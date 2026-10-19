// Personal Cowork parity: SaaS REST connector layer.
// Supports no-auth, env bearer tokens, credential-broker tokens, or OAuth broker tokens with automatic refresh.
import { z } from "zod";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { text } from "../toolkit.js";
import { pinnedRequest } from "../net-safe.js";
import { assertSafeKey } from "../security.js";
import { putCredential, getCredential } from "../credentials.js";
import { getValidAccessToken } from "./oauth.js";

const TEMPLATES = {
  github: { baseUrl:"https://api.github.com", auth:"oauth", headers:{"accept":"application/vnd.github+json","x-github-api-version":"2022-11-28","user-agent":"ChatGPT-Connector/2.0"} },
  slack: { baseUrl:"https://slack.com/api", auth:"oauth" },
  google: { baseUrl:"https://www.googleapis.com", auth:"oauth" },
  gmail: { baseUrl:"https://gmail.googleapis.com", auth:"oauth" },
  drive: { baseUrl:"https://www.googleapis.com/drive/v3", auth:"oauth" },
  calendar: { baseUrl:"https://www.googleapis.com/calendar/v3", auth:"oauth" }
};

function ensure(store){ if(!store.data.saasConnections || typeof store.data.saasConnections!=="object") store.data.saasConnections={}; }

function safeBase(base){
  const u=new URL(base);
  if(!["https:","http:"].includes(u.protocol)) throw new Error("SaaS base URL은 http/https만 가능");
  return u.toString().replace(/\/$/,"");
}
function githubCli(){
  const candidates=process.platform==="win32"?[
    process.env.ProgramFiles?path.join(process.env.ProgramFiles,"GitHub CLI","gh.exe"):null,
    process.env["ProgramFiles(x86)"]?path.join(process.env["ProgramFiles(x86)"],"GitHub CLI","gh.exe"):null,
    "gh.exe"
  ]:["gh"];
  return candidates.filter(Boolean).find(x=>x==="gh"||x==="gh.exe"||fs.existsSync(x))||null;
}

