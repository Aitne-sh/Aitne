/**
 * `ResultProcessor` — closes out the dispatch lifecycle on the success
 * side: forwards the agent's final output to the notification manager
 * (when applicable), writes the audit log row, finalizes the
 * agent_schedule + repository_management bookkeeping, and exposes the
 * cross-session conversation history + proactive-forward heuristics
 * the message handler consults.
 *
 * Extracted from `core/dispatcher.ts` as part of phase D-2 of
 * `docs/design/appendices/file-split-plan.md`. Pattern B (stateful
 * coordinator): the processor holds no mutable state of its own; it
 * borrows the dispatcher's `notifiedEvents` Set as a live reference
 * (the post-success consume site) and reads dispatcher-state via a
 * minimal isReactive callback so the cost-cap / autonomous-trigger
 * classification stays single-sourced.
 *
 * Dispatcher entry points served:
 *   - the message handler / routine handler / scheduled-task handler
 *     all call `processResult` once the backend run terminates;
 *   - `handleError` (now on `DispatcherErrorRouter`) bridges back into
 *     `finalizeRetemplateRun` / `finalizeManagementScan` via the
 *     `onRetemplateFinalize` / `onManagementScanFinalize` callbacks
 *     wired from `EventDispatcher` so the failure path lands the same
 *     bookkeeping rows as the success path;
 *   - the message handler reads
 *     `hasRecentProactiveForwardContext` /
 *     `buildCrossSessionConversationHistory` /
 *     `formatSummaryRole` for cross-surface DM continuity, and calls
 *     `logProactiveForwardDisavowalIfMatched` after the assistant
 *     reply lands.
 *
 * Shared-state references held:
 *   - `notifiedEvents: Set<string>` — live reference; `processResult`
 *     consumes the entry the agent's `/api/notify` call deposited so
 *     the dispatcher doesn't double-DM with the closing assistant
 *     turn.
 *   - `isReactive: (event) => boolean` — getter; mirrors the
 *     dispatcher's classification so audit-log `trigger` and observer
 *     logs stay consistent.
 */

import type Database from "better-sqlite3";
import type { Event, MessageEvent, AgentResult, BackendId } from "@aitne/shared";
import {
  isAgentTaskEvent,
  isDocsQAMessage,
  isMessageEvent,
  isRoutineEvent,
  isScheduledEvent,
  formatSqliteDatetime,
} from "@aitne/shared";
import type { AgentConfig } from "../config.js";
import { getContextDir } from "../config.js";
import { finalizeRetemplate } from "./template-store.js";
import {
  recordManagementInitDone,
  recordManagementScan,
} from "../db/repositories-store.js";
import {
  formatForwardSuffix,
  getProactiveForwardType,
  isProactiveForwardMetadata,
  parseMessageMetadata,
  recordProactiveForwardDeliveries,
} from "./channel-timeline.js";
import { randomUUID } from "node:crypto";
import {
  OWNER_DM_SCOPE,
  OWNER_SCOPE_KEY,
  DASHBOARD_CHAT_SCOPE,
  DASHBOARD_SCOPE_KEY,
  getConversationScope,
} from "../messaging/constants.js";
import { readEventReplyTarget } from "./wiki/dispatcher.js";
import type {
  IAuditLogger,
  INotificationManager,
  ISessionManager,
  MessageReplyTarget,
} from "./dispatcher-types.js";
import { createLogger } from "../logging.js";

const logger = createLogger("dispatcher-result");

/**
 * English-only patterns by CLAUDE.md convention. The disavowal tripwire
 * is a numerator over a `disavowed / injected` ratio (dm-channel-timeline.md
 * §C.1) — false negatives are tolerated; non-English replies that happen to
 * disavow will simply not contribute to the numerator. Operators monitor the
 * ratio and flip `proactiveForwardForceFreshSession` on rise; that fallback
 * path is language-agnostic.
 */
