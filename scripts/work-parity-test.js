#!/usr/bin/env node
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const tests=[
  "cloud-browser-test.js",
  "work-sync-test.js",
  "work-automations-test.js",
  "browser-broker-test.js",
  "sites-test.js",
  "work-facade-test.js",
  "work-policy-test.js"
];
let pass=0;
console.log("🍪 ChatGPT Work functional parity tests\n");
for(const file of tests){
  console.log("── "+file);
  const r=spawnSync(process.execPath,[path.join(ROOT,"scripts",file)],{cwd:ROOT,stdio:"inherit",timeout:90000,windowsHide:true});
  if(r.status===0){pass++;console.log("✅ "+file+"\n");}
  else{console.error("❌ "+file+" exit="+r.status+" signal="+(r.signal||""));process.exit(1);}
}
console.log("Work parity result: "+pass+"/"+tests.length+" passed");
