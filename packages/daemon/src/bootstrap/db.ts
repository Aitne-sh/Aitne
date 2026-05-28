/**
 * Database bootstrap — §3 of the legacy `startup()` IIFE.
 *
 * Extracted from `index.ts` per
 * `docs/design/appendices/index-bootstrap-stage-split.md` Phase B-1.
 * Companion to `bootstrap/adapters.ts` and `bootstrap/services.ts`; same
 * Pattern-C shape (file-split-plan.md §10).
 *
 * Responsibilities (in run order):
 *  1. Open the SQLite file and apply the idempotent schema.
 *  2. Load persisted `settings` rows and merge them on top of env
 *     defaults. **Must run before step 3** so `getContextDir(config)`
 *     sees DB-persisted `vaultMode` / `primaryVaultPath` before the
 *     context-vault-restructure migration (0004) walks the vault.
 *     CONTEXT_VAULT_REDESIGN_PLAN.md §11.8 + V21.
 *  3. Resolve `contextDir`, evaluate the Obsidian-mode consent gate, and
 *     run the forward-only schema migrations.
 *  4. Register the wiki workspace token resolver so skill compilation can
 *     resolve `<wiki_workspace>` tokens via the DB.
 *  5. Backfill the content-less `fts_wiki` virtual table once per workspace.
 *  6. Bump `managed_task_seq.next_id` past any restored backup rows.
 *  7. Close orphaned `dashboard_chat` sessions left active by a crash so
 *     the setup wizard's resume gate flips correctly on next dashboard load.
 *  8. Construct the chat `AttachmentStore` (top-level so adapter reloaders
 *     can capture it in closure) and reap orphan rows.
 *  9. Fire-and-forget price refresh (best-effort, network call).
 *  10. Best-effort seed of git-project document templates (filesystem write).
 *  11. Heal the `delegatedTaskModeEnabled` Phase-1 canary default for users
 *      who have delegated integrations but never explicitly set the flag.
 *
 * Each step that has its own peer-test surface is exported by name so the
 * test file can pin its behavior independent of the parent `initDatabase`
 * factory. Steps with no testable branches (boot-time backfill / managed
 * task seq / price refresh) stay inline.
 *
 * Ordering invariants this module preserves (design §11):
 *  - Wiki token resolver is registered before any observer reads it.
 *  - Orphan dashboard_chat sessions are closed before `SessionManager` is
 *    constructed downstream.
 *  - `mergeRuntimeSettingsFromDb` runs before any observer or service
 *    reloader reads the config.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import type { AgentConfig } from "../config.js";
import { getContextDir, mergeRuntimeSettingsFromDb } from "../config.js";
import { createDatabase } from "../db/client.js";
import { applySchema } from "../db/schema.js";
import { MIGRATIONS, runMigrations, type Migration } from "../db/migrations.js";
import {
  assessVaultVersion,
  runContextVaultRestructure,
  MIGRATION_ID as CONTEXT_VAULT_MIGRATION_ID,
} from "../db/migrations/context-vault-restructure.js";
import {
  clearVaultRestructurePendingConsent,
  getVaultRestructureAck,
  setVaultRestructureAck,
  setVaultRestructurePendingConsent,
} from "../db/runtime-state.js";
import { readIntegrations } from "../db/integrations-store.js";
import { bootstrapManagedTaskSeq } from "../db/managed-tasks-store.js";
import { sweepNonTerminalRowsForBootRecovery } from "../db/browser-task-store.js";
import { setWikiWorkspaceTokenResolver } from "../core/skills-compiler-tree.js";
import {
  listWikiWorkspaces,
  readDefaultWikiWorkspace,
  readWikiWorkspaceByName,
} from "../core/wiki/workspaces.js";
import { backfillWikiFulltext } from "../core/wiki/wiki-fts.js";
import { seedGitProjectDocTemplates } from "../core/git-project-docs.js";
import { PriceFetcher } from "../core/backends/price-fetcher.js";
import {
  createSettingsStore,
  type SettingsStore,
} from "../settings/settings-store.js";
import type { RuntimeSettings } from "../settings/runtime-settings.js";
import { AttachmentStore } from "../services/attachments/store.js";
import { createLogger } from "../logging.js";

const logger = createLogger("daemon-bootstrap-db");

export interface BootstrapDbDeps {
  readonly config: AgentConfig;
}

export interface BootstrapDbResult {
  readonly db: Database.Database;
  readonly settingsStore: SettingsStore;
  readonly persistedSettings: Partial<RuntimeSettings>;
  readonly attachmentStore: AttachmentStore;
}

/**
 * CONTEXT_VAULT_REDESIGN_PLAN.md V16 — env-var override for the Obsidian
 * consent gate. Set to `"1"` (or any non-empty string) to declare that
 * the user has accepted the sidebar reorganization without going
 * through the dashboard surface. Recorded into
 * `runtime_state.context_vault_restructure_acknowledged_at` with
 * `source="env"` so subsequent boots short-circuit the env check.
 */
