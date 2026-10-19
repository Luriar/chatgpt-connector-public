import path from "node:path";
import { spawnSync } from "node:child_process";
import { z } from "zod";
import { text } from "../toolkit.js";

function scriptPath(ctx){
  return path.join(path.dirname(ctx.cfg.configPath || process.cwd()), "scripts", "chatgpt-ui-watchdog.ps1");
}
function call(ctx,args){
  if(process.platform!=="win32")throw new Error("ChatGPT UI watchdog is Windows-only.");
  const p=scriptPath(ctx);
  const r=spawnSync("powershell.exe",["-NoProfile","-ExecutionPolicy","Bypass","-File",p,...args],{encoding:"utf8",timeout:30000,windowsHide:true});
  if(r.error)throw r.error;
  if(r.status!==0)throw new Error((r.stderr||r.stdout||"ui watchdog failed").trim());
  return (r.stdout||"").trim();
}

export function registerUiWatchdogTools(reg,ctx){
  reg("ui_watchdog_status",{description:"ChatGPT stream-recovery UI watchdog 상태를 확인한다.",inputSchema:{}},async()=>text(call(ctx,["-Action","status"])));
  reg("ui_watchdog_enable",{
    description:"ChatGPT 데스크톱에서 stream recovery polling timeout을 감지하면 Retry를 시도하고 필요하면 이전 작업 계속 지시를 자동 전송하는 watchdog을 켠다.",
    inputSchema:{
      mode:z.enum(["retry","continue","retry_then_continue"]).optional(),
      poll_seconds:z.number().int().min(2).max(120).optional(),
      retry_grace_seconds:z.number().int().min(5).max(300).optional(),
      cooldown_seconds:z.number().int().min(10).max(600).optional(),
      resume_text:z.string().min(1).max(500).optional()
    }
  },async({mode="retry_then_continue",poll_seconds=5,retry_grace_seconds=20,cooldown_seconds=45,resume_text="Continue the previous task from the last completed step."})=>
    text(call(ctx,["-Action","enable","-Mode",mode,"-PollSeconds",String(poll_seconds),"-RetryGraceSeconds",String(retry_grace_seconds),"-CooldownSeconds",String(cooldown_seconds),"-ResumeText",resume_text]))
  );
  reg("ui_watchdog_disable",{description:"ChatGPT UI watchdog을 끄고 자동 시작 작업을 제거한다.",inputSchema:{}},async()=>text(call(ctx,["-Action","disable"])));
  reg("ui_watchdog_test",{description:"watchdog을 한 번만 스캔해 timeout 오류 감지/복구 동작 결과를 반환한다.",inputSchema:{}},async()=>text(call(ctx,["-Action","once"])));
}
