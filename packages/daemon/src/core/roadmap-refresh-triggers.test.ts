import { describe, expect, it, vi } from "vitest";
import {
  maybeTriggerRefreshForCalendarEvent,
  maybeTriggerRefreshForTravelBooking,
  shouldTriggerRefreshForCalendarEvent,
  shouldTriggerRefreshForTravelBooking,
} from "./roadmap-refresh-triggers.js";

const NOW = Date.UTC(2026, 3, 19, 12, 0, 0); // 2026-04-19 12:00 UTC
const DAY_MS = 24 * 60 * 60 * 1000;

const iso = (offsetMs: number): string =>
  new Date(NOW + offsetMs).toISOString();

describe("shouldTriggerRefreshForTravelBooking", () => {
  it("returns false when startDate is null", () => {
    expect(
      shouldTriggerRefreshForTravelBooking({ startDate: null, now: NOW }),
    ).toBe(false);
  });

  it("returns false when startDate is unparseable", () => {
    expect(
      shouldTriggerRefreshForTravelBooking({
        startDate: "not-a-date",
        now: NOW,
      }),
    ).toBe(false);
  });

  it("returns false when startDate is within 3 days", () => {
    expect(
      shouldTriggerRefreshForTravelBooking({
        startDate: iso(2 * DAY_MS),
        now: NOW,
      }),
    ).toBe(false);
  });

  it("returns false when startDate is exactly 3 days out (threshold is strict)", () => {
    expect(
      shouldTriggerRefreshForTravelBooking({
        startDate: iso(3 * DAY_MS),
        now: NOW,
      }),
    ).toBe(false);
  });

  it("returns true when startDate is beyond 3 days", () => {
    expect(
      shouldTriggerRefreshForTravelBooking({
        startDate: iso(3 * DAY_MS + 60_000),
        now: NOW,
      }),
    ).toBe(true);
  });

  it("returns true for a booking 30 days out", () => {
    expect(
      shouldTriggerRefreshForTravelBooking({
        startDate: iso(30 * DAY_MS),
        now: NOW,
      }),
    ).toBe(true);
  });

  it("returns false for a startDate in the past", () => {
    expect(
      shouldTriggerRefreshForTravelBooking({
        startDate: iso(-5 * DAY_MS),
        now: NOW,
      }),
    ).toBe(false);
  });

  it("falls back to Date.now() when no `now` is provided", () => {
    // startDate 10 years in the future is always > now + 3d regardless of
    // the current wall clock; exercises the `??` fallback branch.
    const farFuture = new Date(Date.now() + 10 * 365 * DAY_MS).toISOString();
    expect(
      shouldTriggerRefreshForTravelBooking({ startDate: farFuture }),
    ).toBe(true);
  });
});

describe("shouldTriggerRefreshForCalendarEvent", () => {
  it("returns false when changeType is 'modified'", () => {
    expect(
      shouldTriggerRefreshForCalendarEvent({
        startIso: iso(30 * DAY_MS),
        actor: "user",
        changeType: "modified",
        now: NOW,
      }),
    ).toBe(false);
  });

  it("returns false when changeType is 'deleted'", () => {
    expect(
      shouldTriggerRefreshForCalendarEvent({
        startIso: iso(30 * DAY_MS),
        actor: "user",
        changeType: "deleted",
        now: NOW,
      }),
    ).toBe(false);
  });

  it("returns false when actor is 'agent' (the agent created the event itself)", () => {
    expect(
      shouldTriggerRefreshForCalendarEvent({
        startIso: iso(30 * DAY_MS),
        actor: "agent",
        changeType: "created",
        now: NOW,
      }),
    ).toBe(false);
  });

  it("returns false when startIso is null", () => {
    expect(
      shouldTriggerRefreshForCalendarEvent({
        startIso: null,
        actor: "user",
        changeType: "created",
        now: NOW,
      }),
    ).toBe(false);
  });

  it("returns false when event starts within 14 days", () => {
    expect(
      shouldTriggerRefreshForCalendarEvent({
        startIso: iso(13 * DAY_MS),
        actor: "user",
        changeType: "created",
        now: NOW,
      }),
    ).toBe(false);
  });

  it("returns true when a user-created event starts more than 14 days out", () => {
    expect(
      shouldTriggerRefreshForCalendarEvent({
        startIso: iso(20 * DAY_MS),
        actor: "user",
        changeType: "created",
        now: NOW,
      }),
    ).toBe(true);
  });

  it("accepts 'system' actor", () => {
    expect(
      shouldTriggerRefreshForCalendarEvent({
        startIso: iso(20 * DAY_MS),
        actor: "system",
        changeType: "created",
        now: NOW,
      }),
    ).toBe(true);
  });

  it("falls back to Date.now() when no `now` is provided", () => {
    const farFuture = new Date(Date.now() + 10 * 365 * DAY_MS).toISOString();
    expect(
      shouldTriggerRefreshForCalendarEvent({
        startIso: farFuture,
        actor: "user",
        changeType: "created",
      }),
    ).toBe(true);
  });

  it("returns false for an unparseable startIso", () => {
    expect(
      shouldTriggerRefreshForCalendarEvent({
        startIso: "not-a-date",
        actor: "user",
        changeType: "created",
        now: NOW,
      }),
    ).toBe(false);
  });
});

