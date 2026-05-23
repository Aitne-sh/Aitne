import { afterEach, describe, expect, it } from "vitest";
import {
  InterestsReflectionLockBusyError,
  _resetInterestsReflectionLockForTests,
  acquireInterestsReflectionLock,
  peekInterestsReflectionLockHolder,
} from "./interests-reflection-lock.js";

describe("acquireInterestsReflectionLock", () => {
  afterEach(() => {
    _resetInterestsReflectionLockForTests();
  });

  it("returns a release callback that frees the lock", () => {
    const release = acquireInterestsReflectionLock("refresh:test");
    expect(peekInterestsReflectionLockHolder()).toBe("refresh:test");
    release();
    expect(peekInterestsReflectionLockHolder()).toBeNull();
  });

  it("throws InterestsReflectionLockBusyError on contention", () => {
    const release = acquireInterestsReflectionLock("refresh:scheduler");
    try {
      expect(() =>
        acquireInterestsReflectionLock("refresh:dashboard"),
      ).toThrow(InterestsReflectionLockBusyError);
    } finally {
      release();
    }
  });

  it("surfaces both holder names in the error", () => {
    const release = acquireInterestsReflectionLock("cleanup:dashboard");
    try {
      acquireInterestsReflectionLock("refresh:scheduler");
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(InterestsReflectionLockBusyError);
      const lockErr = err as InterestsReflectionLockBusyError;
      expect(lockErr.heldBy).toBe("cleanup:dashboard");
      expect(lockErr.attemptedBy).toBe("refresh:scheduler");
      expect(lockErr.message).toContain("cleanup:dashboard");
      expect(lockErr.message).toContain("refresh:scheduler");
    } finally {
      release();
    }
  });

  it("release is idempotent", () => {
    const release = acquireInterestsReflectionLock("refresh:test");
    release();
    release();
    expect(peekInterestsReflectionLockHolder()).toBeNull();
  });

  it("release after another holder acquired is a no-op", () => {
    // Hold, release, re-acquire by a different caller — releasing the
    // first lockId must not free the second.
    const releaseA = acquireInterestsReflectionLock("refresh:scheduler");
    releaseA();
    const releaseB = acquireInterestsReflectionLock("refresh:dashboard");
    // Stale release on the first caller should not nuke B's hold.
    releaseA();
    expect(peekInterestsReflectionLockHolder()).toBe("refresh:dashboard");
    releaseB();
    expect(peekInterestsReflectionLockHolder()).toBeNull();
  });

  it("reset hatch clears state regardless of holder", () => {
    acquireInterestsReflectionLock("leak:simulated");
    expect(peekInterestsReflectionLockHolder()).toBe("leak:simulated");
    _resetInterestsReflectionLockForTests();
    expect(peekInterestsReflectionLockHolder()).toBeNull();
    // Confirm a fresh acquire works after reset.
    const release = acquireInterestsReflectionLock("after:reset");
    expect(peekInterestsReflectionLockHolder()).toBe("after:reset");
    release();
  });
});
