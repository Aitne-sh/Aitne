import type Database from "better-sqlite3";
import type {
  Event,
  MessageEvent,
  RoutineEvent,
} from "@aitne/shared";
import {
  EventPriority,
  createEvent,
  getAgentDayBoundsUtc,
  isMessageEvent,
  isRoutineEvent,
  isAgentTaskEvent,
  isScheduledDmEvent,
  isKnowledgeImportEvent,
  parseSqliteUtcMs,
} from "@aitne/shared";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { AgentConfig } from "../config.js";
import { CONTEXT_RELATIVE_PATHS } from "./context-paths.js";
import { getContextDir, isRoadmapStale } from "../config.js";
import {
  OWNER_DM_SCOPE,
  OWNER_SCOPE_KEY,
  DASHBOARD_CHAT_SCOPE,
  DASHBOARD_SCOPE_KEY,
  getConversationScope,
} from "../messaging/constants.js";
import type { DocsCitationLookup } from "./docs/citation-validator.js";
import type { SignalDetector } from "./signal-detector.js";
import type { ServiceRegistry } from "../services/service-registry.js";
import { buildConfiguredServices } from "./workdir.js";
import { EventBus } from "./event-bus.js";
import { SessionGateRegistry } from "./session-gate.js";
import { Semaphore } from "./semaphore.js";
import { selectGithubRepoSlugs } from "../db/repositories-store.js";
import {
  isDegraded as readDegradedMode,
  isUserPaused,
} from "../db/runtime-state.js";
import {
  deleteRuntimeState,
  readRuntimeState,
  writeRuntimeState,
} from "../db/runtime-state.js";
import type { IAgentRouter } from "./backends/backend-router.js";
import type { TodayWriteLockManager } from "./today-write-lock.js";
import type { RoadmapWriteLockManager } from "./roadmap-write-lock.js";
import type { AgentWriteTracker } from "../safety/agent-write-tracker.js";
import type { AttachmentStore } from "../services/attachments/store.js";
import type { VoiceTranscriber } from "../services/voice/transcriber.js";
import {
  CUSTOM_BANG_COMMAND_SOURCE,
  getUserBangCommandById,
  type UserBangCommand,
} from "./bang-commands/user-commands.js";
import { createLogger } from "../logging.js";

const logger = createLogger("dispatcher");
export type { IAgentCore, StreamCallbacks } from "./agent-core.js";
export type { IAgentRouter } from "./backends/backend-router.js";

// Phase D-1 split — shared types and zero-dependency helpers live in
// sibling modules (`docs/design/appendices/file-split-plan.md`). The
// dispatcher imports what it needs to reference internally and then
// re-exports the public-surface members below so existing callers of
// `dispatcher.js` continue to work unchanged.
import {
  parseStage2Verdict,
  buildLogErrorContext,
  type ReplyActivityHandle,
  type IDashboardStream,
  type IContextBuilder,
  type GetTaskFlow,
  type INotificationManager,
  type ISessionManager,
  type IMessageRecorder,
  type IAuditLogger,
  type BangCommandDetail,
  type TriggerHourlyCheckSkipReason,
  type SetupMode,
  type TriggerHourlyCheckOptions,
  type TriggerHourlyCheckResult,
  type InFlightExecutionInfo,
} from "./dispatcher-types.js";
export {
  parseStage2Verdict,
};
export type {
  ReplyActivityHandle,
  IDashboardStream,
  IContextBuilder,
  GetTaskFlow,
  INotificationManager,
  ISessionManager,
  IMessageRecorder,
  IAuditLogger,
  BangCommandDetail,
  TriggerHourlyCheckSkipReason,
  SetupMode,
  TriggerHourlyCheckOptions,
  TriggerHourlyCheckResult,
  InFlightExecutionInfo,
};
import { PromptAssembler } from "./dispatcher-prompt.js";
import { DispatcherErrorRouter } from "./dispatcher-error-handling.js";
import { ResultProcessor } from "./dispatcher-result-processor.js";
import { HourlyCheckCoordinator } from "./dispatcher-hourly-check.js";
import type { QueueMorningRoutineWake } from "./dispatcher-hourly-check.js";
import { morningRoutineRanToday } from "../bootstrap/schedule-helpers.js";

/**
 * Routine names that depend on `routine.morning_routine` having completed
 * successfully for the current agent-day. The pre-routine gate in
 * `dispatch()` enqueues a morning_routine wake and skips the dependent
 * routine when the predicate trips — hourly_check is gated separately
 * inside `HourlyCheckCoordinator.trigger` because it has its own entry
 * point (`triggerHourlyCheck`) before any event hits the bus.
 */
const REVIEW_ROUTINES_REQUIRING_MORNING = new Set<string>([
  "evening_review",
  "weekly_review",
  "monthly_review",
]);
import { MorningRoutineRunner } from "./dispatcher-morning-routine.js";
import { MorningRoutinePipelineOrchestrator } from "./morning/orchestrator.js";
import { RoutineFetchWindowRunner } from "./routine-fetch-window-runner.js";
import {
  ScheduledTaskRunner,
  SKILL_CURATION_OPTIMIZER_ALLOWED_TOOLS,
} from "./dispatcher-scheduled-tasks.js";
import { MessageHandler } from "./dispatcher-message-handler.js";

export { SKILL_CURATION_OPTIMIZER_ALLOWED_TOOLS };

const CURRENT_SETUP_MODE_STATE_KEY = "current_setup_mode";

