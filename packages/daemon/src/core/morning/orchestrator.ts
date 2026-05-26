/**
 * `MorningRoutinePipelineOrchestrator` — Phase 5 of
 * `docs/design/appendices/morning-routine-optimization.md`. Replaces the
 * single monolithic medium-tier session that today's
 * `MorningRoutineRunner.executeMorningRoutine` runs with a daemon-
 * orchestrated pipeline:
 *
 *     ① rotateDayFiles                          (owned by MorningRoutineRunner)
 *     ② HandoffParser                           (this module)
 *     ③ JournalSkeletonBuilder                  (this module)
 *     ④ Pre-pass fan-out                        (owned by MorningRoutineRunner)
 *     ⑤A Stage A: today.md synthesis  [medium]  (this module)  ─┐ Promise.all
 *     ⑤B Stage B: daily journal author [lite]   (this module)  ─┘
 *     ⑥  AgentJournalAppender                   (Phase 6 — left to MorningRoutineRunner)
 *     ⑥b parent audit row emit                  (this module)
 *     ⑦  diagnoseTodayMdState                   (owned by MorningRoutineRunner)
 *     ⑧  Post-morning catchups + roadmap_refresh (owned by MorningRoutineRunner)
 *
 * The orchestrator owns only ②③⑤A∥⑤B⑥b. ① and ④ are upstream of `run()`;
 * ⑥, ⑦, ⑧ stay with the runner so the existing today.md health check /
 * retry chain / catchups continue to work unchanged on both legacy and
 * V2 paths.
 *
 * Stage event design:
 *   - Stage A event.type = `routine.morning_routine_today` so its
 *     `agent_actions` row lands with `action_type='routine.morning_routine_today'`
 *     (the audit logger derives action_type from `event.type`). Stage A's
 *     `routine` field stays `"morning_routine"` so ContextBuilder's
 *     existing heavy-context branch fires (yesterday.md / roadmap.md /
 *     active_projects / calendar_events_7d).
 *   - Stage B event.type = `routine.morning_routine_journal`. Stage B's
 *     `routine` field is `"morning_routine_journal"` so ContextBuilder
 *     fires the minimal Stage-B branch added in Phase 5 (calendar_events_7d
 *     for wikilink resolution; no yesterday / roadmap / projects).
 *   - Both stage events share `correlationId` with the parent
 *     `routine.morning_routine` envelope — `loadMorningRoutineActionRows`
 *     and `emitMorningRoutineParentAuditRow` use that as `event_id` to
 *     correlate.
 *
 * Today.md write-lock: Stage A inherits the lockId set on the parent
 * event by `MorningRoutineRunner` (the lock is acquired before this
 * runs and released after); Stage B does not write to today.md and
 * does not receive the lockId.
 *
 * Retry semantics (rev2 — `morning-routine-optimization.md`
 * §"Pipeline-level invariants"):
 *   - The retry chain is gated on today.md health; only Stage A regen
 *     is what fixes a missing / wrong-date today.md. On retry,
 *     `inputs.isRetry` is true and Stage B is NOT re-fired. Phase 5
 *     simplification: if Stage B succeeded on attempt 1, its
 *     `daily/<yesterday>.md` is already on disk and re-firing would
 *     hit the 200/PATCH-Agent-revision path, producing a second
 *     journal entry on every retry; if Stage B failed on attempt 1,
 *     re-firing would still risk that duplication once the next
 *     scheduled write succeeds. The trade-off is documented in design
 *     §"Retry semantics" — Phase 6 may revisit if structured Stage B
 *     result tracking justifies the work.
 *
 * Pre-pass skip on retry: not enforced here because `MorningRoutineRunner`
 * already short-circuits the pre-pass when `isRetry === true`. The
 * pre-pass result lives on the parent event's `event.data.fetchReportBlock`
 * and is forwarded into the Stage A event unchanged (Stage B does not
 * consume it).
 */

import type Database from "better-sqlite3";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  EventPriority,
  getAgentDayBoundsUtc,
  getAgentDayDateStr,
  type AgentResult,
  type BackendId,
  type Event,
  type ProcessKey,
  type RoutineEvent,
} from "@aitne/shared";
import type { AgentConfig } from "../../config.js";
import { getContextDir } from "../../config.js";
import type {
  IAuditLogger,
  IContextBuilder,
} from "../dispatcher-types.js";
import type { PromptAssembler } from "../dispatcher-prompt.js";
import {
  BackendRouterHandledError,
  type IAgentRouter,
  type ResolvedBackendRoute,
} from "../backends/backend-router.js";
import { BackendQuotaError } from "../agent-core.js";
import type { DispatcherErrorRouter } from "../dispatcher-error-handling.js";
import type { ResultProcessor } from "../dispatcher-result-processor.js";
import type { AgentWriteTracker } from "../../safety/agent-write-tracker.js";
import { parseHandoff, type HandoffParsed } from "./handoff-parser.js";
import {
  buildJournalSkeleton,
  gatherJournalSkeletonFacts,
  type JournalSkeletonInputs,
  type SkeletonCalendarEvent,
} from "./journal-skeleton-builder.js";
import {
  buildRoadmapSkeleton,
  gatherRoadmapSkeletonFacts,
  type RoadmapSkeletonCalendarEvent,
} from "./roadmap-skeleton-builder.js";
import {
  emitMorningRoutineParentAuditRow,
  type ParentAuditEmitResult,
  type StageActionResult,
  type StageSummary,
  type TodayMdHealth,
} from "./parent-audit-emitter.js";
import {
  appendMorningRoutineJournalEntry,
  STAGE_A_ACTION_TYPE,
  STAGE_B_ACTION_TYPE,
  type AgentJournalAppenderResult,
} from "./agent-journal-appender.js";
import type {
  DailyJournalComposeResult,
  DailyJournalComposer,
} from "./daily-journal-composer.js";
import type { DailyWriteAuditDetail } from "../dispatcher-types.js";
import {
  maybeEmitPartialExtractStreakDm,
  type PartialExtractStreakNotifier,
} from "./partial-extract-streak.js";
import { readIntegrationState } from "../../db/integrations-store.js";
import {
  buildPreMorningDigest,
  renderPreMorningDigestMarkdown,
} from "../../services/browser-history/pipeline/pre-morning-digest.js";
import { createLogger } from "../../logging.js";

const logger = createLogger("morning-pipeline-orchestrator");

const STAGE_A_PROCESS_KEY: ProcessKey = "routine.morning_routine_today";
const STAGE_B_PROCESS_KEY: ProcessKey = "routine.morning_routine_journal";

/**
 * The `routine` slug carried on each stage's RoutineEvent. Stage A reuses
 * the legacy `"morning_routine"` value so the heavy ContextBuilder branch
 * (yesterday.md / roadmap.md / active_projects / calendar_events_7d)
 * continues to fire unchanged — the Phase 5 split is about dispatch
 * shape, not Stage A's context inputs. Stage B's
 * `"morning_routine_journal"` slug routes into the minimal branch added
 * to ContextBuilder for Phase 5.
 */
const STAGE_A_ROUTINE_SLUG = "morning_routine";
const STAGE_B_ROUTINE_SLUG = "morning_routine_journal";

export interface MorningPipelineOrchestratorDeps {
  db: Database.Database;
  config: AgentConfig;
  contextBuilder: IContextBuilder;
  agentRouter: IAgentRouter;
  prompt: PromptAssembler;
  errorRouter: DispatcherErrorRouter;
  resultProcessor: ResultProcessor;
  /**
   * morning-routine-optimization.md Phase 6 — pre-insert an
   * `agent_actions(result='in_progress', action_type='routine.morning_routine_today')`
   * row before Stage A spawns so the agent's
   * `PATCH /api/agent-actions/self` can resolve and write its structured
   * metadata side-channel. Optional so Phase 5 tests that don't exercise
   * the metadata pathway can construct the orchestrator without an
   * `IAuditLogger` mock. Production wiring always supplies it.
   */
  audit?: IAuditLogger;
  /**
   * morning-routine-optimization.md Phase 6 — ⑥ AgentJournalAppender
   * needs the safety write-tracker so the journal's atomic write does
   * not get tagged as a user-actor change by the obsidian / git
   * observers (which would re-trigger the hourly check on the agent's
   * own output). The context-index reconciler is intentionally NOT
   * threaded here: `journal/agent.md` is not in the indexable set, so
   * the chokidar fallback path covers it without an explicit hint.
   */
  writeTracker?: AgentWriteTracker;
  /**
   * daily-journal-daemon-write.md §4.11 — Stage B's daily journal
   * compose step. The orchestrator invokes the composer AFTER
   * `Promise.allSettled` settles both stages and BEFORE
   * `persistStageAuditRows` so the compose outcome lands on the same
   * INSERT/UPSERT as the Stage B audit row (`detail.dailyWrite`).
   *
   * Optional so the Phase 5 test fixtures that don't exercise the
   * daily-write path can construct the orchestrator without a real
   * composer. Production wiring always supplies it; when omitted the
   * orchestrator skips the compose call entirely (Stage B's audit row
   * lands without `detail.dailyWrite` and `agent-journal-appender`
   * falls back to the file-presence heuristic).
   */
  dailyJournalComposer?: DailyJournalComposer;
  /**
   * daily-journal-daemon-write.md §4.7b — owner-DM emitter the
   * partial-extract streak detector uses. The orchestrator passes the
   * existing `sendNotification` chain via a thin adapter so the
   * detector doesn't depend on Hono / messaging adapters directly.
   * Optional: when omitted the streak detector still runs (SQL is
   * cheap, the result is logged), but no DM is emitted.
   */
  partialExtractStreakNotifier?: PartialExtractStreakNotifier;
}

