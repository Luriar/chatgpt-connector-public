import test from 'node:test';
import assert from 'node:assert/strict';
import {checkedTarget,stateFromBrowserTask} from '../scripts/watch-browser-events.mjs';
const id='evt-11111111-2222-4333-a444-555555555555';
const target='https://chatgpt.com/c/12345678-1234-4123-8123-123456789012';
test('watcher permits only explicit ordinary ChatGPT conversation destination',()=>{
 assert.equal(checkedTarget(target),target);
 for(const candidate of ['http://chatgpt.com/c/12345678-1234-4123-8123-123456789012','https://chatgpt.com/work','https://chatgpt.com/','https://chatgpt.com.evil.com/c/12345678-1234-4123-8123-123456789012','https://chatgpt.com/c/12345678-1234-4123-8123-123456789012?source=external'])assert.throws(()=>checkedTarget(candidate));
});
test('watcher treats every unverified model outcome as uncertain and never assumes completion',()=>{
 const success={status:'succeeded',result:{steps:[{type:'chatgpt_event',result:{eventId:id,state:'response_visible',responseSha256:'a'.repeat(64)}}]}};
 assert.equal(stateFromBrowserTask(success,id),'response_visible');
 assert.equal(stateFromBrowserTask(success,'wrong'),'uncertain');
 for(const state of ['user_submitted','uncertain_after_click','ready_to_send'])assert.equal(stateFromBrowserTask({status:'succeeded',result:{steps:[{type:'chatgpt_event',result:{eventId:id,state}}]}},id),'uncertain');
 assert.equal(stateFromBrowserTask({status:'failed',error:'timeout'},id),'uncertain');
 assert.equal(stateFromBrowserTask({status:'succeeded',result:{steps:[]}},id),'uncertain');
});
