/**
 * Hono API server bootstrap — §11 of the legacy `startup()` IIFE.
 *
 * Extracted from `index.ts` per
 * `docs/design/appendices/index-bootstrap-stage-split.md` Phase B-3.
 * Companion to `bootstrap/db.ts`, `bootstrap/adapters.ts`, and
 * `bootstrap/services.ts`; same Pattern-C shape (file-split-plan.md §10).
 *
 * Responsibilities (in run order):
 *  1. Assemble the `ApiDependencies` record from typed inputs — translate
 *     subsystem instances (dispatcher, scheduler, messageHub, …) into the
 *     small closures the API surface consumes (`getHealthData`,
 *     `sendNotification`, `triggerHourlyCheck`, etc.).
 *  2. Construct WhatsApp / messaging-platform controls (Pattern-C; takes
 *     the adapter state holder + reload closures as deps).
 *  3. Invoke `createApp(apiDeps)` to mount every route module and the
 *     middleware stack (host-check, CORS, bearer-token gate, integration
 *     route gate).
 *  4. Mount `/api/docs/*` after createApp so the indexer handle + docs-QA
 *     adapter can be threaded in without widening `ApiDependencies`.
 *  5. Call `serve()` from `@hono/node-server` with
 *     `overrideGlobalObjects: false` — the workaround documented in
 *     `project_hono_global_response_pitfall` memory and required for
 *     `@huggingface/transformers` cache.put() to function correctly. The
 *     literal `false` is load-bearing; do not refactor away.
 *
 * Ordering invariants this module preserves (design §11):
 *  - The server starts listening before `dispatcher.run()` / `heartbeat.start()`
 *    run in `index.ts` — those calls happen at the call site immediately
 *    after this factory returns.
 *  - `onSecretChanged` (passed in from event-pipeline territory) is wired
 *    into the API surface here, but `secretBroker.onSecretChanged()`
 *    registration stays at the call site so the timing is observable.
 *
 * Note: this module is the API-assembly chokepoint, not the construction
 * site for the cross-stage closures (`handleSecretChange`,
 * `handlePromptContextChanged`, `rematerializeActiveDmWorkdirs`,
 * `handleGoogleServicesReady`, `fireRoadmapMaintenance`). Those are owned
 * by Phase B-4 (event-pipeline) per the design doc; this factory accepts
 * them as deps and threads them into `createApp`.
 */

import { serve, type ServerType } from "@hono/node-server";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type Database from "better-sqlite3";
import type { Hono } from "hono";

