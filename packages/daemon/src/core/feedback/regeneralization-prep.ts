/**
 * Feedback Learning Loop — monthly re-generalization pre-step
 * (FEEDBACK_LEARNING_LOOP_DESIGN.md §4 "Monthly re-generalization", Phase 5).
 *
 * The deterministic, daemon-side half of the *monthly* collapse. Where the
 * nightly evening-review pre-step (`consolidation-prep.ts`) folds unconsumed
 * *signals* into lessons, the monthly pass re-reads the *already-consolidated*
 * lesson stores and surfaces them so the LLM can collapse several specific
 * lessons that share a theme into one higher-level principle — e.g. three
 * "shorter mail summary" / "shorter standup" / "shorter report" lessons → one
 * `agent`-scope lesson "Default to terse, bulleted output." This is the engine
 * that turns accumulated specifics into a small set of meaningful generalizations.
 *
 * Two layers, mirroring `consolidation-prep.ts`:
 *   - The dispatcher (coverage-excluded, FS-heavy) enumerates the lesson files
 *     on disk — the global `policies/agent-lessons.md` plus every per-agent
 *     `policies/agents/<slug>/lessons.md` — and reads their contents.
 *   - `buildRegeneralizationWorksheet(scopes, …)` — this pure markdown/XML
 *     composer turns those contents into a `<feedback_regeneralization>` block.
 *     Every output byte is a deterministic function of its inputs, so it stays
 *     I/O-free and 100% coverable.
 *
 * Unlike the evening worksheet, this pass carries **no signals and no consume
 * ids** — it neither promotes nor consumes; it only ranks the existing lessons
 * (lowest-scored first, the same eviction order Step 4 already uses) and flags
 * staleness / over-cap so the LLM's collapse honours the same caps. A scope is
 * surfaced only when it holds at least {@link MIN_LESSONS_FOR_REGENERALIZATION}
 * *active* lessons — you need two to collapse one — and the whole block is
 * omitted when no scope qualifies, so a sparse vault adds nothing to the
 * monthly prompt.
 *
 * **Promotion-neutral by construction.** Only *active* (non-provisional)
 * lessons are surfaced for collapse. Provisional lessons are awaiting
 * corroboration and are owned exclusively by the nightly evening pass — the
 * single promotion authority (`promotion-gate.ts`). Offering them here would
 * let the LLM merge two provisional lessons into one active lesson, summing
 * their `ev` past the threshold and bypassing the gate's
 * `ignored`-only-never-promotes guard (§3.5.1) — the exact sign-inversion the
 * gate exists to kill. They stay in the file untouched; the task-flow tells the
 * LLM to preserve any provisional lesson byte-for-byte.
 */

import {
  extractMarkdownSection,
  lessonCf,
  parseLessonsSection,
  type Lesson,
} from "./lesson-format.js";
import {
  scoreLesson,
  isLessonStale,
  DEFAULT_RECENCY_HALFLIFE_DAYS,
} from "./eviction-scorer.js";
import { formatScope, scopeSectionSlug, type CanonicalScope } from "./scope-parser.js";

/** A scope needs at least this many *active* lessons before a collapse is possible. */
export const MIN_LESSONS_FOR_REGENERALIZATION = 2;

export interface RegeneralizationScopeInput {
  /** `agent` (global) or `agent_slug` (per-agent) — the user scope is handled
   *  by the existing nightly user-profile consolidation, not re-generalised. */
  scope: CanonicalScope;
  /** Canonical store path (`policies/agent-lessons.md` / `policies/agents/<slug>/lessons.md`). */
  storeFile: string;
  /** Current lessons-store file contents. */
  existingFileMd: string;
  /** Byte/entry caps for the scope (§6). */
  caps: { capBytes: number; maxEntries: number };
}

export interface BuildRegeneralizationOptions {
  nowIso: string;
  recencyHalfLifeDays?: number;
  /**
   * Staleness horizon in days (`feedbackLessonStaleDays`, §4 step 7). A lesson
   * whose `last=` predates `now − staleDays` and is not a `constraint` is
   * flagged `stale="true"` so the LLM can drop it while collapsing. Omitted ⇒
   * nothing is flagged stale.
   */
  staleDays?: number;
}

export interface RegeneralizationResult {
  /** `<feedback_regeneralization>…</…>` block for verbatim injection. */
  block: string;
  /** Number of scopes surfaced (each with ≥ MIN_LESSONS_FOR_REGENERALIZATION active lessons). */
  scopeCount: number;
  /** Total *active* lessons surfaced across all scopes (provisional excluded). */
  lessonCount: number;
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function round2(value: number): string {
  return (Math.round(value * 100) / 100).toFixed(2);
}

/** Collapse a one-line excerpt of a lesson for an XML text node.
 *  The clip strips a trailing lone high surrogate so cutting through an
 *  astral char (emoji) can't leave a U+FFFD in the worksheet. */
function inline(text: string, max = 300): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const clipped =
    flat.length > max
      ? `${flat.slice(0, max - 1).replace(/[\uD800-\uDBFF]$/, "")}…`
      : flat;
  return xmlEscape(clipped);
}

