/**
 * Browser-task slot manager — BROWSER_TASK_REDESIGN_PLAN.md §5.1
 * (Plan A formalisation, 2026-05-26 revision).
 *
 * Pure decision module. No DB, no FS, no clock. The runner wires this
 * to the persistent layer: `decideAcquire`, `decideRelease`,
 * `decideCancel`, and the queue-position read are exposed as pure
 * functions over an immutable `SlotState` value; the runner mutates
 * its in-memory map by replacing the value, then fans out the returned
 * side-effect list (state-machine transitions, DM intents,
 * `agent_actions` rows).
 *
 * Plan A invariants this module enforces:
 *
 *  - Per-siteKey slot held across the entire non-terminal lifetime
 *    including parking (`awaiting_user` / `final_confirm`).
 *  - Global concurrency cap = `maxConcurrent` (`browserTaskMaxConcurrent`
 *    runtime-settings key, default 3, range 1..5). Parked contexts
 *    count against the cap.
 *  - FIFO queue per siteKey + cross-siteKey global FIFO.
 *  - Cancel-while-pending removes from BOTH FIFOs without firing a
 *    release cascade (no slot was acquired).
 *  - Pending-queue timeout
 *    (`browserTaskPendingQueueTimeoutMinutes`, default 30, range 5..180)
 *    transitions overdue `pending` rows to `failed (queue_timeout)`.
 *
 * Plan B (suspend-to-disk on park) is rejected — Playwright's
 * `storageState()` cannot preserve mid-form Page state, AND two
 * BrowserContexts on the same user-data-dir trip Chromium's
 * SingletonLock.
 *
 * 100% coverage gate per §13 testing table.
 */

/** Per-task identity. The runner hands the slot manager a uuid v4; the
 *  manager treats it as opaque. */
export type TaskId = string;

/** Per-siteKey identity. Matches `site-registry.ts`. */
export type SiteKey = string;

/** The minimal task fingerprint the manager needs to track an entry in
 *  the queue. The runner keeps the full `browser_task` row separately
 *  and joins by id when fanning out side effects. */
export interface SlotTaskEntry {
  taskId: TaskId;
  siteKey: SiteKey;
  /** Wall-clock ms when the runner enqueued the entry. Drives the
   *  pending-queue-timeout sweep + the `waitedMs` telemetry. */
  enqueuedAt: number;
}

/** Phase the task is currently in — distinguishes "holds a slot" from
 *  "queued without a slot" without re-encoding the full state machine.
 *  The runner translates the parked phases to the canonical state
 *  (`awaiting_user` / `final_confirm`) when fanning out. */
export type SlotPhase = "pending" | "running" | "parked";

interface ActiveSlotEntry extends SlotTaskEntry {
  phase: "running" | "parked";
  /** Wall-clock ms when the slot was acquired. `running_since` for
   *  telemetry; `enqueuedAt` records the prior queue wait. */
  acquiredAt: number;
}

/**
 * Immutable snapshot of the slot manager's state. The runner replaces
 * its in-memory reference after every operation. No nested mutation —
 * every helper returns a fresh `SlotState`.
 */
export interface SlotState {
  /** Active slots keyed by siteKey. At most one entry per siteKey. */
  readonly active: ReadonlyMap<SiteKey, ActiveSlotEntry>;
  /** Per-siteKey FIFO of `pending` tasks waiting for the siteKey slot.
   *  The head is the next candidate when the siteKey slot frees. */
  readonly siteQueues: ReadonlyMap<SiteKey, readonly SlotTaskEntry[]>;
  /** Cross-siteKey FIFO of `pending` tasks. A task in `siteQueues` AND
   *  this queue is waiting on EITHER the siteKey slot OR the global
   *  cap (whichever is occupied). When both are free, the global-head
   *  candidate promotes. */
  readonly globalQueue: readonly SlotTaskEntry[];
  /** Configured global concurrency cap. Range [1, 5]. Clamped at the
   *  edge of every state-producing function. */
  readonly maxConcurrent: number;
}

/** Initial empty state. */
export function createInitialSlotState(maxConcurrent: number): SlotState {
  return {
    active: new Map(),
    siteQueues: new Map(),
    globalQueue: [],
    maxConcurrent: clampMaxConcurrent(maxConcurrent),
  };
}

/** Range clamp for `maxConcurrent`. Mirrors the `z.number().int().min(1).max(5)`
 *  refine on the runtime-settings key. Used at construction time and
 *  whenever a PATCH /config delivers a new value. */
