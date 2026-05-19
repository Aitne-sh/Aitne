import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type Database from "better-sqlite3";
import {
  filterDeniedToolsForBackend,
  getAgentDayDateStr,
  type BackendId,
  type IntegrationKey,
} from "@aitne/shared";
import type { AgentConfig } from "../config.js";
import { createLogger } from "../logging.js";
import {
  DelegatedProxyTimeoutError,
  DelegatedToolUnsupportedError,
  type DelegatedTaskInvokeParams,
  type DelegatedTaskRawErrorClass,
  type DelegatedTaskResultRaw,
  type DelegatedTaskToolStepRaw,
  type DelegatedToolCost,
  type DelegatedToolErrorClass,
  type DelegatedToolResult,
  type IAgentCore,
} from "../core/agent-core.js";
import { readIntegrations } from "../db/integrations-store.js";
import {
  proxyModelIsKnown,
  resolveCanonicalDelegatedModel,
  resolveProcessKeyModel,
} from "../core/backends/proxy-model-registry.js";
import { DELEGATED_PROXY_DEFAULTS } from "./delegated-proxy-config.js";
import {
  buildRetryFollowup,
  buildTaskPrompt,
  classifyStructuredOutput,
  compileSchema,
  detectConfirmationEnvelope,
  detectErrorEnvelope,
  extractAndValidateResult,
  hashTaskArgs,
  resolveAllowedToolPatterns,
  resolveDestructiveToolPatterns,
  resolveRunWriteClassToolPatterns,
  resolveWriteClassToolPatterns,
  wrapSchemaForStructuredOutput,
} from "./delegated-task-runtime.js";
import {
  DelegatedTaskResultCache,
  execScope,
  integrationVersionFor,
  runScope,
  type DelegatedTaskCacheEntry,
  type DelegatedTaskCacheKey,
} from "./delegated-task-result-cache.js";
import {
  DelegatedTaskSessionPool,
  SESSION_POOL_TEMPDIR_PREFIX,
  type SessionPoolLease,
} from "./delegated-task-session-pool.js";
import {
  readRuntimeState,
  writeRuntimeState,
} from "../db/runtime-state.js";
import {
  LegacyOneShotLease,
  mergeCost,
  readFileSyncIfExists,
  stripCodeFences,
  zeroCost,
} from "./delegated-invoker-utils.js";
import {
  completeTaskHeader,
  recordAction,
  recordTaskHeaderInProgress,
  recordTaskToolStep,
} from "./delegated-invoker-audit.js";
import {
  buildCacheHitRunResult,
  buildCacheHitTaskResult,
} from "./delegated-invoker-cache-hits.js";

const logger = createLogger("delegated-proxy-invoker");

/**
 * Public success/failure shape returned to the route handler. The invoker
 * is the chokepoint that decides what HTTP status the daemon should reply
 * with — `errorClass` is enough to disambiguate (route handler maps to
 * 502 / 503 / 504 etc. in Phase B).
 */
export type InvokeResult =
  | {
    ok: true;
    toolResult: unknown;
    cost: DelegatedToolCost;
    backendId: BackendId;
    modelId: string;
  }
  | {
    ok: false;
    errorClass:
      | DelegatedToolErrorClass
      | "delegated_proxy_busy"
      | "precondition"
      | "unimplemented";
    message: string;
    /** Partial cost when subprocess managed to spend before failing. */
    cost?: DelegatedToolCost;
    backendId?: BackendId;
    modelId?: string;
  };

export interface InvokeParams {
  integrationKey: IntegrationKey;
  toolName: string;
  toolArgs: unknown;
  /** Originating event correlation id, for parent attribution. */
  parentEventId?: string;
  /** Originating ProcessKey, becomes `agent_actions.trigger`. */
  parentProcessKey?: string;
  /**
   * Caller-side model id override. Bypasses the user-pin /
   * `resolveCanonicalDelegatedModel` (lite-tier) cascade so cadence-driven
   * callers (e.g. `delegated-sync-worker` pinned to medium tier for cadence
   * reliability) can dictate the model without rewriting the integration's
   * `delegatedModel` and affecting synchronous skill calls. Falls through to
   * the canonical resolution if the override is not registered for the
   * resolved backend.
   */
  modelOverride?: string;
  abortSignal?: AbortSignal;
}

/**
 * DELEGATED-TASK-MODE-DESIGN.md §4.1 — task-mode invocation params. The
 * route handler is responsible for clamping numeric fields against
 * `DELEGATED_TASK_HARD_CAPS` and filling defaults from
 * `config.delegatedTaskDefault*`. By the time params reach the invoker,
 * every numeric field is concrete and within hard-cap bounds.
 */
export interface TaskInvokeParams {
  integrationKey: IntegrationKey;
  task: string;
  outputSchema: Record<string, unknown>;
  maxToolCalls: number;
  maxBudgetUsd: number;
  timeoutMs: number;
  allowDestructive: boolean;
  /** Heavy-tier opt-in. Effective only when `delegatedTaskHeavyEnabled`
   *  is true; otherwise falls back to light. */
  heavy?: boolean;
  /**
   * DELEGATED-TASK-MODE-DESIGN.md §13 Phase 3.3 — opt-in result cache.
   * When `true` AND `config.delegatedTaskCacheEnabled === true` AND the
   * outcome qualifies (success, no confirmation, no write-class tool ran),
   * the result is cached for `delegatedTaskCacheTtlSeconds`. Cache hits
   * still write a `delegated_task.exec` audit row with `cost_usd=0` and
   * `detail.cacheHit=true`. Defaults to `false` — the caller decides per
   * call whether the operation is idempotent enough to cache.
   *
   * MUST NOT be set on a destructive-confirm re-invocation
   * (`allowDestructive: true`) — confirmation does not extend across
   * cache lifetimes; a stale "I sent this email" reply is wrong on the
   * next call.
   */
  cacheable?: boolean;
  parentEventId?: string;
  parentProcessKey?: string;
  abortSignal?: AbortSignal;
}

export type TaskInvokeResult =
  | {
    ok: true;
    result: unknown;
    needsConfirmation: boolean;
    confirmationPlan: string | null;
    cost: DelegatedToolCost;
    trace: DelegatedTaskToolStepRaw[];
    backendId: BackendId;
    modelId: string;
    retried: boolean;
  }
  | {
    ok: false;
    errorClass:
      | DelegatedTaskRawErrorClass
      | "delegated_proxy_busy"
      | "precondition"
      | "task_mode_disabled"
      | "task_quota_exhausted"
      | "post_write_format_failure"
      | "denied_tool";
    message: string;
    /** Raw assistant text when the failure was extraction / validation. */
    raw?: string;
    cost?: DelegatedToolCost;
    trace?: DelegatedTaskToolStepRaw[];
    backendId?: BackendId;
    modelId?: string;
    retried?: boolean;
  };

/**
 * DELEGATED-TASK-MODE-DESIGN.md §4.2 — Phase 2 generic task-mode params.
 * No `integrationKey`: callers target a backend directly with explicit
 * `allowedTools` patterns. The route handler is responsible for body
 * validation (pattern shape, schema size, hard caps); by the time params
 * reach the invoker every numeric is concrete and within bounds.
 *
 * Phase 1 restriction: `delegatedBackend ∈ {claude, gemini}`. Codex is
 * deferred to Phase 1.5 — the route returns 501 before construction here.
 *
 * Per §4.2 last bullet, model tier is fixed `light` server-side; there is
 * no `heavy` field. Allowing per-request escalation would hand a
 * cost-scaling knob to a prompt-injected DM; the heavy ProcessKey opt-in
 * lives at dashboard config.
 */
export interface RunInvokeParams {
  /**
   * Phase 1.5 expanded the union to include "codex" — Codex /run is now
   * supported via daemon-side stream pre-emption (see codex-core.ts
   * `runDelegatedTask`). Earlier phases restricted this to claude/gemini
   * because Codex CLI lacked a per-spawn allowedTools surface.
   */
  delegatedBackend: BackendId;
  /** Validated per `validateRunAllowedTools`; non-empty array of patterns. */
  allowedTools: readonly string[];
  task: string;
  outputSchema: Record<string, unknown>;
  maxToolCalls: number;
  maxBudgetUsd: number;
  timeoutMs: number;
  allowDestructive: boolean;
  /** §13 Phase 3.3 — see `TaskInvokeParams.cacheable`. */
  cacheable?: boolean;
  parentEventId?: string;
  parentProcessKey?: string;
  abortSignal?: AbortSignal;
}

export type RunInvokeResult =
  | {
    ok: true;
    result: unknown;
    needsConfirmation: boolean;
    confirmationPlan: string | null;
    cost: DelegatedToolCost;
    trace: DelegatedTaskToolStepRaw[];
    backendId: BackendId;
    modelId: string;
    retried: boolean;
  }
  | {
    ok: false;
    errorClass:
      | DelegatedTaskRawErrorClass
      | "delegated_proxy_busy"
      | "task_mode_disabled"
      | "task_quota_exhausted"
      | "post_write_format_failure";
    message: string;
    raw?: string;
    cost?: DelegatedToolCost;
    trace?: DelegatedTaskToolStepRaw[];
    backendId?: BackendId;
    modelId?: string;
    retried?: boolean;
  };

