import type { Hono } from "hono";
import type Database from "better-sqlite3";
import {
  DELEGATED_TASK_HARD_CAPS,
  INTEGRATION_DESCRIPTORS,
  isIntegrationKey,
  type IntegrationBackendConnector,
  type IntegrationKey,
} from "@aitne/shared";
import { checkOutputSchema } from "../../../services/delegated-task-runtime.js";
import { readIntegrations } from "../../../db/integrations-store.js";
import { readJsonBody } from "../../json-body.js";
import { createLogger } from "../../../logging.js";
import { composeIssue, respondWithAgentError } from "../../helpers/agent-errors.js";
import { extractWriteItemIds } from "../../../services/integrations/extract-write-item-id.js";
import { markIntegrationWrite } from "../../../safety/integration-write-tracker.js";
import type { ApiDependencies } from "../../server.js";

const logger = createLogger("integrations-api");

/**
 * Register `POST /integrations/:key/exec` — task-mode delegated invocation
 * (DELEGATED-TASK-MODE-DESIGN.md §4.1).
 *
 * Pre-flight order (cheapest first; matches the dormant /invoke ordering):
 *   1. Integration is registered (404 unknown_integration).
 *   2. Body is valid JSON (400 invalid_json_body).
 *   3. Body fields parse: task non-empty string, outputSchema present
 *      and within 4 KB, caps within hard bounds, allowDestructive bool.
 *   4. Kill switch (config.delegatedTaskModeEnabled): 503 if false.
 *   5. Integration is delegated with non-null delegatedBackend (409).
 *   6. x-session-backend header (if set) ≠ delegatedBackend (409 same
 *      defense-in-depth as /invoke — same-backend should use native MCP).
 *   7. Invoker wired (501).
 *
 * Risk tier: Autonomous (no Bearer required). Tool-level safety lives
 * in `state.deniedTools` + `destructiveTools`, both enforced at the
 * chokepoint by the invoker.
 */
