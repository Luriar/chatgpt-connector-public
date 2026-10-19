#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { classifyWindowsToolTasks,probeWindowsToolPath } from "../src/windows-recovery.js";
import { isRepairableWindowsLocalMcpFailure } from "../src/windows-tool-recovery.js";

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");

const clock=Date.parse("2026-10-04T00:00:00Z"),iso=delta=>new Date(clock+delta).toISOString();
const task={id:"normal",status:"running",action:{type:"tool"},startedAt:iso(-600000),leaseUntil:iso(30000)};
assert.equal(classifyWindowsToolTasks([task],null,{now:clock}).status,"busy","old but leased normal work must not be killed");
assert.equal(classifyWindowsToolTasks([{...task,leaseUntil:iso(-30000)}],null,{now:clock}).status,"stale");
assert.equal(classifyWindowsToolTasks([task],{meta:{activeTaskId:"normal",activeCallDeadline:iso(-30000)}},{now:clock}).reason,"worker_call_deadline_expired");
assert.equal(classifyWindowsToolTasks([task],{meta:{activeTaskId:"different",activeCallDeadline:iso(-30000)}},{now:clock}).status,"busy");
assert.equal(classifyWindowsToolTasks([],{lastSeen:iso(-61000),meta:{}},{now:clock}).reason,"worker_heartbeat_stale");
assert.equal(classifyWindowsToolTasks([],{lastSeen:iso(-30000),meta:{}},{now:clock}).status,"idle");
for(const message of ["Windows local MCP call deadline exceeded","MCP error -32001: Request timed out","fetch failed","read ECONNRESET"]){
  assert.equal(isRepairableWindowsLocalMcpFailure(new Error(message)),true,"repairable local MCP transport failure: "+message);
}
assert.equal(isRepairableWindowsLocalMcpFailure(new Error("tool validation failed")),false,"tool errors must not restart the worker");
const checks=[];
for(const mode of ["healthy","busy","lease_stale","worker_deadline","upstream_down","rpc_broken","invalid_result","lost_ack","busy_race","offline"]){
  let now=clock,posts=0,cancelled=[],created=null,runningReads=0;
  const api=async(url,{method="GET",body}={})=>{
    if(mode==="upstream_down")throw new Error("coordinator unreachable");
    if(url==="/v1/devices")return [{deviceId:"windows-worker",meta:{activeTaskId:"normal",activeCallDeadline:mode==="worker_deadline"?iso(-30000):iso(30000)}}];
    if(url.includes("status=running")){
      runningReads++;
      if(mode==="busy"||mode==="worker_deadline"||(mode==="busy_race"&&runningReads>1))return [task];
      if(mode==="lease_stale")return [{...task,leaseUntil:iso(-30000)}];
      return [];
    }
    if(url.includes("idempotency_key="))return created?[created]:[];
    if(method==="POST"&&url==="/v1/tasks"){
      posts++;assert.equal(body.maxAttempts,1);assert.equal(body.retryOnLeaseExpiry,false);assert.equal(body.action.tool,"computer_uia_status");assert.ok(body.idempotencyKey);
      created={...body,id:"probe",status:mode==="offline"?"waiting_for_device":["rpc_broken","busy_race"].includes(mode)?"queued":"succeeded",result:{mcpResult:{content:[{type:"text",text:"UI_OK"}],isError:mode==="invalid_result"}}};
      if(mode==="lost_ack")throw new Error("request timeout");
      return created;
    }
    if(url.endsWith("/cancel")){cancelled.push(url);return {...created,status:"cancelled"};}
    if(url==="/v1/tasks/probe")return created;
    throw new Error("unexpected fixture request: "+url);
  };
  const r=await probeWindowsToolPath({api,deviceId:"windows-worker",timeoutMs:1000,now:()=>now,sleep:async ms=>{now+=ms;}});
  if(["healthy","lost_ack"].includes(mode)){assert.equal(r.ok,true);assert.equal(r.verified,true);assert.equal(posts,1);assert.equal(cancelled.length,0);}
  if(mode==="busy"){assert.equal(r.status,"busy");assert.equal(r.ok,false);assert.equal(r.verified,false);assert.equal(posts,0);assert.equal(r.repairEligible,false);}
  if(["lease_stale","worker_deadline"].includes(mode)){assert.equal(r.status,"stale");assert.equal(r.repairEligible,true);assert.equal(posts,0);}
  if(mode==="upstream_down"){assert.equal(r.status,"coordinator_unavailable");assert.equal(r.repairEligible,false);assert.equal(posts,0);}
  if(mode==="rpc_broken"){assert.equal(r.status,"probe_timeout");assert.equal(r.repairEligible,true);assert.equal(r.ok,false);assert.equal(cancelled.length,1);}
  if(mode==="invalid_result"){assert.equal(r.status,"probe_failed");assert.equal(r.repairEligible,true);}
  if(mode==="busy_race"){assert.equal(r.status,"busy");assert.equal(r.repairEligible,false);assert.equal(cancelled.length,1);}
  if(mode==="offline"){assert.equal(r.status,"worker_offline");assert.equal(r.repairEligible,true);}
  assert.ok(cancelled.every(url=>url==="/v1/tasks/probe/cancel"),"probe cleanup must never cancel user work");
  checks.push(mode);
}
const workerSource=fs.readFileSync(path.join(root,"scripts","windows-tool-worker.js"),"utf8");
const watchdogSource=fs.readFileSync(path.join(root,"scripts","windows-recovery-watchdog.ps1"),"utf8");
assert.match(workerSource,/WEBJJONKU_WINDOWS_TOOL_RESTART_AFTER_LOCAL_FAILURES/);
assert.match(workerSource,/process\.exit\(75\)/);
assert.match(watchdogSource,/worker-only recovery failed; escalating to local runtime repair/);
assert.match(watchdogSource,/Restart-LocalConnectorRuntime/);
console.log(JSON.stringify({ok:true,checks,healthyLocalMcpDoesNotImplyE2e:true,staleHeartbeatRecovery:true,workerSelfRestart:true,daemonEscalation:true,noLiveChanges:true}));
