import { createLogger } from "../logging.js";
import { raceWithAbort } from "../core/abort-utils.js";

export { raceWithAbort };

const logger = createLogger("poll-guard");

export interface PollGuardOptions {
  /** Human-readable name for logging (e.g. "calendar-poller"). */
  name: string;
  /**
   * Wall-clock cap per tick. When exceeded, the AbortSignal fires and the
   * tick is logged at warn level. The in-flight promise is NOT awaited
   * beyond this point — the next tick can resume once the previous
   * `run()` returns (which it will if `fn` honors the signal, either
   * directly or via {@link raceWithAbort}).
   *
   * 0 or undefined disables the timeout (overlap guard still applies).
   */
  tickTimeoutMs?: number;
}

/**
 * Shared overlap+timeout guard for observer pollers.
 *
 * Combines the two patterns that several existing pollers already do
 * inline — `mail-poller`'s `inFlight` flag (overlap prevention) and a
 * per-tick wall-clock cap that the audit found missing on
 * `CalendarPoller`, `NotionPoller`, and `ImminentEventScheduler`.
 *
 * Contract: callers MUST honor the AbortSignal in long-running work.
 * For SDK calls that don't natively support `signal`, wrap them with
 * {@link raceWithAbort} — the underlying call leaks (continues in the
 * background until it naturally completes or the transport times out),
 * but the poller's promise resolves so `inFlight` can reset and the
 * next tick is unblocked.
 *
 * What this does NOT do:
 *  - Kill the in-flight work directly (PollGuard is signal-only).
 *  - Reset `inFlight` if `fn` ignores both the signal and never resolves.
 *    That failure mode is a poller bug — surface it loudly via the
 *    timeout warning rather than silently allowing concurrent ticks
 *    that could race on shared DB state.
 */
export class PollGuard {
  private readonly name: string;
  private readonly tickTimeoutMs: number;
  private inFlight = false;
  private currentAborter: AbortController | null = null;
  private skipCount = 0;

  constructor(options: PollGuardOptions) {
    this.name = options.name;
    this.tickTimeoutMs = options.tickTimeoutMs ?? 0;
  }

  /**
   * Run `fn` once with overlap protection. Returns `true` if `fn` ran
   * (regardless of whether it threw), `false` if a previous tick was
   * still in flight and this call was skipped.
   *
   * Errors from `fn` are re-thrown to the caller — the guard does not
   * swallow them. Callers wrap their own `try/catch` for logging policy.
   */
  async run(fn: (signal: AbortSignal) => Promise<void>): Promise<boolean> {
    if (this.inFlight) {
      this.skipCount += 1;
      logger.debug(
        { name: this.name, skipCount: this.skipCount },
        "Skipping tick — previous run still in flight",
      );
      return false;
    }
    if (this.skipCount > 0) {
      logger.warn(
        { name: this.name, skipped: this.skipCount },
        "Resumed after skipping ticks",
      );
      this.skipCount = 0;
    }
    this.inFlight = true;
    const aborter = new AbortController();
    this.currentAborter = aborter;
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (this.tickTimeoutMs > 0) {
      timer = setTimeout(() => {
        logger.warn(
          { name: this.name, tickTimeoutMs: this.tickTimeoutMs },
          "Poll tick exceeded wall-clock — aborting",
        );
        aborter.abort(
          new Error(`poll_tick_timeout:${this.name}:${this.tickTimeoutMs}ms`),
        );
      }, this.tickTimeoutMs);
      timer.unref?.();
    }
    try {
      await fn(aborter.signal);
    } finally {
      if (timer) clearTimeout(timer);
      this.currentAborter = null;
      this.inFlight = false;
    }
    return true;
  }

  /**
   * Cancel any in-flight tick. Safe to call from `observer.stop()` even
   * when no tick is running.
   */
  abortInFlight(reason?: unknown): void {
    this.currentAborter?.abort(reason);
  }

  /** Test seam. */
  isInFlight(): boolean {
    return this.inFlight;
  }
}