export const VAULT_RESTRUCTURE_ACK_ENV_VAR = "PA_VAULT_RESTRUCTURE_ACK";

export interface VaultRestructureConsentDecision {
  /** True when the migration is deferred awaiting user consent. */
  deferred: boolean;
  /** Migrations to pass into `runMigrations`. `undefined` means "use the
   *  default MIGRATIONS list" (steady-state proceed). A concrete array
   *  is the filtered list when the migration is deferred. */
  migrationsToRun: readonly Migration[] | undefined;
}

export interface ResolveVaultRestructureConsentDeps {
  readonly db: Database.Database;
  readonly dataDir: string;
  readonly contextDir: string;
  /** Test seam — production reads `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
  /** Test seam — defaults to `() => new Date().toISOString()`. */
  readonly nowIso?: () => string;
}

/**
 * Decide whether to run, defer, or short-circuit the context-vault
 * restructure migration (CONTEXT_VAULT_REDESIGN_PLAN.md §11.3.4 / V16).
 *
 * Branches:
 *  - Vault is in plain mode (under `<dataDir>/context/`): always proceed.
 *  - Vault is Obsidian-rooted and an explicit ack exists: proceed.
 *  - Vault is Obsidian-rooted and `PA_VAULT_RESTRUCTURE_ACK` is set:
 *    record the ack with `source="env"` and proceed.
 *  - Vault is Obsidian-rooted with no ack: defer. The migration is
 *    filtered out of the run list (so `schema_migrations` doesn't get
 *    its row), pending-consent state is recorded, the daemon boots
 *    normally on the legacy layout, and the alias resolver continues to
 *    translate legacy paths until the user acks. The Obsidian-mode
 *    vault-health probe (`config.ts:runVaultHealthProbe`) sees the
 *    missing `policies/management.md` marker on a legacy vault and
 *    enters degraded mode for reason `primary_vault_missing_content`
 *    on its own — that's what 503s context writes during the consent
 *    window. `bootstrapManagementMd` in `index.ts` reads
 *    `getVaultRestructurePendingConsent(db)` and skips its write so the
 *    legacy vault doesn't grow a stray `policies/` directory before the
 *    user has acknowledged the move.
 *
 * **Subsequent-migration ordering caveat**: only the 0004 entry is
 * filtered out. Any future migration appended AFTER 0004 will still
 * run while the vault is at the legacy layout. Authors of post-0004
 * migrations whose body reads from `<contextDir>/policies/...`,
 * `identity/...`, etc. must either (a) be idempotent against both
 * layouts, or (b) detect the pending-consent state via
 * `getVaultRestructurePendingConsent(db)` and skip their body
 * gracefully. Both are simpler than reintroducing a dependency-graph
 * framework just for this one transitional window. The window closes
 * the first time a deferred-consent user runs the daemon with the
 * env / dashboard ack set — at that point the migration runner picks
 * up 0004 (and only 0004; later entries already ran on the legacy
 * layout boot).
 *
 * Exported for peer testing.
 */
