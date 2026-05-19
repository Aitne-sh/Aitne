import type Database from "better-sqlite3";
import { createLogger } from "../logging.js";

const logger = createLogger("runtime-state");

export function readRuntimeState<T>(
  db: Database.Database,
  key: string,
): T | null {
  let row: { value_json: string } | undefined;
  try {
    row = db.prepare(
      "SELECT value_json FROM runtime_state WHERE key = ?",
    ).get(key) as { value_json: string } | undefined;
  } catch (err) {
    logger.error({ err, key }, "runtime_state read failed");
    return null;
  }
  if (!row) return null;
  try {
    return JSON.parse(row.value_json) as T;
  } catch (err) {
    // Corrupt JSON is distinct from a missing row. Surfacing this lets
    // operators notice a corrupted degraded-mode flag or setup latch
    // before the silent-null fallback flips behaviour (e.g., re-running
    // setup or letting writes through against a broken vault).
    logger.error({ err, key }, "runtime_state value_json parse failed (corrupt row)");
    return null;
  }
}

export function writeRuntimeState(
  db: Database.Database,
  key: string,
  value: unknown,
): void {
  db.prepare(
    `INSERT INTO runtime_state (key, value_json, updated_at)
     VALUES (?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(key) DO UPDATE SET
       value_json = excluded.value_json,
       updated_at = CURRENT_TIMESTAMP`,
  ).run(key, JSON.stringify(value));
}

export function deleteRuntimeState(
  db: Database.Database,
  key: string,
): void {
  db.prepare("DELETE FROM runtime_state WHERE key = ?").run(key);
}

/**
 * Management Mode degraded-mode helpers (plan §5.4).
 *
 * The daemon enters degraded mode when `vaultMode === "obsidian"` but
 * `primaryVaultPath` is unreachable (missing, not a directory, not writable)
 * either at startup or mid-run. While degraded:
 *   - context API write AND read handlers return 503.
 *   - dashboard `/api/health` reports `status: "degraded"`.
 *   - schedulers/observers skip ticks.
 *
 * The state persists across restarts via `runtime_state` so the dashboard
 * can surface the banner on first page load.
 */
export const DEGRADED_MODE_KEY = "management_mode.degraded";

export interface DegradedModeState {
  reason: string;
  path: string | null;
  since: string; // ISO timestamp
}

export function setDegradedMode(
  db: Database.Database,
  state: DegradedModeState,
): void {
  writeRuntimeState(db, DEGRADED_MODE_KEY, state);
}

export function getDegradedMode(
  db: Database.Database,
): DegradedModeState | null {
  return readRuntimeState<DegradedModeState>(db, DEGRADED_MODE_KEY);
}

export function isDegraded(db: Database.Database): boolean {
  return getDegradedMode(db) !== null;
}

export function clearDegradedMode(db: Database.Database): void {
  deleteRuntimeState(db, DEGRADED_MODE_KEY);
}

/**
 * Latched "setup completed" marker (Management Mode bootstrap bypass).
 *
 * Written the first time `runVaultHealthProbe` observes
 * `rules/management.md` in either the fallback or primary vault
 * location. It stays latched during normal operation — a user whose
 * vault later becomes unreachable should enter degraded mode, NOT fall
 * back into bootstrapping where the 503 gate is disabled. Explicit reset
 * paths such as Danger Zone context wipe may clear it so the setup wizard
 * can run again. Without this latch the probe would race: mid-migration
 * vault deletion looks identical to "never set up" on a read-only check.
 */
export const SETUP_COMPLETED_KEY = "management_mode.setup_completed";

export function isSetupCompleted(db: Database.Database): boolean {
  return readRuntimeState<boolean>(db, SETUP_COMPLETED_KEY) === true;
}

export function markSetupCompleted(db: Database.Database): void {
  writeRuntimeState(db, SETUP_COMPLETED_KEY, true);
}

export function clearSetupCompleted(db: Database.Database): void {
  deleteRuntimeState(db, SETUP_COMPLETED_KEY);
}

/**
 * Owner-initiated pause (messaging bang-commands `!stop` / `!start`).
 *
 * Persisted via runtime_state so a daemon restart while paused does not
 * silently resume autonomous work — `isAutonomousAllowed()` consults
 * `isUserPaused(db)` on every call.
 */
export const USER_PAUSED_KEY = "agent.user_paused";

export interface UserPausedState {
  since: string; // ISO timestamp
  source: string; // "!stop" | future "/api/agent/pause" etc.
  byPlatform: string; // event.platform — surfaced in audit detail
}

export function setUserPaused(
  db: Database.Database,
  state: UserPausedState,
): void {
  writeRuntimeState(db, USER_PAUSED_KEY, state);
}

export function getUserPaused(
  db: Database.Database,
): UserPausedState | null {
  return readRuntimeState<UserPausedState>(db, USER_PAUSED_KEY);
}

export function clearUserPaused(db: Database.Database): void {
  deleteRuntimeState(db, USER_PAUSED_KEY);
}

export function isUserPaused(db: Database.Database): boolean {
  return getUserPaused(db) !== null;
}
