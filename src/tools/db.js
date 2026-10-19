// DB 조회: URL 스킴 자동 감지 어댑터 — SQLite/Postgres/MySQL·MariaDB/SQL Server/Oracle/MongoDB/Redis
// 드라이버는 지연 로딩. 없으면 설치 명령을 안내(코어는 무의존 유지).
import { z } from "zod";
import { text } from "../toolkit.js";
import { resolveInRoots, assertSafeKey } from "../security.js";

const DRIVER_HINT = {
  postgres: "npm i pg", postgresql: "npm i pg",
  mysql: "npm i mysql2", mariadb: "npm i mysql2",
  mssql: "npm i mssql", sqlserver: "npm i mssql",
  oracle: "npm i oracledb",
  mongodb: "npm i mongodb", "mongodb+srv": "npm i mongodb",
  redis: "npm i redis", rediss: "npm i redis"
};

const READ_ONLY_RE = /^\s*(select|show|describe|desc|explain|pragma|with)\b/i;

function schemeOf(url) {
  if (url.startsWith("sqlite:") || url.endsWith(".db") || url.endsWith(".sqlite") || url.endsWith(".sqlite3")) return "sqlite";
  const m = url.match(/^([a-z+]+):\/\//i);
  if (!m) throw new Error("접속 URL 형식을 모르겠어. 예: postgres://user:pw@host:5432/db, mysql://…, mssql://…, oracle://…, mongodb://…, redis://…, sqlite:./app.db");
  return m[1].toLowerCase();
}

function assertReadOnlySql(cfg, sql, allowWrite) {
  const cleaned = sql.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--.*$/gm, "").trim();
  if (READ_ONLY_RE.test(cleaned)) return;
  if (cfg.readOnly) throw new Error("읽기 전용 모드: SELECT 계열만 가능해.");
  if (!(allowWrite || cfg.db.allowWrite)) {
    throw new Error("쓰기 쿼리가 차단됐어(기본 읽기 전용). 정말 필요하면 allow_write=true를 넘기거나 설정에서 db.allowWrite=true.");
  }
}

async function lazyImport(pkg, scheme) {
  try {
    return await import(pkg);
  } catch {
    throw new Error(`'${scheme}' 드라이버(${pkg})가 설치 안 돼 있어. 웹쫀쿠 폴더에서 \`${DRIVER_HINT[scheme] || "npm i " + pkg}\` 실행하면 바로 활성화돼.`);
  }
}

function rowsToTable(rows, limit) {
  if (!rows?.length) return "(0행)";
  const sliced = rows.slice(0, limit);
  const cols = Object.keys(sliced[0]);
  const lines = [cols.join(" | "), cols.map(() => "---").join(" | ")];
  for (const r of sliced) {
    lines.push(cols.map((c) => fmtCell(r[c])).join(" | "));
  }
  if (rows.length > limit) lines.push(`… (총 ${rows.length}행 중 ${limit}행 표시)`);
  return lines.join("\n");
}
function fmtCell(v) {
  if (v === null || v === undefined) return "NULL";
  if (v instanceof Date) return v.toISOString();
  if (Buffer.isBuffer(v)) return `<bytes:${v.length}>`;
  const s = typeof v === "object" ? JSON.stringify(v) : String(v);
  return s.length > 120 ? s.slice(0, 120) + "…" : s;
}