export interface DelegatedBackendInvokerDeps {
  db: Database.Database;
  config: AgentConfig;
  /**
   * Resolve a core for the given backend id. The invoker depends on a
   * minimal `IAgentCore` shape (only `runDelegatedTool` is called) so
   * tests can hand it stubs without wiring the full SDK/CLI.
   */
  cores: Partial<Record<BackendId, IAgentCore>>;
  /**
   * Optional canonical-light-model resolver. Phase A leaves the actual
   * resolution wiring to Phase C (it depends on plan-preset config that
   * is not yet stable here). When omitted, the invoker derives a
   * deterministic-but-lazy fallback from the listed models on the core,
   * which is enough to spawn — Phase C will inject a smarter resolver.
   */
  resolveProxyModel?: (
    integrationKey: IntegrationKey,
    backendId: BackendId,
  ) => string;
  /**
   * Override defaults for tests (timeout, queue cap, etc.). Production
   * uses the constants in `delegated-proxy-config.ts`.
   *
   * The mapped type widens each `as const` literal in
   * `DELEGATED_PROXY_DEFAULTS` (e.g. `callTimeoutMs: 120_000` → typed
   * `120000`) back to its base primitive (`number` / `string`). Without
   * this, tests passing `{ callTimeoutMs: 1_000 }` to override a timeout
   * fail with "Type '1000' is not assignable to type '120000'". Production
   * callers supply the constant unchanged so they're unaffected.
   */
  defaults?: Partial<{
    -readonly [K in keyof typeof DELEGATED_PROXY_DEFAULTS]:
      typeof DELEGATED_PROXY_DEFAULTS[K] extends infer V
        ? V extends number ? number : V extends string ? string : V
        : never;
  }>;
  /** Now-source for deterministic tests. Defaults to `Date.now`. */
  now?: () => number;
}

export class DelegatedBackendInvoker {
  private readonly defaults: {
    -readonly [K in keyof typeof DELEGATED_PROXY_DEFAULTS]:
      typeof DELEGATED_PROXY_DEFAULTS[K] extends infer V
        ? V extends number ? number : V extends string ? string : V
        : never;
  };
  private readonly now: () => number;

  /** Inflight permit count (acquired from `maxConcurrent`). */
  private inflight = 0;
  /** FIFO waiters parked when `inflight === maxConcurrent`. */
  private readonly waiters: QueueWaiter[] = [];

  /**
   * DELEGATED-TASK-MODE-DESIGN.md §13 Phase 3.3 — result cache.
   * Constructed lazily on first task() / run() so a daemon that never
   * fires task mode does not hold the LRU map. `null` until the first
   * call observes `delegatedTaskCacheEnabled === true`.
   */
  private resultCache: DelegatedTaskResultCache | null = null;
  /**
   * §13 Phase 3.2 — session-dir pool. Lazy-constructed for the same
   * reason as `resultCache`. Pool is per-invoker so concurrent task
   * runs see a coherent set of idle entries.
   */
  private sessionPool: DelegatedTaskSessionPool | null = null;

  constructor(private readonly deps: DelegatedBackendInvokerDeps) {
    this.defaults = { ...DELEGATED_PROXY_DEFAULTS, ...(deps.defaults ?? {}) };
    this.now = deps.now ?? Date.now;
  }

  /**
   * §13 Phase 3.3 — return the cache, instantiating it if missing or
   * recreating it when the live config has flipped TTL or capacity.
   * Returns null when caching is disabled, in which case callers MUST
   * skip every cache code path (no insertions either, otherwise an
   * emergency disable would still serve from a stale local map).
   */
  private getResultCache(): DelegatedTaskResultCache | null {
    if (!this.deps.config.delegatedTaskCacheEnabled) {
      if (this.resultCache) {
        // Killing the cache mid-window: drop entries so they don't
        // resurface if the flag flips back on.
        this.resultCache.clear();
        this.resultCache = null;
      }
      return null;
    }
    const ttlMs =
      Math.max(1, this.deps.config.delegatedTaskCacheTtlSeconds) * 1000;
    const maxEntries = Math.max(
      1,
      this.deps.config.delegatedTaskCacheMaxEntries,
    );
    if (
      !this.resultCache
      || this.resultCache.stats().ttlMs !== ttlMs
      || this.resultCache.stats().maxEntries !== maxEntries
    ) {
      this.resultCache = new DelegatedTaskResultCache({
        ttlMs,
        maxEntries,
        now: this.now,
      });
    }
    return this.resultCache;
  }

  /**
   * §13 Phase 3.2 — return the pool, instantiating if missing. Returns
   * null when the kill switch is off; the caller falls through to the
   * legacy `makeTempdir` + `cleanupTempdir` path.
   */
  private getSessionPool(): DelegatedTaskSessionPool | null {
    if (!this.deps.config.delegatedTaskSubprocessPoolEnabled) {
      if (this.sessionPool) {
        // Killing the pool mid-window: rm idle dirs so we don't strand
        // them past the disable.
        this.sessionPool.evictAll();
        this.sessionPool = null;
      }
      return null;
    }
    const ttlMs =
      Math.max(1, this.deps.config.delegatedTaskSubprocessPoolTtlSeconds)
      * 1000;
    const maxIdle = this.maxConcurrent;
    if (
      !this.sessionPool
      || this.sessionPool.stats().ttlMs !== ttlMs
      || this.sessionPool.stats().maxIdle !== maxIdle
    ) {
      // Pool config changed — drop the old one so its dirs get rm'd
      // before we start handing out new leases under the new shape.
      this.sessionPool?.evictAll();
      this.sessionPool = new DelegatedTaskSessionPool({
        ttlMs,
        maxIdle,
        materializer: (sessionDir, backendId) =>
          this.materializeProxySession(sessionDir, backendId),
        tempdirPrefix: SESSION_POOL_TEMPDIR_PREFIX,
        sessionsRoot: this.sessionsRoot(),
        now: this.now,
      });
    }
    return this.sessionPool;
  }

