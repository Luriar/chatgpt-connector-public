// V2 skill catalog: reusable operating instructions discoverable through MCP
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { fileURLToPath } from "node:url";
import { text } from "../toolkit.js";

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SKILL_ALIASES = new Map([
  ["dbhitek-it-application", "dbhitek-application"]
]);

function skillRoots(cfg) {
  // Share private skills across devices without reading other OS user profiles.
  const shared = process.env.WEBJJONKU_SHARED_SKILLS_PATH ||
    (process.platform === "linux" && fs.existsSync("/nas/ChatGPT-Connector/skills-canonical")
      ? "/nas/ChatGPT-Connector/skills-canonical" : "");
  const roots = [
    ...(shared ? [shared] : []),
    path.join(cfg.roots[0], "skills"),
    path.join(cfg.roots[0], ".webjjonku", "skills"),
    path.join(PKG_ROOT, "skills", "_vendor", "im-not-ai", "skills"),
    path.join(PKG_ROOT, "skills")
  ];
  return [...new Set(roots.map(p => path.resolve(p)))];
}
function scan(root) {
  if (!fs.existsSync(root)) return [];
  const out = [];
  for (const ent of fs.readdirSync(root, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue;
    const dir = path.join(root, ent.name);
    const file = ["SKILL.md", "skill.md", "README.md"].map((n) => path.join(dir, n)).find(fs.existsSync);
    if (!file) continue;
    const body = fs.readFileSync(file, "utf8");
    const fm = body.match(/^---[\s\S]*?\ndescription:\s*(.+)\r?\n[\s\S]*?\n---/i);
    const head = fm?.[1]?.trim() || body.split(/\r?\n/).find((l) => l.trim() && !l.startsWith("#") && l.trim() !== "---" && !/^\w+:/.test(l.trim())) || "";
    out.push({ name: ent.name, file, description: head.trim().slice(0, 240) });
  }
  return out;
}

export function registerSkillTools(reg, ctx) {
  reg("skill_list", {
    description: "V2 재사용 Skill 카탈로그를 나열한다. 사용자의 요청이 특정 작업 절차/전문 워크플로와 맞으면 먼저 확인한다.",
    inputSchema: {}
  }, async () => {
    const seen = new Map();
    for (const root of skillRoots(ctx.cfg)) for (const s of scan(root)) if (!seen.has(s.name)) seen.set(s.name, s);
    const all = [...seen.values()];
    return text(all.length ? all.map((s) => `${s.name} — ${s.description || s.file}`).join("\n") : "등록된 V2 Skill 없음");
  });

  reg("skill_get", {
    description: "이름으로 V2 Skill 전체 지침을 읽는다. include_supporting=true면 references의 지원 파일도 함께 읽어 Work/ChatGPT가 동일한 canonical Skill 묶음을 사용할 수 있다.",
    inputSchema: { name: z.string(), include_supporting: z.boolean().optional() }
  }, async ({ name, include_supporting = false }) => {
    const resolvedName = SKILL_ALIASES.get(name) || name;
    for (const root of skillRoots(ctx.cfg)) {
      const dir = path.join(root, resolvedName);
      for (const n of ["SKILL.md", "skill.md", "README.md"]) {
        const file = path.join(dir, n);
        if (fs.existsSync(file)) {
          let body=`# Skill: ${resolvedName}\nsource: ${file}\n\n${fs.readFileSync(file, "utf8")}`;
          if(include_supporting){
            const refs=path.join(dir,"references");
            if(fs.existsSync(refs)&&fs.statSync(refs).isDirectory()){
              let used=0;
              for(const ent of fs.readdirSync(refs,{withFileTypes:true}).filter(x=>x.isFile()).sort((a,b)=>a.name.localeCompare(b.name))){
                if(!/\.(md|txt|json|ya?ml)$/i.test(ent.name))continue;
                const ref=path.join(refs,ent.name),content=fs.readFileSync(ref,"utf8");
                if(used+content.length>120000)break;
                used+=content.length;
                body+=`\n\n---\n## Supporting: references/${ent.name}\nsource: ${ref}\n\n${content}`;
              }
            }
          }
          return text(body);
        }
      }
    }
    throw new Error(`Skill 없음: ${name}`);
  });

  reg("skill_match", {
    description: "사용자 요청과 키워드를 기준으로 가장 관련 있는 V2 Skill 후보를 찾는다. 자연어 요청에서 Skill 자동 선택을 돕는다.",
    inputSchema: { query: z.string(), limit: z.number().int().min(1).max(10).optional() }
  }, async ({ query, limit = 5 }) => {
    const terms = query.toLowerCase().split(/[^\p{L}\p{N}_-]+/u).filter((x) => x.length > 1);
    const all = [];
    const seen = new Set();
    for (const root of skillRoots(ctx.cfg)) {
      for (const s of scan(root)) {
        if (seen.has(s.name)) continue;
        seen.add(s.name);
        const body = fs.readFileSync(s.file, "utf8").toLowerCase();
        let score = 0;
        for (const t of terms) if (body.includes(t) || s.name.toLowerCase().includes(t)) score++;
        all.push({ ...s, score });
      }
    }
    all.sort((a,b)=>b.score-a.score || a.name.localeCompare(b.name));
    const hits = all.filter((x)=>x.score>0).slice(0,limit);
    return text(hits.length ? hits.map((s)=>`${s.name} score=${s.score} — ${s.description}`).join("\n") : "직접 일치하는 Skill 없음");
  });
}