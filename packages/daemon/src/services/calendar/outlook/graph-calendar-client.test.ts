import { describe, expect, it, vi } from "vitest";
import {
  OutlookGraphCalendarClient,
  type OutlookCalendarEvent,
  type OutlookCalendarRef,
} from "./graph-calendar-client.js";
import type { GraphTokenProvider } from "../../mail/outlook/graph-client.js";

function makeTokenProvider(): GraphTokenProvider {
  return {
    getAccessToken: vi.fn(async () => "test-token"),
    invalidateToken: vi.fn(),
  };
}

function makeFetch(handler: (url: string, init: RequestInit) => Response) {
  return vi.fn(async (input: string | URL, init?: RequestInit) => {
    return handler(String(input), init ?? {});
  }) as unknown as typeof fetch;
}

function jsonResponse(body: unknown, init: { status?: number } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("OutlookGraphCalendarClient.listCalendars", () => {
  it("requests /me/calendars with the documented $select projection", async () => {
    const fetchImpl = makeFetch((url) => {
      expect(url).toContain("/me/calendars");
      // `timeZone` must be in the projection because the parser returns it;
      // shipping `canEdit` instead would leave `OutlookCalendarRef.timeZone`
      // perpetually null while paying for an unused field.
      expect(url).toContain("$select=id,name,isDefaultCalendar,owner,timeZone");
      return jsonResponse({
        value: [
          {
            id: "AAA",
            name: "Calendar",
            isDefaultCalendar: true,
            owner: { name: "Test", address: "test@example.com" },
            timeZone: "Tokyo Standard Time",
          },
          {
            id: "BBB",
            name: "Holidays",
            isDefaultCalendar: false,
          },
        ],
      });
    });
    const client = OutlookGraphCalendarClient.fromTokenProvider(
      makeTokenProvider(),
      { fetchImpl },
    );
    const calendars = await client.listCalendars();
    expect(calendars).toHaveLength(2);
    const primary = calendars[0] as OutlookCalendarRef;
    expect(primary.id).toBe("AAA");
    expect(primary.isDefaultCalendar).toBe(true);
    expect(primary.owner).toBe("test@example.com");
    expect(primary.timeZone).toBe("Tokyo Standard Time");
    const secondary = calendars[1] as OutlookCalendarRef;
    expect(secondary.isDefaultCalendar).toBe(false);
    // Owner falls through to null when neither address nor name is present.
    expect(secondary.owner).toBeNull();
    // timeZone is null when Graph omits it (e.g. holiday calendars).
    expect(secondary.timeZone).toBeNull();
  });

  it("returns an empty list when Graph emits no value", async () => {
    const fetchImpl = makeFetch(() => jsonResponse({}));
    const client = OutlookGraphCalendarClient.fromTokenProvider(
      makeTokenProvider(),
      { fetchImpl },
    );
    expect(await client.listCalendars()).toEqual([]);
  });

  it("propagates Graph errors to the caller", async () => {
    const fetchImpl = makeFetch(() =>
      new Response(
        JSON.stringify({ error: { code: "BadRequest", message: "no" } }),
        { status: 400 },
      ),
    );
    const client = OutlookGraphCalendarClient.fromTokenProvider(
      makeTokenProvider(),
      { fetchImpl, maxRetryAfterRetries: 0 },
    );
    await expect(client.listCalendars()).rejects.toThrow();
  });

  it("falls back to the owner display name when address is absent", async () => {
    const fetchImpl = makeFetch(() =>
      jsonResponse({
        value: [
          {
            id: "X",
            name: "Personal",
            isDefaultCalendar: true,
            owner: { name: "Alice" },
          },
        ],
      }),
    );
    const client = OutlookGraphCalendarClient.fromTokenProvider(
      makeTokenProvider(),
      { fetchImpl },
    );
    const [cal] = await client.listCalendars();
    expect(cal!.owner).toBe("Alice");
  });

  it("handles a null item in the value array defensively (parseCalendarRef null-guard)", async () => {
    // When Graph returns a null/undefined entry in the value array (malformed
    // but theoretically possible), parseCalendarRef should substitute {} and
    // return a zero-filled record rather than throwing.
    const fetchImpl = makeFetch(() =>
      jsonResponse({ value: [null] }),
    );
    const client = OutlookGraphCalendarClient.fromTokenProvider(
      makeTokenProvider(),
      { fetchImpl },
    );
    const calendars = await client.listCalendars();
    expect(calendars).toHaveLength(1);
    const cal = calendars[0]!;
    expect(cal.id).toBe("");          // r.id ?? "" branch
    expect(cal.name).toBe("");        // r.name ?? "" branch
    expect(cal.isDefaultCalendar).toBe(false);
    expect(cal.owner).toBeNull();
    expect(cal.timeZone).toBeNull();
  });
});

describe("OutlookGraphCalendarClient.listEvents", () => {
  it("uses /me/calendarView when no calendarId is supplied", async () => {
    const fetchImpl = makeFetch((url, init) => {
      expect(url).toContain("/me/calendarView");
      expect(url).toContain("startDateTime=");
      expect(url).toContain("endDateTime=");
      // Graph requires the Prefer header to express times in UTC.
      const headers = (init.headers ?? {}) as Record<string, string>;
      expect(headers.Prefer).toBe('outlook.timezone="UTC"');
      return jsonResponse({
        value: [
          {
            id: "evt1",
            subject: "Standup",
            start: { dateTime: "2026-05-04T10:00:00.0000000", timeZone: "UTC" },
            end: { dateTime: "2026-05-04T10:30:00.0000000", timeZone: "UTC" },
            isAllDay: false,
            organizer: { emailAddress: { address: "boss@example.com", name: "Boss" } },
            webLink: "https://outlook.office.com/...",
            bodyPreview: "Daily sync",
          },
        ],
      });
    });
    const client = OutlookGraphCalendarClient.fromTokenProvider(
      makeTokenProvider(),
      { fetchImpl },
    );
    const events = await client.listEvents({
      startUtc: "2026-05-04T00:00:00Z",
      endUtc: "2026-05-05T00:00:00Z",
    });
    expect(events).toHaveLength(1);
    const evt = events[0] as OutlookCalendarEvent;
    expect(evt.id).toBe("evt1");
    expect(evt.subject).toBe("Standup");
    expect(evt.startUtc).toBe("2026-05-04T10:00:00.000Z");
    expect(evt.endUtc).toBe("2026-05-04T10:30:00.000Z");
    expect(evt.organizer).toBe("boss@example.com");
    expect(evt.bodyPreview).toBe("Daily sync");
    expect(evt.isAllDay).toBe(false);
    expect(evt.webLink).toBe("https://outlook.office.com/...");
  });

  it("scopes to the supplied calendarId and respects the $top override", async () => {
    const fetchImpl = makeFetch((url) => {
      expect(url).toContain("/me/calendars/AAA%3D%3D/calendarView");
      expect(url).toContain("$top=10");
      return jsonResponse({ value: [] });
    });
    const client = OutlookGraphCalendarClient.fromTokenProvider(
      makeTokenProvider(),
      { fetchImpl },
    );
    const events = await client.listEvents(
      { startUtc: "2026-05-04T00:00:00Z", endUtc: "2026-05-05T00:00:00Z" },
      { calendarId: "AAA==", top: 10 },
    );
    expect(events).toEqual([]);
  });

  it("falls back to organizer name when address is missing", async () => {
    const fetchImpl = makeFetch(() =>
      jsonResponse({
        value: [
          {
            id: "evt2",
            subject: "Solo",
            start: { dateTime: "2026-05-04T11:00:00.0000000" },
            end: { dateTime: "2026-05-04T12:00:00.0000000" },
            isAllDay: true,
            organizer: { emailAddress: { name: "Anon" } },
          },
        ],
      }),
    );
    const client = OutlookGraphCalendarClient.fromTokenProvider(
      makeTokenProvider(),
      { fetchImpl },
    );
    const [evt] = await client.listEvents({
      startUtc: "2026-05-04T00:00:00Z",
      endUtc: "2026-05-05T00:00:00Z",
    });
    expect(evt!.organizer).toBe("Anon");
    expect(evt!.isAllDay).toBe(true);
  });

  it("returns the original raw dateTime when parsing fails", async () => {
    const fetchImpl = makeFetch(() =>
      jsonResponse({
        value: [
          {
            id: "evt3",
            subject: "Bad date",
            start: { dateTime: "not-a-date" },
            end: { dateTime: "" },
          },
        ],
      }),
    );
    const client = OutlookGraphCalendarClient.fromTokenProvider(
      makeTokenProvider(),
      { fetchImpl },
    );
    const [evt] = await client.listEvents({
      startUtc: "2026-05-04T00:00:00Z",
      endUtc: "2026-05-05T00:00:00Z",
    });
    expect(evt!.startUtc).toBe("not-a-date");
    expect(evt!.endUtc).toBe("");
    expect(evt!.organizer).toBeNull();
    expect(evt!.webLink).toBeNull();
  });

  it("returns an empty list when Graph emits no value", async () => {
    const fetchImpl = makeFetch(() => jsonResponse({}));
    const client = OutlookGraphCalendarClient.fromTokenProvider(
      makeTokenProvider(),
      { fetchImpl },
    );
    const events = await client.listEvents({
      startUtc: "2026-05-04T00:00:00Z",
      endUtc: "2026-05-05T00:00:00Z",
    });
    expect(events).toEqual([]);
  });

  it("substitutes empty defaults when Graph omits id/subject/start/end altogether", async () => {
    // Defensive — a malformed item with no id, no subject, no start, no end,
    // and no organizer email is parsed into a record with empty strings and
    // null fallbacks. Hits the `?? {}` branch on `end` and the `?? ""`
    // branches on `id` and `subject`.
    const fetchImpl = makeFetch(() =>
      jsonResponse({
        value: [
          {
            // No id, no subject, no start, no end, no organizer.
          },
        ],
      }),
    );
    const client = OutlookGraphCalendarClient.fromTokenProvider(
      makeTokenProvider(),
      { fetchImpl },
    );
    const [evt] = await client.listEvents({
      startUtc: "2026-05-04T00:00:00Z",
      endUtc: "2026-05-05T00:00:00Z",
    });
    expect(evt).toBeDefined();
    expect(evt!.id).toBe("");
    expect(evt!.subject).toBe("");
    expect(evt!.startUtc).toBe("");
    expect(evt!.endUtc).toBe("");
    expect(evt!.organizer).toBeNull();
    expect(evt!.isAllDay).toBe(false);
    expect(evt!.webLink).toBeNull();
    expect(evt!.bodyPreview).toBe("");
  });

  it("returns the dateTime unchanged when Graph already includes a trailing Z", async () => {
    // The `raw.endsWith("Z") ? raw : ${raw}Z` guard lets the parser skip the
    // trailing-Z fixup when Graph already supplies it (a few tenant configs
    // do). This exercises the `raw` branch of the conditional.
    const fetchImpl = makeFetch(() =>
      jsonResponse({
        value: [
          {
            id: "evt-z",
            subject: "Already-zoned",
            start: { dateTime: "2026-05-04T10:00:00.000Z" },
            end: { dateTime: "2026-05-04T10:30:00.000Z" },
          },
        ],
      }),
    );
    const client = OutlookGraphCalendarClient.fromTokenProvider(
      makeTokenProvider(),
      { fetchImpl },
    );
    const [evt] = await client.listEvents({
      startUtc: "2026-05-04T00:00:00Z",
      endUtc: "2026-05-05T00:00:00Z",
    });
    expect(evt!.startUtc).toBe("2026-05-04T10:00:00.000Z");
    expect(evt!.endUtc).toBe("2026-05-04T10:30:00.000Z");
  });

  it("handles a null item in the value array defensively (parseCalendarEvent null-guard)", async () => {
    // Same defensive guard: a null entry in calendarView response is parsed
    // into a zero-filled event rather than throwing.
    const fetchImpl = makeFetch(() =>
      jsonResponse({ value: [null] }),
    );
    const client = OutlookGraphCalendarClient.fromTokenProvider(
      makeTokenProvider(),
      { fetchImpl },
    );
    const events = await client.listEvents({
      startUtc: "2026-05-04T00:00:00Z",
      endUtc: "2026-05-05T00:00:00Z",
    });
    expect(events).toHaveLength(1);
    const evt = events[0]!;
    expect(evt.id).toBe("");
    expect(evt.subject).toBe("");
    expect(evt.startUtc).toBe("");
    expect(evt.endUtc).toBe("");
    expect(evt.organizer).toBeNull();
    expect(evt.isAllDay).toBe(false);
    expect(evt.webLink).toBeNull();
    expect(evt.bodyPreview).toBe("");
  });
});

describe("OutlookGraphCalendarClient construction", () => {
  it("accepts a pre-built GraphClient via { graphClient } and does NOT require tokenProvider", async () => {
    const requestJson = vi.fn(async () => ({ value: [] }));
    const fakeClient = { requestJson } as unknown as Parameters<
      typeof OutlookGraphCalendarClient.fromGraphClient
    >[0];
    const client = OutlookGraphCalendarClient.fromGraphClient(fakeClient);
    await client.listCalendars();
    expect(requestJson).toHaveBeenCalledTimes(1);
  });

  it("throws when neither graphClient nor tokenProvider is supplied", () => {
    // The discriminated-union type makes the empty-options call a TS error;
    // cast through `unknown` so we can still exercise the runtime guard,
    // which protects callers that route through generic `Record` plumbing.
    expect(
      () =>
        new OutlookGraphCalendarClient(
          {} as unknown as ConstructorParameters<typeof OutlookGraphCalendarClient>[0],
        ),
    ).toThrow(/graphClient.*tokenProvider/);
  });
});

describe("OutlookGraphCalendarClient.listEvents pagination", () => {
  it("follows @odata.nextLink across pages and stitches the results", async () => {
    let callCount = 0;
    const fetchImpl = makeFetch((url) => {
      callCount += 1;
      if (callCount === 1) {
        // Header check on every page is essential — Graph does not infer
        // `Prefer: outlook.timezone` from prior calls in the same session.
        return jsonResponse({
          value: [
            {
              id: "p1-evt1",
              subject: "Page1 Event1",
              start: { dateTime: "2026-05-04T10:00:00.0000000" },
              end: { dateTime: "2026-05-04T10:30:00.0000000" },
            },
          ],
          "@odata.nextLink": "https://graph.microsoft.com/v1.0/me/calendarView?$skiptoken=PAGE2",
        });
      }
      // The library should hit the absolute nextLink unchanged — that's
      // how Graph's skiptoken / deltatoken plumbing survives the round-trip.
      expect(url).toBe(
        "https://graph.microsoft.com/v1.0/me/calendarView?$skiptoken=PAGE2",
      );
      return jsonResponse({
        value: [
          {
            id: "p2-evt1",
            subject: "Page2 Event1",
            start: { dateTime: "2026-05-04T11:00:00.0000000" },
            end: { dateTime: "2026-05-04T11:30:00.0000000" },
          },
        ],
      });
    });
    const client = OutlookGraphCalendarClient.fromTokenProvider(
      makeTokenProvider(),
      { fetchImpl },
    );
    const events = await client.listEvents({
      startUtc: "2026-05-04T00:00:00Z",
      endUtc: "2026-05-05T00:00:00Z",
    });
    expect(events.map((e) => e.id)).toEqual(["p1-evt1", "p2-evt1"]);
    expect(callCount).toBe(2);
  });

  it("stops following @odata.nextLink once maxItems is reached", async () => {
    let callCount = 0;
    const fetchImpl = makeFetch(() => {
      callCount += 1;
      // Every page advertises a nextLink; the cap inside the wrapper is the
      // only thing that breaks the loop.
      return jsonResponse({
        value: Array.from({ length: 2 }, (_, i) => ({
          id: `p${callCount}-evt${i}`,
          subject: "x",
          start: { dateTime: "2026-05-04T10:00:00.0000000" },
          end: { dateTime: "2026-05-04T10:30:00.0000000" },
        })),
        "@odata.nextLink": "https://graph.microsoft.com/v1.0/me/calendarView?$skiptoken=NEXT",
      });
    });
    const client = OutlookGraphCalendarClient.fromTokenProvider(
      makeTokenProvider(),
      { fetchImpl },
    );
    const events = await client.listEvents(
      { startUtc: "2026-05-04T00:00:00Z", endUtc: "2026-05-05T00:00:00Z" },
      { maxItems: 3 },
    );
    expect(events).toHaveLength(3);
    // Page 1 returns 2 events (collected.length=2 < 3 → fetch page 2),
    // page 2 returns 2 more but the inner break trims at 3, then the loop
    // condition stops fetching → exactly 2 calls.
    expect(callCount).toBe(2);
  });
});
