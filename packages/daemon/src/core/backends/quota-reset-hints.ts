/**
 * Generic provider-agnostic quota reset-time parser, shared by Codex and
 * Gemini cores. Claude has its own extractor (`extractClaudeCodeQuotaResetHint`
 * in `claude-errors.ts`) tuned to the Anthropic SDK's `resets HH(:MM)? am/pm`
 * phrasing; this helper covers the OpenAI- and Google-style strings that
 * surface through the CLI subprocess.
 *
 * The output `BackendQuotaResetHint` is what the dashboard renders as
 * "quota resets at HH:MM (TZ)". Returns null when no pattern matches; the
 * caller falls back to the existing `null`-resetHint behaviour.
 *
 * Patterns supported (in priority order):
 *  1. Relative offset — "try again in 26m11s" / "retry-after: 90s".
 *     Resolved against `now()` and emitted in UTC.
 *  2. ISO timestamp — "try again at 2026-05-15T03:00:00Z" /
 *     "reset time 2026-05-15T03:00:00Z" / "retry-after: 2026-...".
 *     Normalised to UTC.
 *  3. Absolute clock time with optional am/pm and TZ —
 *     "try again at 5pm (UTC)" / "resets at 04:00 PST".
 *
 * Only string-based heuristics — extracting more from the upstream JSON
 * would require parsing each provider's error envelope, which is brittle
 * and not worth the maintenance cost. False negatives are acceptable
 * (caller falls back to `null` hint, matching today's behaviour); false
 * positives are not (would mislead the operator).
 */

import type { BackendQuotaResetHint } from "../agent-core.js";

/**
 * Build a deterministic reset hint anchored on the next agent-day boundary.
 * Used by Gemini's `daily_ceiling` quota error — the reset time is fully
 * known (next `dayBoundaryHour:00` in the configured timezone), so we don't
 * need to scan an upstream message.
 *
 * `timezone` arrives from `AgentConfig.timezone` which defaults to `""` —
 * coerce empty/whitespace to `undefined` so the dashboard renders
 * "resets at 04:00" rather than "resets at 04:00 ()".
 */
export function buildAgentDayBoundaryHint(
  dayBoundaryHour: number,
  timezone: string | undefined,
): BackendQuotaResetHint {
  const tz = timezone?.trim() ? timezone.trim() : undefined;
  const hour = Math.max(0, Math.min(23, Math.trunc(dayBoundaryHour)));
  return {
    hour,
    minute: 0,
    ...(tz ? { timeZone: tz } : {}),
    rawLabel: tz
      ? `next agent-day boundary (${hour.toString().padStart(2, "0")}:00 ${tz})`
      : `next agent-day boundary (${hour.toString().padStart(2, "0")}:00)`,
  };
}

/**
 * Parse a free-form provider error message and return a structured hint when
 * a reset time is detectable. Pure: callers may inject `now` for tests.
 */
export function extractGenericQuotaResetHint(
  message: string,
  now: () => Date = () => new Date(),
): BackendQuotaResetHint | null {
  if (!message) return null;

  // 1. Relative offset — "try again in (Xh)?(Ym)?(Zs)?" or
  //    "retry-after: Ns" (HTTP 429 header surfaced verbatim).
  const relative = /(?:try again in|retry[\s-]?after[:\s]+)\s*(?:(\d+)\s*h)?\s*(?:(\d+)\s*m)?\s*(?:(\d+)\s*s)?/i
    .exec(message);
  if (relative && (relative[1] || relative[2] || relative[3])) {
    const h = Number(relative[1] ?? 0);
    const m = Number(relative[2] ?? 0);
    const s = Number(relative[3] ?? 0);
    const offsetMs = ((h * 60 + m) * 60 + s) * 1000;
    if (offsetMs > 0) {
      const target = new Date(now().getTime() + offsetMs);
      return {
        hour: target.getUTCHours(),
        minute: target.getUTCMinutes(),
        timeZone: "UTC",
        rawLabel: relative[0].trim(),
      };
    }
  }

  // 2. ISO 8601 timestamp — "try again at YYYY-MM-DDTHH:MM(:SS)?Z|±HH:MM".
  const iso = /(?:try again at|reset(?:s|\s+time)?\s+(?:at\s+)?|retry[\s-]?after[:\s]+)\s*([0-9]{4}-[0-9]{2}-[0-9]{2}[T\s][0-9]{2}:[0-9]{2}(?::[0-9]{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)/i
    .exec(message);
  if (iso) {
    // Normalise the date string: bare "YYYY-MM-DD HH:MM" without a TZ marker
    // is interpreted by Date as local time, which is fine — but we always
    // emit UTC fields to keep the contract uniform.
    const date = new Date(iso[1].replace(" ", "T"));
    if (!Number.isNaN(date.getTime())) {
      return {
        hour: date.getUTCHours(),
        minute: date.getUTCMinutes(),
        timeZone: "UTC",
        rawLabel: iso[0].trim(),
      };
    }
  }

  // 3. Absolute clock time with optional am/pm and TZ. Anchored on
  //    "try again at" / "resets (at)?" so plain numbers in error text
  //    can't false-positive.
  const absolute = /(?:try again at|resets?\s+(?:at\s+)?)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:\(?([A-Z]{2,5}|UTC[+-]\d+)\)?)?/i
    .exec(message);
  if (absolute) {
    const rawHour = Number(absolute[1]);
    const meridiem = absolute[3]?.toLowerCase();
    let hour = rawHour;
    if (meridiem) {
      hour = rawHour % 12;
      if (meridiem === "pm") hour += 12;
    }
    if (hour >= 0 && hour < 24) {
      return {
        hour,
        minute: absolute[2] ? Number(absolute[2]) : 0,
        timeZone: absolute[4]?.trim(),
        rawLabel: absolute[0].trim(),
      };
    }
  }

  return null;
}
