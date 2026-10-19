// ChatGPT Work parity: cloud schedules, webhook triggers, and notification feed.
import { z } from "zod";
import { text } from "../toolkit.js";
import { coordinatorApi } from "./coordinator.js";

const executor=z.enum(["device","browser","cloud"]);
const template=z.object({
  title:z.string(),
  executor:executor.optional(),
  local_required:z.boolean().optional(),
  target_device:z.string().optional(),
  action:z.any()
});
function toTemplate(v){return {title:v.title,executor:v.executor||"device",localRequired:v.local_required!==false,targetDevice:v.target_device||null,action:v.action};}

export function registerWorkAutomationTools(reg,ctx){
  reg("cloud_schedule_add_at",{
    description:"항상 켜진 coordinator에서 특정 시각에 한 번 Work task를 실행하도록 예약한다. 로컬 PC가 꺼져도 cloud executor 작업은 실행 가능.",
    inputSchema:{name:z.string(),at:z.string(),task:template}
  },async({name,at,task})=>text(JSON.stringify(await coordinatorApi(ctx,"/v1/schedules",{method:"POST",body:{name,trigger:{type:"at",at},taskTemplate:toTemplate(task)}}),null,2)));

  reg("cloud_schedule_add_interval",{
    description:"coordinator에서 N분마다 반복되는 Work task를 등록한다.",
    inputSchema:{name:z.string(),every_minutes:z.number().int().min(1).max(525600),task:template}
  },async({name,every_minutes,task})=>text(JSON.stringify(await coordinatorApi(ctx,"/v1/schedules",{method:"POST",body:{name,trigger:{type:"interval",minutes:every_minutes},taskTemplate:toTemplate(task)}}),null,2)));

  reg("cloud_schedule_add_cron",{
    description:"coordinator에서 cron+timezone 기반 반복 Work task를 등록한다.",
    inputSchema:{name:z.string(),cron:z.string(),timezone:z.string().optional(),task:template}
  },async({name,cron,timezone,task})=>text(JSON.stringify(await coordinatorApi(ctx,"/v1/schedules",{method:"POST",body:{name,trigger:{type:"cron",expression:cron,timezone:timezone||null},taskTemplate:toTemplate(task)}}),null,2)));

  reg("cloud_schedule_list",{description:"cloud schedule 목록과 nextRunAt을 조회한다.",inputSchema:{}},async()=>text(JSON.stringify(await coordinatorApi(ctx,"/v1/schedules"),null,2)));

  reg("cloud_schedule_action",{
    description:"cloud schedule을 enable/disable/run-now/remove 한다.",
    inputSchema:{id:z.string(),action:z.enum(["enable","disable","run-now","remove"])}
  },async({id,action})=>{
    if(action==="remove")return text(JSON.stringify(await coordinatorApi(ctx,"/v1/schedules/"+encodeURIComponent(id),{method:"DELETE"}),null,2));
    return text(JSON.stringify(await coordinatorApi(ctx,"/v1/schedules/"+encodeURIComponent(id)+"/"+action,{method:"POST",body:{}}),null,2));
  });

  reg("work_webhook_create",{
    description:"외부 이벤트가 POST되면 Work task를 생성하는 secret webhook URL을 만든다. secret URL은 생성 응답에서만 반환되므로 비밀로 취급한다.",
    inputSchema:{name:z.string(),task:template}
  },async({name,task})=>text(JSON.stringify(await coordinatorApi(ctx,"/v1/webhooks",{method:"POST",body:{name,taskTemplate:toTemplate(task)}}),null,2)));

  reg("work_webhook_list",{description:"등록된 Work webhook 목록을 조회한다. secret은 다시 노출되지 않는다.",inputSchema:{}},async()=>text(JSON.stringify(await coordinatorApi(ctx,"/v1/webhooks"),null,2)));

  reg("work_webhook_action",{
    description:"Work webhook을 enable/disable/remove 한다.",
    inputSchema:{id:z.string(),action:z.enum(["enable","disable","remove"])}
  },async({id,action})=>{
    if(action==="remove")return text(JSON.stringify(await coordinatorApi(ctx,"/v1/webhooks/"+encodeURIComponent(id),{method:"DELETE"}),null,2));
    return text(JSON.stringify(await coordinatorApi(ctx,"/v1/webhooks/"+encodeURIComponent(id)+"/"+action,{method:"POST",body:{}}),null,2));
  });

  reg("work_notifications",{
    description:"cloud/device/browser task 완료·실패·취소 알림 feed를 조회한다. ChatGPT native push UI의 기능적 대체 계층.",
    inputSchema:{unread_only:z.boolean().optional(),since:z.string().optional(),limit:z.number().int().min(1).max(500).optional()}
  },async({unread_only=false,since,limit=100})=>{
    const q=new URLSearchParams({limit:String(limit)});if(unread_only)q.set("unread","true");if(since)q.set("since",since);
    return text(JSON.stringify(await coordinatorApi(ctx,"/v1/notifications?"+q.toString()),null,2));
  });

  reg("work_notification_read",{description:"알림을 읽음 처리한다.",inputSchema:{id:z.string()}},async({id})=>text(JSON.stringify(await coordinatorApi(ctx,"/v1/notifications/"+encodeURIComponent(id)+"/read",{method:"POST",body:{}}),null,2)));

  reg("work_notification_wait",{
    description:"새 Work 알림이 생길 때까지 짧게 polling한다. type/title_contains로 필터 가능.",
    inputSchema:{after:z.string().optional(),type:z.string().optional(),title_contains:z.string().optional(),timeout_ms:z.number().int().min(1000).max(120000).optional()}
  },async({after,type,title_contains,timeout_ms=30000})=>{
    const started=Date.now(),since=after||new Date(Date.now()-1000).toISOString();
    while(Date.now()-started<timeout_ms){
      const q=new URLSearchParams({since,limit:"100"}),rows=await coordinatorApi(ctx,"/v1/notifications?"+q.toString());
      const hit=rows.find(n=>(!type||n.type===type)&&(!title_contains||String(n.title||"").toLowerCase().includes(title_contains.toLowerCase())));
      if(hit)return text(JSON.stringify(hit,null,2));
      await new Promise(r=>setTimeout(r,750));
    }
    return text(JSON.stringify({timeout:true,after:since},null,2));
  });
}
