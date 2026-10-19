// Codex 브리지: "MCP 서버가 codex 앱 소유 브리지에 작업을 전달하고, codex 앱이 최종 실행"
// = codex exec(비대화형)를 자식 프로세스로 구동. 미설치 시 대기열(codex-queue)에 적재했다가
//   구매/설치 후 codex_process_queue 한 번으로 일괄 실행.
// 프롬프트는 stdin으로 전달("-") → 따옴표/개행 이스케이프 문제 원천 차단.
import { spawnSync, spawn } from "node:child_process";
import crypto from "node:crypto";
import { z } from "zod";
import { resolveInRoots, assertMutationAllowed } from "../security.js";
import { text } from "../toolkit.js";

const IS_WIN = process.platform === "win32";
const EFFORT_MAP = { minimal: "minimal", low: "low", medium: "medium", high: "high", max: "high" };

// Windows에서 npm 전역 codex는 codex.cmd 셔틀이라 셸 경유가 필요하다.
// 셸 경유 시 args 배열 대신 "한 줄 문자열"을 직접 구성한다(DEP0190·이스케이프 문제 방지).
function shSync(cmdline, opts = {}) {
  return spawnSync(cmdline, { shell: true, encoding: "utf8", timeout: 10_000, ...opts });
}

export function codexBin() {
  if (IS_WIN) {
    try {
      const r = shSync("codex --version");
      return r.status === 0 ? "codex" : null;
    } catch { return null; }
  }
  try {
    const r = spawnSync("codex", ["--version"], { timeout: 8000, encoding: "utf8" });
    return r.status === 0 ? "codex" : null;
  } catch { return null; }
}

const q = (s) => `"${String(s).replace(/"/g, "")}"`; // 경로용 인용(윈도 경로에 따옴표는 원래 불가)

/** codex exec 자식 프로세스 생성(프롬프트는 stdin). 미설치면 null */
export function spawnCodex(prompt, cwd, effort, sandbox = "workspace-write") {
  if (!codexBin()) return null;
  const effortVal = EFFORT_MAP[effort] || "medium";
  let proc;
  if (IS_WIN) {
    const cmdline = [
      "codex", "exec",
      "--sandbox", sandbox,
      "-C", q(cwd),
      "-c", q(`model_reasoning_effort=${effortVal}`),
      "--skip-git-repo-check",
      "-"
    ].join(" ");
    proc = spawn(cmdline, { shell: true, cwd });
  } else {
    proc = spawn("codex", [
      "exec", "--sandbox", sandbox, "-C", cwd,
      "-c", `model_reasoning_effort=${effortVal}`,
      "--skip-git-repo-check", "-"
    ], { cwd });
  }
  proc.stdin.write(prompt);
  proc.stdin.end();
  return proc;
}

