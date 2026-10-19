#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/state.js";

const TMP=fs.mkdtempSync(path.join(os.tmpdir(),"wjk-state-durability-"));
const stateDir=path.join(TMP,".webjjonku");
const cfg={stateDir,effortDefault:"medium"};
const main=path.join(stateDir,"state.json");
const backup=main+".bak";
const backup2=main+".bak2";

const assert=(cond,msg)=>{if(!cond)throw new Error(msg);};
const read=(p)=>JSON.parse(fs.readFileSync(p,"utf8"));
const note=(id)=>({id,note:id,tags:["durability"]});
const noteIds=(v)=>(v.notes||[]).map(x=>x.id);

try{
  const store=new Store(cfg);
  store.data.notes.push(note("one"));
  store.save();

  store.data.notes.push(note("two"));
  store.save();

  store.data.notes.push(note("three"));
  store.save();

  assert(noteIds(read(main)).join(",")==="one,two,three","main generation mismatch");
  assert(noteIds(read(backup)).join(",")==="one,two","backup generation mismatch");
  assert(noteIds(read(backup2)).join(",")==="one","backup2 generation mismatch");

  fs.writeFileSync(main,Buffer.alloc(fs.statSync(main).size));
  fs.writeFileSync(backup,Buffer.alloc(fs.statSync(backup).size));

  const recovered=new Store(cfg);
  assert(recovered.recoveredFromBackup===true,"double-backup recovery flag missing");
  assert(path.resolve(recovered.recoveredFromPath)===path.resolve(backup2),"did not recover from backup2");
  assert(noteIds(recovered.data).join(",")==="one","backup2 recovery data mismatch");

  recovered.data.notes.push(note("after-recovery"));
  recovered.save();

  assert(noteIds(read(main)).join(",")==="one,after-recovery","recovered main mismatch");
  assert(noteIds(read(backup)).join(",")==="one","recovered backup mismatch");

  const beforeFailure=JSON.stringify(read(main));
  const injectionStore=new Store(cfg);
  injectionStore.data.notes.push(note("failure-injection"));

  const originalRename=fs.renameSync;
  let injected=false;
  let threw=false;
  try{
    fs.renameSync=(src,dst)=>{
      if(!injected&&path.resolve(dst)===path.resolve(main)){
        injected=true;
        const err=new Error("injected main rename failure");
        err.code="EIO";
        throw err;
      }
      return originalRename(src,dst);
    };
    injectionStore.save();
  }catch{
    threw=true;
  }finally{
    fs.renameSync=originalRename;
  }

  assert(threw&&injected,"main rename failure injection did not trigger");
  assert(JSON.stringify(read(main))===beforeFailure,"main changed despite failed atomic replace");
  assert(JSON.parse(fs.readFileSync(backup,"utf8")),"backup invalid after failed atomic replace");
  const tmpResidue=fs.readdirSync(stateDir).filter(x=>x.includes(".tmp-"));
  assert(tmpResidue.length===0,"temporary state files leaked: "+tmpResidue.join(","));

  console.log(JSON.stringify({
    ok:true,
    recoveredFrom:path.basename(recovered.recoveredFromPath),
    generations:{
      main:noteIds(read(main)),
      backup:noteIds(read(backup)),
      backup2:fs.existsSync(backup2)?noteIds(read(backup2)):[]
    },
    failureInjectionPreservedMain:true
  },null,2));
}finally{
  try{fs.rmSync(TMP,{recursive:true,force:true});}catch{}
}
