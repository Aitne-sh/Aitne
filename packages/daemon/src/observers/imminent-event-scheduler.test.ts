import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { EventPriority, type CalendarChangeEvent } from "@aitne/shared";
import { applySchema } from "../db/schema.js";
import type { EventBus } from "../core/event-bus.js";
import { ImminentEventScheduler } from "./imminent-event-scheduler.js";

const NOW = new Date("2026-04-29T12:00:00.000Z");

function makeBus(): EventBus {
  return {
    put: vi.fn().mockResolvedValue(undefined),
    take: vi.fn(),
    size: vi.fn(),
  } as unknown as EventBus;
}

function insertSnapshot(
  db: Database.Database,
  itemId: string,
  start: string,
  payload: Record<string, unknown> = {},
): void {
  db.prepare(
    `INSERT INTO integration_snapshots
       (integration, window_key, item_id, content_hash, payload_json, item_start, fetched_at, actor_hint)
     VALUES ('google_calendar', 'primary:14d', ?, ?, ?, ?, ?, 'user')`,
  ).run(
    itemId,
    `${itemId}-hash`,
    JSON.stringify({
      summary: itemId,
      start,
      end: new Date(Date.parse(start) + 30 * 60 * 1000).toISOString(),
      ...payload,
    }),
    start,
    NOW.toISOString(),
  );
}

