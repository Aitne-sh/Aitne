import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEvent, formatSqliteDatetime } from "@aitne/shared";
import type { MessageEvent } from "@aitne/shared";
import { applySchema } from "../db/schema.js";
import { MessageHandler } from "./dispatcher-message-handler.js";
import type { MessageHandlerDeps } from "./dispatcher-message-handler.js";
import type { AgentConfig } from "../config.js";
import type { EventBus } from "./event-bus.js";
import type { IAgentRouter } from "./backends/backend-router.js";
import type { SignalDetector } from "./signal-detector.js";
import type { AttachmentStore } from "../services/attachments/store.js";
import type { DocsCitationLookup } from "./docs/citation-validator.js";
import type { MailAccount } from "../services/mail/provider.js";
import type {
  IAuditLogger,
  IContextBuilder,
  IDashboardStream,
  IMessageRecorder,
  INotificationManager,
  ISessionManager,
  SetupMode,
} from "./dispatcher-types.js";
import type { PromptAssembler } from "./dispatcher-prompt.js";
import type { DispatcherErrorRouter } from "./dispatcher-error-handling.js";
import type { ResultProcessor } from "./dispatcher-result-processor.js";

// ── Test-only fakes ───────────────────────────────────────────────────────

function fakeConfig(dataDir: string): AgentConfig {
  return {
    dataDir,
    workspaceDir: join(dataDir, "workdirs"),
    apiPort: 0,
    timezone: "UTC",
    dayBoundaryHour: 4,
  } as unknown as AgentConfig;
}

function dmEvent(overrides: Partial<MessageEvent> = {}): MessageEvent {
  return {
    ...createEvent({
      type: "message.received",
      platform: "dashboard",
      channel: "chan-1",
      sender: "owner",
      content: "/auth status",
      isDm: true,
    }),
    ...overrides,
  } as MessageEvent;
}

type HandlerHandles = {
  handler: MessageHandler;
  notificationMgr: { send: ReturnType<typeof vi.fn> };
  audit: { logSkip: ReturnType<typeof vi.fn> };
  authRecovery: AuthRecoveryStub;
  authHealthMonitor: AuthHealthMonitorStub;
  setSetupMode: (mode: SetupMode | null) => void;
  beginSetupModeCalls: SetupMode[];
};

interface AuthRecoveryStub {
  isRecoveryActive: ReturnType<typeof vi.fn>;
  getActiveRecovery: ReturnType<typeof vi.fn>;
  initiateClaudeAuth: ReturnType<typeof vi.fn>;
  initiateCodexDeviceAuth: ReturnType<typeof vi.fn>;
  initiateGeminiAuth: ReturnType<typeof vi.fn>;
  handleGeminiAuthCode: ReturnType<typeof vi.fn>;
  cancelRecovery: ReturnType<typeof vi.fn>;
}

interface AuthHealthMonitorStub {
  renderStatusSummary: ReturnType<typeof vi.fn>;
  listExpiredBackends: ReturnType<typeof vi.fn>;
}

function makeAuthRecovery(): AuthRecoveryStub {
  return {
    isRecoveryActive: vi.fn().mockReturnValue(false),
    getActiveRecovery: vi.fn().mockReturnValue(null),
    initiateClaudeAuth: vi
      .fn()
      .mockResolvedValue({ authUrl: "https://claude/auth", expiresMinutes: 15 }),
    initiateCodexDeviceAuth: vi.fn().mockResolvedValue({
      authUrl: "https://codex/device",
      userCode: "ABCD",
      expiresMinutes: 10,
    }),
    initiateGeminiAuth: vi
      .fn()
      .mockResolvedValue({ authUrl: "https://gemini/oauth", expiresMinutes: 30 }),
    handleGeminiAuthCode: vi.fn().mockResolvedValue({ ok: true, detail: "saved" }),
    cancelRecovery: vi.fn().mockReturnValue(false),
  };
}

function makeAuthHealthMonitor(): AuthHealthMonitorStub {
  return {
    renderStatusSummary: vi.fn().mockReturnValue("status-summary"),
    listExpiredBackends: vi.fn().mockReturnValue([]),
  };
}