export class EventDispatcher {
  private readonly reactiveSem: Semaphore;
  private readonly autonomousSem: Semaphore;
  private readonly hasMessageBackendMetadataColumns: boolean;
  private shutdown = false;
  private readonly shutdownAwaiters = new Set<() => void>();
  private signalDetector: SignalDetector | null = null;
  private dashboardStream: IDashboardStream | null = null;
  /**
   * Docs-QA citation lookup. Wired at startup via
   * `setDocsCitationLookup`; null elsewhere so this module stays tree-
   * shakable for tests that don't construct the docs indexer. The
   * dispatcher only consults it when `isDocsQAMessage(event)` is true,
   * so a null lookup never affects chat / DM / routine flows.
   */
  private docsCitationLookup: DocsCitationLookup | null = null;
  private authRecovery: import("./backends/auth-recovery.js").AuthRecovery | null = null;
  private authHealthMonitor: import("./backends/auth-health-monitor.js").AuthHealthMonitor | null = null;
  /**
   * Messaging bang-commands registry — short, exact-match owner controls
   * (`!stop` / `!start` / `!cost` / `!report`) intercepted in
   * `handleMessage` before any agent backend is invoked. Optional so tests
   * that build a dispatcher without the registry continue to pass; when
   * null, all DMs flow straight to the agent path.
   *
   * Spec: docs/design/backlog/messaging-bang-commands.md
   */
  private bangCommandRegistry: import("./bang-commands/registry.js").BangCommandRegistry | null = null;
  /**
   * Phase B-4 — DM-issued purchase confirmation handler. Wired at
   * daemon startup from `index.ts` via `setPurchaseHandler`. Null
   * when B-4 is not enabled at startup; the dispatcher's inbound
   * classifier no-ops in that case and the workflow runner refuses
   * `variant: "purchase"` calls with `purchase_b4_disabled`.
   *
   * Spec: MANAGED_CHROMIUM_IMPLEMENTATION_PLAN.md §17 / §13 step 50.
   */
  private purchaseHandler:
    | import("../services/browser-history/automation/purchase-handler.js").PurchaseHandler
    | null = null;
  /**
   * Current setup mode — scope-agnostic flag that survives internal
   * direct-message session refresh (day boundary, stale flag, etc). Previously this
   * was a `Map<sessionId, mode>` keyed by `conversation_sessions.id`, but the
   * session row is routinely closed and recreated by `getOrCreateDm()` when
   * a loud prompt-context change marks active DMs stale, which orphaned the
   * map entry and silently dropped the setup flow back to the generic DM prompt.
   * A single nullable flag is the right
   * granularity because the dashboard owner-DM scope is singular.
   *
   * Persisted to runtime_state so setup mode survives daemon restart. Without
   * persistence, an update-flow setup conversation that crashes mid-flight
   * would re-open the gate on restart and re-introduce the stale-session race.
   *
   * No auto-expiry. The original 30-minute safety net turned out to be
   * actively harmful: it fired DURING legitimate long setup conversations
   * (which is exactly the pattern that triggered the original report) and
   * re-opened the bug it was trying to guard. Setup mode is only cleared by
   * explicit `clearSetupMode()` from `/setup/save-rules`.
   */
  private currentSetupMode: SetupMode | null = null;
  /** Per-session FIFO gate: owner DMs share one key; thread sessions
   *  keep their own lane. SCHEDULED-DM-IMPLEMENTATION-PLAN §3.6 — also
   *  used by `scheduled.dm` to acquire BOTH owner-facing scopes in
   *  lex-sorted (deadlock-free) order. */
  private readonly sessionGates = new SessionGateRegistry();
  /** Dedup guard: timestamp of the last roadmap_refresh emission */
  private lastRoadmapRefreshEmitMs = 0;
  private morningRoutineInProgress = false;
  private hourlyCheckInProgress = false;
  /**
   * Wall-clock timestamp (ms since epoch) of the most recent flip of
   * `hourlyCheckInProgress` to `true`, or `null` when the flag is false.
   *
   * Paired with `HOURLY_CHECK_FLAG_MAX_AGE_MS` to break the silent-stall
   * pattern where the flag is set true at enqueue time but the matching
   * `dispatchSafe` finally never runs — currently possible when the
   * EventBus evicts/drops the queued routine event under `put()` pressure
   * (heap-js drops the lowest-priority entry silently when `heap.size() >=
   * maxSize=1000`). Without the timestamp the flag stays `true` until
   * process restart and every subsequent hourly tick short-circuits with
   * `hourly_check_in_progress`.
   *
   * Read side (`isHourlyCheckInProgress` callback below) checks the age
   * and auto-clears when it exceeds the bound, surfacing the recovery via
   * a warn log so the operator sees the EventBus pressure event.
   */
  private hourlyCheckInProgressAt: number | null = null;
  /**
   * Upper bound for how long `hourlyCheckInProgress=true` can plausibly
   * be valid before we treat it as stuck and force-clear.
   *
   * Sized generously above the realistic Stage-3 hourly_check ceiling
   * (fetch_window pre-pass ~30–60 s + Sonnet hourly_check session
   * ~1–3 min) so a slow but normal run is never falsely cleared. Sized
   * well below an entire agent-day so a stuck flag recovers within a
   * single hourly cron cycle's worst case (default cadence 60 min).
   * The 30-minute window is comfortably outside any plausible "still
   * running" interpretation and inside one full hourly slot.
   */
  private static readonly HOURLY_CHECK_FLAG_MAX_AGE_MS = 30 * 60 * 1000;
  /**
   * P22 §3.4 — wired by `index.ts` after the daemon's data dir + skills root
   * are known. Returns a `{runId, runToken, workdirPath, targetSkills}` tuple
   * the optimizer routine then runs against. Injected as a callback so the
   * dispatcher does not import the workdir module directly (avoids a cycle
   * with SkillsCompiler / SecretBroker).
   */
  private materializeOptimizerWorkdir:
    | ((opts?: { manual?: boolean; targetSkillsOverride?: string[] }) => Promise<{ runId: string; runToken: string; workdirPath: string; targetSkills: string[] }>)
    | null = null;
  private teardownOptimizerWorkdir: ((workdirPath: string) => void) | null = null;
  setSkillCurationHooks(hooks: {
    materialize: (opts?: { manual?: boolean; targetSkillsOverride?: string[] }) => Promise<{ runId: string; runToken: string; workdirPath: string; targetSkills: string[] }>;
    teardown: (workdirPath: string) => void;
  }): void {
    this.materializeOptimizerWorkdir = hooks.materialize;
    this.teardownOptimizerWorkdir = hooks.teardown;
  }
  private static readonly COST_CAP_SQL =
    `SELECT COALESCE(SUM(cost_usd), 0) as cost
     FROM agent_actions
     WHERE trigger = 'autonomous'
       AND started_at >= ? AND started_at < ?`;

  /** Map `turn_token → sessionId` for in-flight turns. The API layer
   *  calls `validateAttachmentTurnToken(token)` to authorise
   *  `POST /api/chat/outbound-attachments`; the entry is cleared in a
   *  `finally` so orphan tokens don't survive past the turn that
   *  spawned them. */
  private readonly activeTurnTokens = new Map<string, number>();
  /** Injected lazily via `setAttachmentStore` — optional for tests
   *  and older code paths that don't wire the store. When null, the
   *  dispatcher skips attachment staging + outbound collection. */
  private attachmentStore: AttachmentStore | null = null;

  /** Injected lazily via `setDelegatedSyncRefresh` — optional. When null,
   *  hourly check fires without first refreshing delegated-mode snapshots,
   *  matching the pre-Phase-9 behaviour. Wired in production when at
   *  least one integration is in delegated mode. See
   *  `docs/design/appendices/delegated-sync-opt-in.md` and the worker's
   *  `runDisabledCadencesForHourlyCheck` method. */
  private delegatedSyncRefresh: (() => Promise<void>) | null = null;

  /**
   * Injected lazily via `setQueueMorningRoutineWake` (wired in `index.ts`
   * after `AgentScheduler` is constructed). The pre-routine morning_routine
   * gate uses this to enqueue a recovery wake when the current agent-day's
   * morning_routine has not run yet — typical cause: macOS App Nap / sleep
   * suspended node-cron through the 04:00 tick. See `morningRoutineRanToday`
   * in `bootstrap/schedule-helpers.ts` for the authoritative predicate. */
  private queueMorningRoutineWake: QueueMorningRoutineWake | null = null;

  /** Injected lazily via `setVoiceTranscriber` — optional. When null,
   *  inbound audio attachments fall back to the path-only prompt block
   *  exactly as they did before the local-Whisper layer landed. See
   *  `docs/design/appendices/voice-transcription.md`. */
  private voiceTranscriber: VoiceTranscriber | null = null;

  /**
   * Injected lazily via `setEventBroadcaster` — optional. When wired, the
   * dispatcher emits `routine_started` / `routine_completed` SSE events at
   * the `dispatchSafe` chokepoint so the dashboard can render real-time
   * progress for autonomous routines (morning_routine, hourly_check,
   * roadmap_refresh, evening/weekly/monthly reviews, etc.).
   *
   * Failure to broadcast is non-fatal: the throw is swallowed and logged
   * so a misbehaving SSE writer cannot break routine execution.
   *
   * Discriminated by `kind: "routine_started" | "routine_completed"`,
   * consistent with the existing `kind: "main_backend_changed"` pattern
   * carried on the default `event` SSE channel.
   */
  private eventBroadcaster: {
    broadcastEvent: (data: unknown) => void;
  } | null = null;

  /**
   * Notify-dedup tracking — set of correlationIds for in-flight events
   * that have already invoked `POST /api/notify` from inside the agent
   * run. The `/api/notify` route calls `markEventNotified` (via api-deps)
   * on success, and `processResult` consumes the entry with `Set.delete`.
   * When present, the implicit "final assistant text → DM" forward is
   * suppressed — preventing the duplicate-notification bug where the LLM
   * sends both an explicit notify and a non-empty closing turn.
   *
   * In-memory only; single-daemon scope. Cleanup contract:
   *   - Success path: `processResult.delete()` removes the entry exactly
   *     once per event run (every dispatch path funnels into it).
   *   - Throw path: `handleError.delete()` is the defense-in-depth
   *     cleanup for entries left when execution threw before reaching
   *     `processResult`.
   *   - Retry path: `executeWithRetry` reuses the same correlationId
   *     across attempts, but only one `processResult` call closes the
   *     run, so the marker is consumed exactly once.
   *
   * Cross-event safety: each `createEvent()` mints a fresh UUID, so a
   * stale entry surviving both cleanup paths cannot poison a later
   * unrelated event run. Scheduler-resurrected events (scheduler.ts
   * carries `row.correlation_id` when present) intentionally inherit
   * the same id, which is the correct behaviour — they continue the
   * same logical run.
   */
  private readonly notifiedEvents = new Set<string>();

