import ICAL from "ical.js";
import { APP_NAME } from "@aitne/shared";
import type {
  AppleCalendarEvent,
  CreateEventParams,
  UpdateEventParams,
} from "./types.js";

// PRODID is embedded in every iCalendar event we send to iCloud and is shown
// to other CalDAV clients that import the data. Tracks APP_NAME so a rebrand
// surfaces in third-party calendar UIs as well.
const PRODID = `-//${APP_NAME}//iCloud CalDAV//EN`;
const ID_RECURRENCE_SEP = "__";

/**
 * Anchored regex that recognizes a `__<RECURRENCE-ID>` suffix where the
 * RECURRENCE-ID is unambiguously an ISO 8601 date (`YYYY-MM-DD`) or
 * instant (`YYYY-MM-DDTHH:MM:SSZ` or `...mmmZ`). Without the date
 * shape, an externally-authored UID that happens to contain a literal
 * `__` (e.g. `weekly__home@example`) would have been mis-split into a
 * fake `(uid, recurrenceId)` and rejected from PATCH/DELETE with a
 * spurious 501. The shape requirement is tight enough that the only
 * surviving ambiguity is "UID literally ends with __<ISO timestamp>",
 * which does not occur in practice for Apple/Google/Outlook UIDs.
 */
const RECURRENCE_ID_SUFFIX_RE = /__(\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z)?)$/;

/**
 * Compose a stable agent-facing event ID. For non-recurring events this
 * is the bare UID; for an expanded recurring instance, the UID is suffixed
 * with the RECURRENCE-ID so the agent can address a specific occurrence
 * without colliding with siblings.
 */
export function composeEventId(uid: string, recurrenceId: string | null): string {
  if (!recurrenceId) return uid;
  return `${uid}${ID_RECURRENCE_SEP}${recurrenceId}`;
}

/**
 * Inverse of {@link composeEventId}. Splits an agent-facing id back
 * into UID + RECURRENCE-ID. Returns `recurrenceId: null` for the master
 * event of a series, for non-recurring events, and for any id whose
 * trailing `__...` segment is NOT a recognizable ISO 8601 date — that
 * case is treated as part of the UID rather than misinterpreted as a
 * recurrence anchor.
 */
export function parseEventId(id: string): { uid: string; recurrenceId: string | null } {
  const match = id.match(RECURRENCE_ID_SUFFIX_RE);
  if (!match || match.index === undefined) {
    return { uid: id, recurrenceId: null };
  }
  return {
    uid: id.slice(0, match.index),
    // Group 1 is a required capture in RECURRENCE_ID_SUFFIX_RE — the
    // `?? null` fallback is a TypeScript-shaped defensive guard that
    // RegExpMatchArray indices are typed as `string | undefined`.
    /* c8 ignore next */
    recurrenceId: match[1] ?? null,
  };
}

/**
 * Render an {@link ICAL.Time} as the JSON shape the route emits — either
 * `YYYY-MM-DD` for all-day values or an ISO 8601 instant in UTC for
 * date-time values. Floating times (no `tzid`, not UTC) are treated as
 * server-local: `toJSDate()` interprets them in the local zone, which is
 * the documented assumption for Apple Calendar input/output.
 */
