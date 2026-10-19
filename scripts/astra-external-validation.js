#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { pinnedRequest } from "../src/net-safe.js";
import { loadConfig } from "../src/config.js";
import { Store } from "../src/state.js";
import { listCredentials } from "../src/credentials.js";
import { getValidAccessToken } from "../src/tools/oauth.js";

const args=process.argv.slice(2);
const flag=n=>args.includes(n);
const opt=(n,d=null)=>{const i=args.indexOf(n);return i>=0&&args[i+1]?args[i+1]:d;};
const active=flag("--active"),strict=flag("--strict");
const allowPrivate=flag("--allow-private")||process.env.WEBJJONKU_VALIDATION_ALLOW_PRIVATE==="1";
const results=[];
function add(area,name,status,detail=""){results.push({area,name,status,detail});const mark=status==="PASS"?"✅":status==="FAIL"?"❌":"⏭️";console.log(mark+" ["+area+"] "+name+(detail?" — "+detail:""));}
function run(cmd,argv,{timeout=20000}={}){return spawnSync(cmd,argv,{encoding:"utf8",timeout,windowsHide:true});}
function loopback(u){return ["127.0.0.1","localhost","::1"].includes(u.hostname);}
async function request(base,p,{method="GET",token,body}={}){
  const u=new URL(p,base.endsWith("/")?base:base+"/"),isLoop=loopback(u),headers={"accept":"application/json"};
  if(body!==undefined)headers["content-type"]="application/json";
  if(token)headers.authorization="Bearer "+token;
  const r=await pinnedRequest(u,{method,headers,body:body===undefined?undefined:JSON.stringify(body),timeoutMs:20000,maxBytes:2*1024*1024,allowPrivateNetwork:allowPrivate||isLoop,allowLoopback:isLoop});
  let data;try{data=JSON.parse(r.body.toString("utf8"));}catch{data=r.body.toString("utf8");}
  return {...r,data};
}

async function checkWsl(){
  if(process.platform!=="win32"){add("WSL2","Windows host","SKIP","not Windows");return;}
  let prereqReady=true;
  for(const f of ["Microsoft-Windows-Subsystem-Linux","VirtualMachinePlatform"]){
    const r=run("dism.exe",["/English","/Online","/Get-FeatureInfo","/FeatureName:"+f]);
    if(r.status!==0){
      const detail=(r.stderr||r.stdout||"feature query failed").trim().slice(0,240);
      if(/740|elevated permissions|required to run dism/i.test(detail))add("WSL2",f,"SKIP","administrator elevation required to query Windows feature state");
      else add("WSL2",f,"FAIL",detail);
      prereqReady=false;
    }else if(/State\s*:\s*Enabled/i.test(r.stdout||""))add("WSL2",f,"PASS","Enabled");
    else{add("WSL2",f,"SKIP","Disabled; enable feature and reboot before guest validation");prereqReady=false;}
  }
  const ws=run("wsl.exe",["--status"]);if(ws.status===0)add("WSL2","wsl --status","PASS");else if(!prereqReady)add("WSL2","wsl --status","SKIP","WSL prerequisites not active yet");else add("WSL2","wsl --status","FAIL",(ws.stderr||ws.stdout||"failed").trim().slice(0,240));
  const distro=opt("--distro",process.env.WEBJJONKU_VM_DISTRO||"webjjonku-vm");
  const ls=run("wsl.exe",["-l","-q"]);
  const names=String(ls.stdout||"").replace(/\u0000/g,"").split(/\r?\n/).map(x=>x.trim()).filter(Boolean);
  if(!names.some(x=>x.toLowerCase()===distro.toLowerCase())){add("WSL2","guest "+distro,"SKIP","distro not installed/prepared");return;}
  const script="test ! -e /mnt/c && ! command -v cmd.exe >/dev/null 2>&1 && grep -Eq 'enabled[[:space:]]*=[[:space:]]*false' /etc/wsl.conf && grep -Eq 'appendWindowsPath[[:space:]]*=[[:space:]]*false' /etc/wsl.conf";
  const iso=run("wsl.exe",["-d",distro,"--","sh","-lc",script],{timeout:30000});
  if(iso.status===0)add("WSL2","guest boundary","PASS","/mnt/c absent, cmd.exe unavailable, interop/path disabled");
  else add("WSL2","guest boundary","FAIL","guest isolation assertion failed");
}

