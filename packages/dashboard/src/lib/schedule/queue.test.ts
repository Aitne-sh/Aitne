import { describe, expect, it } from "vitest";
import {
  countRecentFailures,
  humanizeTaskType,
  matchesQueueFilter,
  QUEUE_FILTERS,
  queueItemToScheduleRow,
  type ScheduleQueueItem,
} from "./queue";

function item(overrides: Partial<ScheduleQueueItem> = {}): ScheduleQueueItem {
  return {
    id: 7,
    scheduledFor: "2026-07-01 22:00:00",
    taskType: "custom",
    description: "Check the oven",
    prompt: "Remind the user to check the oven.",
    status: "pending",
    model: null,
    tier: null,
    backendId: null,
    taskContext: {},
    createdAt: "2026-07-01 10:00:00",
    ...overrides,
  };
}

describe("humanizeTaskType", () => {
  it("maps the dispatcher vocabulary to user vocabulary", () => {
    expect(humanizeTaskType("wake")).toBe("Wake-up");
    expect(humanizeTaskType("dm")).toBe("DM");
    expect(humanizeTaskType("dm_session")).toBe("Scheduled DM");
    expect(humanizeTaskType("morning_routine")).toBe("Morning routine");
    expect(humanizeTaskType("evening_review")).toBe("Evening review");
    expect(humanizeTaskType("custom")).toBe("One-off");
    expect(humanizeTaskType("agent.task")).toBe("Agent run");
    expect(humanizeTaskType("browser_task")).toBe("Browser task");
    expect(humanizeTaskType("background_task")).toBe("Background task");
  });

  it("sentence-cases unknown snake_case / dotted tokens (forward compat)", () => {
    expect(humanizeTaskType("fetch_window")).toBe("Fetch window");
    expect(humanizeTaskType("objective.step")).toBe("Objective step");
    expect(humanizeTaskType("weird")).toBe("Weird");
  });
});

describe("matchesQueueFilter", () => {
  it("matches every raw type through exactly one category (plus all)", () => {
    const rawTypes = [
      "wake",
      "dm",
      "dm_session",
      "morning_routine",
      "evening_review",
      "custom",
      "agent.task",
      "browser_task",
      "background_task",
    ];
    const categories = QUEUE_FILTERS.filter((f) => f.value !== "all").map((f) => f.value);
    for (const t of rawTypes) {
      expect(matchesQueueFilter(t, "all")).toBe(true);
      const hits = categories.filter((c) => matchesQueueFilter(t, c));
      expect(hits, `type ${t} should belong to exactly one category`).toHaveLength(1);
    }
  });

  it("buckets by user meaning, not raw token", () => {
    expect(matchesQueueFilter("wake", "reminders")).toBe(true);
    expect(matchesQueueFilter("custom", "reminders")).toBe(true);
    expect(matchesQueueFilter("dm_session", "dms")).toBe(true);
    expect(matchesQueueFilter("dm_session", "reminders")).toBe(false);
    expect(matchesQueueFilter("agent.task", "agents")).toBe(true);
    expect(matchesQueueFilter("morning_routine", "routines")).toBe(true);
  });
});

describe("queueItemToScheduleRow", () => {
  it("maps camelCase queue items to the snake_case ScheduleRow shape", () => {
    const row = queueItemToScheduleRow(
      item({ taskContext: { importance: "strategic" }, model: "claude-sonnet-5" }),
    );
    expect(row).toEqual({
      id: 7,
      scheduled_for: "2026-07-01 22:00:00",
      task_type: "custom",
      task_description: "Check the oven",
      task_prompt: "Remind the user to check the oven.",
      model: "claude-sonnet-5",
      status: "pending",
      task_context: JSON.stringify({ importance: "strategic" }),
      created_at: "2026-07-01 10:00:00",
    });
  });

  it("serializes an empty context to null (sheet's no-context branch)", () => {
    expect(queueItemToScheduleRow(item()).task_context).toBeNull();
  });
});

describe("countRecentFailures", () => {
  const now = new Date("2026-07-01T12:00:00Z");

  it("counts only failed rows inside the trailing window", () => {
    const rows = [
      { status: "failed", scheduled_for: "2026-07-01 11:00:00" }, // 1h ago ✓
      { status: "failed", scheduled_for: "2026-06-30 12:00:00" }, // boundary ✓
      { status: "failed", scheduled_for: "2026-06-30 11:59:59" }, // outside ✗
      { status: "completed", scheduled_for: "2026-07-01 11:30:00" }, // not failed ✗
      { status: "failed", scheduled_for: "2026-07-01 13:00:00" }, // future ✗
    ];
    expect(countRecentFailures(rows, { now })).toBe(2);
  });

  it("honors a custom window and empty input", () => {
    const rows = [{ status: "failed", scheduled_for: "2026-07-01 06:00:00" }];
    expect(countRecentFailures(rows, { now, windowHours: 1 })).toBe(0);
    expect(countRecentFailures([], { now })).toBe(0);
  });
});
