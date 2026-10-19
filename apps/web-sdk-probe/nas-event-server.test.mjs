import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
test('real MCP HTTP initialize, schema, UI, and session operations',{timeout:12000},async()=>{
const child=spawn(process.execPath,[new URL('./nas-event-server.mjs',import.meta.url).pathname],{env:{...process.env,NAS_HOST_PROBE_PORT:'18796'},stdio:['ignore','pipe','pipe']});let stderr='';child.stderr.on('data',b=>stderr+=b);
try{await new Promise((resolve,reject)=>{const t=setTimeout(()=>reject(Error('server timeout '+stderr)),4000);child.stdout.on('data',b=>{if(String(b).includes('NAS_EVENT_PROBE_READY')){clearTimeout(t);resolve();}});child.once('exit',code=>{clearTimeout(t);reject(Error('server exit '+code+' '+stderr));});});
const rpc=async(method,params={})=>{const res=await fetch('http://127.0.0.1:18796/mcp',{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});assert.equal(res.status,200);const b=await res.json();assert.equal(b.error,undefined);return b.result;};
const health=await fetch('http://127.0.0.1:18796/healthz').then(r=>r.json());assert.equal(health.version,'0.2.0');
await rpc('initialize',{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'no-inference-test',version:'1'}});
const list=await rpc('tools/list');assert.equal(list.tools.length,2);assert.ok(list.tools.find(x=>x.name==='nas_event_probe_session'));
const result=await rpc('tools/call',{name:'web_sdk_probe',arguments:{}});assert.equal(result.structuredContent.mode,'nas_file_event_probe_v2');
const resource=await rpc('resources/read',{uri:'ui://nas-consumer-host/event-probe-v2.html'});assert.match(resource.contents[0].text,/NAS_EXTERNAL_EVENT_PROBE/);
const legacy=await rpc('resources/read',{uri:'ui://nas-consumer-host/probe.html'});assert.match(legacy.contents[0].text,/NAS_EXTERNAL_EVENT_PROBE/);
const arm=await rpc('tools/call',{name:'nas_event_probe_session',arguments:{action:'arm'}});assert.ok(arm.structuredContent.session);
const stopped=await rpc('tools/call',{name:'nas_event_probe_session',arguments:{action:'stop',session:arm.structuredContent.session}});assert.equal(stopped.structuredContent.state,'stopped');
const res=await fetch('http://127.0.0.1:18796/mcp',{method:'POST',headers:{origin:'https://example.invalid'}});assert.equal(res.status,404);
}finally{child.kill('SIGTERM');}
});