function renderScope(
  input: RegeneralizationScopeInput,
  sectionBody: string,
  activeLessons: Lesson[],
  totalEntries: number,
  opts: BuildRegeneralizationOptions,
  out: string[],
): void {
  const label = formatScope(input.scope);
  const section = scopeSectionSlug(input.scope);
  const halfLife = opts.recencyHalfLifeDays ?? DEFAULT_RECENCY_HALFLIFE_DAYS;
  // `current_bytes` / `current_entries` describe the on-disk `## Lessons`
  // SECTION (active + provisional) — the §6 cap unit
  // (`lessonsSectionByteLength` in lesson-format.ts), the same unit the
  // nightly worksheet's `over_cap` and the eviction engine measure. The
  // whole-file measure used previously disagreed with the nightly pass in a
  // narrow band (frontmatter + `# heading` overhead), making the two
  // worksheets contradict each other on the same store. `over_cap` covers
  // the full entry set, not just the collapsible active subset — the LLM's
  // Step-12 eviction targets the disk cap. The caller extracted
  // `sectionBody` once during eligibility (a scope is only eligible when
  // its `## Lessons` section parsed), so it is measured here verbatim.
  const currentBytes = Buffer.byteLength(sectionBody, "utf-8");
  const overCap =
    currentBytes > input.caps.capBytes || totalEntries > input.caps.maxEntries;
  const provisionalHeld = totalEntries - activeLessons.length;

  // Ascending score → rank 1 = lowest score = drop-first, the same convention
  // the evening worksheet uses so the LLM reads both with one mental model.
  const ranked = [...activeLessons].sort(
    (a, b) =>
      scoreLesson(a, opts.nowIso, undefined, halfLife) -
      scoreLesson(b, opts.nowIso, undefined, halfLife),
  );

  out.push(
    `  <scope label="${xmlEscape(label)}" store="${xmlEscape(input.storeFile)}" ` +
      `section="${xmlEscape(section)}" ` +
      `cap_bytes="${input.caps.capBytes}" max_entries="${input.caps.maxEntries}" ` +
      `current_bytes="${currentBytes}" current_entries="${totalEntries}" ` +
      `provisional_held="${provisionalHeld}" over_cap="${overCap}">`,
  );
  out.push(
    `    <lessons note="active (non-provisional) lessons only, ranked by eviction ` +
      `score (rank 1 = lowest, drop-first); cluster lessons that share a theme ` +
      `and collapse each cluster into ONE higher-level principle; drop any lesson ` +
      `marked stale=&quot;true&quot; unless it joins a cluster; never collapse ` +
      `across a contradiction; preserve any provisional lesson in the file ` +
      `byte-for-byte — they await corroboration and are not yours to collapse or promote">`,
  );
  ranked.forEach((lesson, idx) => {
    out.push(
      `      <lesson rank="${idx + 1}" score="${round2(
        scoreLesson(lesson, opts.nowIso, undefined, halfLife),
      )}" ev="${lesson.ev}" cf="${round2(lessonCf(lesson))}" ` +
        `kind="${lesson.kind}" last="${lesson.last}" ` +
        `provisional="${lesson.provisional}" ` +
        `stale="${isLessonStale(lesson, opts.nowIso, opts.staleDays)}">` +
        `${inline(lesson.text)}</lesson>`,
    );
  });
  out.push("    </lessons>");
  out.push("  </scope>");
}

/**
 * Compose the `<feedback_regeneralization>` block. Returns `null` when no scope
 * holds at least {@link MIN_LESSONS_FOR_REGENERALIZATION} *active*
 * (non-provisional) lessons — there is nothing to collapse, so the caller
 * stamps nothing (no empty block in the prompt). Provisional lessons are
 * excluded from the collapse set (see module header) but still counted in each
 * scope's `current_entries` / `over_cap` so the cap status stays whole-file
 * truthful. Scopes are emitted in input order.
 */
export function buildRegeneralizationWorksheet(
  scopes: ReadonlyArray<RegeneralizationScopeInput>,
  opts: BuildRegeneralizationOptions,
): RegeneralizationResult | null {
  const eligible: Array<{
    input: RegeneralizationScopeInput;
    sectionBody: string;
    active: Lesson[];
    totalEntries: number;
  }> = [];
  for (const input of scopes) {
    // Single extraction per scope — `renderScope` reuses this body for its
    // `current_bytes` measure instead of re-extracting (the old double
    // extraction left renderScope with an unreachable missing-section arm).
    const sectionBody = extractMarkdownSection(input.existingFileMd, "Lessons");
    if (!sectionBody) continue;
    const allLessons = parseLessonsSection(sectionBody);
    // Collapse the ACTIVE set only — provisional lessons are owned by the
    // evening promotion gate (see module header); merging them here would
    // bypass the `ignored`-only-never-promotes guard.
    const active = allLessons.filter((lesson) => !lesson.provisional);
    if (active.length >= MIN_LESSONS_FOR_REGENERALIZATION) {
      eligible.push({ input, sectionBody, active, totalEntries: allLessons.length });
    }
  }
  if (eligible.length === 0) return null;

  const out: string[] = [];
  out.push(
    `<feedback_regeneralization generated_at="${xmlEscape(opts.nowIso)}" ` +
      `scopes="${eligible.length}">`,
  );
  let lessonCount = 0;
  for (const { input, sectionBody, active, totalEntries } of eligible) {
    renderScope(input, sectionBody, active, totalEntries, opts, out);
    lessonCount += active.length;
  }
  out.push("</feedback_regeneralization>");

  return {
    block: out.join("\n"),
    scopeCount: eligible.length,
    lessonCount,
  };
}
