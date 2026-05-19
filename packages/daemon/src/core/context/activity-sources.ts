import type Database from "better-sqlite3";
import { normalizeAppLabel } from "@aitne/shared";

/**
 * Activity-source enumeration (docs/design/21-management-registry-and-
 * entities.md §9.6). Lifted out of `activity-view-runner.ts` so the
 * dashboard can consume the same union the runner renders into
 * `_activity/<source>.md` (followups doc Issue 3).
 *
 * The "active source set" is the union of three projections:
 *
 *   1. `managed_tasks.app_normalized` — the registered fetches (Section
 *      B of `rules/management.md`).
 *   2. `entity_source_keys.source_key` — every L2 entity file that
 *      mentions a source key, joined to the entity's date / sync window.
 *   3. `agent_actions.detail->>app_normalized` — recent management_task
 *      lifecycle rows. Includes `old_app_normalized` for renames so the
 *      OLD label keeps its 90-day post-stop window.
 *
 * Each result carries a `status`:
 *   - `active`  — there is a row in `managed_tasks` for this normalized
 *                 form (Settings → Management can edit it).
 *   - `stopped` — the source appears only in (2) or (3); typically a
 *                 recently stopped task whose `_activity/<source>.md`
 *                 file is still on disk for the 90-day window. The
 *                 dashboard's Activity tab keeps showing it; the
 *                 Settings → Management page does not (it only edits
 *                 the active set).
 */

export interface ActivitySourceRef {
  /** First user-typed label seen for this normalized form. */
  label: string;
  /** `normalizeAppLabel(label)` — dedup key. */
  normalized: string;
  /** Whether a `managed_tasks` row covers this normalized form. */
  status: "active" | "stopped";
}

export function enumerateActivitySources(
  db: Database.Database,
  cutoffDate: string,
): ActivitySourceRef[] {
  // Active set first — those rows win the label slot when an
  // entity-only or audit-only entry would later try to claim the same
  // normalized form (managed_tasks.app is the canonical user-typed
  // label for the active path).
  const activeRows = db
    .prepare(`SELECT app, app_normalized FROM managed_tasks`)
    .all() as { app: string; app_normalized: string }[];
  const activeSet = new Set<string>(activeRows.map((r) => r.app_normalized));

  const labels = new Map<string, string>();
  for (const row of activeRows) {
    if (!labels.has(row.app_normalized)) {
      labels.set(row.app_normalized, row.app);
    }
  }

  // Entity-source-keys with an entity that lands inside the 90-day
  // window. The COALESCE order matches `buildActivitySnapshot` so a
  // source is only enumerated when at least one entity will actually
  // surface in its rendered file.
  const entityRows = db
    .prepare(
      `SELECT DISTINCT k.source_key
         FROM entity_source_keys k
         JOIN entities e ON e.path = k.path
        WHERE COALESCE(e.date, e.last_synced_at, '0000-00-00') >= ?`,
    )
    .all(cutoffDate) as { source_key: string }[];
  for (const row of entityRows) {
    const normalized = normalizeAppLabel(row.source_key);
    if (!labels.has(normalized)) labels.set(normalized, row.source_key);
  }

  // Audit rows. UNION two SELECTs so a `management_task.app_renamed`
  // contributes both the new label (via `$.app_normalized`) AND the
  // old label (via `$.old_app_normalized`).
  const auditRows = db
    .prepare(
      `SELECT DISTINCT app_normalized, app FROM (
         SELECT json_extract(detail, '$.app_normalized') AS app_normalized,
                json_extract(detail, '$.app')            AS app
           FROM agent_actions
          WHERE action_type LIKE 'management_task.%'
            AND date(started_at) >= ?
            AND json_extract(detail, '$.app_normalized') IS NOT NULL
         UNION
         SELECT json_extract(detail, '$.old_app_normalized') AS app_normalized,
                json_extract(detail, '$.old_app')            AS app
           FROM agent_actions
          WHERE action_type = 'management_task.app_renamed'
            AND date(started_at) >= ?
            AND json_extract(detail, '$.old_app_normalized') IS NOT NULL
       )`,
    )
    .all(cutoffDate, cutoffDate) as {
      app_normalized: string;
      app: string | null;
    }[];
  for (const row of auditRows) {
    if (!row.app_normalized) continue;
    if (!labels.has(row.app_normalized)) {
      labels.set(row.app_normalized, row.app ?? row.app_normalized);
    }
  }

  return Array.from(labels.entries())
    .map(([normalized, label]) => ({
      normalized,
      label,
      status: activeSet.has(normalized)
        ? ("active" as const)
        : ("stopped" as const),
    }))
    .sort((a, b) => a.normalized.localeCompare(b.normalized));
}
