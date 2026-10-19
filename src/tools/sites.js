// ChatGPT Work parity: Sites-like interactive artifact runtime.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { z } from "zod";
import { text } from "../toolkit.js";
import { coordinatorApi } from "./coordinator.js";

function ensure(store){if(!store.data.sites||typeof store.data.sites!=="object")store.data.sites={};}
function safeRel(p){const s=String(p||"").replace(/\\/g,"/");if(!s||s.startsWith("/")||s.split("/").some(x=>x===""||x===".."))throw new Error("invalid site path: "+p);return s;}
function siteRoot(cfg,id){return path.join(cfg.stateDir,"sites",id);}
function revisionDir(cfg,id,rev){return path.join(siteRoot(cfg,id),"r"+rev);}
function fileIn(dir,rel){const s=safeRel(rel),out=path.join(dir,...s.split("/"));if(!out.startsWith(dir+path.sep))throw new Error("site path escape");return out;}
function mimeFor(rel){const e=path.extname(rel).toLowerCase();return ({".html":"text/html; charset=utf-8",".htm":"text/html; charset=utf-8",".js":"text/javascript; charset=utf-8",".mjs":"text/javascript; charset=utf-8",".css":"text/css; charset=utf-8",".json":"application/json; charset=utf-8",".svg":"image/svg+xml",".png":"image/png",".jpg":"image/jpeg",".jpeg":"image/jpeg",".gif":"image/gif",".webp":"image/webp",".ico":"image/x-icon",".txt":"text/plain; charset=utf-8",".woff":"font/woff",".woff2":"font/woff2"})[e]||"application/octet-stream";}
export function siteLookup(ctx,siteId,revision,rel){ensure(ctx.store);const site=ctx.store.data.sites[siteId];if(!site)return null;const rev=revision?site.revisions.find(r=>r.revision===revision):site.revisions.at(-1);if(!rev)return null;const safe=safeRel(rel||"index.html"),target=fileIn(rev.dir,safe);if(!fs.existsSync(target)||!fs.statSync(target).isFile())return null;return {file:target,mime:mimeFor(safe),revision:rev.revision};}
function readRevisionFiles(site,rev){
  const r=site.revisions.find(x=>x.revision===rev);if(!r)throw new Error("site revision 없음");
  const out={};for(const f of r.files){const p=fileIn(r.dir,f.path);out[f.path]=fs.readFileSync(p,"utf8");}return out;
}
function snapshot(ctx,site,files,{merge=true,deletePaths=[]}={}){
  const rev=(site.revisions.at(-1)?.revision||0)+1,dir=revisionDir(ctx.cfg,site.id,rev);fs.mkdirSync(dir,{recursive:true});
  if(merge&&site.revisions.length){const prev=site.revisions.at(-1);fs.cpSync(prev.dir,dir,{recursive:true});}
  for(const rel0 of deletePaths||[]){const rel=safeRel(rel0);try{fs.rmSync(fileIn(dir,rel),{force:true,recursive:true});}catch{}}
  for(const [rel0,content] of Object.entries(files||{})){const rel=safeRel(rel0),buf=Buffer.from(String(content));if(buf.length>2*1024*1024)throw new Error("site file too large: "+rel);const dst=fileIn(dir,rel);fs.mkdirSync(path.dirname(dst),{recursive:true});fs.writeFileSync(dst,buf);}
  if(!fs.existsSync(path.join(dir,"index.html")))throw new Error("index.html required");
  const list=[];const walk=(d,prefix="")=>{for(const e of fs.readdirSync(d,{withFileTypes:true})){const rel=prefix?prefix+"/"+e.name:e.name,abs=path.join(d,e.name);if(e.isDirectory())walk(abs,rel);else list.push({path:rel,bytes:fs.statSync(abs).size});}};walk(dir);
  const r={revision:rev,dir,files:list,createdAt:new Date().toISOString(),sha256:crypto.createHash("sha256").update(JSON.stringify(list.map(x=>[x.path,x.bytes]))).digest("hex")};
  site.revisions.push(r);site.currentRevision=rev;site.updatedAt=r.createdAt;ctx.store.save();return r;
}

