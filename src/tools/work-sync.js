// ChatGPT Work parity: cross-device session/goal/task-state sync via coordinator blobs.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { z } from "zod";
import { text, enforcePolicy } from "../toolkit.js";
import { resolveInRoots, redact } from "../security.js";
import { coordinatorPutBlob, coordinatorGetBlob, coordinatorApi } from "./coordinator.js";
import { putCredential, getCredential } from "../credentials.js";
import { currentGoal, currentEffort, setCurrentGoal } from "../session-state.js";
import { ensureWorkspace, bindWorkspace, currentWorkspace, listWorkspaces } from "../workspaces.js";

function ensure(store){
  if(!store.data.workSync||typeof store.data.workSync!=="object")store.data.workSync={profileId:null,cloudVersion:null,lastSyncAt:null,lastPullAt:null,conflicts:[],remoteGoalCandidate:null,signatureRequired:false,lastSignatureVerified:null};
  if(store.data.workSync.remoteGoalCandidate===undefined)store.data.workSync.remoteGoalCandidate=null;
  if(store.data.workSync.signatureRequired===undefined)store.data.workSync.signatureRequired=false;
  if(store.data.workSync.lastSignatureVerified===undefined)store.data.workSync.lastSignatureVerified=null;
  if(!store.data.syncedTaskShadows||typeof store.data.syncedTaskShadows!=="object")store.data.syncedTaskShadows={};
}
function safeId(v,label="id"){const s=String(v||"");if(!/^[A-Za-z0-9._:-]{1,160}$/.test(s))throw new Error("invalid "+label);return s;}
function key(profileId){return "workstate_"+safeId(profileId,"profile id");}
function signingCredential(profileId){return "work-sync-sign:"+safeId(profileId,"profile id");}
function hmac(secret,payload){return crypto.createHmac("sha256",String(secret)).update(payload).digest("base64url");}
function safeSigEqual(a,b){try{const x=Buffer.from(String(a||"")),y=Buffer.from(String(b||""));return x.length===y.length&&x.length>0&&crypto.timingSafeEqual(x,y);}catch{return false;}}
function encodeManifest(ctx){
  const m=manifest(ctx),payload=Buffer.from(JSON.stringify(m));
  const secret=getCredential(ctx.cfg,signingCredential(m.profileId));
  if(!secret)return {buffer:payload,signed:false};
  const envelope={format:"wjk-work-sync-hmac-v1",profileId:m.profileId,payload:payload.toString("base64"),hmac:hmac(secret,payload)};
  return {buffer:Buffer.from(JSON.stringify(envelope)),signed:true};
}
function decodeManifest(ctx,buffer,profileId){
  const parsed=JSON.parse(buffer.toString("utf8")),s=ctx.store.data.workSync;
  if(parsed?.format==="wjk-work-sync-hmac-v1"){
    if(parsed.profileId!==profileId)throw new Error("sync envelope profile mismatch");
    const secret=getCredential(ctx.cfg,signingCredential(profileId));if(!secret)throw new Error("signed sync snapshot but local signing key missing");
    const payload=Buffer.from(String(parsed.payload||""),"base64"),expected=hmac(secret,payload);
    if(!safeSigEqual(parsed.hmac,expected))throw new Error("sync manifest signature verification failed");
    const remote=JSON.parse(payload.toString("utf8"));if(remote.profileId!==profileId)throw new Error("sync profile mismatch");
    return {remote,signed:true};
  }
  if(s.signatureRequired)throw new Error("unsigned sync snapshot rejected by signatureRequired");
  if(parsed.profileId!==profileId)throw new Error("sync profile mismatch");
  return {remote:parsed,signed:false};
}
function sessionContent(rec){try{return fs.readFileSync(rec.file,"utf8");}catch{return null;}}
function slimTask(t,cfg){
  return {
    id:safeId(t.id,"task id"),title:String(t.title||"").slice(0,500),status:t.status,
    steps:(t.steps||[]).slice(0,500).map(s=>({title:String(s.title||"").slice(0,500),command:typeof s.command==="string"?redact(cfg,s.command):undefined,status:s.status,exitCode:s.exitCode??null})),
    dependsOn:(t.dependsOn||[]).map(x=>safeId(x,"dependency id")),projectId:t.projectId?safeId(t.projectId,"project id"):null,
    localRequired:t.localRequired!==false,createdAt:t.createdAt||null,startedAt:t.startedAt||null,finishedAt:t.finishedAt||null,currentStep:t.currentStep??null,error:t.error?String(t.error).slice(0,2000):null
  };
}
function manifest(ctx){
  ensure(ctx.store);
  const s=ctx.store.data.workSync;
  return {
    schema:1,profileId:s.profileId,updatedAt:new Date().toISOString(),
    effort:currentEffort(ctx),
    goal:currentGoal(ctx),
    notes:(ctx.store.data.notes||[]).slice(-500),
    sessions:(ctx.store.data.sessions||[]).slice(-50).map(r=>({id:r.id,createdAt:r.createdAt,goalId:r.goalId||null,content:sessionContent(r)})).filter(x=>x.content),
    taskShadows:Object.fromEntries(Object.entries(ctx.store.data.tasks||{}).map(([id,t])=>[safeId(id,"task id"),slimTask(t,ctx.cfg)])),
    activeProjectId:ctx.store.data.activeProjectId||null
  };
}
function mergeNotes(local,remote){
  const m=new Map();for(const n of [...(local||[]),...(remote||[])])m.set((n.ts||"")+"|"+(n.note||""),n);
  return [...m.values()].sort((a,b)=>String(a.ts).localeCompare(String(b.ts))).slice(-500);
}
function activeGoal(g){return g&&!g.finishedAt;}
function validateRemoteGoal(g){
  if(g===null||g===undefined)return null;if(!g||typeof g!=="object")throw new Error("invalid remote goal");
  const title=String(g.title||"").slice(0,500),steps=Array.isArray(g.steps)?g.steps.slice(0,100).map(s=>({text:String(s?.text||"").slice(0,2000),done:!!s?.done,note:s?.note===null||s?.note===undefined?null:String(s.note).slice(0,5000)})):[];
  if(!title||!steps.length)throw new Error("invalid remote goal");
  return {id:safeId(g.id||("remote_"+Date.now()),"goal id"),title,steps,doneCriteria:g.doneCriteria===null||g.doneCriteria===undefined?null:String(g.doneCriteria).slice(0,5000),createdAt:g.createdAt||new Date().toISOString(),finishedAt:g.finishedAt||null,summary:g.summary===null||g.summary===undefined?null:String(g.summary).slice(0,10000)};
}

