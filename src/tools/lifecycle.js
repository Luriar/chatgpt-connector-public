// V2 lifecycle inspection tools
import fs from "node:fs";
import path from "node:path";
import { text } from "../toolkit.js";

const readJson=(p)=>{try{return JSON.parse(fs.readFileSync(p,"utf8"));}catch{return null;}};
const alive=(pid)=>{try{process.kill(pid,0);return true;}catch{return false;}};
const publicTunnel=(v)=>{if(!v)return null;const out={...v};if(out.mcpUrl){try{const u=new URL(out.mcpUrl);out.mcpUrl=u.origin+"/mcp/<hidden>";}catch{out.mcpUrl="<hidden>";}}return out;};

export function registerLifecycleTools(reg, ctx) {
  reg("lifecycle_status", {
    description:"V2 daemon/HTTP/tunnel 상태를 한 번에 확인한다.",
    inputSchema:{}
  }, async () => {
    const d=readJson(path.join(ctx.cfg.stateDir,"daemon.json"));
    const t=readJson(path.join(ctx.cfg.stateDir,"tunnel.json"));
    const host=ctx.cfg.http.host==="0.0.0.0"?"127.0.0.1":ctx.cfg.http.host;
    let health; try{const r=await fetch(`http://${host}:${ctx.cfg.http.port}/health`,{signal:AbortSignal.timeout(2500)});health=r.ok?await r.json():{ok:false,status:r.status};}catch(e){health={ok:false,error:e.message};}
    return text(JSON.stringify({daemon:d?{...d,alive:alive(d.pid)}:null,health,tunnel:publicTunnel(t)},null,2));
  });
}
