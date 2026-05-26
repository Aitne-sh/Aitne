import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import {
  readRuntimeState,
  writeRuntimeState,
} from "../db/runtime-state.js";

/**
 * Template versioning infrastructure — future-proofing for format changes.
 *
 * Each shipped template in `agent-assets/templates/` carries a
 * `template_version: N` field in its YAML frontmatter. When the template
 * format changes in a future release, bump `template_version` AND the
 * matching entry in `_manifest.json`.
 *
 * User-side files copied from a template retain the version field on
 * disk. At startup, the daemon compares each user file's version against
 * the shipped manifest and flags paths where the manifest is newer. The
 * result lands in `runtime_state.templates.pending` and is surfaced via
 * `/api/health`.
 *
 * Phase 0 (this module) ships the detection + surfacing layer only. An
 * "apply upgrade" path — diff review in the dashboard, merge strategy
 * for user-edited files, audit trail — is deferred to a later phase.
 * Treat "pending upgrade" as an observability signal, not an automatic
 * action.
 *
 * Scope:
 *  - Skip: `today.md`, `roadmap.md`, `plans/projects/_active.base`, and any
 *    future file without YAML frontmatter (no place to carry the version
 *    marker).
 *  - Skip: files whose user-side copy is missing (user deleted it).
 *  - Skip: files whose user-side version is >= manifest version (up to
 *    date OR user ahead; both fine).
 *  - Report: files whose user-side version is < manifest version.
 *  - Treat "user file has NO template_version field" as unknown — do not
 *    report as pending (user has likely rewritten the file; we have no
 *    evidence they want an upgrade).
 */

export const PENDING_UPGRADES_KEY = "templates.pending";
const MANIFEST_FILENAME = "_manifest.json";

export interface TemplateManifestEntry {
  version: number;
}

export interface TemplateManifest {
  manifestVersion: number;
  generatedAt?: string;
  notes?: string;
  templates: Record<string, TemplateManifestEntry>;
}

export interface PendingTemplateUpgrade {
  path: string;
  from: number;
  to: number;
}

export interface PendingTemplateUpgradesRecord {
  checkedAt: string;
  pending: PendingTemplateUpgrade[];
}

/**
 * Read and validate `agent-assets/templates/_manifest.json`. Returns
 * `null` if the file is missing or malformed; callers treat that as
 * "no manifest available, skip the upgrade check" (degraded deployments
 * that ship without assets).
 */
export function readTemplateManifest(
  templatesRoot: string,
): TemplateManifest | null {
  const manifestPath = join(templatesRoot, MANIFEST_FILENAME);
  if (!existsSync(manifestPath)) return null;
  try {
    const raw = readFileSync(manifestPath, "utf-8");
    const parsed = JSON.parse(raw) as TemplateManifest;
    if (
      typeof parsed.manifestVersion !== "number"
      || typeof parsed.templates !== "object"
      || parsed.templates === null
    ) {
      return null;
    }
    // Validate each entry has a numeric `version`.
    for (const [path, entry] of Object.entries(parsed.templates)) {
      if (typeof entry !== "object" || entry === null) return null;
      if (typeof (entry as TemplateManifestEntry).version !== "number") {
        return null;
      }
      // Reject path traversal.
      if (path.includes("..")) return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Parse the `template_version:` field from a file's YAML frontmatter.
 * Returns `null` if the file is missing, has no frontmatter, or the
 * field is absent / malformed. Bounded read (64 KB header) to keep the
 * boot check fast and tolerant of unusually large files.
 */
export function readFileTemplateVersion(absPath: string): number | null {
  if (!existsSync(absPath)) return null;
  let head: string;
  try {
    const full = readFileSync(absPath, "utf-8");
    head = full.length > 65_536 ? full.slice(0, 65_536) : full;
  } catch {
    return null;
  }
  const lines = head.split(/\r?\n/);
  if (lines.length === 0 || lines[0] !== "---") return null;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === "---") return null; // closing delimiter before match
    const m = lines[i].match(/^template_version:\s*(\d+)\s*$/);
    if (m) {
      const n = parseInt(m[1], 10);
      /* c8 ignore next — `\d+` regex guarantees finite int; defensive only. */
      return Number.isFinite(n) ? n : null;
    }
  }
  return null;
}

/**
 * Compare the shipped manifest to the user's on-disk files and return
 * the list of paths whose user-side version is older than the shipped
 * version. Files without a user-side version marker are treated as
 * unknown and NOT reported (see module doc above).
 */
export function findPendingTemplateUpgrades(
  manifest: TemplateManifest,
  contextDir: string,
): PendingTemplateUpgrade[] {
  const pending: PendingTemplateUpgrade[] = [];
  for (const [relPath, entry] of Object.entries(manifest.templates)) {
    const userPath = join(contextDir, relPath);
    const userVersion = readFileTemplateVersion(userPath);
    if (userVersion === null) continue;
    if (userVersion < entry.version) {
      pending.push({
        path: relPath,
        from: userVersion,
        to: entry.version,
      });
    }
  }
  // Deterministic order simplifies tests and dashboard rendering.
  pending.sort((a, b) => a.path.localeCompare(b.path));
  return pending;
}

/**
 * Persist the latest pending-upgrade snapshot to `runtime_state`. A
 * previous snapshot with a longer list is overwritten — callers always
 * pass the full current set, so stale entries disappear naturally once
 * an upgrade is applied.
 */
export function writePendingTemplateUpgrades(
  db: Database.Database,
  pending: PendingTemplateUpgrade[],
): void {
  const record: PendingTemplateUpgradesRecord = {
    checkedAt: new Date().toISOString(),
    pending,
  };
  writeRuntimeState(db, PENDING_UPGRADES_KEY, record);
}

/**
 * Read the last persisted pending-upgrade snapshot. Returns `null` when
 * no check has ever run or the row is malformed. Consumers (e.g. the
 * `/api/health` handler) can treat `null` identically to "no pending"
 * for display purposes.
 */
export function readPendingTemplateUpgrades(
  db: Database.Database,
): PendingTemplateUpgradesRecord | null {
  return readRuntimeState<PendingTemplateUpgradesRecord>(
    db,
    PENDING_UPGRADES_KEY,
  );
}

/**
 * End-to-end helper: read the manifest, diff against the user's context
 * directory, persist the pending list. Returns the pending list for
 * callers that want to log or surface it immediately. Missing manifest
 * yields an empty list (no action) — see `readTemplateManifest`.
 */
export function checkTemplateUpgrades(
  db: Database.Database,
  templatesRoot: string | null,
  contextDir: string,
): PendingTemplateUpgrade[] {
  if (templatesRoot === null) {
    // No assets available (tarball deployment without agent-assets);
    // we cannot compare versions. Still write an empty snapshot so
    // `/api/health` returns a well-formed field.
    writePendingTemplateUpgrades(db, []);
    return [];
  }
  const manifest = readTemplateManifest(templatesRoot);
  if (manifest === null) {
    writePendingTemplateUpgrades(db, []);
    return [];
  }
  const pending = findPendingTemplateUpgrades(manifest, contextDir);
  writePendingTemplateUpgrades(db, pending);
  return pending;
}