async function checkCoordinator(){
  const base=opt("--coordinator",process.env.WEBJJONKU_COORDINATOR_URL||"");
  const token=process.env.WEBJJONKU_COORDINATOR_TOKEN||opt("--token","");
  if(!base){add("Cloud","HTTPS coordinator","SKIP","set WEBJJONKU_COORDINATOR_URL");return;}
  let u;try{u=new URL(base);}catch{add("Cloud","coordinator URL","FAIL","invalid URL");return;}
  if(u.protocol!=="https:"&&!loopback(u)){add("Cloud","HTTPS coordinator","FAIL","non-loopback coordinator must use HTTPS");return;}
  try{
    const h=await request(base,"/health",{token});if(h.status!==200){add("Cloud","coordinator health","FAIL","HTTP "+h.status);return;}
    add("Cloud","coordinator health","PASS",String(h.data?.name||"ok"));
    if(!loopback(u)){
      const unauth=await request(base,"/health",{});if(unauth.status===401)add("Cloud","unauthenticated rejection","PASS","HTTP 401");else add("Cloud","unauthenticated rejection","FAIL","expected 401, got "+unauth.status);
    }
    if(token){
      const dev=await request(base,"/v1/devices",{token});
      if(dev.status===200&&Array.isArray(dev.data)){
        const workers=dev.data.filter(x=>Array.isArray(x.capabilities)&&x.capabilities.includes("cloud-browser"));
        const fresh=workers.filter(x=>Date.now()-new Date(x.lastSeen).getTime()<120000);
        if(fresh.length)add("Cloud","browser worker heartbeat","PASS",fresh.map(x=>x.deviceId).join(", "));
        else add("Cloud","browser worker heartbeat","SKIP","no cloud-browser worker seen in last 120s");
      }else add("Cloud","browser worker heartbeat","FAIL","device list HTTP "+dev.status);
    }else add("Cloud","authenticated API","SKIP","set WEBJJONKU_COORDINATOR_TOKEN");
    if(active){
      if(!token){add("Cloud","active scoped-auth lifecycle","FAIL","--active needs admin token");return;}
      const suffix=crypto.randomBytes(4).toString("hex"),id="astra_"+suffix,subject="astra-probe-"+suffix;
      let x=await request(base,"/v1/auth/tokens",{method:"POST",token,body:{id,role:"device",subject,ttl_seconds:300}});
      if(x.status!==201||!x.data?.token){add("Cloud","active scoped-auth lifecycle","FAIL","token create HTTP "+x.status);return;}
      const old=x.data.token;
      x=await request(base,"/v1/devices/heartbeat",{method:"POST",token:old,body:{deviceId:subject,capabilities:["device","astra-probe"]}});
      if(x.status!==200)throw new Error("probe heartbeat "+x.status);
      x=await request(base,"/v1/tasks",{method:"POST",token:old,body:{title:"must-deny",executor:"device",action:{type:"command",command:"echo denied"}}});
      if(x.status!==403)throw new Error("device token submit was not denied");
      x=await request(base,"/v1/auth/tokens/"+encodeURIComponent(id)+"/rotate",{method:"POST",token,body:{}});
      if(x.status!==200||!x.data?.token)throw new Error("rotate failed");const fresh=x.data.token;
      const oldCheck=await request(base,"/v1/devices/heartbeat",{method:"POST",token:old,body:{deviceId:subject}});
      if(oldCheck.status!==401)throw new Error("old token valid after rotate");
      const newCheck=await request(base,"/v1/devices/heartbeat",{method:"POST",token:fresh,body:{deviceId:subject}});
      if(newCheck.status!==200)throw new Error("rotated token invalid");
      x=await request(base,"/v1/auth/tokens/"+encodeURIComponent(id)+"/revoke",{method:"POST",token,body:{}});
      if(x.status!==200)throw new Error("revoke failed");
      const revoked=await request(base,"/v1/devices/heartbeat",{method:"POST",token:fresh,body:{deviceId:subject}});
      if(revoked.status!==401)throw new Error("revoked token still valid");
      add("Cloud","active scoped-auth lifecycle","PASS","create/least-privilege/rotate/revoke");
    }
  }catch(e){add("Cloud","coordinator validation","FAIL",String(e.message||e).slice(0,300));}
}

