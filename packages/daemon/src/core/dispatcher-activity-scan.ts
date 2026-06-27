/**
 * `ActivityScanCoordinator` — owns the dispatcher's
 * `triggerActivityScan` entry point and the cost-reduction-structural §B
 * three-stage gate that fronts it. The coordinator decides whether a
 * given hourly tick:
 *   - skips (autonomous gate / morning routine active / already running
 *     / below threshold);
 *   - silently consumes observations + records an Agent Log line
 *     (Stage 0 deterministic gate or Stage 2 lite-tier `log_only`);
 *   - escalates to the existing Stage 3 enqueue (Stage 2 `escalate`
 *     verdict or `failed` cautious-escalate path).
 *
 * Extracted from `core/dispatcher.ts` as part of phase D-2 of
 * `docs/design/appendices/file-split-plan.md`. Pattern B (stateful
 * coordinator): the coordinator owns the gate logic but borrows live
 * accessors for state the dispatcher continues to own — the
 * `activityScanInProgress` flag (atomic check-and-set inside the
 * trigger), the `morningRoutineInProgress` flag (read-only), and the
 * lazily-injected delegated-sync refresh callback.
 *
 * Dispatcher entry points served:
 *   - `EventDispatcher.triggerActivityScan(source, options)` is now a
 *     thin one-liner that delegates to `trigger(source, options)`.
 *
 * Invariants preserved bit-for-bit from
 * `docs/design/02-event-pipeline.md` §2:
 *   - skip-if-morning-routine-in-progress;
 *   - skip-if-hourly-already-running (atomic flag flip BEFORE any
 *     await boundary — the C1 race fix from before the split);
 *   - skip-if-pending-observations-below-threshold (legacy
 *     min-observations floor honoured only when the gate would have
 *     proceeded to Stage 3 anyway);
 *   - skip-if-setup-incomplete / vault-degraded / user-paused via
 *     `isAutonomousAllowed`.
 *
 * Shared-state references held:
 *   - `setActivityScanInProgress` / `isActivityScanInProgress` —
 *     getter/setter pair around the dispatcher's flag. The flag is
 *     left `true` when an enqueue actually happens (the EventBus
 *     consumer's `dispatchSafe` finally clears it on routine
 *     completion); it is reset inline when the coordinator owns the
 *     turn (silent gate paths) or when the trigger is skipping.
 *   - `isMorningRoutineActive` — read-only mirror of the dispatcher
 *     method so the gate stays single-sourced.
 *   - `isAutonomousAllowed` — same; returns the
 *     `TriggerActivityScanSkipReason` the gate should surface.
 *   - `getDelegatedSyncRefresh` — accessor; null when no delegated
 *     integration is wired, in which case the gate proceeds without
 *     a refresh, matching pre-injection behaviour.
 */

import type Database from "better-sqlite3";
import type {
  AgentResult,
  BackendId,
  IntegrationKey,
  ProcessKey,
  RoutineEvent,
} from "@aitne/shared";
import {
  EventPriority,
  INTEGRATION_KEYS,
  createEvent,
} from "@aitne/shared";
import { readIntegrations } from "../db/integrations-store.js";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentConfig } from "../config.js";
import { CONTEXT_RELATIVE_PATHS } from "./context-paths.js";
import { getContextDir } from "../config.js";
import type { EventBus } from "./event-bus.js";
import {
  consumeObservations,
  getPendingCount,
  getPendingObservations,
} from "../db/observations.js";
import { computeActivityScanSignals } from "../db/activity-scan-signals.js";
import {
  buildGateAuditDetail,
  decideStage,
  renderGateDecisionBlock,
  type ActivityScanGateDecision,
  type ActivityScanGateStage,
} from "../scheduler/activity-scan-gate.js";
import { appendAgentLogLine } from "./today-direct-writer.js";
import type { TodayWriteLockManager } from "./today-write-lock.js";
import type { IAgentRouter } from "./backends/backend-router.js";
import type {
  IAuditLogger,
  IContextBuilder,
  TriggerActivityScanOptions,
  TriggerActivityScanResult,
  TriggerActivityScanSkipReason,
} from "./dispatcher-types.js";
import { parseStage2Verdict } from "./dispatcher-types.js";
import { morningRoutineRanToday } from "../bootstrap/schedule-helpers.js";
import type { PromptAssembler } from "./dispatcher-prompt.js";
import type { RoutineFetchWindowRunner } from "./routine-fetch-window-runner.js";
import { prePassLastRunRuntimeStateKey } from "./pre-pass-freshness.js";
import { readRuntimeState } from "../db/runtime-state.js";
import { getRuntimeWindow } from "../db/agents-store.js";
import { resolveActivityScanCadence } from "./agents/activity-scan-cadence.js";
import { createLogger } from "../logging.js";

const logger = createLogger("dispatcher-activity-scan");

