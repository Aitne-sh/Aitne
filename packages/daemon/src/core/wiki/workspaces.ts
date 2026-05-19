import type Database from "better-sqlite3";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { join, resolve } from "node:path";
import type { AgentConfig } from "../../config.js";
import { validatePrimaryVaultPath } from "../../config.js";
import { writeFileAtomically } from "../atomic-write.js";

export const DEFAULT_WIKI_WORKSPACE_NAME = "default";
export const DEFAULT_WIKI_SCHEMA_VERSION = 1;
// WIKI_BUILDER_DESIGN.md §14 Q2 — wiki has its own language; no cascade
// from `primaryLanguage`. NULL defaults to 'en' at the DB layer; the seed
// row must not inherit the user's primary language even when set.
export const DEFAULT_WIKI_LANGUAGE = "en";
// WIKI_BUILDER_DESIGN.md §6.0 / §11 — default $2.00 approval threshold
// for `!compile full`. Mirrors the dashboard default and schema CHECK.
export const DEFAULT_WIKI_FULL_COMPILE_APPROVAL_USD = 2.0;

export interface WikiWorkspaceRow {
  id: number;
  name: string;
  kind: "internal" | "external";
  root_path: string;
  language: string;
  dispatch_mode: "parallel" | "serial";
  concurrency_cap: number;
  dm_agent_write_enabled: number;
  bridge_enabled: number;
  // WIKI_BUILDER_DESIGN.md §P5.A / §P5.B — measurement period gate +
  // per-workspace confidence threshold. Defaults: measurement_only=1
  // (no writes), min_confidence=0.70.
  bridge_measurement_only: number;
  bridge_min_confidence: number;
  full_compile_approval_threshold_usd: number;
  // WIKI_BUILDER_DESIGN.md §P2.A — added in Phase 2.
  write_strategy: "fs" | "cli" | "auto";
  git_pre_compile_enabled: number;
  schema_version: number;
  active: number;
  last_ingest_at: string | null;
  last_compile_at: string | null;
  created_at: string;
  updated_at: string;
}

const FALLBACK_SEEDS: Record<string, string> = {
  "taxonomy.md": [
    "# Wiki Taxonomy",
    "",
    "This file defines stable topic names, aliases, and merge rules for the personal wiki.",
    "",
    "## Topics",
    "",
    "- Add canonical topic names here as the wiki grows.",
    "",
  ].join("\n"),
  "schemas/raw.md": [
    "# Raw Note Schema",
    "",
    "Raw notes live under `10_raw/` and preserve source facts before synthesis.",
    "",
    "- Source URL",
    "- Retrieved timestamp",
    "- Extracted facts and quotations",
    "- Open questions",
    "",
  ].join("\n"),
  "schemas/wiki.md": [
    "# Wiki Note Schema",
    "",
    "Wiki notes live under `20_wiki/` and should contain synthesized, cited knowledge.",
    "",
    "- Summary",
    "- Key facts",
    "- Source links",
    "- Related notes",
    "",
  ].join("\n"),
  "schemas/output.md": [
    "# Output Schema",
    "",
    "Outputs live under `30_outputs/` and answer a specific user question from the wiki.",
    "",
    "- Question",
    "- Answer",
    "- Evidence",
    "- Follow-up gaps",
    "",
  ].join("\n"),
};

export function defaultWikiRoot(dataDir: string): string {
  return resolve(dataDir, "wiki");
}

