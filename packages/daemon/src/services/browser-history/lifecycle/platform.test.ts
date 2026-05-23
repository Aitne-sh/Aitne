import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { singletonLockHasLiveOwner } from "./platform.js";

describe("singletonLockHasLiveOwner", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "pa-bh-platform-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("returns true when SingletonLock points to a live PID", async () => {
    symlinkSync(`some-host-${process.pid}`, join(root, "SingletonLock"));
    expect(await singletonLockHasLiveOwner(root)).toBe(true);
  });

  it("returns false when SingletonLock points to a dead PID", async () => {
    // Pick a PID that cannot exist on this host. Linux + macOS both
    // allow PIDs up to ~4 million; 2^31 - 1 is well above any kernel
    // limit and `process.kill(pid, 0)` will ESRCH-throw.
    symlinkSync(`some-host-2147483646`, join(root, "SingletonLock"));
    expect(await singletonLockHasLiveOwner(root)).toBe(false);
  });

  it("returns false when SingletonLock target lacks a parseable PID", async () => {
    symlinkSync("garbage-no-suffix", join(root, "SingletonLock"));
    expect(await singletonLockHasLiveOwner(root)).toBe(false);
  });

  it("returns false when SingletonLock is a regular file, not a symlink", async () => {
    // Some Chromium variants write a regular file instead of a symlink.
    // `readlink` throws EINVAL on those; we should fall through.
    writeFileSync(join(root, "SingletonLock"), `some-host-${process.pid}`);
    expect(await singletonLockHasLiveOwner(root)).toBe(false);
  });

  it("returns false when SingletonLock does not exist", async () => {
    expect(await singletonLockHasLiveOwner(root)).toBe(false);
  });

  it("returns false when the user-data-dir itself does not exist", async () => {
    expect(await singletonLockHasLiveOwner(join(root, "missing"))).toBe(false);
  });
});
