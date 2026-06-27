import { describe, it, expect, vi, afterEach } from "vitest";
import {
  formatAmount,
  formatAmountWithPeriod,
  formatApiError,
  formatBytes,
  formatCurrency,
  formatDate,
  formatDuration,
  formatAbsoluteTime,
  formatRelativeTime,
  formatShortDateTime,
  formatUptime,
  formatRelativeMs,
  formatTimestamp,
  formatTokenCount,
  formatTokens,
  niceAxisMax,
  truncate,
} from "./utils";

describe("formatAmount", () => {
  it("formats USD from cents to dollars", () => {
    expect(formatAmount(999, "USD")).toBe("$9.99");
    expect(formatAmount(100, "USD")).toBe("$1.00");
    expect(formatAmount(0, "USD")).toBe("$0.00");
    expect(formatAmount(1050, "USD")).toBe("$10.50");
  });

  it("formats EUR from cents", () => {
    expect(formatAmount(1299, "EUR")).toBe("€12.99");
  });

  it("formats GBP from pence", () => {
    expect(formatAmount(799, "GBP")).toBe("£7.99");
  });

  it("falls back to raw amount + currency code for unknown currencies", () => {
    expect(formatAmount(500, "KRW")).toBe("500 KRW");
  });
});

describe("formatAmountWithPeriod", () => {
  it("appends /mo for monthly", () => {
    expect(formatAmountWithPeriod(1500, "USD", "monthly")).toBe("$15.00/mo");
  });

  it("appends /yr for yearly", () => {
    expect(formatAmountWithPeriod(11800, "USD", "yearly")).toBe("$118.00/yr");
  });

  it("returns base amount when period is null", () => {
    expect(formatAmountWithPeriod(1500, "USD", null)).toBe("$15.00");
  });

  it("returns base amount for unknown period", () => {
    expect(formatAmountWithPeriod(999, "USD", "weekly")).toBe("$9.99");
  });
});

describe("formatCurrency", () => {
  it("formats nullish, tiny positive, and normal USD values", () => {
    expect(formatCurrency(null)).toBe("$0.00");
    expect(formatCurrency(undefined)).toBe("$0.00");
    expect(formatCurrency(0.005)).toBe("<$0.01");
    expect(formatCurrency(1.2)).toBe("$1.20");
  });
});

describe("formatDate", () => {
  it("formats ISO date string to yyyy-MM-dd", () => {
    expect(formatDate("2026-04-12T10:30:00Z")).toBe("2026-04-12");
  });

  it("handles SQLite UTC format without Z suffix", () => {
    // parseUtcDate appends Z, then format extracts date in UTC
    const result = formatDate("2026-04-12 10:30:00");
    expect(result).toBe("2026-04-12");
  });
});

describe("formatDuration", () => {
  it("renders missing or invalid durations as unavailable", () => {
    expect(formatDuration(null)).toBe("—");
    expect(formatDuration(undefined)).toBe("—");
    expect(formatDuration(Number.NaN)).toBe("—");
  });

  it("formats millisecond, second, and minute durations", () => {
    expect(formatDuration(999)).toBe("999ms");
    expect(formatDuration(1500)).toBe("1.5s");
    expect(formatDuration(65_000)).toBe("1m 5s");
  });
});

describe("formatUptime", () => {
  it("formats day, hour, and minute buckets", () => {
    expect(formatUptime(2 * 86_400 + 3 * 3_600 + 4 * 60)).toBe("2d 3h 4m");
    expect(formatUptime(3 * 3_600 + 4 * 60)).toBe("3h 4m");
    expect(formatUptime(4 * 60)).toBe("4m");
  });
});

describe("formatShortDateTime", () => {
  it("formats a Date value as compact month-day time", () => {
    expect(formatShortDateTime(new Date(2026, 3, 12, 10, 30, 0))).toBe("04-12 10:30");
  });
});

describe("formatAbsoluteTime", () => {
  it("formats Date values as full local timestamps", () => {
    expect(formatAbsoluteTime(new Date(2026, 3, 12, 10, 30, 5))).toBe(
      "2026-04-12 10:30:05",
    );
  });
});

describe("formatRelativeTime", () => {
  afterEach(() => vi.useRealTimers());

  it("formats elapsed time relative to now", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-12T10:30:00Z"));
    expect(formatRelativeTime("2026-04-12T10:25:00Z")).toBe("5 minutes ago");
  });
});

describe("formatTokenCount", () => {
  it("renders sub-1k counts verbatim", () => {
    expect(formatTokenCount(0)).toBe("0");
    expect(formatTokenCount(5)).toBe("5");
    expect(formatTokenCount(999)).toBe("999");
  });

  it("uses K notation between 1k and 1M", () => {
    expect(formatTokenCount(1000)).toBe("1K");
    expect(formatTokenCount(1234)).toBe("1.2K");
    expect(formatTokenCount(12345)).toBe("12K");
    expect(formatTokenCount(123456)).toBe("123K");
  });

  it("rolls into M cleanly at the 999_500 boundary (no '1000K' bug)", () => {
    expect(formatTokenCount(999_499)).toBe("999K");
    expect(formatTokenCount(999_500)).toBe("1M");
    expect(formatTokenCount(999_999)).toBe("1M");
    expect(formatTokenCount(1_000_000)).toBe("1M");
    expect(formatTokenCount(1_234_567)).toBe("1.2M");
  });

  it("handles invalid inputs as 0", () => {
    expect(formatTokenCount(null)).toBe("0");
    expect(formatTokenCount(undefined)).toBe("0");
    expect(formatTokenCount(-1)).toBe("0");
    expect(formatTokenCount(Number.NaN)).toBe("0");
  });
});

