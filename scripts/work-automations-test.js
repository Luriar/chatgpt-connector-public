#!/usr/bin/env node
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fs from "node:fs";import os from "node:os";import path from "node:path";import net from "node:net";import http from "node:http";import { spawn } from "node:child_process";
const ROOT=path.resolve(new URL("..",import.meta.url).pathname.replace(/^\/(.:)/,"$1")),TMP=fs.mkdtempSync(path.join(os.tmpdir(),"wjk-auto-"));
const free=()=>new Promise((resolve,reject)=>{const s=net.createServer();s.listen(0,"127.0.0.1",()=>{const p=s.address().port;s.close(()=>resolve(p));});s.on("error",reject);});
const coordPort=await free(),targetPort=await free();let hits=0;
const target=http.createServer((req,res)=>{hits++;res.writeHead(200,{"content-type":"application/json"});res.end(JSON.stringify({ok:true,path:req.url,hits}));});await new Promise(r=>target.listen(targetPort,"127.0.0.1",r));
const coord=spawn(process.execPath,[path.join(ROOT,"scripts","coordinator-server.js"),"--port",String(coordPort),"--data",path.join(TMP,"state.json"),"--blob-dir",path.join(TMP,"blobs"),"--allow-private-http"],{cwd:ROOT,stdio:"ignore",windowsHide:true});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));for(let i=0;i<50;i++){try{if((await fetch("http://127.0.0.1:"+coordPort+"/health")).ok)break}catch{}await sleep(100);}
const cfg=path.join(TMP,"cfg.json");fs.writeFileSync(cfg,JSON.stringify({roots:[TMP]},null,2));
const tr=new StdioClientTransport({command:process.execPath,args:[path.join(ROOT,"src","index.js"),"--stdio","--config",cfg],cwd:TMP}),c=new Client({name:"auto-test",version:"1"});await c.connect(tr);
const clean=s=>{let x=String(s||"");if(x.startsWith("[UNTRUSTED DATA BOUNDARY]")){const i=x.indexOf("\n\n");x=i>=0?x.slice(i+2):"";}return x.split("\n\n───")[0];};
const call=async(name,args={})=>{const r=await c.callTool({name,arguments:args});return {isError:!!r.isError,text:r.content?.find(x=>x.type==="text")?.text||""};};
await call("coordinator_configure",{url:"http://127.0.0.1:"+coordPort,device_id:"auto-device"});
const at=new Date(Date.now()+1600).toISOString();
const sch=await call("cloud_schedule_add_at",{name:"scheduled-cloud",at,task:{title:"scheduled-cloud-task",executor:"cloud",local_required:false,action:{type:"http",url:"http://127.0.0.1:"+targetPort+"/scheduled",method:"GET"}}});
if(sch.isError)throw new Error("schedule add: "+sch.text);const sid=JSON.parse(clean(sch.text)).id;
let scheduledNote=null;for(let i=0;i<30;i++){await sleep(300);const rows=JSON.parse(clean((await call("work_notifications",{limit:50})).text));scheduledNote=rows.find(n=>n.title==="scheduled-cloud-task"&&n.type==="task.succeeded");if(scheduledNote)break;}
if(!scheduledNote||hits<1)throw new Error("scheduled task notification missing");
const wh=await call("work_webhook_create",{name:"incoming-event",task:{title:"webhook-cloud-task",executor:"cloud",local_required:false,action:{type:"http",url:"http://127.0.0.1:"+targetPort+"/webhook",method:"GET"}}});
if(wh.isError)throw new Error("webhook create: "+wh.text);const wj=JSON.parse(clean(wh.text));
const hookRes=await fetch(wj.hookUrl,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({event:"demo"})});if(hookRes.status!==202)throw new Error("hook status "+hookRes.status);
let webhookNote=null;for(let i=0;i<30;i++){await sleep(250);const rows=JSON.parse(clean((await call("work_notifications",{unread_only:true,limit:50})).text));webhookNote=rows.find(n=>n.title==="webhook-cloud-task"&&n.type==="task.succeeded");if(webhookNote)break;}
if(!webhookNote||hits<2)throw new Error("webhook task notification missing");
await call("work_notification_read",{id:webhookNote.id});
const unread=JSON.parse(clean((await call("work_notifications",{unread_only:true,limit:50})).text));if(unread.some(n=>n.id===webhookNote.id))throw new Error("read state failed");
await call("cloud_schedule_action",{id:sid,action:"remove"});await call("work_webhook_action",{id:wj.id,action:"remove"});
console.log(JSON.stringify({ok:true,scheduleNotification:scheduledNote.id,webhookNotification:webhookNote.id,hits},null,2));
await c.close();try{coord.kill("SIGKILL")}catch{};await new Promise(r=>target.close(r));try{fs.rmSync(TMP,{recursive:true,force:true})}catch{}
