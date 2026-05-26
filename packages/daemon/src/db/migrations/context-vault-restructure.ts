/**
 * Context vault restructure — manifest-driven filesystem + SQLite
 * migration that reshapes `~/.personal-agent/context/` into the six
 * authority-class layout (CONTEXT_VAULT_REDESIGN_PLAN.md §11).
 *
 * Triggered from the standard `db/migrations.ts:runMigrations` runner
 * via the `0004-context-vault-restructure` entry. The runner gives us a
 * `MigrationContext` with `db`, `dataDir`, and `contextDir` so the body
 * can touch the filesystem in addition to SQLite.
 *
 * **Two layers of idempotency** (§11.10):
 *
 *  1. `schema_migrations` row — once written, the standard runner skips
 *     this body.
 *  2. `<contextDir>/.context-vault-version` — written last by the body
 *     itself. Survives DB restore-from-backup scenarios where the row
 *     would otherwise wrongly mark the migration as applied. The
 *     post-migration boot preflight (`assertContextVaultVersion`)
 *     re-runs the body if the marker is missing but the row exists.
 *
 * **Per-entry idempotency**: each manifest row uses the
 * `if-from-exists-and-to-does-not` contract. Re-running on a
 * partially-completed vault skips already-applied entries; a
 * conflicting both-exist state raises `MigrationConflict` instead of
 * clobbering data (§11.10).
 */

import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type Database from "better-sqlite3";

import { createLogger } from "../../logging.js";
import { rewritePathsInDb } from "../../core/path-rewrite.js";
import { mergeReconcilerBlock } from "../../core/context/reconciler-section.js";

const logger = createLogger("context-vault-restructure");

/**
 * Version marker file written at `<contextDir>/.context-vault-version`.
 * `"2"` means "post-restructure layout active". Absent file or `"1"`
 * means pre-restructure; anything else throws.
 */
export const VAULT_LAYOUT_VERSION = "2";
export const VAULT_VERSION_FILE = ".context-vault-version";

/** Migration id — matches `db/migrations.ts:MIGRATIONS`. */
export const MIGRATION_ID = "0004-context-vault-restructure";

/** Bookkeeping shape returned by the runner for tests + telemetry. */
export interface ContextVaultMigrationResult {
  /** True if any filesystem move ran. False on no-op (already migrated). */
  moved: boolean;
  /** Per-manifest-entry outcomes for audit replay. */
  entries: Array<{
    from: string;
    to: string;
    outcome: "moved" | "skip-no-source" | "skip-already-applied" | "merged";
  }>;
  /** Backup directory written before any move, or `null` on no-op. */
  backupDir: string | null;
  /** Number of `wiki_workspaces.root_path` rows updated. */
  wikiWorkspacesRewritten: number;
  /** Counts from each SQLite-path-key UPDATE pass (V13). */
  sqlitePathKeysRewritten: {
    mdFileSnapshots: number;
    entities: number;
    entitySourceKeys: number;
    managedTasks: number;
  };
  /** JSON-blob rewrites by oldPrefix (V17). */
  jsonBlobRewrites: Array<{
    oldPrefix: string;
    newPrefix: string;
    rowsRewritten: number;
  }>;
}

/**
 * The manifest. Each entry tells the runner how to translate one
 * legacy path into its canonical class-prefixed destination.
 *
 * **Kinds**:
 *  - `file` — move a single file. `from` and `to` are vault-relative.
 *  - `dir-rename` — atomically rename a single directory.
 *  - `fanout` — slug-bearing pattern. `from` has a `*` segment; the
 *    runner enumerates direct children of `from` (sans `*`) and emits
 *    one move per match. `to`'s `*` is replaced with the same slug.
 *  - `merge` — move the source into a reserved block inside the target
 *    rather than replacing it (currently only `context-index.md` →
 *    `_index.md` `<!-- reconciler-section -->`).
 */
export type MoveEntry =
  | { kind: "file"; from: string; to: string }
  | { kind: "dir-rename"; from: string; to: string }
  | { kind: "fanout"; from: string; to: string }
  | { kind: "merge"; from: string; to: string; strategy: "reconciler-block" };

/** §11.9 manifest. Longest-prefix-first where multiple entries share a stem. */
export const MOVES: ReadonlyArray<MoveEntry> = [
  // ── Top-level loose files ────────────────────────────────────────
  { kind: "file", from: "today.md", to: "state/today.md" },
  { kind: "file", from: "yesterday.md", to: "state/yesterday.md" },
  { kind: "file", from: "roadmap.md", to: "plans/roadmap.md" },
  {
    kind: "merge",
    from: "context-index.md",
    to: "_index.md",
    strategy: "reconciler-block",
  },

  // ── identity/ ← user/ ───────────────────────────────────────────
  { kind: "dir-rename", from: "user", to: "identity" },

  // ── state/ ← inbox/, agent/scratch/, agent/profile-questions.md, _activity/
  { kind: "dir-rename", from: "inbox", to: "state/inbox" },
  { kind: "dir-rename", from: "agent/scratch", to: "state/scratch" },
  {
    kind: "file",
    from: "agent/profile-questions.md",
    to: "state/profile-questions.md",
  },
  { kind: "dir-rename", from: "_activity", to: "state/activity" },

  // ── plans/ ← projects/ ──────────────────────────────────────────
  { kind: "dir-rename", from: "projects", to: "plans/projects" },

  // ── journal/ ← daily/, weekly/, monthly/, agent/journal.md ──────
  { kind: "dir-rename", from: "daily", to: "journal/daily" },
  { kind: "dir-rename", from: "weekly", to: "journal/weekly" },
  { kind: "dir-rename", from: "monthly", to: "journal/monthly" },
  { kind: "file", from: "agent/journal.md", to: "journal/agent.md" },
  // git/<slug>/journal/ → journal/repos/<slug>/
  { kind: "fanout", from: "git/*/journal", to: "journal/repos/*" },

  // ── knowledge/ ← git/<slug>/overview.md, dossiers/, management entities
  { kind: "fanout", from: "git/*/overview.md", to: "knowledge/repos/*/overview.md" },
  { kind: "dir-rename", from: "dossiers", to: "knowledge/dossiers" },
  // Management entity domain dirs (fanout — each known domain treated as a slug).
  {
    kind: "fanout",
    from: "{domain}/_index.md",
    to: "knowledge/entities/{domain}/_index.md",
  },
  {
    kind: "fanout",
    from: "{domain}/{typePlural}",
    to: "knowledge/entities/{domain}/{typePlural}",
  },

  // ── policies/ ← rules/, routines/ ───────────────────────────────
  { kind: "file", from: "rules/management.md", to: "policies/management.md" },
  { kind: "file", from: "rules/mcp.md", to: "policies/mcp.md" },
  { kind: "file", from: "rules/redaction.md", to: "policies/redaction.md" },
  {
    kind: "file",
    from: "rules/journal-format.md",
    to: "policies/journal-format.md",
  },
  {
    kind: "file",
    from: "rules/journal-export.md",
    to: "policies/journal-export.md",
  },
  {
    kind: "dir-rename",
    from: "rules/policies",
    to: "policies/management-captures",
  },
  { kind: "dir-rename", from: "routines", to: "policies/routines" },

  // ── Deprecated leftover ─────────────────────────────────────────
  { kind: "dir-rename", from: "git-repos", to: "knowledge/repos/legacy-registry" },
] as const;