export interface ActivityScanCoordinatorDeps {
  db: Database.Database;
  config: AgentConfig;
  eventBus: EventBus;
  contextBuilder: IContextBuilder;
  agentRouter: IAgentRouter;
  audit: IAuditLogger;
  todayWriteLock: TodayWriteLockManager | undefined;
  prompt: PromptAssembler;
  /**
   * docs/design/appendices/routine-data-acquisition.md Phase 4 / D3 — pre-pass runner
   * spawned between Stage 2 (lite-tier triage) and Stage 3 (medium-tier
   * main session) on `escalate` / `failed` verdicts. The rendered
   * `<fetch_report>` block rides on the Stage 3 RoutineEvent's
   * `event.data.fetchReportBlock` so ContextBuilder folds it into the
   * Stage 3 prompt.
   */
  fetchWindowRunner: RoutineFetchWindowRunner;
  /** Accessor for the lazily-injected delegated-sync refresh callback. */
  getDelegatedSyncRefresh: () => (() => Promise<void>) | null;
  /** Setter for the dispatcher's `activityScanInProgress` flag. */
  setActivityScanInProgress: (value: boolean) => void;
  /** Getter for the dispatcher's `activityScanInProgress` flag. */
  isActivityScanInProgress: () => boolean;
  /** Mirrors `EventDispatcher.isMorningRoutineActive`. */
  isMorningRoutineActive: () => boolean;
  /**
   * Mirrors `EventDispatcher.isAutonomousAllowed`. Returns the
   * skip-reason when the gate must abort early (setup incomplete,
   * vault degraded, user paused) or `null` when autonomous work is
   * permitted to proceed.
   */
  isAutonomousAllowed: () => TriggerActivityScanSkipReason | null;
  /**
   * Accessor for the scheduler's `queueMorningRoutineWake`. Returns the
   * bound function once wiring has completed, or `null` early in startup
   * before the scheduler is constructed. The pre-routine gate calls this
   * when it detects the current agent-day's morning_routine has not run
   * yet (typical cause: Mac slept through the 04:00 cron tick). The
   * wake row carries the dedup guarantee — multiple back-to-back hourly
   * ticks all see the same in-flight row instead of stacking up.
   */
  getQueueMorningRoutineWake: () => QueueMorningRoutineWake | null;
}

/** Signature of `AgentScheduler.queueMorningRoutineWake`, narrowed to the
 *  surface the dispatcher gate consumes. Kept structural so we don't pull
 *  the scheduler class into this module just for a type reference. */
export type QueueMorningRoutineWake = (
  source: string,
  options?: { postCatchupRoutines?: string[]; postCatchupActivityScan?: boolean },
) => { inserted: boolean; existingId?: number };

/**
 * HOURLY_CHECK_GATE_REDESIGN_PLAN.md §3.3 + §7.2 — outcome of the
 * Layer-1 pre-pass harvest that runs at the top of `trigger()` for
 * delegated/native integrations. Surfaced both in the audit row (per-
 * tick observability) and on the Stage 3 event (the rendered
 * `<fetch_report>` block).
 */
export interface HarvestResult {
  /** True when at least one integration was eligible and the runner ran. */
  ran: boolean;
  /** Integrations whose sub-session completed successfully or partially. */
  integrations: IntegrationKey[];
  /** Eligible integrations suppressed by the freshness window. */
  skippedIntegrations: IntegrationKey[];
  /** Eligible integrations whose sub-session ended in `failed`. */
  failedIntegrations: IntegrationKey[];
  /** Wall-clock time spent on the harvest (ms). */
  durationMs: number;
  /**
   * True when any eligible integration failed. Triggers §3.5 cautious-
   * escalate: gate decision is forced to `stage3` regardless of the
   * signal verdict so a fetch outage doesn't manifest as silent
   * stage0.
   */
  failed: boolean;
  /**
   * Rendered `<fetch_report>` block from the runner, ready to plumb
   * onto `stage3Event.data.fetchReportBlock`. `null` when the runner
   * was not spawned (no eligible integrations) — in that case the
   * Stage 3 prompt simply omits the block.
   */
  fetchReportBlock: string | null;
}

export class ActivityScanCoordinator {
  private readonly db: Database.Database;
  private readonly config: AgentConfig;
  private readonly eventBus: EventBus;
  private readonly contextBuilder: IContextBuilder;
  private readonly agentRouter: IAgentRouter;
  private readonly audit: IAuditLogger;
  private readonly todayWriteLock: TodayWriteLockManager | undefined;
  private readonly prompt: PromptAssembler;
  private readonly fetchWindowRunner: RoutineFetchWindowRunner;
  private readonly getDelegatedSyncRefresh: () => (() => Promise<void>) | null;
  private readonly setActivityScanInProgress: (value: boolean) => void;
  private readonly isActivityScanInProgress: () => boolean;
  private readonly isMorningRoutineActive: () => boolean;
  private readonly isAutonomousAllowed: () => TriggerActivityScanSkipReason | null;
  private readonly getQueueMorningRoutineWake: () => QueueMorningRoutineWake | null;

