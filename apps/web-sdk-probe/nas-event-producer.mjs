import fs from 'node:fs';
import {randomUUID} from 'node:crypto';
const once=process.argv.includes('--once'),target=new URL('./nas-event.json',import.meta.url);
async function emit(){const createdAt=Date.now(),id='evt-'+randomUUID(),event={id,type:'nas.harmless.probe',createdAt,expiresAt:createdAt+90000};const tmp=new URL('./nas-event.'+randomUUID()+'.tmp',import.meta.url);fs.writeFileSync(tmp,JSON.stringify(event),{flag:'wx',mode:0o644});fs.renameSync(tmp,target);console.log(JSON.stringify({at:new Date(createdAt).toISOString(),kind:'emitted',id,source:'nas_file'}));}
if(once)await emit();else{console.log('NAS harmless event producer: maximum 15 events / 5 minutes, no model or chat calls');for(let i=0;i<15;i++){await new Promise(r=>setTimeout(r,20000));await emit();}}
