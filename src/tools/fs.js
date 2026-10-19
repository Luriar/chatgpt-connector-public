// 파일 도구: 읽기/쓰기/정밀수정/유니파이드 패치/검색 — Codex apply_patch, Claude Edit 급
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { resolveInRoots } from "../security.js";
import { text } from "../toolkit.js";

const SKIP_DIRS = new Set(["node_modules", ".git", ".webjjonku", "dist", "build", ".next", "target", "__pycache__", ".venv", "venv"]);
const BIN_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".ico", ".pdf", ".zip", ".gz", ".tar", ".exe", ".dll", ".so", ".woff", ".woff2", ".ttf", ".mp3", ".mp4", ".webm", ".sqlite", ".db"]);

export function registerFsTools(reg, ctx) {
  const cfg = ctx.cfg;

  reg("fs_ls", {
    description: "폴더 내용 나열(승인 루트 안). 파일 크기·수정시각 포함.",
    inputSchema: { path: z.string().optional().describe("기본값: 첫 번째 승인 루트"), depth: z.number().int().min(1).max(3).optional() }
  }, async ({ path: p, depth = 1 }) => {
    const abs = resolveInRoots(cfg, p || cfg.roots[0]);
    const lines = [];
    walk(abs, 0);
    function walk(dir, d) {
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { lines.push(`(읽기 실패: ${e.message})`); return; }
      for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        const fp = path.join(dir, e.name);
        const rel = path.relative(abs, fp) || e.name;
        if (e.isDirectory()) {
          lines.push(`${"  ".repeat(d)}📁 ${rel}/`);
          if (d + 1 < depth && !SKIP_DIRS.has(e.name)) walk(fp, d + 1);
        } else {
          let st; try { st = fs.statSync(fp); } catch { continue; }
          lines.push(`${"  ".repeat(d)}📄 ${rel}  (${fmtSize(st.size)}, ${st.mtime.toISOString().slice(0, 16)})`);
        }
        if (lines.length > 500) { lines.push("… (500개 초과, 잘림)"); return; }
      }
    }
    return text(`${abs}\n` + (lines.join("\n") || "(비어 있음)"));
  });

  reg("fs_read", {
    description: "파일 읽기(줄번호 포함). offset/limit로 부분 읽기 가능.",
    inputSchema: {
      path: z.string(),
      offset: z.number().int().min(1).optional().describe("시작 줄(1부터)"),
      limit: z.number().int().min(1).max(4000).optional().describe("최대 줄 수, 기본 1500")
    }
  }, async ({ path: p, offset = 1, limit = 1500 }) => {
    const abs = resolveInRoots(cfg, p);
    const st = fs.statSync(abs);
    if (st.size > 5 * 1024 * 1024) throw new Error(`파일이 너무 커(${fmtSize(st.size)}). offset/limit로 나눠 읽거나 fs_find/logs_tail을 써.`);
    if (BIN_EXT.has(path.extname(abs).toLowerCase())) throw new Error("바이너리 파일이야. 텍스트 파일만 읽을 수 있어.");
    const all = fs.readFileSync(abs, "utf8").split("\n");
    const slice = all.slice(offset - 1, offset - 1 + limit);
    const body = slice.map((l, i) => `${String(offset + i).padStart(5)}│${l}`).join("\n");
    const more = all.length > offset - 1 + limit ? `\n… (전체 ${all.length}줄 중 ${offset}~${offset - 1 + slice.length}줄)` : "";
    return text(`${abs} (${all.length}줄)\n${body}${more}`);
  });

  reg("fs_write", {
    description: "파일 생성/전체 덮어쓰기. 기존 파일 일부 수정은 fs_edit 또는 fs_apply_patch 사용.",
    inputSchema: { path: z.string(), content: z.string() }
  }, async ({ path: p, content }) => {
    const abs = resolveInRoots(cfg, p, { forWrite: true });
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    const existed = fs.existsSync(abs);
    fs.writeFileSync(abs, content);
    return text(`${existed ? "덮어씀" : "생성"}: ${abs} (${fmtSize(Buffer.byteLength(content))})`);
  });

  reg("fs_edit", {
    description: "정확한 문자열 치환으로 파일 일부 수정(Claude의 Edit와 동일). old_string은 파일 내에서 유일해야 함.",
    inputSchema: {
      path: z.string(),
      old_string: z.string(),
      new_string: z.string(),
      replace_all: z.boolean().optional()
    }
  }, async ({ path: p, old_string, new_string, replace_all = false }) => {
    const abs = resolveInRoots(cfg, p, { forWrite: true });
    let body = fs.readFileSync(abs, "utf8");
    const count = body.split(old_string).length - 1;
    if (count === 0) throw new Error("old_string을 찾지 못했어. fs_read로 현재 내용을 다시 확인해(공백/들여쓰기까지 정확히).");
    if (count > 1 && !replace_all) throw new Error(`old_string이 ${count}군데 일치해. 더 길게 특정하거나 replace_all=true를 써.`);
    body = replace_all ? body.split(old_string).join(new_string) : body.replace(old_string, new_string);
    fs.writeFileSync(abs, body);
    return text(`수정 완료: ${abs} (${replace_all ? count : 1}곳 치환)`);
  });

  reg("fs_apply_patch", {
    description: "유니파이드 디프(unified diff) 패치 적용(Codex apply_patch와 동일 용도). 여러 파일·여러 헝크 지원.",
    inputSchema: { patch: z.string().describe("--- a/file\\n+++ b/file\\n@@ ... 형식") }
  }, async ({ patch }) => {
    const results = applyUnifiedPatch(cfg, patch);
    return text("패치 적용 결과:\n" + results.join("\n"));
  });

  reg("fs_find", {
    description: "파일명 glob + 내용 정규식 검색(ripgrep 유사). 매치된 줄과 줄번호 반환.",
    inputSchema: {
      query: z.string().describe("내용 검색 정규식. 파일명만 찾으려면 비우고 glob만 사용").optional(),
      glob: z.string().optional().describe("예: **/*.js, src/**"),
      dir: z.string().optional(),
      max_results: z.number().int().max(500).optional()
    }
  }, async ({ query, glob, dir, max_results = 200 }) => {
    const base = resolveInRoots(cfg, dir || cfg.roots[0]);
    const re = query ? new RegExp(query, "i") : null;
    const globRe = glob ? globToRegex(glob) : null;
    const hits = [];
    walk(base);
    function walk(d) {
      if (hits.length >= max_results) return;
      let entries;
      try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (hits.length >= max_results) return;
        const fp = path.join(d, e.name);
        const rel = path.relative(base, fp).replace(/\\/g, "/");
        if (e.isDirectory()) {
          if (!SKIP_DIRS.has(e.name)) walk(fp);
          continue;
        }
        if (globRe && !globRe.test(rel)) continue;
        if (!re) { hits.push(rel); continue; }
        if (BIN_EXT.has(path.extname(e.name).toLowerCase())) continue;
        let st; try { st = fs.statSync(fp); } catch { continue; }
        if (st.size > 1.5 * 1024 * 1024) continue;
        let body; try { body = fs.readFileSync(fp, "utf8"); } catch { continue; }
        const lines = body.split("\n");
        for (let i = 0; i < lines.length && hits.length < max_results; i++) {
          if (re.test(lines[i])) hits.push(`${rel}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
        }
      }
    }
    return text(hits.length ? `${hits.length}건:\n${hits.join("\n")}` : "매치 없음");
  });

  reg("fs_mkdir_rm_mv", {
    description: "폴더 생성 / 파일·폴더 삭제 / 이동·이름변경. op: mkdir|rm|mv",
    inputSchema: {
      op: z.enum(["mkdir", "rm", "mv"]),
      path: z.string(),
      dest: z.string().optional().describe("mv일 때 목적지")
    }
  }, async ({ op, path: p, dest }) => {
    const abs = resolveInRoots(cfg, p, { forWrite: true });
    if (op === "mkdir") { fs.mkdirSync(abs, { recursive: true }); return text(`생성: ${abs}`); }
    if (op === "rm") {
      fs.rmSync(abs, { recursive: true, force: true });
      return text(`삭제: ${abs}`);
    }
    const d = resolveInRoots(cfg, dest, { forWrite: true });
    fs.mkdirSync(path.dirname(d), { recursive: true });
    fs.renameSync(abs, d);
    return text(`이동: ${abs} → ${d}`);
  });
}

// ── 유니파이드 디프 적용기 ─────────────────────────────────────────
function applyUnifiedPatch(cfg, patch) {
  const lines = patch.replace(/\r\n/g, "\n").split("\n");
  const results = [];
  let i = 0;
  while (i < lines.length) {
    if (!lines[i].startsWith("--- ")) { i++; continue; }
    const oldFile = lines[i].slice(4).trim().replace(/^a\//, "");
    if (!lines[i + 1]?.startsWith("+++ ")) throw new Error(`잘못된 패치: ${lines[i]} 다음에 +++ 줄이 없어`);
    const newFile = lines[i + 1].slice(4).trim().replace(/^b\//, "");
    i += 2;
    const target = newFile === "/dev/null" ? oldFile : newFile;
    const abs = resolveInRoots(cfg, target, { forWrite: true });

    if (oldFile === "/dev/null") {
      // 새 파일 생성
      const added = [];
      while (i < lines.length && !lines[i].startsWith("--- ")) {
        if (lines[i].startsWith("+")) added.push(lines[i].slice(1));
        i++;
      }
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, added.join("\n"));
      results.push(`🆕 ${target} 생성 (${added.length}줄)`);
      continue;
    }
    if (newFile === "/dev/null") {
      fs.rmSync(abs, { force: true });
      while (i < lines.length && !lines[i].startsWith("--- ")) i++;
      results.push(`🗑 ${target} 삭제`);
      continue;
    }

    let body = fs.readFileSync(abs, "utf8");
    const hadTrailingNL = body.endsWith("\n");
    let fileLines = body.split("\n");
    if (hadTrailingNL) fileLines.pop();
    let applied = 0, searchFrom = 0;

    while (i < lines.length && lines[i].startsWith("@@")) {
      i++;
      const before = [], after = [];
      while (i < lines.length && !lines[i].startsWith("@@") && !lines[i].startsWith("--- ")) {
        const l = lines[i];
        if (l.startsWith(" ") || l === "") { before.push(l.slice(1)); after.push(l.slice(1)); }
        else if (l.startsWith("-")) before.push(l.slice(1));
        else if (l.startsWith("+")) after.push(l.slice(1));
        else if (l.startsWith("\\")) { /* no newline 마커 */ }
        else break;
        i++;
      }
      const idx = findBlock(fileLines, before, searchFrom);
      if (idx === -1) throw new Error(`패치 헝크를 ${target}에서 찾지 못했어. fs_read로 현재 내용 확인 후 패치를 다시 만들어줘.\n찾던 블록 첫 줄: ${JSON.stringify(before[0] ?? "")}`);
      fileLines.splice(idx, before.length, ...after);
      searchFrom = idx + after.length;
      applied++;
    }
    fs.writeFileSync(abs, fileLines.join("\n") + (hadTrailingNL ? "\n" : ""));
    results.push(`✏️ ${target} 수정 (${applied}개 헝크)`);
  }
  if (!results.length) throw new Error("패치에서 '--- a/파일' 헤더를 찾지 못했어. 유니파이드 디프 형식인지 확인해줘.");
  return results;
}

function findBlock(fileLines, block, from) {
  if (!block.length) return from;
  outer: for (let s = from; s <= fileLines.length - block.length; s++) {
    for (let j = 0; j < block.length; j++) {
      if (fileLines[s + j] !== block[j]) continue outer;
    }
    return s;
  }
  // 앞쪽도 한 번 더(순서 어긋난 헝크 대비)
  outer2: for (let s = 0; s < from && s <= fileLines.length - block.length; s++) {
    for (let j = 0; j < block.length; j++) {
      if (fileLines[s + j] !== block[j]) continue outer2;
    }
    return s;
  }
  return -1;
}

function globToRegex(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") { re += ".*"; i++; if (glob[i + 1] === "/") i++; }
      else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else if (".+^${}()|[]\\".includes(c)) re += "\\" + c;
    else re += c;
  }
  return new RegExp(`^${re}$`, "i");
}

function fmtSize(n) {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}