import type { AgentConfig } from "../config.js";
import type { SecretBroker } from "../secrets/secret-broker.js";
import type { EncryptedBlobStore } from "../secrets/encrypted-blob-store.js";
import type { ServiceRegistry } from "../services/service-registry.js";
import type { IAgentCore } from "../core/agent-core.js";
import type { AuthHealthMonitor } from "../core/backends/auth-health-monitor.js";
import type { AuthRecovery } from "../core/backends/auth-recovery.js";
import type { AuthTelemetry } from "../core/backends/auth-telemetry.js";
import type { EventBus } from "../core/event-bus.js";
import type { AgentScheduler } from "../core/scheduler.js";
import type { CustomRoutineScheduler } from "../core/custom-routine-scheduler.js";
import type { HealthMonitor } from "../core/health-monitor.js";
import type { Heartbeat } from "../core/heartbeat.js";
import type { MessageHub } from "../adapters/message-hub.js";
import type { ObserverManager } from "../observers/manager.js";
import type { PrimaryVaultWatcher } from "../observers/primary-vault-watcher.js";
import type { ContextIndexReconcilerObserver } from "../observers/context-index-reconciler-observer.js";
import type { CalendarPoller } from "../observers/calendar-poller.js";
import type { NotionPoller } from "../observers/notion-poller.js";
import type { GitWatcher } from "../observers/git-watcher.js";
import type { GitHubPoller } from "../observers/github-poller.js";
import type {
  DelegatedSyncWorker,
} from "../observers/delegated-sync-worker.js";
import type { GitDelegatedCronObserver } from "../observers/git-delegated-cron.js";
import type { DelegatedBackendInvoker } from "../services/delegated-backend-invoker.js";
import type { GitAccountRegistry } from "../services/git-account-registry.js";
import type { EventDispatcher } from "../core/dispatcher.js";
import type { SessionManager } from "../core/session-manager.js";
import type { ScopedReadSensitiveTokenManager } from "../core/read-sensitive-token-manager.js";
import type { AgentWriteTracker } from "../safety/agent-write-tracker.js";
import type { AuditLogger } from "../safety/audit.js";
import type { AttachmentStore } from "../services/attachments/store.js";
import type { DashboardAdapter } from "../adapters/dashboard-adapter.js";
import type { DocsQAAdapter } from "../adapters/docs-qa-adapter.js";
import type { DocsIndexerHandle } from "../core/docs/indexer.js";
import type { WhatsAppAdapter } from "../adapters/whatsapp-adapter.js";
import type {
  ContextWriteGate,
  MigrationLock,
  TodayWriteLockManager,
} from "../core/today-write-lock.js";
import type { RoadmapWriteLockManager } from "../core/roadmap-write-lock.js";
import type { ManagementMdWriteLockManager } from "../core/management-md-write-lock.js";
import type { RefreshDmSessionWorkdirsResult } from "../core/workdir.js";
import type { RoadmapMaintenanceResult } from "../core/roadmap-maintenance.js";
import { BrowserLifecycleSupervisor } from "../services/browser-history/lifecycle/supervisor.js";
import { BrowserHistoryPoller } from "../observers/browser-history-poller.js";
import type {
  IntegrationKey,
  IntegrationState,
} from "@aitne/shared";
import {
  applyIntegrationModeChange,
  type ObserverBuilder,
} from "../core/integration-lifecycle.js";
import {
  continueDashboardSession as continueDashboardSessionFromHistory,
  endDashboardSession as endDashboardSessionFromChannel,
} from "../core/dashboard-session-controls.js";
import { sendSetupWelcomeDm } from "../messaging/setup-welcome-dm.js";
import { recordProactiveForwardDeliveries } from "../core/channel-timeline.js";
import {
  createApp,
  type ApiDependencies,
  type IntegrationStatuses,
  type MessagingHealthStatus,
  type TelegramControls,
  type SlackControls,
  type DiscordControls,
  type WhatsAppControls,
} from "../api/server.js";
import { createDocsRoutes } from "../api/routes/docs.js";
import {
  whatsappQrResponseFromAdapter,
  type AdapterState,
} from "./adapters.js";
import { EventBroadcaster } from "../api/routes/sse.js";
import type { PromptContextChangedCallback } from "../core/context-staleness.js";
import { createLogger } from "../logging.js";

const logger = createLogger("daemon-bootstrap-api");

/**
 * Inputs to `startApiServer`. The factory consumes the constructed
 * subsystem instances + a small set of cross-stage closures owned by
 * other bootstrap phases (`bootstrap/event-pipeline.ts` once Phase B-4
 * lands; `index.ts` until then). It internally translates those into the
 * full `ApiDependencies` record shaped by `api/server.ts`.
 */
export interface BootstrapApiDeps {
  // ── Core subsystem refs ──────────────────────────────────────────────
  readonly db: Database.Database;
  readonly config: AgentConfig;
  readonly secretBroker: SecretBroker;
  readonly services: ServiceRegistry;
  readonly blobStore: EncryptedBlobStore;
  readonly agentBackends: IAgentCore[];
  readonly authHealthMonitor: AuthHealthMonitor;
  readonly authRecovery: AuthRecovery;
  readonly authTelemetry: AuthTelemetry;
  readonly eventBus: EventBus;
  readonly readTokenManager: ScopedReadSensitiveTokenManager;

  // ── Locks / gates ─────────────────────────────────────────────────────
  readonly morningRoutineLock: TodayWriteLockManager;
  readonly roadmapWriteLock: RoadmapWriteLockManager;
  readonly migrationLock: MigrationLock;
  readonly contextWriteGate: ContextWriteGate;
  /**
   * Test-only injection seam. Production never wires this — `createApp`
   * defaults to a fresh `InMemoryManagementMdWriteLockManager` per
   * process, which is correct because a single createApp call services
   * the entire daemon lifetime. Kept as an optional slot so peer tests
   * for the managed-tasks / sot-bindings routes can supply a controlled
   * lock instance without spinning up the full bootstrap factory.
   */
  readonly managementMdWriteLockManager?: ManagementMdWriteLockManager;

  // ── Dispatcher / scheduler / monitors ────────────────────────────────
  readonly dispatcher: EventDispatcher;
  readonly sessionManager: SessionManager;
  readonly scheduler: AgentScheduler;
  readonly customRoutineScheduler: CustomRoutineScheduler;
  readonly healthMonitor: HealthMonitor;
  readonly heartbeat: Heartbeat;
  readonly messageHub: MessageHub;
  readonly observerManager: ObserverManager;
  readonly contextIndexReconciler: ContextIndexReconcilerObserver;
  readonly primaryVaultWatcher: PrimaryVaultWatcher;

