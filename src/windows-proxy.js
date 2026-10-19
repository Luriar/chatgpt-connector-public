import crypto from "node:crypto";
import { pinnedRequest } from "./net-safe.js";
import { currentWorkspace } from "./workspaces.js";
import { currentGoal } from "./session-state.js";

const WIN_ONLY_PREFIXES=["desktop_","computer_","office_live_"];
const WIN_BROWSER_PREFIX="browser_";
const WIN_BROWSER_SKIP=new Set([]);
const WINDOWS_PATH_RE=/^(?:[A-Za-z]:[\\/]|\\\\)/;

function enabled(){
  return process.platform!=="win32" && process.env.WEBJJONKU_WINDOWS_TOOL_PROXY==="1";
}
function hasWindowsPath(v,depth=0){
  if(depth>5||v==null)return false;
  if(typeof v==="string")return WINDOWS_PATH_RE.test(v);
  if(Array.isArray(v))return v.some(x=>hasWindowsPath(x,depth+1));
  if(typeof v==="object")return Object.values(v).some(x=>hasWindowsPath(x,depth+1));
  return false;
}
export function shouldProxyWindowsTool(name,args={}){
  if(!enabled())return false;
  if(WIN_ONLY_PREFIXES.some(p=>name.startsWith(p)))return true;
  if(name.startsWith(WIN_BROWSER_PREFIX)&&!WIN_BROWSER_SKIP.has(name))return true;
  if(name.startsWith("worker_")){
    if(String(args.host||"").toLowerCase()==="windows"||String(args.id||"").startsWith("ww"))return true;
  }
  if(name.startsWith("codex_"))return true;
  if(/^task_(status|result|events|checkpoint|pause|resume|cancel|steer|retry)$/.test(name)&&/^task_win_[a-f0-9]+$/.test(String(args.id||"")))return true;
  if(name.startsWith("fs_")&&hasWindowsPath(args))return true;
  if(name==="exec_command"){
    const shell=String(args.shell||"").toLowerCase();
    if(["powershell","pwsh","cmd"].includes(shell)||hasWindowsPath(args.cwd))return true;
  }
  if((name.startsWith("excel_")||name.startsWith("pdf_")||name.startsWith("office_"))&&hasWindowsPath(args))return true;
  return false;
}

function baseUrl(){
  const raw=process.env.WEBJJONKU_COORDINATOR_URL;
  if(!raw)throw new Error("Windows tool proxy requires coordinator URL");
  return String(raw).replace(/\/$/,"");
}
function headers(json=true){
  const h={accept:"application/json"};
  if(json)h["content-type"]="application/json";
  const token=process.env.WEBJJONKU_COORDINATOR_TOKEN||"";
  if(token)h.authorization="Bearer "+token;
  return h;
}
async function api(path,{method="GET",body,timeoutMs=8000}={}){
  try{
    const base=new URL(baseUrl());
    const loopback=["127.0.0.1","localhost","::1"].includes(base.hostname);
    const allowPrivate=loopback||process.env.WEBJJONKU_COORDINATOR_ALLOW_PRIVATE==="1";
    const allowInsecure=loopback||process.env.WEBJJONKU_COORDINATOR_ALLOW_INSECURE_HTTP==="1";
    if(base.protocol==="http:"&&!allowInsecure)throw new Error("Windows tool proxy coordinator requires HTTPS or explicit insecure-HTTP opt-in");
    const payload=body===undefined?undefined:JSON.stringify(body);
    const res=await pinnedRequest(new URL(path,base),{
      method,
      headers:headers(body!==undefined),
      body:payload,
      timeoutMs:Math.max(1,timeoutMs),
      maxBytes:5*1024*1024,
      allowPrivateNetwork:allowPrivate,
      allowLoopback:loopback
    });
    const raw=res.body.toString("utf8");
    let data=null;try{data=raw?JSON.parse(raw):null;}catch{data={error:raw};}
    if(!res.ok)throw new Error(data?.error||("coordinator HTTP "+res.status));
    return data;
  }catch(e){
    const msg=String(e?.message||e);
    if(e?.name==="AbortError"||/request timeout/i.test(msg))throw Object.assign(new Error("Windows tool proxy coordinator request timeout"),{code:"PROXY_REQUEST_TIMEOUT"});
    throw e;
  }
}
function sleep(ms){return new Promise(r=>setTimeout(r,ms));}
function uncertainRequest(e){return e?.code==="PROXY_REQUEST_TIMEOUT"||["ECONNRESET","ETIMEDOUT","EPIPE"].includes(e?.code)||/response aborted/i.test(String(e?.message||""));}
function receipt(task,extra=""){
  const reference=task.id?`work_status{id:"${task.id}"}`:`coordinator_tasks: idempotency_key=${task.idempotencyKey}`;
  return {content:[{type:"text",text:`Windows 작업이 coordinator에 접수되었거나 접수 확인 중입니다. ${extra}\n확인: ${reference}\n같은 작업을 새로 제출하지 말고 이 식별자로 상태를 확인하세요.`}],_meta:{taskId:task.id||null,idempotencyKey:task.idempotencyKey,status:task.status||"submission_unknown"}};
}
function boundedResult(result,task){
  const maxBytes=Math.max(4096,Math.min(256*1024,Number(process.env.WEBJJONKU_WINDOWS_TOOL_RESULT_MAX_BYTES)||64*1024));
  if(Buffer.byteLength(JSON.stringify(result))<=maxBytes)return result;
  const preview=(result.content||[]).filter(x=>x.type==="text").map(x=>x.text).join("\n").slice(0,Math.floor(maxBytes/4));
  return {...receipt(task,`작업 결과가 커서 요약만 반환합니다. 전체 결과는 coordinator 작업에 보관되어 있습니다.\n${preview}`),...(result.isError?{isError:true}:{})};
}

