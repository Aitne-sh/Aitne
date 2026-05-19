import type Database from "better-sqlite3";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { createLogger, toSafeErrorMessage } from "../logging.js";
import { clearLogBuffer } from "../log-buffer.js";
import { getContextDir } from "../config.js";
import { applySchema } from "../db/schema.js";
import { cleanupSessionWorkdir, getSessionWorkdirPath } from "./workdir.js";
import type { SecretBroker } from "../secrets/secret-broker.js";
import type { SecretStore } from "../secrets/secret-store.js";
import { INTERNAL_SECRET_NAMES, SECRET_NAMES } from "../secrets/secret-names.js";

const logger = createLogger("system-reset");

/**
 * Append a structured line to `${dataDir}/system-reset.log` for scoped
 * maintenance operations. Full factory reset removes this file again as part
 * of returning the device to a fresh-install state.
 */
export function appendResetAuditLine(params: {
  dataDir: string;
  event: string;
  payload: Record<string, unknown>;
}): void {
  const { dataDir, event, payload } = params;
  try {
    mkdirSync(dataDir, { recursive: true });
    const line = JSON.stringify({
      timestamp: new Date().toISOString(),
      event,
      ...payload,
    }) + "\n";
    appendFileSync(join(dataDir, "system-reset.log"), line, { mode: 0o600 });
  } catch (err) {
    // Audit is best-effort — a failure here must not break the reset.
    logger.warn({ err, event }, "Failed to append to system-reset audit log");
  }
}

export interface PurgeHistoryResult {
  deletedSessions: number;
  deletedMessages: number;
  deletedActions: number;
  deletedObservations: number;
  deletedNotifications: number;
  deletedSnapshots: number;
  deletedSchedule: number;
  deletedDmLog: number;
}

export interface WipedContextPath {
  path: string;
  removed: number;
  error?: string;
}

export interface WipeContextError {
  path: string;
  message: string;
}

export interface WipeContextFilesResult {
  removed: number;
  /**
   * Backward-compatible primary path for callers that predate multi-context
   * wiping. When multiple paths are provided this is the first requested path.
   */
  path: string;
  paths: WipedContextPath[];
  errors: WipeContextError[];
}

export interface WipedDataPath {
  path: string;
  kind: "dir" | "file";
  removed: boolean;
}

export interface WipeAncillaryDataResult {
  removed: number;
  paths: WipedDataPath[];
}

export interface SecretDeleteFailure {
  name: string;
  message: string;
}

function assertSafeContextDir(rawContextDir: string, rawDataDir: string): string {
  if (!isAbsolute(rawContextDir)) {
    throw new Error(`Refusing to wipe non-absolute context path: ${rawContextDir}`);
  }

  const contextDir = resolve(rawContextDir);
  const realContextDir = existsSync(contextDir) ? realpathSync(contextDir) : contextDir;
  const dataDir = resolve(rawDataDir);
  const realDataDir = existsSync(dataDir) ? realpathSync(dataDir) : dataDir;
  const deniedExact = new Set([
    homedir(),
    dataDir,
    realDataDir,
    dirname(dataDir),
    dirname(realDataDir),
  ]);

  for (const candidate of [contextDir, realContextDir]) {
    const root = parse(candidate).root;
    if (candidate === root || deniedExact.has(candidate)) {
      throw new Error(`Refusing to wipe unsafe context path: ${contextDir}`);
    }

    const segmentCount = candidate
      .slice(root.length)
      .split(sep)
      .filter(Boolean).length;
    if (segmentCount < 2) {
      throw new Error(`Refusing to wipe shallow context path: ${contextDir}`);
    }
  }

  return contextDir;
}

function assertSafeDataChild(rawPath: string, rawDataDir: string): string {
  const dataDir = resolve(rawDataDir);
  const target = resolve(rawPath);
  const rel = relative(dataDir, target);
  if (
    rel.length === 0 ||
    rel === ".." ||
    rel.startsWith(`..${sep}`) ||
    isAbsolute(rel)
  ) {
    throw new Error(`Refusing to wipe path outside dataDir: ${target}`);
  }
  return target;
}

function quoteSqlIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function tableExists(db: Database.Database, tableName: string): boolean {
  return db
    .prepare(
      `SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?`,
    )
    .get(tableName) !== undefined;
}

function clearRecurringScheduleLinksForScheduleDelete(
  db: Database.Database,
  includeRunningSchedule: boolean,
): void {
  if (!tableExists(db, "recurring_schedules") || !tableExists(db, "agent_schedule")) {
    return;
  }

  if (includeRunningSchedule) {
    db.prepare(`UPDATE recurring_schedules SET last_scheduled_id = NULL`).run();
    return;
  }

  db.prepare(
    `UPDATE recurring_schedules
        SET last_scheduled_id = NULL
      WHERE last_scheduled_id IN (
        SELECT id FROM agent_schedule WHERE status != 'running'
      )`,
  ).run();
}

/**
 * Wipe every piece of conversation + audit history. Active sessions
 * (status='active') and their messages are preserved so a mid-turn
 * dashboard chat is not yanked out from under the user.
 *
 * Ordering: messages before sessions (FK without ON DELETE CASCADE).
 * Workdir cleanup runs AFTER the transaction commits so a rolled-back
 * tx can't leave orphaned file deletions.
 */