  // ── Integration plumbing ─────────────────────────────────────────────
  readonly delegatedBackendInvoker: DelegatedBackendInvoker;
  readonly gitAccountRegistry: GitAccountRegistry;

  // ── Browser-task surface (BROWSER_TASK_REDESIGN_PLAN §5 / §5.1) ─────
  /** Shared in-memory slot state — the runner + route layer mutate one
   *  instance so cancel-while-pending and runner-side promote see each
   *  other. Constructed in `event-pipeline.ts`. */
  readonly browserTaskSlotStateRef: import(
    "../services/browser-task/browser-task-runner.js"
  ).SlotStateRef;
  /** Per-install browser-task runner. Phase 1 runs without `driver`
   *  wired so the runner returns `failed (not_implemented)`; Phase 2
   *  passes the Playwright + Claude SDK driver into the same factory. */
  readonly browserTaskRunner: import(
    "../services/browser-task/browser-task-runner.js"
  ).BrowserTaskRunner;

  // ── Safety / chat surfaces ────────────────────────────────────────────
  readonly writeTracker: AgentWriteTracker;
  readonly auditLogger: AuditLogger;
  readonly attachmentStore: AttachmentStore;
  readonly dashboardAdapter: DashboardAdapter;
  readonly docsQAAdapter: DocsQAAdapter;
  readonly docsIndexer: DocsIndexerHandle | null;
  readonly eventBroadcaster: EventBroadcaster;

  // ── Status getters ────────────────────────────────────────────────────
  readonly getIntegrationStatus: () => IntegrationStatuses;
  readonly getMessagingStatus: () => Record<string, MessagingHealthStatus>;
  readonly isStartupComplete: () => boolean;
  readonly getDelegatedSyncWorker: () => DelegatedSyncWorker | null;

  // ── Cross-stage closures (Phase B-4 territory; passed in until then) ──
  readonly handleSecretChange: (scope: string) => Promise<void>;
  readonly handlePromptContextChanged: PromptContextChangedCallback;
  /**
   * API-facing wrapper around the inner `handleGoogleServicesReady` —
   * defers the call to the post-startup-complete flush when invoked
   * during bootstrap. Wrapping stays at the call site so `pendingGoogle
   * ServicesReady` lives next to `startupComplete`.
   */
  readonly onGoogleServicesReady: () => void;
  /** Returns null if there are no active DM sessions to refresh. */
  readonly rematerializeActiveDmWorkdirs: (reason: string) => {
    summary: RefreshDmSessionWorkdirsResult;
    mailAccounts: ReadonlyArray<unknown>;
  } | null;
  readonly fireRoadmapMaintenance: () => Promise<RoadmapMaintenanceResult>;

  // ── Observer builders (returned from `bootstrap/observers.ts`) ────────
  // All five hot-register builders are wired through because
  // `onIntegrationModeChange` below routes mode flips through them via
  // `applyIntegrationModeChange` — including the github / git-delegated
  // pair the original B-2 design draft framed as "boot-only" but the
  // actual integration-lifecycle helper consumes at runtime.
  readonly buildCalendarPoller: () => CalendarPoller | null;
  readonly buildNotionPoller: () => NotionPoller | null;
  readonly buildGitWatcher: () => GitWatcher | null;
  readonly buildGithubPoller: () => GitHubPoller;
  readonly buildDelegatedSyncWorker: () => DelegatedSyncWorker;
  readonly buildGitDelegatedCronObserver: () => GitDelegatedCronObserver;
  /** Nulls the `gitWatcher` slot when the git integration drops out of `direct`. */
  readonly clearGitWatcher: () => void;

  // ── Adapter helpers (Phase B-1 territory) ─────────────────────────────
  readonly adapterState: AdapterState;
  readonly buildWhatsAppAdapter: () => WhatsAppAdapter;
  readonly teardownWhatsAppAdapter: () => Promise<void>;
  readonly enableWhatsAppAdapter: () => Promise<void>;
  readonly buildTelegramControls: () => TelegramControls;
  readonly buildSlackControls: () => SlackControls;
  readonly buildDiscordControls: () => DiscordControls;

