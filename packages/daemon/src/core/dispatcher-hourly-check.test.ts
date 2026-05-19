import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySchema } from "../db/schema.js";
import { HourlyCheckCoordinator } from "./dispatcher-hourly-check.js";
import { EventBus } from "./event-bus.js";
import { PromptAssembler } from "./dispatcher-prompt.js";
import type { RoutineFetchWindowRunner } from "./routine-fetch-window-runner.js";
import { prePassLastRunRuntimeStateKey } from "./pre-pass-freshness.js";
import { writeRuntimeState } from "../db/runtime-state.js";
import { recordObservation } from "../db/observations.js";
import type { AgentConfig } from "../config.js";
import type { IAgentRouter } from "./backends/backend-router.js";
import type {
  IAuditLogger,
  IContextBuilder,
  TriggerHourlyCheckSkipReason,
} from "./dispatcher-types.js";

function fakeConfig(dataDir: string): AgentConfig {
  return {
    dataDir,
    workspaceDir: join(dataDir, "workdirs"),
    apiPort: 0,
    timezone: "UTC",
    dayBoundaryHour: 4,
    hourlyCheckMinObservations: 5,
    hourlyCheckHeartbeatHours: 4,
    hourlyCheckStage2Enabled: false,
    hourlyCheckLowSignalPendingCeiling: 0,
    hourlyCheckPrePassFreshnessMinutes: 30,
    vipMailSenders: [],
  } as unknown as AgentConfig;
}

function makeAudit(): IAuditLogger {
  return {
    logAction: vi.fn(),
    logSkip: vi.fn(),
    logError: vi.fn(),
    logAttachment: vi.fn(),
    logBangCommand: vi.fn(),
  } as unknown as IAuditLogger;
}

function makeRouter(): IAgentRouter {
  return {
    execute: vi.fn(),
    executeResume: vi.fn(),
    summarize: vi.fn(),
    resolveBinding: vi.fn(),
  } as unknown as IAgentRouter;
}

/**
 * HOURLY_CHECK_GATE_REDESIGN_PLAN.md §3.3 — most tests don't exercise
 * the pre-pass spawn (they verify gate behaviour, not the fetcher). A
 * stub runner that returns an inert `<fetch_report status="skipped"/>`
 * block keeps the dep contract satisfied without spinning up the real
 * router-driven pipeline. Tests that DO care about the pre-pass spawn
 * install their own runner via the `fetchWindowRunner` opt.
 */
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
      block: `<fetch_report routine="hourly_check" agent_day="2026-05-17" status="skipped" fetched="0" posted="0" duplicates="0" />`,
    }),
  } as unknown as RoutineFetchWindowRunner;
}

interface CoordinatorHandle {
  coordinator: HourlyCheckCoordinator;
  eventBus: EventBus;
  state: {
    hourlyCheckInProgress: boolean;
    morningRoutineActive: boolean;
    autonomousBlock: TriggerHourlyCheckSkipReason | null;
  };
  audit: IAuditLogger;
  router: IAgentRouter;
}

/**
 * Insert a successful `routine.morning_routine` action row dated NOW so
 * the pre-routine gate does not trip in tests that aren't explicitly
 * exercising it. Opt out by passing `preInsertMorningRoutineSuccess: false`.
 */
function insertMorningRoutineSuccess(db: Database.Database): void {
  db
    .prepare(
      `INSERT INTO agent_actions
         (event_id, action_type, result, started_at, completed_at)
       VALUES (?, 'routine.morning_routine', 'success', datetime('now'), datetime('now'))`,
    )
    .run("test-morning-routine-" + Math.random().toString(36).slice(2));
}

