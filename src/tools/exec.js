// 명령 실행: 원샷 + 지속 터미널 세션(write_stdin) — Codex exec_command/write_stdin 급
// Windows 참고: 원샷은 PowerShell, 지속 세션은 cmd로 호스팅한다.
// (powershell.exe는 stdin이 파이프면 EOF까지 실행을 미루는 특성이 있어 세션용으로 부적합)
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { z } from "zod";
import { resolveInRoots, assertMutationAllowed, childProcessEnv } from "../security.js";
import { text } from "../toolkit.js";
import { acquireResourceLocks, releaseResourceLocks } from "../resource-locks.js";

const IS_WIN = process.platform === "win32";
const sessions = new Map(); // id -> { proc, buf, shell, cwd, createdAt }
const PROCESS_KILL_GRACE_MS=2_000;

function pickShell(shell, { session = false } = {}) {
  if (shell && shell !== "auto") return shell;
  if (IS_WIN) return session ? "cmd" : "powershell";
  return "bash";
}

export function registerExecTools(reg, ctx) {
  const cfg = ctx.cfg;
  const resilience=cfg.resilience||{};
  const oneShotHardCapMs=Math.max(5_000,Number(resilience.durableThresholdMs)||30_000);
  const durableForegroundWaitMs=Math.max(500,Number(process.env.WEBJJONKU_DURABLE_FOREGROUND_WAIT_MS||resilience.durableForegroundWaitMs||2500));
  const resultMaxBytes=Math.max(4096,Number(resilience.resultMaxBytes)||65536);

  function cleanSessionOutput(chunk,token=null){
    let out=String(chunk||"");
    if(token){
      let i=out.indexOf(token+"_");
      while(i>=0){
        let j=i+token.length+1;
        if(out[j]==="-")j++;
        while(j<out.length&&out[j]>="0"&&out[j]<="9")j++;
        out=out.slice(0,i)+out.slice(j);
        i=out.indexOf(token+"_",i);
      }
    }
    return out.trimEnd();
  }
  function refreshSessionCommand(s){
    const p=s.pendingCommand;
    if(!p)return s.lastCommand||null;
    const chunk=s.buf.slice(p.mark);
    const m=chunk.match(new RegExp(p.token+"_(-?\\d+)"));
    if(!m)return {state:"running",startedAt:p.startedAt};
    s.lastCommand={token:p.token,state:"finished",exitCode:Number(m[1]),startedAt:p.startedAt,finishedAt:new Date().toISOString(),command:p.command};
    s.pendingCommand=null;
    return s.lastCommand;
  }
  function sessionCommandStatus(s){
    refreshSessionCommand(s);
    if(s.pendingCommand)return `[command running since ${s.pendingCommand.startedAt}]`;
    if(s.lastCommand)return `[command finished exit ${s.lastCommand.exitCode} at ${s.lastCommand.finishedAt}]`;
    return "[session idle]";
  }

  reg("exec_command", {
    description: "셸 명령 실행. 기본은 짧은 단일 목적 one-shot 실행이다. 한 호출에 여러 진단/변경을 묶지 말고 순차 확인하며, 긴 embedded script는 파일 스크립트로 분리한다. 30초를 넘는 장기 작업이나 durable=true인 경우만 영속 durable Task로 실행한다. 대화형 작업만 session=true 사용.",
    inputSchema: {
      command: z.string(),
      cwd: z.string().optional(),
      shell: z.enum(["auto", "powershell", "cmd", "bash"]).optional(),
      timeout_ms: z.number().int().min(1000).max(600_000).optional().describe("기본 30초. 30초 초과면 장기 작업으로 보고 durable Task 사용"),
      session: z.boolean().optional().describe("true면 지속 터미널 세션 생성 후 그 안에서 실행"),
      durable: z.boolean().optional().describe("true면 스트림 단절에도 계속되어야 하는 장기 작업으로 영속 Task 실행. 짧은 확인 명령에는 사용하지 않음")
    }
  }, async ({ command, cwd, shell = "auto", timeout_ms = 30_000, session = false, durable = false }) => {
    assertMutationAllowed(cfg, "명령 실행");
    const dir = resolveInRoots(cfg, cwd || cfg.roots[0]);
    let sh = pickShell(shell, { session });
    let note = "";
    if (session && IS_WIN && sh === "powershell") {
      sh = "cmd";
      note = `\n(참고: Windows 지속 세션은 cmd로 호스팅돼. 파워셸 한 줄이 필요하면 powershell -NoProfile -Command "..." 형태로 실행하면 돼)`;
    }

    const durableRequested=durable===true||Number(timeout_ms)>oneShotHardCapMs;
    const durableNative=durableRequested&&!session&&ctx.createDurableCommandTask&&ctx.waitDurableTask&&process.env.WEBJJONKU_DURABLE_EXEC!=="0"&&
      ((!IS_WIN&&sh==="bash")||(IS_WIN&&["powershell","cmd"].includes(sh)));
    if(durableNative){
      const task=ctx.createDurableCommandTask({title:"exec: "+String(command).slice(0,80),command,cwd:dir,shell:sh,timeoutMs:Number(timeout_ms)||null,autoRecover:false,preAuthorized:true,localRequired:true});
      const waited=await ctx.waitDurableTask(task.id,Math.min(Number(timeout_ms)||30_000,durableForegroundWaitMs));
      const step=waited.steps?.[0];
      if(waited.status==="succeeded")return text(`[exit ${step?.exitCode??0} · ${sh} · ${dir}]\n${step?.output||""}`);
      if(waited.status==="failed")return text(`⛔ 실행 실패 · durable task ${waited.id}: ${waited.error||"failed"}\n${step?.output||""}`);
      if(waited.status==="cancelled")return text(`⛔ durable task ${waited.id} cancelled`);
      if(waited.status==="paused")return text(`⏸ durable task ${waited.id} paused: ${waited.error||""}\n재개: task_resume{id:"${waited.id}"}`);
      return text(`🛟 durable task ${waited.id}로 계속 실행 중이야. ChatGPT 응답 스트림이나 클라이언트가 끊겨도 NAS 프로세스에서 계속 진행돼.\n상태: task_status{id:"${waited.id}"} · 결과: task_result{id:"${waited.id}"}`);
    }

    if (session) {
      const id = openSession(sh, dir);
      const out = await runInSession(id, command, timeout_ms);
      return text(`[세션 ${id} 생성 · ${sh} · ${dir}]\n${out}\n\n(이어서: exec_stdin{session:"${id}"}, 종료: exec_kill)${note}`);
    }

    const lockOwner="exec-"+crypto.randomBytes(6).toString("hex");
    acquireResourceLocks(ctx,["workspace"],{tool:"exec_command",seconds:120,owner:lockOwner,mode:"call"});
    try{
      return await new Promise((resolve) => {
        const effectiveTimeout = Math.min(timeout_ms, oneShotHardCapMs);
        const spawnOpts = { cwd: dir, env: childProcessEnv(), ...(IS_WIN ? {} : { detached: true }) };
        const proc = sh === "bash"
          ? spawn("bash", ["-lc", command], spawnOpts)
          : sh === "cmd"
            ? spawn("cmd.exe", ["/d", "/s", "/c", command], { ...spawnOpts, windowsVerbatimArguments: true })
            : spawn("powershell.exe", ["-NoProfile", "-Command", command], spawnOpts);
        let out = "", err = "", done = false, timedOut = false, killFallback = null;
        const cap = (s, chunk) => (s + chunk).slice(-resultMaxBytes);
        proc.stdout.on("data", (d) => (out = cap(out, d.toString())));
        proc.stderr.on("data", (d) => (err = cap(err, d.toString())));
        const killTree = () => {
          if (IS_WIN) {
            try { spawn("taskkill.exe", ["/PID", String(proc.pid), "/T", "/F"], { windowsHide:true, stdio:"ignore" }); } catch { try { proc.kill("SIGKILL"); } catch {} }
          } else {
            try { process.kill(-proc.pid, "SIGKILL"); } catch { try { proc.kill("SIGKILL"); } catch {} }
          }
        };
        const finishTimeout = () => {
          if (done) return; done = true;
          if (killFallback) clearTimeout(killFallback);
          const capped = timeout_ms > oneShotHardCapMs ? ` (one-shot hard cap ${oneShotHardCapMs}ms)` : "";
          resolve(text(`⏱ 타임아웃(${effectiveTimeout}ms)${capped}. 프로세스 트리 종료 확인 후 반환. 부분 출력:\n${out}\n${err}`));
        };
        const timer = setTimeout(() => {
          if (done) return;
          timedOut = true;
          killTree();
          killFallback = setTimeout(finishTimeout, PROCESS_KILL_GRACE_MS);
        }, effectiveTimeout);
        proc.on("close", (code) => {
          if (done) return;
          clearTimeout(timer);
          if (timedOut) return finishTimeout();
          done = true;
          resolve(text(`[exit ${code} · ${sh} · ${dir}]\n${out}${err ? `\n--- stderr ---\n${err}` : ""}` || `[exit ${code}] (출력 없음)`));
        });
        proc.on("error", (e) => {
          if (done) return;
          clearTimeout(timer);
          if (timedOut) return finishTimeout();
          done = true;
          resolve(text(`⛔ 실행 실패: ${e.message}`));
        });
      });
    }finally{releaseResourceLocks(ctx,["workspace"],lockOwner);}
  });

  reg("exec_stdin", {
    description: "지속 세션에 입력 전송 또는 상태 polling. input=\"\" raw=true면 이전 poll 이후 출력과 명령 완료 상태를 반환.",
    inputSchema: {
      session: z.string(),
      input: z.string().describe("보낼 텍스트. 상태 확인만 하려면 빈 문자열. 개행 자동 추가, raw=true면 그대로 전송"),
      raw: z.boolean().optional(),
      wait_ms: z.number().int().min(100).max(120_000).optional()
    }
  }, async ({ session, input, raw = false, wait_ms = 3000 }) => {
    assertMutationAllowed(cfg, "세션 입력");
    const s = sessions.get(session);
    if (!s) throw new Error(`세션 ${session} 없음. exec_sessions로 목록 확인.`);
    refreshSessionCommand(s);
    const mark = Number.isInteger(s.readCursor) ? s.readCursor : s.buf.length;
    if(String(input||"").length)s.proc.stdin.write(raw ? input : input + "\n");
    await sleep(wait_ms);
    refreshSessionCommand(s);
    const chunk=cleanSessionOutput(s.buf.slice(mark),s.pendingCommand?.token||s.lastCommand?.token||null);
    s.readCursor=s.buf.length;
    return text([chunk||"(새 출력 없음)",sessionCommandStatus(s)].join("\n"));
  });

  reg("exec_sessions", {
    description: "터미널 세션 목록. shell 생존 여부와 현재 명령 running/finished 상태를 구분한다.",
    inputSchema: {}
  }, async () => {
    if (!sessions.size) return text("활성 세션 없음");
    return text([...sessions.entries()].map(([id, s]) => {
      const shellState=s.proc.exitCode===null?"shell=alive":"shell=closed("+s.proc.exitCode+")";
      refreshSessionCommand(s);
      const commandState=s.pendingCommand
        ? "command=running since "+s.pendingCommand.startedAt
        : s.lastCommand
          ? "command=idle lastExit="+s.lastCommand.exitCode+" finished="+s.lastCommand.finishedAt
          : "command=idle";
      return `${id} · ${s.shell} · ${s.cwd} · ${shellState} · ${commandState} · since ${s.createdAt}`;
    }).join("\n"));
  });

  reg("exec_kill", {
    description: "터미널 세션과 그 자식 프로세스 트리를 종료",
    inputSchema: { session: z.string() }
  }, async ({ session }) => {
    const s = sessions.get(session);
    if (!s) throw new Error("해당 세션 없음");
    if(IS_WIN){
      try { spawn("taskkill.exe", ["/PID", String(s.proc.pid), "/T", "/F"], { windowsHide:true, stdio:"ignore" }); } catch { try { s.proc.kill("SIGKILL"); } catch {} }
    }else{
      try { process.kill(-s.proc.pid,"SIGKILL"); } catch { try { s.proc.kill("SIGKILL"); } catch {} }
    }
    sessions.delete(session);
    return text(`세션 ${session} 종료`);
  });

  function openSession(sh, dir) {
    const id = "t" + crypto.randomBytes(3).toString("hex");
    const sessionOpts={cwd:dir,env:childProcessEnv(),...(IS_WIN?{}:{detached:true})};
    const proc = sh === "bash"
      ? spawn("bash", [], sessionOpts)
      : sh === "cmd"
        ? spawn("cmd.exe", ["/Q", "/K"], sessionOpts)
        : spawn("powershell.exe", ["-NoProfile", "-NoLogo", "-Command", "-"], sessionOpts);
    const s = { proc, buf: "", readCursor:0, pendingCommand:null, lastCommand:null, shell: sh, cwd: dir, createdAt: new Date().toISOString() };
    const cap = (chunk) => { s.buf = (s.buf + chunk.toString()).slice(-200_000); };
    proc.stdout.on("data", cap);
    proc.stderr.on("data", cap);
    sessions.set(id, s);
    return id;
  }

  // 명령과 센티널을 "별도의 줄"로 보낸다.
  // - cmd: 같은 줄이면 %errorlevel%이 실행 전에 확장되는 고전 버그 회피
  // - 명령이 끝나야 다음 줄을 읽으므로 순서·종료코드 모두 정확
  async function runInSession(id, command, timeoutMs) {
    const s = sessions.get(id);
    if(!s)throw new Error("세션 "+id+" 없음");
    refreshSessionCommand(s);
    if(s.pendingCommand)throw new Error("세션 "+id+"에서 이전 명령이 아직 실행중이야. exec_stdin으로 상태를 확인하거나 입력을 보내.");
    const token = "WJK_DONE_" + crypto.randomBytes(4).toString("hex");
    const sentinel = s.shell === "cmd"
      ? `echo ${token}_%errorlevel%`
      : s.shell === "powershell"
        ? `echo "${token}_$LASTEXITCODE"`
        : `echo ${token}_$?`;
    const mark = s.buf.length;
    s.readCursor=mark;
    s.pendingCommand={token,mark,startedAt:new Date().toISOString(),command:String(command).slice(0,240)};
    s.proc.stdin.write(command + "\n");
    s.proc.stdin.write(sentinel + "\n");
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      await sleep(150);
      refreshSessionCommand(s);
      if(!s.pendingCommand&&s.lastCommand?.token===token){
        const chunk=cleanSessionOutput(s.buf.slice(mark),token);
        s.readCursor=s.buf.length;
        return (chunk?chunk+"\n":"")+`[exit ${s.lastCommand.exitCode}]`;
      }
    }
    const chunk=cleanSessionOutput(s.buf.slice(mark),token);
    s.readCursor=s.buf.length;
    return (chunk?chunk+"\n":"")+`⏱ ${timeoutMs}ms 안에 안 끝났어. 세션은 계속 살아 있어. exec_stdin{session:"${id}",input:"",raw:true}로 상태와 미전달 출력을 확인하거나 exec_kill로 종료해.`;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
