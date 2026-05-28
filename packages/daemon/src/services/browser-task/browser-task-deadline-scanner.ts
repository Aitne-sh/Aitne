/**
 * Browser-task deadline scanner — BROWSER_TASK_REDESIGN_PLAN.md §5
 * (ask_user resume, "Deadline enforcement") + §5.1 (pending-queue
 * timeout safety valve).
 *
 * Pure decision function. The runner wires this to:
 *   - `listOverdueClarifications(db, nowMs)` for unresolved
 *     clarification rows past their deadline (5-min TTL).
 *   - `sweepPendingTimeouts(slotState, nowMs, timeoutMin)` for
 *     `pending` browser-task rows that have waited too long behind a
 *     parked task ahead of them.
 *
 * Both lists are folded into a single ordered list of actions the
 * runner fans out:
 *   1. abandon overdue clarifications + transition parent task to
 *      `abandoned` + release the BrowserContext + DM the user.
 *   2. mark pending tasks as `failed (queue_timeout)` + DM the user.
 *
 * The scanner runs on the same 30 s tick as B-3's approval-token sweep
 * so the daemon has exactly one timer doing time-based browser-task
 * housekeeping.
 *
 * 100% coverage gate per §13 testing table.
 */

import type { BrowserTaskClarificationRow } from "../../db/browser-task-clarifications-store.js";

/** Pure shape of a pending-queue timeout entry — produced by the slot
 *  manager's `sweepPendingTimeouts` call. Decoupled from `SlotState`
 *  so the deadline-scanner peer test can supply synthetic input
 *  without importing the slot manager. */
export interface PendingQueueTimeoutEntry {
  taskId: string;
  siteKey: string;
  waitedMs: number;
}

/** Single decision the scanner emits for the runner to act on. */
export type DeadlineAction =
  | {
      kind: "abandon_clarification";
      taskId: string;
      clarificationId: string;
      question: string;
      askedAt: number;
      deadlineAt: number;
      nowMs: number;
    }
  | {
      kind: "queue_timeout";
      taskId: string;
      siteKey: string;
      waitedMs: number;
      nowMs: number;
    };

export interface DeadlineScanInput {
  overdueClarifications: readonly BrowserTaskClarificationRow[];
  expiredPending: readonly PendingQueueTimeoutEntry[];
  nowMs: number;
}

/**
 * Decide the ordered list of side-effects the runner must fire on this
 * tick. Pure — no DB, no clock, no FS. Stable ordering: clarifications
 * first (they release a held slot AND DM a user), pending-queue
 * timeouts second (they only release a queue entry).
 *
 * Idempotency contract: a clarification appearing in both
 * `overdueClarifications` AND `expiredPending` (theoretically possible
 * if a `pending` task somehow registered a clarification, though the
 * runner shape forbids this) yields one entry per list — the runner is
 * expected to filter out the second when the task is already terminal.
 */
export function decideDeadlineActions(
  input: DeadlineScanInput,
): readonly DeadlineAction[] {
  const actions: DeadlineAction[] = [];
  for (const c of input.overdueClarifications) {
    actions.push({
      kind: "abandon_clarification",
      taskId: c.taskId,
      clarificationId: c.id,
      question: c.question,
      askedAt: c.askedAt,
      deadlineAt: c.deadlineAt,
      nowMs: input.nowMs,
    });
  }
  for (const p of input.expiredPending) {
    actions.push({
      kind: "queue_timeout",
      taskId: p.taskId,
      siteKey: p.siteKey,
      waitedMs: p.waitedMs,
      nowMs: input.nowMs,
    });
  }
  return actions;
}

/** Default cadence for the deadline tick. Shared with the
 *  `purchase-handler.ts` per-token TTL sweep and the
 *  `final-confirm-handler.ts` per-token TTL sweep so the operator has
 *  one mental model for "how often does the daemon prune expired DM-
 *  flow state". (The legacy `approval-tokens.ts` B-3 supervisor that
 *  established this cadence was retired in BROWSER_TASK_REDESIGN_PLAN.md
 *  §9 Phase 6; the 30 s interval is preserved unchanged.) */
export const DEADLINE_SCAN_INTERVAL_MS = 30 * 1000;
