/**
 * Self-Tuning Review Cycle — Measure stage (SELF_TUNING_REVIEW_CYCLE_DESIGN.md
 * §3.1, Phase 1).
 *
 * The daemon-side, deterministic Measure step ($0 — LLM tokens buy judgment
 * only, P1). On the weekly-review dispatch it computes SQL aggregates over
 * `agent_actions`, `notification_log`, and the `runtime_state` self-tuning
 * ledger for a 7-day window plus a 7-day-prior baseline (trend column), and
 * renders one compact `<self_performance>` block — hard-capped at
 * {@link SELF_PERFORMANCE_MAX_BYTES} — so the weekly review's "Metrics (agent
 * side)" section copies daemon-computed facts instead of paying Sonnet prices
 * to re-count them.
 *
 * Two layers, mirroring `consolidation-prep.ts`:
 *   - {@link gatherSelfPerformanceData} — the single DB read (side-effect
 *     free): per-`action_type` run/cost/duration aggregates (`agent_actions`
 *     has no process_key column; `action_type` carries the routine identity),
 *     the `routine.fetch_window` empty-run rate per integration (from the
 *     fan-out audit rows' `detail.prePass` payload the runner persists), the
 *     `activity_scan.gate` stage distribution (from `buildGateAuditDetail`'s
 *     historical per-tick rows), per-notification-type `user_reaction`
 *     breakdowns (the first reader of the column `signal-detector.ts`
 *     populates), and the `runtime_state.self_tuning:*` ledger.
 *   - {@link buildSelfPerformanceBlock} — pure renderer. Deterministic
 *     byte-capped output: per-section row budgets shrink one row at a time
 *     (largest section first) until the block fits the cap, and clipped rows
 *     surface as `omitted="N"` so truncation is never silent.
 *
 * Phase 1 carries no actuator: nothing here writes config, schedules, or
 * lessons. Later phases (Recommend / Judge / Actuate) consume the same data
 * shape; {@link SELF_TUNING_LEDGER_PREFIX} is exported so the Phase 3
 * actuator writes the ledger keys this module already reads.
 */

import type Database from "better-sqlite3";

import { formatSqliteDatetime } from "@aitne/shared";
import {
  extractMarkdownSection,
  parseLessonsSection,
} from "./lesson-format.js";

/** Measurement window length; the baseline is the same span immediately prior. */
export const SELF_PERFORMANCE_WINDOW_DAYS = 7;

/** §3.1 — hard cap on the rendered `<self_performance>` block, in UTF-8 bytes. */
export const SELF_PERFORMANCE_MAX_BYTES = 1500;

/**
 * §3.4 ledger key prefix. Phase 3's actuator writes
 * `runtime_state.self_tuning:<key> = {prev, applied_at, baselineMetric, rule}`;
 * Phase 1 already reads (and renders) whatever sits under the prefix so the
 * weekly review sees applied changes the cycle they land.
 */
export const SELF_TUNING_LEDGER_PREFIX = "self_tuning:";

/** Fan-out audit rows carry the fetcher event's type as `action_type`. */
export const FETCH_WINDOW_ACTION_TYPE = "routine.fetch_window";

/** Per-tick gate audit rows (`buildGateAuditDetail` payload in `detail`). */
export const ACTIVITY_SCAN_GATE_ACTION_TYPE = "activity_scan.gate";

export interface ActionTypeStats {
  actionType: string;
  runs: number;
  success: number;
  partial: number;
  failed: number;
  skipped: number;
  costUsd: number;
  /** Median over rows with a non-null `duration_ms`; null when none have one. */
  p50DurationMs: number | null;
}

export interface FetchWindowIntegrationStats {
  integrationKey: string;
  /** Completed fan-out attempts (prePass status success|partial). */
  runs: number;
  /** Completed attempts with `fetched=0 ∧ posted=0` (§3.1 empty-run def). */
  empty: number;
}

