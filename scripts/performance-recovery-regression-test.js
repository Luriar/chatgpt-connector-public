#!/usr/bin/env node
import { submitAndMaybeWait } from "../src/tools/coordinator.js";
import { collectDiagnostics } from "../src/tools/diagnostics.js";
import { connectorRecoveryAction, shouldAttemptConnectorRecovery } from "../src/nas-health-recovery.js";

function assert(cond,msg){if(!cond)throw new Error(msg);}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

let polls=0;
const fastApi=async(p,o={})=>{
  if(p==="/v1/tasks"&&o.method==="POST")return {id:"t1",status:"queued"};
  if(p==="/v1/tasks/t1"){
    polls++;
    return polls>=2?{id:"t1",status:"succeeded",result:{ok:true}}:{id:"t1",status:"running"};
  }
  throw new Error("unexpected fastApi call "+p);
};
const fast=await submitAndMaybeWait(fastApi,{title:"fast",idempotencyKey:"fast-1"},{waitMs:800,pollMs:100});
assert(fast.status==="succeeded","bounded wait did not return terminal task");
assert(fast.wait?.terminal===true,"bounded wait terminal flag missing");
assert(polls===2,"bounded wait poll count unexpected: "+polls);

let waitingPolls=0;
const waiting=await submitAndMaybeWait(async(p,o={})=>{
  if(p==="/v1/tasks"&&o.method==="POST")return {id:"tw",status:"waiting_for_device"};
  waitingPolls++;
  throw new Error("waiting_for_device must not poll");
},{title:"offline"},{waitMs:800,pollMs:100});
assert(waiting.status==="waiting_for_device","waiting_for_device status changed");
assert(waitingPolls===0,"waiting_for_device unexpectedly polled");

let lostAckSubmit=0,lostAckPoll=0;
const lostAck=await submitAndMaybeWait(async(p,o={})=>{
  if(p==="/v1/tasks"&&o.method==="POST"){
    lostAckSubmit++;
    throw new Error("simulated lost submit ack");
  }
  if(p.startsWith("/v1/tasks?idempotency_key="))return [{id:"tl",status:"queued"}];
  if(p==="/v1/tasks/tl"){
    lostAckPoll++;
    return {id:"tl",status:"succeeded"};
  }
  throw new Error("unexpected lostAck call "+p);
},{title:"lost-ack",idempotencyKey:"lost-ack-1"},{waitMs:500,pollMs:100});
assert(lostAckSubmit===1,"lost ACK submit replayed");
assert(lostAck.status==="succeeded","lost ACK recovery did not finish");
assert(lostAck.submitRecovery?.recovered===true,"lost ACK recovery metadata missing");
assert(lostAckPoll===1,"lost ACK recovery poll count unexpected");

assert(connectorRecoveryAction("created")==="start","created container must start");
assert(connectorRecoveryAction("exited")==="start","exited container must start");
assert(connectorRecoveryAction("running")==="restart","running unhealthy container must restart");
assert(shouldAttemptConnectorRecovery("created",0,3)===true,"created container must recover immediately");
assert(shouldAttemptConnectorRecovery("exited",1,3)===true,"exited container must recover immediately");
assert(shouldAttemptConnectorRecovery("running",2,3)===false,"running container restarted before threshold");
assert(shouldAttemptConnectorRecovery("running",3,3)===true,"running container did not restart at threshold");
assert(shouldAttemptConnectorRecovery("missing",99,3)===false,"unsupported state must not recover");

const fakeCtx={
  cfg:{roots:[process.cwd()],http:{host:"127.0.0.1",port:9}},
  store:{data:{
    tasks:{a:{status:"succeeded"},b:{status:"failed",id:"b",title:"failed",error:"boom"}},
    workerRecords:[{status:"done"},{status:"failed"}],
    goals:{g1:{finishedAt:null},g2:{finishedAt:new Date().toISOString()}},
    coordinator:{lastError:null}
  }}
};
const delayed=async value=>{await sleep(150);return value;};
const diagnostics=await collectDiagnostics(
  fakeCtx,
  async p=>{
    if(p==="/health")return delayed({ok:true,name:"fake-coordinator"});
    throw new Error("unexpected diagnostics api "+p);
  },
  {
    localHealth:()=>delayed({ok:true,name:"fake-connector"}),
    gitSnapshot:()=>delayed({head:"deadbeef",branch:"beta",trackedChanges:[],dirtyTracked:false,untrackedIncluded:false})
  }
);
assert(diagnostics.coordinator.ok===true&&diagnostics.coordinator.value?.ok===true,"diagnostics coordinator health missing");
assert(diagnostics.connector.ok===true&&diagnostics.connector.value?.ok===true,"diagnostics connector health missing");
assert(diagnostics.git.ok===true&&diagnostics.git.value?.branch==="beta","diagnostics git snapshot failed");
assert(diagnostics.state.tasks.succeeded===1&&diagnostics.state.tasks.failed===1,"diagnostics task counts wrong");
assert(diagnostics.state.workers.done===1&&diagnostics.state.workers.failed===1,"diagnostics worker counts wrong");
assert(diagnostics.state.activeGoals===1,"diagnostics active goal count wrong");
assert(diagnostics.elapsedMs<350,"diagnostics probes did not run in parallel: "+diagnostics.elapsedMs);

console.log(JSON.stringify({
  ok:true,
  boundedWait:{polls,terminal:fast.wait.terminal,elapsedMs:fast.wait.elapsedMs},
  lostAckRecovery:true,
  immediateStoppedContainerRecovery:true,
  diagnosticsElapsedMs:diagnostics.elapsedMs
}));