export function registerWorkSyncTools(reg,ctx){
  const {store,cfg}=ctx;ensure(store);

  reg("work_sync_configure",{
    description:"cross-device Work 상태 동기화 profile id를 설정한다. signing_secret을 같은 값으로 각 기기에 넣으면 coordinator 변조를 검출하는 HMAC 서명 검증을 사용할 수 있다.",
    inputSchema:{profile_id:z.string().regex(/^[A-Za-z0-9._:-]{1,120}$/),signing_secret:z.string().min(16).max(2048).optional(),require_signature:z.boolean().optional()}
  },async({profile_id,signing_secret,require_signature})=>{
    ensure(store);const s=store.data.workSync,switching=s.profileId!==profile_id;
    if(signing_secret)putCredential(cfg,signingCredential(profile_id),signing_secret,{purpose:"work-sync-hmac",profileId:profile_id});
    const hasKey=!!getCredential(cfg,signingCredential(profile_id));
    const required=require_signature===undefined?(switching?hasKey:(s.signatureRequired||hasKey)):require_signature;
    if(required&&!hasKey)throw new Error("require_signature=true requires signing_secret or existing signing key");
    s.profileId=profile_id;s.cloudVersion=null;s.signatureRequired=required;s.lastSignatureVerified=null;store.save();
    return text(JSON.stringify({...s,signingKeyStored:hasKey},null,2));
  });

  reg("work_sync_status",{description:"cross-device Work sync profile/version/conflict 상태를 본다.",inputSchema:{}},async()=>{
    ensure(store);return text(JSON.stringify(store.data.workSync,null,2));
  });

  reg("work_sync_push",{
    description:"현재 goal/notes/handoff/task 상태를 coordinator에 versioned snapshot으로 올린다. 동시 수정 충돌은 409로 차단된다.",
    inputSchema:{force:z.boolean().optional()}
  },async({force=false})=>{
    ensure(store);const s=store.data.workSync;if(!s.profileId)throw new Error("work_sync_configure 먼저");
    const encoded=encodeManifest(ctx),body=encoded.buffer;
    if(s.signatureRequired&&!encoded.signed)throw new Error("signatureRequired but signing key unavailable");
    const meta=await coordinatorPutBlob(ctx,key(s.profileId),body,{contentType:"application/json",ifVersion:force?undefined:(s.cloudVersion??undefined)});
    s.cloudVersion=meta.version;s.lastSyncAt=new Date().toISOString();s.conflicts=[];s.lastSignatureVerified=encoded.signed?true:null;store.save();
    return text(JSON.stringify({profileId:s.profileId,cloudVersion:meta.version,bytes:body.length,signed:encoded.signed},null,2));
  });

  reg("work_sync_pull",{
    description:"coordinator의 Work snapshot을 내려받아 notes/handoff/task shadow를 병합한다. active goal 충돌은 자동 덮어쓰지 않고 기록한다.",
    inputSchema:{goal_strategy:z.enum(["candidate","remote","local"]).optional(),confirm_remote_title:z.string().optional()}
  },async({goal_strategy="candidate",confirm_remote_title})=>{
    ensure(store);const s=store.data.workSync;if(!s.profileId)throw new Error("work_sync_configure 먼저");
    const got=await coordinatorGetBlob(ctx,key(s.profileId)),decoded=decodeManifest(ctx,got.buffer,s.profileId),remote=decoded.remote;
    s.lastSignatureVerified=decoded.signed;
    store.data.notes=mergeNotes(store.data.notes,remote.notes);
    fs.mkdirSync(path.join(cfg.stateDir,"sessions"),{recursive:true});
    const existing=new Set((store.data.sessions||[]).map(x=>x.id));
    for(const rs of Array.isArray(remote.sessions)?remote.sessions.slice(0,100):[]){
      const sid=safeId(rs.id,"session id"),sessionsDir=path.resolve(cfg.stateDir,"sessions"),file=path.resolve(sessionsDir,sid+".md");
      if(!file.startsWith(sessionsDir+path.sep))throw new Error("session path escape");
      const content=typeof rs.content==="string"?rs.content.slice(0,500000):"";
      if(!fs.existsSync(file))fs.writeFileSync(file,content);
      if(!existing.has(sid)){store.data.sessions.push({id:sid,file,createdAt:rs.createdAt||new Date().toISOString(),goalId:rs.goalId||null});existing.add(sid);}
    }
    store.data.sessions.sort((a,b)=>String(a.createdAt).localeCompare(String(b.createdAt)));
    const lg=currentGoal(ctx),rg=validateRemoteGoal(remote.goal);
    s.conflicts=[];s.remoteGoalCandidate=rg;
    if(goal_strategy==="remote"){
      if(!rg)throw new Error("remote goal 없음");
      if(confirm_remote_title!==rg.title)throw new Error("remote goal 활성화에는 confirm_remote_title 정확히 필요");
      if(!store.data.goals||typeof store.data.goals!=="object"||Array.isArray(store.data.goals))store.data.goals={};
      store.data.goals[rg.id]=rg;setCurrentGoal(ctx,rg);s.remoteGoalCandidate=null;
    }else if(goal_strategy==="candidate"&&activeGoal(lg)&&activeGoal(rg)&&lg.title!==rg.title){
      s.conflicts.push({type:"goal",local:{title:lg.title,createdAt:lg.createdAt},remote:{title:rg.title,createdAt:rg.createdAt}});
    }
    for(const [rawId,t] of Object.entries(remote.taskShadows||{}).slice(0,1000)){
      const id=safeId(rawId,"task shadow id");
      if(!store.data.tasks?.[id])store.data.syncedTaskShadows[id]={...t,id,syncedAt:new Date().toISOString(),sourceProfile:s.profileId};
    }
    s.cloudVersion=got.version;s.lastPullAt=new Date().toISOString();store.save();
    return text(JSON.stringify({profileId:s.profileId,cloudVersion:got.version,sessions:remote.sessions?.length||0,taskShadows:Object.keys(remote.taskShadows||{}).length,conflicts:s.conflicts,remoteGoalCandidate:rg?{title:rg.title,steps:rg.steps.length,createdAt:rg.createdAt}:null,goalActivated:goal_strategy==="remote",signatureVerified:decoded.signed},null,2));
  });

  reg("work_task_shadows",{description:"다른 기기에서 동기화된 local Task 상태를 본다. 실행하려면 work_task_adopt로 현재 기기에 채택한다.",inputSchema:{}},async()=>{
    ensure(store);return text(JSON.stringify(store.data.syncedTaskShadows,null,2));
  });

  reg("work_task_trust",{
    description:"채택한 원격 Task의 격리를 해제한다. 원격 명령 실행 권한 승격이므로 명시적 승인(기본 ask)이 필요하다.",
    inputSchema:{id:z.string(),confirm_title:z.string()}
  },async({id,confirm_title})=>{
    const t=store.data.tasks?.[id];if(!t||!t.remoteOriginId)throw new Error("원격 채택 Task 없음");
    if(confirm_title!==t.title)throw new Error("confirm_title 불일치");
    enforcePolicy(ctx,"task.remote.execute","work_task_trust",{id,title:t.title,remoteOriginId:t.remoteOriginId},"ask");
    t.remoteQuarantined=false;t.error=null;t.remoteTrustedAt=new Date().toISOString();store.save();
    return text(JSON.stringify({id:t.id,title:t.title,remoteTrustedAt:t.remoteTrustedAt},null,2));
  });

  reg("work_task_adopt",{
    description:"동기화된 task shadow를 현재 기기의 Task Manager로 채택한다. cwd를 현재 승인 root로 매핑하고 paused 상태로 시작한다.",
    inputSchema:{id:z.string(),cwd:z.string().optional()}
  },async({id,cwd})=>{
    ensure(store);const shadow=store.data.syncedTaskShadows[id];if(!shadow)throw new Error("task shadow 없음: "+id);
    const root=resolveInRoots(cfg,cwd||cfg.roots[0]),copy=structuredClone(shadow);
    copy.cwd=root;copy.status="paused";copy.finishedAt=null;copy.error="Remote task quarantined: review before resume";copy.remoteOriginId=id;copy.remoteQuarantined=true;copy.id="task_adopted_"+Date.now().toString(36);
    copy.steps=(copy.steps||[]).map(s=>({...s,cwd:root,status:["succeeded","skipped"].includes(s.status)?s.status:"pending"}));
    store.data.tasks[copy.id]=copy;store.save();
    return text(JSON.stringify(copy,null,2));
  });

  reg("work_resume",{
    description:"다른 Chat/기기에서 Work를 이어가기 위한 통합 resume briefing. goal, 최신 handoff, unfinished tasks, synced task shadows, coordinator remote tasks를 반환한다.",
    inputSchema:{pull_first:z.boolean().optional(),goal_id:z.string().optional(),workspace_id:z.string().optional(),lineage_id:z.string().optional(),work_id:z.string().optional()}
  },async({pull_first=false,goal_id,workspace_id,lineage_id,work_id})=>{
    if(pull_first){try{
      const s=store.data.workSync;if(s?.profileId){const got=await coordinatorGetBlob(ctx,key(s.profileId)),decoded=decodeManifest(ctx,got.buffer,s.profileId),remote=decoded.remote;store.data.notes=mergeNotes(store.data.notes,remote.notes);s.cloudVersion=got.version;s.lastPullAt=new Date().toISOString();s.lastSignatureVerified=decoded.signed;store.save();}
    }catch{}}
    const ref=work_id?store.data.workItems?.[work_id]||store.data.tasks?.[work_id]:null;
    if(work_id&&!ref)throw new Error("work/task not found: "+work_id);
    let goal=goal_id?store.data.goals?.[goal_id]:ref?.goalId?store.data.goals?.[ref.goalId]:currentGoal(ctx);
    if(goal_id&&!goal)throw new Error("goal not found: "+goal_id);
    let selectedId=workspace_id||ref?.workspaceId||null;
    if(lineage_id){const matches=listWorkspaces(ctx).filter(w=>w.lineageId===lineage_id);if(matches.length!==1)throw new Error("lineage must identify one local workspace; specify workspace_id");selectedId=matches[0].id;}
    // Explicit resume may also recover from duplicate persistent goals created for the same work.
    if(!goal&&!selectedId&&!lineage_id&&!work_id){
      const active=Object.values(store.data.goals||{}).filter(g=>g&&!g.finishedAt);
      if(active.length===1)goal=active[0];
      else if(active.length>1){
        const titles=new Set(active.map(g=>String(g?.title||"").trim()));
        if(titles.size===1){
          goal=[...active].sort((a,b)=>{
            const ad=(a.steps||[]).filter(s=>s?.done).length,bd=(b.steps||[]).filter(s=>s?.done).length;
            if(ad!==bd)return bd-ad;
            return (Date.parse(b.createdAt||"")||0)-(Date.parse(a.createdAt||"")||0);
          })[0]||null;
        }
        if(!goal)throw new Error("multiple active goals; resume with goal_id or workspace_id");
      }
    }
    if(selectedId){const w=bindWorkspace(ctx,selectedId);if(goal_id&&goal?.workspaceId&&goal.workspaceId!==w.id)throw new Error("goal/workspace mismatch");goal=goal_id?goal:(w.goalId?store.data.goals?.[w.goalId]:null);if(goal)setCurrentGoal(ctx,goal);else setCurrentGoal(ctx,null);bindWorkspace(ctx,w.id);}
    else if(goal){const w=await ensureWorkspace(ctx,{goalId:goal.id,lineageId:goal.lineageId||goal.id,projectId:goal.projectId,root:goal.repoRoot,workspaceId:goal.workspaceId,legacyRoot:!goal.workspaceId});goal.workspaceId=w.id;goal.lineageId=w.lineageId;setCurrentGoal(ctx,goal);store.save();}
    const workspace=currentWorkspace(ctx),effort=currentEffort(ctx),sessions=store.data.sessions||[];
    const latest=(goal?[...sessions].reverse().find(s=>s.goalId===goal.id):null)||sessions.at(-1);let handoff=null;if(latest)try{handoff=fs.readFileSync(latest.file,"utf8").slice(0,30000);}catch{}
    let remoteTasks=[];try{const c=store.data.coordinator;if(c?.url)remoteTasks=await coordinatorApi(ctx,"/v1/tasks?device_id="+encodeURIComponent(c.deviceId));}catch{}
    const boundaryMs=Date.parse(latest?.createdAt||goal?.createdAt||"")||Date.now()-24*60*60*1000;
    const activityMs=t=>{
      const events=Array.isArray(t?.events)?t.events:[];
      const lastEvent=events.length?events[events.length-1]?.ts:null;
      return Math.max(0,...[t?.checkpoint?.updatedAt,lastEvent,t?.finishedAt,t?.startedAt,t?.createdAt].map(v=>Date.parse(v||"")||0));
    };
    const liveStatuses=new Set(["queued","running","blocked","waiting_for_device","claimed"]);
    const resumableStatuses=new Set(["paused","failed"]);
    const allLocal=Object.values(store.data.tasks||{});
    const belongs=t=>!workspace||t.workspaceId===workspace.id||(!t.workspaceId&&(!t.goalId||t.goalId===goal?.id));
    const unfinished=allLocal.filter(t=>belongs(t)&&(liveStatuses.has(t.status)||(resumableStatuses.has(t.status)&&activityMs(t)>=boundaryMs)))
      .sort((a,b)=>activityMs(b)-activityMs(a)).slice(0,25)
      .map(t=>({id:t.id,title:t.title,status:t.status,currentStep:t.currentStep,projectId:t.projectId,workspaceId:t.workspaceId,lineageId:t.lineageId,activityAt:new Date(activityMs(t)||0).toISOString()}));
    const visibleLocalIds=new Set(unfinished.map(t=>t.id));
    const hiddenLegacyTaskCount=allLocal.filter(t=>!["succeeded","cancelled"].includes(t.status)&&!visibleLocalIds.has(t.id)).length;
    const remoteActivityMs=t=>Math.max(0,...[t?.updatedAt,t?.finishedAt,t?.startedAt,t?.createdAt,t?.runAt].map(v=>Date.parse(v||"")||0));
    const visibleRemote=remoteTasks.filter(t=>liveStatuses.has(t.status)||(resumableStatuses.has(t.status)&&remoteActivityMs(t)>=boundaryMs))
      .sort((a,b)=>remoteActivityMs(b)-remoteActivityMs(a)).slice(0,25);
    const visibleRemoteIds=new Set(visibleRemote.map(t=>t.id));
    const hiddenRemoteTaskCount=remoteTasks.filter(t=>!["succeeded","cancelled"].includes(t.status)&&!visibleRemoteIds.has(t.id)).length;
    return text(JSON.stringify({
      goal:goal||null,workspace,remoteGoalCandidate:store.data.workSync?.remoteGoalCandidate||null,effort,activeProjectId:store.data.activeProjectId||null,
      latestHandoff:latest?{id:latest.id,createdAt:latest.createdAt,content:handoff}:null,
      unfinishedTasks:unfinished,hiddenLegacyTaskCount,
      syncedTaskShadows:Object.values(store.data.syncedTaskShadows||{}).map(t=>({id:t.id,title:t.title,status:t.status,sourceProfile:t.sourceProfile})),
      remoteTasks:visibleRemote.map(t=>({id:t.id,title:t.title,status:t.status,executor:t.executor,targetDevice:t.targetDevice,runAt:t.runAt})),hiddenRemoteTaskCount,
      sync:store.data.workSync
    },null,2));
  });
}
