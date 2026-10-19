export function connectorRecoveryAction(status){
  const s=String(status||"").trim().toLowerCase();
  if(["created","exited","dead"].includes(s))return "start";
  if(["running","restarting","paused"].includes(s))return "restart";
  return null;
}

export function shouldAttemptConnectorRecovery(status,failStreak,restartAfter){
  const action=connectorRecoveryAction(status);
  if(!action)return false;
  if(action==="start")return true;
  return Number(failStreak||0)>=Math.max(1,Number(restartAfter||1));
}