  constructor(deps: ActivityScanCoordinatorDeps) {
    this.db = deps.db;
    this.config = deps.config;
    this.eventBus = deps.eventBus;
    this.contextBuilder = deps.contextBuilder;
    this.agentRouter = deps.agentRouter;
    this.audit = deps.audit;
    this.todayWriteLock = deps.todayWriteLock;
    this.prompt = deps.prompt;
    this.fetchWindowRunner = deps.fetchWindowRunner;
    this.getDelegatedSyncRefresh = deps.getDelegatedSyncRefresh;
    this.setActivityScanInProgress = deps.setActivityScanInProgress;
    this.isActivityScanInProgress = deps.isActivityScanInProgress;
    this.isMorningRoutineActive = deps.isMorningRoutineActive;
    this.isAutonomousAllowed = deps.isAutonomousAllowed;
    this.getQueueMorningRoutineWake = deps.getQueueMorningRoutineWake;
  }

  async trigger(
    source: string,
    options: TriggerActivityScanOptions = {},
  ): Promise<TriggerActivityScanResult> {
    const forced = options.force === true;
    // Observation threshold comes from the activity-scan agent row's
    // runtime_window, with the legacy `activityScanMinObservations` config key
    // as fallback (AGENTS_HUB_REDESIGN_PLAN.md §2).
    const minObservations = resolveActivityScanCadence(
      getRuntimeWindow(this.db, "activity-scan"),
      this.config,
    ).minObservations;

    // C1 fix: atomic check-and-set on activityScanInProgress BEFORE any await
    // boundary. Previously `await this.isMorningRoutineActive()` yielded to
    // the microtask queue, allowing cron + /api/agent/run-now arriving in
    // the same tick to both observe `activityScanInProgress === false` and
    // both enqueue. Because Node is single-threaded and better-sqlite3 is
    // synchronous, doing set-first + sync checks + rollback-on-skip is now
    // race-free.
    if (this.isActivityScanInProgress()) {
      logger.info({ source }, "Activity scan skipped — previous activity scan is still running");
      return {
        status: "skipped",
        reason: "activity_scan_in_progress",
        minObservations,
        forced,
      };
    }
    this.setActivityScanInProgress(true);

    // Rollback flag unless we actually enqueue the event or land on a
    // silent path that owns its own reset.
    let enqueued = false;
    let silentPathOwnsReset = false;
    try {
      const setupBlock = this.isAutonomousAllowed();
      if (setupBlock !== null) {
        logger.info(
          { source, reason: setupBlock },
          "Activity scan skipped — autonomous work paused for setup",
        );
        return {
          status: "skipped",
          reason: setupBlock,
          minObservations,
          forced,
        };
      }

      if (this.isMorningRoutineActive()) {
        logger.info({ source }, "Activity scan skipped — morning routine is active");
        return {
          status: "skipped",
          reason: "morning_routine_active",
          minObservations,
          forced,
        };
      }

      // Pre-routine morning_routine gate. The signal is the
      // `agent_actions` row (not today.md) because today.md can be
      // user-edited and lie about completion — see the 2026-05-14
      // sleep-skip incident captured in `morningRoutineRanToday`'s
      // doc. When the gate trips, we enqueue a wake row so the
      // morning_routine catches up on the next watcher tick, then
      // skip the current hourly tick. The next hourly cron tick will
      // see the action row and proceed normally; `queueMorningRoutineWake`
      // dedups across back-to-back trips so a sleep gap covering many
      // hours produces exactly one wake row.
      if (!morningRoutineRanToday(this.db, this.config)) {
        const queueWake = this.getQueueMorningRoutineWake();
        if (queueWake) {
          const queueResult = queueWake(`activity_scan_dependency:${source}`);
          logger.info(
            { source, queueResult },
            "Activity scan skipped — morning_routine not yet complete for current agent-day; enqueued morning_routine wake",
          );
        } else {
          logger.warn(
            { source },
            "Activity scan skipped — morning_routine not yet complete and queueMorningRoutineWake not wired",
          );
        }
        return {
          status: "skipped",
          reason: "morning_routine_pending_for_today",
          minObservations,
          forced,
        };
      }

      // Refresh delegated-sync snapshots for any cadence the operator
      // left opted-OUT (the post-Phase-9 default). Without this, Gmail /
      // Notion observations would dry up entirely in delegated mode and
      // the routine.activity_scan.delegated.* task flow's Step 0a / 0c
      // would have nothing to consume — Step 1's `/api/observations`
      // call would return only Obsidian / Git rows. Calendar's Step 0b
      // already fetches actively via `/reconcile`, so the gap is
      // specific to gmail / notion. See `docs/design/appendices/
      // delegated-sync-opt-in.md` and the worker's
      // `runDisabledCadencesForActivityScan` doc-comment for the full
      // reasoning. Failures are logged but do NOT block the check —
      // a stuck cadence cannot starve the entire hourly loop.
      const delegatedSyncRefresh = this.getDelegatedSyncRefresh();
      if (delegatedSyncRefresh) {
        try {
          await delegatedSyncRefresh();
        } catch (err) {
          logger.warn(
            { err, source },
            "Pre-activity-scan delegated sync refresh failed; proceeding with stale snapshot",
          );
        }
      }

      // HOURLY_CHECK_GATE_REDESIGN_PLAN.md Layer 1 — pre-pass harvest
      // for delegated/native integrations BEFORE the gate signal
      // computation. Direct-mode integrations rely on their in-process
      // pollers and are not touched here. The freshness window
      // (`activityScanPrePassFreshnessMinutes`, default 30 min) bounds
      // Haiku spend; forced runs (`/api/agent/run-now`) bypass the
      // window so the operator always sees fresh data.
      //
      // Failures surface as `harvest.failed === true`; combined with
      // §3.5 cautious-escalate the gate force-runs Stage 3 so a
      // transient fetch outage doesn't manifest as silent stage0.
      const harvest = await this.harvestForGate(source, forced);

      // Layer 2 — gate signals are now mode-blind. The actor='user'
      // filter has been dropped (HOURLY_CHECK_GATE_REDESIGN_PLAN.md
      // Phase 1+2): delegated-sync-worker and pre-pass both POST
      // actor='agent' rows that represent real activity. The
      // signal-compute filters by source-prefix sets derived from
      // `INTEGRATION_DESCRIPTORS` instead.
      const pendingCount = getPendingCount(this.db);

      // Layer 2+3 — compute gate verdict.
      const baseDecision = this.computeActivityScanGateDecision();

      // §3.5 cautious-escalate: when pre-pass failed for any non-direct
      // integration, force `stage3` regardless of the signal verdict.
      // The Stage 3 prompt carries the `<fetch_report status="failed">`
      // block so the routine knows the fetch was lossy. We preserve the
      // pre-overwrite gate verdict so the audit row carries both views
      // (`gate_stage`/`gate_reason` show the cautious-escalate label
      // the prompt sees; `pre_escalate_gate_stage`/`_reason` show what
      // the gate would have said without the pre-pass failure).
      const cautiousEscalate = harvest.failed;
      const decision: ActivityScanGateDecision = cautiousEscalate
        ? {
            ...baseDecision,
            stage: "stage3",
            reason: "cautious_escalate_prepass_failure",
          }
        : baseDecision;
      const preEscalate = cautiousEscalate
        ? { stage: baseDecision.stage, reason: baseDecision.reason }
        : null;

      // Honour the legacy min-observations floor only when the gate
      // would have proceeded to Stage 3 anyway. The silent gate path
      // already short-circuits the noisy "1 obs, no signal" case below
      // it, so keeping the floor active there would just suppress the
      // gate's telemetry. The native-integration §6.5.1 bypass is no
      // longer needed — the gate's signal compute now sees pre-pass +
      // delegated-sync rows directly.
      if (
        !forced
        && !cautiousEscalate
        && decision.stage === "stage3"
        && pendingCount < minObservations
      ) {
        this.logGateAuditRow(decision, {
          appliedDecision: "stage3",
          forced,
          harvest,
          preEscalate,
          // Mark the row as a skip even though the gate wanted Stage 3 —
          // the legacy min-observations floor short-circuited it. Without
          // this, every `below_threshold` skip would persist as a phantom
          // `result='success'` row in the audit feed.
          resultOverride: "skipped",
          extra: { skipped: "below_threshold" },
        });
        return {
          status: "skipped",
          reason: "below_threshold",
          pendingCount,
          minObservations,
          forced,
          gateStage: decision.stage,
          gateReason: decision.reason,
        };
      }

      if (decision.stage === "stage0_silent") {
        const silentResult = this.runSilentActivityScanPath(decision, "stage0_silent", {
          source,
          forced,
          harvest,
          preEscalate,
        });
        silentPathOwnsReset = true;
        return {
          ...silentResult,
          minObservations,
          gateStage: decision.stage,
          gateReason: decision.reason,
          appliedStage: "stage0_silent",
        };
      }

      if (decision.stage === "stage2") {
        const verdict = await this.runStage2Triage(decision, source);
        if (verdict === "log_only") {
          const silentResult = this.runSilentActivityScanPath(
            decision,
            "stage2_log_only",
            { source, forced, harvest, preEscalate },
          );
          silentPathOwnsReset = true;
          return {
            ...silentResult,
            minObservations,
            gateStage: decision.stage,
            gateReason: decision.reason,
            appliedStage: "stage2_log_only",
          };
        }
        // verdict === 'escalate' OR 'failed' (failed → cautious escalate
        // since a malformed JSON should not silently skip a hour's worth
        // of signals; matches the prompt contract's stated default).
        await this.enqueueStage3ActivityScan(
          source,
          decision,
          {
            forced,
            pendingCount,
            requestedModel: options.requestedModel,
            stage2Verdict: verdict,
            harvest,
            cautiousEscalate,
            preEscalate,
          },
        );
        enqueued = true;
        return {
          status: "queued",
          pendingCount,
          minObservations,
          forced,
          gateStage: decision.stage,
          gateReason: decision.reason,
          appliedStage: "stage3",
          ...(cautiousEscalate ? { cautiousEscalate: true } : {}),
        };
      }

      // decision.stage === 'stage3'
      await this.enqueueStage3ActivityScan(
        source,
        decision,
        {
          forced,
          pendingCount,
          requestedModel: options.requestedModel,
          harvest,
          cautiousEscalate,
          preEscalate,
        },
      );
      enqueued = true;
      return {
        status: "queued",
        pendingCount,
        minObservations,
        forced,
        gateStage: decision.stage,
        gateReason: decision.reason,
        appliedStage: "stage3",
        ...(cautiousEscalate ? { cautiousEscalate: true } : {}),
      };
    } finally {
      // Flag is only left true when we successfully enqueued OR the
      // silent path explicitly opted out of resetting (it resets at
      // the end of its own helper). The event loop's dispatchSafe()
      // finally block clears the flag when an enqueued routine event
      // finishes processing.
      if (!enqueued && !silentPathOwnsReset) {
        this.setActivityScanInProgress(false);
      }
    }
  }

