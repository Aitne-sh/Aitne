/**
 * `partial-extract-streak` — §4.7b operator escalation for the daily
 * journal's partial-extract shape.
 *
 * When Stage B's daily-journal compose lands `ok='partial'` three days
 * in a row (any mix of `frontmatter_tag_missing` /
 * `frontmatter_invalid_json` / `frontmatter_schema_invalid`), the
 * user's wiki link graph is silently degrading even though the diary
 * body is on disk. The daemon emits a one-shot owner DM the first
 * time the 3-day streak fires, with 24h dedup so a continuing streak
 * does not spam and a streak ending + restarting fires a fresh DM.
 *
 * Storage:
 *   - Streak detection reads the last 7 days of `agent_actions` rows
 *     for `action_type='routine.morning_routine_journal'`, ordered
 *     newest-first.
 *   - Dedup state lives in
 *     `runtime_state.partial_extract_dm_last_notified_at` (ISO
 *     timestamp). Absent value reads as "never notified" — the first
 *     repeat streak fires.
 */

import type Database from "better-sqlite3";
import {
  readRuntimeState,
  writeRuntimeState,
} from "../../db/runtime-state.js";
import { createLogger } from "../../logging.js";

const logger = createLogger("partial-extract-streak");

export const STREAK_THRESHOLD = 3;
export const DEDUP_WINDOW_MS = 24 * 60 * 60 * 1000;

const STAGE_B_ACTION_TYPE = "routine.morning_routine_journal";
const RUNTIME_KEY = "partial_extract_dm_last_notified_at";

export interface PartialExtractStreakNotifier {
  /**
   * Emit a one-shot owner DM about the partial-extract streak. The
   * notifier shape mirrors the existing `sendNotification` chain
   * (priority + platforms) so the streak detector can plug into the
   * already-wired notification surface without depending on Hono /
   * messaging adapters directly.
   */
  notify(args: { message: string }): Promise<void> | void;
}

export interface MaybeEmitArgs {
  db: Database.Database;
  /** Correlation id for the morning routine; logged for ops grep. */
  correlationId: string;
  /** Override `Date.now()` for tests. */
  now?: () => Date;
  /** The DM emitter — the orchestrator passes the daemon's
   *  `sendNotification` proxy. When `null` the streak detector still
   *  runs (so the SQL aggregator is exercised + audited) but no DM
   *  is sent. */
  notifier: PartialExtractStreakNotifier | null;
}

export interface MaybeEmitResult {
  /** Whether the SQL streak check actually fired (3+ recent partials). */
  streakDetected: boolean;
  /** Whether a DM was sent on this call. */
  dmSent: boolean;
  /**
   * Reason the DM was suppressed when streakDetected=true but dmSent=false.
   * Three distinct shapes so operators triaging from telemetry can tell a
   * configuration gap ("no notifier was supplied") apart from a transient
   * runtime failure ("notifier threw") apart from the normal dedup path.
   */
  suppressedReason?: "dedup_recent" | "no_notifier" | "notify_failed";
  /** Reasons gathered from the most-recent 3 rows when the streak fires —
   *  surfaced for tests / ops logging. */
  reasonsInStreak?: ReadonlyArray<string>;
}

/**
 * Look at the most recent 3 Stage B rows. If all carry
 * `detail.dailyWrite.ok = 'partial'`, emit an owner DM (subject to
 * the 24h dedup gate). Returns a structured outcome so callers can
 * log + tests can assert without re-querying the DB.
 *
 * The SELECT is the canonical query from design §4.7b — keyed by
 * `action_type` + a 7-day window + DESC ordering + LIMIT 3.
 */
