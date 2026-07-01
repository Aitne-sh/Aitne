/**
 * Dispatcher handler for `scheduled.browser_task` (BROWSER_TASK_REDESIGN_PLAN
 * §6.2 + §7 + §12 Q#5).
 *
 * Lifts the fire-time row-creation + runner handoff out of `dispatcher.ts`
 * so:
 *   1. The decision logic is unit-testable without booting a real
 *      dispatcher (the dispatcher itself is `Excluded` from the coverage
 *      gate; this helper is on the covered path).
 *   2. The shape (`event → outcome`) is documented as a single value
 *      that every code path returns, instead of `void` + side-effect.
 *
 * Flow:
 *   1. Parse + validate `event.taskContext` (re-runs the POST-time Zod
 *      shape so a hand-crafted DB row cannot smuggle invalid fields
 *      through the scheduler boundary).
 *   2. Re-compose the allowlist regex against the current site
 *      registry. The registry may have evolved between schedule-time
 *      and fire-time; an unregistered siteKey is a clean
 *      `site_unregistered` terminal.
 *   3. Insert the `browser_task` row with the schedule-time
 *      `preGeneratedTaskId` as its id, so the dashboard's
 *      `/api/browser-task/<id>` poll switches from 404 to the real
 *      row at exactly the fire moment.
 *   4. Hand off to the runner. The runner's RunResult is the sole
 *      determinant of the `browser_task` lifecycle from here; the
 *      `agent_schedule` row's status is independent (mark `completed`
 *      on successful dispatch + handoff, `failed` on rejection).
 *
 * **Test seam — `runner` is optional in `BrowserTaskDispatchDeps` so the
 * Phase 3 wiring can land before Phase 2's full driver is plumbed.** When
 * absent, the helper still creates the `browser_task` row + marks the
 * schedule row completed; the runner-level fallback (`failed
 * (not_implemented)` from the §5 stub) handles the row's terminal
 * write on the next code-path that consults it.
 */

import type Database from "better-sqlite3";
import type { ScheduledBrowserTaskEvent } from "@aitne/shared";
import { z } from "zod";

import {
  createBrowserTask,
  getBrowserTask,
  markTerminal,
} from "../db/browser-task-store.js";
import type {
  BrowserTaskNotifier,
  BrowserTaskRunner,
} from "../services/browser-task/browser-task-runner.js";
import { composeAllowlistRegex } from "../services/browser-task/browser-task-allowlist.js";
import { createLogger } from "../logging.js";

const logger = createLogger("dispatcher-scheduled-browser-task");

/** Mirrors the validated POST body persisted into `agent_schedule.task_context`
 *  by the `POST /api/browser-task` scheduleAt branch. Re-validated at fire
 *  time so a hand-crafted DB row cannot bypass the schema.
 *
 *  2026-05-27 open-navigation revision — `siteKey` is now nullable (new
 *  schedules write null because the API dropped the siteKey/extraAllowedHosts
 *  request fields). Legacy schedule rows that still carry a real siteKey
 *  string keep working through the same branches below. `extraAllowedHosts`
 *  stays `.optional()` for the same reason; new rows write `[]`. */
const taskContextSchema = z.object({
  preGeneratedTaskId: z.string().uuid(),
  description: z.string().min(1).max(4096),
  siteKey: z.string().regex(/^[a-z][a-z0-9_]*$/).nullable(),
  extraAllowedHosts: z.array(z.string()).max(5).optional(),
  originatingChannel: z.string().nullable().optional(),
  requireFinalConfirm: z.boolean().optional(),
  // Provenance threaded from the deferring POST (migration 0022); absent on
  // rows scheduled before the column existed → the store defaults 'agent'.
  origin: z.enum(["user", "agent", "system"]).optional(),
});

export type ScheduledBrowserTaskOutcome =
  | { kind: "dispatched"; taskId: string }
  | { kind: "site_unregistered"; taskId: string; siteKey: string | null }
  | {
      kind: "allowlist_rejected";
      taskId: string;
      reason: string;
      offendingHost?: string;
    }
  | { kind: "task_context_invalid"; reason: string }
  | { kind: "row_already_exists"; taskId: string }
  | { kind: "runner_unavailable"; taskId: string };