export function resolveVaultRestructureConsent(
  deps: ResolveVaultRestructureConsentDeps,
): VaultRestructureConsentDecision {
  const env = deps.env ?? process.env;
  const isObsidianVault = !deps.contextDir.startsWith(deps.dataDir);
  if (!isObsidianVault) {
    return { deferred: false, migrationsToRun: undefined };
  }

  // Already-migrated or fresh-empty Obsidian vault — nothing to consent
  // to. The marker check covers post-migration installs (the migration
  // body writes `.context-vault-version=2` as its last step). The
  // legacy-dirs check covers fresh Obsidian installs that have never
  // held vault content yet; without it, a brand-new Obsidian user
  // would see a "consent to restructure" banner with nothing to
  // restructure. Both checks are pure fs reads — no DB writes — so a
  // misclassification can't strand the user in a pending-state row.
  if (!vaultRestructureWouldHaveWork(deps.contextDir)) {
    return { deferred: false, migrationsToRun: undefined };
  }

  const existingAck = getVaultRestructureAck(deps.db);
  if (existingAck) {
    return { deferred: false, migrationsToRun: undefined };
  }

  const envAckRaw = env[VAULT_RESTRUCTURE_ACK_ENV_VAR];
  const envAckSet =
    typeof envAckRaw === "string" && envAckRaw.trim() !== "" && envAckRaw !== "0";
  if (envAckSet) {
    const nowIso = deps.nowIso ?? (() => new Date().toISOString());
    setVaultRestructureAck(deps.db, { at: nowIso(), source: "env" });
    return { deferred: false, migrationsToRun: undefined };
  }

  // Defer: filter the context-vault migration out of the run list so
  // `schema_migrations` doesn't acquire its row this boot. Record
  // pending-consent state for the health endpoint + dashboard surface.
  const nowIso = deps.nowIso ?? (() => new Date().toISOString());
  setVaultRestructurePendingConsent(deps.db, {
    since: nowIso(),
    reason: "obsidian_consent_required",
    contextDir: deps.contextDir,
  });

  return {
    deferred: true,
    migrationsToRun: MIGRATIONS.filter(
      (m) => m.id !== CONTEXT_VAULT_MIGRATION_ID,
    ),
  };
}

/**
 * True when the vault-restructure migration would actually have moves
 * to make against this `contextDir`. Cheap fs-only probe — used by
 * `resolveVaultRestructureConsent` to short-circuit the consent gate
 * for already-migrated and fresh-install Obsidian vaults.
 *
 * Returns false when:
 *  - The version marker `<contextDir>/.context-vault-version` reads
 *    `"2"` — migration completed on a prior boot.
 *  - None of the legacy top-level dirs exists — fresh install (or
 *    one that's already lost its legacy entries some other way).
 *
 * Returns true otherwise (legacy vault with `user/` / `rules/` / etc.).
 */
function vaultRestructureWouldHaveWork(contextDir: string): boolean {
  const markerPath = join(contextDir, ".context-vault-version");
  try {
    if (existsSync(markerPath)) {
      const marker = readFileSync(markerPath, "utf-8").trim();
      if (marker === "2") return false;
    }
  } catch {
    // best-effort — treat marker errors as "do the work to be safe."
  }
  const LEGACY_DIRS = [
    "user",
    "rules",
    "routines",
    "projects",
    "daily",
    "weekly",
    "monthly",
    "dossiers",
    "inbox",
    "agent",
    "_activity",
  ];
  for (const dir of LEGACY_DIRS) {
    if (existsSync(join(contextDir, dir))) return true;
  }
  return false;
}

/**
 * Open the SQLite file, apply schema, run boot-time backfills, hydrate
 * persisted settings, and apply the delegated-task-mode default
 * correction. Mutates `deps.config` in place via
 * `mergeRuntimeSettingsFromDb` and (when triggered) the default
 * correction.
 */
