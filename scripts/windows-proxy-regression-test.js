#!/usr/bin/env node
import http from "node:http";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { pinnedRequest } from "../src/net-safe.js";

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const temp=fs.mkdtempSync(path.join(os.tmpdir(),"wjk-proxy-regression-"));
const originalPlatform=Object.getOwnPropertyDescriptor(process,"platform");
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const freePort=()=>new Promise(resolve=>{const s=net.createServer();s.listen(0,"127.0.0.1",()=>{const p=s.address().port;s.close(()=>resolve(p));});});
const port=await freePort();
const direct="http://127.0.0.1:"+port;
const child=spawn(process.execPath,["scripts/coordinator-server.js","--host","127.0.0.1","--port",String(port),"--data",path.join(temp,"state.json"),"--blob-dir",path.join(temp,"blobs")],{cwd:root,windowsHide:true,stdio:["ignore","pipe","pipe"],env:{...process.env,WEBJJONKU_COORDINATOR_TOKEN:""}});
let logs="",mode="fast",posts=0,lookups=0,lastSubmission=null;
child.stdout.on("data",b=>{logs=(logs+b).slice(-2000);});child.stderr.on("data",b=>{logs=(logs+b).slice(-2000);});
const executions=new Map(),timers=new Set();
const later=(fn,ms)=>{const timer=setTimeout(()=>{timers.delete(timer);fn();},ms);timers.add(timer);};
const send=(res,status,data)=>{if(res.destroyed||res.writableEnded)return;res.writeHead(status,{"content-type":"application/json"});res.end(JSON.stringify(data));};
async function api(p,method="GET",body){const r=await fetch(direct+p,{method,headers:{"content-type":"application/json"},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(3000)});const data=await r.json();if(!r.ok)throw new Error(JSON.stringify(data));return data;}
async function execute(task,large=false){
  if(executions.has(task.id)||task.status==="waiting_for_device")return;
  executions.set(task.id,1);
  await api("/v1/tasks/"+task.id+"/claim","POST",{deviceId:"windows-worker"});
  await api("/v1/tasks/"+task.id+"/complete","POST",{deviceId:"windows-worker",result:{mcpResult:{content:[{type:"text",text:large?"X".repeat(100000):"UI_OK"}]}}});
}
const server=http.createServer(async(req,res)=>{
  try{
    if(req.url==="/trickle"){
      res.writeHead(200);const interval=setInterval(()=>res.write("."),20);res.on("close",()=>clearInterval(interval));return;
    }
    if(req.method==="POST"&&req.url==="/v1/tasks"){
      posts++;const chunks=[];for await(const c of req)chunks.push(c);
      const body=JSON.parse(Buffer.concat(chunks).toString());
      lastSubmission=body;
      const task=await api(req.url,"POST",body);
      if(mode!=="slow")await execute(task,mode==="large");
      if((mode==="retry"&&posts===1)||mode==="lookup"||mode==="unknown")later(()=>send(res,201,task),3400);
      else send(res,201,await api("/v1/tasks/"+task.id));
      return;
    }
    if(req.url.includes("idempotency_key=")){
      lookups++;
      if(mode==="unknown")return send(res,503,{error:"simulated lookup outage"});
      if(mode==="retry"&&lookups===1)return send(res,200,[]);
    }
    send(res,200,await api(req.url));
  }catch(e){send(res,500,{error:e.message});}
});
try{
  let ready=false;
  for(let i=0;i<80;i++){if(child.exitCode!==null)throw new Error(logs);try{await api("/health");ready=true;break;}catch{}await sleep(100);}
  assert.ok(ready,"test coordinator must start");
  await api("/v1/devices/heartbeat","POST",{deviceId:"windows-worker",capabilities:["tool-rpc"]});
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
  process.env.WEBJJONKU_COORDINATOR_URL="http://127.0.0.1:"+server.address().port;
  process.env.WEBJJONKU_WINDOWS_TOOL_PROXY="1";
  process.env.WEBJJONKU_WINDOWS_TOOL_DEVICE_ID="windows-worker";
  process.env.WEBJJONKU_WINDOWS_TOOL_SUBMIT_TIMEOUT_MS="3000";
  process.env.WEBJJONKU_WINDOWS_TOOL_FOREGROUND_WAIT_MS="1000";
  // The production proxy correctly disables itself on Windows. Emulate the NAS only in this test.
  Object.defineProperty(process,"platform",{...originalPlatform,value:"linux"});
  const {maybeProxyWindowsTool}=await import("../src/windows-proxy.js");
  const checks=[];
  for(const scenario of ["retry","lookup","fast","unknown","slow","large"]){
    mode=scenario;posts=0;lookups=0;const before=executions.size;
    const out=await maybeProxyWindowsTool({},"computer_uia_status",{});
    if(["retry","lookup","fast"].includes(scenario))assert.equal(out.content[0].text,"UI_OK");
    if(scenario==="retry")assert.equal(posts,2,"lost ACK retries identical submission key");
    if(scenario==="lookup")assert.equal(posts,1,"known result lookup avoids a second POST");
    if(scenario==="unknown"){
      assert.equal(posts,2);assert.equal(out._meta.status,"submission_unknown");assert.match(out._meta.idempotencyKey,/^windows-proxy:/);
      const rows=await api("/v1/tasks?idempotency_key="+encodeURIComponent(out._meta.idempotencyKey));assert.equal(rows.length,1);
    }
    if(scenario==="slow"){
      assert.match(out.content[0].text,/work_status/);const taskId=out.content[0].text.match(/rt_[a-z0-9]+/)[0];
      const task=await api("/v1/tasks/"+taskId);assert.equal(task.status,"queued");await execute(task);
    }
    if(scenario==="large"){assert.ok(JSON.stringify(out).length<65536);assert.ok(out._meta.taskId);assert.equal((await api("/v1/tasks/"+out._meta.taskId)).result.mcpResult.content[0].text.length,100000);}
    assert.equal(executions.size,before+1,"each task has exactly one remote side effect");checks.push(scenario);
  }
  mode="fast";
  const workspace={id:"ws-nas-physical",lineageId:"shared-goal-lineage",goalId:"shared-goal"};
  const ctx={cfg:{stateDir:temp},store:{data:{goal:{id:"shared-goal",workspaceId:workspace.id,lineageId:workspace.lineageId},workspaces:{[workspace.id]:workspace}}}};
  await maybeProxyWindowsTool(ctx,"worker_spawn",{host:"windows",commands:["harmless"]});
  assert.equal(lastSubmission.action.args.workspace_id,undefined,"NAS physical workspace never crosses hosts implicitly");
  assert.equal(lastSubmission.action.args.lineage_id,workspace.lineageId);
  assert.equal(lastSubmission.action.args.goal_id,workspace.goalId);
  await maybeProxyWindowsTool(ctx,"worker_spawn",{host:"windows",lineage_id:"explicit-lineage",commands:["harmless"]});
  assert.equal(lastSubmission.action.args.lineage_id,"explicit-lineage");
  assert.equal(lastSubmission.action.args.goal_id,undefined,"explicit different lineage must not inherit current goal");
  await maybeProxyWindowsTool(ctx,"worker_spawn",{host:"windows",workspace_id:"windows-local-id",commands:["harmless"]});
  assert.equal(lastSubmission.action.args.workspace_id,"windows-local-id");
  assert.equal(lastSubmission.action.args.lineage_id,undefined,"explicit target-host workspace remains authoritative");
  checks.push("cross_host_lineage_routing");
  mode="fast";
  await maybeProxyWindowsTool({},"task_status",{id:"task_win_0123456789"});
  assert.equal(lastSubmission.action.tool,"task_status");
  assert.equal(lastSubmission.action.args.id,"task_win_0123456789");
  assert.equal(await maybeProxyWindowsTool({},"task_status",{id:"task_0123456789"}),null,"NAS/local legacy tasks must not be redirected");
  checks.push("windows_durable_task_status_routing");
  mode="offline";process.env.WEBJJONKU_WINDOWS_TOOL_DEVICE_ID="offline-worker";
  await assert.rejects(()=>maybeProxyWindowsTool({},"computer_uia_status",{}),/Windows worker offline/);
  const waiting=await maybeProxyWindowsTool({},"exec_command",{command:"echo harmless",shell:"powershell",durable:true,timeout_ms:5000});
  assert.equal(lastSubmission.action.timeout_ms,5000,"durable Windows command deadline reaches the device executor");
  checks.push("windows_durable_command_deadline");
  assert.match(waiting.content[0].text,/durable Windows task/);checks.push("offline_tool_and_durable_waiting");
  const start=Date.now();
  await assert.rejects(()=>pinnedRequest(process.env.WEBJJONKU_COORDINATOR_URL+"/trickle",{timeoutMs:150,allowLoopback:true}),/request timeout/);
  assert.ok(Date.now()-start<700,"whole-body deadline must bound trickled responses");checks.push("absolute_network_deadline");
  console.log(JSON.stringify({ok:true,checks,executions:executions.size,realCoordinator:true}));
}finally{
  Object.defineProperty(process,"platform",originalPlatform);
  for(const timer of timers)clearTimeout(timer);
  server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
  if(child.exitCode===null){child.kill();await new Promise(resolve=>child.once("exit",resolve));}
  if(path.dirname(temp)===path.resolve(os.tmpdir())&&path.basename(temp).startsWith("wjk-proxy-regression-"))fs.rmSync(temp,{recursive:true,force:true});
}
