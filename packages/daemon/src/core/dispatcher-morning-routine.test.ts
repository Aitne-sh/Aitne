import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEvent, EventPriority } from "@aitne/shared";
import type { AgentResult, Event, RoutineEvent } from "@aitne/shared";
import { applySchema } from "../db/schema.js";
import {
  MorningRoutineRunner,
  type TodayMdDiagnosis,
} from "./dispatcher-morning-routine.js";
import { EventBus } from "./event-bus.js";
import type { RoutineFetchWindowRunner } from "./routine-fetch-window-runner.js";
import type {
  MorningPipelineRunResult,
  MorningRoutinePipelineOrchestrator,
} from "./morning/orchestrator.js";
import type { ParentAuditEmitResult } from "./morning/parent-audit-emitter.js";
import type { AgentConfig } from "../config.js";
import type { INotificationManager } from "./dispatcher-types.js";

// ─────────────────────────── helpers ────────────────────────────

function fakeConfig(
  dataDir: string,
  overrides: Partial<AgentConfig> = {},
): AgentConfig {
  return {
    dataDir,
    workspaceDir: join(dataDir, "workdirs"),
    apiPort: 0,
    timezone: "UTC",
    dayBoundaryHour: 4,
    ...overrides,
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
      block: `<fetch_report routine="morning_routine" agent_day="2026-05-11" status="skipped" fetched="0" posted="0" duplicates="0" />`,
    }),
  } as unknown as RoutineFetchWindowRunner;
}

function makeAgentResult(overrides: Partial<AgentResult> = {}): AgentResult {
  return {
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
    ...overrides,
  } as AgentResult;
}

function makeStubOrchestrator(args: {
  runResult?: MorningPipelineRunResult;
  runThrows?: Error;
  emitOutcome?: ParentAuditEmitResult;
  appendOutcome?: ReturnType<MorningRoutinePipelineOrchestrator["appendAgentJournalEntry"]>;
} = {}): {
  orchestrator: MorningRoutinePipelineOrchestrator;
  runMock: ReturnType<typeof vi.fn>;
  emitMock: ReturnType<typeof vi.fn>;
  appendMock: ReturnType<typeof vi.fn>;
} {
  const stageAResult =
    args.runResult?.stageAResult ?? makeAgentResult({ output: "stage-a" });
  const stageBResult =
    args.runResult?.stageBResult ?? makeAgentResult({ output: "stage-b" });
  const startedAt = args.runResult?.startedAt ?? new Date();
  const runMock = vi.fn(async () => {
    if (args.runThrows) throw args.runThrows;
    return {
      stageAResult,
      stageBResult,
      startedAt,
    } as MorningPipelineRunResult;
  });
  const emitMock = vi.fn(
    () =>
      args.emitOutcome ??
      ({ emitted: true, insertedId: 99 } as ParentAuditEmitResult),
  );
  const appendMock = vi.fn(() =>
    args.appendOutcome ??
      ({ ok: true, entryText: "stub-entry" } as unknown as ReturnType<
        MorningRoutinePipelineOrchestrator["appendAgentJournalEntry"]
      >),
  );
  const orchestrator = {
    run: runMock,
    emitParentAuditRow: emitMock,
    appendAgentJournalEntry: appendMock,
  } as unknown as MorningRoutinePipelineOrchestrator;
  return { orchestrator, runMock, emitMock, appendMock };
}