  /**
   * Phase D-2 coordinator (`docs/design/appendices/file-split-plan.md`):
   * owns task-flow prompt assembly and the inbound-attachment lifecycle
   * (token issue/release, staging into the session dir, voice
   * transcription, and the "[Attached files]" prompt block). Borrows
   * a live reference to `activeTurnTokens` so the dispatcher's public
   * `validateAttachmentTurnToken` keeps reading the same map.
   */
  private readonly prompt: PromptAssembler;
  /**
   * Phase D-2 coordinator: owns the failure-path machinery — shallow
   * retry wrapper, post-throw cleanup + DM/dashboard notification,
   * quota-error formatting, and the §4.5 delegated-connector health
   * warning consult/dispatch pair. Holds live references to the
   * dispatcher's `notifiedEvents` Set and `shutdownAwaiters` Set;
   * reads `shutdown` and the dashboard stream through accessor
   * callbacks so lazy injection still flows through.
   */
  private readonly errorRouter: DispatcherErrorRouter;
  /**
   * Phase D-2 coordinator: closes out the success-side dispatch
   * lifecycle — notify, audit, scheduled-task finalize, and the
   * cross-session conversation-history / proactive-forward heuristics.
   * The DispatcherErrorRouter routes through this on the failure
   * path via the `onRetemplateFinalize` / `onManagementScanFinalize`
   * callbacks wired in the constructor.
   */
  private readonly resultProcessor: ResultProcessor;
  /**
   * Phase D-2 coordinator: owns `triggerHourlyCheck` and the
   * cost-reduction-structural §B three-stage gate. Borrows live
   * accessors for the dispatcher's `hourlyCheckInProgress` flag so the
   * pre-existing C1 atomic check-and-set semantics survive the split.
   */
  /**
   * docs/design/appendices/routine-data-acquisition.md Phase 4 / D1 — shared pre-pass
   * runner for `routine.fetch_window`. Injected into HourlyCheckCoordinator
   * (D3), MorningRoutineRunner (D2), and ScheduledTaskRunner (D4) so
   * every routine that has rows in `ROUTINE_WINDOWS` gets the same
   * fetcher session ahead of its parent dispatch. Pure helper, no
   * mutable state of its own.
   */
  private readonly fetchWindowRunner: RoutineFetchWindowRunner;
  private readonly hourlyCheck: HourlyCheckCoordinator;
  /**
   * Phase D-2 coordinator: owns morning-routine execution end-to-end
   * (lock acquisition, prompt-variant selection, retry chain, today.md
   * health check, post-morning catchups + roadmap refresh, and the
   * exponential-back-off retry scheduler). Borrows the dispatcher's
   * `morningRoutineInProgress` flag through a setter callback so the
   * B2 retry-chain invariant (flag stays true across attempts)
   * survives the split.
   */
  private readonly morningRoutine: MorningRoutineRunner;
  /**
   * Phase D-2 coordinator: owns every non-message dispatch path —
   * scheduled.task (generic + repository run + git project doc + retry
   * detection), routine.morning_routine retries, routine.roadmap_refresh,
   * routine.skill_curation, plus the catch-all executeDefault. Also
   * provides the today.md utilities (`rotateDayFiles`,
   * `diagnoseTodayMdState`, `hasCurrentAgentDayTodayMd`) that
   * `MorningRoutineRunner` consumes via dep callbacks.
   */
  private readonly scheduledTasks: ScheduledTaskRunner;
  /**
   * Phase D-3 coordinator: owns the reactive message-event path —
   * `handle` (was `handleMessage`), `handleAuthCommand`, and
   * `collectDmFreshnessTelemetry`. Borrows live accessors for every
   * dispatcher field the path used to read directly (`currentSetupMode`,
   * lazy-injected stream / store / detectors / auth subsystems) so
   * existing tests that reach through `(dispatcher as any).handleMessage`
   * / `(dispatcher as any).handleAuthCommand` keep working via the
   * thin shims that forward into this handler.
   */
  private readonly messageHandler: MessageHandler;

  constructor(
    private readonly eventBus: EventBus,
    private readonly agentRouter: IAgentRouter,
    private readonly contextBuilder: IContextBuilder,
    private readonly getTaskFlow: GetTaskFlow,
    private readonly notificationMgr: INotificationManager,
    private readonly sessionMgr: ISessionManager,
    private readonly messageRecorder: IMessageRecorder,
    private readonly audit: IAuditLogger,
    private readonly db: Database.Database,
    private readonly config: AgentConfig,
    private readonly todayWriteLock?: TodayWriteLockManager,
    private readonly services?: ServiceRegistry,
    private readonly roadmapWriteLock?: RoadmapWriteLockManager,
    private readonly writeTracker?: AgentWriteTracker,
  ) {
    this.reactiveSem = new Semaphore(config.maxReactiveSessions);
    this.autonomousSem = new Semaphore(config.maxConcurrentSessions);
    const messageColumns = new Set(
      (this.db.pragma("table_info(messages)") as { name: string }[]).map(
        (column) => column.name,
      ),
    );
    this.hasMessageBackendMetadataColumns =
      messageColumns.has("backend") && messageColumns.has("model_id");
    this.prompt = new PromptAssembler({
      db: this.db,
      config: this.config,
      getTaskFlow: this.getTaskFlow,
      activeTurnTokens: this.activeTurnTokens,
      getAttachmentStore: () => this.attachmentStore,
      getVoiceTranscriber: () => this.voiceTranscriber,
    });
    this.resultProcessor = new ResultProcessor({
      db: this.db,
      config: this.config,
      audit: this.audit,
      notificationMgr: this.notificationMgr,
      sessionMgr: this.sessionMgr,
      notifiedEvents: this.notifiedEvents,
      isReactive: (event) => this.isReactive(event),
      hasMessageBackendMetadataColumns: this.hasMessageBackendMetadataColumns,
    });
    // docs/design/appendices/routine-data-acquisition.md Phase 4 / D1 — shared pre-pass
    // runner consumed by HourlyCheckCoordinator (D3), MorningRoutineRunner
    // (D2), and ScheduledTaskRunner.executeDefault (D4). Constructed
    // before all three so it can be injected as a dep rather than
    // lazily resolved.
    this.fetchWindowRunner = new RoutineFetchWindowRunner({
      db: this.db,
      config: this.config,
      contextBuilder: this.contextBuilder,
      agentRouter: this.agentRouter,
      audit: this.audit,
      prompt: this.prompt,
      getActiveMailAccounts: () => this.getActiveMailAccounts(),
      // Live accessor so the SSE broadcaster wired later via
      // `setEventBroadcaster` (after dispatcher construction in
      // `index.ts`) reaches the pre-pass runner without requiring a
      // setter on the runner itself. Returns `null` in tests / headless
      // installs where no broadcaster is registered — the runner then
      // skips its pre-pass progress emits cleanly.
      getEventBroadcaster: () => this.eventBroadcaster,
    });
    this.hourlyCheck = new HourlyCheckCoordinator({
      db: this.db,
      config: this.config,
      eventBus: this.eventBus,
      contextBuilder: this.contextBuilder,
      agentRouter: this.agentRouter,
      audit: this.audit,
      todayWriteLock: this.todayWriteLock,
      prompt: this.prompt,
      fetchWindowRunner: this.fetchWindowRunner,
      getDelegatedSyncRefresh: () => this.delegatedSyncRefresh,
      setHourlyCheckInProgress: (value) => {
        this.hourlyCheckInProgress = value;
        this.hourlyCheckInProgressAt = value ? Date.now() : null;
      },
      isHourlyCheckInProgress: () => {
        if (!this.hourlyCheckInProgress) return false;
        // Stale-flag recovery — see `hourlyCheckInProgressAt` doc-comment.
        // The branch fires only when an enqueued event never reached
        // `dispatchSafe`'s finally (EventBus eviction is the realistic
        // cause; a future code path that forgets to reset the flag would
        // also self-heal here within one cron cycle).
        if (this.hourlyCheckInProgressAt !== null) {
          const ageMs = Date.now() - this.hourlyCheckInProgressAt;
          if (ageMs > EventDispatcher.HOURLY_CHECK_FLAG_MAX_AGE_MS) {
            logger.warn(
              {
                ageMs,
                maxAgeMs: EventDispatcher.HOURLY_CHECK_FLAG_MAX_AGE_MS,
              },
              "hourlyCheckInProgress flag exceeded max age — auto-clearing (likely EventBus drop or missed dispatchSafe finally)",
            );
            this.hourlyCheckInProgress = false;
            this.hourlyCheckInProgressAt = null;
            return false;
          }
        }
        return true;
      },
      isMorningRoutineActive: () => this.isMorningRoutineActive(),
      isAutonomousAllowed: () => this.isAutonomousAllowed(),
      getQueueMorningRoutineWake: () => this.queueMorningRoutineWake,
    });
    this.errorRouter = new DispatcherErrorRouter({
      db: this.db,
      config: this.config,
      notificationMgr: this.notificationMgr,
      messageRecorder: this.messageRecorder,
      notifiedEvents: this.notifiedEvents,
      shutdownAwaiters: this.shutdownAwaiters,
      getDashboardStream: () => this.dashboardStream,
      isShutdown: () => this.shutdown,
      onRetemplateFinalize: (event, opts) =>
        this.resultProcessor.finalizeRetemplateRunIfApplicable(event, opts),
      onManagementScanFinalize: (event, opts) =>
        this.resultProcessor.finalizeManagementScanIfApplicable(event, opts),
    });
    // morning-routine-optimization.md Phase 5/6/7 — pipeline orchestrator
    // owns Stage A (today.md) + Stage B (daily journal). It is the only
    // dispatch path for `routine.morning_routine`; the legacy monolithic
    // executor was retired once the orchestrator stabilised.
    const pipelineOrchestrator = new MorningRoutinePipelineOrchestrator({
      db: this.db,
      config: this.config,
      contextBuilder: this.contextBuilder,
      agentRouter: this.agentRouter,
      prompt: this.prompt,
      errorRouter: this.errorRouter,
      resultProcessor: this.resultProcessor,
      // morning-routine-optimization.md Phase 6 — pre-insert the
      // in_progress agent_actions row for Stage A so the agent's
      // `PATCH /api/agent-actions/self` can resolve mid-run, and feed
      // the write-tracker into ⑥ AgentJournalAppender so its atomic
      // write to `agent/journal.md` does not get re-classified as a
      // user-actor change by the obsidian / git observers.
      audit: this.audit,
      ...(this.writeTracker ? { writeTracker: this.writeTracker } : {}),
    });
    this.morningRoutine = new MorningRoutineRunner({
      db: this.db,
      config: this.config,
      eventBus: this.eventBus,
      notificationMgr: this.notificationMgr,
      todayWriteLock: this.todayWriteLock,
      fetchWindowRunner: this.fetchWindowRunner,
      setMorningRoutineInProgress: (value) => {
        this.morningRoutineInProgress = value;
      },
      // ScheduledTaskRunner is constructed AFTER MorningRoutineRunner
      // (it depends on `this.morningRoutine`), so these closures defer
      // the field read until call time — by then `this.scheduledTasks`
      // is populated.
      rotateDayFiles: () => this.scheduledTasks.rotateDayFiles(),
      diagnoseTodayMdState: () => this.scheduledTasks.diagnoseTodayMdState(),
      isRoadmapStale: () => this.isRoadmapStale(),
      emitRoadmapRefresh: (source) => this.emitRoadmapRefresh(source),
      triggerHourlyCheck: (source) => this.triggerHourlyCheck(source),
      pipelineOrchestrator,
    });
    this.scheduledTasks = new ScheduledTaskRunner({
      db: this.db,
      config: this.config,
      contextBuilder: this.contextBuilder,
      agentRouter: this.agentRouter,
      prompt: this.prompt,
      errorRouter: this.errorRouter,
      resultProcessor: this.resultProcessor,
      morningRoutine: this.morningRoutine,
      fetchWindowRunner: this.fetchWindowRunner,
      roadmapWriteLock: this.roadmapWriteLock,
      writeTracker: this.writeTracker,
      getConfiguredServices: () => this.getConfiguredServices(),
      getActiveMailAccounts: () => this.getActiveMailAccounts(),
      getMaterializeOptimizerWorkdir: () => this.materializeOptimizerWorkdir,
      getTeardownOptimizerWorkdir: () => this.teardownOptimizerWorkdir,
    });
    this.messageHandler = new MessageHandler({
      db: this.db,
      config: this.config,
      eventBus: this.eventBus,
      agentRouter: this.agentRouter,
      contextBuilder: this.contextBuilder,
      notificationMgr: this.notificationMgr,
      sessionMgr: this.sessionMgr,
      messageRecorder: this.messageRecorder,
      audit: this.audit,
      prompt: this.prompt,
      errorRouter: this.errorRouter,
      resultProcessor: this.resultProcessor,
      writeTracker: this.writeTracker,
      getSignalDetector: () => this.signalDetector,
      getDashboardStream: () => this.dashboardStream,
      getAttachmentStore: () => this.attachmentStore,
      getDocsCitationLookup: () => this.docsCitationLookup,
      getAuthRecovery: () => this.authRecovery,
      getAuthHealthMonitor: () => this.authHealthMonitor,
      getBangCommandRegistry: () => this.bangCommandRegistry,
      getPurchaseHandler: () => this.purchaseHandler,
      getCurrentSetupMode: () => this.currentSetupMode,
      beginSetupMode: (mode) => this.beginSetupMode(mode),
      lookupCustomBangCommandForEvent: (event) =>
        this.lookupCustomBangCommandForEvent(event),
      getConfiguredServices: () => this.getConfiguredServices(),
      getActiveMailAccounts: () => this.getActiveMailAccounts(),
      readLastInsertedMessageId: (sessionId) =>
        this.readLastInsertedMessageId(sessionId),
    });
    // Restore setup mode from runtime_state. If the daemon crashed or was
    // restarted during a setup conversation, the in-memory flag would be
    // lost and autonomous work would resume mid-setup — re-opening the
    // exact race this gate was designed to prevent.
    this.currentSetupMode = this.loadPersistedSetupMode();
    if (this.currentSetupMode !== null) {
      logger.info(
        { mode: this.currentSetupMode },
        "Restored setup mode from runtime_state — autonomous work remains paused",
      );
    }
  }

