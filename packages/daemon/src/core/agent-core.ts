import type {
  AgentResult,
  BackendId,
  BackendModel,
  Event,
  IntegrationKey,
  ProcessKey,
} from "@aitne/shared";

/** Callbacks for streaming agent responses to a client (e.g., dashboard SSE). */
export interface StreamCallbacks {
  onText?: (text: string) => void;
  onEnd?: () => void;
}

/**
 * Chat-attachments Phase 1 — one entry per inbound attachment the dispatcher
 * has hard-linked into `<sessionDir>/_attachments/`. Cores receive this list
 * alongside the prompt so they can apply per-backend translations on top of
 * the already-assembled `[Attached files]` text block:
 *
 * - Claude Code: no extra work — the SDK's `Read` tool surfaces image / PDF
 *   bytes as multimodal blocks when the agent opens the staged path.
 * - Codex: image-MIME entries become repeated `--image <absolutePath>` argv
 *   flags. Non-image entries stay staged-only (the agent reads them via its
 *   shell). Subject to a 120 KB argv-length cap beyond which the core drops
 *   back to staged-only and logs.
 * - Gemini: every entry is inlined into the prompt as
 *   `@<relativePath>` so the CLI's `@`-expansion embeds the bytes in the
 *   multimodal request. `relativePath` is always `_attachments/<safeFilename>`.
 */
export interface StagedAttachment {
  id: string;
  safeFilename: string;
  mimeType: string;
  /** Absolute path on disk — points into `<sessionDir>/_attachments/`. */
  absolutePath: string;
  /** Path relative to `sessionDir`; always `_attachments/<safeFilename>`. */
  relativePath: string;
}

export interface AgentExecuteParams {
  prompt: string;
  context: string;
  event: Event;
  modelId: string;
  maxTurns: number;
  maxBudgetUsd: number;
  /** Persistent workdir. If omitted, a disposable temp dir is created and cleaned up. */
  sessionDir?: string;
  /** Resolved logical process for backend-specific prompt manifests. */
  processKey?: ProcessKey;
  /** Whether to persist the SDK session for later resume. Default: false. */
  persistSession?: boolean;
  /** SQLite conversation_sessions.id for this turn, forwarded to daemon API shims. */
  sessionDbId?: number;
  /** Summary + recent messages injected when resuming across backends. */
  conversationHistory?: string;
  /** Whether the backend should enable web search tools. */
  webSearchEnabled?: boolean;
  /**
   * Chat-attachments Phase 1 — per-turn capability token. When set, cores
   * inject it into the subprocess/SDK env as `PA_TURN_TOKEN` so the
   * `attach` skill's curl call can authenticate against
   * `POST /api/chat/outbound-attachments`. Token is cleared by the
   * dispatcher after the turn, so leakage is bounded.
   */
  turnToken?: string;
  /**
   * Chat-attachments Phase 1 — staged inbound attachments for this turn.
   * Backends apply per-backend translations on top of the already-injected
   * `[Attached files]` prompt block. See the `StagedAttachment` comment
   * for per-backend behavior.
   */
  stagedAttachments?: StagedAttachment[];
  /**
   * P22 §3.4 step 4 — per-execute hard clamp on the SDK's `allowedTools`.
   * Used by `routine.skill_curation` to give the optimizer agent a tightly
   * bounded envelope (curl glob + Read only) regardless of the dashboard's
   * `allowedToolsOverride` config. When set, the array REPLACES the
   * default allowlist (it does not merge); delegated/web-search tool
   * widening is suppressed for that execute. The config-level
   * `allowedToolsOverride` continues to govern unflagged executes.
   *
   * Per-backend support:
   *   - Claude (`ClaudeCodeCore`): consumed by the SDK `query()` call.
   *   - Codex (`CodexCore`) / Gemini (`GeminiCliCore`): no per-spawn
   *     allowedTools surface today (acknowledged gap §3.5 of the design);
   *     the curation API's run-token + Zod chokepoint is the safety floor.
   */
  allowedToolsOverride?: readonly string[];
  /**
   * WIKI_BUILDER_DESIGN.md §4.3 — narrow per-execute widening so wiki URL
   * ingestion can read external pages without flipping any global toggle.
   * The dispatcher sets this **only for `event.type === "wiki.ingest_url"`**
   * — wiki.compile and wiki.ask read the local vault via the daemon Wiki
   * API and never fetch external URLs, so they keep the narrower posture.
   *
   * Backend behaviour (each as narrow as the SDK / CLI surface allows):
   *   - Claude: gated through `getAllowedTools(..., wikiUrlFetchEnabled)`.
   *     When set AND no custom `allowedToolsOverride` is configured,
   *     `WebFetch` joins the per-execute allowedTools list. Same gating
   *     contract as `webSearchEnabled` — a user-curated override is
   *     respected verbatim (they add `WebFetch` themselves if needed).
   *   - Codex: no-op. Strict-mode workspace-write sandbox already runs
   *     with `sandbox_workspace_write.network_access=true`, so external
   *     curl works without dropping any guard.
   *   - Gemini: threads into `generateAdminPolicy({ wikiUrlFetchEnabled })`.
   *     The strict admin policy is regenerated with the `web_fetch` deny
   *     rule replaced by an allow @ priority 500 for this turn only. All
   *     other policy guards — context-dir chokepoint, sensitive-path
   *     reads, pipe-chain deny, absolute-block layer, `--sandbox`
   *     container — remain intact.
   *   - Allow-mode backends ignore the flag (external HTTP already works).
   */
  wikiUrlFetchEnabled?: boolean;
  /**
   * AGENT_DEFINITIONS_DESIGN.md §4.2 — the firing Agent's `tools.skills`.
   * The dispatcher resolves these from the Agent's effective definition and
   * the core forwards them into `createSessionWorkdir`, where
   * `composeSkillSet` folds them onto the process-key default bundle (union,
   * or replace when `skillsReplace` is set). Empty / undefined is a no-op, so
   * non-Agent executes (DMs, built-in routines, managed tasks) are unaffected.
   *
   * Forwarded verbatim on both the main and fallback execute paths so an
   * Agent's added skills survive a Claude → Codex fallback.
   */
  extraSkills?: readonly string[];
  /** AGENT_DEFINITIONS_DESIGN.md §4.2 — `tools.skills_replace`. See `extraSkills`. */
  skillsReplace?: boolean;
}