export interface MorningPipelineRunInputs {
  /**
   * The parent `routine.morning_routine` event. Its `correlationId` is
   * the link parent-audit-emitter uses to find both stages' agent_actions
   * rows; `data.fetchReportBlock` (pre-pass output) and
   * `data.todayWriteLockId` (today.md lock from the runner) are
   * forwarded to Stage A verbatim.
   */
  parentEvent: Event;
  /**
   * Mirrors `MorningRoutineRunner`'s `isRetry` derivation. When true,
   * Stage B is skipped (see §"Retry semantics" in the module JSDoc).
   */
  isRetry: boolean;
  /**
   * When set, both stages' `resolveBinding` calls receive this as
   * `requestedTier`. `MorningRoutineRunner` forces `"medium"` on retry;
   * the orchestrator forwards verbatim so Stage A's cost-cap-fix
   * downgrade behaviour is preserved. Stage B ignores the override —
   * it always runs on lite per `routine.morning_routine_journal`'s
   * process-key default. (Forcing Stage B to medium on retry would
   * defeat the whole point of the split, and the journal author has
   * no failure mode that medium would fix.)
   */
  requestedTier?: "lite" | "medium" | "high";
}

export interface MorningPipelineRunResult {
  /**
   * Stage A's `AgentResult`. `MorningRoutineRunner.processResult` is
   * invoked on this so today.md health checks / drift / cost telemetry
   * follow the same path as the legacy monolithic session.
   */
  stageAResult: AgentResult;
  /**
   * Stage B's `AgentResult`, or `null` when Stage B was skipped (retry
   * path) or its session threw before producing a result. Stage B
   * failure does not block the pipeline — the journal author is
   * independent of today.md health, so its absence surfaces only in
   * the parent audit row's `detail.stageB` field.
   */
  stageBResult: AgentResult | null;
  /**
   * Snapshot of `Date.now()` taken when `run()` is first invoked. Used
   * by `MorningRoutineRunner` as the parent audit row's `started_at`
   * when it later calls `emitParentAuditRow`.
   */
  startedAt: Date;
}

export class MorningRoutinePipelineOrchestrator {
  constructor(private readonly deps: MorningPipelineOrchestratorDeps) {}

  /**
   * Drive ②③⑤A∥⑤B. The caller (`MorningRoutineRunner`) is responsible
   * for invoking ⑦ (today.md health diagnose) and ⑥b (parent audit
   * emit, via `emitParentAuditRow`) afterwards.
   *
   * Errors:
   *   - Stage A throw → re-thrown so the runner's outer try/finally
   *     (lock release + flag reset) still fires, and the runner's
   *     `diagnoseTodayMdState` post-check catches the missing today.md
   *     and schedules a retry the same way legacy failures do.
   *   - Stage B throw → logged + folded into `stageBResult=null`. Does
   *     NOT propagate; Stage B failure is independent of today.md
   *     health (the day still opens, the journal is best-effort).
   */
  async run(inputs: MorningPipelineRunInputs): Promise<MorningPipelineRunResult> {
    const startedAt = new Date();
    const parentEvent = inputs.parentEvent;
    const correlationId = parentEvent.correlationId;

    // ② HandoffParser — read yesterday.md, parse `## Handoff`, render the
    // `<handoff_parsed>` XML block. Fail-soft per design §"Data-flow
    // principle": when parsing returns null (no file, malformed section)
    // the orchestrator omits the block and Stage A's task-flow falls
    // back to reading `<yesterday>` raw — one extra Stage A turn at most.
    const handoffParsedBlock = this.buildHandoffParsedBlock();

    // ③ JournalSkeletonBuilder — deterministic frontmatter +
    // pre-aggregated facts for yesterday's daily journal. Skipped on
    // retry per `morning-routine-optimization.md` rev4
    // §"Pipeline-level invariants → Retry semantics": Stage B is not
    // re-fired on retry (its prior-attempt PUT is preserved to avoid
    // double-authoring the daily file), so building the skeleton would
    // do work with no consumer. The builder itself remains idempotent
    // — re-enabling Stage B on retry would require no skeleton change.
    const stageBInputs = inputs.isRetry
      ? null
      : this.buildStageBInputs();

    // morning-routine-optimization.md Phase 7 — daemon-prepared roadmap
    // skeleton for the first-run (no-yesterday) branch. The legacy
    // `routine.morning_routine_initial` high-tier session paid for an
    // Opus turn to generate this from scratch; the medium-tier Stage A
    // can spot-edit a deterministic skeleton into roadmap.md via the
    // same `roadmap` skill PATCH paths the recurring branch uses. Only
    // emitted on the first-run branch (yesterday.md absent) — the
    // recurring branch leaves the block off and Stage A reads the
    // truncated `<roadmap>` ContextBuilder injects as usual.
    const roadmapSkeletonBlock = this.buildRoadmapSkeletonBlock();

    // ⑤A + ⑤B — Promise.allSettled so a Stage B throw does not abort
    // Stage A. (Promise.all would; Stage A's result is what gates the
    // morning routine's success, so we always want to surface it.)
    const stageAEvent = this.composeStageAEvent(
      parentEvent,
      correlationId,
      handoffParsedBlock,
      roadmapSkeletonBlock,
    );
    const stageBEvent = stageBInputs === null
      ? null
      : this.composeStageBEvent(
          parentEvent,
          correlationId,
          stageBInputs.block,
          stageBInputs.yesterdayDateStr,
        );

    // Pre-resolve each stage's binding up front so the failure-path
    // handler below can attribute the `result='failed'` row to the
    // requested backend / model — `BackendQuotaError.backendId` covers
    // the quota case, but other rejection shapes (context build error,
    // an unrelated SDK throw) carry no binding info on the error itself.
    // Resolving once at the top also matches the pattern `runStageA/B`
    // already uses internally and keeps the binding observable from this
    // scope. Wrapped in try/catch so a resolver throw still falls through
    // to the stage dispatch (which would re-throw the same error and let
    // the rejection path persist a failed row with a null binding).
    const stageABinding = this.safeResolveBinding(
      stageAEvent,
      STAGE_A_PROCESS_KEY,
      inputs.requestedTier,
    );
    const stageBBinding = stageBEvent === null
      ? null
      : this.safeResolveBinding(stageBEvent, STAGE_B_PROCESS_KEY);

    // morning-routine-optimization.md Phase 6 — pre-insert the
    // `result='in_progress'` sentinel for Stage A so the agent's
    // `PATCH /api/agent-actions/self` resolves to a real row during the
    // run. The eventual `logAction` / `logError` call from
    // `persistStageAuditRows` settles the same row (UPSERT path in
    // `audit.ts`), preserving the metadata column the agent wrote.
    // Stage B does NOT call PATCH self (it has no `agent-actions` skill
    // in its policy set), so it gets no pre-insert.
    this.preInsertStageAInProgressRow(correlationId);

    // Capture per-stage timing INSIDE each promise so the failure path
    // can backdate `started_at` honestly. A naïve `nowMs = Date.now()`
    // taken AFTER `Promise.allSettled` returns would attribute Stage A's
    // ~2h wall-clock to Stage B's `duration_ms` whenever Stage B
    // finished early (e.g. 15s budget-cap failure followed by Stage A
    // grinding for hours), inflating the failed row's reported runtime
    // by an order of magnitude. `.finally()` captures the per-stage
    // settle moment without altering the propagated value/reason that
    // `Promise.allSettled` sees.
    const stageAStartedAtMs = Date.now();
    const stageBStartedAtMs = Date.now();
    let stageACompletedAtMs = stageAStartedAtMs;
    let stageBCompletedAtMs = stageBStartedAtMs;

    const [stageA, stageB] = await Promise.allSettled([
      this.runStageA(stageAEvent, inputs.requestedTier, stageABinding)
        .finally(() => { stageACompletedAtMs = Date.now(); }),
      stageBEvent === null || stageBBinding === null
        ? Promise.resolve<AgentResult | null>(null)
        : this.runStageB(stageBEvent, stageBBinding)
            .finally(() => { stageBCompletedAtMs = Date.now(); }),
    ]);

    // daily-journal-daemon-write.md §4.11 — invoke the daemon-side
    // daily-journal composer BEFORE persistStageAuditRows so the
    // compose outcome lands on the same INSERT/UPSERT as the Stage B
    // row's terminal result (no post-UPDATE race). When the composer
    // dep is absent (Phase 5 test fixtures) or Stage B wasn't
    // dispatched (retry path / first-run skip), we skip the call and
    // the audit row lands without `detail.dailyWrite` — the appender
    // falls back to file-presence detection in that case.
    const stageBResultIfFulfilledForCompose =
      stageB.status === "fulfilled" ? stageB.value : null;
    const dailyComposeOutcome = await this.composeDailyJournalIfPossible({
      correlationId,
      stageBEvent,
      stageBInputs,
      stageBResult: stageBResultIfFulfilledForCompose,
    });

    // Land Stage A / Stage B `agent_actions` rows BEFORE deciding whether
    // to re-throw on Stage A failure. The rows are what
    // `parent-audit-emitter.readStageSummaries` reads via SQL, what the
    // autonomous-cost-cap SUM aggregates over, and what
    // `agent-journal-appender` (Phase 6) template-fills from. Without
    // this call the orchestrator's parent-audit emit silently degrades to
    // `stage_a_row_missing` in production and Stage B's cost is dropped
    // from the budget tracker.
    //
    // We deliberately call this even when Stage A failed: Stage B's
    // result may exist and its row is still meaningful (parent-audit emit
    // won't fire on this attempt because Stage A failed, but a retry's
    // emit will read Stage B's prior-attempt row).
    //
    // Success path → `processResult` (which calls `audit.logAction`,
    // settling the in_progress sentinel row to `success`).
    // Failure path → `audit.logError` (which UPSERTs the same in_progress
    // sentinel to `result='failed'`, preserving any agent-side
    // `PATCH /api/agent-actions/self` metadata writes that landed before
    // the throw). The failure-path write is what closes the
    // "Stage B threw and audit was silently dropped" hole that masked
    // Stage B budget-cap failures as `Journal synthesis: skipped (no
    // prior-day data)` — indistinguishable from a legit first-run skip.
    // Routine events are silent-by-default in `shouldNotify`, so no
    // user-facing notify side effect fires on either path.
    const stageBResultIfFulfilled =
      stageB.status === "fulfilled" ? stageB.value : null;
    await this.persistStageAuditRows({
      stageA: {
        event: stageAEvent,
        binding: stageABinding,
        startedAtMs: stageAStartedAtMs,
        completedAtMs: stageACompletedAtMs,
        ...(stageA.status === "fulfilled"
          ? { result: stageA.value }
          : { error: stageA.reason }),
      },
      stageB: stageBEvent === null
        ? null
        : {
            event: stageBEvent,
            binding: stageBBinding,
            startedAtMs: stageBStartedAtMs,
            completedAtMs: stageBCompletedAtMs,
            // §4.11 — plumb the dailyWrite outcome onto the Stage B
            // outcome so persistStageAuditRows can include it in the
            // single INSERT/UPSERT that lands the row.
            ...(dailyComposeOutcome
              ? { dailyWrite: toDailyWriteAuditDetail(dailyComposeOutcome) }
              : {}),
            ...(stageB.status === "fulfilled"
              ? { result: stageBResultIfFulfilled }
              : { error: stageB.reason }),
          },
    });

    // §4.7b — after the Stage B row has landed (so its just-written
    // `detail.dailyWrite` is visible to the streak query), check for
    // a 3-day all-partial streak and emit the owner DM (subject to
    // the 24h dedup window). Runs only when Stage B was attempted on
    // this morning; first-run / retry skips don't add a row and the
    // SQL filter excludes them naturally.
    if (dailyComposeOutcome !== null) {
      try {
        await maybeEmitPartialExtractStreakDm({
          db: this.deps.db,
          correlationId,
          notifier: this.deps.partialExtractStreakNotifier ?? null,
        });
      } catch (err) {
        logger.warn(
          { err, correlationId },
          "Partial-extract streak check threw — continuing",
        );
      }
    }

    if (stageA.status === "rejected") {
      // Re-throw so the runner's existing finally / retry path fires.
      // Log enough context that the operator can confirm the V2 path
      // was active when the throw happened — the runner-side log will
      // also fire from its own catch.
      logger.error(
        {
          err: stageA.reason,
          correlationId,
          stageB: stageB.status,
        },
        "Stage A threw — propagating to MorningRoutineRunner",
      );
      throw stageA.reason;
    }

    if (stageB.status === "rejected") {
      logger.warn(
        { err: stageB.reason, correlationId },
        "Stage B threw — folding into stageBResult=null; today.md health gates parent audit independently",
      );
    }

    return {
      stageAResult: stageA.value,
      stageBResult: stageBResultIfFulfilled,
      startedAt,
    };
  }

