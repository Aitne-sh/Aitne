import { describe, it, expect, vi } from "vitest";
import { CalendarService } from "./calendar.js";
import type { AgentConfig } from "../config.js";
import { SecretBroker } from "../secrets/secret-broker.js";
import type { SecretStore } from "../secrets/secret-store.js";
import type { StoredSecretName } from "../secrets/secret-names.js";

const mockEventsList = vi.fn().mockResolvedValue({
  data: {
    items: [
      {
        id: "ev1",
        summary: "Team standup",
        start: { dateTime: "2026-01-01T10:00:00Z" },
        end: { dateTime: "2026-01-01T10:30:00Z" },
        description: "Daily standup",
        location: "Room A",
      },
    ],
  },
});
const mockEventsInsert = vi.fn().mockResolvedValue({ data: { id: "event_123" } });
const mockEventsGet = vi.fn().mockResolvedValue({
  data: {
    id: "ev1",
    summary: "Team standup",
    start: { dateTime: "2026-01-01T10:00:00Z" },
    end: { dateTime: "2026-01-01T10:30:00Z" },
    description: "Daily standup",
    location: "Room A",
    status: "confirmed",
    htmlLink: "https://calendar.google.com/ev1",
    creator: { email: "owner@example.com", displayName: "Owner" },
    organizer: { email: "owner@example.com" },
    attendees: [
      { email: "a@example.com", responseStatus: "accepted", self: false, organizer: true, resource: false },
    ],
    recurrence: null,
    recurringEventId: null,
    reminders: { useDefault: true },
    visibility: "default",
    created: "2026-01-01T00:00:00Z",
    updated: "2026-01-01T00:00:00Z",
  },
});
const mockEventsPatch = vi.fn().mockResolvedValue({ data: { id: "ev1" } });
const mockEventsDelete = vi.fn().mockResolvedValue({});
const mockCalendarListList = vi.fn().mockResolvedValue({
  data: {
    items: [
      { id: "primary", summary: "Main Calendar", description: null, primary: true, backgroundColor: "#039be5", accessRole: "owner" },
      { id: "work@group.calendar.google.com", summary: "Work", description: "Work calendar", primary: false, backgroundColor: "#7986cb", accessRole: "writer" },
    ],
  },
});
const mockFreebusyQuery = vi.fn().mockResolvedValue({
  data: {
    calendars: {
      primary: {
        busy: [{ start: "2026-01-01T10:00:00Z", end: "2026-01-01T11:00:00Z" }],
      },
    },
  },
});

vi.mock("googleapis", () => ({
  google: {
    auth: {
      GoogleAuth: class MockGoogleAuth {},
      OAuth2: class MockOAuth2 {
        setCredentials() {}
        on() {}
      },
    },
    calendar: () => ({
      events: {
        list: mockEventsList,
        insert: mockEventsInsert,
        get: mockEventsGet,
        patch: mockEventsPatch,
        delete: mockEventsDelete,
      },
      calendarList: {
        list: mockCalendarListList,
      },
      freebusy: {
        query: mockFreebusyQuery,
      },
    }),
  },
}));

class InMemorySecretStore implements SecretStore {
  private readonly values = new Map<StoredSecretName, string>();

  constructor(seed: Partial<Record<StoredSecretName, string>> = {}) {
    for (const [key, value] of Object.entries(seed)) {
      if (typeof value === "string") this.values.set(key as StoredSecretName, value);
    }
  }

  async has(name: StoredSecretName): Promise<boolean> {
    return this.values.has(name);
  }

  async get(name: StoredSecretName): Promise<string | null> {
    return this.values.get(name) ?? null;
  }

  async set(name: StoredSecretName, value: string): Promise<void> {
    this.values.set(name, value);
  }

  async delete(name: StoredSecretName): Promise<void> {
    this.values.delete(name);
  }
}

function makeSecretBroker(
  seed: Partial<Record<StoredSecretName, string>> = {},
): SecretBroker {
  return new SecretBroker(new InMemorySecretStore(seed), { cacheTtlMs: 0 });
}

const SERVICE_ACCOUNT_CREDENTIALS = JSON.stringify({
  type: "service_account",
  client_email: "svc@example.com",
  private_key: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n",
});

async function makeInitializedService(): Promise<CalendarService> {
  const service = new CalendarService(
    { googleCalendarId: "primary" } as unknown as AgentConfig,
    makeSecretBroker({ googleCredentialsJson: SERVICE_ACCOUNT_CREDENTIALS }),
  );
  await service.init();
  return service;
}

