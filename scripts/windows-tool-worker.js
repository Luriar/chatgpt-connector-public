#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { pinnedRequest } from "../src/net-safe.js";
import { pickWindowsWorkerTask, windowsWorkerCall, windowsWorkerCompletion } from "./windows-command-routing.js";
import { isRepairableWindowsLocalMcpFailure } from "../src/windows-tool-recovery.js";

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const args=process.argv.slice(2);
const opt=(n,d)=>{const i=args.indexOf(n);return i>=0&&args[i+1]?args[i+1]:d;};
const coordinator=String(opt("--coordinator",process.env.WEBJJONKU_COORDINATOR_URL||"")).replace(/\/$/,"");
// Optional legacy alias is restricted to an explicitly configured primary host.
const machineName=os.hostname().toLowerCase();
const legacyHost=String(process.env.WEBJJONKU_LEGACY_WORKER_HOSTNAME||"").toLowerCase();
const suggestedDeviceId=legacyHost&&machineName===legacyHost?"windows-worker":
  "windows-"+machineName.replace(/[^a-z0-9-]/g,"-").slice(0,48);
const deviceId=String(opt("--worker-id",process.env.WEBJJONKU_COORDINATOR_DEVICE_ID||suggestedDeviceId));
if(deviceId==="windows-worker"&&machineName!==legacyHost&&process.env.WEBJJONKU_ALLOW_LEGACY_WORKER_ID!=="1")
  throw new Error("windows-worker is reserved; set a unique --worker-id or configure WEBJJONKU_LEGACY_WORKER_HOSTNAME");
const pollMs=Math.max(500,Number(opt("--poll-ms","750")));
const token=process.env.WEBJJONKU_COORDINATOR_TOKEN||"";
const secretFile=path.join(root,".webjjonku","http-secret");
const localBase=String(process.env.WEBJJONKU_WINDOWS_LOCAL_MCP_BASE||"http://127.0.0.1:8748").replace(/\/$/,"");
const callTimeoutMs=Math.max(10_000,Math.min(300_000,Number(process.env.WEBJJONKU_WINDOWS_TOOL_CALL_TIMEOUT_MS)||120_000));
const localFailureRestartThreshold=Math.max(1,Math.min(5,Number(process.env.WEBJJONKU_WINDOWS_TOOL_RESTART_AFTER_LOCAL_FAILURES)||1));
let activeCall=null,localFailureStreak=0;
if(!coordinator)throw new Error("coordinator required");
const coordinatorUrl=new URL(coordinator);
const coordinatorLoopback=["127.0.0.1","localhost","::1"].includes(coordinatorUrl.hostname);
const coordinatorAllowPrivate=coordinatorLoopback||process.env.WEBJJONKU_COORDINATOR_ALLOW_PRIVATE==="1";
if(coordinatorUrl.protocol==="http:"&&!coordinatorLoopback&&process.env.WEBJJONKU_COORDINATOR_ALLOW_INSECURE_HTTP!=="1")throw new Error("non-loopback coordinator requires explicit insecure-HTTP opt-in");
if(!fs.existsSync(secretFile))throw new Error("local MCP secret missing");

const ALLOWED=[
  /^desktop_/,
  /^computer_/,
  /^office_live_/,
  /^browser_/,
  /^fs_/,
  /^excel_/,
  /^pdf_/,
  /^office_/,
  /^worker_(spawn|pool_status|status|result|kill)$/,
  /^task_(status|result|events|checkpoint|pause|resume|cancel|steer|retry)$/,
  /^codex_status$/,
  /^exec_command$/
];
const allowed=(n)=>ALLOWED.some(r=>r.test(n));