  /**
   * §13 Phase 3.2 — release-or-create wrapper. Returns either a pool
   * lease (when pooling is on) or a one-shot synthetic lease (when
   * pooling is off — preserves the legacy makeTempdir + cleanupTempdir
   * flow). Either way the caller follows the lease's release/discard
   * lifecycle.
   *
   * The legacy synthetic lease wraps `makeTempdir()` + the existing
   * janitor cleanup so the rest of the task() / run() body doesn't have
   * to branch on pooling state.
   */
  private acquireSessionDir(args: {
    backendId: BackendId;
    integrationKey: IntegrationKey | null;
    modelId: string;
  }): SessionPoolLease | LegacyOneShotLease {
    const pool = this.getSessionPool();
    if (pool) {
      return pool.acquire({
        backendId: args.backendId,
        integrationKey: args.integrationKey,
        modelId: args.modelId,
      });
    }
    const sessionDir = this.makeTempdir();
    try {
      this.materializeProxySession(sessionDir, args.backendId);
    } catch (err) {
      try {
        rmSync(sessionDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
      throw err;
    }
    return new LegacyOneShotLease(sessionDir, () =>
      this.cleanupTempdir(sessionDir),
    );
  }

  /**
   * Effective concurrency cap — read live so a runtime PATCH /api/config
   * (Phase C5) takes effect on the next call without a daemon restart.
   */
  private get maxConcurrent(): number {
    const cfg = this.deps.config.delegatedProxyMaxConcurrent;
    return typeof cfg === "number" && cfg > 0
      ? cfg
      : this.defaults.defaultMaxConcurrent;
  }

  /** Visibility for tests + future /health.metrics.delegatedProxy facet. */
  get queueDepth(): number {
    return this.waiters.length;
  }

  get inflightCount(): number {
    return this.inflight;
  }

  async invoke(params: InvokeParams): Promise<InvokeResult> {
    // Pre-permit fast path. Avoid spending one of the (default 4) permits —
    // and a potential 60s queue wait — on a request that is obviously
    // invalid right now. No `agent_actions` row is written: the request
    // never held a slot, never spawned, never blocked anyone.
    const fastCheck = this.resolvePreconditions(
      params.integrationKey,
      params.modelOverride,
    );
    if (!fastCheck.ok) {
      return {
        ok: false,
        errorClass: "precondition",
        message: fastCheck.message,
        ...(fastCheck.backendId ? { backendId: fastCheck.backendId } : {}),
      };
    }

    const acquired = await this.acquirePermit();
    if (!acquired.ok) {
      // Queue saturation — surfaces as 503 in the route handler. Don't
      // create a tempdir, don't materialize anything. Cost row is still
      // written (zero-cost) so the dashboard sees a saturation event.
      recordAction(this.deps.db, {
        backendId: fastCheck.backendId,
        modelId: fastCheck.modelId,
        params,
        result: "failed",
        errorClass: "delegated_proxy_busy",
        cost: zeroCost(),
        startedAt: new Date(this.now()).toISOString(),
        completedAt: new Date(this.now()).toISOString(),
        errorMessage: acquired.message,
      });
      return {
        ok: false,
        errorClass: "delegated_proxy_busy",
        message: acquired.message,
        backendId: fastCheck.backendId,
        modelId: fastCheck.modelId,
      };
    }

    // Post-permit re-check. Integration state may have been flipped (mode,
    // delegatedBackend, or delegatedModel) while this request waited up to
    // 60s in the FIFO queue. Running with stale state would materialize the
    // wrong instruction file (e.g. CLAUDE.md against a freshly-switched
    // codex backend) or invoke a core the user just unregistered. We DO
    // record this row — unlike the pre-permit path it consumed a slot and
    // blocked others, so the dashboard should surface the queue waste.
    const liveCheck = this.resolvePreconditions(
      params.integrationKey,
      params.modelOverride,
    );
    if (!liveCheck.ok) {
      this.releasePermit();
      const nowIso = new Date(this.now()).toISOString();
      const message = `integration state changed during queue wait: ${liveCheck.message}`;
      recordAction(this.deps.db, {
        backendId: liveCheck.backendId ?? fastCheck.backendId,
        modelId: fastCheck.modelId,
        params,
        result: "failed",
        errorClass: "precondition",
        cost: zeroCost(),
        startedAt: nowIso,
        completedAt: nowIso,
        errorMessage: message,
      });
      return {
        ok: false,
        errorClass: "precondition",
        message,
        backendId: liveCheck.backendId ?? fastCheck.backendId,
        modelId: fastCheck.modelId,
      };
    }
    const { state, backendId, core, modelId } = liveCheck;
    const maxTurns = this.resolveMaxTurns(state);

    const sessionDir = this.makeTempdir();
    const startMs = this.now();
    const startedAtIso = new Date(startMs).toISOString();
    let toolResult: DelegatedToolResult | null = null;
    let unimplemented = false;
    let unhandledMessage: string | null = null;
    // Default-classify any unhandled exception as a subprocess crash; the
    // wall-clock timeout callback flips this to "timeout" before aborting
    // so the route handler can map to 504 (vs 502/500). Distinct enums
    // also keep failure-rate metrics honest.
    let unhandledClass: "timeout" | "subprocess_crashed" = "subprocess_crashed";
    try {
      this.materializeProxySession(sessionDir, backendId);

      // Build the abort plumbing — combine caller's signal with our own
      // wall-clock timeout so the core sees one signal. Backend-specific
      // overrides (see `callTimeoutMsByBackend` in delegated-proxy-config.ts)
      // win when present so gemini's slower CLI cold-start gets headroom.
      const ac = new AbortController();
      const callTimeoutMs =
        this.defaults.callTimeoutMsByBackend[backendId]
        ?? this.defaults.callTimeoutMs;
      const timeout = setTimeout(() => {
        unhandledClass = "timeout";
        ac.abort(new DelegatedProxyTimeoutError());
      }, callTimeoutMs);
      timeout.unref?.();
      const callerListener = () => ac.abort(params.abortSignal?.reason);
      if (params.abortSignal) {
        if (params.abortSignal.aborted) {
          ac.abort(params.abortSignal.reason);
        } else {
          params.abortSignal.addEventListener("abort", callerListener, {
            once: true,
          });
        }
      }

      try {
        toolResult = await core.runDelegatedTool({
          integrationKey: params.integrationKey,
          toolName: params.toolName,
          toolArgs: params.toolArgs,
          modelId,
          maxTurns,
          maxBudgetUsd: this.defaults.maxBudgetUsd,
          sessionDir,
          abortSignal: ac.signal,
        });
      } catch (err) {
        if (err instanceof DelegatedToolUnsupportedError) {
          unimplemented = true;
        } else {
          unhandledMessage =
            err instanceof Error ? err.message : String(err);
        }
      } finally {
        clearTimeout(timeout);
        params.abortSignal?.removeEventListener("abort", callerListener);
      }
    } finally {
      this.cleanupTempdir(sessionDir);
      this.releasePermit();
    }

    const completedAtIso = new Date(this.now()).toISOString();

    if (unimplemented) {
      recordAction(this.deps.db, {
        backendId,
        modelId,
        params,
        result: "failed",
        errorClass: "unimplemented",
        cost: zeroCost(),
        startedAt: startedAtIso,
        completedAt: completedAtIso,
        errorMessage:
          "runDelegatedTool not implemented on this backend (Phase A stub)",
      });
      return {
        ok: false,
        errorClass: "unimplemented",
        message:
          "delegated proxy backend has not been wired yet — Phase B will land per-backend stream extraction",
        backendId,
        modelId,
      };
    }

    if (unhandledMessage !== null) {
      recordAction(this.deps.db, {
        backendId,
        modelId,
        params,
        result: "failed",
        errorClass: unhandledClass,
        cost: zeroCost(),
        startedAt: startedAtIso,
        completedAt: completedAtIso,
        errorMessage: unhandledMessage,
      });
      return {
        ok: false,
        errorClass: unhandledClass,
        message: unhandledMessage,
        backendId,
        modelId,
      };
    }

    if (!toolResult) {
      // Defensive: should not happen unless runDelegatedTool resolved with
      // null/undefined, which violates the contract.
      recordAction(this.deps.db, {
        backendId,
        modelId,
        params,
        result: "failed",
        errorClass: "parse_error",
        cost: zeroCost(),
        startedAt: startedAtIso,
        completedAt: completedAtIso,
        errorMessage: "core returned null DelegatedToolResult",
      });
      return {
        ok: false,
        errorClass: "parse_error",
        message: "delegated proxy core returned null",
        backendId,
        modelId,
      };
    }

    if (toolResult.ok) {
      recordAction(this.deps.db, {
        backendId,
        modelId,
        params,
        result: "success",
        cost: toolResult.cost,
        startedAt: startedAtIso,
        completedAt: completedAtIso,
      });
      return {
        ok: true,
        toolResult: toolResult.toolResult,
        cost: toolResult.cost,
        backendId,
        modelId,
      };
    }

    recordAction(this.deps.db, {
      backendId,
      modelId,
      params,
      result: "failed",
      errorClass: toolResult.errorClass,
      cost: toolResult.cost,
      startedAt: startedAtIso,
      completedAt: completedAtIso,
      errorMessage: toolResult.message,
    });
    return {
      ok: false,
      errorClass: toolResult.errorClass,
      message: toolResult.message,
      cost: toolResult.cost,
      backendId,
      modelId,
    };
  }

  // ── Preconditions ───────────────────────────────────────────────────────

  /**
   * Resolve the live integration state to a backend + core + model. Called
   * twice per invocation: once before acquiring a permit (fast-fail without
   * spending a slot) and again after the permit (defends against the user
   * flipping mode/backend during a 60s queue wait — the post-permit re-check
   * is the only place we'd notice).
   */
  private resolvePreconditions(
    integrationKey: IntegrationKey,
    modelOverride?: string,
  ):
    | {
      ok: true;
      state: import("@aitne/shared").IntegrationState;
      backendId: BackendId;
      core: IAgentCore;
      modelId: string;
    }
    | { ok: false; message: string; backendId?: BackendId } {
    const state = readIntegrations(this.deps.db)[integrationKey];
    // INTEGRATION_NATIVE_MODE_DESIGN.md §17 (Phase B1 file list) — the
    // invoker must defensively reject every non-delegated mode, including
    // the new `native` mode. A flip from delegated to native during a
    // queued task would otherwise resolve through this path with stale
    // state; failing here forces the caller to re-route through the
    // native MCP surface (§3.3 invariant: native MUST NOT call the
    // daemon proxy).
    if (!state || state.mode !== "delegated" || !state.delegatedBackend) {
      return {
        ok: false,
        message: `integration '${integrationKey}' is not in delegated mode (mode=${state?.mode ?? "missing"}, delegatedBackend=${state?.delegatedBackend ?? "null"}, nativeBackend=${state?.nativeBackend ?? "null"})`,
      };
    }
    const backendId = state.delegatedBackend;
    const core = this.deps.cores[backendId];
    if (!core) {
      return {
        ok: false,
        message: `no agent core registered for backend '${backendId}'`,
        backendId,
      };
    }
    const modelId = this.resolveModel(
      state,
      integrationKey,
      backendId,
      modelOverride,
    );
    return { ok: true, state, backendId, core, modelId };
  }

  // ── Concurrency primitives ──────────────────────────────────────────────

  private async acquirePermit(): Promise<
    { ok: true } | { ok: false; message: string }
  > {
    if (this.inflight < this.maxConcurrent) {
      this.inflight++;
      return { ok: true };
    }
    return new Promise((resolve) => {
      const waiter: QueueWaiter = {
        // Resolved by `releasePermit` when this waiter is at the head.
        // Must INCREMENT inflight at resolve time (not queue time) so that
        // concurrent acquires don't all see the same low inflight count.
        wake: () => {
          if (waiter.settled) return;
          waiter.settled = true;
          clearTimeout(waiter.timer);
          this.inflight++;
          resolve({ ok: true });
        },
        timer: setTimeout(() => {
          if (waiter.settled) return;
          waiter.settled = true;
          // Remove from queue so releasePermit doesn't try to wake us.
          const idx = this.waiters.indexOf(waiter);
          if (idx >= 0) this.waiters.splice(idx, 1);
          resolve({
            ok: false,
            message: `delegated proxy queue wait exceeded ${this.defaults.queueWaitTimeoutMs}ms`,
          });
        }, this.defaults.queueWaitTimeoutMs),
        settled: false,
      };
      waiter.timer.unref?.();
      this.waiters.push(waiter);
    });
  }

  private releasePermit(): void {
    this.inflight--;
    // Wake the head of the FIFO queue if any. The wake() handler
    // re-increments inflight, so the net change is zero.
    while (this.waiters.length > 0) {
      const next = this.waiters.shift()!;
      if (!next.settled) {
        next.wake();
        return;
      }
    }
  }

  // ── Tempdir + materialization ───────────────────────────────────────────

  /**
   * Path layout matches existing event sessions for filesystem locality —
   * the DELEGATED-PROXY design says "same root as existing event-driven
   * sessions" (§4.4); the actual root in this codebase is `agent-sessions/`.
   */
  private sessionsRoot(): string {
    return join(this.deps.config.dataDir, "agent-sessions");
  }

  private makeTempdir(): string {
    const dir = join(
      this.sessionsRoot(),
      `${this.defaults.tempdirPrefix}${randomUUID()}`,
    );
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
  }

  private cleanupTempdir(sessionDir: string): void {
    try {
      rmSync(sessionDir, { recursive: true, force: true });
    } catch (err) {
      logger.warn({ err, sessionDir }, "proxy tempdir cleanup failed");
    }
  }

  /**
   * Materialize the minimal proxy session: just the proxy profile rendered
   * into the backend-specific instruction file (CLAUDE.md / AGENTS.md /
   * GEMINI.md). No skills, no MCP config, no character block — the proxy
   * profile itself is the entire instruction. Per-backend tool-listing
   * for the connector is the core's responsibility (it knows its native
   * MCP namespace).
   */
  private materializeProxySession(sessionDir: string, backendId: BackendId): void {
    const profilePath = join(
      this.deps.config.workspaceDir,
      "agent-assets",
      "agent-profiles",
      "proxy.md",
    );
    let body: string;
    try {
      body = readFileSyncIfExists(profilePath)
        ?? FALLBACK_PROXY_PROFILE;
    } catch {
      body = FALLBACK_PROXY_PROFILE;
    }
    // Mirror `cliInstructionFileName` in skills-compiler.ts so opencode
    // proxy sessions don't silently land at GEMINI.md (opencode reads
    // AGENTS.md). Even though the integration registry currently filters
    // opencode out of delegated mode (`NATIVE_CONNECTOR_BACKEND_IDS`),
    // this function takes any BackendId — defensive correctness keeps
    // the proxy materialization aligned with the rest of the workdir
    // helpers if that invariant ever changes.
    const filename =
      backendId === "claude" ? "CLAUDE.md"
        : backendId === "codex" || backendId === "opencode" ? "AGENTS.md"
          : "GEMINI.md";
    const target = join(sessionDir, filename);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, body, "utf-8");
  }

  // The five `agent_actions` row-writers (recordAction,
  // recordCacheHitAuditRow, recordTaskHeaderInProgress, completeTaskHeader,
  // recordTaskToolStep) live in `delegated-invoker-audit.ts`; the two
  // cache-hit result builders (buildCacheHitTaskResult /
  // buildCacheHitRunResult) live in `delegated-invoker-cache-hits.ts`.
  // Call sites pass `this.deps.db` and `this.now` explicitly — see
  // file-split-plan.md §9.

  // ── Model resolution ────────────────────────────────────────────────────

  private resolveModel(
    state: import("@aitne/shared").IntegrationState,
    integrationKey: IntegrationKey,
    backendId: BackendId,
    modelOverride?: string,
  ): string {
    // Caller-side override (cadence path passes medium tier — see
    // `delegated-sync-worker.ts`). Wins above the user pin so an operator
    // who pinned Haiku for synchronous skill calls does not also force the
    // cadence onto Haiku. Falls through to the standard cascade if the
    // override is not registered for this backend (e.g. operator hand-edited
    // an unknown model id).
    if (
      modelOverride
      && proxyModelIsKnown(this.deps.db, backendId, modelOverride)
    ) {
      return modelOverride;
    }
    if (this.deps.resolveProxyModel) {
      return this.deps.resolveProxyModel(integrationKey, backendId);
    }
    // DELEGATED-PROXY-API-DESIGN.md §4.2 — user pin wins iff still
    // resolvable for the current backend. After a `delegatedBackend`
    // swap a leftover Claude model id silently falls through to the
    // canonical light-tier pick; the dashboard surfaces the staleness
    // with a "Reset to default" affordance.
    const pinned = state.delegatedModel ?? null;
    if (pinned && proxyModelIsKnown(this.deps.db, backendId, pinned)) {
      return pinned;
    }
    const canonical = resolveCanonicalDelegatedModel(backendId, this.deps.db);
    if (canonical) return canonical;
    // Registry has no lite-tier entry for this backend — fall back to the
    // first model the live core advertises. Keeps the proxy callable when
    // a backend's model registry is mid-redaction (e.g. a deprecated-only
    // listing during a model rotation).
    const core = this.deps.cores[backendId];
    const models = core?.listModels?.() ?? [];
    if (models.length > 0) {
      const lite = models.find((m) => m.tier === "lite");
      return (lite ?? models[0]).modelId;
    }
    return "auto";
  }

  /**
   * Per-call maxTurns. Reads `state.delegatedMaxTurns` when set, otherwise
   * the registry default (DELEGATED_PROXY_DEFAULTS.maxTurns = 2).
   *
   * v0.1 surfaces no dashboard UI for `delegatedMaxTurns` (DELEGATED-PROXY-
   * API-DESIGN.md §4.2 / §13 Q3) but the daemon writes the integrations
   * blob to `~/.personal-agent/integrations.md` for hand-edit, so a user
   * who needs more turns for a connector that does a tool-list lookup
   * before the call (e.g. `list_labels` then `apply_labels`) can edit the
   * file and have it respected without waiting for UI to land.
   *
   * Schema bound is 1..10; defensively clamp here in case a hand-edit
   * slipped through (the schema runs in withDefaults, but a future zod
   * relaxation shouldn't silently let an unbounded value through to the
   * subprocess core).
   */
  private resolveMaxTurns(
    state: import("@aitne/shared").IntegrationState,
  ): number {
    const pinned = state.delegatedMaxTurns;
    if (typeof pinned !== "number" || !Number.isFinite(pinned)) {
      return this.defaults.maxTurns;
    }
    if (pinned < 1) return 1;
    if (pinned > 10) return 10;
    return Math.floor(pinned);
  }

  // ── Task mode ─────────────────────────────────────────────────────────────

  /**
   * DELEGATED-TASK-MODE-DESIGN.md §4.1 — task-mode chokepoint. Mirrors
   * `invoke()`'s lifecycle (preconditions → permit → spawn → audit) but:
   *   - resolves model + allowed tools via the runtime helpers
   *   - writes a `delegated_task.exec` header row BEFORE spawning so step
   *     rows can FK back to its `id`
   *   - applies the §6.2 single-retry rule (only when no destructive /
   *     write-class tool ran)
   *   - returns a structured envelope (result OR confirmation OR error)
   */
  async task(params: TaskInvokeParams): Promise<TaskInvokeResult> {
    if (!this.deps.config.delegatedTaskModeEnabled) {
      return {
        ok: false,
        errorClass: "task_mode_disabled",
        message:
          "Task mode is currently disabled (config.delegatedTaskModeEnabled=false). Re-enable via PATCH /api/config { delegatedTaskModeEnabled: true }, or flip an integration to delegated to auto-enable.",
      };
    }

    // Daily quota check — pre-permit so a 429 doesn't burn a slot.
    const today = getAgentDayDateStr(
      this.deps.config.timezone,
      this.deps.config.dayBoundaryHour,
    );
    const quotaCap = this.deps.config.delegatedTaskMaxPerDay;
    const quotaCount = this.readTaskCount(today);
    if (quotaCap > 0 && quotaCount >= quotaCap) {
      return {
        ok: false,
        errorClass: "task_quota_exhausted",
        message: `Daily task-mode quota reached (${quotaCount}/${quotaCap}); resets at the next agent-day boundary.`,
      };
    }

    // Phase 1.5 landed Codex /exec — `runDelegatedTask` is now wired on
    // CodexCore via daemon-side stream pre-emption. The previous
    // `delegatedBackend === "codex"` short-circuit (501
    // task_mode_unsupported) is gone; the same fastCheck below resolves
    // the Codex core and lets the call flow through.
    const fastCheck = this.resolvePreconditions(params.integrationKey);
    if (!fastCheck.ok) {
      return {
        ok: false,
        errorClass: "precondition",
        message: fastCheck.message,
        ...(fastCheck.backendId ? { backendId: fastCheck.backendId } : {}),
      };
    }

    // §13 Phase 3.3 — opportunistic cache lookup BEFORE acquiring a permit.
    // A cache hit completes in microseconds; making it queue behind in-flight
    // tasks would defeat the latency win. We still write an audit row on
    // hit (cost 0, detail.cacheHit=true) so dashboard accounting stays
    // accurate. Only attempted when the caller opted in AND the operation
    // is read-only by intent (`allowDestructive: false`) — destructive
    // confirm flows must always re-plan.
    if (
      params.cacheable === true
      && params.allowDestructive === false
    ) {
      const cache = this.getResultCache();
      if (cache) {
        const cacheKey: DelegatedTaskCacheKey = {
          scope: execScope(params.integrationKey),
          task: params.task,
          outputSchema: params.outputSchema,
          modelId: fastCheck.modelId,
          backendId: fastCheck.backendId,
          allowDestructive: params.allowDestructive,
          integrationVersion: integrationVersionFor(fastCheck.state),
        };
        const hit = cache.get(cacheKey);
        if (hit) {
          return buildCacheHitTaskResult(this.deps.db, {
            params,
            hit,
            backendId: fastCheck.backendId,
            modelId: fastCheck.modelId,
            now: this.now,
          });
        }
      }
    }

    const acquired = await this.acquirePermit();
    if (!acquired.ok) {
      return {
        ok: false,
        errorClass: "delegated_proxy_busy",
        message: acquired.message,
        backendId: fastCheck.backendId,
      };
    }

    // Post-permit re-check (mirrors invoke()).
    const liveCheck = this.resolvePreconditions(params.integrationKey);
    if (!liveCheck.ok) {
      this.releasePermit();
      return {
        ok: false,
        errorClass: "precondition",
        message: `integration state changed during queue wait: ${liveCheck.message}`,
        backendId: liveCheck.backendId ?? fastCheck.backendId,
      };
    }
    // Codex /exec is supported (Phase 1.5+); no backend-specific
    // short-circuit is needed here. The post-permit re-check above
    // already handles state changes that might have invalidated the
    // resolved core.
    const { state, backendId, core } = liveCheck;

    // Resolve allowed + destructive tool patterns.
    const denyPatterns = state.deniedTools ?? [];
    const expandedDeny = filterDeniedToolsForBackend(
      params.integrationKey,
      backendId,
      denyPatterns,
    ).active;
    const allowedTools = resolveAllowedToolPatterns({
      integrationKey: params.integrationKey,
      delegatedBackend: backendId,
      allowDestructive: params.allowDestructive,
      deniedTools: expandedDeny,
    });
    if (allowedTools.length === 0) {
      this.releasePermit();
      return {
        ok: false,
        errorClass: "denied_tool",
        message: `Every tool in the ${params.integrationKey} connector is denied — task mode has no surface to plan against.`,
        backendId,
      };
    }
    const destructiveToolPatterns = resolveDestructiveToolPatterns(
      params.integrationKey,
      backendId,
    );
    // §6.2 / §7.4 — superset of destructiveTools used by the cores to
    // detect write-class tool calls (e.g. `create_draft`, `update_draft`,
    // `respond_to_event`) that should suppress the single retry. These
    // are NOT removed from `allowedTools` even when allowDestructive=false
    // because they are reversible — the user asked for the action — but
    // a fresh subprocess re-running them on retry would create a second
    // draft / second RSVP / etc.
    const writeClassToolPatterns = resolveWriteClassToolPatterns(
      params.integrationKey,
      backendId,
    );

    // Resolve model. Heavy is opt-in via config; otherwise fall back to
    // light (canonical proxy model). The §17 rationale is in the design
    // doc — we never let the request body select the tier.
    const heavy = !!params.heavy && this.deps.config.delegatedTaskHeavyEnabled;
    const modelId = this.resolveTaskModel(backendId, heavy);

    // Compile schema once; reused across the §6.2 retry.
    const validator = compileSchema(params.outputSchema);
    // §13 Phase 3.1 — schema bound to Claude SDK `outputFormat`. The
    // wrap-helper currently returns the user schema verbatim (see
    // `prepareStructuredOutputSchema` rationale in delegated-task-runtime.ts):
    // top-level `oneOf` admitting confirmation/error envelopes is unverified
    // against Anthropic's stricter validator, so we picked the conservative
    // shape. When the SDK rejects the model's emission and exhausts its
    // internal retries, the model's raw text fallback flows back through
    // `rawAssistantText`, where `detectConfirmationEnvelope` /
    // `detectErrorEnvelope` route it correctly. Cores that don't support
    // structured output (Gemini, Codex) ignore the field.
    const structuredOutputEnabled =
      this.deps.config.delegatedTaskStructuredOutputEnabled === true;
    const wrappedSchema = structuredOutputEnabled
      ? wrapSchemaForStructuredOutput(params.outputSchema)
      : undefined;

    // Render system prompt.
    const systemPrompt = buildTaskPrompt({
      task: params.task,
      outputSchema: params.outputSchema,
      allowedToolPatterns: allowedTools,
      destructiveToolNamespaced: destructiveToolPatterns,
      maxToolCalls: params.maxToolCalls,
      timeoutMs: params.timeoutMs,
      maxBudgetUsd: params.maxBudgetUsd,
      allowDestructive: params.allowDestructive,
    });

    // §13 Phase 3.2 — acquire a session dir from the pool when enabled,
    // else materialize a fresh tempdir. Either path returns a lease the
    // task() loop releases (or discards on subprocess failure) in the
    // outer `finally`.
    let sessionLease: SessionPoolLease | LegacyOneShotLease;
    try {
      sessionLease = this.acquireSessionDir({
        backendId,
        integrationKey: params.integrationKey,
        modelId,
      });
    } catch (err) {
      this.releasePermit();
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        errorClass: "subprocess_crashed",
        message: `failed to materialize session directory: ${message}`,
        backendId,
        modelId,
      };
    }
    const sessionDir = sessionLease.sessionDir;
    const startMs = this.now();
    const startedAtIso = new Date(startMs).toISOString();
    const taskHash = hashTaskArgs(params.task);
    const schemaHash = hashTaskArgs(params.outputSchema);

    // §11.1 — write header row BEFORE spawn so step rows can FK to its id.
    const headerId = recordTaskHeaderInProgress(this.deps.db, {
      actionType: "delegated_task.exec",
      backendId,
      modelId,
      ...(params.parentEventId !== undefined ? { parentEventId: params.parentEventId } : {}),
      ...(params.parentProcessKey !== undefined
        ? { parentProcessKey: params.parentProcessKey }
        : {}),
      startedAt: startedAtIso,
      detail: {
        integrationKey: params.integrationKey,
        delegatedBackend: backendId,
        taskHash,
        schemaHash,
      },
    });

    // Build abort plumbing — task mode uses the request-body timeout
    // (clamped at hard cap) as the wall-clock; backend-specific
    // overrides do not apply here.
    const ac = new AbortController();
    const timeout = setTimeout(() => {
      ac.abort(new DelegatedProxyTimeoutError("delegated task wall-clock timeout"));
    }, params.timeoutMs);
    timeout.unref?.();
    const callerListener = () => ac.abort(params.abortSignal?.reason);
    if (params.abortSignal) {
      if (params.abortSignal.aborted) {
        ac.abort(params.abortSignal.reason);
      } else {
        params.abortSignal.addEventListener("abort", callerListener, {
          once: true,
        });
      }
    }

    let attempt = 0;
    const maxAttempts = 2;
    let aggregatedTrace: DelegatedTaskToolStepRaw[] = [];
    let aggregatedCost: DelegatedToolCost = zeroCost();
    let writeClassToolFiredEver = false;
    let lastRaw: string | undefined;
    let outcome: TaskInvokeResult | null = null;
    let retried = false;

    try {
      while (attempt < maxAttempts) {
        attempt += 1;
        let coreResult: DelegatedTaskResultRaw;
        try {
          // §6.2 — on the retry, we must re-send the entire system
          // prompt (task + schema + tool list) AND the retry instruction.
          // Each `runDelegatedTask` spawns a fresh subprocess with no
          // session memory; sending only the retry follow-up would leave
          // the model without the original task or schema, guaranteeing
          // another validation failure. Append the retry instruction to
          // the original prompt so the model recovers from the same
          // context it had on attempt #1.
          const retryClass: "parse_error" | "schema_violation" =
            outcome?.ok === false
              && (outcome.errorClass === "parse_error"
                || outcome.errorClass === "schema_violation")
              ? outcome.errorClass
              : "parse_error";
          const promptForAttempt = attempt === 1
            ? systemPrompt
            : `${systemPrompt}\n\n## Retry\n\n${buildRetryFollowup({
              errorClass: retryClass,
              message: outcome?.ok === false ? outcome.message : "",
            })}`;
          coreResult = await core.runDelegatedTask({
            integrationKey: params.integrationKey,
            systemPrompt: promptForAttempt,
            validate: validator as (value: unknown) => boolean,
            validatorErrorMessage: () =>
              (validator.errors ?? [])
                .map((e) => `${e.instancePath || "/"} ${e.message ?? "invalid"}`)
                .join("; "),
            allowedTools,
            destructiveTools: destructiveToolPatterns,
            writeClassTools: writeClassToolPatterns,
            modelId,
            maxToolCalls: params.maxToolCalls,
            maxBudgetUsd: params.maxBudgetUsd,
            timeoutMs: params.timeoutMs,
            allowDestructive: params.allowDestructive,
            sessionDir,
            abortSignal: ac.signal,
            // §13 Phase 3.1 — structured output. Cores that don't honor
            // the flag (Gemini, Codex) ignore both fields and fall back
            // to text emission, which the invoker then parses + validates.
            structuredOutputEnabled,
            ...(wrappedSchema ? { wrappedSchema } : {}),
            onToolStep: (step) => {
              recordTaskToolStep(this.deps.db, {
                parentTaskActionId: headerId,
                backendId,
                modelId,
                integrationKey: params.integrationKey,
                step,
              });
            },
          } satisfies DelegatedTaskInvokeParams);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          coreResult = {
            ok: false,
            errorClass: "subprocess_crashed",
            message,
            cost: zeroCost(),
            trace: [],
            writeClassToolFired: false,
          };
        }

        aggregatedTrace = aggregatedTrace.concat(coreResult.trace);
        aggregatedCost = mergeCost(aggregatedCost, coreResult.cost);
        writeClassToolFiredEver =
          writeClassToolFiredEver || coreResult.writeClassToolFired;

        if (!coreResult.ok) {
          outcome = {
            ok: false,
            errorClass: coreResult.errorClass,
            message: coreResult.message,
            ...(coreResult.rawAssistantText
              ? { raw: coreResult.rawAssistantText }
              : {}),
            cost: aggregatedCost,
            trace: aggregatedTrace,
            backendId,
            modelId,
            retried,
          };
          break;
        }

        lastRaw = coreResult.rawAssistantText;

        // §13 Phase 3.1 — when the core supplied a pre-validated
        // `structuredOutput`, classify it directly and skip the text
        // extraction path. The wrapper schema admits the §7.2 confirmation
        // envelope and §5.1 error envelopes, so `classifyStructuredOutput`
        // routes them to the same outcomes the text path would.
        const classification = coreResult.structuredOutput !== undefined
          ? classifyStructuredOutput(coreResult.structuredOutput, validator)
          : null;
        if (classification && classification.ok && "envelope" in classification) {
          if (classification.envelope === "confirmation") {
            const conf = detectConfirmationEnvelope(classification.value);
            outcome = {
              ok: true,
              result: classification.value,
              needsConfirmation: true,
              confirmationPlan: conf?.plan ?? "",
              cost: aggregatedCost,
              trace: aggregatedTrace,
              backendId,
              modelId,
              retried,
            };
            break;
          }
          if (classification.envelope === "error") {
            const env = detectErrorEnvelope(classification.value);
            outcome = {
              ok: false,
              errorClass: env?.errorClass ?? "tool_failed",
              message: env?.message ?? "subprocess returned error envelope",
              raw: JSON.stringify(classification.value),
              cost: aggregatedCost,
              trace: aggregatedTrace,
              backendId,
              modelId,
              retried,
            };
            break;
          }
          // envelope === "result" — happy path
          outcome = {
            ok: true,
            result: classification.value,
            needsConfirmation: false,
            confirmationPlan: null,
            cost: aggregatedCost,
            trace: aggregatedTrace,
            backendId,
            modelId,
            retried,
          };
          break;
        }
        if (classification && !classification.ok) {
          // SDK validated against wrapped schema but our narrower user
          // schema rejected — bias toward post-write failure when
          // applicable, otherwise fall through to retry path with the
          // SDK-supplied error class. We fall through to the existing
          // extraction path below by setting `parsed` so the same retry
          // / write-class logic applies.
          if (writeClassToolFiredEver) {
            outcome = {
              ok: false,
              errorClass: "post_write_format_failure",
              message: classification.message,
              raw: classification.raw,
              cost: aggregatedCost,
              trace: aggregatedTrace,
              backendId,
              modelId,
              retried,
            };
            break;
          }
          if (attempt < maxAttempts) {
            retried = true;
            outcome = {
              ok: false,
              errorClass: classification.errorClass,
              message: classification.message,
              raw: classification.raw,
              cost: aggregatedCost,
              trace: aggregatedTrace,
              backendId,
              modelId,
              retried,
            };
            continue;
          }
          outcome = {
            ok: false,
            errorClass: classification.errorClass,
            message: classification.message,
            raw: classification.raw,
            cost: aggregatedCost,
            trace: aggregatedTrace,
            backendId,
            modelId,
            retried,
          };
          break;
        }

        // §6.2 — extract + validate. On parse/schema failure, retry once
        // ONLY if no write-class tool ran. Confirmation envelope and
        // error envelope short-circuit before validation.
        const stripped = coreResult.rawAssistantText;
        let parsed: unknown;
        try {
          parsed = JSON.parse(stripCodeFences(stripped));
        } catch {
          parsed = null;
        }
        const confirmation = parsed != null
          ? detectConfirmationEnvelope(parsed)
          : null;
        if (confirmation) {
          outcome = {
            ok: true,
            result: parsed,
            needsConfirmation: true,
            confirmationPlan: confirmation.plan,
            cost: aggregatedCost,
            trace: aggregatedTrace,
            backendId,
            modelId,
            retried,
          };
          break;
        }
        const errorEnvelope = parsed != null
          ? detectErrorEnvelope(parsed)
          : null;
        if (errorEnvelope) {
          outcome = {
            ok: false,
            errorClass: errorEnvelope.errorClass,
            message: errorEnvelope.message,
            raw: stripped,
            cost: aggregatedCost,
            trace: aggregatedTrace,
            backendId,
            modelId,
            retried,
          };
          break;
        }
        const extraction = extractAndValidateResult(stripped, validator);
        if (extraction.ok) {
          outcome = {
            ok: true,
            result: extraction.value,
            needsConfirmation: false,
            confirmationPlan: null,
            cost: aggregatedCost,
            trace: aggregatedTrace,
            backendId,
            modelId,
            retried,
          };
          break;
        }
        // Validation failure path.
        if (writeClassToolFiredEver) {
          // §7.4 idempotency rule — no retry after a write.
          outcome = {
            ok: false,
            errorClass: "post_write_format_failure",
            message: extraction.message,
            raw: extraction.raw,
            cost: aggregatedCost,
            trace: aggregatedTrace,
            backendId,
            modelId,
            retried,
          };
          break;
        }
        if (attempt < maxAttempts) {
          retried = true;
          outcome = {
            ok: false,
            errorClass: extraction.errorClass,
            message: extraction.message,
            raw: extraction.raw,
            cost: aggregatedCost,
            trace: aggregatedTrace,
            backendId,
            modelId,
            retried,
          };
          // Loop again for the single retry.
          continue;
        }
        outcome = {
          ok: false,
          errorClass: extraction.errorClass,
          message: extraction.message,
          raw: extraction.raw,
          cost: aggregatedCost,
          trace: aggregatedTrace,
          backendId,
          modelId,
          retried,
        };
        break;
      }
    } finally {
      clearTimeout(timeout);
      params.abortSignal?.removeEventListener("abort", callerListener);
      // §13 Phase 3.2 — release the lease back to the pool when pooling
      // is enabled (otherwise the synthetic lease cleans up its tempdir).
      // We DISCARD instead of release when a write-class tool fired
      // mid-task: the dir is fine to reuse, but if a future invariant
      // change adds per-task state on disk (e.g. cached MCP tool
      // listings keyed by allowDestructive), the discard path stays
      // safe. Currently no per-task state lands on disk, so release
      // would also be correct — but discard is the conservative choice.
      if (writeClassToolFiredEver) {
        sessionLease.discard();
      } else {
        sessionLease.release();
      }
      this.releasePermit();
    }

    const completedAtIso = new Date(this.now()).toISOString();

    // §8.3 — bump the per-day task quota counter on every settled task
    // (success and failure both consumed the budget).
    this.incrementTaskCount(today);

    // §13 Phase 3.3 — write to cache when:
    //   - caller opted in (`cacheable: true`)
    //   - the cache is enabled live
    //   - the outcome is a clean read-only success (no confirmation, no
    //     write-class tool fired). Confirmation envelopes and write-class
    //     touches MUST NOT be cached — see the §6.2/§7.4 idempotency rule.
    if (
      params.cacheable === true
      && params.allowDestructive === false
      && outcome?.ok === true
      && outcome.needsConfirmation === false
      && writeClassToolFiredEver === false
    ) {
      const cache = this.getResultCache();
      if (cache) {
        const cacheKey: DelegatedTaskCacheKey = {
          scope: execScope(params.integrationKey),
          task: params.task,
          outputSchema: params.outputSchema,
          modelId,
          backendId,
          allowDestructive: params.allowDestructive,
          // Use the live state (post-permit) so a deniedTools mutation
          // mid-task invalidates the entry on the very next call.
          integrationVersion: integrationVersionFor(state),
        };
        const entry: DelegatedTaskCacheEntry = {
          result: outcome.result,
          needsConfirmation: false,
          confirmationPlan: null,
          cost: aggregatedCost,
          trace: aggregatedTrace,
          backendId,
          modelId,
          retried: false,
        };
        cache.set(cacheKey, entry);
      }
    }

    // §11.1 — finalise the header row.
    completeTaskHeader(this.deps.db, {
      headerId,
      result: outcome?.ok ? "success" : "failed",
      cost: aggregatedCost,
      completedAt: completedAtIso,
      errorClass: outcome?.ok === false ? outcome.errorClass : null,
      errorMessage: outcome?.ok === false ? outcome.message : null,
      retried,
      toolCallCount: aggregatedTrace.length,
      detail: {
        integrationKey: params.integrationKey,
        delegatedBackend: backendId,
        taskHash,
        schemaHash,
        toolCallCount: aggregatedTrace.length,
        retried,
        // §11.2 metric `delegated_task_destructive_blocked` keys off this
        // flag — true when allowDestructive=false and the subprocess
        // returned a confirmation envelope instead of executing the
        // destructive tool.
        needsConfirmation: outcome?.ok === true && outcome.needsConfirmation === true,
        ...(outcome?.ok === false ? { errorClass: outcome.errorClass } : {}),
      },
    });

    // §11.3 — one INFO line per task summarizing the outcome.
    logger.info(
      {
        integrationKey: params.integrationKey,
        backendId,
        modelId,
        taskLen: params.task.length,
        toolCallCount: aggregatedTrace.length,
        costUsd: aggregatedCost.costUsd,
        durationMs: aggregatedCost.durationMs,
        result: outcome?.ok ? "success" : "failed",
        ...(outcome?.ok === false ? { errorClass: outcome.errorClass } : {}),
        ...(outcome?.ok === true && outcome.needsConfirmation === true
          ? { needsConfirmation: true }
          : {}),
        retried,
      },
      "delegated task complete",
    );

    if (!outcome) {
      // Defensive: should not happen.
      return {
        ok: false,
        errorClass: "subprocess_crashed",
        message: "task settled without producing an outcome",
        backendId,
        modelId,
        cost: aggregatedCost,
        trace: aggregatedTrace,
        retried,
      };
    }
    if (lastRaw && outcome.ok && outcome.confirmationPlan === null) {
      // Successful path — drop the raw text from the response.
    }
    return outcome;
  }

