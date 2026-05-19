/**
 * Backend-agnostic idle/hang detector for delegated-proxy streams.
 *
 * Why: the wall-clock timeout in `delegated-proxy-config.ts` is 120 s for
 * Claude / Codex and 180 s for Gemini. When `gemini-cli` (or any backend)
 * hangs without emitting any stream event, the wall-clock cap is the only
 * thing that fires, leaving the synchronous API caller waiting up to 180 s
 * for a deterministic failure. The idle watchdog detects the hang in
 * tens of seconds instead by tracking stream-event arrival as a heartbeat:
 * each backend calls `beat()` from its event-stream callback, and the
 * watchdog aborts the call when no beat lands inside `idleTimeoutMs`.
 *
 * Backend wiring:
 *   - Claude SDK  — `beat()` from inside `for await (const message of stream)`
 *   - Codex CLI   — `beat()` from `onStdoutLine` and `onStderrLine`
 *   - Gemini CLI  — `beat()` from `onStdoutLine` and `onStderrLine`
 *
 * The watchdog does not know which abort mechanism each backend uses; it
 * delegates that to the `onTimeout` callback (which closes the SDK stream
 * for Claude or `proxyAborter.abort(new DelegatedProxyTimeoutError(...))`
 * for the CLI backends). The resulting failure flows through the existing
 * `classifyAbortReason` path and surfaces as `errorClass="timeout"` —
 * unchanged from the wall-clock case, so cadence retry logic and dashboard
 * grouping work without modification.
 */

const DEFAULT_POLL_INTERVAL_MS = 5_000;

export interface IdleWatchdogOptions {
  /** Abort when no `beat()` for this long. */
  idleTimeoutMs: number;
  /**
   * How often the watchdog checks elapsed-since-last-beat.
   * Default 5 s — fine-grained enough that a 30 s idle threshold trips
   * within ~5 s of the actual deadline; coarse enough that the timer
   * itself does not measurably load the daemon.
   */
  pollIntervalMs?: number;
  /**
   * Called once when the watchdog trips. Receives the elapsed milliseconds
   * since the last beat at the moment the trip was observed (always >=
   * `idleTimeoutMs`). The watchdog auto-stops before invoking — the
   * callback does not need to call `stop()` itself.
   */
  onTimeout: (idleMs: number) => void;
}

export class IdleWatchdog {
  private readonly idleTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly onTimeout: (idleMs: number) => void;
  private readonly clock: () => number;
  private lastBeatAt = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private fired = false;

  constructor(options: IdleWatchdogOptions, clock: () => number = Date.now) {
    if (!Number.isFinite(options.idleTimeoutMs) || options.idleTimeoutMs <= 0) {
      throw new Error("IdleWatchdog: idleTimeoutMs must be a positive number");
    }
    this.idleTimeoutMs = options.idleTimeoutMs;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.onTimeout = options.onTimeout;
    this.clock = clock;
  }

  /**
   * Begin watching. Records the current time as the initial beat so
   * cold-start latency does not falsely trip the watchdog. Idempotent —
   * a second `start()` is a no-op.
   */
  start(): void {
    if (this.timer || this.fired) return;
    this.lastBeatAt = this.clock();
    this.timer = setInterval(() => this.poll(), this.pollIntervalMs);
    this.timer.unref?.();
  }

  /**
   * Mark progress. Backend-side stream callbacks call this once per
   * arrived event. Cheap by design — a single timestamp write — so it is
   * safe to invoke from hot stream paths.
   */
  beat(): void {
    if (this.fired) return;
    this.lastBeatAt = this.clock();
  }

  /**
   * Stop watching. Idempotent. Always safe to call from a `finally` block
   * regardless of whether the watchdog ever started.
   */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Test seam — exposes the firing state so unit tests can assert that
   * the watchdog tripped (or did not) without calling private members.
   */
  hasFired(): boolean {
    return this.fired;
  }

  private poll(): void {
    if (this.fired) return;
    const idleMs = this.clock() - this.lastBeatAt;
    if (idleMs < this.idleTimeoutMs) return;
    this.fired = true;
    this.stop();
    this.onTimeout(idleMs);
  }
}
