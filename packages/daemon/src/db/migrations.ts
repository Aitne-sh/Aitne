import type Database from "better-sqlite3";
import { existsSync, renameSync } from "node:fs";
import { join } from "node:path";
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
  {
    id: "0007-agent-identity",
    description:
      "AGENT_DEFINITIONS_DESIGN.md §5 (v0.1.8→next) — introduce the Agent-as-"
      + "identity layer. The two new tables (`agents`, `agent_executions`) are "
      + "CREATE IF NOT EXISTS in schema.ts, so a fresh install lands on the "
      + "target state with no DDL here. This migration carries ONLY the "
      + "non-additive part: ALTER `agent_actions` to add the nullable "
      + "`agent_id` stamp column (§5.3) + its `idx_agent_actions_agent` index. "
      + "The column also ships in the schema.ts CREATE body (fresh installs get "
      + "it there), but the INDEX is created ONLY here — never in applySchema — "
      + "because applySchema runs before this migration and a CREATE INDEX on "
      + "agent_actions(agent_id) would throw on a pre-0007 upgrader whose table "
      + "predates the column (upgrade-safety checklist #2). So on a fresh DB the "
      + "ALTER is skipped (columnExists true) while the index branch still runs "
      + "(indexExists false → created); on an upgrader both branches run. Both "
      + "are gated so a re-boot is a no-op; the runner records the id either way. "
      + "`agent_id` carries no foreign key — historical rows stay NULL and an FK "
      + "would complicate the agents-row cascade.",
    up(db) {
      // Empty-DB safety: if applySchema never ran (e.g. a bare :memory: DB in
      // a unit test), the table is absent. columnExists returns false for a
      // missing table, so the guard below would attempt the ALTER and throw.
      // Short-circuit on the table's absence — the runner still records the
      // id so a later boot does not re-evaluate.
      if (!tableExists(db, "agent_actions")) return;
      if (!columnExists(db, "agent_actions", "agent_id")) {
        db.exec("ALTER TABLE agent_actions ADD COLUMN agent_id TEXT");
      }
      if (!indexExists(db, "idx_agent_actions_agent")) {
        db.exec(
          `CREATE INDEX idx_agent_actions_agent
             ON agent_actions(agent_id, started_at DESC)`,
        );
      }
    },
  },
  {
    id: "0008-agent-schedule-backfill-task-prompt",
    description:
      "schedule prompt-required rework (v0.1.8→next) — the dispatcher now reads "
      + "`agent_schedule.task_prompt` as the agent body directly; the legacy "
      + "`task_prompt ?? task_description` fallback was removed. Every insert "
      + "site (user/agent POST + the system schedulers + recurring "
      + "materialization) now sets task_prompt, but rows created by a prior "
      + "version may have task_prompt NULL and relied on the fallback. Backfill "
      + "those from task_description so a still-pending pre-upgrade row keeps "
      + "dispatching a non-empty instruction. Idempotent: only NULL prompts are "
      + "touched, so a fresh DB (rows already carry task_prompt, or table empty) "
      + "and a re-boot are both no-ops.",
    up(db) {
      // Empty-DB safety: a bare :memory: test DB may not have run applySchema.
      if (!tableExists(db, "agent_schedule")) return;
      db.exec(
        "UPDATE agent_schedule SET task_prompt = task_description WHERE task_prompt IS NULL",
      );
    },
  },
  {
    id: "0009-today-refresh-budget-bump",
    description:
      "(v0.1.9→next) — raise the routine.today_refresh per-turn budget "
      + "ceiling from the seeded $0.30 to $0.50 for upgrading installs still "
      + "on the seeded default. The drift-triggered today.md ## User Schedule "
      + "refresh reads up to 200 pending calendar observations and retries the "
      + "section PATCH up to 3x with 30s backoffs when the morning-routine lock "
      + "is held; a busy-calendar drift compounded by that retry loop tipped a "
      + "real run past $0.30 and surfaced BackendQuotaError(max_budget_usd) with "
      + "no fallback (claude is the only binding) — the prior $0.10→$0.30 bump "
      + "did not hold. Backend-aware: applyDefaultPresets stores the post-hoc-"
      + "scaled budget (codex/gemini medium x1.5), so the OLD default is $0.30 "
      + "on claude/opencode and $0.45 on codex/gemini, and the NEW default is "
      + "the $0.50 base scaled the same way -> $0.50 / $0.75. Fresh installs "
      + "already get the new value from the schema seed + the per-process "
      + "envelope-overrides map; this migration only touches pre-existing "
      + "installs. Gated so it ONLY moves preset rows still at the OLD per-"
      + "backend default — operator-pinned rows (updated_by='user') and rows "
      + "already at a custom value are left untouched. Idempotent: after the "
      + "bump no row sits in the old band, and the recorded id short-circuits a "
      + "re-run anyway.",
    up(db) {
      // Empty-DB safety (e.g. the runner's own unit tests run on a bare
      // :memory: db): if applySchema never ran, the table is absent — the
      // runner still records the id so a later boot does not re-evaluate.
      if (!tableExists(db, "process_backend_config")) return;
      // The NEW per-backend value mirrors what `resolveDefaultBindingFor`
      // now produces for routine.today_refresh: the $0.50 base x the medium
      // post-hoc factor (1.5 for codex/gemini, 1.0 for claude/opencode). The
      // 0.75 literal is that product at migration time — a migration is a
      // point-in-time snapshot, so the literal is correct even if the factor
      // later changes. The old-default bands ([0.29,0.31] / [0.44,0.46]) keep
      // us from clobbering a row already moved to a custom value while still
      // tolerating float dust.
      db.prepare(
        `UPDATE process_backend_config
            SET max_budget_usd = CASE
              WHEN main_backend IN ('codex', 'gemini') THEN 0.75
              ELSE 0.5
            END
          WHERE process_key = 'routine.today_refresh'
            AND updated_by = 'preset'
            AND (
              (main_backend IN ('codex', 'gemini')
                 AND max_budget_usd >= 0.44 AND max_budget_usd <= 0.46)
              OR (main_backend NOT IN ('codex', 'gemini')
                 AND max_budget_usd >= 0.29 AND max_budget_usd <= 0.31)
            )`,
      ).run();
    },
  },
  {
    id: "0010-hourly-check-to-activity-scan",
    description:
      "(v0.1.10→next) — the 'Hourly Check' built-in is renamed 'Activity "
      + "Scan' (slug hourly-check→activity-scan, process key "
      + "routine.hourly_check→routine.activity_scan, settings keys "
      + "hourlyCheck*→activityScan*). Carries the persisted identity across: "
      + "(1) agents row id rename preserving enabled / enabled_overridden_at / "
      + "metadata_json.runtime_window, moving child agent_executions rows "
      + "first (the FK has no ON UPDATE CASCADE); (2) process_backend_config "
      + "key rename for the routine + its .triage delegate — the fresh "
      + "new-key preset row that applySchema seeds moments before this body "
      + "runs is deleted so the operator's old row (model overrides, budget) "
      + "wins; (3) settings-table key renames (canonical row wins if both "
      + "exist); (4) runtime_state self-tuning ledger key renames for the two "
      + "activity-scan knobs; (5) on-disk vault file renames "
      + "policies/routines/hourly.md→activity-scan.md and "
      + "knowledge/dossiers/hourly.md→activity-scan.md — including the "
      + "pre-restructure root spellings routines/hourly.md and "
      + "dossiers/hourly.md for Obsidian vaults whose 0004 consent is still "
      + "pending (+ md_file_snapshots file_path rewrite so restore points "
      + "follow the file). When agents holds BOTH slugs (mixed-version "
      + "backup restore) the stale old row is dropped after re-homing its "
      + "executions — the registry no longer carries it, so nothing else "
      + "would ever clean it up. Historical "
      + "agent_actions rows keep their old action_type / agent_id — readers "
      + "union the legacy values (see db/activity-scan-signals.ts). Each step "
      + "is independently gated, so a fresh DB (schema.ts already seeds the "
      + "new names) is a recorded no-op and a re-run finds nothing to do.",
    up(db, ctx) {
      // (1) agents row — INSERT-copy → move children → DELETE old. This
      // order is FK-safe whether or not foreign_keys is ON: the new parent
      // exists before children point at it, and the old parent has no
      // children left when it is deleted (its ON DELETE CASCADE finds
      // nothing).
      if (tableExists(db, "agents")) {
        const oldRow = db
          .prepare("SELECT 1 FROM agents WHERE id = 'hourly-check'")
          .get();
        const newRow = db
          .prepare("SELECT 1 FROM agents WHERE id = 'activity-scan'")
          .get();
        if (oldRow && !newRow) {
          db.prepare(
            `INSERT INTO agents (
               id, name, description, source, definition_path,
               definition_hash, enabled, enabled_overridden_at, process_key,
               schedule_kind, schedule_expression, schedule_timezone,
               tags_json, stop_warning_json, recurring_schedule_id,
               last_execution_id, metadata_json, created_at, updated_at
             )
             SELECT
               'activity-scan', 'Activity Scan', description, source,
               replace(definition_path, 'hourly-check', 'activity-scan'),
               definition_hash, enabled, enabled_overridden_at,
               'routine.activity_scan',
               schedule_kind, schedule_expression, schedule_timezone,
               tags_json, stop_warning_json, recurring_schedule_id,
               last_execution_id, metadata_json, created_at, updated_at
             FROM agents WHERE id = 'hourly-check'`,
          ).run();
          if (tableExists(db, "agent_executions")) {
            db.prepare(
              "UPDATE agent_executions SET agent_id = 'activity-scan' WHERE agent_id = 'hourly-check'",
            ).run();
          }
          db.prepare("DELETE FROM agents WHERE id = 'hourly-check'").run();
        } else if (oldRow && newRow) {
          // Both rows exist — a DB restored from a mixed-version backup
          // (or one that briefly ran a post-rename loader before this
          // migration was recorded). The new row is the live identity the
          // loader maintains; the old row is stale. Re-home its execution
          // history, then drop it — the registry no longer carries
          // 'hourly-check', so nothing would ever clean it up otherwise.
          if (tableExists(db, "agent_executions")) {
            db.prepare(
              "UPDATE agent_executions SET agent_id = 'activity-scan' WHERE agent_id = 'hourly-check'",
            ).run();
          }
          db.prepare("DELETE FROM agents WHERE id = 'hourly-check'").run();
        }
      }

      // (2) process_backend_config — the operator's old-key row carries any
      // model/budget overrides; the new-key row at this point can only be
      // the preset applySchema seeded microseconds earlier on this same
      // boot, so deleting it in favour of the renamed old row is lossless.
      if (tableExists(db, "process_backend_config")) {
        const keyPairs: ReadonlyArray<readonly [string, string]> = [
          ["routine.hourly_check", "routine.activity_scan"],
          ["routine.hourly_check.triage", "routine.activity_scan.triage"],
        ];
        for (const [oldKey, newKey] of keyPairs) {
          const exists = db
            .prepare(
              "SELECT 1 FROM process_backend_config WHERE process_key = ?",
            )
            .get(oldKey);
          if (!exists) continue;
          db.prepare(
            "DELETE FROM process_backend_config WHERE process_key = ?",
          ).run(newKey);
          db.prepare(
            "UPDATE process_backend_config SET process_key = ? WHERE process_key = ?",
          ).run(newKey, oldKey);
        }
      }

      // (3) settings rows. Literal pairs (a migration is a point-in-time
      // snapshot — do not import the live alias map). Canonical row wins
      // when both exist (the operator already wrote the new key via a
      // post-upgrade PATCH before this migration ran — possible only on
      // DBs restored from mixed-version backups).
      if (tableExists(db, "settings")) {
        const settingPairs: ReadonlyArray<readonly [string, string]> = [
          ["hourlyCheckEnabled", "activityScanEnabled"],
          ["hourlyCheckIntervalMinutes", "activityScanIntervalMinutes"],
          ["hourlyCheckActiveStartHour", "activityScanActiveStartHour"],
          ["hourlyCheckActiveEndHour", "activityScanActiveEndHour"],
          ["hourlyCheckMinObservations", "activityScanMinObservations"],
          ["hourlyCheckStage2Enabled", "activityScanStage2Enabled"],
          ["hourlyCheckHeartbeatHours", "activityScanHeartbeatHours"],
          [
            "hourlyCheckLowSignalPendingCeiling",
            "activityScanLowSignalPendingCeiling",
          ],
          [
            "hourlyCheckPrePassFreshnessMinutes",
            "activityScanPrePassFreshnessMinutes",
          ],
          ["hourlyObservationCharBudget", "activityScanObservationCharBudget"],
        ];
        for (const [oldKey, newKey] of settingPairs) {
          const oldExists = db
            .prepare("SELECT 1 FROM settings WHERE key = ?")
            .get(oldKey);
          if (!oldExists) continue;
          const newExists = db
            .prepare("SELECT 1 FROM settings WHERE key = ?")
            .get(newKey);
          if (newExists) {
            db.prepare("DELETE FROM settings WHERE key = ?").run(oldKey);
          } else {
            db.prepare("UPDATE settings SET key = ? WHERE key = ?").run(
              newKey,
              oldKey,
            );
          }
        }
      }

      // (4) self-tuning ledger keys (SELF_TUNING_REVIEW_CYCLE_DESIGN.md §3.4).
      if (tableExists(db, "runtime_state")) {
        const ledgerPairs: ReadonlyArray<readonly [string, string]> = [
          [
            "self_tuning:hourlyCheckPrePassFreshnessMinutes",
            "self_tuning:activityScanPrePassFreshnessMinutes",
          ],
          [
            "self_tuning:hourlyCheckLowSignalPendingCeiling",
            "self_tuning:activityScanLowSignalPendingCeiling",
          ],
        ];
        for (const [oldKey, newKey] of ledgerPairs) {
          const oldExists = db
            .prepare("SELECT 1 FROM runtime_state WHERE key = ?")
            .get(oldKey);
          if (!oldExists) continue;
          const newExists = db
            .prepare("SELECT 1 FROM runtime_state WHERE key = ?")
            .get(newKey);
          if (newExists) {
            db.prepare("DELETE FROM runtime_state WHERE key = ?").run(oldKey);
          } else {
            db.prepare("UPDATE runtime_state SET key = ? WHERE key = ?").run(
              newKey,
              oldKey,
            );
          }
        }
      }

      // (5) vault files. Gated per file (old exists, new absent); a vault
      // that never materialized either file is a no-op. Snapshot paths are
      // rewritten so `POST /api/context/snapshots/restore` finds the
      // file's history under its new name.
      //
      // The PRE-RESTRUCTURE spellings (`routines/`, `dossiers/` at the
      // vault root) matter on Obsidian vaults whose 0004 consent is still
      // pending: `resolveVaultRestructureConsent` filters 0004 out of the
      // run list but this migration still runs and records. Renaming the
      // legacy-located files here keeps them aligned, and 0004's
      // `dir-rename` manifest entries (`routines → policies/routines`,
      // `dossiers → knowledge/dossiers`) move the renamed files to their
      // canonical homes when the user eventually consents. Without this,
      // a deferred-consent vault would keep `routines/hourly.md` forever —
      // this migration never re-runs once recorded.
      if (!ctx) {
        throw new Error(
          "Migration 0010-hourly-check-to-activity-scan requires MigrationContext (contextDir); caller passed only db.",
        );
      }
      const fileRenames: ReadonlyArray<readonly [string, string]> = [
        ["policies/routines/hourly.md", "policies/routines/activity-scan.md"],
        ["knowledge/dossiers/hourly.md", "knowledge/dossiers/activity-scan.md"],
        ["routines/hourly.md", "routines/activity-scan.md"],
        ["dossiers/hourly.md", "dossiers/activity-scan.md"],
      ];
      for (const [oldRel, newRel] of fileRenames) {
        const oldAbs = join(ctx.contextDir, oldRel);
        const newAbs = join(ctx.contextDir, newRel);
        if (existsSync(oldAbs) && !existsSync(newAbs)) {
          renameSync(oldAbs, newAbs);
        }
        if (tableExists(db, "md_file_snapshots")) {
          db.prepare(
            "UPDATE md_file_snapshots SET file_path = ? WHERE file_path = ?",
          ).run(newRel, oldRel);
        }
      }
    },
  },
  {
    id: "0011-research-clusters-journal-enqueue-stamp",
    description:
      "RESEARCH_CLUSTER_COST_FIX_PLAN.md F1 (v0.1.10→next) — add the "
      + "nullable `journal_update_enqueued_on` column (TEXT, local "
      + "agent-day 'YYYY-MM-DD') to `browser_research_clusters`. The "
      + "day-boundary fan-out stamps it BEFORE enqueueing "
      + "`routine.research_cluster_update`, so a replayed day-boundary "
      + "callback (wake catch-up fires on every detected sleep gap >= 5 "
      + "min — every macOS maintenance DarkWake) can no longer re-enqueue "
      + "the same cluster within one agent day (the 2026-06-11 incident "
      + "fired ~25 runs in ~5h for one cluster). Fresh installs get the "
      + "column from the schema.ts CREATE; this ALTER covers pre-existing "
      + "tables and is gated on columnExists so a fresh DB is a recorded "
      + "no-op.",
    up(db) {
      // Empty-DB safety: columnExists returns false for a missing table,
      // so without this short-circuit a bare :memory: test DB would
      // attempt the ALTER and throw. The runner still records the id.
      if (!tableExists(db, "browser_research_clusters")) return;
      if (
        !columnExists(
          db,
          "browser_research_clusters",
          "journal_update_enqueued_on",
        )
      ) {
        db.exec(
          "ALTER TABLE browser_research_clusters ADD COLUMN journal_update_enqueued_on TEXT",
        );
      }
    },
  },
  {
    id: "0012-research-budget-bump",
    description:
      "RESEARCH_CLUSTER_COST_FIX_PLAN.md F3 (v0.1.10→next) — raise the "
      + "per-turn budget ceilings for `routine.research_cluster_update` "
      + "($0.05→$0.50) and `routine.research_offer_dm` ($0.02→$0.15) for "
      + "upgrading installs still on the seeded defaults. The SDK budget "
      + "check only fires between turns, and a cold-prompt-cache run "
      + "writes the full session prefix (~$0.13-0.30 observed on Haiku) "
      + "before the check can abort — the old caps killed every cold run "
      + "AFTER the money was spent, so the cluster journal was never "
      + "written (46 runs, zero context writes). Must ship with the F1 "
      + "enqueue stamp (migration 0011): with dedup alone the once-"
      + "nightly run is always cold → always over the old cap → the "
      + "feature stays dead. Backend-aware: applyDefaultPresets stores "
      + "post-hoc-scaled budgets and the lite factor for codex/gemini is "
      + "2.5, so the OLD defaults are $0.05/$0.13 (cluster_update) and "
      + "$0.02/$0.05 (offer_dm) and the NEW values are the bases scaled "
      + "the same way → $0.50/$1.25 and $0.15/$0.38. Fresh installs get "
      + "the new values from the schema seed (cluster_update) + the "
      + "envelope-overrides map (offer_dm has no seed row). Gated so it "
      + "ONLY moves preset rows still in the OLD per-backend band — "
      + "operator-pinned rows (updated_by='user') and rows already at a "
      + "custom value are left untouched. Idempotent: after the bump no "
      + "row sits in the old band, and the recorded id short-circuits a "
      + "re-run anyway.",
    up(db) {
      // Empty-DB safety (e.g. the runner's own unit tests run on a bare
      // :memory: db): if applySchema never ran, the table is absent — the
      // runner still records the id so a later boot does not re-evaluate.
      if (!tableExists(db, "process_backend_config")) return;
      // Literals are point-in-time snapshots of base x lite factor
      // (2.5 for codex/gemini, 1 for claude/opencode), mirroring the
      // 0006/0009 template: 0.05 x 2.5 = 0.13 (2-decimal rounded),
      // 0.50 x 2.5 = 1.25, 0.02 x 2.5 = 0.05, 0.15 x 2.5 = 0.38. The
      // ±0.01 bands tolerate float dust without clobbering a row
      // already moved to a custom value.
      db.prepare(
        `UPDATE process_backend_config
            SET max_budget_usd = CASE
              WHEN main_backend IN ('codex', 'gemini') THEN 1.25
              ELSE 0.5
            END
          WHERE process_key = 'routine.research_cluster_update'
            AND updated_by = 'preset'
            AND (
              (main_backend IN ('codex', 'gemini')
                 AND max_budget_usd >= 0.12 AND max_budget_usd <= 0.14)
              OR (main_backend NOT IN ('codex', 'gemini')
                 AND max_budget_usd >= 0.04 AND max_budget_usd <= 0.06)
            )`,
      ).run();
      db.prepare(
        `UPDATE process_backend_config
            SET max_budget_usd = CASE
              WHEN main_backend IN ('codex', 'gemini') THEN 0.38
              ELSE 0.15
            END
          WHERE process_key = 'routine.research_offer_dm'
            AND updated_by = 'preset'
            AND (
              (main_backend IN ('codex', 'gemini')
                 AND max_budget_usd >= 0.04 AND max_budget_usd <= 0.06)
              OR (main_backend NOT IN ('codex', 'gemini')
                 AND max_budget_usd >= 0.01 AND max_budget_usd <= 0.03)
            )`,
      ).run();
    },
  },
  {
    id: "0013-browser-task-delivery-timestamps",
    description:
      "BACKGROUND_TASK_RUNNER_DESIGN.md Phase 1 — add delivered_at recovery "
      + "keys for browser_task reports and browser_task_clarifications so "
      + "task.delivery can recover without double-sending.",
    up(db) {
      if (
        tableExists(db, "browser_task")
        && !columnExists(db, "browser_task", "delivered_at")
      ) {
        db.exec("ALTER TABLE browser_task ADD COLUMN delivered_at INTEGER");
      }
      if (
        tableExists(db, "browser_task_clarifications")
        && !columnExists(db, "browser_task_clarifications", "delivered_at")
      ) {
        db.exec(
          "ALTER TABLE browser_task_clarifications ADD COLUMN delivered_at INTEGER",
        );
      }
    },
  },
  {
    id: "0014-background-task-significance-criteria",
    description:
      "BACKGROUND_TASK_RUNNER_DESIGN.md Phase 4 — add the nullable "
      + "`significance_criteria` column (TEXT, JSON array of concrete "
      + "conditions) to `background_task` for the if_significant criteria "
      + "DSL (§4.3). The DM agent writes structured criteria at spawn; the "
      + "worker checks each against its result and sets notify accordingly. "
      + "Fresh installs get the column from the schema.ts CREATE body; this "
      + "ALTER covers pre-existing tables and is gated on columnExists so a "
      + "fresh DB (and a re-boot) is a recorded no-op.",
    up(db) {
      // Empty-DB safety: columnExists returns false for a missing table,
      // so without this short-circuit a bare :memory: test DB would
      // attempt the ALTER and throw. The runner still records the id.
      if (!tableExists(db, "background_task")) return;
      if (!columnExists(db, "background_task", "significance_criteria")) {
        db.exec(
          "ALTER TABLE background_task ADD COLUMN significance_criteria TEXT",
        );
      }
    },
  },
  {
    id: "0015-morning-briefing-follow-system-timezone",
    description:
      "(timezone OS-tracking) — the morning-briefing recurring row used to bake "
      + "a concrete `recurrence_rule.timezone` at setup (the resolved system "
      + "zone when the operator left timezone on auto), freezing the briefing to "
      + "the setup-time zone. Drop that baked zone so `resolveRuleTimezone` "
      + "falls back to the live system zone (kept current by TimezoneWatcher) "
      + "and the briefing tracks an OS timezone change. PROVENANCE-SAFE: only "
      + "runs while the operator's `timezone` setting is empty/unset (auto "
      + "mode) — a pinned zone is left untouched, since it may be the intended "
      + "fixed zone. Idempotent: a fresh DB has no briefing row yet (setup seeds "
      + "it without a zone post-fix), and a re-run finds the key already gone.",
    up(db) {
      if (!tableExists(db, "recurring_schedules")) return;
      // Honor an explicit operator pin: setup.ts only bakes the system zone
      // when `config.timezone` is empty, so a currently-pinned zone means the
      // row's zone may be a deliberate choice — don't clear it. Mirror config.ts
      // resolution precedence: a persisted `settings.timezone` row wins (even
      // when empty = explicit auto), otherwise the `PA_TIMEZONE` env var is the
      // source (config.ts:189 `envOrDefault("TIMEZONE", "")` → `PA_TIMEZONE`).
      // `null` here means "no settings row yet → defer to the env var".
      let effectiveTz: string | null = null;
      if (tableExists(db, "settings")) {
        const row = db
          .prepare("SELECT value_json FROM settings WHERE key = 'timezone'")
          .get() as { value_json: string } | undefined;
        if (row) {
          try {
            const value = JSON.parse(row.value_json) as unknown;
            effectiveTz = typeof value === "string" ? value : "";
          } catch {
            // Corrupt value_json — treat as auto (and keep boot from crashing).
            effectiveTz = "";
          }
        }
      }
      if (effectiveTz === null) {
        effectiveTz = process.env.PA_TIMEZONE ?? "";
      }
      if (effectiveTz.length > 0) return; // pinned — leave the row's zone alone
      // Auto mode: strip the baked zone from the briefing row(s). `json_remove`
      // on a rule without the key is a no-op; the WHERE guard keeps re-runs
      // from churning the row.
      db.prepare(
        `UPDATE recurring_schedules
            SET recurrence_rule = json_remove(recurrence_rule, '$.timezone')
          WHERE task_type = 'dm_session'
            AND json_extract(task_context, '$.sub_flow') = 'morning_briefing'
            AND json_extract(recurrence_rule, '$.timezone') IS NOT NULL`,
      ).run();
    },
  },
  {
    id: "0016-sonnet-5-medium-default-bump",
    description:
      "(Sonnet 5 launch, v0.1.11→next) — forward-track the Claude medium-tier "
      + "default from claude-sonnet-4-6 to claude-sonnet-5 for upgrading "
      + "installs. Sonnet 5 shipped 2026-06-30; DEFAULT_CLAUDE_MEDIUM_MODEL is "
      + "now claude-sonnet-5 and the schema seed interpolates it, so FRESH "
      + "installs already land on Sonnet 5. This migration only moves "
      + "PRE-EXISTING process_backend_config.main_model rows whose updated_by is "
      + "a non-user seed source ('preset' / 'cascade'); operator-pinned rows "
      + "(updated_by='user') and any default the operator changed away from the "
      + "old value are left untouched. backend_global_defaults is DELIBERATELY "
      + "NOT touched here (audit A1): at the time this migration shipped that "
      + "table had no updated_by column, so a stored claude-sonnet-4-6 is "
      + "ambiguous between a seed default and a deliberate operator pin — a "
      + "value-only UPDATE would silently override the pin. Those rows "
      + "forward-track lazily instead, the next time the operator hits setup or "
      + "'Reset to defaults' (both resolve via DEFAULT_CLAUDE_MEDIUM_MODEL). "
      + "Migration 0019 adds the provenance column so a FUTURE bump can guard "
      + "backend_global_defaults symmetrically. The conversation_sessions "
      + "'sonnet' alias DEFAULT and agent_schedule 'sonnet' rows resolve at "
      + "runtime and need no migration; a literal "
      + "agent_schedule.model='claude-sonnet-4-6' pin is a deliberate operator "
      + "choice and stays. Literals are point-in-time snapshots (NOT the "
      + "DEFAULT_CLAUDE_MEDIUM_MODEL constant) so a future bump can't retarget "
      + "this migration. Idempotent: the WHERE clause matches only the old "
      + "model, so after the bump nothing matches, and the recorded id "
      + "short-circuits a re-run anyway.",
    up(db) {
      // Empty-DB safety: a bare :memory: DB (e.g. the runner's own unit tests)
      // may not have run applySchema. Guard the table — the runner still
      // records the id so a later boot does not re-evaluate. NOTE:
      // backend_global_defaults is intentionally NOT updated here (see the
      // description) — it has no updated_by column at this migration, so a
      // value-only bump can't tell a seed default from a deliberate pin.
      if (tableExists(db, "process_backend_config")) {
        db.prepare(
          `UPDATE process_backend_config
              SET main_model = 'claude-sonnet-5'
            WHERE main_model = 'claude-sonnet-4-6'
              AND updated_by IN ('preset', 'cascade')`,
        ).run();
        db.prepare(
          `UPDATE process_backend_config
              SET main_model = 'anthropic/claude-sonnet-5'
            WHERE main_model = 'anthropic/claude-sonnet-4-6'
              AND updated_by IN ('preset', 'cascade')`,
        ).run();
      }
    },
  },
  {
    id: "0017-evening-review-budget-bump",
    description:
      "(v0.1.11→next) — raise the routine.evening_review per-turn budget "
      + "ceiling from the seeded $1.00 to $2.00 for upgrading installs still "
      + "on the seeded default. evening_review is a medium-tier, connector-"
      + "capable (it reaches the calendar connector in native / delegated-"
      + "same-backend modes, like morning_routine), many-turn bookkeeping "
      + "routine: its ~130 K cached prefix (full preset + the ~25 K user-scope "
      + "claude.ai connector schemas + the untruncated <today> Agent Log) is "
      + "re-read on every one of its ~28 curl-driven turns, so a busy day tips "
      + "the bare $1.00 medium nominal mid-turn and surfaces "
      + "BackendQuotaError(max_budget_usd) with no fallback (claude is the only "
      + "binding). Realigned to $2.00, matching its morning_routine sibling "
      + "(also medium, connector-capable, many-turn). Backend-aware: "
      + "applyDefaultPresets stores the post-hoc-scaled budget (codex/gemini "
      + "medium x1.5), so the OLD default is $1.00 on claude/opencode and $1.50 "
      + "on codex/gemini, and the NEW default is the $2.00 base scaled the same "
      + "way -> $2.00 / $3.00. Fresh installs already get the new value from the "
      + "schema seed + the per-process envelope-overrides map; this migration "
      + "only touches pre-existing installs. Gated so it ONLY moves preset rows "
      + "still at the OLD per-backend default — operator-pinned rows "
      + "(updated_by='user') and rows already at a custom value are left "
      + "untouched. Idempotent: after the bump no row sits in the old band, and "
      + "the recorded id short-circuits a re-run anyway.",
    up(db) {
      // Empty-DB safety (e.g. the runner's own unit tests run on a bare
      // :memory: db): if applySchema never ran, the table is absent — the
      // runner still records the id so a later boot does not re-evaluate.
      if (!tableExists(db, "process_backend_config")) return;
      // The NEW per-backend value mirrors what `resolveDefaultBindingFor`
      // now produces for routine.evening_review: the $2.00 base x the medium
      // post-hoc factor (1.5 for codex/gemini, 1.0 for claude/opencode). The
      // 3.0 literal is that product at migration time — a migration is a
      // point-in-time snapshot, so the literal is correct even if the factor
      // later changes. The old-default bands ([0.99,1.01] / [1.49,1.51]) keep
      // us from clobbering a row already moved to a custom value while still
      // tolerating float dust.
      db.prepare(
        `UPDATE process_backend_config
            SET max_budget_usd = CASE
              WHEN main_backend IN ('codex', 'gemini') THEN 3.0
              ELSE 2.0
            END
          WHERE process_key = 'routine.evening_review'
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
  {
    id: "0018-recurring-dm-follow-system-timezone-backfill",
    description:
      "(timezone OS-tracking, audit A3 — UNSCOPED backfill) — migration 0015 "
      + "stripped the baked `recurrence_rule.timezone` only from the morning-"
      + "briefing row. The same write-path bug baked a concrete OS zone into "
      + "EVERY auto-mode `dm_session` recurring row created before the "
      + "resolveTimezone fix, freezing each to its create-time zone (a laptop "
      + "crossing timezones kept firing the reminder at the old wall-clock). "
      + "Strip the baked zone from ALL `dm_session` rows so `resolveRuleTimezone` "
      + "re-resolves the live system zone (kept current by TimezoneWatcher). "
      + "PROVENANCE TRADEOFF: a pre-fix row carries NO marker distinguishing an "
      + "auto-baked zone from a deliberately API-pinned per-rule zone — they are "
      + "byte-identical — so this cannot preserve an intentionally pinned zone in "
      + "auto mode; it clears every dm_session zone while auto mode is active. "
      + "Accepted because (a) in auto mode a pinned zone and the live OS zone "
      + "usually coincide, and (b) tracking the OS is the safer failure mode than "
      + "a silently frozen wall-clock. GLOBAL GATE (mirrors 0015): runs ONLY "
      + "while the operator `timezone` setting is empty/unset (auto mode); if any "
      + "operator zone is pinned, every row is left untouched. Idempotent: the "
      + "`$.timezone IS NOT NULL` guard makes a re-run a no-op, and the recorded "
      + "id short-circuits re-evaluation.",
    up(db) {
      if (!tableExists(db, "recurring_schedules")) return;
      // Auto-mode gate — identical resolution precedence to 0015: a persisted
      // settings.timezone row (even empty = explicit auto) wins, else PA_TIMEZONE.
      let effectiveTz: string | null = null;
      if (tableExists(db, "settings")) {
        const row = db
          .prepare("SELECT value_json FROM settings WHERE key = 'timezone'")
          .get() as { value_json: string } | undefined;
        if (row) {
          try {
            const value = JSON.parse(row.value_json) as unknown;
            effectiveTz = typeof value === "string" ? value : "";
          } catch {
            // Corrupt value_json — treat as auto (and keep boot from crashing).
            effectiveTz = "";
          }
        }
      }
      if (effectiveTz === null) {
        effectiveTz = process.env.PA_TIMEZONE ?? "";
      }
      if (effectiveTz.length > 0) return; // pinned — leave all rows alone
      db.prepare(
        `UPDATE recurring_schedules
            SET recurrence_rule = json_remove(recurrence_rule, '$.timezone')
          WHERE task_type = 'dm_session'
            AND json_extract(recurrence_rule, '$.timezone') IS NOT NULL`,
      ).run();
    },
  },
  {
    id: "0019-backend-global-defaults-updated-by",
    description:
      "(audit A1) — add the `updated_by` provenance column to "
      + "backend_global_defaults so a FUTURE value-only default-bump migration "
      + "can guard it symmetrically with process_backend_config (the gap that let "
      + "migration 0016 originally threaten to silently override an operator "
      + "pin). This ONLY runs on an UPGRADING install (the column is absent): the "
      + "ALTER's OWN default is 'user' — DISTINCT from the CREATE-TABLE default "
      + "'preset' — so every PRE-EXISTING row backfills to 'user'. A row already "
      + "present is ambiguous between a seed default and a deliberate pin, so mark "
      + "it a pin (protect it) — the conservative choice that matches 0016's "
      + "decision to leave these rows alone. On a FRESH install applySchema "
      + "already created the column (default 'preset', a forward-trackable seed) "
      + "so this migration is SKIPPED; operator writes (upsertDefaults) and preset "
      + "re-seeds (applyDefaultPresets, setMainBackend INSERT) stamp it going "
      + "forward. Idempotent: the columnExists guard makes it a recorded no-op "
      + "once the column is present.",
    up(db) {
      if (!tableExists(db, "backend_global_defaults")) return;
      // NB: the ALTER default 'user' is INTENTIONALLY different from the
      // CREATE-TABLE default 'preset' (schema.ts). CREATE-TABLE 'preset' marks a
      // fresh seed forward-trackable; this 'user' protects an ambiguous
      // pre-existing upgrade row. Do not "reconcile" the two.
      if (!columnExists(db, "backend_global_defaults", "updated_by")) {
        db.exec(
          "ALTER TABLE backend_global_defaults ADD COLUMN updated_by TEXT NOT NULL DEFAULT 'user'",
        );
      }
    },
  },
  {
    id: "0020-reconcile-agent-claimed-dm-enabled-drift",
    description:
      "(task-board canonical-owner dedup) — an agent-claimed dm_session "
      + "recurring row is now hidden from /schedule and /tasks (surfaced only "
      + "through its owning Agent) and write-guarded (PATCH/DELETE 409). The "
      + "scheduler, however, materializes occurrences from the ROW's `enabled` "
      + "(reconcileRecurringSchedules gates on `rs.enabled = 1`), and the "
      + "Agent→row mirror is one-way — so a pre-existing drifted pair (row "
      + "paused on the old /schedule queue while its Agent stayed enabled, or "
      + "vice versa) would upgrade into an invisible dead schedule: the Agent "
      + "card says active, the paused row is hidden everywhere, nothing fires. "
      + "Reconcile with OFF-WINS: either side paused → both paused. OFF wins "
      + "because resurrecting (rs.enabled=1) could silently revive DMs the user "
      + "deliberately paused, while a visibly paused Agent is one dashboard "
      + "toggle from repair (a real OFF→ON transition re-mirrors both flags). "
      + "Direction 2 stamps `enabled_overridden_at` — without it the loader's "
      + "§6.4 resolution treats the DB flag as non-overridden and the next "
      + "provision resurrects the YAML `enabled`, undoing the reconcile. Scoped "
      + "to dm_session claimed pairs (the dedup's scope; agent.task rows have "
      + "been 410-write-gated since the split, so they carry no such legacy "
      + "drift). Idempotent: both UPDATEs match only misaligned pairs, and the "
      + "recorded id short-circuits a re-run anyway.",
    up(db) {
      if (!tableExists(db, "agents") || !tableExists(db, "recurring_schedules")) {
        return;
      }
      if (!columnExists(db, "agents", "recurring_schedule_id")) return;
      // Direction 1: Agent paused, claimed row still enabled → pull the row
      // down so the schedule stops firing for a paused Agent.
      db.prepare(
        `UPDATE recurring_schedules
            SET enabled = 0
          WHERE enabled = 1
            AND task_type = 'dm_session'
            AND id IN (SELECT recurring_schedule_id FROM agents
                        WHERE enabled = 0 AND recurring_schedule_id IS NOT NULL)`,
      ).run();
      // Direction 2: claimed row paused, Agent still enabled → pull the Agent
      // down so the pause is visible and repairable from the Agent card.
      // (Direction 1 cannot feed this: it only touches rows whose agent is
      // already disabled, which the `enabled = 1` filter here skips.)
      const now = Date.now();
      db.prepare(
        `UPDATE agents
            SET enabled = 0,
                enabled_overridden_at = ?,
                updated_at = ?
          WHERE enabled = 1
            AND recurring_schedule_id IN (SELECT id FROM recurring_schedules
                                           WHERE enabled = 0 AND task_type = 'dm_session')`,
      ).run(now, now);
    },
  },
  {
    id: "0021-fetch-window-max-turns-bump",
    description:
      "(v0.1.12→next, FETCH_WINDOW_TURN_LIMIT_FIX_PLAN.md P1.3) — raise the "
      + "routine.fetch_window max_turns envelope from the seeded 10 to 20 for "
      + "upgrading installs still on the seeded default. The 10-turn cap "
      + "(PREPASS_COST_REDUCTION_PLAN.md N4) was sized from a single install "
      + "whose measured max=11 already exceeded it; on installs whose turn "
      + "demand sits further right (item volume, per-item thread-detail "
      + "wandering on Haiku, ToolSearch schema loads) the SDK kills the "
      + "pre-pass at error_max_turns with no final turn for the closing JSON "
      + "line, and the fan-out runner then retried the identical plan under "
      + "the identical envelope 3x (~$0.57 pure waste per tick per affected "
      + "integration). Turns bound wander, not cost — max_budget_usd $0.50 "
      + "stays the stop-loss. Backend-agnostic: applyBackendBudgetFactor "
      + "scales ONLY max_budget_usd, never max_turns, so the old default is "
      + "10 on every backend and no per-backend CASE is needed (contrast "
      + "migration 0017). Gated so it ONLY moves preset rows still at the old "
      + "default — operator-pinned rows (updated_by='user', e.g. the "
      + "documented PUT /api/process-config mitigation) and rows already at a "
      + "custom value are left untouched. Fresh installs get 20 from the "
      + "schema seed + ENVELOPE_OVERRIDES_BY_PROCESS_KEY. The literals are "
      + "point-in-time snapshots so a future resize cannot retarget this "
      + "migration. Idempotent: after the bump no row matches max_turns=10, "
      + "and the recorded id short-circuits a re-run anyway.",
    up(db) {
      // Empty-DB safety (e.g. unit tests on a bare :memory: db): if
      // applySchema never ran, the table is absent — the runner still
      // records the id so a later boot does not re-evaluate.
      if (!tableExists(db, "process_backend_config")) return;
      db.prepare(
        `UPDATE process_backend_config
            SET max_turns = 20
          WHERE process_key = 'routine.fetch_window'
            AND updated_by = 'preset'
            AND max_turns = 10`,
      ).run();
    },
  },
  {
    id: "0022-task-origin-and-cost",
    description:
      "(tier-2 worker audit) — add `origin` + `cost_usd` to background_task "
      + "and browser_task. `origin` ('user'|'agent'|'system', DEFAULT 'agent') "
      + "records who set the task in motion; the Task Board previously "
      + "hardcoded every worker's origin to 'agent', so the provenance was "
      + "unrecoverable. The ALTER default matches the CREATE-TABLE default "
      + "(both 'agent' — the historical assumption for every pre-existing "
      + "row), unlike 0019's deliberately divergent pair. `cost_usd` is the "
      + "task-level spend rollup: the drivers have ALWAYS computed a per-run "
      + "costUsd and the runners then discarded it — workers bypass the "
      + "agent_actions ledger entirely, so their spend appeared on no surface. "
      + "The runners now accumulate it here per driver leg AND write a per-run "
      + "agent_actions row so `GET /cost` finally includes detached-worker "
      + "spend. NULL = no run recorded a cost yet (pre-migration history stays "
      + "NULL, honestly unknown rather than a fake 0). Idempotent via "
      + "columnExists guards.",
    up(db) {
      for (const table of ["background_task", "browser_task"] as const) {
        if (!tableExists(db, table)) continue;
        if (!columnExists(db, table, "origin")) {
          db.exec(
            `ALTER TABLE ${table} ADD COLUMN origin TEXT NOT NULL DEFAULT 'agent' `
            + `CHECK (origin IN ('user', 'agent', 'system'))`,
          );
        }
        if (!columnExists(db, table, "cost_usd")) {
          db.exec(`ALTER TABLE ${table} ADD COLUMN cost_usd REAL`);
        }
      }
    },
  },
  {
    id: "0023-background-task-verification",
    description:
      "(background-task worker self-verification) — add `verification` to "
      + "background_task: a JSON array of {requirement, met, evidence} the "
      + "worker's finish() tool now REQUIRES, so a tier-2 worker checks its "
      + "result against the brief's requirements before completing instead "
      + "of claiming unverified success. Any unmet item marks the row "
      + "outcome_detail='completed_with_gaps' and appends a deterministic "
      + "gap disclosure to the draft — enforcement is structural (tool "
      + "schema), no new LLM call. NULL = finished before this shipped, or "
      + "a runner-synthesized fail-loud artifact (no worker checklist to "
      + "record). Idempotent via the columnExists guard.",
    up(db) {
      if (!tableExists(db, "background_task")) return;
      if (!columnExists(db, "background_task", "verification")) {
        db.exec(`ALTER TABLE background_task ADD COLUMN verification TEXT`);
      }
    },
  },
  {
    id: "0024-source-documents",
    description:
      "(source library) — create `source_documents` and add "
      + "`chat_attachments.source_id`. User-sent documents (PDF/PPTX/DOCX…) "
      + "previously lived only in the message-lifecycle-coupled "
      + "chat_attachments store, so message pruning (ON DELETE CASCADE) and "
      + "the 24h orphan reaper silently destroyed them. source_documents is "
      + "the durable library ledger for <dataDir>/sources/<id>/ binaries: "
      + "sha256-deduped, status-driven lifecycle (unfiled/filed/archived), "
      + "and deliberately NO foreign key into the message graph — an FK "
      + "would re-import the retention problem this table exists to escape. "
      + "`chat_attachments.source_id` is a plain-TEXT breadcrumb from an "
      + "ingested attachment to its captured source so the DM prompt block "
      + "can announce the library id. Idempotent via IF NOT EXISTS + "
      + "columnExists guards. See SOURCE_LIBRARY_DESIGN.md.",
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS source_documents (
            id TEXT PRIMARY KEY,
            sha256 TEXT NOT NULL UNIQUE,
            path TEXT NOT NULL,
            original_filename TEXT NOT NULL,
            safe_filename TEXT NOT NULL,
            mime_type TEXT NOT NULL,
            size_bytes INTEGER NOT NULL,
            status TEXT NOT NULL DEFAULT 'unfiled'
                CHECK (status IN ('unfiled', 'filed', 'archived')),
            card_path TEXT,
            provenance TEXT NOT NULL,
            origin_attachment_id TEXT,
            caption TEXT,
            received_at TEXT NOT NULL DEFAULT (datetime('now')),
            last_received_at TEXT NOT NULL DEFAULT (datetime('now')),
            receive_count INTEGER NOT NULL DEFAULT 1,
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_source_documents_status
            ON source_documents(status);
      `);
      if (
        tableExists(db, "chat_attachments")
        && !columnExists(db, "chat_attachments", "source_id")
      ) {
        db.exec(`ALTER TABLE chat_attachments ADD COLUMN source_id TEXT`);
      }
    },
  },
  {
    id: "0025-morning-today-budget-bump",
    description:
      "(routine cost reduction 2026-07) — raise the routine."
      + "morning_routine_today (Stage A) per-turn budget ceiling from the "
      + "seeded $1.50 to $2.00 for upgrading installs still on the seeded "
      + "default. The sonnet-4-6 → sonnet-5 default bump (more tokens per "
      + "text + more agentic = more prefix re-reads per run) pushed real "
      + "Stage A runs to ~$1.50-1.69 in 29 turns, so the SDK's mid-turn "
      + "abort produced a daily BackendQuotaError(max_budget_usd) fail "
      + "followed by the today.md-health retry chain re-running the whole "
      + "session — fail+retry costs MORE (~$2.0-2.2/day across both runs) "
      + "than one completed run under the wider cap, and risks a "
      + "half-written today.md. Realigned to $2.00, matching the parent "
      + "routine.morning_routine and the structural twin "
      + "routine.evening_review (both medium-tier, connector-capable, "
      + "many-turn; the evening twin got the same treatment in migration "
      + "0017). Backend-aware: applyDefaultPresets stores the post-hoc-"
      + "scaled budget (codex/gemini medium x1.5), so the OLD default is "
      + "$1.50 on claude/opencode and $2.25 on codex/gemini, and the NEW "
      + "default is the $2.00 base scaled the same way -> $2.00 / $3.00. "
      + "Fresh installs already get the new value from the schema seed + "
      + "the per-process envelope-overrides map; this migration only "
      + "touches pre-existing installs. Gated so it ONLY moves preset rows "
      + "still at the OLD per-backend default — operator-pinned rows "
      + "(updated_by='user') and rows already at a custom value are left "
      + "untouched. Idempotent: after the bump no row sits in the old "
      + "band, and the recorded id short-circuits a re-run anyway.",
    up(db) {
      // Empty-DB safety (e.g. the runner's own unit tests run on a bare
      // :memory: db): if applySchema never ran, the table is absent — the
      // runner still records the id so a later boot does not re-evaluate.
      if (!tableExists(db, "process_backend_config")) return;
      // The NEW per-backend value mirrors what `resolveDefaultBindingFor`
      // now produces for routine.morning_routine_today: the $2.00 base x
      // the medium post-hoc factor (1.5 for codex/gemini, 1.0 for
      // claude/opencode). The 3.0 literal is that product at migration
      // time — a migration is a point-in-time snapshot, so the literal is
      // correct even if the factor later changes. The old-default bands
      // ([1.49,1.51] / [2.24,2.26]) keep us from clobbering a row already
      // moved to a custom value while still tolerating float dust.
      db.prepare(
        `UPDATE process_backend_config
            SET max_budget_usd = CASE
              WHEN main_backend IN ('codex', 'gemini') THEN 3.0
              ELSE 2.0
            END
          WHERE process_key = 'routine.morning_routine_today'
            AND updated_by = 'preset'
            AND (
              (main_backend IN ('codex', 'gemini')
                 AND max_budget_usd >= 2.24 AND max_budget_usd <= 2.26)
              OR (main_backend NOT IN ('codex', 'gemini')
                 AND max_budget_usd >= 1.49 AND max_budget_usd <= 1.51)
            )`,
      ).run();
    },
  },
  {
    id: "0026-dev-mode",
    description:
      "(development mode) — create the four dev-mode tables: dev_sessions "
      + "(one interactive dev session per row — the durable state authority + "
      + "loop-kit run-checkpoint + boot-resume surface for the native "
      + "CONTRACT->APPROVE->LOOP->EVIDENCE engine), dev_session_iterations "
      + "(native journal.jsonl, one immutable row per loop leg), "
      + "dev_session_requirements (the REQ ledger the gate reads and the UI "
      + "renders), and dev_session_escalations (a near-clone of "
      + "background_task_clarifications, CAS-resolve + delivery recovery, but "
      + "with a NULLABLE deadline_at because dev escalations are never "
      + "auto-timed-out). All four are new tables with no seed data, so this "
      + "is a pure CREATE-IF-NOT-EXISTS mirror of the schema.ts definitions — "
      + "idempotent regardless of prior schema state. See the dev-mode plan.",
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS dev_sessions (
            id                   TEXT PRIMARY KEY,
            repository_id        TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
            slug                 TEXT,
            branch               TEXT,
            base_ref             TEXT,
            state                TEXT NOT NULL DEFAULT 'interview'
                CHECK (state IN (
                    'interview', 'awaiting_approval', 'running',
                    'awaiting_user', 'done', 'exited', 'failed'
                )),
            loop_state           TEXT
                CHECK (loop_state IS NULL OR loop_state IN (
                    'SUCCESS', 'NO_OP', 'NEEDS_SPEC_DECISION',
                    'NEEDS_ARCHITECTURE_DECISION', 'RISK_REQUIRES_APPROVAL',
                    'BLOCKED', 'STALLED', 'BUDGET_EXCEEDED'
                )),
            approved_hash        TEXT,
            approved_at          INTEGER,
            iteration            INTEGER NOT NULL DEFAULT 0,
            agent_failures       INTEGER NOT NULL DEFAULT 0,
            gate_revise_count    INTEGER NOT NULL DEFAULT 0,
            iter_revise_count    INTEGER NOT NULL DEFAULT 0,
            resumes              INTEGER NOT NULL DEFAULT 0,
            max_iterations       INTEGER,
            config_json          TEXT,
            models_json          TEXT,
            cost_usd             REAL,
            max_budget_usd       REAL,
            timeout_schedule_id  INTEGER REFERENCES agent_schedule(id) ON DELETE SET NULL,
            originating_platform TEXT,
            originating_channel  TEXT,
            created_at           INTEGER NOT NULL,
            entered_at           INTEGER NOT NULL,
            updated_at           INTEGER NOT NULL,
            exited_at            INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_dev_sessions_state
            ON dev_sessions(state);
        CREATE INDEX IF NOT EXISTS idx_dev_sessions_repo
            ON dev_sessions(repository_id);
        CREATE INDEX IF NOT EXISTS idx_dev_sessions_created
            ON dev_sessions(created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_dev_sessions_non_terminal
            ON dev_sessions(state)
            WHERE state IN ('interview', 'awaiting_approval', 'running', 'awaiting_user');

        CREATE TABLE IF NOT EXISTS dev_session_iterations (
            id          TEXT PRIMARY KEY,
            session_id  TEXT NOT NULL REFERENCES dev_sessions(id) ON DELETE CASCADE,
            iteration   INTEGER NOT NULL,
            phase       TEXT NOT NULL
                CHECK (phase IN (
                    'plan', 'implement', 'evaluate', 'review',
                    'stop_eval', 'gate', 'evidence'
                )),
            verdict     TEXT,
            reason      TEXT,
            cost_usd    REAL,
            commit_sha  TEXT,
            created_at  INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_dev_iterations_session
            ON dev_session_iterations(session_id, iteration);

        CREATE TABLE IF NOT EXISTS dev_session_requirements (
            id          TEXT PRIMARY KEY,
            session_id  TEXT NOT NULL REFERENCES dev_sessions(id) ON DELETE CASCADE,
            req_id      TEXT NOT NULL,
            title       TEXT,
            status      TEXT NOT NULL DEFAULT 'unstarted'
                CHECK (status IN (
                    'unstarted', 'in_progress', 'met', 'at_risk', 'regressed'
                )),
            evidence    TEXT,
            iter        INTEGER,
            updated_at  INTEGER NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_dev_reqs_session_req
            ON dev_session_requirements(session_id, req_id);

        CREATE TABLE IF NOT EXISTS dev_session_escalations (
            id              TEXT PRIMARY KEY,
            session_id      TEXT NOT NULL REFERENCES dev_sessions(id) ON DELETE CASCADE,
            kind            TEXT NOT NULL
                CHECK (kind IN (
                    'spec_decision', 'architecture_decision',
                    'risk_approval', 'review_escalation'
                )),
            question        TEXT NOT NULL,
            context_summary TEXT,
            asked_at        INTEGER NOT NULL,
            deadline_at     INTEGER,
            delivered_at    INTEGER,
            answer          TEXT,
            answered_at     INTEGER,
            resolved        INTEGER NOT NULL DEFAULT 0
                CHECK (resolved IN (0, 1))
        );
        CREATE INDEX IF NOT EXISTS idx_dev_esc_session
            ON dev_session_escalations(session_id);
        CREATE INDEX IF NOT EXISTS idx_dev_esc_unresolved
            ON dev_session_escalations(session_id)
            WHERE resolved = 0;
      `);
    },
  },
  {
    id: "0027-dev-flow",
    description:
      "(dev-flow) — task-DAG data layer for the dev-mode fleet engine. "
      + "(a) create dev_session_tasks: one row per task-DAG node — JSON "
      + "depends_on/reqs edges, per-task loop-checkpoint counters, "
      + "branch/worktree/seed-branch anchors, and a CAS state machine "
      + "(queued->running->supervise_pending->merge_pending->merged plus "
      + "awaiting_user/failed/superseded/dep_failed) — with the "
      + "(session_id, task_key) unique index. (b) ALTER dev_sessions ADD the "
      + "three cumulative fleet-mutation counters (replan_count / "
      + "plan_review_count / fixup_count) that the replan / plan-review / "
      + "integration-fixup budgets are enforced against. (c) ALTER "
      + "dev_session_escalations ADD task_id (task-scoped escalation "
      + "pointer; NULL = session-scoped; ON DELETE SET NULL keeps the Q&A "
      + "history when a task row goes away). (d) rebuild "
      + "dev_session_iterations to add task_id and widen the phase CHECK "
      + "with the five fleet phases (decompose / decompose_review / "
      + "supervise / plan_review / merge) — SQLite cannot ALTER a CHECK in "
      + "place, so: create *_new, copy rows with task_id = NULL (every "
      + "pre-flow leg was session-level), drop, rename, recreate indexes. "
      + "Idempotent: fresh DBs get the final shape from applySchema "
      + "(schema.ts) BEFORE this runs, so (a) is CREATE IF NOT EXISTS, "
      + "(b)/(c) are gated on columnExists, and (d) short-circuits when "
      + "dev_session_iterations.task_id already exists — the runner then "
      + "just records the id. The rebuild needs NO PRAGMA foreign_keys "
      + "toggling (which would be a silent no-op inside the runner's "
      + "transaction anyway): no table references dev_session_iterations, "
      + "so the DROP + RENAME cannot orphan or rewrite any inbound FK.",
    up(db) {
      // (a) New table — pure CREATE IF NOT EXISTS mirror of schema.ts.
      // task_key is the human DAG id ([a-z0-9][a-z0-9-]{0,23}); id is a
      // uuid. depends_on / reqs are JSON string arrays.
      db.exec(`
        CREATE TABLE IF NOT EXISTS dev_session_tasks (
            id                 TEXT PRIMARY KEY,
            session_id         TEXT NOT NULL REFERENCES dev_sessions(id) ON DELETE CASCADE,
            task_key           TEXT NOT NULL,
            summary            TEXT NOT NULL,
            depends_on         TEXT NOT NULL DEFAULT '[]',
            scope              TEXT NOT NULL DEFAULT '',
            reqs               TEXT NOT NULL DEFAULT '[]',
            body               TEXT NOT NULL,
            origin             TEXT NOT NULL DEFAULT 'plan'
                CHECK (origin IN ('plan','replan','plan_review','fixup')),
            state              TEXT NOT NULL DEFAULT 'queued'
                CHECK (state IN ('queued','running','supervise_pending','merge_pending',
                                 'awaiting_user','merged','failed','superseded','dep_failed')),
            loop_state         TEXT
                CHECK (loop_state IS NULL OR loop_state IN (
                    'SUCCESS','NO_OP','NEEDS_SPEC_DECISION','NEEDS_ARCHITECTURE_DECISION',
                    'NEEDS_DECOMPOSITION','RISK_REQUIRES_APPROVAL','BLOCKED','STALLED',
                    'BUDGET_EXCEEDED')),
            branch             TEXT,
            worktree_path      TEXT,
            base_ref           TEXT,
            seed_branch        TEXT,
            iteration          INTEGER NOT NULL DEFAULT 0,
            agent_failures     INTEGER NOT NULL DEFAULT 0,
            gate_revise_count  INTEGER NOT NULL DEFAULT 0,
            iter_revise_count  INTEGER NOT NULL DEFAULT 0,
            resumes            INTEGER NOT NULL DEFAULT 0,
            merge_retries      INTEGER NOT NULL DEFAULT 0,
            supervise_count    INTEGER NOT NULL DEFAULT 0,
            plan_review        TEXT
                CHECK (plan_review IS NULL OR plan_review IN ('pending','done','escalated')),
            cost_usd           REAL,
            fail_reason        TEXT,
            created_at         INTEGER NOT NULL,
            started_at         INTEGER,
            ended_at           INTEGER,
            merged_at          INTEGER,
            updated_at         INTEGER NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_dev_tasks_session_key
            ON dev_session_tasks(session_id, task_key);
        CREATE INDEX IF NOT EXISTS idx_dev_tasks_session_state
            ON dev_session_tasks(session_id, state);
      `);

      // (b) Cumulative fleet-mutation counters on dev_sessions. Fresh DBs
      // already carry these from schema.ts — the columnExists guards make
      // each ALTER a no-op there. tableExists first: columnExists returns
      // false for a missing table, and the ALTER would then throw on a
      // bare unit-test db that never saw applySchema/0026.
      if (tableExists(db, "dev_sessions")) {
        for (const column of [
          "replan_count",
          "plan_review_count",
          "fixup_count",
        ]) {
          if (!columnExists(db, "dev_sessions", column)) {
            db.exec(
              `ALTER TABLE dev_sessions ADD COLUMN ${column} INTEGER NOT NULL DEFAULT 0`,
            );
          }
        }
      }

      // (c) Task-scoped escalation pointer. NULL = session-scoped
      // escalation (plan-phase / fleet-level questions).
      if (
        tableExists(db, "dev_session_escalations")
        && !columnExists(db, "dev_session_escalations", "task_id")
      ) {
        db.exec(
          `ALTER TABLE dev_session_escalations ADD COLUMN task_id TEXT
             REFERENCES dev_session_tasks(id) ON DELETE SET NULL`,
        );
      }

      // (d) dev_session_iterations rebuild — add task_id + widen the phase
      // CHECK (SQLite cannot ALTER a CHECK in place). Guard: a fresh DB's
      // applySchema shape already has task_id, so skip. No PRAGMA
      // foreign_keys toggling: nothing references dev_session_iterations
      // (it is a leaf child of dev_sessions / dev_session_tasks), so the
      // DROP + RENAME is FK-safe inside the runner's transaction.
      if (
        tableExists(db, "dev_session_iterations")
        && !columnExists(db, "dev_session_iterations", "task_id")
      ) {
        db.exec(`
          CREATE TABLE dev_session_iterations_new (
              id          TEXT PRIMARY KEY,
              session_id  TEXT NOT NULL REFERENCES dev_sessions(id) ON DELETE CASCADE,
              task_id     TEXT REFERENCES dev_session_tasks(id) ON DELETE CASCADE,
              iteration   INTEGER NOT NULL,
              phase       TEXT NOT NULL
                  CHECK (phase IN ('plan','implement','evaluate','review','stop_eval','gate','evidence',
                                   'decompose','decompose_review','supervise','plan_review','merge')),
              verdict     TEXT,
              reason      TEXT,
              cost_usd    REAL,
              commit_sha  TEXT,
              created_at  INTEGER NOT NULL
          );
          INSERT INTO dev_session_iterations_new
            (id, session_id, task_id, iteration, phase, verdict, reason,
             cost_usd, commit_sha, created_at)
            SELECT id, session_id, NULL, iteration, phase, verdict, reason,
                   cost_usd, commit_sha, created_at
              FROM dev_session_iterations;
          DROP TABLE dev_session_iterations;
          ALTER TABLE dev_session_iterations_new RENAME TO dev_session_iterations;
        `);
      }
      // Recreate the indexes dropped with the old table (both IF NOT
      // EXISTS so the fresh-DB path — where applySchema already made
      // them — is a no-op). Guarded on the table for bare unit-test dbs.
      if (tableExists(db, "dev_session_iterations")) {
        db.exec(`
          CREATE INDEX IF NOT EXISTS idx_dev_iterations_session
              ON dev_session_iterations(session_id, iteration);
          CREATE INDEX IF NOT EXISTS idx_dev_iterations_task
              ON dev_session_iterations(task_id);
        `);
      }
    },
  },
  {
    id: "0028-dev-escalation-queue",
    description:
      "(dev-mode WP3 P0-5) — serialize concurrent fleet escalations. ALTER "
      + "dev_session_escalations ADD queued INTEGER NOT NULL DEFAULT 0: at "
      + "most one escalation per session is ACTIVE (queued = 0, delivered to "
      + "the owner) at a time; a second task that escalates while a sibling is "
      + "still parked is persisted queued = 1 and only promoted (queued -> 0 + "
      + "delivered) once the active one resolves, so a bare single-channel DM "
      + "reply is never mis-mapped to the wrong task. Also swaps the partial "
      + "index idx_dev_esc_unresolved to (resolved = 0 AND queued = 0) — the "
      + "active-lookup + serialization EXISTS predicate. Idempotent: fresh DBs "
      + "already carry the column + narrowed index from applySchema (schema.ts) "
      + "which runs BEFORE migrations, so the ALTER is columnExists-guarded and "
      + "the index recreate is DROP-then-CREATE. Existing rows backfill to "
      + "queued = 0 (correct — every legacy row was treated as active).",
    up(db) {
      if (
        tableExists(db, "dev_session_escalations")
        && !columnExists(db, "dev_session_escalations", "queued")
      ) {
        db.exec(
          `ALTER TABLE dev_session_escalations
             ADD COLUMN queued INTEGER NOT NULL DEFAULT 0`,
        );
        // Repair legacy multi-active data. The pre-WP3 fleet engine raised
        // task escalations WITHOUT serialization (createAndDeliverEscalation
        // kept siblings running), so a session could carry several concurrent
        // unresolved rows. The DEFAULT 0 backfill makes them ALL active,
        // violating the one-active-per-session invariant and letting a bare DM
        // reply resolve the wrong task. Keep only the OLDEST unresolved row
        // active per session (matching getOpenDevEscalationForSession's
        // asked_at ASC tiebreak, id as a deterministic secondary); hold the
        // rest queued = 1. Idempotent: a no-op on a fresh/single-active DB.
        db.exec(`
          UPDATE dev_session_escalations
             SET queued = 1
           WHERE resolved = 0
             AND id <> (
               SELECT e2.id FROM dev_session_escalations e2
                WHERE e2.session_id = dev_session_escalations.session_id
                  AND e2.resolved = 0
                ORDER BY e2.asked_at ASC, e2.id ASC
                LIMIT 1
             );
        `);
      }
      // Narrow the partial index to the active-escalation predicate. On an
      // existing DB the old index (WHERE resolved = 0) is dropped and
      // recreated; on a fresh DB applySchema already made the narrowed form,
      // so the DROP is a no-op and the CREATE IF NOT EXISTS keeps it.
      if (tableExists(db, "dev_session_escalations")) {
        db.exec(`
          DROP INDEX IF EXISTS idx_dev_esc_unresolved;
          CREATE INDEX IF NOT EXISTS idx_dev_esc_unresolved
              ON dev_session_escalations(session_id)
              WHERE resolved = 0 AND queued = 0;
        `);
      }
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
