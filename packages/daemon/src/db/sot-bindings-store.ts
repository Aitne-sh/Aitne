import type Database from "better-sqlite3";
import {
  sotBindingsSchema,
  type SotBindings,
} from "@aitne/shared";

/**
 * Source-of-Truth bindings — persistence helpers (docs/design/21-management-
 * registry-and-entities.md §9.5, §10.6).
 *
 * SoT bindings are stored as a single JSON blob under `settings` key
 * `sot_bindings`. The shape is the array form of `SotBinding[]`. The
 * `settings` table follows the same idempotent INSERT-OR-UPDATE pattern
 * already used by `db/integrations-store.ts`.
 *
 * Reads always normalize the value through the Zod schema; an unparseable
 * blob (corruption, manual SQL edit) returns the empty array instead of
 * throwing — matching the integrations-store fallback pattern. The boot
 * reconciler in `core/management-registry.ts` then re-renders the file
 * with whatever bindings remain, so a corrupted JSON value cannot brick
 * the daemon.
 *
 * Writes go through `writeSotBindings` (full replace semantics, per
 * §10.6 PUT). The store does not implement single-row mutation — the
 * binding list is small (≤ NFR-1's domain count) so replace-everything
 * is the simplest API.
 */

export const SOT_BINDINGS_SETTINGS_KEY = "sot_bindings";

/**
 * Read the stored SoT bindings, returning an empty list when the row is
 * missing or unparseable. Idempotent and side-effect-free; safe to call
 * from boot, the registry renderer, or the future PUT route.
 */
export function readSotBindings(db: Database.Database): SotBindings {
  const row = db
    .prepare("SELECT value_json FROM settings WHERE key = ?")
    .get(SOT_BINDINGS_SETTINGS_KEY) as { value_json: string } | undefined;
  if (!row) return [];
  try {
    const parsed = JSON.parse(row.value_json);
    const validated = sotBindingsSchema.safeParse(parsed);
    if (!validated.success) return [];
    return validated.data;
  } catch {
    return [];
  }
}

/**
 * Replace the full SoT-bindings list. The Zod schema runs at the call
 * boundary — invalid input throws, matching the API surface's PUT 400
 * contract (§10.6) without forcing the route layer to re-validate.
 *
 * Returns the parsed (canonicalized) array so the caller can re-render
 * management.md from a single trusted source instead of round-tripping
 * through `readSotBindings`.
 */
export function writeSotBindings(
  db: Database.Database,
  next: SotBindings,
): SotBindings {
  const parsed = sotBindingsSchema.parse(next);
  db.prepare(
    `INSERT INTO settings (key, value_json, updated_at)
     VALUES (?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(key) DO UPDATE SET
       value_json = excluded.value_json,
       updated_at = CURRENT_TIMESTAMP`,
  ).run(SOT_BINDINGS_SETTINGS_KEY, JSON.stringify(parsed));
  return parsed;
}
