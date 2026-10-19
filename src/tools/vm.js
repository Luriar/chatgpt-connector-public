// Personal Cowork parity: dedicated WSL2 guest VM backend.
// Host files are never mounted into the guest; workspace transfer uses tar streams.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { z } from "zod";
import { resolveInRoots, assertMutationAllowed } from "../security.js";
import { text } from "../toolkit.js";

const WIN=process.platform==="win32";
function distro(cfg){return cfg.vm?.distro||"webjjonku-vm";}
function vmRoot(cfg){return path.join(cfg.stateDir,"vm",distro(cfg));}
function wsl(args,timeout=10000){return spawnSync("wsl.exe",args,{encoding:"utf8",timeout,windowsHide:true});}
function listRaw(){if(!WIN)return {status:-1,stdout:"",stderr:"not windows"};return wsl(["-l","-v"],5000);}
function exists(cfg){const r=wsl(["-l","-q"],5000);return r.status===0&&(r.stdout||"").toLowerCase().includes(distro(cfg).toLowerCase());}
function ready(cfg){if(!exists(cfg))return false;const r=wsl(["-d",distro(cfg),"--","sh","-lc","printf ready"],5000);return r.status===0&&(r.stdout||"").includes("ready");}
function harden(cfg){
  const cmd=[
    "printf '%s\\n' '[automount]' 'enabled=false' '[interop]' 'enabled=false' 'appendWindowsPath=false' '[network]' 'generateHosts=true' 'generateResolvConf=true' > /etc/wsl.conf",
    "mkdir -p /work /wjk-state",
    "chmod 700 /wjk-state"
  ].join(" && ");
  const r=wsl(["-d",distro(cfg),"-u","root","--","sh","-lc",cmd],10000);
  if(r.status!==0)throw new Error((r.stderr||r.stdout||"VM hardening failed").trim());
}
function validateArchiveListing(archive){
  const names=spawnSync("tar",["-tzf",archive],{encoding:"utf8",timeout:15000,windowsHide:true});
  if(names.status!==0)throw new Error("VM archive 목록 검사 실패: "+(names.stderr||names.stdout||"tar error").trim());
  for(const raw of (names.stdout||"").split(/\r?\n/)){
    if(!raw)continue;
    const rel=raw.replace(/\\/g,"/").replace(/^\.\//,"");
    if(!rel)continue;
    if(rel.startsWith("/")||/^[A-Za-z]:/.test(rel)||rel.split("/").some(x=>x==="..")||rel.includes("\0"))throw new Error("VM archive path escape 차단: "+raw);
  }
  const verbose=spawnSync("tar",["-tvzf",archive],{encoding:"utf8",timeout:15000,windowsHide:true});
  if(verbose.status!==0)throw new Error("VM archive type 검사 실패: "+(verbose.stderr||verbose.stdout||"tar error").trim());
  for(const line of (verbose.stdout||"").split(/\r?\n/)){
    if(!line.trim())continue;
    const type=line.trimStart()[0];
    if(type!=="-"&&type!=="d")throw new Error("VM archive 특수/링크 엔트리 차단: "+line.slice(0,200));
  }
}
function copyValidatedTree(src,dst){
  const base=path.resolve(dst)+path.sep;
  const walk=(dir,rel="")=>{
    for(const ent of fs.readdirSync(dir,{withFileTypes:true})){
      const sp=path.join(dir,ent.name),rp=rel?path.join(rel,ent.name):ent.name,dp=path.resolve(dst,rp);
      if(!dp.startsWith(base))throw new Error("VM staging path escape 차단: "+rp);
      const st=fs.lstatSync(sp);if(st.isSymbolicLink())throw new Error("VM staging symlink 차단: "+rp);
      if(st.isDirectory()){fs.mkdirSync(dp,{recursive:true});walk(sp,rp);}
      else if(st.isFile()){fs.mkdirSync(path.dirname(dp),{recursive:true});fs.copyFileSync(sp,dp);}
      else throw new Error("VM staging 특수 파일 차단: "+rp);
    }
  };
  walk(src);
}
function defaultTar(cfg){
  const root=path.resolve(path.dirname(cfg.configPath||process.cwd()));
  const candidates=[
    path.join(root,"vm-assets","alpine-minirootfs-3.22.6-x86_64.tar.gz"),
    path.join(process.cwd(),"vm-assets","alpine-minirootfs-3.22.6-x86_64.tar.gz")
  ];
  return candidates.find(fs.existsSync)||null;
}

export function registerVmTools(reg,ctx){
  reg("vm_status",{description:"개인용 Cowork 격리용 전용 WSL2 guest 상태/준비조건을 진단한다.",inputSchema:{}},async()=>{
    const lr=listRaw(),ex=WIN&&exists(ctx.cfg),ok=WIN&&ready(ctx.cfg);
    let conf=null;if(ok){const c=wsl(["-d",distro(ctx.cfg),"--","sh","-lc","cat /etc/wsl.conf 2>/dev/null || true"],5000);conf=(c.stdout||"").trim();}
    return text(JSON.stringify({
      backend:"wsl2",platform:process.platform,distro:distro(ctx.cfg),registered:ex,available:ok,
      isolation:{hostDriveAutomount:false,windowsInterop:false,workspaceTransfer:"tar-stream-copy"},
      prereqScript:"scripts/enable-vm-prereqs.ps1",
      wslList:(lr.stdout||lr.stderr||"").trim(),wslConf:conf
    },null,2));
  });

  reg("vm_prepare",{description:"전용 WSL2 guest를 import하고 host drive automount/Windows interop를 차단한다. 관리자 Windows 기능 활성화/재부팅이 선행될 수 있다.",inputSchema:{rootfs_tar:z.string().optional()}},async({rootfs_tar})=>{
    assertMutationAllowed(ctx.cfg,"VM prepare");
    if(!WIN)throw new Error("현재 VM backend는 Windows WSL2 전용");
    if(!exists(ctx.cfg)){
      const tar=rootfs_tar?resolveInRoots(ctx.cfg,rootfs_tar):defaultTar(ctx.cfg);
      if(!tar||!fs.existsSync(tar))throw new Error("Alpine rootfs tar 없음. vm-assets에 준비하거나 rootfs_tar를 지정해.");
      const root=vmRoot(ctx.cfg);fs.mkdirSync(root,{recursive:true});
      const r=wsl(["--import",distro(ctx.cfg),root,tar,"--version","2"],30000);
      if(r.status!==0)throw new Error((r.stderr||r.stdout||"WSL2 import failed").trim()+"\nWindows 가상화/VirtualMachinePlatform이 꺼져 있으면 scripts/enable-vm-prereqs.ps1을 관리자 PowerShell에서 실행 후 재부팅해야 해.");
    }
    if(!ready(ctx.cfg))throw new Error("guest 등록은 되었지만 WSL2 VM을 시작하지 못했어. Windows 가상화 기능/재부팅 상태 확인 필요.");
    harden(ctx.cfg);
    wsl(["--terminate",distro(ctx.cfg)],10000);
    const verify=wsl(["-d",distro(ctx.cfg),"--","sh","-lc","test ! -e /mnt/c && command -v cmd.exe >/dev/null 2>&1 && exit 9 || true; printf hardened"],8000);
    return text(JSON.stringify({prepared:verify.status===0,distro:distro(ctx.cfg),note:"host drive automount/interop disabled; use vm_sync_in/out"},null,2));
  });

  reg("vm_sync_in",{description:"승인된 host 폴더를 symlink/특수파일이 제거된 staging tree로 복사한 뒤 tar stream으로 전용 guest /work에 전달한다. host 드라이브를 mount하지 않는다.",inputSchema:{path:z.string().optional(),clean:z.boolean().optional()}},async({path:p,clean=true})=>{
    assertMutationAllowed(ctx.cfg,"VM sync in");if(!ready(ctx.cfg))throw new Error("전용 VM 사용 불가");
    const src=resolveInRoots(ctx.cfg,p||ctx.cfg.roots[0]),st=fs.lstatSync(src);if(st.isSymbolicLink()||!st.isDirectory())throw new Error("VM sync_in source는 실제 디렉터리여야 해");
    const transferDir=path.join(ctx.cfg.stateDir,"vm-transfer");fs.mkdirSync(transferDir,{recursive:true});
    const nonce=Date.now()+"-"+crypto.randomBytes(6).toString("hex"),stage=path.join(transferDir,nonce+"-in-stage");
    try{
      fs.mkdirSync(stage,{recursive:true});copyValidatedTree(src,stage);
      const tar=spawn("tar",["-czf","-","-C",stage,"."],{windowsHide:true});
      const prep=clean?"rm -rf /work/* /work/.[!.]* /work/..?* 2>/dev/null || true; ":"";
      const guest=spawn("wsl.exe",["-d",distro(ctx.cfg),"--","sh","-lc",prep+"mkdir -p /work; tar -xzf - -C /work"],{windowsHide:true});
      tar.stdout.pipe(guest.stdin);let err="";guest.stderr.on("data",d=>err+=d.toString());
      await new Promise((resolve,reject)=>guest.on("close",code=>code===0?resolve():reject(new Error(err||("exit "+code)))));
      return text("synced in safely: "+src+" → "+distro(ctx.cfg)+":/work");
    } finally {try{fs.rmSync(stage,{recursive:true,force:true});}catch{}}
  });

  reg("vm_sync_out",{description:"guest /work 결과를 검증된 tar archive로 staging한 뒤 승인된 host 목적지에 복사한다. path traversal/symlink/hardlink/special file은 차단한다.",inputSchema:{dest:z.string()}},async({dest})=>{
    assertMutationAllowed(ctx.cfg,"VM sync out");if(!ready(ctx.cfg))throw new Error("전용 VM 사용 불가");
    const dst=resolveInRoots(ctx.cfg,dest,{forWrite:true});fs.mkdirSync(dst,{recursive:true});
    const transferDir=path.join(ctx.cfg.stateDir,"vm-transfer");fs.mkdirSync(transferDir,{recursive:true});
    const nonce=Date.now()+"-"+Math.random().toString(16).slice(2),archive=path.join(transferDir,nonce+".tar.gz"),stage=path.join(transferDir,nonce+"-stage");
    try{
      const guest=spawn("wsl.exe",["-d",distro(ctx.cfg),"--","tar","-czf","-","-C","/work","."],{windowsHide:true});
      const out=fs.createWriteStream(archive,{flags:"wx"});guest.stdout.pipe(out);let err="";guest.stderr.on("data",d=>err+=d.toString());
      await new Promise((resolve,reject)=>{
        let guestCode=null,outDone=false;
        const finish=()=>{if(guestCode===0&&outDone)resolve();};
        guest.on("close",code=>{guestCode=code;if(code!==0)reject(new Error(err||("guest tar exit "+code)));else finish();});
        guest.on("error",reject);out.on("error",reject);out.on("finish",()=>{outDone=true;finish();});
      });
      validateArchiveListing(archive);
      fs.mkdirSync(stage,{recursive:true});
      const ex=spawnSync("tar",["-xzf",archive,"-C",stage],{encoding:"utf8",timeout:30000,windowsHide:true});
      if(ex.status!==0)throw new Error("VM staging extract 실패: "+(ex.stderr||ex.stdout||"tar error").trim());
      copyValidatedTree(stage,dst);
      return text("synced out safely: "+distro(ctx.cfg)+":/work → "+dst);
    } finally {
      try{fs.rmSync(stage,{recursive:true,force:true});}catch{}
      try{fs.rmSync(archive,{force:true});}catch{}
    }
  });

  reg("vm_exec",{description:"전용 WSL2 guest의 /work에서 명령을 실행한다. host filesystem은 직접 노출되지 않는다.",inputSchema:{command:z.string(),timeout_ms:z.number().int().min(1000).max(600000).optional()}},async({command,timeout_ms=120000})=>{
    if(!ready(ctx.cfg))throw new Error("전용 VM 사용 불가");
    return await new Promise(resolve=>{
      const p=spawn("wsl.exe",["-d",distro(ctx.cfg),"--","sh","-lc","cd /work && "+command],{windowsHide:true});
      let out="",err="",done=false;const cap=(s,d)=>(s+d.toString()).slice(-120000);
      p.stdout.on("data",d=>out=cap(out,d));p.stderr.on("data",d=>err=cap(err,d));
      const timer=setTimeout(()=>{if(done)return;done=true;try{p.kill("SIGKILL");}catch{}resolve(text("⏱ VM timeout\n"+out+"\n"+err));},timeout_ms);
      p.on("close",code=>{if(done)return;done=true;clearTimeout(timer);resolve(text("[vm exit "+code+"]\n"+out+(err?"\n--- stderr ---\n"+err:"")));});
      p.on("error",e=>{if(done)return;done=true;clearTimeout(timer);resolve(text("⛔ VM exec 실패: "+e.message));});
    });
  });

  reg("vm_destroy",{description:"전용 webjjonku WSL2 guest 등록과 local VM state를 제거한다.",inputSchema:{confirm:z.literal("DESTROY_WEBJJONKU_VM")}},async()=>{
    assertMutationAllowed(ctx.cfg,"VM destroy");if(!WIN)throw new Error("Windows 전용");
    if(exists(ctx.cfg)){const r=wsl(["--unregister",distro(ctx.cfg)],20000);if(r.status!==0)throw new Error((r.stderr||r.stdout||"unregister failed").trim());}
    try{fs.rmSync(vmRoot(ctx.cfg),{recursive:true,force:true});}catch{}
    return text("VM 제거됨: "+distro(ctx.cfg));
  });
}
