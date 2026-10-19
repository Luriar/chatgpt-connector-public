import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const kinds=new Set(['nas.harmless.probe','research.review.ready','research.progress.ready']);
const idPattern=/^evt-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const refPattern=/^(?:[a-f0-9]{20}|run-[1-9][0-9]{0,7}|probe)$/;
const fsyncDir=dir=>{try{const fd=fs.openSync(dir,'r');try{fs.fsyncSync(fd)}finally{fs.closeSync(fd)}}catch{}};
function putJson(file,obj,{exclusive=false}={}){
 const dir=path.dirname(file);fs.mkdirSync(dir,{recursive:true,mode:0o700});
 const tmp=path.join(dir,'.tmp-'+crypto.randomUUID());
 try{fs.writeFileSync(tmp,JSON.stringify(obj,null,2)+'\n',{mode:0o600,flag:'wx'});if(exclusive){try{fs.linkSync(tmp,file)}catch(e){if(e.code==='EEXIST')return false;throw e}}else fs.renameSync(tmp,file);fsyncDir(dir);return true}
 finally{try{fs.unlinkSync(tmp)}catch{}}
}
function load(file){try{const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);try{const st=fs.fstatSync(fd);if(!st.isFile()||st.size>8192)throw Error('invalid state file');return JSON.parse(fs.readFileSync(fd,'utf8'))}finally{fs.closeSync(fd)}}catch(e){if(e.code==='ENOENT')return null;throw e}}
export function createStore(root,{now=()=>Date.now()}={}){
 const base=path.resolve(root),paths=Object.fromEntries(['events','claims','deliveries','responses','completions','dedup'].map(n=>[n,path.join(base,n)]));
 for(const dir of Object.values(paths))fs.mkdirSync(dir,{recursive:true,mode:0o700});
 const entries=()=>fs.readdirSync(paths.events).filter(n=>idPattern.test(n.replace(/\.json$/,''))&&n.endsWith('.json')).sort();
 function publish({type,ref,ttlMs=3600000}){
  if(!kinds.has(type)||!refPattern.test(String(ref)))throw Error('invalid event type/reference');
  if(!Number.isSafeInteger(ttlMs)||ttlMs<60000||ttlMs>86400000)throw Error('invalid ttl');
  const key=crypto.createHash('sha256').update(type+':'+ref).digest('hex');const existing=load(path.join(paths.dedup,key+'.json'));
  if(existing)return {...existing,duplicate:true};
  const t=now(),id='evt-'+key.slice(0,8)+'-'+key.slice(8,12)+'-4'+key.slice(13,16)+'-a'+key.slice(17,20)+'-'+key.slice(20,32);
  const ev={id,type,ref,createdAt:t,expiresAt:t+ttlMs};
  // Write immutable event before its idempotence index: a crash never fabricates a completed delivery.
  if(!putJson(path.join(paths.events,ev.id+'.json'),ev,{exclusive:true})){
   const previously=load(path.join(paths.events,ev.id+'.json'));if(!previously||previously.type!==type||previously.ref!==ref)throw Error('event key collision');return {...previously,duplicate:true};
  }
  if(!putJson(path.join(paths.dedup,key+'.json'),ev,{exclusive:true}))return {...load(path.join(paths.dedup,key+'.json')),duplicate:true};
  return {...ev,duplicate:false};
 }
 function next(){
  for(const name of entries()){
   const id=name.slice(0,-5),ev=load(path.join(paths.events,name));
   if(!ev||ev.id!==id||!kinds.has(ev.type)||!refPattern.test(ev.ref)||!Number.isSafeInteger(ev.expiresAt)||ev.expiresAt<=now())continue;
   if(fs.existsSync(path.join(paths.claims,id+'.json')))continue;
   return ev;
  }
  return null;
 }
 function claim(id){
  if(!idPattern.test(String(id)))throw Error('invalid id');
  const ev=load(path.join(paths.events,id+'.json'));
  if(!ev||ev.expiresAt<=now()||!kinds.has(ev.type))return null;
  return putJson(path.join(paths.claims,id+'.json'),{id,at:now(),status:'claimed'},{exclusive:true})?ev:null;
 }
 function delivery(id,outcome){
  if(!idPattern.test(String(id))||!['host_accepted','uncertain'].includes(outcome))throw Error('invalid delivery');
  if(!load(path.join(paths.claims,id+'.json')))throw Error('event not claimed');
  const file=path.join(paths.deliveries,id+'.json');
  if(!putJson(file,{id,at:now(),outcome},{exclusive:true})){
   const prior=load(file);if(prior.outcome!==outcome)throw Error('conflicting receipt');return {...prior,duplicate:true};
  }
  return {id,outcome,duplicate:false};
 }
 function recordObservedResponse(id,{evidenceFile}={}){
  if(!idPattern.test(String(id))||typeof evidenceFile!=='string')throw Error('invalid response observation');
  // Operator-only evidence, not a public MCP / browser callback. Never mark scientific completion here.
  const deliveryReceipt=load(path.join(paths.deliveries,id+'.json'));
  if(deliveryReceipt?.outcome!=='host_accepted')throw Error('response observation needs accepted delivery');
  const ev=load(path.join(paths.events,id+'.json'));
  if(!ev||ev.type!=='nas.harmless.probe')throw Error('only harmless probe response observation supported');
  const f=fs.openSync(path.resolve(evidenceFile),fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
  let data;try{const stat=fs.fstatSync(f);if(!stat.isFile()||stat.size<70||stat.size>8192)throw Error('invalid observation size');data=fs.readFileSync(f)}finally{fs.closeSync(f)}
  let evidence;try{evidence=JSON.parse(data.toString('utf8'))}catch{throw Error('invalid observation JSON')}
  if(evidence.event_id!==id||evidence.ref!==ev.ref||evidence.source!=='visible_chat_transcript'||evidence.observed_by!=='trusted_local_operator'||evidence.response_text!=='NAS 이벤트 확인')throw Error('unverified or mismatched response observation');
  const file=path.join(paths.responses,id+'.json');
  const receipt={id,ref:ev.ref,type:ev.type,source:evidence.source,responseText:evidence.response_text,evidenceSha256:crypto.createHash('sha256').update(data).digest('hex'),recordedAt:now(),proofLevel:'operator_observed_not_host_signed'};
  if(!putJson(file,receipt,{exclusive:true}))return {...load(file),duplicate:true};
  return {...receipt,duplicate:false};
 }
 function complete(id,{evidenceFile}={}){
  if(!idPattern.test(String(id))||typeof evidenceFile!=='string')throw Error('invalid completion');
  // This must be invoked only by the trusted local CLI, never through public MCP tools.
  const delivered=load(path.join(paths.deliveries,id+'.json'));if(delivered?.outcome!=='host_accepted')throw Error('no accepted host delivery');
  const ev=load(path.join(paths.events,id+'.json'));if(!ev)throw Error('missing event');
  const absolute=path.resolve(evidenceFile);const fd=fs.openSync(absolute,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
  let buf;try{const st=fs.fstatSync(fd);if(!st.isFile()||st.size<40||st.size>2e6)throw Error('invalid evidence size');buf=fs.readFileSync(fd)}finally{fs.closeSync(fd)}
  let verified;try{verified=JSON.parse(buf.toString('utf8'))}catch{throw Error('not JSON evidence')}
  if(verified.event_id!==id||verified.ref!==ev.ref||verified.result_saved!==true)throw Error('evidence does not attest this event and saved result');
  const digest=crypto.createHash('sha256').update(buf).digest('hex');
  const receipt={id,ref:ev.ref,type:ev.type,evidenceSha256:digest,completedAt:now(),verifiedBy:'trusted_local_operator_not_chat_host'};
  if(!putJson(path.join(paths.completions,id+'.json'),receipt,{exclusive:true}))return {...load(path.join(paths.completions,id+'.json')),duplicate:true};
  return receipt;
 }
 function status(){const records=entries();let claimed=0,accepted=0,responseObserved=0,completed=0,pending=0;for(const name of records){const id=name.slice(0,-5),ev=load(path.join(paths.events,name));if(!ev)continue;if(fs.existsSync(path.join(paths.responses,id+'.json')))responseObserved++;if(ev.expiresAt<=now())continue;if(fs.existsSync(path.join(paths.claims,id+'.json')))claimed++;else pending++;if(fs.existsSync(path.join(paths.deliveries,id+'.json')))accepted++;if(fs.existsSync(path.join(paths.completions,id+'.json')))completed++}return {pending,claimed,accepted,responseObserved,completed,total:records.length,external_unattended_closed_window_verified:false};}
 return {publish,next,claim,delivery,recordObservedResponse,complete,status,loadEvent:id=>idPattern.test(String(id))?load(path.join(paths.events,id+'.json')):null};
}
