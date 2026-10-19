// Optional NAS Consumer Event Bridge v0.3 adapter for the already-connected
// ChatGPT Connector MCP. The durable queue and widget remain separate.
// NO model/API inference and NO installation of a new consumer plugin here.
import {z} from 'zod';
const URI='ui://webjjonku/consumer-event-bridge.html';
const REMOTE_URI='ui://consumer-event-bridge/panel.html';
function configuredUrl(value){
 if(!value)return null;
 const u=new URL(value);
 if(u.username||u.password||u.search||u.hash||u.pathname!=='/v03/mcp'&&u.pathname!=='/mcp')throw Error('invalid event bridge URL');
 if(u.protocol!=='https:'&&!(u.protocol==='http:'&&['127.0.0.1','localhost','::1'].includes(u.hostname)))throw Error('event bridge URL requires HTTPS or loopback');
 return u.toString();
}
export function makeBridgeProxy({url=process.env.WEBJJONKU_CONSUMER_EVENT_BRIDGE_URL,fetcher=fetch}={}){
 const endpoint=configuredUrl(url);
 if(!endpoint)return null;
 const rpc=async(method,params)=>{
  const response=await fetcher(endpoint,{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),signal:AbortSignal.timeout(8500)});
  if(!response.ok)throw Error('event bridge backend returned HTTP '+response.status);
  const out=await response.json();if(out.error)throw Error('event bridge backend rejected request');
  return out.result;
 };
 return {
  resource:async()=>{
   const r=await rpc('resources/read',{uri:REMOTE_URI});
   const content=r?.contents?.[0];
   if(typeof content?.text!=='string'||content.text.length>25000||!content.text.includes('consumer_event_session'))throw Error('event bridge UI unavailable');
   return {contents:[{uri:URI,mimeType:'text/html;profile=mcp-app',text:content.text}]};
  },
  open:async()=>{
   // The widget is passive until explicitly user-armed.
   const r=await rpc('tools/call',{name:'consumer_event_bridge',arguments:{}});
   return {...r,_meta:{ui:{resourceUri:URI},'openai/outputTemplate':URI}};
  },
  session:async(args)=>rpc('tools/call',{name:'consumer_event_session',arguments:args})
 };
}
export function registerConsumerEventBridgeTools(reg,server,opts={}){
 const proxy=makeBridgeProxy(opts);if(!proxy)return false;
 server.registerResource('webjjonku-consumer-event-bridge',URI,{title:'NAS Consumer Event Bridge v0.3',mimeType:'text/html;profile=mcp-app'},proxy.resource);
 reg('consumer_event_bridge',{
  title:'NAS Consumer Event Bridge v0.3',
  description:'Open a passive user-armed NAS event widget in ordinary ChatGPT. Requires Start click and open chat; no model inference by backend.',
  inputSchema:{},annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false},
  _meta:{ui:{resourceUri:URI},'openai/outputTemplate':URI,'openai/widgetAccessible':true}
 },proxy.open);
 reg('consumer_event_session',{
  title:'Consumer Event Bridge widget session',description:'Bounded user-armed session operations; no arbitrary prompt, shell command, model call or completion marking.',
  inputSchema:{action:z.enum(['arm','poll','ack','stop']),session:z.string().uuid().optional(),eventId:z.string().max(64).optional(),outcome:z.enum(['host_accepted','uncertain']).optional()},
  annotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:false},
  _meta:{ui:{visibility:['app']},'openai/widgetAccessible':true,'openai/visibility':'private'}
 },proxy.session);
 return true;
}
export {URI as CONSUMER_EVENT_BRIDGE_URI};