export interface HourlyGateStats {
  /** Every audited cron tick, including rows whose detail failed to parse. */
  ticks: number;
  stage0: number;
  /**
   * Lite-triage ticks that stayed silent. The writer persists the alias
   * `stage2_log_only` verbatim (`dispatcher-activity-scan.ts:logGateAuditRow`
   * overrides `stage_reached` with the applied decision, and a Stage-2 tick
   * only ever settles to log_only-silent or stage3); a bare `stage2` is
   * accepted defensively but never occurs in production rows.
   */
  stage2: number;
  /**
   * Full-session escalations that actually ran. Rows the legacy
   * min-observations floor short-circuited (`result='skipped'` with
   * `stage_reached='stage3'`) are excluded — no session ran, no spend.
   */
  stage3: number;
  /**
   * …of those, ticks whose `gate_reason` was the low-signal fallback (R3).
   * Forced ticks (`!run` / run-now, `detail.forced=true`) are excluded:
   * they escalate at any signal level and say nothing about the gate.
   */
  stage3LowSignal: number;
  /** …of those, ticks whose snapshot max novelty was ≤ 1 (null counts as ≤1). */
  stage3LowSignalLowNovelty: number;
}

export interface NotificationTypeStats {
  notificationType: string;
  /** Rows with status delivered|batched (suppressed/failed are not "sent"). */
  sent: number;
  replied: number;
  acted: number;
  corrected: number;
  ignored: number;
  /** No-reaction-yet (incl. unrecognised reaction values, clamped ≥ 0). */
  pending: number;
}

export interface SelfPerformanceWindow {
  actions: ActionTypeStats[];
  fetchWindow: FetchWindowIntegrationStats[];
  gate: HourlyGateStats;
  notifications: NotificationTypeStats[];
}

export interface SelfTuningLedgerEntry {
  /** Knob name — the runtime_state key with the prefix stripped. */
  key: string;
  prev: unknown;
  appliedAt: string | null;
  rule: string | null;
  /**
   * §3.4 — the rule's target metric captured at apply time, so the weekly
   * review can compare it against the current `<self_performance>` numbers
   * (the "measured effect" §3.1 asks the ledger section to carry). Absent
   * until Phase 3's actuator writes it.
   */
  baselineMetric?: unknown;
  /**
   * §3.4 — stamped by the Phase 3 auto-revert monitor. Present means the
   * change regressed and was rolled back; the Phase 2 recommender reads it
   * to apply the extended 28-day cool-down (vs the normal 14-day
   * hysteresis) so the apply→revert→re-apply cycle can't flap.
   */
  revertedAt?: string;
  /**
   * §3.4 — stamped by the auto-revert monitor after a clean 7-day verify
   * window (`pass`, `no_baseline`, …). Rendered so the weekly judge can
   * tell a verified-clean change from one still inside its window.
   */
  verifyResult?: string;
}

export interface SelfPerformanceData {
  windowDays: number;
  current: SelfPerformanceWindow;
  baseline: SelfPerformanceWindow;
  ledger: SelfTuningLedgerEntry[];
}

/** §3.5 — lesson-store byte pressure, the standing cost multiplier to watch. */
export interface LessonStoreUtilization {
  /** Canonical scope label — `agent` or `agent:<slug>`. */
  scope: string;
  /** UTF-8 byte size of the `## Lessons` section body (the §6 cap unit). */
  bytes: number;
  capBytes: number;
  entries: number;
  /** Median `ev=` across all entries (R5's evidence signal); null when empty. */
  medianEv: number | null;
}

interface ActionRow {
  actionType: string;
  result: string | null;
  costUsd: number | null;
  durationMs: number | null;
}

interface DetailRow {
  detail: string | null;
}

interface GateRow {
  detail: string | null;
  result: string | null;
}

interface NotificationRow {
  notificationType: string | null;
  userReaction: string | null;
  status: string | null;
}

