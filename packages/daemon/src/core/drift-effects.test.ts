import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { applySchema } from "../db/schema.js";
import {
  __driftEffectsTestExports,
  applyDriftEffects,
  emptyDriftSideEffects,
  flushPendingTodayRefresh,
} from "./drift-effects.js";
import type { ReconcileDiff, ReconcileRequest } from "../services/integrations/reconcile.js";
import type { TodayWriteLockManager } from "./today-write-lock.js";

const NOW = new Date("2026-04-29T12:00:00.000Z");

function baseReq(): ReconcileRequest {
  return {
    integration: "google_calendar",
    windowKey: "primary:24h",
    windowMin: "2026-04-29T00:00:00.000Z",
    windowMax: "2026-04-30T00:00:00.000Z",
    fetchedAt: NOW.toISOString(),
    items: [],
  };
}

function emptyDiff(overrides: Partial<ReconcileDiff> = {}): ReconcileDiff {
  return {
    created: [],
    modified: [],
    deleted: [],
    unchanged: 0,
    prunedOutOfWindow: 0,
    isInitialSnapshot: false,
    ...overrides,
  };
}

function createdDiff(itemId: string, summary: string, start = "2026-04-29T15:00:00.000Z"): ReconcileDiff {
  return emptyDiff({
    created: [
      {
        itemId,
        contentHash: `${itemId}-hash`,
        payload: {
          summary,
          start,
          end: "2026-04-29T16:00:00.000Z",
          description: null,
          location: null,
        },
        itemStart: start,
        actor: "user",
      },
    ],
  });
}

