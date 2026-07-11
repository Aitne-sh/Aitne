import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MessageEvent } from "@aitne/shared";
import { applySchema } from "../../db/schema.js";
import type { AgentConfig } from "../../config.js";
import type { IAuditLogger } from "../dispatcher.js";
import {
  approveDevSession,
  createDevSession,
  getActiveDevSession,
  getDevSession,
  markDevAwaitingApproval,
  markDevTerminal,
} from "../../db/dev-sessions-store.js";
import { createDefaultBangCommandRegistry } from "./index.js";
import {
  repoCommand,
  approveCommand,
  addCommand,
  exitCommand,
  parseResumeArgs,
  resumeCommand,
  rollbackCommand,
} from "./commands-dev.js";
import { insertDevTasks, listDevTasks } from "../../db/dev-session-tasks-store.js";
import type { BangCommandContext } from "./registry.js";
import type { DevModeRunner } from "../../services/dev-mode/dev-mode-runner.js";

function makeAudit(): IAuditLogger {
  return {
    logAction: vi.fn(),
    logSkip: vi.fn(),
    logError: vi.fn(),
    logAttachment: vi.fn(),
    logBangCommand: vi.fn(),
    insertInProgressRow: vi.fn(() => -1),
  } as unknown as IAuditLogger;
}

function makeEvent(): MessageEvent {
  return {
    type: "message.received",
    source: "telegram",
    priority: 1 as MessageEvent["priority"],
    timestamp: new Date(),
    data: {},
    correlationId: "corr",
    sender: "owner",
    channel: "D1",
    content: "!repo foo",
    platform: "telegram",
    threadId: null,
    isDm: true,
    isMention: false,
  };
}

function fakeRunner(): { runner: DevModeRunner; calls: Record<string, unknown[]> } {
  const calls: Record<string, unknown[]> = {
    armTimeout: [], startFromApproval: [], cancel: [], resumeSession: [],
  };
  const runner = {
    armTimeout: vi.fn((id: string) => calls.armTimeout!.push(id)),
    startFromApproval: vi.fn((id: string) => {
      calls.startFromApproval!.push(id);
      return { ok: true, branch: `aitne-dev/${id}`, reqCount: 2 };
    }),
    cancel: vi.fn(async (id: string, reason: string) => {
      calls.cancel!.push([id, reason]);
      return true;
    }),
    resumeSession: vi.fn(async (input: unknown) => {
      calls.resumeSession!.push(input);
      return { ok: true };
    }),
    hasLiveOrchestrator: vi.fn(() => false),
    notifyTaskQueued: vi.fn(),
    resumeAfterEscalation: vi.fn(),
    resumeFromBoot: vi.fn(),
    expireForTimeout: vi.fn(),
    cancelTimeout: vi.fn(),
    retimeTimeout: vi.fn(),
    isRunning: vi.fn(() => false),
    runInterviewTurn: vi.fn(),
  } as unknown as DevModeRunner;
  return { runner, calls };
}

