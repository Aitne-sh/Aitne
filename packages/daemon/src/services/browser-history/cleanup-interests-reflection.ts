import {
  existsSync,
  readFileSync,
  readdirSync,
  unlinkSync,
} from "node:fs";
import { join, relative } from "node:path";
import type Database from "better-sqlite3";
import { writeFileAtomically } from "../../core/atomic-write.js";
import { deleteRuntimeState } from "../../db/runtime-state.js";
import { createLogger } from "../../logging.js";
import type { AgentWriteTracker } from "../../safety/agent-write-tracker.js";
import { acquireInterestsReflectionLock } from "./interests-reflection-lock.js";
import { stripAllAutoBlocks } from "./pipeline/interests-block.js";
import {
  RUNTIME_STATE_LAST_RUN_AT_KEY,
  RUNTIME_STATE_LAST_RUN_TARGETS_KEY,
} from "./refresh-interests-reflection.js";

/**
 * WEEKLY_INTERESTS_REFLECTION_PLAN.md §10.3.1 — bulk-purge counterpart
 * of `refreshInterestsReflection`. Invoked exclusively from the
 * dashboard `POST /api/browser-history/cleanup-interests-reflection`
 * (Approve tier; bearer-token required) and from tests; no skill or
 * scheduler path reaches this helper.
 *
 * Four-step purge per §10.3.1:
 *
 *   1. Strip every `<!-- BEGIN aitne:browser-interests v1 … --> …
 *      <!-- END aitne:browser-interests v1 … -->` block from
 *      `user/profile.md`, `user/_index.md`, and every `projects/*.md`.
 *   2. If `alsoDeleteResearchThemesFile` is true (default), delete
 *      `user/research-themes.md` — the wholly-daemon-owned file from
 *      Mode B writes.
 *   3. Clear the two `runtime_state` markers the refresh helper writes
 *      (`weekly_interests_last_run_at` / `..._targets`).
 *   4. Emit one `agent_actions(action_type='browser_interests_
 *      reflection_cleanup', …)` row carrying the structural detail the
 *      dashboard surfaces ("blocksRemoved / filesAffected /
 *      researchThemesDeleted").
 *
 * Idempotent by construction: a re-run on already-cleaned files
 * removes zero blocks, leaves `runtime_state` queries returning null,
 * and produces the same return shape. The cleanup is a *one-shot
 * purge*, not a feature toggle — the next `routine.weekly_review`
 * re-creates fresh content from scratch as long as the upstream
 * `browser-history` integration is still enabled (§13).
 */

const logger = createLogger("cleanup-interests-reflection");

// Block-strip logic lives in `pipeline/interests-block.ts`'s
// `stripAllAutoBlocks` so there is one source of truth for the
// BEGIN/END regex shape. The cleanup helper composes that pure
// utility with FS + audit + tracker concerns.

export interface CleanupOptions {
  /**
   * If true (default), also delete `user/research-themes.md`. The file
   * is wholly daemon-owned (`owner: aitne-browser-history` in
   * frontmatter), so a delete is the intuitive purge — `cleanup` is
   * the user saying "remove the auto-generated content". When false,
   * the file is retained (the dashboard surfaces this as
   * "Remove the auto-blocks but keep the snapshot file").
   */
  readonly alsoDeleteResearchThemesFile?: boolean;
  /**
   * Provenance tag for the audit row. The HTTP route passes
   * `"dashboard"`; tests pass `"test"`. There is no scheduler-trigger
   * path for cleanup — the feature has no per-feature toggle, so
   * cron-driven purges would be a contradiction (§13).
   */
  readonly trigger?: "dashboard" | "test";
  /**
   * FS-watcher attribution channel. Marked on every file we strip
   * blocks from AND on the `user/research-themes.md` delete (path-only
   * mode for the delete since post-unlink there is no content to hash).
   * Without it the cleanup's writes would be observed as user edits —
   * the inverse of the operator's intent (a one-shot purge should not
   * read like fresh user activity to the morning routine / hourly
   * check signal floor).
   */
  readonly writeTracker?: AgentWriteTracker;
}