export function registerDbTools(reg, ctx) {
  const cfg = ctx.cfg;
  const urlOf = (connection) => {
    if(!/^[a-z+]+:\/\//i.test(connection)&&!connection.startsWith("sqlite:")&&!connection.endsWith(".db")&&!connection.endsWith(".sqlite")&&!connection.endsWith(".sqlite3"))connection=assertSafeKey(connection,"DB connection name");
    const url = ctx.store.data.dbConnections[connection] || cfg.db.connections[connection] || connection;
    if (!url) throw new Error("connection 이름 또는 접속 URL을 줘.");
    return url;
  };

  reg("db_connect", {
    description: "DB 연결 등록(이름 붙이기). 이후 db_query에서 이름으로 사용. 지원: postgres, mysql/mariadb, mssql, oracle, mongodb, redis, sqlite",
    inputSchema: {
      name: z.string(),
      url: z.string().describe("예: postgres://user:pw@host:5432/db, sqlite:./data/app.db"),
      persist: z.boolean().optional().describe("true면 상태파일에 저장(기본 true)")
    }
  }, async ({ name, url, persist = true }) => {
    name=assertSafeKey(name,"DB connection name");const scheme = schemeOf(url); // 형식 검증
    ctx.store.data.dbConnections[name] = url;
    if (persist) ctx.store.save();
    return text(`등록 완료: ${name} (${scheme}) — db_query{connection:"${name}", query:"..."}로 조회해봐. 접속 테스트는 db_schema{connection:"${name}"} 추천.`);
  });

  reg("db_query", {
    description: "DB 쿼리 실행. SQL DB는 SQL, MongoDB는 JSON({collection, op, filter, ...}), Redis는 명령 문자열. 기본 읽기 전용.",
    inputSchema: {
      connection: z.string().describe("db_connect로 등록한 이름 또는 접속 URL"),
      query: z.string(),
      params: z.array(z.any()).optional().describe("SQL 파라미터 바인딩 ($1/?/:p 스타일은 DB별 규칙)"),
      limit: z.number().int().min(1).max(5000).optional(),
      allow_write: z.boolean().optional()
    }
  }, async ({ connection, query, params = [], limit = 200, allow_write = false }) => {
    const url = urlOf(connection);
    const scheme = schemeOf(url);
    return text(await runQuery(cfg, url, scheme, query, params, limit, allow_write));
  });

  reg("db_schema", {
    description: "DB 스키마 조회(테이블/컬럼 목록). table 지정 시 해당 테이블 상세.",
    inputSchema: { connection: z.string(), table: z.string().optional() }
  }, async ({ connection, table }) => {
    const url = urlOf(connection);
    const scheme = schemeOf(url);
    return text(await introspect(cfg, url, scheme, table));
  });

  reg("db_connections", {
    description: "등록된 DB 연결 목록",
    inputSchema: {}
  }, async () => {
    const all = { ...cfg.db.connections, ...ctx.store.data.dbConnections };
    if (!Object.keys(all).length) return text("등록된 연결 없음. db_connect로 등록해.");
    return text(Object.entries(all).map(([k, v]) => `${k} → ${v.replace(/:\/\/([^:/]+):[^@]+@/, "://$1:***@")} (${schemeOf(v)})`).join("\n"));
  });

  // ── 스킴별 실행 ──────────────────────────────────────────────
  async function runQuery(cfg, url, scheme, query, params, limit, allowWrite) {
    switch (scheme) {
      case "sqlite": {
        const file = url.replace(/^sqlite:(\/\/)?/, "");
        const abs = resolveInRoots(cfg, file);
        assertReadOnlySql(cfg, query, allowWrite);
        const db = await openSqlite(abs);
        try {
          if (READ_ONLY_RE.test(query.trim())) {
            const rows = db.prepare(query).all(...params);
            return rowsToTable(rows, limit);
          }
          const info = db.prepare(query).run(...params);
          return `실행 완료: ${JSON.stringify(info)}`;
        } finally { db.close?.(); }
      }
      case "postgres": case "postgresql": {
        assertReadOnlySql(cfg, query, allowWrite);
        const { default: pg } = await lazyImport("pg", scheme);
        const client = new pg.Client({ connectionString: url, statement_timeout: 30_000 });
        await client.connect();
        try {
          const r = await client.query(query, params);
          return r.rows ? rowsToTable(r.rows, limit) : `실행 완료 (${r.rowCount}행 영향)`;
        } finally { await client.end(); }
      }
      case "mysql": case "mariadb": {
        assertReadOnlySql(cfg, query, allowWrite);
        const mysql = await lazyImport("mysql2/promise", scheme);
        const conn = await mysql.createConnection(url.replace(/^mariadb:/, "mysql:"));
        try {
          const [rows] = await conn.execute(query, params);
          return Array.isArray(rows) ? rowsToTable(rows, limit) : `실행 완료: ${JSON.stringify(rows)}`;
        } finally { await conn.end(); }
      }
      case "mssql": case "sqlserver": {
        assertReadOnlySql(cfg, query, allowWrite);
        const sql = await lazyImport("mssql", scheme);
        const pool = await (sql.default ?? sql).connect(url.replace(/^sqlserver:/, "mssql:"));
        try {
          const r = await pool.request().query(query);
          return rowsToTable(r.recordset ?? [], limit) + (r.rowsAffected?.length ? `\n(영향: ${r.rowsAffected.join(",")}행)` : "");
        } finally { await pool.close(); }
      }
      case "oracle": {
        assertReadOnlySql(cfg, query, allowWrite);
        const oracledb = (await lazyImport("oracledb", scheme)).default;
        const u = new URL(url);
        const conn = await oracledb.getConnection({
          user: decodeURIComponent(u.username), password: decodeURIComponent(u.password),
          connectString: `${u.hostname}:${u.port || 1521}${u.pathname || "/XEPDB1"}`
        });
        try {
          const r = await conn.execute(query, params, { outFormat: oracledb.OUT_FORMAT_OBJECT, maxRows: limit });
          return r.rows ? rowsToTable(r.rows, limit) : `실행 완료 (${r.rowsAffected}행 영향)`;
        } finally { await conn.close(); }
      }
      case "mongodb": case "mongodb+srv": {
        const { MongoClient } = await lazyImport("mongodb", "mongodb");
        let spec;
        try { spec = JSON.parse(query); } catch { throw new Error('MongoDB는 JSON 쿼리를 줘: {"collection":"users","op":"find","filter":{},"projection":{},"sort":{},"pipeline":[]}'); }
        const writeOps = ["insertOne", "insertMany", "updateOne", "updateMany", "deleteOne", "deleteMany", "drop"];
        if (writeOps.includes(spec.op) && !(allowWrite || cfg.db.allowWrite) || (cfg.readOnly && writeOps.includes(spec.op))) {
          throw new Error("MongoDB 쓰기 작업이 차단됐어(allow_write 필요).");
        }
        const client = new MongoClient(url);
        await client.connect();
        try {
          const col = client.db().collection(spec.collection);
          let out;
          if (spec.op === "find" || !spec.op) out = await col.find(spec.filter || {}, { projection: spec.projection }).sort(spec.sort || {}).limit(limit).toArray();
          else if (spec.op === "aggregate") out = await col.aggregate(spec.pipeline || []).limit?.(limit)?.toArray?.() ?? await col.aggregate(spec.pipeline || []).toArray();
          else if (spec.op === "countDocuments") out = await col.countDocuments(spec.filter || {});
          else if (spec.op === "distinct") out = await col.distinct(spec.key, spec.filter || {});
          else out = await col[spec.op](...(spec.args || [spec.filter || {}, spec.update || spec.doc].filter(Boolean)));
          return typeof out === "object" && Array.isArray(out) ? rowsToTable(out, limit) : JSON.stringify(out, null, 2);
        } finally { await client.close(); }
      }
      case "redis": case "rediss": {
        const { createClient } = await lazyImport("redis", "redis");
        const parts = query.match(/(?:[^\s"]+|"[^"]*")+/g).map((s) => s.replace(/^"|"$/g, ""));
        const writeCmds = ["SET", "DEL", "HSET", "LPUSH", "RPUSH", "SADD", "ZADD", "EXPIRE", "FLUSHDB", "FLUSHALL", "INCR", "DECR"];
        if (writeCmds.includes(parts[0].toUpperCase()) && !(allowWrite || cfg.db.allowWrite) || (cfg.readOnly && writeCmds.includes(parts[0].toUpperCase()))) {
          throw new Error("Redis 쓰기 명령이 차단됐어(allow_write 필요).");
        }
        const client = createClient({ url });
        await client.connect();
        try {
          const out = await client.sendCommand(parts);
          return typeof out === "string" ? out : JSON.stringify(out, null, 2);
        } finally { await client.quit(); }
      }
      default:
        throw new Error(`미지원 스킴 '${scheme}'. 지원: sqlite, postgres, mysql/mariadb, mssql, oracle, mongodb, redis`);
    }
  }

  async function introspect(cfg, url, scheme, table) {
    const q = {
      sqlite: table
        ? `PRAGMA table_info(${JSON.stringify(table).slice(1, -1)})`
        : "SELECT name, type FROM sqlite_master WHERE type IN ('table','view') ORDER BY name",
      postgres: table
        ? `SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_name = '${table}' ORDER BY ordinal_position`
        : "SELECT table_schema || '.' || table_name AS table FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema') ORDER BY 1",
      mysql: table
        ? `DESCRIBE \`${table}\``
        : "SHOW TABLES",
      mssql: table
        ? `SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = '${table}' ORDER BY ORDINAL_POSITION`
        : "SELECT TABLE_SCHEMA + '.' + TABLE_NAME AS [table] FROM INFORMATION_SCHEMA.TABLES ORDER BY 1",
      oracle: table
        ? `SELECT column_name, data_type, nullable FROM user_tab_columns WHERE table_name = UPPER('${table}') ORDER BY column_id`
        : "SELECT table_name FROM user_tables ORDER BY 1"
    };
    const key = scheme === "postgresql" ? "postgres" : scheme === "mariadb" ? "mysql" : scheme === "sqlserver" ? "mssql" : scheme;
    if (key === "mongodb" || key === "mongodb+srv") {
      const { MongoClient } = await lazyImport("mongodb", "mongodb");
      const client = new MongoClient(url);
      await client.connect();
      try {
        if (table) {
          const sample = await client.db().collection(table).findOne();
          return `${table} 샘플 문서:\n${JSON.stringify(sample, null, 2)}`;
        }
        const cols = await client.db().listCollections().toArray();
        return "컬렉션:\n" + cols.map((c) => c.name).join("\n");
      } finally { await client.close(); }
    }
    if (key === "redis" || key === "rediss") {
      return await runQuery(cfg, url, key, table ? `TYPE ${table}` : "INFO keyspace", [], 100, false);
    }
    if (!q[key]) throw new Error(`스키마 조회 미지원 스킴: ${scheme}`);
    return await runQuery(cfg, url, scheme, q[key], [], 500, false);
  }
}

// node:sqlite(무설치) → better-sqlite3 폴백
async function openSqlite(file) {
  try {
    const { DatabaseSync } = await import("node:sqlite");
    return new DatabaseSync(file);
  } catch {
    try {
      const BS = (await import("better-sqlite3")).default;
      return new BS(file);
    } catch {
      throw new Error("SQLite 드라이버가 없어. Node 22.13+ 이면 내장(node:sqlite)이 되고, 아니면 `npm i better-sqlite3` 해줘.");
    }
  }
}
