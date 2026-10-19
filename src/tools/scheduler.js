// V2 advanced persistent scheduler: interval / cron / once / file-change
import fs from "node:fs";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { Cron } from "croner";
import { z } from "zod";
import { resolveInRoots, assertMutationAllowed, policyDecision } from "../security.js";
import { text, enforceCapabilities } from "../toolkit.js";

export function registerSchedulerTools(reg, ctx) {
  const { store, cfg } = ctx;
  if (!Array.isArray(store.data.schedules)) store.data.schedules = [];
  const handles = new Map();

  const persist = () => store.save();
  const MAX_TIMER_MS = 2_147_000_000;
  const pidAlive=(pid)=>{if(!Number.isInteger(pid)||pid<=0)return false;try{process.kill(pid,0);return true;}catch{return false;}};
  const clear = (id) => {
    const h=handles.get(id); if(!h)return;
    if(h.kind==="cron") h.handle.stop();
    else clearTimeout(h.handle), clearInterval(h.handle);
    handles.delete(id);
  };

  const execute = (job, reason="schedule") => {
    if (!job.enabled) return false;
    if(job.runningPid&&pidAlive(job.runningPid)){
      job.lastBlockedAt=new Date().toISOString();job.lastBlockedReason="previous run still active";persist();return false;
    }
    if(job.runningPid&&!pidAlive(job.runningPid)){job.lastRecoveredStaleRunAt=new Date().toISOString();job.runningPid=null;job.runningStartedAt=null;}
    const overridden=store.data.policyOverrides?.["exec.command"]==="allow";
    const decision=overridden?"allow":policyDecision(cfg,"exec.command");
    if(decision==="deny"||(decision==="ask"&&!job.commandAuthorizedAt)){
      job.lastBlockedAt=new Date().toISOString();job.lastBlockedReason=decision==="deny"?"exec.command denied":"exec.command approval required";persist();return false;
    }
    const cwd=resolveInRoots(cfg,job.cwd||cfg.roots[0]);
    const cmd=job.command;
    const p=spawn(process.platform==="win32"?"powershell.exe":"bash",
      process.platform==="win32"?["-NoProfile","-Command",cmd]:["-lc",cmd],
      {cwd,stdio:"ignore",windowsHide:true});
    const runId=crypto.randomBytes(6).toString("hex");
    job.lastRunAt=new Date().toISOString();job.lastReason=reason;job.lastPid=p.pid;job.runningPid=p.pid;job.runningStartedAt=job.lastRunAt;job.lastRunId=runId;persist();
    p.on("close",(code)=>{if(job.lastRunId===runId){job.runningPid=null;job.runningStartedAt=null;}job.lastExitCode=code;job.lastFinishedAt=new Date().toISOString();persist();});
    return true;
  };
  const retryBlocked=(job,reason)=>{const h=setTimeout(()=>{if(execute(job,reason))arm(job);else retryBlocked(job,reason);},60_000);h.unref?.();handles.set(job.id,{kind:"retry",handle:h});};

  const arm = (job) => {
    clear(job.id); if(!job.enabled)return;
    if(job.trigger?.type==="interval"){
      const ms=Math.max(60_000,Number(job.trigger.minutes)*60_000),target=Date.now()+ms;
      const scheduleChunk=()=>{
        if(!job.enabled)return;
        const remaining=target-Date.now();
        if(remaining<=0){if(execute(job,"interval"))arm(job);else retryBlocked(job,"interval");return;}
        const h=setTimeout(scheduleChunk,Math.min(remaining,MAX_TIMER_MS));h.unref?.();handles.set(job.id,{kind:"interval",handle:h});
      };
      scheduleChunk();return;
    }
    if(job.trigger?.type==="cron"){
      const h=new Cron(job.trigger.expression,{timezone:job.trigger.timezone||undefined},()=>execute(job,"cron"));
      handles.set(job.id,{kind:"cron",handle:h}); return;
    }
    if(job.trigger?.type==="at"){
      const when=new Date(job.trigger.at).getTime(),delay=when-Date.now();
      if(delay<=0){ if(!job.lastRunAt){if(!execute(job,"at"))retryBlocked(job,"at");else{job.enabled=false;persist();}} return; }
      if(delay>MAX_TIMER_MS){
        const h=setTimeout(()=>arm(job),MAX_TIMER_MS);h.unref?.();handles.set(job.id,{kind:"at",handle:h});return;
      }
      const h=setTimeout(()=>{if(execute(job,"at")){job.enabled=false;persist();handles.delete(job.id);}else retryBlocked(job,"at");},delay); h.unref?.(); handles.set(job.id,{kind:"at",handle:h}); return;
    }
    if(job.trigger?.type==="file_change"){
      const abs=resolveInRoots(cfg,job.trigger.path); let last=fs.existsSync(abs)?fs.statSync(abs).mtimeMs:null;
      const ms=Math.max(1000,Number(job.trigger.pollSeconds||5)*1000);
      const h=setInterval(()=>{if(job.pendingFileChange){if(execute(job,"file_change"))job.pendingFileChange=false;return;}let cur=null;try{cur=fs.statSync(abs).mtimeMs;}catch{} if(cur!==last){last=cur;if(!execute(job,"file_change"))job.pendingFileChange=true;}},ms);
      h.unref?.(); handles.set(job.id,{kind:"file_change",handle:h});
    }
  };
  let recoveredStale=false;for(const j of store.data.schedules){if(j.runningPid&&!pidAlive(j.runningPid)){j.lastRecoveredStaleRunAt=new Date().toISOString();j.runningPid=null;j.runningStartedAt=null;recoveredStale=true;}arm(j);}if(recoveredStale)persist();

  const add=(name,command,cwd,trigger,enabled=true)=>{
    assertMutationAllowed(cfg,"예약 작업 등록"); resolveInRoots(cfg,cwd||cfg.roots[0]);
    enforceCapabilities(ctx,["schedule.write","exec.command"],"schedule_command",{name,command,cwd:cwd||cfg.roots[0],trigger,enabled});
    const job={id:"s"+crypto.randomBytes(3).toString("hex"),name,kind:"command",command,cwd:cwd||cfg.roots[0],trigger,enabled,commandAuthorizedAt:new Date().toISOString(),createdAt:new Date().toISOString()};
    store.data.schedules.push(job);persist();arm(job);return job;
  };

  reg("schedule_list",{description:"V2 예약 작업 목록(interval/cron/at/file-change)",inputSchema:{}},async()=>text(store.data.schedules.length?JSON.stringify(store.data.schedules,null,2):"예약 작업 없음"));

  reg("schedule_add",{
    description:"분 단위 interval 예약 명령을 등록한다(호환용). 고급 예약은 schedule_add_cron/at/file_watch 사용.",
    inputSchema:{name:z.string(),command:z.string(),every_minutes:z.number().int().min(1).max(525600),cwd:z.string().optional(),enabled:z.boolean().optional()}
  },async({name,command,every_minutes,cwd,enabled=true})=>{const j=add(name,command,cwd,{type:"interval",minutes:every_minutes},enabled);return text(`등록됨: ${j.id}`);});

  reg("schedule_add_cron",{
    description:"cron 표현식으로 반복 명령을 등록한다. timezone 예: Asia/Seoul.",
    inputSchema:{name:z.string(),command:z.string(),cron:z.string(),timezone:z.string().optional(),cwd:z.string().optional(),enabled:z.boolean().optional()}
  },async({name,command,cron,timezone,cwd,enabled=true})=>{
    try{new Cron(cron,{timezone});}catch(e){throw new Error("잘못된 cron: "+e.message);}
    const j=add(name,command,cwd,{type:"cron",expression:cron,timezone:timezone||null},enabled);return text(`등록됨: ${j.id} cron=${cron}`);
  });

  reg("schedule_add_at",{
    description:"ISO 날짜/시간에 한 번 실행할 명령을 등록한다.",
    inputSchema:{name:z.string(),command:z.string(),at:z.string(),cwd:z.string().optional(),enabled:z.boolean().optional()}
  },async({name,command,at,cwd,enabled=true})=>{
    const d=new Date(at);if(Number.isNaN(d.getTime()))throw new Error("잘못된 날짜/시간");const j=add(name,command,cwd,{type:"at",at:d.toISOString()},enabled);return text(`등록됨: ${j.id} at=${d.toISOString()}`);
  });

  reg("schedule_add_file_watch",{
    description:"승인 루트 안 파일/폴더의 수정시각 변경을 감시해 명령을 실행한다.",
    inputSchema:{name:z.string(),command:z.string(),watch_path:z.string(),poll_seconds:z.number().int().min(1).max(3600).optional(),cwd:z.string().optional(),enabled:z.boolean().optional()}
  },async({name,command,watch_path,poll_seconds=5,cwd,enabled=true})=>{
    const abs=resolveInRoots(cfg,watch_path);const j=add(name,command,cwd,{type:"file_change",path:abs,pollSeconds:poll_seconds},enabled);return text(`등록됨: ${j.id} watch=${abs}`);
  });

  reg("schedule_enable",{description:"예약 작업 활성/비활성 전환",inputSchema:{id:z.string(),enabled:z.boolean()}},async({id,enabled})=>{
    const j=store.data.schedules.find(x=>x.id===id);if(!j)throw new Error("예약 작업 없음");
    enforceCapabilities(ctx,enabled?["schedule.write","exec.command"]:["schedule.write"],"schedule_enable",{id,enabled,command:j.command,cwd:j.cwd,trigger:j.trigger});
    if(enabled)j.commandAuthorizedAt=new Date().toISOString();j.enabled=enabled;persist();arm(j);return text(`${id}: enabled=${enabled}`);
  });

  reg("schedule_remove",{description:"예약 작업 삭제",inputSchema:{id:z.string()}},async({id})=>{
    const i=store.data.schedules.findIndex(x=>x.id===id);if(i<0)throw new Error("예약 작업 없음");clear(id);const [j]=store.data.schedules.splice(i,1);persist();return text(`삭제됨: ${j.name}`);
  });

  reg("schedule_run_now",{description:"등록된 예약 작업을 즉시 1회 실행",inputSchema:{id:z.string()}},async({id})=>{
    const j=store.data.schedules.find(x=>x.id===id);if(!j)throw new Error("예약 작업 없음");
    enforceCapabilities(ctx,["schedule.run","exec.command"],"schedule_run_now",{id,command:j.command,cwd:j.cwd,trigger:j.trigger});j.commandAuthorizedAt=new Date().toISOString();
    if(!execute(j,"manual"))throw new Error("예약 명령 실행 권한이 현재 정책에서 차단됨");return text(`실행 시작: ${j.name}`);
  });
}
