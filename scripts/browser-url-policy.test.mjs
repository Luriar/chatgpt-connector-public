import test from 'node:test';import assert from 'node:assert/strict';
import {validateBrowserRoute,validateBrowserRouteWithRetry,trustedChatHost} from './browser-url-policy.mjs';
const pub1=[{address:'104.18.32.47',family:4}],pub2=[{address:'172.64.155.209',family:4}];
const resolver=async(host)=>host==='foo.local'?[{address:'192.168.1.10',family:4}]:pub1;
function alternate(){let n=0;return async(h,opts)=>{if(opts.allowPrivateNetwork!==false)throw Error('private bypass');return ++n%2?pub1:pub2}}
test('public first-party ChatGPT DNS load balancing is permitted',async()=>{assert.equal(await validateBrowserRoute('https://chatgpt.com/',{resolve:alternate()}),true);assert.equal(await validateBrowserRoute('https://cdn.oaistatic.com/x',{resolve:alternate()}),true)});
test('non-first-party DNS rotation is not permitted',async()=>await assert.rejects(()=>validateBrowserRoute('https://evil.example/',{resolve:alternate()}),/DNS changed/));
test('first-party lookalikes are not trusted',()=>{for(const h of ['fakechatgpt.com','chatgpt.com.evil.example','oaistatic.com.attacker.io','chatgpt.com-evil'])assert.equal(trustedChatHost(h),false)});
test('http scheme does not permit DNS rotation even for trusted host',async()=>await assert.rejects(()=>validateBrowserRoute('http://chatgpt.com/',{resolve:alternate()}),/DNS changed/));
test('private IP returns never trusted even if hostname is first party',async()=>await assert.rejects(()=>validateBrowserRoute('https://chatgpt.com/',{resolve:async()=>{throw Error('private/link-local destination blocked')}}),/private\/link-local/));
test('unknown URL schemes rejected',async()=>await assert.rejects(()=>validateBrowserRoute('file:///etc/passwd',{resolve:resolver}),/http\/https only/));

test('private address from unusual resolver is rejected even for trusted domain',async()=>await assert.rejects(()=>validateBrowserRoute('https://chatgpt.com/',{resolve:async()=>[{address:'192.168.10.1',family:4}]}),/private\/link-local/));

test('transient public first-party DNS error retries with complete safety validation',async()=>{
 let calls=0;const resolve=async()=>{calls++;if(calls===1){const e=Error('getaddrinfo EAI_AGAIN');e.code='EAI_AGAIN';throw e;}return pub1};
 assert.equal(await validateBrowserRouteWithRetry('https://chatgpt.com/',{resolve}),true);
 assert.equal(calls,3);
});
test('transient DNS never bypasses private network rejection',async()=>{
 let n=0;const resolve=async()=>{if(++n===1){const e=Error('getaddrinfo EAI_AGAIN');e.code='EAI_AGAIN';throw e;}return [{address:'10.0.0.1',family:4}]};
 await assert.rejects(()=>validateBrowserRouteWithRetry('https://chatgpt.com/',{resolve}),/private\/link-local/);
});
test('untrusted domain transient DNS failures are not retried',async()=>{
 let n=0;await assert.rejects(()=>validateBrowserRouteWithRetry('https://evil.example/',{resolve:async()=>{n++;const e=Error('EAI_AGAIN');e.code='EAI_AGAIN';throw e}}),/EAI_AGAIN/);assert.equal(n,1);
});
