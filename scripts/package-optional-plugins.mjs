#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import JSZip from 'jszip';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const allowed=new Set(['consumer-event-bridge','web-sdk-probe','codex-relay-events']);
const [name,configPath]=process.argv.slice(2);
if(!allowed.has(name)||!configPath)throw Error('Usage: node scripts/package-optional-plugins.mjs <plugin-name> <local-mcp-config.json>');
const manifest=JSON.parse(fs.readFileSync(path.join(root,'plugins',name,'plugin.json'),'utf8'));
const mcp=JSON.parse(fs.readFileSync(path.resolve(configPath),'utf8'));
if(mcp.$schema!=='https://agent-plugins.org/schemas/1.0.0/mcp.schema.json'||!mcp.mcpServers||!Object.keys(mcp.mcpServers).length)throw Error('Invalid portable MCP configuration');
if(/REPLACE_WITH_|example\.invalid|your-tenant/i.test(JSON.stringify(mcp)))throw Error('Replace all deployment placeholders before packaging');
function rejectCredentials(value){if(!value||typeof value!=='object')return;for(const [key,item]of Object.entries(value)){if(/^(authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|client[-_]?secret|password|headers)$/i.test(key))throw Error('Do not package credentials or authentication headers');rejectCredentials(item);}}
rejectCredentials(mcp);
for(const server of Object.values(mcp.mcpServers)){
 const url=new URL(server.url);
 if(server.type!=='streamable-http'||url.protocol!=='https:'||url.username||url.password||url.hash)throw Error('Use your verified HTTPS MCP endpoint');
}
const zip=new JSZip();zip.file('plugin.json',JSON.stringify(manifest,null,2)+'\n');zip.file('mcp.json',JSON.stringify(mcp,null,2)+'\n');
const out=path.join(process.env.WEBJJONKU_PLUGIN_OUTPUT_DIR||path.join(root,'dist'),manifest.name+'-'+manifest.version+'.zip');fs.mkdirSync(path.dirname(out),{recursive:true});
fs.writeFileSync(out,await zip.generateAsync({type:'nodebuffer',compression:'DEFLATE'}),{mode:0o600});
console.log(out);console.warn('Configured plugin packages can contain private connection URLs. Keep generated ZIPs private.');
