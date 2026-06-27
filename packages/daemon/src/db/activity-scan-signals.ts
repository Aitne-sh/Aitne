/**
 * Stage-0 signal compute for the three-stage activity_scan gate
 * (cost-reduction-structural §B). Pure DB-read shape: every value is
 * derived from existing tables (`observations`, `mail_messages_index`,
 * `agent_schedule`, `agent_actions`) plus the optional today.md content
 * passed in by the caller. No LLM call, no filesystem I/O of its own —
 * the dispatcher injects the today.md snapshot (when available) so this
 * module stays unit-testable from a synthetic Database handle.
 *
 * The shape mirrors the design doc 1:1 so the gate (Stage 1) can be
 * a pure function over `ActivityScanSignals` + a config block.
 */

import type Database from "better-sqlite3";
import {
  buildSourcePrefixFilter,
  type ObservationKind,
} from "@aitne/shared";

/**
 * Build a `(source LIKE 'a:%' OR source LIKE 'b:%' ...)` clause covering
 * every direct-poller and pre-pass-partial prefix for the given kinds.
 * Sourced from `INTEGRATION_DESCRIPTORS` so a new integration shipping
 * with `prePassPartial: "<kind>-acquire.<key>.md"` auto-extends the
 * gate's view of the world. Empty `kinds` yields `(1=0)` (defensive).
 *
 * CLAUDE.md: "Never hardcode an integration reference outside the
 * registry."
 */
function sourceMatchClause(kinds: readonly ObservationKind[]): {
  clause: string;
  values: string[];
} {
  return buildSourcePrefixFilter(kinds);
}

/** All-kinds union — every observation source the gate cares about. */
const ALL_KINDS: readonly ObservationKind[] = [
  "mail",
  "calendar",
  "notion",
  "vault",
  "repo",
];

export interface ActivityScanSignals {
  /** Post dedup-against-today user-actor pending observation count. */
  pendingObsCount: number;
  /**
   * Maximum `novelty_score` across pending user observations whose
   * `summary_status='done'`. `null` when no observation has a done
   * summary yet — the gate treats null as a cautious mid-novelty default
   * (see decideStage).
   */
  maxNoveltyScore: number | null;
  /** Histogram of novelty levels across pending+done observations. */
  noveltyDistribution: { low: number; mid: number; high: number };
  /** Count of unread mail rows whose sender is in the VIP list. */
  vipMailUnreadCount: number;
  /** True when at least one pending calendar observation exists. */
  calendarHas24hChange: boolean;
  /**
   * True when at least two pending calendar observations carry
   * overlapping `start`/`end` ISO timestamps in their JSON payload
   * within the next 24 hours. Tolerant of missing fields — when the
   * payload shape isn't recognizable, returns false (the LLM still
   * sees the underlying observation in Stage 3 if escalated).
   */
  calendarHasConflict: boolean;
  /**
   * Number of `## Agent Plan` rows in today.md whose HH:MM is before
   * `now` in the agent timezone. Best-effort regex parse — when
   * today.md is missing or unparseable, returns 0.
   */
  agentPlanOverdueCount: number;
  /** Count of `agent_schedule` rows due in the next 6 hours. */
  scheduleApproachingCount: number;
  /**
   * Hours since the last activity_scan that escalated to Stage 3 (or
   * before the gate was deployed, since the last activity_scan run at
   * all). `Infinity` when no row has been recorded yet.
   */
  hoursSinceLastStage3Run: number;
}

export interface ComputeActivityScanSignalsOptions {
  /** Owner-VIP mail addresses, lowercased exact-match. */
  vipMailSenders?: readonly string[];
  /** Look-ahead window for `scheduleApproachingCount`. Default 6h. */
  scheduleHorizonHours?: number;
  /** Look-ahead window for calendar conflict detection. Default 24h. */
  calendarHorizonHours?: number;
  /** today.md content snapshot (or null when missing/unreadable). */
  todayMd?: string | null;
  /** Wall-clock anchor — injectable for tests. Defaults to `new Date()`. */
  now?: Date;
  /**
   * Agent timezone (IANA name, e.g. `Asia/Tokyo`) used to compare
   * `## Agent Plan` HH:MM rows against `now`. When omitted, falls back
   * to the JS engine's local timezone — fine in the common single-user
   * deployment but wrong if the daemon runs in UTC and the operator
   * pinned a different `config.timezone`.
   */
  agentTimezone?: string;
}

