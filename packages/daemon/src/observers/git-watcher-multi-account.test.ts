import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { GitWatcher } from "./git-watcher.js";
import { applySchema } from "../db/schema.js";

const execFileAsync = promisify(execFile);

/**
 * Phase 5 acceptance: GitWatcher must consult the per-repo env resolver
 * before each fetchOrigin call. Two repos with different aliases hit
 * different envs in the same poll cycle without a `gh auth switch`.
 *
 * The watcher's network-touching path is `git fetch --prune --tags origin`.
 * We don't need a working remote to verify the resolver contract — we
 * only need the watcher to *attempt* the fetch, which it does for every
 * watched repo. The resolver callback fires before the execFile call;
 * failure of the fetch itself is OK.
 */
describe("GitWatcher — per-repo credential injection", () => {
  let db: Database.Database;
  let repoA: string;
  let repoB: string;

  beforeEach(async () => {
    db = new Database(":memory:");
    applySchema(db);
    repoA = mkdtempSync(join(tmpdir(), "git-watcher-multi-a-"));
    repoB = mkdtempSync(join(tmpdir(), "git-watcher-multi-b-"));
    // Create minimal valid git repos so `git rev-parse HEAD` doesn't crash
    // outside the fetchOrigin path.
    await execFileAsync("git", ["init", "-q", repoA]);
    await execFileAsync("git", ["init", "-q", repoB]);
    // Configure user identity so commits work in CI
    for (const repo of [repoA, repoB]) {
      await execFileAsync("git", ["-C", repo, "config", "user.email", "t@t.test"]);
      await execFileAsync("git", ["-C", repo, "config", "user.name", "Tester"]);
      await execFileAsync("git", [
        "-C",
        repo,
        "commit",
        "--allow-empty",
        "-m",
        "init",
      ]);
    }
  });

  afterEach(() => {
    rmSync(repoA, { recursive: true, force: true });
    rmSync(repoB, { recursive: true, force: true });
    db.close();
  });

  it("invokes the env resolver per repo during the baseline fetch", async () => {
    const seenAliases: string[] = [];
    const repoEnvResolver = vi.fn(async (repoPath: string) => {
      if (repoPath === repoA) {
        seenAliases.push("work");
        return { GH_TOKEN: "TOKEN_WORK", PA_GIT_TOKEN: "TOKEN_WORK" };
      }
      if (repoPath === repoB) {
        seenAliases.push("personal");
        return { GH_TOKEN: "TOKEN_PERSONAL", PA_GIT_TOKEN: "TOKEN_PERSONAL" };
      }
      return undefined;
    });

    const watcher = new GitWatcher([repoA, repoB], db, 60, {
      repoEnvResolver,
    });
    await watcher.start();
    await watcher.stop();

    // start() runs an initial fetchOrigin per repo. The resolver may fire
    // additional times (poll cycle if the timer elapses), but never less
    // than 1 per repo.
    expect(seenAliases).toContain("work");
    expect(seenAliases).toContain("personal");
    expect(repoEnvResolver).toHaveBeenCalled();
  });

  it("falls back to default env when the resolver throws", async () => {
    const watcher = new GitWatcher([repoA], db, 60, {
      repoEnvResolver: async () => {
        throw new Error("resolver_broken");
      },
    });
    // Must not throw — start swallows resolver failures.
    await watcher.start();
    await watcher.stop();
  });

  it("calls the env resolver exactly once per repo per remote-touching pass", async () => {
    // The watcher's baseline pass fans out fetchOrigin → readRemoteSnapshot
    // (which itself runs ls-remote --heads, ls-remote --tags, and
    // ls-remote --symref). All four operations must share the same
    // pre-resolved env so a single poll cycle doesn't double-spend the
    // resolver's `gh auth token` budget. Asserting the call count guards
    // the `resolveRepoEnv` caching contract.
    const repoEnvResolver = vi.fn(async () => ({
      GH_TOKEN: "TOKEN_WORK",
      PA_GIT_TOKEN: "TOKEN_WORK",
    }));
    const watcher = new GitWatcher([repoA], db, 60, {
      repoEnvResolver,
    });
    await watcher.start();
    await watcher.stop();
    // start() runs initializeRemoteSnapshot, which is one fetchOrigin +
    // one readRemoteSnapshot. The resolver should fire exactly once
    // for that pass — not three or four times.
    expect(repoEnvResolver).toHaveBeenCalledTimes(1);
  });
});
