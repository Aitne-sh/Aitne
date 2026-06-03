import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { createTravelBookingRoutes } from "./travel-bookings.js";
import type { ApiDependencies } from "../server.js";
import { applySchema } from "../../db/schema.js";

function createTestDb(): Database.Database {
  const db = new Database(":memory:");
  applySchema(db);
  return db;
}

function seedTestData(db: Database.Database): void {
  const stmt = db.prepare(
    `INSERT INTO travel_bookings (type, provider, destination, start_date, end_date,
       confirmation_number, amount, currency, status, provider_msg_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  stmt.run("flight", "JetBlue", "Boston", "2026-05-15T10:30:00Z", null, "ABC123", 35000, "USD", "upcoming", "msg-1");
  stmt.run("hotel", "Booking.com", "Hotel Grand", "2026-05-15", "2026-05-17", "XYZ789", 24000, "USD", "upcoming", "msg-2");
  stmt.run("restaurant", "OpenTable", "Italian Bistro", "2026-04-20T19:00:00Z", null, null, null, "USD", "upcoming", "msg-3");
  stmt.run("train", "Amtrak", null, "2026-03-10T08:00:00Z", null, "DEF456", 13320, "USD", "completed", "msg-4");
  stmt.run("flight", "Alaska Airlines", "New York", "2026-06-01T11:00:00Z", "2026-06-10T15:00:00Z", "GHI012", 150000, "USD", "upcoming", "msg-5");
}

function makeDeps(db: Database.Database): ApiDependencies {
  return { db } as unknown as ApiDependencies;
}

describe("travel-bookings routes", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    seedTestData(db);
  });

  describe("GET /travel-bookings", () => {
    it("returns all bookings", async () => {
      const app = createTravelBookingRoutes(makeDeps(db));
      const res = await app.request("/travel-bookings");
      const data = (await res.json()) as Record<string, any>;

      expect(res.status).toBe(200);
      expect(data.total).toBe(5);
      expect(data.bookings).toHaveLength(5);
    });

    it("filters by type", async () => {
      const app = createTravelBookingRoutes(makeDeps(db));
      const res = await app.request("/travel-bookings?type=flight");
      const data = (await res.json()) as Record<string, any>;

      expect(data.total).toBe(2);
      expect(data.bookings.every((b: { type: string }) => b.type === "flight")).toBe(true);
    });

    it("filters by status", async () => {
      const app = createTravelBookingRoutes(makeDeps(db));
      const res = await app.request("/travel-bookings?status=completed");
      const data = (await res.json()) as Record<string, any>;

      expect(data.total).toBe(1);
      expect(data.bookings[0].provider).toBe("Amtrak");
    });

    it("filters by date range", async () => {
      const app = createTravelBookingRoutes(makeDeps(db));
      const res = await app.request("/travel-bookings?from=2026-05-01&to=2026-06-01");
      const data = (await res.json()) as Record<string, any>;

      expect(data.total).toBe(2); // JetBlue + Booking.com in May
    });

    it("rejects invalid type", async () => {
      const app = createTravelBookingRoutes(makeDeps(db));
      const res = await app.request("/travel-bookings?type=invalid");

      expect(res.status).toBe(400);
    });

    it("rejects invalid status", async () => {
      const app = createTravelBookingRoutes(makeDeps(db));
      const res = await app.request("/travel-bookings?status=invalid");

      expect(res.status).toBe(400);
    });

    it("respects limit", async () => {
      const app = createTravelBookingRoutes(makeDeps(db));
      const res = await app.request("/travel-bookings?limit=2");
      const data = (await res.json()) as Record<string, any>;

      expect(data.total).toBe(5);
      expect(data.bookings).toHaveLength(2);
    });
  });

  describe("GET /travel-bookings/upcoming", () => {
    it("returns only upcoming bookings with future start_date", async () => {
      const app = createTravelBookingRoutes(makeDeps(db));
      const res = await app.request("/travel-bookings/upcoming");
      const data = (await res.json()) as Record<string, any>;

      expect(res.status).toBe(200);
      // Excludes the completed Amtrak booking (2026-03-10)
      // Includes upcoming ones with future dates or null dates
      expect(data.bookings.every((b: { status: string }) => b.status === "upcoming")).toBe(true);
    });

    it("maps every row field for upcoming bookings (null start_date always qualifies)", async () => {
      // A null-start_date upcoming row matches `start_date IS NULL`
      // regardless of the wall clock, so the row-mapping body is always
      // exercised — avoiding a date-dependent flake.
      db.prepare(
        `INSERT INTO travel_bookings (type, provider, destination, start_date, end_date,
           confirmation_number, amount, currency, status, provider_msg_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        "hotel",
        "Hilton",
        "Kyoto",
        null,
        null,
        "NULLDATE1",
        50000,
        "JPY",
        "upcoming",
        "msg-nulldate",
      );

      const app = createTravelBookingRoutes(makeDeps(db));
      const res = await app.request("/travel-bookings/upcoming");
      const data = (await res.json()) as {
        bookings: Array<Record<string, unknown>>;
        total: number;
      };

      expect(res.status).toBe(200);
      const mapped = data.bookings.find(
        (b) => b.confirmationNumber === "NULLDATE1",
      );
      expect(mapped).toMatchObject({
        type: "hotel",
        provider: "Hilton",
        destination: "Kyoto",
        startDate: null,
        endDate: null,
        confirmationNumber: "NULLDATE1",
        amount: 50000,
        currency: "JPY",
        status: "upcoming",
        providerMsgId: "msg-nulldate",
      });
      expect(typeof mapped?.id).toBe("number");
      expect(data.total).toBeGreaterThanOrEqual(1);
    });
  });

  describe("PATCH /travel-bookings/:id", () => {
    it("updates booking status", async () => {
      const app = createTravelBookingRoutes(makeDeps(db));
      const res = await app.request("/travel-bookings/1", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "completed" }),
      });
      const data = (await res.json()) as Record<string, any>;

      expect(res.status).toBe(200);
      expect(data.ok).toBe(true);

      const row = db.prepare("SELECT status FROM travel_bookings WHERE id = 1").get() as { status: string };
      expect(row.status).toBe("completed");
    });

    it("updates destination", async () => {
      const app = createTravelBookingRoutes(makeDeps(db));
      const res = await app.request("/travel-bookings/4", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ destination: "Nagoya" }),
      });

      expect(res.status).toBe(200);
      const row = db.prepare("SELECT destination FROM travel_bookings WHERE id = 4").get() as { destination: string };
      expect(row.destination).toBe("Nagoya");
    });

    it("rejects invalid status", async () => {
      const app = createTravelBookingRoutes(makeDeps(db));
      const res = await app.request("/travel-bookings/1", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "invalid" }),
      });

      expect(res.status).toBe(400);
    });

    it("returns 404 for non-existent booking", async () => {
      const app = createTravelBookingRoutes(makeDeps(db));
      const res = await app.request("/travel-bookings/999", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "completed" }),
      });

      expect(res.status).toBe(404);
    });

    it("returns 400 for empty update", async () => {
      const app = createTravelBookingRoutes(makeDeps(db));
      const res = await app.request("/travel-bookings/1", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(400);
    });

    it("returns 400 with invalid_json when body is malformed", async () => {
      const app = createTravelBookingRoutes(makeDeps(db));
      const res = await app.request("/travel-bookings/1", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: "{ not valid json",
      });

      expect(res.status).toBe(400);
      const data = await res.json() as { error: string };
      expect(data.error).toBe("invalid_json");
    });

    it("returns 400 with invalid_id when id is not a number", async () => {
      const app = createTravelBookingRoutes(makeDeps(db));
      const res = await app.request("/travel-bookings/abc", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "completed" }),
      });

      expect(res.status).toBe(400);
      const data = await res.json() as { error: string };
      expect(data.error).toBe("invalid_id");
    });
  });
});
