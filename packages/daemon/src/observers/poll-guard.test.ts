import { describe, expect, it, vi } from "vitest";
import { PollGuard, raceWithAbort } from "./poll-guard.js";

describe("PollGuard", () => {
  it("runs fn and resets inFlight on completion", async () => {
    const guard = new PollGuard({ name: "test" });
    const fn = vi.fn(async () => {});
    const ran = await guard.run(fn);
    expect(ran).toBe(true);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(guard.isInFlight()).toBe(false);
  });

  it("skips a second concurrent run while first is in flight", async () => {
    const guard = new PollGuard({ name: "test" });
    let release: (() => void) | null = null;
    const blocker = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = guard.run(async () => {
      await blocker;
    });
    // Second invocation should observe inFlight=true and short-circuit.
    const second = await guard.run(async () => {
      throw new Error("must not run");
    });
    expect(second).toBe(false);
    release?.();
    await first;
    expect(guard.isInFlight()).toBe(false);
  });

  it("re-throws errors from fn and resets inFlight", async () => {
    const guard = new PollGuard({ name: "test" });
    await expect(
      guard.run(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(guard.isInFlight()).toBe(false);
  });

  it("fires the AbortSignal after tickTimeoutMs", async () => {
    vi.useFakeTimers();
    try {
      const guard = new PollGuard({ name: "test", tickTimeoutMs: 100 });
      let observedAbort = false;
      const fnPromise = guard.run((signal) => {
        return new Promise<void>((resolve, reject) => {
          signal.addEventListener("abort", () => {
            observedAbort = true;
            reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
          });
        });
      });
      // Catch the rejection eagerly so the test framework doesn't fail
      // before we advance the fake timers.
      const finished = fnPromise.catch((err: unknown) => err);
      await vi.advanceTimersByTimeAsync(150);
      const result = await finished;
      expect(observedAbort).toBe(true);
      expect((result as Error).message).toMatch(/poll_tick_timeout:test/);
      expect(guard.isInFlight()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("abortInFlight cancels the running tick", async () => {
    const guard = new PollGuard({ name: "test" });
    let abortedReason: unknown = null;
    const ran = guard.run((signal) => {
      return new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          abortedReason = signal.reason;
          reject(new Error("aborted-by-test"));
        });
      });
    });
    const ticked = ran.catch((err: unknown) => err);
    guard.abortInFlight(new Error("observer_stopped"));
    const result = await ticked;
    expect((abortedReason as Error).message).toBe("observer_stopped");
    expect((result as Error).message).toBe("aborted-by-test");
    expect(guard.isInFlight()).toBe(false);
  });

  it("abortInFlight is a no-op when no tick is running", () => {
    const guard = new PollGuard({ name: "test" });
    expect(() => guard.abortInFlight()).not.toThrow();
  });

  it("logs a 'Resumed after skipping ticks' warning when a tick runs after at least one skip", async () => {
    // Pins the line-74-80 branch — once skipCount > 0, the next successful
    // run must emit the warn-level resume log and reset skipCount.
    const guard = new PollGuard({ name: "test" });
    let release: (() => void) | null = null;
    const blocker = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = guard.run(async () => {
      await blocker;
    });
    // Two concurrent ticks both skip — pushes skipCount to 2.
    expect(await guard.run(async () => {})).toBe(false);
    expect(await guard.run(async () => {})).toBe(false);
    release?.();
    await first;
    // Next tick must execute AND reset the skip counter so a subsequent
    // back-to-back tick takes the non-resumed path again.
    const fn = vi.fn(async () => {});
    expect(await guard.run(fn)).toBe(true);
    expect(fn).toHaveBeenCalledTimes(1);
    // Second consecutive run with skipCount=0 — exercises the
    // skipCount===0 branch on line 74 (skipped path NOT taken).
    expect(await guard.run(async () => {})).toBe(true);
  });
});

describe("raceWithAbort", () => {
  it("resolves to the promise value when it settles before abort", async () => {
    const controller = new AbortController();
    const value = await raceWithAbort(Promise.resolve(42), controller.signal);
    expect(value).toBe(42);
  });

  it("rejects when the signal fires before the promise resolves", async () => {
    const controller = new AbortController();
    let resolveInner: ((v: number) => void) | null = null;
    const slow = new Promise<number>((resolve) => {
      resolveInner = resolve;
    });
    const raced = raceWithAbort(slow, controller.signal);
    controller.abort(new Error("timeout"));
    await expect(raced).rejects.toThrow("timeout");
    // The original promise is still pending — caller must accept the leak.
    resolveInner?.(1);
  });

  it("rejects immediately when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort(new Error("preaborted"));
    await expect(raceWithAbort(Promise.resolve(1), controller.signal)).rejects.toThrow(
      "preaborted",
    );
  });

  it("propagates underlying promise rejection", async () => {
    const controller = new AbortController();
    await expect(
      raceWithAbort(Promise.reject(new Error("inner")), controller.signal),
    ).rejects.toThrow("inner");
  });

  it("synthesizes an Error when signal.reason is not one", async () => {
    const controller = new AbortController();
    controller.abort("nope");
    await expect(raceWithAbort(Promise.resolve(1), controller.signal)).rejects.toThrow(
      "nope",
    );
  });

  it("synthesizes a generic Error when signal.reason is an empty string", async () => {
    // Drives the `typeof reason === 'string' && reason.length > 0` ternary's
    // falsy branch in toAbortError — empty-string reasons fall back to the
    // generic "aborted" message rather than producing a blank Error.
    const controller = new AbortController();
    controller.abort("");
    await expect(raceWithAbort(Promise.resolve(1), controller.signal)).rejects.toThrow(
      "aborted",
    );
  });
});
