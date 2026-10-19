#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import {spawn,execFile} from "node:child_process";
import {promisify} from "node:util";
import {fileURLToPath} from "node:url";

const execFileP=promisify(execFile);
const root=path.resolve(fileURLToPath(new URL("..",import.meta.url)));
const serverFile=path.join(root,"scripts","coordinator-server.js");
const cliFile=path.join(root,"scripts","chatgpt-delegate.mjs");

const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function freePort(){
  return await new Promise((resolve,reject)=>{
    const s=net.createServer();s.once("error",reject);s.listen(0,"127.0.0.1",()=>{const p=s.address().port;s.close(()=>resolve(p));});
  });
}
async function start(dir,port){
  const child=spawn(process.execPath,[serverFile,"--host","127.0.0.1","--port",String(port),"--token","test-local","--data",path.join(dir,"state.json"),"--blob-dir",path.join(dir,"blobs")],{cwd:root,stdio:["ignore","pipe","pipe"],windowsHide:true});
  let err="";child.stderr.on("data",d=>err+=d);
  const base="http://127.0.0.1:"+port;
  for(let i=0;i<100;i++){
    if(child.exitCode!==null)throw new Error("coordinator exited: "+err);
    try{const r=await fetch(base+"/health",{headers:{authorization:"Bearer test-local"}});if(r.ok)return {child,base};}catch{}
    await sleep(50);
  }
  child.kill("SIGKILL");throw new Error("coordinator did not start: "+err);
}
async function stop(child){
  if(child.exitCode!==null)return;
  child.kill("SIGTERM");
  await Promise.race([new Promise(r=>child.once("exit",r)),sleep(2000)]);
  if(child.exitCode===null)child.kill("SIGKILL");
}
async function req(base,method,p,body,token="test-local"){
  const r=await fetch(base+p,{method,headers:{authorization:"Bearer "+token,...(body!==undefined?{"content-type":"application/json"}:{})},body:body===undefined?undefined:JSON.stringify(body)});
  const text=await r.text();let data;try{data=text?JSON.parse(text):null;}catch{data=text;}
  return {status:r.status,data};
}

