// Personal Cowork parity: host credential broker.
// Windows: DPAPI CurrentUser encrypts secrets at rest. Secret values are never exposed by MCP read tools.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { z } from "zod";
import { text } from "./toolkit.js";
import { assertSafeKey } from "./security.js";

function fileFor(cfg){ return path.join(cfg.stateDir,"credentials.json"); }
function hardenSecretFile(file){
  if(process.platform!=="win32"){try{fs.chmodSync(file,0o600);return true;}catch{return false;}}
  try{
    const sid=ps("[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value","");
    const r=spawnSync("icacls",[file,"/inheritance:r","/grant:r","*"+sid+":(F)","/grant:r","*S-1-5-18:(F)"],{encoding:"utf8",timeout:10000,windowsHide:true});
    if(r.status!==0)throw new Error((r.stderr||r.stdout||"icacls failed").trim());
    return true;
  }catch{return false;}
}
function readDb(cfg){
  const f=fileFor(cfg),bak=f+".bak";if(!fs.existsSync(f))return {version:1,items:{}};
  try{return JSON.parse(fs.readFileSync(f,"utf8"));}
  catch(mainError){
    try{if(fs.existsSync(bak))return JSON.parse(fs.readFileSync(bak,"utf8"));}catch{}
    throw new Error("credentials.json 손상 및 유효한 backup 없음: "+String(mainError.message||mainError));
  }
}
function writeDb(cfg,db){
  const f=fileFor(cfg),tmp=f+".tmp",bak=f+".bak";fs.mkdirSync(path.dirname(f),{recursive:true});
  if(fs.existsSync(f)){try{JSON.parse(fs.readFileSync(f,"utf8"));fs.copyFileSync(f,bak);hardenSecretFile(bak);}catch{}}
  fs.writeFileSync(tmp,JSON.stringify(db,null,2),{mode:0o600});hardenSecretFile(tmp);fs.renameSync(tmp,f);
  if(!hardenSecretFile(f))throw new Error("credential file ACL hardening 실패");
}

function ps(script,input){
  const r=spawnSync("powershell.exe",["-NoProfile","-NonInteractive","-Command",script],{input,encoding:"utf8",timeout:15000,windowsHide:true});
  if(r.status!==0) throw new Error((r.stderr||r.stdout||"DPAPI PowerShell 실패").trim());
  return (r.stdout||"").trim();
}
const DPAPI_PS = [
"$cs=@'",
"using System;",
"using System.Runtime.InteropServices;",
"using System.ComponentModel;",
"public static class WjkDpapi {",
"  [StructLayout(LayoutKind.Sequential)] struct DATA_BLOB { public int cbData; public IntPtr pbData; }",
"  [DllImport(\"crypt32.dll\", CharSet=CharSet.Auto, SetLastError=true)] static extern bool CryptProtectData(ref DATA_BLOB pDataIn, string szDataDescr, IntPtr pOptionalEntropy, IntPtr pvReserved, IntPtr pPromptStruct, int dwFlags, out DATA_BLOB pDataOut);",
"  [DllImport(\"crypt32.dll\", CharSet=CharSet.Auto, SetLastError=true)] static extern bool CryptUnprotectData(ref DATA_BLOB pDataIn, IntPtr ppszDataDescr, IntPtr pOptionalEntropy, IntPtr pvReserved, IntPtr pPromptStruct, int dwFlags, out DATA_BLOB pDataOut);",
"  [DllImport(\"kernel32.dll\", SetLastError=true)] static extern IntPtr LocalFree(IntPtr hMem);",
"  static DATA_BLOB ToBlob(byte[] d){ DATA_BLOB b=new DATA_BLOB(); b.cbData=d.Length; b.pbData=Marshal.AllocHGlobal(d.Length); Marshal.Copy(d,0,b.pbData,d.Length); return b; }",
"  static byte[] FromBlob(DATA_BLOB b){ byte[] d=new byte[b.cbData]; Marshal.Copy(b.pbData,d,0,b.cbData); return d; }",
"  public static byte[] Protect(byte[] d){ DATA_BLOB i=ToBlob(d); DATA_BLOB o; try { if(!CryptProtectData(ref i,null,IntPtr.Zero,IntPtr.Zero,IntPtr.Zero,1,out o)) throw new Win32Exception(Marshal.GetLastWin32Error()); try{return FromBlob(o);} finally{LocalFree(o.pbData);} } finally{Marshal.FreeHGlobal(i.pbData);} }",
"  public static byte[] Unprotect(byte[] d){ DATA_BLOB i=ToBlob(d); DATA_BLOB o; try { if(!CryptUnprotectData(ref i,IntPtr.Zero,IntPtr.Zero,IntPtr.Zero,IntPtr.Zero,1,out o)) throw new Win32Exception(Marshal.GetLastWin32Error()); try{return FromBlob(o);} finally{LocalFree(o.pbData);} } finally{Marshal.FreeHGlobal(i.pbData);} }",
"}",
"'@",
"Add-Type -TypeDefinition $cs -ErrorAction SilentlyContinue"
].join("\n");
function protectWindows(value){
  const script=DPAPI_PS+"\n$s=[Console]::In.ReadToEnd();$b=[Text.Encoding]::UTF8.GetBytes($s);$e=[WjkDpapi]::Protect($b);[Convert]::ToBase64String($e)";
  return ps(script,value);
}
function unprotectWindows(cipher){
  const script=DPAPI_PS+"\n$s=[Console]::In.ReadToEnd().Trim();$e=[Convert]::FromBase64String($s);$b=[WjkDpapi]::Unprotect($e);[Text.Encoding]::UTF8.GetString($b)";
  return ps(script,cipher);
}
function localKey(cfg){
  const f=path.join(cfg.stateDir,"credential-key");
  if(!fs.existsSync(f)) fs.writeFileSync(f,crypto.randomBytes(32),{mode:0o600});
  return fs.readFileSync(f);
}
function protectFallback(cfg,value){
  const iv=crypto.randomBytes(12), key=localKey(cfg), c=crypto.createCipheriv("aes-256-gcm",key,iv);
  const enc=Buffer.concat([c.update(value,"utf8"),c.final()]); const tag=c.getAuthTag();
  return Buffer.concat([iv,tag,enc]).toString("base64");
}
function unprotectFallback(cfg,cipher){
  const b=Buffer.from(cipher,"base64"),iv=b.subarray(0,12),tag=b.subarray(12,28),enc=b.subarray(28),key=localKey(cfg);
  const d=crypto.createDecipheriv("aes-256-gcm",key,iv);d.setAuthTag(tag);return Buffer.concat([d.update(enc),d.final()]).toString("utf8");
}
function protect(cfg,value){ return process.platform==="win32"?{kind:"dpapi-current-user",cipher:protectWindows(value)}:{kind:"aes-gcm-local-user",cipher:protectFallback(cfg,value)}; }
function unprotect(cfg,item){ return item.kind==="dpapi-current-user"?unprotectWindows(item.cipher):unprotectFallback(cfg,item.cipher); }

