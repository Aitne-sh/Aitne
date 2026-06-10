import type Database from "better-sqlite3";
import type {
  AgentResult,
  BackendId,
  Event,
  IntegrationKey,
  MessageEvent,
} from "@aitne/shared";
import type {
  BangCommandDetail,
  DailyWriteAuditDetail,
  IAuditLogger,
} from "../core/dispatcher.js";
import { createLogger } from "../logging.js";

const logger = createLogger("audit");

export interface AuditEventRow {
  id: number;
  event_id: string;
  action_type: string;
  trigger: string;
  model_used: string | null;
  cost_usd: number;
  tokens_input: number;
  tokens_output: number;
  duration_ms: number;
  num_turns: number;
  result: string;
  detail: string | null;
  started_at: string;
  completed_at: string | null;
  error: string | null;
}

interface AuditLoggerOptions {
  onRowInserted?: (row: AuditEventRow) => void;
}

export function loadAuditEventRow(
  db: Database.Database,
  rowId: number,
): AuditEventRow | undefined {
  return db
    .prepare(
      `SELECT id, event_id, action_type, trigger, model_used, cost_usd,
              tokens_input, tokens_output, duration_ms, num_turns,
              result, detail, started_at, completed_at, error
       FROM agent_actions
       WHERE id = ?`,
    )
    .get(rowId) as AuditEventRow | undefined;
}

export class AuditLogger implements IAuditLogger {
  private readonly actionColumns: Set<string>;
  private readonly hasCacheCreationTokensColumn: boolean;
  private readonly hasCacheReadTokensColumn: boolean;
  private readonly hasModelUsageJsonColumn: boolean;
  private readonly hasBackendColumn: boolean;
  private readonly hasCostSourceColumn: boolean;
  private readonly hasContextUpdatedColumn: boolean;
  private readonly hasAdvisorCallCountColumn: boolean;
  private readonly hasSourceKindColumn: boolean;
  private readonly hasSourceRefColumn: boolean;

  constructor(
    private readonly db: Database.Database,
    private readonly options: AuditLoggerOptions = {},
  ) {
    this.actionColumns = new Set(
      (this.db.pragma("table_info(agent_actions)") as { name: string }[]).map(
        (column) => column.name,
      ),
    );
    this.hasCacheCreationTokensColumn =
      this.actionColumns.has("cache_creation_tokens");
    this.hasCacheReadTokensColumn = this.actionColumns.has("cache_read_tokens");
    this.hasModelUsageJsonColumn = this.actionColumns.has("model_usage_json");
    this.hasBackendColumn = this.actionColumns.has("backend");
    this.hasCostSourceColumn = this.actionColumns.has("cost_source");
    this.hasContextUpdatedColumn = this.actionColumns.has("context_updated");
    this.hasAdvisorCallCountColumn =
      this.actionColumns.has("advisor_call_count");
    this.hasSourceKindColumn = this.actionColumns.has("source_kind");
    this.hasSourceRefColumn = this.actionColumns.has("source_ref");
  }

  /**
   * AGENT_DEFINITIONS_DESIGN.md §8.1 — resolver that maps a live event to the
   * owning Agent slug for the in-flight firing, so every `logAction` row the
   * run produces is stamped with `agent_actions.agent_id` without threading the
   * slug through each caller (morning orchestrator, scheduled tasks, DMs). The
   * dispatcher wires `AgentExecutionTracker.currentAgentId(correlationId)` here
   * after both exist; until then (and for events with no resolved Agent) the
   * stamp stays NULL, preserving the legacy row shape.
   */
  private agentIdResolver: ((event: Event) => string | null) | null = null;

  setAgentIdResolver(resolver: (event: Event) => string | null): void {
    this.agentIdResolver = resolver;
  }

