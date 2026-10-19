import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html=fs.readFileSync(new URL('../ui/event-widget.html',import.meta.url),'utf8');
const script=html.match(/<script type="module">([\s\S]*?)<\/script>/)?.[1];

test('unmounting an armed MCP widget stops its polling; backend never wakes a closed ChatGPT',async()=>{
 assert.ok(script,'MCP Apps UI script available');
 const listeners=new Map(),timeouts=new Map(),rpcCalls=[];
 const buttons={start:{disabled:true},stop:{disabled:true},status:{textContent:''}};
 let nextTimer=0;
 const later=(fn,delay=0)=>{const id=++nextTimer;timeouts.set(id,{fn,delay,cancelled:false});return id};
 const clear=id=>{const t=timeouts.get(id);if(t)t.cancelled=true};
 const parent={postMessage(request){
  rpcCalls.push(request);
  if(!request.id)return;
  let answer={};
  if(request.method==='ui/initialize')answer={hostCapabilities:{message:{text:true}}};
  if(request.method==='tools/call'){
   const {action}=request.params.arguments;
   answer={structuredContent:action==='arm'?{state:'waiting',session:'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',expiresAt:Date.now()+900000}:action==='poll'?{state:'waiting'}:{state:'stopped'}};
  }
  queueMicrotask(()=>listeners.get('message')?.({source:parent,data:{jsonrpc:'2.0',id:request.id,result:answer}}));
 }};
 const window={parent,addEventListener(name,cb){listeners.set(name,cb)},openai:undefined};
 const document={getElementById(id){return buttons[id]}};
 await vm.runInNewContext('(async()=>{'+script+'})()',{window,document,setTimeout:later,clearTimeout:clear,Date,Map,Promise,Error,Boolean,String,RegExp},{timeout:1500});
 for(let i=0;i<6;i++)await new Promise(resolve=>setImmediate(resolve));
 assert.equal(buttons.start.disabled,false,'initialization enables Start');
 await buttons.start.onclick();
 assert.ok(rpcCalls.some(x=>x.method==='tools/call'&&x.params.arguments.action==='arm'));
 assert.ok(rpcCalls.some(x=>x.method==='tools/call'&&x.params.arguments.action==='poll'));
 const before=rpcCalls.length;
 listeners.get('pagehide')?.();
 assert.equal(buttons.stop.disabled,true,'closed widget cancels active session locally');
 for(const [id,timer] of timeouts){if(!timer.cancelled&&timer.delay>1000)await timer.fn()}
 for(let i=0;i<4;i++)await new Promise(resolve=>setImmediate(resolve));
 assert.equal(rpcCalls.length,before+1,'pagehide requests one best-effort session stop');
 assert.equal(rpcCalls.at(-1)?.params?.arguments?.action,'stop');
 assert.equal(rpcCalls.filter(x=>x.method==='ui/message').length,0);
});

test('view declares closed-window unsupported rather than promising unattended wake',()=>{
 assert.match(html,/창을 닫으면 중단됩니다/);
 assert.match(html,/addEventListener\('pagehide'/);
});

test('official ui/resource-teardown stops session and acknowledges host without sending any new ChatGPT turn',async()=>{
 const listeners=new Map(),rpc=[],buttons={start:{disabled:true},stop:{disabled:true},status:{textContent:''}};
 const activeTimers=new Map();let timerId=0;
 const parent={postMessage(msg){rpc.push(msg);if(msg.id==null||!msg.method||msg.method==='ui/resource-teardown')return;
  let result={};if(msg.method==='ui/initialize')result={hostCapabilities:{message:{text:true}}};
  if(msg.method==='tools/call')result={structuredContent:msg.params.arguments.action==='arm'?{state:'waiting',session:'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',expiresAt:Date.now()+900000}:msg.params.arguments.action==='poll'?{state:'waiting'}:{state:'stopped'}};
  queueMicrotask(()=>listeners.get('message')?.({source:parent,data:{jsonrpc:'2.0',id:msg.id,result}}));
 }};
 const win={parent,addEventListener:(k,f)=>listeners.set(k,f)};
 const later=(fn,ms=0)=>{const id=++timerId;activeTimers.set(id,{fn,ms});return id};
 const clear=id=>activeTimers.delete(id);
 await vm.runInNewContext('(async()=>{'+script+'})()',{window:win,document:{getElementById:id=>buttons[id]},setTimeout:later,clearTimeout:clear,Date,Map,Promise,Error,Boolean,String,RegExp},{timeout:1200});
 for(let i=0;i<8;i++)await new Promise(resolve=>setImmediate(resolve));
 await buttons.start.onclick();
 const countBefore=rpc.length;
 listeners.get('message')?.({source:parent,data:{jsonrpc:'2.0',id:981,method:'ui/resource-teardown',params:{reason:'host replaced UI'}}});
 for(let i=0;i<8;i++)await new Promise(resolve=>setImmediate(resolve));
 assert.equal(buttons.stop.disabled,true);
 assert.equal(rpc.filter(x=>x.method==='tools/call'&&x.params.arguments.action==='stop').length,1);
 assert.ok(rpc.some(x=>x.id===981&&x.result&&x.method===undefined),'resource teardown host acknowledgement sent');
 assert.equal(rpc.filter(x=>x.method==='ui/message').length,0);
 const old=rpc.length;
 for(const entry of activeTimers.values())if(entry.ms>=5000)await entry.fn();
 assert.equal(rpc.length,old,'no new polls or turns after host teardown');
 assert.ok(rpc.length>=countBefore);
});
