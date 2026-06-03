import type {
  AgentExecution,
  AgentExecutionResult,
  AgentIntervalCadence,
  AgentKind,
  AgentScheduleSummary,
} from "./types";

/**
 * Pure presentation helpers for the `/agents` UI. No React, no I/O — every
 * function is a deterministic transform so it can be unit-tested directly
 * (the `use-repositories.test.ts` precedent). The components import these; the
 * tests import these.
 */

/** Badge colour for an execution result (matches the shared Badge variants). */
export type BadgeVariant =
  | "blue"
  | "purple"
  | "green"
  | "red"
  | "amber"
  | "orange"
  | "pink"
  | "gray";

export function resultBadgeVariant(
  result: AgentExecutionResult | null,
): BadgeVariant {
  switch (result) {
    case "success":
      return "green";
    case "error":
      return "red";
    case "timeout":
      return "amber";
    case "skipped":
      return "gray";
    default:
      return "gray";
  }
}

/** Human label for an Agent kind. */
export function kindLabel(kind: AgentKind): string {
  return kind === "builtin" ? "System" : "User";
}

const DAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

/** Zero-pad a clock field to two digits. */
function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** Minutes → compact "1h" / "30m" / "1h 30m" (matches formatDurationShort). */
function formatIntervalMinutes(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes <= 0) return `${minutes}m`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h > 0 && m > 0) return `${h}h ${m}m`;
  if (h > 0) return `${h}h`;
  return `${m}m`;
}

/**
 * The interval part of a runtime-window cadence on its own — "Every 1h" /
 * "Every 30m" — without the active-hours window. Used where the cadence and the
 * window are surfaced as separate fields (the agent detail Overview + list).
 */
export function formatIntervalEvery(cadence: AgentIntervalCadence): string {
  return `Every ${formatIntervalMinutes(cadence.interval_minutes)}`;
}

/**
 * The active-hours window of a runtime-window cadence as "HH:00–HH:00", or
 * `null` when it spans the full day (00:00–24:00). The hours are local to the
 * Agent's timezone (surfaced alongside).
 */
export function formatActiveHours(cadence: AgentIntervalCadence): string | null {
  const { active_start_hour: s, active_end_hour: e } = cadence;
  if (s <= 0 && e >= 24) return null;
  return `${pad2(s)}:00–${pad2(e)}:00`;
}

/**
 * Friendly description of a runtime-window interval cadence (hourly-check):
 * "Every 1h" or "Every 30m, 04:00–24:00". A full-day active window (00:00–24:00)
 * is the implicit default, so it is omitted. (For a split display of the two
 * parts, use {@link formatIntervalEvery} + {@link formatActiveHours}.)
 */
export function describeInterval(cadence: AgentIntervalCadence): string {
  const every = formatIntervalEvery(cadence);
  const window = formatActiveHours(cadence);
  return window ? `${every}, ${window}` : every;
}

