import { nowInTimezone } from "@aitne/shared";
import {
  extractTodayAgentPlanRows,
  type TodayAgentPlanMetadata,
} from "../today-agent-plan.js";

/**
 * Validators and shape helpers for the `today.md` context file.
 *
 * `today.md` is the agent's daily working surface. Its line-1 header is
 * the canonical agent-day date; its `## Agent Plan` rows feed the
 * scheduler that fires `→DM` / `→notify` / `→check-in` / `→wake` actions
 * at their listed times. Both halves are parsed by every downstream
 * event handler, so the schema is enforced server-side at write time
 * with explicit messages that the agent can self-correct from.
 */

/**
 * Canonical `## ` section headers, in document order. The validator
 * walks the file once and requires each to appear after the previous
 * one — extra sections may sit between them but the relative order is
 * fixed.
 */
export const TODAY_REQUIRED_SECTIONS = [
  "User Schedule",
  "User Tasks",
  "Agent Plan",
  "Agent Notes",
  "Agent Log",
  "Handoff",
] as const;

/**
 * Line 1: `# YYYY-MM-DD (day-of-week)`. Date and dashes are ASCII;
 * only the optional `(...)` weekday may be localized into the user's
 * primary language. The capture group is consulted to compare against
 * the current agent-day date when the route handler passes
 * `expectedAgentDay`.
 */
export const TODAY_H1_RE = /^# \d{4}-\d{2}-\d{2}(?: \([^)]+\))?$/;

/**
 * Line 2: `> Day type: Weekday|Weekend | Work focus: on|off | …`.
 * This line is parsed by every event handler — keep the casing,
 * pipe separators, and `> ` prefix exact ASCII.
 */
export const TODAY_DAY_TYPE_RE =
  /^> Day type: (Weekday|Weekend) \| Work focus: (on|off) \| Study focus: (on|off) \| Personal focus: (on|off)$/;

/**
 * Pre-schema legacy form — first line literally `# Today`. Recognized
 * only when the route handler explicitly opts in via
 * `allowLegacyToday`; used to bridge old fixtures during reload paths
 * that don't carry the agent-day context.
 */
export function isLegacyTodayContent(content: string): boolean {
  const lines = content.split(/\r?\n/);
  // `String.prototype.split` always yields a non-empty array, so `lines[0]`
  // is never undefined; the `?? ""` is a defensive default that types
  // require but no real input can hit.
  /* c8 ignore next */
  return (lines[0] ?? "").trim() === "# Today";
}

/**
 * Validate a `today.md` payload for the canonical schema.
 *
 * Returns a human-readable error message string, or `null` if the
 * content is valid. The caller maps `null` to 200 and any string to
 * 400. Messages echo both the expected and observed shape so the
 * agent gets immediate feedback and can correct the offending line in
 * the same session — see EXECUTION-MODE-DESIGN follow-up
 * §morning-routine for the rationale.
 */
