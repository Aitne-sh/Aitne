/**
 * SELF_IMPROVEMENT_PHASE2 §2.1/§2.3 — the deterministic post-write normalizer.
 *
 * The evening LLM authors lesson *prose* during the wholesale `## Lessons`
 * section rewrite; this pass then stamps/repairs the one numeric key the
 * daemon actually ranks, filters, and decays on — `cf=` — and (Gate 3) enacts
 * the computed expiration verdicts, so neither ever depends on an LLM
 * faithfully transcribing a float or honouring an `action=` attribute.
 *
 * It is **self-contained**: no lesson identity survives the LLM rewrite (the
 * §3.2 argument that deferred A2.2), so worksheet-computed floats cannot be
 * matched to rewritten bullets. Instead every value is re-derived from the
 * previous file content plus the written bullet's own trailer:
 *
 *   1. **Carry** — same normalized text existed before → carry its `cf`
 *      forward; if the write corroborated it (`ev` grew or `last` advanced),
 *      bump `cf ← cf + (1−cf)·γ` (γ = {@link CORROBORATION_GAMMA}).
 *   2. **Transcribe** — new/reworded bullet already carrying a valid `cf`
 *      (the LLM copied the worksheet's `cf0=`) → keep it (clamped, 2dp).
 *   3. **Derive** — otherwise `cf0 = saturate(ev, K) · sourceFactor(src)`
 *      ({@link computeInitialCf}), the §2.1 initial-confidence model.
 *   4. **Backfill** — a legacy pre-Phase-2 bullet (no `cf` before or after)
 *      gets the qualitative default ({@link CONF_CF_DEFAULTS}) so the lazy
 *      on-disk backfill converges on what {@link lessonCf} already reads.
 *
 * The rewrite is **surgical**: only trailer comments are touched (the last
 * attr-bearing comment per entry — the one that wins the tolerant
 * merge-in-document-order parse), plus Gate-3 marker edits / entry removals.
 * LLM-authored prose is preserved byte-for-byte, and re-running the pass on
 * its own output is a no-op (idempotent), which is what lets it sit
 * synchronously in the context write pipeline AND run as the daily
 * mechanical sweep (`lesson-maintenance.ts`) with `prev == current`.
 *
 * Pure logic, no I/O — the FS glue lives in the write route / maintenance
 * job; this module is in the 100%-covered `core/feedback/*` subset.
 */

import {
  CONF_CF_DEFAULTS,
  formatCfValue,
  lessonCf,
  LESSON_ENTRY_START_RE,
  LESSON_OMITTED_MARKER_RE,
  parseLessonsSection,
  roundCf,
  type Lesson,
} from "./lesson-format.js";
import { computeInitialCf, SOURCE_CF_FACTOR } from "./promotion-gate.js";
import { effectiveCf, isLessonStale } from "./eviction-scorer.js";
import { dedupeLessons, normalizeSummary } from "./lesson-merge.js";

/** §2.1 corroboration bump rate: `cf ← cf + (1−cf)·γ`. */
export const CORROBORATION_GAMMA = 0.3;

export interface LessonNormalizerOptions {
  /** ISO timestamp — drives the effective-cf decay in expiration verdicts. */
  nowIso: string;
  /** `feedbackPromotionThreshold` — the K in the §2.1 saturate() model. */
  promotionThreshold: number;
  /**
   * Gate 3 (§2.3): when true, enact the computed expiration lifecycle —
   * demote (active ∧ stale ∧ effective cf < floor → `<!-- provisional -->`),
   * archive (provisional ∧ no corroboration in 2× staleDays → remove), and
   * re-promote (provisional ∧ corroborated at `today` ∧ ev ≥ threshold →
   * marker cleared). Requires `staleDays` + `confidenceFloor`; conditions
   * whose inputs are absent simply never fire (never destructive by default).
   */
  enactExpiration?: boolean;
  /** `feedbackLessonStaleDays` staleness horizon (Gate 3). */
  staleDays?: number;
  /** `feedbackLessonConfidenceFloor` (Gate 3 demote test). */
  confidenceFloor?: number;
  /**
   * Local `YYYY-MM-DD` for the re-promote "corroborated this write" test.
   * Defaults to `nowIso.slice(0, 10)` — callers with a configured timezone
   * should pass their local agent-day instead.
   */
  today?: string;
  /**
   * Gate 3 re-promote guard (§2.2, Phase 3): before clearing a provisional
   * marker, the caller-supplied hook may veto (e.g. contradiction-held
   * candidates must clear the higher anti-whiplash bar). Absent ⇒ no veto.
   */
  repromoteGuard?: (lesson: Lesson, activePeers: ReadonlyArray<Lesson>) => boolean;
}

