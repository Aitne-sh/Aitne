/**
 * Self-Tuning Review Cycle — Recommend stage (SELF_TUNING_REVIEW_CYCLE_DESIGN.md
 * §3.2, Phase 2).
 *
 * The daemon-side, deterministic Recommend step ($0 — LLM tokens buy judgment
 * only, P1). On the weekly-review dispatch it consumes the same
 * {@link SelfPerformanceData} the Measure stage (§3.1) already gathered —
 * current + baseline window = the 14-day evidence span the v1 rules read —
 * and emits at most {@link MAX_RECOMMENDATIONS_PER_CYCLE} bounded
 * `TuningRecommendation`s, rendered as one `<tuning_recommendations>` block
 * for the weekly session's Phase 3c verdict step (§3.3).
 *
 * Guards live in code, not prompt (§3.2): per-rule ladders with hard
 * floors/caps, hysteresis (no re-proposal of a key changed < 14 days ago;
 * 28 days after a revert), minimum sample sizes, and the max-3 ranking by
 * estimated $ impact. Numeric *enforcement* stays where it already lives —
 * `runtimeSettingsSchema` + `env-writer.ts:NUMERIC_RANGE` behind the
 * `applyConfigUpdates` chokepoint (P4); the `bounds` field on a
 * recommendation documents the rule's own ladder, it is not a third copy of
 * the schema bounds.
 *
 * The shadow period (§7): recommendations are generated, persisted under
 * {@link TUNING_PENDING_CYCLE_STATE_KEY}, and verdicted via
 * `POST /api/tuning/verdicts`. While `selfTuningEnabled` is `false` (the
 * shipped default) nothing is actuated; once flipped, the Phase 3 actuator
 * (`tuning-actuator.ts`) applies `apply` verdicts through the config
 * chokepoint. Verdict ids are single-use: each weekly cycle overwrites the
 * pending blob, expiring the prior cycle's ids (§3.4).
 */

import type Database from "better-sqlite3";

import type {
  ActionTypeStats,
  FetchWindowIntegrationStats,
  HourlyGateStats,
  LessonStoreUtilization,
  NotificationTypeStats,
  SelfPerformanceData,
  SelfPerformanceWindow,
  SelfTuningLedgerEntry,
} from "./self-performance-prep.js";
import { FETCH_WINDOW_ACTION_TYPE } from "./self-performance-prep.js";

/**
 * §3.4 — runtime_state key for the current cycle's pending recommendations
 * + verdicts. Deliberately uses a `.` separator, NOT the
 * `SELF_TUNING_LEDGER_PREFIX` (`self_tuning:`) namespace — the Measure
 * stage's `gatherLedger` does a `LIKE 'self_tuning:%'` scan and must never
 * pick the pending blob up as a phantom ledger entry.
 */
export const TUNING_PENDING_CYCLE_STATE_KEY = "self_tuning.pending_cycle";

/** §3.2 — max recommendations per weekly cycle, ranked by estimated $ impact. */
export const MAX_RECOMMENDATIONS_PER_CYCLE = 3;

/** §3.2 — no re-proposal of a key changed less than this many days ago. */
export const TUNING_HYSTERESIS_DAYS = 14;

/** §3.4 — extended cool-down after an auto-revert, so apply→revert can't flap. */
export const TUNING_REVERT_COOLDOWN_DAYS = 28;

// ── R1 (pre-pass freshness) ─────────────────────────────────────────────────
export const R1_KNOB = "hourlyCheckPrePassFreshnessMinutes";
export const R1_EMPTY_RATE_STEP_UP = 0.7;
export const R1_EMPTY_RATE_STEP_DOWN = 0.2;
export const R1_MIN_RUNS = 10;
/**
 * §3.2 — the freshness ladder. Step up = smallest notch above the current
 * value (cap 480); step down = largest notch below it (floor 120). Today's
 * schema caps the knob at 240 — the 360/480 notches become appliable when
 * Phase 3 widens `.max()` to 480 (§6); in the Phase 2 shadow period they are
 * recorded-and-judged only, so proposing them is safe.
 */
export const R1_FRESHNESS_NOTCHES = [120, 240, 360, 480] as const;

