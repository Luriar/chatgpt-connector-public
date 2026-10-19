#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const root=process.cwd();
if(!process.env.WEBJJONKU_NAS_PUBLIC_BASE)throw new Error("Set WEBJJONKU_NAS_PUBLIC_BASE to your own endpoint before running this integration test");
const host=process.env.WEBJJONKU_NAS_PUBLIC_BASE||"";
const secret=fs.readFileSync(path.join(root,".webjjonku","http-secret"),"utf8").trim();
const tr=new StreamableHTTPClientTransport(new URL(host.replace(/\/$/,"")+"/mcp/"+secret));
const c=new Client({name:"nas-public-mcp-e2e",version:"1"});
try{
  await c.connect(tr);
  const list=await c.listTools();
  const names=list.tools.map(x=>x.name);
  const lock=await c.callTool({name:"resource_lock_status",arguments:{}});
  if(lock.isError)throw new Error("resource lock status failed");
  console.log(JSON.stringify({
    ok:true,
    tools:names.length,
    resourceLockTools:names.filter(x=>x.startsWith("resource_lock_")),
    hasDesktop:names.includes("desktop_windows"),
    hasCloudBrowser:names.includes("cloud_browser_submit")
  },null,2));
}finally{
  try{await tr.terminateSession();}catch{}
  try{await c.close();}catch{}
}