export function computeActivityScanSignals(
  db: Database.Database,
  options: ComputeActivityScanSignalsOptions = {},
): ActivityScanSignals {
  const now = options.now ?? new Date();
  const vipSenders = (options.vipMailSenders ?? []).map((s) => s.toLowerCase());
  const calendarHorizonMs = (options.calendarHorizonHours ?? 24) * 60 * 60 * 1000;
  const scheduleHorizonHours = options.scheduleHorizonHours ?? 6;

  // Gate filters by `source` (mail/calendar/notion/vault/repo), NEVER by
  // `actor`. Delegated-sync-worker and the routine.fetch_window pre-pass
  // both POST `actor='agent'` rows; the gate must see them as real
  // activity. The 30-min `pre_pass_last_run:<key>` freshness window in
  // `ActivityScanCoordinator.harvestForGate` structurally prevents a
  // single pre-pass row from being re-counted across ticks.
  const allFilter = sourceMatchClause(ALL_KINDS);

  const pending = db
    .prepare(
      `SELECT COUNT(*) AS count
         FROM observations
        WHERE consumed_at IS NULL
          AND ${allFilter.clause}`,
    )
    .get(...allFilter.values) as { count: number };

  const noveltyMaxRow = db
    .prepare(
      `SELECT MAX(novelty_score) AS max_score
         FROM observations
        WHERE consumed_at IS NULL
          AND summary_status = 'done'
          AND novelty_score IS NOT NULL
          AND ${allFilter.clause}`,
    )
    .get(...allFilter.values) as { max_score: number | null };

  const distributionRows = db
    .prepare(
      `SELECT novelty_score AS score, COUNT(*) AS count
         FROM observations
        WHERE consumed_at IS NULL
          AND summary_status = 'done'
          AND novelty_score IS NOT NULL
          AND ${allFilter.clause}
        GROUP BY novelty_score`,
    )
    .all(...allFilter.values) as Array<{ score: number; count: number }>;

  const noveltyDistribution = { low: 0, mid: 0, high: 0 };
  for (const row of distributionRows) {
    if (row.score <= 1) noveltyDistribution.low += row.count;
    else if (row.score === 2) noveltyDistribution.mid += row.count;
    else if (row.score >= 3) noveltyDistribution.high += row.count;
  }

  const vipMailUnreadCount = countVipUnreadMail(db, vipSenders);

  const calendarFilter = sourceMatchClause(["calendar"]);
  const calendarRow = db
    .prepare(
      `SELECT COUNT(*) AS count
         FROM observations
        WHERE consumed_at IS NULL
          AND ${calendarFilter.clause}`,
    )
    .get(...calendarFilter.values) as { count: number };
  const calendarHas24hChange = calendarRow.count > 0;

  const calendarHasConflict = detectCalendarConflict(db, now, calendarHorizonMs);

  const agentPlanOverdueCount = countOverdueAgentPlanRows(
    options.todayMd ?? null,
    now,
    options.agentTimezone,
  );

  const horizon = new Date(now.getTime() + scheduleHorizonHours * 60 * 60 * 1000);
  const scheduleRow = db
    .prepare(
      `SELECT COUNT(*) AS count
         FROM agent_schedule
        WHERE status = 'pending'
          AND scheduled_for >= ?
          AND scheduled_for < ?`,
    )
    .get(toSqliteUtc(now), toSqliteUtc(horizon)) as { count: number };

  const hoursSinceLastStage3Run = computeHoursSinceLastStage3(db, now);

  return {
    pendingObsCount: pending.count,
    maxNoveltyScore: noveltyMaxRow.max_score,
    noveltyDistribution,
    vipMailUnreadCount,
    calendarHas24hChange,
    calendarHasConflict,
    agentPlanOverdueCount,
    scheduleApproachingCount: scheduleRow.count,
    hoursSinceLastStage3Run,
  };
}

