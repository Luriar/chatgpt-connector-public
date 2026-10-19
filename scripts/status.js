#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const i = argv.indexOf("--config");
const configPath = path.resolve(i >= 0 && argv[i + 1] ? argv[i + 1] : path.join(ROOT, "webjjonku.config.json"));
const profileIndex = argv.indexOf('--profile');
if (profileIndex >= 0) {
  const profile = argv[profileIndex + 1];
  if (!['nas','windows'].includes(profile)) throw new Error('--profile requires nas or windows');
  process.env.WEBJJONKU_RUNTIME_PROFILE = profile;
} else if (!process.env.WEBJJONKU_RUNTIME_PROFILE && process.platform === 'win32') {
  const runtimePath = path.join(ROOT, '.webjjonku', 'nas-runtime.json');
  try {
    const runtime = JSON.parse(fs.readFileSync(runtimePath, 'utf8').replace(/^\uFEFF/, ''));
    if (runtime?.enabled === true) process.env.WEBJJONKU_RUNTIME_PROFILE = 'windows';
  } catch {}
}
const cfg = loadConfig(configPath);
const daemonFile = path.join(cfg.stateDir, "daemon.json");
const tunnelFile = path.join(cfg.stateDir, "tunnel.json");
const read = (p) => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; } };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const publicTunnel=(v)=>{if(!v)return null;const out={...v};if(out.mcpUrl){try{const u=new URL(out.mcpUrl);out.mcpUrl=u.origin+"/mcp/<hidden>";}catch{out.mcpUrl="<hidden>";}}return out;};

const daemon = read(daemonFile);
const tunnel = read(tunnelFile);
const host = cfg.http.host === "0.0.0.0" ? "127.0.0.1" : cfg.http.host;
let health = null;
try {
  const r = await fetch(`http://${host}:${cfg.http.port}/health`, { signal: AbortSignal.timeout(3000) });
  health = r.ok ? await r.json() : { ok: false, status: r.status };
} catch (e) {
  health = { ok: false, error: e.message };
}

console.log(JSON.stringify({
  profile: cfg.runtimeProfile || "legacy",
  daemon: daemon ? { ...daemon, alive: alive(daemon.pid) } : null,
  health,
  tunnel: publicTunnel(tunnel)
}, null, 2));