function buildHandler(
  db: Database.Database,
  dataDir: string,
  overrides: {
    notificationMgr?: Partial<INotificationManager>;
    audit?: Partial<IAuditLogger>;
    authRecovery?: AuthRecoveryStub | null;
    authHealthMonitor?: AuthHealthMonitorStub | null;
    initialSetupMode?: SetupMode | null;
  } = {},
): HandlerHandles {
  const notificationMgr = {
    send: vi.fn().mockResolvedValue(undefined),
    beginReplyActivity: vi.fn().mockResolvedValue({ stop: vi.fn() }),
    ...(overrides.notificationMgr ?? {}),
  };
  const audit = {
    logEvent: vi.fn(),
    logSkip: vi.fn(),
    logError: vi.fn(),
    ...(overrides.audit ?? {}),
  };
  const authRecovery =
    overrides.authRecovery === null
      ? null
      : overrides.authRecovery ?? makeAuthRecovery();
  const authHealthMonitor =
    overrides.authHealthMonitor === null
      ? null
      : overrides.authHealthMonitor ?? makeAuthHealthMonitor();

  let setupMode: SetupMode | null = overrides.initialSetupMode ?? null;
  const beginSetupModeCalls: SetupMode[] = [];

  const deps: MessageHandlerDeps = {
    db,
    config: fakeConfig(dataDir),
    eventBus: { put: vi.fn() } as unknown as EventBus,
    agentRouter: { resolveBinding: vi.fn() } as unknown as IAgentRouter,
    contextBuilder: { build: vi.fn() } as unknown as IContextBuilder,
    notificationMgr: notificationMgr as unknown as INotificationManager,
    sessionMgr: {
      findActive: vi.fn(),
      closeSession: vi.fn(),
    } as unknown as ISessionManager,
    messageRecorder: { recordMessage: vi.fn() } as unknown as IMessageRecorder,
    audit: audit as unknown as IAuditLogger,
    prompt: {} as unknown as PromptAssembler,
    errorRouter: {} as unknown as DispatcherErrorRouter,
    resultProcessor: {} as unknown as ResultProcessor,
    getSignalDetector: () => null as SignalDetector | null,
    getDashboardStream: () => null as IDashboardStream | null,
    getAttachmentStore: () => null as AttachmentStore | null,
    getDocsCitationLookup: () => null as DocsCitationLookup | null,
    getAuthRecovery: () =>
      authRecovery as unknown as ReturnType<MessageHandlerDeps["getAuthRecovery"]>,
    getAuthHealthMonitor: () =>
      authHealthMonitor as unknown as ReturnType<
        MessageHandlerDeps["getAuthHealthMonitor"]
      >,
    getBangCommandRegistry: () => null,
    getCurrentSetupMode: () => setupMode,
    beginSetupMode: (mode) => {
      beginSetupModeCalls.push(mode);
      setupMode = mode;
    },
    lookupCustomBangCommandForEvent: () => null,
    getConfiguredServices: () => new Set<string>() as ReadonlySet<string>,
    getActiveMailAccounts: () => [] as readonly MailAccount[],
    readLastInsertedMessageId: () => null,
  };

  return {
    handler: new MessageHandler(deps),
    notificationMgr,
    audit,
    authRecovery: authRecovery ?? makeAuthRecovery(),
    authHealthMonitor: authHealthMonitor ?? makeAuthHealthMonitor(),
    setSetupMode: (mode) => {
      setupMode = mode;
    },
    beginSetupModeCalls,
  };
}

// ── Test bodies ───────────────────────────────────────────────────────────