  logAction(params: {
    event: Event;
    model: string;
    costUsd: number;
    usage: AgentResult["usage"];
    modelUsage: AgentResult["modelUsage"];
    durationMs: number;
    numTurns: number;
    trigger: "reactive" | "autonomous";
    backend?: AgentResult["backendId"];
    costSource?: AgentResult["costSource"];
    contextUpdated?: boolean;
    advisorCallCount?: number;
    /**
     * STAGE-C-DM-FRESHNESS-PLAN §Task 4 — DM-only freshness telemetry.
     * Persisted into `agent_actions.detail` as `{ dm_freshness: ... }` so
     * the `dm_freshness_metrics` view can compute resume rate, p95 lag,
     * loud/quiet write counts seen mid-session, and refetch-hit rate.
     */
    dmFreshness?: {
      resumed: boolean;
      agentLogLagMinutes: number;
      loudWritesSinceSessionStart: number;
      quietWritesSinceSessionStart: number;
      refetchedToday: boolean;
      triggerMatched: boolean;
    };
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
    dailyWrite?: DailyWriteAuditDetail | null;
  }): void {
    const {
      event,
      model,
      costUsd,
      usage,
      modelUsage,
      durationMs,
      numTurns,
      trigger,
      backend,
      costSource,
      contextUpdated = false,
      advisorCallCount = 0,
      dmFreshness,
      prePass,
      dailyWrite,
    } = params;
    try {
      const modelUsageJson = Object.keys(modelUsage).length > 0
        ? JSON.stringify(modelUsage)
        : null;

      const columns = [
        "event_id",
        "action_type",
        "trigger",
        "model_used",
        "cost_usd",
        "tokens_input",
        "tokens_output",
        "duration_ms",
        "num_turns",
        "result",
        "started_at",
        "completed_at",
      ];
      const values: (string | number | null)[] = [
        event.correlationId,
        event.type,
        trigger,
        model,
        costUsd,
        usage.inputTokens,
        usage.outputTokens,
        durationMs,
        numTurns,
        "success",
      ];

      if (this.hasCacheCreationTokensColumn) {
        columns.splice(7, 0, "cache_creation_tokens");
        values.splice(7, 0, usage.cacheCreationInputTokens);
      }
      if (this.hasCacheReadTokensColumn) {
        // Applied schema always seeds cache_creation_tokens alongside
        // cache_read_tokens; the `: 7` index branch is defensive against
        // partially-migrated databases.
        /* c8 ignore next */
        const insertIndex = this.hasCacheCreationTokensColumn ? 8 : 7;
        columns.splice(insertIndex, 0, "cache_read_tokens");
        values.splice(insertIndex, 0, usage.cacheReadInputTokens);
      }
      if (this.hasModelUsageJsonColumn) {
        const insertIndex =
          7
          + Number(this.hasCacheCreationTokensColumn)
          + Number(this.hasCacheReadTokensColumn);
        columns.splice(insertIndex, 0, "model_usage_json");
        values.splice(insertIndex, 0, modelUsageJson);
      }
      if (this.hasBackendColumn) {
        columns.splice(columns.length - 2, 0, "backend");
        values.splice(values.length, 0, backend ?? "claude");
      }
      if (this.hasCostSourceColumn) {
        columns.splice(columns.length - 2, 0, "cost_source");
        values.splice(values.length, 0, costSource ?? "sdk");
      }
      if (this.hasContextUpdatedColumn) {
        columns.splice(columns.length - 2, 0, "context_updated");
        values.splice(values.length, 0, contextUpdated ? 1 : 0);
      }
      if (this.hasAdvisorCallCountColumn) {
        columns.splice(columns.length - 2, 0, "advisor_call_count");
        values.splice(values.length, 0, Math.max(0, advisorCallCount));
      }
      if (event.type.startsWith("wiki.") && this.hasSourceKindColumn) {
        columns.splice(columns.length - 2, 0, "source_kind");
        values.splice(values.length, 0, "wiki");
      }
      if (event.type.startsWith("wiki.") && this.hasSourceRefColumn) {
        columns.splice(columns.length - 2, 0, "source_ref");
        values.splice(
          values.length,
          0,
          typeof event.data.workspace === "string" ? event.data.workspace : null,
        );
      }
      // AGENT_DEFINITIONS_DESIGN.md §5.3 / §8.1 — stamp the owning Agent slug
      // when the in-flight firing resolved to one. The `agent_id` column ships
      // since migration 0007, so no column-existence guard is needed; an
      // unresolved firing leaves it NULL (legacy row shape). The in_progress
      // UPDATE path below carries it automatically (the generic column loop).
      const resolvedAgentId = this.agentIdResolver?.(event) ?? null;
      if (resolvedAgentId !== null) {
        columns.splice(columns.length - 2, 0, "agent_id");
        values.splice(values.length, 0, resolvedAgentId);
      }
      const detailPayload: Record<string, unknown> = {};
      // STAGE-C-DM-FRESHNESS-PLAN §Task 4 — persist DM freshness telemetry
      // into `detail`. Inserted only when supplied so non-DM rows stay
      // empty and old readers ignore the field.
      if (dmFreshness) {
        detailPayload.dm_freshness = {
          resumed: dmFreshness.resumed,
          agent_log_lag_minutes: dmFreshness.agentLogLagMinutes,
          loud_writes_since_session_start:
            dmFreshness.loudWritesSinceSessionStart,
          quiet_writes_since_session_start:
            dmFreshness.quietWritesSinceSessionStart,
          refetched_today: dmFreshness.refetchedToday,
          trigger_matched: dmFreshness.triggerMatched,
        };
      }
      if (prePass) {
        detailPayload.prePass = {
          parentCorrelationId: prePass.parentCorrelationId,
          parentRoutine: prePass.parentRoutine,
          integrationKey: prePass.integrationKey,
          attempt: prePass.attempt,
          maxAttempts: prePass.maxAttempts,
          retriedFromAttempt: prePass.retriedFromAttempt,
          status: prePass.status,
          fetched: prePass.fetched,
          posted: prePass.posted,
          duplicates: prePass.duplicates,
          errors: prePass.errors,
          willRetry: prePass.willRetry,
          retryReason: prePass.retryReason,
          ...(prePass.fallbackTriggered !== undefined
            ? { fallbackTriggered: prePass.fallbackTriggered }
            : {}),
          ...(prePass.requestedBackend !== undefined
            ? { requestedBackend: prePass.requestedBackend }
            : {}),
        };
      }
      // daily-journal-daemon-write.md §4.11 — Stage B daily journal
      // compose outcome. Lands on the same INSERT/UPSERT as the row's
      // terminal `result`, no post-UPDATE required.
      if (dailyWrite) {
        detailPayload.dailyWrite = dailyWrite;
      }
      if (Object.keys(detailPayload).length > 0) {
        columns.splice(columns.length - 2, 0, "detail");
        values.splice(
          values.length,
          0,
          JSON.stringify(detailPayload),
        );
      }

      // morning-routine-optimization.md Phase 6 — UPSERT semantics for the
      // in_progress sentinel row. The orchestrator pre-inserts a row with
      // `result='in_progress'` before Stage A starts so the agent's
      // `PATCH /api/agent-actions/self` can resolve and write the
      // structured metadata side-channel that ⑥ AgentJournalAppender
      // consumes. Without this branch, `logAction` would INSERT a fresh
      // terminal row and leave the in_progress row orphaned — the
      // appender's "most recent row wins" walk would then read the
      // terminal row's empty metadata, defeating the whole structured-
      // self-report pathway.
      //
      // The branch is generic on `(event_id, action_type, 'in_progress')`
      // so any other pre-insertion pattern (delegated_task header rows
      // already use a parallel `completeTaskHeader` path; this branch is
      // for routine-style sessions that fan through `processResult`)
      // inherits the same settle semantics. The lookup is `event_id IS ?`
      // so a NULL correlationId matches a NULL row, preserving the
      // legacy fresh-INSERT path for events that have never carried a
      // correlationId.
      const inProgressId = this.findInProgressRowId(
        event.correlationId,
        event.type,
      );
      if (inProgressId !== null) {
        // UPDATE in-place — preserves the `metadata` JSON column the agent
        // wrote via `/api/agent-actions/self`, the existing started_at,
        // and the row's id (so any FK references stay valid). Drop
        // `started_at` from the column set since the in-progress INSERT
        // already populated it; `completed_at` flips from NULL to
        // datetime('now') as part of the settle.
        const assignments: string[] = [];
        const updateValues: (string | number | null)[] = [];
        for (let i = 0; i < columns.length; i++) {
          const column = columns[i];
          if (column === "event_id" || column === "action_type") continue;
          if (column === "started_at") continue;
          if (column === "completed_at") {
            assignments.push(`${column} = datetime('now')`);
            continue;
          }
          if (column === "detail") {
            assignments.push(`${column} = json(?)`);
            updateValues.push(values[i]);
            continue;
          }
          assignments.push(`${column} = ?`);
          updateValues.push(values[i]);
        }
        try {
          this.db
            .prepare(
              `UPDATE agent_actions SET ${assignments.join(", ")} WHERE id = ?`,
            )
            .run(...updateValues, inProgressId);
          this.emitInsertedRow(inProgressId, event.type);
          return;
        } catch (err) {
          // Fall through to INSERT on UPDATE failure (e.g. row was
          // garbage-collected between SELECT and UPDATE). Logged here
          // so the operator can spot the race; downstream readers see
          // the fresh terminal row that the INSERT below produces.
          logger.warn(
            { err, event: event.type, inProgressId },
            "in_progress row UPDATE failed — falling back to INSERT",
          );
        }
      }

      const placeholders = columns
        .map((column) => {
          if (column === "started_at" || column === "completed_at") {
            return "datetime('now')";
          }
          if (column === "detail") {
            return "json(?)";
          }
          return "?";
        })
        .join(", ");

      const insertResult = this.db
        .prepare(
          `INSERT INTO agent_actions (${columns.join(", ")})
           VALUES (${placeholders})`,
        )
        .run(...values);
      this.emitInsertedRow(Number(insertResult.lastInsertRowid), event.type);
    } catch (err) {
      logger.error({ err, event: event.type }, "Failed to log action");
    }
  }

