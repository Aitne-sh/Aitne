import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  worktreeRootFor,
  gitWorktreeAdd,
  gitWorktreeRemove,
  gitBranchExists,
  gitRenameBranch,
  gitMergeNoFF,
  gitMergeInProgress,
  hasUncommittedTracked,
  seedMergeFromBranch,
  runSetupCommand,
} from "./dev-flow-git.js";

function git(repo: string, args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
}

function commitAll(repo: string, message: string): string {
  git(repo, ["add", "-A"]);
  git(repo, ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", message]);
  return git(repo, ["rev-parse", "HEAD"]);
}

const cleanup: string[] = [];

/** Throwaway temp repo (NOT the project repo) on branch main with one commit.
 *  Its sibling -aitne-worktrees dir is registered for cleanup too. */
function makeRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "dev-flow-git-"));
  cleanup.push(repo, `${repo}-aitne-worktrees`);
  git(repo, ["init", "-q"]);
  git(repo, ["checkout", "-q", "-B", "main"]);
  git(repo, ["config", "user.email", "t@t"]);
  git(repo, ["config", "user.name", "t"]);
  writeFileSync(join(repo, "README.md"), "seed\n");
  commitAll(repo, "seed");
  return repo;
}

/** Create a branch with one extra commit via a throwaway worktree, then drop
 *  the worktree so only the branch remains. */
function makeBranchWithCommit(
  repo: string,
  branch: string,
  file: string,
  content: string,
): string {
  const wt = join(`${repo}-aitne-worktrees`, `mk-${branch.replace(/\//g, "-")}`);
  gitWorktreeAdd(repo, wt, branch, "HEAD");
  writeFileSync(join(wt, file), content);
  const sha = commitAll(wt, `work on ${branch}`);
  gitWorktreeRemove(repo, wt);
  return sha;
}