  // ── Misc helpers ──────────────────────────────────────────────────────
  readonly queueGitProjectInitsForCurrentConfig: (source: string) => void;

  // ── Optional test seam ────────────────────────────────────────────────
  /**
   * Test-only override for the `@hono/node-server` `serve` function. The
   * default is the real `serve`; peer tests pass a spy so they can assert
   * the load-bearing `overrideGlobalObjects: false` option without spinning
   * up a real socket listener.
   */
  readonly serveImpl?: typeof serve;
}

export interface BootstrapApiResult {
  /** The fully-composed Hono app (route mounts + middleware stack). */
  readonly app: Hono;
  /**
   * Node HTTP server returned by `@hono/node-server.serve`. The shutdown
   * handler closes it via `server.close()`.
   */
  readonly server: ServerType;
  /**
   * The same `EventBroadcaster` instance threaded into `ApiDependencies`.
   * Re-exposed for ergonomic chaining at the call site (e.g. SSE clients
   * registered post-startup) and for peer tests.
   */
  readonly eventBroadcaster: EventBroadcaster;
}

/**
 * Compose the Hono app, mount post-createApp routes, and start the HTTP
 * listener. The returned `server` is already listening on
 * `deps.config.apiPort`; the caller is responsible for kicking off any
 * dispatcher / heartbeat work that depends on the listener being live.
 */
export function startApiServer(deps: BootstrapApiDeps): BootstrapApiResult {
  const apiDeps = composeApiDependencies(deps);

  const app = createApp(apiDeps);

  // Mount /api/docs/* AFTER createApp so the indexer handle + docs-QA
  // adapter can be threaded in without widening `ApiDependencies`. The
  // read endpoints don't need messaging/dispatcher deps; the QA POST/SSE
  // pair leans on `docsQAAdapter` to register clients and enqueue
  // docs_qa events (DOCS_QA_DESIGN.md §10.4 + DOCS_QA_B7_DESIGN.md §S5–S6).
  app.route(
    "/api",
    createDocsRoutes({
      db: deps.db,
      ...(deps.docsIndexer ? { indexer: deps.docsIndexer } : {}),
      docsQAAdapter: deps.docsQAAdapter,
    }),
  );

  const serveFn = deps.serveImpl ?? serve;
  const server = serveFn({
    fetch: app.fetch,
    hostname: "127.0.0.1",
    port: deps.config.apiPort,
    // @hono/node-server's getRequestListener defaults to replacing
    // `globalThis.Request` / `globalThis.Response` with its own lazy
    // wrapper classes (named `_Request` / `_Response`) for response-
    // body materialization performance. The wrappers are prototype-
    // chained to the native classes — fine for Hono's own response
    // path — but they break `instanceof Response` checks for objects
    // returned by native `fetch()`, because a native Response's
    // prototype chain doesn't include `_Response.prototype`. This
    // makes `@huggingface/transformers`'s `toCacheResponse` check
    // (`response instanceof Response && response.status === 200`)
    // evaluate to false on fresh fetches, which silently skips
    // `cache.put` and then throws "Unable to get model file path or
    // buffer." Disabling the override keeps the native globals
    // intact and costs us nothing — we don't construct Hono's
    // `Response` instances directly anywhere in the daemon.
    overrideGlobalObjects: false,
  });

  // @hono/node-server's serve() calls http.Server.listen() without attaching
  // an 'error' listener, so a failed bind (most commonly EADDRINUSE from a
  // stale daemon or PID reuse) escalates into an uncaughtException that
  // surfaces as an opaque "process will exit" crash. Attach a listener so the
  // port-conflict case produces an actionable message. ServerType extends
  // net.Server/EventEmitter on every platform and libuv reports EADDRINUSE
  // identically on macOS/Linux/Windows, so no platform branch is warranted.
  server.on("error", (err) => {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "EADDRINUSE") {
      logger.fatal(
        { port: deps.config.apiPort },
        `API port ${deps.config.apiPort} already in use — another daemon may be running; run 'aitne stop' first, or set PA_API_PORT to a free port`,
      );
    } else {
      logger.fatal({ err }, "API server error — process will exit");
    }
    process.exit(1);
  });

  logger.info({ port: deps.config.apiPort }, "API server listening");

  return { app, server, eventBroadcaster: deps.eventBroadcaster };
}

// ── Internals ────────────────────────────────────────────────────────────

