// Personal Cowork parity: OAuth2 Authorization Code + PKCE.
// Tokens are stored encrypted through the host credential broker.
import http from "node:http";
import crypto from "node:crypto";
import { z } from "zod";
import { pinnedRequest } from "../net-safe.js";
import { text } from "../toolkit.js";
import { putCredential, getCredential, removeCredential } from "../credentials.js";
import { assertSafeKey } from "../security.js";

const listeners = new Map();

function ensure(store){
  if(!store.data.oauthProviders || typeof store.data.oauthProviders!=="object") store.data.oauthProviders={};
  if(!store.data.oauthPending || typeof store.data.oauthPending!=="object") store.data.oauthPending={};
}
function b64url(buf){return Buffer.from(buf).toString("base64url");}
function safeEqual(a,b){const x=Buffer.from(String(a||"")),y=Buffer.from(String(b||""));return x.length===y.length&&crypto.timingSafeEqual(x,y);}
function tokenCred(name){return "oauth-token:"+name;}
function secretCred(name){return "oauth-client-secret:"+name;}
function pendingVerifierCred(name){return "oauth-pending-verifier:"+name;}
function pendingCodeCred(name){return "oauth-pending-code:"+name;}
const PENDING_TTL_MS=10*60*1000;
function pendingExpired(p){return !p?.createdAt || Date.now()-new Date(p.createdAt).getTime()>PENDING_TTL_MS;}
function clearPendingCredentials(ctx,name){removeCredential(ctx.cfg,pendingVerifierCred(name));removeCredential(ctx.cfg,pendingCodeCred(name));}

function normalizeToken(raw){
  const t={...raw};
  if(t.expires_in && !t.expiresAt) t.expiresAt=new Date(Date.now()+Number(t.expires_in)*1000).toISOString();
  return t;
}
function form(obj){
  const p=new URLSearchParams();
  for(const [k,v] of Object.entries(obj)) if(v!==undefined && v!==null && v!=="") p.set(k,String(v));
  return p;
}
async function tokenRequest(ctx,provider,params){
  const headers={"content-type":"application/x-www-form-urlencoded","accept":"application/json"};
  const secret=provider.hasClientSecret?getCredential(ctx.cfg,secretCred(provider.name)):null;
  if(provider.tokenAuthStyle==="basic" && secret){
    headers.authorization="Basic "+Buffer.from(provider.clientId+":"+secret).toString("base64");
  }else{
    params.client_id=provider.clientId;
    if(secret) params.client_secret=secret;
  }
  const endpoint=new URL(provider.tokenUrl),loop=["127.0.0.1","localhost","::1"].includes(endpoint.hostname);
  const res=await pinnedRequest(endpoint,{method:"POST",headers,body:form(params).toString(),timeoutMs:30000,maxBytes:1024*1024,allowPrivateNetwork:ctx.cfg.oauth?.allowPrivateNetwork===true,allowLoopback:loop});
  if(res.status>=300&&res.status<400)throw new Error("OAuth token endpoint redirect 차단: "+res.status);
  const raw=res.body.toString("utf8");let data;try{data=JSON.parse(raw);}catch{data=Object.fromEntries(new URLSearchParams(raw));}
  if(!res.ok || data.error) throw new Error("OAuth token exchange 실패: "+(data.error_description||data.error||("HTTP "+res.status)));
  return normalizeToken(data);
}
function saveToken(ctx,name,token){
  putCredential(ctx.cfg,tokenCred(name),JSON.stringify(token),{
    purpose:"oauth-token",
    provider:name,
    expiresAt:token.expiresAt||null,
    scopes:token.scope||null
  });
}

export async function getValidAccessToken(ctx,name){
  ensure(ctx.store);
  const provider=ctx.store.data.oauthProviders[name]; if(!provider) throw new Error("OAuth provider 없음: "+name);
  const raw=getCredential(ctx.cfg,tokenCred(name)); if(!raw) throw new Error("OAuth 연결 안 됨: "+name);
  let token; try{token=JSON.parse(raw);}catch{throw new Error("OAuth token 저장값 손상");}
  const expiry=token.expiresAt?new Date(token.expiresAt).getTime():Infinity;
  if(expiry-Date.now()>60000 && token.access_token) return token.access_token;
  if(!token.refresh_token) {
    if(token.access_token && expiry>Date.now()) return token.access_token;
    throw new Error("OAuth token 만료 및 refresh_token 없음. 다시 연결 필요.");
  }
  const refreshed=await tokenRequest(ctx,provider,{grant_type:"refresh_token",refresh_token:token.refresh_token});
  if(!refreshed.refresh_token) refreshed.refresh_token=token.refresh_token;
  if(!refreshed.scope && token.scope) refreshed.scope=token.scope;
  saveToken(ctx,name,refreshed);
  return refreshed.access_token;
}