export function initDatabase(deps: BootstrapDbDeps): BootstrapDbResult {
  const { config } = deps;

  const db = createDatabase(config);
  applySchema(db);

  // Merge DB-persisted runtime settings into `config` BEFORE resolving
  // `contextDir`. Settings like `vaultMode` and `primaryVaultPath` live
  // in the `settings` table; without this merge `getContextDir(config)`
  // sees only env defaults — typically `vaultMode="plain"` — and would
  // resolve to `<dataDir>/context/` even for users whose persisted
  // configuration points at an Obsidian vault.
  //
  // The context-vault-restructure migration (0004) consumes that
  // `contextDir` to walk the user's actual vault, so this ordering is
  // load-bearing: if settings merged AFTER `runMigrations`, the
  // migration body would walk the wrong directory on every Obsidian
  // install. CONTEXT_VAULT_REDESIGN_PLAN.md §11.8 + V21 (boot-order
  // fix). The `settings` table is created by `applySchema` above, so
  // reading from it pre-migration is safe; no existing migration ALTERs
  // the `settings` columns.
  const { settingsStore, persistedSettings } = loadPersistedSettings({
    db,
    config,
  });

  // Run any forward-only ALTER / backfill migrations the consolidated
  // CREATE IF NOT EXISTS script in `applySchema` can't express. Empty on
  // steady-state boots and on fresh installs (the schema is already at
  // head); records ids in `schema_migrations` so this stays a no-op once
  // applied. A failing migration throws — startup aborts intentionally
  // so we never run with a half-migrated DB.
  const contextDir = getContextDir(config);

  // CONTEXT_VAULT_REDESIGN_PLAN.md §11.3.4 / V16 — Obsidian consent gate.
  // When the vault root lives inside the user's Obsidian vault, the
  // restructure reorganizes folders the user sees in their Obsidian
  // sidebar. We defer the migration until the user explicitly consents
  // (via env, dashboard, or CLI). Plain-mode vaults bypass this gate.
  const consent = resolveVaultRestructureConsent({
    db,
    dataDir: config.dataDir,
    contextDir,
  });

  runMigrations(db, {
    ctx: {
      dataDir: config.dataDir,
      contextDir,
    },
    migrations: consent.migrationsToRun,
  });

  if (consent.deferred) {
    logger.warn(
      {
        contextDir,
        ackEnvVar: "PA_VAULT_RESTRUCTURE_ACK",
      },
      "Context vault restructure deferred: Obsidian-mode vault requires explicit consent before reorganizing the sidebar. Set PA_VAULT_RESTRUCTURE_ACK=1 and restart, or confirm via the dashboard (POST /api/setup/vault-restructure-ack).",
    );
  } else {
    // Either migration applied (or was a no-op) — pending-consent state
    // is no longer relevant.
    clearVaultRestructurePendingConsent(db);
  }

  // CONTEXT_VAULT_REDESIGN_PLAN.md §11.8 + §11.10 — post-migration
  // preflight. The `schema_migrations` row covers same-DB re-runs; the
  // filesystem marker covers DB-restored-from-backup scenarios where
  // the row is present but the filesystem is from an older snapshot.
  //
  // Three outcomes must be handled distinctly:
  //   - "noop": marker == VAULT_LAYOUT_VERSION → vault is canonical.
  //   - "run-migration": marker missing or stale BUT schema_migrations
  //       already records the id → `runMigrations` above is a no-op so
  //       the file body never ran. This is the DB-restored-from-backup
  //       case the plan calls out. Re-invoke the runner directly; it
  //       is idempotent (skip-if-target-exists per manifest entry,
  //       per-pair JSON rewrites already at rowsRewritten=0) so a
  //       fully-canonical FS is a fast no-op that just writes the
  //       marker. A partially-restored FS converges to canonical.
  //   - "throw-unknown-version": marker holds a value the runner
  //       does not recognise. Hard fail — refuse to boot.
  //
  // V16: when the migration is deferred for Obsidian consent we skip
  // the recovery reinvoke too — otherwise the deferral would be
  // immediately undone by the "marker missing → reinvoke runner" path.
  const assessment = assessVaultVersion({ contextDir });
  if (assessment.action === "throw-unknown-version") {
    throw new Error(
      `Context vault version marker is unrecognised: ${JSON.stringify(assessment.observedVersion)}. Refusing to boot.`,
    );
  }
  if (assessment.action === "run-migration" && !consent.deferred) {
    logger.warn(
      { contextDir, observedVersion: assessment.observedVersion },
      "Context vault marker missing or stale but schema_migrations row present — running idempotent reconciliation",
    );
    runContextVaultRestructure({
      db,
      dataDir: config.dataDir,
      contextDir,
    });
  }

  initWikiTokenResolver(db);

  // WIKI_BUILDER_DESIGN.md §P4.A — boot-time FTS backfill. The
  // `fts_wiki` virtual table is content-less and lives outside the
  // mail-style trigger chain (the source is the filesystem, not a SQL
  // table), so a fresh DB or a workspace seeded before P4 landed needs
  // a one-shot rebuild. Per-workspace gate inside `backfillWikiFulltext`
  // keeps this near-free in steady state.
  backfillWikiFulltext(db, listWikiWorkspaces(db));

  // §12 ("managed_tasks.id collision after restore from backup") — ensure
  // `managed_task_seq.next_id` is greater than the max existing mt id so a
  // backup-restored DB cannot collide with the seq counter on the next
  // POST. No-op when the table is empty (steady-state cost: one SELECT).
  bootstrapManagedTaskSeq(db);

  // BROWSER_TASK_REDESIGN_PLAN.md §6.5 — flip every non-terminal
  // browser_task row to (failed, 'daemon_restarted', now()). The
  // in-memory BrowserContext + slot manager are unrecoverable across
  // restarts; the per-task DM intent is logged at warn-level here
  // because at this stage of boot we do not yet hold a `sendNotification`
  // handle. `index.ts` later picks the affected ids out of the
  // `agent_actions` log via `boot_recovery_browser_task` (or via the
  // returned summary if a future bootstrap factory passes a sender
  // through). For now: log + WARN so the operator can grep the boot
  // line and a per-row reconciliation tool can fan DMs separately.
  surfaceBrowserTaskBootRecovery(db);

  closeOrphanedDashboardChatSessions(db);

  // Chat attachment store — constructed early so adapter reload functions
  // can reference it in closure without TypeScript "used before declaration"
  // issues at the `index.ts` call site.
  const attachmentStore = new AttachmentStore(db, config.dataDir);
  attachmentStore.reapOrphans(24);

  void new PriceFetcher(config.dataDir, db).refresh();

  // NOTE: `loadPersistedSettings` ran earlier (immediately after
  // `applySchema`) so `runMigrations` could see DB-persisted vaultMode /
  // primaryVaultPath when resolving `contextDir`. The legacy position
  // here is intentionally not restored — re-running the merge would be
  // a wasted DB read, and any consumer between then and now relies on
  // the already-merged config.

  try {
    seedGitProjectDocTemplates(config.dataDir, config.workspaceDir);
  } catch (err) {
    logger.warn({ err }, "Failed to seed git project document templates");
  }

  applyDelegatedTaskModeDefaultCorrection({
    db,
    config,
    settingsStore,
    persistedSettings,
  });

  // SCHEDULE_API_REDESIGN_PLAN §9 — surface pre-Phase-D rows whose
  // `model` column holds a full registered id but whose `backend_id`
  // is NULL. The scheduler's override branch (§4.3a) needs BOTH
  // columns together, so such rows were already silently dropped at
  // dispatch time before Phase D landed; this audit row gives the
  // operator a `aitne audit --type schedule.legacy_model` handle to
  // discover and PATCH them.
  surfaceLegacyModelRows(db);

  return { db, settingsStore, persistedSettings, attachmentStore };
}

