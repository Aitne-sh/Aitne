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
  const nice = steps.find((s) => normalized <= s) ?? 10;
  return nice * magnitude;
}

export function formatDuration(ms: number): string {
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

export function formatRelativeTime(date: string | Date): string {
  const d = parseUtcDate(date);
  return formatDistanceToNowStrict(d, { addSuffix: true });
}

export function formatAbsoluteTime(date: string | Date): string {
  const d = parseUtcDate(date);
  return format(d, "yyyy-MM-dd HH:mm:ss");
}

export function formatShortDateTime(date: string | Date): string {
  const d = parseUtcDate(date);
  return format(d, "MM-dd HH:mm");
}

export function formatDate(date: string | Date): string {
  const d = parseUtcDate(date);
  return format(d, "yyyy-MM-dd");
}

export function formatAmount(amount: number, currency: string): string {
  if (currency === "USD") return `$${(amount / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  if (currency === "EUR") return `\u20ac${(amount / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  if (currency === "GBP") return `\u00a3${(amount / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return `${amount} ${currency}`;
}

export function formatAmountWithPeriod(amount: number, currency: string, billingPeriod: string | null): string {
  const base = formatAmount(amount, currency);
  if (billingPeriod === "monthly") return `${base}/mo`;
  if (billingPeriod === "yearly") return `${base}/yr`;
  return base;
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
 * All four params are required to prevent callers from silently regressing
 * to the buggy uncached-only display.
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
