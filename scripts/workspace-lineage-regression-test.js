#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {spawnSync} from "node:child_process";

const temp=fs.mkdtempSync(path.join(os.tmpdir(),"wjk-workspace-lineage-"));
const repo=path.join(temp,"repo"),stateDir=path.join(temp,"state");
fs.mkdirSync(repo,{recursive:true});fs.mkdirSync(stateDir,{recursive:true});
const git=(args,cwd=repo)=>{
  const r=spawnSync("git",args,{cwd,encoding:"utf8",windowsHide:true});
  if(r.status!==0)throw new Error(String(r.stderr||r.stdout));
  return String(r.stdout||"").trim();
};
git(["init"]);
git(["config","user.email","workspace-test@example.invalid"]);
git(["config","user.name","Workspace Regression"]);
fs.writeFileSync(path.join(repo,"base.txt"),"base\n");
git(["add","base.txt"]);git(["commit","-m","baseline"]);
fs.writeFileSync(path.join(repo,"unrelated-dirty.txt"),"must survive\n");

const cfg={
  roots:[repo,stateDir],stateDir,runtimeProfile:process.platform==="win32"?"windows":"nas",
  readOnly:false,effortDefault:"medium",permissions:{default:"allow",actions:{}},
  workspaces:{maxCopyFiles:1000,maxCopyBytes:16*1024*1024}
};
const makeStore=(data=null)=>({
  data:data||{notes:[],goals:{},goal:null,goalHistory:[],sessions:[],effort:"medium",sessionStates:{},tasks:{},projects:{},workerRecords:[],resourceLocks:{}},
  save(){}
});
const journal={tail(){return[];}};
const {registerGoalTools}=await import("../src/tools/goal.js");
const {registerWorkSyncTools}=await import("../src/tools/work-sync.js");
const {currentWorkspace,ensureWorkspace,makeWorkspaceAwareConfig,workspaceSummary}=await import("../src/workspaces.js");

const build=(store,sessionId)=>{
  const ctx={cfg,baseCfg:cfg,store,journal,sessionRef:{id:sessionId,scoped:true}};
  ctx.cfg=makeWorkspaceAwareConfig(cfg,ctx);
  const tools=new Map(),reg=(name,meta,fn)=>tools.set(name,fn);
  registerGoalTools(reg,ctx);registerWorkSyncTools(reg,ctx);
  return {ctx,call:async(name,args={})=>{const fn=tools.get(name);assert.ok(fn,"missing "+name);return fn(args);}};
};

