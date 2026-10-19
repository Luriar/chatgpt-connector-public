// OAuth 2.1 resource-server facade for the local MCP Events prototype.
// Fail-closed: no public binding, no login/password handling, no event producer.
// Requires an independently configured, trusted OAuth authorization server.
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';

const ROOT=path.dirname(fileURLToPath(import.meta.url));
const JSON_HEADERS={'cache-control':'no-store','content-type':'application/json','x-content-type-options':'nosniff'};
const PERMISSIONS={read:'relay:events.read',subscribe:'relay:events.subscribe'};
function nonempty(s){return typeof s==='string' && s.trim().length>0;}
function config(env=process.env){
 const c={
  issuer:env.RELAY_OAUTH_ISSUER,
  jwks:env.RELAY_OAUTH_JWKS_URI,
  resource:env.RELAY_OAUTH_RESOURCE,
  allowedSub:env.RELAY_OAUTH_ALLOWED_SUB,
  port:Number(env.RELAY_OAUTH_PORT||18795),
  localPort:Number(env.RELAY_EVENTS_PORT||18794)
 };
 for(const field of ['issuer','jwks','resource','allowedSub'])if(!nonempty(c[field]))throw Error('Missing '+field+'; proxy NOT started');
 for(const field of ['issuer','jwks','resource']){
  const u=new URL(c[field]);
  if(u.protocol!=='https:'||u.username||u.password||u.hash||u.port&&u.port!=='443')throw Error('Invalid public HTTPS '+field);
 }
 if(!Number.isSafeInteger(c.port)||c.port<1024||c.port>65535||!Number.isSafeInteger(c.localPort)||c.localPort<1024||c.localPort>65535)throw Error('Invalid ports');
 return c;
}
function json(res,status,obj,more={}){
 res.writeHead(status,{...JSON_HEADERS,...more});res.end(JSON.stringify(obj));
}
function resourceMetadata(c){
 return {resource:c.resource,authorization_servers:[c.issuer],scopes_supported:Object.values(PERMISSIONS)};
}
function metadataUrl(c){const u=new URL(c.resource);return u.origin+'/.well-known/oauth-protected-resource'+u.pathname;}
function deny(res,c,status=401){
 res.writeHead(status,{...JSON_HEADERS,'www-authenticate':'Bearer resource_metadata="'+metadataUrl(c)+'", scope="'+Object.values(PERMISSIONS).join(' ')+'"'});res.end(JSON.stringify({error:status===403?'insufficient_scope':'unauthorized'}));
}
function jwtSegments(token){
 if(typeof token!=='string'||token.length>12000)throw Error('Malformed access token');
 const parts=token.split('.');
 if(parts.length!==3||parts.some(p=>!p||!/^[-_A-Za-z0-9]+$/.test(p)))throw Error('Malformed access token');
 let header,payload;
 try{
  header=JSON.parse(Buffer.from(parts[0],'base64url').toString('utf8'));
  payload=JSON.parse(Buffer.from(parts[1],'base64url').toString('utf8'));
 }catch{throw Error('Invalid JWT JSON')}
 if(!header||header.alg!=='RS256'||typeof header.kid!=='string'||header.kid.length>255||!payload||typeof payload!=='object')throw Error('Unsupported access token');
 return {header,payload,parts};
}
export function verifyJwt(token,c,jwks,required=PERMISSIONS.read,now=Math.floor(Date.now()/1000)){
 const {header,payload,parts}=jwtSegments(token);
 const key=jwks?.keys?.find(x=>x.kid===header.kid&&x.kty==='RSA'&&x.use!=='enc'&&(x.alg===undefined||x.alg==='RS256'));
 if(!key)throw Error('Key not found');
 const publicKey=crypto.createPublicKey({key,format:'jwk'});
 if(!crypto.verify('RSA-SHA256',Buffer.from(parts[0]+'.'+parts[1]),publicKey,Buffer.from(parts[2],'base64url')))throw Error('Invalid signature');
 if(payload.iss!==c.issuer||!(Array.isArray(payload.aud)?payload.aud.includes(c.resource):payload.aud===c.resource))throw Error('Invalid audience/issuer');
 if(payload.sub!==c.allowedSub||!nonempty(payload.sub))throw Error('Unauthorized subject');
 if(!Number.isSafeInteger(payload.exp)||payload.exp<=now-30||payload.exp>now+86400)throw Error('Expired or excessive token lifetime');
 if(payload.nbf!==undefined&&(!Number.isSafeInteger(payload.nbf)||payload.nbf>now+30))throw Error('Token not yet valid');
 if(payload.iat!==undefined&&(!Number.isSafeInteger(payload.iat)||payload.iat>now+30))throw Error('Invalid issue time');
 const permissions=new Set((typeof payload.scope==='string'?payload.scope:'').split(/\s+/).filter(Boolean));
 if(!permissions.has(required))throw Error('Insufficient scope');
 if(!Array.isArray(payload.permissions)||!payload.permissions.includes(required))throw Error('Missing RBAC permission');
 return {sub:payload.sub,scopes:[...permissions]};
}
function fetchJwks(url){
 return new Promise((resolve,reject)=>{
  const req=https.get(url,{timeout:5000,headers:{accept:'application/json'},maxRedirects:0},res=>{
   if(res.statusCode!==200){res.resume();reject(Error('JWKS HTTP failure'));return}
   let raw='';
   res.setEncoding('utf8');
   res.on('data',s=>{raw+=s;if(raw.length>65536)req.destroy(Error('JWKS too large'))});
   res.on('end',()=>{try{const doc=JSON.parse(raw);if(!Array.isArray(doc.keys))throw Error('Invalid JWKS');resolve(doc)}catch(e){reject(e)}});
  });
  req.on('timeout',()=>req.destroy(Error('JWKS timeout')));
  req.on('error',reject);
 });
}
export function createAdapter(c,{getJwks=()=>fetchJwks(c.jwks),readInternalToken=()=>fs.readFileSync(path.join(ROOT,'gateway-token.key'),'utf8').trim()}={}){
 let cache=null;let cachedUntil=0;
 const keys=async()=>{
  if(cache&&Date.now()<cachedUntil)return cache;
  const doc=await getJwks();
  if(!Array.isArray(doc.keys))throw Error('Invalid keys');
  cache=doc;cachedUntil=Date.now()+120000;return cache;
 };
 return http.createServer(async(req,res)=>{
  res.setHeader('cache-control','no-store');
  if(req.method==='GET'&&(req.url==='/'||req.url==='/.well-known/oauth-protected-resource'||req.url==='/relay-events/.well-known/oauth-protected-resource'||req.url==='/'+new URL(c.resource).pathname.replace(/^\/+/, '')+'/.well-known/oauth-protected-resource'||req.url===new URL(metadataUrl(c)).pathname)){
   json(res,200,resourceMetadata(c));return;
  }
  if(req.method==='GET'&&req.url==='/healthz'){
   json(res,200,{ok:true,mode:'oauth-facade',configured:true,localOnly:true,eventProducer:false,callbackDelivery:false});return;
  }
  if(!['/mcp','/relay-events/mcp','/'].includes(req.url)||req.method!=='POST'){json(res,404,{error:'not_found'});return;}
  if(req.headers.origin){json(res,403,{error:'origin_not_allowed'});return;}
  const match=/^Bearer ([A-Za-z0-9_.-]+)$/.exec(req.headers.authorization||'');
  if(!match){deny(res,c);return}
  let raw='';
  try{for await(const chunk of req){raw+=chunk;if(raw.length>32768)throw Error('Too large')}}catch{json(res,413,{error:'too_large'});return}
  let body;
  try{body=JSON.parse(raw)}catch{json(res,400,{error:'invalid_json'});return}
  const method=body?.method;
  if(method==='events/subscribe')process.stdout.write('EVENT_AUDIT oauth_received '+new Date().toISOString()+'\n');
  if(typeof method!=='string'||!['server/discover','events/list','events/subscribe','events/unsubscribe','initialize','notifications/initialized','tools/list','tools/call'].includes(method)){json(res,400,{error:'unknown_method'});return}
  const required=method==='events/subscribe'||method==='events/unsubscribe'?PERMISSIONS.subscribe:PERMISSIONS.read;
  let verified=false;
  try{verifyJwt(match[1],c,await keys(),required);verified=true}catch{}
  if(!verified){if(method==='events/subscribe')process.stdout.write('EVENT_AUDIT oauth_auth_rejected '+new Date().toISOString()+'\n');deny(res,c);return}
  if(method==='events/subscribe')process.stdout.write('EVENT_AUDIT oauth_auth_accepted '+new Date().toISOString()+'\n');
  // Legacy Streamable HTTP compatibility: read-only status only; no event actions.
  const legacy=method==='initialize'||method==='notifications/initialized'||body.params?._meta?.['io.modelcontextprotocol/protocolVersion']!=='2026-07-28';
  if(legacy&&method==='initialize'){
    const supported=['2025-03-26','2025-06-18','2025-11-25'];
    const requested=body.params?.protocolVersion;
    const version=supported.includes(requested)?requested:'2025-11-25';
    json(res,200,{jsonrpc:'2.0',id:body.id,result:{protocolVersion:version,capabilities:{tools:{listChanged:false}},serverInfo:{name:'relay-events-readonly-compat',version:'0.1.1'}}});
    return;
  }
  if(legacy&&method==='notifications/initialized'){res.writeHead(202,{'cache-control':'no-store'});res.end();return;}
  if(legacy&&method==='tools/list'){
    json(res,200,{jsonrpc:'2.0',id:body.id,result:{tools:[{name:'relay_events_status',title:'Relay Events Gateway Status',description:'Read-only gateway health and event-delivery state; does not subscribe, publish, or call models.',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false}}]}});
    return;
  }
  if(legacy&&method==='tools/call'){
    if(body.params?.name!=='relay_events_status'||!body.params.arguments||Object.keys(body.params.arguments).length!==0){json(res,200,{jsonrpc:'2.0',id:body.id,error:{code:-32602,message:'Only read-only relay_events_status with empty arguments is allowed'}});return}
    try{
      const health=await new Promise((resolve,reject)=>{
        const req=http.get({hostname:'127.0.0.1',port:c.localPort,path:'/healthz',timeout:3000},back=>{
          if(back.statusCode!==200){back.resume();reject(Error('Local gateway unavailable'));return}
          let raw='';back.setEncoding('utf8');
          back.on('data',x=>{raw+=x;if(raw.length>8192)req.destroy(Error('Gateway health too large'))});
          back.on('end',()=>{try{resolve(JSON.parse(raw))}catch(e){reject(e)}});
        });
        req.on('timeout',()=>req.destroy(Error('Gateway health timeout')));
        req.on('error',reject);
      });
      if(health.ok!==true||health.localOnly!==true||typeof health.callbacksEnabled!=='boolean')throw Error('Unsafe gateway health state');
      const status={ok:true,event:'relay.job.ready',localOnly:true,callbacksEnabled:health.callbacksEnabled,modelCalls:false,subscriptionsNotQueried:true};
      json(res,200,{jsonrpc:'2.0',id:body.id,result:{content:[{type:'text',text:JSON.stringify(status)}],isError:false}});
    }catch{json(res,503,{error:'backend_unavailable'})}
    return;
  }
  let internalToken;try{internalToken=readInternalToken();if(internalToken.length<32)throw Error('Invalid local token')}catch{json(res,503,{error:'backend_unavailable'});return}
  const headers={
   'content-type':'application/json',
   'accept':'application/json',
   'mcp-method':method,
   'mcp-protocol-version':req.headers['mcp-protocol-version']||'',
   'authorization':'Bearer '+internalToken
  };
  if(req.headers['mcp-name'])headers['mcp-name']=req.headers['mcp-name'];
  const outgoing=http.request({hostname:'127.0.0.1',port:c.localPort,path:'/mcp',method:'POST',headers,timeout:5000},back=>{
   res.writeHead(back.statusCode||502,{'content-type':'application/json','cache-control':'no-store'});
   back.pipe(res);
  });
  outgoing.on('timeout',()=>outgoing.destroy(Error('Backend timeout')));
  outgoing.on('error',()=>{if(!res.headersSent)json(res,502,{error:'backend_unavailable'});else res.destroy()});
  outgoing.end(raw);
 });
}
async function selfTest(){
 const pair=crypto.generateKeyPairSync('rsa',{modulusLength:2048});
 const jwk=pair.publicKey.export({format:'jwk'});jwk.kid='test-key';jwk.use='sig';jwk.alg='RS256';
 const c={issuer:'https://issuer.example.com/',resource:'https://relay.example.com/relay-events/mcp',allowedSub:'account-1'};
 const now=Math.floor(Date.now()/1000);
 const base={iss:c.issuer,aud:c.resource,sub:c.allowedSub,iat:now,exp:now+900,scope:'relay:events.read relay:events.subscribe',permissions:['relay:events.read','relay:events.subscribe']};
 const encode=x=>Buffer.from(JSON.stringify(x)).toString('base64url');
 const sign=(claims=base)=>{const prefix=encode({alg:'RS256',kid:'test-key',typ:'JWT'})+'.'+encode(claims);return prefix+'.'+crypto.sign('RSA-SHA256',Buffer.from(prefix),pair.privateKey).toString('base64url')};
 const testToken=sign();
 assert.equal(verifyJwt(testToken,c,{keys:[jwk]}).sub,'account-1');
 assert.equal(verifyJwt(testToken,c,{keys:[jwk]},PERMISSIONS.subscribe).sub,'account-1');
 for(const claims of [{...base,aud:'other'},{...base,iss:'https://wrong/'},{...base,sub:'account-2'},{...base,scope:'relay:events.read'},{...base,permissions:['relay:events.read']},{...base,permissions:[]},{...base,exp:now-60}]){
  assert.throws(()=>verifyJwt(sign(claims),c,{keys:[jwk]},PERMISSIONS.subscribe));
 }
 assert.throws(()=>verifyJwt('none.'+testToken.split('.').slice(1).join('.'),c,{keys:[jwk]}));
 assert.throws(()=>config({}));
 assert.deepEqual(resourceMetadata(c).authorization_servers,[c.issuer]);
 const server=createAdapter({...c,jwks:'https://issuer.example.com/keys'},{getJwks:async()=>({keys:[jwk]}),readInternalToken:()=> 'temporary-local-test-token-more-than-32-chars'});
 await new Promise(ok=>server.listen(0,'127.0.0.1',ok));
 const port=server.address().port;
 try{
  const get=(path,token)=>new Promise((resolve,reject)=>{
   const req=http.request({hostname:'127.0.0.1',port,path,method:path==='/mcp'?'POST':'GET',headers:token?{authorization:'Bearer '+token}:{}},res=>{let s='';res.on('data',b=>s+=b);res.on('end',()=>resolve({status:res.statusCode,body:s,headers:res.headers}))});
   req.on('error',reject);req.end(path==='/mcp'?'{}':'');
  });
  const md=await get('/.well-known/oauth-protected-resource');
  const exactMd=await get('/.well-known/oauth-protected-resource/relay-events/mcp');
  assert.equal(exactMd.status,200);
  assert.equal(md.status,200);assert.equal(JSON.parse(md.body).resource,c.resource);
  const denied=await get('/mcp');
  assert.equal(denied.status,401);
  assert.match(denied.headers['www-authenticate'],/resource_metadata=/);
  const compatibilityProbe=(method,params)=>new Promise((resolve,reject)=>{
    const body=JSON.stringify({jsonrpc:'2.0',id:71,method,params});
    const req=http.request({hostname:'127.0.0.1',port,path:'/mcp',method:'POST',headers:{authorization:'Bearer '+testToken,'content-type':'application/json'}},res=>{
      let str='';res.on('data',chunk=>str+=chunk);res.on('end',()=>{try{resolve({status:res.statusCode,body:JSON.parse(str)})}catch(e){reject(e)}})
    });req.on('error',reject);req.end(body)
  });
  const initializer=await compatibilityProbe('initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'diagnostic',version:'1'},_meta:{'io.modelcontextprotocol/protocolVersion':'2025-11-25'}});
  assert.equal(initializer.status,200);
  assert.equal(initializer.body.result.protocolVersion,'2025-11-25');
  const listed=await compatibilityProbe('tools/list',{_meta:{'io.modelcontextprotocol/protocolVersion':'2025-11-25'}});
  assert.equal(listed.status,200);
  assert.equal(listed.body.result.tools[0].name,'relay_events_status');
  const forbidden=await compatibilityProbe('tools/call',{name:'events/subscribe',arguments:{},_meta:{'io.modelcontextprotocol/protocolVersion':'2025-11-25'}});
  assert.equal(forbidden.body.error.code,-32602);
  process.stdout.write('LEGACY_META_TEST_PASS initialize, tool discovery, non-status rejection\n');
  const wrong=await get('/mcp',sign({...base,sub:'other'}));assert.equal(wrong.status,400); // malformed request must not be passed
  process.stdout.write('OAUTH_FACADE_SELF_TEST_PASS JWT-RS256 signature, iss/aud/sub, expiration, scopes, metadata, noauth challenge; no network callbacks or provider login\n');
 }finally{await new Promise(done=>server.close(done))}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 if(process.argv.includes('--self-test'))await selfTest();
 else {
  const c=config();
  const server=createAdapter(c);
  server.listen(c.port,'127.0.0.1',()=>process.stdout.write('RELAY_OAUTH_LOCAL_FACADE_READY '+c.port+'\n'));
 }
}
