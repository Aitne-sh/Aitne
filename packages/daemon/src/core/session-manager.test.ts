import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySchema } from "../db/schema.js";
import {
  SessionManager,
  findOrCreateActiveChannelSession,
} from "./session-manager.js";
import { applyPromptContextStaleness } from "./context-staleness.js";
import { markContextChanged } from "./dashboard-session-controls.js";
import { getSessionWorkdirPath } from "./workdir.js";
import type { AgentConfig } from "../config.js";
import {
  DASHBOARD_CHAT_SCOPE,
  DASHBOARD_SCOPE_KEY,
  OWNER_DM_SCOPE,
  OWNER_SCOPE_KEY,
} from "../messaging/constants.js";
import { formatSqliteDatetime } from "@aitne/shared";

function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    googleCalendarId: "primary",
    notionDatabaseIds: {},
    dataDir: "/tmp/test",
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
    ...overrides,
  } as unknown as AgentConfig;
}

describe("SessionManager", () => {
  let db: Database.Database;
  let mgr: SessionManager;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applySchema(db);
    mgr = new SessionManager(db, makeConfig());
  });

  afterEach(() => {
    vi.useRealTimers();
    db.close();
  });

  describe("getOrCreate", () => {
    it("creates a new session when none exists", async () => {
      const session = await mgr.getOrCreate({
        platform: "slack",
        channel: "D123",
        threadId: null,
      });

      expect(session.id).toBeGreaterThan(0);
      expect(session.isActive).toBe(false);
      expect(session.sessionId).toBeNull();
      expect(session.model).toBe("claude-opus-4-8");
    });

    it("returns existing active session within timeout", async () => {
      // Create initial session
      const first = await mgr.getOrCreate({
        platform: "slack",
        channel: "D123",
        threadId: null,
      });

      // Simulate agent updating it
      await mgr.updateSession(first.id, "claude-session-abc", "opus");

      // Get again — should return same session
      const second = await mgr.getOrCreate({
        platform: "slack",
        channel: "D123",
        threadId: null,
      });

      expect(second.id).toBe(first.id);
      expect(second.isActive).toBe(true);
      expect(second.sessionId).toBe("claude-session-abc");
      expect(second.model).toBe("opus");
    });

    it("expires active session when required backend changes", async () => {
      const dataDir = mkdtempSync(join(tmpdir(), "pa-session-manager-"));
      try {
        applySchema(db);
        mgr = new SessionManager(db, makeConfig({ dataDir }));

        const first = await mgr.getOrCreate({
          platform: "slack",
          channel: "D123",
          threadId: null,
          requiredBackend: "claude",
        });
        await mgr.updateSession(first.id, "claude-session-abc", "claude-opus-4-6", "claude");
        db.prepare(
          `INSERT INTO messages (session_id, role, content, platform, backend, model_id)
           VALUES (?, 'assistant', 'legacy reply', 'slack', 'claude', 'claude-opus-4-6')`,
        ).run(first.id);

        const second = await mgr.getOrCreate({
          platform: "slack",
          channel: "D123",
          threadId: null,
          requiredBackend: "codex",
        });

        expect(second.id).not.toBe(first.id);
        expect(second.isActive).toBe(false);
        expect(second.backend).toBe("codex");
        expect(second.requiresHistoryInjection).toBe(true);

        const oldSession = db
          .prepare("SELECT status FROM conversation_sessions WHERE id = ?")
          .get(first.id) as { status: string };
        expect(oldSession.status).toBe("expired");
      } finally {
        rmSync(dataDir, { recursive: true, force: true });
      }
    });

    it("dashboard DM: backend flap resets SDK session in place without changing row id", async () => {
      const dataDir = mkdtempSync(join(tmpdir(), "pa-session-manager-dash-"));
      try {
        applySchema(db);
        mgr = new SessionManager(db, makeConfig({ dataDir }));

        const first = await mgr.getOrCreate({
          platform: "dashboard",
          channel: "ch-1",
          threadId: null,
          isDm: true,
          requiredBackend: "claude",
        });
        await mgr.updateSession(first.id, "claude-session-abc", "claude-opus-4-6", "claude");
        db.prepare(
          `INSERT INTO messages (session_id, role, content, platform, backend, model_id)
           VALUES (?, 'assistant', 'reply', 'dashboard', 'claude', 'claude-opus-4-6')`,
        ).run(first.id);

        const second = await mgr.getOrCreate({
          platform: "dashboard",
          channel: "ch-2",
          threadId: null,
          isDm: true,
          requiredBackend: "codex",
        });

        // Same row, but SDK session invalidated so dispatcher falls
        // through to fresh execute with history injection.
        expect(second.id).toBe(first.id);
        expect(second.isActive).toBe(false);
        expect(second.sessionId).toBeNull();
        expect(second.backend).toBe("codex");
        expect(second.requiresHistoryInjection).toBe(true);

        const row = db
          .prepare("SELECT status, backend, backend_session_id FROM conversation_sessions WHERE id = ?")
          .get(first.id) as { status: string; backend: string; backend_session_id: string | null };
        expect(row.status).toBe("active");
        expect(row.backend).toBe("codex");
        expect(row.backend_session_id).toBeNull();
      } finally {
        rmSync(dataDir, { recursive: true, force: true });
      }
    });

    it("dashboard DM: same-backend model switch resets SDK session in place and flags history injection", async () => {
      const dataDir = mkdtempSync(join(tmpdir(), "pa-session-manager-model-"));
      try {
        applySchema(db);
        mgr = new SessionManager(db, makeConfig({ dataDir }));

        const first = await mgr.getOrCreate({
          platform: "dashboard",
          channel: "ch-1",
          threadId: null,
          isDm: true,
          requiredBackend: "claude",
          requiredModel: "claude-sonnet-4-6",
        });
        await mgr.updateSession(first.id, "claude-sdk-sonnet", "claude-sonnet-4-6", "claude");
        db.prepare(
          `INSERT INTO messages (session_id, role, content, platform, backend, model_id)
           VALUES (?, 'assistant', 'sonnet reply', 'dashboard', 'claude', 'claude-sonnet-4-6')`,
        ).run(first.id);

        // User switches Sonnet → Opus via the dashboard picker. Same
        // backend, different model — must trigger the in-place reset so
        // the Claude SDK drops the Sonnet-bound session id, the fresh
        // execute path runs with `model: opus`, and prior messages reach
        // the new model via `buildCrossSessionConversationHistory`.
        const second = await mgr.getOrCreate({
          platform: "dashboard",
          channel: "ch-1",
          threadId: null,
          isDm: true,
          requiredBackend: "claude",
          requiredModel: "claude-opus-4-7",
        });

        expect(second.id).toBe(first.id);
        expect(second.isActive).toBe(false);
        expect(second.sessionId).toBeNull();
        expect(second.backend).toBe("claude");
        expect(second.model).toBe("claude-opus-4-7");
        expect(second.requiresHistoryInjection).toBe(true);

        const row = db
          .prepare(
            "SELECT status, backend, model, backend_session_id FROM conversation_sessions WHERE id = ?",
          )
          .get(first.id) as {
            status: string;
            backend: string;
            model: string;
            backend_session_id: string | null;
          };
        expect(row.status).toBe("active");
        expect(row.backend).toBe("claude");
        expect(row.model).toBe("claude-opus-4-7");
        expect(row.backend_session_id).toBeNull();
      } finally {
        rmSync(dataDir, { recursive: true, force: true });
      }
    });

    it("dashboard DM: same-backend, same-model resumes as hot path even when requiredModel is passed", async () => {
      const dataDir = mkdtempSync(join(tmpdir(), "pa-session-manager-match-"));
      try {
        applySchema(db);
        mgr = new SessionManager(db, makeConfig({ dataDir }));

        const first = await mgr.getOrCreate({
          platform: "dashboard",
          channel: "ch-1",
          threadId: null,
          isDm: true,
          requiredBackend: "claude",
          requiredModel: "claude-sonnet-4-6",
        });
        await mgr.updateSession(first.id, "claude-sdk-sonnet", "claude-sonnet-4-6", "claude");

        const second = await mgr.getOrCreate({
          platform: "dashboard",
          channel: "ch-1",
          threadId: null,
          isDm: true,
          requiredBackend: "claude",
          requiredModel: "claude-sonnet-4-6",
        });

        expect(second.id).toBe(first.id);
        expect(second.isActive).toBe(true);
        expect(second.sessionId).toBe("claude-sdk-sonnet");
        expect(second.requiresHistoryInjection).toBe(false);
      } finally {
        rmSync(dataDir, { recursive: true, force: true });
      }
    });

    it("thread (non-DM): same-backend model switch expires old session and creates a new row", async () => {
      const dataDir = mkdtempSync(join(tmpdir(), "pa-session-manager-thread-model-"));
      try {
        applySchema(db);
        mgr = new SessionManager(db, makeConfig({ dataDir }));

        const first = await mgr.getOrCreate({
          platform: "slack",
          channel: "C123",
          threadId: "T1",
          requiredBackend: "claude",
          requiredModel: "claude-sonnet-4-6",
        });
        await mgr.updateSession(first.id, "claude-sdk", "claude-sonnet-4-6", "claude");
        db.prepare(
          `INSERT INTO messages (session_id, role, content, platform, backend, model_id)
           VALUES (?, 'assistant', 'reply', 'slack', 'claude', 'claude-sonnet-4-6')`,
        ).run(first.id);

        const second = await mgr.getOrCreate({
          platform: "slack",
          channel: "C123",
          threadId: "T1",
          requiredBackend: "claude",
          requiredModel: "claude-opus-4-7",
        });

        expect(second.id).not.toBe(first.id);
        expect(second.isActive).toBe(false);
        expect(second.backend).toBe("claude");
        expect(second.model).toBe("claude-opus-4-7");
        expect(second.requiresHistoryInjection).toBe(true);

        const oldSession = db
          .prepare("SELECT status FROM conversation_sessions WHERE id = ?")
          .get(first.id) as { status: string };
        expect(oldSession.status).toBe("expired");
      } finally {
        rmSync(dataDir, { recursive: true, force: true });
      }
    });

    it("omitting requiredModel preserves the pre-existing backend-only match", async () => {
      const dataDir = mkdtempSync(join(tmpdir(), "pa-session-manager-legacy-"));
      try {
        applySchema(db);
        mgr = new SessionManager(db, makeConfig({ dataDir }));

        const first = await mgr.getOrCreate({
          platform: "dashboard",
          channel: "ch-1",
          threadId: null,
          isDm: true,
          requiredBackend: "claude",
          requiredModel: "claude-sonnet-4-6",
        });
        await mgr.updateSession(first.id, "claude-sdk", "claude-sonnet-4-6", "claude");

        // No requiredModel on the follow-up call — must NOT trigger a
        // reset even though the stored model differs from what the
        // session would normally resolve to.
        const second = await mgr.getOrCreate({
          platform: "dashboard",
          channel: "ch-1",
          threadId: null,
          isDm: true,
          requiredBackend: "claude",
        });

        expect(second.id).toBe(first.id);
        expect(second.isActive).toBe(true);
        expect(second.sessionId).toBe("claude-sdk");
        expect(second.requiresHistoryInjection).toBe(false);
      } finally {
        rmSync(dataDir, { recursive: true, force: true });
      }
    });

    it("dashboard DM: persisted context_changed_at triggers in-place reset across restarts", async () => {
      const dataDir = mkdtempSync(join(tmpdir(), "pa-session-manager-ctx-"));
      try {
        applySchema(db);
        mgr = new SessionManager(db, makeConfig({ dataDir }));

        const first = await mgr.getOrCreate({
          platform: "dashboard",
          channel: "ch-1",
          threadId: null,
          isDm: true,
          requiredBackend: "claude",
        });
        await mgr.updateSession(first.id, "claude-session-abc", "claude-opus-4-6", "claude");

        // Simulate a context mutation AFTER this session's last turn by
        // writing a newer timestamp into runtime_state. This is what
        // `markContextChanged` does from `onPromptContextChanged`, and
        // unlike the in-memory flag it survives daemon restart.
        db.prepare(
          `INSERT INTO runtime_state (key, value_json, updated_at)
           VALUES ('dashboard_context_changed_at', ?, CURRENT_TIMESTAMP)
           ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`,
        ).run(JSON.stringify("9999-01-01 00:00:00"));

        const second = await mgr.getOrCreate({
          platform: "dashboard",
          channel: "ch-1",
          threadId: null,
          isDm: true,
          requiredBackend: "claude",
        });

        expect(second.id).toBe(first.id);
        expect(second.sessionId).toBeNull();
        expect(second.requiresHistoryInjection).toBe(false);

        const row = db
          .prepare("SELECT backend_session_id FROM conversation_sessions WHERE id = ?")
          .get(first.id) as { backend_session_id: string | null };
        expect(row.backend_session_id).toBeNull();
      } finally {
        rmSync(dataDir, { recursive: true, force: true });
      }
    });

    it("dashboard DM: quiet prompt-context writes preserve resume", async () => {
      const dataDir = mkdtempSync(join(tmpdir(), "pa-session-manager-quiet-"));
      try {
        mgr = new SessionManager(db, makeConfig({ dataDir }));

        const first = await mgr.getOrCreate({
          platform: "dashboard",
          channel: "ch-1",
          threadId: null,
          isDm: true,
          requiredBackend: "claude",
        });
        await mgr.updateSession(first.id, "claude-session-abc", "claude-opus-4-6", "claude");

        const decision = applyPromptContextStaleness(
          { path: "today", reason: "context_patch:today", tier: "quiet" },
          {
            dmStalenessStrict: false,
            setupInProgress: false,
            markContextChanged: () => markContextChanged(db),
            markActiveDmSessionsStale: (reason) =>
              mgr.markActiveDmSessionsStale(reason),
          },
        );

        const second = await mgr.getOrCreate({
          platform: "dashboard",
          channel: "ch-1",
          threadId: null,
          isDm: true,
          requiredBackend: "claude",
        });

        expect(decision.invalidatesDmSessions).toBe(false);
        expect(second.id).toBe(first.id);
        expect(second.isActive).toBe(true);
        expect(second.sessionId).toBe("claude-session-abc");
      } finally {
        rmSync(dataDir, { recursive: true, force: true });
      }
    });

    it("dashboard DM: strict mode treats quiet prompt-context writes as loud", async () => {
      const dataDir = mkdtempSync(join(tmpdir(), "pa-session-manager-strict-"));
      try {
        mgr = new SessionManager(db, makeConfig({ dataDir }));

        const first = await mgr.getOrCreate({
          platform: "dashboard",
          channel: "ch-1",
          threadId: null,
          isDm: true,
          requiredBackend: "claude",
        });
        await mgr.updateSession(first.id, "claude-session-abc", "claude-opus-4-6", "claude");

        const decision = applyPromptContextStaleness(
          { path: "today", reason: "context_patch:today", tier: "quiet" },
          {
            dmStalenessStrict: true,
            setupInProgress: false,
            markContextChanged: () => markContextChanged(db),
            markActiveDmSessionsStale: (reason) =>
              mgr.markActiveDmSessionsStale(reason),
          },
        );

        const second = await mgr.getOrCreate({
          platform: "dashboard",
          channel: "ch-1",
          threadId: null,
          isDm: true,
          requiredBackend: "claude",
        });

        expect(decision).toMatchObject({
          requestedTier: "quiet",
          effectiveTier: "loud",
          invalidatesDmSessions: true,
        });
        expect(second.id).toBe(first.id);
        expect(second.isActive).toBe(false);
        expect(second.sessionId).toBeNull();
      } finally {
        rmSync(dataDir, { recursive: true, force: true });
      }
    });

    it("dashboard DM: proactive forwards do not mask context_changed_at staleness", async () => {
      // dm-channel-timeline.md §F.7 — proactive forwards bump
      // `last_message_at` from a separate SDK session. The staleness
      // gate must compare against the most recent non-forwarded message,
      // otherwise a forward arriving after a context change would falsely
      // signal "no stale context" and the resumed SDK session would reason
      // over outdated MD files.
      const dataDir = mkdtempSync(join(tmpdir(), "pa-session-manager-fwd-"));
      try {
        const first = await mgr.getOrCreate({
          platform: "dashboard",
          channel: "ch-1",
          threadId: null,
          isDm: true,
          requiredBackend: "claude",
        });
        await mgr.updateSession(first.id, "claude-session-abc", "claude-opus-4-6", "claude");

        // 1. Seed a real user-consumed turn 5 minutes ago — this is the
        // anchor the staleness gate must compare against.
        db.prepare(
          `INSERT INTO messages (session_id, role, content, platform, timestamp)
           VALUES (?, 'user', 'older question', 'dashboard', datetime('now', '-5 minutes'))`,
        ).run(first.id);
        db.prepare(
          `UPDATE conversation_sessions SET last_message_at = datetime('now', '-5 minutes')
           WHERE id = ?`,
        ).run(first.id);

        // 2. Context file mutated 2 minutes ago — newer than the user turn,
        // so a fresh execute should be required.
        db.prepare(
          `INSERT INTO runtime_state (key, value_json, updated_at)
           VALUES ('dashboard_context_changed_at', ?, CURRENT_TIMESTAMP)
           ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`,
        ).run(JSON.stringify(formatSqliteDatetime(new Date(Date.now() - 2 * 60_000))));

        // 3. Proactive forward delivered 30 seconds ago bumps last_message_at
        // *past* the context_changed_at — under the old comparison this
        // would falsely pass the hot-path check.
        db.prepare(
          `INSERT INTO messages (session_id, role, content, platform, metadata, timestamp)
           VALUES (?, 'assistant', 'forwarded text', 'dashboard', ?, datetime('now', '-30 seconds'))`,
        ).run(first.id, JSON.stringify({ notificationType: "proactive_forward" }));
        db.prepare(
          `UPDATE conversation_sessions SET last_message_at = datetime('now', '-30 seconds')
           WHERE id = ?`,
        ).run(first.id);

        const second = await mgr.getOrCreate({
          platform: "dashboard",
          channel: "ch-1",
          threadId: null,
          isDm: true,
          requiredBackend: "claude",
        });

        expect(second.id).toBe(first.id);
        // Hot path skipped → SDK session cleared, ready for fresh execute.
        expect(second.sessionId).toBeNull();
        const row = db
          .prepare("SELECT backend_session_id FROM conversation_sessions WHERE id = ?")
          .get(first.id) as { backend_session_id: string | null };
        expect(row.backend_session_id).toBeNull();
      } finally {
        rmSync(dataDir, { recursive: true, force: true });
      }
    });

    it("expires timed-out session and creates new one", async () => {
      // Create a session
      const first = await mgr.getOrCreate({
        platform: "slack",
        channel: "D123",
        threadId: null,
      });
      await mgr.updateSession(first.id, "claude-session-old", "opus");

      // Manually set last_message_at to 2 hours ago
      db.prepare(
        "UPDATE conversation_sessions SET last_message_at = datetime('now', '-2 hours') WHERE id = ?",
      ).run(first.id);

      // Get again — should expire old and create new
      const second = await mgr.getOrCreate({
        platform: "slack",
        channel: "D123",
        threadId: null,
      });

      expect(second.id).not.toBe(first.id);
      expect(second.isActive).toBe(false);
      expect(second.sessionId).toBeNull();

      // Verify old session is expired
      const oldSession = db
        .prepare("SELECT status FROM conversation_sessions WHERE id = ?")
        .get(first.id) as { status: string };
      expect(oldSession.status).toBe("expired");
    });

    it("separates sessions by platform", async () => {
      const slack = await mgr.getOrCreate({
        platform: "slack",
        channel: "D123",
        threadId: null,
      });
      const telegram = await mgr.getOrCreate({
        platform: "telegram",
        channel: "D123",
        threadId: null,
      });

      expect(slack.id).not.toBe(telegram.id);
    });

    it("separates sessions by thread_id", async () => {
      const main = await mgr.getOrCreate({
        platform: "slack",
        channel: "C123",
        threadId: null,
      });
      const thread = await mgr.getOrCreate({
        platform: "slack",
        channel: "C123",
        threadId: "T456",
      });

      expect(main.id).not.toBe(thread.id);
    });

    it("forks dashboard DMs onto a docs_qa scope when intent='docs_qa'", async () => {
      const chat = await mgr.getOrCreate({
        platform: "dashboard",
        channel: "ch-1",
        threadId: null,
        isDm: true,
      });
      const qa = await mgr.getOrCreate({
        platform: "dashboard",
        channel: "qa-1",
        threadId: null,
        isDm: true,
        intent: "docs_qa",
      });

      // Distinct rows on distinct scopes — chat and QA must not share the
      // unique-active partial index.
      expect(qa.id).not.toBe(chat.id);

      const rows = db
        .prepare(
          "SELECT id, scope, scope_key, channel_id FROM conversation_sessions ORDER BY id",
        )
        .all() as Array<{
          id: number;
          scope: string;
          scope_key: string;
          channel_id: string;
        }>;
      const chatRow = rows.find((r) => r.id === chat.id);
      const qaRow = rows.find((r) => r.id === qa.id);
      expect(chatRow?.scope).toBe("dashboard_chat");
      expect(qaRow?.scope).toBe("docs_qa");
      expect(qaRow?.scope_key).toBe("docs_qa");
      // The QA row keeps its tab-specific channel id so the SSE adapter
      // can route deltas back to the right tab.
      expect(qaRow?.channel_id).toBe("qa-1");
    });
  });

  // M1 (release-prep): the bare-word close-keyword matcher (`end` /
  // `close` / `done`) was removed because the lone word "done" — a
  // natural English completion signal — silently terminated active
  // sessions. Session close is now an explicit `!close` bang command
  // exercised by `commands-close.test.ts`. No equivalent method
  // remains on `SessionManager`.

  describe("findOrCreateActiveChannelSession", () => {
    it("creates a fresh active row when the latest matching row is closed", () => {
      db.prepare(
        `INSERT INTO conversation_sessions (
           platform, channel_id, scope, scope_key, status, backend_session_id
         )
         VALUES ('slack', 'D-old', ?, ?, 'closed', 'sdk-old')`,
      ).run(OWNER_DM_SCOPE, OWNER_SCOPE_KEY);

      const session = findOrCreateActiveChannelSession(db, {
        scope: OWNER_DM_SCOPE,
        scopeKey: OWNER_SCOPE_KEY,
        platform: "slack",
        channelId: "D-new",
      });

      expect(session.created).toBe(true);
      const rows = db
        .prepare(
          `SELECT id, status, backend_session_id, platform, channel_id
             FROM conversation_sessions
            WHERE scope = ? AND scope_key = ?
            ORDER BY id`,
        )
        .all(OWNER_DM_SCOPE, OWNER_SCOPE_KEY) as Array<{
        id: number;
        status: string;
        backend_session_id: string | null;
        platform: string;
        channel_id: string;
      }>;
      expect(rows).toHaveLength(2);
      expect(rows[0].status).toBe("closed");
      expect(rows[1]).toMatchObject({
        id: session.id,
        status: "active",
        backend_session_id: null,
        platform: "slack",
        channel_id: "D-new",
      });
    });

    it("resolves the same owner_dm row across messaging platforms", async () => {
      const created = findOrCreateActiveChannelSession(db, {
        scope: OWNER_DM_SCOPE,
        scopeKey: OWNER_SCOPE_KEY,
        platform: "slack",
        channelId: "D-slack",
      });
      const telegram = findOrCreateActiveChannelSession(db, {
        scope: OWNER_DM_SCOPE,
        scopeKey: OWNER_SCOPE_KEY,
        platform: "telegram",
        channelId: "D-telegram",
      });
      const viaDispatcherPath = await mgr.getOrCreate({
        platform: "telegram",
        channel: "D-telegram",
        threadId: null,
        isDm: true,
      });

      expect(telegram).toEqual({ id: created.id, created: false });
      expect(viaDispatcherPath.id).toBe(created.id);
      const row = db
        .prepare("SELECT platform, channel_id FROM conversation_sessions WHERE id = ?")
        .get(created.id) as { platform: string; channel_id: string };
      expect(row).toEqual({ platform: "slack", channel_id: "D-slack" });
    });
  });

  describe("closeSession", () => {
    it("marks session as closed", async () => {
      const session = await mgr.getOrCreate({
        platform: "slack",
        channel: "D123",
        threadId: null,
      });
      mgr.closeSession(session.id);

      const row = db
        .prepare("SELECT status FROM conversation_sessions WHERE id = ?")
        .get(session.id) as { status: string };
      expect(row.status).toBe("closed");
    });

    it("closed session is not returned by getOrCreate", async () => {
      const first = await mgr.getOrCreate({
        platform: "slack",
        channel: "D123",
        threadId: null,
      });
      await mgr.updateSession(first.id, "session-abc", "opus");
      mgr.closeSession(first.id);

      const second = await mgr.getOrCreate({
        platform: "slack",
        channel: "D123",
        threadId: null,
      });
      expect(second.id).not.toBe(first.id);
    });

    it("preserves browser-only dashboard workdirs for history resume, including light models", async () => {
      const dataDir = mkdtempSync(join(tmpdir(), "pa-session-resume-"));
      try {
        applySchema(db);
        mgr = new SessionManager(db, makeConfig({ dataDir }));

        const session = await mgr.getOrCreate({
          platform: "dashboard",
          channel: "ch-1",
          threadId: null,
          isDm: true,
        });
        await mgr.updateSession(session.id, "sdk-session-1", "claude-sonnet-4-6", "claude");
        db.prepare(
          `INSERT INTO messages (session_id, role, content, platform)
           VALUES (?, 'user', 'hello', 'dashboard')`,
        ).run(session.id);

        const workdir = getSessionWorkdirPath(dataDir, session.id);
        mkdirSync(workdir, { recursive: true });

        mgr.closeSession(session.id);

        expect(existsSync(workdir)).toBe(true);
      } finally {
        rmSync(dataDir, { recursive: true, force: true });
      }
    });

    it("cleans up read-only messaging DM workdirs immediately", async () => {
      const dataDir = mkdtempSync(join(tmpdir(), "pa-session-readonly-"));
      try {
        applySchema(db);
        mgr = new SessionManager(db, makeConfig({ dataDir }));

        const session = await mgr.getOrCreate({
          platform: "slack",
          channel: "D123",
          threadId: null,
          isDm: true,
        });
        await mgr.updateSession(session.id, "sdk-session-1", "claude-opus-4-6", "claude");

        const workdir = getSessionWorkdirPath(dataDir, session.id);
        mkdirSync(workdir, { recursive: true });

        mgr.closeSession(session.id);

        expect(existsSync(workdir)).toBe(false);
      } finally {
        rmSync(dataDir, { recursive: true, force: true });
      }
    });
  });

  describe("touchSession", () => {
    it("updates last_message_at and message_count", async () => {
      const session = await mgr.getOrCreate({
        platform: "slack",
        channel: "D123",
        threadId: null,
      });

      mgr.touchSession(session.id);
      mgr.touchSession(session.id);

      const row = db
        .prepare(
          "SELECT message_count FROM conversation_sessions WHERE id = ?",
        )
        .get(session.id) as { message_count: number };
      expect(row.message_count).toBe(2);
    });
  });

  describe("markFreshExecuteStart (DM-HISTORY-CONTINUITY-FIX follow-up)", () => {
    it("bumps started_at to the current wall clock", async () => {
      // Seed a row whose started_at is far in the past — the scenario
      // a `handleDirectDm`-created session sits in until the user
      // finally replies and fresh-execute runs. After
      // markFreshExecuteStart, the row should reflect "now", so the
      // H-2 catchup builder's `> started_at` anchor matches the SDK-
      // session-bind time of THIS turn (not the original row-insert
      // time hours / days ago).
      const ancientSqlite = "2020-01-01 00:00:00";
      const result = db
        .prepare(
          `INSERT INTO conversation_sessions (
             platform, channel_id, scope, scope_key, status, is_dm,
             started_at
           ) VALUES ('slack', 'D-OWNER', 'owner_dm', 'owner', 'active', 1, ?)`,
        )
        .run(ancientSqlite);
      const sessionId = Number(result.lastInsertRowid);

      mgr.markFreshExecuteStart(sessionId);

      const row = db
        .prepare(
          "SELECT started_at FROM conversation_sessions WHERE id = ?",
        )
        .get(sessionId) as { started_at: string };
      // Refreshed value must be strictly newer than the seeded ancient
      // timestamp and within a few seconds of now.
      const refreshedMs = Date.parse(row.started_at.replace(" ", "T") + "Z");
      const nowMs = Date.now();
      expect(refreshedMs).toBeGreaterThan(Date.parse("2020-01-01T00:00:00Z"));
      expect(Math.abs(nowMs - refreshedMs)).toBeLessThan(5000);
    });

    it("leaves untouched columns (model, backend_session_id, message_count) alone", async () => {
      const result = db
        .prepare(
          `INSERT INTO conversation_sessions (
             platform, channel_id, scope, scope_key, status, is_dm,
             backend_session_id, model, message_count
           ) VALUES ('slack', 'D-OWNER', 'owner_dm', 'owner', 'active', 1,
                     'sdk-session-xyz', 'opus', 7)`,
        )
        .run();
      const sessionId = Number(result.lastInsertRowid);

      mgr.markFreshExecuteStart(sessionId);

      const row = db
        .prepare(
          `SELECT backend_session_id, model, message_count
             FROM conversation_sessions WHERE id = ?`,
        )
        .get(sessionId) as {
          backend_session_id: string;
          model: string;
          message_count: number;
        };
      expect(row.backend_session_id).toBe("sdk-session-xyz");
      expect(row.model).toBe("opus");
      expect(row.message_count).toBe(7);
    });
  });

  describe("DM session lifecycle", () => {
    it("DM: reuses the same session regardless of channelId", async () => {
      const first = await mgr.getOrCreate({
        platform: "dashboard",
        channel: "ch-aaa",
        threadId: null,
        isDm: true,
      });
      mgr.touchSession(first.id);

      // Different channelId (page reload) — should still find the same session
      const second = await mgr.getOrCreate({
        platform: "dashboard",
        channel: "ch-bbb",
        threadId: null,
        isDm: true,
      });

      expect(second.id).toBe(first.id);
      expect(second.isActive).toBe(true);
    });

    it("DM: no timeout — session persists after 2+ hours within the same agent day", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-04-21T20:00:00.000Z"));
      mgr = new SessionManager(db, makeConfig({ timezone: "UTC" }));

      const first = await mgr.getOrCreate({
        platform: "dashboard",
        channel: "ch-1",
        threadId: null,
        isDm: true,
      });
      mgr.touchSession(first.id);

      db.prepare(
        "UPDATE conversation_sessions SET last_message_at = ? WHERE id = ?",
      ).run("2026-04-21 15:00:00", first.id);

      const second = await mgr.getOrCreate({
        platform: "dashboard",
        channel: "ch-2",
        threadId: null,
        isDm: true,
      });

      expect(second.id).toBe(first.id);
    });

    it("DM: keeps the session before the configured day boundary even when the calendar date changed", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-04-22T03:30:00.000Z"));
      mgr = new SessionManager(db, makeConfig({ timezone: "UTC", dayBoundaryHour: 4 }));

      const first = await mgr.getOrCreate({
        platform: "dashboard",
        channel: "ch-1",
        threadId: null,
        isDm: true,
      });
      await mgr.updateSession(first.id, "sdk-session-1", "opus");

      db.prepare(
        "UPDATE conversation_sessions SET last_message_at = ? WHERE id = ?",
      ).run("2026-04-21 23:00:00", first.id);

      const second = await mgr.getOrCreate({
        platform: "dashboard",
        channel: "ch-2",
        threadId: null,
        isDm: true,
      });

      expect(second.id).toBe(first.id);
      expect(second.sessionId).toBe("sdk-session-1");
    });

    it("DM: expires after the configured day boundary even without an idle timeout", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-04-22T04:01:00.000Z"));
      mgr = new SessionManager(db, makeConfig({ timezone: "UTC", dayBoundaryHour: 4 }));

      const first = await mgr.getOrCreate({
        platform: "dashboard",
        channel: "ch-1",
        threadId: null,
        isDm: true,
      });
      await mgr.updateSession(first.id, "sdk-session-1", "opus");

      db.prepare(
        "UPDATE conversation_sessions SET last_message_at = ? WHERE id = ?",
      ).run("2026-04-21 23:00:00", first.id);

      const second = await mgr.getOrCreate({
        platform: "dashboard",
        channel: "ch-2",
        threadId: null,
        isDm: true,
      });

      expect(second.id).not.toBe(first.id);
      expect(second.sessionId).toBeNull();

      const oldSession = db
        .prepare("SELECT status FROM conversation_sessions WHERE id = ?")
        .get(first.id) as { status: string };
      expect(oldSession.status).toBe("expired");
    });

    it("DM: respects a non-default day boundary hour", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-04-22T06:30:00.000Z"));
      mgr = new SessionManager(db, makeConfig({ timezone: "UTC", dayBoundaryHour: 7 }));

      const first = await mgr.getOrCreate({
        platform: "dashboard",
        channel: "ch-1",
        threadId: null,
        isDm: true,
      });
      await mgr.updateSession(first.id, "sdk-session-1", "opus");

      db.prepare(
        "UPDATE conversation_sessions SET last_message_at = ? WHERE id = ?",
      ).run("2026-04-21 22:00:00", first.id);

      const beforeBoundary = await mgr.getOrCreate({
        platform: "dashboard",
        channel: "ch-2",
        threadId: null,
        isDm: true,
      });
      expect(beforeBoundary.id).toBe(first.id);

      vi.setSystemTime(new Date("2026-04-22T07:00:00.000Z"));

      const afterBoundary = await mgr.getOrCreate({
        platform: "dashboard",
        channel: "ch-3",
        threadId: null,
        isDm: true,
      });

      expect(afterBoundary.id).not.toBe(first.id);
    });

    it("owner DM: keeps the session before the configured day boundary even when the calendar date changed", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-04-22T03:30:00.000Z"));
      mgr = new SessionManager(db, makeConfig({ timezone: "UTC", dayBoundaryHour: 4 }));

      const first = await mgr.getOrCreate({
        platform: "slack",
        channel: "D123",
        threadId: null,
        isDm: true,
      });
      await mgr.updateSession(first.id, "sdk-session-1", "opus");

      db.prepare(
        "UPDATE conversation_sessions SET last_message_at = ? WHERE id = ?",
      ).run("2026-04-21 23:00:00", first.id);

      const second = await mgr.getOrCreate({
        platform: "telegram",
        channel: "T123",
        threadId: null,
        isDm: true,
      });

      expect(second.id).toBe(first.id);
      expect(second.sessionId).toBe("sdk-session-1");
    });

    it("owner DM: expires after the configured day boundary", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-04-22T04:01:00.000Z"));
      mgr = new SessionManager(db, makeConfig({ timezone: "UTC", dayBoundaryHour: 4 }));

      const first = await mgr.getOrCreate({
        platform: "slack",
        channel: "D123",
        threadId: null,
        isDm: true,
      });
      await mgr.updateSession(first.id, "sdk-session-1", "opus");

      db.prepare(
        "UPDATE conversation_sessions SET last_message_at = ? WHERE id = ?",
      ).run("2026-04-21 23:00:00", first.id);

      const second = await mgr.getOrCreate({
        platform: "telegram",
        channel: "T123",
        threadId: null,
        isDm: true,
      });

      expect(second.id).not.toBe(first.id);
      expect(second.sessionId).toBeNull();

      const oldSession = db
        .prepare("SELECT status FROM conversation_sessions WHERE id = ?")
        .get(first.id) as { status: string };
      expect(oldSession.status).toBe("expired");
    });

    it("non-DM: day boundary still expires a channel session inside its idle timeout", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-04-22T04:01:00.000Z"));
      mgr = new SessionManager(db, makeConfig({
        timezone: "UTC",
        dayBoundaryHour: 4,
        sessionTimeoutChannelMinutes: 360,
      }));

      const first = await mgr.getOrCreate({
        platform: "slack",
        channel: "C-general",
        threadId: null,
        isDm: false,
      });
      await mgr.updateSession(first.id, "sdk-session-456", "opus");

      db.prepare(
        "UPDATE conversation_sessions SET last_message_at = ? WHERE id = ?",
      ).run("2026-04-21 23:00:00", first.id);

      const second = await mgr.getOrCreate({
        platform: "slack",
        channel: "C-general",
        threadId: null,
        isDm: false,
      });

      expect(second.id).not.toBe(first.id);
    });

    it("DM: returns stored sessionId so dispatcher can decide resume vs fresh", async () => {
      const first = await mgr.getOrCreate({
        platform: "dashboard",
        channel: "ch-1",
        threadId: null,
        isDm: true,
      });

      expect(first.sessionId).toBeNull(); // No SDK session stored yet

      // Store a sessionId (e.g. from setup conversation)
      await mgr.updateSession(first.id, "sdk-session-123", "opus");

      const second = await mgr.getOrCreate({
        platform: "dashboard",
        channel: "ch-2",
        threadId: null,
        isDm: true,
      });

      // DM now returns the stored sessionId — dispatcher decides whether to resume
      expect(second.id).toBe(first.id);
      expect(second.sessionId).toBe("sdk-session-123");
    });

    it("DM: starts a fresh session after being marked stale", async () => {
      const first = await mgr.getOrCreate({
        platform: "slack",
        channel: "D123",
        threadId: null,
        isDm: true,
      });
      await mgr.updateSession(first.id, "sdk-session-123", "opus");

      mgr.markActiveDmSessionsStale("context_patch:today");

      const second = await mgr.getOrCreate({
        platform: "slack",
        channel: "D456",
        threadId: null,
        isDm: true,
      });

      expect(second.id).not.toBe(first.id);
      expect(second.isActive).toBe(false);
      expect(second.sessionId).toBeNull();

      const oldSession = db
        .prepare("SELECT status FROM conversation_sessions WHERE id = ?")
        .get(first.id) as { status: string };
      expect(oldSession.status).toBe("closed");
    });

    it("DM: separates dashboard chat from owner messaging DMs", async () => {
      const dashboard = await mgr.getOrCreate({
        platform: "dashboard",
        channel: "ch-1",
        threadId: null,
        isDm: true,
      });
      const slack = await mgr.getOrCreate({
        platform: "slack",
        channel: "D123",
        threadId: null,
        isDm: true,
      });

      expect(dashboard.id).not.toBe(slack.id);

      const rows = db.prepare(
        "SELECT id, scope, scope_key FROM conversation_sessions WHERE id IN (?, ?) ORDER BY id",
      ).all(dashboard.id, slack.id) as Array<{
        id: number;
        scope: string;
        scope_key: string;
      }>;
      expect(rows).toEqual([
        { id: dashboard.id, scope: DASHBOARD_CHAT_SCOPE, scope_key: DASHBOARD_SCOPE_KEY },
        { id: slack.id, scope: OWNER_DM_SCOPE, scope_key: OWNER_SCOPE_KEY },
      ]);
    });

    it("DM: still shares one owner session across messaging platforms", async () => {
      const slack = await mgr.getOrCreate({
        platform: "slack",
        channel: "D123",
        threadId: null,
        isDm: true,
      });
      const telegram = await mgr.getOrCreate({
        platform: "telegram",
        channel: "T123",
        threadId: null,
        isDm: true,
      });

      expect(slack.id).toBe(telegram.id);
    });

    it("non-DM: still uses channelId-based lookup with timeout", async () => {
      const first = await mgr.getOrCreate({
        platform: "slack",
        channel: "C-general",
        threadId: null,
        isDm: false,
      });
      await mgr.updateSession(first.id, "sdk-session-456", "opus");

      // Set last_message_at to 2 hours ago
      db.prepare(
        "UPDATE conversation_sessions SET last_message_at = datetime('now', '-2 hours') WHERE id = ?",
      ).run(first.id);

      const second = await mgr.getOrCreate({
        platform: "slack",
        channel: "C-general",
        threadId: null,
        isDm: false,
      });

      // Timed out → new session
      expect(second.id).not.toBe(first.id);
    });
  });

  describe("DM conversation log", () => {
    function seedDmSession(messageContents: string[]) {
      const sessionResult = db.prepare(
        `INSERT INTO conversation_sessions (
           platform, channel_id, scope, scope_key, status, is_dm, message_count
         )
         VALUES ('owner', 'owner', ?, ?, 'active', 1, ?)`,
      ).run(OWNER_DM_SCOPE, OWNER_SCOPE_KEY, messageContents.length);
      const sessionId = Number(sessionResult.lastInsertRowid);
      for (const content of messageContents) {
        const role = content.startsWith("[a]") ? "assistant" : "user";
        db.prepare(
          "INSERT INTO messages (session_id, role, content, platform) VALUES (?, ?, ?, 'owner')",
        ).run(sessionId, role, content);
      }
      return sessionId;
    }

    it("getDmPlatformsWithNewMessages returns nothing with no DM messages", () => {
      expect(mgr.getDmPlatformsWithNewMessages()).toHaveLength(0);
    });

    it("getDmPlatformsWithNewMessages detects new messages", () => {
      seedDmSession(["hello", "[a] hi"]);
      expect(mgr.getDmPlatformsWithNewMessages()).toEqual([OWNER_SCOPE_KEY]);
    });

    it("getDmPlatformsWithNewMessages skips if already summarized", () => {
      seedDmSession(["hello", "[a] hi"]);
      // Summarize → no new messages after this
      mgr.saveDmSummary(OWNER_SCOPE_KEY, "test summary", 2);
      expect(mgr.getDmPlatformsWithNewMessages()).toHaveLength(0);
    });

    it("getUnsummarizedDmMessages returns messages since last summary", () => {
      // Old messages + summary
      const oldSessionId = seedDmSession(["old msg", "[a] old reply"]);
      // Backdate old messages
      db.prepare(
        "UPDATE messages SET timestamp = datetime('now', '-2 hours') WHERE session_id = ?",
      ).run(oldSessionId);
      // Close old session so the unique index allows a new active one
      db.prepare(
        "UPDATE conversation_sessions SET status = 'expired' WHERE id = ?",
      ).run(oldSessionId);
      // Save summary (created_at = now - 1 hour, between old and new messages)
      db.prepare(
        `INSERT INTO dm_conversation_log (platform, scope, scope_key, summary, message_count, created_at)
         VALUES ('owner', ?, ?, 'old summary', 2, datetime('now', '-1 hour'))`,
      ).run(OWNER_DM_SCOPE, OWNER_SCOPE_KEY);

      // New messages (timestamp = now, after the summary)
      seedDmSession(["new msg", "[a] new reply"]);

      const msgs = mgr.getUnsummarizedDmMessages(OWNER_SCOPE_KEY);
      expect(msgs).toHaveLength(2);
      expect(msgs[0].content).toBe("new msg");
    });

    it("getUnsummarizedDmMessages returns all messages if no previous summary", () => {
      seedDmSession(["msg1", "msg2", "msg3"]);
      const msgs = mgr.getUnsummarizedDmMessages(OWNER_SCOPE_KEY);
      expect(msgs).toHaveLength(3);
    });

    it("saveDmSummary + getPreviousDmSummary round-trip", () => {
      db.prepare(
        `INSERT INTO dm_conversation_log (platform, scope, scope_key, summary, message_count, created_at)
         VALUES ('owner', ?, ?, 'Day 1 summary', 5, datetime('now', '-1 hour'))`,
      ).run(OWNER_DM_SCOPE, OWNER_SCOPE_KEY);
      expect(mgr.getPreviousDmSummary(OWNER_SCOPE_KEY)).toBe("Day 1 summary");

      mgr.saveDmSummary(OWNER_SCOPE_KEY, "Day 2 rolling summary", 8);
      expect(mgr.getPreviousDmSummary(OWNER_SCOPE_KEY)).toBe("Day 2 rolling summary");
    });

    it("getPreviousDmSummary returns null with no summaries", () => {
      expect(mgr.getPreviousDmSummary(OWNER_SCOPE_KEY)).toBeNull();
    });

    it("getOrCreate stores is_dm flag", async () => {
      const session = await mgr.getOrCreate({
        platform: "dashboard",
        channel: "ch-1",
        threadId: null,
        isDm: true,
      });

      const row = db.prepare(
        "SELECT is_dm FROM conversation_sessions WHERE id = ?",
      ).get(session.id) as { is_dm: number };
      expect(row.is_dm).toBe(1);
    });

    it("getOrCreate stores is_dm=0 for channel mentions", async () => {
      const session = await mgr.getOrCreate({
        platform: "slack",
        channel: "C-general",
        threadId: null,
        isDm: false,
      });

      const row = db.prepare(
        "SELECT is_dm FROM conversation_sessions WHERE id = ?",
      ).get(session.id) as { is_dm: number };
      expect(row.is_dm).toBe(0);
    });
  });

  describe("findActive", () => {
    it("returns null when no active session exists", async () => {
      const result = await mgr.findActive({
        platform: "slack",
        channel: "D123",
        threadId: null,
      });
      expect(result).toBeNull();
    });

    it("returns the active DM session", async () => {
      const session = await mgr.getOrCreate({
        platform: "dashboard",
        channel: "ch-1",
        threadId: null,
        isDm: true,
      });

      const found = await mgr.findActive({
        platform: "dashboard",
        channel: "ch-1",
        threadId: null,
        isDm: true,
      });

      expect(found).not.toBeNull();
      expect(found!.id).toBe(session.id);
    });

    it("returns the active thread session", async () => {
      const session = await mgr.getOrCreate({
        platform: "slack",
        channel: "C123",
        threadId: "T456",
      });

      const found = await mgr.findActive({
        platform: "slack",
        channel: "C123",
        threadId: "T456",
      });

      expect(found).not.toBeNull();
      expect(found!.id).toBe(session.id);
    });

    it("returns null after session is closed", async () => {
      const session = await mgr.getOrCreate({
        platform: "slack",
        channel: "D123",
        threadId: null,
        isDm: true,
      });
      mgr.closeSession(session.id);

      const found = await mgr.findActive({
        platform: "slack",
        channel: "D123",
        threadId: null,
        isDm: true,
      });
      expect(found).toBeNull();
    });
  });

  describe("updateSession with backend columns", () => {
    it("switches backend_session_id when changing backend", async () => {
      const dataDir = mkdtempSync(join(tmpdir(), "pa-session-backend-"));
      try {
        applySchema(db);
        mgr = new SessionManager(db, makeConfig({ dataDir }));

        const session = await mgr.getOrCreate({
          platform: "dashboard",
          channel: "ch-1",
          threadId: null,
          isDm: true,
        });
        await mgr.updateSession(session.id, "claude-session-1", "claude-opus-4-6", "claude");

        const before = db.prepare(
          "SELECT backend_session_id, backend FROM conversation_sessions WHERE id = ?",
        ).get(session.id) as { backend_session_id: string | null; backend: string | null };
        expect(before.backend_session_id).toBe("claude-session-1");
        expect(before.backend).toBe("claude");

        // Switch to codex
        await mgr.updateSession(session.id, "codex-session-1", "gpt-5.4", "codex");

        const after = db.prepare(
          "SELECT backend_session_id, backend FROM conversation_sessions WHERE id = ?",
        ).get(session.id) as { backend_session_id: string | null; backend: string | null };
        expect(after.backend_session_id).toBe("codex-session-1");
        expect(after.backend).toBe("codex");
      } finally {
        rmSync(dataDir, { recursive: true, force: true });
      }
    });

    it("updates backend_session_id for claude backend", async () => {
      const session = await mgr.getOrCreate({
        platform: "dashboard",
        channel: "ch-1",
        threadId: null,
        isDm: true,
      });

      await mgr.updateSession(session.id, "claude-sess-abc", "claude-opus-4-6", "claude");

      const row = db.prepare(
        "SELECT backend_session_id, model FROM conversation_sessions WHERE id = ?",
      ).get(session.id) as { backend_session_id: string | null; model: string };
      expect(row.backend_session_id).toBe("claude-sess-abc");
      expect(row.model).toBe("claude-opus-4-6");
    });

    it("updates without backend param defaults to claude", async () => {
      const session = await mgr.getOrCreate({
        platform: "dashboard",
        channel: "ch-1",
        threadId: null,
        isDm: true,
      });

      await mgr.updateSession(session.id, "session-default", "opus");

      const row = db.prepare(
        "SELECT backend_session_id FROM conversation_sessions WHERE id = ?",
      ).get(session.id) as { backend_session_id: string | null };
      expect(row.backend_session_id).toBe("session-default");
    });
  });

  describe("markActiveDmSessionsStale", () => {
    it("no-op when no active DM session exists", () => {
      // Should not throw
      mgr.markActiveDmSessionsStale("test_reason");
    });

    it("marks both dashboard chat and owner messaging DM sessions stale", async () => {
      const dashboard = await mgr.getOrCreate({
        platform: "dashboard",
        channel: "dashboard-ch-1",
        threadId: null,
        isDm: true,
      });
      await mgr.updateSession(dashboard.id, "sdk-dashboard", "opus");

      const ownerDm = await mgr.getOrCreate({
        platform: "slack",
        channel: "D123",
        threadId: null,
        isDm: true,
      });
      await mgr.updateSession(ownerDm.id, "sdk-owner", "opus");

      mgr.markActiveDmSessionsStale("context_patch:today");

      const nextDashboard = await mgr.getOrCreate({
        platform: "dashboard",
        channel: "dashboard-ch-2",
        threadId: null,
        isDm: true,
      });
      const nextOwnerDm = await mgr.getOrCreate({
        platform: "telegram",
        channel: "T123",
        threadId: null,
        isDm: true,
      });

      // Dashboard: reset in place — the row identity (session id) must
      // survive stale invalidation so `Continue #N` in the sidebar keeps
      // pointing at the same row. `backend_session_id` is NULLed so the
      // next turn runs a fresh SDK execute with history injection.
      expect(nextDashboard.id).toBe(dashboard.id);
      expect(nextDashboard.sessionId).toBeNull();
      expect(nextDashboard.isActive).toBe(false);
      expect(nextDashboard.requiresHistoryInjection).toBe(false);
      // Owner messaging DM: keep close+create behavior so per-platform
      // summarization and day-long owner-DM semantics are unaffected.
      expect(nextOwnerDm.id).not.toBe(ownerDm.id);
      expect(nextOwnerDm.sessionId).toBeNull();
    });
  });

  describe("DM: day boundary crossing", () => {
    it("expires DM session when day boundary is crossed", async () => {
      const first = await mgr.getOrCreate({
        platform: "dashboard",
        channel: "ch-1",
        threadId: null,
        isDm: true,
      });
      await mgr.updateSession(first.id, "sdk-session-1", "opus");

      // Set last_message_at to yesterday before the day boundary
      db.prepare(
        "UPDATE conversation_sessions SET last_message_at = datetime('now', '-25 hours') WHERE id = ?",
      ).run(first.id);

      const second = await mgr.getOrCreate({
        platform: "dashboard",
        channel: "ch-2",
        threadId: null,
        isDm: true,
      });

      // Should be a new session since the day boundary was crossed
      expect(second.id).not.toBe(first.id);
      expect(second.isActive).toBe(false);
    });
  });

  describe("dashboard session timeout", () => {
    it("uses the longer dashboard timeout for dashboard platform", async () => {
      // Dashboard timeout is 120 min in test config
      const first = await mgr.getOrCreate({
        platform: "dashboard",
        channel: "C-dash",
        threadId: null,
        isDm: false,
      });
      await mgr.updateSession(first.id, "session-abc", "opus");

      // Set last_message_at to 90 minutes ago (within 120 min timeout)
      db.prepare(
        "UPDATE conversation_sessions SET last_message_at = datetime('now', '-90 minutes') WHERE id = ?",
      ).run(first.id);

      const second = await mgr.getOrCreate({
        platform: "dashboard",
        channel: "C-dash",
        threadId: null,
        isDm: false,
      });

      // Should still be the same session (within dashboard timeout)
      expect(second.id).toBe(first.id);
      expect(second.isActive).toBe(true);
    });
  });
});
