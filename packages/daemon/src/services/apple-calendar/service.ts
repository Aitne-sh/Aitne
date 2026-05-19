import type { DAVCalendar } from "tsdav";
import { createLogger } from "../../logging.js";
import type { SecretBroker } from "../../secrets/secret-broker.js";
import {
  applyUpdateToIcs,
  buildEventIcs,
  composeEventId,
  generateUid,
  parseEventId,
  parseEventsFromIcs,
} from "./caldav-codec.js";
import {
  createICloudCalDavClient,
  type CalDavClient,
} from "./caldav-client.js";
import type {
  AppleCalendarCredentials,
  AppleCalendarEvent,
  AppleCalendarListEntry,
  CreateEventParams,
  FreeBusyResult,
  UpdateEventParams,
} from "./types.js";

const logger = createLogger("apple-calendar-service");

/**
 * `Recurring instance editing not supported` — surfaced as the route
 * 501 for PATCH/DELETE on a composite id. Kept centralized so the
 * route layer can match on instance.
 */
export class RecurringInstanceUnsupportedError extends Error {
  constructor() {
    super("Editing single occurrences of a recurring series is not supported");
    this.name = "RecurringInstanceUnsupportedError";
  }
}

export class EventNotFoundError extends Error {
  constructor(uid: string) {
    super(`Apple Calendar event not found: ${uid}`);
    this.name = "EventNotFoundError";
  }
}

/**
 * In-memory UID cache — populated on every list/get so update/delete can
 * resolve a UID to its CalDAV resource URL + ETag without scanning. Cache
 * entries do NOT expire (an iCloud user's calendar is stable enough that
 * a stale URL is overwritten by the next list); on miss the service
 * falls back to a wide time-range scan.
 */
interface ResourceHandle {
  url: string;
  etag: string | null;
  calendarUrl: string;
}

export class AppleCalendarService {
  private credentials: AppleCalendarCredentials | null = null;
  private client: CalDavClient | null = null;
  private calendars: DAVCalendar[] = [];
  private primaryCalendar: DAVCalendar | null = null;
  private readonly uidIndex = new Map<string, ResourceHandle>();
  private lastInitErrorMessage: string | null = null;

  constructor(private readonly secretBroker: SecretBroker) {}

  get available(): boolean {
    return this.client !== null && this.primaryCalendar !== null;
  }

  /**
   * Returns the underlying error message from the most recent failed
   * `init()` call, or `null` if init has never failed (or has succeeded
   * since the last failure). Callers surface this through
   * `services.errors.appleCalendar` so the dashboard's Connections card
   * shows the actual iCloud failure (`401 Unauthorized`, network error,
   * etc.) instead of a generic "discovery did not return" placeholder.
   */
  get initError(): string | null {
    return this.lastInitErrorMessage;
  }

  /**
   * Idempotent — call after credentials change. On success, primes the
   * client + calendar list. On failure (missing creds, bad password,
   * iCloud unreachable) leaves `available` false but does not throw —
   * callers check `available` and surface a 503.
   */
  async init(): Promise<void> {
    this.lastInitErrorMessage = null;
    this.credentials = await this.loadCredentials();
    if (!this.credentials) {
      this.client = null;
      this.primaryCalendar = null;
      return;
    }
    try {
      this.client = await createICloudCalDavClient(this.credentials);
      this.calendars = await this.client.fetchCalendars();
      this.primaryCalendar = this.pickPrimaryCalendar(this.calendars);
      logger.info(
        {
          calendars: this.calendars.length,
          primary: this.primaryCalendar?.url,
        },
        "Apple Calendar service initialized",
      );
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      logger.error({ err: msg }, "Apple Calendar init failed");
      this.lastInitErrorMessage = msg;
      this.client = null;
      this.primaryCalendar = null;
      this.calendars = [];
    }
  }

  /**
   * Connect / reconnect with new credentials. Persists to keychain on
   * success; throws on auth failure so the dashboard can surface the
   * specific error.
   */
  async connect(email: string, appPassword: string): Promise<void> {
    const next: AppleCalendarCredentials = { email, appPassword };
    const client = await createICloudCalDavClient(next);
    const calendars = await client.fetchCalendars();
    if (calendars.length === 0) {
      throw new Error(
        "iCloud returned no calendars — verify the Apple ID has at least one calendar",
      );
    }
    const primary = this.pickPrimaryCalendar(calendars);
    next.principalUrl = undefined;
    next.homeSetUrl = undefined;
    next.defaultCalendarUrl = primary?.url ?? calendars[0]?.url;

    await this.secretBroker.saveAppleCalendarCredentialsJson(JSON.stringify(next));
    this.credentials = next;
    this.client = client;
    this.calendars = calendars;
    this.primaryCalendar = primary;
    this.uidIndex.clear();
  }

  async disconnect(): Promise<void> {
    await this.secretBroker.deleteAppleCalendarCredentials();
    this.credentials = null;
    this.client = null;
    this.calendars = [];
    this.primaryCalendar = null;
    this.uidIndex.clear();
  }

