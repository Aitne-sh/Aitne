/**
 * Browser Automation B-4 site config — per-`site_key` enable flag +
 * per-day caps. Plus the global B-4 master toggle stored in
 * `runtime_state`.
 *
 * MANAGED_CHROMIUM_IMPLEMENTATION_PLAN.md §17.8 / §13 steps 55, 59.
 *
 * The handler reads `getB4Enabled()` first — if false the runner-level
 * outcome is `purchase_b4_disabled` before any DB write. Then it reads
 * `getSiteB4Config(siteKey)` to confirm the site has been opted-in by
 * the user via the dashboard. The atomic cap enforcement lives in
 * `browser-automation-purchase-tokens-store.issuePurchaseToken` — this
 * module is the CRUD surface for the dashboard.
 *
 * Excluded from the 100% coverage gate — prepared statements + runtime
 * state KV reads.
 */

import type Database from "better-sqlite3";

import {
  B4_DEFAULT_DAILY_SPEND_CAP_MINOR,
  B4_DEFAULT_DAILY_TOKEN_CAP,
  MANAGED_CHROMIUM_B4_ENABLED_KEY,
} from "../services/browser-history/managed-chromium/types.js";
import { readRuntimeState, writeRuntimeState } from "./runtime-state.js";

export interface B4SiteConfigRow {
  siteKey: string;
  enabled: boolean;
  currency: string;
  dailyTokenCap: number;
  dailySpendCapMinor: number;
  perTxCapMinorOverride: number | null;
  updatedAt: number;
}

interface B4SiteConfigDbRow {
  site_key: string;
  enabled: number;
  currency: string;
  daily_token_cap: number;
  daily_spend_cap_minor: number;
  per_tx_cap_minor_override: number | null;
  updated_at: number;
}

function fromDbRow(row: B4SiteConfigDbRow): B4SiteConfigRow {
  return {
    siteKey: row.site_key,
    enabled: row.enabled === 1,
    currency: row.currency,
    dailyTokenCap: row.daily_token_cap,
    dailySpendCapMinor: row.daily_spend_cap_minor,
    perTxCapMinorOverride: row.per_tx_cap_minor_override,
    updatedAt: row.updated_at,
  };
}

/** Read the global B-4 master toggle. Off (false) when the row is
 *  absent — that's the default for every install. The value is
 *  persisted as JSON-encoded boolean so future shape extensions
 *  (e.g., enabled-since-when, enabled-by-which-user) can attach
 *  without a key rename. */
export function getB4Enabled(db: Database.Database): boolean {
  const raw = readRuntimeState<boolean>(db, MANAGED_CHROMIUM_B4_ENABLED_KEY);
  return raw === true;
}

/** Atomic write of the global toggle. The dashboard's enable-modal
 *  flow flips this to true AFTER the user clicks through the
 *  experimental-danger acknowledgement. */
export function setB4Enabled(db: Database.Database, enabled: boolean): void {
  writeRuntimeState(db, MANAGED_CHROMIUM_B4_ENABLED_KEY, enabled);
}

export function getSiteB4Config(
  db: Database.Database,
  siteKey: string,
): B4SiteConfigRow | null {
  const row = db
    .prepare<[string], B4SiteConfigDbRow>(
      `SELECT site_key, enabled, currency, daily_token_cap,
              daily_spend_cap_minor, per_tx_cap_minor_override, updated_at
         FROM browser_automation_b4_site_config
        WHERE site_key = ?`,
    )
    .get(siteKey);
  return row ? fromDbRow(row) : null;
}

export function listSiteB4Configs(db: Database.Database): B4SiteConfigRow[] {
  const rows = db
    .prepare<[], B4SiteConfigDbRow>(
      `SELECT site_key, enabled, currency, daily_token_cap,
              daily_spend_cap_minor, per_tx_cap_minor_override, updated_at
         FROM browser_automation_b4_site_config
        ORDER BY site_key`,
    )
    .all();
  return rows.map(fromDbRow);
}

export interface UpsertB4SiteConfigInput {
  siteKey: string;
  enabled: boolean;
  currency: string;
  dailyTokenCap?: number;
  dailySpendCapMinor?: number;
  perTxCapMinorOverride?: number | null;
  updatedAt: number;
}

/**
 * INSERT OR REPLACE the per-site row. The route layer validates the
 * cap shapes (Zod) before calling; the schema's CHECK constraints
 * are the structural floor.
 *
 * The currency field is meaningful — the issuance path refuses any
 * workflow whose `params.currency` does not equal the configured
 * currency. Changing the currency mid-config is permitted (the
 * dashboard surfaces a confirmation when the user does so); the
 * audit row on `browser_automation_workflows` carries the
 * `currency_mismatch` cancel reason if a stale in-flight token hits
 * the new shape.
 */
export function upsertSiteB4Config(
  db: Database.Database,
  input: UpsertB4SiteConfigInput,
): B4SiteConfigRow {
  const tokenCap = input.dailyTokenCap ?? B4_DEFAULT_DAILY_TOKEN_CAP;
  const spendCap = input.dailySpendCapMinor ?? B4_DEFAULT_DAILY_SPEND_CAP_MINOR;
  const perTxOverride =
    input.perTxCapMinorOverride === undefined
      ? null
      : input.perTxCapMinorOverride;
  db.prepare(
    `INSERT INTO browser_automation_b4_site_config
       (site_key, enabled, currency, daily_token_cap,
        daily_spend_cap_minor, per_tx_cap_minor_override, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (site_key) DO UPDATE SET
       enabled = excluded.enabled,
       currency = excluded.currency,
       daily_token_cap = excluded.daily_token_cap,
       daily_spend_cap_minor = excluded.daily_spend_cap_minor,
       per_tx_cap_minor_override = excluded.per_tx_cap_minor_override,
       updated_at = excluded.updated_at`,
  ).run(
    input.siteKey,
    input.enabled ? 1 : 0,
    input.currency,
    tokenCap,
    spendCap,
    perTxOverride,
    input.updatedAt,
  );
  const row = getSiteB4Config(db, input.siteKey);
  if (!row) {
    throw new Error("upsertSiteB4Config: post-upsert lookup missing");
  }
  return row;
}

/**
 * Delete the row. Called by the dashboard's "Disable B-4" destructive
 * flow alongside the global toggle reset. After deletion the site
 * cannot mint tokens until the user re-enables it.
 */
export function deleteSiteB4Config(
  db: Database.Database,
  siteKey: string,
): number {
  const result = db
    .prepare(
      `DELETE FROM browser_automation_b4_site_config
        WHERE site_key = ?`,
    )
    .run(siteKey);
  return result.changes;
}
