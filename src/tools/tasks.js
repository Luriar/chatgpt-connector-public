// Personal Cowork parity: persistent Task Manager with pause/resume/cancel/steer/retry/dependencies.
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import { z } from "zod";
import { resolveInRoots, childProcessEnv } from "../security.js";
import { text, enforcePolicy } from "../toolkit.js";
import { coordinatorApi } from "./coordinator.js";
import { acquireResourceLocks, releaseResourceLocks } from "../resource-locks.js";

const running=new Map();
const recoveredStores=new WeakSet();
const REMOTE_LEASE_HEARTBEAT_MS=Math.max(250,Number(process.env.WEBJJONKU_REMOTE_LEASE_HEARTBEAT_MS||8000));
const MAX_EVENTS=1000;
const checkpointFields = {
  summary:z.string().max(20000).optional(), draft:z.string().max(100000).optional(),
  command_results:z.string().max(100000).optional(), next_steps:z.array(z.string().max(5000)).max(100).optional()
};
function ensure(store){if(!store.data.tasks||typeof store.data.tasks!=="object"||Array.isArray(store.data.tasks))store.data.tasks={};}
function now(){return new Date().toISOString();}
function event(store,t,type,data={},persist=true){
  if(!Array.isArray(t.events))t.events=[];
  t.events.push({ts:now(),type,...data});if(t.events.length>MAX_EVENTS)t.events=t.events.slice(-MAX_EVENTS);
  if(persist)store.save();
}
function publicTask(t){const x=structuredClone(t);for(const s of x.steps||[]){if(s.output&&s.output.length>12000)s.output=s.output.slice(-12000);}return x;}
function shellFor(requested="auto"){
  const sh=String(requested||"auto").toLowerCase();
  if(process.platform==="win32"){
    if(sh==="cmd")return ["cmd.exe",["/d","/s","/c"]];
    return ["powershell.exe",["-NoProfile","-Command"]];
  }
  return ["bash",["-lc"]];
}
function killTree(proc){
  if(!proc?.pid)return;
  if(process.platform==="win32"){
    try{spawnSync("taskkill",["/PID",String(proc.pid),"/T","/F"],{windowsHide:true,stdio:"ignore",timeout:10000});}catch{}
  }else{
    try{process.kill(-proc.pid,"SIGKILL");}catch{try{proc.kill("SIGKILL");}catch{}}
  }
}

