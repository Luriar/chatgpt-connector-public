#!/usr/bin/env node
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";

const ROOT=path.resolve(new URL("..",import.meta.url).pathname.replace(/^\/(.:)/,"$1"));
const TMP=fs.mkdtempSync(path.join(os.tmpdir(),"wjk-http-session-"));
const free=()=>new Promise((resolve,reject)=>{
  const s=net.createServer();
  s.on("error",reject);
  s.listen(0,"127.0.0.1",()=>{const p=s.address().port;s.close(()=>resolve(p));});
});
const port=await free();
const cfg=path.join(TMP,"cfg.json");
const TESTENV={...process.env};
for(const k of Object.keys(TESTENV))if(k.startsWith("WEBJJONKU_"))delete TESTENV[k];
TESTENV.WEBJJONKU_MCP_JSON_RESPONSE="1";
fs.writeFileSync(cfg,JSON.stringify({
  roots:[TMP],
  http:{host:"127.0.0.1",port,secretPath:"session-isolation-test"},
  permissions:{default:"allow"},
  browser:{headless:true,allowPrivateNetwork:true}
},null,2));

const child=spawn(process.execPath,[path.join(ROOT,"src","index.js"),"--http","--config",cfg],{
  cwd:TMP,stdio:["ignore","pipe","pipe"],windowsHide:true,
  env:TESTENV
});
let stderr="",stdout="",exitState=null;
child.stderr.on("data",d=>stderr+=String(d));
child.stdout.on("data",d=>stdout+=String(d));
child.on("exit",(code,signal)=>{exitState={code,signal};});

async function waitHealth(){
  const end=Date.now()+30000;
  while(Date.now()<end){
    try{const r=await fetch(`http://127.0.0.1:${port}/health`);if(r.ok)return;}
    catch{}
    if(exitState)throw new Error("HTTP server exited before health: "+JSON.stringify(exitState)+" stdout="+stdout.slice(-1000)+" stderr="+stderr.slice(-2000));
    await new Promise(r=>setTimeout(r,100));
  }
  throw new Error("HTTP server did not start in 30s: stdout="+stdout.slice(-1000)+" stderr="+stderr.slice(-2000));
}
await waitHealth();

const rawUrl=`http://127.0.0.1:${port}/mcp/session-isolation-test`;
const stale=await fetch(rawUrl,{
  method:"POST",
  headers:{
    "content-type":"application/json",
    "accept":"application/json, text/event-stream",
    "mcp-session-id":"stale-session-regression"
  },
  body:JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/list",params:{}})
});
const staleBody=await stale.json();
if(stale.status!==404||staleBody?.error?.code!==-32001){
  throw new Error("stale session must return HTTP 404 / -32001: "+stale.status+" "+JSON.stringify(staleBody));
}

const noSession=await fetch(rawUrl,{
  method:"POST",
  headers:{
    "content-type":"application/json",
    "accept":"application/json, text/event-stream"
  },
  body:JSON.stringify({jsonrpc:"2.0",id:2,method:"tools/list",params:{}})
});
if(noSession.status!==400)throw new Error("missing session must remain HTTP 400: "+noSession.status);

async function mk(name){
  const url=new URL(`http://127.0.0.1:${port}/mcp/session-isolation-test`);
  const tr=new StreamableHTTPClientTransport(url);
  const c=new Client({name,version:"1"});
  await c.connect(tr);
  const call=async(name,args={})=>{
    const r=await c.callTool({name,arguments:args});
    return {isError:!!r.isError,text:r.content?.find(x=>x.type==="text")?.text||""};
  };
  return {c,tr,call};
}
function base(s){
  let x=String(s||"");
  if(x.startsWith("[UNTRUSTED DATA BOUNDARY]")){
    const i=x.indexOf("\n\n");
    x=i>=0?x.slice(i+2):"";
  }
  const marker="\n\n───\n";
  const i=x.indexOf(marker);
  return i>=0?x.slice(0,i):x;
}

