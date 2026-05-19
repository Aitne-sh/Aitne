import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import Database from "better-sqlite3";
import { AuthTelemetry, bucketHourIso } from "./auth-telemetry.js";

function createSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE auth_telemetry_counters (
      backend_id TEXT NOT NULL,
      counter_key TEXT NOT NULL,
      bucket_hour TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'reactive',
      count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (backend_id, counter_key, bucket_hour, source)
    );
  `);
}

describe("bucketHourIso", () => {
  it("truncates to the hour boundary in UTC", () => {
    expect(bucketHourIso(new Date("2026-04-10T03:17:42.123Z"))).toBe(
      "2026-04-10T03:00:00Z",
    );
  });

  it("handles exact hour inputs", () => {
    expect(bucketHourIso(new Date("2026-04-10T03:00:00.000Z"))).toBe(
      "2026-04-10T03:00:00Z",
    );
  });

  it("normalizes trailing seconds/millis to 00:00", () => {
    expect(bucketHourIso(new Date("2026-04-10T23:59:59.999Z"))).toBe(
      "2026-04-10T23:00:00Z",
    );
  });
});

describe("AuthTelemetry", () => {
  let db: Database.Database;
  let telemetry: AuthTelemetry;

  beforeEach(() => {
    db = new Database(":memory:");
    createSchema(db);
    telemetry = new AuthTelemetry(db);
  });

  afterEach(() => {
    vi.useRealTimers();
    db.close();
  });

  it("upserts counts across multiple calls in the same hour", () => {
    telemetry.recordProbeResult("claude", "ok");
    telemetry.recordProbeResult("claude", "ok");
    telemetry.recordProbeResult("claude", "ok");

    const snapshot = telemetry.snapshot();
    expect(snapshot.claude?.probe_ok).toBe(3);
  });

  it("separates buckets across different hours", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-10T01:15:00Z"));
    telemetry.recordProbeResult("claude", "ok");

    vi.setSystemTime(new Date("2026-04-10T02:45:00Z"));
    telemetry.recordProbeResult("claude", "ok");
    telemetry.recordProbeResult("claude", "ok");

    const rows = db.prepare("SELECT bucket_hour, count FROM auth_telemetry_counters ORDER BY bucket_hour").all() as Array<{ bucket_hour: string; count: number }>;
    expect(rows).toEqual([
      { bucket_hour: "2026-04-10T01:00:00Z", count: 1 },
      { bucket_hour: "2026-04-10T02:00:00Z", count: 2 },
    ]);
  });

  it("exposes each typed recorder", () => {
    telemetry.recordProbeResult("claude", "unauthorized");
    telemetry.recordProbeResult("codex", "network_error");
    telemetry.recordSelfHealObserved("claude", "reactive");
    telemetry.recordSchemaParseFailure("claude");
    telemetry.recordKeychainReadFailed("claude");
    telemetry.recordCredentialsFileReadFailed("claude");
    telemetry.recordKeepaliveReminder("gemini");
    telemetry.recordReactiveExpired("codex");

    const snapshot = telemetry.snapshot();
    expect(snapshot.claude?.probe_unauthorized).toBe(1);
    expect(snapshot.codex?.probe_network_error).toBe(1);
    expect(snapshot.claude?.self_heal_observed).toBe(1);
    expect(snapshot.claude?.schema_parse_failed).toBe(1);
    expect(snapshot.claude?.keychain_read_failed).toBe(1);
    expect(snapshot.claude?.credentials_file_read_failed).toBe(1);
    expect(snapshot.gemini?.keepalive_reminder_sent).toBe(1);
    expect(snapshot.codex?.reactive_expired).toBe(1);
  });

  it("pins each intrinsic-source counter to its natural source", () => {
    telemetry.recordProbeResult("claude", "ok");
    telemetry.recordSchemaParseFailure("claude");
    telemetry.recordKeychainReadFailed("claude");
    telemetry.recordCredentialsFileReadFailed("claude");
    telemetry.recordKeepaliveReminder("codex");
    telemetry.recordReactiveExpired("gemini");

    const rows = db
      .prepare("SELECT counter_key, source FROM auth_telemetry_counters ORDER BY counter_key, source")
      .all() as Array<{ counter_key: string; source: string }>;

    const byKey = Object.fromEntries(rows.map((r) => [r.counter_key, r.source]));
    expect(byKey.probe_ok).toBe("probe");
    expect(byKey.schema_parse_failed).toBe("probe");
    expect(byKey.keychain_read_failed).toBe("probe");
    expect(byKey.credentials_file_read_failed).toBe("probe");
    expect(byKey.keepalive_reminder_sent).toBe("keepalive");
    expect(byKey.reactive_expired).toBe("reactive");
  });

  it("self_heal_observed buckets separately by source", () => {
    telemetry.recordSelfHealObserved("claude", "reactive");
    telemetry.recordSelfHealObserved("claude", "reactive");
    telemetry.recordSelfHealObserved("claude", "probe");

    // Backward-compatible snapshot sums across sources.
    expect(telemetry.snapshot().claude?.self_heal_observed).toBe(3);

    // Source-grouped snapshot shows the split.
    const grouped = telemetry.snapshotBySource();
    expect(grouped.claude?.reactive?.self_heal_observed).toBe(2);
    expect(grouped.claude?.probe?.self_heal_observed).toBe(1);
  });

  it("increment accepts a custom step", () => {
    telemetry.increment("claude", "probe_ok", "probe", 5);
    telemetry.increment("claude", "probe_ok", "probe", 2);
    expect(telemetry.snapshot().claude?.probe_ok).toBe(7);
  });

  it("snapshot filters rows older than the requested window", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-10T12:00:00Z"));

    // Insert an old row directly to simulate prior history.
    db.prepare(
      `INSERT INTO auth_telemetry_counters (backend_id, counter_key, bucket_hour, count)
       VALUES ('claude', 'probe_ok', '2026-04-01T00:00:00Z', 99)`,
    ).run();

    telemetry.recordProbeResult("claude", "ok");
    const snapshot = telemetry.snapshot(1);
    expect(snapshot.claude?.probe_ok).toBe(1);

    const full = telemetry.snapshot(24 * 365);
    expect(full.claude?.probe_ok).toBe(100);
  });

  it("pruneOlderThan deletes stale buckets and returns the count", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-10T12:00:00Z"));

    db.prepare(
      `INSERT INTO auth_telemetry_counters (backend_id, counter_key, bucket_hour, count)
       VALUES ('claude', 'probe_ok', '2025-04-01T00:00:00Z', 99)`,
    ).run();
    telemetry.recordProbeResult("claude", "ok");

    const deleted = telemetry.pruneOlderThan(30);
    expect(deleted).toBe(1);

    const snapshot = telemetry.snapshot(24 * 365);
    expect(snapshot.claude?.probe_ok).toBe(1);
  });
});
