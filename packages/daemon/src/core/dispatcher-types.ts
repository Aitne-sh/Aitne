/**
 * Shared types and zero-dependency helpers for the dispatcher surface.
 *
 * This module owns the contract types the dispatcher exposes to the rest of
 * the daemon — adapter / service interfaces (`IDashboardStream`,
 * `INotificationManager`, `ISessionManager`, `IMessageRecorder`,
 * `IContextBuilder`, `IAuditLogger`), the `GetTaskFlow` callback, and the
 * value types used at API boundaries (`TriggerHourlyCheckOptions`,
 * `TriggerHourlyCheckResult`, `InFlightExecutionInfo`, `SetupMode`,
 * `BangCommandDetail`, `ReplyActivityHandle`). It also hosts two pure
 * helpers that have no dependence on dispatcher instance state:
 * `buildLogErrorContext` (recovers backend/quota failure metadata from a
 * thrown error) and `parseStage2Verdict` (extracts the Stage 2 hourly-check
 * triage JSON verdict from an LLM response).
 *
 * The dispatcher re-exports the public-surface members of this file so that
 * existing callers (`import {...} from "./dispatcher.js"`) continue to work
 * without modification — phase D-1 of `docs/design/appendices/file-split-plan.md`.
 */

import type {
  Event,
  MessageEvent,
  AgentResult,
  BackendId,
  IntegrationKey,
  IntegrationState,
} from "@aitne/shared";
import {
  BackendDecisiveFailure,
  BackendQuotaError,
} from "./agent-core.js";
import { BackendRouterHandledError } from "./backends/backend-router.js";
import type { SessionInfoPayload } from "../api/chat-binding-query.js";
import type { DeferredSessionEffects } from "./session-manager.js";

export interface ReplyActivityHandle {
  stop(): Promise<void>;
}

/** Interface for streaming adapter (dashboard SSE) */
export interface IDashboardStream {
  sendStreamChunk(channelId: string, chunk: string): void;
  sendStreamEnd(channelId: string): void;
  sendMessageMeta?(channelId: string, meta: { backend?: string; model?: string; durationMs?: number; costUsd?: number }): void;
  sendSessionInfo?(channelId: string, info: SessionInfoPayload): void;
  sendError?(channelId: string, message: string): void;
  /**
   * Chat-attachments Phase 1 — ship the outbound attachment list produced
   * during the just-completed turn to the dashboard. Consumed by the
   * transcript renderer to show download chips / inline thumbnails
   * alongside the assistant message.
   */
  sendAttachments?(
    channelId: string,
    attachments: Array<{
      id: string;
      originalFilename: string;
      mimeType: string;
      sizeBytes: number;
      caption?: string;
    }>,
  ): void;
}

/** Interface for ContextBuilder — implemented in Phase 1D */
export interface IContextBuilder {
  build(
    event: Event,
    opts?: {
      /**
       * Suppress the active-session `<conversation_history>` block
       * when the caller knows the cross-session bridge will cover the
       * same rows. See `ContextBuilder.build` for the full rationale
       * (DM-HISTORY-CONTINUITY-FIX H-3).
       */
      skipActiveHistoryBlock?: boolean;
    },
  ): Promise<string>;
  /**
   * Narrow companion to `build()` used by the dispatcher's resume
   * branch when there are proactive forwards that landed in this
   * scope *after* the SDK session was started. Returns the minimal
   * `<proactive_forwards_since_last_turn>` block, or `null` when no
   * such forwards exist. The full context block must NOT be appended
   * to a resume payload — the SDK session already holds the cached
   * system prompt; re-injecting it bills `<management_rules>`,
   * `<today>`, the entire `<conversation_history>` etc. against the
   * user turn instead of the cache (DM-HISTORY-CONTINUITY-FIX H-2).
   */
  buildResumeCatchupContext(
    event: Event,
    sessionStartedAtMs: number,
  ): Promise<string | null>;
}