export interface WikiWorkspaceTokens {
  vault_path: string;
  language: string;
  workspace_name: string;
  schema_version: string;
}

export type WikiTokenResolver = (
  processKey: string,
  workspaceName?: string,
) => WikiWorkspaceTokens | null;

/**
 * Pure factory for the wiki workspace token resolver — separated from the
 * `setWikiWorkspaceTokenResolver` side effect so peer tests can pin the
 * lookup logic without going through the `skills-compiler.ts` singleton.
 *
 * Matches the per-event lookup in `context-builder.ts`: prefer the named
 * workspace, fall back to the default. Without this, multi-workspace
 * installs would render the `<wiki_workspace>` XML against the target
 * workspace while skill prose (`{{vault_path}}` etc.) referenced the
 * default — the agent would then operate on the wrong vault.
 */
export function createWikiTokenResolver(db: Database.Database): WikiTokenResolver {
  return (processKey, workspaceName) => {
    if (!processKey.startsWith("wiki.")) return null;
    const workspace =
      (workspaceName ? readWikiWorkspaceByName(db, workspaceName) : null)
      ?? readDefaultWikiWorkspace(db);
    if (!workspace) return null;
    return {
      vault_path: workspace.root_path,
      language: workspace.language,
      workspace_name: workspace.name,
      schema_version: String(workspace.schema_version),
    };
  };
}

