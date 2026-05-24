import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

import { AGENT_ERROR_REGISTRY } from "./agent-errors-registry.js";
import type {
  AgentErrorConstraint,
  AgentErrorEnvelope,
  AgentErrorIssue,
  AgentErrorRegistryEntry,
  AgentErrorSeverity,
} from "./agent-errors-types.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

const PLACEHOLDER_HINT_PREFIX =
  "(unregistered code — please register in agent-errors-registry.ts) ";

/**
 * Compose an AgentErrorIssue from a code + call-site context. Pulls the
 * registry's `hint` / `expected` / `skillAnchor` / `constraint` defaults so
 * the call site can stay terse:
 *
 * ```ts
 * composeIssue("schedule.scheduled_for_in_past", {
 *   field: "rows[4].scheduledFor",
 *   received: "2026-05-15T03:45:00",
 *   rowIndex: 4,
 * });
 * ```
 *
 * The call site can override any registry default by passing it explicitly.
 */
export function composeIssue(
  code: string,
  overrides: {
    field: string;
    received: unknown;
    rowIndex?: number | null;
    expected?: string;
    constraint?: AgentErrorConstraint;
    /**
     * Runtime-derived list of acceptable values. See `AgentErrorIssue.validValues`
     * for the division of responsibility vs. `constraint.enum`.
     */
    validValues?: unknown;
    hint?: string;
    skillAnchor?: string;
    /** Override the registry's default docsUrl for this issue. */
    docsUrl?: string;
    severity?: AgentErrorSeverity;
  },
): AgentErrorIssue {
  const entry = (AGENT_ERROR_REGISTRY as Record<string, AgentErrorRegistryEntry | undefined>)[code];
  if (!entry) {
    return {
      code,
      field: overrides.field,
      received: overrides.received,
      rowIndex: overrides.rowIndex ?? null,
      expected: overrides.expected ?? "(unspecified)",
      constraint: overrides.constraint,
      validValues: overrides.validValues,
      hint:
        overrides.hint ??
        PLACEHOLDER_HINT_PREFIX +
          "no registry entry for this code; the caller should register it before shipping.",
      skillAnchor: overrides.skillAnchor,
      docsUrl: overrides.docsUrl,
      severity: overrides.severity ?? "error",
    };
  }
  return {
    code,
    field: overrides.field,
    received: overrides.received,
    rowIndex: overrides.rowIndex ?? null,
    expected: overrides.expected ?? entry.expected,
    constraint: overrides.constraint ?? entry.constraint,
    validValues: overrides.validValues,
    hint: overrides.hint ?? entry.hint,
    skillAnchor: overrides.skillAnchor ?? entry.skillAnchor,
    docsUrl: overrides.docsUrl ?? entry.docsUrl,
    severity: overrides.severity ?? entry.severity ?? "error",
  };
}

/**
 * Decide whether the response is retryable. Pure: composed only from the
 * registry entries for each issue's code, so the decision is deterministic
 * given the input array.
 */
function computeRetryable(issues: AgentErrorIssue[]): boolean {
  if (issues.length === 0) return false;
  for (const issue of issues) {
    if (issue.severity === "warning") continue;
    const entry = (AGENT_ERROR_REGISTRY as Record<string, AgentErrorRegistryEntry | undefined>)[
      issue.code
    ];
    if (entry?.retryable === false) return false;
  }
  return true;
}

/**
 * Resolve the top-level `error` legacy alias for an envelope. Precedence:
 *  1. explicit `options.legacyErrorCode` override at the call site
 *  2. the registry entry for the FIRST issue's code (single-issue
 *     responses are the only place a top-level scalar makes sense —
 *     dashboard branches like `body.error === "forbidden"` can only
 *     match one value)
 * Multi-issue envelopes intentionally drop the legacy alias unless the
 * call site forces it: there's no sensible way to surface 4 different
 * legacy strings through one scalar field.
 */
function resolveLegacyAlias(
  issues: AgentErrorIssue[],
  options?: { legacyErrorCode?: string | null },
): string | undefined {
  if (options && "legacyErrorCode" in options) {
    // Allow explicit `null` to opt out even when the registry would set one.
    return options.legacyErrorCode ?? undefined;
  }
  if (issues.length !== 1) return undefined;
  const entry = (AGENT_ERROR_REGISTRY as Record<string, AgentErrorRegistryEntry | undefined>)[
    issues[0].code
  ];
  return entry?.legacyErrorCode;
}

/**
 * Build the response envelope from a list of issues. Exposed for testing;
 * call sites should use `respondWithAgentError` instead.
 */