export function validateTodayContent(
  content: string,
  options: { allowLegacyToday?: boolean; expectedAgentDay?: string } = {},
): string | null {
  if (options.allowLegacyToday && isLegacyTodayContent(content)) return null;
  const lines = content.split(/\r?\n/);
  // Same `split` invariant as `isLegacyTodayContent`.
  /* c8 ignore next */
  const firstLine = (lines[0] ?? "").trim();
  if (!TODAY_H1_RE.test(firstLine)) {
    return (
      "today.md line 1 must be `# YYYY-MM-DD (day-of-week)`. " +
      "The date and dashes are ASCII English; only the weekday inside " +
      "`(...)` may be localized. Do NOT translate the literal `# ` prefix " +
      "or change the date separator. See the today skill for the full " +
      "skeleton contract."
    );
  }
  if (!TODAY_DAY_TYPE_RE.test((lines[1] ?? "").trim())) {
    return (
      "today.md line 2 must be `> Day type: Weekday|Weekend | Work focus: on|off | Study focus: on|off | Personal focus: on|off`. " +
      "This line is parsed by every downstream event handler — keep it " +
      "exact English ASCII with the casing, pipe separators (` | `), and " +
      "leading `> ` shown above. Do NOT translate `Day type` / `Weekday` / " +
      "`Work focus` / `on` / `off` etc. into the user's primary_language; " +
      "the `<output_language_policy>` skeleton-precedence rule covers this " +
      "line. Example: " +
      "`> Day type: Weekday | Work focus: on | Study focus: on | Personal focus: on`."
    );
  }

  // Agent-day-date check — rejects wrong-date H1 with a clear error echoing
  // both values. Without this, a wrong-date PUT silently succeeds (regex
  // passes) and the dispatcher's post-run hasCurrentAgentDayTodayMd() check
  // schedules a retry while the same session still has the prompt context
  // loaded, wasting a heavy-tier turn cycle. With this guard the agent gets
  // immediate feedback and corrects in-session.
  if (options.expectedAgentDay) {
    // TODAY_H1_RE already matched, so the YYYY-MM-DD capture is guaranteed.
    // No optional-chain — the regex precondition guarantees `[1]` is set.
    const writtenDate = firstLine.match(/^# (\d{4}-\d{2}-\d{2})/)![1];
    if (writtenDate !== options.expectedAgentDay) {
      return (
        `today.md line 1 date '${writtenDate}' does not match the current ` +
        `agent-day date '${options.expectedAgentDay}'. ` +
        `Use the date from <current_agent_day date="..."> in your prompt context — ` +
        `the agent-day differs from calendar today before the day-boundary hour.`
      );
    }
  }

  let previousSectionIndex = 1;
  for (const section of TODAY_REQUIRED_SECTIONS) {
    const index = lines.findIndex(
      (line, lineIndex) =>
        lineIndex > previousSectionIndex && line.trim() === `## ${section}`,
    );
    if (index < 0) {
      return `today.md requires \`## ${section}\` in canonical order.`;
    }
    previousSectionIndex = index;
  }

  const parsed = extractTodayAgentPlanRows(content);
  if (parsed.invalidRows.length > 0) {
    const first = parsed.invalidRows[0];
    return (
      `today.md Agent Plan line ${first.line} must match ` +
      `\`- [ ] HH:MM <action> [work|study|personal|home] →DM|→notify|→check-in|→wake\`. ` +
      `Got: ${JSON.stringify(first.raw)}`
    );
  }

  return null;
}

export interface TodayScheduleCandidate {
  id: number;
  scheduledFor: string;
  localDate: string;
  localTime: string;
  taskType: string;
  status: string;
  description: string | null;
  taskContext: Record<string, unknown>;
}

export interface AgentPlanScheduleCandidate extends TodayScheduleCandidate {
  agentPlan: TodayAgentPlanMetadata;
}

/**
 * Project a raw `agent_schedule` row into a `today.md`-reconciliation
 * candidate: derive the local date/time in the caller's timezone, lift
 * the task-context blob into an object, and surface the canonical row
 * id so the route handler can correlate against parsed Agent Plan rows.
 *
 * Returns `null` for rows with an unparseable `scheduled_for`, so the
 * caller can `.filter(Boolean)` past corrupt timestamps without
 * crashing the reconciliation pass.
 */
export function toTodayScheduleCandidate(
  row: {
    id: number;
    scheduled_for: string;
    task_type: string;
    task_description: string | null;
    task_context: string | null;
    status: string;
  },
  timezone: string | undefined,
): TodayScheduleCandidate | null {
  const scheduledAt = parseScheduleDate(row.scheduled_for);
  if (Number.isNaN(scheduledAt.getTime())) return null;
  const local = nowInTimezone(timezone, scheduledAt);
  const localDate = `${local.year}-${String(local.month).padStart(2, "0")}-${String(local.day).padStart(2, "0")}`;
  const localTime = `${String(local.hours).padStart(2, "0")}:${String(local.minutes).padStart(2, "0")}`;
  return {
    id: row.id,
    scheduledFor: row.scheduled_for,
    localDate,
    localTime,
    taskType: row.task_type,
    status: row.status,
    description: row.task_description,
    taskContext: parseJsonObject(row.task_context),
  };
}

function parseScheduleDate(value: string): Date {
  return new Date(value.includes("T") ? value : value.replace(" ", "T") + "Z");
}

function parseJsonObject(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Ignore corrupt metadata for reconciliation diagnostics.
  }
  return {};
}
