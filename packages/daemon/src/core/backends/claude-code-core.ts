import {
  query,
  type McpServerConfig,
  type McpSdkServerConfigWithInstance,
  type SDKResultMessage,
  type SDKSystemMessage,
  type SDKAssistantMessage,
  type SDKUserMessage,
  type Query,
  type SettingSource,
} from "@anthropic-ai/claude-agent-sdk";
import {
  isAutonomousProcessKey,
  isMessageEvent,
  type AgentResult,
  type BackendModel,
  type ProcessKey,
} from "@aitne/shared";
import {
  buildExecutionPrompt,
  buildSummaryPrompt,
} from "./prompt-utils.js";
import type { AgentConfig } from "../../config.js";
import { getContextDir } from "../../config.js";
import type {
  AgentExecuteParams,
  AgentResumeParams,
  AuthCheckResult,
  DelegatedTaskInvokeParams,
  DelegatedTaskResultRaw,
  DelegatedToolInvokeParams,
  DelegatedToolResult,
  IAgentCore,
  BackendQuotaResetHint,
  McpSessionContext,
  ReadSensitiveTokenManager,
  StreamCallbacks,
} from "../agent-core.js";
import { materializeMcpForSession } from "../../services/mcp/session-materializer.js";
import {
  OBSERVATIONS_MCP_SERVER_NAME,
  createObservationsMcpServer,
  type PrePassObservationsSink,
} from "../../services/mcp/sdk-observations-server.js";
import { parseMcpToolName } from "../../services/mcp/risk.js";
import { logMcpToolCall, updateMcpToolCallResult } from "../../services/mcp/tool-audit.js";
import {
  BackendQuotaError,
  BackendDecisiveFailure,
  type BackendQuotaSpend,
} from "../agent-core.js";
import { PriceFetcher } from "./price-fetcher.js";
import { flattenToolResultContent } from "../../services/delegated-tool-runtime.js";
import {
  runDelegatedTool as runDelegatedToolFn,
  runDelegatedTask as runDelegatedTaskFn,
  type ClaudeDelegatedDeps,
} from "./claude-delegated.js";
import type { AgentWriteTracker } from "../../safety/agent-write-tracker.js";
import { createSessionWorkdir, cleanupSessionWorkdir } from "../workdir.js";
import { resolveUserSkillsRoot } from "../user-skills-root.js";
import { buildDaemonApiCliEnv } from "../daemon-api-cli.js";
import { createLogger } from "../../logging.js";
import {
  DEFAULT_CLAUDE_HIGH_MODEL,
  DEFAULT_CLAUDE_MEDIUM_MODEL,
  findRegisteredModel,
  getModelsForBackend,
} from "./model-registry.js";
import { ALWAYS_DISALLOWED_TOOLS } from "../../safety/always-disallowed.js";
import {
  loadFetchWindowSystemPrompt,
  loadSlimSystemPrompt,
  resetFetchWindowSystemPromptForTest,
} from "../slim-system-prompt-loader.js";
import { CliPathCache } from "./cli-utils.js";
import {
  extractSilentApiErrors,
  logSilentApiErrors,
} from "./silent-api-error-detector.js";
import {
  CLAUDE_PROBE_TOOLS_PROMPT,
  computeDelegatedClaudeTools,
  computeNativeClaudeTools,
  describeClaudeProbeResultError,
  extractClaudeProbeTools,
} from "./claude-probe.js";
import {
  AgentTimeoutError,
  extractClaudeCodeQuotaResetHint,
  isClaudeCodeMaxBudgetError,
  isClaudeCodeMaxTurnsError,
  isClaudeCodeQuotaError,
  type ClaudeCodeQuotaResetHint,
} from "./claude-errors.js";
import {
  checkAuth as checkAuthFn,
  checkAuthDetailed as checkAuthDetailedFn,
  getErrorCode,
  getErrorMessage,
  getErrorStatus,
  getErrorType,
  isAuthError,
} from "./claude-auth.js";
import {
  buildSecurityHooks,
  getAllowedTools as getAllowedToolsFn,
  getDelegatedClaudeTools as getDelegatedClaudeToolsFn,
  getNativeClaudeTools as getNativeClaudeToolsFn,
  getSessionDeniedTools as getSessionDeniedToolsFn,
} from "./claude-tool-collection.js";

// Re-exports kept narrow on purpose: only the symbols `claude-code-core.test.ts`
// imports from this module. Internal consumers (this file, claude-auth.ts,
// claude-tool-collection.ts) import directly from `./claude-probe.js` /
// `./claude-errors.js` so the re-export is not a second public entry point.
// Each symbol here previously lived in this file before the §8 file-split;
// keeping them re-exported preserves the test's import path without
// re-routing the test suite. See `docs/design/appendices/file-split-plan.md` §8.
export {
  AgentTimeoutError,
  CLAUDE_PROBE_TOOLS_PROMPT,
  computeDelegatedClaudeTools,
  computeNativeClaudeTools,
  extractClaudeCodeQuotaResetHint,
  isClaudeCodeQuotaError,
};

const logger = createLogger("claude-code-core");

/**
 * SDK `settingSources` opt-in for the daemon's `query()` calls.
 *
 * The Claude Agent SDK defaults `settingSources` to `[]` ("SDK isolation
 * mode", per `sdk.d.ts` — no filesystem settings loaded). With the default,
 * the spawned Claude Code subprocess does NOT read `~/.claude/settings.json`,
 * which is where the user's claude.ai-bound MCP connectors live
 * (`mcp__claude_ai_Gmail__*`, `mcp__claude_ai_Google_Calendar__*`,
 * `mcp__claude_ai_Notion__*`, etc.). Without that, an integration in
 * `native:claude` mode emits an acquisition plan whose tools do not exist
 * in the session, the pre-pass produces no JSON, and the parent routine
 * collapses to a heartbeat-only shadow run.
 *
 * `'project'` is also required: the SDK's `on1` skills loader bails out
 * in bare mode unless `pJ("projectSettings")` is true (verified in the
 * shipped `cli.js`), meaning the per-session `<sessionDir>/.claude/skills/`
 * tree the SkillsCompiler materialises would not be auto-discovered.
 * `sdk.d.ts` is explicit: "Must include 'project' to load CLAUDE.md
 * files." Without it the daemon's `<sessionDir>/CLAUDE.md` (the entire
 * agent profile + safety + skill-reference block) is also silently
 * dropped, and `excludeDynamicSections: true` has nothing to strip /
 * re-inject. Symptom: the agent lists user-scope skills (e.g.
 * `webapp-testing` from `~/.claude/skills/`) but reports daemon-side
 * project skills like `browser-task` as "not available".
 *
 * Opting in to `['user', 'project']` brings Claude in line with Codex
 * and Gemini, both of which load `~/.codex/config.toml` /
 * `~/.gemini/settings.json` AND per-session instruction files by
 * default at CLI spawn (they have no `--setting-sources=` equivalent
 * to suppress).
 *
 * Trade-off — user-scoped file hooks (e.g. notify.sh entries under
 * `~/.claude/settings.json` → `hooks.{Notification,Stop,PermissionRequest}`)
 * are also loaded, plus any `<sessionDir>/.claude/settings.json` the
 * daemon may add in the future. The SkillsCompiler does not currently
 * write a per-session settings.json, so the project surface adds only
 * the intended `<sessionDir>/.claude/skills/` + CLAUDE.md auto-discovery.
 * Programmatic hooks passed via `query({ hooks })` layer on top rather
 * than suppress them. Users with noisy file hooks should scope them
 * with matchers; the daemon does not strip them.
 */
const CLAUDE_SDK_SETTING_SOURCES: readonly SettingSource[] = ["user", "project"];

/**
 * Slim, lite-tier process keys swap the verbose `preset: "claude_code"`
 * system prompt (~30 K tokens of built-in tool descriptions, the skills
 * index, the memory-system docs, and tone/style guidance the key never
 * uses) for a tight custom systemPrompt string. SDK 0.2.98 has no
 * `presetOptions` granularity to drop sub-sections of the preset, so a
 * string prompt is the only lever. `buildSystemPrompt` resolves membership
 * through the shared registry in `core/slim-system-prompt-loader.ts`
 * (`loadSlimSystemPrompt`) — the SAME loader the `SkillsCompiler` uses to
 * write the byte-identical body into Codex / Gemini AGENTS.md / GEMINI.md,
 * so adding a slim key is a one-line registry edit that wires both backends.
 * Per-key agent profiles + task-flow bodies still ship the operational
 * rules; the slim system prompt only sets the broad stance, and the SDK
 * still loads the per-cwd CLAUDE.md the SkillsCompiler materializes.
 *   - `routine.fetch_window` — docs/design/appendices/fetch-window-cost-reduction.md
 *     Phase 1 / 1.5.
 *   - `routine.research_cluster_update` — RESEARCH_CLUSTER_COST_FIX_PLAN.md F4.
 */

