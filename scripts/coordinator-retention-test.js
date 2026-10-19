#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const TMP=fs.mkdtempSync(path.join(os.tmpdir(),"wjk-coord-retention-"));
const stateFile=path.join(TMP,"state.json");
const blobDir=path.join(TMP,"blobs");
let child=null;

const assert=(cond,msg)=>{if(!cond)throw new Error(msg);};
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));

async function freePort(){
  return await new Promise((resolve,reject)=>{
    const s=net.createServer();s.once("error",reject);
    s.listen(0,"127.0.0.1",()=>{const p=s.address().port;s.close(()=>resolve(p));});
  });
}
async function start(port){
  const logs=[];
  child=spawn(process.execPath,[
    path.join(ROOT,"scripts","coordinator-server.js"),
    "--host","127.0.0.1","--port",String(port),
    "--data",stateFile,"--blob-dir",blobDir
  ],{
    cwd:ROOT,
    env:{...process.env,WEBJJONKU_MAX_TERMINAL_RESULT_BYTES:"16384",WEBJJONKU_TERMINAL_RESULT_GRACE_MS:"1000",WEBJJONKU_MAX_EPHEMERAL_TERMINAL_TASKS:"20"},
    stdio:["ignore","pipe","pipe"],windowsHide:true
  });
  child.stdout.on("data",d=>logs.push(String(d)));child.stderr.on("data",d=>logs.push(String(d)));
  for(let i=0;i<80;i++){
    if(child.exitCode!==null)throw new Error("coordinator exited: "+logs.join("").slice(-2000));
    try{const r=await fetch(`http://127.0.0.1:${port}/health`);if(r.ok)return;}catch{}
    await sleep(100);
  }
  throw new Error("health timeout: "+logs.join("").slice(-2000));
}
async function stop(){
  if(!child)return;const p=child;child=null;try{p.kill("SIGTERM");}catch{}
  await Promise.race([new Promise(r=>p.once("exit",r)),sleep(3000).then(()=>{try{p.kill("SIGKILL");}catch{}})]);
}
async function req(port,method,p,body){
  const r=await fetch(`http://127.0.0.1:${port}${p}`,{
    method,headers:body===undefined?{}:{"content-type":"application/json"},
    body:body===undefined?undefined:JSON.stringify(body)
  });
  const raw=await r.text();let data=null;try{data=raw?JSON.parse(raw):null;}catch{data=raw;}
  if(!r.ok)throw new Error(`${method} ${p} -> ${r.status}: ${raw.slice(0,1000)}`);
  return data;
}

try{
  const port=await freePort();
  await start(port);
  const deviceId="retention-device";
  await req(port,"POST","/v1/devices/heartbeat",{deviceId,capabilities:["command"],meta:{generation:1}});
  const task=await req(port,"POST","/v1/tasks",{
    title:"retention regression",executor:"device",localRequired:true,targetDevice:deviceId,
    maxAttempts:1,retryOnLeaseExpiry:false,action:{type:"command",command:"echo retention"}
  });
  await req(port,"POST",`/v1/tasks/${task.id}/claim`,{deviceId});
  const noisy="\"\\\n".repeat(30000);
  await req(port,"POST",`/v1/tasks/${task.id}/complete`,{
    deviceId,result:{localTaskId:"retention-local",steps:[{title:"command",exitCode:0,output:noisy}]}
  });
  await sleep(1200);
  await req(port,"POST","/v1/devices/heartbeat",{deviceId,capabilities:["command"],meta:{generation:2}});
  const saved=await req(port,"GET",`/v1/tasks/${task.id}`);
  const bytes=Buffer.byteLength(JSON.stringify(saved.result),"utf8");
  assert(bytes<=16384,"compacted result exceeds 16KiB: "+bytes);
  assert(saved.result?.truncated===true,"compacted result missing truncated marker");

  const durable=await req(port,"POST","/v1/tasks",{
    title:"durable keyed task",executor:"device",localRequired:true,targetDevice:deviceId,
    maxAttempts:1,retryOnLeaseExpiry:false,idempotencyKey:"durable-keyed-retention",
    action:{type:"command",command:"echo durable"}
  });
  await req(port,"POST",`/v1/tasks/${durable.id}/claim`,{deviceId});
  await req(port,"POST",`/v1/tasks/${durable.id}/complete`,{deviceId,result:{ok:true}});

  const legacyIds=[];
  for(let i=0;i<5;i++){
    const legacy=await req(port,"POST","/v1/tasks",{
      title:"Windows recovery E2E probe",executor:"device",localRequired:true,targetDevice:deviceId,
      maxAttempts:1,retryOnLeaseExpiry:false,idempotencyKey:"windows-recovery:legacy-"+i,
      action:{type:"tool",tool:"computer_uia_status",args:{}}
    });
    legacyIds.push(legacy.id);
    await req(port,"POST",`/v1/tasks/${legacy.id}/claim`,{deviceId});
    await req(port,"POST",`/v1/tasks/${legacy.id}/complete`,{deviceId,result:{ok:true,legacy:i}});
  }
  const ephemeralIds=[];
  for(let i=0;i<25;i++){
    const e=await req(port,"POST","/v1/tasks",{
      title:"ephemeral retention "+i,executor:"device",localRequired:true,targetDevice:deviceId,
      maxAttempts:1,retryOnLeaseExpiry:false,idempotencyKey:"ephemeral-retention-"+i,retentionClass:"ephemeral",
      action:{type:"tool",tool:"computer_uia_status",args:{}}
    });
    ephemeralIds.push(e.id);
    await req(port,"POST",`/v1/tasks/${e.id}/claim`,{deviceId});
    await req(port,"POST",`/v1/tasks/${e.id}/complete`,{deviceId,result:{ok:true,index:i}});
  }
  await req(port,"POST","/v1/devices/heartbeat",{deviceId,capabilities:["command"],meta:{generation:3}});
  const terminal=await req(port,"GET","/v1/tasks?status=succeeded&limit=500");
  const ephemeral=terminal.filter(t=>t.retentionClass==="ephemeral");
  assert(ephemeral.length===20,"ephemeral terminal retention cap failed: "+ephemeral.length);
  assert(legacyIds.every(id=>!terminal.some(t=>t.id===id)),"legacy Windows recovery probes were not pruned");
  assert(terminal.some(t=>t.id===durable.id),"ordinary keyed terminal task was pruned");
  assert(!terminal.some(t=>t.id===ephemeralIds[0]),"oldest ephemeral terminal task was not pruned");
  const recreated=await req(port,"POST","/v1/tasks",{
    title:"ephemeral retention recreated",executor:"device",localRequired:true,targetDevice:deviceId,
    maxAttempts:1,retryOnLeaseExpiry:false,idempotencyKey:"ephemeral-retention-0",retentionClass:"ephemeral",
    action:{type:"tool",tool:"computer_uia_status",args:{}}
  });
  assert(recreated.id!==ephemeralIds[0],"pruned ephemeral idempotency metadata remained live");
  console.log(JSON.stringify({ok:true,resultBytes:bytes,status:saved.status,ephemeralRetained:ephemeral.length,legacyRecoveryPruned:true,durableKeyedPreserved:true,recreatedPrunedKey:true},null,2));
}finally{
  await stop();
  try{fs.rmSync(TMP,{recursive:true,force:true});}catch{}
}