#!/usr/bin/env node
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.js";
import { getCredential } from "../src/credentials.js";

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
process.chdir(root);
const args=process.argv.slice(2);
const opt=(n,d)=>{const i=args.indexOf(n);return i>=0&&args[i+1]?args[i+1]:d;};
const coordinator=opt("--coordinator",process.env.WEBJJONKU_COORDINATOR_URL||"http://127.0.0.1:8765");
const workerId=opt("--worker-id",process.env.WEBJJONKU_BROWSER_WORKER_ID||"browser-windows");
const credential=opt("--credential","nas.coordinator.browser-windows.token");
const profileDir=path.resolve(opt("--profile-dir",path.join(root,".webjjonku","browser-windows-profile")));
const cfg=loadConfig();
const token=getCredential(cfg,credential);
if(!token)throw new Error("credential not found: "+credential);
const child=spawn(process.execPath,[
  path.join(root,"scripts","browser-worker.js"),
  "--coordinator",coordinator,
  "--worker-id",workerId,
  "--profile-dir",profileDir
],{
  cwd:root,
  env:{...process.env,
    WEBJJONKU_COORDINATOR_TOKEN:token,
    WEBJJONKU_COORDINATOR_ALLOW_PRIVATE:"1",
    WEBJJONKU_COORDINATOR_ALLOW_INSECURE_HTTP:"1"
  },
  stdio:"inherit",
  windowsHide:true
});
for(const sig of ["SIGINT","SIGTERM"])process.on(sig,()=>{try{child.kill(sig)}catch{}});
child.on("exit",(code,signal)=>process.exit(code??(signal?1:0)));
