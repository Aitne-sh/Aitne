import { describe, it, expect, vi } from "vitest";

import {
  briefPayload,
  createBackgroundTaskTransitionEmitter,
  noopBackgroundTaskTransitionEmitter,
} from "./background-task-transition-events.js";
import type { BackgroundTaskRow } from "../../db/background-task-store.js";

function row(overrides: Partial<BackgroundTaskRow> = {}): BackgroundTaskRow {
  return {
    id: "bg-1",
    brief: "audit all repos for failing CI",
    title: "CI audit",
    state: "completed",
    notificationPolicy: "always",
    significanceCriteria: null,
    report: "full report",
    draft: "2 repos red",
    notify: true,
    significance: "2 red",
    artifactPath: null,
    outcomeDetail: null,
    originatingChannel: "slack:C1",
    correlationId: null,
    scheduleRowId: null,
    tier: "medium",
    maxBudgetUsd: null,
    backendSessionId: null,
    createdAt: 1000,
    startedAt: 1100,
    finishedAt: 2000,
    deliveredAt: null,
    ...overrides,
  };
}

describe("background-task transition events", () => {
  it("briefPayload prefers the title and scrubs control chars", () => {
    const p = briefPayload(row({ title: "a\nb\tc" }), 42);
    expect(p.brief).toBe("a b c");
    expect(p.taskId).toBe("bg-1");
    expect(p.notify).toBe(true);
    expect(p.transitionedAt).toBe(42);
  });

  it("falls back to the brief when title is empty, truncates to 80 chars", () => {
    const long = "x".repeat(200);
    const p = briefPayload(row({ title: null, brief: long }), 1);
    expect(p.brief).toHaveLength(80);
  });

  it("noop emitter returns the payload without broadcasting", () => {
    expect(noopBackgroundTaskTransitionEmitter.emitFromRow(null, 1)).toBeNull();
    const p = noopBackgroundTaskTransitionEmitter.emitFromRow(row(), 5);
    expect(p?.taskId).toBe("bg-1");
    // emit() is a no-op that must not throw
    expect(() => noopBackgroundTaskTransitionEmitter.emit(briefPayload(row(), 6))).not.toThrow();
  });

  it("real emitter broadcasts on the background_task channel", () => {
    const broadcastNamedEvent = vi.fn();
    const emitter = createBackgroundTaskTransitionEmitter({ broadcastNamedEvent });
    emitter.emitFromRow(row(), 7);
    emitter.emit(briefPayload(row(), 8));
    // null row ⇒ no broadcast, returns null
    expect(emitter.emitFromRow(null, 9)).toBeNull();
    expect(broadcastNamedEvent).toHaveBeenCalledTimes(2);
    expect(broadcastNamedEvent).toHaveBeenCalledWith(
      "background_task",
      expect.objectContaining({ taskId: "bg-1" }),
    );
  });

  it("a null sink yields the noop emitter", () => {
    const emitter = createBackgroundTaskTransitionEmitter(null);
    expect(emitter).toBe(noopBackgroundTaskTransitionEmitter);
    expect(emitter.emitFromRow(null, 1)).toBeNull();
  });
});
