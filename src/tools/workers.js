// Host-scoped on-demand worker pool.
// Workers are ephemeral child processes; the pool enforces host-specific capacity,
// resource-pressure admission and FIFO queueing. State records remain persistent.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { z } from "zod";
import { resolveInRoots, assertMutationAllowed, childProcessEnv } from "../security.js";
import { text } from "../toolkit.js";
import { spawnCodex } from "./codex.js";
import { currentGoal, currentEffort } from "../session-state.js";
import { currentWorkspace, ensureWorkspaceById, ensureWorkspace } from "../workspaces.js";
import { runtimeHost, workerPolicy, workerPressure } from "../worker-capacity.js";

const live = new Map(); // id -> { proc, out, rec }
const queued = new Map(); // id -> { rec, launch }
let retryTimer=null;

function hostPrefix(host){return host==="windows"?"ww":"wn";}
function normalizeRequestedHost(cfg,host){
  const local=runtimeHost(cfg);
  const requested=!host||host==="auto"?local:String(host);
  if(!["nas","windows"].includes(requested))throw new Error("host는 auto|nas|windows만 가능해.");
  if(requested!==local)throw new Error(`host=${requested} 요청이 로컬 ${local} runtime까지 도달했어. 해당 host proxy를 통해 호출해야 해.`);
  return requested;
}
function runningCount(host){
  return [...live.values()].filter(w=>w.rec.status==="running"&&w.rec.host===host).length;
}
function queuedCount(host){
  return [...queued.values()].filter(w=>w.rec.status==="queued"&&w.rec.host===host).length;
}
function scheduleDrain(){
  if(retryTimer)return;
  retryTimer=setTimeout(()=>{retryTimer=null;drainQueue();},2000);
  retryTimer.unref?.();
}
function canStart(q){
  const policy=workerPolicy(q.ctx.cfg,q.rec.host);
  if(runningCount(q.rec.host)>=policy.max)return {ok:false,reason:"capacity",policy};
  const pressure=workerPressure(q.ctx.cfg,q.rec.host);
  if(!pressure.available)return {ok:false,reason:pressure.memoryOk?"load":"memory",policy,pressure};
  return {ok:true,policy,pressure};
}
function startQueued(q){
  const {rec,ctx,packet,dir,kind,commands,effort}=q;
  queued.delete(rec.id);
  rec.status="running";
  rec.startedAt=new Date().toISOString();
  rec.queueReason=null;
  ctx.store.save();

  let proc;
  if(kind==="codex"){
    const prompt=`${packet}\n\n---\n위 컨텍스트를 숙지하고 태스크를 완료해. 완료 후 무엇을 했는지 요약해.`;
    proc=spawnCodex(prompt,dir,effort);
    if(!proc){
      rec.status="failed";rec.endedAt=new Date().toISOString();rec.recoveryReason="Codex CLI unavailable";ctx.store.save();
      drainQueue();
      return;
    }
  }else{
    const sh=process.platform==="win32"
      ? ["powershell.exe",["-NoProfile","-Command",commands.join("; ")]]
      : ["bash",["-lc",commands.join(" && ")]];
    proc=spawn(sh[0],sh[1],{cwd:dir,env:childProcessEnv(),windowsHide:true});
  }

  const w={proc,out:"",rec,ctx};
  const cap=(d)=>{w.out=(w.out+d.toString()).slice(-300_000);};
  proc.stdout?.on("data",cap);
  proc.stderr?.on("data",cap);
  proc.on("close",(code)=>{
    rec.status=code===0?"done":"failed";
    rec.exitCode=code;
    rec.endedAt=new Date().toISOString();
    try{fs.writeFileSync(path.join(rec.stateDir,"output.log"),w.out);}catch{}
    ctx.store.save();
    live.delete(rec.id);
    drainQueue();
  });
  proc.on("error",(e)=>{
    w.out+="\n⛔ "+e.message;
    rec.status="failed";rec.endedAt=new Date().toISOString();rec.recoveryReason=e.message;ctx.store.save();
    live.delete(rec.id);
    drainQueue();
  });
  live.set(rec.id,w);
}
function drainQueue(){
  for(const q of [...queued.values()]){
    const gate=canStart(q);
    if(!gate.ok){
      q.rec.queueReason=gate.reason;
      scheduleDrain();
      continue;
    }
    startQueued(q);
  }
}