export function ensureDefaultWikiWorkspace(
  db: Database.Database,
  config: AgentConfig,
): WikiWorkspaceRow {
  const rootPath = defaultWikiRoot(config.dataDir);
  // §P5.C — multi-workspace: check the named default specifically
  // rather than "first active workspace". With multiple active rows,
  // `readDefaultWikiWorkspace` returns the oldest active row by id,
  // which may not be the named default at all.
  const existing = readWikiWorkspaceByName(db, DEFAULT_WIKI_WORKSPACE_NAME);
  if (!existing) {
    const existingNamed = readWikiWorkspaceByName(db, DEFAULT_WIKI_WORKSPACE_NAME);
    if (existingNamed) {
      db.prepare(
        `UPDATE wiki_workspaces
         SET active = 1,
             kind = 'internal',
             root_path = ?,
             updated_at = CURRENT_TIMESTAMP
         WHERE name = ?`,
      ).run(rootPath, DEFAULT_WIKI_WORKSPACE_NAME);
    } else {
      db.prepare(
        `INSERT INTO wiki_workspaces (
         name,
         kind,
         root_path,
         language,
         dispatch_mode,
         concurrency_cap,
         dm_agent_write_enabled,
         bridge_enabled,
         full_compile_approval_threshold_usd,
         schema_version,
         active,
         updated_at
        ) VALUES (?, 'internal', ?, ?, 'parallel', 3, 0, 0, ?, ?, 1, CURRENT_TIMESTAMP)`,
      ).run(
        DEFAULT_WIKI_WORKSPACE_NAME,
        rootPath,
        DEFAULT_WIKI_LANGUAGE,
        DEFAULT_WIKI_FULL_COMPILE_APPROVAL_USD,
        DEFAULT_WIKI_SCHEMA_VERSION,
      );
    }
  }
  seedWikiWorkspaceFiles(rootPath, config.workspaceDir);
  return readWikiWorkspaceByName(db, DEFAULT_WIKI_WORKSPACE_NAME) ?? {
    id: 0,
    name: DEFAULT_WIKI_WORKSPACE_NAME,
    kind: "internal",
    root_path: rootPath,
    language: DEFAULT_WIKI_LANGUAGE,
    dispatch_mode: "parallel",
    concurrency_cap: 3,
    dm_agent_write_enabled: 0,
    bridge_enabled: 0,
    bridge_measurement_only: 1,
    bridge_min_confidence: 0.7,
    full_compile_approval_threshold_usd: DEFAULT_WIKI_FULL_COMPILE_APPROVAL_USD,
    write_strategy: "fs",
    git_pre_compile_enabled: 1,
    schema_version: DEFAULT_WIKI_SCHEMA_VERSION,
    active: 1,
    last_ingest_at: null,
    last_compile_at: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

/**
 * Create (or re-activate) an external-mode wiki workspace pointed at a
 * caller-supplied path. WIKI_BUILDER_DESIGN.md §P2.A / §P2.C.
 *
 * Path-collision rules (§2.1.1) and writability are enforced by the
 * caller (`validateWikiRootPath` + wizard probe) — this function trusts
 * its inputs and is only responsible for the idempotent DB insert and
 * vault skeleton seeding.
 */
export function createExternalWikiWorkspace(
  db: Database.Database,
  config: AgentConfig,
  options: {
    name?: string;
    rootPath: string;
    language?: string;
  },
): WikiWorkspaceRow {
  const name = options.name ?? DEFAULT_WIKI_WORKSPACE_NAME;
  const language = options.language ?? DEFAULT_WIKI_LANGUAGE;
  const rootPath = resolve(options.rootPath);

  const existing = readWikiWorkspaceByName(db, name);
  if (existing) {
    db.prepare(
      `UPDATE wiki_workspaces
         SET active = 1,
             kind = 'external',
             root_path = ?,
             language = ?,
             write_strategy = 'auto',
             updated_at = CURRENT_TIMESTAMP
       WHERE name = ?`,
    ).run(rootPath, language, name);
  } else {
    db.prepare(
      `INSERT INTO wiki_workspaces (
         name,
         kind,
         root_path,
         language,
         dispatch_mode,
         concurrency_cap,
         dm_agent_write_enabled,
         bridge_enabled,
         full_compile_approval_threshold_usd,
         write_strategy,
         git_pre_compile_enabled,
         schema_version,
         active,
         updated_at
       ) VALUES (?, 'external', ?, ?, 'parallel', 3, 0, 0, ?, 'auto', 1, ?, 1, CURRENT_TIMESTAMP)`,
    ).run(
      name,
      rootPath,
      language,
      DEFAULT_WIKI_FULL_COMPILE_APPROVAL_USD,
      DEFAULT_WIKI_SCHEMA_VERSION,
    );
  }
  seedWikiWorkspaceFiles(rootPath, config.workspaceDir);
  const row = readWikiWorkspaceByName(db, name);
  if (!row) {
    throw new Error(`Failed to create external wiki workspace ${name}`);
  }
  return row;
}

export function readDefaultWikiWorkspace(
  db: Database.Database,
): WikiWorkspaceRow | null {
  return (
    (db
      .prepare(
        `SELECT * FROM wiki_workspaces WHERE active = 1 ORDER BY id ASC LIMIT 1`,
      )
      .get() as WikiWorkspaceRow | undefined) ?? null
  );
}

export function readWikiWorkspaceByName(
  db: Database.Database,
  name: string,
): WikiWorkspaceRow | null {
  return (
    (db
      .prepare(`SELECT * FROM wiki_workspaces WHERE name = ? LIMIT 1`)
      .get(name) as WikiWorkspaceRow | undefined) ?? null
  );
}

export function listWikiWorkspaces(
  db: Database.Database,
): WikiWorkspaceRow[] {
  return db
    .prepare(`SELECT * FROM wiki_workspaces ORDER BY active DESC, name ASC`)
    .all() as WikiWorkspaceRow[];
}

/**
 * WIKI_BUILDER_DESIGN.md §P5.C — active-only iteration helper.
 *
 * Multiple workspaces can be active at once in Phase 5; callers that
 * need to enumerate dispatch targets (the workspace dropdown, the
 * `@<workspace>` resolver, the boot-time FTS backfill) want the
 * single-purpose query rather than filtering `listWikiWorkspaces`
 * downstream and getting it wrong.
 */
export function listActiveWikiWorkspaces(
  db: Database.Database,
): WikiWorkspaceRow[] {
  return db
    .prepare(`SELECT * FROM wiki_workspaces WHERE active = 1 ORDER BY name ASC`)
    .all() as WikiWorkspaceRow[];
}

/**
 * WIKI_BUILDER_DESIGN.md §P5.C — resolve an `@<workspace>` token (or a
 * bare workspace name) against the active set, with a fallback to the
 * default workspace when the caller did not name one.
 *
 * Returns `null` when the named workspace does not exist or is
 * archived — bang handlers turn that into a usage DM rather than
 * silently dispatching to the default. Returning `null` also covers
 * the "wiki not enabled" case (no rows at all) so callers do not have
 * to double-check.
 */
export function resolveWikiWorkspace(
  db: Database.Database,
  name: string | undefined | null,
): WikiWorkspaceRow | null {
  if (name) {
    const row = readWikiWorkspaceByName(db, name);
    return row && row.active === 1 ? row : null;
  }
  return readDefaultWikiWorkspace(db);
}

export interface WikiVaultPathValidation {
  ok: boolean;
  // The wiki-specific overlap codes are layered on top of every code
  // `validatePrimaryVaultPath` may return — including `overlaps_external_vault`
  // (the reactive-memory primary's check against the external Obsidian path).
  // Surfacing that pass-through verbatim keeps the wizard's diagnostics
  // matched to the actual rule that fired.
  error?:
    | "overlaps_primary_vault"
    | "overlaps_external_obsidian"
    | "overlaps_other_wiki"
    | "overlaps_external_vault"
    | "overlaps_data_dir"
    | "not_absolute"
    | "system_path"
    | "path_traversal"
    | "not_directory"
    | "not_writable"
    | "parent_missing";
  message?: string;
  resolvedPath?: string;
}

/**
 * Validate a candidate external-mode wiki workspace `root_path`.
 *
 * Reuses `validatePrimaryVaultPath` for the writability + system-path
 * + dataDir-overlap + path-traversal checks, then layers on the
 * wiki-specific overlap rules from WIKI_BUILDER_DESIGN.md §2.1.1:
 *   - must not equal / overlap `primaryVaultPath`
 *   - must not equal / overlap `externalObsidianVaultPath`
 *   - must not equal / overlap any *other* wiki workspace `root_path`
 *
 * Equality-with-self is allowed so the validator is idempotent during
 * an in-place PATCH of an existing row.
 */
export function validateWikiRootPath(
  rawPath: string,
  db: Database.Database,
  config: AgentConfig,
  options: { selfWorkspaceName?: string } = {},
): WikiVaultPathValidation {
  const base = validatePrimaryVaultPath(rawPath, config, {
    autoCreate: false,
    allowMissingLeaf: true,
    collectFsInfo: false,
  });
  if (!base.ok) {
    return { ok: false, error: base.error, message: base.message };
  }
  const real = realpathSafe(resolve(rawPath));
  if (config.primaryVaultPath) {
    const primaryReal = realpathSafe(config.primaryVaultPath);
    if (overlaps(primaryReal, real)) {
      return {
        ok: false,
        error: "overlaps_primary_vault",
        message: "Wiki root must not overlap the primary vault.",
      };
    }
  }
  if (config.externalObsidianVaultPath) {
    const extReal = realpathSafe(config.externalObsidianVaultPath);
    if (overlaps(extReal, real)) {
      return {
        ok: false,
        error: "overlaps_external_obsidian",
        message:
          "Wiki root must not overlap the external Obsidian vault path.",
      };
    }
  }
  for (const other of listWikiWorkspaces(db)) {
    if (other.name === options.selfWorkspaceName) continue;
    if (other.active !== 1) continue;
    const otherReal = realpathSafe(other.root_path);
    if (overlaps(otherReal, real)) {
      return {
        ok: false,
        error: "overlaps_other_wiki",
        message: `Wiki root overlaps existing workspace \`${other.name}\` at ${other.root_path}.`,
      };
    }
  }
  return { ok: true, resolvedPath: real };
}

function realpathSafe(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function overlaps(a: string, b: string): boolean {
  return containsOrEquals(a, b) || containsOrEquals(b, a);
}

function containsOrEquals(outer: string, inner: string): boolean {
  if (outer === inner) return true;
  const prefix = outer.endsWith("/") ? outer : `${outer}/`;
  return inner.startsWith(prefix);
}

export function seedWikiWorkspaceFiles(rootPath: string, workspaceDir: string): void {
  for (const rel of [
    "00_inbox",
    "10_raw/images",
    "20_wiki",
    "30_outputs",
    "90_meta/schemas",
    "90_meta/health",
  ]) {
    mkdirSync(join(rootPath, rel), { recursive: true });
  }

  writeIfMissing(join(rootPath, "20_wiki/_index.md"), [
    "# Wiki Index",
    "",
    "This index is maintained by `wiki.compile`.",
    "",
  ].join("\n"));
  writeIfMissing(join(rootPath, "log.md"), "# Wiki Log\n\n");

  const seedsRoot = join(workspaceDir, "agent-assets", "wiki-seeds");
  for (const [rel, fallback] of Object.entries(FALLBACK_SEEDS)) {
    const sourcePath = join(seedsRoot, rel);
    const targetPath = join(rootPath, "90_meta", rel);
    const content = existsSync(sourcePath)
      ? readFileSync(sourcePath, "utf-8")
      : fallback;
    writeIfMissing(targetPath, content);
  }
}

export interface WikiWorkspaceStats {
  rawCount: number;
  wikiCount: number;
  outputCount: number;
  lastIngestAt: string | null;
  lastCompileAt: string | null;
}

export function buildWikiWorkspaceStats(row: WikiWorkspaceRow): WikiWorkspaceStats {
  return {
    rawCount: countMarkdownFiles(join(row.root_path, "10_raw")),
    wikiCount: countMarkdownFiles(join(row.root_path, "20_wiki")),
    outputCount: countMarkdownFiles(join(row.root_path, "30_outputs")),
    lastIngestAt: row.last_ingest_at,
    lastCompileAt: row.last_compile_at,
  };
}

function countMarkdownFiles(dir: string): number {
  if (!existsSync(dir)) return 0;
  let count = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      count += countMarkdownFiles(full);
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      count += 1;
    }
  }
  return count;
}

function writeIfMissing(path: string, content: string): void {
  if (existsSync(path)) {
    const stat = statSync(path);
    if (stat.isFile()) return;
  }
  writeFileAtomically(path, content.endsWith("\n") ? content : `${content}\n`);
}
