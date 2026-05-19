import { describe, expect, it } from "vitest";
import { TIPS, pickRandomIndex } from "./tips-card";

/**
 * Data-shape invariants for the curated tips catalog, plus a
 * statistical check on the helper that picks a different tip on
 * "Next tip". Render-side layout decisions are covered separately
 * in tips-card.render.test.tsx.
 */

describe("TIPS catalog", () => {
  it("has at least the three flagship tips required by the design", () => {
    const ids = TIPS.map((t) => t.id);
    expect(ids).toContain("self-learning");
    expect(ids).toContain("voice");
    expect(ids).toContain("harness");
  });

  it("uses unique ids", () => {
    const ids = TIPS.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("populates non-empty title and description for every tip", () => {
    for (const tip of TIPS) {
      expect(tip.title.trim().length).toBeGreaterThan(0);
      expect(tip.description.trim().length).toBeGreaterThan(0);
    }
  });

  it("only links to internal dashboard routes", () => {
    for (const tip of TIPS) {
      if (tip.href) {
        expect(tip.href.startsWith("/")).toBe(true);
        expect(tip.href.startsWith("//")).toBe(false);
      }
    }
  });

  it("pairs every cta with a destination href", () => {
    for (const tip of TIPS) {
      if (tip.cta) {
        expect(tip.href).toBeTruthy();
      }
    }
  });
});

describe("pickRandomIndex", () => {
  it("returns -1 for an empty list", () => {
    expect(pickRandomIndex(0, -1)).toBe(-1);
  });

  it("returns 0 for a single-tip list and ignores `except`", () => {
    expect(pickRandomIndex(1, -1)).toBe(0);
    expect(pickRandomIndex(1, 0)).toBe(0);
  });

  it("never returns the excluded index across many draws", () => {
    for (let except = 0; except < 5; except++) {
      for (let i = 0; i < 500; i++) {
        const got = pickRandomIndex(5, except);
        expect(got).not.toBe(except);
        expect(got).toBeGreaterThanOrEqual(0);
        expect(got).toBeLessThan(5);
      }
    }
  });

  it("draws the remaining indices roughly uniformly (no off-by-one bias)", () => {
    // The earlier "pick uniformly, bump on collision" implementation
    // gave (except+1) twice the share of every other index. With 4
    // remaining buckets and 4000 trials, expected count per bucket is
    // 1000; the buggy version would push one bucket to ~2000. A
    // generous ±35% band catches the bug while staying robust to
    // ordinary RNG variance.
    const length = 5;
    const except = 2;
    const trials = 4000;
    const counts = new Map<number, number>();
    for (let i = 0; i < trials; i++) {
      const got = pickRandomIndex(length, except);
      counts.set(got, (counts.get(got) ?? 0) + 1);
    }

    const expected = trials / (length - 1); // 1000
    const lower = expected * 0.65;
    const upper = expected * 1.35;
    for (const [bucket, count] of counts) {
      expect(bucket).not.toBe(except);
      expect(count).toBeGreaterThan(lower);
      expect(count).toBeLessThan(upper);
    }
  });

  it("falls back to a uniform draw when `except` is out of range", () => {
    // sentinel -1 means "no previous selection"; out-of-range values
    // (negative or >= length) should not crash and should still pick
    // a valid index.
    for (const except of [-1, -99, 5, 100]) {
      for (let i = 0; i < 100; i++) {
        const got = pickRandomIndex(5, except);
        expect(got).toBeGreaterThanOrEqual(0);
        expect(got).toBeLessThan(5);
      }
    }
  });
});
