import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { applySchema } from "../../db/schema.js";
import type {
  ActionTypeStats,
  FetchWindowIntegrationStats,
  HourlyGateStats,
  LessonStoreUtilization,
  NotificationTypeStats,
  SelfPerformanceData,
  SelfPerformanceWindow,
  SelfTuningLedgerEntry,
} from "./self-performance-prep.js";
import {
  MAX_EVIDENCE_CHARS,
  MAX_RECOMMENDATIONS_PER_CYCLE,
  R1_FRESHNESS_NOTCHES,
  R1_KNOB,
  R3_CEILING_NOTCHES,
  R3_KNOB,
  R5_KNOB,
  R5_MIN_BYTES,
  SELF_TUNING_NOTIFICATION_TYPE,
  TUNING_PENDING_CYCLE_STATE_KEY,
  applyVerdictsToCycle,
  buildTuningRecommendations,
  createPendingTuningCycle,
  cycleIdForDate,
  gatherFailingRecurringSchedules,
  isKeyInCooldown,
  renderTuningRecommendationsBlock,
  stepDownNotch,
  stepUpNotch,
  type PendingTuningCycle,
  type TuningKnobValues,
  type TuningRecommenderInput,
} from "./tuning-recommender.js";
import { SELF_TUNING_LEDGER_PREFIX } from "./self-performance-prep.js";

const NOW = new Date("2026-06-09T12:00:00.000Z");

function emptyGate(): HourlyGateStats {
  return {
    ticks: 0,
    stage0: 0,
    stage2: 0,
    stage3: 0,
    stage3LowSignal: 0,
    stage3LowSignalLowNovelty: 0,
  };
}

function emptyWindow(): SelfPerformanceWindow {
  return { actions: [], fetchWindow: [], gate: emptyGate(), notifications: [] };
}

function makeData(over: {
  current?: Partial<SelfPerformanceWindow>;
  baseline?: Partial<SelfPerformanceWindow>;
  ledger?: SelfTuningLedgerEntry[];
} = {}): SelfPerformanceData {
  return {
    windowDays: 7,
    current: { ...emptyWindow(), ...over.current },
    baseline: { ...emptyWindow(), ...over.baseline },
    ledger: over.ledger ?? [],
  };
}

function action(
  over: Partial<ActionTypeStats> & { actionType: string },
): ActionTypeStats {
  return {
    runs: 1,
    success: 1,
    partial: 0,
    failed: 0,
    skipped: 0,
    costUsd: 0,
    p50DurationMs: null,
    ...over,
  };
}

function integration(
  over: Partial<FetchWindowIntegrationStats> & { integrationKey: string },
): FetchWindowIntegrationStats {
  return { runs: 1, empty: 0, ...over };
}

function notification(
  over: Partial<NotificationTypeStats> & { notificationType: string },
): NotificationTypeStats {
  return {
    sent: 1,
    replied: 0,
    acted: 0,
    corrected: 0,
    ignored: 0,
    pending: 1,
    ...over,
  };
}

function store(
  over: Partial<LessonStoreUtilization> & { scope: string },
): LessonStoreUtilization {
  return { bytes: 100, capBytes: 8192, entries: 1, medianEv: 1, ...over };
}

const DEFAULT_KNOBS: TuningKnobValues = {
  activityScanPrePassFreshnessMinutes: 240,
  activityScanLowSignalPendingCeiling: 0,
  feedbackLessonMaxBytesGlobal: 8192,
};

function recommend(
  over: Partial<TuningRecommenderInput> & { data?: SelfPerformanceData } = {},
) {
  return buildTuningRecommendations({
    data: over.data ?? makeData(),
    knobs: over.knobs ?? DEFAULT_KNOBS,
    lessonStores: over.lessonStores,
    failingSchedules: over.failingSchedules,
    now: over.now ?? NOW,
  });
}

