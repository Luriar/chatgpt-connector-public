#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const root=process.cwd();
const secret=fs.readFileSync(path.join(root,".webjjonku","http-secret"),"utf8").trim();
const tr=new StreamableHTTPClientTransport(new URL("http://127.0.0.1:8747/mcp/"+secret));
const c=new Client({name:"nas-windows-proxy-e2e",version:"1"});
try{
  await c.connect(tr);
  const call=async(name,args={})=>{
    const r=await c.callTool({name,arguments:args});
    const t=r.content?.find(x=>x.type==="text")?.text||"";
    if(r.isError)throw new Error(name+": "+t);
    return t;
  };
  const status=await call("computer_uia_status");
  const windows=await call("desktop_windows");
  if(!/available/i.test(status)||!/ChatGPT|PowerShell|ThrottleStop|Task|Windows/i.test(windows)){
    throw new Error("unexpected Windows proxy result");
  }
  console.log(JSON.stringify({ok:true,uia:status.slice(0,300),windows:windows.slice(0,500)},null,2));
}finally{
  try{await tr.terminateSession();}catch{}
  try{await c.close();}catch{}
}