/** Function type for resolving task flow templates by event type */
export type GetTaskFlow = (
  eventType: string,
  backendId?: string,
  integrations?: Partial<Record<IntegrationKey, IntegrationState>>,
) => string;

/**
 * Routing tuple a non-MessageEvent caller passes to
 * `INotificationManager.send` to land the message on a specific
 * channel rather than the user's configured proactive destinations.
 *
 * Structurally compatible with `WikiReplyTarget` (the persisted shape
 * on `event.data.reply_target`) — minus the audit-only `sender` field
 * which the manager doesn't consume for routing. Kept as its own type
 * so the notification layer does not need to import a wiki-specific
 * type from `@aitne/shared`.
 *
 * WIKI_BUILDER_DESIGN.md §3.4-bis (completion notification path).
 */
export interface MessageReplyTarget {
  platform: string;
  channel: string;
  threadId?: string | null;
}

/** Interface for NotificationManager — implemented in Phase 1F */
export interface INotificationManager {
  send(
    message: string,
    event: Event,
    options?: {
      priority?: string;
      category?: string;
      destinationMode?: "default" | "configured_only";
      originSessionId?: number;
      /**
       * Direct reply routing tuple. When supplied, the manager delivers
       * the message straight to `(platform, channel, threadId)` bypassing
       * quiet hours, rate limits, and batch queuing — the same path
       * `MessageEvent`-based replies take, but available to non-message
       * events (e.g. wiki.* sessions spawned from a `!ingest` DM, or
       * scheduled.task events lifted from approval rows). When the
       * adapter for the named platform is unregistered at delivery
       * time, the manager falls back to the proactive path (configured
       * destinations) so the reply still reaches the operator.
       *
       * WIKI_BUILDER_DESIGN.md §3.4-bis (completion notification path).
       */
      replyTo?: MessageReplyTarget;
    },
  ): Promise<void>;
  beginReplyActivity(event: MessageEvent): Promise<ReplyActivityHandle>;
}

/** Interface for SessionManager — implemented in Phase 2A */
export interface ISessionManager {
  getOrCreate(params: {
    platform: string;
    channel: string;
    threadId: string | null;
    isDm?: boolean;
    /**
     * MessageEvent.intent — forks the dashboard DM tuple into a separate
     * scope (chat vs docs_qa) so the two surfaces don't share a session.
     */
    intent?: "chat" | "docs_qa";
    requiredBackend?: BackendId;
    /**
     * When set and it differs from the active session's stored `model`,
     * treat the mismatch like a backend switch: reset the SDK session in
     * place (dashboard) or close + recreate (other DMs/threads) so the
     * new model starts fresh and history is re-injected as prompt text.
     * Omitting it falls back to the pre-existing "backend-only" match.
     */
    requiredModel?: string;
  }): Promise<{
    id: number;
    isActive: boolean;
    sessionId: string | null;
    model: string;
    backend?: BackendId;
    requiresHistoryInjection?: boolean;
  }>;
  /** Find an existing active session without creating one. Returns null if none exists. */
  findActive(params: {
    platform: string;
    channel: string;
    threadId: string | null;
    isDm?: boolean;
    intent?: "chat" | "docs_qa";
  }): Promise<{ id: number } | null>;
  updateSession(
    id: number,
    sessionId: string,
    model: string,
    backend?: BackendId,
  ): Promise<void>;
  /**
   * Refresh `started_at` to the current wall clock. Called from the
   * fresh-execute branch of the dispatcher right before
   * `contextBuilder.build()` so the row's `started_at` matches the
   * `<today snapshot_at="...">` timestamp baked into THIS turn's
   * system prompt.
   *
   * Background: pre-existing design comment in dispatcher-message-
   * handler.ts says "started_at is the moment <today> was captured".
   * That invariant only held by coincidence — every conversation_sessions
   * row was previously INSERTed by the same fresh-execute that built
   * the prompt. Post-H-1 (scheduler.handleDirectDm inserts rows
   * out-of-band) and post-reset-in-place (H-3 path keeps the row but
   * blanks backend_session_id), started_at can lag the actual SDK-
   * session-bind time by hours, causing the H-2 catchup builder to
   * re-emit forwards the SDK already has.
   */
  markFreshExecuteStart(id: number): void;
  touchSession(id: number): void;
  closeSession(id: number): void;
  /**
   * Transaction-safe close variant — callers already inside a
   * `db.transaction(...)` body collect side effects into the supplied
   * buffer and flush them with `flushEffects` after commit.
   */
  closeSessionInTx(id: number, effects: DeferredSessionEffects): void;
  newEffectsBuffer(): DeferredSessionEffects;
  flushEffects(effects: DeferredSessionEffects): void;
  /**
   * DB-backed lookup for the currently-bound dashboard channel_id of an
   * active session. Returns null when the session is not active or not
   * found. Used by dispatcher to route stream/meta/error events to
   * whichever browser tab is currently connected, instead of the stale
   * event.channel captured when the user POSTed their message.
   */
  getActiveChannelIdForSession(sessionId: number): string | null;
  getDmPlatformsWithNewMessages(): string[];
  getUnsummarizedDmMessages(platform: string): { role: string; content: string; timestamp: string; metadata?: string | null }[];
  getPreviousDmSummary(platform: string): string | null;
  saveDmSummary(platform: string, summary: string, messageCount: number): void;
}

