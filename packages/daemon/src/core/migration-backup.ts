import {
  chmodSync,
  closeSync,
  existsSync,
  linkSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  readlinkSync,
  copyFileSync,
  lstatSync,
  unlinkSync,
  utimesSync,
} from "node:fs";
import { join, relative, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createLogger } from "../logging.js";

const logger = createLogger("migration-backup");

const ICLOUD_EVICTED_XATTRS = [
  "com.apple.fileprovider.evicted",
  "com.apple.FileProviderExtendedAttributes",
] as const;

const CROSS_FS_HASH_RETRY_BACKOFF_MS = [100, 1000, 10_000] as const;

export type MigrationFsErrorCode =
  | "cross_fs_partial_failure"
  | "icloud_file_evicted";

export class MigrationFsError extends Error {
  constructor(
    readonly code: MigrationFsErrorCode,
    message: string,
    readonly path?: string,
  ) {
    super(message);
    this.name = "MigrationFsError";
  }
}

function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function removeTreeIfExists(absPath: string): void {
  try {
    if (existsSync(absPath)) {
      rmSync(absPath, { recursive: true, force: true });
    }
  } catch (err) {
    logger.warn({ err, absPath }, "Failed to clean up path");
  }
}

function removeMigratedTopLevelEntries(
  targetDir: string,
  sourceEntries: Iterable<string>,
): void {
  for (const name of sourceEntries) {
    removeTreeIfExists(join(targetDir, name));
  }
}

function listXattrs(absPath: string): string[] {
  if (process.platform !== "darwin") return [];
  try {
    const stdout = execFileSync("xattr", [absPath], {
      stdio: "pipe",
      encoding: "utf-8",
    }).trim();
    return stdout.length > 0
      ? stdout.split("\n").map((line) => line.trim()).filter(Boolean)
      : [];
  } catch {
    return [];
  }
}

function hasEvictedXattr(absPath: string): boolean {
  if (process.platform !== "darwin") return false;
  return ICLOUD_EVICTED_XATTRS.some((attr) => {
    try {
      const value = execFileSync("xattr", ["-p", attr, absPath], {
        stdio: "pipe",
        encoding: "utf-8",
      }).trim();
      return value !== "" && value !== "0";
    } catch {
      return false;
    }
  });
}

function ensureHydratedFile(absPath: string): void {
  // `brctl` is the macOS iCloud Drive hydration CLI and does not exist
  // on Linux/Windows. The `hasEvictedXattr` short-circuit below also
  // returns false off darwin, but pulling the platform check up front
  // makes this safe even if a future caller bypasses xattr inspection.
  if (process.platform !== "darwin") return;
  if (!lstatSync(absPath).isFile() || !hasEvictedXattr(absPath)) {
    return;
  }

  try {
    execFileSync("brctl", ["download", absPath], { stdio: "pipe" });
  } catch {
    throw new MigrationFsError(
      "icloud_file_evicted",
      `File is evicted from local storage and could not be hydrated: ${absPath}`,
      absPath,
    );
  }

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (!hasEvictedXattr(absPath)) {
      return;
    }
    sleepMs(250);
  }

  throw new MigrationFsError(
    "icloud_file_evicted",
    `File remained evicted after hydration attempt: ${absPath}`,
    absPath,
  );
}

function copyXattrsBestEffort(absSrc: string, absDst: string): void {
  if (process.platform !== "darwin") return;
  for (const attr of listXattrs(absSrc)) {
    try {
      const hexValue = execFileSync("xattr", ["-px", attr, absSrc], {
        stdio: "pipe",
        encoding: "utf-8",
      }).trim();
      if (hexValue.length === 0) continue;
      execFileSync("xattr", ["-wx", attr, hexValue, absDst], { stdio: "pipe" });
    } catch (err) {
      logger.warn({ err, absSrc, absDst, attr }, "Best-effort xattr copy failed");
    }
  }
}

/**
 * Recreate at `absDst` whatever symlink-ish thing lives at `absSrc`.
 *
 * On Windows, creating symlinks requires `SeCreateSymbolicLinkPrivilege`
 * (Developer Mode or elevation). When that privilege is missing,
 * `symlinkSync` throws EPERM/EACCES — we degrade to copying the symlink's
 * resolved file content so the migration still completes. Directory and
 * broken-link targets are logged and skipped (recursively copying through
 * symlinked directories is risky in agent context dirs and well outside
 * the expected shape).
 *
 * Defensive lstat first: a forward-flow caller passes a path that IS a
 * symlink, but the rollback path (`restoreFromBackup`,
 * `restoreOverwrittenTargetEntries`, `restoreDirectory`) reads from a
 * backup directory whose "symlink" manifest entry may have been
 * lossy-copied to a regular file on a previous Windows pass. In that
 * round-trip case `readlinkSync` would throw EINVAL and abort rollback —
 * the lstat branch turns it into a regular file copy instead, preserving
 * the data the user already has on disk.
 *
 * Verification (`verifyMoveCompleted`, `verifyTreeSha256`) only size- and
 * hash-checks `entry.kind === "file"` entries, so a symlink-replaced-with-
 * file at the destination still passes both checks for the original
 * `symlink` manifest entry.
 */
