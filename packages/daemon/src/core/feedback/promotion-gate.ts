/**
 * Feedback Learning Loop — promotion gate (FEEDBACK_LEARNING_LOOP_DESIGN.md §4 step 4).
 *
 * Decides whether a candidate lesson (one or more corroborating signals) is
 * *active / injectable* or stays *provisional*. This is the deterministic
 * "globally optimized, not single-shot" gate (requirement #4): the LLM groups
 * signals by intent (semantic), but the promote/hold decision is pure code so
 * the model never decides the threshold.
 *
 * Two hard rules kill the §3.5.1 sign-inversion failure mode at the gate:
 *   1. `ignored` carries `valence='neutral'` and weight 0.25 — silence is weak
 *      corroboration, never disapproval, and can never *flip a lesson negative*.
 *   2. `ignored` is **non-initiating**: a candidate made *only* of `ignored`
 *      signals never promotes, regardless of weighted sum. An ignore can
 *      strengthen an explicit/corrected lesson; it can never start one.
 */

import type {
  FeedbackSignalSource,
  FeedbackSignalValence,
} from "../../db/feedback-signals-store.js";
import { roundCf } from "./lesson-format.js";

/** Minimal signal shape the gate scores — a projection of `feedback_signals`. */
export interface GateSignal {
  source: FeedbackSignalSource;
  valence: FeedbackSignalValence | null;
}

/**
 * Per-signal evidence weight (§3.5.1 / §4 step 4):
 *   explicit | corrected = 1.0 · self_critique | replied | acted = 0.5 · ignored = 0.25
 *
 * Derived from `(source, valence)` only — `valence` already encodes the
 * behavioral reaction (corrected→correction, ignored→neutral,
 * replied/acted→positive), so the gate needs no `evidence_json` lookup.
 * Checked in priority order: an authoritative directive (explicit source or a
 * correction) outranks everything; only the *behavioral* `ignored` reaction
 * (see {@link isIgnoredSignal}) drops to 0.25 — a neutral valence on an
 * `explicit`/`self_critique` row is a deliberate signal, not silence, and keeps
 * the 0.5 (or 1.0, for explicit) authoritative weight.
 */
export function signalWeight(signal: GateSignal): number {
  if (signal.source === "explicit") return 1.0;
  if (signal.valence === "correction") return 1.0;
  if (isIgnoredSignal(signal)) return 0.25;
  return 0.5;
}

/**
 * `ignored` is the §3.5.1 behavioral notification-elapsed reaction: a
 * `behavioral` signal carrying `valence='neutral'`. It drives the
 * non-initiating / never-negative rule. A *neutral* valence on an `explicit`
 * or `self_critique` row is NOT an ignore — it is an authoritative/deliberate
 * signal that merely lacks a positive/negative tilt — so it must not inherit
 * the 0.25 weight or the non-initiating treatment. Scoping the check to
 * `behavioral` keeps this consistent with {@link signalWeight}, which already
 * treats an explicit-neutral row as authoritative (1.0).
 */
export function isIgnoredSignal(signal: GateSignal): boolean {
  return signal.source === "behavioral" && signal.valence === "neutral";
}

/** An authoritative owner directive — promotes on first occurrence. */
export function isExplicitDirective(signal: GateSignal): boolean {
  return signal.source === "explicit" || signal.valence === "correction";
}

/** Weighted evidence sum across a candidate's contributing signals. */
export function computeWeightedEvidence(
  signals: ReadonlyArray<GateSignal>,
): number {
  return signals.reduce((sum, signal) => sum + signalWeight(signal), 0);
}

/**
 * Phase-2 §2.1 source factor for a candidate's initial confidence: an owner
 * directive is fully trusted, the agent's own critique slightly less, and a
 * behavioral inference least — mirroring the {@link signalWeight} authority
 * ordering without re-deriving it per signal (cf0 keys on the candidate's
 * *dominant* source, which the worksheet already computes).
 */
export const SOURCE_CF_FACTOR: Record<FeedbackSignalSource, number> = {
  explicit: 1.0,
  self_critique: 0.85,
  behavioral: 0.7,
};

/**
 * `saturate(w) = w / (w + K)` — maps unbounded weighted evidence into [0,1),
 * with `K = feedbackPromotionThreshold` as the half-saturation point (at the
 * promotion bar, cf0 sits at 0.5·sourceFactor). Guards `k <= 0` to the
 * documented default so a misconfigured threshold can't divide by zero.
 */