export interface AgentResumeParams {
  sessionId: string;
  message: string;
  modelId: string;
  maxTurns?: number;
  maxBudgetUsd?: number;
  /** Persistent workdir — must match the cwd used in the original execute(). */
  sessionDir?: string;
  /** SQLite conversation_sessions.id for this turn, forwarded to daemon API shims. */
  sessionDbId?: number;
  /** Whether the backend should enable web search tools. */
  webSearchEnabled?: boolean;
  /** Chat-attachments Phase 1 — per-turn capability token. See AgentExecuteParams. */
  turnToken?: string;
  /** Chat-attachments Phase 1 — staged attachments for this resume turn. */
  stagedAttachments?: StagedAttachment[];
  /** Event.correlationId for the resuming MessageEvent. Forwarded to the
   *  shim env so /api/notify calls during the resume can be attributed to
   *  the dispatcher's in-flight run for notify-dedup. */
  eventCorrelationId?: string;
}

export interface BackendQuotaResetHint {
  hour: number;
  minute: number;
  timeZone?: string;
  rawLabel: string;
}

export type AuthStatus = "ok" | "expiring_soon" | "expired" | "missing";

export type AuthMethod =
  | "cli_login"
  | "api_key"
  | "oauth"
  | "vertex"
  | "bedrock"
  | "foundry";

export interface AuthCheckResult {
  ok: boolean;
  status: AuthStatus;
  method: AuthMethod;
  detail?: string;
  recoveryCommand?: string;
}

export interface ReadSensitiveTokenManager {
  issue(scope: string): string;
  revoke(scope: string): void;
  isValid(token: string): boolean;
}

/**
 * B-003 Phase 3 — dependency bundle needed by agent cores to materialize
 * MCP config into the session workdir before spawning the backend. Optional
 * per core: a core that hasn't been wired with an MCP context simply skips
 * MCP materialization (equivalent to "no enabled servers for this backend").
 */
export interface McpSessionContext {
  db: import("better-sqlite3").Database;
  blobStore: import("../secrets/encrypted-blob-store.js").EncryptedBlobStore;
}

/** Backend-neutral agent core implemented by each CLI backend. */
export interface IAgentCore {
  readonly backendId: BackendId;

  /** Legacy fallback for a shared read token. Prefer setReadTokenManager(). */
  setReadToken?(token: string): void;

