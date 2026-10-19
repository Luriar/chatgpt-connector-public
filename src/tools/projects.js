// Personal Cowork parity: Projects + Artifacts + revisions + coordinator cross-device sync.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { z } from "zod";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { resolveInRoots } from "../security.js";
import { text, enforcePolicy } from "../toolkit.js";
import { coordinatorPutBlob, coordinatorGetBlob } from "./coordinator.js";

function ensure(store){
  if(!store.data.projects||typeof store.data.projects!=="object")store.data.projects={};
  if(!store.data.artifacts||typeof store.data.artifacts!=="object")store.data.artifacts={};
  if(store.data.activeProjectId===undefined)store.data.activeProjectId=null;
}
function hash(buf){return crypto.createHash("sha256").update(buf).digest("hex");}
function now(){return new Date().toISOString();}
function safeId(v,label="id"){const s=String(v||"");if(!/^[A-Za-z0-9._:-]{1,160}$/.test(s))throw new Error("invalid "+label);return s;}
function safeExtension(v){const s=String(v||".bin").toLowerCase();if(!/^\.[a-z0-9]{1,12}$/.test(s))throw new Error("invalid artifact extension");return s;}
function artifactDir(cfg,id){return path.join(cfg.stateDir,"artifacts",safeId(id,"artifact id"));}
function ext(p){return path.extname(p).toLowerCase();}
function projectBlobKey(id){return "project_"+id;}
function artifactBlobKey(id,rev){return "artifact_"+id+"_r"+rev;}

function snapshot(ctx,artifact,source){
  const abs=resolveInRoots(ctx.cfg,source),buf=fs.readFileSync(abs),n=(artifact.revisions?.at(-1)?.revision||0)+1,e=ext(abs)||".bin",dir=artifactDir(ctx.cfg,artifact.id);
  fs.mkdirSync(dir,{recursive:true});const dst=path.join(dir,"r"+n+e);fs.writeFileSync(dst,buf);
  const r={revision:n,sha256:hash(buf),size:buf.length,extension:e,snapshotPath:dst,sourcePath:abs,createdAt:now(),cloudKey:null,cloudVersion:null};
  artifact.revisions.push(r);artifact.updatedAt=now();ctx.store.save();return r;
}
async function officePreview(file,e){
  const zip=await JSZip.loadAsync(fs.readFileSync(file));
  const names=Object.keys(zip.files).filter(n=>e===".docx"?/^word\/document\.xml$/.test(n):/^ppt\/slides\/slide\d+\.xml$/.test(n)).sort();
  const out=[];for(const n of names){const xml=await zip.file(n).async("string");const re=e===".docx"?/<w:t[^>]*>([\s\S]*?)<\/w:t>/g:/<a:t[^>]*>([\s\S]*?)<\/a:t>/g;let m,s=[];while((m=re.exec(xml)))s.push(m[1].replace(/&amp;/g,"&").replace(/&lt;/g,"<").replace(/&gt;/g,">"));out.push({part:n,text:s.join(" ").slice(0,10000)});}return out;
}
async function previewFile(file){
  const e=ext(file);
  if([".txt",".md",".json",".csv",".js",".ts",".py",".html",".css",".yaml",".yml",".xml",".log"].includes(e))return {kind:"text",text:fs.readFileSync(file,"utf8").slice(0,30000)};
  if(e===".docx"||e===".pptx")return {kind:e.slice(1),parts:await officePreview(file,e)};
  if(e===".xlsx"){
    const wb=new ExcelJS.Workbook();await wb.xlsx.readFile(file);const ws=wb.worksheets[0];const rows=[];if(ws){for(let r=1;r<=Math.min(ws.rowCount,30);r++){const row=[];for(let c=1;c<=Math.min(ws.columnCount,15);c++)row.push(ws.getCell(r,c).value);rows.push(row);}}return {kind:"xlsx",sheet:ws?.name||null,rows};
  }
  if(e===".pdf"){
    const pdf=await getDocument({data:new Uint8Array(fs.readFileSync(file)),useSystemFonts:true}).promise;const pages=[];for(let i=1;i<=Math.min(pdf.numPages,10);i++){const p=await pdf.getPage(i),tc=await p.getTextContent();pages.push({page:i,text:tc.items.map(x=>x.str).join(" ").slice(0,10000)});}return {kind:"pdf",totalPages:pdf.numPages,pages};
  }
  const st=fs.statSync(file);return {kind:"binary",extension:e,size:st.size};
}
function publicArtifact(a){const {previewCapability,...pub}=a;return {...pub,revisions:a.revisions.map(r=>({...r,snapshotPath:undefined,sourcePath:r.sourcePath}))};}

