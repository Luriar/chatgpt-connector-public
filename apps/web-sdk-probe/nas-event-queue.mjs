import {randomUUID} from 'node:crypto';
export class EventGate {
 constructor({readEvent=()=>null,now=()=>Date.now(),log=()=>{}}={}){this.readEvent=readEvent;this.now=now;this.log=log;this.sessions=new Map();this.seen=new Map();}
 arm(){const t=this.now();for(const [k,s] of this.sessions)if(s.expiresAt<=t)this.sessions.delete(k);for(const [k,x] of this.seen)if(x<=t)this.seen.delete(k);if(this.sessions.size>=16)throw Error('session limit');const key=randomUUID();this.sessions.set(key,{startedAt:t,expiresAt:t+180000,claimed:null,state:'waiting'});return {session:key,expiresAt:t+180000,maxMessages:1};}
 call({action,session,eventId,outcome}){
 if(action==='arm')return this.arm();
 const s=this.sessions.get(session);if(!s||s.expiresAt<=this.now())throw Error('session missing or expired');
 if(action==='stop'){s.state='stopped';return {state:s.state};}
 if(action==='ack'){if(!s.claimed||s.claimed.id!==eventId||!['host_accepted','uncertain'].includes(outcome))throw Error('invalid acknowledgement');if(s.state==='claimed'){s.state=outcome;this.log({kind:'ack',id:eventId,outcome});}return {state:s.state};}
 if(action!=='poll')throw Error('unknown action');
 if(s.state!=='waiting')return {state:s.state};
 const e=this.readEvent(),t=this.now();
 if(!e||e.type!=='nas.harmless.probe'||typeof e.id!=='string'||!/^evt-[a-f0-9-]{36}$/.test(e.id)||!Number.isSafeInteger(e.createdAt)||!Number.isSafeInteger(e.expiresAt)||e.createdAt<=s.startedAt||e.createdAt>t||e.expiresAt<=t||e.expiresAt>e.createdAt+120000||Object.keys(e).sort().join(',')!=='createdAt,expiresAt,id,type')return {state:'waiting'};
 if(this.seen.has(e.id))return {state:'waiting'};
 if(this.seen.size>=128)throw Error('event limit');
 this.seen.set(e.id,e.expiresAt);s.claimed={id:e.id};s.state='claimed';this.log({kind:'claim',id:e.id,source:'nas_file'});
 return {state:'claimed',event:{id:e.id,createdAt:e.createdAt,type:e.type}};
 }
}
