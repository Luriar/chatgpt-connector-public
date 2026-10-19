#!/usr/bin/env node
// 웹쫀쿠 🍪 — ChatGPT 웹을 Codex/Claude Code급 에이전트로 만드는 로컬 MCP 브리지
// 실행: node src/index.js --stdio        (로컬 테스트·다른 MCP 클라이언트용)
//       node src/index.js --http         (ChatGPT 커스텀 커넥터용, 터널과 함께)
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { createSessionIdleReaper } from "./http-session-idle.js";

import { loadConfig, configSummary } from "./config.js";
import { Store, Journal } from "./state.js";
import { makeRegistrar } from "./toolkit.js";
import { registerFsTools } from "./tools/fs.js";
import { registerExecTools } from "./tools/exec.js";
import { registerLogTools } from "./tools/logs.js";
import { registerDbTools } from "./tools/db.js";
import { registerGoalTools } from "./tools/goal.js";
import { registerWorkerTools } from "./tools/workers.js";
import { registerCodexTools } from "./tools/codex.js";
import { registerDesktopTools } from "./tools/desktop.js";
import { registerRemoteTools } from "./tools/remote.js";
import { registerSandboxTools } from "./tools/sandbox.js";
import { registerHarnessTools } from "./tools/harness.js";
import { registerSkillTools } from "./tools/skills.js";
import { registerPolicyTools } from "./tools/policy.js";
import { registerSchedulerTools } from "./tools/scheduler.js";
import { registerLifecycleTools } from "./tools/lifecycle.js";
import { registerNasQuietTools } from "./tools/nas-quiet.js";
import { registerBrowserTools } from "./tools/browser.js";
import { registerDocumentTools } from "./tools/documents.js";
import { registerApprovalTools } from "./tools/approval.js";
import { registerSaasTools } from "./tools/saas.js";
import { registerSecureExecTools } from "./tools/secure-exec.js";
import { registerTunnelTools } from "./tools/tunnel.js";
import { registerVmTools } from "./tools/vm.js";
import { registerCredentialTools } from "./credentials.js";
import { registerOAuthTools } from "./tools/oauth.js";
import { registerTaskTools } from "./tools/tasks.js";
import { registerCoordinatorTools } from "./tools/coordinator.js";
import { registerComputerUiaTools } from "./tools/computer-uia.js";
import { registerProjectTools } from "./tools/projects.js";
import { registerOfficeLiveTools } from "./tools/office-live.js";
import { registerCloudBrowserTools } from "./tools/cloud-browser.js";
import { registerWorkSyncTools } from "./tools/work-sync.js";
import { registerWorkAutomationTools } from "./tools/work-automations.js";
import { registerSiteTools, siteLookup } from "./tools/sites.js";
import { registerWorkFacadeTools } from "./tools/work-facade.js";
import { registerUiWatchdogTools } from "./tools/ui-watchdog.js";
import { registerResourceLockTools } from "./tools/resource-locks.js";
import { registerDelegationTools } from "./tools/delegation.js";
import { releaseSessionResources } from "./resource-locks.js";
import { registerImageDeliveryUi } from "./ui/image-delivery.js";
import { artifactDeliveryHeaders } from "./artifact-download.js";
import { makeWorkspaceAwareConfig } from "./workspaces.js";
import { registerWorkspaceTools } from "./tools/workspaces.js";
import { registerDiagnosticsTools } from "./tools/diagnostics.js";
import { TransportTelemetry, classifyHttpPath } from "./transport-telemetry.js";

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};

const cfg = loadConfig(opt("--config"));
const store = new Store(cfg);
const journal = new Journal(cfg);
const ctx = { cfg, store, journal, transportTelemetry:null };

function buildServer(sessionRef={id:null,scoped:false}) {
  const server = new McpServer({ name: "webjjonku", version: cfg.version });
  const serverCtx = { ...ctx, sessionRef, baseCfg:cfg };
  serverCtx.cfg = makeWorkspaceAwareConfig(cfg,serverCtx);
  const reg = makeRegistrar(server, serverCtx);
  registerHarnessTools(reg, serverCtx);
  registerGoalTools(reg, serverCtx);
  registerWorkspaceTools(reg, serverCtx);
  registerResourceLockTools(reg, serverCtx);
  registerDelegationTools(reg, serverCtx);
  registerFsTools(reg, serverCtx);
  registerExecTools(reg, serverCtx);
  registerLogTools(reg, serverCtx);
  registerDbTools(reg, serverCtx);
  registerWorkerTools(reg, serverCtx);
  registerCodexTools(reg, serverCtx);
  registerDesktopTools(reg, serverCtx);
  registerRemoteTools(reg, serverCtx);
  registerSandboxTools(reg, serverCtx);
  registerSkillTools(reg, serverCtx);
  registerPolicyTools(reg, serverCtx);
  registerSchedulerTools(reg, serverCtx);
  registerLifecycleTools(reg, serverCtx);
  registerNasQuietTools(reg, serverCtx);
  registerBrowserTools(reg, serverCtx);
  registerDocumentTools(reg, serverCtx);
  registerApprovalTools(reg, serverCtx);
  registerSaasTools(reg, serverCtx);
  registerSecureExecTools(reg, serverCtx);
  registerTunnelTools(reg, serverCtx);
  registerVmTools(reg, serverCtx);
  registerCredentialTools(reg, serverCtx);
  registerOAuthTools(reg, serverCtx);
  registerTaskTools(reg, serverCtx);
  registerCoordinatorTools(reg, serverCtx);
  registerDiagnosticsTools(reg, serverCtx);
  registerComputerUiaTools(reg, serverCtx);
  registerProjectTools(reg, serverCtx);
  registerOfficeLiveTools(reg, serverCtx);
  registerCloudBrowserTools(reg, serverCtx);
  registerWorkSyncTools(reg, serverCtx);
  registerWorkAutomationTools(reg, serverCtx);
  registerSiteTools(reg, serverCtx);
  registerWorkFacadeTools(reg, serverCtx);
  registerUiWatchdogTools(reg, serverCtx);
  registerImageDeliveryUi(server);
  return server;
}