export function registerSiteTools(reg,ctx){
  const {store}=ctx;ensure(store);

  reg("site_create",{
    description:"HTML/CSS/JS 파일 묶음을 interactive Site artifact로 만들고 revision 1을 생성한다.",
    inputSchema:{title:z.string(),files:z.record(z.string()),project_id:z.string().optional()}
  },async({title,files,project_id})=>{
    const id="site_"+crypto.randomBytes(6).toString("hex"),site={id,title,entry:"index.html",projectId:project_id||null,currentRevision:0,revisions:[],createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),cloud:null};
    store.data.sites[id]=site;const r=snapshot(ctx,site,files,{merge:false});return text(JSON.stringify({id,title,revision:r.revision,files:r.files},null,2));
  });

  reg("site_update",{
    description:"Site에 파일 변경을 적용해 새 immutable revision을 만든다. 기본은 이전 revision을 복사한 뒤 merge.",
    inputSchema:{id:z.string(),files:z.record(z.string()).optional(),delete_paths:z.array(z.string()).optional(),replace_all:z.boolean().optional(),title:z.string().optional()}
  },async({id,files={},delete_paths=[],replace_all=false,title})=>{
    const site=store.data.sites[id];if(!site)throw new Error("site 없음: "+id);if(title)site.title=title;
    const r=snapshot(ctx,site,files,{merge:!replace_all,deletePaths:delete_paths});return text(JSON.stringify({id,title:site.title,revision:r.revision,files:r.files},null,2));
  });

  reg("site_list",{description:"Sites와 현재 revision/cloud URL을 나열한다.",inputSchema:{project_id:z.string().optional()}},async({project_id})=>{
    let rows=Object.values(store.data.sites);if(project_id)rows=rows.filter(s=>s.projectId===project_id);
    return text(JSON.stringify(rows.map(s=>({id:s.id,title:s.title,projectId:s.projectId,currentRevision:s.currentRevision,updatedAt:s.updatedAt,cloudUrl:s.cloud?.publicUrl||null})),null,2));
  });

  reg("site_history",{description:"Site revision history를 본다.",inputSchema:{id:z.string()}},async({id})=>{
    const s=store.data.sites[id];if(!s)throw new Error("site 없음");return text(JSON.stringify(s.revisions.map(r=>({revision:r.revision,createdAt:r.createdAt,files:r.files,sha256:r.sha256})),null,2));
  });

  reg("site_preview_link",{description:"Site revision의 local/tunnel interactive preview URL을 만든다.",inputSchema:{id:z.string(),revision:z.number().int().min(1).optional()}},async({id,revision})=>{
    const s=store.data.sites[id];if(!s)throw new Error("site 없음");const rev=revision||s.currentRevision;if(!s.revisions.some(r=>r.revision===rev))throw new Error("revision 없음");
    if(!s.previewCapability){s.previewCapability=crypto.randomBytes(24).toString("base64url");store.save();}
    const route="/site/"+s.previewCapability+"/"+encodeURIComponent(id)+"/r"+rev+"/index.html",host=ctx.cfg.http.host==="0.0.0.0"?"127.0.0.1":ctx.cfg.http.host;
    let tunnel=null;try{tunnel=JSON.parse(fs.readFileSync(path.join(ctx.cfg.stateDir,"tunnel.json"),"utf8"));}catch{}
    return text(JSON.stringify({id,revision:rev,localUrl:"http://"+host+":"+ctx.cfg.http.port+route,publicUrl:tunnel?.publicBaseUrl?String(tunnel.publicBaseUrl).replace(/\/$/,"")+route:null,warning:"Site-only capability URL; MCP secret와 분리됨."},null,2));
  });

  reg("site_publish_cloud",{description:"현재 Site revision을 coordinator에 publish해 PC가 꺼져도 열리는 capability URL을 만든다.",inputSchema:{id:z.string(),revision:z.number().int().min(1).optional()}},async({id,revision})=>{
    const s=store.data.sites[id];if(!s)throw new Error("site 없음");const rev=revision||s.currentRevision,files=readRevisionFiles(s,rev);
    const out=await coordinatorApi(ctx,"/v1/sites",{method:"POST",body:{id:s.id,title:s.title,files}});
    s.cloud={publicUrl:out.publicUrl,publicPath:out.publicPath,revision:out.revision,publishedAt:new Date().toISOString()};store.save();
    return text(JSON.stringify(out,null,2));
  });

  reg("site_cloud_status",{description:"coordinator에 publish된 Sites 목록을 본다.",inputSchema:{}},async()=>text(JSON.stringify(await coordinatorApi(ctx,"/v1/sites"),null,2)));

  reg("site_delete",{description:"로컬 Site와 revision 파일을 삭제한다. cloud copy는 별도로 유지될 수 있다.",inputSchema:{id:z.string()}},async({id})=>{
    const s=store.data.sites[id];if(!s)throw new Error("site 없음");try{fs.rmSync(siteRoot(ctx.cfg,id),{recursive:true,force:true});}catch{}delete store.data.sites[id];store.save();return text("site 삭제됨: "+id);
  });
}
