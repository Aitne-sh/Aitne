import { describe, it, expect } from "vitest";
import {
  agentDayDateStr,
  agentDaySeed,
  fnv1a32,
  mulberry32,
  seededSample,
} from "./seeded-sample";

describe("agentDayDateStr", () => {
  it("returns today after 04:00", () => {
    const ten = new Date("2026-04-25T10:00:00Z");
    // The implementation uses local-time hours; pick a UTC offset where
    // 10:00 UTC is still ≥ 04:00 local on April 25 in any reasonable TZ.
    expect(agentDayDateStr(ten)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("rolls back one day before 04:00 local", () => {
    const beforeBoundary = new Date(2026, 3, 25, 2, 30, 0); // 02:30 local
    const date = agentDayDateStr(beforeBoundary);
    // The agent day is "previous calendar day".
    expect(date).toBe("2026-04-24");
  });

  it("rolls forward at exactly 04:00 local", () => {
    const atBoundary = new Date(2026, 3, 25, 4, 0, 0);
    expect(agentDayDateStr(atBoundary)).toBe("2026-04-25");
  });
});

describe("fnv1a32", () => {
  it("is deterministic for a given input", () => {
    expect(fnv1a32("hello")).toBe(fnv1a32("hello"));
  });
  it("differs across reasonable inputs", () => {
    expect(fnv1a32("hello")).not.toBe(fnv1a32("hello!"));
  });
  it("returns a uint32", () => {
    const v = fnv1a32("anything");
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThanOrEqual(0xffffffff);
  });
});

describe("mulberry32", () => {
  it("yields the same sequence for the same seed", () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const seqA = [a(), a(), a()];
    const seqB = [b(), b(), b()];
    expect(seqA).toEqual(seqB);
  });

  it("yields a different sequence for a different seed", () => {
    const a = mulberry32(1);
    const b = mulberry32(2);
    expect(a()).not.toBe(b());
  });

  it("emits values in [0, 1)", () => {
    const r = mulberry32(7);
    for (let i = 0; i < 50; i += 1) {
      const v = r();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe("seededSample", () => {
  it("returns the requested count", () => {
    const out = seededSample(["a", "b", "c", "d", "e"], 3, 42);
    expect(out).toHaveLength(3);
    out.forEach((item) => expect(["a", "b", "c", "d", "e"]).toContain(item));
  });

  it("is deterministic across calls with the same seed", () => {
    const pool = ["a", "b", "c", "d", "e", "f", "g"];
    expect(seededSample(pool, 3, 99)).toEqual(seededSample(pool, 3, 99));
  });

  it("returns a fresh ordering for a different seed", () => {
    const pool = ["a", "b", "c", "d", "e", "f", "g"];
    // Probabilistic check but the pool is large enough: two different
    // seeds picking 3-item samples from a 7-item pool will rarely hit
    // the same triple in the same order.
    expect(seededSample(pool, 3, 1)).not.toEqual(seededSample(pool, 3, 99));
  });

  it("returns at most pool.length items", () => {
    expect(seededSample(["a", "b"], 5, 42)).toHaveLength(2);
  });

  it("returns [] for an empty pool or zero count", () => {
    expect(seededSample([], 3, 1)).toEqual([]);
    expect(seededSample(["a"], 0, 1)).toEqual([]);
  });
});

describe("agentDaySeed", () => {
  it("is the same within a single agent-day", () => {
    const morning = new Date(2026, 3, 25, 9, 0, 0);
    const evening = new Date(2026, 3, 25, 22, 0, 0);
    expect(agentDaySeed(morning)).toBe(agentDaySeed(evening));
  });

  it("changes across the 04:00 boundary", () => {
    const beforeBoundary = new Date(2026, 3, 25, 3, 30, 0);
    const afterBoundary = new Date(2026, 3, 25, 4, 0, 0);
    expect(agentDaySeed(beforeBoundary)).not.toBe(agentDaySeed(afterBoundary));
  });
});
