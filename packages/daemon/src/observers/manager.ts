import { createLogger } from "../logging.js";

const logger = createLogger("observer-manager");

/**
 * Observer — anything that detects external changes and emits events.
 */
export interface Observer {
  readonly name: string;
  start(): Promise<void>;
  stop(): Promise<void>;
}

/**
 * Outcome of a hot-remove (`stopAndUnregister`) call.
 *
 *   - `removed`     — observer was found, `stop()` resolved, observer
 *                     dropped from the registry.
 *   - `absent`      — no observer of that name was registered.
 *   - `stop_failed` — observer was found but `stop()` threw. The observer
 *                     is intentionally LEFT REGISTERED so a subsequent
 *                     retry (or `stopAll()` on shutdown) can attempt
 *                     cleanup again. Without this, a flaky stop would
 *                     orphan the underlying poller (timer / fs watcher /
 *                     long-poll) while the registry believed the
 *                     integration was quiet — observations would keep
 *                     flowing under the new mode (`delegated` worker +
 *                     leftover direct poller), double-counting the
 *                     signal.
 */
export type StopAndUnregisterResult =
  | { readonly status: "removed" }
  | { readonly status: "absent" }
  | { readonly status: "stop_failed"; readonly error: unknown };

/**
 * ObserverManager — central registry for all change-detection observers.
 *
 * Manages lifecycle (start/stop) for:
 * - ObsidianWatcher (chokidar file system events)
 * - GitWatcher (git log polling)
 * - CalendarPoller (Google Calendar API polling)
 * - NotionPoller (Notion API polling)
 */
export class ObserverManager {
  private readonly observers: Observer[] = [];
  /**
   * Pause-state tracks which observers were running at the moment
   * `pauseAll()` was invoked so `resumeAll()` only restarts the ones it
   * stopped — not observers that the user had
   * already disabled or that failed to start in the first place. A set
   * of names is enough because each observer's identity is its name.
   */
  private pausedNames: Set<string> | null = null;

  register(observer: Observer): void {
    this.observers.push(observer);
    logger.info({ observer: observer.name }, "Observer registered");
  }

  async startAll(): Promise<void> {
    const results = await Promise.allSettled(
      this.observers.map((o) => o.start()),
    );
    for (const [i, result] of results.entries()) {
      if (result.status === "rejected") {
        logger.error(
          { observer: this.observers[i].name, error: result.reason },
          "Failed to start observer",
        );
      } else {
        logger.info({ observer: this.observers[i].name }, "Observer started");
      }
    }
  }

  async stopAll(): Promise<void> {
    const results = await Promise.allSettled(
      this.observers.map((o) => o.stop()),
    );
    for (const [i, result] of results.entries()) {
      if (result.status === "rejected") {
        logger.error(
          { observer: this.observers[i].name, error: result.reason },
          "Failed to stop observer",
        );
      }
    }
  }

  /**
   * Migration hook — stops every registered observer and remembers the
   * set so `resumeAll()` can restart exactly those observers once the
   * migration commits or rolls back.
   *
   * Idempotent: a second `pauseAll()` before `resumeAll()` is a no-op
   * and preserves the original paused set. The migration endpoint uses
   * this pattern to guarantee `finally { resumeAll() }` works even when
   * an early-abort path retries pause.
   */
  async pauseAll(): Promise<void> {
    if (this.pausedNames !== null) {
      logger.debug(
        { count: this.pausedNames.size },
        "ObserverManager already paused — skipping re-pause",
      );
      return;
    }
    this.pausedNames = new Set(this.observers.map((o) => o.name));
    await this.stopAll();
    logger.info({ count: this.pausedNames.size }, "Observers paused");
  }

  /**
   * Restart observers that were running at `pauseAll()` time. If
   * `pauseAll()` was never called, this is a no-op — callers that always
   * pair pause/resume in a `try/finally` get safe behavior either way.
   */
  async resumeAll(): Promise<void> {
    if (this.pausedNames === null) {
      logger.debug("ObserverManager not paused — nothing to resume");
      return;
    }
    const toResume = this.observers.filter((o) => this.pausedNames!.has(o.name));
    this.pausedNames = null;
    const results = await Promise.allSettled(toResume.map((o) => o.start()));
    for (const [i, result] of results.entries()) {
      if (result.status === "rejected") {
        logger.error(
          { observer: toResume[i].name, error: result.reason },
          "Failed to resume observer after pause",
        );
      }
    }
    logger.info({ count: toResume.length }, "Observers resumed");
  }

  isPaused(): boolean {
    return this.pausedNames !== null;
  }

  has(name: string): boolean {
    return this.observers.some((o) => o.name === name);
  }

  getObservers(): readonly Observer[] {
    return this.observers;
  }

  /**
   * Hot-add path used by the integration delegation framework (§4.10
   * lifecycle): when `direct → delegated → direct` flips at runtime, we
   * register the observer AND start it without requiring a daemon
   * restart. Idempotent — re-registering a same-named observer is a no-op
   * so repeated PATCH calls don't pile duplicates.
   */
  async registerAndStart(observer: Observer): Promise<void> {
    if (this.has(observer.name)) {
      logger.debug(
        { observer: observer.name },
        "Observer already registered — skipping registerAndStart",
      );
      return;
    }
    this.register(observer);
    try {
      await observer.start();
      logger.info({ observer: observer.name }, "Observer started (hot-add)");
    } catch (err) {
      logger.error(
        { observer: observer.name, err },
        "Hot-add observer.start failed",
      );
      throw err;
    }
  }

  /**
   * Hot-remove path used by §4.10. Calls `stop()` on the named observer
   * and unregisters it ONLY when the stop resolves cleanly. If `stop()`
   * throws, the observer is left registered so the failure surfaces to
   * the caller (which logs + audits) and a future retry — or the daemon
   * shutdown's `stopAll()` — can take another swing at it.
   *
   * Returning `boolean` here was the old contract; it conflated three
   * outcomes (removed / absent / stop-failed-but-already-spliced) into
   * the same `true` answer and let an orphaned poller keep firing under
   * a new integration mode. See `StopAndUnregisterResult` for the
   * rationale and the three concrete cases.
   */
  async stopAndUnregister(name: string): Promise<StopAndUnregisterResult> {
    const idx = this.observers.findIndex((o) => o.name === name);
    if (idx < 0) return { status: "absent" };
    const target = this.observers[idx];
    try {
      await target.stop();
    } catch (err) {
      // Leave the observer in the registry so a retry can attempt the
      // stop again — `stopAll()` on daemon shutdown is the backstop.
      logger.error(
        { observer: name, err },
        "Hot-remove observer.stop failed — observer kept in registry for retry",
      );
      return { status: "stop_failed", error: err };
    }
    // Splice only AFTER a successful stop so the failure path above
    // can keep the observer reachable. Re-index defensively in case
    // `stop()` mutated the array (none of the current implementations
    // do, but we don't want to assume).
    const finalIdx = this.observers.indexOf(target);
    if (finalIdx >= 0) {
      this.observers.splice(finalIdx, 1);
    }
    logger.info({ observer: name }, "Observer stopped (hot-remove)");
    return { status: "removed" };
  }
}
