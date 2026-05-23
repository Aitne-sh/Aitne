import type Database from "better-sqlite3";
import { createLogger } from "../logging.js";

const logger = createLogger("migrations");

/**
 * A schema migration. Each migration must be:
 *
 *   - Idempotent — safe to call against a fresh DB where `applySchema()` has
 *     already produced the latest schema. Gate every ALTER / CREATE behind
 *     `columnExists` / `tableExists` / `indexExists`. On a fresh DB the body
 *     simply finds nothing to do and the runner still records the id so it
 *     won't re-run on subsequent boots.
 *   - Forward-only. Aitne is a single-user local app; there is no down path.
 *     To unwind a migration, ship a new migration that reverses it.
 *   - Append-only. Never reorder, never delete, never rewrite an applied id.
 *     `schema_migrations` is keyed on `id` and the runner skips applied ids
 *     by string match.
 *
 * Why this sits next to (and after) `applySchema(db)`:
 *   `applySchema` is the consolidated CREATE ... IF NOT EXISTS script in
 *   `schema.ts`. It handles every brand-new install in one shot. Migrations
 *   are for the things CREATE IF NOT EXISTS can't:
 *     - ALTER TABLE ADD COLUMN on a pre-existing table
 *     - CREATE INDEX on columns added by an earlier migration
 *     - One-shot data backfills / runtime_state seeds
 *     - DROP TABLE / RENAME COLUMN for schema cleanups
 */
export interface Migration {
  /** Stable, never-reused identifier. Pick a zero-padded numeric prefix
   *  (e.g. `"0001-add-foo-column"`) so lexicographic ordering survives
   *  forever. */
  readonly id: string;
  /** Human-readable summary for logs. */
  readonly description: string;
  /** Idempotent upgrade body. Runs inside a single transaction together
   *  with the bookkeeping row write. Throw to abort startup — the
   *  transaction rolls back. */
  up(db: Database.Database): void;
}

/**
 * Registered migrations, applied in array order. Append new entries; never
 * reorder, never delete. Empty by default — the first time an upgrade needs
 * ALTER TABLE or a data backfill, add a row here with the next sequential
 * id prefix.
 */