  /**
   * DELEGATED-TASK-MODE-DESIGN.md §4.2 — Phase 2 generic task mode.
   * Mirror of `task()` but with no `integrationKey`: the caller pins
   * `delegatedBackend` and `allowedTools` patterns directly. Designed
   * for unregistered MCPs the user installed via `gemini mcp add` /
   * `claude mcp add` (etc.) that lack an `INTEGRATION_DESCRIPTORS` entry.
   *
   * Differences from `task()`:
   *   - No registry / `INTEGRATION_DESCRIPTORS` lookup. The caller's
   *     `allowedTools` is the only scoping signal.
   *   - `destructiveTools = []` — the registry has no destructive list
   *     to consult. Per §7.1 the caller takes responsibility for that
   *     classification; the absolute-block layer is still applied at
   *     the core.
   *   - Write-class set is derived from `allowedTools` via
   *     {@link resolveRunWriteClassToolPatterns} (verb-segment heuristic
   *     biased toward false-positive write-class). Phase 2 keeps the
   *     §6.2 retry rule honest without a connector descriptor.
   *   - Model tier is fixed `light` server-side (§4.2 last bullet);
   *     no `heavy` field on the request body.
   *   - Action type is `'delegated_task.run'` so dashboard filters can
   *     separate generic Phase 2 traffic from registered-integration
   *     Phase 1 traffic.
   *
   * Risk tier (route-side): Approve. The route handler is the chokepoint
   * that enforces Bearer auth — see §13 Phase 2 deliverables.
   */
  async run(params: RunInvokeParams): Promise<RunInvokeResult> {
    if (!this.deps.config.delegatedTaskModeEnabled) {
      return {
        ok: false,
        errorClass: "task_mode_disabled",
        message:
          "Task mode is currently disabled (config.delegatedTaskModeEnabled=false). Re-enable via PATCH /api/config { delegatedTaskModeEnabled: true }, or flip an integration to delegated to auto-enable.",
      };
    }

    // §8.3 — quota counter is shared across /exec + /run; both kinds of
    // task consume the same per-day budget so a runaway /run loop cannot
    // starve /exec or vice versa.
    const today = getAgentDayDateStr(
      this.deps.config.timezone,
      this.deps.config.dayBoundaryHour,
    );
    const quotaCap = this.deps.config.delegatedTaskMaxPerDay;
    const quotaCount = this.readTaskCount(today);
    if (quotaCap > 0 && quotaCount >= quotaCap) {
      return {
        ok: false,
        errorClass: "task_quota_exhausted",
        message: `Daily task-mode quota reached (${quotaCount}/${quotaCap}); resets at the next agent-day boundary.`,
      };
    }

    // Phase 1.5 landed Codex /run support — no backend-specific
    // short-circuit needed. The core resolution below surfaces the
    // backend-not-registered case as `subprocess_crashed`.
    const backendId = params.delegatedBackend;
    const core = this.deps.cores[backendId];
    if (!core) {
      // Boot ordering: the requested backend is not registered with this
      // invoker (e.g. claude-only deployment). Surface as
      // subprocess_crashed so the route returns 500 rather than a
      // misleading auth_error. The dashboard surfaces the underlying
      // backend wiring on /api/health.
      return {
        ok: false,
        errorClass: "subprocess_crashed",
        message: `no agent core registered for backend '${backendId}'`,
        backendId,
      };
    }

    // §13 Phase 3.3 — opportunistic cache lookup BEFORE permit acquisition.
    // The /run path uses `runScope(allowedTools)` so two callers with the
    // same MCP allowedTools share a cache slot; different patterns force
    // a miss. Same constraints as /exec: caller must opt in AND the
    // operation must be read-only by intent (allowDestructive=false).
    const runModelId = this.resolveTaskModel(backendId, /* heavy */ false);
    if (params.cacheable === true && params.allowDestructive === false) {
      const cache = this.getResultCache();
      if (cache) {
        const cacheKey: DelegatedTaskCacheKey = {
          scope: runScope(params.allowedTools),
          task: params.task,
          outputSchema: params.outputSchema,
          modelId: runModelId,
          backendId,
          allowDestructive: params.allowDestructive,
          // /run has no integration state — empty version stamps the
          // cache slot but never invalidates from external mutation.
          // Caller-controlled allowedTools changes already invalidate via
          // the `runScope` hash above.
          integrationVersion: "",
        };
        const hit = cache.get(cacheKey);
        if (hit) {
          return buildCacheHitRunResult(this.deps.db, {
            params,
            hit,
            backendId,
            modelId: runModelId,
            now: this.now,
          });
        }
      }
    }

    const acquired = await this.acquirePermit();
    if (!acquired.ok) {
      return {
        ok: false,
        errorClass: "delegated_proxy_busy",
        message: acquired.message,
        backendId,
      };
    }

    // No mid-flight precondition re-check — there is no integration
    // state to flip during the queue wait. The kill switch is the only
    // mutable gate, and we tolerate it silently because: (a) the §6.2
    // retry would already be in-flight; (b) the boot janitor cleans up
    // any orphan in-progress rows; (c) the cost is bounded by the
    // wall-clock and budget caps the request already pinned.

    // Caller-supplied allowedTools is the entire scoping surface. We
    // do NOT subtract anything — there is no per-integration deniedTools
    // to enforce. The absolute-block layer is applied at the core's
    // `disallowedTools` (Claude SDK) or admin-policy TOML (Gemini).
    const allowedTools = [...params.allowedTools];

    // §7.1 — destructive set is empty by design (the caller owns that
    // classification for unregistered MCPs). We still pass an array so
    // the core's admin-policy / disallowedTools synthesis lands on a
    // stable shape; an empty array is a no-op for both backends.
    const destructiveToolPatterns: string[] = [];

    // §6.2 / §7.4 — write-class derivation from the caller's allowedTools
    // patterns. Verb-segment heuristic biased toward false-positive
    // write-class; documented in `resolveRunWriteClassToolPatterns`.
    const writeClassToolPatterns =
      resolveRunWriteClassToolPatterns(params.allowedTools);

    // §4.2 last bullet — model tier is fixed `light` server-side.
    // Heavy is intentionally not selectable per request to prevent a
    // prompt-injected DM from escalating cost. Reuse the modelId
    // resolved earlier for the cache lookup so a slow model resolver
    // isn't called twice.
    const modelId = runModelId;

    // Compile schema once; reused across the §6.2 retry.
    const validator = compileSchema(params.outputSchema);
    // §13 Phase 3.1 — same structured-output bridge as task(): the helper
    // returns the user schema verbatim today. Cores that don't honor the
    // flag (Gemini, Codex) fall back to text emission, which the invoker
    // parses + validates below.
    const structuredOutputEnabled =
      this.deps.config.delegatedTaskStructuredOutputEnabled === true;
    const wrappedSchema = structuredOutputEnabled
      ? wrapSchemaForStructuredOutput(params.outputSchema)
      : undefined;

    const systemPrompt = buildTaskPrompt({
      task: params.task,
      outputSchema: params.outputSchema,
      allowedToolPatterns: allowedTools,
      // §5.1 — the destructive list is empty for /run; the prompt
      // template renders a "(none)" sentinel and falls through to the
      // generic destructive-confirmation prose when allowDestructive=false.
      destructiveToolNamespaced: destructiveToolPatterns,
      maxToolCalls: params.maxToolCalls,
      timeoutMs: params.timeoutMs,
      maxBudgetUsd: params.maxBudgetUsd,
      allowDestructive: params.allowDestructive,
    });

    // §13 Phase 3.2 — pool acquisition with `integrationKey: null` since
    // /run has no registered integration scope.
    let sessionLease: SessionPoolLease | LegacyOneShotLease;
    try {
      sessionLease = this.acquireSessionDir({
        backendId,
        integrationKey: null,
        modelId,
      });
    } catch (err) {
      this.releasePermit();
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        errorClass: "subprocess_crashed",
        message: `failed to materialize session directory: ${message}`,
        backendId,
        modelId,
      };
    }
    const sessionDir = sessionLease.sessionDir;
    const startMs = this.now();
    const startedAtIso = new Date(startMs).toISOString();
    const taskHash = hashTaskArgs(params.task);
    const schemaHash = hashTaskArgs(params.outputSchema);
    const allowedToolsHash = hashTaskArgs(allowedTools);