  /**
   * morning-routine-optimization.md Phase 6 — pre-insert an `in_progress`
   * sentinel row so a subsequent `PATCH /api/agent-actions/self` from
   * inside the spawned session resolves to the same row that the eventual
   * terminal-state `logAction` will settle. Used by the morning-routine
   * pipeline orchestrator before launching Stage A; safe to call from any
   * caller that wants the upsert path in `logAction` to fire.
   *
   * Returns the inserted rowid (`-1` when the INSERT failed — caller
   * should still proceed since `logAction` will fall back to the
   * legacy fresh-INSERT path).
   */
  insertInProgressRow(args: {
    correlationId: string | null;
    actionType: string;
    trigger: "reactive" | "autonomous";
    backend?: string;
    modelId?: string;
  }): number {
    try {
      const columns: string[] = ["event_id", "action_type", "trigger", "result"];
      const valuePlaceholders: string[] = ["?", "?", "?", "?"];
      const values: (string | number | null)[] = [
        args.correlationId,
        args.actionType,
        args.trigger,
        "in_progress",
      ];
      columns.push("started_at");
      valuePlaceholders.push("datetime('now')");
      if (this.hasBackendColumn) {
        columns.push("backend");
        valuePlaceholders.push("?");
        values.push(args.backend ?? null);
      }
      if (args.modelId !== undefined) {
        columns.push("model_used");
        valuePlaceholders.push("?");
        values.push(args.modelId);
      }
      const result = this.db
        .prepare(
          `INSERT INTO agent_actions (${columns.join(", ")}) VALUES (${valuePlaceholders.join(", ")})`,
        )
        .run(...values);
      return Number(result.lastInsertRowid);
    } catch (err) {
      logger.error(
        { err, actionType: args.actionType, correlationId: args.correlationId },
        "Failed to insert in_progress agent_actions row",
      );
      return -1;
    }
  }

