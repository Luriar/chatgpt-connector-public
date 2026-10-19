// 샌드박스 실행: Docker 컨테이너(러스트 등 뭐든 설치 가능) → 없으면 WSL 폴백
// docker/wsl은 실제 .exe라 셸 경유 불필요(직접 spawn — 이스케이프 안전)
import { spawnSync, spawn } from "node:child_process";
import { z } from "zod";
import { resolveInRoots, assertMutationAllowed } from "../security.js";
import { text } from "../toolkit.js";

function has(cmd, args = ["--version"]) {
  try {
    const r = spawnSync(cmd, args, { timeout: 8000, encoding: "utf8" });
    return r.status === 0 ? (r.stdout || "").trim().split("\n")[0] : null;
  } catch { return null; }
}
function dockerReady() {
  try {
    const r = spawnSync("docker", ["info", "--format", "{{.ServerVersion}}"], { timeout: 5000, encoding: "utf8" });
    return r.status === 0 ? (r.stdout || "").trim() : null;
  } catch { return null; }
}

export function registerSandboxTools(reg, ctx) {
  const cfg = ctx.cfg;

  reg("sandbox_status", {
    description: "샌드박스 백엔드 확인(Docker/WSL) + 유지 중인 컨테이너 목록",
    inputSchema: {}
  }, async () => {
    const dockerCli = has("docker");
    const docker = dockerCli ? dockerReady() : null;
    const wsl = process.platform === "win32" ? has("wsl", ["--status"]) : null;
    const lines = [
      docker ? `✅ Docker engine: ${docker}` : (dockerCli ? "⚠️ Docker CLI 있음 / 엔진 응답 없음" : "❌ Docker 없음"),
      process.platform === "win32" ? (wsl !== null ? "✅ WSL 사용 가능(폴백)" : "❌ WSL 없음") : "ℹ️ WSL은 Windows 전용 폴백"
    ];
    if (docker) {
      const psOut = spawnSync("docker", ["ps", "--filter", "name=wjk-", "--format", "{{.Names}} {{.Image}} {{.Status}}"], { encoding: "utf8", timeout: 5000 });
      lines.push("유지 컨테이너:\n" + ((psOut.stdout || "").trim() || "(없음)"));
    }
    return text(lines.join("\n"));
  });

  reg("sandbox_exec", {
    description: "격리 샌드박스에서 명령 실행. Docker 컨테이너에 승인 루트를 마운트해 러스트/파이썬 등 뭐든 설치·빌드 가능. persist_name을 주면 컨테이너가 유지되어 설치 상태(예: rustup) 재사용.",
    inputSchema: {
      commands: z.array(z.string()).min(1),
      image: z.string().optional().describe("기본: 설정의 sandbox.defaultImage (rust:1-slim). 예: python:3.12-slim, node:22, ubuntu:24.04"),
      mount: z.string().optional().describe("컨테이너 /work에 마운트할 로컬 폴더(승인 루트 안). 기본: 첫 루트"),
      persist_name: z.string().optional().describe("영문·숫자·하이픈. 주면 wjk-<이름> 컨테이너 유지·재사용"),
      network: z.boolean().optional().describe("기본 true (패키지 설치 위해). false면 네트워크 차단"),
      timeout_ms: z.number().int().min(5000).max(1_800_000).optional().describe("기본 5분")
    }
  }, async ({ commands, image, mount, persist_name, network = true, timeout_ms = 300_000 }) => {
    assertMutationAllowed(cfg, "샌드박스 실행");
    const img = image || cfg.sandbox.defaultImage;
    const hostDir = resolveInRoots(cfg, mount || cfg.roots[0]);
    const script = commands.join(" && ");

    if (has("docker") && dockerReady()) {
      if (persist_name) {
        if (!/^[a-zA-Z0-9-]+$/.test(persist_name)) throw new Error("persist_name은 영문/숫자/하이픈만.");
        const cname = `wjk-${persist_name}`;
        const exists = spawnSync("docker", ["inspect", cname], { encoding: "utf8" }).status === 0;
        if (!exists) {
          const createArgs = ["run", "-d", "--name", cname, "-v", `${hostDir}:/work`, "-w", "/work"];
          if (!network) createArgs.push("--network", "none");
          createArgs.push(img, "sleep", "infinity");
          const c = spawnSync("docker", createArgs, { encoding: "utf8", timeout: 120_000 });
          if (c.status !== 0) throw new Error(`컨테이너 생성 실패: ${c.stderr}`);
        } else {
          spawnSync("docker", ["start", cname], { encoding: "utf8" });
        }
        const out = await runAsync("docker", ["exec", cname, "sh", "-lc", script], timeout_ms);
        return text(`[샌드박스 ${cname} (${img}) · /work=${hostDir}]\n${out}\n\n(컨테이너 유지됨 — 다음 sandbox_exec{persist_name:"${persist_name}"}에서 설치 상태 재사용)`);
      }
      const args = ["run", "--rm", "-v", `${hostDir}:/work`, "-w", "/work"];
      if (!network) args.push("--network", "none");
      args.push(img, "sh", "-lc", script);
      const out = await runAsync("docker", args, timeout_ms);
      return text(`[샌드박스 일회용 (${img}) · /work=${hostDir}]\n${out}`);
    }

    if (process.platform === "win32" && has("wsl", ["--status"])) {
      const out = await runAsync("wsl", ["-e", "bash", "-lc", `cd "$(wslpath '${hostDir.replace(/'/g, "'\\''")}')" && ${script}`], timeout_ms);
      return text(`[WSL 폴백 · ${hostDir}]\n${out}\n\n⚠️ WSL은 완전 격리가 아니야. 제대로 된 샌드박스는 Docker Desktop 설치 추천.`);
    }

    throw new Error("Docker도 WSL도 없어. Docker Desktop(https://docker.com) 설치하면 sandbox_exec가 활성화돼. 급하면 exec_command로 로컬 실행(격리 없음 주의).");
  });

  reg("sandbox_destroy", {
    description: "유지 중인 샌드박스 컨테이너 삭제",
    inputSchema: { persist_name: z.string() }
  }, async ({ persist_name }) => {
    assertMutationAllowed(cfg, "샌드박스 삭제");
    const cname = `wjk-${persist_name}`;
    const r = spawnSync("docker", ["rm", "-f", cname], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(`삭제 실패: ${r.stderr}`);
    return text(`${cname} 삭제됨`);
  });

  function runAsync(cmd, args, timeoutMs) {
    return new Promise((resolve, reject) => {
      const proc = spawn(cmd, args);
      let out = "";
      const cap = (d) => { out = (out + d.toString()).slice(-150_000); };
      proc.stdout.on("data", cap);
      proc.stderr.on("data", cap);
      let done = false;
      const timer = setTimeout(() => {
        if (done) return; done = true;
        try { proc.kill("SIGKILL"); } catch {}
        resolve(`⏱ 타임아웃(${timeoutMs}ms). 부분 출력:\n${out}`);
      }, timeoutMs);
      proc.on("close", (code) => { if (done) return; done = true; clearTimeout(timer); resolve(out + `\n[exit ${code}]`); });
      proc.on("error", (e) => { if (done) return; done = true; clearTimeout(timer); reject(new Error(e.message)); });
    });
  }
}