/** "*​/N" → N (positive int), else null. */
function parseStep(field: string): number | null {
  const m = /^\*\/(\d+)$/.exec(field);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** A uniform 0-anchored minute list ("0,15,30,45") → its step, else null. */
function uniformListStep(field: string): number | null {
  if (!field.includes(",")) return null;
  const parts = field.split(",").map((p) => Number(p));
  if (parts.length < 2 || parts.some((p) => !Number.isInteger(p)) || parts[0] !== 0) {
    return null;
  }
  const step = parts[1] - parts[0];
  if (step <= 0) return null;
  for (let i = 1; i < parts.length; i++) {
    if (parts[i] - parts[i - 1] !== step) return null;
  }
  return step;
}

/** "A-B" (A<B, in 0–23) → its bounds, else null. */
function parseHourRange(field: string): { start: number; end: number } | null {
  const m = /^(\d+)-(\d+)$/.exec(field);
  if (!m) return null;
  const start = Number(m[1]);
  const end = Number(m[2]);
  if (!Number.isInteger(start) || !Number.isInteger(end)) return null;
  if (start < 0 || end > 23 || start >= end) return null;
  return { start, end };
}

/**
 * Sub-daily (interval) crons the built-ins / user Agents use — `*​/N` minute or
 * hour steps, uniform minute lists, `*` minute — rendered as "Every N …".
 * Returns null for anything that is not an everyday sub-daily cadence so the
 * caller can fall through to the fixed daily/weekly logic.
 */
function describeCronInterval(
  min: string,
  hour: string,
  dom: string,
  mon: string,
  dow: string,
): string | null {
  if (!(dom === "*" && mon === "*" && dow === "*")) return null;

  // Minute steps within the hour (every-N-minutes), optionally inside a window.
  const minStep = parseStep(min) ?? uniformListStep(min);
  if (minStep !== null) {
    const every = `Every ${formatIntervalMinutes(minStep)}`;
    if (hour === "*") return every;
    const win = parseHourRange(hour);
    return win ? `${every}, ${pad2(win.start)}:00–${pad2(win.end + 1)}:00` : null;
  }
  if (min === "*") {
    if (hour === "*") return "Every minute";
    const win = parseHourRange(hour);
    return win ? `Every minute, ${pad2(win.start)}:00–${pad2(win.end + 1)}:00` : null;
  }

  // Hour steps (every-N-hours) at a fixed minute, or a plain hourly cadence.
  const minN = Number(min);
  if (!Number.isInteger(minN) || minN < 0 || minN >= 60) return null;
  const at = minN === 0 ? "" : ` at :${pad2(minN)}`;
  const hourStep = parseStep(hour);
  if (hourStep !== null) return `Every ${hourStep}h${at}`;
  if (hour === "*") return `Hourly${at}`;
  return null;
}

/**
 * Friendly description of a cron expression for the common daily / weekly /
 * interval shapes the built-ins and user Agents use; falls back to the raw
 * expression for anything else (node-cron stays the authoritative parser — this
 * is display only).
 */
export function describeCron(expression: string): string {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5 && fields.length !== 6) return expression;
  // 6-field crons carry a leading seconds field; drop it for the description.
  const [min, hour, dom, mon, dow] = fields.length === 6 ? fields.slice(1) : fields;

  // Sub-daily (every N min / N hours) cadences first — these are exactly the
  // shapes the legacy "two integer fields" check below would reject as raw.
  const interval = describeCronInterval(min, hour, dom, mon, dow);
  if (interval) return interval;

  const minN = Number(min);
  const hourN = Number(hour);
  const timeKnown =
    Number.isInteger(minN) &&
    Number.isInteger(hourN) &&
    minN >= 0 &&
    minN < 60 &&
    hourN >= 0 &&
    hourN < 24;
  if (!timeKnown) return expression;
  const at = `${pad2(hourN)}:${pad2(minN)}`;

  if (dom === "*" && mon === "*" && dow === "*") {
    return `Every day at ${at}`;
  }
  if (dom === "*" && mon === "*") {
    const dowN = Number(dow);
    if (Number.isInteger(dowN) && dowN >= 0 && dowN <= 6) {
      return `Every ${DAY_NAMES[dowN]} at ${at}`;
    }
  }
  return expression;
}

/** One-line description of a schedule summary block. */
export function describeSchedule(schedule: AgentScheduleSummary): string {
  switch (schedule.kind) {
    case "cron":
      // A resolved runtime-window cadence (hourly-check) wins over the stored
      // placeholder cron — it carries the real, config-driven interval.
      if (schedule.interval) return describeInterval(schedule.interval);
      return schedule.expression ? describeCron(schedule.expression) : "Recurring";
    case "one_shot":
      return "One-shot";
    case "event":
      return schedule.expression ? `On event: ${schedule.expression}` : "On event";
    default:
      return schedule.kind;
  }
}

/**
 * True when an Agent fires on an interval (every N minutes / hours) rather than
 * at a fixed daily/weekly time. Drives the agents-list "Interval" cadence
 * filter. A resolved runtime-window cadence is interval by definition; a cron is
 * interval when its minute OR hour field denotes more than one firing per day.
 */
export function isIntervalSchedule(schedule: AgentScheduleSummary): boolean {
  if (schedule.interval) return true;
  if (schedule.kind !== "cron" || !schedule.expression) return false;
  const fields = schedule.expression.trim().split(/\s+/);
  if (fields.length !== 5 && fields.length !== 6) return false;
  const [min, hour] = fields.length === 6 ? fields.slice(1) : fields;
  const isMulti = (f: string): boolean =>
    f === "*" || f.includes(",") || f.includes("-") || f.includes("/");
  return isMulti(min) || isMulti(hour);
}

/** A rate stored as 0..1 → a whole-percent string; null → an em-dash. */
export function formatPercent(rate: number | null | undefined): string {
  if (rate === null || rate === undefined) return "—";
  return `${Math.round(rate * 100)}%`;
}

/** USD cost → "$0.17"; null/undefined → em-dash. */
export function formatCostUsd(usd: number | null | undefined): string {
  if (usd === null || usd === undefined) return "—";
  return `$${usd.toFixed(2)}`;
}

/** Milliseconds between an execution's start and end, or null. */
export function executionDurationMs(exec: AgentExecution): number | null {
  if (!exec.started_at || !exec.ended_at) return null;
  const start = Date.parse(exec.started_at);
  const end = Date.parse(exec.ended_at);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return end - start;
}

/** Milliseconds → "8m 32s" / "51s" / "1h 4m"; null → em-dash. */
export function formatDurationShort(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return "—";
  const totalSeconds = Math.round(ms / 1000);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

/** Seconds (the p95 metric unit) → a short duration label. */
export function formatDurationSeconds(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return "—";
  return formatDurationShort(seconds * 1000);
}