  private findInProgressRowId(
    correlationId: string | null | undefined,
    actionType: string,
  ): number | null {
    try {
      // SQLite `IS` handles NULL equality and is identical to `=` for
      // non-NULL operands, so a single predicate covers both the
      // correlated and uncorrelated cases.
      const row = this.db
        .prepare(
          `SELECT id FROM agent_actions
            WHERE event_id IS ?
              AND action_type = ?
              AND result = 'in_progress'
            ORDER BY id DESC
            LIMIT 1`,
        )
        .get(correlationId ?? null, actionType) as { id: number } | undefined;
      return row ? row.id : null;
    } catch {
      return null;
    }
  }

  logSkip(
    event: Event,
    reason: string,
    trigger: "reactive" | "autonomous",
    /**
     * Optional structured context persisted to the `detail` JSON column.
     * Used by the N2 spawn gates (`detail.spawnGate` — per-backend
     * offline/auth verdicts) and the N3 pre-pass plan-assembly drop rows
     * (`detail.prePass.skipReason`) so skip telemetry is queryable
     * without parsing the `error` string. PREPASS_COST_REDUCTION_PLAN.md.
     */
    detail?: Record<string, unknown>,
  ): void {
    try {
      // AGENT_DEFINITIONS_DESIGN.md §8.1 — stamp the owning Agent when the
      // in-flight firing resolved to one (e.g. a review routine skipped by the
      // morning-pending gate), so the skip row is attributable. Pre-`begin`
      // skips (setup-mode / cost-cap) resolve to NULL — no execution context
      // exists yet — which is the legacy row shape.
      const resolvedAgentId = this.agentIdResolver?.(event) ?? null;
      const columns = ["event_id", "action_type", "trigger", "result", "error"];
      const values: (string | number | null)[] = [
        event.correlationId,
        event.type,
        trigger,
        "skipped",
        reason,
      ];
      if (resolvedAgentId !== null) {
        columns.push("agent_id");
        values.push(resolvedAgentId);
      }
      if (detail !== undefined) {
        columns.push("detail");
        values.push(JSON.stringify(detail));
      }
      const placeholders = columns.map(() => "?").join(", ");
      const insertResult = this.db
        .prepare(
          `INSERT INTO agent_actions
             (${columns.join(", ")}, started_at)
           VALUES (${placeholders}, datetime('now'))`,
        )
        .run(...values);
      this.emitInsertedRow(Number(insertResult.lastInsertRowid), event.type);
    } catch (err) {
      logger.error({ err, event: event.type }, "Failed to log skip");
    }
    logger.info({ event: event.type, reason }, "Event skipped");
  }

