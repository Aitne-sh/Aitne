/**
 * Browser-task runner — BROWSER_TASK_REDESIGN_PLAN.md §5 + §5.1.
 *
 * Owns the per-task lifecycle from POST → terminal state:
 *
 *  1. Slot acquisition (`browser-task-slots.ts` — pure decisions, the
 *     runner mutates its `SlotStateRef`).
 *  2. Playwright + SDK loop via `browser-task-driver.ts` — Phase 2's
 *     real driver. Phase 1 shipped a `not_implemented` stub that flipped
 *     every task straight to `failed (not_implemented)`; the driver
 *     module replaces that body.
 *  3. Post-execute hook — flips parked-without-yield tasks to
 *     `failed (ask_user_without_yield)` (§5 hard rule defence).
 *  4. Park map for clarify resume — `awaiting_user` / `final_confirm`
 *     tasks keep their `DriverHandle` alive in `parkedHandles` so
 *     `/clarify` can call `resumeAfterClarification` and re-enter the
 *     SDK with the user's answer.
 *  5. Cancellation — `cancel(taskId)` walks the park map and any
 *     in-flight `AbortController`, signals abort, and lets the driver
 *     unwind to a `cancelled` terminal.
 *  6. Final-confirm token reply — `consumeFinalConfirmToken(taskId)`
 *     is the hook the messaging adapter calls when a `!~xxxxxxxx`
 *     token reply lands; the runner consults the parked handle to
 *     resume the click that was waiting on the token. (The token
 *     await happens INSIDE the tool body via
 *     `finalConfirmHandler.awaitReply`, so there's no separate driver
 *     entry-point for it.)
 *
 * I/O-shaped. Excluded from the 100% coverage gate; pure logic lives
 * in the slot manager + deadline scanner + tool helpers under
 * `browser-task-tools/`.
 */

import type Database from "better-sqlite3";

import {
  getBrowserTask,
  markRunning,
  markRunningFromParked,
  markTerminal,
  type BrowserTaskRow,
} from "../../db/browser-task-store.js";
import { resolveClarification } from "../../db/browser-task-clarifications-store.js";
import { createLogger } from "../../logging.js";
import {
  prepareDriverHandle,
  releaseDriverHandle,
  resumeDriver,
  runDriver,
  type DriverDeps,
  type DriverHandle,
  type DriverRunResult,
} from "./browser-task-driver.js";
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
} from "./browser-task-slots.js";
import {
  noopBrowserTaskTransitionEmitter,
  type BrowserTaskTransitionEmitter,
} from "./browser-task-transition-events.js";

const logger = createLogger("browser-task-runner");

/**
 * Resolve a slot-manager identity for a browser-task row. Legacy auth-
 * variant rows pin a real `siteKey` and contend per-site; open-navigation
 * rows (siteKey===null per the 2026-05-27 revision) get a unique synthetic
 * key derived from the task id so they only contend against the global
 * `maxConcurrent` cap. The prefix is purely a debugging affordance — a
 * UUID would be unique on its own, but `__open__:<uuid>` is grep-friendly
 * in logs and unambiguously distinct from any real siteKey.
 *
 * The synthetic key is in-memory only; the DB row keeps `site_key=NULL`
 * and `toWire()` exposes that null to the dashboard unchanged.
 */
function slotSiteKeyForRow(row: BrowserTaskRow): string {
  return row.siteKey ?? `__open__:${row.id}`;
}

/** True when the slot manager already tracks `taskId` as an active
 *  occupant (acquired a slot), even if the DB row still reads `pending`
 *  in the narrow acquire→markRunning window. Mirrors the route helper. */
function slotManagerHasActive(state: SlotState, taskId: string): boolean {
  for (const entry of state.active.values()) {
    if (entry.taskId === taskId) return true;
  }
  return false;
}

/**
 * Runner factory dependencies. Production wires `db`, an in-memory
 * `SlotStateRef` shared with the API route layer (so cancel + slot
 * acquisition see one state), the optional notifier for queue / DM
 * events, and the driver deps the per-task runs need. The factory
 * returns the singleton runner; the caller stashes it on
 * `ApiDependencies` for the route layer.
 */
export interface BrowserTaskRunnerDeps {
  db: Database.Database;
  /** Mutable reference to the slot state. The runner reads and
   *  replaces it on every acquire / release. The API route layer
   *  shares the same ref so cancel-while-pending updates a queue the
   *  runner is about to promote from. */
  slotStateRef: SlotStateRef;
  /** Optional notifier — when present, the runner fans queue-state /
   *  DM intents through it. */
  notifier?: BrowserTaskNotifier;
  /** Optional driver-side deps. When absent (Phase 1 boot path that
   *  has not yet wired the driver), the runner falls back to the
   *  Phase 1 `not_implemented` synthetic transition so the row
   *  doesn't hang in pending. Phase 2 callers wire this. */
  driver?: DriverDeps;
  /** BROWSER_TASK_REDESIGN_PLAN.md §9a.5 Shape B — emits a `browser_task`
   *  named SSE event after every state-machine write so the dashboard
   *  invalidates list / detail / awaiting-count caches without per-id
   *  polling. Defaults to the no-op emitter when not wired (tests,
   *  early-boot ordering races). Production wires it from
   *  `bootstrap/event-pipeline.ts` over the global EventBroadcaster. */
  transitionEmitter?: BrowserTaskTransitionEmitter;
  /** Override for tests; production uses `Date.now`. */
  nowFn?: () => number;
}