export function purgeHistory(params: {
  db: Database.Database;
  dataDir: string;
  includeActive?: boolean;
  includeRunningSchedule?: boolean;
}): PurgeHistoryResult {
  const {
    db,
    dataDir,
    includeActive = false,
    includeRunningSchedule = false,
  } = params;
  const sessionFilter = includeActive ? "" : "WHERE status != 'active'";

  const result: PurgeHistoryResult = {
    deletedSessions: 0,
    deletedMessages: 0,
    deletedActions: 0,
    deletedObservations: 0,
    deletedNotifications: 0,
    deletedSnapshots: 0,
    deletedSchedule: 0,
    deletedDmLog: 0,
  };

  let deletedIds: number[] = [];

  db.transaction(() => {
    const msgInfo = db
      .prepare(
        includeActive
          ? `DELETE FROM messages`
          : `DELETE FROM messages
               WHERE session_id IN (
                 SELECT id FROM conversation_sessions WHERE status != 'active'
               )`,
      )
      .run();
    result.deletedMessages = msgInfo.changes;

    const returned = db
      .prepare(
        `DELETE FROM conversation_sessions ${sessionFilter} RETURNING id`,
      )
      .all() as Array<{ id: number }>;
    deletedIds = returned.map((r) => r.id);
    result.deletedSessions = deletedIds.length;

    result.deletedActions = db.prepare(`DELETE FROM agent_actions`).run().changes;
    result.deletedObservations = db.prepare(`DELETE FROM observations`).run().changes;
    result.deletedNotifications = db.prepare(`DELETE FROM notification_log`).run().changes;
    result.deletedSnapshots = db.prepare(`DELETE FROM md_file_snapshots`).run().changes;
    result.deletedDmLog = db.prepare(`DELETE FROM dm_conversation_log`).run().changes;

    clearRecurringScheduleLinksForScheduleDelete(db, includeRunningSchedule);

    // Normal history purge keeps running schedule rows because the dispatcher
    // may be waiting on them. Factory reset opts into deleting them too.
    result.deletedSchedule = db
      .prepare(
        includeRunningSchedule
          ? `DELETE FROM agent_schedule`
          : `DELETE FROM agent_schedule WHERE status != 'running'`,
      )
      .run().changes;
  })();

  for (const id of deletedIds) {
    cleanupSessionWorkdir(getSessionWorkdirPath(dataDir, id));
  }

  logger.info({ ...result, includeActive, includeRunningSchedule }, "Purged history");
  appendResetAuditLine({
    dataDir,
    event: "purge_history",
    payload: { ...result, includeActive, includeRunningSchedule },
  });
  return result;
}

/**
 * Reset runtime config by clearing the `settings` table. Next reads fall
 * back to Zod defaults baked into `runtimeSettingsSchema`. `.env` (bootstrap
 * keys like apiPort) and the keychain (secrets) are NOT touched.
 *
 * Mutates `config` in place for keys that have a default in the schema so
 * the running daemon picks up the reset without a restart. Keys that only
 * have env defaults (not in the runtime-settings schema) stay as-is; the
 * confirm dialog warns the user that bootstrap keys are out of scope.
 */
export function resetRuntimeConfig(params: {
  db: Database.Database;
  dataDir?: string;
  applyDefaults: () => void;
}): { cleared: number } {
  const { db, dataDir, applyDefaults } = params;
  const info = db.prepare(`DELETE FROM settings`).run();
  applyDefaults();
  logger.info({ cleared: info.changes }, "Cleared runtime settings");
  if (dataDir) {
    appendResetAuditLine({
      dataDir,
      event: "reset_runtime_config",
      payload: { cleared: info.changes },
    });
  }
  return { cleared: info.changes };
}

/**
 * Remove everything inside the context directory, including
 * `rules/management.md` — so `/setup/status` flips back to
 * `needsSetup: true` on the next read.
 *
 * The context directory itself is kept so downstream code that
 * unconditionally resolves paths under it doesn't have to recreate it.
 */
