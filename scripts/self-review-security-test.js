#!/usr/bin/env node
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fs from "node:fs";import os from "node:os";import path from "node:path";import net from "node:net";import { spawn } from "node:child_process";
import { loadConfig } from "../src/config.js";
import { Store } from "../src/state.js";
import { resolvePinnedAddresses, pinnedRequest } from "../src/net-safe.js";

const ROOT=path.resolve(new URL("..",import.meta.url).pathname.replace(/^\/(.:)/,"$1"));
const TMP=fs.mkdtempSync(path.join(os.tmpdir(),"wjk-selfreview-"));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const free=()=>new Promise((resolve,reject)=>{const s=net.createServer();s.listen(0,"127.0.0.1",()=>{const p=s.address().port;s.close(()=>resolve(p));});s.on("error",reject);});
const clean=s=>{let x=String(s||"");if(x.startsWith("[UNTRUSTED DATA BOUNDARY]")){const i=x.indexOf("\n\n");x=i>=0?x.slice(i+2):"";}return x.split("\n\n───")[0];};
const results=[];
async function check(name,fn){try{await fn();results.push([name,true]);console.log("✅ "+name);}catch(e){results.push([name,false,String(e.message||e)]);console.log("❌ "+name+" — "+String(e.message||e));}}

const cfgPath=path.join(TMP,"cfg.json");fs.writeFileSync(cfgPath,JSON.stringify({roots:[TMP],browser:{allowPrivateNetwork:false},saas:{allowPrivateNetwork:false},permissions:{default:"allow",actions:{"fs.mutate":"ask","work.start":"ask","project.write":"ask","project.sync":"ask","task.write":"ask"}}},null,2));
const tr=new StdioClientTransport({command:process.execPath,args:[path.join(ROOT,"src","index.js"),"--stdio","--config",cfgPath],cwd:TMP});
const c=new Client({name:"selfreview-test",version:"1"});await c.connect(tr);
const call=async(name,args={})=>{const r=await c.callTool({name,arguments:args});return {isError:!!r.isError,text:r.content?.find(x=>x.type==="text")?.text||""};};