export const MIGRATIONS: readonly Migration[] = [
  {
    id: "0001-browser-pending-offers-add-offered-kind",
    description:
      "BROWSER_HISTORY_INTEGRATION_PLAN seventh-pass (v0.1.8→next) — widen "
      + "`browser_pending_offers.kind` CHECK constraint to include 'offered'. "
      + "SQLite can't ALTER a CHECK in place, so we rebuild the table: "
      + "create *_new with the wider constraint, copy rows, drop, rename.",
    up(db) {
      // Idempotent: fresh installs already get the wider CHECK from
      // schema.ts. We detect that by inspecting the table definition:
      // PRAGMA table_info doesn't surface CHECK constraints, but
      // sqlite_master.sql does. If the wider constraint is already
      // present, skip the rebuild.
      if (!tableExists(db, "browser_pending_offers")) return;
      const row = db
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type='table' AND name='browser_pending_offers'",
        )
        .get() as { sql: string | null } | undefined;
      if (row?.sql && row.sql.includes("'offered'")) {
        // Wider constraint already present; nothing to do.
        return;
      }
      db.exec(`
        CREATE TABLE browser_pending_offers_new (
          slug TEXT NOT NULL,
          kind TEXT NOT NULL
            CHECK (kind IN ('offered', 'research_assist', 'wiki_summary')),
          offered_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL,
          PRIMARY KEY (slug, kind)
        );
        INSERT INTO browser_pending_offers_new (slug, kind, offered_at, expires_at)
          SELECT slug, kind, offered_at, expires_at FROM browser_pending_offers;
        DROP TABLE browser_pending_offers;
        ALTER TABLE browser_pending_offers_new RENAME TO browser_pending_offers;
      `);
    },
  },
  {
    id: "0002-browser-automation-workflows-b3-outcomes",
    description:
      "MANAGED_CHROMIUM_IMPLEMENTATION_PLAN.md Phase B-3 (v0.1.9→next) — "
      + "widen `browser_automation_workflows.outcome` CHECK constraint to "
      + "include the new B-3 statuses ('needs_approval', 'approval_expired', "
      + "'approval_token_invalid', 'payment_path_blocked'). SQLite cannot "
      + "ALTER a CHECK in place, so we rebuild the table: create *_new with "
      + "the wider constraint, copy rows, drop, rename.",
    up(db) {
      // Idempotent: fresh installs already get the wider CHECK from
      // schema.ts. Detect via sqlite_master.sql — if the constraint string
      // already mentions 'needs_approval' the rebuild is unnecessary.
      if (!tableExists(db, "browser_automation_workflows")) return;
      const row = db
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type='table' AND name='browser_automation_workflows'",
        )
        .get() as { sql: string | null } | undefined;
      if (row?.sql && row.sql.includes("'needs_approval'")) {
        return;
      }
      db.exec(`
        CREATE TABLE browser_automation_workflows_new (
          id                INTEGER PRIMARY KEY AUTOINCREMENT,
          workflow_id       TEXT NOT NULL UNIQUE,
          workflow_name     TEXT NOT NULL,
          params_hash       TEXT NOT NULL,
          target_urls       TEXT NOT NULL,
          blocked_requests  TEXT NOT NULL,
          duration_ms       INTEGER NOT NULL,
          outcome           TEXT NOT NULL CHECK (outcome IN (
              'success',
              'unknown_workflow',
              'input_validation_error',
              'output_validation_error',
              'url_not_allowlisted',
              'user_allowlist_blocked',
              'host_not_extractable',
              'rate_limited',
              'site_not_connected',
              'playwright_launch_timeout',
              'playwright_error',
              'timeout',
              'needs_approval',
              'approval_expired',
              'approval_token_invalid',
              'payment_path_blocked'
          )),
          started_at        INTEGER NOT NULL,
          finished_at       INTEGER NOT NULL,
          screenshot_path   TEXT,
          trace_path        TEXT
        );
        INSERT INTO browser_automation_workflows_new
          (id, workflow_id, workflow_name, params_hash, target_urls,
           blocked_requests, duration_ms, outcome,
           started_at, finished_at, screenshot_path, trace_path)
          SELECT id, workflow_id, workflow_name, params_hash, target_urls,
                 blocked_requests, duration_ms, outcome,
                 started_at, finished_at, screenshot_path, trace_path
            FROM browser_automation_workflows;
        DROP TABLE browser_automation_workflows;
        ALTER TABLE browser_automation_workflows_new
          RENAME TO browser_automation_workflows;
        CREATE INDEX IF NOT EXISTS idx_browser_automation_workflows_started_at
          ON browser_automation_workflows(started_at);
        CREATE INDEX IF NOT EXISTS idx_browser_automation_workflows_name
          ON browser_automation_workflows(workflow_name, started_at DESC);
      `);
    },
  },
  {
    id: "0003-browser-automation-workflows-b4-outcomes",
    description:
      "MANAGED_CHROMIUM_IMPLEMENTATION_PLAN.md Phase B-4 (vX.Y→next) — "
      + "widen `browser_automation_workflows.outcome` CHECK constraint to "
      + "include the new B-4 runner-level statuses ('purchase_b4_disabled', "
      + "'purchase_site_not_enabled', 'purchase_pending_exists', "
      + "'purchase_daily_cap_exceeded'). SQLite cannot ALTER a CHECK in "
      + "place, so we rebuild the table: create *_new with the wider "
      + "constraint, copy rows, drop, rename. The new B-4 tables "
      + "(browser_automation_purchase_tokens / _replies / "
      + "browser_automation_b4_site_config / "
      + "browser_automation_purchase_primary_channels) are CREATE IF NOT "
      + "EXISTS in schema.ts and need no migration body — they show up on "
      + "the first boot after the upgrade.",
    up(db) {
      // Idempotent: fresh installs already get the B-4-widened CHECK
      // from schema.ts; the 0002 migration's earlier widening means the
      // sqlite_master.sql for an upgrader from v0.1.9 carries the B-3
      // statuses but not the B-4 ones. Detect via the marker we are
      // adding here — if `purchase_b4_disabled` is already present, the
      // table is at the target shape and the rebuild is unnecessary.
      if (!tableExists(db, "browser_automation_workflows")) return;
      const row = db
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type='table' AND name='browser_automation_workflows'",
        )
        .get() as { sql: string | null } | undefined;
      if (row?.sql && row.sql.includes("'purchase_b4_disabled'")) {
        return;
      }
      db.exec(`
        CREATE TABLE browser_automation_workflows_new (
          id                INTEGER PRIMARY KEY AUTOINCREMENT,
          workflow_id       TEXT NOT NULL UNIQUE,
          workflow_name     TEXT NOT NULL,
          params_hash       TEXT NOT NULL,
          target_urls       TEXT NOT NULL,
          blocked_requests  TEXT NOT NULL,
          duration_ms       INTEGER NOT NULL,
          outcome           TEXT NOT NULL CHECK (outcome IN (
              'success',
              'unknown_workflow',
              'input_validation_error',
              'output_validation_error',
              'url_not_allowlisted',
              'user_allowlist_blocked',
              'host_not_extractable',
              'rate_limited',
              'site_not_connected',
              'playwright_launch_timeout',
              'playwright_error',
              'timeout',
              'needs_approval',
              'approval_expired',
              'approval_token_invalid',
              'payment_path_blocked',
              'purchase_b4_disabled',
              'purchase_site_not_enabled',
              'purchase_pending_exists',
              'purchase_daily_cap_exceeded'
          )),
          started_at        INTEGER NOT NULL,
          finished_at       INTEGER NOT NULL,
          screenshot_path   TEXT,
          trace_path        TEXT
        );
        INSERT INTO browser_automation_workflows_new
          (id, workflow_id, workflow_name, params_hash, target_urls,
           blocked_requests, duration_ms, outcome,
           started_at, finished_at, screenshot_path, trace_path)
          SELECT id, workflow_id, workflow_name, params_hash, target_urls,
                 blocked_requests, duration_ms, outcome,
                 started_at, finished_at, screenshot_path, trace_path
            FROM browser_automation_workflows;
        DROP TABLE browser_automation_workflows;
        ALTER TABLE browser_automation_workflows_new
          RENAME TO browser_automation_workflows;
        CREATE INDEX IF NOT EXISTS idx_browser_automation_workflows_started_at
          ON browser_automation_workflows(started_at);
        CREATE INDEX IF NOT EXISTS idx_browser_automation_workflows_name
          ON browser_automation_workflows(workflow_name, started_at DESC);
      `);
    },
  },
];

