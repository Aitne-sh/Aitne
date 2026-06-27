/**
 * `MorningRoutineRunner` — owns `routine.morning_routine` execution
 * end-to-end: today.md write-lock acquisition, retry chain wrapping
 * (`morningRoutineInProgress` flag), post-run today.md health check
 * (missing / wrong-date), exponential-back-off retry scheduling, and
 * the deferred post-morning catchup emit.
 *
 * Variant collapse (`docs/design/appendices/morning-routine-optimization.md`
 * Phase 4 + Phase 7): both the recurring and first-run (no-yesterday)
 * branches dispatch under the single `routine.morning_routine` process
 * key and share one merged task-flow file; the agent picks the
 * first-run branch inline from the absence of `<yesterday>` in its
 * prompt context. The previous tier-inheritance hack that mirrored
 * morning_routine's configured tier onto a separate
 * `routine.morning_routine_initial` process key has been retired (Phase 4),
 * and Phase 7 (2026-05-16) removed the high-tier seed entirely —
 * Stage A now lands roadmap.md inline on medium tier using the
 * daemon-prepared `<roadmap_skeleton>` block emitted by
 * `MorningRoutinePipelineOrchestrator.buildRoadmapSkeletonBlock`.
 *
 * Extracted from `core/dispatcher.ts` as part of phase D-2 of
 * `docs/design/appendices/file-split-plan.md`. Pattern B (stateful
 * coordinator): the runner has no mutable state of its own; it
 * borrows the dispatcher's `morningRoutineInProgress` flag through a
 * setter callback so the existing C-fix invariants survive the split,
 * and bridges into a handful of dispatcher / coordinator methods that
 * are still owned elsewhere (`rotateDayFiles`,
 * `diagnoseTodayMdState`, `isRoadmapStale`, `emitRoadmapRefresh`,
 * `triggerActivityScan`).
 *
 * Dispatcher entry points served:
 *   - `EventDispatcher.dispatch` routes `routine === "morning_routine"`
 *     into `executeMorningRoutine(event)`;
 *   - `ScheduledTaskRunner.handleMorningRoutineRetry` (after Task 7)
 *     calls back into the same entry point with a synthesized
 *     RoutineEvent carrying the propagated retryCount.
 *
 * Shared-state references held:
 *   - `setMorningRoutineInProgress` — setter callback. The flag is
 *     flipped to true at the start of the execute → executeWithRetry
 *     wrapper and reset in `finally` so the activity scan can resume.
 */

import type Database from "better-sqlite3";
import type {
  AgentResult,
  Event,
  ProcessModelTier,
  RoutineEvent,
} from "@aitne/shared";
import {
  EventPriority,
  createEvent,
  formatSqliteDatetime,
} from "@aitne/shared";
import type { AgentConfig } from "../config.js";
import type { EventBus } from "./event-bus.js";
import type { TodayWriteLockManager } from "./today-write-lock.js";
import { flushPendingTodayRefresh } from "./drift-effects.js";
import { maybeTriggerRoadmapRefresh } from "./schedule-insert-helper.js";
import type { INotificationManager } from "./dispatcher-types.js";
import type { RoutineFetchWindowRunner } from "./routine-fetch-window-runner.js";
import type {
  MorningPipelineRunResult,
  MorningRoutinePipelineOrchestrator,
} from "./morning/orchestrator.js";
import { createLogger } from "../logging.js";

const logger = createLogger("dispatcher-morning-routine");

/**
 * Mirrors the union returned by the dispatcher's `diagnoseTodayMdState`.
 * Re-declared (rather than imported) so the runner stays decoupled
 * from `ScheduledTaskRunner`'s eventual home — the dispatcher passes
 * the diagnose closure as a dep, and only this runner's call site
 * needs to know the shape.
 */
export type TodayMdDiagnosis =
  | { kind: "fresh" }
  | { kind: "missing" }
  | { kind: "no_h1_date" }
  | { kind: "wrong_date"; writtenDate: string; expectedAgentDay: string };

/**
 * Project the runner's discriminated `TodayMdDiagnosis` into the flat
 * `TodayMdHealth` union the parent-audit-emitter consumes. The two
 * shapes were kept decoupled so the emitter does not depend on the
 * dispatcher's types; this helper bridges them at the one call site.
 * Lift the bridge into a shared module when a second caller needs it
 * (no-yet).
 */
