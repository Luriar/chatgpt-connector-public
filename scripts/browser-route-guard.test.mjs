import test from 'node:test';import assert from 'node:assert/strict';
import {createBrowserRouteGuard,createCoalescedVerifier} from './browser-route-guard.mjs';
const r=(url,fn={})=>{let continued=0,aborted=0;return {request(){return {url:()=>url}},async continue(){continued++;if(fn.continue)throw Error(fn.continue)},async abort(_code){aborted++;if(fn.abort)throw Error(fn.abort)},stats(){return {continued,aborted}}}};
test('only allowed public URLs continue',async()=>{const guard=createBrowserRouteGuard(async()=>{});const route=r('https://chatgpt.com/');await guard(route);assert.deepEqual(route.stats(),{continued:1,aborted:0})});
test('rejected private URL aborts exactly once',async()=>{const guard=createBrowserRouteGuard(async()=>{throw Error('private network rejected')});const route=r('http://127.0.0.1:1234/');await guard(route);assert.deepEqual(route.stats(),{continued:0,aborted:1})});
test('invalid URL aborts',async()=>{const guard=createBrowserRouteGuard(async()=>{});const route=r('not a URL');await guard(route);assert.deepEqual(route.stats(),{continued:0,aborted:1})});
test('already handled after continue never retries with abort or crashes',async()=>{const guard=createBrowserRouteGuard(async()=>{});const route=r('https://chatgpt.com/',{continue:'Route is already handled!'});await guard(route);assert.deepEqual(route.stats(),{continued:1,aborted:0})});
test('already handled during abort never leaks rejection',async()=>{const guard=createBrowserRouteGuard(async()=>{throw Error('deny')});const route=r('http://127.0.0.1/',{abort:'Route is already handled!'});await guard(route);assert.deepEqual(route.stats(),{continued:0,aborted:1})});
test('context closing during continue is nonfatal',async()=>{const guard=createBrowserRouteGuard(async()=>{});const route=r('https://chatgpt.com/',{continue:'Target page, context or browser has been closed'});await guard(route);assert.deepEqual(route.stats(),{continued:1,aborted:0})});
test('unexpected route completion errors logged, no unhandled rejection',async()=>{let warn='';const guard=createBrowserRouteGuard(async()=>{},{log:x=>{warn=x}});const route=r('https://chatgpt.com/',{continue:'unexpected Playwright route exception'});await guard(route);assert.match(warn,/unexpected Playwright/);assert.deepEqual(route.stats(),{continued:1,aborted:0})});
test('coalesces only concurrent first-party validations without extending trust lifetime',async()=>{
 let called=0;const validate=async()=>{called++;await new Promise(resolve=>setTimeout(resolve,20));return true};
 const shared=createCoalescedVerifier(validate,{canShare:u=>u.hostname==='chatgpt.com'&&u.protocol==='https:'});
 assert.deepEqual(await Promise.all(Array.from({length:50},()=>shared('https://chatgpt.com/c/1234'))),Array(50).fill(true));
 assert.equal(called,1,'concurrent same-host verification only once');
 await shared('https://chatgpt.com/');assert.equal(called,2,'following requests recheck, no TTL trust cache');
 await Promise.all([shared('https://other.example/'),shared('https://other.example/')]);assert.equal(called,4,'untrusted domain never coalesced');
});
test('coalesced rejection blocks every concurrent caller and does not cache denial',async()=>{
 let count=0;const check=async()=>{count++;await new Promise(resolve=>setTimeout(resolve,10));throw Error('private IP blocked')};
 const shared=createCoalescedVerifier(check,{canShare:u=>u.hostname==='chatgpt.com'});
 const results=await Promise.allSettled(Array.from({length:20},()=>shared('https://chatgpt.com/x')));
 assert.equal(count,1);assert.ok(results.every(r=>r.status==='rejected'&&/private IP blocked/.test(r.reason.message)));
 await assert.rejects(()=>shared('https://chatgpt.com/x'),/private IP blocked/);assert.equal(count,2);
});