export function registerWorkerTools(reg,ctx){
  const {cfg,store}=ctx;

  // Child processes are process-local. Persisted running/queued records from a
  // prior connector process cannot still be alive and must not look healthy.
  let recovered=0;
  const recoveredAt=new Date().toISOString();
  for(const rec of Array.isArray(store.data.workerRecords)?store.data.workerRecords:[]){
    if(["running","queued"].includes(rec?.status)&&!live.has(rec.id)&&!queued.has(rec.id)){
      rec.status="failed";
      rec.endedAt=rec.endedAt||recoveredAt;
      rec.exitCode=rec.exitCode??null;
      rec.recoveryReason="worker process/queue missing after connector restart";
      recovered++;
    }
  }
  if(recovered)store.save();

  reg("worker_spawn",{
    description:"호스트별 on-demand worker pool에 작업을 제출한다. host=nas|windows 선택 가능하며, 여유가 없으면 기본적으로 FIFO queue에 넣고 capacity/부하가 회복되면 자동 시작한다.",
    inputSchema:{
      task:z.string(),
      kind:z.enum(["exec","codex"]).optional().describe("기본 exec"),
      commands:z.array(z.string()).optional().describe("kind=exec일 때 실행할 명령들(순차)"),
      cwd:z.string().optional(),
      name:z.string().optional(),
      extra_context:z.string().optional(),
      host:z.enum(["auto","nas","windows"]).optional(),
      queue_if_busy:z.boolean().optional(),
      workspace_id:z.string().optional().describe("고급 사용: 이 host의 물리 workspace id"),
      lineage_id:z.string().optional().describe("cross-host 재개용 logical workspace lineage"),
      goal_id:z.string().optional().describe("lineage에 연결할 persistent goal id")
    }
  },async({task,kind="exec",commands=[],cwd,name,extra_context,host="auto",queue_if_busy=true,workspace_id,lineage_id,goal_id})=>{
    assertMutationAllowed(cfg,"워커 실행");
    const actualHost=normalizeRequestedHost(cfg,host);
    if(kind==="exec"&&!commands.length)throw new Error("kind=exec는 commands가 필요해.");

    const policy=workerPolicy(cfg,actualHost);
    if(queuedCount(actualHost)>=policy.queueMax)throw new Error(`worker queue 한도(${policy.queueMax}) 초과`);

    const ws=workspace_id
      ? ensureWorkspaceById(ctx,workspace_id)
      : lineage_id
        ? await ensureWorkspace(ctx,{goalId:goal_id||null,lineageId:lineage_id})
        : (currentWorkspace(ctx)||{id:"ws-root",path:cfg.roots[0],root:cfg.roots[0],lineageId:"legacy-root"});
    const wsPath=ws?.path||ws?.root;
    if(!wsPath)throw new Error("workspace path/root missing: "+String(ws?.id||workspace_id||"unknown"));
    const requestedDir=cwd?(path.isAbsolute(cwd)?cwd:path.join(wsPath,cwd)):wsPath;
    const dir=resolveInRoots(cfg,requestedDir);
    const effort=currentEffort(ctx);
    const g=currentGoal(ctx);
    const packet=[
      `# 워커 컨텍스트 패킷`,
      `## 태스크\n${task}`,
      `## host\n${actualHost}`,
      `## workspace\n${ws.id} — ${wsPath}`,
      `## 상위 goal\n${g?`"${g.title}" — 현재 ${g.steps.filter(s=>s.done).length}/${g.steps.length}단계`:"(없음)"}`,
      `## effort\n${effort}`,
      `## 프로젝트 메모(최근)\n${store.data.notes.slice(-10).map(n=>"- "+n.note).join("\n")||"(없음)"}`,
      extra_context?`## 추가 맥락\n${extra_context}`:""
    ].filter(Boolean).join("\n\n");

    const id=hostPrefix(actualHost)+crypto.randomBytes(3).toString("hex");
    const stateDir=path.join(cfg.stateDir,"workers",id);
    fs.mkdirSync(stateDir,{recursive:true});
    fs.writeFileSync(path.join(stateDir,"context.md"),packet);

    const rec={
      id,name:name||task.slice(0,40),kind,task,status:"queued",host:actualHost,
      workspaceId:ws.id,lineageId:ws.lineageId||lineage_id||null,goalId:goal_id||ws.goalId||g?.id||null,startedAt:null,queuedAt:new Date().toISOString(),endedAt:null,
      exitCode:null,cwd:dir,stateDir,queueReason:null
    };
    store.data.workerRecords.push(rec);
    if(store.data.workerRecords.length>200)store.data.workerRecords=store.data.workerRecords.slice(-200);
    store.save();

    const q={rec,ctx,packet,dir,kind,commands:[...commands],effort};
    const gate=canStart(q);
    if(!gate.ok&&!queue_if_busy){
      rec.status="failed";rec.endedAt=new Date().toISOString();rec.recoveryReason="pool busy: "+gate.reason;store.save();
      throw new Error(`worker pool busy (${gate.reason}); running=${runningCount(actualHost)}/${policy.max}`);
    }
    queued.set(id,q);
    if(gate.ok)startQueued(q);else{rec.queueReason=gate.reason;store.save();scheduleDrain();}

    const state=rec.status==="running"?"시작":"queue";
    return text(`🧵 워커 ${id} ${state} (${actualHost}/${kind}) — "${rec.name}"\nworkspace=${ws.id}\nrunning=${runningCount(actualHost)}/${policy.max}, queued=${queuedCount(actualHost)}`);
  });

  reg("worker_pool_status",{
    description:"현재 host의 adaptive worker pool capacity/부하/running/queued 상태를 본다.",
    inputSchema:{host:z.enum(["auto","nas","windows"]).optional()}
  },async({host="auto"})=>{
    const actualHost=normalizeRequestedHost(cfg,host);
    const pressure=workerPressure(cfg,actualHost);
    return text(JSON.stringify({...pressure,running:runningCount(actualHost),queued:queuedCount(actualHost)},null,2));
  });

  reg("worker_status",{
    description:"워커 상태 확인(id 생략 시 최근 목록). Windows worker id는 ww*, NAS worker id는 wn*.",
    inputSchema:{id:z.string().optional(),host:z.enum(["auto","nas","windows"]).optional()}
  },async({id,host="auto"})=>{
    const actualHost=normalizeRequestedHost(cfg,host);
    if(id){
      const w=live.get(id),q=queued.get(id);
      const rec=w?.rec||q?.rec||store.data.workerRecords.find(r=>r.id===id);
      if(!rec)throw new Error("해당 워커 없음");
      const tail=w?w.out.slice(-2000):readOutput(cfg,id).slice(-2000);
      return text(`${rec.id} [${rec.status}] ${rec.host||actualHost}/${rec.kind} — ${rec.name}\nworkspace=${rec.workspaceId||"-"} cwd=${rec.cwd}\n${rec.queueReason?`queueReason=${rec.queueReason}\n`:""}${rec.startedAt?`시작 ${rec.startedAt}`:`queued ${rec.queuedAt}`}${rec.endedAt?` / 종료 ${rec.endedAt} (exit ${rec.exitCode})`:""}\n--- 최근 출력 ---\n${tail||"(없음)"}`);
    }
    const rows=store.data.workerRecords.filter(r=>(r.host||actualHost)===actualHost).slice(-20).map(r=>`${r.id} [${r.status}] ${r.kind} — ${r.name} (${r.startedAt||r.queuedAt||""})`);
    return text(rows.length?rows.join("\n"):"워커 기록 없음");
  });

  reg("worker_result",{
    description:"완료된 워커의 전체 출력 수거",
    inputSchema:{id:z.string(),host:z.enum(["auto","nas","windows"]).optional()}
  },async({id,host="auto"})=>{
    normalizeRequestedHost(cfg,host);
    const w=live.get(id),q=queued.get(id);
    const rec=w?.rec||q?.rec||store.data.workerRecords.find(r=>r.id===id);
    if(!rec)throw new Error("해당 워커 없음");
    if(rec.status==="queued")return text(`아직 queue 중이야. reason=${rec.queueReason||"capacity"}`);
    if(rec.status==="running")return text(`아직 실행 중이야.\n--- 현재까지 출력 ---\n${w?.out.slice(-4000)||""}`);
    return text(`${rec.id} [${rec.status}, exit ${rec.exitCode}] — ${rec.name}\n${w?w.out:readOutput(cfg,id)||"(출력 없음)"}`);
  });

  reg("worker_send",{
    description:"실행 중 exec worker의 stdin으로 입력 전송",
    inputSchema:{id:z.string(),input:z.string(),wait_ms:z.number().int().max(60_000).optional(),host:z.enum(["auto","nas","windows"]).optional()}
  },async({id,input,wait_ms=2000,host="auto"})=>{
    normalizeRequestedHost(cfg,host);
    const w=live.get(id);
    if(!w||w.rec.status!=="running")throw new Error("실행 중인 워커가 아니야.");
    const mark=w.out.length;
    w.proc.stdin?.write(input+"\n");
    await new Promise(r=>setTimeout(r,wait_ms));
    return text(w.out.slice(mark)||"(새 출력 없음)");
  });

  reg("worker_kill",{
    description:"queued/running worker 종료",
    inputSchema:{id:z.string(),host:z.enum(["auto","nas","windows"]).optional()}
  },async({id,host="auto"})=>{
    normalizeRequestedHost(cfg,host);
    const q=queued.get(id);
    if(q){
      queued.delete(id);q.rec.status="killed";q.rec.endedAt=new Date().toISOString();q.ctx.store.save();drainQueue();
      return text(`워커 ${id} queue에서 제거됨`);
    }
    const w=live.get(id);
    if(!w)throw new Error("해당 워커 없음(이미 종료됐을 수 있음)");
    try{w.proc.kill("SIGKILL");}catch{}
    w.rec.status="killed";w.rec.endedAt=new Date().toISOString();w.ctx.store.save();live.delete(id);drainQueue();
    return text(`워커 ${id} 종료됨`);
  });
}

function readOutput(cfg,id){
  const f=path.join(cfg.stateDir,"workers",id,"output.log");
  return fs.existsSync(f)?fs.readFileSync(f,"utf8"):"";
}
