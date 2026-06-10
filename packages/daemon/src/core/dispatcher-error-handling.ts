/**
 * `DispatcherErrorRouter` — owns the dispatcher's failure-path
 * machinery: the shallow retry wrapper around BackendRouter
 * (`executeWithRetry`), the post-throw cleanup + DM/dashboard
 * notification (`handleError`), the quota-error introspection +
 * formatting helpers, and the §4.5 delegated-connector health
 * warning consult/dispatch pair.
 *
 * Extracted from `core/dispatcher.ts` as part of phase D-2 of
 * `docs/design/appendices/file-split-plan.md`. Pattern B (stateful
 * coordinator): the router owns its own logic but borrows live
 * references from the dispatcher for state that must remain
 * observable to the parent class — the `notifiedEvents` Set used to
 * dedup outbound notifications, the `shutdownAwaiters` Set used to
 * shortcut the retry sleep on SIGTERM, plus accessors for the
 * dispatcher's `shutdown` flag and lazily-injected dashboard stream.
 *
 * Dispatcher entry points served:
 *   - `dispatchSafe` calls `executeWithRetry` around backend invokes
 *     and `handleError` on failure;
 *   - `handleMessage` calls the `consult/run` connector-warning pair
 *     before/after recording the user message;
 *   - the §4.5 finalize callbacks (`onRetemplateFinalize` /
 *     `onManagementScanFinalize`) bridge into the ResultProcessor —
 *     the success path uses ResultProcessor directly; the error path
 *     calls through these closures to keep the failure ordering
 *     identical to the pre-split file.
 *
 * Shared-state references held:
 *   - `notifiedEvents: Set<string>` — live reference; `handleError`
 *     deletes the entry as defense-in-depth cleanup when execution
 *     threw before reaching `processResult`.
 *   - `shutdownAwaiters: Set<() => void>` — live reference; the retry
 *     sleep races a 5-min timer against this awaiter set so SIGTERM
 *     resolves the wait promptly.
 *   - `isShutdown: () => boolean` — getter; on shutdown wakeup the
 *     retry loop rethrows instead of looping again.
 *   - `getDashboardStream: () => IDashboardStream | null` — lazy
 *     accessor; the dashboard stream is wired after construction.
 */

import type Database from "better-sqlite3";
import type { Event, MessageEvent, BackendId } from "@aitne/shared";
import { isMessageEvent, isScheduledEvent } from "@aitne/shared";
import type { AgentConfig } from "../config.js";
import {
  BackendDecisiveFailure,
  BackendQuotaError,
} from "./agent-core.js";
import { BackendRouterHandledError } from "./backends/backend-router.js";
import {
  extractFailureSpendInfo,
  recordFailureSpendRow,
} from "./backends/failure-spend.js";
import {
  consultDelegatedConnectorHealth,
  markSignoutWarned,
  renderSignoutDm,
  type DelegatedSignoutWarning,
} from "./delegated-connector-health.js";
import {
  compareLocalDateParts,
  getLocalDateParts,
  localDateTimeToUtcMs,
} from "./dispatcher-date-utils.js";
import type {
  IDashboardStream,
  INotificationManager,
  IMessageRecorder,
} from "./dispatcher-types.js";
import { createLogger } from "../logging.js";

const logger = createLogger("dispatcher-error");

export interface DispatcherErrorRouterDeps {
  db: Database.Database;
  config: AgentConfig;
  notificationMgr: INotificationManager;
  messageRecorder: IMessageRecorder;
  /** Live reference to the dispatcher's notify-dedup set. */
  notifiedEvents: Set<string>;
  /** Live reference to the dispatcher's shutdown-awaiter set. */
  shutdownAwaiters: Set<() => void>;
  /** Lazily-resolved dashboard stream (may be null in tests). */
  getDashboardStream: () => IDashboardStream | null;
  /** Returns the dispatcher's current shutdown flag. */
  isShutdown: () => boolean;
  /**
   * Closure that bridges into `ResultProcessor.finalizeRetemplateRun`.
   * Used by `handleError` so a retemplate run that throws still
   * rolls back / records the right outcome.
   */
  onRetemplateFinalize: (event: Event, opts: { errored: boolean }) => void;
  /**
   * Closure that bridges into `ResultProcessor.finalizeManagementScan`.
   * Used by `handleError` so a management-scan that throws still
   * records `failed` against the right repository row.
   */
  onManagementScanFinalize: (event: Event, opts: { errored: boolean }) => void;
}