/** Interface for MessageRecorder — records messages to DB. Returns
 *  `true` when the row was persisted, `false` when the INSERT/UPDATE
 *  transaction rolled back (logged internally). The atomic
 *  INSERT-plus-touch contract means callers no longer need to pair
 *  `recordMessage` with a separate `touchSession` — on success the
 *  session's `last_message_at` and `message_count` are already in sync
 *  with the `messages` row; on failure, neither moves. */
export interface IMessageRecorder {
  recordMessage(params: {
    sessionId: number;
    role: "user" | "assistant" | "system";
    content: string;
    platform: string;
    senderId?: string;
    backend?: BackendId;
    modelId?: string;
    metadata?: Record<string, unknown>;
    notificationDispatchId?: string | null;
  }): boolean;
}

/** Interface for AuditLogger — implemented in Phase 1D */
export interface IAuditLogger {
  logAction(params: {
    event: Event;
    model: string;
    costUsd: number;
    usage: AgentResult["usage"];
    modelUsage: AgentResult["modelUsage"];
    durationMs: number;
    numTurns: number;
    trigger: "reactive" | "autonomous";
    backend?: BackendId;
    costSource?: AgentResult["costSource"];
    /**
     * Whether the agent made at least one PUT/PATCH call to /api/context/*.
     * Used for observer-event observability — see Phase 6 of
     * docs/observer-context-update-fix.md.
     */
    contextUpdated?: boolean;
    /**
     * Number of server-side advisor tool invocations. Populated by the Claude
     * Code backend when the `advisor_20260301` tool is active; otherwise 0.
     */
    advisorCallCount?: number;
    /**
     * STAGE-C-DM-FRESHNESS-PLAN §Task 4 — DM-only freshness telemetry.
     * Captured for DM dispatches so the dashboard's
     * `dm_freshness_metrics` view can roll up resume rate, snapshot lag,
     * and refetch-hit rate without a separate table. Persisted into
     * `agent_actions.detail` as `{ dm_freshness: {...} }`.
     */
    dmFreshness?: {
      resumed: boolean;
      agentLogLagMinutes: number;
      loudWritesSinceSessionStart: number;
      quietWritesSinceSessionStart: number;
      refetchedToday: boolean;
      triggerMatched: boolean;
    };
    /**
     * docs/design/appendices/pre-pass-fan-out.md §7.1 — fan-out sub-session telemetry.
     * Present only on routine.fetch_window rows emitted by the coordinator.
     *
     * `retriedFromAttempt` is the index of the prior attempt that this row
     * is the retry of (per §7.1 example), or `null` for the first attempt
     * in a sub-session's chain. Strictly derivable as `attempt - 1` when
     * `attempt > 1`; surfaced explicitly so dashboards don't have to do
     * the arithmetic and so the audit feed reads naturally without a
     * cross-row join on attempt index.
     */
    prePass?: {
      parentCorrelationId: string;
      /**
       * §7.3 metric aggregation key — `routine.<name>` matching the
       * parent routine that triggered the fan-out (e.g.
       * `routine.morning_routine`). Carried explicitly so the
       * `/metrics/pre-pass` SQL aggregator can group by routine without
       * a join back to the parent's agent_actions row.
       */
      parentRoutine: string;
      integrationKey: IntegrationKey;
      attempt: number;
      maxAttempts: number;
      retriedFromAttempt: number | null;
      /**
       * §7.3 — this attempt's `FetchReport.status`
       * (`success`/`partial`/`failed`/`skipped`). Surfaced as a
       * top-level field (not derived from `errors.length` or
       * `willRetry`) so the metrics aggregator can compute chain-level
       * counters with one SQL pass and dashboards can render the
       * status axis without re-deriving it from secondary fields.
       */
      status: "success" | "partial" | "failed" | "skipped";
      fetched: number;
      posted: number;
      duplicates: number;
      errors: ReadonlyArray<Record<string, unknown>>;
      willRetry: boolean;
      retryReason: string;
      /**
       * §5 BackendQuotaError mitigation — true when the SDK fell back
       * mid-execute (the actual backend differed from the binding the
       * runner asked for). Operators can grep agent_actions for
       * `fallbackTriggered: true` rows to spot recurring patterns
       * without parsing the daemon log.
       */
      fallbackTriggered?: boolean;
      /**
       * The backend the runner ASKED for (`binding.main.backendId`).
       * Surfaces alongside `fallbackTriggered` so the operator can see
       * what swap occurred without joining additional tables; the
       * actual backend that executed is in the row's `backend` column.
       */
      requestedBackend?: BackendId;
    };
  }): void;
  logSkip(event: Event, reason: string, trigger: "reactive" | "autonomous"): void;
  logError(
    event: Event,
    error: Error,
    trigger: "reactive" | "autonomous",
    context?: {
      durationMs?: number;
      backendId?: BackendId;
      modelId?: string;
      failureKind?: string;
      failureCode?: string;
      /**
       * Pre-pass fan-out failure block. Mirrors the `prePass` payload on
       * `logAction` so `MetricsCollector.collectPrePassMetrics` can see
       * every failure mode (binding-resolve, global-budget-cap,
       * per-integration budget-cap, context-build, agent-execute) without
       * a parallel `result='success'` row. The aggregator filters on
       * `detail.prePass` being a non-null object — independent of
       * `result`, so writing it here is sufficient.
       */
      prePass?: {
        parentCorrelationId: string;
        parentRoutine: string;
        integrationKey: IntegrationKey;
        attempt: number;
        maxAttempts: number;
        retriedFromAttempt: number | null;
        status: "success" | "partial" | "failed" | "skipped";
        fetched: number;
        posted: number;
        duplicates: number;
        errors: ReadonlyArray<Record<string, unknown>>;
        willRetry: boolean;
        retryReason: string;
        fallbackTriggered?: boolean;
        requestedBackend?: BackendId;
      };
    },
  ): void;
  /**
   * Chat-attachments Phase 1 — log an inbound (user→agent) or outbound
   * (agent→user) attachment upload to `agent_actions` so the dashboard
   * events/cost views surface them alongside agent turns.
   */
  logAttachment(params: {
    direction: "inbound" | "outbound";
    attachmentId: string;
    mimeType: string;
    sizeBytes: number;
    provenance: string;
    originalFilename: string;
  }): void;
  /**
   * Messaging bang-commands (`!stop` / `!start` / `!cost` / `!report`) —
   * write an `agent_actions` row with `action_type='bang_command'` so the
   * audit trail covers every owner control message, including paused-decline
   * non-bang DMs. See docs/design/backlog/messaging-bang-commands.md §6.6.
   */
  logBangCommand(event: MessageEvent, detail: BangCommandDetail): void;
  /**
   * morning-routine-optimization.md Phase 6 — pre-insert a sentinel
   * `result='in_progress'` row keyed `(event_id=correlationId,
   * action_type)` BEFORE spawning a session that needs to call
   * `PATCH /api/agent-actions/self` mid-run. The agent's PATCH resolves
   * the in-progress row by `(event_id, action_type, result='in_progress')`
   * and writes structured metadata that daemon-side consumers
   * (`AgentJournalAppender`, anomaly surfacing) read after the session
   * settles. The subsequent `logAction` call UPSERTs the same row to
   * its terminal state, preserving the metadata column.
   *
   * Returns the inserted rowid (`-1` on SQL failure — caller still
   * proceeds; `logAction` falls back to its legacy fresh-INSERT path).
   */
  insertInProgressRow(args: {
    correlationId: string | null;
    actionType: string;
    trigger: "reactive" | "autonomous";
    backend?: string;
    modelId?: string;
  }): number;
}

