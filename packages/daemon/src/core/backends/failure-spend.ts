/**
 * PREPASS_COST_REDUCTION_PLAN.md N1 — shared post-hoc failure-spend
 * recording.
 *
 * A backend attempt that fails (or is budget-killed) after the provider
 * has already billed must still land in `agent_actions`, or the cost
 * dials under-report by the size of every failed turn. Two layers need
 * the same write:
 *
 *  - `DispatcherErrorRouter.handleError` — the throw path, where a
 *    `BackendRouterHandledError` is unwrapped into its per-backend
 *    failures (main + fallback can both have billed);
 *  - `BackendRouter.executeFallbackCore` — the fallback-SUCCESS path,
 *    where the dispatcher's error path never runs and this module is
 *    the only place the main attempt's spend can be recorded (and the
 *    raw-fallback-error rethrow, which bypasses the dispatcher's
 *    unwrap because the thrown error is not a router wrap).
 *
 * Tagging convention: quota errors keep the spend payload's own
 * `costSource` (`sdk` for Codex/Gemini post-hoc asserts, `sdk_partial`
 * for Claude budget aborts); non-quota decisive failures are tagged
 * `cost_source='post_hoc_error'` so failure-spend rows are queryable
 * as a class.
 */

import type Database from "better-sqlite3";
import type { BackendId } from "@aitne/shared";
import {
  BackendDecisiveFailure,
  BackendQuotaError,
  type BackendQuotaSpend,
} from "../agent-core.js";
import { createLogger } from "../../logging.js";

const logger = createLogger("failure-spend");

/**
 * One recordable failure-spend: which backend billed it, the recovered
 * payload, and the `cost_source` tag the audit row should carry.
 */
export interface FailureSpendInfo {
  backendId: BackendId;
  spend: BackendQuotaSpend;
  costSource: string | null;
}

/**
 * Recover the recordable spend from one backend failure signal.
 * Handles the nested `BackendDecisiveFailure(kind="quota",
 * cause=BackendQuotaError)` wrap the router produces. Returns `null`
 * when the failure carries no spend (nothing billed, or the
 * SDK/CLI surfaced no usage before dying).
 */
export function extractFailureSpendInfo(
  failure: unknown,
): FailureSpendInfo | null {
  const quota = failure instanceof BackendQuotaError
    ? failure
    : failure instanceof BackendDecisiveFailure
        && failure.kind === "quota"
        && failure.cause instanceof BackendQuotaError
      ? failure.cause
      : null;
  if (quota?.spend) {
    return {
      backendId: quota.backendId,
      spend: quota.spend,
      costSource: quota.spend.costSource ?? null,
    };
  }
  if (failure instanceof BackendDecisiveFailure && failure.spend) {
    return {
      backendId: failure.backendId,
      spend: failure.spend,
      costSource: "post_hoc_error",
    };
  }
  return null;
}

/**
 * Per-DB memo of whether `agent_actions` carries the migration-added
 * cache-token columns. Pre-migration databases (the `AuditLogger`
 * guards the same way) must not make the whole best-effort INSERT
 * fail just because the optional columns are absent.
 */
const cacheColumnSupport = new WeakMap<Database.Database, boolean>();

function hasCacheTokenColumns(db: Database.Database): boolean {
  const cached = cacheColumnSupport.get(db);
  if (cached !== undefined) return cached;
  let supported = false;
  try {
    const columns = db
      .prepare("PRAGMA table_info(agent_actions)")
      .all() as Array<{ name: string }>;
    const names = new Set(columns.map((c) => c.name));
    supported = names.has("cache_creation_tokens") && names.has("cache_read_tokens");
  } catch {
    supported = false;
  }
  cacheColumnSupport.set(db, supported);
  return supported;
}

/**
 * Write a `result='failed'` agent_actions row carrying the actual spend
 * for a turn the backend completed (or partially ran) before failing.
 * One row per distinct billed backend attempt — a fallback-success run
 * gets a `failed` row for the main attempt next to the ResultProcessor's
 * `success` row for the fallback.
 *
 * Best-effort: a logging failure must not mask the original control
 * flow — we catch and warn instead of rethrowing.
 */
export function recordFailureSpendRow(
  db: Database.Database,
  event: { correlationId: string; type: string },
  spendInfo: FailureSpendInfo,
  errorMessage: string,
): void {
  const { spend } = spendInfo;
  try {
    const columns: string[] = [
      "event_id",
      "action_type",
      "model_used",
      "cost_usd",
      "tokens_input",
      "tokens_output",
      "duration_ms",
      "num_turns",
      "result",
      "backend",
      "cost_source",
      "error",
      "completed_at",
    ];
    const values: (string | number | null)[] = [
      event.correlationId,
      event.type,
      spend.modelId,
      spend.costUsd,
      spend.usage.inputTokens,
      spend.usage.outputTokens,
      spend.durationMs,
      spend.numTurns,
      "failed",
      spendInfo.backendId,
      spendInfo.costSource,
      errorMessage.slice(0, 4096),
      new Date().toISOString(),
    ];
    if (hasCacheTokenColumns(db)) {
      columns.splice(6, 0, "cache_creation_tokens", "cache_read_tokens");
      values.splice(
        6,
        0,
        spend.usage.cacheCreationInputTokens,
        spend.usage.cacheReadInputTokens,
      );
    }
    const placeholders = columns.map(() => "?").join(", ");
    db.prepare(
      `INSERT INTO agent_actions (${columns.join(", ")}) VALUES (${placeholders})`,
    ).run(...values);
  } catch (err) {
    logger.warn(
      { err, eventType: event.type, backendId: spendInfo.backendId },
      "Failed to record post-hoc failure spend in agent_actions",
    );
  }
}