export function registerExecRoutes(app: Hono, deps: ApiDependencies): void {
  app.post("/integrations/:key/exec", async (c) => {
    const key = c.req.param("key");
    if (!isIntegrationKey(key)) {
      return respondWithAgentError(c, 404, [
        composeIssue("integrations.unknown_integration", {
          field: "key",
          received: key,
        }),
      ], { legacyFields: { key } });
    }

    const parsedBody = await readJsonBody(c);
    if (!parsedBody.ok) return parsedBody.response;

    const body = parsedBody.body as
      | {
        task?: unknown;
        outputSchema?: unknown;
        maxToolCalls?: unknown;
        maxBudgetUsd?: unknown;
        timeoutMs?: unknown;
        allowDestructive?: unknown;
        heavy?: unknown;
        // DELEGATED-TASK-MODE-DESIGN.md §13 Phase 3.3 — opt-in result
        // cache. The invoker honors this only when both `cacheable: true`
        // is set AND `config.delegatedTaskCacheEnabled === true`. Caller
        // is responsible for setting this only on idempotent reads;
        // setting it on a destructive-confirm re-invocation is a logic
        // bug and the invoker silently won't cache that path anyway
        // (allowDestructive=true short-circuits the cache check).
        cacheable?: unknown;
      }
      | null;

    // Field-level validation. Each branch maps to `validation_error` /
    // `schema_too_large` per §10.
    if (typeof body?.task !== "string" || body.task.trim().length === 0) {
      return c.json(
        {
          error: "validation_error",
          message: "`task` must be a non-empty string",
        },
        400,
      );
    }
    const schemaCheck = checkOutputSchema(body.outputSchema);
    if (!schemaCheck.ok) {
      const errorCode = schemaCheck.reason === "too_large"
        ? "schema_too_large"
        : "validation_error";
      return c.json(
        {
          error: errorCode,
          message: schemaCheck.message,
          field: "outputSchema",
        },
        400,
      );
    }
    const outputSchema = body.outputSchema as Record<string, unknown>;

    const config = deps.config;
    if (!config.delegatedTaskModeEnabled) {
      return c.json(
        {
          error: "task_mode_disabled",
          // Auto-enable on `PATCH /api/integrations/:key` to delegated
          // (and the matching startup heal in `index.ts`) make this
          // path a deliberate operator action: the flag was either
          // explicitly disabled via `PATCH /api/config` or its
          // emergency-disable use case fired. Surface that fact rather
          // than promising a dashboard toggle that does not exist.
          message:
            "Task mode is currently disabled (config.delegatedTaskModeEnabled=false). Re-enable via PATCH /api/config { delegatedTaskModeEnabled: true }, or flip an integration to delegated to auto-enable.",
          integration: key,
          mode: "delegated",
        },
        503,
      );
    }

    const allowDestructive = body.allowDestructive === true;
    const maxToolCalls = clampNumber(
      body.maxToolCalls,
      config.delegatedTaskDefaultMaxToolCalls,
      1,
      DELEGATED_TASK_HARD_CAPS.maxToolCalls,
    );
    if (maxToolCalls === null) {
      return c.json(
        {
          error: "validation_error",
          message: `maxToolCalls must be an integer between 1 and ${DELEGATED_TASK_HARD_CAPS.maxToolCalls}`,
        },
        400,
      );
    }
    const maxBudgetUsd = clampNumber(
      body.maxBudgetUsd,
      config.delegatedTaskDefaultMaxBudgetUsd,
      0,
      DELEGATED_TASK_HARD_CAPS.maxBudgetUsd,
      true,
    );
    if (maxBudgetUsd === null) {
      return c.json(
        {
          error: "validation_error",
          message: `maxBudgetUsd must be a number between 0 and ${DELEGATED_TASK_HARD_CAPS.maxBudgetUsd}`,
        },
        400,
      );
    }
    const timeoutMs = clampNumber(
      body.timeoutMs,
      config.delegatedTaskDefaultTimeoutMs,
      1000,
      DELEGATED_TASK_HARD_CAPS.maxTimeoutMs,
    );
    if (timeoutMs === null) {
      return c.json(
        {
          error: "validation_error",
          message: `timeoutMs must be an integer between 1000 and ${DELEGATED_TASK_HARD_CAPS.maxTimeoutMs}`,
        },
        400,
      );
    }

    if (!deps.delegatedInvoker) {
      return c.json(
        {
          error: "unimplemented",
          message: "delegated invoker is not wired into this daemon instance",
          integration: key,
          backend: null,
          mode: "delegated",
        },
        501,
      );
    }

    const state = readIntegrations(deps.db)[key];
    if (!state || state.mode !== "delegated" || !state.delegatedBackend) {
      return c.json(
        {
          error: "mode_mismatch",
          message: `${key} is not in delegated mode (mode=${state?.mode ?? "missing"})`,
          integration: key,
          backend: null,
          mode: "delegated",
        },
        409,
      );
    }
    // Codex task mode landed in Phase 1.5 — daemon-side stream pre-emption
    // (see codex-core.ts `runDelegatedTask`) gates allowed-tools / destructive
    // calls without relying on a CLI-level allowedTools surface. The 501
    // short-circuit that previously fired here for `state.delegatedBackend
    // === "codex"` is gone; Codex /exec requests now flow through the
    // invoker like Claude and Gemini.
    const sessionBackendHeader = c.req.header("x-session-backend");
    if (
      sessionBackendHeader
      && sessionBackendHeader === state.delegatedBackend
    ) {
      return c.json(
        {
          error: "mode_mismatch",
          message: `session backend matches delegatedBackend (${sessionBackendHeader}) — use native MCP instead`,
          integration: key,
          backend: state.delegatedBackend,
          mode: "delegated",
        },
        409,
      );
    }

    const result = await deps.delegatedInvoker.task({
      integrationKey: key,
      task: body.task.trim(),
      outputSchema,
      maxToolCalls,
      maxBudgetUsd,
      timeoutMs,
      allowDestructive,
      heavy: body.heavy === true,
      // §13 Phase 3.3 — pass-through opt-in. Defense-in-depth: the
      // invoker also enforces `allowDestructive === false` before
      // checking the cache, so a buggy caller that sets cacheable on a
      // destructive task can't poison the cache.
      cacheable: body.cacheable === true,
      parentEventId: c.req.header("x-event-id"),
      parentProcessKey: c.req.header("x-process-key"),
    });

    // INTEGRATION-DRIFT-DETECTION-PLAN.md §11 Phase 4 — actor
    // attribution at the /exec chokepoint. /invoke called this once per
    // request because there was a single tool. /exec is a loop: walk
    // the trace and mark every successful destructive step.
    //
    // Runs BEFORE the result.ok / error split because failed tasks
    // still strand real side effects in the trace:
    //   - timeout / subprocess_crashed / loop_aborted / budget_exhausted:
    //     earlier ok steps already landed before the wall-clock /
    //     budget / turn cap fired.
    //   - schema_violation / parse_error: the model called the tool
    //     successfully and then mis-formatted its final JSON. The §6.2
    //     retry is suppressed when `writeClassToolFired` is true, so
    //     the side effect landed exactly once and needs marking
    //     exactly once.
    //   - policy_violation: the violating step is `status: "error"`
    //     (Codex aborts before pairing) but earlier ok destructive
    //     steps in the same task are still real.
    // Skipping the loop on failure was the same shape of bug as the
    // old /invoke→/exec migration miss: an agent-issued send_email
    // that schema-violates on output would land in Gmail, return 502,
    // and surface as "I noticed you sent…" on the next reconcile.
    //
    // Bare-tool resolution: trace `toolName` is the fully-qualified
    // `mcp__server__tool` (or dotted `server.tool`) form the core
    // observed mid-stream. Strip `connector.toolNamespace` to recover
    // the bare name for the destructiveTools membership check; if the
    // namespace doesn't match, the tool wasn't from this connector
    // (e.g. an internal Read/Write step) and we ignore it.
    //
    // Each trace step carries the upstream `toolResult` (the cores
    // JSON-parse the connector response when possible, fall back to
    // raw string). extractWriteItemIds first walks the response
    // shape (recovers id-in-response writes — send_email,
    // create_event, notion-create-pages) and then falls back to
    // args-side extraction (recovers id-in-args writes — delete /
    // update / label / archive). Older snapshots / stub cores that
    // don't populate toolResult degrade to args-only without crashing.
    //
    // `result.trace` is required on the success union and optional on
    // the error union — guard with truthiness.
    if (result.trace && result.trace.length > 0) {
      const descriptor = INTEGRATION_DESCRIPTORS[key];
      const connector = descriptor.backendConnectors[state.delegatedBackend];
      if (connector) {
        const namespace = connector.toolNamespace;
        for (const step of result.trace) {
          if (step.status !== "ok") continue;
          if (!step.toolName.startsWith(namespace)) continue;
          const bareTool = step.toolName.slice(namespace.length);
          if (!connector.destructiveTools.includes(bareTool)) continue;
          maybeMarkIntegrationWrite(deps.db, {
            integration: key,
            connector,
            bareTool,
            toolResult: step.toolResult,
            args: step.toolArgs,
          });
        }
      }
    }

    if (result.ok) {
      return c.json({
        result: result.result,
        needsConfirmation: result.needsConfirmation,
        confirmationPlan: result.confirmationPlan,
        trace: result.trace,
        cost: result.cost,
      });
    }

    const status = mapTaskErrorClassToHttpStatus(result.errorClass);
    return c.json(
      {
        error: result.errorClass,
        message: result.message,
        ...(result.raw !== undefined ? { raw: result.raw } : {}),
        ...(result.trace ? { trace: result.trace } : {}),
        ...(result.cost ? { cost: result.cost } : {}),
        integration: key,
        backend: result.backendId ?? state.delegatedBackend,
        mode: "delegated",
      },
      status,
    );
  });
}

