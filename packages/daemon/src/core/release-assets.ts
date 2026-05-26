import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type Database from "better-sqlite3";
import {
  readRuntimeState,
  writeRuntimeState,
} from "../db/runtime-state.js";
import {
  readFileTemplateVersion,
  readTemplateManifest,
  writePendingTemplateUpgrades,
  type PendingTemplateUpgrade,
} from "./template-versions.js";
import { writeFileAtomically } from "./atomic-write.js";

export const RELEASE_ASSETS_STATUS_KEY = "release_assets.status";
export const RELEASE_ASSETS_DOCS_SNAPSHOT_KEY = "release_assets.docs_snapshot";
export const RELEASE_ASSETS_TEMPLATES_SNAPSHOT_KEY = "release_assets.templates_snapshot";
export const INSTRUCTION_ASSETS_STAMP = ".aitne-instruction-assets.json";

export interface AssetFileSnapshot {
  sourceSha256: string;
  targetSha256: string;
  version?: number;
}

export interface AssetSnapshotRecord {
  checkedAt: string;
  sourceRoot: string;
  targetRoot: string;
  files: Record<string, AssetFileSnapshot>;
}

export interface AssetConflict {
  path: string;
  reason: "user_modified" | "unknown_base" | "write_failed";
  detail?: string;
  from?: number;
  to?: number;
}

export interface DocsAssetStatus {
  checkedAt: string;
  sourceRoot: string;
  targetRoot: string;
  added: number;
  autoUpdated: number;
  unchanged: number;
  conflicts: AssetConflict[];
  removedFromSource: string[];
  errors: AssetConflict[];
  backupRoot: string | null;
}

export interface TemplateAssetStatus {
  checkedAt: string;
  sourceRoot: string | null;
  targetRoot: string;
  added: number;
  autoUpdated: number;
  unchanged: number;
  pending: PendingTemplateUpgrade[];
  conflicts: AssetConflict[];
  errors: AssetConflict[];
  backupRoot: string | null;
}

export interface InstructionAssetStatus {
  checkedAt: string;
  fingerprint: string;
  files: number;
  bytes: number;
}

export interface SkillAssetStatus {
  checkedAt: string;
  builtinShadowedUserSkills: string[];
}

export interface ReleaseAssetStatusRecord {
  checkedAt: string;
  docs?: DocsAssetStatus;
  templates?: TemplateAssetStatus;
  instructionAssets?: InstructionAssetStatus;
  skills?: SkillAssetStatus;
}

export interface ReconcileDocsOptions {
  db: Database.Database;
  sourceDir: string;
  targetDir: string;
  backupRoot?: string | null;
  now?: () => Date;
}

export interface ReconcileTemplateOptions {
  db: Database.Database;
  templatesRoot: string | null;
  contextDir: string;
  backupRoot?: string | null;
  now?: () => Date;
}

const DOC_EXT = ".md";
const HASHED_INSTRUCTION_ROOTS = [
  "agent-assets/agent-profiles",
  "agent-assets/skills",
  "agent-assets/task-flows",
  // docs/design/appendices/skills-unification.md Phase 1 §"Consequential changes" item 3 —
  // the per-session fingerprint must cover any source file whose contents
  // land in the materialised instruction file. `system-prompts/` ships
  // `skill-index-instruction.md` (preamble inlined into every Codex /
  // Gemini AGENTS.md / GEMINI.md via `loadSkillIndexPreamble`) and
  // `routine-fetch-window.md` (the slim CLI body written verbatim by
  // `materializeFetchWindowCliSession`). Without this root, an edit to
  // either file leaves in-flight sessions stuck on the stale text past
  // the next dispatch.
  "agent-assets/system-prompts",
] as const;

let instructionFingerprintCache:
  | { workspaceDir: string; status: InstructionAssetStatus }
  | null = null;

function iso(now?: () => Date): string {
  return (now?.() ?? new Date()).toISOString();
}

function backupSegment(now: Date): string {
  return now.toISOString().replace(/[:.]/g, "-");
}

