import { createLogger } from "../logging.js";
import type { AdapterConnectionState } from "./types.js";

const logger = createLogger("adapter-watchdog");

/** Probe cadence. */
export const ADAPTER_WATCHDOG_INTERVAL_MS = 5 * 60_000;

/**
 * Consecutive "down" observations before forcing a restart. Two ticks
 * (~10 min at the default cadence) gives every library's own reconnect
 * machinery (discord.js gateway resume, @slack/socket-mode backoff,
 * telegraf poll retry) ample time to self-heal a transient blip — the
 * watchdog only steps in for the gave-up / wedged cases.
 */
export const ADAPTER_WATCHDOG_DOWN_TICKS_BEFORE_RESTART = 2;

export interface WatchedAdapter {
  platform: string;
  /**
   * Live transport probe. Closures typically read the mutable
   * `AdapterState` slot so a reload that swaps the instance is picked up
   * automatically. Return "unknown" when there is nothing to assess
   * (adapter not configured / not started) — the watchdog takes no action
   * and resets the down counter.
   */
  getConnectionState: () => AdapterConnectionState;
  /**
   * Full stop→start cycle (bootstrap's `reload*Adapter(true)`). Expected
   * to manage MessageHub status transitions itself. Errors are caught and
   * logged; the down counter is preserved so the next tick retries.
   */
  restart: () => Promise<void>;
  /**
   * Invoked on observed state transitions (down ↔ ok) so the caller can
   * surface them (e.g. `messageHub.setPlatformRuntimeStatus`). Optional.
   */
  onStateChange?: (state: AdapterConnectionState) => void;
}

export interface AdapterWatchdogOptions {
  intervalMs?: number;
  downTicksBeforeRestart?: number;
}

/**
 * Daemon-level liveness watchdog for the messaging adapters.
 *
 * Every adapter relies on library-internal reconnection that can end in a
 * permanently dead transport while the daemon still reports "connected":
 * a Slack reconnect chain killed by an unrecoverable start error, a
 * discord.js session invalidation, a telegraf poll loop exited on a
 * non-retryable error — all typically after machine sleep kills the TCP
 * sockets. The pre-watchdog behavior was a silent, indefinite outage that
 * only a daemon restart cleared.
 *
 * The watchdog polls each adapter's `getConnectionState()` and, after
 * {@link ADAPTER_WATCHDOG_DOWN_TICKS_BEFORE_RESTART} consecutive "down"
 * observations, forces a full adapter restart through the bootstrap
 * reloader. Restarts are serialized per adapter (no overlapping cycles)
 * and a failed restart retries on the following tick.
 */
export class AdapterWatchdog {
  private readonly intervalMs: number;
  private readonly downTicksBeforeRestart: number;
  private readonly watched: WatchedAdapter[] = [];
  private readonly downCounts = new Map<string, number>();
  private readonly lastObserved = new Map<string, AdapterConnectionState>();
  private readonly restartInFlight = new Set<string>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(options?: AdapterWatchdogOptions) {
    this.intervalMs = options?.intervalMs ?? ADAPTER_WATCHDOG_INTERVAL_MS;
    this.downTicksBeforeRestart =
      options?.downTicksBeforeRestart
      ?? ADAPTER_WATCHDOG_DOWN_TICKS_BEFORE_RESTART;
  }

  register(adapter: WatchedAdapter): void {
    this.watched.push(adapter);
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    this.timer.unref?.();
    logger.info(
      {
        platforms: this.watched.map((w) => w.platform),
        intervalMs: this.intervalMs,
      },
      "Adapter watchdog started",
    );
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  /** One probe pass over all watched adapters. Exposed for tests. */
  async tick(): Promise<void> {
    for (const adapter of this.watched) {
      await this.probe(adapter).catch((err: unknown) => {
        logger.error(
          { err, platform: adapter.platform },
          "Adapter watchdog probe threw",
        );
      });
    }
  }

  private async probe(adapter: WatchedAdapter): Promise<void> {
    if (this.restartInFlight.has(adapter.platform)) return;

    let state: AdapterConnectionState;
    try {
      state = adapter.getConnectionState();
    } catch (err) {
      logger.warn(
        { err, platform: adapter.platform },
        "Adapter connection probe threw; treating as unknown",
      );
      state = "unknown";
    }

    const previous = this.lastObserved.get(adapter.platform);
    if (previous !== state) {
      this.lastObserved.set(adapter.platform, state);
      if (state === "down" || previous === "down") {
        logger.warn(
          { platform: adapter.platform, from: previous ?? "unobserved", to: state },
          "Adapter connection state changed",
        );
        adapter.onStateChange?.(state);
      }
    }

    if (state !== "down") {
      this.downCounts.set(adapter.platform, 0);
      return;
    }

    const downCount = (this.downCounts.get(adapter.platform) ?? 0) + 1;
    this.downCounts.set(adapter.platform, downCount);
    if (downCount < this.downTicksBeforeRestart) {
      logger.warn(
        { platform: adapter.platform, downCount },
        "Adapter connection down — waiting for library self-recovery before restart",
      );
      return;
    }

    logger.warn(
      { platform: adapter.platform, downCount },
      "Adapter connection still down — forcing restart",
    );
    this.restartInFlight.add(adapter.platform);
    try {
      await adapter.restart();
      this.downCounts.set(adapter.platform, 0);
      logger.info({ platform: adapter.platform }, "Adapter watchdog restart completed");
    } catch (err) {
      // Counter is left at/above the threshold so the next tick retries.
      logger.error(
        { err, platform: adapter.platform },
        "Adapter watchdog restart failed; will retry on next tick",
      );
    } finally {
      this.restartInFlight.delete(adapter.platform);
    }
  }
}