describe("MessageHandler — handleAuthCommand", () => {
  let db: Database.Database;
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "pa-msg-handler-"));
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applySchema(db);
  });

  afterEach(() => {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("returns false on a non-auth command", async () => {
    const h = buildHandler(db, dataDir);
    const handled = await h.handler.handleAuthCommand(
      dmEvent({ content: "hello" }),
    );
    expect(handled).toBe(false);
    expect(h.notificationMgr.send).not.toHaveBeenCalled();
  });

  it("`/auth status` renders the monitor summary when wired", async () => {
    const h = buildHandler(db, dataDir);
    const handled = await h.handler.handleAuthCommand(
      dmEvent({ content: "/auth status" }),
    );
    expect(handled).toBe(true);
    expect(h.authHealthMonitor.renderStatusSummary).toHaveBeenCalledOnce();
    expect(h.notificationMgr.send).toHaveBeenCalledWith(
      "status-summary",
      expect.any(Object),
    );
  });

  it("`/auth status` falls back to a pointer message when monitor unwired", async () => {
    const h = buildHandler(db, dataDir, { authHealthMonitor: null });
    const handled = await h.handler.handleAuthCommand(
      dmEvent({ content: "/auth status" }),
    );
    expect(handled).toBe(true);
    expect(h.notificationMgr.send).toHaveBeenCalledWith(
      expect.stringContaining("Check auth status on the dashboard"),
      expect.any(Object),
    );
  });

  it("`/auth fix claude` returns false when recovery is unwired", async () => {
    const h = buildHandler(db, dataDir, { authRecovery: null });
    const handled = await h.handler.handleAuthCommand(
      dmEvent({ content: "/auth fix claude" }),
    );
    expect(handled).toBe(false);
    expect(h.notificationMgr.send).not.toHaveBeenCalled();
  });

  it("`/auth fix claude` short-circuits when recovery already active", async () => {
    const recovery = makeAuthRecovery();
    recovery.isRecoveryActive.mockReturnValue(true);
    recovery.getActiveRecovery.mockReturnValue({
      authUrl: "https://existing/url",
    });
    const h = buildHandler(db, dataDir, { authRecovery: recovery });
    const handled = await h.handler.handleAuthCommand(
      dmEvent({ content: "/auth fix claude" }),
    );
    expect(handled).toBe(true);
    expect(recovery.initiateClaudeAuth).not.toHaveBeenCalled();
    expect(h.notificationMgr.send).toHaveBeenCalledWith(
      expect.stringContaining("https://existing/url"),
      expect.any(Object),
    );
  });

  it("`/auth fix claude` initiates browser auth and replies with URL", async () => {
    const h = buildHandler(db, dataDir);
    const handled = await h.handler.handleAuthCommand(
      dmEvent({ content: "/auth fix claude" }),
    );
    expect(handled).toBe(true);
    expect(h.authRecovery.initiateClaudeAuth).toHaveBeenCalledOnce();
    expect(h.notificationMgr.send).toHaveBeenCalledWith(
      expect.stringContaining("https://claude/auth"),
      expect.any(Object),
    );
  });

  it("`/auth fix claude` reports the error when initiate throws", async () => {
    const recovery = makeAuthRecovery();
    recovery.initiateClaudeAuth.mockRejectedValue(new Error("boom"));
    const h = buildHandler(db, dataDir, { authRecovery: recovery });
    const handled = await h.handler.handleAuthCommand(
      dmEvent({ content: "/auth fix claude" }),
    );
    expect(handled).toBe(true);
    expect(h.notificationMgr.send).toHaveBeenCalledWith(
      expect.stringContaining("Failed to start Claude auth recovery: boom"),
      expect.any(Object),
    );
  });

  it("`/auth fix codex` posts device-code instructions", async () => {
    const h = buildHandler(db, dataDir);
    const handled = await h.handler.handleAuthCommand(
      dmEvent({ content: "/auth fix codex" }),
    );
    expect(handled).toBe(true);
    expect(h.authRecovery.initiateCodexDeviceAuth).toHaveBeenCalledOnce();
    expect(h.notificationMgr.send).toHaveBeenCalledWith(
      expect.stringContaining("ABCD"),
      expect.any(Object),
    );
  });

  it("`/auth fix gemini` posts the authorize URL with expiry", async () => {
    const h = buildHandler(db, dataDir);
    const handled = await h.handler.handleAuthCommand(
      dmEvent({ content: "/auth fix gemini" }),
    );
    expect(handled).toBe(true);
    expect(h.authRecovery.initiateGeminiAuth).toHaveBeenCalledOnce();
    expect(h.notificationMgr.send).toHaveBeenCalledWith(
      expect.stringContaining("https://gemini/oauth"),
      expect.any(Object),
    );
  });

  it("`/auth fix all` says nothing-to-do when no backends are expired", async () => {
    const h = buildHandler(db, dataDir);
    const handled = await h.handler.handleAuthCommand(
      dmEvent({ content: "/auth fix all" }),
    );
    expect(handled).toBe(true);
    expect(h.notificationMgr.send).toHaveBeenCalledWith(
      "All backends are healthy. No recovery needed.",
      expect.any(Object),
    );
  });

  it("`/auth fix all` walks expired backends and posts a summary", async () => {
    const monitor = makeAuthHealthMonitor();
    monitor.listExpiredBackends.mockReturnValue(["claude", "codex", "gemini"]);
    const h = buildHandler(db, dataDir, { authHealthMonitor: monitor });
    await h.handler.handleAuthCommand(dmEvent({ content: "/auth fix all" }));
    expect(h.authRecovery.initiateClaudeAuth).toHaveBeenCalledOnce();
    expect(h.authRecovery.initiateCodexDeviceAuth).toHaveBeenCalledOnce();
    expect(h.authRecovery.initiateGeminiAuth).toHaveBeenCalledOnce();
    const summary = h.notificationMgr.send.mock.calls[0]?.[0] as string;
    expect(summary).toContain("claude");
    expect(summary).toContain("codex");
    expect(summary).toContain("gemini");
  });

  it("`/auth fix all` surfaces opencode manual recovery instead of starting a session", async () => {
    const monitor = makeAuthHealthMonitor();
    monitor.listExpiredBackends.mockReturnValue(["opencode"]);
    const h = buildHandler(db, dataDir, { authHealthMonitor: monitor });
    await h.handler.handleAuthCommand(dmEvent({ content: "/auth fix all" }));
    // No daemon-driven auth flow exists for OpenCode — none should be started.
    expect(h.authRecovery.initiateClaudeAuth).not.toHaveBeenCalled();
    expect(h.authRecovery.initiateCodexDeviceAuth).not.toHaveBeenCalled();
    expect(h.authRecovery.initiateGeminiAuth).not.toHaveBeenCalled();
    const summary = h.notificationMgr.send.mock.calls[0]?.[0] as string;
    expect(summary).toContain("opencode");
    expect(summary).toContain("opencode auth login");
  });

  it("`/auth cancel` cancels every backend and replies with status", async () => {
    const recovery = makeAuthRecovery();
    recovery.cancelRecovery.mockReturnValueOnce(true);
    const h = buildHandler(db, dataDir, { authRecovery: recovery });
    const handled = await h.handler.handleAuthCommand(
      dmEvent({ content: "/auth cancel" }),
    );
    expect(handled).toBe(true);
    // codex + gemini + claude + opencode — opencode has no daemon-driven
    // session to cancel but is included for symmetry across BACKEND_IDS.
    expect(recovery.cancelRecovery).toHaveBeenCalledTimes(4);
    expect(h.notificationMgr.send).toHaveBeenCalledWith(
      "Auth recovery cancelled.",
      expect.any(Object),
    );
  });

  it("`/auth fix opencode` surfaces the manual CLI command", async () => {
    const h = buildHandler(db, dataDir);
    const handled = await h.handler.handleAuthCommand(
      dmEvent({ content: "/auth fix opencode" }),
    );
    expect(handled).toBe(true);
    const body = h.notificationMgr.send.mock.calls[0]?.[0] as string;
    expect(body).toContain("opencode auth login");
    expect(body).toContain("/auth status");
    // OpenCode recovery is manual — no daemon-driven session is initiated.
    expect(h.authRecovery.initiateClaudeAuth).not.toHaveBeenCalled();
    expect(h.authRecovery.initiateCodexDeviceAuth).not.toHaveBeenCalled();
    expect(h.authRecovery.initiateGeminiAuth).not.toHaveBeenCalled();
  });

  it("`/auth cancel <backend>` cancels only that backend", async () => {
    const recovery = makeAuthRecovery();
    recovery.cancelRecovery.mockReturnValue(true);
    const h = buildHandler(db, dataDir, { authRecovery: recovery });
    await h.handler.handleAuthCommand(
      dmEvent({ content: "/auth cancel gemini" }),
    );
    const args = recovery.cancelRecovery.mock.calls.map((c) => c[0]);
    expect(args).toEqual(["gemini"]);
  });
});

