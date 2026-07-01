/**
 * Background-task runner — BACKGROUND_TASK_RUNNER_DESIGN.md §4.1.
 *
 * The browser-task runner's lifecycle skeleton, generalized: it owns the
 * per-task lifecycle from POST → terminal state, REUSING the pure slot
 * manager (`browser-task-slots.ts`) with a synthetic per-task slot key so
 * background tasks contend ONLY on the global concurrency cap (never on a
 * per-key queue). The Playwright plane is gone; the worker is a generic
 * SDK session (`background-task-driver.ts`).
 *
 * What this owns beyond browser-task's runner:
 *   - DELIVERY ENQUEUE — the runner's `reconcileDriverOutcome` reads the
 *     finished artifact and decides delivery in ONE place (the design's
 *     "post-transition hook"): completed + notify=true ⇒ enqueue result;
 *     parked ⇒ enqueue the open clarification; failed/timeout/no_finish ⇒
 *     FAIL-LOUD synthesize a failure artifact (notify=true) + enqueue;
 *     cancelled ⇒ no delivery (the owner cancelled). notify=false ⇒ file
 *     only. The periodic recovery sweep re-enqueues any lost delivery.
 *
 * I/O-shaped. Excluded from the 100% coverage gate; the pure logic lives
 * in the reused slot manager + the budget envelope.
 */

import type Database from "better-sqlite3";

import {
  addBackgroundTaskCost,
  appendResolvedClarificationToBrief,
  getBackgroundTask,
  markRunning,
  markRunningFromParked,
  markTerminal,
  resetSingleForBootRedispatch,
  type BackgroundTaskRow,
} from "../../db/background-task-store.js";
import { recordTaskRunSpend } from "../task-spend-ledger.js";
import {
  getClarification,
  getOpenClarificationForTask,
} from "../../db/background-task-clarifications-store.js";
import { createLogger } from "../../logging.js";
import {
  prepareDriverHandle,
  releaseDriverHandle,
  resumeDriver,
  resumeFromBootDriver,
  runDriver,
  type DriverDeps,
  type DriverHandle,
  type DriverRunResult,
} from "./background-task-driver.js";
import {
  createInitialSlotState,
  decideAcquire,
  decideCancel,
  decidePark,
  decideRelease,
  decideUnpark,
  type ReleaseEffect,
  type SlotState,
  type SlotTaskEntry,
} from "../browser-task/browser-task-slots.js";
import {
  noopBackgroundTaskTransitionEmitter,
  type BackgroundTaskTransitionEmitter,
} from "./background-task-transition-events.js";

const logger = createLogger("background-task-runner");

/** Synthetic per-task slot key — every background task gets a unique key
 *  so the reused per-siteKey slot manager only ever contends them against
 *  the global `maxConcurrent` cap, never against each other on a shared
 *  queue. `bg:` prefix is a grep-friendly debugging affordance. */
function slotKeyForTask(id: string): string {
  return `bg:${id}`;
}

/** Shared mutable slot-state container — the runner and the route layer
 *  hold the same instance (cancel-while-pending vs runner promote race). */
export interface BackgroundTaskSlotStateRef {
  state: SlotState;
}

export function createBackgroundTaskSlotStateRef(
  maxConcurrent: number,
): BackgroundTaskSlotStateRef {
  return { state: createInitialSlotState(maxConcurrent) };
}

/**
 * Delivery enqueuer — the runner hands the artifact to this so a
 * `task.delivery` event lands on the bus. Wired in bootstrap from the
 * `createBackgroundTask*DeliveryEvent` factories + the event bus (keeps
 * the runner free of any core/messaging import).
 */
export interface BackgroundTaskDeliveryEnqueuer {
  enqueueResult(input: {
    taskId: string;
    originatingChannel: string | null;
    title: string;
    draft: string;
    report: string;
  }): Promise<void>;
  enqueueClarification(input: {
    taskId: string;
    originatingChannel: string | null;
    title: string;
    clarificationId: string;
    question: string;
    contextSummary: string | null;
  }): Promise<void>;
}

