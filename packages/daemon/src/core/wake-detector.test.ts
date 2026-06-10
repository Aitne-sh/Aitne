import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  WAKE_DETECTOR_INTERVAL_MS,
  WAKE_GAP_THRESHOLD_MS,
  WakeDetector,
} from "./wake-detector.js";

describe("WakeDetector", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not fire on ticks with no wall-clock gap", () => {
    const onWake = vi.fn();
    const detector = new WakeDetector({ onWake });
    detector.start();

    // Fake timers advance Date.now in lockstep with the interval, so every
    // tick observes exactly the expected elapsed time — no gap.
    vi.advanceTimersByTime(WAKE_DETECTOR_INTERVAL_MS * 5);

    expect(onWake).not.toHaveBeenCalled();
    detector.stop();
  });

  it("fires onWake with the gap when the wall clock jumps past the threshold", () => {
    const onWake = vi.fn();
    const detector = new WakeDetector({ onWake });
    detector.start();

    // Simulate machine sleep: the wall clock jumps two hours without any
    // timer callbacks running, then the frozen interval fires on wake.
    const sleepMs = 2 * 60 * 60 * 1000;
    vi.setSystemTime(Date.now() + sleepMs);
    vi.advanceTimersByTime(WAKE_DETECTOR_INTERVAL_MS);

    expect(onWake).toHaveBeenCalledTimes(1);
    expect(onWake).toHaveBeenCalledWith(sleepMs);
    detector.stop();
  });

  it("re-baselines after a wake so the next normal tick does not re-fire", () => {
    const onWake = vi.fn();
    const detector = new WakeDetector({ onWake });
    detector.start();

    vi.setSystemTime(Date.now() + 60 * 60 * 1000);
    vi.advanceTimersByTime(WAKE_DETECTOR_INTERVAL_MS);
    expect(onWake).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(WAKE_DETECTOR_INTERVAL_MS * 3);
    expect(onWake).toHaveBeenCalledTimes(1);
    detector.stop();
  });

  it("ignores gaps below the threshold", () => {
    const onWake = vi.fn();
    const detector = new WakeDetector({ onWake });
    detector.start();

    vi.setSystemTime(Date.now() + WAKE_GAP_THRESHOLD_MS - 1);
    vi.advanceTimersByTime(WAKE_DETECTOR_INTERVAL_MS);

    expect(onWake).not.toHaveBeenCalled();
    detector.stop();
  });

  it("ignores backward clock jumps and re-baselines", () => {
    const onWake = vi.fn();
    let nowMs = 1_000_000_000;
    const detector = new WakeDetector({
      onWake,
      intervalMs: 1_000,
      gapThresholdMs: 5_000,
      now: () => nowMs,
    });
    detector.start();

    nowMs -= 60_000; // clock stepped backward (e.g. NTP correction)
    detector.tick();
    expect(onWake).not.toHaveBeenCalled();

    // Next tick measures from the new baseline — still no spurious fire.
    nowMs += 1_000;
    detector.tick();
    expect(onWake).not.toHaveBeenCalled();

    // A real forward jump after the re-baseline is still detected.
    nowMs += 1_000 + 10_000;
    detector.tick();
    expect(onWake).toHaveBeenCalledTimes(1);
    expect(onWake).toHaveBeenCalledWith(10_000);
  });

  it("catches a synchronously throwing handler and keeps ticking", () => {
    const onWake = vi.fn(() => {
      throw new Error("boom");
    });
    let nowMs = 0;
    const detector = new WakeDetector({
      onWake,
      intervalMs: 1_000,
      gapThresholdMs: 5_000,
      now: () => nowMs,
    });
    detector.start();

    nowMs += 1_000 + 10_000;
    expect(() => detector.tick()).not.toThrow();
    expect(onWake).toHaveBeenCalledTimes(1);

    nowMs += 1_000 + 10_000;
    expect(() => detector.tick()).not.toThrow();
    expect(onWake).toHaveBeenCalledTimes(2);
  });

  it("catches an asynchronously rejecting handler", async () => {
    const onWake = vi.fn().mockRejectedValue(new Error("async boom"));
    let nowMs = 0;
    const detector = new WakeDetector({
      onWake,
      intervalMs: 1_000,
      gapThresholdMs: 5_000,
      now: () => nowMs,
    });
    detector.start();

    nowMs += 1_000 + 10_000;
    detector.tick();
    // Flush microtasks so the rejection handler runs (and is swallowed).
    await Promise.resolve();
    await Promise.resolve();
    expect(onWake).toHaveBeenCalledTimes(1);
    detector.stop();
  });

  it("start is idempotent and stop without start is a no-op", () => {
    const onWake = vi.fn();
    const detector = new WakeDetector({ onWake });

    expect(() => detector.stop()).not.toThrow();

    detector.start();
    detector.start(); // second start must not double the interval

    vi.setSystemTime(Date.now() + 60 * 60 * 1000);
    vi.advanceTimersByTime(WAKE_DETECTOR_INTERVAL_MS);
    expect(onWake).toHaveBeenCalledTimes(1);

    detector.stop();
    detector.stop();

    vi.setSystemTime(Date.now() + 60 * 60 * 1000);
    vi.advanceTimersByTime(WAKE_DETECTOR_INTERVAL_MS * 2);
    expect(onWake).toHaveBeenCalledTimes(1);
  });
});