// ── R2 (notification throttle — lesson-mediated in v1) ─────────────────────
export const R2_IGNORED_RATE = 0.6;
export const R2_MIN_SENT = 5;
/**
 * The loop's own DM channel — apply notices ("Reply `!revert tuning` to
 * undo") and auto-revert notices land in `notification_log` under this
 * type. R2 must never propose demoting it: the per-change DM is the D1/D6
 * safety invariant (daemon-sent, mandatory, deliberately not a tunable
 * notification surface), so an owner who lets those DMs sit unreacted
 * would otherwise have the loop spend one of its max-3 weekly slots
 * recommending that its own safety channel go quiet.
 */
export const SELF_TUNING_NOTIFICATION_TYPE = "self_tuning";

// ── R3 (hourly-gate tightening) ─────────────────────────────────────────────
export const R3_KNOB = "hourlyCheckLowSignalPendingCeiling";
export const R3_LOW_NOVELTY_SHARE = 0.5;
/** Minimum stage-3 escalations over 14d before the share is meaningful. */
export const R3_MIN_STAGE3 = 4;
/**
 * Conservative ladder for the silent-skip band. The schema allows up to 20;
 * the rule never proposes past 8 — a wider band is an operator decision.
 */
export const R3_CEILING_NOTCHES = [2, 4, 8] as const;

// ── R5 (lesson-store byte budget, §3.5) ─────────────────────────────────────
export const R5_KNOB = "feedbackLessonMaxBytesGlobal";
export const R5_UTILIZATION_THRESHOLD = 0.9;
export const R5_MEDIAN_EV_CEILING = 1;
/** Floor for the R5 step-down; matches the per-agent default cap. */
export const R5_MIN_BYTES = 4096;
/** R5 proposes a 25% reduction, rounded down to a 1 KiB multiple. */
export const R5_STEP_FACTOR = 0.75;
const R5_ROUNDING_BYTES = 1024;

export type TuningRuleId = "R1" | "R2" | "R3" | "R4" | "R5";

/**
 * What the Actuate stage would touch. `config` → `applyConfigUpdates`
 * chokepoint (Phase 3); `lesson` → consumed as task-flow guidance via the
 * existing lesson loop (R2 v1 — no per-type knob exists yet, §3.2);
 * `schedule` → `recurring_schedules.enabled` flag (R4, propose-only in v1).
 */
export type TuningActuator = "config" | "lesson" | "schedule";

export interface TuningRecommendation {
  /** Daemon-generated, single-use id: `<cycleId>:<rule>:<key>`. */
  id: string;
  rule: TuningRuleId;
  actuator: TuningActuator;
  /** Config knob name, `notification:<type>`, or `recurring_schedules:<id>`. */
  key: string;
  currentValue: number | string;
  proposedValue: number | string;
  /**
   * The rule's own ladder floor/cap — informational for the judge. Numeric
   * enforcement stays in `runtimeSettingsSchema` / `env-writer.ts` (P4).
   */
  bounds: { min: number; max: number } | null;
  /** One-line, number-bearing evidence string (≤ {@link MAX_EVIDENCE_CHARS}). */
  evidence: string;
  /** Deterministic heuristic, used only for the max-3 ranking. */
  estWeeklySavingUsd: number;
}

export type TuningVerdict = "apply" | "reject" | "defer";

export interface TuningVerdictRecord {
  verdict: TuningVerdict;
  reason: string;
  recordedAt: string;
}

export interface PendingTuningCycle {
  /** ISO date of the generating weekly run — doubles as the id namespace. */
  cycleId: string;
  generatedAt: string;
  recommendations: TuningRecommendation[];
  /** Verdicts recorded so far, keyed by recommendation id. */
  verdicts: Record<string, TuningVerdictRecord>;
}

/** R4 input row — gathered by {@link gatherFailingRecurringSchedules}. */
export interface FailingRecurringSchedule {
  id: number;
  taskType: string;
  description: string | null;
  /** Length of the trailing all-failed streak (= the qualifying window, 3). */
  lastFailures: number;
}

