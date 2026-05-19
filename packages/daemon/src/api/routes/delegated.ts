import { Hono } from "hono";
import {
  BACKEND_IDS,
  DELEGATED_TASK_HARD_CAPS,
  validateRunAllowedTools,
  type BackendId,
} from "@aitne/shared";
import { checkOutputSchema } from "../../services/delegated-task-runtime.js";
import { readJsonBody } from "../json-body.js";
import { createLogger } from "../../logging.js";
import type { ApiDependencies } from "../server.js";

const logger = createLogger("delegated-run-api");

/**
 * DELEGATED-TASK-MODE-DESIGN.md §4.2 — `POST /api/delegated/run`. Phase 2
 * generic task mode: the calling agent (or operator) targets an unregistered
 * MCP installed under one of the daemon's backends with explicit
 * `allowedTools` patterns. There is no `INTEGRATION_DESCRIPTORS` entry for
 * the targeted MCP, so the caller carries the entire scoping responsibility.
 *
 * Pre-flight order (cheapest first; mirrors `/exec`):
 *   1. Body is valid JSON (`readJsonBody` guards a 4 KB schema cap via the
 *      schema check below; the body itself is only marginally larger than
 *      the schema).
 *   2. `delegatedBackend ∈ {claude, gemini}`. Codex returns 501
 *      `task_mode_unsupported` (Phase 1.5 surface).
 *   3. `allowedTools` is a non-empty array of well-formed MCP patterns
 *      (`validateRunAllowedTools`). Bare `*`, leading `*`, prefix-too-short
 *      globs, and shell metacharacters are rejected at the boundary.
 *   4. `task` is a non-empty string.
 *   5. `outputSchema` validates (`checkOutputSchema`). Maps to
 *      `validation_error` / `schema_too_large` per §10.
 *   6. Numeric caps are within `DELEGATED_TASK_HARD_CAPS`.
 *   7. Kill switch (`config.delegatedTaskModeEnabled`): 503 if false.
 *   8. Invoker wired (501 if not).
 *
 * Risk tier: **Approve** (Bearer required) per §4.2 "wider blast radius
 * than /exec, so the dashboard / setup flow gates it." This deliberately
 * differs from `/api/integrations/:key/exec` (Autonomous), where
 * `state.deniedTools` is the chokepoint — `/run` has no integration to
 * apply a deny list against, so the trust trigger moves up to Bearer-
 * gated invocation. (The retired `/api/integrations/:key/invoke` RPC
 * route was likewise Autonomous before its 2026-05-01 retirement.)
 *
 * Note on §13 acceptance ("invoked from a Claude DM session"): DM agents do
 * not carry the dashboard's Bearer token, so the literal acceptance flow is
 * a dashboard- or operator-driven invocation that exercises the same
 * delegated-backend wiring. The design is explicit about Approve-tier; we
 * honor §4.2 over the §13 prose. Future Phase 2.x work could either ship a
 * narrowly-scoped agent token or relax to Autonomous behind a per-pattern
 * registry — both are deferrable.
 */
