import { createLogger } from "../logging.js";

const logger = createLogger("timezone-watcher");

/** Default cadence for the OS-timezone poll. A timezone change is rare; 60s
 *  bounds how long any consumer can observe a stale zone after the OS moves. */
export const DEFAULT_TIMEZONE_POLL_INTERVAL_MS = 60_000;

/** Sentinel zone used only to trigger V8's configuration-change notification.
 *  Never observed by application code — set and cleared within one event-loop
 *  tick. */
const TZ_CACHE_FLUSH_SENTINEL = "Etc/UTC";

/**
 * Read the host OS timezone *fresh*, defeating Node/V8's process-lifetime cache.
 *
 * Why this is needed: Node reads the host zone (from `process.env.TZ`, else the
 * OS default — `/etc/localtime` on Unix, the system zone on Windows) exactly
 * once, on first `Intl`/`Date` use, and ICU caches it for the whole process.
 * A laptop that crosses timezones, or a host whose zone is reconfigured, keeps
 * reporting the boot-time zone forever — `Intl.DateTimeFormat().resolvedOptions()
 * .timeZone` and `Date.prototype.getTimezoneOffset()` alike. There is no public
 * API to invalidate this cache.
 *
 * The mechanism: assigning to `process.env.TZ` fires V8's internal
 * `DateTimeConfigurationChangeNotification`, which makes ICU drop its cached
 * default zone. Setting a sentinel and then deleting it forces ICU to re-read
 * the OS default on the next access. The whole sequence is synchronous (a
 * single event-loop tick) with no `await`, so no JS — and no `spawn()` env
 * snapshot — can observe the sentinel value. (One theoretical caveat: assigning
 * `process.env.TZ` calls C `tzset()` process-wide, so a native/libuv-threadpool
 * thread calling C `localtime()` during the ~µs window could momentarily see
 * UTC. No daemon code path relies on C-level local time for correctness.)
 *
 * When the operator pinned a zone via the `TZ` env var, that pin is the source
 * of truth and never tracks the OS — return it directly without thrashing the
 * cache. (An empty `TZ` is treated as "unset".)
 */
export function detectSystemTimezone(): string {
  const savedTZ = process.env.TZ;
  if (savedTZ !== undefined && savedTZ.length > 0) {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  }

  // Force a configuration-change notification, then re-read the OS default.
  process.env.TZ = TZ_CACHE_FLUSH_SENTINEL;
  // Touch a Date so the sentinel is observed before we clear it.
  void new Date().getTimezoneOffset();
  delete process.env.TZ;
  void new Date().getTimezoneOffset();

  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

export interface TimezoneWatcherOptions {
  /**
   * Returns the operator's explicitly-configured zone, or `""`/`undefined` when
   * in auto ("follow the OS") mode. A pinned zone never tracks the OS, so the
   * watcher is inert — and never flushes the cache — while this returns a
   * non-empty value.
   */
  getConfiguredTimezone: () => string | undefined;
  /** Invoked when the detected OS zone changes while in auto mode. */
  onChange: (next: string, previous: string) => void;
  /** Poll cadence; defaults to {@link DEFAULT_TIMEZONE_POLL_INTERVAL_MS}. */
  intervalMs?: number;
  /** Injectable for tests; defaults to the real OS detector. */
  detect?: () => string;
}

/**
 * Polls the host OS timezone and, while the daemon is in auto mode
 * (`config.timezone` empty), refreshes the process so the agent's notion of
 * "now" tracks an OS timezone change.
 *
 * Each poll calls {@link detectSystemTimezone}, which re-reads the OS zone and
 * leaves ICU's cache holding the *current* value. That repaired cache is what
 * every per-call system-fallback consumer reads on its next use — the agent's
 * `<current_time>`, agent-day bounds, the dispatcher's day/quiet-hour math, and
 * a node-cron job's per-tick match check (`timezone: undefined` rebuilds its
 * `Intl.DateTimeFormat` each match). It does NOT, on its own, move a cron's
 * already-scheduled next fire: node-cron precomputes that as a `setTimeout`
 * against the old zone. So on an actual change the watcher additionally fires
 * `onChange`, letting the scheduler `reloadCrons()` and re-anchor those
 * precomputed fire-times to the new zone immediately rather than a cycle later.
 *
 * Cross-platform; cheap (a no-op env toggle + Intl read per minute, and none at
 * all while a zone is pinned). The timer is `unref`'d so it never keeps the
 * event loop alive on its own. Mirrors the WakeDetector poller shape.
 */
export class TimezoneWatcher {
  private readonly getConfiguredTimezone: () => string | undefined;
  private readonly onChange: (next: string, previous: string) => void;
  private readonly intervalMs: number;
  private readonly detect: () => string;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** `null` until the first auto-mode detection establishes the baseline. */
  private lastZone: string | null = null;

  constructor(options: TimezoneWatcherOptions) {
    this.getConfiguredTimezone = options.getConfiguredTimezone;
    this.onChange = options.onChange;
    this.intervalMs = options.intervalMs ?? DEFAULT_TIMEZONE_POLL_INTERVAL_MS;
    this.detect = options.detect ?? detectSystemTimezone;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.poll(), this.intervalMs);
    // Never keep the event loop alive on the watcher's account.
    this.timer.unref();
    // Anchor the baseline now so a zone change inside the first interval isn't
    // silently absorbed. poll() no-ops (no flush) when a zone is pinned, and
    // treats the first auto detection as the baseline without firing onChange.
    this.poll();
    logger.info(
      { intervalMs: this.intervalMs, zone: this.lastZone ?? "pending" },
      "Timezone watcher active",
    );
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** One detection cycle. Public for an immediate check and for tests. */
  poll(): void {
    // A pinned zone is the source of truth — never override it with the OS,
    // and never flush the cache on its behalf.
    if (this.getConfiguredTimezone()) return;

    let next: string;
    try {
      next = this.detect();
    } catch (err) {
      logger.warn({ err }, "Timezone detection failed; keeping last known zone");
      return;
    }

    if (!next) return;
    // First successful auto detection establishes the baseline (not a change).
    if (this.lastZone === null) {
      this.lastZone = next;
      return;
    }
    if (next === this.lastZone) return;

    const previous = this.lastZone;
    this.lastZone = next;
    logger.info({ previous, next }, "OS timezone changed — refreshing schedules");
    try {
      this.onChange(next, previous);
    } catch (err) {
      logger.error({ err, previous, next }, "Timezone change handler failed");
    }
  }
}
