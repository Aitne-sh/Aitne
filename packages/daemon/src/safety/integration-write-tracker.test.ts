import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { INTEGRATION_WRITE_TTL_MS } from "@aitne/shared";
import { applySchema } from "../db/schema.js";
import { reconcile } from "../services/integrations/reconcile.js";
import { getSnapshotNormalizer } from "@aitne/shared";
import { markIntegrationWrite } from "./integration-write-tracker.js";

/**
 * INTEGRATION-DRIFT-DETECTION-PLAN.md §11 Phase 4 — route-handler facade
 * over the persistent `integration_writes` table.
 *
 * The primitive (`services/integrations/reconcile.ts:markIntegrationWrite`)
 * is exercised in `reconcile.test.ts`; here we cover the wrapper's
 * ergonomics: per-integration TTL defaults, current-time defaults, error
 * swallowing, and the end-to-end actor-resolution race that motivates the
 * helper in the first place.
 */
describe("safety/integration-write-tracker — markIntegrationWrite", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(":memory:");
    applySchema(db);
  });
  afterEach(() => db.close());

  function readRow(itemId: string) {
    return db
      .prepare(
        `SELECT integration, item_id, written_at, written_by, expires_at
         FROM integration_writes WHERE item_id = ?`,
      )
      .get(itemId) as
      | {
        integration: string;
        item_id: string;
        written_at: string;
        written_by: string;
        expires_at: string;
      }
      | undefined;
  }

  for (const [integration, expectedTtl] of Object.entries(INTEGRATION_WRITE_TTL_MS) as [
    keyof typeof INTEGRATION_WRITE_TTL_MS,
    number,
  ][]) {
    it(`uses INTEGRATION_WRITE_TTL_MS default for ${integration}`, () => {
      const nowIso = "2026-04-28T12:00:00.000Z";
      markIntegrationWrite(db, integration, "item-1", { nowIso });
      const row = readRow("item-1");
      expect(row).toBeDefined();
      expect(row!.integration).toBe(integration);
      expect(row!.written_by).toBe("agent");
      expect(row!.written_at).toBe(nowIso);
      expect(Date.parse(row!.expires_at) - Date.parse(nowIso)).toBe(expectedTtl);
    });
  }

  it("honours an explicit ttlMs override", () => {
    const nowIso = "2026-04-28T12:00:00.000Z";
    markIntegrationWrite(db, "google_calendar", "evt-2", {
      ttlMs: 7 * 60 * 1000,
      nowIso,
    });
    const row = readRow("evt-2");
    expect(row).toBeDefined();
    expect(Date.parse(row!.expires_at) - Date.parse(nowIso)).toBe(7 * 60 * 1000);
  });

  it("defaults nowIso to the current wall clock when omitted", () => {
    const before = Date.now();
    markIntegrationWrite(db, "google_calendar", "evt-now", {});
    const after = Date.now();
    const row = readRow("evt-now");
    expect(row).toBeDefined();
    const writtenMs = Date.parse(row!.written_at);
    expect(writtenMs).toBeGreaterThanOrEqual(before);
    expect(writtenMs).toBeLessThanOrEqual(after);
  });

  it("UPSERTs on duplicate (integration, item_id) — last call wins", () => {
    markIntegrationWrite(db, "google_calendar", "evt-3", {
      ttlMs: 60_000,
      nowIso: "2026-04-28T12:00:00.000Z",
    });
    markIntegrationWrite(db, "google_calendar", "evt-3", {
      ttlMs: 30_000,
      nowIso: "2026-04-28T13:00:00.000Z",
    });
    const rows = db
      .prepare("SELECT written_at, expires_at FROM integration_writes WHERE item_id = ?")
      .all("evt-3") as { written_at: string; expires_at: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].written_at).toBe("2026-04-28T13:00:00.000Z");
    expect(rows[0].expires_at).toBe("2026-04-28T13:00:30.000Z");
  });

  it("skips empty itemId without writing a row", () => {
    markIntegrationWrite(db, "google_calendar", "");
    const count = db
      .prepare("SELECT COUNT(*) AS n FROM integration_writes")
      .get() as { n: number };
    expect(count.n).toBe(0);
  });

  it("swallows SQLite errors so the route handler still returns 2xx", () => {
    db.prepare("DROP TABLE integration_writes").run();
    expect(() =>
      markIntegrationWrite(db, "google_calendar", "evt-x"),
    ).not.toThrow();
  });
});