export interface BrowserTaskDispatchDeps {
  db: Database.Database;
  runner: BrowserTaskRunner | null;
  /**
   * §7 — "the user is DMed" on fire-time dispatch failure
   * (`site_unregistered`, `allowlist_rejected`, `runner_unavailable`).
   * Without this hook the user scheduled a task hours/days ago and
   * gets no signal when it silently fails at fire time. The runner's
   * own `notifyTerminal` only fires when the runner is reached, which
   * is exactly NOT the case for these pre-runner failure paths.
   *
   * Fire-and-forget — the call is awaited only inside the handler's
   * own `void ... .catch()` to keep failures observable without
   * blocking dispatch. Optional so handler tests can omit it; the
   * `task_context_invalid` / `row_already_exists` paths NEVER call it
   * (no fresh row → no `originating_channel` to address).
   */
  notifier?: BrowserTaskNotifier | null;
  /** Override for tests; production uses `Date.now`. */
  nowFn?: () => number;
}

/**
 * Handle a `scheduled.browser_task` event. Returns a discriminated
 * outcome the caller (the dispatcher) consumes to mark the
 * `agent_schedule` row status. Never throws on validation /
 * registry-miss — those land as explicit outcomes the caller can
 * audit. Throws on truly-unexpected DB errors so the dispatcher's
 * `handleError` path can mark the schedule row `failed`.
 */
