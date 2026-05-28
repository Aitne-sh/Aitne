import type Database from "better-sqlite3";
import type { AgentConfig } from "../../../config.js";
import type { Observer } from "../../../observers/manager.js";
import {
  readBrowserLifecycleState,
  writeBrowserHistoryCapabilities,
  writeBrowserHistoryLastIngestAt,
  writeBrowserLifecycleState,
} from "../../../db/browser-history-store.js";
import { createLogger } from "../../../logging.js";
import {
  computeBrowserHistoryIngestEnabled,
  detectBrowserHistoryCapabilities,
  serializeBrowserHistoryCapabilities,
  browserHistoryCacheRoot,
} from "../detectors/registry.js";
import type {
  BrowserDetectionResult,
  BrowserLifecycleTelemetry,
  BrowserProfileCandidate,
  HostProfile,
} from "../types.js";
import { createHostProfile } from "./platform.js";
import { checkBrowserProfileHealth } from "./health-check.js";
import { launchChromiumProfile, terminateLaunchedChromium } from "./chromium-launcher.js";
import { nextBrowserLifecycleState } from "./failure-escalation.js";
import {
  cleanupStaleBrowserHistorySnapshots,
  createBrowserHistorySnapshot,
} from "../readers/snapshot.js";
import { assertChromiumHistorySchema } from "../readers/chromium-reader.js";

const logger = createLogger("browser-lifecycle-supervisor");

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseClock(value: string): number | null {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return hour * 60 + minute;
}

function isQuietHoursNow(config: Pick<AgentConfig, "quietHoursStart" | "quietHoursEnd">): boolean {
  const start = parseClock(config.quietHoursStart);
  const end = parseClock(config.quietHoursEnd);
  if (start === null || end === null || start === end) return false;
  const now = new Date();
  const minute = now.getHours() * 60 + now.getMinutes();
  if (start < end) return minute >= start && minute < end;
  return minute >= start || minute < end;
}

function profileAllowed(
  config: AgentConfig["browserHistoryLifecycle"],
  profile: BrowserProfileCandidate,
): boolean {
  const perBrowser = config.per_browser[profile.browser];
  if (perBrowser?.enabled === false) return false;
  const tracked = perBrowser?.profiles_to_track ?? [];
  return tracked.length === 0 || tracked.includes(profile.profileName);
}

function waitSecondsForProfile(
  config: AgentConfig["browserHistoryLifecycle"],
  profile: BrowserProfileCandidate,
): number {
  if (profile.browser === "comet" || profile.browser === "atlas") {
    return config.per_browser[profile.browser]?.sync_flush_wait_seconds ?? 5;
  }
  return config.per_browser[profile.browser]?.sync_flush_wait_seconds ?? 60;
}

async function runWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<void>,
): Promise<void> {
  const boundedLimit = Math.max(1, Math.floor(limit));
  for (let index = 0; index < items.length; index += boundedLimit) {
    await Promise.all(items.slice(index, index + boundedLimit).map(task));
  }
}

export class BrowserLifecycleSupervisor implements Observer {
  readonly name = "browser-lifecycle-supervisor";

  private timer: ReturnType<typeof setInterval> | null = null;
  private host: HostProfile;
  private detectionResults: BrowserDetectionResult[] = [];
  private running = false;
  private tickInFlight = false;

  constructor(
    private readonly db: Database.Database,
    private readonly config: AgentConfig,
    host: HostProfile = createHostProfile(),
  ) {
    this.host = host;
  }

  async start(): Promise<void> {
    this.running = true;
    // Drop any `history-*` snapshot dirs the previous process left
    // behind on a crash. The directories are private to the daemon and
    // their contents are regenerable from the live browser profile, so
    // this is safe; errors here are non-fatal — bootstrap continues.
    try {
      const removed = await cleanupStaleBrowserHistorySnapshots(
        browserHistoryCacheRoot(this.config.dataDir),
      );
      if (removed > 0) {
        logger.info({ removed }, "Removed stale browser-history snapshot directories");
      }
    } catch (err) {
      logger.warn({ err }, "Boot-time stale snapshot cleanup failed");
    }
    await this.redetect();
    void this.tick();
    this.timer = setInterval(
      () => void this.tick(),
      this.config.browserHistoryLifecycle.check_interval_minutes * 60 * 1000,
    );
    this.timer.unref?.();
    logger.info(
      {
        intervalMinutes: this.config.browserHistoryLifecycle.check_interval_minutes,
      },
      "Browser lifecycle supervisor started",
    );
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    logger.info("Browser lifecycle supervisor stopped");
  }

  async redetect(): Promise<void> {
    const { capabilities, results } = await detectBrowserHistoryCapabilities({
      db: this.db,
      config: this.config,
      host: this.host,
    });
    this.detectionResults = results;
    writeBrowserHistoryCapabilities(this.db, capabilities);
  }

  private refreshCapabilities(): void {
    const ingestEnabled = computeBrowserHistoryIngestEnabled(
      this.db,
      this.config,
      this.detectionResults,
    );
    const capabilities = serializeBrowserHistoryCapabilities(
      new Date().toISOString(),
      this.detectionResults,
      ingestEnabled,
    );
    writeBrowserHistoryCapabilities(this.db, capabilities);
  }

