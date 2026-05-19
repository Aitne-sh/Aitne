import type Database from "better-sqlite3";
import {
  isIntegrationKey,
  type BackendId,
  type IntegrationKey,
} from "@aitne/shared";
import type { ProbeResult } from "../core/integration-probe.js";

/**
 * Integration delegation framework — `integration_probes` persistence.
 *
 * The schema (see `schema.ts`) defines `(integration_key, backend_id)` as the
 * primary key. `result_json` stores the full {@link ProbeResult} payload so
 * consumers don't need to re-derive feature maps; the denormalized
 * `probed_at` column lets the recency index sort cheaply.
 */

interface ProbeRow {
  integration_key: string;
  backend_id: string;
  result_json: string;
  probed_at: string;
}

function parseRow(row: ProbeRow): ProbeResult | null {
  try {
    const parsed = JSON.parse(row.result_json) as ProbeResult;
    // Trust the persisted shape — writers go through `writeProbe` which
    // accepts a typed `ProbeResult`. A corrupted row (manual SQL edit,
    // mid-write crash) returns null so callers fall back to the
    // descriptor-default features map rather than crashing.
    if (!isIntegrationKey(parsed.integration)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function writeProbe(
  db: Database.Database,
  result: ProbeResult,
): void {
  db.prepare(
    `INSERT INTO integration_probes (integration_key, backend_id, result_json, probed_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(integration_key, backend_id) DO UPDATE SET
       result_json = excluded.result_json,
       probed_at = excluded.probed_at`,
  ).run(
    result.integration,
    result.backend,
    JSON.stringify(result),
    result.probedAt,
  );
}

export function readProbe(
  db: Database.Database,
  integration: IntegrationKey,
  backend: BackendId,
): ProbeResult | null {
  const row = db
    .prepare(
      `SELECT integration_key, backend_id, result_json, probed_at
         FROM integration_probes
         WHERE integration_key = ? AND backend_id = ?`,
    )
    .get(integration, backend) as ProbeRow | undefined;
  if (!row) return null;
  return parseRow(row);
}

/**
 * Read every probe row keyed by `(integration, backend)`. The /health
 * endpoint and dashboard call this to render the per-key feature matrix
 * without N round-trips.
 */
export function listProbes(
  db: Database.Database,
): ReadonlyMap<string, ProbeResult> {
  const rows = db
    .prepare(
      `SELECT integration_key, backend_id, result_json, probed_at
         FROM integration_probes`,
    )
    .all() as ProbeRow[];
  const out = new Map<string, ProbeResult>();
  for (const row of rows) {
    const parsed = parseRow(row);
    if (!parsed) continue;
    out.set(probeKey(parsed.integration, parsed.backend), parsed);
  }
  return out;
}

/**
 * Stable composite key used by callers that need to look up by
 * `(integration, backend)` after listing — e.g. /health iterating the
 * registry then matching the cache. Kept as a single function so callers
 * never reinvent the join character.
 */
export function probeKey(
  integration: IntegrationKey,
  backend: BackendId,
): string {
  return `${integration}::${backend}`;
}

/**
 * Drop every cached probe row for an integration. Called by the PATCH
 * handler after a mode change so `/health.integrationModes.<key>.features`
 * stops showing stale probe data taken before the change — /health then
 * falls back to the descriptor's POC-inventory defaults until the next
 * live probe (dashboard button) re-populates the cache.
 */
export function deleteProbesForIntegration(
  db: Database.Database,
  integration: IntegrationKey,
): number {
  const result = db
    .prepare(`DELETE FROM integration_probes WHERE integration_key = ?`)
    .run(integration);
  return result.changes;
}
