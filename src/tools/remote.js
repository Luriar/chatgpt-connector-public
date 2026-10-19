// 서버 연결: SSH 원격 실행 + 파일 복사(scp) — 시스템 ssh/scp 클라이언트 사용
import { spawn } from "node:child_process";
import { z } from "zod";
import { assertMutationAllowed, resolveInRoots, assertSafeKey } from "../security.js";
import { text } from "../toolkit.js";

export function registerRemoteTools(reg, ctx) {
  const { cfg, store } = ctx;

  const remoteOf = (name) => {
    name=assertSafeKey(name,"remote name");const r = store.data.remotes[name] || cfg.remotes[name];
    if (!r) throw new Error(`원격 '${name}' 미등록. remote_register 먼저. (등록 목록: remote_list)`);
    return r;
  };

  const sshBase = (r) => {
    const args = ["-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=accept-new", "-o", "ConnectTimeout=10"];
    if (r.port) args.push("-p", String(r.port));
    if (r.keyFile) args.push("-i", r.keyFile);
    args.push(`${r.user}@${r.host}`);
    return args;
  };

  reg("remote_register", {
    description: "SSH 원격 서버 등록(예: Oracle 프리티어 VPS). 키 파일 경로는 로컬 절대경로.",
    inputSchema: {
      name: z.string(),
      host: z.string(),
      user: z.string(),
      port: z.number().int().optional(),
      keyFile: z.string().optional().describe("개인키 경로(비밀번호 방식은 미지원 — 키 등록 추천)")
    }
  }, async ({ name, host, user, port, keyFile }) => {
    name=assertSafeKey(name,"remote name");store.data.remotes[name] = { host, user, port: port || null, keyFile: keyFile || null };
    store.save();
    return text(`등록됨: ${name} = ${user}@${host}${port ? ":" + port : ""}\n연결 테스트: ssh_exec{remote:"${name}", command:"echo ok && uname -a"}`);
  });

  reg("remote_list", {
    description: "등록된 원격 서버 목록",
    inputSchema: {}
  }, async () => {
    const all = { ...cfg.remotes, ...store.data.remotes };
    if (!Object.keys(all).length) return text("등록된 원격 없음. remote_register로 등록해.");
    return text(Object.entries(all).map(([k, v]) => `${k} → ${v.user}@${v.host}${v.port ? ":" + v.port : ""}${v.keyFile ? " (key)" : ""}`).join("\n"));
  });

  reg("ssh_exec", {
    description: "원격 서버에서 명령 실행(SSH). 배포·서버 로그 확인·원격 웹쫀쿠 조작 등.",
    inputSchema: {
      remote: z.string().describe("remote_register로 등록한 이름"),
      command: z.string(),
      timeout_ms: z.number().int().min(1000).max(600_000).optional()
    }
  }, async ({ remote, command, timeout_ms = 60_000 }) => {
    assertMutationAllowed(cfg, "원격 명령");
    const r = remoteOf(remote);
    const out = await run("ssh", [...sshBase(r), command], timeout_ms);
    return text(`[${remote}] $ ${command}\n${out}`);
  });

  reg("remote_copy", {
    description: "로컬↔원격 파일 복사(scp). direction: push(로컬→원격) | pull(원격→로컬)",
    inputSchema: {
      remote: z.string(),
      direction: z.enum(["push", "pull"]),
      local_path: z.string(),
      remote_path: z.string(),
      timeout_ms: z.number().int().max(600_000).optional()
    }
  }, async ({ remote, direction, local_path, remote_path, timeout_ms = 120_000 }) => {
    assertMutationAllowed(cfg, "파일 전송");
    const r = remoteOf(remote);
    const local = resolveInRoots(cfg, local_path, { forWrite: direction === "pull" });
    const args = ["-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=accept-new", "-r"];
    if (r.port) args.push("-P", String(r.port));
    if (r.keyFile) args.push("-i", r.keyFile);
    const remoteSpec = `${r.user}@${r.host}:${remote_path}`;
    if (direction === "push") args.push(local, remoteSpec);
    else args.push(remoteSpec, local);
    const out = await run("scp", args, timeout_ms);
    return text(`scp ${direction} 완료\n${out || "(출력 없음)"}`);
  });

  function run(cmd, args, timeoutMs) {
    return new Promise((resolve, reject) => {
      const proc = spawn(cmd, args);
      let out = "";
      const cap = (d) => { out = (out + d.toString()).slice(-100_000); };
      proc.stdout.on("data", cap);
      proc.stderr.on("data", cap);
      let done = false;
      const timer = setTimeout(() => {
        if (done) return; done = true;
        try { proc.kill("SIGKILL"); } catch {}
        resolve(`⏱ 타임아웃(${timeoutMs}ms)\n${out}`);
      }, timeoutMs);
      proc.on("close", (code) => { if (done) return; done = true; clearTimeout(timer); resolve(out + (code ? `\n[exit ${code}]` : "")); });
      proc.on("error", (e) => { if (done) return; done = true; clearTimeout(timer); reject(new Error(`${cmd} 실행 실패: ${e.message} (ssh 클라이언트 설치 필요 — Windows 10+ 기본 내장)`)); });
    });
  }
}
