/**
 * Development-mode git worktree + serialized-merge plumbing for the task
 * fleet: sibling-dir worktrees per session, no-ff merges of task branches
 * into the session branch, conflicted-branch archiving, and the
 * NEEDS_DECOMPOSITION seed carryover. This is the native port of loop-kit's
 * bin/loop.sh fleet git half — bootstrap_worktree (:1755), merge_task
 * (:2892) and bootstrap_seed_merge (:1716) — minus the parent-wins
 * .loop/docs strip, which is unnecessary here because .aitne-dev/ is
 * gitignored inside the registered repo (never tracked, never merged).
 *
 * I/O-bound (git + setup-command subprocesses); excluded from the coverage
 * gate. The PURE fleet sequencing that decides WHEN to call these lives in
 * the covered peers.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { gitMergeInProgress, runVerifyCommand, type VerifyRun } from "./dev-loop-docs.js";

// Canonical home moved to dev-loop-docs.ts (the single-loop side needs it for
// the commit backstop + checkRepoGuards); re-exported here for fleet callers.
export { gitMergeInProgress } from "./dev-loop-docs.js";

/** Sibling-dir suffix (loop-kit: `<parent>/<basename>-loops`). */
const WORKTREE_ROOT_SUFFIX = "-aitne-worktrees";

