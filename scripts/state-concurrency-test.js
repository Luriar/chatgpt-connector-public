#!/usr/bin/env node
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fs from "node:fs";import os from "node:os";import path from "node:path";
const ROOT=path.resolve(new URL("..",import.meta.url).pathname.replace(/^\/(.:)/,"$1")),TMP=fs.mkdtempSync(path.join(os.tmpdir(),"wjk-state-race-"));
const cfg=path.join(TMP,"cfg.json");fs.writeFileSync(cfg,JSON.stringify({roots:[TMP]},null,2));
async function client(name){
 const tr=new StdioClientTransport({command:process.execPath,args:[path.join(ROOT,"src","index.js"),"--stdio","--config",cfg],cwd:TMP});
 const c=new Client({name,version:"1"});await c.connect(tr);
 const call=async(tool,args={})=>{const r=await c.callTool({name:tool,arguments:args});const t=r.content?.find(x=>x.type==="text")?.text||"";if(r.isError)throw new Error(tool+": "+t);return t;};
 return {c,call};
}
const a=await client("state-a"),b=await client("state-b");
await Promise.all([
 a.call("project_create",{name:"Project A",root:TMP}),
 b.call("project_create",{name:"Project B",root:TMP})
]);
await Promise.all([
 a.call("session_save",{note:"note-A",tags:["race"]}),
 b.call("session_save",{note:"note-B",tags:["race"]})
]);
await Promise.all([
 a.call("schedule_add",{name:"schedule-A",command:"echo A",every_minutes:60}),
 b.call("schedule_add",{name:"schedule-B",command:"echo B",every_minutes:60})
]);
await a.c.close();await b.c.close();
const state=JSON.parse(fs.readFileSync(path.join(TMP,".webjjonku","state.json"),"utf8"));
const projects=Object.values(state.projects||{}).map(x=>x.name);
const notes=(state.notes||[]).map(x=>x.note);
const schedules=(state.schedules||[]).map(x=>x.name);
if(!projects.includes("Project A")||!projects.includes("Project B"))throw new Error("project lost update: "+JSON.stringify(projects));
if(!notes.includes("note-A")||!notes.includes("note-B"))throw new Error("note lost update: "+JSON.stringify(notes));
if(!schedules.includes("schedule-A")||!schedules.includes("schedule-B"))throw new Error("schedule lost update: "+JSON.stringify(schedules));
if(fs.existsSync(path.join(TMP,".webjjonku","state.json.lock")))throw new Error("state lock leaked");
console.log(JSON.stringify({ok:true,projects,notes,schedules},null,2));
try{fs.rmSync(TMP,{recursive:true,force:true})}catch{}