export interface LessonNormalizerStats {
  /** Lesson entries seen in the written `## Lessons` section. */
  total: number;
  /** cf carried forward from the previous file (incl. bumped). */
  carried: number;
  /** Carried cfs that received the corroboration bump. */
  bumped: number;
  /** cf kept from the bullet's own trailer (worksheet transcription). */
  transcribed: number;
  /** cf derived from the §2.1 initial model (new bullet, no valid cf). */
  derived: number;
  /** Legacy bullets stamped with the qualitative-conf default. */
  backfilled: number;
  /** Gate 3: active → provisional demotions enacted. */
  demoted: number;
  /** Gate 3: provisional entries removed from the section. */
  archived: number;
  /** Gate 3: provisional markers cleared (re-promotions). */
  repromoted: number;
}

export interface LessonNormalizerResult {
  content: string;
  changed: boolean;
  stats: LessonNormalizerStats;
}

/** A lesson entry's inclusive line range within the file's line array. */
interface EntrySpan {
  start: number;
  end: number;
}

const ANY_COMMENT_RE = /<!--([\s\S]*?)-->/g;
const PROVISIONAL_MARKER_RE = /\s*<!--\s*provisional\s*-->/gi;
/** A comment body carrying trailer attributes (vs. `provisional` / `scope:`). */
const ATTR_COMMENT_RE = /\b(?:ev|kind|src|conf|cf|last)=/;

function emptyStats(): LessonNormalizerStats {
  return {
    total: 0,
    carried: 0,
    bumped: 0,
    transcribed: 0,
    derived: 0,
    backfilled: 0,
    demoted: 0,
    archived: 0,
    repromoted: 0,
  };
}

/**
 * Locate the `## Lessons` body as a line range `[start, end)` — the lines
 * between the header and the next `#`/`##` heading — mirroring
 * `extractMarkdownSection` semantics so the two can never disagree on what
 * "the section" is.
 */
