import { z } from "zod";
import { text } from "../toolkit.js";
import { currentWorkspace, listWorkspaces, inspectWorkspace, bindWorkspace, workspaceMetadata } from "../workspaces.js";

export function registerWorkspaceTools(reg,ctx){
  reg("workspace_status",{
    description:"현재 Goal/session lineage workspace 또는 지정 workspace의 durable metadata를 확인한다.",
    inputSchema:{id:z.string().optional()}
  },async({id})=>{
    const rec=id?inspectWorkspace(ctx,id):currentWorkspace(ctx);
    return text(JSON.stringify(rec?workspaceMetadata(rec):{workspaceId:null,lineageId:null,cwd:(ctx.baseCfg||ctx.cfg).roots[0]},null,2));
  });

  reg("workspace_list",{
    description:"이 host에서 알려진 persistent workspace/worktree 목록을 확인한다. 자동 삭제는 하지 않는다.",
    inputSchema:{}
  },async()=>{
    const rows=listWorkspaces(ctx).map(workspaceMetadata);
    return text(JSON.stringify(rows,null,2));
  });

  reg("workspace_open",{
    description:"이미 존재하는 workspace id를 현재 session에 명시적으로 재바인딩한다. 새 workspace 생성은 goal_set/work_resume가 담당한다.",
    inputSchema:{id:z.string().min(1)}
  },async({id})=>text(JSON.stringify(workspaceMetadata(bindWorkspace(ctx,id)),null,2)));
}
