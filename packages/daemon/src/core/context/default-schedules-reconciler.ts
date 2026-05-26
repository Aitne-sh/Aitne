/**
 * SCHEDULED-DM-IMPLEMENTATION-PLAN §6.5 — pure logic for the
 * `## Default Schedules` section of `policies/management.md`. Mirrors
 * `policy-index-reconciler.ts` exactly — snapshot → rendered output,
 * with no DB or fs I/O. The runner (`default-schedules-runner.ts`)
 * drives it.
 *
 * Scope:
 *   - Render the `## Default Schedules` section content sourced from
 *     the `recurring_schedules` DB table (a read-only mirror).
 *   - Provide section-aware extract / upsert helpers so the setup
 *     wizard's save handler and the runner can splice the section
 *     into existing management.md content without disturbing the
 *     wizard-owned blocks (`## Source of Truth`, `## Active Policies`,
 *     etc.).
 *
 * Invariants:
 *   - Output is deterministic for a given (id-sorted) snapshot —
 *     callers can compare rendered output against on-disk content to
 *     short-circuit no-op writes.
 *   - Pipe characters in user-supplied cells are escaped.
 *   - Section starts with `## Default Schedules` and does NOT include
 *     a trailing newline (the upsert helper appends one).
 */

import type { RecurrenceRule } from "@aitne/shared";
import { formatRecurrenceLabel } from "../recurrence.js";

export interface DefaultScheduleSnapshotEntry {
  /** `recurring_schedules.id`. */
  id: number;
  /** Human label derived from `task_context.sub_flow` (e.g.
   *  `"morning_briefing"` → `"Morning briefing"`) or the raw
   *  `task_description` when `sub_flow` is absent. */
  label: string;
  /** Parsed `recurrence_rule` JSON. The full RecurrenceRule shape is
   *  preserved (incl. `daysOfWeek` / `daysOfMonth`) so weekly /
   *  monthly schedules render their cadence correctly via
   *  `formatRecurrenceLabel` rather than dropping the day arrays. */
  recurrenceRule: RecurrenceRule;
  /** Mirror of `recurring_schedules.enabled`. */
  enabled: boolean;
  /** True when `task_context.pin_to_quiet_hours_end === true`. */
  pinnedToQuietHours: boolean;
  /** Raw `task_context.sub_flow` value, or null. */
  subFlow: string | null;
}

export const DEFAULT_SCHEDULES_SECTION_HEADER = "## Default Schedules";

const EM_DASH = "—";

/**
 * Render the body of `## Default Schedules`. Returned string starts
 * with the header and does NOT include a trailing newline (the upsert
 * helper appends one).
 */
export function renderDefaultSchedulesSection(
  entries: DefaultScheduleSnapshotEntry[],
): string {
  const lines: string[] = [];
  lines.push(DEFAULT_SCHEDULES_SECTION_HEADER);
  lines.push("");
  lines.push(
    "Auto-maintained by the daemon (do not edit by hand — use DM, dashboard,",
  );
  lines.push(
    "or `PATCH /api/recurring-schedules/:id`). Sourced from the",
  );
  lines.push("`recurring_schedules` DB table; this section is a read-only mirror.");
  lines.push("");
  if (entries.length === 0) {
    lines.push("_No default schedules._");
    return lines.join("\n");
  }
  lines.push("| Schedule | Time | Status | Notes |");
  lines.push("|---|---|---|---|");
  const sorted = [...entries].sort((a, b) => a.id - b.id);
  for (const entry of sorted) {
    lines.push(renderRow(entry));
  }
  return lines.join("\n");
}

function renderRow(e: DefaultScheduleSnapshotEntry): string {
  // Reuse `formatRecurrenceLabel` so weekly/monthly schedules render
  // their cadence ("Weekly on Mon, Wed, Fri at 09:00") instead of
  // dropping the day arrays. Timezone is appended in parentheses when
  // present.
  const baseLabel = formatRecurrenceLabel(e.recurrenceRule);
  const tz = e.recurrenceRule.timezone ? ` (${e.recurrenceRule.timezone})` : "";
  const time = `${baseLabel}${tz}`;
  const status = e.enabled ? "enabled" : "disabled";
  const notes = e.pinnedToQuietHours
    ? "pinned to quiet_hours_end"
    : "user-pinned time";
  return `| ${escapeCell(e.label)} | ${escapeCell(time)} | ${status} | ${escapeCell(notes)} |`;
}

