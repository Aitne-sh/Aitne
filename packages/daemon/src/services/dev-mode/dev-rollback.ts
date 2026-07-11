/**
 * Development-mode rollback (`!rollback`) — the 巻き戻し half of the
 * in-place execution model (DEV_MODE_GIT_HARDENING Phase A). loop-kit has NO
 * rollback affordance (its checkpoint-commit trail is the only mechanism);
 * this is a novel, NEVER-DESTRUCTIVE design:
 *
 * - Whole-session (`!rollback`): restore the owner's pre-session checkout —
 *   check out original_branch (recreate at original_head if deleted; detach
 *   if the owner was detached), and re-apply the pre-session uncommitted WIP
 *   that the approval snapshot swept in (cherry-pick -n of wip_snapshot_ref,
 *   unstaged). The aitne-dev/<id> branch is KEPT untouched — no loop work is
 *   ever lost.
 * - Iteration (`!rollback <n>`, single-loop only): archive the current tip as
 *   aitne-dev/<id>-rollback-<k>, hard-reset the session branch to iteration
 *   n's checkpoint commit, restore the gitignored `.aitne-dev/docs` from the
 *   paired history/iter-<n>/ snapshot, supersede the later journal rows
 *   (kept — audit trail), reset the checkpoint counters to n, and re-sync
 *   the REQ ledger from the restored markdown.
 *
 * I/O-bound (git/fs/db); excluded from the coverage gate. The store lookups
 * it leans on (latestEvaluateCommitFor, supersedeDevIterationsAfter, …) have
 * covered peers in dev-sessions-store.test.ts.
 */

import { execFileSync } from "node:child_process";
import type Database from "better-sqlite3";

import { createLogger } from "../../logging.js";
import {
  latestEvaluateCommitFor,
  markDevSessionRolledBack,
  recordDevIteration,
  resetDevRequirementStatuses,
  supersedeDevIterationsAfter,
  updateDevRequirement,
  writeDevCheckpoint,
  type DevSessionRow,
} from "../../db/dev-sessions-store.js";
import { listDevTasks } from "../../db/dev-session-tasks-store.js";
import {
  DEV_DOCS,
  gitBranchAt,
  gitCurrentBranch,
  gitMergeInProgress,
  parseLedgerMarkdown,
  readDevDoc,
  restoreDevDocsSnapshot,
  validateBaseRef,
} from "./dev-loop-docs.js";
import { gitBranchExists, hasUncommittedTracked } from "./dev-flow-git.js";

const logger = createLogger("dev-rollback");

