import http from 'node:http';
import fs from 'node:fs';
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {z} from 'zod';
import {EventGate} from './nas-event-queue.mjs';
const PORT=Number(process.env.NAS_HOST_PROBE_PORT||18795),URI='ui://nas-consumer-host/event-probe-v2.html';
if(!Number.isInteger(PORT)||PORT<1024||PORT>65535)throw Error('unsafe port');
function readEvent(){let fd;try{fd=fs.openSync(new URL('./nas-event.json',import.meta.url),fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);const st=fs.fstatSync(fd);if(!st.isFile()||st.size>1024)return null;return JSON.parse(fs.readFileSync(fd,'utf8'));}catch{return null;}finally{if(fd!==undefined)fs.closeSync(fd);}}
const gate=new EventGate({readEvent,log:e=>console.log(JSON.stringify({at:new Date().toISOString(),...e}))});
const makeServer=()=>{const mcp=new McpServer({name:'NAS Consumer Host Safe Probe',version:'0.2.0'});
mcp.registerResource('nas-consumer-host-event-ui',URI,{mimeType:'text/html;profile=mcp-app'},async()=>({contents:[{uri:URI,mimeType:'text/html;profile=mcp-app',text:fs.readFileSync(new URL('./nas-event-probe.html',import.meta.url),'utf8'),_meta:{ui:{prefersBorder:true}}}]}));
mcp.registerResource('nas-consumer-host-legacy-ui','ui://nas-consumer-host/probe.html',{mimeType:'text/html;profile=mcp-app'},async()=>({contents:[{uri:'ui://nas-consumer-host/probe.html',mimeType:'text/html;profile=mcp-app',text:fs.readFileSync(new URL('./nas-event-probe.html',import.meta.url),'utf8')}]}));
mcp.registerTool('web_sdk_probe',{title:'NAS external event probe',description:'Open a bounded NAS file-event test UI. Loading does not arm or send messages. One Start click permits at most one harmless follow-up while this widget stays mounted.',inputSchema:{},annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false},_meta:{ui:{resourceUri:URI},'openai/outputTemplate':URI,'openai/widgetAccessible':true}},async()=>({content:[{type:'text',text:'NAS event probe v2 ready. Start once to listen for one harmless NAS file event for up to 3 minutes. Keep this chat open. Closed-window wakeup is not supported by this implementation.'}],structuredContent:{mode:'nas_file_event_probe_v2',inference_launched:false,unattended_verified:false}}));
mcp.registerTool('nas_event_probe_session',{title:'Bounded probe UI session',description:'App-only session arm/poll/ack/stop for one fixed harmless event. No model/API invocation or arbitrary commands.',inputSchema:{action:z.enum(['arm','poll','ack','stop']),session:z.string().uuid().optional(),eventId:z.string().max(64).optional(),outcome:z.enum(['host_accepted','uncertain']).optional()},annotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:false},_meta:{ui:{visibility:['app']},'openai/widgetAccessible':true,'openai/visibility':'private'}},async(args)=>{try{return {content:[],structuredContent:gate.call(args)}}catch(e){return {isError:true,content:[{type:'text',text:String(e.message).slice(0,120)}]}}});
return mcp;};
const server=http.createServer(async(req,res)=>{res.setHeader('cache-control','no-store');res.setHeader('x-content-type-options','nosniff');
if(req.url==='/healthz'&&req.method==='GET'){res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({ok:true,mode:'nas_file_event_probe_v2',model_inference:false,version:'0.2.0'}));return;}
if(req.headers.origin||req.url!=='/mcp'||!['POST','GET','DELETE'].includes(req.method)){res.writeHead(404).end();return;}
if(Number(req.headers['content-length']||0)>65536){res.writeHead(413).end();return;}
const mcp=makeServer(),t=new StreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});try{await mcp.connect(t);await t.handleRequest(req,res);}catch(e){if(!res.headersSent)res.writeHead(500).end();console.error('MCP:',String(e.message).slice(0,80));}finally{await t.close().catch(()=>{});await mcp.close().catch(()=>{});}});
server.requestTimeout=15000;server.headersTimeout=16000;server.keepAliveTimeout=5000;
server.listen(PORT,'127.0.0.1',()=>console.log('NAS_EVENT_PROBE_READY',PORT));
const close=()=>server.close(()=>process.exit(0));process.on('SIGTERM',close);process.on('SIGINT',close);
