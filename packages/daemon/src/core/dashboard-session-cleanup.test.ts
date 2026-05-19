import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { applySchema } from "../db/schema.js";
import {
  deleteAllChatSidebarSessions,
  deleteChatSession,
} from "./dashboard-session-cleanup.js";
import { getSessionWorkdirPath } from "./workdir.js";
import {
  DASHBOARD_CHAT_SCOPE,
  DASHBOARD_SCOPE_KEY,
  OWNER_DM_SCOPE,
  OWNER_SCOPE_KEY,
} from "../messaging/constants.js";

describe("dashboard-session-cleanup", () => {
  let dataDir: string;
  let db: Database.Database;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "pa-session-cleanup-"));
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applySchema(db);
  });

  afterEach(() => {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  function seedSessions() {
    // id 1: active dashboard_chat (must NOT be touched)
    // id 2: closed dashboard_chat
    // id 3: closed owner_dm
    // id 4: closed thread (legacy scope — not deletable via the sidebar)
    db.prepare(
      `INSERT INTO conversation_sessions
         (id, platform, channel_id, scope, scope_key, status, is_dm)
       VALUES
         (1, 'dashboard', 'dashboard-ch', ?, ?, 'active', 1),
         (2, 'dashboard', 'dashboard-ch', ?, ?, 'closed', 1),
         (3, 'telegram',  'tg-owner',    ?, ?, 'closed', 1),
         (4, 'slack',     'C123',        'thread', 'k', 'closed', 0)`,
    ).run(
      DASHBOARD_CHAT_SCOPE, DASHBOARD_SCOPE_KEY,
      DASHBOARD_CHAT_SCOPE, DASHBOARD_SCOPE_KEY,
      OWNER_DM_SCOPE,       OWNER_SCOPE_KEY,
    );
    db.prepare(
      `INSERT INTO messages (session_id, role, content, platform)
       VALUES
         (1, 'user', 'live chat', 'dashboard'),
         (2, 'user', 'old browser', 'dashboard'),
         (2, 'assistant', 'old reply', 'dashboard'),
         (3, 'user', 'tg msg', 'telegram'),
         (4, 'user', 'thread msg', 'slack')`,
    ).run();
    for (const id of [1, 2, 3, 4]) {
      mkdirSync(getSessionWorkdirPath(dataDir, id), { recursive: true });
    }
  }

  it("deleteAllChatSidebarSessions removes closed dashboard_chat + owner_dm rows only", () => {
    seedSessions();

    const result = deleteAllChatSidebarSessions({ db, dataDir });

    expect(result).toEqual({ deleted: 2 });

    const remaining = db.prepare(
      "SELECT id FROM conversation_sessions ORDER BY id",
    ).all() as Array<{ id: number }>;
    expect(remaining.map((r) => r.id)).toEqual([1, 4]);

    const remainingMessages = db.prepare(
      "SELECT session_id FROM messages ORDER BY session_id",
    ).all() as Array<{ session_id: number }>;
    expect(remainingMessages.map((r) => r.session_id)).toEqual([1, 4]);

    expect(existsSync(getSessionWorkdirPath(dataDir, 1))).toBe(true);
    expect(existsSync(getSessionWorkdirPath(dataDir, 2))).toBe(false);
    expect(existsSync(getSessionWorkdirPath(dataDir, 3))).toBe(false);
    expect(existsSync(getSessionWorkdirPath(dataDir, 4))).toBe(true);
  });

  it("deleteAllChatSidebarSessions is a no-op when there is nothing to delete", () => {
    const result = deleteAllChatSidebarSessions({ db, dataDir });
    expect(result).toEqual({ deleted: 0 });
  });

  it("deleteAllChatSidebarSessions scales past the historical 999-parameter limit", () => {
    // Insert 1500 closed dashboard_chat sessions — well past the
    // SQLITE_MAX_VARIABLE_NUMBER default of 999 on older builds. The
    // single-statement rewrite has no IN-list expansion so this is just
    // a row-count check.
    const insertSession = db.prepare(
      `INSERT INTO conversation_sessions
         (platform, channel_id, scope, scope_key, status, is_dm)
       VALUES ('dashboard', ?, ?, ?, 'closed', 1)`,
    );
    const bulk = db.transaction((count: number) => {
      for (let i = 0; i < count; i++) {
        insertSession.run(
          `channel-${i}`,
          DASHBOARD_CHAT_SCOPE,
          `${DASHBOARD_SCOPE_KEY}-${i}`,
        );
      }
    });
    bulk(1500);

    const result = deleteAllChatSidebarSessions({ db, dataDir });

    expect(result.deleted).toBe(1500);
    const remaining = db.prepare(
      "SELECT COUNT(*) AS cnt FROM conversation_sessions",
    ).get() as { cnt: number };
    expect(remaining.cnt).toBe(0);
  });

  it("deleteAllChatSidebarSessions is atomic with the status filter — a concurrent active flip cannot leak", () => {
    // Regression test for the previous TOCTOU bug: SELECT-then-DELETE could
    // pick up a closed id, then destroy it after another writer flipped it
    // active. The rewrite runs the scope+status filter inside the DELETE
    // itself, so the filter is evaluated against the row's state at delete
    // time, not at SELECT time.
    seedSessions();
    // Close id 1 FIRST — the unique-active index blocks two active rows
    // sharing (scope, scope_key), and id 1 already occupies the slot.
    db.prepare(
      `UPDATE conversation_sessions SET status = 'closed' WHERE id = 1`,
    ).run();
    db.prepare(
      `UPDATE conversation_sessions SET status = 'active' WHERE id = 2`,
    ).run();

    const result = deleteAllChatSidebarSessions({ db, dataDir });

    // ids 1 (closed dashboard_chat) + 3 (closed owner_dm) are deleted;
    // id 2 is now active and survives; id 4 is out-of-scope.
    expect(result.deleted).toBe(2);
    const remaining = db.prepare(
      "SELECT id, status FROM conversation_sessions ORDER BY id",
    ).all() as Array<{ id: number; status: string }>;
    expect(remaining).toEqual([
      { id: 2, status: "active" },
      { id: 4, status: "closed" },
    ]);
  });

  it("deleteChatSession removes the target session and its messages", () => {
    seedSessions();

    const result = deleteChatSession({ db, dataDir, sessionId: 2 });

    expect(result).toEqual({ ok: true, deleted: 1 });
    const remaining = db.prepare(
      "SELECT id FROM conversation_sessions ORDER BY id",
    ).all() as Array<{ id: number }>;
    expect(remaining.map((r) => r.id)).toEqual([1, 3, 4]);
    const remainingMessages = db.prepare(
      "SELECT COUNT(*) AS cnt FROM messages WHERE session_id = 2",
    ).get() as { cnt: number };
    expect(remainingMessages.cnt).toBe(0);
    expect(existsSync(getSessionWorkdirPath(dataDir, 2))).toBe(false);
  });

  it("deleteChatSession refuses to delete the active session", () => {
    seedSessions();

    const result = deleteChatSession({ db, dataDir, sessionId: 1 });

    expect(result).toEqual({
      ok: false,
      status: 409,
      message: "Active sessions cannot be deleted — end the chat first",
    });
    expect(existsSync(getSessionWorkdirPath(dataDir, 1))).toBe(true);
  });

  it("deleteChatSession refuses scopes outside the sidebar set", () => {
    seedSessions();

    const result = deleteChatSession({ db, dataDir, sessionId: 4 });

    expect(result).toEqual({
      ok: false,
      status: 403,
      message: "This session cannot be deleted from the dashboard",
    });
    expect(existsSync(getSessionWorkdirPath(dataDir, 4))).toBe(true);
  });

  it("deleteChatSession returns 404 for unknown ids", () => {
    const result = deleteChatSession({ db, dataDir, sessionId: 999 });
    expect(result).toEqual({ ok: false, status: 404, message: "Session not found" });
  });
});
