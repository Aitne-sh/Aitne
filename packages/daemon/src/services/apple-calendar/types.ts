/**
 * Apple Calendar (iCloud CalDAV) — service types.
 *
 * The JSON shape mirrors the Google Calendar route output as closely as
 * possible so the agent's downstream prose is provider-agnostic. Notable
 * differences:
 *
 * - `id` is the iCalendar UID, not a Google event id. For an expanded
 *   instance of a recurring series, `id` is the composite
 *   `${UID}__${RECURRENCEID}` so the agent can address a specific
 *   occurrence; the master event uses bare UID.
 * - `etag` and `url` are CalDAV-specific resource handles. Update/delete
 *   path uses them via REPORT lookup by UID; the agent does not need to
 *   hold them.
 */

export interface AppleCalendarCredentials {
  /** Apple ID email address. */
  email: string;
  /** App-specific password (xxxx-xxxx-xxxx-xxxx). */
  appPassword: string;
  /** Cached after discovery — the CalDAV principal URL. */
  principalUrl?: string;
  /** Cached after discovery — the calendar-home-set URL. */
  homeSetUrl?: string;
  /**
   * The user's chosen primary calendar URL. If omitted, the service
   * picks the first writable calendar returned by the home-set query.
   */
  defaultCalendarUrl?: string;
}

export interface AppleCalendarEvent {
  id: string;
  uid: string;
  recurrenceId: string | null;
  summary: string | null;
  start: string | null;
  end: string | null;
  description: string | null;
  location: string | null;
  allDay: boolean;
  status: string | null;
  /** CalDAV resource URL — opaque handle for update/delete. */
  url: string | null;
  etag: string | null;
  /** True if this event is part of a recurring series. */
  recurring: boolean;
}

export interface CreateEventParams {
  summary: string;
  /** ISO 8601 with offset (e.g. `2026-04-26T14:00:00+09:00`) or `YYYY-MM-DD` for all-day. */
  start: string;
  end: string;
  description?: string;
  location?: string;
}

export interface UpdateEventParams {
  summary?: string;
  start?: string;
  end?: string;
  description?: string;
  location?: string;
}

export interface AppleCalendarListEntry {
  /** CalDAV calendar URL (opaque to the agent). */
  id: string;
  summary: string;
  description: string | null;
  primary: boolean;
}

export interface FreeBusyResult {
  calendars: Record<string, { busy: Array<{ start: string; end: string }> }>;
}