  private async tick(): Promise<void> {
    if (!this.running || this.tickInFlight) return;
    this.tickInFlight = true;
    try {
      this.refreshCapabilities();
      if (!this.config.browserHistoryLifecycle.enabled) return;
      const ingestEnabled = computeBrowserHistoryIngestEnabled(
        this.db,
        this.config,
        this.detectionResults,
      );
      if (ingestEnabled.length === 0) return;
      const quiet =
        this.config.browserHistoryLifecycle.respect_quiet_hours
        && isQuietHoursNow(this.config);
      const profilesToSync: BrowserProfileCandidate[] = [];
      for (const browser of ingestEnabled) {
        const result = this.detectionResults.find((entry) => entry.browser === browser);
        if (!result) continue;
        const profiles = result.profiles.filter((profile) =>
          profileAllowed(this.config.browserHistoryLifecycle, profile),
        );
        profilesToSync.push(...profiles);
      }
      await runWithConcurrency(
        profilesToSync,
        this.config.browserHistoryLifecycle.max_concurrent_launches,
        (profile) => this.runProfileCycle(profile, quiet),
      );
    } catch (err) {
      logger.error({ err }, "Browser lifecycle tick failed");
    } finally {
      this.tickInFlight = false;
    }
  }

  private async runProfileCycle(
    profile: BrowserProfileCandidate,
    quiet: boolean,
  ): Promise<void> {
    const started = Date.now();
    const lifecycle = readBrowserLifecycleState(this.db);
    const prior = lifecycle[profile.browser];
    if (
      prior?.state === "lifecycle_paused"
      && prior.pausedUntil
      && prior.pausedUntil > started
    ) {
      this.recordTelemetry({
        browser: profile.browser,
        stateBefore: "paused",
        actionTaken: "skip",
        syncMtimeBefore: profile.lastHistoryMtimeMs,
        syncMtimeAfter: profile.lastHistoryMtimeMs,
        syncAgeAtIngestSeconds: null,
        rowsIngested: 0,
        durationMs: 0,
        outcome: "paused",
      });
      return;
    }

    const healthBefore = await checkBrowserProfileHealth(this.host, profile, started);
    let actionTaken: BrowserLifecycleTelemetry["actionTaken"] = "noop";
    let outcome: BrowserLifecycleTelemetry["outcome"] = "success";
    let error: string | undefined;
    // Captured when the supervisor spawned Chromium itself (vs. found
    // it already running). The `finally` block below terminates this
    // PID — without it the daemon-launched Chrome lingers in the
    // user's dock after every cycle and 24h later starts producing
    // `sync_unresponsive` events because no actual browsing advances
    // the History mtime.
    //
    // Scope of this recovery: this only covers Chromes the supervisor
    // launched during *this* cycle. Pre-existing Chromes (launched by
    // an earlier daemon process and orphaned across a restart, or
    // started by the user / a LaunchAgent) are left alone — we have
    // no in-memory PID to verify they were ours, and killing a
    // user-launched Chrome would be unacceptable. Users in that state
    // recover by quitting Chrome once manually, after which subsequent
    // supervisor launches self-clean.
    let spawnedPid: number | null = null;

    try {
      if (!healthBefore.running && quiet) {
        actionTaken = "skip";
        outcome = "skipped";
      } else if (!healthBefore.running) {
        actionTaken = "launch";
        const launched = await launchChromiumProfile(this.host, profile);
        if (launched.outcome === "missing_binary") {
          outcome = "launch_failed";
        } else if (launched.outcome === "already_running") {
          // The pre-launch health probe raced a user-initiated start
          // (Finder / Dock / restored-session). Chromium is up but we
          // did not spawn it, so the mtime advancement gate below would
          // false-positive `sync_unresponsive`. Treat as a noop — the
          // next tick will see the live SingletonLock through
          // `checkBrowserProfileHealth` and route via the running path.
          actionTaken = "noop";
        } else {
          spawnedPid = launched.pid;
          await sleep(waitSecondsForProfile(this.config.browserHistoryLifecycle, profile) * 1000);
          // BROWSER_HISTORY_INTEGRATION_PLAN.md §7.4.3 — post-launch
          // mtime advancement gate. If the History file has not been
          // touched after the configured flush window the browser
          // process is up but cloud sync has not made progress; surface
          // this as `sync_unresponsive` so failure-escalation kicks in
          // after the design's three consecutive-failures threshold.
          // Pre-launch mtime captured in `healthBefore.historyMtimeMs`
          // is the baseline; a NULL there means the History file did
          // not exist yet, in which case any non-NULL after-mtime is
          // progress.
          const postLaunchHealth = await checkBrowserProfileHealth(
            this.host,
            profile,
            Date.now(),
          );
          const beforeMtime = healthBefore.historyMtimeMs;
          const afterMtime = postLaunchHealth.historyMtimeMs;
          const advanced =
            afterMtime !== null
            && (beforeMtime === null || afterMtime > beforeMtime);
          if (!advanced) outcome = "sync_unresponsive";
        }
      } else if (healthBefore.stale) {
        outcome = "sync_unresponsive";
      }

      if (outcome === "success") {
        await this.validateSnapshot(profile);
        writeBrowserHistoryLastIngestAt(this.db, Date.now());
      }
      const healthAfter = await checkBrowserProfileHealth(this.host, profile, Date.now());
      this.applyLifecycleState(profile.browser, outcome, actionTaken, started);
      this.recordTelemetry({
        browser: profile.browser,
        stateBefore: healthBefore.running
          ? (healthBefore.stale ? "stale" : "running")
          : "stopped",
        actionTaken,
        syncMtimeBefore: healthBefore.historyMtimeMs,
        syncMtimeAfter: healthAfter.historyMtimeMs,
        syncAgeAtIngestSeconds: healthAfter.syncAgeSeconds,
        rowsIngested: 0,
        durationMs: Date.now() - started,
        outcome,
      });
    } catch (err) {
      error = err instanceof Error ? err.message : "browser lifecycle failed";
      outcome = "error";
      this.applyLifecycleState(profile.browser, outcome, actionTaken, started);
      this.recordTelemetry({
        browser: profile.browser,
        stateBefore: healthBefore.running
          ? (healthBefore.stale ? "stale" : "running")
          : "stopped",
        actionTaken,
        syncMtimeBefore: healthBefore.historyMtimeMs,
        syncMtimeAfter: null,
        syncAgeAtIngestSeconds: null,
        rowsIngested: 0,
        durationMs: Date.now() - started,
        outcome,
        error,
      });
    } finally {
      if (spawnedPid !== null) {
        const terminationResult = await terminateLaunchedChromium(
          this.host,
          profile,
          spawnedPid,
        ).catch((err) => {
          logger.warn(
            { err, browser: profile.browser, spawnedPid },
            "Chromium terminate threw",
          );
          return "failed" as const;
        });
        if (terminationResult === "ownership_changed") {
          logger.info(
            { browser: profile.browser, spawnedPid },
            "Skipping Chromium terminate — SingletonLock owner changed mid-flush (user opened the browser)",
          );
        } else if (terminationResult === "failed") {
          logger.warn(
            { browser: profile.browser, spawnedPid },
            "Daemon-launched Chromium failed to exit after SIGKILL — will retry next tick",
          );
        }
      }
    }
  }

