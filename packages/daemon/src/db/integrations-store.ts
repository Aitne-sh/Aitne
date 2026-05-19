import type Database from "better-sqlite3";
import {
  INTEGRATION_KEYS,
  defaultIntegrationsMap,
  integrationStateSchema,
  isIntegrationKey,
  type IntegrationKey,
  type IntegrationState,
} from "@aitne/shared";

/**
 * Integration Delegation Framework — persistence (Phase 1).
 *
 * The integrations map is a single JSON blob under `settings` key
 * `"integrations"`. The shape is `Record<IntegrationKey, IntegrationState>`.
 * Readers always get every registered key back (defaults filled in for
 * missing rows) so callers don't have to null-check per integration; writers
 * also re-validate every key before persisting.
 *
 * Not exposed through `SqliteSettingsStore` / `runtimeSettingsSchema` on
 * purpose — integrations have their own `PATCH /api/integrations/:key`
 * surface and are not part of the generic `PATCH /api/config` key-space.
 */

const STORAGE_KEY = "integrations";

export type IntegrationsRecord = Record<IntegrationKey, IntegrationState>;

function withDefaults(
  raw: Record<string, unknown> | null,
  now: string = new Date().toISOString(),
): IntegrationsRecord {
  const fallback = defaultIntegrationsMap(now);
  if (!raw) return fallback;

  const out = { ...fallback } as IntegrationsRecord;
  for (const key of INTEGRATION_KEYS) {
    const candidate = raw[key];
    if (candidate === undefined) continue;
    const parsed = integrationStateSchema.safeParse(candidate);
    if (parsed.success) {
      out[key] = parsed.data;
    }
  }
  return out;
}

export function readIntegrations(db: Database.Database): IntegrationsRecord {
  try {
    const row = db
      .prepare("SELECT value_json FROM settings WHERE key = ?")
      .get(STORAGE_KEY) as { value_json: string } | undefined;
    if (!row) {
      return defaultIntegrationsMap();
    }
    const parsed = JSON.parse(row.value_json) as Record<string, unknown>;
    return withDefaults(parsed);
  } catch {
    return defaultIntegrationsMap();
  }
}

export function readIntegrationState(
  db: Database.Database,
  key: IntegrationKey,
): IntegrationState {
  return readIntegrations(db)[key];
}

/**
 * Atomically replace the full integrations map. Unknown keys are dropped;
 * missing keys are filled from the current stored map (or the all-disabled
 * default) so a partial update does not wipe sibling integrations.
 */
export function writeIntegrations(
  db: Database.Database,
  update: Partial<IntegrationsRecord>,
): IntegrationsRecord {
  const current = readIntegrations(db);
  const merged = { ...current } as IntegrationsRecord;
  for (const key of INTEGRATION_KEYS) {
    const candidate = update[key];
    if (candidate === undefined) continue;
    merged[key] = integrationStateSchema.parse(candidate);
  }
  db.prepare(
    `INSERT INTO settings (key, value_json, updated_at)
     VALUES (?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(key) DO UPDATE SET
       value_json = excluded.value_json,
       updated_at = CURRENT_TIMESTAMP`,
  ).run(STORAGE_KEY, JSON.stringify(merged));
  return merged;
}

/**
 * Update a single integration's state. The `lastChangedAt` timestamp is
 * stamped by the store; callers do not need to supply it.
 */
export function updateIntegrationState(
  db: Database.Database,
  key: IntegrationKey,
  next: Omit<IntegrationState, "lastChangedAt"> & { lastChangedAt?: string },
): IntegrationsRecord {
  if (!isIntegrationKey(key)) {
    throw new Error(`Unknown integration key: ${key}`);
  }
  const stamped: IntegrationState = {
    ...next,
    lastChangedAt: next.lastChangedAt ?? new Date().toISOString(),
  };
  return writeIntegrations(db, { [key]: stamped } as Partial<IntegrationsRecord>);
}
