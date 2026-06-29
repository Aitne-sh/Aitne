/**
 * Per-site authenticated-session state store for Instance A
 * (Phase B-2.5).
 *
 * MANAGED_CHROMIUM_IMPLEMENTATION_PLAN.md §16.7.
 *
 * Two `runtime_state` keys per site:
 *   - `managed_chromium.sites.<siteKey>`            — persistent connection
 *     record. Created by the bootstrap finalize path; read by the
 *     workflow runner to decide `site_not_connected` vs proceed.
 *   - `managed_chromium.site_bootstrap.<siteKey>`   — transient sign-in
 *     handle. Created when the user clicks "Connect <site>"; cleared
 *     by finalize / disconnect / orphan-reap.
 *
 * No new tables. The §16.7 doc commits explicitly to "All B-2.5 state
 * fits in runtime_state".
 */

import type Database from "better-sqlite3";
import { z } from "zod";

import { createLogger } from "../logging.js";
import {
  deleteRuntimeState,
  readRuntimeState,
  writeRuntimeState,
} from "./runtime-state.js";

const logger = createLogger("managed-chromium-sites-store");

const SITE_KEY_REGEX = /^[a-z][a-z0-9_]*$/;
const SITES_KEY_PREFIX = "managed_chromium.sites.";
const SITE_BOOTSTRAP_KEY_PREFIX = "managed_chromium.site_bootstrap.";

/**
 * Validate a `siteKey` before composing a runtime_state row key —
 * registry validation guarantees this for shipping sites, this is the
 * defence-in-depth path-shape contract for anything that builds the
 * composite runtime_state key from external input (route params).
 */
function assertSiteKey(siteKey: string): void {
  if (!SITE_KEY_REGEX.test(siteKey)) {
    throw new Error(
      `managed-chromium-sites-store: siteKey "${siteKey}" violates naming convention`,
    );
  }
}

export function siteConnectionKey(siteKey: string): string {
  assertSiteKey(siteKey);
  return `${SITES_KEY_PREFIX}${siteKey}`;
}

export function siteBootstrapKey(siteKey: string): string {
  assertSiteKey(siteKey);
  return `${SITE_BOOTSTRAP_KEY_PREFIX}${siteKey}`;
}

/**
 * Persistent per-site connection record. Created by the bootstrap
 * finalize path; cleared by disconnect. The `lastWorkflowAt` tick is
 * advanced by the workflow runner on every successful auth-variant run
 * so the compromise-detection §16.6 filesystem watcher has a
 * cross-check timestamp.
 */
export interface SiteConnection {
  /** Schema version for forward-compat. */
  schemaVersion: 1;
  /** Epoch ms of the bootstrap finalize. Drives the
   *  `sessionMaxAgeDays` freshness floor in the workflow runner. */
  connectedAt: number;
  /** Display label captured from the signed-in page (e.g., "Hello,
   *  Alice" → "Alice"). Optional — some sites do not expose a
   *  readable identifier in the public DOM, and the dashboard
   *  surfaces just "Connected" in that case. */
  accountLabel: string | null;
  /** Epoch ms of the most recent successful auth-variant workflow
   *  run for this site. Null until the first successful run. */
  lastWorkflowAt: number | null;
}

/** Transient bootstrap state — UI Chromium running interactively. */
export interface SiteBootstrap {
  /** PID of the UI Chromium spawned for sign-in. */
  pid: number;
  /** Epoch ms past which the reaper SIGKILLs the orphan PID. */
  deadlineAt: number;
  /** True when this bootstrap is a reauth (reuses the existing
   *  profile dir, may auto-sign-in via persistent cookies). */
  reauth: boolean;
  /** Kernel-assigned loopback port the UI Chromium's CDP listens on.
   *  The status probe and the finalize check connect to this port via
   *  Playwright `connectOverCDP` to verify the per-site
   *  `signedInSelector` resolves. Loopback-only by Chromium's CDP
   *  default; the per-cycle launcher pins `--remote-debugging-address=
   *  127.0.0.1` (defence-in-depth, see `INSTANCE_A_SHARED_FLAGS`). */
  cdpPort: number;
}

const siteConnectionSchema = z.object({
  schemaVersion: z.literal(1),
  connectedAt: z.number().int().nonnegative(),
  accountLabel: z.string().max(120).nullable(),
  lastWorkflowAt: z.number().int().nonnegative().nullable(),
});

const siteBootstrapSchema = z.object({
  pid: z.number().int().positive(),
  deadlineAt: z.number().int().nonnegative(),
  reauth: z.boolean(),
  cdpPort: z.number().int().min(1).max(65535),
});

