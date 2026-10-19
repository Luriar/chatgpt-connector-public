import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
if(Number(process.versions.node.split('.')[0])<22)throw Error('Optional plugin tests require Node.js 22 or later');
const directories=['apps/consumer-event-bridge/test','apps/web-sdk-probe'];
const tests=directories.flatMap(dir=>fs.readdirSync(path.join(root,dir)).filter(x=>x.endsWith('.test.mjs')).map(x=>path.join(dir,x)));
tests.push('scripts/browser-network-diagnostics.test.mjs','scripts/browser-route-guard.test.mjs','scripts/browser-url-policy.test.mjs','scripts/chatgpt-event-action.test.mjs','scripts/optional-plugin-packages.test.mjs');
const commands=[['--test',...tests],['apps/codex-relay-events/relay-events-gateway.mjs','--self-test'],['apps/codex-relay-events/oauth-resource-adapter.mjs','--self-test']];
for(const args of commands){const r=spawnSync(process.execPath,args,{cwd:root,stdio:'inherit',timeout:120000});if(r.error)throw r.error;if(r.status!==0)process.exit(r.status||1);}
console.log('OPTIONAL_PLUGINS_TEST_PASS: local tests only; no live host messages, provider login, model calls or deployment');
