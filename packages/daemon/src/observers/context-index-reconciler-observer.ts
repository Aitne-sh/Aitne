import * as chokidar from "chokidar";
import { existsSync } from "node:fs";
import { extname } from "node:path";
import type Database from "better-sqlite3";
import type { Observer } from "./manager.js";
import type { AgentWriteTracker } from "../safety/agent-write-tracker.js";
import type { TodayWriteLockManager } from "../core/today-write-lock.js";
import {
  runReconciler,
  type ReconcilerTrigger,
  type ReconcilerRunRecord,
} from "../core/context/reconciler-runner.js";
import { runPolicyIndexReconciler } from "../core/context/policy-index-runner.js";
import { runDomainIndexReconciler } from "../core/context/domain-index-runner.js";
import { runActivityViewReconciler } from "../core/context/activity-view-runner.js";
import { shouldIndexPath } from "../core/context/index-reconciler.js";
import { CONTEXT_RELATIVE_PATHS } from "../core/context-paths.js";
import type { PromptContextChangedCallback } from "../core/context-staleness.js";
import { createLogger } from "../logging.js";

const logger = createLogger("context-index-reconciler");

/** Delay before the startup one-shot run fires (§4.1). */
const STARTUP_DELAY_MS = 30 * 1000;
/** Debounce for filesystem events coalescing into a single reconcile (§4.1). */
const FS_EVENT_DEBOUNCE_MS = 10 * 1000;
/** If the morning routine lock is held when cron fires, re-try after this delay. */
const MORNING_LOCK_RETRY_MS = 5 * 60 * 1000;

export interface ContextIndexReconcilerObserverOptions {
  db: Database.Database;
  contextDir: string;
  writeTracker?: AgentWriteTracker;
  onPromptContextChanged?: PromptContextChangedCallback;
  /**
   * Morning-routine lock accessor — when the lock is held, the cron
   * trigger defers by `MORNING_LOCK_RETRY_MS` so the morning routine
   * can finish editing the index first (§4.6).
   */
  morningRoutineLock?: TodayWriteLockManager;
  timezone?: string;
  /**
   * Test seam — override the FS watcher factory so tests can drive the
   * observer end-to-end without chokidar spinning up real FSEvents.
   */
  watcherFactory?: (contextDir: string) => FileWatcher;
}

export interface FileWatcher {
  onChange(handler: (relativePath: string) => void): void;
  close(): Promise<void>;
}

/**
 * B-004 Phase 2a — context-index reconciler observer (§5.4).
 *
 * Owns three trigger sources and debounces all of them through a single
 * latch so the reconciler never runs twice in parallel:
 *   - Startup — a one-shot run 30 s after `start()`.
 *   - FS events — chokidar emits under the context directory coalesced
 *     into one run every 10 s.
 *   - External hints — `requestReconcile("hint")` called from the
 *     `/api/context/*` route after a write/delete.
 *
 * Cron registration lives in `AgentScheduler` — the reconciler callback
 * it wires up calls into this observer so the FS subscription and the
 * cron tick share the same run-once guard.
 */
export class ContextIndexReconcilerObserver implements Observer {
  readonly name = "context-index-reconciler";

  private running = false;
  private watcher: FileWatcher | null = null;
  private startupTimer: ReturnType<typeof setTimeout> | null = null;
  private fsDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimers = new Set<ReturnType<typeof setTimeout>>();
  private inFlight = false;
  /**
   * Latches a trigger that fired while a reconcile run was in flight so
   * the same run-once guard can fire a follow-up immediately on
   * completion (§4.6).
   */
  private pendingTrigger: ReconcilerTrigger | null = null;

  constructor(private readonly opts: ContextIndexReconcilerObserverOptions) {}

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    // Chokidar watcher — create ours rather than piggybacking on
    // `PrimaryVaultWatcher`/`ObsidianWatcher`. Those emit observations to
    // the DB and have no pub/sub surface; standing up an isolated watcher
    // on `contextDir` keeps coupling narrow and the debounce local.
    if (!existsSync(this.opts.contextDir)) {
      logger.warn(
        { contextDir: this.opts.contextDir },
        "Reconciler observer started but contextDir is missing — FS watcher deferred to next start()",
      );
    } else {
      const factory = this.opts.watcherFactory ?? defaultWatcherFactory;
      this.watcher = factory(this.opts.contextDir);
      this.watcher.onChange((relativePath) => this.handleFsEvent(relativePath));
    }

    // Startup one-shot run — waits 30 s so the daemon finishes booting
    // (migrations, skeleton ensureSkeletonFiles, etc.) before sweeping.
    this.startupTimer = setTimeout(() => {
      this.startupTimer = null;
      this.requestReconcile("startup");
    }, STARTUP_DELAY_MS);
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;

