import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import type Database from "better-sqlite3";
import { createLogger } from "../logging.js";

const logger = createLogger("reinstall");

/**
 * B-007 §7 — clean reinstall (no migration).
 *
 * Two-phase operation:
 *   1. `planReinstall` — pure enumeration of what WILL be touched. Safe to
 *      surface in a dashboard confirmation screen. No side effects.
 *   2. `executeReinstall` — performs the destructive operation. Always
 *      called AFTER explicit user confirmation (see §7.2 Phase A) and a
 *      CLI / dashboard guard that requires the literal string "CLEAN".
 *
 * Keep: OS keychain secrets, cache/, .env, google-credentials.json,
 * google-token.json. Wipe: context/ and md_file_snapshots rows. Other
 * SQLite tables (conversation_sessions, messages, agent_actions, etc.)
 * are preserved — see §7.1.
 */

export interface ReinstallPlan {
  contextDir: string;
  /** Absolute paths of all files that will be deleted from context/. */
  filesToDelete: string[];
  /** Total size in bytes of files that will be deleted. */
  totalBytes: number;
  /** Number of rows in md_file_snapshots that will be deleted. */
  snapshotRowCount: number;
  /** Target path for the tarball safety backup. */
  backupPath: string;
  /**
   * Ancillary runtime caches that the spec §7.1 says to wipe alongside
   * context/ — `prompts/` (rendered system-prompt cache, regenerable) and
   * `agent-sessions/` (per-session workdirs pinned to the old layout).
   * Absent entries are skipped at execute time.
   */
  ancillaryDirs: string[];
}

export interface ReinstallResult {
  backupPath: string | null;
  filesDeleted: number;
  bytesDeleted: number;
  snapshotRowsDeleted: number;
  ancillaryDirsRemoved: string[];
}

export interface SpawnTarArgs {
  source: string;
  target: string;
  parent: string;
  leaf: string;
}

export interface SpawnTarResult {
  status: number | null;
  /**
   * Spawn-level error code (e.g. "ENOENT" when `tar` is absent from PATH).
   * Optional → backward-compatible with stubs that return only `status`.
   */
  errorCode?: string;
}

export interface ReinstallDeps {
  contextDir: string;
  db: Database.Database;
  /** Directory where the tarball backup is written. Defaults to a sibling of contextDir. */
  backupDir?: string;
  /**
   * Ancillary caches under the data dir to wipe alongside context/. Spec
   * §7.1 lists `prompts/` and `agent-sessions/`. Defaults to those two
   * resolved relative to contextDir's parent.
   */
  ancillaryDirs?: string[];
  /** Provides the current timestamp (override for determinism in tests). */
  now?: () => Date;
  /**
   * Override for the tar invocation. Production uses `spawnSync("tar", ...)`;
   * tests swap in a stub that writes the target file and returns status 0,
   * or returns non-zero to exercise the failure branch.
   */
  spawnTar?: (args: SpawnTarArgs) => SpawnTarResult;
}

/**
 * Enumerate, without side effects, everything a clean reinstall would remove.
 */
export function planReinstall(deps: ReinstallDeps): ReinstallPlan {
  const { contextDir, db } = deps;
  const now = deps.now?.() ?? new Date();
  const { filesToDelete, totalBytes } = enumerateContextFiles(contextDir);
  const snapshotRowCount = countSnapshotRows(db);
  const backupPath = backupTargetPath(
    deps.backupDir ?? defaultBackupDir(contextDir),
    now,
  );
  const ancillaryDirs = deps.ancillaryDirs ?? defaultAncillaryDirs(contextDir);
  return {
    contextDir,
    filesToDelete,
    totalBytes,
    snapshotRowCount,
    backupPath,
    ancillaryDirs,
  };
}

/**
 * Execute a clean reinstall. Must be called after explicit user
 * confirmation (§7.2 Phase A). Writes a tarball backup first, then wipes
 * context/ and md_file_snapshots rows. Safe to call even when context/
 * does not exist; the tarball step is skipped.
 */
export async function executeReinstall(deps: ReinstallDeps): Promise<ReinstallResult> {
  const plan = planReinstall(deps);

  let backupPath: string | null = null;
  if (existsSync(plan.contextDir) && plan.filesToDelete.length > 0) {
    try {
      await createTarballBackup(
        plan.contextDir,
        plan.backupPath,
        deps.spawnTar,
      );
      backupPath = plan.backupPath;
      logger.info({ backupPath }, "Context tarball backup created");
    } catch (err) {
      logger.error({ err }, "Backup failed — aborting reinstall");
      throw err;
    }
  }

  const bytesDeleted = plan.totalBytes;
  const filesDeleted = plan.filesToDelete.length;

  if (existsSync(plan.contextDir)) {
    rmSync(plan.contextDir, { recursive: true, force: true });
    logger.info({ contextDir: plan.contextDir }, "context/ wiped");
  }

  const snapshotResult = deps.db
    .prepare("DELETE FROM md_file_snapshots")
    .run();
  const snapshotRowsDeleted = snapshotResult.changes;
  logger.info({ snapshotRowsDeleted }, "md_file_snapshots rows deleted");

  // Spec §7.1 — wipe ancillary caches so the next daemon boot cannot load a
  // stale `prompts/` rendering or session workdir that still references the
  // old vault layout. Missing directories are skipped silently.
  const ancillaryDirsRemoved: string[] = [];
  for (const dir of plan.ancillaryDirs) {
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
      ancillaryDirsRemoved.push(dir);
      logger.info({ dir }, "Ancillary cache wiped");
    }
  }

  return {
    backupPath,
    filesDeleted,
    bytesDeleted,
    snapshotRowsDeleted,
    ancillaryDirsRemoved,
  };
}