export interface CleanupResult {
  /** Number of `aitne:browser-interests v1` blocks stripped, summed across all files. */
  blocksRemoved: number;
  /** Relative paths (POSIX) of files whose contents changed or were deleted. */
  filesAffected: string[];
  /** True iff `user/research-themes.md` was deleted in this pass. False if it was absent or retention was requested. */
  researchThemesDeleted: boolean;
}

export function cleanupInterestsReflection(
  db: Database.Database,
  contextDir: string,
  options: CleanupOptions = {},
): CleanupResult {
  const alsoDeleteThemes = options.alsoDeleteResearchThemesFile ?? true;
  const trigger = options.trigger ?? "dashboard";
  const writeTracker = options.writeTracker;

  // rev 4 — same courtesy mutex as the refresh helper. Contention is
  // a surface-level error the caller decides how to handle (HTTP 409
  // for the dashboard route). Held until the helper returns (try/
  // finally below) so a concurrent refresh cannot interleave block-
  // strip and block-write on the same files, and so a future
  // refactor introducing a throw cannot leak the lock.
  const release = acquireInterestsReflectionLock(`cleanup:${trigger}`);
  try {
    return runCleanup(db, contextDir, trigger, alsoDeleteThemes, writeTracker);
  } finally {
    release();
  }
}

function runCleanup(
  db: Database.Database,
  contextDir: string,
  trigger: "dashboard" | "test",
  alsoDeleteThemes: boolean,
  writeTracker: AgentWriteTracker | undefined,
): CleanupResult {
  let blocksRemoved = 0;
  const filesAffected: string[] = [];

  // 1. user/profile.md
  blocksRemoved += stripBlocksFromFile(
    contextDir,
    join(contextDir, "user", "profile.md"),
    filesAffected,
    writeTracker,
  );

  // 2. user/_index.md
  blocksRemoved += stripBlocksFromFile(
    contextDir,
    join(contextDir, "user", "_index.md"),
    filesAffected,
    writeTracker,
  );

  // 3. every projects/*.md (only the .md files at the top level —
  //    no recursion into subdirectories; the matcher only writes to
  //    top-level project files, so a recursive scan would expand the
  //    blast radius without matching the writer).
  const projectsDir = join(contextDir, "projects");
  if (existsSync(projectsDir)) {
    let entries: string[] = [];
    try {
      entries = readdirSync(projectsDir);
    } catch (err) {
      logger.warn(
        { err, projectsDir },
        "Failed to enumerate projects/ during cleanup; skipping project annotations",
      );
      entries = [];
    }
    for (const name of entries) {
      if (!name.endsWith(".md")) continue;
      const fullPath = join(projectsDir, name);
      blocksRemoved += stripBlocksFromFile(
        contextDir,
        fullPath,
        filesAffected,
        writeTracker,
      );
    }
  }

  // 4. Optional: delete user/research-themes.md
  const themesPath = join(contextDir, "user", "research-themes.md");
  let researchThemesDeleted = false;
  if (alsoDeleteThemes && existsSync(themesPath)) {
    // Mark path-only (no content to hash post-unlink). The tracker's
    // path-only entry causes `isMarked(themesPath, …)` to return true
    // for any observation on the path within the TTL — including the
    // chokidar `unlink` event. Roll back on failure so a missed delete
    // does not suppress a later legitimate user edit on the same path.
    writeTracker?.markWriting(themesPath);
    try {
      unlinkSync(themesPath);
      researchThemesDeleted = true;
      filesAffected.push(relativePosix(contextDir, themesPath));
    } catch (err) {
      writeTracker?.unmark(themesPath);
      // Deletion failure is non-fatal — the block-strip pass is the
      // load-bearing surface (the user-injected `<user>` context comes
      // from profile.md, not research-themes.md). Log loudly and
      // continue so the audit row still records the partial purge.
      logger.error(
        { err, themesPath },
        "Failed to delete research-themes.md during cleanup",
      );
    }
  }

  // 5. Clear runtime_state markers regardless of file outcomes so a
  //    fresh weekly_review tick starts from a clean slate.
  try {
    deleteRuntimeState(db, RUNTIME_STATE_LAST_RUN_AT_KEY);
    deleteRuntimeState(db, RUNTIME_STATE_LAST_RUN_TARGETS_KEY);
  } catch (err) {
    logger.error(
      { err },
      "Failed to clear runtime_state markers during cleanup",
    );
  }

  const result: CleanupResult = {
    blocksRemoved,
    filesAffected,
    researchThemesDeleted,
  };

  emitAuditRow(db, result, trigger);

  logger.info(
    {
      trigger,
      blocksRemoved: result.blocksRemoved,
      filesAffected: result.filesAffected.length,
      researchThemesDeleted: result.researchThemesDeleted,
    },
    "Weekly interests reflection cleanup applied",
  );

  return result;
}

