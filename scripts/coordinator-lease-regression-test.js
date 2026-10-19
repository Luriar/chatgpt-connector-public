#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

process.env.WEBJJONKU_REMOTE_LEASE_HEARTBEAT_MS="250";
const { registerTaskTools } = await import("../src/tools/tasks.js");
const { registerCoordinatorTools } = await import("../src/tools/coordinator.js");

const tmp=fs.mkdtempSync(path.join(os.tmpdir(),"wjk-lease-regression-"));
const port=19000+Math.floor(Math.random()*1000);
const data=path.join(tmp,"coordinator-state.json");
const server=spawn(process.execPath,["scripts/coordinator-server.js","--host","127.0.0.1","--port",String(port),"--data",data,"--lease-ms","1200","--offline-ms","10000"],{
  cwd:path.resolve("."),stdio:["ignore","pipe","pipe"],env:{...process.env,WEBJJONKU_DURABLE_FSYNC:"0"}
});
let serverOut="";
server.stdout.on("data",d=>serverOut+=d);
server.stderr.on("data",d=>serverOut+=d);

const base="http://127.0.0.1:"+port;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function waitFor(fn,ms=10000,step=50){
  const end=Date.now()+ms;let last;
  while(Date.now()<end){try{const v=await fn();if(v)return v;}catch(e){last=e;}await sleep(step);}
  throw last||new Error("timeout");
}
async function api(p,{method="GET",body}={}){
  const r=await fetch(base+p,{method,headers:body===undefined?{}:{"content-type":"application/json"},body:body===undefined?undefined:JSON.stringify(body)});
  const txt=await r.text();let j=null;try{j=txt?JSON.parse(txt):null;}catch{j=txt;}
  return {status:r.status,j};
}
function assert(cond,msg){if(!cond)throw new Error(msg);}
function taskShape(id,remoteTaskId,command){
  return {
    id,title:"lease regression local",status:"queued",
    steps:[{title:"long command",command,cwd:tmp,status:"pending",output:null,exitCode:null}],
    cwd:tmp,dependsOn:[],projectId:null,localRequired:true,autoRecover:false,
    createdAt:new Date().toISOString(),startedAt:null,finishedAt:null,currentStep:null,error:null,events:[],
    result:null,remoteTaskId,remoteReported:false
  };
}

