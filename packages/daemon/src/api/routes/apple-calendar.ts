import { Hono } from "hono";
import { z } from "zod";
import { localDateStr } from "@aitne/shared";
import type { ServiceRegistry } from "../../services/service-registry.js";
import {
  AppleCalendarService,
  EventNotFoundError,
  RecurringInstanceUnsupportedError,
} from "../../services/apple-calendar/index.js";
import type { SecretBroker } from "../../secrets/secret-broker.js";
import type { AgentWriteTracker } from "../../safety/agent-write-tracker.js";
import { createLogger, toSafeErrorMessage } from "../../logging.js";
import { readJsonBody } from "../json-body.js";
import { composeIssue, respondWithAgentError } from "../helpers/agent-errors.js";

const logger = createLogger("apple-calendar-api");

/** Mirrors the Google Calendar attribution TTL — long enough that the
 *  next observation pass sees the agent's write as agent-owned. Apple
 *  Calendar has no poller in the MVP, so this is forward-compat. */
const APPLE_CALENDAR_WRITE_TTL_MS = 15 * 60_000;

const credentialsSchema = z
  .object({
    email: z.string().email(),
    appPassword: z.string().min(8),
  })
  .strict();

const setDefaultCalendarSchema = z
  .object({
    calendarUrl: z.string().url(),
  })
  .strict();

/**
 * Apple-specific event schemas. We deliberately do NOT reuse the Google
 * `calendarCreateEventSchema` / `calendarUpdateEventSchema` here: those
 * accept `attendees`, `reminders`, `recurrence`, and `visibility`, which
 * iCloud either ignores silently or fails on, and routing them through
 * a tolerant schema gave the agent the false impression that an
 * invitation had been sent. With `.strict()`, an attempt to author
 * those fields surfaces a 400 `validation_error` so the agent can stop
 * and tell the user instead of pretending success.
 */
const appleCreateEventSchema = z
  .object({
    summary: z.string().min(1).max(1000),
    start: z.string().min(1),
    end: z.string().min(1),
    description: z.string().max(10_000).optional(),
    location: z.string().max(1000).optional(),
  })
  .strict();

const appleUpdateEventSchema = z
  .object({
    summary: z.string().min(1).max(1000).optional(),
    start: z.string().min(1).optional(),
    end: z.string().min(1).optional(),
    description: z.string().max(10_000).optional(),
    location: z.string().max(1000).optional(),
  })
  .strict()
  .refine((data) => Object.values(data).some((v) => v !== undefined), {
    message: "At least one field must be provided for update",
  });

export interface AppleCalendarRouteDependencies {
  services: ServiceRegistry;
  secretBroker: SecretBroker;
  agentWriteTracker?: AgentWriteTracker;
}

/**
 * Apple Calendar (iCloud CalDAV) routes — provider sibling of `/api/calendar/*`.
 *
 * GET    /apple-calendar/status              — connection probe (200 always)
 * GET    /apple-calendar/events              — list events (date, days)
 * GET    /apple-calendar/events/:id          — get event detail
 * POST   /apple-calendar/events              — create
 * PATCH  /apple-calendar/events/:id          — update (master events only)
 * DELETE /apple-calendar/events/:id          — delete (master events only)
 * GET    /apple-calendar/calendars           — list calendars
 * POST   /apple-calendar/freebusy            — derived busy intervals
 * POST   /apple-calendar/credentials         — save Apple ID + app password
 * DELETE /apple-calendar/credentials         — disconnect
 * POST   /apple-calendar/default-calendar    — pick which calendar is primary
 *
 * The skill body routes the agent here when `policies/management.md` Source
 * of Truth declares Apple Calendar as the schedule provider. The agent
 * MUST NOT cross-call `/api/calendar/*`; that would query Google and
 * silently return wrong data, which is worse than an error.
 */
