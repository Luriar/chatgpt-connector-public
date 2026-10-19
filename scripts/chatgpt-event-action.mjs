import crypto from 'node:crypto';

const eventId=/^evt-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const validRef=/^(?:[0-9a-f]{20}|run-[1-9][0-9]{0,7}|probe)$/;
export function validatedChatUrl(raw){
 const u=new URL(raw);
 if(u.protocol!=='https:'||u.hostname!=='chatgpt.com'||u.username||u.password||u.search||u.hash||!/^\/c\/[0-9a-f-]{36}$/.test(u.pathname))throw Error('must target a single explicit ordinary ChatGPT /c/<uuid> conversation');
 return u.toString();
}
export function eventMessage(event){
 if(!eventId.test(event?.id||'')||!validRef.test(event?.ref||''))throw Error('invalid event id/reference');
 if(event.type==='nas.harmless.probe')return `NAS_CONSUMER_BRIDGE_PROBE ${event.id} 수신. NAS에서 보낸 무해한 테스트 이벤트입니다. "NAS 이벤트 확인"이라고만 답해. 외부 도구 실행 금지.`;
 if(event.type==='research.progress.ready')return `NAS_RESEARCH_PROGRESS_READY event=${event.id} run=${event.ref}. NAS의 연구 체크포인트가 생겼습니다. 연결된 ChatGPT Connector의 읽기 전용 경로에서 상태를 먼저 확인하세요. 출처 검증 전에는 UNPROVEN 유지. Codex, Work, 유료 API 추론 금지.`;
 if(event.type==='research.review.ready')return `NAS_RESEARCH_REVIEW_READY event=${event.id} review_id=${event.ref}. 연구 검토 대기 상태를 연결된 ChatGPT Connector로 확인하세요. 근거가 없다면 UNPROVEN으로 남기고 작업 완료를 임의로 선언하지 마세요. Codex, Work, 유료 API 추론 금지.`;
 throw Error('unsupported event type');
}
function roleTurns(){
 return [...document.querySelectorAll('[data-message-author-role]')].filter(x=>['user','assistant'].includes(x.getAttribute('data-message-author-role'))).map(x=>({role:x.getAttribute('data-message-author-role'),text:(x.innerText||x.textContent||'').trim().slice(0,5000)}));
}
export function diagnoseTurns(turns,id){
 const index=turns.findIndex(t=>t.role==='user'&&t.text.includes(id));
 if(index<0)return {state:'not_present'};
 const after=turns.slice(index+1);
 const nextUser=after.findIndex(t=>t.role==='user');
 const assistant=after.slice(0,nextUser<0?undefined:nextUser).find(t=>t.role==='assistant'&&t.text.trim());
 return {state:assistant?'response_visible':'user_submitted',assistantText:assistant?.text||''};
}
const delay=ms=>new Promise(r=>setTimeout(r,ms));
export async function executeChatgptEvent(page,action,{timeoutMs=75000,readOnly=false}={}){
 const url=validatedChatUrl(action?.chatUrl),event=action?.event,prompt=eventMessage(event);
 const max=Date.now()+Math.min(Math.max(timeoutMs,10000),120000),sha256=s=>crypto.createHash('sha256').update(s).digest('hex');
 await page.goto(url,{waitUntil:'commit',timeout:Math.min(28000,timeoutMs)});
 // Never interact with login, CAPTCHA, errors, Work, or an unexpected chat redirect.
 if(page.url().split('?')[0].split('#')[0]!==url)throw Error('conversation navigation was redirected');
 const editor=page.locator('#prompt-textarea,[data-testid="composer-text-input"],[contenteditable="true"][role="textbox"]').first();
 await editor.waitFor({state:'visible',timeout:Math.max(1000,Math.min(35000,max-Date.now()))});
 if(page.url().split('?')[0].split('#')[0]!==url)throw Error('unexpected conversation after load');
 const initial=diagnoseTurns(await page.evaluate(roleTurns),event.id);
 if(initial.state!=='not_present')return {state:initial.state,eventId:event.id,responseSha256:initial.assistantText?sha256(initial.assistantText):null,duplicateBlocked:true,chatUrl:url};
 if(readOnly)return {state:'ready_to_send',eventId:event.id,chatUrl:url};
 await editor.fill(prompt,{timeout:15000});
 const before=(await editor.innerText()).trim();
 if(!before.includes(event.id))throw Error('composer does not contain exact event id');
 const send=page.locator('button[data-testid="send-button"],button[aria-label="Send"]').first();
 await send.waitFor({state:'visible',timeout:9000});
 if(await send.isDisabled())throw Error('ChatGPT send button disabled');
 // No retries from this point: a network failure after this click is uncertain.
 await send.click({timeout:10000,noWaitAfter:true});
 let seenUser=false,observedText='',stable=0;
 while(Date.now()<max){
  const turns=await page.evaluate(roleTurns).catch(()=>[]);
  const found=diagnoseTurns(turns,event.id);
  if(found.state==='response_visible'){
   if(found.assistantText===observedText)stable++;else {observedText=found.assistantText;stable=0;}
   const generating=await page.locator('button[data-testid="stop-button"],button[aria-label="Stop generating"]').count().catch(()=>0);
   if(stable>=2&&generating===0)return {state:'response_visible',eventId:event.id,responseSha256:sha256(observedText),responseLength:observedText.length,chatUrl:url};
  } else if(found.state==='user_submitted')seenUser=true;
  await delay(1800);
 }
 return {state:seenUser?'user_submitted':'uncertain_after_click',eventId:event.id,chatUrl:url};
}
