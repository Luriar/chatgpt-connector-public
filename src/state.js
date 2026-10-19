// 영속 상태(goal/effort/세션/워커 기록/코덱스 큐) + 저널(모든 도구 호출 로그)
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
const DURABLE_FSYNC=process.env.WEBJJONKU_DURABLE_FSYNC!==undefined?process.env.WEBJJONKU_DURABLE_FSYNC!=="0":process.env.WEBJJONKU_RUNTIME_PROFILE!=="nas";
import { redact } from "./security.js";

const clone=(v)=>v===undefined?undefined:structuredClone(v);
const eq=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const plain=(v)=>!!v&&typeof v==="object"&&!Array.isArray(v)&&Object.getPrototypeOf(v)===Object.prototype;
const idArray=(v)=>Array.isArray(v)&&v.every(x=>plain(x)&&typeof x.id==="string")&&new Set(v.map(x=>x.id)).size===v.length;
const prefixArray=(base,local)=>Array.isArray(base)&&Array.isArray(local)&&base.length<=local.length&&base.every((x,i)=>eq(x,local[i]));
const FORBIDDEN_KEYS=new Set(["__proto__","prototype","constructor"]);
function validateStateShape(v,pathParts=["state"],depth=0){
  if(depth>100)throw new Error("state nesting too deep");
  if(Array.isArray(v)){for(let i=0;i<v.length;i++)validateStateShape(v[i],[...pathParts,String(i)],depth+1);return;}
  if(!v||typeof v!=="object")return;
  for(const [k,val] of Object.entries(v)){
    if(FORBIDDEN_KEYS.has(k))throw new Error("forbidden state key: "+[...pathParts,k].join("."));
    validateStateShape(val,[...pathParts,k],depth+1);
  }
}
function reconcileInPlace(target,source){
  if(Array.isArray(target)&&Array.isArray(source)){
    if(idArray(source)&&target.every(x=>plain(x)&&typeof x.id==="string")){
      const byId=new Map(target.map(x=>[x.id,x])),next=[];
      for(const sv of source){
        const tv=byId.get(sv.id);
        if(plain(tv)&&plain(sv)){reconcileInPlace(tv,sv);next.push(tv);}
        else next.push(clone(sv));
      }
      target.splice(0,target.length,...next);return target;
    }
    for(let i=0;i<source.length;i++){
      const sv=source[i],tv=target[i];
      if(plain(tv)&&plain(sv))reconcileInPlace(tv,sv);
      else if(Array.isArray(tv)&&Array.isArray(sv))reconcileInPlace(tv,sv);
      else if(!eq(tv,sv))target[i]=clone(sv);
    }
    target.length=source.length;return target;
  }
  if(plain(target)&&plain(source)){
    for(const k of Object.keys(target))if(!Object.prototype.hasOwnProperty.call(source,k))delete target[k];
    for(const [k,sv] of Object.entries(source)){
      if(FORBIDDEN_KEYS.has(k))throw new Error("forbidden state key: "+k);
      const tv=target[k];
      if(plain(tv)&&plain(sv))reconcileInPlace(tv,sv);
      else if(Array.isArray(tv)&&Array.isArray(sv))reconcileInPlace(tv,sv);
      else if(!eq(tv,sv))target[k]=clone(sv);
    }
    return target;
  }
  return source;
}

