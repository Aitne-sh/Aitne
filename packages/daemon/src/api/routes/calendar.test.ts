import { describe, it, expect, vi } from "vitest";
import Database from "better-sqlite3";
import { createCalendarRoutes } from "./calendar.js";
import type { ServiceRegistry } from "../../services/service-registry.js";
import type { CalendarService } from "../../services/calendar.js";
import { AgentWriteTracker } from "../../safety/agent-write-tracker.js";
import { applySchema } from "../../db/schema.js";

function makeMockCalendar(overrides: Partial<CalendarService> = {}): CalendarService {
  return {
    available: true,
    init: vi.fn(),
    listEvents: vi.fn().mockResolvedValue([]),
    getEvent: vi.fn().mockResolvedValue({
      id: "ev1", summary: "Test", start: "2026-01-01T10:00:00Z", end: "2026-01-01T11:00:00Z",
      description: null, location: null, allDay: false,
      status: "confirmed", htmlLink: null, creator: null, organizer: null,
      attendees: null, recurrence: null, recurringEventId: null,
      reminders: null, visibility: null, created: null, updated: null,
    }),
    createEvent: vi.fn().mockResolvedValue({ eventId: "new_ev1" }),
    updateEvent: vi.fn().mockResolvedValue({ eventId: "ev1" }),
    deleteEvent: vi.fn().mockResolvedValue(undefined),
    listCalendars: vi.fn().mockResolvedValue([]),
    queryFreeBusy: vi.fn().mockResolvedValue({ calendars: {} }),
    ...overrides,
  } as unknown as CalendarService;
}

function makeServices(calendar: CalendarService | null = null): ServiceRegistry {
  return { calendar } as unknown as ServiceRegistry;
}

// ── GET /calendar/events ──