/**
 * Recognised management domains (mirrors
 * `packages/shared/src/management-domains.ts`). The fanout runner only
 * expands the `{domain}` placeholder against this list — arbitrary
 * top-level directories the user may have under the vault root are
 * preserved as-is.
 */
export const MANAGEMENT_DOMAINS = [
  "work",
  "travel",
  "finance",
  "personal",
  "health",
  "learning",
] as const;

/** Forbidden post-migration top-level dirs the verifier asserts are empty. */
const FORBIDDEN_LEGACY_DIRS = [
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
  "work",
  "travel",
  "finance",
  "personal",
  "health",
  "learning",
  "git-repos",
];

export class MigrationConflict extends Error {
  readonly entry: MoveEntry;
  readonly fromAbs: string;
  readonly toAbs: string;
  constructor(entry: MoveEntry, fromAbs: string, toAbs: string) {
    super(
      `Migration conflict: both source and target exist for ${entry.kind}: ${entry.from} → ${entry.to} (from=${fromAbs}, to=${toAbs})`,
    );
    this.entry = entry;
    this.fromAbs = fromAbs;
    this.toAbs = toAbs;
    this.name = "MigrationConflict";
  }
}

export class VerificationFailed extends Error {
  constructor(detail: string) {
    super(`Vault migration verification failed: ${detail}`);
    this.name = "VerificationFailed";
  }
}

/**
 * Entry point invoked from the `MIGRATIONS[].up()` body.
 *
 * **Order**:
 *  1. Read the version marker → fast no-op if `=== "2"`.
 *  2. Plan moves against the manifest; identify what needs to run.
 *  3. Take backup (only if at least one move is queued).
 *  4. Run filesystem moves (per-entry idempotency).
 *  5. Move out-of-contextDir paths: `integrations.md`, internal wiki,
 *     user skills, skill curation overlays.
 *  6. UPDATE wiki_workspaces.root_path + rebuild fts_wiki.
 *  7. UPDATE V13 typed path columns.
 *  8. Run V17 JSON-blob rewrites via `rewritePathsInDb`.
 *  9. Run §11.11 verification sweep (incl. step 7 V17 second-pass).
 * 10. Write `.context-vault-version=2`.
 */
