#!/usr/bin/env node
// webjjonku V2 lifecycle daemon: HTTP MCP + tunnel supervision
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};

const configPath = path.resolve(opt("--config", path.join(ROOT, "webjjonku.config.json")));
const cfg = loadConfig(configPath);
const daemonFile = path.join(cfg.stateDir, "daemon.json");
const tunnelFile = path.join(cfg.stateDir, "tunnel.json");
const logFile = cfg.lifecycle?.logFile
  ? path.resolve(cfg.lifecycle.logFile)
  : path.join(cfg.stateDir, "lifecycle.log");
const restartDelay = Math.max(500, Number(cfg.lifecycle?.restartDelayMs || 2000));
const children = new Map();
let stopping = false;

fs.mkdirSync(path.dirname(logFile), { recursive: true });

function log(...parts) {
  const line = `[${new Date().toISOString()}] ${parts.join(" ")}`;
  try { fs.appendFileSync(logFile, line + "\n"); } catch {}
  console.log(line);
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function isExpectedDaemonProcess(pid) {
  if (!isPidAlive(pid)) return false;
  try {
    if (process.platform === "win32") {
      const script = '$p=Get-CimInstance Win32_Process -Filter "ProcessId=' + String(pid) + '" -ErrorAction SilentlyContinue; if($p){$p.CommandLine}';
      const ps = spawnSync("powershell.exe", ["-NoProfile", "-Command", script], {
        encoding: "utf8", timeout: 5000, windowsHide: true
      });
      const cmd = String(ps.stdout || "").trim();
      return ps.status === 0 && /(?:^|[\\/])scripts[\\/]daemon\.js(?:\s|$)/i.test(cmd);
    }
    const cmdline = fs.readFileSync("/proc/" + String(pid) + "/cmdline", "utf8").replace(/\0/g, " ");
    return /(?:^|[\\/])scripts[\\/]daemon\.js(?:\s|$)/i.test(cmdline);
  } catch {
    return false;
  }
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

function writeJson(file, value) {
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}
function killTree(proc, force=false) {
  if (!proc?.pid) return;
  if (process.platform === "win32") {
    const args=["/PID",String(proc.pid),"/T"]; if(force)args.push("/F");
    try { spawnSync("taskkill", args, { stdio:"ignore", timeout:10000, windowsHide:true }); } catch {}
    return;
  }
  try { process.kill(-proc.pid, force ? "SIGKILL" : "SIGTERM"); }
  catch { try { proc.kill(force ? "SIGKILL" : "SIGTERM"); } catch {} }
}

const existing = readJson(daemonFile);
if (existing?.pid && existing.pid !== process.pid && isExpectedDaemonProcess(existing.pid)) {
  console.log(`webjjonku daemon already running (pid=${existing.pid})`);
  process.exit(0);
}

function snapshot(extra = {}) {
  const childState = {};
  for (const [name, rec] of children) {
    childState[name] = {
      pid: rec.proc?.pid || null,
      startedAt: rec.startedAt,
      command: rec.command,
      args: rec.args
    };
  }
  writeJson(daemonFile, {
    pid: process.pid,
    startedAt: startedAt,
    updatedAt: new Date().toISOString(),
    configPath,
    children: childState,
    ...extra
  });
}

const startedAt = new Date().toISOString();
snapshot({ status: "starting" });

function wireOutput(name, proc, onLine) {
  for (const stream of [proc.stdout, proc.stderr]) {
    if (!stream) continue;
    let buf = "";
    stream.on("data", (chunk) => {
      buf += chunk.toString();
      const lines = buf.split(/\r?\n/);
      buf = lines.pop() || "";
      for (const line of lines) {
        if (!line) continue;
        log(`[${name}]`, line);
        onLine?.(line);
      }
    });
  }
}

function supervise(name, command, args, opts = {}) {
  const launch = () => {
    if (stopping) return;
    log(`starting ${name}:`, command, ...args);
    const proc = spawn(command, args, {
      cwd: opts.cwd || ROOT,
      env: opts.env || process.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32"
    });
    const rec = { proc, command, args, startedAt: new Date().toISOString() };
    children.set(name, rec);
    snapshot({ status: "running" });
    wireOutput(name, proc, opts.onLine);
    proc.on("error", (err) => log(`${name} spawn error:`, err.message));
    proc.on("close", (code, signal) => {
      children.delete(name);
      snapshot({ status: stopping ? "stopping" : "degraded" });
      log(`${name} exited code=${code} signal=${signal || ""}`);
      if (!stopping && cfg.lifecycle?.restart !== false) {
        setTimeout(launch, restartDelay);
      }
    });
  };
  launch();
}

async function waitForHealth(timeoutMs = 30_000) {
  const host = cfg.http.host === "0.0.0.0" ? "127.0.0.1" : cfg.http.host;
  const url = `http://${host}:${cfg.http.port}/health`;
  const until = Date.now() + timeoutMs;
  while (!stopping && Date.now() < until) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

function hasCommand(cmd) {
  try {
    return spawnSync(cmd, ["--version"], { stdio: "ignore", timeout: 8000 }).status === 0;
  } catch {
    return false;
  }
}

function startHttp() {
  supervise("http", process.execPath, [
    path.join(ROOT, "src", "index.js"),
    "--http",
    "--config",
    configPath
  ]);
}

function startTunnel() {
  const t = cfg.tunnel || {};
  const mode = t.mode || "off";
  if (mode === "off" || mode === "none") {
    writeJson(tunnelFile, { mode: "off", updatedAt: new Date().toISOString() });
    log("tunnel disabled");
    return;
  }
  const bin = t.command || "cloudflared";
  if (!hasCommand(bin)) {
    writeJson(tunnelFile, { mode, ok: false, error: `${bin} not found`, updatedAt: new Date().toISOString() });
    log(`tunnel command not found: ${bin}`);
    return;
  }

  if (mode === "quick") {
    const args = ["tunnel", "--url", `http://127.0.0.1:${cfg.http.port}`, "--no-autoupdate"];
    supervise("tunnel", bin, args, {
      onLine: (line) => {
        const m = line.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
        if (m) {
          writeJson(tunnelFile, {
            mode,
            ok: true,
            publicBaseUrl: m[0],
            mcpUrl: `${m[0]}/mcp/${cfg.http.secretPath}`,
            updatedAt: new Date().toISOString()
          });
        }
      }
    });
    return;
  }

  if (mode === "named") {
    if (!t.name) {
      writeJson(tunnelFile, { mode, ok: false, error: "tunnel.name required", updatedAt: new Date().toISOString() });
      log("named tunnel requires tunnel.name");
      return;
    }
    const args = ["tunnel"];
    if (t.configFile) args.push("--config", path.resolve(t.configFile));
    args.push("run", t.name);
    supervise("tunnel", bin, args);
    writeJson(tunnelFile, {
      mode,
      ok: true,
      name: t.name,
      publicBaseUrl: t.publicBaseUrl || null,
      mcpUrl: t.publicBaseUrl ? `${String(t.publicBaseUrl).replace(/\/$/, "")}/mcp/${cfg.http.secretPath}` : null,
      updatedAt: new Date().toISOString()
    });
    return;
  }

  writeJson(tunnelFile, { mode, ok: false, error: "unsupported tunnel mode", updatedAt: new Date().toISOString() });
  log(`unsupported tunnel mode: ${mode}`);
}

async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  log(`shutdown requested: ${signal}`);
  snapshot({ status: "stopping" });
  for (const [, rec] of children) killTree(rec.proc, false);
  await new Promise((r) => setTimeout(r, 1200));
  for (const [, rec] of children) if (rec.proc.exitCode === null) killTree(rec.proc, true);
  try { fs.unlinkSync(daemonFile); } catch {}
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("uncaughtException", (e) => { log("uncaughtException:", e.stack || e.message); });
process.on("unhandledRejection", (e) => { log("unhandledRejection:", String(e)); });

startHttp();
const healthy = await waitForHealth(Number(cfg.lifecycle?.healthTimeoutMs || 30_000));
if (!healthy) log("HTTP health check did not become ready before timeout; tunnel will still be attempted");
startTunnel();
snapshot({ status: "running", healthReady: healthy });
log(`daemon ready pid=${process.pid}`);
