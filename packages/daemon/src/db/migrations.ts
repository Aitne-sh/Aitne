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
export const MIGRATIONS: readonly Migration[] = [];

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
