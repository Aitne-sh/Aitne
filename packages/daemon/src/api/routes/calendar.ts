import { Hono } from "hono";
import type Database from "better-sqlite3";
import {
  localDateStr,
  calendarCreateEventSchema,
  calendarUpdateEventSchema,
  calendarFreeBusySchema,
} from "@aitne/shared";
import type { ServiceRegistry } from "../../services/service-registry.js";
import type { AgentWriteTracker } from "../../safety/agent-write-tracker.js";
import { markIntegrationWrite } from "../../safety/integration-write-tracker.js";
import { createLogger, toSafeErrorMessage } from "../../logging.js";
import { readJsonBody } from "../json-body.js";
import type { OutlookGraphCalendarClient } from "../../services/calendar/outlook/graph-calendar-client.js";
import { readIntegrations } from "../../db/integrations-store.js";
import { composeIssue, respondWithAgentError } from "../helpers/agent-errors.js";

const logger = createLogger("calendar-api");

/**
 * Calendar write attribution TTL — must comfortably exceed the
 * `PA_CALENDAR_POLL_INTERVAL_SECONDS` (default 300s) so the calendar
 * poller's snapshot comparison sees the agent's write as agent-owned
 * before the mark expires. The default 30 s `AgentWriteTracker` TTL
 * would expire long before the next poll, silently re-attributing
 * every agent create/patch/delete to the user.
 */
const CALENDAR_WRITE_TTL_MS = 15 * 60_000;

export interface CalendarRouteDependencies {
  services: ServiceRegistry;
  agentWriteTracker?: AgentWriteTracker;
  /**
   * SQLite handle for the persistent `integration_writes` table
   * (INTEGRATION-DRIFT-DETECTION-PLAN.md §4.2). Optional — test harnesses
   * that omit the DB exercise the legacy path-keyed `AgentWriteTracker`
   * only. When wired, every successful write also marks
   * `(google_calendar, eventId)` so the next reconcile diff resolves
   * `actor='agent'`.
   */
  db?: Database.Database;
}

const VALID_SEND_UPDATES = new Set(["all", "externalOnly", "none"]);

function parseSendUpdates(raw: string | undefined): string | null {
  const value = raw ?? "none";
  return VALID_SEND_UPDATES.has(value) ? value : null;
}

/**
 * Map a `resolveOutlookCalendarClient` failure tag to its registry code so
 * the response carries an actionable hint instead of just the tag string.
 */
function outlookResolutionCode(error: string): string {
  switch (error) {
    case "outlook_calendar_disabled":
      return "calendar.outlook_disabled";
    case "outlook_calendar_delegated":
      return "calendar.outlook_delegated";
    default:
      return "calendar.outlook_not_configured";
  }
}

/**
 * Google Calendar API error — 404 detection across googleapis variants.
 */
function isGoogleNotFound(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as Record<string, unknown>;
  if (e.code === 404 || e.code === "404") return true;
  if (e.response && typeof e.response === "object" && (e.response as Record<string, unknown>).status === 404) return true;
  if (e.status === 404) return true;
  return false;
}

/**
 * Calendar API routes — proxies to Google Calendar via CalendarService.
 *
 * GET    /calendar/events       — list events (query: date+days OR timeMin+timeMax, q, calendarId)
 * GET    /calendar/events/:id   — get event detail
 * POST   /calendar/events       — create an event
 * PATCH  /calendar/events/:id   — update an event
 * DELETE /calendar/events/:id   — delete an event
 * GET    /calendar/calendars    — list calendars
 * POST   /calendar/freebusy     — free/busy query
 *
 * DELEGATED-MODE-V2-DESIGN.md §6.3 — these routes are direct-mode only.
 * When `google_calendar.mode === "delegated"`, the registry's
 * `apiRoutesTouched` 410-gate (`integration-route-gate.ts`) short-
 * circuits the request before it reaches this file. Cross-backend
 * delegated work flows through `POST /api/integrations/google_calendar/exec`
 * (task-mode chokepoint; the legacy /invoke RPC was retired 2026-05-01).
 */
