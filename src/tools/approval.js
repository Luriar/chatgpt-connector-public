// Personal Cowork parity: approval requests, multi-action transactions, and persistent allow overrides.
import crypto from "node:crypto";
import { z } from "zod";
import { text } from "../toolkit.js";

function ensure(store){
  if(!Array.isArray(store.data.approvals))store.data.approvals=[];
  if(!store.data.policyOverrides||typeof store.data.policyOverrides!=="object")store.data.policyOverrides={};
}
function expire(store){
  const now=Date.now();
  for(const a of store.data.approvals){
    if(["pending","granted"].includes(a.status)&&a.expiresAt&&new Date(a.expiresAt).getTime()<now)a.status="expired";
  }
}
function actionsOf(a){return Array.isArray(a.actions)?a.actions:(a.action?[a.action]:[]);}

export function registerApprovalTools(reg,ctx){
  const {store}=ctx;ensure(store);

  reg("approval_request",{
    description:"승인 요청을 수동 생성한다. 여러 actions와 preview를 묶어 transaction 승인을 만들 수 있다. 보통 ask 정책 도구 호출 시 자동 생성되므로 수동 호출은 선택사항.",
    inputSchema:{action:z.string().optional(),actions:z.array(z.string()).optional(),reason:z.string().optional(),preview:z.any().optional(),ttl_seconds:z.number().int().min(30).max(86400).optional()}
  },async({action,actions,reason,preview,ttl_seconds=600})=>{
    const list=[...(actions||[]),...(action?[action]:[])].filter(Boolean);if(!list.length)throw new Error("action(s) 필요");
    const id="a"+crypto.randomBytes(4).toString("hex"),now=Date.now();
    store.data.approvals.push({id,actions:[...new Set(list)],reason:reason||null,preview:preview||null,status:"pending",createdAt:new Date(now).toISOString(),expiresAt:new Date(now+ttl_seconds*1000).toISOString(),mode:null,uses:0,remainingActions:[]});
    store.save();return text(JSON.stringify({id,status:"pending",actions:[...new Set(list)],preview:preview||null,expiresAt:new Date(now+ttl_seconds*1000).toISOString()},null,2));
  });

  reg("approval_grant",{
    description:"승인 요청을 허용한다. mode=once는 요청 action들을 각 1회, session은 일정 시간 동안 여러 번, always는 해당 action을 지속 허용한다.",
    inputSchema:{id:z.string(),mode:z.enum(["once","session","always"]).optional(),ttl_seconds:z.number().int().min(30).max(86400).optional(),uses:z.number().int().min(1).max(10000).optional()}
  },async({id,mode="once",ttl_seconds,uses})=>{
    ensure(store);expire(store);const a=store.data.approvals.find(x=>x.id===id);if(!a)throw new Error("승인 요청 없음");if(a.status==="denied"||a.status==="expired")throw new Error("승인할 수 없는 상태: "+a.status);
    const acts=actionsOf(a);a.mode=mode;a.grantedAt=new Date().toISOString();
    if(mode==="always"){
      for(const action of acts)store.data.policyOverrides[action]="allow";
      a.status="always";a.uses=null;a.remainingActions=[];a.expiresAt=null;
    }else if(mode==="session"){
      a.status="granted";a.uses=uses||1000;a.remainingActions=[];a.expiresAt=new Date(Date.now()+(ttl_seconds||28800)*1000).toISOString();
    }else{
      a.status="granted";a.uses=uses||acts.length;a.remainingActions=[...acts];a.expiresAt=new Date(Date.now()+(ttl_seconds||600)*1000).toISOString();
    }
    store.save();return text(JSON.stringify({id,status:a.status,mode,actions:acts,expiresAt:a.expiresAt},null,2));
  });

  reg("approval_deny",{description:"승인 요청을 거부한다.",inputSchema:{id:z.string()}},async({id})=>{
    const a=store.data.approvals.find(x=>x.id===id);if(!a)throw new Error("승인 요청 없음");a.status="denied";a.deniedAt=new Date().toISOString();store.save();return text("거부됨: "+id);
  });

  reg("approval_revoke_always",{description:"Always allow로 저장된 action 허용을 취소해 config 정책으로 되돌린다.",inputSchema:{action:z.string()}},async({action})=>{
    ensure(store);delete store.data.policyOverrides[action];store.save();return text("persistent override 제거: "+action);
  });

  reg("approval_list",{description:"최근 승인 요청/preview/grant 상태와 persistent overrides를 조회한다.",inputSchema:{}},async()=>{
    ensure(store);expire(store);store.save();return text(JSON.stringify({requests:store.data.approvals.slice(-100),persistentOverrides:store.data.policyOverrides},null,2));
  });

  reg("approval_preview",{description:"승인 ID의 action preview를 다시 확인한다.",inputSchema:{id:z.string()}},async({id})=>{
    const a=store.data.approvals.find(x=>x.id===id);if(!a)throw new Error("승인 요청 없음");return text(JSON.stringify({id:a.id,status:a.status,actions:actionsOf(a),reason:a.reason,preview:a.preview,expiresAt:a.expiresAt},null,2));
  });
}
