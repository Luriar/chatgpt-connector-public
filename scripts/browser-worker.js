#!/usr/bin/env node
// Remote/cloud browser worker for ChatGPT Work functional parity.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { chromium } from "playwright-core";
import { resolvePinnedAddresses, pinnedRequest } from "../src/net-safe.js";

const args=process.argv.slice(2);
const opt=(n,d)=>{const i=args.indexOf(n);return i>=0&&args[i+1]?args[i+1]:d;};
const coord=String(opt("--coordinator",process.env.WEBJJONKU_COORDINATOR_URL||"")).replace(/\/$/,"");
const token=opt("--token",process.env.WEBJJONKU_COORDINATOR_TOKEN||"");
const workerId=opt("--worker-id",process.env.WEBJJONKU_BROWSER_WORKER_ID||("browser_"+crypto.createHash("sha256").update(os.hostname()+"|"+process.pid).digest("hex").slice(0,10)));
const executable=opt("--browser-executable",process.env.WEBJJONKU_BROWSER_EXECUTABLE||"");
const browserHeadless=process.env.WEBJJONKU_BROWSER_HEADLESS!=="0";
const keepOpen=process.env.WEBJJONKU_BROWSER_KEEP_OPEN==="1";
const cdpUrl=String(process.env.WEBJJONKU_BROWSER_CDP_URL||"").trim();
const pollMs=Math.max(500,Number(opt("--poll-ms",process.env.WEBJJONKU_BROWSER_POLL_MS||"750"))||750);
const idleCloseMs=Math.max(0,Number(process.env.WEBJJONKU_BROWSER_IDLE_CLOSE_MS||"600000")||0);
const profileDir=String(opt("--profile-dir",process.env.WEBJJONKU_BROWSER_PROFILE_DIR||"")).trim();
const downloadDir=path.resolve(String(opt("--download-dir",process.env.WEBJJONKU_BROWSER_DOWNLOAD_DIR||(profileDir?path.join(profileDir,"downloads"):path.join(os.tmpdir(),"webjjonku-browser-downloads")))));
const allowPrivateHttp=args.includes("--allow-private-http")||process.env.WEBJJONKU_BROWSER_ALLOW_PRIVATE==="1";
const normalizeHost=h=>String(h||"").trim().toLowerCase().replace(/\.$/,"");
const privateHttpAllowlist=new Set(String(process.env.WEBJJONKU_BROWSER_PRIVATE_ALLOWLIST||"").split(",").map(normalizeHost).filter(Boolean));
const privateDestinationAllowed=u=>allowPrivateHttp||privateHttpAllowlist.has(normalizeHost(u?.hostname));
if(!coord) throw new Error("--coordinator or WEBJJONKU_COORDINATOR_URL required");
const coordUrl=new URL(coord),coordLoopback=["127.0.0.1","localhost","::1"].includes(coordUrl.hostname);
const coordAllowPrivate=coordLoopback||process.env.WEBJJONKU_COORDINATOR_ALLOW_PRIVATE==="1";
if(coordUrl.protocol==="http:"&&!coordLoopback&&process.env.WEBJJONKU_COORDINATOR_ALLOW_INSECURE_HTTP!=="1")throw new Error("non-loopback coordinator requires HTTPS");

fs.mkdirSync(downloadDir,{recursive:true});
if(profileDir)fs.mkdirSync(profileDir,{recursive:true});

const configuredRoots=String(process.env.WEBJJONKU_BROWSER_FILE_ROOTS||"")
  .split(path.delimiter).map(v=>v.trim()).filter(Boolean).map(v=>path.resolve(v));