function findLessonsSectionBounds(
  lines: ReadonlyArray<string>,
): { start: number; end: number } | null {
  const header = lines.findIndex((line) => line.trim() === "## Lessons");
  if (header < 0) return null;
  let end = lines.length;
  for (let i = header + 1; i < lines.length; i++) {
    if (/^#{1,2}\s/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return { start: header + 1, end };
}

/**
 * Walk the section body with the same state machine `parseLessonsSection`
 * uses (shared entry-start / omitted-marker regexes) and return each entry's
 * inclusive line span. Non-entry lines (scope header comment, blanks, the
 * eviction marker, stray prose) belong to no span and are never rewritten.
 */
function collectEntrySpans(
  lines: ReadonlyArray<string>,
  start: number,
  end: number,
): EntrySpan[] {
  const spans: EntrySpan[] = [];
  let current: EntrySpan | null = null;
  const close = (): void => {
    if (current) spans.push(current);
    current = null;
  };
  for (let i = start; i < end; i++) {
    const line = lines[i];
    if (LESSON_ENTRY_START_RE.test(line)) {
      close();
      current = { start: i, end: i };
      continue;
    }
    if (LESSON_OMITTED_MARKER_RE.test(line)) {
      close();
      continue;
    }
    if (current && (line.startsWith("  ") || line.trim().startsWith("<!--"))) {
      current.end = i;
    } else {
      close();
    }
  }
  close();
  return spans;
}

/** Canonical trailer for a lesson with its computed cf. */
function canonicalTrailer(lesson: Lesson, cf: number): string {
  return (
    `<!-- ev=${lesson.ev} kind=${lesson.kind} src=${lesson.src} ` +
    `conf=${lesson.conf} cf=${formatCfValue(cf)} last=${lesson.last} -->`
  );
}

/**
 * Find the last attr-bearing comment across the span (the one whose keys win
 * the merge-in-document-order parse) as `{ line, comment }`, or `null` when
 * the entry carries no trailer at all (hand-written bullet).
 */
function findLastAttrComment(
  lines: ReadonlyArray<string>,
  span: EntrySpan,
): { line: number; comment: string } | null {
  for (let i = span.end; i >= span.start; i--) {
    const matches = [...lines[i].matchAll(ANY_COMMENT_RE)];
    for (let m = matches.length - 1; m >= 0; m--) {
      if (ATTR_COMMENT_RE.test(matches[m][1])) {
        return { line: i, comment: matches[m][0] };
      }
    }
  }
  return null;
}

interface CfDecision {
  cf: number;
  kind: "carried" | "bumped" | "transcribed" | "derived" | "backfilled";
}

/** Apply the header-comment D1 rules for one written lesson. */
function decideCf(
  lesson: Lesson,
  prevBySummary: ReadonlyMap<string, Lesson>,
  promotionThreshold: number,
): CfDecision {
  const prev = prevBySummary.get(normalizeSummary(lesson.text));
  if (prev) {
    const base = lessonCf(prev);
    const corroborated = lesson.ev > prev.ev || lesson.last > prev.last;
    if (corroborated) {
      return { cf: roundCf(base + (1 - base) * CORROBORATION_GAMMA), kind: "bumped" };
    }
    // Unchanged legacy bullet (no cf before): the carry IS the lazy backfill.
    return { cf: roundCf(base), kind: prev.cf === null ? "backfilled" : "carried" };
  }
  if (lesson.cf !== null) {
    // A fresh bullet's cf can only come from the worksheet's cf0, and the
    // §2.1 model can never produce more than `sourceFactor` (saturate < 1).
    // Cap the transcription there so a hallucinated float can't mint an
    // instantly-established lesson the anti-whiplash guard then protects.
    // (Legitimate cf above the factor only arises via corroboration bumps,
    // which flow through the carry branch above, never this one.)
    return {
      cf: Math.min(lesson.cf, SOURCE_CF_FACTOR[lesson.src]),
      kind: "transcribed",
    };
  }
  return {
    cf: computeInitialCf(lesson.ev, lesson.src, promotionThreshold),
    kind: "derived",
  };
}

type ExpirationVerdict = "keep" | "demote" | "archive" | "repromote";

/**
 * Gate 3 (§2.3) verdict table over the *stamped* lesson. `constraint` is
 * durable; demote needs stale + effective (decayed) cf below the floor;
 * archive needs a provisional lesson uncorroborated for 2× the horizon;
 * re-promote needs corroboration at `today` clearing the promotion bar.
 */
export function expirationVerdict(
  lesson: Lesson,
  opts: {
    nowIso: string;
    today: string;
    promotionThreshold: number;
    staleDays?: number;
    confidenceFloor?: number;
  },
): ExpirationVerdict {
  if (lesson.kind === "constraint") return "keep";
  if (lesson.provisional) {
    if (lesson.last === opts.today && lesson.ev >= opts.promotionThreshold) {
      return "repromote";
    }
    if (
      opts.staleDays !== undefined &&
      isLessonStale(lesson, opts.nowIso, opts.staleDays * 2)
    ) {
      return "archive";
    }
    return "keep";
  }
  if (
    opts.staleDays !== undefined &&
    opts.confidenceFloor !== undefined &&
    isLessonStale(lesson, opts.nowIso, opts.staleDays) &&
    effectiveCf(lesson, opts.nowIso) < opts.confidenceFloor
  ) {
    return "demote";
  }
  return "keep";
}

/**
 * Normalize the `## Lessons` section of an outgoing lessons-store write:
 * stamp/repair `cf=` per the module-header rules and, when
 * `opts.enactExpiration`, enact the Gate-3 lifecycle. Content without a
 * `## Lessons` section (or with no entries) passes through unchanged.
 */
export function normalizeLessonsFileContent(
  newFileMd: string,
  prevFileMd: string | null,
  opts: LessonNormalizerOptions,
): LessonNormalizerResult {
  const stats = emptyStats();
  const eol = /\r\n/.test(newFileMd) ? "\r\n" : "\n";
  const lines = newFileMd.split(/\r?\n/);
  const bounds = findLessonsSectionBounds(lines);
  if (!bounds) return { content: newFileMd, changed: false, stats };

  const spans = collectEntrySpans(lines, bounds.start, bounds.end);
  if (spans.length === 0) return { content: newFileMd, changed: false, stats };

  // Previous lessons, deduped (summed ev / max cf) so a duplicated bullet
  // can't make its own rewrite look like fresh corroboration.
  const prevLessons = prevFileMd
    ? dedupeLessons(parseLessonsSection(prevFileMd))
    : [];
  const prevBySummary = new Map<string, Lesson>(
    prevLessons.map((lesson) => [normalizeSummary(lesson.text), lesson]),
  );

  const today = opts.today ?? opts.nowIso.slice(0, 10);
  const replacements = new Map<number, string>();
  const insertAfter = new Map<number, string>();
  const removedSpans: EntrySpan[] = [];

  // First pass: parse + stamp every entry so re-promote guards can see the
  // final active set (peers use their stamped cf, not the written one).
  const entries: Array<{ span: EntrySpan; lesson: Lesson; cf: number }> = [];
  for (const span of spans) {
    const parsed = parseLessonsSection(
      lines.slice(span.start, span.end + 1).join("\n"),
    );
    /* c8 ignore next — spans start with an entry-start line by construction */
    if (parsed.length !== 1) continue;
    const lesson = parsed[0];
    stats.total += 1;
    const decision = decideCf(lesson, prevBySummary, opts.promotionThreshold);
    stats[decision.kind] += 1;
    entries.push({
      span,
      lesson: { ...lesson, cf: decision.cf },
      cf: decision.cf,
    });
  }

  const activePeersOf = (self: EntrySpan): Lesson[] =>
    entries
      .filter((entry) => entry.span !== self && !entry.lesson.provisional)
      .map((entry) => entry.lesson);

  for (const { span, lesson, cf } of entries) {
    const verdict = opts.enactExpiration
      ? expirationVerdict(lesson, {
          nowIso: opts.nowIso,
          today,
          promotionThreshold: opts.promotionThreshold,
          staleDays: opts.staleDays,
          confidenceFloor: opts.confidenceFloor,
        })
      : "keep";

    if (verdict === "archive") {
      removedSpans.push(span);
      stats.archived += 1;
      continue;
    }

    const repromote =
      verdict === "repromote" &&
      (opts.repromoteGuard?.(lesson, activePeersOf(span)) ?? true);

    // Demotion rides the same trailer write (marker appended to it) so a
    // freshly-inserted trailer and a replaced one behave identically.
    const marker = verdict === "demote" ? " <!-- provisional -->" : "";
    const trailer = canonicalTrailer(lesson, cf) + marker;
    const existing = findLastAttrComment(lines, span);
    if (existing) {
      // Splice at the LAST occurrence — the comment whose keys win the
      // merge-in-document-order parse — so a pathological duplicated trailer
      // can't leave stale attrs overriding the canonical ones. Spans are
      // disjoint, so the base is always the original line.
      const base = lines[existing.line];
      const at = base.lastIndexOf(existing.comment);
      replacements.set(
        existing.line,
        base.slice(0, at) + trailer + base.slice(at + existing.comment.length),
      );
    } else {
      insertAfter.set(span.end, `  ${trailer}`);
    }

    if (verdict === "demote") {
      stats.demoted += 1;
    } else if (repromote) {
      for (let i = span.start; i <= span.end; i++) {
        const base = replacements.get(i) ?? lines[i];
        const cleared = base.replace(PROVISIONAL_MARKER_RE, "");
        if (cleared !== base) replacements.set(i, cleared);
      }
      stats.repromoted += 1;
    }
  }

  const removed = new Set<number>();
  for (const span of removedSpans) {
    for (let i = span.start; i <= span.end; i++) removed.add(i);
  }

  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!removed.has(i)) out.push(replacements.get(i) ?? lines[i]);
    const insertion = insertAfter.get(i);
    if (insertion !== undefined && !removed.has(i)) out.push(insertion);
  }

  const content = out.join(eol);
  // Compare against an eol-normalized original: a pure CRLF→(detected eol)
  // rejoin is not a semantic change.
  const original = lines.join(eol);
  return { content, changed: content !== original, stats };
}
