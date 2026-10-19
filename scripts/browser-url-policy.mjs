import {isPrivateAddress} from "../src/net-safe.js";
// For first-party ChatGPT/CDN resources, two independently validated public
// DNS answers can differ legitimately (load balancing). Other origins retain
// the original exact dual-DNS equality rule to reduce rebinding exposure.
const trusted=new Set(['chatgpt.com','openai.com','oaistatic.com']);
export function trustedChatHost(host){
 const h=String(host||'').toLowerCase().replace(/\.$/,'');
 return [...trusted].some(base=>h===base||h.endsWith('.'+base));
}
export async function validateBrowserRoute(raw,{resolve,privateAllowed=()=>false}={}){
 const u=raw instanceof URL?raw:new URL(raw);
 if(!['http:','https:'].includes(u.protocol))throw Error('browser navigation allows http/https only');
 if(typeof resolve!=='function')throw Error('dns resolver required');
 const allowPrivate=privateAllowed(u);
 const one=await resolve(u.hostname,{allowPrivateNetwork:allowPrivate,allowLoopback:false});
 const two=await resolve(u.hostname,{allowPrivateNetwork:allowPrivate,allowLoopback:false});
 if(!Array.isArray(one)||!one.length||!Array.isArray(two)||!two.length)throw Error('empty browser DNS');
 // Defense-in-depth: check public-only even if a caller provides a resolver
 // whose private-address rejection differs from the default implementation.
 if(!allowPrivate){
  for(const row of [...one,...two]){
   if(typeof row?.address!=='string'||row.address.length>60)throw Error('invalid DNS address');
   if(isPrivateAddress(row.address))throw Error("private/link-local destination blocked");
  }
 }
 const fingerprint=rows=>rows.map(v=>v.family+':'+v.address).sort().join('|');
 if(fingerprint(one)!==fingerprint(two)&&!(u.protocol==='https:'&&trustedChatHost(u.hostname)&&!allowPrivate))
  throw Error('browser destination DNS changed during validation');
 return true;
}

// Retry only transient public first-party DNS failures; never relax address validation.
export async function validateBrowserRouteWithRetry(raw,options={}){
 const u=raw instanceof URL?raw:new URL(raw);
 for(let attempt=0;;attempt++){
  try{return await validateBrowserRoute(u,options)}
  catch(e){
   if(attempt>=2||u.protocol!=='https:'||!trustedChatHost(u.hostname)||!/(?:EAI_AGAIN|ETIMEOUT)/.test(String(e?.code||'')+' '+String(e?.message||'')))throw e;
   await new Promise(resolve=>setTimeout(resolve,150*(attempt+1)));
  }
 }
}