export function registerCodexTools(reg, ctx) {
  const { cfg, store } = ctx;

  reg("codex_status", {
    description: "Codex CLI 설치/로그인 상태 확인 + 대기열 현황",
    inputSchema: {}
  }, async () => {
    const bin = codexBin();
    const queue = store.data.codexQueue.filter((qq) => qq.status === "queued");
    if (!bin) {
      return text([
        "❌ Codex CLI 미설치 (아직 구매 전이지? 정상이야)",
        "설치(구독 후): `npm i -g @openai/codex` → `codex login` (ChatGPT 계정 로그인)",
        `대기열: ${queue.length}건 — 설치 후 codex_process_queue 호출하면 순서대로 실행돼.`,
        "그동안 실행이 필요한 작업은 exec_command / worker_spawn(kind=exec) / sandbox_exec로 처리 가능."
      ].join("\n"));
    }
    const v = IS_WIN ? shSync("codex --version") : spawnSync("codex", ["--version"], { encoding: "utf8" });
    let login = "확인 불가";
    try {
      const l = IS_WIN ? shSync("codex login status") : spawnSync("codex", ["login", "status"], { encoding: "utf8", timeout: 10_000 });
      login = ((l.stdout || "") + (l.stderr || "")).trim().split("\n")[0] || "확인 불가";
    } catch {}
    return text(`✅ Codex CLI 설치됨: ${(v.stdout || "").trim()}\n로그인: ${login}\n대기열: ${queue.length}건`);
  });

  reg("codex_delegate", {
    description: "태스크를 Codex 앱(CLI)에 위임 — codex가 자체 샌드박스에서 계획·실행·검증까지 수행하는 진짜 서브에이전트. effort가 reasoning effort로 매핑됨. 미설치면 queue_if_missing=true로 대기열 적재.",
    inputSchema: {
      task: z.string().describe("위임할 태스크(맥락 포함해서 자세히)"),
      cwd: z.string().optional(),
      sandbox: z.enum(["read-only", "workspace-write", "danger-full-access"]).optional().describe("기본 workspace-write"),
      timeout_ms: z.number().int().min(10_000).max(1_800_000).optional().describe("기본 10분"),
      queue_if_missing: z.boolean().optional()
    }
  }, async ({ task, cwd, sandbox = "workspace-write", timeout_ms = 600_000, queue_if_missing = false }) => {
    assertMutationAllowed(cfg, "Codex 위임");
    const dir = resolveInRoots(cfg, cwd || cfg.roots[0]);
    if (!codexBin()) {
      if (!queue_if_missing) {
        throw new Error("Codex CLI 미설치. 대기열에 넣으려면 queue_if_missing=true, 지금 실행이 필요하면 worker_spawn(kind=exec)/sandbox_exec 사용.");
      }
      const item = { id: "q" + crypto.randomBytes(3).toString("hex"), task, cwd: dir, effort: store.data.effort, sandbox, queuedAt: new Date().toISOString(), status: "queued" };
      store.data.codexQueue.push(item);
      store.save();
      return text(`📥 Codex 대기열 적재: ${item.id}\n구독+설치 후 codex_process_queue 호출하면 실행돼. (현재 대기 ${store.data.codexQueue.filter((qq) => qq.status === "queued").length}건)`);
    }
    const out = await runCodex(task, dir, store.data.effort, sandbox, timeout_ms);
    return text(out);
  });

  reg("codex_process_queue", {
    description: "대기열에 쌓인 Codex 태스크를 순서대로 실행(설치 후 1회 호출)",
    inputSchema: { max: z.number().int().min(1).max(20).optional() }
  }, async ({ max = 5 }) => {
    assertMutationAllowed(cfg, "Codex 큐 실행");
    if (!codexBin()) throw new Error("Codex CLI가 아직 없어. `npm i -g @openai/codex` 후 다시.");
    const queued = store.data.codexQueue.filter((qq) => qq.status === "queued").slice(0, max);
    if (!queued.length) return text("대기열 비어 있음.");
    const results = [];
    for (const item of queued) {
      item.status = "running"; store.save();
      try {
        const out = await runCodex(item.task, item.cwd, item.effort, item.sandbox, 600_000);
        item.status = "done";
        results.push(`✅ ${item.id}: ${item.task.slice(0, 60)}\n${out.slice(-1500)}`);
      } catch (e) {
        item.status = "failed";
        results.push(`❌ ${item.id}: ${e.message}`);
      }
      store.save();
    }
    return text(results.join("\n\n────────\n\n"));
  });

  reg("codex_queue", {
    description: "Codex 대기열 목록/정리. clear=true면 대기 항목 삭제",
    inputSchema: { clear: z.boolean().optional() }
  }, async ({ clear = false }) => {
    if (clear) {
      store.data.codexQueue = store.data.codexQueue.filter((qq) => qq.status !== "queued");
      store.save();
      return text("대기 항목 삭제됨.");
    }
    const rows = store.data.codexQueue.slice(-30).map((qq) => `${qq.id} [${qq.status}] ${qq.queuedAt.slice(0, 16)} — ${qq.task.slice(0, 80)}`);
    return text(rows.length ? rows.join("\n") : "대기열 비어 있음.");
  });
}

function runCodex(task, cwd, effort, sandbox, timeoutMs) {
  return new Promise((resolve, reject) => {
    const proc = spawnCodex(task, cwd, effort, sandbox);
    if (!proc) return reject(new Error("Codex CLI 미설치"));
    let out = "";
    const cap = (d) => { out = (out + d.toString()).slice(-200_000); };
    proc.stdout.on("data", cap);
    proc.stderr.on("data", cap);
    let done = false;
    const timer = setTimeout(() => {
      if (done) return; done = true;
      try { proc.kill("SIGKILL"); } catch {}
      resolve(`⏱ Codex 타임아웃(${timeoutMs}ms). 부분 출력:\n${out}`);
    }, timeoutMs);
    proc.on("close", (code) => {
      if (done) return; done = true; clearTimeout(timer);
      resolve(`[codex exit ${code} · sandbox=${sandbox} · effort=${EFFORT_MAP[effort] || "medium"}]\n${out}`);
    });
    proc.on("error", (e) => {
      if (done) return; done = true; clearTimeout(timer);
      reject(new Error(`Codex 실행 실패: ${e.message}`));
    });
  });
}
