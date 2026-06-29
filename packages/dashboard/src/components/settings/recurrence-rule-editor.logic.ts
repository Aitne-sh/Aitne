/**
 * Pure helpers for the managed-task RecurrenceRuleEditor. Separated so
 * the daemon-side cadence semantics (no sub-daily frequency, days-of-
 * week required for weekly, etc.) are unit-testable without React.
 *
 * The editor itself only mutates a draft `RecurrenceRule`; this module
 * holds the validator and the "rule → label" preview that mirrors what
 * the backend's `formatRecurrenceLabel` produces. Skill-level cadence
 * generation lives in `agent-assets/skills/management-task-register/`
 * — this module is the dashboard-side mirror, not a re-implementation.
 */

import type { RecurrenceRule } from "@/lib/api-types";

export type Frequency = RecurrenceRule["frequency"];

export const FREQUENCY_OPTIONS: readonly Frequency[] = [
  "daily",
  "weekly",
  "monthly",
] as const;

export const WEEKDAY_LABELS: readonly string[] = [
  "Sun",
  "Mon",
  "Tue",
  "Wed",
  "Thu",
  "Fri",
  "Sat",
];

export interface RecurrenceFormErrors {
  time?: string;
  daysOfWeek?: string;
  daysOfMonth?: string;
}

/**
 * Validate a draft `RecurrenceRule` against the daemon's
 * `recurrenceRuleSchema` invariants:
 *
 *   - `time` matches `HH:MM` (zero-padded, 00:00 .. 23:59).
 *   - `weekly` requires at least one `daysOfWeek` entry, ints 0..6.
 *   - `monthly` requires at least one `daysOfMonth` entry, ints 1..31.
 *   - `daily` forbids both `daysOfWeek` and `daysOfMonth`.
 *
 * Returns `null` when valid, or an errors object keyed by the offending
 * field. The dashboard's pre-validation matches the server's Zod refine
 * messages so a user sees the same wording either way.
 */
export function validateRecurrenceRule(
  rule: RecurrenceRule,
): RecurrenceFormErrors | null {
  const errs: RecurrenceFormErrors = {};
  // After SCHEDULE_API_REDESIGN_PLAN.md §4.1, `time` is optional on the
  // shared type (forbidden on hourly rules). The managed-task editor is
  // daily/weekly/monthly only — surface a clear validation message when
  // `time` is absent rather than silently coercing.
  if (typeof rule.time !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(rule.time)) {
    errs.time = "Time must be HH:MM, zero-padded.";
  }
  if (rule.frequency === "weekly") {
    const days = rule.daysOfWeek ?? [];
    if (days.length === 0) {
      errs.daysOfWeek = "Select at least one weekday.";
    } else if (days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) {
      errs.daysOfWeek = "Days of week must be 0..6 (Sun..Sat).";
    }
  }
  if (rule.frequency === "monthly") {
    const days = rule.daysOfMonth ?? [];
    if (days.length === 0) {
      errs.daysOfMonth = "Select at least one day of the month.";
    } else if (days.some((d) => !Number.isInteger(d) || d < 1 || d > 31)) {
      errs.daysOfMonth = "Days of month must be 1..31.";
    }
  }
  return Object.keys(errs).length === 0 ? null : errs;
}

/**
 * Coerce a frequency change so the optional fields stay consistent
 * with the daemon's mutually-exclusive invariant: `daysOfWeek` is
 * forbidden on `daily`/`monthly`, `daysOfMonth` is forbidden on
 * `daily`/`weekly`. Forgetting to clear them on a transition would
 * produce a 400 from the route's Zod refine, which is the wrong
 * surface to discover the rule.
 */
export function applyFrequency(
  rule: RecurrenceRule,
  next: Frequency,
): RecurrenceRule {
  // §4.1: `time` is forbidden on hourly rules; the managed-task editor
  // never surfaces hourly, but coerce to "00:00" so a transition through
  // `applyFrequency` from a defensive caller doesn't accidentally produce
  // a `time: undefined` value that the daemon's daily Zod refine rejects.
  const base: RecurrenceRule = {
    frequency: next,
    time: rule.time ?? "00:00",
    ...(rule.timezone ? { timezone: rule.timezone } : {}),
  };
  if (next === "weekly") {
    base.daysOfWeek = rule.daysOfWeek ?? [];
  }
  if (next === "monthly") {
    base.daysOfMonth = rule.daysOfMonth ?? [];
  }
  return base;
}

/** Toggle a weekday in/out of `daysOfWeek` (idempotent, sorted on read). */
export function toggleDayOfWeek(
  rule: RecurrenceRule,
  day: number,
): RecurrenceRule {
  if (rule.frequency !== "weekly") return rule;
  const set = new Set(rule.daysOfWeek ?? []);
  if (set.has(day)) {
    set.delete(day);
  } else {
    set.add(day);
  }
  return { ...rule, daysOfWeek: Array.from(set).sort((a, b) => a - b) };
}

/** Toggle a day in/out of `daysOfMonth` (idempotent, sorted on read). */
export function toggleDayOfMonth(
  rule: RecurrenceRule,
  day: number,
): RecurrenceRule {
  if (rule.frequency !== "monthly") return rule;
  const set = new Set(rule.daysOfMonth ?? []);
  if (set.has(day)) {
    set.delete(day);
  } else {
    set.add(day);
  }
  return { ...rule, daysOfMonth: Array.from(set).sort((a, b) => a - b) };
}

/**
 * Strict structural equality on the rule. Used by the editor's dirty-
 * check so a no-op render (same fields, same order) doesn't enable Save.
 */
export function recurrenceRulesEqual(
  a: RecurrenceRule | null,
  b: RecurrenceRule | null,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.frequency !== b.frequency) return false;
  // `time` is optional on the wider schema; coerce to a string-vs-undefined
  // compare so two hourly rules without `time` are considered equal.
  if ((a.time ?? null) !== (b.time ?? null)) return false;
  if ((a.timezone ?? null) !== (b.timezone ?? null)) return false;
  const aDow = (a.daysOfWeek ?? []).slice().sort((x, y) => x - y);
  const bDow = (b.daysOfWeek ?? []).slice().sort((x, y) => x - y);
  if (aDow.length !== bDow.length) return false;
  for (let i = 0; i < aDow.length; i++) {
    if (aDow[i] !== bDow[i]) return false;
  }
  const aDom = (a.daysOfMonth ?? []).slice().sort((x, y) => x - y);
  const bDom = (b.daysOfMonth ?? []).slice().sort((x, y) => x - y);
  if (aDom.length !== bDom.length) return false;
  for (let i = 0; i < aDom.length; i++) {
    if (aDom[i] !== bDom[i]) return false;
  }
  return true;
}
