import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ADAPTER_WATCHDOG_DOWN_TICKS_BEFORE_RESTART,
  ADAPTER_WATCHDOG_INTERVAL_MS,
  AdapterWatchdog,
  type WatchedAdapter,
} from "./adapter-watchdog.js";
import type { AdapterConnectionState } from "./types.js";

function makeWatched(
  overrides?: Partial<WatchedAdapter> & { states?: AdapterConnectionState[] },
): WatchedAdapter & { restart: ReturnType<typeof vi.fn> } {
  const states = overrides?.states ?? [];
  let i = 0;
  return {
    platform: overrides?.platform ?? "slack",
    getConnectionState:
      overrides?.getConnectionState
      ?? (() => states[Math.min(i++, states.length - 1)] ?? "ok"),
    restart: (overrides?.restart as ReturnType<typeof vi.fn>) ?? vi.fn().mockResolvedValue(undefined),
    onStateChange: overrides?.onStateChange,
  };
}

describe("AdapterWatchdog", () => {
  it("does not restart an adapter that reports ok", async () => {
    const watchdog = new AdapterWatchdog();
    const adapter = makeWatched({ states: ["ok", "ok", "ok"] });
    watchdog.register(adapter);

    await watchdog.tick();
    await watchdog.tick();
    await watchdog.tick();

    expect(adapter.restart).not.toHaveBeenCalled();
  });

  it("takes no action on unknown (unconfigured / not introspectable)", async () => {
    const watchdog = new AdapterWatchdog({ downTicksBeforeRestart: 1 });
    const adapter = makeWatched({ states: ["unknown", "unknown"] });
    watchdog.register(adapter);

    await watchdog.tick();
    await watchdog.tick();

    expect(adapter.restart).not.toHaveBeenCalled();
  });

  it("waits the configured number of down ticks before restarting", async () => {
    const watchdog = new AdapterWatchdog({ downTicksBeforeRestart: 2 });
    const adapter = makeWatched({ states: ["down", "down", "ok"] });
    watchdog.register(adapter);

    await watchdog.tick();
    expect(adapter.restart).not.toHaveBeenCalled();

    await watchdog.tick();
    expect(adapter.restart).toHaveBeenCalledTimes(1);

    // Recovered — the counter reset, no further restarts.
    await watchdog.tick();
    expect(adapter.restart).toHaveBeenCalledTimes(1);
  });

  it("resets the down counter when the adapter self-recovers", async () => {
    const watchdog = new AdapterWatchdog({ downTicksBeforeRestart: 2 });
    const adapter = makeWatched({ states: ["down", "ok", "down", "ok"] });
    watchdog.register(adapter);

    await watchdog.tick();
    await watchdog.tick();
    await watchdog.tick();
    await watchdog.tick();

    expect(adapter.restart).not.toHaveBeenCalled();
  });

  it("retries a failed restart on the next tick", async () => {
    const restart = vi
      .fn()
      .mockRejectedValueOnce(new Error("still offline"))
      .mockResolvedValueOnce(undefined);
    const watchdog = new AdapterWatchdog({ downTicksBeforeRestart: 1 });
    const adapter = makeWatched({ states: ["down", "down"], restart });
    watchdog.register(adapter);

    await watchdog.tick();
    expect(restart).toHaveBeenCalledTimes(1);

    await watchdog.tick();
    expect(restart).toHaveBeenCalledTimes(2);
  });

  it("notifies onStateChange on down and recovery transitions only", async () => {
    const transitions: AdapterConnectionState[] = [];
    const watchdog = new AdapterWatchdog({ downTicksBeforeRestart: 99 });
    const adapter = makeWatched({
      states: ["ok", "ok", "down", "down", "ok"],
      onStateChange: (state) => transitions.push(state),
    });
    watchdog.register(adapter);

    for (let i = 0; i < 5; i++) {
      await watchdog.tick();
    }

    // ok→ok (no event), ok→down, down→down (no event), down→ok.
    expect(transitions).toEqual(["down", "ok"]);
  });

  it("contains a throwing onStateChange callback", async () => {
    const watchdog = new AdapterWatchdog({ downTicksBeforeRestart: 99 });
    const adapter = makeWatched({
      states: ["down"],
      onStateChange: () => {
        throw new Error("status sink boom");
      },
    });
    watchdog.register(adapter);

    await expect(watchdog.tick()).resolves.toBeUndefined();
    expect(adapter.restart).not.toHaveBeenCalled();
  });

  it("treats a throwing probe as unknown", async () => {
    const watchdog = new AdapterWatchdog({ downTicksBeforeRestart: 1 });
    const adapter = makeWatched({
      getConnectionState: () => {
        throw new Error("introspection failed");
      },
    });
    watchdog.register(adapter);

    await expect(watchdog.tick()).resolves.toBeUndefined();
    expect(adapter.restart).not.toHaveBeenCalled();
  });

  it("does not overlap restarts for the same adapter", async () => {
    let resolveRestart: (() => void) | null = null;
    const restart = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveRestart = resolve;
        }),
    );
    const watchdog = new AdapterWatchdog({ downTicksBeforeRestart: 1 });
    const adapter = makeWatched({ states: ["down", "down", "down"], restart });
    watchdog.register(adapter);

    const first = watchdog.tick();
    // Restart is now in flight — a second tick must skip this adapter.
    const second = watchdog.tick();
    await second;
    expect(restart).toHaveBeenCalledTimes(1);

    resolveRestart!();
    await first;
  });

  it("isolates a probe failure to the failing adapter", async () => {
    const watchdog = new AdapterWatchdog({ downTicksBeforeRestart: 1 });
    const bad = makeWatched({
      platform: "discord",
      // Force probe() itself to reject by making restart throw synchronously
      // through an async path — easiest stable trigger: a restart that throws.
      states: ["down"],
      restart: vi.fn().mockRejectedValue(new Error("boom")),
    });
    const good = makeWatched({ platform: "telegram", states: ["down"] });
    watchdog.register(bad);
    watchdog.register(good);

    await watchdog.tick();

    expect(good.restart).toHaveBeenCalledTimes(1);
  });

  describe("interval lifecycle", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("start is idempotent, probes on the interval, and stop halts it", async () => {
      const states: AdapterConnectionState[] = ["down", "down", "down", "down"];
      let i = 0;
      const restart = vi.fn().mockResolvedValue(undefined);
      const watchdog = new AdapterWatchdog({ downTicksBeforeRestart: 1 });
      watchdog.register(
        makeWatched({
          getConnectionState: () => states[Math.min(i++, states.length - 1)]!,
          restart,
        }),
      );

      watchdog.start();
      watchdog.start();

      await vi.advanceTimersByTimeAsync(ADAPTER_WATCHDOG_INTERVAL_MS);
      expect(restart).toHaveBeenCalledTimes(1);

      watchdog.stop();
      watchdog.stop();
      await vi.advanceTimersByTimeAsync(ADAPTER_WATCHDOG_INTERVAL_MS * 3);
      expect(restart).toHaveBeenCalledTimes(1);
    });
  });

  it("exports a sane default threshold", () => {
    expect(ADAPTER_WATCHDOG_DOWN_TICKS_BEFORE_RESTART).toBeGreaterThanOrEqual(2);
  });
});
