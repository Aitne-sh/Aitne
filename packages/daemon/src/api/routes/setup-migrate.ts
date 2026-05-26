import { Hono } from "hono";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import type Database from "better-sqlite3";
import type { AgentConfig, FsInfo } from "../../config.js";
import { getContextDir, getFsInfo, validatePrimaryVaultPath } from "../../config.js";
import type { SettingsStore } from "../../settings/settings-store.js";
import {
  ContextWriteGate,
  MigrationLock,
} from "../../core/today-write-lock.js";
import type { ObserverManager } from "../../observers/manager.js";
import type { EventBus } from "../../core/event-bus.js";
import type { InFlightExecutionInfo } from "../../core/dispatcher.js";
import {
  createBackup,
  finalizeBackup,
  inspectTarget,
  listTopLevel,
  MigrationFsError,
  moveTree,
  resolveConflictPolicy,
  restoreFromBackup,
  restoreOverwrittenTargetEntries,
  stashOverwrittenTargetEntries,
  verifyMoveCompleted,
  type BackupResult,
  type ConflictPolicy,
} from "../../core/migration-backup.js";
import { rewritePathsInDb } from "../../core/path-rewrite.js";
import { clearDegradedMode, isSetupCompleted } from "../../db/runtime-state.js";
import { ensureSkeletonFiles } from "../../core/skeleton.js";
import { createLogger } from "../../logging.js";

const logger = createLogger("setup-migrate");

/**
 * Management Mode Phase 2 — the `/api/setup/migrate-context` endpoint.
 *
 * Orchestrates the atomic move of the primary context directory from
 * its current location to a user-chosen one (plain → obsidian,
 * obsidian A → obsidian B, or obsidian → plain).
 *
 * Execution order (plan §6.2 – §6.10):
 *   1. validate request + current state
 *   2. active-session check (no in-flight work)
 *   3. acquire migrationLock (reject concurrent migrations with 409)
 *   4. engage globalContextWriteGate — all context writes now 503
 *   5. pause observers + event bus dispatch
 *   6. resolve conflict policy against target
 *   7. create backup (hardlink same-fs; copy cross-fs)
 *   8. move tree
 *   9. DB path rewrite (single transaction)
 *  10. settings update (vaultMode + primaryVaultPath + primaryVaultName)
 *  11. refresh in-memory config
 *  12. finalize backup (break hardlinks for retention)
 *  13. resume event bus + observers
 *  14. disengage gate + release lock
 *
 * Any step from 7 onward that fails triggers restoration from backup
 * and a structured error response with `backupPath` so the user can
 * audit. The backup ledger row (`migration_backups`) tracks status so
 * the daily retention cron can sweep completed backups after 7 days.
 */

export interface MigrateDeps {
  db: Database.Database;
  config: AgentConfig;
  settingsStore: SettingsStore;
  migrationLock: MigrationLock;
  contextWriteGate: ContextWriteGate;
  observerManager?: ObserverManager;
  eventBus?: EventBus;
  eventBroadcaster?: {
    broadcastNamedEvent: (event: string, data: unknown) => void | Promise<void>;
  };
  getInFlightExecutions?: () => InFlightExecutionInfo[];
  /**
   * Invoked after `commitVaultSettings` with the new primary-vault
   * path (`null` for plain mode). Wiring for path-sensitive observers
   * — specifically `PrimaryVaultWatcher` — relies on this callback so
   * the watcher re-targets explicitly instead of peeking at a mutable
   * `AgentConfig`. Asynchronous because restart involves closing a
   * chokidar subscription; errors are logged but do not roll back a
   * successful migration.
   */
  onPrimaryVaultPathChange?: (newPath: string | null) => void | Promise<void>;
  /** Override the settle delay for tests. Omitted in production. */
  settleDelayMs?: number;
}

type MigrationErrorCode =
  | "invalid_request"
  | "target_invalid"
  | "noop"
  | "sessions_active"
  | "executions_active"
  | "migration_in_progress"
  | "target_has_unrelated_files"
  | "target_has_agent_file_conflicts"
  | "backup_failed"
  | "move_failed"
  | "move_verification_failed"
  | "db_rewrite_failed"
  | "settings_update_failed"
  | "cross_fs_partial_failure"
  | "icloud_file_evicted"
  | "internal_error";

/**
 * How long to wait after pausing observers + EventBus dispatch for any
 * in-flight cron tick to settle (plan §6.2 step 4). Configurable so
 * tests can override to 0; production default 1s is sufficient because
 * all known cron handlers either stop immediately (observer pollers)
 * or enqueue to the paused EventBus (schedule watcher / hourly check).
 *
 * Plan says "up to 10s" but that's a ceiling; shorter is fine when no
 * cron handler is known to block for that long.
 */
const DEFAULT_SETTLE_DELAY_MS = 1000;

type ValidationConflictKind =
  | "target_has_unrelated_files"
  | "target_has_agent_file_conflicts";

interface ValidationConflict {
  kind: ValidationConflictKind;
  entries: string[];
  allowedPolicies: ConflictPolicy[];
}

type ContextMigrationProgressPhase =
  | "preflight"
  | "backup"
  | "move"
  | "verify"
  | "db_rewrite"
  | "settings_update"
  | "skeleton_seed"
  | "resume"
  | "completed"
  | "failed";

interface ContextMigrationProgressEvent {
  type: "context_migration_progress";
  phase: ContextMigrationProgressPhase;
  status: "running" | "completed" | "failed";
  message: string;
  target: string;
  progress: number;
  timestamp: string;
}

function expandHome(p: string): string {
  if (p.startsWith("~/") || p.startsWith("~\\")) {
    return resolve(homedir(), p.slice(2));
  }
  return resolve(p);
}

