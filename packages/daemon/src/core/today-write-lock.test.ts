import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ContextWriteGate,
  InMemoryTodayWriteLockManager,
  MigrationLock,
  getTodayWriteLockTimeoutMs,
} from "./today-write-lock.js";

describe("getTodayWriteLockTimeoutMs", () => {
  it("derives the lock timeout from execute timeout minutes", () => {
    expect(getTodayWriteLockTimeoutMs(15)).toBe((15 * 2 + 10) * 60 * 1000);
  });

  it("falls back to the default execute timeout when given NaN", () => {
    expect(getTodayWriteLockTimeoutMs(Number.NaN)).toBe((60 * 2 + 10) * 60 * 1000);
  });

  it("falls back to the default when given a negative value", () => {
    expect(getTodayWriteLockTimeoutMs(-5)).toBe((60 * 2 + 10) * 60 * 1000);
  });

  it("falls back to the default when given Infinity", () => {
    expect(getTodayWriteLockTimeoutMs(Number.POSITIVE_INFINITY)).toBe(
      (60 * 2 + 10) * 60 * 1000,
    );
  });

  it("treats zero as a valid (instantly-expiring) value", () => {
    expect(getTodayWriteLockTimeoutMs(0)).toBe(10 * 60 * 1000);
  });
});

describe("InMemoryTodayWriteLockManager", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("acquires when free and returns a lockId", () => {
    const lock = new InMemoryTodayWriteLockManager(1000);
    const result = lock.acquire();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.lockId).toMatch(/^[0-9a-f-]{36}$/);
      expect(lock.getHolder()).toBe(result.lockId);
    }
  });

  it("rejects acquire when already held and returns existing holder", () => {
    const lock = new InMemoryTodayWriteLockManager(1000);
    const first = lock.acquire();
    expect(first.ok).toBe(true);
    const second = lock.acquire();
    expect(second.ok).toBe(false);
    if (!second.ok && first.ok) {
      expect(second.holder).toBe(first.lockId);
    }
  });

  it("releases with the correct lockId", () => {
    const lock = new InMemoryTodayWriteLockManager(1000);
    const result = lock.acquire();
    if (!result.ok) throw new Error("expected acquire to succeed");
    expect(lock.release(result.lockId)).toBe(true);
    expect(lock.getHolder()).toBeNull();
  });

  it("refuses to release with a wrong lockId", () => {
    const lock = new InMemoryTodayWriteLockManager(1000);
    const result = lock.acquire();
    if (!result.ok) throw new Error("expected acquire to succeed");
    expect(lock.release("not-the-real-id")).toBe(false);
    expect(lock.getHolder()).toBe(result.lockId);
  });

  it("release returns false when no lock is held", () => {
    const lock = new InMemoryTodayWriteLockManager(1000);
    expect(lock.release("anything")).toBe(false);
  });

  it("isHeldBy returns false when no lock is held", () => {
    const lock = new InMemoryTodayWriteLockManager(1000);
    expect(lock.isHeldBy("anything")).toBe(false);
    expect(lock.isHeldBy(null)).toBe(false);
    expect(lock.isHeldBy(undefined)).toBe(false);
  });

  it("isHeldBy returns true only for the holder's lockId", () => {
    const lock = new InMemoryTodayWriteLockManager(1000);
    const result = lock.acquire();
    if (!result.ok) throw new Error("expected acquire to succeed");
    expect(lock.isHeldBy(result.lockId)).toBe(true);
    expect(lock.isHeldBy("other-id")).toBe(false);
    expect(lock.isHeldBy(null)).toBe(false);
    expect(lock.isHeldBy(undefined)).toBe(false);
  });

  it("auto-releases the lock after the timeout expires", () => {
    const lock = new InMemoryTodayWriteLockManager(1000);
    const result = lock.acquire();
    if (!result.ok) throw new Error("expected acquire to succeed");
    expect(lock.getHolder()).toBe(result.lockId);
    vi.advanceTimersByTime(1000);
    expect(lock.getHolder()).toBeNull();
    // After expiry, a new acquire should succeed.
    const next = lock.acquire();
    expect(next.ok).toBe(true);
  });

  it("release after expiry returns false", () => {
    const lock = new InMemoryTodayWriteLockManager(1000);
    const result = lock.acquire();
    if (!result.ok) throw new Error("expected acquire to succeed");
    vi.advanceTimersByTime(1000);
    expect(lock.release(result.lockId)).toBe(false);
  });
});

describe("MigrationLock", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("acquires when free and returns a lockId", () => {
    const lock = new MigrationLock(60_000);
    const result = lock.acquire();
    expect(result.ok).toBe(true);
    expect(lock.isHeld()).toBe(true);
  });

  it("rejects acquire when already held", () => {
    const lock = new MigrationLock(60_000);
    const first = lock.acquire();
    if (!first.ok) throw new Error("expected acquire to succeed");
    const second = lock.acquire();
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.holder).toBe(first.lockId);
    }
  });

  it("releases with the correct lockId", () => {
    const lock = new MigrationLock(60_000);
    const result = lock.acquire();
    if (!result.ok) throw new Error("expected acquire to succeed");
    expect(lock.release(result.lockId)).toBe(true);
    expect(lock.isHeld()).toBe(false);
    expect(lock.getHolder()).toBeNull();
  });

  it("refuses to release with a wrong lockId and remains held", () => {
    const lock = new MigrationLock(60_000);
    const result = lock.acquire();
    if (!result.ok) throw new Error("expected acquire to succeed");
    expect(lock.release("bogus")).toBe(false);
    expect(lock.isHeld()).toBe(true);
    expect(lock.getHolder()).toBe(result.lockId);
  });

  it("release returns false when no lock is held", () => {
    const lock = new MigrationLock(60_000);
    expect(lock.release("anything")).toBe(false);
  });

  it("auto-releases after timeout", () => {
    const lock = new MigrationLock(5000);
    const result = lock.acquire();
    if (!result.ok) throw new Error("expected acquire to succeed");
    vi.advanceTimersByTime(5000);
    expect(lock.isHeld()).toBe(false);
    expect(lock.getHolder()).toBeNull();
  });
});

describe("ContextWriteGate", () => {
  it("engages with a reason and exposes state", () => {
    const gate = new ContextWriteGate();
    expect(gate.isEngaged()).toBe(false);
    expect(gate.getState()).toEqual({ engaged: false, reason: null, since: null });

    gate.engage("migration_in_progress");
    expect(gate.isEngaged()).toBe(true);
    const state = gate.getState();
    expect(state.engaged).toBe(true);
    expect(state.reason).toBe("migration_in_progress");
    expect(typeof state.since).toBe("string");
    expect(new Date(state.since ?? "").toString()).not.toBe("Invalid Date");
  });

  it("ignores re-engage and preserves the original reason", () => {
    const gate = new ContextWriteGate();
    gate.engage("first");
    const firstState = gate.getState();
    gate.engage("second");
    const secondState = gate.getState();
    expect(secondState.reason).toBe("first");
    expect(secondState.since).toBe(firstState.since);
  });

  it("disengages and clears state", () => {
    const gate = new ContextWriteGate();
    gate.engage("reason");
    gate.disengage();
    expect(gate.isEngaged()).toBe(false);
    expect(gate.getState()).toEqual({ engaged: false, reason: null, since: null });
  });

  it("disengage when not engaged is a no-op", () => {
    const gate = new ContextWriteGate();
    expect(() => gate.disengage()).not.toThrow();
    expect(gate.getState()).toEqual({ engaged: false, reason: null, since: null });
  });
});