    if (this.startupTimer) {
      clearTimeout(this.startupTimer);
      this.startupTimer = null;
    }
    if (this.fsDebounceTimer) {
      clearTimeout(this.fsDebounceTimer);
      this.fsDebounceTimer = null;
    }
    for (const timer of this.retryTimers) {
      clearTimeout(timer);
    }
    this.retryTimers.clear();
    if (this.watcher) {
      const watcher = this.watcher;
      this.watcher = null;
      try {
        await watcher.close();
      } catch (err) {
        logger.warn({ err }, "Reconciler watcher close failed");
      }
    }
  }

  /**
   * External entry point. Cron callback calls `requestReconcile("cron")`;
   * context-route hints call `requestReconcile("manual")`. A second call
   * while a run is in flight latches the most-recent trigger and fires
   * once the current run completes (§4.6).
   */
  requestReconcile(trigger: ReconcilerTrigger): void {
    if (!this.running) return;
    if (trigger === "cron" && this.opts.morningRoutineLock?.getHolder()) {
      logger.info(
        { delayMs: MORNING_LOCK_RETRY_MS },
        "Deferring cron reconcile — morning routine lock held",
      );
      const timer = setTimeout(() => {
        this.retryTimers.delete(timer);
        this.requestReconcile("cron");
      }, MORNING_LOCK_RETRY_MS);
      this.retryTimers.add(timer);
      return;
    }
    if (this.inFlight) {
      this.pendingTrigger = trigger;
      return;
    }
    void this.runOnce(trigger);
  }

  private handleFsEvent(relativePath: string): void {
    if (!this.running) return;
    if (extname(relativePath) !== ".md") return;
    // Ignore events for paths we already do not index — the walker will
    // never surface them so a reconcile pass would be a no-op anyway.
    if (
      relativePath !== CONTEXT_RELATIVE_PATHS.contextIndex &&
      !shouldIndexPath(relativePath)
    ) {
      return;
    }
    if (this.fsDebounceTimer) {
      clearTimeout(this.fsDebounceTimer);
    }
    this.fsDebounceTimer = setTimeout(() => {
      this.fsDebounceTimer = null;
      this.requestReconcile("fs_event");
    }, FS_EVENT_DEBOUNCE_MS);
  }

  private async runOnce(trigger: ReconcilerTrigger): Promise<ReconcilerRunRecord | null> {
    this.inFlight = true;
    try {
      const record = await runReconciler({
        db: this.opts.db,
        contextDir: this.opts.contextDir,
        writeTracker: this.opts.writeTracker,
        onPromptContextChanged: this.opts.onPromptContextChanged,
        timezone: this.opts.timezone,
        trigger,
      });
      // MANAGEMENT-POLICY-CAPTURE-PLAN §9 P4 — chain the policy-index
      // reconciler off the same trigger latch. Both reconcilers walk the
      // FS so running them sequentially under the shared inFlight guard
      // prevents two redundant chokidar fan-outs (the policy-index
      // runner's writes would otherwise wake the FS watcher again). Each
      // runner has its own per-process mutex + runtime_state row, so an
      // error in one doesn't suppress the other.
      try {
        await runPolicyIndexReconciler({
          db: this.opts.db,
          contextDir: this.opts.contextDir,
          writeTracker: this.opts.writeTracker,
          onPromptContextChanged: this.opts.onPromptContextChanged,
          timezone: this.opts.timezone,
          trigger,
        });
      } catch (err) {
        logger.error(
          { err, trigger },
          "Policy-index reconciler threw unexpectedly",
        );
      }
      // docs/design/21-management-registry-and-entities.md §7.2 P5 —
      // chain the domain-index and activity-view reconcilers off the
      // same trigger latch. Same rationale as the policy-index chain
      // above: shared inFlight guard prevents fan-out, each runner has
      // its own mutex + runtime_state row, errors don't cascade.
      try {
        await runDomainIndexReconciler({
          db: this.opts.db,
          contextDir: this.opts.contextDir,
          writeTracker: this.opts.writeTracker,
          onPromptContextChanged: this.opts.onPromptContextChanged,
          timezone: this.opts.timezone,
          trigger,
        });
      } catch (err) {
        logger.error(
          { err, trigger },
          "Domain-index reconciler threw unexpectedly",
        );
      }
      try {
        await runActivityViewReconciler({
          db: this.opts.db,
          contextDir: this.opts.contextDir,
          writeTracker: this.opts.writeTracker,
          onPromptContextChanged: this.opts.onPromptContextChanged,
          timezone: this.opts.timezone,
          trigger,
        });
      } catch (err) {
        logger.error(
          { err, trigger },
          "Activity-view reconciler threw unexpectedly",
        );
      }
      return record;
    } catch (err) {
      logger.error({ err, trigger }, "Reconciler run threw unexpectedly");
      return null;
    } finally {
      this.inFlight = false;
      const next = this.pendingTrigger;
      this.pendingTrigger = null;
      if (next !== null) {
        void this.runOnce(next);
      }
    }
  }
}

function defaultWatcherFactory(contextDir: string): FileWatcher {
  const watcher = chokidar.watch(contextDir, {
    ignored: ["**/.git/**", "**/.obsidian/**", "**/.DS_Store"],
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: {
      stabilityThreshold: 500,
      pollInterval: 100,
    },
  });

  const handlers: Array<(relativePath: string) => void> = [];
  const emit = (absolutePath: string) => {
    const relative = absolutePath.startsWith(contextDir)
      ? absolutePath.slice(contextDir.length + 1)
      : absolutePath;
    for (const handler of handlers) handler(relative);
  };

  watcher
    .on("add", emit)
    .on("unlink", emit)
    .on("change", emit);

  return {
    onChange(handler) {
      handlers.push(handler);
    },
    async close() {
      await watcher.close();
    },
  };
}