  /**
   * Wrap `agentRouter.resolveBinding` so a resolver-side throw (e.g. a
   * malformed `process_backend_config` row) doesn't abort the whole
   * `run()` before either stage gets a chance to dispatch. A null
   * binding signals "binding unknown" to the failure-path writer; the
   * resulting `agent_actions(result='failed')` row will lack the
   * backend / model columns but still pin the failure to a known
   * stage event. The stage's own `runStage*` will re-throw the same
   * resolution error on dispatch and that's what
   * `persistStageAuditRows` records.
   */
  private safeResolveBinding(
    event: RoutineEvent,
    processKey: ProcessKey,
    requestedTier?: MorningPipelineRunInputs["requestedTier"],
  ): ResolvedBackendRoute | null {
    try {
      return this.deps.agentRouter.resolveBinding(event, {
        processKey,
        ...(requestedTier ? { requestedTier } : {}),
      });
    } catch (err) {
      logger.warn(
        { err, processKey, correlationId: event.correlationId },
        "resolveBinding threw at the orchestrator's pre-resolve site — falling back to null binding",
      );
      return null;
    }
  }

  /**
   * Write per-stage `agent_actions` rows for both success and failure
   * outcomes. Each stage's row lands keyed on its OWN `RoutineEvent`
   * (carrying the stage's process-key event type), so the row's
   * `action_type` is `routine.morning_routine_today` /
   * `routine.morning_routine_journal` — exactly what
   * `parent-audit-emitter.readStageSummaries` and the Phase 6
   * `agent-journal-appender` will read.
   *
   * Success path → `processResult` (which calls `audit.logAction`,
   * settling the in_progress sentinel row to `result='success'`).
   *
   * Failure path → `audit.logError` (which UPSERTs the same in_progress
   * sentinel to `result='failed'`, preserving the agent-side metadata
   * column intact). Without the failure-path write, Stage B rejections
   * (most commonly `BackendQuotaError(max_budget_usd)` from a tight
   * lite-tier envelope) leave the audit trail with NO Stage B row at
   * all — `agent-journal-appender.formatJournalLine` then falls into
   * the `stageB === null` branch and renders `Journal synthesis:
   * skipped (no prior-day data)`, indistinguishable from a legitimate
   * first-run skip. This is the structural bug the failure-path write
   * closes.
   *
   * Failures inside `processResult` or `audit.logError` do NOT
   * propagate — losing audit rows is bad, but blocking the entire
   * morning routine on a downstream telemetry hiccup is worse. In
   * practice `audit.logAction` / `audit.logError` already swallow their
   * own DB errors with an internal logger.error, so the catches here
   * are defence-in-depth guards against non-audit hooks (notify side
   * effects we don't expect for routine events but might land later).
   *
   * Tail-risk acknowledgement: if a stage row truly fails to land
   * (audit's internal try/catch swallowed a real SQLite error AND
   * `processResult`'s notification path threw too), the parent-audit
   * emitter will return `stage_a_row_missing` and the pre-routine gate
   * stays unfired for the day — that day's hourly_check / evening_review
   * are skipped with `morning_routine_pending_for_today`, but
   * `MAX_RETRIES`-bounded `scheduleMorningRetry` does NOT loop on this
   * shape because today.md health is independent. The day's automation
   * degrades silently for that day; it does not infinite-loop.
   */
  private async persistStageAuditRows(args: {
    stageA: StageOutcome;
    stageB: StageOutcome | null;
  }): Promise<void> {
    const tasks: Array<Promise<void>> = [];
    const outcomes: ReadonlyArray<{ label: "A" | "B"; outcome: StageOutcome }> = [
      { label: "A", outcome: args.stageA },
      ...(args.stageB === null
        ? []
        : [{ label: "B" as const, outcome: args.stageB }]),
    ];
    for (const { label, outcome } of outcomes) {
      if ("result" in outcome && outcome.result !== null) {
        tasks.push(
          this.deps.resultProcessor
            .processResult(outcome.result, outcome.event, false, {
              // Thread dailyWrite into the result-processor's options
              // so its `audit.logAction` call lands `detail.dailyWrite`
              // on the same INSERT/UPSERT as the row's terminal result.
              ...(outcome.dailyWrite ? { dailyWrite: outcome.dailyWrite } : {}),
            })
            .catch((err) => {
              logger.warn(
                { err, correlationId: outcome.event.correlationId, stage: label },
                `Stage ${label} processResult failed — audit row may be missing`,
              );
            }),
        );
      } else if ("error" in outcome) {
        tasks.push(
          this.recordStageFailure(outcome).catch((err) => {
            logger.warn(
              { err, correlationId: outcome.event.correlationId, stage: label },
              `Stage ${label} recordStageFailure threw — audit row may be missing`,
            );
          }),
        );
      }
      // "result" in outcome with `result === null` is the Stage B
      // first-run skip path: no execute call, no audit row to write.
    }
    if (tasks.length > 0) {
      await Promise.all(tasks);
    }
  }

