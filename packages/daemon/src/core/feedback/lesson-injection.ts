/**
 * Feedback Learning Loop — Stage 3 inject renderer (FEEDBACK_LEARNING_LOOP_DESIGN.md §5/§6).
 *
 * Renders the `<agent_lessons>` block `ContextBuilder` pushes onto DM /
 * notify-deciding turns. Pure logic, no I/O — the FS read (the lessons file)
 * lives in the coverage-excluded builder; this module owns the *structure* and
 * the *cap*, and is in the 100%-covered `core/feedback/*` subset (§8).
 *
 * Three variants, matching the §5/§6 split — all pack the highest-signal lessons
 * under their cap via one shared {@link packByScore} core, differing only in the
 * wrapper tag, preamble, cap unit, entry cap, and whether an over-cap is an
 * operability signal:
 *
 *  - **global** (DM + review cadences + defined-agent runs) — emit every
 *    *active* (non-provisional) lesson from `policies/agent-lessons.md` when the
 *    body fits the cap. Over cap the block **degrades to the top-N lessons by
 *    score** (v1.5 §11.6) and the builder warns: the cap stays a hard,
 *    non-bypassable guarantee (the emitted body never exceeds it), but the agent
 *    keeps the highest-signal lessons instead of losing all of them. A degrade
 *    only happens if consolidation failed to pre-cap the file, so it is an
 *    operability signal (`overflow`), not a routine path.
 *  - **self** (Phase 4 — any run bound to an Agent slug) — identical render +
 *    degrade discipline to global, but the source is the per-agent
 *    `policies/agents/<slug>/lessons.md` and the wrapper is
 *    `<agent_lessons scope="self">` with a self-facing preamble. Capped at
 *    `feedbackLessonMaxBytesPerAgent`; over-cap degrades + warns exactly like
 *    global. Selected via `opts.selfScope`.
 *  - **slim** (hourly notify turn) — top-N by eviction score, greedily packed
 *    so the *whole* block stays under the hard 2048-byte budget (§6). Tail
 *    dropping is routine here (tight hourly budget), so the slim path never
 *    reports `overflow`; it just drops the lowest-signal tail.
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
   * Set **only** on the global path when the full body exceeded `capBytes` and
   * lessons had to be dropped to fit — the builder logs a warning.
   *  - `bytes` is the full (over-cap) body size that triggered the degrade;
   *  - `dropped` is how many lessons were left out (all of them when not even
   *    the single highest-scored lesson fits, in which case `block` is `null`).
   *
   * `null` on the slim path (tail-dropping there is routine, not a warning
   * condition) and whenever everything fit. The cap is never breached either
   * way: this signals a degrade, not a cap bypass.
   */
  overflow: { bytes: number; cap: number; dropped: number } | null;
}

export interface RenderAgentLessonsOptions {
  /** Defensive byte cap for the rendered body (global/self) / whole block (slim). */
  capBytes: number;
  /** Slim hourly variant: top-N by score, packed under the hard byte cap. */
  slim: boolean;
  /** ISO timestamp used to score lessons for ranking + degrade. */
  nowIso: string;
  /** Override the slim entry cap (defaults to {@link AGENT_LESSONS_SLIM_MAX_ENTRIES}). */
  maxSlimEntries?: number;
  /**
   * Phase 4 — render the per-agent (`agent:<slug>`) block: wrap as
   * `<agent_lessons scope="self">` with the self preamble, same body cap +
   * degrade discipline as global. Ignored when {@link RenderAgentLessonsOptions.slim}
   * is set (the slim variant is global-only by construction).
   */
  selfScope?: boolean;
}

/** Open tag + preamble for a block variant — the only things that differ between
 *  the global and self renders (both share the body cap + degrade discipline). */
interface BlockStyle {
  openTag: string;
  preamble: string;
}

const GLOBAL_STYLE: BlockStyle = {
  openTag: "<agent_lessons>",
  preamble:
    "Lessons calibrated from past owner feedback and your own reviews. Treat each " +
    "as a standing directive and prefer it over your defaults when they conflict.",
};

const SELF_STYLE: BlockStyle = {
  openTag: '<agent_lessons scope="self">',
  preamble:
    "Lessons calibrated specifically from feedback on THIS agent's own past " +
    "output. Treat each as a standing directive for your work and prefer it over " +
    "your defaults when they conflict.",
};

const SLIM_PREAMBLE =
  "Your highest-signal operating lessons, calibrated from past feedback. Weigh " +
  "these before deciding whether to notify the owner.";

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

function wrap(style: BlockStyle, bullets: ReadonlyArray<string>): string {
  return [style.openTag, style.preamble, ...bullets, "</agent_lessons>"].join("\n");
}

