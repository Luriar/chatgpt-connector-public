#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import JSZip from "jszip";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.js";

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const cfg=loadConfig(process.argv[2]?path.resolve(process.argv[2]):path.join(ROOT,"webjjonku.config.json"));
const source=path.join(ROOT,"agent-plugin");
const outDir=path.join(ROOT,"dist");
const zipPath=path.join(outDir,"webjjonku-v2-plugin.zip");
fs.mkdirSync(outDir,{recursive:true});
const zip=new JSZip();
const root=zip.folder("webjjonku-v2");

function addTree(src,dst){
  for(const ent of fs.readdirSync(src,{withFileTypes:true})){
    const p=path.join(src,ent.name), q=dst?dst+"/"+ent.name:ent.name;
    if(ent.isDirectory()) addTree(p,q);
    else root.file(q,fs.readFileSync(p));
  }
}
addTree(source,"");

for(const skill of fs.readdirSync(path.join(ROOT,"skills"),{withFileTypes:true})){
  if(!skill.isDirectory())continue;
  const file=path.join(ROOT,"skills",skill.name,"SKILL.md");
  if(fs.existsSync(file))root.file("skills/"+skill.name+"/SKILL.md",fs.readFileSync(file));
}

let tunnel=null;try{tunnel=JSON.parse(fs.readFileSync(path.join(cfg.stateDir,"tunnel.json"),"utf8"));}catch{}
const mcpUrl = process.env.WEBJJONKU_MCP_URL || tunnel?.mcpUrl || null;
if(mcpUrl){
  const parsed = new URL(mcpUrl);
  if(parsed.protocol !== "https:") throw new Error("Plugin MCP endpoint must be HTTPS");
  root.file("mcp.json",JSON.stringify({
    "$schema":"https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
    "mcpServers":{"webjjonku":{"type":"streamable-http","url":mcpUrl}}
  },null,2));
  console.log("MCP endpoint included.");
}else{
  console.warn("No live MCP URL found: packaging skills-only plugin. Set WEBJJONKU_MCP_URL or start a configured tunnel, then package again to include mcp.json.");
}

const buf=await zip.generateAsync({type:"nodebuffer",compression:"DEFLATE"});
fs.writeFileSync(zipPath,buf,{mode:0o600});
if(process.platform==="win32"){
  try{
    const who=spawnSync("whoami",["/user","/fo","csv","/nh"],{encoding:"utf8",timeout:5000,windowsHide:true});
    const m=String(who.stdout||"").match(/"[^"]*","([^"]+)"/);
    if(m)spawnSync("icacls",[zipPath,"/inheritance:r","/grant:r","*"+m[1]+":(F)","/grant:r","*S-1-5-18:(F)"],{encoding:"utf8",timeout:10000,windowsHide:true});
  }catch{}
}
if(mcpUrl)console.warn("Plugin package contains a capability MCP URL. Treat this ZIP as sensitive.");
console.log(zipPath);