function diff(base,local,path=[],ops=[]){
  if(eq(base,local))return ops;
  if(plain(base)&&plain(local)){
    const keys=new Set([...Object.keys(base),...Object.keys(local)]);
    for(const k of keys){
      if(!Object.prototype.hasOwnProperty.call(local,k)){ops.push({type:"delete",path:[...path,k]});continue;}
      if(!Object.prototype.hasOwnProperty.call(base,k)){ops.push({type:"set",path:[...path,k],value:clone(local[k])});continue;}
      diff(base[k],local[k],[...path,k],ops);
    }
    return ops;
  }
  if(idArray(base)&&idArray(local)){
    const b=new Map(base.map(x=>[x.id,x])),l=new Map(local.map(x=>[x.id,x]));
    for(const id of new Set([...b.keys(),...l.keys()])){
      if(!l.has(id)){ops.push({type:"arrayDeleteId",path:[...path],id});continue;}
      if(!b.has(id)||!eq(b.get(id),l.get(id)))ops.push({type:"arraySetId",path:[...path],id,value:clone(l.get(id))});
    }
    return ops;
  }
  if(Array.isArray(base)&&Array.isArray(local)&&prefixArray(base,local)){
    const items=local.slice(base.length);if(items.length)ops.push({type:"append",path:[...path],items:clone(items)});
    return ops;
  }
  ops.push({type:"set",path:[...path],value:clone(local)});
  return ops;
}
function parentAt(root,pathParts){
  let cur=root;
  for(const k of pathParts){if(!plain(cur[k])&&!Array.isArray(cur[k]))cur[k]={};cur=cur[k];}
  return cur;
}
function applyOps(remote,ops){
  let out=clone(remote);
  for(const op of ops){
    if(op.path.length===0){
      if(op.type==="set")out=clone(op.value);
      else if(op.type==="append"&&Array.isArray(out))out.push(...clone(op.items));
      continue;
    }
    const p=parentAt(out,op.path.slice(0,-1)),key=op.path.at(-1);
    if(op.type==="set")p[key]=clone(op.value);
    else if(op.type==="delete")delete p[key];
    else if(op.type==="append"){
      if(!Array.isArray(p[key]))p[key]=[];
      const seen=new Set(p[key].map(x=>JSON.stringify(x)));for(const item of op.items){const sig=JSON.stringify(item);if(!seen.has(sig)){p[key].push(clone(item));seen.add(sig);}}
    }else if(op.type==="arraySetId"){
      if(!Array.isArray(p[key]))p[key]=[];
      const i=p[key].findIndex(x=>x?.id===op.id);if(i>=0)p[key][i]=clone(op.value);else p[key].push(clone(op.value));
    }else if(op.type==="arrayDeleteId"){
      if(Array.isArray(p[key]))p[key]=p[key].filter(x=>x?.id!==op.id);
    }
  }
  return out;
}
function sleepSync(ms){try{Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,ms);}catch{}}
function parseStateFile(file){
  const v=JSON.parse(fs.readFileSync(file,"utf8"));
  validateStateShape(v);
  return v;
}
function fsyncParentDir(file){
  let fd;
  try{fd=fs.openSync(path.dirname(file),"r");if(DURABLE_FSYNC)fs.fsyncSync(fd);}
  catch{}
  finally{if(fd!==undefined)try{fs.closeSync(fd);}catch{}}
}
function atomicWriteFile(file,body,mode=0o600){
  const dir=path.dirname(file);
  fs.mkdirSync(dir,{recursive:true});
  const tmp=file+".tmp-"+process.pid+"-"+crypto.randomBytes(4).toString("hex");
  let fd;
  try{
    fd=fs.openSync(tmp,"wx",mode);
    fs.writeFileSync(fd,body,{encoding:"utf8"});
    if(DURABLE_FSYNC)fs.fsyncSync(fd);
    fs.closeSync(fd);fd=undefined;
    fs.renameSync(tmp,file);
    fsyncParentDir(file);
  }catch(e){
    if(fd!==undefined)try{fs.closeSync(fd);}catch{}
    try{fs.rmSync(tmp,{force:true});}catch{}
    throw e;
  }
}
function acquireLock(file,timeoutMs=5000){
  const start=Date.now();
  while(true){
    try{
      const fd=fs.openSync(file,"wx",0o600);fs.writeFileSync(fd,JSON.stringify({pid:process.pid,at:new Date().toISOString()}));return fd;
    }catch(e){
      if(e?.code!=="EEXIST")throw e;
      try{const st=fs.statSync(file);if(Date.now()-st.mtimeMs>30000){fs.rmSync(file,{force:true});continue;}}catch{}
      if(Date.now()-start>timeoutMs)throw new Error("state lock timeout");
      sleepSync(20);
    }
  }
}
function releaseLock(file,fd){try{fs.closeSync(fd);}catch{}try{fs.rmSync(file,{force:true});}catch{}}