const log = (...a) => console.error("[웹쫀쿠]", ...a); // stdio 오염 방지: 로그는 stderr로만
function capabilityEqual(a,b){
  if(!a||!b)return false;
  const x=Buffer.from(String(a)),y=Buffer.from(String(b));
  return x.length===y.length&&crypto.timingSafeEqual(x,y);
}

if (flag("--http")) {
  const host = opt("--host", cfg.http.host);
  const port = Number(opt("--port", cfg.http.port));
  const secret = cfg.http.secretPath;
  const mcpPath = `/mcp/${secret}`;
  const transports = new Map();
  const sessionIdle = createSessionIdleReaper({
    idleMs: Number(process.env.WEBJJONKU_MCP_SESSION_IDLE_MS) || 30 * 60_000,
    sweepMs: Number(process.env.WEBJJONKU_MCP_SESSION_SWEEP_MS) || 60_000,
    onExpire: () => log("MCP idle session expired"),
    onError: (error) => log("MCP idle session cleanup failed:", error.message)
  });
  const telemetry = new TransportTelemetry(cfg);
  ctx.transportTelemetry = telemetry;

  const httpServer = http.createServer(async (req, res) => {
    let trace = null;
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      trace = telemetry.beginRequest(req,res,classifyHttpPath(url.pathname,mcpPath),req.headers["mcp-session-id"]);
      if (url.pathname === "/health") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, name: "webjjonku", version: cfg.version }));
        return;
      }
      const artifactPrefix = "/artifact/";
      if (req.method === "GET" && url.pathname.startsWith(artifactPrefix)) {
        try{store.reload();}catch{}
        const parts = url.pathname.slice(artifactPrefix.length).split("/").map(decodeURIComponent);
        const cap=parts.shift(),artId=parts.shift(),art=store.data.artifacts?.[artId];
        if(!art||!capabilityEqual(cap,art.previewCapability)){res.writeHead(404).end("artifact not found");return;}
        const revNo = parts[0] ? Number(parts[0]) : null;
        const rev = art && (revNo ? art.revisions?.find(r => r.revision === revNo) : art.revisions?.at(-1));
        if (!rev?.snapshotPath || !fs.existsSync(rev.snapshotPath)) { res.writeHead(404).end("artifact not found"); return; }
        const ext = (rev.extension || "").toLowerCase();
        const mime = {".pdf":"application/pdf",".png":"image/png",".jpg":"image/jpeg",".jpeg":"image/jpeg",".txt":"text/plain; charset=utf-8",".md":"text/markdown; charset=utf-8",".json":"application/json",".xlsx":"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",".docx":"application/vnd.openxmlformats-officedocument.wordprocessingml.document",".pptx":"application/vnd.openxmlformats-officedocument.presentationml.presentation"}[ext] || "application/octet-stream";
        const st=fs.statSync(rev.snapshotPath);const disposition=artifactDeliveryHeaders(art.title || artId,artId,ext,url.searchParams.get("download")==="1");res.writeHead(200,{"content-type":mime,"content-length":st.size,"content-disposition":disposition,"cache-control":"no-store","x-content-type-options":"nosniff","referrer-policy":"no-referrer"});fs.createReadStream(rev.snapshotPath).pipe(res);return;
      }
      const sitePrefix = "/site/";
      if (req.method === "GET" && url.pathname.startsWith(sitePrefix)) {
        try{store.reload();}catch{}
        const raw = url.pathname.slice(sitePrefix.length).split("/").map(x=>decodeURIComponent(x));
        const cap=raw.shift(),siteId=raw.shift(),revSeg=raw.shift()||"current";
        const revision=revSeg==="current"?null:(/^r\d+$/.test(revSeg)?Number(revSeg.slice(1)):(/^\d+$/.test(revSeg)?Number(revSeg):NaN));
        if(!siteId||Number.isNaN(revision)){res.writeHead(400).end("bad site path");return;}
        let rel=raw.join("/")||"index.html";
        const site=store.data.sites?.[siteId];
        if(!site||!capabilityEqual(cap,site.previewCapability)){res.writeHead(404).end("site not found");return;}
        let found=null;
        try{found=siteLookup(ctx,siteId,revision,rel);}catch{}
        if(!found && (req.headers.accept||"").includes("text/html")){
          try{found=siteLookup(ctx,siteId,revision,"index.html");}catch{}
        }
        if(!found){res.writeHead(404).end("site file not found");return;}
        const st=fs.statSync(found.file);
        res.writeHead(200,{
          "content-type":found.mime,
          "content-length":st.size,
          "cache-control":"no-store",
          "x-content-type-options":"nosniff",
          "referrer-policy":"no-referrer",
          "content-security-policy":"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; media-src 'self' data: blob:; font-src 'self' data:; frame-src 'self'; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'self'; navigate-to 'self'",
          "cross-origin-resource-policy":"same-origin",
          "permissions-policy":"camera=(), microphone=(), geolocation=(), payment=(), usb=()"
        });
        fs.createReadStream(found.file).pipe(res);return;
      }
      if (url.pathname !== mcpPath) {
        res.writeHead(404).end("not found");
        return;
      }
      let body;
      if (req.method === "POST") {
        body = await readJson(req);
      }
      const sid = req.headers["mcp-session-id"];
      let transport = sid && transports.get(sid);
      if (sid && sessionIdle.isClosing(sid)) transport = undefined;
      if (!transport) {
        if (req.method === "POST" && isInitializeRequest(body)) {
          const sessionRef={id:null,scoped:true};
          transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => crypto.randomUUID(),
            enableJsonResponse: process.env.WEBJJONKU_MCP_JSON_RESPONSE==="1",
            onsessioninitialized: (id) => { sessionRef.id=id; transports.set(id, transport); sessionIdle.register(id, transport); telemetry.sessionEvent("mcp_session_initialized",id,trace); }
          });
          transport.onclose = () => {
            if (sessionRef.id) {
              telemetry.sessionEvent("mcp_session_close",sessionRef.id);
              if (transports.get(sessionRef.id) === transport) transports.delete(sessionRef.id);
              sessionIdle.unregister(sessionRef.id, transport);
              try { releaseSessionResources({ ...ctx, sessionRef },sessionRef.id); } catch {}
            }
          };
          const server = buildServer(sessionRef);
          await server.connect(transport);
        } else {
          const staleSession=typeof sid==="string"&&sid.length>0;
          const status=staleSession?404:400;
          const code=staleSession?-32001:-32000;
          const message=staleSession?"Session not found":"세션 없음: initialize 먼저";
          res.writeHead(status, { "content-type": "application/json" });
          res.end(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }));
          return;
        }
      }
      // Protect active tools and SSE streams; a closed GET does not imply MCP DELETE.
      if (sid) sessionIdle.trackRequest(sid, req, res);
      trace?.mark("mcp_handle_start");
      await transport.handleRequest(req, res, body);
      trace?.mark("mcp_handle_done");
    } catch (e) {
      trace?.handlerError(e);
      log("HTTP 오류:", e.message);
      if (!res.headersSent) res.writeHead(500).end("internal error");
    }
  });

  telemetry.attachServer(httpServer);
  const keepAliveMs=Math.max(5000,Number(process.env.WEBJJONKU_HTTP_KEEPALIVE_MS||75000));
  httpServer.keepAliveTimeout=keepAliveMs;
  httpServer.headersTimeout=Math.max(httpServer.headersTimeout,keepAliveMs+5000);

  httpServer.listen(port, host, () => {
    log("──────────────────────────────────────────────");
    log(`HTTP 모드 기동: http://${host}:${port}/mcp/<secret>`);
    log(`헬스체크:      http://${host}:${port}/health`);
    log("");
    log("ChatGPT 연결 방법: 터널로 위 URL을 공개한 뒤,");
    log("ChatGPT 설정 → 앱/커넥터 → Developer mode → 커스텀 커넥터로 등록");
    log("(경로의 시크릿이 비밀번호 역할 — URL 전체를 비밀로 취급!)");
    log("──────────────────────────────────────────────");
    log(configSummary(cfg));
  });
} else {
  // 기본: stdio 모드
  const sessionRef={id:"stdio-"+process.pid,scoped:false};
  const server = buildServer(sessionRef);
  const transport = new StdioServerTransport();
  transport.onclose = () => { try { releaseSessionResources({ ...ctx, sessionRef },sessionRef.id); } catch {} };
  await server.connect(transport);
  log(`stdio 모드 기동 · ${configSummary(cfg).split("\n")[0]}`);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > 20 * 1024 * 1024) reject(new Error("body too large"));
    });
    req.on("end", () => {
      if (!data) return resolve(undefined);
      try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
    });
    req.on("error", reject);
  });
}
