/**
 * Development-mode singleton pointer — the runtime_state latch that mirrors
 * the `SetupMode` pattern (dispatcher.ts CURRENT_SETUP_MODE_STATE_KEY). It is
 * the FAST intercept signal: the dispatcher keeps `currentDevMode` in memory
 * (checked before any DB read on every DM) and persists it here so a daemon
 * restart can restore it. The authoritative session state lives in the
 * `dev_sessions` table; this pointer only says "a dev session is live, here
 * is its id" so the message handler knows to route into DevMode.
 *
 * At most ONE dev session is active at a time (D5) — the pointer is a single
 * runtime_state row, and creating a second session is refused while it is set.
 */

import type Database from "better-sqlite3";
import {
  deleteRuntimeState,
  readRuntimeState,
  writeRuntimeState,
} from "../../db/runtime-state.js";

export const CURRENT_DEV_MODE_STATE_KEY = "current_dev_mode";

export interface DevModeState {
  /** dev_sessions.id — the authoritative session row. */
  sessionId: string;
  /** The repo being built (repositories.id). */
  repositoryId: string;
  /** Denormalized slug for cheap display / routing without a DB read. */
  slug: string | null;
  /** epoch-ms the owner entered dev mode. */
  enteredAt: number;
}

/** Restore the pointer at boot (dispatcher loadPersistedDevMode). Returns null
 *  when no dev session is latched. */
export function readDevModeState(db: Database.Database): DevModeState | null {
  const raw = readRuntimeState<DevModeState>(db, CURRENT_DEV_MODE_STATE_KEY);
  if (!raw || typeof raw.sessionId !== "string" || typeof raw.repositoryId !== "string") {
    return null;
  }
  return {
    sessionId: raw.sessionId,
    repositoryId: raw.repositoryId,
    slug: typeof raw.slug === "string" ? raw.slug : null,
    enteredAt: typeof raw.enteredAt === "number" ? raw.enteredAt : 0,
  };
}

export function writeDevModeState(db: Database.Database, state: DevModeState): void {
  writeRuntimeState(db, CURRENT_DEV_MODE_STATE_KEY, state);
}

export function clearDevModeState(db: Database.Database): void {
  deleteRuntimeState(db, CURRENT_DEV_MODE_STATE_KEY);
}

/** True when a dev session is latched (fast presence check for callers that
 *  only need yes/no). */
export function isDevModeActive(db: Database.Database): boolean {
  return readDevModeState(db) !== null;
}
