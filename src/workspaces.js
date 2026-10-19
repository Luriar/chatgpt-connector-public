import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { resolveInRoots, assertMutationAllowed } from "./security.js";
import { currentGoal, getSessionState } from "./session-state.js";

const ID=/^[A-Za-z0-9._:-]{1,160}$/;
const iso=()=>new Date().toISOString();
const digest=s=>crypto.createHash("sha256").update(String(s)).digest("hex").slice(0,24);

function baseCfg(ctx){return ctx.baseCfg||ctx.cfg;}
export function workspaceHostId(ctx=null){
  const cfg=ctx?baseCfg(ctx):null;
  return process.env.WEBJJONKU_HOST_ID||cfg?.runtimeProfile||process.env.WEBJJONKU_RUNTIME_PROFILE||os.hostname();
}
function validId(id,label){
  id=String(id||"");
  if(!ID.test(id)||["__proto__","constructor","prototype"].includes(id))throw new Error("invalid "+label);
  return id;
}
function catalog(ctx){return path.join(baseCfg(ctx).stateDir,"workspaces","catalog");}
function table(ctx){
  const d=ctx.store.data;
  if(!d.workspaces||typeof d.workspaces!=="object"||Array.isArray(d.workspaces))d.workspaces={};
  if(d.workspaceRecords&&typeof d.workspaceRecords==="object"&&!Array.isArray(d.workspaceRecords)){
    for(const [k,v] of Object.entries(d.workspaceRecords))if(v&&!d.workspaces[k])d.workspaces[k]=v;
  }
  d.workspaceRecords=d.workspaces;
  return d.workspaces;
}
function recordFile(ctx,id){return path.join(catalog(ctx),validId(id,"workspace id")+".json");}
function git(root,args,{optional=false}={}){
  const r=spawnSync("git",["-C",root,...args],{encoding:"utf8",timeout:30_000,windowsHide:true,maxBuffer:1024*1024});
  if(r.error||r.status!==0){
    if(optional)return null;
    throw new Error("workspace git operation failed: "+String(r.error?.message||r.stderr||r.stdout).slice(0,1200));
  }
  return String(r.stdout||"").trim();
}
function legacyRootRecord(ctx,{save=true}={}){
  const cfg=baseCfg(ctx),root=path.resolve(cfg.roots[0]),all=table(ctx),existing=all["ws-root"],now=iso();
  const top=git(root,["rev-parse","--show-toplevel"],{optional:true});
  const rec={
    id:"ws-root",workspaceId:"ws-root",lineageId:existing?.lineageId||"legacy-root",
    goalId:existing?.goalId||null,projectId:existing?.projectId||null,
    repoRoot:top?path.resolve(top):root,root,hostId:workspaceHostId(ctx),
    hostAccessibility:{[workspaceHostId(ctx)]:root},kind:top?"root-git":"root",
    baseCommit:top?git(root,["rev-parse","HEAD"],{optional:true}):null,
    branch:top?git(root,["symbolic-ref","--short","HEAD"],{optional:true}):null,
    createdAt:existing?.createdAt||now,lastUsedAt:now,status:"ready",
    cleanupPolicy:"canonical/legacy workspace; never auto-delete"
  };
  all[rec.id]=rec;
  if(save){ctx.store.save();}
  return rec;
}
function readRecord(ctx,id){
  id=validId(id,"workspace id");
  if(id==="ws-root")return legacyRootRecord(ctx,{save:false});
  const f=recordFile(ctx,id);
  if(!fs.existsSync(f))return table(ctx)[id]||null;
  const rec=JSON.parse(fs.readFileSync(f,"utf8"));
  if(rec.id!==id)throw new Error("workspace metadata identity mismatch");
  table(ctx)[id]=rec;
  return rec;
}
function saveRecord(ctx,rec){
  if(rec.id==="ws-root"){
    table(ctx)[rec.id]=rec;
    ctx.store.save();
    return rec;
  }
  fs.mkdirSync(catalog(ctx),{recursive:true});
  const file=recordFile(ctx,rec.id),tmp=file+"."+crypto.randomBytes(4).toString("hex")+".tmp";
  const fd=fs.openSync(tmp,"wx",0o600);
  try{
    fs.writeFileSync(fd,JSON.stringify(rec,null,2));
    fs.fsyncSync(fd);
  }finally{fs.closeSync(fd);}
  fs.renameSync(tmp,file);
  table(ctx)[rec.id]=rec;
  ctx.store.save();
  return rec;
}

