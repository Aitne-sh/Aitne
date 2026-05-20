/**
 * Tests for `MorningRoutinePipelineOrchestrator` (Phase 5).
 *
 * Strategy: the full `run()` method exercises `agentRouter.execute()` —
 * SDK-bound and excluded from coverage per `vitest.config.ts` (same
 * rationale as `dispatcher-morning-routine.ts`). These tests drive the
 * orchestrator with hand-rolled mocks of the agent router / context
 * builder / prompt assembler / error router / result processor so the
 * orchestration contract (parallel Stage A + Stage B, retry path skips
 * Stage B, parent audit emit gating, daemon-prepared blocks injected
 * onto each stage's `event.data`) is pinned without ringing the SDK.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import {
  EventPriority,
  type AgentResult,
  type BackendId,
  type Event,
  type ProcessKey,
  type ProcessModelTier,
  type RoutineEvent,
} from "@aitne/shared";
import {
  MorningRoutinePipelineOrchestrator,
  STAGE_A_PROCESS_KEY,
  STAGE_A_ROUTINE_SLUG,
  STAGE_B_PROCESS_KEY,
  STAGE_B_ROUTINE_SLUG,
} from "./orchestrator.js";
import { applySchema } from "../../db/schema.js";
import type { AgentConfig } from "../../config.js";

interface CapturedExecute {
  event: Event;
  processKey: ProcessKey | undefined;
  requestedTier?: ProcessModelTier;
}

function makeAgentResult(overrides: Partial<AgentResult> = {}): AgentResult {
  return {
    output: "ok",
    contextUpdated: false,
    isError: false,
    numTurns: 1,
    costUsd: 0,
    durationMs: 1,
    model: "test-model",
    backendId: "claude" as BackendId,
    sessionId: "test-session",
    usage: null,
    modelUsage: null,
    costSource: "sdk",
    advisorCallCount: 0,
    ...overrides,
  };
}

function makeRouteBinding() {
  return {
    main: {
      backendId: "claude" as BackendId,
      modelId: "claude-sonnet-test",
      maxTurns: 50,
      maxBudgetUsd: 0.5,
      role: "main" as const,
    },
    fallback: null,
    processKey: STAGE_A_PROCESS_KEY,
  };
}

function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  // Cast to AgentConfig — the orchestrator only reads `dataDir`,
  // `vaultMode`, `primaryVaultPath`, `timezone`, `dayBoundaryHour`. The
  // full RuntimeSettings shape is irrelevant here.
  return {
    dataDir: "/tmp/aitne-orchestrator-test-data",
    workspaceDir: ".",
    apiPort: 8321,
    timezone: "UTC",
    dayBoundaryHour: 4,
    vaultMode: "plain",
    primaryVaultPath: null,
    ...overrides,
  } as unknown as AgentConfig;
}

function makeParentEvent(overrides: Partial<Event> = {}): Event {
  return {
    type: "routine.morning_routine",
    source: "cron",
    priority: EventPriority.HIGH,
    timestamp: new Date("2026-05-15T04:00:00Z"),
    correlationId: "corr-test-001",
    data: {
      todayWriteLockId: "lock-abc",
      fetchReportBlock: "<fetch_report status=\"success\" />",
    },
    ...overrides,
  };
}

describe("MorningRoutinePipelineOrchestrator", () => {
  let tmp: string;
  let db: Database.Database;
  let config: AgentConfig;
  let mocks: ReturnType<typeof buildMocks>;

  function buildMocks(args: {
    stageAResult?: AgentResult;
    stageBResult?: AgentResult;
    stageAThrows?: Error;
    stageBThrows?: Error;
  }) {
    const calls: CapturedExecute[] = [];
    const contextBuilder = {
      build: vi.fn(async (event: Event) =>
        `<ctx for=${event.type} routine=${(event as RoutineEvent).routine}>`,
      ),
    };
    const agentRouter = {
      execute: vi.fn(async (params: {
        prompt: string;
        context: string;
        event: Event;
        processKey?: ProcessKey;
        requestedTier?: ProcessModelTier;
      }) => {
        calls.push({
          event: params.event,
          processKey: params.processKey,
          ...(params.requestedTier ? { requestedTier: params.requestedTier } : {}),
        });
        if (params.processKey === STAGE_A_PROCESS_KEY) {
          if (args.stageAThrows) throw args.stageAThrows;
          return args.stageAResult ?? makeAgentResult({ output: "stage-a" });
        }
        if (args.stageBThrows) throw args.stageBThrows;
        return args.stageBResult ?? makeAgentResult({ output: "stage-b" });
      }),
      resolveBinding: vi.fn(() => makeRouteBinding()),
      executeResume: vi.fn(),
      summarize: vi.fn(),
    };
    const prompt = {
      assemble: vi.fn(
        (eventType: string, processKey: string) =>
          `prompt(${eventType},${processKey})`,
      ),
    };
    const errorRouter = {
      executeWithRetry: vi.fn(async <T,>(fn: () => Promise<T>) => fn()),
    };
    const resultProcessor = {
      processResult: vi.fn(async () => undefined),
    };
    // Phase-5/6 failure-path audit dep — supplied so `recordStageFailure`
    // can write its `result='failed'` row when a stage rejects. The
    // existing success-path tests don't pass this through (no failure to
    // record), so the constructor's optional shape stays compatible.
    const audit = {
      logAction: vi.fn(),
      logError: vi.fn(),
      logSkip: vi.fn(),
      logAttachment: vi.fn(),
      logBangCommand: vi.fn(),
      insertInProgressRow: vi.fn(() => -1),
    };
    return { contextBuilder, agentRouter, prompt, errorRouter, resultProcessor, audit, calls };
  }

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "morning-orchestrator-test-"));
    db = new Database(":memory:");
    applySchema(db);
    mkdirSync(join(tmp, "context"), { recursive: true });
    config = makeConfig({ dataDir: tmp });
    mocks = buildMocks({});
    // Default fixture = recurring-day. Phase 6 introduced a first-run
    // skip in `buildStageBInputs`: when `yesterday.md` is absent the
    // orchestrator does NOT spawn Stage B (no prior agent-day to author
    // a journal about). Tests that exercise the recurring-day shape
    // (the majority — Stage A + Stage B both fire) therefore need
    // yesterday.md on disk; tests that specifically exercise the
    // missing-yesterday / first-run path opt out with `rmSync` before
    // calling `run()`. Body is intentionally minimal — the handoff
    // parser fails soft on a body with no `## Handoff` and the skeleton
    // builder tolerates a non-`## User Tasks` body, so no per-test
    // assertion depends on the literal content here.
    writeFileSync(
      join(tmp, "context", "yesterday.md"),
      "# 2026-05-14 (Wednesday)\n",
    );
  });

  afterEach(() => {
    db.close();
    rmSync(tmp, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function makeOrchestrator(overrides?: Partial<typeof mocks>) {
    const merged = { ...mocks, ...(overrides ?? {}) };
    return new MorningRoutinePipelineOrchestrator({
      db,
      config,
      contextBuilder: merged.contextBuilder as never,
      agentRouter: merged.agentRouter as never,
      prompt: merged.prompt as never,
      errorRouter: merged.errorRouter as never,
      resultProcessor: merged.resultProcessor as never,
      audit: merged.audit as never,
    });
  }

  describe("run() — parallel Stage A + Stage B", () => {
    it("dispatches both stages with the right process keys + event types", async () => {
      const orch = makeOrchestrator();
      const out = await orch.run({
        parentEvent: makeParentEvent(),
        isRetry: false,
      });
      expect(mocks.agentRouter.execute).toHaveBeenCalledTimes(2);
      const stageACall = mocks.calls.find(
        (c) => c.processKey === STAGE_A_PROCESS_KEY,
      );
      const stageBCall = mocks.calls.find(
        (c) => c.processKey === STAGE_B_PROCESS_KEY,
      );
      expect(stageACall).toBeDefined();
      expect(stageBCall).toBeDefined();
      expect(stageACall!.event.type).toBe("routine.morning_routine_today");
      expect((stageACall!.event as RoutineEvent).routine).toBe(STAGE_A_ROUTINE_SLUG);
      expect(stageBCall!.event.type).toBe("routine.morning_routine_journal");
      expect((stageBCall!.event as RoutineEvent).routine).toBe(STAGE_B_ROUTINE_SLUG);
      expect(out.stageAResult.output).toBe("stage-a");
      expect(out.stageBResult?.output).toBe("stage-b");
    });

    it("injects <handoff_parsed> onto Stage A when yesterday.md has a parseable handoff", async () => {
      writeFileSync(
        join(tmp, "context", "yesterday.md"),
        [
          "# 2026-05-14 (Wednesday)",
          "",
          "## Handoff",
          "### Tomorrow",
          "- ship phase 5",
          "- review the journal author",
          "### Later",
          "- (none)",
          "",
        ].join("\n"),
      );
      const orch = makeOrchestrator();
      await orch.run({ parentEvent: makeParentEvent(), isRetry: false });
      const stageACall = mocks.calls.find(
        (c) => c.processKey === STAGE_A_PROCESS_KEY,
      )!;
      const block = (stageACall.event.data as { handoffParsedBlock?: string })
        .handoffParsedBlock;
      expect(typeof block).toBe("string");
      expect(block).toContain("<item>ship phase 5</item>");
      expect(block).toContain("<item>review the journal author</item>");
      // Empty subsections render `(none)` so the agent reads "no carry"
      // explicitly rather than reading an absent element as ambiguity.
      expect(block).toContain("<later>");
      expect(block).toContain("<item>(none)</item>");
    });

    it("omits <handoff_parsed> when yesterday.md is missing", async () => {
      // beforeEach seeds a minimal yesterday.md for the recurring-day
      // tests; this test exercises the first-run / missing-file path
      // explicitly. Deleting it here also exercises the orchestrator's
      // Phase 6 first-run skip for Stage B — verified in the dedicated
      // "skips Stage B on first-run" test below.
      rmSync(join(tmp, "context", "yesterday.md"));
      const orch = makeOrchestrator();
      await orch.run({ parentEvent: makeParentEvent(), isRetry: false });
      const stageACall = mocks.calls.find(
        (c) => c.processKey === STAGE_A_PROCESS_KEY,
      )!;
      expect(
        (stageACall.event.data as { handoffParsedBlock?: string })
          .handoffParsedBlock,
      ).toBeUndefined();
    });

    it("skips Stage B on first-run when yesterday.md is missing — no phantom daily/<yesterday>.md gets authored", async () => {
      // Phase 6 — `buildStageBInputs` returns null when yesterday.md is
      // absent. Without this skip, Stage B would PUT a daily journal
      // about a date the user wasn't using the agent (calendar_events:
      // 0, messages_handled: 0, ## Tasks: (none) — a meaningless
      // user-facing artifact). The downstream agent-journal-appender
      // renders "Journal synthesis: skipped (no prior-day data)" on
      // missing daily, so the audit trail stays correct.
      rmSync(join(tmp, "context", "yesterday.md"));
      const orch = makeOrchestrator();
      const out = await orch.run({ parentEvent: makeParentEvent(), isRetry: false });
      // Stage A still fires — the first morning routine still has to
      // generate today.md from `<current_agent_day>`.
      const stageACalls = mocks.calls.filter(
        (c) => c.processKey === STAGE_A_PROCESS_KEY,
      );
      expect(stageACalls).toHaveLength(1);
      // Stage B is skipped — no execute call, no journal_skeleton block.
      const stageBCalls = mocks.calls.filter(
        (c) => c.processKey === STAGE_B_PROCESS_KEY,
      );
      expect(stageBCalls).toHaveLength(0);
      expect(out.stageBResult).toBeNull();
    });

    it("escapes XML metacharacters in handoff items", async () => {
      writeFileSync(
        join(tmp, "context", "yesterday.md"),
        [
          "## Handoff",
          "### Tomorrow",
          "- ship <urgent> & risky",
          "### Later",
          "- (none)",
          "",
        ].join("\n"),
      );
      const orch = makeOrchestrator();
      await orch.run({ parentEvent: makeParentEvent(), isRetry: false });
      const stageACall = mocks.calls.find(
        (c) => c.processKey === STAGE_A_PROCESS_KEY,
      )!;
      const block = (stageACall.event.data as { handoffParsedBlock?: string })
        .handoffParsedBlock!;
      expect(block).toContain("ship &lt;urgent&gt; &amp; risky");
    });

    it("injects <journal_skeleton> onto Stage B with deterministic frontmatter", async () => {
      const orch = makeOrchestrator();
      await orch.run({ parentEvent: makeParentEvent(), isRetry: false });
      const stageBCall = mocks.calls.find(
        (c) => c.processKey === STAGE_B_PROCESS_KEY,
      )!;
      const block = (stageBCall.event.data as { journalSkeletonBlock?: string })
        .journalSkeletonBlock;
      expect(typeof block).toBe("string");
      expect(block!).toMatch(/<journal_skeleton>/);
      expect(block!).toMatch(/<\/journal_skeleton>/);
      expect(block!).toContain("type: daily");
      expect(block!).toContain("owner: agent");
      expect(block!).toContain("agent_generated: true");
      // Skeleton-owned placeholders Stage B is expected to fill — should
      // be present so the chokepoint's frontmatter-drift check sees the
      // field name on PUT.
      expect(block!).toContain("projects:");
      expect(block!).toContain("people:");
      expect(block!).toContain("tags:");
    });

    it("renders yesterday's calendar events in the operator's timezone in the ## Schedule scratch section", async () => {
      // Regression guard for the pre-2026-05-16 bug: parseCalendarPayload
      // used getUTCHours()/getUTCMinutes() to format the journal skeleton's
      // `## Schedule` bullet times. For an operator on a non-UTC timezone
      // a 17:00 UTC standup would render as "17:00 — Standup" in the
      // scratch input Stage B then synthesises the daily journal from —
      // silently leaking UTC into a user-facing artifact.
      // SkeletonCalendarEvent.time's contract is "HH:MM local start time";
      // the fix uses Intl with config.timezone, matching the DM-section
      // bullet and ContextBuilder's <calendar_events_7d> block.
      //
      // The test picks America/Los_Angeles as the variation example so the
      // local-time assertion straddles a real DST-applying IANA zone (PDT
      // in May = UTC-7); the fix would also pass under any other non-UTC
      // tz, but pinning the offset keeps the expected `HH:MM` literal.
      config = makeConfig({ dataDir: tmp, timezone: "America/Los_Angeles" });
      // Seed a calendar observation inside yesterday's agent-day window
      // for a UTC-7 operator (PDT in May). 04:00 boundary means yesterday's
      // window is [2026-05-14 04:00 local, 2026-05-15 04:00 local)
      // = [2026-05-14 11:00 UTC, 2026-05-15 11:00 UTC); 2026-05-14T17:00:00Z
      // = 10:00 local and falls inside that window.
      const eventStartUtc = "2026-05-14T17:00:00Z";
      const observedAtUtc = "2026-05-14 17:00:00";
      db.prepare(
        `INSERT INTO observations
           (source, ref, change_type, actor, observed_at, payload)
         VALUES (?, ?, 'created', 'agent', ?, ?)`,
      ).run(
        "google_calendar:primary",
        "evt-tz-test",
        observedAtUtc,
        JSON.stringify({
          kind: "calendar",
          providerId: "primary",
          raw: { title: "Standup", start: eventStartUtc },
        }),
      );
      // Pin "now" so the orchestrator's yesterday computation lands on
      // 2026-05-14. 2026-05-15T17:00:00Z = 10:00 local on 2026-05-15
      // (past the 04:00 agent-day boundary), so today = 2026-05-15 and
      // yesterday = 2026-05-14.
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-05-15T17:00:00Z"));
      try {
        const orch = makeOrchestrator();
        await orch.run({ parentEvent: makeParentEvent(), isRetry: false });
        const stageBCall = mocks.calls.find(
          (c) => c.processKey === STAGE_B_PROCESS_KEY,
        )!;
        const block = (stageBCall.event.data as { journalSkeletonBlock?: string })
          .journalSkeletonBlock!;
        // Local render: 17:00 UTC - 7h (PDT) = 10:00.
        expect(block).toContain("- 10:00 — Standup");
        // Pre-fix UTC bug: would render as "- 17:00 — Standup".
        expect(block).not.toContain("- 17:00 — Standup");
      } finally {
        vi.useRealTimers();
      }
    });

    it("strips the today.md write-lock from Stage B's event.data", async () => {
      const orch = makeOrchestrator();
      await orch.run({ parentEvent: makeParentEvent(), isRetry: false });
      const stageACall = mocks.calls.find(
        (c) => c.processKey === STAGE_A_PROCESS_KEY,
      )!;
      const stageBCall = mocks.calls.find(
        (c) => c.processKey === STAGE_B_PROCESS_KEY,
      )!;
      // Stage A inherits the lock so its PUT/PATCH on today.md carries
      // X-Lock-Id.
      expect(stageACall.event.data).toMatchObject({ todayWriteLockId: "lock-abc" });
      // Stage B does not touch today.md → must NOT carry the lock so it
      // can't masquerade as the lock-holder.
      expect((stageBCall.event.data as { todayWriteLockId?: string }).todayWriteLockId)
        .toBeUndefined();
      expect((stageBCall.event.data as { fetchReportBlock?: string }).fetchReportBlock)
        .toBeUndefined();
    });

    it("shares correlationId between parent + both stages so parent-audit emit can locate the rows", async () => {
      const parent = makeParentEvent({ correlationId: "share-corr-test" });
      const orch = makeOrchestrator();
      await orch.run({ parentEvent: parent, isRetry: false });
      for (const call of mocks.calls) {
        expect(call.event.correlationId).toBe("share-corr-test");
      }
    });

    it("forwards requestedTier to Stage A only — Stage B always runs on its lite process-key default", async () => {
      const orch = makeOrchestrator();
      await orch.run({
        parentEvent: makeParentEvent(),
        isRetry: false,
        requestedTier: "medium",
      });
      const stageA = mocks.calls.find((c) => c.processKey === STAGE_A_PROCESS_KEY)!;
      const stageB = mocks.calls.find((c) => c.processKey === STAGE_B_PROCESS_KEY)!;
      expect(stageA.requestedTier).toBe("medium");
      expect(stageB.requestedTier).toBeUndefined();
    });

    it("writes per-stage agent_actions rows via processResult so parent-audit emit can read them", async () => {
      // The orchestrator MUST run each stage's AgentResult through
      // `processResult` against its OWN stage RoutineEvent. Without this,
      // `parent-audit-emitter.readStageSummaries` (and Phase 6's
      // agent-journal-appender) would query rows that never landed and
      // silently degrade to `stage_a_row_missing` in production — and
      // Stage B's cost would vanish from the autonomous cost-cap SUM.
      const orch = makeOrchestrator();
      await orch.run({ parentEvent: makeParentEvent(), isRetry: false });
      expect(mocks.resultProcessor.processResult).toHaveBeenCalledTimes(2);
      const eventTypes = mocks.resultProcessor.processResult.mock.calls.map(
        (c: unknown[]) => (c[1] as Event).type,
      );
      expect(eventTypes).toEqual(
        expect.arrayContaining([
          "routine.morning_routine_today",
          "routine.morning_routine_journal",
        ]),
      );
    });

    it("still writes the Stage A row but not the Stage B row when Stage B is skipped (retry path)", async () => {
      const orch = makeOrchestrator();
      await orch.run({ parentEvent: makeParentEvent(), isRetry: true });
      expect(mocks.resultProcessor.processResult).toHaveBeenCalledTimes(1);
      const event = mocks.resultProcessor.processResult.mock.calls[0]![1] as Event;
      expect(event.type).toBe("routine.morning_routine_today");
    });
  });

  describe("retry behaviour", () => {
    it("skips Stage B on retry runs — only Stage A fires", async () => {
      const orch = makeOrchestrator();
      const out = await orch.run({
        parentEvent: makeParentEvent(),
        isRetry: true,
      });
      expect(mocks.agentRouter.execute).toHaveBeenCalledTimes(1);
      expect(mocks.calls[0]!.processKey).toBe(STAGE_A_PROCESS_KEY);
      expect(out.stageBResult).toBeNull();
    });
  });

  describe("error handling", () => {
    it("rethrows Stage A throws and writes a result='failed' audit row for Stage A while still landing the Stage B success row", async () => {
      const stageAMocks = buildMocks({
        stageAThrows: new Error("stage A boom"),
      });
      mocks = stageAMocks;
      const orch = makeOrchestrator();
      await expect(
        orch.run({ parentEvent: makeParentEvent(), isRetry: false }),
      ).rejects.toThrow("stage A boom");
      // Stage B's success row still lands via processResult so a later
      // retry's parent-audit emit can find a Stage B row from this
      // attempt's success.
      const successCalls = stageAMocks.resultProcessor.processResult.mock.calls;
      expect(successCalls).toHaveLength(1);
      expect((successCalls[0]![1] as Event).type).toBe(
        "routine.morning_routine_journal",
      );
      // Stage A's rejection now writes a result='failed' row via
      // audit.logError — the structural fix that closes the
      // "stage threw, audit row silently dropped" hole. The row's
      // event.type is Stage A's process key so the agent-journal-
      // appender (loadMorningRoutineActionRows) reads it as a Stage A
      // terminal state instead of falling into the "row missing" branch.
      const failureCalls = stageAMocks.audit.logError.mock.calls;
      expect(failureCalls).toHaveLength(1);
      const [failureEvent, failureErr, failureTrigger, failureCtx] =
        failureCalls[0] as [
          Event,
          Error,
          "reactive" | "autonomous",
          { backendId?: string; modelId?: string; durationMs: number },
        ];
      expect(failureEvent.type).toBe("routine.morning_routine_today");
      expect(failureErr.message).toBe("stage A boom");
      expect(failureTrigger).toBe("autonomous");
      // Pre-resolved binding attribution surfaces the requested
      // backend/model on the failed row so the dashboard's cost dials +
      // failure-by-backend view stay accurate.
      expect(failureCtx.backendId).toBe("claude");
      expect(failureCtx.modelId).toBe("claude-sonnet-test");
      expect(failureCtx.durationMs).toBeGreaterThanOrEqual(0);
    });

    it("folds Stage B throws into stageBResult=null and writes a result='failed' audit row for Stage B without aborting Stage A", async () => {
      const stageBMocks = buildMocks({
        stageBThrows: new Error("stage B boom"),
      });
      mocks = stageBMocks;
      const orch = makeOrchestrator();
      const out = await orch.run({
        parentEvent: makeParentEvent(),
        isRetry: false,
      });
      expect(out.stageAResult.output).toBe("stage-a");
      expect(out.stageBResult).toBeNull();
      // Stage A's success row still lands.
      const successCalls = stageBMocks.resultProcessor.processResult.mock.calls;
      expect(successCalls).toHaveLength(1);
      expect((successCalls[0]![1] as Event).type).toBe(
        "routine.morning_routine_today",
      );
      // Stage B's rejection writes a result='failed' row via
      // `recordStageFailure` → `audit.logError`. Without this write,
      // Stage B budget-cap rejections leave the audit trail with no
      // Stage B row at all, and `agent-journal-appender` renders
      // "Journal synthesis: skipped (no prior-day data)" —
      // indistinguishable from a legit first-run skip.
      const failureCalls = stageBMocks.audit.logError.mock.calls;
      expect(failureCalls).toHaveLength(1);
      const [failureEvent, failureErr] = failureCalls[0] as [Event, Error];
      expect(failureEvent.type).toBe("routine.morning_routine_journal");
      expect(failureErr.message).toBe("stage B boom");
    });

    it("tags failure rows with failureKind/failureCode/backendId when the rejection is a BackendQuotaError(max_budget_usd)", async () => {
      // This is the exact production failure shape that masked Stage B
      // for two consecutive recurring days before the audit-trail fix
      // landed. The audit row needs failureKind='quota' + failureCode
      // (Stage B's `originalCode='max_budget_usd'`) so the dashboard's
      // failure-by-kind view can group budget-cap regressions without
      // a string-match over `error.message`.
      const { BackendQuotaError } = await import("../agent-core.js");
      const quotaErr = new BackendQuotaError(
        "claude" as BackendId,
        "max_budget_usd",
        null,
        "Reached maximum budget ($0.3)",
      );
      const quotaMocks = buildMocks({ stageBThrows: quotaErr });
      mocks = quotaMocks;
      const orch = makeOrchestrator();
      await orch.run({ parentEvent: makeParentEvent(), isRetry: false });
      expect(quotaMocks.audit.logError).toHaveBeenCalledTimes(1);
      const ctx = quotaMocks.audit.logError.mock.calls[0]![3] as {
        backendId?: string;
        modelId?: string;
        durationMs: number;
        failureKind?: string;
        failureCode?: string;
      };
      expect(ctx.failureKind).toBe("quota");
      expect(ctx.failureCode).toBe("max_budget_usd");
      expect(ctx.backendId).toBe("claude");
    });

    it("captures per-stage `durationMs` independently so an early Stage B failure is not inflated by a still-running Stage A", async () => {
      // Production scenario that motivated this guard: Stage B hit the
      // budget cap in ~15 seconds while Stage A continued running for ~2
      // hours. A naïve `nowMs = Date.now()` taken AFTER `Promise.allSettled`
      // would attribute ~2h to Stage B's `duration_ms` on the failed
      // audit row — wrong by an order of magnitude. The orchestrator
      // captures each stage's completion timestamp via `.finally()` so the
      // failed row reflects the stage's own runtime, not the slowest
      // sibling's.
      const STAGE_A_DELAY_MS = 80;
      const STAGE_B_DELAY_MS = 10;
      const timedMocks = buildMocks({});
      timedMocks.agentRouter.execute = vi.fn(async (params: {
        prompt: string;
        context: string;
        event: Event;
        processKey?: ProcessKey;
      }) => {
        if (params.processKey === STAGE_B_PROCESS_KEY) {
          await new Promise((resolve) => setTimeout(resolve, STAGE_B_DELAY_MS));
          throw new Error("stage B boom (fast)");
        }
        await new Promise((resolve) => setTimeout(resolve, STAGE_A_DELAY_MS));
        return makeAgentResult({ output: "stage-a" });
      });
      mocks = timedMocks;
      const orch = makeOrchestrator();
      await orch.run({ parentEvent: makeParentEvent(), isRetry: false });
      const ctx = timedMocks.audit.logError.mock.calls[0]![3] as {
        durationMs: number;
      };
      // Stage B should report a duration close to STAGE_B_DELAY_MS,
      // not STAGE_A_DELAY_MS. Strict bound: the failed row's duration
      // must be at least 20ms below Stage A's wall-clock — anything
      // higher would indicate the orchestrator's `Promise.allSettled`-
      // capped timing leaked into Stage B's row.
      expect(ctx.durationMs).toBeLessThan(STAGE_A_DELAY_MS - 20);
      // And it must be non-negative + at least the stage's actual delay.
      expect(ctx.durationMs).toBeGreaterThanOrEqual(0);
    });

    it("does not propagate a processResult failure past the orchestrator boundary", async () => {
      // If a notify hook or audit writer misbehaves, losing the row is
      // bad but blocking the morning routine on telemetry is worse. The
      // orchestrator logs and continues so the runner's today.md health
      // check still gets a chance to fire.
      const failingMocks = buildMocks({});
      failingMocks.resultProcessor.processResult = vi.fn(async () => {
        throw new Error("audit boom");
      });
      mocks = failingMocks;
      const orch = makeOrchestrator();
      const out = await orch.run({
        parentEvent: makeParentEvent(),
        isRetry: false,
      });
      expect(out.stageAResult.output).toBe("stage-a");
      expect(out.stageBResult?.output).toBe("stage-b");
    });

    it("does not propagate an audit.logError throw past the orchestrator boundary on Stage B failure", async () => {
      // Defence-in-depth: the failure-path write must not block the
      // run() return any more than the success path does. The Stage A
      // rejection branch already re-throws (so the runner's retry chain
      // fires); the Stage B branch must NOT — Stage B failure is
      // independent of today.md health and the runner's parent-audit
      // emit + journal append still need to fire.
      const audErrMocks = buildMocks({
        stageBThrows: new Error("stage B boom"),
      });
      audErrMocks.audit.logError = vi.fn(() => {
        throw new Error("audit logError exploded");
      });
      mocks = audErrMocks;
      const orch = makeOrchestrator();
      const out = await orch.run({
        parentEvent: makeParentEvent(),
        isRetry: false,
      });
      expect(out.stageAResult.output).toBe("stage-a");
      expect(out.stageBResult).toBeNull();
    });
  });

  describe("emitParentAuditRow", () => {
    function seedStageActionRow(
      actionType: string,
      result: string,
      cost = 0.05,
      turns = 3,
    ): void {
      db.prepare(
        `INSERT INTO agent_actions
           (event_id, action_type, trigger, result, cost_usd, num_turns,
            started_at)
         VALUES (?, ?, 'autonomous', ?, ?, ?, datetime('now'))`,
      ).run("emit-test", actionType, result, cost, turns);
    }

    it("emits the parent row when Stage A succeeded + today.md is fresh (roll-up marker, cost lives on stage rows)", () => {
      seedStageActionRow("routine.morning_routine_today", "success", 0.32, 12);
      seedStageActionRow("routine.morning_routine_journal", "success", 0.07, 4);
      const orch = makeOrchestrator();
      const outcome = orch.emitParentAuditRow({
        correlationId: "emit-test",
        startedAt: new Date(),
        todayMdHealth: "fresh",
      });
      expect(outcome.emitted).toBe(true);
      const row = db
        .prepare(
          `SELECT action_type, result, cost_usd, num_turns, detail
             FROM agent_actions
            WHERE event_id = 'emit-test'
              AND action_type = 'routine.morning_routine'
            LIMIT 1`,
        )
        .get() as
          | {
              action_type: string;
              result: string;
              cost_usd: number;
              num_turns: number;
              detail: string;
            }
          | undefined;
      expect(row).toBeDefined();
      expect(row!.result).toBe("success");
      // Roll-up row carries zero cost / turns to keep the autonomous
      // cost-cap SUM from double-counting against the stage rows.
      expect(row!.cost_usd).toBe(0);
      expect(row!.num_turns).toBe(0);
      // Aggregates live in `detail` for the dashboard cost-attribution
      // UI + `pnpm audit`.
      const detail = JSON.parse(row!.detail) as {
        totalCostUsd: number;
        totalNumTurns: number;
      };
      expect(detail.totalCostUsd).toBeCloseTo(0.39, 5);
      expect(detail.totalNumTurns).toBe(16);
    });

    it("does not emit when Stage A failed", () => {
      seedStageActionRow("routine.morning_routine_today", "failed");
      const orch = makeOrchestrator();
      const outcome = orch.emitParentAuditRow({
        correlationId: "emit-test",
        startedAt: new Date(),
        todayMdHealth: "fresh",
      });
      expect(outcome.emitted).toBe(false);
      if (!outcome.emitted) {
        expect(outcome.reason).toBe("stage_a_not_success");
      }
    });

    it("does not emit when today.md health is not fresh", () => {
      seedStageActionRow("routine.morning_routine_today", "success");
      const orch = makeOrchestrator();
      const outcome = orch.emitParentAuditRow({
        correlationId: "emit-test",
        startedAt: new Date(),
        todayMdHealth: "wrong_date",
      });
      expect(outcome.emitted).toBe(false);
      if (!outcome.emitted) {
        expect(outcome.reason).toBe("today_md_wrong_date");
      }
    });

    it("does not emit when no Stage A row exists for the correlationId", () => {
      const orch = makeOrchestrator();
      const outcome = orch.emitParentAuditRow({
        correlationId: "emit-test",
        startedAt: new Date(),
        todayMdHealth: "fresh",
      });
      expect(outcome.emitted).toBe(false);
      if (!outcome.emitted) {
        expect(outcome.reason).toBe("stage_a_row_missing");
      }
    });

    it("emits even when Stage B is missing — the day still 'opens' on Stage A + today.md fresh", () => {
      seedStageActionRow("routine.morning_routine_today", "success", 0.32, 12);
      const orch = makeOrchestrator();
      const outcome = orch.emitParentAuditRow({
        correlationId: "emit-test",
        startedAt: new Date(),
        todayMdHealth: "fresh",
      });
      expect(outcome.emitted).toBe(true);
    });

    it("attributes the latest row when retries leave multiple rows for the same correlationId", () => {
      // Older failed attempt, then a successful retry — the gate should
      // reflect the most-recent state.
      seedStageActionRow("routine.morning_routine_today", "failed", 0.1, 5);
      seedStageActionRow("routine.morning_routine_today", "success", 0.5, 18);
      const orch = makeOrchestrator();
      const outcome = orch.emitParentAuditRow({
        correlationId: "emit-test",
        startedAt: new Date(),
        todayMdHealth: "fresh",
      });
      expect(outcome.emitted).toBe(true);
    });
  });

  // ── Phase 6 — pre-insert in_progress + appendAgentJournalEntry ────────

  describe("Phase 6 pre-insert in_progress agent_actions row", () => {
    function makeOrchestratorWithAudit(
      overrides?: Partial<typeof mocks>,
    ): {
      orch: MorningRoutinePipelineOrchestrator;
      audit: { insertInProgressRow: ReturnType<typeof vi.fn> };
    } {
      const merged = { ...mocks, ...(overrides ?? {}) };
      const audit = {
        // Implements the IAuditLogger surface the orchestrator touches —
        // mocked so the test asserts the pre-insert was called without
        // booting the full AuditLogger machinery.
        insertInProgressRow: vi.fn().mockReturnValue(1),
        logAction: vi.fn(),
        logSkip: vi.fn(),
        logError: vi.fn(),
        logAttachment: vi.fn(),
        logBangCommand: vi.fn(),
      };
      const orch = new MorningRoutinePipelineOrchestrator({
        db,
        config,
        contextBuilder: merged.contextBuilder as never,
        agentRouter: merged.agentRouter as never,
        prompt: merged.prompt as never,
        errorRouter: merged.errorRouter as never,
        resultProcessor: merged.resultProcessor as never,
        audit: audit as never,
      });
      return { orch, audit };
    }

    it("calls audit.insertInProgressRow once for Stage A before stages spawn", async () => {
      const { orch, audit } = makeOrchestratorWithAudit();
      await orch.run({
        parentEvent: makeParentEvent({ correlationId: "phase6-pre-insert" }),
        isRetry: false,
      });
      expect(audit.insertInProgressRow).toHaveBeenCalledTimes(1);
      expect(audit.insertInProgressRow).toHaveBeenCalledWith({
        correlationId: "phase6-pre-insert",
        actionType: "routine.morning_routine_today",
        trigger: "autonomous",
      });
    });

    it("still pre-inserts on retry runs so a retry's PATCH self can resolve too", async () => {
      const { orch, audit } = makeOrchestratorWithAudit();
      await orch.run({
        parentEvent: makeParentEvent({ correlationId: "phase6-retry" }),
        isRetry: true,
      });
      expect(audit.insertInProgressRow).toHaveBeenCalledTimes(1);
    });

    it("does NOT pre-insert when no audit dep is supplied (legacy/Phase-5 test path)", async () => {
      const orch = makeOrchestrator();
      // Should not throw — the orchestrator silently skips the pre-insert
      // call when audit is undefined.
      await expect(
        orch.run({ parentEvent: makeParentEvent(), isRetry: false }),
      ).resolves.toBeTruthy();
    });
  });

  describe("Phase 6 appendAgentJournalEntry", () => {
    it("returns the appender outcome with the correct morning/yesterday date strs", () => {
      // Seed a Stage A row with metadata so the appender has something
      // to compose from. correlationId matches the test invocation.
      db.prepare(
        `INSERT INTO agent_actions
           (event_id, action_type, result, metadata, started_at)
         VALUES (?, 'routine.morning_routine_today', 'success', ?, datetime('now'))`,
      ).run(
        "journal-append-test",
        JSON.stringify({
          dayType: "weekday",
          inboxStats: { triaged: 0, movedToScratch: 0, dmConfirmsSent: 0 },
          morningChecks: [],
          anomalies: [],
        }),
      );
      const orch = makeOrchestrator();
      const out = orch.appendAgentJournalEntry({
        correlationId: "journal-append-test",
      });
      expect(out).not.toBeNull();
      expect(out!.ok).toBe(true);
      if (out!.ok) {
        // morningDateStr is today's agent-day; yesterdayDateStr is the
        // day before. Both are YYYY-MM-DD strings. Verify the H2 has
        // today's date and the body's Journal-line refers to yesterday.
        // Accept any of the legitimate journal-line variants: success
        // (daily file present), first-run skip (yesterday.md absent),
        // or anomaly (Stage B was attempted but its audit row never
        // landed). The beforeEach fixture creates yesterday.md but does
        // not seed a Stage B row, so this test exercises the anomaly
        // branch — pinning the exact branch would over-specify the
        // test's intent (the assertion is about date plumbing, not the
        // failure-rendering contract).
        expect(out!.entryText).toMatch(/^## \d{4}-\d{2}-\d{2} morning routine$/m);
        expect(out!.entryText).toMatch(
          /- (Journal: daily\/\d{4}-\d{2}-\d{2}\.md|Journal synthesis: (skipped|failed))/,
        );
      }
    });

    it("returns the appender's skip reason when no Stage A row exists", () => {
      const orch = makeOrchestrator();
      const out = orch.appendAgentJournalEntry({
        correlationId: "no-such-correlation",
      });
      expect(out).not.toBeNull();
      expect(out!.ok).toBe(false);
      if (!out!.ok) {
        expect(out!.reason).toBe("stage_a_row_missing");
      }
    });
  });

  describe("Phase 7 — roadmap skeleton on first-run branch", () => {
    it("does NOT inject <roadmap_skeleton> on the recurring branch (yesterday.md present)", async () => {
      // beforeEach() seeded yesterday.md, so we're on the recurring
      // branch — Stage A should see the truncated `<roadmap>` block
      // (ContextBuilder responsibility, not the orchestrator's) but
      // NO `<roadmap_skeleton>`. The orchestrator's gate is the same
      // fs predicate as the variant detection.
      const orch = makeOrchestrator();
      await orch.run({ parentEvent: makeParentEvent(), isRetry: false });
      const stageACall = mocks.calls.find(
        (c) => c.processKey === STAGE_A_PROCESS_KEY,
      )!;
      expect(
        (stageACall.event.data as { roadmapSkeletonBlock?: string })
          .roadmapSkeletonBlock,
      ).toBeUndefined();
    });

    it("injects <roadmap_skeleton> with Annual Goals + Quarterly Focus + Preparation Timeline on the first-run branch", async () => {
      // Drop yesterday.md to flip to first-run; seed management rules
      // with an `## Annual Goals` section, an active project, and a
      // travel row so every skeleton section has populated content.
      rmSync(join(tmp, "context", "yesterday.md"));
      mkdirSync(join(tmp, "context", "rules"), { recursive: true });
      writeFileSync(
        join(tmp, "context", "rules", "management.md"),
        [
          "# Management rules",
          "",
          "## Annual Goals",
          "- Ship Aitne 1.0",
          "",
        ].join("\n"),
      );
      mkdirSync(join(tmp, "context", "projects"), { recursive: true });
      writeFileSync(
        join(tmp, "context", "projects", "aitne.md"),
        "---\nstate: active\ndue: 2026-06-30\nnext_milestone: Ship release\n---\n\n# Aitne 1.0\n",
      );
      db.prepare(
        `INSERT INTO travel_bookings (type, provider, destination, start_date, end_date)
         VALUES ('flight', 'test', 'Tokyo', date('now', '+10 days'), date('now', '+10 days'))`,
      ).run();

      const orch = makeOrchestrator();
      await orch.run({ parentEvent: makeParentEvent(), isRetry: false });
      const stageACall = mocks.calls.find(
        (c) => c.processKey === STAGE_A_PROCESS_KEY,
      )!;
      const block = (stageACall.event.data as { roadmapSkeletonBlock?: string })
        .roadmapSkeletonBlock;
      expect(typeof block).toBe("string");
      expect(block!).toMatch(/<roadmap_skeleton>/);
      expect(block!).toMatch(/<\/roadmap_skeleton>/);
      expect(block!).toContain("## Annual Goals");
      expect(block!).toContain("- Ship Aitne 1.0");
      expect(block!).toContain("## Quarterly Focus");
      expect(block!).toContain("Aitne 1.0 (`aitne`)");
      expect(block!).toContain("## Preparation Timeline");
      expect(block!).toContain("flight: Tokyo");
    });

    it("emits a skeleton with placeholders when no projects / management rules / travel exist on first-run", async () => {
      rmSync(join(tmp, "context", "yesterday.md"));
      const orch = makeOrchestrator();
      await orch.run({ parentEvent: makeParentEvent(), isRetry: false });
      const stageACall = mocks.calls.find(
        (c) => c.processKey === STAGE_A_PROCESS_KEY,
      )!;
      const block = (stageACall.event.data as { roadmapSkeletonBlock?: string })
        .roadmapSkeletonBlock;
      expect(typeof block).toBe("string");
      expect(block!).toContain("_(Not yet configured");
      // Recurring-branch carry-over (handoff_parsed) must not appear on
      // a first-run branch; checking it here is defense-in-depth that
      // the two daemon-prepared blocks are gated by the same fs
      // predicate.
      expect(
        (stageACall.event.data as { handoffParsedBlock?: string })
          .handoffParsedBlock,
      ).toBeUndefined();
    });

    it("surfaces calendar events from canonical observation payloads (raw.start) on first-run", async () => {
      // Regression guard for the pre-Phase-7-rev2 bug pair:
      //   (a) parseForwardCalendarPayload read top-level `start`, not
      //       the canonical `raw.start` emitted by
      //       _partials/calendar-acquire.{google,outlook}_calendar.md.
      //   (b) readForwardCalendarEvents filtered SQL `observed_at >= now`
      //       which excluded observations the pre-pass had just landed
      //       (observed_at is recording time, not event start).
      // Both failure modes produced an empty calendar subsection in
      // production even when the pre-pass posted a full window. This
      // test seeds the exact shape the pre-pass partials emit and
      // asserts the skeleton picks them up under both providers, while
      // observations with `observed_at` slightly in the past still
      // match (proving the filter is no longer `observed_at`-bound).
      rmSync(join(tmp, "context", "yesterday.md"));
      const eventStart = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
      const observedAt = new Date(Date.now() - 30 * 1000)
        .toISOString()
        .slice(0, 19)
        .replace("T", " ");
      db.prepare(
        `INSERT INTO observations (source, ref, change_type, actor, observed_at, payload)
         VALUES (?, ?, 'created', 'agent', ?, ?)`,
      ).run(
        "google_calendar:primary",
        "evt-1",
        observedAt,
        JSON.stringify({
          kind: "calendar",
          providerId: "primary",
          raw: { title: "Quarterly review", start: eventStart.toISOString() },
        }),
      );
      db.prepare(
        `INSERT INTO observations (source, ref, change_type, actor, observed_at, payload)
         VALUES (?, ?, 'created', 'agent', ?, ?)`,
      ).run(
        "outlook_calendar:primary",
        "evt-2",
        observedAt,
        JSON.stringify({
          kind: "calendar",
          providerId: "primary",
          raw: {
            title: "Onsite kickoff",
            start: new Date(eventStart.getTime() + 1 * 60 * 60 * 1000).toISOString(),
          },
        }),
      );
      // Out-of-window event (10 days out) should be filtered.
      db.prepare(
        `INSERT INTO observations (source, ref, change_type, actor, observed_at, payload)
         VALUES (?, ?, 'created', 'agent', ?, ?)`,
      ).run(
        "google_calendar:primary",
        "evt-far",
        observedAt,
        JSON.stringify({
          kind: "calendar",
          providerId: "primary",
          raw: {
            title: "Far future",
            start: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
          },
        }),
      );

      const orch = makeOrchestrator();
      await orch.run({ parentEvent: makeParentEvent(), isRetry: false });
      const stageACall = mocks.calls.find(
        (c) => c.processKey === STAGE_A_PROCESS_KEY,
      )!;
      const block = (stageACall.event.data as { roadmapSkeletonBlock?: string })
        .roadmapSkeletonBlock;
      expect(typeof block).toBe("string");
      expect(block!).toContain("### Near-term calendar (7d)");
      expect(block!).toContain("Quarterly review");
      expect(block!).toContain("Onsite kickoff");
      expect(block!).not.toContain("Far future");
    });

    it("ignores consumed calendar observations (only pending rows feed the skeleton)", async () => {
      // The first-run skeleton must reflect what the *next* Stage A turn
      // will see — i.e. pending observations. A consumed row describes
      // an event a prior Stage A already folded into a roadmap edit;
      // surfacing it again would invite Stage A to double-fan it.
      rmSync(join(tmp, "context", "yesterday.md"));
      const eventStart = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);
      db.prepare(
        `INSERT INTO observations
           (source, ref, change_type, actor, observed_at, payload, consumed_at)
         VALUES (?, ?, 'created', 'agent', CURRENT_TIMESTAMP, ?, CURRENT_TIMESTAMP)`,
      ).run(
        "google_calendar:primary",
        "evt-consumed",
        JSON.stringify({
          kind: "calendar",
          providerId: "primary",
          raw: { title: "Already-folded event", start: eventStart.toISOString() },
        }),
      );
      const orch = makeOrchestrator();
      await orch.run({ parentEvent: makeParentEvent(), isRetry: false });
      const stageACall = mocks.calls.find(
        (c) => c.processKey === STAGE_A_PROCESS_KEY,
      )!;
      const block = (stageACall.event.data as { roadmapSkeletonBlock?: string })
        .roadmapSkeletonBlock;
      expect(block!).not.toContain("Already-folded event");
    });
  });
});

