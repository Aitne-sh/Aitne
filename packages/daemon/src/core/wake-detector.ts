import { createLogger } from "../logging.js";

const logger = createLogger("wake-detector");

/**
 * Default tick cadence. One minute keeps detection latency low while the
 * per-tick work (one Date.now() subtraction) is negligible.
 */
export const WAKE_DETECTOR_INTERVAL_MS = 60_000;

/**
 * Minimum unexplained gap between ticks that counts as a sleep / suspend /
 * forward clock jump. Five minutes is far above any plausible event-loop
 * stall on a healthy daemon, and far below the shortest sleep that can
 * swallow a cron tick worth catching up (the activity scan's default
 * 60-minute cadence).
 */
export const WAKE_GAP_THRESHOLD_MS = 5 * 60_000;

export interface WakeDetectorOptions {
  /**
   * Invoked once per detected wake with the gap length. Errors (sync or
   * async) are caught and logged — the detector keeps ticking.
   */
  onWake: (gapMs: number) => void | Promise<void>;
  intervalMs?: number;
  gapThresholdMs?: number;
  /** Injectable wall clock for tests. */
  now?: () => number;
}

/**
 * Detects machine sleep / suspend / forward clock jumps from inside the
 * process.
 *
 * node-cron (and every other timer in the daemon) runs on Node's timer
 * wheel, which does not fire while the host is suspended — a cron tick
 * scheduled inside a sleep window is silently lost, not replayed on wake.
 * The boot-time catchup in `bootstrap/catchup.ts` covers daemon *restarts*,
 * but a long sleep with the process still alive had no equivalent until
 * this detector.
 *
 * Mechanism: a short `setInterval` notes the wall-clock time of each tick.
 * Timers freeze during sleep, so the first tick after wake observes a
 * wall-clock gap of roughly the sleep duration; anything above
 * `gapThresholdMs` beyond the expected interval fires `onWake`. Backward
 * clock jumps are ignored — there is nothing to catch up when time moves
 * backward, and the next tick re-baselines automatically.
 */
export class WakeDetector {
  private readonly onWake: (gapMs: number) => void | Promise<void>;
  private readonly intervalMs: number;
  private readonly gapThresholdMs: number;
  private readonly now: () => number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastTickMs = 0;

  constructor(options: WakeDetectorOptions) {
    this.onWake = options.onWake;
    this.intervalMs = options.intervalMs ?? WAKE_DETECTOR_INTERVAL_MS;
    this.gapThresholdMs = options.gapThresholdMs ?? WAKE_GAP_THRESHOLD_MS;
    this.now = options.now ?? Date.now;
  }

  start(): void {
    if (this.timer) return;
    this.lastTickMs = this.now();
    this.timer = setInterval(() => this.tick(), this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  /** Test seam — exercises one tick without waiting on real timers. */
  tick(): void {
    const current = this.now();
    const gapMs = current - this.lastTickMs - this.intervalMs;
    this.lastTickMs = current;
    if (gapMs < this.gapThresholdMs) return;

    logger.warn(
      { gapMinutes: Math.round(gapMs / 60_000) },
      "Wall-clock gap detected (machine sleep or clock jump) — running wake catch-up",
    );
    try {
      const result = this.onWake(gapMs);
      if (result && typeof result.then === "function") {
        result.then(undefined, (err: unknown) => {
          logger.error({ err }, "Wake catch-up handler failed");
        });
      }
    } catch (err) {
      logger.error({ err }, "Wake catch-up handler threw");
    }
  }
}
