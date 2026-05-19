import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger as honoLogger } from "hono/logger";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import {
  readRuntimeState,
  writeRuntimeState,
} from "../db/runtime-state.js";

/** Persistence key for the boot-audit fingerprint (`auditRiskClassifications`). */
const RISK_AUDIT_STATE_KEY = "risk_audit_unclassified_fingerprint";
import type Database from "better-sqlite3";
import type { AgentConfig } from "../config.js";
import { getContextDir } from "../config.js";
import {
  auditRiskClassifications,
  classifyRisk,
  findExplicitRiskClassification,
  RiskTier,
} from "../safety/risk-classifier.js";
import { createHealthRoutes } from "./routes/health.js";
import { createContextRoutes } from "./routes/context/index.js";
import { createAgentRoutes } from "./routes/agent.js";
import { createDashboardRoutes } from "./routes/dashboard/index.js";
import { createNotionRoutes } from "./routes/notion.js";
import { createGitHubRoutes } from "./routes/github.js";
import { createCalendarRoutes } from "./routes/calendar.js";
import { createAppleCalendarRoutes } from "./routes/apple-calendar.js";
import { createMetricsRoutes } from "./routes/metrics.js";
import { createObsidianRoutes } from "./routes/obsidian.js";
import { createGitRoutes } from "./routes/git.js";
import { createGitTemplatesRoutes } from "./routes/git-templates.js";
import { createRepositoriesRoutes } from "./routes/repositories.js";
import { createMailRoutes } from "./routes/mail/index.js";
import { createSSERoutes, EventBroadcaster } from "./routes/sse.js";
import { createSetupRoutes } from "./routes/setup.js";
import { createSetupMigrateRoutes } from "./routes/setup-migrate.js";
import { createSettingsStore } from "../settings/settings-store.js";
import { createSystemRoutes } from "./routes/system.js";
import { createBackendRoutes } from "./routes/backends.js";
import { createSkillsRoutes } from "./routes/skills.js";
import { createObservationRoutes } from "./routes/observations.js";
import { createSkillCurationRoutes } from "./routes/skill-curation.js";
import { createProfileQuestionsRoutes } from "./routes/profile-questions.js";
import { createRecurringScheduleRoutes } from "./routes/recurring-schedules.js";
import { createScheduleOptionsRoutes } from "./routes/schedule-options.js";
import { createTriggerRoutes } from "./routes/triggers.js";
import { createTravelBookingRoutes } from "./routes/travel-bookings.js";
import { createReceiptRoutes } from "./routes/receipts.js";
import { createTravelTimeRoutes } from "./routes/travel-time.js";
import { createBookRoutes } from "./routes/books.js";
import { createDelegatedRunRoutes } from "./routes/delegated.js";
import { createDelegatedSyncRoutes } from "./routes/delegated-sync.js";
import { createIntegrationRoutes } from "./routes/integrations/index.js";
import { createIntegrationReconcileRoutes } from "./routes/integrations-reconcile.js";
import { createKnowledgeRoutes } from "./routes/knowledge.js";
import { createTaskFlowsRoutes } from "./routes/task-flows.js";
import { createGitAccountsRoutes } from "./routes/git-accounts.js";
import { createCommandsRoutes } from "./routes/commands.js";
import { createVoiceRoutes } from "./routes/voice.js";
import { createWikiRoutes } from "./routes/wiki.js";
import { createFsRoutes } from "./routes/fs.js";
import {
  buildManagedTasksRoutesDepsFromApi,
  createManagedTasksRoutes,
} from "./routes/managed-tasks.js";
import {
  buildSotBindingsRoutesDepsFromApi,
  createSotBindingsRoutes,
} from "./routes/sot-bindings.js";
import {
  buildEntitiesRoutesDepsFromApi,
  createEntitiesRoutes,
} from "./routes/entities.js";
import { createActivitySourcesRoutes } from "./routes/activity-sources.js";
import { createIntegrationRouteGate } from "./integration-route-gate.js";
import { createMcpRoutes } from "./routes/mcp.js";
import { createAttachmentRoutes } from "./routes/attachments.js";
import type { AttachmentStore } from "../services/attachments/store.js";
import type { EventBus } from "../core/event-bus.js";
import type {
  InFlightExecutionInfo,
  TriggerHourlyCheckOptions,
  TriggerHourlyCheckResult,
} from "../core/dispatcher.js";
import type { PromptContextChangedCallback } from "../core/context-staleness.js";
import type { IAgentCore } from "../core/agent-core.js";
import type { AuthHealthMonitor } from "../core/backends/auth-health-monitor.js";
import type { AuthTelemetry } from "../core/backends/auth-telemetry.js";
import type { ServiceRegistry } from "../services/service-registry.js";
import type { DashboardAdapter } from "../adapters/dashboard-adapter.js";
import type { AgentWriteTracker } from "../safety/agent-write-tracker.js";
import type { ContextWriteGate, MigrationLock, TodayWriteLockManager } from "../core/today-write-lock.js";
import type { RoadmapWriteLockManager } from "../core/roadmap-write-lock.js";
import type { RoadmapMaintenanceResult } from "../core/roadmap-maintenance.js";
import {
  InMemoryManagementMdWriteLockManager,
  type ManagementMdWriteLockManager,
} from "../core/management-md-write-lock.js";
import type { ObserverManager } from "../observers/manager.js";
import type { SecretBroker } from "../secrets/secret-broker.js";
import type { DelegatedBackendInvoker } from "../services/delegated-backend-invoker.js";
import type { DelegatedSyncStatus } from "../observers/delegated-sync-worker.js";
import { isRuntimeAvailableBackendId } from "@aitne/shared";
import type { IntegrationKey, IntegrationState } from "@aitne/shared";
import { queryChatBinding } from "./chat-binding-query.js";
import {
  DEFAULT_CLAUDE_HIGH_MODEL,
  getModelsForBackend,
} from "../core/backends/model-registry.js";
import { createLogger } from "../logging.js";

const logger = createLogger("api-server");
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export interface IntegrationStatus {
  configured: boolean;
  connected: boolean;
  error: string | null;
}

interface GoogleIntegrationStatus extends IntegrationStatus {
  /** Per-service statuses within the shared Google OAuth */
  services: {
    calendar: { connected: boolean; error: string | null };
    gmail: { connected: boolean; error: string | null };
  };
}

