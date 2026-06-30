import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import {
  TimezoneWatcher,
  detectSystemTimezone,
  DEFAULT_TIMEZONE_POLL_INTERVAL_MS,
} from "./timezone-watcher.js";

describe("detectSystemTimezone", () => {
  let savedTZ: string | undefined;

  beforeEach(() => {
    savedTZ = process.env.TZ;
  });

  afterEach(() => {
    if (savedTZ === undefined) delete process.env.TZ;
    else process.env.TZ = savedTZ;
  });

  it("returns the operator-pinned zone without clearing TZ", () => {
    process.env.TZ = "Asia/Tokyo";
    expect(detectSystemTimezone()).toBe("Asia/Tokyo");
    // A pin is the source of truth — the env var must survive untouched.
    expect(process.env.TZ).toBe("Asia/Tokyo");
  });

  it("re-reads the OS zone when TZ is unset and leaves TZ unset", () => {
    delete process.env.TZ;
    const zone = detectSystemTimezone();
    expect(typeof zone).toBe("string");
    expect(zone.length).toBeGreaterThan(0);
    expect(process.env.TZ).toBeUndefined();
  });

  it("treats an empty TZ as unset (flushes the cache, clears TZ)", () => {
    process.env.TZ = "";
    const zone = detectSystemTimezone();
    expect(typeof zone).toBe("string");
    expect(zone.length).toBeGreaterThan(0);
    expect(process.env.TZ).toBeUndefined();
  });
});

describe("TimezoneWatcher", () => {
  let savedTZ: string | undefined;

  beforeEach(() => {
    savedTZ = process.env.TZ;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (savedTZ === undefined) delete process.env.TZ;
    else process.env.TZ = savedTZ;
  });

  it("fires onChange once when the OS zone changes in auto mode", () => {
    const detect = vi
      .fn<() => string>()
      .mockReturnValueOnce("America/New_York") // first poll = baseline
      .mockReturnValue("Asia/Tokyo");
    const onChange = vi.fn();
    const watcher = new TimezoneWatcher({
      getConfiguredTimezone: () => "",
      onChange,
      detect,
      intervalMs: 999_999,
    });

    watcher.poll(); // baseline — no fire
    expect(onChange).not.toHaveBeenCalled();

    watcher.poll(); // changed
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("Asia/Tokyo", "America/New_York");

    // Same zone on the next poll → no duplicate fire.
    watcher.poll();
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("does nothing — and never flushes — while a zone is pinned", () => {
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    const detect = vi.fn<() => string>().mockReturnValue("America/New_York");
    const onChange = vi.fn();
    const watcher = new TimezoneWatcher({
      getConfiguredTimezone: () => "Europe/London",
      onChange,
      detect,
      intervalMs: 999_999,
    });

    // start() schedules the timer and runs an immediate baseline poll, which
    // must short-circuit (pinned) without ever calling detect().
    watcher.start();
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    expect(detect).not.toHaveBeenCalled();

    watcher.poll();
    expect(detect).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();

    watcher.stop();
  });

  it("swallows detection errors and keeps the last known zone", () => {
    const detect = vi
      .fn<() => string>()
      .mockReturnValueOnce("UTC") // baseline
      .mockImplementationOnce(() => {
        throw new Error("detect boom");
      });
    const onChange = vi.fn();
    const watcher = new TimezoneWatcher({
      getConfiguredTimezone: () => "",
      onChange,
      detect,
    });

    watcher.poll(); // baseline
    expect(() => watcher.poll()).not.toThrow();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("ignores an empty detected zone", () => {
    const detect = vi
      .fn<() => string>()
      .mockReturnValueOnce("UTC") // baseline
      .mockReturnValue("");
    const onChange = vi.fn();
    const watcher = new TimezoneWatcher({
      getConfiguredTimezone: () => "",
      onChange,
      detect,
    });

    watcher.poll(); // baseline
    watcher.poll(); // empty → ignored
    expect(onChange).not.toHaveBeenCalled();
  });

  it("isolates a throwing onChange handler", () => {
    const detect = vi
      .fn<() => string>()
      .mockReturnValueOnce("UTC") // baseline
      .mockReturnValue("Asia/Tokyo");
    const onChange = vi.fn(() => {
      throw new Error("handler boom");
    });
    const watcher = new TimezoneWatcher({
      getConfiguredTimezone: () => "",
      onChange,
      detect,
    });

    watcher.poll(); // baseline
    expect(() => watcher.poll()).not.toThrow();
    expect(onChange).toHaveBeenCalledTimes(1);
    // lastZone advanced despite the handler throwing → no re-fire.
    watcher.poll();
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("wires the poll loop on start and is idempotent on start/stop", () => {
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");
    const detect = vi.fn<() => string>().mockReturnValue("UTC");
    const onChange = vi.fn();
    const watcher = new TimezoneWatcher({
      getConfiguredTimezone: () => "",
      onChange,
      detect,
      intervalMs: 999_999,
    });

    watcher.start();
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    // start() ran an immediate baseline poll.
    expect(detect).toHaveBeenCalledTimes(1);

    // The scheduled callback must invoke poll().
    const tick = setIntervalSpy.mock.calls[0]![0] as () => void;
    tick();
    expect(detect).toHaveBeenCalledTimes(2);

    // Second start is a no-op (timer already live).
    watcher.start();
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);

    watcher.stop();
    expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
    // Second stop with no live timer takes the no-op branch.
    watcher.stop();
    expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
  });

  it("defaults the interval and the real OS detector when omitted", () => {
    // Exercises the `?? DEFAULT_TIMEZONE_POLL_INTERVAL_MS` and `?? detectSystemTimezone`
    // fallbacks: no `detect`/`intervalMs` provided.
    const onChange = vi.fn();
    const watcher = new TimezoneWatcher({
      getConfiguredTimezone: () => "",
      onChange,
    });
    // Real detector runs (auto mode): first poll sets the baseline, the second
    // re-reads the same host zone → no change.
    watcher.poll();
    expect(() => watcher.poll()).not.toThrow();
    expect(onChange).not.toHaveBeenCalled();
    expect(DEFAULT_TIMEZONE_POLL_INTERVAL_MS).toBe(60_000);
  });
});
