#!/usr/bin/env node
// 터널 헬퍼: cloudflared가 있으면 즉시 공개 URL 발급, 없으면 설치/대안 안내
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const port = process.argv[2] || "8747";
const secretFile = path.join(process.cwd(), ".webjjonku", "http-secret");
const secret = fs.existsSync(secretFile) ? fs.readFileSync(secretFile, "utf8").trim() : "(서버 먼저 실행: npm start)";

const has = (cmd) => {
  try { return spawnSync(cmd, ["--version"], { timeout: 8000 }).status === 0; } catch { return false; }
};

console.log("🍪 웹쫀쿠 터널 헬퍼");
console.log(`   로컬 MCP 엔드포인트: http://127.0.0.1:${port}/mcp/${secret}\n`);

if (has("cloudflared")) {
  console.log("cloudflared 발견 → 임시 공개 터널 여는 중... (아래 https://xxx.trycloudflare.com URL 확인)\n");
  const proc = spawn("cloudflared", ["tunnel", "--url", `http://127.0.0.1:${port}`], { stdio: ["ignore", "inherit", "inherit"] });
  proc.on("close", (c) => process.exit(c ?? 0));
  console.log(`\n👉 ChatGPT 커넥터에 등록할 최종 URL = 터널URL + /mcp/${secret}`);
  console.log("⚠️ URL 전체가 비밀번호야. 절대 공유하지 마. (서버 재시작해도 시크릿은 유지됨)");
} else {
  console.log(`cloudflared가 없어. 두 가지 방법 중 선택:

[방법 1] OpenAI Secure MCP Tunnel (공식, 추천 — 구독 후 사용 가능)
  1) platform.openai.com → Settings → Tunnels 에서 터널 생성
  2) Tunnels: Read/Use 권한만 있는 Restricted API 키 발급
  3) openai/tunnel-client 릴리스 다운로드 후:
     tunnel-client --tunnel <tunnel_id> --target http://127.0.0.1:${port}
  4) ChatGPT → 설정 → 앱 → Developer mode → 커넥터 생성에서 해당 터널 선택

[방법 2] Cloudflare 퀵 터널 (무료, 즉시)
  1) winget install cloudflare.cloudflared  (또는 공식 다운로드 페이지)
  2) 이 스크립트 다시 실행: npm run tunnel
  3) 발급된 https://xxx.trycloudflare.com/mcp/${secret} 를 ChatGPT 커넥터 URL로 등록
`);
}
