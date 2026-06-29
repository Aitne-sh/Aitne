import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";

// PREPASS_COST_REDUCTION_PLAN.md N2 — the dispatcher constructs an
// AutonomousSpawnGate internally, whose default DNS probe would hit the
// real resolver from unit tests. Replace it with a controllable stub:
// permissive by default (skip: false) so every existing dispatch test
// stays hermetic; individual tests override `spawnGateEvaluateMock` to
// exercise the skip path.
const spawnGateEvaluateMock = vi.hoisted(() =>
  vi.fn(async () => ({ skip: false as const, backends: [] })),
);
vi.mock("./spawn-gates.js", () => ({
  AutonomousSpawnGate: class {
    evaluate = spawnGateEvaluateMock;
  },
}));
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createEvent,
  EventPriority,
  getAgentDayDateStr,
  localDateStr,
  type Event,
  type MessageEvent,
  type AgentTaskEvent,
  type AgentResult,
  type CalendarChangeEvent,
  type RoutineEvent,
} from "@aitne/shared";
import { applySchema } from "../db/schema.js";
import { createRepository } from "../db/repositories-store.js";
import { upsertAgent } from "../db/agents-store.js";
import { AuditLogger } from "../safety/audit.js";
import { AgentExecutionRecorder } from "./agent-execution-recorder.js";
import { AgentExecutionTracker } from "./agents/agent-execution-tracker.js";
import { EventBus } from "./event-bus.js";
import { BackendQuotaError, BackendDecisiveFailure } from "./agent-core.js";
import { BackendRouterHandledError } from "./backends/backend-router.js";
import {
  EventDispatcher,
  type IAgentRouter,
  type IContextBuilder,
  type GetTaskFlow,
  type INotificationManager,
  type ISessionManager,
  type IMessageRecorder,
  type IAuditLogger,
} from "./dispatcher.js";
import { getTaskFlow, initTaskFlows } from "./prompts.js";
import { resolveTemplate as _resolveTemplate, extractEventData as _extractEventData } from "./backends/prompt-utils.js";
import type { AgentConfig } from "../config.js";
import { setDegradedMode } from "../db/runtime-state.js";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(TEST_DIR, "..", "..", "..", "..");

initTaskFlows(REPO_ROOT);

function makeResult(overrides: Partial<AgentResult> = {}): AgentResult {
  return {
    output: "test output",
    sessionId: null,
    costUsd: 0.01,
    usage: {
      inputTokens: 100,
      outputTokens: 50,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    },
    modelUsage: {},
    numTurns: 1,
    durationMs: 500,
    durationApiMs: 400,
    model: "sonnet",
    isError: false,
    stopReason: null,
    contextUpdated: false,
    ...overrides,
  };
}

/** Seed a minimal rules/management.md so `isAutonomousAllowed()` returns null.
 *  Tests that exercise autonomous pathways (routines, scheduled tasks,
 *  activity_scan) rely on the setup gate being open; tests that specifically
 *  want to verify gate behavior unlink this file explicitly.
 *
 *  Errors propagate: a silent fallback would leave the gate closed and
 *  cause distant, confusing test failures elsewhere.
 */
function seedManagementRules(dataDir: string): void {
  const contextDir = join(dataDir, "context");
  mkdirSync(join(contextDir, "policies"), { recursive: true });
  const rulesPath = join(contextDir, "policies", "management.md");
  if (!existsSync(rulesPath)) {
    writeFileSync(rulesPath, "# Management Rules\n");
  }
}

const DEFAULT_TEST_DATA_DIR = mkdtempSync(join(tmpdir(), "pa-dispatcher-default-"));
seedManagementRules(DEFAULT_TEST_DATA_DIR);
process.on("exit", () => {
  try {
    rmSync(DEFAULT_TEST_DATA_DIR, { recursive: true, force: true });
  } catch {
    // process is exiting — swallow
  }
});

function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  const config = {
    slackBotToken: null,
    slackAppToken: null,
    telegramBotToken: null,
    discordBotToken: null,
    googleCalendarCredentialsPath: null,
    googleCalendarTokenPath: null,
    googleCalendarId: "primary",
    notionApiKey: null,
    notionDatabaseIds: {},
    dataDir: DEFAULT_TEST_DATA_DIR,
    workspaceDir: ".",
    primaryVaultPath: null,
    primaryVaultName: null,
    externalObsidianVaultPath: null,
    externalObsidianVaultName: null,
    gitRepos: [],
    maxConcurrentSessions: 3,
    maxReactiveSessions: 2,
    executeTimeoutMinutes: 60,
    sessionTimeoutDmMinutes: 60,
    sessionTimeoutChannelMinutes: 30,
    sessionTimeoutDashboardMinutes: 120,
    character: "",
    timezone: "",
    dayBoundaryHour: 4,
    activityScanEnabled: true,
    activityScanIntervalMinutes: 60,
    activityScanActiveStartHour: 4,
    activityScanActiveEndHour: 24,
    activityScanMinObservations: 1,
    schedulePollIntervalSeconds: 5,
    maxBriefingDelayMinutes: 30,
    maxNotificationsPerHour: 3,
    maxNotificationsPerDay: 12,
    quietHoursStart: "23:00",
    quietHoursEnd: "07:00",
    batchIntervalMinutes: 15,
    primaryPlatform: "slack",
    defaultNotificationPlatforms: [],
    disallowedTools: [],
    allowedToolsOverride: null,
    slackOwnerUserId: null,
    telegramOwnerChatId: null,
    discordOwnerUserId: null,
    whatsappEnabled: false,
    whatsappOwnerPhone: null,
    whatsappAuthDir: null,
    githubToken: null,
    githubWebhookSecret: null,
    obsidianDebounceSeconds: 5,
    gitPollIntervalSeconds: 300,
    notionPollIntervalSeconds: 60,
    calendarPollIntervalSeconds: 300,
    apiPort: 8321,
    apiToken: null,
    ...overrides,
  } as unknown as AgentConfig;
  // Setup gate must be OPEN for autonomous-work tests. Any overrides that
  // change dataDir get the same one-line seed applied.
  seedManagementRules(config.dataDir);
  return config;
}

