/**
 * `<previous_week>` digest — extracts the import-targeted
 * `## Carry Over to Next Week`, `## Next Week Focus`, and
 * `## Lessons for Next Week` sections from the just-ended ISO week's
 * `weekly/YYYY-Www.md` and renders them as a compact XML block that the
 * morning_routine task-flow consumes verbatim **every morning** of the
 * new ISO week (Mon–Sun, same file across the week).
 *
 * Cross-week boundary behaviour: when the daemon clock crosses into a
 * new ISO week and the Friday weekly_review produced a fresh file,
 * `getPreviousWeekIsoKey(now)` flips to the new key automatically — no
 * Monday-only or "first morning of week" gating needed. The block is
 * a small daily-context input, not a one-shot handoff.
 *
 * See `docs/design/appendices/weekly-next-week-leverage.md` for the
 * end-to-end design (weekly_review task-flow contract → file shape →
 * ContextBuilder injection → morning_routine consumption).
 *
 * Pure: takes contextDir + an ISO year-week key and a clock; returns the
 * digest or null. No DB, no fs side effects beyond `fs/promises.readFile`
 * + `fs.statSync` for the mtime fallback. Sized for the morning-routine
 * cold-start budget — the rendered block is hard-capped at
 * `PREVIOUS_WEEK_BLOCK_MAX_CHARS` and truncated with an explicit
 * `...` marker so the LLM can tell when content was elided.
 */

import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import { nowInTimezone } from "@aitne/shared";

import { weeklyReviewPath } from "./context-paths.js";

/**
 * Per design — the block is capped at ~600 tokens. Using ~4 chars per
 * token as a conservative estimate, that's ~2400 characters of body
 * payload across the three sub-blocks. The XML scaffolding overhead is
 * negligible against this. Truncation only ever fires when the weekly
 * file violates its own contract caps (Carry Over ≤5, Focus ≤3,
 * Lessons ≤3 short bullets each); typical payloads sit an order of
 * magnitude below this ceiling.
 */
export const PREVIOUS_WEEK_BLOCK_MAX_CHARS = 2400;
const TRUNCATION_MARKER = "...";

export interface PreviousWeekDigest {
  /** ISO year-week the digest was extracted from, e.g. `2026-W19`. */
  period: string;
  /** Absolute timestamp the source file was last written (ISO 8601 UTC). */
  generatedAt: string;
  /**
   * Body of `## Carry Over to Next Week`, header excluded, leading /
   * trailing blank lines trimmed. Empty string when the section is
   * present but empty or carries only a `- (none)` line.
   */
  carryOver: string;
  /**
   * Body of `## Next Week Focus`, header excluded, leading / trailing
   * blank lines trimmed. Empty string when the section is present but
   * empty.
   */
  focus: string;
  /**
   * Body of `## Lessons for Next Week`, header excluded, leading /
   * trailing blank lines trimmed. Empty string when the section is
   * present but empty. Each bullet in the source file follows
   * `<observation> → <specific next-week action>`; the digest preserves
   * the formatting verbatim.
   */
  lessons: string;
}

/**
 * Compute the ISO year-week key for the week containing `date`.
 *
 * Standard ISO-8601 algorithm: the week containing the year's first
 * Thursday is week 01. Year-boundary edge cases (e.g. Jan 1 falling on
 * Friday/Saturday/Sunday belongs to the previous ISO year's W52/W53) are
 * handled correctly because the `target` Thursday's `getUTCFullYear()`
 * is the ISO year by construction.
 *
 * Returns the zero-padded `YYYY-Www` slug — matches the format the
 * `compareWeeklyKey` parser in `retention.ts` already understands.
 */
export function isoYearWeekFromUtc(year: number, month: number, day: number): string {
  // Work in UTC Y/M/D so DST never enters the picture — ISO weeks are
  // timezone-naive at the calendar-date level. `Date.UTC` accepts month
  // as 0-indexed; the caller passes 1-indexed.
  const target = new Date(Date.UTC(year, month - 1, day));
  // Day of week with Monday = 0, Sunday = 6.
  const dayNr = (target.getUTCDay() + 6) % 7;
  // Shift target to the Thursday of the same ISO week — the ISO year
  // and the ISO-week index are anchored on that Thursday.
  target.setUTCDate(target.getUTCDate() - dayNr + 3);
  const isoYear = target.getUTCFullYear();
  // First Thursday of the ISO year — relies on the same shift.
  const firstThursday = new Date(Date.UTC(isoYear, 0, 4));
  const firstDayNr = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNr + 3);
  const week =
    1 +
    Math.round(
      (target.getTime() - firstThursday.getTime()) / (7 * 24 * 60 * 60 * 1000),
    );
  return `${isoYear}-W${String(week).padStart(2, "0")}`;
}