function makeRunner(opts: {
  db: Database.Database;
  dataDir: string;
  diagnoseTodayMdState?: () => TodayMdDiagnosis;
  notificationMgr?: INotificationManager;
  isRoadmapStale?: () => boolean;
  fetchWindowRunner?: RoutineFetchWindowRunner;
  configOverrides?: Partial<AgentConfig>;
  pipelineOrchestrator?: MorningRoutinePipelineOrchestrator;
}): {
  runner: MorningRoutineRunner;
  notificationMgr: INotificationManager;
  emitRoadmapRefresh: ReturnType<typeof vi.fn>;
  triggerActivityScan: ReturnType<typeof vi.fn>;
  rotateDayFiles: ReturnType<typeof vi.fn>;
  setMorningRoutineInProgress: ReturnType<typeof vi.fn>;
  fetchWindowRunner: RoutineFetchWindowRunner;
  pipelineOrchestrator: MorningRoutinePipelineOrchestrator;
} {
  const config = fakeConfig(opts.dataDir, opts.configOverrides);
  const eventBus = new EventBus();
  const notificationMgr =
    opts.notificationMgr ??
    ({
      send: vi.fn().mockResolvedValue(undefined),
      beginReplyActivity: vi.fn(),
    } as unknown as INotificationManager);
  const emitRoadmapRefresh = vi.fn();
  const triggerActivityScan = vi.fn().mockResolvedValue(undefined);
  const rotateDayFiles = vi.fn();
  const setMorningRoutineInProgress = vi.fn();
  const fetchWindowRunner = opts.fetchWindowRunner ?? makeStubFetchWindowRunner();
  // Every executeMorningRoutine path now goes through the orchestrator.
  // Tests that don't override the orchestrator get a no-op stub so the
  // runner can resolve `.run()` / `.emitParentAuditRow()` /
  // `.appendAgentJournalEntry()` without throwing.
  const pipelineOrchestrator =
    opts.pipelineOrchestrator ?? makeStubOrchestrator({}).orchestrator;
  const runner = new MorningRoutineRunner({
    db: opts.db,
    config,
    eventBus,
    notificationMgr,
    todayWriteLock: undefined,
    fetchWindowRunner,
    setMorningRoutineInProgress,
    rotateDayFiles,
    diagnoseTodayMdState: opts.diagnoseTodayMdState ?? (() => ({ kind: "fresh" })),
    isRoadmapStale: opts.isRoadmapStale ?? (() => false),
    emitRoadmapRefresh,
    triggerActivityScan,
    pipelineOrchestrator,
  });
  return {
    runner,
    notificationMgr,
    emitRoadmapRefresh,
    triggerActivityScan,
    rotateDayFiles,
    setMorningRoutineInProgress,
    fetchWindowRunner,
    pipelineOrchestrator,
  };
}

function makeMorningEvent(over: Partial<RoutineEvent> = {}): RoutineEvent {
  return {
    ...createEvent({
      type: "routine.morning_routine",
      source: "cron",
      priority: EventPriority.HIGH,
    }),
    routine: "morning_routine",
    data: {},
    ...over,
  } as RoutineEvent;
}

// ─────────────────────────── tests ──────────────────────────────

