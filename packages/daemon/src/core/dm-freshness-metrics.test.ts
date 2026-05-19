import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { applySchema } from "../db/schema.js";
import {
  RECENT_ACTIVITY_TRIGGER_RE,
  computeDmFreshnessAggregate,
  countContextWritesInWindow,
  didRefetchTodayDuringTurn,
  matchesRecentActivityTrigger,
} from "./dm-freshness-metrics.js";

describe("dm-freshness-metrics", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applySchema(db);
  });

  afterEach(() => {
    db.close();
  });

  describe("matchesRecentActivityTrigger", () => {
    it.each([
      // English exemplars from the Task 3 directive.
      "what have you been up to today",
      "did anything come in",
      "anything new since last hour?",
      "anything happen?",
      "anything happen in the last 20 min?",
      "did anything happen in the past 5 min",
    ])("matches %j", (msg) => {
      expect(matchesRecentActivityTrigger(msg)).toBe(true);
    });

    it.each([
      "hello",
      "thanks",
      "schedule a reminder",
      "tell me about the project",
    ])("does NOT match %j", (msg) => {
      expect(matchesRecentActivityTrigger(msg)).toBe(false);
    });

    it("matches case-insensitively", () => {
      expect(RECENT_ACTIVITY_TRIGGER_RE.test("What Have You Been Up To?")).toBe(
        true,
      );
    });
  });

  describe("countContextWritesInWindow", () => {
    it("counts loud and quiet rows in the half-open window only", () => {
      // Three writes: one before window, one inside (loud), one inside
      // (quiet), one after window. Only the two inside should be counted.
      db.prepare(
        `INSERT INTO agent_actions (action_type, trigger, result, detail, started_at)
         VALUES
           ('context_write', 'reactive', 'success', json(?), '2026-05-01 09:00:00'),
           ('context_write', 'reactive', 'success', json(?), '2026-05-01 10:00:00'),
           ('context_write', 'reactive', 'success', json(?), '2026-05-01 10:30:00'),
           ('context_write', 'reactive', 'success', json(?), '2026-05-01 12:00:00')`,
      ).run(
        JSON.stringify({ tier: "loud" }),
        JSON.stringify({ tier: "loud" }),
        JSON.stringify({ tier: "quiet" }),
        JSON.stringify({ tier: "quiet" }),
      );
      const counts = countContextWritesInWindow(
        db,
        "2026-05-01 09:30:00",
        "2026-05-01 11:00:00",
      );
      expect(counts).toEqual({ loud: 1, quiet: 1 });
    });

    it("returns zeros when no rows fall in the window", () => {
      expect(
        countContextWritesInWindow(
          db,
          "2026-05-01 09:00:00",
          "2026-05-01 10:00:00",
        ),
      ).toEqual({ loud: 0, quiet: 0 });
    });
  });

  describe("didRefetchTodayDuringTurn", () => {
    it("returns true when a context_read of `today` falls inside the bounded window", () => {
      db.prepare(
        `INSERT INTO agent_actions (action_type, trigger, result, detail, started_at)
         VALUES ('context_read', 'reactive', 'success', json(?), '2026-05-01 10:05:00')`,
      ).run(JSON.stringify({ path: "today" }));
      expect(
        didRefetchTodayDuringTurn(
          db,
          "2026-05-01 10:00:00",
          "2026-05-01 10:10:00",
        ),
      ).toBe(true);
    });

    it("returns false when the only context_read is from before the turn", () => {
      db.prepare(
        `INSERT INTO agent_actions (action_type, trigger, result, detail, started_at)
         VALUES ('context_read', 'reactive', 'success', json(?), '2026-05-01 09:00:00')`,
      ).run(JSON.stringify({ path: "today" }));
      expect(
        didRefetchTodayDuringTurn(
          db,
          "2026-05-01 10:00:00",
          "2026-05-01 10:10:00",
        ),
      ).toBe(false);
    });

    it("returns false when the only context_read is AFTER the turn end (cross-turn leakage guard)", () => {
      db.prepare(
        `INSERT INTO agent_actions (action_type, trigger, result, detail, started_at)
         VALUES ('context_read', 'reactive', 'success', json(?), '2026-05-01 10:30:00')`,
      ).run(JSON.stringify({ path: "today" }));
      expect(
        didRefetchTodayDuringTurn(
          db,
          "2026-05-01 10:00:00",
          "2026-05-01 10:10:00",
        ),
      ).toBe(false);
    });

    it("ignores context_read rows for other paths", () => {
      db.prepare(
        `INSERT INTO agent_actions (action_type, trigger, result, detail, started_at)
         VALUES ('context_read', 'reactive', 'success', json(?), '2026-05-01 10:05:00')`,
      ).run(JSON.stringify({ path: "roadmap" }));
      expect(
        didRefetchTodayDuringTurn(
          db,
          "2026-05-01 10:00:00",
          "2026-05-01 10:10:00",
        ),
      ).toBe(false);
    });

    it("defaults the upper bound to now() when omitted (back-compat)", () => {
      db.prepare(
        `INSERT INTO agent_actions (action_type, trigger, result, detail, started_at)
         VALUES ('context_read', 'reactive', 'success', json(?), datetime('now'))`,
      ).run(JSON.stringify({ path: "today" }));
      // turnStart 1 hour ago — the row landed within the [start, now()]
      // window, so the call without an explicit upper bound returns true.
      expect(
        didRefetchTodayDuringTurn(db, "1970-01-01 00:00:00"),
      ).toBe(true);
    });
  });

  describe("computeDmFreshnessAggregate", () => {
    it("returns zero-valued aggregate when no DM rows exist", () => {
      const agg = computeDmFreshnessAggregate(db, 7);
      expect(agg).toEqual({
        windowDays: 7,
        totalDmTurns: 0,
        resumedTurns: 0,
        resumeRate: 0,
        p50LagMinutes: 0,
        p95LagMinutes: 0,
        triggerMatchedTurns: 0,
        refetchHits: 0,
        refetchHitRate: 0,
      });
    });

    it("computes resume rate, lag percentiles, and refetch-hit rate from dm_freshness rows", () => {
      const insert = db.prepare(
        `INSERT INTO agent_actions (action_type, trigger, result, detail, started_at)
         VALUES ('message.received', 'reactive', 'success', json(?), datetime('now'))`,
      );
      // 5 turns: 4 resumed (lags 5/10/30/60), 1 fresh execute (lag 0).
      // 2 trigger-matched of which 1 refetched.
      insert.run(
        JSON.stringify({
          dm_freshness: {
            resumed: true,
            agent_log_lag_minutes: 5,
            loud_writes_since_session_start: 0,
            quiet_writes_since_session_start: 1,
            refetched_today: false,
            trigger_matched: false,
          },
        }),
      );
      insert.run(
        JSON.stringify({
          dm_freshness: {
            resumed: true,
            agent_log_lag_minutes: 10,
            loud_writes_since_session_start: 0,
            quiet_writes_since_session_start: 2,
            refetched_today: true,
            trigger_matched: true,
          },
        }),
      );
      insert.run(
        JSON.stringify({
          dm_freshness: {
            resumed: true,
            agent_log_lag_minutes: 30,
            loud_writes_since_session_start: 0,
            quiet_writes_since_session_start: 3,
            refetched_today: false,
            trigger_matched: true,
          },
        }),
      );
      insert.run(
        JSON.stringify({
          dm_freshness: {
            resumed: true,
            agent_log_lag_minutes: 60,
            loud_writes_since_session_start: 1,
            quiet_writes_since_session_start: 5,
            refetched_today: false,
            trigger_matched: false,
          },
        }),
      );
      insert.run(
        JSON.stringify({
          dm_freshness: {
            resumed: false,
            agent_log_lag_minutes: 0,
            loud_writes_since_session_start: 0,
            quiet_writes_since_session_start: 0,
            refetched_today: false,
            trigger_matched: false,
          },
        }),
      );

      const agg = computeDmFreshnessAggregate(db, 7);
      expect(agg.totalDmTurns).toBe(5);
      expect(agg.resumedTurns).toBe(4);
      expect(agg.resumeRate).toBeCloseTo(0.8);
      // Lag percentile is RESUMED-COHORT only (fresh-execute lag=0 by
      // construction; mixing it into the percentile drags p50/p95 toward
      // 0 and obscures the cohort the plan §6 threshold targets).
      // Sorted resumed lags = [5, 10, 30, 60].
      // Nearest-rank p50 → ceil(0.5*4)=2 → index 1 → 10.
      expect(agg.p50LagMinutes).toBe(10);
      // Nearest-rank p95 → ceil(0.95*4)=4 → index 3 → 60.
      expect(agg.p95LagMinutes).toBe(60);
      expect(agg.triggerMatchedTurns).toBe(2);
      expect(agg.refetchHits).toBe(1);
      expect(agg.refetchHitRate).toBeCloseTo(0.5);
    });

    it("resumed-cohort lag percentile excludes fresh-execute zeros (regression)", () => {
      // Plan §6: p95 ≤ 60 minutes for resumed turns. A naive
      // all-turns aggregation hides the resumed-cohort tail when fresh
      // executes dominate the sample (most "first DM" of a session).
      // This regression test asserts the percentile reflects ONLY the
      // resumed turns.
      const insert = db.prepare(
        `INSERT INTO agent_actions (action_type, trigger, result, detail, started_at)
         VALUES ('message.received', 'reactive', 'success', json(?), datetime('now'))`,
      );
      // 1 resumed turn with 60-minute lag, 19 fresh executes with lag 0.
      insert.run(
        JSON.stringify({
          dm_freshness: {
            resumed: true,
            agent_log_lag_minutes: 60,
            loud_writes_since_session_start: 0,
            quiet_writes_since_session_start: 0,
            refetched_today: false,
            trigger_matched: false,
          },
        }),
      );
      for (let i = 0; i < 19; i += 1) {
        insert.run(
          JSON.stringify({
            dm_freshness: {
              resumed: false,
              agent_log_lag_minutes: 0,
              loud_writes_since_session_start: 0,
              quiet_writes_since_session_start: 0,
              refetched_today: false,
              trigger_matched: false,
            },
          }),
        );
      }
      const agg = computeDmFreshnessAggregate(db, 7);
      expect(agg.totalDmTurns).toBe(20);
      expect(agg.resumedTurns).toBe(1);
      // Resumed-only p95 is 60 (the single resumed turn). An old all-turns
      // aggregation would have returned 0 here (idx 18 of sorted list).
      expect(agg.p50LagMinutes).toBe(60);
      expect(agg.p95LagMinutes).toBe(60);
    });

    it("treats null agent_log_lag_minutes as 0 in the resumed cohort (defensive coercion)", () => {
      const insert = db.prepare(
        `INSERT INTO agent_actions (action_type, trigger, result, detail, started_at)
         VALUES ('message.received', 'reactive', 'success', json(?), datetime('now'))`,
      );
      // Resumed turn whose lag is null — exercises the
      // `Number.isFinite(row.lag) ? Number(row.lag) : 0` branch.
      insert.run(
        JSON.stringify({
          dm_freshness: {
            resumed: true,
            agent_log_lag_minutes: null,
            loud_writes_since_session_start: 0,
            quiet_writes_since_session_start: 0,
            refetched_today: false,
            trigger_matched: false,
          },
        }),
      );
      const agg = computeDmFreshnessAggregate(db, 7);
      expect(agg.resumedTurns).toBe(1);
      expect(agg.p50LagMinutes).toBe(0);
      expect(agg.p95LagMinutes).toBe(0);
    });

    it("zeros lag percentile when there are no resumed turns", () => {
      db.prepare(
        `INSERT INTO agent_actions (action_type, trigger, result, detail, started_at)
         VALUES ('message.received', 'reactive', 'success', json(?), datetime('now'))`,
      ).run(
        JSON.stringify({
          dm_freshness: {
            resumed: false,
            agent_log_lag_minutes: 0,
            loud_writes_since_session_start: 0,
            quiet_writes_since_session_start: 0,
            refetched_today: false,
            trigger_matched: false,
          },
        }),
      );
      const agg = computeDmFreshnessAggregate(db, 7);
      expect(agg.totalDmTurns).toBe(1);
      expect(agg.resumedTurns).toBe(0);
      expect(agg.p50LagMinutes).toBe(0);
      expect(agg.p95LagMinutes).toBe(0);
    });

    it("excludes rows outside the window", () => {
      db.prepare(
        `INSERT INTO agent_actions (action_type, trigger, result, detail, started_at)
         VALUES ('message.received', 'reactive', 'success', json(?), datetime('now', '-30 days'))`,
      ).run(
        JSON.stringify({
          dm_freshness: {
            resumed: true,
            agent_log_lag_minutes: 999,
            loud_writes_since_session_start: 0,
            quiet_writes_since_session_start: 0,
            refetched_today: false,
            trigger_matched: false,
          },
        }),
      );
      // Within window.
      db.prepare(
        `INSERT INTO agent_actions (action_type, trigger, result, detail, started_at)
         VALUES ('message.received', 'reactive', 'success', json(?), datetime('now', '-1 days'))`,
      ).run(
        JSON.stringify({
          dm_freshness: {
            resumed: false,
            agent_log_lag_minutes: 0,
            loud_writes_since_session_start: 0,
            quiet_writes_since_session_start: 0,
            refetched_today: false,
            trigger_matched: false,
          },
        }),
      );
      const agg = computeDmFreshnessAggregate(db, 7);
      expect(agg.totalDmTurns).toBe(1);
    });

    it("guards refetchHitRate against divide-by-zero when no triggers matched", () => {
      db.prepare(
        `INSERT INTO agent_actions (action_type, trigger, result, detail, started_at)
         VALUES ('message.received', 'reactive', 'success', json(?), datetime('now'))`,
      ).run(
        JSON.stringify({
          dm_freshness: {
            resumed: true,
            agent_log_lag_minutes: 5,
            loud_writes_since_session_start: 0,
            quiet_writes_since_session_start: 0,
            refetched_today: false,
            trigger_matched: false,
          },
        }),
      );
      const agg = computeDmFreshnessAggregate(db, 7);
      expect(agg.triggerMatchedTurns).toBe(0);
      expect(agg.refetchHitRate).toBe(0);
    });
  });
});