function mirrorSymlink(absSrc: string, absDst: string): void {
  let srcStat;
  try {
    srcStat = lstatSync(absSrc);
  } catch (err) {
    logger.warn({ err, absSrc, absDst }, "mirrorSymlink: source missing — skipping");
    return;
  }
  if (!srcStat.isSymbolicLink()) {
    // Round-trip case: a previous Windows pass already lossy-copied this
    // entry. Mirror the regular file directly. Non-file content (a
    // directory under a "symlink" manifest entry) shouldn't reach here
    // under any legitimate flow — log and skip rather than recurse.
    if (srcStat.isFile()) {
      copyFileSync(absSrc, absDst);
      return;
    }
    logger.warn(
      { absSrc, absDst, kind: srcStat.isDirectory() ? "dir" : "other" },
      "mirrorSymlink: source is neither symlink nor regular file — skipping",
    );
    return;
  }
  const target = readlinkSync(absSrc);
  try {
    symlinkSync(target, absDst);
    return;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    const isWindowsPrivilegeError =
      process.platform === "win32" && (code === "EPERM" || code === "EACCES");
    if (!isWindowsPrivilegeError) {
      throw err;
    }
  }
  // Windows fallback: copy what the symlink resolves to so the data is
  // preserved even though the link semantics are lost.
  try {
    const st = statSync(absSrc);
    if (st.isFile()) {
      copyFileSync(absSrc, absDst);
      logger.warn(
        { absSrc, absDst, target },
        "Windows: replaced symlink with file copy (no SeCreateSymbolicLinkPrivilege)",
      );
      return;
    }
    logger.warn(
      { absSrc, absDst, target, kind: st.isDirectory() ? "dir" : "other" },
      "Windows: skipping non-file symlink (no SeCreateSymbolicLinkPrivilege)",
    );
  } catch (statErr) {
    logger.warn(
      { statErr, absSrc, absDst, target },
      "Windows: skipping broken or unresolvable symlink (no SeCreateSymbolicLinkPrivilege)",
    );
  }
}

function preserveMetadataBestEffort(absSrc: string, absDst: string): void {
  try {
    const st = statSync(absSrc);
    chmodSync(absDst, st.mode & 0o7777);
    utimesSync(absDst, st.atime, st.mtime);
  } catch (err) {
    logger.warn({ err, absSrc, absDst }, "Best-effort metadata copy failed");
  }
}

function hashFileSha256(absPath: string): string {
  const fd = openSync(absPath, "r");
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  try {
    while (true) {
      const bytes = readSync(fd, buffer, 0, buffer.length, null);
      if (bytes === 0) break;
      hash.update(buffer.subarray(0, bytes));
    }
    return hash.digest("hex");
  } finally {
    closeSync(fd);
  }
}

function verifyCopiedFileSha256(absSrc: string, absDst: string): void {
  const srcHash = hashFileSha256(absSrc);
  const dstHash = hashFileSha256(absDst);
  if (srcHash !== dstHash) {
    throw new MigrationFsError(
      "cross_fs_partial_failure",
      `SHA-256 mismatch after cross-filesystem copy: ${absSrc}`,
      absSrc,
    );
  }
}

function verifyTreeSha256(manifest: Manifest, sourceDir: string, targetDir: string): void {
  for (const entry of manifest.files) {
    if (entry.kind !== "file") continue;
    const absSrc = join(sourceDir, entry.rel);
    const absDst = join(targetDir, entry.rel);
    ensureHydratedFile(absSrc);
    verifyCopiedFileSha256(absSrc, absDst);
  }
}

