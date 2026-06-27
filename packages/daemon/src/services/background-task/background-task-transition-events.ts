/**
 * Background-task SSE transition emitter — BACKGROUND_TASK_RUNNER_DESIGN.md
 * §15 (dashboard). Emits a `background_task` named event on the global
 * `/api/events/stream` on every state transition so a future dashboard
 * surface can invalidate its list/detail queries without per-id polling.
 *
 * Per `project_dashboard_testing`: `background_task` arrives on the
 * default `event` stream with a `kind` field — here the named-event
 * channel is `"background_task"`, payload bounded and ASCII-safe.
 *
 * Mirrors `browser-task-transition-events.ts`: a thin telemetry interface
 * separate from the delivery path (which fans user-facing DMs). The
 * payload never carries the full report — only an 80-char title/brief.
 */

import type { BackgroundTaskRow } from "../../db/background-task-store.js";

export interface BackgroundTaskTransitionPayload {
  taskId: string;
  state: BackgroundTaskRow["state"];
  /** Epoch ms — finishedAt for terminal rows, startedAt for running,
   *  createdAt for pending. Cache-busting timestamp only. */
  transitionedAt: number;
  /** First 80 chars of the title (or brief), control chars scrubbed. */
  brief: string;
  outcomeDetail: string | null;
  /** Worker disposition once finished (null while in-flight). */
  notify: boolean | null;
  originatingChannel: string | null;
}

/** Minimal broadcaster surface — the impl lives in `api/routes/sse.ts`.
 *  Declared structurally so the daemon's `services/background-task/*`
 *  modules don't depend on the HTTP layer. */
export interface BroadcastSink {
  broadcastNamedEvent(event: string, data: unknown): Promise<void> | void;
}

export interface BackgroundTaskTransitionEmitter {
  emit(payload: BackgroundTaskTransitionPayload): void;
  /** Extract fields from a row + transitionedAt and emit. Returns the
   *  payload (or null when row is null) for test chaining. */
  emitFromRow(
    row: BackgroundTaskRow | null,
    transitionedAt: number,
  ): BackgroundTaskTransitionPayload | null;
}

const CONTROL_CHAR_REGEX = new RegExp("[\\x00-\\x1f\\x7f]", "g");

export function briefPayload(
  row: BackgroundTaskRow,
  transitionedAt: number,
): BackgroundTaskTransitionPayload {
  const source = row.title && row.title.length > 0 ? row.title : row.brief;
  const brief = source.replace(CONTROL_CHAR_REGEX, " ").slice(0, 80);
  return {
    taskId: row.id,
    state: row.state,
    transitionedAt,
    brief,
    outcomeDetail: row.outcomeDetail,
    notify: row.notify,
    originatingChannel: row.originatingChannel,
  };
}

export const noopBackgroundTaskTransitionEmitter: BackgroundTaskTransitionEmitter =
  {
    emit() {
      /* no-op */
    },
    emitFromRow(row, transitionedAt) {
      if (!row) return null;
      return briefPayload(row, transitionedAt);
    },
  };

export function createBackgroundTaskTransitionEmitter(
  sink: BroadcastSink | null | undefined,
): BackgroundTaskTransitionEmitter {
  if (!sink) return noopBackgroundTaskTransitionEmitter;
  return {
    emit(payload) {
      void sink.broadcastNamedEvent("background_task", payload);
    },
    emitFromRow(row, transitionedAt) {
      if (!row) return null;
      const payload = briefPayload(row, transitionedAt);
      void sink.broadcastNamedEvent("background_task", payload);
      return payload;
    },
  };
}
