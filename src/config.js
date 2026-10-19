// 웹쫀쿠 설정 로더
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";

const PACKAGE_VERSION=(()=>{
  try{return JSON.parse(fs.readFileSync(new URL("../package.json",import.meta.url),"utf8")).version||"0.0.0";}
  catch{return "0.0.0";}
})();

const DEFAULTS = {
  serverName: "webjjonku",
  version: PACKAGE_VERSION,
  // 승인된 루트 폴더(절대경로). 비어 있으면 서버를 실행한 폴더 하나만 승인됨.
  roots: [],
  // true면 모든 쓰기/실행/입력 도구가 잠김(읽기 전용 킬스위치)
  readOnly: false,
  db: {
    allowWrite: false, // SELECT 외 쿼리 허용 여부(전역)
    connections: {}    // { name: "postgres://user:pw@host/db" }
  },
  remotes: {},         // { name: { host, user, port, keyFile } }
  workers: { max: 8, queueMax: 32, minFreeMemoryMB: 512, maxLoadPerCpu: 1.5, hosts: { nas: {}, windows: {} } },
  resilience: {
    durableExec: true,
    durableThresholdMs: 20000,
    durableForegroundWaitMs: 2500,
    windowsToolForegroundWaitMs: 4000,
    windowsSubmitTimeoutMs: 8000,
    resultMaxBytes: 65536,
    checkpointIntervalMs: 5000,
    taskCommandTimeoutMs: 1800000,
    taskKillGraceMs: 3000,
    verifyBeforeRetry: true,
    preferDurableForLongWork: true
  },
  effortDefault: "medium", // minimal|low|medium|high|max
  desktop: { enabled: true },
  browser: { enabled: true, headless: true, executablePath: null, allowPrivateNetwork: false, profileRetentionDays: 7 },
  oauth: { allowPrivateNetwork: false },
  saas: { allowPrivateNetwork: false },
  coordinator: { allowPrivateNetwork: false, allowInsecureHttp: false },
  vm: { backend: "wsl2", distro: "webjjonku-vm" },
  exec: { secureImage: "node:22-slim" },
  sandbox: { defaultImage: "rust:1-slim" },
  http: { host: "127.0.0.1", port: 8747, secretPath: null },
  tunnel: { mode: "off", command: "cloudflared", name: null, configFile: null, publicBaseUrl: null },
  lifecycle: { restart: true, restartDelayMs: 2000, healthTimeoutMs: 30000, logFile: null },
  permissions: { default: "allow", actions: {} },
  logs: { sources: {} }, // { name: "/path/to/file.log" }
  redactKeys: ["password", "passwd", "secret", "token", "api_key", "apikey", "authorization", "cookie"],
  sessionRetentionDays: 30
};