afterEach(() => {
  for (const d of cleanup.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("dev-flow-git", () => {
  it("worktreeRootFor: sibling-dir shape <parent>/<basename>-aitne-worktrees/<sessionId>", () => {
    expect(worktreeRootFor("/x/y/repo", "s1")).toBe(
      join("/x/y", "repo-aitne-worktrees", "s1"),
    );
    // Trailing slash normalizes to the same place.
    expect(worktreeRootFor("/x/y/repo/", "s1")).toBe(worktreeRootFor("/x/y/repo", "s1"));
  });

  it("gitWorktreeAdd: checked-out worktree on a new branch at baseRef; second add throws", () => {
    const repo = makeRepo();
    const base = git(repo, ["rev-parse", "HEAD"]);
    const wt = worktreeRootFor(repo, "s1");

    gitWorktreeAdd(repo, wt, "aitne-dev/s1-t1", base);
    expect(existsSync(join(wt, "README.md"))).toBe(true);
    expect(git(wt, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("aitne-dev/s1-t1");
    expect(git(wt, ["rev-parse", "HEAD"])).toBe(base);
    expect(gitBranchExists(repo, "aitne-dev/s1-t1")).toBe(true);
    expect(gitBranchExists(repo, "aitne-dev/s1-t2")).toBe(false);

    // Same path again (even with a fresh branch name) must throw.
    expect(() => gitWorktreeAdd(repo, wt, "aitne-dev/s1-t1b", base)).toThrow();
  });

  it("gitWorktreeRemove: removes + prunes; repeat call is a no-op (never throws)", () => {
    const repo = makeRepo();
    const wt = worktreeRootFor(repo, "s1");
    gitWorktreeAdd(repo, wt, "aitne-dev/s1-t1", "HEAD");

    gitWorktreeRemove(repo, wt);
    expect(existsSync(wt)).toBe(false);
    expect(git(repo, ["worktree", "list", "--porcelain"])).not.toContain(wt);

    // Already gone → the fallback path; still never throws.
    expect(() => gitWorktreeRemove(repo, wt)).not.toThrow();
    // The branch survives removal (only the checkout is gone) — the same
    // path/branch pair can be re-bootstrapped after a prune.
    expect(gitBranchExists(repo, "aitne-dev/s1-t1")).toBe(true);
  });

  it("gitMergeNoFF happy path: 2-parent merge commit with the Aitne identity, sha advances", () => {
    const repo = makeRepo();
    const wt = worktreeRootFor(repo, "s1");
    gitWorktreeAdd(repo, wt, "task-1", "HEAD");
    writeFileSync(join(wt, "feature.ts"), "export const x = 1;\n");
    commitAll(wt, "task work");

    const before = git(repo, ["rev-parse", "HEAD"]);
    const res = gitMergeNoFF(repo, "task-1", "dev-mode: merge task-1");
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unreachable");
    expect(res.noChanges).toBe(false);
    expect(res.sha).not.toBe(before);
    expect(git(repo, ["rev-parse", "HEAD"])).toBe(res.sha);
    // No-ff: a real merge commit with 2 parents.
    const parents = git(repo, ["rev-list", "--parents", "-1", "HEAD"]).split(/\s+/);
    expect(parents).toHaveLength(3); // self + 2 parents
    expect(parents).toContain(before);
    // Committed with the Aitne identity, message intact.
    expect(git(repo, ["log", "-1", "--format=%an <%ae>"])).toBe(
      "Aitne Dev Mode <dev-mode@aitne.local>",
    );
    expect(git(repo, ["log", "-1", "--format=%s"])).toBe("dev-mode: merge task-1");
    expect(existsSync(join(repo, "feature.ts"))).toBe(true);
    expect(gitMergeInProgress(repo)).toBe(false);
  });

  it("gitMergeNoFF no-changes: already-contained branch → noChanges, HEAD unchanged", () => {
    const repo = makeRepo();
    git(repo, ["branch", "task-2"]); // points at HEAD — nothing new to merge
    const before = git(repo, ["rev-parse", "HEAD"]);

    const res = gitMergeNoFF(repo, "task-2", "dev-mode: merge task-2");
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unreachable");
    expect(res.noChanges).toBe(true);
    expect(res.sha).toBe(before);
    expect(git(repo, ["rev-parse", "HEAD"])).toBe(before);
    expect(gitMergeInProgress(repo)).toBe(false);
  });

  it("gitMergeNoFF conflict: lists the file, refused:false, repo left clean", () => {
    const repo = makeRepo();
    makeBranchWithCommit(repo, "task-c", "README.md", "task version\n");
    writeFileSync(join(repo, "README.md"), "parent version\n");
    commitAll(repo, "parent edit");
    const before = git(repo, ["rev-parse", "HEAD"]);

    const res = gitMergeNoFF(repo, "task-c", "dev-mode: merge task-c");
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.conflicts).toContain("README.md");
    expect(res.refused).toBe(false);
    // The failure path leaves no merge state and no dirt behind.
    expect(gitMergeInProgress(repo)).toBe(false);
    expect(hasUncommittedTracked(repo)).toBe(false);
    expect(git(repo, ["rev-parse", "HEAD"])).toBe(before);
    expect(readFileSync(join(repo, "README.md"), "utf8")).toBe("parent version\n");
    // The task branch is kept for archiving/autopsy.
    expect(gitBranchExists(repo, "task-c")).toBe(true);
  });

  it("gitMergeNoFF refused: dirty tracked file blocks the merge from starting", () => {
    const repo = makeRepo();
    makeBranchWithCommit(repo, "task-r", "README.md", "task version\n");
    // Uncommitted TRACKED edit to the same file → git refuses to start.
    writeFileSync(join(repo, "README.md"), "mid-edit\n");

    const res = gitMergeNoFF(repo, "task-r", "dev-mode: merge task-r");
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.refused).toBe(true);
    expect(res.conflicts).toEqual([]);
    expect(gitMergeInProgress(repo)).toBe(false);
    // The human's mid-edit is untouched.
    expect(readFileSync(join(repo, "README.md"), "utf8")).toBe("mid-edit\n");
  });

  it("hasUncommittedTracked: tracked edits only — untracked files never block", () => {
    const repo = makeRepo();
    expect(hasUncommittedTracked(repo)).toBe(false);

    writeFileSync(join(repo, "untracked.txt"), "new\n");
    expect(hasUncommittedTracked(repo)).toBe(false);

    writeFileSync(join(repo, "README.md"), "edited\n");
    expect(hasUncommittedTracked(repo)).toBe(true);
  });

  it("seedMergeFromBranch: seeded — carryover commit lands in the fresh worktree", () => {
    const repo = makeRepo();
    makeBranchWithCommit(repo, "seed-b", "carry.ts", "export const carried = true;\n");

    const wt = worktreeRootFor(repo, "s2");
    gitWorktreeAdd(repo, wt, "task-fresh", "main");
    expect(seedMergeFromBranch(wt, "seed-b")).toBe("seeded");
    expect(existsSync(join(wt, "carry.ts"))).toBe(true);
    expect(git(wt, ["log", "-1", "--format=%an <%ae>"])).toBe(
      "Aitne Dev Mode <dev-mode@aitne.local>",
    );
    expect(git(wt, ["log", "-1", "--format=%s"])).toContain("carryover partial work from seed-b");
    expect(gitMergeInProgress(wt)).toBe(false);

    // A no-op merge (seed already contained) also counts as seeded.
    const head = git(wt, ["rev-parse", "HEAD"]);
    expect(seedMergeFromBranch(wt, "seed-b")).toBe("seeded");
    expect(git(wt, ["rev-parse", "HEAD"])).toBe(head);
  });

  it("seedMergeFromBranch: skipped_missing — nonexistent branch, worktree untouched", () => {
    const repo = makeRepo();
    const wt = worktreeRootFor(repo, "s3");
    gitWorktreeAdd(repo, wt, "task-m", "main");
    const head = git(wt, ["rev-parse", "HEAD"]);

    expect(seedMergeFromBranch(wt, "no-such-branch")).toBe("skipped_missing");
    expect(git(wt, ["rev-parse", "HEAD"])).toBe(head);
    expect(gitMergeInProgress(wt)).toBe(false);
  });

  it("seedMergeFromBranch: skipped_conflict — aborts, worktree left merge-free", () => {
    const repo = makeRepo();
    makeBranchWithCommit(repo, "seed-c", "README.md", "seed version\n");
    writeFileSync(join(repo, "README.md"), "parent version\n");
    commitAll(repo, "parent edit");

    const wt = worktreeRootFor(repo, "s4");
    gitWorktreeAdd(repo, wt, "task-x", "main");
    const head = git(wt, ["rev-parse", "HEAD"]);

    expect(seedMergeFromBranch(wt, "seed-c")).toBe("skipped_conflict");
    expect(gitMergeInProgress(wt)).toBe(false);
    expect(hasUncommittedTracked(wt)).toBe(false);
    expect(git(wt, ["rev-parse", "HEAD"])).toBe(head);
    expect(readFileSync(join(wt, "README.md"), "utf8")).toBe("parent version\n");
    // The carried work stays on the (archivable) seed branch.
    expect(gitBranchExists(repo, "seed-c")).toBe(true);
  });

  it("gitRenameBranch: archives a conflicted branch (old gone, new exists)", () => {
    const repo = makeRepo();
    git(repo, ["branch", "task-old"]);
    gitRenameBranch(repo, "task-old", "task-old-conflict-1");
    expect(gitBranchExists(repo, "task-old")).toBe(false);
    expect(gitBranchExists(repo, "task-old-conflict-1")).toBe(true);
  });

  it("runSetupCommand: captures exit code + combined output; timeout → 124", () => {
    const repo = makeRepo();

    const ok = runSetupCommand(repo, "echo installed", 5000);
    expect(ok.exitCode).toBe(0);
    expect(ok.output).toContain("installed");

    const fail = runSetupCommand(repo, "echo out && echo err 1>&2 && exit 3", 5000);
    expect(fail.exitCode).toBe(3);
    expect(fail.output).toContain("out");
    expect(fail.output).toContain("err");

    // Timeout/kill surfaces as a null status → exit 124 (runVerifyCommand shape).
    const timedOut = runSetupCommand(repo, "sleep 5", 300);
    expect(timedOut.exitCode).toBe(124);
  });
});