/**
 * Register the per-process wiki workspace token resolver consumed by
 * `skills-compiler.ts`. Idempotent: replacing the resolver simply
 * re-points the singleton at the new DB handle.
 */
export function initWikiTokenResolver(db: Database.Database): void {
  setWikiWorkspaceTokenResolver(createWikiTokenResolver(db));
}

/**
 * Close any `dashboard_chat` sessions that were left `status='active'`
 * from before the daemon restart. They cannot be resumed cleanly: the
 * SSE channel is gone and `Dispatcher.currentSetupMode` is in-process
 * state lost on restart, so a setup conversation half-way through would
 * otherwise be re-adopted by `findActiveDashboardSessionId` and processed
 * as regular chat against stale prompts. The setup wizard's resume path
 * on the client-side checks active status; closing here flips the check
 * so the wizard correctly falls through to a fresh `/setup/start`.
 *
 * Best-effort: logs and returns 0 on failure (a DB that can't accept this
 * one UPDATE has bigger problems that downstream steps will surface).
 */
export function closeOrphanedDashboardChatSessions(
  db: Database.Database,
): number {
  try {
    const result = db
      .prepare(
        `UPDATE conversation_sessions
         SET status = 'closed'
         WHERE scope = 'dashboard_chat' AND status = 'active'`,
      )
      .run();
    if (result.changes > 0) {
      logger.info(
        { closed: result.changes },
        "Closed orphaned dashboard_chat sessions from previous run",
      );
    }
    return result.changes;
  } catch (err) {
    logger.warn({ err }, "Failed to close orphaned dashboard_chat sessions");
    return 0;
  }
}

export interface LoadPersistedSettingsDeps {
  readonly db: Database.Database;
  readonly config: AgentConfig;
}

export interface LoadPersistedSettingsResult {
  readonly settingsStore: SettingsStore;
  readonly persistedSettings: Partial<RuntimeSettings>;
}

/**
 * Construct the `SettingsStore`, read its current snapshot, and merge
 * the persisted values on top of the env-derived `config`. Mutates
 * `deps.config` in place via `mergeRuntimeSettingsFromDb`.
 */
export function loadPersistedSettings(
  deps: LoadPersistedSettingsDeps,
): LoadPersistedSettingsResult {
  const settingsStore = createSettingsStore(deps.db);
  const persistedSettings = settingsStore.getAll();
  mergeRuntimeSettingsFromDb(deps.config, persistedSettings);
  return { settingsStore, persistedSettings };
}