interface WhatsAppIntegrationStatus extends IntegrationStatus {
  state:
    | "ok"
    | "connecting"
    | "awaiting_qr"
    | "disconnected"
    | "logged_out"
    | "disabled"
    | "not_configured";
}

export interface IntegrationStatuses {
  google: GoogleIntegrationStatus;
  appleCalendar: IntegrationStatus;
  obsidian: IntegrationStatus;
  notion: IntegrationStatus;
  whatsapp: WhatsAppIntegrationStatus;
  googleMaps: IntegrationStatus;
}

export interface MessagingHealthStatus {
  configured: boolean;
  runtimeState: "ok" | "error" | "not_configured" | "connecting";
  ownerConfigured: boolean;
  ownerChannelKnown: boolean;
  notificationEligible: boolean;
  lastInboundAt: string | null;
  error: string | null;
}

export interface ApiDependencies {
  db: Database.Database;
  config: AgentConfig;
  secretBroker: SecretBroker;
  /** Legacy shared token for ReadSensitive tier. Prefer readTokenValidator. */
  readToken?: string;
  /** Optional scoped-token validator for ReadSensitive tier. */
  readTokenValidator?: (token: string) => boolean;
  /**
   * When true, ReadSensitive endpoints reject unauthenticated requests with 401.
   * When false (default), unauthenticated requests are logged as warnings but allowed.
   */
  enforceReadToken?: boolean;
  services: ServiceRegistry;
  /**
   * Shared encrypted blob store. Per-account mail secrets live under
   * `mail:<kind>:<id>`; per-MCP-server secrets under `mcp:<id>:<keyName>`.
   * The same master key envelopes both so there is one place to rotate.
   */
  blobStore?: import("../secrets/encrypted-blob-store.js").EncryptedBlobStore;
  agentBackends?: IAgentCore[];
  /** Used by the backends route to persist `checkAuthDetailed()` results. */
  authHealthMonitor?: AuthHealthMonitor;
  /** Phase 5/6: interactive auth recovery manager. */
  authRecovery?: import("../core/backends/auth-recovery.js").AuthRecovery;
  /** Phase 8: auth telemetry for /metrics/auth dashboard endpoint. */
  authTelemetry?: AuthTelemetry;
  isStartupComplete?: () => boolean;
  eventBus?: EventBus;
  getHealthData: () => {
    uptime: number;
    eventBusSize: number;
    activeSessions: number;
    connectedPlatforms: string[];
    registeredObservers: string[];
    missingContextFiles: string[];
    contextFilesOk: boolean;
  };
  /**
   * Notifications Center heartbeat (see docs/design/20-notifications-center.md).
   * Returns the epoch ms of the last heartbeat tick. The dashboard treats
   * `Date.now() - lastTickAt > FROZEN_THRESHOLD` as the daemon being frozen
   * (event-loop blocked) and surfaces a system-level alert.
   */
  getLastTickAt?: () => number;
  /**
   * Messaging bang-commands (`!stop`/`!start`) — full autonomous-gate enum
   * surfaced on `/api/health` so the dashboard banner can distinguish a
   * user-initiated pause from setup-incomplete / vault-degraded. Wired in
   * `index.ts` to `() => dispatcher.isAutonomousAllowed() ?? "ok"`.
   */
  getAutonomousState?: () =>
    | "ok"
    | "user_paused"
    | "setup_in_progress"
    | "setup_incomplete"
    | "vault_degraded";
  getIntegrationStatus: () => IntegrationStatuses;
  getMessagingStatus?: () => Record<string, MessagingHealthStatus>;
  getNotificationDestinations?: () => {
    defaultPlatforms: string[];
    effectiveFallbackPlatforms: string[];
  };
  /** Phase 3 integration drift sync status for /api/health. */
  getIntegrationDriftSyncStatus?: () => DelegatedSyncStatus;
  /**
   * Reference to the live `DelegatedSyncWorker` (when registered). Optional
   * because the worker is only built when at least one integration is in
   * delegated mode. Consumed by the `/api/delegated-sync/*` routes —
   * `docs/design/appendices/delegated-sync-opt-in.md` — for status,
   * cadence patches, and Run Now invocation.
   */
  delegatedSyncWorker?: import("../observers/delegated-sync-worker.js").DelegatedSyncWorker;
  sendNotification?: (params: {
    message: string;
    platforms?: string[];
    priority?: string;
    notificationType?: string;
    originSessionId?: number;
  }) => Promise<{ dispatchId: string; deliveries: { platform: string; channel: string; messageId?: string }[] }>;
  /**
   * Notify-dedup hook — called by the `/api/notify` route when the request
   * carries an `X-Pa-Event-Correlation-Id` header (auto-injected by
   * the per-session shim env). The dispatcher consumes the marker in
   * `processResult` to suppress the implicit final-text DM forward, so a
   * single agent run that explicitly notifies the user never doubles up
   * with a closing-turn duplicate.
   */
  markEventNotified?: (correlationId: string) => void;
  /** Called after OAuth hot-reload initializes new Google services */
  onGoogleServicesReady?: () => void;
  /** Called when schedule-related config changes (e.g. dayBoundaryHour) to hot-reload crons */
  onScheduleConfigChanged?: () => void;
  /** Called after git repository config changes so project-doc init rows can be queued. */
  onGitReposChanged?: () => void | Promise<void>;
  /** Called when /setup/start arrives so the dispatcher can pause autonomous work. */
  onSetupStart?: (mode: "initial" | "update") => void;
  /** Called after setup/save-rules to clear the setup mode from the dispatcher */
  onSetupComplete?: () => void;
  /** Called after a secret write/delete so adapters and services can be reloaded. */
  onSecretChanged?: (scope: string) => Promise<void>;
  /** Called when a context-bearing file change should refresh the next owner DM session. */
  onPromptContextChanged?: PromptContextChangedCallback;
  /**
   * B-004 Phase 2a — fired after every successful `/api/context/*` write
   * or delete so the reconciler can sweep the context-index.md quickly
   * without waiting for its own chokidar debounce window.
   */
  onIndexableContextChange?: (path: string) => void;
  /**
   * B-007 §5.8 — called after any write/delete under `routines/custom/`
   * so the CustomRoutineScheduler re-enumerates and re-registers jobs.
   */
  onCustomRoutinesChanged?: () => void;
  /**
   * Called after a mutation to the effective mail scope — enabled providers,
   * account add/remove, active toggle, or app-password refresh. Implementations
   * re-materialize active DM session workdirs so the agent picks up the new
   * `accounts.md` + `external-services` skill on its next turn without
   * tearing down the SDK session.
   */
  onMailScopeChanged?: (reason: string) => void;
  /** Manual trigger for the polling-based hourly check */
  triggerHourlyCheck?: (
    source: string,
    options?: TriggerHourlyCheckOptions,
  ) => Promise<TriggerHourlyCheckResult>;
  /**
   * Evening-review slimdown §2.2 — synchronous manual fire of
   * `runRoadmapMechanicalMaintenance` (substeps 2a / 2b / 2d). Used
   * by `POST /api/agent/run-now/roadmap-maintenance` for operator
   * debugging and the parallel-verification rollout phase. Returns
   * the structured maintenance result so the CLI can surface counts.
   */
  triggerRoadmapMaintenance?: () => RoadmapMaintenanceResult;
  /**
   * Emit a `routine.roadmap_refresh` event. Internal callers (post-morning,
   * google-auth-ready, schedule-insert hook) honor the 5-minute dedup guard.
   * Dashboard-initiated regeneration passes `{ bypassDedup: true }` so the
   * user sees an immediate update.
   */
  triggerRoadmapRefresh?: (
    source: string,
    options?: { bypassDedup?: boolean },
  ) => void;
  /** Explicitly end the current dashboard chat session. */
  endDashboardSession?: (channelId: string) => Promise<{ id: number } | null>;
  /** Continue a resumable browser-only dashboard session from history. */
  continueDashboardSession?: (sessionId: number) => Promise<
    | { ok: true; sessionId: number }
    | { ok: false; status: 403 | 404 | 409 | 503; message: string }
  >;
  /** Shared tracker used to mark daemon-originated file writes */
  writeTracker?: AgentWriteTracker;
  /**
   * DELEGATED-MODE-V2-DESIGN.md §4.2 — backs the generic
   * `POST /api/integrations/:key/exec` task-mode endpoint and the
   * delegated-sync-worker's hourly drift-detection invocations. The
   * legacy v1 per-route mail/calendar proxy was removed in Phase 3.6,
   * and the `/api/integrations/:key/invoke` RPC route that originally
   * fronted this invoker was retired 2026-05-01; `/exec` is now the
   * sole agent-facing surface.
   */
  delegatedInvoker?: DelegatedBackendInvoker;
  morningRoutineLock?: TodayWriteLockManager;
  /**
   * Shared management-md write-lock manager (docs/design/21-management-
   * registry-and-entities.md §11.1). The managed-tasks and sot-bindings
   * routes use this single in-process instance to serialize their
   * (render → atomic write → snapshot) trio against each other and
   * against the boot reconciler / chokidar watcher. Optional in tests
   * that don't exercise the registry; production wires it at startup
   * alongside `morningRoutineLock` / `roadmapWriteLock`.
   */
  managementMdWriteLockManager?: ManagementMdWriteLockManager;
  /**
   * Cross-request exclusive lock for `roadmap.md` writes. Dispatcher
   * auto-acquires it for `routine.roadmap_refresh`; DM handler /
   * evening sweeper acquire it via `POST /api/context/lock/roadmap`.
   * PUT / PATCH on `/api/context/roadmap` returns 409 when another
   * session holds the lock without passing the matching `X-Lock-Id`.
   */
  roadmapWriteLock?: RoadmapWriteLockManager;
  /**
   * Test seam for deterministic roadmap id generation.
   * Production uses node:crypto randomBytes.
   */
  roadmapIdRandomBytes?: (size: number) => Buffer;
  /**
   * Management Mode Phase 2 — migration orchestration primitives.
   * The setup-migrate route is the sole consumer; context.ts reads
   * `contextWriteGate` to decide whether to 503 writes during a move.
   */
  migrationLock?: MigrationLock;
  contextWriteGate?: ContextWriteGate;
  observerManager?: ObserverManager;
  /**
   * Integration delegation framework — fired by `PATCH /api/integrations/:key`
   * after the new state is persisted. Index.ts wires it to
   * `applyIntegrationModeChange`, which orchestrates §4.10 lifecycle step
   * 4 (start/stop registry-gated observers without daemon restart). The
   * route handler schedules the callback in the background so Apply returns
   * as soon as the persisted integration state is written.
   */
  onIntegrationModeChange?: (
    key: IntegrationKey,
    prev: IntegrationState,
    next: IntegrationState,
  ) => Promise<void>;
  /**
   * DELEGATED-MODE-V2-DESIGN.md §4.4 — re-materialize active DM session
   * workdirs after `PUT /api/backends/main` commits. Flipping the main
   * backend turns same-backend delegated integrations into cross-backend
   * (and vice-versa), which changes the resolved skill variant and the
   * per-backend instruction file baked into the workdir. Without this
   * hook a Claude→Codex main switch would leave running DM sessions
   * exposing the previous skill bundle until their next mode/scope edit.
   *
   * Optional so test harnesses don't need to supply it. Synchronous
   * fire-and-forget from the caller's perspective; per-session failures
   * are swallowed by the helper.
   */
  onMainBackendChange?: (reason: string) => void;
  /**
   * Hook fired by the migration endpoint after `commitVaultSettings`.
   * Index.ts wires this to `PrimaryVaultWatcher.setVaultPath` so the
   * primary-vault observer re-targets explicitly rather than peeking
   * at the mutable config object.
   */
  onPrimaryVaultPathChange?: (newPath: string | null) => void | Promise<void>;
  getInFlightExecutions?: () => InFlightExecutionInfo[];
  dashboardAdapter?: DashboardAdapter | null;
  eventBroadcaster?: EventBroadcaster | null;
  /**
   * Chat file attachments store (Phase 1). Optional — when absent, the
   * inbound API rejects attachmentIds with 503 and the outbound API
   * is not mounted.
   */
  attachmentStore?: AttachmentStore;
  /**
   * Audit logger for attachment uploads. Paired with `attachmentStore` —
   * index.ts supplies the same `AuditLogger` the dispatcher uses so
   * agent_actions rows flow through the existing onRowInserted hook.
   * Optional in tests that don't mount the full dispatcher.
   */
  auditLogger?: import("../core/dispatcher.js").IAuditLogger;
  /**
   * Map an `X-Turn-Token` back to the session that issued it. The
   * dispatcher owns the token→session mapping; this function is how
   * the API layer checks that a POST /chat/outbound-attachments call
   * really corresponds to a currently-running turn.
   */
  validateAttachmentTurnToken?: (
    token: string,
  ) => { sessionId: number } | null;
  whatsappControls?: WhatsAppControls | null;
  /**
   * Per-platform pairing helpers for Slack/Telegram/Discord. Each entry is
   * optional because the adapter may not be configured at all (no token).
   * The dashboard's pairing-flow routes branch on whether the entry exists.
   */
  messagingControls?: {
    telegram?: TelegramControls;
    slack?: SlackControls;
    discord?: DiscordControls;
  };
  /**
   * Phase 5 (P5 multi-account remotes) — shared per-alias credential
   * resolver. Index.ts builds one instance and threads it both to the
   * GitWatcher / GitHubPoller observers AND to this `ApiDependencies`
   * record so the `/api/git-accounts/:alias/probe` route uses the same
   * registry the observers use. Optional because tests that mount a
   * subset of the API surface needn't supply it; `createGitAccountsRoutes`
   * lazily builds a stand-in only when this is unset.
   */
  gitAccountRegistry?: import("../services/git-account-registry.js").GitAccountRegistry;
}