export class DispatcherErrorRouter {
  private readonly db: Database.Database;
  private readonly config: AgentConfig;
  private readonly notificationMgr: INotificationManager;
  private readonly messageRecorder: IMessageRecorder;
  private readonly notifiedEvents: Set<string>;
  private readonly shutdownAwaiters: Set<() => void>;
  private readonly getDashboardStream: () => IDashboardStream | null;
  private readonly isShutdown: () => boolean;
  private readonly onRetemplateFinalize: (
    event: Event,
    opts: { errored: boolean },
  ) => void;
  private readonly onManagementScanFinalize: (
    event: Event,
    opts: { errored: boolean },
  ) => void;

  constructor(deps: DispatcherErrorRouterDeps) {
    this.db = deps.db;
    this.config = deps.config;
    this.notificationMgr = deps.notificationMgr;
    this.messageRecorder = deps.messageRecorder;
    this.notifiedEvents = deps.notifiedEvents;
    this.shutdownAwaiters = deps.shutdownAwaiters;
    this.getDashboardStream = deps.getDashboardStream;
    this.isShutdown = deps.isShutdown;
    this.onRetemplateFinalize = deps.onRetemplateFinalize;
    this.onManagementScanFinalize = deps.onManagementScanFinalize;
  }

  isRetryable(error: unknown): boolean {
    // BackendCore implementations wrap all errors into BackendQuotaError or
    // BackendDecisiveFailure before they reach the dispatcher. Both are
    // decisive (no retry). BackendRouterHandledError is also decisive.
    if (
      error instanceof BackendQuotaError ||
      error instanceof BackendDecisiveFailure ||
      error instanceof BackendRouterHandledError
    ) {
      return false;
    }
    // Raw 5xx from an unclassified path — retry once.
    const status = typeof error === "object" && error !== null && "status" in error
      ? (error as { status?: unknown }).status
      : undefined;
    return typeof status === "number" && status >= 500;
  }