describe("MessageHandler — handle (cross-platform setup lockout)", () => {
  let db: Database.Database;
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "pa-msg-handler-"));
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applySchema(db);
  });

  afterEach(() => {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("rejects a non-dashboard DM while setup mode is engaged", async () => {
    const h = buildHandler(db, dataDir, { initialSetupMode: "initial" });
    const event = dmEvent({ platform: "slack", content: "ping" });
    await h.handler.handle(event);
    expect(h.audit.logSkip).toHaveBeenCalledWith(
      expect.objectContaining({ platform: "slack" }),
      "setup_in_progress",
      "reactive",
    );
    expect(h.notificationMgr.send).toHaveBeenCalledWith(
      expect.stringContaining("Setup is in progress."),
      expect.any(Object),
    );
  });
});

describe("MessageHandler — collectDmFreshnessTelemetry", () => {
  let db: Database.Database;
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "pa-msg-handler-"));
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applySchema(db);
  });

  afterEach(() => {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  function insertSession(startedAt: string): number {
    const info = db
      .prepare(
        `INSERT INTO conversation_sessions
           (platform, channel_id, started_at)
         VALUES ('dashboard', 'chan-1', ?)`,
      )
      .run(startedAt);
    return info.lastInsertRowid as number;
  }

  function insertContextWrite(tier: "loud" | "quiet", startedAt: string): void {
    db.prepare(
      `INSERT INTO agent_actions (action_type, detail, started_at)
       VALUES ('context_write', ?, ?)`,
    ).run(JSON.stringify({ tier }), startedAt);
  }

  function insertContextRead(path: string, startedAt: string): void {
    db.prepare(
      `INSERT INTO agent_actions (action_type, detail, started_at)
       VALUES ('context_read', ?, ?)`,
    ).run(JSON.stringify({ path }), startedAt);
  }

  it("counts loud/quiet writes between session-start and turn-start (half-open)", () => {
    const sessionStarted = formatSqliteDatetime(new Date(2026, 0, 1, 10, 0, 0));
    const turnStarted = formatSqliteDatetime(new Date(2026, 0, 1, 11, 0, 0));
    const sessionId = insertSession(sessionStarted);

    insertContextWrite("loud", formatSqliteDatetime(new Date(2026, 0, 1, 10, 5, 0)));
    insertContextWrite("loud", formatSqliteDatetime(new Date(2026, 0, 1, 10, 30, 0)));
    insertContextWrite("quiet", formatSqliteDatetime(new Date(2026, 0, 1, 10, 45, 0)));
    // BEFORE the window — must not be counted
    insertContextWrite("loud", formatSqliteDatetime(new Date(2026, 0, 1, 9, 0, 0)));
    // AFTER turn-start (= upper bound) — must not be counted (window is half-open)
    insertContextWrite("loud", turnStarted);

    const h = buildHandler(db, dataDir);
    const result = h.handler.collectDmFreshnessTelemetry({
      sessionId,
      canResume: true,
      resumeSnapshotAgeMinutes: 45,
      turnStartedAtSqlite: turnStarted,
      userContent: "anything new since lunch?",
    });

    expect(result.resumed).toBe(true);
    expect(result.agentLogLagMinutes).toBe(45);
    expect(result.loudWritesSinceSessionStart).toBe(2);
    expect(result.quietWritesSinceSessionStart).toBe(1);
    expect(result.triggerMatched).toBe(true);
  });

  it("zeroes agentLogLagMinutes when the turn is a fresh execute", () => {
    const turnStarted = formatSqliteDatetime(new Date());
    const sessionId = insertSession(turnStarted);
    const h = buildHandler(db, dataDir);
    const result = h.handler.collectDmFreshnessTelemetry({
      sessionId,
      canResume: false,
      resumeSnapshotAgeMinutes: 99,
      turnStartedAtSqlite: turnStarted,
      userContent: "hello",
    });
    expect(result.resumed).toBe(false);
    // canResume === false → lag forced to 0 regardless of the input
    expect(result.agentLogLagMinutes).toBe(0);
    expect(result.triggerMatched).toBe(false);
  });

  it("detects a today-refetch landing within the turn window", () => {
    const sessionStarted = formatSqliteDatetime(new Date(2026, 0, 1, 10, 0, 0));
    const turnStarted = formatSqliteDatetime(new Date(2026, 0, 1, 11, 0, 0));
    const sessionId = insertSession(sessionStarted);
    insertContextRead("today", formatSqliteDatetime(new Date(2026, 0, 1, 11, 0, 30)));
    const h = buildHandler(db, dataDir);
    const result = h.handler.collectDmFreshnessTelemetry({
      sessionId,
      canResume: true,
      resumeSnapshotAgeMinutes: 60,
      turnStartedAtSqlite: turnStarted,
      userContent: "what did I miss?",
    });
    expect(result.refetchedToday).toBe(true);
  });

  it("falls back to turn-start when conversation_sessions.started_at is NULL", () => {
    // Insert directly so started_at is NULL — the row default is
    // CURRENT_TIMESTAMP, but a NULL is still allowed by the column type.
    const info = db
      .prepare(
        `INSERT INTO conversation_sessions
           (platform, channel_id, started_at)
         VALUES ('dashboard', 'chan-1', NULL)`,
      )
      .run();
    const sessionId = info.lastInsertRowid as number;
    const turnStarted = formatSqliteDatetime(new Date());
    // Insert a loud write timestamped BEFORE the turn-start — without the
    // fallback, the wide-open window would count it; with the fallback,
    // the lower bound collapses to turn-start and the count is 0.
    insertContextWrite(
      "loud",
      formatSqliteDatetime(new Date(Date.now() - 60 * 60 * 1000)),
    );
    const h = buildHandler(db, dataDir);
    const result = h.handler.collectDmFreshnessTelemetry({
      sessionId,
      canResume: true,
      resumeSnapshotAgeMinutes: 0,
      turnStartedAtSqlite: turnStarted,
      userContent: "hi",
    });
    expect(result.loudWritesSinceSessionStart).toBe(0);
    expect(result.quietWritesSinceSessionStart).toBe(0);
  });
});