/**
 * Process keys whose Claude SDK session sheds the daemon user's `~/.claude`
 * scope: `settingSources` drops to `["project"]` and `strictMcpConfig` is
 * forced on. On a dev machine the `"user"` source pulls in the user's plugin
 * SKILL.md tree (~178 files) + the ~25 K-token user-scope claude.ai MCP
 * connector schemas (`mcp__claude_ai_*`) into EVERY session's prompt-cache
 * prefix (RESEARCH_CLUSTER_COST_FIX_PLAN.md RC4). Dropping it is pure win for
 * a key that reaches no integration through those connectors — and for a long,
 * many-turn session that re-reads the cached prefix on every turn the saving
 * compounds (the ~25 K is paid once as a cache write, then again as a cache
 * read on each turn).
 *
 * The ONLY prerequisite for shedding is connector-independence: the key must
 * reach no Gmail / Calendar / Notion / etc. through a user-scope
 * `mcp__claude_ai_*` connector. This is INDEPENDENT of the slim-system-prompt
 * lever (`core/slim-system-prompt-loader.ts`): the two optimizations are
 * decoupled in code — `buildSystemPrompt` gates only on the slim registry,
 * while `resolveSettingSources` / `resolveStrictMcpConfig` gate only on this
 * set — so a key may sit in either, both, or neither:
 *   - `routine.fetch_window` — slim, NOT shed. In native integration mode the
 *     fetcher reaches Gmail / Calendar / Notion precisely through the
 *     user-scope claude.ai connectors, so it must keep `["user", "project"]`.
 *   - `routine.research_cluster_update` — slim AND shed. Only ever curls the
 *     daemon's own browser-history + context REST API (no connector).
 *   - `routine.evening_review` — shed, NOT slim. Drives everything through
 *     `curl` to the local daemon REST API (`localhost:8321`) and reaches no
 *     connector, so shedding cannot starve it. It is deliberately NOT slim: a
 *     medium-tier, skill-heavy routine that loads six skills via the `Skill`
 *     tool (context / today / user-profile / notify / roadmap /
 *     management-policy), which the slim prompt drops — so it keeps the full
 *     `preset: "claude_code"`. Those skills are materialized under the
 *     *project* scope (`<sessionDir>/.claude/skills/`) and survive the drop to
 *     `["project"]`; only the owner's personal plugin skills + unused claude.ai
 *     connector schemas are shed.
 *
 * `strictMcpConfig` is defense-in-depth on top of the `settingSources` drop:
 * it shuts out any settings-file-sourced MCP server, while the daemon's own
 * servers (including the in-process `aitne-observations` server) are passed
 * programmatically via `options.mcpServers` (`composeMcpServers`) which
 * `strictMcpConfig` does not touch. Typed `ReadonlySet<ProcessKey>` so a
 * key rename in @aitne/shared lights up at the literal below.
 */
const USER_SCOPE_SHED_PROCESS_KEYS: ReadonlySet<ProcessKey> = new Set<ProcessKey>([
  "routine.research_cluster_update",
  "routine.evening_review",
]);

/**
 * Test-only surface: lets `claude-code-core.test.ts` exercise the slim
 * prompt loader without reaching into module internals via `as any` casts.
 * Re-exports the shared loaders (hoisted to `core/slim-system-prompt-loader.ts`)
 * so the existing fetch_window test import path keeps working.
 */
export const _testInternals = {
  loadFetchWindowSystemPrompt,
  resetFetchWindowSystemPromptForTest,
};

/**
 * ClaudeCodeCore intentionally does NOT run a pre-flight `checkAuth()`
 * gate inside `execute()` / `runTurn()`. Codex and Gemini each call
 * `await this.checkAuth()` at the top of `runTurn()` as a cheap way
 * to surface an early `BackendDecisiveFailure("auth")` before paying
 * the latency of spawning the CLI subprocess; Claude uses the
 * `@anthropic-ai/claude-agent-sdk` stream consumer instead, and the
 * SDK's first HTTP round-trip already returns a decisive 401 on its
 * own. A pre-flight here would duplicate work (two credential reads
 * per execute) and isn't needed to prevent accidental token use —
 * the reactive path in `BackendRouter` catches the SDK's 401, maps
 * it to `BackendDecisiveFailure("auth")`, and calls
 * `recordReactiveAuthFailure` exactly as if a pre-flight had run.
 *
 * This asymmetry is deliberate and matched by the corresponding
 * explanatory comments at `codex-core.ts` / `gemini-cli-core.ts`'s
 * `runTurn` pre-flight and at `IAgentCore.checkAuth` in
 * `agent-core.ts`. If you add a new backend, decide the pre-flight
 * question based on the CLI / SDK's own startup cost, not on
 * pattern-matching against one of the existing three.
 */

// ── Partial-spend recovery (PREPASS_COST_REDUCTION_PLAN.md N1) ────────────
//
// The SDK populates authoritative usage/cost only on the terminal `result`
// stream message. When the stream aborts before that message arrives —
// the SDK's `max_budget_usd` kill, a wall-clock timeout, a transport
// failure — the run's spend would otherwise be unrecoverable: the thrown
// error carries no usage, and the dispatcher's post-hoc audit writer
// (`recordPostHocBudgetSpend`) drops payload-less errors. The accumulator
// below sums per-assistant-message usage during `consumeStream` so a
// partial figure exists at throw time; `executeOnce` / `executeResumeOnce`
// stamp the snapshot onto the propagating error via a symbol property,
// and `classifyExecutionError` / `toBackendQuotaError` lift it onto the
// classified `BackendQuotaError` / `BackendDecisiveFailure`.

/** Carrier property for the partial-spend snapshot on a propagating error. */
const PARTIAL_SPEND_PROP = Symbol("aitne.claudePartialSpend");

interface PartialUsageAccumulator {
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheCreationInputTokens: number;
    cacheReadInputTokens: number;
  };
  numTurns: number;
}

function createPartialUsageAccumulator(): PartialUsageAccumulator {
  return {
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    },
    numTurns: 0,
  };
}

/**
 * Fold one SDK assistant message's API-call usage into the accumulator.
 * The SDK reports usage per API call on each assistant message; summing
 * them approximates the run's total the same way the terminal result
 * message would have.
 */
function recordAssistantUsage(
  acc: PartialUsageAccumulator,
  rawUsage: unknown,
): void {
  acc.numTurns += 1;
  if (typeof rawUsage !== "object" || rawUsage === null) return;
  const u = rawUsage as Record<string, unknown>;
  const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  acc.usage.inputTokens += num(u.input_tokens);
  acc.usage.outputTokens += num(u.output_tokens);
  acc.usage.cacheCreationInputTokens += num(u.cache_creation_input_tokens);
  acc.usage.cacheReadInputTokens += num(u.cache_read_input_tokens);
}

function accumulatorSawUsage(acc: PartialUsageAccumulator): boolean {
  return (
    acc.usage.inputTokens > 0
    || acc.usage.outputTokens > 0
    || acc.usage.cacheCreationInputTokens > 0
    || acc.usage.cacheReadInputTokens > 0
  );
}

function attachPartialSpend(error: unknown, spend: BackendQuotaSpend): void {
  if (typeof error !== "object" || error === null) return;
  try {
    Object.defineProperty(error, PARTIAL_SPEND_PROP, {
      value: spend,
      enumerable: false,
      configurable: true,
    });
  } catch {
    // Frozen/sealed error object — losing the snapshot is acceptable;
    // the row simply stays payload-less like before N1.
  }
}

/** Visible for testing. */
export function getAttachedPartialSpend(
  error: unknown,
): BackendQuotaSpend | null {
  if (typeof error !== "object" || error === null) return null;
  const value = (error as Record<symbol, unknown>)[PARTIAL_SPEND_PROP];
  return value ? (value as BackendQuotaSpend) : null;
}

export class ClaudeCodeCore implements IAgentCore {
  readonly backendId = "claude" as const;
  private static readonly RETRY_DELAY_MS = 5 * 60 * 1000;
  private static readonly MAX_RETRIES = 1;
  // Network-connectivity failures reach us two ways: as a Node error carrying
  // a `.code` (ENOTFOUND, ECONNREFUSED, …) OR — when the Claude Agent SDK's
  // transport hits the failure mid-stream — as a thrown `Error` whose *message*
  // embeds the cause, e.g. `Claude Code returned an error result: API Error:
  // Unable to connect to API (ENOTFOUND)`. The message form has no `.code`, so
  // shape-matching the text is the only signal. Both are transient: a momentary
  // offline blip (wifi reconnect, DNS hiccup) should recover on the next
  // attempt rather than fail decisively as `other_non_retryable` (no retry, no
  // fallback, and a user-notification cascade we can't even deliver while
  // offline). Keep this aligned with the `.code` allowlist in
  // `isRetryableExecutionError`.
  private static readonly NETWORK_ERROR_MESSAGE_PATTERN =
    /network error|fetch failed|socket hang up|connection reset|connection refused|network is unreachable|unable to connect to api|getaddrinfo|timed out|\b(?:ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH|EAI_AGAIN|EPIPE|ECONNABORTED)\b/i;

  // Lazily re-resolved with a 60 s TTL so CLI install/uninstall is
  // detected without a daemon restart (roadmap §9.4). Constructor does an
  // eager PATH scan so the first checkAuth() call has no extra latency.
  private readonly cliPathCache: CliPathCache;
  /** Legacy shared read token injected into the Claude subprocess env. */
  private readToken: string | undefined;
  /** Scoped token manager preferred over the legacy shared read token. */
  private readTokenManager: ReadSensitiveTokenManager | undefined;
  /** B-003 Phase 3 — DB + blob store for per-session MCP materialization. */
  private mcpContext: McpSessionContext | undefined;
  /**
   * Lazily-constructed in-process MCP server exposing
   * `mcp__aitne-observations__submit_observations`. Replaces the curl-to-
   * `/api/observations/batch` path for pre-pass sessions so Unicode-
   * whitespace-bearing mail bodies don't trip the SDK's bash preflight.
   * Built once per ClaudeCodeCore instance (the SDK accepts the same
   * `McpSdkServerConfigWithInstance` across multiple `query()` calls);
   * exposure is still gated per-session by `allowedTools`.
   */
  private observationsMcpServer: McpSdkServerConfigWithInstance | null = null;

  /** Transparent getter — all existing `this.cliPath` references keep working. */
  private get cliPath(): string | null {
    return this.cliPathCache.get();
  }

