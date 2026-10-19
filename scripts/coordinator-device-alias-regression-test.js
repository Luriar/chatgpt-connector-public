#!/usr/bin/env node
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import {spawn} from "node:child_process";
import {fileURLToPath} from "node:url";

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const temp=fs.mkdtempSync(path.join(os.tmpdir(),"wjk-device-alias-"));
const data=path.join(temp,"state.json"),keyPath=data+".key";
const port=await new Promise((resolve,reject)=>{const s=net.createServer();s.once("error",reject);s.listen(0,"127.0.0.1",()=>{const p=s.address().port;s.close(()=>resolve(p));});});
const url="http://127.0.0.1:"+port;
const env={...process.env};
for(const k of Object.keys(env))if(k.startsWith("WEBJJONKU_"))delete env[k];
let child=null, logs="";
async function start(){
  child=spawn(process.execPath,[path.join(root,"scripts/coordinator-server.js"),"--host","127.0.0.1","--port",String(port),"--data",data,"--blob-dir",path.join(temp,"blobs")],{cwd:root,env,stdio:["ignore","pipe","pipe"]});
  child.stderr.on("data",c=>logs+=c.toString());
  child.stdout.on("data",c=>logs+=c.toString());
  for(let n=0;n<130;n++){if(child.exitCode!==null)throw Error("server exited: "+logs.slice(-1200));try{if((await fetch(url+"/health")).ok)return;}catch{}await new Promise(r=>setTimeout(r,65));}
  throw Error("health timeout: "+logs.slice(-1200));
}
async function stop(){if(!child)return;const p=child;child=null;p.kill();await Promise.race([new Promise(r=>p.once("exit",r)),new Promise(r=>setTimeout(r,3000))]);if(p.exitCode===null)p.kill("SIGKILL");}
async function api(path,method="GET",body){const r=await fetch(url+path,{method,headers:body===undefined?{}:{"content-type":"application/json"},body:body===undefined?undefined:JSON.stringify(body)});const b=await r.json();assert.ok(r.ok,"HTTP "+r.status+" "+JSON.stringify(b));return b;}
async function task(target,key){return api("/v1/tasks","POST",{title:"Read-only WHEA fixture",targetDevice:target,executor:"device",localRequired:true,idempotencyKey:key,action:{type:"command",command:"Write-Output WHEA_READONLY"}});}
async function queue(id){const rows=await api("/v1/poll?device_id=windows-worker&executor=device");return rows.filter(x=>x.id===id);}
try{
  await start();
  await api("/v1/devices/heartbeat","POST",{deviceId:"windows-worker",capabilities:["command"]});
  const created=await task("windows","alias-fresh");
  assert.equal(created.targetDevice,"windows-worker");
  assert.equal((await queue(created.id)).length,1);
  const again=await task("windows-worker","alias-fresh");
  assert.equal(again.id,created.id);
  const claimed=await api("/v1/tasks/"+created.id+"/claim","POST",{deviceId:"windows-worker"});
  assert.equal(claimed.attempts,1);
  await api("/v1/tasks/"+created.id+"/complete","POST",{deviceId:"windows-worker",result:{proof:"read-only"}});
  assert.equal((await queue(created.id)).length,0);
  const prior=await task("other-unregistered","legacy-whea");
  assert.equal(prior.status,"waiting_for_device");
  const orphan=await task("future-worker","preserve-offline");
  assert.equal(orphan.status,"waiting_for_device");
  await stop();

  // Simulate an old durable coordinator record with the incorrect alias. The
  // encrypted state is edited only in an isolated test fixture, never live data.
  const envelope=JSON.parse(fs.readFileSync(data,"utf8"));
  const key=Buffer.from(fs.readFileSync(keyPath,"utf8").trim(),"base64");
  const decipher=crypto.createDecipheriv("aes-256-gcm",key,Buffer.from(envelope.iv,"base64"));
  decipher.setAAD(Buffer.from("webjjonku-coordinator-state-v1"));
  decipher.setAuthTag(Buffer.from(envelope.tag,"base64"));
  const state=JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext,"base64")),decipher.final()]).toString());
  state.tasks[prior.id].targetDevice="windows";
  const iv=crypto.randomBytes(12),cipher=crypto.createCipheriv("aes-256-gcm",key,iv);
  cipher.setAAD(Buffer.from("webjjonku-coordinator-state-v1"));
  const ciphertext=Buffer.concat([cipher.update(Buffer.from(JSON.stringify(state))),cipher.final()]);
  fs.writeFileSync(data,JSON.stringify({format:"wjk-state-aesgcm-v1",iv:iv.toString("base64"),tag:cipher.getAuthTag().toString("base64"),ciphertext:ciphertext.toString("base64")}));
  await start();
  const migrated=await api("/v1/tasks/"+prior.id);
  assert.equal(migrated.id,prior.id);
  assert.equal(migrated.targetDevice,"windows-worker");
  assert.equal(migrated.attempts,0);
  await api("/v1/devices/heartbeat","POST",{deviceId:"windows-worker",capabilities:["command"]});
  assert.equal((await queue(prior.id)).length,1);
  const duplicate=await task("windows","legacy-whea");
  assert.equal(duplicate.id,prior.id,"same idempotency must not create a second command");
  await api("/v1/tasks/"+prior.id+"/claim","POST",{deviceId:"windows-worker"});
  await api("/v1/tasks/"+prior.id+"/complete","POST",{deviceId:"windows-worker",result:{proof:"once"}});
  assert.equal((await queue(prior.id)).length,0);
  const offline=await api("/v1/tasks/"+orphan.id);
  assert.equal(offline.targetDevice,"future-worker");
  assert.equal(offline.status,"waiting_for_device");
  console.log(JSON.stringify({ok:true,normalizedAlias:true,onceOnly:true,persistentLegacyRecovery:true,originalTaskIdPreserved:true,unregisteredFutureDevicePreserved:true}));
}finally{await stop();try{fs.rmSync(temp,{recursive:true,force:true});}catch{}}
