// V2 policy engine: server-enforced action policy (allow|ask|deny)
import { z } from "zod";
import { text } from "../toolkit.js";

const LEVELS = ["allow","ask","deny"];

export function policyDecision(cfg, action) {
  const rules = cfg.permissions?.actions || {};
  return rules[action] || cfg.permissions?.default || "allow";
}

export function assertPolicy(cfg, action) {
  const d = policyDecision(cfg, action);
  if (d === "deny") throw new Error(`정책상 차단됨: ${action}`);
  if (d === "ask") throw new Error(`사용자 승인 필요: ${action} (permissions.actions에서 allow로 명시하거나 승인 후 실행)`);
}

export function registerPolicyTools(reg, ctx) {
  reg("policy_status", {
    description: "현재 V2 실행 권한 정책을 확인한다. allow=자동허용, ask=명시적 승인 필요, deny=차단.",
    inputSchema: {}
  }, async () => text(JSON.stringify(ctx.cfg.permissions || { default:"allow", actions:{} }, null, 2)));

  reg("policy_check", {
    description: "특정 작업 키의 현재 권한 판정을 확인한다. 예: fs.delete, exec.command, desktop.input, remote.exec.",
    inputSchema: { action: z.string() }
  }, async ({ action }) => text(`${action}: ${policyDecision(ctx.cfg, action)}`));
}
