import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  EventPriority,
  isDocsQAMessage,
  type Event,
  type MessageEvent,
} from "@aitne/shared";
import { DocsQAAdapter } from "./docs-qa-adapter.js";
import type { DocsCitationLookup } from "../core/docs/citation-validator.js";

interface CapturedSSE {
  event: string;
  data: string;
}

class FakeSSEClient {
  closed = false;
  readonly writes: CapturedSSE[] = [];
  /** Toggle to simulate a write failing (rejected promise). The next
   *  write call rejects exactly once and then resumes normal behavior. */
  failNextWrite = false;

  async writeSSE(event: string, data: string): Promise<void> {
    if (this.failNextWrite) {
      this.failNextWrite = false;
      throw new Error("simulated SSE write failure");
    }
    this.writes.push({ event, data });
  }
}

function makeLookup(map: Record<string, string[]>): DocsCitationLookup {
  return {
    anchorsForSlug(slug) {
      return Object.prototype.hasOwnProperty.call(map, slug) ? map[slug]! : null;
    },
  };
}

describe("DocsQAAdapter", () => {
  let onMessage: ReturnType<typeof vi.fn<(event: Event) => void>>;
  let adapter: DocsQAAdapter;
  let lookup: DocsCitationLookup;

  beforeEach(() => {
    lookup = makeLookup({
      "features/routines/morning-routine": [
        "morning-routine",
        "in-one-sentence",
        "what-it-outputs",
      ],
      "concepts/agent-day": ["agent-day", "tldr"],
    });
    onMessage = vi.fn<(event: Event) => void>();
    adapter = new DocsQAAdapter(onMessage, lookup);
  });

  describe("registerClient / unregisterClient / isConnected", () => {
    it("mints a UUID, sends initial session_info, and tracks the client", () => {
      const client = new FakeSSEClient();
      const channelId = adapter.registerClient(client);

      expect(channelId).toMatch(/^[0-9a-f-]{36}$/);
      expect(adapter.isConnected(channelId)).toBe(true);

      // The first SSE write is `session_info` carrying just the channelId
      // (per §11.6, no resumeSessionId, no model — that comes later from
      // the dispatcher's sendSessionInfo).
      expect(client.writes).toHaveLength(1);
      expect(client.writes[0]!.event).toBe("session_info");
      expect(JSON.parse(client.writes[0]!.data)).toEqual({ channelId });
    });

    it("isConnected returns false for an unknown channelId", () => {
      expect(adapter.isConnected("not-a-real-channel")).toBe(false);
    });

    it("isConnected returns false after the client closes", () => {
      const client = new FakeSSEClient();
      const channelId = adapter.registerClient(client);
      client.closed = true;
      expect(adapter.isConnected(channelId)).toBe(false);
    });

    it("unregisterClient drops the channel and is idempotent for unknown ids", () => {
      const client = new FakeSSEClient();
      const channelId = adapter.registerClient(client);
      adapter.unregisterClient(channelId);
      expect(adapter.isConnected(channelId)).toBe(false);

      // Idempotent: a second call on the same id is a silent no-op.
      expect(() => adapter.unregisterClient(channelId)).not.toThrow();
      // Unknown ids are also a silent no-op (matches dashboard-adapter).
      expect(() => adapter.unregisterClient("nonexistent")).not.toThrow();
    });

    it("getActiveChannels excludes closed clients", () => {
      const a = new FakeSSEClient();
      const b = new FakeSSEClient();
      const idA = adapter.registerClient(a);
      const idB = adapter.registerClient(b);
      b.closed = true;
      expect(adapter.getActiveChannels()).toEqual([idA]);
      void idB;
    });

    it("swallows session_info SSE write failures", async () => {
      const client = new FakeSSEClient();
      client.failNextWrite = true;
      // Should not throw despite the simulated rejection inside the
      // fire-and-forget promise — failures are debug-logged, not bubbled.
      const channelId = adapter.registerClient(client);
      // Drain microtasks so the rejected promise settles inside the
      // adapter's catch handler before the assertion.
      await Promise.resolve();
      expect(channelId).toMatch(/^[0-9a-f-]{36}$/);
    });
  });

  describe("handleIncomingMessage", () => {
    it("emits a docs_qa MessageEvent with forced fields", () => {
      const client = new FakeSSEClient();
      const channelId = adapter.registerClient(client);
      adapter.handleIncomingMessage(channelId, "When does morning routine run?", {
        scope: "current",
        contextHint: { currentSlug: "features/routines/morning-routine" },
      });

      expect(onMessage).toHaveBeenCalledTimes(1);
      const event = onMessage.mock.calls[0]![0] as MessageEvent;
      expect(isDocsQAMessage(event)).toBe(true);
      expect(event.platform).toBe("dashboard");
      expect(event.isDm).toBe(true);
      expect(event.isMention).toBe(false);
      expect(event.threadId).toBeNull();
      expect(event.intent).toBe("docs_qa");
      expect(event.channel).toBe(channelId);
      expect(event.content).toBe("When does morning routine run?");
      expect(event.priority).toBe(EventPriority.HIGH);
      expect(event.data).toMatchObject({
        docsScope: "current",
        currentDocSlug: "features/routines/morning-routine",
        docsContextHint: { currentSlug: "features/routines/morning-routine" },
      });
    });

    it("omits docsContextHint and defaults currentDocSlug to '(none)' when no hint is passed", () => {
      const client = new FakeSSEClient();
      const channelId = adapter.registerClient(client);
      adapter.handleIncomingMessage(channelId, "Hello", { scope: "all" });
      const event = onMessage.mock.calls[0]![0] as MessageEvent;
      expect(event.data).toEqual({ docsScope: "all", currentDocSlug: "(none)" });
      expect("docsContextHint" in event.data).toBe(false);
    });

    it("forces intent='docs_qa' regardless of channel state", () => {
      // Even if the route somehow lets a stale channel through (it
      // shouldn't — POST checks isConnected first), the inbound event
      // is still tagged docs_qa. Defense-in-depth for §3.3.
      adapter.handleIncomingMessage("never-registered", "x", { scope: "all" });
      expect(onMessage).toHaveBeenCalledTimes(1);
      const event = onMessage.mock.calls[0]![0] as MessageEvent;
      expect(event.intent).toBe("docs_qa");
    });

    it("propagates modelOverride as requestedBackendId/requestedModelId", () => {
      const client = new FakeSSEClient();
      const channelId = adapter.registerClient(client);
      adapter.handleIncomingMessage(channelId, "hi", {
        scope: "all",
        modelOverride: {
          backendId: "claude",
          modelId: "claude-haiku-4-5-20251001",
        },
      });
      const event = onMessage.mock.calls[0]![0] as MessageEvent;
      expect(event.requestedBackendId).toBe("claude");
      expect(event.requestedModelId).toBe("claude-haiku-4-5-20251001");
    });

    it("leaves requestedBackendId/requestedModelId unset when no modelOverride is passed", () => {
      const client = new FakeSSEClient();
      const channelId = adapter.registerClient(client);
      adapter.handleIncomingMessage(channelId, "hi", { scope: "all" });
      const event = onMessage.mock.calls[0]![0] as MessageEvent;
      expect(event.requestedBackendId).toBeUndefined();
      expect(event.requestedModelId).toBeUndefined();
    });
  });

  describe("sendStreamChunk citation validation", () => {
    it("forwards a chunk with a valid [doc:slug#anchor] unchanged", () => {
      const client = new FakeSSEClient();
      const channelId = adapter.registerClient(client);
      client.writes.length = 0;

      adapter.sendStreamChunk(
        channelId,
        "See [doc:features/routines/morning-routine#what-it-outputs]. ",
      );
      adapter.sendStreamEnd(channelId);

      const streamWrites = client.writes.filter((w) => w.event === "chat_stream");
      const joined = streamWrites
        .map((w) => (JSON.parse(w.data) as { chunk: string }).chunk)
        .join("");
      expect(joined).toBe(
        "See [doc:features/routines/morning-routine#what-it-outputs]. ",
      );
    });

    it("strips a [doc:unknown-slug] token from the wire", () => {
      const client = new FakeSSEClient();
      const channelId = adapter.registerClient(client);
      client.writes.length = 0;

      adapter.sendStreamChunk(channelId, "Bad cite [doc:nope/missing-doc] here. ");
      adapter.sendStreamEnd(channelId);

      const streamed = client.writes
        .filter((w) => w.event === "chat_stream")
        .map((w) => (JSON.parse(w.data) as { chunk: string }).chunk)
        .join("");
      expect(streamed).toBe("Bad cite  here. ");
    });

    it("rewrites a [doc:slug#missing-anchor] to [doc:slug]", () => {
      const client = new FakeSSEClient();
      const channelId = adapter.registerClient(client);
      client.writes.length = 0;

      adapter.sendStreamChunk(
        channelId,
        "See [doc:features/routines/morning-routine#bogus]. ",
      );
      adapter.sendStreamEnd(channelId);

      const streamed = client.writes
        .filter((w) => w.event === "chat_stream")
        .map((w) => (JSON.parse(w.data) as { chunk: string }).chunk)
        .join("");
      expect(streamed).toBe("See [doc:features/routines/morning-routine]. ");
    });

    it("reassembles a token split across two deltas (per-channel buffer)", () => {
      const client = new FakeSSEClient();
      const channelId = adapter.registerClient(client);
      client.writes.length = 0;

      // Token straddles the delta boundary — without the per-channel
      // buffer, the first feed would emit `Look at [doc:features/routines/`
      // (an open token forwarded raw) and the second would emit a
      // dangling tail. The streaming validator buffers across the gap.
      adapter.sendStreamChunk(channelId, "Look at [doc:features/routines/");
      adapter.sendStreamChunk(
        channelId,
        "morning-routine#in-one-sentence] now.",
      );
      adapter.sendStreamEnd(channelId);

      const streamed = client.writes
        .filter((w) => w.event === "chat_stream")
        .map((w) => (JSON.parse(w.data) as { chunk: string }).chunk)
        .join("");
      expect(streamed).toBe(
        "Look at [doc:features/routines/morning-routine#in-one-sentence] now.",
      );
    });

    it("emits a stream_end event after flushing the trailing buffer", () => {
      const client = new FakeSSEClient();
      const channelId = adapter.registerClient(client);
      client.writes.length = 0;

      adapter.sendStreamChunk(channelId, "ok");
      adapter.sendStreamEnd(channelId);

      const events = client.writes.map((w) => w.event);
      expect(events[events.length - 1]).toBe("stream_end");
    });

    it("a fresh validator is created per turn (sendStreamEnd disposes)", () => {
      const client = new FakeSSEClient();
      const channelId = adapter.registerClient(client);

      // Turn 1 — leave a partial `[doc:` opener at end of stream. The
      // streaming validator forwards unterminated openers raw on flush
      // (per `citation-validator.ts:219-225`).
      adapter.sendStreamChunk(channelId, "first turn [doc:");
      adapter.sendStreamEnd(channelId);

      const turn1End = client.writes.length;

      // Turn 2 — if the validator state had leaked, the leading `[doc:`
      // characters in turn 2 would be misread as a continuation of
      // turn 1's buffer. They should be fresh.
      adapter.sendStreamChunk(
        channelId,
        "second [doc:concepts/agent-day#tldr] turn",
      );
      adapter.sendStreamEnd(channelId);

      const turn2Streams = client.writes
        .slice(turn1End)
        .filter((w) => w.event === "chat_stream")
        .map((w) => (JSON.parse(w.data) as { chunk: string }).chunk)
        .join("");
      expect(turn2Streams).toBe("second [doc:concepts/agent-day#tldr] turn");
    });

    it("emits no chat_stream event when the chunk is fully buffered (partial token)", () => {
      const client = new FakeSSEClient();
      const channelId = adapter.registerClient(client);
      client.writes.length = 0;

      // The validator buffers an in-progress `[doc:` opener — the
      // `feed()` return is empty, and `sendStreamChunk` should short-
      // circuit without writing an empty SSE chunk to the wire.
      adapter.sendStreamChunk(channelId, "[doc:");
      expect(client.writes.filter((w) => w.event === "chat_stream")).toEqual([]);

      // The stream_end then flushes the partial opener as raw text
      // (citation-validator forwards unterminated openers verbatim
      // on flush per `citation-validator.ts:219-225`).
      adapter.sendStreamEnd(channelId);
      const flushed = client.writes
        .filter((w) => w.event === "chat_stream")
        .map((w) => (JSON.parse(w.data) as { chunk: string }).chunk)
        .join("");
      expect(flushed).toBe("[doc:");
    });

    it("silently no-ops when the channelId is unknown (composite fan-out invariant)", () => {
      // No registerClient — channelId is unknown. No throw, no SSE write.
      adapter.sendStreamChunk("not-a-channel", "hello");
      adapter.sendStreamEnd("not-a-channel");
      // Nothing to assert beyond "did not throw". The behavior matches
      // dashboard-adapter.ts:211-218 and is what makes
      // CompositeDashboardStream fan-out safe.
    });

    it("silently no-ops when the client is closed", () => {
      const client = new FakeSSEClient();
      const channelId = adapter.registerClient(client);
      client.closed = true;
      const before = client.writes.length;
      adapter.sendStreamChunk(channelId, "hi");
      adapter.sendStreamEnd(channelId);
      expect(client.writes.length).toBe(before);
    });

    it("does not re-emit after unregisterClient", () => {
      const client = new FakeSSEClient();
      const channelId = adapter.registerClient(client);
      adapter.unregisterClient(channelId);
      client.writes.length = 0;
      adapter.sendStreamChunk(channelId, "[doc:concepts/agent-day#tldr]");
      adapter.sendStreamEnd(channelId);
      expect(client.writes).toEqual([]);
    });
  });

  describe("sendMessageMeta / sendSessionInfo / sendError", () => {
    it("forwards meta payloads to the right channel only", () => {
      const a = new FakeSSEClient();
      const b = new FakeSSEClient();
      const idA = adapter.registerClient(a);
      adapter.registerClient(b);
      a.writes.length = 0;
      b.writes.length = 0;

      adapter.sendMessageMeta(idA, {
        backend: "claude",
        model: "claude-sonnet-4-6",
        durationMs: 1234,
        costUsd: 0.0042,
      });

      expect(a.writes).toHaveLength(1);
      expect(a.writes[0]!.event).toBe("chat_meta");
      expect(JSON.parse(a.writes[0]!.data)).toEqual({
        backend: "claude",
        model: "claude-sonnet-4-6",
        durationMs: 1234,
        costUsd: 0.0042,
      });
      expect(b.writes).toEqual([]);
    });

    it("forwards a session_info update", () => {
      const client = new FakeSSEClient();
      const channelId = adapter.registerClient(client);
      client.writes.length = 0;

      adapter.sendSessionInfo(channelId, {
        channelId,
        sessionId: 17,
        backend: "claude",
        model: "claude-sonnet-4-6",
      });

      expect(client.writes).toHaveLength(1);
      expect(client.writes[0]!.event).toBe("session_info");
      expect(JSON.parse(client.writes[0]!.data)).toEqual({
        channelId,
        sessionId: 17,
        backend: "claude",
        model: "claude-sonnet-4-6",
      });
    });

    it("forwards an error payload", () => {
      const client = new FakeSSEClient();
      const channelId = adapter.registerClient(client);
      client.writes.length = 0;

      adapter.sendError(channelId, "auth expired");

      expect(client.writes).toHaveLength(1);
      expect(client.writes[0]!.event).toBe("chat_error");
      expect(JSON.parse(client.writes[0]!.data)).toEqual({ message: "auth expired" });
    });

    it("meta/sessionInfo/error all silently no-op for unknown channels", () => {
      adapter.sendMessageMeta("nope", { backend: "claude" });
      adapter.sendSessionInfo("nope", { channelId: "nope" });
      adapter.sendError("nope", "boom");
      // No throw, no observable side effect.
    });

    it("meta/sessionInfo/error skip closed clients", () => {
      const client = new FakeSSEClient();
      const channelId = adapter.registerClient(client);
      client.closed = true;
      const before = client.writes.length;
      adapter.sendMessageMeta(channelId, { backend: "claude" });
      adapter.sendSessionInfo(channelId, { channelId });
      adapter.sendError(channelId, "x");
      expect(client.writes.length).toBe(before);
    });

    it("swallows SSE write failures from sendStreamEnd's tail flush", async () => {
      const client = new FakeSSEClient();
      const channelId = adapter.registerClient(client);
      // Leave a non-empty validator buffer with no in-progress token,
      // so the flush path emits a final chat_stream chunk — that write
      // is the one we want to fail. A clean text feed without `[doc:`
      // accumulates nothing because `processChunk` runs immediately,
      // so we instead leave a partial-`[doc:` opener that flushes raw.
      adapter.sendStreamChunk(channelId, "trail [doc:");
      client.failNextWrite = true; // next write = the tail-flush chunk
      adapter.sendStreamEnd(channelId);
      // Drain any rejected promises so the catch handler runs.
      await Promise.resolve();
      await Promise.resolve();
      // No throw, no unhandled rejection — the catch on line ~220
      // ("SSE write failed" debug log) ran.
    });

    it("swallows SSE write failures from sendStreamEnd's stream_end emission", async () => {
      const client = new FakeSSEClient();
      const channelId = adapter.registerClient(client);
      // No prior sendStreamChunk → validator never created → the tail
      // flush block is skipped, so the next write is the stream_end
      // event itself.
      client.failNextWrite = true;
      adapter.sendStreamEnd(channelId);
      await Promise.resolve();
      await Promise.resolve();
    });

    it("swallows SSE write failures without throwing", async () => {
      const client = new FakeSSEClient();
      const channelId = adapter.registerClient(client);
      client.writes.length = 0;

      client.failNextWrite = true;
      adapter.sendStreamChunk(channelId, "ok");
      await Promise.resolve();
      // sendStreamEnd would also try to write; allow that to succeed.
      adapter.sendStreamEnd(channelId);

      client.failNextWrite = true;
      adapter.sendMessageMeta(channelId, { backend: "claude" });
      await Promise.resolve();

      client.failNextWrite = true;
      adapter.sendSessionInfo(channelId, { channelId });
      await Promise.resolve();

      client.failNextWrite = true;
      adapter.sendError(channelId, "x");
      await Promise.resolve();
      // No throw — every write failure is logged at debug level.
    });
  });

  describe("MessageAdapter contract", () => {
    it("start/stop are async no-ops; stop clears registered clients", async () => {
      const client = new FakeSSEClient();
      const channelId = adapter.registerClient(client);
      await adapter.start();
      expect(adapter.isConnected(channelId)).toBe(true);
      await adapter.stop();
      expect(adapter.isConnected(channelId)).toBe(false);
    });

    it("sendMessage rejects — QA replies stream, never land as one-shot", async () => {
      await expect(adapter.sendMessage()).rejects.toThrow(
        /not implemented/i,
      );
    });

    it("declares platformName='dashboard' and notificationEligible=false", () => {
      expect(adapter.platformName).toBe("dashboard");
      expect(adapter.notificationEligible).toBe(false);
    });
  });
});
