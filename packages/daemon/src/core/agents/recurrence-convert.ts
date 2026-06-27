/**
 * Cron ⇄ recurrence-spec conversion for user-Agent recurring pairing and
 * first-boot auto-import (AGENT_DEFINITIONS_DESIGN.md §6.1 step 5 / §6.5).
 *
 * User Agents declare their schedule as a cron `expression` in YAML, but the
 * backing `recurring_schedules` row stores a *structured* recurrence rule
 * (frequency / time / days). The loader therefore needs both directions:
 *
 *   - **pairing** (cron → spec): when a user Agent's YAML has no paired
 *     recurring row yet, derive a structured spec to create one.
 *   - **auto-import** (spec → cron): when a legacy recurring row has no Agent
 *     YAML, derive a cron expression for the synthesised `agent.md`.
 *
 * To keep this module pure and dependency-free (so it stays in the
 * 100%-coverage set and never imports a daemon-only / DB type), it deals in a
 * loader-local {@link AgentRecurrenceSpec} that is a 1:1 structural mirror of
 * the daemon's `recurrence_rule` JSON. The Phase-7 production adapter maps
 * `AgentRecurrenceSpec` ↔ the real `recurring_schedules` `RecurrenceRule`
 * with a field copy — no logic.
 *
 * Both functions are **total**: a cron shape the structured rule cannot
 * represent (sub-hourly step minutes like `*​/30`, hour ranges/lists, `?` in
 * the day fields, an OR of day-of-month AND day-of-week, etc.) yields `null`
 * from {@link cronToRecurrenceSpec}, and the caller keeps the raw cron string
 * instead of fabricating a lossy rule. `recurrenceSpecToCron` always produces a
 * valid 5-field expression.
 *
 * **`hourly` IS mirrored** (the former Phase-7 gap, now closed). The daemon's
 * `recurrenceRuleSchema` (schemas.ts) carries an `hourly` frequency
 * (`intervalHours` 1..23 / `minuteOfHour` 0..59); this module round-trips it
 * through the step-form cron `M * * * *` (every hour at :M) and `M *​/N * * *`
 * (every N hours at :M). So a user Agent CAN declare an hourly cadence and the
 * loader pairs it to a real `recurring_schedules.hourly` row. The remaining gap
 * is the monthly `onMissingDay` policy, which cron cannot carry — it is dropped
 * on conversion (a `daysOfMonth` cron uses node-cron's own missing-day
 * behaviour). Sub-hourly intervals (every N minutes) are NOT representable —
 * only the built-in activity-scan supports those, via config.
 */

/** Loader-local mirror of the daemon `recurrence_rule` JSON (§2.2). Covers the
 *  four cron-representable frequencies (`hourly` via the step-form cron). The
 *  monthly `onMissingDay` policy is not mirrored — it cannot round-trip through
 *  cron (see the module header). */
export interface AgentRecurrenceSpec {
  frequency: "hourly" | "daily" | "weekly" | "monthly";
  /** `HH:MM`, 24-hour, zero-padded. Present for daily/weekly/monthly only. */
  time?: string;
  /** IANA timezone resolved by the loader (never null on the stored row). */
  timezone: string;
  /** 0=Sunday … 6=Saturday — present only for `weekly`. */
  daysOfWeek?: number[];
  /** 1…31 — present only for `monthly`. */
  daysOfMonth?: number[];
  /** 1…23 — present only for `hourly` (fire every N hours). Default 1. */
  intervalHours?: number;
  /** 0…59 — present only for `hourly` (minute-of-hour to fire at). Default 0. */
  minuteOfHour?: number;
}

import type { RecurrenceRule } from "@aitne/shared";

/** Zero-pad a single clock field to two digits. */
function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

/**
 * Parse the hour field of an hourly cron into its interval in hours:
 *   - `*`     → 1   (every hour)
 *   - `*​/N`  → N   (every N hours, N in 1..23 to match `recurrenceRuleSchema`)
 * Returns `null` for a single integer (that is a daily/weekly/monthly hour) or
 * any other shape (range / list / out-of-range step).
 */
function parseHourInterval(field: string): number | null {
  if (field === "*") return 1;
  const match = /^\*\/(\d+)$/.exec(field);
  if (!match) return null;
  const n = Number.parseInt(match[1], 10);
  return n >= 1 && n <= 23 ? n : null;
}

/**
 * Parse a single cron field that must be a single non-negative integer in
 * `[min, max]`. Returns `null` for wildcards, lists, ranges, or steps — the
 * caller treats that as "not representable as a structured rule".
 */
function parseSingleInt(
  field: string | undefined,
  min: number,
  max: number,
): number | null {
  if (field === undefined || !/^\d+$/.test(field)) return null;
  const value = Number.parseInt(field, 10);
  if (value < min || value > max) return null;
  return value;
}

/**
 * Parse a comma-separated list of single integers in `[min, max]` (e.g. the
 * day-of-week or day-of-month field). Returns `null` if any element is a
 * wildcard / range / step / out-of-range value. An empty result is impossible
 * because a non-empty field always yields at least one element or `null`.
 */
function parseIntList(field: string, min: number, max: number): number[] | null {
  const parts = field.split(",");
  const out: number[] = [];
  for (const part of parts) {
    const value = parseSingleInt(part, min, max);
    if (value === null) return null;
    out.push(value);
  }
  return out;
}