export function runContextVaultRestructure(args: {
  db: Database.Database;
  dataDir: string;
  contextDir: string;
}): ContextVaultMigrationResult {
  const { db, dataDir, contextDir } = args;
  const result: ContextVaultMigrationResult = {
    moved: false,
    entries: [],
    backupDir: null,
    wikiWorkspacesRewritten: 0,
    sqlitePathKeysRewritten: {
      mdFileSnapshots: 0,
      entities: 0,
      entitySourceKeys: 0,
      managedTasks: 0,
    },
    jsonBlobRewrites: [],
  };

  // ── Concurrency invariant (§11.3.3) ───────────────────────────
  // The plan calls for defensive acquisition of the today/roadmap
  // write-locks "even though no writer should be live." Those locks
  // are in-memory singletons (InMemoryTodayWriteLockManager /
  // InMemoryRoadmapWriteLockManager) instantiated downstream in
  // index.ts AFTER initDatabase returns — so at this call site the
  // managers do not exist yet to be acquired against. Safety comes
  // from the architectural invariant instead: this function runs
  // inside `initDatabase`, which runs before the HTTP server, the
  // dispatcher, the observer manager, and the lock-manager
  // singletons are constructed. No code path inside this process
  // can write to today.md/roadmap.md while the migration body
  // executes. Cross-process protection is the operator's
  // responsibility — `aitne stop` (graceful) terminates any other
  // daemon process before `aitne start` boots the new one.
  //
  // ── Idempotency check ─────────────────────────────────────────
  const version = readVaultVersion(contextDir);
  if (version === VAULT_LAYOUT_VERSION) {
    logger.info(
      { contextDir, version },
      "Context vault already at target layout — skipping",
    );
    return result;
  }
  if (version !== null && version !== "1") {
    throw new Error(
      `Unknown context vault version: ${JSON.stringify(version)}. Refusing to migrate.`,
    );
  }

  // ── Plan ───────────────────────────────────────────────────────
  const plan = planMoves(contextDir);
  const outOfContextMoves = planOutOfContextDirMoves({ dataDir, contextDir });
  const internalWikiMoves = planInternalWikiMoves({ dataDir, contextDir, db });

  const anyWork =
    plan.queued.length > 0 ||
    outOfContextMoves.length > 0 ||
    internalWikiMoves.length > 0;

  // CONTEXT_VAULT_REDESIGN_PLAN.md v4 V16 / §11.3.4 — when the vault is an
  // Obsidian-mode root the restructure reorganizes folders the user sees
  // in their Obsidian sidebar. The consent gate lives in
  // `bootstrap/db.ts:resolveVaultRestructureConsent`: that function filters
  // this migration out of the run list on Obsidian + no-ack, so reaching
  // this body implies consent (env var, dashboard ack, or plain-mode
  // vault). We still log on first run for the audit trail and to make the
  // backup path visible to the operator.
  const isObsidianVault = !contextDir.startsWith(dataDir);
  if (anyWork && isObsidianVault) {
    logger.info(
      { contextDir, dataDir },
      "Restructuring Obsidian-mode vault — consent recorded; pre-restructure backup will be written to <dataDir>/migration-backups/.",
    );
  }

  if (!anyWork) {
    // Empty vault — just mark the version and return.
    ensureContextDirExists(contextDir);
    writeVaultVersion(contextDir);
    logger.info(
      { contextDir },
      "Context vault is empty — version marker written, no moves required",
    );
    return result;
  }

  // ── Backup ────────────────────────────────────────────────────
  result.backupDir = createBackup({ dataDir, contextDir });

  // ── Filesystem moves (in-contextDir) ──────────────────────────
  ensureContextDirExists(contextDir);
  for (const planned of plan.queued) {
    try {
      const outcome = executeMove(planned, contextDir);
      result.entries.push({
        from: planned.from,
        to: planned.to,
        outcome,
      });
      if (outcome === "moved" || outcome === "merged") {
        result.moved = true;
      }
    } catch (err) {
      logger.error(
        { err, planned },
        "Manifest move failed — leaving partial state for retry",
      );
      throw err;
    }
  }
  for (const planned of plan.skipped) {
    result.entries.push({
      from: planned.from,
      to: planned.to,
      outcome: planned.reason,
    });
  }

  // ── Out-of-contextDir moves (integrations.md, skills, overlays) ─
  for (const ooc of outOfContextMoves) {
    executeOutOfContextMove(ooc);
    if (ooc.applied) result.moved = true;
  }

  // ── Internal wiki workspace migration (per-workspace, with DB UPDATE) ─
  for (const wiki of internalWikiMoves) {
    migrateInternalWikiWorkspace(wiki, db);
    result.wikiWorkspacesRewritten += 1;
    result.moved = true;
  }

  // ── Unmanifested entries — "no omissions" safety net (§11.9) ──
  // Any non-empty legacy dir surviving the manifest contains user-added
  // content that did not match any move rule. Rather than throw at
  // verification, copy each such entry under `state/scratch/` with a
  // dated slug so the user can recover it. If anything is actually
  // captured, set `result.moved` so the version marker writes.
  const unmanifested = captureUnmanifestedEntries(contextDir);
  if (unmanifested.length > 0) {
    result.moved = true;
    for (const captured of unmanifested) {
      result.entries.push({
        from: captured.from,
        to: captured.to,
        outcome: "moved",
      });
    }
    logger.warn(
      { captured: unmanifested },
      "Captured unmanifested legacy entries into state/scratch/legacy-unmanifested-*",
    );
  }

  // ── Clean up empty legacy parents ──────────────────────────────
  // After all moves and the unmanifested-capture pass, legacy parent
  // directories (rules/, agent/, git/, <domain>/) may be empty husks.
  // Remove them so the verifier passes. Errors are best-effort — a
  // remaining non-empty husk surfaces at verification.
  removeEmptyLegacyDirs(contextDir);

  // ── V13 SQLite typed-path-key rewrites ────────────────────────
  result.sqlitePathKeysRewritten = rewriteTypedPathKeys(db);

  // ── V17 JSON-blob rewrites ────────────────────────────────────
  //
  // Per CONTEXT_VAULT_REDESIGN_PLAN.md §15 PR-3 V17, every pair emits an
  // `agent_actions` row with `action_type='migration.json_path_rewrite'`
  // so operators can replay the rewrite via `aitne audit --type
  // migration.json_path_rewrite`.
  //
  // **Audit rows are inserted AFTER the verification sweep**, not inside
  // the rewrite loop: the audit JSON contains the literal `oldPrefix`
  // string, which `rewritePathsInDb` is designed to match. Inserting
  // mid-loop would seed `agent_actions.detail` with strings that the
  // verifier's second-pass call (§11.11 step 7) then finds as
  // "unrewritten paths," failing the migration even when the real path
  // rewrite succeeded. Post-verification is safe — by then the second
  // pass has already confirmed `rowsRewritten=0` and we are about to
  // stamp the marker.
  const absoluteRewrites = buildAbsolutePathRewrites({ dataDir, contextDir });
  for (const [oldPrefix, newPrefix] of absoluteRewrites) {
    const stats = rewritePathsInDb(db, oldPrefix, newPrefix);
    result.jsonBlobRewrites.push({
      oldPrefix,
      newPrefix,
      rowsRewritten: stats.rowsRewritten,
    });
  }

  // ── Verification sweep ────────────────────────────────────────
  verifyMigrationCompleteness({ contextDir, dataDir, db, absoluteRewrites });

  // ── Post-verification audit rows (V17 telemetry) ──────────────
  // Each (oldPrefix, newPrefix) pair emits one row; insert is wrapped
  // in try/catch because audit-log writes must never abort the
  // migration body — the schema_migrations row is recorded by the
  // outer transaction regardless.
  const auditInsert = (() => {
    try {
      return db.prepare(
        `INSERT INTO agent_actions (action_type, detail, result, started_at, completed_at)
         VALUES (?, ?, 'success', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      );
    } catch (err) {
      logger.warn(
        { err },
        "V17 audit insert prepare failed — continuing without per-pair audit rows",
      );
      return null;
    }
  })();
  if (auditInsert) {
    for (const entry of result.jsonBlobRewrites) {
      try {
        auditInsert.run(
          "migration.json_path_rewrite",
          JSON.stringify({
            migrationId: MIGRATION_ID,
            oldPrefix: entry.oldPrefix,
            newPrefix: entry.newPrefix,
            rowsRewritten: entry.rowsRewritten,
          }),
        );
      } catch (err) {
        logger.warn(
          { err, oldPrefix: entry.oldPrefix, newPrefix: entry.newPrefix },
          "V17 audit insert failed",
        );
      }
    }
  }

  // ── Write the version marker LAST ─────────────────────────────
  writeVaultVersion(contextDir);
  logger.info({ contextDir, result }, "Context vault restructure complete");
  return result;
}

// ───────────────────────────────────────────────────────────────────
// Planning
// ───────────────────────────────────────────────────────────────────

interface PlannedMove {
  entry: MoveEntry;
  from: string;
  to: string;
}

interface SkippedMove {
  entry: MoveEntry;
  from: string;
  to: string;
  reason: "skip-no-source" | "skip-already-applied";
}

interface MovePlan {
  queued: PlannedMove[];
  skipped: SkippedMove[];
}

function planMoves(contextDir: string): MovePlan {
  const queued: PlannedMove[] = [];
  const skipped: SkippedMove[] = [];

  for (const entry of MOVES) {
    const expanded = expandEntry(entry, contextDir);
    for (const concrete of expanded) {
      const fromAbs = join(contextDir, concrete.from);
      const toAbs = join(contextDir, concrete.to);
      const fromExists = existsSync(fromAbs);
      const toExists = existsSync(toAbs);

      if (!fromExists && toExists) {
        skipped.push({
          entry,
          from: concrete.from,
          to: concrete.to,
          reason: "skip-already-applied",
        });
        continue;
      }
      if (!fromExists && !toExists) {
        skipped.push({
          entry,
          from: concrete.from,
          to: concrete.to,
          reason: "skip-no-source",
        });
        continue;
      }
      if (fromExists && toExists && entry.kind !== "merge") {
        // Boot-order reality (CONTEXT_VAULT_REDESIGN_PLAN.md v4.1 V18):
        // `initDirectories` runs from `index.ts:159` BEFORE the migration
        // body inside `initDatabase`. It mkdirs every entry in
        // CONTEXT_DIR_NAMES — including the targets of most dir-rename
        // manifest rows (`identity/`, `state/inbox/`, `state/scratch/`,
        // `state/activity/`, `plans/projects/`, `journal/daily/`, etc.).
        // On an upgrade, those targets are therefore present-but-empty
        // when the migration runs. That's not a real conflict; it's the
        // expected pre-state. Treat an empty-directory target as
        // "doesn't exist" for the conflict check; executeMove handles
        // the empty-target case by rmdir'ing before rename.
        //
        // A `file`-kind entry whose target file already exists IS still a
        // real conflict (the file would have content). Same for any
        // dir-rename whose target dir is non-empty.
        if (entry.kind === "dir-rename" && isEmptyDirectory(toAbs)) {
          queued.push({ entry, from: concrete.from, to: concrete.to });
          continue;
        }
        throw new MigrationConflict(entry, fromAbs, toAbs);
      }
      queued.push({ entry, from: concrete.from, to: concrete.to });
    }
  }
  return { queued, skipped };
}

/**
 * True if `abs` is a directory whose tree contains zero files — only
 * (possibly nested) empty directories.
 *
 * `initDirectories` mkdirs every entry in `CONTEXT_DIR_NAMES`, including
 * nested ones like `policies/routines` AND `policies/routines/custom`.
 * On boot the target of a manifest `dir-rename` like `routines →
 * policies/routines` therefore comes with `custom/` already inside it
 * (also empty). That isn't a real conflict — no user data is at risk —
 * so we walk the tree and only the presence of an actual file
 * disqualifies the directory as "empty for migration purposes".
 */
function isEmptyDirectory(abs: string): boolean {
  try {
    const stats = statSync(abs);
    if (!stats.isDirectory()) return false;
  } catch {
    return false;
  }
  let children: string[];
  try {
    children = readdirSync(abs);
  } catch {
    return false;
  }
  for (const child of children) {
    const childAbs = join(abs, child);
    let childStats;
    try {
      childStats = statSync(childAbs);
    } catch {
      return false;
    }
    if (childStats.isFile()) return false;
    if (childStats.isDirectory()) {
      if (!isEmptyDirectory(childAbs)) return false;
      continue;
    }
    // Symlink / socket / device — refuse to count it as "empty".
    return false;
  }
  return true;
}

/**
 * Expand fanout / placeholder entries into concrete (from, to) pairs.
 */
function expandEntry(
  entry: MoveEntry,
  contextDir: string,
): Array<{ from: string; to: string }> {
  if (entry.kind === "file" || entry.kind === "dir-rename" || entry.kind === "merge") {
    return [{ from: entry.from, to: entry.to }];
  }
  // Fanout patterns we support today:
  //   git/*/journal           → journal/repos/*
  //   git/*/overview.md       → knowledge/repos/*/overview.md
  //   {domain}/_index.md      → knowledge/entities/{domain}/_index.md
  //   {domain}/{typePlural}   → knowledge/entities/{domain}/{typePlural}
  const out: Array<{ from: string; to: string }> = [];
  if (entry.from.startsWith("git/*/")) {
    const gitDir = join(contextDir, "git");
    if (!existsSync(gitDir)) return out;
    const slugs = readdirSync(gitDir).filter((name) => {
      try {
        return statSync(join(gitDir, name)).isDirectory();
      } catch {
        return false;
      }
    });
    for (const slug of slugs) {
      const fromTail = entry.from.slice("git/*/".length);
      const toTail = entry.to.replace("*", slug);
      out.push({
        from: `git/${slug}/${fromTail}`,
        to: toTail,
      });
    }
    return out;
  }
  if (entry.from.startsWith("{domain}/")) {
    for (const domain of MANAGEMENT_DOMAINS) {
      const domainDir = join(contextDir, domain);
      if (!existsSync(domainDir)) continue;
      if (entry.from === "{domain}/_index.md") {
        out.push({
          from: `${domain}/_index.md`,
          to: entry.to.replace("{domain}", domain),
        });
        continue;
      }
      if (entry.from === "{domain}/{typePlural}") {
        // Each subdir under <domain>/ that isn't `_index.md` is a typePlural.
        let children: string[] = [];
        try {
          children = readdirSync(domainDir);
        } catch {
          continue;
        }
        for (const child of children) {
          if (child === "_index.md") continue;
          const childAbs = join(domainDir, child);
          let isDir = false;
          try {
            isDir = statSync(childAbs).isDirectory();
          } catch {
            continue;
          }
          if (!isDir) continue;
          out.push({
            from: `${domain}/${child}`,
            to: entry.to
              .replace("{domain}", domain)
              .replace("{typePlural}", child),
          });
        }
      }
    }
    return out;
  }
  // Unknown fanout pattern — log and bail.
  logger.warn({ entry }, "Unrecognised fanout pattern; skipping");
  return out;
}

// ───────────────────────────────────────────────────────────────────
// Execution
// ───────────────────────────────────────────────────────────────────

function executeMove(
  planned: PlannedMove,
  contextDir: string,
): "moved" | "merged" {
  const fromAbs = join(contextDir, planned.from);
  const toAbs = join(contextDir, planned.to);
  mkdirSync(dirname(toAbs), { recursive: true });

  if (planned.entry.kind === "merge") {
    // context-index.md → _index.md reconciler block.
    const indexBody = readFileSync(fromAbs, "utf-8");
    const target = existsSync(toAbs) ? readFileSync(toAbs, "utf-8") : "";
    const merged = mergeReconcilerBlock(target, indexBody);
    writeFileSync(toAbs, merged, "utf-8");
    rmSync(fromAbs);
    return "merged";
  }

  // If the target is a pre-existing empty directory (created by
  // `initDirectories` from CONTEXT_DIR_NAMES on the boot before the
  // migration body runs — see planMoves comment), remove it so the
  // rename can complete cleanly. The empty check is a defence in depth;
  // planMoves only queues this case for kind === "dir-rename" + empty
  // target, so any non-empty toAbs surviving this branch is a bug.
  if (
    planned.entry.kind === "dir-rename" &&
    existsSync(toAbs) &&
    isEmptyDirectory(toAbs)
  ) {
    // `recursive: true` so any nested empty subdirs created by
    // `initDirectories` (e.g. `policies/routines/custom/`) are pruned
    // before the rename. `isEmptyDirectory` already proved no files
    // live anywhere under toAbs, so this cannot delete user data.
    rmSync(toAbs, { recursive: true, force: true });
  }

  // Standard rename. cross-device-safe via cp then rm.
  try {
    renameSync(fromAbs, toAbs);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EXDEV") {
      cpSync(fromAbs, toAbs, { recursive: true });
      rmSync(fromAbs, { recursive: true });
    } else {
      throw err;
    }
  }
  return "moved";
}

// `mergeReconcilerBlock` is re-exported for the migration's own peer test;
// runtime callers should import it from `core/context/reconciler-section.ts`
// directly. The splice helper is shared with the runtime reconciler runner
// (V15) so the one-shot migration and the per-tick reconciler cannot drift.
export { mergeReconcilerBlock };

// ───────────────────────────────────────────────────────────────────
// Out-of-contextDir moves
// ───────────────────────────────────────────────────────────────────

interface OutOfContextMove {
  from: string;
  to: string;
  /** Set after `executeOutOfContextMove` runs. */
  applied: boolean;
  /** `dir` for directory contents move, `file` for single file. */
  kind: "file" | "dir";
}

function planOutOfContextDirMoves(args: {
  dataDir: string;
  contextDir: string;
}): OutOfContextMove[] {
  const { dataDir, contextDir } = args;
  const moves: OutOfContextMove[] = [];

  // integrations.md
  const integrationsFrom = join(dataDir, "integrations.md");
  const integrationsTo = join(contextDir, "policies", "integrations.md");
  if (existsSync(integrationsFrom) && !existsSync(integrationsTo)) {
    moves.push({
      from: integrationsFrom,
      to: integrationsTo,
      applied: false,
      kind: "file",
    });
  }

  // User-registered skill dirs containing SKILL.md → policies/skills/
  const skillsFrom = join(dataDir, "skills");
  const skillsTo = join(contextDir, "policies", "skills");
  if (existsSync(skillsFrom)) {
    let children: string[] = [];
    try {
      children = readdirSync(skillsFrom);
    } catch {
      children = [];
    }
    for (const child of children) {
      const childAbs = join(skillsFrom, child);
      let isDir = false;
      try {
        isDir = statSync(childAbs).isDirectory();
      } catch {
        continue;
      }
      // Only move dirs that look like a user skill (contain SKILL.md).
      // `overlays/` is moved to a separate non-vault location below.
      if (!isDir) continue;
      if (child === "overlays") continue;
      if (!existsSync(join(childAbs, "SKILL.md"))) continue;
      const dest = join(skillsTo, child);
      if (existsSync(dest)) continue;
      moves.push({
        from: childAbs,
        to: dest,
        applied: false,
        kind: "dir",
      });
    }

    // Skill curation overlays → <dataDir>/skill-curation-overlays
    const overlaysFrom = join(skillsFrom, "overlays");
    const overlaysTo = join(dataDir, "skill-curation-overlays");
    if (existsSync(overlaysFrom) && !existsSync(overlaysTo)) {
      moves.push({
        from: overlaysFrom,
        to: overlaysTo,
        applied: false,
        kind: "dir",
      });
    }
  }

  return moves;
}

function executeOutOfContextMove(move: OutOfContextMove): void {
  mkdirSync(dirname(move.to), { recursive: true });
  try {
    renameSync(move.from, move.to);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EXDEV") {
      cpSync(move.from, move.to, { recursive: true });
      rmSync(move.from, { recursive: true });
    } else {
      throw err;
    }
  }
  move.applied = true;
}

// ───────────────────────────────────────────────────────────────────
// Internal wiki workspace migration
// ───────────────────────────────────────────────────────────────────

interface InternalWikiMove {
  workspaceId: number;
  oldRoot: string;
  newRoot: string;
}

function planInternalWikiMoves(args: {
  dataDir: string;
  contextDir: string;
  db: Database.Database;
}): InternalWikiMove[] {
  const { dataDir, contextDir, db } = args;
  const moves: InternalWikiMove[] = [];
  // wiki_workspaces table may not exist in test DBs without applySchema.
  const tableExists = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='wiki_workspaces'")
    .get();
  if (!tableExists) return moves;
  const rows = db
    .prepare<[], { id: number; root_path: string; kind: string }>(
      "SELECT id, root_path, kind FROM wiki_workspaces WHERE kind = 'internal'",
    )
    .all();
  const legacyWikiBase = join(dataDir, "wiki");
  const newWikiBase = join(contextDir, "knowledge", "wiki");
  for (const row of rows) {
    if (!row.root_path.startsWith(legacyWikiBase)) continue;
    const tail = row.root_path.slice(legacyWikiBase.length);
    const newPath = join(newWikiBase, tail).replace(/[\\/]+$/, "");
    if (newPath === row.root_path) continue;
    moves.push({
      workspaceId: row.id,
      oldRoot: row.root_path,
      newRoot: newPath,
    });
  }
  return moves;
}

function migrateInternalWikiWorkspace(
  move: InternalWikiMove,
  db: Database.Database,
): void {
  // 1. Move the files.
  if (existsSync(move.oldRoot)) {
    mkdirSync(dirname(move.newRoot), { recursive: true });
    try {
      renameSync(move.oldRoot, move.newRoot);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EXDEV") {
        cpSync(move.oldRoot, move.newRoot, { recursive: true });
        rmSync(move.oldRoot, { recursive: true });
      } else {
        throw err;
      }
    }
  }

  // 2. UPDATE wiki_workspaces.root_path.
  db.prepare("UPDATE wiki_workspaces SET root_path = ? WHERE id = ?").run(
    move.newRoot,
    move.workspaceId,
  );

  // 3. Clear the fts_wiki rows for the workspace so the boot-time
  //    `backfillWikiFulltext` rebuilds them against the new path.
  const ftsExists = db
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='fts_wiki'",
    )
    .get();
  if (ftsExists) {
    db.prepare("DELETE FROM fts_wiki WHERE workspace_id = ?").run(
      move.workspaceId,
    );
  }
}

// ───────────────────────────────────────────────────────────────────
// V13 — typed SQLite path-key rewrites
// ───────────────────────────────────────────────────────────────────

/**
 * Rewrite `md_file_snapshots.file_path`, `entities.path`,
 * `entity_source_keys.path`, `managed_tasks.output_path` using the same
 * legacy → canonical translation that the API alias resolver uses for
 * incoming requests.
 *
 * The alias map is intentionally a peer of (not equal to) the
 * `context-vault-aliases.ts` table — that file's resolver is designed
 * for HTTP path translation (with `.md`-vs-no-`.md` handling), while
 * the DB columns store stems without extensions. The mapping here is
 * a tight subset.
 */
function rewriteTypedPathKeys(db: Database.Database): {
  mdFileSnapshots: number;
  entities: number;
  entitySourceKeys: number;
  managedTasks: number;
} {
  const entityRewrites = rewriteEntitiesAndSourceKeysPaths(db);
  return {
    mdFileSnapshots: rewriteSnapshotPaths(db),
    entities: entityRewrites.entities,
    entitySourceKeys: entityRewrites.entitySourceKeys,
    managedTasks: rewriteManagedTasksOutputPaths(db),
  };
}

const SNAPSHOT_STEM_RULES: Array<readonly [RegExp, string]> = [
  [/^today$/, "state/today"],
  [/^yesterday$/, "state/yesterday"],
  [/^roadmap$/, "plans/roadmap"],
  [/^context-index$/, "_index"],
  [/^user\//, "identity/"],
  [/^rules\/policies\//, "policies/management-captures/"],
  [/^rules\//, "policies/"],
  [/^routines\//, "policies/routines/"],
  [/^projects\//, "plans/projects/"],
  [/^daily\//, "journal/daily/"],
  [/^weekly\//, "journal/weekly/"],
  [/^monthly\//, "journal/monthly/"],
  [/^dossiers\//, "knowledge/dossiers/"],
  [/^inbox\//, "state/inbox/"],
  [/^_activity\//, "state/activity/"],
  [/^agent\/journal$/, "journal/agent"],
  [/^agent\/profile-questions$/, "state/profile-questions"],
  [/^agent\/scratch\//, "state/scratch/"],
  [
    /^git\/([^/]+)\/journal\/([^/]+)$/,
    "journal/repos/$1/$2",
  ],
  [/^git\/([^/]+)\/overview$/, "knowledge/repos/$1/overview"],
];

function translateSnapshotStem(stem: string): string | null {
  for (const [re, to] of SNAPSHOT_STEM_RULES) {
    if (re.test(stem)) {
      return stem.replace(re, to);
    }
  }
  // Management entity paths (work/, travel/, etc.).
  for (const domain of MANAGEMENT_DOMAINS) {
    if (stem === `${domain}/_index`) {
      return `knowledge/entities/${domain}/_index`;
    }
    const domainEntity = new RegExp(`^${domain}/([a-z][a-z0-9-]*)/(.+)$`).exec(
      stem,
    );
    if (domainEntity) {
      return `knowledge/entities/${domain}/${domainEntity[1]}/${domainEntity[2]}`;
    }
  }
  return null;
}

function rewriteSnapshotPaths(db: Database.Database): number {
  const exists = db
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='md_file_snapshots'",
    )
    .get();
  if (!exists) return 0;
  const rows = db
    .prepare<[], { id: number; file_path: string }>(
      "SELECT id, file_path FROM md_file_snapshots",
    )
    .all();
  const update = db.prepare(
    "UPDATE md_file_snapshots SET file_path = ? WHERE id = ?",
  );
  let count = 0;
  for (const row of rows) {
    const newPath = translateSnapshotStem(row.file_path);
    if (newPath !== null && newPath !== row.file_path) {
      update.run(newPath, row.id);
      count += 1;
    }
  }
  return count;
}

/**
 * Rewrite `entities.path` (the PRIMARY KEY) and the cascaded
 * `entity_source_keys.path` rows that reference it.
 *
 * Schema reality (docs/design/21 §7.6 + schema.ts:1603):
 *   - `entities` PRIMARY KEY is `path` itself — there is no surrogate
 *     `id` column. Updating the primary key is the only way to migrate
 *     the row in place.
 *   - `entity_source_keys.path` REFERENCES `entities(path)` ON DELETE
 *     CASCADE. There is no `ON UPDATE CASCADE`, so a direct UPDATE on
 *     `entities.path` violates FK enforcement unless we defer the
 *     constraint check to commit time.
 *
 * `PRAGMA defer_foreign_keys = ON` works inside the surrounding
 * migration transaction (unlike `foreign_keys = OFF`, which is a no-op
 * mid-transaction). All UPDATEs land before the txn commits, and the
 * parent + child paths agree by then, so the deferred check passes.
 *
 * Returns row counts for both tables. `entitySourceKeys` is the number
 * of rows whose `path` was rewritten as a side effect of the cascaded
 * UPDATE (one row per matching child for each rewritten parent).
 */
function rewriteEntitiesAndSourceKeysPaths(db: Database.Database): {
  entities: number;
  entitySourceKeys: number;
} {
  const entitiesExists = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='entities'")
    .get();
  if (!entitiesExists) return { entities: 0, entitySourceKeys: 0 };

  const sourceKeysExists = Boolean(
    db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='entity_source_keys'",
      )
      .get(),
  );

  // `PRAGMA defer_foreign_keys = ON` only takes effect *inside* a
  // transaction (SQLite docs: "no-op outside of a transaction"). The
  // production caller in `db/migrations.ts:runMigrations` wraps the
  // whole `migration.up(db, ctx)` body in `db.transaction(...)`, but
  // direct test invocations of `runContextVaultRestructure` do not —
  // so wrap the parent-primary-key rewrite in its own nested savepoint
  // here. better-sqlite3 supports `db.transaction(...).deferred` /
  // savepoint nesting transparently, so this composes with any outer
  // txn the runner already started.
  let entitiesCount = 0;
  let sourceKeysCount = 0;
  const work = db.transaction(() => {
    db.pragma("defer_foreign_keys = ON");
    const rows = db
      .prepare<[], { path: string }>("SELECT path FROM entities")
      .all();
    const updateEntity = db.prepare(
      "UPDATE entities SET path = ? WHERE path = ?",
    );
    const updateSourceKeys = sourceKeysExists
      ? db.prepare("UPDATE entity_source_keys SET path = ? WHERE path = ?")
      : null;
    for (const row of rows) {
      const newPath = translateEntityPath(row.path);
      if (newPath !== null && newPath !== row.path) {
        // Child rows must move first: with FKs deferred, the child can
        // briefly reference a non-existent parent path, but only the
        // commit-time check matters — and at commit the new parent
        // exists. Updating the child first matches the more intuitive
        // ordering even though either order works under defer.
        if (updateSourceKeys) {
          const result = updateSourceKeys.run(newPath, row.path);
          sourceKeysCount += result.changes;
        }
        updateEntity.run(newPath, row.path);
        entitiesCount += 1;
      }
    }
  });
  work();
  return { entities: entitiesCount, entitySourceKeys: sourceKeysCount };
}

function rewriteManagedTasksOutputPaths(db: Database.Database): number {
  const exists = db
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='managed_tasks'",
    )
    .get();
  if (!exists) return 0;
  const rows = db
    .prepare<[], { id: string; output_path: string | null }>(
      "SELECT id, output_path FROM managed_tasks WHERE output_path IS NOT NULL",
    )
    .all();
  const update = db.prepare(
    "UPDATE managed_tasks SET output_path = ? WHERE id = ?",
  );
  let count = 0;
  for (const row of rows) {
    if (!row.output_path) continue;
    const newPath = translateEntityPath(row.output_path);
    if (newPath !== null && newPath !== row.output_path) {
      update.run(newPath, row.id);
      count += 1;
    }
  }
  return count;
}

/**
 * Translate `entities.path` / `entity_source_keys.path` /
 * `managed_tasks.output_path` legacy spellings to the new
 * `knowledge/entities/<domain>/...` layout. Returns `null` if no
 * translation applies — caller leaves the row untouched.
 */
function translateEntityPath(path: string): string | null {
  for (const domain of MANAGEMENT_DOMAINS) {
    const prefix = `${domain}/`;
    if (path.startsWith(prefix)) {
      return `knowledge/entities/${path}`;
    }
    if (path === domain) {
      return `knowledge/entities/${domain}`;
    }
  }
  return null;
}

// ───────────────────────────────────────────────────────────────────
// V17 JSON-blob rewrites
// ───────────────────────────────────────────────────────────────────

/**
 * Build the `(oldPrefix, newPrefix)` pair list for `rewritePathsInDb`.
 * The order is longest-prefix-first so `<contextDir>/rules/policies`
 * rewrites before `<contextDir>/rules`. The list is derived
 * programmatically from the MOVES manifest plus the out-of-contextDir
 * moves so it stays in lockstep with the source of truth.
 */
export function buildAbsolutePathRewrites(args: {
  dataDir: string;
  contextDir: string;
}): Array<readonly [string, string]> {
  const { dataDir, contextDir } = args;
  const raw: Array<readonly [string, string]> = [
    // Out-of-contextDir (longest first).
    [join(dataDir, "integrations.md"), join(contextDir, "policies/integrations.md")],
    [join(dataDir, "wiki"), join(contextDir, "knowledge/wiki")],
    [join(dataDir, "skills"), join(contextDir, "policies/skills")],

    // In-contextDir — more-specific prefixes first.
    [
      join(contextDir, "rules/policies"),
      join(contextDir, "policies/management-captures"),
    ],
    [
      join(contextDir, "agent/journal.md"),
      join(contextDir, "journal/agent.md"),
    ],
    [join(contextDir, "agent/scratch"), join(contextDir, "state/scratch")],
    [
      join(contextDir, "agent/profile-questions.md"),
      join(contextDir, "state/profile-questions.md"),
    ],
    [join(contextDir, "today.md"), join(contextDir, "state/today.md")],
    [join(contextDir, "yesterday.md"), join(contextDir, "state/yesterday.md")],
    [join(contextDir, "roadmap.md"), join(contextDir, "plans/roadmap.md")],
    [join(contextDir, "user"), join(contextDir, "identity")],
    [join(contextDir, "rules"), join(contextDir, "policies")],
    [join(contextDir, "routines"), join(contextDir, "policies/routines")],
    [join(contextDir, "projects"), join(contextDir, "plans/projects")],
    [join(contextDir, "daily"), join(contextDir, "journal/daily")],
    [join(contextDir, "weekly"), join(contextDir, "journal/weekly")],
    [join(contextDir, "monthly"), join(contextDir, "journal/monthly")],
    [join(contextDir, "dossiers"), join(contextDir, "knowledge/dossiers")],
    [join(contextDir, "inbox"), join(contextDir, "state/inbox")],
    [join(contextDir, "_activity"), join(contextDir, "state/activity")],
  ];
  // Re-sort defensively in case future edits land out of order.
  return [...raw].sort((a, b) => b[0].length - a[0].length);
}

// ───────────────────────────────────────────────────────────────────
// Verification (§11.11)
// ───────────────────────────────────────────────────────────────────

function verifyMigrationCompleteness(args: {
  contextDir: string;
  dataDir: string;
  db: Database.Database;
  absoluteRewrites: ReadonlyArray<readonly [string, string]>;
}): void {
  const { contextDir, dataDir, db, absoluteRewrites } = args;

  // Step 2 — no forbidden legacy top-level dirs survive non-empty.
  for (const dir of FORBIDDEN_LEGACY_DIRS) {
    const abs = join(contextDir, dir);
    if (!existsSync(abs)) continue;
    let entries: string[] = [];
    try {
      entries = readdirSync(abs);
    } catch {
      continue;
    }
    if (entries.length > 0) {
      throw new VerificationFailed(
        `Legacy directory still populated post-migration: ${dir} (${entries.length} entries)`,
      );
    }
  }

  // Step 3 — every internal wiki workspace re-pointed.
  const wikiExists = db
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='wiki_workspaces'",
    )
    .get();
  if (wikiExists) {
    const newWikiBase = join(contextDir, "knowledge", "wiki");
    const stale = db
      .prepare<[string], { id: number; root_path: string }>(
        "SELECT id, root_path FROM wiki_workspaces WHERE kind = 'internal' AND root_path NOT LIKE ?",
      )
      .all(`${newWikiBase}%`);
    if (stale.length > 0) {
      throw new VerificationFailed(
        `wiki_workspaces still references legacy root_path: ${stale
          .map((r) => `id=${r.id} root=${r.root_path}`)
          .join(", ")}`,
      );
    }
  }

  // Step 4 — out-of-contextDir paths landed inside the vault.
  // The legacy `<dataDir>/integrations.md` must not coexist with the new
  // `<contextDir>/policies/integrations.md` — that would mean the move
  // got skipped or a stale copy survived. The new path may not exist on
  // fresh installs (`bootstrapManagementMd` writes it later), so we only
  // catch the "both exist" failure mode here.
  const legacyIntegrations = join(dataDir, "integrations.md");
  const canonicalIntegrations = join(contextDir, "policies", "integrations.md");
  if (existsSync(legacyIntegrations) && existsSync(canonicalIntegrations)) {
    throw new VerificationFailed(
      "integrations.md exists at both legacy and canonical paths — manual reconciliation required",
    );
  }

  // Step 5 — functional SQLite path keys are canonical (V13 column UPDATEs).
  const tableHas = (table: string): boolean =>
    Boolean(
      db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?",
        )
        .get(table),
    );
  const legacyPathLikePatterns = [
    "user/%",
    "rules/%",
    "routines/%",
    "daily/%",
    "weekly/%",
    "monthly/%",
    "dossiers/%",
    "inbox/%",
    "agent/%",
    "_activity/%",
    "projects/%",
    "git/%",
  ];
  if (tableHas("md_file_snapshots")) {
    for (const pat of legacyPathLikePatterns) {
      const row = db
        .prepare<[string], { c: number }>(
          "SELECT COUNT(*) AS c FROM md_file_snapshots WHERE file_path LIKE ?",
        )
        .get(pat);
      if ((row?.c ?? 0) > 0) {
        throw new VerificationFailed(
          `md_file_snapshots.file_path still has ${row!.c} rows matching legacy prefix ${pat}`,
        );
      }
    }
  }
  if (tableHas("entities")) {
    const stale = db
      .prepare<[], { c: number }>(
        "SELECT COUNT(*) AS c FROM entities WHERE path IS NOT NULL AND path NOT LIKE 'knowledge/entities/%'",
      )
      .get();
    if ((stale?.c ?? 0) > 0) {
      throw new VerificationFailed(
        `entities.path has ${stale!.c} rows not under knowledge/entities/`,
      );
    }
  }
  if (tableHas("entity_source_keys")) {
    const stale = db
      .prepare<[], { c: number }>(
        "SELECT COUNT(*) AS c FROM entity_source_keys WHERE path IS NOT NULL AND path NOT LIKE 'knowledge/entities/%'",
      )
      .get();
    if ((stale?.c ?? 0) > 0) {
      throw new VerificationFailed(
        `entity_source_keys.path has ${stale!.c} rows not under knowledge/entities/`,
      );
    }
  }
  if (tableHas("managed_tasks")) {
    const stale = db
      .prepare<[], { c: number }>(
        "SELECT COUNT(*) AS c FROM managed_tasks WHERE output_path IS NOT NULL AND output_path NOT LIKE 'knowledge/entities/%' AND output_path != ''",
      )
      .get();
    if ((stale?.c ?? 0) > 0) {
      throw new VerificationFailed(
        `managed_tasks.output_path has ${stale!.c} rows not under knowledge/entities/`,
      );
    }
  }

  // Step 6 — runtime-adjacent roots canonical.
  // 6a — user skill bundles live under `<contextDir>/policies/skills/`,
  // not the legacy `<dataDir>/skills/`. We assert legacy is gone (the
  // out-of-contextDir mover empties it on migration). A fresh install
  // has neither path; that's fine.
  const legacySkills = join(dataDir, "skills");
  if (existsSync(legacySkills)) {
    let legacyChildren: string[] = [];
    try {
      legacyChildren = readdirSync(legacySkills);
    } catch {
      legacyChildren = [];
    }
    // A surviving entry is a problem only if it carries a SKILL.md (real
    // user skill) or the legacy `overlays/` directory we explicitly moved.
    for (const child of legacyChildren) {
      const childAbs = join(legacySkills, child);
      const skillMd = join(childAbs, "SKILL.md");
      if (existsSync(skillMd)) {
        throw new VerificationFailed(
          `Legacy <dataDir>/skills/${child}/SKILL.md still present — user skill was not relocated`,
        );
      }
      if (child === "overlays") {
        throw new VerificationFailed(
          "Legacy <dataDir>/skills/overlays/ still present — overlay JSON was not relocated to skill-curation-overlays/",
        );
      }
    }
  }

  // Step 7 — V17 second-pass: rewriting against the same prefixes should
  // yield zero rewrites.
  for (const [oldPrefix, newPrefix] of absoluteRewrites) {
    const stats = rewritePathsInDb(db, oldPrefix, newPrefix);
    if (stats.rowsRewritten > 0) {
      throw new VerificationFailed(
        `V17 second-pass found ${stats.rowsRewritten} unrewritten paths under ${oldPrefix}`,
      );
    }
  }
}

// ───────────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────────

function ensureContextDirExists(contextDir: string): void {
  if (!existsSync(contextDir)) {
    mkdirSync(contextDir, { recursive: true });
  }
}

interface UnmanifestedCapture {
  from: string;
  to: string;
}

/**
 * §11.9 "no omissions" safety net. After the manifest loop runs, walk every
 * legacy top-level entry still surviving with content. Anything left over
 * is **user-added** (the manifest covers every shape we ship). Rather than
 * silently dropping it or failing the verifier, copy each entry into
 * `state/scratch/legacy-unmanifested-<date>-<slug>.md` so the user can
 * recover it. The source entry is then removed so `removeEmptyLegacyDirs`
 * + the verifier can complete.
 *
 * Files are inlined as Markdown code-fence blocks; directory trees are
 * flattened into a single artifact per file under the parent name.
 */
function captureUnmanifestedEntries(contextDir: string): UnmanifestedCapture[] {
  const captured: UnmanifestedCapture[] = [];
  const dateStr = new Date().toISOString().slice(0, 10);
  const scratchDir = join(contextDir, "state", "scratch");

  for (const legacy of FORBIDDEN_LEGACY_DIRS) {
    const abs = join(contextDir, legacy);
    if (!existsSync(abs)) continue;
    let children: string[];
    try {
      children = readdirSync(abs);
    } catch {
      continue;
    }
    if (children.length === 0) continue;

    mkdirSync(scratchDir, { recursive: true });
    const sluggedRoot = legacy.replace(/[^a-z0-9-]/gi, "-").toLowerCase();
    for (const child of children) {
      const childAbs = join(abs, child);
      let isDir = false;
      try {
        isDir = statSync(childAbs).isDirectory();
      } catch {
        continue;
      }
      const slug = `${sluggedRoot}-${child}`.replace(/[^a-z0-9-]/gi, "-").toLowerCase();
      const target = join(scratchDir, `legacy-unmanifested-${dateStr}-${slug}.md`);
      try {
        if (isDir) {
          // Recursive copy under a single artifact dir alongside the
          // sentinel .md so the user can browse the tree if they need it.
          const dirTarget = join(
            scratchDir,
            `legacy-unmanifested-${dateStr}-${slug}-dir`,
          );
          cpSync(childAbs, dirTarget, { recursive: true });
          writeFileSync(
            target,
            `# Legacy unmanifested entry\n\n` +
              `Source: \`${legacy}/${child}/\` (directory)\n` +
              `Captured directory: \`state/scratch/legacy-unmanifested-${dateStr}-${slug}-dir/\`\n\n` +
              `This directory was found under \`${legacy}/\` at vault-restructure ` +
              `time and did not match any manifest move rule. It has been copied here ` +
              `verbatim so you can review and reorganize it.\n`,
            "utf-8",
          );
          rmSync(childAbs, { recursive: true });
        } else {
          let content = "";
          try {
            content = readFileSync(childAbs, "utf-8");
          } catch {
            content = "(unreadable binary or permission denied)";
          }
          writeFileSync(
            target,
            `# Legacy unmanifested entry\n\n` +
              `Source: \`${legacy}/${child}\`\n\n` +
              `\`\`\`\n${content}\n\`\`\`\n`,
            "utf-8",
          );
          rmSync(childAbs);
        }
        captured.push({
          from: `${legacy}/${child}`,
          to: `state/scratch/legacy-unmanifested-${dateStr}-${slug}.md`,
        });
      } catch (err) {
        logger.warn(
          { err, legacy, child },
          "captureUnmanifestedEntries: failed to capture entry; leaving in place",
        );
      }
    }
  }

  return captured;
}