describe("EventDispatcher", () => {
  let db: Database.Database;
  let eventBus: EventBus;
  let mockAgentCore: IAgentRouter;
  let mockContextBuilder: IContextBuilder;
  let mockGetTaskFlow: GetTaskFlow;
  let mockNotificationMgr: INotificationManager;
  let mockSessionMgr: ISessionManager;
  let mockMessageRecorder: IMessageRecorder;
  let mockAudit: IAuditLogger;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applySchema(db);

    // Pre-seed a successful `routine.morning_routine` action for the
    // current agent-day so the pre-routine gate (sleep-skip recovery,
    // see `morningRoutineRanToday`) does not trip in tests that are not
    // specifically exercising it. Tests that want to verify the gate
    // live in dispatcher-activity-scan.test.ts.
    db
      .prepare(
        `INSERT INTO agent_actions
           (event_id, action_type, result, started_at, completed_at)
         VALUES ('seed-morning-routine', 'routine.morning_routine', 'success',
                 datetime('now'), datetime('now'))`,
      )
      .run();

    eventBus = new EventBus();

    mockAgentCore = {
      execute: vi.fn().mockResolvedValue(makeResult()),
      executeResume: vi.fn().mockResolvedValue(makeResult()),
      summarize: vi.fn().mockResolvedValue("Test summary"),
      resolveBinding: vi.fn().mockReturnValue({
        processKey: "dashboard.chat",
        resolvedTier: "heavy",
        main: {
          backendId: "claude",
          modelId: "claude-opus-4-6",
          maxTurns: 15,
          maxBudgetUsd: 2,
        },
        fallback: null,
      }),
    };

    mockContextBuilder = {
      build: vi.fn().mockResolvedValue("test context"),
      buildResumeCatchupContext: vi.fn().mockResolvedValue(null),
      buildScheduledRemindersBlock: vi.fn().mockReturnValue(null),
    };

    mockGetTaskFlow = vi.fn().mockReturnValue("test prompt");

    mockNotificationMgr = {
      send: vi.fn().mockResolvedValue(undefined),
      beginReplyActivity: vi.fn().mockResolvedValue({
        stop: vi.fn().mockResolvedValue(undefined),
      }),
    };

    mockSessionMgr = {
      getOrCreate: vi.fn().mockResolvedValue({
        id: 1,
        isActive: false,
        sessionId: null,
        model: "opus",
      }),
      findActive: vi.fn().mockResolvedValue(null),
      updateSession: vi.fn().mockResolvedValue(undefined),
      markFreshExecuteStart: vi.fn(),
      touchSession: vi.fn(),
      closeSession: vi.fn(),
      closeSessionInTx: vi.fn(),
      newEffectsBuffer: vi.fn().mockReturnValue({}),
      flushEffects: vi.fn(),
      getActiveChannelIdForSession: vi.fn().mockReturnValue(null),
      getDmPlatformsWithNewMessages: vi.fn().mockReturnValue([]),
      getUnsummarizedDmMessages: vi.fn().mockReturnValue([]),
      getPreviousDmSummary: vi.fn().mockReturnValue(null),
      saveDmSummary: vi.fn(),
    };

    mockMessageRecorder = {
      recordMessage: vi.fn().mockReturnValue(true),
    };

    mockAudit = {
      logAction: vi.fn(),
      logSkip: vi.fn(),
      logError: vi.fn(),
      logAttachment: vi.fn(),
      logBangCommand: vi.fn(),
      insertInProgressRow: vi.fn().mockReturnValue(-1),
    };
  });

  afterEach(() => {
    db.close();
  });

  it("classifies DM as reactive", () => {
    const config = makeConfig();
    const dispatcher = new EventDispatcher(
      eventBus,
      mockAgentCore,
      mockContextBuilder,
      mockGetTaskFlow,
      mockNotificationMgr,
      mockSessionMgr,
      mockMessageRecorder,
      mockAudit,
      db,
      config,
    );

    const dmEvent = {
      ...createEvent({
        type: "message.received",
        source: "slack",
        priority: EventPriority.HIGH,
      }),
      sender: "user1",
      channel: "D123",
      content: "hello",
      platform: "slack",
      threadId: null,
      isDm: true,
      isMention: false,
    } as MessageEvent;

    expect(dispatcher.isReactive(dmEvent)).toBe(true);
  });

  it("treats channel message without mention as non-reactive (dropped)", () => {
    const config = makeConfig();
    const dispatcher = new EventDispatcher(
      eventBus,
      mockAgentCore,
      mockContextBuilder,
      mockGetTaskFlow,
      mockNotificationMgr,
      mockSessionMgr,
      mockMessageRecorder,
      mockAudit,
      db,
      config,
    );

    const channelEvent = {
      ...createEvent({
        type: "message.received",
        source: "slack",
        priority: EventPriority.NORMAL,
      }),
      sender: "user1",
      channel: "C123",
      content: "hello team",
      platform: "slack",
      threadId: null,
      isDm: false,
      isMention: false,
    } as MessageEvent;

    expect(dispatcher.isReactive(channelEvent)).toBe(false);
  });

  it("classifies CRITICAL events as reactive", () => {
    const config = makeConfig();
    const dispatcher = new EventDispatcher(
      eventBus,
      mockAgentCore,
      mockContextBuilder,
      mockGetTaskFlow,
      mockNotificationMgr,
      mockSessionMgr,
      mockMessageRecorder,
      mockAudit,
      db,
      config,
    );

    const criticalEvent = createEvent({
      type: "test.critical",
      source: "obsidian",
      priority: EventPriority.CRITICAL,
    });

    expect(dispatcher.isReactive(criticalEvent)).toBe(true);
  });

  it("dispatches the first-run (no-yesterday) morning routine via the orchestrator's Stage A process key", async () => {
    // Phase 4 variant collapse + Phase 5/6/7 V2-only:
    // both day-types (first-run / recurring) flow into the orchestrator
    // and dispatch as `routine.morning_routine_today` (Stage A) +
    // `routine.morning_routine_journal` (Stage B). The first-run branch
    // is an in-prompt decision, not a per-key fork.
    const config = makeConfig();
    const dispatcher = new EventDispatcher(
      eventBus,
      mockAgentCore,
      mockContextBuilder,
      mockGetTaskFlow,
      mockNotificationMgr,
      mockSessionMgr,
      mockMessageRecorder,
      mockAudit,
      db,
      config,
    );

    const runPromise = dispatcher.run();

    const routineEvent = {
      ...createEvent({
        type: "routine.morning_routine",
        source: "cron",
        priority: EventPriority.NORMAL,
      }),
      routine: "morning_routine",
    };
    await eventBus.put(routineEvent);

    await new Promise((r) => setTimeout(r, 50));
    dispatcher.stop();

    // Stage A is the today.md author; its agentRouter.execute call is
    // what the operator's morning_routine binding ultimately drives.
    expect(mockAgentCore.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        processKey: "routine.morning_routine_today",
      }),
    );
    // No tier-inheritance hack: non-retry runs leave `requestedTier`
    // undefined so the BackendRouter resolves the seed/preset binding
    // for `routine.morning_routine_today` directly.
    const stageACall = (mockAgentCore.execute as ReturnType<typeof vi.fn>).mock.calls.find(
      (c: unknown[]) => (c[0] as { processKey?: string }).processKey === "routine.morning_routine_today",
    )?.[0] as { requestedTier?: string };
    expect(stageACall?.requestedTier).toBeUndefined();

    await eventBus.put(
      createEvent({
        type: "dummy",
        source: "test",
        priority: EventPriority.LOW,
      }),
    );
    await Promise.race([runPromise, new Promise((r) => setTimeout(r, 100))]);
  });

  it("forces medium tier (Sonnet) on morning_routine retries", async () => {
    // Cost cap: a wrong-date or malformed today.md is cheap to regenerate
    // — heavy work (mail / journal / roadmap) was already persisted by the
    // first attempt. Retries on Sonnet drop the worst-case 3-attempt chain
    // from ~$12 to ~$2. See morning-routine fix.
    const config = makeConfig();
    const dispatcher = new EventDispatcher(
      eventBus,
      mockAgentCore,
      mockContextBuilder,
      mockGetTaskFlow,
      mockNotificationMgr,
      mockSessionMgr,
      mockMessageRecorder,
      mockAudit,
      db,
      config,
    );

    const runPromise = dispatcher.run();

    const retryEvent = {
      ...createEvent({
        type: "routine.morning_routine",
        source: "morning_routine_retry_1",
        priority: EventPriority.NORMAL,
        data: { retryCount: 1, isRetry: true },
      }),
      routine: "morning_routine",
    };
    await eventBus.put(retryEvent);

    await new Promise((r) => setTimeout(r, 50));
    dispatcher.stop();

    // Stage A receives the `requestedTier: "medium"` override on retry;
    // Stage B always runs on its lite-tier default (the orchestrator
    // does not forward `requestedTier` into Stage B).
    expect(mockAgentCore.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        processKey: "routine.morning_routine_today",
        requestedTier: "medium",
      }),
    );

    await eventBus.put(
      createEvent({ type: "dummy", source: "test", priority: EventPriority.LOW }),
    );
    await Promise.race([runPromise, new Promise((r) => setTimeout(r, 100))]);
  });

  it("routes scheduled task with requestedModel=sonnet to Sonnet tier", async () => {
    const config = makeConfig();
    const dispatcher = new EventDispatcher(
      eventBus,
      mockAgentCore,
      mockContextBuilder,
      mockGetTaskFlow,
      mockNotificationMgr,
      mockSessionMgr,
      mockMessageRecorder,
      mockAudit,
      db,
      config,
    );

    const runPromise = dispatcher.run();

    const taskEvent = {
      ...createEvent({
        type: "scheduled.task",
        source: "wake",
        priority: EventPriority.NORMAL,
      }),
      task: "sonnet task",
      taskContext: {},
      requestedModel: "sonnet" as const,
    } as AgentTaskEvent;
    await eventBus.put(taskEvent);

    await new Promise((r) => setTimeout(r, 50));
    dispatcher.stop();

    expect(mockAgentCore.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        processKey: "agent.task",
        requestedTier: "medium",
      }),
    );

    await eventBus.put(
      createEvent({ type: "dummy", source: "test", priority: EventPriority.LOW }),
    );
    await Promise.race([runPromise, new Promise((r) => setTimeout(r, 100))]);
  });

  it("routes scheduled task with requestedModel=opus to Opus tier", async () => {
    const config = makeConfig();
    const dispatcher = new EventDispatcher(
      eventBus,
      mockAgentCore,
      mockContextBuilder,
      mockGetTaskFlow,
      mockNotificationMgr,
      mockSessionMgr,
      mockMessageRecorder,
      mockAudit,
      db,
      config,
    );

    const runPromise = dispatcher.run();

    const taskEvent = {
      ...createEvent({
        type: "scheduled.task",
        source: "wake",
        priority: EventPriority.NORMAL,
      }),
      task: "opus task",
      taskContext: {},
      requestedModel: "opus" as const,
    } as AgentTaskEvent;
    await eventBus.put(taskEvent);

    await new Promise((r) => setTimeout(r, 50));
    dispatcher.stop();

    expect(mockAgentCore.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        processKey: "agent.task",
        requestedTier: "high",
      }),
    );

    await eventBus.put(
      createEvent({ type: "dummy", source: "test", priority: EventPriority.LOW }),
    );
    await Promise.race([runPromise, new Promise((r) => setTimeout(r, 100))]);
  });

  it("handles scheduled git project init tasks with the direct markdown writer", async () => {
    const root = mkdtempSync(join(tmpdir(), "pa-dispatcher-git-project-"));
    const repoDir = join(root, "repo");
    mkdirSync(repoDir, { recursive: true });
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repoDir });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repoDir });
    execFileSync("git", ["config", "user.name", "Test User"], { cwd: repoDir });
    writeFileSync(join(repoDir, "README.md"), "# Widgets\n", "utf-8");
    execFileSync("git", ["add", "README.md"], { cwd: repoDir });
    execFileSync("git", ["commit", "-q", "-m", "Initial commit"], {
      cwd: repoDir,
      env: {
        ...process.env,
        GIT_AUTHOR_DATE: "2026-05-07T10:00:00Z",
        GIT_COMMITTER_DATE: "2026-05-07T10:00:00Z",
      },
    });
    const repo = createRepository(db, {
      githubOwner: "acme",
      githubRepo: "widgets",
      localPath: repoDir,
      displayName: "Widgets",
      classification: "project",
      category: "work",
    });
    const config = makeConfig({ dataDir: root, workspaceDir: REPO_ROOT });
    const dispatcher = new EventDispatcher(
      eventBus,
      mockAgentCore,
      mockContextBuilder,
      mockGetTaskFlow,
      mockNotificationMgr,
      mockSessionMgr,
      mockMessageRecorder,
      mockAudit,
      db,
      config,
    );

    try {
      const runPromise = dispatcher.run();

      const taskEvent = {
        ...createEvent({
          type: "scheduled.task",
          source: "git.project.init",
          priority: EventPriority.NORMAL,
        }),
        task: "initialize git project documentation",
        taskContext: {
          processKey: "git.project.init",
          repositoryId: repo.id,
          slug: repo.slug,
          localPath: repoDir,
          githubRepo: "acme/widgets",
          classification: "project",
          category: "work",
        },
      } as AgentTaskEvent;
      await eventBus.put(taskEvent);

      await new Promise((r) => setTimeout(r, 50));
      dispatcher.stop();

      expect(mockAgentCore.execute).not.toHaveBeenCalled();
      expect(mockGetTaskFlow).not.toHaveBeenCalledWith(
        "git.project.init",
        expect.any(String),
        expect.any(Object),
      );
      expect(
        readFileSync(
          join(root, "context", "knowledge", "repos", "widgets", "overview.md"),
          "utf-8",
        ),
      ).toContain("Initial commit");

      await eventBus.put(
        createEvent({ type: "dummy", source: "test", priority: EventPriority.LOW }),
      );
      await Promise.race([runPromise, new Promise((r) => setTimeout(r, 100))]);
    } finally {
      dispatcher.stop();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("repository trigger runs use the literal prompt and temp instruction file", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "pa-repo-run-"));
    const config = makeConfig({ dataDir, workspaceDir: REPO_ROOT });
    vi.mocked(mockAgentCore.resolveBinding).mockReturnValue({
      processKey: "agent.task",
      resolvedTier: "medium",
      main: {
        backendId: "claude",
        modelId: "claude-sonnet-test",
        maxTurns: 15,
        maxBudgetUsd: 1,
      },
      fallback: null,
    });
    let observedSessionDir: string | undefined;
    mockAgentCore.execute = vi.fn().mockImplementation(async (params) => {
      observedSessionDir = params.sessionDir;
      expect(params.prompt).toContain("## User Prompt\nReview the failing workflow");
      expect(params.prompt).toContain("Repository id: github:test-owner/aitne");
      expect(params.prompt).toContain("<trigger_event_payload>");
      expect(params.context).toBe("test context");
      expect(readFileSync(join(params.sessionDir!, "CLAUDE.md"), "utf-8"))
        .toBe("custom trigger instructions");
      return makeResult({ output: "" });
    });
    const dispatcher = new EventDispatcher(
      eventBus,
      mockAgentCore,
      mockContextBuilder,
      mockGetTaskFlow,
      mockNotificationMgr,
      mockSessionMgr,
      mockMessageRecorder,
      mockAudit,
      db,
      config,
    );

    const runPromise = dispatcher.run();
    const taskEvent = {
      ...createEvent({
        type: "scheduled.task",
        source: "trigger-dispatch",
        priority: EventPriority.HIGH,
      }),
      task: "Trigger run",
      taskContext: {
        triggerSource: "repository_trigger",
        processKey: "agent.task",
        repositoryId: "github:test-owner/aitne",
        slug: "test-owner-aitne",
        localPath: null,
        githubRepo: "test-owner/aitne",
        workdirMode: "temp",
        prompt: "Review the failing workflow",
        instructionMd: "custom trigger instructions",
        timeoutMinutes: null,
        triggerId: "trg_1",
        triggerName: "CI fix",
        triggerEventType: "github.workflow_run.failed",
        triggerEventPayload: { branch: "main" },
      },
      requestedBackendId: "claude",
      requestedModelId: "claude-sonnet-test",
    } as AgentTaskEvent;
    await eventBus.put(taskEvent);

    await new Promise((r) => setTimeout(r, 50));
    dispatcher.stop();

    expect(mockGetTaskFlow).not.toHaveBeenCalled();
    expect(mockAgentCore.resolveBinding).toHaveBeenCalledWith(
      expect.objectContaining({ type: "scheduled.task" }),
      expect.objectContaining({
        processKey: "agent.task",
        requestedBackendId: "claude",
        requestedModelId: "claude-sonnet-test",
      }),
    );
    expect(observedSessionDir).toContain(join(dataDir, "run"));
    expect(existsSync(observedSessionDir!)).toBe(false);

    await eventBus.put(
      createEvent({ type: "dummy", source: "test", priority: EventPriority.LOW }),
    );
    await Promise.race([runPromise, new Promise((r) => setTimeout(r, 100))]);
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("marks scheduled task as completed via scheduleId", async () => {
    const config = makeConfig();
    const dispatcher = new EventDispatcher(
      eventBus,
      mockAgentCore,
      mockContextBuilder,
      mockGetTaskFlow,
      mockNotificationMgr,
      mockSessionMgr,
      mockMessageRecorder,
      mockAudit,
      db,
      config,
    );

    // Insert a wake-up task (no correlation_id) and set it to 'running'
    db.prepare(
      "INSERT INTO agent_schedule (scheduled_for, task_type, task_description, model, status) VALUES (datetime('now'), 'wake', 'test wake', 'sonnet', 'running')",
    ).run();

    const runPromise = dispatcher.run();

    const taskEvent = {
      ...createEvent({
        type: "scheduled.task",
        source: "wake",
        priority: EventPriority.NORMAL,
      }),
      task: "test wake",
      taskContext: {},
      scheduleId: 1,
    } as AgentTaskEvent;
    await eventBus.put(taskEvent);

    await new Promise((r) => setTimeout(r, 50));
    dispatcher.stop();

    // The task should now be 'completed'
    const row = db.prepare("SELECT status FROM agent_schedule WHERE id = 1").get() as { status: string };
    expect(row.status).toBe("completed");

    await eventBus.put(
      createEvent({ type: "dummy", source: "test", priority: EventPriority.LOW }),
    );
    await Promise.race([runPromise, new Promise((r) => setTimeout(r, 100))]);
  });

  it("marks scheduled task as failed when agent returns isError", async () => {
    const config = makeConfig();
    mockAgentCore.execute = vi.fn().mockResolvedValue(
      makeResult({ isError: true, output: "" }),
    );
    const dispatcher = new EventDispatcher(
      eventBus,
      mockAgentCore,
      mockContextBuilder,
      mockGetTaskFlow,
      mockNotificationMgr,
      mockSessionMgr,
      mockMessageRecorder,
      mockAudit,
      db,
      config,
    );

    db.prepare(
      "INSERT INTO agent_schedule (scheduled_for, task_type, task_description, model, status) VALUES (datetime('now'), 'wake', 'failing task', 'sonnet', 'running')",
    ).run();

    const runPromise = dispatcher.run();

    const taskEvent = {
      ...createEvent({
        type: "scheduled.task",
        source: "wake",
        priority: EventPriority.NORMAL,
      }),
      task: "failing task",
      taskContext: {},
      scheduleId: 1,
    } as AgentTaskEvent;
    await eventBus.put(taskEvent);

    await new Promise((r) => setTimeout(r, 50));
    dispatcher.stop();

    const row = db.prepare("SELECT status FROM agent_schedule WHERE id = 1").get() as { status: string };
    expect(row.status).toBe("failed");

    await eventBus.put(
      createEvent({ type: "dummy", source: "test", priority: EventPriority.LOW }),
    );
    await Promise.race([runPromise, new Promise((r) => setTimeout(r, 100))]);
  });

  it("notify-dedup: scheduled.task skips final-text DM forward when markEventNotified was called for the correlationId", async () => {
    // Reproduces the duplicate-notification bug: a single scheduled.task
    // run that called POST /api/notify must NOT also fire the implicit
    // "final assistant text → DM" forward in processResult. The API
    // layer signals this via dispatcher.markEventNotified(correlationId).
    const config = makeConfig();
    const dispatcher = new EventDispatcher(
      eventBus,
      mockAgentCore,
      mockContextBuilder,
      mockGetTaskFlow,
      mockNotificationMgr,
      mockSessionMgr,
      mockMessageRecorder,
      mockAudit,
      db,
      config,
    );

    // Stub agent.execute to mimic the agent calling /api/notify mid-run
    // (which the route handler translates into markEventNotified) and
    // also returning a non-empty closing turn.
    mockAgentCore.execute = vi.fn().mockImplementation(async (params: { event: { correlationId: string } }) => {
      dispatcher.markEventNotified(params.event.correlationId);
      return makeResult({ output: "the final assistant turn — would be a duplicate DM" });
    });

    db.prepare(
      "INSERT INTO agent_schedule (scheduled_for, task_type, task_description, model, status) VALUES (datetime('now'), 'wake', 'reminder', 'sonnet', 'running')",
    ).run();

    const runPromise = dispatcher.run();

    const taskEvent = {
      ...createEvent({
        type: "scheduled.task",
        source: "wake",
        priority: EventPriority.NORMAL,
      }),
      task: "reminder",
      taskContext: {},
      scheduleId: 1,
    } as AgentTaskEvent;
    await eventBus.put(taskEvent);

    await new Promise((r) => setTimeout(r, 80));
    dispatcher.stop();

    // The implicit final-text DM forward must be suppressed.
    expect(mockNotificationMgr.send).not.toHaveBeenCalled();

    // Schedule row still completes — dedup only suppresses the DM
    // forward, not the bookkeeping.
    const row = db
      .prepare("SELECT status FROM agent_schedule WHERE id = 1")
      .get() as { status: string };
    expect(row.status).toBe("completed");

    await eventBus.put(
      createEvent({ type: "dummy", source: "test", priority: EventPriority.LOW }),
    );
    await Promise.race([runPromise, new Promise((r) => setTimeout(r, 100))]);
  });

  it("notify-dedup: marker is single-use — a subsequent event with a fresh correlationId still forwards the final text", async () => {
    // The dedup marker is consumed (Set.delete) by processResult, so a
    // later event with a brand-new correlationId is unaffected. This
    // protects against an over-broad fix that would silently silence
    // every scheduled task.
    const config = makeConfig();
    const dispatcher = new EventDispatcher(
      eventBus,
      mockAgentCore,
      mockContextBuilder,
      mockGetTaskFlow,
      mockNotificationMgr,
      mockSessionMgr,
      mockMessageRecorder,
      mockAudit,
      db,
      config,
    );

    // Pre-mark a stale correlationId that has nothing to do with the
    // upcoming event. processResult must not cross-suppress.
    dispatcher.markEventNotified("stale-correlation-id-from-other-run");

    mockAgentCore.execute = vi.fn().mockResolvedValue(
      makeResult({ output: "fresh final-text reminder" }),
    );

    db.prepare(
      "INSERT INTO agent_schedule (scheduled_for, task_type, task_description, model, status) VALUES (datetime('now'), 'wake', 'reminder', 'sonnet', 'running')",
    ).run();

    const runPromise = dispatcher.run();

    const taskEvent = {
      ...createEvent({
        type: "scheduled.task",
        source: "wake",
        priority: EventPriority.NORMAL,
      }),
      task: "reminder",
      taskContext: {},
      scheduleId: 1,
    } as AgentTaskEvent;
    await eventBus.put(taskEvent);

    await new Promise((r) => setTimeout(r, 80));
    dispatcher.stop();

    // The new event has its own fresh correlationId, so the implicit
    // final-text forward fires normally.
    expect(mockNotificationMgr.send).toHaveBeenCalledWith(
      "fresh final-text reminder",
      expect.objectContaining({ type: "scheduled.task" }),
    );

    await eventBus.put(
      createEvent({ type: "dummy", source: "test", priority: EventPriority.LOW }),
    );
    await Promise.race([runPromise, new Promise((r) => setTimeout(r, 100))]);
  });

  it("scheduled.dm flows through executeScheduledTask and notifies on completion", async () => {
    // SCHEDULED-DM-IMPLEMENTATION-PLAN §3.6 / §5.6 — scheduled.dm
    // resolves to agent.dm_task, runs through the same
    // executeScheduledTask helper as scheduled.task, marks the row
    // completed, and triggers DM notification (final assistant turn IS
    // the DM).
    const config = makeConfig();
    const dispatcher = new EventDispatcher(
      eventBus,
      mockAgentCore,
      mockContextBuilder,
      mockGetTaskFlow,
      mockNotificationMgr,
      mockSessionMgr,
      mockMessageRecorder,
      mockAudit,
      db,
      config,
    );

    db.prepare(
      "INSERT INTO agent_schedule (scheduled_for, task_type, task_description, model, status) VALUES (datetime('now'), 'dm_session', 'morning briefing — 2026-04-26', 'sonnet', 'running')",
    ).run();

    const runPromise = dispatcher.run();

    const dmEvent = {
      ...createEvent({
        type: "scheduled.dm",
        source: "dm_session",
        priority: EventPriority.NORMAL,
      }),
      task: "morning briefing — 2026-04-26",
      taskContext: { sub_flow: "morning_briefing" },
      scheduleId: 1,
    } as AgentTaskEvent;
    await eventBus.put(dmEvent);

    await new Promise((r) => setTimeout(r, 80));
    dispatcher.stop();

    expect(mockAgentCore.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        processKey: "agent.dm_task",
      }),
    );
    expect(mockNotificationMgr.send).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ type: "scheduled.dm" }),
    );

    const row = db
      .prepare("SELECT status FROM agent_schedule WHERE id = 1")
      .get() as { status: string };
    expect(row.status).toBe("completed");

    await eventBus.put(
      createEvent({ type: "dummy", source: "test", priority: EventPriority.LOW }),
    );
    await Promise.race([runPromise, new Promise((r) => setTimeout(r, 100))]);
  });

  it("scheduled.dm — waits for DASHBOARD_CHAT_SCOPE gate to release before invoking executeScheduledTask", async () => {
    // SCHEDULED-DM-IMPLEMENTATION-PLAN §3.6 — dual-scope
    // serialization. Hold a synthetic gate on
    // `dashboard_chat:dashboard` open while a scheduled.dm event is
    // dispatched; assert the agent core is NOT called until the held
    // gate releases. Without the §3.6 wiring, the briefing would
    // run concurrently and the assertion at "still pending" would
    // fail.
    const config = makeConfig({ maxBriefingDelayMinutes: 1440 });
    const dispatcher = new EventDispatcher(
      eventBus,
      mockAgentCore,
      mockContextBuilder,
      mockGetTaskFlow,
      mockNotificationMgr,
      mockSessionMgr,
      mockMessageRecorder,
      mockAudit,
      db,
      config,
    );

    db.prepare(
      "INSERT INTO agent_schedule (scheduled_for, task_type, task_description, model, status) VALUES (datetime('now'), 'dm_session', 'morning briefing — gate test', 'sonnet', 'running')",
    ).run();

    // Reach into the private SessionGateRegistry to hold the
    // dashboard scope's gate open. The dispatcher exposes
    // `getInFlightExecutions()` which proves the gate is observable;
    // grabbing it directly from the field is a defensible test seam
    // because the contract under test is *that the gate is held*,
    // independent of WHO held it.
    const sessionGates = (dispatcher as unknown as {
      sessionGates: import("./session-gate.js").SessionGateRegistry;
    }).sessionGates;

    let releaseHeldGate!: () => void;
    const heldGate = new Promise<void>((resolve) => {
      releaseHeldGate = resolve;
    });
    const holderPromise = sessionGates.runWithSessionGate(
      "dashboard_chat:dashboard",
      async () => {
        await heldGate;
      },
    );

    const runPromise = dispatcher.run();

    const dmEvent = {
      ...createEvent({
        type: "scheduled.dm",
        source: "dm_session",
        priority: EventPriority.NORMAL,
      }),
      task: "morning briefing — gate test",
      taskContext: {},
      scheduleId: 1,
    } as AgentTaskEvent;
    await eventBus.put(dmEvent);

    // Allow the dispatcher to dequeue + start dispatch. The
    // scheduled.dm path must now be parked on the dashboard gate.
    await new Promise((r) => setTimeout(r, 80));
    expect(mockAgentCore.execute).not.toHaveBeenCalled();

    // Release the held gate — briefing now proceeds.
    releaseHeldGate();
    await holderPromise;
    await new Promise((r) => setTimeout(r, 80));
    expect(mockAgentCore.execute).toHaveBeenCalledWith(
      expect.objectContaining({ processKey: "agent.dm_task" }),
    );

    dispatcher.stop();
    await eventBus.put(
      createEvent({ type: "dummy", source: "test", priority: EventPriority.LOW }),
    );
    await Promise.race([runPromise, new Promise((r) => setTimeout(r, 100))]);
  });

  it("scheduled.dm — also waits on the OWNER_DM_SCOPE gate (regression: both scopes must be in the gate set)", async () => {
    // Sibling of the DASHBOARD_CHAT test: a regression that dropped
    // `owner_dm:owner` from the gate array would silently pass the
    // dashboard-only test (the dispatcher would still serialize behind
    // dashboard_chat). Holding owner_dm here forces the briefing's
    // inner gate acquisition to park; if the array were single-scope
    // and only contained dashboard_chat, the briefing would proceed
    // immediately and mockAgentCore.execute would be called before we
    // release.
    const config = makeConfig({ maxBriefingDelayMinutes: 1440 });
    const dispatcher = new EventDispatcher(
      eventBus,
      mockAgentCore,
      mockContextBuilder,
      mockGetTaskFlow,
      mockNotificationMgr,
      mockSessionMgr,
      mockMessageRecorder,
      mockAudit,
      db,
      config,
    );

    db.prepare(
      "INSERT INTO agent_schedule (scheduled_for, task_type, task_description, model, status) VALUES (datetime('now'), 'dm_session', 'morning briefing — owner gate test', 'sonnet', 'running')",
    ).run();

    const sessionGates = (dispatcher as unknown as {
      sessionGates: import("./session-gate.js").SessionGateRegistry;
    }).sessionGates;

    let releaseHeldGate!: () => void;
    const heldGate = new Promise<void>((resolve) => {
      releaseHeldGate = resolve;
    });
    const holderPromise = sessionGates.runWithSessionGate(
      "owner_dm:owner",
      async () => {
        await heldGate;
      },
    );

    const runPromise = dispatcher.run();

    const dmEvent = {
      ...createEvent({
        type: "scheduled.dm",
        source: "dm_session",
        priority: EventPriority.NORMAL,
      }),
      task: "morning briefing — owner gate test",
      taskContext: {},
      scheduleId: 1,
    } as AgentTaskEvent;
    await eventBus.put(dmEvent);

    await new Promise((r) => setTimeout(r, 80));
    expect(mockAgentCore.execute).not.toHaveBeenCalled();

    // While parked, BOTH gate keys should be observable via
    // getInFlightExecutions() — the briefing has acquired the
    // lex-first gate (`dashboard_chat:dashboard`) and is awaiting the
    // second (`owner_dm:owner`). This locks down the gate-set
    // composition: the test fails if the array drops either scope.
    const inFlightKeys = dispatcher
      .getInFlightExecutions()
      .filter((e): e is { kind: "session_chain"; key: string } =>
        e.kind === "session_chain" && typeof e.key === "string",
      )
      .map((e) => e.key);
    expect(inFlightKeys).toContain("owner_dm:owner");
    expect(inFlightKeys).toContain("dashboard_chat:dashboard");

    releaseHeldGate();
    await holderPromise;
    await new Promise((r) => setTimeout(r, 80));
    expect(mockAgentCore.execute).toHaveBeenCalledWith(
      expect.objectContaining({ processKey: "agent.dm_task" }),
    );

    dispatcher.stop();
    await eventBus.put(
      createEvent({ type: "dummy", source: "test", priority: EventPriority.LOW }),
    );
    await Promise.race([runPromise, new Promise((r) => setTimeout(r, 100))]);
  });

  it("scheduled.dm — drops the briefing when gate-acquisition exceeds maxBriefingDelayMinutes", async () => {
    // §3.6.1 max-wait — a row scheduled 31 minutes ago with a 30-min
    // budget must be marked `skipped` and never reach the agent core.
    const config = makeConfig({ maxBriefingDelayMinutes: 30 });
    const dispatcher = new EventDispatcher(
      eventBus,
      mockAgentCore,
      mockContextBuilder,
      mockGetTaskFlow,
      mockNotificationMgr,
      mockSessionMgr,
      mockMessageRecorder,
      mockAudit,
      db,
      config,
    );

    db.prepare(
      "INSERT INTO agent_schedule (scheduled_for, task_type, task_description, model, status) VALUES (datetime('now', '-31 minutes'), 'dm_session', 'morning briefing — late', 'sonnet', 'running')",
    ).run();

    const runPromise = dispatcher.run();

    const dmEvent = {
      ...createEvent({
        type: "scheduled.dm",
        source: "dm_session",
        priority: EventPriority.NORMAL,
      }),
      task: "morning briefing — late",
      taskContext: {},
      scheduleId: 1,
    } as AgentTaskEvent;
    await eventBus.put(dmEvent);

    await new Promise((r) => setTimeout(r, 60));
    dispatcher.stop();

    expect(mockAgentCore.execute).not.toHaveBeenCalled();
    expect(mockNotificationMgr.send).not.toHaveBeenCalled();
    const row = db
      .prepare("SELECT status FROM agent_schedule WHERE id = 1")
      .get() as { status: string };
    expect(row.status).toBe("skipped");

    await eventBus.put(
      createEvent({ type: "dummy", source: "test", priority: EventPriority.LOW }),
    );
    await Promise.race([runPromise, new Promise((r) => setTimeout(r, 100))]);
  });

  it("marks scheduled task as failed on exception", async () => {
    const config = makeConfig();
    mockAgentCore.execute = vi.fn().mockRejectedValue(new Error("agent crash"));
    const dispatcher = new EventDispatcher(
      eventBus,
      mockAgentCore,
      mockContextBuilder,
      mockGetTaskFlow,
      mockNotificationMgr,
      mockSessionMgr,
      mockMessageRecorder,
      mockAudit,
      db,
      config,
    );

    db.prepare(
      "INSERT INTO agent_schedule (scheduled_for, task_type, task_description, model, status) VALUES (datetime('now'), 'wake', 'crashing task', 'sonnet', 'running')",
    ).run();

    const runPromise = dispatcher.run();

    const taskEvent = {
      ...createEvent({
        type: "scheduled.task",
        source: "wake",
        priority: EventPriority.NORMAL,
      }),
      task: "crashing task",
      taskContext: {},
      scheduleId: 1,
    } as AgentTaskEvent;
    await eventBus.put(taskEvent);

    await new Promise((r) => setTimeout(r, 50));
    dispatcher.stop();

    const row = db.prepare("SELECT status FROM agent_schedule WHERE id = 1").get() as { status: string };
    expect(row.status).toBe("failed");

    await eventBus.put(
      createEvent({ type: "dummy", source: "test", priority: EventPriority.LOW }),
    );
    await Promise.race([runPromise, new Promise((r) => setTimeout(r, 100))]);
  });

  it("uses dm_first prompt for first DM message of the day", async () => {
    const config = makeConfig();
    // New session (isActive: false) — first message of the day
    vi.mocked(mockSessionMgr.getOrCreate).mockResolvedValue({
      id: 1,
      isActive: false,
      sessionId: null,
      model: "opus",
    });

    const dispatcher = new EventDispatcher(
      eventBus,
      mockAgentCore,
      mockContextBuilder,
      mockGetTaskFlow,
      mockNotificationMgr,
      mockSessionMgr,
      mockMessageRecorder,
      mockAudit,
      db,
      config,
    );

    const runPromise = dispatcher.run();

    const dmEvent = {
      ...createEvent({
        type: "message.received",
        source: "dashboard",
        priority: EventPriority.HIGH,
      }),
      sender: "user",
      channel: "ch1",
      content: "good morning",
      platform: "dashboard",
      threadId: null,
      isDm: true,
      isMention: false,
    } as MessageEvent;
    await eventBus.put(dmEvent);

    await new Promise((r) => setTimeout(r, 50));
    dispatcher.stop();

    expect(mockGetTaskFlow).toHaveBeenCalledWith("message.received.dm_first", "claude", expect.any(Object));

    await eventBus.put(
      createEvent({ type: "dummy", source: "test", priority: EventPriority.LOW }),
    );
    await Promise.race([runPromise, new Promise((r) => setTimeout(r, 100))]);
  });

  it("starts and stops reply activity while a DM is being processed", async () => {
    const config = makeConfig();
    const stop = vi.fn().mockResolvedValue(undefined);
    vi.mocked(mockNotificationMgr.beginReplyActivity).mockResolvedValue({ stop });
    vi.mocked(mockSessionMgr.getOrCreate).mockResolvedValue({
      id: 1,
      isActive: false,
      sessionId: null,
      model: "opus",
    });

    const dispatcher = new EventDispatcher(
      eventBus,
      mockAgentCore,
      mockContextBuilder,
      mockGetTaskFlow,
      mockNotificationMgr,
      mockSessionMgr,
      mockMessageRecorder,
      mockAudit,
      db,
      config,
    );

    const runPromise = dispatcher.run();

    const dmEvent = {
      ...createEvent({
        type: "message.received",
        source: "whatsapp",
        priority: EventPriority.HIGH,
      }),
      sender: "818012345678@s.whatsapp.net",
      channel: "818012345678@s.whatsapp.net",
      content: "ping",
      platform: "whatsapp",
      threadId: null,
      isDm: true,
      isMention: false,
    } as MessageEvent;
    await eventBus.put(dmEvent);

    await new Promise((r) => setTimeout(r, 50));
    dispatcher.stop();

    expect(mockNotificationMgr.beginReplyActivity).toHaveBeenCalledWith(dmEvent);
    expect(stop).toHaveBeenCalledTimes(1);

    await eventBus.put(
      createEvent({ type: "dummy", source: "test", priority: EventPriority.LOW }),
    );
    await Promise.race([runPromise, new Promise((r) => setTimeout(r, 100))]);
  });

  it("creates the first DM session workdir with context skill available", async () => {
    const tempDataDir = mkdtempSync(join(tmpdir(), "pa-dispatch-dm-"));
    const config = makeConfig({ dataDir: tempDataDir, workspaceDir: REPO_ROOT });
    vi.mocked(mockSessionMgr.getOrCreate).mockResolvedValue({
      id: 99,
      isActive: false,
      sessionId: null,
      model: "opus",
    });

    const dispatcher = new EventDispatcher(
      eventBus,
      mockAgentCore,
      mockContextBuilder,
      mockGetTaskFlow,
      mockNotificationMgr,
      mockSessionMgr,
      mockMessageRecorder,
      mockAudit,
      db,
      config,
    );

    const runPromise = dispatcher.run();

    const dmEvent = {
      ...createEvent({
        type: "message.received",
        source: "dashboard",
        priority: EventPriority.HIGH,
      }),
      sender: "user",
      channel: "ch1",
      content: "update today please",
      platform: "dashboard",
      threadId: null,
      isDm: true,
      isMention: false,
    } as MessageEvent;
    await eventBus.put(dmEvent);

    await new Promise((r) => setTimeout(r, 50));
    dispatcher.stop();

    const executeArgs = vi.mocked(mockAgentCore.execute).mock.calls.at(-1)?.[0];
    expect(executeArgs?.sessionDir).toBeTruthy();
    expect(
      existsSync(join(executeArgs!.sessionDir!, ".claude", "skills", "context", "SKILL.md")),
    ).toBe(true);

    await eventBus.put(
      createEvent({ type: "dummy", source: "test", priority: EventPriority.LOW }),
    );
    await Promise.race([runPromise, new Promise((r) => setTimeout(r, 100))]);

    rmSync(tempDataDir, { recursive: true, force: true });
  });

  it("persists the Claude session for the first normal DM", async () => {
    const config = makeConfig();
    vi.mocked(mockSessionMgr.getOrCreate).mockResolvedValue({
      id: 1,
      isActive: false,
      sessionId: null,
      model: "opus",
    });
    vi.mocked(mockAgentCore.execute).mockResolvedValue(
      makeResult({ sessionId: "sdk-session-1", model: "opus" }),
    );

    const dispatcher = new EventDispatcher(
      eventBus,
      mockAgentCore,
      mockContextBuilder,
      mockGetTaskFlow,
      mockNotificationMgr,
      mockSessionMgr,
      mockMessageRecorder,
      mockAudit,
      db,
      config,
    );

    const runPromise = dispatcher.run();

    const dmEvent = {
      ...createEvent({
        type: "message.received",
        source: "dashboard",
        priority: EventPriority.HIGH,
      }),
      sender: "user",
      channel: "ch1",
      content: "first DM",
      platform: "dashboard",
      threadId: null,
      isDm: true,
      isMention: false,
    } as MessageEvent;
    await eventBus.put(dmEvent);

    await new Promise((r) => setTimeout(r, 50));
    dispatcher.stop();

    expect(mockAgentCore.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        processKey: "dashboard.chat",
        persistSession: true,
      }),
      undefined,
    );
    expect(mockSessionMgr.updateSession).toHaveBeenCalledWith(
      1,
      "sdk-session-1",
      "opus",
      undefined,
    );

    await eventBus.put(
      createEvent({ type: "dummy", source: "test", priority: EventPriority.LOW }),
    );
    await Promise.race([runPromise, new Promise((r) => setTimeout(r, 100))]);
  });

  it("persists light-tier dashboard DMs so history continue can resume them", async () => {
    const config = makeConfig();
    vi.mocked(mockAgentCore.resolveBinding).mockReturnValue({
      processKey: "dashboard.chat",
      resolvedTier: "lite",
      main: {
        backendId: "claude",
        modelId: "claude-sonnet-4-6",
        maxTurns: 15,
        maxBudgetUsd: 2,
      },
      fallback: null,
    });
    vi.mocked(mockSessionMgr.getOrCreate).mockResolvedValue({
      id: 7,
      isActive: false,
      sessionId: null,
      model: "claude-sonnet-4-6",
      backend: "claude",
    });
    vi.mocked(mockAgentCore.execute).mockResolvedValue(
      makeResult({ sessionId: "sdk-session-light", model: "claude-sonnet-4-6" }),
    );

    const dispatcher = new EventDispatcher(
      eventBus,
      mockAgentCore,
      mockContextBuilder,
      mockGetTaskFlow,
      mockNotificationMgr,
      mockSessionMgr,
      mockMessageRecorder,
      mockAudit,
      db,
      config,
    );

    const runPromise = dispatcher.run();

    await eventBus.put({
      ...createEvent({
        type: "message.received",
        source: "dashboard",
        priority: EventPriority.HIGH,
      }),
      sender: "user",
      channel: "dashboard-ch",
      content: "first browser DM",
      platform: "dashboard",
      threadId: null,
      isDm: true,
      isMention: false,
    } as MessageEvent);

    await new Promise((r) => setTimeout(r, 50));
    dispatcher.stop();

    expect(mockAgentCore.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        processKey: "dashboard.chat",
        persistSession: true,
        sessionDir: expect.any(String),
      }),
      undefined,
    );
    expect(mockSessionMgr.updateSession).toHaveBeenCalledWith(
      7,
      "sdk-session-light",
      "claude-sonnet-4-6",
      undefined,
    );

    await eventBus.put(
      createEvent({ type: "dummy", source: "test", priority: EventPriority.LOW }),
    );
    await Promise.race([runPromise, new Promise((r) => setTimeout(r, 100))]);
  });

  it("keeps light-tier channel messages ephemeral", async () => {
    const config = makeConfig();
    vi.mocked(mockAgentCore.resolveBinding).mockReturnValue({
      processKey: "message.received",
      resolvedTier: "lite",
      main: {
        backendId: "claude",
        modelId: "claude-sonnet-4-6",
        maxTurns: 15,
        maxBudgetUsd: 2,
      },
      fallback: null,
    });
    vi.mocked(mockSessionMgr.getOrCreate).mockResolvedValue({
      id: 8,
      isActive: false,
      sessionId: null,
      model: "claude-sonnet-4-6",
      backend: "claude",
    });

    const dispatcher = new EventDispatcher(
      eventBus,
      mockAgentCore,
      mockContextBuilder,
      mockGetTaskFlow,
      mockNotificationMgr,
      mockSessionMgr,
      mockMessageRecorder,
      mockAudit,
      db,
      config,
    );

    const runPromise = dispatcher.run();

    await eventBus.put({
      ...createEvent({
        type: "message.received",
        source: "slack",
        priority: EventPriority.HIGH,
      }),
      sender: "user",
      channel: "C123",
      content: "thread message",
      platform: "slack",
      threadId: null,
      isDm: false,
      isMention: true,
    } as MessageEvent);

    await new Promise((r) => setTimeout(r, 50));
    dispatcher.stop();

    expect(mockAgentCore.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        persistSession: false,
        sessionDir: undefined,
      }),
      undefined,
    );
    expect(mockSessionMgr.updateSession).not.toHaveBeenCalled();

    await eventBus.put(
      createEvent({ type: "dummy", source: "test", priority: EventPriority.LOW }),
    );
    await Promise.race([runPromise, new Promise((r) => setTimeout(r, 100))]);
  });

  it("uses dm prompt for subsequent DM messages", async () => {
    const config = makeConfig();
    // Existing session (isActive: true) — subsequent message
    vi.mocked(mockSessionMgr.getOrCreate).mockResolvedValue({
      id: 1,
      isActive: true,
      sessionId: null,
      model: "opus",
    });

    const dispatcher = new EventDispatcher(
      eventBus,
      mockAgentCore,
      mockContextBuilder,
      mockGetTaskFlow,
      mockNotificationMgr,
      mockSessionMgr,
      mockMessageRecorder,
      mockAudit,
      db,
      config,
    );

    const runPromise = dispatcher.run();

    const dmEvent = {
      ...createEvent({
        type: "message.received",
        source: "dashboard",
        priority: EventPriority.HIGH,
      }),
      sender: "user",
      channel: "ch1",
      content: "task A is done",
      platform: "dashboard",
      threadId: null,
      isDm: true,
      isMention: false,
    } as MessageEvent;
    await eventBus.put(dmEvent);

    await new Promise((r) => setTimeout(r, 50));
    dispatcher.stop();

    expect(mockGetTaskFlow).toHaveBeenCalledWith("message.received.dm", "claude", expect.any(Object));

    await eventBus.put(
      createEvent({ type: "dummy", source: "test", priority: EventPriority.LOW }),
    );
    await Promise.race([runPromise, new Promise((r) => setTimeout(r, 100))]);
  });

  it("resumes subsequent DMs when a Claude session is already stored", async () => {
    const config = makeConfig();
    vi.mocked(mockSessionMgr.getOrCreate).mockResolvedValue({
      id: 1,
      isActive: true,
      sessionId: "sdk-session-1",
      model: "opus",
    });

    const dispatcher = new EventDispatcher(
      eventBus,
      mockAgentCore,
      mockContextBuilder,
      mockGetTaskFlow,
      mockNotificationMgr,
      mockSessionMgr,
      mockMessageRecorder,
      mockAudit,
      db,
      config,
    );

    const runPromise = dispatcher.run();

    const dmEvent = {
      ...createEvent({
        type: "message.received",
        source: "dashboard",
        priority: EventPriority.HIGH,
      }),
      sender: "user",
      channel: "ch1",
      content: "continuing",
      platform: "dashboard",
      threadId: null,
      isDm: true,
      isMention: false,
    } as MessageEvent;
    await eventBus.put(dmEvent);

    await new Promise((r) => setTimeout(r, 50));
    dispatcher.stop();

    // STAGE-C-DM-FRESHNESS-PLAN §Task 2: resume payload is now prefixed
    // with a `<turn_context>` tag carrying the per-turn fresh clock and
    // the session's snapshot age. The user message text follows after a
    // blank-line separator. Match the structure rather than exact bytes
    // because `current_time` is a wall-clock value.
    expect(mockAgentCore.executeResume).toHaveBeenCalledWith(
      expect.objectContaining({
        backendId: "claude",
        sessionId: "sdk-session-1",
        message: expect.stringMatching(
          /^<turn_context current_time="[^"]+" snapshot_age_minutes="\d+" \/>\n\ncontinuing$/,
        ),
        modelId: "claude-opus-4-6",
        maxTurns: 15,
        maxBudgetUsd: 2,
        sessionDir: expect.any(String),
        sessionDbId: 1,
        eventCorrelationId: expect.any(String),
      }),
      undefined,
    );
    expect(mockAgentCore.execute).not.toHaveBeenCalled();
    expect(mockGetTaskFlow).not.toHaveBeenCalledWith("message.received.dm");

    await eventBus.put(
      createEvent({ type: "dummy", source: "test", priority: EventPriority.LOW }),
    );
    await Promise.race([runPromise, new Promise((r) => setTimeout(r, 100))]);
  });

  it("injects proactive forward context on resume and logs narrow disavowal matches", async () => {
    const config = makeConfig();
    // DM-HISTORY-CONTINUITY-FIX H-2 — the resume catchup builder uses
    // `started_at` as its lower-bound anchor; pin the session row's
    // started_at to ten minutes in the past so the forward row's
    // CURRENT_TIMESTAMP comparison falls strictly after.
    db.prepare(
      `INSERT INTO conversation_sessions (
         id, platform, channel_id, scope, scope_key, status, is_dm,
         backend_session_id, started_at
       )
       VALUES (
         1, 'owner', 'owner', 'owner_dm', 'owner', 'active', 1,
         'sdk-session-1', datetime('now', '-10 minutes')
       )`,
    ).run();
    // canResume requires the on-disk workdir to exist (the
    // dispatcher's existingSessionDirPresent gate falls back to
    // fresh-execute when the directory is missing). Seed an empty
    // directory at the deterministic path so executeResume is taken.
    mkdirSync(join(config.dataDir, "agent-sessions", "1"), { recursive: true });
    db.prepare(
      `INSERT INTO messages (
         session_id, role, content, platform, metadata
       )
       VALUES (
         1,
         'assistant',
         'An email about X arrived. Have you handled it?',
         'slack',
         ?
       )`,
    ).run(JSON.stringify({
      notificationType: "proactive_forward",
      dispatchIds: ["dispatch-1"],
      originSessionIds: [99],
    }));
    vi.mocked(mockSessionMgr.getOrCreate).mockResolvedValue({
      id: 1,
      isActive: true,
      sessionId: "sdk-session-1",
      model: "opus",
    });
    vi.mocked(mockAgentCore.executeResume).mockResolvedValue(
      makeResult({ output: "I don't recall what that refers to." }),
    );
    // H-2 resume catchup builder is mocked — feed it the expected
    // narrow-block return for this scenario. (The wide
    // `contextBuilder.build` is no longer used on the resume path.)
    vi.mocked(mockContextBuilder.buildResumeCatchupContext).mockResolvedValue(
      [
        "<proactive_forwards_since_last_turn>",
        "Background notifications...",
        "[2026-05-17 23:00:00] [assistant → slack, this surface] (forwarded from autonomous run): An email about X arrived. Have you handled it?",
        "</proactive_forwards_since_last_turn>",
      ].join("\n"),
    );

    const dispatcher = new EventDispatcher(
      eventBus,
      mockAgentCore,
      mockContextBuilder,
      mockGetTaskFlow,
      mockNotificationMgr,
      mockSessionMgr,
      mockMessageRecorder,
      mockAudit,
      db,
      config,
    );

    const runPromise = dispatcher.run();
    await eventBus.put({
      ...createEvent({
        type: "message.received",
        source: "slack",
        priority: EventPriority.HIGH,
      }),
      sender: "user",
      channel: "D123",
      content: "handled it",
      platform: "slack",
      threadId: null,
      isDm: true,
      isMention: false,
    } as MessageEvent);

    await new Promise((r) => setTimeout(r, 50));
    dispatcher.stop();

    const call = vi.mocked(mockAgentCore.executeResume).mock.calls[0][0];
    // DM-HISTORY-CONTINUITY-FIX H-2 — resume now uses the narrow
    // `<proactive_forwards_since_last_turn>` block instead of the full
    // `contextBuilder.build()` output. The bare user message wrapped
    // in `<current_user_message>` is still there; the forward content
    // appears verbatim in the new block.
    expect(call.message).toContain("<proactive_forwards_since_last_turn>");
    expect(call.message).toContain("An email about X arrived");
    expect(call.message).toContain("<current_user_message>");
    expect(call.message).toContain("handled it");
    // The full-context bleed is gone — none of the always-injected
    // wide-context blocks should be present in the resume payload.
    expect(call.message).not.toContain("<management_rules>");
    expect(call.message).not.toContain("<today");
    expect(call.message).not.toContain("test context");
    const disavowed = db
      .prepare(
        "SELECT detail FROM agent_actions WHERE action_type = 'proactive_forward_disavowed'",
      )
      .get() as { detail: string } | undefined;
    expect(disavowed).toBeTruthy();
    expect(JSON.parse(disavowed!.detail)).toMatchObject({
      sessionId: 1,
      replyExcerpt: "I don't recall what that refers to.",
    });

    await eventBus.put(
      createEvent({ type: "dummy", source: "test", priority: EventPriority.LOW }),
    );
    await Promise.race([runPromise, new Promise((r) => setTimeout(r, 100))]);
  });

  it("injects a FRESH pending-reminder block into the resume payload (stale-reminder fix)", async () => {
    // Regression guard for the resume-path gap: build() is skipped on
    // resume, so a <scheduled_reminders> snapshot left only in build()
    // would freeze at session start — the agent could not see (and
    // cancel) a reminder queued in an earlier turn of THIS session, which
    // is the exact "owner already did it but the reminder still fires"
    // case. The dispatcher must append a fresh block to the resume turn.
    const config = makeConfig();
    db.prepare(
      `INSERT INTO conversation_sessions (
         id, platform, channel_id, scope, scope_key, status, is_dm,
         backend_session_id, started_at
       )
       VALUES (
         1, 'owner', 'owner', 'owner_dm', 'owner', 'active', 1,
         'sdk-session-1', datetime('now', '-10 minutes')
       )`,
    ).run();
    mkdirSync(join(config.dataDir, "agent-sessions", "1"), { recursive: true });

    vi.mocked(mockSessionMgr.getOrCreate).mockResolvedValue({
      id: 1,
      isActive: true,
      sessionId: "sdk-session-1",
      model: "opus",
    });
    vi.mocked(mockAgentCore.executeResume).mockResolvedValue(
      makeResult({ output: "Cancelled it — removed the reminder." }),
    );
    // No proactive forwards here: the catchup builder returns null, so the
    // reminder block must inject on its own, not piggy-back on that path.
    vi.mocked(mockContextBuilder.buildResumeCatchupContext).mockResolvedValue(
      null,
    );
    vi.mocked(mockContextBuilder.buildScheduledRemindersBlock).mockReturnValue(
      "<scheduled_reminders>\n- #42 · 2026-06-28 14:30 · dm · Reminder: cancel your LinkedIn subscription\n</scheduled_reminders>",
    );

    const dispatcher = new EventDispatcher(
      eventBus,
      mockAgentCore,
      mockContextBuilder,
      mockGetTaskFlow,
      mockNotificationMgr,
      mockSessionMgr,
      mockMessageRecorder,
      mockAudit,
      db,
      config,
    );

    const runPromise = dispatcher.run();
    await eventBus.put({
      ...createEvent({
        type: "message.received",
        source: "slack",
        priority: EventPriority.HIGH,
      }),
      sender: "user",
      channel: "D123",
      content: "I already cancelled LinkedIn",
      platform: "slack",
      threadId: null,
      isDm: true,
      isMention: false,
    } as MessageEvent);

    await new Promise((r) => setTimeout(r, 50));
    dispatcher.stop();

    expect(mockContextBuilder.buildScheduledRemindersBlock).toHaveBeenCalled();
    const call = vi.mocked(mockAgentCore.executeResume).mock.calls[0][0];
    expect(call.message).toContain("<scheduled_reminders>");
    expect(call.message).toContain("#42");
    expect(call.message).toContain("cancel your LinkedIn subscription");
    expect(call.message).toContain("<current_user_message>");
    expect(call.message).toContain("I already cancelled LinkedIn");
    // Stands alone — no forward block, and no wide cached blocks bleed in.
    expect(call.message).not.toContain("<proactive_forwards_since_last_turn>");
    expect(call.message).not.toContain("<management_rules>");

    await Promise.race([runPromise, new Promise((r) => setTimeout(r, 100))]);
  });

  // STAGE-C-DM-FRESHNESS-PLAN §Task 2 — `<turn_context>` is the per-resume
  // freshness anchor. It carries this turn's wall clock and the lag since
  // the session's `<today>` snapshot was captured (= session.started_at,
  // because the fresh-execute branch built the system prompt at that
  // moment). It is emitted on resume only — the fresh-execute branch's
  // system prompt already carries an authoritative `<current_time>`.
  describe("<turn_context> on resume (Stage C DM freshness)", () => {
    it("computes snapshot_age_minutes from conversation_sessions.started_at and prepends <turn_context> to the resume payload", async () => {
      const config = makeConfig();
      // Seed a session row whose started_at is 35 minutes in the past so
      // we can assert the lag math without depending on wall-clock noise.
      const startedAtMs = Date.now() - 35 * 60_000;
      const startedAtSqlite = new Date(startedAtMs)
        .toISOString()
        .replace("T", " ")
        .slice(0, 19);
      db.prepare(
        `INSERT INTO conversation_sessions (
           id, platform, channel_id, scope, scope_key, status, is_dm,
           backend_session_id, started_at
         ) VALUES (1, 'slack', 'D123', 'owner_dm', 'owner', 'active', 1, 'sdk-session-1', ?)`,
      ).run(startedAtSqlite);
      vi.mocked(mockSessionMgr.getOrCreate).mockResolvedValue({
        id: 1,
        isActive: true,
        sessionId: "sdk-session-1",
        model: "opus",
      });

      const dispatcher = new EventDispatcher(
        eventBus,
        mockAgentCore,
        mockContextBuilder,
        mockGetTaskFlow,
        mockNotificationMgr,
        mockSessionMgr,
        mockMessageRecorder,
        mockAudit,
        db,
        config,
      );

      const runPromise = dispatcher.run();
      await eventBus.put({
        ...createEvent({
          type: "message.received",
          source: "slack",
          priority: EventPriority.HIGH,
        }),
        sender: "user",
        channel: "D123",
        content: "anything happen in the last 20 min?",
        platform: "slack",
        threadId: null,
        isDm: true,
        isMention: false,
      } as MessageEvent);

      await new Promise((r) => setTimeout(r, 50));
      dispatcher.stop();

      // executeResume must have fired, and the prepended turn_context must
      // carry an ISO-8601 current_time + an integer snapshot_age_minutes
      // close to 35 (allow ±1 for the round-and-clock window).
      const calls = vi.mocked(mockAgentCore.executeResume).mock.calls;
      expect(calls.length).toBeGreaterThanOrEqual(1);
      const message = (calls[calls.length - 1][0] as { message: string }).message;
      const turnCtxMatch = /^<turn_context current_time="([^"]+)" snapshot_age_minutes="(\d+)" \/>/
        .exec(message);
      expect(turnCtxMatch).not.toBeNull();
      // ISO-8601 UTC parseable.
      const currentTimeIso = turnCtxMatch![1];
      expect(Number.isFinite(Date.parse(currentTimeIso))).toBe(true);
      const ageMin = Number(turnCtxMatch![2]);
      expect(ageMin).toBeGreaterThanOrEqual(34);
      expect(ageMin).toBeLessThanOrEqual(36);
      // The user's message text must follow after the blank-line separator.
      expect(message).toContain("anything happen in the last 20 min?");

      await eventBus.put(
        createEvent({ type: "dummy", source: "test", priority: EventPriority.LOW }),
      );
      await Promise.race([runPromise, new Promise((r) => setTimeout(r, 100))]);
    });

    it("does NOT prepend <turn_context> on the fresh-execute branch (system prompt already carries fresh <current_time>)", async () => {
      const config = makeConfig();
      // No stored backend session id — forces fresh execute.
      vi.mocked(mockSessionMgr.getOrCreate).mockResolvedValue({
        id: 999,
        isActive: false,
        sessionId: null,
        model: "opus",
      });

      const dispatcher = new EventDispatcher(
        eventBus,
        mockAgentCore,
        mockContextBuilder,
        mockGetTaskFlow,
        mockNotificationMgr,
        mockSessionMgr,
        mockMessageRecorder,
        mockAudit,
        db,
        config,
      );

      const runPromise = dispatcher.run();
      await eventBus.put({
        ...createEvent({
          type: "message.received",
          source: "slack",
          priority: EventPriority.HIGH,
        }),
        sender: "user",
        channel: "D-fresh",
        content: "first message",
        platform: "slack",
        threadId: null,
        isDm: true,
        isMention: false,
      } as MessageEvent);

      await new Promise((r) => setTimeout(r, 50));
      dispatcher.stop();

      expect(mockAgentCore.executeResume).not.toHaveBeenCalled();
      expect(mockAgentCore.execute).toHaveBeenCalled();
      const executeCalls = vi.mocked(mockAgentCore.execute).mock.calls;
      const params = executeCalls[executeCalls.length - 1][0] as {
        prompt: string;
        context: string;
      };
      expect(params.prompt).not.toContain("<turn_context");
      expect(params.context).not.toContain("<turn_context");

      await eventBus.put(
        createEvent({ type: "dummy", source: "test", priority: EventPriority.LOW }),
      );
      await Promise.race([runPromise, new Promise((r) => setTimeout(r, 100))]);
    });

    it("falls back to age=0 when conversation_sessions row is unexpectedly missing started_at", async () => {
      const config = makeConfig();
      // Insert a row with started_at explicitly set to NULL (guarded by
      // the dispatcher's null-check). Simulates a forensic row state.
      db.prepare(
        `INSERT INTO conversation_sessions (
           id, platform, channel_id, scope, scope_key, status, is_dm,
           backend_session_id, started_at
         ) VALUES (2, 'slack', 'D-x', 'owner_dm', 'owner', 'active', 1, 'sdk-session-x', NULL)`,
      ).run();
      vi.mocked(mockSessionMgr.getOrCreate).mockResolvedValue({
        id: 2,
        isActive: true,
        sessionId: "sdk-session-x",
        model: "opus",
      });

      const dispatcher = new EventDispatcher(
        eventBus,
        mockAgentCore,
        mockContextBuilder,
        mockGetTaskFlow,
        mockNotificationMgr,
        mockSessionMgr,
        mockMessageRecorder,
        mockAudit,
        db,
        config,
      );

      const runPromise = dispatcher.run();
      await eventBus.put({
        ...createEvent({
          type: "message.received",
          source: "slack",
          priority: EventPriority.HIGH,
        }),
        sender: "user",
        channel: "D-x",
        content: "hi",
        platform: "slack",
        threadId: null,
        isDm: true,
        isMention: false,
      } as MessageEvent);

      await new Promise((r) => setTimeout(r, 50));
      dispatcher.stop();

      const calls = vi.mocked(mockAgentCore.executeResume).mock.calls;
      const message = calls.length > 0
        ? (calls[calls.length - 1][0] as { message: string }).message
        : "";
      // Either fired (resume) with age=0, or didn't fire at all (workdir
      // missing in this isolated case). When it fired, the lag must be 0.
      if (message) {
        const m = /snapshot_age_minutes="(\d+)"/.exec(message);
        expect(m).not.toBeNull();
        expect(Number(m![1])).toBe(0);
      }

      await eventBus.put(
        createEvent({ type: "dummy", source: "test", priority: EventPriority.LOW }),
      );
      await Promise.race([runPromise, new Promise((r) => setTimeout(r, 100))]);
    });
  });

  // STAGE-C-DM-FRESHNESS-PLAN §Task 4 — assert that the per-turn DM
  // freshness telemetry payload reaches `audit.logAction` (which then
  // persists it into `agent_actions.detail.dm_freshness`). The persistence
  // layer itself is covered in audit.ts; this guards the wiring between
  // dispatcher and audit so a future refactor that drops the
  // `collectDmFreshnessTelemetry` call is caught.
  describe("dmFreshness payload on logAction (Stage C DM freshness)", () => {
    it("forwards resumed=true, agentLogLagMinutes=~age, and triggerMatched=true on a resume turn whose user content matches the bilingual trigger", async () => {
      const config = makeConfig();
      const startedAtMs = Date.now() - 25 * 60_000;
      const startedAtSqlite = new Date(startedAtMs)
        .toISOString()
        .replace("T", " ")
        .slice(0, 19);
      db.prepare(
        `INSERT INTO conversation_sessions (
           id, platform, channel_id, scope, scope_key, status, is_dm,
           backend_session_id, started_at
         ) VALUES (1, 'slack', 'D-stagec', 'owner_dm', 'owner', 'active', 1, 'sdk-c-1', ?)`,
      ).run(startedAtSqlite);
      vi.mocked(mockSessionMgr.getOrCreate).mockResolvedValue({
        id: 1,
        isActive: true,
        sessionId: "sdk-c-1",
        model: "opus",
      });

      const dispatcher = new EventDispatcher(
        eventBus,
        mockAgentCore,
        mockContextBuilder,
        mockGetTaskFlow,
        mockNotificationMgr,
        mockSessionMgr,
        mockMessageRecorder,
        mockAudit,
        db,
        config,
      );

      const runPromise = dispatcher.run();
      await eventBus.put({
        ...createEvent({
          type: "message.received",
          source: "slack",
          priority: EventPriority.HIGH,
        }),
        sender: "user",
        channel: "D-stagec",
        content: "anything happen in the last 20 min?",
        platform: "slack",
        threadId: null,
        isDm: true,
        isMention: false,
      } as MessageEvent);

      await new Promise((r) => setTimeout(r, 50));
      dispatcher.stop();

      // logAction must have been called with a dmFreshness payload that
      // mirrors what the dispatcher computed. We don't assert the exact
      // age (it's wall-clock dependent) — just bracket it.
      const logCalls = vi.mocked(mockAudit.logAction).mock.calls;
      expect(logCalls.length).toBeGreaterThanOrEqual(1);
      const params = logCalls[logCalls.length - 1][0];
      expect(params.dmFreshness).toBeDefined();
      expect(params.dmFreshness!.resumed).toBe(true);
      expect(params.dmFreshness!.agentLogLagMinutes).toBeGreaterThanOrEqual(24);
      expect(params.dmFreshness!.agentLogLagMinutes).toBeLessThanOrEqual(26);
      expect(params.dmFreshness!.triggerMatched).toBe(true);
      expect(typeof params.dmFreshness!.refetchedToday).toBe("boolean");
      expect(typeof params.dmFreshness!.loudWritesSinceSessionStart).toBe(
        "number",
      );
      expect(typeof params.dmFreshness!.quietWritesSinceSessionStart).toBe(
        "number",
      );

      await eventBus.put(
        createEvent({ type: "dummy", source: "test", priority: EventPriority.LOW }),
      );
      await Promise.race([runPromise, new Promise((r) => setTimeout(r, 100))]);
    });

    it("forwards resumed=false, agentLogLagMinutes=0, and triggerMatched=false on a fresh-execute DM whose user content does not match the trigger", async () => {
      const config = makeConfig();
      vi.mocked(mockSessionMgr.getOrCreate).mockResolvedValue({
        id: 7,
        isActive: false,
        sessionId: null,
        model: "opus",
      });

      const dispatcher = new EventDispatcher(
        eventBus,
        mockAgentCore,
        mockContextBuilder,
        mockGetTaskFlow,
        mockNotificationMgr,
        mockSessionMgr,
        mockMessageRecorder,
        mockAudit,
        db,
        config,
      );

      const runPromise = dispatcher.run();
      await eventBus.put({
        ...createEvent({
          type: "message.received",
          source: "slack",
          priority: EventPriority.HIGH,
        }),
        sender: "user",
        channel: "D-stagec-fresh",
        content: "hello",
        platform: "slack",
        threadId: null,
        isDm: true,
        isMention: false,
      } as MessageEvent);

      await new Promise((r) => setTimeout(r, 50));
      dispatcher.stop();

      const logCalls = vi.mocked(mockAudit.logAction).mock.calls;
      expect(logCalls.length).toBeGreaterThanOrEqual(1);
      const params = logCalls[logCalls.length - 1][0];
      expect(params.dmFreshness).toBeDefined();
      expect(params.dmFreshness!.resumed).toBe(false);
      // Fresh-execute lag is 0 by construction — the system prompt's
      // <today> snapshot was just built.
      expect(params.dmFreshness!.agentLogLagMinutes).toBe(0);
      expect(params.dmFreshness!.triggerMatched).toBe(false);

      await eventBus.put(
        createEvent({ type: "dummy", source: "test", priority: EventPriority.LOW }),
      );
      await Promise.race([runPromise, new Promise((r) => setTimeout(r, 100))]);
    });

    it("omits dmFreshness for non-DM events", async () => {
      const config = makeConfig();
      const dispatcher = new EventDispatcher(
        eventBus,
        mockAgentCore,
        mockContextBuilder,
        mockGetTaskFlow,
        mockNotificationMgr,
        mockSessionMgr,
        mockMessageRecorder,
        mockAudit,
        db,
        config,
      );

      const runPromise = dispatcher.run();
      await eventBus.put({
        ...createEvent({
          type: "message.received",
          source: "slack",
          priority: EventPriority.HIGH,
        }),
        sender: "user",
        channel: "C-public",
        content: "@bot hi",
        platform: "slack",
        threadId: null,
        isDm: false,
        isMention: true,
      } as MessageEvent);

      await new Promise((r) => setTimeout(r, 50));
      dispatcher.stop();

      const logCalls = vi.mocked(mockAudit.logAction).mock.calls;
      // Some calls may have happened (logSkip / logError instead of
      // logAction is also valid); when logAction fired, dmFreshness must
      // be undefined for the non-DM branch.
      for (const call of logCalls) {
        expect(call[0].dmFreshness).toBeUndefined();
      }

      await eventBus.put(
        createEvent({ type: "dummy", source: "test", priority: EventPriority.LOW }),
      );
      await Promise.race([runPromise, new Promise((r) => setTimeout(r, 100))]);
    });
  });

  it("injects only prior dashboard history when a dashboard session switches backend", async () => {
    const config = makeConfig();
    vi.mocked(mockAgentCore.resolveBinding).mockReturnValue({
      processKey: "dashboard.chat",
      resolvedTier: "high",
      main: {
        backendId: "codex",
        modelId: "gpt-5.4",
        maxTurns: 15,
        maxBudgetUsd: 2,
      },
      fallback: null,
    });
    vi.mocked(mockSessionMgr.getOrCreate).mockResolvedValue({
      id: 2,
      isActive: false,
      sessionId: null,
      model: "gpt-5.4",
      backend: "codex",
      requiresHistoryInjection: true,
    });

    db.prepare(
      `INSERT INTO conversation_sessions (id, platform, channel_id, scope, scope_key, status)
       VALUES
       (1, 'dashboard', 'dashboard', 'dashboard_chat', 'dashboard', 'expired'),
       (3, 'owner', 'owner', 'owner_dm', 'owner', 'expired')`,
    ).run();
    db.prepare(
      `INSERT INTO messages (session_id, role, content, platform)
       VALUES
       (1, 'assistant', 'old dashboard assistant reply', 'dashboard'),
       (3, 'assistant', 'old owner dm assistant reply', 'telegram')`,
    ).run();

    const dispatcher = new EventDispatcher(
      eventBus,
      mockAgentCore,
      mockContextBuilder,
      mockGetTaskFlow,
      mockNotificationMgr,
      mockSessionMgr,
      mockMessageRecorder,
      mockAudit,
      db,
      config,
    );

    const runPromise = dispatcher.run();

    const dmEvent = {
      ...createEvent({
        type: "message.received",
        source: "dashboard",
        priority: EventPriority.HIGH,
      }),
      sender: "user",
      channel: "ch1",
      content: "after the switch",
      platform: "dashboard",
      threadId: null,
      isDm: true,
      isMention: false,
    } as MessageEvent;
    await eventBus.put(dmEvent);

    await new Promise((r) => setTimeout(r, 50));
    dispatcher.stop();

    expect(mockSessionMgr.getOrCreate).toHaveBeenCalledWith(
      expect.objectContaining({ requiredBackend: "codex" }),
    );
    expect(mockAgentCore.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationHistory: expect.stringContaining("old dashboard assistant reply"),
      }),
      undefined,
    );
    const executeParams = vi.mocked(mockAgentCore.execute).mock.calls[0]?.[0];
    expect(executeParams?.conversationHistory).not.toContain("after the switch");
    expect(executeParams?.conversationHistory).not.toContain("old owner dm assistant reply");
    expect(mockSessionMgr.getPreviousDmSummary).not.toHaveBeenCalled();

    // DM-HISTORY-CONTINUITY-FIX H-3 — because the cross-session bridge
    // is about to inject the same rows via `conversationHistory`,
    // contextBuilder.build() must be called with
    // `skipActiveHistoryBlock: true` so the active-session block does
    // not render the same messages a second time under a different XML
    // tag. Pin the call signature.
    expect(mockContextBuilder.build).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ skipActiveHistoryBlock: true }),
    );

    // DM-HISTORY-CONTINUITY-FIX H-1/H-3 follow-up — every fresh-execute
    // turn must refresh `started_at` so the H-2 catchup builder uses
    // the SDK-session-bind time of THIS turn (not the original row-
    // insert time, which can lag by hours after handleDirectDm or
    // reset-in-place). Pin the call so a future refactor that drops
    // the bump silently reintroduces duplicate-forward bleed on resume.
    expect(mockSessionMgr.markFreshExecuteStart).toHaveBeenCalledWith(2);

    await eventBus.put(
      createEvent({ type: "dummy", source: "test", priority: EventPriority.LOW }),
    );
    await Promise.race([runPromise, new Promise((r) => setTimeout(r, 100))]);
  });

  it("tags forwarded assistant rows in cross-session conversation history", async () => {
    const config = makeConfig();
    vi.mocked(mockAgentCore.resolveBinding).mockReturnValue({
      processKey: "dashboard.chat",
      resolvedTier: "high",
      main: {
        backendId: "codex",
        modelId: "gpt-5.4",
        maxTurns: 15,
        maxBudgetUsd: 2,
      },
      fallback: null,
    });
    vi.mocked(mockSessionMgr.getOrCreate).mockResolvedValue({
      id: 2,
      isActive: false,
      sessionId: null,
      model: "gpt-5.4",
      backend: "codex",
      requiresHistoryInjection: true,
    });

    db.prepare(
      `INSERT INTO conversation_sessions (id, platform, channel_id, scope, scope_key, status)
       VALUES (1, 'dashboard', 'dashboard', 'dashboard_chat', 'dashboard', 'expired')`,
    ).run();
    db.prepare(
      `INSERT INTO messages (session_id, role, content, platform, metadata)
       VALUES (1, 'assistant', 'forwarded reminder', 'dashboard', ?)`,
    ).run(JSON.stringify({ notificationType: "proactive_forward" }));

    const dispatcher = new EventDispatcher(
      eventBus,
      mockAgentCore,
      mockContextBuilder,
      mockGetTaskFlow,
      mockNotificationMgr,
      mockSessionMgr,
      mockMessageRecorder,
      mockAudit,
      db,
      config,
    );

    const runPromise = dispatcher.run();
    await eventBus.put({
      ...createEvent({
        type: "message.received",
        source: "dashboard",
        priority: EventPriority.HIGH,
      }),
      sender: "user",
      channel: "ch1",
      content: "anything",
      platform: "dashboard",
      threadId: null,
      isDm: true,
      isMention: false,
    } as MessageEvent);

    await new Promise((r) => setTimeout(r, 50));
    dispatcher.stop();

    const executeParams = vi.mocked(mockAgentCore.execute).mock.calls[0]?.[0];
    expect(executeParams?.conversationHistory).toContain("forwarded reminder");
    expect(executeParams?.conversationHistory).toContain(
      "(forwarded from autonomous run)",
    );

    await eventBus.put(
      createEvent({ type: "dummy", source: "test", priority: EventPriority.LOW }),
    );
    await Promise.race([runPromise, new Promise((r) => setTimeout(r, 100))]);
  });

  it("uses standard prompt for non-DM messages", async () => {
    const config = makeConfig();
    vi.mocked(mockSessionMgr.getOrCreate).mockResolvedValue({
      id: 1,
      isActive: false,
      sessionId: null,
      model: "opus",
    });

    const dispatcher = new EventDispatcher(
      eventBus,
      mockAgentCore,
      mockContextBuilder,
      mockGetTaskFlow,
      mockNotificationMgr,
      mockSessionMgr,
      mockMessageRecorder,
      mockAudit,
      db,
      config,
    );

    const runPromise = dispatcher.run();

    const mentionEvent = {
      ...createEvent({
        type: "message.received",
        source: "slack",
        priority: EventPriority.HIGH,
      }),
      sender: "user1",
      channel: "C123",
      content: "hey agent",
      platform: "slack",
      threadId: "T123",
      isDm: false,
      isMention: true,
    } as MessageEvent;
    await eventBus.put(mentionEvent);

    await new Promise((r) => setTimeout(r, 50));
    dispatcher.stop();

    expect(mockGetTaskFlow).toHaveBeenCalledWith("message.received", "claude", expect.any(Object));

    await eventBus.put(
      createEvent({ type: "dummy", source: "test", priority: EventPriority.LOW }),
    );
    await Promise.race([runPromise, new Promise((r) => setTimeout(r, 100))]);
  });

  describe("summarizeDmSessions", () => {
    /** SQLite CURRENT_TIMESTAMP format (UTC, no Z suffix) */
    function sqliteTs(date: Date): string {
      return date.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "");
    }

    function makeMessages(count: number) {
      return Array.from({ length: count }, (_, i) => ({
        role: i % 2 === 0 ? "user" : "assistant",
        content: `message ${i}`,
        timestamp: sqliteTs(new Date(Date.now() - (count - i) * 60000)),
      }));
    }

    function makeDispatcher() {
      const config = makeConfig();
      return new EventDispatcher(
        eventBus,
        mockAgentCore,
        mockContextBuilder,
        mockGetTaskFlow,
        mockNotificationMgr,
        mockSessionMgr,
        mockMessageRecorder,
        mockAudit,
        db,
        config,
      );
    }

    it("skips summarization when message count is below threshold", async () => {
      vi.mocked(mockSessionMgr.getDmPlatformsWithNewMessages).mockReturnValue(["dashboard"]);
      vi.mocked(mockSessionMgr.getUnsummarizedDmMessages).mockReturnValue(makeMessages(10));

      const dispatcher = makeDispatcher();
      await dispatcher.summarizeDmSessions();

      expect(mockAgentCore.summarize).not.toHaveBeenCalled();
      expect(mockSessionMgr.saveDmSummary).not.toHaveBeenCalled();
    });

    it("runs AI summarization when message count exceeds threshold", async () => {
      vi.mocked(mockSessionMgr.getDmPlatformsWithNewMessages).mockReturnValue(["dashboard"]);
      vi.mocked(mockSessionMgr.getUnsummarizedDmMessages).mockReturnValue(makeMessages(31));

      const dispatcher = makeDispatcher();
      await dispatcher.summarizeDmSessions();

      expect(mockAgentCore.summarize).toHaveBeenCalledOnce();
      expect(mockSessionMgr.saveDmSummary).toHaveBeenCalledWith("dashboard", "Test summary", 31);
    });

    it("runs AI summarization when raw text size exceeds threshold", async () => {
      const longMessages = [
        { role: "user", content: "x".repeat(3000), timestamp: sqliteTs(new Date()) },
        { role: "assistant", content: "y".repeat(3000), timestamp: sqliteTs(new Date()) },
      ];
      vi.mocked(mockSessionMgr.getDmPlatformsWithNewMessages).mockReturnValue(["slack"]);
      vi.mocked(mockSessionMgr.getUnsummarizedDmMessages).mockReturnValue(longMessages);

      const dispatcher = makeDispatcher();
      await dispatcher.summarizeDmSessions();

      expect(mockAgentCore.summarize).toHaveBeenCalledOnce();
      expect(mockSessionMgr.saveDmSummary).toHaveBeenCalledWith("slack", "Test summary", 2);
    });

    it("includes previous summary in AI prompt when it exists", async () => {
      vi.mocked(mockSessionMgr.getDmPlatformsWithNewMessages).mockReturnValue(["dashboard"]);
      vi.mocked(mockSessionMgr.getUnsummarizedDmMessages).mockReturnValue(makeMessages(31));
      vi.mocked(mockSessionMgr.getPreviousDmSummary).mockReturnValue("Previous context here");

      const dispatcher = makeDispatcher();
      await dispatcher.summarizeDmSessions();

      const prompt = vi.mocked(mockAgentCore.summarize).mock.calls[0][0];
      expect(prompt).toContain("Previous context:\nPrevious context here");
      expect(prompt).toContain("New messages:");
    });

    it("does not include previous summary in prompt when none exists", async () => {
      vi.mocked(mockSessionMgr.getDmPlatformsWithNewMessages).mockReturnValue(["dashboard"]);
      vi.mocked(mockSessionMgr.getUnsummarizedDmMessages).mockReturnValue(makeMessages(31));
      vi.mocked(mockSessionMgr.getPreviousDmSummary).mockReturnValue(null);

      const dispatcher = makeDispatcher();
      await dispatcher.summarizeDmSessions();

      const prompt = vi.mocked(mockAgentCore.summarize).mock.calls[0][0];
      expect(prompt).not.toContain("Previous context:");
      expect(prompt).toContain("New messages:");
    });

    it("forces summarization when oldest message approaches retention cutoff", async () => {
      // 5 messages, well below count threshold — but oldest is 6+ days old
      const oldMessages = Array.from({ length: 5 }, (_, i) => ({
        role: i % 2 === 0 ? "user" : "assistant",
        content: `old message ${i}`,
        // Oldest message is 7 days ago, newest is 3 days ago
        timestamp: sqliteTs(new Date(Date.now() - (7 - i) * 24 * 60 * 60 * 1000)),
      }));
      vi.mocked(mockSessionMgr.getDmPlatformsWithNewMessages).mockReturnValue(["dashboard"]);
      vi.mocked(mockSessionMgr.getUnsummarizedDmMessages).mockReturnValue(oldMessages);

      const dispatcher = makeDispatcher();
      await dispatcher.summarizeDmSessions();

      // Should summarize despite being below MSG_THRESHOLD
      expect(mockAgentCore.summarize).toHaveBeenCalledOnce();
      expect(mockSessionMgr.saveDmSummary).toHaveBeenCalledWith("dashboard", "Test summary", 5);
    });

    it("does not force summarization when messages are recent", async () => {
      // 5 messages, all from today — below threshold and not approaching retention
      const recentMessages = Array.from({ length: 5 }, (_, i) => ({
        role: i % 2 === 0 ? "user" : "assistant",
        content: `recent message ${i}`,
        timestamp: sqliteTs(new Date(Date.now() - (5 - i) * 60 * 1000)),
      }));
      vi.mocked(mockSessionMgr.getDmPlatformsWithNewMessages).mockReturnValue(["dashboard"]);
      vi.mocked(mockSessionMgr.getUnsummarizedDmMessages).mockReturnValue(recentMessages);

      const dispatcher = makeDispatcher();
      await dispatcher.summarizeDmSessions();

      expect(mockAgentCore.summarize).not.toHaveBeenCalled();
      expect(mockSessionMgr.saveDmSummary).not.toHaveBeenCalled();
    });

    it("accumulates count across calls when below threshold", async () => {
      // First call: 10 messages, below threshold — no save
      vi.mocked(mockSessionMgr.getDmPlatformsWithNewMessages).mockReturnValue(["dashboard"]);
      vi.mocked(mockSessionMgr.getUnsummarizedDmMessages).mockReturnValue(makeMessages(10));

      const dispatcher = makeDispatcher();
      await dispatcher.summarizeDmSessions();

      expect(mockSessionMgr.saveDmSummary).not.toHaveBeenCalled();

      // Second call: same platform now returns 25 messages (accumulated)
      // Still below threshold — no save
      vi.mocked(mockSessionMgr.getUnsummarizedDmMessages).mockReturnValue(makeMessages(25));
      await dispatcher.summarizeDmSessions();

      expect(mockSessionMgr.saveDmSummary).not.toHaveBeenCalled();

      // Third call: 31 messages accumulated — triggers
      vi.mocked(mockSessionMgr.getUnsummarizedDmMessages).mockReturnValue(makeMessages(31));
      await dispatcher.summarizeDmSessions();

      expect(mockSessionMgr.saveDmSummary).toHaveBeenCalledOnce();
      expect(mockAgentCore.summarize).toHaveBeenCalledOnce();
    });
  });

  describe("isRoadmapStale", () => {
    function makeDispatcherWithDataDir(dataDir: string) {
      const config = makeConfig({ dataDir });
      return new EventDispatcher(
        eventBus,
        mockAgentCore,
        mockContextBuilder,
        mockGetTaskFlow,
        mockNotificationMgr,
        mockSessionMgr,
        mockMessageRecorder,
        mockAudit,
        db,
        config,
      );
    }

    it("returns true when roadmap.md does not exist", () => {
      const dispatcher = makeDispatcherWithDataDir("/tmp/nonexistent-dir-test");
      expect(dispatcher.isRoadmapStale()).toBe(true);
    });

    it("returns true when roadmap.md contains skeleton content", async () => {
      const { mkdirSync, writeFileSync, rmSync } = await import("node:fs");
      const tmpDir = `/tmp/pa-test-roadmap-${Date.now()}`;
      mkdirSync(`${tmpDir}/context`, { recursive: true });
      mkdirSync(`${tmpDir}/context/plans`, { recursive: true });
      writeFileSync(`${tmpDir}/context/plans/roadmap.md`, "# Roadmap\n\n## Annual Goals\n- (Not yet configured)\n");
      try {
        const dispatcher = makeDispatcherWithDataDir(tmpDir);
        expect(dispatcher.isRoadmapStale()).toBe(true);
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("returns false when roadmap.md is recent and has real content", async () => {
      const { mkdirSync, writeFileSync, rmSync } = await import("node:fs");
      const tmpDir = `/tmp/pa-test-roadmap-${Date.now()}`;
      mkdirSync(`${tmpDir}/context`, { recursive: true });
      mkdirSync(`${tmpDir}/context/plans`, { recursive: true });
      writeFileSync(`${tmpDir}/context/plans/roadmap.md`, "# Roadmap\n> Last synced: 2026-04-06\n\n## Annual Goals\n1. Ship project\n");
      try {
        const dispatcher = makeDispatcherWithDataDir(tmpDir);
        expect(dispatcher.isRoadmapStale()).toBe(false);
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("returns true when roadmap.md is older than maxAgeDays", async () => {
      const { mkdirSync, writeFileSync, utimesSync, rmSync } = await import("node:fs");
      const tmpDir = `/tmp/pa-test-roadmap-${Date.now()}`;
      mkdirSync(`${tmpDir}/context`, { recursive: true });
      mkdirSync(`${tmpDir}/context/plans`, { recursive: true });
      const roadmapPath = `${tmpDir}/context/plans/roadmap.md`;
      writeFileSync(roadmapPath, "# Roadmap\n> Last synced: 2026-03-01\n\n## Annual Goals\n1. Ship project\n");
      // Set mtime to 20 days ago
      const pastDate = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000);
      utimesSync(roadmapPath, pastDate, pastDate);
      try {
        const dispatcher = makeDispatcherWithDataDir(tmpDir);
        expect(dispatcher.isRoadmapStale()).toBe(true);
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  describe("emitRoadmapRefresh dedup", () => {
    it("emits on first call", () => {
      const config = makeConfig();
      const dispatcher = new EventDispatcher(
        eventBus,
        mockAgentCore,
        mockContextBuilder,
        mockGetTaskFlow,
        mockNotificationMgr,
        mockSessionMgr,
        mockMessageRecorder,
        mockAudit,
        db,
        config,
      );

      const putSpy = vi.spyOn(eventBus, "put");
      dispatcher.emitRoadmapRefresh("test");
      expect(putSpy).toHaveBeenCalledOnce();
    });

    it("skips second call within 5 minutes", () => {
      const config = makeConfig();
      const dispatcher = new EventDispatcher(
        eventBus,
        mockAgentCore,
        mockContextBuilder,
        mockGetTaskFlow,
        mockNotificationMgr,
        mockSessionMgr,
        mockMessageRecorder,
        mockAudit,
        db,
        config,
      );

      const putSpy = vi.spyOn(eventBus, "put");
      dispatcher.emitRoadmapRefresh("first");
      dispatcher.emitRoadmapRefresh("second");
      expect(putSpy).toHaveBeenCalledOnce();
    });

    it("allows emit after dedup window expires", () => {
      const config = makeConfig();
      const dispatcher = new EventDispatcher(
        eventBus,
        mockAgentCore,
        mockContextBuilder,
        mockGetTaskFlow,
        mockNotificationMgr,
        mockSessionMgr,
        mockMessageRecorder,
        mockAudit,
        db,
        config,
      );

      const putSpy = vi.spyOn(eventBus, "put");
      dispatcher.emitRoadmapRefresh("first");

      // Advance past the 5-minute dedup window
      vi.spyOn(Date, "now").mockReturnValue(Date.now() + 6 * 60 * 1000);
      dispatcher.emitRoadmapRefresh("second");
      expect(putSpy).toHaveBeenCalledTimes(2);

      vi.restoreAllMocks();
    });

    it("bypassDedup overrides the 5-minute guard", () => {
      const config = makeConfig();
      const dispatcher = new EventDispatcher(
        eventBus,
        mockAgentCore,
        mockContextBuilder,
        mockGetTaskFlow,
        mockNotificationMgr,
        mockSessionMgr,
        mockMessageRecorder,
        mockAudit,
        db,
        config,
      );

      const putSpy = vi.spyOn(eventBus, "put");
      dispatcher.emitRoadmapRefresh("first");
      dispatcher.emitRoadmapRefresh("dashboard_regenerate", { bypassDedup: true });
      expect(putSpy).toHaveBeenCalledTimes(2);
    });
  });

  // A2 — routine progress SSE broadcast for the dashboard's
  // "Generating today's status…" indicator. The dispatcher fires
  // `routine_started` BEFORE the agent run begins and
  // `routine_completed` after success or failure. Non-routine events
  // (messages, scheduled.task, scheduled.dm) MUST NOT emit these.
  describe("routine progress SSE broadcast (A2)", () => {
    function makeRecordingBroadcaster(): {
      events: Array<Record<string, unknown>>;
      broadcastEvent: (data: unknown) => void;
    } {
      const events: Array<Record<string, unknown>> = [];
      return {
        events,
        broadcastEvent: (data) => {
          events.push(data as Record<string, unknown>);
        },
      };
    }

    function buildDispatcherWithBroadcaster(
      broadcaster: { broadcastEvent: (data: unknown) => void } | null,
    ): EventDispatcher {
      const config = makeConfig();
      const dispatcher = new EventDispatcher(
        eventBus,
        mockAgentCore,
        mockContextBuilder,
        mockGetTaskFlow,
        mockNotificationMgr,
        mockSessionMgr,
        mockMessageRecorder,
        mockAudit,
        db,
        config,
      );
      dispatcher.setEventBroadcaster(broadcaster);
      return dispatcher;
    }

    it("emits routine_started then routine_completed on a successful routine", async () => {
      const broadcaster = makeRecordingBroadcaster();
      const dispatcher = buildDispatcherWithBroadcaster(broadcaster);
      // Routine dispatch ultimately calls scheduledTasks.executeDefault →
      // agentRouter.execute. Stub the execute path so we don't drive the
      // full SDK stack from a unit test.
      vi.mocked(mockAgentCore.execute).mockResolvedValue(makeResult());

      const routineEvent: RoutineEvent = {
        ...createEvent({
          type: "routine.evening_review",
          source: "cron",
          priority: EventPriority.NORMAL,
        }),
        routine: "evening_review",
      };

      await (
        dispatcher as unknown as { handleEvent: (e: Event) => Promise<void> }
      ).handleEvent(routineEvent);

      // Filter to the A2 envelope (routine_*) — the pre-pass fetch_window
      // runner may interleave its own `prepass_started` / `prepass_completed`
      // events between the two routine markers (B2 broadcast). The A2
      // contract is specifically the outer envelope.
      const routineKinds = broadcaster.events
        .map((e) => e.kind as string)
        .filter((k) => k === "routine_started" || k === "routine_completed");
      expect(routineKinds).toEqual(["routine_started", "routine_completed"]);
      const routineStarted = broadcaster.events.find((e) => e.kind === "routine_started");
      const routineCompleted = broadcaster.events.find((e) => e.kind === "routine_completed");
      expect(routineStarted).toMatchObject({
        kind: "routine_started",
        routine: "evening_review",
        source: "cron",
        correlationId: routineEvent.correlationId,
      });
      expect(routineCompleted).toMatchObject({
        kind: "routine_completed",
        routine: "evening_review",
        result: "success",
      });
      expect(typeof (routineCompleted as { durationMs?: number }).durationMs).toBe("number");
    });

    it("emits routine_completed with result=error when the routine throws", async () => {
      const broadcaster = makeRecordingBroadcaster();
      const dispatcher = buildDispatcherWithBroadcaster(broadcaster);
      vi.mocked(mockAgentCore.execute).mockRejectedValue(new Error("boom"));

      const routineEvent: RoutineEvent = {
        ...createEvent({
          type: "routine.evening_review",
          source: "cron",
          priority: EventPriority.NORMAL,
        }),
        routine: "evening_review",
      };

      await (
        dispatcher as unknown as { handleEvent: (e: Event) => Promise<void> }
      ).handleEvent(routineEvent);

      const routineKinds = broadcaster.events
        .map((e) => e.kind as string)
        .filter((k) => k === "routine_started" || k === "routine_completed");
      expect(routineKinds).toEqual(["routine_started", "routine_completed"]);
      const routineCompleted = broadcaster.events.find((e) => e.kind === "routine_completed");
      expect(routineCompleted).toMatchObject({
        kind: "routine_completed",
        result: "error",
      });
    });

    it("emits NO routine_started for a setup-gated routine (no orphan started)", async () => {
      const emptyDataDir = mkdtempSync(join(tmpdir(), "pa-setup-cold-broadcast-"));
      const config = { ...makeConfig(), dataDir: emptyDataDir };
      rmSync(join(emptyDataDir, "context", "rules", "management.md"), { force: true });
      const broadcaster = makeRecordingBroadcaster();
      const dispatcher = new EventDispatcher(
        eventBus,
        mockAgentCore,
        mockContextBuilder,
        mockGetTaskFlow,
        mockNotificationMgr,
        mockSessionMgr,
        mockMessageRecorder,
        mockAudit,
        db,
        config,
      );
      dispatcher.setEventBroadcaster(broadcaster);

      await (
        dispatcher as unknown as { handleEvent: (e: Event) => Promise<void> }
      ).handleEvent({
        ...createEvent({
          type: "routine.evening_review",
          source: "cron",
          priority: EventPriority.HIGH,
        }),
        routine: "evening_review",
      } as RoutineEvent);

      expect(broadcaster.events).toEqual([]);
      rmSync(emptyDataDir, { recursive: true, force: true });
    });

    it("does NOT emit routine events for message dispatches", async () => {
      const broadcaster = makeRecordingBroadcaster();
      const dispatcher = buildDispatcherWithBroadcaster(broadcaster);

      const messageEvent = {
        ...createEvent({
          type: "message.received",
          source: "test",
          priority: EventPriority.NORMAL,
        }),
        platform: "dashboard",
        channel: "test-channel",
        userId: "user-1",
        userName: "Test",
        message: "hello",
        threadId: null,
        replyToId: null,
        isDm: true,
        isMention: false,
        attachments: [],
      } as unknown as MessageEvent;

      // The dispatcher's handleMessage path is heavily mocked; we only care
      // that NO routine SSE events fire for a non-routine event regardless
      // of the inner handler's behavior.
      try {
        await (
          dispatcher as unknown as { handleEvent: (e: Event) => Promise<void> }
        ).handleEvent(messageEvent);
      } catch {
        // Swallow — the message handler may throw on missing mocks; we
        // are only asserting on the broadcaster surface.
      }

      const kinds = broadcaster.events.map((e) => e.kind);
      expect(kinds).not.toContain("routine_started");
      expect(kinds).not.toContain("routine_completed");
    });

    it("survives a broken broadcaster (broadcastEvent throws → routine still runs)", async () => {
      const dispatcher = buildDispatcherWithBroadcaster({
        broadcastEvent: () => {
          throw new Error("sse writer down");
        },
      });
      vi.mocked(mockAgentCore.execute).mockResolvedValue(makeResult());

      const routineEvent: RoutineEvent = {
        ...createEvent({
          type: "routine.evening_review",
          source: "cron",
          priority: EventPriority.NORMAL,
        }),
        routine: "evening_review",
      };

      // No throw must surface even though both routine_started and
      // routine_completed broadcasts will raise.
      await expect(
        (
          dispatcher as unknown as { handleEvent: (e: Event) => Promise<void> }
        ).handleEvent(routineEvent),
      ).resolves.toBeUndefined();
    });
  });

  describe("triggerActivityScan", () => {
    it("queues routine.activity_scan when enough pending observations exist", async () => {
      const config = makeConfig({ activityScanMinObservations: 1 });
      const dispatcher = new EventDispatcher(
        eventBus,
        mockAgentCore,
        mockContextBuilder,
        mockGetTaskFlow,
        mockNotificationMgr,
        mockSessionMgr,
        mockMessageRecorder,
        mockAudit,
        db,
        config,
      );

      db.prepare(
        "INSERT INTO observations (source, ref, change_type, actor, payload) VALUES ('obsidian:primary', 'notes/test.md', 'modified', 'user', '{}')",
      ).run();

      const result = await dispatcher.triggerActivityScan("cron");

      expect(eventBus.size).toBe(1);
      const queued = await eventBus.get();
      expect(result).toMatchObject({ status: "queued", pendingCount: 1, forced: false });
      expect(queued?.type).toBe("routine.activity_scan");
      expect(queued?.source).toBe("cron");
      expect(queued?.data.pendingCount).toBe(1);
    });

    it("skips when pending observations are below the configured threshold", async () => {
      const config = makeConfig({ activityScanMinObservations: 2 });
      const dispatcher = new EventDispatcher(
        eventBus,
        mockAgentCore,
        mockContextBuilder,
        mockGetTaskFlow,
        mockNotificationMgr,
        mockSessionMgr,
        mockMessageRecorder,
        mockAudit,
        db,
        config,
      );

      db.prepare(
        "INSERT INTO observations (source, ref, change_type, actor, payload) VALUES ('obsidian:primary', 'notes/test.md', 'modified', 'user', '{}')",
      ).run();

      const result = await dispatcher.triggerActivityScan("cron");

      expect(result).toMatchObject({ status: "skipped", reason: "below_threshold", pendingCount: 1, forced: false });
      expect(eventBus.size).toBe(0);
    });

    it("skips while a morning routine retry is pending", async () => {
      const config = makeConfig({ activityScanMinObservations: 1 });
      const dispatcher = new EventDispatcher(
        eventBus,
        mockAgentCore,
        mockContextBuilder,
        mockGetTaskFlow,
        mockNotificationMgr,
        mockSessionMgr,
        mockMessageRecorder,
        mockAudit,
        db,
        config,
      );

      db.prepare(
        "INSERT INTO observations (source, ref, change_type, actor, payload) VALUES ('obsidian:primary', 'notes/test.md', 'modified', 'user', '{}')",
      ).run();
      // C5 fix: detection now uses task_context JSON, not task_description
      db.prepare(
        `INSERT INTO agent_schedule (scheduled_for, task_type, task_description, task_context, status)
         VALUES (datetime('now', '+5 minutes'), 'wake', 'Morning routine retry attempt 1/3',
                 '{"routine":"morning_routine","retryCount":1}', 'pending')`,
      ).run();

      const result = await dispatcher.triggerActivityScan("cron");

      expect(result).toMatchObject({ status: "skipped", reason: "morning_routine_active", forced: false });
      expect(eventBus.size).toBe(0);
    });

    it("is NOT fooled by a schedule row whose description legacy-matches but whose context is unrelated", async () => {
      // C5 regression guard: the old LIKE 'Morning routine retry%' check would
      // false-positive on any wake task whose description happened to start
      // with the same prefix (e.g., a user-scheduled reminder). The new
      // JSON-path check must only match task_context.routine='morning_routine'.
      const config = makeConfig({ activityScanMinObservations: 1 });
      const dispatcher = new EventDispatcher(
        eventBus,
        mockAgentCore,
        mockContextBuilder,
        mockGetTaskFlow,
        mockNotificationMgr,
        mockSessionMgr,
        mockMessageRecorder,
        mockAudit,
        db,
        config,
      );

      db.prepare(
        "INSERT INTO observations (source, ref, change_type, actor, payload) VALUES ('obsidian:primary', 'notes/test.md', 'modified', 'user', '{}')",
      ).run();
      db.prepare(
        `INSERT INTO agent_schedule (scheduled_for, task_type, task_description, task_context, status)
         VALUES (datetime('now', '+5 minutes'), 'wake', 'Morning routine retry write-up reminder',
                 '{"routine":"other_thing"}', 'pending')`,
      ).run();

      const result = await dispatcher.triggerActivityScan("cron");

      // This should NOT skip — the task isn't actually a morning routine retry
      expect(result).toMatchObject({ status: "queued" });
    });

    it("skips if a previous activity scan is still queued/in progress", async () => {
      const config = makeConfig({ activityScanMinObservations: 1 });
      const dispatcher = new EventDispatcher(
        eventBus,
        mockAgentCore,
        mockContextBuilder,
        mockGetTaskFlow,
        mockNotificationMgr,
        mockSessionMgr,
        mockMessageRecorder,
        mockAudit,
        db,
        config,
      );

      db.prepare(
        "INSERT INTO observations (source, ref, change_type, actor, payload) VALUES ('obsidian:primary', 'notes/test.md', 'modified', 'user', '{}')",
      ).run();

      const first = await dispatcher.triggerActivityScan("cron");
      const second = await dispatcher.triggerActivityScan("manual");

      expect(first).toMatchObject({ status: "queued", forced: false });
      expect(second).toMatchObject({ status: "skipped", reason: "activity_scan_in_progress", forced: false });
      expect(eventBus.size).toBe(1);
    });

    it("auto-clears a stale activityScanInProgress flag after the max-age window so an EventBus drop does not stuck the gate", async () => {
      // Regression for the silent-stall pattern around EventBus eviction:
      // - `triggerActivityScan` enqueues and flips the flag to true;
      // - the EventBus drops the event (queue saturation under maxSize)
      //   so `dispatchSafe`'s finally never runs;
      // - the flag stays true and every subsequent hourly tick short-
      //   circuits with `activity_scan_in_progress` until process restart.
      // The flag now carries a wall-clock timestamp and the getter auto-
      // clears entries older than ACTIVITY_SCAN_FLAG_MAX_AGE_MS.
      const config = makeConfig({ activityScanMinObservations: 1 });
      const dispatcher = new EventDispatcher(
        eventBus,
        mockAgentCore,
        mockContextBuilder,
        mockGetTaskFlow,
        mockNotificationMgr,
        mockSessionMgr,
        mockMessageRecorder,
        mockAudit,
        db,
        config,
      );

      db.prepare(
        "INSERT INTO observations (source, ref, change_type, actor, payload) VALUES ('obsidian:primary', 'notes/test.md', 'modified', 'user', '{}')",
      ).run();

      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date("2026-05-17T10:00:00.000Z"));
        const first = await dispatcher.triggerActivityScan("cron");
        expect(first).toMatchObject({ status: "queued" });
        // Drain the queued event WITHOUT going through dispatchSafe so
        // the flag stays true — this mirrors the EventBus-drop shape.
        await eventBus.get();

        // Two minutes later: still inside the max-age window → skip.
        vi.setSystemTime(new Date("2026-05-17T10:02:00.000Z"));
        const stillInWindow = await dispatcher.triggerActivityScan("manual");
        expect(stillInWindow).toMatchObject({
          status: "skipped",
          reason: "activity_scan_in_progress",
        });

        // Insert another observation so the next attempt has work to do
        // and any below_threshold path doesn't dominate the assertion.
        db.prepare(
          "INSERT INTO observations (source, ref, change_type, actor, payload) VALUES ('obsidian:primary', 'notes/later.md', 'modified', 'user', '{}')",
        ).run();

        // 31 minutes later: past the max-age window → auto-clear + queue.
        vi.setSystemTime(new Date("2026-05-17T10:31:00.000Z"));
        const afterStale = await dispatcher.triggerActivityScan("manual");
        expect(afterStale).toMatchObject({ status: "queued" });
      } finally {
        vi.useRealTimers();
      }
    });

    it("invokes the injected delegated-sync refresh before computing pendingCount", async () => {
      // Order matters: the refresh must run before pending-observation
      // counting so newly-fetched gmail/notion rows count toward the
      // threshold gate. Asserting via two visible side effects: the
      // refresh callback fires, and an observation it inserts before
      // resolving is included in `pendingCount`.
      const config = makeConfig({ activityScanMinObservations: 1 });
      const dispatcher = new EventDispatcher(
        eventBus,
        mockAgentCore,
        mockContextBuilder,
        mockGetTaskFlow,
        mockNotificationMgr,
        mockSessionMgr,
        mockMessageRecorder,
        mockAudit,
        db,
        config,
      );

      let refreshCalls = 0;
      dispatcher.setDelegatedSyncRefresh(async () => {
        refreshCalls += 1;
        db.prepare(
          "INSERT INTO observations (source, ref, change_type, actor, payload) VALUES ('mail:lifecycle', 'thr-1', 'created', 'user', '{}')",
        ).run();
      });

      const result = await dispatcher.triggerActivityScan("cron");

      expect(refreshCalls).toBe(1);
      expect(result).toMatchObject({ status: "queued", pendingCount: 1 });
    });

    it("does not invoke the delegated-sync refresh when setup blocks the run", async () => {
      const config = makeConfig({ activityScanMinObservations: 1 });
      const dispatcher = new EventDispatcher(
        eventBus,
        mockAgentCore,
        mockContextBuilder,
        mockGetTaskFlow,
        mockNotificationMgr,
        mockSessionMgr,
        mockMessageRecorder,
        mockAudit,
        db,
        config,
      );
      let refreshCalls = 0;
      dispatcher.setDelegatedSyncRefresh(async () => {
        refreshCalls += 1;
      });
      // Trip the morning-routine guard so we exit before the refresh hook.
      db.prepare(
        `INSERT INTO agent_schedule (scheduled_for, task_type, task_description, task_context, status)
         VALUES (datetime('now', '+5 minutes'), 'wake', 'Morning routine retry attempt 1/3',
                 '{"routine":"morning_routine","retryCount":1}', 'pending')`,
      ).run();

      const result = await dispatcher.triggerActivityScan("cron");

      expect(result).toMatchObject({ status: "skipped", reason: "morning_routine_active" });
      expect(refreshCalls).toBe(0);
    });

    it("proceeds with the activity scan when the delegated-sync refresh throws", async () => {
      // A stuck cadence subprocess must not starve the entire hourly loop.
      // The dispatcher catches the error, logs a warn, and proceeds with
      // whatever observations exist in the table.
      const config = makeConfig({ activityScanMinObservations: 1 });
      const dispatcher = new EventDispatcher(
        eventBus,
        mockAgentCore,
        mockContextBuilder,
        mockGetTaskFlow,
        mockNotificationMgr,
        mockSessionMgr,
        mockMessageRecorder,
        mockAudit,
        db,
        config,
      );
      dispatcher.setDelegatedSyncRefresh(async () => {
        throw new Error("subprocess died");
      });
      db.prepare(
        "INSERT INTO observations (source, ref, change_type, actor, payload) VALUES ('obsidian:primary', 'notes/test.md', 'modified', 'user', '{}')",
      ).run();

      const result = await dispatcher.triggerActivityScan("cron");

      expect(result).toMatchObject({ status: "queued", pendingCount: 1 });
    });

    it("allows manual force-trigger even when below the minimum observation threshold", async () => {
      const config = makeConfig({ activityScanMinObservations: 5 });
      const dispatcher = new EventDispatcher(
        eventBus,
        mockAgentCore,
        mockContextBuilder,
        mockGetTaskFlow,
        mockNotificationMgr,
        mockSessionMgr,
        mockMessageRecorder,
        mockAudit,
        db,
        config,
      );

      db.prepare(
        "INSERT INTO observations (source, ref, change_type, actor, payload) VALUES ('obsidian:primary', 'notes/test.md', 'modified', 'user', '{}')",
      ).run();

      const result = await dispatcher.triggerActivityScan("manual:api", { force: true });

      expect(result).toMatchObject({ status: "queued", pendingCount: 1, forced: true });
      expect(eventBus.size).toBe(1);
    });

    // ── HOURLY_CHECK_GATE_REDESIGN_PLAN.md — single-path gate wiring ──

    it("gate logs a stage3 audit row and emits the gate_decision block", async () => {
      const config = makeConfig({
        activityScanMinObservations: 1,
      });
      const dispatcher = new EventDispatcher(
        eventBus,
        mockAgentCore,
        mockContextBuilder,
        mockGetTaskFlow,
        mockNotificationMgr,
        mockSessionMgr,
        mockMessageRecorder,
        mockAudit,
        db,
        config,
      );
      // High-novelty observation forces stage3 via signal escalation.
      db.prepare(
        `INSERT INTO observations (source, ref, change_type, actor, payload, summary_status, novelty_score, summary_text, summary_at)
         VALUES ('obsidian:primary', 'notes/test.md', 'modified', 'user', '{}', 'done', 3, 'high', '2026-05-17T12:00:00Z')`,
      ).run();

      const result = await dispatcher.triggerActivityScan("cron");

      expect(result).toMatchObject({
        status: "queued",
        appliedStage: "stage3",
      });
      const auditRow = db
        .prepare(
          "SELECT detail FROM agent_actions WHERE action_type = 'activity_scan.gate'",
        )
        .get() as { detail: string } | undefined;
      expect(auditRow).toBeDefined();
      const detail = JSON.parse(auditRow!.detail);
      expect(detail.stage_reached).toBe("stage3");

      // Stage 3 event was enqueued with the gate decision block injected.
      const queued = await eventBus.get();
      expect(queued?.type).toBe("routine.activity_scan");
      expect(
        (queued?.data as { gateDecision?: { block?: string } }).gateDecision?.block,
      ).toContain("<gate_decision>");
    });

    it("gate silences a quiet tick via Stage 0 daemon-direct path", async () => {
      const dataDir = mkdtempSync(join(tmpdir(), "pa-stage0-silent-"));
      const contextDir = join(dataDir, "context");
      mkdirSync(contextDir, { recursive: true });
      mkdirSync(join(contextDir, "state"), { recursive: true });
      writeFileSync(
        join(contextDir, "state", "today.md"),
        [
          "# 2026-05-06 (Wednesday)",
          "> Day type: Weekday | Work focus: on | Study focus: off | Personal focus: on",
          "",
          "## User Schedule",
          "- 09:00 stand-up",
          "",
          "## Agent Plan",
          "",
          "## Agent Log",
          "- 09:00 routine ran",
          "",
        ].join("\n"),
      );
      seedManagementRules(dataDir);
      // Seed a recent Stage-3 row so the heartbeat doesn't force a run.
      db.prepare(
        `INSERT INTO agent_actions (action_type, result, detail, started_at, completed_at)
         VALUES ('activity_scan.gate', 'success', json(?), datetime('now', '-1 hour'), datetime('now', '-1 hour'))`,
      ).run(JSON.stringify({ stage_reached: "stage3" }));

      const config = {
        ...makeConfig({
          activityScanMinObservations: 1,
        }),
        dataDir,
      } as AgentConfig;
      // No pending observations + no signals → decideStage returns
      // stage0_silent. The dispatcher should NOT enqueue and should NOT
      // call agentRouter.execute.
      const dispatcher = new EventDispatcher(
        eventBus,
        mockAgentCore,
        mockContextBuilder,
        mockGetTaskFlow,
        mockNotificationMgr,
        mockSessionMgr,
        mockMessageRecorder,
        mockAudit,
        db,
        config,
        // Provide a today-write-lock so the silent path can actually
        // append the Agent Log line.
        new (await import("./today-write-lock.js")).InMemoryTodayWriteLockManager(60_000),
      );

      const result = await dispatcher.triggerActivityScan("cron", { force: true });

      expect(result).toMatchObject({
        status: "skipped",
        reason: "gate_stage0_silent",
        gateStage: "stage0_silent",
        appliedStage: "stage0_silent",
      });
      expect(eventBus.size).toBe(0);
      expect(mockAgentCore.execute).not.toHaveBeenCalled();

      const updated = readFileSync(join(contextDir, "state", "today.md"), "utf-8");
      expect(updated).toMatch(/\[activity_scan\] Quiet \(no_signals\)/);

      rmSync(dataDir, { recursive: true, force: true });
    });

    it("gate routes high-novelty observation to Stage 3 with gate_decision", async () => {
      const config = makeConfig({
        activityScanMinObservations: 1,
      });
      const dispatcher = new EventDispatcher(
        eventBus,
        mockAgentCore,
        mockContextBuilder,
        mockGetTaskFlow,
        mockNotificationMgr,
        mockSessionMgr,
        mockMessageRecorder,
        mockAudit,
        db,
        config,
      );
      // Insert an observation with a "done" summary at high novelty 3.
      db.prepare(
        `INSERT INTO observations (source, ref, change_type, actor, payload, summary_status, novelty_score, summary_text, summary_at)
         VALUES ('obsidian:primary', 'notes/important.md', 'modified', 'user', '{}', 'done', 3, 'high signal', '2026-05-06T12:00:00Z')`,
      ).run();
      // Recent gate row so heartbeat doesn't fire and the high_novelty
      // branch is reached.
      db.prepare(
        `INSERT INTO agent_actions (action_type, result, detail, started_at, completed_at)
         VALUES ('activity_scan.gate', 'success', json(?), datetime('now', '-1 hour'), datetime('now', '-1 hour'))`,
      ).run(JSON.stringify({ stage_reached: "stage3" }));

      const result = await dispatcher.triggerActivityScan("cron");

      expect(result.gateStage).toBe("stage3");
      expect(result.gateReason).toBe("high_novelty");
      expect(result.appliedStage).toBe("stage3");
      expect(result.status).toBe("queued");
      const queued = await eventBus.get();
      const data = queued?.data as { gateDecision?: { block?: string; reason?: string } };
      expect(data.gateDecision?.reason).toBe("high_novelty");
      expect(data.gateDecision?.block).toContain("high_novelty");
    });
  });

  // ── Setup gate — regression suite for the "Customize Your Rules" bug ──
  //
  // Before the fix, setup mode was tracked in a `Map<sessionId, mode>` keyed
  // by `conversation_sessions.id`. Whenever an activity_scan / morning routine
  // / any other autonomous turn patched today.md or roadmap.md during the
  // setup conversation, `onPromptContextChanged → markOwnerDmSessionStale`
  // fired, which closed the owner-DM session on the next user turn and
  // created a fresh one with a new id. The Map's lookup on the new id
  // returned `undefined`, so `promptKey` fell through from `setup.initial`
  // to `message.received.dm_first` and the agent "forgot" it was in setup,
  // asking the user about today's schedule instead of continuing rules
  // gathering.
  //
  // The fix is two-layered:
  //  (a) `currentSetupMode: SetupMode | null` — scope-agnostic, not keyed by
  //      session.id, survives internal session refresh.
  //  (b) `isAutonomousAllowed()` — gates all non-message event processing
  //      while either `rules/management.md` is missing (cold gate) OR a
  //      setup conversation is active (warm gate).
  describe("spawn gates (PREPASS_COST_REDUCTION_PLAN.md N2)", () => {
    function buildGateDispatcher(): EventDispatcher {
      return new EventDispatcher(
        eventBus,
        mockAgentCore,
        mockContextBuilder,
        mockGetTaskFlow,
        mockNotificationMgr,
        mockSessionMgr,
        mockMessageRecorder,
        mockAudit,
        db,
        makeConfig(),
      );
    }

    function makeHourlyEvent(): Event {
      const event = createEvent({
        type: "routine.activity_scan",
        source: "cron",
        priority: EventPriority.NORMAL,
      });
      Object.assign(event, {
        routine: "activity_scan",
        data: { pendingCount: 1 },
      });
      return event;
    }

    it("skips an autonomous event with the gate's reason and never dispatches", async () => {
      spawnGateEvaluateMock.mockResolvedValueOnce({
        skip: true,
        reason: "offline",
        backends: [
          {
            backendId: "claude",
            host: "api.anthropic.com",
            offline: true,
            authStatus: "ok",
            authShouldSkip: false,
            viable: false,
          },
        ],
      } as never);
      const dispatcher = buildGateDispatcher();

      await (
        dispatcher as unknown as { handleEvent: (e: Event) => Promise<void> }
      ).handleEvent(makeHourlyEvent());

      expect(mockAudit.logSkip).toHaveBeenCalledWith(
        expect.objectContaining({ type: "routine.activity_scan" }),
        "offline",
        "autonomous",
        expect.objectContaining({
          spawnGate: expect.objectContaining({
            backends: expect.arrayContaining([
              expect.objectContaining({ backendId: "claude", offline: true }),
            ]),
          }),
        }),
      );
      expect(mockAgentCore.execute).not.toHaveBeenCalled();
    });

    it("does not consult the gate for reactive (DM) events", async () => {
      spawnGateEvaluateMock.mockClear();
      const dispatcher = buildGateDispatcher();
      const dmEvent = createEvent({
        type: "message.received",
        source: "slack",
        priority: EventPriority.NORMAL,
      });
      Object.assign(dmEvent, {
        platform: "slack",
        channel: "D123",
        user: "U1",
        content: "hello",
        isDm: true,
        isMention: false,
      });

      await (
        dispatcher as unknown as { handleEvent: (e: Event) => Promise<void> }
      ).handleEvent(dmEvent);

      expect(spawnGateEvaluateMock).not.toHaveBeenCalled();
    });

    it("fails open when binding resolution throws — event still dispatches", async () => {
      spawnGateEvaluateMock.mockClear();
      vi.mocked(mockAgentCore.resolveBinding).mockImplementationOnce(() => {
        throw new Error("no binding for you");
      });
      const dispatcher = buildGateDispatcher();

      await (
        dispatcher as unknown as { handleEvent: (e: Event) => Promise<void> }
      ).handleEvent(makeHourlyEvent());

      // Gate never reached (binding threw before evaluate), and the skip
      // path did not fire — dispatch proceeded.
      expect(spawnGateEvaluateMock).not.toHaveBeenCalled();
      expect(mockAudit.logSkip).not.toHaveBeenCalledWith(
        expect.anything(),
        "offline",
        expect.anything(),
        expect.anything(),
      );
    });

    it("releases a claimed schedule row back to pending on a gate skip", async () => {
      spawnGateEvaluateMock.mockResolvedValueOnce({
        skip: true,
        reason: "auth_unhealthy",
        backends: [],
      } as never);
      const dispatcher = buildGateDispatcher();

      const scheduleId = Number(
        db
          .prepare(
            `INSERT INTO agent_schedule (task_type, task_description, scheduled_for, status)
             VALUES ('wake', 'gate test', datetime('now'), 'running')`,
          )
          .run().lastInsertRowid,
      );
      const event = createEvent({
        type: "scheduled.task",
        source: "schedule_watcher",
        priority: EventPriority.NORMAL,
      });
      Object.assign(event, { scheduleId });

      await (
        dispatcher as unknown as { handleEvent: (e: Event) => Promise<void> }
      ).handleEvent(event);

      const row = db
        .prepare("SELECT status FROM agent_schedule WHERE id = ?")
        .get(scheduleId) as { status: string };
      expect(row.status).toBe("pending");
      expect(mockAudit.logSkip).toHaveBeenCalledWith(
        expect.objectContaining({ type: "scheduled.task" }),
        "auth_unhealthy",
        "autonomous",
        expect.anything(),
      );
    });

    // ── requestedBackendId pin ────────────────────────────────────────
    //
    // Scheduled rows / integration cron events can pin a backend; the
    // router's backend-only override then routes to exactly that backend
    // with NO fallback. The gate must mirror that contract: evaluate the
    // pinned candidate alone, ignoring the default binding entirely.

    it("gates a pinned event on exactly the pinned backend — healthy pin dispatches even when the default binding is non-viable", async () => {
      spawnGateEvaluateMock.mockClear();
      // Anything other than the pinned single-candidate list (e.g. the
      // default binding's ["claude"]) reports non-viable — so a pass
      // here proves the gate consulted only the pin.
      spawnGateEvaluateMock.mockImplementationOnce((async (
        ...args: unknown[]
      ) => {
        const candidates = args[0] as string[];
        return candidates.length === 1 && candidates[0] === "codex"
          ? { skip: false, backends: [] }
          : { skip: true, reason: "offline", backends: [] };
      }) as never);
      const dispatcher = buildGateDispatcher();
      const event = makeHourlyEvent();
      Object.assign(event, { requestedBackendId: "codex" });

      await (
        dispatcher as unknown as { handleEvent: (e: Event) => Promise<void> }
      ).handleEvent(event);

      expect(spawnGateEvaluateMock).toHaveBeenCalledTimes(1);
      expect(spawnGateEvaluateMock).toHaveBeenCalledWith(["codex"]);
      // The hourly dispatch path may log unrelated pre-pass skips
      // (plan_drop:*); the spawn-gate reasons must be absent.
      const gateSkipReasons = vi
        .mocked(mockAudit.logSkip)
        .mock.calls.map((c) => c[1])
        .filter((r) => r === "offline" || r === "auth_unhealthy");
      expect(gateSkipReasons).toEqual([]);
      expect(mockAgentCore.execute).toHaveBeenCalled();
    });

    it("skips when the pinned backend is non-viable even though the default binding is healthy", async () => {
      spawnGateEvaluateMock.mockClear();
      spawnGateEvaluateMock.mockImplementationOnce((async (
        ...args: unknown[]
      ) => {
        const candidates = args[0] as string[];
        return candidates.length === 1 && candidates[0] === "gemini"
          ? { skip: true, reason: "auth_unhealthy", backends: [] }
          : { skip: false, backends: [] };
      }) as never);
      const dispatcher = buildGateDispatcher();
      const event = makeHourlyEvent();
      Object.assign(event, { requestedBackendId: "gemini" });

      await (
        dispatcher as unknown as { handleEvent: (e: Event) => Promise<void> }
      ).handleEvent(event);

      expect(spawnGateEvaluateMock).toHaveBeenCalledWith(["gemini"]);
      expect(mockAudit.logSkip).toHaveBeenCalledWith(
        expect.objectContaining({ type: "routine.activity_scan" }),
        "auth_unhealthy",
        "autonomous",
        expect.anything(),
      );
      expect(mockAgentCore.execute).not.toHaveBeenCalled();
    });

    it("ignores an invalid requestedBackendId and falls back to the default binding's candidates", async () => {
      spawnGateEvaluateMock.mockClear();
      const dispatcher = buildGateDispatcher();
      const event = makeHourlyEvent();
      Object.assign(event, { requestedBackendId: "openai" });

      await (
        dispatcher as unknown as { handleEvent: (e: Event) => Promise<void> }
      ).handleEvent(event);

      // Default binding mock: main=claude, fallback=null.
      expect(spawnGateEvaluateMock).toHaveBeenCalledWith(["claude"]);
    });

    // ── skip-audit throttle ───────────────────────────────────────────
    //
    // A released schedule row is due immediately, so the watcher re-claims
    // it every poll tick for the whole outage. The audit INSERT for the
    // same (schedule, reason) key is throttled to one per 10 minutes; the
    // row release itself must still happen on every skip.

    function insertRunningSchedule(): number {
      return Number(
        db
          .prepare(
            `INSERT INTO agent_schedule (task_type, task_description, scheduled_for, status)
             VALUES ('wake', 'gate throttle test', datetime('now'), 'running')`,
          )
          .run().lastInsertRowid,
      );
    }

    function makeScheduledEvent(scheduleId: number): Event {
      const event = createEvent({
        type: "scheduled.task",
        source: "schedule_watcher",
        priority: EventPriority.NORMAL,
      });
      Object.assign(event, { scheduleId });
      return event;
    }

    function setRunning(scheduleId: number): void {
      db.prepare("UPDATE agent_schedule SET status = 'running' WHERE id = ?")
        .run(scheduleId);
    }

    function getStatus(scheduleId: number): string {
      return (
        db
          .prepare("SELECT status FROM agent_schedule WHERE id = ?")
          .get(scheduleId) as { status: string }
      ).status;
    }

    it("throttles duplicate skip audit rows for the same (schedule, reason) but still releases the row every time", async () => {
      spawnGateEvaluateMock.mockClear();
      spawnGateEvaluateMock
        .mockResolvedValueOnce(
          { skip: true, reason: "offline", backends: [] } as never,
        )
        .mockResolvedValueOnce(
          { skip: true, reason: "offline", backends: [] } as never,
        );
      const dispatcher = buildGateDispatcher();
      const handle = (e: Event) =>
        (
          dispatcher as unknown as { handleEvent: (e: Event) => Promise<void> }
        ).handleEvent(e);
      const scheduleId = insertRunningSchedule();

      await handle(makeScheduledEvent(scheduleId));
      expect(mockAudit.logSkip).toHaveBeenCalledTimes(1);
      expect(getStatus(scheduleId)).toBe("pending");

      // Watcher re-claims the still-due row on the next tick…
      setRunning(scheduleId);
      await handle(makeScheduledEvent(scheduleId));

      // …the audit INSERT is throttled, but the release is NOT.
      expect(mockAudit.logSkip).toHaveBeenCalledTimes(1);
      expect(getStatus(scheduleId)).toBe("pending");
    });

    it("a different reason or a different schedule id still writes its own skip audit row", async () => {
      spawnGateEvaluateMock.mockClear();
      spawnGateEvaluateMock
        .mockResolvedValueOnce(
          { skip: true, reason: "offline", backends: [] } as never,
        )
        .mockResolvedValueOnce(
          { skip: true, reason: "auth_unhealthy", backends: [] } as never,
        )
        .mockResolvedValueOnce(
          { skip: true, reason: "offline", backends: [] } as never,
        );
      const dispatcher = buildGateDispatcher();
      const handle = (e: Event) =>
        (
          dispatcher as unknown as { handleEvent: (e: Event) => Promise<void> }
        ).handleEvent(e);
      const scheduleA = insertRunningSchedule();
      const scheduleB = insertRunningSchedule();

      await handle(makeScheduledEvent(scheduleA));
      expect(mockAudit.logSkip).toHaveBeenCalledTimes(1);

      // Same schedule, reason flips offline → auth_unhealthy: recorded
      // promptly (its own throttle key).
      setRunning(scheduleA);
      await handle(makeScheduledEvent(scheduleA));
      expect(mockAudit.logSkip).toHaveBeenCalledTimes(2);
      expect(mockAudit.logSkip).toHaveBeenLastCalledWith(
        expect.objectContaining({ type: "scheduled.task" }),
        "auth_unhealthy",
        "autonomous",
        expect.anything(),
      );

      // Different schedule row, same reason as A's first skip: its own
      // first row still lands.
      await handle(makeScheduledEvent(scheduleB));
      expect(mockAudit.logSkip).toHaveBeenCalledTimes(3);
      expect(getStatus(scheduleB)).toBe("pending");
    });
  });

  describe("setup gate", () => {
    it("isAutonomousAllowed returns setup_incomplete when rules/management.md is missing", () => {
      const emptyDataDir = mkdtempSync(join(tmpdir(), "pa-setup-cold-"));
      // Do NOT seed rules/management.md — simulate first boot pre-setup.
      const config = { ...makeConfig(), dataDir: emptyDataDir };
      // `makeConfig` auto-seeds, so undo that for this case.
      rmSync(join(emptyDataDir, "context", "rules", "management.md"), { force: true });

      const dispatcher = new EventDispatcher(
        eventBus,
        mockAgentCore,
        mockContextBuilder,
        mockGetTaskFlow,
        mockNotificationMgr,
        mockSessionMgr,
        mockMessageRecorder,
        mockAudit,
        db,
        config,
      );

      expect(dispatcher.isAutonomousAllowed()).toBe("setup_incomplete");
      rmSync(emptyDataDir, { recursive: true, force: true });
    });

    it("isAutonomousAllowed returns setup_in_progress after beginSetupMode", () => {
      const config = makeConfig();
      const dispatcher = new EventDispatcher(
        eventBus,
        mockAgentCore,
        mockContextBuilder,
        mockGetTaskFlow,
        mockNotificationMgr,
        mockSessionMgr,
        mockMessageRecorder,
        mockAudit,
        db,
        config,
      );

      expect(dispatcher.isAutonomousAllowed()).toBeNull();
      dispatcher.beginSetupMode("initial");
      expect(dispatcher.isAutonomousAllowed()).toBe("setup_in_progress");
      dispatcher.clearSetupMode();
      expect(dispatcher.isAutonomousAllowed()).toBeNull();
    });

    it("triggerActivityScan skips with reason=setup_incomplete when rules file missing", async () => {
      const emptyDataDir = mkdtempSync(join(tmpdir(), "pa-setup-cold-hourly-"));
      const config = { ...makeConfig({ activityScanMinObservations: 1 }), dataDir: emptyDataDir };
      rmSync(join(emptyDataDir, "context", "rules", "management.md"), { force: true });

      const dispatcher = new EventDispatcher(
        eventBus,
        mockAgentCore,
        mockContextBuilder,
        mockGetTaskFlow,
        mockNotificationMgr,
        mockSessionMgr,
        mockMessageRecorder,
        mockAudit,
        db,
        config,
      );

      db.prepare(
        "INSERT INTO observations (source, ref, change_type, actor, payload) VALUES ('obsidian:primary', 'notes/test.md', 'modified', 'user', '{}')",
      ).run();

      const result = await dispatcher.triggerActivityScan("cron");
      expect(result).toMatchObject({ status: "skipped", reason: "setup_incomplete" });
      expect(eventBus.size).toBe(0);

      rmSync(emptyDataDir, { recursive: true, force: true });
    });

    it("triggerActivityScan skips with reason=setup_in_progress while a setup conversation is active", async () => {
      const config = makeConfig({ activityScanMinObservations: 1 });
      const dispatcher = new EventDispatcher(
        eventBus,
        mockAgentCore,
        mockContextBuilder,
        mockGetTaskFlow,
        mockNotificationMgr,
        mockSessionMgr,
        mockMessageRecorder,
        mockAudit,
        db,
        config,
      );

      db.prepare(
        "INSERT INTO observations (source, ref, change_type, actor, payload) VALUES ('obsidian:primary', 'notes/test.md', 'modified', 'user', '{}')",
      ).run();

      dispatcher.beginSetupMode("update");
      const blocked = await dispatcher.triggerActivityScan("cron");
      expect(blocked).toMatchObject({ status: "skipped", reason: "setup_in_progress" });
      expect(eventBus.size).toBe(0);

      dispatcher.clearSetupMode();
      const resumed = await dispatcher.triggerActivityScan("cron");
      expect(resumed).toMatchObject({ status: "queued" });
    });

    it("dispatchSafe drops routine events via audit.logSkip while setup incomplete", async () => {
      const emptyDataDir = mkdtempSync(join(tmpdir(), "pa-setup-cold-routine-"));
      const config = { ...makeConfig(), dataDir: emptyDataDir };
      rmSync(join(emptyDataDir, "context", "rules", "management.md"), { force: true });

      const dispatcher = new EventDispatcher(
        eventBus,
        mockAgentCore,
        mockContextBuilder,
        mockGetTaskFlow,
        mockNotificationMgr,
        mockSessionMgr,
        mockMessageRecorder,
        mockAudit,
        db,
        config,
      );

      await (
        dispatcher as unknown as { handleEvent: (e: Event) => Promise<void> }
      ).handleEvent({
        ...createEvent({
          type: "routine.evening_review",
          source: "cron",
          priority: EventPriority.HIGH,
        }),
        routine: "evening_review",
      } as RoutineEvent);

      expect(mockAgentCore.execute).not.toHaveBeenCalled();
      expect(mockAudit.logSkip).toHaveBeenCalledWith(
        expect.objectContaining({ type: "routine.evening_review" }),
        "setup_incomplete",
        "autonomous",
      );

      rmSync(emptyDataDir, { recursive: true, force: true });
    });

    it("dashboard setup chat messages are NOT gated (users can still finish setup)", async () => {
      // Reactive message events must reach handleMessage even when the gate
      // is closed — otherwise the user cannot complete setup at all.
      const emptyDataDir = mkdtempSync(join(tmpdir(), "pa-setup-cold-dm-"));
      const config = { ...makeConfig(), dataDir: emptyDataDir };
      rmSync(join(emptyDataDir, "context", "rules", "management.md"), { force: true });

      vi.mocked(mockSessionMgr.getOrCreate).mockResolvedValue({
        id: 1,
        isActive: false,
        sessionId: null,
        model: "opus",
      });

      const dispatcher = new EventDispatcher(
        eventBus,
        mockAgentCore,
        mockContextBuilder,
        mockGetTaskFlow,
        mockNotificationMgr,
        mockSessionMgr,
        mockMessageRecorder,
        mockAudit,
        db,
        config,
      );
      dispatcher.beginSetupMode("initial");

      await (
        dispatcher as unknown as { handleEvent: (e: Event) => Promise<void> }
      ).handleEvent({
        ...createEvent({
          type: "message.received",
          source: "dashboard",
          priority: EventPriority.HIGH,
          data: { setupMode: "initial" },
        }),
        sender: "user",
        channel: "ch1",
        content: "Selected tools: ...",
        platform: "dashboard",
        threadId: null,
        isDm: true,
        isMention: false,
      } as MessageEvent);

      // The setup.initial prompt must be used, and agentCore.execute must
      // be called (message events bypass the gate).
      expect(mockGetTaskFlow).toHaveBeenCalledWith("setup.initial", "claude", expect.any(Object));
      expect(mockAgentCore.execute).toHaveBeenCalled();

      rmSync(emptyDataDir, { recursive: true, force: true });
    });

    it("setup mode survives simulated owner-DM session refresh (the core bug fix)", async () => {
      // This is the main regression test for the bug that prompted the fix.
      // Before: setupSessions map was keyed by session.id, so when
      // markOwnerDmSessionStale closed the owner-DM row mid-setup and the
      // next user turn got a fresh session with a different id, the map
      // lookup returned undefined and promptKey fell back to dm/dm_first.
      // After: currentSetupMode is scope-agnostic and survives any number
      // of internal session refreshes.
      const config = makeConfig();

      // First turn: session id 1, setupMode metadata on event.
      vi.mocked(mockSessionMgr.getOrCreate).mockResolvedValueOnce({
        id: 1,
        isActive: false,
        sessionId: null,
        model: "opus",
      });

      const dispatcher = new EventDispatcher(
        eventBus,
        mockAgentCore,
        mockContextBuilder,
        mockGetTaskFlow,
        mockNotificationMgr,
        mockSessionMgr,
        mockMessageRecorder,
        mockAudit,
        db,
        config,
      );
      dispatcher.beginSetupMode("initial");

      const firstEvent = {
        ...createEvent({
          type: "message.received",
          source: "dashboard",
          priority: EventPriority.HIGH,
          data: { setupMode: "initial" },
        }),
        sender: "user",
        channel: "ch1",
        content: "Selected tools: ...",
        platform: "dashboard",
        threadId: null,
        isDm: true,
        isMention: false,
      } as MessageEvent;
      await (
        dispatcher as unknown as { handleEvent: (e: Event) => Promise<void> }
      ).handleEvent(firstEvent);

      // Simulate: markOwnerDmSessionStale closed session 1, getOrCreate now
      // returns a BRAND NEW session 2. User sends their second setup turn
      // (no setupMode metadata this time — only /setup/start carries it).
      vi.mocked(mockSessionMgr.getOrCreate).mockResolvedValueOnce({
        id: 2, // ← different id, would have orphaned the old Map entry
        isActive: false,
        sessionId: null,
        model: "opus",
      });
      vi.mocked(mockGetTaskFlow).mockClear();
      vi.mocked(mockAgentCore.execute).mockClear();

      const secondEvent = {
        ...createEvent({
          type: "message.received",
          source: "dashboard",
          priority: EventPriority.HIGH,
          // NO setupMode metadata — only /setup/start sets it.
        }),
        sender: "user",
        channel: "ch1",
        content: "Quiet hours: 22:00-08:00, working hours 09:00-18:00",
        platform: "dashboard",
        threadId: null,
        isDm: true,
        isMention: false,
      } as MessageEvent;
      await (
        dispatcher as unknown as { handleEvent: (e: Event) => Promise<void> }
      ).handleEvent(secondEvent);

      // Must still use setup.initial — NOT message.received.dm_first.
      expect(mockGetTaskFlow).toHaveBeenCalledWith("setup.initial", "claude", expect.any(Object));
      expect(mockGetTaskFlow).not.toHaveBeenCalledWith("message.received.dm_first");
      expect(mockGetTaskFlow).not.toHaveBeenCalledWith("message.received.dm");
    });

    it("setup mode does NOT auto-expire — long setup conversations must stay gated", () => {
      // Regression guard: a previous iteration introduced a 30-minute
      // safety timeout that fired DURING legitimate long setup
      // conversations, re-opening the exact bug this state machine was
      // supposed to prevent. Setup mode must only clear on explicit
      // clearSetupMode() (called from /setup/save-rules).
      const config = makeConfig();
      const dispatcher = new EventDispatcher(
        eventBus,
        mockAgentCore,
        mockContextBuilder,
        mockGetTaskFlow,
        mockNotificationMgr,
        mockSessionMgr,
        mockMessageRecorder,
        mockAudit,
        db,
        config,
      );

      dispatcher.beginSetupMode("initial");
      expect(dispatcher.isAutonomousAllowed()).toBe("setup_in_progress");

      // Even after simulating 24 hours of wall-clock time, setup mode
      // must remain engaged.
      const realNow = Date.now();
      vi.spyOn(Date, "now").mockReturnValue(realNow + 24 * 60 * 60 * 1000);
      expect(dispatcher.isAutonomousAllowed()).toBe("setup_in_progress");
      expect(dispatcher.getCurrentSetupMode()).toBe("initial");
      vi.restoreAllMocks();
    });

    it("setup mode is persisted to runtime_state and restored on construction", () => {
      // Regression guard: a daemon crash / restart mid-setup must not
      // re-open the warm gate. Before persistence, the in-memory
      // currentSetupMode was lost on restart, autonomous work resumed,
      // and the update flow would race the dashboard conversation.
      const config = makeConfig();
      const first = new EventDispatcher(
        eventBus,
        mockAgentCore,
        mockContextBuilder,
        mockGetTaskFlow,
        mockNotificationMgr,
        mockSessionMgr,
        mockMessageRecorder,
        mockAudit,
        db,
        config,
      );
      first.beginSetupMode("update");
      expect(first.getCurrentSetupMode()).toBe("update");

      // Simulate restart: build a new dispatcher sharing the same DB.
      const second = new EventDispatcher(
        eventBus,
        mockAgentCore,
        mockContextBuilder,
        mockGetTaskFlow,
        mockNotificationMgr,
        mockSessionMgr,
        mockMessageRecorder,
        mockAudit,
        db,
        config,
      );
      expect(second.getCurrentSetupMode()).toBe("update");
      expect(second.isAutonomousAllowed()).toBe("setup_in_progress");

      // clearSetupMode on either instance clears the shared runtime_state row.
      second.clearSetupMode();
      const third = new EventDispatcher(
        eventBus,
        mockAgentCore,
        mockContextBuilder,
        mockGetTaskFlow,
        mockNotificationMgr,
        mockSessionMgr,
        mockMessageRecorder,
        mockAudit,
        db,
        config,
      );
      expect(third.getCurrentSetupMode()).toBeNull();
    });

    it("rejects non-dashboard DMs while setup is in progress (cross-platform lockout)", async () => {
      // The owner-DM scope is shared across Slack/Discord/Telegram/WhatsApp/
      // dashboard. Without this lockout, a Slack DM landing during a
      // dashboard setup conversation would be routed through setup.initial
      // against a message that has nothing to do with setup.
      const config = makeConfig();
      const dispatcher = new EventDispatcher(
        eventBus,
        mockAgentCore,
        mockContextBuilder,
        mockGetTaskFlow,
        mockNotificationMgr,
        mockSessionMgr,
        mockMessageRecorder,
        mockAudit,
        db,
        config,
      );
      dispatcher.beginSetupMode("initial");

      vi.mocked(mockNotificationMgr.send).mockClear();
      vi.mocked(mockAgentCore.execute).mockClear();

      const slackDm = {
        ...createEvent({
          type: "message.received",
          source: "slack",
          priority: EventPriority.HIGH,
        }),
        sender: "U12345",
        channel: "D12345",
        content: "ping",
        platform: "slack",
        threadId: null,
        isDm: true,
        isMention: false,
      } as MessageEvent;
      await (
        dispatcher as unknown as { handleEvent: (e: Event) => Promise<void> }
      ).handleEvent(slackDm);

      expect(mockAgentCore.execute).not.toHaveBeenCalled();
      expect(mockNotificationMgr.send).toHaveBeenCalledWith(
        expect.stringContaining("Setup is in progress"),
        expect.objectContaining({ platform: "slack" }),
      );
      expect(mockAudit.logSkip).toHaveBeenCalledWith(
        expect.objectContaining({ platform: "slack" }),
        "setup_in_progress",
        "reactive",
      );
    });

    it("dashboard DMs are still accepted during setup (lockout is platform-scoped)", async () => {
      const config = makeConfig();
      vi.mocked(mockSessionMgr.getOrCreate).mockResolvedValue({
        id: 1,
        isActive: false,
        sessionId: null,
        model: "opus",
      });

      const dispatcher = new EventDispatcher(
        eventBus,
        mockAgentCore,
        mockContextBuilder,
        mockGetTaskFlow,
        mockNotificationMgr,
        mockSessionMgr,
        mockMessageRecorder,
        mockAudit,
        db,
        config,
      );
      dispatcher.beginSetupMode("update");

      vi.mocked(mockAgentCore.execute).mockClear();
      vi.mocked(mockGetTaskFlow).mockClear();

      const dashboardDm = {
        ...createEvent({
          type: "message.received",
          source: "dashboard",
          priority: EventPriority.HIGH,
        }),
        sender: "user",
        channel: "ch1",
        content: "I want to change notification hours",
        platform: "dashboard",
        threadId: null,
        isDm: true,
        isMention: false,
      } as MessageEvent;
      await (
        dispatcher as unknown as { handleEvent: (e: Event) => Promise<void> }
      ).handleEvent(dashboardDm);

      expect(mockGetTaskFlow).toHaveBeenCalledWith("setup.update", "claude", expect.any(Object));
      expect(mockAgentCore.execute).toHaveBeenCalled();
    });
  });

  // ── Messaging bang-commands (`!stop`/`!start`/`!cost`/`!report`) ──
  //
  // The bang-command interceptor lives at the very top of `handleMessage`
  // (docs/design/backlog/messaging-bang-commands.md §6.2). These regression
  // tests pin the two highest-leverage invariants:
  //   - I-3: while paused, EVERY DM short-circuits without invoking a
  //     backend, including non-bang messages that previously bypassed the
  //     `dispatchSafe` autonomous-gate (only `!isReactive` is gated there).
  //   - I-7: the pause flag persists across daemon restart via runtime_state.

  describe("user_paused gate", () => {
    it("isAutonomousAllowed returns 'user_paused' when runtime_state has the flag", async () => {
      const config = makeConfig();
      const dispatcher = new EventDispatcher(
        eventBus,
        mockAgentCore,
        mockContextBuilder,
        mockGetTaskFlow,
        mockNotificationMgr,
        mockSessionMgr,
        mockMessageRecorder,
        mockAudit,
        db,
        config,
      );
      const { setUserPaused, clearUserPaused } = await import(
        "../db/runtime-state.js"
      );
      setUserPaused(db, {
        since: new Date().toISOString(),
        source: "!stop",
        byPlatform: "slack",
      });
      expect(dispatcher.isAutonomousAllowed()).toBe("user_paused");
      clearUserPaused(db);
      expect(dispatcher.isAutonomousAllowed()).toBeNull();
    });

    it("triggerActivityScan skips with reason='user_paused' while paused", async () => {
      const config = makeConfig({ activityScanMinObservations: 1 });
      const dispatcher = new EventDispatcher(
        eventBus,
        mockAgentCore,
        mockContextBuilder,
        mockGetTaskFlow,
        mockNotificationMgr,
        mockSessionMgr,
        mockMessageRecorder,
        mockAudit,
        db,
        config,
      );
      db.prepare(
        "INSERT INTO observations (source, ref, change_type, actor, payload) VALUES ('obsidian:primary', 'notes/test.md', 'modified', 'user', '{}')",
      ).run();
      const { setUserPaused } = await import("../db/runtime-state.js");
      setUserPaused(db, {
        since: new Date().toISOString(),
        source: "!stop",
        byPlatform: "slack",
      });
      const blocked = await dispatcher.triggerActivityScan("cron");
      expect(blocked).toMatchObject({
        status: "skipped",
        reason: "user_paused",
      });
      expect(eventBus.size).toBe(0);
    });

    it("paused state survives 'restart': new dispatcher reads the same flag", async () => {
      const config = makeConfig();
      const first = new EventDispatcher(
        eventBus,
        mockAgentCore,
        mockContextBuilder,
        mockGetTaskFlow,
        mockNotificationMgr,
        mockSessionMgr,
        mockMessageRecorder,
        mockAudit,
        db,
        config,
      );
      const { setUserPaused } = await import("../db/runtime-state.js");
      setUserPaused(db, {
        since: new Date().toISOString(),
        source: "!stop",
        byPlatform: "slack",
      });
      expect(first.isAutonomousAllowed()).toBe("user_paused");

      const second = new EventDispatcher(
        eventBus,
        mockAgentCore,
        mockContextBuilder,
        mockGetTaskFlow,
        mockNotificationMgr,
        mockSessionMgr,
        mockMessageRecorder,
        mockAudit,
        db,
        config,
      );
      expect(second.isAutonomousAllowed()).toBe("user_paused");
    });
  });

  describe("bang-command interceptor wiring", () => {
    it("paused non-bang DM short-circuits: notify is sent and agentRouter.execute is NOT called", async () => {
      const config = makeConfig();
      const dispatcher = new EventDispatcher(
        eventBus,
        mockAgentCore,
        mockContextBuilder,
        mockGetTaskFlow,
        mockNotificationMgr,
        mockSessionMgr,
        mockMessageRecorder,
        mockAudit,
        db,
        config,
      );
      const { createDefaultBangCommandRegistry } = await import(
        "./bang-commands/index.js"
      );
      dispatcher.setBangCommandRegistry(createDefaultBangCommandRegistry());
      const { setUserPaused } = await import("../db/runtime-state.js");
      setUserPaused(db, {
        since: new Date().toISOString(),
        source: "!stop",
        byPlatform: "slack",
      });
      const dmEvent = {
        ...createEvent({
          type: "message.received",
          source: "slack",
          priority: EventPriority.HIGH,
        }),
        sender: "owner",
        channel: "D1",
        content: "hello there",
        platform: "slack",
        threadId: null,
        isDm: true,
        isMention: false,
      } as MessageEvent;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (dispatcher as any).handleMessage(dmEvent);
      expect(mockAgentCore.execute).not.toHaveBeenCalled();
      expect(mockNotificationMgr.send).toHaveBeenCalledTimes(1);
      const sentText = (mockNotificationMgr.send as unknown as {
        mock: { calls: [string][] };
      }).mock.calls[0]?.[0];
      expect(sentText).toMatch(/^\[SYSTEM · paused\]/);
      expect(mockAudit.logBangCommand).toHaveBeenCalledWith(
        expect.anything(),
        { command: "(non-command)", status: "paused_decline" },
      );
    });

    it("`!stop` from owner DM pauses the agent without backend dispatch", async () => {
      const config = makeConfig();
      const dispatcher = new EventDispatcher(
        eventBus,
        mockAgentCore,
        mockContextBuilder,
        mockGetTaskFlow,
        mockNotificationMgr,
        mockSessionMgr,
        mockMessageRecorder,
        mockAudit,
        db,
        config,
      );
      const { createDefaultBangCommandRegistry } = await import(
        "./bang-commands/index.js"
      );
      dispatcher.setBangCommandRegistry(createDefaultBangCommandRegistry());
      const dmEvent = {
        ...createEvent({
          type: "message.received",
          source: "slack",
          priority: EventPriority.HIGH,
        }),
        sender: "owner",
        channel: "D1",
        content: "!stop",
        platform: "slack",
        threadId: null,
        isDm: true,
        isMention: false,
      } as MessageEvent;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (dispatcher as any).handleMessage(dmEvent);
      expect(mockAgentCore.execute).not.toHaveBeenCalled();
      expect(dispatcher.isAutonomousAllowed()).toBe("user_paused");
    });
  });

  // ── Phase 9: executeWithRetry wrapper + quota notification dedupe ──
  //
  // These directly exercise the private methods via dispatcher-as-any so
  // we don't need a live agent or network stack. The retry wrapper is
  // small enough to test in isolation, and quota dedupe is a stateful
  // flag that would be annoying to verify via the full event pipeline.

  describe("executeWithRetry", () => {
    // Use a real setTimeout stub instead of vitest fake timers: fake timers
    // interact badly with vi.fn().mockImplementation(async () => { throw … })
    // and surface the inner throw as an "unhandled rejection" even though
    // executeWithRetry's own try/catch handles it. Stubbing setTimeout to
    // fire synchronously is cleaner and avoids the vitest runner's
    // promise-tracking from intercepting the rejection.
    let originalSetTimeout: typeof globalThis.setTimeout;
    beforeEach(() => {
      originalSetTimeout = globalThis.setTimeout;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis as any).setTimeout = ((cb: (...args: unknown[]) => void) => {
        cb();
        return 0 as unknown as ReturnType<typeof setTimeout>;
      }) as unknown as typeof setTimeout;
    });
    afterEach(() => {
      globalThis.setTimeout = originalSetTimeout;
    });

    function makeDispatcher(config = makeConfig()) {
      return new EventDispatcher(
        eventBus,
        mockAgentCore,
        mockContextBuilder,
        mockGetTaskFlow,
        mockNotificationMgr,
        mockSessionMgr,
        mockMessageRecorder,
        mockAudit,
        db,
        config,
      );
    }

    function makeTestEvent(): Event {
      return createEvent({
        type: "routine.evening_review",
        source: "cron",
        priority: EventPriority.NORMAL,
      });
    }

    // NOTE: we use `mockImplementation` with an inline throw instead of
    // `mockRejectedValue` / `mockRejectedValueOnce`. The `vi.fn()` rejected-
    // value helpers eagerly construct a Promise.reject at mock-setup time
    // that vitest's runner reports as an unhandled rejection even when the
    // mock's call site catches the error cleanly. A plain thrown-value
    // implementation creates a fresh rejection only on each invocation and
    // is always paired with a caller-side `try/catch` inside executeWithRetry.

    it("returns the fn() result on first success without retrying", async () => {
      const dispatcher = makeDispatcher();
      const fn = vi.fn().mockImplementation(async () => "ok");
      const result = await (
        dispatcher as unknown as { errorRouter: {
          executeWithRetry: <T>(fn: () => Promise<T>, event: Event) => Promise<T>;
        } }
      ).errorRouter.executeWithRetry(fn, makeTestEvent());
      expect(result).toBe("ok");
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it("retries once on 5xx server error then returns success", async () => {
      const dispatcher = makeDispatcher();
      let call = 0;
      const fn = vi.fn().mockImplementation(async () => {
        call++;
        if (call === 1) throw Object.assign(new Error("server error"), { status: 502 });
        return "ok-after-retry";
      });

      const promise = (
        dispatcher as unknown as { errorRouter: {
          executeWithRetry: <T>(fn: () => Promise<T>, event: Event) => Promise<T>;
        } }
      ).errorRouter.executeWithRetry(fn, makeTestEvent());

      await expect(promise).resolves.toBe("ok-after-retry");
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it("retries once on 5xx errors", async () => {
      const dispatcher = makeDispatcher();
      const serverError = Object.assign(new Error("upstream died"), { status: 503 });
      let call = 0;
      const fn = vi.fn().mockImplementation(async () => {
        call++;
        if (call === 1) throw serverError;
        return "ok";
      });

      const promise = (
        dispatcher as unknown as { errorRouter: {
          executeWithRetry: <T>(fn: () => Promise<T>, event: Event) => Promise<T>;
        } }
      ).errorRouter.executeWithRetry(fn, makeTestEvent());

      await expect(promise).resolves.toBe("ok");
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it("does NOT retry on quota errors (C1)", async () => {
      const dispatcher = makeDispatcher();
      const quotaErr = Object.assign(new Error("rate limit exceeded"), { status: 429 });
      const fn = vi.fn().mockImplementation(async () => {
        throw quotaErr;
      });

      const promise = (
        dispatcher as unknown as { errorRouter: {
          executeWithRetry: <T>(fn: () => Promise<T>, event: Event) => Promise<T>;
        } }
      ).errorRouter.executeWithRetry(fn, makeTestEvent());

      await expect(promise).rejects.toBe(quotaErr);
      expect(fn).toHaveBeenCalledTimes(1); // no second attempt
    });

    it("does NOT retry on BackendDecisiveFailure", async () => {
      const dispatcher = makeDispatcher();
      const failure = new BackendDecisiveFailure("claude", "timeout", new Error("timed out"));
      const fn = vi.fn().mockImplementation(async () => {
        throw failure;
      });

      const promise = (
        dispatcher as unknown as { errorRouter: {
          executeWithRetry: <T>(fn: () => Promise<T>, event: Event) => Promise<T>;
        } }
      ).errorRouter.executeWithRetry(fn, makeTestEvent());

      await expect(promise).rejects.toBe(failure);
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it("does NOT retry on BackendRouterHandledError", async () => {
      const dispatcher = makeDispatcher();
      const mainFailure = new BackendDecisiveFailure("claude", "quota", new Error("quota"));
      const handled = new BackendRouterHandledError("handled", mainFailure, mainFailure);
      const fn = vi.fn().mockImplementation(async () => {
        throw handled;
      });

      const promise = (
        dispatcher as unknown as { errorRouter: {
          executeWithRetry: <T>(fn: () => Promise<T>, event: Event) => Promise<T>;
        } }
      ).errorRouter.executeWithRetry(fn, makeTestEvent());

      await expect(promise).rejects.toBe(handled);
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it("does NOT retry on 4xx errors other than quota", async () => {
      const dispatcher = makeDispatcher();
      const badReq = Object.assign(new Error("bad request"), { status: 400 });
      const fn = vi.fn().mockImplementation(async () => {
        throw badReq;
      });

      const promise = (
        dispatcher as unknown as { errorRouter: {
          executeWithRetry: <T>(fn: () => Promise<T>, event: Event) => Promise<T>;
        } }
      ).errorRouter.executeWithRetry(fn, makeTestEvent());

      await expect(promise).rejects.toBe(badReq);
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it("stops after the second attempt even if the retry also fails", async () => {
      const dispatcher = makeDispatcher();
      const serverError = Object.assign(new Error("upstream died"), { status: 500 });
      const fn = vi.fn().mockImplementation(async () => {
        throw serverError;
      });

      const promise = (
        dispatcher as unknown as { errorRouter: {
          executeWithRetry: <T>(fn: () => Promise<T>, event: Event) => Promise<T>;
        } }
      ).errorRouter.executeWithRetry(fn, makeTestEvent());

      await expect(promise).rejects.toBe(serverError);
      expect(fn).toHaveBeenCalledTimes(2); // max 2 attempts (1 initial + 1 retry)
    });

    it("does not mutate event.data across retry attempts (C3)", async () => {
      const dispatcher = makeDispatcher();
      const event = createEvent({
        type: "routine.evening_review",
        source: "cron",
        priority: EventPriority.NORMAL,
        data: { originalField: "keep" },
      });
      const originalSerialized = JSON.stringify(event.data);

      let call = 0;
      const fn = vi.fn().mockImplementation(async () => {
        call++;
        if (call === 1) throw Object.assign(new Error("server error"), { status: 500 });
        return "ok";
      });

      const promise = (
        dispatcher as unknown as { errorRouter: {
          executeWithRetry: <T>(fn: () => Promise<T>, e: Event) => Promise<T>;
        } }
      ).errorRouter.executeWithRetry(fn, event);

      await promise;

      // event.data must be byte-identical to the pre-retry snapshot
      expect(JSON.stringify(event.data)).toBe(originalSerialized);
      expect((event.data as { isRetry?: unknown }).isRetry).toBeUndefined();
      expect((event.data as { attempt?: unknown }).attempt).toBeUndefined();
    });
  });

  describe("backend failure handling", () => {
    function makeDispatcher() {
      return new EventDispatcher(
        eventBus,
        mockAgentCore,
        mockContextBuilder,
        mockGetTaskFlow,
        mockNotificationMgr,
        mockSessionMgr,
        mockMessageRecorder,
        mockAudit,
        db,
        makeConfig(),
      );
    }

    it("sends a quota reply for interactive events", async () => {
      const dispatcher = makeDispatcher();
      const messageEvent = {
        ...createEvent({
          type: "message.received",
          source: "dashboard",
          priority: EventPriority.HIGH,
        }),
        sender: "user",
        channel: "dashboard-ch",
        content: "hello",
        platform: "dashboard",
        threadId: null,
        isDm: true,
        isMention: false,
      } as MessageEvent;
      const quotaErr = new BackendQuotaError(
        "claude",
        "rate_limited",
        {
          hour: 1,
          minute: 0,
          timeZone: "America/Los_Angeles",
          rawLabel: "1am (America/Los_Angeles)",
        },
        "quota exceeded",
      );

      await (
        dispatcher as unknown as { errorRouter: {
          handleError: (e: Event, err: Error) => Promise<void>;
        } }
      ).errorRouter.handleError(messageEvent, quotaErr);

      expect(mockNotificationMgr.send).toHaveBeenCalledTimes(1);
      expect(mockNotificationMgr.send).toHaveBeenCalledWith(
        expect.stringContaining("usage limit"),
        messageEvent,
      );
    });

    it("does not emit a duplicate reply when the router already handled the failure", async () => {
      const dispatcher = makeDispatcher();
      const messageEvent = {
        ...createEvent({
          type: "message.received",
          source: "dashboard",
          priority: EventPriority.HIGH,
        }),
        sender: "user",
        channel: "dashboard-ch",
        content: "hello",
        platform: "dashboard",
        threadId: null,
        isDm: true,
        isMention: false,
      } as MessageEvent;
      const mainFailure = new BackendQuotaError(
        "claude",
        "rate_limited",
        null,
        "quota exceeded",
      );
      const handledError = new BackendRouterHandledError(
        "handled by router",
        mainFailure,
        mainFailure,
      );

      await (
        dispatcher as unknown as { errorRouter: {
          handleError: (e: Event, err: Error) => Promise<void>;
        } }
      ).errorRouter.handleError(messageEvent, handledError);

      expect(mockNotificationMgr.send).not.toHaveBeenCalled();
    });

    it("does not short-circuit future turns after a quota error", async () => {
      const dispatcher = makeDispatcher();
      const messageEvent = {
        ...createEvent({
          type: "message.received",
          source: "dashboard",
          priority: EventPriority.HIGH,
        }),
        sender: "user",
        channel: "dashboard-ch",
        content: "hello again",
        platform: "dashboard",
        threadId: null,
        isDm: true,
        isMention: false,
      } as MessageEvent;
      const quotaErr = new BackendQuotaError(
        "claude",
        "rate_limited",
        null,
        "quota exceeded",
      );

      await (
        dispatcher as unknown as { errorRouter: {
          handleError: (e: Event, err: Error) => Promise<void>;
        } }
      ).errorRouter.handleError(messageEvent, quotaErr);

      vi.mocked(mockNotificationMgr.send).mockClear();
      const executeSpy = vi.spyOn(mockAgentCore, "execute");

      await (
        dispatcher as unknown as {
          dispatchSafe: (e: Event) => Promise<void>;
        }
      ).dispatchSafe(messageEvent);

      expect(executeSpy).toHaveBeenCalledTimes(1);
      expect(mockNotificationMgr.send).toHaveBeenCalledWith(
        "test output",
        messageEvent,
        { originSessionId: 1 },
      );
    });

    it("marks scheduled tasks as failed when the router already handled backend failure", async () => {
      const dispatcher = makeDispatcher();
      const taskEvent = {
        ...createEvent({
          type: "scheduled.task",
          source: "wake",
          priority: EventPriority.NORMAL,
        }),
        task: "quota during task",
        taskContext: {},
        scheduleId: 1,
        requestedModel: "opus",
      } as AgentTaskEvent;

      db.prepare(
        `INSERT INTO agent_schedule (
          id,
          scheduled_for,
          task_type,
          task_description,
          task_context,
          correlation_id,
          model,
          status
        ) VALUES (
          1,
          datetime('now'),
          'wake',
          'quota during task',
          '{}',
          'corr-2',
          'opus',
          'running'
        )`,
      ).run();

      const mainFailure = new BackendQuotaError(
        "claude",
        "rate_limited",
        null,
        "quota exceeded",
      );
      const handledError = new BackendRouterHandledError(
        "handled by router",
        mainFailure,
        mainFailure,
      );

      await (
        dispatcher as unknown as { errorRouter: {
          handleError: (e: Event, err: Error) => Promise<void>;
        } }
      ).errorRouter.handleError(taskEvent, handledError);

      const row = db.prepare(
        "SELECT status FROM agent_schedule WHERE id = 1",
      ).get() as { status: string };
      expect(row.status).toBe("failed");
      expect(mockNotificationMgr.send).not.toHaveBeenCalled();
    });
  });

  describe("context tracking (Phase 6)", () => {
    // Time-sensitive non-routine events still go through executeDefault,
    // which makes this a good place to assert that contextUpdated reaches audit.
    function makeApproachingEvent(): CalendarChangeEvent {
      return {
        ...createEvent({
          type: "schedule.approaching",
          source: "calendar",
          priority: EventPriority.NORMAL,
        }),
        calendarId: "primary",
        eventTitle: "Design review",
        startTime: new Date("2026-04-07T10:00:00Z"),
        endTime: new Date("2026-04-07T11:00:00Z"),
        changeType: "modified",
      } as CalendarChangeEvent;
    }

    it("propagates contextUpdated=true from AgentResult to audit.logAction", async () => {
      const config = makeConfig();
      mockAgentCore.execute = vi
        .fn()
        .mockResolvedValue(makeResult({ contextUpdated: true }));

      const dispatcher = new EventDispatcher(
        eventBus,
        mockAgentCore,
        mockContextBuilder,
        mockGetTaskFlow,
        mockNotificationMgr,
        mockSessionMgr,
        mockMessageRecorder,
        mockAudit,
        db,
        config,
      );

      await (
        dispatcher as unknown as {
          handleEvent: (e: Event) => Promise<void>;
        }
      ).handleEvent(makeApproachingEvent());

      expect(mockAudit.logAction).toHaveBeenCalledWith(
        expect.objectContaining({ contextUpdated: true }),
      );
    });

    it("propagates contextUpdated=false when agent did not update context", async () => {
      const config = makeConfig();
      mockAgentCore.execute = vi
        .fn()
        .mockResolvedValue(makeResult({ contextUpdated: false }));

      const dispatcher = new EventDispatcher(
        eventBus,
        mockAgentCore,
        mockContextBuilder,
        mockGetTaskFlow,
        mockNotificationMgr,
        mockSessionMgr,
        mockMessageRecorder,
        mockAudit,
        db,
        config,
      );

      await (
        dispatcher as unknown as {
          handleEvent: (e: Event) => Promise<void>;
        }
      ).handleEvent(makeApproachingEvent());

      expect(mockAudit.logAction).toHaveBeenCalledWith(
        expect.objectContaining({ contextUpdated: false }),
      );
    });
  });

  describe("morning routine retry (Phase 7)", () => {
    // Each test runs against an isolated tmp dataDir so we can control
    // whether today.md exists under {dataDir}/context/.
    let tmpRoot: string;
    let contextDir: string;

    beforeEach(() => {
      tmpRoot = mkdtempSync(join(tmpdir(), "pa-dispatcher-retry-"));
      contextDir = join(tmpRoot, "context");
      mkdirSync(contextDir, { recursive: true });
      mkdirSync(join(contextDir, "state"), { recursive: true });
    });

    afterEach(() => {
      rmSync(tmpRoot, { recursive: true, force: true });
    });

    function makeMorningEvent(data: Record<string, unknown> = {}) {
      return {
        ...createEvent({
          type: "routine.morning_routine",
          source: "cron",
          priority: EventPriority.NORMAL,
          data,
        }),
        routine: "morning_routine",
      };
    }

    it("retries instead of failing when the today.md write lock is already held", async () => {
      const config = makeConfig({ dataDir: tmpRoot });
      const dispatcher = new EventDispatcher(
        eventBus,
        mockAgentCore,
        mockContextBuilder,
        mockGetTaskFlow,
        mockNotificationMgr,
        mockSessionMgr,
        mockMessageRecorder,
        mockAudit,
        db,
        config,
        {
          acquire: () => ({ ok: false as const, holder: "lock-held" }),
          release: () => false,
          isHeldBy: () => false,
          getHolder: () => "lock-held",
        },
      );

      await (
        dispatcher as unknown as {
          handleEvent: (e: Event) => Promise<void>;
        }
      ).handleEvent(makeMorningEvent());

      const rows = db
        .prepare(
          `SELECT status, json_extract(task_context, '$.routine') AS routine
             FROM agent_schedule`,
        )
        .all() as { status: string; routine: string }[];

      expect(rows).toEqual([
        { status: "pending", routine: "morning_routine" },
      ]);
      expect(mockAgentCore.execute).not.toHaveBeenCalled();
    });

    it("schedules a retry when today.md is missing after morning routine", async () => {
      const config = makeConfig({ dataDir: tmpRoot });
      const dispatcher = new EventDispatcher(
        eventBus,
        mockAgentCore,
        mockContextBuilder,
        mockGetTaskFlow,
        mockNotificationMgr,
        mockSessionMgr,
        mockMessageRecorder,
        mockAudit,
        db,
        config,
      );

      // today.md deliberately NOT created — retry should fire.
      await (
        dispatcher as unknown as {
          handleEvent: (e: Event) => Promise<void>;
        }
      ).handleEvent(makeMorningEvent());

      const rows = db
        .prepare(
          "SELECT task_type, model, status, task_description, task_context FROM agent_schedule",
        )
        .all() as {
        task_type: string;
        model: string;
        status: string;
        task_description: string;
        task_context: string;
      }[];

      expect(rows).toHaveLength(1);
      expect(rows[0].task_type).toBe("wake");
      expect(rows[0].model).toBeNull();
      expect(rows[0].status).toBe("pending");
      expect(rows[0].task_description).toContain("attempt 1/3");
      const ctx = JSON.parse(rows[0].task_context);
      expect(ctx.routine).toBe("morning_routine");
      expect(ctx.retryCount).toBe(1);
    });

    it("preserves deferred catchup metadata when startup morning routine schedules a retry", async () => {
      const config = makeConfig({ dataDir: tmpRoot });
      const dispatcher = new EventDispatcher(
        eventBus,
        mockAgentCore,
        mockContextBuilder,
        mockGetTaskFlow,
        mockNotificationMgr,
        mockSessionMgr,
        mockMessageRecorder,
        mockAudit,
        db,
        config,
      );

      await (
        dispatcher as unknown as {
          handleEvent: (e: Event) => Promise<void>;
        }
      ).handleEvent(makeMorningEvent({
        postCatchupRoutines: ["evening_review", "weekly_review"],
        postCatchupActivityScan: true,
        deferPostMorningCatchupsUntilStartupReady: true,
      }));

      const row = db
        .prepare("SELECT task_context FROM agent_schedule WHERE task_type = 'wake'")
        .get() as { task_context: string };
      const ctx = JSON.parse(row.task_context);
      expect(ctx.postCatchupRoutines).toEqual(["evening_review", "weekly_review"]);
      expect(ctx.postCatchupActivityScan).toBe(true);
    });

    it("does NOT schedule a retry when today.md was generated", async () => {
      const config = makeConfig({ dataDir: tmpRoot });
      // Simulate a successful morning routine: today.md exists.
      writeFileSync(
        join(contextDir, "state", "today.md"),
        `# ${getAgentDayDateStr(config.timezone || undefined, config.dayBoundaryHour)}\n`,
      );

      const dispatcher = new EventDispatcher(
        eventBus,
        mockAgentCore,
        mockContextBuilder,
        mockGetTaskFlow,
        mockNotificationMgr,
        mockSessionMgr,
        mockMessageRecorder,
        mockAudit,
        db,
        config,
      );

      await (
        dispatcher as unknown as {
          handleEvent: (e: Event) => Promise<void>;
        }
      ).handleEvent(makeMorningEvent());

      const count = db
        .prepare("SELECT COUNT(*) as cnt FROM agent_schedule")
        .get() as { cnt: number };
      expect(count.cnt).toBe(0);
    });

    it("sends critical notification and stops retrying after MAX_RETRIES", async () => {
      const config = makeConfig({ dataDir: tmpRoot });
      const dispatcher = new EventDispatcher(
        eventBus,
        mockAgentCore,
        mockContextBuilder,
        mockGetTaskFlow,
        mockNotificationMgr,
        mockSessionMgr,
        mockMessageRecorder,
        mockAudit,
        db,
        config,
      );

      // Simulate calling scheduleMorningRetry directly with previousCount
      // already at 3 — the 4th attempt should exhaust and notify.
      // retryCount is carried in event.data (the canonical code path).
      const syntheticEvent = {
        ...createEvent({
          type: "routine.morning_routine",
          source: "morning_routine_retry_3",
          priority: EventPriority.NORMAL,
          data: { retryCount: 3, isRetry: true },
        }),
        routine: "morning_routine",
      };

      (dispatcher as unknown as { morningRoutine: { scheduleMorningRetry(e: Event): void } }).morningRoutine.scheduleMorningRetry(syntheticEvent as unknown as Event);

      // No new row should be inserted — 3 retries already happened.
      const count = db
        .prepare("SELECT COUNT(*) as cnt FROM agent_schedule")
        .get() as { cnt: number };
      expect(count.cnt).toBe(0);

      // Critical notification should be sent to the user.
      expect(mockNotificationMgr.send).toHaveBeenCalledWith(
        expect.stringContaining("Morning routine"),
        expect.anything(),
        expect.objectContaining({ category: "critical" }),
      );
    });

    it("increments retry count across wake task failures via event.data", async () => {
      const config = makeConfig({ dataDir: tmpRoot });
      const dispatcher = new EventDispatcher(
        eventBus,
        mockAgentCore,
        mockContextBuilder,
        mockGetTaskFlow,
        mockNotificationMgr,
        mockSessionMgr,
        mockMessageRecorder,
        mockAudit,
        db,
        config,
      );

      // Simulate executeScheduledTask having synthesized a RoutineEvent
      // with retryCount=1 on event.data (the value it read from the
      // wake task's taskContext). scheduleMorningRetry should increment
      // to 2 and write a new row.
      const synthRoutineEvent = {
        ...createEvent({
          type: "routine.morning_routine",
          source: "morning_routine_retry_1",
          priority: EventPriority.NORMAL,
          data: { retryCount: 1, isRetry: true },
        }),
        routine: "morning_routine",
      };

      (dispatcher as unknown as { morningRoutine: { scheduleMorningRetry(e: Event): void } }).morningRoutine.scheduleMorningRetry(synthRoutineEvent as unknown as Event);

      const rows = db
        .prepare("SELECT task_description, task_context FROM agent_schedule")
        .all() as { task_description: string; task_context: string }[];

      expect(rows).toHaveLength(1);
      expect(rows[0].task_description).toContain("attempt 2/3");
      const ctx = JSON.parse(rows[0].task_context);
      expect(ctx.retryCount).toBe(2);
    });

    // ── M1: dedup ─────────────────────────────────────────────────

    it("skips scheduling when another morning routine retry is already pending", async () => {
      const config = makeConfig({ dataDir: tmpRoot });
      const dispatcher = new EventDispatcher(
        eventBus,
        mockAgentCore,
        mockContextBuilder,
        mockGetTaskFlow,
        mockNotificationMgr,
        mockSessionMgr,
        mockMessageRecorder,
        mockAudit,
        db,
        config,
      );

      // Pre-insert a pending retry row to simulate a prior scheduled retry
      db.prepare(
        `INSERT INTO agent_schedule
          (scheduled_for, task_type, task_description, task_context, model, status)
         VALUES (datetime('now', '+5 minutes'), 'wake',
                 'Morning routine retry (attempt 1/3). Generate today.md per the morning_routine flow.',
                 '{"routine":"morning_routine","retryCount":1}',
                 'opus', 'pending')`,
      ).run();

      // Another morning_routine fires (e.g., cron) and fails
      await (
        dispatcher as unknown as {
          handleEvent: (e: Event) => Promise<void>;
        }
      ).handleEvent(makeMorningEvent());

      // Should still be exactly 1 row (the pre-existing one) — dedup kicked in.
      const rows = db
        .prepare("SELECT task_description FROM agent_schedule")
        .all() as { task_description: string }[];
      expect(rows).toHaveLength(1);
      expect(rows[0].task_description).toContain("attempt 1/3");
    });

    it("continues scheduling retries regardless of prior spend", async () => {
      const config = makeConfig({ dataDir: tmpRoot });
      const dispatcher = new EventDispatcher(
        eventBus,
        mockAgentCore,
        mockContextBuilder,
        mockGetTaskFlow,
        mockNotificationMgr,
        mockSessionMgr,
        mockMessageRecorder,
        mockAudit,
        db,
        config,
      );

      db.prepare(
        "INSERT INTO agent_actions (action_type, trigger, cost_usd, result, started_at) VALUES ('test', 'autonomous', 1.5, 'success', datetime('now'))",
      ).run();

      const synthRoutineEvent = {
        ...createEvent({
          type: "routine.morning_routine",
          source: "cron",
          priority: EventPriority.NORMAL,
        }),
        routine: "morning_routine",
      };

      (dispatcher as unknown as { morningRoutine: { scheduleMorningRetry(e: Event): void } }).morningRoutine.scheduleMorningRetry(synthRoutineEvent as unknown as Event);

      const count = db
        .prepare(
          "SELECT COUNT(*) as cnt FROM agent_schedule WHERE task_type = 'wake'",
        )
        .get() as { cnt: number };
      expect(count.cnt).toBe(1);
      expect(mockNotificationMgr.send).not.toHaveBeenCalledWith(
        expect.stringContaining("usage limit"),
        expect.anything(),
        expect.objectContaining({ category: "critical" }),
      );
    });

    // ── L3: full chain continuation via executeScheduledTask ──────

    it("handleMorningRoutineRetry routes through executeMorningRoutine and chains retries via event.data", async () => {
      const config = makeConfig({ dataDir: tmpRoot });
      const dispatcher = new EventDispatcher(
        eventBus,
        mockAgentCore,
        mockContextBuilder,
        mockGetTaskFlow,
        mockNotificationMgr,
        mockSessionMgr,
        mockMessageRecorder,
        mockAudit,
        db,
        config,
      );

      // Pre-seed a running wake task row that matches what the dispatch
      // path would have produced from an agent_schedule pickup.
      db.prepare(
        `INSERT INTO agent_schedule
          (scheduled_for, task_type, task_description, task_context, model, status)
         VALUES (datetime('now'), 'wake',
                 'Morning routine retry (attempt 1/3).',
                 '{"routine":"morning_routine","retryCount":1,"originalCorrelationId":"orig-123"}',
                 'opus', 'running')`,
      ).run();
      const scheduleId = (db
        .prepare("SELECT last_insert_rowid() as id")
        .get() as { id: number }).id;

      // Simulate what ScheduleWatcher would emit.
      const wakeEvent = {
        ...createEvent({
          type: "scheduled.task",
          source: "wake",
          priority: EventPriority.NORMAL,
        }),
        task: "Morning routine retry (attempt 1/3).",
        taskContext: {
          routine: "morning_routine",
          retryCount: 1,
          originalCorrelationId: "orig-123",
        },
        scheduleId,
        requestedModel: "opus" as const,
      } as AgentTaskEvent;

      await (
        dispatcher as unknown as {
          handleEvent: (e: Event) => Promise<void>;
        }
      ).handleEvent(wakeEvent);

      // The mock agent returns success but today.md was never written,
      // so the executeMorningRoutine path should call scheduleMorningRetry →
      // retryCount 1 → 2, producing a new pending row.
      const pendingRetries = db
        .prepare(
          `SELECT task_description, task_context, correlation_id FROM agent_schedule
           WHERE status = 'pending' AND task_type = 'wake'
           ORDER BY id ASC`,
        )
        .all() as {
        task_description: string;
        task_context: string;
        correlation_id: string;
      }[];

      expect(pendingRetries).toHaveLength(1);
      expect(pendingRetries[0].task_description).toContain("attempt 2/3");
      expect(pendingRetries[0].correlation_id).toBe("orig-123");
      const ctx = JSON.parse(pendingRetries[0].task_context);
      expect(ctx.retryCount).toBe(2);
      expect(ctx.originalCorrelationId).toBe("orig-123");

      // The original wake task row should be marked 'completed'.
      const original = db
        .prepare("SELECT status FROM agent_schedule WHERE id = ?")
        .get(scheduleId) as { status: string };
      expect(original.status).toBe("completed");

      // The mock agent WAS invoked (executeMorningRoutine ran it through
      // the orchestrator's Stage A dispatch). The synthesized RoutineEvent
      // carries Stage A's process-key envelope.
      expect(mockAgentCore.execute).toHaveBeenCalledWith(
        expect.objectContaining({
          processKey: "routine.morning_routine_today",
          event: expect.objectContaining({ type: "routine.morning_routine_today" }),
        }),
      );
    });

    it("handleMorningRoutineRetry ends the chain cleanly when agent writes today.md", async () => {
      const config = makeConfig({ dataDir: tmpRoot });
      // Mock agent creates today.md as a side effect — simulates a
      // successful PATCH to /api/context/today during its turn.
      mockAgentCore.execute = vi.fn().mockImplementation(async () => {
        writeFileSync(
          join(contextDir, "state", "today.md"),
          `# ${getAgentDayDateStr(config.timezone || undefined, config.dayBoundaryHour)}\n`,
        );
        return makeResult({ contextUpdated: true });
      });

      const dispatcher = new EventDispatcher(
        eventBus,
        mockAgentCore,
        mockContextBuilder,
        mockGetTaskFlow,
        mockNotificationMgr,
        mockSessionMgr,
        mockMessageRecorder,
        mockAudit,
        db,
        config,
      );

      db.prepare(
        `INSERT INTO agent_schedule
          (scheduled_for, task_type, task_description, task_context, model, status)
         VALUES (datetime('now'), 'wake',
                 'Morning routine retry (attempt 2/3).',
                 '{"routine":"morning_routine","retryCount":2}',
                 'opus', 'running')`,
      ).run();
      const scheduleId = (db
        .prepare("SELECT last_insert_rowid() as id")
        .get() as { id: number }).id;

      const wakeEvent = {
        ...createEvent({
          type: "scheduled.task",
          source: "wake",
          priority: EventPriority.NORMAL,
        }),
        task: "Morning routine retry (attempt 2/3).",
        taskContext: { routine: "morning_routine", retryCount: 2 },
        scheduleId,
        requestedModel: "opus" as const,
      } as AgentTaskEvent;

      await (
        dispatcher as unknown as {
          handleEvent: (e: Event) => Promise<void>;
        }
      ).handleEvent(wakeEvent);

      // Agent should have run (once)
      expect(mockAgentCore.execute).toHaveBeenCalledTimes(1);

      // No new retry row should exist — the chain terminates because
      // today.md now exists, so executeMorningRoutine's post-check is satisfied.
      const pendingCount = db
        .prepare(
          "SELECT COUNT(*) as cnt FROM agent_schedule WHERE status = 'pending'",
        )
        .get() as { cnt: number };
      expect(pendingCount.cnt).toBe(0);

      // Original wake row marked completed.
      const row = db
        .prepare("SELECT status FROM agent_schedule WHERE id = ?")
        .get(scheduleId) as { status: string };
      expect(row.status).toBe("completed");
    });

    // ── O1: early skip when today.md already exists ──────────────

    it("handleMorningRoutineRetry skips execution when today.md already exists", async () => {
      const config = makeConfig({ dataDir: tmpRoot });
      // today.md already written (cron raced us to it)
      writeFileSync(
        join(contextDir, "state", "today.md"),
        `# ${getAgentDayDateStr(config.timezone || undefined, config.dayBoundaryHour)} — generated by cron\n`,
      );

      const dispatcher = new EventDispatcher(
        eventBus,
        mockAgentCore,
        mockContextBuilder,
        mockGetTaskFlow,
        mockNotificationMgr,
        mockSessionMgr,
        mockMessageRecorder,
        mockAudit,
        db,
        config,
      );

      db.prepare(
        `INSERT INTO agent_schedule
          (scheduled_for, task_type, task_description, task_context, model, status)
         VALUES (datetime('now'), 'wake', 'Morning routine retry',
                 '{"routine":"morning_routine","retryCount":1}', 'opus', 'running')`,
      ).run();
      const scheduleId = (db
        .prepare("SELECT last_insert_rowid() as id")
        .get() as { id: number }).id;

      const wakeEvent = {
        ...createEvent({
          type: "scheduled.task",
          source: "wake",
          priority: EventPriority.NORMAL,
        }),
        task: "Morning routine retry",
        taskContext: { routine: "morning_routine", retryCount: 1 },
        scheduleId,
        requestedModel: "opus" as const,
      } as AgentTaskEvent;

      await (
        dispatcher as unknown as {
          handleEvent: (e: Event) => Promise<void>;
        }
      ).handleEvent(wakeEvent);

      // No agent invocation (skipped entirely)
      expect(mockAgentCore.execute).not.toHaveBeenCalled();

      // The wake task row is marked completed
      const row = db
        .prepare("SELECT status FROM agent_schedule WHERE id = ?")
        .get(scheduleId) as { status: string };
      expect(row.status).toBe("completed");

      // No new retry rows
      const pendingCount = db
        .prepare(
          "SELECT COUNT(*) as cnt FROM agent_schedule WHERE status = 'pending'",
        )
        .get() as { cnt: number };
      expect(pendingCount.cnt).toBe(0);
    });
  });

  // ─── M4: observer log extension ─────────────────────────────────

  describe("observer event log extension (M4)", () => {
    it("logs contextUpdated for schedule.approaching events", async () => {
      const config = makeConfig();
      mockAgentCore.execute = vi
        .fn()
        .mockResolvedValue(makeResult({ contextUpdated: true }));

      const dispatcher = new EventDispatcher(
        eventBus,
        mockAgentCore,
        mockContextBuilder,
        mockGetTaskFlow,
        mockNotificationMgr,
        mockSessionMgr,
        mockMessageRecorder,
        mockAudit,
        db,
        config,
      );

      const calEvent = {
        ...createEvent({
          type: "schedule.approaching",
          source: "calendar",
          priority: EventPriority.HIGH,
        }),
        calendarId: "primary",
        eventTitle: "Weekly Sync",
        startTime: new Date(),
        endTime: new Date(),
        changeType: "approaching",
      };

      await (
        dispatcher as unknown as {
          handleEvent: (e: Event) => Promise<void>;
        }
      ).handleEvent(calEvent);

      // audit.logAction should have received contextUpdated=true for the
      // schedule.approaching observer event (proves the event reaches
      // processResult and that contextUpdated flows through).
      expect(mockAudit.logAction).toHaveBeenCalledWith(
        expect.objectContaining({
          contextUpdated: true,
          event: expect.objectContaining({ type: "schedule.approaching" }),
        }),
      );
    });
  });

  describe("observer pipeline integration (Phase 8 / P7-5)", () => {
    // ─────────────────────────────────────────────────────────────────────
    // Why this suite exists
    //
    // The other dispatcher tests stub `getTaskFlow` to return literally
    // "test prompt", which only proves wiring (event reaches AgentCore.execute,
    // audit fires). They CANNOT catch the kind of contract drift that this
    // epic was started to fix:
    //
    //   B2 (Critical) — prompt placeholders and extractEventData drifted,
    //                   causing silent substitutions to fail for observer events.
    //
    // To prevent regressions of this exact class, this suite runs each
    // observer event through the dispatcher with the REAL getTaskFlow and
    // then resolves the captured prompt with the REAL AgentCore helpers.
    // If anyone renames a placeholder in prompts.ts without touching
    // extractEventData (or vice versa), one of these tests will fail.
    //
    // Limitation (intentional, documented):
    //   The contract is "(real prompt template) ⨯ (real extractEventData) ⨯
    //   (real resolveTemplate) produce a clean substitution for this event".
    //   It does NOT prove that AgentCore.execute itself calls these helpers
    //   in the right order with the right inputs — that path is exercised
    //   by manual E2E since `query()` requires a live API key. The unit
    //   tests for extractEventData (agent.test.ts) and resolveTemplate
    //   (prompts.test.ts) cover the helpers in isolation.
    //
    // Each test below uses a per-test fake-timer scope only when the event
    // is batched, to avoid leaking timer state into adjacent describe blocks
    // or test files (vitest worker isolation has historically had quirks).
    // ─────────────────────────────────────────────────────────────────────

    function buildDispatcher(): EventDispatcher {
      return new EventDispatcher(
        eventBus,
        mockAgentCore,
        mockContextBuilder,
        // REAL prompt template lookup — this is the whole point of the suite.
        getTaskFlow,
        mockNotificationMgr,
        mockSessionMgr,
        mockMessageRecorder,
        mockAudit,
        db,
        makeConfig(),
      );
    }

    function captureLastExecuteCall(): {
      prompt: string;
      event: Event;
      processKey?: string;
      requestedTier?: string;
    } {
      expect(mockAgentCore.execute).toHaveBeenCalledTimes(1);
      return (mockAgentCore.execute as ReturnType<typeof vi.fn>).mock
        .calls[0][0];
    }

    function assertResolvesCleanly(
      capturedPrompt: string,
      capturedEvent: Event,
      requiredSubstrings: string[],
    ): void {
      const data = _extractEventData(capturedEvent);
      const resolved = _resolveTemplate(capturedPrompt, "ctx", data);
      expect(resolved).not.toMatch(/\{event_data\[/);
      for (const needle of requiredSubstrings) {
        expect(resolved).toContain(needle);
      }
    }

    it("routine.activity_scan resolves the observations prompt and writes audit", async () => {
      mockAgentCore.execute = vi
        .fn()
        .mockResolvedValue(makeResult({ contextUpdated: true }));
      vi.mocked(mockNotificationMgr.send).mockClear();

      const dispatcher = buildDispatcher();

      const hourlyEvent = createEvent({
        type: "routine.activity_scan",
        source: "cron",
        priority: EventPriority.NORMAL,
      });
      Object.assign(hourlyEvent, {
        routine: "activity_scan",
        data: { pendingCount: 3 },
      });

      await (
        dispatcher as unknown as { handleEvent: (e: Event) => Promise<void> }
      ).handleEvent(hourlyEvent);

      const call = captureLastExecuteCall();
      expect(call.event.type).toBe("routine.activity_scan");
      // requestedTier is NOT hardcoded — BackendRouter resolves it from
      // process-key defaults (light) or user-configured process_backend_config.
      expect(call.requestedTier).toBeUndefined();
      expect(call.processKey).toBe("routine.activity_scan");
      // docs/design/appendices/routine-data-acquisition.md Phase 3 R4 — the merged
      // observation read (the new Phase-3 default) AND the legacy
      // user-only triage query both surface in the prompt body; the
      // partials post mail/calendar/notion with `actor=agent`, so the
      // base body now teaches both reads.
      expect(call.prompt).toContain("GET /api/observations?pending=true&limit=30");
      expect(call.prompt).toContain("actor=user&limit=20");
      expect(call.prompt).toContain("POST /api/observations/consume");
      assertResolvesCleanly(call.prompt, call.event, [
        "GET /api/observations?pending=true&limit=30",
        "POST /api/observations/consume",
      ]);
      expect(mockAudit.logAction).toHaveBeenCalledWith(
        expect.objectContaining({
          contextUpdated: true,
          event: expect.objectContaining({ type: "routine.activity_scan" }),
        }),
      );
      // Silent-by-default contract: activity_scan must NEVER auto-broadcast
      // result.output as a user notification. The agent reaches the user
      // only via an explicit POST /api/notify from inside the run — which
      // does not go through notificationMgr.send here. This test is the
      // dispatcher-side guard against the old "hourly noise" regression.
      expect(mockNotificationMgr.send).not.toHaveBeenCalled();
    });

    it("routine.activity_scan stays silent even when the agent returns a chatty summary", async () => {
      // Even if the agent ignores the prompt and emits a long bookkeeping
      // summary as its final text, processResult must drop it on the
      // floor instead of forwarding to the user. The dispatcher is the
      // hard gate; the prompt is the soft one.
      mockAgentCore.execute = vi
        .fn()
        .mockResolvedValue(
          makeResult({
            output:
              "Hourly review complete. Processed 2 observations, added 0 tasks, skipped 2 noise items.",
            contextUpdated: true,
          }),
        );
      vi.mocked(mockNotificationMgr.send).mockClear();

      const dispatcher = buildDispatcher();

      const hourlyEvent = createEvent({
        type: "routine.activity_scan",
        source: "cron",
        priority: EventPriority.NORMAL,
      });
      Object.assign(hourlyEvent, {
        routine: "activity_scan",
        data: { pendingCount: 2 },
      });

      await (
        dispatcher as unknown as { handleEvent: (e: Event) => Promise<void> }
      ).handleEvent(hourlyEvent);

      expect(mockNotificationMgr.send).not.toHaveBeenCalled();
    });

    it("routine.evening_review does not auto-broadcast result.output (silent-by-default)", async () => {
      // Symmetric with the activity_scan guard. `evening-review-slimdown.md`
      // §2.4 deleted the legacy Step 4 user-visible wrap-up; built-in steps
      // are now silent-by-default and any rulebook-driven nudge goes
      // through the user-defined `POST /api/notify` path explicitly. The
      // dispatcher must not add a second broadcast from result.output.
      mockAgentCore.execute = vi
        .fn()
        .mockResolvedValue(
          makeResult({
            output:
              "Handoff carried 3 tasks, Agent Log updated, Raw Signals cleared.",
          }),
        );
      vi.mocked(mockNotificationMgr.send).mockClear();

      const dispatcher = buildDispatcher();

      const eveningEvent = createEvent({
        type: "routine.evening_review",
        source: "cron",
        priority: EventPriority.HIGH,
      });
      Object.assign(eveningEvent, { routine: "evening_review" });

      await (
        dispatcher as unknown as { handleEvent: (e: Event) => Promise<void> }
      ).handleEvent(eveningEvent);

      expect(mockNotificationMgr.send).not.toHaveBeenCalled();
    });

    it("routine.morning_routine does not auto-broadcast result.output", async () => {
      mockAgentCore.execute = vi
        .fn()
        .mockResolvedValue(makeResult({ output: "Morning routine complete." }));
      vi.mocked(mockNotificationMgr.send).mockClear();

      const dispatcher = buildDispatcher();

      const morningEvent = createEvent({
        type: "routine.morning_routine",
        source: "cron",
        priority: EventPriority.HIGH,
      });
      Object.assign(morningEvent, { routine: "morning_routine" });

      await (
        dispatcher as unknown as { handleEvent: (e: Event) => Promise<void> }
      ).handleEvent(morningEvent);

      // Routines are silent-by-default
      expect(mockNotificationMgr.send).not.toHaveBeenCalled();
    });

    it("routine event with event.requestedModel='opus' passes requestedTier='high' to resolveBinding", async () => {
      // Closes the dispatcher→router integration gap: plan-presets tests cover
      // the router level, this test covers the *dispatcher* translating
      // event.requestedModel into resolveBinding({requestedTier}).
      mockAgentCore.execute = vi.fn().mockResolvedValue(makeResult());
      vi.mocked(mockAgentCore.resolveBinding).mockClear();

      const dispatcher = buildDispatcher();

      const hourlyEvent = createEvent({
        type: "routine.activity_scan",
        source: "manual:test",
        priority: EventPriority.NORMAL,
      });
      Object.assign(hourlyEvent, {
        routine: "activity_scan",
        data: { pendingCount: 1, forced: true },
        requestedModel: "opus",
      });

      await (
        dispatcher as unknown as { handleEvent: (e: Event) => Promise<void> }
      ).handleEvent(hourlyEvent);

      expect(mockAgentCore.resolveBinding).toHaveBeenCalledWith(
        expect.objectContaining({ type: "routine.activity_scan" }),
        expect.objectContaining({
          processKey: "routine.activity_scan",
          requestedTier: "high",
        }),
      );
    });

    it("routine event with event.requestedModel='sonnet' passes requestedTier='medium'", async () => {
      mockAgentCore.execute = vi.fn().mockResolvedValue(makeResult());
      vi.mocked(mockAgentCore.resolveBinding).mockClear();

      const dispatcher = buildDispatcher();

      const hourlyEvent = createEvent({
        type: "routine.activity_scan",
        source: "manual:test",
        priority: EventPriority.NORMAL,
      });
      Object.assign(hourlyEvent, {
        routine: "activity_scan",
        data: { pendingCount: 1, forced: true },
        requestedModel: "sonnet",
      });

      await (
        dispatcher as unknown as { handleEvent: (e: Event) => Promise<void> }
      ).handleEvent(hourlyEvent);

      expect(mockAgentCore.resolveBinding).toHaveBeenCalledWith(
        expect.objectContaining({ type: "routine.activity_scan" }),
        expect.objectContaining({
          processKey: "routine.activity_scan",
          requestedTier: "medium",
        }),
      );
    });

    it("routine event WITHOUT requestedModel leaves requestedTier unset", async () => {
      mockAgentCore.execute = vi.fn().mockResolvedValue(makeResult());
      vi.mocked(mockAgentCore.resolveBinding).mockClear();

      const dispatcher = buildDispatcher();

      const hourlyEvent = createEvent({
        type: "routine.activity_scan",
        source: "cron",
        priority: EventPriority.NORMAL,
      });
      Object.assign(hourlyEvent, {
        routine: "activity_scan",
        data: { pendingCount: 1 },
      });

      await (
        dispatcher as unknown as { handleEvent: (e: Event) => Promise<void> }
      ).handleEvent(hourlyEvent);

      // The N2 spawn gate adds an options-less resolveBinding(event) call
      // before dispatch, so assert over EVERY call for this event type:
      // none may carry requestedTier (the gate passes no options at all;
      // the dispatch-path call passes options without the tier).
      const calls = vi.mocked(mockAgentCore.resolveBinding).mock.calls.filter(
        ([event]) => (event as { type?: string }).type === "routine.activity_scan",
      );
      expect(calls.length).toBeGreaterThan(0);
      for (const call of calls) {
        expect(call[1] ?? {}).not.toHaveProperty("requestedTier");
      }
    });

    it("dashboard chat message with requestedModel='opus' passes requestedTier='high' to resolveBinding", async () => {
      // Plan-aware escape hatch #1 — dashboard chat model picker. The picker
      // writes requestedModel directly onto MessageEvent; the dispatcher
      // translates that into requestedTier so BackendRouter can swap in the
      // canonical Opus model even when the Pro preset pinned dashboard.chat
      // to Sonnet.
      vi.mocked(mockAgentCore.resolveBinding).mockClear();

      const dispatcher = buildDispatcher();

      const dmEvent = {
        ...createEvent({
          type: "message.received",
          source: "dashboard",
          priority: EventPriority.HIGH,
        }),
        sender: "user",
        channel: "ch-picker",
        content: "do something hard",
        platform: "dashboard",
        threadId: null,
        isDm: true,
        isMention: false,
        requestedModel: "opus" as const,
      } as MessageEvent;

      await (
        dispatcher as unknown as { handleEvent: (e: Event) => Promise<void> }
      ).handleEvent(dmEvent);

      expect(mockAgentCore.resolveBinding).toHaveBeenCalledWith(
        expect.objectContaining({ platform: "dashboard" }),
        expect.objectContaining({
          processKey: "dashboard.chat",
          requestedTier: "high",
        }),
      );
    });

    it("dashboard chat message with requestedModel='sonnet' passes requestedTier='medium'", async () => {
      vi.mocked(mockAgentCore.resolveBinding).mockClear();

      const dispatcher = buildDispatcher();

      const dmEvent = {
        ...createEvent({
          type: "message.received",
          source: "dashboard",
          priority: EventPriority.HIGH,
        }),
        sender: "user",
        channel: "ch-picker",
        content: "a quick question",
        platform: "dashboard",
        threadId: null,
        isDm: true,
        isMention: false,
        requestedModel: "sonnet" as const,
      } as MessageEvent;

      await (
        dispatcher as unknown as { handleEvent: (e: Event) => Promise<void> }
      ).handleEvent(dmEvent);

      expect(mockAgentCore.resolveBinding).toHaveBeenCalledWith(
        expect.objectContaining({ platform: "dashboard" }),
        expect.objectContaining({
          processKey: "dashboard.chat",
          requestedTier: "medium",
        }),
      );
    });

    it("dashboard chat message WITHOUT requestedModel leaves requestedTier unset", async () => {
      vi.mocked(mockAgentCore.resolveBinding).mockClear();

      const dispatcher = buildDispatcher();

      const dmEvent = {
        ...createEvent({
          type: "message.received",
          source: "dashboard",
          priority: EventPriority.HIGH,
        }),
        sender: "user",
        channel: "ch-nopicker",
        content: "normal message",
        platform: "dashboard",
        threadId: null,
        isDm: true,
        isMention: false,
      } as MessageEvent;

      await (
        dispatcher as unknown as { handleEvent: (e: Event) => Promise<void> }
      ).handleEvent(dmEvent);

      const call = vi.mocked(mockAgentCore.resolveBinding).mock.calls.find(
        ([event]) => (event as { platform?: string }).platform === "dashboard",
      );
      expect(call).toBeDefined();
      expect(call?.[1]).not.toHaveProperty("requestedTier");
    });

    it("dashboard chat with explicit requestedBackendId + requestedModelId forwards both to resolveBinding", async () => {
      // Superset of the sonnet/opus hatch: lets the picker target any
      // registered model on any enabled backend. Validation is performed
      // on the wire boundary (sse.ts); here we only check the dispatcher
      // passes both fields through.
      vi.mocked(mockAgentCore.resolveBinding).mockClear();

      const dispatcher = buildDispatcher();

      const dmEvent = {
        ...createEvent({
          type: "message.received",
          source: "dashboard",
          priority: EventPriority.HIGH,
        }),
        sender: "user",
        channel: "ch-picker",
        content: "run on gemini",
        platform: "dashboard",
        threadId: null,
        isDm: true,
        isMention: false,
        requestedBackendId: "gemini",
        requestedModelId: "gemini-2.5-pro",
      } as MessageEvent;

      await (
        dispatcher as unknown as { handleEvent: (e: Event) => Promise<void> }
      ).handleEvent(dmEvent);

      expect(mockAgentCore.resolveBinding).toHaveBeenCalledWith(
        expect.objectContaining({ platform: "dashboard" }),
        expect.objectContaining({
          processKey: "dashboard.chat",
          requestedBackendId: "gemini",
          requestedModelId: "gemini-2.5-pro",
        }),
      );
    });

    it("non-dashboard message with requestedBackendId/requestedModelId is IGNORED (defense-in-depth)", async () => {
      vi.mocked(mockAgentCore.resolveBinding).mockClear();

      const dispatcher = buildDispatcher();

      const dmEvent = {
        ...createEvent({
          type: "message.received",
          source: "slack",
          priority: EventPriority.HIGH,
        }),
        sender: "user",
        channel: "C456",
        content: "force gemini",
        platform: "slack",
        threadId: null,
        isDm: true,
        isMention: false,
        requestedBackendId: "gemini",
        requestedModelId: "gemini-2.5-pro",
      } as MessageEvent;

      await (
        dispatcher as unknown as { handleEvent: (e: Event) => Promise<void> }
      ).handleEvent(dmEvent);

      const call = vi.mocked(mockAgentCore.resolveBinding).mock.calls.find(
        ([event]) => (event as { platform?: string }).platform === "slack",
      );
      expect(call).toBeDefined();
      expect(call?.[1]).not.toHaveProperty("requestedBackendId");
      expect(call?.[1]).not.toHaveProperty("requestedModelId");
    });

    it("non-dashboard message with requestedModel='opus' is IGNORED (defense-in-depth)", async () => {
      // Even if some future adapter bug or compromise caused a Slack/Telegram/
      // Discord event to carry requestedModel, the dispatcher must refuse to
      // honor it. The dashboard chat model picker is the only trusted source.
      vi.mocked(mockAgentCore.resolveBinding).mockClear();

      const dispatcher = buildDispatcher();

      const dmEvent = {
        ...createEvent({
          type: "message.received",
          source: "slack",
          priority: EventPriority.HIGH,
        }),
        sender: "user",
        channel: "C123",
        content: "try to force opus",
        platform: "slack",
        threadId: null,
        isDm: true,
        isMention: false,
        requestedModel: "opus" as const,
      } as MessageEvent;

      await (
        dispatcher as unknown as { handleEvent: (e: Event) => Promise<void> }
      ).handleEvent(dmEvent);

      const call = vi.mocked(mockAgentCore.resolveBinding).mock.calls.find(
        ([event]) => (event as { platform?: string }).platform === "slack",
      );
      expect(call).toBeDefined();
      expect(call?.[1]).not.toHaveProperty("requestedTier");
    });

    it("knowledge.import event with platform=dashboard + (backendId, modelId) forwards both to resolveBinding", async () => {
      // Mirrors the dashboard-chat picker invariant for the import surface.
      // The Knowledge upload form lets the user pick which authenticated
      // backend / model runs the import; the route emits a
      // KnowledgeImportEvent with platform="dashboard" and the picked
      // (backendId, modelId) pair, and the dispatcher must forward both
      // through executeDefault → resolveBinding.
      vi.mocked(mockAgentCore.resolveBinding).mockClear();

      const dispatcher = buildDispatcher();

      const importEvent = {
        ...createEvent({
          type: "knowledge.import",
          source: "dashboard_knowledge_upload",
          priority: EventPriority.HIGH,
        }),
        type: "knowledge.import",
        platform: "dashboard",
        scratchPath: "state/scratch/import-2026-04-27-x.md",
        filename: "profile.md",
        source: "self-written",
        uploadDate: "2026-04-27",
        requestedBackendId: "gemini",
        requestedModelId: "gemini-2.5-pro",
        data: {
          scratchPath: "state/scratch/import-2026-04-27-x.md",
          filename: "profile.md",
          source: "self-written",
          uploadDate: "2026-04-27",
        },
      } as unknown as Event;

      await (
        dispatcher as unknown as { handleEvent: (e: Event) => Promise<void> }
      ).handleEvent(importEvent);

      expect(mockAgentCore.resolveBinding).toHaveBeenCalledWith(
        expect.objectContaining({ type: "knowledge.import", platform: "dashboard" }),
        expect.objectContaining({
          processKey: "knowledge.import",
          requestedBackendId: "gemini",
          requestedModelId: "gemini-2.5-pro",
        }),
      );
    });

    it("knowledge.import without platform=dashboard ignores the (backendId, modelId) override", async () => {
      // Defense-in-depth: only the dashboard upload route emits this
      // event with platform="dashboard". A malformed event from any
      // other path must NOT pin the backend.
      vi.mocked(mockAgentCore.resolveBinding).mockClear();

      const dispatcher = buildDispatcher();

      const importEvent = {
        ...createEvent({
          type: "knowledge.import",
          source: "rogue_adapter",
          priority: EventPriority.HIGH,
        }),
        type: "knowledge.import",
        platform: "slack",
        scratchPath: "state/scratch/import-2026-04-27-y.md",
        filename: "profile.md",
        source: "self-written",
        uploadDate: "2026-04-27",
        requestedBackendId: "gemini",
        requestedModelId: "gemini-2.5-pro",
        data: {
          scratchPath: "state/scratch/import-2026-04-27-y.md",
          filename: "profile.md",
          source: "self-written",
          uploadDate: "2026-04-27",
        },
      } as unknown as Event;

      await (
        dispatcher as unknown as { handleEvent: (e: Event) => Promise<void> }
      ).handleEvent(importEvent);

      const call = vi.mocked(mockAgentCore.resolveBinding).mock.calls.find(
        ([event]) => (event as { type?: string }).type === "knowledge.import",
      );
      expect(call).toBeDefined();
      expect(call?.[1]).not.toHaveProperty("requestedBackendId");
      expect(call?.[1]).not.toHaveProperty("requestedModelId");
    });

    it("schedule.approaching resolves event_title + start_time + end_time and writes audit", async () => {
      // Calendar events were broken by B3 (extractEventData had no
      // CalendarChangeEvent branch). This test guards against that branch
      // ever being deleted again.
      mockAgentCore.execute = vi
        .fn()
        .mockResolvedValue(makeResult({ contextUpdated: false }));

      const dispatcher = buildDispatcher();

      const calEvent: CalendarChangeEvent = {
        ...createEvent({
          type: "schedule.approaching",
          source: "calendar",
          priority: EventPriority.HIGH,
          // Mirror calendar-poller.ts:131-141. The schedule.approaching
          // prompt now references `{event_data[calendarEventId]}` and
          // `{event_data[minutesUntil]}` to wire the trigger-(a) detection
          // path; without populating `data`, those placeholders would be
          // left unresolved and assertResolvesCleanly would fail.
          data: {
            calendarEventId: "evt-sprint-1",
            summary: "Sprint Demo",
            startTime: "2026-04-06T15:00:00Z",
            endTime: "2026-04-06T16:00:00Z",
            minutesUntil: 13,
          },
        }),
        calendarId: "primary",
        eventTitle: "Sprint Demo",
        startTime: new Date("2026-04-06T15:00:00Z"),
        endTime: new Date("2026-04-06T16:00:00Z"),
        changeType: "approaching",
      } as CalendarChangeEvent;

      await (
        dispatcher as unknown as { handleEvent: (e: Event) => Promise<void> }
      ).handleEvent(calEvent);

      const call = captureLastExecuteCall();
      // Contract 1: dispatcher routed schedule.approaching to executeDefault.
      expect(call.event.type).toBe("schedule.approaching");
      // requestedTier is NOT hardcoded — BackendRouter resolves from process-key defaults.
      expect(call.requestedTier).toBeUndefined();
      expect(call.processKey).toBe("schedule.approaching");
      // Contract 2: real prompt carries all calendar placeholders.
      expect(call.prompt).toContain("{event_data[event_title]}");
      expect(call.prompt).toContain("{event_data[start_time]}");
      expect(call.prompt).toContain("{event_data[end_time]}");
      // Contract 3: full resolution end-to-end yields the event payload.
      assertResolvesCleanly(call.prompt, call.event, [
        "Sprint Demo",
        "2026-04-06T15:00:00.000Z",
        "2026-04-06T16:00:00.000Z",
      ]);
      // Contract 4: audit log records contextUpdated=false propagated
      // for an observer event the agent decided to skip.
      expect(mockAudit.logAction).toHaveBeenCalledWith(
        expect.objectContaining({
          contextUpdated: false,
          event: expect.objectContaining({ type: "schedule.approaching" }),
        }),
      );
    });
  });

  // ── Additional coverage: uncovered branches ──

  describe("channel message without mention (defense-in-depth)", () => {
    it("drops channel messages without mention via audit.logSkip", async () => {
      const config = makeConfig();
      vi.mocked(mockSessionMgr.getOrCreate).mockResolvedValue({
        id: 1,
        isActive: false,
        sessionId: null,
        model: "opus",
      });

      const dispatcher = new EventDispatcher(
        eventBus,
        mockAgentCore,
        mockContextBuilder,
        mockGetTaskFlow,
        mockNotificationMgr,
        mockSessionMgr,
        mockMessageRecorder,
        mockAudit,
        db,
        config,
      );

      const channelMsg = {
        ...createEvent({
          type: "message.received",
          source: "slack",
          priority: EventPriority.NORMAL,
        }),
        sender: "user1",
        channel: "C-general",
        content: "hello team",
        platform: "slack",
        threadId: null,
        isDm: false,
        isMention: false,
      } as MessageEvent;

      await (
        dispatcher as unknown as { handleEvent: (e: Event) => Promise<void> }
      ).handleEvent(channelMsg);

      expect(mockAgentCore.execute).not.toHaveBeenCalled();
      expect(mockAudit.logSkip).toHaveBeenCalledWith(
        expect.objectContaining({ type: "message.received" }),
        "channel_message_ignored",
        "autonomous",
      );
    });
  });

  describe("degraded management mode", () => {
    it("does not append fallback policy files to reactive prompts", async () => {
      const tmpRoot = mkdtempSync(join(tmpdir(), "pa-dispatcher-degraded-"));
      try {
        const fallbackRulesDir = join(tmpRoot, "context", "rules");
        mkdirSync(fallbackRulesDir, { recursive: true });
        writeFileSync(
          join(fallbackRulesDir, "management.md"),
          "# Fallback Management Rules\nDo not leak this into degraded prompts.\n",
        );

        const config = makeConfig({
          dataDir: tmpRoot,
          vaultMode: "obsidian",
          primaryVaultPath: "/missing/primary-vault",
        });
        setDegradedMode(db, {
          reason: "primary_vault_unreachable",
          path: "/missing/primary-vault",
          since: "2026-04-18T10:00:00Z",
        });

        const dispatcher = new EventDispatcher(
          eventBus,
          mockAgentCore,
          mockContextBuilder,
          mockGetTaskFlow,
          mockNotificationMgr,
          mockSessionMgr,
          mockMessageRecorder,
          mockAudit,
          db,
          config,
        );

        const dmEvent = {
          ...createEvent({
            type: "message.received",
            source: "dashboard",
            priority: EventPriority.HIGH,
          }),
          sender: "user1",
          channel: "dashboard-ch",
          content: "vault looks broken",
          platform: "dashboard",
          threadId: null,
          isDm: true,
          isMention: false,
        } as MessageEvent;

        await (
          dispatcher as unknown as { handleEvent: (e: Event) => Promise<void> }
        ).handleEvent(dmEvent);

        const executeArgs = vi.mocked(mockAgentCore.execute).mock.calls.at(-1)?.[0];
        expect(executeArgs).toBeDefined();
        expect(executeArgs?.prompt).toBe("test prompt");
        expect(executeArgs?.prompt).not.toContain("Fallback Management Rules");
      } finally {
        rmSync(tmpRoot, { recursive: true, force: true });
      }
    });
  });

  // M1 (release-prep): legacy close-keyword tests removed. The bare-word
  // matcher (`end` / `close` / `done`) was retired because the lone word
  // "done" — a natural English completion signal — silently terminated
  // active conversations. Session close is now an explicit `!close` bang
  // command, unit-tested at `commands-close.test.ts` (bang handler in
  // isolation) and integration-covered via the bang-command interceptor
  // in `tryHandle` (see `registry.test.ts`).

  describe("empty agent output handling", () => {
    it("sends error message when agent returns no output for a DM", async () => {
      const config = makeConfig();
      vi.mocked(mockSessionMgr.getOrCreate).mockResolvedValue({
        id: 1,
        isActive: false,
        sessionId: null,
        model: "opus",
      });
      vi.mocked(mockAgentCore.execute).mockResolvedValue(
        makeResult({ output: "", isError: true }),
      );

      const dispatcher = new EventDispatcher(
        eventBus,
        mockAgentCore,
        mockContextBuilder,
        mockGetTaskFlow,
        mockNotificationMgr,
        mockSessionMgr,
        mockMessageRecorder,
        mockAudit,
        db,
        config,
      );

      const dmEvent = {
        ...createEvent({
          type: "message.received",
          source: "dashboard",
          priority: EventPriority.HIGH,
        }),
        sender: "user",
        channel: "ch1",
        content: "hello",
        platform: "dashboard",
        threadId: null,
        isDm: true,
        isMention: false,
      } as MessageEvent;

      await (
        dispatcher as unknown as { handleEvent: (e: Event) => Promise<void> }
      ).handleEvent(dmEvent);

      // Error message should be recorded and sent
      expect(mockMessageRecorder.recordMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          role: "assistant",
          content: expect.stringContaining("Could not generate a response"),
        }),
      );
      expect(mockNotificationMgr.send).toHaveBeenCalledWith(
        expect.stringContaining("Could not generate a response"),
        dmEvent,
      );
    });

    it("treats whitespace-only agent output as empty", async () => {
      const config = makeConfig();
      vi.mocked(mockSessionMgr.getOrCreate).mockResolvedValue({
        id: 1,
        isActive: false,
        sessionId: null,
        model: "opus",
      });
      vi.mocked(mockAgentCore.execute).mockResolvedValue(
        makeResult({ output: "   \n\t", isError: false }),
      );

      const dispatcher = new EventDispatcher(
        eventBus,
        mockAgentCore,
        mockContextBuilder,
        mockGetTaskFlow,
        mockNotificationMgr,
        mockSessionMgr,
        mockMessageRecorder,
        mockAudit,
        db,
        config,
      );

      const dmEvent = {
        ...createEvent({
          type: "message.received",
          source: "dashboard",
          priority: EventPriority.HIGH,
        }),
        sender: "user",
        channel: "ch1",
        content: "hello",
        platform: "dashboard",
        threadId: null,
        isDm: true,
        isMention: false,
      } as MessageEvent;

      await (
        dispatcher as unknown as { handleEvent: (e: Event) => Promise<void> }
      ).handleEvent(dmEvent);

      expect(mockMessageRecorder.recordMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          role: "assistant",
          content: expect.stringContaining("Could not generate a response"),
        }),
      );
    });
  });

  describe("processResult notification logic", () => {
    it("does not notify for routine events (silent-by-default)", async () => {
      const config = makeConfig();
      vi.mocked(mockAgentCore.execute).mockResolvedValue(
        makeResult({ output: "Routine complete" }),
      );

      const dispatcher = new EventDispatcher(
        eventBus,
        mockAgentCore,
        mockContextBuilder,
        mockGetTaskFlow,
        mockNotificationMgr,
        mockSessionMgr,
        mockMessageRecorder,
        mockAudit,
        db,
        config,
      );

      vi.mocked(mockNotificationMgr.send).mockClear();

      const routineEvent = {
        ...createEvent({
          type: "routine.evening_review",
          source: "cron",
          priority: EventPriority.HIGH,
        }),
        routine: "evening_review",
      };

      await (
        dispatcher as unknown as { handleEvent: (e: Event) => Promise<void> }
      ).handleEvent(routineEvent);

      expect(mockNotificationMgr.send).not.toHaveBeenCalled();
    });

    it("notifies for scheduled task events", async () => {
      const config = makeConfig();
      vi.mocked(mockAgentCore.execute).mockResolvedValue(
        makeResult({ output: "Task result" }),
      );

      const dispatcher = new EventDispatcher(
        eventBus,
        mockAgentCore,
        mockContextBuilder,
        mockGetTaskFlow,
        mockNotificationMgr,
        mockSessionMgr,
        mockMessageRecorder,
        mockAudit,
        db,
        config,
      );

      vi.mocked(mockNotificationMgr.send).mockClear();

      const taskEvent = {
        ...createEvent({
          type: "scheduled.task",
          source: "wake",
          priority: EventPriority.NORMAL,
        }),
        task: "test task",
        taskContext: {},
        requestedModel: "sonnet" as const,
      } as AgentTaskEvent;

      await (
        dispatcher as unknown as { handleEvent: (e: Event) => Promise<void> }
      ).handleEvent(taskEvent);

      expect(mockNotificationMgr.send).toHaveBeenCalledWith(
        "Task result",
        expect.objectContaining({ type: "scheduled.task" }),
      );
    });
  });

  describe("quota error formatting", () => {
    function makeDispatcher() {
      return new EventDispatcher(
        eventBus,
        mockAgentCore,
        mockContextBuilder,
        mockGetTaskFlow,
        mockNotificationMgr,
        mockSessionMgr,
        mockMessageRecorder,
        mockAudit,
        db,
        makeConfig(),
      );
    }

    it("formats quota message without resetHint", async () => {
      const dispatcher = makeDispatcher();
      const quotaErr = new BackendQuotaError(
        "claude",
        "rate_limited",
        null,
        "quota exceeded",
      );

      const messageEvent = {
        ...createEvent({
          type: "message.received",
          source: "dashboard",
          priority: EventPriority.HIGH,
        }),
        sender: "user",
        channel: "ch1",
        content: "hello",
        platform: "dashboard",
        threadId: null,
        isDm: true,
        isMention: false,
      } as MessageEvent;

      await (
        dispatcher as unknown as { errorRouter: {
          handleError: (e: Event, err: Error) => Promise<void>;
        } }
      ).errorRouter.handleError(messageEvent, quotaErr);

      expect(mockNotificationMgr.send).toHaveBeenCalledWith(
        expect.stringContaining("usage limit"),
        messageEvent,
      );
    });

    it("formats quota message with rawLabel when time resolution fails", async () => {
      const dispatcher = makeDispatcher();
      const quotaErr = new BackendQuotaError(
        "codex",
        "rate_limited",
        {
          hour: 99, // invalid hour
          minute: 0,
          timeZone: "Invalid/Timezone",
          rawLabel: "at midnight",
        },
        "quota exceeded",
      );

      const messageEvent = {
        ...createEvent({
          type: "message.received",
          source: "dashboard",
          priority: EventPriority.HIGH,
        }),
        sender: "user",
        channel: "ch1",
        content: "hello",
        platform: "dashboard",
        threadId: null,
        isDm: true,
        isMention: false,
      } as MessageEvent;

      await (
        dispatcher as unknown as { errorRouter: {
          handleError: (e: Event, err: Error) => Promise<void>;
        } }
      ).errorRouter.handleError(messageEvent, quotaErr);

      // Should use rawLabel since time resolution failed
      expect(mockNotificationMgr.send).toHaveBeenCalledWith(
        expect.stringContaining("Codex"),
        messageEvent,
      );
    });

    it("formats max budget errors as per-turn budget limit", async () => {
      const dispatcher = makeDispatcher();
      const quotaErr = new BackendQuotaError(
        "gemini",
        "max_budget_usd",
        null,
        "Reached maximum budget",
      );

      const messageEvent = {
        ...createEvent({
          type: "message.received",
          source: "dashboard",
          priority: EventPriority.HIGH,
        }),
        sender: "user",
        channel: "ch1",
        content: "hello",
        platform: "dashboard",
        threadId: null,
        isDm: true,
        isMention: false,
      } as MessageEvent;

      await (
        dispatcher as unknown as { errorRouter: {
          handleError: (e: Event, err: Error) => Promise<void>;
        } }
      ).errorRouter.handleError(messageEvent, quotaErr);

      expect(mockNotificationMgr.send).toHaveBeenCalledWith(
        expect.stringContaining("per-turn budget limit"),
        messageEvent,
      );
    });

    it("extracts quota error from BackendDecisiveFailure wrapper", async () => {
      const dispatcher = makeDispatcher();
      const innerQuota = new BackendQuotaError(
        "claude",
        "rate_limited",
        null,
        "quota exceeded",
      );
      const wrapper = new BackendDecisiveFailure("claude", "quota", innerQuota);

      const messageEvent = {
        ...createEvent({
          type: "message.received",
          source: "dashboard",
          priority: EventPriority.HIGH,
        }),
        sender: "user",
        channel: "ch1",
        content: "hello",
        platform: "dashboard",
        threadId: null,
        isDm: true,
        isMention: false,
      } as MessageEvent;

      await (
        dispatcher as unknown as { errorRouter: {
          handleError: (e: Event, err: Error) => Promise<void>;
        } }
      ).errorRouter.handleError(messageEvent, wrapper);

      expect(mockNotificationMgr.send).toHaveBeenCalledWith(
        expect.stringContaining("usage limit"),
        messageEvent,
      );
    });

    it("sends generic error message for non-quota errors on message events", async () => {
      const dispatcher = makeDispatcher();
      const genericError = new Error("something broke");

      const messageEvent = {
        ...createEvent({
          type: "message.received",
          source: "dashboard",
          priority: EventPriority.HIGH,
        }),
        sender: "user",
        channel: "ch1",
        content: "hello",
        platform: "dashboard",
        threadId: null,
        isDm: true,
        isMention: false,
      } as MessageEvent;

      await (
        dispatcher as unknown as { errorRouter: {
          handleError: (e: Event, err: Error) => Promise<void>;
        } }
      ).errorRouter.handleError(messageEvent, genericError);

      expect(mockNotificationMgr.send).toHaveBeenCalledWith(
        expect.stringContaining("An error occurred"),
        messageEvent,
      );
    });

    it("sends inline chat_error to the dashboard tab when dispatch throws", async () => {
      // DashboardAdapter is notificationEligible=false, so the generic
      // notificationMgr path never reaches the tab that originated the
      // request. Without this hook, the browser would watch nothing
      // happen and hit the 120s waiting timeout with no explanation.
      const dispatcher = makeDispatcher();
      const sendError = vi.fn();
      (dispatcher as unknown as {
        setDashboardStream: (s: { sendStreamChunk: () => void; sendStreamEnd: () => void; sendError: (c: string, m: string) => void }) => void;
      }).setDashboardStream({
        sendStreamChunk: vi.fn(),
        sendStreamEnd: vi.fn(),
        sendError,
      });

      const dashboardEvent = {
        ...createEvent({
          type: "message.received",
          source: "dashboard",
          priority: EventPriority.HIGH,
        }),
        sender: "user",
        channel: "channel-uuid-abc",
        content: "hello",
        platform: "dashboard",
        threadId: null,
        isDm: true,
        isMention: false,
      } as MessageEvent;

      await (
        dispatcher as unknown as { errorRouter: {
          handleError: (e: Event, err: Error) => Promise<void>;
        } }
      ).errorRouter.handleError(dashboardEvent, new Error("backend crash"));

      expect(sendError).toHaveBeenCalledWith(
        "channel-uuid-abc",
        expect.stringContaining("An error occurred"),
      );
    });

    it("does not send chat_error for non-dashboard platforms", async () => {
      const dispatcher = makeDispatcher();
      const sendError = vi.fn();
      (dispatcher as unknown as {
        setDashboardStream: (s: { sendStreamChunk: () => void; sendStreamEnd: () => void; sendError: (c: string, m: string) => void }) => void;
      }).setDashboardStream({
        sendStreamChunk: vi.fn(),
        sendStreamEnd: vi.fn(),
        sendError,
      });

      const slackEvent = {
        ...createEvent({
          type: "message.received",
          source: "slack",
          priority: EventPriority.HIGH,
        }),
        sender: "U1",
        channel: "D1",
        content: "hi",
        platform: "slack",
        threadId: null,
        isDm: true,
        isMention: false,
      } as MessageEvent;

      await (
        dispatcher as unknown as { errorRouter: {
          handleError: (e: Event, err: Error) => Promise<void>;
        } }
      ).errorRouter.handleError(slackEvent, new Error("boom"));

      expect(sendError).not.toHaveBeenCalled();
    });

    it("does not send error notification for non-message events", async () => {
      const dispatcher = makeDispatcher();
      const genericError = new Error("something broke");

      const routineEvent = {
        ...createEvent({
          type: "routine.evening_review",
          source: "cron",
          priority: EventPriority.NORMAL,
        }),
        routine: "evening_review",
      };

      vi.mocked(mockNotificationMgr.send).mockClear();

      await (
        dispatcher as unknown as { errorRouter: {
          handleError: (e: Event, err: Error) => Promise<void>;
        } }
      ).errorRouter.handleError(routineEvent, genericError);

      expect(mockNotificationMgr.send).not.toHaveBeenCalled();
    });
  });

  describe("isReactive classification", () => {
    it("classifies mention messages as reactive", () => {
      const config = makeConfig();
      const dispatcher = new EventDispatcher(
        eventBus,
        mockAgentCore,
        mockContextBuilder,
        mockGetTaskFlow,
        mockNotificationMgr,
        mockSessionMgr,
        mockMessageRecorder,
        mockAudit,
        db,
        config,
      );

      const mentionEvent = {
        ...createEvent({
          type: "message.received",
          source: "slack",
          priority: EventPriority.NORMAL,
        }),
        sender: "user1",
        channel: "C123",
        content: "hey",
        platform: "slack",
        threadId: null,
        isDm: false,
        isMention: true,
      } as MessageEvent;

      expect(dispatcher.isReactive(mentionEvent)).toBe(true);
    });

    it("classifies dashboard_regenerate as reactive", () => {
      const config = makeConfig();
      const dispatcher = new EventDispatcher(
        eventBus,
        mockAgentCore,
        mockContextBuilder,
        mockGetTaskFlow,
        mockNotificationMgr,
        mockSessionMgr,
        mockMessageRecorder,
        mockAudit,
        db,
        config,
      );

      const event = createEvent({
        type: "routine.morning_routine",
        source: "dashboard_regenerate",
        priority: EventPriority.NORMAL,
      });

      expect(dispatcher.isReactive(event)).toBe(true);
    });

    it("classifies normal routine events as non-reactive", () => {
      const config = makeConfig();
      const dispatcher = new EventDispatcher(
        eventBus,
        mockAgentCore,
        mockContextBuilder,
        mockGetTaskFlow,
        mockNotificationMgr,
        mockSessionMgr,
        mockMessageRecorder,
        mockAudit,
        db,
        config,
      );

      const event = {
        ...createEvent({
          type: "routine.activity_scan",
          source: "cron",
          priority: EventPriority.NORMAL,
        }),
        routine: "activity_scan",
      };

      expect(dispatcher.isReactive(event)).toBe(false);
    });

    it("classifies knowledge.import as reactive", () => {
      // The dashboard Knowledge upload form fires this event while the
      // user is on the page waiting for a response. Without reactive
      // classification the dispatchSafe gate would silently skip the
      // event when setup is incomplete or the autonomous cost cap was
      // hit — the user would see 202 + traceId but no agent run.
      const config = makeConfig();
      const dispatcher = new EventDispatcher(
        eventBus,
        mockAgentCore,
        mockContextBuilder,
        mockGetTaskFlow,
        mockNotificationMgr,
        mockSessionMgr,
        mockMessageRecorder,
        mockAudit,
        db,
        config,
      );

      const event = {
        ...createEvent({
          type: "knowledge.import",
          source: "dashboard_knowledge_upload",
          priority: EventPriority.HIGH,
        }),
        type: "knowledge.import" as const,
        platform: "dashboard",
        scratchPath: "state/scratch/import-2026-04-27-x.md",
        filename: "profile.md",
        source: "self-written" as const,
        uploadDate: "2026-04-27",
      } as unknown as Event;

      expect(dispatcher.isReactive(event)).toBe(true);
    });
  });

  describe("processInline", () => {
    it("processes an event synchronously without going through EventBus", async () => {
      const config = makeConfig();
      vi.mocked(mockAgentCore.execute).mockResolvedValue(
        makeResult({ output: "inline result" }),
      );

      const dispatcher = new EventDispatcher(
        eventBus,
        mockAgentCore,
        mockContextBuilder,
        mockGetTaskFlow,
        mockNotificationMgr,
        mockSessionMgr,
        mockMessageRecorder,
        mockAudit,
        db,
        config,
      );

      const event = {
        ...createEvent({
          type: "routine.evening_review",
          source: "test",
          priority: EventPriority.HIGH,
        }),
        routine: "evening_review",
      };

      await dispatcher.processInline(event);

      expect(mockAgentCore.execute).toHaveBeenCalled();
      expect(mockAudit.logAction).toHaveBeenCalled();
    });
  });

  describe("beginSetupMode edge cases", () => {
    it("logs warning when replacing setup mode with a different mode", () => {
      const config = makeConfig();
      const dispatcher = new EventDispatcher(
        eventBus,
        mockAgentCore,
        mockContextBuilder,
        mockGetTaskFlow,
        mockNotificationMgr,
        mockSessionMgr,
        mockMessageRecorder,
        mockAudit,
        db,
        config,
      );

      dispatcher.beginSetupMode("initial");
      expect(dispatcher.getCurrentSetupMode()).toBe("initial");

      // Replacing with a different mode should work (logs warning internally)
      dispatcher.beginSetupMode("update");
      expect(dispatcher.getCurrentSetupMode()).toBe("update");

      dispatcher.clearSetupMode();
    });

    it("clearSetupMode is idempotent (no error when called without beginSetupMode)", () => {
      const config = makeConfig();
      const dispatcher = new EventDispatcher(
        eventBus,
        mockAgentCore,
        mockContextBuilder,
        mockGetTaskFlow,
        mockNotificationMgr,
        mockSessionMgr,
        mockMessageRecorder,
        mockAudit,
        db,
        config,
      );

      // Should not throw
      dispatcher.clearSetupMode();
      dispatcher.clearSetupMode();
      expect(dispatcher.getCurrentSetupMode()).toBeNull();
    });
  });

  describe("isObserverEvent classification", () => {
    it("classifies activity_scan as observer event", () => {
      const config = makeConfig();
      const dispatcher = new EventDispatcher(
        eventBus,
        mockAgentCore,
        mockContextBuilder,
        mockGetTaskFlow,
        mockNotificationMgr,
        mockSessionMgr,
        mockMessageRecorder,
        mockAudit,
        db,
        config,
      );

      const resultProcessor = (dispatcher as unknown as {
        resultProcessor: { isObserverEvent(e: Event): boolean };
      }).resultProcessor;
      const isObs = resultProcessor.isObserverEvent.bind(resultProcessor);

      // activity_scan
      const hourly = {
        ...createEvent({ type: "routine.activity_scan", source: "cron", priority: EventPriority.NORMAL }),
        routine: "activity_scan",
      };
      expect(isObs(hourly)).toBe(true);

      // calendar events
      const calEvent = createEvent({ type: "calendar.updated", source: "cal", priority: EventPriority.NORMAL });
      expect(isObs(calEvent)).toBe(true);

      // schedule.approaching
      const approaching = createEvent({ type: "schedule.approaching", source: "cal", priority: EventPriority.NORMAL });
      expect(isObs(approaching)).toBe(true);

      // notion events
      const notion = createEvent({ type: "notion.updated", source: "notion", priority: EventPriority.NORMAL });
      expect(isObs(notion)).toBe(true);

      // non-observer event
      const dm = {
        ...createEvent({ type: "message.received", source: "dashboard", priority: EventPriority.HIGH }),
        sender: "user",
        channel: "ch1",
        content: "hi",
        platform: "dashboard",
        threadId: null,
        isDm: true,
        isMention: false,
      };
      expect(isObs(dm)).toBe(false);

      // evening_review is not an observer event
      const evening = {
        ...createEvent({ type: "routine.evening_review", source: "cron", priority: EventPriority.HIGH }),
        routine: "evening_review",
      };
      expect(isObs(evening)).toBe(false);
    });
  });

  describe("summarizeDmSessions error handling", () => {
    it("continues with other platforms when one platform summarization fails", async () => {
      vi.mocked(mockSessionMgr.getDmPlatformsWithNewMessages).mockReturnValue([
        "slack",
        "discord",
      ]);
      // Slack: returns 0 messages
      vi.mocked(mockSessionMgr.getUnsummarizedDmMessages).mockImplementation(
        (platform: string) => {
          if (platform === "slack") return [];
          // Discord: 31 messages
          return Array.from({ length: 31 }, (_, i) => ({
            role: i % 2 === 0 ? "user" : "assistant",
            content: `msg ${i}`,
            timestamp: new Date(Date.now() - (31 - i) * 60000)
              .toISOString()
              .replace("T", " ")
              .replace(/\.\d{3}Z$/, ""),
          }));
        },
      );
      vi.mocked(mockAgentCore.summarize).mockResolvedValue("Discord summary");

      const config = makeConfig();
      const dispatcher = new EventDispatcher(
        eventBus,
        mockAgentCore,
        mockContextBuilder,
        mockGetTaskFlow,
        mockNotificationMgr,
        mockSessionMgr,
        mockMessageRecorder,
        mockAudit,
        db,
        config,
      );

      await dispatcher.summarizeDmSessions();

      // Only discord should have been summarized (slack had 0 messages)
      expect(mockSessionMgr.saveDmSummary).toHaveBeenCalledWith("discord", "Discord summary", 31);
    });

    it("handles summarize error without crashing", async () => {
      vi.mocked(mockSessionMgr.getDmPlatformsWithNewMessages).mockReturnValue(["dashboard"]);
      vi.mocked(mockSessionMgr.getUnsummarizedDmMessages).mockReturnValue(
        Array.from({ length: 31 }, (_, i) => ({
          role: "user",
          content: `msg ${i}`,
          timestamp: new Date(Date.now() - (31 - i) * 60000)
            .toISOString()
            .replace("T", " ")
            .replace(/\.\d{3}Z$/, ""),
        })),
      );
      vi.mocked(mockAgentCore.summarize).mockRejectedValue(new Error("API error"));

      const config = makeConfig();
      const dispatcher = new EventDispatcher(
        eventBus,
        mockAgentCore,
        mockContextBuilder,
        mockGetTaskFlow,
        mockNotificationMgr,
        mockSessionMgr,
        mockMessageRecorder,
        mockAudit,
        db,
        config,
      );

      // Should not throw
      await dispatcher.summarizeDmSessions();
      expect(mockSessionMgr.saveDmSummary).not.toHaveBeenCalled();
    });
  });

  describe("resolveQuotaResetAtMs", () => {
    it("advances to the next day when reset time has already passed today", () => {
      const config = makeConfig({ timezone: "UTC" });
      const dispatcher = new EventDispatcher(
        eventBus,
        mockAgentCore,
        mockContextBuilder,
        mockGetTaskFlow,
        mockNotificationMgr,
        mockSessionMgr,
        mockMessageRecorder,
        mockAudit,
        db,
        config,
      );

      const errorRouter = (dispatcher as unknown as {
        errorRouter: {
          resolveQuotaResetAtMs(hint: { hour: number; minute: number; timeZone?: string }): number | null;
        };
      }).errorRouter;
      const resolveQuotaResetAtMs = errorRouter.resolveQuotaResetAtMs.bind(errorRouter);

      // Use hour 0, minute 0 — if current time is after midnight UTC,
      // the result should be tomorrow's midnight
      const resetMs = resolveQuotaResetAtMs({ hour: 0, minute: 0, timeZone: "UTC" });
      expect(resetMs).not.toBeNull();
      if (resetMs !== null) {
        const resetDate = new Date(resetMs);
        // Should be in the future
        expect(resetDate.getTime()).toBeGreaterThan(Date.now());
      }
    });
  });

  // `localDateTimeToUtcMs` and friends were extracted to
  // `dispatcher-date-utils.ts` as part of phase D-2; their tests live next
  // to the implementation in `dispatcher-date-utils.test.ts`.

  // ──────────────────────────────────────────────────────────────────
  // Phase 7 §6.1: /auth fix all
  // ──────────────────────────────────────────────────────────────────

  describe("/auth fix all (Phase 7 §6.1)", () => {
    function makeAuthFixAllDispatcher(
      overrides: {
        listExpiredBackends?: () => string[];
        isRecoveryActive?: (id: string) => boolean;
        initiateClaudeAuth?: () => Promise<unknown>;
        initiateCodexDeviceAuth?: () => Promise<unknown>;
        initiateGeminiAuth?: () => Promise<unknown>;
        renderStatusSummary?: () => string;
      } = {},
    ) {
      const config = makeConfig();
      const dispatcher = new EventDispatcher(
        eventBus,
        mockAgentCore,
        mockContextBuilder,
        mockGetTaskFlow,
        mockNotificationMgr,
        mockSessionMgr,
        mockMessageRecorder,
        mockAudit,
        db,
        config,
      );

      const mockAuthRecovery = {
        isRecoveryActive: vi.fn().mockImplementation(
          overrides.isRecoveryActive ?? (() => false),
        ),
        getActiveRecovery: vi.fn().mockReturnValue(null),
        initiateClaudeAuth: vi.fn().mockImplementation(
          overrides.initiateClaudeAuth ??
            (() => Promise.resolve({ authUrl: "https://claude.com/cai/oauth/authorize?...", expiresMinutes: 10 })),
        ),
        initiateCodexDeviceAuth: vi.fn().mockImplementation(
          overrides.initiateCodexDeviceAuth ??
            (() => Promise.resolve({ authUrl: "https://auth.openai.com/codex/device", userCode: "TEST-CODE", expiresMinutes: 15 })),
        ),
        initiateGeminiAuth: vi.fn().mockImplementation(
          overrides.initiateGeminiAuth ??
            (() => Promise.resolve({ authUrl: "https://accounts.google.com/o/oauth2/auth?...", expiresMinutes: 5 })),
        ),
        cancelRecovery: vi.fn().mockReturnValue(false),
        handleGeminiAuthCode: vi.fn(),
        shutdown: vi.fn(),
      };

      const mockAuthMonitor = {
        listExpiredBackends: vi.fn().mockImplementation(
          overrides.listExpiredBackends ?? (() => []),
        ),
        renderStatusSummary: vi.fn().mockImplementation(
          overrides.renderStatusSummary ?? (() => "Auth Status\n\nclaude — ok\ncodex — ok\ngemini — ok"),
        ),
        checkAll: vi.fn(),
      };

      dispatcher.setAuthRecovery(mockAuthRecovery as never);
      dispatcher.setAuthHealthMonitor(mockAuthMonitor as never);

      return { dispatcher, mockAuthRecovery, mockAuthMonitor };
    }

    function makeAuthFixAllDm(): MessageEvent {
      return {
        ...createEvent({
          type: "message.received",
          source: "slack",
          priority: EventPriority.HIGH,
        }),
        sender: "owner",
        channel: "D123",
        content: "/auth fix all",
        platform: "slack",
        threadId: null,
        isDm: true,
        isMention: false,
      } as MessageEvent;
    }

    it("returns early with 'all OK' when no backends are expired", async () => {
      const { dispatcher } = makeAuthFixAllDispatcher({
        listExpiredBackends: () => [],
      });
      const event = makeAuthFixAllDm();

      // Access private handleAuthCommand via handleMessage
      const handleAuth = (dispatcher as unknown as {
        handleAuthCommand: (e: MessageEvent) => Promise<boolean>;
      }).handleAuthCommand.bind(dispatcher);
      const consumed = await handleAuth(event);

      expect(consumed).toBe(true);
      expect(mockNotificationMgr.send).toHaveBeenCalledWith(
        expect.stringContaining("All backends are healthy"),
        event,
      );
    });

    it("initiates claude browser auth recovery (Phase 9)", async () => {
      const { dispatcher, mockAuthRecovery } = makeAuthFixAllDispatcher({
        listExpiredBackends: () => ["claude"] as string[],
      });
      const event = makeAuthFixAllDm();

      const handleAuth = (dispatcher as unknown as {
        handleAuthCommand: (e: MessageEvent) => Promise<boolean>;
      }).handleAuthCommand.bind(dispatcher);
      await handleAuth(event);

      // Claude should trigger initiateClaudeAuth, not codex/gemini
      expect(mockAuthRecovery.initiateClaudeAuth).toHaveBeenCalledOnce();
      expect(mockAuthRecovery.initiateCodexDeviceAuth).not.toHaveBeenCalled();
      expect(mockAuthRecovery.initiateGeminiAuth).not.toHaveBeenCalled();
      // Message should include recovery URL
      expect(mockNotificationMgr.send).toHaveBeenCalledWith(
        expect.stringContaining("claude"),
        event,
      );
    });

    it("initiates codex recovery for a single expired backend", async () => {
      const { dispatcher, mockAuthRecovery } = makeAuthFixAllDispatcher({
        listExpiredBackends: () => ["codex"] as string[],
      });
      const event = makeAuthFixAllDm();

      const handleAuth = (dispatcher as unknown as {
        handleAuthCommand: (e: MessageEvent) => Promise<boolean>;
      }).handleAuthCommand.bind(dispatcher);
      await handleAuth(event);

      expect(mockAuthRecovery.initiateCodexDeviceAuth).toHaveBeenCalledOnce();
      expect(mockAuthRecovery.initiateGeminiAuth).not.toHaveBeenCalled();
      expect(mockNotificationMgr.send).toHaveBeenCalledWith(
        expect.stringContaining("codex"),
        event,
      );
    });

    it("runs codex then gemini sequentially when both expired", async () => {
      const callOrder: string[] = [];
      const { dispatcher } = makeAuthFixAllDispatcher({
        listExpiredBackends: () => ["codex", "gemini"] as string[],
        initiateCodexDeviceAuth: async () => {
          callOrder.push("codex");
          return { authUrl: "https://auth.openai.com/codex/device", userCode: "TEST-CODE", expiresMinutes: 15 };
        },
        initiateGeminiAuth: async () => {
          callOrder.push("gemini");
          return { authUrl: "https://accounts.google.com/o/oauth2/auth?...", expiresMinutes: 5 };
        },
      });
      const event = makeAuthFixAllDm();

      const handleAuth = (dispatcher as unknown as {
        handleAuthCommand: (e: MessageEvent) => Promise<boolean>;
      }).handleAuthCommand.bind(dispatcher);
      await handleAuth(event);

      // Both should be called, in order
      expect(callOrder).toEqual(["codex", "gemini"]);
      // Final message should include status summary
      expect(mockNotificationMgr.send).toHaveBeenCalledWith(
        expect.stringContaining("Auth Status"),
        event,
      );
    });

    it("skips backends with active recovery in progress", async () => {
      const { dispatcher, mockAuthRecovery } = makeAuthFixAllDispatcher({
        listExpiredBackends: () => ["codex"] as string[],
        isRecoveryActive: (id) => id === "codex",
      });
      const event = makeAuthFixAllDm();

      const handleAuth = (dispatcher as unknown as {
        handleAuthCommand: (e: MessageEvent) => Promise<boolean>;
      }).handleAuthCommand.bind(dispatcher);
      await handleAuth(event);

      // Should not attempt recovery since it's already active
      expect(mockAuthRecovery.initiateCodexDeviceAuth).not.toHaveBeenCalled();
      expect(mockNotificationMgr.send).toHaveBeenCalledWith(
        expect.stringContaining("already in progress"),
        event,
      );
    });

    it("handles recovery initiation failure gracefully", async () => {
      const { dispatcher } = makeAuthFixAllDispatcher({
        listExpiredBackends: () => ["codex"] as string[],
        initiateCodexDeviceAuth: async () => {
          throw new Error("CLI not found");
        },
      });
      const event = makeAuthFixAllDm();

      const handleAuth = (dispatcher as unknown as {
        handleAuthCommand: (e: MessageEvent) => Promise<boolean>;
      }).handleAuthCommand.bind(dispatcher);
      await handleAuth(event);

      // Should report the error but not crash
      expect(mockNotificationMgr.send).toHaveBeenCalledWith(
        expect.stringContaining("CLI not found"),
        event,
      );
    });

    it("handles all three backends: claude + codex + gemini (all automated)", async () => {
      const { dispatcher, mockAuthRecovery } = makeAuthFixAllDispatcher({
        listExpiredBackends: () => ["claude", "codex", "gemini"] as string[],
      });
      const event = makeAuthFixAllDm();

      const handleAuth = (dispatcher as unknown as {
        handleAuthCommand: (e: MessageEvent) => Promise<boolean>;
      }).handleAuthCommand.bind(dispatcher);
      await handleAuth(event);

      // All three: initiated
      expect(mockAuthRecovery.initiateClaudeAuth).toHaveBeenCalledOnce();
      expect(mockAuthRecovery.initiateCodexDeviceAuth).toHaveBeenCalledOnce();
      expect(mockAuthRecovery.initiateGeminiAuth).toHaveBeenCalledOnce();
      const sentMessage = (mockNotificationMgr.send as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(sentMessage).toContain("claude");            // claude result
      expect(sentMessage).toContain("codex");             // codex result
      expect(sentMessage).toContain("gemini");            // gemini result
      expect(sentMessage).toContain("Auth Status");       // status summary appended
    });
  });

  describe("docs_qa intent gates (DOCS_QA_B7_DESIGN.md S1d)", () => {
    /**
     * Build a docs_qa MessageEvent. Mirrors what `DocsQAAdapter.handleIncomingMessage`
     * would emit once Phase 2 lands.
     */
    function makeDocsQAEvent(content = "what does morning routine produce?"): MessageEvent {
      return {
        ...createEvent({
          type: "message.received",
          source: "dashboard",
          priority: EventPriority.HIGH,
        }),
        sender: "user",
        channel: "qa-channel-1",
        content,
        platform: "dashboard",
        threadId: null,
        isDm: true,
        isMention: false,
        intent: "docs_qa",
      } as MessageEvent;
    }

    function makeChatEvent(content = "hi"): MessageEvent {
      return {
        ...createEvent({
          type: "message.received",
          source: "dashboard",
          priority: EventPriority.HIGH,
        }),
        sender: "user",
        channel: "chat-channel-1",
        content,
        platform: "dashboard",
        threadId: null,
        isDm: true,
        isMention: false,
      } as MessageEvent;
    }

    /**
     * Drain the dispatcher: put a sentinel low-priority event after the
     * subject event, run() until both have been consumed, then stop().
     * Mirrors the routine-event tests above.
     */
    async function runOnce(dispatcher: EventDispatcher, event: Event): Promise<void> {
      const runPromise = dispatcher.run();
      await eventBus.put(event);
      await new Promise((r) => setTimeout(r, 50));
      dispatcher.stop();
      await eventBus.put(
        createEvent({ type: "dummy", source: "test", priority: EventPriority.LOW }),
      );
      await Promise.race([runPromise, new Promise((r) => setTimeout(r, 100))]);
    }

    it("forces promptKey='dashboard.docs_qa' and skips upsertOwnerChannel + signalDetector for docs_qa events", async () => {
      const dispatcher = new EventDispatcher(
        eventBus,
        {
          ...mockAgentCore,
          resolveBinding: vi.fn().mockReturnValue({
            processKey: "dashboard.docs_qa",
            resolvedTier: "light",
            main: { backendId: "claude", modelId: "claude-sonnet-4-6", maxTurns: 20, maxBudgetUsd: 0.5 },
            fallback: null,
          }),
        },
        mockContextBuilder,
        mockGetTaskFlow,
        mockNotificationMgr,
        mockSessionMgr,
        mockMessageRecorder,
        mockAudit,
        db,
        makeConfig(),
      );
      const onUserMessage = vi.fn();
      dispatcher.setSignalDetector({ onUserMessage } as unknown as Parameters<typeof dispatcher.setSignalDetector>[0]);

      await runOnce(dispatcher, makeDocsQAEvent());

      // The QA system prompt loads from the dashboard.docs_qa task flow.
      // Without this gate, the dispatcher would load message.received.dm.md
      // and the model would behave like a regular DM (no citation rules).
      expect(mockGetTaskFlow).toHaveBeenCalledWith(
        "dashboard.docs_qa",
        expect.anything(),
        expect.anything(),
      );

      // QA messages are not feedback signals.
      expect(onUserMessage).not.toHaveBeenCalled();

      // QA traffic must not register synthetic owner-channel pairings.
      const ownerChannelRows = db
        .prepare("SELECT COUNT(*) as cnt FROM owner_channels")
        .get() as { cnt: number };
      expect(ownerChannelRows.cnt).toBe(0);
    });

    it("preserves existing chat behavior when intent is undefined or 'chat'", async () => {
      const dispatcher = new EventDispatcher(
        eventBus,
        mockAgentCore,
        mockContextBuilder,
        mockGetTaskFlow,
        mockNotificationMgr,
        mockSessionMgr,
        mockMessageRecorder,
        mockAudit,
        db,
        makeConfig(),
      );
      const onUserMessage = vi.fn();
      dispatcher.setSignalDetector({ onUserMessage } as unknown as Parameters<typeof dispatcher.setSignalDetector>[0]);

      await runOnce(dispatcher, makeChatEvent("hello"));

      // Chat events still feed the signal detector and pair the channel.
      expect(onUserMessage).toHaveBeenCalledTimes(1);
      const ownerChannelRows = db
        .prepare("SELECT COUNT(*) as cnt FROM owner_channels")
        .get() as { cnt: number };
      expect(ownerChannelRows.cnt).toBe(1);
    });

    it("strips invalid [doc:slug] tokens before persisting and logs qa_invalid_citation", async () => {
      // Stub agent core to emit one valid + one slug-missing token.
      const validSlug = "features/routines/morning-routine";
      const validAnchor = "what-it-outputs";
      const invalidSlug = "nope/missing-doc";
      const agentCore = {
        ...mockAgentCore,
        execute: vi.fn().mockResolvedValue(
          makeResult({
            output: `Morning routine outputs today.md [doc:${validSlug}#${validAnchor}]. Bogus claim [doc:${invalidSlug}].`,
          }),
        ),
        resolveBinding: vi.fn().mockReturnValue({
          processKey: "dashboard.docs_qa",
          resolvedTier: "light",
          main: { backendId: "claude", modelId: "claude-sonnet-4-6", maxTurns: 20, maxBudgetUsd: 0.5 },
          fallback: null,
        }),
      };

      const dispatcher = new EventDispatcher(
        eventBus,
        agentCore,
        mockContextBuilder,
        mockGetTaskFlow,
        mockNotificationMgr,
        mockSessionMgr,
        mockMessageRecorder,
        mockAudit,
        db,
        makeConfig(),
      );
      // Hand-rolled lookup so we don't depend on fts_docs being populated.
      dispatcher.setDocsCitationLookup({
        anchorsForSlug: (slug) => (slug === validSlug ? [validAnchor] : null),
      });

      await runOnce(dispatcher, makeDocsQAEvent());

      const recordCalls = (mockMessageRecorder.recordMessage as ReturnType<typeof vi.fn>).mock.calls;
      const assistantCall = recordCalls.find(
        (call) => (call[0] as { role: string }).role === "assistant",
      );
      expect(assistantCall).toBeDefined();
      const persistedContent = (assistantCall![0] as { content: string }).content;
      // Valid token survives; invalid one is stripped from the persisted content.
      expect(persistedContent).toContain(`[doc:${validSlug}#${validAnchor}]`);
      expect(persistedContent).not.toContain(invalidSlug);

      const auditRows = db
        .prepare("SELECT COUNT(*) as cnt FROM agent_actions WHERE action_type = 'qa_invalid_citation'")
        .all() as Array<{ cnt: number }>;
      expect(auditRows[0].cnt).toBe(1);
    });

    it("ignores currentSetupMode for docs_qa events — resolves binding via dashboard.docs_qa, not setup", async () => {
      // A QA event arriving while setup is in progress (operator opens
      // the Docs QA panel in another tab) must NOT be routed through
      // the setup processKey. Without this gate, `processKey="setup"`
      // would bypass `TIER_LOCKED_PROCESS_KEYS["dashboard.docs_qa"]`,
      // letting the QA panel silently run on the heavy setup tier with
      // setup skills materialized. The §11.2 promptKey fix would still
      // emit the QA prompt, producing an incoherent "QA prompt + setup
      // tools + heavy tier" execution.
      const resolveBinding = vi.fn().mockReturnValue({
        processKey: "dashboard.docs_qa",
        resolvedTier: "light",
        main: { backendId: "claude", modelId: "claude-sonnet-4-6", maxTurns: 20, maxBudgetUsd: 0.5 },
        fallback: null,
      });
      const dispatcher = new EventDispatcher(
        eventBus,
        { ...mockAgentCore, resolveBinding },
        mockContextBuilder,
        mockGetTaskFlow,
        mockNotificationMgr,
        mockSessionMgr,
        mockMessageRecorder,
        mockAudit,
        db,
        makeConfig(),
      );
      // Engage setup mode globally — simulates the dashboard setup
      // wizard being mid-flight in tab A.
      dispatcher.beginSetupMode("initial");

      await runOnce(dispatcher, makeDocsQAEvent("what does morning routine output?"));

      expect(resolveBinding).toHaveBeenCalled();
      const call = resolveBinding.mock.calls[0];
      const opts = call[1] as { processKey: string };
      expect(opts.processKey).toBe("dashboard.docs_qa");
      expect(opts.processKey).not.toBe("setup");

      // The QA prompt — not setup.initial — is loaded.
      expect(mockGetTaskFlow).toHaveBeenCalledWith(
        "dashboard.docs_qa",
        expect.anything(),
        expect.anything(),
      );
    });

    it("does not flip currentSetupMode when a docs_qa event smuggles in data.setupMode", async () => {
      // Defense-in-depth: a malformed docs_qa event carrying
      // `data.setupMode` must not silently engage global setup mode for
      // the dispatcher (which would then hijack subsequent owner DMs
      // into the rules-generator agent).
      const dispatcher = new EventDispatcher(
        eventBus,
        {
          ...mockAgentCore,
          resolveBinding: vi.fn().mockReturnValue({
            processKey: "dashboard.docs_qa",
            resolvedTier: "light",
            main: { backendId: "claude", modelId: "claude-sonnet-4-6", maxTurns: 20, maxBudgetUsd: 0.5 },
            fallback: null,
          }),
        },
        mockContextBuilder,
        mockGetTaskFlow,
        mockNotificationMgr,
        mockSessionMgr,
        mockMessageRecorder,
        mockAudit,
        db,
        makeConfig(),
      );
      const evil = makeDocsQAEvent();
      evil.data = { ...evil.data, setupMode: "initial" };

      expect(dispatcher.getCurrentSetupMode()).toBeNull();
      await runOnce(dispatcher, evil);
      expect(dispatcher.getCurrentSetupMode()).toBeNull();
    });

    it("does not inject cross-session conversation history into docs_qa sessions", async () => {
      // §11.6 — "QA panel state lives in React state, not the DB."
      // Without the gate in dispatcher (~:2355), a docs_qa session that
      // gets reset (day boundary, model switch) would re-inject every
      // prior message in the docs_qa scope as cross-session history,
      // contradicting the stateless contract and silently growing the
      // QA token budget across days.
      const sessionMgr = {
        ...mockSessionMgr,
        getOrCreate: vi.fn().mockResolvedValue({
          id: 1,
          isActive: false,
          sessionId: null,
          model: "claude-sonnet-4-6",
          backend: "claude",
          // Force the dispatcher to consider injecting history.
          requiresHistoryInjection: true,
        }),
      };
      // Seed the docs_qa scope with prior messages so a non-gated
      // `buildCrossSessionConversationHistory` would have content to
      // inject.
      db.prepare(
        `INSERT INTO conversation_sessions (id, platform, channel_id, scope, scope_key, status)
         VALUES (1, 'dashboard', 'qa-channel-1', 'docs_qa', 'docs_qa', 'active')`,
      ).run();
      db.prepare(
        `INSERT INTO messages (session_id, role, content, platform)
         VALUES (1, 'user', 'older question', 'dashboard'),
                (1, 'assistant', 'older answer', 'dashboard')`,
      ).run();

      const execute = vi.fn().mockResolvedValue(makeResult());
      const dispatcher = new EventDispatcher(
        eventBus,
        {
          ...mockAgentCore,
          execute,
          resolveBinding: vi.fn().mockReturnValue({
            processKey: "dashboard.docs_qa",
            resolvedTier: "light",
            main: { backendId: "claude", modelId: "claude-sonnet-4-6", maxTurns: 20, maxBudgetUsd: 0.5 },
            fallback: null,
          }),
        },
        mockContextBuilder,
        mockGetTaskFlow,
        mockNotificationMgr,
        sessionMgr,
        mockMessageRecorder,
        mockAudit,
        db,
        makeConfig(),
      );

      await runOnce(dispatcher, makeDocsQAEvent("a fresh question"));

      expect(execute).toHaveBeenCalledTimes(1);
      const params = execute.mock.calls[0][0] as { conversationHistory?: string };
      // Either undefined or a missing field is acceptable; the bug
      // would surface as a non-empty history string referencing the
      // older messages.
      expect(params.conversationHistory).toBeUndefined();
    });
  });

  describe("delegated connector-health DM (§4.5)", () => {
    /**
     * Direct unit test for the private `runDelegatedConnectorWarningDispatch`
     * — the higher-level run() pipeline is exercised end-to-end by other
     * tests, but the warning's two-arms behaviour (notification + dashboard
     * persist vs. notification only) is a small, well-bounded contract that
     * deserves a focused test rather than a cross-cutting integration setup.
     */
    function buildDispatcher(): EventDispatcher {
      const config = makeConfig();
      return new EventDispatcher(
        eventBus,
        mockAgentCore,
        mockContextBuilder,
        mockGetTaskFlow,
        mockNotificationMgr,
        mockSessionMgr,
        mockMessageRecorder,
        mockAudit,
        db,
        config,
      );
    }

    function makeDashboardDmEvent(): MessageEvent {
      return {
        ...createEvent({
          type: "message.received",
          source: "dashboard",
          priority: EventPriority.HIGH,
        }),
        sender: "user",
        channel: "ch-1",
        content: "hi",
        platform: "dashboard",
        threadId: null,
        isDm: true,
        isMention: false,
      } as MessageEvent;
    }

    function makeSlackDmEvent(): MessageEvent {
      return {
        ...createEvent({
          type: "message.received",
          source: "slack",
          priority: EventPriority.HIGH,
        }),
        sender: "user",
        channel: "U0000",
        content: "hi",
        platform: "slack",
        threadId: null,
        isDm: true,
        isMention: false,
      } as MessageEvent;
    }

    const warning = {
      integration: "notion",
      backend: "claude",
      displayName: "Notion",
      missingRequired: ["search", "read"],
    } as const;

    it("persists the DM into `messages` for dashboard channels — survives chat_meta history reload", async () => {
      const dispatcher = buildDispatcher();

      // Direct method invocation so this test stays bounded to the
      // dispatch arm of the §4.5 helper. The end-to-end gating logic
      // (consult + setup-mode skip + dispatch-after-recordMessage
      // ordering) is exercised by the EventDispatcher.run() integration
      // tests above.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (dispatcher as any).errorRouter.runDelegatedConnectorWarningDispatch(
        [warning],
        makeDashboardDmEvent(),
        "claude",
        42,
      );

      // notificationMgr.send is awaited inside the helper's `void` chain;
      // flush microtasks so the .then() persistence runs before assertions.
      await new Promise((resolve) => setImmediate(resolve));

      const sendMock = vi.mocked(mockNotificationMgr.send);
      expect(sendMock).toHaveBeenCalledTimes(1);
      const [sentMessage, sentEvent, sentOptions] = sendMock.mock.calls[0];
      expect(sentMessage).toContain("Notion");
      expect(sentMessage).toContain("appears signed out");
      expect((sentEvent as MessageEvent).platform).toBe("dashboard");
      expect(sentOptions).toMatchObject({
        priority: "high",
        category: "delegated_signout",
      });

      const recordMock = vi.mocked(mockMessageRecorder.recordMessage);
      expect(recordMock).toHaveBeenCalledTimes(1);
      expect(recordMock.mock.calls[0][0]).toMatchObject({
        sessionId: 42,
        role: "assistant",
        platform: "dashboard",
        backend: "claude",
      });
      expect(
        (recordMock.mock.calls[0][0] as { content: string }).content,
      ).toContain("Notion");
    });

    it("does not persist into `messages` for non-dashboard platforms (Slack/Telegram own their own message stores)", async () => {
      const dispatcher = buildDispatcher();

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (dispatcher as any).errorRouter.runDelegatedConnectorWarningDispatch(
        [warning],
        makeSlackDmEvent(),
        "claude",
        99,
      );

      await new Promise((resolve) => setImmediate(resolve));

      expect(vi.mocked(mockNotificationMgr.send)).toHaveBeenCalledTimes(1);
      // Persistence is gated on `event.platform === "dashboard"` precisely
      // because non-dashboard platforms have their own message stores —
      // double-recording locally would leak DM text into a history channel
      // that doesn't currently render notification_log rows.
      expect(vi.mocked(mockMessageRecorder.recordMessage)).not.toHaveBeenCalled();
    });

    // Helpers shared by the two end-to-end gate tests below. Seeding the
    // DB inline keeps the test self-explanatory; the fixture is small
    // enough not to deserve a top-level helper.
    async function seedBrokenNotion(): Promise<void> {
      const { writeIntegrations } = await import("../db/integrations-store.js");
      const { writeProbe } = await import("../db/integration-probe-store.js");
      writeIntegrations(db, {
        notion: {
          mode: "delegated",
          deniedTools: [],
          delegatedBackend: "claude",
          lastChangedAt: new Date().toISOString(),
        },
      });
      writeProbe(db, {
        integration: "notion",
        backend: "claude",
        present: false,
        presentTools: [],
        capabilities: [],
        missingRequired: ["search", "read"],
        probedAt: new Date().toISOString(),
      });
    }

    async function fireDashboardDmThroughRunLoop(
      dispatcher: EventDispatcher,
    ): Promise<void> {
      const runPromise = dispatcher.run();
      await eventBus.put(makeDashboardDmEvent());
      // Allow the dispatcher's run loop to drain the event + the
      // `notificationMgr.send` microtask. 100ms is conservative for an
      // all-mocked synchronous chain.
      await new Promise((r) => setTimeout(r, 100));
      dispatcher.stop();
      await eventBus.put(
        createEvent({
          type: "dummy",
          source: "test",
          priority: EventPriority.LOW,
        }),
      );
      await Promise.race([
        runPromise,
        new Promise((r) => setTimeout(r, 100)),
      ]);
    }

    function signoutDmCount(): number {
      return vi
        .mocked(mockNotificationMgr.send)
        .mock.calls.filter(
          ([msg]) =>
            typeof msg === "string" && msg.includes("appears signed out"),
        ).length;
    }

    it("post-setup: cached probe says broken ⇒ warning DM fires once through run()", async () => {
      // End-to-end gate test (positive): seed an integration in delegated
      // mode + a `present=false` probe row, drive a dashboard DM through
      // the full dispatcher. With no setup mode active, the run() loop
      // must call notificationMgr.send with the rendered warning text.
      await seedBrokenNotion();

      const dispatcher = buildDispatcher();
      await fireDashboardDmThroughRunLoop(dispatcher);

      expect(signoutDmCount()).toBe(1);
      const [sentMessage] = vi
        .mocked(mockNotificationMgr.send)
        .mock.calls.find(
          ([msg]) =>
            typeof msg === "string" && msg.includes("appears signed out"),
        ) ?? [];
      expect(sentMessage).toContain("Notion");
    });

    it("setup mode: cached probe says broken ⇒ warning DM is suppressed (regression for the wizard wrong-tense bubble)", async () => {
      // End-to-end gate test (negative): same broken probe state, but the
      // dispatcher is in `currentSetupMode === "initial"`. The run() loop
      // must skip the §4.5 consult entirely so the wizard's fresh
      // `present=false` row never produces a wrong-tense
      // "Re-authorize from your … connector settings, then re-run the
      // integration probe from the dashboard" DM mid-setup.
      await seedBrokenNotion();

      const dispatcher = buildDispatcher();
      dispatcher.beginSetupMode("initial");
      await fireDashboardDmThroughRunLoop(dispatcher);

      expect(signoutDmCount()).toBe(0);
    });
  });

  // ── Agent execution recording (AGENT_DEFINITIONS_DESIGN.md §8) ──
  describe("Agent execution recording (Phase 7)", () => {
    function wireTracker(config: AgentConfig) {
      const audit = new AuditLogger(db);
      const recorder = new AgentExecutionRecorder({
        db,
        dayBoundaryHour: config.dayBoundaryHour,
        timezone: "UTC",
      });
      const tracker = new AgentExecutionTracker({
        db,
        recorder,
        contextDir: join(config.dataDir, "context"),
        emitSse: () => {},
        loadCriteria: () => [],
      });
      audit.setAgentIdResolver((event) =>
        tracker.currentAgentId(event.correlationId),
      );
      const dispatcher = new EventDispatcher(
        eventBus,
        mockAgentCore,
        mockContextBuilder,
        mockGetTaskFlow,
        mockNotificationMgr,
        mockSessionMgr,
        mockMessageRecorder,
        audit,
        db,
        config,
      );
      dispatcher.setAgentExecutionTracker(tracker);
      return dispatcher;
    }

    function routineEvent(routine: string): RoutineEvent {
      return {
        ...createEvent({
          type: `routine.${routine}`,
          source: "scheduler",
          priority: EventPriority.NORMAL,
        }),
        routine,
      } as RoutineEvent;
    }

    it("creates an agent_executions row + stamps agent_actions for a built-in routine firing", async () => {
      upsertAgent(db, {
        slug: "evening-review",
        name: "Evening review",
        source: "builtin",
        definitionPath: "/agents/evening-review/agent.md",
        definitionHash: "h",
        enabled: true,
        scheduleKind: "cron",
        scheduleExpression: "0 18 * * *",
        scheduleTimezone: "UTC",
      });
      const dispatcher = wireTracker(makeConfig({ timezone: "UTC" }));

      await dispatcher.processInline(routineEvent("evening_review"));

      const exec = db
        .prepare("SELECT agent_id, result, cost_usd FROM agent_executions")
        .get() as { agent_id: string; result: string; cost_usd: number };
      expect(exec.agent_id).toBe("evening-review");
      expect(exec.result).toBe("success");
      expect(exec.cost_usd).toBeCloseTo(0.01);
      // The owning Agent now points at this execution.
      const agentRow = db
        .prepare("SELECT last_execution_id FROM agents WHERE id = 'evening-review'")
        .get() as { last_execution_id: number };
      expect(agentRow.last_execution_id).toBeGreaterThan(0);
      // At least the turn's audit row carries the agent_id stamp.
      const stamped = db
        .prepare("SELECT COUNT(*) AS n FROM agent_actions WHERE agent_id = 'evening-review'")
        .get() as { n: number };
      expect(stamped.n).toBeGreaterThanOrEqual(1);
    });

    it("records result='skipped' for a review routine blocked by the morning-pending gate", async () => {
      // Drop the beforeEach morning-routine success seed so the pre-routine
      // gate trips and the review is skipped without running.
      db.prepare(
        "DELETE FROM agent_actions WHERE action_type = 'routine.morning_routine'",
      ).run();
      upsertAgent(db, {
        slug: "evening-review",
        name: "Evening review",
        source: "builtin",
        definitionPath: "/agents/evening-review/agent.md",
        definitionHash: "h",
        enabled: true,
        scheduleKind: "cron",
        scheduleExpression: "0 18 * * *",
        scheduleTimezone: "UTC",
      });
      const dispatcher = wireTracker(makeConfig({ timezone: "UTC" }));

      await dispatcher.processInline(routineEvent("evening_review"));

      const exec = db
        .prepare("SELECT agent_id, result, cost_usd FROM agent_executions")
        .get() as { agent_id: string; result: string; cost_usd: number | null };
      expect(exec.agent_id).toBe("evening-review");
      expect(exec.result).toBe("skipped");
      expect(exec.cost_usd).toBeNull();
      // The skip audit row is attributed to the Agent too (logSkip stamping).
      const skipRow = db
        .prepare(
          "SELECT agent_id FROM agent_actions WHERE action_type = 'routine.evening_review' AND result = 'skipped'",
        )
        .get() as { agent_id: string | null } | undefined;
      expect(skipRow?.agent_id).toBe("evening-review");
    });

    it("records no execution for a routine that resolves to no Agent", async () => {
      // evening-review Agent is NOT seeded → resolveAgentId returns null.
      const dispatcher = wireTracker(makeConfig({ timezone: "UTC" }));

      await dispatcher.processInline(routineEvent("evening_review"));

      const n = db
        .prepare("SELECT COUNT(*) AS n FROM agent_executions")
        .get() as { n: number };
      expect(n.n).toBe(0);
    });

    it("attributes the morning-routine wake (scheduled.task carrying task_context.routine, no agent_id) via §8.1 step 3", async () => {
      // The flagship daily routine fires via queue_wake → a `scheduled.task`
      // whose task_context carries `routine: "morning_routine"` but NO
      // `agent_id`. Without §8.1 step 3 for scheduled events it resolved to no
      // Agent and recorded no rollup; the resolver must now map the routine →
      // the built-in slug so the most important built-in is attributed.
      upsertAgent(db, {
        slug: "morning-routine",
        name: "Morning Routine",
        source: "builtin",
        definitionPath: "/agents/morning-routine/agent.md",
        definitionHash: "h",
        enabled: true,
        scheduleKind: "cron",
        scheduleExpression: "0 4 * * *",
        scheduleTimezone: "UTC",
      });
      const dispatcher = wireTracker(makeConfig({ timezone: "UTC" }));

      // A running wake row mirroring a ScheduleWatcher pickup (handleMorningRoutineRetry
      // marks it completed by scheduleId).
      db.prepare(
        `INSERT INTO agent_schedule
          (scheduled_for, task_type, task_description, task_context, model, status)
         VALUES (datetime('now'), 'wake', 'Morning routine.',
                 '{"routine":"morning_routine","source":"cron"}', NULL, 'running')`,
      ).run();
      const scheduleId = (db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number }).id;

      const wakeEvent = {
        ...createEvent({ type: "scheduled.task", source: "wake", priority: EventPriority.NORMAL }),
        task: "Morning routine.",
        taskContext: { routine: "morning_routine", source: "cron" },
        scheduleId,
      } as AgentTaskEvent;

      await dispatcher.processInline(wakeEvent);

      const exec = db
        .prepare("SELECT agent_id FROM agent_executions")
        .get() as { agent_id: string } | undefined;
      expect(exec?.agent_id).toBe("morning-routine");
      const agentRow = db
        .prepare("SELECT last_execution_id FROM agents WHERE id = 'morning-routine'")
        .get() as { last_execution_id: number | null };
      expect(agentRow.last_execution_id).not.toBeNull();
    });

    it("records trigger='manual' for a run-now firing (task_context.trigger='manual'), not 'cron'", async () => {
      // run-now (§9.4) enqueues a scheduled.task carrying agent_id + trigger:
      // 'manual'. The rollup must record `manual`, not the `cron` the
      // isScheduledEvent fallback would otherwise assign.
      upsertAgent(db, {
        slug: "weekly-review",
        name: "Weekly review",
        source: "builtin",
        definitionPath: "/agents/weekly-review/agent.md",
        definitionHash: "h",
        enabled: true,
        scheduleKind: "cron",
        scheduleExpression: "0 19 * * 5",
        scheduleTimezone: "UTC",
      });
      const dispatcher = wireTracker(makeConfig({ timezone: "UTC" }));

      const runNowEvent = {
        ...createEvent({ type: "scheduled.task", source: "weekly_review", priority: EventPriority.NORMAL }),
        task: "Weekly review (manual).",
        taskContext: {
          agent_id: "weekly-review",
          trigger: "manual",
          processKey: "routine.weekly_review",
          routine: "weekly_review",
        },
      } as AgentTaskEvent;

      await dispatcher.processInline(runNowEvent);

      const exec = db
        .prepare("SELECT agent_id, trigger FROM agent_executions")
        .get() as { agent_id: string; trigger: string };
      expect(exec.agent_id).toBe("weekly-review");
      expect(exec.trigger).toBe("manual");
    });
  });
});

// `parseStage2Verdict` lives in `./dispatcher-types.ts` after the phase D-1
// split; its dedicated tests live in `dispatcher-types.test.ts`.