  private loadPersistedSetupMode(): SetupMode | null {
    const raw = readRuntimeState<{ mode: SetupMode }>(
      this.db,
      CURRENT_SETUP_MODE_STATE_KEY,
    );
    if (raw && (raw.mode === "initial" || raw.mode === "update")) {
      return raw.mode;
    }
    return null;
  }

  /** Set the SignalDetector for implicit feedback collection from user messages. */
  setSignalDetector(detector: SignalDetector): void {
    this.signalDetector = detector;
  }

  /**
   * Wire the B-4 purchase-confirmation handler. Called once at startup
   * from `index.ts` after the messaging hub is up — the handler's
   * `sender` dependency requires a live MessageHub for outbound DMs.
   * Calling more than once replaces the prior reference (used by the
   * dashboard's "Disable B-4" flow which can later re-enable).
   */
  setPurchaseHandler(
    handler: import("../services/browser-history/automation/purchase-handler.js").PurchaseHandler | null,
  ): void {
    this.purchaseHandler = handler;
  }

  /** Read accessor — used by the route layer's wiring to thread the
   *  same instance into `ApiDependencies.purchaseHandler` without a
   *  parallel construction path. */
  getPurchaseHandler():
    | import("../services/browser-history/automation/purchase-handler.js").PurchaseHandler
    | null {
    return this.purchaseHandler;
  }

  /** Set the dashboard stream adapter for real-time response streaming. */
  setDashboardStream(adapter: IDashboardStream): void {
    this.dashboardStream = adapter;
  }

  /**
   * Wire the docs-QA citation lookup. Called once at startup from
   * `index.ts` after the docs indexer is built. The dispatcher uses it
   * for the persistence-side `validateAndRewrite` pass on docs_qa
   * assistant output (see DOCS_QA_B7_DESIGN.md §11.1) — chat / DM /
   * routine paths never touch it.
   */
  setDocsCitationLookup(lookup: DocsCitationLookup): void {
    this.docsCitationLookup = lookup;
  }

  /** Chat-attachments Phase 1 — inject the shared AttachmentStore. */
  setAttachmentStore(store: AttachmentStore): void {
    this.attachmentStore = store;
  }

  /** Inject the local-Whisper voice transcriber. Optional — when unset,
   *  inbound audio attachments are passed to the backend with a path-only
   *  reference (the pre-feature behaviour). */
  setVoiceTranscriber(transcriber: VoiceTranscriber): void {
    this.voiceTranscriber = transcriber;
  }

  /**
   * Inject the delegated-sync refresh callback. Called from
   * `triggerHourlyCheck` before the gate decision so any cadence the
   * operator left opted-OUT (post-Phase-9 default) populates fresh
   * Gmail / Notion observations the agent can then consume.
   *
   * Wired as a thunk rather than a worker reference so the dispatcher
   * stays decoupled from the observers layer and the live worker
   * instance can be re-registered (integration mode flips) without the
   * dispatcher holding a stale reference.
   *
   * Pass `null` to detach (e.g. when no delegated integration exists).
   * The hourly check then proceeds without a refresh — equivalent to the
   * pre-injection behaviour.
   */
  setDelegatedSyncRefresh(fn: (() => Promise<void>) | null): void {
    this.delegatedSyncRefresh = fn;
  }

  /**
   * Wire the scheduler's `queueMorningRoutineWake` so the pre-routine
   * gate (hourly_check + evening/weekly/monthly review) can self-recover
   * after a missed 04:00 cron fire. Wired once in `index.ts` after both
   * the dispatcher and scheduler are constructed; passing `null` detaches.
   * When unset, the gate logs a warning and still skips the dependent
   * routine — the daemon does not "silently" run a stale review.
   */
  setQueueMorningRoutineWake(fn: QueueMorningRoutineWake | null): void {
    this.queueMorningRoutineWake = fn;
  }

