#!/usr/bin/env node
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createSessionIdleReaper } from '../src/http-session-idle.js';

let clock = 0, closes = 0;
const reaper = createSessionIdleReaper({idleMs:1000,sweepMs:100_000,now:()=>clock});
const transport = { async close(){closes++;reaper.unregister('active',transport);} };
reaper.register('active',transport);
const req = new EventEmitter(), res = new EventEmitter();
reaper.trackRequest('active',req,res);
clock=2_000;await reaper.sweep();
assert.equal(closes,0,'active HTTP request was closed mid-flight');
res.emit('finish');
clock=2_500;await reaper.sweep();
assert.equal(closes,0,'newly idle request was closed too soon');
clock=3_100;await reaper.sweep();
assert.equal(closes,1);
assert.equal(reaper.count(),0,'expired session was not removed');

let failures=0;
const retry = createSessionIdleReaper({idleMs:1000,sweepMs:100_000,now:()=>clock});
retry.register('retry',{async close(){if(!failures++){throw new Error('transient')} }});
clock=5_000;await retry.sweep();
assert.equal(retry.count(),1,'failed cleanup must be retryable');
clock=7_000;await retry.sweep();
assert.equal(retry.count(),0,'session must be removed after a successful retry');
retry.stop();reaper.stop();

const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'wjk-idle-session-'));
const port=await new Promise((resolve,reject)=>{const s=net.createServer();s.on('error',reject);s.listen(0,'127.0.0.1',()=>{const chosen=s.address().port;s.close(()=>resolve(chosen));});});
const cfg=path.join(tmp,'cfg.json');
fs.writeFileSync(cfg,JSON.stringify({roots:[tmp],http:{host:'127.0.0.1',port,secretPath:'idle-regression'},permissions:{default:'allow'}}));
const env={...process.env};
for(const k of Object.keys(env))if(k.startsWith('WEBJJONKU_'))delete env[k];
env.WEBJJONKU_MCP_JSON_RESPONSE='1';
env.WEBJJONKU_MCP_SESSION_IDLE_MS='350';
env.WEBJJONKU_MCP_SESSION_SWEEP_MS='50';
const child=spawn(process.execPath,[path.join(root,'src/index.js'),'--http','--config',cfg],{cwd:tmp,env,stdio:['ignore','pipe','pipe']});
let err='',out='';
child.stdout.on('data',d=>{out+=d.toString();});
child.on('error',e=>{err+=String(e);});
child.stderr.on('data',d=>{err+=d.toString();});
const base='http://127.0.0.1:'+port+'/mcp/idle-regression';
const headers={'content-type':'application/json',accept:'application/json, text/event-stream'};
async function post(body,extra={}){return fetch(base,{method:'POST',headers:{...headers,...extra},body:JSON.stringify(body)});}
try{
  let ready=false;
  for(let i=0;i<375;i++){
    try{const r=await fetch('http://127.0.0.1:'+port+'/health');if(r.ok){ready=true;break;}}catch{}
    if(child.exitCode!==null)throw new Error('HTTP child exited: '+err.slice(-1500));
    await new Promise(r=>setTimeout(r,80));
  }
  assert.ok(ready,'HTTP test child did not become healthy: stderr='+err.slice(-1200)+' stdout='+out.slice(-1200)+' exit='+child.exitCode);
  const noSession=await post({jsonrpc:'2.0',id:1,method:'tools/list',params:{}});
  assert.equal(noSession.status,400,'missing session id must be rejected, not auto-initialized');
  const newSession=async()=>{
    const r=await post({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'idle-test',version:'1'}}});
    const initBody=await r.text();
    assert.equal(r.status,200,'initialization failed: '+initBody.slice(0,250));
    const sid=r.headers.get('mcp-session-id');
    assert.ok(sid,'server must return session id');
    return sid;
  };
  const sid=await newSession();
  const notify=await post({jsonrpc:'2.0',method:'notifications/initialized'},{'mcp-session-id':sid});
  assert.equal(notify.status,202);
  await notify.body?.cancel();
  const active=await post({jsonrpc:'2.0',id:2,method:'tools/list',params:{}},{'mcp-session-id':sid});
  assert.equal(active.status,200,'initial session unexpectedly invalid');
  await active.body?.cancel();
  await new Promise(r=>setTimeout(r,1000));
  const expired=await post({jsonrpc:'2.0',id:3,method:'tools/list',params:{}},{'mcp-session-id':sid});
  assert.equal(expired.status,404,'idle session must be retired and return 404');
  const body=await expired.json();
  assert.equal(body?.error?.code,-32001);
  const replacement=await newSession();
  assert.notEqual(replacement,sid,'new session should have a fresh ID');
  const fresh=await post({jsonrpc:'2.0',method:'notifications/initialized'},{'mcp-session-id':replacement});
  assert.equal(fresh.status,202);
  await fresh.body?.cancel();
  console.log(JSON.stringify({ok:true,activeRequestProtected:true,expiryCleanup:true,failedCleanupRetry:true,stale404:true,freshInitialize:true,missingSession400:true}));
}finally{
  if(child.exitCode===null && child.signalCode===null){
    const exited=new Promise(resolve=>child.once('exit',resolve));
    child.kill();
    await Promise.race([exited,new Promise(resolve=>setTimeout(resolve,5000))]);
  }
  fs.rmSync(tmp,{recursive:true,force:true});
}