/** Shared mutable slot-state container. The runner and the route
 *  layer hold the same instance so a cancel-while-pending and a
 *  runner-side promote race on the same value. */
export interface SlotStateRef {
  state: SlotState;
}

export function createSlotStateRef(maxConcurrent: number): SlotStateRef {
  return { state: createInitialSlotState(maxConcurrent) };
}

/** Surface the runner uses to DM the originating channel on
 *  queue-state events. Production wires a wrapper around the messaging
 *  adapter's `sendNotification`; tests pass null and rely on the
 *  `agent_actions` log to assert intent. */
export interface BrowserTaskNotifier {
  notifyQueued(input: {
    taskId: string;
    originatingChannel: string | null;
    blockedCount: number;
  }): Promise<void>;
  notifyTerminal(input: {
    taskId: string;
    originatingChannel: string | null;
    state: BrowserTaskRow["state"];
    outcomeDetail: string | null;
  }): Promise<void>;
}

export interface RunResult {
  ok: boolean;
  /**
   * - `completed` | `failed` | `timeout` | `cancelled` | `abandoned`:
   *   the driver landed a terminal transition (Phase 2 real run).
   * - `parked_awaiting_user`: the driver yielded for ask_user; the
   *   runner kept the BrowserContext in its parked map.
   * - `parked_final_confirm`: the driver yielded mid-flight on the
   *   final-confirm gate (rare — usually completes inside the tool).
   * - `not_implemented`: Phase 1 fallback (driver deps absent).
   * - `queued`: the slot manager queued the task.
   * - `task_missing`: row was deleted between insert and dispatch.
   * - `already_terminal`: the row already reached a terminal state.
   */
  reason:
    | "completed"
    | "failed"
    | "timeout"
    | "cancelled"
    | "abandoned"
    | "parked_awaiting_user"
    | "parked_final_confirm"
    | "not_implemented"
    | "queued"
    | "task_missing"
    | "already_terminal";
  state: BrowserTaskRow["state"] | null;
}

export interface BrowserTaskRunner {
  /**
   * Entry point for `POST /api/browser-task` (immediate run) — the
   * row was just inserted in state=pending and the route handler is
   * deciding whether to fire-and-forget the runner. Acquires the
   * slot (or queues), then runs the driver when promoted.
   */
  runFromPost(taskId: string): Promise<RunResult>;
  /**
   * Entry point for `scheduled.browser_task` — the scheduler is firing
   * a row whose `agent_schedule.task_context` carries the original
   * POST body. The Phase 3 scheduler branch creates a fresh
   * `browser_task` row at fire time and calls this; identical body
   * to `runFromPost`.
   */
  runFromScheduleRow(taskId: string): Promise<RunResult>;
  /** §14.11 Q#4 cancellation. Aborts the in-flight SDK query via the
   *  per-task AbortController, releases the parked BrowserContext if
   *  any, and lets the driver unwind. Returns true when the cancel
   *  reached a known task. */
  cancel(taskId: string, reason: string): Promise<boolean>;
  /** Clarify resume — called from `POST /api/browser-task/:id/clarify`
   *  after the route layer has written the user's answer into the
   *  clarification row. The runner re-enters the driver with the
   *  parked handle + the user's answer threaded as a fresh user
   *  message. */
  resumeAfterClarification(input: {
    taskId: string;
    clarificationId: string;
    answer: string;
  }): Promise<RunResult>;
  /**
   * Deadline expiry hook called by the daemon-side deadline scanner
   * (`bootstrap/event-pipeline.ts` 30 s tick). Two callers today —
   * the overdue-clarification sweep (`kind: "clarification_deadline"`,
   * target state `abandoned`) and the pending-queue-timeout sweep
   * (`kind: "queue_timeout"`, target state `failed`).
   *
   * The runner owns this because both kinds may target a task whose
   * `DriverHandle` is still alive in `parkedHandles` (clarification
   * deadline) or `liveHandles` (race against a concurrent
   * `markTerminal` write). Without runner involvement the deadline
   * tick would write the terminal DB row directly + release the slot
   * but leak the Playwright Chromium process + workdir for the
   * clarification-deadline case (`Phase 2 hand-off` note in
   * `event-pipeline.ts` § browser-task deadline scanner tick).
   *
   * Idempotent — re-running on an already-terminal row is a no-op.
   */
  expireForDeadline(
    taskId: string,
    kind: "clarification_deadline" | "queue_timeout",
    waitedMs?: number,
  ): Promise<RunResult>;
  /** Test-only — read the parked-task ids so tests can assert the
   *  parking lifecycle without mocking the driver internals. */
  __peekParkedIds(): readonly string[];
}