export async function maybeEmitPartialExtractStreakDm(
  args: MaybeEmitArgs,
): Promise<MaybeEmitResult> {
  const rows = readRecentStageBRows(args.db);
  if (rows.length < STREAK_THRESHOLD) {
    return { streakDetected: false, dmSent: false };
  }
  const top3 = rows.slice(0, STREAK_THRESHOLD);
  const allPartial = top3.every((row) => row.ok === "partial");
  if (!allPartial) {
    return { streakDetected: false, dmSent: false };
  }
  const reasons = top3.map((row) => row.partialReason ?? "unknown");
  if (isWithinDedupWindow(args.db, args.now)) {
    return {
      streakDetected: true,
      dmSent: false,
      suppressedReason: "dedup_recent",
      reasonsInStreak: reasons,
    };
  }
  if (args.notifier === null) {
    return {
      streakDetected: true,
      dmSent: false,
      suppressedReason: "no_notifier",
      reasonsInStreak: reasons,
    };
  }
  const message = renderDmMessage(top3);
  try {
    await args.notifier.notify({ message });
  } catch (err) {
    // Don't propagate notifier failures — the orchestrator already
    // logged Stage B's outcome via `persistStageAuditRows`. A failed
    // DM is recoverable (next day's streak check fires again with no
    // dedup state recorded), so we DON'T write the timestamp on this
    // path. Surfaced as `notify_failed` (distinct from `no_notifier`)
    // so telemetry can tell "notifier threw" apart from "no notifier
    // configured" — the two states are operationally different even
    // though both end in dmSent=false.
    logger.warn(
      { err, correlationId: args.correlationId },
      "Partial-extract streak DM emit failed",
    );
    return {
      streakDetected: true,
      dmSent: false,
      suppressedReason: "notify_failed",
      reasonsInStreak: reasons,
    };
  }
  writeDedupTimestamp(args.db, args.now);
  logger.info(
    { correlationId: args.correlationId, reasonsInStreak: reasons },
    "Partial-extract streak DM emitted",
  );
  return {
    streakDetected: true,
    dmSent: true,
    reasonsInStreak: reasons,
  };
}

interface RecentStageBRow {
  ok: string | null;
  partialReason: string | null;
  startedAt: string;
}

function readRecentStageBRows(db: Database.Database): RecentStageBRow[] {
  // Pull JSON-extracted fields directly via SQLite's json_extract so we
  // never have to parse the column twice. `LIMIT 7` matches the 7-day
  // window design §4.7b specifies; the 3-row check runs in JS over the
  // result.
  try {
    return db
      .prepare(
        `SELECT json_extract(detail, '$.dailyWrite.ok')            AS ok,
                json_extract(detail, '$.dailyWrite.partialReason') AS partialReason,
                started_at                                           AS startedAt
           FROM agent_actions
          WHERE action_type = ?
            AND started_at >= datetime('now', '-7 days')
          ORDER BY started_at DESC
          LIMIT ?`,
      )
      .all(STAGE_B_ACTION_TYPE, STREAK_THRESHOLD + 4) as RecentStageBRow[];
  } catch (err) {
    logger.warn({ err }, "Partial-extract streak SELECT failed");
    return [];
  }
}

function isWithinDedupWindow(
  db: Database.Database,
  nowFn: (() => Date) | undefined,
): boolean {
  const last = readRuntimeState<string>(db, RUNTIME_KEY);
  if (typeof last !== "string" || last.length === 0) return false;
  const lastMs = Date.parse(last);
  if (!Number.isFinite(lastMs)) return false;
  const nowMs = (nowFn ?? (() => new Date()))().getTime();
  return nowMs - lastMs < DEDUP_WINDOW_MS;
}

function writeDedupTimestamp(
  db: Database.Database,
  nowFn: (() => Date) | undefined,
): void {
  const iso = (nowFn ?? (() => new Date()))().toISOString();
  writeRuntimeState(db, RUNTIME_KEY, iso);
}

/**
 * Compose the operator-DM body. Counts each `partialReason` so the
 * operator sees the distribution at a glance — `(reasons:
 * frontmatter_tag_missing × 2, frontmatter_invalid_json × 1)`.
 *
 * Dates surfaced are the `started_at` UTC dates (YYYY-MM-DD slice).
 *
 * Streak-count rendering: derives the "on all N days" suffix from the
 * actual `rows.length` rather than hardcoding three, so a future
 * `STREAK_THRESHOLD` bump (or the SQL LIMIT returning fewer rows than
 * the threshold under an edge case the caller didn't filter) cannot
 * print a lie like "on all three days" against four-row input.
 */
function renderDmMessage(rows: ReadonlyArray<RecentStageBRow>): string {
  const dates = rows
    .map((row) => row.startedAt.slice(0, 10))
    .filter((value, idx, arr) => arr.indexOf(value) === idx)
    .join(" / ");
  const counts = new Map<string, number>();
  for (const row of rows) {
    const reason = row.partialReason ?? "unknown";
    counts.set(reason, (counts.get(reason) ?? 0) + 1);
  }
  const reasonsRendered = [...counts.entries()]
    .map(([reason, count]) => `${reason} × ${count}`)
    .join(", ");
  return [
    `The daily journal authored OK on ${dates} but the model omitted the`,
    `plans/projects/people/tags frontmatter on all ${rows.length} days`,
    `(reasons: ${reasonsRendered}).`,
    `Inspect agent-assets/task-flows/routine.morning_routine_journal.md`,
    `or escalate Stage B's tier from lite to medium under /settings/models.`,
  ].join(" ");
}

/** Exposed for tests — surface the runtime_state key. */
export const PARTIAL_EXTRACT_DEDUP_KEY = RUNTIME_KEY;
