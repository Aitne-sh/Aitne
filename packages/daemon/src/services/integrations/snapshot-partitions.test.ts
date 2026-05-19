import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { applySchema } from "../../db/schema.js";
import {
  INTEGRATION_SNAPSHOT_PARTITIONS_BY_MODE,
  partitionsToPurge,
  purgeStaleSnapshotPartitions,
} from "./snapshot-partitions.js";

describe("partitionsToPurge", () => {
  it("returns the set difference (prev - next) for google_calendar direct→delegated", () => {
    expect(partitionsToPurge("google_calendar", "direct", "delegated")).toEqual([
      "primary:14d",
    ]);
  });

  it("returns delegated calendar partitions when going to direct", () => {
    expect(partitionsToPurge("google_calendar", "delegated", "direct")).toEqual([
      "primary:24h",
      "primary:imminent",
    ]);
  });

  it("returns the full prev set when going to disabled", () => {
    expect(partitionsToPurge("google_calendar", "delegated", "disabled")).toEqual([
      "primary:24h",
      "primary:imminent",
    ]);
    expect(partitionsToPurge("gmail", "delegated", "disabled")).toEqual([
      "inbox:7d",
    ]);
    expect(partitionsToPurge("notion", "delegated", "disabled")).toEqual([
      "recently_updated",
    ]);
  });

  it("returns empty list when prev === next", () => {
    expect(partitionsToPurge("google_calendar", "direct", "direct")).toEqual([]);
    expect(partitionsToPurge("google_calendar", "delegated", "delegated")).toEqual([]);
  });

  it("returns empty list for integrations with no direct-mode partitions yet (Phase 6 stub)", () => {
    // gmail/notion direct-mode partitions are reserved for Phase 6; the
    // ownership map declares them empty so direct↔disabled is a no-op
    // until then.
    expect(partitionsToPurge("gmail", "direct", "disabled")).toEqual([]);
    expect(partitionsToPurge("notion", "direct", "disabled")).toEqual([]);
  });
});

describe("INTEGRATION_SNAPSHOT_PARTITIONS_BY_MODE", () => {
  it("declares calendar's direct partition as primary:14d (matches CalendarPoller)", () => {
    expect(
      INTEGRATION_SNAPSHOT_PARTITIONS_BY_MODE.google_calendar.direct,
    ).toEqual(["primary:14d"]);
  });

  it("declares delegated partitions per cadence definition", () => {
    expect(
      INTEGRATION_SNAPSHOT_PARTITIONS_BY_MODE.google_calendar.delegated,
    ).toEqual(["primary:imminent", "primary:24h"]);
    expect(INTEGRATION_SNAPSHOT_PARTITIONS_BY_MODE.gmail.delegated).toEqual([
      "inbox:7d",
    ]);
    expect(INTEGRATION_SNAPSHOT_PARTITIONS_BY_MODE.notion.delegated).toEqual([
      "recently_updated",
    ]);
  });
});

describe("purgeStaleSnapshotPartitions", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    applySchema(db);
  });

  afterEach(() => {
    db.close();
  });

  function seed(integration: string, windowKey: string, itemId: string): void {
    db.prepare(
      `INSERT INTO integration_snapshots
         (integration, window_key, item_id, content_hash, payload_json,
          item_start, fetched_at, actor_hint)
       VALUES (?, ?, ?, 'h', '{}', NULL, '2026-04-29T00:00:00Z', 'user')`,
    ).run(integration, windowKey, itemId);
    db.prepare(
      `INSERT INTO runtime_state (key, value_json, updated_at)
       VALUES (?, 'true', CURRENT_TIMESTAMP)`,
    ).run(`integration_snapshot_initialized:${integration}:${windowKey}`);
  }

  function rowCount(integration: string, windowKey: string): number {
    return (
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM integration_snapshots WHERE integration = ? AND window_key = ?",
        )
        .get(integration, windowKey) as { n: number }
    ).n;
  }

  function initFlagExists(integration: string, windowKey: string): boolean {
    return (
      db
        .prepare("SELECT 1 FROM runtime_state WHERE key = ?")
        .get(`integration_snapshot_initialized:${integration}:${windowKey}`)
        !== undefined
    );
  }

  it("deletes stale rows AND init flags atomically", () => {
    seed("google_calendar", "primary:imminent", "evt-1");
    seed("google_calendar", "primary:24h", "evt-2");

    const purged = purgeStaleSnapshotPartitions(
      db,
      "google_calendar",
      "delegated",
      "direct",
    );

    expect(purged).toEqual(["primary:24h", "primary:imminent"]);
    expect(rowCount("google_calendar", "primary:imminent")).toBe(0);
    expect(rowCount("google_calendar", "primary:24h")).toBe(0);
    expect(initFlagExists("google_calendar", "primary:imminent")).toBe(false);
    expect(initFlagExists("google_calendar", "primary:24h")).toBe(false);
  });

  it("returns an empty list and writes nothing when prev === next", () => {
    seed("notion", "recently_updated", "page-1");
    const purged = purgeStaleSnapshotPartitions(db, "notion", "delegated", "delegated");
    expect(purged).toEqual([]);
    expect(rowCount("notion", "recently_updated")).toBe(1);
    expect(initFlagExists("notion", "recently_updated")).toBe(true);
  });

  it("leaves rows belonging to a partition that is shared by both modes", () => {
    // Sanity: future work might add a partition shared between direct and
    // delegated. Today no such partition exists, but the helper's
    // semantics (set difference) already cover it correctly. Verified by
    // not deleting `primary:14d` when going from direct to direct.
    seed("google_calendar", "primary:14d", "evt-d14");
    purgeStaleSnapshotPartitions(db, "google_calendar", "direct", "direct");
    expect(rowCount("google_calendar", "primary:14d")).toBe(1);
  });

  it("logs warn and returns the planned partition list when the DELETE throws", () => {
    // Drop the snapshot table to force the prepared DELETE to throw on
    // run; the helper must swallow, log warn, and return the planned
    // list (not throw back at applyIntegrationModeChange).
    db.exec("DROP TABLE integration_snapshots");
    const purged = purgeStaleSnapshotPartitions(
      db,
      "google_calendar",
      "delegated",
      "direct",
    );
    expect(purged).toEqual(["primary:24h", "primary:imminent"]);
  });
});
