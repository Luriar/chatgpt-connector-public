// V2 browser agent: Playwright/CDP DOM-first automation
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { resolvePinnedAddresses } from "../net-safe.js";
import { chromium } from "playwright-core";
import { z } from "zod";
import { fileURLToPath, pathToFileURL } from "node:url";
import { text } from "../toolkit.js";
import { resolveInRoots } from "../security.js";

let browser;
let context;
let activeBrokerId = null;
const pages = new Map();
const guardedContexts=new WeakSet();
async function assertNetworkUrl(ctx,raw){
  const u=new URL(raw);if(!["http:","https:"].includes(u.protocol)||ctx.cfg.browser?.allowPrivateNetwork===true)return;
  // Chromium performs its own connection, so we cannot inject Node's pinned socket lookup here.
  // Resolve on every intercepted request (no DNS allow cache) and require two consecutive stable public answer sets.
  const a=await resolvePinnedAddresses(u.hostname),b=await resolvePinnedAddresses(u.hostname);
  const sig=x=>x.map(v=>v.family+":"+v.address).sort().join("|");
  if(sig(a)!==sig(b))throw new Error("browser destination DNS changed during validation");
}
async function installNetworkGuard(ctx,ctxObj){
  if(!ctxObj||guardedContexts.has(ctxObj)||ctx.cfg.browser?.allowPrivateNetwork===true)return;
  await ctxObj.route("**/*",async route=>{
    let u;try{u=new URL(route.request().url());}catch{return route.abort("blockedbyclient");}
    if(!["http:","https:"].includes(u.protocol))return route.continue();
    try{await assertNetworkUrl(ctx,u.toString());await route.continue();}catch{await route.abort("blockedbyclient");}
  });
  guardedContexts.add(ctxObj);
}

function candidates() {
  if (process.platform === "win32") {
    const pf = process.env.PROGRAMFILES || "C:\\Program Files";
    const pfx86 = process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)";
    const local = process.env.LOCALAPPDATA || "";
    return [
      path.join(pf, "Google", "Chrome", "Application", "chrome.exe"),
      path.join(pfx86, "Google", "Chrome", "Application", "chrome.exe"),
      path.join(local, "Google", "Chrome", "Application", "chrome.exe"),
      path.join(pf, "Microsoft", "Edge", "Application", "msedge.exe"),
      path.join(pfx86, "Microsoft", "Edge", "Application", "msedge.exe")
    ];
  }
  if (process.platform === "darwin") return ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome","/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"];
  return ["/usr/bin/google-chrome","/usr/bin/chromium","/usr/bin/chromium-browser","/usr/bin/microsoft-edge"];
}

function findExecutable(cfg) {
  const explicit = cfg.browser?.executablePath;
  if (explicit && fs.existsSync(explicit)) return explicit;
  return candidates().find(fs.existsSync);
}

