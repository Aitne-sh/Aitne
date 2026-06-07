/**
 * Event-processing pipeline bootstrap — §10 of the legacy `startup()` IIFE.
 *
 * Extracted from `index.ts` per
 * `docs/design/appendices/index-bootstrap-stage-split.md` Phase B-4.
 * Companion to `bootstrap/db.ts`, `bootstrap/adapters.ts`,
 * `bootstrap/services.ts`, `bootstrap/observers.ts`, and `bootstrap/api.ts`;
 * same Pattern-C shape (file-split-plan.md §10).
 *
 * Responsibilities (in run order — preserves the §10 ordering invariants
 * captured by the design doc's §11):
 *  1. Construct the four agent backends (Claude / Codex / Gemini / Opencode)
 *     and wire the per-session MCP context onto each.
 *  2. Run the boot janitors that close orphaned proxy / pool / delegated-task
 *     tempdirs and rows so the dispatcher starts from a clean state.
 *  3. Construct `DelegatedBackendInvoker`, `NotificationManager`, and
 *     `AuthTelemetry`. The shared `makeAuthNotifier` factory binds the
 *     monitor + recovery surfaces to the same notification pipeline.
 *  4. Build the `BackendRouter` with its `prepareSessionDir` fallback
 *     re-materialization callback (CLAUDE.md invariant: a Claude→Codex
 *     fallback would otherwise leave the dir with only CLAUDE.md and no
 *     AGENTS.md). Validates the built-in skill source tree + delegated
 *     mode startup contracts before any execute.
 *  5. Construct `ContextBuilder`, `SessionManager`, `MessageRecorder`,
 *     `EventBroadcaster`, `AuditLogger`. Build `rematerializeActiveDmWorkdirs`
 *     and install it as the real `onMailScopeChanged` handler via the
 *     `setMailScopeChangedHandler` dep (forward-reference resolved).
 *  6. Construct `MigrationLock`, `ContextWriteGate`, `SignalDetector`,
 *     `ScopedReadSensitiveTokenManager`, then the `EventDispatcher`. Apply
 *     every dispatcher setter (signal detector, docs citation lookup,
 *     dashboard stream fan-out, attachment store, event broadcaster, voice
 *     transcriber, auth recovery/monitor, delegated-sync refresh, bang
 *     command registry, skill curation hooks).
 *  7. Construct `AuthHealthMonitor` + `AuthRecovery` (after dispatcher so
 *     the `isMorningRoutineActive` closure resolves immediately). Reconcile
 *     in-flight recoveries, fire the initial keepalive sweep, and arm the
 *     daily sweep timer.
 *  8. Wire the roadmap-refresh trampoline through `setRoadmapRefreshSink`
 *     so the observer pollers built in B-2 can emit refresh signals now
 *     that the dispatcher exists.
 *  9. Build the on-demand `buildDelegatedSyncWorker` + register it when at
 *     least one integration is in `delegated` mode. Register the
 *     `DelegatedProbeObserver` so the §4.5 connector-health cache stays
 *     fresh.
 *  10. Return the cross-stage closures (`handleSecretChange`,
 *      `handleGoogleServicesReady`, `handlePromptContextChanged`,
 *      `rematerializeActiveDmWorkdirs`) the B-3 API factory and the
 *      `index.ts` post-startup-complete flush consume.
 *
 * Ordering invariants this module preserves (design §11):
 *  - Wiki token resolver (B-1) and `mergeRuntimeSettingsFromDb` (B-1) run
 *    before this factory is invoked. The dispatcher reads the merged
 *    config directly.
 *  - Orphan dashboard_chat session close (B-1) runs before SessionManager
 *    is constructed here.
 *  - Fallback re-materialization is wired into BackendRouter before any
 *    backend fallback can occur — the closure lives inside this factory,
 *    same lexical proximity as the pre-extraction code.
 *  - The roadmap-refresh sink (`setRoadmapRefreshSink` dep) is installed
 *    immediately after the dispatcher is constructed but BEFORE
 *    `observerManager.startAll()` runs (which happens later in `index.ts`).
 *  - `handleSecretChange` and `handleGoogleServicesReady` are returned
 *    rather than registered here — the B-3 api factory wires the former
 *    into `ApiDependencies.onSecretChanged` and `index.ts` composes the
 *    latter with the `startupComplete`/`pendingGoogleServicesReady`
 *    deferral wrapper before threading the wrapper into B-3 via
 *    `onGoogleServicesReady`.
 *
 * Test surface (per design doc §10):
 *  - `createSecretChangeHandler` — exported for the scope-routing matrix
 *    test (slack, telegram, discord, notion, github, google, apple_calendar,
 *    apiToken, unknown). The Notion hot-register branch's three gates
 *    (services.notion, observerManager.has, notionDatabaseIds.length,
 *    shouldStartObserversFor) are pinned here. The GitHub webhook-mode
 *    upgrade branch's two gates (getGitWatcher non-null, secretState.
 *    githubWebhookConfigured) are pinned here.
 *  - `createGoogleServicesReadyHandler` — exported for the calendar
 *    hot-register / morning-routine gate / roadmap-refresh test matrix.
 */

import { join } from "node:path";
import { createReadStream } from "node:fs";
import { randomBytes } from "node:crypto";
import type Database from "better-sqlite3";

import type { AgentConfig } from "../config.js";
import { getContextDir, isRoadmapStale } from "../config.js";
import { resolveUserSkillsRoot } from "../core/user-skills-root.js";
import { isUserPaused } from "../db/runtime-state.js";
import { readIntegrations } from "../db/integrations-store.js";
import { selectGithubRepoSlugs } from "../db/repositories-store.js";
import { EventPriority } from "@aitne/shared";
import { createLogger } from "../logging.js";
import { markContextChanged } from "../core/dashboard-session-controls.js";

// Core / dispatcher chain
import type { EventBus } from "../core/event-bus.js";
import { EventDispatcher } from "../core/dispatcher.js";
import { SignalDetector } from "../core/signal-detector.js";
import { ContextBuilder } from "../core/context-builder.js";
import { getTaskFlow, initTaskFlows } from "../core/prompts.js";
import { SessionManager } from "../core/session-manager.js";
import { MessageRecorder } from "../core/message-recorder.js";
import { ScopedReadSensitiveTokenManager } from "../core/read-sensitive-token-manager.js";
import { createDefaultBangCommandRegistry } from "../core/bang-commands/index.js";
import {
  ContextWriteGate,
  MigrationLock,
  type TodayWriteLockManager,
} from "../core/today-write-lock.js";
import type { RoadmapWriteLockManager } from "../core/roadmap-write-lock.js";
import {
  applyPromptContextStaleness,
  type PromptContextChangedCallback,
} from "../core/context-staleness.js";

// Backends
import { ClaudeCodeCore } from "../core/backends/claude-code-core.js";
import { CodexCore } from "../core/backends/codex-core.js";
import { GeminiCliCore } from "../core/backends/gemini-cli-core.js";
import { OpencodeCore } from "../core/backends/opencode-core.js";
import {
  createOpencodeServerManager,
  type OpencodeServerManager,
} from "../core/backends/opencode-server-manager.js";
import { BackendRouter } from "../core/backends/backend-router.js";
import { AuthTelemetry } from "../core/backends/auth-telemetry.js";
import {
  AuthHealthMonitor,
  AUTH_PROBE_NOTIFICATION_CATEGORY,
  type AuthHealthNotifier,
} from "../core/backends/auth-health-monitor.js";
import { AuthRecovery } from "../core/backends/auth-recovery.js";
import type { IAgentCore } from "../core/agent-core.js";

// Workdir / skills
import {
  ensureBackendMaterialized,
  syncAllUserSkills,
  buildConfiguredServices,
  refreshDmSessionWorkdirs,
  validateDelegatedStartup,
  type RefreshDmSessionWorkdirsResult,
} from "../core/workdir.js";
import { validateBuiltinSkillSourceTree } from "../core/skills-compiler-variants.js";

// Audit / safety / messaging
import { AuditLogger } from "../safety/audit.js";
import { AgentExecutionRecorder } from "../core/agent-execution-recorder.js";
import { AgentExecutionTracker } from "../core/agents/agent-execution-tracker.js";
import { loadAgentSuccessCriteria } from "../core/agents/definition-criteria.js";
import type { AgentWriteTracker } from "../safety/agent-write-tracker.js";
import { NotificationManager } from "../adapters/notification-manager.js";
import type { MessageHub } from "../adapters/message-hub.js";
import type { DashboardAdapter } from "../adapters/dashboard-adapter.js";
import { DocsQAAdapter } from "../adapters/docs-qa-adapter.js";
import { CompositeDashboardStream } from "../adapters/composite-dashboard-stream.js";
import { EventBroadcaster } from "../api/routes/sse.js";

// Services / observers
import type { ServiceRegistry } from "../services/service-registry.js";
import type { EncryptedBlobStore } from "../secrets/encrypted-blob-store.js";
import type { SecretBroker } from "../secrets/secret-broker.js";
import type { SecretStore } from "../secrets/secret-store.js";
import type { AttachmentStore } from "../services/attachments/store.js";
import { VoiceTranscriber } from "../services/voice/transcriber.js";
import {
  DelegatedBackendInvoker,
  runDelegatedTaskOrphanJanitor,
  runProxyTempdirJanitor,
} from "../services/delegated-backend-invoker.js";
import { runSessionPoolTempdirJanitor } from "../services/delegated-task-session-pool.js";
import {
  DelegatedSyncWorker,
  hasActiveDelegatedSyncIntegration,
} from "../observers/delegated-sync-worker.js";
import { shouldStartObserversFor } from "../core/integration-lifecycle.js";
import type { ObserverManager } from "../observers/manager.js";
import type { GitWatcher } from "../observers/git-watcher.js";
import type { CalendarPoller } from "../observers/calendar-poller.js";
import type { NotionPoller } from "../observers/notion-poller.js";
import type { AgentScheduler } from "../core/scheduler.js";
import { makeDbLookup as makeDocsCitationLookup } from "../core/docs/citation-validator.js";