/**
 * Clamp a numeric request-body field to [min, max], applying `defaultValue`
 * when omitted. Returns null on invalid input (NaN / wrong type), letting
 * the caller surface a validation_error. When `allowFloat` is true (used
 * for USD budgets), accepts floating-point; otherwise integer-only.
 */
function clampNumber(
  raw: unknown,
  defaultValue: number,
  min: number,
  max: number,
  allowFloat = false,
): number | null {
  if (raw === undefined || raw === null) return defaultValue;
  if (typeof raw !== "number" || !Number.isFinite(raw)) return null;
  if (!allowFloat && !Number.isInteger(raw)) return null;
  if (raw < min || raw > max) return null;
  return raw;
}

type TaskHttpStatus = 403 | 409 | 429 | 500 | 501 | 502 | 503 | 504;

/**
 * DELEGATED-TASK-MODE-DESIGN.md §10 — map the task-mode error class to an
 * HTTP status code. Mirrors the design's table 1:1.
 */
function mapTaskErrorClassToHttpStatus(errorClass: string): TaskHttpStatus {
  switch (errorClass) {
    case "task_mode_disabled":
      return 503;
    case "task_quota_exhausted":
      return 429;
    case "task_mode_unsupported":
      return 501;
    case "delegated_proxy_busy":
      return 503;
    case "denied_tool":
      return 403;
    case "precondition":
      return 409;
    case "auth_error":
      return 502;
    case "tool_failed":
    case "tool_unavailable":
    case "parse_error":
    case "schema_violation":
    case "policy_violation":
    case "post_write_format_failure":
    case "loop_aborted":
    case "budget_exhausted":
      return 502;
    case "timeout":
    case "cancelled":
      return 504;
    case "subprocess_crashed":
    default:
      return 500;
  }
}

