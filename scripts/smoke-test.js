#!/usr/bin/env node
// 웹쫀쿠 스모크 테스트 — ChatGPT 없이 전 도구 검증 (구독 전에 돌려보는 용도)
// 사용: npm test  (= node scripts/smoke-test.js)
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";
import ExcelJS from "exceljs";
import JSZip from "jszip";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// 테스트는 OS 임시폴더에서(패키지 폴더 오염 방지 + SQLite 파일잠금 보장)
const TESTDIR = fs.mkdtempSync(path.join(os.tmpdir(), "wjk-test-"));
fs.writeFileSync(path.join(TESTDIR, "webjjonku.config.json"), JSON.stringify({ roots: [TESTDIR], workers: { max: 8, queueMax: 32, minFreeMemoryMB: 0, maxLoadPerCpu: 32 }, saas: { allowPrivateNetwork: true }, permissions: { default: "allow", actions: { "schedule.run": "ask" } } }, null, 2));
const DBFILE = path.join(TESTDIR, "test.db").replace(/\\/g, "/");
const TESTENV = { ...process.env };
for (const k of Object.keys(TESTENV)) if (k.startsWith("WEBJJONKU_")) delete TESTENV[k];

const results = [];
let client;

async function call(name, args = {}) {
  const r = await client.callTool({ name, arguments: args });
  const t = r.content?.find((c) => c.type === "text")?.text || "";
  return { isError: !!r.isError, text: t, content: r.content };
}

async function check(label, fn) {
  try {
    const out = await fn();
    if (out === false) throw new Error("검증 실패");
    results.push({ label, ok: true });
    console.log(`  ✅ ${label}`);
  } catch (e) {
    results.push({ label, ok: false, err: String(e.message || e).slice(0, 200) });
    console.log(`  ❌ ${label} — ${String(e.message || e).slice(0, 200)}`);
  }
}

console.log("🍪 웹쫀쿠 스모크 테스트 시작\n");

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(ROOT, "src", "index.js"), "--stdio", "--config", path.join(TESTDIR, "webjjonku.config.json")],
  cwd: TESTDIR,
  env: TESTENV
});
client = new Client({ name: "webjjonku-test", version: "1.0.0" });
await client.connect(transport);

// 0. 도구 목록
await check("도구 목록(listTools) 90개 이상", async () => {
  const { tools } = await client.listTools();
  console.log(`     → ${tools.length}개 도구 노출`);
  return tools.length >= 90;
});

// 1. 하네스
await check("webjjonku_bootstrap", async () => (await call("webjjonku_bootstrap")).text.includes("부트스트랩"));
await check("webjjonku_help", async () => (await call("webjjonku_help")).text.includes("기능 지도"));
await check("harness_set + harness_get", async () => {
  await call("harness_set", { name: "AGENTS.md", content: "# 테스트 규칙\n- 한국어로 답한다" });
  return (await call("harness_get", { name: "AGENTS.md" })).text.includes("테스트 규칙");
});
await check("V2 skill_list + skill_match + skill_get", async () => {
  const list = await call("skill_list");
  const match = await call("skill_match", { query: "coding repository test" });
  const get = await call("skill_get", { name: "coding-agent" });
  return list.text.includes("coding-agent") && match.text.includes("coding-agent") && get.text.includes("# Coding Agent");
});
await check("V2 policy_status + policy_check", async () => {
  const status = await call("policy_status");
  const check = await call("policy_check", { action: "exec.command" });
  return status.text.includes("default") && check.text.includes("allow");
});

