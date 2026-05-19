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
});
