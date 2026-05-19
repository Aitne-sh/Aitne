import { describe, expect, it } from "vitest";
import {
  EventPriority,
  createEvent,
  type Event,
  type MessageEvent,
} from "@aitne/shared";
import { createWikiCommandEvent, readWikiReplyTarget } from "./dispatcher.js";

function makeSourceMessage(over: Partial<MessageEvent> = {}): MessageEvent {
  return {
    ...createEvent({
      type: "message.received",
      source: "slack",
      priority: EventPriority.HIGH,
    }),
    sender: "owner",
    channel: "D-original",
    content: "!ingest https://example.com",
    platform: "slack",
    threadId: null,
    isDm: true,
    isMention: false,
    ...over,
  } as MessageEvent;
}

describe("createWikiCommandEvent / readWikiReplyTarget", () => {
  it("populates data.reply_target from a MessageEvent source", () => {
    // WIKI_BUILDER_DESIGN.md §3.4 — wiki sessions started from a DM
    // remember the originating channel so the completion DM lands on
    // the same platform the operator typed the bang on.
    const event = createWikiCommandEvent({
      processKey: "wiki.ingest_url",
      workspace: "default",
      sourceEvent: makeSourceMessage(),
      data: { url: "https://example.com" },
    });
    const target = readWikiReplyTarget(event);
    expect(target).toEqual({
      platform: "slack",
      channel: "D-original",
      threadId: null,
      sender: "owner",
    });
  });

  it("preserves a non-null threadId", () => {
    const event = createWikiCommandEvent({
      processKey: "wiki.ingest_url",
      workspace: "default",
      sourceEvent: makeSourceMessage({ threadId: "thread-1" }),
      data: { url: "https://example.com" },
    });
    expect(readWikiReplyTarget(event)?.threadId).toBe("thread-1");
  });

  it("works across all platforms (telegram/discord/dashboard)", () => {
    for (const platform of ["telegram", "discord", "dashboard"]) {
      const event = createWikiCommandEvent({
        processKey: "wiki.ask",
        workspace: "default",
        sourceEvent: makeSourceMessage({ platform, channel: `${platform}-channel` }),
      });
      const target = readWikiReplyTarget(event);
      expect(target?.platform).toBe(platform);
      expect(target?.channel).toBe(`${platform}-channel`);
    }
  });

  it("omits data.reply_target when no source event is supplied", () => {
    // A hypothetical routine-triggered wiki session has no originating
    // MessageEvent. In that case `readWikiReplyTarget` returns null and
    // the ResultProcessor falls back to proactive delivery (configured
    // destinations).
    const event = createWikiCommandEvent({
      processKey: "wiki.lint",
      workspace: "default",
    });
    expect(readWikiReplyTarget(event)).toBeNull();
    expect((event.data as Record<string, unknown>).reply_target).toBeUndefined();
  });

  it("omits data.reply_target when source event is not a MessageEvent", () => {
    // Defensive: a non-message Event passed as sourceEvent should not
    // produce a reply_target — the routing fields are MessageEvent-only.
    const routineEvent: Event = createEvent({
      type: "routine.hourly_check",
      source: "cron",
      priority: EventPriority.NORMAL,
    });
    const event = createWikiCommandEvent({
      processKey: "wiki.compile",
      workspace: "default",
      sourceEvent: routineEvent,
    });
    expect(readWikiReplyTarget(event)).toBeNull();
  });

  it("readWikiReplyTarget returns null for a corrupt payload", () => {
    // A daemon that was downgraded from a future schema might read a
    // reply_target shape it doesn't recognise. The helper validates
    // via Zod and returns null rather than throwing.
    const event: Event = createEvent({
      type: "wiki.ingest_url",
      source: "wiki.bang",
      priority: EventPriority.HIGH,
      data: { reply_target: { platform: "", channel: "" } },
    });
    expect(readWikiReplyTarget(event)).toBeNull();
  });

  it("readWikiReplyTarget returns null on a wiki event with no reply_target field", () => {
    const event: Event = createEvent({
      type: "wiki.compile",
      source: "wiki.bang",
      priority: EventPriority.HIGH,
      data: { workspace: "default" },
    });
    expect(readWikiReplyTarget(event)).toBeNull();
  });

  it("multi-URL fan-out: every child event carries the same reply_target", () => {
    // Caller emulating `dispatchWikiUrlBatch` parallel mode — the same
    // sourceEvent is reused for each URL, so every minted child must
    // surface the same routing tuple.
    const source = makeSourceMessage({ platform: "telegram", channel: "T1" });
    const events = ["https://a", "https://b", "https://c"].map((url) =>
      createWikiCommandEvent({
        processKey: "wiki.ingest_url",
        workspace: "default",
        sourceEvent: source,
        batchId: "batch-1",
        data: { url },
      }),
    );
    for (const e of events) {
      const t = readWikiReplyTarget(e);
      expect(t?.platform).toBe("telegram");
      expect(t?.channel).toBe("T1");
    }
  });

  // Defense-in-depth: a caller cannot hijack daemon-controlled fields
  // (`workspace`, `batch_id`, `parent_correlation_id`, `reply_target`) by
  // smuggling them through the `data` argument. The spread order in
  // createWikiCommandEvent puts daemon fields AFTER `input.data` so they
  // win the conflict.
  it("daemon-controlled fields cannot be overridden via input.data", () => {
    const event = createWikiCommandEvent({
      processKey: "wiki.ingest_url",
      workspace: "default",
      sourceEvent: makeSourceMessage(),
      batchId: "real-batch",
      data: {
        url: "https://example.com",
        // Hostile / accidental overrides — must not stick:
        workspace: "attacker-owned",
        batch_id: "attacker-batch",
        parent_correlation_id: "attacker-correlation",
        reply_target: { platform: "evil", channel: "evil", threadId: null },
      },
    });
    expect((event.data as Record<string, unknown>).workspace).toBe("default");
    expect((event.data as Record<string, unknown>).batch_id).toBe("real-batch");
    const target = readWikiReplyTarget(event);
    expect(target?.platform).toBe("slack");
    expect(target?.channel).toBe("D-original");
    // The caller-supplied `url` field IS preserved — it's neither a
    // routing nor an audit field, so daemon code does not need to
    // protect it from the same source.
    expect((event.data as Record<string, unknown>).url).toBe("https://example.com");
  });

  it("readWikiReplyTarget tolerates missing sender on stored payload", () => {
    // Forward-compat: the schema allows optional sender. A payload
    // without it should still round-trip cleanly.
    const event: Event = createEvent({
      type: "wiki.ask",
      source: "wiki.bang",
      priority: EventPriority.HIGH,
      data: {
        reply_target: { platform: "slack", channel: "D1", threadId: null },
      },
    });
    const target = readWikiReplyTarget(event);
    expect(target).toEqual({
      platform: "slack",
      channel: "D1",
      threadId: null,
    });
  });
});
