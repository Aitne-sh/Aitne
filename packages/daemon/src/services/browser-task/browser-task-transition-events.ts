/**
 * Browser-task SSE transition emitter — BROWSER_TASK_REDESIGN_PLAN.md §9a.5
 * (Shape B). Phase 7a wires `browser_task` as a named event on the global
 * `/api/events/stream` so every state transition invalidates exactly three
 * dashboard React Query keys: `["browser-tasks"]`, `["browser-tasks", id]`,
 * and `["browser-tasks", "awaiting-count"]`.
 *
 * The emitter is intentionally a thin, narrow interface separate from
 * `BrowserTaskNotifier` (which fans out user-facing DMs) and from
 * `BrowserTaskMcpNotifier` (which is the per-tool DM dispatcher). The
 * Shape B event is a telemetry concern — payload is bounded and never
 * carries user prose past the 80-char `brief` truncation.
 *
 * Wired into four surfaces, each of which is a state-transition site:
 *   1. `POST /api/browser-task` route (pending insert + fallback failed)
 *   2. `POST /api/browser-task/:id/cancel` route (cancelled-in-queue +
 *      no-runner fallback)
 *   3. `BrowserTaskRunner` (markRunning, markTerminal, markRunningFromParked,
 *      reconcileDriverOutcome's terminal branch)
 *   4. `BrowserTaskRuntime` tool layer (ask_user → markAwaitingUser,
 *      final-confirm gate → markFinalConfirm + markRunningFromParked on
 *      proceed, finish → markTerminal=completed)
 *   5. Boot-recovery sweep in `bootstrap/db.ts` (one fan-out per flipped
 *      row).
 *
 * Pure-logic shape lives here; the broadcaster glue is one method call.
 */

import type { BrowserTaskRow } from "../../db/browser-task-store.js";

/** SSE payload shape (§9a.5). Bounded and ASCII-safe — `brief` truncates
 *  to 80 chars matching the dashboard list-column truncation so the
 *  payload size stays small even for long descriptions. */
export interface BrowserTaskTransitionPayload {
  taskId: string;
  state: BrowserTaskRow["state"];
  /** Epoch ms — `finishedAt` for terminal rows, `startedAt` for running,
   *  `createdAt` for pending. The dashboard uses this as the
   *  invalidation timestamp; cache-busting only — display still reads
   *  the row directly via the list/detail queries. */
  transitionedAt: number;
  /** First 80 chars of the description, control chars scrubbed. */
  brief: string;
  /** Optional outcome detail (terminal states). Helps the dashboard
   *  surface a one-line "why this ended" without re-fetching detail. */
  outcomeDetail: string | null;
  /** Originating channel ref, for badge attribution if the dashboard
   *  ever surfaces per-channel "your tasks" view. Today unused; kept
   *  for forward-compat at zero payload cost. */
  originatingChannel: string | null;
}

/** Minimal interface — the broadcaster impl lives in `api/routes/sse.ts`
 *  and is shaped as `broadcastNamedEvent(event: string, data: unknown)`.
 *  Declared here as a structural type so the daemon's
 *  `services/browser-task/*` modules don't depend on the HTTP layer. */
export interface BroadcastSink {
  broadcastNamedEvent(event: string, data: unknown): Promise<void> | void;
}

/** The runner / tool layer / route handlers depend on this narrow
 *  surface, not on `EventBroadcaster` directly, so tests can inject a
 *  recorder without standing up a Hono server. */
export interface BrowserTaskTransitionEmitter {
  emit(payload: BrowserTaskTransitionPayload): void;
  /** Convenience — extract fields from a row + transitionedAt. Returns
   *  the payload that was emitted (or null when row is null) so callers
   *  can chain test assertions. */
  emitFromRow(
    row: BrowserTaskRow | null,
    transitionedAt: number,
  ): BrowserTaskTransitionPayload | null;
}

/** No-op emitter — Phase 1 wiring, test harnesses, and any code path
 *  that doesn't have a broadcaster handy. Production wires the real one
 *  via `createBrowserTaskTransitionEmitter`. */
export const noopBrowserTaskTransitionEmitter: BrowserTaskTransitionEmitter = {
  emit() {
    /* no-op */
  },
  emitFromRow(row, transitionedAt) {
    if (!row) return null;
    return briefPayload(row, transitionedAt);
  },
};

/** Match ASCII control characters (0x00-0x1f) and DEL (0x7f). Constructed
 *  via the RegExp constructor so the source carries the escapes as
 *  string literals — embedding the actual control characters would make
 *  the file unreadable and confuse linters. */
const CONTROL_CHAR_REGEX = new RegExp("[\\x00-\\x1f\\x7f]", "g");

/** Compose a payload from a row. Bounded brief truncation + control-char
 *  scrub so a stray newline / NUL in the description does not corrupt
 *  the SSE frame. */
export function briefPayload(
  row: BrowserTaskRow,
  transitionedAt: number,
): BrowserTaskTransitionPayload {
  const brief = row.description.replace(CONTROL_CHAR_REGEX, " ").slice(0, 80);
  return {
    taskId: row.id,
    state: row.state,
    transitionedAt,
    brief,
    outcomeDetail: row.outcomeDetail,
    originatingChannel: row.originatingChannel,
  };
}

/** Production factory — wraps `EventBroadcaster.broadcastNamedEvent`. */
export function createBrowserTaskTransitionEmitter(
  sink: BroadcastSink | null | undefined,
): BrowserTaskTransitionEmitter {
  if (!sink) return noopBrowserTaskTransitionEmitter;
  return {
    emit(payload) {
      // Fire-and-forget. The broadcaster's iterate-all-clients-and-write
      // surface already swallows per-client failures; we don't need an
      // extra await here, and the await would otherwise block the SQL
      // transaction the emit usually trails.
      void sink.broadcastNamedEvent("browser_task", payload);
    },
    emitFromRow(row, transitionedAt) {
      if (!row) return null;
      const payload = briefPayload(row, transitionedAt);
      void sink.broadcastNamedEvent("browser_task", payload);
      return payload;
    },
  };
}