/**
 * INTEGRATION-DRIFT-DETECTION-PLAN.md §11 Phase 4 — delegated chokepoint
 * actor attribution. Branches on `connector.destructiveTools` membership;
 * non-destructive tools (search / read / list) are left untouched. For
 * write tools we run the response-shape extractor and fall back to args-
 * shape extraction (for `{ ok: true }`-only label / archive responses);
 * each surfaced id is marked in the persistent `integration_writes`
 * table with the per-integration default TTL.
 *
 * Called from one surface today:
 *   - The `/exec` success path — once per successful destructive trace
 *     step. Each trace entry carries the parsed upstream `toolResult`,
 *     so the response-shape extractor and the args-side fallback both
 *     fire normally (id-in-response writes like send_email /
 *     create_event / notion-create-pages are recovered in addition to
 *     id-in-args deletes / updates / labels).
 *
 * The historical `/invoke` route called the same helper once per call
 * with the full upstream `result.toolResult`; it was retired 2026-05-01
 * (/exec-only migration) and the dormant stub file was removed in the
 * api-route-decomposition.md PR-5 follow-up. The internal guards on
 * `connector` / `destructiveTools` membership are retained as
 * defense-in-depth (c8 ignored) so a reactivation — or any future
 * second caller — can re-share the helper safely without re-deriving
 * the pre-filter contract.
 *
 * Idempotent on extraction miss: returning early without any mark is the
 * documented degradation path (causes one self-noticed observation, not
 * data loss). The route handler always returns 2xx on a successful
 * upstream call — this helper never throws back.
 */
function maybeMarkIntegrationWrite(
  db: Database.Database,
  args: {
    integration: IntegrationKey;
    connector: IntegrationBackendConnector | undefined;
    bareTool: string;
    toolResult: unknown;
    args: unknown;
  },
): void {
  /* c8 ignore next -- /exec callsite pre-filters via `if (connector)`; this guard is defense-in-depth that survives /invoke retirement and protects any future re-share */
  if (!args.connector) return;
  /* c8 ignore next -- /exec callsite pre-filters via `if (destructiveTools.includes(...))`; same defense-in-depth as above */
  if (!args.connector.destructiveTools.includes(args.bareTool)) return;
  const extracted = extractWriteItemIds({
    integration: args.integration,
    bareTool: args.bareTool,
    toolResult: args.toolResult,
    args: args.args,
  });
  if (extracted.itemIds.length === 0) {
    logger.debug(
      {
        integration: args.integration,
        bareTool: args.bareTool,
        reason: extracted.reason,
      },
      "destructive tool succeeded but no item id extracted — actor attribution will fall through to 'user' on next reconcile",
    );
    return;
  }
  for (const id of extracted.itemIds) {
    markIntegrationWrite(db, args.integration, id);
  }
  logger.debug(
    {
      integration: args.integration,
      bareTool: args.bareTool,
      reason: extracted.reason,
      itemCount: extracted.itemIds.length,
    },
    "marked integration_writes for destructive delegated call",
  );
}