function copyFileWithVerification(absSrc: string, absDst: string): void {
  ensureHydratedFile(absSrc);
  let lastError: unknown;
  for (const backoffMs of [...CROSS_FS_HASH_RETRY_BACKOFF_MS, null] as Array<number | null>) {
    try {
      copyFileSync(absSrc, absDst);
      copyXattrsBestEffort(absSrc, absDst);
      preserveMetadataBestEffort(absSrc, absDst);
      verifyCopiedFileSha256(absSrc, absDst);
      return;
    } catch (err) {
      lastError = err;
      removeTreeIfExists(absDst);
      if (backoffMs !== null) {
        sleepMs(backoffMs);
      }
    }
  }

  if (lastError instanceof MigrationFsError) {
    throw lastError;
  }
  throw new MigrationFsError(
    "cross_fs_partial_failure",
    `Cross-filesystem copy verification failed for ${absSrc}`,
    absSrc,
  );
}

function copyTreeNodeCrossFs(sourceDir: string, targetDir: string, manifest: Manifest): void {
  const dirs: string[] = [];
  for (const entry of manifest.files) {
    const absSrc = join(sourceDir, entry.rel);
    const absDst = join(targetDir, entry.rel);
    if (entry.kind === "dir") {
      mkdirSync(absDst, { recursive: true, mode: entry.mode & 0o7777 });
      dirs.push(entry.rel);
      continue;
    }
    mkdirSync(dirname(absDst), { recursive: true });
    if (entry.kind === "symlink") {
      mirrorSymlink(absSrc, absDst);
      continue;
    }
    copyFileWithVerification(absSrc, absDst);
  }

  for (const rel of dirs.reverse()) {
    preserveMetadataBestEffort(join(sourceDir, rel), join(targetDir, rel));
  }
}

/**
 * Management Mode Phase 2 — filesystem plumbing for the context-directory
 * migration API. Pure utilities with no database or HTTP dependency so
 * they can be unit-tested against tmp directories.
 *
 * Design principles (plan §6.3, §6.5, §6.9):
 *   - Source is treated as read-only until the final move step; every
 *     failure before the move leaves the source untouched.
 *   - Backup is created BEFORE any destructive op. Same-fs uses hardlinks
 *     (O(1), shared inodes); cross-fs copies. The hardlink alias is
 *     broken by `finalizeBackup` on successful completion so the 7-day
 *     retention window is meaningful — otherwise a post-migration write
 *     to `today.md` would mutate the rollback copy through the shared
 *     inode.
 *   - Move prefers `rename(2)` when source and target share a filesystem;
 *     falls back to `cp -aR` for cross-fs (macOS-specific flags preserve
 *     resource forks / xattr / symlinks that node:fs cannot).
 *   - Restore is source-of-truth: to roll back, we wipe target and
 *     rename backup → source. The backup manifest is what we trust, not
 *     whatever partial state landed at target.
 *
 * Known simplifications vs the plan:
 *   - Progress SSE events (plan §6.3 / §6.5) are still emitted by the
 *     route layer, not here.
 *   - xattr copy in the node fallback is best-effort via the `xattr`
 *     CLI; failures are logged but do not abort an otherwise verified
 *     copy.
 */

export interface FileEntry {
  /** Path relative to the source root; never has a leading slash. */
  rel: string;
  /** File size in bytes, or 0 for directories/symlinks. */
  bytes: number;
  /** Copy of lstat mode so directory re-creation preserves permissions. */
  mode: number;
  /** "file" / "dir" / "symlink". */
  kind: "file" | "dir" | "symlink";
}

export interface Manifest {
  files: FileEntry[];
  totalBytes: number;
}

/**
 * Recursively walk a directory, returning every entry as a manifest.
 * Symlinks are recorded (not dereferenced) so they survive move/restore.
 * The root directory itself is NOT included.
 */
export function inspectDir(rootDir: string): Manifest {
  const files: FileEntry[] = [];
  let totalBytes = 0;

  function walk(absDir: string): void {
    let entries: string[];
    try {
      entries = readdirSync(absDir);
    } catch (err) {
      logger.warn({ err, dir: absDir }, "inspectDir: readdir failed, skipping");
      return;
    }
    for (const name of entries) {
      const abs = join(absDir, name);
      const rel = relative(rootDir, abs);
      let st;
      try {
        st = lstatSync(abs);
      } catch (err) {
        logger.warn({ err, path: abs }, "inspectDir: lstat failed, skipping");
        continue;
      }
      if (st.isSymbolicLink()) {
        files.push({ rel, bytes: 0, mode: st.mode, kind: "symlink" });
      } else if (st.isDirectory()) {
        files.push({ rel, bytes: 0, mode: st.mode, kind: "dir" });
        walk(abs);
      } else if (st.isFile()) {
        totalBytes += st.size;
        files.push({ rel, bytes: st.size, mode: st.mode, kind: "file" });
      }
    }
  }

  if (existsSync(rootDir)) walk(rootDir);
  return { files, totalBytes };
}