  async setDefaultCalendar(calendarUrl: string): Promise<void> {
    if (!this.credentials) {
      throw new Error("Apple Calendar is not connected");
    }
    const match = this.calendars.find((c) => c.url === calendarUrl);
    if (!match) {
      throw new Error(`Unknown calendar URL: ${calendarUrl}`);
    }
    // Persist BEFORE mutating in-memory state, so a failed save cannot
    // leave the daemon talking to one calendar while the keychain
    // remembers a different one. The user retries cleanly on save error.
    const next: AppleCalendarCredentials = {
      ...this.credentials,
      defaultCalendarUrl: calendarUrl,
    };
    await this.secretBroker.saveAppleCalendarCredentialsJson(
      JSON.stringify(next),
    );
    this.credentials = next;
    this.primaryCalendar = match;
    // The cache holds {uid → {url, etag}} keyed against the previous
    // primary calendar's resource URLs. After switching primary, those
    // URLs no longer resolve — clear so the next update/delete repopulates
    // against the new calendar instead of phantom-404'ing once before
    // self-healing on retry.
    this.uidIndex.clear();
  }

  async listEvents(timeMinIso: string, timeMaxIso: string): Promise<AppleCalendarEvent[]> {
    this.requireAvailable();
    const objects = await this.client!.fetchCalendarObjectsExpanded({
      calendar: this.primaryCalendar!,
      timeMinIso,
      timeMaxIso,
    });
    const events: AppleCalendarEvent[] = [];
    const seen = new Set<string>();
    for (const obj of objects) {
      const data = typeof obj.data === "string" ? obj.data : null;
      if (!data) continue;
      const parsed = parseEventsFromIcs(data, obj.url, obj.etag ?? null);
      for (const event of parsed) {
        if (seen.has(event.id)) continue;
        seen.add(event.id);
        events.push(event);
        // Cache only master events (no RECURRENCE-ID): updates/deletes
        // currently target masters only.
        if (event.recurrenceId === null && event.url) {
          this.uidIndex.set(event.uid, {
            url: event.url,
            etag: event.etag,
            calendarUrl: this.primaryCalendar!.url,
          });
        }
      }
    }
    return events.sort((a, b) => (a.start ?? "").localeCompare(b.start ?? ""));
  }

  async getEvent(eventId: string): Promise<AppleCalendarEvent> {
    this.requireAvailable();
    const { uid, recurrenceId } = parseEventId(eventId);

    // A composite id (`<UID>__<RECURRENCE-ID>`) addresses a single
    // **expanded** occurrence of a recurring series. CalDAV resources
    // hold only the master VEVENT plus any moved-occurrence overrides;
    // a regular (un-moved) instance does not exist in the resource
    // body. Server-side `<C:expand>` is the only way to materialize
    // it. Window listEvents tightly around the RECURRENCE-ID anchor
    // so we fetch just the relevant instance set.
    if (recurrenceId !== null) {
      const anchorMs = Date.parse(recurrenceId);
      if (Number.isNaN(anchorMs)) {
        throw new EventNotFoundError(uid);
      }
      const timeMin = new Date(anchorMs - 60_000).toISOString();
      const timeMax = new Date(anchorMs + 86_400_000).toISOString();
      const list = await this.listEvents(timeMin, timeMax);
      const match = list.find((e) => e.id === eventId);
      if (!match) throw new EventNotFoundError(uid);
      return match;
    }

    const handle = await this.resolveUid(uid);
    if (!handle) {
      throw new EventNotFoundError(uid);
    }
    // Master / non-recurring path: address the resource directly via
    // its CalDAV URL. The UID→URL cache lets us collapse the O(N) cost
    // of iterating the entire calendar collection to one HTTP multi-get.
    const target = await this.client!.fetchCalendarObjectByUrl({
      calendar: this.primaryCalendar!,
      url: handle.url,
    });
    if (!target || typeof target.data !== "string") {
      this.uidIndex.delete(uid);
      throw new EventNotFoundError(uid);
    }
    const events = parseEventsFromIcs(target.data, target.url, target.etag ?? null);
    const match = events.find((e) => e.id === composeEventId(uid, null));
    if (!match) throw new EventNotFoundError(uid);
    this.uidIndex.set(uid, {
      url: target.url,
      etag: target.etag ?? null,
      calendarUrl: this.primaryCalendar!.url,
    });
    return match;
  }

  async createEvent(params: CreateEventParams): Promise<{ eventId: string }> {
    this.requireAvailable();
    const uid = generateUid();
    const ics = buildEventIcs(uid, params);
    const filename = `${encodeURIComponent(uid)}.ics`;
    const result = await this.client!.createCalendarObject({
      calendar: this.primaryCalendar!,
      filename,
      iCalString: ics,
    });
    this.uidIndex.set(uid, {
      url: result.url,
      etag: result.etag,
      calendarUrl: this.primaryCalendar!.url,
    });
    return { eventId: uid };
  }