/**
 * Audit detail for `bang_command` rows. `status` distinguishes:
 *   - `ok`         — recognised + handler ran successfully
 *   - `skipped`    — recognised but no-op (e.g. `!stop` while already paused)
 *   - `unknown`    — bang-prefixed but no matching key (not while paused)
 *   - `invalid_args` — recognised prefix but argument parsing rejected
 *   - `paused_decline` — any DM declined while paused (bang or non-bang)
 *
 * Map to `agent_actions.result` per §6.6 (ok→success, skipped/paused_decline
 * →skipped, unknown→failed).
 */
export interface BangCommandDetail {
  command: string;
  /**
   * `paused_blocked` distinguishes "recognised command refused because the
   * agent is paused" from `paused_decline` ("non-command DM while paused"
   * — generic notice path). The former lets us attribute the user's
   * intent to a specific command in `agent_actions` instead of folding it
   * into the generic decline.
   */
  status:
    | "ok"
    | "skipped"
    | "unknown"
    | "invalid_args"
    | "paused_decline"
    | "paused_blocked";
  [extra: string]: unknown;
}

export type TriggerHourlyCheckSkipReason =
  | "morning_routine_active"
  | "hourly_check_in_progress"
  | "below_threshold"
  | "setup_incomplete"
  | "setup_in_progress"
  | "vault_degraded"
  | "user_paused"
  // The current agent-day's morning_routine has not completed yet
  // (typical cause: Mac slept through the 04:00 cron tick — node-cron
  // does not catch up missed fires across sleep). The gate enqueues a
  // morning_routine wake on detection and skips the hourly tick. The
  // next scheduled tick will see the action row and proceed normally.
  | "morning_routine_pending_for_today"
  // cost-reduction-structural §B — Stage 1 deterministic gate consumed
  // observations silently (no LLM session spawned).
  | "gate_stage0_silent"
  // cost-reduction-structural §B — Stage 2 lite-tier triage decided
  // log_only (gate consumed observations silently after the lite call).
  | "gate_stage2_log_only";