/**
 * Plan §6.4 — the set of files/directories the agent considers its own.
 * Used by the conflict detector to decide whether a target pre-existing
 * file is an agent-file collision (needs policy) or foreign content
 * (interleave vs abort).
 *
 * Keep this list synced with the top-level contents written by setup
 * and the morning/evening routines. A new top-level path that the agent
 * writes MUST be added here, or a migration could silently overwrite
 * user data that happens to share the name.
 */
export const AGENT_FILE_TOP_LEVEL = new Set<string>([
  // Loose top-level survivors (legacy + canonical _index.md).
  "today.md",
  "yesterday.md",
  "roadmap.md",
  "_index.md",
  "context-index.md",
  "agent-journal.md",
  "user.md",
  // Legacy top-level dirs (pre-CONTEXT_VAULT_REDESIGN) — kept so an
  // upgrading install whose target carries them is not flagged
  // foreign.
  "agent",
  "bases",
  "daily",
  "dossiers",
  "git",
  "git-repos",
  "inbox",
  "monthly",
  "projects",
  "routines",
  "rules",
  "schedule",
  "user",
  "user-details",
  "weekly",
  // CONTEXT_VAULT_REDESIGN six-class top-level dirs.
  "identity",
  "state",
  "plans",
  "journal",
  "knowledge",
  "policies",
]);

/**
 * Entries the migration silently ignores in a target directory — either
 * benign (Obsidian bookkeeping files that should stay in place) or
 * platform cruft (macOS `.DS_Store`). A target containing ONLY these
 * is treated as effectively empty and allowed under every conflict policy.
 */
const BENIGN_TARGET_ENTRIES = new Set<string>([
  ".obsidian",
  ".DS_Store",
]);

export type ConflictPolicy = "abort" | "merge" | "overwrite_agent_files";

export interface ConflictReport {
  targetExists: boolean;
  targetIsEmpty: boolean;
  foreignEntries: string[];
  agentFileConflicts: string[];
}

/**
 * True when `dir` contains no regular files anywhere in its subtree —
 * only directories and symlinks. Used by `inspectTarget` to filter out
 * stale skeleton scaffolding (the daemon's own `ensureSkeletonFiles`
 * mkdirs every CONTEXT_DIR_NAMES entry on every boot, and a previous
 * plain → obsidian migration leaves those empty dirs behind at the
 * data dir). Such residue is by definition not user content and must
 * not block a rollback under `policy: "abort"`.
 *
 * Symlinks are treated as files for safety — a stale symlink could
 * point at user data we shouldn't quietly overwrite.
 */
function dirHasNoFiles(dir: string): boolean {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return false;
  }
  for (const name of entries) {
    const child = join(dir, name);
    let st;
    try {
      st = lstatSync(child);
    } catch {
      return false;
    }
    if (st.isDirectory()) {
      if (!dirHasNoFiles(child)) return false;
      continue;
    }
    return false;
  }
  return true;
}

/**
 * Classify the target directory state. Entries that appear under the
 * agent's own top-level set AND also exist in the source are flagged as
 * agent-file conflicts; everything else under the target is "foreign"
 * content the user put there (or an untracked leftover).
 *
 * Works off top-level names rather than a full recursive diff because
 * the plan's policies are framed at the file-set level (whole
 * `projects/` subtree either moves intact or aborts), and a recursive
 * diff would be O(both trees) for no extra safety. The one recursive
 * walk we do — `dirHasNoFiles` — only runs on top-level directories
 * (typically <20) and short-circuits on the first file, so it's cheap.
 */
export function inspectTarget(
  targetDir: string,
  sourceEntries: Set<string>,
): ConflictReport {
  if (!existsSync(targetDir)) {
    return {
      targetExists: false,
      targetIsEmpty: true,
      foreignEntries: [],
      agentFileConflicts: [],
    };
  }
  // Filter out benign bookkeeping entries AND empty-directory residue
  // that the skeleton seeder leaves behind. An empty dir, even one with
  // empty subdirs, is scaffolding the daemon owns — never user content.
  const entries = readdirSync(targetDir).filter((name) => {
    if (BENIGN_TARGET_ENTRIES.has(name)) return false;
    const abs = join(targetDir, name);
    let st;
    try {
      st = lstatSync(abs);
    } catch {
      return true;
    }
    if (st.isDirectory() && dirHasNoFiles(abs)) return false;
    return true;
  });
  if (entries.length === 0) {
    return {
      targetExists: true,
      targetIsEmpty: true,
      foreignEntries: [],
      agentFileConflicts: [],
    };
  }
  const foreignEntries: string[] = [];
  const agentFileConflicts: string[] = [];
  for (const name of entries) {
    const isAgentName = AGENT_FILE_TOP_LEVEL.has(name);
    const overlapsSource = sourceEntries.has(name);
    if (isAgentName && overlapsSource) {
      agentFileConflicts.push(name);
    } else {
      foreignEntries.push(name);
    }
  }
  return {
    targetExists: true,
    targetIsEmpty: false,
    foreignEntries,
    agentFileConflicts,
  };
}