/**
 * Translate the high-level `BootstrapApiDeps` record into the
 * closure-laden `ApiDependencies` shape `createApp` consumes. Pure
 * function (no side effects, no construction); every call returns a
 * fresh deps record that captures the input refs. Extracted from the
 * giant inline object literal that lived inside `startup()` so the
 * call site reads as one factory call.
 */
function composeApiDependencies(deps: BootstrapApiDeps): ApiDependencies {
  const {
    db,
    config,
    secretBroker,
    services,
    blobStore,
    agentBackends,
    authHealthMonitor,
    authRecovery,
    authTelemetry,
    eventBus,
    readTokenManager,
    morningRoutineLock,
    roadmapWriteLock,
    migrationLock,
    contextWriteGate,
    managementMdWriteLockManager,
    dispatcher,
    scheduler,
    customRoutineScheduler,
    healthMonitor,
    heartbeat,
    messageHub,
    observerManager,
    contextIndexReconciler,
    primaryVaultWatcher,
    delegatedBackendInvoker,
    gitAccountRegistry,
    writeTracker,
    auditLogger,
    attachmentStore,
    dashboardAdapter,
    eventBroadcaster,
    getIntegrationStatus,
    getMessagingStatus,
    isStartupComplete,
    getDelegatedSyncWorker,
    handleSecretChange,
    handlePromptContextChanged,
    onGoogleServicesReady,
    rematerializeActiveDmWorkdirs,
    fireRoadmapMaintenance,
    buildCalendarPoller,
    buildNotionPoller,
    buildGitWatcher,
    buildGithubPoller,
    buildDelegatedSyncWorker,
    buildGitDelegatedCronObserver,
    clearGitWatcher,
    queueGitProjectInitsForCurrentConfig,
  } = deps;

  const whatsappControls = buildWhatsAppControls(deps);
  const messagingControls = {
    telegram: deps.buildTelegramControls(),
    slack: deps.buildSlackControls(),
    discord: deps.buildDiscordControls(),
  };

  const sendNotification: NonNullable<ApiDependencies["sendNotification"]> =
    async ({ message, platforms, priority, notificationType, originSessionId }) => {
      const dispatchId = randomBytes(16).toString("hex");
      const deliveries = await messageHub.sendToUser(message, platforms, {
        dispatchId,
        notificationType: notificationType ?? "agent",
        priority: priority ?? "normal",
        contentSummary: message.slice(0, 200),
      });
      if (deliveries.length > 0) {
        const insert = db.prepare(
          `INSERT INTO notification_log (
             dispatch_id,
             notification_type,
             priority,
             platform,
             delivery_channel,
             delivery_message_id,
             content_summary,
             status,
             delivered_at
           )
           VALUES (?, ?, ?, ?, ?, ?, ?, 'delivered', CURRENT_TIMESTAMP)`,
        );
        for (const delivery of deliveries) {
          insert.run(
            dispatchId,
            notificationType ?? "agent",
            priority ?? "normal",
            delivery.platform,
            delivery.channel,
            delivery.messageId ?? null,
            message.slice(0, 200),
          );
        }
        recordProactiveForwardDeliveries({
          db,
          config,
          deliveries,
          content: message,
          dispatchId,
          dispatchIds: [dispatchId],
          originSessionIds:
            originSessionId !== undefined ? [originSessionId] : [],
          notificationType: "proactive_forward",
        });
      }
      return { dispatchId, deliveries };
    };

  const onIntegrationModeChange = async (
    key: IntegrationKey,
    prev: IntegrationState,
    next: IntegrationState,
  ): Promise<void> => {
    const buildObserver: ObserverBuilder = (observerName) => {
      // Registry-gated direct observers. Mail's multi-provider poller is a
      // deferred follow-up — gmail.observersTouched is empty, so that
      // branch remains unreachable today.
      if (observerName === "calendar") return buildCalendarPoller();
      if (observerName === "notion-poller") return buildNotionPoller();
      if (observerName === "git") return buildGitWatcher();
      if (observerName === "github") return buildGithubPoller();
      if (observerName === "browser-lifecycle-supervisor") {
        return new BrowserLifecycleSupervisor(db, config);
      }
      if (observerName === "browser-history-poller") {
        return new BrowserHistoryPoller(db, config, {
          // BROWSER_HISTORY_INTEGRATION_PLAN §5.F1 (seventh-pass) —
          // poller enqueues `routine.research_offer_dm` events; the
          // agent session composes + sends the natural-language DM.
          enqueueEvent: async (event) => {
            await eventBus.put(event);
          },
        });
      }
      return null;
    };
    await applyIntegrationModeChange(
      {
        db,
        observerManager,
        buildObserver,
        buildDelegatedSyncWorker,
        buildGitDelegatedCronObserver,
        // DELEGATED-PROXY-API-DESIGN.md Phase F (§4.8) — every mode
        // change re-materializes active DM workdirs so the next turn
        // picks up the new skill body / accounts.md / instruction file
        // without tearing down the SDK session.
        rematerializeDmSessions: (reason: string) => {
          const result = rematerializeActiveDmWorkdirs(reason);
          if (!result) return;
          logger.info(
            { reason, ...result.summary },
            "Integration mode changed — DM session workdirs re-materialized",
          );
        },
      },
      key,
      prev,
      next,
    );
    if (key === "git" && next.mode !== "direct") {
      clearGitWatcher();
    }
  };

  const onMainBackendChange = (reason: string): void => {
    // DELEGATED-MODE-V2-DESIGN.md §4.4 — every main-backend flip
    // re-materializes active DM workdirs so the next turn's skill
    // variant and instruction file reflect the new same- vs.
    // cross-backend topology. Mirrors the `onMailScopeChanged`
    // pattern: helper handles the "no active sessions" no-op + per-
    // session failure containment, and we broadcast a structured
    // event so the dashboard can refresh without polling.
    const result = rematerializeActiveDmWorkdirs(reason);
    if (!result) return;
    logger.info(
      { reason, ...result.summary },
      "Main backend changed — DM session workdirs re-materialized",
    );
    eventBroadcaster.broadcastEvent({
      kind: "main_backend_changed",
      reason,
      ...result.summary,
    });
  };

  const onSetupComplete = (): void => {
    // Kick off an immediate morning routine so today.md is generated
    // right away — otherwise the user completes setup mid-day and sits
    // without a populated today.md until 04:00 next morning. We go
    // through the scheduler's queueMorningRoutineWake so:
    //   - the dedup check prevents a double-run if startup catchup was
    //     about to kick off the same routine (race on first boot after
    //     setup completes)
    //   - the wake task is durable: if the daemon crashes before the
    //     routine runs, it replays on restart via ScheduleWatcher
    //   - ScheduleWatcher obeys the autonomous-work gate, so in the
    //     unlikely case clearSetupMode fails to persist, the gate
    //     still prevents the routine from running mid-setup.
    // Don't emit roadmap_refresh here — skeleton has "(Not yet configured)"
    // which isRoadmapStale() detects. The refresh will be triggered by:
    // - morning_routine's post-completion hook, or
    // - onGoogleServicesReady (once calendar auth completes)
    // This avoids generating a roadmap before calendar data is available.
    dispatcher.clearSetupMode();
    try {
      scheduler.queueMorningRoutineWake("setup_complete");
    } catch (err) {
      logger.error(
        { err },
        "Failed to queue post-setup morning routine — today.md will not be generated until next 04:00",
      );
    }
    // Fire-and-forget: greet the user on every connected messaging
    // platform exactly once. The runtime_state latch inside the helper
    // makes this idempotent across repeated setup completions.
    void sendSetupWelcomeDm({ db, messageHub }).catch((err) => {
      logger.error({ err }, "Welcome DM dispatch crashed");
    });
  };

  return {
    db,
    config,
    secretBroker,
    readTokenValidator: (token: string) => readTokenManager.isValid(token),
    enforceReadToken: config.enforceReadToken,
    agentBackends,
    authHealthMonitor,
    authRecovery,
    authTelemetry,
    eventBus,
    morningRoutineLock,
    roadmapWriteLock,
    migrationLock,
    contextWriteGate,
    ...(managementMdWriteLockManager
      ? { managementMdWriteLockManager }
      : {}),
    observerManager,
    delegatedInvoker: delegatedBackendInvoker,
    gitAccountRegistry,
    onPrimaryVaultPathChange: (newPath) =>
      primaryVaultWatcher.setVaultPath(newPath),
    onGitReposChanged: () =>
      queueGitProjectInitsForCurrentConfig("config-patch"),
    getInFlightExecutions: () => dispatcher.getInFlightExecutions(),
    getHealthData: () => {
      const status = healthMonitor.getStatus();
      return {
        uptime: status.daemonUptime,
        eventBusSize: status.eventBusSize,
        activeSessions: status.activeSessions,
        connectedPlatforms: status.connectedPlatforms,
        registeredObservers: status.registeredObservers,
        missingContextFiles: status.missingContextFiles,
        contextFilesOk: status.contextFilesOk,
      };
    },
    getLastTickAt: () => heartbeat.getLastTickAt(),
    services,
    isStartupComplete,
    getIntegrationStatus,
    getMessagingStatus,
    // Bang-commands `/api/health` surface — messaging-bang-commands.md §6.1.
    // Returns `"ok"` for the unblocked case so dashboards never have to
    // null-check, while preserving the original gate enum for the blocked
    // states.
    getAutonomousState: () => dispatcher.isAutonomousAllowed() ?? "ok",
    getNotificationDestinations: () => ({
      defaultPlatforms: config.defaultNotificationPlatforms,
      effectiveFallbackPlatforms: messageHub.getEffectiveFallbackPlatforms(),
    }),
    getIntegrationDriftSyncStatus: () =>
      getDelegatedSyncWorker()?.getStatus() ?? {
        workerRunning: false,
        lastSuccessAt: null,
        circuitState: "ok",
        activeHours: { startHour: 4, endHour: 24 },
        withinActiveHours: false,
        cadences: {},
        unrecognizedIntervalKeys: [],
        ttlContractViolations: [],
      },
    // delegated-sync opt-in routes consume the live worker reference for
    // cadence Run Now + status snapshot. When no integration is in
    // delegated mode the worker is null and the routes report a
    // worker_unavailable / empty-status response — see
    // `docs/design/appendices/delegated-sync-opt-in.md`.
    get delegatedSyncWorker() {
      return getDelegatedSyncWorker() ?? undefined;
    },
    sendNotification,
    markEventNotified: (correlationId: string) => {
      dispatcher.markEventNotified(correlationId);
    },
    onGoogleServicesReady,
    onScheduleConfigChanged: () => scheduler.reloadCrons(),
    // Phase B-4 — the dispatcher holds the canonical PurchaseHandler
    // instance (constructed in `event-pipeline.ts` once the message
    // hub is available). We thread it through the API deps via a
    // getter so the route layer's `deps.purchaseHandler` reads the
    // live reference instead of a snapshot — important for the
    // future "Disable B-4" dashboard flow that swaps the handler out.
    get purchaseHandler() {
      return dispatcher.getPurchaseHandler() ?? undefined;
    },
    // BROWSER_TASK_REDESIGN_PLAN.md §5 / §14.11 — lite-final-confirm
    // handler. Constructed in `event-pipeline.ts` (parallel to the B-4
    // block) once the message hub is up; surfaced here via the
    // dispatcher getter so the route layer + the inbound message
    // classifier always see the same live instance.
    get finalConfirmHandler() {
      return dispatcher.getFinalConfirmHandler() ?? undefined;
    },
    // BROWSER_TASK_REDESIGN_PLAN.md §5 / §5.1 — browser-task runner +
    // shared slot state. Both originate from `event-pipeline.ts` so
    // every consumer (route handler, runner, deadline tick) operates
    // on a single in-memory state. The route layer's
    // `deps.browserTaskRunner` and `deps.browserTaskSlotStateRef`
    // resolve through this object — never re-instantiated in
    // `createApp` so cancel-while-pending and runner-side promote
    // race on the same value.
    browserTaskRunner: deps.browserTaskRunner,
    browserTaskSlotStateRef: deps.browserTaskSlotStateRef,
    onIntegrationModeChange,
    onMainBackendChange,
    onSetupStart: (mode) => {
      dispatcher.beginSetupMode(mode);
    },
    onSecretChanged: handleSecretChange,
    onSetupComplete,
    // Layer-3 defense for the Customize Your Rules bug (see
    // context-staleness.ts and the inline comment that lived next to
    // this callback before the B-3 split).
    onPromptContextChanged: handlePromptContextChanged,
    onIndexableContextChange: (_path: string) => {
      // API-route hint: any successful PUT/PATCH/DELETE under `/context/*`
      // queues a reconcile. The observer's own chokidar watcher already
      // catches manual edits the API bypasses (e.g. the user editing via
      // Obsidian when contextDir *is* the Obsidian vault) — this hint
      // shortens reconcile latency for API-origin writes from chokidar
      // debounce + stabilityThreshold to the observer's 10s debounce. The
      // reconciler short-circuits when nothing changed, so firing for
      // non-indexed paths is harmless.
      contextIndexReconciler.requestReconcile("manual");
    },
    onCustomRoutinesChanged: () => {
      try {
        customRoutineScheduler.reload();
      } catch (err) {
        logger.error({ err }, "Custom routine reload failed");
      }
    },
    triggerHourlyCheck: (source, options) =>
      dispatcher.triggerHourlyCheck(source, options),
    triggerRoadmapRefresh: (source, options) =>
      dispatcher.emitRoadmapRefresh(source, options),
    triggerRoadmapMaintenance: () => fireRoadmapMaintenance(),
    endDashboardSession: (channelId) =>
      endDashboardSessionFromChannel({
        sessionManager: deps.sessionManager,
        channelId,
      }),
    continueDashboardSession: async (sessionId) =>
      continueDashboardSessionFromHistory({
        db,
        dataDir: config.dataDir,
        sessionManager: deps.sessionManager,
        sessionId,
      }),
    writeTracker,
    blobStore,
    dashboardAdapter,
    eventBroadcaster,
    attachmentStore,
    auditLogger,
    validateAttachmentTurnToken: (token: string) =>
      dispatcher.validateAttachmentTurnToken(token),
    whatsappControls,
    messagingControls,
  };
}

