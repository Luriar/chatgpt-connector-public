#!/usr/bin/env node
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fs from "node:fs";import os from "node:os";import path from "node:path";
const ROOT=path.resolve(new URL("..",import.meta.url).pathname.replace(/^\/(.:)/,"$1")),TMP=fs.mkdtempSync(path.join(os.tmpdir(),"wjk-policy-"));
const cfg=path.join(TMP,"cfg.json");fs.writeFileSync(cfg,JSON.stringify({roots:[TMP],permissions:{default:"allow",actions:{"exec.command":"ask"}}},null,2));
const tr=new StdioClientTransport({command:process.execPath,args:[path.join(ROOT,"src","index.js"),"--stdio","--config",cfg],cwd:TMP}),c=new Client({name:"policy-test",version:"1"});await c.connect(tr);
const clean=s=>{let x=String(s||"");if(x.startsWith("[UNTRUSTED DATA BOUNDARY]")){const i=x.indexOf("\n\n");x=i>=0?x.slice(i+2):"";}return x.split("\n\n───")[0];};const call=async(name,args={})=>{const r=await c.callTool({name,arguments:args});return {isError:!!r.isError,text:r.content?.find(x=>x.type==="text")?.text||""};};
const marker=path.join(TMP,"approved.txt"),command=process.platform==="win32"?'Set-Content -Path "'+marker+'" -Value approved':'printf approved > "'+marker+'"';
const create=await call("task_create",{title:"approval-bound-task",steps:[{title:"write marker",command}],auto_start:true});if(create.isError)throw new Error(create.text);const tid=JSON.parse(clean(create.text)).id;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));let paused=null;for(let i=0;i<20;i++){await sleep(250);const s=JSON.parse(clean((await call("task_status",{id:tid})).text));if(s.status==="paused"&&String(s.error||"").includes("approval_id=")){paused=s;break;}}if(!paused)throw new Error("task did not pause for approval");if(fs.existsSync(marker))throw new Error("command executed before approval");
const list=JSON.parse(clean((await call("approval_list",{})).text));const req=[...list.requests].reverse().find(x=>x.status==="pending"&&(x.actions||[]).includes("exec.command")&&x.tool==="task_runtime");if(!req)throw new Error("runtime approval missing");
const grant=await call("approval_grant",{id:req.id,mode:"once"});if(grant.isError)throw new Error(grant.text);await call("task_resume",{id:tid});
let done=null;for(let i=0;i<30;i++){await sleep(250);const s=JSON.parse(clean((await call("task_status",{id:tid})).text));if(["succeeded","failed"].includes(s.status)){done=s;break;}}if(!done||done.status!=="succeeded")throw new Error("task did not complete after approval: "+JSON.stringify(done));if(!fs.existsSync(marker)||!fs.readFileSync(marker,"utf8").includes("approved"))throw new Error("approved command result missing");
const after=JSON.parse(clean((await call("approval_list",{})).text));const used=after.requests.find(x=>x.id===req.id);if(used?.status!=="consumed")throw new Error("once grant not consumed");
console.log(JSON.stringify({ok:true,taskId:tid,approvalId:req.id,beforeApproval:"blocked",afterApproval:done.status,grantStatus:used.status},null,2));
await c.close();try{fs.rmSync(TMP,{recursive:true,force:true})}catch{}