describe("formatTokens", () => {
  it("sums uncached + cache_creation + cache_read for the input total", () => {
    // Real values from a Claude Opus 4.7 message.received row:
    // tokens_input=5, cache_creation=19_785, cache_read=15_458, output=156.
    // The pre-fix display showed "5 / 156" — misleading because 99% of the
    // actual prompt arrived via cache_read. The new total is 35,248
    // → "35K" under Intl's default compact rules (>=10K drops decimals).
    expect(formatTokens(5, 156, 19_785, 15_458)).toBe("35K / 156");
  });

  it("renders cache-less entries (e.g. Codex no-cache turn) without inflating", () => {
    expect(formatTokens(1200, 800, 0, 0)).toBe("1.2K / 800");
  });

  it("treats null cache columns as 0 (older rows / non-cached backends)", () => {
    expect(formatTokens(100, 50, null, null)).toBe("100 / 50");
  });

  it("renders an all-zero / null row as 0 / 0 without throwing", () => {
    expect(formatTokens(null, null, null, null)).toBe("0 / 0");
  });
});

describe("niceAxisMax", () => {
  it("returns 1 for an empty or all-zero series", () => {
    expect(niceAxisMax([])).toBe(1);
    expect(niceAxisMax([0, 0, 0])).toBe(1);
  });

  it("grows past the data max so the tallest bar has headroom", () => {
    expect(niceAxisMax([3.16, 2.5, 1.0])).toBeGreaterThan(3.16);
    expect(niceAxisMax([12, 8, 4])).toBeGreaterThan(12);
    expect(niceAxisMax([120, 95, 30])).toBeGreaterThan(120);
  });

  it("rounds up to a clean axis bound at the same magnitude", () => {
    expect(niceAxisMax([3.16])).toBe(4);
    expect(niceAxisMax([7.5])).toBe(10);
    expect(niceAxisMax([12])).toBe(15);
  });

  it("scales across orders of magnitude", () => {
    expect(niceAxisMax([0.08])).toBeCloseTo(0.1, 10);
    expect(niceAxisMax([0.5])).toBeCloseTo(0.6, 10);
    expect(niceAxisMax([95])).toBe(120);
  });

  it("ignores non-finite values", () => {
    expect(niceAxisMax([NaN, Infinity, 2.0])).toBe(2.5);
  });
});

describe("formatTimestamp", () => {
  it("renders the empty label for nullish or zero values", () => {
    expect(formatTimestamp(null)).toBe("—");
    expect(formatTimestamp(undefined)).toBe("—");
    expect(formatTimestamp(0)).toBe("—");
    expect(formatTimestamp(null, "Never")).toBe("Never");
  });

  it("formats ISO strings and epoch milliseconds via toLocaleString", () => {
    const iso = "2026-06-10T12:34:56Z";
    expect(formatTimestamp(iso)).toBe(new Date(iso).toLocaleString());
    const ms = Date.UTC(2026, 5, 10, 12, 34, 56);
    expect(formatTimestamp(ms)).toBe(new Date(ms).toLocaleString());
  });

  it("returns an unparseable string as-is", () => {
    expect(formatTimestamp("not-a-date")).toBe("not-a-date");
  });

  it("renders an invalid numeric timestamp as the empty label", () => {
    expect(formatTimestamp(Infinity, "Never")).toBe("Never");
  });
});

describe("formatRelativeMs", () => {
  afterEach(() => vi.useRealTimers());

  it("buckets elapsed time into m/h/d suffixes", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-10T12:00:00Z"));
    const now = Date.now();
    expect(formatRelativeMs(now + 5_000)).toBe("just now"); // future-safe
    expect(formatRelativeMs(now - 30_000)).toBe("just now");
    expect(formatRelativeMs(now - 5 * 60_000)).toBe("5m ago");
    expect(formatRelativeMs(now - 3 * 3_600_000)).toBe("3h ago");
    expect(formatRelativeMs(now - 2 * 86_400_000)).toBe("2d ago");
  });
});

describe("formatBytes", () => {
  it("scales through B / KB / MB / GB", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
    expect(formatBytes(3 * 1024 * 1024 * 1024)).toBe("3.0 GB");
  });
});

describe("truncate", () => {
  it("returns short strings unchanged", () => {
    expect(truncate("abc", 5)).toBe("abc");
    expect(truncate("abcde", 5)).toBe("abcde");
  });

  it("caps at max characters including the ellipsis", () => {
    expect(truncate("abcdef", 5)).toBe("abcd…");
    expect(truncate("abcdef", 5)).toHaveLength(5);
  });
});

describe("formatApiError", () => {
  it("uses the Error message when present", () => {
    expect(formatApiError(new Error("boom"))).toBe("boom");
  });

  it("falls back for non-Error throwables", () => {
    expect(formatApiError("nope")).toBe("Request failed");
    expect(formatApiError(undefined)).toBe("Request failed");
  });
});