describe("CalendarService", () => {
  it("reports unavailable when credentials not configured", () => {
    const service = new CalendarService({
      googleCalendarId: "primary",
    } as unknown as AgentConfig, makeSecretBroker());

    expect(service.available).toBe(false);
  });

  it("reports available after init when credentials are configured", async () => {
    const service = await makeInitializedService();
    expect(service.available).toBe(true);
  });

  it("listEvents returns empty when not initialized", async () => {
    const service = new CalendarService({
      googleCalendarId: "primary",
    } as unknown as AgentConfig, makeSecretBroker());

    const events = await service.listEvents("2026-01-01", "2026-01-02");
    expect(events).toEqual([]);
  });

  it("createEvent throws when not initialized", async () => {
    const service = new CalendarService({
      googleCalendarId: "primary",
    } as unknown as AgentConfig, makeSecretBroker());

    await expect(
      service.createEvent({
        summary: "Test",
        start: "2026-01-01T10:00:00Z",
        end: "2026-01-01T11:00:00Z",
      }),
    ).rejects.toThrow("Calendar service not initialized");
  });

  it("init does nothing when credentials are not configured", async () => {
    const service = new CalendarService({
      googleCalendarId: "primary",
    } as unknown as AgentConfig, makeSecretBroker());

    await service.init();
    expect(service.available).toBe(false);
  });

  it("listEvents returns events after init with service account", async () => {
    const service = await makeInitializedService();

    const events = await service.listEvents("2026-01-01", "2026-01-02");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      id: "ev1",
      summary: "Team standup",
      location: "Room A",
    });
  });

  it("createEvent works after init with service account", async () => {
    const service = await makeInitializedService();
    const result = await service.createEvent({
      summary: "New Event",
      start: "2026-01-01T14:00:00Z",
      end: "2026-01-01T15:00:00Z",
    });

    expect(result.eventId).toBe("event_123");
  });

  it("init with OAuth2 credentials requires token", async () => {
    const service = new CalendarService({
      googleCalendarId: "primary",
    } as unknown as AgentConfig, makeSecretBroker({
      googleCredentialsJson: JSON.stringify({
        installed: {
          client_id: "client-id",
          client_secret: "client-secret",
          redirect_uris: ["http://localhost"],
        },
      }),
      // No googleTokenJson provided
    }));

    await expect(service.init()).rejects.toThrow("OAuth2 credentials require authorization");
  });

  it("init with OAuth2 credentials and token succeeds", async () => {
    const service = new CalendarService({
      googleCalendarId: "primary",
    } as unknown as AgentConfig, makeSecretBroker({
      googleCredentialsJson: JSON.stringify({
        installed: {
          client_id: "client-id",
          client_secret: "client-secret",
          redirect_uris: ["http://localhost"],
        },
      }),
      googleTokenJson: JSON.stringify({
        access_token: "at",
        refresh_token: "rt",
      }),
    }));

    await service.init();
    expect(service.available).toBe(true);
  });

  // ── allDay flag ──

  describe("allDay flag", () => {
    it("returns allDay=false for timed events", async () => {
      const service = await makeInitializedService();
      const events = await service.listEvents("2026-01-01", "2026-01-02");
      expect(events[0]!.allDay).toBe(false);
    });

    it("returns allDay=true for date-only events", async () => {
      mockEventsList.mockResolvedValueOnce({
        data: {
          items: [
            {
              id: "allday1",
              summary: "Holiday",
              start: { date: "2026-01-01" },
              end: { date: "2026-01-02" },
              description: null,
              location: null,
            },
          ],
        },
      });

      const service = await makeInitializedService();
      const events = await service.listEvents("2026-01-01", "2026-01-02");
      expect(events[0]!.allDay).toBe(true);
      expect(events[0]!.start).toBe("2026-01-01");
    });
  });

  // ── All-day event creation (buildEventTimeFields) ──

  describe("all-day event creation", () => {
    it("creates all-day event with date format", async () => {
      const service = await makeInitializedService();
      await service.createEvent({
        summary: "Holiday",
        start: "2026-04-11",
        end: "2026-04-12",
      });

      expect(mockEventsInsert).toHaveBeenCalledWith(
        expect.objectContaining({
          requestBody: expect.objectContaining({
            summary: "Holiday",
            start: { date: "2026-04-11" },
            end: { date: "2026-04-12" },
          }),
        }),
      );
    });

    it("creates timed event with dateTime format", async () => {
      const service = await makeInitializedService();
      await service.createEvent({
        summary: "Meeting",
        start: "2026-04-11T14:00:00+09:00",
        end: "2026-04-11T15:00:00+09:00",
      });

      expect(mockEventsInsert).toHaveBeenCalledWith(
        expect.objectContaining({
          requestBody: expect.objectContaining({
            start: { dateTime: "2026-04-11T14:00:00+09:00" },
            end: { dateTime: "2026-04-11T15:00:00+09:00" },
          }),
        }),
      );
    });

    it("passes sendUpdates to Google API", async () => {
      const service = await makeInitializedService();
      await service.createEvent(
        { summary: "Ev", start: "2026-01-01T10:00:00Z", end: "2026-01-01T11:00:00Z" },
        "all",
      );
      expect(mockEventsInsert).toHaveBeenCalledWith(
        expect.objectContaining({ sendUpdates: "all" }),
      );
    });
  });

  // ── getEvent ──

  describe("getEvent", () => {
    it("throws when not initialized", async () => {
      const service = new CalendarService(
        { googleCalendarId: "primary" } as unknown as AgentConfig,
        makeSecretBroker(),
      );
      await expect(service.getEvent("ev1")).rejects.toThrow("Calendar service not initialized");
    });

    it("returns event detail with sanitized attendees", async () => {
      const service = await makeInitializedService();
      const event = await service.getEvent("ev1");
      expect(event.id).toBe("ev1");
      expect(event.status).toBe("confirmed");
      expect(event.htmlLink).toBe("https://calendar.google.com/ev1");
      expect(event.creator).toEqual({ email: "owner@example.com", displayName: "Owner" });
      // Verify attendees are sanitized — no 'organizer' or 'resource' fields
      expect(event.attendees).toHaveLength(1);
      expect(event.attendees![0]).toEqual({
        email: "a@example.com",
        responseStatus: "accepted",
        self: false,
      });
      expect(event.attendees![0]).not.toHaveProperty("organizer");
      expect(event.attendees![0]).not.toHaveProperty("resource");
    });

    it("passes calendarId to Google API", async () => {
      const service = await makeInitializedService();
      await service.getEvent("ev1", "work@group.calendar.google.com");
      expect(mockEventsGet).toHaveBeenCalledWith({
        calendarId: "work@group.calendar.google.com",
        eventId: "ev1",
      });
    });

    it("uses default calendarId when not specified", async () => {
      const service = await makeInitializedService();
      await service.getEvent("ev1");
      expect(mockEventsGet).toHaveBeenCalledWith({
        calendarId: "primary",
        eventId: "ev1",
      });
    });
  });

  // ── updateEvent ──

  describe("updateEvent", () => {
    it("throws when not initialized", async () => {
      const service = new CalendarService(
        { googleCalendarId: "primary" } as unknown as AgentConfig,
        makeSecretBroker(),
      );
      await expect(service.updateEvent("ev1", { summary: "New" })).rejects.toThrow("Calendar service not initialized");
    });

    it("calls events.patch with correct params", async () => {
      const service = await makeInitializedService();
      const result = await service.updateEvent("ev1", { summary: "Updated" }, "none");
      expect(result.eventId).toBe("ev1");
      expect(mockEventsPatch).toHaveBeenCalledWith(
        expect.objectContaining({
          calendarId: "primary",
          eventId: "ev1",
          sendUpdates: "none",
          requestBody: expect.objectContaining({ summary: "Updated" }),
        }),
      );
    });

    it("handles partial time updates (start only)", async () => {
      const service = await makeInitializedService();
      await service.updateEvent("ev1", { start: "2026-04-11T15:00:00+09:00" });
      expect(mockEventsPatch).toHaveBeenCalledWith(
        expect.objectContaining({
          requestBody: expect.objectContaining({
            start: { dateTime: "2026-04-11T15:00:00+09:00" },
          }),
        }),
      );
      // Verify end is NOT in the requestBody
      const call = mockEventsPatch.mock.calls[mockEventsPatch.mock.calls.length - 1]![0];
      expect(call.requestBody).not.toHaveProperty("end");
    });

    it("handles all-day event update", async () => {
      const service = await makeInitializedService();
      await service.updateEvent("ev1", { start: "2026-04-11", end: "2026-04-12" });
      expect(mockEventsPatch).toHaveBeenCalledWith(
        expect.objectContaining({
          requestBody: expect.objectContaining({
            start: { date: "2026-04-11" },
            end: { date: "2026-04-12" },
          }),
        }),
      );
    });
  });

  // ── deleteEvent ──

  describe("deleteEvent", () => {
    it("throws when not initialized", async () => {
      const service = new CalendarService(
        { googleCalendarId: "primary" } as unknown as AgentConfig,
        makeSecretBroker(),
      );
      await expect(service.deleteEvent("ev1")).rejects.toThrow("Calendar service not initialized");
    });

    it("calls events.delete with correct params", async () => {
      const service = await makeInitializedService();
      await service.deleteEvent("ev1", "all", "work");
      expect(mockEventsDelete).toHaveBeenCalledWith({
        calendarId: "work",
        eventId: "ev1",
        sendUpdates: "all",
      });
    });
  });

  // ── listCalendars ──

  describe("listCalendars", () => {
    it("throws when not initialized", async () => {
      const service = new CalendarService(
        { googleCalendarId: "primary" } as unknown as AgentConfig,
        makeSecretBroker(),
      );
      await expect(service.listCalendars()).rejects.toThrow("Calendar service not initialized");
    });

    it("returns calendar list", async () => {
      const service = await makeInitializedService();
      const calendars = await service.listCalendars();
      expect(calendars).toHaveLength(2);
      expect(calendars[0]).toEqual({
        id: "primary",
        summary: "Main Calendar",
        description: null,
        primary: true,
        backgroundColor: "#039be5",
        accessRole: "owner",
      });
      expect(calendars[1]!.primary).toBe(false);
    });
  });

  // ── queryFreeBusy ──

  describe("queryFreeBusy", () => {
    it("throws when not initialized", async () => {
      const service = new CalendarService(
        { googleCalendarId: "primary" } as unknown as AgentConfig,
        makeSecretBroker(),
      );
      await expect(
        service.queryFreeBusy("2026-01-01T09:00:00Z", "2026-01-01T18:00:00Z"),
      ).rejects.toThrow("Calendar service not initialized");
    });

    it("returns freebusy result", async () => {
      const service = await makeInitializedService();
      const result = await service.queryFreeBusy(
        "2026-01-01T09:00:00Z",
        "2026-01-01T18:00:00Z",
      );
      expect(result.calendars.primary.busy).toHaveLength(1);
      expect(result.calendars.primary.busy[0]).toEqual({
        start: "2026-01-01T10:00:00Z",
        end: "2026-01-01T11:00:00Z",
      });
    });

    it("defaults to primary calendarId when calendarIds not provided", async () => {
      const service = await makeInitializedService();
      await service.queryFreeBusy("2026-01-01T09:00:00Z", "2026-01-01T18:00:00Z");
      expect(mockFreebusyQuery).toHaveBeenCalledWith({
        requestBody: {
          timeMin: "2026-01-01T09:00:00Z",
          timeMax: "2026-01-01T18:00:00Z",
          items: [{ id: "primary" }],
        },
      });
    });

    it("passes explicit calendarIds to Google API", async () => {
      const service = await makeInitializedService();
      await service.queryFreeBusy(
        "2026-01-01T09:00:00Z",
        "2026-01-01T18:00:00Z",
        ["primary", "work"],
      );
      expect(mockFreebusyQuery).toHaveBeenCalledWith({
        requestBody: expect.objectContaining({
          items: [{ id: "primary" }, { id: "work" }],
        }),
      });
    });
  });

  // ── listEvents with query parameter ──

  describe("listEvents with query", () => {
    it("passes q parameter to Google API", async () => {
      const service = await makeInitializedService();
      await service.listEvents("2026-01-01T00:00:00Z", "2026-01-02T00:00:00Z", "standup");
      expect(mockEventsList).toHaveBeenCalledWith(
        expect.objectContaining({ q: "standup" }),
      );
    });

    it("omits q when not provided", async () => {
      const service = await makeInitializedService();
      await service.listEvents("2026-01-01T00:00:00Z", "2026-01-02T00:00:00Z");
      const call = mockEventsList.mock.calls[mockEventsList.mock.calls.length - 1]![0];
      expect(call).not.toHaveProperty("q");
    });

    it("passes calendarId override", async () => {
      const service = await makeInitializedService();
      await service.listEvents("2026-01-01T00:00:00Z", "2026-01-02T00:00:00Z", undefined, "work");
      expect(mockEventsList).toHaveBeenCalledWith(
        expect.objectContaining({ calendarId: "work" }),
      );
    });
  });
});
