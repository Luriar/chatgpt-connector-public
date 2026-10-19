// Read-only, NAS-local MCP protocol gate audit. No subscriptions, callbacks, models or tokens.
const target=process.env.CONSUMER_EVENT_AUDIT_URL||'http://127.0.0.1:18797/mcp';
const u=new URL(target);
if(u.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(u.hostname)||u.pathname!=='/mcp'){
  throw Error('Only loopback MCP endpoint is allowed in this read-only audit');
}
async function rpc(method,version){
  const response=await fetch(u,{method:'POST',redirect:'error',signal:AbortSignal.timeout(4000),headers:{'content-type':'application/json','accept':'application/json,text/event-stream','mcp-protocol-version':version,'mcp-method':method},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params:{}})});
  const data=await response.json();
  return {method,version,http:response.status,code:data.error?.code??null,message:data.error?.message??null,advertisedEvents:Boolean(data.result?.capabilities?.events),eventCatalog:Array.isArray(data.result?.events)?data.result.events.map(e=>e.name):null};
}
const probes=await Promise.all([
  rpc('server/discover','2026-07-28'),
  rpc('events/list','2026-07-28'),
  rpc('server/discover','2025-11-25'),
  rpc('events/list','2025-11-25')
]);
const versionSupported=probes[0].http===200&&probes[0].code===null;
const eventsDiscovered=versionSupported&&probes[0].advertisedEvents&&probes[1].code===null;
console.log(JSON.stringify({audit:'mcp-event-server-readonly',target:'loopback_only',protocol2026Supported:versionSupported,eventsDiscoverable:eventsDiscovered,ordinaryChatSubscriptionVerified:false,closedChatWakeVerified:false,probes},null,2));