    // §11.1 — header row BEFORE spawn so step rows can FK to it.
    const headerId = recordTaskHeaderInProgress(this.deps.db, {
      actionType: "delegated_task.run",
      backendId,
      modelId,
      ...(params.parentEventId !== undefined ? { parentEventId: params.parentEventId } : {}),
      ...(params.parentProcessKey !== undefined
        ? { parentProcessKey: params.parentProcessKey }
        : {}),
      startedAt: startedAtIso,
      detail: {
        delegatedBackend: backendId,
        taskHash,
        schemaHash,
        allowedToolsHash,
        allowedToolsCount: allowedTools.length,
      },
    });

    const ac = new AbortController();
    const timeout = setTimeout(() => {
      ac.abort(new DelegatedProxyTimeoutError("delegated task wall-clock timeout"));
    }, params.timeoutMs);
    timeout.unref?.();
    const callerListener = () => ac.abort(params.abortSignal?.reason);
    if (params.abortSignal) {
      if (params.abortSignal.aborted) {
        ac.abort(params.abortSignal.reason);
      } else {
        params.abortSignal.addEventListener("abort", callerListener, {
          once: true,
        });
      }
    }

    let attempt = 0;
    const maxAttempts = 2;
    let aggregatedTrace: DelegatedTaskToolStepRaw[] = [];
    let aggregatedCost: DelegatedToolCost = zeroCost();
    let writeClassToolFiredEver = false;
    let outcome: RunInvokeResult | null = null;
    let retried = false;