describe("drift effects", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    applySchema(db);
  });

  afterEach(() => {
    db.close();
  });

  it("writes calendar observations and schedules one today_refresh for today's drift", () => {
    const triggerRoadmapRefresh = vi.fn();

    const effects = applyDriftEffects(baseReq(), createdDiff("evt-1", "Standup"), {
      db,
      calendarId: "primary",
      timezone: "UTC",
      now: () => NOW,
      triggerRoadmapRefresh,
    });

    expect(effects.observationsWritten).toBe(1);
    expect(effects.todayRefreshScheduled).toBe(true);
    expect(triggerRoadmapRefresh).not.toHaveBeenCalled();

    const observation = db
      .prepare("SELECT source, ref, change_type, actor, payload FROM observations")
      .get() as {
        source: string;
        ref: string;
        change_type: string;
        actor: string;
        payload: string;
      };
    expect(observation.source).toBe("calendar:primary");
    expect(observation.ref).toBe("evt-1");
    expect(observation.change_type).toBe("created");
    expect(observation.actor).toBe("user");
    expect(JSON.parse(observation.payload)).toMatchObject({ summary: "Standup" });

    const scheduled = db
      .prepare(
        "SELECT task_type, task_description, correlation_id, json_extract(task_context, '$.routine') AS routine FROM agent_schedule",
      )
      .get() as {
        task_type: string;
        task_description: string;
        correlation_id: string | null;
        routine: string;
      };
    expect(scheduled.task_type).toBe("wake");
    expect(scheduled.task_description).toMatch(/Refresh today\.md/);
    expect(scheduled.routine).toBe("today_refresh");
    // Operators tie the wake row back to its triggering drift via
    // correlation_id; missing it would force a JSON-extract dance through
    // task_context for routine activity diagnostics.
    expect(scheduled.correlation_id).toMatch(/^drift:google_calendar:primary:24h:/);
  });

  it("coalesces pending created+modified as created with the latest payload", () => {
    applyDriftEffects(baseReq(), createdDiff("evt-1", "Created"), {
      db,
      timezone: "UTC",
      now: () => NOW,
    });

    applyDriftEffects(
      baseReq(),
      emptyDiff({
        modified: [
          {
            itemId: "evt-1",
            prior: { contentHash: "old", payload: { summary: "Created" } },
            current: {
              contentHash: "new",
              payload: { summary: "Renamed", start: "2026-04-29T15:00:00.000Z" },
            },
            itemStart: "2026-04-29T15:00:00.000Z",
            actor: "user",
          },
        ],
      }),
      { db, timezone: "UTC", now: () => new Date(NOW.getTime() + 60_000) },
    );

    const row = db
      .prepare("SELECT change_type, payload FROM observations WHERE ref = 'evt-1'")
      .get() as { change_type: string; payload: string };
    expect(row.change_type).toBe("created");
    expect(JSON.parse(row.payload)).toMatchObject({ summary: "Renamed" });
  });

  it("coalesces pending created+deleted into no pending observation", () => {
    applyDriftEffects(baseReq(), createdDiff("evt-1", "Temporary"), {
      db,
      timezone: "UTC",
      now: () => NOW,
    });

    applyDriftEffects(
      baseReq(),
      emptyDiff({
        deleted: [
          {
            itemId: "evt-1",
            payload: { summary: "Temporary", start: "2026-04-29T15:00:00.000Z" },
            itemStart: "2026-04-29T15:00:00.000Z",
            actor: "user",
          },
        ],
      }),
      { db, timezone: "UTC", now: () => new Date(NOW.getTime() + 60_000) },
    );

    const count = db
      .prepare("SELECT COUNT(*) AS c FROM observations WHERE ref = 'evt-1'")
      .get() as { c: number };
    expect(count.c).toBe(0);
  });

  it("deduplicates today_refresh scheduling within five minutes", () => {
    applyDriftEffects(baseReq(), createdDiff("evt-1", "A"), {
      db,
      timezone: "UTC",
      now: () => NOW,
    });
    const second = applyDriftEffects(baseReq(), createdDiff("evt-2", "B"), {
      db,
      timezone: "UTC",
      now: () => new Date(NOW.getTime() + 4 * 60 * 1000),
    });

    expect(second.todayRefreshScheduled).toBe(false);
    const count = db
      .prepare(
        "SELECT COUNT(*) AS c FROM agent_schedule WHERE json_extract(task_context, '$.routine') = 'today_refresh'",
      )
      .get() as { c: number };
    expect(count.c).toBe(1);
  });

  it("stores pending today_refresh while the morning lock is held, then flushes it", () => {
    const heldLock: TodayWriteLockManager = {
      acquire: () => ({ ok: false, holder: "lock-1" }),
      release: () => false,
      isHeldBy: () => false,
      getHolder: () => "lock-1",
    };

    const effects = applyDriftEffects(baseReq(), createdDiff("evt-1", "A"), {
      db,
      timezone: "UTC",
      now: () => NOW,
      todayWriteLock: heldLock,
    });

    expect(effects.todayRefreshScheduled).toBe(false);
    expect(effects.todayRefreshPending).toBe(true);
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS c FROM agent_schedule WHERE json_extract(task_context, '$.routine') = 'today_refresh'",
        )
        .get() as { c: number },
    ).toEqual({ c: 0 });

    const pending = db
      .prepare("SELECT value_json FROM runtime_state WHERE key = ?")
      .get(__driftEffectsTestExports.TODAY_REFRESH_PENDING_KEY) as {
        value_json: string;
      };
    expect(JSON.parse(pending.value_json)).toMatchObject({
      reason: "calendar_drift_while_morning_lock_held",
    });

    const flushed = flushPendingTodayRefresh(
      db,
      new Date(NOW.getTime() + 10 * 60 * 1000),
    );
    expect(flushed).toEqual({ scheduled: true, hadPending: true });

    const scheduled = db
      .prepare(
        "SELECT json_extract(task_context, '$.routine') AS routine FROM agent_schedule",
      )
      .get() as { routine: string };
    expect(scheduled.routine).toBe("today_refresh");

    const pendingAfter = db
      .prepare("SELECT value_json FROM runtime_state WHERE key = ?")
      .get(__driftEffectsTestExports.TODAY_REFRESH_PENDING_KEY);
    expect(pendingAfter).toBeUndefined();
  });

  it("fires roadmap refresh for user-created events beyond the calendar horizon", () => {
    const triggerRoadmapRefresh = vi.fn();
    const start = new Date(NOW.getTime() + 20 * 24 * 60 * 60 * 1000).toISOString();

    const effects = applyDriftEffects(baseReq(), createdDiff("evt-far", "Trip", start), {
      db,
      timezone: "UTC",
      now: () => NOW,
      triggerRoadmapRefresh,
    });

    expect(effects.roadmapRefreshTriggered).toBe(true);
    expect(triggerRoadmapRefresh).toHaveBeenCalledWith("calendar_event_detected");
  });

  it("writes gmail drift observations under `mail:lifecycle` keyed by threadId", () => {
    const req: ReconcileRequest = {
      integration: "gmail",
      windowKey: "inbox:7d",
      windowMin: "2026-04-22T00:00:00Z",
      windowMax: "2026-04-29T13:00:00Z",
      fetchedAt: NOW.toISOString(),
      items: [],
    };
    const diff: ReconcileDiff = {
      created: [
        {
          itemId: "thr-1",
          contentHash: "h1",
          payload: {
            threadId: "thr-1",
            subject: "Hi",
            from: "alice@example.com",
            labelIds: ["INBOX"],
            messageIds: ["msg-1"],
            lastMessageInternalDate: "2026-04-29T12:00:00Z",
            snippet: "...",
          },
          itemStart: null,
          actor: "user",
        },
      ],
      modified: [
        {
          itemId: "thr-2",
          prior: { contentHash: "p", payload: { threadId: "thr-2", messageIds: ["m-a"] } },
          current: { contentHash: "n", payload: { threadId: "thr-2", messageIds: ["m-a", "m-b"] } },
          itemStart: null,
          actor: "user",
        },
      ],
      deleted: [],
      unchanged: 0,
      prunedOutOfWindow: 0,
      isInitialSnapshot: false,
    };

    const effects = applyDriftEffects(req, diff, {
      db,
      timezone: "UTC",
      now: () => NOW,
    });

    expect(effects.observationsWritten).toBe(2);
    // Roadmap + today_refresh stay calendar-only — gmail drift never
    // triggers either.
    expect(effects.todayRefreshScheduled).toBe(false);
    expect(effects.todayRefreshPending).toBe(false);
    expect(effects.roadmapRefreshTriggered).toBe(false);

    const rows = db
      .prepare("SELECT source, ref, change_type FROM observations ORDER BY ref")
      .all() as Array<{ source: string; ref: string; change_type: string }>;
    expect(rows).toEqual([
      { source: "mail:lifecycle", ref: "thr-1", change_type: "created" },
      { source: "mail:lifecycle", ref: "thr-2", change_type: "modified" },
    ]);

    // No agent_schedule / today_refresh row.
    const scheduled = db
      .prepare(
        "SELECT COUNT(*) AS c FROM agent_schedule WHERE json_extract(task_context, '$.routine') = 'today_refresh'",
      )
      .get() as { c: number };
    expect(scheduled.c).toBe(0);
  });

  it("writes notion drift observations under `notion:<parentDatabase>` when database-rooted", () => {
    const req: ReconcileRequest = {
      integration: "notion",
      windowKey: "recently_updated",
      windowMin: "2026-04-22T00:00:00Z",
      windowMax: "2026-04-29T13:00:00Z",
      fetchedAt: NOW.toISOString(),
      items: [],
    };
    const diff: ReconcileDiff = {
      created: [
        {
          itemId: "page-1",
          contentHash: "h",
          payload: {
            pageId: "page-1",
            title: "Ship",
            lastEditedTime: "2026-04-28T10:00:00Z",
            parentDatabase: "db-tasks",
            url: null,
            inTrash: false,
            propertiesSummary: null,
            propertiesSummaryHash: "x",
            relationsHash: "y",
          },
          itemStart: null,
          actor: "user",
        },
      ],
      modified: [],
      deleted: [
        {
          itemId: "page-2",
          payload: { pageId: "page-2", parentDatabase: null }, // workspace-rooted
          itemStart: null,
          actor: "user",
        },
      ],
      unchanged: 0,
      prunedOutOfWindow: 0,
      isInitialSnapshot: false,
    };

    const effects = applyDriftEffects(req, diff, {
      db,
      timezone: "UTC",
      now: () => NOW,
    });

    expect(effects.observationsWritten).toBe(2);
    expect(effects.todayRefreshScheduled).toBe(false);
    expect(effects.roadmapRefreshTriggered).toBe(false);

    const rows = db
      .prepare("SELECT source, ref, change_type FROM observations ORDER BY ref")
      .all() as Array<{ source: string; ref: string; change_type: string }>;
    expect(rows).toEqual([
      { source: "notion:db-tasks", ref: "page-1", change_type: "created" },
      // page-2 had no parentDatabase → falls through to lifecycle.
      { source: "notion:lifecycle", ref: "page-2", change_type: "deleted" },
    ]);
  });

  it("returns empty side effects on the initial gmail / notion snapshot", () => {
    const initial: ReconcileDiff = {
      created: [],
      modified: [],
      deleted: [],
      unchanged: 0,
      prunedOutOfWindow: 0,
      isInitialSnapshot: true,
    };
    const gmailReq: ReconcileRequest = {
      integration: "gmail",
      windowKey: "inbox:7d",
      windowMin: "2026-04-22T00:00:00Z",
      windowMax: "2026-04-29T13:00:00Z",
      fetchedAt: NOW.toISOString(),
      items: [],
    };
    const notionReq: ReconcileRequest = {
      ...gmailReq,
      integration: "notion",
      windowKey: "recently_updated",
    };
    expect(applyDriftEffects(gmailReq, initial, { db })).toEqual(
      emptyDriftSideEffects(),
    );
    expect(applyDriftEffects(notionReq, initial, { db })).toEqual(
      emptyDriftSideEffects(),
    );
  });

  it("fires roadmap refresh when a user-modified event moves beyond the calendar horizon", () => {
    const triggerRoadmapRefresh = vi.fn();
    const near = new Date(NOW.getTime() + 5 * 24 * 60 * 60 * 1000).toISOString();
    const far = new Date(NOW.getTime() + 20 * 24 * 60 * 60 * 1000).toISOString();

    const effects = applyDriftEffects(
      baseReq(),
      emptyDiff({
        modified: [
          {
            itemId: "evt-moved",
            prior: { contentHash: "near", payload: { summary: "Trip", start: near } },
            current: { contentHash: "far", payload: { summary: "Trip", start: far } },
            itemStart: far,
            actor: "user",
          },
        ],
      }),
      {
        db,
        timezone: "UTC",
        now: () => NOW,
        triggerRoadmapRefresh,
      },
    );

    expect(effects.roadmapRefreshTriggered).toBe(true);
    expect(triggerRoadmapRefresh).toHaveBeenCalledWith("calendar_event_detected");
  });

  it("does not schedule a today refresh when a created event has an unparseable non-date start", () => {
    // Pins the `Number.isFinite(Date.parse(...))` defensive branch in
    // startsOnLocalDate. Unparseable starts (garbage strings that pass
    // the typeof check but produce NaN from Date.parse) must short-
    // circuit to "no material today drift" rather than crashing the
    // refresh scheduler with NaN math.
    const triggerRoadmapRefresh = vi.fn();
    const effects = applyDriftEffects(
      baseReq(),
      emptyDiff({
        created: [
          {
            itemId: "evt-bad-start",
            contentHash: "h-bad",
            payload: {
              summary: "broken",
              start: "totally-not-a-date",
              end: "also-broken",
              description: null,
              location: null,
            },
            // itemStart kept null so the function falls through to
            // payload.start — which fails Date.parse.
            itemStart: null,
            actor: "user",
          },
        ],
      }),
      {
        db,
        timezone: "UTC",
        now: () => NOW,
        triggerRoadmapRefresh,
      },
    );
    // observation still recorded; today refresh NOT scheduled
    expect(effects.observationsWritten).toBe(1);
    expect(effects.todayRefreshScheduled).toBe(false);
  });

  it("flushPendingTodayRefresh is a no-op when no pending state is recorded", () => {
    // Pin the early-exit branch where readRuntimeState returns
    // undefined. flushPendingTodayRefresh must surface this as
    // {scheduled: false, hadPending: false} so the morning-routine
    // post-hook can branch cleanly.
    const result = flushPendingTodayRefresh(db, NOW);
    expect(result).toEqual({ scheduled: false, hadPending: false });
  });

  it("uses the wall clock when deps.now is omitted", () => {
    // Pin the `deps.now?.() ?? new Date()` defensive branch in
    // maybeScheduleTodayRefresh. The created event lands today
    // relative to the actual wall clock, so a today_refresh fires
    // without a fixed-clock provider.
    const triggerRoadmapRefresh = vi.fn();
    const todayIso = new Date().toISOString();
    const effects = applyDriftEffects(
      baseReq(),
      createdDiff("evt-now", "Live event", todayIso),
      {
        db,
        timezone: "UTC",
        triggerRoadmapRefresh,
        // intentionally omit `now` to exercise the fallback
      },
    );
    expect(effects.observationsWritten).toBe(1);
  });

  it("does not fire roadmap refresh when a modified event has no parsable start (defensive)", () => {
    // Pins the no-start defensive branches in
    // `extractPayloadStart` / `isBeyondCalendarHorizon` — itemStart is
    // null, both prior and current payloads have empty/unparseable
    // start strings. The horizon check returns false for null and
    // also for non-finite Date.parse output, so the modified change
    // should NOT trigger roadmap refresh.
    const triggerRoadmapRefresh = vi.fn();

    applyDriftEffects(
      baseReq(),
      emptyDiff({
        modified: [
          {
            itemId: "evt-no-start",
            // empty string fails `start.length > 0` in extractPayloadStart
            prior: { contentHash: "h0", payload: { summary: "Trip", start: "" } },
            // garbage string fails Number.isFinite(Date.parse(...))
            current: { contentHash: "h1", payload: { summary: "Trip", start: "not-a-date" } },
            itemStart: null,
            actor: "user",
          },
        ],
      }),
      {
        db,
        timezone: "UTC",
        now: () => NOW,
        triggerRoadmapRefresh,
      },
    );

    expect(triggerRoadmapRefresh).not.toHaveBeenCalled();
  });

  it("does not fire roadmap refresh when a modified event already had a far-future start (no horizon crossing)", () => {
    // Pins the prior-already-beyond-horizon branch: when the prior
    // payload already had a start beyond CALENDAR_HORIZON_MS, moving to
    // another far date is not a roadmap-triggering crossing.
    const triggerRoadmapRefresh = vi.fn();
    const far1 = new Date(NOW.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString();
    const far2 = new Date(NOW.getTime() + 45 * 24 * 60 * 60 * 1000).toISOString();

    applyDriftEffects(
      baseReq(),
      emptyDiff({
        modified: [
          {
            itemId: "evt-far-to-far",
            prior: { contentHash: "p", payload: { summary: "Conf", start: far1 } },
            current: { contentHash: "c", payload: { summary: "Conf", start: far2 } },
            itemStart: far2,
            actor: "user",
          },
        ],
      }),
      {
        db,
        timezone: "UTC",
        now: () => NOW,
        triggerRoadmapRefresh,
      },
    );

    expect(triggerRoadmapRefresh).not.toHaveBeenCalled();
  });

  it("coalesces pending modified+modified into modified with the latest payload", () => {
    applyDriftEffects(
      baseReq(),
      emptyDiff({
        modified: [
          {
            itemId: "evt-m",
            prior: { contentHash: "h0", payload: { summary: "v0", start: "2026-04-29T15:00:00.000Z" } },
            current: { contentHash: "h1", payload: { summary: "v1", start: "2026-04-29T15:00:00.000Z" } },
            itemStart: "2026-04-29T15:00:00.000Z",
            actor: "user",
          },
        ],
      }),
      { db, timezone: "UTC", now: () => NOW },
    );
    applyDriftEffects(
      baseReq(),
      emptyDiff({
        modified: [
          {
            itemId: "evt-m",
            prior: { contentHash: "h1", payload: { summary: "v1", start: "2026-04-29T15:00:00.000Z" } },
            current: { contentHash: "h2", payload: { summary: "v2", start: "2026-04-29T15:00:00.000Z" } },
            itemStart: "2026-04-29T15:00:00.000Z",
            actor: "user",
          },
        ],
      }),
      { db, timezone: "UTC", now: () => new Date(NOW.getTime() + 60_000) },
    );
    const row = db
      .prepare("SELECT change_type, payload FROM observations WHERE ref = 'evt-m'")
      .get() as { change_type: string; payload: string };
    expect(row.change_type).toBe("modified");
    expect(JSON.parse(row.payload)).toMatchObject({ summary: "v2" });
  });

  it("coalesces pending modified+deleted into deleted carrying the deletion payload", () => {
    applyDriftEffects(
      baseReq(),
      emptyDiff({
        modified: [
          {
            itemId: "evt-md",
            prior: { contentHash: "h0", payload: { summary: "alive", start: "2026-04-29T15:00:00.000Z" } },
            current: { contentHash: "h1", payload: { summary: "alive-edited", start: "2026-04-29T15:00:00.000Z" } },
            itemStart: "2026-04-29T15:00:00.000Z",
            actor: "user",
          },
        ],
      }),
      { db, timezone: "UTC", now: () => NOW },
    );
    applyDriftEffects(
      baseReq(),
      emptyDiff({
        deleted: [
          {
            itemId: "evt-md",
            payload: { summary: "alive-edited", start: "2026-04-29T15:00:00.000Z" },
            itemStart: "2026-04-29T15:00:00.000Z",
            actor: "user",
          },
        ],
      }),
      { db, timezone: "UTC", now: () => new Date(NOW.getTime() + 60_000) },
    );
    const row = db
      .prepare("SELECT change_type FROM observations WHERE ref = 'evt-md'")
      .get() as { change_type: string };
    expect(row.change_type).toBe("deleted");
  });

  it("coalesces pending deleted+created into modified (recurring-instance recreate)", () => {
    applyDriftEffects(
      baseReq(),
      emptyDiff({
        deleted: [
          {
            itemId: "evt-dc",
            payload: { summary: "old", start: "2026-04-29T15:00:00.000Z" },
            itemStart: "2026-04-29T15:00:00.000Z",
            actor: "user",
          },
        ],
      }),
      { db, timezone: "UTC", now: () => NOW },
    );
    applyDriftEffects(baseReq(), createdDiff("evt-dc", "Re-created"), {
      db,
      timezone: "UTC",
      now: () => new Date(NOW.getTime() + 60_000),
    });
    const row = db
      .prepare("SELECT change_type, payload FROM observations WHERE ref = 'evt-dc'")
      .get() as { change_type: string; payload: string };
    // Per the §17.1 coalesce table: deleted→created → modified.
    expect(row.change_type).toBe("modified");
    expect(JSON.parse(row.payload)).toMatchObject({ summary: "Re-created" });
  });

  it("coalesces pending deleted+modified into modified and warns (data-corruption guard)", () => {
    applyDriftEffects(
      baseReq(),
      emptyDiff({
        deleted: [
          {
            itemId: "evt-dm",
            payload: { summary: "gone", start: "2026-04-29T15:00:00.000Z" },
            itemStart: "2026-04-29T15:00:00.000Z",
            actor: "user",
          },
        ],
      }),
      { db, timezone: "UTC", now: () => NOW },
    );
    applyDriftEffects(
      baseReq(),
      emptyDiff({
        modified: [
          {
            itemId: "evt-dm",
            prior: { contentHash: "h", payload: { summary: "gone" } },
            current: { contentHash: "h2", payload: { summary: "back" } },
            itemStart: "2026-04-29T15:00:00.000Z",
            actor: "user",
          },
        ],
      }),
      { db, timezone: "UTC", now: () => new Date(NOW.getTime() + 60_000) },
    );
    const row = db
      .prepare("SELECT change_type FROM observations WHERE ref = 'evt-dm'")
      .get() as { change_type: string };
    expect(row.change_type).toBe("modified");
  });

  it("merges actor 'unknown' onto a prior actor (keeps the prior)", () => {
    // Prior pending row tagged actor='agent' (via integration_writes
    // pre-mark surrogate); a follow-up coalesce with actor='unknown' must
    // preserve the prior's 'agent' attribution rather than downgrading.
    applyDriftEffects(
      baseReq(),
      emptyDiff({
        created: [
          {
            itemId: "evt-actor",
            contentHash: "h",
            payload: { summary: "x", start: "2026-04-29T15:00:00.000Z" },
            itemStart: "2026-04-29T15:00:00.000Z",
            actor: "agent",
          },
        ],
      }),
      { db, timezone: "UTC", now: () => NOW },
    );
    applyDriftEffects(
      baseReq(),
      emptyDiff({
        modified: [
          {
            itemId: "evt-actor",
            prior: { contentHash: "h", payload: { summary: "x" } },
            current: { contentHash: "h2", payload: { summary: "y" } },
            itemStart: "2026-04-29T15:00:00.000Z",
            actor: "unknown",
          },
        ],
      }),
      { db, timezone: "UTC", now: () => new Date(NOW.getTime() + 60_000) },
    );
    const row = db
      .prepare("SELECT actor FROM observations WHERE ref = 'evt-actor'")
      .get() as { actor: string };
    expect(row.actor).toBe("agent");
  });

  it("merges actor 'agent' onto a prior actor 'agent' (returns next)", () => {
    // Both prior + next are non-user, non-unknown → merge returns next.
    applyDriftEffects(
      baseReq(),
      emptyDiff({
        created: [
          {
            itemId: "evt-agent2",
            contentHash: "h",
            payload: { summary: "x", start: "2026-04-29T15:00:00.000Z" },
            itemStart: "2026-04-29T15:00:00.000Z",
            actor: "agent",
          },
        ],
      }),
      { db, timezone: "UTC", now: () => NOW },
    );
    applyDriftEffects(
      baseReq(),
      emptyDiff({
        modified: [
          {
            itemId: "evt-agent2",
            prior: { contentHash: "h", payload: { summary: "x" } },
            current: { contentHash: "h2", payload: { summary: "y" } },
            itemStart: "2026-04-29T15:00:00.000Z",
            actor: "agent",
          },
        ],
      }),
      { db, timezone: "UTC", now: () => new Date(NOW.getTime() + 60_000) },
    );
    const row = db
      .prepare("SELECT actor FROM observations WHERE ref = 'evt-agent2'")
      .get() as { actor: string };
    expect(row.actor).toBe("agent");
  });

  it("readLastAutoRefreshAt accepts the legacy object form `{ at: <iso> }`", () => {
    // Older runtime_state writes used `{ at }` shape before Phase 7
    // canonicalised to a bare ISO string; readLastAutoRefreshAt must
    // still parse it so the dedup window survives an in-place upgrade.
    db.prepare(
      `INSERT INTO runtime_state (key, value_json, updated_at)
       VALUES ('today_refresh_auto_at', ?, CURRENT_TIMESTAMP)`,
    ).run(JSON.stringify({ at: NOW.toISOString() }));
    // Drift the same calendar event 1 minute later — the dedup window
    // (5 min) should suppress the second schedule.
    const effects = applyDriftEffects(baseReq(), createdDiff("evt-legacy", "Standup"), {
      db,
      timezone: "UTC",
      now: () => new Date(NOW.getTime() + 60_000),
    });
    expect(effects.todayRefreshScheduled).toBe(false);
  });

  it("readLastAutoRefreshAt treats a non-parseable runtime_state value as null", () => {
    // A corrupted runtime_state row must not poison the dedup logic;
    // readLastAutoRefreshAt returns null and the next tick schedules
    // freely.
    db.prepare(
      `INSERT INTO runtime_state (key, value_json, updated_at)
       VALUES ('today_refresh_auto_at', '"not-a-date"', CURRENT_TIMESTAMP)`,
    ).run();
    const effects = applyDriftEffects(baseReq(), createdDiff("evt-bad-state", "Standup"), {
      db,
      timezone: "UTC",
      now: () => NOW,
    });
    expect(effects.todayRefreshScheduled).toBe(true);
  });

  it("enqueueTodayRefresh skips when a pending today_refresh wake already exists", () => {
    // First drift inserts the wake. A second drift on a *different*
    // event still scheduled for today must NOT enqueue a duplicate; the
    // helper returns `{inserted:false, existing:true}` and the bookkeeping
    // refresh-auto-at flag is updated regardless.
    applyDriftEffects(baseReq(), createdDiff("evt-a", "First"), {
      db,
      timezone: "UTC",
      now: () => NOW,
    });
    // Wipe the dedup flag so we exercise the existing-pending branch
    // (instead of the 5-min dedup short-circuit).
    db.prepare(
      "DELETE FROM runtime_state WHERE key = 'today_refresh_auto_at'",
    ).run();
    const effects = applyDriftEffects(baseReq(), createdDiff("evt-b", "Second"), {
      db,
      timezone: "UTC",
      now: () => new Date(NOW.getTime() + 60_000),
    });
    expect(effects.todayRefreshScheduled).toBe(false);
    const wakeRows = db
      .prepare(
        "SELECT COUNT(*) AS n FROM agent_schedule WHERE task_type = 'wake' AND json_extract(task_context, '$.routine') = 'today_refresh'",
      )
      .get() as { n: number };
    expect(wakeRows.n).toBe(1);
  });

  it("swallows a thrown triggerRoadmapRefresh and continues writing observations", () => {
    // Defensive against a misbehaving roadmap refresh handler — drift
    // effects must not abort the per-change observation loop just because
    // the handler threw.
    const triggerRoadmapRefresh = vi.fn().mockImplementation(() => {
      throw new Error("boom");
    });
    const far = new Date(NOW.getTime() + 20 * 24 * 60 * 60 * 1000).toISOString();
    const effects = applyDriftEffects(
      baseReq(),
      emptyDiff({
        created: [
          {
            itemId: "evt-throw",
            contentHash: "h",
            payload: { summary: "Far trip", start: far },
            itemStart: far,
            actor: "user",
          },
        ],
      }),
      { db, timezone: "UTC", now: () => NOW, triggerRoadmapRefresh },
    );
    expect(effects.observationsWritten).toBe(1);
    expect(effects.roadmapRefreshTriggered).toBe(true);
    expect(triggerRoadmapRefresh).toHaveBeenCalledOnce();
  });

  it("does not schedule today_refresh on a non-24h/14d windowKey (e.g. primary:imminent)", () => {
    // Imminent-window drift should not race the today_refresh scheduling
    // path; the 60s ImminentEventScheduler owns DM-level reminders for
    // that window, and calling today_refresh on every imminent tick would
    // create a hot loop of refreshes.
    const req = { ...baseReq(), windowKey: "primary:imminent" };
    const effects = applyDriftEffects(req, createdDiff("evt-imm", "Standup"), {
      db,
      timezone: "UTC",
      now: () => NOW,
    });
    expect(effects.todayRefreshScheduled).toBe(false);
    expect(effects.todayRefreshPending).toBe(false);
  });

  it("recognises an all-day calendar event by its YYYY-MM-DD start string", () => {
    // Google's `start.date` (no time) ships through the normalizer as a
    // bare YYYY-MM-DD string. startsOnLocalDate fast-paths that shape so
    // the today_refresh scheduler does not depend on timezone math for
    // all-day events.
    const allDay = emptyDiff({
      created: [
        {
          itemId: "evt-allday",
          contentHash: "h",
          payload: {
            summary: "Holiday",
            start: "2026-04-29",
            end: "2026-04-30",
            description: null,
            location: null,
          },
          itemStart: null,
          actor: "user",
        },
      ],
    });
    const effects = applyDriftEffects(baseReq(), allDay, {
      db,
      timezone: "UTC",
      now: () => NOW,
    });
    expect(effects.todayRefreshScheduled).toBe(true);
  });

  it("triggers roadmap refresh when priorPayload is a non-object (primitive) and current is far-future", () => {
    // Pins the `typeof payload !== "object"` branch in extractPayloadStart.
    // When priorPayload is a primitive (e.g. a legacy serialized string), it
    // cannot hold a `start`, so priorStart is null. isBeyondCalendarHorizon(null)
    // returns false, meaning the prior was NOT beyond horizon — refresh fires.
    const farFuture = new Date(NOW.getTime() + 20 * 24 * 60 * 60 * 1000).toISOString();
    const triggerRoadmapRefresh = vi.fn();

    applyDriftEffects(
      baseReq(),
      emptyDiff({
        modified: [
          {
            itemId: "evt-primitive-prior",
            prior: { contentHash: "old", payload: "legacy-opaque-string" },
            current: {
              contentHash: "new",
              payload: { summary: "Far event", start: farFuture, end: farFuture, description: null, location: null },
            },
            itemStart: farFuture,
            actor: "user",
          },
        ],
      }),
      { db, timezone: "UTC", now: () => NOW, triggerRoadmapRefresh },
    );

    // priorStart = null (non-object payload → extractPayloadStart returns null)
    // !isBeyondCalendarHorizon(null) = !false = true → roadmap refresh triggered
    expect(triggerRoadmapRefresh).toHaveBeenCalledWith("calendar_event_detected");
  });

  it("triggers roadmap refresh when priorPayload.start is an empty string and current is far-future", () => {
    // Pins the `start.length > 0` false branch in extractPayloadStart.
    // An empty-string start fails the length check, so priorStart resolves
    // to null. isBeyondCalendarHorizon(null) returns false → refresh fires.
    const farFuture = new Date(NOW.getTime() + 20 * 24 * 60 * 60 * 1000).toISOString();
    const triggerRoadmapRefresh = vi.fn();

    applyDriftEffects(
      baseReq(),
      emptyDiff({
        modified: [
          {
            itemId: "evt-empty-start-prior",
            prior: { contentHash: "old", payload: { summary: "Meeting", start: "" } },
            current: {
              contentHash: "new",
              payload: { summary: "Meeting", start: farFuture, end: farFuture, description: null, location: null },
            },
            itemStart: farFuture,
            actor: "user",
          },
        ],
      }),
      { db, timezone: "UTC", now: () => NOW, triggerRoadmapRefresh },
    );

    // priorStart = null (start.length === 0) → !isBeyondCalendarHorizon(null) = true
    expect(triggerRoadmapRefresh).toHaveBeenCalledWith("calendar_event_detected");
  });

  it("treats a non-object payload as not-on-today (no today_refresh)", () => {
    // Defensive: the calendar drift change payload is JSON-serializable,
    // but a future migration or a fabricated payload could pass `null` /
    // a string. startsOnLocalDate must short-circuit safely without
    // throwing on `payload.start` access.
    const oddPayloadDiff: ReconcileDiff = {
      created: [
        {
          itemId: "evt-odd",
          contentHash: "h",
          payload: null as unknown,
          itemStart: null,
          actor: "user",
        },
      ],
      modified: [],
      deleted: [],
      unchanged: 0,
      prunedOutOfWindow: 0,
      isInitialSnapshot: false,
    };
    const effects = applyDriftEffects(baseReq(), oddPayloadDiff, {
      db,
      timezone: "UTC",
      now: () => NOW,
    });
    expect(effects.todayRefreshScheduled).toBe(false);
  });
});