  /**
   * Chat-attachments Phase 1 — log a successful upload (inbound or outbound)
   * to `agent_actions`. Shares the `agent_actions` table with agent-turn
   * actions so the dashboard cost/events views can surface attachment
   * activity alongside agent execution without a second table.
   *
   * Uses a minimal column set like `logSkip`/`logError`: no token/cost
   * accounting (an upload is always zero-cost) and no model_used. The
   * direction is encoded in `action_type` so cost queries that group by
   * action_type bucket uploads separately from turns.
   */
  logAttachment(params: {
    direction: "inbound" | "outbound";
    attachmentId: string;
    mimeType: string;
    sizeBytes: number;
    provenance: string;
    originalFilename: string;
  }): void {
    const actionType = `attachment.upload.${params.direction}`;
    const trigger = params.direction === "inbound" ? "reactive" : "autonomous";
    try {
      const insertResult = this.db
        .prepare(
          `INSERT INTO agent_actions
             (event_id, action_type, trigger, result, detail, started_at, completed_at)
           VALUES (?, ?, ?, 'success', ?, datetime('now'), datetime('now'))`,
        )
        .run(
          params.attachmentId,
          actionType,
          trigger,
          JSON.stringify({
            mimeType: params.mimeType,
            sizeBytes: params.sizeBytes,
            provenance: params.provenance,
            originalFilename: params.originalFilename,
          }),
        );
      this.emitInsertedRow(Number(insertResult.lastInsertRowid), actionType);
    } catch (err) {
      logger.error(
        { err, attachmentId: params.attachmentId, direction: params.direction },
        "Failed to log attachment action",
      );
    }
  }

  logBangCommand(event: MessageEvent, detail: BangCommandDetail): void {
    const result = bangStatusToResult(detail.status);
    // The interceptor injects `platform: event.platform` automatically so
    // handlers don't have to repeat it (docs §6.6).
    const merged: Record<string, unknown> = {
      ...detail,
      platform: event.platform,
    };
    try {
      const insertResult = this.db
        .prepare(
          `INSERT INTO agent_actions
             (event_id, action_type, trigger, result, detail, started_at, completed_at)
           VALUES (?, 'bang_command', 'reactive', ?, json(?), datetime('now'), datetime('now'))`,
        )
        .run(
          event.correlationId,
          result,
          JSON.stringify(merged),
        );
      this.emitInsertedRow(Number(insertResult.lastInsertRowid), "bang_command");
    } catch (err) {
      logger.error(
        { err, command: detail.command, status: detail.status },
        "Failed to log bang_command",
      );
    }
  }