// 2. 파일
await check("fs_write + fs_read", async () => {
  await call("fs_write", { path: "hello.txt", content: "안녕 웹쫀쿠\nline2\nline3" });
  return (await call("fs_read", { path: "hello.txt" })).text.includes("안녕 웹쫀쿠");
});
await check("fs_edit(정밀 치환)", async () => {
  await call("fs_edit", { path: "hello.txt", old_string: "line2", new_string: "수정된 줄" });
  return (await call("fs_read", { path: "hello.txt" })).text.includes("수정된 줄");
});
await check("fs_apply_patch(유니파이드 디프)", async () => {
  const patch = ["--- a/hello.txt", "+++ b/hello.txt", "@@ -1,3 +1,4 @@", " 안녕 웹쫀쿠", " 수정된 줄", "-line3", "+패치된 줄", "+추가된 줄"].join("\n");
  const r = await call("fs_apply_patch", { patch });
  const body = (await call("fs_read", { path: "hello.txt" })).text;
  return !r.isError && body.includes("패치된 줄") && body.includes("추가된 줄");
});
await check("fs_apply_patch(새 파일 생성)", async () => {
  const patch = ["--- /dev/null", "+++ b/newfile.js", "@@ -0,0 +1,2 @@", "+// 새 파일", "+console.log('hi');"].join("\n");
  await call("fs_apply_patch", { patch });
  return (await call("fs_read", { path: "newfile.js" })).text.includes("새 파일");
});
await check("fs_find(내용 검색)", async () => (await call("fs_find", { query: "패치된", glob: "**/*.txt" })).text.includes("hello.txt"));
await check("fs_ls", async () => (await call("fs_ls", {})).text.includes("hello.txt"));
await check("승인 루트 밖 접근 차단", async () => {
  const r = await call("fs_read", { path: process.platform === "win32" ? "C:\\Windows\\win.ini" : "/etc/hostname" });
  return r.isError && r.text.includes("승인");
});

// 3. 실행
await check("exec_command(원샷)", async () => {
  const r = await call("exec_command", { command: "echo jjonku-test-123" });
  return r.text.includes("jjonku-test-123") && r.text.includes("exit 0");
});
await check("exec_command(세션) + exec_stdin + exec_kill", async () => {
  const r = await call("exec_command", { command: "echo session-start", session: true });
  const id = r.text.match(/세션 (t[0-9a-f]+)/)?.[1];
  if (!id || !r.text.includes("session-start")) return false;
  const r2 = await call("exec_stdin", { session: id, input: "echo from-stdin", wait_ms: 1500 });
  const ok = r2.text.includes("from-stdin");
  await call("exec_kill", { session: id });
  return ok;
});

// 4. goal + effort
await check("goal_set → 진행상태 주입 → step_done → finish", async () => {
  await call("goal_set", { title: "테스트 목표", steps: ["1단계", "2단계"], done_criteria: "둘 다 완료" });
  const mid = await call("fs_ls", {}); // goal 활성 중엔 모든 응답에 상태 주입돼야 함
  if (!mid.text.includes("웹쫀쿠 goal")) return false;
  await call("goal_step_done", { note: "됨" });
  await call("goal_step_done", { note: "됨" });
  const fin = await call("goal_finish", { summary: "전부 완료, 검증됨" });
  return fin.text.includes("🏁");
});
await check("effort_set", async () => (await call("effort_set", { level: "high" })).text.includes("effort=high"));

// 5. 세션 메모리
await check("session_save + compact + recall", async () => {
  await call("session_save", { note: "중요한 결정: ESM 사용" });
  const c = await call("session_compact", { extra: "테스트 진행 중" });
  if (!c.text.includes("핸드오프 저장")) return false;
  const r = await call("session_recall", {});
  return r.text.includes("중요한 결정") && r.text.includes("테스트 진행 중");
});

// 6. 로그
await check("logs_tail(journal)", async () => (await call("logs_tail", { source: "journal", lines: 50 })).text.includes("fs_write"));
await check("logs_tail(파일 + grep)", async () => {
  fs.writeFileSync(path.join(TESTDIR, "app.log"), Array.from({ length: 300 }, (_, i) => `line ${i} ${i % 7 === 0 ? "ERROR boom" : "info ok"}`).join("\n"));
  const r = await call("logs_tail", { source: "app.log", lines: 300, grep: "ERROR" });
  return r.text.includes("ERROR boom") && !r.text.split("\n").slice(1).some((l) => l.includes("info ok"));
});

