import { join } from "node:path";
import type Database from "better-sqlite3";

import type { AgentConfig } from "../../config.js";
import { getContextDir } from "../../config.js";
import { createLogger } from "../../logging.js";
import {
  AgentEnabledCache,
  loadAgents,
  resolveTimezone,
  type AgentEventPort,
  type AgentLoadOptions,
  type AgentSnapshotPort,
  type LoadAgentsResult,
} from "./loader.js";
import {
  startAgentsWatcher,
  type AgentsWatcherHandle,
} from "./loader-watcher.js";
import { createRecurringSchedulePort } from "./recurring-schedule-adapter.js";
import { reconcileConfigGates } from "./config-gate-reconcile.js";
import { migrateCustomRoutinesToAgents } from "./custom-routine-migration.js";
import { listAllSkillSlugs } from "../release-assets.js";
import { resolveUserSkillsRoot } from "../user-skills-root.js";

/**
 * Boot adapter for the Agent loader (AGENT_DEFINITIONS_DESIGN.md §6.1 — the
 * Phase-7 `(db, config)` wrapper the Phase-5 loader's DI seam expects).
 *
 * Resolves the concrete ports the loader's pure core takes as injected deps:
 *   - `builtinDir` = `<workspaceDir>/agent-assets/agents`,
 *     `userDir`    = `<contextDir>/policies/agents`;
 *   - `snapshot`   → an `md_file_snapshots` row writer (mirrors the
 *     daily-journal / roadmap-maintenance snapshot inserts);
 *   - `events`     → the dashboard SSE broadcaster (`agent.updated`);
 *   - `recurring`  → the `recurring-schedule-adapter` over `db/recurring-schedules`.
 *
 * Runs the boot scan, builds the live {@link AgentEnabledCache} the scheduler
 * gate consults, and starts the filesystem watcher (user root only — built-ins
 * ship read-only) so a dashboard-authored `agent.md` reloads without a restart.
 * Never throws: the loader is crash-proof by contract and a watcher start
 * failure degrades to a logged warning.
 */

const logger = createLogger("agents-loader-boot");

export interface BootstrapAgentsDeps {
  db: Database.Database;
  config: AgentConfig;
  /** Dashboard SSE broadcaster; omitted in headless installs. */
  eventBroadcaster?: { broadcastEvent: (data: unknown) => void };
}

export interface BootstrapAgentsResult {
  result: LoadAgentsResult;
  enabledCache: AgentEnabledCache;
  watcher: AgentsWatcherHandle | null;
  /**
   * Re-run the loader against the same options (re-resolving each Agent's
   * schedule timezone and reconciling its recurring row) and invalidate the
   * enabled cache — the exact pass the filesystem watcher fires on an
   * `agent.md` edit, exposed so an OS-timezone change can refresh auto-mode
   * Agents whose recurring rows carry a concrete resolved zone. Never throws.
   */
  reloadAgents: () => void;
}

/** Resolve the loader's port set + dirs from daemon config. */
export function buildAgentLoadOptions(
  deps: BootstrapAgentsDeps,
): AgentLoadOptions {
  const { db, config, eventBroadcaster } = deps;
  const builtinDir = join(config.workspaceDir, "agent-assets", "agents");
  const userDir = join(getContextDir(config, db), "policies", "agents");
  // A concrete zone for the recurring adapter's fallback (well-formed rows
  // carry their own; this only fills a hand-edited row with none).
  const fallbackTz = resolveTimezone(undefined, config.timezone);
  // Snapshot the known skill slugs once at boot for the loader's `tools.skills`
  // cross-check (§4.3 step 5). A skill added mid-session is a minor staleness
  // (re-resolved on the next boot), not a correctness gap — the watcher reuses
  // the same opts, matching the recurring-port snapshot semantics.
  const skillSlugs = listAllSkillSlugs(resolveUserSkillsRoot(config), config.workspaceDir);

  const snapshot: AgentSnapshotPort = {
    record: ({ filePath, content, trigger }) => {
      try {
        db.prepare(
          "INSERT INTO md_file_snapshots (file_path, content, trigger, session_id) VALUES (?, ?, ?, ?)",
        ).run(filePath, content, trigger, null);
      } catch (err) {
        logger.warn({ err, filePath, trigger }, "Failed to save agent md_file_snapshots row");
      }
    },
  };

  const events: AgentEventPort | undefined = eventBroadcaster
    ? {
        emit: (event, payload) =>
          eventBroadcaster.broadcastEvent({
            kind: event,
            ...(payload as Record<string, unknown>),
          }),
      }
    : undefined;

  return {
    builtinDir,
    userDir,
    dayBoundaryHour: config.dayBoundaryHour,
    timezone: config.timezone,
    snapshot,
    ...(events ? { events } : {}),
    recurring: createRecurringSchedulePort(db, fallbackTz),
    listSkillSlugs: () => skillSlugs,
  };
}

