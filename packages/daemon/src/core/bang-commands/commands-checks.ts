/**
 * `!checks` — owner-pull view of today's browser reload tally
 * (BROWSER_HISTORY_INTEGRATION_PLAN §5.F4).
 *
 * F4 ("Reload memory") is the passive-observability surface: the daemon
 * counts `transition & 0xFF == 8` reloads per `<domain>/<first-path>`
 * pattern into `browser_reload_signals`, and the weekly review surfaces
 * the top patterns as a neutral "this week you checked" block. `!checks`
 * is the on-demand mirror — the user asks, the daemon answers; never
 * pushed.
 *
 * Properties of this command, in the language §5.F4 + §10.2 require:
 *
 *   - Pure DB read (`listReloadsForDate`). No LLM, no HTTP roundtrip,
 *     no observation emission. Matches `!cost` / `!report`: runs
 *     while paused (`runsWhilePaused: true`).
 *   - Anchored on the agent-day, not the wall-clock UTC date. The
 *     daemon's `dayBoundaryHour` (default 04:00 local) controls when a
 *     "day" rolls over; reading by UTC date would split a single
 *     morning-of-reading session across two `!checks` calls.
 *   - Top 10 by count (matches `/api/browser-history/reloads/today`'s
 *     default limit). Output is bounded by the mobile reply budget the
 *     bang-command pipeline already truncates against.
 *   - Empty state is the common case for a fresh install / quiet day —
 *     the reply is a single, calm line so the user immediately knows
 *     the daemon ran the query rather than seeing a blank.
 */
import type Database from "better-sqlite3";
import { getAgentDayDateStr } from "@aitne/shared";
import type { AgentConfig } from "../../config.js";
import type { BangCommand } from "./registry.js";
import { listReloadsForDate } from "../../db/browser-history-store.js";

const DEFAULT_LIMIT = 10;

function resolveTodayKey(config: AgentConfig, nowMs: number): string {
  return getAgentDayDateStr(
    config.timezone && config.timezone.length > 0 ? config.timezone : undefined,
    config.dayBoundaryHour ?? 4,
    new Date(nowMs),
  );
}

interface ChecksRow {
  urlPattern: string;
  reloadCount: number;
}

/**
 * Pure formatter — same shape as `formatCostAll`, kept exported so the
 * test suite can pin output shape without standing up a DB.
 *
 * The "neutral observation, never recommendation" rule lives in
 * §5.F4 (Explicit non-action). This formatter renders the count and
 * nothing else: no "you should…", no "consider…", no rate per hour.
 */
export function formatChecks(date: string, rows: ChecksRow[]): string {
  const header = `[SYSTEM · !checks · ${date}]`;
  if (rows.length === 0) {
    return [
      header,
      "No reload patterns recorded for today's agent-day yet.",
    ].join("\n");
  }
  const lines: string[] = [
    header,
    `Top reload patterns (${rows.length}):`,
  ];
  for (const row of rows) {
    lines.push(`- ${row.urlPattern}: ${row.reloadCount}`);
  }
  return lines.join("\n");
}

function queryChecks(
  db: Database.Database,
  date: string,
): ChecksRow[] {
  return listReloadsForDate(db, date, DEFAULT_LIMIT);
}

export const checksCommand: BangCommand = {
  name: "!checks",
  title: "Reload tally",
  // describe kept tight so the !help mobile-reply budget (1500 chars)
  // still has headroom for user-defined bang commands when the default
  // registry already runs ~20 entries deep. Full F4 context belongs in
  // `details:` below, not in the one-line describe.
  describe: "Today's browser reload tally.",
  details: [
    "Returns today's top reload patterns per URL (domain + first path segment).",
    "Day boundary is the daemon's `dayBoundaryHour` (default 04:00 local), not UTC midnight.",
    "Does not invoke an LLM. Safe to call while paused.",
  ],
  // Pure DB read with no agent dispatch — same posture as `!cost` /
  // `!report`. Critically, the user can still ask "what was I refreshing
  // today?" with the agent paused, which is when a quiet self-check is
  // most useful.
  runsWhilePaused: true,
  handler: async (ctx) => {
    const date = resolveTodayKey(ctx.config, Date.now());
    const rows = queryChecks(ctx.db, date);
    await ctx.notify(formatChecks(date, rows));
  },
};