function validateMigrationTargetPath(
  rawPath: string,
  config: Pick<AgentConfig, "dataDir" | "externalObsidianVaultPath">,
  options: { collectFsInfo: boolean },
):
  | { ok: true; targetDir: string; fsInfo: FsInfo | null }
  | {
      ok: false;
      status: 400;
      body: {
        error: "target_invalid";
        message: string;
        detail?: string;
      };
    } {
  const expanded = expandHome(rawPath);
  const validation = validatePrimaryVaultPath(
    expanded,
    {
      dataDir: config.dataDir,
      externalObsidianVaultPath: config.externalObsidianVaultPath,
    },
    {
      autoCreate: false,
      allowMissingLeaf: true,
      collectFsInfo: options.collectFsInfo,
    },
  );
  if (!validation.ok) {
    return {
      ok: false,
      status: 400,
      body: {
        error: "target_invalid",
        message: validation.message ?? "Target path failed validation.",
        detail: validation.error,
      },
    };
  }
  return {
    ok: true,
    targetDir: expanded,
    fsInfo: validation.fsInfo ?? null,
  };
}

function describeTargetConflict(
  report: ReturnType<typeof inspectTarget>,
): ValidationConflict | null {
  if (report.agentFileConflicts.length > 0) {
    return {
      kind: "target_has_agent_file_conflicts",
      entries: report.agentFileConflicts,
      allowedPolicies: ["overwrite_agent_files"],
    };
  }
  if (report.foreignEntries.length > 0) {
    return {
      kind: "target_has_unrelated_files",
      entries: report.foreignEntries,
      allowedPolicies: ["merge", "overwrite_agent_files"],
    };
  }
  return null;
}

