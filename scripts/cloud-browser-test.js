#!/usr/bin/env node
import http from "node:http";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const ROOT=path.resolve(new URL("..",import.meta.url).pathname.replace(/^\/(.:)/,"$1"));
const temp=fs.mkdtempSync(path.join(os.tmpdir(),"wjk-cloud-browser-"));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const port=()=>new Promise((resolve,reject)=>{const s=net.createServer();s.listen(0,"127.0.0.1",()=>{const p=s.address().port;s.close(()=>resolve(p));});s.on("error",reject);});
const coordPort=await port(),webPort=await port();
let trackHits=0;
const target=http.createServer((req,res)=>{
 if(req.url==="/track"){
  trackHits++;
  res.writeHead(200,{"content-type":"text/html"});
  res.end('<html><body><main>TRACKED_PAGE_TEXT</main><script>const hidden_script_marker="SHOULD_NOT_APPEAR_IN_VISIBLE_TEXT";</script></body></html>');
  return;
 }
 res.writeHead(200,{"content-type":"text/html"});res.end('<html><body><input id="x"><button id="go" onclick="document.getElementById(\'out\').textContent=document.getElementById(\'x\').value">Go</button><div id="out"></div></body></html>');
});
await new Promise(r=>target.listen(webPort,"127.0.0.1",r));
const coord=spawn(process.execPath,[path.join(ROOT,"scripts","coordinator-server.js"),"--port",String(coordPort),"--data",path.join(temp,"state.json"),"--blob-dir",path.join(temp,"blobs")],{cwd:temp,stdio:["ignore","pipe","pipe"],windowsHide:true});
const wait=async(fn,ms=12000)=>{const end=Date.now()+ms;while(Date.now()<end){try{const v=await fn();if(v)return v}catch{}await sleep(200)}return null};
if(!await wait(async()=>{try{return (await fetch("http://127.0.0.1:"+coordPort+"/health")).ok}catch{return false}}))throw new Error("coordinator start failed");
const worker=spawn(process.execPath,[path.join(ROOT,"scripts","browser-worker.js"),"--coordinator","http://127.0.0.1:"+coordPort,"--worker-id","test-browser","--allow-private-http"],{cwd:ROOT,stdio:["ignore","pipe","pipe"],windowsHide:true});
let workerErr="",workerOut="";
worker.stderr.on("data",d=>workerErr+=d.toString());
worker.stdout.on("data",d=>workerOut+=d.toString());
if(!await wait(async()=>{const r=await fetch("http://127.0.0.1:"+coordPort+"/v1/devices");const rows=await r.json();return rows.some(x=>x.deviceId==="test-browser")},15000))throw new Error("browser worker heartbeat failed: "+workerErr);
const submit=await fetch("http://127.0.0.1:"+coordPort+"/v1/tasks",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({
 title:"cloud-browser-e2e",executor:"browser",localRequired:false,targetDevice:"test-browser",
 action:{type:"browser",url:"http://127.0.0.1:"+webPort,steps:[
  {type:"type",selector:"#x",value:"cloud-ok"},
  {type:"click",selector:"#go"},
  {type:"read",maxChars:5000},
  {type:"screenshot",fullPage:true}
 ]}
})});
const task=await submit.json();
const done=await wait(async()=>{const r=await fetch("http://127.0.0.1:"+coordPort+"/v1/tasks/"+task.id);const j=await r.json();return ["succeeded","failed"].includes(j.status)?j:null},60000);
if(!done){const status=await (await fetch("http://127.0.0.1:"+coordPort+"/v1/tasks/"+task.id)).json();throw new Error("browser task timeout: "+JSON.stringify({status:status.status,error:status.error,partial:status.result,workerErr:workerErr.slice(-1100),workerOut:workerOut.slice(-1100)}));}
if(done.status!=="succeeded")throw new Error("browser task failed: "+JSON.stringify(done));
const read=done.result?.steps?.find(x=>x.type==="read")?.result?.text||"";
const blob=done.result?.artifacts?.[0]?.blobKey;
if(!read.includes("cloud-ok")||!blob)throw new Error("unexpected result: "+JSON.stringify(done.result));
const br=await fetch("http://127.0.0.1:"+coordPort+"/v1/blobs/"+encodeURIComponent(blob));
const buf=Buffer.from(await br.arrayBuffer());
if(!br.ok||buf.length<1000)throw new Error("screenshot blob invalid");
// A supplied action.url together with a first goto should perform exactly one navigation.
const trackUrl="http://127.0.0.1:"+webPort+"/track";
const trackSubmit=await fetch("http://127.0.0.1:"+coordPort+"/v1/tasks",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({
 title:"no-duplicate-goto",executor:"browser",localRequired:false,targetDevice:"test-browser",
 action:{type:"browser",url:trackUrl,steps:[{type:"goto",url:trackUrl},{type:"read",maxChars:2000}]}
})});
const trackTask=await trackSubmit.json();
const trackDone=await wait(async()=>{const r=await fetch("http://127.0.0.1:"+coordPort+"/v1/tasks/"+trackTask.id);const j=await r.json();return ["succeeded","failed"].includes(j.status)?j:null},40000);
if(!trackDone||trackDone.status!=="succeeded")throw new Error("duplicate navigation test failed: "+JSON.stringify(trackDone));
const trackText=trackDone.result.steps.find(x=>x.type==="read").result.text;
if(trackHits!==1||!trackText.includes("TRACKED_PAGE_TEXT")||trackText.includes("SHOULD_NOT_APPEAR_IN_VISIBLE_TEXT"))throw new Error("navigation or visible text regression: "+JSON.stringify({trackHits,trackText}));
console.log(JSON.stringify({ok:true,taskId:task.id,textMatched:true,screenshotBytes:buf.length,trackedNavigations:trackHits,scriptTextExcluded:true},null,2));
try{worker.kill("SIGKILL")}catch{};try{coord.kill("SIGKILL")}catch{};await new Promise(r=>target.close(r));try{fs.rmSync(temp,{recursive:true,force:true})}catch{}
