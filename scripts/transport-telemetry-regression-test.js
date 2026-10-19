#!/usr/bin/env node
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import {TransportTelemetry,classifyHttpPath} from "../src/transport-telemetry.js";

const assert=(v,m)=>{if(!v)throw new Error(m);};
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),"wjk-transport-telemetry-"));
const telemetry=new TransportTelemetry({stateDir:tmp,runtimeProfile:"test"});
const mcpPath="/mcp/VERY-SECRET-CAPABILITY";
const server=http.createServer((req,res)=>{
  const u=new URL(req.url,"http://localhost");
  const trace=telemetry.beginRequest(req,res,classifyHttpPath(u.pathname,mcpPath),req.headers["mcp-session-id"]);
  if(u.pathname===mcpPath&&u.searchParams.get("abort")==="1"){setTimeout(()=>{if(!res.destroyed)res.end("late");},300);return;}
  if(u.pathname===mcpPath&&u.searchParams.get("fail")==="1"){
    const e=Object.assign(new Error("TOP-SECRET-ERROR-MESSAGE"),{code:"E_TEST"});
    trace?.handlerError(e);res.writeHead(500,{"content-type":"text/plain","content-length":"4"});res.end("fail");return;
  }
  let body="";req.on("data",c=>body+=c);req.on("end",()=>{res.writeHead(200,{"content-type":"application/json"});res.end(JSON.stringify({ok:true,seen:body.length}));});
});
telemetry.attachServer(server);
await new Promise(r=>server.listen(0,"127.0.0.1",r));
const port=server.address().port;
const call=(path,body="")=>new Promise((resolve,reject)=>{
  const req=http.request({host:"127.0.0.1",port,path,method:"POST",headers:{"mcp-session-id":"session-secret-value","content-type":"application/json","content-length":Buffer.byteLength(body)}},res=>{res.resume();res.on("end",()=>resolve(res.statusCode));});
  req.on("error",reject);req.end(body);
});
assert(await call(mcpPath,'{"value":"TOP-SECRET-BODY"}')===200,"normal request failed");
assert(await call(mcpPath+"?fail=1","x")===500,"handler failure route failed");
await new Promise(resolve=>{
  const req=http.request({host:"127.0.0.1",port,path:mcpPath+"?abort=1",method:"POST",headers:{"content-length":"1"}});
  req.on("error",()=>resolve());req.end("x");setTimeout(()=>req.destroy(),40);setTimeout(resolve,120);
});
await new Promise(r=>setTimeout(r,380));
await telemetry.flush();
await new Promise(r=>server.close(r));
const snap=telemetry.snapshot(100);
const events=snap.recent.map(x=>x.event);
assert(events.includes("request_finish"),"normal finish not recorded");
assert(events.includes("handler_error"),"handler error not recorded");
assert(events.includes("request_abort")||events.includes("response_close_early")||events.includes("connection_close"),"client abort/early close not recorded");
assert(snap.lastMcpRequestAt,"last MCP request timestamp missing");
const persisted=[telemetry.backup,telemetry.file].filter(f=>fs.existsSync(f)).map(f=>fs.readFileSync(f,"utf8")).join("\n");
for(const secret of ["VERY-SECRET-CAPABILITY","session-secret-value","TOP-SECRET-BODY","TOP-SECRET-ERROR-MESSAGE"])assert(!persisted.includes(secret),"secret leaked to telemetry: "+secret);
for(const row of snap.recent)assert(!("path" in row)&&!("url" in row)&&!("body" in row)&&!("headers" in row),"raw request material leaked");
console.log(JSON.stringify({ok:true,events:snap.eventCounts,lastMcpRequestAt:snap.lastMcpRequestAt,secretsRedacted:true}));
fs.rmSync(tmp,{recursive:true,force:true});
