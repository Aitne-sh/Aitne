import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CONTEXT_DIR_NAMES, CONTEXT_RELATIVE_PATHS } from "./context-paths.js";
import { preTickProfileQuestions } from "./profile-questions/seed.js";
import { createLogger } from "../logging.js";

/**
 * Relative path of the profile-interview queue file, mirrored from the
 * shipped template. Hardcoded here (rather than imported from
 * `context-paths.ts`) because the seed runs before any caller would
 * read it from runtime config.
 */
const PROFILE_QUESTIONS_REL = "agent/profile-questions.md";

const logger = createLogger("skeleton");

/**
 * Fallback placeholders for `today.md` and `roadmap.md` used when the
 * shipped templates tree is unreachable. Exported so the skeleton test
 * can assert byte-equality with `agent-assets/templates/today.md` and
 * `agent-assets/templates/roadmap.md` — a drift canary against the two
 * paths diverging. See `skeleton.test.ts:"fallback matches template"`.
 */
export const FALLBACK_PLACEHOLDERS: Readonly<Record<string, string>> = Object.freeze({
  [CONTEXT_RELATIVE_PATHS.today]: [
    "# Today",
    "",
    "## User Schedule",
    "",
    "## User Tasks",
    "",
    "## Agent Plan",
    "",
    "## Agent Notes",
    "",
    "## Agent Log",
    "",
    "## Handoff",
    "",
  ].join("\n"),
  // Roadmap skeleton: `Last synced: 1970-01-01` is an intentional Unix-epoch
  // sentinel — a valid YMD so `roadmap-validate.ts:LAST_SYNCED_RE` accepts
  // mid-seed PATCHes, but obviously-stale so it is never mistaken for a real
  // sync timestamp. `(Not yet configured)` bullets under Annual Goals and
  // Quarterly Focus cause `config.ts:isRoadmapStale` to flag the file and
  // trigger the `roadmap_refresh` catch-up (see `index.ts:1857` comment).
  [CONTEXT_RELATIVE_PATHS.roadmap]: [
    "# Roadmap",
    "> Last synced: 1970-01-01",
    "",
    "## Annual Goals",
    "- (Not yet configured)",
    "",
    "## Quarterly Focus",
    "- (Not yet configured)",
    "",
    "## Long-term Plans",
    "",
    "## Agent Action Plan",
    "",
    "## Recurring",
    "- Every Friday: weekly review",
    "",
  ].join("\n"),
});

export interface EnsureSkeletonFilesOptions {
  /**
   * Initial setup generates rules/management.md from the user's answers.
   * Seeding the template before the Customize Your Rules step makes
   * /setup/start think setup is already complete.
   */
  skipManagementRules?: boolean;
}

/**
 * Locate `agent-assets/templates/` with multiple fallbacks so skeleton
 * seeding works regardless of how the daemon is launched.
 *
 * The daemon can be launched from the repo root (dev / `pa start`),
 * from an arbitrary cwd (systemd, launchd, Docker), or from a prebuilt
 * tarball. Each layout positions `agent-assets/` differently relative
 * to `process.cwd()`, so relying on `cwd + "./agent-assets/templates"`
 * alone silently fails in prod deployments.
 *
 * Search order (first hit on disk wins):
 *  1. `PA_TEMPLATES_DIR` environment variable — explicit override for
 *     unusual deployments and tests that want to steer the function
 *     at a tree they own.
 *  2. `<workspaceDir>/agent-assets/templates` — dev mode (`pa start`
 *     launched from the repo root) AND the test harness (which sets
 *     a per-test `workspaceDir` with a fake templates tree). Placing
 *     this ahead of the module-derived fallback lets tests influence
 *     resolution without having to shell out to an env var.
 *  3. A path derived from this module's own URL via `import.meta.url`
 *     — walks up from `packages/daemon/{src,dist}/core/skeleton.{ts,js}`
 *     to the repo root. Acts as the production-safety fallback when
 *     `workspaceDir` is "." but cwd is not the repo root (systemd,
 *     launchd, Docker, … — exactly the cases where the old "cwd + ./"
 *     resolution silently fell through to the "skip seed" branch).
 *
 * Returns `null` if none of the candidates exist on disk; callers
 * degrade gracefully (skeleton subdirectories and placeholders still
 * land, only template-sourced files are skipped).
 */
