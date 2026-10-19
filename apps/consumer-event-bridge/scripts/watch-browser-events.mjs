#!/usr/bin/env node
// NAS resident, model-free, event-triggered browser coordinator. Only worker Chromium may invoke ChatGPT.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {createStore} from '../src/event-store.mjs';

const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const root=process.env.CONSUMER_EVENT_DATA;
const coord=process.env.WEBJJONKU_COORDINATOR_URL;
const token=process.env.WEBJJONKU_COORDINATOR_TOKEN;
const target=process.env.CONSUMER_BROWSER_CHAT_URL;
const enabled=process.env.CONSUMER_BROWSER_ENABLED==='1';
const id=/^evt-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export function checkedTarget(raw){
 const u=new URL(raw);
 if(u.protocol!=='https:'||u.hostname!=='chatgpt.com'||u.username||u.password||u.search||u.hash||!/^\/c\/[0-9a-f-]{36}$/.test(u.pathname))throw Error('explicit ordinary ChatGPT /c/uuid conversation required');
 return u.toString();
}
export function stateFromBrowserTask(task,eventId){
 if(task?.status!=='succeeded')return 'uncertain';
 const result=task.result?.steps?.find(s=>s.type==='chatgpt_event')?.result;
 if(result?.eventId!==eventId)return 'uncertain';
 if(result?.state==='response_visible'&&/^[0-9a-f]{64}$/.test(result.responseSha256||''))return 'response_visible';
 return 'uncertain';
}
async function main(){
 if(!enabled){console.log(JSON.stringify({state:'disabled',reason:'must explicitly configure target and enable'}));return}
 if(!root||!coord||!token||!target)throw Error('missing bridge root/coordinator/token/target');
 const chatUrl=checkedTarget(target);
 const url=new URL(coord);if(url.protocol!=='https:'&&!(url.protocol==='http:'&&['coordinator','chatgpt-coordinator','localhost','127.0.0.1'].includes(url.hostname)))throw Error('untrusted coordinator');
 const store=createStore(root),auditDir=path.join(root,'browser-receipts');fs.mkdirSync(auditDir,{recursive:true,mode:0o700});
 // Exclusive lock; a crash makes it remain stuck rather than risk duplicate model turns.
 const lock=path.join(root,'browser-trigger.lock');const fd=fs.openSync(lock,'wx',0o600);
 fs.writeFileSync(fd,JSON.stringify({pid:process.pid,startedAt:new Date().toISOString()}));
 let active=true;for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{active=false});
 const request=async(endpoint,options={})=>{
  const r=await fetch(new URL(endpoint,url),{...options,signal:AbortSignal.timeout(18000),headers:{authorization:`Bearer ${token}`,...(options.body?{'content-type':'application/json'}:{})}});
  if(!r.ok)throw Error(`coordinator HTTP ${r.status}`);
  return r.json();
 };
 const submit=async(event,readOnly)=>request('/v1/tasks',{method:'POST',body:JSON.stringify({title:'Consumer bridge Chromium '+(readOnly?'preflight':'event')+' '+event.id,executor:'browser',localRequired:false,targetDevice:'browser-nas',idempotencyKey:(readOnly?'chat-probe-':'chat-send-')+event.id,action:{type:'browser',steps:[{type:'chatgpt_event',chatUrl,event,readOnly,timeoutMs:readOnly?43000:110000}],timeoutMs:readOnly?55000:125000}})});
 const waitTask=async task=>{for(let i=0;i<95&&active;i++){await sleep(2000);const t=await request('/v1/tasks/'+encodeURIComponent(task.id));if(['succeeded','failed','cancelled'].includes(t.status))return t}throw Error('browser task outcome uncertain')};
 try{console.log(JSON.stringify({state:'watching',intervalMs:1500,chat:'configured_private_target',canaryOnly:process.env.CONSUMER_BROWSER_PROBE_ONLY==='1'}));
  while(active){const event=store.next();if(!event){await sleep(1500);continue}
   if(!id.test(event.id)){await sleep(1500);continue}
   if(process.env.CONSUMER_BROWSER_PROBE_ONLY==='1'&&event.type!=='nas.harmless.probe'){await sleep(2000);continue}
   try{
    const pre=await waitTask(await submit(event,true));
    const step=pre.result?.steps?.find(x=>x.type==='chatgpt_event')?.result;
    if(pre.status!=='succeeded'||!['ready_to_send','response_visible','user_submitted'].includes(step?.state)){console.log(JSON.stringify({eventId:event.id,phase:'preflight_failed',error:String(pre.error||'not ready').slice(0,120)}));await sleep(60000);continue}
    if(!store.claim(event.id))continue;
    let terminal;
    try{terminal=await waitTask(await submit(event,false))}catch(e){terminal={status:'failed',error:String(e?.message).slice(0,120)}}
    const state=stateFromBrowserTask(terminal,event.id);store.delivery(event.id,state==='response_visible'?'host_accepted':'uncertain');
    const info={eventId:event.id,kind:event.type,deliveryState:state,observedAt:new Date().toISOString(),proof:'browser_dom_observed_not_host_signed',responseSha256:terminal.result?.steps?.find(s=>s.type==='chatgpt_event')?.result?.responseSha256||null};
    fs.writeFileSync(path.join(auditDir,event.id+'.json'),JSON.stringify(info,null,2)+'\n',{mode:0o600,flag:'wx'});
    console.log(JSON.stringify({eventId:event.id,state}));await sleep(60000);
   }catch(e){console.log(JSON.stringify({eventId:event.id,phase:'preflight_or_coordinator_error',error:String(e?.message).slice(0,180)}));await sleep(45000)}
  }
 }finally{fs.closeSync(fd);fs.rmSync(lock,{force:true})}
}
if(process.argv[1]&&import.meta.url===new URL('file://'+path.resolve(process.argv[1])).href){main().catch(e=>{console.error('browser watcher fatal:',e.message);process.exitCode=1})}