  constructor(
    private readonly config: AgentConfig,
    /**
     * Shared AgentWriteTracker. When present, the Write/Edit PreToolUse hook
     * pre-marks vault-scoped writes so the ObsidianWatcher attributes the
     * resulting chokidar event to `actor='agent'` instead of `'user'`. Without
     * this wiring, the activity_scan dispatcher would re-discover the agent's
     * own vault writes every cycle and loop.
     */
    private readonly writeTracker?: AgentWriteTracker,
    /**
     * PREPASS_COST_REDUCTION_PLAN.md N1 — used only to estimate the
     * dollar figure of a partial spend snapshot when the SDK stream
     * terminates abnormally (budget abort, timeout, transport failure).
     * Success-path cost still comes from the SDK's own metering.
     * Defaulted like the CLI cores' fetchers so bootstrap stays
     * unchanged; guarded on `dataDir` because several unit tests
     * construct the core with a partial config — those fall back to
     * cap-floor-only estimation in `stampPartialSpend`.
     */
    private readonly priceFetcher: PriceFetcher | undefined = config.dataDir
      ? new PriceFetcher(config.dataDir)
      : undefined,
  ) {
    this.warnOnMissingCriticalTools();
    this.cliPathCache = new CliPathCache("claude");
  }

  /** Set the per-daemon-boot read token for subprocess-local daemon API auth. */
  setReadToken(token: string): void {
    this.readToken = token;
  }

  setReadTokenManager(manager: ReadSensitiveTokenManager): void {
    this.readTokenManager = manager;
  }

  setMcpContext(context: McpSessionContext): void {
    this.mcpContext = context;
    logger.info(
      { backendId: this.backendId },
      "MCP context wired — delegated-integration allowlist resolution enabled",
    );
  }

  /**
   * Lazily build the in-process observations MCP server. Returns null
   * when `mcpContext` isn't wired (tests, very early startup) so the
   * caller's merge skips the server entry rather than wiring a broken
   * one.
   *
   * The server is constructed once and reused — the SDK accepts the same
   * `McpSdkServerConfigWithInstance` across multiple `query()` calls and
   * the underlying handler captures the (long-lived) `db` handle.
   * Per-session exposure is gated by `allowedTools`:
   * `composePrePassAllowedTools` adds the tool name for pre-pass
   * sessions; other sessions cannot invoke it under
   * `permissionMode: "dontAsk"`.
   */
  private getObservationsMcpServer(
    observationsSink?: PrePassObservationsSink,
  ): McpSdkServerConfigWithInstance | null {
    if (!this.mcpContext) return null;
    // FETCH_WINDOW_TURN_LIMIT_FIX_PLAN.md P2.2 — a per-execute sink means a
    // pre-pass fan-out sub-session that needs its own ground-truth tally
    // ledger. Build a fresh sink-bound server for it (the SDK accepts a
    // distinct `McpSdkServerConfigWithInstance` per `query()` call, and
    // fan-out sub-sessions run concurrently on this one core, so a shared
    // ambient sink would cross-attribute). Every OTHER Claude session
    // (no sink) keeps the cached, sink-less boot-time server unchanged.
    if (observationsSink) {
      return createObservationsMcpServer(this.mcpContext.db, observationsSink);
    }
    if (this.observationsMcpServer === null) {
      this.observationsMcpServer = createObservationsMcpServer(
        this.mcpContext.db,
      );
    }
    return this.observationsMcpServer;
  }

  /**
   * Compose the final `mcpServers` map handed to the SDK. Merges the
   * external (OAuth-backed) servers from {@link materializeMcpForSession}
   * with the in-process observations server. External servers win on key
   * collision (defensive against a future external server happening to
   * share the `aitne-observations` name — we'd want the explicit
   * external configuration to take effect rather than silently shadowing
   * it).
   *
   * Returns null when neither side contributes anything so the caller's
   * conditional spread keeps `mcpServers` out of the SDK options
   * entirely (passing an empty object is harmless but noisier in logs).
   */
  private composeMcpServers(
    external: Record<string, unknown> | null,
    observationsSink?: PrePassObservationsSink,
  ): Record<string, McpServerConfig> | null {
    const observations = this.getObservationsMcpServer(observationsSink);
    const externalEntries = external && typeof external === "object" ? external : {};
    const merged: Record<string, McpServerConfig> = {
      ...(observations
        ? { [OBSERVATIONS_MCP_SERVER_NAME]: observations as McpServerConfig }
        : {}),
      ...(externalEntries as Record<string, McpServerConfig>),
    };
    return Object.keys(merged).length > 0 ? merged : null;
  }

  /**
   * Load the per-session MCP materialization. When the core hasn't been
   * wired with a context (tests, startup ordering) we return an empty
   * result rather than throwing — equivalent to "no enabled servers".
   */
  private async materializeMcp(
    sessionDir: string,
    processKey: string | undefined,
  ): Promise<Awaited<ReturnType<typeof materializeMcpForSession>>> {
    if (!this.mcpContext) {
      return {
        servers: [],
        env: {},
        configPath: null,
        claudeMcpServers: null,
        disallowedTools: [],
      };
    }
    // Allow mode bypasses the approve-tier MCP strip that autonomous
    // process keys normally trigger — "strong permission mode" means every
    // MCP is reachable, including routines that would otherwise have
    // `slack_send_message` et al stripped.
    const allowMode = this.config.claudeExecutionPermissionMode === "allow";
    const autonomous = !allowMode && (processKey ? isAutonomousProcessKey(processKey) : false);
    return materializeMcpForSession({
      db: this.mcpContext.db,
      blobStore: this.mcpContext.blobStore,
      sessionDir,
      backendId: this.backendId,
      autonomous,
      contextDir: getContextDir(this.config),
    });
  }

  /**
   * Tools the reactive DM path depends on. If `allowedToolsOverride` is set
   * but drops any of these, sessions will silently deny them under
   * `permissionMode: "dontAsk"` and the owner will see a misleading
   * "restricted" error. See BUG-DM-BACKEND-PERMISSIONS.md §9 (Fix 1a).
   */
  static readonly CRITICAL_OVERRIDE_TOOLS = ["Skill", "Bash(jq *)"] as const;

  /**
   * Pure computation: which of the CRITICAL_OVERRIDE_TOOLS are missing from
   * the current `allowedToolsOverride`. Returns `[]` when the override is
   * unset (the default allowlist already contains all critical tools).
   */
  getMissingCriticalOverrideTools(): readonly string[] {
    const override = this.config.allowedToolsOverride;
    if (!override) return [];
    return ClaudeCodeCore.CRITICAL_OVERRIDE_TOOLS.filter(
      (tool) => !override.includes(tool),
    );
  }

  /**
   * `allowedToolsOverride` REPLACES the default allowlist (it does not merge).
   * Emit a one-shot warning at construction so a mis-configuration surfaces
   * in the daemon log instead of a confusing DM reply.
   */
  private warnOnMissingCriticalTools(): void {
    // In allow mode neither the override nor the default allowlist applies —
    // the SDK runs under bypassPermissions, so a missing Skill / Bash(jq *)
    // entry in the override is cosmetic. Suppress the warning.
    if (this.config.claudeExecutionPermissionMode === "allow") return;
    const missing = this.getMissingCriticalOverrideTools();
    if (missing.length === 0) return;
    logger.warn(
      {
        missing,
        overrideSize: this.config.allowedToolsOverride?.length ?? 0,
      },
      "allowedToolsOverride is set but missing critical tools. " +
        "The reactive DM path calls user skills and jq pipelines; without these " +
        "the session will deny them with 'dontAsk' and respond to the owner with " +
        "a misleading 'restricted' message. Either append the missing entries to " +
        "the override, or clear the override to fall back to the default allowlist.",
    );
  }

  /**
   * Translate the Aitne advisor config into the SDK `options.settings`
   * shape. `advisorModel` is a field on `Settings`, not on `Options` — the
   * query() parameter must be passed inside a `settings` object.
   *
   * Returns an empty object when advisor is disabled so we don't clobber any
   * settings source that would otherwise load.
   */
  private buildAdvisorSettings(): { settings?: { advisorModel: string } } {
    if (!this.config.advisorEnabled || !this.config.advisorModel) {
      return {};
    }
    return {
      settings: {
        advisorModel: this.config.advisorModel,
      },
    };
  }

  private buildSystemPrompt(
    processKey?: ProcessKey,
  ):
    | string
    | {
        type: "preset";
        preset: "claude_code";
        append: string;
        excludeDynamicSections: boolean;
      } {
    // Slim process keys (RESEARCH_CLUSTER_COST_FIX_PLAN.md F4 generalizes the
    // fetch-window-cost-reduction.md Phase 1 precedent) pay the full preset
    // prompt cost on every dispatch (~30 K cache_create tokens per session).
    // These keys never use Skill / Read / Write / Edit / Glob / Grep / Task /
    // WebFetch / WebSearch / NotebookEdit / EnterPlanMode / ScheduleWakeup,
    // the memory-system documentation, or the skills index — every byte of
    // preset for those is wasted cache creation amortized over only a few
    // turns. Replace the preset with a small custom string sourced from the
    // shared registry (`core/slim-system-prompt-loader.ts`); the SkillsCompiler
    // materializes the byte-identical body into AGENTS.md / GEMINI.md for CLI
    // parity. Operational rules still ship via the per-cwd CLAUDE.md profile +
    // task-flow body the SkillsCompiler materializes per session.
    //
    // Trade-off — `excludeDynamicSections` is a no-op when systemPrompt is
    // a string (per SDK 0.2.98 docs: "Has no effect when systemPrompt is a
    // string (custom prompt)"), but the entire string IS byte-stable
    // across sessions, so the prompt-cache prefix is naturally cacheable
    // on the same axis without needing the flag.
    const slimSystemPrompt = loadSlimSystemPrompt(processKey);
    if (slimSystemPrompt !== null) {
      return slimSystemPrompt;
    }

    // Character is NOT appended here — Phase 2 of the Character feature
    // (see docs/design/15-character.md §15.4.3) moved the injection into
    // the rendered CLAUDE.md so Claude / Codex / Gemini see a byte-
    // identical block. The remaining append is the WhatsApp-prefix
    // operational note, which is byte-stable per-session and therefore
    // cache-friendly.
    const appendParts = [
      "WhatsApp outbound messages are prefixed by the daemon. Do not add that prefix yourself unless the user explicitly asks.",
    ];
    return {
      type: "preset" as const,
      preset: "claude_code" as const,
      append: appendParts.join("\n"),
      // Strip per-session dynamic sections (cwd, auto-memory path, git
      // status) from the cached system prompt prefix. The content is
      // re-injected as the first user message so the model still sees it,
      // but the system prompt becomes byte-identical across sessions —
      // enabling inter-session prompt cache hits within the 5-minute TTL.
      // Biggest wins: back-to-back routines (morning_routine + roadmap_refresh
      // + post-morning catchups) and retry chains where the second session
      // starts within minutes of the first.
      //
      // Limitation: the SDK still reads CLAUDE.md and .claude/skills/ from
      // cwd at session init. Different event types use different profiles
      // (routine.md vs conversational.md) and skill subsets, so the file
      // layer differs across event types → no cross-event-type cache hit.
      // This flag only helps same-type back-to-back sessions.
      excludeDynamicSections: true,
    };
  }