function setIntegrationMode(
  db: Database.Database,
  rows: Record<string, { mode: string; nativeBackend?: string; delegatedBackend?: string }>,
): void {
  const payload: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rows)) {
    payload[k] = {
      mode: v.mode,
      ...(v.nativeBackend ? { nativeBackend: v.nativeBackend } : {}),
      ...(v.delegatedBackend ? { delegatedBackend: v.delegatedBackend } : {}),
      deniedTools: [],
      lastChangedAt: "2026-05-17T00:00:00Z",
    };
  }
  db.prepare(
    `INSERT INTO settings (key, value_json, updated_at)
     VALUES ('integrations', ?, CURRENT_TIMESTAMP)
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json,
                                    updated_at = CURRENT_TIMESTAMP`,
  ).run(JSON.stringify(payload));
}

function makeCoordinator(opts: {
  db: Database.Database;
  dataDir: string;
  config?: AgentConfig;
  initialAutonomousBlock?: TriggerHourlyCheckSkipReason | null;
  fetchWindowRunner?: RoutineFetchWindowRunner;
  preInsertMorningRoutineSuccess?: boolean;
  queueMorningRoutineWake?: ((source: string, options?: {
    postCatchupRoutines?: string[];
    postCatchupHourlyCheck?: boolean;
  }) => { inserted: boolean; existingId?: number }) | null;
}): CoordinatorHandle & {
  fetchWindowRunner: RoutineFetchWindowRunner;
  queueWake: ReturnType<typeof vi.fn>;
} {
  const eventBus = new EventBus();
  const audit = makeAudit();
  const router = makeRouter();
  const config = opts.config ?? fakeConfig(opts.dataDir);
  const state = {
    hourlyCheckInProgress: false,
    morningRoutineActive: false,
    autonomousBlock: opts.initialAutonomousBlock ?? null,
  };
  const prompt = new PromptAssembler({
    db: opts.db,
    config,
    getTaskFlow: () => "",
    activeTurnTokens: new Map(),
    getAttachmentStore: () => null,
    getVoiceTranscriber: () => null,
  });
  const contextBuilder: IContextBuilder = {
    build: vi.fn().mockResolvedValue(""),
    buildResumeCatchupContext: vi.fn().mockResolvedValue(null),
  };
  const fetchWindowRunner = opts.fetchWindowRunner ?? makeStubFetchWindowRunner();
  const queueWake = vi.fn(
    opts.queueMorningRoutineWake
      ?? (() => ({ inserted: true as const })),
  );
  if (opts.preInsertMorningRoutineSuccess !== false) {
    insertMorningRoutineSuccess(opts.db);
  }
  const coordinator = new HourlyCheckCoordinator({
    db: opts.db,
    config,
    eventBus,
    contextBuilder,
    agentRouter: router,
    audit,
    todayWriteLock: undefined,
    prompt,
    fetchWindowRunner,
    getDelegatedSyncRefresh: () => null,
    setHourlyCheckInProgress: (value) => {
      state.hourlyCheckInProgress = value;
    },
    isHourlyCheckInProgress: () => state.hourlyCheckInProgress,
    isMorningRoutineActive: () => state.morningRoutineActive,
    isAutonomousAllowed: () => state.autonomousBlock,
    getQueueMorningRoutineWake: () =>
      opts.queueMorningRoutineWake === null ? null : queueWake,
  });
  return { coordinator, eventBus, state, audit, router, fetchWindowRunner, queueWake };
}

describe("HourlyCheckCoordinator — early skip gates", () => {
  let db: Database.Database;
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "pa-hc-"));
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applySchema(db);
  });

  afterEach(() => {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("skips with reason=hourly_check_in_progress when the flag is already set", async () => {
    const { coordinator, state } = makeCoordinator({ db, dataDir });
    state.hourlyCheckInProgress = true;
    const result = await coordinator.trigger("cron");
    expect(result).toMatchObject({
      status: "skipped",
      reason: "hourly_check_in_progress",
    });
    expect(state.hourlyCheckInProgress).toBe(true);
  });

  it("skips with reason from isAutonomousAllowed when the gate forbids autonomous work", async () => {
    const { coordinator, state } = makeCoordinator({
      db,
      dataDir,
      initialAutonomousBlock: "user_paused",
    });
    const result = await coordinator.trigger("cron");
    expect(result).toMatchObject({ status: "skipped", reason: "user_paused" });
    expect(state.hourlyCheckInProgress).toBe(false);
  });

  it("skips with reason=morning_routine_active when isMorningRoutineActive returns true", async () => {
    const { coordinator, state } = makeCoordinator({ db, dataDir });
    state.morningRoutineActive = true;
    const result = await coordinator.trigger("cron");
    expect(result).toMatchObject({
      status: "skipped",
      reason: "morning_routine_active",
    });
    expect(state.hourlyCheckInProgress).toBe(false);
  });
});