export function createDelegatedRunRoutes(deps: ApiDependencies): Hono {
  const app = new Hono();

  app.post("/delegated/run", async (c) => {
    const parsedBody = await readJsonBody(c);
    if (!parsedBody.ok) return parsedBody.response;

    const body = parsedBody.body as
      | {
        delegatedBackend?: unknown;
        allowedTools?: unknown;
        task?: unknown;
        outputSchema?: unknown;
        maxToolCalls?: unknown;
        maxBudgetUsd?: unknown;
        timeoutMs?: unknown;
        allowDestructive?: unknown;
        // DELEGATED-TASK-MODE-DESIGN.md §13 Phase 3.3 — opt-in result cache.
        cacheable?: unknown;
      }
      | null;

    // ── delegatedBackend ─────────────────────────────────────────────────
    const backendRaw = body?.delegatedBackend;
    if (
      typeof backendRaw !== "string"
      || !(BACKEND_IDS as readonly string[]).includes(backendRaw)
    ) {
      return c.json(
        {
          error: "validation_error",
          message: `\`delegatedBackend\` must be one of: ${BACKEND_IDS.join(", ")}`,
          field: "delegatedBackend",
        },
        400,
      );
    }
    // Codex /run landed in Phase 1.5 (alongside /exec) via daemon-side
    // stream pre-emption. The `backendRaw === "codex"` 501 short-circuit
    // that previously fired here is removed.
    const delegatedBackend = backendRaw as BackendId;

    // ── allowedTools ─────────────────────────────────────────────────────
    const allowedToolsRaw = body?.allowedTools;
    if (!Array.isArray(allowedToolsRaw)) {
      return c.json(
        {
          error: "bad_allowed_tools",
          message: "`allowedTools` must be a non-empty array of pattern strings",
          field: "allowedTools",
        },
        400,
      );
    }
    const patternCheck = validateRunAllowedTools(allowedToolsRaw);
    if (!patternCheck.ok) {
      return c.json(
        {
          error: "bad_allowed_tools",
          message: patternCheck.message,
          field: "allowedTools",
          pattern: patternCheck.pattern,
          reason: patternCheck.reason,
        },
        400,
      );
    }
    const allowedTools = allowedToolsRaw as string[];

    // ── task ─────────────────────────────────────────────────────────────
    if (typeof body?.task !== "string" || body.task.trim().length === 0) {
      return c.json(
        {
          error: "validation_error",
          message: "`task` must be a non-empty string",
          field: "task",
        },
        400,
      );
    }

    // ── outputSchema ─────────────────────────────────────────────────────
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

    // ── caps ─────────────────────────────────────────────────────────────
    const config = deps.config;
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
          field: "maxToolCalls",
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
          field: "maxBudgetUsd",
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
          field: "timeoutMs",
        },
        400,
      );
    }

    // ── kill switch ──────────────────────────────────────────────────────
    if (!config.delegatedTaskModeEnabled) {
      return c.json(
        {
          error: "task_mode_disabled",
          message:
            "Task mode is currently disabled (config.delegatedTaskModeEnabled=false). Re-enable via PATCH /api/config { delegatedTaskModeEnabled: true }, or flip an integration to delegated to auto-enable.",
          backend: delegatedBackend,
          mode: "delegated",
        },
        503,
      );
    }

    // ── invoker wired ────────────────────────────────────────────────────
    if (!deps.delegatedInvoker) {
      return c.json(
        {
          error: "unimplemented",
          message: "delegated invoker is not wired into this daemon instance",
          backend: delegatedBackend,
          mode: "delegated",
        },
        501,
      );
    }

    const result = await deps.delegatedInvoker.run({
      delegatedBackend,
      allowedTools,
      task: body.task.trim(),
      outputSchema,
      maxToolCalls,
      maxBudgetUsd,
      timeoutMs,
      allowDestructive,
      cacheable: body.cacheable === true,
      ...(c.req.header("x-event-id") ? { parentEventId: c.req.header("x-event-id")! } : {}),
      ...(c.req.header("x-process-key")
        ? { parentProcessKey: c.req.header("x-process-key")! }
        : {}),
    });

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
    logger.warn(
      {
        backend: delegatedBackend,
        errorClass: result.errorClass,
        retried: result.retried ?? false,
      },
      "delegated/run failed",
    );
    return c.json(
      {
        error: result.errorClass,
        message: result.message,
        ...(result.raw !== undefined ? { raw: result.raw } : {}),
        ...(result.trace ? { trace: result.trace } : {}),
        ...(result.cost ? { cost: result.cost } : {}),
        backend: result.backendId ?? delegatedBackend,
        mode: "delegated",
      },
      status,
    );
  });

  return app;
}

// ── helpers ──────────────────────────────────────────────────────────────────

type TaskHttpStatus = 403 | 409 | 429 | 500 | 501 | 502 | 503 | 504;

/**
 * §10 error → HTTP status. Identical mapping to the `/exec` route — same
 * error space (the invoker reuses every error class). Kept inline rather
 * than importing the route's local function to avoid circular imports
 * between two route files.
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
 * Clamp a numeric request-body field to [min, max], applying `defaultValue`
 * when omitted. Returns null on invalid input. Mirrors the helper in
 * `routes/integrations/exec.ts:clampNumber` — same shape kept local to avoid
 * cross-route imports of trivial utilities.
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