interface LedgerRow {
  key: string;
  value_json: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const SENT_STATUSES = new Set(["delivered", "batched"]);
const COMPLETED_PREPASS_STATUSES = new Set(["success", "partial"]);
const UNTYPED_NOTIFICATION = "(untyped)";

/** Tolerant JSON parse — a corrupt detail blob degrades to "no data", never a throw. */
function parseJson(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Median over a pre-sorted array; averages the two middle values on even counts. */
function median(sortedAscending: ReadonlyArray<number>): number | null {
  const n = sortedAscending.length;
  if (n === 0) return null;
  const mid = Math.floor(n / 2);
  return n % 2 === 1
    ? sortedAscending[mid]
    : (sortedAscending[mid - 1] + sortedAscending[mid]) / 2;
}

function gatherActions(
  db: Database.Database,
  fromUtc: string,
  toUtc: string,
): ActionTypeStats[] {
  const rows = db
    .prepare(
      `SELECT action_type AS actionType, result,
              cost_usd AS costUsd, duration_ms AS durationMs
         FROM agent_actions
        WHERE started_at >= ? AND started_at < ?`,
    )
    .all(fromUtc, toUtc) as ActionRow[];

  const byType = new Map<
    string,
    Omit<ActionTypeStats, "p50DurationMs"> & { durations: number[] }
  >();
  for (const row of rows) {
    let agg = byType.get(row.actionType);
    if (!agg) {
      agg = {
        actionType: row.actionType,
        runs: 0,
        success: 0,
        partial: 0,
        failed: 0,
        skipped: 0,
        costUsd: 0,
        durations: [],
      };
      byType.set(row.actionType, agg);
    }
    agg.runs += 1;
    // `in_progress` (transient) and NULL results count toward runs only.
    if (row.result === "success") agg.success += 1;
    else if (row.result === "partial") agg.partial += 1;
    else if (row.result === "failed") agg.failed += 1;
    else if (row.result === "skipped") agg.skipped += 1;
    if (typeof row.costUsd === "number") agg.costUsd += row.costUsd;
    if (typeof row.durationMs === "number") agg.durations.push(row.durationMs);
  }

  return [...byType.values()].map(({ durations, ...rest }) => {
    const p50 = median([...durations].sort((a, b) => a - b));
    return {
      ...rest,
      p50DurationMs: p50 === null ? null : Math.round(p50),
    };
  });
}

function gatherFetchWindow(
  db: Database.Database,
  fromUtc: string,
  toUtc: string,
): FetchWindowIntegrationStats[] {
  const rows = db
    .prepare(
      `SELECT detail FROM agent_actions
        WHERE action_type = ? AND started_at >= ? AND started_at < ?
          AND detail IS NOT NULL`,
    )
    .all(FETCH_WINDOW_ACTION_TYPE, fromUtc, toUtc) as DetailRow[];

  const byKey = new Map<string, FetchWindowIntegrationStats>();
  for (const row of rows) {
    const prePass = parseJson(row.detail)?.prePass as
      | Record<string, unknown>
      | undefined;
    if (typeof prePass !== "object" || prePass === null) continue;
    const integrationKey = prePass.integrationKey;
    const status = prePass.status;
    if (typeof integrationKey !== "string") continue;
    if (typeof status !== "string" || !COMPLETED_PREPASS_STATUSES.has(status)) {
      continue;
    }
    const fetched = typeof prePass.fetched === "number" ? prePass.fetched : 0;
    const posted = typeof prePass.posted === "number" ? prePass.posted : 0;
    let agg = byKey.get(integrationKey);
    if (!agg) {
      agg = { integrationKey, runs: 0, empty: 0 };
      byKey.set(integrationKey, agg);
    }
    agg.runs += 1;
    if (fetched === 0 && posted === 0) agg.empty += 1;
  }
  return [...byKey.values()];
}

function gatherGate(
  db: Database.Database,
  fromUtc: string,
  toUtc: string,
): HourlyGateStats {
  const rows = db
    .prepare(
      `SELECT detail, result FROM agent_actions
        WHERE action_type = ? AND started_at >= ? AND started_at < ?`,
    )
    .all(ACTIVITY_SCAN_GATE_ACTION_TYPE, fromUtc, toUtc) as GateRow[];

  const stats: HourlyGateStats = {
    ticks: rows.length,
    stage0: 0,
    stage2: 0,
    stage3: 0,
    stage3LowSignal: 0,
    stage3LowSignalLowNovelty: 0,
  };
  for (const row of rows) {
    const detail = parseJson(row.detail);
    if (!detail) continue; // corrupt/absent detail still counts as a tick
    const stage = detail.stage_reached;
    if (stage === "stage0_silent") {
      stats.stage0 += 1;
      continue;
    }
    // The writer never emits a bare "stage2": a Stage-2 tick settles to
    // either the silent alias "stage2_log_only" or an escalated "stage3"
    // (see HourlyGateStats.stage2). Accept both spellings defensively.
    if (stage === "stage2" || stage === "stage2_log_only") {
      stats.stage2 += 1;
      continue;
    }
    if (stage !== "stage3") continue;
    // Min-observations-floor short-circuit: the gate verdict said stage3
    // but no session ran (`resultOverride: "skipped"` in
    // dispatcher-activity-scan.ts). Count as a tick only.
    if (row.result === "skipped") continue;
    stats.stage3 += 1;
    // R3 waste evidence — autonomous low-signal-fallback escalations only.
    if (detail.gate_reason !== "low_signal_default" || detail.forced === true) {
      continue;
    }
    stats.stage3LowSignal += 1;
    const snapshot = detail.signal_snapshot as
      | Record<string, unknown>
      | undefined;
    const novelty =
      typeof snapshot === "object" && snapshot !== null
        ? snapshot.maxNoveltyScore
        : null;
    // A null / missing novelty means nothing scored above the floor —
    // that is the "≤ 1" waste case R3 measures, so it counts.
    if (typeof novelty !== "number" || novelty <= 1) {
      stats.stage3LowSignalLowNovelty += 1;
    }
  }
  return stats;
}

function gatherNotifications(
  db: Database.Database,
  fromUtc: string,
  toUtc: string,
): NotificationTypeStats[] {
  const rows = db
    .prepare(
      `SELECT notification_type AS notificationType,
              user_reaction AS userReaction, status
         FROM notification_log
        WHERE created_at >= ? AND created_at < ?`,
    )
    .all(fromUtc, toUtc) as NotificationRow[];

  const byType = new Map<string, NotificationTypeStats>();
  for (const row of rows) {
    if (row.status === null || !SENT_STATUSES.has(row.status)) continue;
    const name = row.notificationType ?? UNTYPED_NOTIFICATION;
    let agg = byType.get(name);
    if (!agg) {
      agg = {
        notificationType: name,
        sent: 0,
        replied: 0,
        acted: 0,
        corrected: 0,
        ignored: 0,
        pending: 0,
      };
      byType.set(name, agg);
    }
    agg.sent += 1;
    if (row.userReaction === "replied") agg.replied += 1;
    else if (row.userReaction === "acted") agg.acted += 1;
    else if (row.userReaction === "corrected") agg.corrected += 1;
    else if (row.userReaction === "ignored") agg.ignored += 1;
  }
  for (const agg of byType.values()) {
    // Unrecognised reaction values fall through to "no reaction yet".
    agg.pending = Math.max(
      0,
      agg.sent - agg.replied - agg.acted - agg.corrected - agg.ignored,
    );
  }
  return [...byType.values()];
}

function gatherLedger(db: Database.Database): SelfTuningLedgerEntry[] {
  const rows = db
    .prepare(
      `SELECT key, value_json FROM runtime_state
        WHERE key LIKE ? ORDER BY updated_at DESC, key ASC`,
    )
    .all(`${SELF_TUNING_LEDGER_PREFIX}%`) as LedgerRow[];

  const entries: SelfTuningLedgerEntry[] = [];
  for (const row of rows) {
    const value = parseJson(row.value_json);
    if (!value) continue; // a corrupt ledger blob never breaks the measure pass
    entries.push({
      key: row.key.slice(SELF_TUNING_LEDGER_PREFIX.length),
      prev: value.prev,
      appliedAt: typeof value.applied_at === "string" ? value.applied_at : null,
      rule: typeof value.rule === "string" ? value.rule : null,
      baselineMetric: value.baselineMetric,
      ...(typeof value.reverted_at === "string"
        ? { revertedAt: value.reverted_at }
        : {}),
      ...(typeof value.verify_result === "string"
        ? { verifyResult: value.verify_result }
        : {}),
    });
  }
  return entries;
}

function gatherWindow(
  db: Database.Database,
  fromUtc: string,
  toUtc: string,
): SelfPerformanceWindow {
  return {
    actions: gatherActions(db, fromUtc, toUtc),
    fetchWindow: gatherFetchWindow(db, fromUtc, toUtc),
    gate: gatherGate(db, fromUtc, toUtc),
    notifications: gatherNotifications(db, fromUtc, toUtc),
  };
}

/**
 * The single DB read. Computes the current window `[now − windowDays, now)`
 * and the baseline window `[now − 2·windowDays, now − windowDays)` over
 * `agent_actions` / `notification_log` (both store SQLite UTC
 * `YYYY-MM-DD HH:MM:SS` timestamps, so lexicographic comparison against
 * `formatSqliteDatetime` cutoffs is exact), plus the self-tuning ledger.
 */
export function gatherSelfPerformanceData(
  db: Database.Database,
  opts: { now: Date; windowDays?: number },
): SelfPerformanceData {
  const windowDays = opts.windowDays ?? SELF_PERFORMANCE_WINDOW_DAYS;
  const end = formatSqliteDatetime(opts.now);
  const mid = formatSqliteDatetime(
    new Date(opts.now.getTime() - windowDays * DAY_MS),
  );
  const start = formatSqliteDatetime(
    new Date(opts.now.getTime() - 2 * windowDays * DAY_MS),
  );
  return {
    windowDays,
    current: gatherWindow(db, mid, end),
    baseline: gatherWindow(db, start, mid),
    ledger: gatherLedger(db),
  };
}

/** A2.1 — default cap on notification types in the evening rollup (C3). */
export const OUTCOME_ROLLUP_MAX_TYPES = 8;

/**
 * A2.1 — the evening consolidation's outcome window: per-notification-type
 * reaction stats over the trailing `windowDays` (default 7). Same
 * `notification_log` read the weekly measure uses, single window.
 */
export function gatherOutcomeRollup(
  db: Database.Database,
  opts: { now: Date; windowDays?: number },
): NotificationTypeStats[] {
  const windowDays = opts.windowDays ?? SELF_PERFORMANCE_WINDOW_DAYS;
  const end = formatSqliteDatetime(opts.now);
  const start = formatSqliteDatetime(
    new Date(opts.now.getTime() - windowDays * DAY_MS),
  );
  return gatherNotifications(db, start, end);
}

/** `corrected / (replied + corrected)` to 2dp, or null at zero denominator. */
function correctionRate(stats: NotificationTypeStats): string | null {
  const denominator = stats.replied + stats.corrected;
  if (denominator === 0) return null;
  return (stats.corrected / denominator).toFixed(2);
}

/**
 * A2.1 — render the `<outcome_rollup>` block for the evening
 * `<feedback_worksheet>` (SELF_IMPROVEMENT_PHASE2 §3.1). Pure. Returns null
 * when nothing was sent in the window (no empty block in the prompt).
 *
 * Honest-limits framing baked into the shape: `acted` is omitted (its signal
 * source is dormant), `ignored` stays its own attribute (engagement
 * coverage, never rejection), and `correction_rate` only renders when
 * someone actually responded — silence never produces a rate.
 */
export function renderOutcomeRollup(
  stats: ReadonlyArray<NotificationTypeStats>,
  opts?: { windowDays?: number; maxTypes?: number },
): string | null {
  const windowDays = opts?.windowDays ?? SELF_PERFORMANCE_WINDOW_DAYS;
  const maxTypes = opts?.maxTypes ?? OUTCOME_ROLLUP_MAX_TYPES;
  const sent = stats.filter((type) => type.sent > 0);
  if (sent.length === 0) return null;
  const shown = [...sent]
    .sort(
      (a, b) =>
        b.sent - a.sent || a.notificationType.localeCompare(b.notificationType),
    )
    .slice(0, maxTypes);
  const omitted = sent.length - shown.length;
  const out: string[] = [];
  out.push(
    `  <outcome_rollup window_days="${windowDays}"` +
      (omitted > 0 ? ` omitted="${omitted}"` : "") +
      ` note="correction_rate = corrected/(replied+corrected) over responded ` +
      `deliveries; ignored is engagement-coverage, not rejection">`,
  );
  for (const type of shown) {
    const rate = correctionRate(type);
    out.push(
      `    <type name="${xmlEscape(type.notificationType)}" sent="${type.sent}" ` +
        `replied="${type.replied}" corrected="${type.corrected}" ` +
        `ignored="${type.ignored}"` +
        (rate !== null ? ` correction_rate="${rate}"` : "") +
        " />",
    );
  }
  out.push("  </outcome_rollup>");
  return out.join("\n");
}

/**
 * §3.5 — summarise one lesson store's byte pressure from its raw file
 * contents. Pure (the caller does the FS read); a file with no `## Lessons`
 * section degrades to an empty store, never a throw. `medianEv` carries the
 * evidence signal R5's Phase 2 rule keys on (utilization > 90% with median
 * evidence ≤ 1), so the measurement lands one phase ahead of the rule.
 */
export function summarizeLessonStoreUtilization(
  scope: string,
  fileMd: string,
  capBytes: number,
): LessonStoreUtilization {
  const sectionBody = extractMarkdownSection(fileMd, "Lessons");
  const lessons = sectionBody ? parseLessonsSection(sectionBody) : [];
  const bytes = sectionBody ? Buffer.byteLength(sectionBody, "utf-8") : 0;
  const medianEv = median(
    lessons.map((lesson) => lesson.ev).sort((a, b) => a - b),
  );
  return { scope, bytes, capBytes, entries: lessons.length, medianEv };
}

// ── Renderer ────────────────────────────────────────────────────────────────

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Compact USD: at most 4 decimal places, no trailing zeros. */
function usd(value: number): string {
  return String(Math.round(value * 10000) / 10000);
}

/** Integer percent; callers guarantee `denominator > 0`. */
function pct(numerator: number, denominator: number): string {
  return `${Math.round((100 * numerator) / denominator)}%`;
}

/** One-line inline value for a ledger `prev=` attribute. */
function inlineValue(value: unknown): string {
  // JSON.stringify returns runtime `undefined` for `undefined` input even
  // though its declared type is `string` — normalise to "null".
  const json = JSON.stringify(value) as string | undefined;
  const raw = typeof value === "string" ? value : json === undefined ? "null" : json;
  return xmlEscape(raw.length > 60 ? `${raw.slice(0, 59)}…` : raw);
}

interface SectionBudget {
  actions: number;
  fetchWindow: number;
  notifications: number;
  lessonStores: number;
  ledger: number;
}

const INITIAL_BUDGET: SectionBudget = {
  actions: 8,
  fetchWindow: 8,
  notifications: 6,
  lessonStores: 6,
  ledger: 3,
};

/** Drop order when two sections render the same row count (ties only). */
const SHRINK_TIE_ORDER: ReadonlyArray<keyof SectionBudget> = [
  "notifications",
  "lessonStores",
  "actions",
  "fetchWindow",
  "ledger",
];

function findActionBaseline(
  baseline: SelfPerformanceWindow,
  actionType: string,
): ActionTypeStats | undefined {
  return baseline.actions.find((entry) => entry.actionType === actionType);
}

function renderBlock(
  data: SelfPerformanceData,
  lessonStores: ReadonlyArray<LessonStoreUtilization>,
  budget: SectionBudget,
  generatedAt: string,
): string {
  const { current, baseline, ledger } = data;
  const out: string[] = [];
  out.push(
    `<self_performance generated_at="${xmlEscape(generatedAt)}" ` +
      `window_days="${data.windowDays}" baseline="prior_${data.windowDays}d">`,
  );

  // Totals span ALL rows — they are what the weekly task-flow's
  // "Metrics (agent side)" lines copy, so they must not depend on which
  // per-type rows survived the byte budget below.
  const sum = (window: SelfPerformanceWindow) =>
    window.actions.reduce(
      (acc, a) => ({
        runs: acc.runs + a.runs,
        failed: acc.failed + a.failed,
        cost: acc.cost + a.costUsd,
      }),
      { runs: 0, failed: 0, cost: 0 },
    );
  const cur = sum(current);
  const prev = sum(baseline);
  const notifSent = current.notifications.reduce((n, t) => n + t.sent, 0);
  const notifIgnored = current.notifications.reduce((n, t) => n + t.ignored, 0);
  const prevNotifSent = baseline.notifications.reduce((n, t) => n + t.sent, 0);
  out.push(
    `  <totals runs="${cur.runs}" failed="${cur.failed}" ` +
      `cost_usd="${usd(cur.cost)}" prev_runs="${prev.runs}" ` +
      `prev_failed="${prev.failed}" prev_cost_usd="${usd(prev.cost)}" ` +
      `notif_sent="${notifSent}" notif_ignored="${notifIgnored}" ` +
      `prev_notif_sent="${prevNotifSent}" />`,
  );

  const actions = [...current.actions].sort(
    (a, b) =>
      b.costUsd - a.costUsd ||
      b.runs - a.runs ||
      a.actionType.localeCompare(b.actionType),
  );
  const shownActions = actions.slice(0, budget.actions);
  if (shownActions.length > 0) {
    const omitted = actions.length - shownActions.length;
    out.push(
      `  <actions ranked="cost_desc"${omitted > 0 ? ` omitted="${omitted}"` : ""}>`,
    );
    for (const action of shownActions) {
      const prevAction = findActionBaseline(baseline, action.actionType);
      out.push(
        `    <a t="${xmlEscape(action.actionType)}" runs="${action.runs}" ` +
          `ok="${action.success}"` +
          (action.partial > 0 ? ` part="${action.partial}"` : "") +
          ` fail="${action.failed}" skip="${action.skipped}" ` +
          `cost_usd="${usd(action.costUsd)}"` +
          (action.p50DurationMs !== null
            ? ` p50_ms="${action.p50DurationMs}"`
            : "") +
          ` prev_runs="${prevAction?.runs ?? 0}" ` +
          `prev_cost_usd="${usd(prevAction?.costUsd ?? 0)}" />`,
      );
    }
    out.push("  </actions>");
  }

  const integrations = [...current.fetchWindow].sort(
    (a, b) =>
      b.runs - a.runs || a.integrationKey.localeCompare(b.integrationKey),
  );
  const shownIntegrations = integrations.slice(0, budget.fetchWindow);
  if (shownIntegrations.length > 0) {
    const omitted = integrations.length - shownIntegrations.length;
    out.push(
      `  <fetch_window_empty note="empty = completed pre-pass run, nothing fetched/posted"` +
        `${omitted > 0 ? ` omitted="${omitted}"` : ""}>`,
    );
    for (const integration of shownIntegrations) {
      const prevIntegration = baseline.fetchWindow.find(
        (entry) => entry.integrationKey === integration.integrationKey,
      );
      out.push(
        `    <i k="${xmlEscape(integration.integrationKey)}" ` +
          `runs="${integration.runs}" empty="${integration.empty}" ` +
          `rate="${pct(integration.empty, integration.runs)}"` +
          (prevIntegration && prevIntegration.runs > 0
            ? ` prev_rate="${pct(prevIntegration.empty, prevIntegration.runs)}"`
            : "") +
          " />",
      );
    }
    out.push("  </fetch_window_empty>");
  }

  if (current.gate.ticks > 0 || baseline.gate.ticks > 0) {
    out.push(
      `  <hourly_gate ticks="${current.gate.ticks}" ` +
        `stage0="${current.gate.stage0}" stage2="${current.gate.stage2}" ` +
        `stage3="${current.gate.stage3}" ` +
        `stage3_low_signal="${current.gate.stage3LowSignal}" ` +
        `stage3_low_signal_novelty_le1="${current.gate.stage3LowSignalLowNovelty}" ` +
        `prev_ticks="${baseline.gate.ticks}" ` +
        `prev_stage3="${baseline.gate.stage3}" />`,
    );
  }

  const notifications = [...current.notifications].sort(
    (a, b) =>
      b.sent - a.sent || a.notificationType.localeCompare(b.notificationType),
  );
  const shownNotifications = notifications.slice(0, budget.notifications);
  if (shownNotifications.length > 0) {
    const omitted = notifications.length - shownNotifications.length;
    out.push(
      `  <notifications${omitted > 0 ? ` omitted="${omitted}"` : ""}>`,
    );
    for (const type of shownNotifications) {
      const rate = correctionRate(type);
      out.push(
        `    <n t="${xmlEscape(type.notificationType)}" sent="${type.sent}" ` +
          `replied="${type.replied}" acted="${type.acted}" ` +
          `corrected="${type.corrected}" ignored="${type.ignored}" ` +
          `pending="${type.pending}"` +
          (rate !== null ? ` correction_rate="${rate}"` : "") +
          " />",
      );
    }
    out.push("  </notifications>");
  }

  const stores = [...lessonStores].sort(
    (a, b) =>
      (b.capBytes > 0 ? b.bytes / b.capBytes : 0) -
        (a.capBytes > 0 ? a.bytes / a.capBytes : 0) ||
      a.scope.localeCompare(b.scope),
  );
  const shownStores = stores.slice(0, budget.lessonStores);
  if (shownStores.length > 0) {
    const omitted = stores.length - shownStores.length;
    out.push(
      `  <lesson_stores${omitted > 0 ? ` omitted="${omitted}"` : ""}>`,
    );
    for (const store of shownStores) {
      out.push(
        `    <s scope="${xmlEscape(store.scope)}" bytes="${store.bytes}" ` +
          `cap="${store.capBytes}"` +
          (store.capBytes > 0
            ? ` util="${pct(store.bytes, store.capBytes)}"`
            : "") +
          ` entries="${store.entries}"` +
          (store.medianEv !== null ? ` median_ev="${store.medianEv}"` : "") +
          " />",
      );
    }
    out.push("  </lesson_stores>");
  }

  const shownLedger = ledger.slice(0, budget.ledger);
  if (shownLedger.length > 0) {
    const omitted = ledger.length - shownLedger.length;
    out.push(
      `  <tuning_ledger${omitted > 0 ? ` omitted="${omitted}"` : ""}>`,
    );
    for (const entry of shownLedger) {
      out.push(
        `    <c key="${xmlEscape(entry.key)}" prev="${inlineValue(entry.prev)}"` +
          (entry.appliedAt
            ? ` applied_at="${xmlEscape(entry.appliedAt)}"`
            : "") +
          (entry.rule ? ` rule="${xmlEscape(entry.rule)}"` : "") +
          (entry.baselineMetric !== undefined && entry.baselineMetric !== null
            ? ` baseline="${inlineValue(entry.baselineMetric)}"`
            : "") +
          // §3.1 "measured effect" — the judge must see that a change was
          // rolled back (key now in the 28d cool-down) or verified clean,
          // not just that it was applied.
          (entry.revertedAt
            ? ` reverted_at="${xmlEscape(entry.revertedAt)}"`
            : "") +
          (entry.verifyResult
            ? ` verified="${xmlEscape(entry.verifyResult)}"`
            : "") +
          " />",
      );
    }
    out.push("  </tuning_ledger>");
  }

  out.push("</self_performance>");
  return out.join("\n");
}

/**
 * Compose the `<self_performance>` block. Returns `null` when there is no
 * telemetry at all (fresh install) so the caller stamps nothing — no empty
 * block in the prompt. The byte cap is a hard guarantee: row budgets shrink
 * until the block fits; in the (synthetic) case where even the skeleton
 * exceeds the cap, a minimal self-closing element is emitted instead.
 */
export function buildSelfPerformanceBlock(
  data: SelfPerformanceData,
  opts: {
    generatedAt: string;
    lessonStores?: ReadonlyArray<LessonStoreUtilization>;
    maxBytes?: number;
  },
): string | null {
  const hasData =
    data.current.actions.length > 0 ||
    data.baseline.actions.length > 0 ||
    data.current.notifications.length > 0 ||
    data.baseline.notifications.length > 0 ||
    data.current.gate.ticks > 0 ||
    data.baseline.gate.ticks > 0 ||
    data.ledger.length > 0;
  if (!hasData) return null;

  const lessonStores = opts.lessonStores ?? [];
  const maxBytes = opts.maxBytes ?? SELF_PERFORMANCE_MAX_BYTES;
  const budget: SectionBudget = { ...INITIAL_BUDGET };
  const available: SectionBudget = {
    actions: data.current.actions.length,
    fetchWindow: data.current.fetchWindow.length,
    notifications: data.current.notifications.length,
    lessonStores: lessonStores.length,
    ledger: data.ledger.length,
  };
  const effectiveRows = (key: keyof SectionBudget): number =>
    Math.min(budget[key], available[key]);

  let block = renderBlock(data, lessonStores, budget, opts.generatedAt);
  while (Buffer.byteLength(block, "utf-8") > maxBytes) {
    let target: keyof SectionBudget | null = null;
    for (const key of SHRINK_TIE_ORDER) {
      if (effectiveRows(key) === 0) continue;
      if (target === null || effectiveRows(key) > effectiveRows(target)) {
        target = key;
      }
    }
    if (target === null) {
      // Even the row-free skeleton exceeds the cap (only reachable with a
      // tiny custom maxBytes) — degrade to the minimal stub element.
      return (
        `<self_performance generated_at="${xmlEscape(opts.generatedAt)}" ` +
        `window_days="${data.windowDays}" overflow="true" />`
      );
    }
    budget[target] = effectiveRows(target) - 1;
    block = renderBlock(data, lessonStores, budget, opts.generatedAt);
  }
  return block;
}