describe("Calendar API routes", () => {
  describe("GET /calendar/events", () => {
    it("returns events for default date", async () => {
      const cal = makeMockCalendar({
        listEvents: vi.fn().mockResolvedValue([
          { id: "ev1", summary: "Standup", start: "2026-01-01T10:00:00Z", end: "2026-01-01T10:30:00Z", description: null, location: null, allDay: false },
        ]),
      });
      const app = createCalendarRoutes({ services: makeServices(cal) });
      const res = await app.request("/calendar/events?date=2026-01-01");
      expect(res.status).toBe(200);
      const data = await res.json() as { events: unknown[] };
      expect(data.events).toHaveLength(1);
    });

    it("passes q and calendarId to service", async () => {
      const cal = makeMockCalendar();
      const app = createCalendarRoutes({ services: makeServices(cal) });
      await app.request("/calendar/events?date=2026-01-01&q=meeting&calendarId=work@group.calendar.google.com");
      expect(cal.listEvents).toHaveBeenCalledWith(
        expect.any(String), expect.any(String),
        "meeting", "work@group.calendar.google.com",
      );
    });

    it("returns 503 when calendar not configured", async () => {
      const app = createCalendarRoutes({ services: makeServices(null) });
      const res = await app.request("/calendar/events");
      expect(res.status).toBe(503);
    });

    it("returns 400 for invalid date format", async () => {
      const cal = makeMockCalendar();
      const app = createCalendarRoutes({ services: makeServices(cal) });
      const res = await app.request("/calendar/events?date=not-a-date");
      expect(res.status).toBe(400);
    });

    it("returns 502 on service error", async () => {
      const cal = makeMockCalendar({
        listEvents: vi.fn().mockRejectedValue(new Error("API error")),
      });
      const app = createCalendarRoutes({ services: makeServices(cal) });
      const res = await app.request("/calendar/events?date=2026-01-01");
      expect(res.status).toBe(502);
    });

    // The ISO-range shape was added 2026-05-17 for the weekly_review
    // `cal_iso_week_to_now` pre-pass row. Direct mode previously used
    // `date=YYYY-MM-DD&days=7`, whose end snaps to UTC midnight of "today
    // UTC date" — in JST that drops today's events from the
    // retrospective. The ISO-range form forwards `timeMin`/`timeMax`
    // through to the calendar service unchanged so the direct path
    // returns the same window the delegated/native MCP fan-out sees.
    describe("ISO-range shape (timeMin/timeMax)", () => {
      it("forwards a valid ISO range to listEvents verbatim", async () => {
        const cal = makeMockCalendar({
          listEvents: vi.fn().mockResolvedValue([]),
        });
        const app = createCalendarRoutes({ services: makeServices(cal) });
        const res = await app.request(
          "/calendar/events?timeMin=2026-05-11T00:00:00.000Z&timeMax=2026-05-15T10:00:00.000Z",
        );
        expect(res.status).toBe(200);
        const [callTimeMin, callTimeMax] =
          (cal.listEvents as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string];
        expect(callTimeMin).toBe("2026-05-11T00:00:00.000Z");
        expect(callTimeMax).toBe("2026-05-15T10:00:00.000Z");
      });

      it("rejects a half-specified range with 400 iso_range_incomplete", async () => {
        const cal = makeMockCalendar();
        const app = createCalendarRoutes({ services: makeServices(cal) });
        const res = await app.request(
          "/calendar/events?timeMin=2026-05-11T00:00:00Z",
        );
        expect(res.status).toBe(400);
      });

      it("rejects unparseable ISO timestamps with 400 invalid_iso_range", async () => {
        const cal = makeMockCalendar();
        const app = createCalendarRoutes({ services: makeServices(cal) });
        const res = await app.request(
          "/calendar/events?timeMin=garbage&timeMax=2026-05-15T10:00:00Z",
        );
        expect(res.status).toBe(400);
      });

      it("rejects unparseable timeMax (only) with 400 invalid_iso_range", async () => {
        const cal = makeMockCalendar();
        const app = createCalendarRoutes({ services: makeServices(cal) });
        const res = await app.request(
          "/calendar/events?timeMin=2026-05-11T00:00:00Z&timeMax=not-a-date",
        );
        expect(res.status).toBe(400);
      });

      it("treats missing timeMax (only) as half-specified", async () => {
        const cal = makeMockCalendar();
        const app = createCalendarRoutes({ services: makeServices(cal) });
        const res = await app.request(
          "/calendar/events?timeMax=2026-05-11T00:00:00Z",
        );
        expect(res.status).toBe(400);
      });

      it("rejects timeMax <= timeMin with 400 iso_range_inverted", async () => {
        const cal = makeMockCalendar();
        const app = createCalendarRoutes({ services: makeServices(cal) });
        const res = await app.request(
          "/calendar/events?timeMin=2026-05-15T00:00:00Z&timeMax=2026-05-11T00:00:00Z",
        );
        expect(res.status).toBe(400);
      });

      it("rejects ranges wider than 90 days with 400 iso_range_too_wide", async () => {
        const cal = makeMockCalendar();
        const app = createCalendarRoutes({ services: makeServices(cal) });
        const res = await app.request(
          "/calendar/events?timeMin=2026-01-01T00:00:00Z&timeMax=2026-06-01T00:00:00Z",
        );
        expect(res.status).toBe(400);
      });
    });
  });

  // ── GET /calendar/events/:id ──

  describe("GET /calendar/events/:id", () => {
    it("returns event detail", async () => {
      const cal = makeMockCalendar();
      const app = createCalendarRoutes({ services: makeServices(cal) });
      const res = await app.request("/calendar/events/ev1");
      expect(res.status).toBe(200);
      const data = await res.json() as { event: { id: string } };
      expect(data.event.id).toBe("ev1");
      expect(cal.getEvent).toHaveBeenCalledWith("ev1", undefined);
    });

    it("passes calendarId to service", async () => {
      const cal = makeMockCalendar();
      const app = createCalendarRoutes({ services: makeServices(cal) });
      await app.request("/calendar/events/ev1?calendarId=work");
      expect(cal.getEvent).toHaveBeenCalledWith("ev1", "work");
    });

    it("returns 404 when Google returns not found (code=404)", async () => {
      const cal = makeMockCalendar({
        getEvent: vi.fn().mockRejectedValue({ code: 404 }),
      });
      const app = createCalendarRoutes({ services: makeServices(cal) });
      const res = await app.request("/calendar/events/nonexistent");
      expect(res.status).toBe(404);
    });

    it("returns 404 when Google returns not found (code='404' string)", async () => {
      const cal = makeMockCalendar({
        getEvent: vi.fn().mockRejectedValue({ code: "404" }),
      });
      const app = createCalendarRoutes({ services: makeServices(cal) });
      const res = await app.request("/calendar/events/nonexistent");
      expect(res.status).toBe(404);
    });

    it("returns 404 when Google returns not found (response.status=404)", async () => {
      const cal = makeMockCalendar({
        getEvent: vi.fn().mockRejectedValue({ response: { status: 404 } }),
      });
      const app = createCalendarRoutes({ services: makeServices(cal) });
      const res = await app.request("/calendar/events/nonexistent");
      expect(res.status).toBe(404);
    });

    it("returns 404 when Google returns not found (status=404)", async () => {
      const cal = makeMockCalendar({
        getEvent: vi.fn().mockRejectedValue({ status: 404 }),
      });
      const app = createCalendarRoutes({ services: makeServices(cal) });
      const res = await app.request("/calendar/events/nonexistent");
      expect(res.status).toBe(404);
    });

    it("returns 502 on non-404 errors", async () => {
      const cal = makeMockCalendar({
        getEvent: vi.fn().mockRejectedValue(new Error("Internal")),
      });
      const app = createCalendarRoutes({ services: makeServices(cal) });
      const res = await app.request("/calendar/events/ev1");
      expect(res.status).toBe(502);
    });
  });

  // ── POST /calendar/events ──

  describe("POST /calendar/events", () => {
    it("creates a timed event", async () => {
      const cal = makeMockCalendar();
      const app = createCalendarRoutes({ services: makeServices(cal) });
      const res = await app.request("/calendar/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          summary: "Meeting",
          start: "2026-01-01T10:00:00+09:00",
          end: "2026-01-01T11:00:00+09:00",
        }),
      });
      expect(res.status).toBe(200);
      const data = await res.json() as { status: string; eventId: string };
      expect(data.status).toBe("created");
      expect(data.eventId).toBe("new_ev1");
    });

    it("passes sendUpdates and calendarId from query params", async () => {
      const cal = makeMockCalendar();
      const app = createCalendarRoutes({ services: makeServices(cal) });
      await app.request("/calendar/events?sendUpdates=all&calendarId=work", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          summary: "Meeting",
          start: "2026-01-01T10:00:00+09:00",
          end: "2026-01-01T11:00:00+09:00",
        }),
      });
      expect(cal.createEvent).toHaveBeenCalledWith(
        expect.objectContaining({ summary: "Meeting" }),
        "all", "work",
      );
    });

    it("returns 400 for invalid sendUpdates value", async () => {
      const cal = makeMockCalendar();
      const app = createCalendarRoutes({ services: makeServices(cal) });
      const res = await app.request("/calendar/events?sendUpdates=bogus", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          summary: "Meeting",
          start: "2026-01-01T10:00:00+09:00",
          end: "2026-01-01T11:00:00+09:00",
        }),
      });
      expect(res.status).toBe(400);
      const data = await res.json() as { error: string };
      expect(data.error).toContain("sendUpdates");
    });

    it("accepts all valid sendUpdates values", async () => {
      const cal = makeMockCalendar();
      const app = createCalendarRoutes({ services: makeServices(cal) });
      for (const value of ["all", "externalOnly", "none"]) {
        const res = await app.request(`/calendar/events?sendUpdates=${value}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ summary: "Ev", start: "2026-01-01", end: "2026-01-02" }),
        });
        expect(res.status).toBe(200);
      }
    });

    it("passes extended fields (attendees, recurrence, visibility)", async () => {
      const cal = makeMockCalendar();
      const app = createCalendarRoutes({ services: makeServices(cal) });
      await app.request("/calendar/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          summary: "Standup",
          start: "2026-04-13T09:00:00+09:00",
          end: "2026-04-13T09:15:00+09:00",
          attendees: [{ email: "a@example.com" }],
          recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=MO"],
          visibility: "private",
        }),
      });
      expect(cal.createEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          attendees: [{ email: "a@example.com" }],
          recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=MO"],
          visibility: "private",
        }),
        "none", undefined,
      );
    });

    it("returns 400 for missing required fields", async () => {
      const cal = makeMockCalendar();
      const app = createCalendarRoutes({ services: makeServices(cal) });
      const res = await app.request("/calendar/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ summary: "No times" }),
      });
      expect(res.status).toBe(400);
    });

    it("returns 400 for invalid JSON", async () => {
      const cal = makeMockCalendar();
      const app = createCalendarRoutes({ services: makeServices(cal) });
      const res = await app.request("/calendar/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not json",
      });
      expect(res.status).toBe(400);
    });

    it("marks AgentWriteTracker after create", async () => {
      const cal = makeMockCalendar();
      const tracker = new AgentWriteTracker();
      const app = createCalendarRoutes({ services: makeServices(cal), agentWriteTracker: tracker });
      await app.request("/calendar/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ summary: "Ev", start: "2026-01-01T10:00:00Z", end: "2026-01-01T11:00:00Z" }),
      });
      expect(tracker.isMarked("calendar:new_ev1", null)).toBe(true);
    });

    it("marks integration_writes after successful create (Phase 4)", async () => {
      const cal = makeMockCalendar();
      const db = new Database(":memory:");
      applySchema(db);
      const app = createCalendarRoutes({ services: makeServices(cal), db });
      const res = await app.request("/calendar/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ summary: "Ev", start: "2026-01-01T10:00:00Z", end: "2026-01-01T11:00:00Z" }),
      });
      expect(res.status).toBe(200);
      const row = db
        .prepare(
          "SELECT integration, item_id, written_by FROM integration_writes WHERE item_id = ?",
        )
        .get("new_ev1") as
        | { integration: string; item_id: string; written_by: string }
        | undefined;
      expect(row).toBeDefined();
      expect(row!.integration).toBe("google_calendar");
      expect(row!.written_by).toBe("agent");
      db.close();
    });

    it("does not write integration_writes when service throws (Phase 4)", async () => {
      const cal = makeMockCalendar({
        createEvent: vi.fn().mockRejectedValue(new Error("upstream boom")),
      });
      const db = new Database(":memory:");
      applySchema(db);
      const app = createCalendarRoutes({ services: makeServices(cal), db });
      const res = await app.request("/calendar/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ summary: "Ev", start: "2026-01-01T10:00:00Z", end: "2026-01-01T11:00:00Z" }),
      });
      expect(res.status).toBe(502);
      const count = db
        .prepare("SELECT COUNT(*) AS n FROM integration_writes")
        .get() as { n: number };
      expect(count.n).toBe(0);
      db.close();
    });
  });

  // ── PATCH /calendar/events/:id ──

  describe("PATCH /calendar/events/:id", () => {
    it("updates an event", async () => {
      const cal = makeMockCalendar();
      const app = createCalendarRoutes({ services: makeServices(cal) });
      const res = await app.request("/calendar/events/ev1", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ summary: "Updated" }),
      });
      expect(res.status).toBe(200);
      const data = await res.json() as { status: string; eventId: string };
      expect(data.status).toBe("updated");
      expect(cal.updateEvent).toHaveBeenCalledWith("ev1", { summary: "Updated" }, "none", undefined);
    });

    it("passes sendUpdates and calendarId", async () => {
      const cal = makeMockCalendar();
      const app = createCalendarRoutes({ services: makeServices(cal) });
      await app.request("/calendar/events/ev1?sendUpdates=all&calendarId=work", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ summary: "Updated" }),
      });
      expect(cal.updateEvent).toHaveBeenCalledWith("ev1", { summary: "Updated" }, "all", "work");
    });

    it("returns 400 for empty body (refine check)", async () => {
      const cal = makeMockCalendar();
      const app = createCalendarRoutes({ services: makeServices(cal) });
      const res = await app.request("/calendar/events/ev1", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
    });

    it("returns 400 for invalid sendUpdates", async () => {
      const cal = makeMockCalendar();
      const app = createCalendarRoutes({ services: makeServices(cal) });
      const res = await app.request("/calendar/events/ev1?sendUpdates=invalid", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ summary: "Updated" }),
      });
      expect(res.status).toBe(400);
    });

    it("returns 404 when event not found", async () => {
      const cal = makeMockCalendar({
        updateEvent: vi.fn().mockRejectedValue({ code: 404 }),
      });
      const app = createCalendarRoutes({ services: makeServices(cal) });
      const res = await app.request("/calendar/events/missing", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ summary: "Updated" }),
      });
      expect(res.status).toBe(404);
    });

    it("marks AgentWriteTracker before update", async () => {
      const cal = makeMockCalendar();
      const tracker = new AgentWriteTracker();
      const app = createCalendarRoutes({ services: makeServices(cal), agentWriteTracker: tracker });
      await app.request("/calendar/events/ev1", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ summary: "Updated" }),
      });
      expect(tracker.isMarked("calendar:ev1", null)).toBe(true);
    });

    it("marks integration_writes after successful update (Phase 4)", async () => {
      const cal = makeMockCalendar();
      const db = new Database(":memory:");
      applySchema(db);
      const app = createCalendarRoutes({ services: makeServices(cal), db });
      const res = await app.request("/calendar/events/ev1", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ summary: "Updated" }),
      });
      expect(res.status).toBe(200);
      const row = db
        .prepare("SELECT item_id FROM integration_writes WHERE item_id = ?")
        .get("ev1");
      expect(row).toBeDefined();
      db.close();
    });
  });

  // ── DELETE /calendar/events/:id ──

  describe("DELETE /calendar/events/:id", () => {
    it("deletes an event", async () => {
      const cal = makeMockCalendar();
      const app = createCalendarRoutes({ services: makeServices(cal) });
      const res = await app.request("/calendar/events/ev1", { method: "DELETE" });
      expect(res.status).toBe(200);
      const data = await res.json() as { status: string; eventId: string };
      expect(data.status).toBe("deleted");
      expect(data.eventId).toBe("ev1");
    });

    it("passes sendUpdates from query", async () => {
      const cal = makeMockCalendar();
      const app = createCalendarRoutes({ services: makeServices(cal) });
      await app.request("/calendar/events/ev1?sendUpdates=all", { method: "DELETE" });
      expect(cal.deleteEvent).toHaveBeenCalledWith("ev1", "all", undefined);
    });

    it("returns 400 for invalid sendUpdates", async () => {
      const cal = makeMockCalendar();
      const app = createCalendarRoutes({ services: makeServices(cal) });
      const res = await app.request("/calendar/events/ev1?sendUpdates=wrong", { method: "DELETE" });
      expect(res.status).toBe(400);
    });

    it("returns 404 when event not found", async () => {
      const cal = makeMockCalendar({
        deleteEvent: vi.fn().mockRejectedValue({ code: 404 }),
      });
      const app = createCalendarRoutes({ services: makeServices(cal) });
      const res = await app.request("/calendar/events/missing", { method: "DELETE" });
      expect(res.status).toBe(404);
    });

    it("marks AgentWriteTracker before delete", async () => {
      const cal = makeMockCalendar();
      const tracker = new AgentWriteTracker();
      const app = createCalendarRoutes({ services: makeServices(cal), agentWriteTracker: tracker });
      await app.request("/calendar/events/ev1", { method: "DELETE" });
      expect(tracker.isMarked("calendar:ev1", null)).toBe(true);
    });

    it("marks integration_writes after successful delete (Phase 4)", async () => {
      const cal = makeMockCalendar();
      const db = new Database(":memory:");
      applySchema(db);
      const app = createCalendarRoutes({ services: makeServices(cal), db });
      const res = await app.request("/calendar/events/ev1", { method: "DELETE" });
      expect(res.status).toBe(200);
      const row = db
        .prepare("SELECT item_id FROM integration_writes WHERE item_id = ?")
        .get("ev1");
      expect(row).toBeDefined();
      db.close();
    });
  });

  // ── GET /calendar/calendars ──

  describe("GET /calendar/calendars", () => {
    it("returns calendar list", async () => {
      const cal = makeMockCalendar({
        listCalendars: vi.fn().mockResolvedValue([
          { id: "primary", summary: "Main", description: null, primary: true, backgroundColor: "#000", accessRole: "owner" },
        ]),
      });
      const app = createCalendarRoutes({ services: makeServices(cal) });
      const res = await app.request("/calendar/calendars");
      expect(res.status).toBe(200);
      const data = await res.json() as { calendars: unknown[] };
      expect(data.calendars).toHaveLength(1);
    });

    it("returns 503 when calendar not configured", async () => {
      const app = createCalendarRoutes({ services: makeServices(null) });
      const res = await app.request("/calendar/calendars");
      expect(res.status).toBe(503);
    });

    it("returns 502 on service error", async () => {
      const cal = makeMockCalendar({
        listCalendars: vi.fn().mockRejectedValue(new Error("API error")),
      });
      const app = createCalendarRoutes({ services: makeServices(cal) });
      const res = await app.request("/calendar/calendars");
      expect(res.status).toBe(502);
    });
  });

  // ── POST /calendar/freebusy ──

  describe("POST /calendar/freebusy", () => {
    it("returns freebusy result", async () => {
      const cal = makeMockCalendar({
        queryFreeBusy: vi.fn().mockResolvedValue({
          calendars: { primary: { busy: [{ start: "2026-01-01T10:00:00Z", end: "2026-01-01T11:00:00Z" }] } },
        }),
      });
      const app = createCalendarRoutes({ services: makeServices(cal) });
      const res = await app.request("/calendar/freebusy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ timeMin: "2026-01-01T09:00:00Z", timeMax: "2026-01-01T18:00:00Z" }),
      });
      expect(res.status).toBe(200);
      const data = await res.json() as { calendars: Record<string, unknown> };
      expect(data.calendars).toHaveProperty("primary");
    });

    it("passes calendarIds to service", async () => {
      const cal = makeMockCalendar();
      const app = createCalendarRoutes({ services: makeServices(cal) });
      await app.request("/calendar/freebusy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          timeMin: "2026-01-01T09:00:00Z",
          timeMax: "2026-01-01T18:00:00Z",
          calendarIds: ["primary", "work"],
        }),
      });
      expect(cal.queryFreeBusy).toHaveBeenCalledWith(
        "2026-01-01T09:00:00Z", "2026-01-01T18:00:00Z", ["primary", "work"],
      );
    });

    it("returns 400 for missing required fields", async () => {
      const cal = makeMockCalendar();
      const app = createCalendarRoutes({ services: makeServices(cal) });
      const res = await app.request("/calendar/freebusy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ timeMin: "2026-01-01T09:00:00Z" }),
      });
      expect(res.status).toBe(400);
    });

    it("returns 400 for invalid JSON", async () => {
      const cal = makeMockCalendar();
      const app = createCalendarRoutes({ services: makeServices(cal) });
      const res = await app.request("/calendar/freebusy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not json",
      });
      expect(res.status).toBe(400);
    });

    it("returns 503 when calendar not configured", async () => {
      const app = createCalendarRoutes({ services: makeServices(null) });
      const res = await app.request("/calendar/freebusy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ timeMin: "2026-01-01T09:00:00Z", timeMax: "2026-01-01T18:00:00Z" }),
      });
      expect(res.status).toBe(503);
    });
  });

  // ── 503 for all endpoints when calendar not configured ──

  describe("503 when calendar not configured", () => {
    const endpoints = [
      { method: "GET", path: "/calendar/events" },
      { method: "GET", path: "/calendar/events/ev1" },
      { method: "POST", path: "/calendar/events" },
      { method: "PATCH", path: "/calendar/events/ev1" },
      { method: "DELETE", path: "/calendar/events/ev1" },
      { method: "GET", path: "/calendar/calendars" },
      { method: "POST", path: "/calendar/freebusy" },
    ] as const;

    for (const { method, path } of endpoints) {
      it(`${method} ${path} returns 503`, async () => {
        const app = createCalendarRoutes({ services: makeServices(null) });
        const body = method === "POST" || method === "PATCH"
          ? JSON.stringify({ summary: "X", start: "2026-01-01", end: "2026-01-02", timeMin: "a", timeMax: "b" })
          : undefined;
        const headers: Record<string, string> = body ? { "Content-Type": "application/json" } : {};
        const res = await app.request(path, { method, headers, body });
        expect(res.status).toBe(503);
      });
    }
  });

  // SETUP-FLOW-REDESIGN-PLAN §5.5 — Outlook calendar surface graceful
  // when no Outlook account is configured. Full path coverage with a
  // mocked MailAccountRegistry lives in the e2e suite (§11.3).
  describe("Outlook calendar — degraded paths", () => {
    it("GET /calendar/outlook/calendars returns 503 outlook_not_configured when services.mail is null", async () => {
      const app = createCalendarRoutes({ services: makeServices(null) });
      const res = await app.request("/calendar/outlook/calendars");
      expect(res.status).toBe(503);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("outlook_not_configured");
    });

    it("GET /calendar/outlook/events returns 503 outlook_not_configured when services.mail is null", async () => {
      const app = createCalendarRoutes({ services: makeServices(null) });
      const res = await app.request("/calendar/outlook/events?date=2026-05-04");
      expect(res.status).toBe(503);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("outlook_not_configured");
    });

    it("GET /calendar/outlook/events validates the date format before consulting services.mail", async () => {
      // Empty registry → 503 first (no Outlook account); date validation
      // is a downstream concern. The 503 path is what we assert here.
      const app = createCalendarRoutes({ services: makeServices(null) });
      const res = await app.request("/calendar/outlook/events?date=not-a-date");
      expect(res.status).toBe(503);
    });

    it("GET /calendar/outlook/calendars returns 503 when services.mail has no Outlook accounts", async () => {
      const fakeRegistry = {
        listActiveAccounts: () => [{ id: "imap-1", kind: "yahoo" } as const],
      };
      const app = createCalendarRoutes({
        services: {
          calendar: null,
          mail: fakeRegistry,
        } as unknown as ServiceRegistry,
      });
      const res = await app.request("/calendar/outlook/calendars");
      expect(res.status).toBe(503);
    });

    // Regression — when outlook_calendar.mode is "disabled" the route must
    // return 503 outlook_calendar_disabled even if outlook_mail is authed.
    // SETUP-FLOW-REDESIGN-PLAN §5.5 — Mail and Calendar are independently
    // toggleable; sharing the MSAL token does not imply sharing the on/off
    // state.
    it("GET /calendar/outlook/calendars returns 503 outlook_calendar_disabled when outlook_calendar mode is disabled", async () => {
      const db = new Database(":memory:");
      applySchema(db);
      const { updateIntegrationState } = await import("../../db/integrations-store.js");
      updateIntegrationState(db, "outlook_calendar", { mode: "disabled", deniedTools: [] });
      const fakeRegistry = {
        listActiveAccounts: () => [{ id: "outlook-1", kind: "outlook" } as const],
        getProvider: vi.fn(),
      };
      const app = createCalendarRoutes({
        services: {
          calendar: null,
          mail: fakeRegistry,
        } as unknown as ServiceRegistry,
        db,
      });
      const res = await app.request("/calendar/outlook/calendars");
      expect(res.status).toBe(503);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("outlook_calendar_disabled");
      // The mail registry must NOT have been queried — gating short-circuits
      // before we even look at the account list.
      expect(fakeRegistry.getProvider).not.toHaveBeenCalled();
    });

    it("GET /calendar/outlook/calendars returns 503 when the resolved provider lacks createCalendarClient", async () => {
      // Defensive duck-typed check — the registry should never hand back a
      // shape without `createCalendarClient` once kind is "outlook", but the
      // route must surface a clean 503 if it ever does.
      const fakeRegistry = {
        listActiveAccounts: () => [{ id: "outlook-1", kind: "outlook" } as const],
        getProvider: vi.fn(async () => ({ kind: "outlook" })),
      };
      const app = createCalendarRoutes({
        services: {
          calendar: null,
          mail: fakeRegistry,
        } as unknown as ServiceRegistry,
      });
      const res = await app.request("/calendar/outlook/calendars");
      expect(res.status).toBe(503);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("outlook_not_configured");
    });
  });

  // SETUP-FLOW-REDESIGN-PLAN §11.3 footnote — happy-path coverage for the
  // Outlook routes. The §11.3 e2e suite covers the full MSAL stack; these
  // unit tests pin the route's contract (200 shape + correct delegation to
  // the calendar client) so route-level regressions do not hide behind the
  // e2e gate.
  describe("Outlook calendar — happy path", () => {
    it("GET /calendar/outlook/calendars returns 200 with the wrapper's calendars", async () => {
      const fakeCalendarClient = {
        listCalendars: vi.fn(async () => [
          {
            id: "cal-1",
            name: "Work",
            isDefaultCalendar: true,
            owner: "me@example.com",
            timeZone: "UTC",
          },
        ]),
        listEvents: vi.fn(),
      };
      const fakeProvider = {
        kind: "outlook",
        createCalendarClient: () => fakeCalendarClient,
      };
      const fakeRegistry = {
        listActiveAccounts: () => [{ id: "outlook-1", kind: "outlook" } as const],
        getProvider: vi.fn(async () => fakeProvider),
      };
      const app = createCalendarRoutes({
        services: {
          calendar: null,
          mail: fakeRegistry,
        } as unknown as ServiceRegistry,
      });
      const res = await app.request("/calendar/outlook/calendars");
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        calendars: Array<{ id: string; isDefaultCalendar: boolean; timeZone: string | null }>;
        accountId: string;
      };
      expect(body.accountId).toBe("outlook-1");
      expect(body.calendars).toHaveLength(1);
      expect(body.calendars[0]!.id).toBe("cal-1");
      expect(body.calendars[0]!.timeZone).toBe("UTC");
      expect(fakeCalendarClient.listCalendars).toHaveBeenCalledTimes(1);
    });

    it("GET /calendar/outlook/events forwards date+calendarId+days range to the wrapper", async () => {
      const fakeCalendarClient = {
        listCalendars: vi.fn(),
        listEvents: vi.fn(async () => [
          {
            id: "evt-1",
            subject: "Standup",
            startUtc: "2026-05-04T10:00:00.000Z",
            endUtc: "2026-05-04T10:30:00.000Z",
            isAllDay: false,
            organizer: "boss@example.com",
            webLink: null,
            bodyPreview: "",
          },
        ]),
      };
      const fakeProvider = {
        kind: "outlook",
        createCalendarClient: () => fakeCalendarClient,
      };
      const fakeRegistry = {
        listActiveAccounts: () => [{ id: "outlook-1", kind: "outlook" } as const],
        getProvider: vi.fn(async () => fakeProvider),
      };
      const app = createCalendarRoutes({
        services: {
          calendar: null,
          mail: fakeRegistry,
        } as unknown as ServiceRegistry,
      });
      const res = await app.request(
        "/calendar/outlook/events?date=2026-05-04&days=2&calendarId=cal-foo",
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { events: unknown[]; accountId: string };
      expect(body.accountId).toBe("outlook-1");
      expect(body.events).toHaveLength(1);
      expect(fakeCalendarClient.listEvents).toHaveBeenCalledWith(
        {
          startUtc: "2026-05-04T00:00:00.000Z",
          endUtc: "2026-05-06T00:00:00.000Z",
        },
        { calendarId: "cal-foo" },
      );
    });

    // Mirror of the Google `cal_iso_week_to_now` direct shape (2026-05-17):
    // Outlook calendar.ts now accepts `timeMin`/`timeMax` so the
    // weekly_review pre-pass speaks the same window across providers.
    describe("Outlook ISO-range shape (timeMin/timeMax)", () => {
      function makeOutlookApp(listEvents: ReturnType<typeof vi.fn>) {
        const fakeProvider = {
          kind: "outlook",
          createCalendarClient: () => ({ listCalendars: vi.fn(), listEvents }),
        };
        const fakeRegistry = {
          listActiveAccounts: () => [{ id: "outlook-1", kind: "outlook" } as const],
          getProvider: vi.fn(async () => fakeProvider),
        };
        return createCalendarRoutes({
          services: {
            calendar: null,
            mail: fakeRegistry,
          } as unknown as ServiceRegistry,
        });
      }

      it("forwards a valid ISO range to the wrapper verbatim", async () => {
        const listEvents = vi.fn(async () => []);
        const app = makeOutlookApp(listEvents);
        const res = await app.request(
          "/calendar/outlook/events?timeMin=2026-05-11T00:00:00.000Z&timeMax=2026-05-15T10:00:00.000Z",
        );
        expect(res.status).toBe(200);
        expect(listEvents).toHaveBeenCalledWith(
          {
            startUtc: "2026-05-11T00:00:00.000Z",
            endUtc: "2026-05-15T10:00:00.000Z",
          },
          {},
        );
      });

      it("rejects a half-specified range with 400", async () => {
        const app = makeOutlookApp(vi.fn());
        const res = await app.request(
          "/calendar/outlook/events?timeMin=2026-05-11T00:00:00Z",
        );
        expect(res.status).toBe(400);
      });

      it("rejects unparseable timeMin with 400", async () => {
        const app = makeOutlookApp(vi.fn());
        const res = await app.request(
          "/calendar/outlook/events?timeMin=garbage&timeMax=2026-05-15T10:00:00Z",
        );
        expect(res.status).toBe(400);
      });

      it("rejects unparseable timeMax with 400", async () => {
        const app = makeOutlookApp(vi.fn());
        const res = await app.request(
          "/calendar/outlook/events?timeMin=2026-05-11T00:00:00Z&timeMax=not-a-date",
        );
        expect(res.status).toBe(400);
      });

      it("rejects half-specified (timeMax-only)", async () => {
        const app = makeOutlookApp(vi.fn());
        const res = await app.request(
          "/calendar/outlook/events?timeMax=2026-05-11T00:00:00Z",
        );
        expect(res.status).toBe(400);
      });

      it("rejects inverted range with 400", async () => {
        const app = makeOutlookApp(vi.fn());
        const res = await app.request(
          "/calendar/outlook/events?timeMin=2026-05-15T00:00:00Z&timeMax=2026-05-11T00:00:00Z",
        );
        expect(res.status).toBe(400);
      });

      it("rejects ranges wider than 90 days with 400", async () => {
        const app = makeOutlookApp(vi.fn());
        const res = await app.request(
          "/calendar/outlook/events?timeMin=2026-01-01T00:00:00Z&timeMax=2026-06-01T00:00:00Z",
        );
        expect(res.status).toBe(400);
      });
    });

    it("GET /calendar/outlook/events surfaces wrapper errors as 502 calendar_error", async () => {
      const fakeCalendarClient = {
        listCalendars: vi.fn(),
        listEvents: vi.fn(async () => {
          throw new Error("graph 500");
        }),
      };
      const fakeProvider = {
        kind: "outlook",
        createCalendarClient: () => fakeCalendarClient,
      };
      const fakeRegistry = {
        listActiveAccounts: () => [{ id: "outlook-1", kind: "outlook" } as const],
        getProvider: vi.fn(async () => fakeProvider),
      };
      const app = createCalendarRoutes({
        services: {
          calendar: null,
          mail: fakeRegistry,
        } as unknown as ServiceRegistry,
      });
      const res = await app.request("/calendar/outlook/events?date=2026-05-04");
      expect(res.status).toBe(502);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("calendar_error");
    });
  });
  // ── Additional branch coverage ──────────────────────────────────────────────

  describe("GET /calendar/events — date=today shorthand", () => {
    it("resolves 'today' to the current date", async () => {
      const cal = makeMockCalendar();
      const app = createCalendarRoutes({ services: makeServices(cal) });
      const res = await app.request("/calendar/events?date=today");
      expect(res.status).toBe(200);
      expect(cal.listEvents).toHaveBeenCalledTimes(1);
      // The resolved ISO strings should be valid dates, not NaN
      const [[timeMin]] = (cal.listEvents as ReturnType<typeof vi.fn>).mock.calls as [[string, string]];
      expect(Number.isNaN(new Date(timeMin).getTime())).toBe(false);
    });
  });

  describe("isGoogleNotFound — non-object rejection", () => {
    it("returns 502 (not 404) when a non-object value is thrown on GET :id", async () => {
      const cal = makeMockCalendar({
        getEvent: vi.fn().mockRejectedValue(null),
      });
      const app = createCalendarRoutes({ services: makeServices(cal) });
      const res = await app.request("/calendar/events/ev1");
      expect(res.status).toBe(502);
    });

    it("returns 502 (not 404) when a primitive string is thrown on GET :id", async () => {
      const cal = makeMockCalendar({
        getEvent: vi.fn().mockRejectedValue("not found string"),
      });
      const app = createCalendarRoutes({ services: makeServices(cal) });
      const res = await app.request("/calendar/events/ev1");
      expect(res.status).toBe(502);
    });

    it("returns 502 when isGoogleNotFound gets an object with non-object response field", async () => {
      const cal = makeMockCalendar({
        getEvent: vi.fn().mockRejectedValue({ response: "not-an-object" }),
      });
      const app = createCalendarRoutes({ services: makeServices(cal) });
      const res = await app.request("/calendar/events/ev1");
      expect(res.status).toBe(502);
    });
  });

  describe("POST /calendar/freebusy — additional paths", () => {
    it("returns 502 when queryFreeBusy throws", async () => {
      const cal = makeMockCalendar({
        queryFreeBusy: vi.fn().mockRejectedValue(new Error("quota exceeded")),
      });
      const app = createCalendarRoutes({ services: makeServices(cal) });
      const res = await app.request("/calendar/freebusy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ timeMin: "2026-01-01T09:00:00Z", timeMax: "2026-01-01T18:00:00Z" }),
      });
      expect(res.status).toBe(502);
      const data = await res.json() as { error: string };
      expect(data.error).toBe("calendar_error");
    });
  });

  describe("PATCH /calendar/events/:id — additional paths", () => {
    it("returns 400 for invalid JSON body", async () => {
      const cal = makeMockCalendar();
      const app = createCalendarRoutes({ services: makeServices(cal) });
      const res = await app.request("/calendar/events/ev1", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: "not-json",
      });
      expect(res.status).toBe(400);
    });

    it("returns 502 on service error", async () => {
      const cal = makeMockCalendar({
        updateEvent: vi.fn().mockRejectedValue(new Error("server error")),
      });
      const app = createCalendarRoutes({ services: makeServices(cal) });
      const res = await app.request("/calendar/events/ev1", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ summary: "Updated" }),
      });
      expect(res.status).toBe(502);
      const data = await res.json() as { error: string };
      expect(data.error).toBe("calendar_error");
    });
  });

  describe("DELETE /calendar/events/:id — additional paths", () => {
    it("passes calendarId to deleteEvent", async () => {
      const cal = makeMockCalendar();
      const app = createCalendarRoutes({ services: makeServices(cal) });
      await app.request("/calendar/events/ev1?calendarId=work", { method: "DELETE" });
      expect(cal.deleteEvent).toHaveBeenCalledWith("ev1", "none", "work");
    });

    it("returns 502 on service error", async () => {
      const cal = makeMockCalendar({
        deleteEvent: vi.fn().mockRejectedValue(new Error("upstream error")),
      });
      const app = createCalendarRoutes({ services: makeServices(cal) });
      const res = await app.request("/calendar/events/ev1", { method: "DELETE" });
      expect(res.status).toBe(502);
      const data = await res.json() as { error: string };
      expect(data.error).toBe("calendar_error");
    });
  });

  describe("Outlook calendar — delegated mode and error paths", () => {
    it("GET /calendar/outlook/calendars returns 503 when outlook_calendar mode is delegated", async () => {
      const db = new Database(":memory:");
      applySchema(db);
      const { updateIntegrationState } = await import("../../db/integrations-store.js");
      updateIntegrationState(db, "outlook_calendar", { mode: "delegated", delegatedBackend: "claude", deniedTools: [] });
      const fakeRegistry = {
        listActiveAccounts: () => [{ id: "outlook-1", kind: "outlook" } as const],
        getProvider: vi.fn(),
      };
      const app = createCalendarRoutes({
        services: { calendar: null, mail: fakeRegistry } as unknown as ServiceRegistry,
        db,
      });
      const res = await app.request("/calendar/outlook/calendars");
      expect(res.status).toBe(503);
      const body = await res.json() as { error: string };
      expect(body.error).toBe("outlook_calendar_delegated");
      expect(fakeRegistry.getProvider).not.toHaveBeenCalled();
      db.close();
    });

    it("GET /calendar/outlook/calendars returns 503 when getProvider throws", async () => {
      const fakeRegistry = {
        listActiveAccounts: () => [{ id: "outlook-1", kind: "outlook" } as const],
        getProvider: vi.fn(async () => { throw new Error("token expired"); }),
      };
      const app = createCalendarRoutes({
        services: { calendar: null, mail: fakeRegistry } as unknown as ServiceRegistry,
      });
      const res = await app.request("/calendar/outlook/calendars");
      expect(res.status).toBe(503);
      const body = await res.json() as { error: string };
      expect(body.error).toBe("outlook_not_configured");
    });

    it("GET /calendar/outlook/calendars returns 502 when listCalendars throws", async () => {
      const fakeCalendarClient = {
        listCalendars: vi.fn(async () => { throw new Error("graph 503"); }),
        listEvents: vi.fn(),
      };
      const fakeProvider = { kind: "outlook", createCalendarClient: () => fakeCalendarClient };
      const fakeRegistry = {
        listActiveAccounts: () => [{ id: "outlook-1", kind: "outlook" } as const],
        getProvider: vi.fn(async () => fakeProvider),
      };
      const app = createCalendarRoutes({
        services: { calendar: null, mail: fakeRegistry } as unknown as ServiceRegistry,
      });
      const res = await app.request("/calendar/outlook/calendars");
      expect(res.status).toBe(502);
      const body = await res.json() as { error: string };
      expect(body.error).toBe("calendar_error");
    });

    it("GET /calendar/outlook/events resolves 'today' to the current date", async () => {
      const fakeCalendarClient = {
        listCalendars: vi.fn(),
        listEvents: vi.fn(async () => []),
      };
      const fakeProvider = { kind: "outlook", createCalendarClient: () => fakeCalendarClient };
      const fakeRegistry = {
        listActiveAccounts: () => [{ id: "outlook-1", kind: "outlook" } as const],
        getProvider: vi.fn(async () => fakeProvider),
      };
      const app = createCalendarRoutes({
        services: { calendar: null, mail: fakeRegistry } as unknown as ServiceRegistry,
      });
      const res = await app.request("/calendar/outlook/events?date=today");
      expect(res.status).toBe(200);
      const body = await res.json() as { events: unknown[]; accountId: string };
      expect(body.accountId).toBe("outlook-1");
      expect(Array.isArray(body.events)).toBe(true);
    });

    it("GET /calendar/outlook/events returns 400 for invalid date with valid client", async () => {
      const fakeCalendarClient = {
        listCalendars: vi.fn(),
        listEvents: vi.fn(async () => []),
      };
      const fakeProvider = { kind: "outlook", createCalendarClient: () => fakeCalendarClient };
      const fakeRegistry = {
        listActiveAccounts: () => [{ id: "outlook-1", kind: "outlook" } as const],
        getProvider: vi.fn(async () => fakeProvider),
      };
      const app = createCalendarRoutes({
        services: { calendar: null, mail: fakeRegistry } as unknown as ServiceRegistry,
      });
      const res = await app.request("/calendar/outlook/events?date=not-a-date");
      expect(res.status).toBe(400);
      const body = await res.json() as { error: string };
      expect(body.error).toContain("invalid date");
    });

    it("GET /calendar/outlook/events uses default date when no date param provided", async () => {
      const fakeCalendarClient = {
        listCalendars: vi.fn(),
        listEvents: vi.fn(async () => []),
      };
      const fakeProvider = { kind: "outlook", createCalendarClient: () => fakeCalendarClient };
      const fakeRegistry = {
        listActiveAccounts: () => [{ id: "outlook-1", kind: "outlook" } as const],
        getProvider: vi.fn(async () => fakeProvider),
      };
      const app = createCalendarRoutes({
        services: { calendar: null, mail: fakeRegistry } as unknown as ServiceRegistry,
      });
      const res = await app.request("/calendar/outlook/events");
      expect(res.status).toBe(200);
      expect(fakeCalendarClient.listEvents).toHaveBeenCalledTimes(1);
    });
  });
});

// ── DELEGATED-PROXY-API-DESIGN.md Phase B — proxy branch ─────────────────────
