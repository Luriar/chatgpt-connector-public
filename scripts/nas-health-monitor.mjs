import fs from 'node:fs';
import net from 'node:net';
import {spawnSync} from 'node:child_process';
import {connectorRecoveryAction,shouldAttemptConnectorRecovery} from '../src/nas-health-recovery.js';

const LOG=process.env.MONITOR_LOG||'/monitor/health.jsonl';
const INTERVAL=Math.max(10_000,Number(process.env.MONITOR_INTERVAL_MS||60000));
const MAX_BYTES=Math.max(1_000_000,Number(process.env.MONITOR_MAX_BYTES||5_000_000));
const AUTO_RESTART_CONNECTOR=process.env.MONITOR_AUTO_RESTART_CONNECTOR!=='0';
const CONNECTOR_RESTART_AFTER=Math.max(2,Number(process.env.MONITOR_CONNECTOR_RESTART_AFTER||3));
const CONNECTOR_RESTART_FORCE_AFTER=Math.max(CONNECTOR_RESTART_AFTER,Number(process.env.MONITOR_CONNECTOR_RESTART_FORCE_AFTER||10));
const CONNECTOR_CONFIRM_TIMEOUT_MS=Math.max(5_000,Number(process.env.MONITOR_CONNECTOR_CONFIRM_TIMEOUT_MS||30_000));
const CONNECTOR_RESTART_COOLDOWN_MS=Math.max(60_000,Number(process.env.MONITOR_CONNECTOR_RESTART_COOLDOWN_MS||600_000));
const HEALTHY_PERSIST_MS=Math.max(INTERVAL,Number(process.env.MONITOR_HEALTHY_PERSIST_MS||3_600_000));
let failStreak=0;
let connectorFailStreak=0;
let lastConnectorRestartAt=0;
let lastPersistAt=0;
let lastSignature=null;

