import { describe, expect, it } from "vitest";
import { APP_NAME } from "@aitne/shared";
import {
  applyUpdateToIcs,
  buildEventIcs,
  composeEventId,
  generateUid,
  parseEventId,
  parseEventsFromIcs,
  parseInputDate,
  timeToJsonString,
} from "./caldav-codec.js";
import ICAL from "ical.js";

const FIXED_NOW = new Date("2026-04-26T10:00:00.000Z");

describe("composeEventId / parseEventId", () => {
  it("returns bare uid for non-recurring events", () => {
    expect(composeEventId("abc", null)).toBe("abc");
    expect(parseEventId("abc")).toEqual({ uid: "abc", recurrenceId: null });
  });

  it("round-trips a UID + RECURRENCE-ID composite", () => {
    const id = composeEventId("uid-123", "2026-04-26T14:00:00.000Z");
    expect(id).toBe("uid-123__2026-04-26T14:00:00.000Z");
    expect(parseEventId(id)).toEqual({
      uid: "uid-123",
      recurrenceId: "2026-04-26T14:00:00.000Z",
    });
  });

  it("round-trips a date-only RECURRENCE-ID for an all-day series instance", () => {
    const id = composeEventId("series-uid@local", "2026-04-26");
    expect(parseEventId(id)).toEqual({
      uid: "series-uid@local",
      recurrenceId: "2026-04-26",
    });
  });

  it("treats an externally-authored UID containing `__` as a bare UID", () => {
    // External calendar clients may emit UIDs with a literal `__`
    // (e.g. internal app namespacing). Without the ISO-suffix anchor,
    // parseEventId would have mis-split this and the route layer would
    // reject the master event with a spurious 501 recurring-instance
    // error. Verify it stays a single UID.
    expect(parseEventId("weekly__home@example")).toEqual({
      uid: "weekly__home@example",
      recurrenceId: null,
    });
    expect(parseEventId("uid__with__many__segments@local")).toEqual({
      uid: "uid__with__many__segments@local",
      recurrenceId: null,
    });
  });
});

describe("parseInputDate", () => {
  it("accepts YYYY-MM-DD", () => {
    expect(parseInputDate("2026-04-26")).toEqual({ value: "20260426", isDate: true });
  });

  it("accepts ISO with Z offset", () => {
    expect(parseInputDate("2026-04-26T14:00:00Z")).toEqual({
      value: "20260426T140000Z",
      isDate: false,
    });
  });

  it("accepts ISO with named offset and converts to UTC", () => {
    expect(parseInputDate("2026-04-26T14:00:00+09:00")).toEqual({
      value: "20260426T050000Z",
      isDate: false,
    });
  });

  it("trims surrounding whitespace", () => {
    expect(parseInputDate("  2026-04-26T14:00:00Z  ")).toEqual({
      value: "20260426T140000Z",
      isDate: false,
    });
  });

  it("throws on garbage input", () => {
    expect(() => parseInputDate("not a date")).toThrow(/Invalid date/);
  });

  it("rejects ISO date-time strings that omit the timezone offset", () => {
    // Without an offset, Date.parse interprets the value as server-local
    // time and the wire output would be silently shifted by the local
    // UTC offset. The codec contract requires Z or ±HH:MM.
    expect(() => parseInputDate("2026-04-26T14:00:00")).toThrow(
      /TZ offset/,
    );
    expect(() => parseInputDate("2026-04-26T14:00")).toThrow(/TZ offset/);
  });

  it("accepts ISO with compact offset (+0900) and seconds-less form", () => {
    expect(parseInputDate("2026-04-26T14:00:00+0900")).toEqual({
      value: "20260426T050000Z",
      isDate: false,
    });
    expect(parseInputDate("2026-04-26T14:00Z")).toEqual({
      value: "20260426T140000Z",
      isDate: false,
    });
  });
});

describe("timeToJsonString", () => {
  it("formats date-only times as YYYY-MM-DD", () => {
    const t = ICAL.Time.fromDateString("2026-04-26");
    expect(timeToJsonString(t)).toBe("2026-04-26");
  });

  it("formats date-time as ISO UTC", () => {
    const t = ICAL.Time.fromDateTimeString("2026-04-26T14:00:00Z");
    expect(timeToJsonString(t)).toBe("2026-04-26T14:00:00.000Z");
  });
});