export function buildEnvelope(
  issues: AgentErrorIssue[],
  options?: {
    summary?: string;
    rowsAttempted?: number;
    rowsCommitted?: number;
    retryHint?: string;
    retryable?: boolean;
    /**
     * Non-blocking advisories surfaced via `envelope.warnings[]`. Kept
     * in a channel separate from `errors[]` so `computeRetryable` and
     * `errors.length`-style consumers never see them. See
     * SCHEDULE_API_REDESIGN_PLAN.md §5.0.5 for the contract.
     *
     * Each issue's `severity` is normalised to "warning" on the way in
     * — call sites that build a warning issue via `composeIssue` no
     * longer need to remember to pass `severity:"warning"`.
     */
    warnings?: AgentErrorIssue[];
    /**
     * Force a top-level `error: <legacy>` alias regardless of registry
     * defaults. Pass `null` to suppress an alias the registry would
     * otherwise add. Multi-issue envelopes need this — `resolveLegacyAlias`
     * skips the registry path when issues.length !== 1.
     */
    legacyErrorCode?: string | null;
    /**
     * Extra legacy top-level fields preserved on the envelope. Used by
     * pre-envelope endpoints whose response previously carried bespoke
     * keys (`message`, `path`, `reason`, `availableSections`, …) that
     * dashboard branches or older skill prose still pattern-match on.
     * Anything passed here is shallow-merged onto the envelope AFTER the
     * registry-set fields, so `errors`, `summary`, etc. cannot be
     * accidentally overwritten — but the `error` legacy alias above
     * can be, intentionally, when the call site passes both.
     */
    legacyFields?: Record<string, unknown>;
  },
): AgentErrorEnvelope {
  const retryable = options?.retryable ?? computeRetryable(issues);
  const summary =
    options?.summary ??
    (issues.length === 1
      ? `Request rejected: ${issues[0].code} on ${issues[0].field}.`
      : `${issues.length} validation errors. Fix the listed errors and retry.`);
  const envelope: AgentErrorEnvelope & Record<string, unknown> = {
    ok: false,
    summary,
    errors: issues,
    retryable,
  };
  const legacy = resolveLegacyAlias(issues, options);
  if (legacy !== undefined) envelope.error = legacy;
  if (options?.rowsAttempted !== undefined) envelope.rowsAttempted = options.rowsAttempted;
  if (options?.rowsCommitted !== undefined) envelope.rowsCommitted = options.rowsCommitted;
  if (options?.retryHint !== undefined) envelope.retryHint = options.retryHint;
  if (options?.warnings && options.warnings.length > 0) {
    envelope.warnings = options.warnings.map((w) =>
      w.severity === "warning" ? w : { ...w, severity: "warning" },
    );
  }
  if (options?.legacyFields) {
    // Reserved keys we never let the call site overwrite — these are the
    // structured envelope contract. `error` is allowed to pass through so
    // an explicit `legacyErrorCode` can coexist with a registry default.
    const reserved = new Set([
      "ok",
      "summary",
      "errors",
      "warnings",
      "retryable",
      "retryHint",
      "rowsAttempted",
      "rowsCommitted",
    ]);
    for (const [key, value] of Object.entries(options.legacyFields)) {
      if (reserved.has(key)) continue;
      if (value === undefined) continue;
      envelope[key] = value;
    }
  }
  return envelope;
}

/**
 * Compose the envelope and emit it as a Hono JSON response. The status
 * code is required so the call site can pick 400 (single-row request
 * validation) / 422 (per-row batch validation) / 403 (authn) / 404
 * (row missing) without the helper guessing.
 */
export function respondWithAgentError(
  c: Context,
  status: ContentfulStatusCode,
  issues: AgentErrorIssue[],
  options?: {
    summary?: string;
    rowsAttempted?: number;
    rowsCommitted?: number;
    retryHint?: string;
    retryable?: boolean;
    /** See `buildEnvelope` — non-blocking advisories surfaced as `warnings[]`. */
    warnings?: AgentErrorIssue[];
    /** See `buildEnvelope` — explicit legacy alias override. */
    legacyErrorCode?: string | null;
    /** See `buildEnvelope` — extra legacy top-level fields. */
    legacyFields?: Record<string, unknown>;
  },
): Response {
  const envelope = buildEnvelope(issues, options);
  return c.json(envelope, status);
}

/**
 * Compose a warning-severity issue. Thin wrapper around `composeIssue`
 * that pins `severity:"warning"` so call sites populating an
 * `envelope.warnings[]` or a 2xx success body's `warnings` channel
 * don't have to remember the severity argument every time.
 *
 * Use for inputs that are syntactically valid but suspicious enough to
 * flag (deprecated model, `daysOfMonth:[31]` with default policy, etc.).
 * The route still returns 2xx — see
 * SCHEDULE_API_REDESIGN_PLAN.md §5.0.5 for the contract.
 */
export function composeWarning(
  code: string,
  overrides: {
    field: string;
    received: unknown;
    rowIndex?: number | null;
    expected?: string;
    constraint?: AgentErrorConstraint;
    validValues?: unknown;
    hint?: string;
    skillAnchor?: string;
    docsUrl?: string;
  },
): AgentErrorIssue {
  return composeIssue(code, { ...overrides, severity: "warning" });
}