export function wipeContextFiles(params: {
  dataDir: string;
  /**
   * Context roots to wipe. Defaults to the plain fallback context for
   * historical callers. Obsidian-mode callers should pass both the effective
   * primary vault and the fallback context so a reset cannot leave stale
   * setup markers behind in either location.
   */
  contextDirs?: string[];
}): WipeContextFilesResult {
  const fallbackContextDir = getContextDir({ dataDir: params.dataDir });
  const requestedDirs = params.contextDirs && params.contextDirs.length > 0
    ? params.contextDirs
    : [fallbackContextDir];
  const contextDirs = Array.from(
    new Set(requestedDirs.map((dir) => assertSafeContextDir(dir, params.dataDir))),
  );

  let removed = 0;
  const paths: WipedContextPath[] = [];
  const errors: WipeContextError[] = [];
  for (const contextDir of contextDirs) {
    if (!existsSync(contextDir)) {
      paths.push({ path: contextDir, removed: 0 });
      continue;
    }
    let entries: string[];
    try {
      entries = readdirSync(contextDir);
    } catch (err) {
      const message = toSafeErrorMessage(err, "unknown");
      errors.push({ path: contextDir, message });
      paths.push({ path: contextDir, removed: 0, error: message });
      logger.warn({ path: contextDir, err }, "Failed to read context directory during wipe");
      continue;
    }
    let removedForPath = 0;
    for (const entry of entries) {
      const entryPath = join(contextDir, entry);
      try {
        rmSync(entryPath, { recursive: true, force: true });
        removedForPath += 1;
      } catch (err) {
        const message = toSafeErrorMessage(err, "unknown");
        errors.push({ path: entryPath, message });
        logger.warn({ path: entryPath, err }, "Failed to remove context entry during wipe");
      }
    }
    removed += removedForPath;
    const pathResult: WipedContextPath = { path: contextDir, removed: removedForPath };
    if (removedForPath !== entries.length) {
      pathResult.error = `Failed to remove ${entries.length - removedForPath} entr(y/ies)`;
    }
    paths.push(pathResult);
    logger.info({ path: contextDir, removed: removedForPath }, "Wiped context files");
  }
  appendResetAuditLine({
    dataDir: params.dataDir,
    event: "wipe_context",
    payload: { path: contextDirs[0] ?? fallbackContextDir, removed, paths, errors },
  });
  return { removed, path: contextDirs[0] ?? fallbackContextDir, paths, errors };
}

/**
 * Clear every user-supplied secret from the keychain via the broker —
 * goes through the broker's write-serialization tail so concurrent reads
 * can't race the delete.
 *
 * Also clears the internal blob master key via the store (not the broker,
 * which only knows user-facing names). Since blobs are wiped as part of
 * factory reset, retaining the old master key would only serve to
 * recover blobs that no longer exist.
 */
export async function clearAllSecrets(params: {
  secretBroker: SecretBroker;
  secretStore?: SecretStore;
}): Promise<{ deleted: string[]; failed: SecretDeleteFailure[] }> {
  const deleted: string[] = [];
  const failed: SecretDeleteFailure[] = [];
  for (const name of SECRET_NAMES) {
    try {
      await params.secretBroker.delete(name);
      deleted.push(name);
    } catch (err) {
      failed.push({ name, message: toSafeErrorMessage(err, "unknown") });
      logger.warn({ name, err }, "Failed to delete secret during factory reset");
    }
  }
  if (params.secretStore) {
    for (const name of INTERNAL_SECRET_NAMES) {
      try {
        await params.secretStore.delete(name);
        deleted.push(name);
      } catch (err) {
        failed.push({ name, message: toSafeErrorMessage(err, "unknown") });
        logger.warn({ name, err }, "Failed to delete internal secret during factory reset");
      }
    }
  }
  return { deleted, failed };
}

/**
 * Remove every file under the encrypted blob store's root directory.
 * The store is content-agnostic — we operate at the filesystem level so
 * that blobs written by uninstalled providers are still cleaned.
 */
export function wipeEncryptedBlobs(params: {
  dataDir: string;
}): { removed: number } {
  const blobDir = join(params.dataDir, "secrets", "blobs");
  if (!existsSync(blobDir)) {
    return { removed: 0 };
  }
  const entries = readdirSync(blobDir);
  for (const entry of entries) {
    rmSync(join(blobDir, entry), { recursive: true, force: true });
  }
  return { removed: entries.length };
}

const FACTORY_RESET_ANCILLARY_DIRS = [
  // Runtime log files can contain pre-reset operational details.
  "logs",
  // File payloads for rows cleared from `chat_attachments`.
  "attachments",
  // Per-session workdirs. `purgeHistory` removes DB-backed ones, but factory
  // reset must also remove orphaned workdirs from failed/legacy sessions.
  "agent-sessions",
  // Skill-curation per-run workdirs (P22). The runner writes each run under
  // `<dataDir>/optimizer-workdir/<runId>/`; orphans from interrupted runs
  // (or any run prior to factory reset) hold agent-visible intermediate
  // state and must not survive.
  "optimizer-workdir",
  // Migration/reinstall backups, template-versioning backups, release-asset
  // backups, and probe sandboxes are recoverability/cache artifacts from
  // pre-reset state, not fresh-install state.
  //
  // `backup` (singular) — context-reinstall tarballs from `reinstall.ts`.
  // `backups` (plural) — `<dataDir>/backups/templates/<ts>/` and
  //   `<dataDir>/backups/release-assets/` from `template-store.ts` /
  //   `release-assets.ts`. Each carries the *previous* state forward and
  //   has been the primary leak past factory reset.
  "migration-backups",
  "backup",
  "backups",
  "mcp",
  "cache",
  // Runtime scratch/auth/customization data.
  "tmp",
  "whatsapp",
  "skills",
  "prompts",
  // User-customized template overrides (`<dataDir>/templates/*.md` shadow
  // the bundled git-project templates) and event-type task-flow overrides
  // (`<dataDir>/task-flows/<eventType>.md` shadow the bundled flows). Both
  // are user-introduced state that should not survive a fresh-install reset.
  "templates",
  "task-flows",
  // Generated git-credential askpass shim and any other regenerable runtime
  // helpers. The daemon re-materializes these lazily on next use.
  "runtime",
  // Codex CLI managed HOME — `<dataDir>/codex-home/config.toml` holds the
  // operator's Azure OpenAI routing (provider config + env-key reference),
  // re-materialized on next sync if still configured. Treated as sensitive
  // per `codex-home-materializer.ts` (chmod 0600 on the file).
  "codex-home",
  // Local Whisper model cache (`<dataDir>/models/whisper/*`). ~800MB of
  // model weights downloaded by `/voice/install`. Not data leakage but a
  // factory reset that leaves it behind is not "fresh-install state" —
  // the user expects voice mode to be uninstalled afterwards.
  "models",
] as const;