describe("MorningRoutineRunner — scheduleMorningRetry", () => {
  let db: Database.Database;
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "pa-mr-"));
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applySchema(db);
  });

  afterEach(() => {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("inserts a wake row on the first retry attempt", () => {
    const { runner } = makeRunner({ db, dataDir });
    runner.scheduleMorningRetry(makeMorningEvent());
    const rows = db
      .prepare(
        `SELECT task_type, status, json_extract(task_context, '$.routine') AS routine,
                json_extract(task_context, '$.retryCount') AS retryCount
         FROM agent_schedule`,
      )
      .all() as Array<{ task_type: string; status: string; routine: string; retryCount: number }>;
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({
      task_type: "wake",
      status: "pending",
      routine: "morning_routine",
      retryCount: 1,
    });
  });

  it("dedups when a pending retry already exists", () => {
    const { runner } = makeRunner({ db, dataDir });
    runner.scheduleMorningRetry(makeMorningEvent());
    runner.scheduleMorningRetry(makeMorningEvent());
    const count = db
      .prepare("SELECT COUNT(*) as cnt FROM agent_schedule")
      .get() as { cnt: number };
    expect(count.cnt).toBe(1);
  });

  it("escalates with a critical notification after MAX_RETRIES (3) attempts", async () => {
    const { runner, notificationMgr } = makeRunner({ db, dataDir });
    runner.scheduleMorningRetry(
      makeMorningEvent({ data: { retryCount: 3 } }),
    );
    // No new row should be inserted past the 3rd retry.
    const count = db
      .prepare("SELECT COUNT(*) as cnt FROM agent_schedule")
      .get() as { cnt: number };
    expect(count.cnt).toBe(0);
    // Wait a microtask so the void send().catch() chain settles.
    await Promise.resolve();
    expect(notificationMgr.send).toHaveBeenCalledTimes(1);
    const [msg, , opts] = (notificationMgr.send as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(msg).toContain("after 3 attempts");
    expect(opts).toMatchObject({ priority: "critical" });
  });

  it("uses exponential back-off (5min × retryCount) on each scheduled retry", () => {
    const { runner } = makeRunner({ db, dataDir });
    const before = Date.now();
    runner.scheduleMorningRetry(makeMorningEvent({ data: { retryCount: 1 } }));
    const row = db
      .prepare(
        `SELECT scheduled_for, json_extract(task_context, '$.retryCount') AS retryCount
         FROM agent_schedule LIMIT 1`,
      )
      .get() as { scheduled_for: string; retryCount: number };
    expect(row.retryCount).toBe(2); // previousCount + 1
    // scheduled_for should be ~10 minutes from now (retryCount 2 × 5min).
    const scheduledMs = new Date(row.scheduled_for + " UTC").getTime();
    const deltaMin = (scheduledMs - before) / 60_000;
    expect(deltaMin).toBeGreaterThanOrEqual(9);
    expect(deltaMin).toBeLessThanOrEqual(11);
  });

  it("preserves originalCorrelationId across retries", () => {
    const { runner } = makeRunner({ db, dataDir });
    const baseEvent = makeMorningEvent();
    const original = baseEvent.correlationId;
    runner.scheduleMorningRetry(baseEvent);
    const row = db
      .prepare(
        "SELECT correlation_id FROM agent_schedule LIMIT 1",
      )
      .get() as { correlation_id: string };
    expect(row.correlation_id).toBe(original);
  });
});

describe("MorningRoutineRunner — executeMorningRoutine", () => {
  let db: Database.Database;
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "pa-mr-"));
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applySchema(db);
  });

  afterEach(() => {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("dispatches via the orchestrator and emits the parent audit row on success", async () => {
    const { orchestrator, runMock, emitMock } = makeStubOrchestrator();
    const {
      runner,
      rotateDayFiles,
      setMorningRoutineInProgress,
    } = makeRunner({
      db,
      dataDir,
      pipelineOrchestrator: orchestrator,
      diagnoseTodayMdState: () => ({ kind: "fresh" }),
    });
    await runner.executeMorningRoutine(makeMorningEvent() as unknown as Event);
    expect(runMock).toHaveBeenCalledTimes(1);
    expect(emitMock).toHaveBeenCalledTimes(1);
    // Pre-execute lifecycle still fires — rotation + flag flip / reset land
    // around the dispatch regardless of which branch ran.
    expect(rotateDayFiles).toHaveBeenCalledTimes(1);
    expect(setMorningRoutineInProgress).toHaveBeenCalledWith(true);
    expect(setMorningRoutineInProgress).toHaveBeenCalledWith(false);
  });

  it("schedules a retry when diagnoseTodayMdState reports the file is missing", async () => {
    const { runner } = makeRunner({
      db,
      dataDir,
      diagnoseTodayMdState: () => ({ kind: "missing" }),
    });
    await runner.executeMorningRoutine(makeMorningEvent() as unknown as Event);
    const count = db
      .prepare("SELECT COUNT(*) as cnt FROM agent_schedule")
      .get() as { cnt: number };
    expect(count.cnt).toBe(1);
  });

  it("runs the fetch-window pre-pass and attaches the report block to the parent event passed into the orchestrator (D2)", async () => {
    // docs/design/appendices/routine-data-acquisition.md Phase 4 / D2.
    const fetchWindowRunner = {
      run: vi.fn().mockResolvedValue({
        report: {
          status: "success",
          fetched: 4,
          posted: 4,
          duplicates: 0,
          errors: [],
          skipped: false,
        },
        block: '<fetch_report routine="morning_routine" agent_day="2026-05-11" status="success" fetched="4" posted="4" duplicates="0" />',
      }),
    } as unknown as RoutineFetchWindowRunner;
    const { orchestrator, runMock } = makeStubOrchestrator();
    const { runner } = makeRunner({
      db,
      dataDir,
      fetchWindowRunner,
      pipelineOrchestrator: orchestrator,
      diagnoseTodayMdState: () => ({ kind: "fresh" }),
    });
    await runner.executeMorningRoutine(makeMorningEvent() as unknown as Event);
    expect(fetchWindowRunner.run).toHaveBeenCalledTimes(1);
    // The parentEvent forwarded into orchestrator.run carries the block
    // injected by the pre-pass. The orchestrator forwards it into Stage A.
    const parentEvent = runMock.mock.calls[0]![0].parentEvent as Event;
    expect(typeof parentEvent.data?.fetchReportBlock).toBe("string");
    expect(parentEvent.data?.fetchReportBlock).toContain('status="success"');
  });

  it("skips the pre-pass on retry attempts (cost guard)", async () => {
    // docs/design/appendices/routine-data-acquisition.md Phase 4 / D2 — retries cap.
    const fetchWindowRunner = {
      run: vi.fn(),
    } as unknown as RoutineFetchWindowRunner;
    const { runner } = makeRunner({
      db,
      dataDir,
      fetchWindowRunner,
      diagnoseTodayMdState: () => ({ kind: "fresh" }),
    });
    await runner.executeMorningRoutine(
      makeMorningEvent({ data: { retryCount: 1, isRetry: true } }) as unknown as Event,
    );
    expect(fetchWindowRunner.run).not.toHaveBeenCalled();
  });

  it("emits roadmap refresh after the agent runs when isRoadmapStale was true beforehand AND remains stale after", async () => {
    const { runner, emitRoadmapRefresh } = makeRunner({
      db,
      dataDir,
      isRoadmapStale: () => true,
      diagnoseTodayMdState: () => ({ kind: "fresh" }),
    });
    await runner.executeMorningRoutine(makeMorningEvent() as unknown as Event);
    expect(emitRoadmapRefresh).toHaveBeenCalledWith("post_morning_routine");
  });

  // When the agent populates roadmap.md inline, the post-hook re-staleness
  // check sees a fresh roadmap and skips the redundant
  // `routine.roadmap_refresh` session — one routine session instead of two.
  it("skips roadmap refresh when agent populated roadmap inline (was stale, now fresh)", async () => {
    const isRoadmapStale = vi
      .fn<() => boolean>()
      .mockReturnValueOnce(true)
      .mockReturnValue(false);
    const { runner, emitRoadmapRefresh } = makeRunner({
      db,
      dataDir,
      isRoadmapStale,
      diagnoseTodayMdState: () => ({ kind: "fresh" }),
    });
    await runner.executeMorningRoutine(makeMorningEvent() as unknown as Event);
    expect(emitRoadmapRefresh).not.toHaveBeenCalled();
    expect(isRoadmapStale).toHaveBeenCalledTimes(2);
  });

  it("does not call isRoadmapStale post-agent when it was fresh beforehand (preserves regular variant fast path)", async () => {
    const isRoadmapStale = vi.fn<() => boolean>().mockReturnValue(false);
    const { runner, emitRoadmapRefresh } = makeRunner({
      db,
      dataDir,
      isRoadmapStale,
      diagnoseTodayMdState: () => ({ kind: "fresh" }),
    });
    await runner.executeMorningRoutine(makeMorningEvent() as unknown as Event);
    expect(emitRoadmapRefresh).not.toHaveBeenCalled();
    expect(isRoadmapStale).toHaveBeenCalledTimes(1);
  });

  it("forwards the today.md health verdict + the orchestrator's startedAt to emitParentAuditRow", async () => {
    const startedAt = new Date("2026-05-15T04:00:00.000Z");
    const stageAResult = makeAgentResult({
      output: "stage-a",
      backendId: "claude",
      costUsd: 0.32,
      numTurns: 12,
    });
    const { orchestrator, emitMock } = makeStubOrchestrator({
      runResult: {
        stageAResult,
        stageBResult: makeAgentResult({ output: "stage-b" }),
        startedAt,
      },
    });
    const { runner } = makeRunner({
      db,
      dataDir,
      pipelineOrchestrator: orchestrator,
      diagnoseTodayMdState: () => ({ kind: "fresh" }),
    });
    const event = makeMorningEvent();
    await runner.executeMorningRoutine(event as unknown as Event);
    expect(emitMock).toHaveBeenCalledTimes(1);
    const args = emitMock.mock.calls[0]![0] as {
      correlationId: string;
      startedAt: Date;
      todayMdHealth: string;
      backend?: string;
    };
    expect(args.correlationId).toBe(event.correlationId);
    expect(args.startedAt).toBe(startedAt);
    expect(args.todayMdHealth).toBe("fresh");
    // Stage A's backendId is what observability uses to attribute the parent
    // row to a backend lane; pipe it through.
    expect(args.backend).toBe("claude");
  });

  it("projects diagnoseTodayMdState verdicts into the parent-audit health enum so the gate skip-reason is correct", async () => {
    const { orchestrator, emitMock } = makeStubOrchestrator({
      emitOutcome: { emitted: false, reason: "today_md_wrong_date" } as ParentAuditEmitResult,
    });
    const { runner } = makeRunner({
      db,
      dataDir,
      pipelineOrchestrator: orchestrator,
      diagnoseTodayMdState: () => ({
        kind: "wrong_date",
        writtenDate: "2026-05-13",
        expectedAgentDay: "2026-05-15",
      }),
    });
    await runner.executeMorningRoutine(makeMorningEvent() as unknown as Event);
    const args = emitMock.mock.calls[0]![0] as { todayMdHealth: string };
    // Discriminated union → flat string per parent-audit-emitter contract.
    expect(args.todayMdHealth).toBe("wrong_date");
    // The runner must still schedule a retry when the today.md health verdict
    // isn't 'fresh' — the parent-audit emit runs alongside, not instead of,
    // the retry path.
    const retryCount = db
      .prepare("SELECT COUNT(*) AS cnt FROM agent_schedule")
      .get() as { cnt: number };
    expect(retryCount.cnt).toBe(1);
  });

  it("schedules a retry and skips emitParentAuditRow when the orchestrator throws", async () => {
    // The orchestrator owns Stage A / Stage B end-to-end. A throw here
    // means Stage A failed — there's no today.md to gate on. The runner
    // catches, logs, and falls through to `diagnoseTodayMdState` which
    // detects the missing today.md and schedules a retry the same way a
    // Stage-A-internal failure would.
    const { orchestrator, runMock, emitMock } = makeStubOrchestrator({
      runThrows: new Error("orchestrator boom"),
    });
    const { runner } = makeRunner({
      db,
      dataDir,
      pipelineOrchestrator: orchestrator,
      diagnoseTodayMdState: () => ({ kind: "missing" }),
    });
    await runner.executeMorningRoutine(makeMorningEvent() as unknown as Event);
    expect(runMock).toHaveBeenCalledTimes(1);
    expect(emitMock).not.toHaveBeenCalled();
    const count = db
      .prepare("SELECT COUNT(*) AS cnt FROM agent_schedule")
      .get() as { cnt: number };
    expect(count.cnt).toBe(1);
  });

  it("forwards the medium retry tier override into orchestrator.run on retry attempts", async () => {
    const { orchestrator, runMock } = makeStubOrchestrator();
    const { runner } = makeRunner({
      db,
      dataDir,
      pipelineOrchestrator: orchestrator,
      diagnoseTodayMdState: () => ({ kind: "fresh" }),
    });
    await runner.executeMorningRoutine(
      makeMorningEvent({
        data: { retryCount: 1, isRetry: true },
      }) as unknown as Event,
    );
    expect(runMock).toHaveBeenCalledTimes(1);
    const args = runMock.mock.calls[0]![0] as {
      isRetry: boolean;
      requestedTier?: string;
    };
    expect(args.isRetry).toBe(true);
    expect(args.requestedTier).toBe("medium");
  });

  // morning-routine-optimization.md Phase 6 — ⑥ AgentJournalAppender

  it("invokes appendAgentJournalEntry with the routine's correlationId, BEFORE emitParentAuditRow", async () => {
    const { orchestrator, appendMock, emitMock } = makeStubOrchestrator();
    const { runner } = makeRunner({
      db,
      dataDir,
      pipelineOrchestrator: orchestrator,
      diagnoseTodayMdState: () => ({ kind: "fresh" }),
    });
    const event = makeMorningEvent();
    await runner.executeMorningRoutine(event as unknown as Event);
    expect(appendMock).toHaveBeenCalledTimes(1);
    expect(appendMock).toHaveBeenCalledWith({
      correlationId: event.correlationId,
    });
    // Order matters: the journal entry must be on disk before the
    // pre-routine gate's parent-audit row lands, so monitoring tools
    // reading `pnpm audit` see the entry once the gate fires.
    const appendInvocation = appendMock.mock.invocationCallOrder[0]!;
    const emitInvocation = emitMock.mock.invocationCallOrder[0]!;
    expect(appendInvocation).toBeLessThan(emitInvocation);
  });

  it("still emits parent audit row when appendAgentJournalEntry throws — journal write is best-effort", async () => {
    const { orchestrator, appendMock, emitMock } = makeStubOrchestrator();
    appendMock.mockImplementation(() => {
      throw new Error("journal append boom");
    });
    const { runner } = makeRunner({
      db,
      dataDir,
      pipelineOrchestrator: orchestrator,
      diagnoseTodayMdState: () => ({ kind: "fresh" }),
    });
    await runner.executeMorningRoutine(makeMorningEvent() as unknown as Event);
    // Appender threw; emit still fires so the pre-routine gate signal lands.
    expect(emitMock).toHaveBeenCalledTimes(1);
  });
});
