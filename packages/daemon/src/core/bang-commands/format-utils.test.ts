import { describe, it, expect } from "vitest";
import type { AgentConfig } from "../../config.js";
import {
  buildSystemMarker,
  ensureSystemMarker,
  formatLocalLong,
  formatLocalShort,
  formatMoney,
  MOBILE_REPLY_BUDGET,
  truncateForMobile,
} from "./format-utils.js";

describe("buildSystemMarker", () => {
  it("formats command without window", () => {
    expect(buildSystemMarker("!stop")).toBe("[SYSTEM · !stop]");
  });

  it("includes window when provided", () => {
    expect(buildSystemMarker("!cost", "last 7d")).toBe(
      "[SYSTEM · !cost · last 7d]",
    );
  });
});

describe("ensureSystemMarker", () => {
  it("prepends a marker when missing", () => {
    expect(ensureSystemMarker("body", "[SYSTEM · x]")).toBe(
      "[SYSTEM · x]\nbody",
    );
  });

  it("is a no-op for already-prefixed text", () => {
    expect(ensureSystemMarker("[SYSTEM · y]\nbody", "[SYSTEM · x]")).toBe(
      "[SYSTEM · y]\nbody",
    );
  });
});

describe("truncateForMobile", () => {
  it("leaves short text unchanged", () => {
    expect(truncateForMobile("short")).toBe("short");
  });

  it("appends '… (truncated)' on overflow", () => {
    const long = "z".repeat(MOBILE_REPLY_BUDGET + 50);
    const out = truncateForMobile(long);
    expect(out.length).toBeLessThanOrEqual(MOBILE_REPLY_BUDGET);
    expect(out.endsWith("… (truncated)")).toBe(true);
  });

  it("does not tear a surrogate pair at the cut boundary", () => {
    // Construct a payload where the cut index lands exactly on the low
    // surrogate of an emoji — without the backoff guard, the truncated
    // chunk ends with a lone high surrogate that renders as U+FFFD.
    const footer = "\n… (truncated)";
    const cut = MOBILE_REPLY_BUDGET - footer.length;
    const prefix = "a".repeat(cut - 1); // ends one slot before the emoji
    const long = `${prefix}🎉${"b".repeat(100)}`;
    const out = truncateForMobile(long);
    const lastCode = out.replace(footer, "").charCodeAt(out.length - footer.length - 1);
    expect(lastCode >= 0xd800 && lastCode <= 0xdbff).toBe(false);
  });
});

describe("formatMoney", () => {
  it("returns $0.00 for zero / non-positive", () => {
    expect(formatMoney(0)).toBe("$0.00");
    expect(formatMoney(-1)).toBe("$0.00");
  });

  it("returns <$0.01 for sub-cent positives", () => {
    expect(formatMoney(0.0001)).toBe("<$0.01");
  });

  it("rounds to two decimals", () => {
    expect(formatMoney(1.4242)).toBe("$1.42");
    expect(formatMoney(0.08)).toBe("$0.08");
  });

  it("guards against NaN", () => {
    expect(formatMoney(NaN)).toBe("$0.00");
  });
});

describe("formatLocalShort / formatLocalLong", () => {
  const config = { timezone: "Asia/Tokyo" } as AgentConfig;

  it("formats SQLite UTC string in configured timezone (short)", () => {
    expect(formatLocalShort("2026-05-01 03:02:00", config)).toBe("05-01 12:02");
  });

  it("formats ISO UTC string with year (long)", () => {
    expect(formatLocalLong("2026-04-30T12:00:00.000Z", config)).toBe(
      "2026-04-30 21:00",
    );
  });

  it("returns the input when unparseable", () => {
    expect(formatLocalShort("not a date", config)).toBe("not a date");
    expect(formatLocalLong("nope", config)).toBe("nope");
  });

  it("falls back to UTC when timezone is empty", () => {
    const noTz = { timezone: "" } as AgentConfig;
    expect(formatLocalShort("2026-05-01 03:02:00", noTz)).toBe("05-01 03:02");
  });

  it("formatLocalLong falls back to UTC when timezone is empty", () => {
    const noTz = { timezone: "" } as AgentConfig;
    expect(formatLocalLong("2026-04-30T12:00:00.000Z", noTz)).toBe(
      "2026-04-30 12:00",
    );
  });

  it("normalises midnight 24:00 → 00:00", () => {
    // At UTC, midnight in en-CA can render as `24:00` on some Node builds.
    // The helper coerces it to `00:00` for a stable display.
    const noTz = { timezone: "" } as AgentConfig;
    const out = formatLocalShort("2026-05-01 00:00:00", noTz);
    expect(out).toMatch(/^05-01 00:00$/);
  });
});