  /**
   * Resolve the SDK `settingSources` for a session. Returns `["project"]`
   * for `USER_SCOPE_SHED_PROCESS_KEYS` (dropping the daemon user's `~/.claude`
   * scope — plugin SKILL.md tree + claude.ai connector schemas — from the
   * prompt-cache prefix) and the default `["user", "project"]` otherwise. A
   * fresh array per call: the SDK option type is mutable `SettingSource[]`.
   *
   * Applied at both `query()` sites (`executeOnce`, `executeResumeOnce`).
   * Resume carries no `processKey` (it is always a reactive DM continuation,
   * never a slim routine), so it always resolves to the full default.
   */
  private resolveSettingSources(processKey?: ProcessKey): SettingSource[] {
    if (processKey !== undefined && USER_SCOPE_SHED_PROCESS_KEYS.has(processKey)) {
      return ["project"];
    }
    return [...CLAUDE_SDK_SETTING_SOURCES];
  }

  /**
   * Whether to force `strictMcpConfig` for a session — true exactly for the
   * `USER_SCOPE_SHED_PROCESS_KEYS`, as defense-in-depth on top of the
   * `settingSources` drop (shuts out settings-file-sourced MCP servers; the
   * daemon's own servers are passed programmatically and unaffected). Resume
   * carries no `processKey`, so it never qualifies.
   */
  private resolveStrictMcpConfig(processKey?: ProcessKey): boolean {
    return processKey !== undefined && USER_SCOPE_SHED_PROCESS_KEYS.has(processKey);
  }

  /**
   * Expand CLI-style aliases ("opus", "sonnet") to their current canonical
   * API IDs. Unrecognised strings pass through unchanged so custom or
   * fine-tuned model IDs reach the SDK verbatim.
   *
   * NOTE: `"opus"` now resolves to Opus 4.7 (previously 4.6). Legacy
   * `agent_schedule.model = 'opus'` rows will silently route to 4.7 on the
   * next dispatch — intentional, since the alias means "latest Opus".
   */
  private resolveActualModelId(modelId: string): string {
    if (modelId === "opus") {
      return DEFAULT_CLAUDE_HIGH_MODEL;
    }
    if (modelId === "sonnet") {
      return DEFAULT_CLAUDE_MEDIUM_MODEL;
    }
    return modelId;
  }

  async execute(
    params: AgentExecuteParams,
    streamCallbacks?: StreamCallbacks,
  ): Promise<AgentResult> {
    return await this.runWithRetry(
      () => this.executeOnce(params, streamCallbacks),
      { eventType: params.event.type, modelId: params.modelId },
    );
  }

  private async executeOnce(
    params: AgentExecuteParams,
    streamCallbacks?: StreamCallbacks,
  ): Promise<AgentResult> {
    const {
      prompt,
      context,
      event,
      modelId,
      maxTurns,
      maxBudgetUsd,
      sessionDir,
      persistSession = false,
      conversationHistory,
      webSearchEnabled = false,
      wikiUrlFetchEnabled = false,
    } = params;

    const fullPrompt = buildExecutionPrompt(
      prompt,
      context,
      event,
      conversationHistory,
    );

    const startMs = Date.now();
    const actualModelId = this.resolveActualModelId(modelId);

    // If caller provided a persistent sessionDir, use it (non-DM Opus sessions
    // that may be resumed later). Otherwise create a disposable temp dir.
    // The disposable path also receives user skills so agent DMs that don't
    // take the persistent-workdir path can still discover user-authored skills.
    const wikiWorkspaceName =
      typeof event.data?.workspace === "string" ? event.data.workspace : undefined;
    const useSessionDir = sessionDir ?? createSessionWorkdir(
      this.config.workspaceDir,
      event.type,
      resolveUserSkillsRoot(this.config),
      {
        backendId: this.backendId,
        processKey: params.processKey,
        character: this.config.character,
        contextDir: getContextDir(this.config),
        // docs/design/appendices/skills-unification.md Phase 4 — feed the conditional
        // manifest predicates with live state. The dispatcher pre-creates
        // the workdir for DMs / high-tier sessions, so this fallback fires
        // mostly for lite-tier non-DM events; without it, those sessions
        // would resolve `gmailLifestyleActive` / `managedTasksActive` to
        // the conservative `true` branch on every dispatch.
        ...(this.mcpContext?.db ? { db: this.mcpContext.db } : {}),
        ...(isMessageEvent(event) ? { messageText: event.content } : {}),
        ...(wikiWorkspaceName ? { wikiWorkspaceName } : {}),
        // AGENT_DEFINITIONS_DESIGN.md §4.2 — fold the firing Agent's
        // `tools.skills` onto the process-key bundle. No-op for non-Agent
        // executes (the dispatcher leaves these unset).
        ...(params.extraSkills && params.extraSkills.length > 0
          ? { extraSkills: params.extraSkills }
          : {}),
        ...(params.skillsReplace ? { skillsReplace: true } : {}),
      },
    );
    const isOwnedTempDir = !sessionDir;
    const daemonReadToken = this.readTokenManager?.issue(useSessionDir) ?? this.readToken;

    const mcp = await this.materializeMcp(useSessionDir, params.processKey);
    const delegatedTools = this.getDelegatedClaudeTools();
    const nativeTools = this.getNativeClaudeTools();
    const sessionDeniedTools = this.getSessionDeniedTools();

    logger.info(
      {
        eventType: event.type,
        model: actualModelId,
        maxTurns,
        promptLen: fullPrompt.length,
        mcpServers: mcp.servers.map((s) => s.id),
        delegatedToolCount: delegatedTools.length,
        nativeToolCount: nativeTools.length,
        sessionDeniedToolCount: sessionDeniedTools.length,
      },
      "Agent execute started",
    );

    // Declared outside the try so the catch can stamp a partial-spend
    // snapshot onto the propagating error (PREPASS_COST_REDUCTION_PLAN.md N1).
    const partialUsage = createPartialUsageAccumulator();
    try {
      const allowMode = this.config.claudeExecutionPermissionMode === "allow";
      // P22 §3.4 step 4 — when the dispatcher pins a per-execute
      // `allowedToolsOverride`, suspend Allow mode for this run: the
      // optimizer agent must NOT receive `bypassPermissions`, regardless
      // of the operator's per-backend Execution Mode setting. We swap
      // back to strict `dontAsk` + the explicit allowedTools list. The
      // ALWAYS_DISALLOWED_TOOLS layer still applies.
      //
      // An EMPTY array (`[]`) is a deliberate "no tools" clamp — used by
      // `routine.activity_scan.triage` (JSON-only triage spawn) and Stage B
      // of the morning-routine pipeline (daily-journal-daemon-write.md §3
      // corollary). A pre-2026-05-24 version of this gate required
      // `length > 0`, which silently fell through to the default `dontAsk`
      // branch — leaving those callers with the full
      // `CLAUDE_DEFAULT_ALLOWED_TOOLS` set (Read / Write / Edit /
      // Bash(curl *)) despite their explicit `[]` request. The fix:
      // any caller-supplied array (including `[]`) activates the clamp.
      // Callers who want the default surface MUST pass `undefined` or
      // omit the field; passing `[]` now means "no tools, strictly."
      const optimizerClampActive = Array.isArray(params.allowedToolsOverride);
      const stream = query({
        prompt: fullPrompt,
        options: {
          model: actualModelId,
          maxTurns,
          maxBudgetUsd,
          effort: actualModelId.includes("opus") ? "high" : "medium",
          cwd: useSessionDir,
          env: {
            ...buildDaemonApiCliEnv(useSessionDir, this.config.apiPort, {
              readToken: daemonReadToken,
              sessionBackend: "claude",
              sessionId: params.sessionDbId,
              eventCorrelationId: event.correlationId,
              // PA_PROCESS_KEY → the CLI shim's x-process-key header on
              // PATCH /api/agent-actions/self; without it the self-report
              // 400s with session_identity_missing every run.
              ...(params.processKey ? { processKey: params.processKey } : {}),
            }),
            ...mcp.env,
            ...(params.turnToken ? { PA_TURN_TOKEN: params.turnToken } : {}),
          },
          systemPrompt: this.buildSystemPrompt(params.processKey),
          ...(optimizerClampActive
            ? {
                permissionMode: "dontAsk" as const,
                allowedTools: [...(params.allowedToolsOverride as readonly string[])],
                disallowedTools: [
                  ...ALWAYS_DISALLOWED_TOOLS,
                  ...this.config.disallowedTools,
                  ...mcp.disallowedTools,
                  ...sessionDeniedTools,
                ],
              }
            : allowMode
            ? {
                permissionMode: "bypassPermissions" as const,
                allowDangerouslySkipPermissions: true,
                disallowedTools: [
                  ...ALWAYS_DISALLOWED_TOOLS,
                  ...mcp.disallowedTools,
                  ...sessionDeniedTools,
                ],
              }
            : {
                permissionMode: "dontAsk" as const,
                // WIKI_BUILDER_DESIGN.md §4.3 — `wikiUrlFetchEnabled` is
                // honoured inside `getAllowedTools` (same gating contract as
                // `webSearchEnabled`: suppressed when the user configured
                // a custom `allowedToolsOverride`). Keeps the widening
                // centralised and unit-testable.
                //
                // `wikiApiOnlyWrites` is the symmetric narrowing for every
                // `wiki.*` process key: strip `Write` / `Edit` from the
                // session allowlist so the agent cannot bypass the Wiki API
                // path-classifier + `agent_actions` audit trail by writing
                // a vault path directly. The wiki-agent profile and every
                // wiki skill body already forbid this in prose; the SDK
                // gate makes the prose enforceable.
                allowedTools: this.getAllowedTools(
                  webSearchEnabled,
                  delegatedTools,
                  nativeTools,
                  wikiUrlFetchEnabled,
                  params.processKey?.startsWith("wiki.") ?? false,
                ),
                disallowedTools: [
                  ...ALWAYS_DISALLOWED_TOOLS,
                  ...this.config.disallowedTools,
                  ...mcp.disallowedTools,
                  ...sessionDeniedTools,
                ],
              }),
          ...(() => {
            const mcpServers = this.composeMcpServers(
              mcp.claudeMcpServers,
              params.observationsSink,
            );
            return mcpServers ? { mcpServers } : {};
          })(),
          // RESEARCH_CLUSTER_COST_FIX_PLAN.md F4 — `USER_SCOPE_SHED_PROCESS_KEYS`
          // drop to `["project"]` (+ `strictMcpConfig`) to shed the daemon
          // user's `~/.claude` scope from the prompt-cache prefix; all other
          // keys keep `["user", "project"]`.
          settingSources: this.resolveSettingSources(params.processKey),
          ...(this.resolveStrictMcpConfig(params.processKey)
            ? { strictMcpConfig: true as const }
            : {}),
          // When the per-execute clamp is active we already swapped Allow
          // mode back to strict `dontAsk` + an explicit allowedTools list.
          // The PreToolUse hooks must follow the same posture: keeping
          // `allowMode=true` here would drop the curl localhost-only check
          // and the jq env/file-flag check, leaving exfil paths open even
          // though the clamp itself permits `Bash(curl *)` and `Bash(jq *)`.
          hooks: this.getSecurityHooks(optimizerClampActive ? false : allowMode),
          persistSession,
          includePartialMessages: !!streamCallbacks,
          ...this.buildAdvisorSettings(),
        },
      });

      const result = await this.withTimeout(
        stream,
        () =>
          this.consumeStream(
            stream,
            actualModelId,
            startMs,
            streamCallbacks,
            event.type,
            partialUsage,
          ),
        this.config.executeTimeoutMinutes,
      );
      logger.info(
        { eventType: event.type, model: actualModelId, durationMs: result.durationMs, costUsd: result.costUsd, numTurns: result.numTurns, isError: result.isError },
        "Agent execute completed",
      );
      return result;
    } catch (err) {
      this.stampPartialSpend(err, partialUsage, actualModelId, startMs, maxBudgetUsd);
      logger.error(
        { err, eventType: event.type, model: actualModelId, durationMs: Date.now() - startMs },
        "Agent execute failed",
      );
      throw err;
    } finally {
      if (isOwnedTempDir) {
        this.readTokenManager?.revoke(useSessionDir);
      }
      // Only clean up temp dirs we created; caller-owned dirs have their own lifecycle
      if (isOwnedTempDir) {
        cleanupSessionWorkdir(useSessionDir);
      }
    }
  }