/**
 * Strip every `aitne:browser-interests v1` block from `fullPath`.
 * Returns the count removed; mutates `filesAffected` (push of the
 * relative path) only if any content changed. A missing file is a
 * no-op, matching the idempotency contract.
 *
 * Block detection is delegated to `stripAllAutoBlocks` so the BEGIN/END
 * regex shape lives in exactly one place (`pipeline/interests-block.ts`).
 * The local-only concern here is the post-strip tidy (collapse 3+
 * newline runs, normalise the trailing newline) which is intentionally
 * more aggressive than the shared helper's minimal trailing-newline
 * preservation — repeated cleanup passes should not accumulate
 * blank-line drift in the file.
 */
function stripBlocksFromFile(
  contextDir: string,
  fullPath: string,
  filesAffected: string[],
  writeTracker: AgentWriteTracker | undefined,
): number {
  if (!existsSync(fullPath)) return 0;
  let original: string;
  try {
    original = readFileSync(fullPath, "utf-8");
  } catch (err) {
    logger.warn(
      { err, fullPath },
      "Failed to read file during cleanup; skipping",
    );
    return 0;
  }
  const { content: stripped, blocksRemoved } = stripAllAutoBlocks(original);
  if (blocksRemoved === 0) return 0;
  // Collapse any trailing whitespace runs created by the substitution
  // so the file does not accumulate blank-line growth across repeated
  // cleanup invocations. Keep at most one trailing newline.
  const tidied = stripped.replace(/\n{3,}/g, "\n\n").replace(/[\s\n]+$/, "\n");
  // Mark BEFORE the rename so chokidar's debounced `change` event is
  // classified as agent-originated. Roll back on failure so a stale
  // mark does not suppress a later legitimate user edit (C2 pattern,
  // same as roadmap-maintenance.ts and core/context/write.ts).
  writeTracker?.markWriting(fullPath, tidied);
  try {
    writeFileAtomically(fullPath, tidied);
    filesAffected.push(relativePosix(contextDir, fullPath));
  } catch (err) {
    writeTracker?.unmark(fullPath);
    logger.error(
      { err, fullPath },
      "Failed to write stripped content during cleanup",
    );
    return 0;
  }
  return blocksRemoved;
}

function relativePosix(contextDir: string, fullPath: string): string {
  return relative(contextDir, fullPath).split("\\").join("/");
}

function emitAuditRow(
  db: Database.Database,
  result: CleanupResult,
  trigger: "dashboard" | "test",
): void {
  try {
    db.prepare(
      `INSERT INTO agent_actions
         (action_type, trigger, result, detail, completed_at, source_kind, metadata)
       VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, ?, ?)`,
    ).run(
      "browser_interests_reflection_cleanup",
      `weekly_interests_cleanup:${trigger}`,
      "success",
      JSON.stringify({
        trigger,
        blocks_removed: result.blocksRemoved,
        files_affected: result.filesAffected,
        research_themes_deleted: result.researchThemesDeleted,
      }),
      "manual",
      // rev 4 — explicit `metadata: '{}'`. Same rationale as the
      // refresh helper: daemon-write rows leave the agent-self-report
      // side-channel empty per the `agent_actions` schema comment.
      "{}",
    );
  } catch (err) {
    // Mirror the refresh helper's posture: an audit-row failure must
    // not abort the purge — file writes are the load-bearing
    // side-effect. Log loudly so an operator notices the audit gap.
    logger.error({ err }, "Failed to write cleanup audit row");
  }
}