function git(repoPath: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: repoPath,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/** Merge/carryover commit with the Aitne identity — -c flags avoid depending
 *  on the user's git identity for automated commits (same as gitCommitAll in
 *  dev-loop-docs.ts). */
function gitCommitMerge(repoPath: string, message: string): void {
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Aitne Dev Mode",
      "-c",
      "user.email=dev-mode@aitne.local",
      "commit",
      "--no-verify",
      // A repo with commit.gpgsign=true but no key would otherwise make every
      // merge commit fail (→ refused → an un-capped defer loop). Dev mode never
      // signs its automated commits.
      "--no-gpg-sign",
      "-m",
      message,
    ],
    { cwd: repoPath, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
}

function gitHeadStrict(repoPath: string): string {
  return git(repoPath, ["rev-parse", "HEAD"]);
}

/** `git diff --cached --quiet` — true when the merge staged nothing. */
function stagedNothing(repoPath: string): boolean {
  try {
    git(repoPath, ["diff", "--cached", "--quiet"]);
    return true;
  } catch {
    return false;
  }
}

/** Unmerged (conflicted) paths of an in-progress merge. */
function unmergedPaths(repoPath: string): string[] {
  try {
    return git(repoPath, ["diff", "--name-only", "--diff-filter=U"])
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
  } catch {
    return [];
  }
}

/** loop-kit's `git merge --abort || git reset --hard HEAD` cleanup: never
 *  throws, and never leaves a MERGE_HEAD behind. The hard reset only fires
 *  when --abort failed WHILE a merge is actually stuck in progress. */
function abortMergeQuietly(repoPath: string): void {
  try {
    git(repoPath, ["merge", "--abort"]);
  } catch {
    try {
      if (gitMergeInProgress(repoPath)) git(repoPath, ["reset", "--hard", "HEAD"]);
    } catch {
      // best effort
    }
  }
}

// ── worktree lifecycle (bootstrap_worktree's git half) ──────────────────

/** Sibling-dir worktree root for a session:
 *  `<repoParent>/<repoBasename>-aitne-worktrees/<sessionId>` — outside the
 *  repo so task worktrees never pollute the registered tree (loop-kit
 *  WT_ROOT:1377). */
export function worktreeRootFor(repoPath: string, sessionId: string): string {
  const abs = resolve(repoPath);
  return join(dirname(abs), `${basename(abs)}${WORKTREE_ROOT_SUFFIX}`, sessionId);
}

/** `git worktree add <wtPath> -b <branch> <baseRef>` (creates parent dirs). */
export function gitWorktreeAdd(
  repoPath: string,
  wtPath: string,
  branch: string,
  baseRef: string,
): void {
  mkdirSync(dirname(wtPath), { recursive: true });
  git(repoPath, ["worktree", "add", wtPath, "-b", branch, baseRef]);
}

/** Best-effort: `git worktree remove --force <wtPath>`; then
 *  `git worktree prune`. Falls back to rm -rf of the dir + prune when git
 *  refuses (e.g. the dir is already gone or too dirty even for --force).
 *  Never throws. */
export function gitWorktreeRemove(repoPath: string, wtPath: string): void {
  try {
    git(repoPath, ["worktree", "remove", "--force", wtPath]);
  } catch {
    try {
      rmSync(wtPath, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
  try {
    git(repoPath, ["worktree", "prune"]);
  } catch {
    // best effort
  }
}

export function gitBranchExists(repoPath: string, branch: string): boolean {
  try {
    git(repoPath, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

/** `git branch -m <from> <to>` — archive a conflicted branch for autopsy
 *  (deleting it would lose the work; keeping the name would block the
 *  redo's `git worktree add -b`). */
export function gitRenameBranch(repoPath: string, from: string, to: string): void {
  git(repoPath, ["branch", "-m", from, to]);
}

// ── serialized no-ff merge (merge_task's git half) ──────────────────────

export type DevMergeResult =
  | { ok: true; sha: string; noChanges: boolean }
  | { ok: false; conflicts: string[]; refused: boolean };

/**
 * Serialized no-ff merge of a task branch into the CURRENT branch of
 * repoPath (the session branch) — the Refinery pattern, one landing at a
 * time. Port of merge_task's git half:
 *
 * 1. `git merge --no-ff --no-commit <branch>`; on failure collect the
 *    conflicts (`git diff --name-only --diff-filter=U`), abort the merge and
 *    return `{ ok: false, conflicts, refused: false }`. When the merge
 *    command refused to even start (e.g. local changes would be overwritten
 *    — no unmerged paths AND no MERGE_HEAD) it is `refused: true` with `[]`;
 *    the caller must not treat that as a content conflict.
 * 2. If the merge staged nothing → abort any MERGE_HEAD state and return
 *    `{ ok: true, sha: HEAD, noChanges: true }` (loop-kit "no changes to
 *    merge").
 * 3. Else commit with the Aitne identity + --no-verify. A commit failure
 *    (hook? signing?) must NOT fall through to "merged": the merge is
 *    aborted and reported as refused — same MERGE_FAILED bucket loop-kit
 *    uses, distinct from a content conflict.
 *
 * The failure path always leaves the repo without a MERGE_HEAD.
 */
export function gitMergeNoFF(
  repoPath: string,
  branch: string,
  message: string,
): DevMergeResult {
  let mergeFailed = false;
  try {
    git(repoPath, ["merge", "--no-ff", "--no-commit", branch]);
  } catch {
    mergeFailed = true;
  }

  if (mergeFailed) {
    const conflicts = unmergedPaths(repoPath);
    // Refused-vs-conflict discriminator: nothing unmerged AND no merge in
    // progress means git never started the merge (nothing was staged).
    const refused = conflicts.length === 0 && !gitMergeInProgress(repoPath);
    abortMergeQuietly(repoPath);
    return { ok: false, conflicts, refused };
  }

  if (stagedNothing(repoPath)) {
    abortMergeQuietly(repoPath);
    return { ok: true, sha: gitHeadStrict(repoPath), noChanges: true };
  }

  try {
    gitCommitMerge(repoPath, message);
  } catch {
    abortMergeQuietly(repoPath);
    return { ok: false, conflicts: [], refused: true };
  }
  return { ok: true, sha: gitHeadStrict(repoPath), noChanges: false };
}

/** Uncommitted changes to TRACKED files (`git status --porcelain -uno`
 *  non-empty) — the merge-defer guard: uncommitted tracked changes mean a
 *  human is mid-edit, never merge over them. Untracked files do NOT block a
 *  merge (git itself refuses if one is in the way). */
export function hasUncommittedTracked(repoPath: string): boolean {
  try {
    return git(repoPath, ["status", "--porcelain", "-uno"]).length > 0;
  } catch {
    return false;
  }
}

// ── seed carryover (bootstrap_seed_merge) ───────────────────────────────

export type DevSeedMergeResult = "seeded" | "skipped_conflict" | "skipped_missing";

/**
 * Port of bootstrap_seed_merge: inside a FRESH task worktree, merge the
 * escalated predecessor's committed branch so the carried work survives a
 * NEEDS_DECOMPOSITION split. The worktree branches from merged HEAD as
 * always and the seed tip is merged IN, so sibling work merged in the
 * meantime is kept. NEVER fails the bootstrap:
 *
 * - Branch missing → "skipped_missing".
 * - Merge (or carryover commit) conflict/failure → abort, "skipped_conflict"
 *   — the work then still lives on the archived seed branch, never merged
 *   ungated.
 * - Success → "seeded" (a no-op merge — seed already contained — counts).
 */
export function seedMergeFromBranch(wtPath: string, seedBranch: string): DevSeedMergeResult {
  if (!gitBranchExists(wtPath, seedBranch)) return "skipped_missing";

  try {
    git(wtPath, ["merge", "--no-ff", "--no-commit", seedBranch]);
  } catch {
    abortMergeQuietly(wtPath);
    return "skipped_conflict";
  }

  if (stagedNothing(wtPath)) {
    abortMergeQuietly(wtPath);
    return "seeded";
  }

  try {
    gitCommitMerge(wtPath, `dev-mode: carryover partial work from ${seedBranch}`);
  } catch {
    abortMergeQuietly(wtPath);
    return "skipped_conflict";
  }
  return "seeded";
}

// ── worktree setup command (bootstrap_worktree's env prep hook) ─────────

/** Run flow.worktreeSetupCommand (e.g. "pnpm install") in a fresh worktree
 *  via /bin/sh -c, capturing combined output + exit code — the exact
 *  runVerifyCommand shape (timeout/kill surfaces as exit 124). ⚠️ Runs
 *  unsandboxed with the daemon's privileges, same honest gap as the verify
 *  runner. */
export function runSetupCommand(wtPath: string, command: string, timeoutMs: number): VerifyRun {
  return runVerifyCommand(wtPath, command, timeoutMs);
}
