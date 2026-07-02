/**
 * Feedback Learning Loop — eviction scorer + cap enforcer (FEEDBACK_LEARNING_LOOP_DESIGN.md §6).
 *
 * A **new** pure-logic module (not `trimBulletEntries`, which is recency
 * top-N with no notion of `ev`/`kind`; not `clearEntriesBefore`, which keys on
 * the *leading* `[date]` not the trailer `last=`). It scores lessons and, when
 * a file is over its per-scope byte/entry cap, evicts the lowest-scored first
 * — provisional + stale go first — emitting an `[...N omitted]` marker.
 *
 *   score = w_ev·log(ev+1) + w_recency·decay(last) + w_kind·importance(kind)
 *
 * where importance is `constraint > correction > do-more/do-less > preference`.
 * Provisional lessons carry a fixed penalty so they sort below active peers of
 * equal evidence. Near-duplicates are merged (their `ev` summed) *before*
 * eviction is considered, so a merged lesson is harder to evict, never easier.
 */

import {
  formatLessonsSection,
  lessonCf,
  type Lesson,
  type LessonKind,
} from "./lesson-format.js";
import { dedupeLessons } from "./lesson-merge.js";

export interface EvictionWeights {
  ev: number;
  recency: number;
  kind: number;
  /** Subtracted from a provisional lesson's score so it evicts first. */
  provisionalPenalty: number;
}

export const DEFAULT_EVICTION_WEIGHTS: EvictionWeights = {
  ev: 1.0,
  recency: 1.0,
  kind: 0.75,
  provisionalPenalty: 1.0,
};

/** Half-life (days) of the recency decay term. */
export const DEFAULT_RECENCY_HALFLIFE_DAYS = 45;

const KIND_IMPORTANCE: Record<LessonKind, number> = {
  constraint: 4,
  correction: 3,
  "do-more": 2,
  "do-less": 2,
  preference: 1,
};

/** `constraint` > `correction` > `do-more`/`do-less` > `preference`. */
export function kindImportance(kind: LessonKind): number {
  return KIND_IMPORTANCE[kind];
}

function dateToMs(date: string): number {
  const ms = Date.parse(`${date.slice(0, 10)}T00:00:00Z`);
  return Number.isFinite(ms) ? ms : NaN;
}

/**
 * Exponential recency decay in `[0, 1]`: `1` for a lesson reinforced today,
 * `0.5` at one half-life, approaching `0` for ancient lessons. A future or
 * unparseable `last` clamps to `1` (treated as fresh — never penalised for a
 * clock/format quirk).
 */
export function recencyDecay(
  last: string,
  nowIso: string,
  halfLifeDays: number = DEFAULT_RECENCY_HALFLIFE_DAYS,
): number {
  const lastMs = dateToMs(last);
  const nowMs = Date.parse(nowIso);
  if (!Number.isFinite(lastMs) || !Number.isFinite(nowMs)) return 1;
  const ageDays = (nowMs - lastMs) / 86_400_000;
  if (ageDays <= 0) return 1;
  return Math.pow(0.5, ageDays / halfLifeDays);
}

/** Composite eviction score — higher means keep, lower means evict first.
 *  Phase-2 §2.1 folds `cf` into the evidence term (`w_ev·log(ev+1)·cf`) so a
 *  low-confidence lesson evicts before an equally-evidenced confident one. */
export function scoreLesson(
  lesson: Lesson,
  nowIso: string,
  weights: EvictionWeights = DEFAULT_EVICTION_WEIGHTS,
  halfLifeDays: number = DEFAULT_RECENCY_HALFLIFE_DAYS,
): number {
  const evTerm =
    weights.ev * Math.log(Math.max(lesson.ev, 0) + 1) * lessonCf(lesson);
  const recencyTerm =
    weights.recency * recencyDecay(lesson.last, nowIso, halfLifeDays);
  const kindTerm = weights.kind * kindImportance(lesson.kind);
  const penalty = lesson.provisional ? weights.provisionalPenalty : 0;
  return evTerm + recencyTerm + kindTerm - penalty;
}

/**
 * Effective (time-decayed) confidence — Phase-2 §2.1 "cf is multiplied by
 * recencyDecay(last) at read/rank time rather than rewritten". This is the
 * value the injection floor filters on and (Gate 3) the demote test compares
 * against the floor; the *persisted* cf is what {@link scoreLesson} folds in,
 * because the score already carries its own recency term (double-decay would
 * over-punish idle lessons).
 */
export function effectiveCf(
  lesson: Lesson,
  nowIso: string,
  halfLifeDays: number = DEFAULT_RECENCY_HALFLIFE_DAYS,
): number {
  return lessonCf(lesson) * recencyDecay(lesson.last, nowIso, halfLifeDays);
}

