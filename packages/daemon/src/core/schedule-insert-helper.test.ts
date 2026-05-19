import { describe, expect, it, vi } from "vitest";
import {
  maybeTriggerRoadmapRefresh,
  shouldTriggerRoadmapRefresh,
} from "./schedule-insert-helper.js";

const NOW_UTC_MS = Date.UTC(2026, 3, 19, 12, 0, 0); // 2026-04-19 12:00:00 UTC

function sqliteUtc(offsetMs: number): string {
  const d = new Date(NOW_UTC_MS + offsetMs);
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
  );
}

describe("shouldTriggerRoadmapRefresh", () => {
  it("returns false for normal tasks within the 7-day horizon", () => {
    const scheduledFor = sqliteUtc(5 * 24 * 60 * 60 * 1000);
    expect(
      shouldTriggerRoadmapRefresh({ scheduledFor, now: NOW_UTC_MS }),
    ).toBe(false);
  });

  it("returns true for normal tasks beyond the 7-day horizon", () => {
    const scheduledFor = sqliteUtc(8 * 24 * 60 * 60 * 1000);
    expect(
      shouldTriggerRoadmapRefresh({ scheduledFor, now: NOW_UTC_MS }),
    ).toBe(true);
  });

  it("returns true when taskContext is undefined (default normal)", () => {
    const scheduledFor = sqliteUtc(8 * 24 * 60 * 60 * 1000);
    expect(
      shouldTriggerRoadmapRefresh({ scheduledFor, now: NOW_UTC_MS }),
    ).toBe(true);
  });

  it("gates explicit importance: normal behind the 7-day horizon", () => {
    const scheduledFor = sqliteUtc(5 * 24 * 60 * 60 * 1000);
    expect(
      shouldTriggerRoadmapRefresh({
        scheduledFor,
        taskContext: { importance: "normal" },
        now: NOW_UTC_MS,
      }),
    ).toBe(false);
  });

  it("returns false for transient tasks, even beyond the horizon", () => {
    const scheduledFor = sqliteUtc(30 * 24 * 60 * 60 * 1000);
    expect(
      shouldTriggerRoadmapRefresh({
        scheduledFor,
        taskContext: { importance: "transient" },
        now: NOW_UTC_MS,
      }),
    ).toBe(false);
  });

  it("returns true for strategic tasks inside the horizon", () => {
    const scheduledFor = sqliteUtc(2 * 24 * 60 * 60 * 1000);
    expect(
      shouldTriggerRoadmapRefresh({
        scheduledFor,
        taskContext: { importance: "strategic" },
        now: NOW_UTC_MS,
      }),
    ).toBe(true);
  });

  it("returns true for strategic tasks beyond the horizon", () => {
    const scheduledFor = sqliteUtc(30 * 24 * 60 * 60 * 1000);
    expect(
      shouldTriggerRoadmapRefresh({
        scheduledFor,
        taskContext: { importance: "strategic" },
        now: NOW_UTC_MS,
      }),
    ).toBe(true);
  });

  it("returns false for strategic tasks in the past", () => {
    const scheduledFor = sqliteUtc(-1 * 60 * 60 * 1000);
    expect(
      shouldTriggerRoadmapRefresh({
        scheduledFor,
        taskContext: { importance: "strategic" },
        now: NOW_UTC_MS,
      }),
    ).toBe(false);
  });

  it("returns false when importance is low, even beyond horizon", () => {
    const scheduledFor = sqliteUtc(30 * 24 * 60 * 60 * 1000);
    expect(
      shouldTriggerRoadmapRefresh({
        scheduledFor,
        taskContext: { importance: "low", other: "value" },
        now: NOW_UTC_MS,
      }),
    ).toBe(false);
  });

  it("returns false for unparseable scheduledFor", () => {
    expect(
      shouldTriggerRoadmapRefresh({
        scheduledFor: "not-a-date",
        now: NOW_UTC_MS,
      }),
    ).toBe(false);
  });

  it("uses Date.now() when `now` is omitted", () => {
    const scheduledFor = sqliteUtc(-1 * 60 * 60 * 1000);
    // Without `now`, uses real Date.now() — the scheduledFor is in 2026-04-19
    // which may be past or future depending on current clock. The guarantee
    // we can test: a far-future schedule returns true.
    const farFuture = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000);
    const pad = (n: number) => String(n).padStart(2, "0");
    const farFutureStr =
      `${farFuture.getUTCFullYear()}-${pad(farFuture.getUTCMonth() + 1)}-${pad(farFuture.getUTCDate())} ` +
      `${pad(farFuture.getUTCHours())}:${pad(farFuture.getUTCMinutes())}:${pad(farFuture.getUTCSeconds())}`;
    expect(
      shouldTriggerRoadmapRefresh({ scheduledFor: farFutureStr }),
    ).toBe(true);
    // And ensure scheduledFor above is referenced so linter doesn't complain
    expect(typeof scheduledFor).toBe("string");
  });
});

describe("maybeTriggerRoadmapRefresh", () => {
  it("invokes the trigger with the supplied source when predicate passes", () => {
    const trigger = vi.fn();
    maybeTriggerRoadmapRefresh(
      { scheduledFor: sqliteUtc(8 * 24 * 60 * 60 * 1000), now: NOW_UTC_MS },
      trigger,
      "scheduled_task_created",
    );
    expect(trigger).toHaveBeenCalledWith("scheduled_task_created");
  });

  it("does not invoke the trigger when predicate fails inside the 7-day horizon", () => {
    const trigger = vi.fn();
    maybeTriggerRoadmapRefresh(
      { scheduledFor: sqliteUtc(1 * 60 * 60 * 1000), now: NOW_UTC_MS },
      trigger,
      "scheduled_task_created",
    );
    expect(trigger).not.toHaveBeenCalled();
  });

  it("does not invoke the trigger when importance is low", () => {
    const trigger = vi.fn();
    maybeTriggerRoadmapRefresh(
      {
        scheduledFor: sqliteUtc(30 * 24 * 60 * 60 * 1000),
        taskContext: { importance: "low" },
        now: NOW_UTC_MS,
      },
      trigger,
      "scheduled_task_created",
    );
    expect(trigger).not.toHaveBeenCalled();
  });

  it("is a no-op when trigger callback is null", () => {
    // No assertion needed beyond "does not throw"
    maybeTriggerRoadmapRefresh(
      { scheduledFor: sqliteUtc(8 * 24 * 60 * 60 * 1000), now: NOW_UTC_MS },
      null,
      "scheduled_task_created",
    );
  });

  it("is a no-op when trigger callback is undefined", () => {
    maybeTriggerRoadmapRefresh(
      { scheduledFor: sqliteUtc(8 * 24 * 60 * 60 * 1000), now: NOW_UTC_MS },
      undefined,
      "scheduled_task_created",
    );
  });

  it("swallows thrown errors from the trigger callback", () => {
    const trigger = vi.fn(() => {
      throw new Error("boom");
    });
    expect(() =>
      maybeTriggerRoadmapRefresh(
        { scheduledFor: sqliteUtc(8 * 24 * 60 * 60 * 1000), now: NOW_UTC_MS },
        trigger,
        "scheduled_task_created",
      ),
    ).not.toThrow();
    expect(trigger).toHaveBeenCalled();
  });
});