// 7. DB (SQLite — node:sqlite 또는 better-sqlite3)
await check("db_connect + db_query + db_schema (sqlite)", async () => {
  const reg = await call("db_connect", { name: "t", url: `sqlite:${DBFILE}` });
  if (reg.isError) return false;
  const w = await call("db_query", { connection: "t", query: "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)", allow_write: true });
  if (w.isError && w.text.includes("드라이버")) { console.log("     → SQLite 드라이버 없음(환경 이슈) — 안내 메시지 정상 출력 확인"); return w.text.includes("npm i"); }
  await call("db_query", { connection: "t", query: "INSERT INTO users (name) VALUES ('쫀쿠'),('두바이')", allow_write: true });
  const r = await call("db_query", { connection: "t", query: "SELECT * FROM users ORDER BY id" });
  const s = await call("db_schema", { connection: "t" });
  return r.text.includes("쫀쿠") && s.text.includes("users");
});
await check("db 읽기전용 가드(쓰기 차단)", async () => {
  const r = await call("db_query", { connection: "t", query: "DELETE FROM users" });
  return r.isError || r.text.includes("차단");
});
await check("db 미설치 드라이버 안내(postgres)", async () => {
  const r = await call("db_query", { connection: "postgres://u:p@localhost:5/x", query: "SELECT 1" });
  return r.text.includes("npm i pg") || r.text.includes("연결") || r.isError;
});

