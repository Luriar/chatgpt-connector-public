#!/usr/bin/env node
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fs from "node:fs";import os from "node:os";import path from "node:path";import net from "node:net";import { spawn } from "node:child_process";
const ROOT=path.resolve(new URL("..",import.meta.url).pathname.replace(/^\/(.:)/,"$1"));
const TMP=fs.mkdtempSync(path.join(os.tmpdir(),"wjk-sync-"));
const d1=path.join(TMP,"dev1"),d2=path.join(TMP,"dev2"),SYNC_SECRET="sync-test-shared-key-2026-09-24";fs.mkdirSync(d1);fs.mkdirSync(d2);
const free=()=>new Promise((resolve,reject)=>{const s=net.createServer();s.listen(0,"127.0.0.1",()=>{const p=s.address().port;s.close(()=>resolve(p));});s.on("error",reject);});
const port=await free(),coord=spawn(process.execPath,[path.join(ROOT,"scripts","coordinator-server.js"),"--port",String(port),"--data",path.join(TMP,"coord.json"),"--blob-dir",path.join(TMP,"blobs")],{cwd:TMP,stdio:"ignore",windowsHide:true});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));for(let i=0;i<40;i++){try{if((await fetch("http://127.0.0.1:"+port+"/health")).ok)break}catch{}await sleep(100);}
async function mk(root,id){
 const cfg=path.join(root,"cfg.json");fs.writeFileSync(cfg,JSON.stringify({roots:[root],http:{host:"127.0.0.1",port:0}},null,2));
 const tr=new StdioClientTransport({command:process.execPath,args:[path.join(ROOT,"src","index.js"),"--stdio","--config",cfg],cwd:root});
 const c=new Client({name:id,version:"1"});await c.connect(tr);
 const call=async(name,args={})=>{const r=await c.callTool({name,arguments:args});return {isError:!!r.isError,text:r.content?.find(x=>x.type==="text")?.text||""};};
 await call("coordinator_configure",{url:"http://127.0.0.1:"+port,device_id:id});
 await call("work_sync_configure",{profile_id:"shared-profile",signing_secret:SYNC_SECRET,require_signature:true});
 return {c,call};
}
const clean=s=>{let x=String(s||"");if(x.startsWith("[UNTRUSTED DATA BOUNDARY]")){const i=x.indexOf("\n\n");x=i>=0?x.slice(i+2):"";}return x.split("\n\n───")[0];};
const a=await mk(d1,"device-one"),b=await mk(d2,"device-two");
await a.call("session_save",{note:"cross-device-note",tags:["sync"]});
await a.call("goal_set",{title:"Cross Device Goal",steps:["first","second"],done_criteria:"done"});
await a.call("session_compact",{extra:"handoff-from-device-one"});
const tc=await a.call("task_create",{title:"portable paused task",steps:[{title:"echo",command:"echo synced"}],auto_start:false});if(tc.isError)throw new Error(tc.text);
const push=await a.call("work_sync_push",{});if(push.isError)throw new Error("push: "+push.text);const pushJson=JSON.parse(clean(push.text));if(pushJson.signed!==true)throw new Error("sync push was not signed");
const pull=await b.call("work_sync_pull",{});if(pull.isError)throw new Error("pull: "+pull.text);const pullJson=JSON.parse(clean(pull.text));if(pullJson.signatureVerified!==true)throw new Error("sync signature was not verified");
const badPayload=Buffer.from(JSON.stringify({schema:1,profileId:"shared-profile",goal:null,notes:[],sessions:[],taskShadows:{}})).toString("base64");
const tamper=JSON.stringify({format:"wjk-work-sync-hmac-v1",profileId:"shared-profile",payload:badPayload,hmac:"invalid-signature"});
let tr=await fetch("http://127.0.0.1:"+port+"/v1/blobs/workstate_shared-profile",{method:"PUT",headers:{"content-type":"application/json"},body:tamper});if(!tr.ok)throw new Error("tamper fixture write failed");
const rejected=await b.call("work_sync_pull",{});if(!rejected.isError||!rejected.text.toLowerCase().includes("signature"))throw new Error("tampered sync manifest was accepted");
const restore=await a.call("work_sync_push",{force:true});if(restore.isError)throw new Error("restore push: "+restore.text);
const resume=await b.call("work_resume",{});if(resume.isError)throw new Error("resume: "+resume.text);
const j=JSON.parse(clean(resume.text));if(j.goal!==null)throw new Error("remote goal auto-activated unexpectedly");if(j.remoteGoalCandidate?.title!=="Cross Device Goal")throw new Error("remote goal candidate missing");if(!j.latestHandoff?.content?.includes("handoff-from-device-one"))throw new Error("handoff not synced");if(!j.syncedTaskShadows?.some(x=>x.title==="portable paused task"))throw new Error("task shadow missing");
const activate=await b.call("work_sync_pull",{goal_strategy:"remote",confirm_remote_title:"Cross Device Goal"});if(activate.isError)throw new Error("goal activate: "+activate.text);
const resumed2=JSON.parse(clean((await b.call("work_resume",{})).text));if(resumed2.goal?.title!=="Cross Device Goal")throw new Error("confirmed remote goal not activated");
const shadows=JSON.parse(clean((await b.call("work_task_shadows",{})).text));const id=Object.keys(shadows)[0];const adopt=await b.call("work_task_adopt",{id,cwd:d2});if(adopt.isError)throw new Error("adopt: "+adopt.text);const adopted=JSON.parse(clean(adopt.text));if(adopted.status!=="paused"||adopted.cwd!==d2||adopted.remoteQuarantined!==true)throw new Error("adopt quarantine invalid");
console.log(JSON.stringify({ok:true,cloudVersion:JSON.parse(clean(push.text)).cloudVersion,goal:resumed2.goal.title,candidateFirst:true,handoff:true,shadowCount:j.syncedTaskShadows.length,adoptedId:adopted.id,quarantined:true},null,2));
await a.c.close();await b.c.close();try{coord.kill("SIGKILL")}catch{};try{fs.rmSync(TMP,{recursive:true,force:true})}catch{}
