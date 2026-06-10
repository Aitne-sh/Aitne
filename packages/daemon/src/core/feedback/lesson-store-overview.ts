/**
 * Feedback Learning Loop — lesson-store overview (FEEDBACK_LEARNING_LOOP_DESIGN.md §9 Phase 5).
 *
 * The pure, deterministic half of the `GET /api/feedback/lessons` dashboard
 * surface. The route (coverage-excluded — it does the FS enumeration) hands
 * each lesson file's raw contents to {@link summarizeLessonStore}, which parses
 * the `## Lessons` section and reports the cap-utilisation metrics the
 * "view/edit lessons and tune caps/threshold" settings page renders:
 * byte size vs. cap, entry count vs. cap, active vs. provisional split, and
 * whether the store is currently over either cap.
 *
 * Mirrors the §4 division of labour: the byte/entry accounting is mechanical
 * (here, 100% covered), while the route owns only the FS read + JSON assembly.
 */

import {
  extractMarkdownSection,
  parseLessonsSection,
  type Lesson,
} from "./lesson-format.js";

export interface LessonStoreSummary {
  /** UTF-8 byte size of the on-disk `## Lessons` section (the cap unit, §6). */
  bytes: number;
  /** Per-scope byte cap. */
  capBytes: number;
  /** Total parsed lessons (active + provisional). */
  entries: number;
  /** Per-scope entry cap. */
  maxEntries: number;
  /** Injectable (promoted) lessons — the ones that actually reach a prompt. */
  active: number;
  /** Stored-but-not-yet-injected lessons awaiting corroboration (§4 step 4). */
  provisional: number;
  /** True when the file exceeds its byte cap or its entry cap. */
  overCap: boolean;
}

/**
 * Summarise one lesson store from its raw file contents. A file with no
 * `## Lessons` section (or an empty one) reports zero entries — never throws,
 * so a hand-edited or partially-written file degrades to "empty store" rather
 * than breaking the overview. `bytes` measures the on-disk `## Lessons`
 * section body — the §6 cap unit (`lessonsSectionByteLength` in
 * lesson-format.ts) the eviction scorer and the nightly worksheet's
 * `over_cap` enforce. Measuring the whole file here previously reported a
 * permanently-stuck `overCap: true` in the band where the section fit the
 * cap but frontmatter + heading overhead pushed the file past it — a state
 * no enforcement actor would ever clear.
 */
export function summarizeLessonStore(
  fileMd: string,
  caps: { capBytes: number; maxEntries: number },
): LessonStoreSummary {
  const sectionBody = extractMarkdownSection(fileMd, "Lessons");
  const lessons: Lesson[] = sectionBody ? parseLessonsSection(sectionBody) : [];
  const provisional = lessons.filter((lesson) => lesson.provisional).length;
  const bytes = sectionBody ? Buffer.byteLength(sectionBody, "utf-8") : 0;
  return {
    bytes,
    capBytes: caps.capBytes,
    entries: lessons.length,
    maxEntries: caps.maxEntries,
    active: lessons.length - provisional,
    provisional,
    overCap: bytes > caps.capBytes || lessons.length > caps.maxEntries,
  };
}
