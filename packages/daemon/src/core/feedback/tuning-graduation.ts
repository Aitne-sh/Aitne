/**
 * Self-Tuning Review Cycle — graduation criteria (SELF_TUNING_REVIEW_CYCLE_DESIGN.md
 * §7 shadow-period exit, Work Package 5).
 *
 * The shadow period (`selfTuningEnabled=false`, the shipped default) records
 * verdicts but never actuates — without an observable exit it runs forever.
 * This module defines that exit: a **qualifying cycle** generated ≥ 1
 * recommendation, every recommendation received a verdict, at least one
 * verdict was `apply`, and none were `reject`. All-`defer` does not qualify
 * (the owner never endorsed anything) and a reject resets the streak (the
 * loop is still producing recommendations the owner refuses).
 * Zero-recommendation cycles are NEUTRAL — the rules simply had nothing to
 * say that week, which is evidence of neither quality nor regression, so
 * they neither break nor extend the streak.
 *
 * **Graduation** = {@link TUNING_GRADUATION_CYCLES} consecutive qualifying
 * cycles. Deliberately an exported constant, NOT a config knob — the
 * graduation bar must not itself be tunable.
 *
 * State lives in two `runtime_state` keys:
 *   - {@link TUNING_CYCLE_HISTORY_STATE_KEY} — a bounded (last
 *     {@link TUNING_CYCLE_HISTORY_CAP} cycles) history blob, appended by the
 *     weekly pre-step (`prepareSelfTuningBlocks`) when it persists the
 *     pending cycle, and tallied by `POST /api/tuning/verdicts` as verdicts
 *     are newly recorded.
 *   - {@link TUNING_GRADUATION_NOTIFIED_STATE_KEY} — the one-time
 *     "graduation reached" DM guard, so the owner is told exactly once.
 *
 * Like the `.` in `TUNING_PENDING_CYCLE_STATE_KEY`, both keys avoid the
 * `self_tuning:` ledger prefix so `gatherLedger`'s `LIKE 'self_tuning:%'`
 * scan never picks them up as phantom ledger entries.
 *
 * Pure module — no I/O, no clock. Callers own the runtime_state reads and
 * writes. Falls in the 100%-coverage set.
 */

import type { TuningVerdict } from "./tuning-recommender.js";

/** Consecutive qualifying cycles required to graduate. Not a config knob. */
export const TUNING_GRADUATION_CYCLES = 3;

/** runtime_state key for the bounded cycle-history blob. */
export const TUNING_CYCLE_HISTORY_STATE_KEY = "self_tuning.cycle_history";

/** runtime_state key for the one-time "graduation reached" DM guard. */
export const TUNING_GRADUATION_NOTIFIED_STATE_KEY =
  "self_tuning.graduation_notified_at";

/** Cycles retained in the history blob — oldest dropped beyond this. */
export const TUNING_CYCLE_HISTORY_CAP = 12;

export interface TuningCycleVerdictTallies {
  apply: number;
  reject: number;
  defer: number;
}

export interface TuningCycleHistoryEntry {
  /** ISO date of the generating weekly run (`PendingTuningCycle.cycleId`). */
  cycleId: string;
  generatedAt: string;
  recommendationCount: number;
  /** Verdicts recorded so far, tallied by kind. */
  verdicts: TuningCycleVerdictTallies;
}

/** Chronological, oldest first — the append order of the weekly pre-step. */
export type TuningCycleHistory = TuningCycleHistoryEntry[];

export interface GraduationStatus {
  graduated: boolean;
  /** Trailing consecutive qualifying cycles (neutral cycles skipped). */
  qualifyingStreak: number;
}

/**
 * Append a fresh cycle to the history, capped at
 * {@link TUNING_CYCLE_HISTORY_CAP} (oldest dropped). A same-`cycleId` entry
 * is replaced in place — a same-day weekly re-run (`!run` / crash retry)
 * regenerates the same cycle id and must overwrite, not double-count.
 */
export function appendCycleToHistory(
  history: ReadonlyArray<TuningCycleHistoryEntry>,
  entry: TuningCycleHistoryEntry,
): TuningCycleHistory {
  const next = [...history];
  const index = next.findIndex((e) => e.cycleId === entry.cycleId);
  if (index >= 0) {
    next[index] = entry;
  } else {
    next.push(entry);
  }
  return next.slice(-TUNING_CYCLE_HISTORY_CAP);
}

/**
 * Tally verdicts **newly recorded by one POST** onto the matching cycle
 * entry. Callers must pass only `recorded`-status verdicts — the route's
 * per-id idempotency means duplicates/conflicts never reach the tallies, so
 * a retried POST cannot double-count. An unknown `cycleId` (history blob
 * lost or the pre-step's append failed) returns the history unchanged — the
 * cycle then simply never qualifies, which degrades conservatively.
 */
export function recordVerdictsInHistory(
  history: ReadonlyArray<TuningCycleHistoryEntry>,
  cycleId: string,
  verdicts: ReadonlyArray<TuningVerdict>,
): TuningCycleHistory {
  const index = history.findIndex((e) => e.cycleId === cycleId);
  if (index < 0) return [...history];
  const tallies = { ...history[index].verdicts };
  for (const verdict of verdicts) tallies[verdict] += 1;
  const next = [...history];
  next[index] = { ...history[index], verdicts: tallies };
  return next;
}

/**
 * A qualifying cycle: fully verdicted (tallies sum to the recommendation
 * count — an over-tallied entry fails the equality and degrades to
 * non-qualifying), at least one `apply`, zero `reject`. All-`defer` fails
 * the `apply ≥ 1` arm by construction.
 */
function isQualifyingCycle(entry: TuningCycleHistoryEntry): boolean {
  const { apply, reject, defer } = entry.verdicts;
  return (
    apply + reject + defer === entry.recommendationCount &&
    apply >= 1 &&
    reject === 0
  );
}

/**
 * Walk the history newest → oldest: neutral cycles
 * (`recommendationCount === 0`) are skipped; each qualifying cycle extends
 * the streak; the first non-qualifying, non-neutral cycle (rejects present,
 * not fully verdicted, or all-defer) stops the walk.
 */
export function evaluateGraduation(
  history: ReadonlyArray<TuningCycleHistoryEntry>,
): GraduationStatus {
  let streak = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const entry = history[i];
    if (entry.recommendationCount === 0) continue; // neutral — skip
    if (!isQualifyingCycle(entry)) break;
    streak += 1;
  }
  return {
    graduated: streak >= TUNING_GRADUATION_CYCLES,
    qualifyingStreak: streak,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isValidTallies(value: unknown): value is TuningCycleVerdictTallies {
  return (
    isRecord(value) &&
    typeof value.apply === "number" &&
    typeof value.reject === "number" &&
    typeof value.defer === "number"
  );
}

function isValidEntry(value: unknown): value is TuningCycleHistoryEntry {
  return (
    isRecord(value) &&
    typeof value.cycleId === "string" &&
    typeof value.generatedAt === "string" &&
    typeof value.recommendationCount === "number" &&
    isValidTallies(value.verdicts)
  );
}

/**
 * Tolerant parse of the runtime_state blob. A non-array degrades to an
 * empty history; individually malformed entries are dropped. Never throws —
 * a damaged blob must not cost the weekly pre-step or the verdict route
 * (mirrors `listLedgerEntries`' tolerance; `readRuntimeState` already maps
 * corrupt JSON to `null`).
 */
export function parseCycleHistory(raw: unknown): TuningCycleHistory {
  if (!Array.isArray(raw)) return [];
  return raw.filter(isValidEntry);
}
