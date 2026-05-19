/**
 * `aitne audit` — view the agent action log.
 *
 * Reads `agent_actions` directly from SQLite in readonly mode. Safe while
 * the daemon runs because the daemon enables WAL
 * (packages/daemon/src/db/client.ts) — concurrent readers are fine.
 *
 * Default: last 50 rows from the past 24h, table output, summary footer.
 *
 * The `agent_actions` columns we surface are intentionally narrow:
 *   started_at, action_type, backend, result, duration_ms, cost_usd
 * Plus `error` and `detail` only on `--detail`. That keeps the default
 * output scannable on an 80-col terminal.
 */
import fs from "node:fs";
import path from "node:path";

export async function run(args, ctx) {
  if (args.includes("--help") || args.includes("-h")) {
    printHelp();
    return;
  }

  const opts = parseArgs(args);
  const dbPath = path.join(ctx.DATA_DIR, "data", "personal_agent.db");
  if (!fs.existsSync(dbPath)) {
    console.log("No actions logged yet.");
    console.log(`(Database not found at ${dbPath} — run \`aitne start\` first.)`);
    return;
  }

  const { loadBetterSqlite3 } = await import("../lib/sqlite-loader.mjs");
  const Database = await loadBetterSqlite3(ctx.PROJECT_ROOT);
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  let rows;
  let summary;
  try {
    rows = queryRows(db, opts);
    summary = querySummary(db, opts);
  } catch (err) {
    if (/no such table/i.test(err?.message ?? "")) {
      console.error("agent_actions table not present — schema is older than this CLI.");
      console.error("Try `aitne stop && rm ~/.personal-agent/data/personal_agent.db && aitne start`.");
      process.exit(1);
    }
    throw err;
  } finally {
    db.close();
  }

  if (opts.json) {
    process.stdout.write(JSON.stringify({ rows, summary, query: opts }, null, 2) + "\n");
    return;
  }

  if (rows.length === 0) {
    console.log(`No actions in the selected window (since ${opts.since}).`);
    return;
  }

  printTable(rows, opts);
  printFooter(summary, opts);
}

// ─────────────────────────────────────────────────────────────────────────
// CLI parsing
// ─────────────────────────────────────────────────────────────────────────

// Allowed values for enum-style flags. Validated up-front so a typo like
// `--result fail` becomes an explicit error instead of a silent zero-row
// query (`WHERE result = 'fail'` matches nothing).
const VALID_RESULTS = new Set(["success", "failed", "partial", "skipped"]);
const VALID_BACKENDS = new Set(["claude", "codex", "gemini"]);

function parseArgs(args) {
  const opts = {
    since: "24h",
    type: null,
    result: null,
    backend: null,
    limit: 50,
    detail: false,
    json: false,
  };
  // Helper: read the value paired with a flag and fail loudly if missing.
  // Without this, `aitne audit --since` would set opts.since to undefined
  // and produce a misleading "got: undefined" downstream.
  const takeValue = (i, flag) => {
    if (i + 1 >= args.length) {
      console.error(`${flag} requires a value`);
      console.error(`See \`aitne audit --help\`.`);
      process.exit(1);
    }
    return args[i + 1];
  };

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--since") { opts.since = takeValue(i, "--since"); i++; }
    else if (a === "--type") { opts.type = takeValue(i, "--type"); i++; }
    else if (a === "--result") {
      const v = takeValue(i, "--result"); i++;
      if (!VALID_RESULTS.has(v)) {
        console.error(`--result must be one of ${[...VALID_RESULTS].join(" | ")} (got: ${v})`);
        process.exit(1);
      }
      opts.result = v;
    }
    else if (a === "--backend") {
      const v = takeValue(i, "--backend"); i++;
      if (!VALID_BACKENDS.has(v)) {
        console.error(`--backend must be one of ${[...VALID_BACKENDS].join(" | ")} (got: ${v})`);
        process.exit(1);
      }
      opts.backend = v;
    }
    else if (a === "--limit") {
      const raw = takeValue(i, "--limit"); i++;
      const n = parseInt(raw, 10);
      if (!Number.isFinite(n) || n <= 0) {
        console.error(`--limit must be a positive integer (got: ${raw})`);
        process.exit(1);
      }
      opts.limit = n;
    }
    else if (a === "--detail") opts.detail = true;
    else if (a === "--json") opts.json = true;
    else {
      console.error(`Unknown flag: ${a}`);
      console.error("See `aitne audit --help`.");
      process.exit(1);
    }
  }
  return opts;
}

/**
 * Convert a duration like "24h" / "7d" / "90m" / "2026-04-20" into a SQLite
 * datetime modifier suitable for `datetime('now', '<modifier>')`. Returns
 * the modifier OR an absolute ISO-ish date for direct comparison.
 */
function sinceToWhereClause(since) {
  // Absolute date (YYYY-MM-DD).
  if (/^\d{4}-\d{2}-\d{2}$/.test(since)) {
    return { sql: "started_at >= ?", param: `${since} 00:00:00` };
  }
  // Relative duration.
  const m = /^(\d+)\s*(s|m|h|d)$/.exec(since);
  if (!m) {
    console.error(`--since must be like "24h", "7d", "90m", or "2026-04-20" (got: ${since}).`);
    process.exit(1);
  }
  const n = parseInt(m[1], 10);
  const unit = { s: "seconds", m: "minutes", h: "hours", d: "days" }[m[2]];
  return { sql: `started_at >= datetime('now', ?)`, param: `-${n} ${unit}` };
}

// ─────────────────────────────────────────────────────────────────────────
// SQL
// ─────────────────────────────────────────────────────────────────────────