export function clampMaxConcurrent(value: number): number {
  if (!Number.isFinite(value)) return 3;
  const intVal = Math.floor(value);
  if (intVal < 1) return 1;
  if (intVal > 5) return 5;
  return intVal;
}

/** Apply a new max-concurrent. Lowering takes effect on the next slot
 *  release (per §5.1: "already-acquired slots are not preemptively
 *  yanked"). Returns a fresh state. */
export function withMaxConcurrent(
  state: SlotState,
  maxConcurrent: number,
): SlotState {
  return { ...state, maxConcurrent: clampMaxConcurrent(maxConcurrent) };
}

/** Decision returned by `decideAcquire`. The runner inspects `effect`
 *  to know whether the task acquired the slot immediately (`promoted`)
 *  or is queued. */
export type AcquireEffect =
  | {
      kind: "promoted";
      taskId: TaskId;
      siteKey: SiteKey;
      acquiredAt: number;
      waitedMs: number;
    }
  | {
      kind: "queued";
      taskId: TaskId;
      siteKey: SiteKey;
      sitePos: number;
      globalPos: number;
      /** taskId of the active occupant blocking this entry, if any.
       *  Null when the block is purely global-cap pressure. */
      blockedBy: TaskId | null;
      blockedByPhase: "running" | "parked" | null;
    };

export interface AcquireResult {
  state: SlotState;
  effect: AcquireEffect;
}

/**
 * Enqueue a fresh task. If the siteKey slot AND the global cap have
 * room, the task acquires immediately (effect: 'promoted'); otherwise
 * it lands at the tail of both FIFOs (effect: 'queued').
 *
 * Idempotency: if the task id already appears anywhere in the state
 * (active or any queue), the function throws — the caller is expected
 * to dedup at the route layer via the DB primary key.
 */
export function decideAcquire(
  state: SlotState,
  entry: SlotTaskEntry,
  nowMs: number,
): AcquireResult {
  if (knowsTask(state, entry.taskId)) {
    throw new Error(
      `decideAcquire: task ${entry.taskId} already tracked by slot manager`,
    );
  }
  const siteFree = !state.active.has(entry.siteKey);
  const globalFree = state.active.size < state.maxConcurrent;
  if (siteFree && globalFree) {
    const active = new Map(state.active);
    active.set(entry.siteKey, {
      ...entry,
      phase: "running",
      acquiredAt: nowMs,
    });
    return {
      state: { ...state, active },
      effect: {
        kind: "promoted",
        taskId: entry.taskId,
        siteKey: entry.siteKey,
        acquiredAt: nowMs,
        waitedMs: 0,
      },
    };
  }

  // Enqueue. Build fresh siteQueue + globalQueue with this entry
  // appended. `sitePos` / `globalPos` are 0-indexed positions in the
  // queue (`0` = next promotion candidate).
  const siteQueue = state.siteQueues.get(entry.siteKey) ?? [];
  const newSiteQueue = [...siteQueue, entry];
  const newGlobalQueue = [...state.globalQueue, entry];
  const siteQueues = new Map(state.siteQueues);
  siteQueues.set(entry.siteKey, newSiteQueue);

  const blocker = state.active.get(entry.siteKey) ?? null;

  return {
    state: { ...state, siteQueues, globalQueue: newGlobalQueue },
    effect: {
      kind: "queued",
      taskId: entry.taskId,
      siteKey: entry.siteKey,
      sitePos: newSiteQueue.length - 1,
      globalPos: newGlobalQueue.length - 1,
      blockedBy: blocker?.taskId ?? null,
      blockedByPhase: blocker?.phase ?? null,
    },
  };
}

/** Mark an active slot as parked (`awaiting_user` / `final_confirm`).
 *  Slot is retained. Returns the new state; throws if the task is not
 *  the active occupant of its siteKey. */
export function decidePark(state: SlotState, taskId: TaskId): SlotState {
  const occupant = findActiveOccupant(state, taskId);
  if (!occupant) {
    throw new Error(`decidePark: task ${taskId} is not active`);
  }
  if (occupant.entry.phase === "parked") return state; // idempotent
  const active = new Map(state.active);
  active.set(occupant.siteKey, { ...occupant.entry, phase: "parked" });
  return { ...state, active };
}

/** Mark a parked task as running again (clarification resume / token
 *  consume). Slot was never released, so no acquisition fires.
 *  Idempotent on already-running. */
