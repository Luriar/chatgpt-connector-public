import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import JSZip from 'jszip';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const names=['consumer-event-bridge','web-sdk-probe','codex-relay-events'];
test('each exported package contains exactly a portable manifest and configured MCP definition',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'optional-plugin-zip-'));
 try{for(const name of names){
  const src=path.join(root,'plugins',name);const manifest=JSON.parse(fs.readFileSync(path.join(src,'plugin.json'),'utf8'));
  const example=fs.readFileSync(path.join(src,'mcp.example.json'),'utf8');
  const conf=example.replaceAll('example.invalid','example.test').replaceAll('REPLACE_WITH_OAUTH_CLIENT_ID','test-client');
  const local=path.join(dir,name+'.json');fs.writeFileSync(local,conf);
  const r=spawnSync(process.execPath,['scripts/package-optional-plugins.mjs',name,local],{cwd:root,encoding:'utf8',env:{...process.env,WEBJJONKU_PLUGIN_OUTPUT_DIR:dir}});
  assert.equal(r.status,0,r.stderr);const zip=await JSZip.loadAsync(fs.readFileSync(r.stdout.trim()));assert.deepEqual(Object.keys(zip.files).sort(),['mcp.json','plugin.json']);
  assert.equal(JSON.parse(await zip.file('plugin.json').async('string')).name,manifest.name);
  const mcp=JSON.parse(await zip.file('mcp.json').async('string'));assert.deepEqual(mcp,JSON.parse(conf));
  assert.ok(!manifest.author.email);assert.ok(!manifest.extensions?.['com.openai']?.apps);
 }}finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('unconfigured examples and credential-bearing URLs cannot be packaged',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'optional-plugin-negative-'));
 try{for(const name of names){const r=spawnSync(process.execPath,['scripts/package-optional-plugins.mjs',name,path.join(root,'plugins',name,'mcp.example.json')],{cwd:root,encoding:'utf8',env:{...process.env,WEBJJONKU_PLUGIN_OUTPUT_DIR:dir}});assert.notEqual(r.status,0);}
 const conf={"$schema":"https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",mcpServers:{test:{type:'streamable-http',url:'https://user:password@example.test/mcp'}}};
 const local=path.join(dir,'bad.json');fs.writeFileSync(local,JSON.stringify(conf));const r=spawnSync(process.execPath,['scripts/package-optional-plugins.mjs',names[0],local],{cwd:root,encoding:'utf8',env:{...process.env,WEBJJONKU_PLUGIN_OUTPUT_DIR:dir}});assert.notEqual(r.status,0);
 conf.mcpServers.test.url='https://example.test/mcp';conf.mcpServers.test.headers={authorization:'Bearer test-only'};fs.writeFileSync(local,JSON.stringify(conf));const withHeader=spawnSync(process.execPath,['scripts/package-optional-plugins.mjs',names[0],local],{cwd:root,encoding:'utf8',env:{...process.env,WEBJJONKU_PLUGIN_OUTPUT_DIR:dir}});assert.notEqual(withHeader.status,0);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