export function inspectWorkspace(ctx,id){
  id=validId(id,"workspace id");
  const rec=id==="ws-root"?legacyRootRecord(ctx,{save:false}):readRecord(ctx,id);
  if(!rec)throw new Error("workspace not found: "+id);
  const cfg=baseCfg(ctx);
  resolveInRoots(cfg,rec.root);
  if(!fs.existsSync(rec.root))throw new Error("workspace missing; restore its existing directory before resume: "+rec.root);
  if(rec.status!=="ready")throw new Error("workspace requires inspection before resume: "+rec.id+" ("+rec.status+")");
  if(rec.hostId!==workspaceHostId(ctx))throw new Error("workspace belongs to host "+rec.hostId+"; resume on that host or provide an explicit local project mapping");
  if(rec.kind==="git"){
    const top=git(rec.root,["rev-parse","--show-toplevel"],{optional:true});
    const branch=git(rec.root,["symbolic-ref","--short","HEAD"],{optional:true});
    if(!top||path.resolve(top)!==path.resolve(rec.root)||branch!==rec.branch){
      throw new Error("workspace worktree missing/corrupted or branch changed; inspect without recreating: "+rec.id);
    }
  }
  return rec;
}
export function listWorkspaces(ctx){
  if(fs.existsSync(catalog(ctx))){
    for(const name of fs.readdirSync(catalog(ctx))){
      if(/^ws_[a-f0-9]{24}\.json$/.test(name))readRecord(ctx,name.slice(0,-5));
    }
  }
  const rows=Object.values(table(ctx)).map(r=>({...r}));
  if(!rows.some(r=>r.id==="ws-root"))rows.unshift(legacyRootRecord(ctx,{save:false}));
  return rows;
}
export function currentWorkspace(ctx){
  const state=getSessionState(ctx,false),goal=currentGoal(ctx);
  const id=goal?.workspaceId||state?.workspaceId||(!ctx.sessionRef?.scoped?ctx.store.data.workspaceId:null);
  if(!id)return null;
  return readRecord(ctx,id);
}
export function bindWorkspace(ctx,id){
  const rec=inspectWorkspace(ctx,id),state=getSessionState(ctx,true);
  if(state){
    state.workspaceId=rec.id;
    state.lineageId=rec.lineageId||null;
    state.updatedAt=iso();
  }else{
    ctx.store.data.workspaceId=rec.id;
  }
  rec.lastUsedAt=iso();
  saveRecord(ctx,rec);
  return rec;
}
export function clearWorkspaceBinding(ctx){
  const state=getSessionState(ctx,false);
  if(state){
    state.workspaceId=null;
    state.lineageId=null;
    state.updatedAt=iso();
  }else{
    ctx.store.data.workspaceId=null;
  }
  ctx.store.save();
}
export function ensureWorkspaceById(ctx,id){return bindWorkspace(ctx,id);}
export function workspaceMetadata(rec){
  return rec?{
    workspaceId:rec.id,lineageId:rec.lineageId,goalId:rec.goalId,projectId:rec.projectId,
    cwd:rec.root,hostId:rec.hostId,kind:rec.kind,branch:rec.branch,baseCommit:rec.baseCommit,status:rec.status
  }:{};
}

function copyInputs(source,dest,cfg){
  let files=0,bytes=0;
  const maxFiles=Number(cfg.workspaces?.maxCopyFiles)||10_000;
  const maxBytes=Number(cfg.workspaces?.maxCopyBytes)||256*1024*1024;
  const skip=new Set([".git",".webjjonku",".webjjonku-workspaces","node_modules",".tmp","work",".ssh",".aws",".codex",".env","webjjonku.config.json"]);
  function walk(from,to){
    fs.mkdirSync(to,{recursive:true});
    for(const e of fs.readdirSync(from,{withFileTypes:true})){
      if(skip.has(e.name)||e.name.startsWith(".env.")||/\.(?:key|pem|pfx|p12)$/i.test(e.name)||e.isSymbolicLink())continue;
      const src=path.join(from,e.name),dst=path.join(to,e.name);
      if(e.isDirectory())walk(src,dst);
      else if(e.isFile()){
        const n=fs.statSync(src).size;
        if(++files>maxFiles||(bytes+=n)>maxBytes)throw new Error("non-Git workspace copy exceeds configured bounds; choose a narrower project root");
        fs.copyFileSync(src,dst,fs.constants.COPYFILE_EXCL);
      }
    }
  }
  walk(source,dest);
  return {files,bytes,excluded:"runtime/config/secrets, dependency directories and symbolic links"};
}

