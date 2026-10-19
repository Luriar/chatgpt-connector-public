const URI="ui://webjjonku/image-delivery.html";

const HTML=String.raw`<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<style>
:root{color-scheme:light dark}*{box-sizing:border-box}body{margin:0;font:14px system-ui,-apple-system,sans-serif;background:transparent;color:inherit}
.wrap{display:grid;gap:10px;padding:10px}.frame{display:flex;justify-content:center;align-items:center;min-height:80px;max-height:70vh;overflow:auto;border:1px solid color-mix(in srgb,currentColor 16%,transparent);border-radius:12px;background:color-mix(in srgb,currentColor 3%,transparent)}
img{display:block;max-width:100%;height:auto}.bar{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.status{opacity:.75;flex:1;min-width:180px}
button,a{font:inherit;border:1px solid color-mix(in srgb,currentColor 20%,transparent);border-radius:9px;padding:8px 11px;background:transparent;color:inherit;text-decoration:none}button{cursor:pointer}.hidden{display:none}
</style>
</head>
<body><div class="wrap">
<div class="frame"><div id="loading">미리보기를 불러오는 중…</div><img id="img" class="hidden" alt="Image preview"></div>
<div class="bar"><span id="status" class="status"></span><a id="download" class="hidden">원본 저장</a><button id="upload" class="hidden">ChatGPT 파일로 저장</button></div>
</div>
<script>
const $=id=>document.getElementById(id);
let started=false,blob=null,fileName="image.png",mime="image/png",fileId=null;

function b64bytes(s){
  const bin=atob(s),a=new Uint8Array(bin.length);
  for(let i=0;i<bin.length;i++)a[i]=bin.charCodeAt(i);
  return a;
}
function getOutput(){
  return window.openai?.toolOutput||null;
}
async function fetchChunk(blobKey,offset,length){
  const r=await window.openai.callTool("cloud_browser_artifact_chunk",{blob_key:blobKey,offset,length});
  const sc=r?.structuredContent||r?.structured_content||{};
  const meta=r?._meta||{};
  let c=sc;
  if(!c?.data && meta?.imageChunk)c=meta.imageChunk;
  if(!c?.data && Array.isArray(r?.content)){
    const t=r.content.find(x=>x.type==="text")?.text;
    try{c=JSON.parse(t)}catch{}
  }
  if(!c?.data)throw new Error("chunk data missing");
  return c;
}
async function uploadOriginal(){
  if(!blob||!window.openai?.uploadFile)return;
  $("upload").disabled=true;$("status").textContent="ChatGPT에 원본 업로드 중…";
  try{
    const f=new File([blob],fileName,{type:mime});
    const out=await window.openai.uploadFile(f,{library:false});
    fileId=out?.fileId||out?.file_id||null;
    if(fileId){
      window.openai.setWidgetState?.({
        modelContent:"원본 이미지 파일이 ChatGPT에 업로드되었습니다.",
        privateContent:{fileId,fileName,mime,size:blob.size},
        imageIds:[fileId]
      });
      $("status").textContent="원본을 ChatGPT 파일로 저장함 · "+Math.round(blob.size/1024)+" KB";
      $("upload").textContent="저장됨";
    }else throw new Error("fileId missing");
  }catch(e){
    $("status").textContent="자동 업로드 실패 — 버튼을 다시 눌러 저장할 수 있어요.";
    $("upload").disabled=false;$("upload").classList.remove("hidden");
  }
}
async function start(){
  if(started)return;
  const d=getOutput(); if(!d?.blobKey)return;
  started=true;
  try{
    const total=Number(d.bytes||0); if(!total)throw new Error("invalid size");
    fileName=d.fileName||"image.png"; mime=d.contentType||"image/png";
    const parts=[]; let off=0; const chunkSize=96*1024;
    while(off<total){
      $("status").textContent="원본 수신 "+Math.round(off/total*100)+"%";
      const c=await fetchChunk(d.blobKey,off,Math.min(chunkSize,total-off));
      const a=b64bytes(c.data); parts.push(a); off+=a.byteLength;
      if(!a.byteLength)throw new Error("empty chunk");
    }
    blob=new Blob(parts,{type:mime});
    const url=URL.createObjectURL(blob);
    $("img").src=url;$("img").classList.remove("hidden");$("loading").classList.add("hidden");
    $("download").href=url;$("download").download=fileName;$("download").classList.remove("hidden");
    $("upload").classList.remove("hidden");$("upload").onclick=uploadOriginal;
    $("status").textContent="미리보기 준비됨 · 원본 "+Math.round(blob.size/1024)+" KB";
  }catch(e){
    started=false;$("status").textContent="이미지 로드 실패: "+(e?.message||e);
  }
}
window.addEventListener("openai:set_globals",()=>start(),{passive:true});
setTimeout(start,0);setTimeout(start,300);setTimeout(start,1000);
</script></body></html>`;

export function registerImageDeliveryUi(server){
  server.registerResource("webjjonku-image-delivery",URI,{
    title:"Original image delivery",
    description:"Preview a cloud-browser image in ChatGPT and save/upload the original only on explicit user action.",
    mimeType:"text/html;profile=mcp-app"
  },async()=>({contents:[{
    uri:URI,
    mimeType:"text/html;profile=mcp-app",
    text:HTML,
    _meta:{
      "openai/ui":{availableDisplayModes:["inline","fullscreen"]},
      "openai/widgetDescription":"이미지를 미리보기로 표시하고, 원본 저장 또는 ChatGPT 파일 업로드는 사용자가 버튼을 눌렀을 때만 수행합니다."
    }
  }]}));
}

export const IMAGE_DELIVERY_URI=URI;
