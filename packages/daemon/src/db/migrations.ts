import type Database from "better-sqlite3";
import { createLogger } from "../logging.js";
import {
  MIGRATION_ID as CONTEXT_VAULT_MIGRATION_ID,
  runContextVaultRestructure,
} from "./migrations/context-vault-restructure.js";

const logger = createLogger("migrations");

/**
 * Runtime context handed to migrations whose body needs more than the
 * `db` handle alone. CONTEXT_VAULT_REDESIGN_PLAN.md §11.8: the vault
 * restructure needs `dataDir` (out-of-contextDir source paths) and
 * `contextDir` (the new destination root) to drive the manifest walker.
 *
 * Existing migrations (0001-0003) don't read this; their `up()` simply
 * ignores the second argument. New migrations that DO read it should
 * defensively check for presence and throw a self-describing error if
 * the caller forgot to thread the context in (the runner exposes a
 * matching error message at the registration site).
 */
export interface MigrationContext {
  readonly db: Database.Database;
  readonly dataDir: string;
  readonly contextDir: string;
}

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
  /**
   * Idempotent upgrade body. Runs inside a single transaction together
   * with the bookkeeping row write. Throw to abort startup — the
   * transaction rolls back.
   *
   * The optional `ctx` argument carries `dataDir` and `contextDir` for
   * migrations whose body needs to touch the filesystem. Existing
   * migrations ignore it; new ones MUST defensively check for presence
   * when their body reads from it.
   */
  up(db: Database.Database, ctx?: MigrationContext): void;
}

/**
 * Pre-built migration entry for the context-vault restructure
 * (CONTEXT_VAULT_REDESIGN_PLAN.md). Defined above MIGRATIONS so the
 * forward reference works at module load (const declarations live in
 * the TDZ until their line executes).
 */
export const CONTEXT_VAULT_MIGRATION_ENTRY: Migration = {
  id: CONTEXT_VAULT_MIGRATION_ID,
  description:
    "CONTEXT_VAULT_REDESIGN_PLAN.md (v0.1.x→next) — reshape "
    + "~/.personal-agent/context/ into six authority classes (identity, "
    + "state, plans, journal, knowledge, policies); move wiki/ and "
    + "integrations.md under the vault root; rewrite wiki_workspaces.root_path "
    + "for kind='internal'; rebuild fts_wiki; rewrite md_file_snapshots / "
    + "entities / entity_source_keys / managed_tasks path columns (V13); "
    + "rewrite JSON-blob path references in agent_actions / observations / "
    + "messages (V17); write .context-vault-version marker.",
  up(db, ctx) {
    if (!ctx) {
      throw new Error(
        `Migration ${CONTEXT_VAULT_MIGRATION_ID} requires MigrationContext (dataDir + contextDir); caller passed only db.`,
      );
    }
    runContextVaultRestructure({
      db,
      dataDir: ctx.dataDir,
      contextDir: ctx.contextDir,
    });
  },
};

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
  {
    id: "0004-drop-browser-automation-approvals",
    description:
      "BROWSER_TASK_REDESIGN_PLAN.md §6.8 / Phase 6 (v0.1.x→next) — drop "
      + "`browser_automation_approvals`. The B-3 single-use approval-token "
      + "gate is retired alongside the workflow runner + frozen registry; "
      + "the replacement chokepoint for in-turn user confirmations is "
      + "`browser_task_clarifications` (mid-task ask_user) + "
      + "`browser_task_final_confirm_tokens` (final-confirm DM token). "
      + "The B-4 purchase-confirmation path is unaffected — it continues "
      + "through `browser_automation_purchase_tokens` + `purchase-handler.ts`. "
      + "The audit table `browser_automation_workflows` is INTENTIONALLY "
      + "retained so users with prior B-2 / B-2.5 / B-3 audit rows can still "
      + "query their history; new audit lives in `browser_task_action_log`.",
    up(db) {
      // Idempotent: on a fresh install the table never existed (we
      // dropped its CREATE from `schema.ts` in this same plan revision),
      // so the existence check short-circuits and the migration body is
      // a no-op. The `schema_migrations` row is still inserted by the
      // runner, so subsequent boots won't re-evaluate.
      if (!tableExists(db, "browser_automation_approvals")) return;
      db.exec("DROP TABLE browser_automation_approvals");
    },
  },
  {
    id: "0005-drop-browser-automation-allowlist",
    description:
      "BROWSER_TASK_REDESIGN_PLAN.md §9 Phase 6.5 follow-up (v0.1.x→next) — "
      + "drop `browser_automation_allowlist`. The per-domain user opt-in "
      + "fronted the workflow-runner's deny-on-unknown gate; both the "
      + "runner and the four `/api/browser-automation/allowlist*` routes "
      + "were deleted in Phase 6, leaving the table with zero callers. "
      + "The browser-task surface uses the site-registry's "
      + "`allowedHostPattern` plus per-request `extraAllowedHosts` (§14.1 "
      + "composition rules) as its allowlist; the registry's structural "
      + "fence supersedes the runtime DB allowlist entirely. The store "
      + "helpers `listAllowlistEntries` / `upsertAllowlistEntry` / "
      + "`removeAllowlistEntry` / `isDomainAllowed` were removed in the "
      + "same Phase 6.5 pass.",
    up(db) {
      if (!tableExists(db, "browser_automation_allowlist")) return;
      db.exec("DROP TABLE browser_automation_allowlist");
    },
  },
  // CONTEXT_VAULT_REDESIGN_PLAN.md PR-3 — registered after the
  // coordinated `CONTEXT_RELATIVE_PATHS` rewrite, structural-matcher
  // sweep, and `agent-assets/templates/` restructure all landed. On
  // first boot after upgrade the runner moves legacy files into the
  // six-class layout, rewrites DB path keys, and stamps the
  // `.context-vault-version` marker. The body is idempotent and the
  // verification step rolls back if anything is off.
  CONTEXT_VAULT_MIGRATION_ENTRY,
  {
    id: "0006-message-dm-budget-bump",
    description:
      "(v0.1.x→next) — raise the message.dm per-turn budget ceiling to the "
      + "new $5.00 base default for upgrading installs still on the seeded "
      + "default. DM turns re-process the full conversation history every "
      + "turn and routinely run $0.70-0.80 on Sonnet; legitimate multi-step "
      + "turns (e.g. dispatching a browser task) tipped over $1.00 mid-turn "
      + "and surfaced a per-turn-budget quota error to the user even when "
      + "the work succeeded. Backend-aware: applyDefaultPresets stores the "
      + "post-hoc-scaled budget (codex/gemini medium x1.5), so the OLD "
      + "default is $1.00 on claude/opencode and $1.50 on codex/gemini, and "
      + "the NEW default is the $5.00 base scaled the same way -> $5.00 / "
      + "$7.50. Fresh installs already get the new value from the schema "
      + "seed + the per-process envelope-overrides map; this migration only "
      + "touches pre-existing installs. Gated so it ONLY moves preset rows "
      + "still at the OLD per-backend default — operator-pinned rows "
      + "(updated_by='user') and rows already at a custom value are left "
      + "untouched. Idempotent: after the bump no row sits in the old band, "
      + "and the recorded id short-circuits a re-run anyway.",
    up(db) {
      // Empty-DB safety (e.g. the runner's own unit tests run on a bare
      // :memory: db): if applySchema never ran, the table is absent — the
      // runner still records the id so a later boot does not re-evaluate.
      if (!tableExists(db, "process_backend_config")) return;
      // The NEW per-backend value mirrors what `resolveDefaultBindingFor`
      // now produces for message.dm: the $5.00 base x the medium post-hoc
      // factor (1.5 for codex/gemini, 1.0 for claude/opencode). The 7.50
      // literal is that product at migration time — a migration is a
      // point-in-time snapshot, so the literal is correct even if the
      // factor later changes. The old-default bands ([0.99,1.01] /
      // [1.49,1.51]) keep us from clobbering a row already moved to a
      // custom value while still tolerating float dust.
      db.prepare(
        `UPDATE process_backend_config
            SET max_budget_usd = CASE
              WHEN main_backend IN ('codex', 'gemini') THEN 7.5
              ELSE 5.0
            END
          WHERE process_key = 'message.dm'
            AND updated_by = 'preset'
            AND (
              (main_backend IN ('codex', 'gemini')
                 AND max_budget_usd >= 1.49 AND max_budget_usd <= 1.51)
              OR (main_backend NOT IN ('codex', 'gemini')
                 AND max_budget_usd >= 0.99 AND max_budget_usd <= 1.01)
            )`,
      ).run();
    },
  },
];