export interface TelegramBotInfoResponse {
  ok: true;
  id: number;
  username: string | null;
  firstName: string | null;
}
export interface TelegramPairingStartResponse {
  pairToken: string;
  deepLink: string;
  qrDataUrl: string;
  expiresAt: number;
  botUsername: string;
}
export interface TelegramPairingStatusResponse {
  paired: boolean;
  ownerChatId: string | null;
  pairingActive: boolean;
}

export interface TelegramControls {
  /**
   * Validate a Telegram bot token by calling getMe. If `candidate` is
   * provided, that token is tested directly (no need to save it first).
   * Otherwise the saved Telegram token is loaded from the secret store.
   */
  testToken: (candidate?: string) => Promise<TelegramBotInfoResponse>;
  startPairing: (ttlMs?: number) => Promise<TelegramPairingStartResponse>;
  getPairingStatus: () => TelegramPairingStatusResponse;
  cancelPairing: () => void;
}

export interface SlackBotInfoResponse {
  ok: true;
  botUserId: string | null;
  botName: string | null;
  team: string | null;
  url: string | null;
}
export interface PhrasePairingStartResponse {
  /** The phrase the user must include in their next DM to the bot. */
  phrase: string;
  /** ms since epoch when this challenge expires. */
  expiresAt: number;
}
export interface SlackPairingStatusResponse {
  paired: boolean;
  ownerUserId: string | null;
  pairingActive: boolean;
}

