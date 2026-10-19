function scoped(ctx){return !!(ctx?.sessionRef?.scoped&&ctx?.sessionRef?.id);}
export function sessionKey(ctx){return scoped(ctx)?String(ctx.sessionRef.id):null;}
function states(ctx){
  if(!ctx.store.data.sessionStates||typeof ctx.store.data.sessionStates!=="object"||Array.isArray(ctx.store.data.sessionStates)){
    ctx.store.data.sessionStates={};
  }
  return ctx.store.data.sessionStates;
}
export function getSessionState(ctx,create=false){
  const key=sessionKey(ctx);
  if(!key)return null;
  const all=states(ctx);
  if(!all[key]&&create){
    all[key]={
      goal:null,
      goalHistory:[],
      effort:ctx.cfg.effortDefault,
      createdAt:new Date().toISOString(),
      updatedAt:new Date().toISOString()
    };
  }
  return all[key]||null;
}
export function currentGoal(ctx){
  if(scoped(ctx)){
    const s=getSessionState(ctx,false);
    if(s?.goal)return s.goal;
    // A fresh transport is not evidence that unrelated work resumes a prior goal.
    // Explicit work_resume/goal_status can rebind a persistent goal.
    return null;
  }
  return ctx.store.data.goal;
}
export function setCurrentGoal(ctx,goal){
  const s=getSessionState(ctx,true);
  if(s){s.goal=goal;s.workspaceId=goal?.workspaceId||null;s.lineageId=goal?.lineageId||null;s.updatedAt=new Date().toISOString();}
  else {ctx.store.data.goal=goal;ctx.store.data.workspaceId=goal?.workspaceId||null;}
}
export function currentGoalHistory(ctx){
  const s=getSessionState(ctx,true);
  return s?s.goalHistory:ctx.store.data.goalHistory;
}
export function currentEffort(ctx){
  if(scoped(ctx))return getSessionState(ctx,false)?.effort||ctx.cfg.effortDefault;
  return ctx.store.data.effort||ctx.cfg.effortDefault;
}
export function setCurrentEffort(ctx,effort){
  const s=getSessionState(ctx,true);
  if(s){s.effort=effort;s.updatedAt=new Date().toISOString();}
  else ctx.store.data.effort=effort;
}
export function touchSessionState(ctx){
  const s=getSessionState(ctx,true);
  if(s)s.updatedAt=new Date().toISOString();
}