function mapDiagnoseToHealth(
  state: TodayMdDiagnosis,
): "fresh" | "missing" | "no_h1_date" | "wrong_date" {
  return state.kind;
}

export interface MorningRoutineRunnerDeps {
  db: Database.Database;
  config: AgentConfig;
  eventBus: EventBus;
  notificationMgr: INotificationManager;
  todayWriteLock: TodayWriteLockManager | undefined;
  /**
   * docs/design/appendices/routine-data-acquisition.md Phase 4 / D2 — the pre-pass
   * runner spawned before the main morning routine session so external
   * mail / notion data lands in `/api/observations` before the parent
   * agent reads `pending=true`.
   */
  fetchWindowRunner: RoutineFetchWindowRunner;
  /** Setter for the dispatcher's `morningRoutineInProgress` flag. */
  setMorningRoutineInProgress: (value: boolean) => void;
  /**
   * Pre-execute day-file rotation (today.md → yesterday.md when the
   * agent day rolled over). Owned by `ScheduledTaskRunner` after Task
   * 7 of the file-split plan.
   */
  rotateDayFiles: () => void;
  /**
   * Post-execute today.md health check. `'fresh'` permits the rest
   * of the morning chain (post-catchups, today_refresh flush);
   * `'missing'` / `'wrong_date'` triggers `scheduleMorningRetry`.
   */
  diagnoseTodayMdState: () => TodayMdDiagnosis;
  /**
   * Read the dispatcher's pre-execute roadmap-staleness flag so the
   * runner can fire `emitRoadmapRefresh` once the agent's writes
   * settle (the agent itself may have updated the roadmap mid-run,
   * so this must be sampled BEFORE `executeMorningRoutine` invokes
   * the agent).
   */
  isRoadmapStale: () => boolean;
  /** Bridges into the dispatcher's roadmap-refresh emit. */
  emitRoadmapRefresh: (source: string) => void;
  /**
   * Bridges into `EventDispatcher.triggerActivityScan` so the deferred
   * post-morning activity_scan can fire from `emitPostMorningCatchups`.
   */
  triggerActivityScan: (source: string) => Promise<unknown>;
  /**
   * morning-routine-optimization.md Phase 5/6/7 — the split-stage
   * pipeline orchestrator owns Stage A (today.md) + Stage B (daily
   * journal). The legacy monolithic single-session path was retired
   * once the orchestrator path stabilised; there is no fallback. If
   * the orchestrator throws, the post-execute `diagnoseTodayMdState`
   * gate catches the missing today.md and schedules a retry the same
   * way a Stage-A-internal failure would.
   */
  pipelineOrchestrator: MorningRoutinePipelineOrchestrator;
}

export class MorningRoutineRunner {
  private readonly db: Database.Database;
  private readonly config: AgentConfig;
  private readonly eventBus: EventBus;
  private readonly notificationMgr: INotificationManager;
  private readonly todayWriteLock: TodayWriteLockManager | undefined;
  private readonly fetchWindowRunner: RoutineFetchWindowRunner;
  private readonly setMorningRoutineInProgress: (value: boolean) => void;
  private readonly rotateDayFiles: () => void;
  private readonly diagnoseTodayMdState: () => TodayMdDiagnosis;
  private readonly isRoadmapStale: () => boolean;
  private readonly emitRoadmapRefresh: (source: string) => void;
  private readonly triggerActivityScan: (source: string) => Promise<unknown>;
  private readonly pipelineOrchestrator: MorningRoutinePipelineOrchestrator;

  constructor(deps: MorningRoutineRunnerDeps) {
    this.db = deps.db;
    this.config = deps.config;
    this.eventBus = deps.eventBus;
    this.notificationMgr = deps.notificationMgr;
    this.todayWriteLock = deps.todayWriteLock;
    this.fetchWindowRunner = deps.fetchWindowRunner;
    this.setMorningRoutineInProgress = deps.setMorningRoutineInProgress;
    this.rotateDayFiles = deps.rotateDayFiles;
    this.diagnoseTodayMdState = deps.diagnoseTodayMdState;
    this.isRoadmapStale = deps.isRoadmapStale;
    this.emitRoadmapRefresh = deps.emitRoadmapRefresh;
    this.triggerActivityScan = deps.triggerActivityScan;
    this.pipelineOrchestrator = deps.pipelineOrchestrator;
  }