  /**
   * Write a `result='failed'` agent_actions row for a rejected stage.
   * Uses `audit.logError`, which UPSERTs the matching in_progress
   * sentinel row when one exists (Stage A's pre-insert) and INSERTs a
   * fresh row otherwise (Stage B). Both paths land a terminal-state
   * row keyed on `(event_id=correlationId, action_type=event.type)` so
   * the downstream readers — `loadMorningRoutineActionRows`,
   * `parent-audit-emitter.readStageSummaries`,
   * `agent-journal-appender.formatJournalLine` — see one consistent
   * shape per stage regardless of which terminal state the stage
   * reached.
   *
   * Backend / model attribution: pulled from the pre-resolved binding
   * when available, with a fallback to `BackendQuotaError.backendId`
   * if the binding was unresolvable but the error happens to carry
   * that field. Other failure shapes leave backend/model unset; the
   * audit logger's `context` schema tolerates absent values.
   */
  private async recordStageFailure(outcome: StageFailureOutcome): Promise<void> {
    if (this.deps.audit === undefined) return;
    const error = outcome.error instanceof Error
      ? outcome.error
      : new Error(String(outcome.error ?? "stage rejection with no message"));
    const durationMs = Math.max(0, outcome.completedAtMs - outcome.startedAtMs);
    const quotaError = extractQuotaError(outcome.error);
    const context: {
      durationMs: number;
      backendId?: BackendId;
      modelId?: string;
      failureKind?: string;
      failureCode?: string;
      dailyWrite?: DailyWriteAuditDetail;
    } = { durationMs };
    const backendId =
      outcome.binding?.main.backendId ?? quotaError?.backendId ?? undefined;
    const modelId = outcome.binding?.main.modelId ?? undefined;
    if (backendId !== undefined) context.backendId = backendId;
    if (modelId !== undefined) context.modelId = modelId;
    if (quotaError !== null) {
      context.failureKind = "quota";
      context.failureCode = quotaError.originalCode;
    }
    // §4.11 — Stage B's failure-path row also carries the dailyWrite
    // outcome when one was computed. Useful for the streak detector
    // when Stage B threw but `composeDailyJournalIfPossible` was
    // dispatched anyway (e.g. session crashed AFTER emitting valid
    // body / frontmatter tags in its final text — uncommon but
    // representable).
    if (outcome.dailyWrite) {
      context.dailyWrite = outcome.dailyWrite;
    }
    // Morning routine fires from cron — never reactive — same trigger
    // shape as `preInsertStageAInProgressRow`. Keeping the trigger value
    // consistent with the pre-insert row also keeps the UPSERT idempotent
    // (Stage A's in_progress row has `trigger='autonomous'`; we don't
    // want the UPSERT to flip it).
    this.deps.audit.logError(outcome.event, error, "autonomous", context);
  }

  /**
   * daily-journal-daemon-write.md §4.11 — invoke the daily-journal
   * composer when (a) the orchestrator has a composer dep, (b) Stage B
   * was actually dispatched (event built), and (c) `buildStageBInputs`
   * produced the skeleton facts the composer needs. Otherwise return
   * `null` and let the appender fall back to file-presence detection.
   *
   * Reuses the SAME skeleton + counts cached on `stageBInputs` (the
   * exact byte stream Stage B's prompt saw) rather than re-deriving
   * against the live DB. Re-deriving was the previous behaviour and
   * introduced a drift class: if a new DM or calendar observation
   * landed during Stage A's wall-clock window, the LLM authored against
   * Skeleton-V1 while the daemon wrote Skeleton-V2 frontmatter; ditto
   * `updated:` if the agent day rolled over between the two reads.
   *
   * Stage B's `AgentResult` may be `null` even when the event was
   * dispatched (the SDK threw mid-stream); the composer handles that
   * explicitly via its `stage_b_null` reason.
   */
  private async composeDailyJournalIfPossible(args: {
    correlationId: string;
    stageBEvent: RoutineEvent | null;
    stageBInputs: StageBInputs | null;
    stageBResult: AgentResult | null;
  }): Promise<DailyJournalComposeResult | null> {
    if (this.deps.dailyJournalComposer === undefined) return null;
    if (args.stageBEvent === null) return null;
    if (args.stageBInputs === null) return null;
    try {
      const outcome = await this.deps.dailyJournalComposer.compose({
        correlationId: args.correlationId,
        yesterdayDateStr: args.stageBInputs.yesterdayDateStr,
        skeleton: args.stageBInputs.skeleton,
        calendarEvents: args.stageBInputs.calendarEventsCount,
        messagesHandled: args.stageBInputs.messagesHandled,
        stageBResult: args.stageBResult,
      });
      return outcome;
    } catch (err) {
      // The composer's own try/catch returns `ok: false, reason:
      // "write_failed"` for write errors — anything that escapes is a
      // construction bug. Surface it as a structured `write_failed`
      // outcome so the audit row still carries a discriminated reason
      // rather than going silent.
      logger.error(
        { err, correlationId: args.correlationId },
        "Daily journal composer threw past its own catch — recording as write_failed",
      );
      return { ok: false, reason: "write_failed" };
    }
  }

  /**
   * ⑥b parent audit emit — the row keyed `action_type='routine.morning_routine'`
   * that `morningRoutineRanToday` in `schedule-helpers.ts` SELECTs on.
   * Called by `MorningRoutineRunner` AFTER its `diagnoseTodayMdState`
   * verdict so the today.md health gate is enforced; gated also on
   * Stage A success (Stage B success is recorded in `detail` but does
   * NOT block — the day still "opened" if today.md is good).
   *
   * Reads agent_actions rows by correlationId to get authoritative
   * `cost_usd` / `num_turns` / `result` for each stage — handles the
   * case where one stage's `AgentResult` is in memory and the other
   * is null (Stage B was skipped on retry) without an
   * impedance-mismatch shim.
   */
  emitParentAuditRow(args: {
    correlationId: string;
    startedAt: Date;
    todayMdHealth: TodayMdHealth;
    backend?: BackendId;
  }): ParentAuditEmitResult {
    const stages = this.readStageSummaries(args.correlationId);
    return emitMorningRoutineParentAuditRow(this.deps.db, {
      correlationId: args.correlationId,
      stageA: stages.stageA,
      stageB: stages.stageB,
      todayMdHealth: args.todayMdHealth,
      startedAt: args.startedAt,
      completedAt: new Date(),
      ...(args.backend ? { backend: args.backend } : {}),
    });
  }

