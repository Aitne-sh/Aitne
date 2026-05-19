import { describe, it, expect } from "vitest";
import { computeHealthKpis } from "./health-kpis";
import type { MetricsDailyBucket, MetricsResponse } from "./api-types";

function bucket(
  overrides: Partial<MetricsDailyBucket> = {},
): MetricsDailyBucket {
  return {
    date: "2026-04-10",
    executions: 0,
    executionsReactive: 0,
    executionsAutonomous: 0,
    failures: 0,
    contextUpdatesAutonomous: 0,
    contextUpdatesReactive: 0,
    avgDurationMs: null,
    notificationsDelivered: 0,
    notificationsReacted: 0,
    ...overrides,
  };
}

function snapshot(
  overrides: Partial<MetricsResponse> = {},
): MetricsResponse {
  return {
    collectedAt: "2026-04-10T00:00:00Z",
    notificationConfirmRate: null,
    notificationCounts: { delivered: 0, reacted: 0, suppressed: 0 },
    advisorCallRate: null,
    proactiveForwardResume: {
      injected: 0,
      disavowed: 0,
      ratio: null,
      threshold: 0,
    },
    modelCounts: { sonnetSessions: 0, opusSessions: 0 },
    responseTime: { p50: null, p90: null, p95: null, p99: null, avg: null },
    cost: { todayUsd: 0, last7dUsd: 0, last30dUsd: 0 },
    sessions: { todayTotal: 0, todayAutonomous: 0, todayReactive: 0 },
    ...overrides,
  };
}

describe("computeHealthKpis", () => {
  it("Success Rate sparkline: zero-exec days map to null, not 1", () => {
    const daily = [
      bucket({ executions: 0 }),
      bucket({ executions: 10, failures: 1 }),
    ];
    const [success] = computeHealthKpis(daily, 7, undefined);
    expect(success.sparkline).toEqual([null, 0.9]);
  });

  it("Errors sparkline: zero-exec days map to null, not 0", () => {
    const daily = [
      bucket({ executions: 0 }),
      bucket({ executions: 5, failures: 2 }),
    ];
    const [, errors] = computeHealthKpis(daily, 7, undefined);
    expect(errors.sparkline).toEqual([null, 2]);
  });

  it("Reaction Rate sparkline: zero-delivery days map to null, not 0", () => {
    const daily = [
      bucket({ notificationsDelivered: 0, notificationsReacted: 0 }),
      bucket({ notificationsDelivered: 4, notificationsReacted: 3 }),
    ];
    const [, , , reaction] = computeHealthKpis(daily, 7, undefined);
    expect(reaction.sparkline).toEqual([null, 0.75]);
  });

  it("successRate is null and level neutral when totalExec === 0", () => {
    const daily = [bucket({ executions: 0 })];
    const [success] = computeHealthKpis(daily, 7, undefined);
    expect(success.value).toBe("—");
    expect(success.subtitle).toBe("no data");
    expect(success.level).toBe("neutral");
  });

  it("errorsLevel is 'good' and subtitle is 'no failures' when totalFail === 0", () => {
    const daily = [bucket({ executions: 10, failures: 0 })];
    const [, errors] = computeHealthKpis(daily, 7, undefined);
    expect(errors.value).toBe("0");
    expect(errors.subtitle).toBe("no failures");
    expect(errors.level).toBe("good");
  });

  it("errorsLevel is 'warn' for 1..5 failures and 'crit' for >5", () => {
    const warn = computeHealthKpis(
      [bucket({ executions: 10, failures: 3 })],
      7,
      undefined,
    );
    expect(warn[1].level).toBe("warn");

    const crit = computeHealthKpis(
      [bucket({ executions: 10, failures: 6 })],
      7,
      undefined,
    );
    expect(crit[1].level).toBe("crit");
  });

  it("successLevel tracks 95% / 80% thresholds", () => {
    const good = computeHealthKpis(
      [bucket({ executions: 100, failures: 4 })],
      7,
      undefined,
    );
    expect(good[0].level).toBe("good");

    const warn = computeHealthKpis(
      [bucket({ executions: 100, failures: 10 })],
      7,
      undefined,
    );
    expect(warn[0].level).toBe("warn");

    const crit = computeHealthKpis(
      [bucket({ executions: 100, failures: 30 })],
      7,
      undefined,
    );
    expect(crit[0].level).toBe("crit");
  });

  it("Response P50/P95 card has no sparkline and uses snapshot headline", () => {
    const snap = snapshot({
      responseTime: {
        p50: 34_200,
        p90: 120_000,
        p95: 220_000,
        p99: 400_000,
        avg: 50_000,
      },
    });
    const [, , response] = computeHealthKpis([], 7, snap);
    expect(response.sparkline).toBeNull();
    expect(response.value).toBe("34.2s / 3m 40s");
    expect(response.subtitle).toBe("rolling 30d");
    expect(response.level).toBe("neutral");
  });

  it("Response card falls back to — when snapshot is undefined", () => {
    const [, , response] = computeHealthKpis([], 7, undefined);
    expect(response.value).toBe("—");
    expect(response.sparkline).toBeNull();
  });

  it("Reaction Rate uses snapshot.notificationConfirmRate and counts", () => {
    const snap = snapshot({
      notificationConfirmRate: 0.25,
      notificationCounts: { delivered: 40, reacted: 10, suppressed: 3 },
    });
    const [, , , reaction] = computeHealthKpis([], 30, snap);
    expect(reaction.value).toBe("25%");
    expect(reaction.subtitle).toBe("10 of 40 in 30d");
    expect(reaction.level).toBe("neutral");
  });

  it("Errors card title includes the days window", () => {
    const [, errors] = computeHealthKpis([], 30, undefined);
    expect(errors.title).toBe("Errors (30d)");
  });

  it("Today view (days=0) labels don't read as broken English", () => {
    const daily = [bucket({ executions: 5, failures: 2 })];
    const [, errors] = computeHealthKpis(daily, 0, undefined);
    expect(errors.title).toBe("Errors (today)");
    expect(errors.subtitle).toBe("today total");
  });

  it("Today view with zero failures still reads 'no failures'", () => {
    const daily = [bucket({ executions: 5, failures: 0 })];
    const [, errors] = computeHealthKpis(daily, 0, undefined);
    expect(errors.title).toBe("Errors (today)");
    expect(errors.subtitle).toBe("no failures");
  });

  it("Reaction Rate subtitle falls back to 'rolling 30d' when snapshot is undefined", () => {
    const [, , , reaction] = computeHealthKpis([], 7, undefined);
    // Must NOT say "0 of 0 in 30d" — that's indistinguishable from real zero
    // data. Previously leaked through.
    expect(reaction.subtitle).toBe("rolling 30d");
    expect(reaction.subtitle).not.toContain("0 of 0");
  });

  it("Reaction Rate subtitle shows counts when snapshot is defined, even if zero", () => {
    const snap = snapshot({
      notificationConfirmRate: null,
      notificationCounts: { delivered: 0, reacted: 0, suppressed: 0 },
    });
    const [, , , reaction] = computeHealthKpis([], 7, snap);
    // When snapshot IS loaded but there's genuinely no delivered notifs,
    // "0 of 0 in 30d" is the honest label.
    expect(reaction.subtitle).toBe("0 of 0 in 30d");
  });
});