describe("HourlyCheckCoordinator — morning_routine_pending_for_today gate", () => {
  let db: Database.Database;
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "pa-hc-"));
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applySchema(db);
  });

  afterEach(() => {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("skips and enqueues a morning_routine wake when no successful morning_routine row exists", async () => {
    const { coordinator, state, queueWake } = makeCoordinator({
      db,
      dataDir,
      preInsertMorningRoutineSuccess: false,
    });
    const result = await coordinator.trigger("cron");
    expect(result).toMatchObject({
      status: "skipped",
      reason: "morning_routine_pending_for_today",
    });
    expect(queueWake).toHaveBeenCalledOnce();
    expect(queueWake.mock.calls[0][0]).toBe("hourly_check_dependency:cron");
    expect(state.hourlyCheckInProgress).toBe(false);
  });

  it("does not skip when a successful morning_routine row exists for the current agent-day", async () => {
    const { coordinator, queueWake } = makeCoordinator({ db, dataDir });
    const result = await coordinator.trigger("cron");
    expect(result.reason).not.toBe("morning_routine_pending_for_today");
    expect(queueWake).not.toHaveBeenCalled();
  });

  it("still skips (no infinite loop) when the queue-wake callback is unwired", async () => {
    const { coordinator } = makeCoordinator({
      db,
      dataDir,
      preInsertMorningRoutineSuccess: false,
      queueMorningRoutineWake: null,
    });
    const result = await coordinator.trigger("cron");
    expect(result).toMatchObject({
      status: "skipped",
      reason: "morning_routine_pending_for_today",
    });
  });
});

// ────────────────────────────────────────────────────────────────────────────
// HOURLY_CHECK_GATE_REDESIGN_PLAN.md §3.3 Layer-1 harvest — `harvestForGate`
// spawns the routine.fetch_window runner for active non-direct integrations
// BEFORE the gate signal computation. The freshness window
// (`hourlyCheckPrePassFreshnessMinutes`, default 30 min) prevents redundant
// fetches; `forced` runs bypass the window.
// ────────────────────────────────────────────────────────────────────────────

