import { describe, it, expect } from "vitest";
import {
  detectShoppingSessions,
  SHOPPING_COMPARISON_WINDOW_MS,
} from "./browser-history-poller.js";

function visit(tsMinutes: number, asin: string) {
  return { ts: tsMinutes * 60_000, asin };
}

describe("detectShoppingSessions (§5.F3 sliding-window)", () => {
  it("returns empty for fewer than 3 visits", () => {
    expect(
      detectShoppingSessions([visit(0, "B01"), visit(5, "B02")]),
    ).toEqual([]);
  });

  it("returns empty for 3 visits sharing one ASIN", () => {
    expect(
      detectShoppingSessions([
        visit(0, "B01"),
        visit(5, "B01"),
        visit(10, "B01"),
      ]),
    ).toEqual([]);
  });

  it("emits a session when 3 distinct ASINs fall inside a 90-min window", () => {
    const sessions = detectShoppingSessions([
      visit(0, "B01"),
      visit(20, "B02"),
      visit(85, "B03"),
    ]);
    expect(sessions).toHaveLength(1);
    expect(new Set(sessions[0].asins)).toEqual(new Set(["B01", "B02", "B03"]));
    expect(sessions[0].lastMs - sessions[0].firstMs).toBeLessThanOrEqual(
      SHOPPING_COMPARISON_WINDOW_MS,
    );
  });

  it("does NOT merge a morning burst with an evening burst hours apart", () => {
    const sessions = detectShoppingSessions([
      visit(0, "B01"),
      visit(10, "B02"),
      visit(20, "B03"),
      // 6h gap — must not fuse into one session
      visit(360, "B04"),
      visit(370, "B05"),
      visit(380, "B06"),
    ]);
    expect(sessions).toHaveLength(2);
    expect(new Set(sessions[0].asins)).toEqual(new Set(["B01", "B02", "B03"]));
    expect(new Set(sessions[1].asins)).toEqual(new Set(["B04", "B05", "B06"]));
  });

  it("does NOT emit overlapping windows for a single sustained burst", () => {
    const sessions = detectShoppingSessions([
      visit(0, "B01"),
      visit(5, "B02"),
      visit(10, "B03"),
      visit(15, "B04"),
      visit(20, "B05"),
    ]);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].asins.length).toBe(5);
  });

  it("rejects a 3-distinct-ASIN burst whose span exceeds 90 min", () => {
    const sessions = detectShoppingSessions([
      visit(0, "B01"),
      visit(60, "B02"),
      // 91 min after B01: outside window
      visit(91, "B03"),
    ]);
    expect(sessions).toEqual([]);
  });
});