const FACTORY_RESET_TOP_LEVEL_FILES = [
  // If left in place, startup bootstrap reads integrations.md and re-applies
  // pre-reset integration state into the freshly-cleared DB.
  "integrations.md",
  "management.md",
  "system-reset.log",
  // Legacy DB at the dataDir root from very old layouts. Other legacy /
  // backup DB files under `<dataDir>/data/` are wiped dynamically by
  // `wipeStaleDataDirArtifacts` so newly-introduced legacy names cannot
  // silently leak user data through factory reset.
  "data.db",
] as const;

const ACTIVE_DB_FILES = [
  "personal_agent.db",
  "personal_agent.db-shm",
  "personal_agent.db-wal",
] as const;

/**
 * Remove every file under `<dataDir>/data/` that is not the active SQLite
 * database (compacted, not removed) or one of its WAL/SHM sidecars. This
 * catches:
 *
 *   - Legacy DB filenames from prior rebrands (`aitne.db`, `data.db`,
 *     `agent.db`, `personal-agent.db`) — including newly-introduced ones
 *     a hardcoded allowlist would miss.
 *   - DB backup snapshots (`personal_agent.db.bak.<timestamp>`) which
 *     contain the *previous* user state in full — a critical leak past
 *     factory reset if missed.
 *   - Any other `.db` file an older layout dropped here.
 *
 * Subdirectories (none expected today) are also removed for symmetry.
 */
export function wipeStaleDataDirArtifacts(params: {
  dataDir: string;
}): { removed: string[] } {
  const dbDir = resolve(params.dataDir, "data");
  if (!existsSync(dbDir)) {
    return { removed: [] };
  }
  const keep = new Set<string>(ACTIVE_DB_FILES);
  const removed: string[] = [];
  for (const entry of readdirSync(dbDir)) {
    if (keep.has(entry)) continue;
    const target = assertSafeDataChild(join(dbDir, entry), params.dataDir);
    rmSync(target, { recursive: true, force: true });
    removed.push(target);
  }
  return { removed };
}

export function wipeFactoryResetAncillaryData(params: {
  dataDir: string;
  dirs?: string[];
  files?: string[];
}): WipeAncillaryDataResult {
  const dataDir = resolve(params.dataDir);
  const paths: WipedDataPath[] = [];
  let removed = 0;
  const legacyLogDirs = params.dirs || !existsSync(dataDir)
    ? []
    : readdirSync(dataDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith("logs-old-"))
      .map((entry) => join(dataDir, entry.name));
  const dirs = params.dirs ?? [
    ...FACTORY_RESET_ANCILLARY_DIRS.map((name) => join(dataDir, name)),
    ...legacyLogDirs,
  ];
  const files = params.files ?? FACTORY_RESET_TOP_LEVEL_FILES.map((name) => join(dataDir, name));

  for (const rawDir of dirs) {
    const dir = assertSafeDataChild(rawDir, dataDir);
    const didRemove = existsSync(dir);
    if (didRemove) {
      rmSync(dir, { recursive: true, force: true });
      removed += 1;
    }
    paths.push({ path: dir, kind: "dir", removed: didRemove });
  }

  for (const rawFile of files) {
    const file = assertSafeDataChild(rawFile, dataDir);
    const didRemove = existsSync(file);
    if (didRemove) {
      rmSync(file, { force: true });
      removed += 1;
    }
    paths.push({ path: file, kind: "file", removed: didRemove });
  }

  // Keep required runtime directories available while the daemon continues
  // running. On the next start `initDirectories` will also recreate them.
  mkdirSync(join(dataDir, "tmp"), { recursive: true });
  mkdirSync(join(dataDir, "secrets"), { recursive: true });
  return { removed, paths };
}

export interface DatabaseCompactionResult {
  vacuumed: boolean;
  checkpointed: boolean;
}

export interface SequenceResetResult {
  reset: boolean;
  tables: string[];
}

export function compactDatabaseAfterReset(db: Database.Database): DatabaseCompactionResult {
  db.exec("VACUUM");
  let checkpointed = false;
  try {
    db.pragma("wal_checkpoint(TRUNCATE)");
    checkpointed = true;
  } catch (err) {
    logger.warn({ err }, "Factory reset WAL checkpoint failed after VACUUM");
  }
  return { vacuumed: true, checkpointed };
}

const FACTORY_RESET_SEQUENCE_TABLES = [
  "conversation_sessions",
  "dm_conversation_log",
  "messages",
  "agent_actions",
  "recurring_schedules",
  "agent_schedule",
  "notification_log",
  "md_file_snapshots",
  "observations",
  "migration_backups",
  "mcp_tool_calls",
] as const;

