// Personal Cowork parity: client for always-on coordinator.
// Syncs device heartbeats, remote queue leases, local command tasks, and cloud-only scheduled HTTP jobs.
import os from "node:os";
import crypto from "node:crypto";
import { z } from "zod";
import { text, enforceCapabilities } from "../toolkit.js";
import { putCredential, getCredential, removeCredential } from "../credentials.js";
import { pinnedRequest } from "../net-safe.js";

const REMOTE_LEASE_HEARTBEAT_MS=Math.max(250,Number(process.env.WEBJJONKU_REMOTE_LEASE_HEARTBEAT_MS||8000));
const DEFAULT_SUBMIT_WAIT_MS=Math.max(0,Math.min(15000,Number(process.env.WEBJJONKU_COORDINATOR_SUBMIT_WAIT_MS||6000)));
const TERMINAL_REMOTE_STATUSES=new Set(["succeeded","failed","cancelled"]);
const backgroundStores=new WeakSet();

const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
export async function submitAndMaybeWait(api,body,{waitMs=0,pollMs=250}={}){
  let task,recoveredFromLostAck=false,submitError=null;
  try{
    task=await api("/v1/tasks",{method:"POST",body});
  }catch(error){
    if(!body?.idempotencyKey)throw error;
    try{
      const rows=await api("/v1/tasks?idempotency_key="+encodeURIComponent(body.idempotencyKey));
      if(!Array.isArray(rows)||rows.length!==1)throw error;
      task=rows[0];
      recoveredFromLostAck=true;
      submitError=String(error?.message||error).slice(0,500);
    }catch{throw error;}
  }
  const requested=Math.max(0,Math.min(15000,Number(waitMs)||0));
  const poll=Math.max(100,Math.min(2000,Number(pollMs)||250));
  if(!requested||!task?.id||TERMINAL_REMOTE_STATUSES.has(task.status)||["scheduled","waiting_for_device"].includes(task.status)){
    return recoveredFromLostAck?{...task,submitRecovery:{recovered:true,error:submitError}}:task;
  }
  const started=Date.now(),deadline=started+requested;
  let latest=task,pollError=null;
  while(Date.now()<deadline&&!TERMINAL_REMOTE_STATUSES.has(latest?.status)){
    await sleep(Math.min(poll,Math.max(1,deadline-Date.now())));
    try{
      latest=await api("/v1/tasks/"+encodeURIComponent(task.id));
    }catch(error){
      pollError=String(error?.message||error).slice(0,500);
      break;
    }
  }
  return {
    ...latest,
    ...(recoveredFromLostAck?{submitRecovery:{recovered:true,error:submitError}}:{}),
    wait:{requestedMs:requested,elapsedMs:Date.now()-started,terminal:TERMINAL_REMOTE_STATUSES.has(latest?.status),pollError}
  };
}