function knownProfileRoot(kind) {
  if (process.platform !== "win32") throw new Error("로그인 프로필 broker는 현재 Windows Chrome/Edge 지원");
  const local = process.env.LOCALAPPDATA || "";
  if (kind === "chrome") return path.join(local, "Google", "Chrome", "User Data");
  if (kind === "edge") return path.join(local, "Microsoft", "Edge", "User Data");
  throw new Error("browser는 chrome|edge");
}
function profileDest(ctx, kind, profileName) {
  return path.join(ctx.cfg.stateDir, "browser-profiles", kind + "-" + profileName.replace(/[^A-Za-z0-9._-]/g, "_"));
}
function currentWindowsSid(){
  try{
    const who=spawnSync("whoami",["/user","/fo","csv","/nh"],{encoding:"utf8",timeout:5000,windowsHide:true});
    return String(who.stdout||"").match(/"[^"]*","([^"]+)"/)?.[1]||null;
  }catch{return null;}
}
function hardenPrivateTree(dir){
  if(process.platform==="win32"){
    const sid=currentWindowsSid();if(!sid)return false;
    try{
      const r=spawnSync("icacls",[dir,"/inheritance:r","/grant:r","*"+sid+":(OI)(CI)(F)","/grant:r","*S-1-5-18:(OI)(CI)(F)"],{stdio:"ignore",windowsHide:true,timeout:15000});
      return r.status===0;
    }catch{return false;}
  }
  try{
    const walk=(p)=>{const st=fs.lstatSync(p);if(st.isSymbolicLink())return;if(st.isDirectory()){fs.chmodSync(p,0o700);for(const n of fs.readdirSync(p))walk(path.join(p,n));}else fs.chmodSync(p,0o600);};
    walk(dir);return true;
  }catch{return false;}
}
function profileMetaFile(dir){return path.join(dir,".webjjonku-profile.json");}
function readProfileMeta(dir){try{return JSON.parse(fs.readFileSync(profileMetaFile(dir),"utf8"));}catch{return null;}}
function writeProfileMeta(dir,kind,profileName){
  const meta={browser:kind,profile:profileName,refreshedAt:new Date().toISOString()};
  fs.writeFileSync(profileMetaFile(dir),JSON.stringify(meta,null,2),{mode:0o600});return meta;
}
function pruneProfileSnapshots(ctx){
  const root=path.join(ctx.cfg.stateDir,"browser-profiles"),days=Math.max(1,Number(ctx.cfg.browser?.profileRetentionDays||7)),cutoff=Date.now()-days*86400000;
  if(!fs.existsSync(root))return 0;let removed=0;
  for(const e of fs.readdirSync(root,{withFileTypes:true})){
    if(!e.isDirectory())continue;const dir=path.join(root,e.name),meta=readProfileMeta(dir),ts=meta?.refreshedAt?new Date(meta.refreshedAt).getTime():fs.statSync(dir).mtimeMs;
    if(Number.isFinite(ts)&&ts<cutoff){try{fs.rmSync(dir,{recursive:true,force:true});removed++;}catch{}}
  }
  return removed;
}
function copyProfileSnapshot(ctx, kind, profileName) {
  if (!/^[A-Za-z0-9 ._-]+$/.test(profileName) || profileName.includes("..")) throw new Error("잘못된 profile name");
  const root=knownProfileRoot(kind), src=path.join(root,profileName), dest=profileDest(ctx,kind,profileName);
  if(!fs.existsSync(src)) throw new Error("브라우저 profile 없음: "+src);
  // Never delete a known-good snapshot before a copy from a live profile succeeds.
  const staging=dest+".copy-"+crypto.randomBytes(4).toString("hex");
  fs.mkdirSync(staging,{recursive:true});
  try {
    const skip=new Set(["Cache","Code Cache","GPUCache","GrShaderCache","ShaderCache","DawnCache","Crashpad"]);
    const filter=(source)=>!source.split(path.sep).some(part=>skip.has(part));
    const localState=path.join(root,"Local State");
    if(fs.existsSync(localState))fs.copyFileSync(localState,path.join(staging,"Local State"));
    fs.cpSync(src,path.join(staging,profileName),{recursive:true,filter});
    writeProfileMeta(staging,kind,profileName);
    if(!hardenPrivateTree(staging))throw new Error("browser profile snapshot ACL/permission hardening failed");
    fs.rmSync(dest,{recursive:true,force:true});
    fs.renameSync(staging,dest);
    return dest;
  } catch(e) {
    try{fs.rmSync(staging,{recursive:true,force:true});}catch{}
    if(e?.code==="EBUSY"||e?.code==="EPERM") {
      throw new Error("실행 중인 "+kind+" 프로필이 잠겨 복제할 수 없음. 기존 창은 닫지 않고 computer_* (Windows UI Automation), desktop_* 도구로 조작하거나 CDP가 이미 활성화된 브라우저에 연결하세요. cause="+String(e.code));
    }
    throw e;
  }
}
async function attachContextPages(ctxObj) {
  ctxObj.on("page",p=>attach(p));
  const ps=ctxObj.pages();
  if(!ps.length)attach(await ctxObj.newPage());else for(const p of ps)attach(p);
}

async function ensure(ctx) {
  if (browser?.isConnected()) return;
  const exe = findExecutable(ctx.cfg);
  if (!exe) throw new Error("Chrome/Edge 실행 파일을 찾지 못했어. browser.executablePath를 설정해줘.");
  browser = await chromium.launch({
    executablePath: exe,
    headless: ctx.cfg.browser?.headless ?? true,
    args: ["--disable-background-networking","--disable-component-update","--no-first-run"],
  });
  context = await browser.newContext({ acceptDownloads: true,serviceWorkers:"block" });
  await installNetworkGuard(ctx,context);
  context.on("page", (p) => attach(p));
  attach(await context.newPage());
}

function attach(page) {
  let id = [...pages].find(([,p]) => p === page)?.[0];
  if (!id) {
    id = "p" + Math.random().toString(36).slice(2,8);
    pages.set(id, page);
    page.on("close", () => pages.delete(id));
  }
  return id;
}

function getPage(id) {
  if (id) {
    const p = pages.get(id);
    if (!p) throw new Error(`브라우저 탭 없음: ${id}`);
    return p;
  }
  const last = [...pages.values()].filter(p=>!p.isClosed()).at(-1);
  if (!last) throw new Error("브라우저 탭 없음. browser_open 먼저.");
  return last;
}

function safeUrl(ctx,url) {
  const u = new URL(url);
  if(["http:","https:","data:"].includes(u.protocol))return u.toString();
  if(u.protocol==="file:"){
    const abs=resolveInRoots(ctx.cfg,fileURLToPath(u));
    return pathToFileURL(abs).toString();
  }
  throw new Error("http/https/data 또는 승인 루트 안 file URL만 허용");
}


function ensureBrokers(store) {
  if (!store.data.browserBrokers || typeof store.data.browserBrokers !== "object") store.data.browserBrokers = {};
}
function brokerDir(ctx, id) {
  return path.join(ctx.cfg.stateDir, "browser-brokers", id);
}
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}
function pruneStaleBrokers(ctx){
  ensureBrokers(ctx.store);const days=Math.max(1,Number(ctx.cfg.browser?.profileRetentionDays||7)),cutoff=Date.now()-days*86400000;let removed=0;
  for(const [id,rec] of Object.entries(ctx.store.data.browserBrokers)){
    const ts=new Date(rec.lastConnectedAt||rec.startedAt||0).getTime();
    if(!pidAlive(rec.pid)&&Number.isFinite(ts)&&ts<cutoff){
      try{fs.rmSync(rec.userDataDir,{recursive:true,force:true});}catch{}
      delete ctx.store.data.browserBrokers[id];removed++;
    }
  }
  return removed;
}
function killBrowserTree(pid){
  if(!Number.isInteger(pid)||pid<=0)return;
  if(process.platform==="win32"){try{spawnSync("taskkill",["/PID",String(pid),"/T","/F"],{windowsHide:true,stdio:"ignore",timeout:10000});}catch{}}
  else{try{process.kill(-pid,"SIGKILL");}catch{try{process.kill(pid,"SIGKILL");}catch{}}}
}
async function waitDevTools(dir, timeoutMs=12000) {
  const file=path.join(dir,"DevToolsActivePort"),end=Date.now()+timeoutMs;
  while(Date.now()<end) {
    if(fs.existsSync(file)) {
      const lines=fs.readFileSync(file,"utf8").trim().split(/\r?\n/);
      const port=Number(lines[0]);if(port>0)return "http://127.0.0.1:"+port;
    }
    await new Promise(r=>setTimeout(r,150));
  }
  throw new Error("DevToolsActivePort timeout");
}
async function attachBrokerEndpoint(ctx,endpoint,id) {
  pages.clear();
  browser=await chromium.connectOverCDP(endpoint);
  context=browser.contexts()[0];
  if(!context)throw new Error("broker browser context 없음");
  await installNetworkGuard(ctx,context);await attachContextPages(context);activeBrokerId=id||null;
}
function pickFrame(page,{frame_name,frame_url_contains}={}) {
  const frames=page.frames();
  const f=frames.find(x=>(!frame_name||x.name()===frame_name)&&(!frame_url_contains||x.url().includes(frame_url_contains)));
  if(!f)throw new Error("frame 없음");return f;
}