const FACTORY_RESET_TABLE_CLEAR_ORDER = [
  // Child tables first where the schema has explicit FKs.
  "chat_attachments",
  "messages",
  "conversation_sessions",
  "dm_conversation_log",
  "agent_actions",
  "notification_log",
  "md_file_snapshots",
  "observations",
  "agent_schedule",
  "recurring_schedules",
  "backend_global_defaults",
  "process_backend_config",
  "backends",
  "settings",
  "runtime_state",
  "auth_telemetry_counters",
  "reading_highlights",
  "books",
  "receipts",
  "travel_bookings",
  "parse_failures",
  "mail_messages_index",
  "mail_accounts",
  "migration_backups",
  "mcp_tool_calls",
  "mcp_servers",
  "integration_probes",
  "owner_channels",
] as const;

export interface RemainingDataTable {
  name: string;
  rowCount: number;
}

export interface FactoryResetSearchIndex {
  name: string;
  externalContent: boolean;
}

export interface SearchIndexResetResult {
  table: string;
  mode: "delete" | "delete-all";
}

export function getFactoryResetUserTables(db: Database.Database): string[] {
  const rows = db
    .prepare(
      `SELECT name
         FROM sqlite_master
        WHERE type = 'table'
          AND name NOT LIKE 'sqlite_%'
          AND name NOT LIKE 'fts_%'
        ORDER BY name ASC`,
    )
    .all() as Array<{ name: string }>;
  const existing = new Set(rows.map((row) => row.name));
  const ordered = FACTORY_RESET_TABLE_CLEAR_ORDER.filter((name) => existing.has(name));
  const orderedSet = new Set<string>(ordered);
  const remaining = rows
    .map((row) => row.name)
    .filter((name) => !orderedSet.has(name));
  return [...ordered, ...remaining];
}

export function getFactoryResetSearchIndexes(db: Database.Database): FactoryResetSearchIndex[] {
  const rows = db
    .prepare(
      `SELECT name, sql
         FROM sqlite_master
        WHERE type = 'table'
          AND sql LIKE 'CREATE VIRTUAL TABLE%USING fts5%'
        ORDER BY name ASC`,
    )
    .all() as Array<{ name: string; sql: string | null }>;

  return rows.map((row) => ({
    name: row.name,
    externalContent: /\bcontent\s*=/i.test(row.sql ?? ""),
  }));
}

/**
 * Last-resort table sweeper for factory reset. It dynamically clears every
 * user-data table in the current schema so newly added tables cannot silently
 * retain state just because a hand-maintained allowlist was missed.
 */
export function clearFactoryResetDatabaseTables(
  db: Database.Database,
  tableNames: readonly string[] = getFactoryResetUserTables(db),
): string[] {
  const tables = Array.from(new Set(tableNames));
  const cleared: string[] = [];
  if (tables.length === 0) {
    return cleared;
  }

  db.transaction(() => {
    db.pragma("defer_foreign_keys = ON");
    if (tableExists(db, "recurring_schedules")) {
      db.prepare(`UPDATE recurring_schedules SET last_scheduled_id = NULL`).run();
    }
    if (tableExists(db, "agent_schedule")) {
      db.prepare(`UPDATE agent_schedule SET recurring_schedule_id = NULL`).run();
    }

    for (const table of tables) {
      db.prepare(`DELETE FROM ${quoteSqlIdentifier(table)}`).run();
      cleared.push(table);
    }
  })();

  return cleared;
}

/**
 * Drop every user-data table so the next `applySchema` recreates them with
 * the current column set. Necessary because `applySchema` is built from
 * `CREATE TABLE IF NOT EXISTS` statements — those skip existing tables
 * entirely, so columns added to `schema.ts` after the DB was first created
 * never appear in long-lived installs (e.g. `wiki_workspaces.write_strategy`
 * was missing on DBs older than the Phase-2 wiki schema). Without this step
 * a factory reset only clears rows, leaving the schema frozen at whatever
 * version the DB was originally booted with — and any INSERT referencing a
 * newer column blows up with `table X has no column named Y`.
 *
 * Pair with `applySchema` (via `restoreFactoryResetSearchInfrastructure`)
 * to get a true clean-slate reset. Runs in a transaction with FK deferral
 * so DROP order is not significant.
 *
 * Indexes, views, and triggers attached to dropped tables are auto-removed
 * by SQLite; `applySchema` recreates them through its existing `CREATE …
 * IF NOT EXISTS` statements.
 */
export function dropFactoryResetUserTables(
  db: Database.Database,
  tableNames: readonly string[] = getFactoryResetUserTables(db),
): string[] {
  const tables = Array.from(new Set(tableNames));
  const dropped: string[] = [];
  if (tables.length === 0) {
    return dropped;
  }

  db.transaction(() => {
    db.pragma("defer_foreign_keys = ON");
    for (const table of tables) {
      db.exec(`DROP TABLE IF EXISTS ${quoteSqlIdentifier(table)}`);
      dropped.push(table);
    }
  })();

  return dropped;
}

