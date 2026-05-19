import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { applySchema } from "../db/schema.js";
import type { AgentConfig } from "../config.js";
import { SessionManager } from "./session-manager.js";
import {
  continueDashboardSession,
  endDashboardSession,
  markContextChanged,
  CONTEXT_CHANGED_AT_KEY,
} from "./dashboard-session-controls.js";
import { applyPromptContextStaleness } from "./context-staleness.js";
import { readRuntimeState } from "../db/runtime-state.js";
import { getSessionWorkdirPath } from "./workdir.js";
import {
  DASHBOARD_CHAT_SCOPE,
  DASHBOARD_SCOPE_KEY,
  OWNER_DM_SCOPE,
  OWNER_SCOPE_KEY,
} from "../messaging/constants.js";

function makeConfig(dataDir: string): AgentConfig {
  return {
    googleCalendarId: "primary",
    notionDatabaseIds: {},
    dataDir,
    workspaceDir: ".",
    primaryVaultPath: null,
    primaryVaultName: null,
    externalObsidianVaultPath: null,
    externalObsidianVaultName: null,
    gitRepos: [],
    maxConcurrentSessions: 3,
    maxReactiveSessions: 2,
    sessionTimeoutDmMinutes: 60,
    sessionTimeoutChannelMinutes: 30,
    sessionTimeoutDashboardMinutes: 120,
    character: "",
    timezone: "",
    dayBoundaryHour: 4,
    schedulePollIntervalSeconds: 5,
    maxNotificationsPerHour: 3,
    maxNotificationsPerDay: 12,
    quietHoursStart: "23:00",
    quietHoursEnd: "07:00",
    batchIntervalMinutes: 15,
    primaryPlatform: "slack",
    disallowedTools: [],
    allowedToolsOverride: null,
    obsidianDebounceSeconds: 5,
    gitPollIntervalSeconds: 300,
    notionPollIntervalSeconds: 60,
    calendarPollIntervalSeconds: 300,
    apiPort: 8321,
  } as unknown as AgentConfig;
}