export const PROACTIVE_FORWARD_DISAVOWAL_PATTERNS: RegExp[] = [
  /\b(?:don't|do not) (?:recall|remember)\b/i,
  /\bI (?:didn't|did not) (?:say|send|mention)\b/i,
  /\breferenc(?:ing|e) what\b/i,
  /\bwhat did .* (?:say|mean|refer)\b/i,
];

export interface ResultProcessorDeps {
  db: Database.Database;
  config: AgentConfig;
  audit: IAuditLogger;
  notificationMgr: INotificationManager;
  sessionMgr: ISessionManager;
  /** Live reference to the dispatcher's notify-dedup set. */
  notifiedEvents: Set<string>;
  /** Mirrors `EventDispatcher.isReactive` for audit-trigger classification. */
  isReactive: (event: Event) => boolean;
  /**
   * Whether the messages table has the `backend` and `model_id`
   * columns. Computed once at dispatcher startup; the cross-session
   * history builder branches on it to keep ancient deployments
   * upgradable.
   */
  hasMessageBackendMetadataColumns: boolean;
}

export class ResultProcessor {
  private readonly db: Database.Database;
  private readonly config: AgentConfig;
  private readonly audit: IAuditLogger;
  private readonly notificationMgr: INotificationManager;
  private readonly sessionMgr: ISessionManager;
  private readonly notifiedEvents: Set<string>;
  private readonly isReactive: (event: Event) => boolean;
  private readonly hasMessageBackendMetadataColumns: boolean;

  constructor(deps: ResultProcessorDeps) {
    this.db = deps.db;
    this.config = deps.config;
    this.audit = deps.audit;
    this.notificationMgr = deps.notificationMgr;
    this.sessionMgr = deps.sessionMgr;
    this.notifiedEvents = deps.notifiedEvents;
    this.isReactive = deps.isReactive;
    this.hasMessageBackendMetadataColumns = deps.hasMessageBackendMetadataColumns;
  }

  async processResult(
    result: AgentResult,
    event: Event,
    skipNotify = false,
    options: {
      originSessionId?: number;
      dmFreshness?: {
        resumed: boolean;
        agentLogLagMinutes: number;
        loudWritesSinceSessionStart: number;
        quietWritesSinceSessionStart: number;
        refetchedToday: boolean;
        triggerMatched: boolean;
      };
    } = {},
  ): Promise<void> {
    // Notify-dedup: consume the marker (if present) so this method also
    // serves as the cleanup point — every event run reaches processResult
    // exactly once on the success path, and on the error path the entry
    // is harmless (next event gets a fresh UUID).
    const alreadyNotified = this.notifiedEvents.delete(event.correlationId);
    // WIKI_BUILDER_DESIGN.md §3.4 — wiki.ingest_url defines success as a
    // 200 receipt from `POST /api/wiki/<workspace>/files/10_raw/<slug>.md`.
    // Sonnet 4.6 has been observed claiming success in the final assistant
    // text while never actually calling the Wiki API (e.g. inventing routes
    // like `/api/send-message`). Verify the agent's claim against the
    // authoritative DB record before forwarding the DM; if no write
    // happened, rewrite the message into a failure DM so the operator does
    // not get a misleading "ingested" notification.
    const output = this.verifyWikiIngestWriteOrRewrite(
      result.output.trim(),
      event,
      result,
    );
    if (
      !skipNotify
      && !alreadyNotified
      && output.length > 0
      && this.shouldNotify(event)
    ) {
      // WIKI_BUILDER_DESIGN.md §3.4-bis — non-message events that were
      // spawned from a bang command carry the originating MessageEvent's
      // routing tuple in `data.reply_target`. Pull it out so the
      // completion DM lands on the same channel the operator typed the
      // bang on rather than the proactive "primary messaging app"
      // destinations.
      //
      // The check is gated to **non-message** events deliberately:
      //   - MessageEvents (`message.*`) have routing at the top level
      //     (`event.platform/channel/threadId`) and `NotificationManager`
      //     already self-routes them via `deliverReply`. Honouring a
      //     `data.reply_target` on a MessageEvent would conflict with
      //     that self-route.
      //   - `wiki.*` events from bang commands → reply_target populated
      //     by `createWikiCommandEvent` (§3.4).
      //   - `scheduled.task` events from approval rows → reply_target
      //     populated by `scheduler.ts` lifting `taskContext.replyTarget`
      //     into `event.data` (covers the `!compile full` above-threshold
      //     path that lands as `scheduled.task` with wiki.compile
      //     process key).
      //   - Cron/observer/routine events → no reply_target → fall through
      //     to the proactive path so quiet hours + configured-destinations
      //     semantics apply.
      const explicitReply = isMessageEvent(event) ? null : readEventReplyTarget(event);
      const sendOptions: {
        originSessionId?: number;
        replyTo?: MessageReplyTarget;
      } = {};
      if (options.originSessionId !== undefined) {
        sendOptions.originSessionId = options.originSessionId;
      }
      if (explicitReply) {
        sendOptions.replyTo = {
          platform: explicitReply.platform,
          channel: explicitReply.channel,
          threadId: explicitReply.threadId ?? null,
        };
      }
      if (Object.keys(sendOptions).length === 0) {
        await this.notificationMgr.send(output, event);
      } else {
        await this.notificationMgr.send(output, event, sendOptions);
      }
      // BROWSER_HISTORY_INTEGRATION_PLAN §10.5 (seventh-pass) —
      // conversation-injection invariant. Outbound DMs from routine
      // sessions with a `reply_target` must land in the owner DM
      // scope's `conversation_sessions` so the standard `message.dm`
      // agent sees them in `<recent_dm_conversation>` on the user's
      // reply turn. Without this, the natural-language acceptance
      // flow (user replies "research please" to an offer DM) is
      // structurally broken — the DM agent has no record of what
      // offer was sent.
      //
      // Mirrors `scheduler.ts:handleDirectDm` which records
      // `scheduled.dm` outputs the same way. `notificationMgr.send`
      // by itself writes to `notification_log` (telemetry) only,
      // not to `messages` (conversation history) — this call closes
      // the gap. Best-effort: a recording failure must not break
      // the send itself, so wrap in try/catch.
      if (explicitReply && output.length > 0) {
        try {
          recordProactiveForwardDeliveries({
            db: this.db,
            config: this.config,
            deliveries: [
              {
                platform: explicitReply.platform,
                channel: explicitReply.channel,
              },
            ],
            content: output,
            dispatchId: randomUUID(),
            ...(options.originSessionId !== undefined
              ? { originSessionIds: [options.originSessionId] }
              : {}),
            notificationType: "proactive_forward",
          });
        } catch (err) {
          logger.warn(
            { err, eventType: event.type },
            "Failed to record outbound DM into channel timeline; "
              + "next message.dm session will not see this DM in "
              + "conversation_history. Send itself succeeded.",
          );
        }
      }
    }
    this.audit.logAction({
      event,
      model: result.model,
      costUsd: result.costUsd,
      usage: result.usage,
      modelUsage: result.modelUsage,
      durationMs: result.durationMs,
      numTurns: result.numTurns,
      trigger: this.isReactive(event) ? "reactive" : "autonomous",
      backend: result.backendId,
      costSource: result.costSource,
      contextUpdated: result.contextUpdated,
      advisorCallCount: result.advisorCallCount,
      ...(options.dmFreshness ? { dmFreshness: options.dmFreshness } : {}),
    });
    // Observer-event observability: log whether an external-change
    // event actually produced a context-file update. Makes it obvious
    // from the logs when the pipeline ran but the agent decided the
    // change wasn't actionable. Covers every autonomous observer:
    //  - calendar.* / schedule.approaching (calendar observer)
    //  - github.*        (GitHub poller high-priority events)
    //  - git.*           (git watcher batched events)
    //  - notion.*        (notion poller)
    //  - routine.hourly_check (Phase-9 polling sink for obsidian/git/notion)
    if (this.isObserverEvent(event)) {
      logger.info(
        {
          eventType: event.type,
          source: event.source,
          contextUpdated: result.contextUpdated,
          numTurns: result.numTurns,
          costUsd: result.costUsd,
        },
        result.contextUpdated
          ? "Observer event processed — context files updated"
          : "Observer event processed — no context updates",
      );
    }
    // Mark scheduled task as completed or failed (covers both
    // scheduled.task and scheduled.dm — both share the agent_schedule
    // row lifecycle).
    if (isScheduledEvent(event) && event.scheduleId) {
      const newStatus = result.isError ? "failed" : "completed";
      this.db
        .prepare(
          "UPDATE agent_schedule SET status = ? WHERE id = ? AND status = 'running'",
        )
        .run(newStatus, event.scheduleId);
      this.finalizeRetemplateRunIfApplicable(event, { errored: result.isError });
    }
    // Repository-management events from the daily cron and the manual
    // /api/repositories/:id/management/{init,scan} routes are
    // `scheduled.task` events emitted directly to the EventBus (no
    // `agent_schedule` row), so the finalize hook lives outside the
    // `scheduleId` guard above. The finalizer is a no-op for any event
    // whose taskContext doesn't match the management ProcessKey set.
    this.finalizeManagementScanIfApplicable(event, { errored: result.isError });
  }

  /**
   * P6 (git-lifecycle-and-triggers.md Decision 8) — restore in-flight
   * `git.project.retemplate` targets from backup whenever a retemplate
   * scheduled task settles. The agent itself cannot reliably roll back
   * its own writes (process exit, exceeded turns, backend faults), so
   * the daemon owns rollback at the dispatcher's two terminal sites
   * (`processResult` + `handleError`). The status grid is the source of
   * truth for which files to restore; `finalizeRetemplate` is idempotent
   * via the `finalizedAt` marker so calling both paths is safe.
   */
  finalizeRetemplateRunIfApplicable(
    event: Event,
    options: { errored: boolean },
  ): void {
    if (!isAgentTaskEvent(event) || !event.scheduleId) return;
    const taskCtx = event.taskContext;
    const processKey =
      taskCtx
      && typeof taskCtx === "object"
      && typeof (taskCtx as { processKey?: unknown }).processKey === "string"
        ? (taskCtx as { processKey: string }).processKey
        : null;
    if (processKey !== "git.project.retemplate") return;
    try {
      const result = finalizeRetemplate({
        db: this.db,
        contextDir: getContextDir(this.config, this.db),
        scheduleId: event.scheduleId,
        errored: options.errored,
      });
      if (result.applied && result.rolledBackSlugs.length > 0) {
        logger.info(
          {
            scheduleId: event.scheduleId,
            rolledBack: result.rolledBackSlugs,
            finalStatus: result.finalStatus,
          },
          "Re-template run finalized — rolled back in-flight files from backup",
        );
      }
    } catch (err) {
      logger.error(
        { err, scheduleId: event.scheduleId },
        "Failed to finalize re-template run",
      );
    }
  }

  /**
   * Unified-repositories §4.5 — settle a `repository_management` row when
   * a `git.project.init` / `git.project.update` event the daemon emitted
   * for management terminates. Runs unconditionally on every event
   * because management events live on the EventBus only (no
   * `agent_schedule` row), so the scheduleId-guarded path can't see
   * them; the method early-returns for any taskContext that doesn't
   * carry management metadata.
   *
   * Status mapping (v1):
   *   - `git.project.init` success → `recordManagementInitDone`
   *   - `git.project.update` success → `recordManagementScan('ok')`
   *     (resets `scan_failure_count`)
   *   - either, error → `recordManagementScan('failed')`
   *     (bumps `scan_failure_count`)
   *
   * `'skipped_no_activity'` is reserved for future task-flow callback —
   * the dispatcher cannot reliably distinguish "agent decided no
   * journal entry needed" from "agent succeeded but didn't write" here.
   */
  finalizeManagementScanIfApplicable(
    event: Event,
    options: { errored: boolean },
  ): void {
    if (!isAgentTaskEvent(event)) return;
    const taskCtx = event.taskContext;
    if (!taskCtx || typeof taskCtx !== "object") return;
    const ctx = taskCtx as {
      processKey?: unknown;
      repositoryId?: unknown;
      triggerSource?: unknown;
    };
    const processKey =
      typeof ctx.processKey === "string" ? ctx.processKey : null;
    const repositoryId =
      typeof ctx.repositoryId === "string" ? ctx.repositoryId : null;
    const triggerSource =
      typeof ctx.triggerSource === "string" ? ctx.triggerSource : null;
    if (!processKey || !repositoryId || !triggerSource) return;
    // Only management-emitted events should mutate `repository_management`.
    // Trigger-fired sessions (`triggerSource === 'repository_trigger'`)
    // share `processKey` in some cases but must not flip the management
    // row — they have their own observability (`fire_count`).
    if (
      triggerSource !== "repository_management_cron"
      && triggerSource !== "repository_management_manual"
    ) {
      return;
    }
    try {
      if (processKey === "git.project.init") {
        if (!options.errored) {
          recordManagementInitDone(this.db, repositoryId);
        } else {
          recordManagementScan(this.db, repositoryId, "failed");
        }
      } else if (processKey === "git.project.update") {
        recordManagementScan(
          this.db,
          repositoryId,
          options.errored ? "failed" : "ok",
        );
      }
    } catch (err) {
      logger.error(
        { err, repositoryId, processKey, errored: options.errored },
        "Failed to finalize repository management state",
      );
    }
  }

  hasRecentProactiveForwardContext(
    event: MessageEvent,
    sessionId: number,
  ): boolean {
    if (!event.isDm || isDocsQAMessage(event)) return false;

    const activeRows = this.db
      .prepare(
        `SELECT metadata
           FROM messages
          WHERE session_id = ?
          ORDER BY timestamp DESC, id DESC
          LIMIT ?`,
      )
      .all(sessionId, this.config.historyInjectionMaxMessages ?? 20) as Array<{
      metadata: string | null;
    }>;
    if (activeRows.some((row) => isProactiveForwardMetadata(parseMessageMetadata(row.metadata)))) {
      return true;
    }

    const windowMinutes = this.config.historyOtherSurfaceWindowMinutes ?? 1440;
    if (!Number.isFinite(windowMinutes) || windowMinutes <= 0) return false;

    const { scope } = getConversationScope({
      platform: event.platform,
      channel: event.channel,
      threadId: event.threadId,
      isDm: true,
      intent: event.intent,
    });
    const other =
      scope === OWNER_DM_SCOPE
        ? { scope: DASHBOARD_CHAT_SCOPE, scopeKey: DASHBOARD_SCOPE_KEY }
        : scope === DASHBOARD_CHAT_SCOPE
          ? { scope: OWNER_DM_SCOPE, scopeKey: OWNER_SCOPE_KEY }
          : null;
    if (!other) return false;

    const sinceUtc = formatSqliteDatetime(
      new Date(Date.now() - windowMinutes * 60_000),
    );
    const otherRows = this.db
      .prepare(
        `SELECT m.metadata
           FROM messages m
           JOIN conversation_sessions s ON m.session_id = s.id
          WHERE s.scope = ?
            AND s.scope_key = ?
            AND s.status = 'active'
            AND m.timestamp >= ?
          ORDER BY m.timestamp DESC, m.id DESC
          LIMIT 60`,
      )
      .all(other.scope, other.scopeKey, sinceUtc) as Array<{
      metadata: string | null;
    }>;
    return otherRows.some((row) =>
      isProactiveForwardMetadata(parseMessageMetadata(row.metadata)),
    );
  }

  logProactiveForwardDisavowalIfMatched(
    sessionId: number,
    reply: string,
  ): void {
    const matchedPattern = PROACTIVE_FORWARD_DISAVOWAL_PATTERNS.find((pattern) =>
      pattern.test(reply),
    );
    if (!matchedPattern) return;

    try {
      this.db
        .prepare(
          `INSERT INTO agent_actions (
             action_type, trigger, result, detail, started_at
           )
           VALUES (
             'proactive_forward_disavowed',
             'reactive',
             'success',
             ?,
             CURRENT_TIMESTAMP
           )`,
        )
        .run(
          JSON.stringify({
            sessionId,
            replyExcerpt: reply.slice(0, 240),
            matchedPattern: matchedPattern.source,
          }),
        );
    } catch (err) {
      logger.warn({ err, sessionId }, "Failed to log proactive forward disavowal");
    }
  }

  formatSummaryRole(message: {
    role: string;
    metadata?: string | null;
  }): string {
    if (message.role !== "assistant") return message.role;
    const metadata = parseMessageMetadata(message.metadata);
    const type = getProactiveForwardType(metadata);
    if (type === "scheduled_dm") {
      return "assistant (scheduled DM dispatched)";
    }
    if (type !== null) {
      return "assistant (forwarded from autonomous run)";
    }
    return message.role;
  }

  buildCrossSessionConversationHistory(event: MessageEvent): string | null {
    const { scope, scopeKey } = getConversationScope({
      platform: event.platform,
      channel: event.channel,
      threadId: event.threadId,
      isDm: event.isDm,
      intent: event.intent,
    });
    const summary = event.isDm && scope === OWNER_DM_SCOPE
      ? this.sessionMgr.getPreviousDmSummary(OWNER_SCOPE_KEY)
      : null;
    const statement = this.hasMessageBackendMetadataColumns
      ? this.db.prepare(
          `SELECT m.role, m.content, m.timestamp, m.metadata, m.backend, m.model_id
           FROM messages m
           JOIN conversation_sessions s ON m.session_id = s.id
           WHERE s.scope = ? AND s.scope_key = ?
           ORDER BY m.timestamp DESC, m.id DESC
           LIMIT 20`,
        )
      : this.db.prepare(
          `SELECT m.role, m.content, m.timestamp, m.metadata,
                  NULL AS backend,
                  NULL AS model_id
           FROM messages m
           JOIN conversation_sessions s ON m.session_id = s.id
           WHERE s.scope = ? AND s.scope_key = ?
           ORDER BY m.timestamp DESC, m.id DESC
           LIMIT 20`,
        );
    const rows = statement
      .all(scope, scopeKey) as {
        role: "user" | "assistant" | "system";
        content: string;
        timestamp: string;
        metadata: string | null;
        backend: BackendId | null;
        model_id: string | null;
      }[];

    if (!summary && rows.length === 0) {
      return null;
    }

    const parts = ["## Previous conversation in this thread"];
    if (summary) {
      parts.push("", "### Earlier summary", summary);
    }
    if (rows.length > 0) {
      parts.push("", "### Recent messages (oldest first)");
      for (const row of rows.reverse()) {
        const tag = row.backend
          ? `[${row.role}/${row.backend}:${row.model_id ?? "?"}]`
          : `[${row.role}/user]`;
        const forwardSuffix =
          row.role === "assistant"
            ? formatForwardSuffix(parseMessageMetadata(row.metadata))
            : "";
        parts.push(`${tag}${forwardSuffix}: ${row.content}`);
      }
    }
    return parts.join("\n");
  }

  shouldNotify(event: Event): boolean {
    if (isMessageEvent(event)) return true;
    if (isScheduledEvent(event)) {
      // Dashboard-triggered tasks (e.g. regenerate) already show status
      // in the UI — suppress DM notification to avoid noisy messages.
      // Both scheduled.task and scheduled.dm share this gate; the
      // briefing path's final assistant turn IS the DM.
      const ctx = event.taskContext as Record<string, unknown> | undefined;
      if (ctx?.triggeredBy === "dashboard") return false;
      return true;
    }
    // WIKI_BUILDER_DESIGN.md §3.4 — wiki.* sessions self-report on
    // completion. Each `wiki.ingest_url` / `wiki.compile` / `wiki.ask`
    // / `wiki.lint` / `wiki.trace` / `wiki.connect` session forwards
    // its closing assistant turn to the user. Replies route back to
    // the originating channel via the §3.4 `reply_target` payload
    // when the event was spawned from a bang command; otherwise they
    // fall through to the proactive path (configured destinations).
    // No batch aggregation — N URLs ingested = N completion DMs, the
    // operator can correlate by URL in each line.
    if (event.type.startsWith("wiki.")) return true;
    // Routine events are silent-by-default: result.output is an internal
    // agent log, never forwarded as a user notification. Routines reach
    // the user only via explicit POST /api/notify from their prompt. Do
    // not re-add routines here — the routine_protocol header injected by
    // the context-builder carries this rule to the agent.
    return false;
  }

  /**
   * Autonomous "observer" events: external-change detections that the
   * daemon pushes into the pipeline, as opposed to user-initiated
   * messages, cron routines, or scheduled tasks. Used for the
   * contextUpdated observability log in processResult.
   */
  isObserverEvent(event: Event): boolean {
    return (
      (isRoutineEvent(event) && event.routine === "hourly_check") ||
      event.type.startsWith("calendar.") ||
      event.type === "schedule.approaching" ||
      event.type.startsWith("notion.") ||
      event.type.startsWith("github.") ||
      event.type.startsWith("git.")
    );
  }

  /**
   * Confirm that a `wiki.ingest_url` session actually wrote a raw note via
   * the Wiki API before letting the agent's claimed success DM reach the
   * channel. The Wiki API's POST route writes an `agent_actions` row with
   * `(action_type='wiki.ingest_url', source_kind='wiki', source_ref=<workspace>,
   * result='success')` — checking for that row in the session's time window
   * is the cheapest authoritative cross-check.
   *
   * Returns `output` unchanged for any other event type, when no workspace
   * is present on the event, or when at least one matching write row is
   * found. Otherwise emits a warning log and returns a one-line failure DM
   * the dispatcher will forward in place of the agent's misleading text.
   *
   * Time window: `[now − result.durationMs − 5s, now]`. The 5-second
   * buffer absorbs clock skew between the daemon process's wall clock and
   * SQLite's `CURRENT_TIMESTAMP`. The `source_ref=<workspace>` filter
   * prevents picking up a row from a concurrent run targeting a different
   * workspace; concurrent runs on the SAME workspace would overlap and
   * either could attribute to the other, but the Wiki API serializes raw
   * writes per-slug (create-only 409 on collision) so the practical risk
   * is bounded.
   */
  private verifyWikiIngestWriteOrRewrite(
    output: string,
    event: Event,
    result: AgentResult,
  ): string {
    if (event.type !== "wiki.ingest_url") return output;
    const data = (event.data ?? {}) as { workspace?: unknown; url?: unknown };
    const workspace = typeof data.workspace === "string" ? data.workspace : null;
    if (!workspace) return output;
    const url = typeof data.url === "string" ? data.url : null;
    const bufferMs = 5_000;
    const windowStartMs = Date.now() - (result.durationMs ?? 0) - bufferMs;
    // SQLite stores `datetime('now')` as `YYYY-MM-DD HH:MM:SS` (UTC).
    // Match that shape so the lexicographic compare is well-defined.
    const windowStart = new Date(windowStartMs)
      .toISOString()
      .replace("T", " ")
      .slice(0, 19);
    let wroteRowCount = 0;
    try {
      const row = this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM agent_actions
             WHERE action_type = 'wiki.ingest_url'
               AND source_kind = 'wiki'
               AND source_ref = ?
               AND result = 'success'
               AND started_at >= ?`,
        )
        .get(workspace, windowStart) as { n: number } | undefined;
      wroteRowCount = row?.n ?? 0;
    } catch (err) {
      logger.warn(
        { err, workspace, correlationId: event.correlationId },
        "wiki.ingest_url write-verification query failed — forwarding the agent's DM unchanged",
      );
      return output;
    }
    if (wroteRowCount > 0) return output;
    logger.warn(
      {
        eventType: event.type,
        correlationId: event.correlationId,
        workspace,
        url,
        windowStart,
        originalOutput: output.slice(0, 240),
      },
      "wiki.ingest_url session completed but no Wiki API write was recorded — rewriting the agent's completion DM",
    );
    return `Failed ${url ?? "<url>"} — agent reported completion but no raw note was POSTed via the Wiki API; the vault is unchanged.`;
  }
}
