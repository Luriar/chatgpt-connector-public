#!/usr/bin/env node
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT=path.resolve(new URL("..",import.meta.url).pathname.replace(/^\/(.:)/,"$1"));
const TMP=fs.mkdtempSync(path.join(os.tmpdir(),"wjk-scheduler-"));
const cfg=path.join(TMP,"cfg.json"),marker=path.join(TMP,"marker.txt");
fs.writeFileSync(cfg,JSON.stringify({roots:[TMP],permissions:{default:"allow"}},null,2));

async function mk(name){
  const tr=new StdioClientTransport({command:process.execPath,args:[path.join(ROOT,"src","index.js"),"--stdio","--config",cfg],cwd:TMP});
  const c=new Client({name,version:"1"});await c.connect(tr);
  const call=async(n,a={})=>{const r=await c.callTool({name:n,arguments:a});return {isError:!!r.isError,text:r.content?.find(x=>x.type==="text")?.text||""};};
  return {c,call};
}
const clean=s=>String(s||"").split("\n\n───")[0];
const cmd=process.platform==="win32"?`Start-Sleep -Milliseconds 1200; Add-Content -LiteralPath '${marker.replace(/'/g,"''")}' -Value x`:`sleep 1.2; printf 'x\\n' >> '${marker.replace(/'/g,"'\\''")}'`;

const a=await mk("scheduler-a");
let r=await a.call("schedule_add",{name:"overlap-guard",command:cmd,every_minutes:60,cwd:TMP,enabled:true});
if(r.isError)throw new Error("schedule add failed: "+r.text);
const id=r.text.match(/등록됨:\s*(s[a-f0-9]+)/i)?.[1];if(!id)throw new Error("schedule id missing");
r=await a.call("schedule_run_now",{id});if(r.isError)throw new Error("first run_now failed: "+r.text);
const second=await a.call("schedule_run_now",{id});if(!second.isError)throw new Error("overlapping run was accepted");
let list=null,job=null;
for(let i=0;i<40;i++){await new Promise(res=>setTimeout(res,250));list=JSON.parse(clean((await a.call("schedule_list",{})).text));job=list.find(x=>x.id===id);if(job&&!job.runningPid)break;}
if(!job||job.runningPid)throw new Error("scheduled command did not finish");
const lines=fs.existsSync(marker)?fs.readFileSync(marker,"utf8").trim().split(/\r?\n/).filter(Boolean):[];
if(lines.length!==1)throw new Error("expected exactly one execution, got "+lines.length);
if(!job||job.runningPid!==null||job.lastExitCode!==0||job.lastBlockedReason!=="previous run still active")throw new Error("overlap state invalid");
await a.c.close();

const statePath=path.join(TMP,".webjjonku","state.json");
const state=JSON.parse(fs.readFileSync(statePath,"utf8")),persisted=state.schedules.find(x=>x.id===id);persisted.runningPid=99999999;persisted.runningStartedAt=new Date().toISOString();fs.writeFileSync(statePath,JSON.stringify(state,null,2));
const b=await mk("scheduler-b");
list=JSON.parse(clean((await b.call("schedule_list",{})).text));job=list.find(x=>x.id===id);
if(!job||job.runningPid!==null||!job.lastRecoveredStaleRunAt)throw new Error("stale running pid not recovered");
console.log(JSON.stringify({ok:true,overlapBlocked:true,staleRecovered:true,runs:lines.length},null,2));
await b.c.close();try{fs.rmSync(TMP,{recursive:true,force:true})}catch{}
