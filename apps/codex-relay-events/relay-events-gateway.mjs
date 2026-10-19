// Isolated prototype: MCP 2.0 Events (2026-07-28). Localhost only by default.
// The application has NO automatic event producer and NO model or Codex client.
import http from 'node:http';
import https from 'node:https';
import {lookup} from 'node:dns/promises';
import {isIP} from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';

const VERSION='2026-07-28';
const NAME='relay.job.ready';
const PORT=Number(process.env.RELAY_EVENTS_PORT||18794);
const EVENT_SCHEMA={name:NAME,description:'A verified relay job is ready in an authorized queue. This demo never publishes events automatically.',delivery:['webhook'],inputSchema:{type:'object',properties:{queue_id:{type:'string',description:'A single relay job queue to watch (demo only)'}},required:['queue_id'],additionalProperties:false},payloadSchema:{type:'object',properties:{queue_id:{type:'string'},job_id:{type:'string'},status:{type:'string',enum:['ready']},created_at:{type:'string'}},required:['queue_id','job_id','status','created_at'],additionalProperties:false}};
function canonical(value){if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';if(value&&typeof value==='object')return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}';return JSON.stringify(value)}
function constantEqual(a,b){const aa=Buffer.from(String(a)),bb=Buffer.from(String(b));return aa.length===bb.length&&crypto.timingSafeEqual(aa,bb)}
function isPublicIPv4(ip){if(isIP(ip)!==4)return false;const b=ip.split('.').map(Number);const [a,c,d]=b;return !(a===0||a===10||a===127||a>=224||a===169&&c===254||a===172&&c>=16&&c<=31||a===192&&c===168||a===100&&c>=64&&c<=127||a===192&&c===0||a===192&&c===88&&d===99||a===192&&c===0&&d===2||a===198&&c===18||a===198&&c===19||a===198&&c===51&&d===100||a===203&&c===0&&d===113||a===192&&c===0&&d===0)}
function validateUrl(s){if(typeof s!=='string'||s.length>2048)throw Error('Invalid callback URL');let u;try{u=new URL(s)}catch{throw Error('Invalid callback URL')}if(u.protocol!=='https:'||u.port&&u.port!=='443'||u.username||u.password||u.hash||!u.hostname||isIP(u.hostname)||u.hostname==='localhost'||!u.hostname.includes('.'))throw Error('Invalid or unsafe callback URL');return u}
async function pinnedHttpsPost(url,body,headers){const u=validateUrl(url);const records=await lookup(u.hostname,{all:true});const publicA=records.filter(r=>r.family===4&&isPublicIPv4(r.address));if(publicA.length<1||records.some(r=>r.family===4&&!isPublicIPv4(r.address)))throw Error('Callback resolves to unsafe address');const ip=publicA[0].address;return await new Promise((resolve,reject)=>{const req=https.request(u,{method:'POST',headers:{'content-type':'application/json','content-length':Buffer.byteLength(body),...headers},timeout:8000,lookup:(_host,options,cb)=>options.all?cb(null,[{address:ip,family:4}]):cb(null,ip,4),rejectUnauthorized:true},res=>{let acc='';res.setEncoding('utf8');res.on('data',c=>{acc+=c;if(acc.length>8192)req.destroy(Error('Callback response too large'))});res.on('end',()=>resolve({status:res.statusCode,body:acc}))});req.on('timeout',()=>req.destroy(Error('Callback timeout')));req.on('error',reject);req.end(body)})}
function signingKey(secret){if(typeof secret!=='string'||!/^whsec_[A-Za-z0-9+/_=-]+$/.test(secret))throw Error('Invalid signing secret');const enc=secret.slice(6).replace(/-/g,'+').replace(/_/g,'/');const key=Buffer.from(enc,'base64');if(key.length<24||key.length>64)throw Error('Invalid signing secret size');return key}
function signedHeaders(secret,id,body,subscriptionId){const sec=signingKey(secret),ts=String(Math.floor(Date.now()/1000));const mac=crypto.createHmac('sha256',sec).update(`${id}.${ts}.${body}`).digest('base64');return {'webhook-id':id,'webhook-timestamp':ts,'webhook-signature':`v1,${mac}`,'X-MCP-Subscription-Id':subscriptionId}}
function readDb(file){try{const obj=JSON.parse(fs.readFileSync(file,'utf8'));if(!Array.isArray(obj.subscriptions))throw Error('Corrupted subscription store');return obj.subscriptions}catch(e){if(e.code==='ENOENT')return [];throw e}}
function persist(file,subs){fs.mkdirSync(path.dirname(file),{recursive:true});const tmp=file+'.'+crypto.randomUUID()+'.tmp';fs.writeFileSync(tmp,JSON.stringify({version:1,subscriptions:subs}),{mode:0o600,flag:'wx'});try{fs.renameSync(tmp,file)}catch(e){try{fs.unlinkSync(tmp)}catch{}throw e}}
function fail(code,message,data){const e=Error(message);e.rpcCode=code;e.rpcData=data;throw e}
export function createGateway({dbFile,token,transport=pinnedHttpsPost,allowCallbacks=false,owner='local-user'}){
 if(typeof token!=='string'||token.length<32)throw Error('Strong local token required');
 let subs=readDb(dbFile);
 const prune=()=>{const now=Date.now(),remaining=subs.filter(s=>Date.parse(s.refreshBefore)>now);if(remaining.length!==subs.length){subs=remaining;persist(dbFile,subs)}};
 const auth=value=>typeof value==='string'&&value.startsWith('Bearer ')&&constantEqual(value.slice(7),token);
 const subscriptionId=(url,queue)=>'sub_'+crypto.createHash('sha256').update(canonical({owner,url,name:NAME,args:{queue_id:queue}})).digest('hex').slice(0,40);
 async function handle(method,params={}){
  prune();
  switch(method){
   case 'server/discover':return {resultType:'complete',supportedVersions:[VERSION],capabilities:{tools:{},events:{}},_meta:{'io.modelcontextprotocol/serverInfo':{name:'relay-events-gateway-prototype',version:'0.1.0'}},cacheScope:'private',ttlMs:0};
   case 'tools/list':return {resultType:'complete',tools:[{name:'relay_events_status',title:'Relay Events Gateway Status',description:'Read-only local gateway readiness; does not trigger events or models.',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false}}]};
   case 'tools/call':if(params.name!=='relay_events_status')fail(-32602,'Unknown tool');return {resultType:'complete',content:[{type:'text',text:JSON.stringify({event:NAME,subscriptions:subs.length,callbackDeliveryEnabled:allowCallbacks,automatedEventProduction:false,modelCalls:false})}]};
   case 'events/list':return {events:[EVENT_SCHEMA]};
   case 'events/subscribe':{
    if(!allowCallbacks)fail(-32015,'Callback verification disabled on local-only gateway',{reason:'delivery_disabled'});
    if(params.name!==NAME||!params.arguments||Object.keys(params.arguments).sort().join(',')!=='queue_id')fail(-32602,'Unsupported event filter');
    const queue=params.arguments.queue_id;
    if(typeof queue!=='string'||!/^[-_A-Za-z0-9]{1,64}$/.test(queue))fail(-32602,'Invalid queue_id');
    const delivery=params.delivery;
    if(!delivery||delivery.mode!=='webhook')fail(-32602,'Webhook mode required');
    const u=validateUrl(delivery.url);
    signingKey(delivery.secret);
    let ttl=Number.isSafeInteger(params.ttlMs)?params.ttlMs:86400000;
    if(params.ttlMs===null)fail(-32602,'Unlimited subscriptions not supported');
    if(ttl<60000)fail(-32602,'TTL too short');
    ttl=Math.min(ttl,86400000);
    const id=subscriptionId(u.href,queue);
    const challenge=crypto.randomBytes(20).toString('base64url');
    const body=JSON.stringify({type:'verification',challenge});
    const msgId='msg_verification_'+crypto.randomUUID();
    let response;
    try{response=await transport(u.href,body,signedHeaders(delivery.secret,msgId,body,id))}catch(e){
      const raw=String(e?.message||'');
      const phase=raw==='Callback resolves to unsafe address'?'dns_public_address_guard':raw==='Invalid or unsafe callback URL'||raw==='Invalid callback URL'?'url_validation':raw==='Callback timeout'?'https_timeout':raw==='Callback response too large'?'https_response_limit':/certificate|self.signed|unable to verify/i.test(raw)?'tls_certificate':/getaddrinfo|ENOTFOUND|EAI_AGAIN/i.test(raw)?'dns_resolution':'https_transport';
      const code=typeof e?.code==='string'&&/^[A-Z0-9_]{2,60}$/.test(e.code)?e.code:'none';
      process.stdout.write('EVENT_AUDIT callback_transport_error '+new Date().toISOString()+' phase='+phase+' code='+code+'\n');
      fail(-32015,'Callback verification failed',{reason:'connection_failed'})
     }
    let echo;try{echo=JSON.parse(response.body).challenge}catch{}
    if(response.status<200||response.status>=300||typeof echo!=='string'||!constantEqual(challenge,echo))fail(-32015,'Callback challenge rejected',{reason:'challenge_failed'});
    const item={id,owner,name:NAME,queue_id:queue,url:u.href,secret:delivery.secret,refreshBefore:new Date(Date.now()+ttl).toISOString(),cursor:null};
    const ix=subs.findIndex(s=>s.id===id);if(ix<0)subs.push(item);else subs[ix]=item;
    persist(dbFile,subs);
    return {id,refreshBefore:item.refreshBefore,cursor:null,truncated:false};
   }
   case 'events/unsubscribe':{
    if(params.name!==NAME||!params.arguments||typeof params.arguments.queue_id!=='string'||!params.delivery||params.delivery.mode!=='webhook')fail(-32602,'Invalid unsubscription');
    const u=validateUrl(params.delivery.url);
    const id=subscriptionId(u.href,params.arguments.queue_id);
    const prev=subs.length;subs=subs.filter(s=>s.id!==id);if(prev!==subs.length)persist(dbFile,subs);return {};
   }
   default:fail(-32601,'Method not found');
  }
 }
 async function publish({queue_id,job_id,created_at=new Date().toISOString()}){
  if(!allowCallbacks)throw Error('Delivery disabled');
  if(!/^[-_A-Za-z0-9]{1,64}$/.test(queue_id)||!/^[-_A-Za-z0-9]{1,128}$/.test(job_id))throw Error('Invalid job');
  prune();const event={eventId:'evt_'+crypto.randomUUID(),name:NAME,timestamp:new Date().toISOString(),data:{queue_id,job_id,status:'ready',created_at},cursor:null};
  const body=JSON.stringify(event);if(Buffer.byteLength(body)>256*1024)throw Error('Payload too large');
  const matched=subs.filter(s=>s.queue_id===queue_id&&s.owner===owner);
  const results=[];
  for(const sub of matched){try{const out=await transport(sub.url,body,signedHeaders(sub.secret,event.eventId,body,sub.id));results.push({id:sub.id,status:out.status,accepted:out.status>=200&&out.status<300})}catch{results.push({id:sub.id,accepted:false})}}
  return {eventId:event.eventId,matched:matched.length,results};
 }
 return {auth,handle,publish,list:()=>subs.map(s=>({id:s.id,queue_id:s.queue_id,refreshBefore:s.refreshBefore}))};
}
function tokenAt(directory){const f=path.join(directory,'gateway-token.key');if(!fs.existsSync(f)){fs.mkdirSync(directory,{recursive:true});fs.writeFileSync(f,crypto.randomBytes(32).toString('hex'),{mode:0o600,flag:'wx'})}return fs.readFileSync(f,'utf8').trim()}
export async function serve(){const dir=path.dirname(fileURLToPath(import.meta.url));const gateway=createGateway({dbFile:path.join(dir,'subscriptions.json'),token:tokenAt(dir),allowCallbacks:process.env.RELAY_EVENTS_ALLOW_CALLBACK_VERIFICATION==='1'});const server=http.createServer(async(req,res)=>{
 res.setHeader('cache-control','no-store');res.setHeader('x-content-type-options','nosniff');
 if(req.method==='GET'&&req.url==='/healthz'){res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({ok:true,localOnly:true,callbacksEnabled:process.env.RELAY_EVENTS_ALLOW_CALLBACK_VERIFICATION==='1',protocolVersion:VERSION}));return}
 if(req.method!=='POST'||req.url!=='/mcp'){res.writeHead(404).end();return}
 if(req.headers.origin){res.writeHead(403).end();return}
 if(!gateway.auth(req.headers.authorization)){res.writeHead(401,{'www-authenticate':'Bearer'}).end();return}
 if(Number(req.headers['content-length']||0)>32768){res.writeHead(413).end();return}
 let raw='';try{for await(const piece of req){raw+=piece;if(raw.length>32768)throw Error('Too large')}}catch{res.writeHead(413).end();return}
 let payload;try{payload=JSON.parse(raw)}catch{res.writeHead(400).end();return}
 const send=obj=>res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify(obj));
 if(!payload||payload.jsonrpc!=='2.0'||typeof payload.method!=='string'||payload.id===undefined||Array.isArray(payload)){send({jsonrpc:'2.0',id:payload?.id??null,error:{code:-32600,message:'Invalid request'}});return}
 const meta=payload.params?._meta;
 if(req.headers['mcp-protocol-version']!==VERSION||req.headers['mcp-method']!==payload.method||meta?.['io.modelcontextprotocol/protocolVersion']!==VERSION||!meta?.['io.modelcontextprotocol/clientCapabilities']||typeof meta['io.modelcontextprotocol/clientCapabilities']!=='object'){
  send({jsonrpc:'2.0',id:payload.id,error:{code:-32600,message:'MCP 2.0 protocol metadata and headers required'}});return;
 }
 try{const result=await gateway.handle(payload.method,payload.params);if(payload.method==='events/subscribe')process.stdout.write('EVENT_AUDIT gateway_subscribed '+new Date().toISOString()+'\n');send({jsonrpc:'2.0',id:payload.id,result})}
 catch(e){if(payload.method==='events/subscribe')process.stdout.write('EVENT_AUDIT gateway_rejected '+new Date().toISOString()+' code='+String(e.rpcCode||-32603)+' reason='+String(e.rpcData?.reason||'none')+'\n');send({jsonrpc:'2.0',id:payload.id,error:{code:e.rpcCode||-32603,message:e.rpcCode?e.message:'Internal error',...(e.rpcData?{data:e.rpcData}:{})}})}
 });server.listen(PORT,'127.0.0.1',()=>process.stdout.write('EVENTS_GATEWAY_LOCAL_READY '+PORT+'\n'));return server}