export type ConflictResolution =
  | { ok: true }
  | { ok: false; error: "target_has_unrelated_files"; entries: string[] }
  | { ok: false; error: "target_has_agent_file_conflicts"; entries: string[] };

export function resolveConflictPolicy(
  report: ConflictReport,
  policy: ConflictPolicy,
): ConflictResolution {
  if (!report.targetExists || report.targetIsEmpty) {
    return { ok: true };
  }
  if (report.foreignEntries.length > 0 && policy === "abort") {
    return {
      ok: false,
      error: "target_has_unrelated_files",
      entries: report.foreignEntries,
    };
  }
  if (report.agentFileConflicts.length > 0) {
    if (policy === "abort" || policy === "merge") {
      return {
        ok: false,
        error: "target_has_agent_file_conflicts",
        entries: report.agentFileConflicts,
      };
    }
    // "overwrite_agent_files": proceed.
  }
  return { ok: true };
}

/**
 * Detect whether two paths sit on the same filesystem via their stat
 * device numbers. If either path doesn't exist, walks up to the nearest
 * existing ancestor (same strategy as the config-level realpath helper).
 */
export function onSameFilesystem(a: string, b: string): boolean {
  const devOf = (p: string): number | null => {
    let cur = p;
    while (cur && cur !== "/" && cur !== ".") {
      try {
        return statSync(cur).dev;
      } catch {
        cur = dirname(cur);
      }
    }
    try {
      return statSync("/").dev;
    } catch {
      return null;
    }
  };
  const devA = devOf(a);
  const devB = devOf(b);
  return devA !== null && devB !== null && devA === devB;
}

export interface BackupResult {
  backupDir: string;
  manifest: Manifest;
  /** True if backup was created via hardlinks; false if copied. */
  hardlinked: boolean;
}

/**
 * Create a point-in-time backup of `sourceDir` under `backupDir`.
 *
 * Same-filesystem: every file is created as a hardlink to its source
 * counterpart. This is O(1) per file with zero extra disk. Directories
 * and symlinks are recreated literally. The hardlink aliasing means the
 * backup tracks subsequent source mutations — callers running a
 * migration must call `finalizeBackup` after the move so post-migration
 * writes cannot mutate the rollback copy.
 *
 * Cross-filesystem: files are copy_file_range'd (or the node copy
 * fallback). Slower but creates a genuinely independent snapshot so no
 * finalization is required.
 */
export function createBackup(
  sourceDir: string,
  backupDir: string,
): BackupResult {
  if (existsSync(backupDir)) {
    throw new Error(`Backup directory already exists: ${backupDir}`);
  }
  mkdirSync(backupDir, { recursive: true });
  const manifest = inspectDir(sourceDir);
  const hardlinked = onSameFilesystem(sourceDir, backupDir);
  try {
    for (const entry of manifest.files) {
      const absSrc = join(sourceDir, entry.rel);
      const absDst = join(backupDir, entry.rel);
      if (entry.kind === "dir") {
        mkdirSync(absDst, { recursive: true, mode: entry.mode & 0o7777 });
      } else if (entry.kind === "symlink") {
        mkdirSync(dirname(absDst), { recursive: true });
        mirrorSymlink(absSrc, absDst);
      } else if (entry.kind === "file") {
        ensureHydratedFile(absSrc);
        mkdirSync(dirname(absDst), { recursive: true });
        if (hardlinked) {
          linkSync(absSrc, absDst);
        } else {
          copyFileSync(absSrc, absDst);
          copyXattrsBestEffort(absSrc, absDst);
          preserveMetadataBestEffort(absSrc, absDst);
        }
      }
    }
  } catch (err) {
    removeTreeIfExists(backupDir);
    throw err;
  }

  logger.info(
    { sourceDir, backupDir, files: manifest.files.length, bytes: manifest.totalBytes, hardlinked },
    "Backup created",
  );
  return { backupDir, manifest, hardlinked };
}

