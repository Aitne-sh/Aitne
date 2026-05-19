import { afterEach, describe, expect, it } from "vitest";
import {
  __resetWikiCompileLockForTests,
  getWikiCompileLockHolder,
  releaseWikiCompileLock,
  tryAcquireWikiCompileLock,
} from "./compile-lock.js";

describe("wiki compile lock", () => {
  afterEach(() => {
    __resetWikiCompileLockForTests();
  });

  it("acquires a free workspace and reports the holder", () => {
    const result = tryAcquireWikiCompileLock("default", "corr-1");
    expect(result.ok).toBe(true);
    const holder = getWikiCompileLockHolder("default");
    expect(holder).not.toBeNull();
    expect(holder?.correlationId).toBe("corr-1");
  });

  it("rejects a second acquire for the same workspace", () => {
    expect(tryAcquireWikiCompileLock("default", "first").ok).toBe(true);
    const second = tryAcquireWikiCompileLock("default", "second");
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.holder.correlationId).toBe("first");
    }
  });

  it("does not interfere across workspaces", () => {
    expect(tryAcquireWikiCompileLock("a").ok).toBe(true);
    expect(tryAcquireWikiCompileLock("b").ok).toBe(true);
  });

  it("frees the workspace after release", () => {
    tryAcquireWikiCompileLock("default", "first");
    releaseWikiCompileLock("default");
    expect(getWikiCompileLockHolder("default")).toBeNull();
    const second = tryAcquireWikiCompileLock("default", "second");
    expect(second.ok).toBe(true);
  });

  it("treats a lock older than the TTL as orphaned and overwrites it", () => {
    const past = new Date(Date.now() - 2 * 60 * 60 * 1000);
    tryAcquireWikiCompileLock("default", "orphan", past);
    const now = new Date();
    const result = tryAcquireWikiCompileLock("default", "fresh", now);
    expect(result.ok).toBe(true);
    expect(getWikiCompileLockHolder("default")?.correlationId).toBe("fresh");
  });

  it("release is a no-op when no lock is held", () => {
    expect(() => releaseWikiCompileLock("unknown")).not.toThrow();
  });
});
