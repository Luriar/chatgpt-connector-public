// V2 secure command execution via Docker bind-mount sandbox
import { spawn, spawnSync } from "node:child_process";
import { z } from "zod";
import { resolveInRoots, assertMutationAllowed } from "../security.js";
import { text } from "../toolkit.js";

export function registerSecureExecTools(reg,ctx){
  reg("exec_secure",{
    description:"격리 Docker 컨테이너에서 명령을 실행한다. 승인 루트의 지정 cwd만 /work로 마운트한다. 불신 코드/패키지/외부 프로젝트 명령은 exec_command보다 우선 사용.",
    inputSchema:{command:z.string(),cwd:z.string().optional(),image:z.string().optional(),network:z.boolean().optional(),timeout_ms:z.number().int().min(1000).max(600000).optional()}
  },async({command,cwd,image,network=false,timeout_ms=120000})=>{
    assertMutationAllowed(ctx.cfg,"격리 명령 실행");
    const dir=resolveInRoots(ctx.cfg,cwd||ctx.cfg.roots[0]);
    const img=image||ctx.cfg.exec?.secureImage||"node:22-slim";
    const ready=spawnSync("docker",["info","--format","{{.ServerVersion}}"],{encoding:"utf8",timeout:5000,windowsHide:true});
    if(ready.status!==0) throw new Error("Docker 엔진이 준비되지 않았어. Docker Desktop을 시작한 뒤 다시 실행해.");
    const args=["run","--rm","-v",`${dir}:/work`,"-w","/work"];
    if(!network)args.push("--network","none");
    args.push(img,"sh","-lc",command);
    return await new Promise((resolve)=>{
      const p=spawn("docker",args,{windowsHide:true});let out="",err="",done=false;
      const cap=(s,d)=>(s+d.toString()).slice(-120000);
      p.stdout.on("data",d=>out=cap(out,d));p.stderr.on("data",d=>err=cap(err,d));
      const timer=setTimeout(()=>{if(done)return;done=true;try{p.kill("SIGKILL");}catch{}resolve(text(`⏱ secure exec timeout ${timeout_ms}ms\n${out}\n${err}`));},timeout_ms);
      p.on("close",code=>{if(done)return;done=true;clearTimeout(timer);resolve(text(`[secure exit ${code} · ${img} · network=${network}]\n${out}${err?`\n--- stderr ---\n${err}`:""}`));});
      p.on("error",e=>{if(done)return;done=true;clearTimeout(timer);resolve(text(`⛔ Docker 실행 실패: ${e.message}`));});
    });
  });
}