/**
 * Build the WhatsApp dashboard control surface. Captures the shared
 * `adapterState` holder + adapter build/teardown closures + config refs
 * so the dashboard's pairing / reset flows can drive the adapter
 * without each route knowing the internals. Logic preserved bit-for-bit
 * from the pre-B-3 inline block in `index.ts`.
 */
function buildWhatsAppControls(deps: BootstrapApiDeps): WhatsAppControls {
  const {
    adapterState,
    buildWhatsAppAdapter,
    teardownWhatsAppAdapter,
    enableWhatsAppAdapter,
    config,
    db,
  } = deps;

  return {
    isInitialized: () => adapterState.whatsapp !== null,
    enable: async () => {
      const adapter = buildWhatsAppAdapter();
      if (adapter.getStatus() === "disabled") {
        await adapter.start();
      }
    },
    disable: async () => {
      await teardownWhatsAppAdapter();
    },
    requestQr: async () => {
      if (!adapterState.whatsapp) {
        await enableWhatsAppAdapter();
      }
      await adapterState.whatsapp!.requestQR();
    },
    waitForQr: async (timeoutMs = 10_000) => {
      if (!adapterState.whatsapp) {
        await enableWhatsAppAdapter();
      }
      const snapshot = await adapterState.whatsapp!.waitForQr(timeoutMs);
      return whatsappQrResponseFromAdapter(adapterState.whatsapp, snapshot);
    },
    getQrResponse: () => whatsappQrResponseFromAdapter(adapterState.whatsapp),
    reset: async (timeoutMs = 10_000) => {
      // 1. Stop + unregister any live adapter so no Baileys callbacks fire
      //    against the auth dir while we delete it.
      await teardownWhatsAppAdapter();

      // 2. Wipe Baileys' multi-file auth state. Without this, a fresh
      //    enable() would re-load the stale creds and never emit a QR —
      //    which is exactly the "stale creds left over from a previous
      //    pairing make re-pairing impossible" failure mode the
      //    dashboard's "Reset connection" button exists
      //    to recover from. Recursive + force so a partially-written dir
      //    (e.g. only qr.txt present, no creds.json yet) still wipes
      //    cleanly. `force: true` also no-ops if the dir is already gone.
      const authDir =
        config.whatsappAuthDir ?? join(config.dataDir, "whatsapp", "auth");
      try {
        rmSync(authDir, { recursive: true, force: true });
      } catch (err) {
        logger.warn(
          { err, authDir },
          "Failed to wipe WhatsApp auth directory during reset",
        );
      }

      // 3. Drop the cached owner_channels mapping so a freshly-paired
      //    session re-discovers the channel id from the inbound auth
      //    handshake rather than reusing the prior LID alias.
      try {
        db
          .prepare("DELETE FROM owner_channels WHERE platform = ?")
          .run("whatsapp");
      } catch (err) {
        logger.warn(
          { err },
          "Failed to clear WhatsApp owner_channels row during reset",
        );
      }

      // 4. If the integration is still enabled, rebuild the adapter and
      //    await the first scannable QR so the dashboard can render it
      //    in the same request that triggered the reset.
      if (!config.whatsappEnabled) {
        return whatsappQrResponseFromAdapter(null);
      }
      await enableWhatsAppAdapter();
      const snapshot = await adapterState.whatsapp!.waitForQr(timeoutMs);
      return whatsappQrResponseFromAdapter(adapterState.whatsapp, snapshot);
    },
  };
}