  /**
   * morning-routine-optimization.md Phase 6 — ⑥ AgentJournalAppender.
   * Assembles the one-paragraph English audit-trail entry for
   * `journal/agent.md` from `agent_actions` rows (stage results +
   * the metadata column Stage A wrote via `PATCH /api/agent-actions/self`)
   * plus `daily/<yesterday>.md` frontmatter. No LLM final-text parsing.
   *
   * Called by `MorningRoutineRunner` AFTER both stage rows have settled
   * (so `loadMorningRoutineActionRows` sees terminal `result` + the
   * agent-supplied metadata) and BEFORE `emitParentAuditRow` so the
   * journal block is on disk by the time the pre-routine gate fires.
   *
   * Returns the appender's structured outcome so the runner can log the
   * skip reason (e.g. `stage_a_row_missing` when the Stage A audit row
   * never landed) without grepping the file. Returns `null` when the
   * orchestrator was constructed without the deps the appender needs
   * (Phase 5-only test fixtures) — caller treats `null` as a no-op.
   */
  async appendAgentJournalEntry(args: {
    correlationId: string;
  }): Promise<AgentJournalAppenderResult | null> {
    const contextDir = getContextDir(this.deps.config, this.deps.db);
    const now = new Date();
    const yesterdayNow = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const morningDateStr = getAgentDayDateStr(
      this.deps.config.timezone || undefined,
      this.deps.config.dayBoundaryHour,
      now,
    );
    const yesterdayDateStr = getAgentDayDateStr(
      this.deps.config.timezone || undefined,
      this.deps.config.dayBoundaryHour,
      yesterdayNow,
    );
    // Yesterday's agent-day UTC window — same shape `buildStageBInputs`
    // derives for the skeleton facts. The appender uses it to aggregate
    // the agent-action breakdown into the `journal/agent.md` footprint
    // line. Recomputed here (rather than threaded from `buildStageBInputs`)
    // because Stage B is dispatched async and the orchestrator does not
    // retain its inputs between phases.
    const bounds = getAgentDayBoundsUtc(
      this.deps.config.timezone || undefined,
      this.deps.config.dayBoundaryHour,
      yesterdayNow,
    );
    const agentDayWindow = { startUtc: bounds.start, endUtc: bounds.end };
    return appendMorningRoutineJournalEntry(
      {
        db: this.deps.db,
        contextDir,
        ...(this.deps.writeTracker
          ? { writeTracker: this.deps.writeTracker }
          : {}),
      },
      {
        correlationId: args.correlationId,
        morningDateStr,
        yesterdayDateStr,
        agentDayWindow,
      },
    );
  }

  // ── ⑥ pre-insert in_progress row for Stage A ────────────────────────

  private preInsertStageAInProgressRow(correlationId: string): void {
    if (this.deps.audit === undefined) return;
    this.deps.audit.insertInProgressRow({
      correlationId,
      actionType: STAGE_A_ACTION_TYPE,
      // Morning routine fires from cron — never reactive.
      trigger: "autonomous",
    });
  }

  // ── ② HandoffParser plumbing ─────────────────────────────────────────

  private buildHandoffParsedBlock(): string | null {
    const contextDir = getContextDir(this.deps.config, this.deps.db);
    const yesterdayPath = join(contextDir, "state", "yesterday.md");
    if (!existsSync(yesterdayPath)) return null;
    let body: string;
    try {
      body = readFileSync(yesterdayPath, "utf-8");
    } catch (err) {
      logger.warn(
        { err, yesterdayPath },
        "yesterday.md read failed — falling back to in-task handoff parse",
      );
      return null;
    }
    const parsed = parseHandoff(body);
    if (parsed === null) return null;
    return renderHandoffParsedBlock(parsed);
  }

  // ── ③ JournalSkeletonBuilder plumbing ────────────────────────────────

  private buildStageBInputs(): StageBInputs | null {
    const contextDir = getContextDir(this.deps.config, this.deps.db);

    // First-run skip: when yesterday.md is absent, there is no prior
    // agent-day to author a journal about. Firing Stage B anyway would
    // produce a phantom `daily/<yesterday>.md` with `calendar_events: 0`
    // / `messages_handled: 0` / `## Tasks: (none)` for a date the user
    // wasn't using the agent — and `daily/<date>.md` is user-facing in
    // the vault, so the phantom entry is a real correctness issue, not
    // just internal noise. Aligns with §5.9 Step 5's "Skipped when no
    // yesterday.md (initial variant)" entry in the design's per-stage
    // responsibility matrix. The downstream `agent-journal-appender`
    // renders the daemon-emitted `Journal synthesis: skipped (no
    // prior-day data)` line whenever `daily/<yesterday>.md` is absent on
    // disk, so the audit-trail entry stays correct without Stage B.
    const yesterdayPath = join(contextDir, "state", "yesterday.md");
    if (!existsSync(yesterdayPath)) return null;

    // Yesterday's agent-day window = today's window shifted by -24h.
    // `getAgentDayBoundsUtc(now=<24h ago>)` yields the correct
    // `[start, end)` even across the 04:00 boundary / DST transitions
    // because the helper recomputes the offset at the boundary instant.
    const now = new Date();
    const yesterdayNow = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    // `getAgentDayBoundsUtc` returns `{start, end}` shaped strings;
    // `gatherJournalSkeletonFacts` consumes `{startUtc, endUtc}`. Adapt
    // here at the call site so the helper's shared shape stays stable
    // across other callers (`buildYesterdaySqliteContext` etc.).
    const bounds = getAgentDayBoundsUtc(
      this.deps.config.timezone || undefined,
      this.deps.config.dayBoundaryHour,
      yesterdayNow,
    );
    const window = { startUtc: bounds.start, endUtc: bounds.end };
    const dateStr = getAgentDayDateStr(
      this.deps.config.timezone || undefined,
      this.deps.config.dayBoundaryHour,
      yesterdayNow,
    );
    // Today's agent-day — lands in the skeleton's `updated:` frontmatter
    // field. Computed from `now` (not `yesterdayNow`) so a 04:00 run on
    // 2026-05-15 stamps `updated: 2026-05-15` while the journal's `date:`
    // stays `2026-05-14`.
    const updatedDateStr = getAgentDayDateStr(
      this.deps.config.timezone || undefined,
      this.deps.config.dayBoundaryHour,
      now,
    );
    const weekday = new Date(`${dateStr}T00:00:00Z`).toLocaleDateString("en-US", {
      weekday: "long",
      timeZone: "UTC",
    });

    const yesterdayMd = readFileSync(yesterdayPath, "utf-8");

    const facts = gatherJournalSkeletonFacts(this.deps.db, window);
    const calendarEvents = this.readYesterdayCalendarEvents(window);

    const skeletonInputs: JournalSkeletonInputs = {
      dateStr,
      weekday,
      updatedDateStr,
      yesterdayMd,
      calendarEvents,
      ...(this.deps.config.timezone
        ? { timezone: this.deps.config.timezone }
        : {}),
    };

    const skeletonBody = buildJournalSkeleton(skeletonInputs, facts);
    return {
      block: `<journal_skeleton>\n${skeletonBody}\n</journal_skeleton>`,
      yesterdayDateStr: dateStr,
      // daily-journal-daemon-write.md §4.11 (drift fix) — cache the
      // skeleton inputs + pre-aggregated counts here so the post-
      // `Promise.allSettled` composer can reuse the SAME byte stream
      // Stage B's prompt saw. Re-deriving on the composer side (as the
      // initial implementation did via `buildStageBSkeletonInputs`)
      // re-runs `gatherJournalSkeletonFacts` + `readYesterdayCalendar
      // Events` against the live DB; if a new DM or calendar observation
      // landed during Stage A's wall-clock window, or the agent day rolled
      // over, the LLM authored against Skeleton-V1 while the daemon wrote
      // Skeleton-V2 frontmatter (`messages_handled` / `calendar_events`
      // count drift, `updated:` date drift across the 04:00 boundary).
      // One canonical snapshot eliminates the drift class entirely.
      skeleton: skeletonInputs,
      calendarEventsCount: calendarEvents.length,
      messagesHandled: facts.messagesHandled,
    };
  }

  private readYesterdayCalendarEvents(window: {
    startUtc: string;
    endUtc: string;
  }): ReadonlyArray<SkeletonCalendarEvent> {
    // Calendar events stored in `observations` or `calendar_events` are
    // schema-fluid across direct / delegated / native modes. Phase 2's
    // skeleton builder is contract-tested against this shape; for Phase
    // 5 wiring we read the agent-day window from `observations` rows
    // tagged with a calendar source_prefix. Missing rows yield an empty
    // array — the skeleton renders `- (none)` in that case.
    const rows = this.deps.db
      .prepare(
        `SELECT payload AS payload
           FROM observations
          WHERE (source LIKE 'google_calendar:%'
              OR source LIKE 'outlook_calendar:%')
            AND observed_at >= ?
            AND observed_at < ?
          ORDER BY observed_at ASC`,
      )
      .all(window.startUtc, window.endUtc) as Array<{ payload: string | null }>;

    const out: SkeletonCalendarEvent[] = [];
    const timezone = this.deps.config.timezone || undefined;
    for (const row of rows) {
      const event = parseCalendarPayload(row.payload, timezone);
      if (event !== null) out.push(event);
    }
    return out;
  }

  // ── ⑤A Stage A dispatch ──────────────────────────────────────────────

  private composeStageAEvent(
    parent: Event,
    correlationId: string,
    handoffParsedBlock: string | null,
    roadmapSkeletonBlock: string | null,
  ): RoutineEvent {
    const data: Record<string, unknown> = {
      ...parent.data,
      morningPipelineStage: "today",
    };
    if (handoffParsedBlock !== null) {
      data.handoffParsedBlock = handoffParsedBlock;
    }
    if (roadmapSkeletonBlock !== null) {
      // Picked up by `ContextBuilder.build` on the `morning_routine`
      // branch; injected as the `<roadmap_skeleton>` block alongside
      // the truncated `<roadmap>` so Stage A can detect the placeholder
      // wizard skeleton and fully populate roadmap.md from the
      // daemon-prepared facts on the first-run day.
      data.roadmapSkeletonBlock = roadmapSkeletonBlock;
    }
    return {
      type: STAGE_A_PROCESS_KEY,
      source: parent.source,
      priority: parent.priority ?? EventPriority.HIGH,
      timestamp: parent.timestamp,
      correlationId,
      data,
      routine: STAGE_A_ROUTINE_SLUG,
    };
  }

