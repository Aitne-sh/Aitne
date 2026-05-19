import type Database from "better-sqlite3";
import type { BackendId, IntegrationKey } from "@aitne/shared";
import type {
  DelegatedTaskRawErrorClass,
  DelegatedTaskToolStepRaw,
  DelegatedToolCost,
  DelegatedToolErrorClass,
} from "../core/agent-core.js";
import { createLogger } from "../logging.js";
import { hashArgs } from "./delegated-invoker-utils.js";
import { hashTaskArgs } from "./delegated-task-runtime.js";
import type { InvokeParams } from "./delegated-backend-invoker.js";

/**
 * Audit-row writers for the delegated proxy + task subsystem.
 *
 * Each function is a pure DB writer — it consumes a `Database` handle plus
 * a structured args object and INSERTs / UPDATEs a row in `agent_actions`.
 * No instance state, no closures over the invoker. All failures are
 * logged and swallowed: an audit-row write must never break the live
 * invocation it is recording.
 *
 * Row lifecycle reference — DELEGATED-TASK-MODE-DESIGN.md §11.1:
 *   - `recordAction` — terminal row for `DelegatedBackendInvoker.invoke()`
 *     (one shot). Today this is reached only via the
 *     `delegated-sync-worker` hourly drift-detection path — the
 *     `/api/integrations/:key/invoke` RPC route that previously also
 *     hit this writer was retired 2026-05-01.
 *   - `recordCacheHitAuditRow` — terminal cache-hit row for task / run.
 *   - `recordTaskHeaderInProgress` → `completeTaskHeader` — header for
 *     /exec or /run; step rows FK back to its rowid.
 *   - `recordTaskToolStep` — one row per tool_use / tool_result pair.
 */

const logger = createLogger("delegated-proxy-audit");

/**
 * Terminal audit row for {@link DelegatedBackendInvoker.invoke}. Written
 * after the subprocess has settled (success, failure, or precondition
 * miss). Distinct cost / error shapes are preserved by leaving optional
 * fields off when absent rather than coercing them to defaults — keeps
 * the dashboard's metric aggregator honest.
 */
export function recordAction(
  db: Database.Database,
  args: {
    backendId: BackendId;
    modelId: string;
    params: InvokeParams;
    result: "success" | "failed";
    errorClass?:
      | DelegatedToolErrorClass
      | "delegated_proxy_busy"
      | "unimplemented"
      | "precondition";
    cost: DelegatedToolCost;
    startedAt: string;
    completedAt: string;
    errorMessage?: string;
  },
): void {
  const detail = {
    integrationKey: args.params.integrationKey,
    toolName: args.params.toolName,
    toolArgsHash: hashArgs(args.params.toolArgs),
    ...(args.errorClass ? { errorClass: args.errorClass } : {}),
  };
  try {
    db.prepare(
      // datetime(@started_at) coerces ISO-8601 input into SQLite's
      // canonical 'YYYY-MM-DD HH:MM:SS' so this row sorts correctly
      // alongside rows written via datetime('now') elsewhere — without
      // it, mixed formats break ORDER BY started_at.
      `INSERT INTO agent_actions (
         event_id, action_type, trigger, model_used,
         cost_usd, tokens_input, tokens_output,
         cache_creation_tokens, cache_read_tokens,
         duration_ms, num_turns, result, detail,
         started_at, completed_at, error, backend, cost_source
       ) VALUES (
         @event_id, 'delegated_proxy.invoke', @trigger, @model_used,
         @cost_usd, @tokens_input, @tokens_output,
         @cache_creation_tokens, @cache_read_tokens,
         @duration_ms, @num_turns, @result, @detail,
         datetime(@started_at), datetime(@completed_at), @error, @backend, 'sdk'
       )`,
    ).run({
      event_id: args.params.parentEventId ?? null,
      trigger: args.params.parentProcessKey ?? null,
      model_used: args.modelId,
      cost_usd: args.cost.costUsd,
      tokens_input: args.cost.tokensInput,
      tokens_output: args.cost.tokensOutput,
      cache_creation_tokens: args.cost.cacheCreationTokens,
      cache_read_tokens: args.cost.cacheReadTokens,
      duration_ms: args.cost.durationMs,
      num_turns: args.cost.numTurns,
      result: args.result,
      detail: JSON.stringify(detail),
      started_at: args.startedAt,
      completed_at: args.completedAt,
      error: args.errorMessage ?? null,
      backend: args.backendId,
    });
  } catch (err) {
    logger.error(
      { err, integrationKey: args.params.integrationKey },
      "failed to record delegated_proxy.invoke action",
    );
  }
}