export function registerProjectTools(reg,ctx){
  const {store}=ctx;ensure(store);
  const getProject=id=>{const p=store.data.projects[id||store.data.activeProjectId];if(!p)throw new Error("project 없음");return p;};
  const getArtifact=id=>{const a=store.data.artifacts[id];if(!a)throw new Error("artifact 없음");return a;};

  reg("project_create",{description:"프로젝트를 생성해 root/instructions/skills/tasks/artifacts를 하나의 재개 가능한 컨텍스트로 묶는다.",inputSchema:{name:z.string(),root:z.string().optional(),instructions:z.string().optional(),skills:z.array(z.string()).optional()}},async({name,root,instructions="",skills=[]})=>{
    const r=root?resolveInRoots(ctx.cfg,root):ctx.cfg.roots[0],id="proj_"+crypto.randomBytes(5).toString("hex");
    const p={id,name,root:r,instructions,skills,createdAt:now(),updatedAt:now(),cloudVersion:null};store.data.projects[id]=p;store.data.activeProjectId=id;store.save();return text(JSON.stringify(p,null,2));
  });
  reg("project_list",{description:"프로젝트 목록",inputSchema:{}},async()=>text(JSON.stringify(Object.values(store.data.projects).map(p=>({...p,active:p.id===store.data.activeProjectId})),null,2)));
  reg("project_open",{description:"프로젝트를 active context로 연다.",inputSchema:{id:z.string()}},async({id})=>{const p=getProject(id);store.data.activeProjectId=id;store.save();return text(JSON.stringify(p,null,2));});
  reg("project_update",{description:"프로젝트 instructions/skills/name/root를 갱신한다.",inputSchema:{id:z.string().optional(),name:z.string().optional(),root:z.string().optional(),instructions:z.string().optional(),skills:z.array(z.string()).optional()}},async({id,name,root,instructions,skills})=>{
    const p=getProject(id);if(name!==undefined)p.name=name;if(root!==undefined)p.root=resolveInRoots(ctx.cfg,root);if(instructions!==undefined)p.instructions=instructions;if(skills!==undefined)p.skills=skills;p.updatedAt=now();store.save();return text(JSON.stringify(p,null,2));
  });
  reg("project_status",{description:"프로젝트의 task/artifact 현황과 persistent instructions를 한 번에 본다.",inputSchema:{id:z.string().optional()}},async({id})=>{
    const p=getProject(id),tasks=Object.values(store.data.tasks||{}).filter(t=>t.projectId===p.id).map(t=>({id:t.id,title:t.title,status:t.status})),arts=Object.values(store.data.artifacts).filter(a=>a.projectId===p.id).map(a=>({id:a.id,title:a.title,revisions:a.revisions.length,updatedAt:a.updatedAt}));
    return text(JSON.stringify({project:p,tasks,artifacts:arts},null,2));
  });

  reg("artifact_register",{description:"승인 루트의 파일을 프로젝트 artifact로 등록하고 immutable revision snapshot을 만든다.",inputSchema:{project_id:z.string().optional(),path:z.string(),title:z.string().optional()}},async({project_id,path:p,title})=>{
    const project=getProject(project_id),abs=resolveInRoots(ctx.cfg,p),id="art_"+crypto.randomBytes(5).toString("hex"),a={id,projectId:project.id,title:title||path.basename(abs),createdAt:now(),updatedAt:now(),revisions:[]};store.data.artifacts[id]=a;snapshot(ctx,a,abs);return text(JSON.stringify(publicArtifact(a),null,2));
  });
  reg("artifact_update",{description:"현재 파일 상태를 artifact의 새 revision으로 snapshot한다.",inputSchema:{id:z.string(),path:z.string().optional()}},async({id,path:p})=>{
    const a=getArtifact(id),src=p?resolveInRoots(ctx.cfg,p):a.revisions.at(-1)?.sourcePath;if(!src)throw new Error("source path 필요");const r=snapshot(ctx,a,src);return text(JSON.stringify(r,null,2));
  });
  reg("artifact_list",{description:"프로젝트 artifact 목록",inputSchema:{project_id:z.string().optional()}},async({project_id})=>{
    const pid=project_id||store.data.activeProjectId;return text(JSON.stringify(Object.values(store.data.artifacts).filter(a=>!pid||a.projectId===pid).map(publicArtifact),null,2));
  });
  reg("artifact_history",{description:"artifact revision history",inputSchema:{id:z.string()}},async({id})=>text(JSON.stringify(publicArtifact(getArtifact(id)).revisions,null,2)));
  reg("artifact_preview",{description:"artifact revision을 텍스트/Office/PDF/Excel semantic preview로 렌더한다.",inputSchema:{id:z.string(),revision:z.number().int().min(1).optional()}},async({id,revision})=>{
    const a=getArtifact(id),r=revision?a.revisions.find(x=>x.revision===revision):a.revisions.at(-1);if(!r)throw new Error("revision 없음");return text(JSON.stringify({artifact:{id:a.id,title:a.title,revision:r.revision,sha256:r.sha256},preview:await previewFile(r.snapshotPath)},null,2));
  });
  reg("artifact_restore",{description:"선택 revision을 승인 경로로 복원한다. 기존 파일이 있으면 timestamp backup을 먼저 만든다.",inputSchema:{id:z.string(),revision:z.number().int().min(1).optional(),dest:z.string()}},async({id,revision,dest})=>{
    const a=getArtifact(id),r=revision?a.revisions.find(x=>x.revision===revision):a.revisions.at(-1);if(!r)throw new Error("revision 없음");const out=resolveInRoots(ctx.cfg,dest,{forWrite:true});fs.mkdirSync(path.dirname(out),{recursive:true});let backup=null;if(fs.existsSync(out)){backup=out+".bak-"+Date.now();fs.copyFileSync(out,backup);}fs.copyFileSync(r.snapshotPath,out);return text(JSON.stringify({restored:out,backup,sha256:r.sha256},null,2));
  });


  reg("artifact_preview_link",{
    description:"artifact revision의 안전한 inline preview URL을 만든다. HTTP secret 경로가 capability 역할을 하므로 URL 전체를 비밀로 취급한다.",
    inputSchema:{id:z.string(),revision:z.number().int().min(1).optional()}
  },async({id,revision})=>{
    const a=getArtifact(id),r=revision?a.revisions.find(x=>x.revision===revision):a.revisions.at(-1);if(!r)throw new Error("revision 없음");
    if(!a.previewCapability){a.previewCapability=crypto.randomBytes(24).toString("base64url");store.save();}
    const route="/artifact/"+a.previewCapability+"/"+encodeURIComponent(a.id)+"/"+r.revision;
    let tunnel=null;try{tunnel=JSON.parse(fs.readFileSync(path.join(ctx.cfg.stateDir,"tunnel.json"),"utf8"));}catch{}
    const host=ctx.cfg.http.host==="0.0.0.0"?"127.0.0.1":ctx.cfg.http.host;
    const localUrl="http://"+host+":"+ctx.cfg.http.port+route;
    const publicUrl=tunnel?.publicBaseUrl?String(tunnel.publicBaseUrl).replace(/\/$/,"")+route:null;
    return text(JSON.stringify({artifactId:a.id,revision:r.revision,localUrl,publicUrl,downloadUrl:localUrl+"?download=1",publicDownloadUrl:publicUrl?publicUrl+"?download=1":null,warning:"Artifact-only capability URL. MCP secret와 분리되어 있지만 공유 시 이 artifact preview 접근 권한이 생김."},null,2));
  });

  reg("project_sync_push",{description:"프로젝트 manifest와 모든 artifact revision snapshot을 coordinator blob store에 업로드한다. cloudVersion으로 동시 수정 충돌을 감지한다.",inputSchema:{id:z.string().optional()}},async({id})=>{
    const p=getProject(id),arts=Object.values(store.data.artifacts).filter(a=>a.projectId===p.id),manifest={project:{...p,root:null},artifacts:[],syncedAt:now()};
    for(const a of arts){const ma={id:a.id,projectId:a.projectId,title:a.title,createdAt:a.createdAt,updatedAt:a.updatedAt,revisions:[]};for(const r of a.revisions){const key=artifactBlobKey(a.id,r.revision);const meta=await coordinatorPutBlob(ctx,key,fs.readFileSync(r.snapshotPath),{contentType:"application/octet-stream",ifVersion:r.cloudVersion??undefined});r.cloudKey=key;r.cloudVersion=meta.version;ma.revisions.push({revision:r.revision,sha256:r.sha256,size:r.size,extension:r.extension,createdAt:r.createdAt,cloudKey:key,cloudVersion:meta.version});}manifest.artifacts.push(ma);}
    const m=await coordinatorPutBlob(ctx,projectBlobKey(p.id),Buffer.from(JSON.stringify(manifest)) ,{contentType:"application/json",ifVersion:p.cloudVersion??undefined});p.cloudVersion=m.version;p.updatedAt=now();store.save();return text(JSON.stringify({projectId:p.id,cloudVersion:m.version,artifacts:arts.length},null,2));
  });

  reg("project_sync_pull",{description:"coordinator에서 project/artifact snapshots를 내려받아 로컬 registry에 복원한다. 작업 root 파일은 자동 덮어쓰지 않는다.",inputSchema:{id:z.string()}},async({id})=>{
    safeId(id,"project id");
    const mb=await coordinatorGetBlob(ctx,projectBlobKey(id));if(mb.buffer.length>5*1024*1024)throw new Error("project manifest too large");
    const manifest=JSON.parse(mb.buffer.toString("utf8")),existing=store.data.projects[id];
    if(!manifest?.project||safeId(manifest.project.id,"manifest project id")!==id)throw new Error("project manifest id mismatch");
    const mas=Array.isArray(manifest.artifacts)?manifest.artifacts:[];if(mas.length>200)throw new Error("too many artifacts in manifest");
    const remoteMeta={name:String(manifest.project.name||"").slice(0,500),instructions:String(manifest.project.instructions||"").slice(0,20000),skills:Array.isArray(manifest.project.skills)?manifest.project.skills.slice(0,100).map(x=>String(x).slice(0,200)):[]};
    const p={
      ...manifest.project,id,
      name:existing?.name||("Remote project "+id),
      instructions:existing?.instructions||"",
      skills:existing?.skills||[],
      root:existing?.root||ctx.cfg.roots[0],
      cloudVersion:mb.version,updatedAt:now(),
      remoteMetadataCandidate:remoteMeta,
      remoteMetadataTrusted:!!existing?.remoteMetadataTrusted
    };store.data.projects[id]=p;
    let totalBytes=0;
    for(const ma of mas){
      const aid=safeId(ma.id,"artifact id");if(ma.projectId&&ma.projectId!==id)throw new Error("artifact project mismatch");
      const revisions=Array.isArray(ma.revisions)?ma.revisions:[];if(revisions.length>200)throw new Error("too many artifact revisions");
      const a={...ma,id:aid,projectId:id,revisions:[]};
      for(const r of revisions){
        const rev=Number(r.revision);if(!Number.isInteger(rev)||rev<1||rev>1000000000)throw new Error("invalid artifact revision");
        const extension=safeExtension(r.extension||".bin");if(!/^[a-f0-9]{64}$/i.test(String(r.sha256||"")))throw new Error("invalid artifact sha256");
        const b=await coordinatorGetBlob(ctx,r.cloudKey);totalBytes+=b.buffer.length;if(totalBytes>500*1024*1024)throw new Error("project sync size limit exceeded");
        if(Number.isFinite(Number(r.size))&&Number(r.size)!==b.buffer.length)throw new Error("artifact size mismatch");
        if(hash(b.buffer).toLowerCase()!==String(r.sha256).toLowerCase())throw new Error("artifact hash mismatch");
        const dir=artifactDir(ctx.cfg,aid),sp=path.join(dir,"r"+rev+extension);fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(sp,b.buffer);
        a.revisions.push({...r,revision:rev,extension,snapshotPath:sp,sourcePath:null,cloudVersion:b.version});
      }
      store.data.artifacts[aid]=a;
    }
    store.save();return text(JSON.stringify({project:{id:p.id,name:p.name,cloudVersion:p.cloudVersion,remoteMetadataCandidate:{name:remoteMeta.name,instructionsChars:remoteMeta.instructions.length,skills:remoteMeta.skills}},artifacts:mas.length,active:false},null,2));
  });

  reg("project_sync_accept_metadata",{
    description:"원격 project manifest의 name/instructions/skills를 로컬 프로젝트 지침으로 승격한다. 원격 control-plane 데이터이므로 기본적으로 사용자 승인이 필요하다.",
    inputSchema:{id:z.string(),confirm_name:z.string()}
  },async({id,confirm_name})=>{
    const p=getProject(id),m=p.remoteMetadataCandidate;if(!m)throw new Error("remote metadata candidate 없음");
    if(confirm_name!==m.name)throw new Error("confirm_name 불일치");
    enforcePolicy(ctx,"project.remote.metadata","project_sync_accept_metadata",{id,name:m.name,skills:m.skills},"ask");
    p.name=m.name||p.name;p.instructions=m.instructions;p.skills=m.skills;p.remoteMetadataTrusted=true;p.remoteMetadataAcceptedAt=now();delete p.remoteMetadataCandidate;p.updatedAt=now();store.save();
    return text(JSON.stringify({id:p.id,name:p.name,instructionsChars:p.instructions.length,skills:p.skills,acceptedAt:p.remoteMetadataAcceptedAt},null,2));
  });

  reg("project_resume",{description:"프로젝트를 active로 열고 instructions/skills/task/artifact 상태를 재개 브리핑으로 반환한다.",inputSchema:{id:z.string()}},async({id})=>{
    const p=getProject(id);store.data.activeProjectId=id;store.save();const tasks=Object.values(store.data.tasks||{}).filter(t=>t.projectId===id).map(t=>({id:t.id,title:t.title,status:t.status,currentStep:t.currentStep})),arts=Object.values(store.data.artifacts).filter(a=>a.projectId===id).map(a=>({id:a.id,title:a.title,latestRevision:a.revisions.at(-1)?.revision||0}));
    return text(JSON.stringify({project:p,tasks,artifacts:arts,resumeInstruction:"Apply project instructions and listed skills, then continue unfinished tasks."},null,2));
  });
}
