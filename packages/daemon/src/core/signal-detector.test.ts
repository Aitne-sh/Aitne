import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SignalDetector } from "./signal-detector.js";
import type { AgentConfig } from "../config.js";

// Mock fetch globally
const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

// Suppress logger output
vi.mock("../logging.js", () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

function createDetector(port = 8321): SignalDetector {
  return new SignalDetector({ apiPort: port } as unknown as AgentConfig);
}

describe("SignalDetector", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValue({ ok: true, status: 200 });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("starts and stops without error", () => {
    const d = createDetector();
    d.start();
    d.stop();
  });

  it("stop is idempotent", () => {
    const d = createDetector();
    d.start();
    d.stop();
    d.stop();
  });

  it("trackNotification records a pending notification", () => {
    const d = createDetector();
    d.trackNotification("n1", "slack", "Hello user");
    // Reaction clears it
    d.onReaction({ platform: "slack", notificationId: "n1", emoji: "👍" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.section).toBe("raw_signals");
    expect(body.content).toContain("👍");
  });

  it("onReaction sends signal via Context API", () => {
    const d = createDetector();
    d.onReaction({ platform: "discord", emoji: "❤️" });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:8321/api/context/user/profile",
      expect.objectContaining({ method: "PATCH" }),
    );
  });

  it("onReaction includes response time when provided", () => {
    const d = createDetector();
    d.onReaction({ platform: "slack", emoji: "👍", responseTimeMs: 5000 });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.content).toContain("5s");
  });

  it("onReaction omits response time when not provided", () => {
    const d = createDetector();
    d.onReaction({ platform: "slack", emoji: "👍" });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.content).not.toContain("(");
  });

  it("onUserMessage detects correction patterns", () => {
    const d = createDetector();
    d.onUserMessage({ platform: "slack", content: "make it shorter" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.content).toContain("[correction]");
  });

  it("onUserMessage ignores non-correction messages", () => {
    const d = createDetector();
    d.onUserMessage({ platform: "slack", content: "thanks" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("onUserMessage clears pending notification when responding", () => {
    const d = createDetector();
    d.trackNotification("n1", "slack", "Hello");
    d.onUserMessage({
      platform: "slack",
      content: "Thanks",
      responseToNotificationId: "n1",
    });
    // Not a correction, so no fetch call for the message itself
    // But notification should be removed from pending
    // Advance past ignore threshold to verify it was cleared
    vi.advanceTimersByTime(31 * 60 * 1000);
    d.start();
    vi.advanceTimersByTime(5 * 60 * 1000);
    d.stop();
    // No ignore signal should have been sent
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("checkIgnoredMessages fires after threshold", () => {
    const d = createDetector();
    d.trackNotification("n1", "slack", "Important update");
    d.start();

    // Advance past the 30-minute threshold + 5-minute check interval
    vi.advanceTimersByTime(35 * 60 * 1000);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.content).toContain("[ignore]");
    expect(body.content).toContain("slack");

    d.stop();
  });

  it("checkIgnoredMessages does not fire before threshold", () => {
    const d = createDetector();
    d.trackNotification("n1", "slack", "Hello");
    d.start();

    // Advance 10 minutes (before 30-minute threshold)
    vi.advanceTimersByTime(10 * 60 * 1000);

    expect(fetchMock).not.toHaveBeenCalled();
    d.stop();
  });

  it("appendSignal handles API error response gracefully", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: () => Promise.resolve("Internal error"),
    });
    const d = createDetector();
    d.onReaction({ platform: "slack", emoji: "👍" });
    // Should not throw
    await vi.advanceTimersByTimeAsync(10);
  });

  it("appendSignal handles fetch failure gracefully", async () => {
    fetchMock.mockRejectedValueOnce(new Error("Network error"));
    const d = createDetector();
    d.onReaction({ platform: "slack", emoji: "👍" });
    // Should not throw
    await vi.advanceTimersByTimeAsync(10);
  });

  it("onUserMessage detects 'elaborate' / 'more detail' corrections", () => {
    const d = createDetector();
    d.onUserMessage({ platform: "slack", content: "please elaborate on that" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.content).toContain("[correction]");
    expect(body.content).toContain("elaborate");
  });

  it("onUserMessage detects language-switch corrections", () => {
    const d = createDetector();
    d.onUserMessage({ platform: "slack", content: "answer in japanese please" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.content).toContain("[correction]");
  });

  it("onUserMessage detects bullet-list corrections", () => {
    const d = createDetector();
    d.onUserMessage({ platform: "slack", content: "use bullet points" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.content).toContain("[correction]");
  });

  it("onUserMessage stops at the first matching correction (early return)", () => {
    // A single message that triggers two correction patterns must only
    // produce one signal — exercising the `return` inside the pattern loop.
    const d = createDetector();
    d.onUserMessage({
      platform: "slack",
      content: "make it shorter and please elaborate",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("onUserMessage truncates long content to 60 chars in the signal detail", () => {
    const d = createDetector();
    const longContent =
      "this is a much longer message please make it shorter and " +
      "keep it brief but also include xxxxxxxxxxxxxxxxxxxxxxx";
    d.onUserMessage({ platform: "slack", content: longContent });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    // detail wraps a `"…"` substring of length 60
    const match = body.content.match(/"([^"]*)"/);
    expect(match).not.toBeNull();
    expect(match[1].length).toBe(60);
  });

  it("dedup suppresses an identical signal within the TTL window", () => {
    const d = createDetector();
    d.onReaction({ platform: "slack", emoji: "👍" });
    d.onReaction({ platform: "slack", emoji: "👍" });
    // Second call is deduped — only one fetch.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("dedup expires after the TTL window so the same signal can be recorded again", () => {
    const d = createDetector();
    d.onReaction({ platform: "slack", emoji: "👍" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // TTL is 10 minutes — advance past it.
    vi.advanceTimersByTime(10 * 60 * 1000 + 1);
    d.onReaction({ platform: "slack", emoji: "👍" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("dedup cache is cleared on API error so retry is allowed immediately", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: () => Promise.resolve("oops"),
    });
    const d = createDetector();
    d.onReaction({ platform: "slack", emoji: "👍" });
    await vi.advanceTimersByTimeAsync(10);
    // After error, dedup entry is removed → next call should hit fetch
    // again (mocked success on the second call).
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200 });
    d.onReaction({ platform: "slack", emoji: "👍" });
    await vi.advanceTimersByTimeAsync(10);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("dedup cache is cleared on fetch throw so retry is allowed immediately", async () => {
    fetchMock.mockRejectedValueOnce(new Error("network down"));
    const d = createDetector();
    d.onReaction({ platform: "slack", emoji: "👍" });
    await vi.advanceTimersByTimeAsync(10);
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200 });
    d.onReaction({ platform: "slack", emoji: "👍" });
    await vi.advanceTimersByTimeAsync(10);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("checkIgnoredMessages removes the pending entry after firing (no duplicate ignore signals)", () => {
    const d = createDetector();
    d.trackNotification("n1", "slack", "Hello");
    d.start();
    // First check fires the ignore signal.
    vi.advanceTimersByTime(35 * 60 * 1000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Subsequent check intervals must not refire — the pending entry was
    // removed.
    vi.advanceTimersByTime(10 * 60 * 1000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    d.stop();
  });
});

describe("SignalDetector.normalizeDedupKey", () => {
  it("strips dynamic minute counts from ignore signal detail", () => {
    const key1 = SignalDetector.normalizeDedupKey({
      timestamp: "2026-05-22T10:00:00Z",
      type: "ignore",
      detail: 'slack: "Hello" unread for 32min',
    });
    const key2 = SignalDetector.normalizeDedupKey({
      timestamp: "2026-05-22T11:00:00Z",
      type: "ignore",
      detail: 'slack: "Hello" unread for 47min',
    });
    expect(key1).toBe(key2);
    expect(key1).toBe('ignore:slack: "Hello"');
  });

  it("strips parenthesized response time from reaction detail", () => {
    const key1 = SignalDetector.normalizeDedupKey({
      timestamp: "2026-05-22T10:00:00Z",
      type: "reaction",
      detail: "👍 on slack (5s)",
    });
    const key2 = SignalDetector.normalizeDedupKey({
      timestamp: "2026-05-22T11:00:00Z",
      type: "reaction",
      detail: "👍 on slack (12s)",
    });
    expect(key1).toBe(key2);
    expect(key1).toBe("reaction:👍 on slack");
  });

  it("preserves details that don't match either dynamic-suffix pattern", () => {
    const key = SignalDetector.normalizeDedupKey({
      timestamp: "2026-05-22T10:00:00Z",
      type: "correction",
      detail: '"please be shorter"',
    });
    expect(key).toBe('correction:"please be shorter"');
  });
});
