import { describe, expect, it } from "vitest";

import { decideDeadlineActions } from "./browser-task-deadline-scanner.js";
import type { BrowserTaskClarificationRow } from "../../db/browser-task-clarifications-store.js";

function clarification(
  overrides: Partial<BrowserTaskClarificationRow> = {},
): BrowserTaskClarificationRow {
  return {
    id: "clarif-1",
    taskId: "task-1",
    question: "Which option?",
    contextSummary: null,
    screenshotKey: null,
    askedAt: 1000,
    deadlineAt: 1000 + 5 * 60 * 1000,
    deliveredAt: null,
    answer: null,
    answeredAt: null,
    resolved: false,
    ...overrides,
  };
}

describe("decideDeadlineActions", () => {
  it("returns empty list when nothing overdue", () => {
    expect(
      decideDeadlineActions({
        overdueClarifications: [],
        expiredPending: [],
        nowMs: 5000,
      }),
    ).toEqual([]);
  });

  it("emits one abandon_clarification per overdue row", () => {
    const result = decideDeadlineActions({
      overdueClarifications: [
        clarification({ id: "a", taskId: "t1" }),
        clarification({ id: "b", taskId: "t2", deadlineAt: 2000 }),
      ],
      expiredPending: [],
      nowMs: 9999,
    });
    expect(result).toHaveLength(2);
    expect(result.every((a) => a.kind === "abandon_clarification")).toBe(true);
    expect(result.map((a) => "clarificationId" in a ? a.clarificationId : "")).toEqual(["a", "b"]);
  });

  it("emits one queue_timeout per expired pending entry", () => {
    const result = decideDeadlineActions({
      overdueClarifications: [],
      expiredPending: [
        { taskId: "p1", siteKey: "amazon_jp", waitedMs: 31 * 60 * 1000 },
        { taskId: "p2", siteKey: "x_com", waitedMs: 60 * 60 * 1000 },
      ],
      nowMs: 9999,
    });
    expect(result).toHaveLength(2);
    expect(result.every((a) => a.kind === "queue_timeout")).toBe(true);
  });

  it("orders clarifications before pending timeouts", () => {
    const result = decideDeadlineActions({
      overdueClarifications: [clarification({ id: "c1" })],
      expiredPending: [
        { taskId: "p1", siteKey: "x_com", waitedMs: 60_000 },
      ],
      nowMs: 9999,
    });
    expect(result[0].kind).toBe("abandon_clarification");
    expect(result[1].kind).toBe("queue_timeout");
  });

  it("propagates nowMs to every emitted action", () => {
    const result = decideDeadlineActions({
      overdueClarifications: [clarification()],
      expiredPending: [
        { taskId: "p1", siteKey: "x_com", waitedMs: 60_000 },
      ],
      nowMs: 42,
    });
    expect(result.every((a) => a.nowMs === 42)).toBe(true);
  });
});
