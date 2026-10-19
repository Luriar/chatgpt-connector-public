// Combine only simultaneously pending first-party checks. Never cache an approved host
// after resolution, so each later navigation is revalidated with fresh public DNS.
export function createCoalescedVerifier(validate,{canShare=()=>false}={}){
 const inflight=new Map();
 return async url=>{
  const u=url instanceof URL?url:new URL(url);
  if(!canShare(u))return validate(u);
  const key=u.protocol+"//"+u.host;
  if(inflight.has(key))return inflight.get(key);
  const pending=Promise.resolve().then(()=>validate(u));
  inflight.set(key,pending);
  try{return await pending}finally{if(inflight.get(key)===pending)inflight.delete(key)}
 };
}
// Route guard for a persistent Playwright context. Never respond twice to one
// route: continue() may itself throw after another handler/navigation completed.
export function createBrowserRouteGuard(assertUrl,{log=()=>{}}={}){
 return async route=>{
  let allowed=false;
  try{
   const url=new URL(route.request().url());
   if(url.protocol==='http:'||url.protocol==='https:')await assertUrl(url);
   allowed=true;
  }catch(e){
   log('blocked browser route: '+String(e?.message||e).slice(0,100));
  }
  try{
   if(allowed)await route.continue();
   else await route.abort('blockedbyclient');
  }catch(e){
   const msg=String(e?.message||e);
   if(!/route is already handled|target page.*closed|target context.*closed|page.*closed|has been closed|browser has been closed/i.test(msg))
    log('browser route completion skipped: '+msg.slice(0,100));
  }
 };
}
