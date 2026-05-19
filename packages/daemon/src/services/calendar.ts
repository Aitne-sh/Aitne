import { createLogger } from "../logging.js";
import type { AgentConfig } from "../config.js";
import type { SecretBroker } from "../secrets/secret-broker.js";
import {
  getGoogleOAuthClientConfig,
  mergeGoogleTokenPayload,
  parseGoogleCredentialsJson,
} from "./google-auth.js";

const logger = createLogger("calendar-service");

export interface CalendarEvent {
  id: string;
  summary: string | null;
  start: string | null;
  end: string | null;
  description: string | null;
  location: string | null;
  allDay: boolean;
}

export interface CalendarEventDetail extends CalendarEvent {
  status: string | null;
  htmlLink: string | null;
  creator: { email: string; displayName?: string } | null;
  organizer: { email: string; displayName?: string } | null;
  attendees: Array<{
    email: string;
    displayName?: string;
    responseStatus: string;
    self?: boolean;
  }> | null;
  recurrence: string[] | null;
  recurringEventId: string | null;
  reminders: {
    useDefault: boolean;
    overrides?: Array<{ method: string; minutes: number }>;
  } | null;
  visibility: string | null;
  created: string | null;
  updated: string | null;
}

export interface CreateEventParams {
  summary: string;
  start: string;
  end: string;
  description?: string;
  location?: string;
  reminders?: { useDefault: boolean; overrides?: Array<{ method: string; minutes: number }> };
  recurrence?: string[];
  attendees?: Array<{ email: string }>;
  visibility?: string;
}

export interface UpdateEventParams {
  summary?: string;
  start?: string;
  end?: string;
  description?: string;
  location?: string;
  reminders?: { useDefault: boolean; overrides?: Array<{ method: string; minutes: number }> };
  recurrence?: string[];
  attendees?: Array<{ email: string }>;
  visibility?: string;
}

export interface CalendarListEntry {
  id: string;
  summary: string;
  description: string | null;
  primary: boolean;
  backgroundColor: string | null;
  accessRole: string;
}

export interface FreeBusyResult {
  calendars: Record<string, {
    busy: Array<{ start: string; end: string }>;
  }>;
}

export class CalendarService {
  private calendar: GoogleCalendarApi | null = null;
  private readonly calendarId: string;

  constructor(
    config: Pick<AgentConfig, "googleCalendarId">,
    private readonly secretBroker: SecretBroker,
  ) {
    this.calendarId = config.googleCalendarId;
  }

  get available(): boolean {
    return this.calendar !== null;
  }

  async init(): Promise<void> {
    const credentialsRaw = await this.secretBroker.getGoogleCredentialsJson();
    if (!credentialsRaw) {
      logger.warn("Google Calendar credentials not configured");
      return;
    }

    this.calendar = await createGoogleCalendarApi(credentialsRaw, this.secretBroker);
    logger.info("Calendar service initialized");
  }

  async listEvents(timeMin: string, timeMax: string, query?: string, calendarId?: string): Promise<CalendarEvent[]> {
    if (!this.calendar) return [];
    return this.calendar.listEvents(calendarId ?? this.calendarId, timeMin, timeMax, query);
  }

  async getEvent(eventId: string, calendarId?: string): Promise<CalendarEventDetail> {
    if (!this.calendar) {
      throw new Error("Calendar service not initialized");
    }
    return this.calendar.getEvent(calendarId ?? this.calendarId, eventId);
  }

  async createEvent(params: CreateEventParams, sendUpdates?: string, calendarId?: string): Promise<{ eventId: string }> {
    if (!this.calendar) {
      throw new Error("Calendar service not initialized");
    }
    return this.calendar.createEvent(calendarId ?? this.calendarId, params, sendUpdates);
  }

  async updateEvent(eventId: string, params: UpdateEventParams, sendUpdates?: string, calendarId?: string): Promise<{ eventId: string }> {
    if (!this.calendar) {
      throw new Error("Calendar service not initialized");
    }
    return this.calendar.updateEvent(calendarId ?? this.calendarId, eventId, params, sendUpdates);
  }

  async deleteEvent(eventId: string, sendUpdates?: string, calendarId?: string): Promise<void> {
    if (!this.calendar) {
      throw new Error("Calendar service not initialized");
    }
    return this.calendar.deleteEvent(calendarId ?? this.calendarId, eventId, sendUpdates);
  }

