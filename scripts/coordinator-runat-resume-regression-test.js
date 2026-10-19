#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const TMP=fs.mkdtempSync(path.join(os.tmpdir(),"wjk-runat-resume-"));
const stateFile=path.join(TMP,"state.json");
const blobDir=path.join(TMP,"blobs");
let child=null;

const assert=(cond,msg)=>{if(!cond)throw new Error(msg);};
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));

async function freePort(){
  return await new Promise((resolve,reject)=>{
    const s=net.createServer();
    s.once("error",reject);
    s.listen(0,"127.0.0.1",()=>{const p=s.address().port;s.close(()=>resolve(p));});
  });
}
async function stop(){
  if(!child)return;
  const p=child;child=null;
  try{p.kill("SIGTERM");}catch{}
  await Promise.race([new Promise(r=>p.once("exit",r)),sleep(3000)]);
  if(p.exitCode===null)try{p.kill("SIGKILL");}catch{}
}
async function start(port){
  const logs=[];
  child=spawn(process.execPath,[path.join(ROOT,"scripts","coordinator-server.js"),"--host","127.0.0.1","--port",String(port),"--data",stateFile,"--blob-dir",blobDir],{cwd:ROOT,stdio:["ignore","pipe","pipe"],windowsHide:true});
  child.stdout.on("data",d=>logs.push(d.toString()));
  child.stderr.on("data",d=>logs.push(d.toString()));
  for(let i=0;i<80;i++){
    if(child.exitCode!==null)throw new Error("coordinator exited early: "+logs.join("").slice(-2000));
    try{const r=await fetch(`http://127.0.0.1:${port}/health`);if(r.ok)return;}catch{}
    await sleep(100);
  }
  throw new Error("coordinator health timeout: "+logs.join("").slice(-2000));
}
async function heartbeat(port,deviceId){
  const r=await fetch(`http://127.0.0.1:${port}/v1/devices/heartbeat`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({deviceId,capabilities:["command"],meta:{kind:"test-device"}})});
  assert(r.ok,"heartbeat failed "+r.status+" "+await r.text());
}
async function create(port,{deviceId,delayMs,title}){
  const runAt=new Date(Date.now()+delayMs).toISOString();
  const r=await fetch(`http://127.0.0.1:${port}/v1/tasks`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({title,executor:"device",localRequired:true,targetDevice:deviceId,runAt,action:{type:"command",command:"echo ok"}})});
  if(!r.ok)throw new Error("task create failed "+r.status+" "+await r.text());
  const t=await r.json();
  assert(t.status==="scheduled","expected scheduled, got "+t.status);
  return t;
}
async function task(port,id){
  const r=await fetch(`http://127.0.0.1:${port}/v1/tasks/${encodeURIComponent(id)}`);
  assert(r.ok,"task read failed "+r.status);
  return await r.json();
}
async function poll(port,deviceId){
  const r=await fetch(`http://127.0.0.1:${port}/v1/poll?device_id=${encodeURIComponent(deviceId)}&executor=device`);
  if(!r.ok)throw new Error("poll failed "+r.status+" "+await r.text());
  return await r.json();
}
async function waitFor(fn,pred,ms=5000){
  const deadline=Date.now()+ms;
  let last=null;
  while(Date.now()<deadline){
    last=await fn();
    if(pred(last))return last;
    await sleep(100);
  }
  throw new Error("condition timeout; last="+JSON.stringify(last));
}
async function claim(port,id,deviceId){
  const r=await fetch(`http://127.0.0.1:${port}/v1/tasks/${encodeURIComponent(id)}/claim`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({deviceId})});
  if(!r.ok)throw new Error("claim failed "+r.status+" "+await r.text());
  return await r.json();
}

try{
  const port=await freePort();
  await start(port);

  const online="resume-online";
  await heartbeat(port,online);
  const a=await create(port,{deviceId:online,delayMs:350,title:"scheduled online continuation"});
  const immediate=await poll(port,online);
  assert(!immediate.some(x=>x.id===a.id),"scheduled task leaked into poll before runAt");
  const dueRows=await waitFor(()=>poll(port,online),rows=>rows.some(x=>x.id===a.id));
  assert(dueRows.some(x=>x.id===a.id),"due task missing from poll");
  const claimedA=await claim(port,a.id,online);
  assert(claimedA.status==="running","online task not claimable after runAt");

  const late="resume-late";
  const b=await create(port,{deviceId:late,delayMs:300,title:"scheduled reconnect continuation"});
  const waiting=await waitFor(()=>task(port,b.id),t=>t.status==="waiting_for_device");
  assert(waiting.status==="waiting_for_device","offline due task did not wait for device");
  await heartbeat(port,late);
  const reconnectRows=await waitFor(()=>poll(port,late),rows=>rows.some(x=>x.id===b.id));
  assert(reconnectRows.some(x=>x.id===b.id),"reconnected device did not receive due task");
  const claimedB=await claim(port,b.id,late);
  assert(claimedB.status==="running","reconnected task not claimable");

  console.log(JSON.stringify({ok:true,onlineTask:a.id,reconnectTask:b.id,scheduledHiddenBeforeDue:true,reconnectResumed:true},null,2));
}finally{
  await stop();
  try{fs.rmSync(TMP,{recursive:true,force:true});}catch{}
}