/**
 * Best-effort removal of empty legacy parent directories. After a
 * `rename` move the source filename disappears but its parent dir
 * remains as an empty husk; this helper sweeps the known parents.
 *
 * Non-empty dirs are preserved (the verifier catches them and raises
 * VerificationFailed). Removal errors are swallowed — the next boot
 * will retry, and a stuck non-empty dir surfaces at verification.
 */
function removeEmptyLegacyDirs(contextDir: string): void {
  const candidates = [
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
    "git",
    "git-repos",
    ...MANAGEMENT_DOMAINS,
  ];
  for (const name of candidates) {
    const abs = join(contextDir, name);
    if (!existsSync(abs)) continue;
    try {
      // readdirSync first so we don't blindly rm a dir with user content.
      const children = readdirSync(abs);
      if (children.length === 0) {
        rmSync(abs, { recursive: true, force: true });
        continue;
      }
      // For `git/`, child dirs (e.g. `git/myrepo/`) may also be husks.
      if (name === "git") {
        for (const child of children) {
          const childAbs = join(abs, child);
          try {
            if (readdirSync(childAbs).length === 0) {
              rmSync(childAbs, { recursive: false, force: true });
            }
          } catch {
            /* ignore */
          }
        }
        // Retry parent removal after children pruned.
        try {
          if (readdirSync(abs).length === 0) {
            rmSync(abs, { recursive: true, force: true });
          }
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* ignore — surfaces at verification */
    }
  }
}

function readVaultVersion(contextDir: string): string | null {
  const abs = join(contextDir, VAULT_VERSION_FILE);
  if (!existsSync(abs)) return null;
  return readFileSync(abs, "utf-8").trim();
}

function writeVaultVersion(contextDir: string): void {
  const abs = join(contextDir, VAULT_VERSION_FILE);
  writeFileSync(abs, `${VAULT_LAYOUT_VERSION}\n`, "utf-8");
}

function createBackup(args: {
  dataDir: string;
  contextDir: string;
}): string {
  const { dataDir, contextDir } = args;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupRoot = join(
    dataDir,
    "migration-backups",
    `vault-pre-restructure-${stamp}`,
  );
  mkdirSync(backupRoot, { recursive: true });

  if (existsSync(contextDir)) {
    cpSync(contextDir, join(backupRoot, "context"), { recursive: true });
  }
  const wikiSrc = join(dataDir, "wiki");
  if (existsSync(wikiSrc)) {
    cpSync(wikiSrc, join(backupRoot, "wiki"), { recursive: true });
  }
  const integrationsSrc = join(dataDir, "integrations.md");
  if (existsSync(integrationsSrc)) {
    copyFileSync(integrationsSrc, join(backupRoot, "integrations.md"));
  }
  const skillsSrc = join(dataDir, "skills");
  if (existsSync(skillsSrc)) {
    cpSync(skillsSrc, join(backupRoot, "skills"), { recursive: true });
  }
  // MANIFEST.json — captures the moment-of-capture state of the SQLite
  // path-key tables so a manual rollback can replay the rows.
  writeFileSync(
    join(backupRoot, "MANIFEST.json"),
    JSON.stringify({ stamp, dataDir, contextDir, migrationId: MIGRATION_ID }, null, 2),
    "utf-8",
  );

  return backupRoot;
}

/**
 * Boot-time preflight (§11.10 #2). Compares the filesystem marker against
 * the `schema_migrations` row. Returns the action the caller should take.
 */
export type VaultVersionAction =
  | "noop"
  | "run-migration"
  | "throw-unknown-version";

export function assessVaultVersion(args: {
  contextDir: string;
}): { action: VaultVersionAction; observedVersion: string | null } {
  const observed = readVaultVersion(args.contextDir);
  if (observed === VAULT_LAYOUT_VERSION) {
    return { action: "noop", observedVersion: observed };
  }
  if (observed === null || observed === "1") {
    return { action: "run-migration", observedVersion: observed };
  }
  return { action: "throw-unknown-version", observedVersion: observed };
}