// 8. 워커(병렬)
await check("worker_spawn(exec) 2개 병렬 + result", async () => {
  const isWin = process.platform === "win32";
  const sleepCmd = isWin ? "Start-Sleep -Milliseconds 500; echo done-A" : "sleep 0.5 && echo done-A";
  const sleepCmd2 = isWin ? "Start-Sleep -Milliseconds 500; echo done-B" : "sleep 0.5 && echo done-B";
  const a = await call("worker_spawn", { task: "A작업", commands: [sleepCmd] });
  const b = await call("worker_spawn", { task: "B작업", commands: [sleepCmd2] });
  const idA = a.text.match(/워커 (w(?:n|w)?[0-9a-f]+)/)?.[1];
  const idB = b.text.match(/워커 (w(?:n|w)?[0-9a-f]+)/)?.[1];
  if (!idA || !idB) return false;
  for (let i = 0; i < 20; i++) {
    const ra = await call("worker_result", { id: idA });
    const rb = await call("worker_result", { id: idB });
    if (ra.text.includes("done-A") && rb.text.includes("done-B")) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
});
await check("워커 컨텍스트 패킷 생성 확인", async () => {
  const dirs = fs.readdirSync(path.join(TESTDIR, ".webjjonku", "workers"));
  if (!dirs.length) return false;
  const ctx = fs.readFileSync(path.join(TESTDIR, ".webjjonku", "workers", dirs[0], "context.md"), "utf8");
  return ctx.includes("컨텍스트 패킷");
});

// 9. Codex 브리지 (미설치 상태 동작 확인)
await check("codex_status(미설치 안내 또는 설치 감지)", async () => {
  const r = await call("codex_status");
  return r.text.includes("Codex CLI");
});
await check("codex_delegate 대기열 적재", async () => {
  const r = await call("codex_delegate", { task: "테스트 태스크", queue_if_missing: true });
  return r.text.includes("대기열") || r.text.includes("codex exit");
});
await check("codex_queue 목록", async () => !((await call("codex_queue")).isError));

// 10. 데스크톱(플랫폼별)
await check("desktop_* 플랫폼 가드", async () => {
  const r = await call("desktop_windows");
  return process.platform === "win32" ? !r.isError : r.isError && r.text.includes("Windows");
});

// 11. 원격/샌드박스 상태
await check("remote_register + remote_list", async () => {
  await call("remote_register", { name: "test-vps", host: "203.0.113.1", user: "ubuntu" });
  return (await call("remote_list")).text.includes("test-vps");
});
await check("sandbox_status", async () => (await call("sandbox_status")).text.length > 0);

// 12. V2 scheduler/lifecycle
await check("schedule approval one-shot + run_now + remove", async () => {
  const marker = path.join(TESTDIR, "scheduled.txt");
  const cmd = process.platform === "win32" ? `Set-Content -Path "${marker}" -Value scheduled` : `printf scheduled > "${marker}"`;
  const add = await call("schedule_add", { name: "smoke", command: cmd, every_minutes: 60 });
  const id = add.text.match(/(s[0-9a-f]+)/)?.[1];
  if (!id) return false;
  const blocked = await call("schedule_run_now", { id });
  if (!blocked.isError || !blocked.text.includes("승인")) return false;
  const req = await call("approval_request", { action: "schedule.run", reason: "smoke test" });
  const aid = req.text.match(/(a[0-9a-f]+)/)?.[1];
  if (!aid) return false;
  await call("approval_grant", { id: aid });
  const run = await call("schedule_run_now", { id });
  if (run.isError) return false;
  await new Promise((r) => setTimeout(r, 1200));
  const ok = fs.existsSync(marker) && fs.readFileSync(marker, "utf8").includes("scheduled");
  const blockedAgain = await call("schedule_run_now", { id });
  await call("schedule_remove", { id });
  return ok && blockedAgain.isError && blockedAgain.text.includes("승인");
});
await check("lifecycle_status", async () => !((await call("lifecycle_status")).isError));

// 13. V2 browser E2E
await check("browser DOM open/read/type/click/screenshot", async () => {
  const status = await call("browser_status");
  const clean = status.text.split("\n\n───")[0];
  const parsed = JSON.parse(clean);
  if (!parsed.available) {
    console.log("     → Chrome/Edge 미탐지: 상태 진단까지만 확인");
    return status.text.includes("available");
  }
  const html = '<html><body><input id="x"><button id="b" onclick="document.getElementById(&quot;out&quot;).textContent=document.getElementById(&quot;x&quot;).value">go</button><div id="out"></div></body></html>';
  const opened = await call("browser_open", { url: "data:text/html," + encodeURIComponent(html) });
  const id = opened.text.match(/(p[a-z0-9]+)/i)?.[1];
  if (!id) return false;
  await call("browser_type", { page: id, selector: "#x", value: "browser-ok" });
  await call("browser_click", { page: id, selector: "#b" });
  const read = await call("browser_read", { page: id });
  const shot = path.join(TESTDIR, "browser.png");
  await call("browser_screenshot", { page: id, path: shot });
  await call("browser_close", { all: true });
  return read.text.includes("browser-ok") && fs.existsSync(shot);
});

// 14. V2 document-native E2E
await check("XLSX read/write range", async () => {
  const p = path.join(TESTDIR, "sample.xlsx");
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Sheet1");
  ws.getCell("A1").value = "hello";
  ws.getCell("B1").value = 1;
  await wb.xlsx.writeFile(p);
  const before = await call("excel_read_range", { path: p, sheet: "Sheet1", range: "A1:B1" });
  await call("excel_write_range", { path: p, sheet: "Sheet1", start: "B2", values: [["written"]] });
  const after = await call("excel_read_range", { path: p, sheet: "Sheet1", range: "B2:B2" });
  return before.text.includes("hello") && after.text.includes("written");
});

await check("DOCX/PPTX extract + replace", async () => {
  const docx = path.join(TESTDIR, "sample.docx");
  const zd = new JSZip();
  zd.file("word/document.xml", '<w:document xmlns:w="x"><w:body><w:p><w:r><w:t>HelloDoc</w:t></w:r></w:p></w:body></w:document>');
  fs.writeFileSync(docx, await zd.generateAsync({ type: "nodebuffer" }));
  const d1 = await call("office_extract_text", { path: docx });
  const docx2 = path.join(TESTDIR, "sample2.docx");
  await call("office_replace_text", { path: docx, find: "HelloDoc", replace: "ByeDoc", output: docx2 });
  const d2 = await call("office_extract_text", { path: docx2 });

  const pptx = path.join(TESTDIR, "sample.pptx");
  const zp = new JSZip();
  zp.file("ppt/slides/slide1.xml", '<p:sld xmlns:p="p" xmlns:a="a"><a:t>HelloSlide</a:t></p:sld>');
  fs.writeFileSync(pptx, await zp.generateAsync({ type: "nodebuffer" }));
  const p1 = await call("office_extract_text", { path: pptx });
  const pptx2 = path.join(TESTDIR, "sample2.pptx");
  await call("office_replace_text", { path: pptx, find: "HelloSlide", replace: "ByeSlide", output: pptx2 });
  const p2 = await call("office_extract_text", { path: pptx2 });
  return d1.text.includes("HelloDoc") && d2.text.includes("ByeDoc") && p1.text.includes("HelloSlide") && p2.text.includes("ByeSlide");
});

await check("PDF create + extract", async () => {
  const p = path.join(TESTDIR, "sample.pdf");
  const c = await call("pdf_create_text", { path: p, text: "pdf-test-hello" });
  if (c.isError) return false;
  const r = await call("pdf_extract_text", { path: p });
  return r.text.includes("pdf-test-hello");
});

// 15. Advanced scheduler
await check("schedule_add_at one-shot", async () => {
  const marker = path.join(TESTDIR, "scheduled-at.txt");
  const cmd = process.platform === "win32"
    ? 'Set-Content -Path "' + marker + '" -Value once'
    : 'printf once > "' + marker + '"';
  const at = new Date(Date.now() + 1800).toISOString();
  const add = await call("schedule_add_at", { name: "once", command: cmd, at: at });
  const id = add.text.match(/(s[0-9a-f]+)/)?.[1];
  if (!id) return false;
  // Slow hosts may start the command after the timer's scheduled instant.
  // Wait for observable completion within a bound instead of assuming 3.2s.
  const deadline=Date.now()+12000;
  while(!fs.existsSync(marker)&&Date.now()<deadline)await new Promise(r=>setTimeout(r,100));
  const ok = fs.existsSync(marker) && fs.readFileSync(marker, "utf8").includes("once");
  await call("schedule_remove", { id: id });
  return ok;
});

// 16. SaaS connector against local HTTP API
await check("SaaS register + REST request", async () => {
  const srv = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, path: req.url }));
  });
  await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve));
  const port = srv.address().port;
  try {
    const reg = await call("saas_register", { name: "local-api", base_url: "http://127.0.0.1:" + port, token_env: "UNUSED", auth: "none" });
    if (reg.isError) return false;
    const req = await call("saas_request", { connection: "local-api", path: "/ping", query: { a: 1 } });
    return req.text.includes('"ok": true') && req.text.includes("/ping?a=1");
  } finally {
    await new Promise((resolve) => srv.close(resolve));
  }
});

await check("tunnel_validate_named diagnostics", async () => {
  const r = await call("tunnel_validate_named", { name: "nonexistent-smoke-test" });
  return !r.isError && r.text.includes("cloudflared");
});

// ── 결과 ──
const pass = results.filter((r) => r.ok).length;
console.log(`\n════════════════════════════`);
console.log(`결과: ${pass}/${results.length} 통과`);
if (pass < results.length) {
  console.log("실패 항목:");
  for (const r of results.filter((x) => !x.ok)) console.log(`  - ${r.label}: ${r.err}`);
}
try { fs.rmSync(TESTDIR, { recursive: true, force: true }); } catch {}
await client.close();
process.exit(pass === results.length ? 0 : 1);
