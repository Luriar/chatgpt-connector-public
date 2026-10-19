import http from 'node:http';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {z} from 'zod';
import {createStore} from './event-store.mjs';
const PORT=Number(process.env.CONSUMER_EVENT_PORT||18795);
const HOST=process.env.CONSUMER_EVENT_HOST||'127.0.0.1';
const ROOT=process.env.CONSUMER_EVENT_DATA;
if(!ROOT||!Number.isSafeInteger(PORT)||PORT<1024||PORT>65535||!['127.0.0.1','::1'].includes(HOST))throw Error('invalid isolated bridge configuration');
const store=createStore(ROOT),URI='ui://consumer-event-bridge/panel.html';
const sessions=new Map(),now=()=>Date.now(),MAX_MESSAGES=6,DURATION=15*60*1000,MIN_GAP=60000;
const clock=()=>{const t=now();for(const [key,value] of sessions)if(value.expiresAt<t)sessions.delete(key);return t};
function command({action,session,eventId,outcome}){
 const t=clock();
 if(action==='arm'){
  if(sessions.size>=8)throw Error('too many active sessions');
  const key=crypto.randomUUID();sessions.set(key,{expiresAt:t+DURATION,startedAt:t,claimed:null,count:0,last:0,stop:false});
  return {state:'waiting',session:key,expiresAt:t+DURATION,maxMessages:MAX_MESSAGES};
 }
 if(!session||!sessions.has(session))throw Error('session missing or expired');
 const s=sessions.get(session);if(s.stop)throw Error('session stopped');
 if(action==='stop'){s.stop=true;return {state:'stopped'};}
 if(action==='ack'){
  if(!s.claimed||s.claimed.id!==eventId||!['host_accepted','uncertain'].includes(outcome))throw Error('invalid acknowledgement');
  const r=store.delivery(eventId,outcome);s.claimed=null;s.last=t;s.count++;
  return {...r,state:s.count>=MAX_MESSAGES?'limit_reached':'waiting',count:s.count,completed:false};
 }
 if(action!=='poll')throw Error('invalid action');
 if(s.claimed)return {state:'claimed_pending_ack',eventId:s.claimed.id};
 if(s.count>=MAX_MESSAGES)return {state:'limit_reached'};
 if(s.last&&t-s.last<MIN_GAP)return {state:'cooldown',retryAfterMs:MIN_GAP-(t-s.last)};
 const e=store.next();if(!e)return {state:'waiting'};
 const claimed=store.claim(e.id);if(!claimed)return {state:'race_lost'};
 s.claimed=claimed;return {state:'claimed',event:claimed};
}
import crypto from 'node:crypto';
function mcpServer(){const mcp=new McpServer({name:'Consumer Event Bridge (NAS)',version:'0.3.0'});
 mcp.registerResource('consumer-event-ui',URI,{mimeType:'text/html;profile=mcp-app'},async()=>({contents:[{uri:URI,mimeType:'text/html;profile=mcp-app',text:fs.readFileSync(new URL('../ui/event-widget.html',import.meta.url),'utf8')}]}));
 mcp.registerTool('consumer_event_bridge',{title:'NAS Consumer Event Bridge',description:'Open a user-armed NAS event widget. Loading it never sends a message or invokes a model. Requires a live ChatGPT widget.',inputSchema:{},annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false},_meta:{ui:{resourceUri:URI},'openai/outputTemplate':URI,'openai/widgetAccessible':true}},async()=>({content:[{type:'text',text:'Click Start in the panel to listen for NAS-only event IDs; live ChatGPT must remain open. Host receipt is not scientific or model-completion proof.'}],structuredContent:{mode:'live_widget_only',maxMessages:MAX_MESSAGES,windowMs:DURATION,closed_window_supported:false}}));
 mcp.registerTool('consumer_event_session',{title:'User-armed widget session operations',description:'App-only bounded arm, poll, receipt and stop. Does not accept prompts, execute arbitrary commands, or run models.',inputSchema:{action:z.enum(['arm','poll','ack','stop']),session:z.string().uuid().optional(),eventId:z.string().max(64).optional(),outcome:z.enum(['host_accepted','uncertain']).optional()},annotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:false},_meta:{ui:{visibility:['app']},'openai/widgetAccessible':true,'openai/visibility':'private'}},async(args)=>{try{return {content:[],structuredContent:command(args)}}catch(e){return {isError:true,content:[{type:'text',text:String(e.message).slice(0,140)}]}}});return mcp;
}
const server=http.createServer(async(req,res)=>{
 res.setHeader('cache-control','no-store');res.setHeader('x-content-type-options','nosniff');
 if(req.url==='/healthz'&&req.method==='GET'){res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({ok:true,component:'consumer-event-bridge',version:'0.3.0',inference:false}));return}
 if(req.headers.origin||req.url!=='/mcp'||!['POST','GET','DELETE'].includes(req.method)){res.writeHead(404).end();return}
 if(Number(req.headers['content-length']||0)>65536){res.writeHead(413).end();return}
 const mcp=mcpServer(),trans=new StreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});
 try{await mcp.connect(trans);await trans.handleRequest(req,res)}catch(e){console.error('MCP_ERROR',String(e.message).slice(0,180));if(!res.headersSent)res.writeHead(500).end()}
 finally{await trans.close().catch(()=>{});await mcp.close().catch(()=>{})}
});
server.requestTimeout=15000;server.headersTimeout=16000;server.keepAliveTimeout=5000;
server.listen(PORT,HOST,()=>console.log(JSON.stringify({event:'consumer_bridge_ready',host:HOST,port:PORT,mode:'model_free',user_action_required:true})));
const shutdown=()=>server.close(()=>process.exit(0));process.on('SIGTERM',shutdown);process.on('SIGINT',shutdown);
