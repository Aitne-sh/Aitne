import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { getAgentDayDateStr } from "@aitne/shared";
import { applySchema } from "../db/schema.js";
import {
  ScheduledTaskRunner,
  SKILL_CURATION_OPTIMIZER_ALLOWED_TOOLS,
  REFRESH_ARCHITECTURE_ALLOWED_TOOLS,
  appendToWeeklyInterestsJournalSection,
  pruneWeeklyInterestsJournalBullets,
} from "./dispatcher-scheduled-tasks.js";
import { writeIntegrations } from "../db/integrations-store.js";
import { PromptAssembler } from "./dispatcher-prompt.js";
import { ResultProcessor } from "./dispatcher-result-processor.js";
import { DispatcherErrorRouter } from "./dispatcher-error-handling.js";
import { MorningRoutineRunner } from "./dispatcher-morning-routine.js";
import { EventBus } from "./event-bus.js";
import type { RoutineFetchWindowRunner } from "./routine-fetch-window-runner.js";
import type { AgentConfig } from "../config.js";
import type { IAgentRouter } from "./backends/backend-router.js";
import type {
  IAuditLogger,
  IContextBuilder,
  INotificationManager,
  IMessageRecorder,
  ISessionManager,
} from "./dispatcher-types.js";

function fakeConfig(dataDir: string): AgentConfig {
  return {
    dataDir,
    workspaceDir: join(dataDir, "workdirs"),
    apiPort: 0,
    timezone: "UTC",
    dayBoundaryHour: 4,
    character: "default",
  } as unknown as AgentConfig;
}

function makeStubFetchWindowRunner(): RoutineFetchWindowRunner {
  return {
    run: vi.fn().mockResolvedValue({
      report: {
        status: "skipped",
        fetched: 0,
        posted: 0,
        duplicates: 0,
        errors: [],
        skipped: true,
      },
      block: `<fetch_report routine="evening_review" agent_day="2026-05-11" status="skipped" fetched="0" posted="0" duplicates="0" />`,
    }),
  } as unknown as RoutineFetchWindowRunner;
}

function makeRunner(opts: {
  db: Database.Database;
  dataDir: string;
  fetchWindowRunner?: RoutineFetchWindowRunner;
}): {
  runner: ScheduledTaskRunner;
  router: IAgentRouter;
  contextBuilder: IContextBuilder;
  fetchWindowRunner: RoutineFetchWindowRunner;
  morningRoutine: MorningRoutineRunner;
} {
  const config = fakeConfig(opts.dataDir);
  const eventBus = new EventBus();
  const audit: IAuditLogger = {
    logAction: vi.fn(),
    logSkip: vi.fn(),
    logError: vi.fn(),
    logAttachment: vi.fn(),
    logBangCommand: vi.fn(),
  } as unknown as IAuditLogger;
  const notificationMgr: INotificationManager = {
    send: vi.fn().mockResolvedValue(undefined),
    beginReplyActivity: vi.fn(),
  } as unknown as INotificationManager;
  const sessionMgr = {
    getPreviousDmSummary: vi.fn().mockReturnValue(null),
  } as unknown as ISessionManager;
  const messageRecorder: IMessageRecorder = {
    recordMessage: vi.fn(),
  } as unknown as IMessageRecorder;
  const router: IAgentRouter = {
    execute: vi.fn(),
    executeResume: vi.fn(),
    summarize: vi.fn(),
    resolveBinding: vi.fn(),
  } as unknown as IAgentRouter;
  const contextBuilder: IContextBuilder = {
    build: vi.fn().mockResolvedValue(""),
    buildResumeCatchupContext: vi.fn().mockResolvedValue(null),
  };
  const prompt = new PromptAssembler({
    db: opts.db,
    config,
    getTaskFlow: () => "",
    activeTurnTokens: new Map(),
    getAttachmentStore: () => null,
    getVoiceTranscriber: () => null,
  });
  const resultProcessor = new ResultProcessor({
    db: opts.db,
    config,
    audit,
    notificationMgr,
    sessionMgr,
    notifiedEvents: new Set<string>(),
    isReactive: () => false,
    hasMessageBackendMetadataColumns: true,
  });
  const errorRouter = new DispatcherErrorRouter({
    db: opts.db,
    config,
    notificationMgr,
    messageRecorder,
    notifiedEvents: new Set<string>(),
    shutdownAwaiters: new Set<() => void>(),
    getDashboardStream: () => null,
    isShutdown: () => false,
    onRetemplateFinalize: () => {},
    onManagementScanFinalize: () => {},
  });
  const fetchWindowRunner = opts.fetchWindowRunner ?? makeStubFetchWindowRunner();
  const morningRoutine = new MorningRoutineRunner({
    db: opts.db,
    config,
    eventBus,
    contextBuilder,
    agentRouter: router,
    notificationMgr,
    todayWriteLock: undefined,
    prompt,
    errorRouter,
    resultProcessor,
    fetchWindowRunner,
    setMorningRoutineInProgress: vi.fn(),
    rotateDayFiles: vi.fn(),
    diagnoseTodayMdState: () => ({ kind: "fresh" }),
    isRoadmapStale: () => false,
    emitRoadmapRefresh: vi.fn(),
    triggerHourlyCheck: vi.fn().mockResolvedValue(undefined),
  });
  const runner = new ScheduledTaskRunner({
    db: opts.db,
    config,
    contextBuilder,
    agentRouter: router,
    prompt,
    errorRouter,
    resultProcessor,
    morningRoutine,
    fetchWindowRunner,
    roadmapWriteLock: undefined,
    writeTracker: undefined,
    getConfiguredServices: () => new Set<string>(),
    getActiveMailAccounts: () => [],
    getMaterializeOptimizerWorkdir: () => null,
    getTeardownOptimizerWorkdir: () => null,
  });
  return { runner, router, contextBuilder, fetchWindowRunner, morningRoutine };
}

describe("ScheduledTaskRunner — diagnoseTodayMdState", () => {
  let db: Database.Database;
  let dataDir: string;
  let contextDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "pa-st-"));
    contextDir = join(dataDir, "context");
    mkdirSync(contextDir, { recursive: true });
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applySchema(db);
  });

  afterEach(() => {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("returns 'missing' when today.md does not exist", () => {
    const { runner } = makeRunner({ db, dataDir });
    expect(runner.diagnoseTodayMdState()).toEqual({ kind: "missing" });
  });

  it("returns 'no_h1_date' when today.md exists but has no H1 date", () => {
    writeFileSync(join(contextDir, "today.md"), "# Today\nno date here");
    const { runner } = makeRunner({ db, dataDir });
    expect(runner.diagnoseTodayMdState()).toEqual({ kind: "no_h1_date" });
  });

  it("returns 'wrong_date' when today.md's H1 date does not match the current agent day", () => {
    writeFileSync(join(contextDir, "today.md"), "# 1999-01-01 — old day\n");
    const { runner } = makeRunner({ db, dataDir });
    const state = runner.diagnoseTodayMdState();
    expect(state.kind).toBe("wrong_date");
    if (state.kind === "wrong_date") {
      expect(state.writtenDate).toBe("1999-01-01");
      expect(state.expectedAgentDay).not.toBe("1999-01-01");
    }
  });

  it("returns 'fresh' when today.md's H1 date matches the current agent day", () => {
    // Use the real getAgentDayDateStr to compute today's expected value.
    const expected = getAgentDayDateStr("UTC", 4);
    writeFileSync(join(contextDir, "today.md"), `# ${expected} — fresh\n`);
    const { runner } = makeRunner({ db, dataDir });
    expect(runner.diagnoseTodayMdState()).toEqual({ kind: "fresh" });
  });
});

