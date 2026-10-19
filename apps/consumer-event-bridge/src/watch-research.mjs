// NAS-only deterministic source ingestion. No inference, browser, credential or output scraping.
import fs from 'node:fs';
import path from 'node:path';
import {createStore} from './event-store.mjs';
const store=createStore(process.env.CONSUMER_EVENT_DATA||path.resolve('./consumer-event-state'));
const source=process.env.CONSUMER_RESEARCH_ROOT;if(!source)throw Error('CONSUMER_RESEARCH_ROOT required');
function read(file){try{const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);try{const st=fs.fstatSync(fd);if(st.size>2e6||!st.isFile())return null;return JSON.parse(fs.readFileSync(fd,'utf8'))}finally{fs.closeSync(fd)}}catch{return null}}
function scan(){let added=0;const bridge=path.join(source,'automation/chat_turn_bridge'),jobs=path.join(bridge,'jobs'),reviews=path.join(bridge,'reviews');for(const name of fs.readdirSync(jobs).filter(n=>/^[a-f0-9]{20}\.json$/.test(n)).sort().slice(0,250)){
 if(fs.existsSync(path.join(reviews,name)))continue;const doc=read(path.join(jobs,name));if(!doc||doc.job_id!==name.slice(0,-5)||doc.goal_id!=='g547ca4')continue;
 if(!store.publish({type:'research.review.ready',ref:doc.job_id}).duplicate)added++;
 }
 const latest=read(path.join(source,'automation/research_v2/latest.json'));
 if(latest?.goal_id==='g547ca4'&&Number.isSafeInteger(latest.run_number)&&latest.run_number>0&&(latest.new_candidate_dois?.length||latest.offline_falsification?.ran)){
 if(!store.publish({type:'research.progress.ready',ref:'run-'+latest.run_number}).duplicate)added++;
 }
 return {added,...store.status()};}
const every=Number(process.env.CONSUMER_RESEARCH_POLL_MS||60000);if(!Number.isSafeInteger(every)||every<30000||every>3600000)throw Error('unsafe polling interval');
console.log(JSON.stringify({event:'watch_start',mode:'deterministic_only',intervalMs:every}));do{try{const res=scan();if(res.added)console.log(JSON.stringify({event:'events_queued',...res}))}catch(e){console.error('WATCH_FAILED '+String(e.message).slice(0,140))}if(process.argv.includes('--once'))break;await new Promise(resolve=>setTimeout(resolve,every))}while(true);
