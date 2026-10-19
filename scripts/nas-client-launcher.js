#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.js";
import { getCredential } from "../src/credentials.js";

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
process.chdir(root);
const args=process.argv.slice(2);
const opt=(n,d)=>{const i=args.indexOf(n);return i>=0&&args[i+1]?args[i+1]:d;};
const mode=opt("--mode","");
const runtimePath=path.resolve(opt("--config",path.join(root,".webjjonku","nas-runtime.json")));
if(!["daemon","browser","tools"].includes(mode))throw new Error("--mode daemon|browser|tools required");
const runtime=JSON.parse(fs.readFileSync(runtimePath,"utf8").replace(/^\uFEFF/,""));
if(runtime.enabled!==true)throw new Error("NAS runtime is not enabled");
const coordinator=String(runtime.coordinatorUrl||"").replace(/\/$/,"");
if(!coordinator)throw new Error("coordinatorUrl required");
if(!process.env.WEBJJONKU_RUNTIME_PROFILE)process.env.WEBJJONKU_RUNTIME_PROFILE="windows";
const cfg=loadConfig();
const credential=mode==="browser"?runtime.browserCredential:runtime.clientCredential;
let token=getCredential(cfg,credential);
if(!token && cfg.runtimeProfile){
  const legacyCfg={...cfg,stateDir:path.join(root,'.webjjonku')};
  token=getCredential(legacyCfg,credential);
}
if(!token)throw new Error("credential not found: "+credential);
const env={...process.env,
  WEBJJONKU_COORDINATOR_URL:coordinator,
  WEBJJONKU_COORDINATOR_TOKEN:token,
  WEBJJONKU_COORDINATOR_FORCE_ENV:"1",
  WEBJJONKU_COORDINATOR_ALLOW_PRIVATE:"1",
  WEBJJONKU_COORDINATOR_ALLOW_INSECURE_HTTP:"1",
  WEBJJONKU_COORDINATOR_DEVICE_ID:String(runtime.deviceId||"windows-worker"),
  WEBJJONKU_DEFAULT_BROWSER_WORKER:String(runtime.defaultBrowserWorker||"browser-nas"),
  WEBJJONKU_WINDOWS_LOCAL_MCP_BASE:"http://127.0.0.1:8748"
};
const workerPolicy=runtime.workerPolicy&&typeof runtime.workerPolicy==="object"?runtime.workerPolicy:{};
for(const [key,envName] of Object.entries({
  max:"WEBJJONKU_WORKER_MAX",
  queueMax:"WEBJJONKU_WORKER_QUEUE_MAX",
  minFreeMemoryMB:"WEBJJONKU_WORKER_MIN_FREE_MEMORY_MB",
  maxLoadPerCpu:"WEBJJONKU_WORKER_MAX_LOAD_PER_CPU"
})){
  if(workerPolicy[key]!==undefined&&workerPolicy[key]!==null)env[envName]=String(workerPolicy[key]);
}
let childArgs;
if(mode==="daemon"){
  childArgs=[path.join(root,"scripts","daemon.js")];
}else if(mode==="browser"){
  const workerId=String(runtime.browserWorkerId||"browser-windows");
  const profileDir=path.resolve(runtime.browserProfileDir||path.join(root,".webjjonku","browser-windows-profile"));
  childArgs=[path.join(root,"scripts","browser-worker.js"),"--coordinator",coordinator,"--worker-id",workerId,"--profile-dir",profileDir,"--poll-ms","750"];
  env.WEBJJONKU_BROWSER_WORKER_ID=workerId;
}else{
  const workerId=String(runtime.windowsToolWorkerId||runtime.deviceId||"windows-worker");
  childArgs=[path.join(root,"scripts","windows-tool-worker.js"),"--coordinator",coordinator,"--worker-id",workerId,"--poll-ms","750"];
}

let child=null,stopping=false,restartTimer=null,crashCount=0;
const maxDelay=Math.max(1000,Number(process.env.WEBJJONKU_LAUNCHER_MAX_RESTART_MS||5000));
function scheduleRestart(reason,livedMs=0){
  if(stopping)return;
  if(livedMs>=30_000)crashCount=0;else crashCount=Math.min(crashCount+1,6);
  const delay=Math.min(maxDelay,Math.max(500,500*(2**Math.max(0,crashCount-1))));
  process.stderr.write("[nas-client-launcher] "+mode+" child stopped ("+reason+"); restart in "+delay+"ms\n");
  restartTimer=setTimeout(startChild,delay);
}
function startChild(){
  if(stopping)return;
  const started=Date.now();let settled=false;
  child=spawn(process.execPath,childArgs,{cwd:root,env,stdio:"inherit",windowsHide:true});
  const settle=(reason)=>{
    if(settled)return;settled=true;
    scheduleRestart(reason,Date.now()-started);
  };
  child.once("error",e=>settle("spawn error: "+String(e?.message||e)));
  child.once("exit",(code,signal)=>{
    if(stopping){process.exit(code??0);return;}
    settle("exit code="+String(code)+" signal="+String(signal));
  });
}
function shutdown(sig){
  if(stopping)return;stopping=true;
  if(restartTimer)clearTimeout(restartTimer);
  try{child?.kill(sig);}catch{}
  setTimeout(()=>process.exit(0),2000).unref?.();
}
for(const sig of ["SIGINT","SIGTERM"])process.on(sig,()=>shutdown(sig));
startChild();