function sha256Bytes(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function sha256File(absPath: string): string {
  return sha256Bytes(readFileSync(absPath));
}

function normalizeRelPath(relPath: string): string | null {
  if (!relPath || isAbsolute(relPath)) return null;
  const normalized = relPath.split(sep).join("/");
  const parts = normalized.split("/");
  if (parts.some((part) => part.length === 0 || part === "." || part === "..")) {
    return null;
  }
  return normalized;
}

function resolveInside(root: string, relPath: string): string | null {
  const normalized = normalizeRelPath(relPath);
  if (!normalized) return null;
  const abs = resolve(root, normalized);
  const rel = relative(root, abs);
  if (rel.startsWith("..") || isAbsolute(rel)) return null;
  return abs;
}

function listFiles(root: string, predicate: (relPath: string) => boolean): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(abs, relPath);
        continue;
      }
      if (!entry.isFile()) continue;
      if (predicate(relPath)) out.push(relPath);
    }
  };
  walk(root, "");
  return out.sort((a, b) => a.localeCompare(b));
}

function copyWithParents(src: string, dst: string): void {
  mkdirSync(dirname(dst), { recursive: true, mode: 0o700 });
  copyFileSync(src, dst);
}

function backupExistingFile(
  absPath: string,
  backupRoot: string | null | undefined,
  kind: "docs" | "templates",
  relPath: string,
  now: Date,
): string | null {
  if (!backupRoot) return null;
  const dest = resolve(backupRoot, backupSegment(now), kind, relPath);
  copyWithParents(absPath, dest);
  return dest;
}

export function readReleaseAssetStatus(
  db: Database.Database,
): ReleaseAssetStatusRecord | null {
  return readRuntimeState<ReleaseAssetStatusRecord>(db, RELEASE_ASSETS_STATUS_KEY);
}

function updateReleaseAssetStatus(
  db: Database.Database,
  patch: Partial<Omit<ReleaseAssetStatusRecord, "checkedAt">>,
  checkedAt: string,
): void {
  const previous = readReleaseAssetStatus(db);
  writeRuntimeState(db, RELEASE_ASSETS_STATUS_KEY, {
    ...(previous ?? {}),
    ...patch,
    checkedAt,
  } satisfies ReleaseAssetStatusRecord);
}

function readDocsSnapshot(db: Database.Database): AssetSnapshotRecord | null {
  return readRuntimeState<AssetSnapshotRecord>(
    db,
    RELEASE_ASSETS_DOCS_SNAPSHOT_KEY,
  );
}

function writeDocsSnapshot(
  db: Database.Database,
  snapshot: AssetSnapshotRecord,
): void {
  writeRuntimeState(db, RELEASE_ASSETS_DOCS_SNAPSHOT_KEY, snapshot);
}

function readTemplateSnapshot(db: Database.Database): AssetSnapshotRecord | null {
  return readRuntimeState<AssetSnapshotRecord>(
    db,
    RELEASE_ASSETS_TEMPLATES_SNAPSHOT_KEY,
  );
}

function writeTemplateSnapshot(
  db: Database.Database,
  snapshot: AssetSnapshotRecord,
): void {
  writeRuntimeState(db, RELEASE_ASSETS_TEMPLATES_SNAPSHOT_KEY, snapshot);
}

/**
 * Reconcile the operator-facing docs corpus (`docs/user`) against the
 * bundled seed corpus. Files that still match the previous shipped hash
 * are refreshed automatically; files with user edits are preserved and
 * reported as conflicts for manual review.
 */