export interface MigrationRunResult {
  /** Ids applied during this call, in execution order. Empty on steady state. */
  applied: string[];
}

/**
 * Ensure the `schema_migrations` bookkeeping table exists, then apply every
 * registered migration whose id is not already recorded. Each migration
 * runs in a single transaction with its bookkeeping insert so a partial
 * apply is impossible. A failing migration throws (after rollback) — the
 * caller (`initDatabase` in `bootstrap/db.ts`) is expected to surface that
 * as a fatal startup error.
 *
 * `migrations` defaults to the production-registered list. Tests pass an
 * explicit list to keep behaviour deterministic without mutating module
 * state.
 */
export function runMigrations(
  db: Database.Database,
  migrations: readonly Migration[] = MIGRATIONS,
): MigrationRunResult {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);
  const appliedRows = db
    .prepare<[], { id: string }>("SELECT id FROM schema_migrations")
    .all();
  const applied = new Set<string>(appliedRows.map((row) => row.id));
  const insertApplied = db.prepare(
    "INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)",
  );

  const newlyApplied: string[] = [];
  for (const migration of migrations) {
    if (applied.has(migration.id)) continue;
    const txn = db.transaction(() => {
      migration.up(db);
      insertApplied.run(migration.id, new Date().toISOString());
    });
    try {
      txn();
    } catch (err) {
      logger.error(
        { err, migration: migration.id, description: migration.description },
        "Schema migration failed; startup aborted",
      );
      throw err;
    }
    newlyApplied.push(migration.id);
    logger.info(
      { migration: migration.id, description: migration.description },
      "Applied schema migration",
    );
  }
  return { applied: newlyApplied };
}

// ── Helpers exposed for individual migrations ───────────────────────────────

/** True if `table` exists in `sqlite_master`. */
export function tableExists(db: Database.Database, table: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table);
  return row !== undefined;
}

/**
 * True if `column` exists on `table`. Returns false if the table itself is
 * missing — keeps migration code declarative (no separate existence check
 * for the table when ALTER is gated on a missing column).
 */
export function columnExists(
  db: Database.Database,
  table: string,
  column: string,
): boolean {
  // Validate the identifier first — PRAGMA table_info cannot take a bound
  // parameter, so a non-identifier name would be interpolated raw. We
  // refuse those before any DB lookup so a typo in a migration body fails
  // loudly instead of silently returning false.
  const safeTable = assertIdentifier(table);
  if (!tableExists(db, safeTable)) return false;
  const rows = db
    .prepare<[], { name: string }>(`PRAGMA table_info(${safeTable})`)
    .all();
  return rows.some((row) => row.name === column);
}

/** True if `index` exists in `sqlite_master`. */
export function indexExists(db: Database.Database, index: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?")
    .get(index);
  return row !== undefined;
}

/**
 * PRAGMA table_info does not accept bound parameters — the table name has
 * to be interpolated. Restrict to plain SQL identifiers to keep that safe;
 * a caller passing user input would already be a bug in a migration body.
 */
function assertIdentifier(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`Invalid SQL identifier: ${JSON.stringify(name)}`);
  }
  return name;
}