function countVipUnreadMail(
  db: Database.Database,
  vipSenders: readonly string[],
): number {
  if (vipSenders.length === 0) return 0;

  // Primary path (delegated / native / direct-with-pre-pass):
  // unread VIP mail rides on `observations` with source prefixes
  // `gmail:%` / `outlook_mail:%` (pre-pass) or `mail:%` (direct
  // aggregate; only carries lifecycle metadata). The pre-pass payload
  // is normalized at the `/api/observations` POST chokepoint to surface
  // `is_read=0` + `from_email=<lowercased>` so this query can read a
  // single canonical shape regardless of provider. We treat a row as
  // VIP-unread when EITHER:
  //   (a) the normalized `is_read=0` + `from_email` keys are present
  //       and match, OR
  //   (b) `is_read` is absent (pre-normalization payload or non-mail
  //       lifecycle row) but `payload.raw.from` is a substring match
  //       for one of the VIP addresses — captures the legacy case
  //       where the partial doesn't emit the normalized keys.
  const mailFilter = sourceMatchClause(["mail"]);
  const senderPlaceholders = vipSenders.map(() => "?").join(",");

  const observationsRow = db
    .prepare(
      `SELECT COUNT(*) AS count
         FROM observations
        WHERE consumed_at IS NULL
          AND ${mailFilter.clause}
          AND COALESCE(json_extract(payload, '$.is_read'), 0) = 0
          AND LOWER(
                COALESCE(
                  json_extract(payload, '$.from_email'),
                  json_extract(payload, '$.raw.from'),
                  json_extract(payload, '$.from'),
                  ''
                )
              ) IN (${senderPlaceholders})`,
    )
    .get(...mailFilter.values, ...vipSenders) as { count: number };
  let observationsCount = observationsRow.count;

  // Substring fallback for `payload.raw.from` shapes like
  // "Foo Bar <foo@bar.com>" — the IN-match above only catches exact
  // address fields. Defensive cap (50 rows) keeps the per-tick cost
  // bounded; tens of unread VIP mails in one window is already a
  // hard-escalate signal regardless of exact count.
  if (observationsCount === 0) {
    const candidateRows = db
      .prepare(
        `SELECT json_extract(payload, '$.raw.from') AS rawFrom
           FROM observations
          WHERE consumed_at IS NULL
            AND ${mailFilter.clause}
            AND COALESCE(json_extract(payload, '$.is_read'), 0) = 0
          LIMIT 50`,
      )
      .all(...mailFilter.values) as Array<{ rawFrom: string | null }>;
    for (const row of candidateRows) {
      if (!row.rawFrom) continue;
      const haystack = row.rawFrom.toLowerCase();
      if (vipSenders.some((s) => haystack.includes(s))) {
        observationsCount += 1;
      }
    }
  }

  // Fallback path (direct mode pre-pre-pass installs whose observations
  // are aggregate `mail:lifecycle` rows without per-message detail).
  // The `mail_messages_index` table carries the canonical `is_read` +
  // `from_email` columns and the MailPoller writes to it on every poll.
  const tableExists = db
    .prepare(
      `SELECT 1 AS present
         FROM sqlite_master
        WHERE type = 'table' AND name = 'mail_messages_index'`,
    )
    .get() as { present: number } | undefined;

  let tableCount = 0;
  if (tableExists) {
    const row = db
      .prepare(
        `SELECT COUNT(*) AS count
           FROM mail_messages_index
          WHERE is_read = 0
            AND deleted_at_utc IS NULL
            AND LOWER(COALESCE(from_email, '')) IN (${senderPlaceholders})`,
      )
      .get(...vipSenders) as { count: number };
    tableCount = row.count;
  }

  return Math.max(observationsCount, tableCount);
}

function detectCalendarConflict(
  db: Database.Database,
  now: Date,
  horizonMs: number,
): boolean {
  // Pull pending calendar observation payloads. We tolerate the common
  // shapes (`start`, `end`, `start.dateTime`, `end.dateTime`) and bail
  // gracefully when neither is recognizable. A "conflict" is two events
  // whose [start, end) ranges intersect within the lookahead window.
  const calendarFilter = sourceMatchClause(["calendar"]);
  const rows = db
    .prepare(
      `SELECT payload
         FROM observations
        WHERE consumed_at IS NULL
          AND payload IS NOT NULL
          AND ${calendarFilter.clause}`,
    )
    .all(...calendarFilter.values) as Array<{ payload: string | null }>;

  type Range = { start: number; end: number };
  const ranges: Range[] = [];
  const horizon = now.getTime() + horizonMs;

  for (const row of rows) {
    if (!row.payload) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.payload);
    } catch {
      continue;
    }
    const range = extractRange(parsed);
    if (!range) continue;
    if (range.end <= now.getTime()) continue;
    if (range.start >= horizon) continue;
    ranges.push(range);
  }

  if (ranges.length < 2) return false;
  ranges.sort((a, b) => a.start - b.start);
  for (let i = 1; i < ranges.length; i++) {
    if (ranges[i].start < ranges[i - 1].end) {
      return true;
    }
  }
  return false;
}

function extractRange(payload: unknown): { start: number; end: number } | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;

  const start = parseTimestamp(
    record["start"] ??
      (typeof record["startTime"] === "string" ? record["startTime"] : undefined) ??
      readNested(record, "start", "dateTime") ??
      readNested(record, "start", "date"),
  );
  const end = parseTimestamp(
    record["end"] ??
      (typeof record["endTime"] === "string" ? record["endTime"] : undefined) ??
      readNested(record, "end", "dateTime") ??
      readNested(record, "end", "date"),
  );
  if (start === null || end === null || end <= start) return null;
  return { start, end };
}

function readNested(
  record: Record<string, unknown>,
  key: string,
  inner: string,
): unknown {
  const child = record[key];
  if (!child || typeof child !== "object") return undefined;
  return (child as Record<string, unknown>)[inner];
}

function parseTimestamp(value: unknown): number | null {
  if (typeof value !== "string" || value.length === 0) return null;
  const ts = Date.parse(value);
  return Number.isFinite(ts) ? ts : null;
}

