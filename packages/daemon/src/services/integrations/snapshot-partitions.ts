import type Database from "better-sqlite3";
import type { IntegrationKey, IntegrationMode } from "@aitne/shared";
import { createLogger } from "../../logging.js";

const logger = createLogger("snapshot-partitions");

/**
 * INTEGRATION-DRIFT-PHASE-7-PLAN.md §3.3 — per-integration ownership map
 * over `integration_snapshots` window-key partitions, indexed by the
 * `IntegrationMode` whose writer owns each partition.
 *
 *   - `direct`: writers are the in-process pollers (CalendarPoller).
 *     `primary:14d` is calendar's direct-mode window.
 *   - `delegated`: writers are the DelegatedSyncWorker cadences. Calendar
 *     uses `primary:imminent` + `primary:24h`; Gmail uses `inbox:7d`;
 *     Notion uses `recently_updated`.
 *   - `native`: writers are the agent's in-turn `POST /api/observations`
 *     calls (INTEGRATION_NATIVE_MODE_DESIGN.md §8.3). They land directly
 *     in the `observations` table rather than `integration_snapshots`, so
 *     this row is empty — `partitionsToPurge` will already drop the
 *     prior-mode partitions when flipping out of direct/delegated.
 *   - `disabled`: no writer; partitions are empty.
 *
 * The map is the single source of truth for the §3.3 stale-partition
 * cleanup. Phase 6's direct-mode unification will populate the direct
 * row for gmail / notion; until then those rows stay empty so the
 * helper is a no-op for them.
 */
export const INTEGRATION_SNAPSHOT_PARTITIONS_BY_MODE: Readonly<
  Record<IntegrationKey, Readonly<Record<IntegrationMode, readonly string[]>>>
> = {
  google_calendar: {
    direct: ["primary:14d"],
    delegated: ["primary:imminent", "primary:24h"],
    native: [],
    disabled: [],
  },
  gmail: {
    direct: [],
    delegated: ["inbox:7d"],
    native: [],
    disabled: [],
  },
  notion: {
    direct: [],
    delegated: ["recently_updated"],
    native: [],
    disabled: [],
  },
  git: {
    direct: [],
    delegated: [],
    native: [],
    disabled: [],
  },
  github: {
    direct: [],
    delegated: [],
    native: [],
    disabled: [],
  },
  // SETUP-FLOW-REDESIGN-PLAN §6.1 — Outlook integrations are direct-only
  // in v1 with no MCP connectors, so the delegated drift snapshot path
  // never owns any partitions. Empty rows keep the type system honest
  // without committing to a partitioning scheme yet.
  outlook_mail: {
    direct: [],
    delegated: [],
    native: [],
    disabled: [],
  },
  outlook_calendar: {
    direct: [],
    delegated: [],
    native: [],
    disabled: [],
  },
  // Browser history has no integration_snapshots partitions — ingest is
  // local-file-backed and not part of the delegated drift pipeline.
  browser_history: {
    direct: [],
    delegated: [],
    native: [],
    disabled: [],
  },
};

/**
 * Compute the set of window keys that were owned by `prev` but are not
 * owned by `next`. These are the partitions whose writer is going away —
 * leaving them in `integration_snapshots` would let a future flip-back
 * see their stale prior set as the diff baseline and emit a one-tick
 * burst of spurious `modified` / `deleted` entries.
 */
export function partitionsToPurge(
  integration: IntegrationKey,
  prev: IntegrationMode,
  next: IntegrationMode,
): string[] {
  const ownership = INTEGRATION_SNAPSHOT_PARTITIONS_BY_MODE[integration];
  const prevSet = new Set(ownership[prev]);
  const nextSet = new Set(ownership[next]);
  const out: string[] = [];
  for (const key of prevSet) {
    if (!nextSet.has(key)) out.push(key);
  }
  return out.sort();
}

/**
 * Delete `integration_snapshots` rows and the matching `runtime_state`
 * partition-init flags for partitions whose writer just went away. Best-
 * effort: failures log warn and never throw — `applyIntegrationModeChange`
 * is the only caller and the integration mode flip itself has already
 * been persisted by the time this runs, so an error here is hygiene
 * lost, not state corrupted.
 *
 * Returns the partitions that were processed for log + test visibility.
 */
export function purgeStaleSnapshotPartitions(
  db: Database.Database,
  integration: IntegrationKey,
  prev: IntegrationMode,
  next: IntegrationMode,
): string[] {
  const stale = partitionsToPurge(integration, prev, next);
  if (stale.length === 0) return [];

  try {
    const txn = db.transaction((keys: readonly string[]) => {
      const deleteSnapshot = db.prepare(
        "DELETE FROM integration_snapshots WHERE integration = ? AND window_key = ?",
      );
      const deleteInit = db.prepare(
        "DELETE FROM runtime_state WHERE key = ?",
      );
      for (const windowKey of keys) {
        deleteSnapshot.run(integration, windowKey);
        deleteInit.run(`integration_snapshot_initialized:${integration}:${windowKey}`);
      }
    });
    txn(stale);
    logger.info(
      { integration, prev, next, purgedPartitions: stale },
      "Purged stale integration_snapshots partitions after mode change",
    );
  } catch (err) {
    /* c8 ignore start — defensive against a malformed schema in a stripped
     *   test harness; live daemon path always has the tables. */
    logger.warn(
      { err, integration, prev, next, purgedPartitions: stale },
      "Failed to purge stale snapshot partitions; mode change still applied",
    );
    /* c8 ignore stop */
  }
  return stale;
}
