import type Database from "better-sqlite3";
import type { Observer } from "./manager.js";
import type { AgentWriteTracker } from "../safety/agent-write-tracker.js";
import {
  bootstrapEntityMirror,
  startEntityMirrorWatcher,
  type EntityMirrorWatcherHandle,
  type EntityMirrorWatcherOptions,
} from "../core/context/entity-mirror.js";
import { createLogger } from "../logging.js";

const logger = createLogger("entity-mirror-observer");

/**
 * P5 — entity-mirror observer (docs/design/21-management-registry-and-
 * entities.md §7.6).
 *
 * Wraps the §7.6 chokidar watcher in the {@link Observer} contract so
 * `ObserverManager` can manage its lifecycle alongside the other
 * change-detection observers (Obsidian, Git, Calendar). Two
 * responsibilities:
 *
 *   - **Boot pass**: walk the L2 tree once on `start()` to converge
 *     the mirror with disk (the §7.6 "MD wins on divergence" invariant).
 *     Logged with `scanned` / `upserted` / `deleted` counts so the
 *     dashboard surfaces the boot work.
 *   - **Watcher**: hand off to {@link startEntityMirrorWatcher}, which
 *     debounces fs events through chokidar and applies single-file
 *     refreshes within NFR-9's 500 ms budget.
 *
 * This observer is independent of the cron-driven
 * `context-index-reconciler-observer`: the activity-view + domain-
 * index reconcilers can run on a slow cadence, but the entity mirror
 * has to converge fast for the §7.6 lookup contract to be useful at
 * scheduled-task fire time.
 */
export class EntityMirrorObserver implements Observer {
  readonly name = "entity-mirror";

  private running = false;
  private watcher: EntityMirrorWatcherHandle | null = null;

  constructor(
    private readonly opts: {
      db: Database.Database;
      contextDir: string;
      writeTracker?: AgentWriteTracker;
      /**
       * Forwarded to {@link startEntityMirrorWatcher}. The daemon wires
       * this to the context-index reconciler so a §7.6 entity write
       * triggers the §7.2 chain (domain-index + activity-view) — see
       * the option doc on {@link EntityMirrorWatcherOptions} for the
       * fan-out-safety argument.
       */
      onEntityChanged?: EntityMirrorWatcherOptions["onEntityChanged"];
      /**
       * Test seam — forwarded to {@link startEntityMirrorWatcher} so
       * unit tests can inject a deterministic watcher without booting
       * chokidar.
       */
      watcherFactory?: EntityMirrorWatcherOptions["watcherFactory"];
    },
  ) {}

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    try {
      const result = bootstrapEntityMirror({
        db: this.opts.db,
        contextDir: this.opts.contextDir,
      });
      logger.info(
        {
          scanned: result.scanned,
          upserted: result.upserted,
          deleted: result.deleted,
          durationMs: result.durationMs,
        },
        "entity-mirror boot pass completed",
      );
    } catch (err) {
      logger.error({ err }, "entity-mirror boot pass failed");
    }

    this.watcher = startEntityMirrorWatcher({
      db: this.opts.db,
      contextDir: this.opts.contextDir,
      writeTracker: this.opts.writeTracker,
      onEntityChanged: this.opts.onEntityChanged,
      watcherFactory: this.opts.watcherFactory,
    });
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    if (this.watcher) {
      const watcher = this.watcher;
      this.watcher = null;
      await watcher.stop();
    }
  }
}
