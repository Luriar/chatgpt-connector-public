import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const html=fs.readFileSync(new URL('./nas-event-probe.html',import.meta.url),'utf8');
async function mount({rejectSend=false}={}){
const els=Object.fromEntries(['status','start','stop'].map(k=>[k,{disabled:k!=='status',textContent:''}]));
const listeners=new Map(),calls=[],messages=[],timers=new Map();let seq=0,nextEvent=null;
const win={addEventListener:(k,fn)=>listeners.set(k,fn)};win.openai={sendFollowUpMessage:()=>{throw Error('unexpected fallback');}};
win.parent={postMessage:msg=>{if(msg.id===undefined)return;calls.push(msg);
let result={};if(msg.method==='ui/initialize')result={hostCapabilities:{message:{text:true}}};
if(msg.method==='tools/call'){const a=msg.params.arguments;result={structuredContent:a.action==='arm'?{session:'11111111-1111-4111-8111-111111111111',expiresAt:Date.now()+180000}:a.action==='poll'?(nextEvent?{state:'claimed',event:nextEvent}:{state:'waiting'}):{state:a.action}};}
if(msg.method==='ui/message'){messages.push(msg.params);if(rejectSend){queueMicrotask(()=>listeners.get('message')({source:win.parent,data:{jsonrpc:'2.0',id:msg.id,error:{message:'rejected'}}}));return;}}
queueMicrotask(()=>listeners.get('message')({source:win.parent,data:{jsonrpc:'2.0',id:msg.id,result}}));}};
const ctx=vm.createContext({window:win,document:{getElementById:k=>els[k]},Date,Map,Set,Boolean,String,Error,Promise,setTimeout:fn=>{const id=++seq;timers.set(id,fn);return id;},clearTimeout:id=>timers.delete(id)});
const script=html.match(/<script type="module">([\s\S]*?)<\/script>/)[1];
await vm.runInContext('(async()=>{'+script+';globalThis.testTick=()=>tick(epoch);})()',ctx);
return {els,calls,messages,ctx,setEvent:e=>nextEvent=e};
}
const event={id:'evt-11111111-1111-4111-8111-111111111111',createdAt:Date.now(),type:'nas.harmless.probe'};
test('mount and idle polls never send a chat message',async()=>{const a=await mount();assert.equal(a.messages.length,0);await a.els.start.onclick();await a.ctx.testTick();assert.equal(a.messages.length,0);assert.ok(a.calls.some(x=>x.params?.arguments?.action==='poll'));});
test('a real event causes one message and duplicate ticks do not resend',async()=>{const a=await mount();await a.els.start.onclick();a.setEvent(event);await a.ctx.testTick();await a.ctx.testTick();assert.equal(a.messages.length,1);assert.match(a.messages[0].content[0].text,/NAS_EXTERNAL_EVENT_PROBE/);assert.ok(a.calls.some(x=>x.params?.arguments?.outcome==='host_accepted'));});
test('host rejection is marked uncertain with no retry or fallback',async()=>{const a=await mount({rejectSend:true});await a.els.start.onclick();a.setEvent(event);await a.ctx.testTick();await a.ctx.testTick();assert.equal(a.messages.length,1);assert.ok(a.calls.some(x=>x.params?.arguments?.outcome==='uncertain'));});
test('stopping before event prevents any later message',async()=>{const a=await mount();await a.els.start.onclick();await a.els.stop.onclick();a.setEvent(event);await a.ctx.testTick();assert.equal(a.messages.length,0);});