describe("ImminentEventScheduler", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    applySchema(db);
  });

  afterEach(() => {
    db.close();
  });

  it("emits schedule.approaching for events in (now, now+15min]", async () => {
    const bus = makeBus();
    insertSnapshot(db, "evt-1", new Date(NOW.getTime() + 10 * 60 * 1000).toISOString(), {
      summary: "Standup",
    });
    insertSnapshot(db, "evt-late", new Date(NOW.getTime() + 16 * 60 * 1000).toISOString());

    const scheduler = new ImminentEventScheduler(db, bus, "primary", 60, () => NOW);
    await scheduler.tick();

    expect(bus.put).toHaveBeenCalledTimes(1);
    const event = (bus.put as ReturnType<typeof vi.fn>).mock.calls[0][0] as CalendarChangeEvent;
    expect(event.type).toBe("schedule.approaching");
    expect(event.priority).toBe(EventPriority.HIGH);
    expect(event.calendarId).toBe("primary");
    expect(event.eventTitle).toBe("Standup");
    expect(event.data.calendarEventId).toBe("evt-1");
    expect(event.data.minutesUntil).toBe(10);
  });

  it("does not emit duplicates for the same event id", async () => {
    const bus = makeBus();
    insertSnapshot(db, "evt-1", new Date(NOW.getTime() + 10 * 60 * 1000).toISOString());

    const scheduler = new ImminentEventScheduler(db, bus, "primary", 60, () => NOW);
    await scheduler.tick();
    await scheduler.tick();

    expect(bus.put).toHaveBeenCalledTimes(1);
  });

  it("ignores events at or before now", async () => {
    const bus = makeBus();
    insertSnapshot(db, "evt-now", NOW.toISOString());
    insertSnapshot(db, "evt-past", new Date(NOW.getTime() - 60_000).toISOString());

    const scheduler = new ImminentEventScheduler(db, bus, "primary", 60, () => NOW);
    await scheduler.tick();

    expect(bus.put).not.toHaveBeenCalled();
  });

  it("Phase 7 (d): persistent dedup survives a daemon restart — a fresh scheduler does not re-emit", async () => {
    const start = new Date(NOW.getTime() + 10 * 60 * 1000).toISOString();
    insertSnapshot(db, "evt-imm", start, { summary: "Standup" });

    // First "process": tick, get one emit, write the dedup row.
    const bus1 = makeBus();
    const sched1 = new ImminentEventScheduler(db, bus1, "primary", 60, () => NOW);
    await sched1.tick();
    expect(bus1.put).toHaveBeenCalledTimes(1);
    const dedup = db
      .prepare("SELECT item_id FROM imminent_event_notifications")
      .all() as Array<{ item_id: string }>;
    expect(dedup).toEqual([{ item_id: "evt-imm" }]);

    // Second "process" (simulated restart): a fresh scheduler against the
    // SAME db must NOT re-emit because the dedup row persists across the
    // restart. Pre-Phase-7 this re-DMed the user.
    const bus2 = makeBus();
    const sched2 = new ImminentEventScheduler(db, bus2, "primary", 60, () => NOW);
    await sched2.tick();
    expect(bus2.put).not.toHaveBeenCalled();
  });

  it("Phase 7 (d): events with malformed payload_json are skipped without writing a dedup row", async () => {
    insertSnapshot(db, "evt-bad", new Date(NOW.getTime() + 10 * 60 * 1000).toISOString());
    db.prepare(
      "UPDATE integration_snapshots SET payload_json = ? WHERE item_id = ?",
    ).run("{not json", "evt-bad");

    const bus = makeBus();
    const scheduler = new ImminentEventScheduler(db, bus, "primary", 60, () => NOW);
    await scheduler.tick();

    expect(bus.put).not.toHaveBeenCalled();
    // Dedup must NOT be set — a recoverable upstream that re-snapshots
    // the event with valid JSON should be picked up on the next tick.
    const dedup = db
      .prepare("SELECT COUNT(*) AS n FROM imminent_event_notifications")
      .get() as { n: number };
    expect(dedup.n).toBe(0);
  });

  it("Phase 7 (d): malformed item_start (non-parseable) is skipped without writing a dedup row", async () => {
    db.prepare(
      `INSERT INTO integration_snapshots
         (integration, window_key, item_id, content_hash, payload_json, item_start, fetched_at, actor_hint)
       VALUES ('google_calendar', 'primary:14d', 'evt-bad-start', 'h', '{}', 'not-an-iso', ?, 'user')`,
    ).run(NOW.toISOString());

    const bus = makeBus();
    const scheduler = new ImminentEventScheduler(db, bus, "primary", 60, () => NOW);
    await scheduler.tick();

    expect(bus.put).not.toHaveBeenCalled();
    const dedup = db
      .prepare("SELECT COUNT(*) AS n FROM imminent_event_notifications")
      .get() as { n: number };
    expect(dedup.n).toBe(0);
  });

  it("defensively skips snapshot rows whose item_start parses to NaN", async () => {
    // The SQL gate uses lexical string comparison, so a malformed item_start
    // can still pass `now < item_start <= max` while Date.parse returns NaN.
    // The JS-level `Number.isFinite(startMs)` guard is what catches it. Using
    // a value that lex-sorts inside the window:
    //   '2026-04-29T12:10:00ZX' > '2026-04-29T12:00:00.000Z' AND
    //   '2026-04-29T12:10:00ZX' <= '2026-04-29T12:15:00.000Z'
    // but Date.parse returns NaN.
    db.prepare(
      `INSERT INTO integration_snapshots
         (integration, window_key, item_id, content_hash, payload_json, item_start, fetched_at, actor_hint)
       VALUES ('google_calendar', 'primary:14d', 'evt-bad', 'h', '{}', ?, ?, 'user')`,
    ).run("2026-04-29T12:10:00ZX", NOW.toISOString());

    const bus = makeBus();
    const scheduler = new ImminentEventScheduler(db, bus, "primary", 60, () => NOW);
    await scheduler.tick();

    expect(bus.put).not.toHaveBeenCalled();
    const dedup = db
      .prepare("SELECT COUNT(*) AS n FROM imminent_event_notifications")
      .get() as { n: number };
    expect(dedup.n).toBe(0);
  });

  it("defensively skips rows whose chronological time falls outside the (now, +15m] window despite passing the lex SQL filter", async () => {
    // Lex compare ≠ chrono compare when timezone offsets differ. A +05:30
    // ISO string can lex-fall inside (now-iso, max-iso] while pointing to
    // a chrono time hours before now — the JS-level minutesUntil guard
    // (minutesUntil <= 0 || > 15) is the safety net.
    //   '2026-04-29T12:14:00+05:30' (06:44:00Z) is BEFORE NOW=12:00:00Z
    //   yet '12:14:00+05:30' lex-sorts inside (12:00, 12:15].
    db.prepare(
      `INSERT INTO integration_snapshots
         (integration, window_key, item_id, content_hash, payload_json, item_start, fetched_at, actor_hint)
       VALUES ('google_calendar', 'primary:14d', 'evt-tz', 'h', '{}', ?, ?, 'user')`,
    ).run("2026-04-29T12:14:00+05:30", NOW.toISOString());

    const bus = makeBus();
    const scheduler = new ImminentEventScheduler(db, bus, "primary", 60, () => NOW);
    await scheduler.tick();

    expect(bus.put).not.toHaveBeenCalled();
    const dedup = db
      .prepare("SELECT COUNT(*) AS n FROM imminent_event_notifications")
      .get() as { n: number };
    expect(dedup.n).toBe(0);
  });

  it("uses payload.end when provided to populate endTime on the emitted event", async () => {
    const start = new Date(NOW.getTime() + 5 * 60 * 1000).toISOString();
    const end = new Date(NOW.getTime() + 35 * 60 * 1000).toISOString();
    insertSnapshot(db, "evt-end", start, { summary: "Standup", end });

    const bus = makeBus();
    const scheduler = new ImminentEventScheduler(db, bus, "primary", 60, () => NOW);
    await scheduler.tick();

    expect(bus.put).toHaveBeenCalledTimes(1);
    const event = (bus.put as ReturnType<typeof vi.fn>).mock.calls[0][0] as CalendarChangeEvent;
    expect(event.endTime).toBeInstanceOf(Date);
    expect((event.endTime as Date).toISOString()).toBe(end);
    expect(event.data.endTime).toBe(end);
  });

  it("falls back to '' / 'Untitled Event' / null when payload fields are missing", async () => {
    // Branch coverage for the optional chain on payload.summary, payload.end,
    // and the start-time fallback to row.item_start.
    const start = new Date(NOW.getTime() + 5 * 60 * 1000).toISOString();
    db.prepare(
      `INSERT INTO integration_snapshots
         (integration, window_key, item_id, content_hash, payload_json, item_start, fetched_at, actor_hint)
       VALUES ('google_calendar', 'primary:14d', 'evt-empty', 'h', '{}', ?, ?, 'user')`,
    ).run(start, NOW.toISOString());

    const bus = makeBus();
    const scheduler = new ImminentEventScheduler(db, bus, "primary", 60, () => NOW);
    await scheduler.tick();

    expect(bus.put).toHaveBeenCalledTimes(1);
    const event = (bus.put as ReturnType<typeof vi.fn>).mock.calls[0][0] as CalendarChangeEvent;
    expect(event.eventTitle).toBe("Untitled Event");
    expect(event.endTime).toBeNull();
    expect(event.data.summary).toBe("");
    expect(event.data.startTime).toBe(start);
    expect(event.data.endTime).toBeNull();
  });

  // ── Native mode source (Finding 1, 2026-05-13) ────────────────────────────
  //
  // `INTEGRATION_SNAPSHOT_PARTITIONS_BY_MODE[google_calendar].native = []` —
  // native-mode calendar writes land in the `observations` table via the
  // agent's `routine.fetch_window` pre-pass POSTs. Without observation-table
  // coverage the scheduler silently misses every 15-min reminder in native
  // mode (the bug this group of tests pins down).

  function insertObservation(
    db: Database.Database,
    ref: string,
    start: string,
    raw: Record<string, unknown> = {},
  ): void {
    db.prepare(
      `INSERT INTO observations
         (source, ref, change_type, actor, observed_at, payload)
       VALUES ('google_calendar:primary', ?, 'created', 'agent', ?, ?)`,
    ).run(
      ref,
      NOW.toISOString(),
      JSON.stringify({
        kind: "calendar",
        providerId: "primary",
        raw: {
          title: ref,
          start,
          end: new Date(Date.parse(start) + 30 * 60 * 1000).toISOString(),
          ...raw,
        },
      }),
    );
  }

  it("falls back to raw.summary when raw.title is missing on a native observation", async () => {
    const bus = makeBus();
    insertObservation(db, "evt-native-summary", new Date(NOW.getTime() + 10 * 60 * 1000).toISOString(), {
      title: undefined,
      summary: "Summary-only event",
    });
    const scheduler = new ImminentEventScheduler(db, bus, "primary", 60, () => NOW);
    await scheduler.tick();
    expect(bus.put).toHaveBeenCalledTimes(1);
    const event = (bus.put as ReturnType<typeof vi.fn>).mock.calls[0][0] as CalendarChangeEvent;
    expect(event.eventTitle).toBe("Summary-only event");
  });

  it("emits schedule.approaching for native-mode observations (snapshot table empty)", async () => {
    const bus = makeBus();
    insertObservation(db, "evt-native-1", new Date(NOW.getTime() + 12 * 60 * 1000).toISOString(), {
      title: "Customer call",
    });
    insertObservation(db, "evt-native-late", new Date(NOW.getTime() + 30 * 60 * 1000).toISOString());

    const scheduler = new ImminentEventScheduler(db, bus, "primary", 60, () => NOW);
    await scheduler.tick();

    expect(bus.put).toHaveBeenCalledTimes(1);
    const event = (bus.put as ReturnType<typeof vi.fn>).mock.calls[0][0] as CalendarChangeEvent;
    expect(event.type).toBe("schedule.approaching");
    expect(event.eventTitle).toBe("Customer call");
    expect(event.data.calendarEventId).toBe("evt-native-1");
    expect(event.data.minutesUntil).toBe(12);
  });

  it("skips observations whose source is NOT google_calendar (defensive)", async () => {
    // The observation table is a shared surface — mail / notion / other
    // sources land here too. The scheduler must filter by source prefix
    // so a `gmail:` row with a synthetic `raw.start` shape (defensively
    // impossible but cheap to assert) never trips the imminent path.
    const bus = makeBus();
    db.prepare(
      `INSERT INTO observations (source, ref, change_type, actor, observed_at, payload)
       VALUES ('gmail:acc1', 'msg-1', 'created', 'agent', ?, ?)`,
    ).run(
      NOW.toISOString(),
      JSON.stringify({ kind: "calendar", providerId: "x", raw: { start: new Date(NOW.getTime() + 5 * 60 * 1000).toISOString() } }),
    );
    const scheduler = new ImminentEventScheduler(db, bus, "primary", 60, () => NOW);
    await scheduler.tick();
    expect(bus.put).not.toHaveBeenCalled();
  });

  it("skips consumed observations (the morning routine already processed the row)", async () => {
    const bus = makeBus();
    const start = new Date(NOW.getTime() + 10 * 60 * 1000).toISOString();
    db.prepare(
      `INSERT INTO observations
         (source, ref, change_type, actor, observed_at, payload, consumed_at, consumed_by)
       VALUES ('google_calendar:primary', 'evt-consumed', 'created', 'agent', ?, ?, ?, 'morning-routine')`,
    ).run(
      NOW.toISOString(),
      JSON.stringify({ kind: "calendar", providerId: "primary", raw: { title: "Old", start, end: start } }),
      NOW.toISOString(),
    );
    const scheduler = new ImminentEventScheduler(db, bus, "primary", 60, () => NOW);
    await scheduler.tick();
    expect(bus.put).not.toHaveBeenCalled();
  });

  it("dedupes cross-source duplicates: same event id in both snapshots and observations fires once", async () => {
    // Mode-flip transition window scenario: direct→native flip leaves a
    // snapshot row in place (the `partitionsToPurge` cleanup is best-
    // effort) while the agent's first native pre-pass also posts the
    // same event to observations. Both queries surface the row; the
    // scheduler must emit exactly one `schedule.approaching` and write
    // a single `imminent_event_notifications` entry.
    const bus = makeBus();
    const start = new Date(NOW.getTime() + 10 * 60 * 1000).toISOString();
    insertSnapshot(db, "evt-shared", start, { summary: "Sync" });
    insertObservation(db, "evt-shared", start, { title: "Sync" });

    const scheduler = new ImminentEventScheduler(db, bus, "primary", 60, () => NOW);
    await scheduler.tick();

    expect(bus.put).toHaveBeenCalledTimes(1);
    const notified = db
      .prepare("SELECT COUNT(*) AS n FROM imminent_event_notifications WHERE item_id = ?")
      .get("evt-shared") as { n: number };
    expect(notified.n).toBe(1);
  });

  it("dedupe survives a second tick: a notified native-observation row is not re-emitted", async () => {
    const bus = makeBus();
    insertObservation(db, "evt-native-redup", new Date(NOW.getTime() + 10 * 60 * 1000).toISOString());

    const scheduler = new ImminentEventScheduler(db, bus, "primary", 60, () => NOW);
    await scheduler.tick();
    await scheduler.tick();

    expect(bus.put).toHaveBeenCalledTimes(1);
  });

  it("matches native observations whose start carries a timezone offset (RFC 3339 -hh:mm form)", async () => {
    // Issue A1 (2026-05-13) — Google Calendar MCPs typically return
    // `raw.start` as RFC 3339 with offset (`2026-04-29T08:00:00-04:00`
    // = 12:00 UTC). A naive lexicographic compare against the UTC-Z
    // `now.toISOString()` parameter would silently drop this row from
    // the imminent window even though the same UTC instant on the
    // snapshot path would fire. The query wraps both sides in
    // `datetime()` so the comparison normalises to UTC and works
    // across formats.
    const bus = makeBus();
    // NOW is 2026-04-29T12:00:00Z. An event at 12:10 UTC expressed as
    // EDT (-04:00) is "08:10-04:00" — lex-before "12:00..." but the
    // SAME instant + 10 min.
    const startOffset = "2026-04-29T08:10:00-04:00";
    db.prepare(
      `INSERT INTO observations (source, ref, change_type, actor, observed_at, payload)
       VALUES ('google_calendar:primary', 'evt-offset', 'created', 'agent', ?, ?)`,
    ).run(
      NOW.toISOString(),
      JSON.stringify({
        kind: "calendar",
        providerId: "primary",
        raw: {
          title: "EDT event",
          start: startOffset,
          end: "2026-04-29T08:40:00-04:00",
        },
      }),
    );
    const scheduler = new ImminentEventScheduler(db, bus, "primary", 60, () => NOW);
    await scheduler.tick();
    expect(bus.put).toHaveBeenCalledTimes(1);
    const event = (bus.put as ReturnType<typeof vi.fn>).mock.calls[0][0] as CalendarChangeEvent;
    expect(event.data.calendarEventId).toBe("evt-offset");
    expect(event.data.minutesUntil).toBe(10);
  });

  it("skips native observations with malformed payload JSON without writing a dedup row", async () => {
    const bus = makeBus();
    db.prepare(
      `INSERT INTO observations (source, ref, change_type, actor, observed_at, payload)
       VALUES ('google_calendar:primary', 'evt-bad-json', 'created', 'agent', ?, ?)`,
    ).run(NOW.toISOString(), '{"kind":"calendar","raw":{"start":"' + new Date(NOW.getTime() + 5 * 60 * 1000).toISOString() + '"}'); // missing closing brace
    const scheduler = new ImminentEventScheduler(db, bus, "primary", 60, () => NOW);
    await scheduler.tick();
    expect(bus.put).not.toHaveBeenCalled();
    const notified = db
      .prepare("SELECT COUNT(*) AS n FROM imminent_event_notifications WHERE item_id = 'evt-bad-json'")
      .get() as { n: number };
    expect(notified.n).toBe(0);
  });

  it("Phase 7 (d): start() runs an initial tick and registers a periodic timer; stop() clears it", async () => {
    const bus = makeBus();
    const scheduler = new ImminentEventScheduler(db, bus, "primary", 3600, () => NOW);
    try {
      await scheduler.start();
      // Initial tick has run — even with no rows the start logs without throwing.
      // No assertion on bus.put count needed; this exercises the start/stop branches.
    } finally {
      await scheduler.stop();
      await scheduler.stop();
    }
  });

  it("uses real `new Date()` when no `now` injection is supplied", async () => {
    // Constructing without the optional `now` arg covers the default-parameter
    // arrow `() => new Date()`. We then run a tick: with no rows the SQL
    // returns empty and the function returns early without observable side
    // effects, so the assertion is simply that the constructor + first tick
    // do not throw and bus.put is untouched.
    const bus = makeBus();
    const scheduler = new ImminentEventScheduler(db, bus, "primary", 60);
    await expect(scheduler.tick()).resolves.toBeUndefined();
    expect(bus.put).not.toHaveBeenCalled();
  });

  it("swallows + logs runTick errors so a failed tick never propagates out of tick()", async () => {
    // Close the DB while the scheduler still holds a reference — the next
    // `db.prepare(...)` inside `runTick` throws, the PollGuard re-throws,
    // and the outer `try/catch` in `tick()` must log + recover. Without
    // this guard the timer's `() => void this.tick()` would surface an
    // unhandled rejection on every tick after a transient DB failure.
    const bus = makeBus();
    const scheduler = new ImminentEventScheduler(db, bus, "primary", 60, () => NOW);
    db.close();
    await expect(scheduler.tick()).resolves.toBeUndefined();
    expect(bus.put).not.toHaveBeenCalled();
    // Re-open a fresh DB so afterEach's close() does not throw on the
    // already-closed handle.
    db = new Database(":memory:");
    applySchema(db);
  });

  it("aborts mid-loop when stop() fires between row emits (signal.aborted breaks the for-loop)", async () => {
    // Two rows in the imminent window. The first bus.put() invocation
    // calls scheduler.stop(), which aborts the PollGuard signal. The
    // `if (signal.aborted) return;` check at the top of the next
    // iteration short-circuits, so only one event is emitted even though
    // both rows passed the SQL filter. Without this signal check, a
    // long-running tick could keep emitting after the observer has
    // been shut down.
    const bus = makeBus();
    insertSnapshot(db, "evt-A", new Date(NOW.getTime() + 5 * 60 * 1000).toISOString());
    insertSnapshot(db, "evt-B", new Date(NOW.getTime() + 10 * 60 * 1000).toISOString());

    const scheduler = new ImminentEventScheduler(db, bus, "primary", 60, () => NOW);
    (bus.put as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      await scheduler.stop();
    });
    await scheduler.tick();
    expect(bus.put).toHaveBeenCalledTimes(1);
  });

  it("invokes the periodic tick callback registered by start()", async () => {
    vi.useFakeTimers();
    try {
      const bus = makeBus();
      // 1-second interval so the setInterval callback runs without a long wait.
      const scheduler = new ImminentEventScheduler(db, bus, "primary", 1, () => NOW);
      const tickSpy = vi.spyOn(scheduler, "tick");
      await scheduler.start();
      // start() ran one initial tick (call 1).
      expect(tickSpy).toHaveBeenCalledTimes(1);
      // Advance the timer so the setInterval arrow `() => void this.tick()`
      // fires, exercising the otherwise-uncovered timer callback function.
      await vi.advanceTimersByTimeAsync(1_000);
      expect(tickSpy).toHaveBeenCalledTimes(2);
      await scheduler.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
