import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const clamp=(n,min,max)=>Math.max(min,Math.min(max,Number(n)||min));
const terminalCode=v=>typeof v==="string"&&/^[A-Za-z0-9_.:-]{1,80}$/.test(v)?v:null;
const byteHeader=v=>{const n=Number(v);return Number.isFinite(n)&&n>=0?Math.min(n,1024*1024*1024):null;};

export function classifyHttpPath(pathname,mcpPath){
  if(pathname==="/health")return "health";
  if(pathname===mcpPath)return "mcp";
  if(pathname?.startsWith("/artifact/"))return "artifact";
  if(pathname?.startsWith("/site/"))return "site";
  return "other";
}

function transportClass(address){
  const s=String(address||"");
  if(["127.0.0.1","::1","::ffff:127.0.0.1"].includes(s))return "loopback";
  if(s.includes(":"))return "ipv6";
  if(/^\d{1,3}(?:\.\d{1,3}){3}$/.test(s))return "ipv4";
  return "unknown";
}

export class TransportTelemetry{
  constructor(cfg){
    this.enabled=process.env.WEBJJONKU_TRANSPORT_TELEMETRY!=="0";
    this.stateDir=cfg.stateDir;
    this.profile=cfg.runtimeProfile||null;
    this.file=path.join(this.stateDir,"transport-telemetry.jsonl");
    this.backup=this.file+".1";
    this.maxBytes=clamp(process.env.WEBJJONKU_TRANSPORT_TELEMETRY_MAX_BYTES||2*1024*1024,256*1024,16*1024*1024);
    this.ringMax=clamp(process.env.WEBJJONKU_TRANSPORT_TELEMETRY_RING||200,50,2000);
    this.recent=[];
    this.socketMeta=new WeakMap();
    this.openConnections=0;
    this.lastIngressAt=null;
    this.lastMcpRequestAt=null;
    this.lastEventAt=null;
    this.pending=Promise.resolve();
    fs.mkdirSync(this.stateDir,{recursive:true});
    const saltFile=path.join(this.stateDir,"transport-telemetry.salt");
    try{this.salt=fs.readFileSync(saltFile);}
    catch{this.salt=crypto.randomBytes(32);fs.writeFileSync(saltFile,this.salt,{mode:0o600});}
    this.loadTail();
  }
  loadTail(){
    if(!this.enabled)return;
    const rows=[];
    for(const file of [this.backup,this.file]){
      try{
        const raw=fs.readFileSync(file,"utf8");
        for(const line of raw.split(/\r?\n/))if(line.trim())try{rows.push(JSON.parse(line));}catch{}
      }catch{}
    }
    this.recent=rows.slice(-this.ringMax);
    const last=this.recent.at(-1);
    this.lastEventAt=last?.ts||null;
    this.lastIngressAt=[...this.recent].reverse().find(x=>x.event==="request_start")?.ts||null;
    this.lastMcpRequestAt=[...this.recent].reverse().find(x=>x.event==="request_start"&&x.pathClass==="mcp")?.ts||null;
  }
  token(value){
    if(!value)return null;
    return crypto.createHmac("sha256",this.salt).update(String(value)).digest("hex").slice(0,16);
  }
  record(event,fields={}){
    if(!this.enabled)return null;
    const row={ts:new Date().toISOString(),event:String(event).slice(0,64),pid:process.pid,host:os.hostname(),profile:this.profile};
    const strings=["connectionId","requestId","sessionKey","transport","remoteHash","method","pathClass","errorClass","errorCode"];
    for(const k of strings)if(fields[k]!==undefined&&fields[k]!==null)row[k]=String(fields[k]).slice(0,120);
    const nums=["statusCode","durationMs","requestBytes","responseBytes"];
    for(const k of nums)if(Number.isFinite(fields[k]))row[k]=Math.max(0,Math.round(fields[k]));
    if(typeof fields.hadError==="boolean")row.hadError=fields.hadError;
    this.recent.push(row);if(this.recent.length>this.ringMax)this.recent.splice(0,this.recent.length-this.ringMax);
    this.lastEventAt=row.ts;
    if(row.event==="request_start"){this.lastIngressAt=row.ts;if(row.pathClass==="mcp")this.lastMcpRequestAt=row.ts;}
    const line=JSON.stringify(row)+"\n";
    this.pending=this.pending.then(async()=>{
      await fs.promises.appendFile(this.file,line,{encoding:"utf8",mode:0o600});
      const st=await fs.promises.stat(this.file);
      if(st.size>this.maxBytes){
        try{await fs.promises.rm(this.backup,{force:true});}catch{}
        try{await fs.promises.rename(this.file,this.backup);}catch{}
      }
    }).catch(()=>{});
    return row;
  }
  attachServer(server){
    if(!this.enabled)return;
    server.on("connection",socket=>{
      const connectionId="c_"+crypto.randomBytes(6).toString("hex");
      const started=Date.now(),address=socket.remoteAddress||"";
      const meta={connectionId,started,remoteHash:this.token(address),transport:transportClass(address)};
      this.socketMeta.set(socket,meta);this.openConnections++;
      this.record("connection_open",meta);
      socket.once("error",error=>this.record("socket_error",{...meta,errorClass:error?.name||"Error",errorCode:terminalCode(error?.code)}));
      socket.once("close",hadError=>{this.openConnections=Math.max(0,this.openConnections-1);this.record("connection_close",{...meta,hadError:!!hadError,durationMs:Date.now()-started});});
    });
  }
  beginRequest(req,res,pathClass,sessionId){
    if(!this.enabled)return null;
    const meta=this.socketMeta.get(req.socket)||{connectionId:null,remoteHash:this.token(req.socket?.remoteAddress||""),transport:transportClass(req.socket?.remoteAddress)};
    const requestId="r_"+crypto.randomBytes(6).toString("hex"),started=Date.now(),sessionKey=this.token(sessionId);
    const base={connectionId:meta.connectionId,requestId,sessionKey,transport:meta.transport,remoteHash:meta.remoteHash,method:String(req.method||"").toUpperCase().slice(0,12),pathClass:String(pathClass||"other").slice(0,32)};
    const requestBytes=byteHeader(req.headers?.["content-length"]);if(requestBytes!==null)base.requestBytes=requestBytes;
    this.record("request_start",base);
    let finished=false;
    req.once("aborted",()=>this.record("request_abort",{...base,durationMs:Date.now()-started}));
    req.once("error",error=>this.record("request_error",{...base,durationMs:Date.now()-started,errorClass:error?.name||"Error",errorCode:terminalCode(error?.code)}));
    res.once("finish",()=>{
      finished=true;
      const responseBytes=byteHeader(res.getHeader?.("content-length"));
      this.record("request_finish",{...base,statusCode:res.statusCode,durationMs:Date.now()-started,...(responseBytes===null?{}:{responseBytes})});
    });
    res.once("close",()=>{if(!finished)this.record("response_close_early",{...base,statusCode:res.statusCode,durationMs:Date.now()-started});});
    return {
      requestId,connectionId:meta.connectionId,
      mark:(event,extra={})=>this.record(event,{...base,...extra}),
      handlerError:error=>this.record("handler_error",{...base,durationMs:Date.now()-started,errorClass:error?.name||"Error",errorCode:terminalCode(error?.code)})
    };
  }
  sessionEvent(event,sessionId,trace=null){
    return this.record(event,{sessionKey:this.token(sessionId),requestId:trace?.requestId||null,connectionId:trace?.connectionId||null,pathClass:"mcp"});
  }
  snapshot(limit=20){
    const recent=this.recent.slice(-clamp(limit,1,100));
    const counts={};for(const e of this.recent)counts[e.event]=(counts[e.event]||0)+1;
    return {enabled:this.enabled,lastEventAt:this.lastEventAt,lastIngressAt:this.lastIngressAt,lastMcpRequestAt:this.lastMcpRequestAt,openConnections:this.openConnections,retainedEvents:this.recent.length,maxFileBytes:this.maxBytes,eventCounts:counts,recent};
  }
  async flush(){await this.pending;}
}
