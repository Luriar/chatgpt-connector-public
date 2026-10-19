import crypto from "node:crypto";
import { workspaceLockKey } from "./workspaces.js";

const RESOURCE_RE=/^[A-Za-z0-9._:@/\\-]{1,160}$/;
const DEFAULT_TTL_MS=45_000;
const AUTO_LOCK_TTL_MS=120_000;
const AUTO_WAIT_MS=5_000;
const MAX_TTL_MS=15*60_000;
const callLockTables=new WeakMap();

const desktopMutating=new Set([
  "desktop_click","desktop_type","desktop_key","desktop_focus",
  "computer_invoke","computer_set_value","computer_select",
  "office_excel_write","office_word_replace","office_word_set_selection",
  "office_powerpoint_set_selected_text","office_live_save"
]);
const browserMutating=new Set([
  "browser_open","browser_click","browser_type","browser_wait","browser_download","browser_close",
  "browser_upload_file","browser_click_popup","browser_frame_click","browser_frame_type",
  "browser_clone_profile","browser_open_profile","browser_connect_cdp",
  "browser_broker_start","browser_broker_reconnect","browser_broker_stop"
]);
const workspaceMutating=new Set([
  "fs_write","fs_edit","fs_apply_patch","fs_mkdir_rm_mv",
  "exec_command","exec_stdin","exec_kill","exec_secure",
  "codex_run","remote_register"
]);

