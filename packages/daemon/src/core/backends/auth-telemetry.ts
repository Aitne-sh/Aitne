import type Database from "better-sqlite3";
import type { BackendId } from "@aitne/shared";

/**
 * DB-backed authentication telemetry.
 *
 * Persists counters in hourly buckets so 24h / 72h trend queries survive
 * daemon restarts. Backed by the `auth_telemetry_counters` table — see
 * `schema.ts` and `docs/design/09-safety-cost.md` §9.5.8.
 *
 * The `source` grain lets Phase 4 dashboards answer "this backend's
 * self-heal is N% reactive / M% probe"; until Phase 4 it simply makes
 * the counter writes semantically honest. Intrinsic-source counters
 * (probe_*, reactive_expired, keepalive_reminder_sent) are pinned to
 * their natural source. `self_heal_observed` is the only counter that
 * accepts an explicit source argument because it can be bumped from
 * either the reactive path or the probe path.
 */

export type AuthCounterKey =
  | "probe_ok"
  | "probe_unauthorized"
  | "probe_network_error"
  | "self_heal_observed"
  | "schema_parse_failed"
  | "keychain_read_failed"
  | "credentials_file_read_failed"
  | "keepalive_reminder_sent"
  | "reactive_expired"
  | "preflight_skipped_main"
  | "recovery_started"
  | "recovery_success"
  | "recovery_timeout"
  | "recovery_failed";

export type AuthCounterSource = "reactive" | "probe" | "keepalive";

export type AuthTelemetrySnapshot = {
  [backendId: string]: { [K in AuthCounterKey]?: number };
};

/**
 * Source-grouped snapshot for the Phase 4 dashboard Analytics view.
 * Keyed by backend → source → counter.
 */
export type AuthTelemetryBySourceSnapshot = {
  [backendId: string]: {
    [S in AuthCounterSource]?: { [K in AuthCounterKey]?: number };
  };
};

/**
 * Bucket a timestamp to its hour boundary in ISO8601 (UTC).
 *
 * Example: `2026-04-10T03:17:42.123Z` → `2026-04-10T03:00:00Z`.
 */
export function bucketHourIso(date: Date): string {
  const iso = date.toISOString();
  return `${iso.slice(0, 13)}:00:00Z`;
}

export class AuthTelemetry {
  constructor(private readonly db: Database.Database) {}

  /**
   * Low-level upsert. Prefer the typed `record*` wrappers — they pin
   * each counter to its intrinsic source and keep callers from
   * stumbling into the wrong bucket.
   */
  increment(
    backend: BackendId,
    key: AuthCounterKey,
    source: AuthCounterSource,
    n = 1,
  ): void {
    const bucket = bucketHourIso(new Date());
    this.db
      .prepare(
        `INSERT INTO auth_telemetry_counters (backend_id, counter_key, bucket_hour, source, count)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (backend_id, counter_key, bucket_hour, source)
         DO UPDATE SET count = count + excluded.count`,
      )
      .run(backend, key, bucket, source, n);
  }

  recordProbeResult(
    backend: BackendId,
    result: "ok" | "unauthorized" | "network_error",
  ): void {
    this.increment(backend, `probe_${result}` as AuthCounterKey, "probe");
  }

  /**
   * `self_heal_observed` is the only counter whose source is genuinely
   * variable — it can be bumped from the reactive path (successful
   * execute clearing a prior failure) or from the probe path (Phase 4
   * hourly probe flipping expired → ok). Callers MUST pass the source
   * explicitly so the Analytics tab can attribute recoveries correctly.
   */
  recordSelfHealObserved(
    backend: BackendId,
    source: AuthCounterSource,
  ): void {
    this.increment(backend, "self_heal_observed", source);
  }

  recordSchemaParseFailure(backend: BackendId): void {
    this.increment(backend, "schema_parse_failed", "probe");
  }

  recordKeychainReadFailed(backend: BackendId): void {
    this.increment(backend, "keychain_read_failed", "probe");
  }

  recordCredentialsFileReadFailed(backend: BackendId): void {
    this.increment(backend, "credentials_file_read_failed", "probe");
  }

  recordKeepaliveReminder(backend: BackendId): void {
    this.increment(backend, "keepalive_reminder_sent", "keepalive");
  }

  recordReactiveExpired(backend: BackendId): void {
    this.increment(backend, "reactive_expired", "reactive");
  }

  /**
   * Aggregate counters over the last `hoursBack` hours (default 72).
   * Sums across sources for backward-compatible shape. Use
   * `snapshotBySource` to break down by source.
   */
  snapshot(hoursBack = 72): AuthTelemetrySnapshot {
    const since = new Date(Date.now() - hoursBack * 3_600_000);
    const rows = this.db
      .prepare(
        `SELECT backend_id, counter_key, SUM(count) AS total
           FROM auth_telemetry_counters
          WHERE bucket_hour >= ?
          GROUP BY backend_id, counter_key`,
      )
      .all(bucketHourIso(since)) as Array<{
        backend_id: BackendId;
        counter_key: AuthCounterKey;
        total: number;
      }>;

    const result: AuthTelemetrySnapshot = {};
    for (const row of rows) {
      const byKey = (result[row.backend_id] ??= {});
      byKey[row.counter_key] = row.total;
    }
    return result;
  }

  /**
   * Source-grouped snapshot for Phase 4 Analytics: `{ backend: { source:
   * { counter: total } } }`. Counters that only have one intrinsic
   * source appear once; `self_heal_observed` may appear under both
   * `reactive` and `probe`.
   */
  snapshotBySource(hoursBack = 72): AuthTelemetryBySourceSnapshot {
    const since = new Date(Date.now() - hoursBack * 3_600_000);
    const rows = this.db
      .prepare(
        `SELECT backend_id, counter_key, source, SUM(count) AS total
           FROM auth_telemetry_counters
          WHERE bucket_hour >= ?
          GROUP BY backend_id, counter_key, source`,
      )
      .all(bucketHourIso(since)) as Array<{
        backend_id: BackendId;
        counter_key: AuthCounterKey;
        source: AuthCounterSource;
        total: number;
      }>;

    const result: AuthTelemetryBySourceSnapshot = {};
    for (const row of rows) {
      const byBackend = (result[row.backend_id] ??= {});
      const bySource = (byBackend[row.source] ??= {});
      bySource[row.counter_key] = row.total;
    }
    return result;
  }

  /** Delete telemetry rows older than `days` days (retention GC). */
  pruneOlderThan(days: number): number {
    const cutoff = new Date(Date.now() - days * 86_400_000);
    const info = this.db
      .prepare("DELETE FROM auth_telemetry_counters WHERE bucket_hour < ?")
      .run(bucketHourIso(cutoff));
    return Number(info.changes);
  }
}