/**
 * §13 Phase 3.3 — single-shot INSERT for cache-hit audit rows. Cache
 * hits don't go through the in-progress → complete two-step lifecycle
 * (the outcome is known synchronously), so this writes one row with
 * `result='success'`, `cost_usd=0`, `cost_source='cache'` for clean
 * dashboard cost-source filtering.
 *
 * Returns the inserted rowid (`-1` on SQL failure).
 */
export function recordCacheHitAuditRow(
  db: Database.Database,
  args: {
    actionType: "delegated_task.exec" | "delegated_task.run";
    backendId: BackendId;
    modelId: string;
    parentEventId?: string;
    parentProcessKey?: string;
    timestamp: string;
    detail: Record<string, unknown>;
    toolCallCount: number;
  },
): number {
  try {
    const result = db
      .prepare(
        `INSERT INTO agent_actions (
           event_id, action_type, trigger, model_used,
           cost_usd, tokens_input, tokens_output,
           cache_creation_tokens, cache_read_tokens,
           duration_ms, num_turns, result, detail,
           started_at, completed_at, error, backend, cost_source
         ) VALUES (
           @event_id, @action_type, @trigger, @model_used,
           0, 0, 0, 0, 0,
           0, @num_turns, 'success', @detail,
           datetime(@ts), datetime(@ts), NULL, @backend, 'cache'
         )`,
      )
      .run({
        event_id: args.parentEventId ?? null,
        action_type: args.actionType,
        trigger: args.parentProcessKey ?? null,
        model_used: args.modelId,
        num_turns: args.toolCallCount,
        detail: JSON.stringify(args.detail),
        ts: args.timestamp,
        backend: args.backendId,
      });
    return Number(result.lastInsertRowid);
  } catch (err) {
    logger.error(
      { err, actionType: args.actionType, detail: args.detail },
      "failed to write delegated_task cache-hit audit row",
    );
    return -1;
  }
}

/**
 * §11.1 — INSERT the `'in_progress'` header row BEFORE spawning the
 * subprocess so any tool-step rows have a stable parent rowid to FK
 * against. Caller pairs this with {@link completeTaskHeader} once the
 * task has settled.
 *
 * Returns the inserted rowid (`-1` on SQL failure — caller checks
 * before persisting child rows).
 */
export function recordTaskHeaderInProgress(
  db: Database.Database,
  args: {
    /** §11.1 — `'delegated_task.exec'` (Phase 1 /exec) or
     *  `'delegated_task.run'` (Phase 2 /run). Dashboard filters key off this. */
    actionType: "delegated_task.exec" | "delegated_task.run";
    backendId: BackendId;
    modelId: string;
    parentEventId?: string;
    parentProcessKey?: string;
    startedAt: string;
    /** Detail JSON. Caller picks what to surface — typically taskHash,
     *  schemaHash, integrationKey, or allowedToolsHash. */
    detail: Record<string, unknown>;
  },
): number {
  try {
    const result = db
      .prepare(
        `INSERT INTO agent_actions (
           event_id, action_type, trigger, model_used,
           cost_usd, tokens_input, tokens_output,
           cache_creation_tokens, cache_read_tokens,
           duration_ms, num_turns, result, detail,
           started_at, completed_at, error, backend, cost_source
         ) VALUES (
           @event_id, @action_type, @trigger, @model_used,
           0, 0, 0, 0, 0,
           0, 0, 'in_progress', @detail,
           datetime(@started_at), NULL, NULL, @backend, 'sdk'
         )`,
      )
      .run({
        event_id: args.parentEventId ?? null,
        action_type: args.actionType,
        trigger: args.parentProcessKey ?? null,
        model_used: args.modelId,
        detail: JSON.stringify(args.detail),
        started_at: args.startedAt,
        backend: args.backendId,
      });
    return Number(result.lastInsertRowid);
  } catch (err) {
    logger.error(
      { err, actionType: args.actionType, detail: args.detail },
      "failed to write delegated_task header row",
    );
    return -1;
  }
}

