import type Database from "better-sqlite3";
import {
  createEvent,
  EventPriority,
  type AgentTaskEvent,
} from "@aitne/shared";
import type { EventBus } from "../core/event-bus.js";
import {
  listManagementDueForScan,
  markManagementScanQueued,
  recordManagementScan,
  type RepositoryDTO,
} from "../db/repositories-store.js";
import {
  runRepositoryManagementScan,
} from "../core/repository-management-docs.js";
import type { AgentWriteTracker } from "../safety/agent-write-tracker.js";
import { gitRepoJournalPath, gitRepoOverviewPath } from "../core/context-paths.js";
import { createLogger } from "../logging.js";
import type { Observer } from "./manager.js";

const logger = createLogger("repository-management-cron");

export const REPOSITORY_MANAGEMENT_CRON_OBSERVER_NAME =
  "repository-management-cron";
export const REPOSITORY_MANAGEMENT_PROCESS_KEY = "git.project.update";

const DAY_MS = 24 * 60 * 60 * 1000;
const MIN_TICK_INTERVAL_SECONDS = 60;

export interface RepositoryManagementCronOptions {
  db: Database.Database;
  eventBus: EventBus;
  /**
   * Tick cadence for the cron itself (seconds). Defaults to 1 hour — the
   * cron iterates the table on every tick and only fires for rows whose
   * `last_scan_at` is more than `intervalMs` ago, so a tighter cron tick
   * is harmless and ensures a row that flips to `enabled=1` mid-day is
   * picked up reasonably quickly.
   */
  tickIntervalSeconds?: number;
  /**
   * Per-repo scan interval (ms). Default 24h matches design §4.5
   * "1×/day per enabled row".
   */
  scanIntervalMs?: number;
  now?: () => Date;
  /**
   * When provided, the cron writes the required markdown artifacts directly
   * instead of relying on an autonomous backend session to do the write.
   * Tests that exercise the legacy EventBus scheduling path omit this.
   */
  contextDir?: string | (() => string);
  timezone?: string;
  writeTracker?: AgentWriteTracker;
  onIndexableContextChange?: (path: string) => void;
}

/**
 * Daily-scan dispatcher for unified repositories whose
 * `repository_management.enabled = 1`. See
 * `docs/design/appendices/unified-repositories.md` §4.5.
 *
 * Iterates `repository_management` rows that:
 *   1. are enabled,
 *   2. have a non-null `local_path` on the parent repository,
 *   3. were last scanned more than `scanIntervalMs` ago (or never).
 *
 * For each match, emits a `scheduled.task` event with the
 * `git.project.update` process key. The dispatcher's task-flow + run
 * endpoint owns the actual session spawn; this observer only schedules
 * the work.
 */
export class RepositoryManagementCron implements Observer {
  readonly name = REPOSITORY_MANAGEMENT_CRON_OBSERVER_NAME;

  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private stopped = false;
  private readonly tickIntervalSeconds: number;
  private readonly scanIntervalMs: number;
  private readonly now: () => Date;

  constructor(private readonly options: RepositoryManagementCronOptions) {
    this.tickIntervalSeconds = Math.max(
      MIN_TICK_INTERVAL_SECONDS,
      Math.floor(options.tickIntervalSeconds ?? 3600),
    );
    this.scanIntervalMs = options.scanIntervalMs ?? DAY_MS;
    this.now = options.now ?? (() => new Date());
  }

  async start(): Promise<void> {
    if (this.timer || this.stopped) return;
    this.scheduleNext(this.tickIntervalSeconds);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /**
   * Run the iterator once. Returns the number of events emitted.
   * Exposed for tests and the manual `POST .../management/scan` path.
   */
  async tick(): Promise<number> {
    if (this.running || this.stopped) return 0;
    this.running = true;
    try {
      const due = listManagementDueForScan(
        this.options.db,
        this.scanIntervalMs,
        this.now().getTime(),
      );
      let emitted = 0;
      for (const row of due) {
        try {
          // Optimistic pre-fire mark — prevents the next tick from
          // re-emitting the same scan if dispatch is slow or the
          // task-flow crashes silently. Dispatcher finalizer flips
          // `last_scan_status` on terminal completion.
          markManagementScanQueued(
            this.options.db,
            row.id,
            this.now().getTime(),
          );
          if (this.options.contextDir) {
            const result = await runRepositoryManagementScan({
              db: this.options.db,
              repo: row,
              contextDir: this.resolveContextDir(),
              now: this.now(),
              timezone: this.options.timezone,
              writeTracker: this.options.writeTracker,
              onIndexableContextChange: this.options.onIndexableContextChange,
            });
            recordManagementScan(
              this.options.db,
              row.id,
              result.status === "skipped_no_activity"
                ? "skipped_no_activity"
                : "ok",
              this.now().getTime(),
            );
          } else {
            const event = this.buildEvent(row);
            await this.options.eventBus.put(event);
          }
          emitted += 1;
        } catch (err) {
          recordManagementScan(this.options.db, row.id, "failed", this.now().getTime());
          logger.warn(
            { err, repositoryId: row.id },
            "Failed to run repository management scan",
          );
        }
      }
      if (emitted > 0) {
        logger.info({ emitted }, "Processed repository management scans");
      }
      return emitted;
    } catch (err) {
      logger.warn({ err }, "Repository management cron tick failed");
      return 0;
    } finally {
      this.running = false;
    }
  }

  private scheduleNext(delaySeconds: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.tick().finally(() =>
        this.scheduleNext(this.tickIntervalSeconds),
      );
    }, delaySeconds * 1000);
    this.timer.unref?.();
  }

  private resolveContextDir(): string {
    const value = this.options.contextDir;
    if (typeof value === "function") return value();
    if (typeof value === "string") return value;
    throw new Error("contextDir is required for direct repository management scans");
  }

  private buildEvent(row: RepositoryDTO): AgentTaskEvent {
    const now = this.now();
    const base = createEvent({
      type: "scheduled.task",
      source: REPOSITORY_MANAGEMENT_CRON_OBSERVER_NAME,
      priority: EventPriority.NORMAL,
    });
    return {
      ...base,
      task: `Run daily git management scan for ${row.slug}.`,
      taskContext: {
        triggerSource: "repository_management_cron",
        processKey: REPOSITORY_MANAGEMENT_PROCESS_KEY,
        repository: {
          id: row.id,
          slug: row.slug,
          localPath: row.localPath,
          githubRepo:
            row.githubOwner && row.githubRepo
              ? `${row.githubOwner}/${row.githubRepo}`
              : null,
          classification: row.classification,
          category: row.category,
          pollPriority: row.pollPriority,
        },
        repositoryId: row.id,
        slug: row.slug,
        localPath: row.localPath,
        githubRepo:
          row.githubOwner && row.githubRepo
            ? `${row.githubOwner}/${row.githubRepo}`
            : null,
        classification: row.classification,
        category: row.category,
        overviewPath: gitRepoOverviewPath(row.slug),
        journalPath: gitRepoJournalPath(row.slug, now.toISOString().slice(0, 10)),
        lookbackHours: 24,
        firedAt: now.toISOString(),
      },
    };
  }
}