await check("prototype-key credential 차단",async()=>{const r=await call("credential_store",{name:"__proto__",secret:"x"});if(!r.isError)throw new Error("credential __proto__ accepted");});
await check("prototype-key SaaS/remote/DB 차단",async()=>{
  for(const [name,args] of [
    ["saas_register",{name:"constructor",base_url:"https://example.com",auth:"none"}],
    ["remote_register",{name:"toString",host:"example.com",user:"u"}],
    ["db_connect",{name:"__proto__",url:"sqlite:"+path.join(TMP,"x.db")}]
  ]){const r=await call(name,args);if(!r.isError)throw new Error(name+" dangerous key accepted");}
});
await check("credential broker ACL/self-test",async()=>{const r=await call("credential_self_test");if(r.isError)throw new Error(r.text);const j=JSON.parse(clean(r.text));if(!j.ok||j.aclHardened!==true)throw new Error(JSON.stringify(j));});
await check("socket-level DNS pinning private destination 차단",async()=>{
  let blocked=false;try{await resolvePinnedAddresses("127.0.0.1");}catch(e){blocked=String(e.message||e).includes("private/link-local");}
  if(!blocked)throw new Error("direct private address was not blocked");
  const p=await free(),server=net.createServer(sock=>sock.end("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok"));await new Promise(r=>server.listen(p,"127.0.0.1",r));
  try{const res=await pinnedRequest("http://127.0.0.1:"+p+"/",{allowLoopback:true,maxBytes:1024});if(!res.ok||res.body.toString()!=="ok"||res.pinnedAddresses[0]!=="127.0.0.1")throw new Error("pinned loopback request failed");}finally{server.close();}
});
await check("SaaS private-network SSRF default 차단",async()=>{
  let r=await call("saas_register",{name:"localblocked",base_url:"http://127.0.0.1:9",auth:"none"});if(r.isError)throw new Error("register should be allowed but guarded on request: "+r.text);
  r=await call("saas_request",{connection:"localblocked",path:"/x"});if(!r.isError||!r.text.toLowerCase().includes("private"))throw new Error("private request not blocked: "+r.text);
});
await check("OAuth 수동 code는 state 필수",async()=>{
  let r=await call("oauth_register_provider",{name:"mockmanual",authorization_url:"http://127.0.0.1:9/auth",token_url:"http://127.0.0.1:9/token",client_id:"c",token_auth_style:"none"});if(r.isError)throw new Error(r.text);
  r=await call("oauth_begin",{provider:"mockmanual"});if(r.isError)throw new Error(r.text);
  r=await call("oauth_finish",{provider:"mockmanual",code:"abc"});if(!r.isError||!r.text.includes("state"))throw new Error("manual code without state accepted");
  await call("oauth_disconnect",{provider:"mockmanual"});
});
await check("config prototype pollution key 차단",async()=>{
  const bad=path.join(TMP,"bad-config.json");fs.writeFileSync(bad,'{"roots":['+JSON.stringify(TMP)+'],"__proto__":{"polluted":true}}');
  let threw=false;try{loadConfig(bad);}catch(e){threw=String(e.message||e).includes("금지된 config key");}
  if(!threw)throw new Error("dangerous config key accepted");
});
await check("state forbidden-key 검증 + backup 복구",async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"wjk-state-validate-")),cf=path.join(root,"cfg.json");fs.writeFileSync(cf,JSON.stringify({roots:[root]}));
  try{const cfg=loadConfig(cf),s=new Store(cfg);s.save();s.data.notes.push("backup-ok");s.save();s.data.effort="high";s.save();fs.writeFileSync(path.join(cfg.stateDir,"state.json"),'{"__proto__":{"polluted":true}}');const recovered=new Store(cfg);if(!recovered.recoveredFromBackup||!recovered.data.notes.includes("backup-ok")||({}).polluted)throw new Error("invalid state was not safely recovered");}finally{try{fs.rmSync(root,{recursive:true,force:true})}catch{}}
});
await check("approval once exact-args fingerprint/replay 차단",async()=>{
  const p1=path.join(TMP,"approved-exact"),p2=path.join(TMP,"altered-target");
  let r=await call("fs_mkdir_rm_mv",{op:"mkdir",path:p1});const id=r.text.match(/approval_id=(a[0-9a-f]+)/)?.[1];if(!r.isError||!id)throw new Error("approval request missing");
  r=await call("approval_grant",{id,mode:"once"});if(r.isError)throw new Error(r.text);
  r=await call("fs_mkdir_rm_mv",{op:"mkdir",path:p2});if(!r.isError||fs.existsSync(p2))throw new Error("once grant reused with altered args");
  r=await call("fs_mkdir_rm_mv",{op:"mkdir",path:p1});if(r.isError||!fs.existsSync(p1))throw new Error("exact approved args rejected");
  r=await call("fs_mkdir_rm_mv",{op:"mkdir",path:p1});if(!r.isError)throw new Error("consumed once grant replayed");
});
await check("multi-action once transaction 단일 소비",async()=>{
  const args={title:"txn-once",kind:"local",project_name:"Txn Project",cwd:TMP,steps:[{title:"noop"}],auto_start:false};
  let r=await call("work_start",args);const id=r.text.match(/approval_id=(a[0-9a-f]+)/)?.[1];if(!r.isError||!id)throw new Error("transaction approval missing");
  r=await call("approval_grant",{id,mode:"once"});if(r.isError)throw new Error(r.text);
  r=await call("work_start",args);if(r.isError)throw new Error("approved transaction failed: "+r.text);
  const list=JSON.parse(clean((await call("approval_list")).text)),used=list.requests.find(x=>x.id===id);if(used?.status!=="consumed"||used.remainingActions?.length)throw new Error("transaction grant not fully consumed");
  r=await call("work_start",args);if(!r.isError)throw new Error("consumed transaction replayed");
});
await check("approval preview 원문 secret 비저장",async()=>{
  const secret="PREVIEW_SECRET_9f31b7",r=await call("work_start",{title:"preview-secret",kind:"cloud_http",http_url:"https://example.com",headers:{Authorization:"Bearer "+secret,"X-Test":"ok"},body:{secret}});
  const id=r.text.match(/approval_id=(a[0-9a-f]+)/)?.[1];if(!r.isError||!id)throw new Error("preview approval missing");
  const state=JSON.parse(fs.readFileSync(path.join(TMP,".webjjonku","state.json"),"utf8")),a=state.approvals.find(x=>x.id===id),raw=JSON.stringify(a?.preview||{});
  if(raw.includes(secret)||raw.includes('"secret":"'+secret+'"'))throw new Error("secret persisted in preview: "+raw);
});
await check("work sync signing secret preview/journal 비저장",async()=>{
  const secret="SYNC_SIGNING_VALUE_SHOULD_NOT_APPEAR_12345",r=await call("work_sync_configure",{profile_id:"signed-sec-test",signing_secret:secret,require_signature:true});
  const id=r.text.match(/approval_id=(a[0-9a-f]+)/)?.[1];if(!r.isError||!id)throw new Error("work sync approval missing");
  const state=JSON.parse(fs.readFileSync(path.join(TMP,".webjjonku","state.json"),"utf8")),a=state.approvals.find(x=>x.id===id),preview=JSON.stringify(a?.preview||{});
  const journal=fs.readFileSync(path.join(TMP,".webjjonku","journal.jsonl"),"utf8");
  if(preview.includes(secret)||journal.includes(secret))throw new Error("sync signing secret persisted in preview/journal");
  await call("approval_deny",{id});
});
await check("승인 루트 path traversal 차단",async()=>{
  const outside=path.join(path.dirname(TMP),"wjk-outside-"+process.pid+".txt");fs.writeFileSync(outside,"outside");
  try{const r=await call("fs_read",{path:outside});if(!r.isError)throw new Error("outside-root read accepted");}finally{try{fs.rmSync(outside,{force:true})}catch{}}
});

