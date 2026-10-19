// ChatGPT Work parity: unified high-level facade over projects/tasks/cloud browser/sites/connectors.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { z } from "zod";
import { fileURLToPath } from "node:url";
import { text, enforceCapabilities } from "../toolkit.js";
import { resolveInRoots } from "../security.js";
import { coordinatorApi } from "./coordinator.js";
import { currentGoal, currentEffort } from "../session-state.js";
import { ensureWorkspace, currentWorkspace, workspaceMetadata } from "../workspaces.js";

function ensure(store){
  if(!store.data.workItems||typeof store.data.workItems!=="object")store.data.workItems={};
  if(!store.data.projects||typeof store.data.projects!=="object")store.data.projects={};
}
function now(){return new Date().toISOString();}
function skillNames(ctx){
  const pkgRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..","..");
  const roots=[path.join(pkgRoot,"skills"),path.join(ctx.cfg.roots[0],".webjjonku","skills")],set=new Set();
  for(const root of roots)try{for(const e of fs.readdirSync(root,{withFileTypes:true}))if(e.isDirectory()&&fs.existsSync(path.join(root,e.name,"SKILL.md")))set.add(e.name);}catch{}
  return [...set].sort();
}
function project(ctx,id){
  return ctx.store.data.projects[id||ctx.store.data.activeProjectId]||null;
}
function createProject(ctx,{name,root,instructions="",skills=[]}){
  const id="proj_"+crypto.randomBytes(5).toString("hex"),p={id,name,root:resolveInRoots(ctx.cfg,root||ctx.cfg.roots[0]),instructions,skills,createdAt:now(),updatedAt:now(),cloudVersion:null};
  ctx.store.data.projects[id]=p;ctx.store.data.activeProjectId=id;ctx.store.save();return p;
}
async function createLocalTask(ctx,{title,steps,cwd,projectId,workspaceId,lineageId,autoStart=true,autoRecover=true}){
  const g=currentGoal(ctx),w=await ensureWorkspace(ctx,{goalId:g?.id,lineageId:lineageId||g?.lineageId||g?.id,projectId,root:cwd||project(ctx,projectId)?.root||g?.repoRoot,workspaceId:workspaceId||(!cwd&&!projectId?g?.workspaceId:null)});
  const id="task_"+crypto.randomBytes(5).toString("hex"),root=w.root;
  const t={id,title,...workspaceMetadata(w),status:autoStart?"queued":"paused",steps:steps.map(s=>({...s,cwd:resolveInRoots(ctx.cfg,s.cwd?(path.isAbsolute(s.cwd)?s.cwd:path.join(root,s.cwd)):root),status:"pending",output:null,exitCode:null})),cwd:root,dependsOn:[],projectId:projectId||w.projectId||null,localRequired:true,autoRecover:autoRecover===true,createdAt:now(),startedAt:null,finishedAt:null,currentStep:null,error:null,events:[{ts:now(),type:"created",source:"work_start",autoRecover:autoRecover===true}],result:null};
  ctx.store.data.tasks[id]=t;ctx.store.save();return t;
}
function addRef(ctx,data){const id="work_"+crypto.randomBytes(5).toString("hex"),rec={id,createdAt:now(),...data};ctx.store.data.workItems[id]=rec;ctx.store.save();return rec;}