describe("tuning-recommender", () => {
  describe("cycleIdForDate", () => {
    it("uses the UTC date of the generating run", () => {
      expect(cycleIdForDate(NOW)).toBe("2026-06-09");
    });
  });

  describe("notch steppers", () => {
    it("steps up to the smallest notch above current", () => {
      expect(stepUpNotch(R1_FRESHNESS_NOTCHES, 30)).toBe(120);
      expect(stepUpNotch(R1_FRESHNESS_NOTCHES, 240)).toBe(360);
      expect(stepUpNotch(R1_FRESHNESS_NOTCHES, 360)).toBe(480);
    });

    it("returns null at or above the cap", () => {
      expect(stepUpNotch(R1_FRESHNESS_NOTCHES, 480)).toBeNull();
      expect(stepUpNotch(R1_FRESHNESS_NOTCHES, 600)).toBeNull();
    });

    it("steps down to the largest notch below current", () => {
      expect(stepDownNotch(R1_FRESHNESS_NOTCHES, 480)).toBe(360);
      expect(stepDownNotch(R1_FRESHNESS_NOTCHES, 240)).toBe(120);
    });

    it("returns null at or below the floor", () => {
      expect(stepDownNotch(R1_FRESHNESS_NOTCHES, 120)).toBeNull();
      expect(stepDownNotch(R1_FRESHNESS_NOTCHES, 30)).toBeNull();
    });
  });

  describe("isKeyInCooldown", () => {
    const ledgerEntry = (
      over: Partial<SelfTuningLedgerEntry> & { key: string },
    ): SelfTuningLedgerEntry => ({
      prev: 30,
      appliedAt: null,
      rule: "R1",
      ...over,
    });

    it("is false when the ledger has no entry for the key", () => {
      expect(
        isKeyInCooldown([ledgerEntry({ key: "other" })], R1_KNOB, NOW),
      ).toBe(false);
    });

    it("blocks a key applied within the 14-day hysteresis window", () => {
      const ledger = [
        ledgerEntry({ key: R1_KNOB, appliedAt: "2026-06-01T00:00:00.000Z" }),
      ];
      expect(isKeyInCooldown(ledger, R1_KNOB, NOW)).toBe(true);
    });

    it("unblocks a key applied more than 14 days ago", () => {
      const ledger = [
        ledgerEntry({ key: R1_KNOB, appliedAt: "2026-05-01T00:00:00.000Z" }),
      ];
      expect(isKeyInCooldown(ledger, R1_KNOB, NOW)).toBe(false);
    });

    it("parses SQLite-format timestamps as UTC", () => {
      const ledger = [
        ledgerEntry({ key: R1_KNOB, appliedAt: "2026-06-08 00:00:00" }),
      ];
      expect(isKeyInCooldown(ledger, R1_KNOB, NOW)).toBe(true);
    });

    it("blocks conservatively when applied_at is unparseable", () => {
      const ledger = [ledgerEntry({ key: R1_KNOB, appliedAt: "not-a-date" })];
      expect(isKeyInCooldown(ledger, R1_KNOB, NOW)).toBe(true);
    });

    it("blocks conservatively when applied_at is absent", () => {
      const ledger = [ledgerEntry({ key: R1_KNOB, appliedAt: null })];
      expect(isKeyInCooldown(ledger, R1_KNOB, NOW)).toBe(true);
    });

    it("applies the extended 28-day cool-down after a revert", () => {
      const ledger = [
        ledgerEntry({
          key: R1_KNOB,
          appliedAt: "2026-05-01T00:00:00.000Z",
          revertedAt: "2026-05-20T00:00:00.000Z",
        }),
      ];
      expect(isKeyInCooldown(ledger, R1_KNOB, NOW)).toBe(true);
    });

    it("unblocks once the revert cool-down has elapsed", () => {
      const ledger = [
        ledgerEntry({
          key: R1_KNOB,
          // Applied recently would block — but the revert path takes
          // precedence (the apply that preceded an old revert is older
          // still in real ledgers; the precedence is what's under test).
          appliedAt: "2026-06-08T00:00:00.000Z",
          revertedAt: "2026-05-01T00:00:00.000Z",
        }),
      ];
      expect(isKeyInCooldown(ledger, R1_KNOB, NOW)).toBe(false);
    });
  });

  describe("R1 — pre-pass freshness", () => {
    const emptyMail = (runs: number, empty: number) =>
      makeData({
        current: {
          fetchWindow: [integration({ integrationKey: "gmail", runs, empty })],
          actions: [
            action({
              actionType: "routine.fetch_window",
              runs,
              costUsd: runs * 0.02,
            }),
          ],
        },
      });

    it("steps freshness up one notch when the 14d aggregate empty-rate exceeds 70%", () => {
      const recs = recommend({ data: emptyMail(20, 16) });
      expect(recs).toHaveLength(1);
      const rec = recs[0];
      expect(rec.rule).toBe("R1");
      expect(rec.actuator).toBe("config");
      expect(rec.key).toBe(R1_KNOB);
      expect(rec.currentValue).toBe(240);
      expect(rec.proposedValue).toBe(360);
      expect(rec.bounds).toEqual({ min: 120, max: 480 });
      expect(rec.id).toBe(`2026-06-09:R1:${R1_KNOB}`);
      expect(rec.evidence).toContain("80% empty over 20 runs/14d");
      expect(rec.evidence).toContain("worst: gmail 80%");
      expect(rec.evidence).toContain("raise freshness");
      // 16 empty × 0.5 reachable × $0.02 avg × 0.5 heuristic = 0.08
      expect(rec.estWeeklySavingUsd).toBeCloseTo(0.08, 4);
    });

    it("combines current and baseline windows into the 14d aggregate", () => {
      const data = makeData({
        current: {
          fetchWindow: [
            integration({ integrationKey: "gmail", runs: 6, empty: 5 }),
          ],
        },
        baseline: {
          fetchWindow: [
            integration({ integrationKey: "gmail", runs: 6, empty: 5 }),
          ],
        },
      });
      const recs = recommend({ data });
      expect(recs).toHaveLength(1);
      expect(recs[0].evidence).toContain("83% empty over 12 runs/14d");
    });

    it("steps down (ranked $0) when the empty-rate is below 20%", () => {
      const recs = recommend({ data: emptyMail(20, 2) });
      expect(recs).toHaveLength(1);
      expect(recs[0].proposedValue).toBe(120);
      expect(recs[0].evidence).toContain("lower freshness");
      expect(recs[0].estWeeklySavingUsd).toBe(0);
    });

    it("stays silent in the 20–70% hysteresis band", () => {
      expect(recommend({ data: emptyMail(20, 10) })).toEqual([]);
    });

    it("ignores integrations below the minimum sample size", () => {
      const data = makeData({
        current: {
          fetchWindow: [
            integration({ integrationKey: "gmail", runs: 9, empty: 9 }),
          ],
        },
      });
      expect(recommend({ data })).toEqual([]);
    });

    it("does not step past the 480 cap", () => {
      const recs = recommend({
        data: emptyMail(20, 16),
        knobs: { ...DEFAULT_KNOBS, activityScanPrePassFreshnessMinutes: 480 },
      });
      expect(recs).toEqual([]);
    });

    it("does not step below the 120 floor", () => {
      const recs = recommend({
        data: emptyMail(20, 2),
        knobs: { ...DEFAULT_KNOBS, activityScanPrePassFreshnessMinutes: 120 },
      });
      expect(recs).toEqual([]);
    });

    it("cites the worst integration even when another dominates run counts", () => {
      const data = makeData({
        current: {
          fetchWindow: [
            integration({ integrationKey: "gmail", runs: 30, empty: 22 }),
            integration({ integrationKey: "notion", runs: 10, empty: 10 }),
          ],
        },
      });
      const recs = recommend({ data });
      expect(recs).toHaveLength(1);
      expect(recs[0].evidence).toContain("worst: notion 100%");
    });

    it("breaks an equal-rate tie alphabetically when picking the worst integration", () => {
      const data = makeData({
        current: {
          fetchWindow: [
            integration({ integrationKey: "notion", runs: 10, empty: 10 }),
            integration({ integrationKey: "gmail", runs: 10, empty: 10 }),
          ],
        },
      });
      const recs = recommend({ data });
      expect(recs[0].evidence).toContain("worst: gmail 100%");
    });
  });

  describe("R2 — notification throttle (lesson-mediated)", () => {
    it("proposes demoting a type ignored more than 60% of the time", () => {
      const data = makeData({
        current: {
          notifications: [
            notification({ notificationType: "reminder", sent: 4, ignored: 3 }),
          ],
        },
        baseline: {
          notifications: [
            notification({ notificationType: "reminder", sent: 4, ignored: 3 }),
          ],
        },
      });
      const recs = recommend({ data });
      expect(recs).toHaveLength(1);
      const rec = recs[0];
      expect(rec.rule).toBe("R2");
      expect(rec.actuator).toBe("lesson");
      expect(rec.key).toBe("notification:reminder");
      expect(rec.currentValue).toBe("send");
      expect(rec.bounds).toBeNull();
      expect(rec.evidence).toBe("reminder: 6/8 ignored (75%) over 14d");
      expect(rec.estWeeklySavingUsd).toBe(0);
    });

    it("requires the minimum sent sample", () => {
      const data = makeData({
        current: {
          notifications: [
            notification({ notificationType: "reminder", sent: 4, ignored: 4 }),
          ],
        },
      });
      expect(recommend({ data })).toEqual([]);
    });

    it("stays silent at or below the 60% ignored-rate threshold", () => {
      const data = makeData({
        current: {
          notifications: [
            notification({ notificationType: "reminder", sent: 10, ignored: 6 }),
          ],
        },
      });
      expect(recommend({ data })).toEqual([]);
    });

    it("never proposes demoting the loop's own mandatory DM channel", () => {
      // Apply / auto-revert notices land in notification_log under
      // SELF_TUNING_NOTIFICATION_TYPE; an owner who lets them sit unreacted
      // must not have R2 recommend silencing the D1/D6 safety channel.
      const data = makeData({
        current: {
          notifications: [
            notification({
              notificationType: SELF_TUNING_NOTIFICATION_TYPE,
              sent: 10,
              ignored: 10,
            }),
          ],
        },
      });
      expect(recommend({ data })).toEqual([]);
    });
  });

  describe("R3 — hourly-gate tightening", () => {
    const gateData = (over: Partial<HourlyGateStats>) =>
      makeData({
        current: {
          gate: { ...emptyGate(), ...over },
          actions: [
            action({
              actionType: "routine.activity_scan",
              runs: 10,
              costUsd: 1.0,
            }),
          ],
        },
      });

    it("steps the low-signal ceiling up when low-novelty fallback escalations dominate", () => {
      const recs = recommend({
        data: gateData({
          ticks: 50,
          stage3: 6,
          stage3LowSignal: 5,
          stage3LowSignalLowNovelty: 4,
        }),
      });
      expect(recs).toHaveLength(1);
      const rec = recs[0];
      expect(rec.rule).toBe("R3");
      expect(rec.key).toBe(R3_KNOB);
      expect(rec.currentValue).toBe(0);
      expect(rec.proposedValue).toBe(2);
      expect(rec.bounds).toEqual({ min: 0, max: 8 });
      expect(rec.evidence).toBe(
        "4/6 stage3 escalations were low_signal_default with novelty<=1 over 14d",
      );
      // 4 waste escalations / 2 weeks × $0.10 avg per hourly run
      expect(rec.estWeeklySavingUsd).toBeCloseTo(0.2, 4);
    });

    it("requires the minimum stage-3 sample", () => {
      const recs = recommend({
        data: gateData({
          stage3: 3,
          stage3LowSignal: 3,
          stage3LowSignalLowNovelty: 3,
        }),
      });
      expect(recs).toEqual([]);
    });

    it("stays silent at or below the 50% share", () => {
      const recs = recommend({
        data: gateData({
          stage3: 8,
          stage3LowSignal: 4,
          stage3LowSignalLowNovelty: 4,
        }),
      });
      expect(recs).toEqual([]);
    });

    it("does not step past the conservative ladder cap", () => {
      const recs = recommend({
        data: gateData({
          stage3: 6,
          stage3LowSignal: 5,
          stage3LowSignalLowNovelty: 4,
        }),
        knobs: {
          ...DEFAULT_KNOBS,
          activityScanLowSignalPendingCeiling:
            R3_CEILING_NOTCHES[R3_CEILING_NOTCHES.length - 1],
        },
      });
      expect(recs).toEqual([]);
    });
  });

  describe("R4 — schedule hygiene", () => {
    it("proposes disabling each failing recurring schedule", () => {
      const recs = recommend({
        failingSchedules: [
          {
            id: 7,
            taskType: "agent.task",
            description: "Nightly repo sweep",
            lastFailures: 3,
          },
        ],
      });
      expect(recs).toHaveLength(1);
      const rec = recs[0];
      expect(rec.rule).toBe("R4");
      expect(rec.actuator).toBe("schedule");
      expect(rec.key).toBe("recurring_schedules:7");
      expect(rec.currentValue).toBe("enabled");
      expect(rec.proposedValue).toBe("disabled");
      expect(rec.evidence).toBe(
        "last 3 runs failed (task_type=agent.task, Nightly repo sweep)",
      );
    });

    it("omits the description clause when the row has none", () => {
      const recs = recommend({
        failingSchedules: [
          { id: 2, taskType: "agent.dm_task", description: null, lastFailures: 3 },
        ],
      });
      expect(recs[0].evidence).toBe("last 3 runs failed (task_type=agent.dm_task)");
    });

    it("truncates an over-long evidence line, never silently overflowing", () => {
      const recs = recommend({
        failingSchedules: [
          {
            id: 3,
            taskType: "agent.task",
            description: "x".repeat(400),
            lastFailures: 3,
          },
        ],
      });
      expect(recs[0].evidence.length).toBeLessThanOrEqual(MAX_EVIDENCE_CHARS);
      expect(recs[0].evidence.endsWith("…")).toBe(true);
    });
  });

  describe("R5 — lesson-store byte budget", () => {
    const pressured = (over: Partial<LessonStoreUtilization> = {}) => [
      store({ scope: "agent", bytes: 7600, capBytes: 8192, medianEv: 1, entries: 38, ...over }),
    ];

    it("proposes a 25% step-down when the global store is >90% full with median ev<=1", () => {
      const recs = recommend({ lessonStores: pressured() });
      expect(recs).toHaveLength(1);
      const rec = recs[0];
      expect(rec.rule).toBe("R5");
      expect(rec.key).toBe(R5_KNOB);
      expect(rec.currentValue).toBe(8192);
      expect(rec.proposedValue).toBe(6144);
      expect(rec.bounds).toEqual({ min: R5_MIN_BYTES, max: 8192 });
      expect(rec.evidence).toBe(
        "agent lesson store at 93% of cap with median ev=1 (38 entries)",
      );
    });

    it("rounds the step-down to a 1 KiB multiple on non-default caps", () => {
      const recs = recommend({
        lessonStores: [
          store({ scope: "agent", bytes: 31000, capBytes: 32768, medianEv: 0 }),
        ],
        knobs: { ...DEFAULT_KNOBS, feedbackLessonMaxBytesGlobal: 32768 },
      });
      expect(recs[0].proposedValue).toBe(24576);
    });

    it("never proposes below the floor", () => {
      const recs = recommend({
        lessonStores: [
          store({ scope: "agent", bytes: 4000, capBytes: 4096, medianEv: 1 }),
        ],
        knobs: { ...DEFAULT_KNOBS, feedbackLessonMaxBytesGlobal: 4096 },
      });
      expect(recs).toEqual([]);
    });

    it("ignores per-agent stores — only the global scope feeds R5", () => {
      const recs = recommend({
        lessonStores: [
          store({ scope: "agent:writer", bytes: 4000, capBytes: 4096, medianEv: 0 }),
        ],
      });
      expect(recs).toEqual([]);
    });

    it.each([
      ["utilization at/below 90%", pressured({ bytes: 7000 })],
      ["median ev above 1", pressured({ medianEv: 2 })],
      ["empty store (median null)", pressured({ medianEv: null })],
      ["zero cap", pressured({ capBytes: 0 })],
    ])("stays silent on %s", (_label, lessonStores) => {
      expect(recommend({ lessonStores })).toEqual([]);
    });
  });

  describe("guards — hysteresis, ranking, max 3", () => {
    it("drops a recommendation whose key is in cool-down", () => {
      const data = makeData({
        current: {
          fetchWindow: [
            integration({ integrationKey: "gmail", runs: 20, empty: 16 }),
          ],
        },
        ledger: [
          {
            key: R1_KNOB,
            prev: 30,
            appliedAt: "2026-06-05T00:00:00.000Z",
            rule: "R1",
          },
        ],
      });
      expect(recommend({ data })).toEqual([]);
    });

    it("caps the cycle at 3 recommendations ranked by estimated $ impact", () => {
      const data = makeData({
        current: {
          // R1: 80% empty, est > 0.
          fetchWindow: [
            integration({ integrationKey: "gmail", runs: 20, empty: 16 }),
          ],
          actions: [
            action({
              actionType: "routine.fetch_window",
              runs: 20,
              costUsd: 0.4,
            }),
          ],
          // Two R2 candidates (est 0).
          notifications: [
            notification({ notificationType: "b-type", sent: 10, ignored: 9 }),
            notification({ notificationType: "a-type", sent: 10, ignored: 9 }),
          ],
        },
      });
      const recs = recommend({
        data,
        failingSchedules: [
          { id: 1, taskType: "agent.task", description: null, lastFailures: 3 },
        ],
      });
      expect(recs).toHaveLength(MAX_RECOMMENDATIONS_PER_CYCLE);
      // R1 leads on $; the zero-$ tie breaks by rule order (R2 < R4), then key.
      expect(recs.map((r) => r.rule)).toEqual(["R1", "R2", "R2"]);
      expect(recs[1].key).toBe("notification:a-type");
      expect(recs[2].key).toBe("notification:b-type");
    });
  });

  describe("createPendingTuningCycle", () => {
    it("wraps recommendations with the cycle id derived from generatedAt", () => {
      const recs = recommend({
        failingSchedules: [
          { id: 1, taskType: "agent.task", description: null, lastFailures: 3 },
        ],
      });
      const cycle = createPendingTuningCycle(recs, NOW.toISOString());
      expect(cycle).toEqual({
        cycleId: "2026-06-09",
        generatedAt: "2026-06-09T12:00:00.000Z",
        recommendations: recs,
        verdicts: {},
      });
    });

    // Same-day regeneration (weekly re-run via `!run` / crash retry) keeps
    // the same cycle id and — for rules still firing — the same ids, so
    // recorded verdicts must survive the overwrite: an empty map would
    // reopen judged ids and the re-run's re-POST would double-post the
    // rejection self_critique signals the route's idempotency prevents.
    it("carries same-day verdicts forward for ids the regenerated set still contains", () => {
      const recs = recommend({
        failingSchedules: [
          { id: 1, taskType: "agent.task", description: null, lastFailures: 3 },
        ],
      });
      const judged = applyVerdictsToCycle(
        createPendingTuningCycle(recs, NOW.toISOString()),
        [{ id: recs[0].id, verdict: "reject", reason: "integration was down" }],
        "2026-06-09T13:00:00.000Z",
      ).cycle;

      const regenerated = createPendingTuningCycle(
        recs,
        "2026-06-09T18:00:00.000Z",
        judged,
      );
      expect(regenerated.verdicts).toEqual(judged.verdicts);
    });

    it("drops carried verdicts for ids the regenerated set no longer contains", () => {
      const recs = recommend({
        failingSchedules: [
          { id: 1, taskType: "agent.task", description: null, lastFailures: 3 },
        ],
      });
      const judged = applyVerdictsToCycle(
        createPendingTuningCycle(recs, NOW.toISOString()),
        [{ id: recs[0].id, verdict: "apply", reason: "schedule is dead weight" }],
        "2026-06-09T13:00:00.000Z",
      ).cycle;

      // The failing streak healed between runs — the regenerated cycle is
      // empty, so the stale verdict's evidence is gone with its id.
      const regenerated = createPendingTuningCycle(
        [],
        "2026-06-09T18:00:00.000Z",
        judged,
      );
      expect(regenerated.verdicts).toEqual({});
    });

    it("starts clean across days — §3.4 expiry, no cross-cycle carry", () => {
      const recs = recommend({
        failingSchedules: [
          { id: 1, taskType: "agent.task", description: null, lastFailures: 3 },
        ],
      });
      const judged = applyVerdictsToCycle(
        createPendingTuningCycle(recs, NOW.toISOString()),
        [{ id: recs[0].id, verdict: "defer", reason: "one more week" }],
        "2026-06-09T13:00:00.000Z",
      ).cycle;

      const nextWeek = createPendingTuningCycle(
        recommend({
          failingSchedules: [
            { id: 1, taskType: "agent.task", description: null, lastFailures: 3 },
          ],
          now: new Date("2026-06-16T12:00:00.000Z"),
        }),
        "2026-06-16T12:00:00.000Z",
        judged,
      );
      expect(nextWeek.cycleId).toBe("2026-06-16");
      expect(nextWeek.verdicts).toEqual({});
    });

    it("tolerates a previous blob without a verdicts map (hand-edited runtime_state)", () => {
      const recs = recommend({
        failingSchedules: [
          { id: 1, taskType: "agent.task", description: null, lastFailures: 3 },
        ],
      });
      const malformed = {
        cycleId: "2026-06-09",
        generatedAt: "2026-06-09T05:00:00.000Z",
        recommendations: recs,
      } as unknown as PendingTuningCycle;
      const regenerated = createPendingTuningCycle(
        recs,
        NOW.toISOString(),
        malformed,
      );
      expect(regenerated.verdicts).toEqual({});
    });
  });

  describe("renderTuningRecommendationsBlock", () => {
    it("returns null for an empty cycle — zero bytes in the prompt", () => {
      const cycle = createPendingTuningCycle([], NOW.toISOString());
      expect(renderTuningRecommendationsBlock(cycle)).toBeNull();
    });

    it("renders one <r> row per recommendation with bounds and est attrs", () => {
      const data = makeData({
        current: {
          fetchWindow: [
            integration({ integrationKey: "gmail", runs: 20, empty: 16 }),
          ],
          actions: [
            action({ actionType: "routine.fetch_window", runs: 20, costUsd: 0.4 }),
          ],
        },
      });
      const cycle = createPendingTuningCycle(recommend({ data }), NOW.toISOString());
      const block = renderTuningRecommendationsBlock(cycle);
      expect(block).toContain(
        '<tuning_recommendations cycle="2026-06-09" count="1" mode="shadow" verdict_endpoint="POST /api/tuning/verdicts">',
      );
      expect(block).toContain(`<r id="2026-06-09:R1:${R1_KNOB}" rule="R1"`);
      expect(block).toContain('current="240" proposed="360" bounds="120..480"');
      expect(block).toContain('est_usd_wk="0.08"');
      expect(block).toContain("</tuning_recommendations>");
    });

    it("omits bounds/est attrs when absent and escapes XML metacharacters", () => {
      const cycle = createPendingTuningCycle(
        recommend({
          failingSchedules: [
            {
              id: 5,
              taskType: "agent.task",
              description: 'check <feed> & "deploy"',
              lastFailures: 3,
            },
          ],
        }),
        NOW.toISOString(),
      );
      const block = renderTuningRecommendationsBlock(cycle);
      expect(block).not.toContain("bounds=");
      expect(block).not.toContain("est_usd_wk=");
      expect(block).toContain("&lt;feed&gt; &amp; &quot;deploy&quot;");
    });

    it("annotates carried-forward verdicts so a same-day re-run skips judged rows", () => {
      const data = makeData({
        current: {
          fetchWindow: [
            integration({ integrationKey: "gmail", runs: 20, empty: 16 }),
          ],
          actions: [
            action({ actionType: "routine.fetch_window", runs: 20, costUsd: 0.4 }),
          ],
        },
      });
      const cycle = createPendingTuningCycle(
        [
          ...recommend({ data }),
          ...recommend({
            failingSchedules: [
              { id: 5, taskType: "agent.task", description: null, lastFailures: 3 },
            ],
          }),
        ],
        NOW.toISOString(),
      );
      const { cycle: judged } = applyVerdictsToCycle(
        cycle,
        [
          {
            id: `2026-06-09:R1:${R1_KNOB}`,
            verdict: "reject",
            reason: "travel week",
          },
        ],
        NOW.toISOString(),
      );
      const block = renderTuningRecommendationsBlock(judged)!;
      expect(block).toContain(
        `<r id="2026-06-09:R1:${R1_KNOB}" rule="R1"`,
      );
      // The judged row carries its verdict; the unjudged row does not.
      const rows = block.split("\n").filter((line) => line.includes("<r "));
      expect(rows.find((line) => line.includes(":R1:"))).toContain(
        'verdict="reject"',
      );
      expect(rows.find((line) => line.includes(":R4:"))).not.toContain(
        "verdict=",
      );
    });

    it("renders mode='live' when the Phase 3 actuation flag is on", () => {
      const cycle = createPendingTuningCycle(
        recommend({
          failingSchedules: [
            { id: 5, taskType: "agent.task", description: null, lastFailures: 3 },
          ],
        }),
        NOW.toISOString(),
      );
      const live = renderTuningRecommendationsBlock(cycle, { mode: "live" });
      expect(live).toContain('mode="live"');
      // Default stays shadow — the safe direction for older call sites.
      const fallback = renderTuningRecommendationsBlock(cycle, {});
      expect(fallback).toContain('mode="shadow"');
    });
  });

  describe("applyVerdictsToCycle", () => {
    const cycleWithRec = (): PendingTuningCycle =>
      createPendingTuningCycle(
        recommend({
          failingSchedules: [
            { id: 1, taskType: "agent.task", description: null, lastFailures: 3 },
          ],
        }),
        NOW.toISOString(),
      );
    const REC_ID = "2026-06-09:R4:recurring_schedules:1";

    it("records a first verdict", () => {
      const { cycle, results } = applyVerdictsToCycle(
        cycleWithRec(),
        [{ id: REC_ID, verdict: "apply", reason: "evidence checks out" }],
        "2026-06-09T13:00:00.000Z",
      );
      expect(results).toEqual([{ id: REC_ID, status: "recorded" }]);
      expect(cycle.verdicts[REC_ID]).toEqual({
        verdict: "apply",
        reason: "evidence checks out",
        recordedAt: "2026-06-09T13:00:00.000Z",
      });
    });

    it("treats a retried identical verdict as an idempotent duplicate", () => {
      const first = applyVerdictsToCycle(
        cycleWithRec(),
        [{ id: REC_ID, verdict: "reject", reason: "integration was down" }],
        "2026-06-09T13:00:00.000Z",
      );
      const second = applyVerdictsToCycle(
        first.cycle,
        [{ id: REC_ID, verdict: "reject", reason: "retry" }],
        "2026-06-09T13:05:00.000Z",
      );
      expect(second.results).toEqual([{ id: REC_ID, status: "duplicate" }]);
      // First verdict wins — reason and timestamp are unchanged.
      expect(second.cycle.verdicts[REC_ID].reason).toBe("integration was down");
    });

    it("keeps the first verdict on conflict", () => {
      const first = applyVerdictsToCycle(
        cycleWithRec(),
        [{ id: REC_ID, verdict: "defer", reason: "one more week" }],
        "2026-06-09T13:00:00.000Z",
      );
      const second = applyVerdictsToCycle(
        first.cycle,
        [{ id: REC_ID, verdict: "apply", reason: "changed my mind" }],
        "2026-06-09T13:05:00.000Z",
      );
      expect(second.results).toEqual([{ id: REC_ID, status: "conflict" }]);
      expect(second.cycle.verdicts[REC_ID].verdict).toBe("defer");
    });

    it("throws on an id the cycle never generated — route-level validation contract", () => {
      expect(() =>
        applyVerdictsToCycle(
          cycleWithRec(),
          [{ id: "2026-06-09:R1:made-up", verdict: "apply", reason: "x" }],
          "2026-06-09T13:00:00.000Z",
        ),
      ).toThrow(/Unknown recommendation id/);
    });
  });

  describe("gatherFailingRecurringSchedules", () => {
    function makeDb(): Database.Database {
      const db = new Database(":memory:");
      applySchema(db);
      return db;
    }

    function insertRecurring(
      db: Database.Database,
      over: { enabled?: number; description?: string | null } = {},
    ): number {
      const result = db
        .prepare(
          `INSERT INTO recurring_schedules
             (task_type, task_description, recurrence_rule, enabled)
           VALUES ('agent.task', ?, '{"frequency":"daily"}', ?)`,
        )
        .run(over.description ?? "Nightly sweep", over.enabled ?? 1);
      return Number(result.lastInsertRowid);
    }

    function insertRun(
      db: Database.Database,
      recurringId: number,
      status: string,
      scheduledFor: string,
    ): void {
      db.prepare(
        `INSERT INTO agent_schedule
           (scheduled_for, task_type, task_description, status, recurring_schedule_id)
         VALUES (?, 'agent.task', 'run', ?, ?)`,
      ).run(scheduledFor, status, recurringId);
    }

    it("returns enabled rows whose last 3 settled runs all failed", () => {
      const db = makeDb();
      const id = insertRecurring(db);
      insertRun(db, id, "completed", "2026-06-01 09:00:00");
      insertRun(db, id, "failed", "2026-06-05 09:00:00");
      insertRun(db, id, "failed", "2026-06-06 09:00:00");
      insertRun(db, id, "failed", "2026-06-07 09:00:00");
      // pending/running rows are not evidence and must not mask the streak
      insertRun(db, id, "pending", "2026-06-08 09:00:00");
      expect(gatherFailingRecurringSchedules(db)).toEqual([
        {
          id,
          taskType: "agent.task",
          description: "Nightly sweep",
          lastFailures: 3,
        },
      ]);
    });

    it("excludes rows with fewer than 3 settled runs", () => {
      const db = makeDb();
      const id = insertRecurring(db);
      insertRun(db, id, "failed", "2026-06-06 09:00:00");
      insertRun(db, id, "failed", "2026-06-07 09:00:00");
      expect(gatherFailingRecurringSchedules(db)).toEqual([]);
    });

    it("a recent success or skip breaks the streak", () => {
      const db = makeDb();
      const id = insertRecurring(db);
      insertRun(db, id, "failed", "2026-06-04 09:00:00");
      insertRun(db, id, "failed", "2026-06-05 09:00:00");
      insertRun(db, id, "failed", "2026-06-06 09:00:00");
      insertRun(db, id, "skipped", "2026-06-07 09:00:00");
      expect(gatherFailingRecurringSchedules(db)).toEqual([]);
    });

    it("ignores disabled rows", () => {
      const db = makeDb();
      const id = insertRecurring(db, { enabled: 0 });
      insertRun(db, id, "failed", "2026-06-05 09:00:00");
      insertRun(db, id, "failed", "2026-06-06 09:00:00");
      insertRun(db, id, "failed", "2026-06-07 09:00:00");
      expect(gatherFailingRecurringSchedules(db)).toEqual([]);
    });
  });

  describe("state key namespace", () => {
    it("does not collide with the Measure stage's ledger LIKE-prefix scan", () => {
      expect(
        TUNING_PENDING_CYCLE_STATE_KEY.startsWith(SELF_TUNING_LEDGER_PREFIX),
      ).toBe(false);
    });
  });
});