  logError(
    event: Event,
    error: Error,
    trigger: "reactive" | "autonomous",
    /**
     * Optional partial-run context the dispatcher recovers from the catch
     * site (wall-clock duration) and from `BackendRouterHandledError`
     * (backend / model / failure kind+code). Without this, the row is a
     * black hole: the dashboard shows "Duration: 0ms" for a long run that
     * hit `max_budget_usd` because the row was written with no
     * timing/backend/model info.
     *
     * Tokens / cost / num_turns are passed ONLY when the caller holds a
     * real recovered spend figure (PREPASS_COST_REDUCTION_PLAN.md N1 —
     * post-hoc budget kills, partial stream aborts). Callers without one
     * must omit them: a fabricated value here would corrupt the cost
     * dials. duration_ms + backend + failure shape are always
     * recoverable and that's the baseline record.
     */
    context?: {
      durationMs?: number;
      backendId?: import("@aitne/shared").BackendId;
      modelId?: string;
      failureKind?: string;
      failureCode?: string;
      /**
       * PREPASS_COST_REDUCTION_PLAN.md N1 — recovered spend for a failed
       * turn the provider already billed. Pass ONLY a real recovered
       * figure (BackendQuotaSpend / partial-usage snapshot), never a
       * guess — the historical contract that failure rows carry no
       * fabricated cost still holds for callers without one.
       */
      costUsd?: number;
      costSource?: string;
      tokensInput?: number;
      tokensOutput?: number;
      tokensCacheCreation?: number;
      tokensCacheRead?: number;
      numTurns?: number;
      /**
       * Pre-pass fan-out failure block. Mirrors the `prePass` payload on
       * `logAction` so `MetricsCollector.collectPrePassMetrics` can see
       * every failure mode (binding-resolve, global-budget-cap,
       * per-integration budget-cap, context-build, agent-execute) without
       * a parallel `result='success'` row. The aggregator filters by
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
      dailyWrite?: DailyWriteAuditDetail | null;
    },
  ): void {
    try {
      const columns = [
        "event_id",
        "action_type",
        "trigger",
        "result",
        "error",
        "started_at",
        "completed_at",
      ];
      // Emitted as a SQL expression (datetime(...)) rather than a bound
      // value — the placeholder map below special-cases these column names.
      const values: (string | number | null)[] = [
        event.correlationId,
        event.type,
        trigger,
        "failed",
        error.message,
      ];

      // Optional columns are inserted BEFORE the started_at/completed_at
      // tail (`columns.length - 2`) and APPENDED to `values` (which has
      // no started_at/completed_at entries — those are SQL expressions
      // in the INSERT placeholder map). The lockstep invariant
      // `columns.length - 2 === values.length` is what makes the
      // in_progress UPSERT branch's iteration `values[i]` align with
      // columns[i]: any other splice pattern (e.g. inserting at
      // `columns.length`, AFTER the timestamps) would shift columns
      // ahead of values and the UPDATE assignments would bind the wrong
      // value to each column. Mirrors the identically-shaped block in
      // `logAction` (above).
      if (typeof context?.durationMs === "number" && context.durationMs >= 0) {
        columns.splice(columns.length - 2, 0, "duration_ms");
        values.splice(values.length, 0, Math.round(context.durationMs));
      }
      if (context?.modelId) {
        columns.splice(columns.length - 2, 0, "model_used");
        values.splice(values.length, 0, context.modelId);
      }
      if (this.hasBackendColumn && context?.backendId) {
        columns.splice(columns.length - 2, 0, "backend");
        values.splice(values.length, 0, context.backendId);
      }
      // PREPASS_COST_REDUCTION_PLAN.md N1 — recovered spend for a failed
      // turn the provider already billed (post-hoc budget kill, partial
      // stream abort, timeout-with-usage). Only callers that hold a real
      // recovered figure pass these; the historical "no guessed values"
      // contract still applies to everyone else.
      if (typeof context?.costUsd === "number" && context.costUsd >= 0) {
        columns.splice(columns.length - 2, 0, "cost_usd");
        values.splice(values.length, 0, context.costUsd);
      }
      if (this.hasCostSourceColumn && context?.costSource) {
        columns.splice(columns.length - 2, 0, "cost_source");
        values.splice(values.length, 0, context.costSource);
      }
      if (typeof context?.tokensInput === "number" && context.tokensInput >= 0) {
        columns.splice(columns.length - 2, 0, "tokens_input");
        values.splice(values.length, 0, context.tokensInput);
      }
      if (typeof context?.tokensOutput === "number" && context.tokensOutput >= 0) {
        columns.splice(columns.length - 2, 0, "tokens_output");
        values.splice(values.length, 0, context.tokensOutput);
      }
      if (
        this.hasCacheCreationTokensColumn
        && typeof context?.tokensCacheCreation === "number"
        && context.tokensCacheCreation >= 0
      ) {
        columns.splice(columns.length - 2, 0, "cache_creation_tokens");
        values.splice(values.length, 0, context.tokensCacheCreation);
      }
      if (
        this.hasCacheReadTokensColumn
        && typeof context?.tokensCacheRead === "number"
        && context.tokensCacheRead >= 0
      ) {
        columns.splice(columns.length - 2, 0, "cache_read_tokens");
        values.splice(values.length, 0, context.tokensCacheRead);
      }
      if (typeof context?.numTurns === "number" && context.numTurns > 0) {
        columns.splice(columns.length - 2, 0, "num_turns");
        values.splice(values.length, 0, context.numTurns);
      }
      // AGENT_DEFINITIONS_DESIGN.md §8.1 — stamp the owning Agent when the
      // in-flight firing resolved to one, so a FAILED routine's audit row is
      // attributable to its Agent (the same resolver `logAction` uses). The
      // in_progress UPSERT loop below carries it via the generic column path.
      const resolvedAgentId = this.agentIdResolver?.(event) ?? null;
      if (resolvedAgentId !== null) {
        columns.splice(columns.length - 2, 0, "agent_id");
        values.splice(values.length, 0, resolvedAgentId);
      }
      const detailPayload: Record<string, unknown> = {};
      if (context?.failureKind) detailPayload.failureKind = context.failureKind;
      if (context?.failureCode) detailPayload.failureCode = context.failureCode;
      if (context?.prePass) {
        detailPayload.prePass = {
          parentCorrelationId: context.prePass.parentCorrelationId,
          parentRoutine: context.prePass.parentRoutine,
          integrationKey: context.prePass.integrationKey,
          attempt: context.prePass.attempt,
          maxAttempts: context.prePass.maxAttempts,
          retriedFromAttempt: context.prePass.retriedFromAttempt,
          status: context.prePass.status,
          fetched: context.prePass.fetched,
          posted: context.prePass.posted,
          duplicates: context.prePass.duplicates,
          errors: context.prePass.errors,
          willRetry: context.prePass.willRetry,
          retryReason: context.prePass.retryReason,
          ...(context.prePass.fallbackTriggered !== undefined
            ? { fallbackTriggered: context.prePass.fallbackTriggered }
            : {}),
          ...(context.prePass.requestedBackend !== undefined
            ? { requestedBackend: context.prePass.requestedBackend }
            : {}),
        };
      }
      // daily-journal-daemon-write.md §4.11 — Stage B daily journal
      // compose outcome (failure-path twin of the success-path block
      // above). Lets the streak detector see `ok: false, reason: ...`
      // rows when Stage B threw mid-flight.
      if (context?.dailyWrite) {
        detailPayload.dailyWrite = context.dailyWrite;
      }
      if (Object.keys(detailPayload).length > 0) {
        columns.splice(columns.length - 2, 0, "detail");
        values.splice(values.length, 0, JSON.stringify(detailPayload));
      }

      // Backdate started_at so the dashboard "Started" column reflects when
      // the run actually began rather than when the catch fired. completed_at
      // is "now" — the catch site IS end-of-run.
      const backdateSeconds = context?.durationMs
        ? Math.round(context.durationMs) / 1000
        : 0;
      const startedAtExpr = backdateSeconds > 0
        ? `datetime('now', '-${backdateSeconds.toFixed(3)} seconds')`
        : "datetime('now')";

      // UPSERT semantics for the in_progress sentinel row — mirrors the
      // identically-shaped branch in `logAction` (lines 297-344). Callers
      // (notably the morning-routine pipeline orchestrator) pre-insert a
      // `result='in_progress'` row before spawning Stage A so the agent's
      // `PATCH /api/agent-actions/self` can resolve and write structured
      // metadata; without this branch a subsequent throw inside the same
      // stage would leave the in_progress row orphaned AND emit a parallel
      // `result='failed'` row, causing `loadMorningRoutineActionRows`
      // (which picks the most-recent matching row) to read whichever
      // landed last and producing misleading audit-trail entries. The
      // UPDATE preserves the row's original `started_at` and `metadata`
      // column so any agent-side PATCH writes that landed before the
      // throw survive the settle.
      //
      // Lookup is `event_id IS ?` so a NULL correlationId matches a NULL
      // row — same NULL-tolerant predicate `logAction` uses.
      const inProgressId = this.findInProgressRowId(
        event.correlationId,
        event.type,
      );
      if (inProgressId !== null) {
        const assignments: string[] = [];
        const updateValues: (string | number | null)[] = [];
        for (let i = 0; i < columns.length; i++) {
          const column = columns[i];
          // event_id / action_type / started_at are immutable on settle —
          // event_id/action_type are the lookup key; started_at was
          // captured at the pre-insert and IS the actual start time.
          if (column === "event_id" || column === "action_type") continue;
          if (column === "started_at") continue;
          if (column === "completed_at") {
            assignments.push(`${column} = datetime('now')`);
            continue;
          }
          if (column === "detail") {
            assignments.push(`${column} = json(?)`);
            updateValues.push(values[i]);
            continue;
          }
          assignments.push(`${column} = ?`);
          updateValues.push(values[i]);
        }
        try {
          this.db
            .prepare(
              `UPDATE agent_actions SET ${assignments.join(", ")} WHERE id = ?`,
            )
            .run(...updateValues, inProgressId);
          this.emitInsertedRow(inProgressId, event.type);
          logger.error(
            { event: event.type, error: error.message },
            "Event error",
          );
          return;
        } catch (err) {
          // Fall through to INSERT on UPDATE failure (e.g. row was
          // garbage-collected between SELECT and UPDATE). Mirrors the
          // identical defensive fall-through in `logAction`.
          logger.warn(
            { err, event: event.type, inProgressId },
            "in_progress row UPDATE in logError failed — falling back to INSERT",
          );
        }
      }

      const placeholders = columns
        .map((column) => {
          if (column === "started_at") return startedAtExpr;
          if (column === "completed_at") return "datetime('now')";
          if (column === "detail") return "json(?)";
          return "?";
        })
        .join(", ");

      const insertResult = this.db
        .prepare(
          `INSERT INTO agent_actions (${columns.join(", ")})
           VALUES (${placeholders})`,
        )
        .run(...values);
      this.emitInsertedRow(Number(insertResult.lastInsertRowid), event.type);
    } catch (err) {
      logger.error({ err, event: event.type }, "Failed to log error");
    }
    logger.error({ event: event.type, error: error.message }, "Event error");
  }

  private emitInsertedRow(rowId: number, eventType: string): void {
    if (!this.options.onRowInserted || !Number.isFinite(rowId) || rowId <= 0) {
      return;
    }

    try {
      const row = loadAuditEventRow(this.db, rowId);

      if (row) {
        this.options.onRowInserted(row);
      }
    } catch (err) {
      logger.warn(
        { err, event: eventType, rowId },
        "Failed to emit inserted audit row",
      );
    }
  }
}

/**
 * Map a `BangCommandDetail.status` to the `agent_actions.result` value
 * permitted by the schema's CHECK constraint
 * (`success | failed | partial | skipped | in_progress`). See docs/design/
 * backlog/messaging-bang-commands.md §6.6 for the rationale.
 */
export function bangStatusToResult(
  status: BangCommandDetail["status"],
): "success" | "skipped" | "failed" {
  switch (status) {
    case "ok":
      return "success";
    case "unknown":
    case "invalid_args":
      return "failed";
    case "skipped":
    case "paused_decline":
    case "paused_blocked":
      return "skipped";
  }
}