  /** Set the scoped token manager used for read-sensitive daemon API auth. */
  setReadTokenManager?(manager: ReadSensitiveTokenManager): void;

  /**
   * B-003 Phase 3 — wire the MCP session context (DB + blob store) so the
   * core can materialize per-session MCP config before spawning. Optional:
   * cores without a context treat sessions as MCP-less.
   */
  setMcpContext?(context: McpSessionContext): void;

  execute(
    params: AgentExecuteParams,
    streamCallbacks?: StreamCallbacks,
  ): Promise<AgentResult>;

  executeResume(
    params: AgentResumeParams,
    streamCallbacks?: StreamCallbacks,
  ): Promise<AgentResult>;

  summarize(conversationText: string): Promise<string>;

  /**
   * Lightweight auth presence check used by implementations that want
   * a pre-flight gate in `runTurn()` (CodexCore, GeminiCliCore) to
   * avoid paying subprocess TTFB on a request that will obviously 401.
   * Implementations are NOT required to call this from `runTurn()`
   * themselves — `ClaudeCodeCore`, for example, relies on the Agent
   * SDK's first HTTP round-trip to produce a decisive 401 and skips
   * the pre-flight entirely. The reactive path in `BackendRouter`
   * catches the resulting `BackendDecisiveFailure("auth")` either way,
   * so both patterns feed the same DB cache and telemetry.
   *
   * See the class-level comment on `ClaudeCodeCore` for the full
   * rationale behind the asymmetry.
   */
  checkAuth(): Promise<
    | { ok: true; method: AuthMethod }
    | { ok: false; reason: string }
  >;

  /**
   * Detailed auth check used by AuthHealthMonitor + reactive backend router.
   * Returns a structured status (`ok` / `expired` / `missing`) plus a
   * user-facing `detail` string and optional `recoveryCommand` hint.
   *
   * Unlike `checkAuth()`, implementations are read-only: they must not
   * invoke any CLI write/refresh path (credentials rotation races — see
   * `docs/design/09-safety-cost.md` §9.5.1).
   */
  checkAuthDetailed(): Promise<AuthCheckResult>;

  /**
   * Enumerate MCP tool names the backend subprocess currently exposes.
   *
   * Phase 5 §4.11 "live probe" — cost-bearing user-initiated operation used
   * by the Re-probe button and the setup wizard's pre-commit check. Each
   * backend implements the cheapest path that returns a full tool manifest:
   *   - ClaudeCodeCore: start a tightly-scoped `query()` that can use only
   *     ToolSearch, then extract hosted connector tool references from the
   *     stream. Claude Code defers large MCP manifests behind ToolSearch.
   *   - CodexCore: run a focused `codex exec --json` prompt that asks the
   *     agent to print tools in the integration's namespace. 1 turn minimum.
   *   - GeminiCliCore: scans `~/.gemini/extensions/*` and
   *     `~/.gemini/settings.json` for registered MCP servers and
   *     synthesizes the expected tool list from the registry — Gemini CLI
   *     exposes no first-party tool-enumeration API. Presence-only:
   *     verifies registration, not actual sign-in.
   *
   * Returns the full namespaced tool names (e.g.
   * `mcp__claude_ai_Gmail__search_threads`). Callers feed the list into
   * `evaluateProbe({tools, integration, backend})` to derive the feature
   * matrix and persist via `writeProbe`.
   */
  probeTools(): Promise<string[]>;

  listModels(): ReadonlyArray<BackendModel>;

  /**
   * Delegated proxy invocation — spawn this backend in a one-shot session
   * that calls a single MCP connector tool and returns its raw result.
   * Used by `DelegatedBackendInvoker` to fold delegated `/api/mail/*` and
   * `/api/calendar/*` calls back into the daemon API surface.
   *
   * Phase A ships this as a stub on every core (throws
   * `DelegatedToolUnsupportedError`); Phase B fills in the per-backend
   * stream-event extraction. Implementations:
   *   - read `params.sessionDir` (the invoker has already materialized a
   *     minimal proxy profile + instruction file there);
   *   - send a single user message that names the tool + verbatim JSON args;
   *   - parse the structured stream for the FIRST tool_use_result whose
   *     tool_name matches `params.toolName` — never trust LLM text output;
   *   - return cost / tokens / duration regardless of result.ok so the
   *     invoker can attribute partial spend to no_tool_call / wrong_tool /
   *     tool_error / timeout.
   *
   * The `result` object always carries the cost block. `ok: false` paths
   * (no_tool_call, wrong_tool, tool_error, parse_error, auth_error,
   * timeout) include `errorClass` so the invoker can map to a daemon HTTP
   * status code without re-classifying.
   */
  runDelegatedTool(params: DelegatedToolInvokeParams): Promise<DelegatedToolResult>;

