#!/usr/bin/env node
// Portable personal coordinator service. Deploy on any always-on Node host.
// Provides device heartbeat, task queue/lease, waiting_for_device resume, idempotency, and cloud-only HTTP tasks.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { Cron } from "croner";
import { pinnedRequest } from "../src/net-safe.js";

const args=process.argv.slice(2);
const opt=(n,d)=>{const i=args.indexOf(n);return i>=0&&args[i+1]?args[i+1]:d;};
const host=opt("--host","127.0.0.1"),port=Number(opt("--port","8765"));
const dataFile=path.resolve(opt("--data",path.join(process.cwd(),"coordinator-state.json")));
const stateKeyFile=path.resolve(opt("--state-key-file",process.env.WEBJJONKU_COORDINATOR_STATE_KEY_FILE||dataFile+".key"));
const authToken=opt("--token",process.env.WEBJJONKU_COORDINATOR_TOKEN||"");
const blobDir=path.resolve(opt("--blob-dir",path.join(path.dirname(dataFile),"coordinator-blobs"))),siteRoot=path.join(blobDir,"sites"),delegationRoot=path.join(blobDir,"delegations");
fs.mkdirSync(blobDir,{recursive:true});fs.mkdirSync(siteRoot,{recursive:true});fs.mkdirSync(delegationRoot,{recursive:true});
const allowPrivateHttp=args.includes("--allow-private-http");
const isLoopbackBind=["127.0.0.1","localhost","::1"].includes(host);
const leaseMs=Number(opt("--lease-ms","30000")),offlineMs=Number(opt("--offline-ms","30000"));
// Browser steps can legitimately run longer than a 30-second device lease.
// Keep device leases unchanged, but give browser jobs their declared timeout
// plus bounded completion/transport slack. Heartbeats still renew the lease.
function taskLeaseMs(task){
  if(task?.executor!=="browser")return leaseMs;
  const declared=Number(task.action?.timeoutMs);
  const budget=Number.isFinite(declared)&&declared>0?declared:60000;
  return Math.max(leaseMs,Math.min(240000,Math.max(30000,budget)+45000));
}
const MAX_UNKEYED_TERMINAL_TASKS=Math.max(50,Number(process.env.WEBJJONKU_MAX_UNKEYED_TERMINAL_TASKS||200));
const MAX_EPHEMERAL_TERMINAL_TASKS=Math.max(20,Number(process.env.WEBJJONKU_MAX_EPHEMERAL_TERMINAL_TASKS||180));
const MAX_NOTIFICATIONS=Math.max(50,Number(process.env.WEBJJONKU_MAX_NOTIFICATIONS||300));
const configuredTerminalResultBytes=Number(process.env.WEBJJONKU_MAX_TERMINAL_RESULT_BYTES);
const MAX_TERMINAL_RESULT_BYTES=Number.isFinite(configuredTerminalResultBytes)&&configuredTerminalResultBytes>0?Math.max(16384,Math.min(5*1024*1024,configuredTerminalResultBytes)):65536;
const configuredTerminalResultGraceMs=Number(process.env.WEBJJONKU_TERMINAL_RESULT_GRACE_MS);
const TERMINAL_RESULT_GRACE_MS=Number.isFinite(configuredTerminalResultGraceMs)&&configuredTerminalResultGraceMs>=1000?Math.max(1000,Math.min(24*60*60*1000,configuredTerminalResultGraceMs)):15*60*1000;
const configuredLeasePersistMs=Number(process.env.WEBJJONKU_LEASE_PERSIST_MS);
const LEASE_PERSIST_MS=Number.isFinite(configuredLeasePersistMs)&&configuredLeasePersistMs>0?Math.max(500,Math.min(10000,configuredLeasePersistMs)):Math.max(1000,Math.min(10000,Math.floor(leaseMs/3)));
let ticking=false;
const webhookRate=new Map();

