import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { queryChatBinding } from "./chat-binding-query.js";
import { DASHBOARD_CHAT_SCOPE, DASHBOARD_SCOPE_KEY } from "../messaging/constants.js";
import type { BackendId } from "@aitne/shared";

const FALLBACK = { backend: "claude" as BackendId, highModel: "claude-sonnet-4-6" };

function createFullSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE backends (id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE backend_global_defaults (
      singleton INTEGER PRIMARY KEY DEFAULT 1,
      default_backend TEXT NOT NULL,
      default_lite_model TEXT NOT NULL,
      default_medium_model TEXT NOT NULL,
      default_high_model TEXT NOT NULL
    );
    CREATE TABLE process_backend_config (
      process_key TEXT PRIMARY KEY,
      main_backend TEXT,
      main_model TEXT,
      fallback_backend TEXT,
      fallback_model TEXT
    );
    CREATE TABLE conversation_sessions (
      id INTEGER PRIMARY KEY,
      platform TEXT,
      scope TEXT,
      scope_key TEXT,
      status TEXT,
      backend TEXT,
      model TEXT,
      backend_session_id TEXT,
      last_message_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `);
}

describe("queryChatBinding", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  it("returns null when required tables are missing", () => {
    expect(queryChatBinding(db, FALLBACK)).toBeNull();
  });

  it("uses fallbackConfig when no defaults row or chatConfig row exist", () => {
    createFullSchema(db);
    const result = queryChatBinding(db, FALLBACK);
    expect(result).not.toBeNull();
    expect(result!.mainBackend).toBe("claude");
    expect(result!.mainModel).toBe("claude-sonnet-4-6");
    expect(result!.fallbackBackend).toBeNull();
    expect(result!.fallbackActive).toBe(false);
  });

  it("uses defaults row values when no chatConfig exists", () => {
    createFullSchema(db);
    db.prepare(
      "INSERT INTO backend_global_defaults (singleton, default_backend, default_lite_model, default_medium_model, default_high_model) VALUES (1, 'codex', 'codex-lite', 'codex-heavy', 'codex-heavy')",
    ).run();
    const result = queryChatBinding(db, FALLBACK);
    expect(result!.mainBackend).toBe("codex" as BackendId);
    expect(result!.mainModel).toBe("codex-heavy");
  });

  it("uses process-level chatConfig when present", () => {
    createFullSchema(db);
    db.prepare(
      "INSERT INTO process_backend_config (process_key, main_backend, main_model, fallback_backend, fallback_model) VALUES ('dashboard.chat', 'gemini', 'gemini-heavy', 'claude', 'claude-sonnet')",
    ).run();
    const result = queryChatBinding(db, FALLBACK);
    expect(result!.mainBackend).toBe("gemini" as BackendId);
    expect(result!.mainModel).toBe("gemini-heavy");
    expect(result!.fallbackBackend).toBe("claude" as BackendId);
  });

  it("uses mainBackend when active session is unactivated (no backend_session_id)", () => {
    createFullSchema(db);
    db.prepare(
      "INSERT INTO backend_global_defaults (singleton, default_backend, default_lite_model, default_medium_model, default_high_model) VALUES (1, 'claude', 'claude-haiku', 'claude-sonnet', 'claude-opus')",
    ).run();
    db.prepare(
      `INSERT INTO conversation_sessions (scope, scope_key, status, backend, model, backend_session_id)
       VALUES (?, ?, 'active', 'gemini', 'gemini-model', NULL)`,
    ).run(DASHBOARD_CHAT_SCOPE, DASHBOARD_SCOPE_KEY);
    const result = queryChatBinding(db, FALLBACK);
    expect(result!.activeBackend).toBe("claude" as BackendId);
    expect(result!.fallbackActive).toBe(false);
  });

  it("uses session backend when activated (backend_session_id set)", () => {
    createFullSchema(db);
    db.prepare(
      "INSERT INTO backend_global_defaults (singleton, default_backend, default_lite_model, default_medium_model, default_high_model) VALUES (1, 'claude', 'claude-haiku', 'claude-sonnet', 'claude-opus')",
    ).run();
    db.prepare(
      `INSERT INTO conversation_sessions (scope, scope_key, status, backend, model, backend_session_id)
       VALUES (?, ?, 'active', 'gemini', 'gemini-model', 'session-xyz')`,
    ).run(DASHBOARD_CHAT_SCOPE, DASHBOARD_SCOPE_KEY);
    const result = queryChatBinding(db, FALLBACK);
    expect(result!.activeBackend).toBe("gemini" as BackendId);
    expect(result!.activeModel).toBe("gemini-model");
    expect(result!.fallbackActive).toBe(true);
  });

  it("falls back to mainBackend/mainModel when an activated row has null backend/model", () => {
    // Covers the `?? mainBackend` / `?? mainModel` fallbacks on lines 93-94
    // when a session row has `backend_session_id` set but the columns are
    // null (legacy rows from before the columns were enforced NOT NULL, or
    // a partial migration).
    createFullSchema(db);
    db.prepare(
      "INSERT INTO backend_global_defaults (singleton, default_backend, default_lite_model, default_medium_model, default_high_model) VALUES (1, 'claude', 'claude-haiku', 'claude-sonnet', 'claude-opus')",
    ).run();
    db.prepare(
      `INSERT INTO conversation_sessions (scope, scope_key, status, backend, model, backend_session_id)
       VALUES (?, ?, 'active', NULL, NULL, 'session-xyz')`,
    ).run(DASHBOARD_CHAT_SCOPE, DASHBOARD_SCOPE_KEY);
    const result = queryChatBinding(db, FALLBACK);
    expect(result!.activeBackend).toBe("claude" as BackendId);
    expect(result!.activeModel).toBe("claude-sonnet");
  });
});
