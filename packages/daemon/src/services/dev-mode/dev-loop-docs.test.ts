/**
 * Real-git tests for the Phase-A safety helpers in dev-loop-docs.ts
 * (DEV_MODE_GIT_HARDENING): merge/branch guards, base-ref ancestry
 * validation, the gitCommitAll merge backstop, per-iteration docs snapshots,
 * and the baseline-verify log. Same real-temp-repo posture as
 * dev-flow-git.test.ts — git itself is exercised, never mocked.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEV_DOCS,
  checkRepoGuards,
  gitCommitAll,
  gitCreateBranch,
  gitCurrentBranch,
  gitHead,
  gitMergeInProgress,
  gitStatusDirty,
  restoreDevDocsSnapshot,
  snapshotDevDocs,
  validateBaseRef,
  writeBaselineVerifyLog,
} from "./dev-loop-docs.js";

function run(repo: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd: repo,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

describe("dev-loop-docs git safety helpers", () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "dev-loop-docs-"));
    run(repo, "init");
    run(repo, "checkout", "-B", "main");
    writeFileSync(join(repo, "f.txt"), "base\n");
    gitCommitAll(repo, "base");
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  /** Manufacture a REAL conflicted merge (both branches edit the same line)
   *  and leave it in progress (MERGE_HEAD present). */
  function startConflictedMerge(): void {
    gitCreateBranch(repo, "side");
    writeFileSync(join(repo, "f.txt"), "side\n");
    gitCommitAll(repo, "side edit");
    run(repo, "checkout", "main");
    writeFileSync(join(repo, "f.txt"), "main\n");
    gitCommitAll(repo, "main edit");
    expect(() => run(repo, "merge", "side")).toThrow();
    expect(gitMergeInProgress(repo)).toBe(true);
  }

  it("checkRepoGuards passes on a clean expected-branch checkout", () => {
    expect(checkRepoGuards(repo, "main")).toEqual({ ok: true });
    expect(checkRepoGuards(repo, null)).toEqual({ ok: true });
  });

  it("checkRepoGuards flags a moved checkout with a chat-ready question", () => {
    run(repo, "checkout", "-b", "feature/x");
    const guard = checkRepoGuards(repo, "main");
    expect(guard.ok).toBe(false);
    if (!guard.ok) {
      expect(guard.kind).toBe("branch_moved");
      expect(guard.currentBranch).toBe("feature/x");
      expect(guard.question).toContain("'feature/x'");
      expect(guard.question).toContain("git checkout main");
    }
  });

  it("checkRepoGuards reports a detached HEAD as such", () => {
    run(repo, "checkout", "--detach");
    const guard = checkRepoGuards(repo, "main");
    expect(guard.ok).toBe(false);
    if (!guard.ok) {
      expect(guard.kind).toBe("branch_moved");
      expect(guard.currentBranch).toBeNull();
      expect(guard.question).toContain("(detached HEAD)");
    }
  });

  it("checkRepoGuards flags an in-progress merge BEFORE the branch check", () => {
    startConflictedMerge();
    // Even on the expected branch, the merge guard wins.
    const guard = checkRepoGuards(repo, "main");
    expect(guard.ok).toBe(false);
    if (!guard.ok) {
      expect(guard.kind).toBe("merge_in_progress");
      expect(guard.question).toContain("merge --abort");
    }
    run(repo, "merge", "--abort");
    expect(checkRepoGuards(repo, "main")).toEqual({ ok: true });
  });

  it("gitCommitAll refuses to sweep a half-resolved merge (backstop)", () => {
    startConflictedMerge();
    expect(() => gitCommitAll(repo, "should not land")).toThrow(/merge is in progress/);
    run(repo, "merge", "--abort");
    // After the abort the helper works again.
    writeFileSync(join(repo, "g.txt"), "ok\n");
    expect(gitCommitAll(repo, "lands")).toBe(gitHead(repo));
  });

  it("validateBaseRef accepts a real ancestor and keeps it", () => {
    const base = gitHead(repo)!;
    writeFileSync(join(repo, "f.txt"), "more\n");
    gitCommitAll(repo, "more");
    expect(validateBaseRef(repo, base)).toEqual({ ref: base, degraded: false });
    // HEAD is its own ancestor.
    expect(validateBaseRef(repo, gitHead(repo))).toEqual({
      ref: gitHead(repo)!,
      degraded: false,
    });
  });

  it("validateBaseRef degrades a garbage / null / non-ancestor ref to HEAD", () => {
    expect(validateBaseRef(repo, "not-a-sha")).toEqual({
      ref: gitHead(repo)!,
      degraded: true,
    });
    expect(validateBaseRef(repo, null)).toEqual({
      ref: gitHead(repo)!,
      degraded: true,
    });
    // A commit on a side branch is NOT an ancestor of main's HEAD.
    gitCreateBranch(repo, "stray");
    writeFileSync(join(repo, "s.txt"), "stray\n");
    gitCommitAll(repo, "stray work");
    const straySha = gitHead(repo)!;
    run(repo, "checkout", "main");
    expect(validateBaseRef(repo, straySha)).toEqual({
      ref: gitHead(repo)!,
      degraded: true,
    });
  });

  it("gitStatusDirty sees tracked AND untracked changes", () => {
    expect(gitStatusDirty(repo)).toBe(false);
    writeFileSync(join(repo, "new.txt"), "untracked\n");
    expect(gitStatusDirty(repo)).toBe(true);
    gitCommitAll(repo, "sweep");
    expect(gitStatusDirty(repo)).toBe(false);
    writeFileSync(join(repo, "f.txt"), "edited\n");
    expect(gitStatusDirty(repo)).toBe(true);
  });

  it("docs snapshots round-trip the gitignored working memory", () => {
    const docs = join(repo, ".aitne-dev", "docs");
    mkdirSync(docs, { recursive: true });
    writeFileSync(join(docs, "progress.md"), "iter-1 state\n");
    snapshotDevDocs(repo, 1);
    writeFileSync(join(docs, "progress.md"), "iter-2 state\n");
    writeFileSync(join(docs, "extra.md"), "appeared later\n");
    snapshotDevDocs(repo, 2);

    expect(restoreDevDocsSnapshot(repo, 1)).toBe(true);
    expect(readFileSync(join(docs, "progress.md"), "utf8")).toBe("iter-1 state\n");
    // The restore replaces docs/ wholesale — later files do not leak back.
    expect(existsSync(join(docs, "extra.md"))).toBe(false);
    // The snapshot tree itself survives a restore (repeatable rollbacks).
    expect(restoreDevDocsSnapshot(repo, 2)).toBe(true);
    expect(readFileSync(join(docs, "extra.md"), "utf8")).toBe("appeared later\n");
    // Missing snapshot → false (pre-feature session).
    expect(restoreDevDocsSnapshot(repo, 9)).toBe(false);
  });

  it("snapshotDevDocs is a no-op without a docs dir and never copies history/", () => {
    const bare = mkdtempSync(join(tmpdir(), "dev-loop-docs-bare-"));
    try {
      snapshotDevDocs(bare, 1); // no .aitne-dev/docs — must not throw
      expect(existsSync(join(bare, ".aitne-dev"))).toBe(false);
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
    // history/ lives BESIDE docs/, so a snapshot never nests snapshots.
    const docs = join(repo, ".aitne-dev", "docs");
    mkdirSync(docs, { recursive: true });
    writeFileSync(join(docs, "a.md"), "x\n");
    snapshotDevDocs(repo, 1);
    snapshotDevDocs(repo, 2);
    expect(existsSync(join(repo, ".aitne-dev", "history", "iter-1", "a.md"))).toBe(true);
    expect(existsSync(join(repo, ".aitne-dev", "history", "iter-1", "history"))).toBe(false);
  });

  it("writeBaselineVerifyLog writes the [PASS]/[FAIL] grammar", () => {
    writeBaselineVerifyLog(repo, [
      { command: "true", passed: true, exitCode: 0, output: "" },
      { command: "npm test", passed: false, exitCode: 1, output: "3 failed" },
    ]);
    const body = readFileSync(
      join(repo, ".aitne-dev", DEV_DOCS.baselineVerify),
      "utf8",
    );
    expect(body).toContain("$ true");
    expect(body).toContain("[PASS]");
    expect(body).toContain("$ npm test");
    expect(body).toContain("[FAIL] (exit 1)");
  });

  it("gitCurrentBranch reads the checkout and null on detached HEAD", () => {
    expect(gitCurrentBranch(repo)).toBe("main");
    run(repo, "checkout", "--detach");
    expect(gitCurrentBranch(repo)).toBeNull();
  });
});