export function resolveTemplatesRoot(workspaceDir: string): string | null {
  const candidates: string[] = [];

  const envOverride = process.env.PA_TEMPLATES_DIR;
  if (envOverride && envOverride.length > 0) {
    candidates.push(resolve(envOverride));
  }

  candidates.push(join(workspaceDir, "agent-assets", "templates"));

  // `import.meta.url` — anchored to this source file, not cwd. The
  // path is `packages/daemon/{src,dist}/core/skeleton.{ts,js}`; we walk
  // up four levels to reach the repo root.
  try {
    const self = fileURLToPath(import.meta.url);
    const repoRoot = resolve(dirname(self), "..", "..", "..", "..");
    candidates.push(join(repoRoot, "agent-assets", "templates"));
    /* c8 ignore start — `fileURLToPath(import.meta.url)` only throws
       under exotic bundler configurations where `import.meta.url` is
       not a proper file:// URL. Unreachable from a real Node ESM run. */
  } catch {
    // fall back to candidates already collected.
  }
  /* c8 ignore stop */

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
    /* c8 ignore start — the import.meta.url-derived candidate above
       resolves to `<repo>/agent-assets/templates`, which exists in every
       shipped layout (dev, npm tarball, smoke-test worktree). The
       for-loop fall-through and null return are forward-defensive for a
       hypothetical install with the templates tree stripped; see also
       the mirror `c8 ignore` in `api/routes/context/repair.ts`. */
  }
  return null;
}
/* c8 ignore stop */

/**
 * Materialize the agent's skeleton vault layout at `contextDir`.
 *
 * B-007 §8 — seed the fresh-install vault layout from `agent-assets/templates/`.
 * Idempotent by design: existing files are preserved, missing ones are
 * added. Safe to invoke both at setup completion AND at every successful
 * vault migration.
 *
 * Called from:
 *  - `api/routes/setup-migrate.ts` — right after `commitVaultSettings`
 *    so the target directory is immediately usable when the user
 *    selects an obsidian vault path (or changes it later via Settings
 *    → Management Mode). Without this the target would only contain
 *    the empty subdirectories that `initDirectories` created under the
 *    plain-mode fallback, leaving the agent with no policy files /
 *    routine rulebooks / user profile for prompt injection.
 *  - `api/routes/setup.ts` `/setup/save-rules` — kept as a safety net
 *    for any code path that commits `rules/management.md` without going
 *    through migrate-context (e.g. the plain-mode first-run flow).
 *
 * When `agent-assets/templates/` is missing (running from a prebuilt
 * tarball without assets, or an unexpected `workspaceDir`), the
 * function still materializes the canonical subdirectory skeleton and
 * the `today.md` / `roadmap.md` placeholders so the agent has a valid
 * working surface; template-sourced files are just skipped with a
 * warning in that case.
 */