export interface BackgroundTaskRunnerDeps {
  db: Database.Database;
  slotStateRef: BackgroundTaskSlotStateRef;
  /** Drives the worker SDK session. Absent only in early-boot ordering
   *  races / tests — when absent the runner fails the row fast. */
  driver?: DriverDeps;
  /** Enqueues `task.delivery` events. Optional — when absent (tests) the
   *  artifact is still written + filed; only the push is skipped. */
  deliveryEnqueuer?: BackgroundTaskDeliveryEnqueuer;
  transitionEmitter?: BackgroundTaskTransitionEmitter;
  /** BACKGROUND_TASK_RUNNER_DESIGN.md §10.2 / Phase 4 — when true, a task
   *  with a captured SDK session id is resumed via `query({resume})` across
   *  a daemon restart (boot) or a clarify-after-restart, falling back to
   *  re-dispatch-from-brief when the session can't be loaded. Wired from
   *  `backgroundTaskResumeAcrossRestart`; defaults to false (the v1
   *  re-dispatch-only behaviour) when omitted. */
  resumeAcrossRestart?: boolean;
  nowFn?: () => number;
}

export interface RunResult {
  ok: boolean;
  reason:
    | "completed"
    | "failed"
    | "timeout"
    | "cancelled"
    | "parked_awaiting_user"
    | "no_driver"
    | "queued"
    | "task_missing"
    | "already_terminal";
  state: BackgroundTaskRow["state"] | null;
}

export interface BackgroundTaskRunner {
  runFromPost(taskId: string): Promise<RunResult>;
  runFromScheduleRow(taskId: string): Promise<RunResult>;
  cancel(taskId: string, reason: string): Promise<boolean>;
  resumeAfterClarification(input: {
    taskId: string;
    clarificationId: string;
    answer: string;
  }): Promise<RunResult>;
  /** Phase 4 (§10.2) — boot recovery for ONE non-terminal task: resume the
   *  warm SDK session when possible, else re-dispatch from brief. */
  resumeFromBoot(taskId: string): Promise<RunResult>;
  expireForDeadline(
    taskId: string,
    kind: "clarification_deadline" | "queue_timeout",
    waitedMs?: number,
  ): Promise<RunResult>;
  __peekParkedIds(): readonly string[];
}