  private async validateSnapshot(profile: BrowserProfileCandidate): Promise<number> {
    const snapshot = await createBrowserHistorySnapshot(
      profile.historyPath,
      browserHistoryCacheRoot(this.config.dataDir),
    );
    try {
      return assertChromiumHistorySchema(snapshot.mainPath).visitCount;
    } finally {
      await snapshot.cleanup();
    }
  }

  private applyLifecycleState(
    browser: BrowserProfileCandidate["browser"],
    outcome: BrowserLifecycleTelemetry["outcome"],
    actionTaken: BrowserLifecycleTelemetry["actionTaken"],
    nowMs: number,
  ): void {
    const state = readBrowserLifecycleState(this.db);
    const prior = state[browser];
    const next = nextBrowserLifecycleState({
      state: prior?.state ?? "stopped",
      consecutiveFailures: prior?.consecutiveFailures ?? 0,
      nowMs,
      outcome,
    });
    state[browser] = {
      ...prior,
      ...next,
      lastLaunchAt: actionTaken === "launch" ? nowMs : (prior?.lastLaunchAt ?? next.lastLaunchAt),
      lastSuccessfulSyncAt:
        next.lastSuccessfulSyncAt ?? prior?.lastSuccessfulSyncAt ?? null,
    };
    writeBrowserLifecycleState(this.db, state);
  }

  private recordTelemetry(telemetry: BrowserLifecycleTelemetry): void {
    try {
      this.db
        .prepare(
          `INSERT INTO agent_actions
             (action_type, trigger, result, detail, duration_ms, completed_at, source_kind)
           VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?)`,
        )
        .run(
          `browser_lifecycle.${telemetry.browser}`,
          "browser_lifecycle",
          telemetry.outcome === "success" || telemetry.outcome === "skipped"
            ? "success"
            : telemetry.outcome === "paused"
              ? "skipped"
              : "failed",
          JSON.stringify({
            state_before: telemetry.stateBefore,
            action_taken: telemetry.actionTaken,
            sync_mtime_before: telemetry.syncMtimeBefore,
            sync_mtime_after: telemetry.syncMtimeAfter,
            sync_age_at_ingest_seconds: telemetry.syncAgeAtIngestSeconds,
            rows_ingested: telemetry.rowsIngested,
            duration_ms: telemetry.durationMs,
            outcome: telemetry.outcome,
            ...(telemetry.error ? { error: telemetry.error } : {}),
          }),
          telemetry.durationMs,
          "cron",
        );
    } catch (err) {
      logger.warn({ err, telemetry }, "Failed to write browser lifecycle telemetry");
    }
  }
}
