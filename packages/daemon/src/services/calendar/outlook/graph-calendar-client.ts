import {
  GraphClient,
  type GraphClientOptions,
  type GraphTokenProvider,
} from "../../mail/outlook/graph-client.js";

/**
 * Microsoft Graph calendar wrapper (SETUP-FLOW-REDESIGN-PLAN §6.1 / §10).
 *
 * Mirrors `services/mail/outlook/graph-client.ts` in spirit — pure wrapper
 * with an injected `GraphTokenProvider`, no MSAL coupling at this layer.
 * The token provider that backs production calls is the same one
 * `OutlookGraphProvider` builds when consuming the per-account MSAL cache;
 * tests inject a stub.
 *
 * v1 ships on-demand reads + writes only; the design plan defers
 * `OutlookCalendarPoller` to a follow-up. Until that observer lands,
 * `schedule.approaching` events are not emitted for Outlook calendars.
 */

export interface OutlookCalendarRef {
  id: string;
  name: string;
  isDefaultCalendar: boolean;
  /** Owner email when present; falls back to display name. */
  owner: string | null;
  /** Calendar tz declared by Graph (e.g. `"Tokyo Standard Time"`). */
  timeZone: string | null;
}

export interface OutlookCalendarEvent {
  id: string;
  subject: string;
  /** Start in ISO-8601 (UTC). Combined from Graph's `dateTime`+`timeZone`. */
  startUtc: string;
  /** End in ISO-8601 (UTC). */
  endUtc: string;
  isAllDay: boolean;
  organizer: string | null;
  webLink: string | null;
  /** Free-form preview from Graph's `bodyPreview`. */
  bodyPreview: string;
}

export interface ListEventsRange {
  /** Inclusive lower bound. */
  startUtc: string;
  /** Exclusive upper bound. */
  endUtc: string;
}

export interface ListEventsOptions {
  /** Optional calendar id; omit for the default calendar (`/me/calendar`). */
  calendarId?: string;
  /** Per-page cap (Graph default = 10; we default 50). Pages are stitched together via `@odata.nextLink`. */
  top?: number;
  /**
   * Hard ceiling on the total number of events returned across all pages.
   * Stops following `@odata.nextLink` once reached. Defaults to 1000 — high
   * enough that v1's wizard / Connections page never trips it on a sane
   * calendar, low enough that a runaway recurrence does not pull pages
   * indefinitely.
   */
  maxItems?: number;
}

/**
 * Two construction shapes:
 *   1. `{ graphClient }` — reuse a pre-built {@link GraphClient}. Production
 *      code in `OutlookGraphProvider.createCalendarClient` uses this so the
 *      mail and calendar surfaces share one concurrency limiter + abortSignal,
 *      respecting Graph's 4-concurrent / (app, tenant) cap (§3.8).
 *   2. `{ tokenProvider, ...graphOpts }` — construct a fresh `GraphClient`.
 *      Used by tests via the {@link OutlookGraphCalendarClient.fromTokenProvider}
 *      factory.
 *
 * Exactly one of `graphClient` / `tokenProvider` must be supplied; the
 * constructor throws otherwise. Supplying both prefers `graphClient` (the
 * `tokenProvider` is unused — easy to read but easy to misread, so mark it
 * accordingly in call sites).
 */
export type OutlookGraphCalendarClientOptions =
  | { graphClient: GraphClient }
  | (GraphClientOptions & { graphClient?: undefined });

/**
 * Bare-minimum surface required by the wizard's Calendar step + the
 * `/api/calendar/outlook/*` routes. Add capabilities here in lockstep with
 * the route extension; the registry-driven probe consumes none of them
 * until `outlook_calendar.backendConnectors` is widened beyond `{}`.
 */
export class OutlookGraphCalendarClient {
  private readonly client: GraphClient;

  constructor(options: OutlookGraphCalendarClientOptions) {
    if ("graphClient" in options && options.graphClient) {
      this.client = options.graphClient;
    } else if ("tokenProvider" in options && options.tokenProvider) {
      this.client = new GraphClient(options);
    } else {
      throw new Error(
        "OutlookGraphCalendarClient requires either { graphClient } or { tokenProvider }",
      );
    }
  }

  static fromTokenProvider(
    tokenProvider: GraphTokenProvider,
    extra: Omit<GraphClientOptions, "tokenProvider"> = {},
  ): OutlookGraphCalendarClient {
    return new OutlookGraphCalendarClient({ tokenProvider, ...extra });
  }

  /**
   * Production constructor for {@link OutlookGraphProvider} — reuses the
   * provider's pre-built `GraphClient` so mail + calendar share one
   * concurrency limiter + abortSignal. Prefer this over `fromTokenProvider`
   * when an `OutlookGraphProvider` is in scope.
   */
  static fromGraphClient(graphClient: GraphClient): OutlookGraphCalendarClient {
    return new OutlookGraphCalendarClient({ graphClient });
  }