/**
 * Recursively enumerate files under contextDir with accumulated byte size.
 * Pure helper exported for unit testing the planner without touching a DB.
 */
export function enumerateContextFiles(contextDir: string): {
  filesToDelete: string[];
  totalBytes: number;
} {
  if (!existsSync(contextDir)) {
    return { filesToDelete: [], totalBytes: 0 };
  }

  const files: string[] = [];
  let totalBytes = 0;

  const walk = (dir: string): void => {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        files.push(full);
        totalBytes += statSync(full).size;
      }
    }
  };

  walk(contextDir);
  return { filesToDelete: files, totalBytes };
}

export function countSnapshotRows(db: Database.Database): number {
  try {
    const row = db
      .prepare("SELECT COUNT(*) as n FROM md_file_snapshots")
      .get() as { n: number };
    return row.n;
  } catch {
    return 0;
  }
}

/**
 * Default backup directory: sibling of contextDir named `backup/`.
 * Example: contextDir = `~/.personal-agent/context` → `~/.personal-agent/backup`.
 */
export function defaultBackupDir(contextDir: string): string {
  return join(dirname(contextDir), "backup");
}

/**
 * Default ancillary caches to wipe alongside context/. Spec §7.1 lists
 * `prompts/` (regenerable rendered prompts) and `agent-sessions/` (session
 * workdirs bound to the old vault layout). Resolved as siblings of contextDir.
 */
export function defaultAncillaryDirs(contextDir: string): string[] {
  const parent = dirname(contextDir);
  return [join(parent, "prompts"), join(parent, "agent-sessions")];
}

/**
 * Construct the tarball backup target path.
 * Format: `<backupDir>/context-pre-reinstall-<ISO-no-colons>.tar.gz`.
 */
export function backupTargetPath(backupDir: string, now: Date): string {
  const iso = now.toISOString().replace(/[:.]/g, "-");
  return join(backupDir, `context-pre-reinstall-${iso}.tar.gz`);
}

/**
 * Create a gzip-compressed tarball of contextDir at backupPath. Uses the
 * system `tar` CLI (POSIX + macOS + Linux) to avoid a js-only tar dep.
 * Throws when tar exits non-zero. Overridable via `spawnTar` for tests.
 */
async function createTarballBackup(
  contextDir: string,
  backupPath: string,
  spawnTar?: ReinstallDeps["spawnTar"],
): Promise<void> {
  mkdirSync(dirname(backupPath), { recursive: true });

  // `tar -czf` reads files and writes a compressed archive.
  // -C parent so the archive contains just the leaf directory name rather
  // than the full absolute path.
  const parent = dirname(contextDir);
  const leaf = contextDir.slice(parent.length + 1);
  const runner = spawnTar ?? defaultSpawnTar;
  const result = runner({
    source: contextDir,
    target: backupPath,
    parent,
    leaf,
  });
  if (result.status !== 0) {
    // On Windows hosts that lack `tar`/`bsdtar` on PATH, `spawnSync` returns
    // status null with a spawn-level ENOENT instead of a non-zero exit. The
    // backup-first ordering guarantees nothing was deleted yet, so surface an
    // actionable message rather than the opaque "exited with status null".
    if (result.errorCode === "ENOENT" || result.status === null) {
      throw new Error(
        "Cannot create the safety backup: the 'tar' command was not found on PATH. " +
          "Install tar/bsdtar (bundled with Windows 10 1803+ and Windows 11) or run the reinstall on a host that has it.",
      );
    }
    throw new Error(
      `tar exited with status ${result.status} while writing ${backupPath}`,
    );
  }
}

function defaultSpawnTar(args: SpawnTarArgs): SpawnTarResult {
  const result = spawnSync(
    "tar",
    ["-czf", args.target, "-C", args.parent, args.leaf],
    { stdio: "ignore" },
  );
  // `spawnSync().error` is typed as plain Error, but a failed spawn carries an
  // errno `code` (e.g. "ENOENT" when `tar` is absent from PATH on Windows).
  const errorCode = (result.error as NodeJS.ErrnoException | undefined)?.code;
  return { status: result.status, errorCode };
}
