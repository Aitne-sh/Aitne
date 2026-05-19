import { localDateStr } from "@aitne/shared";

/**
 * Truncate `roadmap.md` for context injection.
 *
 * Consumer routines (morning / evening / weekly / monthly) only need
 * entries relevant to the near-term injection window. Keeping the full
 * Agent Action Plan bloats the prompt as entries accumulate over months.
 *
 * Rules (§3.5 of ROADMAP-REDESIGN.md):
 * - Keep every section other than `## Agent Action Plan` verbatim.
 * - Within `## Agent Action Plan`, keep only entries whose header date
 *   falls in `[today - lookbackDays, today + lookaheadDays]`, where
 *   "today" is resolved in the user's configured timezone. YMD strings
 *   are compared lexicographically to avoid UTC-vs-local off-by-one at
 *   timezone-edge hours.
 * - For `### Scheduled: ...` entries the header carries no date; the
 *   `Source: scheduled.task — wake-up YYYY-MM-DD` line is the effective
 *   header date for filtering.
 * - Entries whose date cannot be parsed are kept (safer than dropping).
 * - If any entries are dropped, insert an omission marker pointing
 *   callers at `GET /api/context/roadmap` for the full file.
 *
 * `## Long-term Plans` is injected verbatim — lines there are already
 * terse and the agent needs them all to decide promotion timing. The
 * refresh session must NOT use this truncator — it needs the full file
 * to regenerate content.
 */

export interface RoadmapTruncationOptions {
  /** Reference "today". Defaults to `new Date()`. */
  now?: Date;
  /** How many days before `now` to keep. Defaults to 7. */
  lookbackDays?: number;
  /** How many days after `now` to keep. Defaults to 30. */
  lookaheadDays?: number;
  /**
   * User's configured timezone (e.g. `America/New_York`). When omitted
   * the system timezone is used. Required for correct day-boundary
   * semantics — an evening_review running at 22:00 local time in a
   * timezone west of UTC would otherwise have `floor-UTC-day(now)`
   * already point at tomorrow's UTC date, dropping entries the user
   * still considers in-window.
   */
  timezone?: string;
}

const AGENT_ACTION_PLAN_HEADER = "## Agent Action Plan";
const OMITTED_MARKER_PREFIX =
  "[...{N} older/farther entries omitted — use GET /api/context/roadmap for full content]";

/**
 * Returns the roadmap body with `## Agent Action Plan` filtered to the
 * near-term window. Pass-through when the section is absent or empty.
 */
export function truncateRoadmap(
  content: string,
  options?: RoadmapTruncationOptions,
): string {
  const now = options?.now ?? new Date();
  const lookbackDays = options?.lookbackDays ?? 7;
  const lookaheadDays = options?.lookaheadDays ?? 30;
  const timezone = options?.timezone;

  const { sectionStart, sectionEnd } = findAgentActionPlanBounds(content);
  if (sectionStart < 0) return content;

  const sectionBody = content.slice(sectionStart, sectionEnd);
  const { entries, preamble } = splitEntries(sectionBody);
  if (entries.length === 0) return content;

  const todayYmd = localDateStr(now, timezone);
  const windowStartYmd = addDaysToYmd(todayYmd, -lookbackDays);
  const windowEndYmd = addDaysToYmd(todayYmd, lookaheadDays);

  const kept: string[] = [];
  let droppedCount = 0;
  for (const entry of entries) {
    const headerYmd = extractEntryYmd(entry);
    if (headerYmd === null) {
      kept.push(entry);
      continue;
    }
    // Lexicographic YYYY-MM-DD comparison = calendar-date comparison.
    if (headerYmd >= windowStartYmd && headerYmd <= windowEndYmd) {
      kept.push(entry);
    } else {
      droppedCount++;
    }
  }

  if (droppedCount === 0) return content;

  const omissionMarker = `${OMITTED_MARKER_PREFIX.replace(
    "{N}",
    String(droppedCount),
  )}\n\n`;
  const rebuiltSection = `${preamble}${omissionMarker}${kept.join("")}`;

  return (
    content.slice(0, sectionStart) +
    rebuiltSection +
    content.slice(sectionEnd)
  );
}

/**
 * Shift a YYYY-MM-DD string by a signed number of calendar days. Uses
 * `Date.UTC` internally but the input/output are tz-agnostic YMD
 * strings, so calling this on a "local YMD" and comparing the result
 * against another "local YMD" is timezone-correct.
 */