export function createBackgroundTaskRunner(
  deps: BackgroundTaskRunnerDeps,
): BackgroundTaskRunner {
  const now = deps.nowFn ?? (() => Date.now());
  const emitter = deps.transitionEmitter ?? noopBackgroundTaskTransitionEmitter;
  const resumeAcrossRestart = deps.resumeAcrossRestart ?? false;

  const parkedHandles = new Map<string, DriverHandle>();
  const liveHandles = new Map<string, DriverHandle>();
  const pendingAborts = new Map<string, string>();

  function tryAcquire(taskId: string): {
    promoted: boolean;
    blocked: number;
    alreadyTracked?: boolean;
  } {
    const row = getBackgroundTask(deps.db, taskId);
    if (!row) return { promoted: false, blocked: 0 };
    const entry: SlotTaskEntry = {
      taskId: row.id,
      siteKey: slotKeyForTask(row.id),
      enqueuedAt: row.createdAt,
    };
    try {
      const { state, effect } = decideAcquire(deps.slotStateRef.state, entry, now());
      deps.slotStateRef.state = state;
      if (effect.kind === "promoted") return { promoted: true, blocked: 0 };
      return { promoted: false, blocked: effect.globalPos };
    } catch (err) {
      logger.warn(
        { err, taskId },
        "background-task tryAcquire: slot manager already tracks this task — treating as no-op",
      );
      return { promoted: false, blocked: 0, alreadyTracked: true };
    }
  }

  function releaseAndPromote(taskId: string): void {
    const result = decideRelease(deps.slotStateRef.state, taskId, now());
    deps.slotStateRef.state = result.state;
    void emitReleaseEffects(result.effects);
  }

  function parkSlot(taskId: string): void {
    try {
      deps.slotStateRef.state = decidePark(deps.slotStateRef.state, taskId);
    } catch (err) {
      logger.warn({ err, taskId }, "decidePark failed (slot telemetry)");
    }
  }
  function unparkSlot(taskId: string): void {
    try {
      deps.slotStateRef.state = decideUnpark(deps.slotStateRef.state, taskId);
    } catch (err) {
      logger.warn({ err, taskId }, "decideUnpark failed (slot telemetry)");
    }
  }

  async function emitReleaseEffects(
    effects: readonly ReleaseEffect[],
  ): Promise<void> {
    for (const e of effects) {
      if (e.kind !== "promoted") continue;
      const startedAt = now();
      const runningRow = markRunning(deps.db, e.taskId, startedAt);
      if (!runningRow) {
        pendingAborts.delete(e.taskId);
        releaseAndPromote(e.taskId);
        continue;
      }
      emitter.emitFromRow(runningRow, startedAt);
      void runDriverFromPending(e.taskId).catch((err) => {
        logger.error({ err, taskId: e.taskId }, "background-task promoted-drive failed");
      });
    }
  }

  /** Synthesize a fail-loud artifact for a worker that died before
   *  `finish`. The owner asked for this task; silence on a requested task
   *  is the worse failure (§4.3). notify=true regardless of policy. */
  function failLoudArtifact(
    row: BackgroundTaskRow,
    outcomeDetail: string,
  ): { report: string; draft: string } {
    const title = row.title ?? row.brief.slice(0, 80);
    return {
      draft: `That task ("${title}") couldn't finish: ${outcomeDetail}.`,
      report:
        `Background task ${row.id} ("${title}") ended without a result.\n`
        + `Outcome: ${outcomeDetail}.\n`
        + `The worker did not call finish(), so no verbatim result was captured.`,
    };
  }

  async function reconcileDriverOutcome(input: {
    taskId: string;
    handle: DriverHandle;
    result: DriverRunResult;
  }): Promise<RunResult> {
    const { taskId, handle, result } = input;

    // Persist this leg's spend BEFORE branching: every outcome — park
    // included — has already spent its driver run. Task-row rollup +
    // per-run agent_actions ledger row (the driver used to compute
    // `costUsd` and this function silently dropped it).
    addBackgroundTaskCost(deps.db, taskId, result.costUsd);
    recordTaskRunSpend(deps.db, {
      taskKind: "background_task",
      taskId,
      result:
        result.outcome === "completed"
          ? "success"
          : result.outcome === "yielded_for_clarification"
            ? "partial"
            : result.outcome === "cancelled"
              ? "skipped"
              : "failed",
      costUsd: result.costUsd,
      numTurns: result.numTurns,
      durationMs: result.durationMs,
      completedAt: now(),
      modelUsed: result.modelId ?? null,
    });

    // PARK — keep the handle alive for /clarify. The ask_user tool
    // already moved the row to `awaiting_user`; enqueue the clarification
    // delivery so the owner sees the question.
    if (result.outcome === "yielded_for_clarification") {
      parkedHandles.set(taskId, handle);
      liveHandles.delete(taskId);
      parkSlot(taskId);
      await enqueueClarificationDelivery(taskId);
      logger.info({ taskId }, "background-task parked — awaiting clarification");
      return { ok: true, reason: "parked_awaiting_user", state: "awaiting_user" };
    }

    // COMPLETED — the finish tool wrote the artifact + terminal. Read it
    // and enqueue the result delivery iff the worker set notify=true.
    if (result.outcome === "completed") {
      cleanupHandle(taskId);
      if (deps.driver) {
        await releaseDriverHandle(deps.driver, handle).catch((err) => {
          logger.warn({ err, taskId }, "release driver handle failed (continuing)");
        });
      }
      releaseAndPromote(taskId);
      const row = getBackgroundTask(deps.db, taskId);
      emitter.emitFromRow(row, now());
      if (row && row.notify === true) {
        await enqueueResultDelivery(row);
      } else {
        logger.info(
          { taskId, notify: row?.notify },
          "background-task completed with notify=false — filed, no push (§10.5)",
        );
      }
      return { ok: true, reason: "completed", state: row?.state ?? "completed" };
    }

    // CANCELLED — the owner cancelled; no fail-loud delivery.
    if (result.outcome === "cancelled") {
      const finishedAt = now();
      const terminal = markTerminal(deps.db, {
        id: taskId,
        state: "cancelled",
        outcomeDetail: result.detail ?? "cancelled",
        finishedAt,
      });
      emitter.emitFromRow(terminal, finishedAt);
      cleanupHandle(taskId);
      if (deps.driver) {
        await releaseDriverHandle(deps.driver, handle).catch(() => {});
      }
      releaseAndPromote(taskId);
      return { ok: false, reason: "cancelled", state: terminal?.state ?? "cancelled" };
    }

    // FAIL-LOUD terminals — worker died/timed out/exceeded budget without
    // finish(). Synthesize the artifact (notify=true) so the owner always
    // hears back on a requested task, then enqueue delivery.
    const isTimeout = result.outcome === "timeout";
    const terminalState: "failed" | "timeout" = isTimeout ? "timeout" : "failed";
    const outcomeDetail = result.detail ?? result.outcome;
    const finishedAt = now();
    const rowBefore = getBackgroundTask(deps.db, taskId);
    const synthesized = rowBefore
      ? failLoudArtifact(rowBefore, outcomeDetail)
      : { report: null as string | null, draft: null as string | null };
    const terminal = markTerminal(deps.db, {
      id: taskId,
      state: terminalState,
      outcomeDetail,
      finishedAt,
      report: synthesized.report,
      draft: synthesized.draft,
      notify: true,
      significance: `task failed (${outcomeDetail})`,
    });
    emitter.emitFromRow(terminal, finishedAt);
    cleanupHandle(taskId);
    if (deps.driver) {
      await releaseDriverHandle(deps.driver, handle).catch((err) => {
        logger.warn({ err, taskId }, "release driver handle failed (continuing)");
      });
    }
    releaseAndPromote(taskId);
    if (terminal) await enqueueResultDelivery(terminal);
    return { ok: false, reason: terminalState, state: terminal?.state ?? terminalState };
  }

  async function enqueueResultDelivery(row: BackgroundTaskRow): Promise<void> {
    if (!deps.deliveryEnqueuer) return;
    if (!row.draft) return;
    try {
      await deps.deliveryEnqueuer.enqueueResult({
        taskId: row.id,
        originatingChannel: row.originatingChannel,
        title: row.title ?? row.brief.slice(0, 80),
        draft: row.draft,
        report: row.report ?? row.draft,
      });
    } catch (err) {
      // Best-effort — the recovery sweep re-enqueues (notify=1 &
      // delivered_at IS NULL) so a lost enqueue is not a lost result.
      logger.warn({ err, taskId: row.id }, "background-task result delivery enqueue failed (recovery sweep will retry)");
    }
  }

  async function enqueueClarificationDelivery(taskId: string): Promise<void> {
    if (!deps.deliveryEnqueuer) return;
    const clar = getOpenClarificationForTask(deps.db, taskId);
    if (!clar) return;
    const row = getBackgroundTask(deps.db, taskId);
    try {
      await deps.deliveryEnqueuer.enqueueClarification({
        taskId,
        originatingChannel: row?.originatingChannel ?? null,
        title: row?.title ?? row?.brief.slice(0, 80) ?? `Task ${taskId}`,
        clarificationId: clar.id,
        question: clar.question,
        contextSummary: clar.contextSummary,
      });
    } catch (err) {
      logger.warn({ err, taskId }, "background-task clarification delivery enqueue failed (recovery sweep will retry)");
    }
  }

  function cleanupHandle(taskId: string): void {
    parkedHandles.delete(taskId);
    liveHandles.delete(taskId);
    pendingAborts.delete(taskId);
  }

  async function runDriverFromPending(taskId: string): Promise<RunResult> {
    if (!deps.driver) {
      const finishedAt = now();
      const terminal = markTerminal(deps.db, {
        id: taskId,
        state: "failed",
        outcomeDetail: "runner_unavailable",
        finishedAt,
        report: "The background-task runner has no worker driver wired.",
        draft: "That task couldn't start — the worker runtime is unavailable.",
        notify: true,
      });
      emitter.emitFromRow(terminal, finishedAt);
      pendingAborts.delete(taskId);
      releaseAndPromote(taskId);
      if (terminal) await enqueueResultDelivery(terminal);
      return { ok: false, reason: "no_driver", state: terminal?.state ?? "failed" };
    }

    const row = getBackgroundTask(deps.db, taskId);
    if (!row) {
      pendingAborts.delete(taskId);
      releaseAndPromote(taskId);
      return { ok: false, reason: "task_missing", state: null };
    }

    const prepared = await prepareDriverHandle({ deps: deps.driver, row });
    if (!prepared.ok) {
      const finishedAt = now();
      const synthesized = failLoudArtifact(row, prepared.detail ?? prepared.reason);
      const terminal = markTerminal(deps.db, {
        id: taskId,
        state: "failed",
        outcomeDetail: prepared.detail ?? prepared.reason,
        finishedAt,
        report: synthesized.report,
        draft: synthesized.draft,
        notify: true,
      });
      emitter.emitFromRow(terminal, finishedAt);
      pendingAborts.delete(taskId);
      releaseAndPromote(taskId);
      if (terminal) await enqueueResultDelivery(terminal);
      return { ok: false, reason: "failed", state: terminal?.state ?? "failed" };
    }

    const handle = prepared.handle;
    liveHandles.set(taskId, handle);
    const pendingAbort = pendingAborts.get(taskId);
    if (pendingAbort !== undefined) {
      pendingAborts.delete(taskId);
      try {
        handle.abortController.abort(new Error(pendingAbort));
      } catch (err) {
        /* c8 ignore next 2 -- defensive */
        logger.warn({ err, taskId, reason: pendingAbort }, "forwarding pending-cancel abort failed");
      }
    }

    let result: DriverRunResult;
    try {
      result = await runDriver(deps.driver, row, handle);
    } catch (err) {
      logger.error({ err, taskId }, "background-task driver threw");
      result = {
        outcome: "sdk_error",
        sdkSessionId: handle.sdkSessionId,
        detail: err instanceof Error ? err.message : String(err),
        costUsd: 0,
        numTurns: 0,
        durationMs: 0,
        modelId: null,
      };
    }
    return reconcileDriverOutcome({ taskId, handle, result });
  }

  async function runOnce(taskId: string): Promise<RunResult> {
    const row = getBackgroundTask(deps.db, taskId);
    if (!row) return { ok: false, reason: "task_missing", state: null };
    if (row.state !== "pending") {
      return { ok: false, reason: "already_terminal", state: row.state };
    }
    const { promoted, blocked, alreadyTracked } = tryAcquire(taskId);
    if (alreadyTracked) {
      return { ok: false, reason: "already_terminal", state: row.state };
    }
    if (!promoted) {
      logger.info({ taskId, blocked }, "background-task queued — waiting for slot");
      return { ok: true, reason: "queued", state: "pending" };
    }
    const startedAt = now();
    const runningRow = markRunning(deps.db, taskId, startedAt);
    if (!runningRow) {
      pendingAborts.delete(taskId);
      releaseAndPromote(taskId);
      const afterRow = getBackgroundTask(deps.db, taskId);
      return { ok: false, reason: "already_terminal", state: afterRow?.state ?? null };
    }
    emitter.emitFromRow(runningRow, startedAt);
    return runDriverFromPending(taskId);
  }

  async function runFromPost(taskId: string): Promise<RunResult> {
    return runOnce(taskId);
  }
  async function runFromScheduleRow(taskId: string): Promise<RunResult> {
    return runOnce(taskId);
  }

  async function cancel(taskId: string, reason: string): Promise<boolean> {
    const row = getBackgroundTask(deps.db, taskId);
    if (!row) return false;
    const live = liveHandles.get(taskId);
    const parked = parkedHandles.get(taskId);
    const handle = live ?? parked;
    if (handle) {
      try {
        handle.abortController.abort(new Error(reason || "cancel"));
      } catch (err) {
        /* c8 ignore next 2 -- defensive */
        logger.warn({ err, taskId }, "abort signal failed");
      }
    } else if (row.state === "running") {
      pendingAborts.set(taskId, reason || "cancel");
    } else if (row.state === "pending") {
      // Queued behind the concurrency cap, not yet running — remove it
      // from the slot FIFO and write the terminal directly. Without this
      // the row stays `pending` forever and the FIFO entry leaks a slot
      // reservation. `decideCancel` throws only if the task is the active
      // occupant — by construction a `pending` DB row never is (markRunning
      // runs synchronously after acquire), so the catch is defensive.
      try {
        deps.slotStateRef.state = decideCancel(deps.slotStateRef.state, taskId).state;
      } catch (err) {
        logger.warn({ err, taskId }, "decideCancel on pending row failed (continuing)");
      }
      const finishedAt = now();
      const terminal = markTerminal(deps.db, {
        id: taskId,
        state: "cancelled",
        outcomeDetail: `cancelled_in_queue:${reason}`,
        finishedAt,
      });
      emitter.emitFromRow(terminal, finishedAt);
      logger.info({ taskId, reason }, "background-task cancel (pending → cancelled)");
      return true;
    }
    // Parked tasks aren't iterating the SDK, so abort alone won't unwind —
    // walk the terminal path manually (no fail-loud delivery on cancel).
    if (parked && !live) {
      parkedHandles.delete(taskId);
      if (deps.driver) {
        await releaseDriverHandle(deps.driver, parked).catch(() => {});
      }
      const finishedAt = now();
      const terminal = markTerminal(deps.db, {
        id: taskId,
        state: "cancelled",
        outcomeDetail: reason,
        finishedAt,
      });
      emitter.emitFromRow(terminal, finishedAt);
      pendingAborts.delete(taskId);
      releaseAndPromote(taskId);
    }
    logger.info(
      { taskId, reason, currentState: row.state, hadLive: !!live, hadParked: !!parked },
      "background-task cancel",
    );
    return true;
  }

  async function resumeAfterClarification(input: {
    taskId: string;
    clarificationId: string;
    answer: string;
  }): Promise<RunResult> {
    const row = getBackgroundTask(deps.db, input.taskId);
    const parked = parkedHandles.get(input.taskId);

    // The task vanished (retention prune / manual delete) — drop any stray
    // handle and free its slot.
    if (!row) {
      if (parked) {
        parkedHandles.delete(input.taskId);
        if (deps.driver) await releaseDriverHandle(deps.driver, parked).catch(() => {});
      }
      releaseAndPromote(input.taskId);
      return { ok: false, reason: "task_missing", state: null };
    }

    // (1) Warm in-memory handle (no restart since the park) — resume the
    //     live SDK session. The slot was held across the park, so unpark it.
    if (parked && deps.driver) {
      parkedHandles.delete(input.taskId);
      liveHandles.set(input.taskId, parked);
      unparkSlot(input.taskId);
      return driveResumeOrFallback(input, row, parked, deps.driver);
    }
    // A parked handle with no driver to drive it is pathological — drop it
    // and fall through to the re-dispatch floor.
    if (parked) parkedHandles.delete(input.taskId);

    // (2) Cross-restart: the in-memory handle was lost with the prior
    //     process. Reconstruct + resume the warm SDK session (§10.2) ONLY
    //     when resume is enabled, a session id was persisted, AND a slot is
    //     immediately free. Every other case — and any resume that can't
    //     load the session (§driveResumeOrFallback) — degrades to the
    //     zero-regression floor: re-dispatch from the brief with the owner's
    //     answer folded in (so the cold re-run doesn't re-ask). This mirrors
    //     `resumeFromBoot`; a clarify-after-restart therefore never
    //     fail-louds a recoverable task, over-commits a slot, or loses the
    //     owner's already-consumed answer.
    if (resumeAcrossRestart && deps.driver && row.backendSessionId) {
      const { promoted } = tryAcquire(input.taskId);
      if (promoted) {
        const prepared = await prepareDriverHandle({ deps: deps.driver, row });
        if (prepared.ok) {
          liveHandles.set(input.taskId, prepared.handle);
          logger.info(
            { taskId: input.taskId },
            "background-task clarify-after-restart — reconstructed handle from persisted session id",
          );
          return driveResumeOrFallback(input, row, prepared.handle, deps.driver);
        }
        // Reconstruction failed — release the slot we just took, then
        // re-dispatch.
        releaseAndPromote(input.taskId);
        logger.warn(
          { taskId: input.taskId, reason: prepared.reason },
          "background-task clarify-after-restart — handle reconstruction failed; re-dispatching from brief",
        );
      } else {
        // Concurrency cap full — tryAcquire queued the task; re-dispatch
        // resets the row to pending so that queued FIFO entry drives it
        // fresh (the same pattern resumeFromBoot uses).
        logger.info(
          { taskId: input.taskId },
          "background-task clarify-after-restart — concurrency cap full; re-dispatching from brief",
        );
      }
    }
    return redispatchAfterClarification(input);
  }

  /** Resume a parked/reconstructed worker with the owner's answer; if the
   *  warm SDK session can't load (`resume_unavailable`), degrade to a cold
   *  re-dispatch-with-answer rather than fail-louding (§10.2). */
  async function driveResumeOrFallback(
    input: { taskId: string; clarificationId: string; answer: string },
    row: BackgroundTaskRow,
    handle: DriverHandle,
    driver: DriverDeps,
  ): Promise<RunResult> {
    const resumedAt = now();
    const resumed = markRunningFromParked(deps.db, input.taskId);
    if (resumed) emitter.emitFromRow(resumed, resumedAt);

    let result: DriverRunResult;
    try {
      result = await resumeDriver(driver, row, handle, input.answer);
    } catch (err) {
      logger.error({ err, taskId: input.taskId }, "background-task resume threw");
      result = {
        outcome: "sdk_error",
        sdkSessionId: handle.sdkSessionId,
        detail: err instanceof Error ? err.message : String(err),
        costUsd: 0,
        numTurns: 0,
        durationMs: 0,
        modelId: null,
      };
    }
    if (result.outcome === "resume_unavailable") {
      logger.warn(
        { taskId: input.taskId, detail: result.detail },
        "background-task clarify resume unavailable — re-dispatching from brief with the answer",
      );
      cleanupHandle(input.taskId);
      await releaseDriverHandle(driver, handle).catch(() => {});
      releaseAndPromote(input.taskId);
      return redispatchAfterClarification(input);
    }
    return reconcileDriverOutcome({ taskId: input.taskId, handle, result });
  }

  /** Zero-regression fallback for a clarify that can't reuse the warm SDK
   *  session: fold the owner's just-answered clarification into the brief
   *  (the route already CAS-resolved it) and re-dispatch from the brief, so
   *  the cold re-run has the answer and doesn't re-ask. */
  async function redispatchAfterClarification(input: {
    taskId: string;
    clarificationId: string;
    answer: string;
  }): Promise<RunResult> {
    const clar = getClarification(deps.db, input.clarificationId);
    appendResolvedClarificationToBrief(
      deps.db,
      input.taskId,
      clar?.question ?? null,
      input.answer,
    );
    return redispatchFromBrief(input.taskId);
  }

  /**
   * Phase 4 (§10.2) — boot recovery for ONE non-terminal task. A `running`
   * task that captured an SDK session id is resumed via `query({resume})`
   * (warm transcript + prompt cache survive the restart); everything else,
   * and any resume that can't load the session, re-dispatches from the
   * self-contained brief. Resume is a pure optimization — every failure
   * path degrades to the proven v1 re-dispatch behaviour.
   */
  async function resumeFromBoot(taskId: string): Promise<RunResult> {
    const row = getBackgroundTask(deps.db, taskId);
    if (!row) return { ok: false, reason: "task_missing", state: null };
    if (
      !resumeAcrossRestart
      || !deps.driver
      || !row.backendSessionId
      || row.state !== "running"
    ) {
      return redispatchFromBrief(taskId);
    }
    const { promoted, alreadyTracked } = tryAcquire(taskId);
    if (alreadyTracked || !promoted) {
      // Concurrency cap is full right now — re-dispatch (it queues, and the
      // normal promotion path runs it fresh). Resume only when a slot is
      // immediately free.
      return redispatchFromBrief(taskId);
    }
    emitter.emitFromRow(row, now());
    const prepared = await prepareDriverHandle({ deps: deps.driver, row });
    if (!prepared.ok) {
      const finishedAt = now();
      const synthesized = failLoudArtifact(row, prepared.detail ?? prepared.reason);
      const terminal = markTerminal(deps.db, {
        id: taskId,
        state: "failed",
        outcomeDetail: prepared.detail ?? prepared.reason,
        finishedAt,
        report: synthesized.report,
        draft: synthesized.draft,
        notify: true,
      });
      emitter.emitFromRow(terminal, finishedAt);
      releaseAndPromote(taskId);
      if (terminal) await enqueueResultDelivery(terminal);
      return { ok: false, reason: "failed", state: terminal?.state ?? "failed" };
    }
    const handle = prepared.handle;
    liveHandles.set(taskId, handle);
    // A cancel that arrived during boot recovery (before this handle
    // existed) parked its reason in `pendingAborts` — forward it now so the
    // resume unwinds instead of dropping the cancel.
    const pendingAbort = pendingAborts.get(taskId);
    if (pendingAbort !== undefined) {
      pendingAborts.delete(taskId);
      try {
        handle.abortController.abort(new Error(pendingAbort));
      } catch (err) {
        /* c8 ignore next 2 -- defensive */
        logger.warn({ err, taskId, reason: pendingAbort }, "forwarding pending-cancel abort failed (boot resume)");
      }
    }
    let result: DriverRunResult;
    try {
      result = await resumeFromBootDriver(deps.driver, row, handle);
    } catch (err) {
      result = {
        outcome: "resume_unavailable",
        sdkSessionId: handle.sdkSessionId,
        detail: err instanceof Error ? err.message : String(err),
        costUsd: 0,
        numTurns: 0,
        durationMs: 0,
        modelId: null,
      };
    }
    if (result.outcome === "resume_unavailable") {
      logger.warn(
        { taskId, detail: result.detail },
        "background-task resume-across-restart unavailable — re-dispatching from brief",
      );
      cleanupHandle(taskId);
      await releaseDriverHandle(deps.driver, handle).catch(() => {});
      releaseAndPromote(taskId);
      return redispatchFromBrief(taskId);
    }
    return reconcileDriverOutcome({ taskId, handle, result });
  }

  /** Reset a single non-terminal row to pending (clearing its lost session)
   *  and re-run its brief through the normal pending→running→drive path. */
  async function redispatchFromBrief(taskId: string): Promise<RunResult> {
    resetSingleForBootRedispatch(deps.db, taskId, now());
    return runOnce(taskId);
  }

  async function expireForDeadline(
    taskId: string,
    kind: "clarification_deadline" | "queue_timeout",
    waitedMs?: number,
  ): Promise<RunResult> {
    const row = getBackgroundTask(deps.db, taskId);
    if (!row) return { ok: false, reason: "task_missing", state: null };
    if (
      row.state === "completed"
      || row.state === "failed"
      || row.state === "timeout"
      || row.state === "cancelled"
    ) {
      return { ok: false, reason: "already_terminal", state: row.state };
    }

    const outcomeDetail =
      kind === "clarification_deadline" ? "clarification_deadline" : "queue_timeout";
    const parked = parkedHandles.get(taskId);
    const live = liveHandles.get(taskId);
    const handle = parked ?? live;
    if (handle) {
      try {
        handle.abortController.abort(new Error(outcomeDetail));
      } catch (err) {
        /* c8 ignore next 2 -- defensive */
        logger.warn({ err, taskId, kind }, "expireForDeadline: abort failed");
      }
    }
    if (parked) {
      parkedHandles.delete(taskId);
      if (deps.driver) await releaseDriverHandle(deps.driver, parked).catch(() => {});
    }

    const finishedAt = now();
    const synthesized = failLoudArtifact(row, outcomeDetail);
    const terminal = markTerminal(deps.db, {
      id: taskId,
      state: "timeout",
      outcomeDetail,
      finishedAt,
      report: synthesized.report,
      draft: synthesized.draft,
      notify: true,
      significance: `task timed out (${outcomeDetail})`,
    });
    emitter.emitFromRow(terminal, finishedAt);
    pendingAborts.delete(taskId);
    // For a live-only handle (clarification deadline racing a still-live
    // run), the abort unwinds the SDK into reconcileDriverOutcome which
    // releases + promotes; releasing here too would double-promote.
    if (parked || !live) {
      releaseAndPromote(taskId);
    }
    if (terminal) await enqueueResultDelivery(terminal);
    logger.info({ taskId, kind, hadParked: !!parked, hadLive: !!live, waitedMs }, "background-task expired for deadline");
    return { ok: false, reason: "timeout", state: terminal?.state ?? "timeout" };
  }

  function __peekParkedIds(): readonly string[] {
    return Array.from(parkedHandles.keys());
  }

  return {
    runFromPost,
    runFromScheduleRow,
    cancel,
    resumeAfterClarification,
    resumeFromBoot,
    expireForDeadline,
    __peekParkedIds,
  };
}