/**
 * Read the persistent connection record for `siteKey`. Returns null
 * when the row is absent or fails schema validation — a corrupt row is
 * treated as "never connected" so the runner reports
 * `site_not_connected` and the dashboard prompts a fresh sign-in. The
 * profile dir is unaffected by the read; only the metadata row is
 * discarded.
 */
export function readSiteConnection(
  db: Database.Database,
  siteKey: string,
): SiteConnection | null {
  const raw = readRuntimeState<unknown>(db, siteConnectionKey(siteKey));
  if (raw == null) return null;
  const parsed = siteConnectionSchema.safeParse(raw);
  if (!parsed.success) {
    logger.warn(
      { issues: parsed.error.issues, siteKey },
      "managed_chromium site connection row parse failed; treating as disconnected",
    );
    return null;
  }
  return parsed.data;
}

export function writeSiteConnection(
  db: Database.Database,
  siteKey: string,
  value: SiteConnection,
): void {
  const validated = siteConnectionSchema.parse(value);
  writeRuntimeState(db, siteConnectionKey(siteKey), validated);
}

export function clearSiteConnection(db: Database.Database, siteKey: string): void {
  deleteRuntimeState(db, siteConnectionKey(siteKey));
}

/**
 * Atomic read-modify-write helper used by the runner to advance
 * `lastWorkflowAt`. Caller's mutator receives a shallow copy and
 * returns the new value (or void to mutate in place). Writes the
 * result through the schema so an accidentally-out-of-shape update
 * fails fast in tests.
 */
export function updateSiteConnection(
  db: Database.Database,
  siteKey: string,
  mutate: (current: SiteConnection) => SiteConnection | void,
): SiteConnection | null {
  const current = readSiteConnection(db, siteKey);
  if (!current) return null;
  const draft: SiteConnection = { ...current };
  const next = mutate(draft) ?? draft;
  const validated = siteConnectionSchema.parse(next);
  writeRuntimeState(db, siteConnectionKey(siteKey), validated);
  return validated;
}

export function readSiteBootstrap(
  db: Database.Database,
  siteKey: string,
): SiteBootstrap | null {
  const raw = readRuntimeState<unknown>(db, siteBootstrapKey(siteKey));
  if (raw == null) return null;
  const parsed = siteBootstrapSchema.safeParse(raw);
  if (!parsed.success) {
    logger.warn(
      { issues: parsed.error.issues, siteKey },
      "managed_chromium site bootstrap row parse failed; treating as idle",
    );
    return null;
  }
  return parsed.data;
}

export function writeSiteBootstrap(
  db: Database.Database,
  siteKey: string,
  value: SiteBootstrap,
): void {
  const validated = siteBootstrapSchema.parse(value);
  writeRuntimeState(db, siteBootstrapKey(siteKey), validated);
}

export function clearSiteBootstrap(db: Database.Database, siteKey: string): void {
  deleteRuntimeState(db, siteBootstrapKey(siteKey));
}

/**
 * Enumerate every persisted (connection row, siteKey) pair. Used by
 * the supervisor's orphan reaper to sweep stale bootstrap PIDs across
 * every connected site without needing a registry import (the reaper
 * cleans up whatever rows happen to exist, including rows for sites
 * that were removed from the registry in a later release).
 *
 * Returns rows in alphabetical site-key order so output is stable for
 * tests and audit logs.
 */
export function listSiteConnectionKeys(db: Database.Database): string[] {
  let rows: ReadonlyArray<{ key: string }>;
  try {
    rows = db
      .prepare(
        `SELECT key FROM runtime_state
         WHERE key LIKE ?
         ORDER BY key ASC`,
      )
      .all(`${SITES_KEY_PREFIX}%`) as ReadonlyArray<{ key: string }>;
  } catch (err) {
    logger.error({ err }, "site-connection enumeration failed");
    return [];
  }
  const out: string[] = [];
  for (const { key } of rows) {
    const siteKey = key.slice(SITES_KEY_PREFIX.length);
    if (SITE_KEY_REGEX.test(siteKey)) out.push(siteKey);
  }
  return out;
}

export function listSiteBootstrapKeys(db: Database.Database): string[] {
  let rows: ReadonlyArray<{ key: string }>;
  try {
    rows = db
      .prepare(
        `SELECT key FROM runtime_state
         WHERE key LIKE ?
         ORDER BY key ASC`,
      )
      .all(`${SITE_BOOTSTRAP_KEY_PREFIX}%`) as ReadonlyArray<{ key: string }>;
  } catch (err) {
    logger.error({ err }, "site-bootstrap enumeration failed");
    return [];
  }
  const out: string[] = [];
  for (const { key } of rows) {
    const siteKey = key.slice(SITE_BOOTSTRAP_KEY_PREFIX.length);
    if (SITE_KEY_REGEX.test(siteKey)) out.push(siteKey);
  }
  return out;
}