try{
  await waitFor(async()=>{try{return (await fetch(base+"/health")).ok}catch{return false;}});
  let x=await api("/v1/devices/heartbeat",{method:"POST",body:{deviceId:"dev1",capabilities:["device"]}});
  assert(x.status===200,"device heartbeat failed");

  x=await api("/v1/tasks",{method:"POST",body:{
    title:"heartbeat-live-task",executor:"device",localRequired:false,targetDevice:"dev1",
    action:{type:"command",command:"long"},maxAttempts:1
  }});
  assert(x.status===201,"create live remote task failed");
  const remote=x.j;
  x=await api("/v1/tasks/"+remote.id+"/claim",{method:"POST",body:{deviceId:"dev1"}});
  assert(x.status===200&&x.j.attempts===1,"initial claim failed");
  const deviceLeaseMs=new Date(x.j.leaseUntil).getTime()-Date.now();
  assert(deviceLeaseMs>0&&deviceLeaseMs<=1500,"device lease duration unexpectedly changed: "+deviceLeaseMs);

  // Browser operations take longer than the device lease; validate browser
  // claim and heartbeat grants enough time to finish the declared budget.
  x=await api("/v1/tasks",{method:"POST",body:{
    title:"browser-extended-lease",executor:"browser",localRequired:false,targetDevice:"dev1",
    action:{type:"browser",timeoutMs:65000,steps:[{type:"goto",url:"https://example.com"}]}
  }});
  assert(x.status===201,"browser lease task creation failed");
  const browserTask=x.j;
  x=await api("/v1/tasks/"+browserTask.id+"/claim",{method:"POST",body:{deviceId:"dev1"}});
  let browserLeaseMs=new Date(x.j?.leaseUntil).getTime()-Date.now();
  assert(x.status===200&&browserLeaseMs>=105000&&browserLeaseMs<=120000,"browser claim lease too short: "+browserLeaseMs);
  x=await api("/v1/tasks/"+browserTask.id+"/heartbeat",{method:"POST",body:{deviceId:"dev1"}});
  browserLeaseMs=new Date(x.j?.leaseUntil).getTime()-Date.now();
  assert(x.status===200&&browserLeaseMs>=105000&&browserLeaseMs<=120000,"browser renewed lease too short: "+browserLeaseMs);
  x=await api("/v1/tasks/"+browserTask.id+"/complete",{method:"POST",body:{deviceId:"dev1",result:{verified:true}}});
  assert(x.status===200&&x.j.status==="succeeded","browser extended lease completion failed");

  const marker=path.join(tmp,"marker.txt");
  const store={data:{tasks:{},coordinator:{url:base,deviceId:"dev1",credentialName:null,lastHeartbeat:null,lastError:null}},save(){}};
  store.data.tasks.local_live=taskShape("local_live",remote.id,"printf 'start\\n' >> marker.txt; sleep 3");
  const cfg={roots:[tmp],readOnly:false,redactKeys:[],permissions:{default:"allow",actions:{"exec.command":"allow","coordinator.submit":"allow","task.control":"allow"}},coordinator:{}};
  const ctx1={store,cfg};
  const handlers1={};
  registerTaskTools((name,_meta,handler)=>{handlers1[name]=handler;},ctx1);

  await waitFor(()=>store.data.tasks.local_live.status==="running",3000);
  const ctx2={store,cfg};
  registerTaskTools(()=>{},ctx2);
  await sleep(1700);
  assert(store.data.tasks.local_live.status==="running","new MCP session incorrectly recovered a live task");
  assert(!(store.data.tasks.local_live.events||[]).some(e=>e.type==="recovered_stale_run"),"live task got recovered_stale_run");

  x=await api("/v1/tasks/"+remote.id);
  assert(x.status===200&&x.j.status==="running","remote lease expired despite task-owned heartbeat");
  assert(x.j.attempts===1,"remote task was reclaimed while command still running");

  await waitFor(()=>store.data.tasks.local_live.status==="succeeded",6000);
  const starts=fs.readFileSync(marker,"utf8").trim().split(/\r?\n/).filter(Boolean);
  assert(starts.length===1,"long command executed more than once: "+starts.length);
  x=await api("/v1/tasks/"+remote.id+"/complete",{method:"POST",body:{deviceId:"dev1",result:{test:true}}});
  assert(x.status===200&&x.j.status==="succeeded","remote completion failed");

  // A claimed remote command may remain locally queued while another task owns
  // the workspace lock. The coordinator client must keep that remote lease
  // alive until the local task can actually start and its task-owned heartbeat
  // takes over.
  await api("/v1/devices/heartbeat",{method:"POST",body:{deviceId:"devq",capabilities:["device"]}});
  const storeQueued={data:{tasks:{},coordinator:{url:base,deviceId:"devq",credentialName:null,lastHeartbeat:null,lastError:null}},save(){}};
  const ctxQueued={store:storeQueued,cfg};
  const handlersQueued={};
  registerTaskTools((name,_meta,handler)=>{handlersQueued[name]=handler;},ctxQueued);
  registerCoordinatorTools((name,_meta,handler)=>{handlersQueued[name]=handler;},ctxQueued);
  const blockerRes=await handlersQueued.task_create({
    title:"workspace blocker",steps:[{title:"hold workspace",command:"sleep 3",cwd:tmp}],cwd:tmp,
    local_required:true,auto_start:true,auto_recover:false
  });
  const blocker=JSON.parse(blockerRes.content[0].text);
  await waitFor(()=>storeQueued.data.tasks[blocker.id]?.status==="running",3000,50);
  const queuedMarker=path.join(tmp,"queued-marker.txt");
  const queuedSubmit=await handlersQueued.coordinator_submit({
    title:"queued-lease-heartbeat",executor:"device",local_required:true,target_device:"devq",
    max_attempts:1,retry_on_lease_expiry:false,
    action:{type:"command",command:"printf 'queued-run\\n' >> queued-marker.txt",cwd:tmp}
  });
  const queuedRemote=JSON.parse(queuedSubmit.content[0].text);
  const queuedLocal=await waitFor(()=>Object.values(storeQueued.data.tasks).find(t=>t.remoteTaskId===queuedRemote.id),4000,50);
  assert(queuedLocal.status==="queued","remote local task should wait on workspace lock");
  await sleep(1700);
  x=await api("/v1/tasks/"+queuedRemote.id);
  assert(x.status===200&&x.j.status==="running","queued remote lease expired before local command could start");
  await waitFor(()=>queuedLocal.status==="succeeded",7000,100);
  x=await waitFor(async()=>{const y=await api("/v1/tasks/"+queuedRemote.id);return y.j?.status==="succeeded"?y:false;},4000,100);
  assert(x.j.status==="succeeded","queued remote task did not report success");
  const queuedStarts=fs.readFileSync(queuedMarker,"utf8").trim().split(/\r?\n/).filter(Boolean);
  assert(queuedStarts.length===1,"queued remote command executed more than once: "+queuedStarts.length);

  x=await api("/v1/tasks",{method:"POST",body:{
    title:"no-auto-replay",executor:"device",localRequired:false,targetDevice:"dev1",
    action:{type:"command",command:"noop"}
  }});
  const noRetry=x.j;
  x=await api("/v1/tasks/"+noRetry.id+"/claim",{method:"POST",body:{deviceId:"dev1"}});
  assert(x.status===200,"no-retry claim failed");
  x=await waitFor(async()=>{const y=await api("/v1/tasks/"+noRetry.id);return y.j?.status!=="running"?y:false;},4000,100);
  assert(x.j.status==="failed","expired lease should fail when retry is not explicit; got "+x.j.status);
  assert(x.j.attempts===1,"lease expiry must not increment attempts");
  assert(String(x.j.error||"").includes("automatic replay disabled"),"missing safe lease-expiry error");

  x=await api("/v1/tasks",{method:"POST",body:{
    title:"bounded-retry",executor:"device",localRequired:false,targetDevice:"dev1",
    retryOnLeaseExpiry:true,maxAttempts:2,action:{type:"command",command:"noop"}
  }});
  const bounded=x.j;
  x=await api("/v1/tasks/"+bounded.id+"/claim",{method:"POST",body:{deviceId:"dev1"}});
  assert(x.status===200&&x.j.attempts===1,"bounded retry first claim failed");
  x=await waitFor(async()=>{const y=await api("/v1/tasks/"+bounded.id);return y.j?.status!=="running"?y:false;},4000,100);
  assert(x.j.status==="queued"&&x.j.attempts===1,"first lease expiry should queue exactly one retry; got "+x.j.status);
  x=await api("/v1/tasks/"+bounded.id+"/claim",{method:"POST",body:{deviceId:"dev1"}});
  assert(x.status===200&&x.j.attempts===2,"bounded retry second claim failed");
  x=await waitFor(async()=>{const y=await api("/v1/tasks/"+bounded.id);return y.j?.status!=="running"?y:false;},4000,100);
  assert(x.j.status==="failed"&&x.j.attempts===2,"retry limit did not terminate task; got "+x.j.status);

  await api("/v1/devices/heartbeat",{method:"POST",body:{deviceId:"dev1",capabilities:["device"]}});
  const store2={data:{tasks:{},coordinator:{url:base,deviceId:"dev1",credentialName:null,lastHeartbeat:null,lastError:null}},save(){}};
  const ctx3={store:store2,cfg};
  const handlers3={};
  registerTaskTools((name,_meta,handler)=>{handlers3[name]=handler;},ctx3);
  registerCoordinatorTools((name,_meta,handler)=>{handlers3[name]=handler;},ctx3);
  const cancelMarker=path.join(tmp,"cancel-marker.txt");
  const submitRes=await handlers3.coordinator_submit({
    title:"cancel-live-task",executor:"device",local_required:true,target_device:"dev1",max_attempts:1,retry_on_lease_expiry:false,
    action:{type:"command",command:"printf 'start\\n' >> cancel-marker.txt; sleep 10",cwd:tmp}
  });
  const submitted=JSON.parse(submitRes.content[0].text);
  const localCancelTask=await waitFor(()=>Object.values(store2.data.tasks).find(t=>t.remoteTaskId===submitted.id&&t.status==="running"),7000,100);
  assert(localCancelTask,"coordinator sync did not start cancel test task");
  await waitFor(()=>fs.existsSync(cancelMarker),3000,50);
  await handlers3.coordinator_cancel({id:submitted.id});
  await waitFor(()=>localCancelTask.status==="cancelled",3000,50);
  x=await api("/v1/tasks/"+submitted.id);
  assert(x.j.status==="cancelled","remote coordinator task was not cancelled");
  await sleep(300);
  const cancelStarts=fs.readFileSync(cancelMarker,"utf8").trim().split(/\r?\n/).filter(Boolean);
  assert(cancelStarts.length===1,"cancelled command started more than once");

  console.log(JSON.stringify({ok:true,liveTaskSingleRun:true,heartbeatHeldLease:true,noAutomaticReplay:true,boundedRetry:true,cancelStopsLocal:true}));
} finally {
  try{server.kill("SIGTERM");}catch{}
  await sleep(100);
  try{fs.rmSync(tmp,{recursive:true,force:true});}catch{}
}