const AGENT_PLAN_HEADING = /^##\s+Agent Plan\b/i;
const NEXT_HEADING = /^##\s+/;
const PLAN_ROW_TIME = /^[\s>*-]*?(\d{1,2}):(\d{2})\b/;

function countOverdueAgentPlanRows(
  todayMd: string | null,
  now: Date,
  agentTimezone?: string,
): number {
  if (!todayMd) return 0;
  const lines = todayMd.split(/\r?\n/);
  let inPlan = false;
  let count = 0;
  const nowMin = minutesOfDayInTimezone(now, agentTimezone);
  for (const line of lines) {
    if (AGENT_PLAN_HEADING.test(line)) {
      inPlan = true;
      continue;
    }
    if (inPlan && NEXT_HEADING.test(line)) {
      break;
    }
    if (!inPlan) continue;
    const match = PLAN_ROW_TIME.exec(line);
    if (!match) continue;
    const hh = Number(match[1]);
    const mm = Number(match[2]);
    if (!Number.isFinite(hh) || !Number.isFinite(mm)) continue;
    if (hh > 23 || mm > 59) continue;
    const planMin = hh * 60 + mm;
    if (planMin < nowMin) count += 1;
  }
  return count;
}

/**
 * Convert a wall-clock instant into "minutes-of-day in the given IANA
 * timezone". Falls back to the JS engine's local timezone when no zone
 * is supplied or the zone string is invalid — the latter avoids the
 * gate going dark on an operator typo.
 */
function minutesOfDayInTimezone(now: Date, timezone?: string): number {
  if (!timezone) {
    return now.getHours() * 60 + now.getMinutes();
  }
  try {
    const formatter = new Intl.DateTimeFormat("en-GB", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZone: timezone,
    });
    const parts = formatter.formatToParts(now);
    const hh = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
    const mm = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
    if (!Number.isFinite(hh) || !Number.isFinite(mm)) {
      return now.getHours() * 60 + now.getMinutes();
    }
    return hh * 60 + mm;
  } catch {
    return now.getHours() * 60 + now.getMinutes();
  }
}

function computeHoursSinceLastStage3(
  db: Database.Database,
  now: Date,
): number {
  // Prefer the gate-emitted row (`activity_scan.gate` with
  // stage_reached='stage3') — that matches the design doc's "since the
  // last Stage 3 run" semantics. Fall back to the legacy
  // `routine.activity_scan` action-type for installs deployed before
  // the gate was wired. (The `stage3_shadow` marker was removed when
  // the gateMode enum collapsed in HOURLY_CHECK_GATE_REDESIGN_PLAN.md
  // Phase 4 — only the canonical `stage3` is ever written now.)
  // The `hourly_check.*` legacy action types are pre-v0.1.11 rename rows —
  // keep them in the union so the heartbeat window doesn't falsely report
  // "no recent Stage 3" on the first post-upgrade ticks. Safe to drop once
  // the heartbeat lookback (≤48 h) has fully aged past an upgrade.
  const gateRow = db
    .prepare(
      `SELECT started_at
         FROM agent_actions
        WHERE action_type IN ('activity_scan.gate', 'hourly_check.gate')
          AND json_extract(detail, '$.stage_reached') = 'stage3'
        ORDER BY started_at DESC
        LIMIT 1`,
    )
    .get() as { started_at: string | null } | undefined;

  let lastStarted = gateRow?.started_at ?? null;
  if (!lastStarted) {
    const fallbackRow = db
      .prepare(
        `SELECT started_at
           FROM agent_actions
          WHERE action_type IN ('routine.activity_scan', 'routine.hourly_check')
            AND result IN ('success', 'partial', 'failed')
          ORDER BY started_at DESC
          LIMIT 1`,
      )
      .get() as { started_at: string | null } | undefined;
    lastStarted = fallbackRow?.started_at ?? null;
  }
  if (!lastStarted) return Number.POSITIVE_INFINITY;

  const lastUtc = parseSqliteUtc(lastStarted);
  if (lastUtc === null) return Number.POSITIVE_INFINITY;
  const diffMs = now.getTime() - lastUtc;
  if (diffMs <= 0) return 0;
  return diffMs / (60 * 60 * 1000);
}

function toSqliteUtc(date: Date): string {
  // "YYYY-MM-DD HH:MM:SS" — matches CURRENT_TIMESTAMP / datetime('now').
  return date.toISOString().replace("T", " ").slice(0, 19);
}

function parseSqliteUtc(value: string): number | null {
  // Tolerate both "YYYY-MM-DD HH:MM:SS" and ISO 8601.
  const iso = value.includes("T") ? value : value.replace(" ", "T") + "Z";
  const ts = Date.parse(iso);
  return Number.isFinite(ts) ? ts : null;
}
