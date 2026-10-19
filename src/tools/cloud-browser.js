// ChatGPT Work parity: cloud/remote browser facade over coordinator + browser-worker.
import path from "node:path";
import { z } from "zod";
import { text, enforceCapabilities } from "../toolkit.js";
import { coordinatorApi, coordinatorGetBlob } from "./coordinator.js";

const step=z.object({
  type:z.enum(["goto","click","type","search","upload","download","wait","read","inspect_controls","screenshot","html"]),
  url:z.string().url().optional(),
  selector:z.string().optional(),
  text:z.string().optional(),
  exact:z.boolean().optional(),
  value:z.union([z.string(),z.number(),z.boolean()]).optional(),
  query:z.string().optional(),
  path:z.string().optional(),
  paths:z.array(z.string()).optional(),
  fileName:z.string().optional(),
  contentType:z.string().optional(),
  pressEnter:z.boolean().optional(),
  ms:z.number().int().min(0).max(120000).optional(),
  timeoutMs:z.number().int().min(100).max(120000).optional(),
  waitUntil:z.enum(["load","domcontentloaded","networkidle"]).optional(),
  state:z.enum(["attached","detached","visible","hidden"]).optional(),
  maxChars:z.number().int().min(100).max(100000).optional(),
  max:z.number().int().min(1).max(300).optional(),
  fullPage:z.boolean().optional()
});

export function registerCloudBrowserTools(reg,ctx){
  reg("cloud_browser_workers",{description:"coordinator에 연결된 cloud-browser worker 목록과 마지막 heartbeat를 본다.",inputSchema:{}},async()=>{
    const rows=await coordinatorApi(ctx,"/v1/devices");
    return text(JSON.stringify(rows.filter(x=>(x.capabilities||[]).includes("cloud-browser")),null,2));
  });

  reg("cloud_browser_submit",{
    description:"항상 켜진 browser worker에 Playwright DOM 작업을 제출한다. PC 로컬 브라우저가 없어도 coordinator/browser-worker가 살아 있으면 실행된다.",
    inputSchema:{
      title:z.string().optional(),url:z.string().url().optional(),steps:z.array(step).min(1),
      worker_id:z.string().optional(),run_at:z.string().optional(),idempotency_key:z.string().optional(),timeout_ms:z.number().int().min(1000).max(120000).optional()
    }
  },async({title="cloud browser task",url,steps,worker_id,run_at,idempotency_key,timeout_ms=30000})=>{
    const caps=["coordinator.submit","browser.navigate"];if(steps.some(s=>["click","type","search","upload","download"].includes(s.type)))caps.push("browser.input");
    enforceCapabilities(ctx,caps,"cloud_browser_submit",{title,url,steps,worker_id,run_at,idempotency_key,timeout_ms});
    const body={
      title,executor:"browser",localRequired:false,targetDevice:worker_id||process.env.WEBJJONKU_DEFAULT_BROWSER_WORKER||null,runAt:run_at||null,idempotencyKey:idempotency_key||null,
      action:{type:"browser",url:url||null,steps,timeoutMs:timeout_ms}
    };
    return text(JSON.stringify(await coordinatorApi(ctx,"/v1/tasks",{method:"POST",body}),null,2));
  });

  reg("cloud_browser_status",{description:"cloud browser 작업 상태를 조회한다.",inputSchema:{id:z.string()}},async({id})=>{
    return text(JSON.stringify(await coordinatorApi(ctx,"/v1/tasks/"+encodeURIComponent(id)),null,2));
  });

  reg("cloud_browser_result",{description:"완료된 cloud browser 작업의 DOM 결과/스크린샷 blob metadata를 반환한다.",inputSchema:{id:z.string()}},async({id})=>{
    const t=await coordinatorApi(ctx,"/v1/tasks/"+encodeURIComponent(id));
    return text(JSON.stringify({id:t.id,status:t.status,error:t.error,result:t.result},null,2));
  });

  reg("cloud_browser_artifact",{
    description:"cloud browser screenshot을 ChatGPT 안에서 미리보기로 표시한다. 원본 저장/ChatGPT 파일 업로드는 사용자가 UI에서 직접 눌렀을 때만 수행한다.",
    inputSchema:{blob_key:z.string(),path:z.string().optional()},
    _meta:{ui:{resourceUri:"ui://webjjonku/image-delivery.html"},"openai/outputTemplate":"ui://webjjonku/image-delivery.html"}
  },async({blob_key,path:out})=>{
    const b=await coordinatorGetBlob(ctx,blob_key);
    const mime=String(b.contentType||"image/png").split(";")[0];
    if(!mime.startsWith("image/"))throw new Error("artifact is not an image");
    const fileName=out?path.basename(out):("image."+((mime.split("/")[1]||"png").replace(/[^a-z0-9.+-]/gi,"")||"png"));
    const meta={blobKey:blob_key,saved:null,previewOnly:true,bytes:b.buffer.length,version:b.version,contentType:mime,fileName};
    return {content:[{type:"text",text:JSON.stringify(meta,null,2)}],structuredContent:meta,_meta:{ui:{resourceUri:"ui://webjjonku/image-delivery.html"},"openai/outputTemplate":"ui://webjjonku/image-delivery.html"}};
  });

  reg("cloud_browser_artifact_chunk",{
    description:"이미지 전달 UI가 원본 blob을 조각 단위로 읽는다. 일반 대화에서는 직접 호출하지 않는다.",
    inputSchema:{blob_key:z.string(),offset:z.number().int().min(0),length:z.number().int().min(1).max(131072)}
  },async({blob_key,offset,length})=>{
    const b=await coordinatorGetBlob(ctx,blob_key),total=b.buffer.length;
    if(offset>total)throw new Error("offset beyond blob");
    const end=Math.min(total,offset+length),slice=b.buffer.subarray(offset,end);
    const sc={blobKey:blob_key,offset,end,total,done:end>=total,data:slice.toString("base64")};
    return {content:[{type:"text",text:JSON.stringify(sc)}],structuredContent:sc};
  });
}
