import {createStore} from './event-store.mjs';
import path from 'node:path';
const root=process.env.CONSUMER_EVENT_DATA||path.resolve('./consumer-event-state');
const store=createStore(root);const [cmd,...args]=process.argv.slice(2);
try{
 if(cmd==='publish')console.log(JSON.stringify(store.publish({type:args[0],ref:args[1],ttlMs:args[2]?Number(args[2]):undefined})));
 else if(cmd==='response-observed')console.log(JSON.stringify(store.recordObservedResponse(args[0],{evidenceFile:args[1]})));
 else if(cmd==='complete')console.log(JSON.stringify(store.complete(args[0],{evidenceFile:args[1]})));
 else if(cmd==='status')console.log(JSON.stringify(store.status()));
 else if(cmd==='next')console.log(JSON.stringify(store.next()));
 else throw Error('Usage: node src/cli.mjs publish <type> <safe-reference> [ttl-ms] | response-observed <event-id> <trusted-visible-chat-evidence.json> | complete <event-id> <trusted-evidence-file> | status | next');
}catch(e){console.error('BRIDGE_CLI_FAILED '+String(e.message));process.exitCode=2}