describe("ScheduledTaskRunner — hasCurrentAgentDayTodayMd", () => {
  let db: Database.Database;
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "pa-st-"));
    mkdirSync(join(dataDir, "context"), { recursive: true });
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applySchema(db);
  });

  afterEach(() => {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("is true only when diagnoseTodayMdState reports 'fresh'", () => {
    const { runner } = makeRunner({ db, dataDir });
    // No today.md → not fresh.
    expect(runner.hasCurrentAgentDayTodayMd()).toBe(false);
    const expected = getAgentDayDateStr("UTC", 4);
    writeFileSync(
      join(dataDir, "context", "today.md"),
      `# ${expected} — fresh\n`,
    );
    expect(runner.hasCurrentAgentDayTodayMd()).toBe(true);
  });
});

describe("ScheduledTaskRunner — handleMorningRoutineRetry gate", () => {
  // The retry wake fast-path skips the morning_routine session only when
  // BOTH today.md is fresh AND a `routine.morning_routine`
  // `agent_actions.result='success'` row exists for the current agent-day.
  // Skipping on today.md alone was the 2026-05-14 stall-loop failure mode
  // (handleMorningRoutineRetry-gate): if the audit row was missing
  // (daemon crash mid-write OR user manually edited today.md) every
  // hourly_check tick would queue a retry, the retry would fast-path
  // skip, and the morning_routine never actually ran — autonomous work
  // silently stalled.
  let db: Database.Database;
  let dataDir: string;
  let contextDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "pa-st-"));
    contextDir = join(dataDir, "context");
    mkdirSync(contextDir, { recursive: true });
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applySchema(db);
  });

  afterEach(() => {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  function writeFreshTodayMd(): void {
    const expected = getAgentDayDateStr("UTC", 4);
    writeFileSync(join(contextDir, "today.md"), `# ${expected} — fresh\n`);
  }

  function insertMorningRoutineSuccessRow(): void {
    db.prepare(
      `INSERT INTO agent_actions
         (action_type, trigger, result, started_at, completed_at)
       VALUES ('routine.morning_routine', 'autonomous', 'success',
               datetime('now'), datetime('now'))`,
    ).run();
  }

  function buildRetryEvent(scheduleId: number): unknown {
    return {
      type: "scheduled.task",
      source: "scheduler",
      correlationId: "test-corr",
      priority: 0,
      timestamp: new Date(),
      data: {},
      task: "Morning routine retry",
      taskContext: {
        routine: "morning_routine",
        retryCount: 1,
        originalCorrelationId: "orig-corr",
      },
      scheduleId,
    };
  }

  function insertRetryWakeRow(): number {
    const info = db
      .prepare(
        `INSERT INTO agent_schedule
           (scheduled_for, task_type, task_description, task_context, status)
         VALUES (datetime('now'), 'wake', 'Morning routine retry',
                 json('{"routine":"morning_routine","retryCount":1}'),
                 'running')`,
      )
      .run();
    return Number(info.lastInsertRowid);
  }

  it("skips when today.md is fresh AND the agent_actions success row is present", async () => {
    const { runner, morningRoutine } = makeRunner({ db, dataDir });
    writeFreshTodayMd();
    insertMorningRoutineSuccessRow();
    const spy = vi
      .spyOn(morningRoutine, "executeMorningRoutine")
      .mockResolvedValue(undefined);
    const scheduleId = insertRetryWakeRow();
    await runner.executeScheduledTask(
      buildRetryEvent(scheduleId) as Parameters<
        typeof runner.executeScheduledTask
      >[0],
    );
    expect(spy).not.toHaveBeenCalled();
    const row = db
      .prepare("SELECT status FROM agent_schedule WHERE id = ?")
      .get(scheduleId) as { status: string };
    expect(row.status).toBe("completed");
  });

  it("runs the retry when today.md is fresh BUT the success row is missing (recovers from the silent-stall failure mode)", async () => {
    const { runner, morningRoutine } = makeRunner({ db, dataDir });
    writeFreshTodayMd();
    // Intentionally NO insertMorningRoutineSuccessRow() — this is the
    // failure mode the fix recovers from.
    const spy = vi
      .spyOn(morningRoutine, "executeMorningRoutine")
      .mockResolvedValue(undefined);
    const scheduleId = insertRetryWakeRow();
    await runner.executeScheduledTask(
      buildRetryEvent(scheduleId) as Parameters<
        typeof runner.executeScheduledTask
      >[0],
    );
    expect(spy).toHaveBeenCalledTimes(1);
    // After executeMorningRoutine returns, handleMorningRoutineRetry
    // marks the wake row completed regardless of whether
    // executeMorningRoutine itself produced an audit row (the production
    // path emits the row via AuditLogger).
    const row = db
      .prepare("SELECT status FROM agent_schedule WHERE id = ?")
      .get(scheduleId) as { status: string };
    expect(row.status).toBe("completed");
  });

  it("runs the retry when today.md is missing (standard retry case, unchanged)", async () => {
    const { runner, morningRoutine } = makeRunner({ db, dataDir });
    // No today.md, no audit row.
    const spy = vi
      .spyOn(morningRoutine, "executeMorningRoutine")
      .mockResolvedValue(undefined);
    const scheduleId = insertRetryWakeRow();
    await runner.executeScheduledTask(
      buildRetryEvent(scheduleId) as Parameters<
        typeof runner.executeScheduledTask
      >[0],
    );
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe("ScheduledTaskRunner — rotateDayFiles", () => {
  let db: Database.Database;
  let dataDir: string;
  let contextDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "pa-st-"));
    contextDir = join(dataDir, "context");
    mkdirSync(contextDir, { recursive: true });
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applySchema(db);
  });

  afterEach(() => {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("is a no-op when today.md does not exist", () => {
    const { runner } = makeRunner({ db, dataDir });
    expect(() => runner.rotateDayFiles()).not.toThrow();
  });

  it("is a no-op when today.md has no H1 date", () => {
    writeFileSync(join(contextDir, "today.md"), "no h1 date here");
    const { runner } = makeRunner({ db, dataDir });
    runner.rotateDayFiles();
    // today.md should still exist (no rotation).
    expect(existsSync(join(contextDir, "today.md"))).toBe(true);
    expect(existsSync(join(contextDir, "yesterday.md"))).toBe(false);
  });

  it("renames today.md → yesterday.md when the date is stale, and snapshots to DB", () => {
    writeFileSync(
      join(contextDir, "today.md"),
      "# 1999-01-01 — old day\nbody",
    );
    const { runner } = makeRunner({ db, dataDir });
    runner.rotateDayFiles();
    expect(existsSync(join(contextDir, "today.md"))).toBe(false);
    expect(existsSync(join(contextDir, "yesterday.md"))).toBe(true);
    expect(readFileSync(join(contextDir, "yesterday.md"), "utf-8")).toContain(
      "1999-01-01",
    );
    const snapshots = db
      .prepare("SELECT trigger, content FROM md_file_snapshots WHERE file_path = 'today'")
      .all() as Array<{ trigger: string; content: string }>;
    expect(snapshots.length).toBe(1);
    expect(snapshots[0].trigger).toBe("day_rotation");
  });

  it("does NOT rotate when today.md already carries the current agent day", () => {
    const expected = getAgentDayDateStr("UTC", 4);
    writeFileSync(
      join(contextDir, "today.md"),
      `# ${expected} — fresh\n`,
    );
    const { runner } = makeRunner({ db, dataDir });
    runner.rotateDayFiles();
    expect(existsSync(join(contextDir, "today.md"))).toBe(true);
    expect(existsSync(join(contextDir, "yesterday.md"))).toBe(false);
  });
});

describe("ScheduledTaskRunner — SKILL_CURATION_OPTIMIZER_ALLOWED_TOOLS", () => {
  it("contains exactly Read + the curl loopback glob", () => {
    expect([...SKILL_CURATION_OPTIMIZER_ALLOWED_TOOLS]).toEqual([
      "Read",
      "Bash(curl http://localhost:8321/api/skill-curation/*)",
    ]);
  });
});

describe("ScheduledTaskRunner — buildRepositoryRunPrompt", () => {
  let db: Database.Database;
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "pa-st-"));
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applySchema(db);
  });

  afterEach(() => {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("renders the repository metadata header and the user prompt", () => {
    const { runner } = makeRunner({ db, dataDir });
    const out = runner.buildRepositoryRunPrompt({
      triggerSource: "manual",
      repositoryId: "repo-1",
      slug: "my-repo",
      localPath: "/tmp/my-repo",
      githubRepo: "octocat/my-repo",
      workdirMode: "local-clone",
      prompt: "do the thing",
      instructionMd: null,
      timeoutMinutes: null,
    });
    expect(out).toContain("Repository id: repo-1");
    expect(out).toContain("Repository slug: my-repo");
    expect(out).toContain("GitHub repo: octocat/my-repo");
    expect(out).toContain("do the thing");
    expect(out).not.toContain("## Trigger");
  });

  it("appends a Trigger block when trigger metadata is present", () => {
    const { runner } = makeRunner({ db, dataDir });
    const out = runner.buildRepositoryRunPrompt({
      triggerSource: "repository_trigger",
      repositoryId: "repo-1",
      slug: "my-repo",
      localPath: null,
      githubRepo: null,
      workdirMode: "temp",
      prompt: "do",
      instructionMd: "instructions",
      timeoutMinutes: null,
      triggerId: "trig-1",
      triggerName: "Daily summary",
      triggerEventType: "github.push",
      triggerEventPayload: { ref: "refs/heads/main" },
    });
    expect(out).toContain("## Trigger");
    expect(out).toContain("Trigger id: trig-1");
    expect(out).toContain("Trigger name: Daily summary");
    expect(out).toContain("<trigger_event_payload>");
    expect(out).toContain("refs/heads/main");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// docs/design/appendices/routine-data-acquisition.md Phase 4 / D4 — pre-pass spawn inside
// executeDefault for routine events whose ProcessKey is in ROUTINE_WINDOWS
// (today_refresh, evening_review, weekly_review). monthly_review is in the
// catalog but has zero rows and short-circuits inside the runner.
// skill_curation / roadmap_refresh / user_profile_sweep are not in the
// catalog and skip without invoking the runner.
// ────────────────────────────────────────────────────────────────────────────

describe("ScheduledTaskRunner.executeDefault — Phase 4 / D4 pre-pass", () => {
  let db: Database.Database;
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "pa-st-d4-"));
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applySchema(db);
  });

  afterEach(() => {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  function makeRecordingPrepass(): {
    fetchWindowRunner: RoutineFetchWindowRunner;
    run: ReturnType<typeof vi.fn>;
  } {
    const run = vi.fn().mockResolvedValue({
      report: {
        status: "success",
        fetched: 2,
        posted: 2,
        duplicates: 0,
        errors: [],
        skipped: false,
      },
      block:
        '<fetch_report routine="evening_review" agent_day="2026-05-11" status="success" fetched="2" posted="2" duplicates="0" />',
    });
    return {
      fetchWindowRunner: { run } as unknown as RoutineFetchWindowRunner,
      run,
    };
  }

  function stubExecute(router: IAgentRouter): void {
    (router.resolveBinding as ReturnType<typeof vi.fn>).mockReturnValue({
      main: { backendId: "claude", modelId: "model", maxTurns: 1 },
    });
    (router.execute as ReturnType<typeof vi.fn>).mockResolvedValue({
      output: "",
      isError: false,
      durationMs: 10,
      numTurns: 1,
      sessionId: null,
      model: "model",
      backendId: "claude",
      costUsd: 0,
      usage: { input_tokens: 0, output_tokens: 0 },
      modelUsage: {},
      costSource: "backend",
      contextUpdated: false,
      advisorCallCount: 0,
      stopReason: null,
    });
  }

  it("invokes the pre-pass for evening_review and grafts the block onto the agent's event", async () => {
    const { fetchWindowRunner, run } = makeRecordingPrepass();
    const { runner, router } = makeRunner({ db, dataDir, fetchWindowRunner });
    stubExecute(router);
    const evt = {
      type: "routine.evening_review",
      source: "cron",
      priority: 2,
      timestamp: new Date(),
      data: {},
      correlationId: "evt-ev",
      routine: "evening_review",
    } as unknown as Parameters<typeof runner.executeDefault>[0];
    await runner.executeDefault(evt);
    expect(run).toHaveBeenCalledTimes(1);
    const execEvent = (router.execute as ReturnType<typeof vi.fn>).mock.calls[0]![0]
      .event as { data: { fetchReportBlock?: string } };
    expect(execEvent.data.fetchReportBlock).toContain('status="success"');
  });

  it("invokes the pre-pass for weekly_review (cal_iso_week_to_now window)", async () => {
    const { fetchWindowRunner, run } = makeRecordingPrepass();
    const { runner, router } = makeRunner({ db, dataDir, fetchWindowRunner });
    stubExecute(router);
    await runner.executeDefault({
      type: "routine.weekly_review",
      source: "cron",
      priority: 2,
      timestamp: new Date(),
      data: {},
      correlationId: "evt-wk",
      routine: "weekly_review",
    } as unknown as Parameters<typeof runner.executeDefault>[0]);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("does NOT invoke the pre-pass when event.data.fetchReportBlock is already set (idempotency for hourly_check D3)", async () => {
    const { fetchWindowRunner, run } = makeRecordingPrepass();
    const { runner, router } = makeRunner({ db, dataDir, fetchWindowRunner });
    stubExecute(router);
    await runner.executeDefault({
      type: "routine.hourly_check",
      source: "cron",
      priority: 2,
      timestamp: new Date(),
      data: {
        fetchReportBlock: "<fetch_report routine=\"hourly_check\" status=\"success\" />",
      },
      correlationId: "evt-hc",
      routine: "hourly_check",
    } as unknown as Parameters<typeof runner.executeDefault>[0]);
    expect(run).not.toHaveBeenCalled();
  });

  it("skips the pre-pass for non-catalog routines (skill_curation / roadmap_refresh)", async () => {
    const { fetchWindowRunner, run } = makeRecordingPrepass();
    const { runner, router } = makeRunner({ db, dataDir, fetchWindowRunner });
    stubExecute(router);
    await runner.executeDefault({
      type: "routine.roadmap_refresh",
      source: "cron",
      priority: 2,
      timestamp: new Date(),
      data: {},
      correlationId: "evt-rm",
      routine: "roadmap_refresh",
    } as unknown as Parameters<typeof runner.executeDefault>[0]);
    expect(run).not.toHaveBeenCalled();
  });

  it("skips the pre-pass for non-routine events (knowledge.import)", async () => {
    const { fetchWindowRunner, run } = makeRecordingPrepass();
    const { runner, router } = makeRunner({ db, dataDir, fetchWindowRunner });
    stubExecute(router);
    await runner.executeDefault({
      type: "knowledge.import",
      source: "dashboard",
      priority: 2,
      timestamp: new Date(),
      data: {},
      correlationId: "evt-ki",
      platform: "dashboard",
    } as unknown as Parameters<typeof runner.executeDefault>[0]);
    expect(run).not.toHaveBeenCalled();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// WIKI_BUILDER_DESIGN.md §3.5 / §14 Q4 — the bang handler acquires the
// workspace-scoped `wiki.compile` lock at enqueue time and the dispatcher
// is responsible for releasing it. A throw inside any pre-execute step
// (prepass, contextBuilder, router, prompt assembly) must still release
// the lock — otherwise a transient failure would block the workspace
// until the in-module TTL safety net expires.
// ────────────────────────────────────────────────────────────────────────────

describe("ScheduledTaskRunner.executeDefault — wiki.compile lock release", () => {
  let db: Database.Database;
  let dataDir: string;

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "pa-st-wikilock-"));
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applySchema(db);
    const { __resetWikiCompileLockForTests } = await import(
      "./wiki/compile-lock.js"
    );
    __resetWikiCompileLockForTests();
  });

  afterEach(() => {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("releases the lock when the session completes normally", async () => {
    const { runner, router } = makeRunner({ db, dataDir });
    (router.resolveBinding as ReturnType<typeof vi.fn>).mockReturnValue({
      main: { backendId: "claude", modelId: "model", maxTurns: 1 },
    });
    (router.execute as ReturnType<typeof vi.fn>).mockResolvedValue({
      output: "",
      isError: false,
      durationMs: 1,
      numTurns: 1,
      sessionId: null,
      model: "model",
      backendId: "claude",
      costUsd: 0,
      usage: { input_tokens: 0, output_tokens: 0 },
      modelUsage: {},
      costSource: "backend",
      contextUpdated: false,
      advisorCallCount: 0,
      stopReason: null,
    });
    const {
      tryAcquireWikiCompileLock,
      getWikiCompileLockHolder,
    } = await import("./wiki/compile-lock.js");
    const acquired = tryAcquireWikiCompileLock("ws-happy");
    expect(acquired.ok).toBe(true);
    await runner.executeDefault({
      type: "wiki.compile",
      source: "owner_dm",
      priority: 2,
      timestamp: new Date(),
      data: { workspace: "ws-happy" },
      correlationId: "evt-wc-happy",
    } as unknown as Parameters<typeof runner.executeDefault>[0]);
    expect(getWikiCompileLockHolder("ws-happy")).toBeNull();
  });

  it("releases the lock when contextBuilder.build throws before executeWithRetry", async () => {
    // Regression test for the lock-leak bug: the workspace capture used
    // to sit AFTER `contextBuilder.build` / `resolveBinding` / prompt
    // assembly, so a throw from any of those would skip the `finally`
    // and keep the lock held until the in-module TTL fired.
    const { runner, router, contextBuilder } = makeRunner({ db, dataDir });
    (router.resolveBinding as ReturnType<typeof vi.fn>).mockReturnValue({
      main: { backendId: "claude", modelId: "model", maxTurns: 1 },
    });
    (contextBuilder.build as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("context build failed"),
    );
    const {
      tryAcquireWikiCompileLock,
      getWikiCompileLockHolder,
    } = await import("./wiki/compile-lock.js");
    const acquired = tryAcquireWikiCompileLock("ws-throw");
    expect(acquired.ok).toBe(true);
    await expect(
      runner.executeDefault({
        type: "wiki.compile",
        source: "owner_dm",
        priority: 2,
        timestamp: new Date(),
        data: { workspace: "ws-throw" },
        correlationId: "evt-wc-throw",
      } as unknown as Parameters<typeof runner.executeDefault>[0]),
    ).rejects.toThrow(/context build failed/);
    expect(getWikiCompileLockHolder("ws-throw")).toBeNull();
  });

  it("does NOT touch the lock for non-wiki.compile events", async () => {
    // Defense check: an unrelated throw on a non-wiki event must not
    // accidentally release a wiki.compile lock that some other workspace
    // is currently holding.
    const { runner, contextBuilder } = makeRunner({ db, dataDir });
    (contextBuilder.build as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("unrelated failure"),
    );
    const {
      tryAcquireWikiCompileLock,
      getWikiCompileLockHolder,
    } = await import("./wiki/compile-lock.js");
    tryAcquireWikiCompileLock("ws-other");
    await expect(
      runner.executeDefault({
        type: "routine.evening_review",
        source: "cron",
        priority: 2,
        timestamp: new Date(),
        data: {},
        correlationId: "evt-er",
        routine: "evening_review",
      } as unknown as Parameters<typeof runner.executeDefault>[0]),
    ).rejects.toThrow(/unrelated failure/);
    expect(getWikiCompileLockHolder("ws-other")).not.toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Daily git management — `git.project.refresh_architecture` runs an agent
// that walks the user's local repository to compose the Architecture section
// of `git/<slug>/overview.md`. The clamp keeps the session read-only:
// Write/Edit/`Bash(git *)` are absent, so the only write path is the
// daemon-API chokepoint at `PUT /api/repositories/:id/architecture-section`.
// ────────────────────────────────────────────────────────────────────────────

describe("ScheduledTaskRunner — REFRESH_ARCHITECTURE_ALLOWED_TOOLS", () => {
  it("envelope is the read-only set with endpoint-pinned curl + jq", () => {
    expect([...REFRESH_ARCHITECTURE_ALLOWED_TOOLS]).toEqual([
      "Read",
      "Glob",
      "Grep",
      "Bash(curl http://localhost:8321/api/repositories/*/architecture-section*)",
      "Bash(jq *)",
    ]);
  });

  it("does NOT include any write or repo-mutating surface", () => {
    for (const tool of REFRESH_ARCHITECTURE_ALLOWED_TOOLS) {
      expect(tool).not.toBe("Write");
      expect(tool).not.toBe("Edit");
      expect(tool).not.toBe("Skill");
      expect(tool).not.toBe("WebSearch");
      // No git CLI: even read-only verbs would permit shell-chained writes
      // (`git log; git push --force`) that the absolute-block classifier
      // does not categorise.
      expect(tool).not.toMatch(/^Bash\(git\b/);
      // No generic shell escapes.
      expect(tool).not.toMatch(/^Bash\(rm\b/);
      expect(tool).not.toMatch(/^Bash\(ls\b/);
      expect(tool).not.toMatch(/^Bash\(sh\b/);
      expect(tool).not.toMatch(/^Bash\(bash\b/);
    }
  });

  it("pins curl to the architecture-section endpoint (no broad curl glob)", () => {
    // Defense-in-depth: `Bash(curl *)` would let the agent reach every
    // Autonomous daemon-API surface on localhost (`/api/notify`,
    // `/api/observations`, `/api/obsidian/notes`, `/api/calendar/events`,
    // etc.). The SDK glob layer must reject those URLs outright, so the
    // curl entry MUST be a strict prefix match on the architecture-section
    // endpoint.
    const curlEntries = REFRESH_ARCHITECTURE_ALLOWED_TOOLS.filter((t) =>
      t.startsWith("Bash(curl"),
    );
    expect(curlEntries).toHaveLength(1);
    const curl = curlEntries[0]!;
    expect(curl).not.toBe("Bash(curl *)");
    expect(curl).toContain("architecture-section");
    expect(curl).toContain("/api/repositories/");
    // Other Autonomous daemon-API namespaces must not be reachable via the
    // SDK glob layer. The curl PreToolUse hook is a secondary defense, but
    // the first gate is this prefix.
    for (const forbidden of [
      "/api/notify",
      "/api/observations",
      "/api/obsidian",
      "/api/calendar/events",
      "/api/notion/pages",
      "/api/context/",
    ]) {
      expect(curl).not.toContain(forbidden);
    }
  });
});

describe("ScheduledTaskRunner.executeScheduledTask — refresh_architecture clamp", () => {
  let db: Database.Database;
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "pa-st-arch-"));
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applySchema(db);
  });

  afterEach(() => {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  function stubRouter(router: IAgentRouter): void {
    (router.resolveBinding as ReturnType<typeof vi.fn>).mockReturnValue({
      main: { backendId: "claude", modelId: "model", maxTurns: 1 },
    });
    (router.execute as ReturnType<typeof vi.fn>).mockResolvedValue({
      output: "",
      isError: false,
      durationMs: 10,
      numTurns: 1,
      sessionId: null,
      model: "model",
      backendId: "claude",
      costUsd: 0,
      usage: { input_tokens: 0, output_tokens: 0 },
      modelUsage: {},
      costSource: "backend",
      contextUpdated: false,
      advisorCallCount: 0,
      stopReason: null,
    });
  }

  it("pins allowedToolsOverride for processKey 'git.project.refresh_architecture'", async () => {
    const { runner, router } = makeRunner({ db, dataDir });
    stubRouter(router);
    await runner.executeScheduledTask({
      type: "scheduled.task",
      source: "git.project.refresh_architecture",
      priority: 2,
      timestamp: new Date(),
      data: {},
      correlationId: "corr-refresh",
      task: "Refresh architecture for my-repo",
      taskContext: {
        processKey: "git.project.refresh_architecture",
        repositoryId: "repo-1",
        slug: "my-repo",
        localPath: "/tmp/my-repo",
        githubRepo: null,
        classification: "project",
        category: "personal",
        correlationId: "corr-refresh",
      },
    } as unknown as Parameters<typeof runner.executeScheduledTask>[0]);
    const call = (router.execute as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
      allowedToolsOverride?: readonly string[];
      processKey?: string;
    };
    expect(call.processKey).toBe("git.project.refresh_architecture");
    expect(call.allowedToolsOverride).toEqual([...REFRESH_ARCHITECTURE_ALLOWED_TOOLS]);
  });

  it("does NOT pin allowedToolsOverride for unrelated scheduled tasks", async () => {
    const { runner, router } = makeRunner({ db, dataDir });
    stubRouter(router);
    await runner.executeScheduledTask({
      type: "scheduled.task",
      source: "wake",
      priority: 2,
      timestamp: new Date(),
      data: {},
      correlationId: "corr-other",
      task: "Wake task",
      taskContext: { processKey: "agent.task" },
    } as unknown as Parameters<typeof runner.executeScheduledTask>[0]);
    const call = (router.execute as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
      allowedToolsOverride?: readonly string[];
    };
    expect(call.allowedToolsOverride).toBeUndefined();
  });

  it("never widens the envelope with Write/Edit/Bash(git*) at the call site", async () => {
    const { runner, router } = makeRunner({ db, dataDir });
    stubRouter(router);
    await runner.executeScheduledTask({
      type: "scheduled.task",
      source: "git.project.refresh_architecture",
      priority: 2,
      timestamp: new Date(),
      data: {},
      correlationId: "corr-defense",
      task: "Refresh architecture",
      taskContext: {
        processKey: "git.project.refresh_architecture",
        repositoryId: "repo-2",
        slug: "another",
        localPath: "/tmp/another",
        githubRepo: null,
        classification: "project",
        category: "personal",
        correlationId: "corr-defense",
      },
    } as unknown as Parameters<typeof runner.executeScheduledTask>[0]);
    const call = (router.execute as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
      allowedToolsOverride?: readonly string[];
    };
    expect(call.allowedToolsOverride).toBeDefined();
    for (const tool of call.allowedToolsOverride ?? []) {
      expect(tool).not.toBe("Write");
      expect(tool).not.toBe("Edit");
      expect(tool).not.toMatch(/^Bash\(git\b/);
    }
  });

  it("refuses-at-execute when refresh_architecture is rebound to a non-Claude backend (clamp would silently drop)", async () => {
    // Regression: previously the clamp was passed through to a Codex or
    // Gemini binding even though those cores have no per-execute
    // `allowedTools` surface. The agent would then run with the default
    // tool envelope (Write, Edit, `Bash(git *)`) on the user's local
    // worktree. Now the dispatcher refuses at the boundary and writes
    // an `agent_actions` row so the operator can see the misconfig.
    const { runner, router } = makeRunner({ db, dataDir });
    // Same stub shape, but with main backend swapped to Codex — this
    // mirrors what `/settings/models` produces if the operator rebinds
    // `git.project.refresh_architecture`.
    (router.resolveBinding as ReturnType<typeof vi.fn>).mockReturnValue({
      main: { backendId: "codex", modelId: "gpt-5-codex", maxTurns: 1 },
    });
    (router.execute as ReturnType<typeof vi.fn>).mockResolvedValue({
      output: "",
      isError: false,
      durationMs: 10,
      numTurns: 1,
      sessionId: null,
      model: "gpt-5-codex",
      backendId: "codex",
      costUsd: 0,
      usage: { input_tokens: 0, output_tokens: 0 },
      modelUsage: {},
      costSource: "backend",
      contextUpdated: false,
      advisorCallCount: 0,
      stopReason: null,
    });
    await runner.executeScheduledTask({
      type: "scheduled.task",
      source: "git.project.refresh_architecture",
      priority: 2,
      timestamp: new Date(),
      data: {},
      correlationId: "corr-refuse",
      task: "Refresh architecture",
      taskContext: {
        processKey: "git.project.refresh_architecture",
        repositoryId: "repo-refuse",
        slug: "refuse",
        localPath: "/tmp/refuse",
        githubRepo: null,
        classification: "project",
        category: "personal",
        correlationId: "corr-refuse",
      },
    } as unknown as Parameters<typeof runner.executeScheduledTask>[0]);
    // The router.execute must NEVER be called — refusal is at dispatch
    // time, before the SDK or any tool is touched.
    expect((router.execute as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    // The refusal is recorded as an `agent_actions` row whose
    // `action_type` is exactly `scheduled_task_clamp_unsupported` and
    // whose JSON detail carries the rebound backend so the operator can
    // find the offending `/settings/models` row.
    const auditRows = db
      .prepare<[], { action_type: string; result: string; detail: string }>(
        `SELECT action_type, result, detail FROM agent_actions
          WHERE action_type = 'scheduled_task_clamp_unsupported'`,
      )
      .all();
    expect(auditRows).toHaveLength(1);
    // The result is "failed" because agent_actions.result has a CHECK
    // constraint limiting it to canonical settle states; the
    // `scheduled_task_clamp_unsupported` action_type is the
    // discriminator that distinguishes this from a true agent failure.
    expect(auditRows[0]!.result).toBe("failed");
    const detail = JSON.parse(auditRows[0]!.detail) as {
      process_key: string;
      backend: string;
      clamp: string;
      supported_backends: string[];
    };
    expect(detail.process_key).toBe("git.project.refresh_architecture");
    expect(detail.backend).toBe("codex");
    expect(detail.clamp).toBe("REFRESH_ARCHITECTURE_ALLOWED_TOOLS");
    expect(detail.supported_backends).toContain("claude");
  });
});

describe("ScheduledTaskRunner.executeScheduledTask — requestedTier resolution", () => {
  let db: Database.Database;
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "pa-st-tier-"));
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applySchema(db);
  });

  afterEach(() => {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  function stub(router: IAgentRouter): void {
    (router.resolveBinding as ReturnType<typeof vi.fn>).mockReturnValue({
      main: { backendId: "claude", modelId: "model", maxTurns: 1 },
    });
    (router.execute as ReturnType<typeof vi.fn>).mockResolvedValue({
      output: "",
      isError: false,
      durationMs: 10,
      numTurns: 1,
      sessionId: null,
      model: "model",
      backendId: "claude",
      costUsd: 0,
      usage: { input_tokens: 0, output_tokens: 0 },
      modelUsage: {},
      costSource: "backend",
      contextUpdated: false,
      advisorCallCount: 0,
      stopReason: null,
    });
  }

  type ExecArg = Parameters<ScheduledTaskRunner["executeScheduledTask"]>[0];

  function baseEvent(overrides: Partial<ExecArg> = {}): ExecArg {
    return {
      type: "scheduled.task",
      source: "wake",
      priority: 2,
      timestamp: new Date(),
      data: {},
      correlationId: "corr-tier",
      task: "Sample task body",
      taskContext: {},
      ...overrides,
    } as ExecArg;
  }

  it("passes event.requestedTier through to resolveBinding when set", async () => {
    const { runner, router } = makeRunner({ db, dataDir });
    stub(router);
    await runner.executeScheduledTask(baseEvent({
      requestedTier: "lite",
    } as Partial<ExecArg>));
    const bindCall = (router.resolveBinding as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(bindCall[1]).toMatchObject({ requestedTier: "lite" });
  });

  it("event.requestedTier wins over event.requestedModel when both are set", async () => {
    // Primary contract: tier_override is the new abstract knob;
    // model stays as a Claude escape hatch. When both arrive on the
    // event (e.g. a row that carried both columns), tier must win
    // so the dispatcher cannot silently drag a row meant for Haiku
    // up to Opus via the legacy model→tier coercion.
    const { runner, router } = makeRunner({ db, dataDir });
    stub(router);
    await runner.executeScheduledTask(baseEvent({
      requestedTier: "lite",
      requestedModel: "opus",
    } as Partial<ExecArg>));
    const bindCall = (router.resolveBinding as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(bindCall[1]).toMatchObject({ requestedTier: "lite" });
  });

  it("falls back to model-derived tier when only requestedModel is set", async () => {
    const { runner, router } = makeRunner({ db, dataDir });
    stub(router);
    await runner.executeScheduledTask(baseEvent({
      requestedModel: "opus",
    } as Partial<ExecArg>));
    const bindCall = (router.resolveBinding as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(bindCall[1]).toMatchObject({ requestedTier: "high" });
  });

  it("omits requestedTier entirely when neither knob is set (process-key default = medium applies)", async () => {
    const { runner, router } = makeRunner({ db, dataDir });
    stub(router);
    await runner.executeScheduledTask(baseEvent());
    const bindCall = (router.resolveBinding as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const opts = bindCall[1] as { requestedTier?: string };
    expect(opts.requestedTier).toBeUndefined();
  });

  it("forwards requestedTier through the today_refresh fast-path (AgentTaskEvent → RoutineEvent)", async () => {
    // The today_refresh branch in executeScheduledTask synthesizes a
    // RoutineEvent and hands it to executeDefault. The dispatcher's
    // routineHint computation must read requestedTier off the
    // synthesized RoutineEvent so the lite/high choice survives the
    // conversion. Without the copy step, today_refresh tasks would
    // silently drop the tier on the floor.
    const { runner, router } = makeRunner({ db, dataDir });
    stub(router);
    await runner.executeScheduledTask(baseEvent({
      requestedTier: "lite",
      taskContext: { routine: "today_refresh" },
    } as Partial<ExecArg>));
    // executeDefault calls resolveBinding once with the routineHint
    // derived from the synthesized RoutineEvent.
    const bindCall = (router.resolveBinding as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(bindCall[1]).toMatchObject({ requestedTier: "lite" });
  });
});

// ────────────────────────────────────────────────────────────────────────────
// WEEKLY_INTERESTS_REFLECTION_PLAN.md §10.4 — pre-hook for
// `routine.weekly_review`. Verifies: (a) happy path refreshes the
// profile.md auto-block before the LLM session runs; (b) disabled
// integration short-circuits; (c) skip path writes a journal line;
// (d) helper throw is caught — weekly_review still proceeds.
// ────────────────────────────────────────────────────────────────────────────

describe("ScheduledTaskRunner.executeDefault — weekly interests reflection pre-hook", () => {
  let db: Database.Database;
  let dataDir: string;
  let contextDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "pa-st-wir-"));
    contextDir = join(dataDir, "context");
    mkdirSync(contextDir, { recursive: true });
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applySchema(db);
  });

  afterEach(() => {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  function stubExecute(router: IAgentRouter): void {
    (router.resolveBinding as ReturnType<typeof vi.fn>).mockReturnValue({
      main: { backendId: "claude", modelId: "model", maxTurns: 1 },
    });
    (router.execute as ReturnType<typeof vi.fn>).mockResolvedValue({
      output: "",
      isError: false,
      durationMs: 10,
      numTurns: 1,
      sessionId: null,
      model: "model",
      backendId: "claude",
      costUsd: 0,
      usage: { input_tokens: 0, output_tokens: 0 },
      modelUsage: {},
      costSource: "backend",
      contextUpdated: false,
      advisorCallCount: 0,
      stopReason: null,
    });
  }

  function enableBrowserHistory(): void {
    writeIntegrations(db, {
      browser_history: {
        mode: "direct",
        deniedTools: [],
        lastChangedAt: new Date().toISOString(),
      },
    });
  }

  function seedQualifyingClusters(count = 3): void {
    for (let i = 0; i < count; i++) {
      const slug = `theme-${i}`;
      const lastActivity = Date.now() - 2 * 24 * 60 * 60 * 1000;
      db.prepare(
        `INSERT INTO browser_research_clusters (
           slug, root_task_id, display_name, started_at, last_activity_at,
           visits_total, meaningful_visits_total, meaningful_foreground_sec_total,
           distinct_meaningful_domains, status,
           research_offer_accepted_at, wiki_summary_written_at,
           agent_summary_revision
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      ).run(
        slug,
        i + 1,
        `Theme ${i}`,
        lastActivity - 86_400_000,
        lastActivity,
        30,
        22,
        5400 - i * 100,
        4,
        "active",
        null,
        null,
      );
      db.prepare(
        `INSERT INTO browser_visits (
           ts, browser, profile, url_hash, domain, category, meaningful,
           foreground_sec, transition, is_reload, root_task_id
         ) VALUES (?, 'chrome', 'Default', ?, ?, 'research', 1, ?, 0, 0, ?)`,
      ).run(lastActivity, `hash-${i}`, `d${i}.example.com`, 600, i + 1);
    }
  }

  function makeWeeklyReviewEvent(): Parameters<ScheduledTaskRunner["executeDefault"]>[0] {
    return {
      type: "routine.weekly_review",
      source: "cron",
      priority: 2,
      timestamp: new Date(),
      data: {},
      correlationId: "evt-wir",
      routine: "weekly_review",
    } as unknown as Parameters<ScheduledTaskRunner["executeDefault"]>[0];
  }

  it("refreshes profile.md before the LLM session when browser_history is enabled", async () => {
    enableBrowserHistory();
    seedQualifyingClusters(3);
    mkdirSync(join(contextDir, "user"), { recursive: true });
    writeFileSync(
      join(contextDir, "user", "profile.md"),
      [
        "---",
        "type: user",
        "owner: user",
        "---",
        "# Profile",
        "",
        "## Identity",
        "User identity.",
      ].join("\n"),
    );
    const { runner, router } = makeRunner({ db, dataDir });
    stubExecute(router);

    await runner.executeDefault(makeWeeklyReviewEvent());

    const profile = readFileSync(
      join(contextDir, "user", "profile.md"),
      "utf-8",
    );
    expect(profile).toContain("<!-- BEGIN aitne:browser-interests v1");
    expect(profile).toContain("## Current research themes (auto)");
    // User-authored content is untouched.
    expect(profile).toContain("## Identity");

    // Audit row emitted by the helper — joined to the originating
    // weekly_review event via the threaded correlationId.
    const audit = db
      .prepare(
        `SELECT event_id, result, trigger FROM agent_actions
         WHERE action_type = 'browser_interests_reflection_applied'`,
      )
      .get() as { event_id: string | null; result: string; trigger: string } | undefined;
    expect(audit?.result).toBe("success");
    expect(audit?.trigger).toBe("weekly_interests_reflection:scheduler");
    expect(audit?.event_id).toBe("evt-wir");

    // The LLM session still ran (executeDefault did not short-circuit).
    expect(router.execute).toHaveBeenCalledTimes(1);
  });

  it("short-circuits with skipped='no_browser_history' when browser_history is disabled", async () => {
    // Default integration mode is "disabled" — do NOT enable it.
    seedQualifyingClusters(3);
    mkdirSync(join(contextDir, "user"), { recursive: true });
    writeFileSync(join(contextDir, "user", "profile.md"), "# Profile\n");
    const { runner, router } = makeRunner({ db, dataDir });
    stubExecute(router);

    await runner.executeDefault(makeWeeklyReviewEvent());

    // rev 4 — the disabled gate is enforced INSIDE the helper, so the
    // audit row now lands uniformly with `skipped.reason='no_browser_history'`.
    // The previous contract (no audit row at all) was inconsistent with
    // the < min-themes path and made the dashboard's reason-display
    // arm need a dead branch for "we didn't hear from the helper".
    const row = db
      .prepare(
        `SELECT result, detail FROM agent_actions
         WHERE action_type = 'browser_interests_reflection_applied'`,
      )
      .get() as { result: string; detail: string };
    expect(row.result).toBe("skipped");
    const detail = JSON.parse(row.detail);
    expect(detail.skipped.reason).toBe("no_browser_history");
    // profile.md untouched.
    expect(readFileSync(join(contextDir, "user", "profile.md"), "utf-8")).toBe(
      "# Profile\n",
    );
    // Journal records the skip reason — the dispatcher logs the
    // human-readable form regardless of helper-emitted audit row.
    const journal = readFileSync(
      join(contextDir, "agent", "journal.md"),
      "utf-8",
    );
    expect(journal).toContain("## Weekly interests reflection");
    expect(journal).toContain("no_browser_history");
    // LLM session still ran.
    expect(router.execute).toHaveBeenCalledTimes(1);
  });

  it("writes a journal line when the helper returns { skipped: fewer_than_min_themes }", async () => {
    enableBrowserHistory();
    // Only 2 qualifying clusters — below the MIN_PROFILE_MD_THEMES floor.
    seedQualifyingClusters(2);
    const { runner, router } = makeRunner({ db, dataDir });
    stubExecute(router);

    await runner.executeDefault(makeWeeklyReviewEvent());

    const audit = db
      .prepare(
        `SELECT result FROM agent_actions
         WHERE action_type = 'browser_interests_reflection_applied'`,
      )
      .get() as { result: string } | undefined;
    expect(audit?.result).toBe("skipped");

    const journal = readFileSync(
      join(contextDir, "agent", "journal.md"),
      "utf-8",
    );
    expect(journal).toContain("interest reflection skipped: fewer_than_min_themes");
    expect(router.execute).toHaveBeenCalledTimes(1);
  });

  it("does not skip the weekly_review when the helper throws", async () => {
    enableBrowserHistory();
    seedQualifyingClusters(3);
    // Drop the table the helper reads — any prepare() call against
    // it will raise SqliteError. The pre-hook's try/catch must
    // swallow it and let the LLM session run.
    db.prepare("DROP TABLE browser_research_clusters").run();

    const { runner, router } = makeRunner({ db, dataDir });
    stubExecute(router);

    await expect(runner.executeDefault(makeWeeklyReviewEvent())).resolves.toBeUndefined();

    expect(router.execute).toHaveBeenCalledTimes(1);

    const journal = readFileSync(
      join(contextDir, "agent", "journal.md"),
      "utf-8",
    );
    expect(journal).toContain("interest reflection failed:");
  });

  it("does not run the pre-hook for non-weekly_review routines", async () => {
    enableBrowserHistory();
    seedQualifyingClusters(3);
    const { runner, router } = makeRunner({ db, dataDir });
    stubExecute(router);

    await runner.executeDefault({
      type: "routine.evening_review",
      source: "cron",
      priority: 2,
      timestamp: new Date(),
      data: {},
      correlationId: "evt-ev",
      routine: "evening_review",
    } as unknown as Parameters<ScheduledTaskRunner["executeDefault"]>[0]);

    const applied = db
      .prepare(
        `SELECT COUNT(*) AS n FROM agent_actions
         WHERE action_type = 'browser_interests_reflection_applied'`,
      )
      .get() as { n: number };
    expect(applied.n).toBe(0);
    expect(existsSync(join(contextDir, "agent", "journal.md"))).toBe(false);
  });
});

describe("appendToWeeklyInterestsJournalSection", () => {
  it("creates a new journal file with the section header when original is null", () => {
    const out = appendToWeeklyInterestsJournalSection(
      null,
      "- 2026-05-21 09:00: interest reflection skipped: fewer_than_min_themes",
    );
    expect(out).toContain("# Agent journal");
    expect(out).toContain("## Weekly interests reflection");
    expect(out).toContain(
      "- 2026-05-21 09:00: interest reflection skipped: fewer_than_min_themes",
    );
    expect(out.endsWith("\n")).toBe(true);
  });

  it("appends under an existing section, preserving prior bullets", () => {
    const original = [
      "# Agent journal",
      "",
      "## Weekly interests reflection",
      "",
      "- 2026-05-14 09:00: interest reflection skipped: no_browser_history",
      "",
    ].join("\n");
    const out = appendToWeeklyInterestsJournalSection(
      original,
      "- 2026-05-21 09:00: refresh applied",
    );
    expect(out).toContain(
      "- 2026-05-14 09:00: interest reflection skipped: no_browser_history",
    );
    expect(out).toContain("- 2026-05-21 09:00: refresh applied");
    // Section header appears exactly once.
    expect(out.match(/## Weekly interests reflection/g)?.length).toBe(1);
  });

  it("adds the section to an existing journal that has unrelated sections", () => {
    const original = [
      "# Agent journal",
      "",
      "## Roadmap maintenance",
      "- 2026-05-14 09:00: status_synced=2, swept=1",
      "",
    ].join("\n");
    const out = appendToWeeklyInterestsJournalSection(
      original,
      "- 2026-05-21 09:00: refresh applied",
    );
    expect(out).toContain("## Roadmap maintenance");
    expect(out).toContain("## Weekly interests reflection");
    expect(out.indexOf("## Roadmap maintenance")).toBeLessThan(
      out.indexOf("## Weekly interests reflection"),
    );
  });

  it("does not duplicate the section when called twice in sequence", () => {
    const first = appendToWeeklyInterestsJournalSection(
      null,
      "- 2026-05-21 09:00: first",
    );
    const second = appendToWeeklyInterestsJournalSection(
      first,
      "- 2026-05-21 10:00: second",
    );
    expect(second.match(/## Weekly interests reflection/g)?.length).toBe(1);
    expect(second).toContain("- 2026-05-21 09:00: first");
    expect(second).toContain("- 2026-05-21 10:00: second");
  });

  // ──────────────────────────────────────────────────────────────────
  // rev 4 — monthly rotation. Bullets older than 30 days drop off on
  // append so the section stays at ~4-5 entries.
  // ──────────────────────────────────────────────────────────────────

  it("prunes bullets older than 30 days on append", () => {
    // nowMs = 2026-05-21 12:00 UTC. Cutoff = 30 days prior =
    // 2026-04-21 12:00 UTC. Anything dated 2026-04-21 or later is
    // kept; older drops.
    const nowMs = Date.UTC(2026, 4, 21, 12, 0, 0);
    const original = [
      "# Agent journal",
      "",
      "## Weekly interests reflection",
      "",
      "- 2026-03-15 09:00: way too old",
      "- 2026-04-20 09:00: barely too old",
      "- 2026-04-22 09:00: still fresh",
      "- 2026-05-14 09:00: fresh",
      "",
    ].join("\n");
    const next = appendToWeeklyInterestsJournalSection(
      original,
      "- 2026-05-21 12:00: just now",
      nowMs,
    );
    expect(next).not.toContain("2026-03-15");
    expect(next).not.toContain("2026-04-20");
    expect(next).toContain("2026-04-22 09:00: still fresh");
    expect(next).toContain("2026-05-14 09:00: fresh");
    expect(next).toContain("2026-05-21 12:00: just now");
  });

  it("preserves user-authored prose (non-bullet lines) inside the section regardless of date", () => {
    // The rotation only targets daemon-emitted bullets (recognised by
    // the `- YYYY-MM-DD HH:MM` prefix). Manual prose stays.
    const nowMs = Date.UTC(2026, 4, 21, 12);
    const original = [
      "# Agent journal",
      "",
      "## Weekly interests reflection",
      "",
      "Operator note: see incident #42.",
      "- 2026-01-01 09:00: ancient bullet",
      "",
    ].join("\n");
    const next = appendToWeeklyInterestsJournalSection(
      original,
      "- 2026-05-21 12:00: fresh",
      nowMs,
    );
    expect(next).toContain("Operator note: see incident #42.");
    expect(next).not.toContain("2026-01-01");
    expect(next).toContain("2026-05-21 12:00: fresh");
  });

  it("keeps a bullet dated exactly 30 days ago (cutoff is inclusive on the kept side)", () => {
    const nowMs = Date.UTC(2026, 4, 21, 12);
    // Exactly 30 days before nowMs is 2026-04-21 12:00 UTC. The bullet
    // for that date is anchored at noon UTC by the parser, so the
    // condition `dateMs >= cutoffMs` keeps it.
    const original = [
      "# Agent journal",
      "",
      "## Weekly interests reflection",
      "",
      "- 2026-04-21 09:00: exactly on the boundary",
      "",
    ].join("\n");
    const next = appendToWeeklyInterestsJournalSection(
      original,
      "- 2026-05-21 12:00: today",
      nowMs,
    );
    expect(next).toContain("2026-04-21 09:00: exactly on the boundary");
  });

  it("is a no-op when the section is empty (no bullets to prune)", () => {
    const nowMs = Date.UTC(2026, 4, 21, 12);
    const original = [
      "# Agent journal",
      "",
      "## Weekly interests reflection",
      "",
    ].join("\n");
    const next = appendToWeeklyInterestsJournalSection(
      original,
      "- 2026-05-21 12:00: first",
      nowMs,
    );
    expect(next).toContain("2026-05-21 12:00: first");
    expect(next.match(/## Weekly interests reflection/g)?.length).toBe(1);
  });

  it("pruneWeeklyInterestsJournalBullets is pure of its input slice", () => {
    const nowMs = Date.UTC(2026, 4, 21, 12);
    const lines = [
      "intro",
      "## Section",
      "",
      "- 2026-01-01 09:00: ancient",
      "- 2026-05-01 09:00: recent",
      "",
      "trailing",
    ];
    const out = pruneWeeklyInterestsJournalBullets(lines, 3, 6, nowMs, 30);
    // Lines before bodyStart and on/after bodyEnd are passed through.
    expect(out[0]).toBe("intro");
    expect(out[1]).toBe("## Section");
    expect(out[2]).toBe("");
    expect(out).toContain("trailing");
    // Ancient bullet dropped, recent kept.
    expect(out.some((l) => l.includes("ancient"))).toBe(false);
    expect(out.some((l) => l.includes("recent"))).toBe(true);
  });
});