  /**
   * HOURLY_CHECK_GATE_REDESIGN_PLAN.md §3.3 Layer 1 — pre-pass harvest
   * for active non-direct integrations. Reads the per-integration
   * `pre_pass_last_run:<key>` freshness key; integrations whose last
   * successful run is within `activityScanPrePassFreshnessMinutes` are
   * skipped this tick. Forced runs (`/api/agent/run-now`) bypass the
   * freshness gate.
   *
   * Returns a `HarvestResult` so the caller can:
   *   - emit telemetry (which integrations fetched, which skipped on
   *     freshness, which failed),
   *   - cautious-escalate when any non-direct integration failed
   *     (§3.5 — prevents silent stage0 from masking a fetch outage),
   *   - plumb the rendered `<fetch_report>` block onto the Stage 3
   *     event so ContextBuilder folds it into the prompt.
   */
  private async harvestForGate(
    source: string,
    forced: boolean,
  ): Promise<HarvestResult> {
    const startedAt = Date.now();
    const integrations = readIntegrations(this.db);
    const freshnessMinutes =
      this.config.activityScanPrePassFreshnessMinutes ?? 30;
    const freshnessMs = Math.max(0, freshnessMinutes) * 60 * 1000;
    const now = Date.now();

    const eligibleIntegrations: IntegrationKey[] = [];
    const skipped: IntegrationKey[] = [];
    for (const key of INTEGRATION_KEYS) {
      const state = integrations[key];
      if (!state) continue;
      // Only non-direct integrations participate in pre-pass harvest.
      // Direct-mode integrations rely on their in-process pollers; their
      // observations land in `observations` independently of the gate.
      if (state.mode !== "delegated" && state.mode !== "native") continue;
      if (forced || freshnessMs === 0) {
        eligibleIntegrations.push(key);
        continue;
      }
      const last = readRuntimeState<string>(
        this.db,
        prePassLastRunRuntimeStateKey(key),
      );
      const lastMs = last ? Date.parse(last) : NaN;
      if (Number.isFinite(lastMs) && now - lastMs < freshnessMs) {
        skipped.push(key);
        continue;
      }
      eligibleIntegrations.push(key);
    }

    if (eligibleIntegrations.length === 0) {
      return {
        ran: false,
        integrations: [],
        skippedIntegrations: skipped,
        failedIntegrations: [],
        durationMs: Date.now() - startedAt,
        failed: false,
        fetchReportBlock: null,
      };
    }

    // Manufacture a placeholder activity_scan event so the runner can
    // derive `RoutineWindowKey` and the agent-day. The runner's own
    // `prepass_started` / `prepass_completed` SSE pair carries the
    // correlation id back to the dashboard.
    const parentEvent: RoutineEvent = {
      ...createEvent({
        type: "routine.activity_scan",
        source,
        priority: EventPriority.NORMAL,
      }),
      routine: "activity_scan",
      data: { forced },
    } as RoutineEvent;

    let result: Awaited<ReturnType<RoutineFetchWindowRunner["run"]>>;
    try {
      result = await this.fetchWindowRunner.run(
        parentEvent,
        "routine.activity_scan",
        { integrationKeyFilter: new Set(eligibleIntegrations) },
      );
    } catch (err) {
      // Runner errors never propagate per design — but as a defensive
      // floor we treat any throw as a hard failure across all eligible
      // integrations so cautious-escalate kicks in.
      logger.error(
        { err, source, eligibleIntegrations },
        "harvestForGate: fetchWindowRunner.run threw — forcing cautious escalate",
      );
      return {
        ran: true,
        integrations: [],
        skippedIntegrations: skipped,
        failedIntegrations: eligibleIntegrations,
        durationMs: Date.now() - startedAt,
        failed: true,
        fetchReportBlock: null,
      };
    }

    const perIntegration = result.report.perIntegration ?? [];
    const fetched: IntegrationKey[] = [];
    const failed: IntegrationKey[] = [];
    for (const sub of perIntegration) {
      if (sub.status === "success") fetched.push(sub.integrationKey);
      else if (sub.status === "failed") failed.push(sub.integrationKey);
      else if (sub.status === "partial") fetched.push(sub.integrationKey);
      // skipped → no per-integration list entry; suppressed silently.
    }

    return {
      ran: true,
      integrations: fetched,
      skippedIntegrations: skipped,
      failedIntegrations: failed,
      durationMs: Date.now() - startedAt,
      failed: failed.length > 0,
      fetchReportBlock: result.block,
    };
  }

