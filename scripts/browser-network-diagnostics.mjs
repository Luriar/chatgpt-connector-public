// Read-only browser diagnostics. Never store request URLs/headers, cookies or response bodies.
export function networkDiagnostics(page){
 const counts={responses:0,errors4xx:0,errors5xx:0,failedRequests:0,scriptErrors:0};
 const failures=[];
 const group=url=>{
  try{const host=new URL(url).hostname;
   if(host==='chatgpt.com'||host.endsWith('.chatgpt.com'))return 'chatgpt';
   if(host==='openai.com'||host.endsWith('.openai.com'))return 'openai';
   if(host==='oaistatic.com'||host.endsWith('.oaistatic.com'))return 'static';
   return 'other';
  }catch{return 'unknown'};
 };
 const classification=message=>{
  const s=String(message||'').toLowerCase();
  if(/eai_again|name_not_resolved|dns|err_name/.test(s))return 'dns';
  if(/blockedbyclient|err_blocked/.test(s))return 'route_blocked';
  if(/timeout|timed out/.test(s))return 'timeout';
  if(/connection|err_network|err_failed|net::/.test(s))return 'connection';
  return 'other';
 };
 const add=(kind,domain,detail)=>{if(failures.length<24)failures.push({kind,domain,detail})};
 const onResponse=res=>{counts.responses++;
  const status=res.status();if(status>=400){if(status>=500)counts.errors5xx++;else counts.errors4xx++;
   add('http',group(res.url()),String(status));}
 };
 const onFailed=req=>{counts.failedRequests++;add('request_failed',group(req.url()),classification(req.failure()?.errorText))};
 const onError=err=>{counts.scriptErrors++;add('script_error','page',classification(err?.message))};
 page.on('response',onResponse);page.on('requestfailed',onFailed);page.on('pageerror',onError);
 return {snapshot:()=>({counts:{...counts},failures:[...failures]}),close:()=>{page.off('response',onResponse);page.off('requestfailed',onFailed);page.off('pageerror',onError)}};
}