function h(json=true){
  const x={accept:"application/json"};if(json)x["content-type"]="application/json";
  if(token)x.authorization="Bearer "+token;return x;
}
async function api(p,{method="GET",body}={}){
  const payload=body===undefined?undefined:JSON.stringify(body);
  const res=await pinnedRequest(new URL(p,coordinatorUrl),{
    method,
    headers:h(body!==undefined),
    body:payload,
    timeoutMs:20_000,
    maxBytes:5*1024*1024,
    allowPrivateNetwork:coordinatorAllowPrivate,
    allowLoopback:coordinatorLoopback
  });
  const raw=res.body.toString("utf8");let j=null;try{j=raw?JSON.parse(raw):null;}catch{j={error:raw};}
  if(!res.ok)throw new Error(j?.error||("HTTP "+res.status));return j;
}
function stripNestedDecoration(result){
  if(!result||!Array.isArray(result.content))return result;
  const marker="\n\n───\n[웹쫀쿠 goal]";
  return {...result,content:result.content.map(item=>{
    if(item?.type!=="text"||typeof item.text!=="string")return item;
    const i=item.text.indexOf(marker);
    return i>=0?{...item,text:item.text.slice(0,i)}:item;
  })};
}
async function localCall(tool,toolArgs){
  if(!allowed(tool))throw new Error("tool not allowed by Windows worker: "+tool);
  const secret=fs.readFileSync(secretFile,"utf8").trim();
  const tr=new StreamableHTTPClientTransport(new URL(localBase+"/mcp/"+secret));
  const c=new Client({name:"windows-tool-worker",version:"1"});
  const controller=new AbortController();
  let deadlineTimer;
  try{
    return await Promise.race([
      (async()=>{
        await c.connect(tr);
        return stripNestedDecoration(await c.callTool({name:tool,arguments:toolArgs||{}},undefined,{timeout:callTimeoutMs,maxTotalTimeout:callTimeoutMs,signal:controller.signal}));
      })(),
      new Promise((_,reject)=>{deadlineTimer=setTimeout(()=>{controller.abort();reject(new Error("Windows local MCP call deadline exceeded"));},callTimeoutMs);})
    ]);
  }finally{
    clearTimeout(deadlineTimer);
    // Cleanup itself must not hold the worker forever after a hung transport.
    let cleanupTimer;
    await Promise.race([(async()=>{try{await tr.terminateSession();}catch{}try{await c.close();}catch{}})(),new Promise(resolve=>{cleanupTimer=setTimeout(resolve,2000);})]).finally(()=>clearTimeout(cleanupTimer));
  }
}
async function heartbeat(){
  return api("/v1/devices/heartbeat",{method:"POST",body:{
    deviceId,
    capabilities:["local-files","command","browser","documents","desktop","office-com","windows-browser-profile","tool-rpc"],
    meta:{hostname:os.hostname(),platform:process.platform,kind:"windows-tool-worker",hostId:process.env.WEBJJONKU_WORKER_HOST_ID||"windows",workerType:process.env.WEBJJONKU_WORKER_TYPE||"tool",pid:process.pid,activeTaskId:activeCall?.taskId||null,activeCallDeadline:activeCall?.deadline||null}
  }});
}
let busy=false,lastBeat=0;
async function tick(){
  if(busy)return;busy=true;
  try{
    if(Date.now()-lastBeat>10_000){await heartbeat();lastBeat=Date.now();}
    const rows=await api("/v1/poll?device_id="+encodeURIComponent(deviceId)+"&executor=device");
    const task=pickWindowsWorkerTask(rows,callTimeoutMs);
    if(!task)return;
    try{
      await api("/v1/tasks/"+encodeURIComponent(task.id)+"/claim",{method:"POST",body:{deviceId}});
    }catch{return;}
    let leaseTimer,restartAfterTask=false;
    try{
      activeCall={taskId:task.id,deadline:new Date(Date.now()+callTimeoutMs+5000).toISOString()};
      await heartbeat();lastBeat=Date.now();
      let refreshing=false;
      leaseTimer=setInterval(async()=>{
        if(refreshing)return;refreshing=true;
        try{await api("/v1/tasks/"+encodeURIComponent(task.id)+"/heartbeat",{method:"POST",body:{deviceId}});await heartbeat();lastBeat=Date.now();}catch{}finally{refreshing=false;}
      },10_000);
      leaseTimer.unref?.();
      let result,completion;
      try{
        const call=windowsWorkerCall(task,callTimeoutMs);
        result=await localCall(call.tool,call.args);
        completion=windowsWorkerCompletion(task,result);
        localFailureStreak=0;
      }catch(error){
        if(isRepairableWindowsLocalMcpFailure(error)){
          localFailureStreak++;
          restartAfterTask=localFailureStreak>=localFailureRestartThreshold;
        }else{
          localFailureStreak=0;
        }
        throw error;
      }
      for(let attempt=0;attempt<2;attempt++){
        try{await api("/v1/tasks/"+encodeURIComponent(task.id)+"/complete",{method:"POST",body:{deviceId,result:completion}});break;}
        catch(error){
          // A lost completion ACK must never cause the tool to execute again.
          let actual;try{actual=await api("/v1/tasks/"+encodeURIComponent(task.id));}catch{}
          if(actual?.status==="succeeded")break;
          if(attempt||actual&&actual.status!=="running")throw error;
        }
      }
    }catch(e){
      try{await api("/v1/tasks/"+encodeURIComponent(task.id)+"/fail",{method:"POST",body:{deviceId,error:String(e?.message||e).slice(0,4000)}});}catch{}
    }finally{if(leaseTimer)clearInterval(leaseTimer);activeCall=null;try{await heartbeat();lastBeat=Date.now();}catch{}}
    if(restartAfterTask){
      process.stderr.write("[windows-tool-worker] local MCP transport failure threshold reached; exiting for launcher restart\n");
      process.exitCode=75;
      setImmediate(()=>process.exit(75));
      return;
    }
  }catch(e){
    process.stderr.write("[windows-tool-worker] "+String(e?.message||e)+"\n");
  }finally{busy=false;}
}
try{await heartbeat();lastBeat=Date.now();}catch(e){process.stderr.write("[windows-tool-worker] initial heartbeat failed; retrying: "+String(e?.message||e)+"\n");}
setInterval(()=>tick().catch(()=>{}),pollMs);
tick().catch(()=>{});
process.stderr.write("[windows-tool-worker] ready device="+deviceId+" coordinator="+coordinator+"\n");