export function createAppleCalendarRoutes(
  deps: AppleCalendarRouteDependencies,
): Hono {
  const app = new Hono();
  const { services, secretBroker, agentWriteTracker } = deps;

  // ── Status (always 200) ──

  app.get("/apple-calendar/status", (c) => {
    return c.json({
      configured: !!services.appleCalendar,
      available: !!services.appleCalendar?.available,
    });
  });

  // ── Credentials management ──

  app.post("/apple-calendar/credentials", async (c) => {
    const parsedBody = await readJsonBody(c);
    if (!parsedBody.ok) return parsedBody.response;
    const parsed = credentialsSchema.safeParse(parsedBody.body);
    if (!parsed.success) {
      return respondWithAgentError(
        c,
        400,
        [composeIssue("apple_calendar.validation_error", { field: "body", received: parsedBody.body })],
        { legacyFields: { details: parsed.error.issues } },
      );
    }

    try {
      // Validate + persist + populate the registry slot in one shot via
      // the service's `connect()`. We deliberately skip the secret-change
      // hot-reload notification here: the reload helper would null the
      // slot and rebuild the service from keychain, redoing the iCloud
      // round-trip we just completed and momentarily exposing a
      // `services.appleCalendar === null` window to concurrent requests.
      // The hot-reload path is reserved for boot + dashboard secret
      // editor; direct connect bypasses it cleanly.
      const target = services.appleCalendar ?? new AppleCalendarService(secretBroker);
      await target.connect(parsed.data.email, parsed.data.appPassword);
      services.appleCalendar = target;
      delete services.errors.appleCalendar;

      const calendars = target.listCalendars();
      return c.json({
        status: "connected",
        email: parsed.data.email,
        calendars,
      });
    } catch (err) {
      logger.error({ err }, "Apple Calendar connect failed");
      const message = toSafeErrorMessage(err);
      return respondWithAgentError(
        c,
        401,
        [composeIssue("apple_calendar.auth_failed", { field: "credentials", received: message })],
        { legacyFields: { message } },
      );
    }
  });

  app.delete("/apple-calendar/credentials", async (c) => {
    if (services.appleCalendar) {
      await services.appleCalendar.disconnect();
      services.appleCalendar = null;
    } else {
      // No live service — clear keychain ourselves so the wipe is
      // idempotent even when the daemon never finished init().
      await secretBroker.deleteAppleCalendarCredentials();
    }
    delete services.errors.appleCalendar;
    return c.json({ status: "disconnected" });
  });

  app.post("/apple-calendar/default-calendar", async (c) => {
    const parsedBody = await readJsonBody(c);
    if (!parsedBody.ok) return parsedBody.response;
    const parsed = setDefaultCalendarSchema.safeParse(parsedBody.body);
    if (!parsed.success) {
      return respondWithAgentError(
        c,
        400,
        [composeIssue("apple_calendar.validation_error", { field: "body", received: parsedBody.body })],
        { legacyFields: { details: parsed.error.issues } },
      );
    }
    if (!services.appleCalendar?.available) {
      return respondWithAgentError(c, 503, [
        composeIssue("apple_calendar.not_configured", {
          field: "services.appleCalendar",
          received: "<unavailable>",
        }),
      ]);
    }
    try {
      await services.appleCalendar.setDefaultCalendar(parsed.data.calendarUrl);
      return c.json({ status: "ok", calendars: services.appleCalendar.listCalendars() });
    } catch (err) {
      const message = toSafeErrorMessage(err);
      return respondWithAgentError(
        c,
        400,
        [
          composeIssue("apple_calendar.validation_error", {
            field: "calendarUrl",
            received: parsed.data.calendarUrl,
            expected: message,
          }),
        ],
        { legacyFields: { message } },
      );
    }
  });

  // ── Read-only routes ──

  app.get("/apple-calendar/calendars", (c) => {
    if (!services.appleCalendar?.available) {
      return respondWithAgentError(c, 503, [
        composeIssue("apple_calendar.not_configured", {
          field: "services.appleCalendar",
          received: "<unavailable>",
        }),
      ]);
    }
    return c.json({ calendars: services.appleCalendar.listCalendars() });
  });

  app.post("/apple-calendar/freebusy", async (c) => {
    if (!services.appleCalendar?.available) {
      return respondWithAgentError(c, 503, [
        composeIssue("apple_calendar.not_configured", {
          field: "services.appleCalendar",
          received: "<unavailable>",
        }),
      ]);
    }
    const parsedBody = await readJsonBody(c);
    if (!parsedBody.ok) return parsedBody.response;
    const parsed = z
      .object({ timeMin: z.string().min(1), timeMax: z.string().min(1) })
      .safeParse(parsedBody.body);
    if (!parsed.success) {
      return respondWithAgentError(
        c,
        400,
        [composeIssue("apple_calendar.validation_error", { field: "body", received: parsedBody.body })],
        { legacyFields: { details: parsed.error.issues } },
      );
    }
    try {
      const result = await services.appleCalendar.queryFreeBusy(
        parsed.data.timeMin,
        parsed.data.timeMax,
      );
      return c.json(result);
    } catch (err) {
      logger.error({ err }, "Apple Calendar freebusy failed");
      const message = toSafeErrorMessage(err);
      return respondWithAgentError(
        c,
        502,
        [composeIssue("apple_calendar.upstream_error", { field: "iCloud", received: message })],
        { legacyFields: { message } },
      );
    }
  });

  // ── Events ──

  app.get("/apple-calendar/events", async (c) => {
    if (!services.appleCalendar?.available) {
      return respondWithAgentError(c, 503, [
        composeIssue("apple_calendar.not_configured", {
          field: "services.appleCalendar",
          received: "<unavailable>",
        }),
      ]);
    }
    let date = c.req.query("date") ?? localDateStr(new Date());
    if (date === "today") date = localDateStr(new Date());
    // Guard non-finite `days` (e.g. `?days=abc` → NaN) so it can't propagate
    // into `new Date(startMs + NaN).toISOString()` (RangeError → opaque 500).
    const daysRaw = Number(c.req.query("days") ?? "1");
    const days = Number.isFinite(daysRaw) ? Math.min(Math.max(daysRaw, 1), 90) : 1;

    const startMs = new Date(`${date}T00:00:00Z`).getTime();
    if (Number.isNaN(startMs)) {
      return respondWithAgentError(
        c,
        400,
        [composeIssue("apple_calendar.invalid_date", { field: "date", received: date })],
        {
          legacyErrorCode: "invalid date format — expected YYYY-MM-DD or 'today'",
        },
      );
    }
    const timeMin = new Date(startMs).toISOString();
    const timeMax = new Date(startMs + days * 24 * 60 * 60 * 1000).toISOString();

    try {
      const events = await services.appleCalendar.listEvents(timeMin, timeMax);
      return c.json({ events });
    } catch (err) {
      logger.error({ err }, "Apple Calendar list failed");
      const message = toSafeErrorMessage(err);
      return respondWithAgentError(
        c,
        502,
        [composeIssue("apple_calendar.upstream_error", { field: "iCloud", received: message })],
        { legacyFields: { message } },
      );
    }
  });

  app.post("/apple-calendar/events", async (c) => {
    const parsedBody = await readJsonBody(c);
    if (!parsedBody.ok) return parsedBody.response;
    if (!services.appleCalendar?.available) {
      return respondWithAgentError(c, 503, [
        composeIssue("apple_calendar.not_configured", {
          field: "services.appleCalendar",
          received: "<unavailable>",
        }),
      ]);
    }
    const parsed = appleCreateEventSchema.safeParse(parsedBody.body);
    if (!parsed.success) {
      return respondWithAgentError(
        c,
        400,
        [composeIssue("apple_calendar.validation_error", { field: "body", received: parsedBody.body })],
        { legacyFields: { details: parsed.error.issues } },
      );
    }
    try {
      const result = await services.appleCalendar.createEvent({
        summary: parsed.data.summary,
        start: parsed.data.start,
        end: parsed.data.end,
        description: parsed.data.description,
        location: parsed.data.location,
      });
      agentWriteTracker?.markWriting(`apple-calendar:${result.eventId}`, null, {
        ttlMs: APPLE_CALENDAR_WRITE_TTL_MS,
      });
      return c.json({ status: "created", eventId: result.eventId });
    } catch (err) {
      logger.error({ err }, "Apple Calendar create failed");
      const message = toSafeErrorMessage(err);
      return respondWithAgentError(
        c,
        502,
        [composeIssue("apple_calendar.upstream_error", { field: "iCloud", received: message })],
        { legacyFields: { message } },
      );
    }
  });

  app.get("/apple-calendar/events/:id", async (c) => {
    if (!services.appleCalendar?.available) {
      return respondWithAgentError(c, 503, [
        composeIssue("apple_calendar.not_configured", {
          field: "services.appleCalendar",
          received: "<unavailable>",
        }),
      ]);
    }
    const eventId = c.req.param("id");
    try {
      const event = await services.appleCalendar.getEvent(eventId);
      return c.json({ event });
    } catch (err) {
      if (err instanceof EventNotFoundError) {
        return respondWithAgentError(c, 404, [
          composeIssue("apple_calendar.not_found", {
            field: "id",
            received: c.req.param("id"),
          }),
        ]);
      }
      logger.error({ err }, "Apple Calendar get failed");
      const message = toSafeErrorMessage(err);
      return respondWithAgentError(
        c,
        502,
        [composeIssue("apple_calendar.upstream_error", { field: "iCloud", received: message })],
        { legacyFields: { message } },
      );
    }
  });

  app.patch("/apple-calendar/events/:id", async (c) => {
    const parsedBody = await readJsonBody(c);
    if (!parsedBody.ok) return parsedBody.response;
    if (!services.appleCalendar?.available) {
      return respondWithAgentError(c, 503, [
        composeIssue("apple_calendar.not_configured", {
          field: "services.appleCalendar",
          received: "<unavailable>",
        }),
      ]);
    }
    const parsed = appleUpdateEventSchema.safeParse(parsedBody.body);
    if (!parsed.success) {
      return respondWithAgentError(
        c,
        400,
        [composeIssue("apple_calendar.validation_error", { field: "body", received: parsedBody.body })],
        { legacyFields: { details: parsed.error.issues } },
      );
    }
    const eventId = c.req.param("id");
    agentWriteTracker?.markWriting(`apple-calendar:${eventId}`, null, {
      ttlMs: APPLE_CALENDAR_WRITE_TTL_MS,
    });
    try {
      const result = await services.appleCalendar.updateEvent(eventId, {
        summary: parsed.data.summary,
        start: parsed.data.start,
        end: parsed.data.end,
        description: parsed.data.description,
        location: parsed.data.location,
      });
      return c.json({ status: "updated", eventId: result.eventId });
    } catch (err) {
      if (err instanceof EventNotFoundError) {
        return respondWithAgentError(c, 404, [
          composeIssue("apple_calendar.not_found", {
            field: "id",
            received: c.req.param("id"),
          }),
        ]);
      }
      if (err instanceof RecurringInstanceUnsupportedError) {
        return respondWithAgentError(
          c,
          501,
          [
            composeIssue("apple_calendar.recurring_instance_unsupported", {
              field: "id",
              received: c.req.param("id"),
            }),
          ],
          { legacyFields: { message: err.message } },
        );
      }
      logger.error({ err }, "Apple Calendar update failed");
      const message = toSafeErrorMessage(err);
      return respondWithAgentError(
        c,
        502,
        [composeIssue("apple_calendar.upstream_error", { field: "iCloud", received: message })],
        { legacyFields: { message } },
      );
    }
  });

  app.delete("/apple-calendar/events/:id", async (c) => {
    if (!services.appleCalendar?.available) {
      return respondWithAgentError(c, 503, [
        composeIssue("apple_calendar.not_configured", {
          field: "services.appleCalendar",
          received: "<unavailable>",
        }),
      ]);
    }
    const eventId = c.req.param("id");
    agentWriteTracker?.markWriting(`apple-calendar:${eventId}`, null, {
      ttlMs: APPLE_CALENDAR_WRITE_TTL_MS,
    });
    try {
      await services.appleCalendar.deleteEvent(eventId);
      return c.json({ status: "deleted", eventId });
    } catch (err) {
      if (err instanceof EventNotFoundError) {
        return respondWithAgentError(c, 404, [
          composeIssue("apple_calendar.not_found", {
            field: "id",
            received: c.req.param("id"),
          }),
        ]);
      }
      if (err instanceof RecurringInstanceUnsupportedError) {
        return respondWithAgentError(
          c,
          501,
          [
            composeIssue("apple_calendar.recurring_instance_unsupported", {
              field: "id",
              received: c.req.param("id"),
            }),
          ],
          { legacyFields: { message: err.message } },
        );
      }
      logger.error({ err }, "Apple Calendar delete failed");
      const message = toSafeErrorMessage(err);
      return respondWithAgentError(
        c,
        502,
        [composeIssue("apple_calendar.upstream_error", { field: "iCloud", received: message })],
        { legacyFields: { message } },
      );
    }
  });

  return app;
}
