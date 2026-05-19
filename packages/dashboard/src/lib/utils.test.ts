import { describe, it, expect } from "vitest";
import {
  formatAmount,
  formatAmountWithPeriod,
  formatDate,
  formatTokenCount,
  formatTokens,
  niceAxisMax,
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
