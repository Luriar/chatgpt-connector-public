import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { z } from "zod";
import { text } from "../toolkit.js";
import { assertMutationAllowed } from "../security.js";

const CHROMIUM_HOST_DIR="/share/CACHEDEV1_DATA/appdata/chromium-browser";
const QUIET_IMAGE="deploy-connector";

function nasOnly(){
  const profile=String(process.env.WEBJJONKU_RUNTIME_PROFILE||"").toLowerCase();
  if(profile!=="nas")throw new Error("NAS runtime profile에서만 사용할 수 있어.");
}
function run(cmd,args,{input,timeout=20000}={}){
  const r=spawnSync(cmd,args,{encoding:"utf8",input,timeout,windowsHide:true,maxBuffer:2*1024*1024});
  if(r.error)throw r.error;
  if(r.status!==0)throw new Error(`${cmd} failed (${r.status}): ${String(r.stderr||r.stdout||"").trim().slice(-2000)}`);
  return String(r.stdout||"").trim();
}
function docker(args,opts){return run("docker",args,opts);}
function read(p){try{return fs.readFileSync(p,"utf8").trim();}catch{return null;}}

function cpuState(){
  const rows=[];
  for(let i=0;i<64;i++){
    const base=`/sys/devices/system/cpu/cpu${i}/cpufreq`;
    if(!fs.existsSync(base))continue;
    rows.push({
      cpu:i,
      governor:read(path.join(base,"scaling_governor")),
      currentKHz:Number(read(path.join(base,"scaling_cur_freq"))||0)||null,
      minKHz:Number(read(path.join(base,"scaling_min_freq"))||0)||null,
      maxKHz:Number(read(path.join(base,"scaling_max_freq"))||0)||null,
      available:(read(path.join(base,"scaling_available_governors"))||"").split(/\s+/).filter(Boolean)
    });
  }
  return rows;
}
function temperatures(){
  const out=[];
  const root="/sys/class/hwmon";
  let dirs=[];try{dirs=fs.readdirSync(root);}catch{return out;}
  for(const d of dirs){
    const base=path.join(root,d),name=read(path.join(base,"name"));
    if(name!=="coretemp")continue;
    for(const f of fs.readdirSync(base).filter(x=>/^temp\d+_input$/.test(x))){
      const stem=f.replace(/_input$/,""),raw=Number(read(path.join(base,f)));
      out.push({label:read(path.join(base,stem+"_label"))||stem,celsius:Number.isFinite(raw)?raw/1000:null});
    }
  }
  return out;
}
function containerStats(){
  const wanted=new Set(["chatgpt-browser-nas","chatgpt-coordinator","chatgpt-health-monitor","chromium-browser","xiaomusic","homeassistant","music-assistant-server"]);
  const raw=docker(["stats","--no-stream","--format","{{.Name}}|{{.CPUPerc}}|{{.MemUsage}}|{{.PIDs}}"],{timeout:15000});
  return raw.split(/\r?\n/).filter(Boolean).map(line=>{
    const [name,cpu,memory,pids]=line.split("|");
    return {name,cpu,memory,pids:Number(pids)||0};
  }).filter(x=>wanted.has(x.name));
}
function chromiumConfig(){
  try{
    const env=docker(["inspect","chromium-browser","--format","{{range .Config.Env}}{{println .}}{{end}}"]);
    const pick=(k)=>env.split(/\r?\n/).find(x=>x.startsWith(k+"="))?.slice(k.length+1)||null;
    return {framerate:pick("SELKIES_FRAMERATE"),resolution:pick("MAX_RESOLUTION"),status:"running"};
  }catch{return {status:"unavailable"};}
}
function xiaoConfig(){
  try{
    const out=docker(["exec","xiaomusic","python","-c","import json;d=json.load(open('/app/conf/setting.json'));print(json.dumps({'pull_ask_sec':d.get('pull_ask_sec'),'enable_pull_ask':d.get('enable_pull_ask')}))"]);
    return JSON.parse(out);
  }catch{return null;}
}
function snapshot(){
  return {cpu:cpuState(),temperatures:temperatures(),containers:containerStats(),chromium:chromiumConfig(),xiaomusic:xiaoConfig()};
}

