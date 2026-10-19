import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { text } from "../toolkit.js";
import { coordinatorApi } from "./coordinator.js";

const execFileAsync=promisify(execFile);
async function gitSnapshot(ctx){
  const root=ctx.cfg.roots?.[0]||process.cwd();
  const {stdout}=await execFileAsync("git",["-C",root,"status","--porcelain=v2","--branch","--untracked-files=no"],{encoding:"utf8",timeout:3000,maxBuffer:256*1024,windowsHide:true});
  const lines=String(stdout||"").split(/\r?\n/).filter(Boolean);
  let head=null,branch=null;
  const trackedChanges=[];
  for(const line of lines){
    if(line.startsWith("# branch.oid "))head=line.slice(13).trim();
    else if(line.startsWith("# branch.head "))branch=line.slice(14).trim();
    else if(!line.startsWith("# "))trackedChanges.push(line);
  }
  return {head,branch,trackedChanges,dirtyTracked:trackedChanges.length>0,untrackedIncluded:false};
}
async function localHealth(ctx){
  const rawHost=ctx.cfg.http?.host||"127.0.0.1";
  const host=["0.0.0.0","::"].includes(rawHost)?"127.0.0.1":rawHost;
  const port=Number(ctx.cfg.http?.port||8747);
  const r=await fetch(`http://${host}:${port}/health`,{signal:AbortSignal.timeout(1500)});
  return r.ok?await r.json():{ok:false,status:r.status};
}
function counts(rows,key="status"){
  return rows.reduce((out,row)=>{const k=String(row?.[key]||"unknown");out[k]=(out[k]||0)+1;return out;},{});
}
async function settled(p){
  try{return {ok:true,value:await p};}catch(error){return {ok:false,error:String(error?.message||error).slice(0,500)};}
}
export async function collectDiagnostics(ctx,api=(p,o)=>coordinatorApi(ctx,p,o),deps={}){
  const started=Date.now();
  const healthProbe=deps.localHealth||localHealth;
  const gitProbe=deps.gitSnapshot||gitSnapshot;
  const [coordinator,connector,git]=await Promise.all([
    settled(api("/health")),
    settled(healthProbe(ctx)),
    settled(gitProbe(ctx))
  ]);
  const tasks=Object.values(ctx.store.data.tasks||{});
  const workers=Array.isArray(ctx.store.data.workerRecords)?ctx.store.data.workerRecords:[];
  const recentErrors=tasks.filter(t=>t?.status==="failed").slice(-5).map(t=>({id:t.id,title:t.title,error:String(t.error||"").slice(0,300)}));
  return {
    elapsedMs:Date.now()-started,
    runtime:{host:os.hostname(),platform:process.platform,pid:process.pid,uptimeSeconds:Math.round(process.uptime()),freeMemoryMB:Math.round(os.freemem()/1048576),load1:Number(os.loadavg?.()[0]||0)},
    connector,
    coordinator,
    git,
    transport:ctx.transportTelemetry?.snapshot(20)||{enabled:false},
    state:{tasks:counts(tasks),workers:counts(workers),activeGoals:Object.values(ctx.store.data.goals||{}).filter(g=>g&&!g.finishedAt).length,coordinatorLastError:ctx.store.data.coordinator?.lastError||null,recentErrors}
  };
}
export function registerDiagnosticsTools(reg,ctx){
  reg("diagnostics_snapshot",{
    description:"Connector/coordinator/git/runtime/task-worker/transport 상태를 독립적으로 병렬 조회해 한 번에 반환하는 read-only 진단 스냅샷.",
    inputSchema:{}
  },async()=>text(JSON.stringify(await collectDiagnostics(ctx),null,2)));
  reg("transport_telemetry_status",{
    description:"최근 MCP HTTP transport 메타데이터만 반환한다. prompt/body/header/raw URL/credential은 기록하거나 반환하지 않는다.",
    inputSchema:{}
  },async()=>text(JSON.stringify(ctx.transportTelemetry?.snapshot(50)||{enabled:false},null,2)));
}