export interface SlackControls {
  testToken: (candidate?: string) => Promise<SlackBotInfoResponse>;
  startPairing: (ttlMs?: number) => Promise<PhrasePairingStartResponse>;
  cancelPairing: () => void;
  getPairingStatus: () => SlackPairingStatusResponse;
}

export interface DiscordBotInfoResponse {
  ok: true;
  id: string;
  username: string;
  discriminator: string | null;
  avatarUrl: string | null;
}
export interface DiscordPairingStatusResponse {
  paired: boolean;
  ownerUserId: string | null;
  pairingActive: boolean;
}

export interface DiscordControls {
  testToken: (candidate?: string) => Promise<DiscordBotInfoResponse>;
  startPairing: (ttlMs?: number) => Promise<PhrasePairingStartResponse>;
  cancelPairing: () => void;
  getPairingStatus: () => DiscordPairingStatusResponse;
}

export interface WhatsAppQrResponse {
  /** scannable PNG data URL ready for `<img src=...>`, or null when no QR is current */
  dataUrl: string | null;
  /** raw payload string Baileys produced — only useful for debugging */
  payload: string | null;
  /** ms since epoch the snapshot was generated, or null */
  generatedAt: number | null;
  /** ms since epoch the QR snapshot will be discarded, or null */
  expiresAt: number | null;
  /** current connection state of the adapter */
  state:
    | "ok"
    | "connecting"
    | "awaiting_qr"
    | "disconnected"
    | "logged_out"
    | "disabled"
    | "not_initialized";
  /** last error string surfaced by the adapter, if any */
  error: string | null;
}

export interface WhatsAppControls {
  /** True if a WhatsAppAdapter is currently registered with the MessageHub. */
  isInitialized: () => boolean;
  /** Build + register + start the adapter (no-op if already initialized). */
  enable: () => Promise<void>;
  /** Stop and unregister the adapter. */
  disable: () => Promise<void>;
  /** Trigger Baileys connect/QR generation; returns immediately. */
  requestQr: () => Promise<void>;
  /** Trigger pairing and wait up to `timeoutMs` for the first scannable QR. */
  waitForQr: (timeoutMs?: number) => Promise<WhatsAppQrResponse>;
  /** Get the current QR snapshot + adapter state without triggering pairing. */
  getQrResponse: () => WhatsAppQrResponse;
  /**
   * Reset all WhatsApp link state: tear the adapter down, wipe the Baileys
   * multi-file auth directory (creds + sessions + QR file), and delete the
   * cached `owner_channels` row. If WhatsApp is currently enabled, the
   * adapter is rebuilt and a fresh QR is awaited up to `timeoutMs`; if it
   * is disabled, the response state is `not_initialized`.
   *
   * The dashboard exposes this as a "Reset connection" button for the
   * recovery flow where the user has unlinked the device from the WhatsApp
   * side (or the link is otherwise broken) and the stale auth dir would
   * otherwise prevent a fresh pair from succeeding.
   */
  reset: (timeoutMs?: number) => Promise<WhatsAppQrResponse>;
}

/**
 * Hostnames the daemon will accept in the Host header. Anything else is
 * rejected before any handler runs — the daemon binds to 127.0.0.1 only,
 * but Node still accepts requests with arbitrary Host headers, and a DNS
 * rebinding attack could land here with `Host: pairing.evil.example`.
 */
const ALLOWED_DAEMON_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

function normalizeHostname(rawHostname: string): string {
  const lower = rawHostname.toLowerCase();
  /* c8 ignore next -- WHATWG URL.hostname strips brackets already; this guard is defensive-only */
  if (lower.startsWith("[") && lower.endsWith("]")) return lower.slice(1, -1);
  return lower;
}

