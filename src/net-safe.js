import http from "node:http";
import https from "node:https";
import dns from "node:dns/promises";
import net from "node:net";

export function isPrivateAddress(address){
  let s=String(address||"").toLowerCase();
  if(!s)return true;
  if(s==="::1"||s==="::"||s==="0.0.0.0"||s.startsWith("fe8")||s.startsWith("fe9")||s.startsWith("fea")||s.startsWith("feb")||s.startsWith("fc")||s.startsWith("fd"))return true;
  if(s.startsWith("::ffff:"))s=s.slice(7);
  const p=s.split(".").map(Number);
  if(p.length===4&&p.every(n=>Number.isInteger(n)&&n>=0&&n<=255)){
    if(
      p[0]===10||p[0]===127||p[0]===0||
      (p[0]===169&&p[1]===254)||
      (p[0]===192&&p[1]===168)||
      (p[0]===172&&p[1]>=16&&p[1]<=31)||
      (p[0]===100&&p[1]>=64&&p[1]<=127)||
      (p[0]===198&&[18,19].includes(p[1]))||
      p[0]>=224
    )return true;
  }
  return false;
}

function isLoopbackHost(host){
  const h=String(host||"").toLowerCase();
  return h==="localhost"||h==="127.0.0.1"||h==="::1";
}

export async function resolvePinnedAddresses(hostname,{allowPrivateNetwork=false,allowLoopback=false}={}){
  const host=String(hostname||"");
  if(!host)throw new Error("destination hostname missing");
  if(allowLoopback&&isLoopbackHost(host)){
    if(host==="localhost")return [{address:"127.0.0.1",family:4}];
    return [{address:host,family:net.isIP(host)||4}];
  }
  const family=net.isIP(host);
  const rows=family?[{address:host,family}]:await dns.lookup(host,{all:true,verbatim:true});
  if(!rows.length)throw new Error("destination DNS resolution failed");
  if(!allowPrivateNetwork&&rows.some(x=>isPrivateAddress(x.address)))throw new Error("private/link-local destination blocked");
  return rows.map(x=>({address:x.address,family:x.family}));
}

function lookupFromPinned(rows){
  return (_hostname,options,callback)=>{
    const all=typeof options==="object"&&options?.all===true;
    if(all)return callback(null,rows.map(x=>({address:x.address,family:x.family})));
    const pref=typeof options==="object"?Number(options?.family||0):0;
    const row=(pref?rows.find(x=>x.family===pref):null)||rows[0];
    callback(null,row.address,row.family);
  };
}

export async function pinnedRequest(rawUrl,{
  method="GET",
  headers={},
  body,
  timeoutMs=30000,
  maxBytes=5*1024*1024,
  allowPrivateNetwork=false,
  allowLoopback=false
}={}){
  const u=rawUrl instanceof URL?new URL(rawUrl):new URL(rawUrl);
  if(!["http:","https:"].includes(u.protocol))throw new Error("http/https only");
  // A socket inactivity timeout alone does not bound DNS or a slowly trickling body.
  const deadline=Date.now()+Math.max(1,Number(timeoutMs)||30000);
  let dnsTimer;
  const pinned=await Promise.race([
    resolvePinnedAddresses(u.hostname,{allowPrivateNetwork,allowLoopback}),
    new Promise((_,reject)=>{dnsTimer=setTimeout(()=>reject(new Error("request timeout")),Math.max(1,deadline-Date.now()));})
  ]).finally(()=>clearTimeout(dnsTimer));
  const lib=u.protocol==="https:"?https:http;
  const payload=body===undefined||body===null?null:(Buffer.isBuffer(body)?body:Buffer.from(String(body)));
  return await new Promise((resolve,reject)=>{
    let settled=false,deadlineTimer;
    const fail=e=>{if(settled)return;settled=true;clearTimeout(deadlineTimer);reject(e);};
    const req=lib.request({
      protocol:u.protocol,
      hostname:u.hostname,
      port:u.port||undefined,
      path:u.pathname+u.search,
      method,
      headers,
      servername:u.protocol==="https:"?u.hostname:undefined,
      lookup:lookupFromPinned(pinned),
      timeout:Math.max(1,deadline-Date.now())
    },res=>{
      const chunks=[];let total=0;
      res.on("data",chunk=>{
        total+=chunk.length;
        if(total>maxBytes){
          req.destroy(new Error("response too large"));
          return;
        }
        chunks.push(chunk);
      });
      res.on("end",()=>{
        if(settled)return;settled=true;clearTimeout(deadlineTimer);
        const h={};
        for(const [k,v] of Object.entries(res.headers))h[k]=Array.isArray(v)?v.join(", "):(v??"");
        resolve({
          status:Number(res.statusCode||0),
          ok:Number(res.statusCode||0)>=200&&Number(res.statusCode||0)<300,
          headers:h,
          body:Buffer.concat(chunks),
          url:u.toString(),
          pinnedAddresses:pinned.map(x=>x.address)
        });
      });
      res.on("error",fail);
      res.on("aborted",()=>fail(new Error("response aborted")));
    });
    deadlineTimer=setTimeout(()=>req.destroy(new Error("request timeout")),Math.max(1,deadline-Date.now()));
    req.on("timeout",()=>req.destroy(new Error("request timeout")));
    req.on("error",fail);
    if(payload)req.write(payload);
    req.end();
  });
}
