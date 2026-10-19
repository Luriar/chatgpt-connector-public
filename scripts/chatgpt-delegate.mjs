#!/usr/bin/env node
import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";

const argv=process.argv.slice(2);
const take=(name)=>{
  const i=argv.indexOf(name);
  if(i<0)return null;
  const v=argv[i+1];argv.splice(i,v===undefined?1:2);return v??"";
};
const flag=(name)=>{const i=argv.indexOf(name);if(i<0)return false;argv.splice(i,1);return true;};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

function config(){
  const url=(take("--url")||process.env.WEBJJONKU_COORDINATOR_URL||"").replace(/\/$/,"");
  const tokenFile=take("--token-file")||process.env.WEBJJONKU_COORDINATOR_TOKEN_FILE||"";
  let token=process.env.WEBJJONKU_COORDINATOR_TOKEN||"";
  if(!token&&tokenFile)token=fs.readFileSync(path.resolve(tokenFile),"utf8").trim();
  if(!url)throw new Error("WEBJJONKU_COORDINATOR_URL or --url is required");
  if(!token)throw new Error("WEBJJONKU_COORDINATOR_TOKEN or --token-file is required");
  return {url,token};
}

async function api(cfg,method,p,body,{read=false,retries=2}={}){
  const run=async()=>{
    const r=await fetch(cfg.url+p,{method,headers:{authorization:"Bearer "+cfg.token,...(body!==undefined?{"content-type":"application/json"}:{})},body:body===undefined?undefined:JSON.stringify(body)});
    const txt=await r.text();let data;try{data=txt?JSON.parse(txt):null;}catch{data={error:txt};}
    return {r,data};
  };
  for(let attempt=0;;attempt++){
    try{
      const {r,data}=await run();
      if(read&&[502,503,504].includes(r.status)&&attempt<retries){await sleep(250*2**attempt);continue;}
      if(!r.ok)throw new Error(data?.error||("HTTP "+r.status));
      return data;
    }catch(e){
      if(read&&attempt<retries&&(e?.name==="TypeError"||/fetch|socket|ECONN|timeout/i.test(String(e?.message||e)))){await sleep(250*2**attempt);continue;}
      throw e;
    }
  }
}

function normalizeMode(v){
  const m=String(v||"xh").toLowerCase();
  return ({m:"m",medium:"m",h:"h",high:"h",xh:"xh",xhigh:"xh",p:"pro",pro:"pro"})[m]||null;
}
function taskPrompt(d){
  if(d.kind==="open")return [
    "Open a user-controlled project chat through ChatGPT Connector.",
    "Use delegation_get_task with this private capability token to read the project context:",
    d.taskToken,
    "Keep this chat open for the user. Do not call delegation_submit_result for an open session and do not expose the capability token."
  ].join("\n");
  return [
    "A supervisor delegated a bounded task through ChatGPT Connector.",
    "Use the ChatGPT Connector tool delegation_get_task with this private capability token:",
    d.taskToken,
    "Complete only the assigned task and its relevant verification.",
    "When finished, call delegation_submit_result with the same token and status completed, partial, failed, or cancelled.",
    "Do not echo or expose the capability token in your response."
  ].join("\n");
}
async function stdinText(){
  if(process.stdin.isTTY)return "";
  const parts=[];for await(const c of process.stdin)parts.push(c);return Buffer.concat(parts).toString("utf8");
}
function print(v){process.stdout.write(JSON.stringify(v,null,2)+"\n");}
function sha(s){return crypto.createHash("sha256").update(Buffer.from(String(s),"utf8")).digest("hex");}

async function register(cfg,{kind="delegate"}={}){
  const title=take("--title");
  const mode=normalizeMode(take("--mode")||"xh");if(!mode)throw new Error("unsupported mode");
  const cwd=take("--cwd")||process.cwd();
  const backupMsRaw=take("--backup-ms"),backupMs=backupMsRaw?Number(backupMsRaw):undefined;
  let instructions=take("--task");
  if(instructions==="-"||instructions==null)instructions=(await stdinText()).trim();
  if(!instructions)throw new Error("register requires --task <text> or stdin");
  const body={kind,mode,cwd,instructions,...(title?{title}:{}),...(Number.isFinite(backupMs)?{backupMs}:{}),targetDevice:take("--target-device")||"nas-mcp"};
  const d=await api(cfg,"POST","/v1/delegations",body);
  print({...d,prompt:taskPrompt(d)});
}
async function status(cfg,ids){
  if(!ids.length){print(await api(cfg,"GET","/v1/delegations",undefined,{read:true}));return;}
  const out=[];for(const id of ids)out.push(await api(cfg,"GET","/v1/delegations/"+encodeURIComponent(id),undefined,{read:true}));print(out.length===1?out[0]:out);
}
async function collect(cfg,id){
  const r=await api(cfg,"POST","/v1/delegations/"+encodeURIComponent(id)+"/collect",{});
  if(r.resultSha256&&sha(r.result)!==r.resultSha256)throw new Error("delegation result integrity mismatch");
  print(r);
}
async function finish(cfg,ids){
  if(!ids.length)throw new Error("finish requires at least one delegation id");
  const remaining=new Set(ids),events=[];
  while(remaining.size){
    const due=[];
    for(const id of [...remaining]){
      const d=await api(cfg,"GET","/v1/delegations/"+encodeURIComponent(id),undefined,{read:true});
      if(["completed","partial","failed","cancelled"].includes(d.status)&&d.resultSubmittedAt){
        const c=await api(cfg,"POST","/v1/delegations/"+encodeURIComponent(id)+"/collect",{});
        if(c.resultSha256&&sha(c.result)!==c.resultSha256)throw new Error("delegation result integrity mismatch for "+id);
        events.push(c);remaining.delete(id);continue;
      }
      if(d.status==="cancelled"&&!d.resultSubmittedAt){events.push(d);remaining.delete(id);continue;}
      if(d.status==="expired"){events.push(d);remaining.delete(id);continue;}
      if(d.backupDue)due.push(id);
    }
    if(due.length){print({events,backupDue:due,settled:false});return;}
    if(!remaining.size){print({events,backupDue:[],settled:true});return;}
    await sleep(2000);
  }
}
async function mutate(cfg,id,action){print(await api(cfg,"POST","/v1/delegations/"+encodeURIComponent(id)+"/"+action,{}));}

async function main(){
  const cfg=config(),cmd=argv.shift();
  if(cmd==="register")return register(cfg);
  if(cmd==="open"){
    const cwd=argv[0]&&!argv[0].startsWith("--")?argv.shift():process.cwd();
    argv.push("--cwd",cwd);
    if(!argv.includes("--task"))argv.push("--task","User-controlled project chat. Use the connected project tools when requested; do not submit a final delegation result.");
    return register(cfg,{kind:"open"});
  }
  if(cmd==="status")return status(cfg,argv);
  if(cmd==="finish")return finish(cfg,argv);
  if(cmd==="collect"){if(argv.length!==1)throw new Error("collect requires one id");return collect(cfg,argv[0]);}
  if(["cancel","checked","touch"].includes(cmd)){if(argv.length!==1)throw new Error(cmd+" requires one id");return mutate(cfg,argv[0],cmd);}
  throw new Error("usage: chatgpt-delegate <register|open|status|finish|collect|cancel|checked|touch> ...");
}
main().catch(e=>{process.stderr.write("chatgpt-delegate: "+String(e?.message||e)+"\n");process.exitCode=1;});
