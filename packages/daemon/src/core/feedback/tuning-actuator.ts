/**
 * Self-Tuning Review Cycle — Actuate stage (SELF_TUNING_REVIEW_CYCLE_DESIGN.md
 * §3.4, Phase 3).
 *
 * The daemon-side Actuate step ($0 — P1). Consumes `apply` verdicts the
 * weekly session POSTed to `/api/tuning/verdicts` and applies them **per key
 * namespace** (decision D5):
 *
 *   - `config` knobs (R1/R3/R5) actuate through the injected
 *     `applyUpdates` seam — production binds it to the existing
 *     `applyConfigUpdates` chokepoint (`api/env-writer.ts`), which enforces
 *     the per-key bounds in `runtimeSettingsSchema` / `NUMERIC_RANGE` (P4 —
 *     bounds are enforced where they already live, never re-copied here).
 *   - `notification:<type>` keys (R2) never touch config — an apply verdict
 *     records the demotion as lesson guidance through the existing feedback
 *     loop (§3.2 v1 actuator is lesson-mediated; a real per-type knob is
 *     Phase 4).
 *   - `recurring_schedules:<id>` keys (R4) stay propose-only — an apply
 *     verdict DMs the owner the suggested `enabled=0` flip; a real flip
 *     needs its own audit/revert path outside `applyConfigUpdates`
 *     (Phase 4).
 *
 * Every applied config change writes the §3.4 ledger blob
 * (`runtime_state.self_tuning:<key>` — the keys the Phase 1 Measure stage
 * already reads and renders into `<tuning_ledger>`), an
 * `agent_actions.action_type='self_tuning.applied'` audit row, and a
 * one-line owner DM ("Reply `!revert tuning` to undo") — the
 * Autonomous-plus-mandatory-DM pattern that replaced the abolished Notify
 * tier. Reverts (manual `!revert tuning` or the auto-revert monitor) share
 * {@link revertAppliedTuningChange} so the ledger stamp, audit row, and
 * feedback signal are identical regardless of trigger; a reverted key gets
 * the extended 28-day cool-down via the recommender's `isKeyInCooldown`.
 *
 * Pure-module conventions match `self-performance-prep.ts`: DB handle
 * injected, `now` passed in, every side branch failure-isolated. Falls in
 * the 100%-coverage set.
 */

import type Database from "better-sqlite3";

import { formatSqliteDatetime } from "@aitne/shared";

import {
  HOURLY_GATE_ACTION_TYPE,
  SELF_TUNING_LEDGER_PREFIX,
} from "./self-performance-prep.js";
import type {
  TuningActuator,
  TuningRecommendation,
  TuningRuleId,
} from "./tuning-recommender.js";
import { recordFeedbackSignal } from "../../db/feedback-signals-store.js";
import { readRuntimeState, writeRuntimeState } from "../../db/runtime-state.js";
import { createLogger } from "../../logging.js";

const logger = createLogger("tuning-actuator");

const DAY_MS = 24 * 60 * 60 * 1000;

/** §3.4 — baseline/verify metric window length, same span as the Measure stage. */
export const TUNING_METRIC_WINDOW_DAYS = 7;

/**
 * §3.4 ledger blob — `runtime_state.self_tuning:<key>`. Field names are
 * load-bearing: `gatherLedger` (self-performance-prep.ts) reads `prev` /
 * `applied_at` / `rule` / `baselineMetric` / `reverted_at` verbatim, and
 * `isKeyInCooldown` (tuning-recommender.ts) keys the 14d/28d hysteresis off
 * `applied_at` / `reverted_at`. The remaining fields are Phase 3 additions —
 * unknown fields are ignored by the Phase 1/2 readers, so they are additive.
 */