export function registerOAuthTools(reg,ctx){
  const {store}=ctx; ensure(store);

  reg("oauth_register_provider",{
    description:"OAuth2 Authorization Code + PKCE provider를 등록한다. client_secret은 host credential broker에 암호화 저장한다.",
    inputSchema:{
      name:z.string(),authorization_url:z.string().url(),token_url:z.string().url(),client_id:z.string(),
      client_secret:z.string().optional(),scopes:z.array(z.string()).optional(),
      token_auth_style:z.enum(["post","basic","none"]).optional(),
      extra_authorize:z.record(z.string()).optional()
    }
  },async({name,authorization_url,token_url,client_id,client_secret,scopes=[],token_auth_style="post",extra_authorize={}})=>{
    name=assertSafeKey(name,"OAuth provider name");const au=new URL(authorization_url),tu=new URL(token_url);
    const secure=u=>u.protocol==="https:"||(u.protocol==="http:"&&["127.0.0.1","localhost","::1"].includes(u.hostname));
    if(!secure(au)||!secure(tu))throw new Error("OAuth authorization/token endpoint는 HTTPS 또는 loopback HTTP만 허용");
    const reserved=new Set(["response_type","client_id","redirect_uri","scope","state","code_challenge","code_challenge_method"]);
    for(const k of Object.keys(extra_authorize||{}))if(reserved.has(k.toLowerCase()))throw new Error("extra_authorize에서 보안 예약 파라미터 덮어쓰기 금지: "+k);
    if(client_secret) putCredential(ctx.cfg,secretCred(name),client_secret,{purpose:"oauth-client-secret",provider:name});
    store.data.oauthProviders[name]={name,authorizationUrl:authorization_url,tokenUrl:token_url,clientId:client_id,hasClientSecret:!!client_secret,scopes,tokenAuthStyle:token_auth_style,extraAuthorize:extra_authorize,updatedAt:new Date().toISOString()};
    store.save(); return text("OAuth provider 등록: "+name);
  });

  reg("oauth_begin",{
    description:"OAuth 로그인 절차를 시작한다. 로컬 callback listener를 열고 PKCE authorization URL을 반환한다. URL을 브라우저에서 열어 승인한다.",
    inputSchema:{provider:z.string(),prompt:z.string().optional()}
  },async({provider:providerName,prompt})=>{
    const provider=store.data.oauthProviders[providerName]; if(!provider) throw new Error("OAuth provider 없음");
    if(listeners.has(providerName)){try{listeners.get(providerName).close();}catch{}listeners.delete(providerName);}
    clearPendingCredentials(ctx,providerName);
    const verifier=b64url(crypto.randomBytes(48));
    const challenge=b64url(crypto.createHash("sha256").update(verifier).digest());
    putCredential(ctx.cfg,pendingVerifierCred(providerName),verifier,{purpose:"oauth-pkce-verifier",provider:providerName,expiresAt:new Date(Date.now()+PENDING_TTL_MS).toISOString()});
    const state=b64url(crypto.randomBytes(24));
    const server=http.createServer((req,res)=>{
      try{
        const u=new URL(req.url,"http://127.0.0.1");
        if(u.pathname!=="/callback"){res.writeHead(404).end("not found");return;}
        const p=store.data.oauthPending[providerName];
        if(!p || !safeEqual(u.searchParams.get("state"),p.state)){res.writeHead(400).end("OAuth state mismatch");return;}
        if(pendingExpired(p)){clearPendingCredentials(ctx,providerName);delete store.data.oauthPending[providerName];store.save();res.writeHead(400).end("OAuth request expired");return;}
        if(p.receivedAt){res.writeHead(409).end("OAuth callback already received");return;}
        if(u.searchParams.get("error")){p.error=u.searchParams.get("error_description")||u.searchParams.get("error");p.receivedAt=new Date().toISOString();store.save();res.writeHead(400,{"content-type":"text/plain; charset=utf-8"}).end("OAuth denied. Return to ChatGPT.");setImmediate(()=>{try{server.close();}catch{}listeners.delete(providerName);});return;}
        const receivedCode=u.searchParams.get("code");if(!receivedCode){res.writeHead(400).end("OAuth code missing");return;}
        putCredential(ctx.cfg,pendingCodeCred(providerName),receivedCode,{purpose:"oauth-authorization-code",provider:providerName,expiresAt:new Date(Date.now()+PENDING_TTL_MS).toISOString()});
        p.receivedAt=new Date().toISOString();store.save();
        res.writeHead(200,{"content-type":"text/plain; charset=utf-8"}).end("OAuth authorization received. You can return to ChatGPT.");
        setImmediate(()=>{try{server.close();}catch{}listeners.delete(providerName);});
      }catch(e){res.writeHead(500).end("OAuth callback error");}
    });
    await new Promise((resolve,reject)=>{server.once("error",reject);server.listen(0,"127.0.0.1",resolve);});
    listeners.set(providerName,server);
    const port=server.address().port;
    const redirectUri="http://127.0.0.1:"+port+"/callback";
    store.data.oauthPending[providerName]={provider:providerName,state,redirectUri,createdAt:new Date().toISOString(),receivedAt:null,error:null};
    store.save();
    const u=new URL(provider.authorizationUrl);
    u.searchParams.set("response_type","code");u.searchParams.set("client_id",provider.clientId);u.searchParams.set("redirect_uri",redirectUri);
    if(provider.scopes?.length)u.searchParams.set("scope",provider.scopes.join(" "));
    u.searchParams.set("state",state);u.searchParams.set("code_challenge",challenge);u.searchParams.set("code_challenge_method","S256");
    if(prompt)u.searchParams.set("prompt",prompt);
    for(const [k,v] of Object.entries(provider.extraAuthorize||{}))u.searchParams.set(k,v);
    return text(JSON.stringify({provider:providerName,authorizationUrl:u.toString(),redirectUri,stateExpiresMinutes:10},null,2));
  });

  reg("oauth_pending_status",{description:"OAuth callback 수신 여부를 확인한다. code/token 값은 노출하지 않는다.",inputSchema:{provider:z.string()}},async({provider})=>{
    const p=store.data.oauthPending[provider]; if(!p)return text(JSON.stringify({pending:false},null,2));
    if(pendingExpired(p)){clearPendingCredentials(ctx,provider);delete store.data.oauthPending[provider];store.save();return text(JSON.stringify({pending:false,expired:true},null,2));}
    return text(JSON.stringify({pending:true,received:!!getCredential(ctx.cfg,pendingCodeCred(provider)),error:p.error||null,createdAt:p.createdAt,receivedAt:p.receivedAt||null,redirectUri:p.redirectUri},null,2));
  });

  reg("oauth_finish",{
    description:"수신된 authorization code를 token endpoint와 교환해 access/refresh token을 credential broker에 암호화 저장한다.",
    inputSchema:{provider:z.string(),code:z.string().optional(),state:z.string().optional()}
  },async({provider:providerName,code,state})=>{
    const provider=store.data.oauthProviders[providerName]; const p=store.data.oauthPending[providerName];
    if(!provider||!p)throw new Error("OAuth begin 상태 없음");
    if(code && !state)throw new Error("수동 OAuth code를 제공할 때는 state도 반드시 필요");
    if(state && !safeEqual(state,p.state))throw new Error("OAuth state mismatch");
    if(pendingExpired(p)){clearPendingCredentials(ctx,providerName);delete store.data.oauthPending[providerName];store.save();throw new Error("OAuth begin 상태 만료");}
    const actualCode=code||getCredential(ctx.cfg,pendingCodeCred(providerName)); if(!actualCode)throw new Error(p.error||"callback code 아직 없음");
    const verifier=getCredential(ctx.cfg,pendingVerifierCred(providerName));if(!verifier)throw new Error("PKCE verifier 없음 또는 만료");
    const token=await tokenRequest(ctx,provider,{grant_type:"authorization_code",code:actualCode,redirect_uri:p.redirectUri,code_verifier:verifier});
    saveToken(ctx,providerName,token);
    clearPendingCredentials(ctx,providerName);delete store.data.oauthPending[providerName];store.save();
    const s=listeners.get(providerName);if(s){try{s.close();}catch{}listeners.delete(providerName);}
    return text(JSON.stringify({connected:true,provider:providerName,expiresAt:token.expiresAt||null,scope:token.scope||null,hasRefreshToken:!!token.refresh_token},null,2));
  });

  reg("oauth_status",{description:"OAuth provider 등록/연결 상태를 토큰 값 없이 확인한다.",inputSchema:{provider:z.string().optional()}},async({provider})=>{
    const names=provider?[provider]:Object.keys(store.data.oauthProviders);
    const rows=names.map(name=>{const p=store.data.oauthProviders[name];if(!p)return {name,registered:false};const raw=getCredential(ctx.cfg,tokenCred(name));let token=null;try{token=raw?JSON.parse(raw):null;}catch{}return {name,registered:true,connected:!!token,expiresAt:token?.expiresAt||null,scope:token?.scope||null,hasRefreshToken:!!token?.refresh_token};});
    return text(JSON.stringify(rows,null,2));
  });

  reg("oauth_disconnect",{description:"저장된 OAuth token을 credential broker에서 삭제한다.",inputSchema:{provider:z.string()}},async({provider})=>{
    removeCredential(ctx.cfg,tokenCred(provider));clearPendingCredentials(ctx,provider);delete store.data.oauthPending[provider];store.save();const s=listeners.get(provider);if(s){try{s.close();}catch{}listeners.delete(provider);}return text("OAuth 연결 삭제: "+provider);
  });
}
