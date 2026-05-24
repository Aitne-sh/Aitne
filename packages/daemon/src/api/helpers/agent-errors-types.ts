// ── Agent-consumable error envelope ──────────────────────────────────────────
//
// Defined in docs/design/appendices/morning-routine-optimization.md
// §"Error messaging contract for agent self-correction".
//
// Why this exists: every Phase 1 endpoint (POST /api/schedule, POST
// /api/schedule/batch, PATCH /api/agent-actions/self) is consumed by an LLM
// agent in the same turn it's called from. A bare `{error:"validation_failed"}`
// gives the LLM nothing to act on; it loops blindly. A structured envelope
// with `code`, `field`, `received`, `expected`, `hint`, and `skillAnchor`
// lets the LLM self-correct on the *next* turn rather than the 8th —
// production telemetry on /api/observations/consume showed an agent burning
// $0.58 / 25 turns guessing the field name before the structured shape
// landed.

/**
 * Severity of an individual error issue.
 *
 * - `error` blocks commit. For atomic batch endpoints (`POST
 *   /api/schedule/batch` with `atomic:true`, the default), one `error`
 *   rolls back the whole batch. Errors live in `envelope.errors[]`.
 * - `warning` is non-blocking. The row is persisted and the response
 *   returns 2xx (or 4xx alongside real errors). Warnings live in
 *   `envelope.warnings[]` — a channel that `computeRetryable` and
 *   `errors.length`-style consumers do NOT see — and follow the same
 *   issue shape as errors. Use for inputs that are syntactically valid
 *   but suspicious (deprecated model on a long-lived recurring rule,
 *   ambiguous `daysOfMonth:[31]` with the default `lastDayOfMonth`
 *   policy, etc.). See SCHEDULE_API_REDESIGN_PLAN.md §5.0.5.
 */
export type AgentErrorSeverity = "error" | "warning";

/**
 * Structured form of `expected`. Lets future tooling lint against the
 * registry without prose parsing. Every field is optional — the registry
 * entry picks what's relevant to that particular code.
 */
export interface AgentErrorConstraint {
  type?:
    | "string"
    | "number"
    | "integer"
    | "boolean"
    | "iso8601"
    | "array"
    | "object"
    | "enum"
    | "json"
    | "unknown";
  minLength?: number;
  maxLength?: number;
  minimum?: string | number;
  maximum?: string | number;
  pattern?: string;
  enum?: readonly string[];
  required?: boolean;
}

/**
 * A single agent-consumable error issue. The fields are documented in
 * morning-routine-optimization.md §"Required fields in every
 * agent-consumable error".
 */
export interface AgentErrorIssue {
  /**
   * Index into `request.body.rows[]` for batch endpoints; `null` for
   * single-row endpoints. Required field on the response so a 5-row
   * batch with 2 errors is unambiguous about which rows failed.
   */
  rowIndex: number | null;
  /**
   * Stable machine-readable code, namespaced by resource (e.g.
   * `schedule.task_context_field_missing`). Skills can switch on it.
   * New codes ship as additive enum values — never reused for a different
   * meaning. Codes are validated against AGENT_ERROR_REGISTRY at
   * `respondWithAgentError` time; an unregistered code is a programmer
   * bug and logs a warning before serialising.
   */
  code: string;
  /** JSON-pointer-ish path locating the offending input. */
  field: string;
  /** Exact value the daemon saw. `'<missing>'` sentinel for omitted fields. */
  received: unknown;
  /** One-sentence description of what would have been accepted. */
  expected: string;
  /** Structured form of `expected` for future tooling. */
  constraint?: AgentErrorConstraint;
  /**
   * Runtime-derived list of acceptable values. Use this when the answer
   * is data the operator can change (model registry snapshot, IANA
   * timezones, an integration's `supportedModes`). Filled at error-time
   * by the route, never in the registry default. See
   * SCHEDULE_API_REDESIGN_PLAN.md §5.3 for the division of responsibility
   * vs. `constraint.enum`:
   *   - `constraint.enum`  — STATIC enum fixed across deploys.
   *   - `validValues`      — DYNAMIC payload computed per-request.
   * Never both for the same code.
   */
  validValues?: unknown;
  /** Concrete remediation guidance with an example when non-obvious. */
  hint: string;
  /**
   * `<skill>#<heading-slug>` reference into the relevant SKILL.md. Agent
   * can `Read` the anchor for fuller contract docs.
   */
  skillAnchor?: string;
  /**
   * Repo-relative reference into `docs/design/` or `agent-assets/` for
   * deeper "what to do on this error" prose (e.g.
   * `agent-assets/skills/schedule/references/errors.md#model_unknown`).
   * Complements `skillAnchor` — skillAnchor is the entry point, docsUrl
   * is the precise heading. Set on registry entries that ship a matching
   * anchor in the documented file; the call site can override per-issue.
   */
  docsUrl?: string;
  severity: AgentErrorSeverity;
}

