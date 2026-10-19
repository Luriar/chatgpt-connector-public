#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerExecTools } from "../src/tools/exec.js";
import { registerTaskTools } from "../src/tools/tasks.js";

const tmp=fs.mkdtempSync(path.join(os.tmpdir(),"wjk-task-timeout-"));
const store={
  data:{tasks:{},resourceLocks:{}},
  save(){this.saved=structuredClone(this.data);}
};
const cfg={
  roots:[tmp],
  readOnly:false,
  permissions:{default:"allow",actions:{}},
  resilience:{
    checkpointIntervalMs:1000,
    resultMaxBytes:65536,
    taskCommandTimeoutMs:5000,
    taskKillGraceMs:500
  }
};
const ctx={store,cfg,baseCfg:cfg,sessionRef:{id:"task-timeout-regression",scoped:true}};
const handlers={};
registerTaskTools((name,_meta,handler)=>handlers[name]=handler,ctx);
registerExecTools((name,_meta,handler)=>handlers[name]=handler,ctx);

const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const waitFor=async(fn,timeoutMs=12000)=>{
  const deadline=Date.now()+timeoutMs;
  while(Date.now()<deadline){
    const v=fn();
    if(v)return v;
    await sleep(50);
  }
  return null;
};

try{
  const hangSource="const fs=require('node:fs');fs.writeFileSync('parent.pid',String(process.pid));const child=require('node:child_process').spawn(process.execPath,['-e','setInterval(Function(),1000)'],{stdio:'inherit'});fs.writeFileSync('child.pid',String(child.pid));console.log('STARTED');setInterval(Function(),1000)";
  const hangCommand=process.platform==="win32"
    ? `& '${process.execPath}' -e "${hangSource}"`
    : `'${process.execPath}' -e "${hangSource}"`;
  const startedAt=Date.now();
  const created=JSON.parse((await handlers.task_create({
    title:"timeout regression hang",
    steps:[{title:"hang",command:hangCommand}],
    cwd:tmp,
    timeout_ms:5000,
    auto_start:true
  })).content[0].text);
  await waitFor(()=>fs.existsSync(path.join(tmp,'child.pid')),4000);
  assert.ok(fs.existsSync(path.join(tmp,'child.pid')),"real child process did not start");
  const nextCommand=process.platform==="win32"
    ? "Write-Output 'NEXT_OK'"
    : "printf 'NEXT_OK\\n'";
  const next=JSON.parse((await handlers.task_create({title:"queued successor",steps:[{title:"next",command:nextCommand}],cwd:tmp,timeout_ms:5000,auto_start:true})).content[0].text);
  await sleep(100);
  assert.notEqual(store.data.tasks[next.id].status,"succeeded","successor bypassed active workspace lock");
  const failed=await waitFor(()=>store.data.tasks[created.id]?.status==="failed"&&store.data.tasks[created.id],15000);
  assert.ok(failed,"hang task did not terminate after timeout");
  assert.match(String(failed.error||""),/timed out after 5000ms/);
  assert.ok(failed.events.some(e=>e.type==="timed_out"&&e.timeoutMs===5000),"missing timed_out event");
  assert.ok(Date.now()-startedAt<15000,"timeout path took too long");
  assert.equal(failed.steps[0].status,"failed");
  assert.match(String(failed.steps[0].output||""),/STARTED/);
  for(const file of ['parent.pid','child.pid']){
    const pid=Number(fs.readFileSync(path.join(tmp,file),'utf8'));
    assert.ok(pid>0&&pid!==process.pid,"invalid owned fixture PID");
    const dead=await waitFor(()=>{
      try{process.kill(pid,0);}catch(e){if(e.code==='ESRCH')return true;throw e;}
      if(process.platform!=='win32')try{return fs.readFileSync('/proc/'+pid+'/stat','utf8').split(') ')[1]?.startsWith('Z ');}catch(e){if(e.code==='ENOENT')return true;throw e;}
      return false;
    },3000);
    assert.ok(dead,`timed-out ${file} process remained alive`);
  }
  const succeeded=await waitFor(()=>store.data.tasks[next.id]?.status==="succeeded"&&store.data.tasks[next.id],8000);
  assert.ok(succeeded,"successor task stayed blocked after timed-out task");
  assert.match(String(succeeded.steps[0].output||""),/NEXT_OK/);

  const lockRows=Object.values(store.data.resourceLocks||{}).filter(Boolean);
  assert.equal(lockRows.length,0,"workspace lock leaked after timeout");

  const response=await handlers.exec_command({command:hangCommand,cwd:tmp,shell:process.platform==='win32'?'powershell':'bash',durable:true,timeout_ms:5000});
  const text=response.content[0].text;
  const durableId=text.match(/task_(?:win_)?[a-f0-9]+/)?.[0];
  assert.ok(durableId,"durable foreground call did not return task ID");
  assert.equal(store.data.tasks[durableId].timeoutMs,5000,"exec timeout was lost during durable conversion");
  const durableFailed=await waitFor(()=>store.data.tasks[durableId]?.status==='failed'&&store.data.tasks[durableId],12000);
  assert.ok(durableFailed,"durable command outlived requested deadline after foreground returned");
  assert.match(durableFailed.error,/timed out after 5000ms/);
  assert.equal(durableId.startsWith('task_win_'),process.platform==='win32',"durable ID lost host identity");

  console.log(JSON.stringify({
    ok:true,
    platform:process.platform,
    checks:["hang_timeout","parent_and_descendant_exit","workspace_lock_release","queued_successor_runs","durable_exec_deadline_after_return","host_qualified_durable_id"],
    timeoutMs:5000
  }));
}finally{
  try{fs.rmSync(tmp,{recursive:true,force:true});}catch{}
}
process.exit(0);