export async function ensureWorkspace(ctx,{goalId=null,lineageId=null,projectId=null,root=null,workspaceId=null,legacyRoot=false}={}){
  if(workspaceId)return bindWorkspace(ctx,workspaceId);
  if(goalId)validId(goalId,"goal id");
  if(projectId)validId(projectId,"project id");
  lineageId=validId(lineageId||goalId||("lineage_"+crypto.randomUUID()),"lineage id");

  if(legacyRoot){
    const rec=legacyRootRecord(ctx);
    rec.goalId=goalId||rec.goalId;
    rec.lineageId=lineageId||rec.lineageId;
    saveRecord(ctx,rec);
    return bindWorkspace(ctx,rec.id);
  }

  const cfg=baseCfg(ctx);
  const source=resolveInRoots(cfg,root||cfg.roots[0]);
  const prior=listWorkspaces(ctx).find(w=>w.root&&path.resolve(w.root)===path.resolve(source));
  const canonicalRoot=prior?.repoRoot||source;
  const gitRoot=git(canonicalRoot,["rev-parse","--show-toplevel"],{optional:true});
  const repoRoot=resolveInRoots(cfg,gitRoot||canonicalRoot);
  const id="ws_"+digest(repoRoot+"|"+workspaceHostId(ctx)+"|"+lineageId);

  fs.mkdirSync(catalog(ctx),{recursive:true});
  const lock=recordFile(ctx,id)+".lock",deadline=Date.now()+35_000;
  let fd;
  while(fd===undefined){
    try{
      fd=fs.openSync(lock,"wx",0o600);
      fs.writeFileSync(fd,String(process.pid));
    }catch(e){
      if(e.code!=="EEXIST")throw e;
      let owner=0;
      try{owner=Number(fs.readFileSync(lock,"utf8"));}catch{}
      if(owner>0){
        try{process.kill(owner,0);}
        catch(err){
          if(err.code==="ESRCH"){
            try{fs.unlinkSync(lock);}catch{}
            continue;
          }
        }
      }
      if(Date.now()>=deadline)throw new Error("workspace creation busy; inspect existing creation before retry: "+id);
      await new Promise(r=>setTimeout(r,100));
    }
  }

  try{
    const existing=readRecord(ctx,id);
    if(existing)return bindWorkspace(ctx,id);
    assertMutationAllowed(cfg,"isolated workspace creation");
    const dest=resolveInRoots(cfg,path.join(cfg.stateDir,"workspaces","trees",id),{forWrite:true});
    if(fs.existsSync(dest))throw new Error("workspace directory already exists without metadata; preserve and inspect: "+dest);

    const rec={
      id,workspaceId:id,lineageId,goalId,projectId,repoRoot,root:dest,
      hostId:workspaceHostId(ctx),hostAccessibility:{[workspaceHostId(ctx)]:dest},
      kind:gitRoot?"git":"directory",baseCommit:null,branch:null,
      createdAt:iso(),lastUsedAt:iso(),status:"creating",
      cleanupPolicy:"manual-only; never delete active, dirty or unmerged work"
    };
    if(gitRoot){
      rec.baseCommit=git(repoRoot,["rev-parse","HEAD"]);
      rec.branch="goals/"+id;
    }
    saveRecord(ctx,rec);
    try{
      fs.mkdirSync(path.dirname(dest),{recursive:true});
      if(gitRoot)git(repoRoot,["worktree","add","-b",rec.branch,dest,rec.baseCommit]);
      else rec.copy=copyInputs(repoRoot,dest,cfg);
      rec.status="ready";
      saveRecord(ctx,rec);
      return bindWorkspace(ctx,id);
    }catch(e){
      rec.status="needs_inspection";
      rec.error=String(e.message).slice(0,1200);
      saveRecord(ctx,rec);
      throw e;
    }
  }finally{
    try{fs.closeSync(fd);}catch{}
    try{fs.unlinkSync(lock);}catch{}
  }
}

// Compatibility for goals created before isolated workspaces existed.
// New goal_set calls ensureWorkspace directly and therefore always isolates;
// legacy goals without workspace metadata stay on the canonical dirty tree.
export async function bindGoalWorkspace(ctx,goal){
  if(!goal)return currentWorkspace(ctx)||legacyRootRecord(ctx,{save:false});
  if(goal.workspaceId){
    const rec=bindWorkspace(ctx,goal.workspaceId);
    goal.lineageId=goal.lineageId||rec.lineageId||goal.id;
    return rec;
  }
  const rec=await ensureWorkspace(ctx,{goalId:goal.id,lineageId:goal.lineageId||goal.id,projectId:goal.projectId,legacyRoot:true});
  goal.workspaceId=rec.id;
  goal.lineageId=goal.lineageId||goal.id;
  ctx.store.save();
  return rec;
}

export function workspaceLockKey(ctx){
  try{
    const ws=currentWorkspace(ctx);
    return "workspace:"+String(ws?.id||"root").replace(/[^A-Za-z0-9._:-]/g,"_").slice(0,120);
  }catch{
    return "workspace:root";
  }
}
export function makeWorkspaceAwareConfig(base,ctx){
  const cfg={...base};
  Object.defineProperty(cfg,"roots",{
    enumerable:true,configurable:false,
    get(){
      const ws=currentWorkspace(ctx);
      if(!ws?.root)return base.roots;
      const rest=base.roots.slice(1).filter(r=>path.resolve(r)!==path.resolve(ws.root));
      return [ws.root,...rest];
    }
  });
  return cfg;
}
export function workspaceSummary(ctx){
  const ws=currentWorkspace(ctx);
  return ws?workspaceMetadata(ws):{workspaceId:null,lineageId:null,cwd:baseCfg(ctx).roots[0],hostId:workspaceHostId(ctx),kind:"unbound"};
}