  /**
   * cost-reduction-structural §B — pull a fresh signal snapshot and run
   * the deterministic gate. Helper so the dispatcher's call site stays
   * compact and tests can spy on the boundary.
   */
  private computeActivityScanGateDecision(): ActivityScanGateDecision {
    const todayMd = this.readTodayMdSafe();
    const signals = computeActivityScanSignals(this.db, {
      vipMailSenders: this.config.vipMailSenders ?? [],
      todayMd,
      // Pass the configured agent timezone so `agentPlanOverdueCount`
      // compares HH:MM rows in the right zone. Falls back to the
      // engine's local TZ inside `computeActivityScanSignals` when this
      // config field is empty (the common single-user case).
      ...(this.config.timezone
        ? { agentTimezone: this.config.timezone }
        : {}),
    });
    return decideStage(signals, {
      heartbeatHours: this.config.activityScanHeartbeatHours ?? 4,
      stage2Enabled: this.config.activityScanStage2Enabled ?? false,
      pendingObsLowSignalCeiling: this.config.activityScanLowSignalPendingCeiling ?? 0,
    });
  }

  private readTodayMdSafe(): string | null {
    try {
      const path = join(
        getContextDir(this.config, this.db),
        CONTEXT_RELATIVE_PATHS.today,
      );
      if (!existsSync(path)) return null;
      return readFileSync(path, "utf-8");
    } catch (err) {
      logger.warn({ err }, "Failed to read today.md for activity_scan signals");
      return null;
    }
  }