describe("dashboard-session-controls", () => {
  let dataDir: string;
  let db: Database.Database;
  let sessionManager: SessionManager;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "pa-dashboard-session-controls-"));
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applySchema(db);
    sessionManager = new SessionManager(db, makeConfig(dataDir));
  });

  afterEach(() => {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("markContextChanged writes a timestamp to runtime_state", () => {
    const before = new Date();
    markContextChanged(db);
    const after = new Date();

    const stored = readRuntimeState(db, CONTEXT_CHANGED_AT_KEY) as string | null;
    expect(stored).not.toBeNull();
    // The stored value is a UTC string without milliseconds
    const storedMs = new Date(stored!.replace(" ", "T") + "Z").getTime();
    expect(storedMs).toBeGreaterThanOrEqual(before.getTime() - 1000);
    expect(storedMs).toBeLessThanOrEqual(after.getTime() + 1000);
  });

  it("applies prompt-context staleness tiers before writing the dashboard context timestamp", () => {
    const quietDecision = applyPromptContextStaleness(
      { path: "today", reason: "context_patch:today", tier: "quiet" },
      {
        dmStalenessStrict: false,
        setupInProgress: false,
        markContextChanged: () => markContextChanged(db),
        markActiveDmSessionsStale: () => {
          throw new Error("quiet writes must not mark DMs stale");
        },
      },
    );

    expect(quietDecision.invalidatesDmSessions).toBe(false);
    expect(readRuntimeState(db, CONTEXT_CHANGED_AT_KEY)).toBeNull();

    const loudDecision = applyPromptContextStaleness(
      { path: "today", reason: "context_patch:today", tier: "loud" },
      {
        dmStalenessStrict: false,
        setupInProgress: false,
        markContextChanged: () => markContextChanged(db),
        markActiveDmSessionsStale: () => {},
      },
    );

    expect(loudDecision.invalidatesDmSessions).toBe(true);
    expect(readRuntimeState(db, CONTEXT_CHANGED_AT_KEY)).not.toBeNull();
  });

  it("continueDashboardSession returns 404 for unknown session id", () => {
    const result = continueDashboardSession({
      db,
      dataDir,
      sessionManager,
      sessionId: 9999,
    });

    expect(result).toEqual({
      ok: false,
      status: 404,
      message: "Session not found",
    });
  });

  it("endDashboardSession returns null when no active session exists", async () => {
    const result = await endDashboardSession({
      sessionManager,
      channelId: "dashboard-ch",
    });
    expect(result).toBeNull();
  });

  it("ends only the active dashboard chat session", async () => {
    db.prepare(
      `INSERT INTO conversation_sessions (id, platform, channel_id, scope, scope_key, status, is_dm)
       VALUES
       (1, 'dashboard', 'dashboard-ch', ?, ?, 'active', 1),
       (2, 'owner', 'owner', ?, ?, 'active', 1)`,
    ).run(DASHBOARD_CHAT_SCOPE, DASHBOARD_SCOPE_KEY, OWNER_DM_SCOPE, OWNER_SCOPE_KEY);

    const ended = await endDashboardSession({
      sessionManager,
      channelId: "dashboard-ch",
    });

    expect(ended).toEqual({ id: 1 });
    const statuses = db.prepare(
      "SELECT id, status FROM conversation_sessions ORDER BY id",
    ).all() as Array<{ id: number; status: string }>;
    expect(statuses).toEqual([
      { id: 1, status: "closed" },
      { id: 2, status: "active" },
    ]);
  });

  it("continues dashboard chat without closing the active owner DM session", () => {
    db.prepare(
      `INSERT INTO conversation_sessions (
         id, platform, channel_id, scope, scope_key, status, is_dm, backend_session_id
       )
       VALUES
       (1, 'dashboard', 'dashboard-old', ?, ?, 'active', 1, 'sdk-active'),
       (2, 'dashboard', 'dashboard-old', ?, ?, 'closed', 1, 'sdk-history'),
       (3, 'owner', 'owner', ?, ?, 'active', 1, 'sdk-owner')`,
    ).run(
      DASHBOARD_CHAT_SCOPE,
      DASHBOARD_SCOPE_KEY,
      DASHBOARD_CHAT_SCOPE,
      DASHBOARD_SCOPE_KEY,
      OWNER_DM_SCOPE,
      OWNER_SCOPE_KEY,
    );
    db.prepare(
      `INSERT INTO messages (session_id, role, content, platform)
       VALUES
       (1, 'user', 'current browser chat', 'dashboard'),
       (2, 'user', 'older browser chat', 'dashboard'),
       (3, 'user', 'telegram owner chat', 'telegram')`,
    ).run();
    mkdirSync(getSessionWorkdirPath(dataDir, 1), { recursive: true });
    mkdirSync(getSessionWorkdirPath(dataDir, 2), { recursive: true });
    mkdirSync(getSessionWorkdirPath(dataDir, 3), { recursive: true });

    const result = continueDashboardSession({
      db,
      dataDir,
      sessionManager,
      sessionId: 2,
    });

    expect(result).toEqual({ ok: true, sessionId: 2 });
    const statuses = db.prepare(
      "SELECT id, status FROM conversation_sessions ORDER BY id",
    ).all() as Array<{ id: number; status: string }>;
    expect(statuses).toEqual([
      { id: 1, status: "closed" },
      { id: 2, status: "active" },
      { id: 3, status: "active" },
    ]);
    expect(existsSync(getSessionWorkdirPath(dataDir, 3))).toBe(true);
  });

  it("continues a dashboard session whose backend_session_id is NULL", () => {
    // Regression: after `shouldInvalidateSdkSession` fires once (or a
    // backend like Gemini CLI returns without a session id), the row
    // has NULL backend but is otherwise intact. Earlier code rejected
    // this with 409 "This session cannot be resumed", which trapped
    // the session read-only in the sidebar forever. Fresh-execute +
    // history injection handles NULL backend fine, so the only real
    // precondition is the workdir surviving on disk.
    db.prepare(
      `INSERT INTO conversation_sessions (
         id, platform, channel_id, scope, scope_key, status, is_dm, backend_session_id
       )
       VALUES (7, 'dashboard', 'dashboard-old', ?, ?, 'closed', 1, NULL)`,
    ).run(DASHBOARD_CHAT_SCOPE, DASHBOARD_SCOPE_KEY);
    db.prepare(
      `INSERT INTO messages (session_id, role, content, platform)
       VALUES
       (7, 'user', 'first user turn', 'dashboard'),
       (7, 'assistant', 'first assistant turn', 'dashboard')`,
    ).run();
    mkdirSync(getSessionWorkdirPath(dataDir, 7), { recursive: true });

    const result = continueDashboardSession({
      db,
      dataDir,
      sessionManager,
      sessionId: 7,
    });

    expect(result).toEqual({ ok: true, sessionId: 7 });
    const row = db
      .prepare(
        "SELECT status, backend_session_id FROM conversation_sessions WHERE id = 7",
      )
      .get() as { status: string; backend_session_id: string | null };
    expect(row.status).toBe("active");
    // backend_session_id stays NULL; next turn will populate it after
    // fresh-execute with history injection.
    expect(row.backend_session_id).toBeNull();
  });

  it("rejects continuing a dashboard session whose workdir was reclaimed", () => {
    // Workdir is the real gate — without it, fresh-execute has no
    // instruction files / skill tree and would start from an empty cwd.
    db.prepare(
      `INSERT INTO conversation_sessions (
         id, platform, channel_id, scope, scope_key, status, is_dm, backend_session_id
       )
       VALUES (8, 'dashboard', 'dashboard-old', ?, ?, 'closed', 1, NULL)`,
    ).run(DASHBOARD_CHAT_SCOPE, DASHBOARD_SCOPE_KEY);
    db.prepare(
      `INSERT INTO messages (session_id, role, content, platform)
       VALUES (8, 'user', 'hi', 'dashboard')`,
    ).run();
    // No mkdirSync for session 8 — workdir is absent.

    const result = continueDashboardSession({
      db,
      dataDir,
      sessionManager,
      sessionId: 8,
    });

    expect(result).toEqual({
      ok: false,
      status: 409,
      message: "This session's local state has already been cleaned up",
    });
  });

  it("rejects continuing a non-dashboard session", () => {
    db.prepare(
      `INSERT INTO conversation_sessions (
         id, platform, channel_id, scope, scope_key, status, is_dm, backend_session_id
       )
       VALUES (10, 'owner', 'owner', ?, ?, 'closed', 1, 'sdk-owner')`,
    ).run(OWNER_DM_SCOPE, OWNER_SCOPE_KEY);
    db.prepare(
      `INSERT INTO messages (session_id, role, content, platform)
       VALUES (10, 'user', 'telegram owner chat', 'telegram')`,
    ).run();
    mkdirSync(getSessionWorkdirPath(dataDir, 10), { recursive: true });

    const result = continueDashboardSession({
      db,
      dataDir,
      sessionManager,
      sessionId: 10,
    });

    expect(result).toEqual({
      ok: false,
      status: 403,
      message: "Only dashboard chat sessions can be continued from dashboard history",
    });
  });

  it("rejects continuing a session that has non-dashboard messages", () => {
    db.prepare(
      `INSERT INTO conversation_sessions (
         id, platform, channel_id, scope, scope_key, status, is_dm, backend_session_id
       )
       VALUES (11, 'dashboard', 'dashboard-mixed', ?, ?, 'closed', 1, 'sdk-mixed')`,
    ).run(DASHBOARD_CHAT_SCOPE, DASHBOARD_SCOPE_KEY);
    db.prepare(
      `INSERT INTO messages (session_id, role, content, platform)
       VALUES
       (11, 'user', 'web message', 'dashboard'),
       (11, 'user', 'forwarded from telegram', 'telegram')`,
    ).run();
    mkdirSync(getSessionWorkdirPath(dataDir, 11), { recursive: true });

    const result = continueDashboardSession({
      db,
      dataDir,
      sessionManager,
      sessionId: 11,
    });

    expect(result).toEqual({
      ok: false,
      status: 403,
      message: "Only browser-only sessions can be continued from dashboard history",
    });
  });

  it("invalidates SDK session when context changed after the session's last message", () => {
    db.prepare(
      `INSERT INTO conversation_sessions (
         id, platform, channel_id, scope, scope_key, status, is_dm, backend_session_id, last_message_at
       )
       VALUES (12, 'dashboard', 'dashboard-stale', ?, ?, 'closed', 1, 'sdk-stale', '2026-04-16 10:00:00')`,
    ).run(DASHBOARD_CHAT_SCOPE, DASHBOARD_SCOPE_KEY);
    db.prepare(
      `INSERT INTO messages (session_id, role, content, platform, timestamp)
       VALUES (12, 'user', 'old message', 'dashboard', '2026-04-16 10:00:00')`,
    ).run();
    mkdirSync(getSessionWorkdirPath(dataDir, 12), { recursive: true });
    // Simulate a context change AFTER the session's last message
    db.prepare(
      `INSERT OR REPLACE INTO runtime_state (key, value_json) VALUES ('dashboard_context_changed_at', '"2026-04-16 11:00:00"')`,
    ).run();

    const result = continueDashboardSession({
      db,
      dataDir,
      sessionManager,
      sessionId: 12,
    });

    expect(result).toEqual({ ok: true, sessionId: 12 });
    const row = db
      .prepare("SELECT backend_session_id FROM conversation_sessions WHERE id = 12")
      .get() as { backend_session_id: string | null };
    // SDK session should be cleared since context changed
    expect(row.backend_session_id).toBeNull();
  });

  it("falls back to last_message_at when every prior message is a proactive forward", () => {
    // Pins the `lastConsumedRow?.timestamp ?? sessionRow.last_message_at`
    // null-coalesce branch: the consumed-message lookup returns no
    // rows (because every assistant message is a forward), so the
    // freshness check has to fall back to the row's last_message_at.
    // Without the fallback, `shouldInvalidateSdkSession` would compare
    // contextChangedAt against `undefined` and would silently never
    // invalidate.
    db.prepare(
      `INSERT INTO conversation_sessions (
         id, platform, channel_id, scope, scope_key, status, is_dm, backend_session_id, last_message_at
       )
       VALUES (
         14, 'dashboard', 'dashboard-only-fwds', ?, ?, 'closed', 1,
         'sdk-only-fwds', '2026-04-16 09:00:00'
       )`,
    ).run(DASHBOARD_CHAT_SCOPE, DASHBOARD_SCOPE_KEY);
    db.prepare(
      `INSERT INTO messages (session_id, role, content, platform, metadata, timestamp)
       VALUES (14, 'assistant', 'forward only', 'dashboard', ?, '2026-04-16 12:00:00')`,
    ).run(JSON.stringify({ notificationType: "proactive_forward_batched" }));
    mkdirSync(getSessionWorkdirPath(dataDir, 14), { recursive: true });
    // Context changed AFTER the session's last_message_at — the fallback
    // path must still detect this and invalidate the SDK session.
    db.prepare(
      `INSERT OR REPLACE INTO runtime_state (key, value_json)
         VALUES ('dashboard_context_changed_at', '"2026-04-16 10:00:00"')`,
    ).run();

    const result = continueDashboardSession({
      db,
      dataDir,
      sessionManager,
      sessionId: 14,
    });

    expect(result).toEqual({ ok: true, sessionId: 14 });
    const row = db
      .prepare("SELECT backend_session_id FROM conversation_sessions WHERE id = 14")
      .get() as { backend_session_id: string | null };
    expect(row.backend_session_id).toBeNull();
  });

  it("ignores proactive forwards when judging context staleness", () => {
    // dm-channel-timeline.md §F.7 — forwards bump `last_message_at`
    // but must not mask a real context change that landed before the
    // forward, because the resumed SDK session never consumed the new
    // context.
    db.prepare(
      `INSERT INTO conversation_sessions (
         id, platform, channel_id, scope, scope_key, status, is_dm, backend_session_id, last_message_at
       )
       VALUES (
         13, 'dashboard', 'dashboard-fwd', ?, ?, 'closed', 1,
         'sdk-fwd', '2026-04-16 12:00:00'
       )`,
    ).run(DASHBOARD_CHAT_SCOPE, DASHBOARD_SCOPE_KEY);
    db.prepare(
      `INSERT INTO messages (session_id, role, content, platform, metadata, timestamp)
       VALUES
       (13, 'user', 'consumed turn', 'dashboard', '{}', '2026-04-16 10:00:00'),
       (13, 'assistant', 'forwarded text', 'dashboard', ?, '2026-04-16 12:00:00')`,
    ).run(JSON.stringify({ notificationType: "proactive_forward" }));
    mkdirSync(getSessionWorkdirPath(dataDir, 13), { recursive: true });
    // Context changed AFTER the consumed turn but BEFORE the forward.
    db.prepare(
      `INSERT OR REPLACE INTO runtime_state (key, value_json)
         VALUES ('dashboard_context_changed_at', '"2026-04-16 11:00:00"')`,
    ).run();

    const result = continueDashboardSession({
      db,
      dataDir,
      sessionManager,
      sessionId: 13,
    });

    expect(result).toEqual({ ok: true, sessionId: 13 });
    const row = db
      .prepare("SELECT backend_session_id FROM conversation_sessions WHERE id = 13")
      .get() as { backend_session_id: string | null };
    expect(row.backend_session_id).toBeNull();
  });
});