export interface TuningLedgerBlob {
  prev: unknown;
  applied_at: string;
  rule: string;
  /** What the apply touched — only `config` entries are revertable. */
  actuator: TuningActuator;
  proposed: unknown;
  recommendation_id: string;
  evidence: string;
  /** Rule's target metric captured at apply time (D4); null when none. */
  baselineMetric: unknown;
  /** Stamped by the auto-revert monitor after a clean 7-day verify window. */
  verified_at?: string;
  verify_result?: string;
  /** Present means the change regressed (or the owner undid it). */
  reverted_at?: string;
  revert_trigger?: "auto" | "bang_command";
  revert_reason?: string;
}

export interface LedgerScanEntry {
  /** Knob name / namespaced key — the runtime_state key minus the prefix. */
  key: string;
  blob: TuningLedgerBlob;
}

export function ledgerStateKey(key: string): string {
  return `${SELF_TUNING_LEDGER_PREFIX}${key}`;
}

/** Tolerant JSON-object parse; anything malformed degrades to null. */
function parseJsonObject(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * Scan the §3.4 ledger. A corrupt blob or one without a string `applied_at`
 * is skipped — the actuator/monitor must never throw over a damaged ledger
 * row (mirrors `gatherLedger`'s tolerance).
 */
export function listLedgerEntries(db: Database.Database): LedgerScanEntry[] {
  const rows = db
    .prepare(
      `SELECT key, value_json FROM runtime_state
        WHERE key LIKE ? ORDER BY key ASC`,
    )
    .all(`${SELF_TUNING_LEDGER_PREFIX}%`) as Array<{
    key: string;
    value_json: string;
  }>;
  const entries: LedgerScanEntry[] = [];
  for (const row of rows) {
    const blob = parseJsonObject(row.value_json);
    if (!blob || typeof blob.applied_at !== "string") continue;
    entries.push({
      key: row.key.slice(SELF_TUNING_LEDGER_PREFIX.length),
      blob: blob as unknown as TuningLedgerBlob,
    });
  }
  return entries;
}

/**
 * The `!revert tuning` target: the most recently applied, not-yet-reverted
 * `config` change. Lesson/schedule entries are hysteresis bookkeeping only —
 * there is no machine state to restore. Already-verified entries remain
 * revertable: passing the 7-day window means "no measured regression", not
 * "the owner is forbidden from undoing it".
 */
export function findLatestRevertableEntry(
  entries: ReadonlyArray<LedgerScanEntry>,
): LedgerScanEntry | null {
  const candidates = entries.filter(
    (entry) =>
      entry.blob.actuator === "config" &&
      entry.blob.reverted_at === undefined &&
      entry.blob.prev !== undefined,
  );
  if (candidates.length === 0) return null;
  return [...candidates].sort((a, b) =>
    b.blob.applied_at.localeCompare(a.blob.applied_at),
  )[0];
}

// ── Rule target metrics (§3.4 / D3 / D4) ────────────────────────────────────
//
// Computed twice per applied change: once at apply time (the pre-change
// baseline stored in the ledger) and once by the auto-revert monitor over
// the 7-day verify window. Both windows read rows that already exist —
// `observations.novelty_score` and the `hourly_check.gate` audit rows —
// never recomputed signals.

/** D4 — R1's target metric pair. */
export interface R1Metric {
  /** Daily novelty≥2 observation arrivals (stale pre-pass suppresses these). */
  noveltyGe2PerDay: number;
  /** Share of audited gate ticks that took the cautious-escalate path. */
  cautiousEscalateShare: number;
}

interface GateDetailRow {
  detail: string | null;
}

export function computeR1Metric(
  db: Database.Database,
  from: Date,
  to: Date,
): R1Metric {
  const fromUtc = formatSqliteDatetime(from);
  const toUtc = formatSqliteDatetime(to);
  const windowDays = Math.max(
    (to.getTime() - from.getTime()) / DAY_MS,
    1 / 24, // guard against a degenerate window producing Infinity
  );
  const arrivals = db
    .prepare(
      `SELECT COUNT(*) AS n FROM observations
        WHERE observed_at >= ? AND observed_at < ? AND novelty_score >= 2`,
    )
    .get(fromUtc, toUtc) as { n: number };

  const gateRows = db
    .prepare(
      `SELECT detail FROM agent_actions
        WHERE action_type = ? AND started_at >= ? AND started_at < ?`,
    )
    .all(HOURLY_GATE_ACTION_TYPE, fromUtc, toUtc) as GateDetailRow[];
  let cautious = 0;
  for (const row of gateRows) {
    if (parseJsonObject(row.detail)?.cautious_escalate === true) cautious += 1;
  }
  return {
    noveltyGe2PerDay: arrivals.n / windowDays,
    cautiousEscalateShare: gateRows.length > 0 ? cautious / gateRows.length : 0,
  };
}

/** D3 — R3's target metric: silenced ticks that carried real signal. */
export interface R3Metric {
  stage0Ticks: number;
  /** …of those, ticks whose audited snapshot had maxNoveltyScore ≥ 2. */
  noveltyGe2: number;
}

export function computeR3Metric(
  db: Database.Database,
  from: Date,
  to: Date,
): R3Metric {
  const rows = db
    .prepare(
      `SELECT detail FROM agent_actions
        WHERE action_type = ? AND started_at >= ? AND started_at < ?`,
    )
    .all(
      HOURLY_GATE_ACTION_TYPE,
      formatSqliteDatetime(from),
      formatSqliteDatetime(to),
    ) as GateDetailRow[];
  const metric: R3Metric = { stage0Ticks: 0, noveltyGe2: 0 };
  for (const row of rows) {
    const detail = parseJsonObject(row.detail);
    if (detail?.stage_reached !== "stage0_silent") continue;
    metric.stage0Ticks += 1;
    const snapshot = detail.signal_snapshot as Record<string, unknown> | undefined;
    const novelty =
      typeof snapshot === "object" && snapshot !== null
        ? snapshot.maxNoveltyScore
        : null;
    if (typeof novelty === "number" && novelty >= 2) metric.noveltyGe2 += 1;
  }
  return metric;
}

/**
 * D3 (R5 arm) — the explicit-correction proxy: negative explicit /
 * self_critique signals citing a lesson within the window. Excludes the
 * self-tuning loop's own bookkeeping signals (verdict rejections and revert
 * records mention lesson-byte knobs by name and would otherwise
 * self-trigger).
 */
export function countLessonRegressionSignals(
  db: Database.Database,
  from: Date,
  to: Date,
): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM feedback_signals
        WHERE created_at >= ? AND created_at < ?
          AND source IN ('explicit', 'self_critique')
          AND valence IN ('negative', 'correction')
          AND summary LIKE '%lesson%'
          AND summary NOT LIKE 'Tuning recommendation%'
          AND summary NOT LIKE 'Self-tuning%'`,
    )
    .get(formatSqliteDatetime(from), formatSqliteDatetime(to)) as { n: number };
  return row.n;
}

/**
 * Capture the rule's pre-change baseline over the {@link
 * TUNING_METRIC_WINDOW_DAYS} immediately before `now`. R5's verify metric is
 * the correction proxy (no numeric baseline); unknown rules carry none.
 */
export function captureBaselineMetric(
  db: Database.Database,
  rule: TuningRuleId | string,
  now: Date,
): unknown {
  const from = new Date(now.getTime() - TUNING_METRIC_WINDOW_DAYS * DAY_MS);
  if (rule === "R1") return computeR1Metric(db, from, now);
  if (rule === "R3") return computeR3Metric(db, from, now);
  return null;
}

// ── Audit helper ────────────────────────────────────────────────────────────

/**
 * Best-effort `agent_actions` row. Audit failure must never fail an
 * actuation that already happened — the ledger blob is the durable record.
 */
export function auditSelfTuning(
  db: Database.Database,
  actionType: "self_tuning.applied" | "self_tuning.reverted" | "self_tuning.verified",
  trigger: "autonomous" | "user",
  result: "success" | "failed",
  detail: Record<string, unknown>,
): void {
  try {
    db.prepare(
      `INSERT INTO agent_actions
         (action_type, trigger, result, detail, started_at, completed_at)
       VALUES (?, ?, ?, json(?), datetime('now'), datetime('now'))`,
    ).run(actionType, trigger, result, JSON.stringify(detail));
  } catch (err) {
    logger.warn({ err, actionType }, "Failed to audit self-tuning action");
  }
}

// ── Apply (route-side entry point) ──────────────────────────────────────────

export interface ActuatorDeps {
  db: Database.Database;
  /**
   * Bound `applyConfigUpdates` (live config + settings store). The seam
   * keeps env-writer I/O out of this module and lets tests assert the
   * chokepoint contract (P4: bounds are enforced inside, not here).
   */
  applyUpdates: (
    updates: Record<string, unknown>,
  ) => Promise<{ updated: string[]; errors: Record<string, string> }>;
  /** Live config read for the ledger's `prev` snapshot. */
  getCurrentValue: (key: string) => unknown;
  /** Owner DM sender. Absent in test harnesses; required for R4 applies. */
  sendDm?: (message: string) => Promise<void>;
  /** Mirrors `POST /api/feedback`'s kill switch for the R2 lesson signal. */
  feedbackLearningEnabled?: boolean;
}

export interface AppliedChange {
  id: string;
  key: string;
  rule: string;
  mode: "config" | "lesson" | "dm_suggestion";
  from?: unknown;
  to?: unknown;
}

export interface ActuationFailure {
  id: string;
  key: string;
  error: string;
}

export interface ActuationOutcome {
  applied: AppliedChange[];
  failures: ActuationFailure[];
}

/** §3.4 — the one-line owner DM for an applied config change. */
export function buildApplyDmMessage(
  rec: TuningRecommendation,
  prev: unknown,
): string {
  return (
    `Self-tuning (${rec.rule}): changed ${rec.key} ` +
    `${String(prev)} → ${String(rec.proposedValue)} — ${rec.evidence}. ` +
    "Reply `!revert tuning` to undo."
  );
}

/** D5 — R4 apply verdicts become an owner suggestion, never a flip. */
export function buildR4SuggestionDmMessage(rec: TuningRecommendation): string {
  return (
    `Self-tuning suggestion (R4): ${rec.evidence} — consider disabling ` +
    `${rec.key} from the dashboard schedules page. Schedules are never ` +
    "disabled automatically."
  );
}

function writeLedgerEntry(
  db: Database.Database,
  rec: TuningRecommendation,
  prev: unknown,
  baselineMetric: unknown,
  nowIso: string,
): void {
  const blob: TuningLedgerBlob = {
    prev,
    applied_at: nowIso,
    rule: rec.rule,
    actuator: rec.actuator,
    proposed: rec.proposedValue,
    recommendation_id: rec.id,
    evidence: rec.evidence,
    baselineMetric,
  };
  writeRuntimeState(db, ledgerStateKey(rec.key), blob);
}

/**
 * Actuate newly-recorded `apply` verdicts (D5 namespace dispatch). Each
 * recommendation is processed in isolation: one failure (bounds rejection,
 * missing DM path, thrown dependency) lands in `failures` and the rest
 * proceed. Callers pass only verdicts recorded **this POST** — the route's
 * per-id idempotency means a retried POST yields `duplicate` statuses and
 * never reaches this function, so a change cannot double-apply (§3.4).
 */
export async function actuateApplyVerdicts(
  deps: ActuatorDeps,
  recommendations: ReadonlyArray<TuningRecommendation>,
  now: Date,
): Promise<ActuationOutcome> {
  const outcome: ActuationOutcome = { applied: [], failures: [] };
  const nowIso = now.toISOString();
  for (const rec of recommendations) {
    try {
      if (rec.actuator === "config") {
        const prev = deps.getCurrentValue(rec.key) ?? rec.currentValue;
        const result = await deps.applyUpdates({ [rec.key]: rec.proposedValue });
        const error = result.errors[rec.key];
        if (error !== undefined || !result.updated.includes(rec.key)) {
          const message = error ?? "Config chokepoint did not apply the key";
          outcome.failures.push({ id: rec.id, key: rec.key, error: message });
          auditSelfTuning(deps.db, "self_tuning.applied", "autonomous", "failed", {
            recommendationId: rec.id,
            rule: rec.rule,
            key: rec.key,
            proposed: rec.proposedValue,
            error: message,
          });
          continue;
        }
        // Baseline capture is best-effort: a metric failure must not undo
        // an apply that already landed — the monitor degrades to
        // `no_baseline` for this entry.
        let baselineMetric: unknown = null;
        try {
          baselineMetric = captureBaselineMetric(deps.db, rec.rule, now);
        } catch (err) {
          logger.warn({ err, key: rec.key }, "Baseline metric capture failed");
        }
        writeLedgerEntry(deps.db, rec, prev, baselineMetric, nowIso);
        auditSelfTuning(deps.db, "self_tuning.applied", "autonomous", "success", {
          recommendationId: rec.id,
          rule: rec.rule,
          key: rec.key,
          prev,
          applied: rec.proposedValue,
          evidence: rec.evidence,
        });
        // Mandatory owner DM (§3.4) — but a DM delivery failure cannot
        // un-apply the change; the audit row + ledger remain the record.
        if (deps.sendDm) {
          try {
            await deps.sendDm(buildApplyDmMessage(rec, prev));
          } catch (err) {
            logger.warn({ err, key: rec.key }, "Self-tuning apply DM failed");
          }
        } else {
          logger.warn(
            { key: rec.key },
            "Self-tuning change applied without DM path — owner not notified",
          );
        }
        outcome.applied.push({
          id: rec.id,
          key: rec.key,
          rule: rec.rule,
          mode: "config",
          from: prev,
          to: rec.proposedValue,
        });
        continue;
      }

      if (rec.actuator === "lesson") {
        // R2 — lesson-mediated (§3.2): the guidance flows through the
        // existing feedback loop; no machine state changes. The ledger
        // entry exists purely for the 14-day hysteresis so the same type
        // is not re-proposed weekly.
        if (deps.feedbackLearningEnabled !== false) {
          recordFeedbackSignal(deps.db, {
            source: "self_critique",
            valence: "negative",
            scopeType: "agent",
            scopeRef: null,
            actionKind: "agent_execution",
            actionRef: rec.id,
            agentId: null,
            summary:
              `Demote ${rec.key}: ${rec.evidence} — batch into digests or ` +
              "stay silent unless user-actionable (weekly apply verdict)",
            evidence: {
              kind: "do-less",
              recommendationId: rec.id,
              rule: rec.rule,
              key: rec.key,
            },
          });
        }
        writeLedgerEntry(deps.db, rec, rec.currentValue, null, nowIso);
        auditSelfTuning(deps.db, "self_tuning.applied", "autonomous", "success", {
          recommendationId: rec.id,
          rule: rec.rule,
          key: rec.key,
          mode: "lesson",
          ...(deps.feedbackLearningEnabled === false
            ? { note: "feedback_loop_disabled" }
            : {}),
        });
        outcome.applied.push({
          id: rec.id,
          key: rec.key,
          rule: rec.rule,
          mode: "lesson",
        });
        continue;
      }

      // rec.actuator === "schedule" (R4) — the DM *is* the actuation
      // (propose-only, D5). No DM path → the owner never saw the
      // suggestion → report failure and leave the ledger unwritten so the
      // rule re-proposes next cycle.
      if (!deps.sendDm) {
        outcome.failures.push({
          id: rec.id,
          key: rec.key,
          error: "No DM path available for the R4 suggestion",
        });
        continue;
      }
      await deps.sendDm(buildR4SuggestionDmMessage(rec));
      writeLedgerEntry(deps.db, rec, rec.currentValue, null, nowIso);
      auditSelfTuning(deps.db, "self_tuning.applied", "autonomous", "success", {
        recommendationId: rec.id,
        rule: rec.rule,
        key: rec.key,
        mode: "dm_suggestion",
      });
      outcome.applied.push({
        id: rec.id,
        key: rec.key,
        rule: rec.rule,
        mode: "dm_suggestion",
      });
    } catch (err) {
      logger.warn({ err, id: rec.id }, "Tuning actuation failed");
      outcome.failures.push({
        id: rec.id,
        key: rec.key,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return outcome;
}

// ── Revert (shared by `!revert tuning` and the auto-revert monitor) ────────

export interface RevertDeps {
  db: Database.Database;
  applyUpdates: (
    updates: Record<string, unknown>,
  ) => Promise<{ updated: string[]; errors: Record<string, string> }>;
  feedbackLearningEnabled?: boolean;
}

export interface RevertOptions {
  trigger: "auto" | "bang_command";
  reason: string;
  now: Date;
}

export type RevertResult = { ok: true } | { ok: false; error: string };

/**
 * Restore a config entry's `prev` value through the chokepoint, stamp
 * `reverted_at` (which puts the key into the 28-day re-proposal cool-down,
 * §3.4), audit `self_tuning.reverted`, and record the feedback signal that
 * turns the failure into a lesson — `self_critique` for the monitor's
 * measured regression, `explicit` correction when the owner typed
 * `!revert tuning`.
 */
export async function revertAppliedTuningChange(
  deps: RevertDeps,
  entry: LedgerScanEntry,
  opts: RevertOptions,
): Promise<RevertResult> {
  const result = await deps.applyUpdates({ [entry.key]: entry.blob.prev });
  const error = result.errors[entry.key];
  if (error !== undefined || !result.updated.includes(entry.key)) {
    const message = error ?? "Config chokepoint did not apply the revert";
    auditSelfTuning(
      deps.db,
      "self_tuning.reverted",
      opts.trigger === "auto" ? "autonomous" : "user",
      "failed",
      {
        key: entry.key,
        rule: entry.blob.rule,
        restored: entry.blob.prev,
        trigger: opts.trigger,
        reason: opts.reason,
        error: message,
      },
    );
    return { ok: false, error: message };
  }

  const nowIso = opts.now.toISOString();
  // Re-read so a concurrent stamp (e.g. verified_at) is not clobbered;
  // fall back to the scanned blob when the row vanished mid-flight.
  const current =
    readRuntimeState<TuningLedgerBlob>(deps.db, ledgerStateKey(entry.key)) ??
    entry.blob;
  writeRuntimeState(deps.db, ledgerStateKey(entry.key), {
    ...current,
    reverted_at: nowIso,
    revert_trigger: opts.trigger,
    revert_reason: opts.reason,
  } satisfies TuningLedgerBlob);

  auditSelfTuning(
    deps.db,
    "self_tuning.reverted",
    opts.trigger === "auto" ? "autonomous" : "user",
    "success",
    {
      key: entry.key,
      rule: entry.blob.rule,
      restored: entry.blob.prev,
      trigger: opts.trigger,
      reason: opts.reason,
    },
  );

  if (deps.feedbackLearningEnabled !== false) {
    try {
      recordFeedbackSignal(deps.db, {
        source: opts.trigger === "auto" ? "self_critique" : "explicit",
        valence: opts.trigger === "auto" ? "negative" : "correction",
        scopeType: "agent",
        scopeRef: null,
        actionKind: "agent_execution",
        actionRef: entry.blob.recommendation_id ?? entry.key,
        agentId: null,
        summary:
          `Self-tuning change ${entry.key} (${entry.blob.rule}) reverted ` +
          `(${opts.trigger}): ${opts.reason}`,
        evidence: {
          kind: "revert",
          rule: entry.blob.rule,
          key: entry.key,
          trigger: opts.trigger,
        },
      });
    } catch (err) {
      logger.warn({ err, key: entry.key }, "Failed to record revert signal");
    }
  }
  return { ok: true };
}
