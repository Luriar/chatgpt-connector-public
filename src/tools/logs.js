// 로그 확인: 파일 tail + grep + 웹쫀쿠 자체 저널
import fs from "node:fs";
import { z } from "zod";
import { resolveInRoots } from "../security.js";
import { text } from "../toolkit.js";

export function registerLogTools(reg, ctx) {
  const cfg = ctx.cfg;

  reg("logs_tail", {
    description: "로그 파일 끝부분 보기 + 필터. source에 'journal'을 주면 웹쫀쿠 자체 도구호출 로그. 등록된 소스 이름 또는 파일 경로 사용 가능.",
    inputSchema: {
      source: z.string().describe("'journal' | 설정의 logs.sources 이름 | 파일 경로"),
      lines: z.number().int().min(1).max(2000).optional(),
      grep: z.string().optional().describe("정규식 필터")
    }
  }, async ({ source, lines = 100, grep }) => {
    if (source === "journal") {
      const rows = ctx.journal.tail(lines, grep);
      return text(rows.length ? rows.join("\n") : "저널 비어 있음");
    }
    const p = cfg.logs.sources[source] || source;
    const abs = resolveInRoots(cfg, p);
    const st = fs.statSync(abs);
    // 큰 파일도 끝부분만 효율적으로 읽기
    const readBytes = Math.min(st.size, Math.max(lines * 400, 64 * 1024));
    const fd = fs.openSync(abs, "r");
    const buf = Buffer.alloc(readBytes);
    fs.readSync(fd, buf, 0, readBytes, st.size - readBytes);
    fs.closeSync(fd);
    let rows = buf.toString("utf8").split("\n");
    rows = rows.slice(-lines);
    if (grep) {
      const re = new RegExp(grep, "i");
      rows = rows.filter((r) => re.test(r));
    }
    return text(`${abs} (${(st.size / 1024).toFixed(0)}KB, 마지막 ${rows.length}줄${grep ? `, grep=/${grep}/` : ""})\n` + rows.join("\n"));
  });

  reg("logs_sources", {
    description: "조회 가능한 로그 소스 목록(journal + 설정된 소스)",
    inputSchema: {}
  }, async () => {
    const s = Object.entries(cfg.logs.sources).map(([k, v]) => `${k} → ${v}`);
    return text(["journal → 웹쫀쿠 도구호출 저널(.webjjonku/journal.jsonl)", ...s].join("\n"));
  });
}
