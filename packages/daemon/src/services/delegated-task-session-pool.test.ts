import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DelegatedTaskSessionPool,
  SESSION_POOL_TEMPDIR_PREFIX,
  runSessionPoolTempdirJanitor,
} from "./delegated-task-session-pool.js";

let workspace: string;
let materializerCalls: string[];

const materializer = (sessionDir: string): void => {
  materializerCalls.push(sessionDir);
};

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "session-pool-test-"));
  materializerCalls = [];
});

afterEach(() => {
  try {
    rmSync(workspace, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

function makePool(opts: { ttlMs?: number; maxIdle?: number; nowRef?: { value: number } } = {}) {
  const nowRef = opts.nowRef ?? { value: 1_000 };
  const pool = new DelegatedTaskSessionPool({
    ttlMs: opts.ttlMs ?? 30_000,
    maxIdle: opts.maxIdle ?? 4,
    materializer,
    tempdirPrefix: SESSION_POOL_TEMPDIR_PREFIX,
    sessionsRoot: workspace,
    now: () => nowRef.value,
  });
  return { pool, nowRef };
}

describe("DelegatedTaskSessionPool constructor validation", () => {
  it("throws on non-positive ttlMs", () => {
    expect(() => new DelegatedTaskSessionPool({
      ttlMs: 0,
      maxIdle: 1,
      materializer,
      tempdirPrefix: SESSION_POOL_TEMPDIR_PREFIX,
      sessionsRoot: workspace,
    })).toThrow(/ttlMs must be > 0/);
  });

  it("throws on non-positive maxIdle", () => {
    expect(() => new DelegatedTaskSessionPool({
      ttlMs: 1000,
      maxIdle: 0,
      materializer,
      tempdirPrefix: SESSION_POOL_TEMPDIR_PREFIX,
      sessionsRoot: workspace,
    })).toThrow(/maxIdle must be > 0/);
  });
});

describe("DelegatedTaskSessionPool.hashKey", () => {
  it("differs by backend / integrationKey / model", () => {
    const a = DelegatedTaskSessionPool.hashKey({
      backendId: "claude",
      integrationKey: "gmail",
      modelId: "x",
    });
    expect(DelegatedTaskSessionPool.hashKey({
      backendId: "gemini",
      integrationKey: "gmail",
      modelId: "x",
    })).not.toBe(a);
    expect(DelegatedTaskSessionPool.hashKey({
      backendId: "claude",
      integrationKey: "notion",
      modelId: "x",
    })).not.toBe(a);
    expect(DelegatedTaskSessionPool.hashKey({
      backendId: "claude",
      integrationKey: "gmail",
      modelId: "y",
    })).not.toBe(a);
  });

  it("treats null integrationKey as the 'run' bucket", () => {
    expect(DelegatedTaskSessionPool.hashKey({
      backendId: "claude",
      integrationKey: null,
      modelId: "x",
    })).toContain("|run|");
  });
});

describe("DelegatedTaskSessionPool acquire/release reuse", () => {
  it("reuses an idle entry within TTL", () => {
    const { pool, nowRef } = makePool();
    const lease1 = pool.acquire({
      backendId: "claude",
      integrationKey: "gmail",
      modelId: "model-x",
    });
    expect(lease1.fromPool).toBe(false);
    const dir1 = lease1.sessionDir;
    expect(materializerCalls.length).toBe(1);
    lease1.release();

    nowRef.value += 1_000;
    const lease2 = pool.acquire({
      backendId: "claude",
      integrationKey: "gmail",
      modelId: "model-x",
    });
    expect(lease2.fromPool).toBe(true);
    expect(lease2.sessionDir).toBe(dir1);
    expect(materializerCalls.length).toBe(1);
    lease2.release();
  });

  it("does not reuse across different pool keys", () => {
    const { pool } = makePool();
    const lease1 = pool.acquire({
      backendId: "claude",
      integrationKey: "gmail",
      modelId: "model-x",
    });
    lease1.release();
    const lease2 = pool.acquire({
      backendId: "claude",
      integrationKey: "notion",
      modelId: "model-x",
    });
    expect(lease2.fromPool).toBe(false);
    expect(lease2.sessionDir).not.toBe(lease1.sessionDir);
    expect(materializerCalls.length).toBe(2);
    lease2.release();
  });

  it("expires entries past TTL", () => {
    const { pool, nowRef } = makePool({ ttlMs: 1_000 });
    const lease1 = pool.acquire({
      backendId: "claude",
      integrationKey: "gmail",
      modelId: "model-x",
    });
    const dir1 = lease1.sessionDir;
    lease1.release();
    nowRef.value += 5_000;
    const lease2 = pool.acquire({
      backendId: "claude",
      integrationKey: "gmail",
      modelId: "model-x",
    });
    expect(lease2.fromPool).toBe(false);
    expect(lease2.sessionDir).not.toBe(dir1);
    expect(existsSync(dir1)).toBe(false);
    lease2.release();
  });

  it("evicts oldest idle entry when over maxIdle", () => {
    const { pool, nowRef } = makePool({ maxIdle: 2 });
    const a = pool.acquire({ backendId: "claude", integrationKey: "gmail", modelId: "m" });
    a.release();
    nowRef.value += 100;
    const b = pool.acquire({ backendId: "claude", integrationKey: "notion", modelId: "m" });
    b.release();
    nowRef.value += 100;
    // Acquire a third — oldest (gmail) should be evicted.
    const c = pool.acquire({ backendId: "gemini", integrationKey: "gmail", modelId: "m" });
    c.release();
    const stats = pool.stats();
    expect(stats.idle).toBe(2);
    expect(existsSync(a.sessionDir)).toBe(false);
    expect(existsSync(b.sessionDir)).toBe(true);
    expect(existsSync(c.sessionDir)).toBe(true);
  });

  it("discard() drops the entry permanently and removes the dir", () => {
    const { pool } = makePool();
    const lease = pool.acquire({ backendId: "claude", integrationKey: "gmail", modelId: "m" });
    const dir = lease.sessionDir;
    lease.discard();
    expect(existsSync(dir)).toBe(false);
    expect(pool.stats().total).toBe(0);
  });

  it("release() and discard() are idempotent", () => {
    const { pool } = makePool();
    const lease = pool.acquire({ backendId: "claude", integrationKey: "gmail", modelId: "m" });
    lease.release();
    lease.release(); // no-op
    lease.discard(); // no-op
    expect(pool.stats().idle).toBe(1);
  });

  it("evictAll() removes idle entries but keeps in-use ones", () => {
    const { pool } = makePool();
    const inUse = pool.acquire({ backendId: "claude", integrationKey: "gmail", modelId: "m" });
    const idle = pool.acquire({ backendId: "claude", integrationKey: "notion", modelId: "m" });
    idle.release();
    expect(pool.evictAll()).toBe(1);
    expect(pool.stats().inUse).toBe(1);
    expect(pool.stats().idle).toBe(0);
    expect(existsSync(inUse.sessionDir)).toBe(true);
    expect(existsSync(idle.sessionDir)).toBe(false);
    inUse.release();
  });

  it("detects an externally-deleted dir and re-materializes", () => {
    const { pool } = makePool();
    const a = pool.acquire({ backendId: "claude", integrationKey: "gmail", modelId: "m" });
    const dir1 = a.sessionDir;
    a.release();
    rmSync(dir1, { recursive: true, force: true });
    const b = pool.acquire({ backendId: "claude", integrationKey: "gmail", modelId: "m" });
    expect(b.fromPool).toBe(false);
    expect(b.sessionDir).not.toBe(dir1);
    b.release();
  });

  it("rethrows materialization errors and removes the half-built dir", () => {
    const flaky: typeof materializer = () => {
      throw new Error("boom");
    };
    const pool = new DelegatedTaskSessionPool({
      ttlMs: 30_000,
      maxIdle: 4,
      materializer: flaky,
      tempdirPrefix: SESSION_POOL_TEMPDIR_PREFIX,
      sessionsRoot: workspace,
    });
    expect(() => pool.acquire({
      backendId: "claude",
      integrationKey: "gmail",
      modelId: "m",
    })).toThrow(/boom/);
    // The half-built dir must not be left behind.
    const leftovers = readdirSync(workspace).filter((e) =>
      e.startsWith(SESSION_POOL_TEMPDIR_PREFIX),
    );
    expect(leftovers).toHaveLength(0);
  });

  it("rethrows materialization errors even when the cleanup rm itself fails", () => {
    // The materializer throws AND the half-built dir cannot be removed; the
    // pool's inner cleanup catch swallows the rm failure so the original
    // materialization error propagates uncorrupted.
    const flaky: typeof materializer = (sessionDir) => {
      // Drop write perms so rm of the dir's contents fails. We leave a
      // placeholder file inside so rmSync has to traverse before failing.
      mkdirSync(sessionDir, { recursive: true });
      const fs = require("node:fs");
      fs.writeFileSync(join(sessionDir, "marker"), "x");
      chmodSync(sessionDir, 0o555);
      throw new Error("materialize-then-cleanup-also-fails");
    };
    const pool = new DelegatedTaskSessionPool({
      ttlMs: 30_000,
      maxIdle: 4,
      materializer: flaky,
      tempdirPrefix: SESSION_POOL_TEMPDIR_PREFIX,
      sessionsRoot: workspace,
    });
    let trackedDir: string | null = null;
    try {
      expect(() => {
        // Capture the dir name on first call so the afterEach can chmod it back.
        try {
          pool.acquire({ backendId: "claude", integrationKey: "gmail", modelId: "m" });
        } catch (err) {
          // Find the leftover dir to chmod it back later.
          const leftovers = readdirSync(workspace).filter((e) =>
            e.startsWith(SESSION_POOL_TEMPDIR_PREFIX),
          );
          if (leftovers.length > 0) trackedDir = join(workspace, leftovers[0]);
          throw err;
        }
      }).toThrow(/materialize-then-cleanup-also-fails/);
    } finally {
      if (trackedDir) chmodSync(trackedDir, 0o755);
    }
  });
});

describe("runSessionPoolTempdirJanitor", () => {
  it("removes pool-prefixed dirs older than maxAgeMs", () => {
    const { pool } = makePool();
    const a = pool.acquire({ backendId: "claude", integrationKey: "gmail", modelId: "m" });
    a.release();
    // Force the dir's mtime backwards by recreating with a known mtime.
    const dir = a.sessionDir;
    expect(existsSync(dir)).toBe(true);
    const now = Date.now() + 10 * 60 * 1000; // 10 minutes in the future
    const removed = runSessionPoolTempdirJanitor(workspace, {
      now: () => now,
      maxAgeMs: 60 * 1000,
    });
    expect(removed).toBeGreaterThanOrEqual(1);
    expect(existsSync(dir)).toBe(false);
  });

  it("returns 0 when sessionsRoot does not exist", () => {
    expect(runSessionPoolTempdirJanitor(join(workspace, "missing"))).toBe(0);
  });

  it("skips entries whose statSync throws (e.g. dangling symlinks)", () => {
    // Create a sessions root with a single dangling symlink that uses the
    // pool prefix, so the entry is enumerated but statSync raises ENOENT.
    // The janitor should swallow the error, treat the entry as missing,
    // and continue without throwing.
    const root = join(workspace, "sessions");
    mkdirSync(root, { recursive: true });
    symlinkSync(
      join(root, "does-not-exist"),
      join(root, `${SESSION_POOL_TEMPDIR_PREFIX}dangling`),
    );
    expect(runSessionPoolTempdirJanitor(root, { maxAgeMs: 0 })).toBe(0);
  });

  it("logs and continues when an entry's rm fails inside removeEntry/discard", () => {
    // Acquire + release an entry so it's pooled, then chmod the sessionDir
    // read-only with a child file inside, so rmSync throws when discard()
    // calls removeEntry. The pool must still drop the entry from its
    // bookkeeping list and not leak the throw.
    const { pool } = makePool();
    const lease = pool.acquire({
      backendId: "claude",
      integrationKey: "gmail",
      modelId: "m",
    });
    const dir = lease.sessionDir;
    lease.release();
    const fs = require("node:fs");
    fs.writeFileSync(join(dir, "child"), "x");
    chmodSync(dir, 0o555);
    try {
      expect(() => pool.evictAll()).not.toThrow();
      // Bookkeeping should still report empty.
      expect(pool.stats().total).toBe(0);
    } finally {
      chmodSync(dir, 0o755);
    }
  });

  it("ignores non-pool-prefixed entries, files, and recently-touched dirs", async () => {
    // Build a sessions root that contains every reject branch in the loop:
    //  - an entry whose name doesn't start with SESSION_POOL_TEMPDIR_PREFIX
    //  - a regular file with the prefix (statSync is a file → !isDirectory)
    //  - a recent pool-prefixed dir (mtime within maxAgeMs)
    // Plus one stale dir that should be removed, so we can assert removed === 1.
    const root = join(workspace, "sessions");
    mkdirSync(root, { recursive: true });
    mkdirSync(join(root, "unrelated-name"));
    const fs = await import("node:fs");
    fs.writeFileSync(join(root, `${SESSION_POOL_TEMPDIR_PREFIX}file`), "x");
    const fresh = join(root, `${SESSION_POOL_TEMPDIR_PREFIX}fresh`);
    mkdirSync(fresh);
    const stale = join(root, `${SESSION_POOL_TEMPDIR_PREFIX}stale`);
    mkdirSync(stale);

    // Pin mtimes deterministically: fresh inside the window, stale past it.
    const now = Date.now() + 10 * 60 * 1000;
    const freshMtime = (now - 60 * 1000) / 1000; // 1 min ago — within 5 min window
    const staleMtime = (now - 60 * 60 * 1000) / 1000; // 1 hour ago — outside window
    fs.utimesSync(fresh, freshMtime, freshMtime);
    fs.utimesSync(stale, staleMtime, staleMtime);

    const removed = runSessionPoolTempdirJanitor(root, {
      now: () => now,
      maxAgeMs: 5 * 60 * 1000,
    });
    expect(removed).toBe(1);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(join(root, "unrelated-name"))).toBe(true);
  });

  it("returns 0 when readdirSync throws (e.g. sessionsRoot is a file, not a directory)", async () => {
    // readdir on a regular file path throws ENOTDIR. We point sessionsRoot
    // at a regular file so existsSync passes (file exists) but readdirSync
    // fails — this exercises the catch arm at lines 345-348 in the source.
    const root = join(workspace, "not-a-dir");
    const fs = await import("node:fs");
    fs.writeFileSync(root, "this is a file, not a directory");
    expect(runSessionPoolTempdirJanitor(root)).toBe(0);
  });

  it("logs and continues when rmSync fails for a stale entry", async () => {
    // Make a stale pool-prefixed dir, then place a child file inside it and
    // strip write permissions on the parent so rm cannot remove the child
    // even with `force: true`. The janitor should log the failure and
    // return 0 (no successful removals) rather than throwing.
    const root = join(workspace, "sessions");
    mkdirSync(root, { recursive: true });
    const stale = join(root, `${SESSION_POOL_TEMPDIR_PREFIX}stale`);
    mkdirSync(stale, { recursive: true });
    // Insert a child file the rm must traverse.
    const fs = await import("node:fs");
    fs.writeFileSync(join(stale, "x"), "data");
    // Lock the parent directory so the child cannot be unlinked. On macOS
    // this denies unlink/remove permissions; chmod 0o555 strips write.
    chmodSync(stale, 0o555);
    try {
      const removed = runSessionPoolTempdirJanitor(root, {
        now: () => Date.now() + 10 * 60 * 1000,
        maxAgeMs: 60 * 1000,
      });
      // rmSync threw — the catch arm logged and skipped, so removed === 0.
      expect(removed).toBe(0);
      // The directory is still present (the rm didn't complete).
      expect(existsSync(stale)).toBe(true);
    } finally {
      // Restore perms so the afterEach cleanup doesn't fail.
      chmodSync(stale, 0o755);
    }
  });
});