/**
 * Load every Agent definition at boot, build the enabled cache, and start the
 * user-root watcher. Wire the returned `enabledCache` into the scheduler via
 * `scheduler.setAgentEnabledCache(...)` and the `watcher` into the shutdown
 * sequence.
 */
export function bootstrapAgents(deps: BootstrapAgentsDeps): BootstrapAgentsResult {
  const opts = buildAgentLoadOptions(deps);
  // One-time legacy custom-routine conversion (AGENTS_HUB_REDESIGN_PLAN §3).
  // Runs BEFORE loadAgents so the loader pairs the generated user agent.md
  // files with recurring_schedules rows in this same boot pass. Never throws
  // out of boot.
  try {
    migrateCustomRoutinesToAgents(deps.db, {
      contextDir: getContextDir(deps.config, deps.db),
      userDir: opts.userDir,
      timezone: resolveTimezone(undefined, deps.config.timezone),
    });
  } catch (err) {
    logger.error({ err }, "Custom-routine migration failed (continuing boot)");
  }
  const result = loadAgents(deps.db, opts);
  // One-time legacy gate carry-over (activityScanEnabled / monthlyReviewEnabled
  // → agents.enabled). Must run AFTER the loader has seeded the rows;
  // runtime_state-flagged so it never re-applies (AGENTS_HUB_REDESIGN_PLAN §2).
  reconcileConfigGates(deps.db, {
    activityScanEnabled: deps.config.activityScanEnabled,
    monthlyReviewEnabled: deps.config.monthlyReviewEnabled,
  });
  if (result.invalid.length > 0) {
    logger.warn(
      { count: result.invalid.length, slugs: result.invalid.map((d) => d.slug) },
      "Some Agent definitions failed to load (surfaced under /api/agents include_invalid)",
    );
  }
  for (const warning of result.warnings) logger.debug({ warning }, "agent load warning");
  logger.info({ upserted: result.upserted.length }, "Agents loaded");

  const enabledCache = new AgentEnabledCache(deps.db);

  let watcher: AgentsWatcherHandle | null = null;
  try {
    watcher = startAgentsWatcher(deps.db, opts, {
      reload: () => loadAgents(deps.db, opts),
      cache: enabledCache,
      ...(opts.events ? { events: opts.events } : {}),
    });
  } catch (err) {
    logger.warn({ err }, "Agent definitions watcher failed to start — edits apply on next restart");
  }

  const reloadAgents = (): void => {
    try {
      const reloaded = loadAgents(deps.db, opts);
      enabledCache.invalidate();
      opts.events?.emit("agent.updated", {
        reason: "timezone_change",
        upserted: reloaded.upserted,
      });
      logger.info(
        { upserted: reloaded.upserted.length },
        "Agents re-resolved after OS timezone change",
      );
    } catch (err) {
      logger.error({ err }, "Agent re-resolve after timezone change failed");
    }
  };

  return { result, enabledCache, watcher, reloadAgents };
}
