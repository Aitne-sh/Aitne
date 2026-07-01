/**
 * Dispatcher handler for `scheduled.background_task`
 * (BACKGROUND_TASK_RUNNER_DESIGN.md §4.2).
 *
 * Lifts fire-time row creation + runner handoff out of `dispatcher.ts`,
 * mirroring `dispatcher-scheduled-browser-task.ts` but with the whole
 * allowlist / site-registry plane removed — a background task carries
 * only a self-contained brief.
 *
 * Flow:
 *   1. Re-validate the persisted `task_context` (a hand-crafted DB row
 *      cannot smuggle invalid fields through the scheduler boundary).
 *   2. Dedup on `preGeneratedTaskId` (a scheduler/dispatcher restart
 *      between event.put and dispatch must not double-insert).
 *   3. Insert the `background_task` row pinned to the pre-generated id.
 *   4. Hand off to the runner. The runner's RunResult drives the
 *      `background_task` lifecycle from here; the `agent_schedule` row's
 *      status is independent (the dispatcher marks it completed on
 *      successful dispatch, failed on rejection).
 */

import type Database from "better-sqlite3";
import type { ScheduledBackgroundTaskEvent } from "@aitne/shared";
import { z } from "zod";

import {
  createBackgroundTask,
  getBackgroundTask,
  markTerminal,
} from "../db/background-task-store.js";
import type { BackgroundTaskRunner } from "../services/background-task/background-task-runner.js";
import { createLogger } from "../logging.js";

const logger = createLogger("dispatcher-scheduled-background-task");

const taskContextSchema = z.object({
  preGeneratedTaskId: z.string().uuid(),
  brief: z.string().min(1).max(16_384),
  title: z.string().min(1).max(200).nullable().optional(),
  notificationPolicy: z
    .enum(["always", "if_significant", "silent"])
    .optional(),
  significanceCriteria: z
    .array(z.string().min(1).max(500))
    .max(12)
    .nullable()
    .optional(),
  tier: z.enum(["lite", "medium", "high"]).nullable().optional(),
  maxBudgetUsd: z.number().positive().max(15).nullable().optional(),
  originatingChannel: z.string().nullable().optional(),
  // Provenance threaded from the deferring POST (migration 0022); absent on
  // rows scheduled before the column existed → the store defaults 'agent'.
  origin: z.enum(["user", "agent", "system"]).optional(),
});

export type ScheduledBackgroundTaskOutcome =
  | { kind: "dispatched"; taskId: string }
  | { kind: "task_context_invalid"; reason: string }
  | { kind: "row_already_exists"; taskId: string }
  | { kind: "runner_unavailable"; taskId: string };

export interface BackgroundTaskDispatchDeps {
  db: Database.Database;
  runner: BackgroundTaskRunner | null;
  nowFn?: () => number;
}

export async function handleScheduledBackgroundTask(
  deps: BackgroundTaskDispatchDeps,
  event: ScheduledBackgroundTaskEvent,
): Promise<ScheduledBackgroundTaskOutcome> {
  const now = deps.nowFn ?? (() => Date.now());

  const parsed = taskContextSchema.safeParse(event.taskContext);
  if (!parsed.success) {
    const reason = parsed.error.issues
      .slice(0, 3)
      .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
      .join("; ");
    logger.error(
      { scheduleId: event.scheduleId, reason },
      "scheduled.background_task: task_context failed schema validation",
    );
    return { kind: "task_context_invalid", reason };
  }
  const ctx = parsed.data;

  const existing = getBackgroundTask(deps.db, ctx.preGeneratedTaskId);
  if (existing) {
    logger.warn(
      { taskId: ctx.preGeneratedTaskId, scheduleId: event.scheduleId, state: existing.state },
      "scheduled.background_task: row already exists for preGeneratedTaskId — skipping re-dispatch",
    );
    return { kind: "row_already_exists", taskId: ctx.preGeneratedTaskId };
  }

  createBackgroundTask(deps.db, {
    id: ctx.preGeneratedTaskId,
    brief: ctx.brief,
    title: ctx.title ?? null,
    notificationPolicy: ctx.notificationPolicy ?? "always",
    significanceCriteria: ctx.significanceCriteria ?? null,
    originatingChannel: ctx.originatingChannel ?? null,
    correlationId: event.correlationId ?? null,
    scheduleRowId: event.scheduleId,
    tier: ctx.tier ?? null,
    maxBudgetUsd: ctx.maxBudgetUsd ?? null,
    origin: ctx.origin,
    createdAt: now(),
  });

  if (!deps.runner) {
    markTerminal(deps.db, {
      id: ctx.preGeneratedTaskId,
      state: "failed",
      outcomeDetail: "runner_unavailable",
      finishedAt: now(),
      report: "The background-task runner was not wired at fire time.",
      draft: "That scheduled task couldn't start — the runner was unavailable.",
      notify: true,
    });
    logger.warn(
      { taskId: ctx.preGeneratedTaskId, scheduleId: event.scheduleId },
      "scheduled.background_task: runner not wired — marked failed (runner_unavailable)",
    );
    return { kind: "runner_unavailable", taskId: ctx.preGeneratedTaskId };
  }

  void deps.runner.runFromScheduleRow(ctx.preGeneratedTaskId).catch((err) => {
    logger.error(
      { err, taskId: ctx.preGeneratedTaskId, scheduleId: event.scheduleId },
      "background-task runFromScheduleRow threw — task left in pending state",
    );
  });
  logger.info(
    { taskId: ctx.preGeneratedTaskId, scheduleId: event.scheduleId },
    "scheduled.background_task dispatched to runner",
  );
  return { kind: "dispatched", taskId: ctx.preGeneratedTaskId };
}