  // ── Phase 7 — Roadmap skeleton plumbing (first-run branch only) ──────

  /**
   * Compose the `<roadmap_skeleton>` block injected into Stage A's
   * prompt on the **first-run** (no-yesterday) branch. Returns `null`
   * on the recurring branch (yesterday.md present); the recurring
   * branch reads the live truncated `<roadmap>` ContextBuilder
   * already injects.
   *
   * Why gate on `yesterday.md`: the first-run signal lines up with
   * the variant collapse documented in §5 ("variant collapse") — the
   * setup wizard produces a placeholder roadmap.md and rotateDayFiles
   * has not yet emitted yesterday.md. Both gates fire from the same
   * fs predicate so Stage A's first-run branch never sees a mismatch.
   *
   * Errors are swallowed: a malformed projects file or a missing
   * travel_bookings table degrades to "Stage A sees an empty
   * section" rather than failing the whole stage. The variant
   * collapse depends on Stage A still landing roadmap.md in this
   * case (it can fall back to reading `<management_rules>` and
   * `<active_projects>` inline); shipping a broken skeleton block
   * would be worse than no skeleton block at all.
   */
  private buildRoadmapSkeletonBlock(): string | null {
    const contextDir = getContextDir(this.deps.config, this.deps.db);
    const yesterdayPath = join(contextDir, "state", "yesterday.md");
    if (existsSync(yesterdayPath)) return null; // recurring branch
    try {
      const now = new Date();
      const todayDateStr = getAgentDayDateStr(
        this.deps.config.timezone || undefined,
        this.deps.config.dayBoundaryHour,
        now,
      );
      const calendarEvents = this.readForwardCalendarEvents(now);
      const facts = gatherRoadmapSkeletonFacts(
        this.deps.db,
        contextDir,
        todayDateStr,
      );
      const skeleton = buildRoadmapSkeleton(
        {
          todayDateStr,
          calendarEvents,
          ...(this.deps.config.timezone
            ? { timezone: this.deps.config.timezone }
            : {}),
        },
        facts,
      );
      return `<roadmap_skeleton>\n${skeleton}\n</roadmap_skeleton>`;
    } catch (err) {
      logger.warn(
        { err },
        "Roadmap skeleton build threw — Stage A will run without <roadmap_skeleton>",
      );
      return null;
    }
  }

  /**
   * Read forward-looking calendar events from the observations table
   * for the next 7 days (matching the design's "Annual Goals from
   * management rules, Quarterly Focus from active projects +
   * calendar, Preparation Timeline from travel_bookings + calendar"
   * window).
   *
   * Filtering note (pre-Phase-7-rev2 bug fix): the SQL filter does
   * NOT use `observed_at` as a window bound. `observed_at` is the
   * recording timestamp (CURRENT_TIMESTAMP at INSERT) — for a
   * forward-looking window every relevant row was inserted BEFORE
   * `now` (the just-completed pre-pass, an observer poll yesterday,
   * etc.), so an `observed_at >= now` predicate would exclude every
   * row. Instead we pull pending calendar observations and let JS
   * filter on the parsed event start time extracted from
   * `payload.raw.start`. The `consumed_at IS NULL` predicate scopes
   * the read to rows the next Stage A turn has not yet consumed —
   * exactly the set the pre-pass just landed for this morning's run.
   * The `LIMIT 500` clamp guards against an unexpectedly large
   * pending backlog blowing up Stage A's prompt budget; 500 is well
   * above any realistic seven-day window the routine
   * `cal_morning_7d` pre-pass would emit.
   *
   * Returns `[]` when no provider has pushed observations yet — the
   * skeleton renders an explicit placeholder line.
   */
  private readForwardCalendarEvents(
    now: Date,
  ): ReadonlyArray<RoadmapSkeletonCalendarEvent> {
    let rows: Array<{ payload: string | null }>;
    try {
      rows = this.deps.db
        .prepare(
          `SELECT payload AS payload
             FROM observations
            WHERE (source LIKE 'google_calendar:%'
                OR source LIKE 'outlook_calendar:%')
              AND consumed_at IS NULL
            ORDER BY observed_at DESC
            LIMIT 500`,
        )
        .all() as Array<{ payload: string | null }>;
    } catch {
      return [];
    }
    const startMs = now.getTime();
    const endMs = startMs + 7 * 24 * 60 * 60 * 1000;
    const out: RoadmapSkeletonCalendarEvent[] = [];
    for (const row of rows) {
      const event = parseForwardCalendarPayload(
        row.payload,
        this.deps.config.timezone || undefined,
      );
      if (event === null) continue;
      if (event.startMs < startMs) continue;
      if (event.startMs >= endMs) continue;
      out.push({ date: event.date, title: event.title });
    }
    // Stable ascending order so the skeleton output is deterministic
    // regardless of the SQL-side `ORDER BY observed_at DESC` (which is
    // tuned for the LIMIT clamp, not the rendering order).
    out.sort((a, b) => {
      if (a.date !== b.date) return a.date.localeCompare(b.date);
      return a.title.localeCompare(b.title);
    });
    return out;
  }

  private async runStageA(
    event: RoutineEvent,
    requestedTier: MorningPipelineRunInputs["requestedTier"],
    preResolvedBinding: ResolvedBackendRoute | null,
  ): Promise<AgentResult> {
    const context = await this.deps.contextBuilder.build(event);
    // The orchestrator pre-resolves the binding so the failure-path
    // handler can attribute the audit row to the requested backend/model.
    // When the pre-resolve threw (binding === null), fall back to a
    // resolve here — the throw will propagate normally and persist via
    // `recordStageFailure` with a null binding.
    const binding = preResolvedBinding
      ?? this.deps.agentRouter.resolveBinding(event, {
        processKey: STAGE_A_PROCESS_KEY,
        ...(requestedTier ? { requestedTier } : {}),
      });
    const reassemblePrompt = (bid: BackendId): string =>
      this.deps.prompt.assemble(event.type, STAGE_A_PROCESS_KEY, bid);
    const prompt = reassemblePrompt(binding.main.backendId);
    return this.deps.errorRouter.executeWithRetry(
      () =>
        this.deps.agentRouter.execute({
          prompt,
          context,
          event,
          processKey: STAGE_A_PROCESS_KEY,
          preResolvedBinding: binding,
          reassemblePrompt,
          ...(requestedTier ? { requestedTier } : {}),
        }),
      event,
    );
  }

  // ── ⑤B Stage B dispatch ──────────────────────────────────────────────