export function timeToJsonString(time: ICAL.Time): string {
  if (time.isDate) {
    const y = String(time.year).padStart(4, "0");
    const m = String(time.month).padStart(2, "0");
    const d = String(time.day).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  return time.toJSDate().toISOString();
}

/**
 * Parse an ISO 8601 instant or `YYYY-MM-DD` date into the iCalendar
 * property value pair `{ value, isDate }`. The returned `value` is in
 * iCalendar wire format (`YYYYMMDDTHHMMSSZ` for instants, `YYYYMMDD`
 * for dates).
 *
 * **Strict offset requirement.** ISO 8601 strings WITHOUT a timezone
 * offset (`2026-04-26T14:00:00`) are rejected — `Date.parse` interprets
 * them as server-local time and the resulting "UTC" wire value would
 * be silently wrong by the local UTC offset. The contract documented
 * in `external-services` SKILL.md requires `Z` or `±HH:MM`; this
 * function enforces it so the bug fails loud at the codec boundary
 * rather than silently in the user's calendar.
 *
 * Throws `Error` with a stable `message` on parse failure so the route
 * layer can map it to a 400 validation error.
 */
const ISO_DATE_TIME_WITH_OFFSET_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/;

export function parseInputDate(input: string): { value: string; isDate: boolean } {
  const trimmed = input.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return { value: trimmed.replace(/-/g, ""), isDate: true };
  }
  if (!ISO_DATE_TIME_WITH_OFFSET_RE.test(trimmed)) {
    throw new Error(
      `Invalid date — expected ISO 8601 with TZ offset (Z or ±HH:MM) or YYYY-MM-DD, got "${input}"`,
    );
  }
  const parsed = Date.parse(trimmed);
  /* c8 ignore start — unreachable: regex above narrows to valid ISO 8601
     instants, which Date.parse accepts. The NaN guard is defensive only. */
  if (Number.isNaN(parsed)) {
    throw new Error(
      `Invalid date — expected ISO 8601 with TZ offset (Z or ±HH:MM) or YYYY-MM-DD, got "${input}"`,
    );
  }
  /* c8 ignore stop */
  const d = new Date(parsed);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  const ss = String(d.getUTCSeconds()).padStart(2, "0");
  return { value: `${y}${m}${day}T${hh}${mm}${ss}Z`, isDate: false };
}

/**
 * Convert ical.js `vstatus` enum values (uppercase iCal) to the
 * lowercase shape Google's API uses (`confirmed` / `cancelled` /
 * `tentative`). Returns null if no STATUS property was present.
 */
function statusToLowercase(raw: string | null | undefined): string | null {
  if (!raw) return null;
  return String(raw).toLowerCase();
}

/**
 * Best-effort end-time fallback when a VEVENT lacks DTEND. Per RFC 5545
 * §3.6.1, an event with VALUE=DATE DTSTART and no DTEND defaults to one
 * day; an event with VALUE=DATE-TIME and no DTEND defaults to the same
 * instant as DTSTART (zero-duration). We follow that for read; agent
 * output keeps the same convention.
 */
function deriveEndTime(start: ICAL.Time, end: ICAL.Time | null): ICAL.Time {
  if (end) return end;
  if (start.isDate) {
    const next = start.clone();
    next.day += 1;
    return next;
  }
  return start.clone();
}

/**
 * Parse a VCALENDAR text blob and project each VEVENT into the agent
 * JSON shape. The input is whatever tsdav's `CalendarObject.data` field
 * carries; CalDAV returns one VCALENDAR per resource, but
 * `calendar-query` with `<C:expand>` returns one expanded VEVENT per
 * occurrence inside that VCALENDAR.
 *
 * `sourceUrl` and `etag` come from the same {@link import('tsdav').CalendarObject}
 * and are propagated onto every parsed event so the route can pre-warm
 * the UID→{url,etag} cache used by update/delete.
 */
