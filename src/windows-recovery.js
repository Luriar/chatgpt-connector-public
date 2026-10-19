import crypto from "node:crypto";

const time=value=>{const n=Date.parse(value||"");return Number.isFinite(n)?n:null;};
export function classifyWindowsToolTasks(tasks,device,{now=Date.now(),busyGraceMs=180000,deviceStaleMs=60000}={}){
  const active=(tasks||[]).filter(t=>t?.status==="running"&&t.action?.type==="tool");
  for(const task of active){
    const ageMs=Math.max(0,now-(time(task.startedAt||task.createdAt)??now));
    const leaseUntil=time(task.leaseUntil);
    const deadline=device?.meta?.activeTaskId===task.id?time(device.meta.activeCallDeadline):null;
    if(deadline!==null&&now>deadline+10000)return {status:"stale",taskId:task.id,reason:"worker_call_deadline_expired",ageMs};
    if(ageMs>busyGraceMs&&leaseUntil!==null&&leaseUntil<now)return {status:"stale",taskId:task.id,reason:"expired_task_lease",ageMs};
  }
  const lastSeen=time(device?.lastSeen);
  if(lastSeen!==null&&Math.max(0,now-lastSeen)>deviceStaleMs)return {status:"stale",reason:"worker_heartbeat_stale",ageMs:Math.max(0,now-lastSeen)};
  if(active.length)return {status:"busy",activeToolTasks:active.length,reason:"active_tool_task",verified:false};
  return {status:"idle"};
}

// Dependency injection keeps failure/recovery classification tests off the live worker.
export async function probeWindowsToolPath({api,deviceId,timeoutMs=8000,busyGraceMs=180000,now=Date.now,sleep=ms=>new Promise(r=>setTimeout(r,ms)),idempotencyKey="windows-recovery:"+deviceId+":"+crypto.randomUUID()}){
  const start=now(),end=start+timeoutMs;
  const request=(url,options={})=>{
    const left=end-now();
    if(left<=0)throw new Error("probe budget exhausted");
    return api(url,{...options,timeout:Math.max(1,Math.min(3000,left))});
  };
  const runningPath="/v1/tasks?device_id="+encodeURIComponent(deviceId)+"&status=running&limit=100";
  const result=(status,fields={})=>({ok:status==="probe_succeeded",status,deviceId,verified:status==="probe_succeeded",repairEligible:false,durationMs:now()-start,...fields});
  let created;
  try{
    const [rows,devices]=await Promise.all([request(runningPath),request("/v1/devices")]);
    const device=(Array.isArray(devices)?devices:[]).find(d=>d.deviceId===deviceId);
    const classification=classifyWindowsToolTasks(Array.isArray(rows)?rows:[],device,{now:now(),busyGraceMs});
    if(classification.status==="busy")return result("busy",classification);
    if(classification.status==="stale")return result("stale",{...classification,repairEligible:true});
    const body={title:"Windows recovery E2E probe",executor:"device",localRequired:true,targetDevice:deviceId,maxAttempts:1,retryOnLeaseExpiry:false,idempotencyKey,retentionClass:"ephemeral",action:{type:"tool",tool:"computer_uia_status",args:{}}};
    try{created=await request("/v1/tasks",{method:"POST",body});}
    catch(error){
      // Recover a lost submission ACK before considering another submission.
      const matches=await request("/v1/tasks?idempotency_key="+encodeURIComponent(idempotencyKey)+"&limit=1");
      created=Array.isArray(matches)?matches.find(t=>t.idempotencyKey===idempotencyKey):null;
      if(!created)return result("coordinator_unavailable",{error:String(error.message||error).slice(0,300),idempotencyKey});
    }
    let latest=created;
    while(now()<end){
      if(latest.status==="succeeded"){
        const mcp=latest.result?.mcpResult;
        if(!mcp||mcp.isError===true||!Array.isArray(mcp.content))return result("probe_failed",{taskId:created.id,repairEligible:true,reason:"invalid_mcp_result"});
        return result("probe_succeeded",{taskId:created.id});
      }
      if(["failed","cancelled"].includes(latest.status))return result("probe_failed",{taskId:created.id,repairEligible:true,reason:String(latest.error||latest.status).slice(0,300)});
      if(latest.status==="waiting_for_device")return result("worker_offline",{taskId:created.id,repairEligible:true});
      await sleep(Math.min(250,Math.max(1,end-now())));
      if(now()<end)latest=await request("/v1/tasks/"+encodeURIComponent(created.id));
    }
    const current=await api(runningPath,{timeout:1500});
    const other=(Array.isArray(current)?current:[]).filter(t=>t.id!==created.id);
    if(other.some(t=>t.action?.type==="tool"))return result("busy",{taskId:created.id,reason:"work_started_during_probe"});
    return result("probe_timeout",{taskId:created.id,repairEligible:true});
  }catch(error){
    // Network/auth failures are upstream failures, not evidence to kill a worker.
    return result("coordinator_unavailable",{taskId:created?.id||null,idempotencyKey,error:String(error?.message||error).slice(0,300)});
  }finally{
    if(created?.id){
      // Only our harmless probe may be cancelled. Never touch another task here.
      try{
        const actual=await api("/v1/tasks/"+encodeURIComponent(created.id),{timeout:1000});
        if(!["succeeded","failed","cancelled"].includes(actual.status))await api("/v1/tasks/"+encodeURIComponent(created.id)+"/cancel",{method:"POST",body:{deviceId},timeout:1000});
      }catch{}
    }
  }
}
