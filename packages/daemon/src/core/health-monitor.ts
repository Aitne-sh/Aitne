import type Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { EventPriority, createEvent, getAgentDayBoundsUtc } from "@aitne/shared";
import type { AgentConfig } from "../config.js";
import { getContextDir } from "../config.js";
import type { EventBus } from "./event-bus.js";
import type { MessageHub } from "../adapters/message-hub.js";
import type { ObserverManager } from "../observers/manager.js";
import { createLogger } from "../logging.js";

const logger = createLogger("health-monitor");

const CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

export interface HealthStatus {
  /**
   * Seconds since daemon start. Every consumer of the `/health` `uptime`
   * field (`bin/aitne.mjs formatUptime`, dashboard `formatUptime`)
   * formats seconds — this was milliseconds until 2026-06-10, which made
   * `aitne status` report a minutes-old daemon as days of uptime.
   */
  daemonUptime: number;
  eventBusSize: number;
  activeSessions: number;
  dbConnected: boolean;
  connectedPlatforms: string[];
  registeredObservers: string[];
  todaySessions: number;
  todayCostUsd: number;
  contextFilesOk: boolean;
  missingContextFiles: string[];
  lastCheckAt: string;
}

export interface HealthMonitorDependencies {
  db: Database.Database;
  config: AgentConfig;
  eventBus: EventBus;
  messageHub: MessageHub;
  observerManager: ObserverManager;
  startedAt: Date;
}

/**
 * HealthMonitor splits two concerns that used to share a cache:
 *  - `getStatus()` always returns a fresh `check()` so the dashboard
 *    cannot see a snapshot from up to 5 minutes ago.
 *  - The 5-min interval drives anomaly detection only, comparing each
 *    tick against `anomalyBaseline` and emitting `health.anomaly` on
 *    transitions (db lost, platform dropped, context file vanished).
 */
export class HealthMonitor {
  private readonly db: Database.Database;
  private readonly config: AgentConfig;
  private readonly eventBus: EventBus;
  private readonly messageHub: MessageHub;
  private readonly observerManager: ObserverManager;
  private readonly startedAt: Date;

  private timer: ReturnType<typeof setInterval> | null = null;
  // Snapshot used by detectAnomalies as the "previous" state. Touching
  // this from getStatus() would couple the two paths and re-create the
  // stale-cache bug, so it is updated only on interval ticks.
  private anomalyBaseline: HealthStatus | null = null;

  /** Required context files (relative to context dir). Updated for the
   *  six-class vault layout (CONTEXT_VAULT_REDESIGN_PLAN). */
  private static readonly REQUIRED_FILES = [
    "identity/profile.md",
    "state/today.md",
  ];

  constructor(deps: HealthMonitorDependencies) {
    this.db = deps.db;
    this.config = deps.config;
    this.eventBus = deps.eventBus;
    this.messageHub = deps.messageHub;
    this.observerManager = deps.observerManager;
    this.startedAt = deps.startedAt;
  }

  start(): void {
    // Seed the baseline so the first tick has something to diff
    // against. Anomaly detection runs only on subsequent ticks — same
    // behavior as before the cache was removed.
    this.anomalyBaseline = this.check();

    this.timer = setInterval(() => {
      const prev = this.anomalyBaseline;
      this.anomalyBaseline = this.check();
      this.detectAnomalies(prev, this.anomalyBaseline);
    }, CHECK_INTERVAL_MS);

    logger.info("Health monitor started (5-min interval)");
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  getStatus(): HealthStatus {
    return this.check();
  }

  /** Run all health checks and return status */
  check(): HealthStatus {
    const contextDir = getContextDir(this.config, this.db);
    const missingFiles: string[] = [];

    for (const file of HealthMonitor.REQUIRED_FILES) {
      if (!existsSync(resolve(contextDir, file))) {
        missingFiles.push(file);
      }
    }

    let dbConnected = true;
    let todaySessions = 0;
    let todayCostUsd = 0;
    let activeSessions = 0;

    try {
      const bounds = getAgentDayBoundsUtc(this.config.timezone, this.config.dayBoundaryHour);
      const stats = this.db
        .prepare(
          "SELECT COUNT(*) as sessions, COALESCE(SUM(cost_usd), 0) as cost FROM agent_actions WHERE started_at >= ? AND started_at < ?",
        )
        .get(bounds.start, bounds.end) as { sessions: number; cost: number };
      todaySessions = stats.sessions;
      todayCostUsd = stats.cost;

      const activeRow = this.db
        .prepare(
          "SELECT COUNT(*) as cnt FROM conversation_sessions WHERE status = 'active'",
        )
        .get() as { cnt: number };
      activeSessions = activeRow.cnt;
    } catch {
      dbConnected = false;
    }

    return {
      daemonUptime: Math.floor((Date.now() - this.startedAt.getTime()) / 1000),
      eventBusSize: this.eventBus.size,
      activeSessions,
      dbConnected,
      connectedPlatforms: this.messageHub.getPlatforms(),
      registeredObservers: this.observerManager
        .getObservers()
        .map((o) => o.name),
      todaySessions,
      todayCostUsd,
      contextFilesOk: missingFiles.length === 0,
      missingContextFiles: missingFiles,
      lastCheckAt: new Date().toISOString(),
    };
  }

  /** Compare previous and current status, emit events for anomalies.
   *  Only emits on *transitions* (prev OK → curr bad) to avoid flooding. */
  private detectAnomalies(
    prev: HealthStatus | null,
    curr: HealthStatus,
  ): void {
    // DB disconnected (only on transition from connected → disconnected)
    if (!curr.dbConnected && (prev === null || prev.dbConnected)) {
      this.emitAnomaly("Database connection lost", "critical");
    }

    // Platform disconnected (was connected before)
    if (prev) {
      const lostPlatforms = prev.connectedPlatforms.filter(
        (p) => !curr.connectedPlatforms.includes(p),
      );
      for (const platform of lostPlatforms) {
        this.emitAnomaly(
          `Messaging platform "${platform}" disconnected`,
          "high",
        );
      }
    }

    // Context files missing (only on transition from OK → missing)
    if (!curr.contextFilesOk && (prev === null || prev.contextFilesOk)) {
      this.emitAnomaly(
        `Missing context files: ${curr.missingContextFiles.join(", ")}`,
        "normal",
      );
    }

  }

  private emitAnomaly(
    description: string,
    severity: "critical" | "high" | "normal",
  ): void {
    const priorityMap = {
      critical: EventPriority.CRITICAL,
      high: EventPriority.HIGH,
      normal: EventPriority.NORMAL,
    };

    logger.warn({ severity, description }, "Health anomaly detected");

    this.eventBus.put(
      createEvent({
        type: "health.anomaly",
        source: "health-monitor",
        priority: priorityMap[severity],
        data: { description, severity },
      }),
    );
  }
}