function getFtsTriggerNames(db: Database.Database): string[] {
  // Match by SQL body containing any `fts_<word>` identifier so triggers are
  // still discoverable when their target FTS table has already been dropped
  // — that's the exact recovery path: a corrupt or missing FTS index cannot
  // be enumerated through `getFactoryResetSearchIndexes`, but the trigger
  // body still mentions it by name.
  const FTS_NAME_PATTERN = /\bfts_[A-Za-z0-9_]+\b/;
  const rows = db
    .prepare(`SELECT name, sql FROM sqlite_master WHERE type = 'trigger'`)
    .all() as Array<{ name: string; sql: string | null }>;
  return rows
    .filter((row) => FTS_NAME_PATTERN.test(row.sql ?? ""))
    .map((row) => row.name);
}

/**
 * Tear down every FTS5 virtual table and the triggers that write into them so
 * a corrupt search index cannot make the AFTER DELETE triggers on `messages`
 * / `agent_actions` / `mail_messages_index` raise
 * "database disk image is malformed" mid-reset.
 *
 * External-content FTS5 indexes can land in a state where reads succeed but
 * the trigger-emitted `INSERT INTO fts_x(fts_x,...) VALUES ('delete', ...)`
 * tombstone fails with that error — `PRAGMA integrity_check` does not always
 * catch it. Even drop+recreate alone is not enough, because a freshly
 * recreated external-content FTS index has no row for an existing source
 * rowid, so the next AFTER DELETE on the source can still raise "malformed".
 *
 * The recovery move: drop the indexes AND their AI/AD/AU triggers up front,
 * then run the data wipes with no FTS writes happening at all, and
 * re-apply the (idempotent) schema at the end via
 * `restoreFactoryResetSearchInfrastructure` to recreate fresh empty indexes
 * and triggers. The next-boot docs indexer rebuilds contentless FTS rows;
 * external-content rows get rebuilt by AFTER INSERT triggers as the source
 * tables get repopulated.
 */
export function dropFactoryResetSearchInfrastructure(
  db: Database.Database,
): { droppedIndexes: string[]; droppedTriggers: string[] } {
  const indexes = getFactoryResetSearchIndexes(db);
  const indexNames = indexes.map((index) => index.name);
  const triggerNames = getFtsTriggerNames(db);
  for (const trigger of triggerNames) {
    db.exec(`DROP TRIGGER IF EXISTS ${quoteSqlIdentifier(trigger)}`);
  }
  for (const name of indexNames) {
    db.exec(`DROP TABLE IF EXISTS ${quoteSqlIdentifier(name)}`);
  }
  return { droppedIndexes: indexNames, droppedTriggers: triggerNames };
}

/**
 * Recreate the FTS5 tables and triggers that
 * `dropFactoryResetSearchInfrastructure` removed. Idempotent — safe to call
 * even if the early drop step failed and nothing was actually dropped.
 *
 * `applySchema` re-runs the schema's INSERT OR IGNORE seed rows (5 tables —
 * managed_task_seq, backends, backend_global_defaults, process_backend_config,
 * settings) into a freshly-emptied DB. The factory-reset contract is "leave
 * the DB completely empty; the next-boot applySchema re-seeds." Re-clearing
 * every user table after applySchema preserves that contract — we don't need
 * to track which specific seeds the schema introduces, and a future addition
 * to the seed block won't silently leak rows past factoryReset.
 */
export function restoreFactoryResetSearchInfrastructure(
  db: Database.Database,
): void {
  applySchema(db);
  clearFactoryResetDatabaseTables(db);
}

export function clearFactoryResetSearchIndexes(
  db: Database.Database,
  indexes: readonly FactoryResetSearchIndex[] = getFactoryResetSearchIndexes(db),
): SearchIndexResetResult[] {
  const results: SearchIndexResetResult[] = [];
  for (const index of indexes) {
    const table = quoteSqlIdentifier(index.name);
    if (index.externalContent) {
      // External-content FTS tables can retain orphaned index entries even
      // when COUNT(*) reads as zero because the backing table is empty.
      // `delete-all` clears the index directly and does not depend on the
      // backing table being readable or schema-compatible.
      db.prepare(`INSERT INTO ${table}(${table}) VALUES ('delete-all')`).run();
      results.push({ table: index.name, mode: "delete-all" });
    } else {
      db.prepare(`DELETE FROM ${table}`).run();
      results.push({ table: index.name, mode: "delete" });
    }
  }
  return results;
}

export function findNonEmptyFactoryResetTables(
  db: Database.Database,
  tableNames: readonly string[] = getFactoryResetUserTables(db),
): RemainingDataTable[] {
  const remaining: RemainingDataTable[] = [];
  for (const table of tableNames) {
    const row = db
      .prepare(`SELECT COUNT(*) AS count FROM ${quoteSqlIdentifier(table)}`)
      .get() as { count: number };
    if (row.count > 0) {
      remaining.push({ name: table, rowCount: row.count });
    }
  }
  return remaining;
}

export function findNonEmptyFactoryResetSearchIndexes(
  db: Database.Database,
  indexes: readonly FactoryResetSearchIndex[] = getFactoryResetSearchIndexes(db),
): RemainingDataTable[] {
  const remaining: RemainingDataTable[] = [];
  for (const index of indexes) {
    const table = quoteSqlIdentifier(index.name);
    const row = db
      .prepare(`SELECT COUNT(*) AS count FROM ${table}`)
      .get() as { count: number };
    if (row.count > 0) {
      remaining.push({ name: index.name, rowCount: row.count });
    }
  }
  return remaining;
}