/**
 * Resolve the request's effective hostname for the loopback check.
 * Falls back to the URL's parsed hostname when the Host header is
 * absent — this is the path Hono's synthetic test requests
 * (`app.request("/api/...")`) take, since they construct a Request
 * with a URL but no explicit Host header. In production every real
 * HTTP/1.1 request carries a Host header, and the URL Hono constructs
 * is itself derived from that header, so the fallback never widens
 * the security boundary.
 */
function getRequestHostname(c: {
  req: { header: (n: string) => string | undefined; url: string };
}): string | null {
  const headerValue = c.req.header("host");
  if (headerValue) {
    try {
      return normalizeHostname(new URL(`http://${headerValue}`).hostname);
    } catch {
      return null;
    }
  }
  /* c8 ignore start -- Hono always provides a valid URL; fallback catch is defensive-only */
  try {
    return normalizeHostname(new URL(c.req.url).hostname);
  } catch {
    return null;
  }
  /* c8 ignore stop */
}

interface LoopbackBrowserGateInput {
  method: string;
  origin: string | null;
  secFetchSite: string | null;
  allowedOrigins: ReadonlySet<string>;
}

function buildAllowedDaemonOrigins(apiPort: number): Set<string> {
  return new Set([
    `http://localhost:${apiPort}`,
    `http://127.0.0.1:${apiPort}`,
    `http://[::1]:${apiPort}`,
  ]);
}

function evaluateLoopbackBrowserGate(
  input: LoopbackBrowserGateInput,
): { allowed: true } | { allowed: false; reason: string } {
  if (SAFE_METHODS.has(input.method)) {
    return { allowed: true };
  }

  if (input.secFetchSite) {
    if (input.secFetchSite === "same-origin") {
      return { allowed: true };
    }
    return {
      allowed: false,
      reason: `sec_fetch_site_${input.secFetchSite.replace(/-/g, "_")}`,
    };
  }

  if (input.origin) {
    return input.allowedOrigins.has(input.origin)
      ? { allowed: true }
      : { allowed: false, reason: "origin_mismatch" };
  }

  return { allowed: true };
}

function getBearerToken(c: {
  req: { header: (n: string) => string | undefined };
}): string | null {
  const authHeader = c.req.header("authorization");
  return authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
}

function safeTokenEquals(actual: string | null, expected: string | null): boolean {
  return actual !== null
    && expected !== null
    && actual.length === expected.length
    && timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
}

async function isBearerAuthenticated(
  c: { req: { header: (n: string) => string | undefined } },
  deps: Pick<ApiDependencies, "secretBroker">,
): Promise<boolean> {
  return safeTokenEquals(getBearerToken(c), await deps.secretBroker.getApiToken());
}

/**
 * Check if a request to a ReadSensitive endpoint carries a valid token.
 *
 * Two valid credentials:
 *  1. `Authorization: Bearer <apiToken>` — dashboard proxy path
 *  2. `X-Read-Token: <readToken>` — agent backend path
 *
 * Both are verified with timing-safe comparison.
 */
async function isReadSensitiveAuthenticated(
  c: { req: { header: (n: string) => string | undefined } },
  deps: Pick<ApiDependencies, "secretBroker" | "readToken" | "readTokenValidator">,
): Promise<boolean> {
  // Path 1: Bearer token (dashboard proxy)
  if (await isBearerAuthenticated(c, deps)) {
    return true;
  }

  // Path 2: X-Read-Token (agent backend)
  const readTokenHeader = c.req.header("x-read-token");
  if (readTokenHeader !== undefined) {
    if (deps.readTokenValidator?.(readTokenHeader) === true) {
      return true;
    }
    if (
      typeof deps.readToken === "string"
      && readTokenHeader.length === deps.readToken.length
      && timingSafeEqual(Buffer.from(readTokenHeader), Buffer.from(deps.readToken))
    ) {
      return true;
    }
  }

  return false;
}