import type { BootstrapSecretState } from "./services.js";
import { hasFreshAgentDayTodayMd, readSkillCurationCadence } from "./schedule-helpers.js";

const logger = createLogger("daemon-bootstrap-event-pipeline");

/**
 * Result returned by {@link rematerializeActiveDmWorkdirs} — null when
 * there are no active DM sessions to refresh.
 */
export interface DmWorkdirRefreshResult {
  readonly summary: RefreshDmSessionWorkdirsResult;
  readonly mailAccounts: ReadonlyArray<unknown>;
}

export interface BootstrapEventPipelineDeps {
  // ── Foundational ────────────────────────────────────────────────────────
  readonly db: Database.Database;
  readonly config: AgentConfig;
  readonly eventBus: EventBus;
  readonly secretBroker: SecretBroker;
  readonly blobStore: EncryptedBlobStore;
  readonly writeTracker: AgentWriteTracker;

  // ── Services + adapters (built earlier in §5/§6) ─────────────────────
  readonly services: ServiceRegistry;
  readonly messageHub: MessageHub;
  readonly dashboardAdapter: DashboardAdapter;
  readonly attachmentStore: AttachmentStore;

  // ── Write locks (built early in §4 so observers can read them) ───────
  readonly morningRoutineLock: TodayWriteLockManager;
  readonly roadmapWriteLock: RoadmapWriteLockManager;

  // ── Secret state (B-2 read; the github webhook branch reads it) ──────
  readonly secretState: BootstrapSecretState;

  // ── Observer-side handles (B-2 result) ───────────────────────────────
  readonly observerManager: ObserverManager;
  readonly buildCalendarPoller: () => CalendarPoller | null;
  readonly buildNotionPoller: () => NotionPoller | null;
  readonly getGitWatcher: () => GitWatcher | null;

  // ── Adapter reloaders consumed by handleSecretChange ─────────────────
  readonly reloadDiscordAdapter: (force: boolean) => Promise<void>;
  readonly reloadSlackAdapter: (force: boolean) => Promise<void>;
  readonly reloadTelegramAdapter: (force: boolean) => Promise<void>;

  // ── Service reloaders consumed by handleSecretChange ─────────────────
  readonly reloadGoogleServices: () => Promise<void>;
  readonly reloadAppleCalendarService: () => Promise<void>;
  readonly reloadNotionService: () => Promise<void>;
  readonly reloadGitHubService: () => Promise<void>;

  // ── Scheduler — handleGoogleServicesReady's morning-routine gate ─────
  readonly scheduler: AgentScheduler;

  /**
   * Reads index.ts's `startupComplete` latch. Threaded through to the
   * `handleSecretChange("notion")` hot-register branch so it can avoid
   * double-starting the poller during the bootstrap window — see
   * `SecretChangeHandlerDeps.isStartupComplete` for the full rationale.
   */
  readonly isStartupComplete: () => boolean;

  // ── Forward-reference wiring ──────────────────────────────────────────
  /**
   * `MailAccountRegistry` was built in `index.ts` §6 with a placeholder
   * `onScopeChanged`. This setter installs the real handler once
   * `rematerializeActiveDmWorkdirs` + `eventBroadcaster` exist (mid-§10
   * in the pre-extraction code).
   */
  readonly setMailScopeChangedHandler: (cb: (reason: string) => void) => void;
  /**
   * Observer pollers (built in B-2 before the dispatcher exists) call a
   * `triggerRoadmapRefresh` trampoline that forwards to a `let` slot in
   * `index.ts`. This setter fills the slot with
   * `dispatcher.emitRoadmapRefresh` immediately after dispatcher
   * construction — observers don't fire the trampoline until
   * `observerManager.startAll()` runs further down in `index.ts`, by
   * which time the sink is installed.
   */
  readonly setRoadmapRefreshSink: (sink: (source: string) => void) => void;

  // ── Optional test seam ────────────────────────────────────────────────
  /**
   * Test-only override for the opencode server manager. Production passes
   * the real `createOpencodeServerManager()` factory implicitly; peer
   * tests of higher-level wiring inject a no-op stub.
   */
  readonly opencodeServerManager?: OpencodeServerManager;
}

export interface BootstrapEventPipelineResult {
  // ── Dispatcher chain ──────────────────────────────────────────────────
  readonly dispatcher: EventDispatcher;
  readonly sessionManager: SessionManager;
  readonly messageRecorder: MessageRecorder;
  readonly notificationManager: NotificationManager;
  readonly signalDetector: SignalDetector;
  readonly eventBroadcaster: EventBroadcaster;
  readonly auditLogger: AuditLogger;
  readonly docsQAAdapter: DocsQAAdapter;

  // ── Backend chain ─────────────────────────────────────────────────────
  readonly agentBackends: IAgentCore[];
  readonly opencodeServerManager: OpencodeServerManager;
  readonly delegatedBackendInvoker: DelegatedBackendInvoker;
  readonly authHealthMonitor: AuthHealthMonitor;
  readonly authRecovery: AuthRecovery;
  readonly authTelemetry: AuthTelemetry;
  readonly readTokenManager: ScopedReadSensitiveTokenManager;

  // ── Cross-stage locks (constructed here, consumed by B-3 api deps) ───
  readonly migrationLock: MigrationLock;
  readonly contextWriteGate: ContextWriteGate;

  // ── Delegated-sync worker accessors ───────────────────────────────────
  readonly buildDelegatedSyncWorker: () => DelegatedSyncWorker;
  readonly getDelegatedSyncWorker: () => DelegatedSyncWorker | null;

  // ── Cross-stage closures ──────────────────────────────────────────────
  readonly rematerializeActiveDmWorkdirs: (
    reason: string,
  ) => DmWorkdirRefreshResult | null;
  readonly handleSecretChange: (scope: string) => Promise<void>;
  readonly handleGoogleServicesReady: () => void;
  readonly handlePromptContextChanged: PromptContextChangedCallback;

  // ── Shutdown handles ──────────────────────────────────────────────────
  /** Daily auth-health keepalive sweep timer; cleared during graceful shutdown. */
  readonly keepaliveTimer: NodeJS.Timeout;
  /**
   * BROWSER_TASK_REDESIGN_PLAN.md §5 ask_user + §5.1 pending-queue
   * timeout. 30 s tick that sweeps overdue clarifications + queue
   * timeouts. Cleared during graceful shutdown alongside the keepalive
   * timer so the daemon process can exit cleanly.
   */
  readonly browserTaskDeadlineTimer: NodeJS.Timeout;

  // ── Browser-task surface (BROWSER_TASK_REDESIGN_PLAN.md §5 / §5.1) ──
  /**
   * Shared in-memory slot state for the browser-task surface. The
   * runner and the API route layer hold THIS instance (not a copy)
   * so a cancel-while-pending and a runner-side promote race on the
   * same value.
   */
  readonly browserTaskSlotStateRef: import(
    "../services/browser-task/browser-task-runner.js"
  ).SlotStateRef;
  /**
   * Per-install browser-task runner. Phase 1 ships without
   * `driver` wired so the runner returns `failed (not_implemented)`
   * after acquiring + releasing the slot (state-machine round-trip
   * still exercised). Phase 2 plumbs the Playwright + Claude SDK
   * driver into the same factory call.
   */
  readonly browserTaskRunner: import(
    "../services/browser-task/browser-task-runner.js"
  ).BrowserTaskRunner;
}

/**
 * Construct the event-processing pipeline (§10). See the file-level
 * docstring for the run order and the ordering invariants this factory
 * preserves.
 */
