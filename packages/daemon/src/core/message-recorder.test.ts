import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySchema } from "../db/schema.js";
import { MessageRecorder } from "./message-recorder.js";

describe("MessageRecorder", () => {
  let db: Database.Database;
  let recorder: MessageRecorder;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applySchema(db);
    recorder = new MessageRecorder(db);

    // Create a session for FK reference
    db.prepare(
      `INSERT INTO conversation_sessions (platform, channel_id, status)
       VALUES ('slack', 'D123', 'active')`,
    ).run();
  });

  afterEach(() => {
    db.close();
  });

  it("records a user message", () => {
    recorder.recordMessage({
      sessionId: 1,
      role: "user",
      content: "Hello, world!",
      platform: "slack",
      senderId: "U123",
    });

    const row = db
      .prepare("SELECT * FROM messages WHERE session_id = 1")
      .get() as { role: string; content: string; platform: string; sender_id: string };
    expect(row.role).toBe("user");
    expect(row.content).toBe("Hello, world!");
    expect(row.platform).toBe("slack");
    expect(row.sender_id).toBe("U123");
  });

  it("records an assistant message without senderId", () => {
    recorder.recordMessage({
      sessionId: 1,
      role: "assistant",
      content: "Hi there!",
      platform: "slack",
    });

    const row = db
      .prepare("SELECT * FROM messages WHERE session_id = 1")
      .get() as { role: string; sender_id: string | null };
    expect(row.role).toBe("assistant");
    expect(row.sender_id).toBeNull();
  });

  it("records multiple messages in order", () => {
    recorder.recordMessage({
      sessionId: 1,
      role: "user",
      content: "first",
      platform: "slack",
    });
    recorder.recordMessage({
      sessionId: 1,
      role: "assistant",
      content: "second",
      platform: "slack",
    });
    recorder.recordMessage({
      sessionId: 1,
      role: "user",
      content: "third",
      platform: "slack",
    });

    const rows = db
      .prepare("SELECT content FROM messages WHERE session_id = 1 ORDER BY id")
      .all() as { content: string }[];
    expect(rows.map((r) => r.content)).toEqual(["first", "second", "third"]);
  });

  it("inserts into FTS5 index via trigger", () => {
    recorder.recordMessage({
      sessionId: 1,
      role: "user",
      content: "important meeting tomorrow",
      platform: "slack",
    });

    // FTS5 search
    const results = db
      .prepare("SELECT * FROM fts_messages WHERE fts_messages MATCH 'meeting'")
      .all() as { content: string }[];
    expect(results.length).toBe(1);
    expect(results[0].content).toContain("meeting");
  });

  it("bumps last_message_at and message_count atomically with the INSERT", () => {
    // Nudge last_message_at backward so the CURRENT_TIMESTAMP refresh
    // produced by recordMessage is detectable even at second granularity.
    db.prepare(
      "UPDATE conversation_sessions SET last_message_at = datetime('now', '-1 hour'), message_count = 0 WHERE id = 1",
    ).run();
    const backdated = (
      db
        .prepare("SELECT last_message_at FROM conversation_sessions WHERE id = 1")
        .get() as { last_message_at: string }
    ).last_message_at;

    const ok1 = recorder.recordMessage({
      sessionId: 1,
      role: "user",
      content: "first",
      platform: "slack",
    });
    const ok2 = recorder.recordMessage({
      sessionId: 1,
      role: "assistant",
      content: "second",
      platform: "slack",
    });
    expect(ok1).toBe(true);
    expect(ok2).toBe(true);

    const after = db
      .prepare(
        "SELECT message_count, last_message_at FROM conversation_sessions WHERE id = 1",
      )
      .get() as { message_count: number; last_message_at: string };
    expect(after.message_count).toBe(2);
    expect(after.last_message_at > backdated).toBe(true);
  });

  it("rolls back message_count when the INSERT fails (atomicity)", () => {
    // Pre-condition: FK on a non-existent session id causes INSERT to
    // fail. Verify the counter does NOT advance — guards the
    // INSERT-before-UPDATE atomicity invariant in message-recorder.ts.
    const before = db
      .prepare("SELECT message_count FROM conversation_sessions WHERE id = 1")
      .get() as { message_count: number };

    const ok = recorder.recordMessage({
      sessionId: 9999, // no such session
      role: "user",
      content: "lost",
      platform: "slack",
    });
    expect(ok).toBe(false);

    const session1After = db
      .prepare("SELECT message_count FROM conversation_sessions WHERE id = 1")
      .get() as { message_count: number };
    expect(session1After.message_count).toBe(before.message_count);

    // And nothing was inserted into messages for the bad session id.
    const rows = db
      .prepare("SELECT COUNT(*) as n FROM messages WHERE session_id = 9999")
      .get() as { n: number };
    expect(rows.n).toBe(0);
  });

  it("records backend metadata when migrated schema is present", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "pa-message-recorder-"));
    try {
      recorder = new MessageRecorder(db);
      const insertSession = db
        .prepare(
          `INSERT INTO conversation_sessions (platform, channel_id, status, backend, scope, scope_key)
           VALUES ('dashboard', 'owner', 'active', 'codex', 'dashboard_chat', 'owner')`,
        )
        .run();
      const sessionId = Number(insertSession.lastInsertRowid);

      recorder.recordMessage({
        sessionId,
        role: "assistant",
        content: "Handled by Codex",
        platform: "dashboard",
        backend: "codex",
        modelId: "gpt-5.4",
      });

      const row = db
        .prepare(
          "SELECT backend, model_id FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT 1",
        )
        .get(sessionId) as { backend: string | null; model_id: string | null };

      expect(row.backend).toBe("codex");
      expect(row.model_id).toBe("gpt-5.4");
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("records message metadata and notification dispatch id", () => {
    const ok = recorder.recordMessage({
      sessionId: 1,
      role: "assistant",
      content: "Forwarded note",
      platform: "slack",
      metadata: {
        notificationType: "proactive_forward",
        dispatchIds: ["dispatch-1"],
        originSessionIds: [42],
      },
      notificationDispatchId: "dispatch-1",
    });

    expect(ok).toBe(true);
    const row = db
      .prepare(
        `SELECT metadata, notification_dispatch_id
           FROM messages
          WHERE session_id = 1
          ORDER BY id DESC
          LIMIT 1`,
      )
      .get() as { metadata: string; notification_dispatch_id: string | null };
    expect(row.notification_dispatch_id).toBe("dispatch-1");
    expect(JSON.parse(row.metadata)).toEqual({
      notificationType: "proactive_forward",
      dispatchIds: ["dispatch-1"],
      originSessionIds: [42],
    });
  });
});
