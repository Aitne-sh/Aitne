import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";
import { formatDistanceToNowStrict, format } from "date-fns";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Parse a SQLite UTC datetime string ("YYYY-MM-DD HH:MM:SS") into a Date.
 * SQLite stores all timestamps as UTC without a "Z" suffix. Without
 * normalization, `new Date(...)` treats them as local time, causing times
 * to display incorrectly.
 */
export function parseUtcDate(date: string | Date): Date {
  if (date instanceof Date) return date;
  // Already has timezone info: "Z", "+HH:MM", or "-HH:MM"
  if (date.endsWith("Z") || /[+-]\d{2}:\d{2}$/.test(date)) return new Date(date);
  // SQLite UTC datetime without timezone suffix — append "Z"
  return new Date(date.replace(" ", "T") + "Z");
}

export function formatCurrency(usd: number | null | undefined): string {
  if (usd == null) return "$0.00";
  if (usd < 0.01 && usd > 0) return "<$0.01";
  return `$${usd.toFixed(2)}`;
}

/**
 * Round `max` up to a clean axis bound with ~10% headroom. Used by cost
 * charts so the YAxis grows with the data instead of pinning to the
 * Recharts-derived "nice" tick (which can look static across many sessions
 * when the data only inches up).
 *
 * Returns `1` when there is no positive value yet so the chart still
 * renders a sane axis on an empty day.
 */
export function niceAxisMax(values: readonly number[]): number {
  let max = 0;
  for (const v of values) {
    if (typeof v === "number" && Number.isFinite(v) && v > max) max = v;
  }
  if (max <= 0) return 1;
  const target = max * 1.1;
  const magnitude = Math.pow(10, Math.floor(Math.log10(target)));
  const normalized = target / magnitude;
  const steps = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];
  const nice = steps.find((s) => normalized <= s)!;
  return nice * magnitude;
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m ${s}s`;
}

export function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

/** Placeholder for a missing / unparseable timestamp. */
const INVALID_DATE_LABEL = "—";

/**
 * `parseUtcDate` but null/invalid-safe: returns null instead of throwing on a
 * missing value (`.endsWith` on null) or producing an Invalid Date. The dashboard
 * has no `error.tsx` boundaries, so a single null timestamp reaching a `format()`
 * call throws and white-screens the whole page — the formatters below all route
 * through this guard so a bad value degrades to `—` instead.
 */
function safeParseUtcDate(date: string | Date | null | undefined): Date | null {
  if (date == null || date === "") return null;
  const d = parseUtcDate(date);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function formatRelativeTime(date: string | Date | null | undefined): string {
  const d = safeParseUtcDate(date);
  return d ? formatDistanceToNowStrict(d, { addSuffix: true }) : INVALID_DATE_LABEL;
}

export function formatAbsoluteTime(date: string | Date | null | undefined): string {
  const d = safeParseUtcDate(date);
  return d ? format(d, "yyyy-MM-dd HH:mm:ss") : INVALID_DATE_LABEL;
}

export function formatShortDateTime(date: string | Date | null | undefined): string {
  const d = safeParseUtcDate(date);
  return d ? format(d, "MM-dd HH:mm") : INVALID_DATE_LABEL;
}

export function formatDate(date: string | Date | null | undefined): string {
  const d = safeParseUtcDate(date);
  return d ? format(d, "yyyy-MM-dd") : INVALID_DATE_LABEL;
}

/**
 * Locale-formatted absolute timestamp for "last activity"-style fields.
 * Accepts an ISO string or epoch milliseconds. Falsy values render as
 * `emptyLabel`; an unparseable string renders as-is.
 *
 * Unlike `formatAbsoluteTime`, this does NOT apply the SQLite-UTC
 * normalization — use it for values that already carry timezone info
 * (ISO strings with offset, epoch ms).
 */
export function formatTimestamp(
  value: string | number | null | undefined,
  emptyLabel = "—",
): string {
  if (!value) return emptyLabel;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    return typeof value === "string" ? value : emptyLabel;
  }
  return d.toLocaleString();
}

/** Relative "Xm ago" label from an epoch-millisecond timestamp. */
export function formatRelativeMs(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 0) return "just now";
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/** Truncate to at most `max` characters, ellipsis included. */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

/**
 * Human-readable message from a thrown fetch/query error. `ApiError`
 * already extracts the daemon's `message`/`error` body field into
 * `Error#message`, so a plain `Error` check covers it.
 */
export function formatApiError(error: unknown): string {
  return error instanceof Error ? error.message : "Request failed";
}

export function formatAmount(amount: number, currency: string): string {
  if (currency === "USD") return `$${(amount / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  if (currency === "EUR") return `\u20ac${(amount / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  if (currency === "GBP") return `\u00a3${(amount / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return `${amount} ${currency}`;
}

/**
 * Compact token formatter using Intl.NumberFormat default compact notation:
 * `5`, `999`, `1.2K`, `12K`, `123K`, `999K`, `1M`, `1.2M`, `12M`, `1B`.
 *
 * Intl's default `compactDisplay: "short"` keeps 1 decimal when the
 * significand < 10 and drops it otherwise — exactly the rule readers expect
 * from a billing-style display. Hand-rolled threshold logic (e.g.
 * `n < 1_000_000 ? "K" : "M"`) silently breaks at boundaries: 999,999
 * rounds to "1000K" instead of "1M". Intl handles those rollovers
 * correctly. Forcing `maximumFractionDigits: 1` re-introduces the bug
 * (999,499 becomes "999.5K"), so we leave it at the default.
 */
const compactTokenFormat = new Intl.NumberFormat("en-US", {
  notation: "compact",
});

export function formatTokenCount(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n) || n <= 0) return "0";
  return compactTokenFormat.format(n);
}

/**
 * Token usage summary for the activity table's "In / Out" column.
 *
 * `input` is the **total input tokens delivered to the model** —
 * uncached + cache_creation + cache_read. The three backend cores all
 * normalize `tokens_input` to "non-cached billable input only", so summing
 * the three columns recovers the true input volume.
 *
 * Showing only `tokens_input` (the prior behavior) was misleading because
 * Claude with prompt caching reports it as a tiny delta (often single
 * digits) while the actual prompt sent to the model is tens of thousands
 * of tokens — the bulk arrives as `cache_read_input_tokens`.
 *
 * All four params are required so callers cannot silently fall back to
 * the uncached-only count.
 */
export function formatTokens(
  inputUncached: number | null | undefined,
  output: number | null | undefined,
  cacheCreation: number | null | undefined,
  cacheRead: number | null | undefined,
): string {
  const totalInput =
    (inputUncached ?? 0) + (cacheCreation ?? 0) + (cacheRead ?? 0);
  return `${formatTokenCount(totalInput)} / ${formatTokenCount(output ?? 0)}`;
}