  /**
   * Defense-in-depth retry wrapper around BackendRouter.execute().
   *
   * **Primary retry responsibility lives inside each BackendCore** (§12/§13).
   * Quota errors, timeouts, and auth failures are all normalized into
   * BackendDecisiveFailure / BackendQuotaError before they reach this layer.
   * The BackendRouter handles fallback on decisive failures.
   *
   * This outer loop exists solely as a safety net for raw 5xx errors that
   * somehow escape the BackendCore → Router chain (e.g., an unexpected HTTP
   * error from the SDK transport layer). In practice it almost never fires.
   */
  async executeWithRetry<T>(
    fn: () => Promise<T>,
    event: Event,
  ): Promise<T> {
    const maxRetries = 1;
    let lastError: unknown;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error;
        if (attempt < maxRetries && this.isRetryable(error)) {
          logger.warn(
            {
              eventType: event.type,
              attempt: attempt + 1,
              error: error instanceof Error ? error.message : String(error),
            },
            "Retrying agent execution after backoff",
          );
          // Shutdown-aware sleep: race a single 5-minute timer against the
          // shutdown signal so SIGTERM unwinds the retry loop promptly
          // instead of blocking for up to 5 minutes.
          await new Promise<void>((resolve) => {
            const onShutdown = () => {
              clearTimeout(timer);
              this.shutdownAwaiters.delete(onShutdown);
              resolve();
            };
            const timer = setTimeout(() => {
              this.shutdownAwaiters.delete(onShutdown);
              resolve();
            }, 5 * 60 * 1000);
            this.shutdownAwaiters.add(onShutdown);
          });
          if (this.isShutdown()) {
            throw lastError;
          }
          continue;
        }
        break;
      }
    }

    throw lastError;
  }

  async handleError(event: Event, error: Error): Promise<void> {
    logger.error({ event: event.type, error: error.message }, "Event processing error");
    // Cost visibility for failed turns that already billed the provider —
    // post-hoc budget rejections (Codex / Gemini run the turn to
    // completion before the cap can reject; Claude's SDK aborts mid-
    // stream with a partial-usage snapshot stamped by the core) and
    // non-quota terminal errors that carried usage (auth-mid-run,
    // timeout, transport failure). Write a `result='failed'`
    // agent_actions row per distinct backend failure so the dashboard's
    // cost dials reflect reality. Without this the success-only audit
    // path (`logAction` in ResultProcessor) silently drops the spend.
    // PREPASS_COST_REDUCTION_PLAN.md N1.
    //
    // `BackendRouterHandledError` is unwrapped into its per-backend
    // failures (main + fallback can BOTH have billed); a raw failover
    // signal is recorded as-is. Pre-N1 this looked only at the top-level
    // error, so a no-fallback quota kill — which the router wraps —
    // recorded nothing.
    for (const failure of this.collectSpendFailures(error)) {
      const spendInfo = extractFailureSpendInfo(failure);
      if (spendInfo) {
        recordFailureSpendRow(this.db, event, spendInfo, error.message);
      }
    }
    // Defense-in-depth cleanup of the notify-dedup marker — processResult
    // is the primary collection point, but if execution threw before
    // reaching it, drop any orphan entry here so the set cannot grow
    // unbounded across error storms.
    this.notifiedEvents.delete(event.correlationId);
    const routerHandledError = error instanceof BackendRouterHandledError
      ? error
      : null;

    // Mark scheduled task as failed whenever execution terminates
    // without a result. Covers both scheduled.task and scheduled.dm —
    // a scheduled.dm row that throws would otherwise stick in
    // `running` forever.
    if (isScheduledEvent(event) && event.scheduleId) {
      this.db
        .prepare(
          "UPDATE agent_schedule SET status = 'failed' WHERE id = ? AND status = 'running'",
        )
        .run(event.scheduleId);
      this.onRetemplateFinalize(event, { errored: true });
    }
    // Same rationale as the success-path call: management events have no
    // `agent_schedule` row, so this hook is intentionally outside the
    // scheduleId guard.
    this.onManagementScanFinalize(event, { errored: true });

    if (routerHandledError) {
      const quotaError = this.extractQuotaError(routerHandledError.cause);
      if (quotaError && isMessageEvent(event)) {
        this.notifyDashboardError(event, this.formatQuotaMessage(quotaError));
      }
      return;
    }

    const quotaError = this.extractQuotaError(error);
    if (quotaError && isMessageEvent(event)) {
      const quotaMsg = this.formatQuotaMessage(quotaError);
      this.notifyDashboardError(event, quotaMsg);
      await this.notificationMgr.send(quotaMsg, event);
      return;
    }

    if (isMessageEvent(event)) {
      const errorMsg = "An error occurred during processing. Please try again.";
      this.notifyDashboardError(event, errorMsg);
      await this.notificationMgr.send(errorMsg, event);
    }
  }

  /**
   * Best-effort inline error to the dashboard tab whose POST triggered
   * this event. `DashboardAdapter` is `notificationEligible=false`, so
   * the normal `notificationMgr.send` path skips it — without this hook
   * the browser sees the request accepted (200 OK), watches nothing
   * happen, and hits the 120s waiting timeout with no explanation. We
   * target the originating channel id; if the tab already reconnected
   * with a new UUID the adapter silently drops, which matches the
   * chat_error semantics.
   */
  notifyDashboardError(event: Event, message: string): void {
    if (!isMessageEvent(event)) return;
    if (event.platform !== "dashboard") return;
    this.getDashboardStream()?.sendError?.(event.channel, message);
  }

  /**
   * The distinct per-backend failures hiding behind a thrown error.
   * `BackendRouterHandledError` carries up to two (main + fallback —
   * both may have billed before failing); any other error is its own
   * single entry. Identity-deduped because `cause` usually aliases one
   * of `mainFailure` / `fallbackFailure`.
   */
  private collectSpendFailures(error: unknown): unknown[] {
    if (error instanceof BackendRouterHandledError) {
      const failures: unknown[] = [error.mainFailure];
      if (error.fallbackFailure && error.fallbackFailure !== error.mainFailure) {
        failures.push(error.fallbackFailure);
      }
      if (error.cause && !failures.includes(error.cause)) {
        failures.push(error.cause);
      }
      return failures;
    }
    return [error];
  }

  extractQuotaError(error: unknown): BackendQuotaError | null {
    if (error instanceof BackendQuotaError) {
      return error;
    }
    if (
      error instanceof BackendDecisiveFailure &&
      error.kind === "quota" &&
      error.cause instanceof BackendQuotaError
    ) {
      return error.cause;
    }
    // All BackendCore implementations normalize quota errors before they
    // reach the dispatcher, so no Claude-specific fallback is needed here.
    return null;
  }

  formatQuotaMessage(quotaError: BackendQuotaError): string {
    const backendLabel = this.formatBackendLabel(quotaError.backendId);
    const resetHint = quotaError.resetHint;

    if (quotaError.originalCode === "max_budget_usd") {
      return `${backendLabel} reached the per-turn budget limit. Please try a shorter request or raise max_budget_usd in backend settings.`;
    }

    if (resetHint) {
      const timeZone = resetHint.timeZone || this.config.timezone || undefined;
      const resetAtMs = this.resolveQuotaResetAtMs(resetHint);

      if (resetAtMs !== null) {
        const formatted = new Intl.DateTimeFormat("en-US", {
          timeZone,
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
          hourCycle: "h12",
        }).format(new Date(resetAtMs));
        const zoneLabel = timeZone ? ` (${timeZone})` : "";
        return `${backendLabel} has reached its usage limit. Resets at ${formatted}${zoneLabel}. Please try again after the reset.`;
      }
      try {
        new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date());
      } catch {
        // Fall through to rawLabel/generic message if the timezone label is invalid.
      }

      const rawLabel = resetHint.rawLabel.trim();
      if (rawLabel) {
        return `${backendLabel} has reached its usage limit. Resets at ${rawLabel}. Please try again after the reset.`;
      }
    }

    return `${backendLabel} has reached its usage limit. Please wait and try again later.`;
  }

  formatBackendLabel(backendId: BackendQuotaError["backendId"]): string {
    switch (backendId) {
      case "claude":
        return "Claude Code";
      case "codex":
        return "Codex";
      case "gemini":
        return "Gemini CLI";
      case "opencode":
        return "OpenCode";
      default:
        return backendId;
    }
  }

  resolveQuotaResetAtMs(
    resetHint: { hour: number; minute: number; timeZone?: string },
  ): number | null {
    const timeZone = resetHint.timeZone || this.config.timezone || undefined;
    const now = new Date();
    const current = getLocalDateParts(now, timeZone);
    let target = {
      year: current.year,
      month: current.month,
      day: current.day,
      hour: resetHint.hour,
      minute: resetHint.minute,
    };

    if (compareLocalDateParts(current, target) >= 0) {
      const nextDate = new Date(Date.UTC(current.year, current.month - 1, current.day + 1));
      target = {
        year: nextDate.getUTCFullYear(),
        month: nextDate.getUTCMonth() + 1,
        day: nextDate.getUTCDate(),
        hour: resetHint.hour,
        minute: resetHint.minute,
      };
    }

    return localDateTimeToUtcMs(target, timeZone);
  }

  /**
   * DELEGATED-MODE-V2-DESIGN.md §4.5 — at every DM dispatch, consult the
   * cached probe for delegated integrations whose effective backend
   * matches the session backend. Surfaces a one-shot DM (deduped via
   * `runtime_state`) when the cached probe says required capabilities
   * are no longer present.
   *
   * The consult itself is synchronous DB-only work (cheap on the hot
   * path). The DM dispatch is fire-and-forget so the agent's response
   * latency is not gated on Slack/Telegram round-trips. Per-warning
   * dispatch failures are swallowed so a flaky messaging adapter never
   * breaks the user's actual DM.
   *
   * Phase 1 of the §4.5 health check — synchronous cache consult only.
   * Returns the warnings the dispatcher must surface this turn (or `[]`
   * when nothing is broken / setup mode is active / the consult itself
   * threw). Recovery markers are cleared inline by the consult helper, so
   * the caller does not have to track them.
   *
   * Split from the dispatch step so the actual DM (and its messages-table
   * persist) fires AFTER the dispatcher has recorded the inbound user
   * message — otherwise the warning row's `CURRENT_TIMESTAMP` lands before
   * the user-message row's, which makes `chat_meta` history reload reorder
   * the bubbles (warning above user) and a one-time visual flicker leaks
   * to the user. See `runDelegatedConnectorWarningDispatch` below.
   */
  consultDelegatedConnectorWarnings(
    sessionBackend: BackendId,
  ): readonly DelegatedSignoutWarning[] {
    try {
      const result = consultDelegatedConnectorHealth(this.db, sessionBackend);
      if (result.recovered.length > 0) {
        logger.info(
          { recovered: result.recovered, sessionBackend },
          "Delegated connector(s) recovered — sign-out warning markers cleared",
        );
      }
      return result.warnings;
    } catch (err) {
      logger.warn(
        { err, sessionBackend },
        "Delegated connector-health consult failed — skipping DM warning",
      );
      return [];
    }
  }

  /**
   * Phase 2 of the §4.5 health check — asynchronous DM dispatch + post-
   * delivery bookkeeping (throttle marker + dashboard-channel persist).
   * Caller invokes this AFTER the user message is recorded so the DM's
   * messages-table row carries a strictly-later `CURRENT_TIMESTAMP`
   * (preserves pre-reconcile chat order on the dashboard).
   */
  runDelegatedConnectorWarningDispatch(
    warnings: readonly DelegatedSignoutWarning[],
    event: MessageEvent,
    sessionBackend: BackendId,
    sessionId: number,
  ): void {
    for (const warning of warnings) {
      logger.warn(
        {
          integration: warning.integration,
          backend: warning.backend,
          missingRequired: warning.missingRequired,
        },
        "Delegated connector reports missing required capabilities — DM owner",
      );
      const message = renderSignoutDm(warning);
      // Mark the throttle ONLY after a successful dispatch — if the
      // messaging adapter is down, an absent marker keeps the next
      // consult ready to re-issue the warning. The .send() promise
      // resolves on adapter-acknowledged delivery; .catch() is the
      // failure side, which deliberately leaves the marker unset.
      //
      // After delivery, persist the warning to `messages` so it survives
      // dashboard chat reload + the chat_meta history-reconcile pass
      // (`reconcileLiveMessagesAfterHistoryReload` drops live bubbles whose
      // timestamp is before the sync started AND whose signature is not in
      // the restored history; without this persist the DM bubble vanishes
      // the moment the agent's reply chat_meta arrives). For non-dashboard
      // platforms (Slack/Telegram) the message-store is the platform itself,
      // so we deliberately persist only when `event.platform === "dashboard"`
      // to avoid duplicating remote-platform messages locally.
      void this.notificationMgr
        .send(message, event, {
          priority: "high",
          category: "delegated_signout",
        })
        .then(() => {
          try {
            markSignoutWarned(this.db, warning);
          } catch (err) {
            logger.warn(
              {
                err,
                integration: warning.integration,
                backend: warning.backend,
              },
              "Failed to persist delegated-signout marker — next consult may re-warn",
            );
          }
          if (event.platform === "dashboard") {
            try {
              this.messageRecorder.recordMessage({
                sessionId,
                role: "assistant",
                content: message,
                platform: event.platform,
                backend: sessionBackend,
              });
            } catch (err) {
              logger.warn(
                {
                  err,
                  integration: warning.integration,
                  backend: warning.backend,
                  sessionId,
                },
                "Failed to persist delegated-signout DM into messages — bubble may vanish on chat reload",
              );
            }
          }
        })
        .catch((err) => {
          logger.error(
            { err, integration: warning.integration, backend: warning.backend },
            "Failed to deliver delegated-signout DM — marker not set, will retry next dispatch",
          );
        });
    }
  }
}