  /**
   * Wire the dashboard SSE broadcaster so routine-start / routine-complete
   * progress events flow to subscribed clients. Optional — when unset,
   * `broadcastRoutineProgress` is a silent no-op and routines run exactly
   * as before. Failure inside `broadcastEvent` is swallowed at the
   * call-site so a broken SSE writer cannot break dispatch.
   */
  setEventBroadcaster(broadcaster: {
    broadcastEvent: (data: unknown) => void;
  } | null): void {
    this.eventBroadcaster = broadcaster;
  }

  /**
   * Internal helper: broadcast `routine_started` or `routine_completed` for
   * the given routine event. Centralised so the JSON shape and failure
   * containment live in one place.
   *
   * The payload intentionally includes `correlationId` (chains back to the
   * `agent_actions` row written by the executor) and `kind` (matches the
   * existing dashboard event discriminator pattern). `durationMs` and
   * `result` are present on the `routine_completed` variant only.
   */
  private broadcastRoutineProgress(
    kind: "routine_started" | "routine_completed",
    event: RoutineEvent,
    extra?: { durationMs?: number; result?: "success" | "error" },
  ): void {
    const broadcaster = this.eventBroadcaster;
    if (!broadcaster) return;
    try {
      broadcaster.broadcastEvent({
        kind,
        routine: event.routine,
        source: event.source,
        correlationId: event.correlationId,
        timestamp: new Date().toISOString(),
        ...(extra?.durationMs !== undefined ? { durationMs: extra.durationMs } : {}),
        ...(extra?.result ? { result: extra.result } : {}),
      });
    } catch (err) {
      // Defense-in-depth: the broadcaster contract is fire-and-forget, but
      // a misbehaving writer (e.g. JSON.stringify cycle on an upstream
      // event mutation) must not propagate into the dispatch path.
      logger.warn({ err, kind, routine: event.routine }, "Routine SSE broadcast failed");
    }
  }

  /**
   * Authorise an `X-Turn-Token` for POST /api/chat/outbound-attachments.
   * Returns the DB session id bound to that token while a turn is still
   * running, null otherwise.
   */
  validateAttachmentTurnToken(token: string): { sessionId: number } | null {
    const sessionId = this.activeTurnTokens.get(token);
    if (sessionId === undefined) return null;
    return { sessionId };
  }

  /**
   * Read the `messages.id` that was just persisted for this session.
   * Used to bind inbound attachment rows to the user message (so the
   * history endpoint can re-serve them) and outbound attachments to the
   * assistant message. `better-sqlite3`'s `last_insert_rowid()` is
   * per-connection and authoritative right after `recordMessage` returns
   * (its transaction has committed synchronously).
   */
  private readLastInsertedMessageId(sessionId: number): number | null {
    try {
      const row = this.db
        .prepare(`SELECT last_insert_rowid() AS id`)
        .get() as { id: number } | undefined;
      if (!row || !Number.isFinite(row.id) || row.id <= 0) return null;
      // Guard against a completely unrelated insert racing in on the same
      // connection (shouldn't happen — better-sqlite3 is sync — but cheap
      // to verify). If the latest insert isn't for this session, abandon.
      const check = this.db
        .prepare(`SELECT session_id FROM messages WHERE id = ?`)
        .get(row.id) as { session_id: number } | undefined;
      if (!check || check.session_id !== sessionId) return null;
      return row.id;
    } catch {
      return null;
    }
  }

  /**
   * Resolve the `UserBangCommand` row that produced this event, when one
   * applies. The dispatcher consults the row to apply the per-command
   * skill set and instruction body to the session workdir before the
   * agent runs. Returns `null` for non-bang messages, for bang events
   * whose row was deleted between enqueue and dispatch, and for events
   * whose `data.customBangCommand.id` is missing or malformed (defense
   * against a future event constructor that forgets to set it).
   */
  private lookupCustomBangCommandForEvent(
    event: MessageEvent,
  ): UserBangCommand | null {
    if (event.source !== CUSTOM_BANG_COMMAND_SOURCE) return null;
    const ref = event.data?.customBangCommand;
    if (!ref || typeof ref !== "object") return null;
    const id = (ref as { id?: unknown }).id;
    if (typeof id !== "number" || !Number.isInteger(id) || id <= 0) {
      return null;
    }
    return getUserBangCommandById(this.db, id);
  }

  /**
   * Phase 5: set the auth recovery manager so owner DMs like `/auth fix codex`
   * can be intercepted before reaching the agent backend.
   */
  setAuthRecovery(recovery: import("./backends/auth-recovery.js").AuthRecovery): void {
    this.authRecovery = recovery;
  }

  /**
   * Phase 5 (M2 fix): set the AuthHealthMonitor so `/auth status` can
   * render the full summary in-DM instead of a pointer to the dashboard.
   */
  setAuthHealthMonitor(monitor: import("./backends/auth-health-monitor.js").AuthHealthMonitor): void {
    this.authHealthMonitor = monitor;
  }

  /**
   * Wire the bang-command registry so owner DMs are intercepted before the
   * agent path. See docs/design/backlog/messaging-bang-commands.md.
   */
  setBangCommandRegistry(
    registry: import("./bang-commands/registry.js").BangCommandRegistry,
  ): void {
    this.bangCommandRegistry = registry;
  }

  /** Main event processing loop */
  async run(): Promise<void> {
    while (!this.shutdown) {
      const event = await this.eventBus.get();
      if (!event) break; // EventBus was closed
      void this.handleEvent(event); // fire-and-forget
    }
  }

  stop(): void {
    this.shutdown = true;
    this.eventBus.close();
    for (const onShutdown of this.shutdownAwaiters) {
      try {
        onShutdown();
      } catch {
        // Awaiter callbacks just resolve a promise — never throw — but keep
        // the loop defensive so one bad callback can't strand the rest.
      }
    }
    this.shutdownAwaiters.clear();
  }

  /**
   * Enter setup mode. Called from `POST /setup/start` so the warm gate
   * engages the moment the user opens the dashboard setup flow — before any
   * agent turn runs — so concurrent hourly_check / morning routine / scheduled
   * wake work cannot race with the setup conversation. Persisted to
   * `runtime_state` so the flag survives daemon restart.
   */
  beginSetupMode(mode: SetupMode): void {
    if (this.currentSetupMode !== null && this.currentSetupMode !== mode) {
      logger.warn(
        { previous: this.currentSetupMode, next: mode },
        "Setup mode replaced with a different mode while one was already active",
      );
    }
    this.currentSetupMode = mode;
    try {
      writeRuntimeState(this.db, CURRENT_SETUP_MODE_STATE_KEY, { mode });
    } catch (err) {
      // Non-fatal: in-memory state still protects the current process.
      logger.warn(
        { err, mode },
        "Failed to persist setup mode to runtime_state",
      );
    }
    logger.info({ mode }, "Setup mode engaged — autonomous work paused");
  }

  /**
   * Exit setup mode. Called from `POST /setup/save-rules` on success.
   * Idempotent.
   */
  clearSetupMode(): void {
    if (this.currentSetupMode === null) {
      // Still attempt a best-effort runtime_state cleanup so any stray row
      // (e.g., from a previous run that crashed before clearing) is removed.
      try {
        deleteRuntimeState(this.db, CURRENT_SETUP_MODE_STATE_KEY);
      } catch {
        // ignore
      }
      return;
    }
    const mode = this.currentSetupMode;
    this.currentSetupMode = null;
    try {
      deleteRuntimeState(this.db, CURRENT_SETUP_MODE_STATE_KEY);
    } catch (err) {
      logger.warn(
        { err },
        "Failed to clear setup mode from runtime_state (in-memory state cleared)",
      );
    }
    logger.info({ mode }, "Setup mode cleared — autonomous work resumed");
  }

  /** Observable getter, primarily for tests and the onPromptContextChanged gate. */
  getCurrentSetupMode(): SetupMode | null {
    return this.currentSetupMode;
  }

  /**
   * Management Mode Phase 2 — expose in-flight executions so
   * `/api/setup/migrate-context` can refuse to start while real work is
   * still running, not just while sessions remain marked active.
   */
  getInFlightExecutions(): InFlightExecutionInfo[] {
    const executions: InFlightExecutionInfo[] = [];
    for (const key of this.sessionGates.activeKeys()) {
      executions.push({ kind: "session_chain", key });
    }
    if (this.morningRoutineInProgress) {
      executions.push({ kind: "routine", key: "morning_routine" });
    }
    if (this.hourlyCheckInProgress) {
      executions.push({ kind: "routine", key: "hourly_check" });
    }
    const runningTasks = this.db
      .prepare(
        `SELECT id, task_type, task_description
           FROM agent_schedule
          WHERE status = 'running'`,
      )
      .all() as Array<{ id: number; task_type: string; task_description: string }>;
    for (const task of runningTasks) {
      executions.push({
        kind: "scheduled_task",
        id: task.id,
        taskType: task.task_type,
        detail: task.task_description,
      });
    }
    return executions;
  }

