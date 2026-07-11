/**
 * Real-git tests for `!rollback` (dev-rollback.ts): whole-session restore
 * (checkout + WIP re-apply, session branch kept) and iteration rewind
 * (tip archived, hard reset, docs snapshot restored, journal superseded).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySchema } from "../../db/schema.js";
import {
  approveDevSession,
  createDevSession,
  getDevSession,
  listDevIterations,
  listDevRequirements,
  markDevAwaitingApproval,
  markDevTerminal,
  recordDevIteration,
  seedDevRequirements,
  writeDevCheckpoint,
} from "../../db/dev-sessions-store.js";
import { insertDevTasks } from "../../db/dev-session-tasks-store.js";
import {
  DEV_DOCS,
  ensureDevWorkdir,
  gitCommitAll,
  gitCreateBranch,
  gitHead,
  snapshotDevDocs,
  writeDevDoc,
} from "./dev-loop-docs.js";
import { rollbackToIteration, rollbackWholeSession } from "./dev-rollback.js";

const T0 = 1_700_000_000_000;

function git(repo: string, args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
}

describe("dev-rollback", () => {
  let repo: string;
  let db: Database.Database;
  let idn = 0;
  const now = (): number => T0 + 1;
  const uuid = (): string => `rb-${idn++}`;

  beforeEach(() => {
    idn = 0;
    repo = mkdtempSync(join(tmpdir(), "dev-rollback-"));
    git(repo, ["init", "-q"]);
    git(repo, ["checkout", "-q", "-B", "main"]);
    writeFileSync(join(repo, "app.ts"), "export const v = 0;\n");
    ensureDevWorkdir(repo); // also writes .gitignore (tracked)
    gitCommitAll(repo, "seed");

    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applySchema(db);
    db.prepare(
      `INSERT INTO repositories (id, local_path, local_only, created_at, updated_at) VALUES ('local:t', ?, 1, 0, 0)`,
    ).run(repo);
    createDevSession(db, {
      id: "s1",
      repositoryId: "local:t",
      slug: "t",
      originatingPlatform: "telegram",
      originatingChannel: "telegram:D1",
      createdAt: T0,
    });
    markDevAwaitingApproval(db, "s1", T0);
  });

  afterEach(() => {
    db.close();
    rmSync(repo, { recursive: true, force: true });
  });

  /** Mirror startFromApproval's git dance: capture anchors, switch onto the
   *  session branch, snapshot (sweeping any dirty WIP). */
  function approveOnBranch(): { originalHead: string; wipSnapshotRef: string | null } {
    const originalHead = gitHead(repo)!;
    gitCreateBranch(repo, "aitne-dev/s1");
    gitCommitAll(repo, "dev: baseline snapshot (pre-loop)");
    const post = gitHead(repo)!;
    const wipSnapshotRef = post !== originalHead ? post : null;
    approveDevSession(db, {
      id: "s1",
      approvedHash: "h1",
      branch: "aitne-dev/s1",
      baseRef: post,
      originalBranch: "main",
      originalHead,
      wipSnapshotRef,
      maxIterations: 10,
      maxBudgetUsd: null,
      approvedAt: T0,
    });
    return { originalHead, wipSnapshotRef };
  }

  it("whole-session: restores the original checkout AND the swept-in WIP", () => {
    writeFileSync(join(repo, "wip.txt"), "owner wip\n"); // dirty at approve
    const { wipSnapshotRef } = approveOnBranch();
    expect(wipSnapshotRef).not.toBeNull();
    // The loop worked: two iteration commits on the session branch.
    writeFileSync(join(repo, "app.ts"), "export const v = 1;\n");
    gitCommitAll(repo, "dev: iter 1 — CONTINUE");
    markDevTerminal(db, { id: "s1", state: "failed", loopState: "BLOCKED", exitedAt: T0 });

    const session = getDevSession(db, "s1")!;
    const result = rollbackWholeSession(db, session, repo, now, uuid);
    expect(result).toMatchObject({
      ok: true,
      mode: "session",
      restoredBranch: "main",
      recreatedBranch: false,
      wipRestored: true,
      keptBranch: "aitne-dev/s1",
    });
    // Back on main, pre-session content, WIP re-applied UNCOMMITTED.
    expect(git(repo, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("main");
    expect(readFileSync(join(repo, "app.ts"), "utf8")).toBe("export const v = 0;\n");
    expect(readFileSync(join(repo, "wip.txt"), "utf8")).toBe("owner wip\n");
    expect(git(repo, ["status", "--porcelain"])).toContain("wip.txt");
    // The session branch (with all loop work) survives.
    expect(git(repo, ["rev-parse", "--verify", "refs/heads/aitne-dev/s1"])).toBeTruthy();
    // Bookkeeping: rolled_back_at + a journal row.
    expect(getDevSession(db, "s1")!.rolledBackAt).not.toBeNull();
    expect(listDevIterations(db, "s1").some((i) => i.phase === "rollback" && i.verdict === "SESSION")).toBe(true);
  });

  it("whole-session: clean-at-approve needs no WIP re-apply", () => {
    approveOnBranch();
    markDevTerminal(db, { id: "s1", state: "exited", loopState: null, exitedAt: T0 });
    const result = rollbackWholeSession(db, getDevSession(db, "s1")!, repo, now, uuid);
    expect(result).toMatchObject({ ok: true, wipRestored: false, wipNote: null });
    expect(git(repo, ["status", "--porcelain"])).toBe("");
  });

  it("whole-session: recreates a deleted original branch at the recorded head", () => {
    const { originalHead } = approveOnBranch();
    git(repo, ["branch", "-D", "main"]);
    markDevTerminal(db, { id: "s1", state: "exited", loopState: null, exitedAt: T0 });
    const result = rollbackWholeSession(db, getDevSession(db, "s1")!, repo, now, uuid);
    expect(result).toMatchObject({ ok: true, restoredBranch: "main", recreatedBranch: true });
    expect(git(repo, ["rev-parse", "HEAD"])).toBe(originalHead);
  });

  it("whole-session: refuses on a dirty tree and on missing anchors", () => {
    approveOnBranch();
    markDevTerminal(db, { id: "s1", state: "exited", loopState: null, exitedAt: T0 });
    // Tracked edit → refuse.
    writeFileSync(join(repo, "app.ts"), "export const v = 99;\n");
    const dirty = rollbackWholeSession(db, getDevSession(db, "s1")!, repo, now, uuid);
    expect(dirty).toMatchObject({ ok: false });
    git(repo, ["checkout", "--", "app.ts"]);
    // Pre-0029 session (no anchors) → refuse with the manual hint.
    const legacy = { ...getDevSession(db, "s1")!, originalBranch: null, originalHead: null };
    const refused = rollbackWholeSession(db, legacy, repo, now, uuid);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.reason).toContain("predates rollback support");
  });

  it("iteration: archives the tip, resets, restores docs, supersedes the journal", () => {
    approveOnBranch();
    seedDevRequirements(db, "s1", [{ id: "r1", reqId: "REQ-001", title: "a" }], T0);

    const mkIter = (n: number, content: string, ledgerStatus: string): string => {
      writeFileSync(join(repo, "app.ts"), content);
      writeDevDoc(repo, DEV_DOCS.ledger, `| REQ-001 | ${ledgerStatus} | ev | ${n} |`);
      writeDevDoc(repo, DEV_DOCS.progress, `iter ${n}\n`);
      const sha = gitCommitAll(repo, `dev: iter ${n} — CONTINUE`)!;
      snapshotDevDocs(repo, n);
      recordDevIteration(db, {
        id: `i${n}`, sessionId: "s1", iteration: n, phase: "evaluate",
        verdict: "CONTINUE", commitSha: sha, createdAt: T0 + n,
      });
      return sha;
    };
    const sha1 = mkIter(1, "export const v = 1;\n", "in-progress");
    const sha2 = mkIter(2, "export const v = 2;\n", "in-progress");
    const sha3 = mkIter(3, "export const v = 3;\n", "met");
    writeDevCheckpoint(db, { id: "s1", iteration: 3, agentFailures: 1, gateReviseCount: 1, iterReviseCount: 1, resumes: 2 }, T0);
    markDevTerminal(db, { id: "s1", state: "failed", loopState: "STALLED", exitedAt: T0 });

    const result = rollbackToIteration(db, getDevSession(db, "s1")!, repo, 2, now, uuid);
    expect(result).toMatchObject({
      ok: true,
      mode: "iteration",
      iteration: 2,
      commitSha: sha2,
      archivedBranch: "aitne-dev/s1-rollback-1",
      docsRestored: true,
    });
    // Code reset to iter 2; the tip (iter 3) survives on the archive branch.
    expect(gitHead(repo)).toBe(sha2);
    expect(readFileSync(join(repo, "app.ts"), "utf8")).toBe("export const v = 2;\n");
    expect(git(repo, ["rev-parse", "refs/heads/aitne-dev/s1-rollback-1"])).toBe(sha3);
    // Docs restored to the iter-2 snapshot.
    expect(readFileSync(join(repo, ".aitne-dev", DEV_DOCS.progress), "utf8")).toBe("iter 2\n");
    // Journal: iter-3 rows superseded (kept); counters back to 2; ledger
    // re-synced from the RESTORED markdown (met → in_progress).
    const rows = listDevIterations(db, "s1");
    expect(rows.find((r) => r.id === "i3")?.superseded).toBe(true);
    expect(rows.find((r) => r.id === "i2")?.superseded).toBe(false);
    const session = getDevSession(db, "s1")!;
    expect(session.iteration).toBe(2);
    expect(session.agentFailures).toBe(0);
    expect(session.resumes).toBe(2); // resume counter persists
    expect(listDevRequirements(db, "s1")[0]?.status).toBe("in_progress");
    // A second rollback probes a fresh archive name.
    const again = rollbackToIteration(db, getDevSession(db, "s1")!, repo, 1, now, uuid);
    expect(again).toMatchObject({ ok: true, archivedBranch: "aitne-dev/s1-rollback-2", commitSha: sha1 });
  });

  it("iteration: refuses fleets, off-branch checkouts, and unknown iterations", () => {
    approveOnBranch();
    markDevTerminal(db, { id: "s1", state: "failed", loopState: "BLOCKED", exitedAt: T0 });
    // No evaluate commit recorded.
    const missing = rollbackToIteration(db, getDevSession(db, "s1")!, repo, 5, now, uuid);
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.reason).toContain("iteration 5");
    // Fleet session → refuse.
    insertDevTasks(db, "s1", [{
      id: "t1", taskKey: "a", summary: "a", dependsOn: [], scope: "", reqs: [], body: "x", origin: "plan",
    }], T0);
    const fleet = rollbackToIteration(db, getDevSession(db, "s1")!, repo, 1, now, uuid);
    expect(fleet.ok).toBe(false);
    if (!fleet.ok) expect(fleet.reason).toContain("task fleet");
    db.prepare(`DELETE FROM dev_session_tasks WHERE id='t1'`).run();
    // Off-branch checkout → refuse.
    git(repo, ["checkout", "-q", "main"]);
    const offBranch = rollbackToIteration(db, getDevSession(db, "s1")!, repo, 1, now, uuid);
    expect(offBranch.ok).toBe(false);
    if (!offBranch.ok) expect(offBranch.reason).toContain("check it out first");
    // The docs-restored=false path: an evaluate row exists but no snapshot.
    git(repo, ["checkout", "-q", "aitne-dev/s1"]);
    writeFileSync(join(repo, "app.ts"), "export const v = 1;\n");
    const sha1 = gitCommitAll(repo, "dev: iter 1 — CONTINUE")!;
    recordDevIteration(db, {
      id: "i1", sessionId: "s1", iteration: 1, phase: "evaluate",
      verdict: "CONTINUE", commitSha: sha1, createdAt: T0 + 1,
    });
    writeFileSync(join(repo, "app.ts"), "export const v = 2;\n");
    gitCommitAll(repo, "dev: iter 2 — CONTINUE");
    const noDocs = rollbackToIteration(db, getDevSession(db, "s1")!, repo, 1, now, uuid);
    expect(noDocs).toMatchObject({ ok: true, docsRestored: false });
    expect(existsSync(join(repo, ".aitne-dev", "history"))).toBe(false);
  });
});
