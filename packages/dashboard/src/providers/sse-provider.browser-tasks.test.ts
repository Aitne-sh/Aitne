import { describe, expect, it, vi } from "vitest";
import {
  invalidateBrowserTaskCaches,
  type BrowserTaskSsePayload,
} from "./sse-provider";

/**
 * BROWSER_TASK_REDESIGN_PLAN.md §13 — behavioural test for the
 * `browser_task` SSE event invalidation contract (§9a.5 Shape B).
 *
 * Asserts the dispatch invalidates EXACTLY the three documented keys
 * (list, detail-by-id, awaiting-count) and no extras. A regression
 * that adds a 4th invalidation (e.g. an over-broad `["health"]` reset)
 * would re-introduce the cache-thrash the Shape B design was chosen
 * to avoid; an under-broad set would leave the dashboard rendering
 * stale `awaiting-count` after a state transition.
 */

function recorder() {
  return {
    calls: [] as readonly unknown[][],
    invalidateQueries(filter: { queryKey: readonly unknown[] }) {
      this.calls = [...this.calls, [...filter.queryKey]];
    },
  };
}

describe("invalidateBrowserTaskCaches", () => {
  it("invalidates exactly list + awaiting-count + per-id detail when taskId present", () => {
    const sink = recorder();
    const payload: BrowserTaskSsePayload = {
      taskId: "task-1",
      state: "running",
      transitionedAt: 1700_000_000_000,
      brief: "Test",
      outcomeDetail: null,
      originatingChannel: null,
    };
    invalidateBrowserTaskCaches(sink, payload);
    expect(sink.calls).toEqual([
      ["browser-tasks"],
      ["browser-tasks", "awaiting-count"],
      ["browser-tasks", "task-1"],
    ]);
  });

  it("skips the per-id invalidation when taskId is absent (malformed payload)", () => {
    const sink = recorder();
    invalidateBrowserTaskCaches(sink, {
      // No taskId — could happen if a future daemon revision adds a
      // bulk event or sends a partial payload. The list + count must
      // still invalidate.
      state: "running",
    });
    expect(sink.calls).toEqual([
      ["browser-tasks"],
      ["browser-tasks", "awaiting-count"],
    ]);
  });

  it("invalidates list + count even on a null payload", () => {
    const sink = recorder();
    invalidateBrowserTaskCaches(sink, null);
    expect(sink.calls).toEqual([
      ["browser-tasks"],
      ["browser-tasks", "awaiting-count"],
    ]);
  });

  it("does not invalidate any unrelated key (regression guard)", () => {
    // §9a.5 explicitly forbids global cache thrash. A regression that
    // adds e.g. ["health"], ["events"], or ["approvals"] would re-
    // introduce the noise Shape B was chosen to avoid.
    const sink = vi.fn();
    invalidateBrowserTaskCaches({ invalidateQueries: sink }, {
      taskId: "task-2",
      state: "completed",
    });
    expect(sink).toHaveBeenCalledTimes(3);
    const seenKeys = sink.mock.calls.map(
      ([arg]) => (arg as { queryKey: readonly unknown[] }).queryKey[0],
    );
    // Every invalidation should target the browser-tasks namespace.
    for (const k of seenKeys) {
      expect(k).toBe("browser-tasks");
    }
  });
});
