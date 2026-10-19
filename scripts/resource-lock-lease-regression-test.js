#!/usr/bin/env node
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";

const ROOT=path.resolve(new URL("..",import.meta.url).pathname.replace(/^\/(.:)/,"$1"));
const TMP=fs.mkdtempSync(path.join(os.tmpdir(),"wjk-lock-lease-"));
const free=()=>new Promise((resolve,reject)=>{
  const s=net.createServer();s.on("error",reject);
  s.listen(0,"127.0.0.1",()=>{const p=s.address().port;s.close(()=>resolve(p));});
});
const port=await free();
const cfg=path.join(TMP,"cfg.json");
fs.writeFileSync(cfg,JSON.stringify({
  roots:[TMP],
  http:{host:"127.0.0.1",port,secretPath:"lock-lease-test"},
  permissions:{default:"allow"}
},null,2));

const childEnv={...process.env};
for(const k of Object.keys(childEnv))if(k.startsWith("WEBJJONKU_"))delete childEnv[k];
childEnv.WEBJJONKU_MCP_JSON_RESPONSE="1";
const child=spawn(process.execPath,[path.join(ROOT,"src","index.js"),"--http","--config",cfg],{
  cwd:TMP,stdio:["ignore","pipe","pipe"],windowsHide:true,
  env:childEnv
});
let stdout="",stderr="",childExit=null;
child.stdout.on("data",d=>stdout+=String(d));
child.stderr.on("data",d=>stderr+=String(d));
child.once("exit",(code,signal)=>{childExit={code,signal};});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

function clean(s){
  let x=String(s||"");
  if(x.startsWith("[UNTRUSTED DATA BOUNDARY]")){
    const i=x.indexOf("\n\n");x=i>=0?x.slice(i+2):"";
  }
  const marker="\n\n───\n",i=x.indexOf(marker);
  return i>=0?x.slice(0,i):x;
}
async function mk(name){
  const tr=new StreamableHTTPClientTransport(new URL("http://127.0.0.1:"+port+"/mcp/lock-lease-test"));
  const c=new Client({name,version:"1"});await c.connect(tr);
  const call=async(name,args={})=>{
    const r=await c.callTool({name,arguments:args});
    return {isError:!!r.isError,text:r.content?.find(x=>x.type==="text")?.text||""};
  };
  return {c,tr,call};
}

let a,b;
try{
  let healthy=false;
  for(let i=0;i<300;i++){
    try{if((await fetch("http://127.0.0.1:"+port+"/health")).ok){healthy=true;break;}}catch{}
    await sleep(100);
  }
  if(!healthy)throw new Error("HTTP server did not start: "+JSON.stringify({childExit,stdout:stdout.slice(-1000),stderr:stderr.slice(-2000)}));

  a=await mk("lease-a");
  const acquired=await a.call("resource_lock_acquire",{resource:"workspace",lease_seconds:60});
  if(acquired.isError)throw new Error(acquired.text);
  const lease=JSON.parse(clean(acquired.text));
  if(!lease.lease_id)throw new Error("lease_id missing");

  await a.tr.terminateSession();await a.c.close();a=null;
  await sleep(200);

  b=await mk("lease-b");
  let status=JSON.parse(clean((await b.call("resource_lock_status",{resource:"workspace"})).text));
  if(status.length!==1)throw new Error("lease disappeared after transport close");

  const wrong=await b.call("resource_lock_release",{resource:"workspace",lease_id:"AAAAAAAAAAAAAAAA"});
  if(wrong.isError)throw new Error(wrong.text);
  if(JSON.parse(clean(wrong.text)).released!==0)throw new Error("wrong lease_id released lock");

  const released=await b.call("resource_lock_release",{resource:"workspace",lease_id:lease.lease_id});
  if(released.isError)throw new Error(released.text);
  if(JSON.parse(clean(released.text)).released!==1)throw new Error("lease_id could not release lock from new transport");

  status=JSON.parse(clean((await b.call("resource_lock_status",{resource:"workspace"})).text));
  if(status.length!==0)throw new Error("lock remains after release");

  console.log(JSON.stringify({ok:true,crossTransportLease:true,wrongLeaseRejected:true},null,2));
} finally {
  try{if(a)await a.c.close();}catch{}
  try{if(b)await b.c.close();}catch{}
  try{if(!child.killed)child.kill();}catch{}
  await sleep(200);
  try{fs.rmSync(TMP,{recursive:true,force:true});}catch{}
}