export function reconcileDocsCorpus(options: ReconcileDocsOptions): DocsAssetStatus {
  const checkedAt = iso(options.now);
  const now = options.now?.() ?? new Date();
  const previous = readDocsSnapshot(options.db);
  const files = listFiles(options.sourceDir, (relPath) => relPath.endsWith(DOC_EXT));
  mkdirSync(options.targetDir, { recursive: true, mode: 0o700 });
  const nextSnapshot: AssetSnapshotRecord = {
    checkedAt,
    sourceRoot: options.sourceDir,
    targetRoot: options.targetDir,
    files: {},
  };

  let added = 0;
  let autoUpdated = 0;
  let unchanged = 0;
  const conflicts: AssetConflict[] = [];
  const errors: AssetConflict[] = [];
  if (!existsSync(options.sourceDir)) {
    errors.push({
      path: options.sourceDir,
      reason: "write_failed",
      detail: "source_missing",
    });
  }

  for (const relPath of files) {
    const src = resolveInside(options.sourceDir, relPath);
    const dst = resolveInside(options.targetDir, relPath);
    if (!src || !dst) {
      errors.push({ path: relPath, reason: "write_failed", detail: "path_outside_root" });
      continue;
    }

    try {
      const sourceSha256 = sha256File(src);
      if (!existsSync(dst)) {
        copyWithParents(src, dst);
        added++;
      } else {
        const currentSha256 = sha256File(dst);
        const previousFile = previous?.files[relPath];
        const canAutoUpdate =
          previousFile !== undefined
          && currentSha256 === previousFile.sourceSha256;
        if (currentSha256 === sourceSha256) {
          unchanged++;
        } else if (canAutoUpdate) {
          backupExistingFile(dst, options.backupRoot, "docs", relPath, now);
          writeFileAtomically(dst, readFileSync(src, "utf-8"));
          autoUpdated++;
        } else {
          conflicts.push({
            path: relPath,
            reason: previousFile ? "user_modified" : "unknown_base",
            detail: previousFile
              ? "target differs from the last shipped hash"
              : "no previous shipped hash is available for safe auto-merge",
          });
        }
      }

      nextSnapshot.files[relPath] = {
        sourceSha256,
        /* v8 ignore next */
        targetSha256: existsSync(dst) ? sha256File(dst) : sourceSha256,
      };
    } catch (err) {
      errors.push({
        path: relPath,
        reason: "write_failed",
        /* v8 ignore next */
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const removedFromSource = previous
    ? Object.keys(previous.files)
      .filter((relPath) => !nextSnapshot.files[relPath])
      .filter((relPath) => {
        const dst = resolveInside(options.targetDir, relPath);
        return dst !== null && existsSync(dst);
      })
      .sort((a, b) => a.localeCompare(b))
    : [];

  writeDocsSnapshot(options.db, nextSnapshot);
  const status: DocsAssetStatus = {
    checkedAt,
    sourceRoot: options.sourceDir,
    targetRoot: options.targetDir,
    added,
    autoUpdated,
    unchanged,
    conflicts,
    removedFromSource,
    errors,
    backupRoot: options.backupRoot ?? null,
  };
  updateReleaseAssetStatus(options.db, { docs: status }, checkedAt);
  return status;
}

/**
 * Reconcile versioned context templates. Existing user-edited files are never
 * overwritten. A file is auto-updated only when it still matches the hash we
 * recorded for the previous shipped template version.
 */
export function reconcileTemplateAssets(
  options: ReconcileTemplateOptions,
): TemplateAssetStatus {
  const checkedAt = iso(options.now);
  const now = options.now?.() ?? new Date();
  const emptyStatus = (sourceRoot: string | null): TemplateAssetStatus => ({
    checkedAt,
    sourceRoot,
    targetRoot: options.contextDir,
    added: 0,
    autoUpdated: 0,
    unchanged: 0,
    pending: [],
    conflicts: [],
    errors: [],
    backupRoot: options.backupRoot ?? null,
  });

  if (options.templatesRoot === null) {
    writePendingTemplateUpgrades(options.db, []);
    const status = emptyStatus(null);
    updateReleaseAssetStatus(options.db, { templates: status }, checkedAt);
    return status;
  }

  const manifest = readTemplateManifest(options.templatesRoot);
  if (manifest === null) {
    writePendingTemplateUpgrades(options.db, []);
    const status = emptyStatus(options.templatesRoot);
    status.errors.push({
      path: "_manifest.json",
      reason: "write_failed",
      detail: "manifest_missing_or_malformed",
    });
    updateReleaseAssetStatus(options.db, { templates: status }, checkedAt);
    return status;
  }

  const previous = readTemplateSnapshot(options.db);
  const nextSnapshot: AssetSnapshotRecord = {
    checkedAt,
    sourceRoot: options.templatesRoot,
    targetRoot: options.contextDir,
    files: {},
  };
  let added = 0;
  let autoUpdated = 0;
  let unchanged = 0;
  const pending: PendingTemplateUpgrade[] = [];
  const conflicts: AssetConflict[] = [];
  const errors: AssetConflict[] = [];

  for (const [relPath, entry] of Object.entries(manifest.templates)) {
    const src = resolveInside(options.templatesRoot, relPath);
    const dst = resolveInside(options.contextDir, relPath);
    if (!src || !dst) {
      errors.push({ path: relPath, reason: "write_failed", detail: "path_outside_root" });
      continue;
    }
    if (!existsSync(src)) {
      errors.push({ path: relPath, reason: "write_failed", detail: "source_missing" });
      continue;
    }

    try {
      const sourceSha256 = sha256File(src);
      if (!existsSync(dst)) {
        copyWithParents(src, dst);
        added++;
      } else {
        const targetVersion = readFileTemplateVersion(dst);
        const currentSha256 = sha256File(dst);
        if (targetVersion !== null && targetVersion < entry.version) {
          const previousFile = previous?.files[relPath];
          const canAutoUpdate =
            previousFile !== undefined
            && currentSha256 === previousFile.sourceSha256;
          if (canAutoUpdate) {
            backupExistingFile(dst, options.backupRoot, "templates", relPath, now);
            writeFileAtomically(dst, readFileSync(src, "utf-8"));
            autoUpdated++;
          } else {
            pending.push({ path: relPath, from: targetVersion, to: entry.version });
            conflicts.push({
              path: relPath,
              reason: previousFile ? "user_modified" : "unknown_base",
              from: targetVersion,
              to: entry.version,
              detail: previousFile
                ? "target differs from the last shipped template hash"
                : "no previous shipped hash is available for safe auto-merge",
            });
          }
        } else {
          unchanged++;
        }
      }

      nextSnapshot.files[relPath] = {
        sourceSha256,
        /* v8 ignore next */
        targetSha256: existsSync(dst) ? sha256File(dst) : sourceSha256,
        version: entry.version,
      };
    } catch (err) {
      errors.push({
        path: relPath,
        reason: "write_failed",
        /* v8 ignore next */
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  pending.sort((a, b) => a.path.localeCompare(b.path));
  conflicts.sort((a, b) => a.path.localeCompare(b.path));
  writeTemplateSnapshot(options.db, nextSnapshot);
  writePendingTemplateUpgrades(options.db, pending);

  const status: TemplateAssetStatus = {
    checkedAt,
    sourceRoot: options.templatesRoot,
    targetRoot: options.contextDir,
    added,
    autoUpdated,
    unchanged,
    pending,
    conflicts,
    errors,
    backupRoot: options.backupRoot ?? null,
  };
  updateReleaseAssetStatus(options.db, { templates: status }, checkedAt);
  return status;
}

export function computeInstructionAssetStatus(
  workspaceDir: string,
  now?: () => Date,
): InstructionAssetStatus {
  const absWorkspace = resolve(workspaceDir);
  if (instructionFingerprintCache?.workspaceDir === absWorkspace) {
    return instructionFingerprintCache.status;
  }

  const hash = createHash("sha256");
  let files = 0;
  let bytes = 0;
  for (const rootRel of HASHED_INSTRUCTION_ROOTS) {
    const root = join(absWorkspace, rootRel);
    for (const relPath of listFiles(root, () => true)) {
      const abs = join(root, relPath);
      const body = readFileSync(abs);
      files++;
      bytes += body.byteLength;
      hash.update(`${rootRel}/${relPath}\0`);
      hash.update(body);
      hash.update("\0");
    }
  }

  const status: InstructionAssetStatus = {
    checkedAt: iso(now),
    fingerprint: hash.digest("hex"),
    files,
    bytes,
  };
  instructionFingerprintCache = { workspaceDir: absWorkspace, status };
  return status;
}

export function recordInstructionAssetStatus(
  db: Database.Database,
  workspaceDir: string,
  now?: () => Date,
): InstructionAssetStatus {
  const status = computeInstructionAssetStatus(workspaceDir, now);
  updateReleaseAssetStatus(db, { instructionAssets: status }, status.checkedAt);
  return status;
}

export function readInstructionAssetStamp(sessionDir: string): string | null {
  const stampPath = join(sessionDir, INSTRUCTION_ASSETS_STAMP);
  if (!existsSync(stampPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(stampPath, "utf-8")) as {
      fingerprint?: unknown;
    };
    return typeof parsed.fingerprint === "string" ? parsed.fingerprint : null;
  } catch {
    return null;
  }
}

/**
 * docs/design/appendices/skills-unification.md Phase 1 item 14 — per-session manifest
 * snapshot recorded alongside the asset fingerprint. The snapshot captures
 * the (processKey, skill-slug set) the workdir was last materialised for
 * so a subsequent turn whose manifest resolves to a different slug set
 * triggers a forced re-render — even when the source assets themselves
 * are byte-identical.
 *
 * Returns `null` for stamps written before Phase 1 (no manifest field),
 * for missing / unparseable stamps, and when the JSON shape is wrong.
 * Callers treat `null` as "no recorded manifest" → force re-render to
 * upgrade the stamp.
 */
export function readInstructionStampManifest(
  sessionDir: string,
): { processKey: string; skillSlugs: string[] } | null {
  const stampPath = join(sessionDir, INSTRUCTION_ASSETS_STAMP);
  if (!existsSync(stampPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(stampPath, "utf-8")) as {
      manifest?: { processKey?: unknown; skillSlugs?: unknown };
    };
    const m = parsed.manifest;
    if (!m) return null;
    if (typeof m.processKey !== "string") return null;
    if (!Array.isArray(m.skillSlugs)) return null;
    const slugs: string[] = [];
    for (const s of m.skillSlugs) {
      if (typeof s !== "string") return null;
      slugs.push(s);
    }
    return { processKey: m.processKey, skillSlugs: slugs };
  } catch {
    return null;
  }
}

export function writeInstructionAssetStamp(
  sessionDir: string,
  status: InstructionAssetStatus,
  manifest?: { processKey: string; skillSlugs: readonly string[] },
): void {
  const payload: Record<string, unknown> = {
    fingerprint: status.fingerprint,
    checkedAt: status.checkedAt,
    files: status.files,
    bytes: status.bytes,
  };
  if (manifest) {
    payload.manifest = {
      processKey: manifest.processKey,
      skillSlugs: [...manifest.skillSlugs].sort(),
    };
  }
  writeFileSync(
    join(sessionDir, INSTRUCTION_ASSETS_STAMP),
    JSON.stringify(payload),
    "utf-8",
  );
}

export function sessionInstructionAssetsStale(
  sessionDir: string,
  workspaceDir: string,
): boolean {
  if (!existsSync(sessionDir)) return false;
  const current = computeInstructionAssetStatus(workspaceDir);
  return readInstructionAssetStamp(sessionDir) !== current.fingerprint;
}

function listSkillSlugs(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .filter((entry) => existsSync(join(root, entry.name, "SKILL.md")))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
}

/**
 * `userSkillsRoot` is the absolute user-skills directory. Production callers
 * derive it via `resolveUserSkillsRoot(config)` from `core/user-skills-root.ts`
 * (CONTEXT_VAULT_REDESIGN_PLAN.md v4 V11 — post-migration this resolves to
 * `<contextDir>/policies/skills`). Tests may pass any directory directly so
 * the helper remains decoupled from `AgentConfig`.
 */
export function findBuiltinShadowedUserSkills(
  userSkillsRoot: string,
  workspaceDir: string,
): string[] {
  const userSkills = new Set(listSkillSlugs(userSkillsRoot));
  const builtinSkills = listSkillSlugs(join(workspaceDir, "agent-assets", "skills"));
  return builtinSkills.filter((slug) => userSkills.has(slug));
}

export function recordSkillAssetStatus(
  db: Database.Database,
  userSkillsRoot: string,
  workspaceDir: string,
  now?: () => Date,
): SkillAssetStatus {
  const status: SkillAssetStatus = {
    checkedAt: iso(now),
    builtinShadowedUserSkills: findBuiltinShadowedUserSkills(userSkillsRoot, workspaceDir),
  };
  updateReleaseAssetStatus(db, { skills: status }, status.checkedAt);
  return status;
}

export function sourceFileStats(root: string): { files: number; bytes: number } {
  let files = 0;
  let bytes = 0;
  for (const relPath of listFiles(root, () => true)) {
    files++;
    bytes += statSync(join(root, relPath)).size;
  }
  return { files, bytes };
}
