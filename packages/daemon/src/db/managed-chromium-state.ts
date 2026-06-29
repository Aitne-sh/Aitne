import type Database from "better-sqlite3";
import { z } from "zod";

import {
  DEFAULT_MANAGED_CHROMIUM_STATE,
  MANAGED_CHROMIUM_STATE_KEY,
  type ManagedChromiumState,
  type ManagedChromiumStateValue,
} from "../services/browser-history/managed-chromium/types.js";
import { createLogger } from "../logging.js";
import {
  deleteRuntimeState,
  readRuntimeState,
  writeRuntimeState,
} from "./runtime-state.js";

const logger = createLogger("managed-chromium-state");

const STATE_VALUES = [
  "off",
  "needs_setup",
  "missing_binary",
  "missing_sandbox",
  "ready",
  "needs_reauth",
  "disconnected",
] as const satisfies readonly ManagedChromiumStateValue[];

const bootstrapSchema = z.object({
  pid: z.number().int().positive(),
  deadlineAt: z.number().int().nonnegative(),
  reauth: z.boolean(),
});

const stateSchema = z.object({
  schemaVersion: z.literal(1),
  enabled: z.boolean(),
  state: z.enum(STATE_VALUES),
  signedInUser: z.string().nullable(),
  lastCheckAt: z.number().int().nonnegative().nullable(),
  lastSyncAt: z.number().int().nonnegative().nullable(),
  recentRowCount: z.number().int().nonnegative().nullable(),
  bootstrap: bootstrapSchema.nullable(),
  // Per-kind DM rate-limit timestamps. Each known kind is optional —
  // an absent key means "never DMed". Modeled as `z.object({...optional})`
  // rather than `z.record(z.enum(...), …)` because the latter requires
  // every enum key to be present in the persisted value to typecheck,
  // which contradicts the in-memory `Partial<Record<…>>` shape.
  lastDmAt: z
    .object({
      healthy: z.number().int().nonnegative().optional(),
      sync_silent: z.number().int().nonnegative().optional(),
      account_changed: z.number().int().nonnegative().optional(),
      corrupt_local_state: z.number().int().nonnegative().optional(),
      signed_out: z.number().int().nonnegative().optional(),
    })
    .default({}),
  consecutiveFailures: z.number().int().nonnegative(),
  pausedUntil: z.number().int().nonnegative().nullable(),
  unsandboxedOptIn: z.boolean(),
});

/**
 * Read the singleton managed-chromium state blob. Returns the canonical
 * default shape when the row is absent or fails schema validation —
 * corrupt rows are treated as "never written" rather than throwing, so a
 * malformed runtime_state row cannot brick the daemon's boot path.
 */
export function readManagedChromiumState(
  db: Database.Database,
): ManagedChromiumState {
  const raw = readRuntimeState<unknown>(db, MANAGED_CHROMIUM_STATE_KEY);
  if (raw == null) return { ...DEFAULT_MANAGED_CHROMIUM_STATE };
  const parsed = stateSchema.safeParse(raw);
  if (!parsed.success) {
    logger.warn(
      { issues: parsed.error.issues },
      "managed_chromium state parse failed; using default shape",
    );
    return { ...DEFAULT_MANAGED_CHROMIUM_STATE };
  }
  return parsed.data;
}

/**
 * Atomic read-modify-write helper. The mutator receives a deep copy and
 * returns the new value (or void to mutate in place); the resulting
 * value is validated through the same schema before persistence so an
 * accidentally-out-of-shape update fails fast in tests.
 */
export function updateManagedChromiumState(
  db: Database.Database,
  mutate: (current: ManagedChromiumState) => ManagedChromiumState | void,
): ManagedChromiumState {
  const current = readManagedChromiumState(db);
  const draft: ManagedChromiumState = {
    ...current,
    bootstrap: current.bootstrap ? { ...current.bootstrap } : null,
    lastDmAt: { ...current.lastDmAt },
  };
  const next = mutate(draft) ?? draft;
  const validated = stateSchema.parse(next);
  writeRuntimeState(db, MANAGED_CHROMIUM_STATE_KEY, validated);
  return validated;
}

/**
 * Reset to the default shape. Called on disconnect and during the
 * Danger-Zone context wipe.
 */
export function clearManagedChromiumState(db: Database.Database): void {
  deleteRuntimeState(db, MANAGED_CHROMIUM_STATE_KEY);
}