describe("HourlyCheckCoordinator — Layer-1 pre-pass harvest", () => {
  let db: Database.Database;
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "pa-hc-harvest-"));
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applySchema(db);
  });

  afterEach(() => {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  function makeSuccessRunner(): {
    fetchWindowRunner: RoutineFetchWindowRunner;
    run: ReturnType<typeof vi.fn>;
  } {
    const run = vi.fn().mockResolvedValue({
      report: {
        status: "success",
        fetched: 1,
        posted: 1,
        duplicates: 0,
        errors: [],
        skipped: false,
        perIntegration: [
          {
            integrationKey: "gmail",
            status: "success",
            fetched: 1,
            posted: 1,
            duplicates: 0,
            errors: [],
            attempts: [],
            attempt: 1,
            fetcherCorrelationId: "x",
            startedAt: "2026-05-17T00:00:00Z",
            endedAt: "2026-05-17T00:00:01Z",
            costUsd: 0.001,
            numTurns: 1,
          },
        ],
      },
      block:
        '<fetch_report routine="hourly_check" agent_day="2026-05-17" status="success" fetched="1" posted="1" duplicates="0" />',
    });
    return {
      fetchWindowRunner: { run } as unknown as RoutineFetchWindowRunner,
      run,
    };
  }

  it("skips pre-pass entirely when no non-direct integration is active", async () => {
    // Only a direct-mode integration → harvestForGate is a no-op. The
    // gate proceeds with whatever observations the in-process pollers
    // have written.
    setIntegrationMode(db, { gmail: { mode: "direct" } });
    const { fetchWindowRunner, run } = makeSuccessRunner();
    const config = fakeConfig(dataDir);
    (config as { hourlyCheckMinObservations: number }).hourlyCheckMinObservations = 0;
    (config as { hourlyCheckHeartbeatHours: number }).hourlyCheckHeartbeatHours = 24;
    const { coordinator, eventBus } = makeCoordinator({
      db,
      dataDir,
      config,
      fetchWindowRunner,
    });
    await coordinator.trigger("cron");
    expect(run).not.toHaveBeenCalled();
    // The event bus may or may not have an enqueue depending on signals;
    // we only care that the runner didn't spawn.
    await Promise.race([
      eventBus.get(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 10)),
    ]);
  });

  it("runs pre-pass for delegated integrations whose freshness window has elapsed", async () => {
    setIntegrationMode(db, {
      gmail: { mode: "delegated", delegatedBackend: "claude" },
    });
    const { fetchWindowRunner, run } = makeSuccessRunner();
    const config = fakeConfig(dataDir);
    (config as { hourlyCheckMinObservations: number }).hourlyCheckMinObservations = 0;
    const { coordinator } = makeCoordinator({
      db,
      dataDir,
      config,
      fetchWindowRunner,
    });
    await coordinator.trigger("cron");
    expect(run).toHaveBeenCalledTimes(1);
    const [, , runOpts] = run.mock.calls[0];
    expect(runOpts.integrationKeyFilter).toBeInstanceOf(Set);
    expect((runOpts.integrationKeyFilter as Set<string>).has("gmail")).toBe(true);
  });

  it("skips pre-pass when the freshness window has not elapsed", async () => {
    setIntegrationMode(db, {
      gmail: { mode: "delegated", delegatedBackend: "claude" },
    });
    // Mark gmail's pre-pass as just-run.
    writeRuntimeState(
      db,
      prePassLastRunRuntimeStateKey("gmail"),
      new Date().toISOString(),
    );
    const { fetchWindowRunner, run } = makeSuccessRunner();
    const config = fakeConfig(dataDir);
    (config as { hourlyCheckMinObservations: number }).hourlyCheckMinObservations = 0;
    const { coordinator } = makeCoordinator({
      db,
      dataDir,
      config,
      fetchWindowRunner,
    });
    await coordinator.trigger("cron");
    expect(run).not.toHaveBeenCalled();
  });

  it("bypasses the freshness window when forced=true", async () => {
    setIntegrationMode(db, {
      gmail: { mode: "native", nativeBackend: "claude" },
    });
    writeRuntimeState(
      db,
      prePassLastRunRuntimeStateKey("gmail"),
      new Date().toISOString(),
    );
    const { fetchWindowRunner, run } = makeSuccessRunner();
    const config = fakeConfig(dataDir);
    (config as { hourlyCheckMinObservations: number }).hourlyCheckMinObservations = 0;
    const { coordinator } = makeCoordinator({
      db,
      dataDir,
      config,
      fetchWindowRunner,
    });
    await coordinator.trigger("manual:api", { force: true });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("attaches the pre-pass <fetch_report> block onto the Stage 3 event", async () => {
    setIntegrationMode(db, {
      gmail: { mode: "native", nativeBackend: "claude" },
    });
    const { fetchWindowRunner } = makeSuccessRunner();
    const config = fakeConfig(dataDir);
    (config as { hourlyCheckMinObservations: number }).hourlyCheckMinObservations = 0;
    (config as { hourlyCheckHeartbeatHours: number }).hourlyCheckHeartbeatHours = 0;
    const { coordinator, eventBus } = makeCoordinator({
      db,
      dataDir,
      config,
      fetchWindowRunner,
    });
    const result = await coordinator.trigger("cron");
    expect(result.status).toBe("queued");
    const event = (await eventBus.get()) as
      | { data: { fetchReportBlock?: string } }
      | null;
    expect(event).not.toBeNull();
    expect(event!.data.fetchReportBlock).toContain('status="success"');
  });

  it("§3.5 cautious-escalate: pre-pass failure forces stage3 regardless of signal verdict", async () => {
    setIntegrationMode(db, {
      gmail: { mode: "native", nativeBackend: "claude" },
    });
    const run = vi.fn().mockResolvedValue({
      report: {
        status: "failed",
        fetched: 0,
        posted: 0,
        duplicates: 0,
        errors: [{ type: "pre-pass-failed" }],
        skipped: false,
        perIntegration: [
          {
            integrationKey: "gmail",
            status: "failed",
            fetched: 0,
            posted: 0,
            duplicates: 0,
            errors: [{ type: "pre-pass-failed" }],
            attempts: [],
            attempt: 1,
            fetcherCorrelationId: "x",
            startedAt: "2026-05-17T00:00:00Z",
            endedAt: "2026-05-17T00:00:01Z",
            costUsd: 0,
            numTurns: 0,
          },
        ],
      },
      block:
        '<fetch_report routine="hourly_check" agent_day="2026-05-17" status="failed" fetched="0" posted="0" duplicates="0" />',
    });
    const fetchWindowRunner = { run } as unknown as RoutineFetchWindowRunner;
    const config = fakeConfig(dataDir);
    // No signals — without cautious-escalate this would be stage0_silent.
    (config as { hourlyCheckMinObservations: number }).hourlyCheckMinObservations = 0;
    (config as { hourlyCheckHeartbeatHours: number }).hourlyCheckHeartbeatHours = 999;
    const { coordinator, eventBus } = makeCoordinator({
      db,
      dataDir,
      config,
      fetchWindowRunner,
    });
    const result = await coordinator.trigger("cron");
    expect(result).toMatchObject({
      status: "queued",
      appliedStage: "stage3",
      cautiousEscalate: true,
      gateReason: "cautious_escalate_prepass_failure",
    });
    const event = (await eventBus.get()) as
      | { data: { gateDecision?: { cautiousEscalate?: boolean } } }
      | null;
    expect(event).not.toBeNull();
    expect(event!.data.gateDecision?.cautiousEscalate).toBe(true);

    // §3.5 observability — the original gate verdict (heartbeat_due
    // because hoursSinceLastStage3Run=Infinity here) must be preserved
    // alongside the cautious-escalate overwrite so dashboards can
    // distinguish "would have been stage3 anyway" from "forced up by
    // pre-pass failure".
    const auditRow = db
      .prepare(
        "SELECT detail FROM agent_actions WHERE action_type='hourly_check.gate' ORDER BY id DESC LIMIT 1",
      )
      .get() as { detail: string } | undefined;
    expect(auditRow).toBeDefined();
    const detail = JSON.parse(auditRow!.detail);
    expect(detail.cautious_escalate).toBe(true);
    expect(detail.pre_escalate_gate_stage).toBeDefined();
    expect(typeof detail.pre_escalate_gate_reason).toBe("string");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// HOURLY_CHECK_GATE_REDESIGN_PLAN.md Phase 1+2 — mode-matrix coverage.
// The gate's signal compute is mode-blind: actor='user' (direct poller)
// and actor='agent' (delegated-sync / pre-pass) rows both contribute to
// the same signals. Each row here verifies the structural promise.
// ────────────────────────────────────────────────────────────────────────────

describe("HourlyCheckCoordinator — mode-blind gate signals", () => {
  let db: Database.Database;
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "pa-hc-modematrix-"));
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applySchema(db);
  });

  afterEach(() => {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("counts actor='agent' delegated rows toward pendingCount (defect fix)", async () => {
    // Pre-Phase-1 the gate filtered `actor='user'`, so a delegated-sync
    // POST tagged `actor='agent'` would be invisible. Verify the
    // filter is dropped: the row contributes to pendingCount.
    recordObservation(db, {
      source: "gmail:default",
      ref: "msg-1",
      changeType: "created",
      actor: "agent",
      payload: { kind: "mail", raw: { from: "x@example.com" } },
    });
    setIntegrationMode(db, {
      gmail: { mode: "delegated", delegatedBackend: "claude" },
    });
    // Pre-set freshness so the harvester does not double-fetch on this
    // tick — we want to read the prior agent-row that's already in the
    // table, not have the gate spawn another fetch.
    writeRuntimeState(
      db,
      prePassLastRunRuntimeStateKey("gmail"),
      new Date().toISOString(),
    );
    const config = fakeConfig(dataDir);
    (config as { hourlyCheckMinObservations: number }).hourlyCheckMinObservations = 1;
    (config as { hourlyCheckHeartbeatHours: number }).hourlyCheckHeartbeatHours = 24;
    const { coordinator } = makeCoordinator({ db, dataDir, config });
    const result = await coordinator.trigger("cron");
    expect(result.pendingCount).toBeGreaterThanOrEqual(1);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Forced runs and queue mechanics.
// ────────────────────────────────────────────────────────────────────────────

describe("HourlyCheckCoordinator — forced enqueue mechanics", () => {
  let db: Database.Database;
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "pa-hc-forced-"));
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applySchema(db);
  });

  afterEach(() => {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("propagates requestedModel into the enqueued event", async () => {
    const config = fakeConfig(dataDir);
    (config as { hourlyCheckMinObservations: number }).hourlyCheckMinObservations = 0;
    (config as { hourlyCheckHeartbeatHours: number }).hourlyCheckHeartbeatHours = 0;
    const { coordinator, eventBus } = makeCoordinator({ db, dataDir, config });
    await coordinator.trigger("manual:api", {
      force: true,
      requestedModel: "opus",
    });
    const event = await eventBus.get();
    expect(event).not.toBeNull();
    expect((event as { requestedModel?: string }).requestedModel).toBe("opus");
  });

  it("skips with reason=below_threshold when pendingCount<min and gate stage is stage3 (legacy floor)", async () => {
    // heartbeatHours=0 forces stage3 every tick. With no novelty, no
    // signals, and pendingCount < min, the legacy min-observations
    // floor short-circuits the Stage 3 enqueue.
    const config = fakeConfig(dataDir);
    (config as { hourlyCheckMinObservations: number }).hourlyCheckMinObservations = 5;
    (config as { hourlyCheckHeartbeatHours: number }).hourlyCheckHeartbeatHours = 0;
    const { coordinator } = makeCoordinator({ db, dataDir, config });
    const result = await coordinator.trigger("cron");
    expect(result).toMatchObject({
      status: "skipped",
      reason: "below_threshold",
      minObservations: 5,
    });
  });

  it("queues Stage 3 with forced=true regardless of pendingCount", async () => {
    const config = fakeConfig(dataDir);
    (config as { hourlyCheckMinObservations: number }).hourlyCheckMinObservations = 5;
    (config as { hourlyCheckHeartbeatHours: number }).hourlyCheckHeartbeatHours = 0;
    const { coordinator, eventBus, state } = makeCoordinator({
      db,
      dataDir,
      config,
    });
    const result = await coordinator.trigger("manual:api", { force: true });
    expect(result).toMatchObject({
      status: "queued",
      forced: true,
      appliedStage: "stage3",
    });
    const event = await eventBus.get();
    expect((event as { type: string }).type).toBe("routine.hourly_check");
    expect(state.hourlyCheckInProgress).toBe(true);
  });
});
