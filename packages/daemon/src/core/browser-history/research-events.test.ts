import { describe, expect, it } from "vitest";
import { EventPriority, createEvent } from "@aitne/shared";
import {
  createResearchCommandEvent,
  isResearchProcessKey,
  RESEARCH_PROCESS_KEYS,
} from "./research-events.js";

describe("isResearchProcessKey", () => {
  it.each(RESEARCH_PROCESS_KEYS)("recognises %s", (key) => {
    expect(isResearchProcessKey(key)).toBe(true);
  });

  it.each(["routine.morning_routine", "message.dm", "agent.task", "routine.fetch_window"])(
    "rejects unrelated %s",
    (key) => {
      expect(isResearchProcessKey(key)).toBe(false);
    },
  );
});

describe("createResearchCommandEvent", () => {
  it("sets type to the process key and carries slug on data", () => {
    const event = createResearchCommandEvent({
      processKey: "routine.research_cluster_update",
      slug: "quantum-mechanics",
    });
    expect(event.type).toBe("routine.research_cluster_update");
    expect((event.data as { slug?: string }).slug).toBe("quantum-mechanics");
  });

  it("forwards reply_target when a MessageEvent is the source", () => {
    const source = createEvent({
      type: "message.received",
      source: "slack",
      priority: EventPriority.HIGH,
    });
    Object.assign(source, {
      platform: "slack",
      channel: "D123",
      sender: "U999",
      content: "!research accept quantum-mechanics",
      threadId: null,
      isDm: true,
      isMention: false,
    });
    const event = createResearchCommandEvent({
      processKey: "routine.research_dispatch",
      slug: "quantum-mechanics",
      sourceEvent: source,
    });
    const data = event.data as { reply_target?: { platform?: string } };
    expect(data.reply_target?.platform).toBe("slack");
    expect(event.source).toBe("browser_history.bang");
  });

  it("omits reply_target for a non-message source", () => {
    const cron = createEvent({
      type: "routine.morning_routine",
      source: "scheduler",
      priority: EventPriority.HIGH,
    });
    const event = createResearchCommandEvent({
      processKey: "routine.research_cluster_update",
      slug: "quantum-mechanics",
      sourceEvent: cron,
    });
    expect((event.data as { reply_target?: unknown }).reply_target).toBeUndefined();
    // Source-event is present, so the source is the bang label.
    expect(event.source).toBe("browser_history.bang");
  });

  it("uses the cron source label when no sourceEvent is supplied", () => {
    const event = createResearchCommandEvent({
      processKey: "routine.research_cluster_update",
      slug: "x",
    });
    expect(event.source).toBe("browser_history.cron");
  });

  it("does not let caller `data` override the typed slug", () => {
    const event = createResearchCommandEvent({
      processKey: "routine.research_cluster_update",
      slug: "real-slug",
      data: { slug: "fake-slug", extra: "preserved" },
    });
    const data = event.data as { slug?: string; extra?: string };
    expect(data.slug).toBe("real-slug");
    expect(data.extra).toBe("preserved");
  });
});