export interface DelegatedTaskModeCorrectionDeps {
  readonly db: Database.Database;
  readonly config: AgentConfig;
  readonly settingsStore: SettingsStore;
  readonly persistedSettings: Partial<RuntimeSettings>;
}

/**
 * Default-correction for `delegatedTaskModeEnabled`.
 *
 * The legacy `/integrations/:key/invoke` RPC was retired 2026-05-01 and
 * every delegated skill / task flow now goes through `/exec`, which is
 * gated by this flag. Its Phase-1 canary default of `false` is now a
 * footgun: any user with delegated integrations from before the runtime
 * PATCH-time auto-enable landed will hit 503 on every /exec call.
 *
 * Heal once at boot, only when the operator never explicitly chose:
 *   - `delegatedTaskModeEnabled` row is *absent* from settings (the
 *     `in` check distinguishes "never set" from "explicitly false"),
 *   - and at least one integration is currently in `delegated` mode.
 *
 * An explicit `false` row in `settings` is treated as operator intent
 * and respected — emergency-disable still works.
 */
/**
 * SCHEDULE_API_REDESIGN_PLAN §9 — one-time scan emitting one
 * `agent_actions.action_type='schedule.legacy_model'` row per
 * pre-Phase-D agent_schedule / recurring_schedules row whose `model`
 * column holds a full registered model id but whose `backend_id`
 * column is NULL.
 *
 * The Phase-D scheduler's override branch (§4.3a) requires BOTH
 * columns together — so such rows were already silently dropped at
 * dispatch time before Phase D landed; this scan does not change the
 * runtime behavior of those rows, it merely surfaces them via the
 * audit log so the operator can PATCH them (or `DELETE` if the row
 * is obsolete). Idempotent in steady state: subsequent boots find no
 * matching rows and the SELECT returns 0 rows.
 *
 * The audit row's `result='skipped'` mirrors the dispatcher's
 * effective behavior — the row pin is being skipped because the
 * column tuple is incomplete. `detail` carries the row id, the
 * registered model id, and the table so a `--format=json` audit
 * dump retains everything the operator needs to reach the row.
 *
 * Emits at most 200 rows per boot to bound the audit-log impact on
 * a hypothetically badly-migrated DB; the operator sees the count
 * via `aitne audit --type schedule.legacy_model --limit 0`.
 */
function surfaceLegacyModelRows(db: Database.Database): void {
  type LegacyRow = { source: string; id: number; model: string };
  const stmt = db.prepare(`
    SELECT 'agent_schedule' AS source, id, model
      FROM agent_schedule
     WHERE model IS NOT NULL
       AND backend_id IS NULL
       AND model NOT IN ('sonnet', 'opus')
    UNION ALL
    SELECT 'recurring_schedules' AS source, id, model
      FROM recurring_schedules
     WHERE model IS NOT NULL
       AND backend_id IS NULL
       AND model NOT IN ('sonnet', 'opus')
    LIMIT 200
  `);
  let rows: LegacyRow[];
  try {
    rows = stmt.all() as LegacyRow[];
  } catch (err) {
    // Defensive — agent_schedule / recurring_schedules pre-date Phase D
    // and `applySchema(db)` re-applied above ensures the columns exist,
    // but a hand-crafted test DB might skip one. Log and bail.
    /* c8 ignore start */
    logger.warn(
      { err },
      "surfaceLegacyModelRows: SELECT failed — schema likely partial; skipping the audit emission",
    );
    return;
    /* c8 ignore stop */
  }
  if (rows.length === 0) return;

  const insert = db.prepare(`
    INSERT INTO agent_actions (action_type, detail, result, started_at, completed_at)
    VALUES (?, ?, 'skipped', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `);
  const tx = db.transaction((batch: LegacyRow[]) => {
    for (const row of batch) {
      insert.run(
        "schedule.legacy_model",
        JSON.stringify({
          table: row.source,
          rowId: row.id,
          model: row.model,
          remediation:
            "PATCH the row's `model` to a registered alias/tier, or DELETE if obsolete. Phase D requires (model, backend_id) together for the dispatcher's override block to apply the pin — backend_id IS NULL drops the pin silently.",
        }),
      );
    }
  });
  tx(rows);

  logger.warn(
    { count: rows.length },
    "Found pre-Phase-D schedule rows with a full model id but no backend_id companion — see `aitne audit --type schedule.legacy_model`",
  );
}