function buildWhere(opts) {
  const clauses = [];
  const params = [];
  const since = sinceToWhereClause(opts.since);
  clauses.push(since.sql);
  params.push(since.param);
  if (opts.type) {
    if (opts.type.includes("%")) { clauses.push("action_type LIKE ?"); params.push(opts.type); }
    else { clauses.push("action_type = ?"); params.push(opts.type); }
  }
  if (opts.result) { clauses.push("result = ?"); params.push(opts.result); }
  if (opts.backend) { clauses.push("backend = ?"); params.push(opts.backend); }
  return { where: clauses.join(" AND "), params };
}

function queryRows(db, opts) {
  const { where, params } = buildWhere(opts);
  const cols = "started_at, action_type, backend, result, duration_ms, cost_usd"
    + (opts.detail ? ", error, detail" : "");
  const stmt = db.prepare(
    `SELECT ${cols} FROM agent_actions WHERE ${where} ORDER BY started_at DESC LIMIT ?`,
  );
  return stmt.all(...params, opts.limit);
}

function querySummary(db, opts) {
  const { where, params } = buildWhere(opts);
  const stmt = db.prepare(
    `SELECT COUNT(*) AS n,
            SUM(CASE WHEN result = 'failed' THEN 1 ELSE 0 END) AS failed,
            SUM(CASE WHEN result = 'success' THEN 1 ELSE 0 END) AS success,
            COALESCE(SUM(cost_usd), 0) AS cost,
            (SELECT action_type FROM agent_actions WHERE ${where}
             GROUP BY action_type ORDER BY COUNT(*) DESC LIMIT 1) AS top_type
       FROM agent_actions WHERE ${where}`,
  );
  // Inline the params twice — once for the outer query, once for the
  // correlated subquery — since better-sqlite3 doesn't reuse positional
  // params across nested SELECTs.
  return stmt.get(...params, ...params);
}

// ─────────────────────────────────────────────────────────────────────────
// Output
// ─────────────────────────────────────────────────────────────────────────

function printTable(rows, opts) {
  // Column widths chosen for typical content; clamp action_type so a long
  // event name doesn't push everything off-screen.
  const headers = ["TIME", "TYPE", "BACKEND", "RESULT", "DURATION", "COST"];
  const widths = [19, 32, 8, 8, 10, 8];
  console.log(headers.map((h, i) => h.padEnd(widths[i])).join("  "));
  for (const r of rows) {
    const t = (r.started_at ?? "").slice(0, 19);
    const type = clamp(r.action_type ?? "", widths[1]);
    const be = (r.backend ?? "").slice(0, widths[2]);
    const res = (r.result ?? "—").slice(0, widths[3]);
    const dur = formatDuration(r.duration_ms);
    const cost = formatCost(r.cost_usd);
    console.log([
      t.padEnd(widths[0]),
      type.padEnd(widths[1]),
      be.padEnd(widths[2]),
      res.padEnd(widths[3]),
      dur.padStart(widths[4]),
      cost.padStart(widths[5]),
    ].join("  "));
    if (opts.detail) {
      if (r.error) console.log(`    error: ${r.error}`);
      if (r.detail) {
        // Pretty-print one line per top-level key to keep --detail readable.
        try {
          const parsed = typeof r.detail === "string" ? JSON.parse(r.detail) : r.detail;
          for (const [k, v] of Object.entries(parsed)) {
            const printable = typeof v === "string" ? v : JSON.stringify(v);
            console.log(`    ${k}: ${truncate(printable, 120)}`);
          }
        } catch { console.log(`    detail: ${truncate(String(r.detail), 120)}`); }
      }
    }
  }
}

function printFooter(s, opts) {
  if (!s || !s.n) return;
  const failed = Number(s.failed ?? 0);
  const cost = Number(s.cost ?? 0);
  const top = s.top_type ?? "—";
  console.log("");
  console.log(`${s.n} action(s) since ${opts.since} · ${failed} failed · $${cost.toFixed(3)} spent · top: ${top}`);
}

// ── formatting helpers ──

function formatDuration(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return "—";
  if (n < 1000) return `${n}ms`;
  const s = n / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = s / 60;
  if (m < 60) return `${m.toFixed(1)}m`;
  return `${(m / 60).toFixed(1)}h`;
}

function formatCost(c) {
  const n = Number(c);
  if (!Number.isFinite(n) || n === 0) return "$0.000";
  return `$${n.toFixed(3)}`;
}

function clamp(s, w) {
  if (s.length <= w) return s;
  return s.slice(0, w - 1) + "…";
}

function truncate(s, n) {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
}

function printHelp() {
  console.log(`Usage: aitne audit [flags]

Show the agent action log (\`agent_actions\` table) — what the agent has been
doing, when, on which backend, with what result, and how much it cost.

Default: last 50 rows from the past 24h.

Flags:
  --since <duration>    Window. Examples: 1h, 90m, 7d, 2026-04-20. Default: 24h.
  --type <pattern>      Filter on action_type. Use % for LIKE wildcard.
                        Examples: --type routine.morning_routine
                                  --type "routine.%"
  --result <value>      Filter on result column: success | failed | partial | skipped.
  --backend <id>        Filter on backend: claude | codex | gemini.
  --limit <N>           Max rows. Default: 50.
  --detail              Append the \`error\` and \`detail\` columns under each row.
  --json                Machine-readable output (suppresses the summary footer).

Examples:
  aitne audit                                # last 24h, default columns
  aitne audit --since 7d                     # last week
  aitne audit --result failed                # only failures
  aitne audit --type "routine.%" --limit 100 # all routines in last 24h, 100 rows
  aitne audit --type blocked_absolute        # everything the absolute-block layer caught
  aitne audit --json | jq '.summary'         # programmatic`);
}