export function resourceOwner(ctx){
  return String(ctx?.sessionRef?.id||`process-${process.pid}`);
}
export function resourceOwnerTag(owner){
  return crypto.createHash("sha256").update(String(owner)).digest("hex").slice(0,12);
}
function ttlMs(seconds){
  const n=Number(seconds);
  if(Number.isFinite(n)&&n>0)return Math.min(MAX_TTL_MS,Math.max(5_000,Math.round(n*1000)));
  const env=Number(process.env.WEBJJONKU_RESOURCE_LOCK_TTL_MS||DEFAULT_TTL_MS);
  return Math.min(MAX_TTL_MS,Math.max(5_000,Number.isFinite(env)?env:DEFAULT_TTL_MS));
}
function table(ctx){
  if(!ctx.store.data.resourceLocks||typeof ctx.store.data.resourceLocks!=="object"||Array.isArray(ctx.store.data.resourceLocks)){
    ctx.store.data.resourceLocks={};
  }
  return ctx.store.data.resourceLocks;
}
function callTable(ctx){
  const store=ctx?.store;
  if(!store)throw new Error("resource lock store unavailable");
  let t=callLockTables.get(store);
  if(!t){t={};callLockTables.set(store,t);}
  return t;
}
function cleanupCallLocks(ctx,now=Date.now()){
  const t=callTable(ctx);
  for(const [k,v] of Object.entries(t)){
    if(!v||!v.expiresAt||new Date(v.expiresAt).getTime()<=now)delete t[k];
  }
}
export function cleanupResourceLocks(ctx,now=Date.now()){
  const t=table(ctx);let changed=false;
  for(const [k,v] of Object.entries(t)){
    if(!v||v.mode==="call"||!v.expiresAt||new Date(v.expiresAt).getTime()<=now){delete t[k];changed=true;}
  }
  cleanupCallLocks(ctx,now);
  return changed;
}
export function publicResourceLock(resource,lock){
  return {
    resource,
    owner:resourceOwnerTag(lock.owner),
    acquiredAt:lock.acquiredAt,
    renewedAt:lock.renewedAt,
    expiresAt:lock.expiresAt,
    tool:lock.tool||null,
    mode:lock.mode||"explicit"
  };
}
export function resourceLockTable(ctx){return {...table(ctx),...callTable(ctx)};}
export function resourceKeysForTool(name,args={},ctx=null){
  const out=[];
  if(desktopMutating.has(name)||name.startsWith("ui_watchdog_"))out.push("windows-desktop");
  if(browserMutating.has(name))out.push("browser-local");
  if(workspaceMutating.has(name))out.push(ctx?workspaceLockKey(ctx):"workspace");
  if(name==="ssh_exec"||name==="remote_copy"){
    const r=String(args.remote||args.host||"default").replace(/[^A-Za-z0-9._:@-]/g,"_").slice(0,120)||"default";
    out.push("remote:"+r);
  }
  return [...new Set(out)];
}
export function acquireResourceLocks(ctx,resources,{tool=null,seconds=null,owner=null,mode="explicit"}={}){
  const rs=[...new Set((resources||[]).filter(Boolean).map(String))];
  if(!rs.length)return [];
  for(const r of rs)if(!RESOURCE_RE.test(r))throw new Error("invalid resource lock key: "+r);
  const actualOwner=String(owner||resourceOwner(ctx)),now=Date.now(),ttl=ttlMs(seconds),persisted=table(ctx),local=callTable(ctx);
  cleanupResourceLocks(ctx,now);
  for(const r of rs){
    for(const cur of [persisted[r],local[r]]){
      if(cur&&cur.owner!==actualOwner&&new Date(cur.expiresAt).getTime()>now){
        const remain=Math.max(1,Math.ceil((new Date(cur.expiresAt).getTime()-now)/1000));
        const err=new Error(`resource busy: ${r} (owner=${resourceOwnerTag(cur.owner)}, retry_after≈${remain}s)`);
        err.code="RESOURCE_BUSY";
        throw err;
      }
    }
  }
  const iso=new Date(now).toISOString(),exp=new Date(now+ttl).toISOString();
  const target=mode==="call"?local:persisted;
  for(const r of rs){
    const cur=target[r];
    target[r]={
      owner:actualOwner,
      acquiredAt:cur?.owner===actualOwner&&cur.acquiredAt?cur.acquiredAt:iso,
      renewedAt:iso,
      expiresAt:exp,
      tool:tool||cur?.tool||null,
      mode
    };
  }
  // Automatic call-scoped locks are purely in-process concurrency guards.
  // Persisting them would turn every MCP call into two crash-safe state writes
  // (acquire + release), causing avoidable I/O and stale locks after restarts.
  if(mode!=="call")ctx.store.save();
  return rs;
}
export function releaseResourceLocks(ctx,resources,owner){
  const rs=[...new Set((resources||[]).filter(Boolean).map(String))];
  if(!rs.length||!owner)return 0;
  const persisted=table(ctx),local=callTable(ctx);let n=0,persist=false;
  for(const r of rs){
    let removed=false;
    if(local[r]?.owner===owner){delete local[r];removed=true;}
    if(persisted[r]?.owner===owner){delete persisted[r];persist=true;removed=true;}
    if(removed)n++;
  }
  if(n&&persist)ctx.store.save();
  return n;
}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
export async function acquireToolResources(ctx,name,args){
  // ChatGPT's MCP client may create a fresh transport session between tool-call batches.
  // Automatic locking is therefore CALL-scoped, not transport-session-scoped.
  // This prevents concurrent writes while avoiding stale cross-call locks.
  if(ctx?.sessionRef?.scoped===false)return null;
  const resources=resourceKeysForTool(name,args,ctx);
  if(!resources.length)return null;
  const owner="call-"+crypto.randomUUID();
  const deadline=Date.now()+Number(process.env.WEBJJONKU_RESOURCE_LOCK_WAIT_MS||AUTO_WAIT_MS);
  while(true){
    try{
      acquireResourceLocks(ctx,resources,{tool:name,seconds:AUTO_LOCK_TTL_MS/1000,owner,mode:"call"});
      return {resources,owner};
    }catch(e){
      if(e?.code!=="RESOURCE_BUSY"||Date.now()>=deadline)throw e;
      await sleep(100);
    }
  }
}
export function releaseToolResources(ctx,lease){
  if(!lease?.owner||!lease?.resources?.length)return 0;
  return releaseResourceLocks(ctx,lease.resources,lease.owner);
}
export function releaseSessionResources(ctx,owner=resourceOwner(ctx)){
  if(!owner)return 0;
  const persisted=table(ctx),local=callTable(ctx);let n=0,persist=false;
  for(const r of new Set([...Object.keys(persisted),...Object.keys(local)])){
    let removed=false;
    if(local[r]?.owner===owner){delete local[r];removed=true;}
    if(persisted[r]?.owner===owner){delete persisted[r];persist=true;removed=true;}
    if(removed)n++;
  }
  if(n&&persist)ctx.store.save();
  return n;
}
export {RESOURCE_RE};