  /**
   * DELEGATED-TASK-MODE-DESIGN.md §5 — task-mode invocation. Spawn this
   * backend in a one-shot session that plans + executes a small number of
   * MCP tool calls and emits a final JSON envelope matching the caller's
   * `outputSchema`.
   *
   * Implementations:
   *   - **Claude (`ClaudeCodeCore`)**: SDK `query()` with `allowedTools`
   *     restricted to the integration's connector tools (minus the
   *     destructive subset when `allowDestructive: false`). Stream is
   *     parsed for `tool_use` / `tool_result` events; the final assistant
   *     message is the validation target.
   *   - **Gemini (`GeminiCliCore`)**: synthesised admin TOML with
   *     priority-920 allow rules per allowed tool + priority-998 destructive
   *     denies + the existing catch-all deny. Stream is parsed for
   *     `tool_use` events to enforce `maxToolCalls` and to populate the
   *     trace.
   *   - **Codex (`CodexCore`)**: spawns `codex exec` and runs daemon-side
   *     stream pre-emption (Phase 1.5 — see §9.2 + codex-core.ts
   *     `runDelegatedTask`). Codex CLI has no per-spawn allowedTools
   *     surface, so the wrapper aborts the subprocess on the first
   *     disallowed or destructive `mcp__*` call observed in the JSONL
   *     stream. `task_mode_unsupported` no longer fires from this core;
   *     the error class is retained on the union for future cores
   *     that opt out of task mode.
   *
   * Cores own subprocess + cost; the runtime helpers in
   * `services/delegated-task-runtime.ts` own prompt + schema + retry
   * decision. The invoker (`DelegatedBackendInvoker.task`) is the
   * chokepoint that enforces concurrency, daily quota, and audit.
   */
  runDelegatedTask(
    params: DelegatedTaskInvokeParams,
  ): Promise<DelegatedTaskResultRaw>;
}

export interface DelegatedToolInvokeParams {
  integrationKey: IntegrationKey;
  toolName: string;
  toolArgs: unknown;
  modelId: string;
  maxTurns: number;
  maxBudgetUsd: number;
  /**
   * Pre-materialized session workdir (the invoker creates the tempdir,
   * writes the proxy profile + instruction file, then hands the path off).
   * The core must `cwd` into this directory; cleanup is the invoker's
   * responsibility.
   */
  sessionDir: string;
  /** Aborts the subprocess and returns `error: "timeout"`. */
  abortSignal?: AbortSignal;
}

export interface DelegatedToolCost {
  tokensInput: number;
  tokensOutput: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  costUsd: number;
  durationMs: number;
  numTurns: number;
}

export type DelegatedToolErrorClass =
  | "subprocess_crashed"
  | "timeout"
  | "cancelled"
  | "tool_error"
  | "tool_not_registered"
  | "parse_error"
  | "auth_error"
  | "no_tool_call"
  | "wrong_tool";

/**
 * Sentinel used by the delegated-proxy invoker's wall-clock timer when it
 * aborts the per-call AbortController. Backends use `instanceof` against
 * `abortSignal.reason` to distinguish wall-clock timeout from caller-side
 * cancellation, which is recorded as a separate `errorClass` so the
 * dashboard can tell "Gemini was slow" apart from "session was cancelled".
 *
 * Stronger than message-string matching: a future refactor of the message
 * literal cannot silently break the classifier, and unrelated libraries
 * cannot accidentally collide with the sentinel by emitting an Error
 * whose message happens to contain "timeout".
 */
export class DelegatedProxyTimeoutError extends Error {
  constructor(message = "delegated proxy wall-clock timeout") {
    super(message);
    this.name = "DelegatedProxyTimeoutError";
  }
}

/**
 * Map an `AbortSignal.reason` to the right `errorClass` enum value.
 * Use the result for the `errorClass` field on the failure return path
 * after `abortSignal?.aborted` (or the equivalent claude `aborted.value`)
 * is observed true.
 */