  async executeResume(
    params: AgentResumeParams,
    streamCallbacks?: StreamCallbacks,
  ): Promise<AgentResult> {
    return await this.runWithRetry(
      () => this.executeResumeOnce(params, streamCallbacks),
      { sessionId: params.sessionId, modelId: params.modelId },
    );
  }

  private async executeResumeOnce(
    params: AgentResumeParams,
    streamCallbacks?: StreamCallbacks,
  ): Promise<AgentResult> {
    const { sessionId, message, modelId, sessionDir, webSearchEnabled = false } = params;
    const startMs = Date.now();
    const actualModelId = this.resolveActualModelId(modelId);
    const isOpusTier = actualModelId.includes("opus");
    const maxTurns = params.maxTurns ?? (isOpusTier ? 300 : 50);
    const maxBudgetUsd = params.maxBudgetUsd ?? (isOpusTier ? 5.0 : 1.0);
    if (!sessionDir) {
      throw new Error("sessionDir is required for executeResume — SDK stores session history per-cwd");
    }
    const daemonReadToken = this.readTokenManager?.issue(sessionDir) ?? this.readToken;

    // Resume is always a reactive DM continuation (owner in the loop), so the
    // approve-tier MCP strip stays off even for otherwise-autonomous process
    // keys. `materializeMcp` short-circuits on no context / no servers.
    const mcp = await this.materializeMcp(sessionDir, undefined);
    const delegatedTools = this.getDelegatedClaudeTools();
    const nativeTools = this.getNativeClaudeTools();
    const sessionDeniedTools = this.getSessionDeniedTools();

    logger.info(
      {
        sessionId,
        model: actualModelId,
        maxTurns,
        mcpServers: mcp.servers.map((s) => s.id),
        delegatedToolCount: delegatedTools.length,
        nativeToolCount: nativeTools.length,
        sessionDeniedToolCount: sessionDeniedTools.length,
      },
      "Agent resume started",
    );

    // Use the same cwd as the original execute() so the SDK can find
    // the session history (stored per-cwd in ~/.claude/projects/).
    const allowMode = this.config.claudeExecutionPermissionMode === "allow";
    const stream = query({
      prompt: message,
      options: {
        resume: sessionId,
        maxTurns,
        maxBudgetUsd,
        cwd: sessionDir,
        env: {
          ...buildDaemonApiCliEnv(sessionDir, this.config.apiPort, {
            readToken: daemonReadToken,
            sessionBackend: "claude",
            sessionId: params.sessionDbId,
            eventCorrelationId: params.eventCorrelationId,
          }),
          ...mcp.env,
          ...(params.turnToken ? { PA_TURN_TOKEN: params.turnToken } : {}),
        },
        systemPrompt: this.buildSystemPrompt(),
        ...(allowMode
          ? {
              permissionMode: "bypassPermissions" as const,
              allowDangerouslySkipPermissions: true,
              disallowedTools: [
                ...ALWAYS_DISALLOWED_TOOLS,
                ...mcp.disallowedTools,
                ...sessionDeniedTools,
              ],
            }
          : {
              permissionMode: "dontAsk" as const,
              allowedTools: this.getAllowedTools(
                webSearchEnabled,
                delegatedTools,
                nativeTools,
              ),
              disallowedTools: [
                ...ALWAYS_DISALLOWED_TOOLS,
                ...this.config.disallowedTools,
                ...mcp.disallowedTools,
                ...sessionDeniedTools,
              ],
            }),
        ...(() => {
          const mcpServers = this.composeMcpServers(mcp.claudeMcpServers);
          return mcpServers ? { mcpServers } : {};
        })(),
        // Resume is always a reactive DM continuation (no `processKey`), so
        // `resolveSettingSources()` returns the full `["user", "project"]`;
        // routed through the helper for a single source of truth with the
        // execute path (RESEARCH_CLUSTER_COST_FIX_PLAN.md F4).
        settingSources: this.resolveSettingSources(),
        hooks: this.getSecurityHooks(allowMode),
        includePartialMessages: !!streamCallbacks,
        ...this.buildAdvisorSettings(),
      },
    });

    const partialUsage = createPartialUsageAccumulator();
    try {
      return await this.withTimeout(
        stream,
        () =>
          this.consumeStream(
            stream,
            actualModelId,
            startMs,
            streamCallbacks,
            "message.received",
            partialUsage,
          ),
        this.config.executeTimeoutMinutes,
      );
    } catch (err) {
      this.stampPartialSpend(err, partialUsage, actualModelId, startMs, maxBudgetUsd);
      throw err;
    }
  }

  private async runWithRetry<T>(
    fn: () => Promise<T>,
    context: Record<string, string | number>,
  ): Promise<T> {
    let lastError: unknown;

    for (let attempt = 0; attempt <= ClaudeCodeCore.MAX_RETRIES; attempt++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error;
        if (
          attempt < ClaudeCodeCore.MAX_RETRIES &&
          this.isRetryableExecutionError(error)
        ) {
          logger.warn(
            {
              ...context,
              attempt: attempt + 1,
              maxRetries: ClaudeCodeCore.MAX_RETRIES,
              error: this.getErrorMessage(error),
            },
            "Retrying Claude backend after transient failure",
          );
          await this.sleep(ClaudeCodeCore.RETRY_DELAY_MS);
          continue;
        }
        throw this.classifyExecutionError(error);
      }
    }

