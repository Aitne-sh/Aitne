import { describe, it, expect } from "vitest";
import {
  computeProcessShares,
  computeCacheHitRate,
  computeAutonomousShare,
  computeAvgCostPerRun,
  formatShare,
} from "./today-drivers.logic";

describe("computeProcessShares", () => {
  it("ranks processes with share of today's total and per-run average", () => {
    const shares = computeProcessShares(
      [
        { event_type: "routine.fetch_window", total_cost: 0.8, session_count: 4 },
        { event_type: "message.dm", total_cost: 0.2, session_count: 1 },
      ],
      1.0,
    );
    expect(shares).toEqual([
      {
        eventType: "routine.fetch_window",
        totalCost: 0.8,
        sessionCount: 4,
        avgCost: 0.2,
        pct: 80,
      },
      {
        eventType: "message.dm",
        totalCost: 0.2,
        sessionCount: 1,
        avgCost: 0.2,
        pct: 20,
      },
    ]);
  });

  it("clamps shares to 100 when rows exceed a stale total", () => {
    const shares = computeProcessShares(
      [{ event_type: "message.dm", total_cost: 2.0, session_count: 1 }],
      1.0,
    );
    expect(shares[0]?.pct).toBe(100);
  });

  it("renders zero-width bars when today's total is zero", () => {
    const shares = computeProcessShares(
      [{ event_type: "message.dm", total_cost: 0, session_count: 2 }],
      0,
    );
    expect(shares[0]?.pct).toBe(0);
    expect(shares[0]?.avgCost).toBe(0);
  });

  it("guards the per-run average against a zero session count", () => {
    const shares = computeProcessShares(
      [{ event_type: "message.dm", total_cost: 0.5, session_count: 0 }],
      1.0,
    );
    expect(shares[0]?.avgCost).toBe(0);
  });
});

describe("computeCacheHitRate", () => {
  it("returns cache-read share of all input-side tokens", () => {
    const rate = computeCacheHitRate({
      input: 1000,
      output: 500,
      cacheRead: 8000,
      cacheCreation: 1000,
    });
    expect(rate).toBeCloseTo(0.8, 6);
  });

  it("ignores output tokens in the denominator", () => {
    const rate = computeCacheHitRate({
      input: 50,
      output: 999999,
      cacheRead: 50,
      cacheCreation: 0,
    });
    expect(rate).toBeCloseTo(0.5, 6);
  });

  it("returns null when no input-side tokens were recorded", () => {
    expect(
      computeCacheHitRate({ input: 0, output: 100, cacheRead: 0, cacheCreation: 0 }),
    ).toBeNull();
  });
});

describe("computeAutonomousShare", () => {
  it("returns the autonomous fraction of today's spend", () => {
    const share = computeAutonomousShare([
      { trigger: "autonomous", total_cost: 0.9, session_count: 3 },
      { trigger: "reactive", total_cost: 0.3, session_count: 1 },
    ]);
    expect(share).toBeCloseTo(0.75, 6);
  });

  it("counts unknown triggers toward the denominator only", () => {
    const share = computeAutonomousShare([
      { trigger: "autonomous", total_cost: 0.5, session_count: 1 },
      { trigger: "unknown", total_cost: 0.5, session_count: 1 },
    ]);
    expect(share).toBeCloseTo(0.5, 6);
  });

  it("returns null when nothing has spent money yet", () => {
    expect(computeAutonomousShare([])).toBeNull();
    expect(
      computeAutonomousShare([
        { trigger: "autonomous", total_cost: 0, session_count: 2 },
      ]),
    ).toBeNull();
  });
});

describe("computeAvgCostPerRun", () => {
  it("divides today's total by session count", () => {
    expect(computeAvgCostPerRun(1.2, 4)).toBeCloseTo(0.3, 6);
  });

  it("returns null for zero sessions", () => {
    expect(computeAvgCostPerRun(0, 0)).toBeNull();
  });
});

describe("formatShare", () => {
  it("formats a fraction as a rounded percent", () => {
    expect(formatShare(0.734)).toBe("73%");
    expect(formatShare(1)).toBe("100%");
    expect(formatShare(0)).toBe("0%");
  });

  it("renders an em dash when unavailable", () => {
    expect(formatShare(null)).toBe("—");
  });
});