export function classifyAbortReason(
  reason: unknown,
): "timeout" | "cancelled" {
  return reason instanceof DelegatedProxyTimeoutError ? "timeout" : "cancelled";
}

export type DelegatedToolResult =
  | {
    ok: true;
    toolResult: unknown;
    cost: DelegatedToolCost;
  }
  | {
    ok: false;
    errorClass: DelegatedToolErrorClass;
    message: string;
    /** Partial cost when usage events landed before the failure. */
    cost: DelegatedToolCost;
  };

/**
 * Thrown by `IAgentCore.runDelegatedTool()` implementations that have not
 * yet been wired to the per-backend stream-event extractor (Phase A ships
 * the contract; Phase B fills it in for Claude / Codex / Gemini). The
 * invoker treats this as a 501-class failure and records it in
 * `agent_actions.detail.errorClass = "unimplemented"`.
 */
export class DelegatedToolUnsupportedError extends Error {
  constructor(public readonly backendId: BackendId, reason: string) {
    super(`${backendId}: runDelegatedTool not implemented — ${reason}`);
    this.name = "DelegatedToolUnsupportedError";
  }
}

/**
 * DELEGATED-TASK-MODE-DESIGN.md §5 — params passed from the invoker into
 * a per-backend `runDelegatedTask` implementation. Mirrors
 * `DelegatedToolInvokeParams` but carries the task body / schema /
 * caller-tunable caps instead of a single tool name + args.
 *
 * The route handler enforces the §17 hard caps and fills defaults; by
 * the time the params reach the core, every numeric is concrete and
 * within bounds. The `systemPrompt` is also pre-rendered by the runtime
 * helper (`buildTaskPrompt`) so the core only has to wire it into the
 * per-backend prompt placement (`systemPrompt` for Claude, `GEMINI.md`
 * for Gemini).
 */
export interface DelegatedTaskInvokeParams {
  /**
   * Originating integration key when the task was scoped to one of the
   * registered integrations (`/api/integrations/:key/exec`). Optional —
   * `/api/delegated/run` (Phase 2 generic task mode) does not have a
   * registered integration, so the field is absent for those calls. The
   * cores do not consult this field; it stays on the type for telemetry
   * pass-through and future routing decisions.
   */
  integrationKey?: IntegrationKey;
  /** Pre-rendered system prompt (§5.1 template). */
  systemPrompt: string;
  /** Compiled Ajv validator for the caller's outputSchema. */
  validate: (value: unknown) => boolean;
  /**
   * The validator above is shared with the runtime extractor; expose its
   * raw error array so the core can surface schema violations without
   * re-running validation.
   */
  validatorErrorMessage: () => string;
  /** Fully-qualified namespaced tool names the subprocess may call. */
  allowedTools: readonly string[];
  /** Fully-qualified destructive tool names — deny-listed to defense-in-depth
   *  past `allowedTools` exclusion. Always populated. */
  destructiveTools: readonly string[];
  /**
   * §6.2 / §7.4 — fully-qualified namespaced names of tools that mutate
   * user-visible state (destructive ∪ write-class). Cores match every
   * `tool_use` event against this set; on first match they flip
   * `writeClassToolFired`, which the invoker uses to suppress the §6.2
   * single retry (no second planning turn after a write). Strict superset
   * of `destructiveTools`. Always populated.
   */
  writeClassTools: readonly string[];
  /** §6.2 retry rule — write-class trigger flag. The core sets this true
   *  on the first `tool_use` whose name matches a destructive or
   *  write-class tool, so the invoker can decide whether to issue the
   *  single retry. */
  destructiveOrWriteClassToolFired?: { value: boolean };
  modelId: string;
  maxToolCalls: number;
  maxBudgetUsd: number;
  timeoutMs: number;
  allowDestructive: boolean;
  sessionDir: string;
  abortSignal?: AbortSignal;
  /** §11.1 — emit one entry per tool_use/tool_result pair. */
  onToolStep?: (step: DelegatedTaskToolStepRaw) => void;
  /**
   * DELEGATED-TASK-MODE-DESIGN.md §13 Phase 3.1 — request the backend to
   * use its native structured-output knob (Claude SDK
   * `outputFormat: { type: 'json_schema', schema }`) when available. When
   * set, the core also passes back a parsed object on `structuredOutput`
   * if the SDK supplied one; the invoker prefers that over text extraction.
   * Cores that don't support structured output (Gemini CLI 0.40.0, Codex)
   * MUST ignore the field and continue producing `rawAssistantText` —
   * the invoker falls back to text-extract + Ajv automatically.
   */
  structuredOutputEnabled?: boolean;
  /**
   * §13 Phase 3.1 — pre-built wrapped schema (`oneOf` of user schema +
   * confirmation envelope + error envelopes). Cores that wire the SDK's
   * structured-output knob pass this through verbatim; cores that don't
   * ignore it. The runtime helper `wrapSchemaForStructuredOutput` builds
   * it; the invoker passes both `outputSchema` and `wrappedSchema` so the
   * core implementations can pick whichever fits their SDK.
   */
  wrappedSchema?: Record<string, unknown>;
}

