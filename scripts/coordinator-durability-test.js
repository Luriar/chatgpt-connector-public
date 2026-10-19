#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const TMP=fs.mkdtempSync(path.join(os.tmpdir(),"wjk-coord-durability-"));
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
async function waitExit(proc,ms=5000){
  if(!proc||proc.exitCode!==null)return;
  await Promise.race([
    new Promise(r=>proc.once("exit",r)),
    sleep(ms).then(()=>{try{proc.kill("SIGKILL");}catch{}})
  ]);
}
async function stop(){
  const p=child;child=null;
  if(!p)return;
  try{p.kill("SIGTERM");}catch{}
  await waitExit(p);
}
async function start(port){
  const logs=[];
  child=spawn(process.execPath,[
    path.join(ROOT,"scripts","coordinator-server.js"),
    "--host","127.0.0.1",
    "--port",String(port),
    "--data",stateFile,
    "--blob-dir",blobDir
  ],{cwd:ROOT,stdio:["ignore","pipe","pipe"],windowsHide:true});
  child.stdout.on("data",d=>logs.push(d.toString()));
  child.stderr.on("data",d=>logs.push(d.toString()));
  for(let i=0;i<80;i++){
    if(child.exitCode!==null)throw new Error("coordinator exited early: "+logs.join("").slice(-2000));
    try{
      const r=await fetch(`http://127.0.0.1:${port}/health`);
      if(r.ok)return;
    }catch{}
    await sleep(100);
  }
  throw new Error("coordinator health timeout: "+logs.join("").slice(-2000));
}
async function heartbeat(port,generation){
  const r=await fetch(`http://127.0.0.1:${port}/v1/devices/heartbeat`,{
    method:"POST",
    headers:{"content-type":"application/json"},
    body:JSON.stringify({deviceId:"durability-device",capabilities:["test"],meta:{generation}})
  });
  assert(r.ok,"heartbeat failed: "+r.status+" "+await r.text());
}
async function devices(port){
  const r=await fetch(`http://127.0.0.1:${port}/v1/devices`);
  assert(r.ok,"devices failed: "+r.status);
  return await r.json();
}

try{
  let port=await freePort();
  await start(port);
  await heartbeat(port,1);
  await heartbeat(port,2);
  await heartbeat(port,3);
  await stop();

  const bak=stateFile+".bak",bak2=stateFile+".bak2";
  for(const p of [stateFile,bak,bak2]){
    assert(fs.existsSync(p),"missing state generation: "+path.basename(p));
    const envelope=JSON.parse(fs.readFileSync(p,"utf8"));
    assert(envelope?.format==="wjk-state-aesgcm-v1","invalid encrypted state envelope: "+path.basename(p));
  }

  fs.writeFileSync(stateFile,Buffer.alloc(fs.statSync(stateFile).size));
  fs.writeFileSync(bak,Buffer.alloc(fs.statSync(bak).size));

  port=await freePort();
  await start(port);
  const recovered=await devices(port);
  const rec=recovered.find(x=>x.deviceId==="durability-device");
  assert(rec,"device missing after backup2 recovery");
  assert(rec.meta?.generation===1,"expected backup2 generation 1, got "+JSON.stringify(rec.meta));

  await heartbeat(port,4);
  await stop();

  const currentEnvelope=JSON.parse(fs.readFileSync(stateFile,"utf8"));
  const backupEnvelope=JSON.parse(fs.readFileSync(bak,"utf8"));
  assert(currentEnvelope?.format==="wjk-state-aesgcm-v1","main invalid after recovery save");
  assert(backupEnvelope?.format==="wjk-state-aesgcm-v1","backup invalid after recovery save");
  const tmpResidue=fs.readdirSync(TMP).filter(x=>x.includes(".tmp-"));
  assert(tmpResidue.length===0,"temporary coordinator state files leaked: "+tmpResidue.join(","));

  console.log(JSON.stringify({
    ok:true,
    recoveredGeneration:rec.meta.generation,
    generations:["state.json","state.json.bak","state.json.bak2"],
    encryptedAtRest:true
  },null,2));
}finally{
  await stop();
  try{fs.rmSync(TMP,{recursive:true,force:true});}catch{}
}
