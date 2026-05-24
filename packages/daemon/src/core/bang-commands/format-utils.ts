/**
 * Reply-formatting helpers for messaging bang-commands. Mobile-first: short
 * lines, vertical bullets, no fixed-width tables, no markdown code blocks.
 * See docs/design/backlog/messaging-bang-commands.md §6.5.
 */
import type { AgentConfig } from "../../config.js";

/**
 * Hard reply length budget — sized to fit on a phone screen and well below
 * WhatsApp/Telegram/Discord/Slack message caps. See §6.5 rule 8.
 */
export const MOBILE_REPLY_BUDGET = 1500;

/** Prefix every SYSTEM-origin reply with this marker so the agent can
 *  recognize its own output on round-trip. */
export function buildSystemMarker(
  command: string,
  window?: string,
): string {
  return window
    ? `[SYSTEM · ${command} · ${window}]`
    : `[SYSTEM · ${command}]`;
}

/**
 * Inject the `[SYSTEM · …]` marker as the first line if the supplied text
 * does not already lead with `[SYSTEM`. Defensive backup so handlers that
 * forget to prepend the marker still produce well-formed output.
 */
export function ensureSystemMarker(text: string, marker: string): string {
  if (text.startsWith("[SYSTEM")) return text;
  return `${marker}\n${text}`;
}

/** Truncate a reply that exceeds the mobile budget, appending a footer.
 *
 * UTF-16 surrogate safety: a naive `text.slice(...)` slice that lands
 * between a high surrogate (0xD800-0xDBFF) and its trailing low surrogate
 * tears the pair. The orphan renders as U+FFFD on every platform and
 * Slack/Telegram/Discord reject the payload outright if the broken pair
 * happens to be the last code unit. Bang-reply text routinely carries
 * non-BMP code points (emoji, CJK extension B+) when the agent quotes
 * user input, so this is hit in practice. The fix mirrors
 * `splitOutboundText`'s B-2 backoff: if the boundary lands directly
 * after a high surrogate, step back by one code unit so the pair stays
 * intact in the truncated chunk.
 */
export function truncateForMobile(text: string): string {
  if (text.length <= MOBILE_REPLY_BUDGET) return text;
  const footer = "\n… (truncated)";
  let cut = MOBILE_REPLY_BUDGET - footer.length;
  if (cut > 0 && isHighSurrogate(text.charCodeAt(cut - 1))) {
    cut -= 1;
  }
  return text.slice(0, cut) + footer;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

/** Compact USD formatter — `$1.42`, `$0.08`, `<$0.01`. */
export function formatMoney(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) return "$0.00";
  if (usd < 0.01) return "<$0.01";
  return `$${usd.toFixed(2)}`;
}

/**
 * Render a `started_at` UTC string (SQLite `datetime('now')` format or ISO)
 * as `MM-DD HH:MM` in the user's configured timezone.
 */
export function formatLocalShort(
  isoOrSqlite: string,
  config: AgentConfig,
): string {
  const ms = parseTimestampMs(isoOrSqlite);
  if (ms === null) return isoOrSqlite;
  // Empty `config.timezone` is the "no timezone configured" sentinel — fall
  // back to UTC so reply text is reproducible across environments instead of
  // tracking the host timezone.
  const tz = config.timezone && config.timezone.length > 0
    ? config.timezone
    : "UTC";
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = fmt.formatToParts(new Date(ms));
  // Intl.DateTimeFormat is guaranteed to emit each requested field — the
  // `?? ""` is a defensive fallback for unreachable null cases that never
  // fire in practice across supported Node runtimes.
  /* c8 ignore next 2 */
  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? "";
  // Some Node builds render UTC midnight as "24:00"; coerce to "00:00" so
  // the display is stable. The "24" branch is host-platform-dependent and
  // not consistently reproducible in tests.
  /* c8 ignore next */
  const hour = get("hour") === "24" ? "00" : get("hour");
  return `${get("month")}-${get("day")} ${hour}:${get("minute")}`;
}

/**
 * Render a `since` ISO timestamp as `YYYY-MM-DD HH:MM` in the user's
 * timezone — used by `!stop`/`!start` where the calendar year matters.
 */
export function formatLocalLong(
  iso: string,
  config: AgentConfig,
): string {
  const ms = parseTimestampMs(iso);
  if (ms === null) return iso;
  const tz = config.timezone && config.timezone.length > 0
    ? config.timezone
    : "UTC";
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = fmt.formatToParts(new Date(ms));
  // Intl.DateTimeFormat is guaranteed to emit each requested field — the
  // `?? ""` is a defensive fallback for unreachable null cases that never
  // fire in practice across supported Node runtimes.
  /* c8 ignore next 2 */
  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? "";
  // Some Node builds render UTC midnight as "24:00"; coerce to "00:00" so
  // the display is stable. The "24" branch is host-platform-dependent and
  // not consistently reproducible in tests.
  /* c8 ignore next */
  const hour = get("hour") === "24" ? "00" : get("hour");
  return `${get("year")}-${get("month")}-${get("day")} ${hour}:${get("minute")}`;
}

function parseTimestampMs(value: string): number | null {
  // SQLite `datetime('now')` produces `YYYY-MM-DD HH:MM:SS` (UTC, no `T`,
  // no zone). Normalize to ISO so `Date.parse` reads it as UTC instead of
  // local time, which would shift `formatLocalShort` by the local offset
  // when the column is consumed verbatim.
  const trimmed = value.trim();
  const sqliteMatch = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(
    trimmed,
  );
  const candidate = sqliteMatch
    ? `${sqliteMatch[1]}-${sqliteMatch[2]}-${sqliteMatch[3]}T${sqliteMatch[4]}:${sqliteMatch[5]}:${sqliteMatch[6]}Z`
    : trimmed;
  const ms = Date.parse(candidate);
  return Number.isFinite(ms) ? ms : null;
}