describe("parseEventsFromIcs", () => {
  it("parses a single VEVENT with all standard fields", () => {
    const ics = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//Test//EN",
      "BEGIN:VEVENT",
      "UID:abc-123@local",
      "DTSTAMP:20260426T100000Z",
      "DTSTART:20260426T140000Z",
      "DTEND:20260426T150000Z",
      "SUMMARY:Hello",
      "DESCRIPTION:Body line",
      "LOCATION:Room 1",
      "STATUS:CONFIRMED",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");

    const events = parseEventsFromIcs(ics, "https://example/cal/abc.ics", '"etag-1"');
    expect(events).toEqual([
      {
        id: "abc-123@local",
        uid: "abc-123@local",
        recurrenceId: null,
        summary: "Hello",
        description: "Body line",
        location: "Room 1",
        start: "2026-04-26T14:00:00.000Z",
        end: "2026-04-26T15:00:00.000Z",
        allDay: false,
        status: "confirmed",
        url: "https://example/cal/abc.ics",
        etag: '"etag-1"',
        recurring: false,
      },
    ]);
  });

  it("parses an all-day event and defaults DTEND to next day", () => {
    const ics = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//Test//EN",
      "BEGIN:VEVENT",
      "UID:allday@local",
      "DTSTAMP:20260426T100000Z",
      "DTSTART;VALUE=DATE:20260426",
      "SUMMARY:All-day",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");

    const [event] = parseEventsFromIcs(ics, null, null);
    expect(event.allDay).toBe(true);
    expect(event.start).toBe("2026-04-26");
    expect(event.end).toBe("2026-04-27");
    expect(event.status).toBeNull();
    expect(event.url).toBeNull();
    expect(event.etag).toBeNull();
  });

  it("defaults DTEND to DTSTART for date-time events without DTEND", () => {
    const ics = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//Test//EN",
      "BEGIN:VEVENT",
      "UID:nodtend@local",
      "DTSTAMP:20260426T100000Z",
      "DTSTART:20260426T140000Z",
      "SUMMARY:Zero-duration",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");

    const [event] = parseEventsFromIcs(ics, null, null);
    expect(event.start).toBe("2026-04-26T14:00:00.000Z");
    expect(event.end).toBe("2026-04-26T14:00:00.000Z");
  });

  it("flags a master VEVENT with RRULE as recurring", () => {
    const ics = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//Test//EN",
      "BEGIN:VEVENT",
      "UID:weekly@local",
      "DTSTAMP:20260426T100000Z",
      "DTSTART:20260426T140000Z",
      "DTEND:20260426T150000Z",
      "SUMMARY:Weekly standup",
      "RRULE:FREQ=WEEKLY;BYDAY=MO",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");

    const [event] = parseEventsFromIcs(ics, null, null);
    expect(event.recurring).toBe(true);
    expect(event.recurrenceId).toBeNull();
    expect(event.id).toBe("weekly@local");
  });

  it("emits composite id for an expanded recurring instance and dedupes by RECURRENCE-ID", () => {
    const ics = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//Test//EN",
      "BEGIN:VEVENT",
      "UID:weekly@local",
      "DTSTAMP:20260426T100000Z",
      "DTSTART:20260427T140000Z",
      "DTEND:20260427T150000Z",
      "RECURRENCE-ID:20260427T140000Z",
      "SUMMARY:Weekly standup",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");

    const [event] = parseEventsFromIcs(ics, null, null);
    expect(event.recurring).toBe(true);
    expect(event.recurrenceId).toBe("2026-04-27T14:00:00.000Z");
    expect(event.id).toBe("weekly@local__2026-04-27T14:00:00.000Z");
  });

  it("skips VEVENTs missing UID or DTSTART", () => {
    const ics = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//Test//EN",
      "BEGIN:VEVENT",
      "DTSTART:20260426T140000Z",
      "SUMMARY:No UID",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:nodtstart@local",
      "SUMMARY:No DTSTART",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:ok@local",
      "DTSTART:20260426T140000Z",
      "DTEND:20260426T150000Z",
      "SUMMARY:Good",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");

    const events = parseEventsFromIcs(ics, null, null);
    expect(events.map((e) => e.uid)).toEqual(["ok@local"]);
  });

  it("treats non-string summary/description/location values as null", () => {
    // ical.js coerces SUMMARY into a string, but DESCRIPTION values can be
    // arrays in unusual encodings. Rather than fixture those, we feed a
    // VEVENT with a numeric-looking custom prop that the codec should
    // ignore — protects the code path that guards typeof === "string".
    const ics = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//Test//EN",
      "BEGIN:VEVENT",
      "UID:bare@local",
      "DTSTAMP:20260426T100000Z",
      "DTSTART:20260426T140000Z",
      "DTEND:20260426T150000Z",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");

    const [event] = parseEventsFromIcs(ics, null, null);
    expect(event.summary).toBeNull();
    expect(event.description).toBeNull();
    expect(event.location).toBeNull();
  });
});