export type SetupMode = "initial" | "update";

/**
 * Unwrap the partial-run context the audit logger needs for a failed
 * event. The dispatcher owns wall-clock timing (caller passes
 * `durationMs`); the rest is recovered from `BackendRouterHandledError`
 * if the throw came through the router. For non-router errors we still
 * record the duration so the dashboard "Duration" column is honest.
 */
export function buildLogErrorContext(
  err: unknown,
  durationMs: number,
): {
  durationMs: number;
  backendId?: BackendId;
  failureKind?: string;
  failureCode?: string;
} {
  if (err instanceof BackendRouterHandledError) {
    const cause = err.cause;
    const failure: { backendId: BackendId; kind?: string; code?: string }
      = cause instanceof BackendQuotaError
        ? {
            backendId: cause.backendId,
            kind: "quota",
            code: cause.originalCode,
          }
        : cause instanceof BackendDecisiveFailure
          ? { backendId: cause.backendId, kind: cause.kind }
          : { backendId: err.mainFailure.backendId };
    return {
      durationMs,
      backendId: failure.backendId,
      ...(failure.kind ? { failureKind: failure.kind } : {}),
      ...(failure.code ? { failureCode: failure.code } : {}),
    };
  }
  if (err instanceof BackendQuotaError) {
    return {
      durationMs,
      backendId: err.backendId,
      failureKind: "quota",
      failureCode: err.originalCode,
    };
  }
  if (err instanceof BackendDecisiveFailure) {
    return {
      durationMs,
      backendId: err.backendId,
      failureKind: err.kind,
    };
  }
  return { durationMs };
}