describe("maybeTriggerRefreshForTravelBooking", () => {
  it("invokes the callback with 'travel_booking_detected' when predicate holds", () => {
    const trigger = vi.fn();
    maybeTriggerRefreshForTravelBooking(
      { startDate: iso(30 * DAY_MS), now: NOW },
      trigger,
    );
    expect(trigger).toHaveBeenCalledOnce();
    expect(trigger).toHaveBeenCalledWith("travel_booking_detected");
  });

  it("is a no-op when predicate fails", () => {
    const trigger = vi.fn();
    maybeTriggerRefreshForTravelBooking(
      { startDate: iso(DAY_MS), now: NOW },
      trigger,
    );
    expect(trigger).not.toHaveBeenCalled();
  });

  it("tolerates a null callback", () => {
    expect(() =>
      maybeTriggerRefreshForTravelBooking(
        { startDate: iso(30 * DAY_MS), now: NOW },
        null,
      ),
    ).not.toThrow();
  });

  it("swallows callback errors so the INSERT path cannot fail", () => {
    const trigger = vi.fn(() => {
      throw new Error("boom");
    });
    expect(() =>
      maybeTriggerRefreshForTravelBooking(
        { startDate: iso(30 * DAY_MS), now: NOW },
        trigger,
      ),
    ).not.toThrow();
    expect(trigger).toHaveBeenCalledOnce();
  });
});

describe("maybeTriggerRefreshForCalendarEvent", () => {
  it("invokes the callback with 'calendar_event_detected' for a user-created far-future event", () => {
    const trigger = vi.fn();
    maybeTriggerRefreshForCalendarEvent(
      {
        startIso: iso(30 * DAY_MS),
        actor: "user",
        changeType: "created",
        now: NOW,
      },
      trigger,
    );
    expect(trigger).toHaveBeenCalledWith("calendar_event_detected");
  });

  it("is a no-op for an agent-created event", () => {
    const trigger = vi.fn();
    maybeTriggerRefreshForCalendarEvent(
      {
        startIso: iso(30 * DAY_MS),
        actor: "agent",
        changeType: "created",
        now: NOW,
      },
      trigger,
    );
    expect(trigger).not.toHaveBeenCalled();
  });

  it("swallows callback errors", () => {
    const trigger = vi.fn(() => {
      throw new Error("boom");
    });
    expect(() =>
      maybeTriggerRefreshForCalendarEvent(
        {
          startIso: iso(30 * DAY_MS),
          actor: "user",
          changeType: "created",
          now: NOW,
        },
        trigger,
      ),
    ).not.toThrow();
  });

  it("is a silent no-op when the trigger callback is null or undefined", () => {
    // Pin the early-exit branch in maybeTriggerRefreshForCalendarEvent.
    // Boot-time call sites (mail / git observer wiring) pass `null`
    // when the roadmap refresher has not been wired yet — that path
    // must not throw or attempt to call a missing function.
    expect(() =>
      maybeTriggerRefreshForCalendarEvent(
        {
          startIso: iso(30 * DAY_MS),
          actor: "user",
          changeType: "created",
          now: NOW,
        },
        null,
      ),
    ).not.toThrow();
    expect(() =>
      maybeTriggerRefreshForCalendarEvent(
        {
          startIso: iso(30 * DAY_MS),
          actor: "user",
          changeType: "created",
          now: NOW,
        },
        undefined,
      ),
    ).not.toThrow();
  });
});