  /**
   * Gate for autonomous background work (cron routines, hourly_check,
   * scheduled wake tasks, startup catchup, calendar-poller reactive events).
   *
   * Two layers:
   *  - **Cold gate**: `rules/management.md` must exist. Before initial setup
   *    there is no policy document, no user/profile.md, no today.md — running
   *    routines would produce garbage AND, crucially, any loud prompt-context
   *    write from such a routine can trigger
   *    `onPromptContextChanged -> markActiveDmSessionsStale`, which destroys
   *    the in-flight setup conversation on the next user turn.
   *  - **Warm gate**: while a setup conversation is active (initial OR
   *    update), pause autonomous work even though the file exists. This
   *    covers the update flow where the rules file is present but the same
   *    race still applies.
   *
   * Returns `null` when allowed, or a string reason when blocked.
   */
  isAutonomousAllowed():
    | null
    | "setup_incomplete"
    | "setup_in_progress"
    | "vault_degraded"
    | "user_paused" {
    // Management Mode (plan §5.4): schedulers and observer-driven routines
    // must skip ticks while the primary vault is unreachable. Reactive DM
    // sessions still run — the user may be messaging the agent precisely
    // to ask about the broken vault. Writes still hit the context 503 gate.
    if (readDegradedMode(this.db)) {
      return "vault_degraded";
    }
    // Owner-initiated pause via `!stop` (docs/design/backlog/messaging-
    // bang-commands.md). Distinct from setup gates so the dashboard banner
    // and audit rows can surface it independently. Cron callbacks consult
    // this via `setAutonomousGate(() => dispatcher.isAutonomousAllowed())`.
    if (isUserPaused(this.db)) {
      return "user_paused";
    }
    const rulesPath = join(
      getContextDir(this.config, this.db),
      CONTEXT_RELATIVE_PATHS.rules.management,
    );
    if (!existsSync(rulesPath)) {
      return "setup_incomplete";
    }
    if (this.currentSetupMode !== null) {
      return "setup_in_progress";
    }
    return null;
  }

  /**
   * Process a catchup or bootstrap event synchronously without going through
   * the EventBus loop. Uses the same semaphore and error-handling path as the
   * normal dispatcher.
   */
  async processInline(event: Event): Promise<void> {
    await this.handleEventInner(event);
  }

  /** Get configured services set, rebuilding when ServiceRegistry changes. */
  private getConfiguredServices(): ReadonlySet<string> {
    // ServiceRegistry is mutable (services come online after OAuth etc.), so
    // rebuild each call. buildConfiguredServices is a cheap set construction.
    // GitHub is sourced from the unified `repositories` table — also live so
    // a row added via /api/repositories shows up on the next session
    // materialization without a daemon restart.
    const hasGithub = selectGithubRepoSlugs(this.db).length > 0;
    if (this.services) {
      return buildConfiguredServices(this.config, {
        ...this.services,
        github: hasGithub,
      });
    }
    // Test fallback (no ServiceRegistry). Cannot cache when `hasGithub`
    // changes between calls, so just rebuild — the construction is cheap.
    return buildConfiguredServices(this.config, { github: hasGithub });
  }

  /** Snapshot active mail accounts (§Phase 5 accounts.md materialization). */
  private getActiveMailAccounts(): readonly import("../services/mail/provider.js").MailAccount[] {
    return this.services?.mail?.listActiveAccounts() ?? [];
  }

  isReactive(event: Event): boolean {
    if (isMessageEvent(event) && (event.isDm || event.isMention)) return true;
    if (event.priority === EventPriority.CRITICAL) return true;
    // Dashboard-triggered tasks are user-initiated — treat as reactive.
    // Both the regenerate button and the Knowledge upload form fire while
    // the user is on the dashboard waiting for a response, so neither
    // should be gated by setup mode or the autonomous cost cap.
    if (event.source === "dashboard_regenerate") return true;
    if (isKnowledgeImportEvent(event)) return true;
    return false;
  }

  /**
   * Check whether this autonomous event should be skipped because the daily
   * autonomous cost cap has been exceeded. Uses priority-based degradation:
   * hourly_check (lowest priority, skipped first) → roadmap_refresh →
   * evening_review → morning_routine (highest, last to be cut).
   *
   * Lower-priority events are skipped at 100% of cap; higher-priority events
   * only at 150%+, giving headroom for the morning briefing.
   */
  private shouldSkipForCostCap(event: Event): boolean {
    const cap = this.config.autonomousDailyCostCapUsd;
    if (cap == null) return false;

    const tz = this.config.timezone || undefined;
    const bounds = getAgentDayBoundsUtc(tz, this.config.dayBoundaryHour);
    // better-sqlite3 caches prepared statements internally by SQL string,
    // so this.db.prepare() with a static string is effectively free.
    const row = this.db
      .prepare(EventDispatcher.COST_CAP_SQL)
      .get(bounds.start, bounds.end) as { cost: number };

    const todayCost = row.cost;
    if (todayCost < cap) return false;

    // Priority-based degradation: assign each routine a threshold multiplier.
    // Lower multiplier = skipped sooner.
    const routine = isRoutineEvent(event)
      ? (event as RoutineEvent).routine
      : null;
    const thresholds: Record<string, number> = {
      hourly_check: 1.0,      // skipped first (at 100% of cap)
      roadmap_refresh: 1.2,   // skipped at 120%
      evening_review: 1.5,    // skipped at 150%
      morning_routine: 2.0,   // last to be cut (only at 200%)
    };
    const threshold = routine ? (thresholds[routine] ?? 1.0) : 1.0;

    return todayCost >= cap * threshold;
  }

  private async handleEvent(event: Event): Promise<void> {
    try {
      await this.handleEventInner(event);
    } catch (err) {
      // Top-level catch prevents unhandled promise rejections from crashing the process
      // (handleEvent is called with `void` — fire-and-forget — so rejections are unhandled)
      logger.error(
        { err, eventType: event.type, source: event.source },
        "Unhandled error in event processing",
      );
    }
  }

  private async handleEventInner(event: Event): Promise<void> {
    const sem = this.isReactive(event) ? this.reactiveSem : this.autonomousSem;
    await sem.acquire();
    try {
      await this.dispatchSafe(event);
    } finally {
      sem.release();
    }
  }

  /**
   * Public entry point. Delegates to the HourlyCheckCoordinator.
   * The dispatcher keeps the wrapper because tests + the cron entry
   * call `dispatcher.triggerHourlyCheck(source, opts)` directly.
   */
  async triggerHourlyCheck(
    source: string,
    options: TriggerHourlyCheckOptions = {},
  ): Promise<TriggerHourlyCheckResult> {
    return this.hourlyCheck.trigger(source, options);
  }


  /**
   * Advisory check: is a morning routine execution or retry currently in
   * progress? Synchronous (no async) so callers can atomically gate other
   * work without introducing microtask race windows.
   *
   * C5 fix: detects retry rows via `task_context.routine='morning_routine'`
   * instead of a fragile `task_description LIKE 'Morning routine retry%'`
   * substring match. The schedule row's task_context is written by
   * scheduleMorningRetry() below, so this JSON path is authoritative even
   * if the human-readable description string later changes.
   *
   * Public (not private) because Phase 4's `AuthHealthMonitor.checkAll()`
   * shares the same skip-while-morning-routine-active invariant as the
   * hourly check, and injects this method as an option so a probe tick
   * running concurrently with morning routine can no-op cleanly. See
   * `docs/design/09-safety-cost.md` §9.5.4.
   */
  isMorningRoutineActive(): boolean {
    if (this.morningRoutineInProgress) {
      return true;
    }
    const row = this.db.prepare(
      `SELECT 1 as active
       FROM agent_schedule
       WHERE status IN ('pending', 'running')
         AND task_type = 'wake'
         AND json_extract(task_context, '$.routine') = 'morning_routine'
       LIMIT 1`,
    ).get() as { active: number } | undefined;
    return !!row;
  }