/**
 * Break hardlink aliases to make the backup independent of the post-
 * migration source. Each file in the backup is copied out under a
 * sibling name and atomically renamed back over the hardlink. If the
 * backup was already a cross-fs copy, this is a no-op.
 *
 * Should be called AFTER the move commits and the settings update
 * succeeds — before that, the backup's own content is load-bearing for
 * rollback and we don't want to fault a broken-link scenario during
 * recovery.
 */
export function finalizeBackup(backup: BackupResult): void {
  if (!backup.hardlinked) {
    logger.debug({ backupDir: backup.backupDir }, "Backup not hardlinked — finalize is a no-op");
    return;
  }
  for (const entry of backup.manifest.files) {
    if (entry.kind !== "file") continue;
    const abs = join(backup.backupDir, entry.rel);
    const tmp = `${abs}.finalize-${process.pid}-${Date.now()}`;
    copyFileSync(abs, tmp);
    unlinkSync(abs);
    renameSync(tmp, abs);
  }
  logger.info({ backupDir: backup.backupDir, files: backup.manifest.files.length }, "Backup finalized (hardlinks broken)");
}

/**
 * Move `sourceDir` to `targetDir`. Uses `rename(2)` when both paths are
 * on the same filesystem AND the target doesn't exist yet — a single
 * atomic syscall that preserves every metadata bit. Otherwise falls
 * back to an entry-by-entry merge (same-fs) or `cp -aR` (cross-fs).
 *
 * Conflict handling: `targetDir` may already contain entries — the
 * caller is responsible for deciding via `inspectTarget` +
 * `resolveConflictPolicy` whether those entries should survive (merge
 * / benign-only case) or be replaced (overwrite_agent_files). moveTree
 * is permissive at the syscall level: if a source entry already exists
 * at the target, the target's version is replaced. The policy layer
 * runs BEFORE moveTree to make sure this is the desired behavior.
 */
export function moveTree(sourceDir: string, targetDir: string): void {
  const sameFs = onSameFilesystem(sourceDir, dirname(targetDir));

  if (sameFs) {
    if (existsSync(targetDir)) {
      // Target exists with contents (foreign, benign, or conflicting).
      // rename(2) can't replace a non-empty directory, so iterate.
      return mergeMoveSameFs(sourceDir, targetDir);
    }
    mkdirSync(dirname(targetDir), { recursive: true });
    renameSync(sourceDir, targetDir);
    return;
  }

  // Cross-filesystem: prefer `cp -aR` on POSIX (preserves mtime, mode,
  // xattr, resource forks). Windows has no `cp` binary, so go straight to
  // the Node fallback. The trailing `/.` on the POSIX path copies the
  // contents into an existing target directory (which we ensure exists).
  const manifest = inspectDir(sourceDir);
  const sourceTopLevel = listTopLevel(sourceDir);
  for (const entry of manifest.files) {
    if (entry.kind !== "file") continue;
    ensureHydratedFile(join(sourceDir, entry.rel));
  }
  mkdirSync(targetDir, { recursive: true });
  if (process.platform === "win32") {
    try {
      copyTreeNodeCrossFs(sourceDir, targetDir, manifest);
    } catch (err) {
      removeMigratedTopLevelEntries(targetDir, sourceTopLevel);
      logger.error({ err, targetDir }, "Cross-filesystem move failed");
      throw err;
    }
  } else {
    try {
      execFileSync("cp", ["-aR", `${sourceDir}/.`, targetDir], { stdio: "pipe" });
      verifyTreeSha256(manifest, sourceDir, targetDir);
    } catch (err) {
      // Clean up partial target so the caller's rollback sees a clean slate.
      removeMigratedTopLevelEntries(targetDir, sourceTopLevel);
      try {
        mkdirSync(targetDir, { recursive: true });
        copyTreeNodeCrossFs(sourceDir, targetDir, manifest);
      } catch (fallbackErr) {
        removeMigratedTopLevelEntries(targetDir, sourceTopLevel);
        logger.error({ err, fallbackErr, targetDir }, "Cross-filesystem move failed");
        if (fallbackErr instanceof MigrationFsError) {
          throw fallbackErr;
        }
        if (err instanceof MigrationFsError) {
          throw err;
        }
        throw fallbackErr;
      }
    }
  }
  // Source still exists on cross-fs copy; remove it to complete the move.
  rmSync(sourceDir, { recursive: true, force: true });
}

/**
 * Same-fs merge — hardlink every source entry into the target,
 * overwriting any colliding file. Directories are recreated (no-op
 * when they exist); symlinks are recreated after removing the existing
 * target entry if any; regular files are linked after unlinking the
 * target's pre-existing version. Source is removed after the walk.
 *
 * Pre-existing target entries that don't collide with source (foreign
 * files, `.obsidian/`, `.DS_Store`) are left untouched.
 */