function setGovernor(value){
  const script='set -e; for f in /hostsys/devices/system/cpu/cpu[0-9]*/cpufreq/scaling_governor; do grep -qw "$GOV" "$(dirname "$f")/scaling_available_governors" || exit 3; echo "$GOV" > "$f"; done';
  docker(["run","--rm","--privileged","-e",`GOV=${value}`,"-v","/sys:/hostsys","--entrypoint","sh",QUIET_IMAGE,"-lc",script],{timeout:15000});
}
function composePluginSource(){
  const raw=docker(["inspect","chatgpt-connector","--format","{{range .Mounts}}{{if eq .Destination \"/usr/local/lib/docker/cli-plugins/docker-compose\"}}{{.Source}}{{end}}{{end}}"]);
  if(!raw)throw new Error("Docker Compose plugin mount source unavailable");
  return raw;
}
function setChromiumFps(value){
  const editScript=`
const fs=require("fs"),p=process.env.QUIET_COMPOSE,fps=process.env.QUIET_FPS;
let s=fs.readFileSync(p,"utf8");
const stamp=new Date().toISOString().replace(/[:.]/g,"-");
fs.copyFileSync(p,p+".bak.quiet-tool-"+stamp);
if(/\\n\\s*SELKIES_FRAMERATE:/.test(s))s=s.replace(/(\\n\\s*SELKIES_FRAMERATE:)\\s*[^\\n]+/,"$1 \\""+fps+"-"+fps+"\\\"");
else{
  const anchor='      MAX_RESOLUTION: "864x1824"';
  if(!s.includes(anchor))throw new Error("Chromium compose anchor missing");
  s=s.replace(anchor,anchor+'\\n      SELKIES_FRAMERATE: "'+fps+'-'+fps+'"');
}
fs.writeFileSync(p,s);
`;
  const composePath=path.posix.join(CHROMIUM_HOST_DIR,"docker-compose.yml");
  const plugin=composePluginSource();
  const helperScript='node -e "$QUIET_EDIT_SCRIPT"; cd "$QUIET_PROJECT_DIR"; docker compose -p chromium-browser -f docker-compose.yml up -d';
  docker([
    "run","--rm",
    "-e",`QUIET_FPS=${value}`,
    "-e",`QUIET_COMPOSE=${composePath}`,
    "-e",`QUIET_PROJECT_DIR=${CHROMIUM_HOST_DIR}`,
    "-e",`QUIET_EDIT_SCRIPT=${editScript}`,
    "-v","/var/run/docker.sock:/var/run/docker.sock",
    "-v",`${CHROMIUM_HOST_DIR}:${CHROMIUM_HOST_DIR}`,
    "-v",`${plugin}:/usr/local/lib/docker/cli-plugins/docker-compose:ro`,
    QUIET_IMAGE,"sh","-lc",helperScript
  ],{timeout:60000});
}
function setXiaoPoll(value){
  const py=`
import json,base64,urllib.request,os
p='/app/conf/setting.json'; d=json.load(open(p)); sec=int(os.environ['QUIET_POLL_SEC'])
body=json.dumps({'pull_ask_sec':sec}).encode()
req=urllib.request.Request('http://127.0.0.1:8090/api/system/modifiysetting',data=body,headers={'Content-Type':'application/json'},method='POST')
if not d.get('disable_httpauth'):
    raw=(str(d.get('httpauth_username',''))+':'+str(d.get('httpauth_password',''))).encode()
    req.add_header('Authorization','Basic '+base64.b64encode(raw).decode())
with urllib.request.urlopen(req,timeout=8) as r:
    r.read()
now=json.load(open(p))
assert now.get('pull_ask_sec')==sec
`;
  docker(["exec","-e",`QUIET_POLL_SEC=${value}`,"-i","xiaomusic","python","-"],{input:py,timeout:15000});
}

export function registerNasQuietTools(reg,ctx){
  reg("nas_quiet_status",{
    description:"NAS quiet-idle 상태를 고수준으로 확인한다. CPU governor/온도와 관련 컨테이너 사용량, Chromium/XiaoMusic quiet 설정만 반환하며 임의 명령은 실행하지 않는다.",
    inputSchema:{}
  },async()=>{
    nasOnly();
    return text(JSON.stringify(snapshot(),null,2));
  });

  reg("nas_quiet_apply",{
    description:"NAS quiet-idle의 사전 정의된 안전 설정만 적용한다. 임의 셸 명령은 받지 않으며 CPU governor, 독립 Chromium FPS, XiaoMusic polling 주기만 조정한다.",
    inputSchema:{
      cpu_governor:z.enum(["schedutil","ondemand","powersave","performance"]).optional(),
      chromium_fps:z.union([z.literal(15),z.literal(30),z.literal(60)]).optional(),
      xiaomusic_poll_sec:z.number().int().min(1).max(60).optional()
    }
  },async({cpu_governor,chromium_fps,xiaomusic_poll_sec})=>{
    nasOnly();assertMutationAllowed(ctx.cfg,"NAS quiet-idle 설정");
    const changed=[];
    if(cpu_governor){setGovernor(cpu_governor);changed.push("cpu_governor");}
    if(chromium_fps){setChromiumFps(chromium_fps);changed.push("chromium_fps");}
    if(xiaomusic_poll_sec){setXiaoPoll(xiaomusic_poll_sec);changed.push("xiaomusic_poll_sec");}
    return text(JSON.stringify({ok:true,changed,state:snapshot()},null,2));
  });
}