export function createApp(deps: ApiDependencies): Hono {
  const app = new Hono();
  const allowedDaemonOrigins = buildAllowedDaemonOrigins(deps.config.apiPort);

  // Middleware

  // Defense-in-depth Host header validation. The dashboard proxy already
  // does this check, but the daemon should not trust an upstream gate —
  // an attacker reaching port 8321 directly (or via a future proxy bypass)
  // must still be denied if their Host header isn't a loopback hostname.
  // This closes the DNS rebinding attack against the daemon itself.
  app.use("*", async (c, next) => {
    const hostname = getRequestHostname(c);
    if (!hostname || !ALLOWED_DAEMON_HOSTS.has(hostname)) {
      return c.json(
        { error: "forbidden_host", message: "Daemon only accepts loopback Host headers." },
        403,
      );
    }
    await next();
  });

  app.use("*", cors({ origin: "http://localhost:3000" }));
  app.use("*", honoLogger());

  // Risk-based auth middleware — Approve-tier endpoints require Bearer token;
  // ReadSensitive-tier endpoints require Bearer or X-Read-Token when
  // `enforceReadToken=true`; Autonomous-tier endpoints pass through
  // (deniedTools is the safety control per DELEGATED-MODE-V2 §4.5).
  app.use("*", async (c, next) => {
    const path = new URL(c.req.url).pathname;
    const method = c.req.method;
    const tier = classifyRisk(method, path);
    const browserGate = evaluateLoopbackBrowserGate({
      method,
      origin: c.req.header("origin") ?? null,
      secFetchSite: c.req.header("sec-fetch-site") ?? null,
      allowedOrigins: allowedDaemonOrigins,
    });

    if (tier === RiskTier.Approve) {
      const expected = await deps.secretBroker.getApiToken();
      if (!expected) {
        return c.json(
          { error: "server_misconfigured", message: "Protected endpoints require a configured daemon API token" },
          503,
        );
      }

      const token = getBearerToken(c);
      // Timing-safe comparison to prevent side-channel leakage
      const valid = safeTokenEquals(token, expected);
      if (!valid) {
        // Fail-closed fallback misfires when the agent invents a path that
        // doesn't exist in `API_RISK` — `classifyRisk` defaulted it to
        // Approve, then the bearer check turned it into a 401 that reads
        // like an auth issue. Detect that case and return a clearer 404
        // hint so the agent can correct the path instead of retrying with
        // the same bad route. Real Approve-tier routes still 401.
        const explicit = findExplicitRiskClassification(method, path);
        if (explicit === null && path.startsWith("/api/")) {
          logger.warn(
            { method, path },
            "Unknown /api route → 404 hint (agent likely used wrong path)",
          );
          return c.json(
            {
              error: "unknown_route",
              message:
                `Route ${method} ${path} is not registered on this daemon. ` +
                `If you intended a context write lock, the correct paths are ` +
                `POST/DELETE /api/context/lock/{morning-routine,roadmap} — ` +
                `note the order: \`/lock/<name>\`, NOT \`/<name>/lock\` or ` +
                `\`/<name>/write-lock\`. Otherwise re-check the relevant ` +
                `skill (context / today / roadmap / schedule / ...) for the ` +
                `exact path.`,
            },
            404,
          );
        }
        return c.json(
          { error: "unauthorized", message: "This endpoint requires authentication" },
          401,
        );
      }
    } else if (!browserGate.allowed && !(await isBearerAuthenticated(c, deps))) {
      logger.warn(
        { method, path, tier, reason: browserGate.reason },
        "browser-originated unsafe request rejected",
      );
      return c.json(
        {
          error: "forbidden_origin",
          reason: browserGate.reason,
          message:
            "Browser-originated unsafe requests must go through the authenticated dashboard proxy.",
        },
        403,
      );
    } else if (tier === RiskTier.ReadSensitive) {
      // Accept either Bearer (dashboard proxy) or X-Read-Token (agent backend).
      const authenticated = await isReadSensitiveAuthenticated(c, deps);
      if (!authenticated) {
        if (deps.enforceReadToken) {
          // Phase D: hard enforcement — reject unauthenticated requests.
          logger.warn(
            { method, path, tier: "read_sensitive" },
            "read-sensitive-access REJECTED — no valid token",
          );
          return c.json(
            { error: "unauthorized", message: "This endpoint requires X-Read-Token or Bearer authentication" },
            401,
          );
        }
        // Phase C: soft enforcement — warn but allow through.
        logger.warn(
          { method, path, tier: "read_sensitive" },
          "read-sensitive-access WITHOUT valid token",
        );
      } else {
        logger.debug(
          { method, path, tier: "read_sensitive" },
          "read-sensitive-access",
        );
      }
    }

    await next();
  });

  // Integration delegation framework — registry-driven 410 gate (§4.5.2).
  // Mounted AFTER auth so unauthenticated requests still get 401 (not 410,
  // which would leak the integration's mode to anonymous callers). Gating
  // is path-prefix only; multi-provider routes (Gmail under /api/mail/*)
  // do per-account 410s inside their handlers.
  app.use("*", createIntegrationRouteGate({ db: deps.db }));

  // Error handling — do not leak internal details to clients, but mint a
  // short debug id so the agent can quote it on retry and the operator can
  // grep daemon logs for it. The id is the only correlation surface for
  // uncaught throws; route-specific errors carry richer envelopes via
  // respondWithAgentError.
  app.onError((err, c) => {
    const debugId = randomUUID().slice(0, 8);
    logger.error(
      { err, path: c.req.path, method: c.req.method, debugId },
      "API error",
    );
    return c.json(
      {
        error: "internal_error",
        debugId,
        hint:
          "Unexpected daemon error. Quote `debugId` if reporting; the operator can grep daemon logs for it. Do not auto-retry tight — re-issue once and notify the user if it fails again.",
      },
      500,
    );
  });

  // Routes
  const healthRoutes = createHealthRoutes(deps);
  const contextRoutes = createContextRoutes(deps);
  const agentRoutes = createAgentRoutes(deps);
  const dashboardRoutes = createDashboardRoutes(deps);
  const notionRoutes = createNotionRoutes({
    notionService: deps.services.notion,
    writeTracker: deps.writeTracker,
  });
  const metricsRoutes = createMetricsRoutes(deps);
  const setupRoutes = createSetupRoutes(deps);
  // Management Mode Phase 2 — migration endpoint. Mounted only when
  // the orchestrator primitives are wired (normal boot); tests that
  // skip the primitives gracefully omit the route. Uses a shared
  // settings store so the settings update inside the route hits the
  // same DB rows env-writer would.
  const setupMigrateRoutes =
    deps.migrationLock && deps.contextWriteGate
      ? createSetupMigrateRoutes({
          db: deps.db,
          config: deps.config,
          settingsStore: createSettingsStore(deps.db),
          migrationLock: deps.migrationLock,
          contextWriteGate: deps.contextWriteGate,
          observerManager: deps.observerManager,
          eventBus: deps.eventBus,
          eventBroadcaster: deps.eventBroadcaster ?? undefined,
          getInFlightExecutions: deps.getInFlightExecutions,
          onPrimaryVaultPathChange: deps.onPrimaryVaultPathChange,
        })
      : null;
  const systemRoutes = createSystemRoutes(deps);
  const backendRoutes = createBackendRoutes(deps);
  const skillsRoutes = createSkillsRoutes({ config: deps.config });
  const observationRoutes = createObservationRoutes(deps);
  const skillCurationRoutes = createSkillCurationRoutes(deps);
  const profileQuestionsRoutes = createProfileQuestionsRoutes(deps);
  const recurringScheduleRoutes = createRecurringScheduleRoutes(deps);
  const scheduleOptionsRoutes = createScheduleOptionsRoutes({
    config: deps.config,
  });
  const triggerRoutes = createTriggerRoutes(deps);
  const travelBookingRoutes = createTravelBookingRoutes(deps);
  const receiptRoutes = createReceiptRoutes(deps);
  const travelTimeRoutes = createTravelTimeRoutes({ services: deps.services });
  const bookRoutes = createBookRoutes(deps);
  const integrationRoutes = createIntegrationRoutes(deps);
  const integrationReconcileRoutes = createIntegrationReconcileRoutes(deps);
  const delegatedRunRoutes = createDelegatedRunRoutes(deps);
  const delegatedSyncRoutes = createDelegatedSyncRoutes(deps);
  const knowledgeRoutes = createKnowledgeRoutes(deps);
  const taskFlowsRoutes = createTaskFlowsRoutes();
  const gitAccountsRoutes = createGitAccountsRoutes(deps);
  const commandsRoutes = createCommandsRoutes(deps);
  const voiceRoutes = createVoiceRoutes(deps);
  const wikiRoutes = createWikiRoutes(deps);
  const fsRoutes = createFsRoutes(deps);
  // Management Registry & Entities (docs/design/21-management-registry-
  // and-entities.md). The managed-tasks and sot-bindings routes MUST
  // share one lock manager — separate instances would let back-to-back
  // POSTs stomp each other's render. Honor the externally-supplied
  // manager when present (production boot wires it into the boot
  // reconciler + chokidar watcher), otherwise materialize a single
  // shared instance for this server's lifetime.
  const sharedManagementMdLockManager: ManagementMdWriteLockManager =
    deps.managementMdWriteLockManager ?? new InMemoryManagementMdWriteLockManager();
  const managedTasksRoutes = createManagedTasksRoutes(
    buildManagedTasksRoutesDepsFromApi(deps, sharedManagementMdLockManager),
  );
  const sotBindingsRoutes = createSotBindingsRoutes(
    buildSotBindingsRoutesDepsFromApi(deps, sharedManagementMdLockManager),
  );
  const entitiesRoutes = createEntitiesRoutes(
    buildEntitiesRoutesDepsFromApi(deps),
  );
  const activitySourcesRoutes = createActivitySourcesRoutes({ db: deps.db });

  app.route("/api", healthRoutes);
  app.route("/api", contextRoutes);
  app.route("/api", agentRoutes);
  app.route("/api", dashboardRoutes);
  app.route("/api", notionRoutes);
  app.route("/api", metricsRoutes);
  app.route("/api", setupRoutes);
  if (setupMigrateRoutes) {
    app.route("/api", setupMigrateRoutes);
  }
  app.route("/api", systemRoutes);
  app.route("/api", backendRoutes);
  app.route("/api", skillsRoutes);
  app.route("/api", observationRoutes);
  app.route("/api", skillCurationRoutes);
  app.route("/api", profileQuestionsRoutes);
  app.route("/api", recurringScheduleRoutes);
  app.route("/api", scheduleOptionsRoutes);
  app.route("/api", managedTasksRoutes);
  app.route("/api", sotBindingsRoutes);
  app.route("/api", entitiesRoutes);
  app.route("/api", activitySourcesRoutes);
  app.route("/api", triggerRoutes);
  app.route("/api", travelBookingRoutes);
  app.route("/api", receiptRoutes);
  app.route("/api", travelTimeRoutes);
  app.route("/api", bookRoutes);
  app.route("/api", integrationRoutes);
  app.route("/api", integrationReconcileRoutes);
  app.route("/api", delegatedRunRoutes);
  app.route("/api", delegatedSyncRoutes);
  app.route("/api", knowledgeRoutes);
  app.route("/api", taskFlowsRoutes);
  app.route("/api", gitAccountsRoutes);
  app.route("/api", commandsRoutes);
  app.route("/api", voiceRoutes);
  app.route("/api", wikiRoutes);
  app.route("/api", fsRoutes);

  // ── Chat file attachments (Phase 1) ──
  if (deps.attachmentStore) {
    const attachmentRoutes = createAttachmentRoutes({
      db: deps.db,
      config: deps.config,
      store: deps.attachmentStore,
      /* c8 ignore start -- fallback null-validator is only invoked when validateAttachmentTurnToken is absent and a turn token is presented; no test covers that deep interaction */
      validateTurnToken: deps.validateAttachmentTurnToken ?? (() => null),
      /* c8 ignore stop */
      ...(deps.auditLogger ? { audit: deps.auditLogger } : {}),
    });
    app.route("/api", attachmentRoutes);
  }

  // ── MCP server CRUD + probe (B-003 Phase 2) ──
  // Per-server secrets live in the shared blob store under `mcp:<id>:<key>`.
  // If no blob store is wired (unit-test harnesses that omit it), the MCP
  // route is skipped rather than silently writing secrets with a different
  // key.
  if (deps.blobStore) {
    const mcpRoutes = createMcpRoutes({
      db: deps.db,
      blobStore: deps.blobStore,
      dataDir: deps.config.dataDir,
    });
    app.route("/api", mcpRoutes);
  }

  // Calendar routes (reads from services registry dynamically). Direct
  // mode only — delegated requests are 410-gated by the integration
  // route gate before reaching this handler (DELEGATED-MODE-V2-DESIGN.md
  // §6.3); cross-backend delegated work flows through
  // POST /api/integrations/google_calendar/exec.
  const calendarRoutes = createCalendarRoutes({
    services: deps.services,
    agentWriteTracker: deps.writeTracker,
    db: deps.db,
  });
  app.route("/api", calendarRoutes);

  // Apple Calendar (iCloud CalDAV) routes — sibling provider to
  // /api/calendar. The skill body routes the agent here when
  // rules/management.md says Schedule = Apple Calendar.
  const appleCalendarRoutes = createAppleCalendarRoutes({
    services: deps.services,
    secretBroker: deps.secretBroker,
    agentWriteTracker: deps.writeTracker,
  });
  app.route("/api", appleCalendarRoutes);

  // Multi-mail provider routes — /api/mail/* + /api/config/mail/*. Gmail
  // accounts return 410 from the per-account gate inside the route
  // handler when `gmail.mode === "delegated"` (DELEGATED-MODE-V2-DESIGN.md
  // §6.3 defense-in-depth); cross-backend delegated work flows through
  // POST /api/integrations/gmail/exec.
  const mailRoutes = createMailRoutes({
    db: deps.db,
    config: deps.config,
    services: deps.services,
    blobStore: deps.blobStore,
    writeTracker: deps.writeTracker,
    onMailScopeChanged: deps.onMailScopeChanged,
  });
  app.route("/api", mailRoutes);

  // Obsidian routes — share the writeTracker so agent-originated vault
  // writes (create / append / daily:append) are attributed correctly by
  // the obsidian-watcher observer instead of appearing as user edits.
  const obsidianRoutes = createObsidianRoutes({
    obsidianService: deps.services.obsidian,
    writeTracker: deps.writeTracker,
  });
  app.route("/api", obsidianRoutes);

  // Git routes — registered unconditionally; the read-only proxy
  // resolves `?repo=` against the unified `repositories` table on every
  // request and 400s when the row is missing or has no local clone.
  const gitRoutes = createGitRoutes({ db: deps.db });
  app.route("/api", gitRoutes);

  // Unified Repositories API — registration + behavioural surface
  // (CRUD, run, triggers, daily management). See
  // docs/design/appendices/unified-repositories.md.
  const repositoriesRoutes = createRepositoriesRoutes({
    db: deps.db,
    eventBus: deps.eventBus,
    config: deps.config,
    writeTracker: deps.writeTracker,
    onIndexableContextChange: deps.onIndexableContextChange,
  });
  app.route("/api", repositoriesRoutes);
  // Git template editor + retemplate. Registered unconditionally — the
  // dashboard's Templates editor is reachable even when no repos are
  // currently watched (the user may be staging a template change before
  // adding repos), and the retemplate path's own enumeration handles
  // the empty-targets case.
  const gitTemplatesRoutes = createGitTemplatesRoutes({
    db: deps.db,
    config: deps.config,
    getContextDir: () => getContextDir(deps.config, deps.db),
  });
  app.route("/api", gitTemplatesRoutes);

  // SSE routes for real-time dashboard communication
  if (deps.eventBroadcaster) {
    const sseRoutes = createSSERoutes({
      dashboardAdapter: deps.dashboardAdapter ?? null,
      eventBroadcaster: deps.eventBroadcaster,
      getChatBinding: () => {
        const result = queryChatBinding(deps.db, {
          backend: "claude",
          highModel: DEFAULT_CLAUDE_HIGH_MODEL,
        });
        if (!result) return null;
        return {
          backend: result.activeBackend,
          model: result.activeModel,
          modelLabel: result.activeModelLabel,
        };
      },
      isSessionActive: (sessionId) => {
        const row = deps.db
          .prepare(
            "SELECT 1 FROM conversation_sessions WHERE id = ? AND status = 'active' LIMIT 1",
          )
          .get(sessionId);
        return row != null;
      },
      findActiveDashboardSessionId: () => {
        const row = deps.db
          .prepare(
            `SELECT id FROM conversation_sessions
             WHERE scope = 'dashboard_chat'
               AND scope_key = 'dashboard'
               AND status = 'active'
             ORDER BY last_message_at DESC
             LIMIT 1`,
          )
          .get() as { id: number } | undefined;
        return row?.id ?? null;
      },
      rebindSessionChannel: (sessionId, newChannelId) => {
        deps.db
          .prepare(
            "UPDATE conversation_sessions SET channel_id = ? WHERE id = ? AND status = 'active'",
          )
          .run(newChannelId, sessionId);
      },
      endSession: (channelId) => deps.endDashboardSession?.(channelId) ?? Promise.resolve(null),
      continueSession: (sessionId) =>
        deps.continueDashboardSession?.(sessionId)
          ?? Promise.resolve({ ok: false as const, status: 503, message: "continue unavailable" }),
      attachmentStore: deps.attachmentStore,
      validateChatModelOverride: (backendId, modelId) => {
        try {
          // Defense-in-depth: even if `backends.enabled = 1` somehow lands
          // for a backend whose runtime core isn't wired (`opencode` until
          // docs/design/appendices/opencode-backend.md Phase 2), reject the override here so
          // dashboard chat doesn't trip BackendRouter.requireCore at dispatch.
          if (!isRuntimeAvailableBackendId(backendId)) {
            return false;
          }
          const row = deps.db
            .prepare("SELECT enabled FROM backends WHERE id = ? LIMIT 1")
            .get(backendId) as { enabled: number } | undefined;
          if (!row || row.enabled !== 1) {
            return false;
          }
          return getModelsForBackend(backendId).some(
            (model) => model.modelId === modelId,
          );
        /* c8 ignore start -- schema always includes backends table after applySchema; catch is defensive for production drift */
        } catch (err) {
          logger.warn(
            { err, backendId, modelId },
            "validateChatModelOverride query failed — rejecting override",
          );
          return false;
        }
        /* c8 ignore stop */
      },
    });
    app.route("/api", sseRoutes);
  }

  // GitHub routes — webhook at root, API proxy under /api
  if (deps.eventBus) {
    const { webhookApp, apiApp } = createGitHubRoutes({
      db: deps.db,
      config: deps.config,
      secretBroker: deps.secretBroker,
      eventBus: deps.eventBus,
    });
    app.route("/", webhookApp);   // POST /webhook/github
    app.route("/api", apiApp);    // GET /api/github/repos, etc.
  }

  // Boot-time risk-classification audit. Surfaces /api routes that
  // rely on the default-Approve fallback. Most are intentional admin
  // surfaces (secrets, pairing, restore-snapshot, dashboard-only
  // controls) for which fail-closed is correct — but the same fallback
  // historically masked the `POST /api/context/roadmap/id` regression
  // that 7×401'd inside roadmap_refresh on 2026-04-28.
  //
  // Gating: log only when the unclassified set CHANGES from the last
  // boot. A warning that fires identically on every restart turns into
  // wallpaper within a week and a real regression (one new entry) gets
  // lost in the noise. Hash + persist + diff via `runtime_state`.
  const unclassified = auditRiskClassifications(app.routes);
  /* c8 ignore start -- all current routes are classified via prefix match; this block fires only during development when a new route is added without updating risk-classifier.ts */
  if (unclassified.length > 0) {
    const auditFingerprint = createHash("sha256")
      .update(
        unclassified
          .map((r) => `${r.method} ${r.path}`)
          .sort()
          .join("\n"),
      )
      .digest("hex");
    const previous = readRuntimeState<{ fingerprint: string }>(
      deps.db,
      RISK_AUDIT_STATE_KEY,
    );
    if (previous?.fingerprint !== auditFingerprint) {
      logger.warn(
        { count: unclassified.length, routes: unclassified },
        "Boot audit: /api routes relying on the default-Approve fallback (changed since last boot). Each WILL require Bearer auth. Add explicit RiskTier.Approve / Autonomous entries in risk-classifier.ts to silence this and surface future regressions cleanly.",
      );
      writeRuntimeState(deps.db, RISK_AUDIT_STATE_KEY, {
        fingerprint: auditFingerprint,
      });
    }
  } else {
  /* c8 ignore stop */
    // Set was previously non-empty and is now empty — clear the
    // stored fingerprint so a regression resurrects the warning.
    writeRuntimeState(deps.db, RISK_AUDIT_STATE_KEY, { fingerprint: "" });
  }

  return app;
}