  private async dispatchSafe(event: Event): Promise<void> {
    const trigger: "reactive" | "autonomous" = this.isReactive(event) ? "reactive" : "autonomous";
    const startMs = Date.now();
    logger.info({ eventType: event.type, source: event.source, trigger }, "Event processing started");
    // SSE-progress hook (file-relative to A2): announce routine start so the
    // dashboard can render "Generating today's status…" before the first turn
    // executes. Fires AFTER the setup-gate / cost-cap short-circuits below
    // would have skipped — so a skipped routine never emits a phantom
    // `routine_started` without a matching `routine_completed`. Routine
    // events only; messages / scheduled.dm have their own UX surfaces.
    const broadcastRoutine = isRoutineEvent(event) ? (event as RoutineEvent) : null;
    let routineStartBroadcast = false;
    try {
      // Setup gate — skip all autonomous work while initial setup is
      // incomplete or a setup conversation is active. Reactive work is
      // exempt: user DMs (including the dashboard setup chat itself),
      // mentions in channels, CRITICAL-priority events, and explicit
      // dashboard-initiated actions (e.g. dashboard_regenerate). The
      // `isReactive` check is the semantic match — `isMessageEvent` alone
      // is both too broad (channel messages without mention are dropped
      // as a personal-agent policy) and too narrow (dashboard_regenerate
      // is not a message event but is user-initiated).
      //
      // Scheduled wake tasks stay in the agent_schedule table in 'pending'
      // — ScheduleWatcher's top-level gate prevents claiming them, and
      // `discardStalePendingSchedules` will tidy anything left over
      // across day boundaries.
      if (!this.isReactive(event)) {
        const setupBlock = this.isAutonomousAllowed();
        if (setupBlock !== null) {
          this.audit.logSkip(event, setupBlock, trigger);
          logger.info(
            { eventType: event.type, source: event.source, reason: setupBlock },
            "Event skipped — autonomous work paused for setup",
          );
          return;
        }

        // Autonomous daily cost cap — safety net distinct from removed Phase 9
        // maxDailyCostUsd (which blanket-blocked all sessions including DMs).
        // Reactive sessions always pass. Degradation priority: hourly_check is
        // skipped first, morning_routine last.
        if (this.shouldSkipForCostCap(event)) {
          this.audit.logSkip(event, "autonomous_cost_cap_exceeded", trigger);
          logger.info(
            { eventType: event.type, source: event.source },
            "Event skipped — autonomous daily cost cap exceeded",
          );
          return;
        }
      }

      if (broadcastRoutine) {
        this.broadcastRoutineProgress("routine_started", broadcastRoutine);
        routineStartBroadcast = true;
      }
      await this.dispatch(event);
      const durationMs = Date.now() - startMs;
      logger.info({ eventType: event.type, source: event.source, durationMs }, "Event processing completed");
      if (broadcastRoutine) {
        this.broadcastRoutineProgress("routine_completed", broadcastRoutine, {
          durationMs,
          result: "success",
        });
      }
    } catch (err) {
      const durationMs = Date.now() - startMs;
      logger.error(
        { err, eventType: event.type, source: event.source, durationMs },
        "Event processing failed",
      );
      this.audit.logError(
        event,
        err as Error,
        trigger,
        buildLogErrorContext(err, durationMs),
      );
      // Only emit `routine_completed` if we previously emitted
      // `routine_started`; otherwise the dashboard would receive an
      // orphan completion for a routine that never started (e.g. error
      // thrown by the setup-gate audit write itself).
      if (broadcastRoutine && routineStartBroadcast) {
        this.broadcastRoutineProgress("routine_completed", broadcastRoutine, {
          durationMs,
          result: "error",
        });
      }
      await this.errorRouter.handleError(event, err as Error);
    } finally {
      if (isRoutineEvent(event) && event.routine === "hourly_check") {
        this.hourlyCheckInProgress = false;
        this.hourlyCheckInProgressAt = null;
      }
    }
  }

  private async dispatch(event: Event): Promise<void> {
    if (isMessageEvent(event)) {
      if (event.isDm || event.isMention) {
        await this.runWithSessionGate(this.getMessageExecutionKey(event), () =>
          this.handleMessage(event),
        );
      } else {
        // Personal agent — channel messages without mention are dropped.
        // Adapters already filter these, but guard here as defense-in-depth.
        this.audit.logSkip(event, "channel_message_ignored", "autonomous");
        logger.debug(
          { eventType: event.type, source: event.source, channel: event.channel },
          "Channel message without mention dropped — personal agent does not process multi-user channel traffic",
        );
        return;
      }
    } else if (isRoutineEvent(event)) {
      const routine = (event as RoutineEvent).routine;
      // Pre-routine morning_routine gate for review routines. The
      // evening / weekly / monthly review prompts all read today.md +
      // dossiers + agent-journal — without a completed morning_routine
      // for the current agent-day these files are stale or missing,
      // and the review would synthesise nonsense from yesterday's data.
      // Spec: enqueue a morning_routine wake (recovery) and skip the
      // review for this tick. The next scheduled review tick will see
      // a completed morning_routine and proceed normally.
      //
      // Why agent_actions (not today.md): today.md can be edited by the
      // user (manual rollover, DM-driven writes). The 2026-05-14
      // sleep-skip incident hit this exact failure mode — today.md
      // showed the new date while morning_routine had never run. See
      // `morningRoutineRanToday` in `bootstrap/schedule-helpers.ts`.
      if (REVIEW_ROUTINES_REQUIRING_MORNING.has(routine)) {
        if (!morningRoutineRanToday(this.db, this.config)) {
          const queueWake = this.queueMorningRoutineWake;
          if (queueWake) {
            const queueResult = queueWake(`review_dependency:${routine}`);
            logger.info(
              { routine, eventType: event.type, queueResult },
              "Review routine skipped — morning_routine not yet complete for current agent-day; enqueued morning_routine wake",
            );
          } else {
            logger.warn(
              { routine, eventType: event.type },
              "Review routine skipped — morning_routine not yet complete and queueMorningRoutineWake not wired",
            );
          }
          this.audit.logSkip(
            event,
            "morning_routine_pending_for_today",
            "autonomous",
          );
          return;
        }
      }
      if (routine === "morning_routine") {
        await this.morningRoutine.executeMorningRoutine(event);
      } else if (routine === "roadmap_refresh") {
        await this.scheduledTasks.executeRoadmapRefresh(event);
      } else if (routine === "skill_curation") {
        // P22 §3.4 step 4. The optimizer runs in an isolated workdir under
        // ~/.personal-agent/optimizer-workdir/<runId>/ with a hard-restricted
        // allowedTools envelope (curl + Read only). The MaterializeOptimizer
        // hook is wired in `index.ts`; if absent, the routine no-ops with an
        // audit log. This is the safety floor — without the materializer the
        // session would otherwise inherit standard executor allowedTools, so
        // declining to execute is the correct behaviour for an unwired
        // installation.
        if (!this.materializeOptimizerWorkdir) {
          this.audit.logSkip(
            event,
            "skill_curation_unwired",
            "autonomous",
          );
          return;
        }
        await this.scheduledTasks.executeSkillCurationRoutine(event);
      } else {
        // hourly_check, evening_review, weekly_review, monthly_review
        // Tier is resolved from process-key defaults by BackendRouter.
        await this.scheduledTasks.executeDefault(event);
      }
    } else if (isScheduledDmEvent(event)) {
      // SCHEDULED-DM-IMPLEMENTATION-PLAN §3.6 — serialize behind any
      // in-flight owner-facing DM (across BOTH OWNER_DM_SCOPE and
      // DASHBOARD_CHAT_SCOPE) so the briefing never composes
      // concurrently with a DM reply that's currently answering the
      // same topic. Sort order on key acquisition is the
      // deadlock-prevention contract.
      await this.runWithSessionGates(
        [
          `${OWNER_DM_SCOPE}:${OWNER_SCOPE_KEY}`,
          `${DASHBOARD_CHAT_SCOPE}:${DASHBOARD_SCOPE_KEY}`,
        ],
        async () => {
          // §3.6.1 max-wait — drop the briefing if gate-acquisition
          // pushed delivery past `maxBriefingDelayMinutes` of the
          // scheduled time. Loses the daily heartbeat on chatty
          // mornings; preserves "morning" semantics on quiet ones.
          if (event.scheduleId !== undefined) {
            const row = this.db
              .prepare(
                "SELECT scheduled_for FROM agent_schedule WHERE id = ?",
              )
              .get(event.scheduleId) as { scheduled_for: string } | undefined;
            if (row) {
              const lateMs =
                Date.now() - parseSqliteUtcMs(row.scheduled_for);
              const budgetMs =
                this.config.maxBriefingDelayMinutes * 60_000;
              if (lateMs > budgetMs) {
                this.db
                  .prepare(
                    "UPDATE agent_schedule SET status = 'skipped' WHERE id = ? AND status = 'running'",
                  )
                  .run(event.scheduleId);
                logger.info(
                  {
                    eventType: event.type,
                    scheduleId: event.scheduleId,
                    lateMs,
                    budgetMs,
                  },
                  "scheduled.dm dropped — gate acquisition exceeded max delay",
                );
                return;
              }
            }
          }
          await this.scheduledTasks.executeScheduledTask(event);
        },
      );
    } else if (isAgentTaskEvent(event)) {
      // scheduled.task — no gate, retains existing parallel-execution
      // behavior. (scheduled.dm subtype is handled above.)
      await this.scheduledTasks.executeScheduledTask(event);
    } else {
      await this.scheduledTasks.executeDefault(event);
    }
  }