    try {
      while (attempt < maxAttempts) {
        attempt += 1;
        let coreResult: DelegatedTaskResultRaw;
        try {
          const retryClass: "parse_error" | "schema_violation" =
            outcome?.ok === false
              && (outcome.errorClass === "parse_error"
                || outcome.errorClass === "schema_violation")
              ? outcome.errorClass
              : "parse_error";
          const promptForAttempt = attempt === 1
            ? systemPrompt
            : `${systemPrompt}\n\n## Retry\n\n${buildRetryFollowup({
              errorClass: retryClass,
              message: outcome?.ok === false ? outcome.message : "",
            })}`;
          coreResult = await core.runDelegatedTask({
            // No integrationKey — runtime helpers tolerate undefined; cores
            // do not consult this field.
            systemPrompt: promptForAttempt,
            validate: validator as (value: unknown) => boolean,
            validatorErrorMessage: () =>
              (validator.errors ?? [])
                .map((e) => `${e.instancePath || "/"} ${e.message ?? "invalid"}`)
                .join("; "),
            allowedTools,
            destructiveTools: destructiveToolPatterns,
            writeClassTools: writeClassToolPatterns,
            modelId,
            maxToolCalls: params.maxToolCalls,
            maxBudgetUsd: params.maxBudgetUsd,
            timeoutMs: params.timeoutMs,
            allowDestructive: params.allowDestructive,
            sessionDir,
            abortSignal: ac.signal,
            structuredOutputEnabled,
            ...(wrappedSchema ? { wrappedSchema } : {}),
            onToolStep: (step) => {
              recordTaskToolStep(this.deps.db, {
                parentTaskActionId: headerId,
                backendId,
                modelId,
                step,
              });
            },
          } satisfies DelegatedTaskInvokeParams);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          coreResult = {
            ok: false,
            errorClass: "subprocess_crashed",
            message,
            cost: zeroCost(),
            trace: [],
            writeClassToolFired: false,
          };
        }

        aggregatedTrace = aggregatedTrace.concat(coreResult.trace);
        aggregatedCost = mergeCost(aggregatedCost, coreResult.cost);
        writeClassToolFiredEver =
          writeClassToolFiredEver || coreResult.writeClassToolFired;

        if (!coreResult.ok) {
          outcome = {
            ok: false,
            errorClass: coreResult.errorClass,
            message: coreResult.message,
            ...(coreResult.rawAssistantText
              ? { raw: coreResult.rawAssistantText }
              : {}),
            cost: aggregatedCost,
            trace: aggregatedTrace,
            backendId,
            modelId,
            retried,
          };
          break;
        }

        // §13 Phase 3.1 — structured-output-first path mirrors task().
        const classification = coreResult.structuredOutput !== undefined
          ? classifyStructuredOutput(coreResult.structuredOutput, validator)
          : null;
        if (classification && classification.ok && "envelope" in classification) {
          if (classification.envelope === "confirmation") {
            const conf = detectConfirmationEnvelope(classification.value);
            outcome = {
              ok: true,
              result: classification.value,
              needsConfirmation: true,
              confirmationPlan: conf?.plan ?? "",
              cost: aggregatedCost,
              trace: aggregatedTrace,
              backendId,
              modelId,
              retried,
            };
            break;
          }
          if (classification.envelope === "error") {
            const env = detectErrorEnvelope(classification.value);
            outcome = {
              ok: false,
              errorClass: env?.errorClass ?? "tool_failed",
              message: env?.message ?? "subprocess returned error envelope",
              raw: JSON.stringify(classification.value),
              cost: aggregatedCost,
              trace: aggregatedTrace,
              backendId,
              modelId,
              retried,
            };
            break;
          }
          outcome = {
            ok: true,
            result: classification.value,
            needsConfirmation: false,
            confirmationPlan: null,
            cost: aggregatedCost,
            trace: aggregatedTrace,
            backendId,
            modelId,
            retried,
          };
          break;
        }
        if (classification && !classification.ok) {
          if (writeClassToolFiredEver) {
            outcome = {
              ok: false,
              errorClass: "post_write_format_failure",
              message: classification.message,
              raw: classification.raw,
              cost: aggregatedCost,
              trace: aggregatedTrace,
              backendId,
              modelId,
              retried,
            };
            break;
          }
          if (attempt < maxAttempts) {
            retried = true;
            outcome = {
              ok: false,
              errorClass: classification.errorClass,
              message: classification.message,
              raw: classification.raw,
              cost: aggregatedCost,
              trace: aggregatedTrace,
              backendId,
              modelId,
              retried,
            };
            continue;
          }
          outcome = {
            ok: false,
            errorClass: classification.errorClass,
            message: classification.message,
            raw: classification.raw,
            cost: aggregatedCost,
            trace: aggregatedTrace,
            backendId,
            modelId,
            retried,
          };
          break;
        }

        // Text-extraction fallback (Gemini, or Claude with structured
        // output disabled).
        const stripped = coreResult.rawAssistantText;
        let parsed: unknown;
        try {
          parsed = JSON.parse(stripCodeFences(stripped));
        } catch {
          parsed = null;
        }
        const confirmation = parsed != null
          ? detectConfirmationEnvelope(parsed)
          : null;
        if (confirmation) {
          outcome = {
            ok: true,
            result: parsed,
            needsConfirmation: true,
            confirmationPlan: confirmation.plan,
            cost: aggregatedCost,
            trace: aggregatedTrace,
            backendId,
            modelId,
            retried,
          };
          break;
        }
        const errorEnvelope = parsed != null
          ? detectErrorEnvelope(parsed)
          : null;
        if (errorEnvelope) {
          outcome = {
            ok: false,
            errorClass: errorEnvelope.errorClass,
            message: errorEnvelope.message,
            raw: stripped,
            cost: aggregatedCost,
            trace: aggregatedTrace,
            backendId,
            modelId,
            retried,
          };
          break;
        }
        const extraction = extractAndValidateResult(stripped, validator);
        if (extraction.ok) {
          outcome = {
            ok: true,
            result: extraction.value,
            needsConfirmation: false,
            confirmationPlan: null,
            cost: aggregatedCost,
            trace: aggregatedTrace,
            backendId,
            modelId,
            retried,
          };
          break;
        }
        if (writeClassToolFiredEver) {
          outcome = {
            ok: false,
            errorClass: "post_write_format_failure",
            message: extraction.message,
            raw: extraction.raw,
            cost: aggregatedCost,
            trace: aggregatedTrace,
            backendId,
            modelId,
            retried,
          };
          break;
        }
        if (attempt < maxAttempts) {
          retried = true;
          outcome = {
            ok: false,
            errorClass: extraction.errorClass,
            message: extraction.message,
            raw: extraction.raw,
            cost: aggregatedCost,
            trace: aggregatedTrace,
            backendId,
            modelId,
            retried,
          };
          continue;
        }
        outcome = {
          ok: false,
          errorClass: extraction.errorClass,
          message: extraction.message,
          raw: extraction.raw,
          cost: aggregatedCost,
          trace: aggregatedTrace,
          backendId,
          modelId,
          retried,
        };
        break;
      }
    } finally {
      clearTimeout(timeout);
      params.abortSignal?.removeEventListener("abort", callerListener);
      // §13 Phase 3.2 — same release/discard rule as task().
      if (writeClassToolFiredEver) {
        sessionLease.discard();
      } else {
        sessionLease.release();
      }
      this.releasePermit();
    }