function bootId(){try{return fs.readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim();}catch{return null;}}
function uptime(){try{return Number(fs.readFileSync('/proc/uptime','utf8').split(/\s+/)[0]);}catch{return null;}}
async function http(url,timeout=8000,headers={}){
  const c=new AbortController(); const t=setTimeout(()=>c.abort(),timeout);
  try{const r=await fetch(url,{signal:c.signal,headers}); return {ok:r.ok,status:r.status};}
  catch(e){return {ok:false,error:String(e?.name||e?.message||e)};} finally{clearTimeout(t);}
}
function tcp(host,port,timeout=2000){return new Promise(resolve=>{
  const s=net.createConnection({host,port}); let done=false;
  const fin=(x)=>{if(done)return;done=true;clearTimeout(t);s.destroy();resolve(x);};
  const t=setTimeout(()=>fin({ok:false,error:'timeout'}),timeout);
  s.once('connect',()=>fin({ok:true})); s.once('error',e=>fin({ok:false,error:e.code||e.message}));
});}
function rotate(){try{if(fs.statSync(LOG).size>=MAX_BYTES){try{fs.rmSync(LOG+'.1');}catch{} fs.renameSync(LOG,LOG+'.1');}}catch{}}
function activeConnectorTasks(){
  const script="const fs=require('fs'),p='/workspace/.webjjonku/runtimes/nas/state.json';try{const s=JSON.parse(fs.readFileSync(p,'utf8'));const a=Object.values(s.tasks||{}).filter(t=>t&&t.status==='running').slice(-5).map(t=>({id:t.id,title:t.title,startedAt:t.startedAt}));process.stdout.write(JSON.stringify(a));}catch{process.stdout.write('[]');}";
  const r=spawnSync('docker',['exec','chatgpt-connector','node','-e',script],{encoding:'utf8',timeout:5_000});
  if(r.status!==0||r.error)return [];
  try{const a=JSON.parse(String(r.stdout||'[]'));return Array.isArray(a)?a:[];}catch{return [];}
}
function connectorContainerState(){
  const r=spawnSync('docker',['inspect','-f','{{.State.Status}}','chatgpt-connector'],{encoding:'utf8',timeout:5_000});
  if(r.status!==0||r.error)return {exists:false,status:null,error:r.error?String(r.error.message||r.error):String(r.stderr||'').trim().slice(-1000)};
  return {exists:true,status:String(r.stdout||'').trim().toLowerCase(),error:null};
}
async function waitConnectorHealth(timeoutMs){
  const deadline=Date.now()+Math.max(1000,timeoutMs);
  let last={ok:false,error:'health wait not started'};
  while(Date.now()<deadline){
    last=await http('http://connector:8747/health',Math.min(2500,Math.max(500,deadline-Date.now())));
    if(last.ok)return last;
    await new Promise(r=>setTimeout(r,500));
  }
  return last;
}
async function maybeRestartConnector(coordinatorOk){
  if(!AUTO_RESTART_CONNECTOR||coordinatorOk!==true)return null;
  const container=connectorContainerState();
  if(!container.exists)return {attempted:false,reason:'container-missing',container};
  const action=connectorRecoveryAction(container.status);
  if(!action)return {attempted:false,reason:'unsupported-container-state',container};
  if(!shouldAttemptConnectorRecovery(container.status,connectorFailStreak,CONNECTOR_RESTART_AFTER))return null;
  const active=container.status==='running'?activeConnectorTasks():[];
  if(active.length&&connectorFailStreak<CONNECTOR_RESTART_FORCE_AFTER){
    return {attempted:false,reason:'active-durable-task',container,activeTasks:active.map(t=>({id:t.id,title:t.title}))};
  }
  const confirm=action==="start"
    ? {ok:false,skipped:true,reason:"container-not-running"}
    : await http('http://connector:8747/health',CONNECTOR_CONFIRM_TIMEOUT_MS);
  if(confirm.ok){
    connectorFailStreak=0;
    return {attempted:false,reason:'long-probe-recovered',container,confirm};
  }
  const now=Date.now();
  if(now-lastConnectorRestartAt<CONNECTOR_RESTART_COOLDOWN_MS)return {attempted:false,reason:'cooldown',container,confirm};
  lastConnectorRestartAt=now;
  const r=spawnSync('docker',[action,'chatgpt-connector'],{encoding:'utf8',timeout:30_000});
  const commandOk=r.status===0&&!r.error;
  const postHealth=commandOk?await waitConnectorHealth(CONNECTOR_CONFIRM_TIMEOUT_MS):{ok:false,error:'docker action failed'};
  const ok=commandOk&&postHealth.ok;
  if(ok)connectorFailStreak=0;
  return {
    attempted:true,ok,action,container,status:r.status,confirm,postHealth,
    error:r.error?String(r.error.message||r.error):null,
    stderr:String(r.stderr||'').trim().slice(-2000)
  };
}
async function sample(){
  const auth=process.env.WEBJJONKU_COORDINATOR_TOKEN?{authorization:'Bearer '+process.env.WEBJJONKU_COORDINATOR_TOKEN}:{};
  const [connector,coordinator,browser,nfs111,nfs2049]=await Promise.all([
    http('http://connector:8747/health',8000),
    http('http://coordinator:8765/health',8000,auth),
    http('http://browser-nas:6080/',8000),
    process.env.MONITOR_NFS_HOST?tcp(process.env.MONITOR_NFS_HOST,111):Promise.resolve({ok:true,skipped:true}),
    process.env.MONITOR_NFS_HOST?tcp(process.env.MONITOR_NFS_HOST,2049):Promise.resolve({ok:true,skipped:true})
  ]);
  const overallOk=[connector,coordinator,browser,nfs111,nfs2049].every(x=>x.ok);
  failStreak=overallOk?0:failStreak+1;
  connectorFailStreak=connector.ok?0:connectorFailStreak+1;
  const recovery=connector.ok?null:await maybeRestartConnector(coordinator.ok);
  const row={ts:new Date().toISOString(),bootId:bootId(),uptimeSeconds:uptime(),overallOk,failStreak,connectorFailStreak,connector,coordinator,browser,nfs111,nfs2049,recovery};
  const signature=JSON.stringify([overallOk,connector.ok,coordinator.ok,browser.ok,nfs111.ok,nfs2049.ok,recovery?.attempted||false,recovery?.reason||null]);
  const now=Date.now(),changed=signature!==lastSignature;
  const shouldPersist=!overallOk||!!recovery||changed||(now-lastPersistAt>=HEALTHY_PERSIST_MS);
  lastSignature=signature;
  if(shouldPersist){
    fs.mkdirSync(new URL('.', 'file://'+LOG).pathname,{recursive:true});
    rotate();
    fs.appendFileSync(LOG,JSON.stringify(row)+'\n');
    fs.writeFileSync('/monitor/current.json',JSON.stringify(row,null,2));
    if(failStreak>=3)fs.writeFileSync('/monitor/last-alert.json',JSON.stringify(row,null,2));
    lastPersistAt=now;
    console.log(JSON.stringify(row));
  }
}
await sample();
setInterval(()=>sample().catch(e=>console.error('sample',e)),INTERVAL);