/**
 * ISO year-week key of the week immediately preceding the week that
 * contains `now` in the given timezone.
 *
 * Algorithm: find the Monday of the current ISO week (today minus
 * `(localDayOfWeek - 1 + 7) % 7` days), then step back another 7 days
 * to land on the previous ISO week's Monday. The Monday-anchor is
 * timezone-naive at the calendar-date level by construction.
 *
 * Stable across Mon–Sun of the current week: every weekday returns the
 * same previous-week key. When the daemon clock crosses into a new ISO
 * week (Mon 00:00 local), this helper rolls forward automatically so
 * the morning_routine sees the freshly-written weekly file from the
 * just-ended week.
 *
 * Year-boundary cases (current week is `2027-W01`, prev = `2026-W53`)
 * are handled by `isoYearWeekFromUtc` — see its docstring.
 */
export function getPreviousWeekIsoKey(
  timezone: string | undefined,
  now?: Date,
): string {
  const reference = now ?? new Date();
  const local = nowInTimezone(timezone, reference);
  // Anchor a UTC Date on the local Y/M/D so day-of-week arithmetic
  // happens at the calendar-date level (TZ-naive). Same convention as
  // `isoYearWeekFromUtc`.
  const today = new Date(Date.UTC(local.year, local.month - 1, local.day));
  const dayNr = (today.getUTCDay() + 6) % 7; // Mon = 0
  // Step back to Monday of this ISO week, then another 7 days to land
  // on the previous ISO week's Monday.
  const prevWeekAnchorMs = today.getTime() - (dayNr + 7) * 24 * 60 * 60 * 1000;
  const prevWeekAnchor = new Date(prevWeekAnchorMs);
  return isoYearWeekFromUtc(
    prevWeekAnchor.getUTCFullYear(),
    prevWeekAnchor.getUTCMonth() + 1,
    prevWeekAnchor.getUTCDate(),
  );
}

const CARRY_OVER_HEADER_RE = /^##\s+Carry Over to Next Week\s*$/im;
const NEXT_WEEK_FOCUS_HEADER_RE = /^##\s+Next Week Focus\s*$/im;
const LESSONS_HEADER_RE = /^##\s+Lessons for Next Week\s*$/im;
const ANY_H2_HEADER_RE = /^##\s+\S/m;

/**
 * Extract a single H2 section body from a markdown document.
 *
 * Returns the lines between `## <header>` (exclusive) and the next H2
 * (exclusive), trimmed of leading / trailing blank lines. Returns `null`
 * when the header is absent. Returns an empty string when the header is
 * present but the body is empty or whitespace-only.
 *
 * Header regex matches verbatim — section titles in the weekly file are
 * load-bearing per the task-flow contract; we deliberately do not
 * normalize whitespace, case, or pluralization.
 */
function extractH2Section(body: string, headerRe: RegExp): string | null {
  const headerMatch = headerRe.exec(body);
  if (!headerMatch) return null;
  const after = body.slice(headerMatch.index + headerMatch[0].length);
  // Skip the newline after the header line.
  const afterTrimLeading = after.replace(/^\r?\n/, "");
  const nextHeader = ANY_H2_HEADER_RE.exec(afterTrimLeading);
  const sectionRaw = nextHeader
    ? afterTrimLeading.slice(0, nextHeader.index)
    : afterTrimLeading;
  return sectionRaw.replace(/^\s*\n+/, "").replace(/\n+\s*$/, "");
}

/**
 * Load and parse `weekly/<isoYearWeek>.md` from disk, extracting the
 * three import-targeted sections. Returns null when the file is
 * missing, empty, unreadable, or contains none of the three sections.
 *
 * - Missing file → null (silent skip; caller proceeds without the
 *   block — explicit no-fail path for the "daemon was down through
 *   Friday and no weekly_review fired" case).
 * - File present but none of the three headers found → null. Caller
 *   skips the block so the agent does not waste tokens on a vestigial
 *   `<previous_week>` whose body would be empty.
 * - Any of the three sections present (even if body is empty) → return
 *   digest with the present body and `""` for the missing ones. The
 *   renderer emits a `(none recorded)` placeholder so the LLM sees the
 *   intent ("focus was not declared this week") rather than guessing.
 */