export function saturate(weightedEv: number, k: number): number {
  const safeK = k > 0 ? k : 2;
  const w = Math.max(weightedEv, 0);
  return w / (w + safeK);
}

/**
 * Initial numeric confidence for a newly-promoted lesson (Phase-2 §2.1):
 * `cf0 = saturate(weighted_ev) · sourceFactor`, rounded to the persisted 2dp.
 * Surfaced on worksheet candidates as `cf0=` and re-derived by the normalizer
 * for a written bullet that carries no trustworthy `cf`.
 */
export function computeInitialCf(
  weightedEv: number,
  src: FeedbackSignalSource,
  threshold: number,
): number {
  return roundCf(saturate(weightedEv, threshold) * SOURCE_CF_FACTOR[src]);
}

/**
 * §2.2 anti-whiplash gate. A promotable NON-explicit candidate that
 * contradicts an established lesson (`maxSuspectCf ≥ guardCf`) is downgraded
 * to provisional with reason `contradiction` unless its weighted evidence
 * clears the HIGHER bar `1.5 · threshold · maxSuspectCf` — established
 * beliefs take more evidence to overturn than to confirm. An explicit owner
 * directive bypasses the guard entirely (a user correction always wins), as
 * does a verdict that is already non-promotable.
 */
export function applyContradictionGuard(
  verdict: PromotionVerdict,
  maxSuspectCf: number,
  opts: { guardCf: number; threshold: number },
): PromotionVerdict {
  if (!verdict.promotable || verdict.reason === "explicit-directive") {
    return verdict;
  }
  if (
    maxSuspectCf >= opts.guardCf &&
    verdict.weightedEv < contradictionOverrideBar(opts.threshold, maxSuspectCf)
  ) {
    return {
      ...verdict,
      promotable: false,
      provisional: true,
      reason: "contradiction",
    };
  }
  return verdict;
}

/** The §2.2 higher evidence bar for overturning an established lesson. */
export function contradictionOverrideBar(
  threshold: number,
  suspectCf: number,
): number {
  return 1.5 * threshold * suspectCf;
}

export type PromotionReason =
  | "explicit-directive"
  | "evidence-threshold"
  | "below-threshold"
  | "ignored-non-initiating"
  | "contradiction"
  | "no-signals";

export interface PromotionVerdict {
  /** Active & injectable when true; provisional otherwise. */
  promotable: boolean;
  /** Stored-but-excluded-from-injection marker (`<!-- provisional -->`). */
  provisional: boolean;
  /** `high` if any explicit/corrected; `medium` at threshold; else `low`. */
  conf: "high" | "medium" | "low";
  weightedEv: number;
  reason: PromotionReason;
}

/**
 * Evaluate the promotion gate for a candidate's contributing signals.
 *
 * @param threshold weighted-evidence bar for behavioral/self_critique
 *   (`feedbackPromotionThreshold`, default 2).
 */
export function evaluatePromotion(
  signals: ReadonlyArray<GateSignal>,
  threshold: number,
): PromotionVerdict {
  const weightedEv = computeWeightedEvidence(signals);

  if (signals.length === 0) {
    return {
      promotable: false,
      provisional: true,
      conf: "low",
      weightedEv,
      reason: "no-signals",
    };
  }

  // Rule 2: an ignored-only candidate is non-initiating — never promotes,
  // regardless of weighted sum (two coincidental busy-morning ignores cannot
  // teach "stop notifying about X").
  if (signals.every(isIgnoredSignal)) {
    return {
      promotable: false,
      provisional: true,
      conf: "low",
      weightedEv,
      reason: "ignored-non-initiating",
    };
  }

  // An explicit owner directive (or any correction) is authoritative →
  // promote on first occurrence with high confidence.
  if (signals.some(isExplicitDirective)) {
    return {
      promotable: true,
      provisional: false,
      conf: "high",
      weightedEv,
      reason: "explicit-directive",
    };
  }

  // Behavioral / self_critique corroboration: promote at the weighted bar.
  if (weightedEv >= threshold) {
    return {
      promotable: true,
      provisional: false,
      conf: "medium",
      weightedEv,
      reason: "evidence-threshold",
    };
  }

  return {
    promotable: false,
    provisional: true,
    conf: "low",
    weightedEv,
    reason: "below-threshold",
  };
}
