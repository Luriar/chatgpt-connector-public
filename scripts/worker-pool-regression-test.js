#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const temp=fs.mkdtempSync(path.join(os.tmpdir(),"wjk-worker-pool-"));
const stateDir=path.join(temp,".state");
fs.mkdirSync(stateDir,{recursive:true});
const host=process.platform==="win32"?"windows":"nas";
const otherHost=host==="windows"?"nas":"windows";
const prefix=host==="windows"?"ww":"wn";
const cmd=process.platform==="win32"
  ? {hold:"Start-Sleep -Milliseconds 450",ok:"Write-Output second",fail:"exit 7",replacement:"Write-Output replacement",no:"Write-Output no"}
  : {hold:"sleep 0.45",ok:"printf second",fail:"exit 7",replacement:"printf replacement",no:"printf no"};

const cfg={
  roots:[temp],
  stateDir,
  runtimeProfile:host,
  readOnly:false,
  workers:{
    max:1,queueMax:4,minFreeMemoryMB:0,maxLoadPerCpu:99,
    hosts:{
      nas:{max:host==="nas"?1:4,queueMax:8,minFreeMemoryMB:0,maxLoadPerCpu:99},
      windows:{max:host==="windows"?1:4,queueMax:8,minFreeMemoryMB:0,maxLoadPerCpu:99}
    }
  },
  permissions:{default:"allow",actions:{}},
  effortDefault:"medium",
  redactKeys:[]
};
const store={
  data:{workerRecords:[],notes:[],goals:{},goal:null,goalHistory:[],effort:"medium",workspaceRecords:{}},
  save(){}
};
const ctx={cfg,baseCfg:cfg,store,sessionRef:{id:null,scoped:false}};
const tools=new Map();
const reg=(name,meta,handler)=>tools.set(name,handler);

const {registerWorkerTools}=await import("../src/tools/workers.js");
const {shouldProxyWindowsTool}=await import("../src/windows-proxy.js");
registerWorkerTools(reg,ctx);

const call=async(name,args={})=>{
  const fn=tools.get(name);
  assert.ok(fn,"missing tool "+name);
  return fn(args);
};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const waitForStatus=async(id,status,timeoutMs=5000)=>{
  const deadline=Date.now()+timeoutMs;
  while(Date.now()<deadline){
    const current=store.data.workerRecords.find(r=>r.id===id)?.status;
    if(current===status)return current;
    await sleep(50);
  }
  return store.data.workerRecords.find(r=>r.id===id)?.status;
};

try{
  assert.equal(store.data.workerRecords.length,0,"pool starts at scale zero");

  const first=await call("worker_spawn",{task:"first",kind:"exec",commands:[cmd.hold],host});
  assert.match(first.content[0].text,new RegExp("워커 "+prefix));
  let rows=store.data.workerRecords;
  assert.equal(rows.at(-1).status,"running","first task scales pool 0 -> 1");
  const firstId=rows.at(-1).id;
  assert.ok(firstId.startsWith(prefix));

  const second=await call("worker_spawn",{task:"second",kind:"exec",commands:[cmd.ok],host});
  rows=store.data.workerRecords;
  const secondRec=rows.at(-1);
  assert.equal(secondRec.status,"queued","second task queues at max=1");
  assert.equal(secondRec.queueReason,"capacity");
  assert.match(second.content[0].text,/queue/);

  assert.equal(await waitForStatus(firstId,"done"),"done","first worker exits");
  assert.equal(await waitForStatus(secondRec.id,"done"),"done","queued worker automatically starts after capacity frees");

  await sleep(100);
  const pool=await call("worker_pool_status",{host});
  const poolState=JSON.parse(pool.content[0].text);
  assert.equal(poolState.running,0,"pool scales back to zero after ephemeral workers finish");
  assert.equal(poolState.queued,0);

  const failed=await call("worker_spawn",{task:"fail",kind:"exec",commands:[cmd.fail],host});
  const failedId=store.data.workerRecords.at(-1).id;
  void failed;
  assert.equal(await waitForStatus(failedId,"failed"),"failed","failed worker terminates cleanly");
  const replacement=await call("worker_spawn",{task:"replacement",kind:"exec",commands:[cmd.replacement],host});
  void replacement;
  const replacementId=store.data.workerRecords.at(-1).id;
  assert.equal(await waitForStatus(replacementId,"done"),"done","failed worker does not block replacement");

  const oldReserve=cfg.workers.hosts[host].minFreeMemoryMB;
  cfg.workers.hosts[host].minFreeMemoryMB=Math.ceil(os.freemem()/1024/1024)+1024;
  await assert.rejects(
    ()=>call("worker_spawn",{task:"pressure",kind:"exec",commands:[cmd.no],host,queue_if_busy:false}),
    /pool busy \(memory\)/,
    "memory pressure blocks scale-up"
  );
  cfg.workers.hosts[host].minFreeMemoryMB=oldReserve;

  await assert.rejects(
    ()=>call("worker_spawn",{task:"wrong-host",kind:"exec",commands:[cmd.no],host:otherHost}),
    /해당 host proxy/,
    "local pool refuses a task for the other host when proxy routing is bypassed"
  );

  if(host==="nas"){
    const prior=process.env.WEBJJONKU_WINDOWS_TOOL_PROXY;
    process.env.WEBJJONKU_WINDOWS_TOOL_PROXY="1";
    assert.equal(shouldProxyWindowsTool("worker_spawn",{host:"windows"}),true,"NAS registrar routes Windows worker spawn to Windows proxy");
    assert.equal(shouldProxyWindowsTool("worker_status",{id:"ww123456"}),true,"Windows worker ids route back to Windows proxy");
    assert.equal(shouldProxyWindowsTool("worker_spawn",{host:"nas"}),false,"NAS worker tasks remain local");
    if(prior===undefined)delete process.env.WEBJJONKU_WINDOWS_TOOL_PROXY;else process.env.WEBJJONKU_WINDOWS_TOOL_PROXY=prior;
  }else{
    assert.equal(shouldProxyWindowsTool("worker_spawn",{host:"windows"}),false,"Windows runtime executes Windows workers locally");
  }

  console.log(JSON.stringify({
    ok:true,
    checks:["scale_zero_to_one","max_queue","queue_drain","scale_to_zero","failed_worker_replacement","pressure_gate","wrong_host_guard","windows_proxy_routing"],
    host, policy:cfg.workers.hosts[host]
  }));
}finally{
  try{fs.rmSync(temp,{recursive:true,force:true});}catch{}
}
