/**
 * Feedback Learning Loop — Stage 3 inject renderer (FEEDBACK_LEARNING_LOOP_DESIGN.md §5/§6).
 *
 * Renders the `<agent_lessons>` block `ContextBuilder` pushes onto DM /
 * notify-deciding turns. Pure logic, no I/O — the FS read (the lessons file)
 * lives in the coverage-excluded builder; this module owns the *structure* and
 * the *cap*, and is in the 100%-covered `core/feedback/*` subset (§8).
 *
 * Two variants, matching the §5/§6 split:
 *
 *  - **global** (DM + review cadences) — emit every *active* (non-provisional)
 *    lesson. The defensive inject cap is checked on the rendered body and over
 *    cap is **skip-with-warn**, mirroring the `<management_rules>` 32 KB guard
 *    in `context-builder.ts` (the hard backstop §4 hop-3 / v1.3 §11.5 says must
 *    land with Phase 3 so the cap guarantee is non-bypassable).
 *  - **slim** (hourly notify turn) — top-N by eviction score, greedily packed
 *    so the *whole* block stays under the hard 2048-byte budget (§6). Never
 *    skips the block wholesale; it drops the lowest-signal tail instead.
 *
 * Provisional lessons are excluded from injection (§4 step 4) — they are stored
 * for corroboration but must not yet bind behaviour. The machine-readable
 * trailers (`<!-- ev=… -->`) are dropped: the agent consumes the directive
 * prose, not the consolidator's bookkeeping.
 */

import {
  extractMarkdownSection,
  parseLessonsSection,
  type Lesson,
} from "./lesson-format.js";
import { scoreLesson } from "./eviction-scorer.js";

/**
 * Hard inject-time byte cap for the slim hourly notify-discipline variant (§6
 * table: "slim notify-discipline subset injected to hourly_check · hard 2048 at
 * inject"). Exported so the builder and tests share one constant.
 */
export const AGENT_LESSONS_SLIM_CAP_BYTES = 2048;

/**
 * Belt-and-braces entry cap for the slim variant: the byte cap is the binding
 * constraint, but a small entry cap keeps the hourly turn focused on the
 * highest-signal lessons even if they are individually tiny.
 */
export const AGENT_LESSONS_SLIM_MAX_ENTRIES = 12;

export interface AgentLessonsBlockResult {
  /** The `<agent_lessons>`-wrapped block, or `null` when nothing is injected. */
  block: string | null;
  /**
   * Set **only** on the global path when the rendered body exceeds `capBytes`
   * — the builder logs a skip-with-warn. `null` on every other outcome
   * (including the slim path, which packs-to-fit rather than skipping).
   */
  skipped: { reason: "over_cap"; bytes: number; cap: number } | null;
}

export interface RenderAgentLessonsOptions {
  /** Defensive byte cap for the rendered body (global) / whole block (slim). */
  capBytes: number;
  /** Slim hourly variant: top-N by score, packed under the hard byte cap. */
  slim: boolean;
  /** ISO timestamp used to score lessons for the slim ranking. */
  nowIso: string;
  /** Override the slim entry cap (defaults to {@link AGENT_LESSONS_SLIM_MAX_ENTRIES}). */
  maxSlimEntries?: number;
}

const GLOBAL_PREAMBLE =
  "Lessons calibrated from past owner feedback and your own reviews. Treat each " +
  "as a standing directive and prefer it over your defaults when they conflict.";

const SLIM_PREAMBLE =
  "Notification-discipline lessons calibrated from past feedback. Weigh these " +
  "before deciding whether to notify the owner.";

/** Parse the `## Lessons` section and keep only injectable (active) lessons. */
function activeLessons(fileMd: string): Lesson[] {
  const section = extractMarkdownSection(fileMd, "Lessons");
  if (!section) return [];
  return parseLessonsSection(section).filter(
    (lesson) => !lesson.provisional && lesson.text.length > 0,
  );
}

/** One lesson as an agent-facing bullet (trailer + date stripped). */
function bulletFor(lesson: Lesson): string {
  return `- ${lesson.text}`;
}

function wrap(preamble: string, bullets: ReadonlyArray<string>): string {
  return ["<agent_lessons>", preamble, ...bullets, "</agent_lessons>"].join("\n");
}

function renderGlobal(
  lessons: ReadonlyArray<Lesson>,
  capBytes: number,
): AgentLessonsBlockResult {
  const bullets = lessons.map(bulletFor);
  // Cap on the rendered body — matches the `<management_rules>` precedent
  // (check the content bytes, then wrap unconditionally).
  const bodyBytes = Buffer.byteLength(bullets.join("\n"), "utf-8");
  if (bodyBytes > capBytes) {
    return {
      block: null,
      skipped: { reason: "over_cap", bytes: bodyBytes, cap: capBytes },
    };
  }
  return { block: wrap(GLOBAL_PREAMBLE, bullets), skipped: null };
}

function renderSlim(
  lessons: ReadonlyArray<Lesson>,
  opts: RenderAgentLessonsOptions,
): AgentLessonsBlockResult {
  const maxEntries = opts.maxSlimEntries ?? AGENT_LESSONS_SLIM_MAX_ENTRIES;
  // Highest eviction score first — "top-N by score" (§6). Scoring is the same
  // function consolidation uses, so inject-time ranking matches disk ranking.
  const ranked = [...lessons].sort(
    (a, b) => scoreLesson(b, opts.nowIso) - scoreLesson(a, opts.nowIso),
  );
  const kept: string[] = [];
  for (const lesson of ranked) {
    if (kept.length >= maxEntries) break;
    const candidate = [...kept, bulletFor(lesson)];
    // Measure the *whole* block so the hard 2048 budget covers preamble + tags,
    // not just the bullets. Strict score-prefix: once the next-highest lesson
    // overflows, stop — swapping in a lower-scored shorter tail would violate
    // "top-N by score".
    if (Buffer.byteLength(wrap(SLIM_PREAMBLE, candidate), "utf-8") > opts.capBytes) {
      break;
    }
    kept.push(bulletFor(lesson));
  }
  // Even the single highest-scored bullet can exceed the cap → empty kept set.
  if (kept.length === 0) return { block: null, skipped: null };
  return { block: wrap(SLIM_PREAMBLE, kept), skipped: null };
}

/**
 * Render the `<agent_lessons>` block for a surface, or `null` when there is
 * nothing to inject (no file, no `## Lessons` section, no active lessons, or —
 * global path only — the body is over cap, in which case `skipped` is set so
 * the caller can warn).
 */
export function renderAgentLessonsBlock(
  fileMd: string | null,
  opts: RenderAgentLessonsOptions,
): AgentLessonsBlockResult {
  if (!fileMd) return { block: null, skipped: null };
  const lessons = activeLessons(fileMd);
  if (lessons.length === 0) return { block: null, skipped: null };
  return opts.slim
    ? renderSlim(lessons, opts)
    : renderGlobal(lessons, opts.capBytes);
}