const dir=fs.mkdtempSync(path.join(os.tmpdir(),"wjk-delegation-"));
let srv;
try{
  const port=await freePort();srv=await start(dir,port);
  const created=(await req(srv.base,"POST","/v1/delegations",{title:"protocol test",instructions:"Change one thing and verify it.",cwd:"/tmp/project",mode:"xh",targetDevice:"nas-mcp",backupMs:30000})).data;
  assert.match(created.id,/^dlg_/);assert.equal(created.status,"running");assert.ok(created.taskToken.length>20);
  const token=created.taskToken;
  assert.equal((await req(srv.base,"POST","/v1/delegations/task",{token:"invalid-capability-token"})).status,404);
  const task=await req(srv.base,"POST","/v1/delegations/task",{token});
  assert.equal(task.status,200);assert.equal(task.data.instructions,"Change one thing and verify it.");
  assert.equal(task.data.cwd,"/tmp/project");

  const payload={token,status:"completed",summary:"done",result:"PASS test\nchanged: one thing"};
  const first=await req(srv.base,"POST","/v1/delegations/submit",payload);
  assert.equal(first.status,200);assert.equal(first.data.duplicate,false);
  const stored=fs.readFileSync(path.join(dir,"blobs","delegations",created.id+".result"),"utf8");
  assert.equal(JSON.parse(stored).format,"wjk-blob-aesgcm-v1");
  assert.ok(!stored.includes(payload.result),"delegation result must be encrypted at rest");
  const publicStatus=(await req(srv.base,"GET","/v1/delegations/"+created.id)).data;
  assert.ok(!("taskTokenHash" in publicStatus));assert.ok(!JSON.stringify(publicStatus).includes(token));
  const duplicate=await req(srv.base,"POST","/v1/delegations/submit",payload);
  assert.equal(duplicate.status,200);assert.equal(duplicate.data.duplicate,true);
  const conflict=await req(srv.base,"POST","/v1/delegations/submit",{...payload,result:"different"});
  assert.equal(conflict.status,409);

  const collected=await req(srv.base,"POST","/v1/delegations/"+created.id+"/collect",{});
  assert.equal(collected.status,200);assert.equal(collected.data.integrity,"verified");assert.equal(collected.data.result,payload.result);
  assert.equal(collected.data.resultSha256,first.data.sha256);
  const revoked=await req(srv.base,"POST","/v1/delegations/task",{token});
  assert.equal(revoked.status,404);

  await stop(srv.child);
  srv=await start(dir,port);
  const persisted=await req(srv.base,"GET","/v1/delegations/"+created.id);
  assert.equal(persisted.status,200);assert.ok(persisted.data.collectedAt);
  const recollect=await req(srv.base,"POST","/v1/delegations/"+created.id+"/collect",{});
  assert.equal(recollect.status,200);assert.equal(recollect.data.result,payload.result);

  const env={...process.env,WEBJJONKU_COORDINATOR_URL:srv.base,WEBJJONKU_COORDINATOR_TOKEN:"test-local"};
  const reg=JSON.parse((await execFileP(process.execPath,[cliFile,"register","--title","CLI task","--task","CLI delegated work","--cwd",root,"--mode","high","--backup-ms","30000"],{cwd:root,windowsHide:true,env})).stdout);
  assert.equal(reg.mode,"h");assert.equal(reg.status,"running");assert.match(reg.prompt,/delegation_get_task/);
  const cliSubmit=await req(srv.base,"POST","/v1/delegations/submit",{token:reg.taskToken,status:"partial",summary:"API done",result:"PASS API\nNOT_RUN UI"});
  assert.equal(cliSubmit.status,200);
  const fin=JSON.parse((await execFileP(process.execPath,[cliFile,"finish",reg.id],{cwd:root,windowsHide:true,env,timeout:10000})).stdout);
  assert.equal(fin.settled,true);assert.equal(fin.events.length,1);assert.equal(fin.events[0].status,"partial");assert.equal(fin.events[0].result,"PASS API\nNOT_RUN UI");assert.equal(fin.events[0].integrity,"verified");

  const open=JSON.parse((await execFileP(process.execPath,[cliFile,"open",root],{cwd:root,windowsHide:true,env})).stdout);
  assert.equal((await req(srv.base,"POST","/v1/delegations/submit",{token:open.taskToken,status:"completed",summary:"forbidden",result:"forbidden"})).status,409);
  assert.equal(open.kind,"open");assert.equal(open.status,"open");assert.match(open.prompt,/Do not call delegation_submit_result/);
  const touch=await req(srv.base,"POST","/v1/delegations/"+open.id+"/touch",{});
  assert.equal(touch.status,200);assert.ok(touch.data.idleExpiresAt);

  const cancelled=(await req(srv.base,"POST","/v1/delegations",{instructions:"cancel me",targetDevice:"nas-mcp"})).data;
  assert.equal((await req(srv.base,"POST","/v1/delegations/"+cancelled.id+"/cancel",{})).status,200);
  assert.equal((await req(srv.base,"POST","/v1/delegations/task",{token:cancelled.taskToken})).status,404);
  const finCancel=JSON.parse((await execFileP(process.execPath,[cliFile,"finish",cancelled.id],{cwd:root,windowsHide:true,env,timeout:10000})).stdout);
  assert.equal(finCancel.settled,true);assert.equal(finCancel.events[0].status,"cancelled");

  const owner=(await req(srv.base,"POST","/v1/auth/tokens",{role:"client",subject:"owner"})).data.token;
  const stranger=(await req(srv.base,"POST","/v1/auth/tokens",{role:"client",subject:"stranger"})).data.token;
  const workerToken=(await req(srv.base,"POST","/v1/auth/tokens",{role:"device",subject:"nas-mcp"})).data.token;
  const owned=(await req(srv.base,"POST","/v1/delegations",{instructions:"subject-scoped task",targetDevice:"nas-mcp"},owner)).data;
  assert.equal((await req(srv.base,"GET","/v1/delegations/"+owned.id,undefined,stranger)).status,403);
  assert.equal((await req(srv.base,"POST","/v1/delegations/"+owned.id+"/cancel",{},stranger)).status,403);
  const strangerList=(await req(srv.base,"GET","/v1/delegations",undefined,stranger)).data;
  assert.ok(!strangerList.some(x=>x.id===owned.id));
  assert.equal((await req(srv.base,"POST","/v1/delegations",{instructions:"unauthorized create"},workerToken)).status,403);
  assert.equal((await req(srv.base,"POST","/v1/delegations/task",{token:owned.taskToken},workerToken)).status,200);
  assert.ok(!fs.readFileSync(path.join(dir,"state.json"),"utf8").includes(owned.taskToken));

  console.log(JSON.stringify({ok:true,encryptedResult:true,scopedAuthorization:true,capabilityToken:true,idempotentSubmit:true,integrityCollect:true,restartPersistence:true,quietFinish:true,openLease:true,cancelSettles:true}));
}finally{
  if(srv?.child)await stop(srv.child);
  fs.rmSync(dir,{recursive:true,force:true});
}
