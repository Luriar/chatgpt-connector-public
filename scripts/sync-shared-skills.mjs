#!/usr/bin/env node
// Private copy-only, device-independent skill sync. Never executes skill contents.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
const opts=process.argv.slice(2);
const sourceArg=opts.find(a=>a.startsWith('--source='));
const root=sourceArg?path.resolve(sourceArg.slice('--source='.length)):path.dirname(fileURLToPath(import.meta.url));
const manifest=JSON.parse(fs.readFileSync(path.join(root,'manifest.json'),'utf8'));
const destArg=opts.find(a=>a.startsWith('--dest='));
const dest=destArg?path.resolve(destArg.slice('--dest='.length)):null;
const apply=opts.includes('--apply'),check=opts.includes('--check');
if(!dest||Number(apply)+Number(check)!==1){
 console.error('Usage: node scripts/sync-shared-skills.mjs --source=<private-canonical-dir> --dest=<approved-skill-root> --check|--apply');
 process.exit(64);
}
const names=new Set(),report=[];
const hash=f=>crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex').toUpperCase();
function enumerate(dir){
 const out=[];
 function visit(p,rel){
  for(const it of fs.readdirSync(p,{withFileTypes:true})){
   if(it.isSymbolicLink())throw Error('SYMLINK_DENIED '+path.join(rel,it.name));
   const q=path.join(p,it.name),name=path.join(rel,it.name);
   if(it.isDirectory())visit(q,name);
   else if(it.isFile())out.push({rel:name,sha:hash(q)});
   else throw Error('NONFILE_DENIED '+name);
  }
 }
 visit(dir,'');return out.sort((a,b)=>a.rel.localeCompare(b.rel));
}
const rootReal=fs.realpathSync(root);
for(const item of manifest.skills){
 if(!/^[a-z][a-z0-9-]{2,80}$/.test(item.name)||names.has(item.name))throw Error('BAD_NAME '+item.name);
 names.add(item.name);
 const source=path.join(root,item.name);
 if(!fs.statSync(source).isDirectory()||!fs.realpathSync(source).startsWith(rootReal+path.sep))throw Error('SOURCE_OUTSIDE');
 const files=enumerate(source);
 if(files.length!==item.fileCount||hash(path.join(source,'SKILL.md'))!==item.sha256)throw Error('MANIFEST_MISMATCH '+item.name);
 const target=path.join(dest,item.name);
 if(!fs.existsSync(target)){report.push({name:item.name,status:'missing',files:files.length});continue}
 const targetFiles=enumerate(target);
 const identical=files.length===targetFiles.length&&files.every((f,i)=>f.rel===targetFiles[i].rel&&f.sha===targetFiles[i].sha);
 report.push({name:item.name,status:identical?'match':'conflict',files:files.length});
}
if(report.some(x=>x.status==='conflict')){console.log(JSON.stringify({mode:apply?'apply':'check',dest,report},null,2));process.exit(2);}
if(apply){
 fs.mkdirSync(dest,{recursive:true});
 for(const item of report.filter(x=>x.status==='missing')){
  const stage=path.join(dest,'.skill-stage-'+item.name+'-'+process.pid+'-'+crypto.randomBytes(4).toString('hex'));
  const source=path.join(root,item.name),target=path.join(dest,item.name);
  try{
   fs.cpSync(source,stage,{recursive:true,errorOnExist:true,force:false,dereference:false});
   const expected=enumerate(source),actual=enumerate(stage);
   if(expected.length!==actual.length||!expected.every((f,i)=>f.rel===actual[i].rel&&f.sha===actual[i].sha))throw Error('COPY_VERIFY_FAILED '+item.name);
   if(fs.existsSync(target))throw Error('RACE_COLLISION '+target);
   fs.renameSync(stage,target);
   item.status='copied';
  }catch(e){console.error(e.message);process.exitCode=3;break}
  finally{if(fs.existsSync(stage))fs.rmSync(stage,{recursive:true,force:true})}
 }
 const gitInfo=path.join(path.dirname(dest),'.git','info','exclude');
 if(fs.existsSync(gitInfo)&&dest===path.join(path.dirname(dest),'skills')){
  let existing=fs.readFileSync(gitInfo,'utf8');
  for(const n of names){const line='/skills/'+n+'/';if(!existing.split(/\r?\n/).includes(line))existing+='\n'+line;}
  fs.writeFileSync(gitInfo,existing,'utf8');
 }
}
console.log(JSON.stringify({mode:apply?'apply':'check',dest,sourceDevice:manifest.sourceDevice,report},null,2));