/**
 * §11.1 — flip the header row from `'in_progress'` to the final
 * `result` and patch in the aggregate cost. No-op when `headerId < 0`
 * (the upstream INSERT failed; we just don't compound the loss).
 */
export function completeTaskHeader(
  db: Database.Database,
  args: {
    headerId: number;
    result: "success" | "failed";
    cost: DelegatedToolCost;
    completedAt: string;
    errorClass: DelegatedTaskRawErrorClass | string | null;
    errorMessage: string | null;
    retried: boolean;
    toolCallCount: number;
    detail: Record<string, unknown>;
  },
): void {
  if (args.headerId < 0) return;
  try {
    db.prepare(
      `UPDATE agent_actions SET
         result = @result,
         cost_usd = @cost_usd,
         tokens_input = @tokens_input,
         tokens_output = @tokens_output,
         cache_creation_tokens = @cache_creation_tokens,
         cache_read_tokens = @cache_read_tokens,
         duration_ms = @duration_ms,
         num_turns = @num_turns,
         completed_at = datetime(@completed_at),
         error = @error,
         detail = @detail
       WHERE id = @id`,
    ).run({
      id: args.headerId,
      result: args.result,
      cost_usd: args.cost.costUsd,
      tokens_input: args.cost.tokensInput,
      tokens_output: args.cost.tokensOutput,
      cache_creation_tokens: args.cost.cacheCreationTokens,
      cache_read_tokens: args.cost.cacheReadTokens,
      duration_ms: args.cost.durationMs,
      num_turns: args.cost.numTurns,
      completed_at: args.completedAt,
      error: args.errorMessage,
      detail: JSON.stringify(args.detail),
    });
  } catch (err) {
    logger.error(
      { err, headerId: args.headerId },
      "failed to update delegated_task.exec header row",
    );
  }
}

/**
 * §11.1 — one row per `tool_use` / `tool_result` pair the core observed.
 * Skipped (logged at warn) on SQL failure: per-step persistence must not
 * abort the surrounding task loop.
 */
export function recordTaskToolStep(
  db: Database.Database,
  args: {
    parentTaskActionId: number;
    backendId: BackendId;
    modelId: string;
    /** Integration scope when known (Phase 1 /exec); omitted for Phase 2
     *  /run since there's no registered integration. */
    integrationKey?: IntegrationKey;
    step: DelegatedTaskToolStepRaw;
  },
): void {
  try {
    db.prepare(
      `INSERT INTO agent_actions (
         action_type, trigger, model_used,
         cost_usd, tokens_input, tokens_output,
         cache_creation_tokens, cache_read_tokens,
         duration_ms, num_turns, result, detail,
         started_at, completed_at, error, backend, cost_source
       ) VALUES (
         'delegated_task.tool_step', NULL, @model_used,
         @cost_usd, @tokens_input, @tokens_output,
         0, 0,
         @duration_ms, 1, @result, @detail,
         datetime('now'), datetime('now'), @error, @backend, 'sdk'
       )`,
    ).run({
      model_used: args.modelId,
      cost_usd: args.step.costUsd,
      tokens_input: args.step.tokensInput,
      tokens_output: args.step.tokensOutput,
      duration_ms: args.step.durationMs,
      result: args.step.status === "ok" ? "success" : "failed",
      detail: JSON.stringify({
        ...(args.integrationKey ? { integrationKey: args.integrationKey } : {}),
        toolName: args.step.toolName,
        toolArgsHash: hashTaskArgs(args.step.toolArgs),
        toolStatus: args.step.status,
        parentTaskActionId: args.parentTaskActionId,
      }),
      error: args.step.status === "error" ? "tool_step_error" : null,
      backend: args.backendId,
    });
  } catch (err) {
    logger.warn(
      { err, parentTaskActionId: args.parentTaskActionId },
      "failed to write delegated_task.tool_step row",
    );
  }
}
