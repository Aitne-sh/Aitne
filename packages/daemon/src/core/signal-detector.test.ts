import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { SignalDetector } from "./signal-detector.js";
import type { AgentConfig } from "../config.js";
import { applySchema } from "../db/schema.js";
import { upsertAgent } from "../db/agents-store.js";
import { routineToAgentSlug } from "./agents/agent-id-resolver.js";

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

function createDetectorWithDb(db: Database.Database, port = 8321): SignalDetector {
  return new SignalDetector(
    { apiPort: port, feedbackLearningEnabled: true } as unknown as AgentConfig,
    { db },
  );
}

function makeDb(): Database.Database {
  const db = new Database(":memory:");
  applySchema(db);
  return db;
}

describe("SignalDetector", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fetchMock.mockReset();
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
      "http://localhost:8321/api/context/identity/profile",
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

  it("records a replied notification outcome in notification_log and feedback_signals", () => {
    const db = makeDb();
    db.prepare(
      `INSERT INTO notification_log (
         dispatch_id, notification_type, platform, delivery_channel, content_summary, status
       ) VALUES ('dispatch-1', 'message.received.dm', 'slack', 'C1', 'reply body', 'delivered')`,
    ).run();
    const d = createDetectorWithDb(db);

    d.trackNotification("dispatch-1:slack", "slack", "reply body");
    d.onUserMessage({ platform: "slack", channel: "C1", content: "thanks" });

    const log = db.prepare("SELECT user_reaction, reacted_at FROM notification_log").get() as {
      user_reaction: string | null;
      reacted_at: string | null;
    };
    expect(log.user_reaction).toBe("replied");
    expect(log.reacted_at).not.toBeNull();
    const signal = db.prepare("SELECT source, valence, scope_type, action_ref, evidence_json FROM feedback_signals").get() as {
      source: string;
      valence: string;
      scope_type: string;
      action_ref: string;
      evidence_json: string;
    };
    expect(signal).toMatchObject({
      source: "behavioral",
      valence: "positive",
      scope_type: "agent",
      action_ref: "dispatch-1",
    });
    expect(JSON.parse(signal.evidence_json).userReaction).toBe("replied");
  });

  it("records corrections as correction valence and still appends the raw signal", () => {
    const db = makeDb();
    db.prepare(
      `INSERT INTO notification_log (
         dispatch_id, notification_type, platform, delivery_channel, content_summary, status
       ) VALUES ('dispatch-2', 'message.received.dm', 'slack', 'C1', 'verbose reply', 'delivered')`,
    ).run();
    const d = createDetectorWithDb(db);

    d.trackNotification("dispatch-2:slack", "slack", "verbose reply");
    d.onUserMessage({
      platform: "slack",
      channel: "C1",
      content: "don't send that long version again",
    });

    const log = db.prepare("SELECT user_reaction FROM notification_log").get() as {
      user_reaction: string | null;
    };
    expect(log.user_reaction).toBe("corrected");
    const signal = db.prepare("SELECT valence, evidence_json FROM feedback_signals").get() as {
      valence: string;
      evidence_json: string;
    };
    expect(signal.valence).toBe("correction");
    expect(JSON.parse(signal.evidence_json).userReaction).toBe("corrected");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.content).toContain("[correction]");
  });

  it("does not classify benign negations as corrections (false-positive guard)", () => {
    // Each of these previously matched the broad `\b(stop|no)\b.*\b(do|that|…)\b`
    // / bare `don't` patterns, marked the reply `corrected`, and — because the
    // promotion gate promotes any correction on FIRST occurrence — minted a
    // bogus standing directive from a friendly reply.
    const db = makeDb();
    db.prepare(
      `INSERT INTO notification_log (
         dispatch_id, notification_type, platform, delivery_channel, content_summary, status
       ) VALUES ('dispatch-benign', 'message.received.dm', 'slack', 'C1', 'update', 'delivered')`,
    ).run();
    const benignReplies = [
      "No worries, that sounds great",
      "I don't have anything else today",
      "No idea what to do",
      "Don't worry about it",
    ];
    for (const content of benignReplies) {
      const d = createDetectorWithDb(db);
      d.trackNotification("dispatch-benign:slack", "slack", "update");
      d.onUserMessage({ platform: "slack", channel: "C1", content });
    }

    const log = db.prepare("SELECT user_reaction FROM notification_log").get() as {
      user_reaction: string | null;
    };
    expect(log.user_reaction).toBe("replied");
    const corrections = db
      .prepare("SELECT COUNT(*) AS n FROM feedback_signals WHERE valence = 'correction'")
      .get() as { n: number };
    expect(corrections.n).toBe(0);
    // No [correction] raw signal appended either.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("still detects imperative stop/don't corrections", () => {
    const d = createDetector();
    const imperatives = [
      "stop notifying me about CI runs",
      "please don't send these reminders",
      "no more messages after 10pm",
      "don't do that again",
      "you can stop sending these",
    ];
    for (const content of imperatives) {
      fetchMock.mockClear();
      d.onUserMessage({ platform: "slack", content });
      expect(fetchMock, content).toHaveBeenCalledTimes(1);
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.content).toContain("[correction]");
    }
  });

  it("records a thumbs-down reaction as negative valence with the emoji in the summary", () => {
    const db = makeDb();
    db.prepare(
      `INSERT INTO notification_log (
         dispatch_id, notification_type, platform, delivery_channel, content_summary, status
       ) VALUES ('dispatch-neg', 'routine.hourly_check', 'slack', 'C1', 'noisy alert', 'delivered')`,
    ).run();
    const d = createDetectorWithDb(db);
    d.trackNotification("dispatch-neg:slack", "slack", "noisy alert");
    // Skin-tone variant must normalize to the base emoji.
    d.onReaction({ platform: "slack", notificationId: "dispatch-neg:slack", emoji: "👎🏽" });

    const signal = db
      .prepare("SELECT valence, summary FROM feedback_signals")
      .get() as { valence: string; summary: string };
    expect(signal.valence).toBe("negative");
    // The consolidation LLM only ever sees the summary — the disapproval
    // must be legible there, not buried in evidence_json.
    expect(signal.summary).toContain("reacted negatively");
    expect(signal.summary).toContain("👎");
  });

  it("records a positive emoji reaction with the emoji in the summary", () => {
    const db = makeDb();
    db.prepare(
      `INSERT INTO notification_log (
         dispatch_id, notification_type, platform, delivery_channel, content_summary, status
       ) VALUES ('dispatch-pos', 'routine.hourly_check', 'slack', 'C1', 'useful alert', 'delivered')`,
    ).run();
    const d = createDetectorWithDb(db);
    d.trackNotification("dispatch-pos:slack", "slack", "useful alert");
    d.onReaction({ platform: "slack", notificationId: "dispatch-pos:slack", emoji: "👍" });

    const signal = db
      .prepare("SELECT valence, summary FROM feedback_signals")
      .get() as { valence: string; summary: string };
    expect(signal.valence).toBe("positive");
    expect(signal.summary).toContain("👍");
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

  it("records ignored notification outcomes as neutral, not negative", () => {
    const db = makeDb();
    db.prepare(
      `INSERT INTO notification_log (
         dispatch_id, notification_type, platform, delivery_channel, content_summary, status
       ) VALUES ('dispatch-3', 'routine.hourly_check', 'slack', 'C1', 'possible alert', 'delivered')`,
    ).run();
    const d = createDetectorWithDb(db);
    d.trackNotification("dispatch-3:slack", "slack", "possible alert");
    d.start();

    vi.advanceTimersByTime(35 * 60 * 1000);

    const log = db.prepare("SELECT user_reaction FROM notification_log").get() as {
      user_reaction: string | null;
    };
    expect(log.user_reaction).toBe("ignored");
    const signal = db.prepare("SELECT valence, evidence_json FROM feedback_signals").get() as {
      valence: string;
      evidence_json: string;
    };
    expect(signal.valence).toBe("neutral");
    expect(JSON.parse(signal.evidence_json)).toMatchObject({
      userReaction: "ignored",
      initiatesLesson: false,
      weight: 0.25,
    });
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

  // ── Behavioral feedback sink (FEEDBACK_LEARNING_LOOP_DESIGN.md §3.5.1) ──

  it("onNotificationActed records an 'acted' outcome with positive valence", () => {
    const db = makeDb();
    db.prepare(
      `INSERT INTO notification_log (
         dispatch_id, notification_type, platform, delivery_channel, content_summary, status
       ) VALUES ('act-1', 'github_pr', 'slack', 'C1', 'PR needs review', 'delivered')`,
    ).run();
    const d = createDetectorWithDb(db);
    d.trackNotification("act-1:slack", "slack", "PR needs review");
    d.onNotificationActed({
      notificationId: "act-1:slack",
      actionRef: "obs-77",
      detail: "owner merged the PR",
    });

    const log = db.prepare("SELECT user_reaction FROM notification_log").get() as {
      user_reaction: string | null;
    };
    expect(log.user_reaction).toBe("acted");
    const signal = db
      .prepare("SELECT valence, scope_type, action_ref, summary, evidence_json FROM feedback_signals")
      .get() as {
        valence: string;
        scope_type: string;
        action_ref: string;
        summary: string;
        evidence_json: string;
      };
    expect(signal).toMatchObject({
      valence: "positive",
      scope_type: "agent",
      action_ref: "act-1",
    });
    expect(signal.summary).toContain("acted");
    expect(JSON.parse(signal.evidence_json)).toMatchObject({
      userReaction: "acted",
      actionRef: "obs-77",
    });
  });

  it("onNotificationActed prefix-resolves a pending key and drops undefined optional evidence", () => {
    const db = makeDb();
    db.prepare(
      `INSERT INTO notification_log (dispatch_id, platform, status)
       VALUES ('act-2', 'slack', 'delivered')`,
    ).run();
    const d = createDetectorWithDb(db);
    // Track the full "dispatch:platform" key, then act with the bare dispatch
    // id → resolvePendingNotificationId must prefix-match the pending entry.
    d.trackNotification("act-2:slack", "slack", "x");
    d.onNotificationActed({ notificationId: "act-2" });

    const signal = db.prepare("SELECT evidence_json FROM feedback_signals").get() as {
      evidence_json: string;
    };
    const evidence = JSON.parse(signal.evidence_json);
    expect(evidence.actionRef).toBeUndefined();
    expect(evidence.detail).toBeUndefined();
    expect(evidence.userReaction).toBe("acted");
  });

  it("does not record a second behavioral signal for the same dispatch + reaction", () => {
    const db = makeDb();
    db.prepare(
      `INSERT INTO notification_log (dispatch_id, platform, status)
       VALUES ('dup-1', 'slack', 'delivered')`,
    ).run();
    const d = createDetectorWithDb(db);
    d.onNotificationActed({ notificationId: "dup-1:slack" });
    d.onNotificationActed({ notificationId: "dup-1:slack" });
    const count = db.prepare("SELECT COUNT(*) AS n FROM feedback_signals").get() as { n: number };
    expect(count.n).toBe(1);
  });

  it("falls back to parsed ids and an empty summary when no notification_log row exists", () => {
    const db = makeDb();
    const d = createDetectorWithDb(db);
    // An unrelated pending entry forces resolvePendingNotificationId to iterate
    // without a prefix match before returning the id unchanged.
    d.trackNotification("other:slack", "slack", "x");
    d.onNotificationActed({ notificationId: "ghost" });
    const signal = db
      .prepare("SELECT scope_type, action_ref, summary FROM feedback_signals")
      .get() as { scope_type: string; action_ref: string; summary: string };
    expect(signal).toMatchObject({ scope_type: "agent", action_ref: "ghost" });
    // No content_summary / notification_type → summary carries neither suffix.
    expect(signal.summary).toBe("Owner acted on notification");
  });

  it("returns early when the resolved notification id has no dispatch id", () => {
    const db = makeDb();
    const d = createDetectorWithDb(db);
    d.onNotificationActed({ notificationId: "" });
    const count = db.prepare("SELECT COUNT(*) AS n FROM feedback_signals").get() as { n: number };
    expect(count.n).toBe(0);
  });

  it("parses a trailing-colon notification id as a null platform", () => {
    const db = makeDb();
    const d = createDetectorWithDb(db);
    d.onNotificationActed({ notificationId: "col-1:" });
    const signal = db.prepare("SELECT action_ref FROM feedback_signals").get() as {
      action_ref: string;
    };
    expect(signal.action_ref).toBe("col-1");
  });

  it("scopes the signal to agent_slug when the notification maps to a built-in agent", () => {
    const db = makeDb();
    const slug = routineToAgentSlug("evening_review", null);
    expect(slug).not.toBeNull();
    upsertAgent(db, {
      slug: slug as string,
      name: "Evening Review",
      source: "builtin",
      definitionPath: `/vault/policies/agents/${slug}/agent.md`,
      definitionHash: "h",
      enabled: true,
      scheduleKind: "cron",
      scheduleTimezone: "UTC",
    });
    db.prepare(
      `INSERT INTO notification_log (dispatch_id, notification_type, platform, status)
       VALUES ('rev-1', 'routine.evening_review', 'slack', 'delivered')`,
    ).run();
    const d = createDetectorWithDb(db);
    d.onNotificationActed({ notificationId: "rev-1:slack" });
    const signal = db
      .prepare("SELECT scope_type, scope_ref, agent_id FROM feedback_signals")
      .get() as { scope_type: string; scope_ref: string; agent_id: string };
    expect(signal).toMatchObject({
      scope_type: "agent_slug",
      scope_ref: slug,
      agent_id: slug,
    });
  });

  it("skips behavioral capture entirely when feedbackLearningEnabled is false", () => {
    const db = makeDb();
    db.prepare(
      `INSERT INTO notification_log (dispatch_id, platform, status)
       VALUES ('off-1', 'slack', 'delivered')`,
    ).run();
    const d = new SignalDetector(
      { apiPort: 8321, feedbackLearningEnabled: false } as unknown as AgentConfig,
      { db },
    );
    d.onNotificationActed({ notificationId: "off-1:slack" });
    const count = db.prepare("SELECT COUNT(*) AS n FROM feedback_signals").get() as { n: number };
    expect(count.n).toBe(0);
    const log = db.prepare("SELECT user_reaction FROM notification_log").get() as {
      user_reaction: string | null;
    };
    expect(log.user_reaction).toBeNull();
  });

  it("swallows DB errors during outcome capture without throwing", () => {
    const db = makeDb();
    db.prepare(
      `INSERT INTO notification_log (dispatch_id, platform, status)
       VALUES ('err-1', 'slack', 'delivered')`,
    ).run();
    const d = createDetectorWithDb(db);
    d.trackNotification("err-1:slack", "slack", "x");
    db.close(); // any subsequent prepare throws → caught by the single guard
    expect(() => d.onNotificationActed({ notificationId: "err-1:slack" })).not.toThrow();
  });

  it("updates a platform-less notification_log row on the bare-dispatch path", () => {
    const db = makeDb();
    db.prepare(
      `INSERT INTO notification_log (dispatch_id, platform, delivery_channel, status)
       VALUES ('np-1', NULL, NULL, 'delivered')`,
    ).run();
    const d = createDetectorWithDb(db);
    d.onNotificationActed({ notificationId: "np-1" });
    const log = db
      .prepare("SELECT user_reaction FROM notification_log WHERE dispatch_id='np-1'")
      .get() as { user_reaction: string | null };
    expect(log.user_reaction).toBe("acted");
  });

  it("findPendingNotificationForReply skips stale / wrong-platform / wrong-channel and picks the freshest", () => {
    const db = makeDb();
    for (const [id, platform, channel] of [
      ["a", "slack", "C1"],
      ["b", "discord", "C2"],
      ["c", "slack", "C1"],
      ["d", "slack", "C9"],
      ["e", "slack", "C1"],
    ] as const) {
      db.prepare(
        `INSERT INTO notification_log (dispatch_id, platform, delivery_channel, status)
         VALUES (?, ?, ?, 'delivered')`,
      ).run(id, platform, channel);
    }
    const d = createDetectorWithDb(db);
    // "e" is tracked first then aged past the ignore threshold (stale → skip).
    d.trackNotification("e:slack", "slack", "old");
    vi.advanceTimersByTime(31 * 60 * 1000);
    d.trackNotification("a:slack", "slack", "first");
    vi.advanceTimersByTime(60 * 1000);
    d.trackNotification("c:slack", "slack", "fresher"); // newer than a
    d.trackNotification("b:discord", "discord", "other-platform");
    d.trackNotification("d:slack", "slack", "other-channel");

    d.onUserMessage({ platform: "slack", channel: "C1", content: "thanks!" });

    const reacted = db
      .prepare("SELECT dispatch_id FROM notification_log WHERE user_reaction = 'replied'")
      .all() as { dispatch_id: string }[];
    expect(reacted.map((r) => r.dispatch_id)).toEqual(["c"]);
  });

  it("preserves the parsed platform on the no-db early-return path", () => {
    // db-less detector with a "dispatch:platform" id → lookupNotificationMetadata
    // returns immediately, keeping the parsed platform.
    const d = createDetector();
    expect(() => d.trackNotification("x:discord", "discord", "hi")).not.toThrow();
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