function currentWindowsSid(){
  try{
    const who=spawnSync("whoami",["/user","/fo","csv","/nh"],{encoding:"utf8",timeout:5000,windowsHide:true});
    return String(who.stdout||"").match(/"[^"]*","([^"]+)"/)?.[1]||null;
  }catch{return null;}
}
const hardenedFiles=new Set();
function hardenFile(file){
  try{fs.chmodSync(file,0o600);}catch{}
  if(process.platform==="win32"){
    if(hardenedFiles.has(file))return true;
    const sid=currentWindowsSid();if(!sid)return false;
    try{
      const r=spawnSync("icacls",[file,"/inheritance:r","/grant:r","*"+sid+":(F)","/grant:r","*S-1-5-18:(F)"],{stdio:"ignore",windowsHide:true,timeout:10000});
      if(r.status===0)hardenedFiles.add(file);
      return r.status===0;
    }catch{return false;}
  }
  return true;
}
function stateKeyMaterial(){
  const supplied=process.env.WEBJJONKU_COORDINATOR_STATE_KEY;
  if(supplied)return crypto.createHash("sha256").update(String(supplied)).digest();
  if(fs.existsSync(stateKeyFile)){
    const raw=fs.readFileSync(stateKeyFile,"utf8").trim();
    const b=Buffer.from(raw,"base64");if(b.length===32){if(!hardenFile(stateKeyFile)&&!isLoopbackBind)throw new Error("coordinator state key ACL hardening failed");return b;}
    throw new Error("invalid coordinator state key file");
  }
  fs.mkdirSync(path.dirname(stateKeyFile),{recursive:true});
  const key=crypto.randomBytes(32);fs.writeFileSync(stateKeyFile,key.toString("base64"),{mode:0o600});if(!hardenFile(stateKeyFile)&&!isLoopbackBind)throw new Error("coordinator state key ACL hardening failed");return key;
}
const DURABLE_FSYNC=process.env.WEBJJONKU_DURABLE_FSYNC!==undefined?process.env.WEBJJONKU_DURABLE_FSYNC!=="0":!String(dataFile||"").startsWith("/data/");
const stateKey=stateKeyMaterial(),STATE_AAD=Buffer.from("webjjonku-coordinator-state-v1");
function encryptState(obj){
  const iv=crypto.randomBytes(12),c=crypto.createCipheriv("aes-256-gcm",stateKey,iv);c.setAAD(STATE_AAD);
  const ciphertext=Buffer.concat([c.update(Buffer.from(JSON.stringify(obj))),c.final()]),tag=c.getAuthTag();
  return {format:"wjk-state-aesgcm-v1",iv:iv.toString("base64"),tag:tag.toString("base64"),ciphertext:ciphertext.toString("base64")};
}
function decodeState(parsed){
  if(parsed?.format!=="wjk-state-aesgcm-v1")return parsed;
  const iv=Buffer.from(parsed.iv||"","base64"),tag=Buffer.from(parsed.tag||"","base64"),ciphertext=Buffer.from(parsed.ciphertext||"","base64");
  if(iv.length!==12||tag.length!==16||!ciphertext.length)throw new Error("invalid encrypted state envelope");
  const d=crypto.createDecipheriv("aes-256-gcm",stateKey,iv);d.setAAD(STATE_AAD);d.setAuthTag(tag);
  return JSON.parse(Buffer.concat([d.update(ciphertext),d.final()]).toString("utf8"));
}
function readStateFile(file){return decodeState(JSON.parse(fs.readFileSync(file,"utf8")));}
function validStateCandidate(file){
  if(!fs.existsSync(file))return null;
  const body=fs.readFileSync(file,"utf8");
  const value=decodeState(JSON.parse(body));
  if(!value||typeof value!=="object"||Array.isArray(value))throw new Error("invalid coordinator state shape");
  return {file,body,value};
}
function firstValidStateCandidate(){
  let firstError=null,sawAny=false;
  for(const file of [dataFile,dataFile+".bak",dataFile+".bak2"]){
    if(!fs.existsSync(file))continue;
    sawAny=true;
    try{return validStateCandidate(file);}catch(e){if(!firstError)firstError=e;}
  }
  if(!sawAny)return null;
  throw new Error("coordinator state decrypt/parse failed: "+String(firstError?.message||firstError));
}
function fsyncParentDir(file){
  let fd;
  try{fd=fs.openSync(path.dirname(file),"r");if(DURABLE_FSYNC)fs.fsyncSync(fd);}
  catch{}
  finally{if(fd!==undefined)try{fs.closeSync(fd);}catch{}}
}
function atomicWriteFile(file,body){
  const dir=path.dirname(file);fs.mkdirSync(dir,{recursive:true});
  const tmp=file+".tmp-"+process.pid+"-"+crypto.randomBytes(4).toString("hex");
  let fd;
  try{
    fd=fs.openSync(tmp,"wx",0o600);
    fs.writeFileSync(fd,body,{encoding:"utf8"});
    if(DURABLE_FSYNC)fs.fsyncSync(fd);
    fs.closeSync(fd);fd=undefined;
    fs.renameSync(tmp,file);
    fsyncParentDir(file);
    hardenFile(file);
  }catch(e){
    if(fd!==undefined)try{fs.closeSync(fd);}catch{}
    try{fs.rmSync(tmp,{force:true});}catch{}
    throw e;
  }
}
function emptyState(){return {version:2,devices:{},tasks:{},idempotency:{},authTokens:{},delegations:{}};}
function load(){
  const found=firstValidStateCandidate();
  return found?found.value:emptyState();
}
let state=load();if(!state.blobs)state.blobs={};if(!state.schedules)state.schedules={};if(!state.webhooks)state.webhooks={};if(!Array.isArray(state.notifications))state.notifications=[];if(!state.sites)state.sites={};if(!state.authTokens||typeof state.authTokens!=="object")state.authTokens={};if(!state.delegations||typeof state.delegations!=="object")state.delegations={};
function truncateStoredText(value,maxBytes){
  const s=String(value??"");if(Buffer.byteLength(s,"utf8")<=maxBytes)return s;
  const marker="\n...[truncated for coordinator retention]...\n",budget=Math.max(0,maxBytes-Buffer.byteLength(marker,"utf8")),head=Math.floor(budget/2),tail=budget-head,b=Buffer.from(s,"utf8");
  return b.subarray(0,head).toString("utf8")+marker+b.subarray(-tail).toString("utf8");
}
function fitTerminalSummary(raw,extra={}){
  let lo=0,hi=Math.min(Buffer.byteLength(raw,"utf8"),MAX_TERMINAL_RESULT_BYTES),best={truncated:true,...extra,preview:""};
  while(lo<=hi){
    const mid=Math.floor((lo+hi)/2),candidate={truncated:true,...extra,preview:truncateStoredText(raw,mid)};
    if(Buffer.byteLength(JSON.stringify(candidate),"utf8")<=MAX_TERMINAL_RESULT_BYTES){best=candidate;lo=mid+1;}
    else hi=mid-1;
  }
  return best;
}
function compactTerminalResult(value){
  if(value==null)return value;
  if(typeof value==="string")return truncateStoredText(value,MAX_TERMINAL_RESULT_BYTES);
  let raw;try{raw=JSON.stringify(value);}catch{raw=String(value);}
  if(Buffer.byteLength(raw,"utf8")<=MAX_TERMINAL_RESULT_BYTES)return value;
  if(value&&typeof value==="object"&&Array.isArray(value.steps)){
    const perStep=Math.max(2048,Math.floor((MAX_TERMINAL_RESULT_BYTES-8192)/Math.max(1,value.steps.length)));
    const next={...value,truncated:true,steps:value.steps.map(step=>{
      if(!step||typeof step!=="object")return step;
      return {...step,output:typeof step.output==="string"?truncateStoredText(step.output,perStep):step.output};
    })};
    try{if(Buffer.byteLength(JSON.stringify(next),"utf8")<=MAX_TERMINAL_RESULT_BYTES)return next;}catch{}
  }
  return fitTerminalSummary(raw,value&&typeof value==="object"&&value.localTaskId?{localTaskId:value.localTaskId}:{});
}
function pruneHistory(){
  const terminal=new Set(["succeeded","failed","cancelled"]);
  const now=Date.now();
  let changed=false;
  const removeTask=t=>{
    delete state.tasks[t.id];
    if(t.idempotencyKey){
      const slot=idempotencySlot(t.idempotencyKey);
      if(state.idempotency[slot]===t.id)delete state.idempotency[slot];
    }
    changed=true;
  };
  for(const t of Object.values(state.tasks||{})){
    if(!terminal.has(t.status))continue;
    const finishedAt=new Date(t.finishedAt||t.createdAt||0).getTime();
    if(!t.idempotencyKey&&Number.isFinite(finishedAt)&&now-finishedAt>=TERMINAL_RESULT_GRACE_MS){
      const compacted=compactTerminalResult(t.result);
      if(compacted!==t.result){t.result=compacted;changed=true;}
    }
    if(typeof t.error==="string"){
      const compactedError=truncateStoredText(t.error,16384);
      if(compactedError!==t.error){t.error=compactedError;changed=true;}
    }
  }
  const unkeyed=Object.values(state.tasks||{}).filter(t=>terminal.has(t.status)&&!t.idempotencyKey);
  if(unkeyed.length>MAX_UNKEYED_TERMINAL_TASKS){
    unkeyed.sort((a,b)=>new Date(b.finishedAt||b.createdAt||0)-new Date(a.finishedAt||a.createdAt||0));
    for(const t of unkeyed.slice(MAX_UNKEYED_TERMINAL_TASKS))removeTask(t);
  }
  const isEphemeral=t=>t.retentionClass==="ephemeral"||(t.title==="Windows recovery E2E probe"&&String(t.idempotencyKey||"").startsWith("windows-recovery:"));
  const ephemeral=Object.values(state.tasks||{}).filter(t=>terminal.has(t.status)&&isEphemeral(t));
  if(ephemeral.length>MAX_EPHEMERAL_TERMINAL_TASKS){
    ephemeral.sort((a,b)=>new Date(b.finishedAt||b.createdAt||0)-new Date(a.finishedAt||a.createdAt||0));
    for(const t of ephemeral.slice(MAX_EPHEMERAL_TERMINAL_TASKS))removeTask(t);
  }
  for(const [slot,id] of Object.entries(state.idempotency||{}))if(!state.tasks[id]){delete state.idempotency[slot];changed=true;}
  if(Array.isArray(state.notifications)&&state.notifications.length>MAX_NOTIFICATIONS){state.notifications=state.notifications.slice(-MAX_NOTIFICATIONS);changed=true;}
  for(const d of Object.values(state.delegations||{})){
    if(d.kind==="open"&&d.status==="open"&&Date.now()-new Date(d.lastUsedAt||d.createdAt||0).getTime()>=24*60*60*1000){
      d.status="expired";d.accessRevokedAt=new Date().toISOString();d.updatedAt=d.accessRevokedAt;changed=true;
    }
  }
  return changed;
}
let backupRotationValidated=false;
function save(){
  pruneHistory();
  fs.mkdirSync(path.dirname(dataFile),{recursive:true});
  const bak=dataFile+".bak",bak2=dataFile+".bak2";
  // Validate the old generation once after startup. A recovery from .bak or
  // .bak2 must repair the corrupt primary before rotating generations.
  if(!backupRotationValidated){
    const valid=firstValidStateCandidate();
    if(valid&&valid.file!==dataFile){
      atomicWriteFile(dataFile,valid.body);
      atomicWriteFile(bak,valid.body);
    }
    backupRotationValidated=true;
  }
  // Preserve the primary path throughout each save. Rename-rotating the
  // primary away leaves a gap where readers/backups see ENOENT. Hard-link its
  // immutable encrypted generation to .bak instead; atomicWriteFile replaces
  // the primary inode only after the new encrypted file is fully written.
  if(fs.existsSync(bak)){
    if(fs.existsSync(bak2))fs.rmSync(bak2,{force:true});
    fs.renameSync(bak,bak2);
  }
  if(fs.existsSync(dataFile)){
    const staged=bak+".tmp-"+process.pid+"-"+crypto.randomBytes(4).toString("hex");
    try{
      fs.linkSync(dataFile,staged);
      fs.renameSync(staged,bak);
      hardenFile(bak);
    }catch(e){
      try{fs.rmSync(staged,{force:true});}catch{}
      throw e;
    }
  }
  atomicWriteFile(dataFile,JSON.stringify(encryptState(state),null,2));
}
function canonicalTargetDevice(value){
  const device=safeKey(value,"target device");
  return device.toLowerCase()==="windows"?"windows-worker":device;
}
// Preserve task identity/idempotency when repairing a legacy alias. Never reissue
// running/terminal work; online heartbeats requeue retained waiting tasks once.
function migrateLegacyWindowsTasks(){
  let changed=false;
  for(const task of Object.values(state.tasks||{})){
    if(task.executor!=="device"||task.targetDevice!=="windows"||!["waiting_for_device","queued","scheduled"].includes(task.status))continue;
    task.targetDevice="windows-worker";
    if(task.status==="waiting_for_device"&&deviceOnline("windows-worker"))task.status="queued";
    changed=true;
  }
  return changed;
}
const migratedLegacyWindowsTasks=migrateLegacyWindowsTasks();
if(pruneHistory()||migratedLegacyWindowsTasks)save();
let deferredSaveTimer=null;
function saveSoon(delayMs=1000){
  if(deferredSaveTimer)return;
  deferredSaveTimer=setTimeout(()=>{
    deferredSaveTimer=null;
    try{save();}catch(e){console.error("[coordinator] deferred save failed:",String(e?.message||e));}
  },Math.max(50,Number(delayMs)||1000));
  deferredSaveTimer.unref?.();
}
function json(res,code,obj){res.writeHead(code,{"content-type":"application/json"});res.end(JSON.stringify(obj));}
function readBody(req){return new Promise((resolve,reject)=>{let s="";req.on("data",d=>{s+=d;if(s.length>5e6)reject(new Error("body too large"));});req.on("end",()=>{try{resolve(s?JSON.parse(s):{});}catch(e){reject(e);}});req.on("error",reject);});}
function readRaw(req,max=50*1024*1024){return new Promise((resolve,reject)=>{const parts=[];let n=0;req.on("data",d=>{n+=d.length;if(n>max){reject(new Error("blob too large"));req.destroy();return;}parts.push(d);});req.on("end",()=>resolve(Buffer.concat(parts)));req.on("error",reject);});}
function blobFile(key){return path.join(blobDir,crypto.createHash("sha256").update(key).digest("hex")+".blob");}
function encryptBlobBytes(key,raw){
  const iv=crypto.randomBytes(12),aad=Buffer.from("webjjonku-coordinator-blob-v1:"+key),c=crypto.createCipheriv("aes-256-gcm",stateKey,iv);c.setAAD(aad);
  const ciphertext=Buffer.concat([c.update(raw),c.final()]),tag=c.getAuthTag();
  return Buffer.from(JSON.stringify({format:"wjk-blob-aesgcm-v1",iv:iv.toString("base64"),tag:tag.toString("base64"),ciphertext:ciphertext.toString("base64")}));
}
function decryptBlobBytes(key,stored){
  let e;try{e=JSON.parse(stored.toString("utf8"));}catch{return stored;}
  if(e?.format!=="wjk-blob-aesgcm-v1")return stored;
  const iv=Buffer.from(e.iv||"","base64"),tag=Buffer.from(e.tag||"","base64"),ciphertext=Buffer.from(e.ciphertext||"","base64"),aad=Buffer.from("webjjonku-coordinator-blob-v1:"+key);
  if(iv.length!==12||tag.length!==16)throw new Error("invalid encrypted blob envelope");
  const d=crypto.createDecipheriv("aes-256-gcm",stateKey,iv);d.setAAD(aad);d.setAuthTag(tag);return Buffer.concat([d.update(ciphertext),d.final()]);
}
function atomicWriteBuffer(file,body){
  const dir=path.dirname(file);fs.mkdirSync(dir,{recursive:true});
  const tmp=file+".tmp-"+process.pid+"-"+crypto.randomBytes(4).toString("hex");
  let fd;
  try{
    fd=fs.openSync(tmp,"wx",0o600);fs.writeFileSync(fd,body);if(DURABLE_FSYNC)fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;
    fs.renameSync(tmp,file);fsyncParentDir(file);hardenFile(file);
  }catch(e){if(fd!==undefined)try{fs.closeSync(fd);}catch{}try{fs.rmSync(tmp,{force:true});}catch{}throw e;}
}
function delegationResultFile(id){return path.join(delegationRoot,safeKey(id,"delegation id")+".result");}
function publicDelegation(d,{includeInputs=false}={}){
  const {taskTokenHash:_,...x}=structuredClone(d);
  if(!includeInputs)x.inputs=Object.keys(x.inputs||{});
  return x;
}
function delegationVisibleTo(identity,d){
  if(!identity?.subject)return true;
  const s=String(identity.subject);
  return String(d?.submittedBy||"")===s||String(d?.targetDevice||"")===s;
}
function delegationByToken(token){
  if(typeof token!=="string"||token.length<20)return null;
  for(const d of Object.values(state.delegations||{}))if(!d.accessRevokedAt&&hashMatchesHex(d.taskTokenHash,token))return d;
  return null;
}
function createDelegation(body,identity){
  const instructions=String(body.instructions||"").trim();if(!instructions||instructions.length>200000)throw new Error("instructions required (max 200000 chars)");
  const inputs=body.inputs&&typeof body.inputs==="object"&&!Array.isArray(body.inputs)?body.inputs:{};
  let inputBytes=0;for(const [k,v] of Object.entries(inputs)){safeKey(k,"input name");if(typeof v!=="string")throw new Error("delegation inputs must be strings");inputBytes+=Buffer.byteLength(v);}
  if(inputBytes>2*1024*1024)throw new Error("delegation inputs too large");
  const kind=body.kind?String(body.kind):"delegate";if(!["delegate","open"].includes(kind))throw new Error("invalid delegation kind");
  const mode=String(body.mode||"xh").toLowerCase();if(!["m","medium","h","high","xh","xhigh","p","pro"].includes(mode))throw new Error("invalid delegation mode");
  const canonicalMode={m:"m",medium:"m",h:"h",high:"h",xh:"xh",xhigh:"xh",p:"pro",pro:"pro"}[mode];
  const id=body.id?safeKey(body.id,"delegation id"):"dlg_"+crypto.randomBytes(8).toString("hex");
  if(state.delegations[id])throw new Error("delegation id exists");
  const token=crypto.randomBytes(32).toString("base64url"),nowIso=new Date().toISOString();
  const backupMs=Math.max(30000,Math.min(24*60*60*1000,Number(body.backupMs||20*60*1000)));
  const targetDevice=body.targetDevice?safeKey(body.targetDevice,"target device"):null;
  const d={id,kind,mode:canonicalMode,title:String(body.title||instructions.slice(0,100)),instructions,inputs,cwd:body.cwd?String(body.cwd):null,
    status:kind==="open"?"open":"running",summary:null,resultSha256:null,resultBytes:0,resultSubmittedAt:null,collectedAt:null,accessRevokedAt:null,
    taskTokenHash:tokenHash(token),submittedBy:identity?.subject||identity?.id||null,targetDevice,
    createdAt:nowIso,updatedAt:nowIso,lastUsedAt:nowIso,backupMs,nextCheckAt:kind==="open"?null:new Date(Date.now()+backupMs).toISOString(),cancelledAt:null};
  state.delegations[id]=d;save();return {delegation:d,token};
}
function readDelegationResult(d){
  if(!d.resultSha256)return null;const file=delegationResultFile(d.id);if(!fs.existsSync(file))throw new Error("delegation result missing");
  const raw=decryptBlobBytes("delegation:"+d.id,fs.readFileSync(file)),sha=crypto.createHash("sha256").update(raw).digest("hex");
  if(sha!==d.resultSha256)throw new Error("delegation result integrity mismatch");return raw.toString("utf8");
}
function encryptSiteBytes(siteId,revision,rel,raw){
  const iv=crypto.randomBytes(12),aad=Buffer.from("webjjonku-coordinator-site-v1:"+siteId+":"+revision+":"+rel),c=crypto.createCipheriv("aes-256-gcm",stateKey,iv);c.setAAD(aad);
  const ciphertext=Buffer.concat([c.update(raw),c.final()]),tag=c.getAuthTag();
  return Buffer.from(JSON.stringify({format:"wjk-site-aesgcm-v1",iv:iv.toString("base64"),tag:tag.toString("base64"),ciphertext:ciphertext.toString("base64")}));
}
function decryptSiteBytes(siteId,revision,rel,stored){
  let e;try{e=JSON.parse(stored.toString("utf8"));}catch{return stored;}
  if(e?.format!=="wjk-site-aesgcm-v1")return stored;
  const iv=Buffer.from(e.iv||"","base64"),tag=Buffer.from(e.tag||"","base64"),ciphertext=Buffer.from(e.ciphertext||"","base64"),aad=Buffer.from("webjjonku-coordinator-site-v1:"+siteId+":"+revision+":"+rel);
  if(iv.length!==12||tag.length!==16)throw new Error("invalid encrypted site envelope");
  const d=crypto.createDecipheriv("aes-256-gcm",stateKey,iv);d.setAAD(aad);d.setAuthTag(tag);return Buffer.concat([d.update(ciphertext),d.final()]);
}
function safeKey(v,label="id"){const s=String(v||"");if(!/^[A-Za-z0-9._:-]{1,160}$/.test(s)||[".","..","__proto__","prototype","constructor"].includes(s))throw new Error("invalid "+label);return s;}
function safeSiteId(v){const s=String(v||"");if(!/^site_[A-Za-z0-9_-]{4,100}$/.test(s))throw new Error("invalid site id");return s;}
function idempotencySlot(v){return crypto.createHash("sha256").update(String(v)).digest("hex");}
function deviceOnline(id){const d=state.devices[id];return !!d && Date.now()-new Date(d.lastSeen).getTime()<offlineMs;}
function routeTask(url){return url.pathname.match(/^\/v1\/tasks\/([^/]+)(?:\/([^/]+))?$/);}
function redactAction(action){
  if(!action||typeof action!=="object")return action;
  const x=structuredClone(action);
  if(x.headers&&typeof x.headers==="object")for(const k of Object.keys(x.headers))if(["authorization","proxy-authorization","cookie","set-cookie","x-api-key","api-key"].includes(k.toLowerCase()))x.headers[k]="***";
  if(x.body!==undefined)x.body="<omitted>";
  if(x.type==="tool"&&x.args!==undefined)x.args="<omitted>";
  return x;
}
function publicTask(t){
  const x=structuredClone(t);
  x.action=redactAction(x.action);
  if(x.triggerPayload!==undefined&&x.triggerPayload!==null)x.triggerPayload="<omitted>";
  return x;
}
function leaseOwned(t,deviceId){
  return !!deviceId&&t.status==="running"&&t.assignedDevice===deviceId&&!!t.leaseUntil&&new Date(t.leaseUntil).getTime()>=Date.now();
}
const TOKEN_ROLES={
  admin:["*"],
  client:["worker","read","submit","blob.read","blob.write","site","automation"],
  device:["worker","read","blob.read","blob.write"],
  "browser-worker":["worker","blob.write"],
  sync:["blob.read","blob.write","read"]
};
const VALID_SCOPES=new Set(["*","admin","worker","read","submit","blob.read","blob.write","site","automation"]);
function tokenHash(value){return crypto.createHash("sha256").update(String(value)).digest("hex");}
function timingBearer(req,secret){
  if(!secret)return false;
  const got=String(req.headers.authorization||""),want="Bearer "+secret,a=Buffer.from(got),b=Buffer.from(want);
  return a.length===b.length&&crypto.timingSafeEqual(a,b);
}
function tokenActive(t){
  if(!t||t.revokedAt)return false;
  if(t.expiresAt&&new Date(t.expiresAt).getTime()<Date.now())return false;
  return true;
}
function authIdentity(req){
  if(authToken&&timingBearer(req,authToken))return {id:"legacy-admin",scopes:["*"],subject:null,legacy:true};
  const raw=String(req.headers.authorization||"");
  if(raw.startsWith("Bearer ")){
    const secret=raw.slice(7);
    for(const t of Object.values(state.authTokens||{})){
      if(tokenActive(t)&&hashMatchesHex(t.tokenHash,secret))return {id:t.id,scopes:t.scopes||[],subject:t.subject||null,legacy:false};
    }
  }
  if(isLoopbackBind&&!authToken&&!Object.values(state.authTokens||{}).some(tokenActive))return {id:"loopback-local",scopes:["*"],subject:null,local:true};
  return null;
}
function hasScope(identity,scope){return !!identity&&(identity.scopes?.includes("*")||identity.scopes?.includes("admin")||identity.scopes?.includes(scope));}
function subjectOk(identity,value){return !identity?.subject||String(identity.subject)===String(value);}
function taskVisibleTo(identity,t){
  if(!identity?.subject)return true;
  const s=String(identity.subject);
  return String(t?.targetDevice||"")===s||String(t?.assignedDevice||"")===s;
}
function publicToken(t){if(!t)return null;const {tokenHash:_,...x}=t;return x;}
function requestedScopes(body){
  const role=body.role?String(body.role):null;
  const scopes=role?(TOKEN_ROLES[role]||null):(Array.isArray(body.scopes)?body.scopes.map(String):null);
  if(!scopes||!scopes.length)throw new Error("role or scopes required");
  for(const s of scopes)if(!VALID_SCOPES.has(s))throw new Error("invalid auth scope: "+s);
  return [...new Set(scopes)];
}
function requiredScope(req,u){
  const p=u.pathname,m=req.method||"GET";
  if(p==="/health")return "read";
  if(p.startsWith("/v1/auth/tokens"))return "admin";
  if(p.startsWith("/v1/blobs/"))return m==="GET"?"blob.read":"blob.write";
  if(p==="/v1/devices/heartbeat"||p==="/v1/poll")return "worker";
  if(p==="/v1/devices")return "read";
  if(p.startsWith("/v1/sites"))return "site";
  if(p.startsWith("/v1/schedules")||p.startsWith("/v1/webhooks"))return "automation";
  if(p.startsWith("/v1/notifications"))return "read";
  if(p==="/v1/delegations/task"||p==="/v1/delegations/submit")return "worker";
  if(p==="/v1/delegations")return m==="POST"?"submit":"read";
  if(/^\/v1\/delegations\/[^/]+\/(collect|cancel|checked|touch)$/.test(p))return "submit";
  if(/^\/v1\/delegations\/[^/]+$/.test(p))return "read";
  if(p==="/v1/tasks")return m==="POST"?"submit":"read";
  if(/^\/v1\/tasks\/[^/]+$/.test(p))return "read";
  if(/^\/v1\/tasks\/[^/]+\/cancel$/.test(p))return "submit";
  if(/^\/v1\/tasks\/[^/]+\//.test(p))return "worker";
  return "admin";
}
function hashMatchesHex(hex,value){
  try{const a=Buffer.from(String(hex),"hex"),b=crypto.createHash("sha256").update(String(value)).digest();return a.length===b.length&&a.length>0&&crypto.timingSafeEqual(a,b);}catch{return false;}
}
if(!isLoopbackBind&&!authToken&&!Object.values(state.authTokens||{}).some(tokenActive))throw new Error("non-loopback coordinator bind requires a bootstrap/admin token");
function webhookRateOk(id){
  const now=Date.now(),cur=webhookRate.get(id)||{start:now,count:0};
  if(now-cur.start>=60000){cur.start=now;cur.count=0;}
  cur.count++;webhookRate.set(id,cur);return cur.count<=120;
}
function notify(type,title,data={}){
  const n={id:"n_"+crypto.randomBytes(6).toString("hex"),type,title,data,createdAt:new Date().toISOString(),read:false};
  state.notifications.push(n);if(state.notifications.length>2000)state.notifications=state.notifications.slice(-2000);return n;
}
function createTask(b){
  const key=b.idempotencyKey||null,slot=key?idempotencySlot(key):null;
  if(slot&&state.idempotency[slot]&&state.tasks[state.idempotency[slot]])return state.tasks[state.idempotency[slot]];
  const id=b.id?safeKey(b.id,"task id"):"rt_"+crypto.randomBytes(6).toString("hex"),runAt=b.runAt?new Date(b.runAt).toISOString():null;
  if(b.targetDevice)b.targetDevice=canonicalTargetDevice(b.targetDevice);
  if(b.executor&&!["device","browser","cloud"].includes(b.executor))throw new Error("invalid executor");
  const retentionClass=b.retentionClass==null?null:String(b.retentionClass);
  if(retentionClass&&retentionClass!=="ephemeral")throw new Error("invalid retention class");
  let status=runAt&&new Date(runAt).getTime()>Date.now()?"scheduled":"queued";
  if(b.localRequired!==false&&b.targetDevice&&!deviceOnline(b.targetDevice)&&status==="queued")status="waiting_for_device";
  const maxAttempts=Math.min(10,Math.max(1,Number(b.maxAttempts??1)||1)),retryOnLeaseExpiry=b.retryOnLeaseExpiry===true;
  const t={id,title:b.title||id,status,executor:b.executor||"device",action:b.action||null,localRequired:b.localRequired!==false,targetDevice:b.targetDevice||null,assignedDevice:null,leaseUntil:null,runAt,attempts:0,maxAttempts,retryOnLeaseExpiry,createdAt:new Date().toISOString(),startedAt:null,finishedAt:null,result:null,error:null,idempotencyKey:key,retentionClass,scheduleId:b.scheduleId||null,webhookId:b.webhookId||null,triggerPayload:b.triggerPayload??null};
  state.tasks[id]=t;if(slot)state.idempotency[slot]=id;save();return t;
}
function nextForTrigger(trigger,from=new Date()){
  if(trigger?.type==="at"){const d=new Date(trigger.at);return Number.isNaN(d.getTime())?null:d;}
  if(trigger?.type==="interval"){const mins=Math.max(1,Number(trigger.minutes||1));return new Date(from.getTime()+mins*60000);}
  if(trigger?.type==="cron"){const c=new Cron(trigger.expression,{paused:true,timezone:trigger.timezone||undefined});try{return c.nextRun(from);}finally{c.stop();}}
  return null;
}
function scheduleTask(s,scheduledFor){
  const key="schedule:"+s.id+":"+new Date(scheduledFor).toISOString();
  return createTask({...s.taskTemplate,runAt:null,idempotencyKey:key,scheduleId:s.id});
}
function safeSiteRel(rel){
  const s=String(rel||"index.html").replace(/\\/g,"/");
  if(s.startsWith("/")||s.split("/").some(x=>x===".."||x===""))throw new Error("invalid site path");
  return s;
}
function siteFile(siteId,revision,rel){
  siteId=safeSiteId(siteId);
  const safe=safeSiteRel(rel),base=path.join(siteRoot,siteId,"r"+revision),out=path.join(base,...safe.split("/"));
  if(!out.startsWith(base+path.sep)&&out!==base)throw new Error("site path escape");
  return out;
}
function siteMime(rel){
  const e=path.extname(rel).toLowerCase();
  return ({".html":"text/html; charset=utf-8",".htm":"text/html; charset=utf-8",".js":"text/javascript; charset=utf-8",".mjs":"text/javascript; charset=utf-8",".css":"text/css; charset=utf-8",".json":"application/json; charset=utf-8",".svg":"image/svg+xml",".png":"image/png",".jpg":"image/jpeg",".jpeg":"image/jpeg",".gif":"image/gif",".webp":"image/webp",".ico":"image/x-icon",".txt":"text/plain; charset=utf-8"})[e]||"application/octet-stream";
}

async function safeCloudFetch(action){
  let u=new URL(action.url),method=action.method||"GET",body=action.body===undefined?undefined:(typeof action.body==="string"?action.body:JSON.stringify(action.body)),headers={...(action.headers||{})};
  for(let hop=0;hop<=5;hop++){
    if(!["http:","https:"].includes(u.protocol))throw new Error("http/https only");
    if(!allowPrivateHttp&&u.protocol!=="https:")throw new Error("cloud HTTP action은 기본적으로 HTTPS만 허용");
    const res=await pinnedRequest(u,{method,headers,body,timeoutMs:action.timeoutMs||30000,maxBytes:1024*1024,allowPrivateNetwork:allowPrivateHttp});
    if(![301,302,303,307,308].includes(res.status))return res;
    const loc=res.headers.location;if(!loc)throw new Error("redirect without location");
    if(hop===5)throw new Error("too many redirects");
    const next=new URL(loc,u);
    if(next.origin!==u.origin){for(const k of Object.keys(headers))if(["authorization","proxy-authorization","cookie"].includes(k.toLowerCase()))delete headers[k];}
    if(res.status===303||((res.status===301||res.status===302)&&method.toUpperCase()==="POST")){method="GET";body=undefined;}
    u=next;
  }
  throw new Error("redirect loop");
}
async function runCloudTask(t){
  if(t.status!=="queued"||t.executor!=="cloud"||!t.action)return;
  t.status="running";t.startedAt=t.startedAt||new Date().toISOString();t.attempts=(t.attempts||0)+1;save();
  try{
    if(t.action.type!=="http")throw new Error("unsupported cloud action");
    const res=await safeCloudFetch(t.action);
    const body=res.body.toString("utf8");
    t.status=res.ok?"succeeded":"failed";t.result={status:res.status,body:body.slice(0,100000)};t.finishedAt=new Date().toISOString();
  }catch(e){t.status="failed";t.error=String(e.message||e);t.finishedAt=new Date().toISOString();}
  if(["succeeded","failed"].includes(t.status))notify("task."+t.status,t.title,{taskId:t.id,status:t.status,executor:t.executor,scheduleId:t.scheduleId||null,webhookId:t.webhookId||null});
  save();
}

async function tick(){
  if(ticking)return;ticking=true;
  try{
    const now=Date.now();
    for(const s of Object.values(state.schedules)){
      if(!s.enabled||!s.nextRunAt)continue;
      const due=new Date(s.nextRunAt).getTime();if(!Number.isFinite(due)||due>now)continue;
      scheduleTask(s,s.nextRunAt);s.lastRunAt=new Date().toISOString();
      if(s.trigger?.type==="at"){s.enabled=false;s.nextRunAt=null;}
      else if(s.trigger?.type==="interval"){
        let n=new Date(s.nextRunAt);do{n=nextForTrigger(s.trigger,n);}while(n&&n.getTime()<=now);s.nextRunAt=n?.toISOString()||null;
      }else{const n=nextForTrigger(s.trigger,new Date(now+1000));s.nextRunAt=n?.toISOString()||null;}
      save();
    }
    for(const t of Object.values(state.tasks)){
      if(t.status==="scheduled" && (!t.runAt || new Date(t.runAt).getTime()<=now)){
        if(t.localRequired && t.targetDevice && !deviceOnline(t.targetDevice))t.status="waiting_for_device";else t.status="queued";save();
      }
      if(t.status==="waiting_for_device" && (!t.targetDevice || deviceOnline(t.targetDevice))){t.status="queued";save();}
      if(t.status==="running" && t.leaseUntil && new Date(t.leaseUntil).getTime()<now){
        const maxAttempts=Math.max(1,Number(t.maxAttempts||1)),canRetry=t.retryOnLeaseExpiry===true&&(t.attempts||0)<maxAttempts;
        t.assignedDevice=null;t.leaseUntil=null;
        if(canRetry){
          t.status=(t.localRequired&&t.targetDevice&&!deviceOnline(t.targetDevice))?"waiting_for_device":"queued";
          t.error="lease expired; retrying by explicit policy";
        }else{
          t.status="failed";t.error="lease expired; automatic replay disabled to prevent duplicate side effects";t.finishedAt=new Date().toISOString();
          notify("task.failed",t.title,{taskId:t.id,status:t.status,executor:t.executor,error:t.error,reason:"lease_expired"});
        }
        save();
      }
      if(t.status==="queued" && t.executor==="cloud") await runCloudTask(t);
    }
  }finally{ticking=false;}
}
const TICK_MS=Math.max(1000,Math.min(60000,Number(process.env.WEBJJONKU_COORDINATOR_TICK_MS||1000)||1000));
setInterval(tick,TICK_MS).unref?.();

const srv=http.createServer(async(req,res)=>{
  try{
    const u=new URL(req.url,"http://"+(req.headers.host||"localhost"));
    const hook=u.pathname.match(/^\/hooks\/([^/]+)\/([^/]+)$/);
    if(req.method==="POST"&&hook){
      let hookId;try{hookId=safeKey(hook[1],"webhook id");}catch{json(res,404,{error:"webhook not found"});return;}
      const wh=Object.prototype.hasOwnProperty.call(state.webhooks,hookId)?state.webhooks[hookId]:null,given=hook[2];
      if(!wh||!wh.enabled||!hashMatchesHex(wh.secretHash,given)){json(res,404,{error:"webhook not found"});return;}
      if(!webhookRateOk(hookId)){json(res,429,{error:"webhook rate limit"});return;}
      const raw=await readRaw(req,1024*1024);let payload=null;try{payload=raw.length?JSON.parse(raw.toString("utf8")):null;}catch{payload=raw.toString("utf8").slice(0,200000);}
      const t=createTask({...wh.taskTemplate,webhookId:wh.id,triggerPayload:payload,idempotencyKey:req.headers["idempotency-key"]||null});
      wh.lastTriggeredAt=new Date().toISOString();wh.triggerCount=(wh.triggerCount||0)+1;save();
      json(res,202,{ok:true,taskId:t.id,status:t.status});return;
    }
    const publicSite=u.pathname.match(/^\/sites\/([^/]+)\/([^/]+)(?:\/(.*))?$/);
    if(req.method==="GET"&&publicSite){
      let publicSiteId;try{publicSiteId=safeSiteId(publicSite[1]);}catch{res.writeHead(404).end("site not found");return;}
      const site=Object.prototype.hasOwnProperty.call(state.sites,publicSiteId)?state.sites[publicSiteId]:null,cap=publicSite[2];
      if(!site||!hashMatchesHex(site.capabilityHash,cap)){res.writeHead(404).end("site not found");return;}
      let rel=publicSite[3]||"index.html";try{rel=safeSiteRel(rel);}catch{res.writeHead(400).end("bad path");return;}
      const file=siteFile(site.id,site.currentRevision,rel);
      if(!fs.existsSync(file)||!fs.statSync(file).isFile()){res.writeHead(404).end("not found");return;}
      const stored=fs.readFileSync(file),raw=decryptSiteBytes(site.id,site.currentRevision,rel,stored);
      res.writeHead(200,{
        "content-type":siteMime(rel),"content-length":raw.length,"cache-control":"no-store",
        "content-security-policy":"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; media-src 'self' data: blob:; font-src 'self' data:; frame-src 'self'; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'self'; navigate-to 'self'",
        "x-content-type-options":"nosniff","referrer-policy":"no-referrer","cross-origin-resource-policy":"same-origin",
        "permissions-policy":"camera=(), microphone=(), geolocation=(), payment=(), usb=()"
      });
      res.end(raw);return;
    }
    const identity=authIdentity(req),need=requiredScope(req,u);
    if(!identity){json(res,401,{error:"unauthorized"});return;}
    if(!hasScope(identity,need)){json(res,403,{error:"forbidden",requiredScope:need});return;}
    if(u.pathname==="/v1/auth/tokens"){
      if(req.method==="GET"){json(res,200,Object.values(state.authTokens||{}).map(publicToken));return;}
      if(req.method==="POST"){
        const b=await readBody(req),id=b.id?safeKey(b.id,"auth token id"):"tok_"+crypto.randomBytes(6).toString("hex");
        if(state.authTokens[id]&&!state.authTokens[id].revokedAt){json(res,409,{error:"auth token id exists"});return;}
        const scopes=requestedScopes(b),subject=b.subject?safeKey(b.subject,"auth token subject"):null,secret=crypto.randomBytes(32).toString("base64url");
        const ttl=Number(b.ttl_seconds||0),expiresAt=ttl>0?new Date(Date.now()+Math.min(ttl,365*24*3600)*1000).toISOString():null;
        const rec={id,role:b.role||null,scopes,subject,tokenHash:tokenHash(secret),createdAt:new Date().toISOString(),expiresAt,revokedAt:null,rotatedAt:null};
        state.authTokens[id]=rec;save();json(res,201,{...publicToken(rec),token:secret});return;
      }
    }
    const authRoute=u.pathname.match(/^\/v1\/auth\/tokens\/([^/]+)(?:\/(rotate|revoke))?$/);
    if(authRoute){
      let id;try{id=safeKey(authRoute[1],"auth token id");}catch{json(res,404,{error:"token not found"});return;}
      const rec=state.authTokens[id];if(!rec){json(res,404,{error:"token not found"});return;}
      if(req.method==="GET"&&!authRoute[2]){json(res,200,publicToken(rec));return;}
      if((req.method==="DELETE"&&!authRoute[2])||(req.method==="POST"&&authRoute[2]==="revoke")){
        rec.revokedAt=new Date().toISOString();save();json(res,200,publicToken(rec));return;
      }
      if(req.method==="POST"&&authRoute[2]==="rotate"){
        const secret=crypto.randomBytes(32).toString("base64url");rec.tokenHash=tokenHash(secret);rec.rotatedAt=new Date().toISOString();rec.revokedAt=null;save();json(res,200,{...publicToken(rec),token:secret});return;
      }
    }
    if(req.method==="GET"&&u.pathname==="/health"){json(res,200,{ok:true,name:"webjjonku-coordinator",devices:Object.keys(state.devices).length,tasks:Object.keys(state.tasks).length,blobs:Object.keys(state.blobs||{}).length,authMode:identity.legacy?"legacy-admin":identity.local?"loopback-local":"scoped"});return;}
    const bm=u.pathname.match(/^\/v1\/blobs\/([^/]+)$/);
    if(bm){
      const key=decodeURIComponent(bm[1]);try{safeKey(key,"blob key");}catch{json(res,400,{error:"invalid blob key"});return;}
      if(req.method==="PUT"){
        const raw=await readRaw(req),expect=req.headers["x-wjk-if-version"];
        const cur=state.blobs[key]||null;if(expect!==undefined&&String(cur?.version||0)!==String(expect)){json(res,409,{error:"version conflict",currentVersion:cur?.version||0});return;}
        const version=(cur?.version||0)+1,encrypted=encryptBlobBytes(key,raw);fs.writeFileSync(blobFile(key),encrypted,{mode:0o600});hardenFile(blobFile(key));
        state.blobs[key]={key,version,size:raw.length,storedSize:encrypted.length,encryptedAtRest:true,contentType:req.headers["content-type"]||"application/octet-stream",updatedAt:new Date().toISOString()};save();
        json(res,200,state.blobs[key]);return;
      }
      if(req.method==="GET"){
        const meta=state.blobs[key],file=blobFile(key);if(!meta||!fs.existsSync(file)){json(res,404,{error:"blob not found"});return;}
        const stored=fs.readFileSync(file),raw=meta.encryptedAtRest?decryptBlobBytes(key,stored):stored;
        res.writeHead(200,{"content-type":meta.contentType||"application/octet-stream","content-length":raw.length,"x-wjk-version":String(meta.version),"x-wjk-updated-at":meta.updatedAt,"x-wjk-at-rest":meta.encryptedAtRest?"aes-gcm":"legacy-plain"});res.end(raw);return;
      }
      if(req.method==="DELETE"){
        const meta=state.blobs[key];if(meta){try{fs.unlinkSync(blobFile(key));}catch{}delete state.blobs[key];save();}json(res,200,{ok:true});return;
      }
    }
    if(req.method==="GET"&&u.pathname==="/v1/devices"){json(res,200,Object.values(state.devices));return;}
    if(req.method==="POST"&&u.pathname==="/v1/devices/heartbeat"){
      const b=await readBody(req);if(!b.deviceId){json(res,400,{error:"deviceId required"});return;}const deviceId=safeKey(b.deviceId,"device id");
      if(!subjectOk(identity,deviceId)){json(res,403,{error:"token subject mismatch"});return;}
      const prev=state.devices[deviceId],capabilities=b.capabilities||[],meta=b.meta||{};
      state.devices[deviceId]={deviceId,lastSeen:new Date().toISOString(),capabilities,meta};
      let durableChange=!prev||JSON.stringify(prev.capabilities||[])!==JSON.stringify(capabilities)||JSON.stringify(prev.meta||{})!==JSON.stringify(meta);
      for(const t of Object.values(state.tasks))if(t.status==="waiting_for_device"&&(!t.targetDevice||t.targetDevice===deviceId)){t.status="queued";durableChange=true;}
      if(durableChange)save();json(res,200,{ok:true,serverTime:new Date().toISOString()});return;
    }
    if(req.method==="POST"&&u.pathname==="/v1/sites"){
      const b=await readBody(req),files=b.files||{};
      if(!b.title||!files||typeof files!=="object"||Array.isArray(files)){json(res,400,{error:"title and files object required"});return;}
      const names=Object.keys(files);if(!names.length||names.length>200){json(res,400,{error:"site files must contain 1..200 entries"});return;}
      let totalBytes=0;for(const [name,value] of Object.entries(files)){safeSiteRel(name);const n=Buffer.byteLength(String(value));if(n>2*1024*1024){json(res,413,{error:"site file too large: "+name});return;}totalBytes+=n;}
      if(totalBytes>10*1024*1024){json(res,413,{error:"site revision too large"});return;}
      if(!names.includes("index.html")){json(res,400,{error:"index.html required"});return;}
      let id=b.id?safeSiteId(b.id):"site_"+crypto.randomBytes(6).toString("hex"),site=state.sites[id];
      if(!site){const capability=crypto.randomBytes(24).toString("base64url");site={id,title:b.title,capability,capabilityHash:crypto.createHash("sha256").update(capability).digest("hex"),currentRevision:0,revisions:[],createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};state.sites[id]=site;}
      site.title=b.title||site.title;const revision=site.currentRevision+1,dir=path.join(siteRoot,id,"r"+revision);fs.mkdirSync(dir,{recursive:true});
      const manifest=[];
      for(const [name,value] of Object.entries(files)){
        const rel=safeSiteRel(name),content=String(value);
        const dst=siteFile(id,revision,rel),raw=Buffer.from(content),encrypted=encryptSiteBytes(id,revision,rel,raw);fs.mkdirSync(path.dirname(dst),{recursive:true});fs.writeFileSync(dst,encrypted,{mode:0o600});hardenFile(dst);manifest.push({path:rel,bytes:raw.length,storedBytes:encrypted.length,encryptedAtRest:true,contentType:siteMime(rel)});
      }
      site.currentRevision=revision;site.updatedAt=new Date().toISOString();site.revisions.push({revision,createdAt:site.updatedAt,files:manifest});
      if(site.revisions.length>50){const removed=site.revisions.splice(0,site.revisions.length-50);for(const old of removed)try{fs.rmSync(path.join(siteRoot,id,"r"+old.revision),{recursive:true,force:true});}catch{}}
      save();
      const proto=String(req.headers["x-forwarded-proto"]||"http").split(",")[0].trim(),hostHeader=String(req.headers["x-forwarded-host"]||req.headers.host||"").split(",")[0].trim(),publicPath="/sites/"+id+"/"+site.capability+"/";
      json(res,201,{id,title:site.title,revision,publicPath,publicUrl:hostHeader?proto+"://"+hostHeader+publicPath:null,files:manifest});return;
    }
    if(req.method==="GET"&&u.pathname==="/v1/sites"){
      const proto=String(req.headers["x-forwarded-proto"]||"http").split(",")[0].trim(),hostHeader=String(req.headers["x-forwarded-host"]||req.headers.host||"").split(",")[0].trim();
      json(res,200,Object.values(state.sites).map(s=>({id:s.id,title:s.title,currentRevision:s.currentRevision,createdAt:s.createdAt,updatedAt:s.updatedAt,publicPath:"/sites/"+s.id+"/"+s.capability+"/",publicUrl:hostHeader?proto+"://"+hostHeader+"/sites/"+s.id+"/"+s.capability+"/":null})));return;
    }
    const siteApi=u.pathname.match(/^\/v1\/sites\/([^/]+)$/);
    if(siteApi){
      let siteId;try{siteId=safeSiteId(siteApi[1]);}catch{json(res,404,{error:"site not found"});return;}const site=Object.prototype.hasOwnProperty.call(state.sites,siteId)?state.sites[siteId]:null;if(!site){json(res,404,{error:"site not found"});return;}
      if(req.method==="GET"){const {capabilityHash,...pub}=site;json(res,200,{...pub,publicPath:"/sites/"+site.id+"/"+site.capability+"/"});return;}
      if(req.method==="DELETE"){try{fs.rmSync(path.join(siteRoot,site.id),{recursive:true,force:true});}catch{}delete state.sites[site.id];save();json(res,200,{ok:true});return;}
    }

    if(req.method==="POST"&&u.pathname==="/v1/schedules"){
      const b=await readBody(req),trigger=b.trigger||{},next=nextForTrigger(trigger,new Date());
      if(!b.taskTemplate||!b.name||!next){json(res,400,{error:"name, valid trigger, taskTemplate required"});return;}
      const id=b.id?safeKey(b.id,"schedule id"):"sch_"+crypto.randomBytes(6).toString("hex");
      const s={id,name:b.name,enabled:b.enabled!==false,trigger,taskTemplate:b.taskTemplate,nextRunAt:next.toISOString(),lastRunAt:null,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};
      state.schedules[id]=s;save();json(res,201,s);return;
    }
    if(req.method==="GET"&&u.pathname==="/v1/schedules"){json(res,200,Object.values(state.schedules).map(s=>({...s,taskTemplate:s.taskTemplate?{...s.taskTemplate,action:redactAction(s.taskTemplate.action)}:null})));return;}
    const sm=u.pathname.match(/^\/v1\/schedules\/([^/]+)(?:\/([^/]+))?$/);
    if(sm){
      let scheduleId;try{scheduleId=safeKey(sm[1],"schedule id");}catch{json(res,404,{error:"schedule not found"});return;}const s=Object.prototype.hasOwnProperty.call(state.schedules,scheduleId)?state.schedules[scheduleId]:null;if(!s){json(res,404,{error:"schedule not found"});return;}
      if(req.method==="DELETE"){delete state.schedules[s.id];save();json(res,200,{ok:true});return;}
      if(req.method==="POST"&&sm[2]){
        const action=sm[2];
        if(action==="enable"||action==="disable"){s.enabled=action==="enable";if(s.enabled&&!s.nextRunAt){const n=nextForTrigger(s.trigger,new Date());s.nextRunAt=n?.toISOString()||null;}s.updatedAt=new Date().toISOString();save();json(res,200,s);return;}
        if(action==="run-now"){const t=scheduleTask(s,new Date());s.lastRunAt=new Date().toISOString();save();json(res,202,t);return;}
      }
      if(req.method==="GET"&&!sm[2]){json(res,200,{...s,taskTemplate:s.taskTemplate?{...s.taskTemplate,action:redactAction(s.taskTemplate.action)}:null});return;}
    }

    if(req.method==="POST"&&u.pathname==="/v1/webhooks"){
      const b=await readBody(req);if(!b.name||!b.taskTemplate){json(res,400,{error:"name and taskTemplate required"});return;}
      const id=b.id?safeKey(b.id,"webhook id"):"wh_"+crypto.randomBytes(6).toString("hex"),secret=crypto.randomBytes(24).toString("base64url");
      const wh={id,name:b.name,enabled:b.enabled!==false,secretHash:crypto.createHash("sha256").update(secret).digest("hex"),taskTemplate:b.taskTemplate,createdAt:new Date().toISOString(),lastTriggeredAt:null,triggerCount:0};
      state.webhooks[id]=wh;save();
      const proto=String(req.headers["x-forwarded-proto"]||"http").split(",")[0].trim(),hostHeader=String(req.headers["x-forwarded-host"]||req.headers.host||"").split(",")[0].trim();
      json(res,201,{id,name:wh.name,enabled:wh.enabled,hookPath:"/hooks/"+id+"/"+secret,hookUrl:hostHeader?proto+"://"+hostHeader+"/hooks/"+id+"/"+secret:null,createdAt:wh.createdAt});return;
    }
    if(req.method==="GET"&&u.pathname==="/v1/webhooks"){
      json(res,200,Object.values(state.webhooks).map(({secretHash,...x})=>({...x,taskTemplate:x.taskTemplate?{...x.taskTemplate,action:redactAction(x.taskTemplate.action)}:null})));return;
    }
    const wm=u.pathname.match(/^\/v1\/webhooks\/([^/]+)(?:\/([^/]+))?$/);
    if(wm){
      let webhookId;try{webhookId=safeKey(wm[1],"webhook id");}catch{json(res,404,{error:"webhook not found"});return;}const wh=Object.prototype.hasOwnProperty.call(state.webhooks,webhookId)?state.webhooks[webhookId]:null;if(!wh){json(res,404,{error:"webhook not found"});return;}
      if(req.method==="DELETE"){delete state.webhooks[wh.id];save();json(res,200,{ok:true});return;}
      if(req.method==="POST"&&wm[2]){
        const action=wm[2];if(action==="enable"||action==="disable"){wh.enabled=action==="enable";save();const {secretHash,...pub}=wh;json(res,200,pub);return;}
      }
      if(req.method==="GET"&&!wm[2]){const {secretHash,...pub}=wh;json(res,200,{...pub,taskTemplate:pub.taskTemplate?{...pub.taskTemplate,action:redactAction(pub.taskTemplate.action)}:null});return;}
    }

    if(req.method==="GET"&&u.pathname==="/v1/notifications"){
      let rows=[...state.notifications];const since=u.searchParams.get("since"),unread=u.searchParams.get("unread"),limit=Math.min(500,Math.max(1,Number(u.searchParams.get("limit")||100)));
      if(since){const ts=new Date(since).getTime();if(Number.isFinite(ts))rows=rows.filter(n=>new Date(n.createdAt).getTime()>ts);}
      if(unread==="true")rows=rows.filter(n=>!n.read);json(res,200,rows.slice(-limit));return;
    }
    const nm=u.pathname.match(/^\/v1\/notifications\/([^/]+)\/read$/);
    if(req.method==="POST"&&nm){const n=state.notifications.find(x=>x.id===nm[1]);if(!n){json(res,404,{error:"notification not found"});return;}n.read=true;n.readAt=new Date().toISOString();save();json(res,200,n);return;}

    if(req.method==="POST"&&u.pathname==="/v1/delegations"){
      const b=await readBody(req),created=createDelegation(b,identity);
      json(res,201,{...publicDelegation(created.delegation,{includeInputs:true}),taskToken:created.token,backupDue:false});return;
    }
    if(req.method==="GET"&&u.pathname==="/v1/delegations"){
      let rows=Object.values(state.delegations||{});if(identity.subject)rows=rows.filter(d=>delegationVisibleTo(identity,d));
      const status=u.searchParams.get("status"),kind=u.searchParams.get("kind");if(status)rows=rows.filter(d=>d.status===status);if(kind)rows=rows.filter(d=>d.kind===kind);
      json(res,200,rows.map(d=>({...publicDelegation(d),backupDue:d.status==="running"&&!!d.nextCheckAt&&new Date(d.nextCheckAt).getTime()<=Date.now(),idleExpiresAt:d.kind==="open"?new Date(new Date(d.lastUsedAt||d.createdAt).getTime()+24*60*60*1000).toISOString():null})));return;
    }
    if(req.method==="POST"&&u.pathname==="/v1/delegations/task"){
      const b=await readBody(req),d=delegationByToken(b.token);if(!d){json(res,404,{error:"delegation not found"});return;}
      if(d.kind==="open"){d.lastUsedAt=new Date().toISOString();d.updatedAt=d.lastUsedAt;saveSoon();}
      json(res,200,{id:d.id,kind:d.kind,mode:d.mode,title:d.title,instructions:d.instructions,inputs:d.inputs||{},cwd:d.cwd,status:d.status,createdAt:d.createdAt,
        ...(d.kind==="open"?{idleExpiresAt:new Date(new Date(d.lastUsedAt).getTime()+24*60*60*1000).toISOString()}:{})});return;
    }
    if(req.method==="POST"&&u.pathname==="/v1/delegations/submit"){
      const b=await readBody(req),d=delegationByToken(b.token);if(!d){json(res,404,{error:"delegation not found"});return;}
      if(d.kind==="open"){json(res,409,{error:"open delegation is user-controlled and cannot submit a final result"});return;}
      const status=String(b.status||"");if(!["completed","partial","failed","cancelled"].includes(status)){json(res,400,{error:"invalid delegation result status"});return;}
      const summary=String(b.summary||"");if(summary.length>2048){json(res,400,{error:"summary too large"});return;}
      const result=String(b.result||"");if(Buffer.byteLength(result,"utf8")>1024*1024){json(res,413,{error:"result too large"});return;}
      const raw=Buffer.from(result,"utf8"),sha=crypto.createHash("sha256").update(raw).digest("hex");
      if(["completed","partial","failed","cancelled"].includes(d.status)&&d.resultSubmittedAt){
        if(d.status===status&&d.resultSha256===sha&&d.summary===summary){json(res,200,{accepted:true,duplicate:true,id:d.id,status:d.status,sha256:sha});return;}
        json(res,409,{error:"delegation already has a different terminal result",status:d.status});return;
      }
      const encrypted=encryptBlobBytes("delegation:"+d.id,raw);atomicWriteBuffer(delegationResultFile(d.id),encrypted);
      d.status=status;d.summary=summary;d.resultSha256=sha;d.resultBytes=raw.length;d.resultSubmittedAt=new Date().toISOString();d.updatedAt=d.resultSubmittedAt;d.nextCheckAt=null;save();
      notify("delegation."+status,d.title,{delegationId:d.id,status,submittedBy:d.submittedBy||null});saveSoon();
      json(res,200,{accepted:true,duplicate:false,id:d.id,status:d.status,sha256:sha});return;
    }
    const dm=u.pathname.match(/^\/v1\/delegations\/([^/]+)(?:\/(collect|cancel|checked|touch))?$/);
    if(dm){
      let delegationId;try{delegationId=safeKey(dm[1],"delegation id");}catch{json(res,404,{error:"delegation not found"});return;}
      const d=Object.prototype.hasOwnProperty.call(state.delegations,delegationId)?state.delegations[delegationId]:null;if(!d){json(res,404,{error:"delegation not found"});return;}
      if(!delegationVisibleTo(identity,d)){json(res,403,{error:"token subject mismatch"});return;}
      if(req.method==="GET"&&!dm[2]){
        json(res,200,{...publicDelegation(d),backupDue:d.status==="running"&&!!d.nextCheckAt&&new Date(d.nextCheckAt).getTime()<=Date.now(),idleExpiresAt:d.kind==="open"?new Date(new Date(d.lastUsedAt||d.createdAt).getTime()+24*60*60*1000).toISOString():null});return;
      }
      if(req.method==="POST"&&dm[2]){
        const action=dm[2],ts=new Date().toISOString();
        if(action==="collect"){
          if(!["completed","partial","failed","cancelled"].includes(d.status)||!d.resultSubmittedAt){json(res,409,{error:"delegation has no collectable result",status:d.status});return;}
          let result;try{result=readDelegationResult(d);}catch(e){json(res,409,{error:String(e.message||e)});return;}
          if(!d.collectedAt){d.collectedAt=ts;d.accessRevokedAt=ts;d.updatedAt=ts;save();}
          json(res,200,{...publicDelegation(d),integrity:"verified",collected:true,result});return;
        }
        if(action==="cancel"){
          if(!["completed","partial","failed","cancelled","expired"].includes(d.status)){d.status="cancelled";d.cancelledAt=ts;d.updatedAt=ts;d.nextCheckAt=null;d.accessRevokedAt=ts;save();}
          json(res,200,publicDelegation(d));return;
        }
        if(action==="checked"){
          if(d.status!=="running"){json(res,409,{error:"delegation is not running",status:d.status});return;}
          d.nextCheckAt=new Date(Date.now()+Math.max(30000,Number(d.backupMs||20*60*1000))).toISOString();d.updatedAt=ts;save();json(res,200,{id:d.id,nextCheckAt:d.nextCheckAt});return;
        }
        if(action==="touch"){
          if(d.kind!=="open"||d.status!=="open"){json(res,409,{error:"delegation is not an open session",status:d.status});return;}
          d.lastUsedAt=ts;d.updatedAt=ts;save();json(res,200,{id:d.id,idleExpiresAt:new Date(Date.now()+24*60*60*1000).toISOString()});return;
        }
      }
    }
    if(req.method==="POST"&&u.pathname==="/v1/tasks"){
      const b=await readBody(req);
      if(b.targetDevice)b.targetDevice=canonicalTargetDevice(b.targetDevice);
      if(identity.subject){
        if(b.executor==="cloud"){json(res,403,{error:"subject-bound token cannot submit cloud task"});return;}
        if(b.targetDevice&&!subjectOk(identity,b.targetDevice)){json(res,403,{error:"token subject mismatch"});return;}
        if(!b.targetDevice)b.targetDevice=identity.subject;
      }
      const slot=b.idempotencyKey?idempotencySlot(b.idempotencyKey):null,existing=slot&&state.idempotency[slot]&&state.tasks[state.idempotency[slot]];
      const t=createTask(b);json(res,existing?200:201,publicTask(t));return;
    }
    if(req.method==="GET"&&u.pathname==="/v1/tasks"){
      let rows=Object.values(state.tasks);const dev=u.searchParams.get("device_id"),status=u.searchParams.get("status"),idempotencyKey=u.searchParams.get("idempotency_key"),limit=Math.max(1,Math.min(500,Number(u.searchParams.get("limit")||25)||25));
      if(dev&&identity.subject&&!subjectOk(identity,dev)){json(res,403,{error:"token subject mismatch"});return;}
      if(identity.subject)rows=rows.filter(t=>taskVisibleTo(identity,t));
      if(dev)rows=rows.filter(t=>!t.targetDevice||t.targetDevice===dev||t.assignedDevice===dev);
      if(status)rows=rows.filter(t=>t.status===status);
      if(idempotencyKey)rows=rows.filter(t=>t.idempotencyKey===idempotencyKey);
      rows.sort((a,b)=>String(b.createdAt||"").localeCompare(String(a.createdAt||"")));
      json(res,200,rows.slice(0,limit).map(publicTask));return;
    }
    if(req.method==="GET"&&u.pathname==="/v1/poll"){
      let dev=u.searchParams.get("device_id"),executor=u.searchParams.get("executor")||"device";if(!dev){json(res,400,{error:"device_id required"});return;}dev=safeKey(dev,"device id");if(!subjectOk(identity,dev)){json(res,403,{error:"token subject mismatch"});return;}if(!["device","browser","cloud"].includes(executor)){json(res,400,{error:"invalid executor"});return;}
      const device=state.devices[dev];if(executor==="browser"&&!device?.capabilities?.includes("cloud-browser")){json(res,403,{error:"device lacks cloud-browser capability"});return;}const rows=Object.values(state.tasks).filter(t=>["queued","waiting_for_device"].includes(t.status)&&t.executor===executor&&(!t.targetDevice||t.targetDevice===dev));json(res,200,rows);return;
    }
    const m=routeTask(u);
    if(m){
      let taskId;try{taskId=safeKey(m[1],"task id");}catch{json(res,404,{error:"task not found"});return;}const t=Object.prototype.hasOwnProperty.call(state.tasks,taskId)?state.tasks[taskId]:null;if(!t){json(res,404,{error:"task not found"});return;}
      if(req.method==="GET"&&!m[2]){if(!taskVisibleTo(identity,t)){json(res,403,{error:"token subject mismatch"});return;}json(res,200,publicTask(t));return;}
      if(req.method==="POST"&&m[2]){
        const b=await readBody(req),action=m[2];
        if(b.deviceId&&!subjectOk(identity,b.deviceId)){json(res,403,{error:"token subject mismatch"});return;}
        if(action==="cancel"&&!taskVisibleTo(identity,t)){json(res,403,{error:"token subject mismatch"});return;}
        if(action==="claim"){
          if(!b.deviceId){json(res,400,{error:"deviceId required"});return;}const deviceId=safeKey(b.deviceId,"device id");
          if(!["queued","waiting_for_device"].includes(t.status)){json(res,409,{error:"not claimable",status:t.status});return;}
          if(t.targetDevice&&t.targetDevice!==deviceId){json(res,403,{error:"wrong device"});return;}
          const maxAttempts=Math.max(1,Number(t.maxAttempts||1));
          if((t.attempts||0)>=maxAttempts){t.status="failed";t.finishedAt=new Date().toISOString();t.error="maximum claim attempts reached";save();json(res,409,{error:t.error,status:t.status,attempts:t.attempts,maxAttempts});return;}
          t.status="running";t.assignedDevice=deviceId;t.leaseUntil=new Date(Date.now()+taskLeaseMs(t)).toISOString();t.startedAt=t.startedAt||new Date().toISOString();t.attempts=(t.attempts||0)+1;save();json(res,200,t);return;
        }
        if(action==="heartbeat"){
          if(!leaseOwned(t,b.deviceId)){json(res,409,{error:"not active lease owner"});return;}
          t.leaseUntil=new Date(Date.now()+taskLeaseMs(t)).toISOString();saveSoon(LEASE_PERSIST_MS);json(res,200,{ok:true,leaseUntil:t.leaseUntil});return;
        }
        if(action==="complete"){
          if(!leaseOwned(t,b.deviceId)){json(res,409,{error:"not active lease owner",status:t.status});return;}
          t.status="succeeded";t.result=b.result??null;t.finishedAt=new Date().toISOString();t.leaseUntil=null;notify("task.succeeded",t.title,{taskId:t.id,status:t.status,executor:t.executor,scheduleId:t.scheduleId||null,webhookId:t.webhookId||null});save();json(res,200,t);return;
        }
        if(action==="fail"){
          if(!leaseOwned(t,b.deviceId)){json(res,409,{error:"not active lease owner",status:t.status});return;}
          t.status="failed";t.error=b.error||"failed";t.result=b.result??null;t.finishedAt=new Date().toISOString();t.leaseUntil=null;notify("task.failed",t.title,{taskId:t.id,status:t.status,executor:t.executor,scheduleId:t.scheduleId||null,webhookId:t.webhookId||null,error:t.error});save();json(res,200,t);return;
        }
        if(action==="release"){
          if(!leaseOwned(t,b.deviceId)){json(res,409,{error:"not active lease owner",status:t.status});return;}
          t.assignedDevice=null;t.leaseUntil=null;t.status=(t.localRequired&&t.targetDevice&&!deviceOnline(t.targetDevice))?"waiting_for_device":"queued";save();json(res,200,t);return;
        }
        if(action==="cancel"){
          t.status="cancelled";t.finishedAt=new Date().toISOString();t.leaseUntil=null;notify("task.cancelled",t.title,{taskId:t.id,status:t.status,executor:t.executor});save();json(res,200,t);return;
        }
      }
    }
    json(res,404,{error:"not found"});
  }catch(e){json(res,500,{error:String(e.message||e)});}
});
const keepAliveMs=Math.max(5000,Number(process.env.WEBJJONKU_COORDINATOR_KEEPALIVE_MS||75000));
srv.keepAliveTimeout=keepAliveMs;
srv.headersTimeout=Math.max(srv.headersTimeout,keepAliveMs+5000);
srv.listen(port,host,()=>console.log(JSON.stringify({ok:true,url:"http://"+host+":"+port,dataFile,auth:!!authToken,keepAliveMs})));