const fileRoots=[...new Set([downloadDir,...(profileDir?[path.resolve(profileDir)]:[]),...configuredRoots])];
function within(root,target){const rel=path.relative(root,target);return rel===""||(!rel.startsWith(".."+path.sep)&&rel!==".."&&!path.isAbsolute(rel));}
function safeFile(raw,{mustExist=true}={}){
  const p=path.resolve(String(raw||""));
  if(!fileRoots.some(r=>within(r,p)))throw new Error("browser file path outside allowed roots");
  if(mustExist&&!fs.existsSync(p))throw new Error("browser file does not exist: "+p);
  return p;
}
function safeFileName(name){return String(name||"download.bin").replace(/[\\/:*?"<>|\x00-\x1f]/g,"_").slice(0,180)||"download.bin";}

function headers(extra={}){return {...extra,...(token?{authorization:"Bearer "+token}:{})};}
async function api(p,{method="GET",body,raw}={}){
  const res=await pinnedRequest(new URL(p,coordUrl),{method,headers:headers(body!==undefined?{"content-type":"application/json"}:{}),body:body===undefined?undefined:JSON.stringify(body),timeoutMs:20000,maxBytes:5*1024*1024,allowPrivateNetwork:coordAllowPrivate,allowLoopback:coordLoopback});
  if(raw)return res;
  const t=res.body.toString("utf8");let j;try{j=JSON.parse(t);}catch{j=t;}if(!res.ok)throw new Error("coordinator "+res.status+": "+JSON.stringify(j));return j;
}
async function uploadBlob(key,buf,type="application/octet-stream"){
  const res=await pinnedRequest(new URL("/v1/blobs/"+encodeURIComponent(key),coordUrl),{method:"PUT",headers:headers({"content-type":type}),body:buf,timeoutMs:30000,maxBytes:50*1024*1024,allowPrivateNetwork:coordAllowPrivate,allowLoopback:coordLoopback});
  const t=res.body.toString("utf8");if(!res.ok)throw new Error("blob upload "+res.status+": "+t);return JSON.parse(t);
}
async function assertBrowserUrl(u){
  if(!["http:","https:"].includes(u.protocol))throw new Error("browser navigation allows http/https only");
  const allowPrivate=privateDestinationAllowed(u);
  const a=await resolvePinnedAddresses(u.hostname,{allowPrivateNetwork:allowPrivate,allowLoopback:false}),b=await resolvePinnedAddresses(u.hostname,{allowPrivateNetwork:allowPrivate,allowLoopback:false});
  const sig=x=>x.map(v=>v.family+":"+v.address).sort().join("|");
  if(sig(a)!==sig(b))throw new Error("browser destination DNS changed during validation");
}
function browserCandidates(){
  if(process.platform==="win32")return [
    executable,
    process.env.PROGRAMFILES&&path.join(process.env.PROGRAMFILES,"Google","Chrome","Application","chrome.exe"),
    process.env["PROGRAMFILES(X86)"]&&path.join(process.env["PROGRAMFILES(X86)"],"Microsoft","Edge","Application","msedge.exe")
  ].filter(Boolean).find(fs.existsSync);
  return [executable,"/usr/bin/chromium","/usr/bin/chromium-browser","/usr/bin/google-chrome"].filter(Boolean).find(fs.existsSync);
}
async function heartbeat(){
  return api("/v1/devices/heartbeat",{method:"POST",body:{deviceId:workerId,capabilities:["cloud-browser","playwright","dom","downloads","uploads",...(profileDir?["persistent-profile"]:[])],meta:{hostname:os.hostname(),platform:process.platform,kind:"browser-worker",persistentProfile:!!profileDir}}});
}
async function createBrowserContext(exe){
  if(cdpUrl){
    const browser=await chromium.connectOverCDP(cdpUrl);
    const context=browser.contexts()[0];
    if(!context){try{await browser.close();}catch{}throw new Error("CDP browser has no default context");}
    return {browser,context,persistent:true,external:true};
  }
  const browserSandbox=process.env.WEBJJONKU_BROWSER_CHROMIUM_SANDBOX!=="0";
  const common={executablePath:exe,headless:browserHeadless,chromiumSandbox:browserSandbox,args:["--disable-dev-shm-usage","--window-size=1400,820"],acceptDownloads:true,downloadsPath:downloadDir,serviceWorkers:"block"};
  if(profileDir){
    // A live local Chromium owns these singleton files; never unlock its profile.
    let owner;
    try{owner=fs.readlinkSync(path.join(profileDir,"SingletonLock"));}catch{}
    const match=owner?.match(/^(.*)-(\d+)$/);
    if(match&&match[1]===os.hostname()){
      let alive=true;
      try{process.kill(Number(match[2]),0);}catch(e){if(e.code==="ESRCH")alive=false;else throw e;}
      if(alive)throw new Error("browser profile is already in use by a live Chromium process");
    }
    for(const name of ["SingletonLock","SingletonCookie","SingletonSocket"]){
      try{fs.rmSync(path.join(profileDir,name),{force:true});}catch{}
    }
    const context=await chromium.launchPersistentContext(profileDir,common);
    return {browser:null,context,persistent:true,external:false};
  }
  const browser=await chromium.launch({executablePath:exe,headless:browserHeadless,chromiumSandbox:browserSandbox,args:common.args});
  try{
    const context=await browser.newContext({acceptDownloads:true,serviceWorkers:"block"});
    return {browser,context,persistent:false,external:false};
  }catch(e){try{await browser.close();}catch{}throw e;}
}
function withDeadline(promise,ms,label){
  const limit=Math.max(500,Math.min(Number(ms)||15000,60000));
  let timer;
  return Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(label+" timed out after "+limit+"ms")),limit);})]).finally(()=>clearTimeout(timer));
}
function targetLocator(page,s){
  if(s.selector)return page.locator(s.selector).first();
  if(s.text!==undefined)return page.getByText(String(s.text),{exact:!!s.exact}).first();
  throw new Error("selector or text required");
}
let sharedOpened=null,sharedIdleTimer=null;
function cancelSharedIdleClose(){
  if(sharedIdleTimer){clearTimeout(sharedIdleTimer);sharedIdleTimer=null;}
}
async function closeSharedOpened(){
  const opened=sharedOpened;sharedOpened=null;cancelSharedIdleClose();
  if(!opened)return;
  if(opened.external)return;
  try{await opened.context?.close();}catch{}
  if(opened.browser)try{await opened.browser.close();}catch{}
}
function scheduleSharedIdleClose(){
  cancelSharedIdleClose();
  if(!sharedOpened||sharedOpened.external||idleCloseMs<=0)return;
  sharedIdleTimer=setTimeout(()=>closeSharedOpened().catch(()=>{}),idleCloseMs);
  sharedIdleTimer.unref?.();
}
async function getBrowserContext(exe){
  if(profileDir&&keepOpen){
    cancelSharedIdleClose();
    if(!sharedOpened){
      const next={...(await createBrowserContext(exe)),shared:true};
      // A persistent browser may exit or disconnect between tasks. Invalidate
      // the cached context immediately so the next job launches a fresh one.
      next.context.on("close",()=>{
        if(sharedOpened===next){sharedOpened=null;cancelSharedIdleClose();}
      });
      sharedOpened=next;
    }
    return sharedOpened;
  }
  return {...(await createBrowserContext(exe)),shared:false};
}
async function runTask(task){
  await api("/v1/tasks/"+encodeURIComponent(task.id)+"/claim",{method:"POST",body:{deviceId:workerId}});
  // Lease renewal must not block a completed browser step. In particular, a
  // slow coordinator must never turn a successful goto into a task failure.
  let leaseHeartbeatPending=false,taskTerminal=false;
  const renewLease=()=>{
    if(leaseHeartbeatPending||taskTerminal)return;
    leaseHeartbeatPending=true;
    api("/v1/tasks/"+encodeURIComponent(task.id)+"/heartbeat",{method:"POST",body:{deviceId:workerId}})
      .catch(e=>{
        const msg=String(e?.message||e);
        // A concurrent heartbeat can arrive after a successful completion.
        // A terminal lease-owner 409 is expected and must not look like a fault.
        if(taskTerminal&&msg.includes("coordinator 409"))return;
        console.warn(`[browser-worker] task=${task.id} lease heartbeat warning=${msg.slice(0,90)}`);
      })
      .finally(()=>{leaseHeartbeatPending=false;});
  };
  const leaseTimer=setInterval(renewLease,7000);
  leaseTimer.unref?.();
  let opened=null,ctx=null,page=null,activeStep="init",result={steps:[],finalUrl:null,title:null,artifacts:[],persistentProfile:!!profileDir};
  const guardRoute=async route=>{
    const raw=route.request().url();let u;try{u=new URL(raw);}catch{return route.abort("blockedbyclient");}
    if(!["http:","https:"].includes(u.protocol))return route.continue();
    try{await assertBrowserUrl(u);await route.continue();}catch{await route.abort("blockedbyclient");}
  };
  try{
    const exe=browserCandidates();if(!exe)throw new Error("Chromium/Chrome executable not found");
    opened=await getBrowserContext(exe);ctx=opened.context;
    await ctx.route("**/*",guardRoute);
    let pages=ctx.pages();page=pages[0]||await ctx.newPage();
    const action=task.action||{},steps=Array.isArray(action.steps)?action.steps:[];
    // An explicit first goto supersedes action.url; avoid visiting a large SPA twice.
    if(action.url&&steps[0]?.type!=="goto"){await assertBrowserUrl(new URL(action.url));await page.goto(action.url,{waitUntil:"domcontentloaded",timeout:action.timeoutMs||30000});}
    for(let i=0;i<steps.length;i++){
      const s=steps[i]||{},kind=s.type;let out=null;
      activeStep=String(kind||"unknown");const stepStart=Date.now();
      console.log(`[browser-worker] task=${task.id} step=${i} type=${activeStep} start`);
      if(kind==="goto"){const target=new URL(s.url);await assertBrowserUrl(target);await page.goto(target.toString(),{waitUntil:s.waitUntil||"domcontentloaded",timeout:s.timeoutMs||30000});out={url:page.url()};}
      else if(kind==="click"){await targetLocator(page,s).click({timeout:s.timeoutMs||15000});out={url:page.url()};}
      else if(kind==="type"){const loc=page.locator(s.selector).first();await loc.fill(String(s.value??""),{timeout:s.timeoutMs||15000});if(s.pressEnter)await loc.press("Enter");out={ok:true};}
      else if(kind==="search"){const loc=page.locator(s.selector||'input[type="search"],input[name="q"]').first();await loc.fill(String(s.value??s.query??""),{timeout:s.timeoutMs||15000});await loc.press("Enter");out={ok:true,url:page.url()};}
      else if(kind==="upload"){
        const loc=page.locator(s.selector).first(),paths=(Array.isArray(s.paths)?s.paths:[s.path]).filter(Boolean).map(v=>safeFile(v));
        if(!paths.length)throw new Error("upload requires path or paths");
        await loc.setInputFiles(paths,{timeout:s.timeoutMs||15000});out={ok:true,files:paths.map(p=>path.basename(p))};
      }
      else if(kind==="download"){
        const loc=targetLocator(page,s);
        const href=await loc.getAttribute("href");
        let buf,name=safeFileName(s.fileName||"download.bin");
        if(href){
          const u=new URL(href,page.url());await assertBrowserUrl(u);
          const res=await pinnedRequest(u,{method:"GET",timeoutMs:s.timeoutMs||30000,maxBytes:50*1024*1024,allowPrivateNetwork:privateDestinationAllowed(u),allowLoopback:false});
          if(!res.ok)throw new Error("download HTTP "+res.status);
          buf=Buffer.from(res.body);
          if(!s.fileName){try{name=safeFileName(new URL(res.url||u).pathname.split("/").pop()||"download.bin");}catch{}}
        }else{
          const [dl]=await Promise.all([page.waitForEvent("download",{timeout:s.timeoutMs||30000}),loc.click({timeout:s.timeoutMs||15000})]);
          name=safeFileName(s.fileName||dl.suggestedFilename());
          const stream=await dl.createReadStream();if(!stream)throw new Error("download stream unavailable");
          const chunks=[];for await(const chunk of stream)chunks.push(Buffer.from(chunk));buf=Buffer.concat(chunks);
        }
        const target=s.path?safeFile(s.path,{mustExist:false}):path.join(downloadDir,name);
        fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,buf);
        const key="browser_"+task.id+"_download_"+i+"_"+Date.now();
        const meta=await uploadBlob(key,buf,s.contentType||"application/octet-stream");
        out={fileName:path.basename(target),path:target,size:buf.length,blobKey:key,version:meta.version};result.artifacts.push(out);
      }
      else if(kind==="wait"){if(s.selector)await page.locator(s.selector).first().waitFor({state:s.state||"visible",timeout:s.timeoutMs||30000});else await page.waitForTimeout(Math.min(Number(s.ms||1000),120000));out={ok:true};}
      else if(kind==="read"){
        const max=Math.min(Number(s.maxChars||12000),50000);
        out=await withDeadline(page.evaluate(max=>{
          // innerText forces layout and can hang on a heavily updating SPA.
          // Walk text nodes without a layout flush; stop as soon as max is reached.
          const parts=[];let count=0;
          if(document.body){
            const walker=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);
            let node;
            while(count<max&&(node=walker.nextNode())){
              const parent=node.parentElement;
              if(!parent||["SCRIPT","STYLE","NOSCRIPT","TEMPLATE","SVG"].includes(parent.tagName))continue;
              const chunk=(node.nodeValue||"").trim();if(!chunk)continue;
              const text=chunk.slice(0,max-count);parts.push(text);count+=text.length+1;
            }
          }
          return {title:document.title,url:location.href,text:parts.join("\n").slice(0,max),links:[...document.querySelectorAll("a")].slice(0,100).map(a=>({text:(a.textContent||"").trim().slice(0,120),href:a.href}))};
        },max),s.timeoutMs||12000,"browser read");
      }
      else if(kind==="inspect_controls"){
        const max=Math.min(Math.max(1,Number(s.max||120)),300);
        out=await page.evaluate(max=>({
          url:location.href,
          controls:[...document.querySelectorAll('button,[role="button"],textarea,input,[contenteditable="true"],[role="menuitem"],[role="radio"],[role="option"]')].slice(0,max).map((el,i)=>({
            i,tag:el.tagName.toLowerCase(),role:el.getAttribute('role'),id:el.id||null,name:el.getAttribute('name'),type:el.getAttribute('type'),
            ariaLabel:el.getAttribute('aria-label'),ariaExpanded:el.getAttribute('aria-expanded'),dataTestId:el.getAttribute('data-testid'),
            contenteditable:el.getAttribute('contenteditable'),placeholder:el.getAttribute('placeholder'),text:(el.innerText||el.textContent||'').trim().replace(/\s+/g,' ').slice(0,180)
          }))
        }),max);
      }
      else if(kind==="screenshot"){
        const fullPage=s.fullPage!==false,timeout=Math.min(s.timeoutMs||14000,30000);
        let buf,viewportFallback=false;
        try{buf=await withDeadline(page.screenshot({fullPage,type:"png",timeout,animations:"disabled"}),timeout+1000,"browser screenshot");}
        catch(err){
          if(!fullPage||!(/timed out|Timeout/i.test(String(err?.message))))throw err;
          console.warn(`[browser-worker] task=${task.id} step=${i} full-page timeout; trying viewport`);
          buf=await withDeadline(page.screenshot({fullPage:false,type:"png",timeout:7000,animations:"disabled"}),8000,"browser viewport screenshot");
          viewportFallback=true;
        }
        let savedPath=null;
        if(s.path){savedPath=safeFile(s.path,{mustExist:false});fs.mkdirSync(path.dirname(savedPath),{recursive:true});fs.writeFileSync(savedPath,buf);}
        const key="browser_"+task.id+"_step_"+i+"_"+Date.now();
        const meta=await uploadBlob(key,buf,"image/png");out={blobKey:key,version:meta.version,size:buf.length,viewportFallback,...(savedPath?{path:savedPath}:{})};result.artifacts.push(out);
      }
      else if(kind==="html"){out={html:(await page.content()).slice(0,Number(s.maxChars||50000))};}
      else throw new Error("unsupported browser step: "+kind);
      result.steps.push({index:i,type:kind,result:out});
      console.log(`[browser-worker] task=${task.id} step=${i} type=${activeStep} done ms=${Date.now()-stepStart}`);
      // A periodic lease heartbeat runs independently of browser execution.
    }
    result.finalUrl=page.url();result.title=await page.title();
    await api("/v1/tasks/"+encodeURIComponent(task.id)+"/complete",{method:"POST",body:{deviceId:workerId,result}});
    taskTerminal=true;
  }catch(e){
    console.error(`[browser-worker] task=${task.id} failed at=${activeStep} error=${String(e?.name||"Error")} message=${String(e?.message||e).slice(0,180)}`);
    // A timed-out page must not be reused by a later job on a shared profile.
    if(page&&/timed out|Timeout/i.test(String(e?.message))){
      try{await withDeadline(page.close({runBeforeUnload:false,timeout:3500}),4000,"close stale page");}catch{}
    }
    if(opened?.shared&&/Target page, context or browser has been closed|Browser has been closed|browserContext\.route.*closed/i.test(String(e?.message||e))){
      // A stale shared CDP context cannot be reused for subsequent jobs.
      try{await closeSharedOpened();}catch{}
    }
    try{await api("/v1/tasks/"+encodeURIComponent(task.id)+"/fail",{method:"POST",body:{deviceId:workerId,error:String(e.message||e),result}});}catch{}
    taskTerminal=true;
  }finally{
    taskTerminal=true;
    clearInterval(leaseTimer);
    if(ctx)try{await ctx.unroute("**/*",guardRoute);}catch{}
    if(opened&&!opened.shared){
      if(ctx&&!opened.external)try{await ctx.close();}catch{}
      if(opened.browser)try{await opened.browser.close();}catch{}
    }else if(opened?.shared){
      scheduleSharedIdleClose();
    }
  }
}
let stopping=false,shutdownStarted=false;
async function shutdown(){
  if(shutdownStarted)return;
  shutdownStarted=true;stopping=true;cancelSharedIdleClose();
  const force=setTimeout(()=>process.exit(0),5000);
  try{
    if(sharedOpened?.external&&sharedOpened.browser){
      await sharedOpened.browser.close();
    }else if(sharedOpened?.context)await sharedOpened.context.close();
    else if(sharedOpened?.browser)await sharedOpened.browser.close();
  }catch(e){console.error("[browser-worker] shutdown",e.message||e);}
  clearTimeout(force);
  process.exit(0);
}
process.on("SIGINT",()=>{void shutdown();});process.on("SIGTERM",()=>{void shutdown();});
console.log(JSON.stringify({ok:true,workerId,coordinator:coord,browser:browserCandidates()||null,persistentProfile:profileDir||null,downloadDir,fileRoots,headless:browserHeadless,keepOpen,idleCloseMs}));
if(profileDir&&keepOpen&&idleCloseMs<=0){try{const exe=browserCandidates();if(exe)await getBrowserContext(exe);}catch(e){console.error("[browser-worker] initial browser",e.message||e);}}
while(!stopping){
  try{
    await heartbeat();
    const rows=await api("/v1/poll?device_id="+encodeURIComponent(workerId)+"&executor=browser");
    for(const t of rows){if(stopping)break;try{await runTask(t);}catch(e){console.error(e.message||e);}}
  }catch(e){console.error("[browser-worker]",e.message||e);}
  await new Promise(r=>setTimeout(r,pollMs));
}