export function parseEventsFromIcs(
  ics: string,
  sourceUrl: string | null,
  etag: string | null,
): AppleCalendarEvent[] {
  const jcal = ICAL.parse(ics);
  const vcal = new ICAL.Component(jcal);
  const vevents = vcal.getAllSubcomponents("vevent");

  const out: AppleCalendarEvent[] = [];
  for (const vevent of vevents) {
    const uid = vevent.getFirstPropertyValue("uid");
    if (typeof uid !== "string" || uid.length === 0) continue;

    const dtstartProp = vevent.getFirstProperty("dtstart");
    if (!dtstartProp) continue;
    const startTime = dtstartProp.getFirstValue() as ICAL.Time;

    const dtendProp = vevent.getFirstProperty("dtend");
    const endRaw = dtendProp ? (dtendProp.getFirstValue() as ICAL.Time) : null;
    const endTime = deriveEndTime(startTime, endRaw);

    const recurrenceProp = vevent.getFirstProperty("recurrence-id");
    const recurrenceId = recurrenceProp
      ? timeToJsonString(recurrenceProp.getFirstValue() as ICAL.Time)
      : null;

    const hasRrule = vevent.hasProperty("rrule");
    const recurring = hasRrule || recurrenceId !== null;

    const summary = vevent.getFirstPropertyValue("summary");
    const description = vevent.getFirstPropertyValue("description");
    const location = vevent.getFirstPropertyValue("location");
    const status = vevent.getFirstPropertyValue("status");

    out.push({
      id: composeEventId(uid, recurrenceId),
      uid,
      recurrenceId,
      summary: typeof summary === "string" ? summary : null,
      description: typeof description === "string" ? description : null,
      location: typeof location === "string" ? location : null,
      start: timeToJsonString(startTime),
      end: timeToJsonString(endTime),
      allDay: startTime.isDate,
      status: statusToLowercase(typeof status === "string" ? status : null),
      url: sourceUrl,
      etag,
      recurring,
    });
  }
  return out;
}

/**
 * Build a fresh VCALENDAR/VEVENT iCalendar string for {@link createEvent}.
 *
 * The `now` parameter is injected so tests can pin DTSTAMP — production
 * callers default to `new Date()`.
 */
export function buildEventIcs(
  uid: string,
  params: CreateEventParams,
  now: Date = new Date(),
): string {
  const calendar = new ICAL.Component(["vcalendar", [], []]);
  calendar.updatePropertyWithValue("version", "2.0");
  calendar.updatePropertyWithValue("prodid", PRODID);

  const vevent = new ICAL.Component("vevent");
  calendar.addSubcomponent(vevent);

  vevent.updatePropertyWithValue("uid", uid);
  vevent.updatePropertyWithValue("dtstamp", isoToIcalTime(now.toISOString(), false));
  applyParamsToVEvent(vevent, params, /* isUpdate */ false);

  return calendar.toString();
}

/**
 * Apply update params to an existing VCALENDAR's primary VEVENT.
 * Returns the updated iCalendar text. Override (RECURRENCE-ID) VEVENTs
 * are NOT mutated — for MVP the route layer rejects updates to
 * recurring instances. The function picks the first VEVENT lacking a
 * RECURRENCE-ID; if none, throws.
 */
export function applyUpdateToIcs(originalIcs: string, params: UpdateEventParams): string {
  const jcal = ICAL.parse(originalIcs);
  const vcal = new ICAL.Component(jcal);
  const vevents = vcal.getAllSubcomponents("vevent");

  const master = vevents.find((v) => !v.hasProperty("recurrence-id"));
  if (!master) {
    throw new Error("No master VEVENT found in resource");
  }
  applyParamsToVEvent(master, params, /* isUpdate */ true);
  master.updatePropertyWithValue("dtstamp", isoToIcalTime(new Date().toISOString(), false));

  return vcal.toString();
}

/**
 * Shared property writer for create + update. Skipping a key in `params`
 * leaves the existing value alone; passing an empty string clears it
 * (we delete the property so iCalendar consumers see the absence rather
 * than an empty string).
 */