const port=await free(),data=path.join(TMP,"coord.json");
const coord=spawn(process.execPath,[path.join(ROOT,"scripts","coordinator-server.js"),"--port",String(port),"--lease-ms","120","--data",data,"--blob-dir",path.join(TMP,"blobs")],{cwd:ROOT,stdio:["ignore","pipe","pipe"],windowsHide:true});
for(let i=0;i<50;i++){try{if((await fetch("http://127.0.0.1:"+port+"/health")).ok)break}catch{}await sleep(100);}
const api=async(p,{method="GET",body,token}={})=>{const headers=body!==undefined?{"content-type":"application/json"}:{};if(token)headers.authorization="Bearer "+token;const r=await fetch("http://127.0.0.1:"+port+p,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});let j;try{j=await r.json()}catch{j=null}return {r,j};};

await check("coordinator expired lease completion race 차단",async()=>{
  await api("/v1/devices/heartbeat",{method:"POST",body:{deviceId:"dev1",capabilities:["device"]}});
  const {j:t}=await api("/v1/tasks",{method:"POST",body:{title:"lease-race",executor:"device",localRequired:false,targetDevice:"dev1",action:{type:"command",command:"echo x"}}});
  let x=await api("/v1/tasks/"+t.id+"/claim",{method:"POST",body:{deviceId:"dev1"}});if(x.r.status!==200)throw new Error("claim failed");
  await sleep(180);
  x=await api("/v1/tasks/"+t.id+"/complete",{method:"POST",body:{deviceId:"dev1",result:{ok:true}}});
  if(x.r.status!==409)throw new Error("expired lease complete accepted: "+x.r.status);
});
await check("coordinator public task 민감 action redaction",async()=>{
  const {j:t}=await api("/v1/tasks",{method:"POST",body:{title:"redact",executor:"device",localRequired:true,targetDevice:"offline",action:{type:"http",url:"https://example.com",headers:{Authorization:"Bearer topsecret",Cookie:"a=b"},body:{secret:"bodysecret"}}}});
  const {j:g}=await api("/v1/tasks/"+t.id);
  if(g.action?.headers?.Authorization!=="***"||g.action?.headers?.Cookie!=="***"||g.action?.body!=="<omitted>")throw new Error(JSON.stringify(g.action));
});
await check("browser executor capability 없는 device poll 차단",async()=>{
  await api("/v1/devices/heartbeat",{method:"POST",body:{deviceId:"plain",capabilities:["device"]}});
  const x=await api("/v1/poll?device_id=plain&executor=browser");if(x.r.status!==403)throw new Error("browser poll accepted: "+x.r.status);
});
await check("coordinator public bind 무인증 차단",async()=>{
  const p=await free(),child=spawn(process.execPath,[path.join(ROOT,"scripts","coordinator-server.js"),"--host","0.0.0.0","--port",String(p),"--data",path.join(TMP,"badcoord.json")],{cwd:ROOT,stdio:["ignore","pipe","pipe"],windowsHide:true});
  const code=await new Promise(resolve=>{const to=setTimeout(()=>{try{child.kill("SIGKILL")}catch{};resolve(null);},2500);child.on("close",c=>{clearTimeout(to);resolve(c);});});
  if(code===null||code===0)throw new Error("public unauth coordinator started");
});
await check("coordinator scoped token role/subject/rotate/revoke",async()=>{
  let x=await api("/v1/auth/tokens",{method:"POST",body:{id:"admin-test",role:"admin"}});
  if(x.r.status!==201||!x.j?.token)throw new Error("admin bootstrap token creation failed");const admin=x.j.token;
  x=await api("/v1/auth/tokens",{method:"POST",token:admin,body:{id:"worker-test",role:"browser-worker",subject:"bw1"}});if(x.r.status!==201||!x.j?.token)throw new Error("worker token creation failed");const old=x.j.token;
  x=await api("/health",{token:old});if(x.r.status!==403)throw new Error("browser-worker read scope escalation: "+x.r.status);
  x=await api("/v1/devices/heartbeat",{method:"POST",token:old,body:{deviceId:"bw1",capabilities:["cloud-browser"]}});if(x.r.status!==200)throw new Error("worker heartbeat denied");
  x=await api("/v1/devices/heartbeat",{method:"POST",token:old,body:{deviceId:"other",capabilities:["cloud-browser"]}});if(x.r.status!==403)throw new Error("worker subject mismatch accepted");
  x=await api("/v1/tasks",{method:"POST",token:old,body:{title:"nope",executor:"browser",localRequired:false,action:{type:"browser"}}});if(x.r.status!==403)throw new Error("worker submit scope escalation");
  x=await api("/v1/blobs/scoped-test",{method:"PUT",token:old,body:{x:1}});if(x.r.status!==200)throw new Error("worker blob write denied");
  x=await api("/v1/auth/tokens/worker-test/rotate",{method:"POST",token:admin,body:{}});if(x.r.status!==200||!x.j?.token)throw new Error("rotate failed");const fresh=x.j.token;
  x=await api("/v1/devices/heartbeat",{method:"POST",token:old,body:{deviceId:"bw1"}});if(x.r.status!==401)throw new Error("old rotated token still valid");
  x=await api("/v1/devices/heartbeat",{method:"POST",token:fresh,body:{deviceId:"bw1"}});if(x.r.status!==200)throw new Error("rotated token invalid");
  x=await api("/v1/auth/tokens/worker-test/revoke",{method:"POST",token:admin,body:{}});if(x.r.status!==200)throw new Error("revoke failed");
  x=await api("/v1/devices/heartbeat",{method:"POST",token:fresh,body:{deviceId:"bw1"}});if(x.r.status!==401)throw new Error("revoked token still valid");

  x=await api("/v1/auth/tokens",{method:"POST",token:admin,body:{id:"device-test",role:"device",subject:"devscope"}});if(x.r.status!==201||!x.j?.token)throw new Error("device token creation failed");const devToken=x.j.token;
  x=await api("/v1/devices/heartbeat",{method:"POST",token:devToken,body:{deviceId:"devscope",capabilities:["device"]}});if(x.r.status!==200)throw new Error("device heartbeat denied");
  x=await api("/v1/tasks",{method:"POST",token:devToken,body:{title:"device-cannot-submit",executor:"device",action:{type:"command",command:"echo no"}}});if(x.r.status!==403)throw new Error("device role retained submit scope");
  const own=(await api("/v1/tasks",{method:"POST",token:admin,body:{title:"own-task",executor:"device",targetDevice:"devscope",action:{type:"command",command:"echo own"}}})).j;
  const other=(await api("/v1/tasks",{method:"POST",token:admin,body:{title:"other-task",executor:"device",targetDevice:"otherdev",action:{type:"command",command:"echo other"}}})).j;
  x=await api("/v1/tasks/"+own.id,{token:devToken});if(x.r.status!==200)throw new Error("subject token cannot read own task");
  x=await api("/v1/tasks/"+other.id,{token:devToken});if(x.r.status!==403)throw new Error("subject token read other device task");
  x=await api("/v1/tasks?device_id=otherdev",{token:devToken});if(x.r.status!==403)throw new Error("subject token queried other device task list");
});
await check("coordinator state/blob AES-GCM at-rest envelope",async()=>{
  const raw=fs.readFileSync(data,"utf8"),j=JSON.parse(raw);
  if(j.format!=="wjk-state-aesgcm-v1"||!j.ciphertext||raw.includes("lease-race")||raw.includes("topsecret")||!fs.existsSync(data+".key"))throw new Error("coordinator state not encrypted at rest");
  const blobFiles=fs.readdirSync(path.join(TMP,"blobs")).filter(x=>x.endsWith(".blob"));
  if(!blobFiles.length)throw new Error("encrypted blob fixture missing");
  const br=fs.readFileSync(path.join(TMP,"blobs",blobFiles[0]),"utf8"),bj=JSON.parse(br);
  if(bj.format!=="wjk-blob-aesgcm-v1"||br.includes('{"x":1}'))throw new Error("coordinator blob not encrypted at rest");
});

try{coord.kill("SIGKILL")}catch{};await c.close();
const failed=results.filter(x=>!x[1]);console.log("\n"+JSON.stringify({passed:results.length-failed.length,total:results.length,failed},null,2));
try{fs.rmSync(TMP,{recursive:true,force:true})}catch{}
if(failed.length)process.exit(1);