  private composeStageBEvent(
    parent: Event,
    correlationId: string,
    journalSkeletonBlock: string,
    yesterdayDateStr: string,
  ): RoutineEvent {
    // Stage B does NOT inherit the parent's `todayWriteLockId` or
    // `fetchReportBlock`. The lock gates today.md only (Stage B never
    // touches it); the fetch report describes data Stage A consumes
    // (pending observations from mail / notion / calendar pre-pass)
    // that Stage B has no skill bundle to read. Stripping them keeps
    // Stage B's prompt minimal so the lite-tier cold-start floor holds.
    const stripped: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(parent.data ?? {})) {
      if (key === "todayWriteLockId") continue;
      if (key === "fetchReportBlock") continue;
      if (key === "acquisitionPlanBlock") continue;
      stripped[key] = value;
    }
    stripped.morningPipelineStage = "journal";
    stripped.journalSkeletonBlock = journalSkeletonBlock;
    // daily-journal-daemon-write.md §4.10 — browser-history digest now
    // fetched daemon-side and injected as `<browser_digest>` (Stage B
    // has zero tool requirement so it cannot fetch it itself). The
    // four-step chain in `buildBrowserDigestBlock` mirrors the LLM
    // logic the task-flow used to perform.
    const browserDigestBlock = this.buildBrowserDigestBlock(yesterdayDateStr);
    if (browserDigestBlock !== null) {
      stripped.browserDigestBlock = browserDigestBlock;
    }
    return {
      type: STAGE_B_PROCESS_KEY,
      source: parent.source,
      priority: parent.priority ?? EventPriority.HIGH,
      timestamp: parent.timestamp,
      correlationId,
      data: stripped,
      routine: STAGE_B_ROUTINE_SLUG,
    };
  }

  /**
   * Resolve the `<browser_digest>` block Stage B used to fetch via
   * `GET /api/context/browser/yesterday-<date>.md`. Now daemon-driven
   * since Stage B has no tools:
   *
   *  1. Gate on integration mode — `browser_history` `disabled` →
   *     return `null` (no block injection).
   *  2. File-first — `<contextDir>/browser/yesterday-<date>.md` written
   *     by the 03:00 cron is the primary surface.
   *  3. In-process JSON fallback — if the file is absent (daemon was
   *     down at 03:00 or the file was purged), call
   *     `runPreMorningDigestJob` in-process to rebuild from SQLite +
   *     render the markdown shape (no HTTP loopback).
   *  4. Both unavailable → return `null` (silent skip; the task-flow
   *     omits the block).
   *
   * The block is wrapped in `<browser_digest>...</browser_digest>` to
   * match the inbound-XML idiom every other ContextBuilder injection
   * uses (`<fetch_report>`, `<journal_skeleton>`, etc.).
   */
  private buildBrowserDigestBlock(yesterdayDateStr: string): string | null {
    try {
      const integrationState = readIntegrationState(this.deps.db, "browser_history");
      if (integrationState.mode === "disabled") return null;
    } catch (err) {
      // Read failure on the integration registry is rare (corrupt
      // settings JSON). Log + skip — Stage B should still author the
      // journal without browser-history context if the registry is in
      // a bad state.
      logger.warn(
        { err },
        "browser_history integration state read failed — omitting <browser_digest>",
      );
      return null;
    }
    const contextDir = getContextDir(this.deps.config, this.deps.db);
    // §10.6 / §5.F2 — the cron writes `browser/yesterday-<date>.md`.
    const filePath = join(contextDir, "browser", `yesterday-${yesterdayDateStr}.md`);
    if (existsSync(filePath)) {
      try {
        const body = readFileSync(filePath, "utf-8");
        return `<browser_digest>\n${body}\n</browser_digest>`;
      } catch (err) {
        logger.warn(
          { err, filePath },
          "browser digest file read failed — falling back to in-process rebuild",
        );
      }
    }
    // In-process fallback — rebuild the digest from SQLite using the
    // same pure builder the cron uses. Avoids the HTTP loopback that
    // hits the `@hono/node-server` globalThis.Response pitfall
    // (`project_hono_global_response_pitfall` memory). The result is
    // rendered into the same markdown shape the file-first path would
    // have produced.
    try {
      const boundary = {
        timezone: this.deps.config.timezone || undefined,
        dayBoundaryHour: this.deps.config.dayBoundaryHour ?? 4,
      };
      const digest = buildPreMorningDigest({
        db: this.deps.db,
        date: yesterdayDateStr,
        boundary,
      });
      const markdown = renderPreMorningDigestMarkdown(digest);
      return `<browser_digest>\n${markdown}\n</browser_digest>`;
    } catch (err) {
      logger.warn(
        { err, yesterdayDateStr },
        "browser digest in-process rebuild failed — omitting <browser_digest>",
      );
      return null;
    }
  }

  private async runStageB(
    event: RoutineEvent,
    preResolvedBinding: ResolvedBackendRoute | null,
  ): Promise<AgentResult> {
    const context = await this.deps.contextBuilder.build(event);
    // Same pre-resolve fallback as Stage A — see `runStageA`'s comment.
    const binding = preResolvedBinding
      ?? this.deps.agentRouter.resolveBinding(event, {
        processKey: STAGE_B_PROCESS_KEY,
      });
    const reassemblePrompt = (bid: BackendId): string =>
      this.deps.prompt.assemble(event.type, STAGE_B_PROCESS_KEY, bid);
    const prompt = reassemblePrompt(binding.main.backendId);
    return this.deps.errorRouter.executeWithRetry(
      () =>
        this.deps.agentRouter.execute({
          prompt,
          context,
          event,
          processKey: STAGE_B_PROCESS_KEY,
          preResolvedBinding: binding,
          reassemblePrompt,
          // daily-journal-daemon-write.md §3 corollary — Stage B's
          // session must have zero tool requirement. The empty
          // `skills-manifest.ts` entry suppresses `.claude/skills/*` from
          // being registered, but the SDK still ships its default
          // `CLAUDE_DEFAULT_ALLOWED_TOOLS` (Read / Write / Edit /
          // Bash(curl *) / …). Without this per-execute clamp, Haiku
          // could still call `Write` on `daily/<date>.md` directly —
          // bypassing the daemon-side `DailyJournalComposer` chokepoint
          // and racing it. Mirrors the precedent at
          // `dispatcher-hourly-check.ts:1003` (`routine.hourly_check.triage`).
          //
          // Activation requires the clamp gate in `claude-code-core.ts`
          // to honour an empty array as "no tools" — fixed in the same
          // PR as this addition (the prior `length > 0` gate silently
          // dropped `[]` to the default surface).
          //
          // Codex / Gemini have no per-spawn `allowedTools` surface —
          // the Stage B process key routes to Claude (lite tier / Haiku)
          // by default, so this clamp is effective on the production
          // binding. On a Claude→Codex/Gemini fallback the clamp is
          // not honoured; the `max_turns: 20` / `max_budget_usd: 0.30`
          // envelope on `routine.morning_routine_journal` remains the
          // safety floor on those backends.
          allowedToolsOverride: [],
        }),
      event,
    );
  }

  // ── ⑥b helpers — read DB-side stage summaries for parent-audit ──────

  private readStageSummaries(correlationId: string): {
    stageA: StageSummary | null;
    stageB: StageSummary | null;
  } {
    // We use the auditor's authoritative agent_actions rows (cost / turns /
    // result) rather than the in-memory `AgentResult` so retry attempts
    // and partial-failure paths report the same shape regardless of which
    // branch produced them.
    const rows = this.deps.db
      .prepare(
        `SELECT action_type AS actionType,
                cost_usd   AS cost_usd,
                num_turns  AS num_turns,
                result     AS result
           FROM agent_actions
          WHERE event_id = ?
            AND action_type IN (?, ?)
          ORDER BY id ASC`,
      )
      .all(correlationId, STAGE_A_ACTION_TYPE, STAGE_B_ACTION_TYPE) as Array<{
      actionType: string;
      cost_usd: number | null;
      num_turns: number | null;
      result: StageActionResult;
    }>;

    let stageA: StageSummary | null = null;
    let stageB: StageSummary | null = null;
    for (const row of rows) {
      // Latest row wins on retry — agent_actions inserts append a fresh
      // row per attempt; the most-recent row is the one the gate should
      // attribute. `loadMorningRoutineActionRows` follows the same rule.
      const summary: StageSummary = {
        cost_usd: row.cost_usd,
        num_turns: row.num_turns,
        result: row.result,
      };
      if (row.actionType === STAGE_A_ACTION_TYPE) stageA = summary;
      else if (row.actionType === STAGE_B_ACTION_TYPE) stageB = summary;
    }
    return { stageA, stageB };
  }
}

// ── module-level helpers ────────────────────────────────────────────────

/**
 * What `buildStageBInputs` returns: the prompt-side `<journal_skeleton>`
 * XML block AND the inputs that produced it (skeleton inputs + the two
 * pre-aggregated counts that land in the `daily/<date>.md` frontmatter).
 *
 * Single canonical snapshot per morning run — the composer reads from
 * here instead of re-querying SQLite, eliminating the drift class where
 * Skeleton-V1 went into the prompt but Skeleton-V2 landed in the file.
 */
interface StageBInputs {
  block: string;
  yesterdayDateStr: string;
  skeleton: JournalSkeletonInputs;
  calendarEventsCount: number;
  messagesHandled: number;
}

/**
 * Per-stage settled outcome handed to `persistStageAuditRows`. Models
 * three states with a discriminated union on the property carried:
 *   - `result: AgentResult`   → success (writes via processResult)
 *   - `result: null`          → Stage B first-run skip (no row to write)
 *   - `error: unknown`        → rejection (writes via audit.logError)
 *
 * `startedAtMs` / `completedAtMs` are captured by the orchestrator at
 * call sites that bracket the `Promise.allSettled` so the failure-path
 * writer can backdate `agent_actions.started_at` honestly.
 */
type StageOutcome = StageSuccessOutcome | StageFailureOutcome;

interface StageSuccessOutcome {
  event: RoutineEvent;
  binding: ResolvedBackendRoute | null;
  startedAtMs: number;
  completedAtMs: number;
  /** `null` is the Stage B first-run skip — no execute call happened. */
  result: AgentResult | null;
  /**
   * daily-journal-daemon-write.md §4.11 — Stage B's compose outcome,
   * threaded into the row's `detail.dailyWrite` field. Absent on Stage
   * A and on Stage B runs where `composeDailyJournalIfPossible`
   * short-circuited.
   */
  dailyWrite?: DailyWriteAuditDetail;
}