/**
 * Greedily keep the highest-scored lessons whose serialized form — produced by
 * `render`, the cap-measured unit — stays within `capBytes`, up to `maxEntries`.
 * Returns the kept bullets (highest-score-first) and how many lessons dropped.
 *
 * Strict score-prefix: stops at the first lesson that would overflow — a
 * lower-scored shorter tail is never swapped in, since that would violate
 * "top-N by score". Scoring is the same `scoreLesson` consolidation eviction
 * uses, so inject-time ranking matches on-disk ranking. Measuring and keeping
 * the same `bullet` value guarantees what was size-checked is exactly what
 * lands in the block.
 */
function packByScore(
  lessons: ReadonlyArray<Lesson>,
  nowIso: string,
  capBytes: number,
  maxEntries: number,
  render: (bullets: string[]) => string,
): { kept: string[]; dropped: number } {
  const ranked = [...lessons].sort(
    (a, b) => scoreLesson(b, nowIso) - scoreLesson(a, nowIso),
  );
  const kept: string[] = [];
  for (const lesson of ranked) {
    if (kept.length >= maxEntries) break;
    const bullet = bulletFor(lesson);
    if (Buffer.byteLength(render([...kept, bullet]), "utf-8") > capBytes) break;
    kept.push(bullet);
  }
  return { kept, dropped: ranked.length - kept.length };
}

function renderBody(
  lessons: ReadonlyArray<Lesson>,
  capBytes: number,
  nowIso: string,
  style: BlockStyle,
): AgentLessonsBlockResult {
  // Cap on the rendered body — matches the `<management_rules>` precedent
  // (check the content bytes, then wrap unconditionally). The wrapper tag /
  // preamble are the only per-variant difference between global and self.
  const bodyBytes = Buffer.byteLength(lessons.map(bulletFor).join("\n"), "utf-8");
  if (bodyBytes <= capBytes) {
    return { block: wrap(style, lessons.map(bulletFor)), overflow: null };
  }
  // Over cap → graceful degradation (v1.5 §11.6): keep the highest-scored
  // lessons whose body still fits and warn, rather than dropping all of them.
  // The cap stays a hard, non-bypassable guarantee (the emitted body never
  // exceeds it); consolidation should have pre-capped the file, so a degrade
  // here is an operability signal the builder logs.
  const { kept, dropped } = packByScore(
    lessons,
    nowIso,
    capBytes,
    Number.POSITIVE_INFINITY,
    (bullets) => bullets.join("\n"),
  );
  const overflow = { bytes: bodyBytes, cap: capBytes, dropped };
  // Even the single highest-scored bullet can exceed the cap → empty kept set.
  if (kept.length === 0) return { block: null, overflow };
  return { block: wrap(style, kept), overflow };
}

function renderSlim(
  lessons: ReadonlyArray<Lesson>,
  opts: RenderAgentLessonsOptions,
): AgentLessonsBlockResult {
  const maxEntries = opts.maxSlimEntries ?? AGENT_LESSONS_SLIM_MAX_ENTRIES;
  // Measure the *whole* block so the hard 2048 budget covers preamble + tags,
  // not just the bullets. Tail-dropping is routine on the tight hourly turn, so
  // the slim path never reports `overflow`. Slim is global-only — always the
  // plain `<agent_lessons>` wrapper with the notify-discipline preamble.
  const slimStyle: BlockStyle = {
    openTag: GLOBAL_STYLE.openTag,
    preamble: SLIM_PREAMBLE,
  };
  const { kept } = packByScore(
    lessons,
    opts.nowIso,
    opts.capBytes,
    maxEntries,
    (bullets) => wrap(slimStyle, bullets),
  );
  if (kept.length === 0) return { block: null, overflow: null };
  return { block: wrap(slimStyle, kept), overflow: null };
}

/**
 * Render the `<agent_lessons>` block for a surface, or `null` when there is
 * nothing to inject (no file, no `## Lessons` section, no active lessons, or —
 * global/self path only — not even the single highest-scored lesson fits the
 * cap). When the global/self body is over cap but some lessons fit, the block
 * degrades to the top-N by score and `overflow` is set so the caller can warn.
 *
 * Variant selection: `slim` → the hourly notify block; else `selfScope` → the
 * per-agent `<agent_lessons scope="self">` block; else the global block. `slim`
 * and `selfScope` are mutually exclusive by construction (slim wins).
 */
export function renderAgentLessonsBlock(
  fileMd: string | null,
  opts: RenderAgentLessonsOptions,
): AgentLessonsBlockResult {
  if (!fileMd) return { block: null, overflow: null };
  const lessons = activeLessons(fileMd);
  if (lessons.length === 0) return { block: null, overflow: null };
  if (opts.slim) return renderSlim(lessons, opts);
  return renderBody(
    lessons,
    opts.capBytes,
    opts.nowIso,
    opts.selfScope ? SELF_STYLE : GLOBAL_STYLE,
  );
}
