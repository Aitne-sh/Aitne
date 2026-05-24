import { describe, it, expect } from "vitest";
import {
  formatSqliteTimestampForContext,
  truncateContextText,
  truncateForBlock,
} from "./context-builder-format.js";

describe("truncateForBlock", () => {
  it("returns input unchanged when already a single line under the cap", () => {
    expect(truncateForBlock("hello world", 50)).toBe("hello world");
  });

  it("collapses internal whitespace runs to single spaces", () => {
    expect(truncateForBlock("hello\n\n  world", 50)).toBe("hello world");
  });

  it("trims leading and trailing whitespace before measuring length", () => {
    expect(truncateForBlock("  padded  ", 10)).toBe("padded");
  });

  it("truncates with a U+2026 ellipsis when over the cap", () => {
    const out = truncateForBlock("0123456789abcdef", 10);
    expect(out).toBe("012345678…");
    expect(out.length).toBe(10);
  });

  it("uses (max - 1) for the slice so the ellipsis fits exactly", () => {
    // Contract: ellipsis is U+2026, single code point.
    // Result length must equal `max`.
    const value = "x".repeat(100);
    const out = truncateForBlock(value, 7);
    expect(out).toBe("xxxxxx…");
    expect(out.length).toBe(7);
  });
});

describe("truncateContextText", () => {
  it("returns input unchanged when already a single line under the cap", () => {
    expect(truncateContextText("hello world", 50)).toBe("hello world");
  });

  it("collapses internal whitespace runs to single spaces", () => {
    expect(truncateContextText("a   b\nc\td", 50)).toBe("a b c d");
  });

  it("truncates with three ASCII dots when over the cap", () => {
    const out = truncateContextText("0123456789abcdef", 10);
    expect(out).toBe("0123456...");
    expect(out.length).toBe(10);
  });

  it("uses (maxChars - 3) for the slice so the three dots fit exactly", () => {
    // Contract distinction from truncateForBlock: this helper uses three
    // ASCII dots, not U+2026. Golden snapshots depend on this distinction;
    // do not unify the two truncators.
    const value = "x".repeat(100);
    const out = truncateContextText(value, 8);
    expect(out).toBe("xxxxx...");
    expect(out.length).toBe(8);
  });
});

describe("formatSqliteTimestampForContext", () => {
  it("renders a SQLite UTC timestamp as YYYY-MM-DD HH:MM in the supplied IANA timezone", () => {
    // 2026-04-12 09:30:00 UTC is 18:30 in Asia/Tokyo (UTC+9, no DST).
    expect(
      formatSqliteTimestampForContext("2026-04-12 09:30:00", "Asia/Tokyo"),
    ).toBe("2026-04-12 18:30");
  });

  it("treats 'system' as undefined so the host timezone is used", () => {
    // We cannot pin the host timezone in the test runner, so assert only
    // that the output matches the expected shape; the underlying call
    // mirrors the production path used by every yesterday/SQLite formatter.
    const out = formatSqliteTimestampForContext(
      "2026-04-12 09:30:00",
      "system",
    );
    expect(out).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  });

  it("zero-pads month, day, hour, and minute", () => {
    // 2026-01-02 03:04:05 UTC -> 03:04 UTC (since timezone=UTC has no shift).
    expect(
      formatSqliteTimestampForContext("2026-01-02 03:04:05", "UTC"),
    ).toBe("2026-01-02 03:04");
  });
});