function git(repoPath: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: repoPath,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

export type DevRollbackResult =
  | {
      ok: true;
      mode: "session";
      /** Branch the checkout was restored to; null = detached at the
       *  recorded original head. */
      restoredBranch: string | null;
      /** The original branch was deleted mid-session and re-created at the
       *  recorded head. */
      recreatedBranch: boolean;
      /** Pre-session uncommitted WIP was re-applied to the working tree. */
      wipRestored: boolean;
      /** Set when the WIP could NOT be re-applied cleanly — where it lives. */
      wipNote: string | null;
      /** The untouched session branch holding all loop work. */
      keptBranch: string;
    }
  | {
      ok: true;
      mode: "iteration";
      iteration: number;
      commitSha: string;
      archivedBranch: string;
      /** False when the docs snapshot for iteration n was missing
       *  (pre-feature session) — the docs may describe a later state. */
      docsRestored: boolean;
    }
  | { ok: false; reason: string };

function commonRefusal(repoPath: string): string | null {
  if (gitMergeInProgress(repoPath)) {
    return "a git merge is in progress in the repository — resolve it (or run `git merge --abort`) first";
  }
  if (hasUncommittedTracked(repoPath)) {
    return "the repository has uncommitted local edits — commit (or stash) them first so the rollback can never sweep your work";
  }
  return null;
}

/** Restore the owner's pre-session checkout. The session branch is kept. */
export function rollbackWholeSession(
  db: Database.Database,
  session: DevSessionRow,
  repoPath: string,
  now: () => number,
  uuid: () => string,
): DevRollbackResult {
  const refusal = commonRefusal(repoPath);
  if (refusal) return { ok: false, reason: refusal };
  if (!session.branch) {
    return { ok: false, reason: "the session never created a branch — nothing to roll back" };
  }
  if (session.originalBranch === null && session.originalHead === null) {
    return {
      ok: false,
      reason:
        "this session predates rollback support (no recorded original checkout) — "
        + `the work is on branch ${session.branch}; restore manually`,
    };
  }

  // 1. Restore the checkout. NEVER move the owner's ref — a plain checkout
  //    when the branch exists; recreate at the recorded head only when it
  //    was deleted mid-session.
  let restoredBranch: string | null = null;
  let recreatedBranch = false;
  try {
    if (session.originalBranch) {
      if (gitBranchExists(repoPath, session.originalBranch)) {
        git(repoPath, ["checkout", session.originalBranch]);
      } else if (session.originalHead) {
        git(repoPath, ["checkout", "-B", session.originalBranch, session.originalHead]);
        recreatedBranch = true;
      } else {
        return {
          ok: false,
          reason: `the original branch '${session.originalBranch}' no longer exists and no head was recorded`,
        };
      }
      restoredBranch = session.originalBranch;
    } else {
      git(repoPath, ["checkout", "--detach", session.originalHead!]);
    }
  } catch (err) {
    return {
      ok: false,
      reason: `git checkout failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // 2. Re-apply the swept-in pre-session WIP as uncommitted changes.
  //    cherry-pick -n is a 3-way apply (handles deletes/renames) and is
  //    trivially abortable; against the unmoved original branch it is its
  //    own parent's diff, so it only conflicts when the owner moved the
  //    branch mid-session — exactly the case to surface loudly.
  let wipRestored = false;
  let wipNote: string | null = null;
  if (session.wipSnapshotRef) {
    try {
      git(repoPath, ["cherry-pick", "-n", session.wipSnapshotRef]);
      git(repoPath, ["reset", "-q"]);
      wipRestored = true;
    } catch {
      try {
        git(repoPath, ["cherry-pick", "--abort"]);
      } catch {
        try {
          git(repoPath, ["reset", "--merge"]);
        } catch {
          // best effort — the guards above ensured a clean tree going in
        }
      }
      wipNote =
        "your pre-session uncommitted changes couldn't be re-applied cleanly — "
        + `they are preserved as commit ${session.wipSnapshotRef.slice(0, 7)} on ${session.branch}`;
    }
  }

  markDevSessionRolledBack(db, { id: session.id, at: now() });
  recordDevIteration(db, {
    id: uuid(),
    sessionId: session.id,
    iteration: session.iteration,
    phase: "rollback",
    verdict: "SESSION",
    reason: `restored ${restoredBranch ?? "(detached)"}; work kept on ${session.branch}`,
    createdAt: now(),
  });
  logger.info(
    { sessionId: session.id, restoredBranch, recreatedBranch, wipRestored },
    "dev whole-session rollback",
  );
  return {
    ok: true,
    mode: "session",
    restoredBranch,
    recreatedBranch,
    wipRestored,
    wipNote,
    keptBranch: session.branch,
  };
}

/** Hard-reset the session branch to iteration n's checkpoint commit
 *  (single-loop only; the tip is archived first). */
export function rollbackToIteration(
  db: Database.Database,
  session: DevSessionRow,
  repoPath: string,
  n: number,
  now: () => number,
  uuid: () => string,
): DevRollbackResult {
  if (!session.branch) {
    return { ok: false, reason: "the session never created a branch — nothing to roll back" };
  }
  if (listDevTasks(db, session.id).length > 0) {
    return {
      ok: false,
      reason:
        "this session ran as a task fleet — per-iteration rollback is only "
        + "defined for single-loop sessions (use a bare !rollback to restore "
        + "your original checkout instead)",
    };
  }
  const refusal = commonRefusal(repoPath);
  if (refusal) return { ok: false, reason: refusal };
  if (gitCurrentBranch(repoPath) !== session.branch) {
    return {
      ok: false,
      reason: `the checkout is not on ${session.branch} — check it out first`,
    };
  }
  const sha = latestEvaluateCommitFor(db, session.id, n);
  if (!sha) {
    return { ok: false, reason: `no checkpoint commit is recorded for iteration ${n}` };
  }
  const check = validateBaseRef(repoPath, sha);
  if (check.degraded) {
    return {
      ok: false,
      reason: `iteration ${n}'s commit ${sha.slice(0, 7)} is no longer an ancestor of HEAD (already rolled back past it?)`,
    };
  }

  // Archive the tip under a probed-unique name, then reset. The archive makes
  // the reset non-destructive: every commit stays reachable by name.
  let archived = `${session.branch}-rollback-1`;
  for (let k = 2; gitBranchExists(repoPath, archived); k += 1) {
    archived = `${session.branch}-rollback-${k}`;
  }
  try {
    gitBranchAt(repoPath, archived, "HEAD");
    git(repoPath, ["reset", "--hard", sha]);
  } catch (err) {
    return {
      ok: false,
      reason: `git archive/reset failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const docsRestored = restoreDevDocsSnapshot(repoPath, n);

  // Journal: later rows become superseded (kept), counters return to n, and
  // the REQ ledger is re-synced from the restored markdown (absent rows stay
  // 'unstarted' — honest, the gate re-derives the truth from here).
  supersedeDevIterationsAfter(db, session.id, n);
  writeDevCheckpoint(
    db,
    {
      id: session.id,
      iteration: n,
      agentFailures: 0,
      gateReviseCount: 0,
      iterReviseCount: 0,
      resumes: session.resumes,
    },
    now(),
  );
  resetDevRequirementStatuses(db, session.id, now());
  if (docsRestored) {
    for (const row of parseLedgerMarkdown(readDevDoc(repoPath, DEV_DOCS.ledger))) {
      updateDevRequirement(db, {
        sessionId: session.id,
        reqId: row.reqId,
        status: row.status,
        evidence: row.evidence || null,
        iter: row.iter,
        updatedAt: now(),
      });
    }
  }
  recordDevIteration(db, {
    id: uuid(),
    sessionId: session.id,
    iteration: n,
    phase: "rollback",
    verdict: "ITERATION",
    reason: `reset to iter ${n}; tip archived as ${archived}`,
    commitSha: sha,
    createdAt: now(),
  });
  logger.info({ sessionId: session.id, n, sha, archived, docsRestored }, "dev iteration rollback");
  return { ok: true, mode: "iteration", iteration: n, commitSha: sha, archivedBranch: archived, docsRestored };
}