/**
 * Convert a standard 5-field cron expression (`m h dom mon dow`) into a
 * structured {@link AgentRecurrenceSpec}, or `null` when the expression is not
 * one of the three shapes the recurrence rule can represent:
 *
 *   - **hourly**  `M * * * *` / `M *​/N * * *`     (hour wild or step)
 *   - **daily**   `M H * * *`
 *   - **weekly**  `M H * * <dow-list>`            (day-of-month wild)
 *   - **monthly** `M H <dom-list> * *`            (day-of-week wild)
 *
 * The minute field must be a single integer. The hour field is either a single
 * integer (daily/weekly/monthly) or `*` / `*​/N` (hourly). The month field must
 * be `*` (the rule has no month selector). A `null` return is the signal to
 * keep the raw cron string rather than fabricate a lossy rule.
 */
export function cronToRecurrenceSpec(
  cronExpr: string,
  timezone: string,
): AgentRecurrenceSpec | null {
  const fields = cronExpr.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const [minuteField, hourField, domField, monthField, dowField] = fields;

  const minute = parseSingleInt(minuteField, 0, 59);
  if (minute === null) return null;
  // The structured rule has no month selector, so a non-wildcard month field
  // is not representable.
  if (monthField !== "*") return null;

  const domWild = domField === "*";
  // cron treats both `*` and `?` as "no constraint" for day-of-week; the
  // structured rule only emits `*`, so normalise `?` to wild here.
  const dowWild = dowField === "*" || dowField === "?";

  // Hourly: the hour field is `*` (every hour) or `*​/N` (every N hours). An
  // hourly rule fires on every day, so a constrained day-of-month / day-of-week
  // is not representable (use a daily/weekly/monthly cadence for that).
  const intervalHours = parseHourInterval(hourField);
  if (intervalHours !== null) {
    if (!(domWild && dowWild)) return null;
    return { frequency: "hourly", timezone, intervalHours, minuteOfHour: minute };
  }

  // Daily / weekly / monthly: the hour field must be a single integer.
  const hour = parseSingleInt(hourField, 0, 23);
  if (hour === null) return null;
  const time = `${pad2(hour)}:${pad2(minute)}`;

  if (domWild && dowWild) {
    return { frequency: "daily", time, timezone };
  }
  if (domWild && !dowWild) {
    const daysOfWeek = parseIntList(dowField, 0, 6);
    if (daysOfWeek === null) return null;
    return { frequency: "weekly", time, timezone, daysOfWeek };
  }
  if (!domWild && dowWild) {
    const daysOfMonth = parseIntList(domField, 1, 31);
    if (daysOfMonth === null) return null;
    return { frequency: "monthly", time, timezone, daysOfMonth };
  }
  // Both day-of-month AND day-of-week constrained — cron ORs them, which the
  // structured rule cannot express. Not representable.
  return null;
}

/**
 * Convert a structured {@link AgentRecurrenceSpec} into a standard 5-field
 * cron expression. Always total — `hourly` emits the step-form (`M * * * *` /
 * `M *​/N * * *`), `daily` collapses both day fields to `*`, `weekly` lists the
 * days-of-week, `monthly` lists the days-of-month. An empty / missing day list
 * falls back to the wildcard so the expression is always schedulable.
 */
export function recurrenceSpecToCron(spec: AgentRecurrenceSpec): string {
  if (spec.frequency === "hourly") {
    const minute = spec.minuteOfHour ?? 0;
    const n = spec.intervalHours ?? 1;
    // `*​/1` is just `*`; emit the simpler form for every-hour cadences.
    return `${minute} ${n === 1 ? "*" : `*/${n}`} * * *`;
  }

  const [hourStr, minuteStr] = (spec.time ?? "").split(":");
  // Defensive: a malformed / absent time falls back to midnight rather than
  // emitting an unschedulable field. parseSingleInt tolerates an absent field.
  const hour = parseSingleInt(hourStr, 0, 23) ?? 0;
  const minute = parseSingleInt(minuteStr, 0, 59) ?? 0;

  let dom = "*";
  let dow = "*";
  if (spec.frequency === "weekly") {
    dow = spec.daysOfWeek && spec.daysOfWeek.length > 0
      ? spec.daysOfWeek.join(",")
      : "*";
  } else if (spec.frequency === "monthly") {
    dom = spec.daysOfMonth && spec.daysOfMonth.length > 0
      ? spec.daysOfMonth.join(",")
      : "*";
  }
  return `${minute} ${hour} ${dom} * ${dow}`;
}

/**
 * Convert a daemon `RecurrenceRule` (the schedule-API structured shape, incl.
 * `hourly`) into a 5-field cron expression for storage in a user Agent's
 * `agent.md`. Used by `POST /api/agents` so a caller can declare a structured
 * `recurrence` (frequency + fields) and the route renders the canonical cron
 * the loader then re-pairs. The monthly `onMissingDay` policy is intentionally
 * not carried (cron cannot express it). Delegates to {@link recurrenceSpecToCron}
 * after a field copy so the two stay byte-identical.
 */
export function recurrenceRuleToCron(rule: RecurrenceRule): string {
  return recurrenceSpecToCron({
    frequency: rule.frequency,
    // timezone is unused by the cron emitter (it carries no zone); a placeholder
    // keeps the spec well-formed.
    timezone: rule.timezone ?? "UTC",
    ...(rule.time !== undefined ? { time: rule.time } : {}),
    ...(rule.daysOfWeek !== undefined ? { daysOfWeek: rule.daysOfWeek } : {}),
    ...(rule.daysOfMonth !== undefined ? { daysOfMonth: rule.daysOfMonth } : {}),
    ...(rule.intervalHours !== undefined ? { intervalHours: rule.intervalHours } : {}),
    ...(rule.minuteOfHour !== undefined ? { minuteOfHour: rule.minuteOfHour } : {}),
  });
}