function ensure(store){
  if(!store.data.coordinator||typeof store.data.coordinator!=="object")store.data.coordinator={url:null,deviceId:"dev_"+crypto.createHash("sha256").update(os.hostname()+"|"+os.userInfo().username).digest("hex").slice(0,12),credentialName:null,lastHeartbeat:null,lastError:null};
  const c=store.data.coordinator;
  const forceEnv=process.env.WEBJJONKU_COORDINATOR_FORCE_ENV==="1";
  if(process.env.WEBJJONKU_COORDINATOR_URL&&(forceEnv||!c.url))c.url=String(process.env.WEBJJONKU_COORDINATOR_URL).replace(/\/$/,"");
  if(process.env.WEBJJONKU_COORDINATOR_DEVICE_ID)c.deviceId=String(process.env.WEBJJONKU_COORDINATOR_DEVICE_ID);
  if(forceEnv)c.credentialName=null;
  if(!store.data.tasks||typeof store.data.tasks!=="object"||Array.isArray(store.data.tasks))store.data.tasks={};
}
function cfg(store){ensure(store);return store.data.coordinator;}
function credName(deviceId){return "coordinator-api:"+deviceId;}
function coordinatorUrlPolicy(ctx,raw){
  const u=new URL(raw),loop=["127.0.0.1","localhost","::1"].includes(u.hostname);
  if(!["https:","http:"].includes(u.protocol))throw new Error("coordinator URL은 http/https만");
  const allowInsecureHttp=ctx.cfg.coordinator?.allowInsecureHttp===true||process.env.WEBJJONKU_COORDINATOR_ALLOW_INSECURE_HTTP==="1";
  const allowPrivateNetwork=ctx.cfg.coordinator?.allowPrivateNetwork===true||process.env.WEBJJONKU_COORDINATOR_ALLOW_PRIVATE==="1";
  if(u.protocol==="http:"&&!loop&&!allowInsecureHttp)throw new Error("public/private coordinator는 기본적으로 HTTPS 필요");
  return {u,loop,allowPrivate:loop||allowPrivateNetwork};
}
export async function coordinatorApi(ctx,p,{method="GET",body}={}){
  const c=cfg(ctx.store);if(!c.url)throw new Error("coordinator 미설정");
  const pol=coordinatorUrlPolicy(ctx,c.url),base=pol.u;
  const u=new URL(p.replace(/^\//,""),base.toString().replace(/\/?$/,"/"));
  const h={"accept":"application/json"};if(body!==undefined)h["content-type"]="application/json";
  const token=process.env.WEBJJONKU_COORDINATOR_FORCE_ENV==="1"?(process.env.WEBJJONKU_COORDINATOR_TOKEN||""):(c.credentialName?getCredential(ctx.cfg,c.credentialName):(process.env.WEBJJONKU_COORDINATOR_TOKEN||""));if(token)h.authorization="Bearer "+token;
  const res=await pinnedRequest(u,{method,headers:h,body:body===undefined?undefined:JSON.stringify(body),timeoutMs:10000,maxBytes:5*1024*1024,allowPrivateNetwork:pol.allowPrivate,allowLoopback:pol.loop});
  const raw=res.body.toString("utf8");let data;try{data=JSON.parse(raw);}catch{data=raw;}
  if(!res.ok)throw new Error("coordinator "+res.status+": "+JSON.stringify(data).slice(0,1000));
  return data;
}
export async function coordinatorPutBlob(ctx,key,buffer,{contentType="application/octet-stream",ifVersion}={}){
  const c=cfg(ctx.store);if(!c.url)throw new Error("coordinator 미설정");
  if(!/^[A-Za-z0-9._:-]{1,200}$/.test(key))throw new Error("invalid blob key");
  const pol=coordinatorUrlPolicy(ctx,c.url),u=new URL("/v1/blobs/"+encodeURIComponent(key),pol.u);
  const h={"content-type":contentType};if(ifVersion!==undefined)h["x-wjk-if-version"]=String(ifVersion);
  const secret=process.env.WEBJJONKU_COORDINATOR_FORCE_ENV==="1"?(process.env.WEBJJONKU_COORDINATOR_TOKEN||""):(c.credentialName?getCredential(ctx.cfg,c.credentialName):(process.env.WEBJJONKU_COORDINATOR_TOKEN||""));if(secret)h.authorization="Bearer "+secret;
  const res=await pinnedRequest(u,{method:"PUT",headers:h,body:buffer,timeoutMs:30000,maxBytes:5*1024*1024,allowPrivateNetwork:pol.allowPrivate,allowLoopback:pol.loop});
  const raw=res.body.toString("utf8");let data;try{data=JSON.parse(raw);}catch{data=raw;}if(!res.ok)throw new Error("blob PUT "+res.status+": "+JSON.stringify(data));
  return data;
}
export async function coordinatorGetBlob(ctx,key){
  const c=cfg(ctx.store);if(!c.url)throw new Error("coordinator 미설정");
  if(!/^[A-Za-z0-9._:-]{1,200}$/.test(key))throw new Error("invalid blob key");
  const pol=coordinatorUrlPolicy(ctx,c.url),u=new URL("/v1/blobs/"+encodeURIComponent(key),pol.u);const h={};
  const secret=process.env.WEBJJONKU_COORDINATOR_FORCE_ENV==="1"?(process.env.WEBJJONKU_COORDINATOR_TOKEN||""):(c.credentialName?getCredential(ctx.cfg,c.credentialName):(process.env.WEBJJONKU_COORDINATOR_TOKEN||""));if(secret)h.authorization="Bearer "+secret;
  const res=await pinnedRequest(u,{headers:h,timeoutMs:30000,maxBytes:50*1024*1024,allowPrivateNetwork:pol.allowPrivate,allowLoopback:pol.loop});if(!res.ok)throw new Error("blob GET "+res.status);
  return {buffer:res.body,version:Number(res.headers["x-wjk-version"]||0),contentType:res.headers["content-type"]||"application/octet-stream"};
}
function localTaskForRemote(store,remoteId){return Object.values(store.data.tasks).find(t=>t.remoteTaskId===remoteId);}
function makeLocalTask(store,ctx,rt){
  const id="task_"+crypto.randomBytes(5).toString("hex"),a=rt.action||{};
  const timeoutMs=Number(a.timeout_ms)||null;
  const t={id,title:rt.title||rt.id,status:"queued",steps:[{title:a.title||"remote command",command:a.command||"",cwd:a.cwd||ctx.cfg.roots[0],timeoutMs,status:"pending",output:null,exitCode:null}],cwd:a.cwd||ctx.cfg.roots[0],timeoutMs,dependsOn:[],projectId:a.projectId||null,localRequired:true,createdAt:new Date().toISOString(),startedAt:null,finishedAt:null,currentStep:null,error:null,events:[{ts:new Date().toISOString(),type:"remote_claimed",remoteTaskId:rt.id}],result:null,remoteTaskId:rt.id,remoteReported:false};
  store.data.tasks[id]=t;store.save();return t;
}

export function registerCoordinatorTools(reg,ctx){
  const {store}=ctx;ensure(store);
  let syncing=false,lastHeartbeat=0;
  const remoteCheckAt=new Map();
  const remoteLeaseHeartbeatAt=new Map();
  const terminalRemoteStatuses=TERMINAL_REMOTE_STATUSES;

  function markRemoteReported(lt,remoteStatus,reason){
    lt.remoteReported=true;
    if(!Array.isArray(lt.events))lt.events=[];
    lt.events.push({ts:new Date().toISOString(),type:"remote_reconciled",remoteStatus:remoteStatus||null,reason});
    if(lt.events.length>1000)lt.events=lt.events.slice(-1000);
  }
  async function reconcileTerminalConflict(lt,e){
    const msg=String(e?.message||e);
    if(!msg.includes("coordinator 409:"))return false;
    try{
      const rt=await coordinatorApi(ctx,"/v1/tasks/"+encodeURIComponent(lt.remoteTaskId));
      if(!terminalRemoteStatuses.has(rt?.status))return false;
      markRemoteReported(lt,rt.status,"remote task already terminal after report conflict");
      return true;
    }catch{return false;}
  }

  async function heartbeat(){
    const c=cfg(store);if(!c.url)return null;
    const capabilities=["local-files","command","browser","documents",...(process.platform==="win32"?["desktop","office-com","windows-browser-profile"]:["linux-sandbox"])];
    const r=await coordinatorApi(ctx,"/v1/devices/heartbeat",{method:"POST",body:{deviceId:c.deviceId,capabilities,meta:{hostname:os.hostname(),platform:process.platform}}});
    c.lastHeartbeat=new Date().toISOString();c.lastError=null;store.save();lastHeartbeat=Date.now();return r;
  }
  async function sync(){
    if(syncing)return;const c=cfg(store);if(!c.url)return;syncing=true;
    let stateChanged=false,syncError=null;
    try{
      if(Date.now()-lastHeartbeat>10000)await heartbeat();
      const queued=await coordinatorApi(ctx,"/v1/poll?device_id="+encodeURIComponent(c.deviceId));
      for(const rt of queued){
        if(rt.executor!=="device"||rt.action?.type!=="command")continue;
        let lt=localTaskForRemote(store,rt.id);
        try{await coordinatorApi(ctx,"/v1/tasks/"+encodeURIComponent(rt.id)+"/claim",{method:"POST",body:{deviceId:c.deviceId}});}catch(e){continue;}
        if(!lt)lt=makeLocalTask(store,ctx,rt);
        else if(!["succeeded","running","queued"].includes(lt.status)){lt.status="queued";lt.finishedAt=null;lt.error=null;for(const s of lt.steps)if(["failed","cancelled"].includes(s.status))s.status="pending";store.save();}
      }
      for(const lt of Object.values(store.data.tasks).filter(t=>t.remoteTaskId&&!t.remoteReported)){
        if(["queued","running","paused"].includes(lt.status)){
          if(["queued","running"].includes(lt.status)){
            const leaseDue=remoteLeaseHeartbeatAt.get(lt.id)||0;
            if(Date.now()>=leaseDue){
              remoteLeaseHeartbeatAt.set(lt.id,Date.now()+REMOTE_LEASE_HEARTBEAT_MS);
              try{
                await coordinatorApi(ctx,"/v1/tasks/"+encodeURIComponent(lt.remoteTaskId)+"/heartbeat",{method:"POST",body:{deviceId:c.deviceId}});
              }catch(e){
                if(await reconcileTerminalConflict(lt,e)){stateChanged=true;}
                else syncError??=String(e?.message||e);
              }
            }
          }
          if(["running","paused"].includes(lt.status)&&!lt.remoteReported){
            const due=remoteCheckAt.get(lt.id)||0;
            if(Date.now()>=due){
              remoteCheckAt.set(lt.id,Date.now()+30000);
              try{
                const rt=await coordinatorApi(ctx,"/v1/tasks/"+encodeURIComponent(lt.remoteTaskId));
                if(terminalRemoteStatuses.has(rt?.status)){
                  markRemoteReported(lt,rt.status,"remote task terminal while local task inactive or detached");
                  stateChanged=true;
                }
              }catch(e){syncError??=String(e?.message||e);}
            }
          }
          continue;
        }
        try{
          if(lt.status==="succeeded"){
            await coordinatorApi(ctx,"/v1/tasks/"+encodeURIComponent(lt.remoteTaskId)+"/complete",{method:"POST",body:{deviceId:c.deviceId,result:{localTaskId:lt.id,steps:lt.steps.map(s=>({title:s.title,exitCode:s.exitCode,output:(s.output||"").slice(-20000)}))}}});
          }else if(lt.status==="failed"){
            await coordinatorApi(ctx,"/v1/tasks/"+encodeURIComponent(lt.remoteTaskId)+"/fail",{method:"POST",body:{deviceId:c.deviceId,error:lt.error||"local task failed"}});
          }else if(lt.status==="cancelled"){
            await coordinatorApi(ctx,"/v1/tasks/"+encodeURIComponent(lt.remoteTaskId)+"/cancel",{method:"POST",body:{deviceId:c.deviceId}});
          }else continue;
          markRemoteReported(lt,lt.status,"remote report accepted");stateChanged=true;
        }catch(e){
          if(await reconcileTerminalConflict(lt,e)){stateChanged=true;}
          else syncError??=String(e?.message||e);
        }
      }
      if(c.lastError!==syncError){c.lastError=syncError;stateChanged=true;}
      if(stateChanged)store.save();
    }catch(e){const msg=String(e.message||e);if(c.lastError!==msg){c.lastError=msg;store.save();}}
    finally{syncing=false;}
  }
  // MCP reconnects share a Store. Keep one background sync after sessions close,
  // so durable work survives disconnects without accumulating poll/report loops.
  if(!backgroundStores.has(store)){
    backgroundStores.add(store);
    const timer=setInterval(()=>sync().catch(()=>{}),1000);timer.unref?.();
  }

  reg("coordinator_configure",{
    description:"항상 켜진 coordinator URL과 이 기기의 identity를 설정한다. api_secret은 credential broker에 암호화 저장한다.",
    inputSchema:{url:z.string().url(),device_id:z.string().optional(),api_secret:z.string().optional()}
  },async({url,device_id,api_secret})=>{
    const {u}=coordinatorUrlPolicy(ctx,url);
    const c=cfg(store);if(device_id)c.deviceId=device_id;c.url=u.toString().replace(/\/$/,"");
    if(api_secret){const n=credName(c.deviceId);putCredential(ctx.cfg,n,api_secret,{purpose:"coordinator-api",deviceId:c.deviceId});c.credentialName=n;}
    store.save();await heartbeat();return text(JSON.stringify(c,null,2));
  });

  reg("coordinator_status",{description:"coordinator 연결/기기 heartbeat/오류 상태를 확인한다.",inputSchema:{}},async()=>{
    const c=cfg(store);let health=null;if(c.url)try{health=await coordinatorApi(ctx,"/health");}catch(e){health={ok:false,error:e.message};}
    return text(JSON.stringify({config:{url:c.url,deviceId:c.deviceId,lastHeartbeat:c.lastHeartbeat,lastError:c.lastError,credentialStored:!!c.credentialName},health},null,2));
  });

  reg("coordinator_heartbeat",{description:"현재 기기가 온라인임을 coordinator에 즉시 알린다.",inputSchema:{}},async()=>text(JSON.stringify(await heartbeat(),null,2)));

  reg("coordinator_submit",{
    description:"원격 coordinator에 작업을 등록한다. 빠른 device 작업은 bounded wait로 한 호출 안에서 완료 결과까지 받을 수 있고, 시간이 넘으면 durable task ID/state를 반환한다. PC가 오프라인이면 waiting_for_device가 되고 재접속 후 자동 claim/resume된다.",
    inputSchema:{
      title:z.string(),executor:z.enum(["device","cloud"]).optional(),local_required:z.boolean().optional(),target_device:z.string().optional(),run_at:z.string().optional(),idempotency_key:z.string().optional(),max_attempts:z.number().int().min(1).max(10).optional(),retry_on_lease_expiry:z.boolean().optional(),
      wait_ms:z.number().int().min(0).max(15000).optional().describe("submit 뒤 terminal 상태를 내부에서 기다릴 최대 시간. 미지정 device 즉시 작업은 기본 6초, 0이면 즉시 반환."),
      poll_ms:z.number().int().min(100).max(2000).optional().describe("bounded wait 내부 poll 간격. 기본 250ms."),
      action:z.object({type:z.enum(["command","http"]),command:z.string().optional(),cwd:z.string().optional(),timeout_ms:z.number().int().min(5000).max(24*60*60*1000).optional(),url:z.string().url().optional(),method:z.string().optional(),body:z.any().optional(),headers:z.record(z.string()).optional()})
    }
  },async({title,executor="device",local_required=true,target_device,run_at,idempotency_key,max_attempts=1,retry_on_lease_expiry=false,wait_ms,poll_ms=250,action})=>{
    const caps=["coordinator.submit"];if(action?.type==="command")caps.push("exec.command");if(action?.type==="http")caps.push("saas.request");
    enforceCapabilities(ctx,caps,"coordinator_submit",{title,executor,local_required,target_device,run_at,idempotency_key,max_attempts,retry_on_lease_expiry,wait_ms,poll_ms,action});
    const c=cfg(store);const body={title,executor,localRequired:local_required,targetDevice:target_device||(executor==="device"?c.deviceId:null),runAt:run_at||null,idempotencyKey:idempotency_key||null,maxAttempts:max_attempts,retryOnLeaseExpiry:retry_on_lease_expiry,action};
    const effectiveWait=wait_ms===undefined?(executor==="device"&&!run_at?DEFAULT_SUBMIT_WAIT_MS:0):wait_ms;
    return text(JSON.stringify(await submitAndMaybeWait((p,o)=>coordinatorApi(ctx,p,o),body,{waitMs:effectiveWait,pollMs:poll_ms}),null,2));
  });

  reg("coordinator_tasks",{description:"원격 coordinator 작업 목록을 조회한다. 제출/대기 중인 다른 target device 작업도 포함한다.",inputSchema:{status:z.string().optional(),device_id:z.string().optional()}},async({status,device_id})=>{
    const q=[];if(device_id)q.push("device_id="+encodeURIComponent(device_id));if(status)q.push("status="+encodeURIComponent(status));
    const p="/v1/tasks"+(q.length?"?"+q.join("&"):"");return text(JSON.stringify(await coordinatorApi(ctx,p),null,2));
  });

  reg("coordinator_cancel",{description:"원격 coordinator 작업을 취소하고, 이 프로세스에서 실행 중인 대응 로컬 Task가 있으면 함께 종료한다.",inputSchema:{id:z.string()}},async({id})=>{
    enforceCapabilities(ctx,["coordinator.submit"],"coordinator_cancel",{id});
    const c=cfg(store),remote=await coordinatorApi(ctx,"/v1/tasks/"+encodeURIComponent(id)+"/cancel",{method:"POST",body:{deviceId:c.deviceId}});
    const lt=localTaskForRemote(store,id);
    if(lt){ctx.cancelTaskRuntime?.(lt.id,"Remote coordinator task cancelled");lt.remoteReported=true;store.save();}
    return text(JSON.stringify(remote,null,2));
  });

  reg("coordinator_sync",{description:"heartbeat + 원격 queue claim + 로컬 Task Manager 연동 + 결과 보고를 즉시 수행한다.",inputSchema:{}},async()=>{await sync();return text(JSON.stringify(cfg(store),null,2));});

  reg("coordinator_clear",{description:"로컬 coordinator 설정을 제거한다. 원격 서버 데이터는 삭제하지 않는다.",inputSchema:{}},async()=>{
    const c=cfg(store);if(c.credentialName)removeCredential(ctx.cfg,c.credentialName);store.data.coordinator={url:null,deviceId:c.deviceId,credentialName:null,lastHeartbeat:null,lastError:null};store.save();return text("coordinator 설정 제거됨");
  });
}