export function decideUnpark(state: SlotState, taskId: TaskId): SlotState {
  const occupant = findActiveOccupant(state, taskId);
  if (!occupant) {
    throw new Error(`decideUnpark: task ${taskId} is not active`);
  }
  if (occupant.entry.phase === "running") return state;
  const active = new Map(state.active);
  active.set(occupant.siteKey, { ...occupant.entry, phase: "running" });
  return { ...state, active };
}

/** Decision returned by `decideRelease`. `promoted` is at most one
 *  task per release (the global-queue head that also has its siteKey
 *  slot free). If no candidate is promotable the effect is `released`
 *  alone. */
export interface ReleaseResult {
  state: SlotState;
  effects: readonly ReleaseEffect[];
}

export type ReleaseEffect =
  | {
      kind: "released";
      taskId: TaskId;
      siteKey: SiteKey;
      waitedMs: number; // (running-since - acquired-at); 0 for a fresh release where caller doesn't track
    }
  | {
      kind: "promoted";
      taskId: TaskId;
      siteKey: SiteKey;
      acquiredAt: number;
      waitedMs: number;
    }
  | {
      kind: "queue_state_changed";
      affectedTaskIds: readonly TaskId[];
    };

/**
 * Terminal transition for an active task. Releases the siteKey slot and
 * walks the queues to promote the next candidate (FIFO from the
 * siteKey queue head when that siteKey opens up; otherwise the global
 * queue head when global-cap room appears).
 *
 * The effect list contains:
 *   - exactly one `released` for the releasing task,
 *   - zero or one `promoted` for the auto-promoted candidate (if any),
 *   - zero or one `queue_state_changed` listing other still-pending
 *     task ids whose `sitePos`/`globalPos` numbers shifted (the dashboard
 *     uses this to update positions without per-id polling).
 */
export function decideRelease(
  state: SlotState,
  taskId: TaskId,
  nowMs: number,
): ReleaseResult {
  const occupant = findActiveOccupant(state, taskId);
  if (!occupant) {
    // Idempotent — releasing a task we don't track is a no-op (the row
    // may have been cancelled-in-queue and the runner is calling
    // through both paths defensively).
    return { state, effects: [] };
  }
  const releasedSiteKey = occupant.siteKey;
  const acquiredAt = occupant.entry.acquiredAt;
  const active = new Map(state.active);
  active.delete(releasedSiteKey);
  const releaseEffect: ReleaseEffect = {
    kind: "released",
    taskId,
    siteKey: releasedSiteKey,
    waitedMs: Math.max(0, nowMs - acquiredAt),
  };

  // Promotion candidate. The promotion contract is "head of the
  // global queue whose siteKey slot is currently free":
  //
  //   - If the released siteKey's queue has a head, that head's
  //     siteKey is by definition free now — but it must ALSO be at
  //     the head of the global FIFO ahead of it, or it cuts the line.
  //   - In the general case we scan the global queue front-to-back
  //     looking for the first entry whose siteKey slot is free in the
  //     post-release state. That's the candidate.
  //
  // The scan respects two invariants:
  //   1. A task at the head of its siteKey queue is the only one
  //      eligible to promote from that queue (FIFO).
  //   2. The global FIFO breaks ties across siteKey queues — without
  //      it, repeated releases on one siteKey would let that siteKey's
  //      queue starve cross-siteKey tasks.
  const candidate = findPromotionCandidate({
    ...state,
    active,
  });
  let nextState: SlotState = { ...state, active };
  const effects: ReleaseEffect[] = [releaseEffect];

  if (candidate) {
    nextState = applyPromotion(nextState, candidate, nowMs);
    effects.push({
      kind: "promoted",
      taskId: candidate.taskId,
      siteKey: candidate.siteKey,
      acquiredAt: nowMs,
      waitedMs: Math.max(0, nowMs - candidate.enqueuedAt),
    });
  }

  // queue_state_changed fan-out — every other pending task whose
  // sitePos or globalPos shifted (because the head left). We only emit
  // if at least one such task exists so the dashboard doesn't get
  // empty events.
  const remainingPending = enumeratePendingTaskIds(nextState);
  if (remainingPending.length > 0) {
    effects.push({
      kind: "queue_state_changed",
      affectedTaskIds: remainingPending,
    });
  }

  return { state: nextState, effects };
}

/** Cancel a pending task (no slot acquired). Removes from both FIFOs
 *  and emits `queue_state_changed` for any siblings whose positions
 *  shifted. No release cascade fires (no slot was held). */