/**
 * Per-step entry the core emits via `onToolStep`. Costs / token counts
 * are best-effort: cores fill them only when they can attribute usage
 * to a single tool (one-tool turn). The header row aggregates from the
 * subprocess's terminal usage event, so missing per-step values do not
 * lose information.
 */
export interface DelegatedTaskToolStepRaw {
  toolName: string;
  toolArgs: unknown;
  durationMs: number;
  status: "ok" | "error";
  costUsd: number | null;
  tokensInput: number | null;
  tokensOutput: number | null;
  /**
   * Verbatim upstream tool result (parsed when the connector returns
   * JSON, raw string otherwise). Optional because the field arrived
   * after the original trace shape was set; older snapshots and stub
   * cores may omit it. Consumed by the `/exec` route's
   * `integration_writes` actor-attribution loop so the response-shape
   * extractor (`extractWriteItemIds`) can recover the upstream id from
   * id-in-response writes (`send_email`, `create_event`,
   * `notion-create-pages`) — without it, /exec falls through to the
   * args-side fallback only and silently mis-attributes those creates
   * as user actions on the next reconcile.
   */
  toolResult?: unknown;
}

export type DelegatedTaskRawErrorClass =
  | "subprocess_crashed"
  | "timeout"
  | "cancelled"
  | "auth_error"
  | "tool_failed"
  | "tool_unavailable"
  | "parse_error"
  | "schema_violation"
  | "policy_violation"
  | "loop_aborted"
  | "budget_exhausted"
  | "task_mode_unsupported";

export type DelegatedTaskResultRaw =
  | {
    ok: true;
    /** Raw assistant text — runtime helpers parse + validate. */
    rawAssistantText: string;
    cost: DelegatedToolCost;
    /** Trace mirrors the per-step events fed via `onToolStep`. Returned
     *  here too so cores that batch can surface the trace at end-of-stream
     *  without forcing every implementation to thread the callback. */
    trace: DelegatedTaskToolStepRaw[];
    /** §6.2 — true if the core ran any destructive/write-class tool. */
    writeClassToolFired: boolean;
    /**
     * DELEGATED-TASK-MODE-DESIGN.md §13 Phase 3.1 — pre-parsed structured
     * output from the SDK when `structuredOutputEnabled: true` was honored.
     * The invoker prefers this over `rawAssistantText` extraction when
     * present. `undefined` means the core fell back to text emission
     * (Gemini, Codex, or Claude with the kill switch off). Already
     * validated against the wrapped schema by the SDK — the runtime still
     * runs `classifyStructuredOutput` to detect confirmation / error
     * envelopes and to apply the user's narrower schema check.
     */
    structuredOutput?: unknown;
  }
  | {
    ok: false;
    errorClass: DelegatedTaskRawErrorClass;
    message: string;
    /** Best-effort raw text when extraction reached the model output. */
    rawAssistantText?: string;
    cost: DelegatedToolCost;
    trace: DelegatedTaskToolStepRaw[];
    writeClassToolFired: boolean;
  };

/**
 * DELEGATED-TASK-MODE-DESIGN.md §9.2 — historically thrown by the Codex
 * core when task mode wasn't yet wired (Phase 1). Phase 1.5 (2026-05-01)
 * landed `runDelegatedTask` on Codex via daemon-side stream pre-emption,
 * so this error class is no longer thrown by any current core. The
 * sentinel + the `task_mode_unsupported` errorClass enum value are kept
 * so a future backend that ships before its task-mode wiring can reuse
 * the contract instead of inventing a new one.
 */