function currentWindowsSid(){
  try{
    const who=spawnSync("whoami",["/user","/fo","csv","/nh"],{encoding:"utf8",timeout:5000,windowsHide:true});
    return String(who.stdout||"").match(/"[^"]*","([^"]+)"/)?.[1]||null;
  }catch{return null;}
}
function hardenPathAcl(target,{directory=false}={}){
  if(process.platform!=="win32"){
    try{fs.chmodSync(target,directory?0o700:0o600);return true;}catch{return false;}
  }
  const sid=currentWindowsSid();if(!sid)return false;
  try{
    const own="*"+sid+":"+(directory?"(OI)(CI)(F)":"(F)"),sys="*S-1-5-18:"+(directory?"(OI)(CI)(F)":"(F)");
    const r=spawnSync("icacls",[target,"/inheritance:r","/grant:r",own,"/grant:r",sys],{encoding:"utf8",timeout:10000,windowsHide:true});
    return r.status===0;
  }catch{return false;}
}
function hardenStateDir(dir){hardenPathAcl(dir,{directory:true});}

function deepMerge(base, extra) {
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(extra || {})) {
    if (["__proto__","prototype","constructor"].includes(k)) throw new Error(`금지된 config key: ${k}`);
    if (v && typeof v === "object" && !Array.isArray(v) && base?.[k] && typeof base[k] === "object" && !Array.isArray(base[k])) {
      out[k] = deepMerge(base[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

export function loadConfig(configPath) {
  const profile = process.env.WEBJJONKU_RUNTIME_PROFILE || null;
  if (profile && !['nas','windows'].includes(profile)) throw new Error('Invalid runtime profile');
  const cwd = process.cwd();
  let fileCfg = {};
  const p = configPath || path.join(cwd, "webjjonku.config.json");
  if (fs.existsSync(p)) {
    try {
      fileCfg = JSON.parse(fs.readFileSync(p, "utf8").replace(/^\uFEFF/, ""));
    } catch (e) {
      throw new Error(`설정 파일 파싱 실패 (${p}): ${e.message}`);
    }
  }
  const cfg = deepMerge(DEFAULTS, fileCfg);
  cfg.configPath = p;
  cfg.runtimeProfile = profile;
  const envNumber=(name,min,max)=>{
    if(process.env[name]===undefined||process.env[name]==="")return null;
    const n=Number(process.env[name]);
    return Number.isFinite(n)?Math.max(min,Math.min(max,n)):null;
  };
  const workerMax=envNumber("WEBJJONKU_WORKER_MAX",1,64);
  const workerQueueMax=envNumber("WEBJJONKU_WORKER_QUEUE_MAX",1,1000);
  const workerMinFree=envNumber("WEBJJONKU_WORKER_MIN_FREE_MEMORY_MB",0,1024*1024);
  const workerMaxLoad=envNumber("WEBJJONKU_WORKER_MAX_LOAD_PER_CPU",0.1,32);
  if(workerMax!==null)cfg.workers.max=workerMax;
  if(workerQueueMax!==null)cfg.workers.queueMax=workerQueueMax;
  if(workerMinFree!==null)cfg.workers.minFreeMemoryMB=workerMinFree;
  if(workerMaxLoad!==null)cfg.workers.maxLoadPerCpu=workerMaxLoad;
  if (profile === 'nas') cfg.desktop.enabled = false;
  if (profile === 'windows') cfg.http.port = 8748;

  // 루트 확정
  if (!cfg.roots || cfg.roots.length === 0) cfg.roots = [cwd];
  cfg.roots = cfg.roots.map((r) => path.resolve(r));
  for (const r of cfg.roots) {
    if (!fs.existsSync(r)) fs.mkdirSync(r, { recursive: true });
  }

  // 상태 디렉토리(.webjjonku)는 첫 번째 루트 아래
  cfg.stateDir = path.join(cfg.roots[0], ".webjjonku", ...(profile ? ["runtimes", profile] : []));
  for (const d of ["", "sessions", "workers", "tmp"]) {
    fs.mkdirSync(path.join(cfg.stateDir, d), { recursive: true });
  }
  hardenStateDir(cfg.stateDir);

  // HTTP 시크릿 경로(캐퍼빌리티 토큰) 생성/영속화
  const secretFile = path.join(cfg.stateDir, "http-secret");
  if (!cfg.http.secretPath) {
    const legacySecretFile = profile ? path.join(cfg.roots[0], ".webjjonku", "http-secret") : null;
    if (!fs.existsSync(secretFile) && legacySecretFile && fs.existsSync(legacySecretFile)) {
      const inheritedSecret = fs.readFileSync(legacySecretFile, "utf8").trim();
      if (inheritedSecret) fs.writeFileSync(secretFile, inheritedSecret, { mode: 0o600 });
    }
    if (fs.existsSync(secretFile)) {
      cfg.http.secretPath = fs.readFileSync(secretFile, "utf8").trim();
    } else {
      cfg.http.secretPath = crypto.randomBytes(18).toString("base64url");
      fs.writeFileSync(secretFile, cfg.http.secretPath, { mode: 0o600 });
    }
    if(!hardenPathAcl(secretFile))throw new Error("http-secret ACL hardening 실패");
  }
  return cfg;
}

export function configSummary(cfg) {
  return [
    `승인 루트: ${cfg.roots.join(", ")}`,
    `읽기 전용 모드: ${cfg.readOnly ? "ON (쓰기/실행 잠김)" : "OFF"}`,
    `DB 쓰기 허용: ${cfg.db.allowWrite ? "ON" : "OFF (SELECT만)"}`,
    `워커 최대: ${cfg.workers.max}`,
    `기본 effort: ${cfg.effortDefault}`,
    `데스크톱 제어: ${cfg.desktop.enabled ? "ON" : "OFF"}`,
    `등록된 DB 연결: ${Object.keys(cfg.db.connections).join(", ") || "(없음)"}`,
    `등록된 원격 서버: ${Object.keys(cfg.remotes).join(", ") || "(없음)"}`
  ].join("\n");
}