async function checkTunnel(){
  const name=opt("--tunnel-name",process.env.WEBJJONKU_TUNNEL_NAME||"");
  const url=opt("--tunnel-url",process.env.WEBJJONKU_NAMED_TUNNEL_URL||"");
  const v=run("cloudflared",["--version"]);
  if(v.status!==0){add("Tunnel","cloudflared","SKIP","cloudflared not available");return;}
  add("Tunnel","cloudflared","PASS",(v.stdout||"").trim().slice(0,120));
  if(name){
    const r=run("cloudflared",["tunnel","info",name],{timeout:30000});
    if(r.status===0)add("Tunnel","named tunnel auth/info","PASS",name);else add("Tunnel","named tunnel auth/info","FAIL",(r.stderr||r.stdout||"failed").trim().slice(0,240));
  }else add("Tunnel","named tunnel auth/info","SKIP","set WEBJJONKU_TUNNEL_NAME");
  if(url){
    try{
      const u=new URL(url);if(u.protocol!=="https:")throw new Error("Named Tunnel URL must be HTTPS");
      const r=await request(url,"/health",{token:process.env.WEBJJONKU_COORDINATOR_TOKEN||undefined});
      if(r.status===200)add("Tunnel","HTTPS route health","PASS",u.host);else add("Tunnel","HTTPS route health","FAIL","HTTP "+r.status);
    }catch(e){add("Tunnel","HTTPS route health","FAIL",String(e.message||e));}
  }else add("Tunnel","HTTPS route health","SKIP","set WEBJJONKU_NAMED_TUNNEL_URL");
}

async function checkOAuth(){
  const provider=opt("--oauth-provider",process.env.WEBJJONKU_OAUTH_PROVIDER||"");
  const configPath=path.resolve(opt("--config",process.env.WEBJJONKU_CONFIG||path.join(process.cwd(),"webjjonku.config.json")));
  if(!provider){add("OAuth","real provider","SKIP","use --oauth-provider NAME after connecting a real provider");return;}
  if(!fs.existsSync(configPath)){add("OAuth","local config","FAIL","config file not found: "+configPath);return;}
  try{
    const cfg=loadConfig(configPath),store=new Store(cfg),p=store.data.oauthProviders?.[provider];
    if(!p){add("OAuth","provider registered","FAIL",provider+" not registered");return;}add("OAuth","provider registered","PASS",provider);
    const creds=listCredentials(cfg),tokenName="oauth-token:"+provider;
    if(!creds.some(x=>x.name===tokenName)){add("OAuth","encrypted token present","FAIL","no stored token");return;}add("OAuth","encrypted token present","PASS");
    if(flag("--oauth-live")){
      await getValidAccessToken({cfg,store},provider);add("OAuth","token validity/refresh","PASS","token obtained without exposing value");
    }else add("OAuth","token validity/refresh","SKIP","add --oauth-live to validate/refresh token");
  }catch(e){add("OAuth","provider validation","FAIL",String(e.message||e).slice(0,300));}
}

await checkWsl();
await checkCoordinator();
await checkTunnel();
await checkOAuth();

const fail=results.filter(x=>x.status==="FAIL"),skip=results.filter(x=>x.status==="SKIP");
console.log("\n"+JSON.stringify({ok:fail.length===0&&(!strict||skip.length===0),active,strict,passed:results.filter(x=>x.status==="PASS").length,failed:fail.length,skipped:skip.length,results},null,2));
if(fail.length||(strict&&skip.length))process.exit(1);