export function ensureSkeletonFiles(
  contextDir: string,
  workspaceDir: string,
  options: EnsureSkeletonFilesOptions = {},
): void {
  // Always materialize canonical subdirectories. This is a no-op when
  // they already exist and gives the agent a consistent layout even
  // when the templates tree is unavailable.
  for (const sub of CONTEXT_DIR_NAMES) {
    mkdirSync(join(contextDir, sub), { recursive: true });
  }

  // Profile-interview queue Layer 1 (deterministic skeleton-time
  // pre-tick) only fires when the queue file did not already exist —
  // re-runs over an existing vault must not overwrite hand-edits or
  // accumulated `last_attempted` history. See
  // docs/design/backlog/profile-interview-queue.md §3.5.1.
  const profileQueuePath = join(contextDir, PROFILE_QUESTIONS_REL);
  const profileQueueExistedBefore = existsSync(profileQueuePath);

  const templatesRoot = resolveTemplatesRoot(workspaceDir);
  if (templatesRoot !== null) {
    copyTreePreservingExisting(templatesRoot, contextDir, options);
    logger.info(
      { templatesRoot, contextDir },
      "skeleton seeded from templates tree",
    );
    /* c8 ignore start — resolveTemplatesRoot always finds a candidate
       via its import.meta.url fallback in every shipped layout; this
       else branch is forward-defensive for a missing-templates install
       (mirrors the `c8 ignore` on resolveTemplatesRoot itself). */
  } else {
    logger.warn(
      { contextDir, workspaceDir, env: process.env.PA_TEMPLATES_DIR ?? null },
      "agent-assets/templates/ not locatable — skipping template seed (placeholders will still be written)",
    );
  }
  /* c8 ignore stop */

  // Fallback placeholders used ONLY when `agent-assets/templates/` is not
  // locatable (rare: tarball deployments without assets, misconfigured
  // `workspaceDir`). Byte-equal to the shipped `today.md` / `roadmap.md`
  // templates so both paths produce identical install state. Do NOT add
  // dynamic substitutions here — the first `roadmap_refresh` routine
  // populates `Last synced:` with a real date.
  //
  // Invariant checked by `skeleton.test.ts`: these strings match
  // `agent-assets/templates/today.md` and `agent-assets/templates/roadmap.md`
  // byte-for-byte.
  for (const [rel, content] of Object.entries(FALLBACK_PLACEHOLDERS)) {
    const full = join(contextDir, rel);
    if (!existsSync(full)) {
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content, "utf-8");
    }
  }

  // Profile-interview queue Layer 1 — only when the file was just
  // created in this call. Errors are contained: a seed failure must
  // not break skeleton materialization (the queue can still be ticked
  // by Layer 4 on the next sweep). The function itself is a no-op when
  // the queue file is absent, but the existed-before gate also blocks
  // a no-op write that would still touch the file's mtime.
  if (!profileQueueExistedBefore && existsSync(profileQueuePath)) {
    try {
      const seedResult = preTickProfileQuestions(contextDir);
      if (seedResult.examined > 0) {
        logger.info(
          { contextDir, ...seedResult },
          "profile-interview queue seeded (Layer 1 pre-tick)",
        );
      }
      /* c8 ignore start — preTickProfileQuestions only throws on a
         race between existsSync and readFileSync (the queue file is
         removed mid-call), which cannot be reproduced without a
         filesystem mock. The catch keeps skeleton seeding resilient
         and is intentionally non-fatal. */
    } catch (err) {
      logger.error(
        { err, contextDir },
        "profile-interview queue Layer 1 pre-tick failed; queue left in unticked state",
      );
    }
    /* c8 ignore stop */
  }
}

/**
 * Recursively copy `srcDir` into `destDir`, preserving any destination
 * files that already exist. Directories are `mkdir -p`ed so the walk
 * survives a partial target. `README.md` at the top level is skipped —
 * it documents the templates tree in the repo, not runtime content.
 */
export function copyTreePreservingExisting(
  srcDir: string,
  destDir: string,
  options: EnsureSkeletonFilesOptions = {},
  relativeDir = "",
): void {
  for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
    const src = join(srcDir, entry.name);
    const dest = join(destDir, entry.name);
    const relativePath = relativeDir.length > 0
      ? `${relativeDir}/${entry.name}`
      : entry.name;
    if (entry.name === "README.md") continue;
    if (
      options.skipManagementRules
      && relativePath === CONTEXT_RELATIVE_PATHS.rules.management
    ) {
      continue;
    }
    if (entry.isDirectory()) {
      mkdirSync(dest, { recursive: true });
      copyTreePreservingExisting(src, dest, options, relativePath);
    } else if (entry.isFile()) {
      if (!existsSync(dest)) {
        mkdirSync(dirname(dest), { recursive: true });
        copyFileSync(src, dest);
      }
    }
  }
}