describe("commands-dev", () => {
  let db: Database.Database;
  let repo: string;
  let runner: DevModeRunner;
  let calls: Record<string, unknown[]>;
  let beganDevMode: unknown[];

  function makeCtx(overrides: Partial<BangCommandContext> = {}): {
    ctx: BangCommandContext;
    notify: ReturnType<typeof vi.fn>;
  } {
    const notify = vi.fn().mockResolvedValue(undefined);
    const ctx = {
      event: makeEvent(),
      db,
      config: { timezone: "UTC" } as AgentConfig,
      notify,
      audit: makeAudit(),
      registry: createDefaultBangCommandRegistry(),
      getDevModeRunner: () => runner,
      beginDevMode: (state: unknown) => beganDevMode.push(state),
      ...overrides,
    } as unknown as BangCommandContext;
    return { ctx, notify };
  }

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "dev-cmd-"));
    execFileSync("git", ["init", "-q"], { cwd: repo });
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applySchema(db);
    db.prepare(
      `INSERT INTO repositories (id, local_path, local_only, created_at, updated_at) VALUES ('local:foo', ?, 1, 0, 0)`,
    ).run(repo);
    const seeded = fakeRunner();
    runner = seeded.runner;
    calls = seeded.calls;
    beganDevMode = [];
  });

  afterEach(() => {
    db.close();
    rmSync(repo, { recursive: true, force: true });
  });

  it("!repo is a prefix command that parses the name", () => {
    const r = createDefaultBangCommandRegistry();
    const m = r.resolve("!repo foo");
    expect(m?.kind).toBe("prefix");
    expect(m?.rest).toBe("foo");
    expect(exitCommand.runsWhilePaused).toBe(true);
    expect(approveCommand.runsWhilePaused).toBe(true);
    expect(repoCommand.runsWhilePaused).toBe(true);
    // parseArgs trims the raw remainder into the repo name.
    const { ctx } = makeCtx();
    expect(repoCommand.parseArgs?.("  my-repo  ", ctx)).toBe("my-repo");
  });

  it("!repo enters dev mode for a resolvable git repo", async () => {
    const { ctx, notify } = makeCtx();
    // Resolve by slug 'foo' (deriveSlug from local path basename won't be 'foo',
    // so seed by id form). The event content already carries the arg via parseArgs.
    await repoCommand.handler(ctx, "local:foo");
    const active = getActiveDevSession(db);
    expect(active).not.toBeNull();
    expect(active!.state).toBe("interview");
    expect(beganDevMode).toHaveLength(1);
    expect(calls.armTimeout).toHaveLength(1);
    expect(notify.mock.calls[0]?.[0]).toContain("Dev mode on");
  });

  it("!repo refuses a second session (singleton D5)", async () => {
    createDevSession(db, {
      id: "existing",
      repositoryId: "local:foo",
      slug: "foo",
      originatingPlatform: "telegram",
      originatingChannel: "telegram:D1",
      createdAt: 0,
    });
    const { ctx, notify } = makeCtx();
    await repoCommand.handler(ctx, "local:foo");
    expect(notify.mock.calls[0]?.[0]).toContain("Already in dev mode");
    // No second session created.
    expect(getDevSession(db, "existing")).not.toBeNull();
  });

  it("!repo rejects an unknown repo", async () => {
    const { ctx, notify } = makeCtx();
    await repoCommand.handler(ctx, "does-not-exist");
    expect(notify.mock.calls[0]?.[0]).toContain("No repository matches");
    expect(getActiveDevSession(db)).toBeNull();
  });

  it("!repo with no name shows usage", async () => {
    const { ctx, notify } = makeCtx();
    await repoCommand.handler(ctx, "   ");
    expect(notify.mock.calls[0]?.[0]).toContain("Usage: !repo");
  });

  it("!repo with non-string args shows usage", async () => {
    const { ctx, notify } = makeCtx();
    await repoCommand.handler(ctx, undefined);
    expect(notify.mock.calls[0]?.[0]).toContain("Usage: !repo");
  });

  it("!repo singleton reject falls back to repositoryId when slug is null", async () => {
    createDevSession(db, {
      id: "existing",
      repositoryId: "local:foo",
      slug: null,
      originatingPlatform: "telegram",
      originatingChannel: "telegram:D1",
      createdAt: 0,
    });
    const { ctx, notify } = makeCtx();
    await repoCommand.handler(ctx, "local:foo");
    expect(notify.mock.calls[0]?.[0]).toContain("local:foo");
  });

  it("!repo resolves by slug / display name (not just id)", async () => {
    const repo2 = mkdtempSync(join(tmpdir(), "dev-cmd2-"));
    execFileSync("git", ["init", "-q"], { cwd: repo2 });
    db.prepare(
      `INSERT INTO repositories (id, local_path, local_only, display_name, created_at, updated_at) VALUES ('local:bar', ?, 1, 'My Bar', 0, 0)`,
    ).run(repo2);
    const { ctx } = makeCtx();
    await repoCommand.handler(ctx, "my bar"); // case-insensitive display-name match
    const active = getActiveDevSession(db);
    expect(active?.repositoryId).toBe("local:bar");
    rmSync(repo2, { recursive: true, force: true });
  });

  it("!repo rejects a repo with no local worktree", async () => {
    // A GitHub-only repo (satisfies the has-github-or-local CHECK) with no
    // local_path exercises the "no local worktree" branch.
    db.prepare(
      `INSERT INTO repositories (id, github_owner, github_repo, local_only, created_at, updated_at) VALUES ('gh:o/r', 'o', 'r', 0, 0, 0)`,
    ).run();
    const { ctx, notify } = makeCtx();
    await repoCommand.handler(ctx, "github:o/r");
    expect(notify.mock.calls[0]?.[0]).toContain("no local worktree");
    expect(getActiveDevSession(db)).toBeNull();
  });

  it("!repo rejects a local path that isn't a git worktree", async () => {
    const nonGit = mkdtempSync(join(tmpdir(), "dev-nongit-"));
    db.prepare(
      `INSERT INTO repositories (id, local_path, local_only, created_at, updated_at) VALUES ('local:nongit', ?, 1, 0, 0)`,
    ).run(nonGit);
    const { ctx, notify } = makeCtx();
    await repoCommand.handler(ctx, "local:nongit");
    expect(notify.mock.calls[0]?.[0]).toContain("git worktree");
    expect(getActiveDevSession(db)).toBeNull();
    rmSync(nonGit, { recursive: true, force: true });
  });

  it("!approve on a running session reports its state", async () => {
    createDevSession(db, {
      id: "s1",
      repositoryId: "local:foo",
      slug: "foo",
      originatingPlatform: "telegram",
      originatingChannel: "telegram:D1",
      createdAt: 0,
    });
    db.prepare(`UPDATE dev_sessions SET state = 'running' WHERE id = 's1'`).run();
    const { ctx, notify } = makeCtx();
    await approveCommand.handler(ctx);
    expect(notify.mock.calls[0]?.[0]).toContain("running");
    expect(calls.startFromApproval).toHaveLength(0);
  });

  it("!approve with no session says so", async () => {
    const { ctx, notify } = makeCtx();
    await approveCommand.handler(ctx);
    expect(notify.mock.calls[0]?.[0]).toContain("No dev session");
  });

  it("!approve reports a failed start", async () => {
    createDevSession(db, {
      id: "s1",
      repositoryId: "local:foo",
      slug: "foo",
      originatingPlatform: "telegram",
      originatingChannel: "telegram:D1",
      createdAt: 0,
    });
    markDevAwaitingApproval(db, "s1", 0);
    (runner.startFromApproval as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      ok: false,
      reason: "product-contract.md missing",
    });
    const { ctx, notify } = makeCtx();
    await approveCommand.handler(ctx);
    expect(notify.mock.calls[0]?.[0]).toContain("Couldn't start");
  });

  it("!approve / !exit degrade when the runner is unavailable", async () => {
    createDevSession(db, {
      id: "s1",
      repositoryId: "local:foo",
      slug: "foo",
      originatingPlatform: "telegram",
      originatingChannel: "telegram:D1",
      createdAt: 0,
    });
    markDevAwaitingApproval(db, "s1", 0);
    const { ctx: approveCtx, notify: approveNotify } = makeCtx({
      getDevModeRunner: () => null,
    });
    await approveCommand.handler(approveCtx);
    expect(approveNotify.mock.calls[0]?.[0]).toContain("unavailable");

    const { ctx: exitCtx, notify: exitNotify } = makeCtx({
      getDevModeRunner: () => null,
    });
    await exitCommand.handler(exitCtx);
    // No runner → the command writes the terminal directly + still confirms.
    expect(exitNotify.mock.calls[0]?.[0]).toContain("Dev mode ended");
    expect(getActiveDevSession(db)).toBeNull();
  });

  it("!approve rejects when nothing is awaiting approval", async () => {
    createDevSession(db, {
      id: "s1",
      repositoryId: "local:foo",
      slug: "foo",
      originatingPlatform: "telegram",
      originatingChannel: "telegram:D1",
      createdAt: 0,
    });
    const { ctx, notify } = makeCtx();
    await approveCommand.handler(ctx);
    expect(notify.mock.calls[0]?.[0]).toContain("isn't ready");
    expect(calls.startFromApproval).toHaveLength(0);
  });

  it("!approve starts the loop for an awaiting_approval session", async () => {
    createDevSession(db, {
      id: "s1",
      repositoryId: "local:foo",
      slug: "foo",
      originatingPlatform: "telegram",
      originatingChannel: "telegram:D1",
      createdAt: 0,
    });
    markDevAwaitingApproval(db, "s1", 0);
    const { ctx, notify } = makeCtx();
    await approveCommand.handler(ctx);
    expect(calls.startFromApproval).toEqual(["s1"]);
    expect(notify.mock.calls[0]?.[0]).toContain("Approved");
  });

  it("!exit cancels the active session via the runner (null-slug fallback)", async () => {
    createDevSession(db, {
      id: "s1",
      repositoryId: "local:foo",
      slug: null,
      originatingPlatform: "telegram",
      originatingChannel: "telegram:D1",
      createdAt: 0,
    });
    const { ctx, notify } = makeCtx();
    await exitCommand.handler(ctx);
    expect(calls.cancel).toEqual([["s1", "user_bang_exit"]]);
    expect(notify.mock.calls[0]?.[0]).toContain("Dev mode ended for local:foo");
  });

  it("!exit with no active session says so", async () => {
    const { ctx, notify } = makeCtx();
    await exitCommand.handler(ctx);
    expect(notify.mock.calls[0]?.[0]).toContain("No dev session is active");
  });

  // ── !rollback (DEV_MODE_GIT_HARDENING Phase A) ─────────────────────────

  function seedBranchedSession(state: "running" | "failed" | "exited", channel = "telegram:D1"): void {
    // A real approved session whose repo sits on the session branch with the
    // rollback anchors recorded — the shape startFromApproval leaves behind.
    execFileSync("git", ["checkout", "-q", "-B", "main"], { cwd: repo });
    execFileSync("git", ["add", "-A"], { cwd: repo });
    execFileSync(
      "git",
      ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "seed"],
      { cwd: repo },
    );
    const originalHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
    execFileSync("git", ["checkout", "-q", "-B", "aitne-dev/s1"], { cwd: repo });
    createDevSession(db, {
      id: "s1",
      repositoryId: "local:foo",
      slug: "foo",
      originatingPlatform: "telegram",
      originatingChannel: channel,
      createdAt: 0,
    });
    markDevAwaitingApproval(db, "s1", 0);
    approveDevSession(db, {
      id: "s1",
      approvedHash: "h",
      branch: "aitne-dev/s1",
      baseRef: originalHead,
      originalBranch: "main",
      originalHead,
      wipSnapshotRef: null,
      maxIterations: 10,
      maxBudgetUsd: null,
      approvedAt: 0,
    });
    if (state !== "running") {
      markDevTerminal(db, { id: "s1", state, loopState: state === "failed" ? "BLOCKED" : null, exitedAt: 1 });
    }
  }

  it("!rollback rejects a non-numeric argument with usage", async () => {
    const { ctx, notify } = makeCtx();
    await rollbackCommand.handler(ctx, "abc");
    expect(notify.mock.calls[0]?.[0]).toContain("Usage: !rollback");
  });

  it("!rollback refuses while the loop is running", async () => {
    seedBranchedSession("running");
    const { ctx, notify } = makeCtx();
    await rollbackCommand.handler(ctx, "");
    expect(notify.mock.calls[0]?.[0]).toContain("!exit first");
  });

  it("!rollback is channel-bound (a session on another channel is invisible here)", async () => {
    seedBranchedSession("failed", "telegram:OTHER");
    const { ctx, notify } = makeCtx();
    await rollbackCommand.handler(ctx, "");
    // Channel-scoped resolution (consistent with !resume/!add): the D1
    // channel simply never resolves the OTHER-channel session.
    expect(notify.mock.calls[0]?.[0]).toContain("no dev session on this channel");
  });

  it("!rollback restores the original checkout of the latest terminal session", async () => {
    seedBranchedSession("failed");
    const { ctx, notify } = makeCtx();
    await rollbackCommand.handler(ctx, "");
    const reply = notify.mock.calls[0]?.[0] as string;
    expect(reply).toContain("Rolled back foo");
    expect(reply).toContain("back on main");
    expect(reply).toContain("kept on aitne-dev/s1");
    expect(
      execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: repo, encoding: "utf8" }).trim(),
    ).toBe("main");
    // A second !rollback resolves the same (now rolled-back) session and
    // refuses with the specific reason (channel-scoped resolution surfaces it
    // rather than returning null).
    const second = makeCtx();
    await rollbackCommand.handler(second.ctx, "");
    expect(second.notify.mock.calls[0]?.[0]).toContain("already rolled back");
  });

  it("!exit points at !rollback when the session has a branch", async () => {
    seedBranchedSession("running");
    const { ctx, notify } = makeCtx();
    await exitCommand.handler(ctx);
    const reply = notify.mock.calls[0]?.[0] as string;
    expect(reply).toContain("!rollback");
    expect(reply).toContain("main");
  });

  it("!rollback with no branched session says so", async () => {
    const { ctx, notify } = makeCtx();
    await rollbackCommand.handler(ctx, "");
    expect(notify.mock.calls[0]?.[0]).toContain("Nothing to roll back");
  });

  // ── !resume ─────────────────────────────────────────────────────────────

  it("parseResumeArgs splits budget/iters raises from the steer note", () => {
    expect(parseResumeArgs("")).toEqual({});
    expect(parseResumeArgs("budget=2.5 iters=15 use sqlite instead")).toEqual({
      budgetUsd: 2.5,
      iters: 15,
      note: "use sqlite instead",
    });
    expect(parseResumeArgs("just keep going")).toEqual({ note: "just keep going" });
    expect(parseResumeArgs("budget=abc").error).toContain("invalid budget");
    expect(parseResumeArgs("iters=0").error).toContain("invalid iters");
  });

  it("!resume targets the newest channel session and re-latches on success", async () => {
    seedBranchedSession("failed");
    const { ctx, notify } = makeCtx();
    await resumeCommand.handler(ctx, parseResumeArgs("budget=3 keep at it"));
    expect(calls.resumeSession).toEqual([
      { sessionId: "s1", budgetUsd: 3, iters: undefined, note: "keep at it" },
    ]);
    expect(beganDevMode).toHaveLength(1);
    expect(notify.mock.calls[0]?.[0]).toContain("Resuming foo");
  });

  it("!resume relays the runner's honest refusal without latching", async () => {
    seedBranchedSession("failed");
    (runner.resumeSession as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      reason: "budget exhausted",
    });
    const { ctx, notify } = makeCtx();
    await resumeCommand.handler(ctx, parseResumeArgs(""));
    expect(notify.mock.calls[0]?.[0]).toContain("Can't resume: budget exhausted");
    expect(beganDevMode).toHaveLength(0);
  });

  it("!resume with no session / bad args replies usage", async () => {
    const first = makeCtx();
    await resumeCommand.handler(first.ctx, parseResumeArgs(""));
    expect(first.notify.mock.calls[0]?.[0]).toContain("No dev session on this channel");
    const second = makeCtx();
    await resumeCommand.handler(second.ctx, parseResumeArgs("budget=nope"));
    expect(second.notify.mock.calls[0]?.[0]).toContain("Usage: !resume");
  });

  // ── !add ────────────────────────────────────────────────────────────────

  it("!add refuses pre-approval and mid-single-loop, honestly", async () => {
    // Pre-approval → fold into the interview.
    createDevSession(db, {
      id: "s1", repositoryId: "local:foo", slug: "foo",
      originatingPlatform: "telegram", originatingChannel: "telegram:D1", createdAt: 0,
    });
    const first = makeCtx();
    await addCommand.handler(first.ctx, "also do X");
    expect(first.notify.mock.calls[0]?.[0]).toContain("fold this into the interview");
    // Running single loop (no live orchestrator) → wait + !add + !resume.
    markDevAwaitingApproval(db, "s1", 0);
    approveDevSession(db, {
      id: "s1", approvedHash: "h", branch: "aitne-dev/s1", baseRef: "x",
      maxIterations: 10, maxBudgetUsd: null, approvedAt: 0,
    });
    (runner.hasLiveOrchestrator as ReturnType<typeof vi.fn>).mockReturnValue(false);
    const second = makeCtx();
    await addCommand.handler(second.ctx, "also do X");
    expect(second.notify.mock.calls[0]?.[0]).toContain("single-loop session");
    expect(listDevTasks(db, "s1")).toHaveLength(0);
  });

  it("!add enqueues manual-<n> on a done session and wakes a live fleet", async () => {
    seedBranchedSession("failed");
    // Fleet history exists → failed-with-orchestration enqueues with a hint.
    insertDevTasks(db, "s1", [{
      id: "t1", taskKey: "core", summary: "core", dependsOn: [], scope: "",
      reqs: [], body: "x", origin: "plan",
    }], 0);
    const first = makeCtx();
    await addCommand.handler(first.ctx, "polish the README");
    expect(first.notify.mock.calls[0]?.[0]).toContain("Queued manual-1");
    expect(first.notify.mock.calls[0]?.[0]).toContain("!resume");
    // A second identical add warns but still lands as manual-2.
    const second = makeCtx();
    await addCommand.handler(second.ctx, "polish the README");
    expect(second.notify.mock.calls[0]?.[0]).toContain("Queued manual-2");
    expect(second.notify.mock.calls[0]?.[0]).toContain("identical task");
    const manuals = listDevTasks(db, "s1").filter((t) => t.origin === "manual");
    expect(manuals.map((t) => t.taskKey)).toEqual(["manual-1", "manual-2"]);
    // Live fleet → the dispatch loop is woken.
    db.prepare(`UPDATE dev_sessions SET state = 'running' WHERE id = 's1'`).run();
    (runner.hasLiveOrchestrator as ReturnType<typeof vi.fn>).mockReturnValue(true);
    const third = makeCtx();
    await addCommand.handler(third.ctx, "one more thing");
    expect(third.notify.mock.calls[0]?.[0]).toContain("integration gate");
    expect(runner.notifyTaskQueued).toHaveBeenCalledWith("s1");
  });
});
