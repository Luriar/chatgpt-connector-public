import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const script=fileURLToPath(new URL('../scripts/audit-event-protocol.mjs',import.meta.url));
function run(url){return new Promise((resolve,reject)=>{const child=spawn(process.execPath,[script],{env:{...process.env,CONSUMER_EVENT_AUDIT_URL:url}});let stdout='',stderr='';child.stdout.on('data',x=>stdout+=x);child.stderr.on('data',x=>stderr+=x);child.once('error',reject);child.once('exit',code=>resolve({code,stdout,stderr}));});}
async function localServer(t,protocolSupported){const calls=[];const server=http.createServer(async(req,res)=>{let body='';for await(const part of req)body+=part;const {method}=JSON.parse(body);calls.push(method);const version=req.headers['mcp-protocol-version'];let status=200,result;
 if(version==='2026-07-28'&&!protocolSupported){status=400;result={jsonrpc:'2.0',id:1,error:{code:-32000,message:'Unsupported protocol version'}}}
 else if(method==='server/discover'&&protocolSupported)result={jsonrpc:'2.0',id:1,result:{resultType:'complete',supportedVersions:['2026-07-28'],capabilities:{tools:{},events:{}}}};
 else if(method==='events/list'&&protocolSupported)result={jsonrpc:'2.0',id:1,result:{events:[{name:'nas.harmless.probe',delivery:['webhook']}]}};
 else result={jsonrpc:'2.0',id:1,error:{code:-32601,message:'Method not found'}};
 res.writeHead(status,{'content-type':'application/json'}).end(JSON.stringify(result));});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>server.close());return {url:`http://127.0.0.1:${server.address().port}/mcp`,calls};}

test('legacy NAS endpoint blocks MCP Events without even attempting a subscription',async t=>{const s=await localServer(t,false);const r=await run(s.url);assert.equal(r.code,0,r.stderr);const x=JSON.parse(r.stdout);assert.equal(x.protocol2026Supported,false);assert.equal(x.eventsDiscoverable,false);assert.equal(x.closedChatWakeVerified,false);assert.deepEqual(s.calls,['server/discover','events/list','server/discover','events/list']);});
test('even successful MCP 2.0 discovery is NOT proof that ordinary closed ChatGPT chats can wake',async t=>{const s=await localServer(t,true);const r=await run(s.url);assert.equal(r.code,0,r.stderr);const x=JSON.parse(r.stdout);assert.equal(x.protocol2026Supported,true);assert.equal(x.eventsDiscoverable,true);assert.equal(x.ordinaryChatSubscriptionVerified,false);assert.equal(x.closedChatWakeVerified,false);assert.ok(!s.calls.includes('events/subscribe'));});
test('refuse connections to external endpoints or disguised URLs',async()=>{for(const bad of ['https://chatgpt.com/mcp','http://127.0.0.1:18797/other','http://127.0.0.1.evil.example/mcp']){const r=await run(bad);assert.notEqual(r.code,0);assert.match(r.stderr,/Only loopback MCP endpoint/);}});