export function registerTaskTools(reg,ctx){
  const {store,cfg}=ctx;ensure(store);
  const resilience=cfg.resilience||{};
  const checkpointIntervalMs=Math.max(1000,Math.min(60000,Number(resilience.checkpointIntervalMs)||5000));
  const taskOutputMaxBytes=Math.max(12000,Math.min(1024*1024,Number(resilience.resultMaxBytes)||65536));
  const taskCommandTimeoutMs=Math.max(5000,Math.min(24*60*60*1000,Number(process.env.WEBJJONKU_TASK_COMMAND_TIMEOUT_MS||resilience.taskCommandTimeoutMs)||30*60*1000));
  const taskKillGraceMs=Math.max(250,Math.min(30000,Number(process.env.WEBJJONKU_TASK_KILL_GRACE_MS||resilience.taskKillGraceMs)||3000));

  // Recover tasks left in "running" only once per Store/process lifetime.
  // buildServer() runs for every MCP session, so per-session recovery would otherwise
  // misclassify a live background task as stale whenever a new chat/session connects.
  if(!recoveredStores.has(store)){
    recoveredStores.add(store);
    for(const t of Object.values(store.data.tasks)){
      if(t.status!=="running"||running.has(t.id))continue;
      const idx=Number.isInteger(t.currentStep)?t.currentStep:(t.steps||[]).findIndex(s=>s.status==="running");
      if(idx>=0&&t.steps?.[idx]?.status==="running"){
        t.steps[idx].status="pending";t.steps[idx].startedAt=null;t.steps[idx].finishedAt=null;t.steps[idx].exitCode=null;
      }
      t.currentStep=null;t.finishedAt=null;
      if(t.autoRecover===true){t.status="queued";t.error=null;event(store,t,"recovered_stale_run",{policy:"auto"});}
      else{t.status="paused";t.error="Recovered after connector interruption; resume manually or create with auto_recover=true.";event(store,t,"recovered_stale_run",{policy:"manual"});}
    }
  }

  function get(id){const t=store.data.tasks[id];if(!t)throw new Error("task 없음: "+id);return t;}
  function depsReady(t){
    for(const id of t.dependsOn||[]){const d=store.data.tasks[id];if(!d||d.status!=="succeeded")return false;}return true;
  }
  function nextStep(t){return (t.steps||[]).findIndex(s=>!["succeeded","skipped"].includes(s.status));}
  function remoteDeviceId(){return store.data.coordinator?.deviceId||null;}
  async function beatRemoteLease(t){
    if(!t.remoteTaskId)return;
    const deviceId=remoteDeviceId();if(!deviceId)throw new Error("remote task has no coordinator device id");
    await coordinatorApi(ctx,"/v1/tasks/"+encodeURIComponent(t.remoteTaskId)+"/heartbeat",{method:"POST",body:{deviceId}});
  }
  ctx.cancelTaskRuntime=(id,reason="cancel requested")=>{
    const t=store.data.tasks[id];if(!t)return false;
    t.status="cancelled";t.finishedAt=now();t.error=reason;
    const p=running.get(id);if(p)killTree(p);
    event(store,t,"cancel_requested",{reason});return true;
  };

  async function runTask(t){
    if(running.has(t.id)||["cancelled","succeeded"].includes(t.status))return;
    if(!depsReady(t)){t.status="blocked";event(store,t,"blocked",{dependsOn:t.dependsOn});return;}
    const lockOwner="task-"+t.id;
    try{
      acquireResourceLocks(ctx,["workspace"],{tool:"task_runtime",seconds:120,owner:lockOwner,mode:"call"});
    }catch(e){
      if(e?.code==="RESOURCE_BUSY")return;
      throw e;
    }
    const lockTimer=setInterval(()=>{try{acquireResourceLocks(ctx,["workspace"],{tool:"task_runtime",seconds:120,owner:lockOwner,mode:"call"});}catch{}},30000);
    lockTimer.unref?.();
    try{
      t.status="running";t.startedAt=t.startedAt||now();event(store,t,"started",{},false);
      while(t.status==="running"){
        const idx=nextStep(t);
        if(idx<0){t.status="succeeded";t.finishedAt=now();event(store,t,"succeeded");break;}
        const step=t.steps[idx]; t.currentStep=idx; step.status="running";step.startedAt=now();event(store,t,"step_started",{index:idx,title:step.title});
        if(!step.command){
          step.status="succeeded";step.finishedAt=now();
          const finalStep=nextStep(t)<0;
          event(store,t,"step_succeeded",{index:idx},!finalStep);
          continue;
        }
        const cwd=resolveInRoots(cfg,step.cwd||t.cwd||cfg.roots[0]);
        if(!t.preAuthorized){
          try{
            enforcePolicy(ctx,"exec.command","task_runtime",{task_id:t.id,step:idx,command:step.command,cwd});
          }catch(e){
            step.status="pending";step.startedAt=null;t.status="paused";t.error=String(e.message||e);event(store,t,"approval_required",{index:idx,action:"exec.command",message:t.error});break;
          }
        }
        if(t.remoteTaskId){
          try{await beatRemoteLease(t);}catch(e){
            step.status="pending";step.startedAt=null;t.status="paused";t.error="Remote lease unavailable before execution: "+String(e.message||e);event(store,t,"remote_lease_lost",{phase:"before_spawn",message:t.error});break;
          }
        }
        const [cmd,prefix]=shellFor(step.shell||t.shell||"auto");
        const requestedTimeout=Number(step.timeoutMs??t.timeoutMs??taskCommandTimeoutMs);
        const effectiveTimeoutMs=Math.max(5000,Math.min(24*60*60*1000,Number.isFinite(requestedTimeout)?requestedTimeout:taskCommandTimeoutMs));
        const proc=spawn(cmd,[...prefix,step.command],{cwd,env:childProcessEnv(),windowsHide:true,detached:process.platform!=="win32"});
        running.set(t.id,proc);let out="",err="",leaseBusy=false,leaseFailures=0,timedOut=false,settled=false,timeoutTimer=null,killFallback=null;
        const saveOutput=()=>{step.output=out+(err?"\n--- stderr ---\n"+err:"");step.checkpointAt=now();store.save();};
        const checkpointTimer=setInterval(()=>{try{saveOutput();}catch(e){t.error="Checkpoint failed: "+e.message;t.status="paused";killTree(proc);}},checkpointIntervalMs);
        checkpointTimer.unref?.();
        const leaseTimer=t.remoteTaskId?setInterval(async()=>{
          if(leaseBusy||t.status!=="running")return;leaseBusy=true;
          try{await beatRemoteLease(t);leaseFailures=0;}
          catch(e){
            leaseFailures++;
            if(leaseFailures===1)event(store,t,"remote_heartbeat_failed",{message:String(e.message||e)});
            if(leaseFailures>=2&&t.status==="running"){
              t.status="paused";t.error="Remote lease heartbeat failed repeatedly; command stopped before lease expiry to prevent duplicate execution.";
              event(store,t,"remote_lease_lost",{phase:"running",failures:leaseFailures,message:String(e.message||e)});killTree(proc);
            }
          }finally{leaseBusy=false;}
        },REMOTE_LEASE_HEARTBEAT_MS):null;
        leaseTimer?.unref?.();
        const cap=(s,d)=>(s+d.toString()).slice(-taskOutputMaxBytes);
        proc.stdout.on("data",d=>out=cap(out,d));proc.stderr.on("data",d=>err=cap(err,d));
        const code=await new Promise((resolve)=>{
          const finish=(value)=>{
            if(settled)return;settled=true;
            if(timeoutTimer)clearTimeout(timeoutTimer);
            if(killFallback)clearTimeout(killFallback);
            resolve(value);
          };
          proc.on("close",finish);proc.on("error",()=>finish(-1));
          timeoutTimer=setTimeout(()=>{
            if(settled||t.status!=="running")return;
            timedOut=true;killTree(proc);
            killFallback=setTimeout(()=>finish(-408),taskKillGraceMs);
          },effectiveTimeoutMs);
          timeoutTimer.unref?.();
        });
        clearInterval(checkpointTimer);if(leaseTimer)clearInterval(leaseTimer);
        running.delete(t.id);step.output=out+(err?"\n--- stderr ---\n"+err:"");step.exitCode=code;step.finishedAt=now();
        if(t.status==="paused"){step.status="pending";event(store,t,"paused",{index:idx});break;}
        if(t.status==="cancelled"){step.status="cancelled";event(store,t,"cancelled",{index:idx});break;}
        if(timedOut){
          step.status="failed";t.status="failed";t.error="step "+idx+" timed out after "+effectiveTimeoutMs+"ms";t.finishedAt=now();event(store,t,"timed_out",{index:idx,timeoutMs:effectiveTimeoutMs});break;
        }
        if(code===0){
          step.status="succeeded";
          const finalStep=nextStep(t)<0;
          event(store,t,"step_succeeded",{index:idx,exitCode:code},!finalStep);
        }
        else{step.status="failed";t.status="failed";t.error="step "+idx+" exit "+code;t.finishedAt=now();event(store,t,"failed",{index:idx,exitCode:code});break;}
      }
    }finally{
      clearInterval(lockTimer);
      releaseResourceLocks(ctx,["workspace"],lockOwner);
    }
  }

  ctx.createDurableCommandTask=({title,command,cwd,shell="auto",timeoutMs,autoRecover=false,preAuthorized=false,localRequired=true}={})=>{
    const dir=resolveInRoots(cfg,cwd||cfg.roots[0]);
    // A Windows durable task must remain inspectable through the NAS Connector.
    const id="task_"+(process.platform==="win32"?"win_":"")+crypto.randomBytes(5).toString("hex");
    const t={
      id,title:title||("exec: "+String(command||"").slice(0,80)),status:"queued",
      steps:[{title:"command",command:String(command||""),cwd:dir,shell,timeoutMs:Number(timeoutMs)||null,status:"pending",output:null,exitCode:null}],
      cwd:dir,timeoutMs:Number(timeoutMs)||null,dependsOn:[],projectId:null,localRequired,autoRecover:autoRecover===true,preAuthorized:preAuthorized===true,
      createdAt:now(),startedAt:null,finishedAt:null,currentStep:null,error:null,events:[],result:null
    };
    store.data.tasks[id]=t;event(store,t,"created",{autoStart:true,durableExec:true});
    runTask(t).catch((e)=>{t.status="failed";t.error=String(e?.message||e);t.finishedAt=now();event(store,t,"failed",{message:t.error});});
    return t;
  };
  ctx.waitDurableTask=async(id,waitMs=8000)=>{
    const deadline=Date.now()+Math.max(0,Number(waitMs)||0);
    let t=get(id);
    while(Date.now()<deadline&&!['succeeded','failed','cancelled','paused'].includes(t.status)){
      await new Promise(r=>setTimeout(r,100));
      t=get(id);
    }
    return t;
  };

  const timer=setInterval(()=>{
    for(const t of Object.values(store.data.tasks)){
      if((t.status==="queued"||t.status==="blocked")&&depsReady(t))runTask(t).catch(()=>{});
    }
  },1000);timer.unref?.();

  reg("task_create",{
    description:"지속 Task를 생성한다. 명령 step은 백그라운드 실행되고 상태/이벤트가 영속 저장된다. auto_recover=true면 커넥터 재시작 후 stale running Task를 자동 queue한다(부작용 있는 명령은 false 권장).",
    inputSchema:{
      title:z.string(),steps:z.array(z.object({title:z.string(),command:z.string().optional(),cwd:z.string().optional(),timeout_ms:z.number().int().min(5000).max(24*60*60*1000).optional()})).min(1),
      cwd:z.string().optional(),timeout_ms:z.number().int().min(5000).max(24*60*60*1000).optional(),depends_on:z.array(z.string()).optional(),project_id:z.string().optional(),local_required:z.boolean().optional(),auto_start:z.boolean().optional(),auto_recover:z.boolean().optional()
    }
  },async({title,steps,cwd,timeout_ms,depends_on=[],project_id,local_required=true,auto_start=true,auto_recover=false})=>{
    if(cwd)resolveInRoots(cfg,cwd);
    const id="task_"+crypto.randomBytes(5).toString("hex");
    const t={id,title,status:auto_start?"queued":"paused",steps:steps.map(s=>({...s,timeoutMs:Number(s.timeout_ms)||null,status:"pending",output:null,exitCode:null})),cwd:cwd||cfg.roots[0],timeoutMs:Number(timeout_ms)||null,dependsOn:depends_on,projectId:project_id||null,localRequired:local_required,autoRecover:auto_recover===true,createdAt:now(),startedAt:null,finishedAt:null,currentStep:null,error:null,events:[],result:null};
    store.data.tasks[id]=t;event(store,t,"created",{autoStart:auto_start});return text(JSON.stringify(publicTask(t),null,2));
  });

  reg("task_list",{description:"Task 목록을 상태별로 조회한다.",inputSchema:{status:z.string().optional(),project_id:z.string().optional()}},async({status,project_id})=>{
    let rows=Object.values(store.data.tasks);if(status)rows=rows.filter(t=>t.status===status);if(project_id)rows=rows.filter(t=>t.projectId===project_id);
    return text(JSON.stringify(rows.map(t=>({id:t.id,title:t.title,status:t.status,currentStep:t.currentStep,createdAt:t.createdAt,finishedAt:t.finishedAt,projectId:t.projectId})),null,2));
  });

  reg("task_checkpoint",{
    description:"Save summary, draft, command results and next steps before/after short (30-60 second) stages. Never submit private chain-of-thought. Restore with task_status, continue unfinished commands with task_resume.",
    inputSchema:{id:z.string(),summary:z.string().max(20000).optional(),draft:z.string().max(100000).optional(),command_results:z.string().max(100000).optional(),next_steps:z.array(z.string().max(5000)).max(100).optional()}
  },async(args)=>{
    if(cfg.readOnly)throw new Error('readOnly');
    enforcePolicy(ctx,'task.write','task_checkpoint',args);
    const t=get(args.id);
    const fields=Object.fromEntries(Object.keys(checkpointFields).filter(k=>args[k]!==undefined).map(k=>[k,args[k]]));
    t.checkpoint={...t.checkpoint,...fields,updatedAt:now(),step:t.currentStep};
    event(store,t,'checkpoint_saved');
    return text(JSON.stringify({id:t.id,checkpointAt:t.checkpoint.updatedAt}));
  });

  reg("task_status",{description:"Task 상세 상태/step을 조회한다.",inputSchema:{id:z.string()}},async({id})=>text(JSON.stringify(publicTask(get(id)),null,2)));

  reg("task_pause",{description:"실행 중 Task를 중단하고 paused 상태로 둔다. 현재 command는 종료되고 resume 시 해당 step을 처음부터 재실행한다.",inputSchema:{id:z.string()}},async({id})=>{
    const t=get(id);t.status="paused";const p=running.get(id);if(p)killTree(p);event(store,t,"pause_requested");return text(id+" paused");
  });

  reg("task_resume",{description:"paused/failed/cancelled Task를 재개한다. failed step은 pending으로 되돌린다.",inputSchema:{id:z.string()}},async({id})=>{
    const t=get(id);if(t.status==="succeeded")return text("이미 완료");
    if(t.remoteQuarantined)throw new Error("원격 동기화 Task는 격리 상태야. work_task_trust로 승인한 뒤 재개해.");
    const idx=nextStep(t);if(idx>=0&&["failed","cancelled"].includes(t.steps[idx].status))t.steps[idx].status="pending";
    t.status="queued";t.finishedAt=null;t.error=null;event(store,t,"resume_requested");return text(id+" queued");
  });

  reg("task_cancel",{description:"Task를 취소한다. 실행 중 command도 종료한다.",inputSchema:{id:z.string()}},async({id})=>{
    const t=get(id);t.status="cancelled";t.finishedAt=now();const p=running.get(id);if(p)killTree(p);event(store,t,"cancel_requested");return text(id+" cancelled");
  });

  reg("task_steer",{
    description:"진행 중 Task에 사용자의 방향 수정 메모를 추가하거나 새 step을 뒤에 붙인다.",
    inputSchema:{id:z.string(),instruction:z.string(),append_step:z.object({title:z.string(),command:z.string().optional(),cwd:z.string().optional()}).optional()}
  },async({id,instruction,append_step})=>{
    const t=get(id);event(store,t,"steer",{instruction});if(append_step){t.steps.push({...append_step,status:"pending",output:null,exitCode:null});store.save();}return text("steer 저장됨");
  });

  reg("task_events",{description:"Task의 시간순 event timeline을 반환한다.",inputSchema:{id:z.string(),limit:z.number().int().min(1).max(1000).optional()}},async({id,limit=200})=>{
    const t=get(id);return text(JSON.stringify((t.events||[]).slice(-limit),null,2));
  });

  reg("task_result",{description:"완료/실패 Task 결과와 step 출력을 반환한다.",inputSchema:{id:z.string()}},async({id})=>{
    const t=get(id);return text(JSON.stringify({id:t.id,status:t.status,result:t.result,error:t.error,steps:t.steps.map(s=>({title:s.title,status:s.status,exitCode:s.exitCode,output:s.output}))},null,2));
  });

  reg("task_retry",{description:"failed Task의 실패 step부터 다시 queue한다.",inputSchema:{id:z.string()}},async({id})=>{
    const t=get(id);for(const s of t.steps)if(s.status==="failed")s.status="pending";t.status="queued";t.error=null;t.finishedAt=null;event(store,t,"retry_requested");return text(id+" retry queued");
  });
}