try{
  const store=makeStore();
  const s1=build(store,"chat-A");

  await s1.call("goal_set",{title:"Goal A",steps:["a"]});
  const goalA=store.data.sessionStates["chat-A"].goal;
  const wsA=currentWorkspace(s1.ctx);
  assert.ok(goalA?.workspaceId&&wsA?.id===goalA.workspaceId);
  assert.notEqual(wsA.id,"ws-root");
  assert.ok(fs.existsSync(wsA.root));
  assert.equal(wsA.kind,"git");
  fs.writeFileSync(path.join(wsA.root,"goal-a-only.txt"),"A\n");

  await s1.call("goal_set",{title:"Goal B",steps:["b"]});
  const goalB=store.data.sessionStates["chat-A"].goal;
  const wsB=currentWorkspace(s1.ctx);
  assert.ok(goalB?.workspaceId&&wsB?.id===goalB.workspaceId);
  assert.notEqual(wsA.id,wsB.id,"new goal gets a distinct workspace");
  assert.notEqual(path.resolve(wsA.root),path.resolve(wsB.root));
  assert.equal(fs.existsSync(path.join(wsB.root,"goal-a-only.txt")),false,"new goal does not inherit dirty files from Goal A");

  const s2=build(store,"chat-B");
  assert.equal(currentWorkspace(s2.ctx),null,"fresh chat does not implicitly inherit another goal");
  const resumed=await s2.call("work_resume",{goal_id:goalA.id});
  const resumedJson=JSON.parse(resumed.content[0].text);
  assert.equal(resumedJson.goal.id,goalA.id);
  assert.equal(resumedJson.workspace.id,wsA.id,"explicit resume reuses Goal A workspace");
  assert.equal(currentWorkspace(s2.ctx).id,wsA.id);
  assert.equal(fs.readFileSync(path.join(wsA.root,"goal-a-only.txt"),"utf8"),"A\n");

  const s3=build(store,"worker-replacement-session");
  await s3.call("work_resume",{workspace_id:wsA.id});
  assert.equal(currentWorkspace(s3.ctx).id,wsA.id,"replacement session/worker can bind same workspace");

  const persisted=structuredClone(store.data);
  persisted.workspaces={};persisted.workspaceRecords={};
  const reloaded=makeStore(persisted);
  const s4=build(reloaded,"chat-reloaded");
  const resumedAfterReload=await s4.call("work_resume",{goal_id:goalA.id});
  const reloadJson=JSON.parse(resumedAfterReload.content[0].text);
  assert.equal(reloadJson.workspace.id,wsA.id,"catalog metadata survives process/store reload");
  assert.equal(currentWorkspace(s4.ctx).id,wsA.id);

  assert.equal(fs.readFileSync(path.join(repo,"unrelated-dirty.txt"),"utf8"),"must survive\n","canonical unrelated dirty file preserved");
  assert.match(git(["status","--short"]),/\?\? unrelated-dirty\.txt/,"canonical dirty state remains untouched");

  const legacy=build(store,"legacy-resume");
  store.data.goals.legacy={id:"legacy",title:"Legacy goal",steps:[{text:"finish",done:false}]};
  await legacy.call("work_resume",{goal_id:"legacy"});
  assert.equal(currentWorkspace(legacy.ctx).id,"ws-root","legacy goal keeps canonical compatibility path");
  assert.equal(currentWorkspace(legacy.ctx).root,path.resolve(repo));
  const fresh=build(store,"fresh-summary");
  assert.equal(workspaceSummary(fresh.ctx).kind,"unbound");

  const makeHost=host=>{
    const hostCfg={...cfg,stateDir:path.join(temp,host),runtimeProfile:host};
    hostCfg.roots=[repo,hostCfg.stateDir];
    return {cfg:hostCfg,baseCfg:hostCfg,store:makeStore(),sessionRef:{id:host,scoped:true}};
  };
  const nasCtx=makeHost("nas"),winCtx=makeHost("windows");
  const nasWs=await ensureWorkspace(nasCtx,{lineageId:"cross-host",goalId:"cross-goal"});
  const winWs=await ensureWorkspace(winCtx,{lineageId:nasWs.lineageId,goalId:nasWs.goalId});
  assert.notEqual(nasWs.id,winWs.id,"physical workspace IDs are host-local");
  assert.notEqual(nasWs.root,winWs.root);
  assert.equal(nasWs.lineageId,winWs.lineageId);
  fs.writeFileSync(path.join(winWs.root,"windows-dirty.txt"),"preserved");
  assert.equal((await ensureWorkspace(winCtx,{lineageId:"cross-host",goalId:"cross-goal"})).id,winWs.id,"cross-host replacement reuses local worktree");
  assert.equal(fs.readFileSync(path.join(winWs.root,"windows-dirty.txt"),"utf8"),"preserved");

  console.log(JSON.stringify({
    ok:true,
    checks:["goal_isolation","dirty_noninheritance","fresh_chat_unbound","explicit_goal_resume","replacement_worker_resume","reload_persistence","canonical_dirty_preserved","legacy_root_resume","cross_host_local_worktrees"],
    goalA:{id:goalA.id,workspaceId:wsA.id,branch:wsA.branch},
    goalB:{id:goalB.id,workspaceId:wsB.id,branch:wsB.branch}
  }));
}finally{
  try{git(["worktree","remove","--force",path.join(stateDir,"workspaces","trees")],repo);}catch{}
  try{fs.rmSync(temp,{recursive:true,force:true});}catch{}
}