    const completedAtIso = new Date(this.now()).toISOString();

    // §8.3 — bump the shared per-day quota counter.
    this.incrementTaskCount(today);

    // §13 Phase 3.3 — cache write mirrors task(), with `runScope` keyed
    // off the caller's allowedTools.
    if (
      params.cacheable === true
      && params.allowDestructive === false
      && outcome?.ok === true
      && outcome.needsConfirmation === false
      && writeClassToolFiredEver === false
    ) {
      const cache = this.getResultCache();
      if (cache) {
        const cacheKey: DelegatedTaskCacheKey = {
          scope: runScope(params.allowedTools),
          task: params.task,
          outputSchema: params.outputSchema,
          modelId,
          backendId,
          allowDestructive: params.allowDestructive,
          integrationVersion: "",
        };
        cache.set(cacheKey, {
          result: outcome.result,
          needsConfirmation: false,
          confirmationPlan: null,
          cost: aggregatedCost,
          trace: aggregatedTrace,
          backendId,
          modelId,
          retried: false,
        });
      }
    }

    // §11.1 — finalise the header row.
    completeTaskHeader(this.deps.db, {
      headerId,
      result: outcome?.ok ? "success" : "failed",
      cost: aggregatedCost,
      completedAt: completedAtIso,
      errorClass: outcome?.ok === false ? outcome.errorClass : null,
      errorMessage: outcome?.ok === false ? outcome.message : null,
      retried,
      toolCallCount: aggregatedTrace.length,
      detail: {
        delegatedBackend: backendId,
        taskHash,
        schemaHash,
        allowedToolsHash,
        allowedToolsCount: allowedTools.length,
        toolCallCount: aggregatedTrace.length,
        retried,
        // §11.2 — see /exec equivalent above.
        needsConfirmation: outcome?.ok === true && outcome.needsConfirmation === true,
        ...(outcome?.ok === false ? { errorClass: outcome.errorClass } : {}),
      },
    });