  /**
   * cost-reduction-structural §B — daemon-direct silent path. Used by
   * Stage 0 and Stage 2 log-only verdicts. Consumes pending user
   * observations + appends a single Agent Log line + records the gate
   * verdict to `agent_actions`. The flag is reset before return.
   */
  private runSilentActivityScanPath(
    decision: ActivityScanGateDecision,
    appliedDecision: "stage0_silent" | "stage2_log_only",
    ctx: {
      source: string;
      forced: boolean;
      harvest: HarvestResult;
      preEscalate: { stage: ActivityScanGateStage; reason: string } | null;
    },
  ): { status: "skipped"; reason: TriggerActivityScanSkipReason; pendingCount: number; forced: boolean } {
    const reason: TriggerActivityScanSkipReason =
      appliedDecision === "stage0_silent"
        ? "gate_stage0_silent"
        : "gate_stage2_log_only";
    let pendingCount = 0;
    try {
      pendingCount = decision.signals.pendingObsCount;

      // Append a single bullet to today.md ## Agent Log. Best-effort —
      // when today.md is missing or the lock is held, we still consume
      // the observations so the queue doesn't grow indefinitely.
      const message =
        appliedDecision === "stage0_silent"
          ? `[activity_scan] Quiet (${decision.reason}) — ${pendingCount} obs consumed silently`
          : `[activity_scan] Stage 2 log-only (${decision.reason}) — ${pendingCount} obs consumed silently`;
      if (this.todayWriteLock) {
        // Fire-and-forget: the silent-path return is a sync object the
        // gate caller needs immediately to bookkeep observations. The
        // Agent Log bullet is a best-effort trace (skipping is already
        // an accepted outcome per AppendAgentLogLineResult.reason), so
        // we don't await it. The serializer inside ensures the write
        // does not race with HTTP context PATCHes on today.md.
        void appendAgentLogLine({
          contextDir: getContextDir(this.config, this.db),
          message,
          todayWriteLock: this.todayWriteLock,
          timezone: this.config.timezone || undefined,
        }).catch((err: unknown) => {
          logger.error(
            { err },
            "Daemon-direct Agent Log append threw — silent-path observations were still consumed",
          );
        });
      }

      // Consume the observations under the gate's correlation id so
      // dashboards can attribute "consumed by gate" rows separately
      // from agent-driven consumption. The actor filter is dropped
      // (HOURLY_CHECK_GATE_REDESIGN_PLAN.md Phase 1+2) so pre-pass and
      // delegated-sync agent rows are cleared too — otherwise they
      // would accumulate on every silent tick.
      try {
        const pending = getPendingObservations(this.db, { limit: 100 });
        if (pending.length > 0) {
          consumeObservations(
            this.db,
            pending.map((row) => row.id),
            `activity_scan_gate:${appliedDecision}`,
          );
        }
      } catch (err) {
        logger.warn({ err }, "Failed to consume observations on silent gate path");
      }

      this.logGateAuditRow(decision, {
        appliedDecision,
        forced: ctx.forced,
        harvest: ctx.harvest,
        preEscalate: ctx.preEscalate,
      });
      logger.info(
        {
          source: ctx.source,
          gateStage: decision.stage,
          gateReason: decision.reason,
          appliedDecision,
          pendingCount,
        },
        "Activity scan silenced by Stage-1 gate",
      );
    } finally {
      this.setActivityScanInProgress(false);
    }
    return {
      status: "skipped",
      reason,
      pendingCount,
      forced: ctx.forced,
    };
  }