export interface MigrationRunResult {
  /** Ids applied during this call, in execution order. Empty on steady state. */
  applied: string[];
}

export interface RunMigrationsOptions {
  /** Vault filesystem context — required for any migration whose body
   *  reads the filesystem. Migrations that only mutate SQLite ignore it.
   *  Omitted by the legacy single-arg call shape that pre-dates the
   *  CONTEXT_VAULT_REDESIGN_PLAN runner — those callers will only get a
   *  hard error if a migration that needs the context is registered. */
  readonly ctx?: Omit<MigrationContext, "db">;
  /** Override the migration list. Tests pass an explicit list to keep
   *  behaviour deterministic without mutating module state. */
  readonly migrations?: readonly Migration[];
}

/**
 * Ensure the `schema_migrations` bookkeeping table exists, then apply every
 * registered migration whose id is not already recorded. Each migration
 * runs in a single transaction with its bookkeeping insert so a partial
 * apply is impossible. A failing migration throws (after rollback) — the
 * caller (`initDatabase` in `bootstrap/db.ts`) is expected to surface that
 * as a fatal startup error.
 *
 * The two-arg shape `runMigrations(db, migrations)` is preserved for
 * legacy tests; production callers pass `runMigrations(db, { ctx, migrations })`.
 */
export function runMigrations(
  db: Database.Database,
  optionsOrMigrations: RunMigrationsOptions | readonly Migration[] = MIGRATIONS,
): MigrationRunResult {
  const options: RunMigrationsOptions = Array.isArray(optionsOrMigrations)
    ? { migrations: optionsOrMigrations as readonly Migration[] }
    : (optionsOrMigrations as RunMigrationsOptions);
  const migrations = options.migrations ?? MIGRATIONS;
  const ctx: MigrationContext | undefined = options.ctx
    ? { db, dataDir: options.ctx.dataDir, contextDir: options.ctx.contextDir }
    : undefined;
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
      migration.up(db, ctx);
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