export interface TuningKnobValues {
  hourlyCheckPrePassFreshnessMinutes: number;
  hourlyCheckLowSignalPendingCeiling: number;
  feedbackLessonMaxBytesGlobal: number;
}

export interface TuningRecommenderInput {
  /** Measure-stage output; current + baseline = the 14-day evidence span. */
  data: SelfPerformanceData;
  knobs: TuningKnobValues;
  /** §3.5 store-side byte pressure; only the global `agent` scope feeds R5. */
  lessonStores?: ReadonlyArray<LessonStoreUtilization>;
  failingSchedules?: ReadonlyArray<FailingRecurringSchedule>;
  now: Date;
}

export const MAX_EVIDENCE_CHARS = 200;

const DAY_MS = 24 * 60 * 60 * 1000;
const RULE_ORDER: Record<TuningRuleId, number> = { R1: 0, R2: 1, R3: 2, R4: 3, R5: 4 };

function truncateEvidence(value: string): string {
  return value.length <= MAX_EVIDENCE_CHARS
    ? value
    : `${value.slice(0, MAX_EVIDENCE_CHARS - 1)}…`;
}

function pctLabel(numerator: number, denominator: number): string {
  return `${Math.round((100 * numerator) / denominator)}%`;
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}

/**
 * Tolerant timestamp parse for ledger `applied_at` / `reverted_at` values.
 * Accepts ISO 8601 and SQLite `YYYY-MM-DD HH:MM:SS` (read as UTC). An
 * unparseable value returns null — the hysteresis check treats that as
 * "recently changed" (blocking) because an unverifiable timestamp must not
 * silently unlock a re-proposal.
 */