  /**
   * Morning routine execution with pre-processing (lock, rotateDayFiles).
   * Only called for routine === "morning_routine".
   *
   * Variant collapse: both the recurring and first-run (no-yesterday)
   * branches dispatch under the single `routine.morning_routine` process
   * key. The merged task-flow lets the agent pick the first-run branch
   * inline from the absence of `<yesterday>` in its prompt context, so
   * tier / binding / cost-cap resolution is the same for both day-types.
   * Tier is resolved by BackendRouter from process-key defaults or user
   * config.
   */
  async executeMorningRoutine(event: Event): Promise<void> {
    let lockId: string | null = null;
    let effectiveEvent = event;

    if (this.todayWriteLock) {
      const lock = this.todayWriteLock.acquire();
      if (!lock.ok) {
        logger.warn(
          {
            eventType: event.type,
            source: event.source,
            holder: lock.holder,
          },
          "today.md write lock held during morning routine — scheduling retry",
        );
        this.scheduleMorningRetry(event);
        return;
      }
      lockId = lock.lockId;
      effectiveEvent = {
        ...event,
        data: {
          ...event.data,
          todayWriteLockId: lockId,
        },
      };
    }

    this.rotateDayFiles();
    // Check roadmap staleness BEFORE agent runs (agent may PATCH roadmap, updating mtime)
    const roadmapStaleBeforeMorning = this.isRoadmapStale();
    const promptKey = "routine.morning_routine";

    // Retry runs on the medium tier (Sonnet) instead of any higher pin the
    // operator may have configured. Cost trade-off: a wrong-date or
    // malformed today.md is cheap to regenerate — the heavy work (mail
    // classification, journal synthesis, roadmap walk) was already done by
    // the first attempt and its outputs persisted via /api/context/* writes
    // that survive into the retry's prompt context. Sonnet at ~1/5 of Opus's
    // per-turn cost keeps the worst-case retry chain (3 attempts) under $2
    // instead of $12, which is the cap the user asked for after observing
    // $25/hour burn during a date-format loop. See morning-routine fix doc.
    const retryCount = Number(effectiveEvent.data?.retryCount ?? 0);
    const isRetry =
      retryCount > 0 || effectiveEvent.data?.isRetry === true;
    const requestedTier: ProcessModelTier | undefined = isRetry
      ? "medium"
      : undefined;
    logger.info(
      { promptKey, roadmapStale: roadmapStaleBeforeMorning, isRetry, retryCount, requestedTier: requestedTier ?? "default" },
      "Morning routine dispatch",
    );

    // B2 fix + docs/design/appendices/routine-data-acquisition.md Phase 4 / D2 race fix:
    // flip `morningRoutineInProgress=true` BEFORE the pre-pass fires so
    // activity_scan can't squeeze through the cold-start window
    // (`activityScan.trigger` skips when `isMorningRoutineActive()`
    // returns true). The original B2 fix already widened the flag to
    // span the whole retry chain; the pre-pass shifts the boundary
    // earlier so the same guard covers context build + binding resolve
    // + Haiku fetcher cold-start, all of which precede the executor.
    // The flag is reset in `finally` regardless of whether the pre-pass,
    // context build, or main session throws — so a partial-failure path
    // cannot leave the flag stuck `true` and starve activity_scan forever.
    this.setMorningRoutineInProgress(true);
    // `pipelineRun` is non-null when the orchestrator completed and
    // Stage A produced an `AgentResult`. A null value means Stage A
    // threw (caught below); we fall through to `diagnoseTodayMdState`
    // which detects the missing today.md and schedules a retry.
    let pipelineRun: MorningPipelineRunResult | null = null;
    try {
      // docs/design/appendices/routine-data-acquisition.md Phase 4 / D2 — fire the
      // pre-pass fetcher session BEFORE we build the parent's context.
      // The fetcher POSTs to `/api/observations` so the parent's
      // `pending=true` reads see the fresh rows; the rendered
      // `<fetch_report>` block is grafted into `event.data.fetchReportBlock`
      // so ContextBuilder injects it verbatim into the parent prompt. The
      // runner never throws — failures surface as
      // `<fetch_report status="failed">` and the parent routine
      // continues with whatever observations the rest of the plan
      // produced (cf. runner doc-comment, design §11 R5).
      //
      // Retry runs (`isRetry === true`) skip the pre-pass: by the time we
      // retry, observations posted by the original attempt are still
      // available (TTL is days; retries are minutes apart), and Haiku
      // tokens spent re-confirming the same window inflate the retry
      // cost cap the user explicitly set.
      const fetchPrepass = isRetry
        ? null
        : await this.fetchWindowRunner.run(effectiveEvent, promptKey);
      if (fetchPrepass) {
        effectiveEvent = {
          ...effectiveEvent,
          data: {
            ...effectiveEvent.data,
            fetchReportBlock: fetchPrepass.block,
          },
        };
      }

      // Stage A medium + Stage B lite in parallel, with daemon-prepared
      // `<handoff_parsed>` + `<journal_skeleton>` + `<roadmap_skeleton>`
      // blocks injected into each stage's prompt context. Stage A's
      // `AgentResult` (today.md synthesis) is what gates the post-run
      // today.md health check; Stage B's result (journal author) lands
      // in `pipelineRun.stageBResult` for the parent-audit row. Stage A
      // throw propagates here; we catch, log, and let the post-execute
      // `diagnoseTodayMdState` schedule a retry — same recovery shape
      // as a Stage-A-internal failure.
      try {
        pipelineRun = await this.pipelineOrchestrator.run({
          parentEvent: effectiveEvent,
          isRetry,
          ...(requestedTier ? { requestedTier } : {}),
        });
      } catch (err) {
        logger.error(
          { err, promptKey, correlationId: effectiveEvent.correlationId },
          "Morning pipeline orchestrator threw — falling through to today.md health check + retry",
        );
        pipelineRun = null;
      }
    } finally {
      // B3 fix: the today.md write-lock is released here (Stage B /
      // journal / parent-audit do not touch today.md, so early release
      // is safe), but `morningRoutineInProgress` is NOT cleared here.
      // Clearing the flag before the authoritative
      // `routine.morning_routine` success audit row is durable opens a
      // window where, for a cron-triggered (non-wake) run, both
      // `isMorningRoutineActive()` and `morningRoutineRanToday()` read
      // false — an activity_scan tick would then take the
      // `morning_routine_pending_for_today` branch and enqueue a
      // spurious morning_routine wake. The flag is instead cleared in
      // the post-finally try/finally below, AFTER the journal append +
      // parent-audit emit, on every exit path.
      if (lockId && this.todayWriteLock) {
        this.todayWriteLock.release(lockId);
      }
    }
    try {
    // Per-stage `agent_actions` rows are written from inside
    // `orchestrator.run()` (each stage runs through
    // `resultProcessor.processResult(stageResult, stageEvent)` so each
    // row lands with `action_type=routine.morning_routine_today` /
    // `..._journal`). The parent `routine.morning_routine` audit row
    // is synthesised below by `emitParentAuditRow` once Stage A success
    // + today.md health are both confirmed — that is the row the
    // pre-routine gate (`morningRoutineRanToday`) reads.
    const stageAResult: AgentResult | null =
      pipelineRun !== null ? pipelineRun.stageAResult : null;

    // Post-morning-routine: verify today.md was generated, retry if not.
    // This catches agent failures that don't throw (e.g., early stop, context
    // building succeeded but the PUT /api/context/today call was skipped).
    //
    // Distinguish the two failure modes so the operator can tell from the log
    // whether the agent skipped the write entirely vs. wrote with the wrong
    // agent-day date. Pre-fix, both paths logged the same "does not exist"
    // string and the wrong-date case looked indistinguishable from a hard
    // crash, masking the date-confusion root cause.
    const todayMdState = this.diagnoseTodayMdState();
    // Parent audit row emit. The pre-routine gate
    // (`morningRoutineRanToday` in `bootstrap/schedule-helpers.ts`)
    // selects on `action_type='routine.morning_routine' AND
    // result='success'`. The two stages write their own action_types
    // (`routine.morning_routine_today` / `..._journal`), neither of
    // which the gate reads — so we synthesise the parent row here,
    // gated on Stage A success + today.md health.
    if (pipelineRun !== null) {
      const todayMdHealth = mapDiagnoseToHealth(todayMdState);
      // Land the `journal/agent.md` block BEFORE the parent-audit row
      // emit so the gate-fire moment (which the dashboard / monitoring
      // tooling reads as "morning routine is done") follows the journal
      // write, not precedes it. The appender is self-gating on Stage A's
      // row presence — it returns `stage_a_row_missing` (not throws)
      // when the row is absent, so we just log the skip reason.
      try {
        const appenderOutcome = await this.pipelineOrchestrator.appendAgentJournalEntry({
          correlationId: effectiveEvent.correlationId,
        });
        if (appenderOutcome === null) {
          logger.debug(
            { correlationId: effectiveEvent.correlationId },
            "Morning pipeline journal appender skipped — orchestrator constructed without journal-side deps",
          );
        } else if (appenderOutcome.ok) {
          logger.info(
            {
              correlationId: effectiveEvent.correlationId,
              entryBytes: appenderOutcome.entryText.length,
            },
            "Morning pipeline agent/journal.md entry appended",
          );
        } else {
          logger.warn(
            {
              correlationId: effectiveEvent.correlationId,
              reason: appenderOutcome.reason,
            },
            "Morning pipeline agent/journal.md entry NOT appended",
          );
        }
      } catch (err) {
        // Appender failures are best-effort telemetry — never block
        // the parent-audit emit / today.md health flow on a journal
        // write hiccup. The fs write is atomic + snapshot-backed; the
        // only realistic failure mode here is a malformed
        // `agent_actions.metadata` JSON that the composer mis-parses.
        logger.error(
          { err, correlationId: effectiveEvent.correlationId },
          "Morning pipeline journal appender threw — continuing to parent-audit emit",
        );
      }
      const emitOutcome = this.pipelineOrchestrator.emitParentAuditRow({
        correlationId: effectiveEvent.correlationId,
        startedAt: pipelineRun.startedAt,
        todayMdHealth,
        ...(stageAResult?.backendId ? { backend: stageAResult.backendId } : {}),
      });
      if (emitOutcome.emitted) {
        logger.info(
          {
            correlationId: effectiveEvent.correlationId,
            parentAuditRowId: emitOutcome.insertedId,
            todayMdHealth,
            stageBPresent: pipelineRun.stageBResult !== null,
          },
          "Morning pipeline parent audit row emitted",
        );
      } else {
        logger.warn(
          {
            correlationId: effectiveEvent.correlationId,
            reason: emitOutcome.reason,
            todayMdHealth,
          },
          "Morning pipeline parent audit row NOT emitted — pre-routine gate will not fire for this run",
        );
      }
    }
    if (todayMdState.kind !== "fresh") {
      logger.warn(
        {
          eventType: effectiveEvent.type,
          isError: stageAResult?.isError ?? null,
          numTurns: stageAResult?.numTurns ?? null,
          orchestratorThrew: pipelineRun === null,
          todayMdState: todayMdState.kind,
          ...(todayMdState.kind === "wrong_date"
            ? {
                writtenDate: todayMdState.writtenDate,
                expectedAgentDay: todayMdState.expectedAgentDay,
              }
            : {}),
        },
        todayMdState.kind === "missing"
          ? "Morning routine completed but today.md does not exist — scheduling retry"
          : "Morning routine completed but today.md has wrong agent-day date — scheduling retry",
      );
      this.scheduleMorningRetry(effectiveEvent);
    } else {
      if (effectiveEvent.data?.deferPostMorningCatchupsUntilStartupReady === true) {
        logger.info(
          { eventType: effectiveEvent.type, source: effectiveEvent.source },
          "Deferring post-morning catchups until startup messaging is ready",
        );
      } else {
        await this.emitPostMorningCatchups(effectiveEvent);
      }
      const todayRefreshFlush = flushPendingTodayRefresh(this.db);
      if (todayRefreshFlush.hadPending) {
        logger.info(
          { scheduled: todayRefreshFlush.scheduled },
          "Flushed pending today_refresh after morning routine",
        );
      }
    }

    // Post-morning-routine: trigger roadmap refresh if STILL stale after
    // the agent ran. Re-checking staleness here lets the first-run
    // branch of the merged morning routine populate roadmap.md inline
    // (its Step 6b fully replaces the setup-wizard skeleton in the same
    // session) without firing a redundant `routine.roadmap_refresh`
    // afterwards — that doubled post-setup latency by ~1–2 minutes.
    //
    // The check is `staleBefore && staleNow`:
    //   - recurring day on a fresh roadmap: staleBefore=false → skip (unchanged).
    //   - either branch where agent did nothing to roadmap: still stale → emit.
    //   - first-run day where agent populated inline: staleNow=false → skip.
    //   - recurring day where agent happened to spot-update on a stale day:
    //     staleNow=false → skip the redundant refresh (pure win).
    if (roadmapStaleBeforeMorning) {
      if (effectiveEvent.data?.deferPostMorningCatchupsUntilStartupReady === true) {
        logger.info(
          { eventType: effectiveEvent.type, source: effectiveEvent.source },
          "Deferring roadmap_refresh until startup messaging is ready",
        );
      } else if (this.isRoadmapStale()) {
        this.emitRoadmapRefresh("post_morning_routine");
      } else {
        logger.info(
          { eventType: effectiveEvent.type, source: effectiveEvent.source, promptKey },
          "Skipping post-morning roadmap_refresh — agent populated roadmap.md inline",
        );
      }
    }
    } finally {
      // B3 fix: clear `morningRoutineInProgress` only AFTER the parent
      // audit row is durable (journal append + emitParentAuditRow above).
      // Reached on every post-finally exit path — success/catchup,
      // retry-scheduled, and the `pipelineRun === null` branch — so a
      // Stage-A failure cannot leak the flag and wedge activity_scan.
      this.setMorningRoutineInProgress(false);
    }
  }

