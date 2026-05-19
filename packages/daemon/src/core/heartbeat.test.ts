import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Heartbeat } from "./heartbeat.js";

describe("Heartbeat", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns the construction time before start()", () => {
    vi.setSystemTime(new Date("2026-05-01T12:00:00Z"));
    const hb = new Heartbeat();
    expect(hb.getLastTickAt()).toBe(Date.parse("2026-05-01T12:00:00Z"));
  });

  it("re-anchors lastTickAt to now() when start() is called", () => {
    // The daemon constructs Heartbeat well before it calls start() (the
    // intervening setup runs the API server listen, dispatcher.run(), etc.).
    // start() must define "alive from now", otherwise `/api/health.lastTickAt`
    // would carry the construction timestamp into the first interval window
    // and the dashboard's 90s frozen-alert could fire spuriously on slow
    // boots. See docs/design/20-notifications-center.md.
    vi.setSystemTime(new Date("2026-05-01T12:00:00Z"));
    const hb = new Heartbeat();
    vi.setSystemTime(new Date("2026-05-01T12:05:00Z"));
    hb.start();
    expect(hb.getLastTickAt()).toBe(Date.parse("2026-05-01T12:05:00Z"));
    hb.stop();
  });

  it("advances the timestamp on every interval tick", () => {
    vi.setSystemTime(new Date("2026-05-01T12:00:00Z"));
    const hb = new Heartbeat();
    hb.start();
    const initial = hb.getLastTickAt();

    vi.setSystemTime(new Date("2026-05-01T12:00:35Z"));
    vi.advanceTimersByTime(35_000);
    expect(hb.getLastTickAt()).toBeGreaterThan(initial);

    hb.stop();
  });

  it("does not advance after stop()", () => {
    vi.setSystemTime(new Date("2026-05-01T12:00:00Z"));
    const hb = new Heartbeat();
    hb.start();
    vi.setSystemTime(new Date("2026-05-01T12:00:35Z"));
    vi.advanceTimersByTime(35_000);
    const before = hb.getLastTickAt();
    hb.stop();
    vi.setSystemTime(new Date("2026-05-01T12:01:35Z"));
    vi.advanceTimersByTime(60_000);
    expect(hb.getLastTickAt()).toBe(before);
  });

  it("is idempotent when start() is called twice", () => {
    const hb = new Heartbeat();
    hb.start();
    expect(() => hb.start()).not.toThrow();
    hb.stop();
  });
});
