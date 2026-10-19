import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {networkDiagnostics} from './browser-network-diagnostics.mjs';
test('browser diagnostic records only domains and error categories, not URL or tokens',()=>{
 const page=new EventEmitter(),d=networkDiagnostics(page);
 page.emit('response',{url:()=> 'https://chatgpt.com/backend-api/me?token=PRIVATE123',status:()=>403});
 page.emit('requestfailed',{url:()=> 'https://user:pass@private.example/secret/PRIVATE123',failure:()=>({errorText:'net::ERR_NAME_NOT_RESOLVED'})});
 page.emit('pageerror',new Error('Sensitive customer number 123456789'));
 const result=d.snapshot();assert.equal(result.counts.errors4xx,1);assert.equal(result.counts.failedRequests,1);assert.equal(result.counts.scriptErrors,1);
 assert.equal(result.failures[0].domain,'chatgpt');assert.equal(result.failures[1].domain,'other');
 assert.ok(!JSON.stringify(result).includes('PRIVATE123'));assert.ok(!JSON.stringify(result).includes('123456789'));
 d.close();page.emit('response',{url:()=> 'https://chatgpt.com/',status:()=>500});assert.equal(d.snapshot().counts.responses,1);
});
