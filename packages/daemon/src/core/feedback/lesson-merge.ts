/**
 * Feedback Learning Loop — mechanical merge / dedup (FEEDBACK_LEARNING_LOOP_DESIGN.md §4 step 3, §6).
 *
 * The *mechanical* half of "merge, don't append": group incoming signals by a
 * normalised summary so identical reports collapse into one candidate, and
 * collapse near-duplicate existing lessons (summing their `ev`) before the
 * eviction scorer runs (§6: "Near-duplicates are merged … before eviction is
 * even considered").
 *
 * The *semantic* half — judging whether a candidate matches an existing
 * lesson's *intent* and phrasing the generalization — is the LLM's job (§4
 * division of labour). This module never paraphrases; it only collapses exact
 * normalised-text matches, which is safe to do deterministically.
 */

import type { Lesson } from "./lesson-format.js";

/**
 * Normalise a summary for mechanical equality: lowercase, strip punctuation,
 * collapse whitespace. Two signals/lessons with the same normalised form are
 * treated as the same candidate. Conservative — only *identical* phrasings
 * collapse; anything semantic is left to the LLM.
 */
export function normalizeSummary(summary: string): string {
  return summary
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export interface SignalLike {
  id: number;
  summary: string;
}

export interface SignalGroup<T extends SignalLike> {
  /** Normalised-summary key shared by every member. */
  key: string;
  /** Representative (first-seen) raw summary, for display. */
  summary: string;
  members: T[];
}

/**
 * Group signals by normalised summary, preserving first-seen order for both
 * the groups and their members. Empty / whitespace-only summaries are kept
 * under a stable empty key rather than dropped, so no signal id is lost from
 * the consume set.
 */
export function groupSignalsBySummary<T extends SignalLike>(
  signals: ReadonlyArray<T>,
): SignalGroup<T>[] {
  const order: string[] = [];
  const byKey = new Map<string, SignalGroup<T>>();
  for (const signal of signals) {
    const key = normalizeSummary(signal.summary);
    let group = byKey.get(key);
    if (!group) {
      group = { key, summary: signal.summary, members: [] };
      byKey.set(key, group);
      order.push(key);
    }
    group.members.push(signal);
  }
  return order.map((key) => byKey.get(key)!);
}

const CONF_RANK: Record<Lesson["conf"], number> = {
  high: 3,
  medium: 2,
  low: 1,
};

/**
 * Collapse near-duplicate lessons (identical normalised text) into one, summing
 * `ev`, keeping the earliest `date`, the latest `last`, the max confidence, the
 * strongest `kind` (constraint outranks a softer kind), and OR-ing
 * `provisional` to `false` if any duplicate is active. Order is stable: the
 * first occurrence's position is retained.
 *
 * Deterministic and lossless on `ev` — the summed evidence flows straight into
 * the eviction score so a merged lesson is *harder* to evict, never easier.
 */
export function dedupeLessons(lessons: ReadonlyArray<Lesson>): Lesson[] {
  const order: string[] = [];
  const byKey = new Map<string, Lesson>();
  for (const lesson of lessons) {
    const key = normalizeSummary(lesson.text);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, { ...lesson });
      order.push(key);
      continue;
    }
    existing.ev += lesson.ev;
    if (lesson.date < existing.date) existing.date = lesson.date;
    if (lesson.last > existing.last) existing.last = lesson.last;
    if (CONF_RANK[lesson.conf] > CONF_RANK[existing.conf]) {
      existing.conf = lesson.conf;
    }
    if (lesson.kind === "constraint") existing.kind = "constraint";
    existing.provisional = existing.provisional && lesson.provisional;
  }
  return order.map((key) => byKey.get(key)!);
}