export async function maybeProxyWindowsTool(ctx,name,args={}){
  if(!shouldProxyWindowsTool(name,args))return null;
  const routedArgs={...args};
  if(name==="worker_spawn"&&!routedArgs.workspace_id){
    const goal=ctx.store?currentGoal(ctx):null;
    const ws=ctx.store?currentWorkspace(ctx):null;
    const localLineage=ws?.lineageId||goal?.lineageId||goal?.id;
    if(!routedArgs.lineage_id)routedArgs.lineage_id=localLineage;
    if(!routedArgs.goal_id&&routedArgs.lineage_id===localLineage)routedArgs.goal_id=goal?.id||ws?.goalId;
  }
  const target=process.env.WEBJJONKU_WINDOWS_TOOL_DEVICE_ID||"windows-worker";
  const resilience=ctx.cfg?.resilience||{};
  const timeout=Math.max(5_000,Math.min(120_000,Number(process.env.WEBJJONKU_WINDOWS_TOOL_TIMEOUT_MS)||60_000));
  const durableWait=Math.max(500,Math.min(5000,Number(process.env.WEBJJONKU_DURABLE_FOREGROUND_WAIT_MS||resilience.durableForegroundWaitMs||2500)));
  const toolForegroundWait=Math.max(1000,Math.min(8000,Number(process.env.WEBJJONKU_WINDOWS_TOOL_FOREGROUND_WAIT_MS||resilience.windowsToolForegroundWaitMs||4000)));
  const submitTimeout=Math.max(3000,Math.min(20000,Number(process.env.WEBJJONKU_WINDOWS_TOOL_SUBMIT_TIMEOUT_MS||resilience.windowsSubmitTimeoutMs||8000)));
  const shell=String(args.shell||"auto").toLowerCase();
  const durableThresholdMs=Math.max(5000,Number(resilience.durableThresholdMs)||20000);
  const durableRequested=args.durable===true||Number(args.timeout_ms||0)>durableThresholdMs;
  const durableCommand=name==="exec_command"&&durableRequested&&!args.session&&["auto","powershell","pwsh",""].includes(shell);
  const foregroundWait=durableCommand?durableWait:Math.min(timeout,toolForegroundWait);
  const submitTask=async body=>{
    const payload={...body,idempotencyKey:body.idempotencyKey||("windows-proxy:"+crypto.randomUUID())};
    const lookup=async()=>{
      try{
        const rows=await api("/v1/tasks?idempotency_key="+encodeURIComponent(payload.idempotencyKey)+"&limit=1",{timeoutMs:Math.min(3000,submitTimeout)});
        return Array.isArray(rows)?rows.find(t=>t.idempotencyKey===payload.idempotencyKey):null;
      }catch{return null;}
    };
    for(let attempt=0;attempt<2;attempt++){
      try{return await api("/v1/tasks",{method:"POST",body:payload,timeoutMs:submitTimeout});}
      catch(e){
        if(!uncertainRequest(e))throw e;
        // Resolve an ambiguous ACK before resubmitting the identical idempotency key.
        const recovered=await lookup();
        if(recovered)return recovered;
        if(attempt>0)return {status:"submission_unknown",idempotencyKey:payload.idempotencyKey};
        await sleep(100);
      }
    }
  };
  const poll=async(created,render)=>{
    if(!created.id)return receipt(created);
    if(["succeeded","failed","cancelled","waiting_for_device"].includes(created.status))return render(created);
    const end=Date.now()+foregroundWait;
    let latest=created;
    while(Date.now()<end){
      try{latest=await api("/v1/tasks/"+encodeURIComponent(created.id),{timeoutMs:Math.max(1,Math.min(3000,end-Date.now()))});}
      catch(e){if(uncertainRequest(e))break;throw e;}
      if(latest.status==="failed")throw new Error(latest.error||"Windows tool worker failed");
      if(latest.status==="cancelled")throw new Error("Windows tool task cancelled");
      if(["succeeded","waiting_for_device"].includes(latest.status))return render(latest);
      const remaining=end-Date.now();
      if(remaining>0)await sleep(Math.min(250,remaining));
    }
    // Do not start a final network request after the budget has expired.
    return render(latest);
  };
  if(durableCommand){
    const created=await submitTask({
      title:"Windows command: "+String(args.command||"").slice(0,80),
      executor:"device",localRequired:true,targetDevice:target,maxAttempts:1,retryOnLeaseExpiry:false,
      action:{type:"command",command:String(args.command||""),...(args.cwd?{cwd:args.cwd}:{}),...(args.timeout_ms!==undefined?{timeout_ms:args.timeout_ms}:{})}
    });
    const render=(t)=>{
      if(t.status==="waiting_for_device")return {content:[{type:"text",text:`🛟 durable Windows task ${t.id} 대기 중이야. PC가 꺼져 있어도 coordinator에 보관되고 ${target}가 다시 온라인이 되면 claim돼.\n상태: work_status{id:"${t.id}"}`} ]};
      if(t.status==="succeeded"){
        const steps=Array.isArray(t.result?.steps)?t.result.steps:[];
        const out=steps.map(s=>s.output||"").filter(Boolean).join("\n");
        const exit=steps.length?steps[steps.length-1].exitCode:0;
        return boundedResult({content:[{type:"text",text:`[exit ${exit} · durable Windows · ${args.cwd||"default"}]\n${out}`} ]},t);
      }
      return {content:[{type:"text",text:`🛟 durable Windows task ${t.id}로 계속 실행 중이야. ChatGPT 스트림이 끊겨도 coordinator가 상태를 유지해.\n상태: work_status{id:"${t.id}"}`} ]};
    };
    if(created.status==="waiting_for_device")return render(created);
    return poll(created,render);
  }
  const created=await submitTask({
    title:"Windows tool: "+name,
    executor:"device",
    localRequired:true,
    targetDevice:target,
    maxAttempts:1,retryOnLeaseExpiry:false,
    action:{type:"tool",tool:name,args:routedArgs}
  });
  const render=(t)=>{
    if(t.status==="succeeded"){
      const r=t.result?.mcpResult;
      if(!r||typeof r!=="object")throw new Error("Windows worker returned invalid MCP result");
      return boundedResult(r,t);
    }
    if(t.status==="failed")throw new Error(t.error||"Windows tool worker failed");
    if(t.status==="cancelled")throw new Error("Windows tool task cancelled");
    if(t.status==="waiting_for_device")throw new Error("Windows worker offline: "+target);
    return {content:[{type:"text",text:`🛟 Windows tool task ${created.id}가 계속 실행 중이야. foreground 요청은 ${foregroundWait}ms에서 반환했고 Windows worker는 계속 처리해.\n상태: work_status{id:"${created.id}"}`}]};
  };
  if(created.status==="waiting_for_device")return render(created);
  return poll(created,render);
}