async function selfTest(){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'relay-events-test-'));const key='whsec_'+crypto.randomBytes(32).toString('base64');const token=crypto.randomBytes(32).toString('hex');let count=0;let bad=false;
 const transport=async(url,body,headers)=>{count++;assert.equal(url,'https://events.example.com/callback');assert.equal(headers['webhook-signature'].startsWith('v1,'),true);const expected='v1,'+crypto.createHmac('sha256',Buffer.from(key.slice(6),'base64')).update(headers['webhook-id']+'.'+headers['webhook-timestamp']+'.'+body).digest('base64');assert.equal(headers['webhook-signature'],expected);const obj=JSON.parse(body);return {status:200,body:JSON.stringify({challenge:bad?'bad':obj.challenge})}};
 try{const dbFile=path.join(dir,'db.json');const safe=createGateway({dbFile,token});assert.equal((await safe.handle('server/discover')).capabilities.events instanceof Object,true);assert.equal((await safe.handle('events/list')).events[0].name,NAME);assert.equal((await safe.handle('tools/list')).tools[0].name,'relay_events_status');await assert.rejects(safe.handle('events/subscribe',{}),e=>e.rpcCode===-32015);
  const g=createGateway({dbFile,token,transport,allowCallbacks:true});assert.equal(g.auth('Bearer '+token),true);assert.equal(g.auth('Bearer no'),false);
  const p={name:NAME,arguments:{queue_id:'test'},delivery:{mode:'webhook',url:'https://events.example.com/callback',secret:key}};
  const one=await g.handle('events/subscribe',p);assert.equal(g.list().length,1);
  const two=await g.handle('events/subscribe',p);assert.equal(one.id,two.id);assert.equal(g.list().length,1);
  bad=true;await assert.rejects(g.handle('events/subscribe',{...p,arguments:{queue_id:'other'}}),e=>e.rpcCode===-32015);bad=false;assert.equal(g.list().length,1);
  const loaded=createGateway({dbFile,token,transport,allowCallbacks:true});assert.equal(loaded.list().length,1);
  const none=await loaded.publish({queue_id:'nomatch',job_id:'job_1'});assert.equal(none.matched,0);
  const yes=await loaded.publish({queue_id:'test',job_id:'job_2'});assert.equal(yes.matched,1);assert.equal(yes.results[0].accepted,true);
  await loaded.handle('events/unsubscribe',{name:NAME,arguments:{queue_id:'test'},delivery:{mode:'webhook',url:p.delivery.url}});assert.equal(loaded.list().length,0);
  await loaded.handle('events/unsubscribe',{name:NAME,arguments:{queue_id:'test'},delivery:{mode:'webhook',url:p.delivery.url}});assert.equal(loaded.list().length,0);
  assert.throws(()=>validateUrl('http://127.0.0.1/cb'));assert.throws(()=>validateUrl('https://127.0.0.1/cb'));assert.equal(isPublicIPv4('192.168.0.1'),false);assert.equal(isPublicIPv4('8.8.8.8'),true);
  process.stdout.write('SELF_TEST_PASS discovery, auth, signed-challenge, idempotency, persistence, rejection, filter, delivery, unsubscribe, SSRF guards; mock transport only, callbackPosts='+count+'\n');
 }finally{fs.rmSync(dir,{force:true,recursive:true})}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){if(process.argv.includes('--self-test'))await selfTest();else await serve()}