export function registerSaasTools(reg,ctx){
  const {store}=ctx; ensure(store);

  reg("saas_templates",{description:"내장 SaaS REST 연결 템플릿(GitHub/Slack/Google/Gmail/Drive/Calendar)을 본다.",inputSchema:{}},async()=>text(JSON.stringify(TEMPLATES,null,2)));

  reg("saas_register",{
    description:"SaaS REST 연결을 등록한다. oauth, env bearer, credential broker, no-auth를 지원하며 시크릿 값은 응답에 노출하지 않는다.",
    inputSchema:{
      name:z.string(),template:z.enum(["github","slack","google","gmail","drive","calendar"]).optional(),
      base_url:z.string().url().optional(),token_env:z.string().optional(),oauth_provider:z.string().optional(),credential_name:z.string().optional(),
      auth:z.enum(["oauth","bearer","credential","none"]).optional(),headers:z.record(z.string()).optional()
    }
  },async({name,template,base_url,token_env,oauth_provider,credential_name,auth,headers})=>{
    name=assertSafeKey(name,"SaaS connection name");const t=template?TEMPLATES[template]:null; const base=base_url||t?.baseUrl; if(!base)throw new Error("base_url 또는 template 필요");
    const mode=auth||t?.auth||"none";
    if(mode==="bearer"&&!token_env)throw new Error("bearer auth는 token_env 필요");
    if(mode==="oauth"&&!oauth_provider)throw new Error("oauth auth는 oauth_provider 필요");
    if(mode==="credential"&&!credential_name)throw new Error("credential auth는 credential_name 필요");
    store.data.saasConnections[name]={
      name,template:template||null,baseUrl:safeBase(base),tokenEnv:token_env||null,oauthProvider:oauth_provider||null,credentialName:credential_name||null,
      auth:mode,headers:{...(t?.headers||{}),...(headers||{})},createdAt:new Date().toISOString()
    };
    store.save(); return text("등록됨: "+name+" auth="+mode);
  });

  reg("saas_import_github_cli",{
    description:"현재 GitHub CLI(gh) 로그인 토큰을 DPAPI credential broker로 가져오고 GitHub SaaS 연결을 등록한다. 토큰 값은 응답에 노출하지 않는다.",
    inputSchema:{name:z.string().optional()}
  },async({name="github"})=>{
    name=assertSafeKey(name,"SaaS connection name");
    const gh=githubCli();if(!gh)throw new Error("GitHub CLI(gh)를 찾을 수 없어");
    const r=spawnSync(gh,["auth","token"],{encoding:"utf8",timeout:10000,windowsHide:true});
    const token=String(r.stdout||"").trim();
    if(r.status!==0||!token)throw new Error("GitHub CLI 인증 토큰을 가져오지 못했어");
    const credentialName="saas-github:"+name;
    putCredential(ctx.cfg,credentialName,token,{purpose:"saas-github",source:"gh-cli"});
    const t=TEMPLATES.github;
    store.data.saasConnections[name]={
      name,template:"github",baseUrl:t.baseUrl,tokenEnv:null,oauthProvider:null,credentialName,
      auth:"credential",headers:{...t.headers},createdAt:new Date().toISOString()
    };
    store.save();
    return text("등록됨: "+name+" auth=credential source=gh-cli");
  });

  reg("saas_list",{description:"등록된 SaaS REST 연결 목록(시크릿 값은 노출하지 않음)",inputSchema:{}},async()=>text(JSON.stringify(store.data.saasConnections,null,2)));

  reg("saas_request",{
    description:"등록된 SaaS REST API를 호출한다. 상대 path만 허용하며 credential/OAuth 인증은 credential broker를 사용한다. cross-origin redirect는 차단한다.",
    inputSchema:{
      connection:z.string(),method:z.enum(["GET","POST","PUT","PATCH","DELETE"]).optional(),path:z.string(),
      query:z.record(z.union([z.string(),z.number(),z.boolean()])).optional(),body:z.any().optional(),
      headers:z.record(z.string()).optional(),timeout_ms:z.number().int().min(1000).max(120000).optional()
    }
  },async({connection,method="GET",path:p,query,body,headers,timeout_ms=30000})=>{
    connection=assertSafeKey(connection,"SaaS connection name");const c=store.data.saasConnections[connection]; if(!c)throw new Error("SaaS 연결 없음");
    if(/^https?:\/\//i.test(p))throw new Error("절대 URL 금지: 등록된 baseUrl 아래 path만 허용");
    const u=new URL(p.replace(/^\//,""),c.baseUrl.replace(/\/$/,"")+"/");
    const baseOrigin=new URL(c.baseUrl).origin;
    if(u.origin!==baseOrigin)throw new Error("base URL 탈출 차단");
    for(const [k,v] of Object.entries(query||{}))u.searchParams.set(k,String(v));
    const h={...c.headers,...(headers||{})};
    if(c.auth==="bearer"){
      const bearer=process.env[c.tokenEnv]; if(!bearer)throw new Error("환경변수 "+c.tokenEnv+"에 인증 값이 없어");
      h.authorization="Bearer "+bearer;
    } else if(c.auth==="credential"){
      const bearer=getCredential(ctx.cfg,c.credentialName);if(!bearer)throw new Error("credential broker에 인증 값이 없어: "+c.credentialName);
      h.authorization="Bearer "+bearer;
    } else if(c.auth==="oauth"){
      const access=await getValidAccessToken(ctx,c.oauthProvider);
      h.authorization="Bearer "+access;
    }
    if(body!==undefined && !h["content-type"])h["content-type"]="application/json";
    const payload=body===undefined?undefined:(typeof body==="string"?body:JSON.stringify(body));
    const res=await pinnedRequest(u,{method,headers:h,body:payload,timeoutMs:timeout_ms,maxBytes:5*1024*1024,allowPrivateNetwork:ctx.cfg.saas?.allowPrivateNetwork===true});
    if(res.status>=300&&res.status<400)throw new Error("SaaS API redirect 차단: HTTP "+res.status);
    const raw=res.body.toString("utf8");let parsed;try{parsed=JSON.parse(raw);}catch{parsed=raw;}
    return text(JSON.stringify({status:res.status,ok:res.ok,url:u.toString(),body:parsed},null,2));
  });
}
