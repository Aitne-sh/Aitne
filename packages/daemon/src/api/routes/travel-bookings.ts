import { Hono } from "hono";
import type { ApiDependencies } from "../server.js";
import { composeIssue, respondWithAgentError } from "../helpers/agent-errors.js";

interface TravelBookingRow {
  id: number;
  type: string;
  provider: string;
  destination: string | null;
  start_date: string | null;
  end_date: string | null;
  confirmation_number: string | null;
  amount: number | null;
  currency: string;
  status: string;
  provider_msg_id: string | null;
  created_at: string;
}

export function createTravelBookingRoutes(deps: ApiDependencies): Hono {
  const app = new Hono();
  const { db } = deps;

  /**
   * GET /travel-bookings — list travel bookings with optional filters.
   *
   * Query params:
   * - type: flight | hotel | restaurant | train | bus | other
   * - status: upcoming | completed | cancelled | all (default: all)
   * - from: ISO date, only bookings with start_date on or after
   * - to: ISO date, only bookings with start_date before
   * - limit: max results (1–200, default 50)
   */
  app.get("/travel-bookings", (c) => {
    const type = c.req.query("type");
    const status = c.req.query("status") ?? "all";
    const from = c.req.query("from");
    const to = c.req.query("to");
    const limit = Math.min(
      Math.max(parseInt(c.req.query("limit") ?? "50", 10), 1),
      200,
    );

    const validStatuses = ["upcoming", "completed", "cancelled", "all"];
    if (!validStatuses.includes(status)) {
      return respondWithAgentError(
        c,
        400,
        [composeIssue("travel_bookings.invalid_status", { field: "status", received: status })],
        { legacyFields: { validStatuses } },
      );
    }

    const validTypes = ["flight", "hotel", "restaurant", "train", "bus", "other"];
    if (type && !validTypes.includes(type)) {
      return respondWithAgentError(
        c,
        400,
        [composeIssue("travel_bookings.invalid_type", { field: "type", received: type })],
        { legacyFields: { validTypes } },
      );
    }

    const conditions: string[] = [];
    const params: unknown[] = [];

    if (type) {
      conditions.push("type = ?");
      params.push(type);
    }
    if (status !== "all") {
      conditions.push("status = ?");
      params.push(status);
    }
    if (from) {
      conditions.push("start_date >= ?");
      params.push(from);
    }
    if (to) {
      conditions.push("start_date < ?");
      params.push(to);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const countRow = db.prepare(
      `SELECT COUNT(*) as count FROM travel_bookings ${where}`,
    ).get(...params) as { count: number };

    const rows = db.prepare(
      `SELECT id, type, provider, destination, start_date, end_date,
              confirmation_number, amount, currency, status,
              provider_msg_id, created_at
       FROM travel_bookings ${where}
       ORDER BY COALESCE(start_date, created_at) DESC
       LIMIT ?`,
    ).all(...params, limit) as TravelBookingRow[];

    const bookings = rows.map((row) => ({
      id: row.id,
      type: row.type,
      provider: row.provider,
      destination: row.destination,
      startDate: row.start_date,
      endDate: row.end_date,
      confirmationNumber: row.confirmation_number,
      amount: row.amount,
      currency: row.currency,
      status: row.status,
      providerMsgId: row.provider_msg_id,
      createdAt: row.created_at,
    }));

    return c.json({ bookings, total: countRow.count });
  });

  /**
   * GET /travel-bookings/upcoming — convenience endpoint for upcoming bookings.
   * Returns bookings with start_date >= today, ordered by start_date ASC.
   */
  app.get("/travel-bookings/upcoming", (c) => {
    const limit = Math.min(
      Math.max(parseInt(c.req.query("limit") ?? "20", 10), 1),
      100,
    );

    const where = `WHERE status = 'upcoming' AND (start_date >= date('now') OR start_date IS NULL)`;

    const countRow = db.prepare(
      `SELECT COUNT(*) as count FROM travel_bookings ${where}`,
    ).get() as { count: number };

    const rows = db.prepare(
      `SELECT id, type, provider, destination, start_date, end_date,
              confirmation_number, amount, currency, status,
              provider_msg_id, created_at
       FROM travel_bookings
       ${where}
       ORDER BY COALESCE(start_date, created_at) ASC
       LIMIT ?`,
    ).all(limit) as TravelBookingRow[];

    const bookings = rows.map((row) => ({
      id: row.id,
      type: row.type,
      provider: row.provider,
      destination: row.destination,
      startDate: row.start_date,
      endDate: row.end_date,
      confirmationNumber: row.confirmation_number,
      amount: row.amount,
      currency: row.currency,
      status: row.status,
      providerMsgId: row.provider_msg_id,
      createdAt: row.created_at,
    }));

    return c.json({ bookings, total: countRow.count });
  });

  /**
   * PATCH /travel-bookings/:id — update booking status or details.
   */
  app.patch("/travel-bookings/:id", async (c) => {
    const rawId = c.req.param("id");
    const id = parseInt(rawId, 10);
    if (isNaN(id) || id <= 0) {
      return respondWithAgentError(c, 400, [
        composeIssue("travel_bookings.invalid_id", { field: "id", received: rawId }),
      ]);
    }

    let body: { status?: string; destination?: string };
    try {
      body = await c.req.json<{ status?: string; destination?: string }>();
    } catch {
      return respondWithAgentError(c, 400, [
        composeIssue("travel_bookings.invalid_json", {
          field: "body",
          received: "<unparseable>",
        }),
      ]);
    }

    const validStatuses = ["upcoming", "completed", "cancelled"];
    if (body.status && !validStatuses.includes(body.status)) {
      return respondWithAgentError(
        c,
        400,
        [composeIssue("travel_bookings.invalid_status", { field: "status", received: body.status })],
        { legacyFields: { valid: validStatuses } },
      );
    }

    const updates: string[] = [];
    const params: unknown[] = [];

    if (body.status) {
      updates.push("status = ?");
      params.push(body.status);
    }
    if (body.destination !== undefined) {
      updates.push("destination = ?");
      params.push(body.destination);
    }

    if (updates.length === 0) {
      return respondWithAgentError(c, 400, [
        composeIssue("travel_bookings.no_updates", {
          field: "body",
          received: body,
        }),
      ]);
    }

    params.push(id);
    const result = db.prepare(
      `UPDATE travel_bookings SET ${updates.join(", ")} WHERE id = ?`,
    ).run(...params);

    if (result.changes === 0) {
      return respondWithAgentError(c, 404, [
        composeIssue("travel_bookings.not_found", { field: "id", received: id }),
      ]);
    }

    return c.json({ ok: true, id });
  });

  return app;
}
