import type Database from "better-sqlite3";
import type { BackendId } from "@aitne/shared";
import { hashTaskArgs } from "./delegated-task-runtime.js";
import type { DelegatedTaskCacheEntry } from "./delegated-task-result-cache.js";
import { recordCacheHitAuditRow } from "./delegated-invoker-audit.js";
import { zeroCost } from "./delegated-invoker-utils.js";
import type {
  RunInvokeParams,
  RunInvokeResult,
  TaskInvokeParams,
  TaskInvokeResult,
} from "./delegated-backend-invoker.js";

/**
 * §13 Phase 3.3 — cache-hit response builders. Both functions:
 *   1. Compute the task / schema (and for /run: allowedTools) hashes used
 *      by the dashboard's detail filter.
 *   2. Write a single `'success'`, `cost_source='cache'` audit row via
 *      {@link recordCacheHitAuditRow}.
 *   3. Synthesize the public {@link TaskInvokeResult} / {@link RunInvokeResult}
 *      from the cache entry — `cost: zeroCost()` because the cached
 *      subprocess was the one that spent.
 *
 * Pure pattern A: no instance state, no closures. Cache hits are looked
 * up before the concurrency permit so they do not consume a slot and do
 * not increment the per-day quota counter (the quota counts subprocess
 * invocations, not cache returns).
 */

export function buildCacheHitTaskResult(
  db: Database.Database,
  args: {
    params: TaskInvokeParams;
    hit: DelegatedTaskCacheEntry;
    backendId: BackendId;
    modelId: string;
    now: () => number;
  },
): TaskInvokeResult {
  const nowIso = new Date(args.now()).toISOString();
  const taskHash = hashTaskArgs(args.params.task);
  const schemaHash = hashTaskArgs(args.params.outputSchema);
  recordCacheHitAuditRow(db, {
    actionType: "delegated_task.exec",
    backendId: args.backendId,
    modelId: args.modelId,
    ...(args.params.parentEventId !== undefined
      ? { parentEventId: args.params.parentEventId }
      : {}),
    ...(args.params.parentProcessKey !== undefined
      ? { parentProcessKey: args.params.parentProcessKey }
      : {}),
    timestamp: nowIso,
    toolCallCount: args.hit.trace.length,
    detail: {
      integrationKey: args.params.integrationKey,
      delegatedBackend: args.backendId,
      taskHash,
      schemaHash,
      cacheHit: true,
      toolCallCount: args.hit.trace.length,
      retried: false,
      // §11.2 — cache hits are gated on the original outcome being
      // non-confirmation (see Phase 3.3 cache guard); record this
      // explicitly so the metric aggregator's schema stays uniform
      // across live + cache-hit rows.
      needsConfirmation: false,
    },
  });
  return {
    ok: true,
    result: args.hit.result,
    needsConfirmation: false,
    confirmationPlan: null,
    cost: zeroCost(),
    trace: args.hit.trace,
    backendId: args.backendId,
    modelId: args.modelId,
    retried: false,
  };
}

export function buildCacheHitRunResult(
  db: Database.Database,
  args: {
    params: RunInvokeParams;
    hit: DelegatedTaskCacheEntry;
    backendId: BackendId;
    modelId: string;
    now: () => number;
  },
): RunInvokeResult {
  const nowIso = new Date(args.now()).toISOString();
  const taskHash = hashTaskArgs(args.params.task);
  const schemaHash = hashTaskArgs(args.params.outputSchema);
  const allowedToolsHash = hashTaskArgs(args.params.allowedTools);
  recordCacheHitAuditRow(db, {
    actionType: "delegated_task.run",
    backendId: args.backendId,
    modelId: args.modelId,
    ...(args.params.parentEventId !== undefined
      ? { parentEventId: args.params.parentEventId }
      : {}),
    ...(args.params.parentProcessKey !== undefined
      ? { parentProcessKey: args.params.parentProcessKey }
      : {}),
    timestamp: nowIso,
    toolCallCount: args.hit.trace.length,
    detail: {
      delegatedBackend: args.backendId,
      taskHash,
      schemaHash,
      allowedToolsHash,
      allowedToolsCount: args.params.allowedTools.length,
      cacheHit: true,
      toolCallCount: args.hit.trace.length,
      retried: false,
      // §11.2 — see /exec equivalent.
      needsConfirmation: false,
    },
  });
  return {
    ok: true,
    result: args.hit.result,
    needsConfirmation: false,
    confirmationPlan: null,
    cost: zeroCost(),
    trace: args.hit.trace,
    backendId: args.backendId,
    modelId: args.modelId,
    retried: false,
  };
}
