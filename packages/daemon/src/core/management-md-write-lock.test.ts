import { describe, expect, it, vi } from "vitest";
import {
  InMemoryManagementMdWriteLockManager,
  MANAGEMENT_MD_WRITE_LOCK_TIMEOUT_MS,
  withManagementMdWriteLock,
} from "./management-md-write-lock.js";

describe("InMemoryManagementMdWriteLockManager", () => {
  it("grants a lock and reports the holder", () => {
    const mgr = new InMemoryManagementMdWriteLockManager();
    const result = mgr.acquire();
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(mgr.isHeldBy(result.lockId)).toBe(true);
    expect(mgr.getHolder()).toBe(result.lockId);
  });

  it("rejects a second acquire while held and reports the holder id", () => {
    const mgr = new InMemoryManagementMdWriteLockManager();
    const first = mgr.acquire();
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error("unreachable");
    const second = mgr.acquire();
    expect(second.ok).toBe(false);
    if (second.ok) throw new Error("unreachable");
    expect(second.holder).toBe(first.lockId);
  });

  it("release with a non-matching id returns false and keeps the lock held", () => {
    const mgr = new InMemoryManagementMdWriteLockManager();
    const first = mgr.acquire();
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error("unreachable");
    expect(mgr.release("nope")).toBe(false);
    expect(mgr.isHeldBy(first.lockId)).toBe(true);
  });

  it("release with the matching id frees the lock and stops the timer", () => {
    const mgr = new InMemoryManagementMdWriteLockManager();
    const first = mgr.acquire();
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error("unreachable");
    expect(mgr.release(first.lockId)).toBe(true);
    expect(mgr.getHolder()).toBeNull();
    // Subsequent release is idempotent (no-op, returns false).
    expect(mgr.release(first.lockId)).toBe(false);
  });

  it("release on a never-held lock is a no-op", () => {
    const mgr = new InMemoryManagementMdWriteLockManager();
    expect(mgr.release("anything")).toBe(false);
  });

  it("isHeldBy returns false when no lock is held", () => {
    const mgr = new InMemoryManagementMdWriteLockManager();
    expect(mgr.isHeldBy("nope")).toBe(false);
    expect(mgr.isHeldBy(null)).toBe(false);
    expect(mgr.isHeldBy(undefined)).toBe(false);
  });

  it("auto-releases after the configured timeout", () => {
    vi.useFakeTimers();
    try {
      const mgr = new InMemoryManagementMdWriteLockManager(1_000);
      const first = mgr.acquire();
      expect(first.ok).toBe(true);
      vi.advanceTimersByTime(1_001);
      expect(mgr.getHolder()).toBeNull();
      // Lock is reusable once auto-released.
      const next = mgr.acquire();
      expect(next.ok).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("default timeout matches the documented constant", () => {
    expect(MANAGEMENT_MD_WRITE_LOCK_TIMEOUT_MS).toBe(5_000);
  });
});

describe("withManagementMdWriteLock", () => {
  it("runs the body and releases on success", async () => {
    const mgr = new InMemoryManagementMdWriteLockManager();
    const result = await withManagementMdWriteLock(mgr, () => 42);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.value).toBe(42);
    expect(mgr.getHolder()).toBeNull();
  });

  it("releases the lock when the body throws", async () => {
    const mgr = new InMemoryManagementMdWriteLockManager();
    await expect(
      withManagementMdWriteLock(mgr, () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(mgr.getHolder()).toBeNull();
  });

  it("returns the holder id when the lock is contended", async () => {
    const mgr = new InMemoryManagementMdWriteLockManager();
    const held = mgr.acquire();
    expect(held.ok).toBe(true);
    if (!held.ok) throw new Error("unreachable");
    const result = await withManagementMdWriteLock(mgr, () => "should not run");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.holder).toBe(held.lockId);
  });

  it("supports an async body", async () => {
    const mgr = new InMemoryManagementMdWriteLockManager();
    const result = await withManagementMdWriteLock(mgr, async () => {
      await new Promise((r) => setTimeout(r, 1));
      return "async-ok";
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.value).toBe("async-ok");
    expect(mgr.getHolder()).toBeNull();
  });
});
