import type Database from "better-sqlite3";

/**
 * `management_parse_failures` access helpers (docs/design/21-management-
 * registry-and-entities.md §9.1 parse rules, §17.1).
 *
 * Failures recorded here are surfaced on the dashboard's degraded-mode
 * banner (P6) and counted by the §14.3
 * `aitne_management_parse_failures_total` metric (P8). This module
 * provides the smallest necessary surface — record / list / clear —
 * to keep both consumers cheap and the registry's hot path uncluttered.
 */

export type ManagementParseFailureSection = "A" | "B" | "C" | null;

export interface ManagementParseFailure {
  id: number;
  section: ManagementParseFailureSection;
  reason: string;
  raw: string | null;
  created_at: string;
}

interface InsertParseFailure {
  section?: ManagementParseFailureSection;
  reason: string;
  raw?: string | null;
}

/**
 * Persist a single parse failure. Returns the inserted row id so call
 * sites can correlate the registry's structured parse result with the
 * dashboard banner's deep-link.
 */
export function recordManagementParseFailure(
  db: Database.Database,
  failure: InsertParseFailure,
): number {
  const result = db
    .prepare(
      `INSERT INTO management_parse_failures (section, reason, raw)
         VALUES (?, ?, ?)`,
    )
    .run(failure.section ?? null, failure.reason, failure.raw ?? null);
  return Number(result.lastInsertRowid);
}

/**
 * List the most recent parse failures, newest first. The default cap
 * matches the dashboard banner's render budget (a single row carries
 * the user-facing message; older rows are reachable from the
 * "see all" link).
 */
export function listManagementParseFailures(
  db: Database.Database,
  limit = 50,
): ManagementParseFailure[] {
  return db
    .prepare(
      `SELECT id, section, reason, raw, created_at
         FROM management_parse_failures
         ORDER BY id DESC
         LIMIT ?`,
    )
    .all(Math.max(1, Math.floor(limit))) as ManagementParseFailure[];
}

/**
 * Drop every recorded failure. Called by the registry once the file
 * round-trips cleanly so the dashboard banner clears without manual
 * intervention.
 */
export function clearManagementParseFailures(db: Database.Database): number {
  const result = db.prepare("DELETE FROM management_parse_failures").run();
  return result.changes;
}