interface StageFailureOutcome {
  event: RoutineEvent;
  binding: ResolvedBackendRoute | null;
  startedAtMs: number;
  completedAtMs: number;
  error: unknown;
  /** Mirror of `StageSuccessOutcome.dailyWrite` on the failure path. */
  dailyWrite?: DailyWriteAuditDetail;
}

/**
 * Extract the underlying `BackendQuotaError` from a stage rejection so
 * `recordStageFailure` can tag the audit row with `failureKind='quota'`
 * + `failureCode=originalCode` (e.g. `max_budget_usd`). Mirrors the
 * `DispatcherErrorRouter.extractQuotaError` logic — kept module-local
 * here so the orchestrator is not coupled to the dispatcher's private
 * extraction surface.
 */
function extractQuotaError(error: unknown): BackendQuotaError | null {
  if (error instanceof BackendQuotaError) return error;
  if (error instanceof BackendRouterHandledError) {
    if (error.cause instanceof BackendQuotaError) return error.cause;
  }
  return null;
}

/**
 * Map the composer's `DailyJournalComposeResult` to the
 * `agent_actions.detail.dailyWrite` JSON shape audit persists. The two
 * types are structurally identical today — but the mapper localises
 * the coupling so a future schema change to the audit shape doesn't
 * silently drift from the composer's API. Inlined at the call site
 * via `import type` would also work but loses the assertion site.
 */
function toDailyWriteAuditDetail(
  result: DailyJournalComposeResult,
): DailyWriteAuditDetail {
  return result;
}

function renderHandoffParsedBlock(parsed: HandoffParsed): string {
  // XML over JSON: the rest of the daemon's prompt-injection payloads
  // (`<fetch_report>`, `<acquisition-plan>`, `<integration_modes>`) use
  // XML-style tags; keep the same shape so Stage A's task-flow can read
  // them with one consistent extractor.
  const lines: string[] = ["<handoff_parsed>"];
  lines.push("  <tomorrow>");
  if (parsed.tomorrow.length === 0) {
    lines.push("    <item>(none)</item>");
  } else {
    for (const item of parsed.tomorrow) {
      lines.push(`    <item>${escapeXml(item)}</item>`);
    }
  }
  lines.push("  </tomorrow>");
  lines.push("  <later>");
  if (parsed.later.length === 0) {
    lines.push("    <item>(none)</item>");
  } else {
    for (const item of parsed.later) {
      lines.push(`    <item>${escapeXml(item)}</item>`);
    }
  }
  lines.push("  </later>");
  lines.push("</handoff_parsed>");
  return lines.join("\n");
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Calendar observation payload shape. The canonical wrapper produced by
 * `_partials/calendar-acquire.{google,outlook}_calendar.md`,
 * `imminent-event-scheduler.ts`, and any other writer that POSTs to
 * `/api/observations` for a calendar event is
 *
 *     { kind: "calendar", providerId: string, raw: { title, start, end, ... } }
 *
 * The pre-Phase-7 readers in this file only looked at the legacy /
 * hypothetical top-level fields (`startTime`, `start_time`, `start`,
 * `title`, `summary`) — none of which appear in the canonical row. As a
 * result every real-world calendar observation parsed to a null event
 * and the roadmap/journal skeletons silently rendered their empty
 * placeholders even when the pre-pass had just landed a full window.
 *
 * The struct keeps the legacy keys as a forward-compat fallback so any
 * fixture or future writer that happens to emit a flatter shape still
 * resolves; the canonical `raw.*` lookup is checked first.
 */
interface CalendarPayloadShape {
  raw?: {
    title?: unknown;
    summary?: unknown;
    start?: unknown;
    end?: unknown;
    allDay?: unknown;
    all_day?: unknown;
  };
  // Legacy top-level fields kept for forward-compat with non-canonical
  // observation writers and test fixtures.
  startTime?: unknown;
  start_time?: unknown;
  start?: unknown;
  title?: unknown;
  summary?: unknown;
  allDay?: unknown;
  all_day?: unknown;
}

/** Parsed `{startMs, title, isAllDay}` triple from a canonical calendar payload. */
interface CalendarPayloadParts {
  startMs: number | null;
  title: string;
  isAllDay: boolean;
}

/**
 * Walk a calendar observation payload and lift the load-bearing fields
 * (`start`, `title`, `allDay`) into a uniform struct. Canonical
 * `raw.*` keys win over legacy top-level keys; whichever provides the
 * value first is taken so a writer that emits both does not produce
 * inconsistent reads.
 */
function extractCalendarPayloadParts(parsed: CalendarPayloadShape): CalendarPayloadParts {
  const title =
    pickString(parsed.raw?.title)
    ?? pickString(parsed.raw?.summary)
    ?? pickString(parsed.title)
    ?? pickString(parsed.summary)
    ?? "";
  const isAllDay =
    parsed.raw?.allDay === true
    || parsed.raw?.all_day === true
    || parsed.allDay === true
    || parsed.all_day === true;
  const startRaw =
    pickString(parsed.raw?.start)
    ?? pickString(parsed.startTime)
    ?? pickString(parsed.start_time)
    ?? pickString(parsed.start);
  if (startRaw === null) return { startMs: null, title, isAllDay };
  const ms = Date.parse(startRaw);
  if (!Number.isFinite(ms)) return { startMs: null, title, isAllDay };
  return { startMs: ms, title, isAllDay };
}

function safeParseCalendarShape(raw: string | null): CalendarPayloadShape | null {
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as CalendarPayloadShape;
  } catch {
    return null;
  }
}

/**
 * Phase 7 — extract `{date, title}` from a calendar observation payload
 * for the roadmap skeleton. Differs from `parseCalendarPayload` (which
 * emits `{time HH:MM, title}` for the daily journal skeleton): the
 * roadmap skeleton renders calendar events as date bullets, not time
 * bullets, because the look-ahead window is 7 days forward and per-
 * minute granularity is irrelevant for Quarterly Focus / Preparation
 * Timeline hints.
 *
 * Returns `null` when the payload has no parseable start time. Title-
 * only payloads are intentionally dropped — a calendar bullet without a
 * date is noise for a forward-window skeleton.
 */
function parseForwardCalendarPayload(
  raw: string | null,
  timezone: string | undefined,
): { date: string; title: string; startMs: number } | null {
  const parsed = safeParseCalendarShape(raw);
  if (parsed === null) return null;
  const parts = extractCalendarPayloadParts(parsed);
  if (parts.startMs === null) return null;
  // Render the date in the operator's timezone so the skeleton's bullet
  // dates line up with `<calendar_events_7d>` (which renders in the same
  // tz). All-day events stored with a trailing 00:00 UTC suffix could
  // otherwise drift by one day for east-of-UTC operators.
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone ?? "UTC",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const date = formatter.format(new Date(parts.startMs));
  return { date, title: parts.title, startMs: parts.startMs };
}

function parseCalendarPayload(
  raw: string | null,
  timezone: string | undefined,
): SkeletonCalendarEvent | null {
  const parsed = safeParseCalendarShape(raw);
  if (parsed === null) return null;
  const parts = extractCalendarPayloadParts(parsed);
  if (parts.isAllDay) {
    return { time: null, title: parts.title };
  }
  if (parts.startMs === null) {
    return { time: null, title: parts.title };
  }
  // Render `HH:MM` in the operator's local timezone — matches
  // `SkeletonCalendarEvent.time`'s "HH:MM local start time" contract,
  // the DM-section bullet's tz-aware rendering inside the skeleton
  // builder, and ContextBuilder's `<calendar_events_7d>` block. The
  // pre-fix UTC slice (`getUTCHours`/`Minutes`) would render a 10:00
  // local standup for a UTC-7 operator as `17:00` in the `## Schedule`
  // scratch input that Stage B then uses to author the daily journal.
  if (typeof timezone === "string" && timezone.length > 0) {
    try {
      const fmt = new Intl.DateTimeFormat("en-GB", {
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
        timeZone: timezone,
      });
      return { time: fmt.format(new Date(parts.startMs)), title: parts.title };
    } catch {
      // Fall through to UTC slice on a bad TZ name (Intl throws
      // RangeError). Still better than throwing past the pure helper.
    }
  }
  const date = new Date(parts.startMs);
  const hh = String(date.getUTCHours()).padStart(2, "0");
  const mm = String(date.getUTCMinutes()).padStart(2, "0");
  return { time: `${hh}:${mm}`, title: parts.title };
}

function pickString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (value.length === 0) return null;
  return value;
}

// Re-export the action-type constants so dispatcher / runner can
// continue to import them from one path even after Phase 6 moves
// more responsibilities into the orchestrator.
export {
  STAGE_A_PROCESS_KEY,
  STAGE_B_PROCESS_KEY,
  STAGE_A_ROUTINE_SLUG,
  STAGE_B_ROUTINE_SLUG,
};

