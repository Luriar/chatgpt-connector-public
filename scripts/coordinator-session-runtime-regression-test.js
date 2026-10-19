#!/usr/bin/env node
import assert from 'node:assert/strict';
import http from 'node:http';
import {registerCoordinatorTools} from '../src/tools/coordinator.js';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const counts={};
const server=http.createServer(async(req,res)=>{
  let body='';for await(const c of req)body+=c;
  const value=body?JSON.parse(body):{},device=value.deviceId||new URL(req.url,'http://localhost').searchParams.get('device_id');
  const row=counts[device]??={heartbeat:0,poll:0,fail:0};
  if(req.url==='/v1/devices/heartbeat')row.heartbeat++;
  if(req.url.startsWith('/v1/poll?'))row.poll++;
  if(req.url.endsWith('/fail'))row.fail++;
  res.writeHead(200,{'content-type':'application/json'});res.end(req.url.startsWith('/v1/poll?')?'[]':'{}');
});
const timers=[],originalInterval=globalThis.setInterval;
const envKeys=['WEBJJONKU_COORDINATOR_URL','WEBJJONKU_COORDINATOR_DEVICE_ID','WEBJJONKU_COORDINATOR_FORCE_ENV','WEBJJONKU_COORDINATOR_TOKEN'];
const priorEnv=Object.fromEntries(envKeys.map(k=>[k,process.env[k]]));for(const k of envKeys)delete process.env[k];
try{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const url='http://127.0.0.1:'+server.address().port;
 const store=id=>({data:{coordinator:{url,deviceId:id},tasks:{owned:{id:'owned',remoteTaskId:'rt_fixture',status:'failed',error:'fixture terminal failure',events:[]}}},save(){}});
 const first=store('first-device'),second=store('second-device');
 globalThis.setInterval=(...args)=>{const timer=originalInterval(...args);timers.push(timer);return timer;};
 for(let i=0;i<8;i++)registerCoordinatorTools(()=>{},{store:first,cfg:{roots:[],coordinator:{}},sessionRef:{id:'reconnection-'+i,scoped:true}});
 registerCoordinatorTools(()=>{},{store:second,cfg:{roots:[],coordinator:{}}});
 globalThis.setInterval=originalInterval;
 const deadline=Date.now()+4000;
 while(Date.now()<deadline&&(!counts['first-device']?.poll||!counts['second-device']?.poll))await sleep(50);
 await sleep(1200);
 for(const id of ['first-device','second-device']){
  assert.equal(counts[id]?.heartbeat,1,'reconnections must not duplicate background heartbeat for '+id);
  assert.ok(counts[id].poll>=1&&counts[id].poll<=3,'poll cadence remains per runtime for '+id);
  assert.equal(counts[id].fail,1,'terminal command is reported once for '+id);
 }
 assert.ok(first.data.tasks.owned.remoteReported&&second.data.tasks.owned.remoteReported);
 console.log(JSON.stringify({ok:true,reconnections:8,independentStores:2,networkCounts:counts,checks:['reconnect_heartbeat_deduplication','bounded_poll_cadence','single_terminal_report','independent_runtime_sync']}));
}finally{
 globalThis.setInterval=originalInterval;for(const timer of timers)clearInterval(timer);
 for(const k of envKeys){if(priorEnv[k]===undefined)delete process.env[k];else process.env[k]=priorEnv[k];}
 server.closeAllConnections();await new Promise(r=>server.close(r));
}