  private getMessageExecutionKey(event: MessageEvent): string {
    const { scope, scopeKey } = getConversationScope({
      platform: event.platform,
      channel: event.channel,
      threadId: event.threadId,
      isDm: event.isDm,
      // Forks docs_qa traffic onto its own gate so a QA lookup does not
      // queue behind an in-flight chat turn (or vice versa).
      intent: event.intent,
    });
    return `${scope}:${scopeKey}`;
  }

  private async runWithSessionGate<T>(
    key: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    return this.sessionGates.runWithSessionGate(key, fn);
  }

  /**
   * Acquire multiple session gates sequentially in lexicographic order
   * before invoking `fn`. Used by the `scheduled.dm` dispatch path to
   * serialize a briefing behind ALL owner-facing DM scopes
   * (messaging-app DMs and dashboard chat).
   *
   * SCHEDULED-DM-IMPLEMENTATION-PLAN §3.6.
   */
  private async runWithSessionGates<T>(
    keys: string[],
    fn: () => Promise<T>,
  ): Promise<T> {
    return this.sessionGates.runWithSessionGates(keys, fn);
  }

  /**
   * Handle `/auth` prefix commands from owner DMs.
   * Phase 5 §4.2 (fix codex, cancel), Phase 6 §5.3 (fix gemini),
   * Phase 7 §6.1 (fix all).
   * Returns `true` if the message was consumed (caller should return).
   */
  private async handleAuthCommand(event: MessageEvent): Promise<boolean> {
    // D-3 forward — see dispatcher-message-handler.ts. Kept as a thin
    // shim so `(dispatcher as any).handleAuthCommand` private-access
    // casts in dispatcher.test.ts keep working until the transitional
    // shims are dropped (file-split-plan.md §15).
    return this.messageHandler.handleAuthCommand(event);
  }

  private async handleMessage(event: MessageEvent): Promise<void> {
    // D-3 forward — see dispatcher-message-handler.ts. Kept as a thin
    // shim so `(dispatcher as any).handleMessage` private-access casts
    // in dispatcher.test.ts keep working until the transitional shims
    // are dropped (file-split-plan.md §15).
    return this.messageHandler.handle(event);
  }

  /**
   * Mark an in-flight event as having sent a user-facing notification via
   * `POST /api/notify`. Called by the API layer when the route handler sees
   * an `X-Pa-Event-Correlation-Id` header (auto-injected by the shim
   * env). `processResult` consumes the entry to suppress the implicit
   * final-text DM forward.
   */
  markEventNotified(correlationId: string): void {
    if (correlationId) {
      this.notifiedEvents.add(correlationId);
    }
  }

  /**
   * STAGE-C-DM-FRESHNESS-PLAN §Task 4 — assemble the DM-only freshness
   * telemetry payload that gets persisted into `agent_actions.detail`.
   * Pulled into its own helper so the message-dispatch path stays
   * readable and so unit tests can exercise the SQL aggregation in
   * isolation.
   */
  private collectDmFreshnessTelemetry(input: {
    sessionId: number;
    canResume: boolean;
    resumeSnapshotAgeMinutes: number;
    turnStartedAtSqlite: string;
    userContent: string;
  }): {
    resumed: boolean;
    agentLogLagMinutes: number;
    loudWritesSinceSessionStart: number;
    quietWritesSinceSessionStart: number;
    refetchedToday: boolean;
    triggerMatched: boolean;
  } {
    // D-3 forward — see dispatcher-message-handler.ts. Kept as a thin
    // shim so private-access test casts keep working until the
    // transitional shims are dropped (file-split-plan.md §15).
    return this.messageHandler.collectDmFreshnessTelemetry(input);
  }

  /**
   * Create rolling summaries for DM conversations.
   * Called at 4 AM (day boundary) before morning routine.
   *
   * Session-independent: queries messages directly from the DB regardless
   * of which session they belong to. Does NOT expire active sessions —
   * session lifecycle is handled by getOrCreateDm's day boundary check.
   *
   * Rolling summary: previous summary + new messages → new summary.
   * This prevents unbounded growth (summarizing days of history each time).
   *
   * Threshold gate: only runs AI summarization when accumulated messages
   * since the LAST summary exceed the threshold (> 30 messages or > 5000
   * chars of raw text). Below threshold, nothing is saved — the message
   * count accumulates across days until the threshold is reached.
   */
  async summarizeDmSessions(): Promise<void> {
    const platforms = this.sessionMgr.getDmPlatformsWithNewMessages();
    if (platforms.length === 0) return;

    const MSG_THRESHOLD = 30;
    const SIZE_THRESHOLD = 5000;
    // Force summarization before session retention (7 days) deletes messages
    const DAYS_THRESHOLD = 6;

    for (const platform of platforms) {
      try {
        const newMessages = this.sessionMgr.getUnsummarizedDmMessages(platform);
        if (newMessages.length === 0) continue;

        const rawNew = newMessages
          .map((m) => `[${this.resultProcessor.formatSummaryRole(m)}] ${m.content}`)
          .join("\n");

        // Check if oldest message is approaching retention cutoff
        const oldestMs = parseSqliteUtcMs(newMessages[0].timestamp);
        const daysOld = (Date.now() - oldestMs) / (1000 * 60 * 60 * 24);
        const approachingRetention = daysOld >= DAYS_THRESHOLD;

        // Below threshold: skip — count accumulates until next check
        if (
          newMessages.length <= MSG_THRESHOLD &&
          rawNew.length <= SIZE_THRESHOLD &&
          !approachingRetention
        ) {
          logger.debug(
            { platform, messageCount: newMessages.length, rawSize: rawNew.length },
            "DM messages below threshold, skipping summarization",
          );
          continue;
        }

        // AI compression (rolling: previous summary + new messages → condensed)
        const previousSummary = this.sessionMgr.getPreviousDmSummary(platform);
        const parts: string[] = [];
        if (previousSummary) {
          parts.push(`Previous context:\n${previousSummary}`);
        }
        parts.push(
          `New messages:\n${newMessages.map((m) => `${this.resultProcessor.formatSummaryRole(m)}: ${m.content}`).join("\n")}`,
        );
        const summary = await this.agentRouter.summarize(parts.join("\n\n"));

        this.sessionMgr.saveDmSummary(platform, summary, newMessages.length);
        logger.info(
          { platform, messageCount: newMessages.length, hadPreviousSummary: !!previousSummary },
          "DM conversation summarized",
        );
      } catch (err) {
        logger.error(
          { err, platform },
          "Failed to summarize DM conversation",
        );
      }
    }
  }

  /** Delegate to shared isRoadmapStale utility. */
  isRoadmapStale(maxAgeDays = 15): boolean {
    return isRoadmapStale(getContextDir(this.config, this.db), maxAgeDays);
  }

  /**
   * Emit a roadmap_refresh routine event.
   * Dedup guard: skips if emitted within the last 5 minutes unless
   * `options.bypassDedup` is true. Dashboard-initiated regeneration is
   * the one legal caller that may bypass dedup; all internal call-sites
   * honor it so a burst of signals (flight + hotel confirmations in the
   * same minute) collapses into a single refresh.
   */
  emitRoadmapRefresh(
    source: string,
    options?: { bypassDedup?: boolean },
  ): void {
    const DEDUP_MS = 5 * 60 * 1000;
    const bypassDedup = options?.bypassDedup === true;
    if (!bypassDedup && Date.now() - this.lastRoadmapRefreshEmitMs < DEDUP_MS) {
      logger.info({ source }, "Skipping roadmap_refresh (dedup, emitted recently)");
      return;
    }
    this.lastRoadmapRefreshEmitMs = Date.now();
    logger.info({ source, bypassDedup }, "Emitting roadmap_refresh");
    void this.eventBus.put({
      ...createEvent({
        type: "routine.roadmap_refresh",
        source,
        priority: EventPriority.NORMAL,
      }),
      routine: "roadmap_refresh",
    } as RoutineEvent);
  }
}