export async function createEventPipeline(
  deps: BootstrapEventPipelineDeps,
): Promise<BootstrapEventPipelineResult> {
  const {
    db,
    config,
    eventBus,
    secretBroker,
    blobStore,
    writeTracker,
    services,
    messageHub,
    dashboardAdapter,
    attachmentStore,
    morningRoutineLock,
    roadmapWriteLock,
    secretState,
    observerManager,
    buildCalendarPoller,
    buildNotionPoller,
    getGitWatcher,
    reloadDiscordAdapter,
    reloadSlackAdapter,
    reloadTelegramAdapter,
    reloadGoogleServices,
    reloadAppleCalendarService,
    reloadNotionService,
    reloadGitHubService,
    scheduler,
    isStartupComplete,
    setMailScopeChangedHandler,
    setRoadmapRefreshSink,
  } = deps;

  // ── Agent cores + per-session MCP context ──────────────────────────────
  const opencodeServerManager: OpencodeServerManager =
    deps.opencodeServerManager ?? createOpencodeServerManager();

  const agentCore = new ClaudeCodeCore(config, writeTracker);
  const codexCore = new CodexCore(config);
  const geminiCore = new GeminiCliCore(config, writeTracker, undefined, db);
  const opencodeCore = new OpencodeCore(
    config,
    writeTracker,
    opencodeServerManager,
  );

  // B-003 Phase 3 — wire the MCP session context so per-session workdirs
  // pick up the current DB + keychain state at spawn time. Each core stays
  // backward-compatible: without this call it simply runs without MCP.
  const mcpContext = { db, blobStore };
  agentCore.setMcpContext(mcpContext);
  codexCore.setMcpContext(mcpContext);
  geminiCore.setMcpContext(mcpContext);
  opencodeCore.setMcpContext(mcpContext);

  // ── Boot janitors ──────────────────────────────────────────────────────
  // DELEGATED-PROXY-API-DESIGN.md Phase A — sweep stale
  // `agent-sessions/proxy-*` tempdirs left by SIGKILL'd proxy invocations.
  const janitorRemoved = runProxyTempdirJanitor(config.dataDir);
  if (janitorRemoved > 0) {
    logger.info(
      { removed: janitorRemoved },
      "Boot janitor cleared stale delegated-proxy tempdirs",
    );
  }
  const poolJanitorRemoved = runSessionPoolTempdirJanitor(
    join(config.dataDir, "agent-sessions"),
  );
  if (poolJanitorRemoved > 0) {
    logger.info(
      { removed: poolJanitorRemoved },
      "Boot janitor cleared stale delegated-task pool tempdirs",
    );
  }
  // DELEGATED-TASK-MODE-DESIGN.md §11.1 — close `delegated_task.exec`
  // rows that were `in_progress` when the daemon last crashed.
  const taskOrphansClosed = runDelegatedTaskOrphanJanitor(db);
  if (taskOrphansClosed > 0) {
    logger.info(
      { closed: taskOrphansClosed },
      "Boot janitor closed orphaned delegated_task in-progress rows",
    );
  }

  const delegatedBackendInvoker = new DelegatedBackendInvoker({
    db,
    config,
    cores: {
      claude: agentCore,
      codex: codexCore,
      gemini: geminiCore,
      opencode: opencodeCore,
    },
  });

  // ── Notification + auth telemetry + shared notifier factory ────────────
  // Sweep stale `batched` rows from a prior crash before the new
  // dispatcher starts producing notifications. A queued (status='batched')
  // row whose flush timer didn't fire (process killed) would otherwise
  // linger forever and confuse the dashboard's notification feed.
  NotificationManager.closeStaleBatchedRows(db);
  const notificationManager = new NotificationManager(messageHub, db, config);
  const authTelemetry = new AuthTelemetry(db);

  const makeAuthNotifier = (source: string): AuthHealthNotifier => ({
    send: async (message, options) => {
      const kind = options?.kind ?? "keepalive";
      const typeMap: Record<string, string> = {
        probe_failure: "auth.probe_failure",
        recovery: "auth.recovery",
        keepalive: "auth.keepalive_reminder",
      };
      const notificationType = typeMap[kind] ?? "auth.keepalive_reminder";
      // probe_failure and recovery bypass quiet-hours; keepalive does not.
      const category =
        kind === "keepalive" ? "auth-health" : AUTH_PROBE_NOTIFICATION_CATEGORY;
      await notificationManager.send(
        message,
        {
          type: notificationType,
          source,
          priority: EventPriority.NORMAL,
          timestamp: new Date(),
          data: {},
          correlationId: randomBytes(8).toString("hex"),
        },
        {
          priority: "normal",
          category,
          destinationMode: "configured_only",
        },
      );
    },
  });

  // ── Read-token manager + backend router with fallback re-materialize ──
  const readTokenManager = new ScopedReadSensitiveTokenManager();

  const agentRouter = new BackendRouter(
    db,
    config,
    [agentCore, codexCore, geminiCore, opencodeCore],
    notificationManager,
    authTelemetry,
    // Materialize instruction files for a fallback backend in an existing
    // session workdir. Without this, a Claude→Codex heavy-tier fallback
    // would leave the dir with only CLAUDE.md and no AGENTS.md.
    (sessionDir, backendId, eventType, processKey, wikiWorkspaceName, messageText) => {
      const cfgServices = buildConfiguredServices(config, {
        ...services,
        github: selectGithubRepoSlugs(db).length > 0,
      });
      const mailAccounts = services.mail?.listActiveAccounts() ?? [];
      ensureBackendMaterialized(
        config.workspaceDir,
        sessionDir,
        backendId,
        eventType,
        processKey,
        cfgServices,
        mailAccounts,
        readIntegrations(db),
        config.character,
        wikiWorkspaceName,
        getContextDir(config, db),
        db,
        messageText ?? null,
      );
      syncAllUserSkills(sessionDir, resolveUserSkillsRoot(config));
    },
  );

  // docs/design/appendices/skills-unification.md Phase 1 §R5 / item 6 — refuse to boot on a
  // malformed source tree. Throws on slug-pattern violations and
  // `description.length > 280` for every built-in `SKILL.md`.
  validateBuiltinSkillSourceTree(
    join(config.workspaceDir, "agent-assets", "skills"),
  );

  // Startup validation — warn if any delegated-mode variant files are
  // missing. Never throws.
  {
    const startupIntegrations = readIntegrations(db);
    const missing = validateDelegatedStartup(
      config.workspaceDir,
      startupIntegrations,
    );
    if (missing.skills.length > 0 || missing.taskFlows.length > 0) {
      logger.warn(
        { missingSkills: missing.skills, missingTaskFlows: missing.taskFlows },
        "Delegated-mode variant files missing — agent will fall back to SKILL.md / direct task-flow for affected entries",
      );
    }
  }

  // ── Context builder + session/message recording + audit broadcaster ───
  const contextBuilder = new ContextBuilder(config, db, services);
  const sessionManager = new SessionManager(db, config);
  const messageRecorder = new MessageRecorder(db);
  const eventBroadcaster = new EventBroadcaster();
  const auditLogger = new AuditLogger(db, {
    // `/api/events/stream` is defined in terms of persisted agent_actions
    // rows, not raw EventBus payloads, so the broadcaster subscribes at
    // the audit layer.
    onRowInserted: (row) => eventBroadcaster.broadcastEvent(row),
  });

  // ── Agent execution recorder + tracker (AGENT_DEFINITIONS_DESIGN.md §8) ─
  // The recorder owns the `agent_executions` row lifecycle + the agent-day
  // `{date}` label; the tracker owns the per-firing begin/complete keyed by
  // event correlationId, success-criteria evaluation, and the SSE feed. Both
  // are wired into the dispatcher (+ the audit `agent_id` resolver) below.
  const agentExecutionRecorder = new AgentExecutionRecorder({
    db,
    timezone: config.timezone || undefined,
    dayBoundaryHour: config.dayBoundaryHour,
  });
  const agentExecutionTracker = new AgentExecutionTracker({
    db,
    recorder: agentExecutionRecorder,
    contextDir: getContextDir(config, db),
    emitSse: (event, payload) =>
      eventBroadcaster.broadcastEvent({
        kind: event,
        ...(payload as Record<string, unknown>),
      }),
    loadCriteria: loadAgentSuccessCriteria,
  });
  // Stamp `agent_actions.agent_id` for every row produced by the in-flight
  // firing — the tracker holds the resolved slug for the run's correlationId.
  auditLogger.setAgentIdResolver((event) =>
    agentExecutionTracker.currentAgentId(event.correlationId),
  );

  // ── DM workdir re-materialization (shared by mail scope + mode flips) ─
  const rematerializeActiveDmWorkdirs = (
    reason: string,
  ): DmWorkdirRefreshResult | null => {
    const sessions = sessionManager.listActiveDmSessions();
    if (sessions.length === 0) {
      logger.debug(
        { reason },
        "DM workdir refresh requested — no active DM sessions",
      );
      return null;
    }
    const cfgServices = buildConfiguredServices(config, {
      ...services,
      github: selectGithubRepoSlugs(db).length > 0,
    });
    const mailAccounts = services.mail?.listActiveAccounts() ?? [];
    // Read integration state fresh inside the closure so a Phase F mode
    // flip's pre-`writeIntegrations` row is not what gets baked.
    const integrations = readIntegrations(db);
    const summary = refreshDmSessionWorkdirs({
      projectRoot: config.workspaceDir,
      dataDir: config.dataDir,
      sessions,
      configuredServices: cfgServices,
      mailAccounts,
      integrations,
      character: config.character,
    });
    return { summary, mailAccounts };
  };

  // Real implementation of the mail-scope-changed hook. Forward-reference
  // was held open by the `setMailScopeChangedHandler` setter in `index.ts`.
  setMailScopeChangedHandler((reason: string) => {
    const result = rematerializeActiveDmWorkdirs(reason);
    if (!result) return;
    logger.info(
      { reason, ...result.summary },
      "Mail scope changed — DM session workdirs re-materialized",
    );
    eventBroadcaster.broadcastEvent({
      kind: "mail_scope_changed",
      reason,
      activeAccounts: result.mailAccounts.length,
      ...result.summary,
    });
  });

  // ── Migration / context-write gates + task flow init ──────────────────
  // Long timeout because cross-fs copies of large vaults may legitimately
  // run multiple minutes.
  const migrationLock = new MigrationLock(60 * 60 * 1000);
  const contextWriteGate = new ContextWriteGate();

  initTaskFlows(config.workspaceDir, config.dataDir);

  // ── Signal detector + dispatcher ──────────────────────────────────────
  const signalDetector = new SignalDetector(config, { db });

  const dispatcher = new EventDispatcher(
    eventBus,
    agentRouter,
    contextBuilder,
    getTaskFlow,
    notificationManager,
    sessionManager,
    messageRecorder,
    auditLogger,
    db,
    config,
    morningRoutineLock,
    services,
    roadmapWriteLock,
    writeTracker,
  );

  notificationManager.setSignalDetector(signalDetector);
  // Wire the scoped read-token manager into every backend so daemon-API
  // calls from `<sessionDir>` workdirs carry a per-session token, not the
  // legacy shared one. OpenCode is included for parity even though the
  // SDK currently runs in-process and offers no per-tool env injection
  // slot — see opencode-core.ts (issuedReadToken) for the gap; this call
  // keeps the issue/revoke bookkeeping consistent so a future env-
  // injection path lands on a wired manager rather than a silent undefined.
  agentCore.setReadTokenManager?.(readTokenManager);
  codexCore.setReadTokenManager?.(readTokenManager);
  geminiCore.setReadTokenManager?.(readTokenManager);
  opencodeCore.setReadTokenManager?.(readTokenManager);

  // Install the roadmap-refresh sink so observer pollers built in B-2 can
  // emit refresh signals via the `triggerRoadmapRefresh` trampoline. Until
  // this fires the trampoline is a no-op; the actual emit only happens
  // inside poll loops which start after `observerManager.startAll()` in
  // §13 of `index.ts`.
  setRoadmapRefreshSink((source) => dispatcher.emitRoadmapRefresh(source));

  // ── Dispatcher setters ────────────────────────────────────────────────
  dispatcher.setSignalDetector(signalDetector);

  // DOCS_QA_B7_DESIGN.md §11.1 — persistence-side citation validator for
  // docs_qa sessions. Inert for chat/DM/routine flows.
  const docsCitationLookup = makeDocsCitationLookup(db);
  dispatcher.setDocsCitationLookup(docsCitationLookup);

  // Docs-QA SSE adapter — DOCS_QA_B7_DESIGN.md §S4 / §S8. Fans out
  // alongside the dashboard adapter on the same `platform="dashboard"`
  // surface; the `intent: "docs_qa"` discriminator on inbound events
  // forks dispatch into the docs-qa task flow. Intentionally NOT
  // registered with `messageHub` (would collide with the dashboard adapter
  // on the shared platform key).
  const docsQAAdapter = new DocsQAAdapter(
    (event) => void eventBus.put(event),
    docsCitationLookup,
  );

  dispatcher.setDashboardStream(
    new CompositeDashboardStream([dashboardAdapter, docsQAAdapter]),
  );
  dispatcher.setAttachmentStore(attachmentStore);
  dispatcher.setEventBroadcaster(eventBroadcaster);
  dispatcher.setAgentExecutionTracker(agentExecutionTracker);

  // Voice transcription. See docs/design/appendices/voice-transcription.md.
  // Env vars stay live for advanced operators; `enabled` falls back to the
  // `voiceTranscriptionEnabled` runtime setting via a getter so the
  // dashboard install flow takes effect without a daemon restart.
  const voiceTranscriberMaxDuration = Number(
    process.env.PA_VOICE_TRANSCRIPTION_MAX_DURATION_SEC ?? "600",
  );
  const voiceEnvOverride = process.env.PA_VOICE_TRANSCRIPTION_ENABLED;
  const voiceTranscriberEnabled: boolean | (() => boolean) =
    voiceEnvOverride !== undefined
      ? voiceEnvOverride.toLowerCase() !== "false"
      : () => config.voiceTranscriptionEnabled;
  const voicePrimaryEnvOverride =
    process.env.PA_VOICE_TRANSCRIPTION_PRIMARY_LANGUAGE;
  const voiceTranscriberPrimaryLanguage: string | null | (() => string | null) =
    voicePrimaryEnvOverride !== undefined
      ? voicePrimaryEnvOverride.trim() || null
      : () => config.voiceTranscriptionPrimaryLanguage;
  const voiceTranscriber = new VoiceTranscriber({
    db,
    modelDir: join(config.dataDir, "models", "whisper"),
    enabled: voiceTranscriberEnabled,
    model: process.env.PA_VOICE_TRANSCRIPTION_MODEL,
    language: process.env.PA_VOICE_TRANSCRIPTION_LANGUAGE ?? null,
    primaryLanguage: voiceTranscriberPrimaryLanguage,
    maxDurationSec: Number.isFinite(voiceTranscriberMaxDuration)
      ? voiceTranscriberMaxDuration
      : 600,
  });
  dispatcher.setVoiceTranscriber(voiceTranscriber);
  // M5 (release-prep): kick off the Whisper pipeline load in the
  // background so the first inbound voice DM does not pay the
  // ~800 MB – 2.5 GB model-download cost on the request path. The
  // `void` is deliberate — daemon startup must NOT block on Hugging
  // Face Hub being reachable. `warmUp()` is internally fault-tolerant
  // (catches its own errors and logs them), so the outer `.catch` is
  // pure defence against future signature drift.
  void voiceTranscriber.warmUp().catch((err) => {
    logger.warn({ err }, "voice transcriber warm-up threw despite internal catch — investigate");
  });

  // ── Auth health monitor + recovery (post-dispatcher) ──────────────────
  // Constructed after the dispatcher so the `isMorningRoutineActive`
  // closure resolves immediately (no forward-reference let-slot needed).
  const authHealthMonitor = new AuthHealthMonitor(
    db,
    {
      claude: agentCore,
      codex: codexCore,
      gemini: geminiCore,
      opencode: opencodeCore,
    },
    authTelemetry,
    {
      notifier: makeAuthNotifier("auth-health-monitor"),
      isMorningRoutineActive: () => dispatcher.isMorningRoutineActive(),
      isQuietHours: () => notificationManager.isQuietHours(),
      probeDisabled: () => config.authProbeDisabled,
    },
  );

  // Reset any recoveries that were in-flight when the daemon was last killed.
  const recovered = authHealthMonitor.reconcilePendingRecoveries();
  if (recovered > 0) {
    logger.info(
      { count: recovered },
      "Reconciled stuck auth recoveries on startup",
    );
  }
  // Run the 60-day keepalive sweep once on startup. Hourly probe is
  // registered via `scheduler.setAuthProbeCallback` in §12.
  void authHealthMonitor.runKeepaliveSweep().catch((err) => {
    logger.warn({ err }, "Initial auth keepalive sweep failed");
  });
  const keepaliveTimer = setInterval(() => {
    void authHealthMonitor.runKeepaliveSweep().catch((err) => {
      logger.warn({ err }, "Periodic auth keepalive sweep failed");
    });
  }, 24 * 60 * 60 * 1000);
  keepaliveTimer.unref?.();

  // Interactive auth recovery manager. Uses the same notifier sink as the
  // AuthHealthMonitor so recovery DMs flow through the same notification
  // pipeline with the same anti-spam guarantees.
  const authRecovery = new AuthRecovery(
    db,
    authTelemetry,
    authHealthMonitor,
    makeAuthNotifier("auth-recovery"),
    {
      claudeRecoveryTimeoutMin: 10,
      codexRecoveryTimeoutMin: 15,
      geminiRecoveryTimeoutMin: 5,
    },
  );

  dispatcher.setAuthRecovery(authRecovery);
  dispatcher.setAuthHealthMonitor(authHealthMonitor);

  // ── Delegated sync worker (on-demand) ─────────────────────────────────
  let delegatedSyncWorker: DelegatedSyncWorker | null = null;
  const buildDelegatedSyncWorker = (): DelegatedSyncWorker => {
    if (!delegatedSyncWorker) {
      delegatedSyncWorker = new DelegatedSyncWorker({
        db,
        invoker: delegatedBackendInvoker,
        calendarId: config.googleCalendarId,
        timezone: config.timezone,
        todayWriteLock: morningRoutineLock,
        triggerRoadmapRefresh: (source) =>
          dispatcher.emitRoadmapRefresh(source),
      });
    }
    return delegatedSyncWorker;
  };
  if (hasActiveDelegatedSyncIntegration(db)) {
    observerManager.register(buildDelegatedSyncWorker());
  }

  // Wire the delegated-sync refresh callback. The thunk reads the live
  // `delegatedSyncWorker` reference each call so the dispatcher tracks
  // re-registration when an integration mode flips. When no delegated
  // integration is present, the worker is null and the call is a no-op.
  dispatcher.setDelegatedSyncRefresh(async () => {
    await delegatedSyncWorker?.runDisabledCadencesForHourlyCheck();
  });

  // ── Delegated probe observer (DELEGATED-MODE-V2 §7.1) ────────────────
  // Hourly re-probe of delegated integrations' connector tools so the
  // `integration_probes` cache reflects current sign-in state.
  {
    const { DelegatedProbeObserver } = await import(
      "../observers/delegated-probe-observer.js"
    );
    observerManager.register(
      new DelegatedProbeObserver({
        db,
        agentBackends: [agentCore, codexCore, geminiCore, opencodeCore],
        intervalMinutes: config.delegatedProbeIntervalMinutes,
      }),
    );
  }

  // ── Bang commands + skill-curation hooks ──────────────────────────────
  // Messaging bang-commands (`!stop`/`!start`/`!cost`/`!report`) — owner
  // DM chokepoint that runs ahead of every other interceptor.
  dispatcher.setBangCommandRegistry(createDefaultBangCommandRegistry());

  // Browser-task screenshots (ask_user / finish / lite-final-confirm / B-4
  // purchase confirmations) are delivered to the dashboard as real chat
  // attachments — fetched by id through the authenticated /api proxy —
  // instead of loopback trace URLs a raw <img> cannot authenticate. This
  // hook ingests a trace-store PNG/JPEG into the AttachmentStore to mint a
  // fetchable id; messaging adapters take the trace file directly via their
  // native upload API and never reach it. Best-effort: an ingest failure
  // (disallowed mime, missing file) returns null and the caller omits the
  // image. Shared by the MCP notifier + both confirm senders.
  const ingestBrowserTaskScreenshot = async (input: {
    absPath: string;
    mimeType: string;
    originalFilename: string;
  }) => {
    try {
      const result = await attachmentStore.ingestStream({
        stream: createReadStream(input.absPath),
        declaredMimeType: input.mimeType,
        originalFilename: input.originalFilename,
        direction: "outbound",
        provenance: "agent",
        maxSizeBytes: 5 * 1024 * 1024,
      });
      return {
        id: result.id,
        path: result.path,
        originalFilename: result.originalFilename,
        mimeType: result.mimeType,
        sizeBytes: result.sizeBytes,
      };
    } catch (err) {
      logger.warn({ err }, "browser-task screenshot ingest failed (omitting)");
      return null;
    }
  };

  // ── Phase B-4 purchase handler ────────────────────────────────────────
  // MANAGED_CHROMIUM_IMPLEMENTATION_PLAN.md §17.3 / §13 step 50.
  //
  // The handler holds the unforgeable capability that gates
  // `sendSystemMessage` — see `purchase-handler.ts`. The system-message
  // sender uses the existing MessageHub to dispatch DMs; we construct
  // it here once the hub is available, then thread the handler into
  // the dispatcher (for the inbound classifier hook on `!~xxxxxxxx` /
  // `!verify` / `!cancel-purchase`). The API server picks up the same
  // instance via `dispatcher.getPurchaseHandler()` at startup-api.ts.
  //
  // Wired unconditionally — every install gets a handler even when the
  // master toggle is OFF, because the inbound classifier still needs
  // to recognise + reject token-shaped replies that the user might
  // send by mistake (and to write the audit row). The handler refuses
  // issuance internally via `getB4Enabled` so cost is bounded.
  {
    const { createPurchaseHandler } = await import(
      "../services/browser-history/automation/purchase-handler.js"
    );
    const { createPurchaseSystemMessageSender } = await import(
      "../messaging/purchase-system-message-sender.js"
    );
    const sender = createPurchaseSystemMessageSender({
      messageHub,
      paDataDir: config.dataDir,
      ingestOutboundImage: ingestBrowserTaskScreenshot,
    });
    const purchaseHandler = createPurchaseHandler({
      db,
      sender,
    });
    dispatcher.setPurchaseHandler(purchaseHandler);

    // MANAGED_CHROMIUM_IMPLEMENTATION_PLAN.md §17.3 "Daemon crash during
    // the 5-min window" — on supervisor restart, sweep both flavours of
    // orphaned token. (a) Pre-consume rows whose 5-min TTL has elapsed
    // are flipped to `expired` with reason=timeout; (b) post-consume
    // rows where the click never landed (the previous daemon process
    // died after the user typed the token but before finalize) are
    // flipped to `cancelled` with reason=supervisor_orphan_sweep.
    // Without this the rows sit stranded until the daily retention
    // sweep. Best-effort: a failure logs but does not abort startup —
    // the retention sweep is the long-running safety net.
    try {
      const {
        expireStalePurchaseTokens,
        sweepOrphanedConsumedPurchaseTokens,
      } = await import(
        "../db/browser-automation-purchase-tokens-store.js"
      );
      const now = Date.now();
      const expired = expireStalePurchaseTokens(db, now);
      // 10-min grace mirrors the retention sweep — anything consumed
      // more than 10 min ago without a finalize must have been
      // orphaned by a previous daemon process (the workflow's own
      // perWorkflowTimeoutMs is 6 min).
      const orphaned = sweepOrphanedConsumedPurchaseTokens(
        db,
        now - 10 * 60 * 1000,
      );
      if (expired.length > 0 || orphaned.length > 0) {
        logger.info(
          { expired: expired.length, orphaned: orphaned.length },
          "B-4 boot-time orphan recovery: cleaned up stranded purchase tokens",
        );
      }
    } catch (err) {
      logger.warn(
        { err },
        "B-4 boot-time orphan recovery failed (retention sweep will retry)",
      );
    }

    // MANAGED_CHROMIUM_IMPLEMENTATION_PLAN.md §17.3 row 7 — SIGKILL
    // every orphan A-purchase Chromium process whose `--user-data-dir`
    // points at `chromium-automation-purchase/<siteKey>/`. The DB sweep
    // above flips the token rows to cancelled but the Chromium process
    // could survive the parent daemon's death (Chromium spawns helper
    // children; `detached: false` is a best-effort, not a hard
    // guarantee, and a `nohup` / suspended-launcher path leaves the
    // child alive with the user's authenticated cart context and an
    // open CDP debug port on localhost). The kill is OS-agnostic via
    // the HostProfile abstraction, runs unconditionally regardless of
    // whether any rows were swept (the DB and the process state can
    // diverge — e.g. a daemon crash AFTER finalize but before SIGTERM
    // would leave the process alive without a corresponding pending
    // row), and is best-effort: a missing `chromium-automation-purchase/`
    // directory, missing Chromium binary, or a `ps` shell-out failure
    // is silent.
    try {
      const { createHostProfile } = await import(
        "../services/browser-history/lifecycle/platform.js"
      );
      const { killOrphanedPurchaseChromium } = await import(
        "../services/browser-history/managed-chromium/setup-bootstrap.js"
      );
      const host = createHostProfile();
      const { killedPids } = await killOrphanedPurchaseChromium(
        host,
        config.dataDir,
      );
      if (killedPids.length > 0) {
        logger.warn(
          { killedPids },
          "B-4 boot-time recovery: killed orphan A-purchase Chromium processes",
        );
      }
    } catch (err) {
      logger.warn(
        { err },
        "B-4 boot-time orphan-Chromium kill failed (process may persist until next OS-level cleanup)",
      );
    }
  }

  // ── Browser-task lite-final-confirm handler ───────────────────────────
  // BROWSER_TASK_REDESIGN_PLAN.md §5 / §14.11 (Q#6 MVP blocker).
  //
  // Parallel to the B-4 purchase handler block above. Same anti-spoofing
  // capability pattern — the sender mints its credential from
  // `final-confirm-handler`'s module-private getter, so an agent tool
  // that imports the sender still cannot dispatch DMs. The dispatcher
  // holds the canonical instance via `setFinalConfirmHandler`; the
  // inbound `!~xxxxxxxx` classifier in `dispatcher-message-handler.ts`
  // queries both stores by raw token and routes to whichever returns a
  // row (jti-prefix dispatch in practice — both jtis are uuid v4, so
  // collision is bounded by uuid uniqueness).
  //
  // Wired unconditionally so the inbound classifier can still write
  // the strict-cancel-on-non-token-reply audit row even when no tokens
  // are currently outstanding. Phase 2 plumbs the same handler instance
  // into the browser-task driver (`DriverDeps.finalConfirmHandler`) so
  // the sub-agent's final-confirm gate issues + awaits via the canonical
  // surface — sharing a single instance is what makes the §14.11 Q#6
  // jti-prefix dispatch deterministic.
  const { createFinalConfirmHandler } = await import(
    "../services/browser-history/automation/final-confirm-handler.js"
  );
  const { createFinalConfirmSystemMessageSender } = await import(
    "../messaging/final-confirm-system-message-sender.js"
  );
  const finalConfirmSender = createFinalConfirmSystemMessageSender({
    messageHub,
    paDataDir: config.dataDir,
    ingestOutboundImage: ingestBrowserTaskScreenshot,
  });
  const finalConfirmHandler = createFinalConfirmHandler({
    db,
    sender: finalConfirmSender,
  });
  dispatcher.setFinalConfirmHandler(finalConfirmHandler);

  // ── Browser-task slot manager + runner + driver ───────────────────────
  // BROWSER_TASK_REDESIGN_PLAN.md §5 / §5.1 — wire the in-memory slot
  // state + the Phase 2 driver so `POST /api/browser-task` runs the
  // real Playwright + Claude SDK loop.
  //
  // Two notifiers, one runner:
  //  - `notifier` (structural): runner-side. Fans "queued" /
  //    non-completed-terminal intents into MessageHub DMs. Stays terse
  //    + templated.
  //  - `driver.notifier` (MCP-side): the `mcp__aitne-browser__ask_user`
  //    and `mcp__aitne-browser__finish` tool handlers DM through this
  //    notifier so agent-authored prose lands on the originating channel.
  //
  // Both round-trip via `parseChannelRef` for the §14.8 attestation —
  // unparseable refs log + skip rather than fan out to all primary
  // channels (the originating value was already attestation-validated
  // at task-creation time).
  const { createBrowserTaskRunner, createSlotStateRef } = await import(
    "../services/browser-task/browser-task-runner.js"
  );
  // BROWSER_TASK_REDESIGN_PLAN.md §9a.5 Shape B — the same emitter
  // instance threads through runner + driver + tools so a single
  // `browser_task` SSE event fans out on every state transition.
  const { createBrowserTaskTransitionEmitter: createBrowserTaskTransitionEmitterAtBoot } =
    await import(
      "../services/browser-task/browser-task-transition-events.js"
    );
  const browserTaskTransitionEmitter =
    createBrowserTaskTransitionEmitterAtBoot(eventBroadcaster);
  const { parseChannelRef: parseBrowserTaskChannelRef } = await import(
    "../db/browser-automation-purchase-primary-channels-store.js"
  );
  const { createHostProfile: createBrowserTaskHostProfile } = await import(
    "../services/browser-history/lifecycle/platform.js"
  );
  const { createBrowserTaskMcpNotifier } = await import(
    "../messaging/browser-task-mcp-notifier.js"
  );
  const browserTaskSlotStateRef = createSlotStateRef(
    config.browserTaskMaxConcurrent,
  );
  const browserTaskMcpNotifier = createBrowserTaskMcpNotifier({
    messageHub,
    paDataDir: config.dataDir,
    ingestOutboundImage: ingestBrowserTaskScreenshot,
  });
  const browserTaskHostProfile = createBrowserTaskHostProfile();
  // Hoisted out of the `createBrowserTaskRunner({ notifier: ... })` arg
  // so the same instance can also wire into the dispatcher's
  // `scheduled.browser_task` fire-time-failure path (see
  // BROWSER_TASK_REDESIGN_PLAN.md §7). One DM-emission contract covers
  // both the runner's own non-completed terminals and the pre-runner
  // dispatch failures (`site_unregistered`, `allowlist_rejected`,
  // `runner_unavailable`) that the runner never sees.
  const browserTaskTerminalNotifier: import(
    "../services/browser-task/browser-task-runner.js"
  ).BrowserTaskNotifier = {
    async notifyQueued(input): Promise<void> {
      const ref = input.originatingChannel;
      if (!ref) return;
      const parsed = parseBrowserTaskChannelRef(ref);
      if (!parsed) {
        logger.warn(
          { taskId: input.taskId, ref },
          "browser-task notifyQueued: unparseable channel ref — skipping DM",
        );
        return;
      }
      try {
        await messageHub.sendToPlatform(
          parsed.platform,
          parsed.channelId,
          `🕒 Browser task ${input.taskId} is queued behind ${input.blockedCount} task(s). Aitne will start it once the slot opens.`,
        );
      } catch (err) {
        logger.warn(
          { err, taskId: input.taskId, ref },
          "browser-task queue DM dispatch failed (continuing)",
        );
      }
    },
    async notifyTerminal(input): Promise<void> {
      // §5 "Reporting": on the success path the sub-agent's own
      // `finish({ report, screenshotKeys })` tool fans the
      // user-facing DM via the driver-side MCP notifier above. The
      // structural notifier here is the FALLBACK signal — it covers
      // every non-completed terminal (failures, timeouts,
      // cancellations, abandons) where the agent never reached
      // `finish` and the user would otherwise be left waiting.
      if (input.state === "completed") return;
      const ref = input.originatingChannel;
      if (!ref) return;
      const parsed = parseBrowserTaskChannelRef(ref);
      if (!parsed) {
        logger.warn(
          { taskId: input.taskId, ref },
          "browser-task notifyTerminal: unparseable channel ref — skipping DM",
        );
        return;
      }
      const detail = input.outcomeDetail ?? input.state;
      try {
        await messageHub.sendToPlatform(
          parsed.platform,
          parsed.channelId,
          `🟦 Browser task ${input.taskId} ended: ${input.state} (${detail}).`,
        );
      } catch (err) {
        logger.warn(
          { err, taskId: input.taskId, ref },
          "browser-task terminal DM dispatch failed (continuing)",
        );
      }
    },
  };
  const { compileUserHostnameDenylist } = await import(
    "../services/browser-history/automation/egress-denylist.js"
  );
  const browserTaskRunner = createBrowserTaskRunner({
    db,
    slotStateRef: browserTaskSlotStateRef,
    notifier: browserTaskTerminalNotifier,
    transitionEmitter: browserTaskTransitionEmitter,
    driver: {
      db,
      paDataDir: config.dataDir,
      workspaceDir: config.workspaceDir,
      hostProfile: browserTaskHostProfile,
      finalConfirmHandler,
      notifier: browserTaskMcpNotifier,
      transitionEmitter: browserTaskTransitionEmitter,
      // User-curated hostname denylist for the browser-task CDP route
      // handler + §14.7 screenshot retention check. Passed as a thunk
      // (not a precompiled array) so a Dashboard PATCH /api/config —
      // which mutates `config.browserTaskHostnameDenylist` in place via
      // `applyConfigUpdates` — takes effect on the **next** task without
      // a daemon restart. Recompilation per task is cheap (max 500
      // entries × tiny regex).
      getHostnameDenylist: () =>
        compileUserHostnameDenylist(
          config.browserTaskHostnameDenylist ?? [],
        ),
    },
    });

  // BROWSER_TASK_REDESIGN_PLAN.md §6.2 + §7 — Phase 3 wiring. The
  // dispatcher's `scheduled.browser_task` branch reaches the runner
  // through this setter. Wired right after the factory call so a
  // fire-time event that races startup still finds the runner instead
  // of falling through to `runner_unavailable`.
  dispatcher.setBrowserTaskRunner(browserTaskRunner);
  // BROWSER_TASK_REDESIGN_PLAN.md §7 — wire the same DM emitter the
  // runner uses into the dispatcher so fire-time failures
  // (`site_unregistered`, `allowlist_rejected`, `runner_unavailable`)
  // that never reach the runner still notify the owner. Without this
  // a user-scheduled task can silently fail at fire time hours/days
  // after the user issued it.
  dispatcher.setBrowserTaskTerminalNotifier(browserTaskTerminalNotifier);

  // ── Browser-task deadline scanner tick ────────────────────────────────
  // BROWSER_TASK_REDESIGN_PLAN.md §5 ask_user "Deadline enforcement" +
  // §5.1 pending-queue timeout safety valve. Single 30 s tick handles
  // both sweeps so the daemon has one mental model for time-based
  // browser-task housekeeping (cadence preserved from the retired B-3
  // approval-tokens supervisor; see browser-task-deadline-scanner.ts).
  // The tick:
  //   1. lists overdue clarifications (resolved=0 AND deadline_at < now)
  //   2. asks the slot manager to sweep pending-queue timeouts
  //   3. folds the two lists via `decideDeadlineActions`
  //   4. for each action, writes the terminal transition + releases the
  //      slot (clarifications also expire the clarification row so the
  //      `awaiting_user → abandoned` edge is recorded)
  //   5. DMs the originating channel once per affected task
  //
  // The tick is best-effort: it logs and continues on per-row failures
  // so a single bad row cannot wedge the timer. Cleared during graceful
  // shutdown alongside the keepalive timer (see
  // BootstrapEventPipelineResult.browserTaskDeadlineTimer).
  //
  // Phase 2 — both branches delegate to `browserTaskRunner.expireForDeadline`
  // so a parked Playwright handle gets `releaseDriverHandle`'d alongside
  // the terminal DB write (clarification-deadline path) and the SSE +
  // slot-manager fan-out stays consistent with the runner's own
  // terminal-write paths. The runner method is idempotent on
  // already-terminal rows, so a concurrent /cancel race is safe.
  const browserTaskDeadlineTimer = await (async () => {
    const {
      decideDeadlineActions,
      DEADLINE_SCAN_INTERVAL_MS,
    } = await import(
      "../services/browser-task/browser-task-deadline-scanner.js"
    );
    const { sweepPendingTimeouts } = await import(
      "../services/browser-task/browser-task-slots.js"
    );
    const {
      listOverdueClarifications,
      expireClarification,
    } = await import(
      "../db/browser-task-clarifications-store.js"
    );
    // `parseBrowserTaskChannelRef` is the same `parseChannelRef` hoisted
    // above for the runner notifier; reuse it so the deadline tick and
    // the runner share one channel-parse contract.

    async function tick(): Promise<void> {
      try {
        const now = Date.now();
        const overdue = listOverdueClarifications(db, now);
        const sweep = sweepPendingTimeouts(
          browserTaskSlotStateRef.state,
          now,
          config.browserTaskPendingQueueTimeoutMinutes,
        );
        // Apply the pending-queue removals to the shared slot ref so a
        // subsequent route-layer queueState read does not still see
        // expired entries.
        browserTaskSlotStateRef.state = sweep.state;

        const actions = decideDeadlineActions({
          overdueClarifications: overdue,
          expiredPending: sweep.expired,
          nowMs: now,
        });
        if (actions.length === 0) return;

        for (const action of actions) {
          try {
            if (action.kind === "abandon_clarification") {
              // Mark the clarification row expired first so the
              // dashboard's clarification list reflects the deadline
              // miss even if `expireForDeadline` hits a CAS race below.
              expireClarification(db, action.clarificationId, action.nowMs);
              // Delegate the parent-task transition to the runner so
              // the parked Playwright handle is released alongside the
              // terminal DB write — without this, every overdue
              // clarification leaks a Chromium process + workdir.
              // `expireForDeadline` is idempotent on already-terminal
              // rows, so a concurrent cancel-race is safe.
              const result = await browserTaskRunner.expireForDeadline(
                action.taskId,
                "clarification_deadline",
              );
              if (result.state === "abandoned") {
                const row = (await import("../db/browser-task-store.js"))
                  .getBrowserTask(db, action.taskId);
                await sendDeadlineDm(
                  row?.originatingChannel ?? null,
                  `⏰ Browser task ${action.taskId}: the 5-minute clarification window elapsed without a reply. Task abandoned.`,
                );
              }
            } else {
              // Queue-timeout — the pending row never acquired a slot,
              // so no Playwright handle exists to release. Still route
              // through the runner so the slot-manager / DB / SSE
              // emission stay coordinated; `expireForDeadline` flips
              // the row to `failed (queue_timeout)` and is a no-op on
              // the slot manager (the pending FIFO entry was already
              // removed by `sweepPendingTimeouts` above).
              const result = await browserTaskRunner.expireForDeadline(
                action.taskId,
                "queue_timeout",
                action.waitedMs,
              );
              const terminal = result.state === "failed"
                ? (await import("../db/browser-task-store.js"))
                    .getBrowserTask(db, action.taskId)
                : null;
              if (terminal) {
                // BROWSER_TASK_REDESIGN_PLAN.md §5.1 + §13 — the
                // pending-queue timeout transition is the one slot-
                // manager telemetry row the plan's test list pins
                // explicitly ("emits agent_actions.queue.timeout + DM
                // intent"). The DM intent is the sendDeadlineDm below;
                // this writes the paired audit row so the operator can
                // diagnose saturation episodes without dumping the
                // in-memory slot map. The remaining queue.* events
                // (enter / promote / release) power the dashboard
                // "queue health" surface flagged as §9a future work and
                // are deferred with the rest of that surface.
                try {
                  db.prepare(
                    `INSERT INTO agent_actions
                       (action_type, detail, result, started_at, completed_at)
                     VALUES (?, ?, 'success', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
                  ).run(
                    "browser_task.queue.timeout",
                    JSON.stringify({
                      taskId: action.taskId,
                      siteKey: action.siteKey,
                      waitedMs: action.waitedMs,
                    }),
                  );
                } catch (err) {
                  /* c8 ignore next 5 */
                  logger.warn(
                    { err, taskId: action.taskId },
                    "browser-task queue.timeout audit insert failed (continuing)",
                  );
                }
                await sendDeadlineDm(
                  terminal.originatingChannel,
                  `⏰ Browser task ${action.taskId}: queued for ${Math.round(action.waitedMs / 60000)} min behind a parked task and exceeded the pending-queue timeout. Task failed.`,
                );
              }
            }
          } catch (err) {
            logger.warn(
              { err, action },
              "browser-task deadline action failed (continuing)",
            );
          }
        }
      } catch (err) {
        logger.warn({ err }, "browser-task deadline tick failed (continuing)");
      }
    }

    async function sendDeadlineDm(
      ref: string | null,
      text: string,
    ): Promise<void> {
      if (!ref) return;
      const parsed = parseBrowserTaskChannelRef(ref);
      if (!parsed) {
        // Persisted via the §14.8-attested channel set, so an
        // unparseable value here means a value drifted past the
        // attestation — flag visibly even though we cannot deliver.
        logger.warn(
          { ref },
          "browser-task deadline DM: unparseable channel ref — skipping",
        );
        return;
      }
      try {
        await messageHub.sendToPlatform(parsed.platform, parsed.channelId, text);
      } catch (err) {
        logger.warn(
          { err, ref },
          "browser-task deadline DM dispatch failed (continuing)",
        );
      }
    }

    const timer = setInterval(() => {
      void tick();
    }, DEADLINE_SCAN_INTERVAL_MS);
    // Allow the daemon to exit cleanly if every other timer has unrefed;
    // a 30 s tick is housekeeping, not load-bearing for liveness.
    if (typeof timer.unref === "function") timer.unref();
    return timer;
  })();

  // ── Browser-task boot-recovery DM fan-out ─────────────────────────────
  // BROWSER_TASK_REDESIGN_PLAN.md §6.5 — `initDatabase` flipped every
  // non-terminal `browser_task` row to `failed (daemon_restarted)` and
  // wrote `agent_actions(action_type='browser_task.boot_recovery')` rows
  // (deferred DM dispatch because the messaging adapters were still
  // constructing). Now that `messageHub` exists, scan the audit log for
  // un-DM'd recovery rows and fan them out once. A per-row marker on
  // `agent_actions.metadata` ensures a second boot cannot double-DM.
  //
  // Best-effort: failures log but do not abort startup. The audit log
  // remains the source of truth — an operator can re-fan by running the
  // same SQL manually if all DMs fail.
  void (async (): Promise<void> => {
    try {
      const rows = db
        .prepare<[], { id: number; detail: string }>(
          `SELECT id, detail FROM agent_actions
            WHERE action_type = 'browser_task.boot_recovery'
              AND (metadata IS NULL
                OR json_extract(metadata, '$.dmSentAt') IS NULL)
            ORDER BY id ASC`,
        )
        .all();
      if (rows.length === 0) return;
      const markDmSent = db.prepare(
        `UPDATE agent_actions
            SET metadata = json_set(COALESCE(metadata, '{}'), '$.dmSentAt', ?)
          WHERE id = ?`,
      );
      for (const row of rows) {
        try {
          const detail = JSON.parse(row.detail) as {
            taskId?: string;
            originatingChannel?: string | null;
          };
          const taskId = detail.taskId ?? "<unknown>";
          const ref = detail.originatingChannel;
          if (ref) {
            const parsed = parseBrowserTaskChannelRef(ref);
            if (parsed) {
              await messageHub.sendToPlatform(
                parsed.platform,
                parsed.channelId,
                `♻️ Browser task ${taskId} was running when the daemon restarted and could not resume. The task is marked failed; re-issue the request if you still want it run.`,
              );
            } else {
              logger.warn(
                { taskId, ref },
                "browser-task boot-recovery DM: unparseable channel ref — skipping",
              );
            }
          }
          markDmSent.run(new Date().toISOString(), row.id);
        } catch (err) {
          logger.warn(
            { err, auditId: row.id },
            "browser-task boot-recovery DM failed (continuing; row stays unmarked for next-boot retry)",
          );
        }
      }
      logger.info(
        { count: rows.length },
        "browser-task boot-recovery: fanned DMs for restarted tasks",
      );
    } catch (err) {
      logger.warn(
        { err },
        "browser-task boot-recovery DM fan-out failed (continuing)",
      );
    }
  })();

  // P22 — wire the optimizer-workdir hooks. The `materialize` callback
  // captures db, dataDir, workspaceDir, contextDir, and secretStore so
  // the dispatcher branch can invoke it without importing the workdir
  // module directly.
  {
    const { materializeOptimizerWorkdir, teardownOptimizerWorkdir } =
      await import("../core/skill-curation/workdir.js");
    dispatcher.setSkillCurationHooks({
      materialize: (opts) =>
        materializeOptimizerWorkdir({
          db,
          dataDir: config.dataDir,
          workspaceDir: config.workspaceDir,
          contextDir: getContextDir(config),
          secretStore: secretBroker as unknown as SecretStore,
          cadence: readSkillCurationCadence(db),
          ...(opts?.manual ? { manual: true } : {}),
          ...(opts?.targetSkillsOverride
            ? { targetSkillsOverride: opts.targetSkillsOverride }
            : {}),
        }),
      teardown: teardownOptimizerWorkdir,
    });
  }

  if (isUserPaused(db)) {
    logger.info(
      "Restored user-paused state, autonomous work remains paused",
    );
  }

  // ── Cross-stage closures ──────────────────────────────────────────────
  const handleGoogleServicesReady = createGoogleServicesReadyHandler({
    db,
    config,
    services,
    observerManager,
    buildCalendarPoller,
    scheduler,
    dispatcher,
  });

  const handleSecretChange = createSecretChangeHandler({
    db,
    config,
    services,
    observerManager,
    secretState,
    buildNotionPoller,
    getGitWatcher,
    isStartupComplete,
    reloadSlackAdapter,
    reloadTelegramAdapter,
    reloadDiscordAdapter,
    reloadNotionService,
    reloadGitHubService,
    reloadGoogleServices,
    reloadAppleCalendarService,
  });

  const handlePromptContextChanged = createPromptContextChangedHandler({
    config,
    db,
    dispatcher,
    sessionManager,
  });

  return {
    dispatcher,
    sessionManager,
    messageRecorder,
    notificationManager,
    signalDetector,
    eventBroadcaster,
    auditLogger,
    docsQAAdapter,
    agentBackends: [agentCore, codexCore, geminiCore, opencodeCore],
    opencodeServerManager,
    delegatedBackendInvoker,
    authHealthMonitor,
    authRecovery,
    authTelemetry,
    readTokenManager,
    migrationLock,
    contextWriteGate,
    buildDelegatedSyncWorker,
    getDelegatedSyncWorker: () => delegatedSyncWorker,
    rematerializeActiveDmWorkdirs,
    handleSecretChange,
    handleGoogleServicesReady,
    handlePromptContextChanged,
    keepaliveTimer,
    browserTaskDeadlineTimer,
    browserTaskSlotStateRef,
    browserTaskRunner,
  };
}

// ── Cross-stage closure factories (peer-testable) ────────────────────────

export interface SecretChangeHandlerDeps {
  readonly db: Database.Database;
  readonly config: AgentConfig;
  readonly services: ServiceRegistry;
  readonly observerManager: ObserverManager;
  readonly secretState: BootstrapSecretState;
  readonly buildNotionPoller: () => NotionPoller | null;
  readonly getGitWatcher: () => GitWatcher | null;
  /**
   * Reads index.ts's `startupComplete` latch. Used by the notion hot-
   * register branch to decide whether to call `poller.start()`
   * explicitly: pre-startup the pending `observerManager.startAll()`
   * will start it; post-startup the call site owns starting it since
   * `startAll()` has already finished. Without this gate the poller's
   * `setInterval` slot leaks (the start methods overwrite `this.timer`
   * unconditionally — see `notion-poller.ts:91` and `calendar-poller.ts:63`).
   * Mirrors the `pendingGoogleServicesReady` deferral pattern in index.ts.
   */
  readonly isStartupComplete: () => boolean;
  readonly reloadSlackAdapter: (force: boolean) => Promise<void>;
  readonly reloadTelegramAdapter: (force: boolean) => Promise<void>;
  readonly reloadDiscordAdapter: (force: boolean) => Promise<void>;
  readonly reloadNotionService: () => Promise<void>;
  readonly reloadGitHubService: () => Promise<void>;
  readonly reloadGoogleServices: () => Promise<void>;
  readonly reloadAppleCalendarService: () => Promise<void>;
}

/**
 * Build the `handleSecretChange(scope)` closure consumed by the API
 * surface's `onSecretChanged` hook. Exported so the peer test can pin
 * the scope-routing matrix without booting a real dispatcher.
 *
 * The matrix MUST stay in sync with `docs/design/appendices/
 * index-bootstrap-stage-split.md` §10 (test bullet 1):
 *
 *   scope            → reload + hot-register branches
 *   "slack"          → reloadSlackAdapter(force=true)
 *   "telegram"       → reloadTelegramAdapter(force=true)
 *   "discord"        → reloadDiscordAdapter(force=true)
 *   "notion"         → reloadNotionService; then if services.notion
 *                      && !observerManager.has("notion-poller")
 *                      && notionDatabaseIds.length > 0
 *                      && shouldStartObserversFor(db, "notion")
 *                      → register + start a freshly-built poller
 *   "github"         → reloadGitHubService; then if getGitWatcher()
 *                      && secretState.githubWebhookConfigured
 *                      → enableWebhookMode on the existing watcher
 *   "google"         → reloadGoogleServices
 *   "apple_calendar" → reloadAppleCalendarService
 *   "apiToken"       → no-op (a token rotation only affects future
 *                      request authentication; nothing here is keyed on it)
 *   default          → no-op (unknown scope is silently ignored to keep
 *                      forward-compat with new secret kinds)
 */
export function createSecretChangeHandler(
  deps: SecretChangeHandlerDeps,
): (scope: string) => Promise<void> {
  const {
    db,
    config,
    services,
    observerManager,
    secretState,
    buildNotionPoller,
    getGitWatcher,
    isStartupComplete,
    reloadSlackAdapter,
    reloadTelegramAdapter,
    reloadDiscordAdapter,
    reloadNotionService,
    reloadGitHubService,
    reloadGoogleServices,
    reloadAppleCalendarService,
  } = deps;

  return async (scope: string): Promise<void> => {
    switch (scope) {
      case "slack":
        await reloadSlackAdapter(true);
        return;
      case "telegram":
        await reloadTelegramAdapter(true);
        return;
      case "discord":
        await reloadDiscordAdapter(true);
        return;
      case "notion":
        await reloadNotionService();
        // Hot-reload: if the user just added the Notion API key while the
        // integration is already in `direct` mode, register the poller now
        // so they don't have to restart the daemon. Mirrors the
        // `handleGoogleServicesReady` calendar-side path. Idempotent via
        // `observerManager.has()`.
        //
        // The explicit `poller.start()` only fires AFTER startup has
        // completed. During the bootstrap window (API listener live, but
        // `observerManager.startAll()` not yet called) we register the
        // poller and let the pending `startAll()` start it — calling
        // `start()` here AND letting `startAll()` start it again would
        // overwrite NotionPoller's `setInterval` slot and leak the first
        // timer (`notion-poller.ts:91` unconditionally writes `this.timer`).
        if (
          services.notion
          && !observerManager.has("notion-poller")
          && Object.keys(config.notionDatabaseIds).length > 0
          && shouldStartObserversFor(db, "notion")
        ) {
          const poller = buildNotionPoller();
          if (poller) {
            observerManager.register(poller);
            if (isStartupComplete()) {
              void poller.start();
              logger.info("NotionPoller started via hot-reload");
            } else {
              logger.info(
                "NotionPoller registered during bootstrap; observerManager.startAll() will start it",
              );
            }
          }
        }
        return;
      case "github":
        await reloadGitHubService();
        {
          const existingGitWatcher = getGitWatcher();
          if (existingGitWatcher && secretState.githubWebhookConfigured) {
            existingGitWatcher.enableWebhookMode();
          }
        }
        return;
      case "google":
        await reloadGoogleServices();
        return;
      case "apple_calendar":
        await reloadAppleCalendarService();
        return;
      case "apiToken":
      default:
        return;
    }
  };
}

export interface GoogleServicesReadyHandlerDeps {
  readonly db: Database.Database;
  readonly config: AgentConfig;
  readonly services: ServiceRegistry;
  readonly observerManager: ObserverManager;
  readonly buildCalendarPoller: () => CalendarPoller | null;
  // Narrowed to the only methods the handler invokes — same shape as
  // `dispatcher` below. Keeps the test seam honest: a peer test cannot
  // accidentally rely on scheduler internals the handler does not touch.
  readonly scheduler: Pick<AgentScheduler, "queueMorningRoutineWake">;
  readonly dispatcher: Pick<EventDispatcher, "emitRoadmapRefresh">;
}

/**
 * Build the `handleGoogleServicesReady` closure consumed when an OAuth
 * round-trip leaves a fresh Google credential in the keychain mid-runtime.
 * Exported so the peer test can pin the morning-routine / roadmap-refresh
 * matrix without booting a real dispatcher.
 *
 * Branches (per design doc §10 test bullets 2 + 3):
 *   - services.calendar set AND google_calendar in `direct` AND no
 *     calendar observer registered yet → build + start a poller.
 *   - today.md stale → `scheduler.queueMorningRoutineWake("google_auth_ready")`
 *     and SKIP the standalone roadmap refresh (the morning routine's
 *     post-completion hook handles roadmap).
 *   - today.md fresh AND roadmap stale → `dispatcher.emitRoadmapRefresh
 *     ("google_auth_ready")`.
 */
export function createGoogleServicesReadyHandler(
  deps: GoogleServicesReadyHandlerDeps,
): () => void {
  const {
    db,
    config,
    services,
    observerManager,
    buildCalendarPoller,
    scheduler,
    dispatcher,
  } = deps;

  return (): void => {
    if (
      services.calendar
      && !observerManager.has("calendar")
      && shouldStartObserversFor(db, "google_calendar")
    ) {
      const poller = buildCalendarPoller();
      if (poller) {
        observerManager.register(poller);
        void poller.start();
        logger.info("CalendarPoller started via hot-reload");
      }
    }

    // Trigger morning_routine catchup if today.md is stale or missing
    // (same logic as runCatchup, ensures schedule generation after first
    // auth).
    const contextDir = getContextDir(config);
    const todayMdPath = join(contextDir, "state", "today.md");
    const needsMorning = !hasFreshAgentDayTodayMd(
      todayMdPath,
      config.timezone || undefined,
      config.dayBoundaryHour,
    );

    if (needsMorning) {
      // Morning routine's post-completion hook will also check roadmap staleness.
      logger.info(
        "Google services ready — today.md stale, queueing morning_routine wake",
      );
      scheduler.queueMorningRoutineWake("google_auth_ready");
      return;
    }

    // Only refresh roadmap independently when today.md is already current.
    // If morning_routine is needed, its post-completion hook will handle
    // stale roadmap regeneration after the day context has been rebuilt.
    if (isRoadmapStale(contextDir)) {
      logger.info(
        "Google services ready — roadmap stale, emitting roadmap_refresh",
      );
      dispatcher.emitRoadmapRefresh("google_auth_ready");
    }
  };
}

export interface PromptContextChangedHandlerDeps {
  readonly config: AgentConfig;
  readonly db: Database.Database;
  readonly dispatcher: Pick<EventDispatcher, "getCurrentSetupMode">;
  readonly sessionManager: Pick<SessionManager, "markActiveDmSessionsStale">;
}

/**
 * Build the `handlePromptContextChanged` callback consumed by the
 * context-index reconciler and by the API surface's
 * `onPromptContextChanged` hook. Exported for symmetry with the other
 * cross-stage closures; the staleness decision logic itself lives in
 * `core/context-staleness.ts` (and is unit-tested there).
 */
export function createPromptContextChangedHandler(
  deps: PromptContextChangedHandlerDeps,
): PromptContextChangedCallback {
  const { config, db, dispatcher, sessionManager } = deps;

  return (path, reason, tier, metadata) => {
    const setupMode = dispatcher.getCurrentSetupMode();
    const decision = applyPromptContextStaleness(
      { path, reason, tier, metadata },
      {
        dmStalenessStrict: config.dmStalenessStrict,
        setupInProgress: setupMode !== null,
        markContextChanged: () => markContextChanged(db),
        markActiveDmSessionsStale: (staleReason) =>
          sessionManager.markActiveDmSessionsStale(staleReason),
      },
    );

    logger.debug(
      {
        path,
        reason,
        tier_decided: decision.effectiveTier,
        tier_requested: decision.requestedTier,
        tier_reason: metadata?.tierReason,
        dmStalenessStrict: config.dmStalenessStrict,
        mode: setupMode,
        invalidatesDmSessions: decision.invalidatesDmSessions,
        skippedForSetup: decision.skippedForSetup,
      },
      "Prompt context staleness classified",
    );

    if (decision.skippedForSetup) {
      logger.info(
        { path, reason, mode: setupMode },
        "Skipping DM session stale flag - setup in progress",
      );
    }
  };
}
