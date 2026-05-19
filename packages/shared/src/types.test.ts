import { describe, it, expect } from "vitest";
import {
  EventPriority,
  createEvent,
  isMessageEvent,
  isCalendarChangeEvent,
  isRoutineEvent,
  isAgentTaskEvent,
  isScheduledDmEvent,
  isScheduledEvent,
} from "./types.js";

describe("createEvent", () => {
  it("creates an event with defaults", () => {
    const event = createEvent({
      type: "test.event",
      source: "test",
      priority: EventPriority.NORMAL,
    });

    expect(event.type).toBe("test.event");
    expect(event.source).toBe("test");
    expect(event.priority).toBe(EventPriority.NORMAL);
    expect(event.correlationId).toBeTruthy();
    expect(event.timestamp).toBeInstanceOf(Date);
    expect(event.data).toEqual({});
  });

  it("allows overriding defaults", () => {
    const event = createEvent({
      type: "test.event",
      source: "test",
      priority: EventPriority.HIGH,
      data: { foo: "bar" },
    });

    expect(event.priority).toBe(EventPriority.HIGH);
    expect(event.data).toEqual({ foo: "bar" });
  });
});

describe("type guards", () => {
  it("isMessageEvent matches message.* types", () => {
    const event = createEvent({
      type: "message.received",
      source: "slack",
      priority: EventPriority.HIGH,
    });
    expect(isMessageEvent(event)).toBe(true);
    expect(isCalendarChangeEvent(event)).toBe(false);
  });

  it("isCalendarChangeEvent matches calendar.* and schedule.approaching", () => {
    const calEvent = createEvent({
      type: "calendar.event_created",
      source: "google",
      priority: EventPriority.NORMAL,
    });
    expect(isCalendarChangeEvent(calEvent)).toBe(true);

    const approaching = createEvent({
      type: "schedule.approaching",
      source: "google",
      priority: EventPriority.HIGH,
    });
    expect(isCalendarChangeEvent(approaching)).toBe(true);
  });

  it("isRoutineEvent matches routine.* types", () => {
    const event = createEvent({
      type: "routine.morning_routine",
      source: "cron",
      priority: EventPriority.NORMAL,
    });
    expect(isRoutineEvent(event)).toBe(true);
  });

  it("isAgentTaskEvent matches scheduled.task", () => {
    const event = createEvent({
      type: "scheduled.task",
      source: "scheduler",
      priority: EventPriority.NORMAL,
    });
    expect(isAgentTaskEvent(event)).toBe(true);
  });

  it("isAgentTaskEvent does NOT match scheduled.dm (legacy exact-match guard)", () => {
    const event = createEvent({
      type: "scheduled.dm",
      source: "scheduler",
      priority: EventPriority.NORMAL,
    });
    expect(isAgentTaskEvent(event)).toBe(false);
  });

  it("isScheduledDmEvent matches scheduled.dm only", () => {
    const dm = createEvent({
      type: "scheduled.dm",
      source: "scheduler",
      priority: EventPriority.NORMAL,
    });
    const task = createEvent({
      type: "scheduled.task",
      source: "scheduler",
      priority: EventPriority.NORMAL,
    });
    const message = createEvent({
      type: "message.received",
      source: "slack",
      priority: EventPriority.HIGH,
    });
    expect(isScheduledDmEvent(dm)).toBe(true);
    expect(isScheduledDmEvent(task)).toBe(false);
    expect(isScheduledDmEvent(message)).toBe(false);
  });

  it("isScheduledEvent matches both scheduled.task and scheduled.dm", () => {
    const dm = createEvent({
      type: "scheduled.dm",
      source: "scheduler",
      priority: EventPriority.NORMAL,
    });
    const task = createEvent({
      type: "scheduled.task",
      source: "scheduler",
      priority: EventPriority.NORMAL,
    });
    const routine = createEvent({
      type: "routine.morning_routine",
      source: "cron",
      priority: EventPriority.NORMAL,
    });
    expect(isScheduledEvent(dm)).toBe(true);
    expect(isScheduledEvent(task)).toBe(true);
    expect(isScheduledEvent(routine)).toBe(false);
  });
});