export interface TriggerHourlyCheckOptions {
  force?: boolean;
  /** Optional model hint — injected as `requestedModel` on the enqueued
   *  routine.hourly_check event so the user can force an Opus run from
   *  /api/agent/run-now without touching process_backend_config. */
  requestedModel?: "sonnet" | "opus";
}

export interface TriggerHourlyCheckResult {
  status: "queued" | "skipped";
  reason?: TriggerHourlyCheckSkipReason;
  pendingCount?: number;
  minObservations: number;
  forced: boolean;
  /**
   * cost-reduction-structural §B — populated whenever the gate ran.
   * Mirrors what was logged to `agent_actions` so the cron caller's
   * metrics path can attribute without a re-read.
   */
  gateStage?: "stage0_silent" | "stage2" | "stage3";
  /** Effective stage actually executed. */
  appliedStage?: "stage0_silent" | "stage2_log_only" | "stage3";
  gateReason?: string;
  /**
   * HOURLY_CHECK_GATE_REDESIGN_PLAN.md §3.5 — true when pre-pass for
   * any non-direct integration failed during `harvestForGate` and the
   * gate force-escalated to `stage3` regardless of the signal verdict.
   * Surfaces in the audit row so dashboards can flag tickets where the
   * Stage 3 run was a cautious escalate vs. a real signal.
   */
  cautiousEscalate?: boolean;
}

/**
 * cost-reduction-structural §B — extract the JSON verdict from a
 * Stage 2 triage response. The contract is strict: a single line
 * matching `{ "action": "log_only" | "escalate", ... }`. Anything else
 * — empty output, prose around the JSON, missing fields, malformed JSON
 * — falls back to `failed` so the caller cautiously escalates rather
 * than silently silencing.
 */
export function parseStage2Verdict(
  output: string,
): "log_only" | "escalate" | "failed" {
  const trimmed = (output ?? "").trim();
  if (!trimmed) return "failed";
  // Tolerate code fences (```json … ```) without making them mandatory.
  const stripped = trimmed
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
  // Find the FIRST balanced JSON object — agents occasionally emit
  // trailing prose after the JSON line.
  const objMatch = stripped.match(/\{[\s\S]*?\}/);
  if (!objMatch) return "failed";
  let parsed: unknown;
  try {
    parsed = JSON.parse(objMatch[0]);
  } catch {
    return "failed";
  }
  // The upstream regex `\{[\s\S]*?\}` constrains the parsed payload to a
  // brace-delimited slice, so `JSON.parse` either throws (caught above) or
  // returns a truthy object — the `!parsed` half of the guard is a defensive
  // null check that cannot fire from the current call sites.
  /* c8 ignore next */
  if (!parsed || typeof parsed !== "object") return "failed";
  const action = (parsed as Record<string, unknown>).action;
  if (action === "log_only" || action === "escalate") return action;
  return "failed";
}

export interface InFlightExecutionInfo {
  kind: "session_chain" | "routine" | "scheduled_task";
  key?: string;
  id?: number;
  taskType?: string;
  detail?: string;
}