function applyParamsToVEvent(
  vevent: ICAL.Component,
  params: CreateEventParams | UpdateEventParams,
  isUpdate: boolean,
): void {
  const startInfo =
    params.start !== undefined ? parseInputDate(params.start) : null;
  const endInfo = params.end !== undefined ? parseInputDate(params.end) : null;

  if (!isUpdate) {
    if (startInfo === null) throw new Error("start is required");
    if (endInfo === null) throw new Error("end is required");
  }

  // VALUE type guard: iCalendar requires DTSTART and DTEND to share value
  // type (both VALUE=DATE or both VALUE=DATE-TIME). On a partial update
  // that toggles all-day-ness on only one side, the resource would become
  // malformed and iCloud responds with 400 — but at that point the agent
  // has already issued a write whose failure is opaque. Detect the
  // mismatch up-front so the caller gets a precise 400 from us.
  if (isUpdate) {
    if (startInfo !== null && endInfo === null) {
      const existingEnd = readPropertyDateFlag(vevent, "dtend");
      if (existingEnd !== null && existingEnd !== startInfo.isDate) {
        throw new Error(
          "Updating start without end while toggling all-day is not allowed — provide both start and end together",
        );
      }
    }
    if (endInfo !== null && startInfo === null) {
      const existingStart = readPropertyDateFlag(vevent, "dtstart");
      if (existingStart !== null && existingStart !== endInfo.isDate) {
        throw new Error(
          "Updating end without start while toggling all-day is not allowed — provide both start and end together",
        );
      }
    }
  }

  if (startInfo !== null) {
    setDateProperty(vevent, "dtstart", startInfo.value, startInfo.isDate);
  }
  if (endInfo !== null) {
    setDateProperty(vevent, "dtend", endInfo.value, endInfo.isDate);
  }
  if (params.summary !== undefined) {
    if (params.summary.length === 0) {
      vevent.removeAllProperties("summary");
    } else {
      vevent.updatePropertyWithValue("summary", params.summary);
    }
  } else if (!isUpdate) {
    throw new Error("summary is required");
  }
  if (params.description !== undefined) {
    if (params.description.length === 0) {
      vevent.removeAllProperties("description");
    } else {
      vevent.updatePropertyWithValue("description", params.description);
    }
  }
  if (params.location !== undefined) {
    if (params.location.length === 0) {
      vevent.removeAllProperties("location");
    } else {
      vevent.updatePropertyWithValue("location", params.location);
    }
  }
}

function setDateProperty(
  vevent: ICAL.Component,
  name: "dtstart" | "dtend",
  value: string,
  isDate: boolean,
): void {
  vevent.removeAllProperties(name);
  const time = isoToIcalTime(value, isDate);
  vevent.addPropertyWithValue(name, time);
}

/**
 * Read the existing `VALUE=DATE` flag of a date property on a VEVENT.
 * Returns `true` for an all-day value, `false` for a date-time value,
 * and `null` when the property is absent. Used by the VALUE-type
 * mismatch guard in `applyParamsToVEvent`.
 */
function readPropertyDateFlag(
  vevent: ICAL.Component,
  name: "dtstart" | "dtend",
): boolean | null {
  const prop = vevent.getFirstProperty(name);
  if (!prop) return null;
  const value = prop.getFirstValue() as ICAL.Time;
  return value.isDate;
}

/**
 * Build an `ICAL.Time` from either an iCalendar wire-format string
 * (`YYYYMMDD` or `YYYYMMDDTHHMMSSZ`) or a plain ISO 8601 instant. The
 * second form is convenient for DTSTAMP construction inside this file.
 */
function isoToIcalTime(value: string, isDate: boolean): ICAL.Time {
  if (isDate) {
    const time = ICAL.Time.fromDateString(
      `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`,
    );
    return time;
  }
  if (/^\d{8}T\d{6}Z$/.test(value)) {
    const iso =
      `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T` +
      `${value.slice(9, 11)}:${value.slice(11, 13)}:${value.slice(13, 15)}Z`;
    return ICAL.Time.fromDateTimeString(iso);
  }
  return ICAL.Time.fromDateTimeString(value);
}

/**
 * UID generator wrapping `crypto.randomUUID`. Suffixed so events
 * created by this app are distinguishable in the user's calendar
 * inspector — purely cosmetic.
 */
export function generateUid(): string {
  return `${globalThis.crypto.randomUUID()}@personal-agent`;
}
