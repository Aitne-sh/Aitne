import type Database from "better-sqlite3";
import type { AgentWriteTracker } from "../safety/agent-write-tracker.js";
import type { Observer } from "./manager.js";
import { ObsidianWatcher } from "./obsidian-watcher.js";
import { createLogger } from "../logging.js";

const logger = createLogger("primary-vault-watcher");

/**
 * Factory signature for the inner chokidar-backed watcher. Injectable
 * so unit tests can assert the wiring (path changes → new inner
 * watcher with the new path) without running chokidar/FSEvents.
 */
export type InnerWatcherFactory = (
  vaultPath: string,
  db: Database.Database,
  debounceSeconds: number,
  writeTracker: AgentWriteTracker | undefined,
  name: string,
) => Observer;

const defaultInnerFactory: InnerWatcherFactory = (
  vaultPath,
  db,
  debounceSeconds,
  writeTracker,
  name,
) =>
  new ObsidianWatcher(vaultPath, db, debounceSeconds, writeTracker, {
    name,
    source: "obsidian:primary",
  });

export interface PrimaryVaultWatcherOptions {
  /** Override the inner watcher factory. Production code never sets this. */
  innerFactory?: InnerWatcherFactory;
}

/**
 * Primary-vault watcher — observes user-originated edits to the agent's
 * primary management vault when `vaultMode === "obsidian"`.
 *
 * Responsibilities:
 *   - Hold the currently-targeted vault path.
 *   - Start/stop an inner `ObsidianWatcher` tagged with
 *     `source: "obsidian:primary"`.
 *   - Re-target on path change via `setVaultPath` — called by
 *     `/api/setup/migrate-context` after a successful vault migration.
 *     The watcher restarts itself atomically only when it was running
 *     at the time of the call; otherwise it just stores the new path
 *     so the next `start()` picks it up.
 *
 * Design notes:
 *   - The watcher does NOT peek at `AgentConfig` on its own. Previously
 *     it captured the config reference and relied on `Object.assign`
 *     mutation happening before `resumeAll()` — correct in practice
 *     but fragile across refactors. Making the path update explicit
 *     gives any current or future settings-mutation call site a single,
 *     named plumbing point.
 *   - `start()` and `stop()` remain idempotent and tolerant of being
 *     called while the target path is null (plain mode); they become
 *     no-ops in that branch.
 */
export class PrimaryVaultWatcher implements Observer {
  readonly name = "obsidian:primary";
  private vaultPath: string | null = null;
  private inner: Observer | null = null;
  private running = false;
  private readonly innerFactory: InnerWatcherFactory;

  constructor(
    private readonly db: Database.Database,
    private readonly debounceSeconds: number,
    private readonly writeTracker?: AgentWriteTracker,
    options: PrimaryVaultWatcherOptions = {},
  ) {
    this.innerFactory = options.innerFactory ?? defaultInnerFactory;
  }

  /**
   * Current targeted vault path, or `null` in plain mode / when the
   * primary path is unset. Exposed for diagnostics (e.g. the health
   * monitor can surface "watcher targeting foo/bar").
   */
  getVaultPath(): string | null {
    return this.vaultPath;
  }

  /**
   * Point the watcher at a new vault path. Callers MUST invoke this
   * whenever `primaryVaultPath` changes — the migration endpoint wires
   * it via its `onPrimaryVaultPathChange` callback, and the startup
   * sequence calls it once with the config-loaded value.
   *
   * A value equal to the current path is a no-op; `null` detaches the
   * watcher from any directory (plain mode). When the watcher is
   * currently running, the inner chokidar instance is torn down and
   * recreated with the new path atomically so no events are observed
   * against a stale target.
   */
  async setVaultPath(newPath: string | null): Promise<void> {
    const normalized = newPath && newPath.length > 0 ? newPath : null;
    if (normalized === this.vaultPath) return;
    this.vaultPath = normalized;
    if (!this.running) {
      logger.debug(
        { vaultPath: normalized },
        "primary vault path updated while stopped",
      );
      return;
    }
    await this.teardownInner();
    await this.spinUpInnerIfTargeted();
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    await this.spinUpInnerIfTargeted();
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    await this.teardownInner();
    logger.info("primary vault watcher stopped");
  }

  private async spinUpInnerIfTargeted(): Promise<void> {
    if (!this.vaultPath) {
      logger.debug("primary vault watcher dormant (no target path)");
      return;
    }
    this.inner = this.innerFactory(
      this.vaultPath,
      this.db,
      this.debounceSeconds,
      this.writeTracker,
      this.name,
    );
    await this.inner.start();
    logger.info(
      { path: this.vaultPath },
      "primary vault watcher started",
    );
  }

  private async teardownInner(): Promise<void> {
    if (!this.inner) return;
    const inner = this.inner;
    this.inner = null;
    try {
      await inner.stop();
    } catch (err) {
      logger.error({ err }, "failed to stop inner watcher during teardown");
    }
  }
}
