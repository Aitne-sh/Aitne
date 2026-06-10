/**
 * Self-Tuning Review Cycle — Verify stage / auto-revert monitor
 * (SELF_TUNING_REVIEW_CYCLE_DESIGN.md §3.4, Phase 3).
 *
 * Piggybacks the existing hourly cron tick (scheduler.ts — same
 * fire-and-forget slot as the auth probe; no new scheduled session, P2) and
 * throttles itself to one pass per UTC day via
 * {@link REVERT_MONITOR_STATE_KEY}. Seven days after an applied config
 * change, it recomputes the rule's target metric over the verify window
 * `[applied_at, applied_at + 7d)` and:
 *
 *   - **regression past the rule's margin** → revert through the shared
 *     {@link revertAppliedTuningChange} (config restored via the
 *     `applyConfigUpdates` chokepoint, ledger stamped `reverted_at` — which
 *     triggers the 28-day re-proposal cool-down — audit
 *     `self_tuning.reverted`, `self_critique` signal so the failure becomes
 *     a lesson) and DM the owner;
 *   - **no regression** → stamp `verified_at` + audit
 *     `self_tuning.verified` so the entry is never re-examined.
 *
 * Per-rule margins (D3/D4 — named constants, deliberately not settings
 * keys):
 *   - R1 reverts if daily novelty≥2 observation arrivals fall >30% below
 *     the pre-change baseline (stale pre-pass suppressing signal) OR the
 *     cautious-escalate tick share rises >10 pt.
 *   - R3 reverts if >10% of `stage0_silent` ticks in the window carried
 *     `maxNoveltyScore ≥ 2` in their audited snapshot — harm only the
 *     raised ceiling can introduce (today's gate never silences novelty≥2).
 *   - R5 reverts on the explicit-correction proxy: any negative explicit /
 *     self_critique signal citing a lesson within the window.
 *
 * The monitor runs regardless of `selfTuningEnabled`: entries only exist
 * once actuation has run, and a safety rollback must keep working even if
 * the owner turns the loop off afterwards. Only `config`-actuator entries
 * are verified — lesson/schedule entries carry no machine state.
 */

import type Database from "better-sqlite3";

import {
  TUNING_METRIC_WINDOW_DAYS,
  auditSelfTuning,
  computeR1Metric,
  computeR3Metric,
  countLessonRegressionSignals,
  ledgerStateKey,
  listLedgerEntries,
  revertAppliedTuningChange,
  type LedgerScanEntry,
  type R1Metric,
  type RevertDeps,
  type TuningLedgerBlob,
} from "./tuning-actuator.js";
import { readRuntimeState, writeRuntimeState } from "../../db/runtime-state.js";
import { createLogger } from "../../logging.js";

const logger = createLogger("tuning-revert-monitor");

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Daily-throttle state key. Dot-separated namespace on purpose — the
 * Measure stage's `gatherLedger` scans `self_tuning:%` and must never pick
 * monitor state up as a phantom ledger entry (same rule as the pending
 * cycle key).
 */
export const REVERT_MONITOR_STATE_KEY = "self_tuning.revert_monitor";

/** §3.4 — days between apply and the verify pass. */
export const TUNING_VERIFY_WINDOW_DAYS = TUNING_METRIC_WINDOW_DAYS;

/** D4 — R1 reverts when novelty≥2 arrivals fall >30% below baseline. */
export const R1_NOVELTY_ARRIVALS_MAX_DROP = 0.3;
/** D4 — R1 reverts when the cautious-escalate share rises >10 pt. */
export const R1_CAUTIOUS_ESCALATE_MAX_RISE = 0.1;
/** D3 — R3 reverts when >10% of silent ticks carried novelty≥2 snapshots. */
export const R3_SILENT_NOVELTY_GE2_MAX_SHARE = 0.1;

interface RevertMonitorState {
  lastRunDay?: string;
}

export type VerifyDecision =
  | { action: "wait" }
  | { action: "verify"; result: string }
  | { action: "revert"; reason: string };

function isR1Metric(value: unknown): value is R1Metric {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as R1Metric).noveltyGe2PerDay === "number" &&
    typeof (value as R1Metric).cautiousEscalateShare === "number"
  );
}

function pct(value: number): string {
  return `${Math.round(value * 100)}%`;
}

/**
 * Decide one applied entry's fate. Pure given the DB rows: every margin is
 * compared against telemetry that already exists (D3 — no recomputation of
 * live signals). An entry whose `applied_at` cannot be parsed, or whose
 * rule has no metric, settles as verified with an explanatory result — the
 * conservative direction is "leave the change in place", never "revert
 * without evidence".
 */