  private async emitPostMorningCatchups(event: Event): Promise<void> {
    const queuedRoutines = Array.isArray(event.data?.postCatchupRoutines)
      ? event.data.postCatchupRoutines.filter((value): value is string => typeof value === "string")
      : [];

    for (const routine of queuedRoutines) {
      logger.info({ routine }, "Emitting deferred post-morning catchup routine");
      await this.eventBus.put({
        ...createEvent({
          type: `routine.${routine}`,
          source: "post_morning_catchup",
          priority: EventPriority.HIGH,
        }),
        routine,
      } as RoutineEvent);
    }

    if (event.data?.postCatchupActivityScan === true) {
      logger.info("Triggering deferred activity_scan after morning catchup");
      await this.triggerActivityScan("post_morning_catchup");
    }
  }

  /**
   * Schedule a retry of the morning routine when today.md wasn't generated.
   *
   * Uses the existing agent_schedule → ScheduleWatcher path rather than
   * re-enqueuing on the EventBus directly. Benefits:
   * 1. Retry persists across daemon restarts.
   * 2. Shares the same Opus cost-limit and concurrency gates.
   * 3. Back-off delay is enforced by scheduled_for timestamp.
   *
   * Retry policy: exponential back-off (5 min → 10 min → 15 min), max 3
   * attempts. After the 3rd failure, send a critical notification to
   * the user and stop retrying.
   *
   * Retry count is tracked via `event.data.retryCount` on the RoutineEvent.
   * On the first failure the count comes from the cron-fired RoutineEvent
   * (undefined → 0). On subsequent failures handleMorningRoutineRetry
   * synthesizes a new RoutineEvent carrying the previous count from the
   * wake task's taskContext, so the chain propagates through a single
   * code path: event.data.retryCount → +1 → task_context.retryCount
   * → next event.data.retryCount → ...
   *
   * Dedup protects against pathological cases:
   *  - M1: another retry is already pending/running → skip
   */
  scheduleMorningRetry(event: Event): void {
    const previousCount = Number(event.data?.retryCount ?? 0);
    const retryCount = previousCount + 1;
    const MAX_RETRIES = 3;

    // Preserve the original cron morning_routine correlationId through
    // the chain if present. On the first call this is the cron event's
    // own id. On later calls it's propagated via event.correlationId
    // (which handleMorningRoutineRetry sets from taskCtx).
    const originalCorrelationId =
      (event.data?.originalCorrelationId as string | undefined) ??
      event.correlationId;

    if (retryCount > MAX_RETRIES) {
      logger.error(
        {
          retryCount: previousCount,
          maxRetries: MAX_RETRIES,
          originalCorrelationId,
        },
        "Morning routine retry exhausted — sending critical notification",
      );
      void this.notificationMgr
        .send(
          `⚠️ Morning routine failed to generate today.md after ${MAX_RETRIES} attempts. Please regenerate manually from the dashboard.`,
          event,
          { category: "critical", priority: "critical" },
        )
        .catch((err) => {
          logger.error(
            { err },
            "Failed to send morning-routine-retry-exhausted notification",
          );
        });
      return;
    }

    // Exponential back-off: 5 / 10 / 15 minutes
    const delayMinutes = retryCount * 5;
    const retryTime = new Date(Date.now() + delayMinutes * 60 * 1000);
    const scheduledFor = formatSqliteDatetime(retryTime);

    // Encode the retry state in task_context so the wake agent (via
    // executeScheduledTask → handleMorningRoutineRetry) can propagate
    // retryCount into the synthesized RoutineEvent's event.data.
    // `importance: "low"` keeps the retry out of roadmap.md — the
    // originating morning_routine is already tracked elsewhere.
    const taskContext = JSON.stringify({
      routine: "morning_routine",
      retryCount,
      originalCorrelationId,
      source: typeof event.data?.queuedSource === "string" ? event.data.queuedSource : event.source,
      postCatchupRoutines: Array.isArray(event.data?.postCatchupRoutines)
        ? event.data.postCatchupRoutines
        : [],
      postCatchupActivityScan: event.data?.postCatchupActivityScan === true,
      importance: "low",
    });

    // M1: dedup + INSERT in a single transaction so two concurrent
    // retry schedulers cannot both race past the dedup check and both
    // insert new rows. better-sqlite3 is synchronous so the transaction
    // callback runs atomically relative to any other DB access from
    // this process.
    //
    // Dedup checks for 'pending' only — not 'running' — because the
    // retry chain legitimately calls this method while the current
    // wake task is still in 'running' state (handleMorningRoutineRetry
    // → executeMorningRoutine → this). Including 'running' would break chain
    // continuation.
    const insertRetryTxn = this.db.transaction(() => {
      // C5 fix: dedup on task_context.routine, not task_description prefix.
      // Both `scheduleMorningRetry` (here) and `isMorningRoutineActive`
      // (above) now use the same JSON-path check, so the detection path
      // doesn't depend on the human-readable description string.
      const existing = this.db
        .prepare(
          `SELECT id FROM agent_schedule
           WHERE task_type = 'wake'
             AND status = 'pending'
             AND json_extract(task_context, '$.routine') = 'morning_routine'
           LIMIT 1`,
        )
        .get() as { id: number } | undefined;
      if (existing) {
        return { inserted: false as const, existingId: existing.id };
      }
      const retryInstruction = `Morning routine retry (attempt ${retryCount}/${MAX_RETRIES}). Generate today.md per the morning_routine flow.`;
      this.db
        .prepare(
          `INSERT INTO agent_schedule
             (scheduled_for, task_type, task_description, task_prompt, task_context, correlation_id, model, status)
           VALUES (?, 'wake', ?, ?, ?, ?, NULL, 'pending')`,
        )
        .run(
          scheduledFor,
          // task_description (list label) and task_prompt (agent instruction)
          // are the same string for this system-generated row.
          retryInstruction,
          retryInstruction,
          taskContext,
          originalCorrelationId,
        );
      return { inserted: true as const };
    });

    try {
      const outcome = insertRetryTxn();
      if (!outcome.inserted) {
        logger.info(
          {
            existingScheduleId: outcome.existingId,
            retryCount,
            originalCorrelationId,
          },
          "Morning routine retry dedup — another pending retry already exists",
        );
        return;
      }
      logger.info(
        {
          retryCount,
          delayMinutes,
          scheduledFor,
          originalCorrelationId,
          // Retries always fall back to the medium tier (Sonnet) per the
          // cost-cap fix in executeMorningRoutine — surface that explicitly
          // in the schedule log so the operator can confirm the
          // downgrade happened without grepping the next agent-execute line.
          plannedTier: "medium",
          plannedTierReason: "morning_routine_retry_cost_cap",
        },
        "Morning routine retry scheduled (will run on Sonnet)",
      );
      // Route the INSERT through the shared roadmap-refresh gate.
      // `importance:"low"` short-circuits the trigger — the morning
      // routine is already represented elsewhere — but going through
      // the helper keeps all five INSERT call-sites on one path.
      maybeTriggerRoadmapRefresh(
        { scheduledFor, taskContext: { importance: "low" } },
        (src) => this.emitRoadmapRefresh(src),
        "morning_retry",
      );
    } catch (err) {
      logger.error(
        { err, retryCount },
        "Failed to schedule morning routine retry",
      );
    }
  }
}