  async listCalendars(): Promise<CalendarListEntry[]> {
    if (!this.calendar) {
      throw new Error("Calendar service not initialized");
    }
    return this.calendar.listCalendars();
  }

  async queryFreeBusy(timeMin: string, timeMax: string, calendarIds?: string[]): Promise<FreeBusyResult> {
    if (!this.calendar) {
      throw new Error("Calendar service not initialized");
    }
    const ids = calendarIds ?? [this.calendarId];
    return this.calendar.queryFreeBusy(timeMin, timeMax, ids);
  }
}

// ── Internal helpers ──

/** YYYY-MM-DD format check (no T = date-only) */
function isDateOnly(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

/** Convert a single time value to Google API format */
function toGoogleTime(value: string): { dateTime: string } | { date: string } {
  return isDateOnly(value) ? { date: value } : { dateTime: value };
}

/** Build start/end fields independently for Google API request body */
function buildEventTimeFields(params: { start?: string; end?: string }): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  if (params.start) result.start = toGoogleTime(params.start);
  if (params.end) result.end = toGoogleTime(params.end);
  return result;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseCalendarEvent(item: any): CalendarEvent {
  const startValue = item.start?.dateTime ?? item.start?.date ?? null;
  return {
    id: item.id ?? "",
    summary: item.summary ?? null,
    start: startValue,
    end: item.end?.dateTime ?? item.end?.date ?? null,
    description: item.description ?? null,
    location: item.location ?? null,
    allDay: !item.start?.dateTime && !!item.start?.date,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseCalendarEventDetail(item: any): CalendarEventDetail {
  // Sanitize attendees to only include defined interface fields
  const attendees = Array.isArray(item.attendees)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ? item.attendees.map((a: any) => ({
        email: a.email ?? "",
        ...(a.displayName != null && { displayName: a.displayName }),
        responseStatus: a.responseStatus ?? "needsAction",
        ...(a.self != null && { self: a.self }),
      }))
    : null;

  return {
    ...parseCalendarEvent(item),
    status: item.status ?? null,
    htmlLink: item.htmlLink ?? null,
    creator: item.creator ? { email: item.creator.email ?? "", ...(item.creator.displayName != null && { displayName: item.creator.displayName }) } : null,
    organizer: item.organizer ? { email: item.organizer.email ?? "", ...(item.organizer.displayName != null && { displayName: item.organizer.displayName }) } : null,
    attendees,
    recurrence: item.recurrence ?? null,
    recurringEventId: item.recurringEventId ?? null,
    reminders: item.reminders ?? null,
    visibility: item.visibility ?? null,
    created: item.created ?? null,
    updated: item.updated ?? null,
  };
}

// ── Google Calendar API adapter ──

interface GoogleCalendarApi {
  listEvents(calendarId: string, timeMin: string, timeMax: string, query?: string): Promise<CalendarEvent[]>;
  getEvent(calendarId: string, eventId: string): Promise<CalendarEventDetail>;
  createEvent(calendarId: string, params: CreateEventParams, sendUpdates?: string): Promise<{ eventId: string }>;
  updateEvent(calendarId: string, eventId: string, params: UpdateEventParams, sendUpdates?: string): Promise<{ eventId: string }>;
  deleteEvent(calendarId: string, eventId: string, sendUpdates?: string): Promise<void>;
  listCalendars(): Promise<CalendarListEntry[]>;
  queryFreeBusy(timeMin: string, timeMax: string, calendarIds: string[]): Promise<FreeBusyResult>;
}

async function createGoogleCalendarApi(
  credentialsRaw: string,
  secretBroker: SecretBroker,
): Promise<GoogleCalendarApi> {
  const credentials = parseGoogleCredentialsJson(credentialsRaw);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let google: any;
  try {
    const mod = await import("googleapis" as string);
    google = mod.google;
  } catch {
    throw new Error(
      "googleapis package not installed. Run: pnpm --filter @aitne/daemon add googleapis",
    );
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let auth: any;

  if (credentials.type === "service_account") {
    auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ["https://www.googleapis.com/auth/calendar"],
    });
  } else {
    const tokenRaw = await secretBroker.getGoogleTokenJson();
    if (!tokenRaw) {
      throw new Error("OAuth2 credentials require authorization. Click 'Authorize' in the dashboard.");
    }

    const token = JSON.parse(tokenRaw) as Record<string, unknown>;
    const clientConfig = getGoogleOAuthClientConfig(credentials);
    if (!clientConfig) {
      throw new Error("Invalid Google Calendar credentials format");
    }

    auth = new google.auth.OAuth2(
      clientConfig.client_id,
      clientConfig.client_secret,
      clientConfig.redirect_uris?.[0],
    );
    auth.setCredentials(token);
    auth.on("tokens", async (tokens: Record<string, unknown>) => {
      try {
        const existingRaw = await secretBroker.getGoogleTokenJson();
        const merged = mergeGoogleTokenPayload(existingRaw, tokens);
        await secretBroker.saveGoogleTokenJson(merged);
      } catch (error) {
        logger.error({ err: error }, "Failed to persist refreshed Google Calendar token");
      }
    });
  }

  const calendar = google.calendar({ version: "v3", auth });

  return {
    async listEvents(calendarId, timeMin, timeMax, query) {
      const params: Record<string, unknown> = {
        calendarId,
        timeMin,
        timeMax,
        singleEvents: true,
        orderBy: "startTime",
        maxResults: 250,
      };
      if (query) params.q = query;

      const res = await calendar.events.list(params);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (res.data.items ?? []).map((item: any) => parseCalendarEvent(item));
    },

    async getEvent(calendarId, eventId) {
      const res = await calendar.events.get({ calendarId, eventId });
      return parseCalendarEventDetail(res.data);
    },

    async createEvent(calendarId, params, sendUpdates) {
      const timeFields = buildEventTimeFields(params);
      const requestBody: Record<string, unknown> = {
        summary: params.summary,
        ...timeFields,
      };
      if (params.description !== undefined) requestBody.description = params.description;
      if (params.location !== undefined) requestBody.location = params.location;
      if (params.reminders !== undefined) requestBody.reminders = params.reminders;
      if (params.recurrence !== undefined) requestBody.recurrence = params.recurrence;
      if (params.attendees !== undefined) requestBody.attendees = params.attendees;
      if (params.visibility !== undefined) requestBody.visibility = params.visibility;

      const res = await calendar.events.insert({
        calendarId,
        sendUpdates: sendUpdates ?? "none",
        requestBody,
      });

      return { eventId: res.data.id ?? "" };
    },

    async updateEvent(calendarId, eventId, params, sendUpdates) {
      const timeFields = buildEventTimeFields(params);
      const requestBody: Record<string, unknown> = { ...timeFields };
      if (params.summary !== undefined) requestBody.summary = params.summary;
      if (params.description !== undefined) requestBody.description = params.description;
      if (params.location !== undefined) requestBody.location = params.location;
      if (params.reminders !== undefined) requestBody.reminders = params.reminders;
      if (params.recurrence !== undefined) requestBody.recurrence = params.recurrence;
      if (params.attendees !== undefined) requestBody.attendees = params.attendees;
      if (params.visibility !== undefined) requestBody.visibility = params.visibility;

      const res = await calendar.events.patch({
        calendarId,
        eventId,
        sendUpdates: sendUpdates ?? "none",
        requestBody,
      });

      return { eventId: res.data.id ?? "" };
    },

    async deleteEvent(calendarId, eventId, sendUpdates) {
      await calendar.events.delete({
        calendarId,
        eventId,
        sendUpdates: sendUpdates ?? "none",
      });
    },

    async listCalendars() {
      const res = await calendar.calendarList.list({ maxResults: 250 });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (res.data.items ?? []).map((item: any) => ({
        id: item.id ?? "",
        summary: item.summary ?? "",
        description: item.description ?? null,
        primary: item.primary ?? false,
        backgroundColor: item.backgroundColor ?? null,
        accessRole: item.accessRole ?? "reader",
      }));
    },

    async queryFreeBusy(timeMin, timeMax, calendarIds) {
      const res = await calendar.freebusy.query({
        requestBody: {
          timeMin,
          timeMax,
          items: calendarIds.map((id) => ({ id })),
        },
      });

      const calendars: FreeBusyResult["calendars"] = {};
      const rawCalendars = res.data.calendars ?? {};
      for (const [id, data] of Object.entries(rawCalendars)) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const d = data as any;
        calendars[id] = {
          busy: (d.busy ?? []).map((b: { start?: string; end?: string }) => ({
            start: b.start ?? "",
            end: b.end ?? "",
          })),
        };
      }
      return { calendars };
    },
  };
}
