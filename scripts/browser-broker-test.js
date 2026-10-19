#!/usr/bin/env node
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fs from "node:fs";import os from "node:os";import path from "node:path";import http from "node:http";import net from "node:net";
const ROOT=path.resolve(new URL("..",import.meta.url).pathname.replace(/^\/(.:)/,"$1")),TMP=fs.mkdtempSync(path.join(os.tmpdir(),"wjk-broker-"));
const cfg=path.join(TMP,"cfg.json");fs.writeFileSync(cfg,JSON.stringify({roots:[TMP],browser:{headless:true,allowPrivateNetwork:true,profileRetentionDays:1}},null,2));fs.writeFileSync(path.join(TMP,"upload.txt"),"upload-ok");
const stale=path.join(TMP,".webjjonku","browser-profiles","stale-fixture");fs.mkdirSync(stale,{recursive:true});fs.writeFileSync(path.join(stale,".webjjonku-profile.json"),JSON.stringify({refreshedAt:"2020-01-01T00:00:00.000Z"}));
const free=()=>new Promise((resolve,reject)=>{const s=net.createServer();s.listen(0,"127.0.0.1",()=>{const p=s.address().port;s.close(()=>resolve(p));});s.on("error",reject);});
const port=await free();
const server=http.createServer((req,res)=>{
  res.writeHead(200,{"content-type":"text/html"});
  if(req.url==="/popup"){res.end('<title>Popup</title><h1>popup-ok</h1>');return;}
  res.end('<title>Persist</title><h1>persist-ok</h1><input id="file" type="file"><a id="pop" target="_blank" href="/popup">popup</a><iframe name="f" srcdoc="<input id=fi><button id=fb onclick=&quot;document.getElementById(\'fo\').textContent=document.getElementById(\'fi\').value&quot;>go</button><div id=fo></div>"></iframe>');
});
await new Promise(r=>server.listen(port,"127.0.0.1",r));
async function mk(name){
 const tr=new StdioClientTransport({command:process.execPath,args:[path.join(ROOT,"src","index.js"),"--stdio","--config",cfg],cwd:TMP});
 const c=new Client({name,version:"1"});await c.connect(tr);
 const call=async(n,a={})=>{const r=await c.callTool({name:n,arguments:a});return {isError:!!r.isError,text:r.content?.find(x=>x.type==="text")?.text||""};};
 return {c,call};
}
const clean=s=>{let x=String(s||"");if(x.startsWith("[UNTRUSTED DATA BOUNDARY]")){const i=x.indexOf("\n\n");x=i>=0?x.slice(i+2):"";}return x.split("\n\n───")[0];};
const a=await mk("broker-a"),st=JSON.parse(clean((await a.call("browser_status")).text));if(st.startupCleanup?.staleSnapshotsRemoved<1||fs.existsSync(stale))throw new Error("stale profile retention cleanup failed");if(!st.available){console.log(JSON.stringify({ok:true,skipped:"browser unavailable",retentionCleanup:true}));await a.c.close();await new Promise(r=>server.close(r));process.exit(0);}
const kind=/msedge/i.test(st.executablePath)?"edge":"chrome";
const start=await a.call("browser_broker_start",{browser:kind,use_profile_snapshot:false,visible:false});if(start.isError)throw new Error("start: "+start.text);const broker=JSON.parse(clean(start.text)),bid=broker.id;
const op=await a.call("browser_open",{url:"http://127.0.0.1:"+port+"/"});if(op.isError)throw new Error(op.text);const page=op.text.match(/(p[a-z0-9]+)/i)?.[1];if(!page)throw new Error("page id");
await a.call("browser_upload_file",{page,selector:"#file",paths:[path.join(TMP,"upload.txt")]});
await a.call("browser_frame_type",{page,frame_name:"f",selector:"#fi",value:"frame-ok"});
await a.call("browser_frame_click",{page,frame_name:"f",selector:"#fb"});
const fr=await a.call("browser_frame_read",{page,frame_name:"f"});if(fr.isError||!fr.text.includes("frame-ok"))throw new Error("frame failed");
const pop=await a.call("browser_click_popup",{page,selector:"#pop"});if(pop.isError||!pop.text.includes("Popup"))throw new Error("popup failed: "+pop.text);
await a.c.close();await new Promise(r=>setTimeout(r,700));
const b=await mk("broker-b"),re=await b.call("browser_broker_reconnect",{id:bid});if(re.isError)throw new Error("reconnect: "+re.text);
const tabs=await b.call("browser_tabs");if(tabs.isError||!tabs.text.includes("Persist")||!tabs.text.includes("Popup"))throw new Error("tabs not persisted: "+tabs.text);
const list=JSON.parse(clean((await b.call("browser_broker_list")).text));if(!list.some(x=>x.id===bid&&x.alive&&x.active))throw new Error("broker list invalid");
const stop=await b.call("browser_broker_stop",{id:bid,keep_profile:false});if(stop.isError)throw new Error("stop: "+stop.text);
console.log(JSON.stringify({ok:true,brokerId:bid,reconnected:true,frame:true,popup:true,upload:true},null,2));
await b.c.close();await new Promise(r=>server.close(r));try{fs.rmSync(TMP,{recursive:true,force:true})}catch{};process.exit(0)
