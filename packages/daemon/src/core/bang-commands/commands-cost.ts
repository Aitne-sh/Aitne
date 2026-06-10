/**
 * `!cost` and `!cost <backend>` — agent spend over the trailing 7 days
 * (calendar, wall-clock).
 *
 * Spec: docs/design/backlog/messaging-bang-commands.md §6.4 (`!cost`)
 */
import type Database from "better-sqlite3";
import { BACKEND_IDS, type BackendId } from "@aitne/shared";
import type { BangCommand } from "./registry.js";
import { formatMoney } from "./format-utils.js";

interface CostRow {
  backend: string;
  cost_usd: number;
  sessions: number;
}

// Filter on `cost_usd IS NOT NULL` rather than `result = 'success'` —
// a run that errors out after consuming backend tokens still costs the
// user money, and excluding those rows would silently under-report the
// "Total" line. Spec §6.4 (`!cost`).
const COST_SQL = `
  SELECT
    COALESCE(backend, 'claude') AS backend,
    SUM(cost_usd)               AS cost_usd,
    COUNT(*)                    AS sessions
  FROM agent_actions
  WHERE started_at >= datetime('now', '-7 days')
    AND cost_usd IS NOT NULL
  GROUP BY 1
  ORDER BY cost_usd DESC
`;

function queryCost(db: Database.Database): CostRow[] {
  return db.prepare(COST_SQL).all() as CostRow[];
}

export function formatCostAll(rows: CostRow[]): string {
  if (rows.length === 0) {
    return [
      "[SYSTEM · !cost · last 7d]",
      "No agent runs recorded with a billed cost.",
    ].join("\n");
  }
  let totalUsd = 0;
  let totalSessions = 0;
  for (const row of rows) {
    totalUsd += row.cost_usd;
    totalSessions += row.sessions;
  }
  const lines: string[] = [
    "[SYSTEM · !cost · last 7d]",
    `Total: ${formatMoney(totalUsd)} (${pluralizeSessions(totalSessions)})`,
    "",
    "By backend:",
  ];
  for (const row of rows) {
    lines.push(`- ${row.backend}: ${formatMoney(row.cost_usd)} (${row.sessions})`);
  }
  return lines.join("\n");
}

function pluralizeSessions(n: number): string {
  return n === 1 ? "1 session" : `${n} sessions`;
}

export function formatCostFiltered(
  backend: BackendId,
  rows: CostRow[],
): string {
  const match = rows.find((r) => r.backend === backend);
  if (!match) {
    return [
      `[SYSTEM · !cost ${backend} · last 7d]`,
      `${formatMoney(0)} (${pluralizeSessions(0)})`,
    ].join("\n");
  }
  return [
    `[SYSTEM · !cost ${backend} · last 7d]`,
    `${formatMoney(match.cost_usd)} (${pluralizeSessions(match.sessions)})`,
  ].join("\n");
}

export const costAllCommand: BangCommand = {
  name: "!cost",
  title: "Cost summary",
  describe: "Agent spend over the past 7 days.",
  details: [
    "Reports billed agent runs over the trailing 7 days.",
    "Groups total spend by backend.",
    "Does not invoke an LLM.",
  ],
  runsWhilePaused: true,
  handler: async (ctx) => {
    const rows = queryCost(ctx.db);
    await ctx.notify(formatCostAll(rows));
  },
};

/**
 * P2-21 — `!cost <backend>` is intentionally registered as one exact-match
 * BangCommand per backend (see {@link costBackendCommands}). An unknown
 * argument like `!cost notabackend` therefore falls through to the
 * unknown-command path which lists the known set. If a future refactor
 * flips this to a single `BangPrefixCommand` with `prefix: "!cost"`, add
 * a `parseArgs` that validates against `RUNTIME_AVAILABLE_BACKEND_IDS`
 * and throws `BangArgError("Unknown backend: <x>. Use claude, gemini,
 * codex.")` — otherwise an unknown backend would silently render `$0.00`
 * which reads as "no spend" rather than "you typed the wrong thing".
 */
function makeCostBackendCommand(backend: BackendId): BangCommand {
  return {
    name: `!cost ${backend}`,
    title: `Cost for ${backend}`,
    // Short on purpose — one of these renders per registered backend in
    // `!help`, and the whole list must fit MOBILE_REPLY_BUDGET.
    describe: `Agent spend on ${backend} (7 days).`,
    details: [
      `Reports trailing 7-day spend for ${backend}.`,
      "Does not invoke an LLM.",
    ],
    runsWhilePaused: true,
    handler: async (ctx) => {
      const rows = queryCost(ctx.db);
      await ctx.notify(formatCostFiltered(backend, rows));
    },
  };
}

export const costBackendCommands: BangCommand[] = BACKEND_IDS.map(
  makeCostBackendCommand,
);