export function registerWorkFacadeTools(reg,ctx){
  ensure(ctx.store);

  reg("work_capabilities",{description:"일반 Chat에서 ChatGPT Work처럼 사용할 수 있는 고수준 기능 지도를 반환한다.",inputSchema:{}},async()=>text(JSON.stringify({
    local:["files","commands","documents","Office live","desktop/UIA","persistent tasks"],
    browser:["local DOM browser","persistent broker","cloud browser worker"],
    cloud:["coordinator tasks","schedules","webhooks","notifications","cross-device sync"],
    outputs:["artifacts","revisioned Sites","cloud Sites"],
    integrations:["OAuth2/PKCE","SaaS REST","Skills/Agent Plugin package"],
    resilience:["persistent goal/session state","auto-recoverable local Work tasks","ChatGPT UI stream watchdog"],
    highLevelTools:["work_home","work_start","work_status","work_project_view","work_recent","work_resume"]
  },null,2)));

  reg("work_home",{description:"Work 홈 화면에 해당하는 통합 상태: active project/goal/local+remote tasks/sites/artifacts/schedules/notifications/skills/connectors를 한 번에 본다.",inputSchema:{}},async()=>{
    ensure(ctx.store);let remoteTasks=[],cloudSchedules=[],notifications=[];try{if(ctx.store.data.coordinator?.url){[remoteTasks,cloudSchedules,notifications]=await Promise.all([coordinatorApi(ctx,"/v1/tasks?device_id="+encodeURIComponent(ctx.store.data.coordinator.deviceId)),coordinatorApi(ctx,"/v1/schedules"),coordinatorApi(ctx,"/v1/notifications?limit=20")]);}}catch{}
    const p=project(ctx),local=Object.values(ctx.store.data.tasks||{}).filter(t=>["queued","running","blocked","paused","waiting_for_device"].includes(t.status)).map(t=>({id:t.id,title:t.title,status:t.status,projectId:t.projectId,currentStep:t.currentStep}));
    const sites=Object.values(ctx.store.data.sites||{}).map(s=>({id:s.id,title:s.title,revision:s.currentRevision,projectId:s.projectId,cloudUrl:s.cloud?.publicUrl||null}));
    const artifacts=Object.values(ctx.store.data.artifacts||{}).map(a=>({id:a.id,title:a.title,projectId:a.projectId,revisions:a.revisions?.length||0}));
    return text(JSON.stringify({
      activeProject:p,goal:currentGoal(ctx),workspace:currentWorkspace(ctx),effort:currentEffort(ctx),
      localTasks:local,remoteTasks:remoteTasks.slice(-50),sites,artifacts,
      localSchedules:(ctx.store.data.schedules||[]).map(s=>({id:s.id,name:s.name,enabled:s.enabled,trigger:s.trigger||{type:"interval",minutes:s.everyMinutes}})),
      cloudSchedules:cloudSchedules.slice(-50),notifications:notifications.slice(-20),
      skills:skillNames(ctx),connectors:{saas:Object.keys(ctx.store.data.saasConnections||{}),oauth:Object.keys(ctx.store.data.oauthProviders||{})},
      plugin:{manifest:fs.existsSync(path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..",".."),"agent-plugin","plugin.json")),package:fs.existsSync(path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..",".."),"dist","webjjonku-v2-plugin.zip"))},
      sync:ctx.store.data.workSync||null,recentWork:Object.values(ctx.store.data.workItems||{}).slice(-20)
    },null,2));
  });

  reg("work_start",{
    description:"고수준 Work 작업을 시작한다. local은 persistent Task Manager(auto_recover 기본 ON), cloud_browser는 remote browser worker, cloud_http는 coordinator cloud executor로 자동 라우팅한다.",
    inputSchema:{
      title:z.string(),kind:z.enum(["local","cloud_browser","cloud_http"]),
      project_id:z.string().optional(),project_name:z.string().optional(),project_instructions:z.string().optional(),project_skills:z.array(z.string()).optional(),
      workspace_id:z.string().optional(),lineage_id:z.string().optional(),
      cwd:z.string().optional(),command:z.string().optional(),steps:z.array(z.object({title:z.string(),command:z.string().optional(),cwd:z.string().optional()})).optional(),
      url:z.string().url().optional(),browser_steps:z.array(z.any()).optional(),worker_id:z.string().optional(),
      http_url:z.string().url().optional(),method:z.string().optional(),body:z.any().optional(),headers:z.record(z.string()).optional(),
      auto_start:z.boolean().optional(),auto_recover:z.boolean().optional(),run_at:z.string().optional()
    }
  },async(args)=>{
    ensure(ctx.store);let p=args.project_id?project(ctx,args.project_id):project(ctx);
    if(args.project_id&&!p)throw new Error("project 없음: "+args.project_id);
    const caps=["work.start"];
    if(!p&&args.project_name)caps.push("project.write");
    if(args.kind==="local")caps.push("task.write");
    if(args.kind==="cloud_browser"){
      caps.push("coordinator.submit","browser.navigate");
      if((args.browser_steps||[]).some(s=>["click","type","search","download"].includes(s?.type)))caps.push("browser.input");
      if((args.browser_steps||[]).some(s=>s?.type==="upload"))caps.push("browser.upload");
    }
    if(args.kind==="cloud_http")caps.push("coordinator.submit","saas.request");
    enforceCapabilities(ctx,caps,"work_start",args);
    if(!p&&args.project_name)p=createProject(ctx,{name:args.project_name,root:args.cwd||ctx.cfg.roots[0],instructions:args.project_instructions||"",skills:args.project_skills||[]});
    const projectId=p?.id||null;
    if(args.kind==="local"){
      let steps=args.steps||[];if(!steps.length&&args.command)steps=[{title:args.title,command:args.command}];if(!steps.length)throw new Error("local work는 command 또는 steps 필요");
      const t=await createLocalTask(ctx,{title:args.title,steps,cwd:args.cwd,projectId,workspaceId:args.workspace_id,lineageId:args.lineage_id,autoStart:args.auto_start!==false,autoRecover:args.auto_recover!==false});
      const ref=addRef(ctx,{title:args.title,kind:"local",projectId,localTaskId:t.id,workspaceId:t.workspaceId,lineageId:t.lineageId,goalId:t.goalId});return text(JSON.stringify({work:ref,task:t},null,2));
    }
    if(args.kind==="cloud_browser"){
      if(!args.browser_steps?.length)throw new Error("cloud_browser는 browser_steps 필요");
      const targetDevice=args.worker_id||process.env.WEBJJONKU_DEFAULT_BROWSER_WORKER||null;
      const rt=await coordinatorApi(ctx,"/v1/tasks",{method:"POST",body:{title:args.title,executor:"browser",localRequired:false,targetDevice,runAt:args.run_at||null,...workspaceMetadata(currentWorkspace(ctx)),action:{type:"browser",url:args.url||null,steps:args.browser_steps}}});
      const ref=addRef(ctx,{title:args.title,kind:"cloud_browser",projectId,remoteTaskId:rt.id});return text(JSON.stringify({work:ref,task:rt},null,2));
    }
    if(!args.http_url)throw new Error("cloud_http는 http_url 필요");
    const rt=await coordinatorApi(ctx,"/v1/tasks",{method:"POST",body:{title:args.title,executor:"cloud",localRequired:false,runAt:args.run_at||null,action:{type:"http",url:args.http_url,method:args.method||"GET",body:args.body,headers:args.headers||{}}}});
    const ref=addRef(ctx,{title:args.title,kind:"cloud_http",projectId,remoteTaskId:rt.id});return text(JSON.stringify({work:ref,task:rt},null,2));
  });

  reg("work_status",{description:"work reference 또는 underlying task/site/artifact/project id를 한 인터페이스로 조회한다.",inputSchema:{id:z.string()}},async({id})=>{
    ensure(ctx.store);const ref=ctx.store.data.workItems[id];
    if(ref){
      if(ref.localTaskId)return text(JSON.stringify({work:ref,status:ctx.store.data.tasks?.[ref.localTaskId]||null},null,2));
      if(ref.remoteTaskId)return text(JSON.stringify({work:ref,status:await coordinatorApi(ctx,"/v1/tasks/"+encodeURIComponent(ref.remoteTaskId))},null,2));
      return text(JSON.stringify({work:ref},null,2));
    }
    if(ctx.store.data.tasks?.[id])return text(JSON.stringify(ctx.store.data.tasks[id],null,2));
    if(ctx.store.data.sites?.[id])return text(JSON.stringify(ctx.store.data.sites[id],null,2));
    if(ctx.store.data.artifacts?.[id])return text(JSON.stringify(ctx.store.data.artifacts[id],null,2));
    if(ctx.store.data.projects?.[id])return text(JSON.stringify(ctx.store.data.projects[id],null,2));
    if(id.startsWith("rt_"))return text(JSON.stringify(await coordinatorApi(ctx,"/v1/tasks/"+encodeURIComponent(id)),null,2));
    throw new Error("Work item 없음: "+id);
  });

  reg("work_project_view",{description:"프로젝트의 instructions/skills/local+remote work/tasks/artifacts/sites를 통합 조회한다.",inputSchema:{id:z.string().optional()}},async({id})=>{
    const p=project(ctx,id);if(!p)throw new Error("project 없음");
    let remote=[];try{remote=await coordinatorApi(ctx,"/v1/tasks?device_id="+encodeURIComponent(ctx.store.data.coordinator?.deviceId||""));}catch{}
    return text(JSON.stringify({
      project:p,
      localTasks:Object.values(ctx.store.data.tasks||{}).filter(t=>t.projectId===p.id).map(t=>({id:t.id,title:t.title,status:t.status,currentStep:t.currentStep})),
      workItems:Object.values(ctx.store.data.workItems||{}).filter(w=>w.projectId===p.id),
      remoteTasks:remote.filter(t=>Object.values(ctx.store.data.workItems||{}).some(w=>w.projectId===p.id&&w.remoteTaskId===t.id)).map(t=>({id:t.id,title:t.title,status:t.status,executor:t.executor})),
      artifacts:Object.values(ctx.store.data.artifacts||{}).filter(a=>a.projectId===p.id).map(a=>({id:a.id,title:a.title,revisions:a.revisions?.length||0})),
      sites:Object.values(ctx.store.data.sites||{}).filter(s=>s.projectId===p.id).map(s=>({id:s.id,title:s.title,revision:s.currentRevision,cloudUrl:s.cloud?.publicUrl||null}))
    },null,2));
  });

  reg("work_recent",{description:"최근 고수준 Work 작업 reference를 조회한다.",inputSchema:{limit:z.number().int().min(1).max(100).optional()}},async({limit=30})=>{
    ensure(ctx.store);return text(JSON.stringify(Object.values(ctx.store.data.workItems).slice(-limit),null,2));
  });
}
