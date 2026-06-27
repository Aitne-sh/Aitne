/**
 * `!report` — recent agent failures, grouped by `(action_type, backend)`.
 *
 * Source: structured query over `agent_actions` rows with
 * `result IN ('failed','partial') AND error IS NOT NULL` rather than a
 * log-file scan. See spec §6.4 (`!report`) for the rationale.
 * `partial` joined the set with RESEARCH_CLUSTER_COST_FIX_PLAN F5: a
 * session that ends cleanly but fails its post-run outcome check (e.g.
 * `journal_write_missing`) is exactly the silent breakage `!report`
 * exists to surface. The `error IS NOT NULL` guard keeps benign
 * partial rows (wiki-bridge `candidate_logged` / `deduplicated`, which
 * carry no error) out of the report.
 */
import type Database from "better-sqlite3";
import { redactSensitiveString } from "@aitne/shared";
import type { AgentConfig } from "../../config.js";
import type { BangCommand } from "./registry.js";
import { formatLocalShort } from "./format-utils.js";

interface ReportRow {
  backend: string;
  action_type: string;
  n: number;
  first_seen: string;
  last_seen: string;
  sample: string | null;
}

const REPORT_LIMIT = 5;
const SAMPLE_TRUNCATE = 80;

const REPORT_SQL = `
  SELECT
    COALESCE(g.backend, 'claude') AS backend,
    g.action_type,
    g.n,
    g.first_seen,
    g.last_seen,
    substr(latest.error, 1, 120) AS sample
  FROM (
    SELECT
      backend,
      action_type,
      COUNT(*)        AS n,
      MIN(started_at) AS first_seen,
      MAX(started_at) AS last_seen
    FROM agent_actions
    WHERE result IN ('failed', 'partial')
      AND started_at >= datetime('now', '-7 days')
      AND error IS NOT NULL
    GROUP BY backend, action_type
  ) AS g
  JOIN agent_actions AS latest
    ON latest.action_type = g.action_type
   AND COALESCE(latest.backend, 'claude') = COALESCE(g.backend, 'claude')
   AND latest.started_at = g.last_seen
   AND latest.result IN ('failed', 'partial')
   AND latest.error IS NOT NULL
  GROUP BY g.backend, g.action_type
  ORDER BY g.n DESC, g.last_seen DESC
  LIMIT ?
`;

function queryReport(db: Database.Database): {
  rows: ReportRow[];
  totalGroups: number;
  totalEvents: number;
} {
  const rows = db.prepare(REPORT_SQL).all(REPORT_LIMIT + 1) as ReportRow[];
  // Count total failure groups + total failures separately so the "and N
  // more" footer reflects the unseen-group count, not just truncated rows.
  const stats = db
    .prepare(
      `SELECT
         COUNT(DISTINCT COALESCE(backend, 'claude') || '|' || action_type) AS groups,
         COUNT(*) AS total
       FROM agent_actions
       WHERE result IN ('failed', 'partial')
         AND started_at >= datetime('now', '-7 days')
         AND error IS NOT NULL`,
    )
    .get() as { groups: number; total: number };
  return { rows, totalGroups: stats.groups, totalEvents: stats.total };
}

function truncateSample(sample: string | null): string {
  if (!sample) return "(no error message)";
  // Apply the same secret-redaction pipeline used by structured logs
  // before the message lands in a messaging platform. `agent_actions.error`
  // is written verbatim by `AuditLogger.logError`, so any bearer token or
  // refresh string a backend SDK puts in `error.message` would otherwise
  // round-trip into the owner's DM.
  const redacted = redactSensitiveString(sample);
  const oneLine = redacted.replace(/\s+/g, " ").trim();
  if (oneLine.length <= SAMPLE_TRUNCATE) return oneLine;
  return `${oneLine.slice(0, SAMPLE_TRUNCATE - 1)}…`;
}

export function formatReport(
  data: { rows: ReportRow[]; totalGroups: number; totalEvents: number },
  config: AgentConfig,
): string {
  if (data.totalGroups === 0) {
    return [
      "[SYSTEM · !report · last 7d]",
      "Clean. No agent failures recorded.",
    ].join("\n");
  }
  const lines: string[] = [
    "[SYSTEM · !report · last 7d]",
    `${data.totalGroups} error groups (${data.totalEvents} total)`,
  ];
  const visible = data.rows.slice(0, REPORT_LIMIT);
  visible.forEach((row, idx) => {
    const backendLabel = row.backend || "—";
    lines.push("");
    lines.push(
      `${idx + 1}. ${row.action_type} · ${backendLabel} (${row.n}×)`,
    );
    lines.push(`   "${truncateSample(row.sample)}"`);
    lines.push(`   last: ${formatLocalShort(row.last_seen, config)}`);
  });
  if (data.totalGroups > visible.length) {
    const remaining = data.totalGroups - visible.length;
    lines.push("");
    lines.push(`… and ${remaining} more`);
  }
  return lines.join("\n");
}

export const reportCommand: BangCommand = {
  name: "!report",
  title: "Failure report",
  describe: "Agent errors over the past 7 days.",
  details: [
    "Summarizes recent failed agent actions by action type and backend.",
    "Includes partial runs that failed a post-run outcome check.",
    "Samples are redacted before sending to messaging surfaces.",
    "Does not invoke an LLM.",
  ],
  runsWhilePaused: true,
  handler: async (ctx) => {
    const data = queryReport(ctx.db);
    await ctx.notify(formatReport(data, ctx.config));
  },
};