    // §11.3 — one INFO line per /run task.
    logger.info(
      {
        backendId,
        modelId,
        taskLen: params.task.length,
        toolCallCount: aggregatedTrace.length,
        costUsd: aggregatedCost.costUsd,
        durationMs: aggregatedCost.durationMs,
        allowedToolsCount: allowedTools.length,
        result: outcome?.ok ? "success" : "failed",
        ...(outcome?.ok === false ? { errorClass: outcome.errorClass } : {}),
        ...(outcome?.ok === true && outcome.needsConfirmation === true
          ? { needsConfirmation: true }
          : {}),
        retried,
      },
      "delegated run task complete",
    );

    if (!outcome) {
      return {
        ok: false,
        errorClass: "subprocess_crashed",
        message: "task settled without producing an outcome",
        backendId,
        modelId,
        cost: aggregatedCost,
        trace: aggregatedTrace,
        retried,
      };
    }
    return outcome;
  }

  /**
   * Resolve the model for a task-mode call.
   *
   * §8.1 resolution order — first match wins:
   *   1. `process_backend_config(delegated_task | delegated_task_heavy)`
   *      with `main_backend == backendId` — honors dashboard-configured
   *      per-process model pins (e.g. user pins Haiku 4.5 for
   *      `delegated_task` on Claude). The ProcessKey constants
   *      `delegated_task` / `delegated_task_heavy` exist in
   *      `packages/shared/src/process-key.ts:51-52` precisely so the
   *      dashboard's process-config surface can target them.
   *   2. Heavy: first registered heavy-tier model for the backend.
   *      Light: canonical proxy model (`backend_global_defaults` →
   *      registry default).
   *   3. First registered model on the live core (`auto` if none — keeps
   *      the call alive when a backend's registry is mid-rotation).
   *
   * Heavy is opt-in via `config.delegatedTaskHeavyEnabled`; when the
   * config flag is `false` the heavy ProcessKey falls through to light.
   */
  private resolveTaskModel(backendId: BackendId, heavy: boolean): string {
    const useHeavy = heavy && this.deps.config.delegatedTaskHeavyEnabled;
    const processKey = useHeavy ? "delegated_task_heavy" : "delegated_task";

    // Step 1: dashboard / process_backend_config override.
    const pinned = resolveProcessKeyModel(this.deps.db, processKey, backendId);
    if (pinned) return pinned;

    // Step 2: heavy-task fallback to first registered high-tier model.
    if (useHeavy) {
      const core = this.deps.cores[backendId];
      const models = core?.listModels?.() ?? [];
      const highModel = models.find((m) => m.tier === "high");
      if (highModel) return highModel.modelId;
    }

    // Step 3: canonical lite-tier delegated model (registry + global default).
    const canonical = resolveCanonicalDelegatedModel(backendId, this.deps.db);
    if (canonical) return canonical;

    // Step 4: live-core fallback.
    const core = this.deps.cores[backendId];
    const models = core?.listModels?.() ?? [];
    if (models.length > 0) {
      const lite = models.find((m) => m.tier === "lite");
      return (lite ?? models[0]).modelId;
    }
    return "auto";
  }

  // ── Per-day task-mode quota counter ───────────────────────────────────────

  private readTaskCount(today: string): number {
    const state = readRuntimeState<{ date: string; count: number }>(
      this.deps.db,
      DELEGATED_TASK_COUNT_STATE_KEY,
    );
    if (!state || state.date !== today) return 0;
    return state.count;
  }

  private incrementTaskCount(today: string): void {
    try {
      const state = readRuntimeState<{ date: string; count: number }>(
        this.deps.db,
        DELEGATED_TASK_COUNT_STATE_KEY,
      );
      const nextCount = state && state.date === today ? state.count + 1 : 1;
      writeRuntimeState(this.deps.db, DELEGATED_TASK_COUNT_STATE_KEY, {
        date: today,
        count: nextCount,
      });
    } catch (err) {
      logger.warn({ err }, "failed to increment delegated task quota counter");
    }
  }
}

interface QueueWaiter {
  wake: () => void;
  timer: NodeJS.Timeout;
  settled: boolean;
}

const FALLBACK_PROXY_PROFILE = `# Delegated Proxy

Call the named tool exactly once with the JSON arguments given verbatim.
Do not narrate, do not summarize, do not call any other tool — with one
exception: if the named tool's schema is not yet loaded, call ToolSearch
to load it, then immediately call the named tool. Do not browse other
tools. If the tool errors, return the error verbatim.
`;

/**
 * DELEGATED-TASK-MODE-DESIGN.md §8.3 — runtime_state key for the per-day
 * task-mode quota counter. Resets at the agent-day boundary; mirrors the
 * Gemini per-day request counter shape.
 */
const DELEGATED_TASK_COUNT_STATE_KEY = "delegated_task_count_today";

// Boot-time janitors live in `delegated-invoker-janitors.ts`. Re-export
// here so `index.ts` and tests that import from this module keep working
// without an import-path churn — see file-split-plan.md §6.
export {
  runDelegatedTaskOrphanJanitor,
  runProxyTempdirJanitor,
} from "./delegated-invoker-janitors.js";