function parseLedgerTimestamp(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const sqliteShaped = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(raw);
  const ms = Date.parse(sqliteShaped ? `${raw.replace(" ", "T")}Z` : raw);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * §3.2 hysteresis guard. A key with a ledger entry applied within
 * {@link TUNING_HYSTERESIS_DAYS} (or reverted within
 * {@link TUNING_REVERT_COOLDOWN_DAYS}) is off the table this cycle. A ledger
 * entry whose timestamps fail to parse blocks conservatively.
 */
export function isKeyInCooldown(
  ledger: ReadonlyArray<SelfTuningLedgerEntry>,
  key: string,
  now: Date,
): boolean {
  for (const entry of ledger) {
    if (entry.key !== key) continue;
    const revertedMs = parseLedgerTimestamp(entry.revertedAt);
    if (revertedMs !== null) {
      if (now.getTime() - revertedMs < TUNING_REVERT_COOLDOWN_DAYS * DAY_MS) {
        return true;
      }
      continue; // old revert — the apply that preceded it is older still
    }
    const appliedMs = parseLedgerTimestamp(entry.appliedAt);
    if (appliedMs === null) return true; // unverifiable → block
    if (now.getTime() - appliedMs < TUNING_HYSTERESIS_DAYS * DAY_MS) return true;
  }
  return false;
}

// ── 14-day window combinators ───────────────────────────────────────────────

function combineFetchWindow(
  current: SelfPerformanceWindow,
  baseline: SelfPerformanceWindow,
): FetchWindowIntegrationStats[] {
  const byKey = new Map<string, FetchWindowIntegrationStats>();
  for (const list of [current.fetchWindow, baseline.fetchWindow]) {
    for (const row of list) {
      const agg = byKey.get(row.integrationKey) ?? {
        integrationKey: row.integrationKey,
        runs: 0,
        empty: 0,
      };
      agg.runs += row.runs;
      agg.empty += row.empty;
      byKey.set(row.integrationKey, agg);
    }
  }
  return [...byKey.values()];
}

function combineGate(
  current: SelfPerformanceWindow,
  baseline: SelfPerformanceWindow,
): HourlyGateStats {
  const sum = (pick: (g: HourlyGateStats) => number): number =>
    pick(current.gate) + pick(baseline.gate);
  return {
    ticks: sum((g) => g.ticks),
    stage0: sum((g) => g.stage0),
    stage2: sum((g) => g.stage2),
    stage3: sum((g) => g.stage3),
    stage3LowSignal: sum((g) => g.stage3LowSignal),
    stage3LowSignalLowNovelty: sum((g) => g.stage3LowSignalLowNovelty),
  };
}

function combineNotifications(
  current: SelfPerformanceWindow,
  baseline: SelfPerformanceWindow,
): NotificationTypeStats[] {
  const byType = new Map<string, NotificationTypeStats>();
  for (const list of [current.notifications, baseline.notifications]) {
    for (const row of list) {
      const agg = byType.get(row.notificationType) ?? {
        notificationType: row.notificationType,
        sent: 0,
        replied: 0,
        acted: 0,
        corrected: 0,
        ignored: 0,
        pending: 0,
      };
      agg.sent += row.sent;
      agg.replied += row.replied;
      agg.acted += row.acted;
      agg.corrected += row.corrected;
      agg.ignored += row.ignored;
      agg.pending += row.pending;
      byType.set(row.notificationType, agg);
    }
  }
  return [...byType.values()];
}

/** Mean cost per run for one action_type across both windows; 0 when unseen. */
function avgCostPerRun(data: SelfPerformanceData, actionType: string): number {
  let runs = 0;
  let cost = 0;
  for (const window of [data.current, data.baseline]) {
    const row = window.actions.find(
      (a: ActionTypeStats) => a.actionType === actionType,
    );
    if (!row) continue;
    runs += row.runs;
    cost += row.costUsd;
  }
  return runs > 0 ? cost / runs : 0;
}

// ── Ladder steppers (exported for direct unit coverage) ─────────────────────

/** Smallest notch strictly above `current`, or null at/above the cap. */
export function stepUpNotch(
  notches: ReadonlyArray<number>,
  current: number,
): number | null {
  for (const notch of notches) if (notch > current) return notch;
  return null;
}

/** Largest notch strictly below `current`, or null at/below the floor. */
export function stepDownNotch(
  notches: ReadonlyArray<number>,
  current: number,
): number | null {
  for (let i = notches.length - 1; i >= 0; i--) {
    if (notches[i] < current) return notches[i];
  }
  return null;
}

// ── Rules ───────────────────────────────────────────────────────────────────

function makeId(cycleId: string, rule: TuningRuleId, key: string): string {
  return `${cycleId}:${rule}:${key}`;
}

/**
 * R1 — pre-pass freshness. The knob is global while the measurement is
 * per-integration (§8 open question); v1 fires on the **run-weighted
 * aggregate** empty-rate across qualifying integrations (n ≥
 * {@link R1_MIN_RUNS} each) — the same "72% of runs were empty" overall
 * framing that produced the manual freshness=240 fix — and cites the worst
 * single integration in the evidence line.
 */
function ruleR1(
  cycleId: string,
  data: SelfPerformanceData,
  knobs: TuningKnobValues,
): TuningRecommendation | null {
  const combined = combineFetchWindow(data.current, data.baseline).filter(
    (row) => row.runs >= R1_MIN_RUNS,
  );
  if (combined.length === 0) return null;
  const runs = combined.reduce((n, r) => n + r.runs, 0);
  const empty = combined.reduce((n, r) => n + r.empty, 0);
  const rate = empty / runs;

  const current = knobs.hourlyCheckPrePassFreshnessMinutes;
  let proposed: number | null = null;
  if (rate > R1_EMPTY_RATE_STEP_UP) {
    proposed = stepUpNotch(R1_FRESHNESS_NOTCHES, current);
  } else if (rate < R1_EMPTY_RATE_STEP_DOWN) {
    proposed = stepDownNotch(R1_FRESHNESS_NOTCHES, current);
  }
  if (proposed === null) return null;

  const worst = [...combined].sort(
    (a, b) =>
      b.empty / b.runs - a.empty / a.runs ||
      a.integrationKey.localeCompare(b.integrationKey),
  )[0];
  const direction = proposed > current ? "raise" : "lower";
  // Heuristic: a step-up roughly halves the empty-run share it can reach;
  // a step-down's value is responsiveness, not $ — rank it by 0.
  const estWeeklySavingUsd =
    proposed > current
      ? round4((empty / 2) * avgCostPerRun(data, FETCH_WINDOW_ACTION_TYPE) * 0.5)
      : 0;
  return {
    id: makeId(cycleId, "R1", R1_KNOB),
    rule: "R1",
    actuator: "config",
    key: R1_KNOB,
    currentValue: current,
    proposedValue: proposed,
    bounds: {
      min: R1_FRESHNESS_NOTCHES[0],
      max: R1_FRESHNESS_NOTCHES[R1_FRESHNESS_NOTCHES.length - 1],
    },
    evidence: truncateEvidence(
      `fetch_window ${pctLabel(empty, runs)} empty over ${runs} runs/14d ` +
        `(worst: ${worst.integrationKey} ${pctLabel(worst.empty, worst.runs)}) — ${direction} freshness`,
    ),
    estWeeklySavingUsd,
  };
}

/**
 * R2 — notification throttle, lesson-mediated in v1 (§3.2): no per-type
 * digest/silent knob exists, so the recommendation's actuator is `lesson` —
 * an apply verdict feeds task-flow guidance through the existing lesson
 * loop rather than any config write. One recommendation per qualifying
 * type (the max-3 ranking keeps the block bounded).
 */
function ruleR2(
  cycleId: string,
  data: SelfPerformanceData,
): TuningRecommendation[] {
  const out: TuningRecommendation[] = [];
  for (const type of combineNotifications(data.current, data.baseline)) {
    // The loop's own mandatory DM channel is not a demotion candidate —
    // see SELF_TUNING_NOTIFICATION_TYPE.
    if (type.notificationType === SELF_TUNING_NOTIFICATION_TYPE) continue;
    if (type.sent < R2_MIN_SENT) continue;
    if (type.ignored / type.sent <= R2_IGNORED_RATE) continue;
    out.push({
      id: makeId(cycleId, "R2", `notification:${type.notificationType}`),
      rule: "R2",
      actuator: "lesson",
      key: `notification:${type.notificationType}`,
      currentValue: "send",
      proposedValue: "demote (batch into digests / silence unless user-actionable)",
      bounds: null,
      evidence: truncateEvidence(
        `${type.notificationType}: ${type.ignored}/${type.sent} ignored ` +
          `(${pctLabel(type.ignored, type.sent)}) over 14d`,
      ),
      estWeeklySavingUsd: 0,
    });
  }
  return out;
}

/**
 * R3 — hourly-gate tightening. Counts only the autonomous
 * `low_signal_default` fallback escalations (legitimate VIP-mail /
 * calendar-conflict escalations and forced ticks are excluded upstream by
 * the Measure stage, §3.1) and steps up the existing silent-skip band knob.
 * Zero new gate code by design (§3.2).
 */
function ruleR3(
  cycleId: string,
  data: SelfPerformanceData,
  knobs: TuningKnobValues,
): TuningRecommendation | null {
  const gate = combineGate(data.current, data.baseline);
  if (gate.stage3 < R3_MIN_STAGE3) return null;
  if (gate.stage3LowSignalLowNovelty / gate.stage3 <= R3_LOW_NOVELTY_SHARE) {
    return null;
  }
  const current = knobs.hourlyCheckLowSignalPendingCeiling;
  const proposed = stepUpNotch(R3_CEILING_NOTCHES, current);
  if (proposed === null) return null;
  return {
    id: makeId(cycleId, "R3", R3_KNOB),
    rule: "R3",
    actuator: "config",
    key: R3_KNOB,
    currentValue: current,
    proposedValue: proposed,
    bounds: { min: 0, max: R3_CEILING_NOTCHES[R3_CEILING_NOTCHES.length - 1] },
    evidence: truncateEvidence(
      `${gate.stage3LowSignalLowNovelty}/${gate.stage3} stage3 escalations were ` +
        `low_signal_default with novelty<=1 over 14d`,
    ),
    estWeeklySavingUsd: round4(
      (gate.stage3LowSignalLowNovelty / 2) *
        avgCostPerRun(data, "routine.hourly_check"),
    ),
  };
}

/**
 * R4 — schedule hygiene. Propose-only in v1 (§3.2 / §8): no provenance
 * column distinguishes agent-created rows, so an apply verdict still means
 * "the owner flips `recurring_schedules.enabled` by hand". Built-in cron
 * routines never appear here — they have no `recurring_schedule_id` parent.
 */
function ruleR4(
  cycleId: string,
  failingSchedules: ReadonlyArray<FailingRecurringSchedule>,
): TuningRecommendation[] {
  return failingSchedules.map((row) => ({
    id: makeId(cycleId, "R4", `recurring_schedules:${row.id}`),
    rule: "R4",
    actuator: "schedule",
    key: `recurring_schedules:${row.id}`,
    currentValue: "enabled",
    proposedValue: "disabled",
    bounds: null,
    evidence: truncateEvidence(
      `last ${row.lastFailures} runs failed (task_type=${row.taskType}` +
        (row.description ? `, ${row.description}` : "") +
        ")",
    ),
    estWeeklySavingUsd: 0,
  }));
}

/**
 * R5 — lesson-store byte budget (§3.5). The eviction scorer's primary term
 * is `w_ev·log(ev+1)`, so cap pressure already evicts low-evidence entries
 * first; R5 only fires when the **global** store sits above 90% utilization
 * with median evidence ≤ 1 — i.e. the cap is keeping weak lessons alive.
 * Per-agent stores are measured (§3.5 `<lesson_stores>`) but not tuned in v1.
 */
function ruleR5(
  cycleId: string,
  knobs: TuningKnobValues,
  lessonStores: ReadonlyArray<LessonStoreUtilization>,
): TuningRecommendation | null {
  const globalStore = lessonStores.find((store) => store.scope === "agent");
  if (!globalStore || globalStore.capBytes <= 0) return null;
  if (globalStore.bytes / globalStore.capBytes <= R5_UTILIZATION_THRESHOLD) {
    return null;
  }
  if (globalStore.medianEv === null || globalStore.medianEv > R5_MEDIAN_EV_CEILING) {
    return null;
  }
  const current = knobs.feedbackLessonMaxBytesGlobal;
  const proposed = Math.max(
    R5_MIN_BYTES,
    Math.floor((current * R5_STEP_FACTOR) / R5_ROUNDING_BYTES) * R5_ROUNDING_BYTES,
  );
  if (proposed >= current) return null;
  return {
    id: makeId(cycleId, "R5", R5_KNOB),
    rule: "R5",
    actuator: "config",
    key: R5_KNOB,
    currentValue: current,
    proposedValue: proposed,
    bounds: { min: R5_MIN_BYTES, max: current },
    evidence: truncateEvidence(
      `agent lesson store at ${pctLabel(globalStore.bytes, globalStore.capBytes)} ` +
        `of cap with median ev=${globalStore.medianEv} (${globalStore.entries} entries)`,
    ),
    estWeeklySavingUsd: 0,
  };
}

/**
 * The rule table (§3.2). Pure: every input is passed in; the only
 * non-determinism allowed is the caller's `now`. Applies the code-side
 * guards — hysteresis against the ledger, per-rule minimum samples, and the
 * max-3 ranking by estimated weekly $ impact (ties: rule order, then key).
 */
export function buildTuningRecommendations(
  input: TuningRecommenderInput,
): TuningRecommendation[] {
  const cycleId = cycleIdForDate(input.now);
  const lessonStores = input.lessonStores ?? [];
  const failingSchedules = input.failingSchedules ?? [];

  const candidates: TuningRecommendation[] = [];
  const r1 = ruleR1(cycleId, input.data, input.knobs);
  if (r1) candidates.push(r1);
  candidates.push(...ruleR2(cycleId, input.data));
  const r3 = ruleR3(cycleId, input.data, input.knobs);
  if (r3) candidates.push(r3);
  candidates.push(...ruleR4(cycleId, failingSchedules));
  const r5 = ruleR5(cycleId, input.knobs, lessonStores);
  if (r5) candidates.push(r5);

  return candidates
    .filter((rec) => !isKeyInCooldown(input.data.ledger, rec.key, input.now))
    .sort(
      (a, b) =>
        b.estWeeklySavingUsd - a.estWeeklySavingUsd ||
        RULE_ORDER[a.rule] - RULE_ORDER[b.rule] ||
        a.key.localeCompare(b.key),
    )
    .slice(0, MAX_RECOMMENDATIONS_PER_CYCLE);
}

/** Cycle id = the generating run's UTC date (`YYYY-MM-DD`). */
export function cycleIdForDate(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Wrap a recommendation set as the persisted pending-cycle blob. Written to
 * `runtime_state` even when empty — overwriting is what expires the previous
 * cycle's single-use ids (§3.4).
 *
 * Same-day regeneration (a weekly-review re-run via `!run` / crash retry)
 * produces the SAME cycle id and — for any rule still firing on the same
 * key — the same recommendation ids. Those ids are not expired (§3.4 expiry
 * is the *next* weekly cycle), so verdicts already recorded against them
 * carry forward: without this, the regenerated blob's empty `verdicts` map
 * would silently reopen judged ids, and the re-run session's re-POST would
 * record fresh verdicts — double-posting the rejection `self_critique`
 * signals the route's per-id idempotency exists to prevent. Verdicts for
 * ids the regenerated set no longer contains are dropped (the evidence
 * that produced them is gone); a different-day cycle starts clean.
 */
export function createPendingTuningCycle(
  recommendations: ReadonlyArray<TuningRecommendation>,
  generatedAtIso: string,
  previousCycle?: PendingTuningCycle | null,
): PendingTuningCycle {
  const cycleId = generatedAtIso.slice(0, 10);
  const verdicts: Record<string, TuningVerdictRecord> = {};
  if (previousCycle && previousCycle.cycleId === cycleId) {
    const liveIds = new Set(recommendations.map((rec) => rec.id));
    for (const [id, record] of Object.entries(previousCycle.verdicts ?? {})) {
      if (liveIds.has(id)) verdicts[id] = record;
    }
  }
  return {
    cycleId,
    generatedAt: generatedAtIso,
    recommendations: [...recommendations],
    verdicts,
  };
}

// ── R4 gather (single DB read, same injected-DB pattern as the Measure stage) ─

/** Trailing settled-run window R4 inspects per recurring row. */
export const R4_FAILURE_STREAK = 3;

interface RecurringRow {
  id: number;
  taskType: string;
  description: string | null;
}

/**
 * R4 input — enabled `recurring_schedules` rows whose last
 * {@link R4_FAILURE_STREAK} *settled* materialized runs (`completed` /
 * `failed` / `skipped`; pending and running rows are not evidence) all
 * failed. SQL over `agent_schedule` grouped by `recurring_schedule_id` —
 * no new columns (§3.2). A `skipped` run breaks the streak deliberately:
 * the rule targets "fires and fails every time", not gate-skipped rows.
 */
export function gatherFailingRecurringSchedules(
  db: Database.Database,
): FailingRecurringSchedule[] {
  const recurring = db
    .prepare(
      `SELECT id, task_type AS taskType, task_description AS description
         FROM recurring_schedules
        WHERE enabled = 1
        ORDER BY id ASC`,
    )
    .all() as RecurringRow[];

  const lastRuns = db.prepare(
    `SELECT status FROM agent_schedule
      WHERE recurring_schedule_id = ?
        AND status IN ('completed', 'failed', 'skipped')
      ORDER BY scheduled_for DESC, id DESC
      LIMIT ${R4_FAILURE_STREAK}`,
  );

  const out: FailingRecurringSchedule[] = [];
  for (const row of recurring) {
    const settled = lastRuns.all(row.id) as Array<{ status: string }>;
    if (settled.length < R4_FAILURE_STREAK) continue;
    if (!settled.every((run) => run.status === "failed")) continue;
    out.push({
      id: row.id,
      taskType: row.taskType,
      description: row.description,
      lastFailures: R4_FAILURE_STREAK,
    });
  }
  return out;
}

// ── Renderer ────────────────────────────────────────────────────────────────

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export interface RenderTuningRecommendationsOptions {
  /**
   * Phase 3 — `shadow` (default) means verdicts are recorded but never
   * actuated; `live` means the daemon applies `apply` verdicts through the
   * config chokepoint (`selfTuningEnabled=true`). The attribute is what the
   * weekly task-flow's Phase 3c branches on, so the prompt never has to
   * guess the flag state.
   */
  mode?: "shadow" | "live";
}

/**
 * Render the `<tuning_recommendations>` block for the weekly session's
 * Phase 3c verdict step. Returns `null` when the cycle holds no
 * recommendations — the design requires zero bytes in that case (§3.2).
 * Output is bounded by construction: ≤ {@link MAX_RECOMMENDATIONS_PER_CYCLE}
 * rows with ≤ {@link MAX_EVIDENCE_CHARS}-char evidence strings.
 *
 * Carried-forward verdicts (a same-day re-run regenerates the same ids, and
 * `createPendingTuningCycle` preserves verdicts already recorded against
 * them) surface as a `verdict` attribute on the row, so the re-run session
 * skips already-judged rows instead of re-POSTing them — the route's per-id
 * idempotency would absorb the duplicates, but not the wasted judgment
 * tokens.
 */
export function renderTuningRecommendationsBlock(
  cycle: PendingTuningCycle,
  opts: RenderTuningRecommendationsOptions = {},
): string | null {
  if (cycle.recommendations.length === 0) return null;
  const mode = opts.mode ?? "shadow";
  const out: string[] = [];
  out.push(
    `<tuning_recommendations cycle="${xmlEscape(cycle.cycleId)}" ` +
      `count="${cycle.recommendations.length}" mode="${mode}" ` +
      `verdict_endpoint="POST /api/tuning/verdicts">`,
  );
  for (const rec of cycle.recommendations) {
    const recorded = cycle.verdicts?.[rec.id];
    out.push(
      `  <r id="${xmlEscape(rec.id)}" rule="${rec.rule}" ` +
        `actuator="${rec.actuator}" key="${xmlEscape(rec.key)}" ` +
        `current="${xmlEscape(String(rec.currentValue))}" ` +
        `proposed="${xmlEscape(String(rec.proposedValue))}"` +
        (rec.bounds ? ` bounds="${rec.bounds.min}..${rec.bounds.max}"` : "") +
        (rec.estWeeklySavingUsd > 0
          ? ` est_usd_wk="${rec.estWeeklySavingUsd}"`
          : "") +
        (recorded ? ` verdict="${recorded.verdict}"` : "") +
        ` evidence="${xmlEscape(rec.evidence)}" />`,
    );
  }
  out.push("</tuning_recommendations>");
  return out.join("\n");
}

// ── Verdict application (pure; the route owns I/O and id validation) ───────

export interface VerdictEntry {
  id: string;
  verdict: TuningVerdict;
  reason: string;
}

export type VerdictStatus = "recorded" | "duplicate" | "conflict";

export interface VerdictApplicationResult {
  cycle: PendingTuningCycle;
  results: Array<{ id: string; status: VerdictStatus }>;
}

/**
 * Record verdicts onto a pending cycle, idempotently per id (§3.4): a
 * retried POST with the same verdict is a `duplicate` no-op; a different
 * verdict for an already-verdicted id is a `conflict` — first verdict wins
 * (re-judging a recommendation mid-cycle is not a supported operation).
 * Callers must have validated every id against `cycle.recommendations`
 * first; an unknown id here is a programming error and throws.
 */
export function applyVerdictsToCycle(
  cycle: PendingTuningCycle,
  entries: ReadonlyArray<VerdictEntry>,
  nowIso: string,
): VerdictApplicationResult {
  const known = new Set(cycle.recommendations.map((rec) => rec.id));
  const verdicts: Record<string, TuningVerdictRecord> = { ...cycle.verdicts };
  const results: Array<{ id: string; status: VerdictStatus }> = [];
  for (const entry of entries) {
    if (!known.has(entry.id)) {
      throw new Error(`Unknown recommendation id: ${entry.id}`);
    }
    const existing = verdicts[entry.id];
    if (existing) {
      results.push({
        id: entry.id,
        status: existing.verdict === entry.verdict ? "duplicate" : "conflict",
      });
      continue;
    }
    verdicts[entry.id] = {
      verdict: entry.verdict,
      reason: entry.reason,
      recordedAt: nowIso,
    };
    results.push({ id: entry.id, status: "recorded" });
  }
  return { cycle: { ...cycle, verdicts }, results };
}