export async function handleScheduledBrowserTask(
  deps: BrowserTaskDispatchDeps,
  event: ScheduledBrowserTaskEvent,
): Promise<ScheduledBrowserTaskOutcome> {
  const now = deps.nowFn ?? (() => Date.now());

  /** Fire-and-forget DM after a fresh failed-row write. Closes §7's
   *  "user is DMed" gap for fire-time dispatch failures. The runner's
   *  own `notifyTerminal` covers everything once the runner is reached;
   *  these failure paths happen before that. */
  function notifyDispatchFailure(
    taskId: string,
    originatingChannel: string | null,
    outcomeDetail: string,
  ): void {
    if (!deps.notifier) return;
    void deps.notifier
      .notifyTerminal({
        taskId,
        originatingChannel,
        state: "failed",
        outcomeDetail,
      })
      .catch((err: unknown) => {
        logger.warn(
          { err, taskId, outcomeDetail },
          "scheduled.browser_task: failure-DM dispatch failed (continuing)",
        );
      });
  }

  // Step 1: re-validate the persisted task_context.
  const parsed = taskContextSchema.safeParse(event.taskContext);
  if (!parsed.success) {
    const reason = parsed.error.issues
      .slice(0, 3)
      .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
      .join("; ");
    logger.error(
      { scheduleId: event.scheduleId, reason },
      "scheduled.browser_task: task_context failed schema validation",
    );
    return { kind: "task_context_invalid", reason };
  }
  const ctx = parsed.data;

  // Step 2: dedup. If a previous tick already created the row (e.g.
  // a scheduler/dispatcher restart between event.put and dispatch),
  // the row's existing state machine is the source of truth — do
  // NOT re-insert and do NOT re-fire the runner. The schedule row
  // is still marked completed by the caller because the dispatch
  // succeeded.
  const existing = getBrowserTask(deps.db, ctx.preGeneratedTaskId);
  if (existing) {
    logger.warn(
      { taskId: ctx.preGeneratedTaskId, scheduleId: event.scheduleId, state: existing.state },
      "scheduled.browser_task: browser_task row already exists for preGeneratedTaskId — skipping re-dispatch",
    );
    return { kind: "row_already_exists", taskId: ctx.preGeneratedTaskId };
  }

  // Step 3: re-compose the allowlist against the live site registry.
  const allowlist = composeAllowlistRegex({
    siteKey: ctx.siteKey,
    extraAllowedHosts: ctx.extraAllowedHosts,
  });
  if (!allowlist.ok) {
    // site_unregistered is the documented soft failure (registry
    // changed between schedule and fire). Other failures (too_many_extra_hosts,
    // extra_host_must_be_hostname, extra_host_not_in_etld_set) are
    // structural and would have been rejected at POST time; the only
    // way they fire here is a runtime config change to
    // EXTRA_ALLOWED_ETLD_HELPERS or a tampered schedule row. Both
    // surface as a `failed` row with the explicit reason so the user
    // sees what happened.
    if (allowlist.reason === "site_unregistered") {
      createBrowserTask(deps.db, {
        id: ctx.preGeneratedTaskId,
        description: ctx.description,
        siteKey: ctx.siteKey,
        extraAllowedHosts: [],
        originatingChannel: ctx.originatingChannel ?? null,
        scheduleRowId: event.scheduleId,
        requireFinalConfirm: ctx.requireFinalConfirm ?? true,
        effectiveAllowlistRegex: null,
        origin: ctx.origin,
        createdAt: now(),
      });
      markTerminal(deps.db, {
        id: ctx.preGeneratedTaskId,
        state: "failed",
        outcomeDetail: "site_unregistered",
        report: null,
        finishedAt: now(),
      });
      logger.warn(
        { taskId: ctx.preGeneratedTaskId, scheduleId: event.scheduleId, siteKey: ctx.siteKey },
        "scheduled.browser_task: siteKey unregistered at fire time — task marked failed",
      );
      notifyDispatchFailure(
        ctx.preGeneratedTaskId,
        ctx.originatingChannel ?? null,
        "site_unregistered",
      );
      return {
        kind: "site_unregistered",
        taskId: ctx.preGeneratedTaskId,
        siteKey: ctx.siteKey,
      };
    }
    createBrowserTask(deps.db, {
      id: ctx.preGeneratedTaskId,
      description: ctx.description,
      siteKey: ctx.siteKey,
      extraAllowedHosts: [],
      originatingChannel: ctx.originatingChannel ?? null,
      scheduleRowId: event.scheduleId,
      requireFinalConfirm: ctx.requireFinalConfirm ?? true,
      effectiveAllowlistRegex: null,
      origin: ctx.origin,
      createdAt: now(),
    });
    markTerminal(deps.db, {
      id: ctx.preGeneratedTaskId,
      state: "failed",
      outcomeDetail: `allowlist_rejected:${allowlist.reason}`,
      report: null,
      finishedAt: now(),
    });
    logger.warn(
      {
        taskId: ctx.preGeneratedTaskId,
        scheduleId: event.scheduleId,
        reason: allowlist.reason,
        offendingHost: allowlist.offendingHost,
      },
      "scheduled.browser_task: allowlist rejected at fire time — task marked failed",
    );
    notifyDispatchFailure(
      ctx.preGeneratedTaskId,
      ctx.originatingChannel ?? null,
      `allowlist_rejected:${allowlist.reason}`,
    );
    return {
      kind: "allowlist_rejected",
      taskId: ctx.preGeneratedTaskId,
      reason: allowlist.reason,
      // The composer's only `offendingHost: undefined` branch is the
      // `too_many_extra_hosts` failure, but Zod's `.max(5)` in the
      // task_context schema rejects that shape upstream. The fallback
      // is defence-in-depth against a future widening of the schema.
      /* c8 ignore next 3 -- structurally unreachable: see comment above */
      ...(allowlist.offendingHost !== undefined
        ? { offendingHost: allowlist.offendingHost }
        : {}),
    };
  }

  // Step 4: create the `browser_task` row pinned to the pre-generated
  // taskId. The runner picks it up from here.
  createBrowserTask(deps.db, {
    id: ctx.preGeneratedTaskId,
    description: ctx.description,
    siteKey: ctx.siteKey,
    extraAllowedHosts: allowlist.acceptedExtras,
    originatingChannel: ctx.originatingChannel ?? null,
    scheduleRowId: event.scheduleId,
    requireFinalConfirm: ctx.requireFinalConfirm ?? true,
    effectiveAllowlistRegex: allowlist.composedSource,
    origin: ctx.origin,
    createdAt: now(),
  });

  // Step 5: hand off to the runner. Fire-and-forget — `runFromScheduleRow`
  // owns the BrowserContext + slot lifecycle from here; awaiting would
  // block the EventBus loop for the duration of a 5-min task.
  if (!deps.runner) {
    // Mirror the route-layer fallback so the row doesn't park indefinitely
    // when the runner factory hasn't landed.
    markTerminal(deps.db, {
      id: ctx.preGeneratedTaskId,
      state: "failed",
      outcomeDetail: "runner_unavailable",
      report: null,
      finishedAt: now(),
    });
    logger.warn(
      { taskId: ctx.preGeneratedTaskId, scheduleId: event.scheduleId },
      "scheduled.browser_task: runner not wired — task marked failed (runner_unavailable)",
    );
    notifyDispatchFailure(
      ctx.preGeneratedTaskId,
      ctx.originatingChannel ?? null,
      "runner_unavailable",
    );
    return { kind: "runner_unavailable", taskId: ctx.preGeneratedTaskId };
  }
  void deps.runner.runFromScheduleRow(ctx.preGeneratedTaskId).catch((err) => {
    logger.error(
      { err, taskId: ctx.preGeneratedTaskId, scheduleId: event.scheduleId },
      "browser-task runFromScheduleRow threw — task left in pending state",
    );
  });
  logger.info(
    {
      taskId: ctx.preGeneratedTaskId,
      scheduleId: event.scheduleId,
      siteKey: ctx.siteKey,
    },
    "scheduled.browser_task dispatched to runner",
  );
  return { kind: "dispatched", taskId: ctx.preGeneratedTaskId };
}