export async function loadPreviousWeekDigest(
  contextDir: string,
  isoYearWeek: string,
): Promise<PreviousWeekDigest | null> {
  const relativePath = weeklyReviewPath(isoYearWeek);
  const fullPath = join(contextDir, relativePath);
  if (!existsSync(fullPath)) return null;

  let body: string;
  let generatedAt: string;
  try {
    const [b, st] = await Promise.all([
      readFile(fullPath, "utf-8"),
      stat(fullPath),
    ]);
    body = b;
    generatedAt = st.mtime.toISOString();
  } catch {
    return null;
  }
  if (!body.trim()) return null;

  const carryOver = extractH2Section(body, CARRY_OVER_HEADER_RE);
  const focus = extractH2Section(body, NEXT_WEEK_FOCUS_HEADER_RE);
  const lessons = extractH2Section(body, LESSONS_HEADER_RE);
  if (carryOver === null && focus === null && lessons === null) return null;

  return {
    period: isoYearWeek,
    generatedAt,
    carryOver: carryOver ?? "",
    focus: focus ?? "",
    lessons: lessons ?? "",
  };
}

/**
 * Render a `<previous_week>` block from a digest. Stable shape: the
 * outer element carries `period` and `generated_at` attributes; the
 * three child elements always appear in `(carry_over, focus, lessons)`
 * order so the task-flow can describe their semantics without
 * conditional branching. Sub-blocks render their body verbatim — bullet
 * markers, indentation, multi-line reasons all preserved as they
 * appeared in the source weekly file.
 *
 * Token-cap: if the joined rendering exceeds
 * `PREVIOUS_WEEK_BLOCK_MAX_CHARS`, the body sections are truncated
 * proportionally to their original length and end with the explicit
 * `...` marker so the LLM can tell content was elided. Truncation
 * almost never fires because the section caps in the weekly file
 * keep payloads an order of magnitude below the ceiling — when it
 * does, it signals the upstream file violated the contract and the
 * digest is salvaging what fits.
 */
export function renderPreviousWeekBlock(digest: PreviousWeekDigest): string {
  const { carryOver, focus, lessons } = capDigestBodies(digest);
  return [
    `<previous_week period="${digest.period}" generated_at="${digest.generatedAt}">`,
    "  <carry_over>",
    indent(carryOver || "(none recorded)", "    "),
    "  </carry_over>",
    "  <focus>",
    indent(focus || "(none recorded)", "    "),
    "  </focus>",
    "  <lessons>",
    indent(lessons || "(none recorded)", "    "),
    "  </lessons>",
    "</previous_week>",
  ].join("\n");
}

function indent(text: string, prefix: string): string {
  // `text` is always non-empty here — render sites guard with
  // `|| "(none recorded)"` and capDigestBodies never produces "" (truncate
  // returns the explicit `...` marker for zero-byte budgets).
  return text
    .split("\n")
    .map((line) => (line.length === 0 ? line : prefix + line))
    .join("\n");
}

function capDigestBodies(digest: PreviousWeekDigest): {
  carryOver: string;
  focus: string;
  lessons: string;
} {
  const totalLen =
    digest.carryOver.length + digest.focus.length + digest.lessons.length;
  if (totalLen <= PREVIOUS_WEEK_BLOCK_MAX_CHARS) {
    return {
      carryOver: digest.carryOver,
      focus: digest.focus,
      lessons: digest.lessons,
    };
  }
  // Proportional split — preserve the original ratio so one section
  // does not dominate the remaining budget. Subtract the marker length
  // from each per-section budget so appended ellipses fit inside the
  // overall cap.
  const budget = PREVIOUS_WEEK_BLOCK_MAX_CHARS - 3 * TRUNCATION_MARKER.length;
  const safeTotal = Math.max(totalLen, 1);
  const carryBudget = Math.max(
    0,
    Math.floor((budget * digest.carryOver.length) / safeTotal),
  );
  const focusBudget = Math.max(
    0,
    Math.floor((budget * digest.focus.length) / safeTotal),
  );
  const lessonsBudget = Math.max(0, budget - carryBudget - focusBudget);
  return {
    carryOver: truncate(digest.carryOver, carryBudget),
    focus: truncate(digest.focus, focusBudget),
    lessons: truncate(digest.lessons, lessonsBudget),
  };
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  if (max <= TRUNCATION_MARKER.length) return TRUNCATION_MARKER;
  return text.slice(0, max - TRUNCATION_MARKER.length) + TRUNCATION_MARKER;
}
