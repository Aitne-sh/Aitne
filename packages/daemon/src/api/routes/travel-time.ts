import { Hono } from "hono";
import type { ServiceRegistry } from "../../services/service-registry.js";
import type { TravelMode } from "../../services/google-maps.js";
import { composeIssue, respondWithAgentError } from "../helpers/agent-errors.js";

interface TravelTimeDeps {
  services: ServiceRegistry;
}

export function createTravelTimeRoutes(deps: TravelTimeDeps): Hono {
  const app = new Hono();

  /**
   * GET /travel-time — estimate travel time between two locations.
   *
   * Query params:
   * - origin: origin address (required)
   * - destination: destination address (required)
   * - mode: driving | transit | walking | bicycling (default: transit)
   * - arrival: ISO 8601 arrival time (optional, used to compute departure time)
   */
  app.get("/travel-time", async (c) => {
    const maps = deps.services.googleMaps;
    if (!maps?.available) {
      return respondWithAgentError(c, 503, [
        composeIssue("travel_time.google_maps_not_configured", {
          field: "service",
          received: "<unavailable>",
        }),
      ]);
    }

    const origin = c.req.query("origin");
    const destination = c.req.query("destination");
    if (!origin || !destination) {
      return respondWithAgentError(c, 400, [
        composeIssue("travel_time.origin_and_destination_required", {
          field: !origin ? "origin" : "destination",
          received: !origin ? (origin ?? "<missing>") : (destination ?? "<missing>"),
        }),
      ]);
    }

    const mode = (c.req.query("mode") ?? "transit") as TravelMode;
    const validModes: TravelMode[] = ["driving", "transit", "walking", "bicycling"];
    if (!validModes.includes(mode)) {
      return respondWithAgentError(
        c,
        400,
        [composeIssue("travel_time.invalid_mode", { field: "mode", received: mode })],
        { legacyFields: { validModes } },
      );
    }

    const arrival = c.req.query("arrival");

    const result = await maps.getTravelTime(origin, destination, mode, arrival ?? undefined);
    if (!result) {
      return respondWithAgentError(c, 404, [
        composeIssue("travel_time.no_route_found", {
          field: "route",
          received: { origin, destination, mode },
        }),
      ]);
    }

    return c.json(result);
  });

  /**
   * GET /travel-time/for-event/:eventId — estimate travel time for a calendar event.
   *
   * Reads the event's location and start time from the calendar, then queries
   * Google Maps for travel time from the configured default origin.
   *
   * Query params:
   * - origin: override origin address (optional, defaults to home/office from config)
   * - mode: driving | transit | walking | bicycling (default: transit)
   */
  app.get("/travel-time/for-event/:eventId", async (c) => {
    const maps = deps.services.googleMaps;
    if (!maps?.available) {
      return respondWithAgentError(c, 503, [
        composeIssue("travel_time.google_maps_not_configured", {
          field: "service",
          received: "<unavailable>",
        }),
      ]);
    }

    const calendar = deps.services.calendar;
    if (!calendar?.available) {
      return respondWithAgentError(c, 503, [
        composeIssue("travel_time.calendar_not_configured", {
          field: "service",
          received: "<unavailable>",
        }),
      ]);
    }

    const eventId = c.req.param("eventId");
    let event;
    try {
      event = await calendar.getEvent(eventId);
    } catch {
      return respondWithAgentError(c, 404, [
        composeIssue("travel_time.event_not_found", { field: "eventId", received: eventId }),
      ]);
    }

    if (!event.location) {
      return respondWithAgentError(c, 400, [
        composeIssue("travel_time.event_has_no_location", {
          field: "event.location",
          received: "<missing>",
        }),
      ]);
    }

    const origin = c.req.query("origin");
    if (!origin) {
      return respondWithAgentError(c, 400, [
        composeIssue("travel_time.origin_required", { field: "origin", received: "<missing>" }),
      ]);
    }

    const mode = (c.req.query("mode") ?? "transit") as TravelMode;
    const arrivalTime = event.start ?? undefined;

    const result = await maps.getTravelTime(
      origin,
      event.location,
      mode,
      arrivalTime,
    );

    if (!result) {
      return respondWithAgentError(c, 404, [
        composeIssue("travel_time.no_route_found", {
          field: "route",
          received: { origin, destination: event.location, mode },
        }),
      ]);
    }

    return c.json({
      event: {
        id: event.id,
        summary: event.summary,
        location: event.location,
        start: event.start,
      },
      travelTime: result,
    });
  });

  return app;
}