  /**
   * List the user's calendars. The default calendar is flagged via
   * `isDefaultCalendar` so the UI can pre-select it without a second call.
   * Does not paginate — Graph caps `/me/calendars` at 50, which exceeds any
   * sensible single-user setup.
   */
  async listCalendars(): Promise<OutlookCalendarRef[]> {
    const response = await this.client.requestJson<{ value: unknown[] }>({
      method: "GET",
      // `canEdit` is intentionally NOT in the projection — we expose `timeZone`
      // (which the parser actually returns) but not `canEdit` (no consumer
      // today). Adding fields here that the type doesn't surface is dead
      // bandwidth; missing fields the type promises are silent nulls.
      url: "/me/calendars?$select=id,name,isDefaultCalendar,owner,timeZone",
    });
    const list = Array.isArray(response.value) ? response.value : [];
    return list.map(parseCalendarRef);
  }

  /**
   * List events overlapping `[startUtc, endUtc)`. Uses the Graph
   * `calendarView` endpoint, which expands recurrences in-server (vs. `events`
   * which returns raw recurrence masters).
   *
   * Pagination follows `@odata.nextLink` until either no further pages exist
   * or `options.maxItems` (default 1000) is reached. Without this loop a
   * caller asking for a 90-day window with >50 events per page would silently
   * truncate at the first page — Microsoft Graph's `calendarView` does not
   * promise to return everything inline.
   */
  async listEvents(
    range: ListEventsRange,
    options: ListEventsOptions = {},
  ): Promise<OutlookCalendarEvent[]> {
    const top = options.top ?? 50;
    const maxItems = options.maxItems ?? 1000;
    const path = options.calendarId
      ? `/me/calendars/${encodeURIComponent(options.calendarId)}/calendarView`
      : `/me/calendarView`;
    const initialUrl =
      `${path}?startDateTime=${encodeURIComponent(range.startUtc)}` +
      `&endDateTime=${encodeURIComponent(range.endUtc)}` +
      `&$top=${top}` +
      `&$select=id,subject,start,end,isAllDay,organizer,webLink,bodyPreview` +
      `&$orderby=start/dateTime`;

    const collected: OutlookCalendarEvent[] = [];
    let nextUrl: string | null = initialUrl;
    while (nextUrl !== null && collected.length < maxItems) {
      const response: { value?: unknown[]; "@odata.nextLink"?: unknown } =
        await this.client.requestJson({
          method: "GET",
          url: nextUrl,
          // Graph requires this header to express times in UTC for calendarView;
          // without it event times come back in the user's primary timezone and
          // the conversion below would silently double-correct. The header must
          // ride EVERY page request — Graph does not infer it from prior calls.
          headers: { Prefer: 'outlook.timezone="UTC"' },
        });
      const list = Array.isArray(response.value) ? response.value : [];
      for (const raw of list) {
        if (collected.length >= maxItems) break;
        collected.push(parseCalendarEvent(raw));
      }
      const link = response["@odata.nextLink"];
      // `resolveGraphUrl` accepts absolute URLs unchanged, so passing the
      // server-returned link directly preserves cursor params Graph encodes
      // into it (skiptoken, etc.) without us having to parse them.
      nextUrl = typeof link === "string" && link.length > 0 ? link : null;
    }
    return collected;
  }
}

function parseCalendarRef(raw: unknown): OutlookCalendarRef {
  const r = (raw ?? {}) as Record<string, unknown>;
  const owner = r.owner as Record<string, unknown> | undefined;
  const ownerAddress =
    typeof owner?.address === "string" ? (owner.address as string) : null;
  const ownerName =
    typeof owner?.name === "string" ? (owner.name as string) : null;
  return {
    id: String(r.id ?? ""),
    name: String(r.name ?? ""),
    isDefaultCalendar: r.isDefaultCalendar === true,
    owner: ownerAddress ?? ownerName ?? null,
    timeZone: typeof r.timeZone === "string" ? (r.timeZone as string) : null,
  };
}

function parseCalendarEvent(raw: unknown): OutlookCalendarEvent {
  const r = (raw ?? {}) as Record<string, unknown>;
  const start = (r.start ?? {}) as Record<string, unknown>;
  const end = (r.end ?? {}) as Record<string, unknown>;
  const organizer = (r.organizer ?? {}) as Record<string, unknown>;
  const emailAddress = (organizer.emailAddress ?? {}) as Record<string, unknown>;
  return {
    id: String(r.id ?? ""),
    subject: typeof r.subject === "string" ? (r.subject as string) : "",
    // The `Prefer: outlook.timezone="UTC"` header guarantees Graph emits the
    // dateTime in UTC; appending Z is the canonical ISO-8601 fixup.
    startUtc: toIsoUtc(start),
    endUtc: toIsoUtc(end),
    isAllDay: r.isAllDay === true,
    organizer:
      typeof emailAddress.address === "string"
        ? (emailAddress.address as string)
        : typeof emailAddress.name === "string"
          ? (emailAddress.name as string)
          : null,
    webLink: typeof r.webLink === "string" ? (r.webLink as string) : null,
    bodyPreview:
      typeof r.bodyPreview === "string" ? (r.bodyPreview as string) : "",
  };
}

function toIsoUtc(dateContainer: Record<string, unknown>): string {
  const raw = dateContainer.dateTime;
  if (typeof raw !== "string" || raw.length === 0) return "";
  // Graph's calendarView dateTime is missing the trailing `Z` even though we
  // requested UTC. `new Date(raw + "Z").toISOString()` is the path with the
  // fewest sharp edges (handles fractional seconds, leading zeros, etc.).
  const parsed = new Date(raw.endsWith("Z") ? raw : `${raw}Z`);
  return Number.isNaN(parsed.getTime()) ? raw : parsed.toISOString();
}
