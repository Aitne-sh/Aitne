import { describe, it, expect } from "vitest";
import { Sparkline } from "./sparkline";

// Sparkline is a React functional component, but it is just a function.
// These tests exercise the early-return null guards by calling it directly —
// no React runtime needed because the null branches never construct JSX.

describe("Sparkline null guards", () => {
  it("returns null for values.length < 2 (Today view single bucket)", () => {
    // daily.length === 1 when the Today agent-day bucket is selected
    expect(Sparkline({ values: [0.9], color: "#10b981" })).toBeNull();
  });

  it("returns null for an empty values array", () => {
    expect(Sparkline({ values: [], color: "#10b981" })).toBeNull();
  });

  it("returns null when every value is null", () => {
    expect(
      Sparkline({ values: [null, null, null, null], color: "#10b981" }),
    ).toBeNull();
  });

  it("returns null for a single non-null value wrapped in nulls (still length===1 → <2 guard)", () => {
    // The first guard (values.length < 2) bails before the present-count check.
    // This case can't happen (length is 1) but documents the precedence.
    expect(Sparkline({ values: [5], color: "#10b981" })).toBeNull();
  });
});