export class Store {
  constructor(cfg) {
    this.cfg = cfg;
    this.file = path.join(cfg.stateDir, "state.json");
    this.lockFile=this.file+".lock";
    this.data = {
      goal: null,
      goalHistory: [],
      goals: {},
      effort: cfg.effortDefault,
      sessions: [],
      workerRecords: [],
      codexQueue: [],
      dbConnections: {},
      remotes: {},
      schedules: [],
      approvals: [],
      policyOverrides: {},
      saasConnections: {},
      oauthProviders: {},
      oauthPending: {},
      tasks: {},
      coordinator: null,
      projects: {},
      artifacts: {},
      activeProjectId: null,
      workSync: { profileId: null, cloudVersion: null, lastSyncAt: null, lastPullAt: null, conflicts: [] },
      syncedTaskShadows: {},
      browserBrokers: {},
      sites: {},
      workItems: {},
      sessionStates: {},
      resourceLocks: {},
      workspaceRecords: {},
      workspaceFeatureVersion: null,
      notes: []
    };
    this.defaults=clone(this.data);
    this.baseline=clone(this.data);
    this.load();
  }
  #readFileOrBackup(){
    const candidates=[this.file,this.file+".bak",this.file+".bak2"];
    let firstError=null,sawAny=false;
    for(const candidate of candidates){
      if(!fs.existsSync(candidate))continue;
      sawAny=true;
      try{
        const v=parseStateFile(candidate);
        if(candidate!==this.file){
          this.recoveredFromBackup=true;
          this.recoveredFromPath=candidate;
          this.loadError=String(firstError?.message||firstError||"primary state unavailable");
        }
        return v;
      }catch(e){
        if(!firstError)firstError=e;
      }
    }
    if(!sawAny)return null;
    throw new Error("state.json 손상/검증 실패 및 유효한 backup 없음: "+String(firstError?.message||firstError));
  }
  load() {
    const parsed=this.#readFileOrBackup();
    if(parsed)this.data={...clone(this.defaults),...parsed};
    this.baseline=clone(this.data);
  }
  reload() {
    const parsed=this.#readFileOrBackup();if(!parsed)return false;
    const next={...clone(this.defaults),...parsed};reconcileInPlace(this.data,next);this.baseline=clone(next);return true;
  }
  save() {
    fs.mkdirSync(path.dirname(this.lockFile),{recursive:true});
    const ops=diff(this.baseline,this.data);
    if(!ops.length&&fs.existsSync(this.file)&&!this.recoveredFromBackup)return;
    const fd=acquireLock(this.lockFile);
    try{
      const latest=this.#readFileOrBackup();
      const baseLatest=latest?{...clone(this.defaults),...latest}:clone(this.defaults);
      const merged=applyOps(baseLatest,ops);
      validateStateShape(merged);
      const backup=this.file+".bak",backup2=this.file+".bak2",body=JSON.stringify(merged);
      fs.mkdirSync(path.dirname(this.file),{recursive:true});
      if(latest){
        if(fs.existsSync(backup)){
          try{
            const priorBackup=parseStateFile(backup);
            atomicWriteFile(backup2,JSON.stringify(priorBackup));
          }catch{}
        }
        atomicWriteFile(backup,JSON.stringify(baseLatest));
      }
      atomicWriteFile(this.file,body);
      reconcileInPlace(this.data,merged);this.baseline=clone(merged);
    } finally {releaseLock(this.lockFile,fd);}
  }
}

export class Journal {
  constructor(cfg) {
    this.cfg = cfg;
    this.file = path.join(cfg.stateDir, "journal.jsonl");
    this.maxBytes = 8 * 1024 * 1024;
  }
  log(entry) {
    try {
      const line = JSON.stringify({ ts: new Date().toISOString(), ...entry, args: this.#slim(entry.args) });
      const safe = redact(this.cfg, line);
      if (fs.existsSync(this.file) && fs.statSync(this.file).size > this.maxBytes) {
        fs.renameSync(this.file, this.file + ".1");
      }
      fs.appendFileSync(this.file, safe + "\n");
    } catch {}
  }
  #slim(args) {
    if (!args) return args;
    const out = {};
    for (const [k, v] of Object.entries(args)) {
      out[k] = typeof v === "string" && v.length > 400 ? v.slice(0, 400) + `…(${v.length})` : v;
    }
    return out;
  }
  tail(lines = 100, grep) {
    if (!fs.existsSync(this.file)) return [];
    const content = fs.readFileSync(this.file, "utf8").trimEnd().split("\n");
    let rows = content.slice(-Math.min(lines, 2000));
    if (grep) {
      const re = new RegExp(grep, "i");
      rows = rows.filter((r) => re.test(r));
    }
    return rows;
  }
}