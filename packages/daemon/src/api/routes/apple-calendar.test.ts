import { describe, it, expect, vi } from "vitest";
import { createAppleCalendarRoutes } from "./apple-calendar.js";
import type { ServiceRegistry } from "../../services/service-registry.js";
import type { AppleCalendarService } from "../../services/apple-calendar/index.js";
import type { SecretBroker } from "../../secrets/secret-broker.js";

// apple-calendar.ts is coverage-excluded (thin CalDAV forwarder), so the
// GET /apple-calendar/events window arithmetic shipped without a regression
// test even though the sibling Google/Outlook routes (calendar.ts) carry one.
// The `days` query guard is the only non-trivial pure logic in the route —
// `Number("abc")` → NaN once propagated into `new Date(startMs + NaN)`,
// throwing RangeError → opaque 500. These tests pin that guard so the same
// bug class the calendar.ts fix closed can't silently reopen here.

function makeAppleCalendar(
  overrides: Partial<AppleCalendarService> = {},
): AppleCalendarService {
  return {
    available: true,
    listEvents: vi.fn().mockResolvedValue([]),
    ...overrides,
  } as unknown as AppleCalendarService;
}

function makeDeps(
  appleCalendar: AppleCalendarService | null,
): Parameters<typeof createAppleCalendarRoutes>[0] {
  return {
    services: { appleCalendar } as unknown as ServiceRegistry,
    secretBroker: {} as unknown as SecretBroker,
  };
}

describe("Apple Calendar API routes — GET /apple-calendar/events", () => {
  it("returns events for an explicit date (default 1-day window)", async () => {
    const cal = makeAppleCalendar({
      listEvents: vi.fn().mockResolvedValue([
        { id: "ev1", summary: "Standup", start: "2026-05-04T10:00:00Z", end: "2026-05-04T10:30:00Z" },
      ]),
    });
    const app = createAppleCalendarRoutes(makeDeps(cal));
    const res = await app.request("/apple-calendar/events?date=2026-05-04");
    expect(res.status).toBe(200);
    const data = (await res.json()) as { events: unknown[] };
    expect(data.events).toHaveLength(1);
    expect(cal.listEvents).toHaveBeenCalledWith(
      "2026-05-04T00:00:00.000Z",
      "2026-05-05T00:00:00.000Z",
    );
  });

  it("falls back to a 1-day window when ?days is non-finite (no RangeError 500)", async () => {
    // Regression mirror of the Google/Outlook routes: a non-numeric `days`
    // must clamp to 1, not propagate NaN into the ISO-range math.
    const cal = makeAppleCalendar();
    const app = createAppleCalendarRoutes(makeDeps(cal));
    const res = await app.request("/apple-calendar/events?date=2026-05-04&days=abc");
    expect(res.status).toBe(200);
    expect(cal.listEvents).toHaveBeenCalledWith(
      "2026-05-04T00:00:00.000Z",
      "2026-05-05T00:00:00.000Z",
    );
  });

  it("clamps an over-large ?days to a 90-day window", async () => {
    const cal = makeAppleCalendar();
    const app = createAppleCalendarRoutes(makeDeps(cal));
    const res = await app.request("/apple-calendar/events?date=2026-05-04&days=200");
    expect(res.status).toBe(200);
    expect(cal.listEvents).toHaveBeenCalledWith(
      "2026-05-04T00:00:00.000Z",
      "2026-08-02T00:00:00.000Z",
    );
  });

  it("clamps a zero/negative ?days up to a 1-day window", async () => {
    const cal = makeAppleCalendar();
    const app = createAppleCalendarRoutes(makeDeps(cal));
    const res = await app.request("/apple-calendar/events?date=2026-05-04&days=0");
    expect(res.status).toBe(200);
    expect(cal.listEvents).toHaveBeenCalledWith(
      "2026-05-04T00:00:00.000Z",
      "2026-05-05T00:00:00.000Z",
    );
  });

  it("returns 503 when Apple Calendar is not configured", async () => {
    const app = createAppleCalendarRoutes(makeDeps(null));
    const res = await app.request("/apple-calendar/events?date=2026-05-04");
    expect(res.status).toBe(503);
  });

  it("returns 400 for an invalid date format", async () => {
    const cal = makeAppleCalendar();
    const app = createAppleCalendarRoutes(makeDeps(cal));
    const res = await app.request("/apple-calendar/events?date=not-a-date");
    expect(res.status).toBe(400);
  });

  it("returns 502 when the upstream service throws", async () => {
    const cal = makeAppleCalendar({
      listEvents: vi.fn().mockRejectedValue(new Error("iCloud unreachable")),
    });
    const app = createAppleCalendarRoutes(makeDeps(cal));
    const res = await app.request("/apple-calendar/events?date=2026-05-04");
    expect(res.status).toBe(502);
  });
});