describe("safety/integration-write-tracker — actor-resolution race", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(":memory:");
    applySchema(db);
  });
  afterEach(() => db.close());

  const calendarNormalizer = getSnapshotNormalizer("google_calendar")!;
  if (!calendarNormalizer) throw new Error("calendar normalizer must be registered");

  function calendarItem(id: string, start: string, summary = "Test event") {
    const raw = {
      id,
      summary,
      start: { dateTime: start },
      end: { dateTime: new Date(Date.parse(start) + 3600 * 1000).toISOString() },
    };
    const payload = calendarNormalizer.payload(raw);
    return {
      itemId: calendarNormalizer.itemId(raw),
      contentHash: calendarNormalizer.hash(payload),
      payload,
      itemStart: calendarNormalizer.itemStart(raw),
      raw,
    };
  }

  it("agent-marked write surfaces as actor='agent' in the next reconcile", () => {
    const fetchedAt1 = "2026-04-28T12:00:00.000Z";
    const event = calendarItem("evt-A", "2026-04-28T15:00:00.000Z");

    // First reconcile: nothing in the snapshot yet, so the partition
    // bootstraps as initial-snapshot. No diff entries are emitted —
    // we just need to bring the partition out of "isInitialSnapshot".
    reconcile(
      db,
      {
        integration: "google_calendar",
        windowKey: "primary:24h",
        windowMin: "2026-04-28T12:00:00.000Z",
        windowMax: "2026-04-29T12:00:00.000Z",
        fetchedAt: fetchedAt1,
        items: [event],
      },
      { normalizer: calendarNormalizer },
    );

    // Agent makes an upstream change to evt-A — route handler marks
    // (gmail, evt-A) before the reconcile that observes the change.
    markIntegrationWrite(db, "google_calendar", "evt-A", {
      nowIso: "2026-04-28T12:30:00.000Z",
    });

    // New event payload (summary differs → hash drifts → 'modified').
    const updated = calendarItem("evt-A", "2026-04-28T15:00:00.000Z", "Renamed");
    const fetchedAt2 = "2026-04-28T12:31:00.000Z";
    const diff = reconcile(
      db,
      {
        integration: "google_calendar",
        windowKey: "primary:24h",
        windowMin: "2026-04-28T12:31:00.000Z",
        windowMax: "2026-04-29T12:31:00.000Z",
        fetchedAt: fetchedAt2,
        items: [updated],
      },
      { normalizer: calendarNormalizer },
    );

    expect(diff.modified).toHaveLength(1);
    expect(diff.modified[0].itemId).toBe("evt-A");
    expect(diff.modified[0].actor).toBe("agent");
  });

  it("expired integration_writes row falls back to 'user' attribution", () => {
    const event = calendarItem("evt-B", "2026-04-28T15:00:00.000Z");
    reconcile(
      db,
      {
        integration: "google_calendar",
        windowKey: "primary:24h",
        windowMin: "2026-04-28T12:00:00.000Z",
        windowMax: "2026-04-29T12:00:00.000Z",
        fetchedAt: "2026-04-28T12:00:00.000Z",
        items: [event],
      },
      { normalizer: calendarNormalizer },
    );

    // Mark expires_at = 12:01:00, but reconcile fetchedAt = 12:30:00 —
    // RESOLVE_AGENT_WRITE_SQL filters `expires_at > fetchedAt`, so the
    // row is past TTL and should not influence actor.
    markIntegrationWrite(db, "google_calendar", "evt-B", {
      ttlMs: 60_000,
      nowIso: "2026-04-28T12:00:00.000Z",
    });

    const updated = calendarItem("evt-B", "2026-04-28T15:00:00.000Z", "Renamed");
    const diff = reconcile(
      db,
      {
        integration: "google_calendar",
        windowKey: "primary:24h",
        windowMin: "2026-04-28T12:30:00.000Z",
        windowMax: "2026-04-29T12:30:00.000Z",
        fetchedAt: "2026-04-28T12:30:00.000Z",
        items: [updated],
      },
      { normalizer: calendarNormalizer },
    );

    expect(diff.modified).toHaveLength(1);
    expect(diff.modified[0].itemId).toBe("evt-B");
    expect(diff.modified[0].actor).toBe("user");
  });
});