  private async enqueueStage3ActivityScan(
    source: string,
    decision: ActivityScanGateDecision,
    extra: {
      forced: boolean;
      pendingCount: number;
      requestedModel?: "sonnet" | "opus";
      stage2Verdict?: "log_only" | "escalate" | "failed";
      harvest: HarvestResult;
      cautiousEscalate: boolean;
      preEscalate: { stage: ActivityScanGateStage; reason: string } | null;
    },
  ): Promise<void> {
    const gateBlock = renderGateDecisionBlock(decision, {
      forced: extra.forced,
      cautiousEscalate: extra.cautiousEscalate,
    });
    this.logGateAuditRow(decision, {
      appliedDecision: "stage3",
      forced: extra.forced,
      harvest: extra.harvest,
      preEscalate: extra.preEscalate,
      ...(extra.cautiousEscalate ? { cautiousEscalate: true } : {}),
      ...(extra.stage2Verdict ? { stage2Verdict: extra.stage2Verdict } : {}),
    });
    const stage3Event: RoutineEvent = {
      ...createEvent({
        type: "routine.activity_scan",
        source,
        priority: EventPriority.NORMAL,
      }),
      routine: "activity_scan",
      data: {
        pendingCount: extra.pendingCount,
        forced: extra.forced,
        gateDecision: {
          stage: decision.stage,
          reason: decision.reason,
          forced: extra.forced,
          ...(extra.cautiousEscalate ? { cautiousEscalate: true } : {}),
          ...(extra.stage2Verdict ? { stage2Verdict: extra.stage2Verdict } : {}),
          block: gateBlock,
        },
        // HOURLY_CHECK_GATE_REDESIGN_PLAN.md §3.3 — Layer-1 harvest ran
        // BEFORE this enqueue so the gate could see fresh signals. The
        // rendered `<fetch_report>` block is plumbed onto the event so
        // ContextBuilder folds it into the Stage 3 prompt (the routine
        // body still relies on the block for "what arrived this tick").
        ...(extra.harvest.fetchReportBlock
          ? { fetchReportBlock: extra.harvest.fetchReportBlock }
          : {}),
      },
      ...(extra.requestedModel ? { requestedModel: extra.requestedModel } : {}),
    } as RoutineEvent;
    await this.eventBus.put(stage3Event);
  }

  private logGateAuditRow(
    decision: ActivityScanGateDecision,
    params: {
      appliedDecision:
        | ActivityScanGateStage
        | "stage2_log_only";
      forced: boolean;
      stage2Verdict?: "log_only" | "escalate" | "failed";
      /**
       * HOURLY_CHECK_GATE_REDESIGN_PLAN.md §7.2 — Layer-1 harvest
       * summary surfaced in the audit row so dashboards can see which
       * integrations were fetched on this tick.
       */
      harvest: HarvestResult;
      cautiousEscalate?: boolean;
      /**
       * HOURLY_CHECK_GATE_REDESIGN_PLAN.md §3.5 — original gate verdict
       * captured BEFORE cautious-escalate overwrote it. Persists as
       * `pre_escalate_gate_stage` / `pre_escalate_gate_reason` so
       * dashboards can answer "what would the gate have said?"
       */
      preEscalate?: { stage: ActivityScanGateStage; reason: string } | null;
      /**
       * Override the auto-derived `result` (success / skipped). Set this
       * when the gate decided Stage 3 but the legacy min-observations
       * floor short-circuited the actual run — without the override the
       * row would persist as a phantom successful Stage 3 in the audit
       * feed.
       */
      resultOverride?: "skipped" | "success";
      extra?: Record<string, unknown>;
    },
  ): void {
    try {
      // The gate-audit helper only knows about the canonical stages
      // (gate output). Map the silent-path alias `stage2_log_only` onto
      // its canonical sibling so the helper's typing stays narrow; the
      // verdict is preserved verbatim alongside `stage_reached` in the
      // merged detail.
      const auditAppliedDecision: ActivityScanGateStage =
        params.appliedDecision === "stage2_log_only"
          ? "stage0_silent"
          : (params.appliedDecision as ActivityScanGateStage);
      const detail = {
        ...buildGateAuditDetail(decision, {
          appliedDecision: auditAppliedDecision,
          forced: params.forced,
          ...(params.stage2Verdict ? { stage2Verdict: params.stage2Verdict } : {}),
          ...(params.cautiousEscalate ? { cautiousEscalate: true } : {}),
          ...(params.preEscalate
            ? {
                preEscalateGateStage: params.preEscalate.stage,
                preEscalateGateReason: params.preEscalate.reason,
              }
            : {}),
        }),
        // Always reflect the *real* applied stage in the row regardless
        // of the alias mapping above.
        stage_reached: params.appliedDecision,
        // §7.2 harvest telemetry — surfaces on every gate audit row,
        // including silent-gate skips, so per-tick cadence is observable
        // without re-querying `routine.fetch_window` rows.
        harvest_ran: params.harvest.ran,
        harvest_integrations: params.harvest.integrations,
        harvest_skipped_integrations: params.harvest.skippedIntegrations,
        harvest_failed_integrations: params.harvest.failedIntegrations,
        harvest_duration_ms: params.harvest.durationMs,
        ...(params.extra ?? {}),
      };
      const isSilentPath =
        params.appliedDecision === "stage0_silent"
        || params.appliedDecision === "stage2_log_only";
      const result =
        params.resultOverride
        ?? (isSilentPath ? "skipped" : "success");
      this.db
        .prepare(
          `INSERT INTO agent_actions
             (action_type, trigger, result, detail, started_at, completed_at)
           VALUES ('activity_scan.gate', 'autonomous', ?, json(?), datetime('now'), datetime('now'))`,
        )
        .run(result, JSON.stringify(detail));
    } catch (err) {
      logger.warn({ err }, "Failed to record activity_scan.gate audit row");
    }
  }