    throw this.classifyExecutionError(lastError);
  }

  private isRetryableExecutionError(error: unknown): boolean {
    if (
      error instanceof BackendQuotaError ||
      error instanceof BackendDecisiveFailure
    ) {
      return false;
    }

    if (error instanceof AgentTimeoutError) {
      return true;
    }
    if (isClaudeCodeQuotaError(error)) {
      return false;
    }

    const status = this.getErrorStatus(error);
    if (typeof status === "number" && status >= 500) {
      return true;
    }

    const code = this.getErrorCode(error)?.toUpperCase();
    if (
      code &&
      ["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EPIPE", "ECONNABORTED", "ENOTFOUND"].includes(code)
    ) {
      return true;
    }

    return ClaudeCodeCore.NETWORK_ERROR_MESSAGE_PATTERN.test(
      this.getErrorMessage(error),
    );
  }

  /**
   * PREPASS_COST_REDUCTION_PLAN.md N1 — build a spend snapshot from the
   * stream's partial-usage accumulator and stamp it onto the propagating
   * error so `classifyExecutionError` / `toBackendQuotaError` (which only
   * see the error object) can lift it onto the classified failure.
   *
   * Dollar figure: estimated from the accumulated tokens via the shared
   * price fetcher. For the SDK's `max_budget_usd` abort the figure is
   * additionally floored at the cap — the SDK's own metering crossed it,
   * so any lower estimate (e.g. usage observed only for the first few
   * messages) would under-report what was actually billed. `costSource`
   * is `"sdk_partial"` to mark the figure as a partial reconstruction.
   *
   * No-op when nothing recordable exists: no usage observed AND the
   * error is not a budget abort with a known cap.
   */
  private stampPartialSpend(
    error: unknown,
    acc: PartialUsageAccumulator,
    modelId: string,
    startMs: number,
    maxBudgetUsd: number | undefined,
  ): void {
    try {
      if (
        error instanceof BackendQuotaError
        || error instanceof BackendDecisiveFailure
      ) {
        // Already classified upstream (carries its own spend or lack of
        // one) — re-stamping could only disagree with the classified
        // payload.
        return;
      }
      const isBudgetAbort = isClaudeCodeMaxBudgetError(error);
      const sawUsage = accumulatorSawUsage(acc);
      if (!sawUsage && !(isBudgetAbort && typeof maxBudgetUsd === "number")) {
        return;
      }
      const estimated = sawUsage && this.priceFetcher
        ? this.priceFetcher.estimateUsageCost({
            backendId: this.backendId,
            modelId,
            usage: acc.usage,
            fallbackModel: findRegisteredModel(this.backendId, modelId),
          }).costUsd
        : 0;
      const costUsd = isBudgetAbort
        ? Math.max(estimated, maxBudgetUsd ?? 0)
        : estimated;
      attachPartialSpend(error, {
        usage: { ...acc.usage },
        costUsd,
        modelId,
        numTurns: acc.numTurns,
        durationMs: Date.now() - startMs,
        costSource: "sdk_partial",
      });
    } catch (stampErr) {
      // Best-effort telemetry — never mask the original failure.
      logger.warn(
        { err: stampErr, modelId },
        "Failed to stamp partial spend onto Claude execution error",
      );
    }
  }

  /** Visible for testing. */
  classifyExecutionError(
    error: unknown,
  ): BackendQuotaError | BackendDecisiveFailure {
    if (
      error instanceof BackendQuotaError ||
      error instanceof BackendDecisiveFailure
    ) {
      return error;
    }

    const quotaError = this.toBackendQuotaError(error);
    if (quotaError) {
      return quotaError;
    }
    const partialSpend = getAttachedPartialSpend(error);
    if (error instanceof AgentTimeoutError) {
      return new BackendDecisiveFailure(
        this.backendId,
        "timeout",
        error,
        partialSpend,
      );
    }
    if (this.isAuthError(error)) {
      return new BackendDecisiveFailure(
        this.backendId,
        "auth",
        error,
        partialSpend,
      );
    }
    // FETCH_WINDOW_TURN_LIMIT_FIX_PLAN.md P1.1 safety net — the primary
    // turn-limit capture throws a typed `max_turns` failure from
    // `consumeStream` (returned as-is by the instanceof branch above).
    // This message-shape match only fires when the SDK transport's wrapped
    // throw arrived WITHOUT the terminal result message being observed;
    // without it a turn-limit kill would fall through to the opaque
    // `other_non_retryable`.
    if (isClaudeCodeMaxTurnsError(error)) {
      return new BackendDecisiveFailure(
        this.backendId,
        "max_turns",
        error,
        partialSpend,
      );
    }
    return new BackendDecisiveFailure(
      this.backendId,
      "other_non_retryable",
      error,
      partialSpend,
    );
  }

  private toBackendQuotaError(error: unknown): BackendQuotaError | null {
    if (isClaudeCodeMaxBudgetError(error)) {
      // The partial-spend snapshot stamped by `stampPartialSpend` is the
      // only usage figure that exists for a budget abort — the SDK kills
      // the stream before the terminal `result` message
      // (PREPASS_COST_REDUCTION_PLAN.md N1).
      return new BackendQuotaError(
        this.backendId,
        "max_budget_usd",
        null,
        this.getErrorMessage(error),
        getAttachedPartialSpend(error),
      );
    }

    if (!isClaudeCodeQuotaError(error)) {
      return null;
    }

    const hint = extractClaudeCodeQuotaResetHint(error);
    return new BackendQuotaError(
      this.backendId,
      this.getErrorCode(error) ?? "rate_limited",
      hint ? this.toBackendQuotaResetHint(hint) : null,
      this.getErrorMessage(error),
      getAttachedPartialSpend(error),
    );
  }

  private toBackendQuotaResetHint(
    hint: ClaudeCodeQuotaResetHint,
  ): BackendQuotaResetHint {
    return {
      hour: hint.hour,
      minute: hint.minute,
      timeZone: hint.timeZone,
      rawLabel: hint.rawLabel,
    };
  }

  // Transitional shims — file-split-plan §15. The implementations live in
  // `./claude-auth.ts`; these methods stay on the class so internal call
  // sites (`this.getErrorMessage(...)`, etc.) and test files that reach in
  // via `(core as any).isAuthError(...)` keep compiling against the same
  // surface. Remove once all callers are migrated to the module-level
  // exports.
  private isAuthError(error: unknown): boolean {
    return isAuthError(error);
  }

  private getErrorStatus(error: unknown): number | undefined {
    return getErrorStatus(error);
  }

  private getErrorCode(error: unknown): string | undefined {
    return getErrorCode(error);
  }

  private getErrorType(error: unknown): string | undefined {
    return getErrorType(error);
  }

  private getErrorMessage(error: unknown): string {
    return getErrorMessage(error);
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      timer.unref?.();
    });
  }

  async summarize(conversationText: string): Promise<string> {
    const prompt = buildSummaryPrompt(conversationText);

    const startMs = Date.now();
    const sessionDir = createSessionWorkdir(
      this.config.workspaceDir,
      "message.received",
      undefined,
      { backendId: this.backendId, character: this.config.character },
    );
    const daemonReadToken = this.readTokenManager?.issue(sessionDir) ?? this.readToken;
    try {
      // Light-tier model for cheap conversation summarization. Tracks the
      // canonical default in MODEL_REGISTRY so a Sonnet generation bump
      // propagates here for free, mirroring how Codex/Gemini do it via
      // their own `pickSummaryModel()` helpers.
      const summaryModel = DEFAULT_CLAUDE_MEDIUM_MODEL;
      const stream = query({
        prompt,
        options: {
          model: summaryModel,
          maxTurns: 1,
          maxBudgetUsd: 0.25,
          cwd: sessionDir,
          env: buildDaemonApiCliEnv(sessionDir, this.config.apiPort, { readToken: daemonReadToken, sessionBackend: "claude" }),
          systemPrompt: { type: "preset", preset: "claude_code" },
          permissionMode: "dontAsk",
          allowedTools: [],
          settingSources: [...CLAUDE_SDK_SETTING_SOURCES],
        },
      });
      const result = await this.withTimeout(
        stream,
        () => this.consumeStream(stream, summaryModel, startMs),
        this.config.executeTimeoutMinutes,
      );
      return result.output || "";
    } finally {
      this.readTokenManager?.revoke(sessionDir);
      cleanupSessionWorkdir(sessionDir);
    }
  }

  /**
   * Cheap presence check used by the reactive execute path. Detailed probe
   * lives in `checkAuthDetailed`. Implementation moved to `./claude-auth.ts`
   * (file-split-plan §8, Tier 2); this stays as a thin forwarder so the
   * `IAgentCore` interface contract is unchanged and existing call sites in
   * `BackendRouter` / `AuthHealthMonitor` continue to work.
   */
  async checkAuth(): ReturnType<typeof checkAuthFn> {
    return checkAuthFn({ cliPath: this.cliPath });
  }

  /**
   * Detailed auth probe used by `AuthHealthMonitor` and the dashboard setup
   * wizard. Implementation moved to `./claude-auth.ts`; see the comment on
   * `checkAuth` above.
   */
  async checkAuthDetailed(): Promise<AuthCheckResult> {
    return checkAuthDetailedFn({ cliPath: this.cliPath });
  }

  /**
   * Phase 5 §4.11 live probe. Claude Code 2.1+ may defer large MCP tool
   * manifests behind `ToolSearch`, so the old zero-turn `system.init.tools`
   * capture is no longer sufficient for hosted claude.ai connectors like
   * Gmail and Google Calendar. Run a tightly-scoped turn that can only use
   * the read-only ToolSearch catalog, then extract connector names from
   * both returned `tool_reference` blocks and the final printed answer.
   */
  async probeTools(): Promise<string[]> {
    const sessionDir = createSessionWorkdir(
      this.config.workspaceDir,
      "message.received",
      undefined,
      { backendId: this.backendId, character: this.config.character },
    );
    const daemonReadToken = this.readTokenManager?.issue(sessionDir) ?? this.readToken;
    try {
      const stream = query({
        prompt: CLAUDE_PROBE_TOOLS_PROMPT,
        options: {
          model: DEFAULT_CLAUDE_MEDIUM_MODEL,
          maxTurns: 3,
          maxBudgetUsd: 0.25,
          cwd: sessionDir,
          env: buildDaemonApiCliEnv(sessionDir, this.config.apiPort, { readToken: daemonReadToken, sessionBackend: "claude" }),
          systemPrompt: { type: "preset", preset: "claude_code" },
          permissionMode: "dontAsk",
          allowedTools: ["ToolSearch"],
          settingSources: [...CLAUDE_SDK_SETTING_SOURCES],
        },
      });

      const tools = await new Promise<string[]>((resolve, reject) => {
        const timer = setTimeout(() => {
          void (async () => {
            try {
              await stream.return?.(undefined);
            } catch {
              /* stream already closed */
            }
          })();
          reject(new Error("probeTools: timeout waiting for ToolSearch probe"));
        }, 60_000);
        timer.unref?.();

        void (async () => {
          const collected: string[] = [];
          let terminalError: string | null = null;
          try {
            for await (const message of stream) {
              collected.push(...extractClaudeProbeTools(message));
              if (message.type === "result") {
                const result = message as SDKResultMessage;
                if (result.is_error) {
                  terminalError = describeClaudeProbeResultError(result);
                }
              }
            }
            clearTimeout(timer);
            const deduped = Array.from(new Set(collected));
            if (terminalError && deduped.length === 0) {
              reject(new Error(`probeTools: ${terminalError}`));
              return;
            }
            resolve(deduped);
          } catch (err) {
            clearTimeout(timer);
            reject(err instanceof Error ? err : new Error(String(err)));
          }
        })();
      });

      logger.info({ toolCount: tools.length }, "Live probe collected tool manifest");
      return tools;
    } finally {
      this.readTokenManager?.revoke(sessionDir);
      cleanupSessionWorkdir(sessionDir);
    }
  }

  listModels(): ReadonlyArray<BackendModel> {
    const defaultMediumModel = DEFAULT_CLAUDE_MEDIUM_MODEL;
    const defaultHighModel = DEFAULT_CLAUDE_HIGH_MODEL;
    const configuredModels = [
      {
        ...(findRegisteredModel(this.backendId, defaultMediumModel) ?? {
          backendId: this.backendId,
          modelId: defaultMediumModel,
          label: defaultMediumModel,
          tier: "medium" as const,
          available: true,
        }),
      },
      {
        ...(findRegisteredModel(this.backendId, defaultHighModel) ?? {
          backendId: this.backendId,
          modelId: defaultHighModel,
          label: defaultHighModel,
          tier: "high" as const,
          available: true,
        }),
      },
    ];
    const models = [...configuredModels, ...getModelsForBackend(this.backendId)];

    return models.filter(
      (model, index, list) =>
        list.findIndex((candidate) => candidate.modelId === model.modelId) === index,
    );
  }

  private async consumeStream(
    stream: Query,
    model: string,
    startMs: number,
    streamCallbacks?: StreamCallbacks,
    eventType?: string,
    /**
     * PREPASS_COST_REDUCTION_PLAN.md N1 — live per-message usage sink the
     * caller keeps a reference to. When the stream throws before the
     * terminal `result` message, the caller stamps a spend snapshot built
     * from this accumulator onto the propagating error.
     */
    partialUsage?: PartialUsageAccumulator,
  ): Promise<AgentResult> {
    let output = "";
    let streamedOutput = "";
    let sessionId: string | null = null;
    let costUsd = 0;
    let usage = {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    };
    const modelUsage: AgentResult["modelUsage"] = {};
    let numTurns = 0;
    let durationApiMs = 0;
    let isError = false;
    let stopReason: string | null = null;

    // Context-update tracking (Phase 6 + H2 refinement).
    const contextUpdateCalls = new Set<string>();
    const failedContextUpdates = new Set<string>();

    // Advisor tool invocation count — incremented each time the SDK stream
    // emits a `server_tool_use` content block with `name: "advisor"`. This is
    // the `advisor_20260301` Anthropic-hosted tool. See `docs/advisor.md`.
    let advisorCallCount = 0;

    // B-003 Phase 4.4 — MCP tool result matching.
    // Maps tool_use_id → { rowId, startMs } so that when the SDK delivers the
    // matching tool_result block we can backfill ok/error/duration_ms.
    // startMs is set when the assistant message containing the tool_use block is
    // processed. The resulting duration_ms therefore covers SDK dispatch latency
    // (model → executor → result delivery) rather than pure tool execution time.
    const mcpPendingResults = new Map<string, { rowId: number; startMs: number }>();

    try {
      for await (const message of stream) {
        if (message.type === "system" && message.subtype === "init") {
          const sysMsg = message as SDKSystemMessage;
          sessionId = sysMsg.session_id;
          logger.debug({ sessionId, model: sysMsg.model }, "Session initialized");
        } else if (message.type === "stream_event") {
          // Forward streaming text deltas to the caller (e.g., dashboard SSE).
          // The SDK union doesn't surface `.event` on the stream_event variant,
          // so narrow with a local shape that mirrors what the runtime emits.
          const event = (message as { event?: {
            type?: string;
            delta?: { type?: string; text?: string };
          } }).event;
          if (event?.type === "content_block_delta" && event.delta?.type === "text_delta") {
            const text = event.delta.text ?? "";
            streamedOutput += text;
            streamCallbacks?.onText?.(text);
          }
        } else if (message.type === "assistant") {
          // Track Bash tool_use blocks that hit the context API + server-side
          // advisor tool invocations.
          const assistantMsg = message as SDKAssistantMessage;
          if (partialUsage) {
            recordAssistantUsage(
              partialUsage,
              (assistantMsg.message as { usage?: unknown } | undefined)?.usage,
            );
          }
          const blocks = assistantMsg.message?.content;
          if (Array.isArray(blocks)) {
            for (const block of blocks) {
              if (!block || typeof block !== "object") continue;
              const blockType = (block as { type?: string }).type;
              const blockName = (block as { name?: string }).name;

              if (blockType === "tool_use" && blockName === "Bash") {
                const toolUseId = (block as { id?: string }).id;
                const cmd = (
                  (block as { input?: { command?: unknown } }).input?.command ?? ""
                ) as string;
                logger.info(
                  {
                    eventType,
                    sessionId,
                    toolUseId,
                    cmd: typeof cmd === "string" ? cmd.slice(0, 400) : null,
                  },
                  "Bash tool_use",
                );
                if (
                  typeof toolUseId === "string" &&
                  typeof cmd === "string" &&
                  ClaudeCodeCore.isContextUpdateCommand(cmd)
                ) {
                  contextUpdateCalls.add(toolUseId);
                }
              } else if (
                blockType === "tool_use" &&
                typeof blockName === "string" &&
                blockName.startsWith("mcp__")
              ) {
                // B-003 Phase 4.4 — persist MCP tool call to `mcp_tool_calls`.
                // Capture tool_use_id + start time so we can match the result
                // block that arrives later in a `user` message.
                const parsed = parseMcpToolName(blockName);
                if (parsed) {
                  logger.debug(
                    {
                      serverId: parsed.serverId,
                      toolName: parsed.toolName,
                      sessionId,
                      eventType,
                    },
                    "mcp.tool_call",
                  );
                  if (this.mcpContext?.db) {
                    try {
                      const rowId = logMcpToolCall(this.mcpContext.db, {
                        serverId: parsed.serverId,
                        toolName: parsed.toolName,
                        eventType,
                        sessionId: sessionId ?? undefined,
                      });
                      const toolUseId = (block as { id?: string }).id;
                      if (typeof toolUseId === "string") {
                        mcpPendingResults.set(toolUseId, { rowId, startMs: Date.now() });
                      }
                    } catch (err) {
                      logger.warn({ err, serverId: parsed.serverId }, "mcp.tool_call audit insert failed");
                    }
                  }
                }
              } else if (
                blockType === "server_tool_use" &&
                blockName === "advisor"
              ) {
                // The advisor_20260301 server-side tool. The SDK emits one
                // server_tool_use per invocation; we count them here.
                advisorCallCount += 1;
              }
            }
          }
        } else if (message.type === "user") {
          // The SDK emits the tool_result that feeds back to the model
          // as a 'user' message whose content array contains
          // tool_result blocks. Check is_error on each result matched
          // against our pending context tool_use ids, and scan the
          // merged tool output for PA_API_ERROR markers emitted by the
          // daemon API wrappers.
          const userMsg = message as SDKUserMessage;
          const content = userMsg.message?.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (
                block &&
                (block as { type?: string }).type === "tool_result"
              ) {
                const toolUseId = (block as { tool_use_id?: string }).tool_use_id;
                const isError = (block as { is_error?: boolean }).is_error === true;

                if (typeof toolUseId === "string") {
                  // Context-update error tracking.
                  if (contextUpdateCalls.has(toolUseId) && isError) {
                    failedContextUpdates.add(toolUseId);
                  }

                  // B-003 Phase 4.4 — backfill ok/error/duration_ms for MCP tool calls.
                  const pending = mcpPendingResults.get(toolUseId);
                  if (pending && this.mcpContext?.db) {
                    const ok = !isError;
                    const errorText = isError
                      ? flattenToolResultContent(
                          (block as { content?: unknown }).content,
                        ).slice(0, 1000) || null
                      : null;
                    const durationMs = Date.now() - pending.startMs;
                    try {
                      updateMcpToolCallResult(this.mcpContext.db, pending.rowId, ok, errorText, durationMs);
                    } catch (err) {
                      logger.warn({ err, rowId: pending.rowId }, "mcp.tool_call result update failed");
                    }
                    mcpPendingResults.delete(toolUseId);
                  }
                }

                const resultText = flattenToolResultContent(
                  (block as { content?: unknown }).content,
                );
                if (isError) {
                  logger.info(
                    {
                      eventType,
                      sessionId,
                      toolUseId,
                      resultText: resultText.slice(0, 600),
                    },
                    "tool_result error",
                  );
                }
                const apiErrors = extractSilentApiErrors(resultText);
                if (apiErrors.length > 0) {
                  logSilentApiErrors(logger, apiErrors, {
                    backendId: this.backendId,
                    sessionId,
                    eventType,
                  });
                }
              }
            }
          }
        } else if (message.type === "result") {
          const r = message as SDKResultMessage;
          if (r.subtype === "success") {
            const resultOutput = typeof r.result === "string" ? r.result : "";
            // Claude SDK can stream assistant text and still report an empty
            // final result when the turn ends after a tool-only message.
            output =
              resultOutput.trim().length > 0
                ? resultOutput
                : streamedOutput.trim().length > 0
                  ? streamedOutput
                  : resultOutput;
          }
          sessionId = r.session_id;
          costUsd = r.total_cost_usd;
          usage = {
            inputTokens: r.usage.input_tokens,
            outputTokens: r.usage.output_tokens,
            cacheCreationInputTokens: r.usage.cache_creation_input_tokens ?? 0,
            cacheReadInputTokens: r.usage.cache_read_input_tokens ?? 0,
          };
          // Convert SDK modelUsage to our format
          for (const [modelName, mu] of Object.entries(r.modelUsage)) {
            modelUsage[modelName] = {
              inputTokens: mu.inputTokens,
              outputTokens: mu.outputTokens,
              costUsd: mu.costUSD,
            };
          }
          numTurns = r.num_turns;
          durationApiMs = r.duration_api_ms;
          isError = r.is_error;
          stopReason = r.stop_reason;

          if (r.subtype !== "success") {
            logger.warn(
              { subtype: r.subtype, errors: "errors" in r ? r.errors : [] },
              "Agent session ended with error",
            );
          }

          // FETCH_WINDOW_TURN_LIMIT_FIX_PLAN.md P1.1 — a turn-limit kill is
          // an SDK *policy stop*, not a backend fault. The model gets no
          // final turn, and after yielding this terminal result the SDK
          // transport throws `Error("Claude Code returned an error result:
          // Reached maximum number of turns (N)")` on the next readMessages
          // step — which the outer catch would misclassify as
          // `other_non_retryable`, hiding the real cause from the audit
          // trail and the retry matrix (`claude-delegated.ts` fixed the
          // same masking for the delegated path). Throw the typed failure
          // here instead, carrying this result message's authoritative
          // usage/cost — richer than the partial-usage accumulator the
          // generic throw path would have to fall back on.
          if (r.subtype === "error_max_turns") {
            const sdkErrors =
              "errors" in r && Array.isArray(r.errors) ? r.errors : [];
            throw new BackendDecisiveFailure(
              this.backendId,
              "max_turns",
              new Error(
                sdkErrors.length > 0
                  ? sdkErrors.join("; ")
                  : `Claude Code stopped the session at the maximum number of turns (${r.num_turns})`,
              ),
              {
                usage: { ...usage },
                costUsd,
                modelId: model,
                numTurns,
                durationMs: Date.now() - startMs,
                costSource: "sdk",
              },
            );
          }
        }
      }
    } finally {
      // Always signal stream completion — even on error — so the client's
      // streaming state is reset (prevents stuck "streaming = true").
      streamCallbacks?.onEnd?.();
    }

    const contextUpdated =
      contextUpdateCalls.size > failedContextUpdates.size;

    return {
      output,
      sessionId,
      backendId: this.backendId,
      modelId: model,
      costSource: "sdk",
      costUsd,
      usage,
      modelUsage,
      numTurns,
      durationMs: Date.now() - startMs,
      durationApiMs,
      model,
      isError,
      stopReason,
      contextUpdated,
      advisorCallCount,
    };
  }

  /**
   * Race `fn()` against an `executeTimeoutMinutes` wall-clock timer.
   *
   * On timeout we must terminate the underlying SDK stream too — otherwise
   * `Promise.race` just rejects while `query()` keeps running in the
   * background, which in retry scenarios would produce two concurrent
   * Claude Code sessions for the same event and double quota consumption.
   */
  private async withTimeout<T>(
    stream: Query,
    fn: () => Promise<T>,
    timeoutMinutes: number,
  ): Promise<T> {
    const timeoutMs = timeoutMinutes * 60 * 1000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;

    const fnPromise = fn();
    // Attach a no-op catch so post-timeout rejections from fn() don't
    // surface as unhandledRejection once Promise.race has already resolved.
    fnPromise.catch(() => undefined);

    try {
      return await Promise.race([
        fnPromise,
        new Promise<T>((_, reject) => {
          timer = setTimeout(() => {
            timedOut = true;
            reject(new AgentTimeoutError(timeoutMs));
            // Cancel the SDK stream asynchronously.
            void (async () => {
              try {
                const iterable = stream as unknown as AsyncIterable<unknown>;
                const iterator =
                  typeof iterable[Symbol.asyncIterator] === "function"
                    ? iterable[Symbol.asyncIterator]()
                    : null;
                await iterator?.return?.(undefined);
              } catch {
                // ignore — cancellation is best-effort
              }
            })();
          }, timeoutMs);
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
      void timedOut; // reference to avoid unused-variable if optimizer drops it
    }
  }

  /**
   * Detect whether a Bash command invokes a write against the Context
   * File API (`PUT|PATCH /api/context/*` via curl).
   */
  static isContextUpdateCommand(command: string): boolean {
    if (!/\bcurl\b/.test(command)) return false;
    if (!/\/api\/context\//.test(command)) return false;

    const segments = command.split(/[;&|\n]+/);
    for (const seg of segments) {
      if (!/\bcurl\b/.test(seg)) continue;
      if (!/\/api\/context\//.test(seg)) continue;
      if (/(?:-X|--request)\s+(?:PUT|PATCH)\b/.test(seg)) {
        return true;
      }
    }
    return false;
  }

  // Template resolution and event data extraction are shared with Codex/Gemini
  // backends via prompt-utils.ts (buildExecutionPrompt, extractEventData).

  /**
   * Allowed tools whitelist for dontAsk permission mode.
   *
   * `delegatedTools` is UNION'd onto the returned list — even when
   * `allowedToolsOverride` is set. This is a deliberate deviation from the
   * override's otherwise-absolute "replace everything" contract (see
   * `CRITICAL_OVERRIDE_TOOLS`, which warns but does not union).
   * Rationale: delegated mode is a runtime-configurable axis orthogonal to
   * the dashboard's tool-customization override. If a user set the override
   * before flipping an integration to delegated, silently dropping the
   * registry-declared connector tools would break mail/calendar with a
   * misleading "permission denied" DM. Union semantics keep the override's
   * curation intent while letting delegated mode widen the surface to
   * whatever the registry already advertised.
   */
  // Transitional shims — file-split-plan §15. Implementations live in
  // `./claude-tool-collection.ts`; the class methods stay so existing call
  // sites and the test file (`(core as any).getAllowedTools(...)`) keep
  // working without modification. See the comment header of
  // `claude-tool-collection.ts` for the design rationale.
  private getAllowedTools(
    webSearchEnabled: boolean,
    delegatedTools: readonly string[] = [],
    nativeTools: readonly string[] = [],
    wikiUrlFetchEnabled = false,
    wikiApiOnlyWrites = false,
  ): string[] {
    return getAllowedToolsFn(
      this.config,
      webSearchEnabled,
      delegatedTools,
      nativeTools,
      wikiUrlFetchEnabled,
      wikiApiOnlyWrites,
    );
  }

  private getDelegatedClaudeTools(): readonly string[] {
    return getDelegatedClaudeToolsFn(this.mcpContext);
  }

  private getNativeClaudeTools(): readonly string[] {
    return getNativeClaudeToolsFn(this.mcpContext);
  }

  private getSessionDeniedTools(): readonly string[] {
    return getSessionDeniedToolsFn(this.mcpContext);
  }

  /**
   * Security hooks — thin shim that forwards to `buildSecurityHooks` in
   * `./claude-tool-collection.ts`. The implementation lives there as a
   * pure factory consuming a `SecurityHooksDeps` record. See that module
   * for hook semantics; see `file-split-plan.md` §8 + §15 for why the
   * shim stays here.
   */
  private getSecurityHooks(allowMode = false) {
    return buildSecurityHooks(
      {
        config: this.config,
        writeTracker: this.writeTracker,
        // Thunk — see `SecurityHooksDeps.getMcpContext` JSDoc. The hook
        // reads the live reference at fire time so it picks up any
        // `setMcpContext` call that happens between hook build and the
        // SDK invoking the matcher (faithful to original this.mcpContext
        // semantics).
        getMcpContext: () => this.mcpContext,
      },
      allowMode,
    );
  }

  /**
   * Delegated-execution deps bundle. Built fresh per call so the captured
   * `readTokenManager` / `readToken` reflect the latest state of the core's
   * mutable fields (both can be re-wired post-construction via
   * `setReadToken` / `setReadTokenManager`).
   *
   * Snapshot semantics — once handed to `runDelegated{Tool,Task}Fn`, the
   * deps record is treated as immutable for the duration of the call. This
   * is a deliberate, narrow strengthening of the pre-split behavior: the
   * original re-read `this.readTokenManager` at revoke time, so a
   * (hypothetical) mid-call replacement would revoke on the *new* manager
   * — leaving a scope leak on the manager that issued the token.
   * Production never replaces the manager after boot (`index.ts` wires it
   * exactly once via `setReadTokenManager?`), so the two behaviors converge
   * in practice; the new shape is simply more robust by construction.
   */
  private delegatedDeps(): ClaudeDelegatedDeps {
    return {
      apiPort: this.config.apiPort,
      readToken: this.readToken,
      readTokenManager: this.readTokenManager,
    };
  }

  /**
   * Delegated proxy invocation — DELEGATED-PROXY-API-DESIGN.md §4.5.
   * Implementation moved to `./claude-delegated.ts` (file-split-plan §8,
   * Tier 2); this stays as a thin forwarder so the `IAgentCore` interface
   * contract and existing call sites in `BackendRouter` /
   * `DelegatedBackendInvoker` continue to dispatch through
   * `core.runDelegatedTool`.
   */
  async runDelegatedTool(
    params: DelegatedToolInvokeParams,
  ): Promise<DelegatedToolResult> {
    return runDelegatedToolFn(this.delegatedDeps(), params);
  }

  /**
   * Delegated task-mode invocation — DELEGATED-TASK-MODE-DESIGN.md §9.1.
   * Implementation moved to `./claude-delegated.ts`; see the comment on
   * `runDelegatedTool` above.
   */
  async runDelegatedTask(
    params: DelegatedTaskInvokeParams,
  ): Promise<DelegatedTaskResultRaw> {
    return runDelegatedTaskFn(this.delegatedDeps(), params);
  }
}