let a,b,c;
try{
  a=await mk("session-a");
  b=await mk("session-b");

  const stale=await a.call("task_create",{title:"stale failed task",steps:[{title:"fail",command:"node -e \"process.exit(1)\""}],auto_start:true});
  if(stale.isError)throw new Error(stale.text);
  const staleId=JSON.parse(base(stale.text)).id;
  for(let i=0;i<80;i++){
    const sj=JSON.parse(base((await a.call("task_status",{id:staleId})).text));
    if(sj.status==="failed")break;
    await new Promise(r=>setTimeout(r,50));
    if(i===79)throw new Error("stale task did not fail");
  }

  let r=await a.call("goal_set",{title:"Goal A",steps:["a1"]});
  if(r.isError)throw new Error(r.text);
  r=await b.call("goal_set",{title:"Goal B",steps:["b1"]});
  if(r.isError)throw new Error(r.text);

  const ga=base((await a.call("goal_status")).text);
  const gb=base((await b.call("goal_status")).text);
  if(!ga.includes("Goal A")||ga.includes("Goal B"))throw new Error("session A goal leaked: "+ga);
  if(!gb.includes("Goal B")||gb.includes("Goal A"))throw new Error("session B goal leaked: "+gb);

  r=await b.call("goal_step_done",{});
  if(r.isError)throw new Error("Goal B step finish failed: "+r.text);
  r=await b.call("goal_finish",{summary:"Goal B done"});
  if(r.isError)throw new Error("Goal B finish failed: "+r.text);

  r=await a.call("resource_lock_acquire",{resource:"windows-desktop",lease_seconds:60});
  if(r.isError)throw new Error("A lock failed: "+r.text);
  const leaseA=JSON.parse(base(r.text)).lease_id;
  if(!leaseA)throw new Error("A lock missing lease_id");
  const blocked=await b.call("resource_lock_acquire",{resource:"windows-desktop",lease_seconds:60});
  if(!blocked.isError||!blocked.text.includes("resource busy"))throw new Error("B was not blocked: "+blocked.text);

  await a.tr.terminateSession();
  await a.c.close();a=null;
  await new Promise(r=>setTimeout(r,300));
  const stillBlocked=await b.call("resource_lock_acquire",{resource:"windows-desktop",lease_seconds:60});
  if(!stillBlocked.isError||!stillBlocked.text.includes("resource busy"))throw new Error("explicit lease should survive transport close: "+stillBlocked.text);
  r=await b.call("resource_lock_release",{resource:"windows-desktop",lease_id:leaseA});
  if(r.isError||JSON.parse(base(r.text)).released!==1)throw new Error("cross-transport release failed: "+r.text);
  r=await b.call("resource_lock_acquire",{resource:"windows-desktop",lease_seconds:60});
  if(r.isError)throw new Error("B lock failed after release: "+r.text);
  const leaseB=JSON.parse(base(r.text)).lease_id;
  await b.call("resource_lock_release",{resource:"windows-desktop",lease_id:leaseB});

  c=await mk("session-c");
  const resumed=JSON.parse(base((await c.call("work_resume",{})).text));
  if(resumed.goal?.title!=="Goal A")throw new Error("new session did not resume unique persistent goal: "+JSON.stringify(resumed.goal));
  if(!resumed.latestHandoff?.content?.includes("Goal A")||resumed.latestHandoff.content.includes("Goal B"))throw new Error("handoff was not scoped to resumed goal");
  if(resumed.unfinishedTasks?.some(t=>t.id===staleId))throw new Error("stale failed task leaked into resume");
  if(!(resumed.hiddenLegacyTaskCount>=1))throw new Error("hidden legacy task count missing");
  const recalled=(await c.call("session_recall",{})).text;
  if(!recalled.includes("Goal A")||recalled.includes("Goal B"))throw new Error("session_recall selected unrelated handoff");

  console.log(JSON.stringify({ok:true,goalIsolation:true,lockContention:true,crossTransportLease:true,resumeFallback:true,handoffScoped:true,staleTaskFiltered:true},null,2));
} finally {
  try{if(a)await a.c.close();}catch{}
  try{if(b)await b.c.close();}catch{}
  try{if(c)await c.c.close();}catch{}
  child.kill();
  await new Promise(r=>setTimeout(r,200));
  try{fs.rmSync(TMP,{recursive:true,force:true});}catch{}
}