export function evaluateAppliedEntry(
  db: Database.Database,
  entry: LedgerScanEntry,
  now: Date,
): VerifyDecision {
  const appliedMs = Date.parse(entry.blob.applied_at);
  if (Number.isNaN(appliedMs)) {
    return { action: "verify", result: "invalid_applied_at" };
  }
  const windowEndMs = appliedMs + TUNING_VERIFY_WINDOW_DAYS * DAY_MS;
  if (now.getTime() < windowEndMs) return { action: "wait" };
  const from = new Date(appliedMs);
  const to = new Date(windowEndMs);

  if (entry.blob.rule === "R1") {
    if (!isR1Metric(entry.blob.baselineMetric)) {
      return { action: "verify", result: "no_baseline" };
    }
    const baseline = entry.blob.baselineMetric;
    const current = computeR1Metric(db, from, to);
    if (
      baseline.noveltyGe2PerDay > 0 &&
      current.noveltyGe2PerDay <
        baseline.noveltyGe2PerDay * (1 - R1_NOVELTY_ARRIVALS_MAX_DROP)
    ) {
      return {
        action: "revert",
        reason:
          `novelty>=2 observation arrivals fell to ` +
          `${current.noveltyGe2PerDay.toFixed(2)}/day vs baseline ` +
          `${baseline.noveltyGe2PerDay.toFixed(2)}/day (>30% drop)`,
      };
    }
    if (
      current.cautiousEscalateShare >
      baseline.cautiousEscalateShare + R1_CAUTIOUS_ESCALATE_MAX_RISE
    ) {
      return {
        action: "revert",
        reason:
          `cautious-escalate tick share rose to ` +
          `${pct(current.cautiousEscalateShare)} vs baseline ` +
          `${pct(baseline.cautiousEscalateShare)} (>10 pt rise)`,
      };
    }
    return { action: "verify", result: "pass" };
  }

  if (entry.blob.rule === "R3") {
    const metric = computeR3Metric(db, from, to);
    if (
      metric.stage0Ticks > 0 &&
      metric.noveltyGe2 / metric.stage0Ticks > R3_SILENT_NOVELTY_GE2_MAX_SHARE
    ) {
      return {
        action: "revert",
        reason:
          `${metric.noveltyGe2}/${metric.stage0Ticks} silent ticks carried ` +
          `maxNoveltyScore>=2 (>10% — harm from the raised ceiling)`,
      };
    }
    return { action: "verify", result: "pass" };
  }

  if (entry.blob.rule === "R5") {
    const signals = countLessonRegressionSignals(db, from, to);
    if (signals > 0) {
      return {
        action: "revert",
        reason:
          `${signals} explicit-correction signal(s) cited a lesson within ` +
          "the verify window (forgotten-lesson proxy)",
      };
    }
    return { action: "verify", result: "pass" };
  }

  return { action: "verify", result: "no_metric" };
}

export interface RevertMonitorDeps extends RevertDeps {
  /** Owner DM for an auto-revert. Failure-isolated; absence only logs. */
  sendDm?: (message: string) => Promise<void>;
}

export interface RevertMonitorRun {
  /** False when the daily throttle short-circuited the pass. */
  ran: boolean;
  reverted: string[];
  verified: string[];
}

/** §3.4 — the one-line owner DM for an auto-revert. */
export function buildAutoRevertDmMessage(
  entry: LedgerScanEntry,
  reason: string,
): string {
  return (
    `Self-tuning auto-revert: restored ${entry.key} to ` +
    `${String(entry.blob.prev)} — ${reason}. The key is now in a 28-day ` +
    "re-proposal cool-down."
  );
}

/**
 * The cron-tick entry point. Throttled to one pass per UTC day; the state
 * write happens before the scan so a mid-pass failure waits for tomorrow
 * instead of retrying every tick. Each entry is processed in isolation —
 * one broken entry never blocks the rest.
 */
export async function runSelfTuningRevertMonitor(
  deps: RevertMonitorDeps,
  now: Date = new Date(),
): Promise<RevertMonitorRun> {
  const today = now.toISOString().slice(0, 10);
  const state = readRuntimeState<RevertMonitorState>(
    deps.db,
    REVERT_MONITOR_STATE_KEY,
  );
  if (state?.lastRunDay === today) {
    return { ran: false, reverted: [], verified: [] };
  }
  writeRuntimeState(deps.db, REVERT_MONITOR_STATE_KEY, { lastRunDay: today });

  const run: RevertMonitorRun = { ran: true, reverted: [], verified: [] };
  const due = listLedgerEntries(deps.db).filter(
    (entry) =>
      entry.blob.actuator === "config" &&
      entry.blob.reverted_at === undefined &&
      entry.blob.verified_at === undefined,
  );
  for (const entry of due) {
    try {
      const decision = evaluateAppliedEntry(deps.db, entry, now);
      if (decision.action === "wait") continue;

      if (decision.action === "revert") {
        const result = await revertAppliedTuningChange(deps, entry, {
          trigger: "auto",
          reason: decision.reason,
          now,
        });
        if (!result.ok) {
          logger.warn(
            { key: entry.key, error: result.error },
            "Auto-revert failed at the config chokepoint",
          );
          continue;
        }
        run.reverted.push(entry.key);
        if (deps.sendDm) {
          try {
            await deps.sendDm(buildAutoRevertDmMessage(entry, decision.reason));
          } catch (err) {
            logger.warn({ err, key: entry.key }, "Auto-revert DM failed");
          }
        } else {
          logger.warn(
            { key: entry.key },
            "Auto-revert applied without DM path — owner not notified",
          );
        }
        continue;
      }

      // decision.action === "verify" — clean window (or no metric): stamp
      // so the entry is never re-examined; revertability via
      // `!revert tuning` is unaffected. Re-read before writing (same
      // discipline as revertAppliedTuningChange): an `!revert tuning`
      // landing between this pass's scan and this stamp must not have its
      // `reverted_at` clobbered by the stale scanned blob — that would
      // both resurrect the key as revertable and drop its 28d cool-down.
      const current =
        readRuntimeState<TuningLedgerBlob>(
          deps.db,
          ledgerStateKey(entry.key),
        ) ?? entry.blob;
      writeRuntimeState(deps.db, ledgerStateKey(entry.key), {
        ...current,
        verified_at: now.toISOString(),
        verify_result: decision.result,
      });
      auditSelfTuning(deps.db, "self_tuning.verified", "autonomous", "success", {
        key: entry.key,
        rule: entry.blob.rule,
        verifyResult: decision.result,
      });
      run.verified.push(entry.key);
    } catch (err) {
      logger.warn({ err, key: entry.key }, "Revert-monitor entry failed");
    }
  }
  return run;
}