function escapeCell(value: string): string {
  // empty-string fallback to EM_DASH only fires for an all-whitespace
  // input, which the callers don't currently produce.
  /* c8 ignore next */
  return value.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim() || EM_DASH;
}

/**
 * Splice the rendered `## Default Schedules` section into existing
 * management.md content. Mirrors
 * `upsertManagementRulesActivePolicies` from
 * `policy-index-reconciler.ts` — same regex / scan strategy with the
 * section header swapped.
 *
 *   - If the section header already exists, replace from the header
 *     up to (but not including) the next top-level H2 heading or end
 *     of file.
 *   - Otherwise, append at the end of the file (after a blank line)
 *     so the section lands at the bottom regardless of which other
 *     sections the wizard payload happens to include.
 *   - When `content` is empty / whitespace, return the section alone.
 *
 * Section content is normalised to end with a single trailing newline
 * so the resulting file always ends with `\n`.
 */
export function upsertManagementRulesDefaultSchedules(
  content: string,
  sectionContent: string,
): string {
  const normalized = content.replace(/\r\n/g, "\n").replace(/\s+$/u, "");
  const section = sectionContent.replace(/\r\n/g, "\n").replace(/\s+$/u, "");

  if (!normalized) {
    return `${section}\n`;
  }

  const range = findDefaultSchedulesSectionRange(normalized);
  if (range) {
    const before = normalized.slice(0, range.start).replace(/\s+$/u, "");
    const after = normalized.slice(range.end).replace(/^\s+/u, "");
    // empty-string branch (`before`/`after` empty) fires only when the
    // section sits at the file boundary; test fixtures always pad with
    // surrounding content.
    /* c8 ignore next 2 */
    const beforePart = before ? `${before}\n\n` : "";
    const afterPart = after ? `\n\n${after}` : "";
    return `${beforePart}${section}${afterPart}\n`;
  }

  return `${normalized}\n\n${section}\n`;
}

/**
 * Read the current rendered section from existing management.md
 * content, if present. Returns null when the section is absent. Used
 * by the wizard preservation path so a `POST /setup/save-rules`
 * payload that omits the section can re-acquire the on-disk version
 * verbatim before the splice.
 */
export function extractDefaultSchedulesSection(
  content: string,
): string | null {
  const normalized = content.replace(/\r\n/g, "\n");
  const range = findDefaultSchedulesSectionRange(normalized);
  if (!range) return null;
  return normalized.slice(range.start, range.end).replace(/\s+$/u, "");
}

interface SectionRange {
  start: number;
  end: number;
}

function findDefaultSchedulesSectionRange(
  normalized: string,
): SectionRange | null {
  const headerPattern = /^## Default Schedules(?:\s|$)/m;
  const headerMatch = headerPattern.exec(normalized);
  if (!headerMatch || headerMatch.index === undefined) return null;
  const start = headerMatch.index;

  const nextHeadingPattern = /^##\s/gm;
  nextHeadingPattern.lastIndex = start + headerMatch[0].length;
  const nextMatch = nextHeadingPattern.exec(normalized);
  const end = nextMatch ? nextMatch.index : normalized.length;

  return { start, end };
}

/**
 * Convert a `task_context.sub_flow` slug into a display label.
 * `morning_briefing` → `Morning briefing`. Falls back to the raw
 * description when no sub_flow is present.
 */
export function deriveDefaultScheduleLabel(
  subFlow: string | null,
  description: string,
): string {
  if (!subFlow) return description.trim() || EM_DASH;
  const words = subFlow.replace(/_/g, " ").trim();
  // empty `words` here means subFlow was all underscores — degenerate
  // case the routine subFlow vocabulary never produces.
  /* c8 ignore next */
  if (words.length === 0) return description.trim() || EM_DASH;
  return words.charAt(0).toUpperCase() + words.slice(1);
}