export function putCredential(cfg,name,value,meta={}){
  name=assertSafeKey(name,"credential name");const db=readDb(cfg); const enc=protect(cfg,String(value));
  db.items[name]={...enc,meta,createdAt:db.items[name]?.createdAt||new Date().toISOString(),updatedAt:new Date().toISOString()};
  writeDb(cfg,db);
}
export function getCredential(cfg,name){
  name=assertSafeKey(name,"credential name");const db=readDb(cfg), item=db.items[name]; if(!item)return null; return unprotect(cfg,item);
}
export function removeCredential(cfg,name){name=assertSafeKey(name,"credential name");const db=readDb(cfg);const ok=!!db.items[name];delete db.items[name];writeDb(cfg,db);return ok;}
export function listCredentials(cfg){const db=readDb(cfg);return Object.entries(db.items).map(([name,v])=>({name,kind:v.kind,meta:v.meta,createdAt:v.createdAt,updatedAt:v.updatedAt}));}

export function registerCredentialTools(reg,ctx){
  reg("credential_store",{
    description:"시크릿을 host credential broker에 암호화 저장한다. Windows에서는 DPAPI CurrentUser를 사용하며 값은 이후 MCP 응답으로 다시 노출하지 않는다.",
    inputSchema:{name:z.string(),secret:z.string(),purpose:z.string().optional()}
  },async({name,secret,purpose})=>{putCredential(ctx.cfg,name,secret,{purpose:purpose||null});return text("credential 저장됨: "+name+" (값은 비공개)");});

  reg("credential_list",{description:"credential broker에 저장된 이름/메타데이터만 나열한다. 값은 반환하지 않는다.",inputSchema:{}},async()=>text(JSON.stringify(listCredentials(ctx.cfg),null,2)));

  reg("credential_remove",{description:"credential broker의 시크릿을 삭제한다.",inputSchema:{name:z.string()}},async({name})=>text(removeCredential(ctx.cfg,name)?"삭제됨: "+name:"없음"));

  reg("credential_self_test",{description:"임시 랜덤 값을 암호화→복호화해 credential broker가 정상인지 검사하고 즉시 삭제한다.",inputSchema:{}},async()=>{
    const n="__selftest_"+crypto.randomBytes(4).toString("hex"),v=crypto.randomBytes(24).toString("hex");putCredential(ctx.cfg,n,v,{temporary:true});
    const ok=getCredential(ctx.cfg,n)===v;const f=fileFor(ctx.cfg),aclHardened=hardenSecretFile(f);removeCredential(ctx.cfg,n);return text(JSON.stringify({ok,backend:process.platform==="win32"?"DPAPI CurrentUser":"local AES-GCM",aclHardened},null,2));
  });
}