export function resetAutoincrementSequences(
  db: Database.Database,
  tableNames: readonly string[] = FACTORY_RESET_SEQUENCE_TABLES,
): SequenceResetResult {
  const tables = Array.from(new Set(tableNames));
  if (tables.length === 0) {
    return { reset: true, tables: [] };
  }

  const placeholders = tables.map(() => "?").join(", ");
  try {
    db.prepare(`DELETE FROM sqlite_sequence WHERE name IN (${placeholders})`).run(...tables);
  } catch (err) {
    const message = toSafeErrorMessage(err, "unknown");
    if (/no such table: sqlite_sequence/i.test(message)) {
      return { reset: false, tables: [] };
    }
    throw err;
  }
  return { reset: true, tables };
}

export interface ResetError {
  step: string;
  message: string;
}

export interface FactoryResetResult {
  purged: PurgeHistoryResult;
  settingsCleared: number;
  context: WipeContextFilesResult;
  secretsDeleted: string[];
  secretDeleteFailures: SecretDeleteFailure[];
  blobsRemoved: number;
  ancillary: WipeAncillaryDataResult;
  staleDataArtifactsRemoved: string[];
  sequencesReset: SequenceResetResult;
  databaseCompacted: DatabaseCompactionResult;
  searchIndexesRebuilt: string[];
  tablesCleared: string[];
  /** User tables dropped before re-applying the schema. Empty array on a
   *  fresh-install DB where no user tables exist yet. The names overlap
   *  with `tablesCleared` by design — clear-then-drop preserves the
   *  "leave the DB completely empty" contract even if the DROP step fails. */
  userTablesDropped: string[];
  searchIndexesCleared: SearchIndexResetResult[];
  remainingTables: RemainingDataTable[];
  remainingSearchIndexes: RemainingDataTable[];
  /** Per-step failures — the reset continues past each failure so a keychain
   *  error doesn't leave the DB half-wiped. Empty array means clean success. */
  errors: ResetError[];
}

/**
 * Wipe the daemon back to a fresh-install state: purge all history,
 * close active sessions, clear settings, secrets, blobs, and every
 * user-data table. The daemon keeps running; the user must restart
 * to re-bootstrap observers, adapters, and auth.
 */
