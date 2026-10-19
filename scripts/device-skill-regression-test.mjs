import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const cli=path.join(repo,'scripts','sync-shared-skills.mjs');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'device-skills-'));
const source=path.join(tmp,'canonical'),target=path.join(tmp,'project','skills'),name='korean-portfolio';
const sha=f=>crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex').toUpperCase();
const run=mode=>spawnSync(process.execPath,[cli,'--source='+source,'--dest='+target,'--'+mode],{encoding:'utf8'});
try{
 fs.mkdirSync(path.join(source,name,'references'),{recursive:true});
 fs.writeFileSync(path.join(source,name,'SKILL.md'),'---\nname: korean-portfolio\n---\nA\n');
 fs.writeFileSync(path.join(source,name,'references','tone-verified.md'),'approved');
 fs.writeFileSync(path.join(source,'manifest.json'),JSON.stringify({sourceDevice:'TEST',skills:[{name,fileCount:2,sha256:sha(path.join(source,name,'SKILL.md'))}]}));
 let r=run('check');assert.equal(r.status,0,r.stderr);assert.match(r.stdout,/"missing"/);
 r=run('apply');assert.equal(r.status,0,r.stderr);assert.match(r.stdout,/"copied"/);
 assert.equal(fs.readFileSync(path.join(target,name,'references','tone-verified.md'),'utf8'),'approved');
 r=run('apply');assert.equal(r.status,0,r.stderr);assert.match(r.stdout,/"match"/);
 fs.writeFileSync(path.join(target,name,'SKILL.md'),'local edit');
 r=run('apply');assert.equal(r.status,2,'conflict must fail');
 assert.equal(fs.readFileSync(path.join(target,name,'SKILL.md'),'utf8'),'local edit');
 console.log('PASS: missing, copy, idempotency, conflict preservation');
}finally{fs.rmSync(tmp,{recursive:true,force:true})}