  /**
   * cost-reduction-structural §B Stage 2 — synchronous lite-tier triage.
   * Builds a `routine.activity_scan.triage` RoutineEvent and runs it
   * inline through the agent router (NOT the EventBus, so the result
   * is available before we decide whether to silence or escalate).
   *
   * The agent contract is JSON-only output (`{ "action": "log_only" |
   * "escalate", "reason": "..." }`); on parse failure we return
   * `'failed'` and the caller treats that as cautious escalate.
   *
   * Tool/turn clamp (defense-in-depth):
   *   - `allowedToolsOverride: []` removes every tool from the SDK's
   *     allowlist for the spawn. Stage 2 has nothing to do but emit a
   *     JSON line; the design's "no write tools" rule is enforced here
   *     instead of relying on the prompt alone.
   *   - `maxTurns: 1` caps the spawn at a single assistant turn. Even
   *     if a future prompt change accidentally invites tool use, the
   *     spawn cannot loop. Codex/Gemini have no per-spawn `allowedTools`
   *     surface today (acknowledged gap in `agent-core.ts`); the
   *     `maxTurns` cap and process_backend_config envelope are the
   *     remaining safety floor on those backends.
   */
  private async runStage2Triage(
    decision: ActivityScanGateDecision,
    source: string,
  ): Promise<"log_only" | "escalate" | "failed"> {
    const triageEvent: RoutineEvent = {
      ...createEvent({
        type: "routine.activity_scan.triage",
        source,
        priority: EventPriority.NORMAL,
      }),
      routine: "activity_scan.triage",
      data: {
        forced: false,
        gateDecision: {
          stage: decision.stage,
          reason: decision.reason,
          forced: false,
          block: renderGateDecisionBlock(decision, { forced: false }),
        },
      },
    } as RoutineEvent;

    let context: string;
    try {
      context = await this.contextBuilder.build(triageEvent);
    } catch (err) {
      logger.error({ err }, "Stage 2 triage context build failed");
      return "failed";
    }

    const processKey: ProcessKey = "routine.activity_scan.triage";
    const reassemblePrompt = (bid: BackendId): string =>
      this.prompt.assemble(triageEvent.type, processKey, bid);
    let binding: ReturnType<IAgentRouter["resolveBinding"]>;
    try {
      binding = this.agentRouter.resolveBinding(triageEvent, { processKey });
    } catch (err) {
      logger.error({ err }, "Stage 2 triage binding resolve failed");
      return "failed";
    }
    const prompt = reassemblePrompt(binding.main.backendId);

    let result: AgentResult;
    try {
      result = await this.agentRouter.execute({
        prompt,
        context,
        event: triageEvent,
        processKey,
        preResolvedBinding: binding,
        reassemblePrompt,
        // Defense-in-depth: Stage 2 must not call any tool. Empty
        // `allowedToolsOverride` REPLACES the default allowlist on
        // Claude (Codex/Gemini have no per-spawn `allowedTools` surface
        // — acknowledged gap in `agent-core.ts`). The `max_turns=1` cap
        // for the spawn comes from the seeded `process_backend_config`
        // row for `routine.activity_scan.triage` (see `db/schema.ts`),
        // which the router reads via `binding.main.maxTurns`. Together
        // these mean: zero tools on Claude, one assistant turn on every
        // backend.
        allowedToolsOverride: [],
      });
    } catch (err) {
      logger.error({ err }, "Stage 2 triage agent execution failed");
      return "failed";
    }

    // Audit row for the lite-tier session itself, distinct from the gate
    // audit row written by `logGateAuditRow`.
    try {
      this.audit.logAction({
        event: triageEvent,
        model: result.model,
        costUsd: result.costUsd,
        usage: result.usage,
        modelUsage: result.modelUsage,
        durationMs: result.durationMs,
        numTurns: result.numTurns,
        trigger: "autonomous",
        backend: result.backendId,
        costSource: result.costSource,
        contextUpdated: result.contextUpdated,
        advisorCallCount: result.advisorCallCount,
      });
    } catch (err) {
      logger.warn({ err }, "Failed to log Stage 2 triage agent_actions row");
    }

    return parseStage2Verdict(result.output);
  }
}