/**
 * BROWSER_TASK_REDESIGN_PLAN.md §6.5 boot-recovery — flip every
 * non-terminal `browser_task` row to `failed (daemon_restarted)` and
 * emit a single `agent_actions(action_type='browser_task.boot_recovery')`
 * row per affected task so the operator can DM-fan them out post-boot
 * via a reconciliation tool. We do NOT call the sender here because
 * the messaging adapters are still constructing at this stage of boot.
 *
 * Pure SQL UPDATE inside `sweepNonTerminalRowsForBootRecovery`; this
 * wrapper handles the audit-row emission + the log line. Exported so
 * a peer test can exercise both branches (no rows vs. some rows).
 */
export function surfaceBrowserTaskBootRecovery(db: Database.Database): number {
  let affected: readonly { id: string; originatingChannel: string | null }[];
  try {
    affected = sweepNonTerminalRowsForBootRecovery(db, Date.now());
  } catch (err) {
    /* c8 ignore start -- the schema script creates the table; this catch
     * exists for defence-in-depth against a hand-crafted partial DB. */
    logger.warn(
      { err },
      "surfaceBrowserTaskBootRecovery: sweep failed — browser_task table likely missing; skipping",
    );
    return 0;
    /* c8 ignore stop */
  }
  if (affected.length === 0) return 0;
  const insert = db.prepare(`
    INSERT INTO agent_actions (action_type, detail, result, started_at, completed_at)
    VALUES (?, ?, 'success', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `);
  const tx = db.transaction(
    (batch: readonly { id: string; originatingChannel: string | null }[]) => {
      for (const row of batch) {
        insert.run(
          "browser_task.boot_recovery",
          JSON.stringify({
            taskId: row.id,
            originatingChannel: row.originatingChannel,
            reason: "daemon_restarted",
            remediation:
              "DM the originating channel that the task was running when the daemon restarted and could not resume. Future revisions may checkpoint state to disk to enable resume.",
          }),
        );
      }
    },
  );
  tx(affected);
  logger.warn(
    { count: affected.length },
    "browser-task boot recovery — non-terminal rows flipped to failed(daemon_restarted)",
  );
  return affected.length;
}

export function applyDelegatedTaskModeDefaultCorrection(
  deps: DelegatedTaskModeCorrectionDeps,
): void {
  const { db, config, settingsStore, persistedSettings } = deps;
  if ("delegatedTaskModeEnabled" in persistedSettings) return;
  if (config.delegatedTaskModeEnabled) return;

  const integrationsAtBoot = readIntegrations(db);
  const delegatedKeys = Object.entries(integrationsAtBoot)
    .filter(([, state]) => state.mode === "delegated")
    .map(([key]) => key);
  if (delegatedKeys.length === 0) return;

  try {
    settingsStore.set("delegatedTaskModeEnabled", true);
    config.delegatedTaskModeEnabled = true;
    logger.info(
      { delegatedKeys },
      "auto-enabled delegatedTaskModeEnabled at startup — delegated integrations exist and the flag was never explicitly set",
    );
  } catch (err) {
    logger.error(
      { err, delegatedKeys },
      "startup auto-enable of delegatedTaskModeEnabled failed; /exec calls may continue to 503 until PATCH /api/config sets the flag",
    );
  }
}