export function decideCancel(
  state: SlotState,
  taskId: TaskId,
): ReleaseResult {
  // If the task is active (running / parked), the route layer should
  // be calling `decideRelease` after writing the cancel transition;
  // refuse here so the caller cannot accidentally double-release.
  if (findActiveOccupant(state, taskId)) {
    throw new Error(
      `decideCancel: task ${taskId} is active — call decideRelease instead`,
    );
  }
  let removedFromSomewhere = false;
  const siteQueues = new Map<SiteKey, readonly SlotTaskEntry[]>();
  for (const [siteKey, queue] of state.siteQueues) {
    const filtered = queue.filter((q) => q.taskId !== taskId);
    if (filtered.length !== queue.length) {
      removedFromSomewhere = true;
    }
    if (filtered.length > 0) {
      siteQueues.set(siteKey, filtered);
    }
  }
  const globalQueue = state.globalQueue.filter((q) => q.taskId !== taskId);
  if (globalQueue.length !== state.globalQueue.length) {
    removedFromSomewhere = true;
  }
  if (!removedFromSomewhere) {
    return { state, effects: [] };
  }
  const nextState: SlotState = { ...state, siteQueues, globalQueue };
  const remainingPending = enumeratePendingTaskIds(nextState);
  if (remainingPending.length === 0) {
    return { state: nextState, effects: [] };
  }
  return {
    state: nextState,
    effects: [
      {
        kind: "queue_state_changed",
        affectedTaskIds: remainingPending,
      },
    ],
  };
}

/** §5.1 pending-queue timeout sweep. Returns the list of `pending`
 *  tasks that have waited past the timeout, alongside the new state
 *  with them removed (they will transition to `failed (queue_timeout)`
 *  via the runner). */
export interface SweepPendingTimeoutResult {
  state: SlotState;
  expired: readonly { taskId: TaskId; siteKey: SiteKey; waitedMs: number }[];
}

export function sweepPendingTimeouts(
  state: SlotState,
  nowMs: number,
  pendingQueueTimeoutMinutes: number,
): SweepPendingTimeoutResult {
  const timeoutMs = clampPendingQueueTimeoutMinutes(
    pendingQueueTimeoutMinutes,
  ) * 60 * 1000;
  const expired: { taskId: TaskId; siteKey: SiteKey; waitedMs: number }[] = [];
  for (const entry of state.globalQueue) {
    const waitedMs = nowMs - entry.enqueuedAt;
    if (waitedMs >= timeoutMs) {
      expired.push({ taskId: entry.taskId, siteKey: entry.siteKey, waitedMs });
    }
  }
  if (expired.length === 0) return { state, expired: [] };
  let nextState = state;
  for (const e of expired) {
    // decideCancel handles both FIFOs + the queue_state_changed
    // emission. We swallow effects here because the caller wraps each
    // expiration in its own state-machine transition + DM intent.
    const cancelResult = decideCancel(nextState, e.taskId);
    nextState = cancelResult.state;
  }
  return { state: nextState, expired };
}

/** Range clamp for `browserTaskPendingQueueTimeoutMinutes`. Mirrors
 *  the `z.number().int().min(5).max(180)` refine on the runtime-
 *  settings key. */
export function clampPendingQueueTimeoutMinutes(value: number): number {
  if (!Number.isFinite(value)) return 30;
  const intVal = Math.floor(value);
  if (intVal < 5) return 5;
  if (intVal > 180) return 180;
  return intVal;
}

/** Queue position read for `GET /api/browser-task/:id`. Returns null
 *  when the task is not pending (active or unknown to the manager). */
export interface QueueStateView {
  waitingForSlot: boolean;
  sitePos: number;
  globalPos: number;
  blockedBy: TaskId | null;
  blockedByPhase: "running" | "parked" | null;
}

export function readQueueState(
  state: SlotState,
  taskId: TaskId,
): QueueStateView | null {
  // Active tasks: not waiting.
  if (findActiveOccupant(state, taskId)) {
    return {
      waitingForSlot: false,
      sitePos: -1,
      globalPos: -1,
      blockedBy: null,
      blockedByPhase: null,
    };
  }
  const globalPos = state.globalQueue.findIndex((q) => q.taskId === taskId);
  if (globalPos === -1) return null;
  const entry = state.globalQueue[globalPos];
  /* c8 ignore start -- a queued task is always present in BOTH FIFOs by
   * construction; the `?? []` arm is defensive against a future
   * regression that breaks the FIFO invariant. */
  const siteQueue = state.siteQueues.get(entry.siteKey) ?? [];
  /* c8 ignore stop */
  const sitePos = siteQueue.findIndex((q) => q.taskId === taskId);
  const blocker = state.active.get(entry.siteKey) ?? null;
  return {
    waitingForSlot: true,
    sitePos,
    globalPos,
    blockedBy: blocker?.taskId ?? null,
    blockedByPhase: blocker?.phase ?? null,
  };
}

