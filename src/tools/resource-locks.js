import crypto from "node:crypto";
import { z } from "zod";
import { text } from "../toolkit.js";
import {
  RESOURCE_RE,
  acquireResourceLocks,
  cleanupResourceLocks,
  publicResourceLock,
  releaseSessionResources,
  releaseResourceLocks,
  resourceLockTable,
  resourceOwner
} from "../resource-locks.js";

export function registerResourceLockTools(reg,ctx){
  reg("resource_lock_status",{
    description:"동시 ChatGPT 세션 간 공유 자원 lease 상태를 조회한다. owner는 원본 세션 ID 대신 해시 태그만 표시한다.",
    inputSchema:{resource:z.string().optional()}
  },async({resource})=>{
    const now=Date.now();const changed=cleanupResourceLocks(ctx,now);if(changed)ctx.store.save();const t=resourceLockTable(ctx);
    const rows=Object.entries(t)
      .filter(([k])=>!resource||k===resource)
      .map(([k,v])=>publicResourceLock(k,v));
    return text(JSON.stringify(rows,null,2));
  });

  const leaseIdSchema=z.string().regex(/^[A-Za-z0-9_-]{16,128}$/);

  reg("resource_lock_acquire",{
    description:"공유 자원 lease를 명시적으로 획득/갱신한다. ChatGPT가 tool-call 사이에 transport session을 바꿔도 유지되도록 반환된 lease_id를 다음 acquire/release 호출에 그대로 사용한다.",
    inputSchema:{
      resource:z.string().regex(RESOURCE_RE),
      lease_seconds:z.number().int().min(5).max(900).optional(),
      lease_id:leaseIdSchema.optional()
    }
  },async({resource,lease_seconds,lease_id})=>{
    const id=lease_id||crypto.randomBytes(18).toString("base64url");
    const owner="lease:"+id;
    acquireResourceLocks(ctx,[resource],{tool:"resource_lock_acquire",seconds:lease_seconds,owner});
    return text(JSON.stringify({...publicResourceLock(resource,resourceLockTable(ctx)[resource]),lease_id:id},null,2));
  });

  reg("resource_lock_release",{
    description:"명시적 공유 자원 lease를 해제한다. 새 lease는 acquire가 반환한 lease_id를 넘기면 transport session이 바뀌어도 해제된다. lease_id가 없으면 구형 session-owned lease만 해제한다.",
    inputSchema:{resource:z.string().regex(RESOURCE_RE).optional(),lease_id:leaseIdSchema.optional()}
  },async({resource,lease_id})=>{
    const owner=lease_id?("lease:"+lease_id):resourceOwner(ctx);let n=0;
    if(resource)n=releaseResourceLocks(ctx,[resource],owner);
    else n=releaseSessionResources(ctx,owner);
    return text(JSON.stringify({released:n},null,2));
  });
}