export function createSetupMigrateRoutes(deps: MigrateDeps): Hono {
  const app = new Hono();
  const {
    db,
    config,
    settingsStore,
    migrationLock,
    contextWriteGate,
    observerManager,
    eventBus,
    eventBroadcaster,
    getInFlightExecutions,
  } = deps;
  const settleDelayMs = deps.settleDelayMs ?? DEFAULT_SETTLE_DELAY_MS;

  const emitProgress = async (
    phase: ContextMigrationProgressPhase,
    status: ContextMigrationProgressEvent["status"],
    target: string,
    progress: number,
    message: string,
  ): Promise<void> => {
    try {
      await eventBroadcaster?.broadcastNamedEvent("context_migration_progress", {
        type: "context_migration_progress",
        phase,
        status,
        message,
        target,
        progress,
        timestamp: new Date().toISOString(),
      } satisfies ContextMigrationProgressEvent);
    } catch (err) {
      logger.warn({ err, phase, target }, "Failed to broadcast migration progress");
    }
  };

  /**
   * POST /setup/reseed-skeleton — manual recovery endpoint for the
   * case where the post-migration skeleton seed failed silently (e.g.
   * `agent-assets/templates/` was not locatable on the daemon host).
   * Idempotent: `ensureSkeletonFiles` preserves existing files, so
   * hitting this more than once is safe. Body takes no parameters —
   * the target is always the currently-configured `getContextDir`.
   *
   * Returns `{ status: "seeded", contextDir, templatesUsed }` where
   * `templatesUsed` is `false` if the templates tree could not be
   * located (only canonical directories + placeholders were written).
   */
  app.post("/setup/reseed-skeleton", async (c) => {
    const contextDir = getContextDir(config);
    try {
      ensureSkeletonFiles(contextDir, config.workspaceDir, {
        skipManagementRules: !isSetupCompleted(db),
      });
    } catch (err) {
      logger.error({ err, contextDir }, "Manual reseed failed");
      return c.json(
        {
          error: "reseed_failed" as const,
          message:
            err instanceof Error ? err.message : "Unknown reseed error",
        },
        500,
      );
    }
    // Best-effort detection of whether templates were applied vs. only
    // placeholders — checked by looking for a representative template
    // file. `policies/redaction.md` (post-CONTEXT_VAULT_REDESIGN) is the
    // canonical post-migration target; the legacy `rules/redaction.md` // drift-allow
    // is still recognized so a vault that has not yet been migrated by
    // the 0004 migration also flips this flag correctly.
    const templatesUsed =
      existsSync(join(contextDir, "policies", "redaction.md")) ||
      existsSync(join(contextDir, "rules", "redaction.md"));
    return c.json({
      status: "seeded" as const,
      contextDir,
      templatesUsed,
    });
  });

  app.post("/setup/validate-vault-path", async (c) => {
    let body: {
      targetVaultMode?: unknown;
      targetVaultPath?: unknown;
    };
    try {
      body = await c.req.json();
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return c.json({ error: "invalid_request", message: `Invalid JSON: ${detail}` }, 400);
    }

    const targetVaultMode = body.targetVaultMode;
    if (targetVaultMode !== "plain" && targetVaultMode !== "obsidian") {
      return c.json(
        {
          error: "invalid_request" satisfies MigrationErrorCode,
          message: "targetVaultMode must be 'plain' or 'obsidian'.",
        },
        400,
      );
    }

    if (targetVaultMode === "plain") {
      return c.json({
        ok: true,
        targetDir: resolve(config.dataDir, "context"),
        fsInfo: null,
        conflict: null,
      });
    }

    if (typeof body.targetVaultPath !== "string" || body.targetVaultPath.length === 0) {
      return c.json(
        {
          error: "invalid_request" satisfies MigrationErrorCode,
          message: "targetVaultPath is required for 'obsidian' mode.",
        },
        400,
      );
    }

    const targetValidation = validateMigrationTargetPath(body.targetVaultPath, config, {
      collectFsInfo: true,
    });
    if (!targetValidation.ok) {
      return c.json(targetValidation.body, targetValidation.status);
    }

    const sourceDir = getContextDir(config);
    const targetReport = inspectTarget(
      targetValidation.targetDir,
      listTopLevel(sourceDir),
    );

    return c.json({
      ok: true,
      targetDir: targetValidation.targetDir,
      fsInfo: targetValidation.fsInfo,
      conflict: describeTargetConflict(targetReport),
    });
  });

  app.post("/setup/migrate-context", async (c) => {
    let body: {
      targetVaultMode?: unknown;
      targetVaultPath?: unknown;
      conflictPolicy?: unknown;
    };
    try {
      body = await c.req.json();
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return c.json({ error: "invalid_request", message: `Invalid JSON: ${detail}` }, 400);
    }

    const targetVaultMode = body.targetVaultMode;
    if (targetVaultMode !== "plain" && targetVaultMode !== "obsidian") {
      return c.json(
        {
          error: "invalid_request" satisfies MigrationErrorCode,
          message: "targetVaultMode must be 'plain' or 'obsidian'.",
        },
        400,
      );
    }

    let targetVaultPathInput: string | null = null;
    if (targetVaultMode === "obsidian") {
      if (typeof body.targetVaultPath !== "string" || body.targetVaultPath.length === 0) {
        return c.json(
          {
            error: "invalid_request" satisfies MigrationErrorCode,
            message: "targetVaultPath is required for 'obsidian' mode.",
          },
          400,
        );
      }
      targetVaultPathInput = body.targetVaultPath;
    }

    const conflictPolicy = (body.conflictPolicy ?? "abort") as ConflictPolicy;
    if (
      conflictPolicy !== "abort"
      && conflictPolicy !== "merge"
      && conflictPolicy !== "overwrite_agent_files"
    ) {
      return c.json(
        {
          error: "invalid_request" satisfies MigrationErrorCode,
          message: "conflictPolicy must be 'abort', 'merge', or 'overwrite_agent_files'.",
        },
        400,
      );
    }

    // Resolve source (current context dir) and target.
    const sourceDir = getContextDir(config);
    let targetDir: string;
    if (targetVaultMode === "obsidian" && targetVaultPathInput) {
      const targetValidation = validateMigrationTargetPath(targetVaultPathInput, config, {
        collectFsInfo: false,
      });
      if (!targetValidation.ok) {
        return c.json(targetValidation.body, targetValidation.status);
      }
      targetDir = targetValidation.targetDir;
    } else {
      targetDir = resolve(config.dataDir, "context");
    }

    // Noop short-circuit — both path AND mode already match. The
    // {source, target} pair can only collide when both modes equal
    // plain (obsidian mode's validator rejects paths inside dataDir,
    // so an obsidian target can never coincide with the plain default).
    if (sourceDir === targetDir && config.vaultMode === targetVaultMode) {
      return c.json({
        status: "noop",
        from: sourceDir,
        to: targetDir,
      });
    }

    // Active-session / in-flight execution check (first pass —
    // informative, avoids paying for the lock/gate/pause cycle when
    // we're obviously blocked).
    const checkActiveSessions = () =>
      db
        .prepare(
          "SELECT id, scope, scope_key FROM conversation_sessions WHERE status = 'active'",
        )
        .all() as Array<{ id: number; scope: string; scope_key: string }>;
    const checkRunningScheduledExecutions = () =>
      db
        .prepare(
          `SELECT id, task_type, task_description
             FROM agent_schedule
            WHERE status = 'running'`,
        )
        .all() as Array<{ id: number; task_type: string; task_description: string }>;
    const checkExecutionBlockers = () => {
      const scheduledExecutions: InFlightExecutionInfo[] = checkRunningScheduledExecutions()
        .map((row) => ({
          kind: "scheduled_task",
          id: row.id,
          taskType: row.task_type,
          detail: row.task_description,
        }));
      const seen = new Set<string>();
      const combined = [
        ...scheduledExecutions,
        ...(getInFlightExecutions?.() ?? []),
      ];
      return combined.filter((entry) => {
        const key = JSON.stringify(entry);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    };

    const activeSessions = checkActiveSessions();
    const activeExecutions = checkExecutionBlockers();
    if (activeSessions.length > 0 || activeExecutions.length > 0) {
      return c.json(
        {
          error: (
            activeSessions.length > 0 ? "sessions_active" : "executions_active"
          ) satisfies MigrationErrorCode,
          message:
            activeSessions.length > 0
              ? "Active sessions block migration. Wait for them to close."
              : "In-flight executions block migration. Wait for them to finish.",
          sessions: activeSessions,
          executions: activeExecutions,
        },
        409,
      );
    }

    // Acquire the migration lock. A second concurrent migrate gets 409.
    const lock = migrationLock.acquire();
    if (!lock.ok) {
      return c.json(
        {
          error: "migration_in_progress" satisfies MigrationErrorCode,
          message: "A migration is already running.",
        },
        409,
      );
    }

    // From here on, every early return MUST release the lock + gate + resume observers.
    contextWriteGate.engage("migration_in_progress");

    // Second active-session check, this time AFTER the lock is held and
    // the write gate is engaged. Closes the race where an adapter accepts
    // an inbound DM in the window between the first SELECT and our pause
    // calls; a session landing there would begin executing against the
    // old contextDir right as we move files out from under it. The lock
    // alone doesn't stop dispatch — this re-check does.
    const racedSessions = checkActiveSessions();
    const racedExecutions = checkExecutionBlockers();
    if (racedSessions.length > 0 || racedExecutions.length > 0) {
      contextWriteGate.disengage();
      migrationLock.release(lock.lockId);
      return c.json(
        {
          error: (
            racedSessions.length > 0 ? "sessions_active" : "executions_active"
          ) satisfies MigrationErrorCode,
          message:
            racedSessions.length > 0
              ? "A session started during migration setup. Wait for sessions to close and retry."
              : "An execution started during migration setup. Wait for it to finish and retry.",
          sessions: racedSessions,
          executions: racedExecutions,
        },
        409,
      );
    }

    // Snapshot pre-migration settings for rollback.
    const previousSettings = {
      vaultMode: config.vaultMode,
      primaryVaultPath: config.primaryVaultPath,
      primaryVaultName: config.primaryVaultName,
    };

    let observersPaused = false;
    let dispatchPaused = false;
    let backup: BackupResult | null = null;
    let backupRowId: number | null = null;
    let moveCompleted = false;
    const startedAt = Date.now();

    // Snapshot of target's pre-existing top-level entries. Captured
    // BEFORE the move so rollback can remove only what we added and
    // leave the user's pre-existing content (notably `.obsidian/`)
    // intact. Without this, a failed move + rmSync(targetDir) would
    // wipe an Obsidian workspace state that never participated in the
    // migration.
    let preExistingTargetEntries: Set<string> | null = null;
    // Names of target-side files that `overwrite_agent_files` would
    // destroy; stashed into the backup before the move so a failed
    // migration can restore the user's pre-existing versions.
    let overwrittenEntries: string[] = [];
    let cleanupComplete = false;

    const classifyFsError = (
      err: unknown,
      fallbackError: Extract<
        MigrationErrorCode,
        "backup_failed" | "move_failed"
      >,
      fallbackMessage: string,
    ): {
      error: MigrationErrorCode;
      message: string;
    } => {
      if (err instanceof MigrationFsError) {
        if (err.code === "icloud_file_evicted") {
          return {
            error: "icloud_file_evicted",
            message: err.message,
          };
        }
        if (err.code === "cross_fs_partial_failure") {
          return {
            error: "cross_fs_partial_failure",
            message: err.message,
          };
        }
      }
      return { error: fallbackError, message: fallbackMessage };
    };

    const cleanupAfterMigration = async (): Promise<{ resumeFailures: string[] }> => {
      if (cleanupComplete) {
        return { resumeFailures: [] };
      }
      cleanupComplete = true;
      const resumeFailures: string[] = [];
      try {
        if (dispatchPaused && eventBus) {
          try {
            eventBus.resumeDispatch();
          } catch (err) {
            resumeFailures.push("event_bus");
            logger.error({ err }, "Failed to resume event bus");
          }
        }
        if (observersPaused && observerManager) {
          try {
            await observerManager.resumeAll();
          } catch (err) {
            resumeFailures.push("observer_manager");
            logger.error({ err }, "Failed to resume observers");
          }
        }
      } finally {
        contextWriteGate.disengage();
        migrationLock.release(lock.lockId);
      }
      return { resumeFailures };
    };

    const respondAfterCleanup = async (
      payload: Record<string, unknown>,
      status: 200 | 400 | 409 | 500,
      options: { surfaceResumeFailures?: boolean } = {},
    ) => {
      if (status !== 200) {
        await emitProgress(
          "failed",
          "failed",
          targetDir,
          100,
          typeof payload.message === "string"
            ? payload.message
            : "Migration failed.",
        );
      }
      const { resumeFailures } = await cleanupAfterMigration();
      if (options.surfaceResumeFailures && resumeFailures.length > 0) {
        payload = {
          ...payload,
          resumeStatus: "manual_required",
          manualActionRequired: true,
          message:
            "Migration committed, but observers/schedulers failed to resume. Restart the daemon.",
          resumeFailures,
        };
      }
      return c.json(payload, status);
    };

    const restoreSettingsDirectly = (settings: typeof previousSettings): void => {
      const upsert = db.prepare(
        `INSERT INTO settings (key, value_json, updated_at)
         VALUES (?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(key) DO UPDATE SET
           value_json = excluded.value_json,
           updated_at = CURRENT_TIMESTAMP`,
      );
      const tx = db.transaction(() => {
        upsert.run("vaultMode", JSON.stringify(settings.vaultMode));
        upsert.run("primaryVaultPath", JSON.stringify(settings.primaryVaultPath));
        upsert.run("primaryVaultName", JSON.stringify(settings.primaryVaultName));
      });
      tx();
      Object.assign(config, settings);
    };

    const commitVaultSettings = (
      nextVaultMode: "plain" | "obsidian",
      nextTargetDir: string,
    ): void => {
      const nextPrimaryVaultPath =
        nextVaultMode === "obsidian" ? nextTargetDir : null;
      const nextPrimaryVaultName =
        nextVaultMode === "obsidian" ? basename(nextTargetDir) : null;
      settingsStore.setMany({
        vaultMode: nextVaultMode,
        primaryVaultPath: nextPrimaryVaultPath,
        primaryVaultName: nextPrimaryVaultName,
      });
      Object.assign(config, {
        vaultMode: nextVaultMode,
        primaryVaultPath: nextPrimaryVaultPath,
        primaryVaultName: nextPrimaryVaultName,
      });
      clearDegradedMode(db);
    };

    // Seed / top up the canonical vault skeleton (B-007 §5.1) on the
    // freshly-committed target. Idempotent via
    // `copyTreePreservingExisting`, so an existing-vault move through
    // this endpoint only fills gaps and never overwrites user edits.
    // Non-fatal: the migration has already committed, so a skeleton
    // failure is logged but does not surface a 500 to the client.
    //
    // Ordering vs `finalizeBackup`: `ensureSkeletonFiles` writes new
    // file inodes at the target (or no-ops on existing ones), so it
    // never mutates the hardlinked backup. Running it here — after
    // `commitVaultSettings` and before backup finalization — means
    // `getContextDir(config)` already returns the committed path and
    // any downstream API caller observes a fully provisioned vault.
    const seedTargetSkeleton = async (nextTargetDir: string): Promise<void> => {
      await emitProgress(
        "skeleton_seed",
        "running",
        nextTargetDir,
        90,
        "Seeding the skeleton templates into the target vault…",
      );
      try {
        ensureSkeletonFiles(nextTargetDir, config.workspaceDir, {
          skipManagementRules: !isSetupCompleted(db),
        });
      } catch (err) {
        logger.warn(
          { err, targetDir: nextTargetDir, workspaceDir: config.workspaceDir },
          "skeleton seed after migration failed — vault may be missing template files",
        );
      }
    };

    // Re-target path-sensitive observers (PrimaryVaultWatcher) after
    // settings commit. The migration already paused all observers
    // earlier; firing this callback between commit and resume gives
    // the observer the authoritative new path before its `start()`
    // runs during resume. Non-fatal — an observer wiring failure must
    // not roll back a migration that otherwise succeeded.
    const notifyVaultPathChange = async (
      nextPath: string | null,
    ): Promise<void> => {
      if (!deps.onPrimaryVaultPathChange) return;
      try {
        await deps.onPrimaryVaultPathChange(nextPath);
      } catch (err) {
        logger.warn(
          { err, nextPath },
          "onPrimaryVaultPathChange callback failed — observers may be targeting a stale path",
        );
      }
    };

    const rollback = async (
      reason: string,
    ): Promise<{ rollbackStatus: "completed" | "partial" | "manual_required" }> => {
      try {
        if (moveCompleted && backup) {
          restoreFromBackup(backup, sourceDir);
          // Before deciding what to remove at target, put the user's
          // pre-existing overwritten versions BACK. This undoes the
          // irrecoverable side effect of `overwrite_agent_files`:
          // without restoring the stash, the user's original target
          // files are gone, replaced by source's versions that the
          // move wrote in their place.
          if (overwrittenEntries.length > 0) {
            try {
              restoreOverwrittenTargetEntries(backup, targetDir, overwrittenEntries);
            } catch (err) {
              logger.warn({ err }, "rollback: overwritten-target restore failed");
            }
          }
          // Remove only entries moveTree added at target. Reading the
          // post-move target and subtracting `preExistingTargetEntries`
          // (captured pre-move) yields the set we introduced; everything
          // else was the user's and must stay. If we can't read the
          // target (e.g. partial cross-fs failure left it in odd state),
          // fall back to a whole-tree rm ONLY when the target had no
          // pre-existing entries — that's the only case where rm is safe.
          try {
            if (existsSync(targetDir) && targetDir !== sourceDir) {
              const pre = preExistingTargetEntries ?? new Set<string>();
              if (pre.size === 0) {
                rmSync(targetDir, { recursive: true, force: true });
              } else {
                for (const name of readdirSync(targetDir)) {
                  if (pre.has(name)) continue;
                  try {
                    rmSync(join(targetDir, name), { recursive: true, force: true });
                  } catch (err) {
                    logger.warn(
                      { err, entry: name, targetDir },
                      "rollback: failed to remove migration-added entry",
                    );
                  }
                }
              }
            }
          } catch (err) {
            logger.warn({ err, targetDir }, "rollback: target cleanup failed");
          }
        }
        // Reapply previous settings defensively — a step that got as far
        // as settings update and then failed would have left them
        // partially applied.
        try {
          restoreSettingsDirectly(previousSettings);
        } catch (err) {
          logger.warn({ err }, "rollback: settings revert failed");
        }
        if (backupRowId !== null) {
          db.prepare(
            "UPDATE migration_backups SET status = 'rolled_back', rollback_completed_at = ? WHERE id = ?",
          ).run(new Date().toISOString(), backupRowId);
        }
        logger.warn({ reason, sourceDir, targetDir }, "Migration rollback complete");
        return { rollbackStatus: "completed" };
      } catch (err) {
        logger.error({ err, reason }, "Migration rollback failed");
        return { rollbackStatus: "manual_required" };
      }
    };

    try {
      await emitProgress(
        "preflight",
        "running",
        targetDir,
        5,
        "Pausing observers and validating the target directory…",
      );

      if (observerManager) {
        await observerManager.pauseAll();
        observersPaused = true;
      }
      if (eventBus) {
        eventBus.pauseDispatch();
        dispatchPaused = true;
      }

      // Plan §6.2 step 4 — give any in-flight cron tick that fired
      // just before pause a chance to settle. Every known cron
      // handler either (a) respects observer stop() via pauseAll, or
      // (b) enqueues events onto the now-paused EventBus. The delay
      // is belt-and-suspenders for handlers that do direct I/O
      // without going through either gate; exposed for tests so the
      // 1s wall clock doesn't bloat the suite.
      if (settleDelayMs > 0) {
        await new Promise((r) => setTimeout(r, settleDelayMs));
      }

      // Recovery edge case: degraded "obsidian without a primary path"
      // resolves to the plain fallback directory. There is no file move
      // to perform, but we still must commit the mode switch so the app
      // leaves degraded mode instead of colliding with itself.
      if (sourceDir === targetDir && config.vaultMode !== targetVaultMode) {
        await emitProgress(
          "settings_update",
          "running",
          targetDir,
          85,
          "Updating Management Mode settings…",
        );
        try {
          commitVaultSettings(targetVaultMode, targetDir);
        } catch (err) {
          logger.error({ err }, "Settings update failed during zero-copy migration");
          const { rollbackStatus } = await rollback("settings_update_failed");
          return await respondAfterCleanup(
            {
              error: "settings_update_failed" satisfies MigrationErrorCode,
              message: "Settings update failed; source and DB restored.",
              rollbackStatus,
              backupPath: null,
            },
            500,
          );
        }

        await seedTargetSkeleton(targetDir);
        await notifyVaultPathChange(
          targetVaultMode === "obsidian" ? targetDir : null,
        );

        const durationMs = Date.now() - startedAt;
        let fsInfo: FsInfo | null = null;
        try {
          fsInfo = getFsInfo(targetDir);
        } catch (err) {
          logger.warn({ err }, "fsInfo probe failed after zero-copy migration");
        }

        await emitProgress(
          "resume",
          "running",
          targetDir,
          95,
          "Resuming observers and schedulers…",
        );
        const { resumeFailures } = await cleanupAfterMigration();
        const resumeStatus = resumeFailures.length > 0 ? "manual_required" : "resumed";

        try {
          db.prepare(
            `INSERT INTO agent_actions
               (action_type, result, detail, started_at, completed_at, duration_ms)
             VALUES ('context_dir_migration', 'success', ?, ?, ?, ?)`,
          ).run(
            JSON.stringify({
              from: sourceDir,
              to: targetDir,
              filesMoved: 0,
              bytes: 0,
              conflictPolicy,
              backupPath: null,
              dbRewrite: null,
              fsInfo,
              resumeStatus,
              resumeFailures,
            }),
            new Date(startedAt).toISOString(),
            new Date().toISOString(),
            durationMs,
          );
        } catch (err) {
          logger.warn({ err }, "failed to write zero-copy context_dir_migration audit row");
        }

        logger.info(
          {
            from: sourceDir,
            to: targetDir,
            files: 0,
            bytes: 0,
            durationMs,
            conflictPolicy,
            dbRewrite: null,
            fsInfo,
            resumeStatus,
            resumeFailures,
          },
          "context_migration_complete_without_move",
        );

        await emitProgress(
          "completed",
          "completed",
          targetDir,
          100,
          "Migration complete.",
        );

        return c.json({
          status: "migrated",
          from: sourceDir,
          to: targetDir,
          filesMoved: 0,
          bytes: 0,
          durationMs,
          backupPath: null,
          backupExpiresAt: null,
          fsInfo,
          resumeStatus,
          manualActionRequired: resumeFailures.length > 0,
          ...(resumeFailures.length > 0
            ? {
                message:
                  "Migration committed, but observers/schedulers failed to resume. Restart the daemon.",
                resumeFailures,
              }
            : {}),
        });
      }

      // Conflict detection against target.
      const sourceTopLevel = listTopLevel(sourceDir);
      const targetReport = inspectTarget(targetDir, sourceTopLevel);
      const resolution = resolveConflictPolicy(targetReport, conflictPolicy);
      if (!resolution.ok) {
        return await respondAfterCleanup(
          {
            error: resolution.error satisfies MigrationErrorCode,
            message:
              resolution.error === "target_has_unrelated_files"
                ? "Target directory contains foreign files. Pick a policy or choose an empty target."
                : "Target directory has agent-file name collisions. Pass conflictPolicy='overwrite_agent_files' to proceed.",
            entries: resolution.entries,
          },
          400,
        );
      }

      // Backup — place under dataDir so cleanup is local; timestamp in UTC.
      await emitProgress(
        "backup",
        "running",
        targetDir,
        20,
        "Creating a safety backup before moving files…",
      );
      const backupPath = join(
        config.dataDir,
        "migration-backups",
        `migration-backup-${new Date().toISOString().replace(/[:.]/g, "-")}`,
      );
      mkdirSync(dirname(backupPath), { recursive: true });
      try {
        backup = createBackup(sourceDir, backupPath);
      } catch (err) {
        logger.error({ err, sourceDir, backupPath }, "Backup creation failed");
        const classified = classifyFsError(
          err,
          "backup_failed",
          "Failed to create backup before migration.",
        );
        return await respondAfterCleanup(
          {
            error: classified.error satisfies MigrationErrorCode,
            message: classified.message,
          },
          500,
        );
      }

      // Ledger row (pending).
      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
      const ledgerResult = db
        .prepare(
          `INSERT INTO migration_backups
             (created_at, source_path, target_path, backup_path, files_count, bytes, status, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`,
        )
        .run(
          new Date().toISOString(),
          sourceDir,
          targetDir,
          backup.backupDir,
          backup.manifest.files.length,
          backup.manifest.totalBytes,
          expiresAt,
        );
      backupRowId = Number(ledgerResult.lastInsertRowid);

      // Capture the target's pre-existing top-level entries BEFORE the
      // move so rollback can tell apart "we moved this here" from "the
      // user had this here already". Includes benign entries like
      // `.obsidian/` so they survive a rollback intact. Uses raw
      // readdir (not listTopLevel, which filters benigns) because the
      // rollback logic needs to preserve them specifically.
      preExistingTargetEntries = existsSync(targetDir)
        ? new Set(readdirSync(targetDir))
        : new Set();

      // Stash agent-file entries that `overwrite_agent_files` is about
      // to destroy at target. Only runs when the user opted into the
      // destructive policy AND real conflicts exist. The stash lives
      // inside the backup dir so the retention cron reaches it too.
      if (
        conflictPolicy === "overwrite_agent_files"
        && targetReport.agentFileConflicts.length > 0
      ) {
        try {
          overwrittenEntries = stashOverwrittenTargetEntries(
            targetDir,
            targetReport.agentFileConflicts,
            backup.backupDir,
          );
        } catch (err) {
          logger.error({ err }, "Failed to stash overwritten target entries — aborting migration");
          const { rollbackStatus } = await rollback("overwrite_stash_failed");
          return await respondAfterCleanup(
            {
              error: "backup_failed" satisfies MigrationErrorCode,
              message:
                "Could not stash target-side versions of colliding files; refusing to proceed with overwrite.",
              rollbackStatus,
              backupPath: backup.backupDir,
            },
            500,
          );
        }
      }

      // Move.
      await emitProgress(
        "move",
        "running",
        targetDir,
        45,
        "Moving context files to the selected directory…",
      );
      try {
        moveTree(sourceDir, targetDir);
        moveCompleted = true;
      } catch (err) {
        logger.error({ err, sourceDir, targetDir }, "Move failed");
        const { rollbackStatus } = await rollback("move_failed");
        const classified = classifyFsError(err, "move_failed", "File move failed.");
        return await respondAfterCleanup(
          {
            error: classified.error satisfies MigrationErrorCode,
            message: classified.message,
            rollbackStatus,
            backupPath: backup.backupDir,
          },
          500,
        );
      }

      // Plan §6.5 "verification after move" — walk the source manifest
      // against the target, confirming every file exists with the
      // expected size. Catches partial copies, truncation, or a
      // filesystem that silently dropped files. Cheap O(n) stat walk;
      // SHA-256 content verification is deferred to Phase 2.x.
      await emitProgress(
        "verify",
        "running",
        targetDir,
        60,
        "Verifying the moved files…",
      );
      const verification = verifyMoveCompleted(backup.manifest, targetDir);
      if (!verification.ok) {
        logger.error(
          { missing: verification.missing, sizeMismatch: verification.sizeMismatch },
          "Move verification failed",
        );
        const { rollbackStatus } = await rollback("move_verification_failed");
        return await respondAfterCleanup(
          {
            error: "move_verification_failed" satisfies MigrationErrorCode,
            message: "Move completed but target does not match source manifest.",
            missing: verification.missing,
            sizeMismatch: verification.sizeMismatch,
            rollbackStatus,
            backupPath: backup.backupDir,
          },
          500,
        );
      }

      // DB path rewrite.
      let dbRewriteStats: { rowsRewritten: number; rowsUnchanged: number; rowsUnparseable: number } | null = null;
      await emitProgress(
        "db_rewrite",
        "running",
        targetDir,
        75,
        "Rewriting stored absolute paths in the database…",
      );
      try {
        dbRewriteStats = rewritePathsInDb(db, sourceDir, targetDir);
      } catch (err) {
        logger.error({ err }, "DB path rewrite failed");
        const { rollbackStatus } = await rollback("db_rewrite_failed");
        return await respondAfterCleanup(
          {
            error: "db_rewrite_failed" satisfies MigrationErrorCode,
            message: "DB path rewrite failed; source restored from backup.",
            rollbackStatus,
            backupPath: backup.backupDir,
          },
          500,
        );
      }

      // Settings update. We write directly via settingsStore — env-writer
      // rejects `vaultMode` / `primaryVaultPath` PATCH to steer callers
      // into this endpoint, and the migration endpoint is the one place
      // that legitimately owns those writes.
      await emitProgress(
        "settings_update",
        "running",
        targetDir,
        85,
        "Updating Management Mode settings…",
      );
      try {
        commitVaultSettings(targetVaultMode, targetDir);
        // Gemini's `.pa-admin-policy.toml` embeds an absolute contextDir
        // regex (audit §5.3). No separate regeneration is needed:
        // `gemini-cli-core.ts` re-runs `generateAdminPolicy` with the
        // current `getContextDir(this.config)` on every execute, and
        // the Object.assign above makes the next execute see the new
        // vault. Persisted workdirs are overwritten on resume, not
        // before. The active-session check earlier in this handler
        // guarantees no execute is currently running against the old
        // path.
      } catch (err) {
        logger.error({ err }, "Settings update failed");
        // Plan §6.9 row "settings update failure" — reverse the DB
        // rewrite BEFORE restoring files. Reversal is safe here
        // because (a) observers are paused so no new row could have
        // landed referencing the new path, (b) the rewrite is
        // directional and monotonic, and (c) the temporal window
        // between rewritePathsInDb and this catch is sub-millisecond
        // in practice. If the reverse rewrite itself throws, the
        // rollback still restores the files, and the user is
        // notified via `manual_required` status.
        try {
          rewritePathsInDb(db, targetDir, sourceDir);
        } catch (reverseErr) {
          logger.error({ reverseErr }, "DB rewrite reverse failed — rollback marked manual_required");
          const { rollbackStatus: _ } = await rollback("settings_update_failed_with_db_unreversed");
          return await respondAfterCleanup(
            {
              error: "settings_update_failed" satisfies MigrationErrorCode,
              message:
                "Settings update failed AND the DB rewrite reverse also failed. Restore manually from backup.",
              rollbackStatus: "manual_required" as const,
              backupPath: backup.backupDir,
            },
            500,
          );
        }
        const { rollbackStatus } = await rollback("settings_update_failed");
        return await respondAfterCleanup(
          {
            error: "settings_update_failed" satisfies MigrationErrorCode,
            message: "Settings update failed; source and DB restored.",
            rollbackStatus,
            backupPath: backup.backupDir,
          },
          500,
        );
      }

      await seedTargetSkeleton(targetDir);
      await notifyVaultPathChange(
        targetVaultMode === "obsidian" ? targetDir : null,
      );

      // Finalize backup (break hardlinks so it's a true 7-day rollback snapshot).
      try {
        finalizeBackup(backup);
      } catch (err) {
        // Non-fatal: the migration succeeded; the 7-day retention guarantee
        // is best-effort for same-fs hardlinks in this narrow case.
        logger.warn({ err }, "finalizeBackup failed — rollback window is reduced to pre-migration only");
      }

      db.prepare(
        "UPDATE migration_backups SET status = 'completed' WHERE id = ?",
      ).run(backupRowId);

      const durationMs = Date.now() - startedAt;

      // Plan §4.3 / §6.1 — collect fsInfo on the now-populated target
      // so the dashboard can surface "iCloud sync detected" or similar
      // banners. Probed AFTER the move because some checks (case
      // sensitivity via probe files) need the directory to exist.
      let fsInfo: FsInfo | null = null;
      try {
        fsInfo = getFsInfo(targetDir);
      } catch (err) {
        logger.warn({ err }, "fsInfo probe failed post-migration");
      }

      await emitProgress(
        "resume",
        "running",
        targetDir,
        95,
        "Resuming observers and schedulers…",
      );
      const { resumeFailures } = await cleanupAfterMigration();
      const resumeStatus = resumeFailures.length > 0 ? "manual_required" : "resumed";

      // Plan §6.6, §6.14, §10 — emit an agent_actions audit row so
      // `/api/metrics` and the dashboard cost timeline surface the
      // context-directory migration. `action_type` is the canonical
      // agent_actions field; `detail` carries the structured payload
      // the plan enumerates.
      try {
        db.prepare(
          `INSERT INTO agent_actions
             (action_type, result, detail, started_at, completed_at, duration_ms)
           VALUES ('context_dir_migration', 'success', ?, ?, ?, ?)`,
        ).run(
          JSON.stringify({
            from: sourceDir,
            to: targetDir,
            filesMoved: backup.manifest.files.length,
            bytes: backup.manifest.totalBytes,
            conflictPolicy,
            backupPath: backup.backupDir,
            dbRewrite: dbRewriteStats,
            fsInfo,
            resumeStatus,
            resumeFailures,
          }),
          new Date(startedAt).toISOString(),
          new Date().toISOString(),
          durationMs,
        );
      } catch (err) {
        logger.warn({ err }, "failed to write context_dir_migration audit row");
      }

      logger.info(
        {
          from: sourceDir,
          to: targetDir,
          files: backup.manifest.files.length,
          bytes: backup.manifest.totalBytes,
          durationMs,
          conflictPolicy,
          dbRewrite: dbRewriteStats,
          fsInfo,
          resumeStatus,
          resumeFailures,
        },
        "context_migration_complete",
      );

      await emitProgress(
        "completed",
        "completed",
        targetDir,
        100,
        "Migration complete.",
      );

      return c.json({
        status: "migrated",
        from: sourceDir,
        to: targetDir,
        filesMoved: backup.manifest.files.length,
        bytes: backup.manifest.totalBytes,
        durationMs,
        backupPath: backup.backupDir,
        backupExpiresAt: expiresAt,
        fsInfo,
        resumeStatus,
        manualActionRequired: resumeFailures.length > 0,
        ...(resumeFailures.length > 0
          ? {
              message:
                "Migration committed, but observers/schedulers failed to resume. Restart the daemon.",
              resumeFailures,
            }
          : {}),
      });
    } catch (err) {
      logger.error({ err }, "Unhandled migration error");
      const { rollbackStatus } = await rollback("internal_error");
      return await respondAfterCleanup(
        {
          error: "internal_error" satisfies MigrationErrorCode,
          message: "Unexpected error during migration.",
          rollbackStatus,
          backupPath: backup?.backupDir ?? null,
        },
        500,
      );
    } finally {
      if (!cleanupComplete) {
        await cleanupAfterMigration();
      }
    }
  });

  return app;
}

/**
 * Daily retention sweep — delete backup directories whose `expires_at`
 * is in the past AND whose status is 'completed' or 'rolled_back'.
 * 'pending' rows are left alone: they represent an in-flight or
 * crashed migration whose resolution the operator should inspect.
 * Called by the scheduler; see `index.ts` wiring.
 */
export function sweepExpiredMigrationBackups(
  db: Database.Database,
  opts: {
    /**
     * Override for the directory removal call. Defaults to `rmSync` from
     * `node:fs`. Tests inject a throwing function to exercise the
     * error-counting branch — `vi.spyOn` cannot wrap the static `node:fs`
     * namespace under ESM, so the injection point lives here.
     */
    removeFn?: (path: string) => void;
  } = {},
): {
  swept: number;
  errors: number;
} {
  const removeFn =
    opts.removeFn ??
    ((path: string) => rmSync(path, { recursive: true, force: true }));
  const now = new Date().toISOString();
  const rows = db
    .prepare(
      "SELECT id, backup_path FROM migration_backups WHERE status IN ('completed', 'rolled_back') AND expires_at < ?",
    )
    .all(now) as Array<{ id: number; backup_path: string }>;
  let swept = 0;
  let errors = 0;
  const updateStatus = db.prepare(
    "UPDATE migration_backups SET status = 'expired' WHERE id = ?",
  );
  for (const row of rows) {
    try {
      if (existsSync(row.backup_path)) {
        removeFn(row.backup_path);
      }
      updateStatus.run(row.id);
      swept += 1;
    } catch (err) {
      logger.error({ err, backupPath: row.backup_path }, "sweep: backup removal failed");
      errors += 1;
    }
  }
  if (swept > 0 || errors > 0) {
    logger.info({ swept, errors }, "sweepExpiredMigrationBackups complete");
  }
  return { swept, errors };
}
