import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createStore} from '../src/event-store.mjs';

function env(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'consumer-response-observed-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const store=createStore(root),event=store.publish({type:'nas.harmless.probe',ref:'01234567890123456789'});
 const evidenceFile=path.join(root,'chat-evidence.json');
 const evidence=()=>({event_id:event.id,ref:event.ref,source:'visible_chat_transcript',observed_by:'trusted_local_operator',response_text:'NAS 이벤트 확인'});
 const write=v=>fs.writeFileSync(evidenceFile,JSON.stringify(v));
 return {root,store,event,evidenceFile,evidence,write};
}

test('accepted two ChatGPT probe turns produce separate operator-observed receipts, not scientific completion',t=>{
 const {root,store,event,evidenceFile,evidence,write}=env(t);
 assert.throws(()=>store.recordObservedResponse(event.id,{evidenceFile}),/accepted delivery/);
 store.claim(event.id);store.delivery(event.id,'host_accepted');write(evidence());
 const receipt=store.recordObservedResponse(event.id,{evidenceFile});
 assert.equal(receipt.proofLevel,'operator_observed_not_host_signed');
 assert.match(receipt.evidenceSha256,/^[a-f0-9]{64}$/);
 assert.equal(receipt.duplicate,false);
 assert.equal(store.status().responseObserved,1);
 assert.equal(store.status().completed,0);
 assert.equal(createStore(root).status().responseObserved,1);
 assert.equal(createStore(root).recordObservedResponse(event.id,{evidenceFile}).duplicate,true);
});

test('evidence cannot identify other event, claim an invented response, or claim unsupported proof',t=>{
 const {store,event,evidenceFile,evidence,write}=env(t);store.claim(event.id);store.delivery(event.id,'host_accepted');
 for(const v of [{event_id:'wrong'}, {ref:'notmatching'}, {source:'NAS_only'}, {observed_by:'widget'}, {response_text:'not a model response'}]){
  write({...evidence(),...v});assert.throws(()=>store.recordObservedResponse(event.id,{evidenceFile}),/unverified or mismatched/);
 }
 assert.equal(store.status().responseObserved,0);
});

test('uncertain delivery and research event cannot be misreported as observed model response',t=>{
 const {root,store,event,evidenceFile,evidence,write}=env(t);store.claim(event.id);store.delivery(event.id,'uncertain');write(evidence());
 assert.throws(()=>store.recordObservedResponse(event.id,{evidenceFile}),/accepted delivery/);
 const research=store.publish({type:'research.review.ready',ref:'a'.repeat(20)});store.claim(research.id);store.delivery(research.id,'host_accepted');
 write({...evidence(),event_id:research.id,ref:research.ref});
 assert.throws(()=>store.recordObservedResponse(research.id,{evidenceFile}),/harmless probe/);
 assert.equal(store.status().completed,0);
});

test('operator evidence must be a real bounded file, not symlink or malformed JSON',t=>{
 const {root,store,event,evidenceFile,evidence,write}=env(t);store.claim(event.id);store.delivery(event.id,'host_accepted');
 write(evidence());const link=path.join(root,'link.json');fs.symlinkSync(evidenceFile,link);
 assert.throws(()=>store.recordObservedResponse(event.id,{evidenceFile:link}));
 fs.writeFileSync(evidenceFile,'{bad-json'.repeat(20));assert.throws(()=>store.recordObservedResponse(event.id,{evidenceFile}),/JSON/);
 assert.equal(store.status().responseObserved,0);
});

test('closed-window status remains explicitly unverified even with a response observation',t=>{
 const {store,event,evidenceFile,evidence,write}=env(t);store.claim(event.id);store.delivery(event.id,'host_accepted');write(evidence());store.recordObservedResponse(event.id,{evidenceFile});
 assert.equal(store.status().external_unattended_closed_window_verified,false);
 assert.equal(store.status().completed,0);
});

test('response observation remains counted after event expiration without renewing delivery',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'consumer-observed-expiry-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 let clock=1_790_000_000_000;const store=createStore(root,{now:()=>clock});
 const ev=store.publish({type:'nas.harmless.probe',ref:'88888888888888888888',ttlMs:60000});
 store.claim(ev.id);store.delivery(ev.id,'host_accepted');
 const evidenceFile=path.join(root,'evidence.json');
 fs.writeFileSync(evidenceFile,JSON.stringify({event_id:ev.id,ref:ev.ref,source:'visible_chat_transcript',observed_by:'trusted_local_operator',response_text:'NAS 이벤트 확인'}));
 store.recordObservedResponse(ev.id,{evidenceFile});clock+=61000;
 const status=createStore(root,{now:()=>clock}).status();
 assert.equal(status.pending,0);assert.equal(status.accepted,0);
 assert.equal(status.responseObserved,1);
 assert.equal(status.completed,0);
});
