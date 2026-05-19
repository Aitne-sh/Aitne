/**
 * Boot-time catchup sequence — pure-move from `index.ts` per
 * `docs/design/appendices/file-split-plan.md` §10. Pattern A: each function
 * takes its dependencies (db, dispatcher, config) as arguments so the
 * startup IIFE can compose them without going through `this`.
 *
 * Policy (unchanged from origin):
 * - discard previous-agent-day pending tasks instead of replaying them
 * - fail/skip orphaned running tasks instead of blindly retrying side effects
 * - catch up same-agent-day routines only once
 */

import { join } from "node:path";
import type Database from "better-sqlite3";
import {
  createEvent,
  EventPriority,
  getAgentDayBoundsUtc,
  type RoutineEvent,
} from "@aitne/shared";
import type { AgentConfig } from "../config.js";
import { getContextDir, isRoadmapStale } from "../config.js";
import type { EventDispatcher } from "../core/dispatcher.js";
import {
  discardStalePendingSchedules,
  recoverOrphanedRunningSchedules,
} from "../core/schedule-maintenance.js";
import { createLogger } from "../logging.js";
import {
  getDueCatchupRoutines,
  hasFreshAgentDayTodayMd,
  shouldCatchUpHourlyCheck,
} from "./schedule-helpers.js";

const logger = createLogger("daemon-bootstrap-catchup");

export interface StartupCatchupResult {
  postMessagingRoadmapRefresh: boolean;
  postMessagingRoutines: string[];
  postMessagingHourlyCheck: boolean;
}

export async function runCatchup(
  db: Database.Database,
  dispatcher: EventDispatcher,
  config: AgentConfig,
): Promise<StartupCatchupResult> {
  // Setup gate — on first boot (before rules/management.md exists) we must
  // NOT run the morning routine. Without user/profile.md / rules/management.md
  // the generated today.md is meaningless AND it fires
  // onPromptContextChanged → markActiveDmSessionsStale, which destroys the
  // dashboard setup conversation on the user's next turn. Autonomous
  // catchup will run on the first normal boot *after* setup completes.
  const gateReason = dispatcher.isAutonomousAllowed();
  if (gateReason !== null) {
    logger.info(
      { reason: gateReason },
      "Skipping startup catchup — autonomous work paused for setup",
    );
    return {
      postMessagingRoadmapRefresh: false,
      postMessagingRoutines: [],
      postMessagingHourlyCheck: false,
    };
  }

  const now = new Date();
  const tz = config.timezone || undefined;
  const contextDir = getContextDir(config);
  const todayMdPath = join(contextDir, "today.md");
  const { start: agentDayStartUtc, end: agentDayEndUtc } = getAgentDayBoundsUtc(
    tz,
    config.dayBoundaryHour,
    now,
  );
  const skippedPending = discardStalePendingSchedules(db, agentDayStartUtc);
  if (skippedPending > 0) {
    logger.warn({ count: skippedPending }, "Discarded stale pending schedules at startup");
  }
  const runningRecovery = recoverOrphanedRunningSchedules(db, agentDayStartUtc);
  if (runningRecovery.skipped > 0 || runningRecovery.failed > 0) {
    logger.warn(runningRecovery, "Recovered orphaned running schedules without replay");
  }

  // Pin to the same `now` so the day-boundary check sees a consistent
  // clock across the catchup's pre / post freshness probes.
  const needsMorning = !hasFreshAgentDayTodayMd(
    todayMdPath,
    tz,
    config.dayBoundaryHour,
    now,
  );

  const dueCatchupRoutines = getDueCatchupRoutines(
    db,
    config,
    agentDayStartUtc,
    agentDayEndUtc,
    now,
  );
  const needsHourlyCheckCatchup = shouldCatchUpHourlyCheck(
    db,
    config,
    now,
  );
  let ranMorningCatchup = false;

  if (needsMorning) {
    try {
      await dispatcher.summarizeDmSessions();
    } catch (err) {
      logger.error(
        { err },
        "DM summarization catchup failed before morning routine",
      );
    }
    logger.info("Stale today.md detected, running morning_routine catchup inline");
    await dispatcher.processInline({
      ...createEvent({
        type: "routine.morning_routine",
        source: "catchup",
        priority: EventPriority.HIGH,
        data: {
          postCatchupRoutines: dueCatchupRoutines,
          postCatchupHourlyCheck: needsHourlyCheckCatchup,
          deferPostMorningCatchupsUntilStartupReady: true,
        },
      }),
      routine: "morning_routine",
    } as RoutineEvent);
    ranMorningCatchup = true;

    if (!hasFreshAgentDayTodayMd(todayMdPath, tz, config.dayBoundaryHour)) {
      logger.warn(
        "Startup morning catchup did not produce a fresh today.md — deferring remaining catchup work",
      );
      return {
        postMessagingRoadmapRefresh: false,
        postMessagingRoutines: [],
        postMessagingHourlyCheck: false,
      };
    }

    return {
      postMessagingRoadmapRefresh: isRoadmapStale(contextDir),
      postMessagingRoutines: dueCatchupRoutines,
      postMessagingHourlyCheck: needsHourlyCheckCatchup,
    };
  }

  if (!ranMorningCatchup && isRoadmapStale(contextDir)) {
    logger.info("Roadmap stale at startup, running roadmap_refresh catchup inline");
    await processRoutineCatchup(dispatcher, "roadmap_refresh");
  }

  return {
    postMessagingRoadmapRefresh: false,
    postMessagingRoutines: dueCatchupRoutines,
    postMessagingHourlyCheck: needsHourlyCheckCatchup,
  };
}

export async function runPostMessagingCatchup(
  dispatcher: EventDispatcher,
  catchup: StartupCatchupResult,
): Promise<void> {
  if (catchup.postMessagingRoadmapRefresh) {
    logger.info("Running roadmap_refresh catchup after messaging startup");
    await processRoutineCatchup(dispatcher, "roadmap_refresh");
  }

  for (const routine of catchup.postMessagingRoutines) {
    logger.info({ routine }, "Running same-day routine catchup after messaging startup");
    await processRoutineCatchup(dispatcher, routine);
  }

  if (catchup.postMessagingHourlyCheck) {
    logger.info("Triggering hourly_check catchup after messaging startup");
    await dispatcher.triggerHourlyCheck("catchup_startup", { force: false });
  }
}

export async function processRoutineCatchup(
  dispatcher: EventDispatcher,
  routine: string,
): Promise<void> {
  await dispatcher.processInline({
    ...createEvent({
      type: `routine.${routine}`,
      source: "catchup",
      priority: routine === "hourly_check" ? EventPriority.NORMAL : EventPriority.HIGH,
    }),
    routine,
  } as RoutineEvent);
}