function mergeMoveSameFs(sourceDir: string, targetDir: string): void {
  const manifest = inspectDir(sourceDir);
  for (const entry of manifest.files) {
    const absSrc = join(sourceDir, entry.rel);
    const absDst = join(targetDir, entry.rel);
    mkdirSync(dirname(absDst), { recursive: true });
    if (entry.kind === "dir") {
      mkdirSync(absDst, { recursive: true, mode: entry.mode & 0o7777 });
    } else if (entry.kind === "symlink") {
      // Remove any colliding target entry so symlink creation succeeds.
      try {
        if (existsSync(absDst)) rmSync(absDst, { recursive: true, force: true });
      } catch (err) {
        logger.warn({ err, absDst }, "mergeMoveSameFs: failed to unlink colliding symlink target");
      }
      mirrorSymlink(absSrc, absDst);
    } else {
      // Regular file: unlink colliding target (linkSync fails with EEXIST).
      try {
        if (existsSync(absDst)) unlinkSync(absDst);
      } catch (err) {
        logger.warn({ err, absDst }, "mergeMoveSameFs: failed to unlink colliding file");
      }
      linkSync(absSrc, absDst);
    }
  }
  rmSync(sourceDir, { recursive: true, force: true });
}

/**
 * Restore the source directory from a backup. Called from the endpoint's
 * rollback path when the move succeeded but a subsequent step (DB
 * rewrite, settings write) failed.
 *
 * Strategy: wipe whatever partial state landed at `sourceDir` (or
 * `targetDir`), then copy the backup tree back to `sourceDir`. Backup
 * remains intact afterwards so the admin can inspect it or we can
 * retry.
 */
export function restoreFromBackup(
  backup: BackupResult,
  sourceDir: string,
): void {
  // Wipe any partial source first — rollback is destructive by design.
  if (existsSync(sourceDir)) {
    rmSync(sourceDir, { recursive: true, force: true });
  }
  mkdirSync(sourceDir, { recursive: true });

  for (const entry of backup.manifest.files) {
    const absSrc = join(backup.backupDir, entry.rel);
    const absDst = join(sourceDir, entry.rel);
    if (entry.kind === "dir") {
      mkdirSync(absDst, { recursive: true, mode: entry.mode & 0o7777 });
    } else if (entry.kind === "symlink") {
      mkdirSync(dirname(absDst), { recursive: true });
      if (existsSync(absSrc)) {
        mirrorSymlink(absSrc, absDst);
      }
    } else if (entry.kind === "file") {
      mkdirSync(dirname(absDst), { recursive: true });
      copyFileSync(absSrc, absDst);
    }
  }
  logger.info(
    { sourceDir, backupDir: backup.backupDir, files: backup.manifest.files.length },
    "Source restored from backup",
  );
}

/**
 * Collect the set of top-level entry names (files and directories) in
 * `sourceDir`. Used by `inspectTarget` to decide which target entries
 * overlap with source file names.
 */
export function listTopLevel(dir: string): Set<string> {
  if (!existsSync(dir)) return new Set();
  return new Set(readdirSync(dir).filter((name) => !BENIGN_TARGET_ENTRIES.has(name)));
}

export interface VerifyResult {
  ok: boolean;
  missing: string[];
  sizeMismatch: Array<{ rel: string; expected: number; actual: number }>;
}

/**
 * Plan §6.5 "verification after move" — walk every entry in the
 * pre-move source manifest and confirm it exists at `targetDir` with
 * the expected size. Cheap existence-and-size check (no content hash)
 * that surfaces partial copies, truncated writes, or a filesystem that
 * silently dropped a file. Called after `moveTree` succeeds; any
 * missing or mismatched entry triggers rollback at the route level.
 *
 * Directories and symlinks are verified for existence only — size for
 * those is meaningless on most filesystems.
 */
export function verifyMoveCompleted(
  manifest: Manifest,
  targetDir: string,
): VerifyResult {
  const missing: string[] = [];
  const sizeMismatch: VerifyResult["sizeMismatch"] = [];
  for (const entry of manifest.files) {
    const abs = join(targetDir, entry.rel);
    let st;
    try {
      st = lstatSync(abs);
    } catch {
      missing.push(entry.rel);
      continue;
    }
    if (entry.kind === "file" && st.size !== entry.bytes) {
      sizeMismatch.push({ rel: entry.rel, expected: entry.bytes, actual: st.size });
    }
  }
  return { ok: missing.length === 0 && sizeMismatch.length === 0, missing, sizeMismatch };
}

