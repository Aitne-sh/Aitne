import { describe, it, expect } from "vitest";
import { STATUS_BADGE_VARIANTS, statusBadgeVariant } from "./status-badge";

describe("statusBadgeVariant", () => {
  it("covers every browser-task state (BROWSER_TASK_REDESIGN_PLAN §9a.2)", () => {
    const browserTaskStates = [
      "pending",
      "running",
      "awaiting_user",
      "final_confirm",
      "completed",
      "failed",
      "timeout",
      "cancelled",
      "abandoned",
    ];
    for (const state of browserTaskStates) {
      expect(STATUS_BADGE_VARIANTS[state], state).toBeDefined();
    }
  });

  it("covers every schedule-queue status", () => {
    const scheduleStatuses = ["pending", "running", "completed", "skipped", "failed"];
    for (const status of scheduleStatuses) {
      expect(STATUS_BADGE_VARIANTS[status], status).toBeDefined();
    }
  });

  it("keeps the dashboard color language: queued=blue, live=amber, done=green, failed=red, inert=gray", () => {
    expect(statusBadgeVariant("pending")).toBe("blue");
    expect(statusBadgeVariant("running")).toBe("amber");
    expect(statusBadgeVariant("completed")).toBe("green");
    expect(statusBadgeVariant("failed")).toBe("red");
    expect(statusBadgeVariant("skipped")).toBe("gray");
  });

  it("colors the Task-board enablement states (active=green, paused=gray, invalid=red)", () => {
    expect(statusBadgeVariant("active")).toBe("green");
    expect(statusBadgeVariant("paused")).toBe("gray");
    expect(statusBadgeVariant("invalid")).toBe("red");
  });

  it("falls back to gray for unknown statuses", () => {
    expect(statusBadgeVariant("definitely-not-a-status")).toBe("gray");
  });
});