/**
 * Response envelope. Strictly additive to the existing Hono error shape
 * so existing non-agent callers (dashboard, tests) see a recognisable
 * `errors[].code` / `summary` and ignore extra fields.
 */
export interface AgentErrorEnvelope {
  ok: false;
  /**
   * Legacy short code alias. Set when the registry entry (or the call
   * site override) declares a `legacyErrorCode` — dashboard / older
   * test consumers that switch on `body.error === "forbidden"` etc.
   * continue to work without each consumer learning the namespaced
   * `errors[0].code` shape. New consumers should read `errors[]`.
   */
  error?: string;
  /**
   * Human-skimmable one-liner. The agent reads `errors[]` for action;
   * the operator reads `summary` in logs. Should never be the sole
   * source of truth.
   */
  summary: string;
  /** For batch endpoints: total rows submitted. Omitted for single-row. */
  rowsAttempted?: number;
  /** For batch endpoints: rows actually committed. */
  rowsCommitted?: number;
  errors: AgentErrorIssue[];
  /**
   * Non-blocking advisories using the same issue shape as `errors[]`.
   * The route still returns 2xx (or, when paired with errors, 4xx) and
   * persists the row; the agent should surface warnings so the LLM can
   * refine on the next turn. Channel separation matters — every issue
   * placed here is invisible to `computeRetryable` and to the
   * `errorCount`-style consumers that switch on `errors.length`.
   *
   * Per SCHEDULE_API_REDESIGN_PLAN.md §5.0.5: use for inputs that are
   * syntactically valid but suspicious (deprecated model, ambiguous
   * `daysOfMonth:[31]` with default `lastDayOfMonth`, etc.).
   */
  warnings?: AgentErrorIssue[];
  /** Whether the agent can fix this and retry, or must escalate. */
  retryable: boolean;
  /**
   * Optional one-line remediation summary. Set when the retry strategy
   * is non-obvious (e.g. "Fix the 2 errors above and POST the same body
   * again. The atomic=true default means no rows were committed.").
   */
  retryHint?: string;
}

/**
 * Per-entry shape inside `AGENT_ERROR_REGISTRY`. Exported only so the
 * sibling `agent-errors-registry.ts` can type-check its `as const satisfies
 * Record<string, AgentErrorRegistryEntry>` declaration against it.
 *
 * @internal Folder-private — route handlers should not construct registry
 * entries at runtime; compose via `composeIssue` / `composeWarning` instead.
 */
export interface AgentErrorRegistryEntry {
  /** Default `expected` string. Call site can override per-issue. */
  expected: string;
  /** Default `hint`. Call site can override when more specific context exists. */
  hint: string;
  skillAnchor: string;
  constraint?: AgentErrorConstraint;
  /**
   * Default `docsUrl` (repo-relative path to deeper prose, e.g.
   * `agent-assets/skills/schedule/references/errors.md#model_unknown`).
   * Set when the matching anchor exists in the docs corpus — the call
   * site can override per-issue when the link should point elsewhere
   * (e.g. a code emitted from two different endpoints with separate
   * recovery pages). Static; for runtime-derived value sets use the
   * call-site `validValues` override on `composeIssue` instead.
   */
  docsUrl?: string;
  /**
   * Default severity when the call site does not specify. Stays at
   * `error` for every entry today — registry-driven warnings have no
   * call site yet. Phase D's `validateModelToken` consumers will emit
   * warnings via the `composeWarning` helper or by passing
   * `severity:"warning"` as an override, both of which bypass this
   * registry default. Keep the entry's default at `error` unless an
   * entry is *intrinsically* advisory.
   */
  severity?: AgentErrorSeverity;
  /**
   * Whether an envelope composed entirely of this code is retryable by the
   * agent in the same turn. Soft defaults to `true` — the agent self-
   * corrects on validation errors. Set `false` for codes that need a
   * human (auth misconfiguration, server-side state mismatches).
   */
  retryable?: boolean;
  /**
   * Legacy short code surfaced on the envelope as top-level `error`. Set
   * when an endpoint previously returned `{ error: "<short>" }` and one or
   * more consumers (dashboard UI, older skill prose, third-party scripts)
   * still pattern-match on `body.error === "<short>"`. The structured
   * `errors[0].code` (namespaced) remains the canonical machine-readable
   * field; this is a backwards-compat surface for the migration window.
   *
   * Omit when the code is new — agents and new consumers read
   * `errors[0].code` and don't need the alias.
   */
  legacyErrorCode?: string;
}
