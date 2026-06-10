import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  InMemoryRoadmapWriteLockManager,
  getRoadmapWriteLockTimeoutMs,
} from "./roadmap-write-lock.js";

describe("InMemoryRoadmapWriteLockManager", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("acquire returns a lockId on first call", () => {
    const mgr = new InMemoryRoadmapWriteLockManager(60_000);
    const result = mgr.acquire();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(typeof result.lockId).toBe("string");
      expect(result.lockId.length).toBeGreaterThan(0);
      expect(mgr.getHolder()).toBe(result.lockId);
    }
  });

  it("acquire rejects while another holder owns the lock", () => {
    const mgr = new InMemoryRoadmapWriteLockManager(60_000);
    const first = mgr.acquire();
    expect(first.ok).toBe(true);
    const second = mgr.acquire();
    expect(second.ok).toBe(false);
    if (!second.ok && first.ok) {
      expect(second.holder).toBe(first.lockId);
    }
  });

  it("release with the correct lockId frees the lock for re-acquisition", () => {
    const mgr = new InMemoryRoadmapWriteLockManager(60_000);
    const first = mgr.acquire();
    if (!first.ok) throw new Error("expected acquire to succeed");
    expect(mgr.release(first.lockId)).toBe(true);
    expect(mgr.getHolder()).toBeNull();

    const second = mgr.acquire();
    expect(second.ok).toBe(true);
  });

  it("release with a mismatched lockId is rejected and leaves holder intact", () => {
    const mgr = new InMemoryRoadmapWriteLockManager(60_000);
    const first = mgr.acquire();
    if (!first.ok) throw new Error("expected acquire to succeed");
    expect(mgr.release("not-the-right-id")).toBe(false);
    expect(mgr.getHolder()).toBe(first.lockId);
  });

  it("release on an unheld lock returns false", () => {
    const mgr = new InMemoryRoadmapWriteLockManager(60_000);
    expect(mgr.release("anything")).toBe(false);
  });

  it("isHeldBy matches only the current holder", () => {
    const mgr = new InMemoryRoadmapWriteLockManager(60_000);
    expect(mgr.isHeldBy("x")).toBe(false);
    const first = mgr.acquire();
    if (!first.ok) throw new Error("expected acquire to succeed");
    expect(mgr.isHeldBy(first.lockId)).toBe(true);
    expect(mgr.isHeldBy("other")).toBe(false);
    expect(mgr.isHeldBy(null)).toBe(false);
    expect(mgr.isHeldBy(undefined)).toBe(false);
  });

  it("auto-releases the lock after the timeout", () => {
    const mgr = new InMemoryRoadmapWriteLockManager(60_000);
    const first = mgr.acquire();
    expect(first.ok).toBe(true);
    expect(mgr.getHolder()).not.toBeNull();

    vi.advanceTimersByTime(60_000);

    expect(mgr.getHolder()).toBeNull();
    const second = mgr.acquire();
    expect(second.ok).toBe(true);
  });

  it("expires by wall clock even when timers never fire (machine-sleep simulation)", () => {
    const mgr = new InMemoryRoadmapWriteLockManager(60_000);
    const first = mgr.acquire();
    if (!first.ok) throw new Error("expected acquire to succeed");

    // Jump the wall clock past the TTL without running any timer callbacks —
    // this is what waking from machine sleep looks like to the process.
    vi.setSystemTime(Date.now() + 60_001);

    expect(mgr.isHeldBy(first.lockId)).toBe(false);
    expect(mgr.getHolder()).toBeNull();
    const second = mgr.acquire();
    expect(second.ok).toBe(true);
  });

  it("does not expire before the TTL elapses on the wall clock", () => {
    const mgr = new InMemoryRoadmapWriteLockManager(60_000);
    const first = mgr.acquire();
    if (!first.ok) throw new Error("expected acquire to succeed");

    vi.setSystemTime(Date.now() + 59_999);

    expect(mgr.isHeldBy(first.lockId)).toBe(true);
    expect(mgr.getHolder()).toBe(first.lockId);
  });
});

describe("getRoadmapWriteLockTimeoutMs", () => {
  it("returns 2x execute timeout plus 10 minutes", () => {
    // 60 min execute → 2*60 + 10 = 130 min = 7_800_000 ms
    expect(getRoadmapWriteLockTimeoutMs(60)).toBe(130 * 60 * 1000);
    // 15 min execute → 2*15 + 10 = 40 min = 2_400_000 ms
    expect(getRoadmapWriteLockTimeoutMs(15)).toBe(40 * 60 * 1000);
  });

  it("falls back to 60 minutes when the input is not finite", () => {
    expect(getRoadmapWriteLockTimeoutMs(Number.NaN)).toBe(130 * 60 * 1000);
    expect(getRoadmapWriteLockTimeoutMs(Number.POSITIVE_INFINITY)).toBe(130 * 60 * 1000);
  });

  it("falls back to 60 minutes when the input is negative", () => {
    expect(getRoadmapWriteLockTimeoutMs(-5)).toBe(130 * 60 * 1000);
  });

  it("permits zero (immediate expiry useful for tests)", () => {
    expect(getRoadmapWriteLockTimeoutMs(0)).toBe(10 * 60 * 1000);
  });
});
