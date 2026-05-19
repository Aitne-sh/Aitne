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
 *  2. Register the wiki workspace token resolver so skill compilation can
 *     resolve `<wiki_workspace>` tokens via the DB.
 *  3. Backfill the content-less `fts_wiki` virtual table once per workspace.
 *  4. Bump `managed_task_seq.next_id` past any restored backup rows.
 *  5. Close orphaned `dashboard_chat` sessions left active by a crash so
 *     the setup wizard's resume gate flips correctly on next dashboard load.
 *  6. Construct the chat `AttachmentStore` (top-level so adapter reloaders
 *     can capture it in closure) and reap orphan rows.
 *  7. Fire-and-forget price refresh (best-effort, network call).
 *  8. Load persisted `settings` rows and merge them on top of env defaults.
 *  9. Best-effort seed of git-project document templates (filesystem write).
 *  10. Heal the `delegatedTaskModeEnabled` Phase-1 canary default for users
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

import type Database from "better-sqlite3";
import type { AgentConfig } from "../config.js";
import { mergeRuntimeSettingsFromDb } from "../config.js";
import { createDatabase } from "../db/client.js";
import { applySchema } from "../db/schema.js";
import { readIntegrations } from "../db/integrations-store.js";
import { bootstrapManagedTaskSeq } from "../db/managed-tasks-store.js";
import { setWikiWorkspaceTokenResolver } from "../core/skills-compiler.js";
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

  closeOrphanedDashboardChatSessions(db);

  // Chat attachment store — constructed early so adapter reload functions
  // can reference it in closure without TypeScript "used before declaration"
  // issues at the `index.ts` call site.
  const attachmentStore = new AttachmentStore(db, config.dataDir);
  attachmentStore.reapOrphans(24);

  void new PriceFetcher(config.dataDir, db).refresh();

  const { settingsStore, persistedSettings } = loadPersistedSettings({
    db,
    config,
  });

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
