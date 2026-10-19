#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { loadConfig } from "../src/config.js";

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const cfg=loadConfig(path.join(ROOT,"webjjonku.config.json"));
const mcpBase=(process.env.WEBJJONKU_MCP_BASE||("http://127.0.0.1:"+cfg.http.port)).replace(/\/$/,"");
const mcpUrl=new URL(mcpBase+"/mcp/"+encodeURIComponent(cfg.http.secretPath));
const transport=new StreamableHTTPClientTransport(mcpUrl);
const client=new Client({name:"sites-browser-nas-live-e2e",version:"1"});

const clean=s=>{
  let x=String(s||"");
  if(x.startsWith("[UNTRUSTED DATA BOUNDARY]")){
    const i=x.indexOf("\n\n");
    x=i>=0?x.slice(i+2):"";
  }
  return x.split("\n\n───")[0];
};
const call=async(name,args={})=>{
  const r=await client.callTool({name,arguments:args});
  const t=r.content?.find(x=>x.type==="text")?.text||"";
  if(r.isError)throw new Error(name+": "+clean(t));
  return clean(t);
};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

let siteId=null;
let cleanupNeeded=false;
try{
  await client.connect(transport);

  const created=JSON.parse(await call("site_create",{
    title:"browser-nas-live-e2e-temp",
    files:{
      "index.html":'<!doctype html><html><body><h1>NAS Browser E2E</h1><button id="b">go</button><div id="out">before</div><script src="app.js"></script></body></html>',
      "app.js":"document.getElementById('b').addEventListener('click',()=>{document.getElementById('out').textContent='clicked-browser-nas';});"
    }
  }));
  siteId=created.id;
  cleanupNeeded=true;

  const published=JSON.parse(await call("site_publish_cloud",{id:siteId}));
  if(!published.publicUrl)throw new Error("site publish returned no publicUrl");

  const submitted=JSON.parse(await call("cloud_browser_submit",{
    title:"Sites browser-nas live E2E",
    worker_id:"browser-nas",
    timeout_ms:30000,
    steps:[
      {type:"goto",url:published.publicUrl,waitUntil:"domcontentloaded",timeoutMs:10000},
      {type:"click",selector:"#b",timeoutMs:5000},
      {type:"read",maxChars:5000}
    ]
  }));

  let task=null;
  const deadline=Date.now()+35000;
  while(Date.now()<deadline){
    task=JSON.parse(await call("cloud_browser_status",{id:submitted.id}));
    if(["succeeded","failed","cancelled"].includes(task.status))break;
    await sleep(350);
  }
  if(!task||task.status!=="succeeded")throw new Error("browser-nas task did not succeed: "+(task?.error||task?.status||"timeout"));
  if(task.assignedDevice!=="browser-nas")throw new Error("task assigned to wrong browser worker");
  const readStep=task.result?.steps?.find(x=>x.type==="read");
  const body=String(readStep?.result?.text||"");
  if(!body.includes("clicked-browser-nas"))throw new Error("interactive DOM result missing");

  const deleted=JSON.parse(await call("site_delete",{id:siteId,delete_cloud:true}));
  if(deleted.localDeleted!==true||deleted.cloudDeleted!==true)throw new Error("site cleanup incomplete");
  cleanupNeeded=false;

  const cloud=JSON.parse(await call("site_cloud_status",{}));
  if(cloud.some(x=>x.id===siteId))throw new Error("cloud Site remained after cleanup");

  console.log(JSON.stringify({
    ok:true,
    worker:"browser-nas",
    assignedDevice:task.assignedDevice,
    persistentProfile:task.result?.persistentProfile===true,
    interactiveClick:true,
    cloudDeleted:true
  },null,2));
} finally {
  if(cleanupNeeded&&siteId){
    try{await call("site_delete",{id:siteId,delete_cloud:true});}catch{}
  }
  try{await client.close();}catch{}
}