export async function factoryReset(params: {
  db: Database.Database;
  dataDir: string;
  contextDirs?: string[];
  secretBroker: SecretBroker;
  secretStore?: SecretStore;
  applyDefaults: () => void;
}): Promise<FactoryResetResult> {
  const { db, dataDir, contextDirs, secretBroker, secretStore, applyDefaults } = params;
  const errors: ResetError[] = [];

  // Open the audit trail BEFORE any destructive work so a crash mid-reset
  // still leaves a diagnostic breadcrumb. A completed factory reset removes
  // this file again during the ancillary-data wipe below.
  appendResetAuditLine({
    dataDir,
    event: "factory_reset.started",
    payload: {},
  });

  const runStep = <T>(step: string, fn: () => T, fallback: T): T => {
    try {
      return fn();
    } catch (err) {
      const message = toSafeErrorMessage(err, "unknown");
      errors.push({ step, message });
      logger.warn({ step, err }, "Factory reset step failed");
      return fallback;
    }
  };

  runStep("enable_secure_delete", () => {
    db.pragma("secure_delete = ON");
  }, undefined);

  // Tear down FTS5 tables AND their triggers BEFORE any DELETE on the source
  // tables. A corrupt external-content FTS index (e.g. fts_messages,
  // fts_actions) makes the AFTER DELETE triggers raise "database disk image
  // is malformed", which previously aborted purge_history and
  // clear_database_tables and left up to ~18 user tables populated. Dropping
  // the triggers as well prevents any FTS write during the wipe — the schema
  // gets re-applied at the end of factoryReset.
  const searchIndexesRebuilt = runStep(
    "drop_search_infrastructure",
    () => dropFactoryResetSearchInfrastructure(db).droppedIndexes,
    [] as string[],
  );

  // Close active sessions first so `purgeHistory({ includeActive: true })`
  // doesn't have to walk FKs around rows the dispatcher still references.
  runStep("close_active_sessions", () => {
    db.prepare(
      `UPDATE conversation_sessions SET status = 'closed' WHERE status = 'active'`,
    ).run();
  }, undefined);

  const purged = runStep(
    "purge_history",
    () => purgeHistory({
      db,
      dataDir,
      includeActive: true,
      includeRunningSchedule: true,
    }),
    {
      deletedSessions: 0,
      deletedMessages: 0,
      deletedActions: 0,
      deletedObservations: 0,
      deletedNotifications: 0,
      deletedSnapshots: 0,
      deletedSchedule: 0,
      deletedDmLog: 0,
    },
  );

  const settingsChanges = runStep(
    "clear_settings",
    () => {
      const info = db.prepare(`DELETE FROM settings`).run();
      applyDefaults();
      return info.changes;
    },
    0,
  );

  const tablesCleared: string[] = [];
  runStep("clear_database_tables", () => {
    tablesCleared.push(...clearFactoryResetDatabaseTables(db));
  }, undefined);

  // Drop every user table so the upcoming `applySchema` rebuilds them with
  // the current column set. `applySchema` is `CREATE TABLE IF NOT EXISTS`
  // throughout, so without this step long-lived DBs keep whatever schema
  // they were first booted with — any column added to `schema.ts` after
  // first boot stays missing and INSERTs that reference it blow up with
  // SqliteError. The clear-then-drop order matters: if DROP fails, the
  // DELETE above already satisfied the "DB empty" contract.
  const userTablesDropped: string[] = [];
  runStep("drop_stale_user_tables", () => {
    userTablesDropped.push(...dropFactoryResetUserTables(db));
  }, undefined);

  // Re-apply schema BEFORE clear/verify search indexes so the API contract
  // stays intact (the verifier still sees the FTS tables) while the data
  // wipes themselves ran with no FTS triggers active.
  runStep("restore_search_infrastructure", () => {
    restoreFactoryResetSearchInfrastructure(db);
  }, undefined);

  const searchIndexesCleared: SearchIndexResetResult[] = [];
  runStep("clear_search_indexes", () => {
    searchIndexesCleared.push(...clearFactoryResetSearchIndexes(db));
  }, undefined);

  const remainingTables = runStep(
    "verify_database_empty",
    () => findNonEmptyFactoryResetTables(db),
    [],
  );
  if (remainingTables.length > 0) {
    errors.push({
      step: "verify_database_empty",
      message: `Factory reset left ${remainingTables.length} table(s) with data`,
    });
  }

  const remainingSearchIndexes = runStep(
    "verify_search_indexes_empty",
    () => findNonEmptyFactoryResetSearchIndexes(db),
    [],
  );
  if (remainingSearchIndexes.length > 0) {
    errors.push({
      step: "verify_search_indexes_empty",
      message: `Factory reset left ${remainingSearchIndexes.length} search index(es) with data`,
    });
  }

  const context = runStep(
    "wipe_context",
    () => wipeContextFiles({ dataDir, contextDirs }),
    { removed: 0, path: getContextDir({ dataDir }), paths: [], errors: [] },
  );
  if (context.errors.length > 0) {
    errors.push({
      step: "wipe_context",
      message: `Failed to wipe ${context.errors.length} context path(s)`,
    });
  }

  const blobsRemoved = runStep(
    "wipe_blobs",
    () => wipeEncryptedBlobs({ dataDir }).removed,
    0,
  );

  const ancillary = runStep(
    "wipe_ancillary_data",
    () => wipeFactoryResetAncillaryData({ dataDir }),
    { removed: 0, paths: [] },
  );

  // Wipe stale legacy DB files and DB backup snapshots in <dataDir>/data/.
  // These can carry the *previous* user state forward across a factory
  // reset (especially `personal_agent.db.bak.*` snapshots) — must run AFTER
  // VACUUM completes... wait, before. The compaction step below operates
  // on the active DB only, so order with respect to that step doesn't
  // matter. Place this with the other filesystem wipes.
  const staleDataArtifacts = runStep(
    "wipe_stale_data_artifacts",
    () => wipeStaleDataDirArtifacts({ dataDir }).removed,
    [] as string[],
  );

  let secretsDeleted: string[] = [];
  let secretDeleteFailures: SecretDeleteFailure[] = [];
  try {
    const result = await clearAllSecrets({ secretBroker, secretStore });
    secretsDeleted = result.deleted;
    secretDeleteFailures = result.failed;
    if (secretDeleteFailures.length > 0) {
      errors.push({
        step: "clear_secrets",
        message: `Failed to delete ${secretDeleteFailures.length} secret(s)`,
      });
    }
  } catch (err) {
    errors.push({ step: "clear_secrets", message: toSafeErrorMessage(err, "unknown") });
    logger.warn({ err }, "Factory reset clearAllSecrets failed");
  }

  const sequencesReset = runStep(
    "reset_sequences",
    () => resetAutoincrementSequences(db, getFactoryResetUserTables(db)),
    { reset: false, tables: [] },
  );

  const databaseCompacted = runStep(
    "compact_database",
    () => compactDatabaseAfterReset(db),
    { vacuumed: false, checkpointed: false },
  );

  const summary = {
    purged,
    settingsCleared: settingsChanges,
    context,
    blobsRemoved,
    ancillary,
    staleDataArtifactsRemoved: staleDataArtifacts.length,
    sequencesReset,
    databaseCompacted,
    secretsDeleted: secretsDeleted.length,
    secretDeleteFailures: secretDeleteFailures.length,
    searchIndexesRebuilt,
    tablesCleared,
    userTablesDropped: userTablesDropped.length,
    searchIndexesCleared,
    remainingTables,
    remainingSearchIndexes,
    errorCount: errors.length,
  };
  logger.warn(summary, "Factory reset completed");
  clearLogBuffer();

  return {
    purged,
    settingsCleared: settingsChanges,
    context,
    secretsDeleted,
    secretDeleteFailures,
    blobsRemoved,
    ancillary,
    staleDataArtifactsRemoved: staleDataArtifacts,
    sequencesReset,
    databaseCompacted,
    searchIndexesRebuilt,
    tablesCleared,
    userTablesDropped,
    searchIndexesCleared,
    remainingTables,
    remainingSearchIndexes,
    errors,
  };
}