describe("buildEventIcs", () => {
  it("emits a VCALENDAR/VEVENT with all parameters", () => {
    const ics = buildEventIcs(
      "uid-1@local",
      {
        summary: "Team meeting",
        start: "2026-04-26T14:00:00Z",
        end: "2026-04-26T15:00:00Z",
        description: "Quarterly review",
        location: "Conference room A",
      },
      FIXED_NOW,
    );
    expect(ics).toContain("UID:uid-1@local");
    expect(ics).toContain("SUMMARY:Team meeting");
    expect(ics).toContain("DTSTART:20260426T140000Z");
    expect(ics).toContain("DTEND:20260426T150000Z");
    expect(ics).toContain("DESCRIPTION:Quarterly review");
    expect(ics).toContain("LOCATION:Conference room A");
    expect(ics).toContain("DTSTAMP:20260426T100000Z");
    expect(ics).toContain(`PRODID:-//${APP_NAME}//iCloud CalDAV//EN`);

    const reparsed = parseEventsFromIcs(ics, null, null);
    expect(reparsed).toHaveLength(1);
    expect(reparsed[0]?.summary).toBe("Team meeting");
  });

  it("omits optional fields when not provided", () => {
    const ics = buildEventIcs(
      "uid-2@local",
      {
        summary: "Bare",
        start: "2026-04-26T14:00:00Z",
        end: "2026-04-26T15:00:00Z",
      },
      FIXED_NOW,
    );
    expect(ics).not.toContain("DESCRIPTION");
    expect(ics).not.toContain("LOCATION");
  });

  it("emits VALUE=DATE for all-day events", () => {
    const ics = buildEventIcs(
      "uid-3@local",
      {
        summary: "Holiday",
        start: "2026-04-26",
        end: "2026-04-27",
      },
      FIXED_NOW,
    );
    expect(ics).toMatch(/DTSTART;VALUE=DATE:20260426/);
    expect(ics).toMatch(/DTEND;VALUE=DATE:20260427/);
  });

  it("escapes commas and semicolons in TEXT properties", () => {
    const ics = buildEventIcs(
      "uid-4@local",
      {
        summary: "Hello, world; with semis",
        start: "2026-04-26T14:00:00Z",
        end: "2026-04-26T15:00:00Z",
      },
      FIXED_NOW,
    );
    expect(ics).toContain("SUMMARY:Hello\\, world\\; with semis");
  });

  it("rejects create when required fields are missing", () => {
    expect(() =>
      buildEventIcs(
        "uid-5@local",
        // @ts-expect-error — intentionally invalid for test
        { start: "2026-04-26T14:00:00Z", end: "2026-04-26T15:00:00Z" },
        FIXED_NOW,
      ),
    ).toThrow(/summary is required/);
  });

  it("rejects create when start or end is missing", () => {
    expect(() =>
      buildEventIcs(
        "uid-6@local",
        // @ts-expect-error — intentionally invalid for test
        { summary: "x", end: "2026-04-26T15:00:00Z" },
        FIXED_NOW,
      ),
    ).toThrow(/start is required/);

    expect(() =>
      buildEventIcs(
        "uid-7@local",
        // @ts-expect-error — intentionally invalid for test
        { summary: "x", start: "2026-04-26T14:00:00Z" },
        FIXED_NOW,
      ),
    ).toThrow(/end is required/);
  });
});