export class TaskModeUnsupportedError extends Error {
  constructor(public readonly backendId: BackendId) {
    super(
      `${backendId}: task mode (runDelegatedTask) is not implemented on this backend yet. Reactivation surface: implement runDelegatedTask on the core and the invoker will route /exec calls through it like Claude / Codex / Gemini.`,
    );
    this.name = "TaskModeUnsupportedError";
  }
}

/**
 * Thrown by `IAgentCore.probeTools()` implementations that cannot
 * enumerate their MCP tool manifest. The API route surfaces this as a
 * 501 so the dashboard can render a targeted "live probe not available
 * on this backend" message. Currently no production core throws this;
 * it stays in place for cores that may land in the future without a
 * tool-enumeration path.
 */
export class LiveProbeUnsupportedError extends Error {
  constructor(
    public readonly backendId: BackendId,
    public readonly reason: string,
  ) {
    super(`${backendId}: live probe not supported — ${reason}`);
    this.name = "LiveProbeUnsupportedError";
  }
}

/**
 * Optional spend payload attached to BackendQuotaError when the underlying
 * backend has already consumed tokens before the daemon's per-turn budget
 * cap rejected the run. Populated by post-hoc budget assertions (Codex /
 * Gemini CLI) where the model completed a turn whose actual usage exceeded
 * the cap. The dispatcher's error handler writes this into `agent_actions`
 * with `result='failed'` so the dashboard reflects what was actually
 * billed, instead of dropping the row silently on the success-only audit
 * path.
 */
export interface BackendQuotaSpend {
  usage: import("@aitne/shared").BackendUsage;
  costUsd: number;
  modelId: string;
  numTurns: number;
  durationMs: number;
  costSource: AgentResult["costSource"];
}

export class BackendQuotaError extends Error {
  constructor(
    public readonly backendId: BackendId,
    public readonly originalCode: string,
    public readonly resetHint: BackendQuotaResetHint | null,
    message: string,
    public readonly spend: BackendQuotaSpend | null = null,
  ) {
    super(message);
    this.name = "BackendQuotaError";
  }
}

export class BackendDecisiveFailure extends Error {
  constructor(
    public readonly backendId: BackendId,
    public readonly kind:
      | "quota"
      | "auth"
      | "max_turns"
      | "timeout"
      | "model_unavailable"
      // The backend's permission layer (TOML deny rule, PreToolUse hook,
      // sandbox) rejected a tool invocation. Distinct from
      // `other_non_retryable` so dashboards / audit logs can surface "the
      // agent tried something forbidden" instead of an opaque backend
      // failure. Router behaviour is unchanged: fallback still fires
      // because policy surfaces differ across backends (e.g. Gemini denies
      // `curl A && curl B` via its TOML rules while Claude's absolute-block
      // layer does not), so the alternate backend may legitimately succeed
      // on the same prompt.
      | "policy_denied"
      | "other_non_retryable",
    public readonly cause: unknown,
    /**
     * PREPASS_COST_REDUCTION_PLAN.md N1 — best-effort spend recovered
     * from the failed run when the SDK/CLI surfaced usage before the
     * terminal error (auth rejection mid-run, timeout, transport
     * failure). Same shape as `BackendQuotaError.spend` so the
     * dispatcher's post-hoc audit writer can record what the provider
     * actually billed for a turn that produced no `AgentResult`.
     * `null` when the failure happened before any usage was observed.
     */
    public readonly spend: BackendQuotaSpend | null = null,
  ) {
    super(`${backendId} decisive failure: ${kind}`);
    this.name = "BackendDecisiveFailure";
  }
}

/**
 * Recover the spend payload from a backend failover signal, regardless
 * of which of the two error classes carries it. Handles the nested
 * `BackendDecisiveFailure(kind="quota", cause=BackendQuotaError)` wrap
 * the router produces, preferring the inner quota error's spend when
 * both layers carry one. Returns `null` for non-backend errors.
 *
 * PREPASS_COST_REDUCTION_PLAN.md N1 — shared by the dispatcher's
 * post-hoc audit writer and the pre-pass fan-out runner so both
 * failure paths record the same figure for the same error.
 */
export function extractBackendSpend(error: unknown): BackendQuotaSpend | null {
  if (error instanceof BackendQuotaError) {
    return error.spend;
  }
  if (error instanceof BackendDecisiveFailure) {
    if (error.cause instanceof BackendQuotaError && error.cause.spend) {
      return error.cause.spend;
    }
    return error.spend;
  }
  return null;
}