export function createCalendarRoutes(deps: CalendarRouteDependencies): Hono {
  const app = new Hono();
  const { services, agentWriteTracker, db } = deps;

  // INTEGRATION-DRIFT-DETECTION-PLAN.md §11 Phase 4 — every successful
  // calendar write marks the persistent `integration_writes` table so
  // the next reconcile diff (direct CalendarPoller post-Phase 2) resolves
  // `actor='agent'` instead of re-noticing the agent's own write as a
  // user edit. We pair this with the legacy in-memory `AgentWriteTracker`
  // mark — they target different consumers and the cost is one indexed
  // SQL upsert. TTL is governed by the shared
  // `INTEGRATION_WRITE_TTL_MS["google_calendar"]` (15 min — §17.11) so
  // there is one source of truth for the persistent table; the local
  // `CALENDAR_WRITE_TTL_MS` covers the in-memory tracker only (different
  // consumer, different rationale documented inline above).
  const markCalendarIntegrationWrite = (eventId: string): void => {
    if (!db) return;
    markIntegrationWrite(db, "google_calendar", eventId);
  };

  // ── Literal paths first (before parameterized routes) ──

  // GET /calendar/calendars — list available calendars
  app.get("/calendar/calendars", async (c) => {
    if (!services.calendar?.available) {
      return respondWithAgentError(c, 503, [
        composeIssue("calendar.not_configured", {
          field: "services.calendar",
          received: "<unavailable>",
        }),
      ]);
    }

    try {
      const calendars = await services.calendar!.listCalendars();
      return c.json({ calendars });
    } catch (err) {
      logger.error({ err }, "Calendar list calendars failed");
      return respondWithAgentError(c, 502, [
        composeIssue("calendar.upstream_error", {
          field: "services.calendar",
          received: toSafeErrorMessage(err),
        }),
      ], { legacyFields: { message: toSafeErrorMessage(err) } });
    }
  });

  // POST /calendar/freebusy — free/busy query
  app.post("/calendar/freebusy", async (c) => {
    if (!services.calendar?.available) {
      return respondWithAgentError(c, 503, [
        composeIssue("calendar.not_configured", {
          field: "services.calendar",
          received: "<unavailable>",
        }),
      ]);
    }

    const parsedBody = await readJsonBody(c);
    if (!parsedBody.ok) return parsedBody.response;
    const parsed = calendarFreeBusySchema.safeParse(parsedBody.body);
    if (!parsed.success) {
      return respondWithAgentError(c, 400, [
        composeIssue("calendar.validation_error", {
          field: "body",
          received: parsed.error.issues,
        }),
      ], { legacyFields: { details: parsed.error.issues } });
    }

    try {
      const result = await services.calendar!.queryFreeBusy(
        parsed.data.timeMin, parsed.data.timeMax, parsed.data.calendarIds,
      );
      return c.json(result);
    } catch (err) {
      logger.error({ err }, "Calendar freebusy failed");
      return respondWithAgentError(c, 502, [
        composeIssue("calendar.upstream_error", {
          field: "services.calendar",
          received: toSafeErrorMessage(err),
        }),
      ], { legacyFields: { message: toSafeErrorMessage(err) } });
    }
  });

  // ── Collection routes ──

  // GET /calendar/events — list events for a date range. Two shapes:
  //   1. `date=YYYY-MM-DD&days=N` — UTC calendar-date anchor + day count.
  //      The historical shape; preserved for callers that already build it.
  //   2. `timeMin=<iso>&timeMax=<iso>` — explicit ISO range. Added 2026-05-17
  //      for `routine.fetch_window`'s `cal_iso_week_to_now` row so the direct
  //      pre-pass returns the same Monday-00:00-local → now window the
  //      delegated/native MCP fan-out sees. Without this, the direct-mode
  //      retrospective was a UTC `date+days=7` window that silently dropped
  //      events between today UTC midnight and `now` (e.g. all Friday-evening
  //      events when the JST user fires weekly_review at 19:00 JST).
  //   `timeMin`/`timeMax` takes precedence; the date+days fallback fires
  //   only when both ISO params are absent. Mixed forms (one ISO param +
  //   `date=…`) reject with 400 — a likely caller bug.
  app.get("/calendar/events", async (c) => {
    const q = c.req.query("q") ?? undefined;
    const calendarId = c.req.query("calendarId") ?? undefined;
    const timeMinParam = c.req.query("timeMin");
    const timeMaxParam = c.req.query("timeMax");
    const hasIsoOpen = timeMinParam !== undefined || timeMaxParam !== undefined;
    let timeMin: string;
    let timeMax: string;
    if (hasIsoOpen) {
      if (timeMinParam === undefined || timeMaxParam === undefined) {
        return respondWithAgentError(c, 400, [
          composeIssue("calendar.iso_range_incomplete", {
            field: timeMinParam === undefined ? "timeMin" : "timeMax",
            received: "<missing>",
          }),
        ]);
      }
      const minMs = Date.parse(timeMinParam);
      const maxMs = Date.parse(timeMaxParam);
      if (Number.isNaN(minMs) || Number.isNaN(maxMs)) {
        return respondWithAgentError(c, 400, [
          composeIssue("calendar.invalid_iso_range", {
            field: Number.isNaN(minMs) ? "timeMin" : "timeMax",
            received: Number.isNaN(minMs) ? timeMinParam : timeMaxParam,
          }),
        ]);
      }
      if (maxMs <= minMs) {
        return respondWithAgentError(c, 400, [
          composeIssue("calendar.iso_range_inverted", {
            field: "timeMax",
            received: { timeMin: timeMinParam, timeMax: timeMaxParam },
          }),
        ]);
      }
      // Cap range at 90 days to keep parity with the date+days route's
      // `days=Math.min(…, 90)` guard — calendar listEvents is a paginated
      // call upstream and an unbounded window can spin for minutes.
      if (maxMs - minMs > 90 * 24 * 60 * 60 * 1000) {
        return respondWithAgentError(c, 400, [
          composeIssue("calendar.iso_range_too_wide", {
            field: "timeMax",
            received: { timeMin: timeMinParam, timeMax: timeMaxParam },
          }),
        ]);
      }
      timeMin = new Date(minMs).toISOString();
      timeMax = new Date(maxMs).toISOString();
    } else {
      let date = c.req.query("date") ?? localDateStr(new Date());
      if (date === "today") {
        date = localDateStr(new Date());
      }
      // Guard non-finite `days` (e.g. `?days=abc` → NaN) — without it the
      // NaN propagates into `new Date(startMs + NaN).toISOString()`, which
      // throws RangeError and surfaces as an opaque 500 instead of a sane
      // bounded window. Clamp finite values to [1, 90]; fall back to 1.
      const daysRaw = Number(c.req.query("days") ?? "1");
      const days = Number.isFinite(daysRaw) ? Math.min(Math.max(daysRaw, 1), 90) : 1;

      // Append Z to ensure UTC parsing regardless of OS timezone
      const startMs = new Date(`${date}T00:00:00Z`).getTime();
      if (Number.isNaN(startMs)) {
        return respondWithAgentError(c, 400, [
          composeIssue("calendar.invalid_date_format", {
            field: "date",
            received: date,
          }),
        ]);
      }
      timeMin = new Date(startMs).toISOString();
      timeMax = new Date(startMs + days * 24 * 60 * 60 * 1000).toISOString();
    }

    if (!services.calendar?.available) {
      return respondWithAgentError(c, 503, [
        composeIssue("calendar.not_configured", {
          field: "services.calendar",
          received: "<unavailable>",
        }),
      ]);
    }

    try {
      const events = await services.calendar!.listEvents(timeMin, timeMax, q, calendarId);
      return c.json({ events });
    } catch (err) {
      logger.error({ err }, "Calendar list failed");
      return respondWithAgentError(c, 502, [
        composeIssue("calendar.upstream_error", {
          field: "services.calendar",
          received: toSafeErrorMessage(err),
        }),
      ], { legacyFields: { message: toSafeErrorMessage(err) } });
    }
  });

  // POST /calendar/events — create a new event
  app.post("/calendar/events", async (c) => {
    const parsedBody = await readJsonBody(c);
    if (!parsedBody.ok) return parsedBody.response;
    if (!services.calendar?.available) {
      return respondWithAgentError(c, 503, [
        composeIssue("calendar.not_configured", {
          field: "services.calendar",
          received: "<unavailable>",
        }),
      ]);
    }

    const parsed = calendarCreateEventSchema.safeParse(parsedBody.body);
    if (!parsed.success) {
      return respondWithAgentError(c, 400, [
        composeIssue("calendar.validation_error", {
          field: "body",
          received: parsed.error.issues,
        }),
      ], { legacyFields: { details: parsed.error.issues } });
    }

    const calendarId = c.req.query("calendarId") ?? undefined;
    const sendUpdates = parseSendUpdates(c.req.query("sendUpdates"));
    if (!sendUpdates) {
      return respondWithAgentError(c, 400, [
        composeIssue("calendar.invalid_send_updates", {
          field: "sendUpdates",
          /* c8 ignore next — parseSendUpdates defaults missing values to "none"; this fallback only fires when the query is present-but-invalid, so the rhs is unreachable. */
          received: c.req.query("sendUpdates") ?? "<missing>",
        }),
      ]);
    }

    try {
      const result = await services.calendar!.createEvent(parsed.data, sendUpdates, calendarId);
      // AgentWriteTracker — mark after create (event ID only known after Google responds).
      // Long TTL matches the calendar-poller cadence; see CALENDAR_WRITE_TTL_MS.
      agentWriteTracker?.markWriting(`calendar:${result.eventId}`, null, {
        ttlMs: CALENDAR_WRITE_TTL_MS,
      });
      markCalendarIntegrationWrite(result.eventId);
      return c.json({ status: "created", eventId: result.eventId });
    } catch (err) {
      logger.error({ err }, "Calendar create failed");
      return respondWithAgentError(c, 502, [
        composeIssue("calendar.upstream_error", {
          field: "services.calendar",
          received: toSafeErrorMessage(err),
        }),
      ], { legacyFields: { message: toSafeErrorMessage(err) } });
    }
  });

  // ── Parameterized routes (last) ──

  // GET /calendar/events/:id — get event detail
  app.get("/calendar/events/:id", async (c) => {
    if (!services.calendar?.available) {
      return respondWithAgentError(c, 503, [
        composeIssue("calendar.not_configured", {
          field: "services.calendar",
          received: "<unavailable>",
        }),
      ]);
    }

    const eventId = c.req.param("id");
    const calendarId = c.req.query("calendarId") ?? undefined;

    try {
      const event = await services.calendar!.getEvent(eventId, calendarId);
      return c.json({ event });
    } catch (err) {
      if (isGoogleNotFound(err)) {
        return respondWithAgentError(c, 404, [
          composeIssue("calendar.not_found", {
            field: "eventId",
            received: eventId,
          }),
        ]);
      }
      logger.error({ err }, "Calendar get failed");
      return respondWithAgentError(c, 502, [
        composeIssue("calendar.upstream_error", {
          field: "services.calendar",
          received: toSafeErrorMessage(err),
        }),
      ], { legacyFields: { message: toSafeErrorMessage(err) } });
    }
  });

  // PATCH /calendar/events/:id — update an event
  app.patch("/calendar/events/:id", async (c) => {
    const parsedBody = await readJsonBody(c);
    if (!parsedBody.ok) return parsedBody.response;
    if (!services.calendar?.available) {
      return respondWithAgentError(c, 503, [
        composeIssue("calendar.not_configured", {
          field: "services.calendar",
          received: "<unavailable>",
        }),
      ]);
    }

    const eventId = c.req.param("id");
    const calendarId = c.req.query("calendarId") ?? undefined;
    const sendUpdates = parseSendUpdates(c.req.query("sendUpdates"));
    if (!sendUpdates) {
      return respondWithAgentError(c, 400, [
        composeIssue("calendar.invalid_send_updates", {
          field: "sendUpdates",
          /* c8 ignore next — parseSendUpdates defaults missing values to "none"; this fallback only fires when the query is present-but-invalid, so the rhs is unreachable. */
          received: c.req.query("sendUpdates") ?? "<missing>",
        }),
      ]);
    }

    const parsed = calendarUpdateEventSchema.safeParse(parsedBody.body);
    if (!parsed.success) {
      return respondWithAgentError(c, 400, [
        composeIssue("calendar.validation_error", {
          field: "body",
          received: parsed.error.issues,
        }),
      ], { legacyFields: { details: parsed.error.issues } });
    }

    // AgentWriteTracker — mark before calling Google (event ID is known).
    agentWriteTracker?.markWriting(`calendar:${eventId}`, null, {
      ttlMs: CALENDAR_WRITE_TTL_MS,
    });

    try {
      const result = await services.calendar!.updateEvent(eventId, parsed.data, sendUpdates, calendarId);
      markCalendarIntegrationWrite(result.eventId);
      return c.json({ status: "updated", eventId: result.eventId });
    } catch (err) {
      if (isGoogleNotFound(err)) {
        return respondWithAgentError(c, 404, [
          composeIssue("calendar.not_found", {
            field: "eventId",
            received: eventId,
          }),
        ]);
      }
      logger.error({ err }, "Calendar update failed");
      return respondWithAgentError(c, 502, [
        composeIssue("calendar.upstream_error", {
          field: "services.calendar",
          received: toSafeErrorMessage(err),
        }),
      ], { legacyFields: { message: toSafeErrorMessage(err) } });
    }
  });

  // DELETE /calendar/events/:id — delete an event
  app.delete("/calendar/events/:id", async (c) => {
    if (!services.calendar?.available) {
      return respondWithAgentError(c, 503, [
        composeIssue("calendar.not_configured", {
          field: "services.calendar",
          received: "<unavailable>",
        }),
      ]);
    }

    const eventId = c.req.param("id");
    const calendarId = c.req.query("calendarId") ?? undefined;
    const sendUpdates = parseSendUpdates(c.req.query("sendUpdates"));
    if (!sendUpdates) {
      return respondWithAgentError(c, 400, [
        composeIssue("calendar.invalid_send_updates", {
          field: "sendUpdates",
          /* c8 ignore next — parseSendUpdates defaults missing values to "none"; this fallback only fires when the query is present-but-invalid, so the rhs is unreachable. */
          received: c.req.query("sendUpdates") ?? "<missing>",
        }),
      ]);
    }

    // AgentWriteTracker — mark before calling Google (event ID is known).
    agentWriteTracker?.markWriting(`calendar:${eventId}`, null, {
      ttlMs: CALENDAR_WRITE_TTL_MS,
    });

    try {
      await services.calendar!.deleteEvent(eventId, sendUpdates, calendarId);
      markCalendarIntegrationWrite(eventId);
      return c.json({ status: "deleted", eventId });
    } catch (err) {
      if (isGoogleNotFound(err)) {
        return respondWithAgentError(c, 404, [
          composeIssue("calendar.not_found", {
            field: "eventId",
            received: eventId,
          }),
        ]);
      }
      logger.error({ err }, "Calendar delete failed");
      return respondWithAgentError(c, 502, [
        composeIssue("calendar.upstream_error", {
          field: "services.calendar",
          received: toSafeErrorMessage(err),
        }),
      ], { legacyFields: { message: toSafeErrorMessage(err) } });
    }
  });

  // ── Outlook Calendar (SETUP-FLOW-REDESIGN-PLAN §5.5 / §6.1) ────────────
  // v1: on-demand reads only. The unified mail poller's MSAL token cache
  // holds the same Outlook token (scope expanded to include
  // Calendars.ReadWrite, see services/mail/outlook/client-config.ts), so
  // the route reuses the first authenticated Outlook account's provider.
  // No `OutlookCalendarPoller` is shipped; `schedule.approaching` events
  // for Outlook calendars do not fire until that observer lands (§13).

  const resolveOutlookCalendarClient = async (): Promise<
    | { ok: true; client: OutlookGraphCalendarClient; accountId: string }
    | { ok: false; status: 503; error: string }
  > => {
    // Honour the integration mode independently of mail auth — a user
    // can keep Outlook Mail authed while toggling Outlook Calendar off
    // or to delegated, and the route must not leak calendar data in
    // either case. The route-gate middleware also 410s
    // `/api/calendar/outlook` when delegated (apiRoutesTouched), so
    // this check is defense-in-depth for code paths that bypass the
    // middleware (e.g. internal callers).
    if (db) {
      const state = readIntegrations(db).outlook_calendar;
      if (state.mode === "disabled") {
        return { ok: false, status: 503, error: "outlook_calendar_disabled" };
      }
      if (state.mode === "delegated") {
        return { ok: false, status: 503, error: "outlook_calendar_delegated" };
      }
    }
    const registry = services.mail;
    if (!registry) {
      return { ok: false, status: 503, error: "outlook_not_configured" };
    }
    // Pick the first active Outlook account; the wizard's Mail step
    // documents single-account ergonomics and the registry already orders
    // by `created_at_utc`.
    const accounts = registry
      .listActiveAccounts()
      .filter((a) => a.kind === "outlook");
    if (accounts.length === 0) {
      return { ok: false, status: 503, error: "outlook_not_configured" };
    }
    const account = accounts[0]!;
    try {
      const provider = await registry.getProvider(account.id);
      // Duck-typed factory check rather than `instanceof OutlookGraphProvider`.
      // The account was already filtered to `kind === "outlook"` above; the
      // structural check on `createCalendarClient` covers the residual
      // "registry handed back the wrong shape" case while keeping the route
      // testable without dragging the full MSAL provider into unit tests.
      const factory = (provider as { createCalendarClient?: () => OutlookGraphCalendarClient })
        .createCalendarClient;
      if (typeof factory !== "function") {
        return { ok: false, status: 503, error: "outlook_not_configured" };
      }
      return { ok: true, client: factory.call(provider), accountId: account.id };
    } catch (err) {
      logger.warn({ err, accountId: account.id }, "Outlook calendar token acquisition failed");
      return { ok: false, status: 503, error: "outlook_not_configured" };
    }
  };

  // GET /calendar/outlook/calendars — list available Outlook calendars
  app.get("/calendar/outlook/calendars", async (c) => {
    const resolution = await resolveOutlookCalendarClient();
    if (!resolution.ok) {
      return respondWithAgentError(c, resolution.status, [
        composeIssue(outlookResolutionCode(resolution.error), {
          field: "outlook_calendar",
          received: resolution.error,
        }),
      ]);
    }
    try {
      const calendars = await resolution.client.listCalendars();
      return c.json({ calendars, accountId: resolution.accountId });
    } catch (err) {
      logger.error({ err }, "Outlook list calendars failed");
      return respondWithAgentError(c, 502, [
        composeIssue("calendar.upstream_error", {
          field: "services.calendar",
          received: toSafeErrorMessage(err),
        }),
      ], { legacyFields: { message: toSafeErrorMessage(err) } });
    }
  });

  // GET /calendar/outlook/events — list Outlook events for a date range.
  // Two shapes match the Google route: `date=YYYY-MM-DD&days=N` (historical)
  // or `timeMin=<iso>&timeMax=<iso>` (added 2026-05-17 so `cal_iso_week_to_now`
  // direct-mode pre-pass speaks the same window across providers).
  app.get("/calendar/outlook/events", async (c) => {
    const resolution = await resolveOutlookCalendarClient();
    if (!resolution.ok) {
      return respondWithAgentError(c, resolution.status, [
        composeIssue(outlookResolutionCode(resolution.error), {
          field: "outlook_calendar",
          received: resolution.error,
        }),
      ]);
    }
    const calendarId = c.req.query("calendarId") ?? undefined;
    const timeMinParam = c.req.query("timeMin");
    const timeMaxParam = c.req.query("timeMax");
    const hasIsoOpen = timeMinParam !== undefined || timeMaxParam !== undefined;
    let startUtc: string;
    let endUtc: string;
    if (hasIsoOpen) {
      if (timeMinParam === undefined || timeMaxParam === undefined) {
        return respondWithAgentError(c, 400, [
          composeIssue("calendar.iso_range_incomplete", {
            field: timeMinParam === undefined ? "timeMin" : "timeMax",
            received: "<missing>",
          }),
        ]);
      }
      const minMs = Date.parse(timeMinParam);
      const maxMs = Date.parse(timeMaxParam);
      if (Number.isNaN(minMs) || Number.isNaN(maxMs)) {
        return respondWithAgentError(c, 400, [
          composeIssue("calendar.invalid_iso_range", {
            field: Number.isNaN(minMs) ? "timeMin" : "timeMax",
            received: Number.isNaN(minMs) ? timeMinParam : timeMaxParam,
          }),
        ]);
      }
      if (maxMs <= minMs) {
        return respondWithAgentError(c, 400, [
          composeIssue("calendar.iso_range_inverted", {
            field: "timeMax",
            received: { timeMin: timeMinParam, timeMax: timeMaxParam },
          }),
        ]);
      }
      if (maxMs - minMs > 90 * 24 * 60 * 60 * 1000) {
        return respondWithAgentError(c, 400, [
          composeIssue("calendar.iso_range_too_wide", {
            field: "timeMax",
            received: { timeMin: timeMinParam, timeMax: timeMaxParam },
          }),
        ]);
      }
      startUtc = new Date(minMs).toISOString();
      endUtc = new Date(maxMs).toISOString();
    } else {
      let date = c.req.query("date") ?? localDateStr(new Date());
      if (date === "today") {
        date = localDateStr(new Date());
      }
      // Guard non-finite `days` (e.g. `?days=abc` → NaN) — without it the
      // NaN propagates into `new Date(startMs + NaN).toISOString()`, which
      // throws RangeError and surfaces as an opaque 500 instead of a sane
      // bounded window. Clamp finite values to [1, 90]; fall back to 1.
      const daysRaw = Number(c.req.query("days") ?? "1");
      const days = Number.isFinite(daysRaw) ? Math.min(Math.max(daysRaw, 1), 90) : 1;
      const startMs = new Date(`${date}T00:00:00Z`).getTime();
      if (Number.isNaN(startMs)) {
        return respondWithAgentError(c, 400, [
          composeIssue("calendar.invalid_date_format", {
            field: "date",
            received: date,
          }),
        ]);
      }
      startUtc = new Date(startMs).toISOString();
      endUtc = new Date(startMs + days * 24 * 60 * 60 * 1000).toISOString();
    }

    try {
      const events = await resolution.client.listEvents(
        { startUtc, endUtc },
        calendarId ? { calendarId } : {},
      );
      return c.json({ events, accountId: resolution.accountId });
    } catch (err) {
      logger.error({ err }, "Outlook list events failed");
      return respondWithAgentError(c, 502, [
        composeIssue("calendar.upstream_error", {
          field: "services.calendar",
          received: toSafeErrorMessage(err),
        }),
      ], { legacyFields: { message: toSafeErrorMessage(err) } });
    }
  });

  return app;
}