function addDaysToYmd(ymd: string, days: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

/**
 * Find the `## Agent Action Plan` section bounds. Returns
 * `{ sectionStart: -1 }` when the header is missing.
 *
 * `sectionStart` points at the character immediately after the header
 * line + its trailing newline, i.e. at the body of the section.
 * `sectionEnd` points at the start of the next `## ` heading, or the
 * end of the file if there is no next heading.
 */
function findAgentActionPlanBounds(content: string): {
  sectionStart: number;
  sectionEnd: number;
} {
  // Match the header at line start — `\n## Agent Action Plan\n` (or at
  // file start). Avoid matching inside code blocks or quoted text.
  const atStart = content.startsWith(`${AGENT_ACTION_PLAN_HEADER}\n`);
  const headerIdx = atStart
    ? 0
    : content.indexOf(`\n${AGENT_ACTION_PLAN_HEADER}\n`);
  if (headerIdx < 0 && !atStart) return { sectionStart: -1, sectionEnd: -1 };

  const headerLineStart = atStart ? 0 : headerIdx + 1;
  const bodyStart =
    headerLineStart + AGENT_ACTION_PLAN_HEADER.length + 1; // past the \n
  const nextHeadingIdx = content.indexOf("\n## ", bodyStart);
  const sectionEnd = nextHeadingIdx >= 0 ? nextHeadingIdx + 1 : content.length;
  return { sectionStart: bodyStart, sectionEnd };
}

/**
 * Split the body of `## Agent Action Plan` into `preamble` (text before
 * the first `### ` entry, if any) and `entries` (each entry is a `### `
 * heading plus all text up to the next `### ` heading, including the
 * trailing blank line if present).
 *
 * Keeping the original whitespace inside each entry matters because we
 * reassemble with plain string concatenation.
 */
function splitEntries(sectionBody: string): {
  preamble: string;
  entries: string[];
} {
  // Locate the first `### ` heading. When the body starts with one
  // directly, there is no preamble. Otherwise the match points at the
  // preceding `\n`, which belongs to the preamble — the heading itself
  // starts one character later.
  let headingStart: number;
  if (sectionBody.startsWith("### ")) {
    headingStart = 0;
  } else {
    const idx = sectionBody.indexOf("\n### ");
    if (idx < 0) return { preamble: sectionBody, entries: [] };
    headingStart = idx + 1;
  }

  const preamble = sectionBody.slice(0, headingStart);
  const entriesText = sectionBody.slice(headingStart);

  const entries: string[] = [];
  let cursor = 0;
  while (cursor < entriesText.length) {
    const nextEntryIdx = entriesText.indexOf("\n### ", cursor + 4);
    if (nextEntryIdx < 0) {
      entries.push(entriesText.slice(cursor));
      break;
    }
    entries.push(entriesText.slice(cursor, nextEntryIdx + 1));
    cursor = nextEntryIdx + 1;
  }
  return { preamble, entries };
}

const YMD_RE = /\d{4}-\d{2}-\d{2}/;

/**
 * Extract the effective header YMD for a roadmap entry as a
 * lexicographically-comparable string:
 * - Event entry: first `YYYY-MM-DD` on the `### ` heading line.
 * - Scheduled entry: first `YYYY-MM-DD` on the `Source: ... wake-up ...`
 *   line (the heading carries no date).
 *
 * Returns `null` when no date can be parsed (entry is conservatively
 * retained).
 */
function extractEntryYmd(entry: string): string | null {
  // Entries always carry a trailing newline after the heading (they came
  // from a `\n### ` boundary split). `indexOf` therefore returns a
  // non-negative position; falling back to the whole string when it does
  // not would be dead code.
  const newlineIdx = entry.indexOf("\n");
  const headerLine = entry.slice(0, newlineIdx);
  const body = entry.slice(newlineIdx + 1);

  const isScheduled = /^###\s+Scheduled:/.test(headerLine);
  if (isScheduled) {
    const wakeupMatch = body.match(/wake-up\s+(\d{4}-\d{2}-\d{2})/);
    return wakeupMatch ? wakeupMatch[1] : null;
  }

  const match = headerLine.match(YMD_RE);
  return match ? match[0] : null;
}
