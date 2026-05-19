import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { IdleWatchdog } from "./idle-watchdog.js";

describe("IdleWatchdog", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("rejects non-positive idleTimeoutMs", () => {
    expect(
      () => new IdleWatchdog({ idleTimeoutMs: 0, onTimeout: () => {} }),
    ).toThrow(/positive number/);
    expect(
      () => new IdleWatchdog({ idleTimeoutMs: -1, onTimeout: () => {} }),
    ).toThrow(/positive number/);
    expect(
      () => new IdleWatchdog({ idleTimeoutMs: NaN, onTimeout: () => {} }),
    ).toThrow(/positive number/);
  });

  it("trips after idleTimeoutMs of inactivity", () => {
    let now = 0;
    const clock = () => now;
    const onTimeout = vi.fn();
    const watchdog = new IdleWatchdog(
      { idleTimeoutMs: 30_000, pollIntervalMs: 1_000, onTimeout },
      clock,
    );
    watchdog.start();

    // Advance clock + drain pollers up to just under the threshold.
    now = 25_000;
    vi.advanceTimersByTime(25_000);
    expect(onTimeout).not.toHaveBeenCalled();

    // Cross the threshold on the next poll.
    now = 30_500;
    vi.advanceTimersByTime(5_500);

    expect(onTimeout).toHaveBeenCalledTimes(1);
    expect(onTimeout).toHaveBeenCalledWith(30_500);
    expect(watchdog.hasFired()).toBe(true);
  });

  it("does not trip while beat() is called inside the threshold", () => {
    let now = 0;
    const onTimeout = vi.fn();
    const watchdog = new IdleWatchdog(
      { idleTimeoutMs: 30_000, pollIntervalMs: 1_000, onTimeout },
      () => now,
    );
    watchdog.start();

    for (let i = 0; i < 10; i++) {
      now += 5_000;
      vi.advanceTimersByTime(5_000);
      watchdog.beat();
    }

    expect(onTimeout).not.toHaveBeenCalled();
    expect(watchdog.hasFired()).toBe(false);
    watchdog.stop();
  });

  it("only fires onTimeout once even if poll runs again before stop()", () => {
    let now = 0;
    const onTimeout = vi.fn();
    const watchdog = new IdleWatchdog(
      { idleTimeoutMs: 1_000, pollIntervalMs: 100, onTimeout },
      () => now,
    );
    watchdog.start();

    now = 5_000;
    vi.advanceTimersByTime(5_000);

    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it("ignores beat() and timer ticks after firing", () => {
    let now = 0;
    const onTimeout = vi.fn();
    const watchdog = new IdleWatchdog(
      { idleTimeoutMs: 1_000, pollIntervalMs: 100, onTimeout },
      () => now,
    );
    watchdog.start();
    now = 2_000;
    vi.advanceTimersByTime(2_000);
    expect(onTimeout).toHaveBeenCalledTimes(1);

    // Late beat after fire is a no-op
    watchdog.beat();
    now = 5_000;
    vi.advanceTimersByTime(5_000);
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it("stop() is idempotent and safe before/after start()", () => {
    const watchdog = new IdleWatchdog(
      { idleTimeoutMs: 1_000, onTimeout: () => {} },
      () => 0,
    );
    expect(() => watchdog.stop()).not.toThrow();
    watchdog.start();
    watchdog.stop();
    expect(() => watchdog.stop()).not.toThrow();
  });

  it("start() is idempotent — second call is a no-op", () => {
    let now = 0;
    const onTimeout = vi.fn();
    const watchdog = new IdleWatchdog(
      { idleTimeoutMs: 1_000, pollIntervalMs: 500, onTimeout },
      () => now,
    );
    watchdog.start();
    watchdog.start();

    now = 2_000;
    vi.advanceTimersByTime(2_000);

    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it("poll() exits immediately if fired flag is already set (defensive re-entry guard)", () => {
    // The poll loop is auto-cancelled inside `poll()` once it trips, so the
    // `if (this.fired) return` guard at the top of poll is normally
    // unreachable from the timer path. However, the guard exists as
    // defense-in-depth: if a second poll were ever to land (e.g. a queued
    // microtask, a future race, or — as exercised here — a direct caller),
    // it must not re-fire onTimeout. Reach it by invoking poll directly via
    // the test seam after the first fire.
    let now = 0;
    const onTimeout = vi.fn();
    const watchdog = new IdleWatchdog(
      { idleTimeoutMs: 1_000, pollIntervalMs: 100, onTimeout },
      () => now,
    );
    watchdog.start();
    now = 2_000;
    vi.advanceTimersByTime(2_000);
    expect(onTimeout).toHaveBeenCalledTimes(1);

    // Force a second poll() invocation. The guard must short-circuit
    // before the elapsed-since-beat math runs.
    const internal = watchdog as unknown as { poll: () => void };
    internal.poll();
    expect(onTimeout).toHaveBeenCalledTimes(1);
    expect(watchdog.hasFired()).toBe(true);
  });

  it("does not start once it has fired", () => {
    let now = 0;
    const onTimeout = vi.fn();
    const watchdog = new IdleWatchdog(
      { idleTimeoutMs: 1_000, pollIntervalMs: 500, onTimeout },
      () => now,
    );
    watchdog.start();
    now = 2_000;
    vi.advanceTimersByTime(2_000);
    expect(onTimeout).toHaveBeenCalledTimes(1);

    watchdog.start();
    now = 4_000;
    vi.advanceTimersByTime(2_000);
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });
});