export function registerBrowserTools(reg, ctx) {
  ensureBrokers(ctx.store);
  const staleSnapshotsRemoved=pruneProfileSnapshots(ctx),staleBrokersRemoved=pruneStaleBrokers(ctx);
  if(staleBrokersRemoved)ctx.store.save();
  reg("browser_status", { description:"V2 Playwright 브라우저 에이전트 상태와 실행 가능 브라우저를 확인한다.", inputSchema:{} }, async () => {
    const exe=findExecutable(ctx.cfg);
    return text(JSON.stringify({available:!!exe,executablePath:exe||null,running:!!browser?.isConnected(),tabs:[...pages].filter(([,p])=>!p.isClosed()).length,profileRetentionDays:Math.max(1,Number(ctx.cfg.browser?.profileRetentionDays||7)),startupCleanup:{staleSnapshotsRemoved,staleBrokersRemoved}},null,2));
  });

  reg("browser_connect_cdp", {
    description:"이미 remote-debugging이 켜진 Chrome/Edge에 CDP로 연결한다. 기존 로그인 세션을 재사용하지만 cookie/token 값은 MCP 응답으로 노출하지 않는다.",
    inputSchema:{endpoint:z.string().url()}
  }, async ({endpoint}) => {
    try{await browser?.close();}catch{} pages.clear();
    browser=await chromium.connectOverCDP(endpoint); context=browser.contexts()[0];
    if(!context) throw new Error("CDP browser context 없음");
    await installNetworkGuard(ctx,context);await attachContextPages(context);
    const eu=new URL(endpoint);return text(JSON.stringify({connected:true,tabs:context.pages().length,endpointProtocol:eu.protocol,endpointHost:eu.host},null,2));
  });

  reg("browser_clone_profile", {
    description:"현재 Windows 사용자의 Chrome/Edge 로그인 profile을 webjjonku 전용 broker snapshot으로 복제한다. cookie 값을 읽거나 출력하지 않으며 캐시는 제외한다.",
    inputSchema:{browser:z.enum(["chrome","edge"]),profile_name:z.string().optional()}
  }, async ({browser:kind,profile_name="Default"}) => {
    const dest=copyProfileSnapshot(ctx,kind,profile_name);
    return text(JSON.stringify({snapshot:true,browser:kind,profile:profile_name,path:dest},null,2));
  });

  reg("browser_open_profile", {
    description:"복제된 로그인 profile snapshot으로 별도 브라우저 context를 시작한다. 원본 profile을 직접 수정하지 않는다.",
    inputSchema:{browser:z.enum(["chrome","edge"]),profile_name:z.string().optional(),refresh_snapshot:z.boolean().optional(),headless:z.boolean().optional()}
  }, async ({browser:kind,profile_name="Default",refresh_snapshot=false,headless=false}) => {
    try{await browser?.close();}catch{} pages.clear();
    const dest=refresh_snapshot||!fs.existsSync(profileDest(ctx,kind,profile_name))?copyProfileSnapshot(ctx,kind,profile_name):profileDest(ctx,kind,profile_name);
    const exe=kind==="chrome"?candidates().find(p=>/chrome\.exe$/i.test(p)&&fs.existsSync(p)):candidates().find(p=>/msedge\.exe$/i.test(p)&&fs.existsSync(p));
    if(!exe)throw new Error(kind+" 실행 파일 없음");
    context=await chromium.launchPersistentContext(dest,{executablePath:exe,headless,args:["--profile-directory="+profile_name,"--no-first-run","--disable-component-update"],acceptDownloads:true,serviceWorkers:"block"});
    await installNetworkGuard(ctx,context);browser=context.browser();await attachContextPages(context);
    return text(JSON.stringify({opened:true,browser:kind,profile:profile_name,tabs:context.pages().length},null,2));
  });

  reg("browser_profile_status", {
    description:"webjjonku broker에 만들어진 로그인 profile snapshot 목록을 본다. cookie/token 내용은 읽지 않는다.",
    inputSchema:{}
  }, async () => {
    const root=path.join(ctx.cfg.stateDir,"browser-profiles");if(!fs.existsSync(root))return text("[]");
    const retentionDays=Math.max(1,Number(ctx.cfg.browser?.profileRetentionDays||7));
    const rows=fs.readdirSync(root,{withFileTypes:true}).filter(e=>e.isDirectory()).map(e=>{const dir=path.join(root,e.name),st=fs.statSync(dir),meta=readProfileMeta(dir);return {name:e.name,modified:st.mtime.toISOString(),refreshedAt:meta?.refreshedAt||null,retentionDays};});
    return text(JSON.stringify(rows,null,2));
  });

  reg("browser_broker_start", {
    description:"Chrome/Edge profile snapshot을 별도 broker 프로세스로 실행하고 CDP에 연결한다. 브라우저 프로세스는 MCP보다 오래 살아남을 수 있어 이후 reconnect 가능.",
    inputSchema:{browser:z.enum(["chrome","edge"]),profile_name:z.string().optional(),refresh_snapshot:z.boolean().optional(),use_profile_snapshot:z.boolean().optional(),visible:z.boolean().optional()}
  }, async ({browser:kind,profile_name="Default",refresh_snapshot=false,use_profile_snapshot=true,visible=true}) => {
    ensureBrokers(ctx.store);
    const exe=kind==="chrome"?candidates().find(p=>/chrome\.exe$/i.test(p)&&fs.existsSync(p)):candidates().find(p=>/msedge\.exe$/i.test(p)&&fs.existsSync(p));
    if(!exe)throw new Error(kind+" 실행 파일 없음");
    const id="bb_"+crypto.randomBytes(5).toString("hex"),dir=brokerDir(ctx,id);
    fs.mkdirSync(path.dirname(dir),{recursive:true});
    if(use_profile_snapshot){const snap=refresh_snapshot||!fs.existsSync(profileDest(ctx,kind,profile_name))?copyProfileSnapshot(ctx,kind,profile_name):profileDest(ctx,kind,profile_name);fs.cpSync(snap,dir,{recursive:true});}else fs.mkdirSync(dir,{recursive:true});
    for(const n of ["SingletonLock","SingletonCookie","SingletonSocket","DevToolsActivePort"]){try{fs.rmSync(path.join(dir,n),{force:true,recursive:true});}catch{}}
    if(!hardenPrivateTree(dir))throw new Error("browser broker profile ACL/permission hardening failed");
    const args=["--user-data-dir="+dir,"--profile-directory="+profile_name,"--remote-debugging-port=0","--no-first-run","--no-default-browser-check","about:blank"];
    if(!visible)args.unshift("--headless=new");
    const proc=spawn(exe,args,{detached:true,stdio:"ignore",windowsHide:!visible});proc.unref();
    const endpoint=await waitDevTools(dir,15000);await attachBrokerEndpoint(ctx,endpoint,id);
    const rec={id,browser:kind,profileName:profile_name,userDataDir:dir,pid:proc.pid,endpoint,visible,startedAt:new Date().toISOString(),lastConnectedAt:new Date().toISOString()};
    ctx.store.data.browserBrokers[id]=rec;ctx.store.save();
    return text(JSON.stringify({...rec,alive:true,tabs:context.pages().length},null,2));
  });

  reg("browser_broker_list", {
    description:"지속 browser broker 세션 목록과 프로세스 생존 상태를 본다.",
    inputSchema:{}
  }, async () => {
    ensureBrokers(ctx.store);
    const rows=Object.values(ctx.store.data.browserBrokers).map(r=>({...r,alive:pidAlive(r.pid),active:r.id===activeBrokerId}));
    return text(JSON.stringify(rows,null,2));
  });

  reg("browser_broker_reconnect", {
    description:"MCP/Chat이 바뀐 뒤에도 살아 있는 browser broker에 CDP로 다시 연결한다.",
    inputSchema:{id:z.string()}
  }, async ({id}) => {
    ensureBrokers(ctx.store);const rec=ctx.store.data.browserBrokers[id];if(!rec)throw new Error("browser broker 없음: "+id);
    if(!pidAlive(rec.pid))throw new Error("browser broker 프로세스가 살아 있지 않아");
    const endpoint=await waitDevTools(rec.userDataDir,3000);await attachBrokerEndpoint(ctx,endpoint,id);
    rec.endpoint=endpoint;rec.lastConnectedAt=new Date().toISOString();ctx.store.save();
    return text(JSON.stringify({connected:true,id,endpoint,tabs:context.pages().length},null,2));
  });

  reg("browser_broker_stop", {
    description:"browser broker 세션을 종료하고 registry에서 제거한다. keep_profile=true면 broker profile snapshot은 남긴다.",
    inputSchema:{id:z.string(),keep_profile:z.boolean().optional()}
  }, async ({id,keep_profile=true}) => {
    ensureBrokers(ctx.store);const rec=ctx.store.data.browserBrokers[id];if(!rec)throw new Error("browser broker 없음: "+id);
    if(id===activeBrokerId){try{await browser?.close();}catch{}browser=null;context=null;pages.clear();activeBrokerId=null;}
    if(pidAlive(rec.pid))killBrowserTree(rec.pid);
    delete ctx.store.data.browserBrokers[id];ctx.store.save();
    if(!keep_profile){try{fs.rmSync(rec.userDataDir,{recursive:true,force:true});}catch{}}
    return text(JSON.stringify({stopped:true,id,profileKept:keep_profile},null,2));
  });

  reg("browser_upload_file", {
    description:"현재 페이지의 file input에 승인 루트 안 파일을 업로드한다.",
    inputSchema:{page:z.string().optional(),selector:z.string(),paths:z.array(z.string()).min(1)}
  }, async ({page,selector,paths}) => {
    await ensure(ctx);const p=getPage(page),files=paths.map(x=>resolveInRoots(ctx.cfg,x));
    await p.locator(selector).first().setInputFiles(files);
    return text(JSON.stringify({uploaded:files.map(x=>path.basename(x)),count:files.length},null,2));
  });

  reg("browser_click_popup", {
    description:"요소를 클릭하면서 새 popup/tab을 기다리고 새 page id를 반환한다.",
    inputSchema:{page:z.string().optional(),selector:z.string().optional(),text:z.string().optional(),timeout_ms:z.number().int().min(100).max(60000).optional()}
  }, async ({page,selector,text:label,timeout_ms=15000}) => {
    await ensure(ctx);const p=getPage(page);
    const popupPromise=p.waitForEvent("popup",{timeout:timeout_ms});
    if(selector)await p.locator(selector).first().click();else if(label)await p.getByText(label).first().click();else throw new Error("selector 또는 text 필요");
    const pop=await popupPromise,id=attach(pop);await pop.waitForLoadState("domcontentloaded").catch(()=>{});
    return text(JSON.stringify({page:id,title:await pop.title(),url:pop.url()},null,2));
  });

  reg("browser_frames", {
    description:"페이지의 iframe/frame 목록을 name/url과 함께 반환한다.",
    inputSchema:{page:z.string().optional()}
  }, async ({page}) => {
    await ensure(ctx);const p=getPage(page);
    return text(JSON.stringify(p.frames().map((f,i)=>({index:i,name:f.name(),url:f.url(),main:f===p.mainFrame()})),null,2));
  });

  reg("browser_frame_read", {
    description:"name 또는 URL 일부로 iframe을 찾아 텍스트/제목을 DOM 기반으로 읽는다.",
    inputSchema:{page:z.string().optional(),frame_name:z.string().optional(),frame_url_contains:z.string().optional(),max_chars:z.number().int().min(100).max(50000).optional()}
  }, async ({page,frame_name,frame_url_contains,max_chars=12000}) => {
    await ensure(ctx);const p=getPage(page),f=pickFrame(p,{frame_name,frame_url_contains});
    const data=await f.evaluate(max=>({title:document.title,url:location.href,text:(document.body?.innerText||"").slice(0,max)}),max_chars);
    return text(JSON.stringify(data,null,2));
  });

  reg("browser_frame_click", {
    description:"iframe 내부 요소를 selector 또는 보이는 text로 클릭한다.",
    inputSchema:{page:z.string().optional(),frame_name:z.string().optional(),frame_url_contains:z.string().optional(),selector:z.string().optional(),text:z.string().optional()}
  }, async ({page,frame_name,frame_url_contains,selector,text:label}) => {
    await ensure(ctx);const f=pickFrame(getPage(page),{frame_name,frame_url_contains});
    if(selector)await f.locator(selector).first().click();else if(label)await f.getByText(label).first().click();else throw new Error("selector 또는 text 필요");
    return text("frame click 완료");
  });

  reg("browser_frame_type", {
    description:"iframe 내부 input을 selector로 찾아 값을 입력한다.",
    inputSchema:{page:z.string().optional(),frame_name:z.string().optional(),frame_url_contains:z.string().optional(),selector:z.string(),value:z.string(),press_enter:z.boolean().optional()}
  }, async ({page,frame_name,frame_url_contains,selector,value,press_enter=false}) => {
    await ensure(ctx);const f=pickFrame(getPage(page),{frame_name,frame_url_contains}),loc=f.locator(selector).first();
    await loc.fill(value);if(press_enter)await loc.press("Enter");return text("frame 입력 완료");
  });

  reg("browser_open", {
    description:"브라우저 URL 열기. 실패하면 비밀 쿼리 없이 호스트별 HTTP 응답/실패 사유를 제공한다.",
    inputSchema:{url:z.string(), wait_until:z.enum(["load","domcontentloaded","networkidle"]).optional()}
  }, async ({url,wait_until="domcontentloaded"}) => {
    await ensure(ctx);
    const target=safeUrl(ctx,url);
    await assertNetworkUrl(ctx,target);
    const p=await context.newPage(),id=attach(p),events=[];
    const record=(type,requestOrResponse,extra={})=>{
      try {
        const u=new URL(requestOrResponse.url());
        events.push({type,host:u.hostname,...extra});
        if(events.length>40)events.shift();
      } catch {}
    };
    p.on("response",r=>{if(r.status()>=300)record("http",r,{status:r.status()});});
    p.on("requestfailed",r=>record("failed",r,{failure:String(r.failure()||"unknown").replace(/https?:\/\/\S+/g,"[url]").slice(0,160)}));
    try {
      await p.goto(target,{waitUntil:wait_until,timeout:30000});
      return text(`${id} | ${await p.title()} | ${p.url()}`);
    } catch(e) {
      // Do not include the complete URL, cookies, request headers, or navigation query.
      const u=new URL(target);
      const msg=String(e?.message||e).split("\n")[0].replace(/https?:\/\/\S+/g,"[url]").slice(0,250);
      throw new Error("browser_open failed: "+JSON.stringify({page:id,host:u.hostname,wait_until,error:msg,events:events.slice(-16)}));
    }
  });

  reg("browser_tabs", {description:"열린 브라우저 탭 목록",inputSchema:{}}, async ()=>{
    await ensure(ctx);
    const rows=[]; for(const [id,p] of pages){if(!p.isClosed())rows.push(`${id} | ${await p.title()} | ${p.url()}`);}
    return text(rows.join("\n")||"탭 없음");
  });

  reg("browser_read", {
    description:"현재 페이지의 제목, URL, 주요 텍스트와 링크/버튼/입력 요소를 DOM 기반으로 읽는다.",
    inputSchema:{page:z.string().optional(),max_chars:z.number().int().min(100).max(50000).optional()}
  }, async ({page,max_chars=12000})=>{
    await ensure(ctx); const p=getPage(page);
    const data=await p.evaluate((max)=>{
      const text=(document.body?.innerText||"").slice(0,max);
      const items=[...document.querySelectorAll("a,button,input,textarea,select")].slice(0,250).map((el,i)=>({
        i,tag:el.tagName.toLowerCase(),text:(el.innerText||el.getAttribute("aria-label")||el.getAttribute("placeholder")||el.value||"").trim().slice(0,120),
        id:el.id||null,name:el.getAttribute("name"),type:el.getAttribute("type"),href:el.getAttribute("href")
      }));
      return {title:document.title,url:location.href,text,items};
    },max_chars);
    return text(JSON.stringify(data,null,2));
  });

  reg("browser_click", {
    description:"CSS selector 또는 보이는 텍스트로 웹 요소를 클릭한다.",
    inputSchema:{page:z.string().optional(),selector:z.string().optional(),text:z.string().optional(),exact:z.boolean().optional()}
  }, async ({page,selector,text:label,exact=false})=>{
    await ensure(ctx); const p=getPage(page);
    if(selector) await p.locator(selector).first().click({timeout:15000});
    else if(label) await p.getByText(label,{exact}).first().click({timeout:15000});
    else throw new Error("selector 또는 text 필요");
    return text(`clicked | ${p.url()}`);
  });

  reg("browser_type", {
    description:"CSS selector로 입력 요소를 찾아 값을 채운다. press_enter=true면 Enter도 전송한다.",
    inputSchema:{page:z.string().optional(),selector:z.string(),value:z.string(),press_enter:z.boolean().optional()}
  }, async ({page,selector,value,press_enter=false})=>{
    await ensure(ctx); const p=getPage(page); const loc=p.locator(selector).first();
    await loc.fill(value,{timeout:15000}); if(press_enter) await loc.press("Enter");
    return text("입력 완료");
  });

  reg("browser_wait", {
    description:"selector가 나타나거나 지정 시간(ms)이 지날 때까지 기다린다.",
    inputSchema:{page:z.string().optional(),selector:z.string().optional(),ms:z.number().int().min(0).max(120000).optional()}
  }, async ({page,selector,ms=1000})=>{
    await ensure(ctx); const p=getPage(page);
    if(selector) await p.locator(selector).first().waitFor({state:"visible",timeout:ms||30000}); else await p.waitForTimeout(ms);
    return text("대기 완료");
  });

  reg("browser_screenshot", {
    description:"현재 웹페이지 스크린샷을 승인 루트 안 PNG 파일로 저장한다.",
    inputSchema:{page:z.string().optional(),path:z.string(),full_page:z.boolean().optional()}
  }, async ({page,path:out,full_page=true})=>{
    await ensure(ctx); const p=getPage(page); const abs=resolveInRoots(ctx.cfg,out,{forWrite:true});
    fs.mkdirSync(path.dirname(abs),{recursive:true}); await p.screenshot({path:abs,fullPage:full_page});
    return text(`저장됨: ${abs}`);
  });

  reg("browser_download", {
    description:"클릭으로 발생하는 다운로드를 승인 루트 안 경로에 저장한다.",
    inputSchema:{page:z.string().optional(),selector:z.string(),path:z.string()}
  }, async ({page,selector,path:out})=>{
    await ensure(ctx); const p=getPage(page); const abs=resolveInRoots(ctx.cfg,out,{forWrite:true});
    const [dl]=await Promise.all([p.waitForEvent("download"),p.locator(selector).first().click()]);
    fs.mkdirSync(path.dirname(abs),{recursive:true}); await dl.saveAs(abs);
    return text(`다운로드 저장: ${abs}`);
  });

  reg("browser_close", {description:"브라우저 탭 또는 전체 브라우저를 닫는다.",inputSchema:{page:z.string().optional(),all:z.boolean().optional()}}, async ({page,all=false})=>{
    if(all){try{await browser?.close();}catch{} browser=null;context=null;pages.clear();activeBrokerId=null;return text("브라우저 종료");}
    const p=getPage(page); await p.close(); return text("탭 닫음");
  });
}