/**
 * Reserved subdirectory inside a backup that holds target-side entries
 * the `overwrite_agent_files` policy is about to destroy. Kept as a
 * separate tree inside the backup so:
 *  - `restoreFromBackup` doesn't accidentally restore them to source,
 *  - the retention sweep still reaches them when the backup expires.
 */
const OVERWRITTEN_TARGET_SUBDIR = "_overwritten_target";

/**
 * Before `moveTree` runs in `overwrite_agent_files` mode, stash the
 * target-side entries that are about to be overwritten so a failed
 * migration can restore them. Without this the user's pre-existing
 * `today.md` at target is gone forever the moment mergeMove unlinks
 * it, and rollback has no way to reach it (the source backup doesn't
 * contain target's version).
 *
 * Same-fs uses hardlinks (zero extra disk); cross-fs copies. Returns
 * the list of stashed entries so rollback knows what to restore.
 */
export function stashOverwrittenTargetEntries(
  targetDir: string,
  entries: string[],
  backupDir: string,
): string[] {
  if (entries.length === 0) return [];
  const stashRoot = join(backupDir, OVERWRITTEN_TARGET_SUBDIR);
  mkdirSync(stashRoot, { recursive: true });
  const sameFs = onSameFilesystem(targetDir, backupDir);
  const stashed: string[] = [];
  for (const name of entries) {
    const src = join(targetDir, name);
    if (!existsSync(src)) continue;
    const dst = join(stashRoot, name);
    const st = lstatSync(src);
    if (st.isDirectory()) {
      // Recursively hardlink-or-copy the subtree.
      stashDirectory(src, dst, sameFs);
    } else if (st.isSymbolicLink()) {
      mirrorSymlink(src, dst);
    } else {
      if (sameFs) {
        linkSync(src, dst);
      } else {
        copyFileSync(src, dst);
      }
    }
    stashed.push(name);
  }
  logger.info(
    { stashRoot, entries: stashed, hardlinked: sameFs },
    "Overwritten target entries stashed",
  );
  return stashed;
}

function stashDirectory(srcDir: string, dstDir: string, sameFs: boolean): void {
  mkdirSync(dstDir, { recursive: true });
  for (const name of readdirSync(srcDir)) {
    const src = join(srcDir, name);
    const dst = join(dstDir, name);
    const st = lstatSync(src);
    if (st.isDirectory()) {
      stashDirectory(src, dst, sameFs);
    } else if (st.isSymbolicLink()) {
      mirrorSymlink(src, dst);
    } else {
      if (sameFs) {
        linkSync(src, dst);
      } else {
        copyFileSync(src, dst);
      }
    }
  }
}

/**
 * Restore target-side entries that `stashOverwrittenTargetEntries`
 * saved. Called by rollback when the overwrite path ran but a later
 * step failed. Removes any colliding source-version that moveTree
 * placed at target (rollback caller already attempts this for
 * migration-added entries; this path ensures it covers the overwrite
 * collisions too) then re-places the original target-side version.
 */
export function restoreOverwrittenTargetEntries(
  backup: BackupResult,
  targetDir: string,
  entries: string[],
): void {
  if (entries.length === 0) return;
  const stashRoot = join(backup.backupDir, OVERWRITTEN_TARGET_SUBDIR);
  if (!existsSync(stashRoot)) return;
  for (const name of entries) {
    const src = join(stashRoot, name);
    const dst = join(targetDir, name);
    if (!existsSync(src)) continue;
    try {
      if (existsSync(dst)) rmSync(dst, { recursive: true, force: true });
    } catch (err) {
      logger.warn({ err, dst }, "restoreOverwrittenTargetEntries: pre-cleanup failed");
    }
    const st = lstatSync(src);
    if (st.isDirectory()) {
      restoreDirectory(src, dst);
    } else if (st.isSymbolicLink()) {
      mirrorSymlink(src, dst);
    } else {
      copyFileSync(src, dst);
    }
  }
  logger.info({ targetDir, entries }, "Overwritten target entries restored");
}

function restoreDirectory(srcDir: string, dstDir: string): void {
  mkdirSync(dstDir, { recursive: true });
  for (const name of readdirSync(srcDir)) {
    const src = join(srcDir, name);
    const dst = join(dstDir, name);
    const st = lstatSync(src);
    if (st.isDirectory()) {
      restoreDirectory(src, dst);
    } else if (st.isSymbolicLink()) {
      mirrorSymlink(src, dst);
    } else {
      copyFileSync(src, dst);
    }
  }
}