/**
 * §4 step 7 staleness test — a lesson is prunable for staleness when its `last`
 * reinforcement predates `now − staleDays` and it is not a durable
 * `constraint`. Shared single source of truth for both worksheet builders
 * (the nightly `consolidation-prep` and the monthly `regeneralization-prep`)
 * so the `stale="…"` flag they stamp can never drift apart.
 *
 * Semantics (kept byte-stable across the two prior local copies):
 *   - no horizon configured (`staleDays === undefined`) ⇒ never stale;
 *   - `kind=constraint` ⇒ never stale (durable);
 *   - an unparseable `last` (or `nowIso`) yields a `NaN` comparison, which is
 *     `false` — i.e. never prune on a clock/format quirk. Reuses {@link dateToMs}
 *     for the same `YYYY-MM-DD → epoch ms` parse the recency decay uses.
 */
export function isLessonStale(
  lesson: Lesson,
  nowIso: string,
  staleDays: number | undefined,
): boolean {
  if (staleDays === undefined || lesson.kind === "constraint") return false;
  const lastMs = dateToMs(lesson.last);
  const nowMs = Date.parse(nowIso);
  return (nowMs - lastMs) / 86_400_000 > staleDays;
}

export interface CapConfig {
  maxBytes: number;
  maxEntries: number;
}

export interface EvictionPlan {
  /** Lessons that survive, in eviction-score order (highest first). */
  keep: Lesson[];
  /** Lessons removed to satisfy the cap, lowest-scored first. */
  evicted: Lesson[];
  /** `[...N … omitted]` marker when anything was evicted, else `null`. */
  omittedMarker: string | null;
  /** Serialized byte length of the kept section incl. header + marker. */
  bytes: number;
}

export function omittedMarker(count: number): string {
  return `- [...${count} lower-signal lessons omitted — full history in feedback_signals]`;
}

/**
 * Dedupe, score, sort (highest first), then evict the lowest-scored lessons
 * until the section fits both `maxEntries` and `maxBytes`. The byte cap is
 * checked against the *serialized* section (header + bullets + marker) so the
 * measured size matches what lands on disk.
 *
 * Always makes progress when over the byte cap with ≥1 lesson — even a single
 * lesson longer than the cap is reduced to an empty kept set with the marker —
 * so the loop terminates.
 */
export function enforceCaps(
  lessons: ReadonlyArray<Lesson>,
  cap: CapConfig,
  nowIso: string,
  opts: { scopeLabel: string },
  weights: EvictionWeights = DEFAULT_EVICTION_WEIGHTS,
  halfLifeDays: number = DEFAULT_RECENCY_HALFLIFE_DAYS,
): EvictionPlan {
  const deduped = dedupeLessons(lessons);
  const sorted = [...deduped].sort(
    (a, b) =>
      scoreLesson(b, nowIso, weights, halfLifeDays) -
      scoreLesson(a, nowIso, weights, halfLifeDays),
  );

  const evicted: Lesson[] = [];
  let keep = sorted;

  // Entry cap first — cheap, and shrinks the byte-cap work. Reverse the
  // overflow slice (it comes off the descending-sorted array) so `evicted`
  // honours its documented lowest-scored-first order; the byte-cap loop
  // below already pushes lowest-first, so the combined array stays
  // ascending by score.
  if (keep.length > cap.maxEntries) {
    evicted.push(...keep.slice(cap.maxEntries).reverse());
    keep = keep.slice(0, cap.maxEntries);
  }

  const sectionOpts = {
    scopeLabel: opts.scopeLabel,
    capBytes: cap.maxBytes,
    maxEntries: cap.maxEntries,
  };
  const measure = (lessonsToMeasure: Lesson[]): number =>
    Buffer.byteLength(
      formatLessonsSection(lessonsToMeasure, {
        ...sectionOpts,
        omittedMarker:
          evicted.length > 0 ? omittedMarker(evicted.length) : null,
      }),
      "utf-8",
    );

  // Byte cap — drop lowest-scored (tail of the sorted array) until it fits.
  while (keep.length > 0 && measure(keep) > cap.maxBytes) {
    evicted.push(keep[keep.length - 1]);
    keep = keep.slice(0, -1);
  }

  const marker = evicted.length > 0 ? omittedMarker(evicted.length) : null;
  return {
    keep,
    evicted,
    omittedMarker: marker,
    bytes: Buffer.byteLength(
      formatLessonsSection(keep, { ...sectionOpts, omittedMarker: marker }),
      "utf-8",
    ),
  };
}
