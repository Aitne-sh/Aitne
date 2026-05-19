import type { DAVCalendar, DAVCalendarObject } from "tsdav";
import type { AppleCalendarCredentials } from "./types.js";

const ICLOUD_SERVER_URL = "https://caldav.icloud.com";

/**
 * Lazy-loaded tsdav helpers — `createDAVClient` and friends. Imported
 * via dynamic `import()` so the daemon doesn't fault on the dep at boot
 * if the user never configures Apple Calendar.
 */
type TsdavApi = typeof import("tsdav");

let cachedTsdav: Promise<TsdavApi> | null = null;
function loadTsdav(): Promise<TsdavApi> {
  cachedTsdav ??= import("tsdav");
  return cachedTsdav;
}

export interface CalDavClient {
  fetchCalendars(): Promise<DAVCalendar[]>;
  fetchCalendarObjectsExpanded(params: {
    calendar: DAVCalendar;
    timeMinIso: string;
    timeMaxIso: string;
  }): Promise<DAVCalendarObject[]>;
  fetchAllCalendarObjects(calendar: DAVCalendar): Promise<DAVCalendarObject[]>;
  /**
   * Fetch a single CalDAV resource by URL. Used by getEvent / updateEvent
   * after the UID→URL cache resolves the target — avoids the O(N) cost
   * of iterating the entire calendar collection just to find one event.
   * Returns `null` if the resource is missing (deleted between cache
   * population and lookup).
   */
  fetchCalendarObjectByUrl(params: {
    calendar: DAVCalendar;
    url: string;
  }): Promise<DAVCalendarObject | null>;
  createCalendarObject(params: {
    calendar: DAVCalendar;
    filename: string;
    iCalString: string;
  }): Promise<{ url: string; etag: string | null }>;
  updateCalendarObject(params: {
    url: string;
    etag: string | null;
    iCalString: string;
  }): Promise<{ etag: string | null }>;
  deleteCalendarObject(params: {
    url: string;
    etag: string | null;
  }): Promise<void>;
}

/**
 * Construct a tsdav-backed CalDAV client bound to iCloud, performing
 * principal + home-set discovery during construction. Throws on auth
 * failure so callers can surface 401 via the credentials-test endpoint.
 */
export async function createICloudCalDavClient(
  credentials: AppleCalendarCredentials,
): Promise<CalDavClient> {
  const tsdav = await loadTsdav();
  const client = await tsdav.createDAVClient({
    serverUrl: ICLOUD_SERVER_URL,
    credentials: {
      username: credentials.email,
      password: credentials.appPassword,
    },
    authMethod: "Basic",
    defaultAccountType: "caldav",
  });

  return {
    async fetchCalendars(): Promise<DAVCalendar[]> {
      return client.fetchCalendars();
    },

    async fetchCalendarObjectsExpanded({
      calendar,
      timeMinIso,
      timeMaxIso,
    }): Promise<DAVCalendarObject[]> {
      // iCloud is required to honor <C:expand> in calendar-query — when it
      // fails we surface 502 to the route layer rather than silently
      // returning the master VEVENT (which the codec would emit with the
      // series anchor's start/end and the agent would relay to the user
      // as the next instance's time). Wrong data is worse than no data.
      return client.fetchCalendarObjects({
        calendar,
        timeRange: { start: timeMinIso, end: timeMaxIso },
        expand: true,
      });
    },

    async fetchAllCalendarObjects(calendar): Promise<DAVCalendarObject[]> {
      return client.fetchCalendarObjects({ calendar });
    },

    async fetchCalendarObjectByUrl({ calendar, url }): Promise<DAVCalendarObject | null> {
      const objects = await client.fetchCalendarObjects({
        calendar,
        objectUrls: [url],
      });
      return objects[0] ?? null;
    },

    async createCalendarObject({ calendar, filename, iCalString }): Promise<{
      url: string;
      etag: string | null;
    }> {
      const res = await client.createCalendarObject({
        calendar,
        filename,
        iCalString,
      });
      // iCloud returns 201 with Location + ETag headers.
      const location = res.headers.get("location");
      const url = location
        ? new URL(location, calendar.url).toString()
        : new URL(filename, calendar.url).toString();
      return { url, etag: res.headers.get("etag") };
    },

    async updateCalendarObject({ url, etag, iCalString }): Promise<{ etag: string | null }> {
      const calendarObject: DAVCalendarObject = {
        url,
        data: iCalString,
        etag: etag ?? undefined,
      };
      const res = await client.updateCalendarObject({ calendarObject });
      if (!res.ok) {
        throw new Error(
          `iCloud rejected calendar update — HTTP ${res.status} ${res.statusText}`,
        );
      }
      return { etag: res.headers.get("etag") };
    },

    async deleteCalendarObject({ url, etag }): Promise<void> {
      const calendarObject: DAVCalendarObject = {
        url,
        etag: etag ?? undefined,
      };
      const res = await client.deleteCalendarObject({ calendarObject });
      if (!res.ok && res.status !== 404) {
        throw new Error(
          `iCloud rejected calendar delete — HTTP ${res.status} ${res.statusText}`,
        );
      }
    },
  };
}
