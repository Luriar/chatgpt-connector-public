#!/usr/bin/env node
import fs from "node:fs";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { registerExecTools } from "../src/tools/exec.js";
import { acquireToolResources, releaseToolResources, resourceLockTable } from "../src/resource-locks.js";

const cfg={roots:[process.cwd()],readOnly:false,redactKeys:[],permissions:{default:"allow",actions:{}},resilience:{durableThresholdMs:20000,durableForegroundWaitMs:2500,resultMaxBytes:65536}};
const store={data:{resourceLocks:{}},save(){}};
let durableCalls=0;
const runtimeCtx={
  cfg,
  store,
  createDurableCommandTask(){
    durableCalls++;
    return {id:"task-policy-test"};
  },
  async waitDurableTask(id){
    return {id,status:"succeeded",steps:[{exitCode:0,output:"DURABLE_OK"}]};
  }
};
const handlers={};
registerExecTools((name,_meta,handler)=>{handlers[name]=handler;},runtimeCtx);
const execHandler=handlers.exec_command;
if(!execHandler)throw new Error("exec_command handler not registered");

const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const windows=process.platform==="win32";
const shell=windows?"powershell":"bash";
const delayedCommand=tag=>windows?`powershell.exe -NoProfile -Command "Start-Sleep -Seconds 30 # ${tag}"`:`bash -c 'exec -a ${tag} sleep 30' & wait`;
function countArgv0(tag){
  if(windows){
    const r=spawnSync("powershell.exe",["-NoProfile","-Command",`@(Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -like '*${tag}*' }).Count`],{encoding:"utf8",windowsHide:true,timeout:10000});
    if(r.status!==0)throw new Error("process inspection failed: "+r.stderr);
    return Number(r.stdout.trim());
  }
  let n=0;
  for(const name of fs.readdirSync("/proc")){
    if(!/^\d+$/.test(name))continue;
    try{
      const argv=fs.readFileSync("/proc/"+name+"/cmdline").toString().split("\0").filter(Boolean);
      if(argv[0]===tag)n++;
    }catch{}
  }
  return n;
}

const tag="wjk-timeout-probe-"+crypto.randomBytes(5).toString("hex");
const cmd=delayedCommand(tag);
const t0=Date.now();
const timeoutRes=await execHandler({command:cmd,cwd:process.cwd(),shell,timeout_ms:1200,session:false});
const elapsed=Date.now()-t0;
const timeoutText=timeoutRes?.content?.[0]?.text||"";
if(!timeoutText.includes("타임아웃"))throw new Error("expected timeout response");
if(elapsed>5000)throw new Error("timeout cleanup took too long: "+elapsed+"ms");
await sleep(400);
if(countArgv0(tag)!==0)throw new Error("one-shot orphan process remained");

const t1=Date.now();
const second=await execHandler({command:windows?"Write-Output SECOND_OK":"printf SECOND_OK",cwd:process.cwd(),shell,timeout_ms:3000,session:false});
if(!(second?.content?.[0]?.text||"").includes("SECOND_OK"))throw new Error("second exec failed");
if(Date.now()-t1>3000)throw new Error("second exec was unexpectedly slow");

if(durableCalls!==0)throw new Error("short commands must not use durable execution");
const longRun=await execHandler({command:windows?"Write-Output SHOULD_NOT_RUN":"printf SHOULD_NOT_RUN",cwd:process.cwd(),shell,timeout_ms:20_001,session:false});
if(durableCalls!==1)throw new Error("timeout above configured durable threshold must use durable execution");
if(!(longRun?.content?.[0]?.text||"").includes("DURABLE_OK"))throw new Error("durable result missing");
const explicitDurable=await execHandler({command:windows?"Write-Output SHOULD_NOT_RUN":"printf SHOULD_NOT_RUN",cwd:process.cwd(),shell,timeout_ms:3000,session:false,durable:true});
if(durableCalls!==2)throw new Error("durable=true must use durable execution");
if(!(explicitDurable?.content?.[0]?.text||"").includes("DURABLE_OK"))throw new Error("explicit durable result missing");

const ctx={store,sessionRef:{scoped:true,id:"test-session"}};
const lease=await acquireToolResources(ctx,"exec_command",{});
if(!lease?.resources?.some(r=>String(r).startsWith("workspace:")))throw new Error("workspace-scoped lease not acquired");
releaseToolResources(ctx,lease);
if(Object.keys(resourceLockTable(ctx)).length!==0)throw new Error("call-scoped lease remained after release");

const sessionStart=await execHandler({command:windows?'powershell.exe -NoProfile -Command "Start-Sleep -Milliseconds 600; Write-Output SESSION_DONE"':"sleep 0.6; printf SESSION_DONE",cwd:process.cwd(),shell:windows?"cmd":"bash",timeout_ms:100,session:true});
const sessionText=sessionStart?.content?.[0]?.text||"";
const sid=sessionText.match(/세션 (t[0-9a-f]+)/)?.[1];
if(!sid)throw new Error("session id missing");
await sleep(windows?2500:800);
const poll=await handlers.exec_stdin({session:sid,input:"",raw:true,wait_ms:100});
const pollText=poll?.content?.[0]?.text||"";
if(!pollText.includes("SESSION_DONE"))throw new Error("session polling missed buffered output");
if(!pollText.includes("command finished exit 0"))throw new Error("session completion state missing");
const listed=await handlers.exec_sessions({});
if(!(listed?.content?.[0]?.text||"").includes("command=idle lastExit=0"))throw new Error("session list did not show idle completed command");
await handlers.exec_kill({session:sid});

const killTag="wjk-session-kill-"+crypto.randomBytes(5).toString("hex");
const killStart=await execHandler({command:delayedCommand(killTag),cwd:process.cwd(),shell:windows?"cmd":"bash",timeout_ms:100,session:true});
const killText=killStart?.content?.[0]?.text||"";
const killSid=killText.match(/세션 (t[0-9a-f]+)/)?.[1];
if(!killSid)throw new Error("kill-test session id missing");
await sleep(250);
if(countArgv0(killTag)===0)throw new Error("kill-test child never started");
await handlers.exec_kill({session:killSid});
await sleep(350);
if(countArgv0(killTag)!==0)throw new Error("session kill left orphan process");

console.log(JSON.stringify({
  ok:true,
  timeoutMs:elapsed,
  secondExec:true,
  orphanFree:true,
  lockReleased:true,
  sessionPolling:true,
  sessionKillTree:true
}));
