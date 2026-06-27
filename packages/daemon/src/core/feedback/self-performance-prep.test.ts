import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { applySchema } from "../../db/schema.js";
import {
  buildSelfPerformanceBlock,
  gatherSelfPerformanceData,
  summarizeLessonStoreUtilization,
  FETCH_WINDOW_ACTION_TYPE,
  ACTIVITY_SCAN_GATE_ACTION_TYPE,
  SELF_PERFORMANCE_MAX_BYTES,
  SELF_PERFORMANCE_WINDOW_DAYS,
  SELF_TUNING_LEDGER_PREFIX,
  type ActionTypeStats,
  type FetchWindowIntegrationStats,
  type HourlyGateStats,
  type LessonStoreUtilization,
  type NotificationTypeStats,
  type SelfPerformanceData,
  type SelfPerformanceWindow,
} from "./self-performance-prep.js";

const NOW = new Date("2026-06-09T12:00:00Z");
const IN_CURRENT = "2026-06-05 00:00:00";
const IN_BASELINE = "2026-05-28 00:00:00";
const BEFORE_BASELINE = "2026-05-01 00:00:00";

function makeDb(): Database.Database {
  const db = new Database(":memory:");
  applySchema(db);
  return db;
}

function insertAction(
  db: Database.Database,
  over: {
    actionType: string;
    result?: string | null;
    costUsd?: number | null;
    durationMs?: number | null;
    detail?: string | null;
    startedAt?: string;
  },
): void {
  db.prepare(
    `INSERT INTO agent_actions
       (action_type, result, cost_usd, duration_ms, detail, started_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    over.actionType,
    over.result ?? null,
    over.costUsd ?? null,
    over.durationMs ?? null,
    over.detail ?? null,
    over.startedAt ?? IN_CURRENT,
  );
}

function fetchDetail(prePass: Record<string, unknown> | unknown): string {
  return JSON.stringify({ prePass });
}

function gateDetail(detail: Record<string, unknown>): string {
  return JSON.stringify(detail);
}

function insertNotification(
  db: Database.Database,
  over: {
    type?: string | null;
    reaction?: string | null;
    status?: string | null;
    createdAt?: string;
  },
): void {
  db.prepare(
    `INSERT INTO notification_log
       (notification_type, user_reaction, status, created_at)
     VALUES (?, ?, ?, ?)`,
  ).run(
    over.type ?? null,
    over.reaction ?? null,
    over.status === undefined ? "delivered" : over.status,
    over.createdAt ?? IN_CURRENT,
  );
}

function insertLedger(
  db: Database.Database,
  key: string,
  valueJson: string,
  updatedAt: string,
): void {
  db.prepare(
    `INSERT INTO runtime_state (key, value_json, updated_at) VALUES (?, ?, ?)`,
  ).run(`${SELF_TUNING_LEDGER_PREFIX}${key}`, valueJson, updatedAt);
}

// ── Pure-data factories for the renderer tests ──────────────────────────────

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

function makeData(over: Partial<SelfPerformanceData> = {}): SelfPerformanceData {
  return {
    windowDays: 7,
    current: emptyWindow(),
    baseline: emptyWindow(),
    ledger: [],
    ...over,
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

const GENERATED_AT = "2026-06-09T12:00:00.000Z";

function build(
  data: SelfPerformanceData,
  opts: Partial<Parameters<typeof buildSelfPerformanceBlock>[1]> = {},
): string | null {
  return buildSelfPerformanceBlock(data, { generatedAt: GENERATED_AT, ...opts });
}

describe("self-performance-prep", () => {
  describe("gatherSelfPerformanceData — per-action_type aggregates", () => {
    it("returns empty windows and ledger on a fresh DB", () => {
      const db = makeDb();
      const data = gatherSelfPerformanceData(db, { now: NOW });
      expect(data.windowDays).toBe(SELF_PERFORMANCE_WINDOW_DAYS);
      expect(data.current).toEqual(emptyWindow());
      expect(data.baseline).toEqual(emptyWindow());
      expect(data.ledger).toEqual([]);
    });

    it("buckets results, sums cost, and computes p50 per action_type", () => {
      const db = makeDb();
      insertAction(db, {
        actionType: "message.dm",
        result: "success",
        costUsd: 0.5,
        durationMs: 100,
      });
      insertAction(db, {
        actionType: "message.dm",
        result: "partial",
        costUsd: 0.25,
        durationMs: 300,
      });
      insertAction(db, {
        actionType: "message.dm",
        result: "failed",
        costUsd: null,
        durationMs: 200,
      });
      insertAction(db, { actionType: "message.dm", result: "skipped" });
      // Transient / unsettled rows count toward runs only.
      insertAction(db, { actionType: "message.dm", result: "in_progress" });
      insertAction(db, { actionType: "message.dm", result: null });

      const { current } = gatherSelfPerformanceData(db, { now: NOW });
      expect(current.actions).toEqual([
        {
          actionType: "message.dm",
          runs: 6,
          success: 1,
          partial: 1,
          failed: 1,
          skipped: 1,
          costUsd: 0.75,
          p50DurationMs: 200, // odd count → exact middle of [100, 200, 300]
        },
      ]);
    });

    it("averages the two middle durations on even counts and rounds", () => {
      const db = makeDb();
      insertAction(db, { actionType: "a", result: "success", durationMs: 100 });
      insertAction(db, { actionType: "a", result: "success", durationMs: 101 });
      const { current } = gatherSelfPerformanceData(db, { now: NOW });
      expect(current.actions[0].p50DurationMs).toBe(101); // 100.5 rounds up
    });

    it("reports null p50 when no row carries a duration", () => {
      const db = makeDb();
      insertAction(db, { actionType: "a", result: "success" });
      const { current } = gatherSelfPerformanceData(db, { now: NOW });
      expect(current.actions[0].p50DurationMs).toBeNull();
    });

    it("splits rows into current / baseline windows and drops older rows", () => {
      const db = makeDb();
      insertAction(db, { actionType: "a", result: "success", startedAt: IN_CURRENT });
      insertAction(db, { actionType: "a", result: "failed", startedAt: IN_BASELINE });
      insertAction(db, { actionType: "a", result: "failed", startedAt: BEFORE_BASELINE });

      const data = gatherSelfPerformanceData(db, { now: NOW });
      expect(data.current.actions[0]).toMatchObject({ runs: 1, success: 1 });
      expect(data.baseline.actions[0]).toMatchObject({ runs: 1, failed: 1 });
    });

    it("honours a custom windowDays", () => {
      const db = makeDb();
      // 5 days ago: inside a 7d window but outside a 3d one.
      insertAction(db, { actionType: "a", result: "success", startedAt: "2026-06-04 12:00:00" });
      const data = gatherSelfPerformanceData(db, { now: NOW, windowDays: 3 });
      expect(data.windowDays).toBe(3);
      expect(data.current.actions).toEqual([]);
      // …it lands in the 3d baseline window [now-6d, now-3d) instead.
      expect(data.baseline.actions[0]).toMatchObject({ runs: 1 });
    });
  });

  describe("gatherSelfPerformanceData — fetch_window empty-run rate", () => {
    it("groups completed pre-pass attempts per integration and counts empties", () => {
      const db = makeDb();
      const fw = FETCH_WINDOW_ACTION_TYPE;
      insertAction(db, {
        actionType: fw,
        result: "success",
        detail: fetchDetail({ integrationKey: "gmail", status: "success", fetched: 0, posted: 0 }),
      });
      insertAction(db, {
        actionType: fw,
        result: "success",
        detail: fetchDetail({ integrationKey: "gmail", status: "partial", fetched: 3, posted: 2 }),
      });
      // Missing fetched/posted numbers default to 0 → counts as empty.
      insertAction(db, {
        actionType: fw,
        result: "success",
        detail: fetchDetail({ integrationKey: "gmail", status: "success", fetched: "3" }),
      });
      insertAction(db, {
        actionType: fw,
        result: "success",
        detail: fetchDetail({ integrationKey: "notion", status: "success", fetched: 1, posted: 1 }),
      });

      const { current } = gatherSelfPerformanceData(db, { now: NOW });
      expect(current.fetchWindow).toEqual([
        { integrationKey: "gmail", runs: 3, empty: 2 },
        { integrationKey: "notion", runs: 1, empty: 0 },
      ]);
    });

    it("skips failed/skipped attempts, malformed payloads, and non-prePass rows", () => {
      const db = makeDb();
      const fw = FETCH_WINDOW_ACTION_TYPE;
      insertAction(db, {
        actionType: fw,
        detail: fetchDetail({ integrationKey: "gmail", status: "failed", fetched: 0, posted: 0 }),
      });
      insertAction(db, {
        actionType: fw,
        detail: fetchDetail({ integrationKey: "gmail", status: "skipped" }),
      });
      // status missing entirely.
      insertAction(db, { actionType: fw, detail: fetchDetail({ integrationKey: "gmail" }) });
      // integrationKey not a string.
      insertAction(db, { actionType: fw, detail: fetchDetail({ integrationKey: 7, status: "success" }) });
      // prePass not an object / null.
      insertAction(db, { actionType: fw, detail: fetchDetail("nope") });
      insertAction(db, { actionType: fw, detail: fetchDetail(null) });
      // detail without prePass and non-object detail. (Corrupt JSON cannot
      // exist in agent_actions — the schema's JSON column rejects it on
      // insert; the parse-failure branch is reachable only via runtime_state.)
      insertAction(db, { actionType: fw, detail: JSON.stringify({ other: true }) });
      insertAction(db, { actionType: fw, detail: JSON.stringify("just a string") });

      const { current } = gatherSelfPerformanceData(db, { now: NOW });
      expect(current.fetchWindow).toEqual([]);
    });
  });

  describe("gatherSelfPerformanceData — hourly gate stage distribution", () => {
    it("counts ticks, stages, and the low-signal low-novelty stage-3 share", () => {
      const db = makeDb();
      const gate = ACTIVITY_SCAN_GATE_ACTION_TYPE;
      const snap = (maxNoveltyScore: unknown) => ({ maxNoveltyScore });
      insertAction(db, {
        actionType: gate,
        detail: gateDetail({ stage_reached: "stage0_silent", gate_reason: "no_signals" }),
      });
      // The writer's real silent-lite-triage spelling is the alias
      // `stage2_log_only` (logGateAuditRow overrides `stage_reached` with
      // the applied decision verbatim); a bare `stage2` never occurs in
      // production rows but is accepted defensively.
      insertAction(db, {
        actionType: gate,
        detail: gateDetail({ stage_reached: "stage2", gate_reason: "low_signal_default" }),
      });
      insertAction(db, {
        actionType: gate,
        detail: gateDetail({
          stage_reached: "stage2_log_only",
          gate_reason: "low_signal_default",
          stage2_verdict: "log_only",
        }),
      });
      // Min-observations-floor phantom: gate verdict stage3, but the run
      // was short-circuited (`result='skipped'`) — tick only, never an
      // escalation and never R3 waste evidence.
      insertAction(db, {
        actionType: gate,
        result: "skipped",
        detail: gateDetail({
          stage_reached: "stage3",
          gate_reason: "low_signal_default",
          signal_snapshot: snap(0),
        }),
      });
      // Forced tick (`!run` / run-now): a real stage3 run, but excluded
      // from the low-signal waste counters — it escalates at any signal.
      insertAction(db, {
        actionType: gate,
        result: "success",
        detail: gateDetail({
          stage_reached: "stage3",
          gate_reason: "low_signal_default",
          forced: true,
          signal_snapshot: snap(0),
        }),
      });
      // stage3 via low-signal fallback with novelty ≤ 1 → waste case.
      insertAction(db, {
        actionType: gate,
        detail: gateDetail({
          stage_reached: "stage3",
          gate_reason: "low_signal_default",
          signal_snapshot: snap(1),
        }),
      });
      // …with null novelty (counts as ≤ 1).
      insertAction(db, {
        actionType: gate,
        detail: gateDetail({
          stage_reached: "stage3",
          gate_reason: "low_signal_default",
          signal_snapshot: snap(null),
        }),
      });
      // …with a non-number novelty (defensive: counts as ≤ 1).
      insertAction(db, {
        actionType: gate,
        detail: gateDetail({
          stage_reached: "stage3",
          gate_reason: "low_signal_default",
          signal_snapshot: snap("high"),
        }),
      });
      // …with no snapshot at all (counts as ≤ 1).
      insertAction(db, {
        actionType: gate,
        detail: gateDetail({ stage_reached: "stage3", gate_reason: "low_signal_default" }),
      });
      // low-signal stage3 with real novelty 2 → NOT the waste case.
      insertAction(db, {
        actionType: gate,
        detail: gateDetail({
          stage_reached: "stage3",
          gate_reason: "low_signal_default",
          signal_snapshot: snap(2),
        }),
      });
      // legitimate stage3 (vip mail) — never in the low-signal buckets.
      insertAction(db, {
        actionType: gate,
        detail: gateDetail({
          stage_reached: "stage3",
          gate_reason: "vip_mail_unread",
          signal_snapshot: snap(1),
        }),
      });
      // unknown stage value → tick only; non-object / NULL detail → tick only.
      insertAction(db, { actionType: gate, detail: gateDetail({ stage_reached: "stage9" }) });
      insertAction(db, { actionType: gate, detail: JSON.stringify("tick-only") });
      insertAction(db, { actionType: gate, detail: null });

      const { current } = gatherSelfPerformanceData(db, { now: NOW });
      expect(current.gate).toEqual({
        ticks: 14,
        stage0: 1,
        stage2: 2,
        stage3: 7,
        stage3LowSignal: 5,
        stage3LowSignalLowNovelty: 4,
      });
    });
  });

  describe("gatherSelfPerformanceData — notification reactions", () => {
    it("breaks sent notifications down by reaction, with pending as remainder", () => {
      const db = makeDb();
      insertNotification(db, { type: "reminder", reaction: "replied" });
      insertNotification(db, { type: "reminder", reaction: "acted", status: "batched" });
      insertNotification(db, { type: "reminder", reaction: "corrected" });
      insertNotification(db, { type: "reminder", reaction: "ignored" });
      insertNotification(db, { type: "reminder", reaction: null });
      // Unrecognised reaction value → folded into pending.
      insertNotification(db, { type: "reminder", reaction: "emoji:+1" });
      // Not sent → excluded entirely (NULL status passes the schema CHECK).
      insertNotification(db, { type: "reminder", status: "suppressed" });
      insertNotification(db, { type: "reminder", status: "failed" });
      insertNotification(db, { type: "reminder", status: null });
      // NULL type bucket.
      insertNotification(db, { type: null, reaction: null });

      const { current } = gatherSelfPerformanceData(db, { now: NOW });
      expect(current.notifications).toEqual([
        {
          notificationType: "reminder",
          sent: 6,
          replied: 1,
          acted: 1,
          corrected: 1,
          ignored: 1,
          pending: 2,
        },
        {
          notificationType: "(untyped)",
          sent: 1,
          replied: 0,
          acted: 0,
          corrected: 0,
          ignored: 0,
          pending: 1,
        },
      ]);
    });
  });

  describe("gatherSelfPerformanceData — self-tuning ledger", () => {
    it("reads prefix-matched runtime_state rows newest-first and strips the prefix", () => {
      const db = makeDb();
      insertLedger(
        db,
        "activityScanPrePassFreshnessMinutes",
        JSON.stringify({
          prev: 240,
          applied_at: "2026-06-01T00:00:00Z",
          rule: "R1",
          baselineMetric: 0.72,
        }),
        "2026-06-01 00:00:00",
      );
      insertLedger(
        db,
        "maxNotificationsPerHour",
        JSON.stringify({ prev: 6 }),
        "2026-06-05 00:00:00",
      );
      // Corrupt blob is skipped, never thrown.
      insertLedger(db, "corrupt", "{nope", "2026-06-06 00:00:00");
      // Non-prefixed runtime_state rows are invisible.
      db.prepare(
        `INSERT INTO runtime_state (key, value_json) VALUES ('other.key', '1')`,
      ).run();

      const { ledger } = gatherSelfPerformanceData(db, { now: NOW });
      expect(ledger).toEqual([
        { key: "maxNotificationsPerHour", prev: 6, appliedAt: null, rule: null },
        {
          key: "activityScanPrePassFreshnessMinutes",
          prev: 240,
          appliedAt: "2026-06-01T00:00:00Z",
          rule: "R1",
          baselineMetric: 0.72,
        },
      ]);
    });

    it("passes reverted_at / verify_result through so the recommender and renderer see outcomes", () => {
      const db = makeDb();
      insertLedger(
        db,
        "activityScanLowSignalPendingCeiling",
        JSON.stringify({
          prev: 0,
          applied_at: "2026-05-01T00:00:00Z",
          rule: "R3",
          reverted_at: "2026-05-20T00:00:00Z",
          verify_result: "pass",
        }),
        "2026-05-20 00:00:00",
      );
      // Non-string reverted_at / verify_result degrade to absent, never a throw.
      insertLedger(
        db,
        "otherKnob",
        JSON.stringify({ prev: 1, reverted_at: 42, verify_result: 7 }),
        "2026-05-21 00:00:00",
      );

      const { ledger } = gatherSelfPerformanceData(db, { now: NOW });
      expect(ledger[1]).toMatchObject({
        key: "activityScanLowSignalPendingCeiling",
        revertedAt: "2026-05-20T00:00:00Z",
        verifyResult: "pass",
      });
      expect(ledger[0].key).toBe("otherKnob");
      expect("revertedAt" in ledger[0]).toBe(false);
      expect("verifyResult" in ledger[0]).toBe(false);
    });
  });

  describe("summarizeLessonStoreUtilization", () => {
    const file = (lessons: string[]): string =>
      ["# Agent Lessons", "## Lessons", ...lessons].join("\n");
    const lesson = (ev: number): string =>
      `- [2026-06-01] Lesson ev${ev}. <!-- ev=${ev} kind=preference src=behavioral conf=medium last=2026-06-01 -->`;

    it("measures the Lessons section and takes the median ev (odd count)", () => {
      const md = file([lesson(1), lesson(5), lesson(2)]);
      const summary = summarizeLessonStoreUtilization("agent", md, 8192);
      expect(summary).toMatchObject({
        scope: "agent",
        capBytes: 8192,
        entries: 3,
        medianEv: 2,
      });
      expect(summary.bytes).toBeGreaterThan(0);
    });

    it("averages the middle pair on even counts", () => {
      const md = file([lesson(1), lesson(2), lesson(3), lesson(6)]);
      expect(summarizeLessonStoreUtilization("agent", md, 8192).medianEv).toBe(2.5);
    });

    it("degrades a file without a Lessons section to an empty store", () => {
      expect(summarizeLessonStoreUtilization("agent", "# Nothing\n", 8192)).toEqual({
        scope: "agent",
        bytes: 0,
        capBytes: 8192,
        entries: 0,
        medianEv: null,
      });
    });
  });

  describe("buildSelfPerformanceBlock — emptiness gate", () => {
    it("returns null when there is no telemetry at all (lesson stores alone don't count)", () => {
      expect(build(makeData(), { lessonStores: [store({ scope: "agent" })] })).toBeNull();
    });

    it.each([
      ["current actions", makeData({ current: { ...emptyWindow(), actions: [action({ actionType: "a" })] } })],
      ["baseline actions", makeData({ baseline: { ...emptyWindow(), actions: [action({ actionType: "a" })] } })],
      ["current notifications", makeData({ current: { ...emptyWindow(), notifications: [notification({ notificationType: "n" })] } })],
      ["baseline notifications", makeData({ baseline: { ...emptyWindow(), notifications: [notification({ notificationType: "n" })] } })],
      ["current gate ticks", makeData({ current: { ...emptyWindow(), gate: { ...emptyGate(), ticks: 1 } } })],
      ["baseline gate ticks", makeData({ baseline: { ...emptyWindow(), gate: { ...emptyGate(), ticks: 1 } } })],
      ["ledger entries", makeData({ ledger: [{ key: "k", prev: 1, appliedAt: null, rule: null }] })],
    ])("renders when only %s exist", (_label, data) => {
      const block = build(data);
      expect(block).toContain("<self_performance ");
      expect(block).toContain(`generated_at="${GENERATED_AT}"`);
    });
  });

  describe("buildSelfPerformanceBlock — rendering", () => {
    it("renders totals across ALL action types and notification types", () => {
      const data = makeData({
        current: {
          ...emptyWindow(),
          actions: [
            action({ actionType: "a", runs: 3, failed: 1, costUsd: 1.5 }),
            action({ actionType: "b", runs: 2, costUsd: 0.5 }),
          ],
          notifications: [
            notification({ notificationType: "x", sent: 4, ignored: 2, pending: 2 }),
            notification({ notificationType: "y", sent: 1, ignored: 1, pending: 0 }),
          ],
        },
        baseline: {
          ...emptyWindow(),
          actions: [action({ actionType: "a", runs: 5, failed: 2, costUsd: 2 })],
          notifications: [notification({ notificationType: "x", sent: 3 })],
        },
      });
      const block = build(data)!;
      expect(block).toContain(
        '<totals runs="5" failed="1" cost_usd="2" prev_runs="5" prev_failed="2" ' +
          'prev_cost_usd="2" notif_sent="5" notif_ignored="3" prev_notif_sent="3" />',
      );
    });

    it("ranks actions by cost desc with runs / name tie-breaks and shows trend attrs", () => {
      const data = makeData({
        current: {
          ...emptyWindow(),
          actions: [
            action({ actionType: "cheap.z", costUsd: 0.1, runs: 1 }),
            action({ actionType: "cheap.a", costUsd: 0.1, runs: 1 }),
            action({ actionType: "busy", costUsd: 0.1, runs: 9 }),
            action({
              actionType: "pricey",
              costUsd: 2.5,
              runs: 4,
              success: 2,
              partial: 1,
              failed: 1,
              skipped: 0,
              p50DurationMs: 1234,
            }),
          ],
        },
        baseline: {
          ...emptyWindow(),
          actions: [action({ actionType: "pricey", runs: 6, costUsd: 3.25 })],
        },
      });
      const block = build(data)!;
      const order = ["pricey", "busy", "cheap.a", "cheap.z"].map((t) =>
        block.indexOf(`<a t="${t}"`),
      );
      expect(Math.min(...order)).toBeGreaterThan(-1);
      expect([...order].sort((a, b) => a - b)).toEqual(order);
      expect(block).toContain(
        '<a t="pricey" runs="4" ok="2" part="1" fail="1" skip="0" ' +
          'cost_usd="2.5" p50_ms="1234" prev_runs="6" prev_cost_usd="3.25" />',
      );
      // No baseline entry → zero trend attrs; no partial → no part attr;
      // null p50 → no p50_ms attr.
      expect(block).toContain(
        '<a t="busy" runs="9" ok="1" fail="0" skip="0" cost_usd="0.1" ' +
          'prev_runs="0" prev_cost_usd="0" />',
      );
    });

    it("renders fetch-window empty rates with prev_rate only when the baseline saw runs", () => {
      const data = makeData({
        current: {
          ...emptyWindow(),
          actions: [action({ actionType: "a" })],
          fetchWindow: [
            integration({ integrationKey: "gmail", runs: 40, empty: 31 }),
            integration({ integrationKey: "alpha", runs: 40, empty: 4 }),
            integration({ integrationKey: "notion", runs: 2, empty: 0 }),
          ],
        },
        baseline: {
          ...emptyWindow(),
          fetchWindow: [integration({ integrationKey: "gmail", runs: 35, empty: 25 })],
        },
      });
      const block = build(data)!;
      expect(block).toContain(
        '<i k="gmail" runs="40" empty="31" rate="78%" prev_rate="71%" />',
      );
      expect(block).toContain('<i k="notion" runs="2" empty="0" rate="0%" />');
      // runs tie → key asc.
      expect(block.indexOf('k="alpha"')).toBeLessThan(block.indexOf('k="gmail"'));
    });

    it("renders the hourly gate line with both windows", () => {
      const data = makeData({
        current: {
          ...emptyWindow(),
          gate: {
            ticks: 160,
            stage0: 120,
            stage2: 0,
            stage3: 40,
            stage3LowSignal: 18,
            stage3LowSignalLowNovelty: 12,
          },
        },
        baseline: {
          ...emptyWindow(),
          gate: { ...emptyGate(), ticks: 150, stage3: 35 },
        },
      });
      expect(build(data)).toContain(
        '<hourly_gate ticks="160" stage0="120" stage2="0" stage3="40" ' +
          'stage3_low_signal="18" stage3_low_signal_novelty_le1="12" ' +
          'prev_ticks="150" prev_stage3="35" />',
      );
    });

    it("renders notifications sorted by sent desc with name tie-break", () => {
      const data = makeData({
        current: {
          ...emptyWindow(),
          notifications: [
            notification({ notificationType: "b", sent: 2, pending: 2 }),
            notification({ notificationType: "a", sent: 2, pending: 2 }),
            notification({
              notificationType: "reminder",
              sent: 9,
              replied: 2,
              acted: 1,
              corrected: 1,
              ignored: 4,
              pending: 1,
            }),
          ],
        },
      });
      const block = build(data)!;
      expect(block).toContain(
        '<n t="reminder" sent="9" replied="2" acted="1" corrected="1" ignored="4" pending="1" />',
      );
      expect(block.indexOf('t="reminder"')).toBeLessThan(block.indexOf('t="a"'));
      expect(block.indexOf('t="a"')).toBeLessThan(block.indexOf('t="b"'));
    });

    it("renders lesson stores by utilization desc, tolerating a zero cap", () => {
      const data = makeData({
        current: { ...emptyWindow(), actions: [action({ actionType: "a" })] },
      });
      const block = build(data, {
        lessonStores: [
          store({ scope: "agent:writer", bytes: 10, capBytes: 0, medianEv: null }),
          // Equal (zero) utilization → scope-name tie-break.
          store({ scope: "agent:editor", bytes: 5, capBytes: 0, medianEv: null }),
          store({ scope: "agent", bytes: 7373, capBytes: 8192, entries: 22, medianEv: 1.5 }),
        ],
      })!;
      expect(block).toContain(
        '<s scope="agent" bytes="7373" cap="8192" util="90%" entries="22" median_ev="1.5" />',
      );
      // Zero cap → no util / median attrs beyond what exists.
      expect(block).toContain('<s scope="agent:writer" bytes="10" cap="0" entries="1" />');
      expect(block.indexOf('scope="agent"')).toBeLessThan(
        block.indexOf('scope="agent:editor"'),
      );
      expect(block.indexOf('scope="agent:editor"')).toBeLessThan(
        block.indexOf('scope="agent:writer"'),
      );
    });

    it("marks clipped lesson stores as omitted", () => {
      const data = makeData({
        current: { ...emptyWindow(), actions: [action({ actionType: "a" })] },
      });
      const block = build(data, {
        maxBytes: 4000,
        lessonStores: Array.from({ length: 7 }, (_, i) =>
          store({ scope: `agent:store-${i}`, bytes: 700 - i, capBytes: 4096 }),
        ),
      })!;
      expect(block).toContain('<lesson_stores omitted="1">');
    });

    it("renders ledger entries with optional applied_at / rule / baseline and inlined prev values", () => {
      const data = makeData({
        ledger: [
          {
            key: "activityScanPrePassFreshnessMinutes",
            prev: 240,
            appliedAt: "2026-06-01T00:00:00Z",
            rule: "R1",
            baselineMetric: 0.72,
          },
          { key: "long", prev: "x".repeat(80), appliedAt: null, rule: null },
          { key: "blank", prev: undefined, appliedAt: null, rule: null },
          { key: "bare", prev: "manual", appliedAt: null, rule: null },
        ],
      });
      const block = build(data, { maxBytes: 4000 })!;
      expect(block).toContain(
        '<c key="activityScanPrePassFreshnessMinutes" prev="240" ' +
          'applied_at="2026-06-01T00:00:00Z" rule="R1" baseline="0.72" />',
      );
      expect(block).toContain(`<c key="long" prev="${"x".repeat(59)}…" />`);
      expect(block).toContain('<c key="blank" prev="null" />');
      // The ledger budget is 3 — the 4th entry is clipped, never silent.
      expect(block).not.toContain('key="bare"');
      expect(block).toContain('omitted="1"');
    });

    it("renders revert / verify outcomes so the judge sees a change's measured effect", () => {
      const data = makeData({
        ledger: [
          {
            key: "activityScanLowSignalPendingCeiling",
            prev: 0,
            appliedAt: "2026-05-25T00:00:00Z",
            rule: "R3",
            revertedAt: "2026-06-02T00:00:00Z",
          },
          {
            key: "feedbackLessonMaxBytesGlobal",
            prev: 8192,
            appliedAt: "2026-05-20T00:00:00Z",
            rule: "R5",
            verifyResult: "pass",
          },
        ],
      });
      const block = build(data, { maxBytes: 4000 })!;
      expect(block).toContain(
        '<c key="activityScanLowSignalPendingCeiling" prev="0" ' +
          'applied_at="2026-05-25T00:00:00Z" rule="R3" ' +
          'reverted_at="2026-06-02T00:00:00Z" />',
      );
      expect(block).toContain(
        '<c key="feedbackLessonMaxBytesGlobal" prev="8192" ' +
          'applied_at="2026-05-20T00:00:00Z" rule="R5" verified="pass" />',
      );
    });

    it("escapes XML metacharacters in identifier attributes", () => {
      const data = makeData({
        current: {
          ...emptyWindow(),
          actions: [action({ actionType: 'odd&<>"type' })],
        },
      });
      expect(build(data)).toContain('t="odd&amp;&lt;&gt;&quot;type"');
    });
  });

  describe("buildSelfPerformanceBlock — byte cap", () => {
    function bulkyData(): SelfPerformanceData {
      const longName = (i: number) =>
        `routine.some_very_long_action_type_name_${String(i).padStart(2, "0")}`;
      return makeData({
        current: {
          actions: Array.from({ length: 12 }, (_, i) =>
            action({ actionType: longName(i), runs: i + 1, costUsd: 12 - i }),
          ),
          fetchWindow: Array.from({ length: 10 }, (_, i) =>
            integration({ integrationKey: `integration_key_${i}`, runs: 10, empty: i }),
          ),
          gate: { ...emptyGate(), ticks: 100, stage0: 90, stage3: 10 },
          notifications: Array.from({ length: 9 }, (_, i) =>
            notification({ notificationType: `notification_type_${i}`, sent: 9 - i }),
          ),
        },
        ledger: Array.from({ length: 5 }, (_, i) => ({
          key: `tunable_knob_number_${i}`,
          prev: 100 + i,
          appliedAt: "2026-06-01T00:00:00Z",
          rule: `R${i}`,
        })),
      });
    }

    it("stays under the default hard cap and marks clipped rows as omitted", () => {
      const block = build(bulkyData())!;
      expect(Buffer.byteLength(block, "utf-8")).toBeLessThanOrEqual(
        SELF_PERFORMANCE_MAX_BYTES,
      );
      expect(block).toContain("omitted=");
      // Totals survive shrinking — they are the task-flow's copy source.
      expect(block).toContain("<totals ");
    });

    it("honours a custom maxBytes by shrinking sections row by row", () => {
      const block = build(bulkyData(), { maxBytes: 900 })!;
      expect(Buffer.byteLength(block, "utf-8")).toBeLessThanOrEqual(900);
      expect(block).toContain("<totals ");
    });

    it("degrades to the minimal stub when even the skeleton exceeds maxBytes", () => {
      const block = build(bulkyData(), { maxBytes: 10 })!;
      expect(block).toBe(
        `<self_performance generated_at="${GENERATED_AT}" window_days="7" overflow="true" />`,
      );
    });
  });
});