export function createBrowserTaskRunner(
  deps: BrowserTaskRunnerDeps,
): BrowserTaskRunner {
  const now = deps.nowFn ?? (() => Date.now());
  const emitter = deps.transitionEmitter ?? noopBrowserTaskTransitionEmitter;

  // Per-task in-memory map of parked handles. Keys: taskId; values:
  // the DriverHandle whose BrowserContext + Page + abortController
  // the runner is preserving across an `awaiting_user` / `final_confirm`
  // round-trip. Lost on daemon restart (§6.5 boot recovery flips the
  // row to `failed (daemon_restarted)`).
  const parkedHandles = new Map<string, DriverHandle>();

  // Per-task in-memory map of LIVE (non-parked) abort controllers — the
  // runner needs these so a `/cancel` POST during `running` can abort
  // the SDK query.  Cleared on terminal transition or on park.
  const liveHandles = new Map<string, DriverHandle>();

  // Pending-abort intent — recorded by `cancel()` when a task is in the
  // narrow window between `tryAcquire` (slot held) and `liveHandles.set`
  // (real handle registered). `prepareDriverHandle` is async (Chromium
  // spawn + workdir setup), so a cancel landing during that window had
  // no handle to abort and was silently dropped — the SDK would then
  // run anyway, burning turns + cost up to the static envelope caps.
  // Now `runDriverFromPending` consults this map right after the prepare
  // returns and forwards the abort onto the real `abortController` so
  // the SDK exits on its first message.
  const pendingAborts = new Map<string, string>();

  function tryAcquire(taskId: string): {
    promoted: boolean;
    blocked: number;
    alreadyTracked?: boolean;
  } {
    const row = getBrowserTask(deps.db, taskId);
    if (!row) {
      return { promoted: false, blocked: 0 };
    }
    // Open-navigation rows (siteKey===null per the 2026-05-27 revision)
    // get a synthetic per-task slot key so they only contend against
    // the global concurrency cap, never against each other on a per-
    // siteKey queue. Legacy auth-variant rows still pass their persisted
    // siteKey so multiple tasks targeting the same registered site
    // serialise as before. The synthetic key never leaves the in-memory
    // slot manager — the DB row keeps site_key=NULL and the route layer
    // never sees it.
    const slotSiteKey = slotSiteKeyForRow(row);
    const entry: SlotTaskEntry = {
      taskId: row.id,
      siteKey: slotSiteKey,
      enqueuedAt: row.createdAt,
    };
    // `decideAcquire` throws when the taskId is already tracked by the
    // slot manager (active or queued). Phase 1 never re-enters because
    // the route layer dedups via the DB primary key; the catch exists
    // for a future regression that double-fires (e.g. a scheduler
    // retry mistakenly emitting a second event for the same row).
    // Treating dup-id as "already tracked, no acquire fires" preserves
    // slot invariants without crashing the caller, and the warn log
    // surfaces the regression so the operator can grep for it.
    try {
      const { state, effect } = decideAcquire(
        deps.slotStateRef.state,
        entry,
        now(),
      );
      deps.slotStateRef.state = state;
      if (effect.kind === "promoted") {
        return { promoted: true, blocked: 0 };
      }
      return { promoted: false, blocked: effect.globalPos };
    } catch (err) {
      logger.warn(
        { err, taskId },
        "browser-task tryAcquire: slot manager already tracks this task — treating as no-op (regression suspected)",
      );
      return { promoted: false, blocked: 0, alreadyTracked: true };
    }
  }

  function releaseAndPromote(taskId: string): void {
    const result = decideRelease(deps.slotStateRef.state, taskId, now());
    deps.slotStateRef.state = result.state;
    void emitReleaseEffects(result.effects);
  }

  // Slot PHASE transitions (running <-> parked). The slot itself is never
  // released on park — Plan A (§5.1) keeps the BrowserContext + slot held
  // across `awaiting_user` / `final_confirm`. These only update the
  // active-occupant phase so `blockedByPhase` telemetry and snapshots
  // (`browser-task-slots.ts:findActiveOccupant`) reflect reality; without
  // them every parked task is still reported as `phase: "running"`.
  // `decidePark`/`decideUnpark` throw only if the task is not the active
  // occupant — by construction a parked task still holds its slot, so the
  // catch is defensive (and idempotent on repeat calls).
  function parkSlot(taskId: string): void {
    try {
      deps.slotStateRef.state = decidePark(deps.slotStateRef.state, taskId);
    } catch (err) {
      logger.warn({ err, taskId }, "decidePark failed (slot phase telemetry)");
    }
  }
  function unparkSlot(taskId: string): void {
    try {
      deps.slotStateRef.state = decideUnpark(deps.slotStateRef.state, taskId);
    } catch (err) {
      logger.warn({ err, taskId }, "decideUnpark failed (slot phase telemetry)");
    }
  }

  async function emitReleaseEffects(
    effects: readonly ReleaseEffect[],
  ): Promise<void> {
    for (const e of effects) {
      if (e.kind !== "promoted") continue;
      logger.debug(
        { taskId: e.taskId, waitedMs: e.waitedMs },
        "browser-task slot promoted",
      );
      // The slot manager (`applyPromotion`) has already moved this task
      // into `active` (slot held) and removed it from BOTH FIFOs. The
      // runner must now drive it: the row is still `pending`, no handle
      // is tracked, and nothing else will start it. Without this the
      // promoted task hangs in `pending` forever and the slot leaks
      // (cumulative concurrency drop). §5.1 + §13 "auto-promotes to
      // running with no manual nudge".
      const startedAt = now();
      const runningRow = markRunning(deps.db, e.taskId, startedAt); // CAS: WHERE state='pending'
      if (!runningRow) {
        // CAS miss — the promoted task was cancelled-in-queue / already
        // moved on between `applyPromotion` and this drive. The slot
        // manager already put it in `active`, so release it (which may
        // cascade to the next candidate). `releaseAndPromote` re-enters
        // here, but `applyPromotion` promotes at most one candidate per
        // release and each promotion either drives async (no
        // re-entrancy) or releases a single slot, so this terminates.
        pendingAborts.delete(e.taskId);
        releaseAndPromote(e.taskId);
        continue;
      }
      emitter.emitFromRow(runningRow, startedAt);
      // Drive directly — the slot is already held by the slot manager;
      // do NOT route through runOnce/tryAcquire (decideAcquire would hit
      // its dup-id guard and throw, since the task is already in active).
      void runDriverFromPending(e.taskId).catch((err) => {
        logger.error(
          { err, taskId: e.taskId },
          "browser-task promoted-drive failed",
        );
      });
    }
  }

  /**
   * Reconcile a single driver-run outcome with the DB state machine
   * + the parked map. Idempotent — safe to invoke from the post-run
   * branch AND from a `cancel()` race.
   */
  async function reconcileDriverOutcome(input: {
    taskId: string;
    handle: DriverHandle;
    result: DriverRunResult;
  }): Promise<RunResult> {
    const { taskId, handle, result } = input;

    // PARK paths — keep the BrowserContext alive in `parkedHandles`.
    // The DB row already shows the parked state; do NOT call markTerminal
    // here. The slot stays held (Plan A — §5.1).
    if (result.outcome === "yielded_for_clarification") {
      parkedHandles.set(taskId, handle);
      liveHandles.delete(taskId);
      parkSlot(taskId);
      logger.info(
        { taskId, sessionId: result.sdkSessionId },
        "browser-task parked — awaiting clarification",
      );
      return { ok: true, reason: "parked_awaiting_user", state: "awaiting_user" };
    }
    if (result.outcome === "yielded_for_final_confirm") {
      parkedHandles.set(taskId, handle);
      liveHandles.delete(taskId);
      parkSlot(taskId);
      return {
        ok: true,
        reason: "parked_final_confirm",
        state: "final_confirm",
      };
    }

    // TERMINAL paths. Map driver outcome → DB terminal state.
    let terminalState: "completed" | "failed" | "timeout" | "cancelled";
    let outcomeDetail: string | null = result.detail ?? null;
    switch (result.outcome) {
      case "completed":
        terminalState = "completed";
        break;
      case "timeout":
        terminalState = "timeout";
        break;
      case "cancelled":
        terminalState = "cancelled";
        break;
      case "max_turns_exceeded":
        terminalState = "failed";
        outcomeDetail = "max_turns_exceeded";
        break;
      case "budget_exceeded":
        terminalState = "failed";
        outcomeDetail = "budget_exceeded";
        break;
      case "blocked_request_spike":
        terminalState = "failed";
        outcomeDetail = "blocked_request_spike";
        break;
      case "tool_loop_detected":
        terminalState = "failed";
        outcomeDetail = "tool_loop_detected";
        break;
      case "failed_ask_user_without_yield":
        terminalState = "failed";
        outcomeDetail = "ask_user_without_yield";
        break;
      case "site_unregistered":
        terminalState = "failed";
        outcomeDetail = "site_unregistered";
        break;
      case "playwright_unavailable":
        terminalState = "failed";
        outcomeDetail = result.detail ?? "playwright_unavailable";
        break;
      case "backend_misconfigured":
        terminalState = "failed";
        outcomeDetail = result.detail ?? "backend_misconfigured";
        break;
      case "sdk_error":
      default:
        terminalState = "failed";
        outcomeDetail = result.detail ?? "sdk_error";
        break;
    }

    const finishedAt = now();
    const terminal = markTerminal(deps.db, {
      id: taskId,
      state: terminalState,
      outcomeDetail,
      report: null,
      finishedAt,
    });
    emitter.emitFromRow(terminal, finishedAt);

    // Release the Playwright handle + workdir + slot.
    parkedHandles.delete(taskId);
    liveHandles.delete(taskId);
    pendingAborts.delete(taskId);
    if (deps.driver) {
      try {
        await releaseDriverHandle(deps.driver, handle);
      } catch (err) {
        /* c8 ignore start -- defensive */
        logger.warn({ err, taskId }, "release driver handle failed");
        /* c8 ignore stop */
      }
    }
    releaseAndPromote(taskId);

    if (terminal && deps.notifier) {
      try {
        await deps.notifier.notifyTerminal({
          taskId,
          originatingChannel: terminal.originatingChannel,
          state: terminal.state,
          outcomeDetail: terminal.outcomeDetail,
        });
      } catch (err) {
        logger.warn(
          { err, taskId },
          "notifyTerminal failed (continuing)",
        );
      }
    }

    return {
      ok: terminalState === "completed",
      reason: terminalState,
      state: terminal?.state ?? terminalState,
    };
  }

  async function runDriverFromPending(
    taskId: string,
  ): Promise<RunResult> {
    if (!deps.driver) {
      // Phase 1 fallback — driver wiring not in place yet. Flip
      // straight to failed(not_implemented) so the row doesn't hang.
      const finishedAt = now();
      const terminal = markTerminal(deps.db, {
        id: taskId,
        state: "failed",
        outcomeDetail: "not_implemented",
        report: null,
        finishedAt,
      });
      emitter.emitFromRow(terminal, finishedAt);
      pendingAborts.delete(taskId);
      releaseAndPromote(taskId);
      if (terminal && deps.notifier) {
        try {
          await deps.notifier.notifyTerminal({
            taskId,
            originatingChannel: terminal.originatingChannel,
            state: terminal.state,
            outcomeDetail: terminal.outcomeDetail,
          });
        } catch (err) {
          logger.warn({ err, taskId }, "notifyTerminal failed (continuing)");
        }
      }
      logger.warn(
        { taskId },
        "browser-task runner has no driver wired — fell back to failed(not_implemented).",
      );
      return {
        ok: false,
        reason: "not_implemented",
        state: terminal?.state ?? "failed",
      };
    }

    const row = getBrowserTask(deps.db, taskId);
    if (!row) {
      pendingAborts.delete(taskId);
      releaseAndPromote(taskId);
      return { ok: false, reason: "task_missing", state: null };
    }

    const prepared = await prepareDriverHandle({ deps: deps.driver, row });
    if (!prepared.ok) {
      const finishedAt = now();
      const terminal = markTerminal(deps.db, {
        id: taskId,
        state: "failed",
        outcomeDetail: prepared.detail ?? prepared.reason,
        report: null,
        finishedAt,
      });
      emitter.emitFromRow(terminal, finishedAt);
      pendingAborts.delete(taskId);
      releaseAndPromote(taskId);
      if (terminal && deps.notifier) {
        try {
          await deps.notifier.notifyTerminal({
            taskId,
            originatingChannel: terminal.originatingChannel,
            state: terminal.state,
            outcomeDetail: terminal.outcomeDetail,
          });
        } catch (err) {
          logger.warn({ err, taskId }, "notifyTerminal failed (continuing)");
        }
      }
      return { ok: false, reason: "failed", state: terminal?.state ?? "failed" };
    }

    const handle = prepared.handle;
    liveHandles.set(taskId, handle);
    // Honour any `cancel()` that landed during the async
    // `prepareDriverHandle` window — `cancel()` could not have found a
    // handle in `liveHandles` / `parkedHandles` at that moment, so it
    // stashed the reason in `pendingAborts`. Forward the abort to the
    // real `AbortController` now so the SDK loop short-circuits on its
    // first message and `runDriver` returns `outcome=cancelled`. The
    // existing `reconcileDriverOutcome` path then writes the terminal +
    // releases the Playwright handle + slot.
    const pendingAbort = pendingAborts.get(taskId);
    if (pendingAbort !== undefined) {
      pendingAborts.delete(taskId);
      try {
        handle.abortController.abort(new Error(pendingAbort));
      } catch (err) {
        /* c8 ignore start -- defensive */
        logger.warn(
          { err, taskId, reason: pendingAbort },
          "browser-task: forwarding pending-cancel abort failed (continuing)",
        );
        /* c8 ignore stop */
      }
    }

    let result: DriverRunResult;
    try {
      result = await runDriver(deps.driver, row, handle);
    } catch (err) {
      logger.error({ err, taskId }, "browser-task driver threw");
      result = {
        outcome: "sdk_error",
        sdkSessionId: handle.sdkSessionId,
        detail: err instanceof Error ? err.message : String(err),
        costUsd: 0,
        numTurns: 0,
        durationMs: 0,
      };
    }
    return reconcileDriverOutcome({ taskId, handle, result });
  }

  async function runOnce(
    taskId: string,
    label: "post" | "schedule",
  ): Promise<RunResult> {
    const row = getBrowserTask(deps.db, taskId);
    if (!row) {
      return { ok: false, reason: "task_missing", state: null };
    }
    if (row.state !== "pending") {
      return { ok: false, reason: "already_terminal", state: row.state };
    }
    const { promoted, blocked, alreadyTracked } = tryAcquire(taskId);
    if (alreadyTracked) {
      // Defensive — another invocation path already owns the slot.
      // Skip without a queue DM so the user doesn't see a duplicate
      // "queued" notification. The other invocation will drive the
      // task to terminal.
      return { ok: false, reason: "already_terminal", state: row.state };
    }
    if (!promoted) {
      logger.info(
        { taskId, blocked, source: label },
        "browser-task queued — waiting for slot",
      );
      if (deps.notifier) {
        try {
          await deps.notifier.notifyQueued({
            taskId,
            originatingChannel: row.originatingChannel,
            blockedCount: blocked,
          });
        } catch (err) {
          logger.warn({ err, taskId }, "notifyQueued failed (continuing)");
        }
      }
      return { ok: true, reason: "queued", state: "pending" };
    }
    const startedAt = now();
    const runningRow = markRunning(deps.db, taskId, startedAt);
    if (runningRow) emitter.emitFromRow(runningRow, startedAt);
    if (!runningRow) {
      // CAS miss — the task was cancelled-in-queue or already
      // transitioned. Release the slot and return.
      pendingAborts.delete(taskId);
      releaseAndPromote(taskId);
      const afterRow = getBrowserTask(deps.db, taskId);
      return {
        ok: false,
        reason: "already_terminal",
        state: afterRow?.state ?? null,
      };
    }
    return runDriverFromPending(taskId);
  }

  async function runFromPost(taskId: string): Promise<RunResult> {
    return runOnce(taskId, "post");
  }

  async function runFromScheduleRow(taskId: string): Promise<RunResult> {
    return runOnce(taskId, "schedule");
  }

  async function cancel(taskId: string, reason: string): Promise<boolean> {
    const row = getBrowserTask(deps.db, taskId);
    if (!row) return false;
    const live = liveHandles.get(taskId);
    const parked = parkedHandles.get(taskId);
    const handle = live ?? parked;
    if (handle) {
      try {
        handle.abortController.abort(new Error(reason || "cancel"));
      } catch (err) {
        /* c8 ignore start -- defensive */
        logger.warn({ err, taskId }, "abort signal failed");
        /* c8 ignore stop */
      }
    } else if (row.state === "running") {
      // No handle tracked but the row is `running` — the runner is mid-
      // `prepareDriverHandle` (slot acquired, Chromium spawning). Record
      // the abort intent so the handle, once registered at
      // `runDriverFromPending`, fires the abort before the SDK loop
      // begins (consumed + deleted there). Without this, a cancel
      // landing in that window is silently dropped and the SDK runs
      // anyway, burning turns / cost.
      //
      // The parked states (`awaiting_user`/`final_confirm`) always have a
      // tracked handle, so they take the `handle` branch above.
      pendingAborts.set(taskId, reason || "cancel");
    } else if (row.state === "pending") {
      // Queued behind the concurrency cap (or in the narrow acquire→
      // markRunning window). The HTTP `/cancel` route handles `pending`
      // itself, but `!stop <id>` (Phase 4) calls `cancel()` directly — so
      // the runner must own this state too, or the bang path reports a
      // false "Stopping…" while the task keeps running.
      if (slotManagerHasActive(deps.slotStateRef.state, taskId)) {
        // `tryAcquire` already promoted the task (slot active) but
        // `markRunning` hasn't flipped the DB row yet — `decideCancel`
        // would throw on an active occupant. Record the abort intent like
        // the running case; the handle registered at `runDriverFromPending`
        // fires it before the SDK loop begins (and drains the map entry,
        // so it does not leak).
        pendingAborts.set(taskId, reason || "cancel");
      } else {
        // Genuinely queued — drop the FIFO entry and write the terminal
        // directly (no slot was held, so no release cascade). Mirrors the
        // route's `isPending` path and the background runner.
        try {
          deps.slotStateRef.state = decideCancel(
            deps.slotStateRef.state,
            taskId,
          ).state;
        } catch (err) {
          /* c8 ignore start -- defensive: slot promoted between the check and here */
          logger.warn(
            { err, taskId },
            "decideCancel on pending row failed (continuing)",
          );
          /* c8 ignore stop */
        }
        const finishedAt = now();
        const terminal = markTerminal(deps.db, {
          id: taskId,
          state: "cancelled",
          outcomeDetail: `cancelled_in_queue:${reason}`,
          report: null,
          finishedAt,
        });
        emitter.emitFromRow(terminal, finishedAt);
        logger.info(
          { taskId, reason },
          "browser-task cancel (pending → cancelled)",
        );
        return true;
      }
    }
    if (handle) {
      // Cancel any pending lite-final-confirm tokens issued by this
      // task — otherwise a gate that was mid-flight leaves a token
      // listening on the user's DM channel after the parent is dead,
      // and a stale `!~xxxxxxxx` reply could resolve nothing visible.
      // Best-effort; failures log + continue. (B-4 purchase tokens
      // are NOT cancelled here — they have their own per-purchase
      // lifecycle owned by `purchase-handler`.)
      if (deps.driver?.finalConfirmHandler) {
        try {
          await deps.driver.finalConfirmHandler.cancelPendingForTask(taskId);
        } catch (err) {
          /* c8 ignore start -- defensive */
          logger.warn(
            { err, taskId },
            "cancel: lite-final-confirm cancelPendingForTask failed (continuing)",
          );
          /* c8 ignore stop */
        }
      }
    }
    // For parked tasks the SDK is not iterating, so abort alone does
    // not unwind. Walk through the terminal-transition path manually.
    if (parked && !live) {
      parkedHandles.delete(taskId);
      if (deps.driver) {
        try {
          await releaseDriverHandle(deps.driver, parked);
        } catch (err) {
          /* c8 ignore start -- defensive */
          logger.warn({ err, taskId }, "release parked handle failed");
          /* c8 ignore stop */
        }
      }
      const finishedAt = now();
      const terminal = markTerminal(deps.db, {
        id: taskId,
        state: "cancelled",
        outcomeDetail: reason,
        report: null,
        finishedAt,
      });
      emitter.emitFromRow(terminal, finishedAt);
      pendingAborts.delete(taskId);
      releaseAndPromote(taskId);
      if (terminal && deps.notifier) {
        try {
          await deps.notifier.notifyTerminal({
            taskId,
            originatingChannel: terminal.originatingChannel,
            state: terminal.state,
            outcomeDetail: terminal.outcomeDetail,
          });
        } catch (err) {
          logger.warn({ err, taskId }, "notifyTerminal failed (continuing)");
        }
      }
    }
    logger.info(
      { taskId, reason, currentState: row.state, hadLive: !!live, hadParked: !!parked },
      "browser-task cancel",
    );
    return true;
  }

  async function resumeAfterClarification(input: {
    taskId: string;
    clarificationId: string;
    answer: string;
  }): Promise<RunResult> {
    const handle = parkedHandles.get(input.taskId);
    if (!handle) {
      // The /clarify route flips the clarification row before calling
      // this — if the handle is gone (daemon restart, race with cancel)
      // we cannot resume. Flip to failed.
      logger.warn(
        { taskId: input.taskId },
        "resumeAfterClarification: no parked handle — task cannot be resumed",
      );
      const finishedAt = now();
      const terminal = markTerminal(deps.db, {
        id: input.taskId,
        state: "failed",
        outcomeDetail: "clarify_no_parked_handle",
        report: null,
        finishedAt,
      });
      emitter.emitFromRow(terminal, finishedAt);
      releaseAndPromote(input.taskId);
      return {
        ok: false,
        reason: "failed",
        state: terminal?.state ?? "failed",
      };
    }
    const row = getBrowserTask(deps.db, input.taskId);
    if (!row) {
      parkedHandles.delete(input.taskId);
      if (deps.driver) {
        try {
          await releaseDriverHandle(deps.driver, handle);
        } catch (err) {
          /* c8 ignore start -- defensive */
          logger.warn({ err, taskId: input.taskId }, "release missing-row handle failed");
          /* c8 ignore stop */
        }
      }
      return { ok: false, reason: "task_missing", state: null };
    }
    // The /clarify route already resolved the clarification row + the
    // state transition to running-from-parked. We belt-and-suspender the
    // transition here for cases where the route layer (a future programmatic
    // caller) skipped it.
    const resumedAt = now();
    const resumed = markRunningFromParked(deps.db, input.taskId);
    if (resumed) emitter.emitFromRow(resumed, resumedAt);
    // Best-effort: keep the clarifications store consistent in case the
    // caller landed straight here via internal API.
    void resolveClarification;

    if (!deps.driver) {
      // No driver wired — flip to failed.
      parkedHandles.delete(input.taskId);
      const finishedAt = now();
      const terminal = markTerminal(deps.db, {
        id: input.taskId,
        state: "failed",
        outcomeDetail: "no_driver",
        report: null,
        finishedAt,
      });
      emitter.emitFromRow(terminal, finishedAt);
      releaseAndPromote(input.taskId);
      return {
        ok: false,
        reason: "failed",
        state: terminal?.state ?? "failed",
      };
    }

    // Move from parked to live for the duration of the resume turn.
    parkedHandles.delete(input.taskId);
    liveHandles.set(input.taskId, handle);
    unparkSlot(input.taskId);

    let result: DriverRunResult;
    try {
      result = await resumeDriver(deps.driver, row, handle, input.answer);
    } catch (err) {
      logger.error({ err, taskId: input.taskId }, "browser-task resume threw");
      result = {
        outcome: "sdk_error",
        sdkSessionId: handle.sdkSessionId,
        detail: err instanceof Error ? err.message : String(err),
        costUsd: 0,
        numTurns: 0,
        durationMs: 0,
      };
    }
    return reconcileDriverOutcome({
      taskId: input.taskId,
      handle,
      result,
    });
  }

  async function expireForDeadline(
    taskId: string,
    kind: "clarification_deadline" | "queue_timeout",
    waitedMs?: number,
  ): Promise<RunResult> {
    const row = getBrowserTask(deps.db, taskId);
    if (!row) return { ok: false, reason: "task_missing", state: null };
    if (
      row.state === "completed"
      || row.state === "failed"
      || row.state === "timeout"
      || row.state === "cancelled"
      || row.state === "abandoned"
    ) {
      return { ok: false, reason: "already_terminal", state: row.state };
    }

    const targetState = kind === "clarification_deadline" ? "abandoned" : "failed";
    const outcomeDetail = kind === "clarification_deadline"
      ? "clarification_deadline"
      : "queue_timeout";

    // For an active task whose handle is still alive (parked OR a
    // late-firing live entry), release the Playwright resources BEFORE
    // writing the terminal so the next promoted task on the same
    // `--user-data-dir` doesn't trip Chromium's SingletonLock. Also
    // abort the in-flight SDK if any so it stops billing turns.
    const parked = parkedHandles.get(taskId);
    const live = liveHandles.get(taskId);
    const handle = parked ?? live;
    if (handle) {
      try {
        handle.abortController.abort(new Error(outcomeDetail));
      } catch (err) {
        /* c8 ignore start -- defensive */
        logger.warn(
          { err, taskId, kind },
          "expireForDeadline: abort signal failed (continuing)",
        );
        /* c8 ignore stop */
      }
      // Best-effort cancel of any open final-confirm token tied to the
      // expired task — same posture as `cancel()`.
      if (deps.driver?.finalConfirmHandler) {
        try {
          await deps.driver.finalConfirmHandler.cancelPendingForTask(taskId);
        } catch (err) {
          /* c8 ignore start -- defensive */
          logger.warn(
            { err, taskId },
            "expireForDeadline: cancelPendingForTask failed (continuing)",
          );
          /* c8 ignore stop */
        }
      }
    }
    if (parked) {
      parkedHandles.delete(taskId);
      if (deps.driver) {
        try {
          await releaseDriverHandle(deps.driver, parked);
        } catch (err) {
          /* c8 ignore start -- defensive */
          logger.warn(
            { err, taskId, kind },
            "expireForDeadline: parked handle release failed (continuing)",
          );
          /* c8 ignore stop */
        }
      }
    }

    const finishedAt = now();
    const terminal = markTerminal(deps.db, {
      id: taskId,
      state: targetState,
      outcomeDetail,
      report: null,
      finishedAt,
    });
    emitter.emitFromRow(terminal, finishedAt);
    pendingAborts.delete(taskId);
    // Slot-release policy by handle kind:
    //   - parked clarification-deadline: handle already released above;
    //     free the slot + promote here.
    //   - queue_timeout (pending row, no handle): the caller already
    //     removed the FIFO entry via `sweepPendingTimeouts`, so this is
    //     a no-op — but harmless and keeps the promote cascade running.
    //   - live-only handle (clarification deadline racing a still-live
    //     run): do NOT free the slot here. The abort above unwinds the
    //     SDK into `reconcileDriverOutcome`, which calls
    //     `releaseDriverHandle` (release the live Chromium) BEFORE
    //     `releaseAndPromote` — preserving release-before-promote so a
    //     queued same-siteKey task can't promote into a Chromium
    //     SingletonLock clash on the shared `--user-data-dir` (§5.1).
    if (parked || !live) {
      releaseAndPromote(taskId);
    }
    if (terminal && deps.notifier) {
      try {
        await deps.notifier.notifyTerminal({
          taskId,
          originatingChannel: terminal.originatingChannel,
          state: terminal.state,
          outcomeDetail: terminal.outcomeDetail,
        });
      } catch (err) {
        logger.warn(
          { err, taskId, kind },
          "expireForDeadline notifyTerminal failed (continuing)",
        );
      }
    }
    logger.info(
      {
        taskId,
        kind,
        hadParked: !!parked,
        hadLive: !!live,
        waitedMs,
      },
      "browser-task expired for deadline",
    );
    return {
      ok: false,
      reason: kind === "clarification_deadline" ? "abandoned" : "failed",
      state: terminal?.state ?? targetState,
    };
  }

  function __peekParkedIds(): readonly string[] {
    return Array.from(parkedHandles.keys());
  }

  return {
    runFromPost,
    runFromScheduleRow,
    cancel,
    resumeAfterClarification,
    expireForDeadline,
    __peekParkedIds,
  };
}
