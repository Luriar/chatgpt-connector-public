import assert from "node:assert/strict";
import {
  acquireResourceLocks,
  acquireToolResources,
  releaseSessionResources,
  releaseToolResources,
  resourceKeysForTool,
  resourceLockTable
} from "../src/resource-locks.js";
import {
  currentEffort,
  currentGoal,
  setCurrentEffort,
  setCurrentGoal
} from "../src/session-state.js";

function store(){
  return {
    data:{goal:{title:"legacy-global"},goalHistory:[],effort:"max",sessionStates:{},resourceLocks:{}},
    saveCount:0,
    save(){this.saveCount++;}
  };
}
const shared=store();
const cfg={effortDefault:"medium"};
const a={store:shared,cfg,sessionRef:{id:"session-a",scoped:true}};
const b={store:shared,cfg,sessionRef:{id:"session-b",scoped:true}};
const fresh={store:shared,cfg,sessionRef:{id:"session-fresh",scoped:true}};

assert.equal(currentGoal(fresh),null);
assert.equal(currentEffort(fresh),"medium");

setCurrentGoal(a,{title:"A"});
setCurrentGoal(b,{title:"B"});
assert.equal(currentGoal(a).title,"A");
assert.equal(currentGoal(b).title,"B");
assert.notEqual(currentGoal(a),currentGoal(b));

setCurrentEffort(a,"high");
setCurrentEffort(b,"low");
assert.equal(currentEffort(a),"high");
assert.equal(currentEffort(b),"low");

assert.deepEqual(resourceKeysForTool("desktop_click",{}),["windows-desktop"]);
assert.deepEqual(resourceKeysForTool("exec_command",{}),["workspace"]);
assert.deepEqual(resourceKeysForTool("ssh_exec",{remote:"ts253d"}),["remote:ts253d"]);

process.env.WEBJJONKU_RESOURCE_LOCK_WAIT_MS="80";
const savesBeforeAuto=shared.saveCount;
const leaseA=await acquireToolResources(a,"desktop_click",{});
assert.ok(leaseA?.owner?.startsWith("call-"));
assert.equal(resourceLockTable(a)["windows-desktop"].owner,leaseA.owner);
assert.equal(shared.saveCount,savesBeforeAuto);
let busy=false;
try{await acquireToolResources(b,"desktop_click",{});}catch(e){busy=e?.code==="RESOURCE_BUSY"&&/resource busy/.test(String(e.message));}
assert.equal(busy,true);
assert.equal(releaseToolResources(a,leaseA),1);
assert.equal(shared.saveCount,savesBeforeAuto);

const leaseB=await acquireToolResources(b,"desktop_click",{});
assert.ok(leaseB?.owner?.startsWith("call-"));
assert.equal(releaseToolResources(b,leaseB),1);
assert.equal(resourceLockTable(b)["windows-desktop"],undefined);
assert.equal(shared.saveCount,savesBeforeAuto);

const leaseWaitA=await acquireToolResources(a,"exec_command",{});
setTimeout(()=>releaseToolResources(a,leaseWaitA),20);
const waitStarted=Date.now();
const leaseWaitB=await acquireToolResources(b,"exec_command",{});
assert.ok(Date.now()-waitStarted>=10);
assert.equal(releaseToolResources(b,leaseWaitB),1);

const savesBeforeExplicit=shared.saveCount;
acquireResourceLocks(a,["windows-desktop"],{seconds:60,tool:"explicit-test"});
assert.equal(resourceLockTable(a)["windows-desktop"].owner,"session-a");
assert.equal(shared.saveCount,savesBeforeExplicit+1);
assert.equal(releaseSessionResources(a),1);
assert.equal(shared.saveCount,savesBeforeExplicit+2);

console.log("session/resource lock isolation: OK");
