import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { CalendarPoller } from "./calendar-poller.js";
import { applySchema } from "../db/schema.js";
import { AgentWriteTracker } from "../safety/agent-write-tracker.js";
import type { CalendarService, CalendarEvent } from "../services/calendar.js";

function makeMockCalendarService(events: CalendarEvent[] = []): CalendarService {
  return {
    available: true,
    init: vi.fn(),
    listEvents: vi.fn().mockResolvedValue(events),
    getEvent: vi.fn(),
    createEvent: vi.fn(),
    updateEvent: vi.fn(),
    deleteEvent: vi.fn(),
    listCalendars: vi.fn(),
    queryFreeBusy: vi.fn(),
  } as unknown as CalendarService;
}

describe("CalendarPoller", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    applySchema(db);
  });

  afterEach(() => {
    db.close();
  });

  it("implements Observer interface", () => {
    const poller = new CalendarPoller(
      makeMockCalendarService(),
      db,
      9999,
      "primary",
    );
    expect(poller.name).toBe("calendar");
    expect(typeof poller.start).toBe("function");
    expect(typeof poller.stop).toBe("function");
  });

  it("stop without start does not throw", async () => {
    const poller = new CalendarPoller(
      makeMockCalendarService(),
      db,
      9999,
      "primary",
    );
    await poller.stop();
  });

  describe("AgentWriteTracker integration", () => {
    it("records actor=user when writeTracker has no mark", async () => {
      const events: CalendarEvent[] = [
        { id: "ev1", summary: "Meeting", start: "2026-01-01T10:00:00Z", end: "2026-01-01T11:00:00Z", description: null, location: null, allDay: false },
      ];
      const calService = makeMockCalendarService(events);
      const tracker = new AgentWriteTracker();
      const poller = new CalendarPoller(calService, db, 9999, "primary", tracker);

      // First poll initializes snapshots
      await poller.start();
      await poller.stop();

      // Second poll with a new event triggers "created" observation
      const newEvents: CalendarEvent[] = [
        ...events,
        { id: "ev2", summary: "New Event", start: "2026-01-01T14:00:00Z", end: "2026-01-01T15:00:00Z", description: null, location: null, allDay: false },
      ];
      (calService.listEvents as ReturnType<typeof vi.fn>).mockResolvedValue(newEvents);

      // Manually trigger poll by starting again (re-initializes and polls)
      // Instead, access the private poll method through a workaround
      await (poller as any).tick();

      // Check observation was recorded with actor=user
      const rows = db.prepare("SELECT * FROM observations WHERE ref = 'ev2'").all() as Array<{ actor: string }>;
      expect(rows).toHaveLength(1);
      expect(rows[0]!.actor).toBe("user");
    });

    it("populates the integration snapshot table on the initial poll", async () => {
      const events: CalendarEvent[] = [
        { id: "ev1", summary: "Meeting", start: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(), end: new Date(Date.now() + 25 * 60 * 60 * 1000).toISOString(), description: null, location: null, allDay: false },
      ];
      const calService = makeMockCalendarService(events);
      const poller = new CalendarPoller(calService, db, 9999, "primary");

      await (poller as any).tick();

      const rows = db
        .prepare(
          "SELECT integration, window_key, item_id FROM integration_snapshots",
        )
        .all() as Array<{
          integration: string;
          window_key: string;
          item_id: string;
        }>;
      expect(rows).toEqual([
        {
          integration: "google_calendar",
          window_key: "primary:14d",
          item_id: "ev1",
        },
      ]);
    });

    it("records actor=agent when writeTracker has a mark for the event", async () => {
      const events: CalendarEvent[] = [
        { id: "ev1", summary: "Meeting", start: "2026-01-01T10:00:00Z", end: "2026-01-01T11:00:00Z", description: null, location: null, allDay: false },
      ];
      const calService = makeMockCalendarService(events);
      const tracker = new AgentWriteTracker();
      const poller = new CalendarPoller(calService, db, 9999, "primary", tracker);

      // First poll initializes snapshots
      await (poller as any).tick();

      // Mark ev_new as agent-written
      tracker.markWriting("calendar:ev_new");

      // Second poll with the new event
      const newEvents: CalendarEvent[] = [
        ...events,
        { id: "ev_new", summary: "Agent Created", start: "2026-01-01T14:00:00Z", end: "2026-01-01T15:00:00Z", description: null, location: null, allDay: false },
      ];
      (calService.listEvents as ReturnType<typeof vi.fn>).mockResolvedValue(newEvents);

      await (poller as any).tick();

      const rows = db.prepare("SELECT * FROM observations WHERE ref = 'ev_new'").all() as Array<{ actor: string }>;
      expect(rows).toHaveLength(1);
      expect(rows[0]!.actor).toBe("agent");
    });

    it("records actor=user for modified events without writeTracker mark", async () => {
      const events: CalendarEvent[] = [
        { id: "ev1", summary: "Meeting", start: "2026-01-01T10:00:00Z", end: "2026-01-01T11:00:00Z", description: null, location: null, allDay: false },
      ];
      const calService = makeMockCalendarService(events);
      const tracker = new AgentWriteTracker();
      const poller = new CalendarPoller(calService, db, 9999, "primary", tracker);

      // First poll
      await (poller as any).tick();

      // Modify the event (user changed it)
      const modifiedEvents: CalendarEvent[] = [
        { id: "ev1", summary: "Updated Meeting", start: "2026-01-01T10:00:00Z", end: "2026-01-01T11:00:00Z", description: null, location: null, allDay: false },
      ];
      (calService.listEvents as ReturnType<typeof vi.fn>).mockResolvedValue(modifiedEvents);

      await (poller as any).tick();

      const rows = db.prepare("SELECT * FROM observations WHERE ref = 'ev1'").all() as Array<{ actor: string; change_type: string }>;
      expect(rows).toHaveLength(1);
      expect(rows[0]!.actor).toBe("user");
      expect(rows[0]!.change_type).toBe("modified");
    });

    it("records actor=agent for modified events with writeTracker mark", async () => {
      const events: CalendarEvent[] = [
        { id: "ev1", summary: "Meeting", start: "2026-01-01T10:00:00Z", end: "2026-01-01T11:00:00Z", description: null, location: null, allDay: false },
      ];
      const calService = makeMockCalendarService(events);
      const tracker = new AgentWriteTracker();
      const poller = new CalendarPoller(calService, db, 9999, "primary", tracker);

      // First poll
      await (poller as any).tick();

      // Agent updates the event
      tracker.markWriting("calendar:ev1");

      const modifiedEvents: CalendarEvent[] = [
        { id: "ev1", summary: "Agent Updated", start: "2026-01-01T10:00:00Z", end: "2026-01-01T11:00:00Z", description: null, location: null, allDay: false },
      ];
      (calService.listEvents as ReturnType<typeof vi.fn>).mockResolvedValue(modifiedEvents);

      await (poller as any).tick();

      const rows = db.prepare("SELECT * FROM observations WHERE ref = 'ev1'").all() as Array<{ actor: string }>;
      expect(rows).toHaveLength(1);
      expect(rows[0]!.actor).toBe("agent");
    });

    it("records actor=user for deleted events without writeTracker mark", async () => {
      const start = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      const end = new Date(Date.now() + 25 * 60 * 60 * 1000).toISOString();
      const events: CalendarEvent[] = [
        { id: "ev1", summary: "Meeting", start, end, description: null, location: null, allDay: false },
      ];
      const calService = makeMockCalendarService(events);
      const tracker = new AgentWriteTracker();
      const poller = new CalendarPoller(calService, db, 9999, "primary", tracker);

      // First poll
      await (poller as any).tick();

      // Event disappears (user deleted)
      (calService.listEvents as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      await (poller as any).tick();

      const rows = db.prepare("SELECT * FROM observations WHERE ref = 'ev1'").all() as Array<{ actor: string; change_type: string }>;
      expect(rows).toHaveLength(1);
      expect(rows[0]!.actor).toBe("user");
      expect(rows[0]!.change_type).toBe("deleted");
    });

    it("records actor=agent for deleted events with writeTracker mark", async () => {
      const start = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      const end = new Date(Date.now() + 25 * 60 * 60 * 1000).toISOString();
      const events: CalendarEvent[] = [
        { id: "ev1", summary: "Meeting", start, end, description: null, location: null, allDay: false },
      ];
      const calService = makeMockCalendarService(events);
      const tracker = new AgentWriteTracker();
      const poller = new CalendarPoller(calService, db, 9999, "primary", tracker);

      // First poll
      await (poller as any).tick();

      // Agent deletes the event
      tracker.markWriting("calendar:ev1");
      (calService.listEvents as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      await (poller as any).tick();

      const rows = db.prepare("SELECT * FROM observations WHERE ref = 'ev1'").all() as Array<{ actor: string; change_type: string }>;
      expect(rows).toHaveLength(1);
      expect(rows[0]!.actor).toBe("agent");
      expect(rows[0]!.change_type).toBe("deleted");
    });

    it("polls with a window wide enough to satisfy the 14d roadmap-refresh trigger", async () => {
      const calService = makeMockCalendarService([]);
      const poller = new CalendarPoller(calService, db, 9999, "primary");
      const before = Date.now();
      await (poller as any).tick();
      const call = (calService.listEvents as ReturnType<typeof vi.fn>).mock.calls[0]!;
      const [timeMin, timeMax] = call as [string, string];
      const minMs = Date.parse(timeMin);
      const maxMs = Date.parse(timeMax);
      const fourteenDaysMs = 14 * 24 * 60 * 60 * 1000;
      expect(minMs).toBeGreaterThanOrEqual(before);
      // The window must strictly exceed 14 days so events at the trigger
      // horizon (`start > now + 14d`) are visible to the diff.
      expect(maxMs - minMs).toBeGreaterThan(fourteenDaysMs);
    });

    it("fires the roadmap-refresh trigger when a new event > 14d out appears", async () => {
      const calService = makeMockCalendarService([]);
      const triggerRoadmapRefresh = vi.fn();
      const poller = new CalendarPoller(
        calService,
        db,
        9999,
        "primary",
        undefined,
        triggerRoadmapRefresh,
      );

      // First poll initializes the snapshot map (no trigger yet).
      await (poller as any).tick();
      expect(triggerRoadmapRefresh).not.toHaveBeenCalled();

      // User creates an event 20 days out. Poll horizon must include it for
      // the diff to see it as "created" and the predicate to fire.
      const startMs = Date.now() + 20 * 24 * 60 * 60 * 1000;
      const farFutureStart = new Date(startMs).toISOString();
      const farFutureEnd = new Date(startMs + 60 * 60 * 1000).toISOString();
      (calService.listEvents as ReturnType<typeof vi.fn>).mockResolvedValue([
        { id: "ev_far", summary: "Trip to LA", start: farFutureStart, end: farFutureEnd, description: null, location: null, allDay: false },
      ]);

      await (poller as any).tick();

      expect(triggerRoadmapRefresh).toHaveBeenCalledOnce();
      expect(triggerRoadmapRefresh).toHaveBeenCalledWith("calendar_event_detected");
    });

    it("does NOT fire the trigger for new events within 14d (predicate guard)", async () => {
      const calService = makeMockCalendarService([]);
      const triggerRoadmapRefresh = vi.fn();
      const poller = new CalendarPoller(
        calService,
        db,
        9999,
        "primary",
        undefined,
        triggerRoadmapRefresh,
      );

      await (poller as any).tick();

      // Event 5 days out — well inside the poll horizon, but the trigger
      // predicate requires > 14d, so the callback must stay quiet.
      const startMs = Date.now() + 5 * 24 * 60 * 60 * 1000;
      (calService.listEvents as ReturnType<typeof vi.fn>).mockResolvedValue([
        { id: "ev_near", summary: "Lunch", start: new Date(startMs).toISOString(), end: new Date(startMs + 60 * 60 * 1000).toISOString(), description: null, location: null, allDay: false },
      ]);

      await (poller as any).tick();

      expect(triggerRoadmapRefresh).not.toHaveBeenCalled();
    });

    it("works without writeTracker (backward compatibility)", async () => {
      const events: CalendarEvent[] = [
        { id: "ev1", summary: "Meeting", start: "2026-01-01T10:00:00Z", end: "2026-01-01T11:00:00Z", description: null, location: null, allDay: false },
      ];
      const calService = makeMockCalendarService(events);
      // No writeTracker passed
      const poller = new CalendarPoller(calService, db, 9999, "primary");

      await (poller as any).tick();

      // Add a new event
      (calService.listEvents as ReturnType<typeof vi.fn>).mockResolvedValue([
        ...events,
        { id: "ev2", summary: "New", start: "2026-01-01T14:00:00Z", end: "2026-01-01T15:00:00Z", description: null, location: null, allDay: false },
      ]);
      await (poller as any).tick();

      const rows = db.prepare("SELECT * FROM observations WHERE ref = 'ev2'").all() as Array<{ actor: string }>;
      expect(rows).toHaveLength(1);
      expect(rows[0]!.actor).toBe("user");
    });
  });
});
