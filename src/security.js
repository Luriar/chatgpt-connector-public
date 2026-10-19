// 경로 가드 · 시크릿 마스킹 · 읽기전용 게이트
import fs from "node:fs";
import path from "node:path";
import { workspaceDefaultRoot } from "./workspace-context.js";

const INTERNAL_CHILD_ENV_KEYS = [
  "WEBJJONKU_COORDINATOR_URL",
  "WEBJJONKU_COORDINATOR_TOKEN",
  "WEBJJONKU_COORDINATOR_FORCE_ENV",
  "WEBJJONKU_COORDINATOR_ALLOW_PRIVATE",
  "WEBJJONKU_COORDINATOR_ALLOW_INSECURE_HTTP",
  "WEBJJONKU_COORDINATOR_DEVICE_ID",
  "WEBJJONKU_DEFAULT_BROWSER_WORKER"
];

export function childProcessEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  for (const key of INTERNAL_CHILD_ENV_KEYS) delete env[key];
  return env;
}

/** 존재하는 상위 경로까지 realpath로 정규화(심볼릭 링크 탈출 방지) */
function canonicalize(p) {
  let cur = path.resolve(p);
  const suffix = [];
  while (!fs.existsSync(cur)) {
    suffix.unshift(path.basename(cur));
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  let real;
  try {
    real = fs.realpathSync.native ? fs.realpathSync.native(cur) : fs.realpathSync(cur);
  } catch {
    real = cur;
  }
  return suffix.length ? path.join(real, ...suffix) : real;
}

/** 승인 루트 안에 있는지 검증하고 정규화된 절대경로 반환 */
export function resolveInRoots(cfg, p, { forWrite = false } = {}) {
  if (!p || typeof p !== "string") throw new Error("경로가 필요해");
  const abs = canonicalize(path.isAbsolute(p) ? p : path.join(workspaceDefaultRoot(cfg), p));
  const ok = cfg.roots.some((root) => {
    const cr = canonicalize(root);
    return abs === cr || abs.startsWith(cr + path.sep);
  });
  if (!ok) {
    throw new Error(`승인되지 않은 경로야: ${abs}\n승인 루트: ${cfg.roots.join(", ")} (webjjonku.config.json의 roots에 추가 가능)`);
  }
  if (forWrite && cfg.readOnly) throw new Error("읽기 전용 모드(readOnly)가 켜져 있어 쓰기가 잠겨 있어.");
  return abs;
}

export function assertSafeKey(value,label="이름"){
  if(typeof value!=="string")throw new Error(label+"은 문자열이어야 해");
  const v=value.trim();if(!v||v.length>128||/[\x00-\x1f\x7f]/.test(v))throw new Error(label+" 형식이 잘못됐어");
  if(["__proto__","prototype","constructor"].includes(v)||Object.prototype[v]!==undefined)throw new Error("금지된 "+label+": "+v);
  return v;
}

export function assertMutationAllowed(cfg, what = "이 작업") {
  if (cfg.readOnly) throw new Error(`읽기 전용 모드라 ${what}이(가) 잠겨 있어. webjjonku.config.json에서 readOnly=false로 바꾸면 풀려.`);
}

export function policyDecision(cfg, action) {
  const rules = cfg.permissions?.actions || {};
  return rules[action] || cfg.permissions?.default || "allow";
}

export function assertPolicy(cfg, action) {
  if (!action) return;
  const decision = policyDecision(cfg, action);
  if (decision === "deny") throw new Error(`정책상 차단됨: ${action}`);
  if (decision === "ask") throw new Error(`사용자 승인 필요: ${action} (permissions.actions에서 allow로 명시하거나 승인 후 실행)`);
}

/** 텍스트에서 시크릿으로 보이는 값 마스킹 */
export function redact(cfg, text) {
  if (typeof text !== "string") text = JSON.stringify(text);
  if (!text) return text;
  let out = text;
  // Authorization/Bearer/Basic은 공백을 포함하므로 일반 key=value 정규식보다 먼저 전체 값을 마스킹.
  out = out.replace(/((?:authorization|proxy-authorization)["']?\s*[:=]\s*["']?(?:Bearer|Basic)\s+)([^"'\s,}{]+)/gi, "$1***");
  out = out.replace(/(\bBearer\s+)([A-Za-z0-9._~+\/=:-]{8,})/gi, "$1***");
  // 흔한 CLI secret flags: --token value, --password=value 등.
  out = out.replace(/(--(?:token|api[-_]?key|password|passwd|secret|client[-_]?secret)\s*(?:=|\s)\s*)(?:"[^"]*"|'[^']*'|\S+)/gi, "$1***");
  for (const key of cfg.redactKeys) {
    // key=value / "key": "value" / key: value 패턴
    const re = new RegExp(`(["']?${key}["']?\\s*[:=]\\s*["']?)([^"'\\s,}{]{3,})`, "gi");
    out = out.replace(re, "$1***");
  }
  // URL 크리덴셜 scheme://user:pass@
  out = out.replace(/(\w+:\/\/[^:/\s]+:)([^@/\s]+)@/g, "$1***@");
  return out;
}

export function truncate(text, max = 60_000) {
  if (typeof text !== "string") text = String(text ?? "");
  if (text.length <= max) return text;
  return text.slice(0, max) + `\n... (총 ${text.length}자 중 ${max}자만 표시 — 잘림)`;
}
