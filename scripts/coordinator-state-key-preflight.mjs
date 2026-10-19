#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const args=process.argv.slice(2);
const opt=(name,def=null)=>{const i=args.indexOf(name);return i>=0&&args[i+1]?args[i+1]:def;};
const stateFile=path.resolve(String(opt("--state-file","")));
const keyFile=path.resolve(String(opt("--key-file","")));
const expectedUidRaw=opt("--expected-uid",null);
const expectedUid=expectedUidRaw===null?null:Number(expectedUidRaw);

if(!opt("--state-file")||!opt("--key-file")){
  throw new Error("usage: coordinator-state-key-preflight.mjs --state-file <state.json> --key-file <secret.key> [--expected-uid <uid>]");
}

function regular(file,label){
  const st=fs.lstatSync(file);
  if(!st.isFile()||st.isSymbolicLink())throw new Error(label+" must be a regular file");
  return st;
}
function readKey(file){
  const st=regular(file,"state key");
  const raw=Buffer.from(fs.readFileSync(file,"utf8").trim(),"base64");
  if(raw.length!==32)throw new Error("invalid 32-byte state key");
  return {raw,stat:st};
}

const key=readKey(keyFile);
const mode=key.stat.mode&0o777;
if(mode!==0o600)throw new Error("state key mode must be 0600");
if(process.platform!=="win32"&&expectedUid!==null&&key.stat.uid!==expectedUid){
  throw new Error("state key owner uid mismatch: expected "+expectedUid+", got "+key.stat.uid);
}

regular(stateFile,"state file");
const env=JSON.parse(fs.readFileSync(stateFile,"utf8"));
if(env?.format!=="wjk-state-aesgcm-v1")throw new Error("unexpected state envelope format");
const iv=Buffer.from(env.iv||"","base64");
const tag=Buffer.from(env.tag||"","base64");
const ciphertext=Buffer.from(env.ciphertext||"","base64");
if(iv.length!==12||tag.length!==16||!ciphertext.length)throw new Error("invalid state envelope");

const decipher=crypto.createDecipheriv("aes-256-gcm",key.raw,iv);
decipher.setAAD(Buffer.from("webjjonku-coordinator-state-v1"));
decipher.setAuthTag(tag);
const clear=Buffer.concat([decipher.update(ciphertext),decipher.final()]);
const state=JSON.parse(clear.toString("utf8"));
if(!state||typeof state!=="object"||Array.isArray(state))throw new Error("decrypted state is not an object");

console.log(JSON.stringify({
  ok:true,
  stateDecrypted:true,
  keyMode:"0600",
  keyUid:process.platform==="win32"?null:key.stat.uid,
  tasks:Object.keys(state.tasks||{}).length,
  blobs:Object.keys(state.blobs||{}).length,
  sites:Object.keys(state.sites||{}).length
},null,2));
