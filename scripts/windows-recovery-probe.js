#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getCredential } from "../src/credentials.js";
import { pinnedRequest } from "../src/net-safe.js";
import { probeWindowsToolPath } from "../src/windows-recovery.js";

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const args=process.argv.slice(2);
const opt=(name,def)=>{const i=args.indexOf(name);return i>=0&&args[i+1]?args[i+1]:def;};
async function main(){
  const timeoutMs=Math.max(2000,Math.min(30000,Number(opt("--timeout-ms","8000"))||8000));
  const busyGraceMs=Math.max(30000,Math.min(15*60_000,Number(opt("--busy-grace-ms","180000"))||180000));
  const runtime=JSON.parse(fs.readFileSync(path.join(root,".webjjonku","nas-runtime.json"),"utf8").replace(/^\uFEFF/,""));
  if(runtime.enabled!==true)throw new Error("NAS runtime is not enabled");
  const coordinator=String(runtime.coordinatorUrl||"").replace(/\/$/,"");
  const deviceId=String(runtime.windowsToolWorkerId||runtime.deviceId||"windows-worker");
  const credential=String(runtime.clientCredential||"");
  if(!coordinator||!credential)throw new Error("coordinatorUrl/clientCredential missing");
  let token;
  for(const stateDir of [path.join(root,".webjjonku","runtimes","windows"),path.join(root,".webjjonku")]){
    try{token=getCredential({stateDir},credential);}catch{}
    if(token)break;
  }
  if(!token)throw new Error("coordinator credential unavailable");
  const base=new URL(coordinator);
  const loopback=["127.0.0.1","localhost","::1"].includes(base.hostname);
  // Administrator-supplied runtime coordinator, matching nas-client-launcher.
  const api=async(p,{method="GET",body,timeout=3000}={})=>{
    const headers={accept:"application/json",authorization:"Bearer "+token};
    if(body!==undefined)headers["content-type"]="application/json";
    const res=await pinnedRequest(new URL(p,base),{method,headers,body:body===undefined?undefined:JSON.stringify(body),timeoutMs:timeout,maxBytes:2*1024*1024,allowPrivateNetwork:true,allowLoopback:loopback});
    const data=JSON.parse(res.body.toString("utf8")||"null");
    if(!res.ok)throw new Error(data?.error||("HTTP "+res.status));
    return data;
  };
  return probeWindowsToolPath({api,deviceId,timeoutMs,busyGraceMs});
}
let result;
try{result=await main();}catch(error){result={ok:false,status:"configuration_unavailable",verified:false,repairEligible:false,error:String(error?.message||error).slice(0,300)};}
console.log(JSON.stringify(result));
process.exitCode=result.ok||result.status==="busy"?0:result.repairEligible?1:2;