  async updateEvent(eventId: string, params: UpdateEventParams): Promise<{ eventId: string }> {
    this.requireAvailable();
    const { uid, recurrenceId } = parseEventId(eventId);
    if (recurrenceId !== null) {
      throw new RecurringInstanceUnsupportedError();
    }
    const handle = await this.resolveUid(uid);
    if (!handle) throw new EventNotFoundError(uid);

    // Re-fetch via objectUrls to refresh the iCalendar body + ETag — the
    // cached etag could be stale if the user edited from iPhone since
    // our last list. iCloud's If-Match precondition rejects a stale
    // PUT with 412, which would surface as a generic 502; the fresh
    // fetch closes that race.
    const target = await this.client!.fetchCalendarObjectByUrl({
      calendar: this.primaryCalendar!,
      url: handle.url,
    });
    if (!target || typeof target.data !== "string") {
      this.uidIndex.delete(uid);
      throw new EventNotFoundError(uid);
    }
    const updatedIcs = applyUpdateToIcs(target.data, params);
    const result = await this.client!.updateCalendarObject({
      url: target.url,
      etag: target.etag ?? null,
      iCalString: updatedIcs,
    });
    this.uidIndex.set(uid, {
      url: target.url,
      etag: result.etag,
      calendarUrl: this.primaryCalendar!.url,
    });
    return { eventId: uid };
  }

  async deleteEvent(eventId: string): Promise<void> {
    this.requireAvailable();
    const { uid, recurrenceId } = parseEventId(eventId);
    if (recurrenceId !== null) {
      throw new RecurringInstanceUnsupportedError();
    }
    const handle = await this.resolveUid(uid);
    if (!handle) throw new EventNotFoundError(uid);
    await this.client!.deleteCalendarObject({
      url: handle.url,
      etag: handle.etag,
    });
    this.uidIndex.delete(uid);
  }

  listCalendars(): AppleCalendarListEntry[] {
    this.requireAvailable();
    const primaryUrl = this.primaryCalendar?.url;
    return this.calendars.map((c) => ({
      id: c.url,
      summary: typeof c.displayName === "string" ? c.displayName : c.url,
      description: typeof c.description === "string" ? c.description : null,
      primary: c.url === primaryUrl,
    }));
  }

  /**
   * iCloud's free-busy REPORT is unreliable — derive busy intervals
   * locally by listing events for the requested range and filtering out
   * cancelled events. The output uses the primary calendar's URL as the
   * map key so the response shape mirrors Google Calendar's freebusy.
   */
  async queryFreeBusy(timeMinIso: string, timeMaxIso: string): Promise<FreeBusyResult> {
    this.requireAvailable();
    const events = await this.listEvents(timeMinIso, timeMaxIso);
    const busy = events
      .filter((e) => e.status !== "cancelled" && e.start && e.end)
      .map((e) => ({ start: e.start as string, end: e.end as string }));
    return {
      calendars: {
        [this.primaryCalendar!.url]: { busy },
      },
    };
  }

  // ── Internal helpers ──

  private requireAvailable(): void {
    if (!this.client || !this.primaryCalendar) {
      throw new Error("Apple Calendar service is not configured");
    }
  }

  private async loadCredentials(): Promise<AppleCalendarCredentials | null> {
    const raw = await this.secretBroker.getAppleCalendarCredentialsJson();
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as AppleCalendarCredentials;
      if (!parsed.email || !parsed.appPassword) return null;
      return parsed;
    } catch {
      logger.warn("Apple Calendar credentials are not valid JSON, ignoring");
      return null;
    }
  }

  private pickPrimaryCalendar(calendars: DAVCalendar[]): DAVCalendar | null {
    if (calendars.length === 0) return null;
    const stored = this.credentials?.defaultCalendarUrl;
    if (stored) {
      const match = calendars.find((c) => c.url === stored);
      if (match) return match;
    }
    // Prefer a calendar whose components include VEVENT (vs. VTODO-only)
    const eventCalendars = calendars.filter(
      (c) => !c.components || c.components.includes("VEVENT"),
    );
    return eventCalendars[0] ?? calendars[0] ?? null;
  }

  /**
   * Resolve a UID to a CalDAV resource handle. Tries the in-memory cache
   * first; on miss, scans the user's primary calendar (no time-range
   * filter) once to populate the cache, then retries.
   */
  private async resolveUid(uid: string): Promise<ResourceHandle | null> {
    const cached = this.uidIndex.get(uid);
    if (cached) return cached;

    const objects = await this.client!.fetchAllCalendarObjects(this.primaryCalendar!);
    for (const obj of objects) {
      if (typeof obj.data !== "string") continue;
      const events = parseEventsFromIcs(obj.data, obj.url, obj.etag ?? null);
      for (const event of events) {
        if (event.recurrenceId !== null) continue;
        if (event.url) {
          this.uidIndex.set(event.uid, {
            url: event.url,
            etag: event.etag,
            calendarUrl: this.primaryCalendar!.url,
          });
        }
      }
    }
    return this.uidIndex.get(uid) ?? null;
  }
}