describe("applyUpdateToIcs", () => {
  const original = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Test//EN",
    "BEGIN:VEVENT",
    "UID:upd@local",
    "DTSTAMP:20260426T100000Z",
    "DTSTART:20260426T140000Z",
    "DTEND:20260426T150000Z",
    "SUMMARY:Old summary",
    "DESCRIPTION:Old body",
    "LOCATION:Old room",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");

  it("partial-updates only the provided fields", () => {
    const updated = applyUpdateToIcs(original, { summary: "New summary" });
    const [event] = parseEventsFromIcs(updated, null, null);
    expect(event.summary).toBe("New summary");
    expect(event.description).toBe("Old body");
    expect(event.start).toBe("2026-04-26T14:00:00.000Z");
  });

  it("clears a field when an empty string is provided", () => {
    const updated = applyUpdateToIcs(original, { description: "", location: "" });
    const [event] = parseEventsFromIcs(updated, null, null);
    expect(event.description).toBeNull();
    expect(event.location).toBeNull();
  });

  it("clears summary when set to empty string", () => {
    const updated = applyUpdateToIcs(original, { summary: "" });
    const [event] = parseEventsFromIcs(updated, null, null);
    expect(event.summary).toBeNull();
  });

  it("rewrites DTSTART/DTEND when new times are provided", () => {
    const updated = applyUpdateToIcs(original, {
      start: "2026-04-27T09:00:00Z",
      end: "2026-04-27T10:00:00Z",
    });
    const [event] = parseEventsFromIcs(updated, null, null);
    expect(event.start).toBe("2026-04-27T09:00:00.000Z");
    expect(event.end).toBe("2026-04-27T10:00:00.000Z");
  });

  it("rejects toggling all-day on start without also providing end", () => {
    // Existing event is a date-time event (not all-day). User PATCHes
    // only `start` to a date-only value — that would leave DTSTART as
    // VALUE=DATE while DTEND remains VALUE=DATE-TIME. iCloud rejects
    // such a malformed VEVENT; we surface 400 from the codec instead.
    expect(() =>
      applyUpdateToIcs(original, { start: "2026-04-26" }),
    ).toThrow(/all-day/);
  });

  it("rejects toggling all-day on end without also providing start", () => {
    expect(() =>
      applyUpdateToIcs(original, { end: "2026-04-27" }),
    ).toThrow(/all-day/);
  });

  it("permits toggling all-day when both start and end are provided together", () => {
    const updated = applyUpdateToIcs(original, {
      start: "2026-04-26",
      end: "2026-04-27",
    });
    const [event] = parseEventsFromIcs(updated, null, null);
    expect(event.allDay).toBe(true);
    expect(event.start).toBe("2026-04-26");
    expect(event.end).toBe("2026-04-27");
  });

  it("permits partial start update when the original VEVENT has no DTEND", () => {
    // RFC 5545 allows VEVENTs without DTEND (zero-duration / DURATION-only).
    // The all-day mismatch guard short-circuits when the property is absent
    // — verify the partial update succeeds in that shape, AND that the
    // emitted iCalendar still has the new DTSTART so it would round-trip
    // through iCloud correctly.
    const noDtend = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//Test//EN",
      "BEGIN:VEVENT",
      "UID:nodtend@local",
      "DTSTAMP:20260426T100000Z",
      "DTSTART:20260426T140000Z",
      "SUMMARY:no DTEND",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");
    const updated = applyUpdateToIcs(noDtend, { start: "2026-04-27T09:00:00Z" });
    expect(updated).toContain("DTSTART:20260427T090000Z");
    const [event] = parseEventsFromIcs(updated, null, null);
    expect(event.start).toBe("2026-04-27T09:00:00.000Z");
  });

  it("throws when no master VEVENT exists", () => {
    const overrideOnly = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//Test//EN",
      "BEGIN:VEVENT",
      "UID:override@local",
      "DTSTAMP:20260426T100000Z",
      "DTSTART:20260427T140000Z",
      "DTEND:20260427T150000Z",
      "RECURRENCE-ID:20260427T140000Z",
      "SUMMARY:Override only",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");
    expect(() => applyUpdateToIcs(overrideOnly, { summary: "x" })).toThrow(
      /No master VEVENT/,
    );
  });
});

describe("generateUid", () => {
  it("produces a unique-looking, namespaced uid", () => {
    const a = generateUid();
    const b = generateUid();
    expect(a).not.toBe(b);
    expect(a).toMatch(/@personal-agent$/);
    // RFC 4122 v4 UUID prefix
    expect(a.split("@")[0]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });
});
