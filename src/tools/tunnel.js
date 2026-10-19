// V2 Cloudflare tunnel diagnostics
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { z } from "zod";
import { text } from "../toolkit.js";

function run(cmd,args,timeout=15000){try{const r=spawnSync(cmd,args,{encoding:"utf8",timeout,windowsHide:true});return {code:r.status,stdout:r.stdout||"",stderr:r.stderr||"",error:r.error?.message||null};}catch(e){return {code:null,stdout:"",stderr:"",error:e.message};}}
function publicTunnelState(v){if(!v)return null;const out={...v};if(out.mcpUrl){try{const u=new URL(out.mcpUrl);out.mcpUrl=u.origin+"/mcp/<hidden>";}catch{out.mcpUrl="<hidden>";}}return out;}
export function registerTunnelTools(reg,ctx){
  reg("tunnel_status",{description:"현재 tunnel 설정과 daemon이 기록한 공개 URL 상태를 확인한다.",inputSchema:{}},async()=>{
    let state=null;try{state=JSON.parse(fs.readFileSync(ctx.cfg.stateDir+"/tunnel.json","utf8"));}catch{}
    return text(JSON.stringify({config:ctx.cfg.tunnel||{},state:publicTunnelState(state)},null,2));
  });
  reg("tunnel_validate_named",{
    description:"Cloudflare Named Tunnel 실행 준비 상태를 검증한다. cloudflared 설치, 설정파일, 계정 인증/tunnel list 접근을 확인하며 변경은 하지 않는다.",
    inputSchema:{name:z.string().optional()}
  },async({name})=>{
    const t=ctx.cfg.tunnel||{};const bin=t.command||"cloudflared";const version=run(bin,["--version"],8000);
    const target=name||t.name;const configFile=t.configFile||null;
    const configExists=configFile?fs.existsSync(configFile):null;
    let list=null;if(version.code===0)list=run(bin,["tunnel","list","--output","json"],15000);
    let found=false;if(list?.code===0&&target){try{const arr=JSON.parse(list.stdout);found=arr.some(x=>x.name===target||x.id===target);}catch{}}
    return text(JSON.stringify({cloudflared:version.code===0,version:version.stdout.trim()||version.stderr.trim(),name:target||null,configFile,configExists,listOk:list?.code===0,found,listError:list?.code===0?null:(list?.stderr||list?.error)},null,2));
  });
}
