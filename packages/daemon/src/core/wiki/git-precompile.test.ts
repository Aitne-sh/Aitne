import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isGitRepo,
  previewGitPreCompile,
  runGitPreCompile,
} from "./git-precompile.js";
import type { WikiWorkspaceRow } from "./workspaces.js";

function externalWorkspace(rootPath: string, overrides: Partial<WikiWorkspaceRow> = {}): WikiWorkspaceRow {
  return {
    id: 1,
    name: "default",
    kind: "external",
    root_path: rootPath,
    language: "en",
    dispatch_mode: "parallel",
    concurrency_cap: 3,
    dm_agent_write_enabled: 0,
    bridge_enabled: 0,
    bridge_measurement_only: 1,
    bridge_min_confidence: 0.7,
    full_compile_approval_threshold_usd: 2,
    write_strategy: "auto",
    git_pre_compile_enabled: 1,
    schema_version: 1,
    active: 1,
    last_ingest_at: null,
    last_compile_at: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

describe("runGitPreCompile", () => {
  let rootPath: string;

  beforeEach(() => {
    rootPath = mkdtempSync(join(tmpdir(), "pa-wiki-git-"));
  });

  afterEach(() => {
    rmSync(rootPath, { recursive: true, force: true });
  });

  it("skips when workspace is internal-mode", async () => {
    const result = await runGitPreCompile(externalWorkspace(rootPath, { kind: "internal" }));
    expect(result).toEqual({ status: "skipped", reason: "internal_mode" });
  });

  it("skips when external vault is not a git repo", async () => {
    const result = await runGitPreCompile(externalWorkspace(rootPath));
    expect(result).toEqual({ status: "skipped", reason: "no_git_repo" });
  });

  it("skips when the workspace toggle is disabled", async () => {
    mkdirSync(join(rootPath, ".git"));
    const result = await runGitPreCompile(
      externalWorkspace(rootPath, { git_pre_compile_enabled: 0 }),
    );
    expect(result).toEqual({ status: "skipped", reason: "disabled" });
  });

  it("refuses when the working tree is dirty", async () => {
    mkdirSync(join(rootPath, ".git"));
    const run = vi.fn().mockResolvedValueOnce({ stdout: " M wiki.md\n?? new.md", stderr: "" });
    const result = await runGitPreCompile(externalWorkspace(rootPath), { run });
    expect(result.status).toBe("refused");
    if (result.status === "refused") {
      expect(result.dirtyPaths).toEqual(["wiki.md", "new.md"]);
    }
  });

  it("forwards the snapshot SHA to writeTracker.markAgentCommit (C1)", async () => {
    mkdirSync(join(rootPath, ".git"));
    const fixedNow = new Date("2026-05-12T03:00:00.000Z");
    const run = vi
      .fn()
      .mockResolvedValueOnce({ stdout: "", stderr: "" })
      .mockResolvedValueOnce({ stdout: "", stderr: "" })
      .mockResolvedValueOnce({ stdout: "", stderr: "" })
      .mockResolvedValueOnce({ stdout: "deadbeef0000abcd1234\n", stderr: "" });
    const markAgentCommit = vi.fn();
    const writeTracker = { markAgentCommit } as unknown as Parameters<
      typeof runGitPreCompile
    >[1]["writeTracker"];

    const result = await runGitPreCompile(externalWorkspace(rootPath), {
      run,
      now: () => fixedNow,
      writeTracker,
    });

    expect(result.status).toBe("committed");
    expect(markAgentCommit).toHaveBeenCalledExactlyOnceWith(
      rootPath,
      "deadbeef0000abcd1234",
    );
  });

  it("omitting writeTracker does not throw (back-compat for existing callers)", async () => {
    mkdirSync(join(rootPath, ".git"));
    const run = vi
      .fn()
      .mockResolvedValueOnce({ stdout: "", stderr: "" })
      .mockResolvedValueOnce({ stdout: "", stderr: "" })
      .mockResolvedValueOnce({ stdout: "", stderr: "" })
      .mockResolvedValueOnce({ stdout: "abc1234567\n", stderr: "" });
    const result = await runGitPreCompile(externalWorkspace(rootPath), { run });
    expect(result.status).toBe("committed");
  });

  it("commits with a deterministic message when the tree is clean", async () => {
    mkdirSync(join(rootPath, ".git"));
    const fixedNow = new Date("2026-05-12T03:00:00.000Z");
    const run = vi
      .fn()
      .mockResolvedValueOnce({ stdout: "", stderr: "" })
      .mockResolvedValueOnce({ stdout: "", stderr: "" })
      .mockResolvedValueOnce({ stdout: "", stderr: "" })
      .mockResolvedValueOnce({ stdout: "abc1234567\n", stderr: "" });
    const result = await runGitPreCompile(externalWorkspace(rootPath), {
      run,
      now: () => fixedNow,
    });
    expect(result.status).toBe("committed");
    if (result.status === "committed") {
      expect(result.commitMessage).toBe(
        "aitne wiki: pre-compile snapshot 2026-05-12T03:00:00.000Z",
      );
      expect(result.commitSha).toBe("abc1234567");
    }
    expect(run).toHaveBeenNthCalledWith(
      2,
      "git",
      ["-C", rootPath, "add", "-A"],
      expect.any(Object),
    );
    expect(run).toHaveBeenNthCalledWith(
      3,
      "git",
      [
        "-C",
        rootPath,
        "commit",
        "--allow-empty",
        "-m",
        "aitne wiki: pre-compile snapshot 2026-05-12T03:00:00.000Z",
      ],
      expect.any(Object),
    );
  });
});

describe("previewGitPreCompile", () => {
  let rootPath: string;

  beforeEach(() => {
    rootPath = mkdtempSync(join(tmpdir(), "pa-wiki-git-preview-"));
  });

  afterEach(() => {
    rmSync(rootPath, { recursive: true, force: true });
  });

  it("returns clean_would_commit without running add/commit when tree is clean", async () => {
    mkdirSync(join(rootPath, ".git"));
    const run = vi
      .fn()
      .mockResolvedValueOnce({ stdout: "", stderr: "" }); // status only
    const result = await previewGitPreCompile(externalWorkspace(rootPath), {
      run,
    });
    expect(result).toEqual({ status: "clean_would_commit" });
    // Crucial: `status` is the ONLY git call. No add, no commit.
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith(
      "git",
      ["-C", rootPath, "status", "--porcelain"],
      expect.any(Object),
    );
  });

  it("returns refused/dirty without mutating when tree is dirty", async () => {
    mkdirSync(join(rootPath, ".git"));
    const run = vi
      .fn()
      .mockResolvedValueOnce({ stdout: " M dirty.md\n", stderr: "" });
    const result = await previewGitPreCompile(externalWorkspace(rootPath), {
      run,
    });
    expect(result).toEqual({
      status: "refused",
      reason: "dirty_tree",
      dirtyPaths: ["dirty.md"],
    });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("skips for internal-mode workspaces with no git invocations", async () => {
    const run = vi.fn();
    const result = await previewGitPreCompile(
      externalWorkspace(rootPath, { kind: "internal" }),
      { run },
    );
    expect(result).toEqual({ status: "skipped", reason: "internal_mode" });
    expect(run).not.toHaveBeenCalled();
  });
});

describe("isGitRepo", () => {
  let rootPath: string;

  beforeEach(() => {
    rootPath = mkdtempSync(join(tmpdir(), "pa-wiki-isgit-"));
  });

  afterEach(() => {
    rmSync(rootPath, { recursive: true, force: true });
  });

  it("returns false for a plain directory", () => {
    expect(isGitRepo(rootPath)).toBe(false);
  });

  it("returns true when .git is a directory", () => {
    mkdirSync(join(rootPath, ".git"));
    expect(isGitRepo(rootPath)).toBe(true);
  });

  it("returns true when .git is a file (worktree)", () => {
    writeFileSync(join(rootPath, ".git"), "gitdir: /elsewhere");
    expect(isGitRepo(rootPath)).toBe(true);
  });
});
