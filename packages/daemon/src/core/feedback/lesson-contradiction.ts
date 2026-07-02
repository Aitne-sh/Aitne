/**
 * SELF_IMPROVEMENT_PHASE2 §2.2 — deterministic contradiction pairing.
 *
 * For a promote-candidate, find same-scope existing lessons that are
 * *contradiction suspects* — cheap, deterministic cues only; judging whether
 * an apparent conflict is real (vs. context-scoped) stays with the evening
 * LLM. Three cue classes, per the design:
 *
 *   - **opposing kind**: `do-more` vs `do-less` on an overlapping topic;
 *   - **negation**: the candidate opens with a negation cue ("stop", "don't",
 *     "never", …) against an existing affirmative directive;
 *   - **token overlap** ≥ {@link MIN_OVERLAP_TOKENS} significant tokens.
 *
 * Suspects are capped at {@link MAX_SUSPECTS} (context frugality) and only
 * *active* (non-provisional) lessons can be contradicted — a provisional
 * lesson is not yet binding, so there is nothing to whiplash.
 *
 * Pure logic, no I/O — in the 100%-covered `core/feedback/*` subset.
 */

import { lessonCf, type Lesson, type LessonKind } from "./lesson-format.js";
import { normalizeSummary } from "./lesson-merge.js";
import { contradictionOverrideBar } from "./promotion-gate.js";

/** Token-overlap bar for the standalone overlap cue. */
export const MIN_OVERLAP_TOKENS = 3;
/** Softer overlap bar when another cue (kind opposition / negation) fires. */
export const MIN_CUED_OVERLAP_TOKENS = 2;
/** Cap on suspects surfaced per candidate (§2.2, C3). */
export const MAX_SUSPECTS = 3;

/** Leading negation cues — a candidate that *negates* an affirmative. */
const NEGATION_CUE_RE =
  /^(?:stop|don['’]t|do not|never|no longer|avoid|quit)\b/i;

/**
 * Small stopword set for significant-token extraction. Deliberately tiny —
 * `normalizeSummary` already lowercases/strips punctuation, and the ≥4-char
 * filter drops most function words; this catches the long common ones.
 */
const STOPWORDS: ReadonlySet<string> = new Set([
  "about",
  "after",
  "always",
  "because",
  "before",
  "between",
  "could",
  "every",
  "should",
  "their",
  "there",
  "these",
  "thing",
  "those",
  "when",
  "where",
  "which",
  "while",
  "with",
  "would",
  "your",
]);

/** Normalized, stopword-free tokens of ≥4 chars — the overlap vocabulary. */
export function significantTokens(text: string): Set<string> {
  const tokens = new Set<string>();
  for (const token of normalizeSummary(text).split(" ")) {
    if (token.length >= 4 && !STOPWORDS.has(token)) tokens.add(token);
  }
  return tokens;
}

export interface ContradictionSuspect {
  /** Index into the caller's `existing` array (NOT a worksheet rank). */
  index: number;
  /** Which cue fired, with the overlap count — for the worksheet `reason`. */
  reason: string;
  /** Significant-token overlap, for ranking suspects. */
  overlap: number;
}

export interface ContradictionCandidate {
  text: string;
  /** Best-effort candidate kind (worksheet `candidateKind`), if known. */
  kind?: LessonKind | null;
}

function opposingKinds(
  a: LessonKind | null | undefined,
  b: LessonKind,
): boolean {
  return (
    (a === "do-more" && b === "do-less") || (a === "do-less" && b === "do-more")
  );
}

function overlapCount(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  let count = 0;
  for (const token of a) if (b.has(token)) count += 1;
  return count;
}

/**
 * Find the top contradiction suspects for `candidate` among the `existing`
 * lessons (provisional entries are skipped — indices always refer to the
 * caller's array). Suspects rank by overlap (desc), capped at
 * {@link MAX_SUSPECTS}.
 */
export function findContradictionSuspects(
  candidate: ContradictionCandidate,
  existing: ReadonlyArray<Lesson>,
  opts?: { minOverlapTokens?: number; maxSuspects?: number },
): ContradictionSuspect[] {
  const minOverlap = opts?.minOverlapTokens ?? MIN_OVERLAP_TOKENS;
  const maxSuspects = opts?.maxSuspects ?? MAX_SUSPECTS;
  const candidateTokens = significantTokens(candidate.text);
  if (candidateTokens.size === 0) return [];
  const candidateNegates = NEGATION_CUE_RE.test(candidate.text.trim());

  const suspects: ContradictionSuspect[] = [];
  existing.forEach((lesson, index) => {
    if (lesson.provisional) return;
    const overlap = overlapCount(candidateTokens, significantTokens(lesson.text));
    if (overlap === 0) return;
    if (opposingKinds(candidate.kind, lesson.kind) && overlap >= MIN_CUED_OVERLAP_TOKENS) {
      suspects.push({ index, reason: `opposing-kind overlap=${overlap}`, overlap });
      return;
    }
    if (
      candidateNegates &&
      !NEGATION_CUE_RE.test(lesson.text.trim()) &&
      overlap >= MIN_CUED_OVERLAP_TOKENS
    ) {
      suspects.push({ index, reason: `negation overlap=${overlap}`, overlap });
      return;
    }
    if (overlap >= minOverlap) {
      suspects.push({ index, reason: `token-overlap=${overlap}`, overlap });
    }
  });

  suspects.sort((a, b) => b.overlap - a.overlap || a.index - b.index);
  return suspects.slice(0, maxSuspects);
}

/**
 * §2.3 × §2.2 — the normalizer's re-promote guard. Before a provisional
 * lesson's marker is cleared, check it against the section's *stamped* active
 * peers: if it contradicts an established lesson (`cf ≥ guardCf`), require
 * its evidence to clear the same higher anti-whiplash bar the promotion gate
 * applies (`ev ≥ 1.5 · threshold · cf`), so a contradiction-held candidate
 * cannot sneak in through the corroboration side door.
 */
export function buildRepromoteGuard(opts: {
  guardCf: number;
  threshold: number;
}): (lesson: Lesson, activePeers: ReadonlyArray<Lesson>) => boolean {
  return (lesson, activePeers) => {
    const suspects = findContradictionSuspects(
      { text: lesson.text, kind: lesson.kind },
      activePeers,
    );
    if (suspects.length === 0) return true;
    const maxCf = Math.max(
      ...suspects.map((suspect) => lessonCf(activePeers[suspect.index])),
    );
    if (maxCf < opts.guardCf) return true;
    return lesson.ev >= contradictionOverrideBar(opts.threshold, maxCf);
  };
}