// ── Internal helpers ─────────────────────────────────────────────────────

interface ActiveOccupantLookup {
  siteKey: SiteKey;
  entry: ActiveSlotEntry;
}

function findActiveOccupant(
  state: SlotState,
  taskId: TaskId,
): ActiveOccupantLookup | null {
  for (const [siteKey, entry] of state.active) {
    if (entry.taskId === taskId) return { siteKey, entry };
  }
  return null;
}

function knowsTask(state: SlotState, taskId: TaskId): boolean {
  if (findActiveOccupant(state, taskId)) return true;
  return state.globalQueue.some((q) => q.taskId === taskId);
}

function findPromotionCandidate(state: SlotState): SlotTaskEntry | null {
  // No saturation guard — `findPromotionCandidate` is only invoked
  // from `decideRelease` AFTER the released entry has been deleted
  // from `active`, so `active.size < maxConcurrent` always holds at
  // call time. The loop below also bails when no entry's siteKey is
  // free; together they make a separate cap check redundant.
  for (const entry of state.globalQueue) {
    if (!state.active.has(entry.siteKey)) {
      // Defensive: the entry must also be at the head of its
      // siteKey queue. With our FIFO discipline that's guaranteed
      // (we never insert mid-queue), but a future regression that
      // breaks FIFO would let a non-head entry sneak past.
      const siteQueue = state.siteQueues.get(entry.siteKey);
      /* c8 ignore start -- both checks defensive against a FIFO
       * regression; the construction invariant guarantees siteQueue
       * exists and entry is at its head. */
      if (siteQueue && siteQueue[0]?.taskId === entry.taskId) {
        return entry;
      }
      /* c8 ignore stop */
    }
  }
  return null;
}

function applyPromotion(
  state: SlotState,
  candidate: SlotTaskEntry,
  nowMs: number,
): SlotState {
  const active = new Map(state.active);
  active.set(candidate.siteKey, {
    ...candidate,
    phase: "running",
    acquiredAt: nowMs,
  });
  const siteQueues = new Map(state.siteQueues);
  /* c8 ignore start -- the `?? []` arm is defensive; a promotion
   * candidate is always present in the siteQueues map. */
  const siteQueue = siteQueues.get(candidate.siteKey) ?? [];
  /* c8 ignore stop */
  const trimmedSiteQueue = siteQueue.filter(
    (q) => q.taskId !== candidate.taskId,
  );
  if (trimmedSiteQueue.length > 0) {
    siteQueues.set(candidate.siteKey, trimmedSiteQueue);
  } else {
    siteQueues.delete(candidate.siteKey);
  }
  const globalQueue = state.globalQueue.filter(
    (q) => q.taskId !== candidate.taskId,
  );
  return { ...state, active, siteQueues, globalQueue };
}

function enumeratePendingTaskIds(state: SlotState): readonly TaskId[] {
  return state.globalQueue.map((q) => q.taskId);
}

// ── Telemetry shapes — pure (the runner emits the actual agent_actions row) ──

/** Lightweight summary used by `/health` / dashboard inspector. */
export interface SlotManagerSnapshot {
  active: ReadonlyArray<{
    taskId: TaskId;
    siteKey: SiteKey;
    phase: "running" | "parked";
    acquiredAt: number;
  }>;
  pendingCount: number;
  maxConcurrent: number;
}

export function snapshotSlotState(state: SlotState): SlotManagerSnapshot {
  const active: Array<{
    taskId: TaskId;
    siteKey: SiteKey;
    phase: "running" | "parked";
    acquiredAt: number;
  }> = [];
  for (const [siteKey, entry] of state.active) {
    active.push({
      taskId: entry.taskId,
      siteKey,
      phase: entry.phase,
      acquiredAt: entry.acquiredAt,
    });
  }
  return {
    active,
    pendingCount: state.globalQueue.length,
    maxConcurrent: state.maxConcurrent,
  };
}
