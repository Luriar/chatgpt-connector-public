import { z } from "zod";
import { text } from "../toolkit.js";
import { coordinatorApi } from "./coordinator.js";

export function registerDelegationTools(reg,ctx){
  reg("delegation_get_task",{
    description:"Codex/외부 supervisor가 발급한 delegation capability token으로 배정된 작업을 읽는다. token은 해당 작업 하나에만 쓰는 비밀 capability이며 로그/답변에 재노출하지 않는다.",
    inputSchema:{token:z.string().min(20)}
  },async({token})=>{
    const task=await coordinatorApi(ctx,"/v1/delegations/task",{method:"POST",body:{token}});
    return text(JSON.stringify(task,null,2));
  });

  reg("delegation_submit_result",{
    description:"배정된 delegation 작업의 최종 결과를 coordinator에 영속 저장한다. completed/partial/failed/cancelled 상태, 짧은 summary, 검증/변경/남은 작업을 포함한 result를 제출한다. 동일 payload 재제출은 안전한 duplicate로 처리된다.",
    inputSchema:{
      token:z.string().min(20),
      status:z.enum(["completed","partial","failed","cancelled"]),
      summary:z.string().max(2048),
      result:z.string().max(1_000_000)
    }
  },async({token,status,summary,result})=>{
    const saved=await coordinatorApi(ctx,"/v1/delegations/submit",{method:"POST",body:{token,status,summary,result}});
    return text(JSON.stringify(saved,null,2));
  });

  reg("delegation_touch_open",{
    description:"사용자 제어 open delegation의 24시간 idle lease를 갱신한다. 일반 delegated task에는 사용하지 않는다.",
    inputSchema:{id:z.string()}
  },async({id})=>text(JSON.stringify(await coordinatorApi(ctx,"/v1/delegations/"+encodeURIComponent(id)+"/touch",{method:"POST",body:{}}),null,2)));
}
