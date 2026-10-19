// V2 document-native tools for xlsx/docx/pptx/pdf
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { resolveInRoots } from "../security.js";
import { text } from "../toolkit.js";

function extOf(p){return path.extname(p).toLowerCase();}
function atomicWriteBuffer(out,buf){
  fs.mkdirSync(path.dirname(out),{recursive:true});
  const tmp=out+".wjk-tmp-"+process.pid+"-"+Date.now();
  fs.writeFileSync(tmp,buf);
  try{fs.renameSync(tmp,out);}
  catch(e){try{fs.copyFileSync(tmp,out);fs.rmSync(tmp,{force:true});}catch{try{fs.rmSync(tmp,{force:true});}catch{}throw e;}}
}
function assertInputSize(abs,max=200*1024*1024){const st=fs.statSync(abs);if(st.size>max)throw new Error("document too large");}
function assertZipBudget(zip,maxEntries=10000,maxUncompressed=300*1024*1024){
  const entries=Object.values(zip.files);if(entries.length>maxEntries)throw new Error("Office ZIP has too many entries");
  let total=0;for(const e of entries){const n=Number(e?._data?.uncompressedSize||0);if(Number.isFinite(n)){total+=n;if(total>maxUncompressed)throw new Error("Office ZIP expanded size limit exceeded");}}
}
function xmlDecode(s){return s.replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/&amp;/g,"&").replace(/&quot;/g,'"').replace(/&apos;/g,"'");}
function xmlEncode(s){return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&apos;");}

async function officeZipText(abs) {
  assertInputSize(abs);const zip = await JSZip.loadAsync(fs.readFileSync(abs));assertZipBudget(zip);
  const ext=extOf(abs);
  const names = Object.keys(zip.files).filter((n)=>{
    if(ext===".docx") return /^word\/(document|header\d*|footer\d*)\.xml$/.test(n);
    if(ext===".pptx") return /^ppt\/slides\/slide\d+\.xml$/.test(n);
    return false;
  }).sort();
  const out=[];
  for(const n of names){
    const xml=await zip.file(n).async("string");
    const re=ext===".docx"?/<w:t[^>]*>([\s\S]*?)<\/w:t>/g:/<a:t[^>]*>([\s\S]*?)<\/a:t>/g;
    const parts=[]; let m; while((m=re.exec(xml))) parts.push(xmlDecode(m[1]));
    out.push({part:n,text:parts.join(" ")});
  }
  return out;
}

async function replaceOfficeText(abs,outAbs,find,replacement,replaceAll){
  assertInputSize(abs);const zip=await JSZip.loadAsync(fs.readFileSync(abs));assertZipBudget(zip); const ext=extOf(abs);
  let count=0;
  for(const n of Object.keys(zip.files)){
    const relevant=ext===".docx"?/^word\/(document|header\d*|footer\d*)\.xml$/.test(n):/^ppt\/slides\/slide\d+\.xml$/.test(n);
    if(!relevant) continue;
    let xml=await zip.file(n).async("string");
    const encodedFind=xmlEncode(find), encodedRepl=xmlEncode(replacement);
    const hits=xml.split(encodedFind).length-1;
    if(hits){
      if(replaceAll){xml=xml.split(encodedFind).join(encodedRepl);count+=hits;}
      else if(count===0){xml=xml.replace(encodedFind,encodedRepl);count++;}
      zip.file(n,xml);
      if(!replaceAll && count) break;
    }
  }
  if(!count) throw new Error("치환할 텍스트를 찾지 못했어. Office XML에서 텍스트가 여러 run으로 분리된 경우 전체 문구 치환이 어려울 수 있어.");
  atomicWriteBuffer(outAbs,await zip.generateAsync({type:"nodebuffer"}));
  return count;
}


function replaceBlockRuns(block,prefix,find,replacement,replaceAll){
  const re=new RegExp("<"+prefix+":t([^>]*)>([\\s\\S]*?)<\\/"+prefix+":t>","g");
  const texts=[];let m;while((m=re.exec(block)))texts.push(xmlDecode(m[2]));
  if(!texts.length)return {block,count:0};
  const combined=texts.join("");const hits=combined.split(find).length-1;if(!hits)return {block,count:0};
  const count=replaceAll?hits:1,newCombined=replaceAll?combined.split(find).join(replacement):combined.replace(find,replacement);
  const next=[];let cursor=0;for(let i=0;i<texts.length;i++){if(i===texts.length-1)next.push(newCombined.slice(cursor));else{next.push(newCombined.slice(cursor,cursor+texts[i].length));cursor+=texts[i].length;}}
  let idx=0;const out=block.replace(re,(full,attrs)=>"<"+prefix+":t"+attrs+">"+xmlEncode(next[idx++]||"")+"</"+prefix+":t>");
  return {block:out,count};
}
async function replaceOfficeTextSemantic(abs,outAbs,find,replacement,replaceAll){
  assertInputSize(abs);const zip=await JSZip.loadAsync(fs.readFileSync(abs));assertZipBudget(zip);const e=extOf(abs);let total=0,done=false;
  for(const n of Object.keys(zip.files)){
    const relevant=e===".docx"?/^word\/(document|header\d*|footer\d*)\.xml$/.test(n):/^ppt\/slides\/slide\d+\.xml$/.test(n);if(!relevant)continue;
    let xml=await zip.file(n).async("string");const para=e===".docx"?/<w:p\b[\s\S]*?<\/w:p>/g:/<a:p\b[\s\S]*?<\/a:p>/g;const prefix=e===".docx"?"w":"a";
    xml=xml.replace(para,(block)=>{if(done&&!replaceAll)return block;const r=replaceBlockRuns(block,prefix,find,replacement,replaceAll);if(r.count){total+=r.count;if(!replaceAll)done=true;}return r.block;});
    zip.file(n,xml);if(done&&!replaceAll)break;
  }
  if(!total)throw new Error("semantic 치환 텍스트를 찾지 못했어");
  atomicWriteBuffer(outAbs,await zip.generateAsync({type:"nodebuffer"}));return total;
}

export function registerDocumentTools(reg,ctx){
  reg("document_info",{description:"xlsx/docx/pptx/pdf 파일 형식과 기본 정보를 확인한다.",inputSchema:{path:z.string()}},async({path:p})=>{
    const abs=resolveInRoots(ctx.cfg,p); const st=fs.statSync(abs); return text(JSON.stringify({path:abs,extension:extOf(abs),bytes:st.size,modified:st.mtime.toISOString()},null,2));
  });

  reg("excel_read_range",{
    description:"XLSX 워크북의 시트와 셀 범위를 읽는다. formulas=true면 수식도 함께 반환.",
    inputSchema:{path:z.string(),sheet:z.string().optional(),range:z.string().optional(),formulas:z.boolean().optional()}
  },async({path:p,sheet,range="A1:Z50",formulas=false})=>{
    const abs=resolveInRoots(ctx.cfg,p); const wb=new ExcelJS.Workbook(); await wb.xlsx.readFile(abs);
    const ws=sheet?wb.getWorksheet(sheet):wb.worksheets[0]; if(!ws) throw new Error("시트 없음");
    const [a,b]=range.split(":"); const start=ws.getCell(a); const end=ws.getCell(b||a); const rows=[];
    for(let r=start.row;r<=end.row;r++){const row=[];for(let c=start.col;c<=end.col;c++){const cell=ws.getCell(r,c);row.push(formulas&&cell.formula?{value:cell.value,result:cell.result,formula:cell.formula}:cell.value);}rows.push(row);}
    return text(JSON.stringify({sheet:ws.name,range,rows},null,2));
  });

  reg("excel_write_range",{
    description:"XLSX 워크북의 시작 셀부터 2차원 values를 쓴다. output을 생략하면 원본을 수정한다.",
    inputSchema:{path:z.string(),sheet:z.string().optional(),start:z.string(),values:z.array(z.array(z.any())),output:z.string().optional()}
  },async({path:p,sheet,start,values,output})=>{
    const abs=resolveInRoots(ctx.cfg,p,{forWrite:!output}); const out=resolveInRoots(ctx.cfg,output||p,{forWrite:true});
    assertInputSize(abs);const wb=new ExcelJS.Workbook(); await wb.xlsx.readFile(abs); const ws=sheet?wb.getWorksheet(sheet):wb.worksheets[0]; if(!ws)throw new Error("시트 없음");
    const s=ws.getCell(start); values.forEach((row,ri)=>row.forEach((v,ci)=>{ws.getCell(s.row+ri,s.col+ci).value=v;}));
    atomicWriteBuffer(out,Buffer.from(await wb.xlsx.writeBuffer())); return text(`저장됨: ${out}`);
  });

  reg("office_extract_text",{
    description:"DOCX 또는 PPTX의 텍스트를 문서/슬라이드 단위로 추출한다.",
    inputSchema:{path:z.string()}
  },async({path:p})=>{
    const abs=resolveInRoots(ctx.cfg,p); const ext=extOf(abs); if(![".docx",".pptx"].includes(ext))throw new Error("docx/pptx만 지원");
    return text(JSON.stringify(await officeZipText(abs),null,2));
  });

  reg("office_replace_text",{
    description:"DOCX/PPTX에서 정확히 일치하는 텍스트를 치환해 새 파일 또는 원본에 저장한다. 간단한 run 단위 텍스트에 적합.",
    inputSchema:{path:z.string(),find:z.string(),replace:z.string(),output:z.string().optional(),replace_all:z.boolean().optional()}
  },async({path:p,find,replace,output,replace_all=true})=>{
    const abs=resolveInRoots(ctx.cfg,p); const out=resolveInRoots(ctx.cfg,output||p,{forWrite:true}); const n=await replaceOfficeText(abs,out,find,replace,replace_all); return text(`${n}곳 치환 → ${out}`);
  });


  reg("office_replace_text_semantic",{
    description:"DOCX/PPTX에서 여러 XML text run으로 분리된 문장도 paragraph 단위로 결합해 찾아 치환한다. 교체 텍스트는 기존 run 경계에 재분배되어 구조를 최대한 보존한다.",
    inputSchema:{path:z.string(),find:z.string(),replace:z.string(),output:z.string().optional(),replace_all:z.boolean().optional()}
  },async({path:p,find,replace,output,replace_all=true})=>{
    const abs=resolveInRoots(ctx.cfg,p),e=extOf(abs);if(![".docx",".pptx"].includes(e))throw new Error("docx/pptx만 지원");
    const out=resolveInRoots(ctx.cfg,output||p,{forWrite:true});const n=await replaceOfficeTextSemantic(abs,out,find,replace,replace_all);return text(n+"곳 semantic 치환 → "+out);
  });

  reg("pdf_extract_text",{
    description:"PDF 텍스트를 페이지별로 추출한다.",
    inputSchema:{path:z.string(),start_page:z.number().int().min(1).optional(),end_page:z.number().int().min(1).optional()}
  },async({path:p,start_page=1,end_page})=>{
    const abs=resolveInRoots(ctx.cfg,p); const data=new Uint8Array(fs.readFileSync(abs)); const pdf=await getDocument({data,useSystemFonts:true}).promise;
    const end=Math.min(end_page||pdf.numPages,pdf.numPages); const pages=[];
    for(let i=start_page;i<=end;i++){const page=await pdf.getPage(i);const tc=await page.getTextContent();pages.push({page:i,text:tc.items.map(x=>x.str).join(" ")});}
    return text(JSON.stringify({pages,totalPages:pdf.numPages},null,2));
  });


  reg("pdf_stamp_text",{
    description:"기존 PDF의 지정 페이지 좌표에 텍스트를 추가해 output으로 저장한다. 기본 표준 폰트는 라틴 문자 중심.",
    inputSchema:{path:z.string(),output:z.string(),page:z.number().int().min(1),x:z.number(),y:z.number(),text:z.string(),size:z.number().min(4).max(100).optional()}
  },async({path:p,output,page,x,y,text:value,size=12})=>{
    const abs=resolveInRoots(ctx.cfg,p),out=resolveInRoots(ctx.cfg,output,{forWrite:true});assertInputSize(abs);const pdf=await PDFDocument.load(fs.readFileSync(abs));if(page>pdf.getPageCount())throw new Error("page 범위 초과");
    const font=await pdf.embedFont(StandardFonts.Helvetica),pg=pdf.getPage(page-1);pg.drawText(value.replace(/[^\x20-\x7E]/g,"?"),{x,y,size,font});atomicWriteBuffer(out,Buffer.from(await pdf.save()));return text("PDF 저장: "+out);
  });

  reg("pdf_merge",{
    description:"여러 PDF를 순서대로 병합한다.",
    inputSchema:{paths:z.array(z.string()).min(2),output:z.string()}
  },async({paths,output})=>{
    const out=resolveInRoots(ctx.cfg,output,{forWrite:true}),merged=await PDFDocument.create();for(const p of paths){const abs=resolveInRoots(ctx.cfg,p);assertInputSize(abs);const src=await PDFDocument.load(fs.readFileSync(abs));const pages=await merged.copyPages(src,src.getPageIndices());for(const pg of pages)merged.addPage(pg);}atomicWriteBuffer(out,Buffer.from(await merged.save()));return text("PDF 병합: "+out);
  });

  reg("pdf_create_text",{
    description:"텍스트로 간단한 PDF를 생성한다. 한글 폰트 임베딩은 별도 폰트 지원이 필요해 기본 라틴 문자 중심.",
    inputSchema:{path:z.string(),text:z.string(),title:z.string().optional()}
  },async({path:p,text:body,title})=>{
    const out=resolveInRoots(ctx.cfg,p,{forWrite:true}); const pdf=await PDFDocument.create(); const font=await pdf.embedFont(StandardFonts.Helvetica);
    let page=pdf.addPage(); const size=page.getSize(); let y=size.height-50; const lines=(title?[title,"",...body.split(/\r?\n/)]:body.split(/\r?\n/));
    for(const raw of lines){for(const line of (raw.match(/.{1,90}/g)||[""])){if(y<50){page=pdf.addPage();y=page.getSize().height-50;} page.drawText(line.replace(/[^\x20-\x7E]/g,"?"),{x:50,y,size:11,font});y-=16;}}
    atomicWriteBuffer(out,Buffer.from(await pdf.save()));return text(`PDF 생성: ${out}`);
  });
}
