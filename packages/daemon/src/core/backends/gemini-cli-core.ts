import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import type Database from "better-sqlite3";
import {
  APP_NAME,
  collectSessionDeniedTools,
  getAgentDayDateStr,
  INTEGRATION_DESCRIPTORS,
  INTEGRATION_KEYS,
  isAutonomousProcessKey,
  isMessageEvent,
  isPlausibleGeminiApiKey,
  matchRunAllowedToolPattern,
  type AgentResult,
  type BackendId,
  type BackendModel,
  type BackendUsage,
  type ProcessKey,
} from "@aitne/shared";
import { readIntegrations } from "../../db/integrations-store.js";
import type { AgentConfig } from "../../config.js";
import { getContextDir } from "../../config.js";
import { cleanupSessionWorkdir, createSessionWorkdir } from "../workdir.js";
import { resolveUserSkillsRoot } from "../user-skills-root.js";
import type {
  AgentExecuteParams,
  AgentResumeParams,
  AuthCheckResult,
  DelegatedTaskInvokeParams,
  DelegatedTaskResultRaw,
  DelegatedTaskToolStepRaw,
  DelegatedToolInvokeParams,
  DelegatedToolResult,
  IAgentCore,
  McpSessionContext,
  ReadSensitiveTokenManager,
  StagedAttachment,
  StreamCallbacks,
} from "../agent-core.js";
import {
  BackendDecisiveFailure,
  BackendQuotaError,
  DelegatedProxyTimeoutError,
  classifyAbortReason,
} from "../agent-core.js";
import { IdleWatchdog } from "./idle-watchdog.js";
import {
  buildDelegatedToolPrompt,
  emptyCost,
  tryParseToolResult,
  withDurationMs,
} from "../../services/delegated-tool-runtime.js";
import { DELEGATED_PROXY_DEFAULTS } from "../../services/delegated-proxy-config.js";
import { materializeMcpForSession } from "../../services/mcp/session-materializer.js";
import { parseMcpToolName } from "../../services/mcp/risk.js";
import {
  noteNativeSkillToolIfPresent,
  probeCliNativeSkillSubcommand,
} from "./native-skill-discovery-probe.js";
import { logMcpToolCall } from "../../services/mcp/tool-audit.js";
import { buildDaemonApiCliEnv } from "../daemon-api-cli.js";
import type { AgentWriteTracker } from "../../safety/agent-write-tracker.js";
import { ALWAYS_DISALLOWED_TOOLS } from "../../safety/always-disallowed.js";
import {
  CliPathCache,
  parseJsonLine,
  runLineCommand,
} from "./cli-utils.js";
import {
  isPathInsideOrEqual,
  jsonStringPathForms,
  shellPathForms,
} from "../path-compat.js";
import { probeApiKeyServerSide } from "./api-key-probe.js";
import {
  assertCostWithinMaxBudget,
  assertPromptCostWithinMaxBudget,
  classifyCliFailure,
} from "./cli-quota-guards.js";
import { buildAgentDayBoundaryHint } from "./quota-reset-hints.js";
import {
  auditStreamObservation,
  extractGeminiToolUseTarget,
} from "../../safety/subprocess-block-scanner.js";
import {
  extractSilentApiErrors,
  logSilentApiErrors,
} from "./silent-api-error-detector.js";
import {
  findRegisteredModel,
  getModelsForBackend,
  latestLiteFor,
} from "./model-registry.js";
import { PriceFetcher } from "./price-fetcher.js";
import { buildExecutionPrompt, buildSummaryPrompt } from "./prompt-utils.js";
import { createLogger } from "../../logging.js";
import { readRuntimeState, writeRuntimeState } from "../../db/runtime-state.js";
const logger = createLogger("gemini-cli-core");

/**
 * runtime_state key for the Gemini per-agent-day request counter.
 * Gemini meters per-day model requests, and `maxTurns` alone cannot
 * bound daily consumption — so this counter applies a conservative
 * fixed ceiling that matches the free Gemini API tier (500 requests/
 * day × 0.9 = 450 requests/day). Operators on higher-quota Gemini
 * accounts can widen via the dashboard config.
 */
const GEMINI_REQUESTS_STATE_KEY = "gemini_requests_today";
/**
 * Conservative default. Replaces the legacy plan-driven ceilings — the
 * daemon does not ask the operator which Gemini account tier they
 * hold (Aitne is intended to run on `GEMINI_API_KEY` / `GOOGLE_API_KEY`,
 * with the CLI's local auth as a fallback), so we cannot infer a
 * tier-specific quota and assume the free-tier published cap. When an
 * API key is configured, the upstream Google quota is the real bound
 * and this counter just stops the daemon from blowing past 450/day in
 * the worst case.
 */
const GEMINI_DAILY_REQUEST_CEILING = 450;

interface GeminiRequestsState {
  /** Agent-day label — e.g. `2026-04-11`. Rolls over at `dayBoundaryHour`. */
  date: string;
  count: number;
}

/** Policy file name written into each session workdir. */
const ADMIN_POLICY_FILENAME = ".pa-admin-policy.toml";

const EMPTY_USAGE: BackendUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
};

/**
 * Per-event stream-idle threshold for reactive `runTurn` execution
 * (DMs, routines, scheduled tasks). Distinct from the delegated-path
 * `DELEGATED_PROXY_DEFAULTS.idleTimeoutMsByBackend.gemini` (75s)
 * because reactive turns include longer legitimate silences — extended
 * thinking, MCP cold-starts, long `google-workspace` round-trips. The
 * threshold catches a fully hung CLI subprocess (zero stream events)
 * well before `executeTimeoutMinutes` (default 30 min) fires.
 *
 * The reactive path needs this guard explicitly: without it, a hung
 * subprocess could pin a session for the full executeTimeoutMinutes
 * wall-clock.
 */
const REACTIVE_IDLE_TIMEOUT_MS = 5 * 60 * 1000;

interface GeminiStreamEvent {
  type?: string;
  session_id?: string;
  role?: string;
  content?: string;
  delta?: boolean;
  status?: string;
  stats?: GeminiStats;
  result?: {
    status?: string;
    stats?: GeminiStats;
    error?: string;
  };
  error?: string;
  messageType?: string;
  /** Present on tool_use and tool_result events. */
  tool_name?: string;
  /** Present on tool_use events. */
  args?: Record<string, unknown>;
  /** Present on tool_use and tool_result — used to pair the two. */
  tool_id?: string;
  /** Present on tool_result events — string-encoded tool output. */
  output?: string;
}

interface GeminiStats {
  total_tokens?: number;
  input_tokens?: number;
  output_tokens?: number;
  cached?: number;
  duration_ms?: number;
  models?: Record<
    string,
    {
      total_tokens?: number;
      input_tokens?: number;
      output_tokens?: number;
      cached?: number;
      input?: number;
    }
  >;
}

export class GeminiCliCore implements IAgentCore {
  readonly backendId = "gemini" as const;
  // Lazily re-resolved with a 60 s TTL — see ClaudeCodeCore for rationale (§9.4).
  private readonly cliPathCache: CliPathCache;
  /** Legacy shared read token injected into the Gemini subprocess env. */
  private readToken: string | undefined;
  /** Scoped token manager preferred over the legacy shared read token. */
  private readTokenManager: ReadSensitiveTokenManager | undefined;

  private get cliPath(): string | null {
    return this.cliPathCache.get();
  }

  constructor(
    private readonly config: AgentConfig,
    /**
     * Shared AgentWriteTracker. When present, vault-scoped writes detected in
     * Gemini's tool_use stream are pre-marked so the ObsidianWatcher attributes
     * the chokidar event to `actor='agent'` instead of `'user'`.
     */
    private readonly writeTracker?: AgentWriteTracker,
    private readonly priceFetcher = new PriceFetcher(config.dataDir),
    /**
     * DB handle for the per-agent-day Gemini request counter. Optional so
     * unit tests that construct the core without a database get
     * graceful degradation: no quota enforcement and no counter writes.
     * Production always supplies this.
     */
    private readonly db: Database.Database | null = null,
  ) {
    this.cliPathCache = new CliPathCache("gemini");
  }

  /** Set the per-daemon-boot read token for subprocess-local daemon API auth. */
  setReadToken(token: string): void {
    this.readToken = token;
  }

  setReadTokenManager(manager: ReadSensitiveTokenManager): void {
    this.readTokenManager = manager;
  }

  private mcpContext: McpSessionContext | undefined;
  setMcpContext(context: McpSessionContext): void {
    this.mcpContext = context;
  }

  private async materializeMcp(
    sessionDir: string,
    processKey: ProcessKey | undefined,
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
    // Allow mode bypasses the approve-tier MCP strip (see claude-code-core
    // for the rationale — "strong permission mode" enables every MCP tool,
    // autonomous routines included).
    const allowMode = this.config.geminiExecutionPermissionMode === "allow";
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

  async execute(
    params: AgentExecuteParams,
    streamCallbacks?: StreamCallbacks,
  ): Promise<AgentResult> {
    const wikiWorkspaceName =
      typeof params.event.data?.workspace === "string"
        ? params.event.data.workspace
        : undefined;
    return await this.runTurn(
      {
        prompt: appendGeminiAttachmentTokens(
          buildExecutionPrompt(
            params.prompt,
            params.context,
            params.event,
            params.conversationHistory,
          ),
          params.stagedAttachments,
        ),
        modelId: params.modelId,
        eventType: params.event.type,
        processKey: params.processKey,
        ...(wikiWorkspaceName ? { wikiWorkspaceName } : {}),
        sessionDir: params.sessionDir,
        maxTurns: params.maxTurns,
        maxBudgetUsd: params.maxBudgetUsd,
        webSearchEnabled: params.webSearchEnabled,
        turnToken: params.turnToken,
        sessionDbId: params.sessionDbId,
        eventCorrelationId: params.event.correlationId,
        wikiUrlFetchEnabled: params.wikiUrlFetchEnabled ?? false,
        ...(isMessageEvent(params.event) ? { messageText: params.event.content } : {}),
        ...(params.extraSkills && params.extraSkills.length > 0
          ? { extraSkills: params.extraSkills }
          : {}),
        ...(params.skillsReplace ? { skillsReplace: true } : {}),
      },
      streamCallbacks,
    );
  }

  async executeResume(
    params: AgentResumeParams,
    streamCallbacks?: StreamCallbacks,
  ): Promise<AgentResult> {
    return await this.runTurn(
      {
        prompt: appendGeminiAttachmentTokens(params.message, params.stagedAttachments),
        modelId: params.modelId,
        eventType: "message.received",
        sessionDir: params.sessionDir,
        resumeSessionId: params.sessionId,
        maxTurns: params.maxTurns,
        maxBudgetUsd: params.maxBudgetUsd,
        webSearchEnabled: params.webSearchEnabled,
        turnToken: params.turnToken,
        sessionDbId: params.sessionDbId,
        eventCorrelationId: params.eventCorrelationId,
        // Forward the user's reply text as the trigger-phrase signal —
        // mirrors codex / opencode resume paths.
        messageText: params.message,
      },
      streamCallbacks,
    );
  }

  async summarize(conversationText: string): Promise<string> {
    const result = await this.runTurn({
      prompt: buildSummaryPrompt(conversationText),
      modelId: this.pickSummaryModel(),
      eventType: "message.received",
    });
    return result.output;
  }

  async checkAuth(): Promise<
    | { ok: true; method: "cli_login" | "api_key" | "oauth" | "vertex" }
    | { ok: false; reason: string }
  > {
    if (!this.cliPath) {
      return { ok: false, reason: "Gemini CLI is not installed or not on PATH." };
    }
    const rawApiKey =
      process.env.GEMINI_API_KEY?.trim() || process.env.GOOGLE_API_KEY?.trim();
    if (rawApiKey) {
      if (!isPlausibleGeminiApiKey(rawApiKey)) {
        return {
          ok: false,
          reason: "GEMINI_API_KEY / GOOGLE_API_KEY is set but does not look like a Google API key (expected `AIza…`, 39 chars).",
        };
      }
      return { ok: true, method: "api_key" };
    }
    if (
      process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim()
      && process.env.GOOGLE_CLOUD_PROJECT?.trim()
    ) {
      return { ok: true, method: "vertex" };
    }
    if (
      existsSync(join(homedir(), ".gemini", "oauth_creds.json"))
      || existsSync(join(homedir(), ".gemini", "google_accounts.json"))
    ) {
      return { ok: true, method: "oauth" };
    }
    return {
      ok: false,
      reason: "Gemini is not authenticated. Configure OAuth, Vertex, or GEMINI_API_KEY.",
    };
  }

  /**
   * Detailed auth probe. Three modes:
   *  - **API key** (`GEMINI_API_KEY` / `GOOGLE_API_KEY`): format check +
   *    server-side probe via `probeApiKeyServerSide("google", ...)`
   *    (roadmap §9.1). Throws on network/timeout.
   *  - **Vertex** (`GOOGLE_APPLICATION_CREDENTIALS` + `GOOGLE_CLOUD_PROJECT`):
   *    env-var presence check only.
   *  - **OAuth** (`~/.gemini/oauth_creds.json`): presence check on
   *    `refresh_token` field + grace window. Does NOT validate the
   *    refresh_token server-side; real failures surface via the reactive
   *    path during `execute()`.
   */
  async checkAuthDetailed(): Promise<AuthCheckResult> {
    if (!this.cliPath) {
      return {
        ok: false,
        status: "missing",
        method: "cli_login",
        detail: "Gemini CLI not found on PATH",
        recoveryCommand: "npm install -g @google/gemini-cli",
      };
    }
    const rawApiKey =
      process.env.GEMINI_API_KEY?.trim() || process.env.GOOGLE_API_KEY?.trim();
    if (rawApiKey) {
      if (!isPlausibleGeminiApiKey(rawApiKey)) {
        return {
          ok: false,
          status: "expired",
          method: "api_key",
          detail: "GEMINI_API_KEY / GOOGLE_API_KEY does not match Google API key format (`AIza…`, 39 chars).",
          recoveryCommand: "Unset the env var or replace it with a valid Google API key",
        };
      }
      // Format is plausible — attempt a server-side probe to detect
      // revoked keys within 1 hourly cycle (roadmap §9.1).
      const probe = await probeApiKeyServerSide("google", rawApiKey);
      return {
        ok: probe.ok,
        status: probe.ok ? "ok" : "expired",
        method: "api_key",
        detail: probe.detail,
        ...(!probe.ok && {
          recoveryCommand: "Unset the env var or replace it with a valid Google API key",
        }),
      };
    }
    if (
      process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim()
      && process.env.GOOGLE_CLOUD_PROJECT?.trim()
    ) {
      return { ok: true, status: "ok", method: "vertex" };
    }

    const oauthPath = join(homedir(), ".gemini", "oauth_creds.json");
    if (existsSync(oauthPath)) {
      try {
        const raw = readFileSync(oauthPath, "utf-8");
        const creds = JSON.parse(raw) as { refresh_token?: unknown };
        if (typeof creds.refresh_token === "string" && creds.refresh_token.length > 0) {
          return { ok: true, status: "ok", method: "oauth" };
        }
        // refresh_token missing — treat recently-modified files as ok
        // because the Gemini CLI has a known upstream bug where the field
        // drops out mid-session (observed in 0.x CLI versions). Without
        // this grace, every Gemini user would false-trip to "expired"
        // until they re-authenticated. The grace window is tunable via
        // `PA_GEMINI_OAUTH_GRACE_HOURS`; set to 0 to disable the grace
        // entirely once the upstream bug is fixed.
        const graceHours = parseGraceHours(
          process.env.PA_GEMINI_OAUTH_GRACE_HOURS,
          24,
        );
        const hoursSinceModified =
          (Date.now() - statSync(oauthPath).mtimeMs) / 3_600_000;
        if (graceHours > 0 && hoursSinceModified < graceHours) {
          logger.warn(
            { graceHours, hoursSinceModified },
            "Gemini oauth_creds.json missing refresh_token — applying grace window",
          );
          return {
            ok: true,
            status: "ok",
            method: "oauth",
            detail: `refresh_token missing but file was updated ${hoursSinceModified.toFixed(1)}h ago (< ${graceHours}h grace)`,
          };
        }
        return {
          ok: false,
          status: "expired",
          method: "oauth",
          detail: "refresh_token missing from oauth_creds.json",
          recoveryCommand: "gemini → Sign in with Google",
        };
      } catch (err) {
        logger.warn({ err }, "Failed to read Gemini oauth_creds.json");
        return {
          ok: false,
          status: "expired",
          method: "oauth",
          detail: err instanceof Error ? err.message : "Failed to parse oauth_creds.json",
          recoveryCommand: "gemini → Sign in with Google",
        };
      }
    }

    if (existsSync(join(homedir(), ".gemini", "gemini-credentials.json"))) {
      return {
        ok: true,
        status: "ok",
        method: "oauth",
        detail: "Encrypted storage detected — CLI handles validation",
      };
    }
    if (existsSync(join(homedir(), ".gemini", "google_accounts.json"))) {
      return { ok: true, status: "ok", method: "oauth" };
    }

    return {
      ok: false,
      status: "expired",
      method: "oauth",
      detail: "No Gemini OAuth credentials found",
      recoveryCommand: "gemini → Sign in with Google",
    };
  }

  listModels(): ReadonlyArray<BackendModel> {
    return getModelsForBackend(this.backendId);
  }

  /**
   * Phase 5 §4.11 live probe for Gemini. Gemini CLI exposes no first-party
   * tool-enumeration API and its MCP namespace (`mcp_<server>_<tool>`,
   * single-underscore — confirmed via stream-event probe 2026-04-26)
   * differs from Claude / Codex (`mcp__<server>__<tool>`).
   *
   * Strategy: scan the host for registered MCP servers (the
   * `gemini-extension.json` `mcpServers` block under each subdir of
   * `~/.gemini/extensions/` plus the `~/.gemini/settings.json`
   * `mcpServers` block), then for every registry-declared Gemini
   * connector whose namespace points at a detected server, synthesize
   * the expected fully-qualified tool names from `capabilityTools`. The
   * synthetic list is what `evaluateProbe` matches against the
   * descriptor.
   *
   * Trade-off: this is a "presence-only" probe — it verifies the server
   * is registered with Gemini, not that the agent's OAuth / tool-call
   * actually works. Connector auth failures surface when the agent first
   * invokes the tool. Codex / Claude run live `tool_search` queries
   * because their MCP catalog is queryable from the SDK; Gemini does not
   * expose that surface, and asking the model to enumerate via prompt
   * proved unreliable (whitespace-only responses, see chat history).
   *
   * Two distinct outcomes:
   *  - Server NOT detected → returns `[]`. `evaluateProbe` matches
   *    against the connector's expected tools, finds none, reports all
   *    required capabilities missing — dashboard correctly shows
   *    "Gemini's <X> connector is not installed."
   *  - Server detected → returns the registry's claimed tool list for
   *    that server. `evaluateProbe` matches every entry exactly (since
   *    the list IS the registry's expectation), so all caps mark
   *    present. The dashboard shows "all features available." This is
   *    accurate for `google-workspace` (whose tool names were verified
   *    from `~/.gemini/extensions/google-workspace/dist/index.js` —
   *    `registerTool("gmail.*", ...)` etc. — at registry-write time)
   *    and is a guess for `notion` (registry assumes `notion-search`,
   *    `notion-fetch`, etc.; actual hosted-MCP names may diverge —
   *    surfaced via the install card's namespace caveat). Runtime
   *    `wrong_tool` errors are the failure mode for the latter.
   */
  async probeTools(): Promise<string[]> {
    const detectedServers = new Set<string>();

    // Extension-installed MCP servers (e.g. google-workspace ships
    // gmail.* and calendar.* via this path).
    const extDir = join(homedir(), ".gemini", "extensions");
    if (existsSync(extDir)) {
      try {
        const subdirs = readdirSync(extDir, { withFileTypes: true });
        for (const ent of subdirs) {
          if (!ent.isDirectory()) continue;
          const manifestPath = join(extDir, ent.name, "gemini-extension.json");
          if (!existsSync(manifestPath)) continue;
          collectMcpServerNames(manifestPath, detectedServers);
        }
      } catch (err) {
        logger.warn({ err, extDir }, "failed to scan Gemini extensions");
      }
    }

    // User-added MCP servers (`gemini mcp add <name> ...`). Notion's
    // hosted MCP server is typically registered here under the literal
    // name `notion` — that's the assumption the registry's Notion
    // descriptor encodes.
    const settingsPath = join(homedir(), ".gemini", "settings.json");
    if (existsSync(settingsPath)) {
      collectMcpServerNames(settingsPath, detectedServers);
    }

    const tools: string[] = [];
    for (const integrationKey of INTEGRATION_KEYS) {
      const connector =
        INTEGRATION_DESCRIPTORS[integrationKey].backendConnectors.gemini;
      if (!connector) continue;
      const serverName = extractGeminiServerName(connector.toolNamespace);
      if (!serverName || !detectedServers.has(serverName)) continue;
      for (const toolList of Object.values(connector.capabilityTools)) {
        for (const t of toolList) {
          tools.push(connector.toolNamespace + t);
        }
      }
    }
    const deduped = Array.from(new Set(tools));
    logger.info(
      {
        detectedServers: [...detectedServers],
        toolCount: deduped.length,
      },
      "Gemini probe collected tool manifest via host MCP scan",
    );
    // docs/design/appendices/skills-unification.md Phase 1 item 13 — forward-compat
    // signals. The name-pattern scan over `deduped` here is structurally
    // a no-op for native discovery (the list is built from
    // `INTEGRATION_DESCRIPTORS.capabilityTools`, which Aitne controls,
    // and therefore can never contain a native CLI skill tool we did
    // not register). The `gemini --help` subcommand probe below is the
    // real detector: `gemini --help` already lists `gemini skills`
    // natively, so this is the call site that will trip on first deploy
    // and need cleanup.
    noteNativeSkillToolIfPresent("gemini", deduped);
    void probeCliNativeSkillSubcommand(this.cliPath, "gemini");
    return deduped;
  }

  private async runTurn(
    params: {
      prompt: string;
      modelId: string;
      eventType: string;
      processKey?: AgentExecuteParams["processKey"];
      /** WIKI_BUILDER_DESIGN.md §P5.C — per-event wiki workspace name for
       *  token substitution in skill bodies / wiki-agent profile when the
       *  disposable-temp-dir branch fires. Resume turns pass undefined. */
      wikiWorkspaceName?: string;
      sessionDir?: string;
      resumeSessionId?: string;
      /**
       * Daemon-side turn cap. The Gemini CLI has no `--max-turns` flag
       * (verified via `gemini --help` on 0.x), so unlike Claude — where the
       * SDK enforces this natively — we count `tool_use` events in the
       * stream and abort the subprocess via AbortController when the cap is
       * exceeded. Surfaces as `BackendDecisiveFailure("max_turns")`,
       * matching the contract Claude raises. Without this guard a runaway
       * Gemini turn would burn the full `executeTimeoutMinutes` wall-clock
       * (default 60 min) before the wall-clock watchdog fires — the
       * "Customize Your Rules" force-stop / very-slow report. Default
       * mirrors Codex's implicit ceiling (50) when the caller omits it.
       */
      maxTurns?: number;
      maxBudgetUsd?: number;
      webSearchEnabled?: boolean;
      turnToken?: string;
      sessionDbId?: number;
      /** See AgentResumeParams.eventCorrelationId — forwarded to the shim env. */
      eventCorrelationId?: string;
      /**
       * WIKI_BUILDER_DESIGN.md §4.3 — narrow per-turn override that threads
       * into `generateAdminPolicy` so the strict policy emits
       * `web_fetch` decision = "allow" (priority 500) for this single
       * turn. Context-dir chokepoint, sensitive-path reads, pipe-chain
       * deny, absolute-block layer, and the `--sandbox` container stay
       * intact. Does NOT flip the turn into allow-mode minimal policy.
       */
      wikiUrlFetchEnabled?: boolean;
      /**
       * docs/design/appendices/skills-unification.md Phase 4 — inbound message text
       * forwarded to `createSessionWorkdir` so the conditional
       * `gmail-lifestyle` / `managed-tasks` *ForDm predicates can run
       * when the dispatcher hasn't pre-created the workdir (lite-tier
       * non-DM message paths).
       */
      messageText?: string | null;
      /** AGENT_DEFINITIONS_DESIGN.md §4.2 — the firing Agent's `tools.skills`,
       *  forwarded to `createSessionWorkdir`. Undefined for non-Agent turns. */
      extraSkills?: readonly string[];
      /** AGENT_DEFINITIONS_DESIGN.md §4.2 — `tools.skills_replace`. */
      skillsReplace?: boolean;
    },
    streamCallbacks?: StreamCallbacks,
  ): Promise<AgentResult> {
    // Pre-flight auth gate — intentionally absent in ClaudeCodeCore.
    // Same reasoning as Codex: spawning the Gemini CLI subprocess has
    // non-trivial TTFB, so reading `oauth_creds.json` (or the API key
    // format) once here is cheaper than discovering the failure after
    // the subprocess has already booted and begun streaming. Claude
    // leans on the Agent SDK's own 401 instead, which is why it has
    // no equivalent pre-flight. See the class-level comment on
    // `ClaudeCodeCore` for the full rationale.
    const auth = await this.checkAuth();
    if (!auth.ok) {
      logger.warn({ reason: auth.reason }, "Gemini auth check failed");
      throw new BackendDecisiveFailure(
        this.backendId,
        "auth",
        new Error(auth.reason),
      );
    }

    // Daily-request quota gate. Reads `backend_global_defaults.gemini_plan`
    // → `PlanPreset.dailyRequestCeiling` and compares against the per-agent-day
    // counter in runtime_state. Pre-flight refusal so we don't waste a CLI
    // subprocess on a request we know is over quota. See
    // `docs/design/09-safety-cost.md` §9.4.8 for the full contract.
    const today = getAgentDayDateStr(
      this.config.timezone,
      this.config.dayBoundaryHour,
    );
    const ceiling = this.resolveDailyRequestCeiling();
    if (ceiling !== null) {
      const currentCount = this.readRequestsCount(today);
      if (currentCount >= ceiling) {
        logger.warn(
          { currentCount, ceiling, date: today },
          "Gemini daily-request ceiling hit — refusing execution",
        );
        throw new BackendQuotaError(
          this.backendId,
          "daily_ceiling",
          // Deterministic reset: the next agent-day boundary fires at
          // `dayBoundaryHour:00` in the configured timezone. The helper
          // handles the empty-timezone default (`AgentConfig.timezone`
          // defaults to `""` in config.ts) by omitting the field so the
          // dashboard renders cleanly.
          buildAgentDayBoundaryHint(
            this.config.dayBoundaryHour,
            this.config.timezone,
          ),
          `Gemini daily-request ceiling reached (${currentCount}/${ceiling}) — resets at the next agent-day boundary.`,
        );
      }
    }
    this.assertPromptWithinMaxBudget(params.prompt, params.maxBudgetUsd, params.modelId);

    const startMs = Date.now();
    const sessionDir = params.sessionDir ?? createSessionWorkdir(
      this.config.workspaceDir,
      params.eventType,
      resolveUserSkillsRoot(this.config),
      {
        backendId: this.backendId,
        processKey: params.processKey,
        character: this.config.character,
        contextDir: getContextDir(this.config),
        // docs/design/appendices/skills-unification.md Phase 4 — feed conditional manifest
        // predicates with live DB rows and the inbound DM text. Gemini
        // already keeps a `this.db` for the daily request ceiling; reuse
        // it (falls back to `mcpContext.db` for symmetry with the other
        // cores).
        ...((this.db ?? this.mcpContext?.db) ? { db: this.db ?? this.mcpContext?.db ?? null } : {}),
        ...(typeof params.messageText === "string" ? { messageText: params.messageText } : {}),
        ...(params.wikiWorkspaceName ? { wikiWorkspaceName: params.wikiWorkspaceName } : {}),
        // AGENT_DEFINITIONS_DESIGN.md §4.2 — see ClaudeCodeCore. No-op for
        // non-Agent executes.
        ...(params.extraSkills && params.extraSkills.length > 0
          ? { extraSkills: params.extraSkills }
          : {}),
        ...(params.skillsReplace ? { skillsReplace: true } : {}),
      },
    );
    const ownsSessionDir = !params.sessionDir;
    const daemonReadToken = this.readTokenManager?.issue(sessionDir) ?? this.readToken;

    // Write admin policy to session workdir. The admin tier overrides the
    // --approval-mode yolo grants, so this policy is the ONLY mechanism on
    // Gemini for preserving non-negotiable invariants — chiefly that writes
    // to the context directory must go through the daemon API.
    //
    // Strict mode: full whitelist policy (catch-all deny + explicit allows).
    // Allow mode: minimal policy with NO catch-all — only denies context-dir
    // writes and sensitive-path reads; everything else falls through to yolo.
    //
    // WIKI_BUILDER_DESIGN.md §4.3 — `wikiUrlFetchEnabled` does NOT flip the
    // turn into allow mode (which would drop unrelated guards). Instead it
    // threads into the strict admin policy so the `web_fetch` deny rule is
    // replaced with an allow rule for this turn only. Every other policy
    // guard (context-dir chokepoint, sensitive-path reads, pipe-chain deny,
    // absolute-block layer, etc.) remains intact.
    const allowMode = this.config.geminiExecutionPermissionMode === "allow";
    const policyPath = join(sessionDir, ADMIN_POLICY_FILENAME);
    writeFileSync(
      policyPath,
      allowMode
        ? this.generateAllowModeMinimalPolicy()
        : this.generateAdminPolicy({
            webSearchEnabled: params.webSearchEnabled,
            wikiUrlFetchEnabled: params.wikiUrlFetchEnabled,
          }),
      "utf-8",
    );

    const mcp = await this.materializeMcp(sessionDir, params.processKey);

    logger.info(
      { eventType: params.eventType, model: params.modelId, promptLen: params.prompt.length, mcpServers: mcp.servers.map((s) => s.id) },
      "Gemini execute started",
    );

    let assistantDelta = "";
    let finalAssistantMessage = "";
    let sessionId: string | null = params.resumeSessionId ?? null;
    let lastError: string | null = null;
    let resultStatus = "error";
    let stats: GeminiStats | null = null;
    // Stream text deltas live as they arrive — mirrors ClaudeCodeCore /
    // CodexCore so the owner-facing chat surfaces (dashboard chat, owner DM)
    // get the same incremental-output UX regardless of which backend serves
    // the turn. `assertWithinMaxBudget` is still enforced post-completion
    // and surfaces as `BackendQuotaError` AFTER text has streamed —
    // matching Claude's behaviour. The earlier "defer until budget check"
    // guard buffered the entire turn, which made interactive flows
    // (`setup.initial`, dashboard chat) look frozen for minutes.
    let streamed = false;
    // Daemon-side max-turns enforcement. The Gemini CLI exposes no
    // `--max-turns` flag (verified `gemini --help` on 0.x) and the SDK-level
    // contract that Claude relies on for `BackendDecisiveFailure("max_turns")`
    // is unavailable. To match Claude / Codex semantics we count `tool_use`
    // events as a turn proxy (one model→tool round-trip per event; parallel
    // tool calls within the same turn marginally over-count, which only
    // tightens the cap) and use AbortController to terminate the subprocess
    // when the cap is exceeded. Without this guard, a runaway interactive
    // flow (`setup.initial` was the trigger case) would burn the full
    // `executeTimeoutMinutes` wall-clock (default 60 min) before the
    // generic timeout watchdog fired — the "Customize Your Rules
    // force-stop / very-slow" report.
    //
    // The fallback default (50) mirrors Codex's implicit ceiling so callers
    // that omit `maxTurns` get the same envelope on every CLI backend.
    const maxTurns = params.maxTurns ?? 50;
    let toolCallCount = 0;
    let maxTurnsExceeded = false;
    const maxTurnsAborter = new AbortController();
    // Accumulate raw subprocess text across the run so we can scan once for
    // `PA_API_ERROR` markers the pa-api / curl wrappers emit on HTTP errors.
    // Gemini's stream schema doesn't expose a dedicated tool-output field, so
    // we fall back to the raw stdout/stderr lines (which include both the
    // JSONL itself and any uncaptured subprocess stderr).
    const apiOutputBuffer: string[] = [];

    // Reactive idle watchdog (audit 2026-05-17 C1). Mirrors the delegated
    // path's wiring in `runDelegatedTool` (~line 2240). Distinct aborter
    // from `maxTurnsAborter` so `AbortSignal.any` carries both reasons
    // to runLineCommand; post-await we classify via the flag pair
    // (`maxTurnsExceeded` → `idleTimedOut` → `runResult.timedOut`).
    let idleTimedOut = false;
    const idleAborter = new AbortController();
    const idleWatchdog = new IdleWatchdog({
      idleTimeoutMs: REACTIVE_IDLE_TIMEOUT_MS,
      onTimeout: (idleMs) => {
        idleTimedOut = true;
        logger.warn(
          { idleMs, idleTimeoutMs: REACTIVE_IDLE_TIMEOUT_MS, eventType: params.eventType },
          "gemini reactive idle watchdog tripped — aborting",
        );
        idleAborter.abort(
          new Error(
            `gemini reactive stream idle for ${idleMs}ms (limit ${REACTIVE_IDLE_TIMEOUT_MS}ms)`,
          ),
        );
      },
    });

    try {
      idleWatchdog.start();
      // Spawn the resolved CLI path, not the bare name. `this.cliPath` is the
      // PATHEXT-resolved binary (e.g. `gemini.cmd` on Windows, where the npm
      // shim has no extensionless entry); a literal `"gemini"` ENOENTs there.
      // Mirrors the delegated/probe paths (~2330, ~2781). The getter is typed
      // `string | null`, so narrow before assigning to the `string` field —
      // `checkAuth()` already returns ok:false when null but doesn't narrow.
      if (!this.cliPath) {
        throw new BackendDecisiveFailure(
          this.backendId,
          "auth",
          new Error("gemini CLI not found on PATH"),
        );
      }
      const runResult = await runLineCommand({
        command: this.cliPath,
        args: this.buildArgs(params, policyPath),
        cwd: sessionDir,
        env: {
          ...buildDaemonApiCliEnv(sessionDir, this.config.apiPort, {
            readToken: daemonReadToken,
            sessionBackend: "gemini",
            sessionId: params.sessionDbId,
            eventCorrelationId: params.eventCorrelationId,
          }),
          ...mcp.env,
          ...(params.turnToken ? { PA_TURN_TOKEN: params.turnToken } : {}),
        },
        timeoutMs: this.config.executeTimeoutMinutes * 60 * 1000,
        abortSignal: AbortSignal.any([
          maxTurnsAborter.signal,
          idleAborter.signal,
        ]),
        onStdoutLine: (line) => {
          idleWatchdog.beat();
          apiOutputBuffer.push(line);
          const event = parseJsonLine<GeminiStreamEvent>(line);
          if (!event?.type) {
            if (isLikelyGeminiFailure(line)) {
              lastError = line.trim();
            }
            return;
          }

          if (event.type === "init" && typeof event.session_id === "string") {
            sessionId = event.session_id;
            return;
          }

          // Pre-mark vault writes for observer attribution (same as Claude Code hook).
          if (this.writeTracker && event.type === "tool_use") {
            this.trackVaultWrite(event);
          }

          // EXECUTION-MODE-DESIGN.md §6.3 — stream-side absolute-block
          // observability. The admin TOML at priority 999 already enforces
          // the same patterns at the Gemini CLI layer; this adds an
          // `agent_actions.blocked_absolute` row with `result='partial'`
          // so the dashboard sees stream-observed attempts the same way it
          // sees Claude's PreToolUse rejections (recorded with
          // `result='failed'`).
          if (event.type === "tool_use") {
            const target = extractGeminiToolUseTarget(
              event.tool_name,
              event.args,
            );
            if (target) {
              auditStreamObservation(target, {
                db: this.mcpContext?.db,
                backend: this.backendId,
                mode: this.config.geminiExecutionPermissionMode,
                sessionId: params.sessionDbId,
              });
            }
          }

          // Persist MCP tool call to `mcp_tool_calls`.
          // Gemini emits `mcp_<server>_<tool>` (single underscore — see
          // parseMcpToolName); host-installed Gemini MCPs (like
          // `google-workspace` from extensions, or user-added `notion`)
          // produce `serverId` values that DON'T appear in the daemon's
          // `mcp_servers` table. The schema has no FK so writes succeed,
          // but the dashboard's per-server activity panel (keyed by a
          // matching server-card) won't surface them. The rows persist
          // for any future "all MCP activity" view; for now they're a
          // forensic-only audit trail.
          if (event.type === "tool_use" && typeof event.tool_name === "string") {
            const parsed = parseMcpToolName(event.tool_name);
            if (parsed) {
              logger.debug(
                {
                  serverId: parsed.serverId,
                  toolName: parsed.toolName,
                  sessionId,
                  eventType: params.eventType,
                },
                "mcp.tool_call",
              );
              if (this.mcpContext?.db) {
                try {
                  logMcpToolCall(this.mcpContext.db, {
                    serverId: parsed.serverId,
                    toolName: parsed.toolName,
                    eventType: params.eventType,
                    sessionId: sessionId ?? undefined,
                  });
                } catch (err) {
                  logger.warn({ err, serverId: parsed.serverId }, "mcp.tool_call audit insert failed");
                }
              }
            }
          }

          // Max-turns counting + enforcement.
          //
          // ── Semantic ──
          // `maxTurns` here is the **maximum number of tool calls** the
          // model may make in a single execute. The cap is exclusive: we
          // abort when the next `tool_use` would push the count *past*
          // `maxTurns` (`toolCallCount > maxTurns`), not on the
          // `maxTurns`-th call itself. That semantic is what the rest of
          // this test suite asserts — multiple absolute-block / audit
          // tests pass `maxTurns: 1` together with a single `tool_use`
          // event and expect the run to complete cleanly so the
          // observability row gets persisted before the cap could fire.
          //
          // This is intentionally one turn more permissive than the
          // strict Claude-SDK contract (where `maxTurns` is the
          // model-invocation count). The trade-off is justified by:
          //   1. The Gemini CLI emits no explicit turn-boundary event,
          //      so the daemon can only count tool calls, not full
          //      invocations. The final assistant message (which does
          //      count as a model invocation in Claude) is invisible to
          //      this counter until after-the-fact.
          //   2. The cap exists primarily to stop runaway loops, not to
          //      shave one model call off the budget. Allowing one
          //      "settling" final answer keeps the contract aligned
          //      with `numTurns: toolCallCount + 1` and avoids
          //      mass-breaking the existing audit-observation tests.
          //
          // The increment is gated on `!maxTurnsExceeded` so post-abort
          // stdout lines (the kill chain is asynchronous; a few lines
          // can still arrive before `SIGTERM` reaps the subprocess) do
          // not drift the error-message tally past the precise abort
          // point. Audit / policy hooks above this block still fire for
          // those lines — they are forensic data, not budget accounting.
          if (event.type === "tool_use" && !maxTurnsExceeded) {
            toolCallCount += 1;
            if (toolCallCount > maxTurns) {
              maxTurnsExceeded = true;
              logger.warn(
                {
                  toolCallCount,
                  maxTurns,
                  eventType: params.eventType,
                  model: params.modelId,
                },
                "Gemini max-turns exceeded — aborting subprocess",
              );
              maxTurnsAborter.abort(new Error("max_turns_exceeded"));
              return;
            }
          }

          if (event.type === "message" && event.role === "assistant") {
            // Gemini CLI 0.x ships an emerging "thought" channel that
            // surfaces inside an assistant-role message via
            // `messageType: "thought"`. Drop these so internal reasoning
            // never reaches the dashboard chat bubble. `type: "thought"`
            // events already fall through the positive-match below and
            // never reach `onText`.
            if (event.messageType === "thought") {
              return;
            }
            const content = typeof event.content === "string" ? event.content : "";
            if (!content) {
              return;
            }
            if (event.delta) {
              assistantDelta += content;
              streamCallbacks?.onText?.(content);
              streamed = true;
              return;
            }
            finalAssistantMessage = content;
            return;
          }

          if (event.type === "result") {
            const payload = event.result ?? event;
            resultStatus = payload.status ?? resultStatus;
            stats = payload.stats ?? stats;
            lastError = payload.error ?? lastError;
          }
        },
        onStderrLine: (line) => {
          idleWatchdog.beat();
          apiOutputBuffer.push(line);
          if (isLikelyGeminiFailure(line)) {
            lastError = line.trim();
          }
        },
      });

      const apiErrors = extractSilentApiErrors(apiOutputBuffer.join("\n"));
      if (apiErrors.length > 0) {
        logSilentApiErrors(logger, apiErrors, {
          backendId: this.backendId,
          sessionId,
          eventType: params.eventType,
        });
      }

      // Max-turns abort is checked BEFORE `timedOut` because the AbortController
      // and the runLineCommand wall-clock can race: a subprocess that we
      // aborted because the cap was hit may still surface `timedOut=true`
      // if the kill path took long enough that the safety-net timer
      // tripped. Checking maxTurns first preserves the more specific
      // error class — `BackendDecisiveFailure("max_turns")` matches the
      // Claude SDK contract, while a generic `"timeout"` would obscure
      // the real cause and route the dispatcher's retry logic differently.
      //
      // The idle-watchdog flag is checked between max-turns and the
      // wall-clock so a stuck subprocess surfaces as a distinct timeout
      // message — the dispatcher's retry semantics are the same as for
      // the wall-clock case, but the audit trail and operator alert
      // call out the idle hang specifically.
      if (maxTurnsExceeded) {
        const err = new BackendDecisiveFailure(
          this.backendId,
          "max_turns",
          new Error(
            `Gemini execution exceeded max-turns cap of ${maxTurns} (observed ${toolCallCount} tool calls).`,
          ),
        );
        logger.error(
          {
            err,
            eventType: params.eventType,
            model: params.modelId,
            toolCallCount,
            maxTurns,
            durationMs: Date.now() - startMs,
          },
          "Gemini execute hit max_turns",
        );
        throw err;
      }

      if (idleTimedOut) {
        const err = new BackendDecisiveFailure(
          this.backendId,
          "timeout",
          new Error(
            `Gemini reactive stream went idle for ${REACTIVE_IDLE_TIMEOUT_MS}ms (no events from CLI subprocess)`,
          ),
        );
        logger.error(
          { err, eventType: params.eventType, model: params.modelId, durationMs: Date.now() - startMs },
          "Gemini execute idle-timed-out",
        );
        throw err;
      }

      if (runResult.timedOut) {
        const err = new BackendDecisiveFailure(
          this.backendId,
          "timeout",
          new Error(`Gemini execution exceeded timeout of ${this.config.executeTimeoutMinutes} minutes`),
        );
        logger.error(
          { err, eventType: params.eventType, model: params.modelId, durationMs: Date.now() - startMs },
          "Gemini execute timed out",
        );
        throw err;
      }

      const outputSource =
        finalAssistantMessage.trim().length > 0
          ? finalAssistantMessage
          : assistantDelta;
      const output = outputSource.trim();

      if (resultStatus !== "success" || runResult.exitCode !== 0) {
        const failureText =
          lastError
          ?? firstFailureLine(runResult.stdoutLines)
          ?? firstFailureLine(runResult.stderrLines)
          ?? "Gemini execution did not complete successfully.";
        const classified = this.classifyFailure(failureText);
        logger.error(
          { err: classified, eventType: params.eventType, model: params.modelId, exitCode: runResult.exitCode, durationMs: Date.now() - startMs },
          "Gemini execute failed",
        );
        throw classified;
      }

      const normalizedUsage = normalizeGeminiUsage(stats);
      const { modelUsage, costSource } = buildGeminiModelUsage(this.priceFetcher, stats);
      const actualModelId = resolveActualGeminiModel(params.modelId, modelUsage);
      const durationApiMs =
        (stats as GeminiStats | null)?.duration_ms ?? Date.now() - startMs;
      const estimatedCost = this.priceFetcher.estimateUsageCost({
        backendId: this.backendId,
        modelId: actualModelId,
        usage: normalizedUsage,
        fallbackModel: findRegisteredModel(this.backendId, actualModelId),
      });
      const costUsd = Object.values(modelUsage)
        .reduce((total, usage) => total + usage.costUsd, 0)
        || estimatedCost.costUsd;
      // Hand the post-hoc budget assertion the exact spend it would
      // otherwise be unable to recover — same shape Codex uses so the
      // dispatcher's `BackendQuotaError` audit-row writer doesn't need a
      // per-backend branch. `numTurns` here matches the success-branch
      // formula below (`toolCallCount + 1`) so a budget-rejected and a
      // successful run with the same tool fan-out report the same turn
      // count.
      this.assertWithinMaxBudget(costUsd, params.maxBudgetUsd, actualModelId, {
        usage: normalizedUsage,
        costSource:
          Object.keys(modelUsage).length > 0 ? costSource : estimatedCost.costSource,
        numTurns: toolCallCount + 1,
        durationMs: Date.now() - startMs,
      });
      if (output && !streamed) {
        streamCallbacks?.onText?.(output);
      }

      const durationMs = Date.now() - startMs;
      logger.info(
        { eventType: params.eventType, model: actualModelId, durationMs, costUsd },
        "Gemini execute completed",
      );

      // Bump the per-agent-day request counter on successful completion.
      // We increment per-runTurn rather than per-JSONL-event because
      // Gemini's streaming CLI may emit only delta messages without a
      // final non-delta aggregate — counting on events made the ceiling
      // enforcement silently break in streaming-only mode. Per-runTurn is
      // protocol-agnostic and guaranteed to fire once per successful
      // execution. Tool-fanout turns still count as one request, which
      // undercounts real API consumption; that is an acceptable
      // approximation for a safety-net ceiling (the tight 900 / 1350 /
      // 1800 plan ceilings absorb the slack).
      this.incrementRequestsCount(today);

      return {
        output,
        sessionId,
        backendId: this.backendId,
        modelId: actualModelId,
        costSource:
          Object.keys(modelUsage).length > 0 ? costSource : estimatedCost.costSource,
        costUsd,
        usage: normalizedUsage,
        modelUsage,
        // Each `tool_use` event indicates one model→tool turn; the
        // surrounding final assistant message is one more turn — so
        // `toolCallCount + 1` matches the Codex contract (which increments
        // `numTurns` on `turn.started`). Parallel tool calls in a single
        // model turn marginally over-count; that aligns conservatively with
        // the max-turns cap above (we cut off sooner rather than later).
        numTurns: toolCallCount + 1,
        durationMs,
        durationApiMs,
        model: actualModelId,
        isError: false,
        stopReason: resultStatus,
        contextUpdated: false,
        // advisorCallCount omitted — non-Anthropic backends never populate
        // this field, consumers treat undefined as 0.
      };
    } finally {
      // Stop the reactive idle watchdog FIRST so its interval doesn't
      // leak across the cleanup path. Safe to call even when start()
      // was never reached (the runTurn body might have thrown before
      // start()) — IdleWatchdog.stop is idempotent.
      idleWatchdog.stop();
      if (ownsSessionDir) {
        this.readTokenManager?.revoke(sessionDir);
      }
      streamCallbacks?.onEnd?.();
      if (ownsSessionDir) {
        cleanupSessionWorkdir(sessionDir);
      }
    }
  }

  private buildArgs(
    params: {
      prompt: string;
      modelId: string;
      resumeSessionId?: string;
    },
    policyPath: string,
  ): string[] {
    // The admin policy always applies (strict or allow) so context-dir and
    // sensitive-path guardrails remain enforced. `--sandbox` is the container
    // sandbox toggle (Docker/Podman) — only strict mode runs inside it.
    // `--skip-trust` bypasses the workspace-trust prompt: session workdirs
    // under PA_DATA_DIR are created fresh by the daemon and can't realistically
    // be trusted interactively; the admin policy is the actual safety surface.
    //
    // WIKI_BUILDER_DESIGN.md §4.3 — wiki sessions keep `--sandbox` on; the
    // `web_fetch` widening lives entirely inside `generateAdminPolicy` (the
    // strict policy is regenerated with one rule swapped), so `buildArgs`
    // takes no wiki-specific branch.
    const allowMode = this.config.geminiExecutionPermissionMode === "allow";
    return [
      ...(params.resumeSessionId ? ["--resume", params.resumeSessionId] : []),
      "--prompt",
      params.prompt,
      "--model",
      params.modelId,
      "--approval-mode",
      "yolo",
      "--skip-trust",
      ...(allowMode ? [] : ["--sandbox"]),
      "--admin-policy",
      policyPath,
      "--output-format",
      "stream-json",
    ];
  }

  /**
   * Generate a TOML admin policy that restricts Gemini CLI tools to match
   * the same security posture as Claude Code (allowedTools + security hooks).
   *
   * Admin policies are tier 5 (highest priority) and override --approval-mode yolo.
   *
   * All regex patterns use TOML literal strings ('...') to avoid escape-sequence
   * conflicts — TOML basic strings ("...") treat `\b` as backspace and reject
   * unknown escapes like `\.` / `\s`, which are valid regex metacharacters.
   *
   * ── Audit note: DM reactive-path allowlist bug (BUG-DM-BACKEND-PERMISSIONS) ──
   *
   * This Gemini policy does NOT need the Skill / Bash(jq *) additions that
   * Claude Code needed for the same bug. Reasons verified 2026-04-11:
   *
   *   1. Gemini CLI has no first-class "Skill" tool. User skills are loaded
   *      as files in the session workdir (`${dataDir}/skills/`), and the
   *      agent reads them via `read_file` — which is already allowed at
   *      priority 500 below. There is no tool invocation to deny.
   *
   *   2. The priority-950 rule below denies any shell command that contains
   *      a pipe (`|`), semicolon (`;`), `&&`, or subshell operator. That
   *      means `curl ... | jq ...` is ALREADY denied on this backend by
   *      design — adding `jq` to an allowlist would have no effect while the
   *      pipe-chaining deny rule is in force. Gemini's workflow for JSON
   *      post-processing is: `curl -o /tmp/out.json ...`, then `read_file`,
   *      then parse in-model. That workflow does not need `jq`.
   *
   * If `message.dm` is ever re-routed to Gemini by default, re-audit: the
   * task-flow prompts may reference `Skill(...)` syntax the agent cannot
   * invoke on this backend. That would be a prompt/task-flow issue, not an
   * allowlist issue.
   */
  generateAdminPolicy(options?: {
    webSearchEnabled?: boolean;
    /**
     * WIKI_BUILDER_DESIGN.md §4.3 — narrow per-turn override that flips the
     * `web_fetch` deny rule to `allow`. Used by `wiki.*` sessions so the
     * agent can read external URLs while every other admin-policy guard
     * (context-dir chokepoint, sensitive-path reads, pipe-chain deny,
     * absolute-block layer, etc.) remains in force. Far narrower than
     * switching the whole turn into allow-mode minimal policy.
     */
    wikiUrlFetchEnabled?: boolean;
  }): string {
    const webSearchEnabled = options?.webSearchEnabled ?? false;
    const wikiUrlFetchEnabled = options?.wikiUrlFetchEnabled ?? false;
    const port = this.config.apiPort;
    const contextDir = resolvePath(getContextDir(this.config));
    // Escape regex special chars in the path for use inside TOML literal strings.
    // Literal strings don't process escapes, so single backslash is fine.
    const escapedContextDir = contextDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

    // Build sensitive-path argsPattern (regex alternation).
    const sensitivePathPatterns = [
      "\\.ssh/",
      "\\.gnupg/",
      "\\.aws/",
      "Library/Keychains/",
      "\\.personal-agent/backups/",
      "\\.personal-agent/whatsapp/auth/",
      // `\"` (closing JSON string quote) is a required terminator because
      // Gemini matches argsPattern against the JSON-stringified args object
      // like `{"file_path":".env"}` — without `\"` the pattern silently
      // misses root `.env` reads (after `.env` comes `"` in the JSON, which
      // matches none of $ / . / /).
      '\\.env($|\\.|/|\\")',
    ];
    const sensitivePathRegex = sensitivePathPatterns.join("|");
    const sessionHelperPathRegex = '(^|/)\\.pa/';

    // Translate config.disallowedTools into additional deny rules.
    // Claude Code format: "Bash(rm -rf *)", "Read(~/.ssh/**)" etc.
    const extraDenyRules = this.buildDisallowedToolRules();
    // DELEGATED-MODE-V2-DESIGN.md §4.3.3 — same-backend integration deny
    // rules. For each integration whose `delegatedBackend === "gemini"` or
    // `nativeBackend === "gemini"`, emit one literal-toolName deny rule per
    // concrete (glob-expanded) tool name. Priority sits between
    // user-disallowedTools (935) and the absolute-block layer (1000) —
    // same enforcement weight as user-driven disallowedTools by intent,
    // but distinct so logs/audits can attribute.
    const sessionDenyRules = this.buildSessionDeniedToolRules();
    // INTEGRATION_NATIVE_MODE_DESIGN.md §11 — admin-policy catch-all
    // (priority 1) would silently deny native MCP calls; emit explicit
    // allows at priority 920 for every connector tool whose
    // `nativeBackend === "gemini"`. Below the deny tier (935/936) so
    // `deniedTools` stays authoritative; above the catch-all so the agent
    // can actually call its skill-instructed MCP tools.
    const nativeAllowRules = this.buildNativeIntegrationAllowRules();
    // EXECUTION-MODE-DESIGN.md §6 absolute-block layer — applied in both
    // strict and allow mode at priority 999 (the in-tier ceiling enforced
    // by Gemini CLI's PolicyFileSchema; admin tier still outranks user /
    // workspace / default tiers regardless of in-tier priority).
    const absoluteBlockRules = this.buildAbsoluteBlockRules();

    return `# ${APP_NAME} admin policy for Gemini CLI (auto-generated)
# Admin tier — overrides approval-mode yolo

# ══════════════════════════════════════════════════
# Catch-all: deny everything not explicitly allowed.
# This creates whitelist semantics matching Claude Code's allowedTools.
# Every allowed tool must have a higher-priority allow rule below.
# ══════════════════════════════════════════════════
[[rule]]
toolName = "*"
decision = "deny"
denyMessage = "This tool is not permitted in daemon mode."
priority = 1

${this.buildWebAccessRules(webSearchEnabled, wikiUrlFetchEnabled)}

# ── Shell: restrict to curl localhost:${port} and git ──

# Deny any shell command containing a non-localhost HTTP URL.
# This catches curl piping/chaining bypasses like:
#   curl http://localhost:8321/... ; curl http://evil.com
# Negative lookahead ensures only localhost:{port} URLs are permitted.
[[rule]]
toolName = "run_shell_command"
commandRegex = 'https?://(?!(localhost|127\\.0\\.0\\.1):${port}[/\\s?#])'
decision = "deny"
denyMessage = "HTTP requests to non-localhost targets are forbidden. Use the daemon API."
priority = 960

# Deny curl with connection-override flags (bypass prevention, matches Claude Code hook)
[[rule]]
toolName = "run_shell_command"
commandRegex = '\\bcurl\\b.*(--connect-to|--resolve|--config(\\b|=)|\\s-K|--proxy(\\b|=)|\\s-x|--socks)'
decision = "deny"
denyMessage = "curl connection override flags are not allowed (--connect-to, --resolve, --config, --proxy)."
priority = 955

# Deny curl with command chaining operators (pipe, semicolon, &&, ||, subshell, backtick)
[[rule]]
toolName = "run_shell_command"
commandRegex = '\\bcurl\\b.*(;|\\|\\||&&|\\||\\$\\(|\x60)'
decision = "deny"
denyMessage = "curl with command chaining is not allowed. Use separate tool calls."
priority = 950

# Allow curl targeting localhost:${port}
[[rule]]
toolName = "run_shell_command"
commandRegex = '\\bcurl\\b.*https?://(localhost|127\\.0\\.0\\.1):${port}(/|\\s|$|\\?)'
decision = "allow"
priority = 900

# Deny any other curl command
[[rule]]
toolName = "run_shell_command"
commandRegex = '\\bcurl\\b'
decision = "deny"
denyMessage = "curl is restricted to localhost:${port}. Use the daemon API for all HTTP requests."
priority = 850

# Deny dangerous git operations (matches Claude Code's disallowedTools)
[[rule]]
toolName = "run_shell_command"
commandRegex = '\\bgit\\s+push\\s+(-f|--force)'
decision = "deny"
denyMessage = "git push --force is not allowed."
priority = 940

[[rule]]
toolName = "run_shell_command"
commandRegex = '\\bgit\\s+reset\\s+--hard'
decision = "deny"
denyMessage = "git reset --hard is not allowed."
priority = 940

[[rule]]
toolName = "run_shell_command"
commandRegex = '\\bgit\\s+clean\\b'
decision = "deny"
denyMessage = "git clean is not allowed."
priority = 940

# Allow other git commands
[[rule]]
toolName = "run_shell_command"
commandPrefix = "git "
decision = "allow"
priority = 800

[[rule]]
toolName = "run_shell_command"
commandPrefix = "git"
decision = "allow"
priority = 800

# Deny keychain access (secrets use -A flag; block agent from reading them)
[[rule]]
toolName = "run_shell_command"
commandPrefix = "security "
decision = "deny"
denyMessage = "Keychain access is not allowed in daemon mode."
priority = 950

# Deny dangerous shell commands
[[rule]]
toolName = "run_shell_command"
commandPrefix = "rm -rf"
decision = "deny"
priority = 940

[[rule]]
toolName = "run_shell_command"
commandPrefix = "rm -r"
decision = "deny"
priority = 940

[[rule]]
toolName = "run_shell_command"
commandPrefix = "sudo "
decision = "deny"
priority = 940

[[rule]]
toolName = "run_shell_command"
commandPrefix = "su "
decision = "deny"
priority = 940

[[rule]]
toolName = "run_shell_command"
commandPrefix = "chmod "
decision = "deny"
priority = 940

[[rule]]
toolName = "run_shell_command"
commandPrefix = "chown "
decision = "deny"
priority = 940

# Deny all other shell commands (only curl-to-localhost and git are allowed)
[[rule]]
toolName = "run_shell_command"
decision = "deny"
denyMessage = "Only 'curl localhost:${port}' and 'git' commands are allowed in daemon mode."
priority = 100

# ── File operations ──

# Deny writes to context directory (must use daemon API)
[[rule]]
toolName = ["write_file", "replace"]
argsPattern = '${escapedContextDir}'
decision = "deny"
denyMessage = "Direct writes to context directory are forbidden. Use PUT/PATCH http://localhost:${port}/api/context/*"
priority = 960

# Deny writes to the session helper directory. The daemon manages .pa/bin/*
# wrappers; allowing edits would let the agent rewrite the curl shim that
# receives daemon-auth env at execution time.
[[rule]]
toolName = ["write_file", "replace"]
argsPattern = '${sessionHelperPathRegex}'
decision = "deny"
denyMessage = "Direct writes to .pa are forbidden. Session helper binaries are daemon-managed."
priority = 958

# Deny reads/writes to sensitive paths
[[rule]]
toolName = ["read_file", "read_many_files", "write_file", "replace"]
argsPattern = '${sensitivePathRegex}'
decision = "deny"
denyMessage = "Access to sensitive paths (.ssh, .aws, .gnupg, Keychains, .env, backups) is forbidden."
priority = 955

# Allow standard file operations
[[rule]]
toolName = ["read_file", "read_many_files", "glob", "grep_search", "list_directory"]
decision = "allow"
priority = 500

[[rule]]
toolName = ["write_file", "replace"]
decision = "allow"
priority = 500

# ── Other tools ──
[[rule]]
toolName = ["ask_user", "write_todos", "save_memory"]
decision = "allow"
priority = 500

# ── Subagent delegation (invoke_agent) ──
# Block Gemini CLI's built-in subagent dispatcher. The daemon's stream
# parsers (runTurn + runDelegatedTool) only observe the parent agent's
# tool_use events — subagent-internal MCP calls don't surface, so the
# anti-prompt-injection guard would mis-classify the turn as wrong_tool.
# Subagents also paraphrase tool output instead of returning the raw
# connector envelope, and per-integration deniedTools / cost accounting
# don't cross the subagent boundary. Bundled policies/agents.toml allows
# invoke_agent at default-tier priority 50; admin tier wins cross-tier
# so this rule's priority only orders it inside the admin policy, not
# against the bundled allow.
#
# Hard-coded by tool name — if a future Gemini CLI ships a renamed or
# additional delegation builtin, this rule will not catch it. Watch for
# new tool-name constants alongside AGENT_TOOL_NAME in the bundled CLI.
[[rule]]
toolName = "invoke_agent"
decision = "deny"
denyMessage = "Subagent delegation via invoke_agent is not allowed in daemon-managed sessions. Call the requested tool directly."
priority = 950
${absoluteBlockRules}${extraDenyRules}${nativeAllowRules}${sessionDenyRules}`;
  }

  /**
   * Minimal admin policy for allow mode. No catch-all deny — every tool not
   * matched by a rule below falls through to the `--approval-mode yolo`
   * grants, which is what "all commands/MCPs/skills enabled" requires.
   *
   * Only two invariants are preserved:
   *   1. Context directory writes must go through the daemon API. This is
   *      memory-layer integrity (today-write-lock, md_file_snapshots,
   *      CONTEXT_WRITE_PERMISSIONS, onPromptContextChanged) — orthogonal to
   *      tool permissions. Denied for both `write_file`/`replace` directly
   *      and for `run_shell_command` whose argv contains the context path.
   *   2. Reads of keychain / SSH / GPG / AWS / .env / daemon secrets /
   *      WhatsApp auth / backups stay denied. These aren't tool policy
   *      either — they're the exfiltration surface, and enabling them
   *      serves no agent workflow on a single-owner device.
   *
   * Everything else (arbitrary `rm`, `curl` to any host, `chmod`, `sudo`,
   * web search / fetch, etc.) is permitted because allow mode is meant to
   * be the "strong permission mode" the user asked for.
   */
  generateAllowModeMinimalPolicy(): string {
    const port = this.config.apiPort;
    const contextDir = resolvePath(getContextDir(this.config));
    // Escape regex metacharacters — TOML literal strings don't process escapes,
    // so a single backslash reaches the regex engine unchanged.
    const escapeRegex = (s: string): string =>
      s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

    // Match any shell-level path form that points at the context dir:
    //   - absolute: /Users/.../context
    //   - home-tilde: ~/... (shell expands; raw command text contains "~")
    //   - $HOME / ${HOME} env-var interpolation
    // Without these alternations, `tee ~/.personal-agent/context/today.md`
    // slips through the context-write deny rule.
    const home = homedir();
    const contextPathForms = shellPathForms(contextDir, home);
    const contextPathRegex = contextPathForms.map(escapeRegex).join("|");
    const contextArgsRegex = jsonStringPathForms(contextPathForms)
      .map(escapeRegex)
      .join("|");

    const sensitivePathPatterns = [
      "\\.ssh[\\\\/]",
      "\\.gnupg[\\\\/]",
      "\\.aws[\\\\/]",
      "Library[\\\\/]Keychains[\\\\/]",
      "\\.personal-agent[\\\\/]backups[\\\\/]",
      "\\.personal-agent[\\\\/]whatsapp[\\\\/]auth[\\\\/]",
      "\\.personal-agent[\\\\/]secrets[\\\\/]",
      // `\"` (closing JSON string quote) is a required terminator because
      // Gemini matches argsPattern against the JSON-stringified args object
      // like `{"file_path":".env"}` — without `\"` the pattern silently
      // misses root `.env` reads (after `.env` comes `"` in the JSON, which
      // matches none of $ / . / /).
      '\\.env($|\\.|[\\\\/]|\\")',
    ];
    const sensitivePathRegex = sensitivePathPatterns.join("|");

    return `# ${APP_NAME} admin policy for Gemini CLI — Allow mode (minimal)
# Admin tier — overrides approval-mode yolo only for the rules below.
# No catch-all deny: every tool not matched here inherits yolo's auto-approve.

# ── Context directory writes must go through the daemon API ──
# Memory-layer integrity invariants (today-write-lock, md_file_snapshots,
# CONTEXT_WRITE_PERMISSIONS, onPromptContextChanged) cannot be enforced on
# shell-level writes; so we deny any shell command or direct tool that
# targets the context dir.

[[rule]]
toolName = ["write_file", "replace"]
argsPattern = '${contextArgsRegex}'
decision = "deny"
denyMessage = "Direct writes to the context directory are forbidden even in Allow mode. Use PUT/PATCH http://localhost:${port}/api/context/* so today-write-lock, md_file_snapshots, and CONTEXT_WRITE_PERMISSIONS stay enforced."
priority = 999

[[rule]]
toolName = "run_shell_command"
commandRegex = '${contextPathRegex}'
decision = "deny"
denyMessage = "Shell commands that reference the context directory are forbidden — writing via redirects / tee / sed -i / script engines bypasses daemon-API guarantees. Use http://localhost:${port}/api/context/*. Absolute, ~, and HOME-env-var forms are all matched."
priority = 999

# ── Sensitive-path reads ──
# Secrets, keys, and daemon backups stay read-blocked. Writes to these
# paths are also blocked so the agent cannot plant credentials or tamper
# with keychain-adjacent directories.

[[rule]]
toolName = ["read_file", "read_many_files", "write_file", "replace"]
argsPattern = '${sensitivePathRegex}'
decision = "deny"
denyMessage = "Access to sensitive paths (.ssh, .aws, .gnupg, Keychains, .env, daemon secrets, backups, WhatsApp auth) is forbidden even in Allow mode."
priority = 998

# ── Subagent delegation (invoke_agent) ──
# Same rationale as the strict-mode policy: daemon stream parsers don't
# see subagent-internal tool calls, subagents paraphrase results, and
# per-integration deniedTools / cost accounting don't cross the subagent
# boundary. Allow mode has no catch-all "*" deny, so this explicit rule
# is the only thing keeping bundled policies/agents.toml (default tier,
# priority 50) from re-allowing invoke_agent.
[[rule]]
toolName = "invoke_agent"
decision = "deny"
denyMessage = "Subagent delegation via invoke_agent is not allowed in daemon-managed sessions. Call the requested tool directly."
priority = 950
${this.buildAbsoluteBlockRules()}${this.buildSessionDeniedToolRules()}`;
  }

  /**
   * EXECUTION-MODE-DESIGN.md §6.2 — absolute-block rules applied in BOTH
   * strict and allow mode. Priority is pinned at 999 — the in-tier
   * ceiling enforced by Gemini CLI's `PolicyFileSchema` (`priority` is
   * `.int().min(0).max(999)`; values >= 1000 fail with "Schema validation
   * failed" and the entire policy file is dropped, which would also drop
   * every other guardrail in this admin policy).
   *
   * Cross-tier precedence is unaffected: the daemon registers this file
   * via `--admin-policy <path>`, which puts it at `ADMIN_POLICY_TIER (=5)`,
   * strictly above user/workspace/default. Within the admin tier, 999 is
   * the maximum so absolute-block still wins against every other rule
   * here. The two existing 998/999 deny rules in allow mode are also
   * `decision = "deny"`, so a tie at 999 collapses to the same outcome
   * (deny) — no semantic conflict.
   *
   * Highest-priority ALLOW rule across both modes is `curl localhost`
   * at 900, well below 999, so absolute-block continues to override any
   * allow currently emitted.
   */
  private buildAbsoluteBlockRules(): string {
    return this.convertToolListToTomlRules(
      ALWAYS_DISALLOWED_TOOLS,
      {
        priority: 999,
        denyPrefix: "Blocked by absolute-block layer: ",
        sectionHeader: "Absolute-block layer (EXECUTION-MODE-DESIGN.md §6)",
      },
    );
  }

  /**
   * Convert config.disallowedTools entries into TOML deny rules.
   *
   * Claude Code format entries like "Bash(rm -rf *)" or "Read(~/.ssh/**)"
   * are translated into Gemini-native policy rules.
   */
  private buildDisallowedToolRules(): string {
    return this.convertToolListToTomlRules(
      this.config.disallowedTools ?? [],
      {
        priority: 935,
        denyPrefix: "Blocked by disallowedTools: ",
        sectionHeader: "User-configured disallowedTools",
      },
    );
  }

  /**
   * DELEGATED-MODE-V2-DESIGN.md §4.3.3 — emit deny rules for every
   * concrete (glob-expanded) MCP tool name carried by an integration's
   * `deniedTools` whose `delegatedBackend === "gemini"`. Tools are
   * matched by literal name (e.g.
   * `mcp__codex_apps__google_calendar._delete_event`) at priority 936
   * — one tick above the user-disallowedTools block (935) so a deny
   * here cannot be overridden by anything below.
   *
   * Empty when no integration is in same-backend mode for Gemini.
   */
  private buildSessionDeniedToolRules(): string {
    if (!this.mcpContext) return "";
    let denied: readonly string[] = [];
    try {
      const integrations = readIntegrations(this.mcpContext.db);
      const map = collectSessionDeniedTools(integrations, "gemini");
      const flat: string[] = [];
      for (const names of map.values()) flat.push(...names);
      denied = flat;
    } catch (err) {
      logger.warn(
        { err },
        "Failed to read integrations for same-backend denied-tools — proceeding without per-integration deny",
      );
      return "";
    }
    if (denied.length === 0) return "";
    const rules: string[] = [
      "",
      "",
      "# ══════════════════════════════════════════════════",
      "# Same-backend deniedTools (DELEGATED-MODE-V2-DESIGN.md §4.3.3)",
      "# ══════════════════════════════════════════════════",
    ];
    for (const tool of denied) {
      rules.push(`
[[rule]]
toolName = "${this.escapeTomlBasicString(tool)}"
decision = "deny"
denyMessage = "Tool '${this.escapeTomlBasicString(tool)}' is denied by the user's integration deniedTools setting."
priority = 936`);
    }
    return rules.join("\n");
  }

  /**
   * INTEGRATION_NATIVE_MODE_DESIGN.md §11 — Safe-mode admin policy allow
   * rules for every integration whose `nativeBackend === "gemini"`. The
   * `generateAdminPolicy` catch-all (`toolName = "*"`, priority 1) denies
   * unmatched tools; without an explicit allow, the agent's native MCP
   * calls (`mcp_google-workspace_gmail.search` etc.) are silently rejected
   * even though the skill body instructs the agent to make them.
   *
   * Priority 920 mirrors the per-task allow tier used in
   * `runDelegatedTask` (`generateTaskModePolicy`), placing native allows
   * above the catch-all (1) and the default file/web allows (500), and
   * below user disallowedTools (935), `buildSessionDeniedToolRules` (936),
   * destructive overlays (998), and the absolute-block layer (999). The
   * ordering keeps `deniedTools` and destructive denies authoritative over
   * the registry-driven allow.
   *
   * Empty when no integration is in native mode bound to Gemini, mirroring
   * `buildSessionDeniedToolRules`'s empty-string contract so the template
   * substitution renders cleanly.
   */
  private buildNativeIntegrationAllowRules(): string {
    if (!this.mcpContext) return "";
    let allowedTools: readonly string[] = [];
    try {
      const integrations = readIntegrations(this.mcpContext.db);
      const out: string[] = [];
      for (const key of INTEGRATION_KEYS) {
        const state = integrations[key];
        if (!state || state.mode !== "native") continue;
        if (state.nativeBackend !== "gemini") continue;
        const connector = INTEGRATION_DESCRIPTORS[key].backendConnectors.gemini;
        // User-managed native (no descriptor connector entry) reaches here;
        // see `docs/design/appendices/native-integration-mode.md`
        // "User-managed native" — the operator widens via their own admin
        // policy or runs Allow mode.
        if (!connector) continue;
        for (const toolNames of Object.values(connector.capabilityTools)) {
          for (const tool of toolNames) {
            out.push(`${connector.toolNamespace}${tool}`);
          }
        }
      }
      allowedTools = Array.from(new Set(out));
    } catch (err) {
      logger.warn(
        { err },
        "Failed to read integrations for native-mode allow rules — proceeding without per-integration allow",
      );
      return "";
    }
    if (allowedTools.length === 0) return "";
    const rules: string[] = [
      "",
      "",
      "# ══════════════════════════════════════════════════",
      "# Native-mode connector allow (INTEGRATION_NATIVE_MODE_DESIGN.md §11)",
      "# ══════════════════════════════════════════════════",
    ];
    for (const tool of allowedTools) {
      rules.push(`
[[rule]]
toolName = "${this.escapeTomlBasicString(tool)}"
decision = "allow"
priority = 920`);
    }
    return rules.join("\n");
  }

  private convertToolListToTomlRules(
    disallowed: readonly string[],
    opts: { priority: number; denyPrefix: string; sectionHeader: string },
  ): string {
    const rules: string[] = [];

    for (const entry of disallowed) {
      const bashMatch = /^Bash\((.+)\)$/.exec(entry);
      if (bashMatch) {
        // "Bash(rm -rf *)" → deny run_shell_command with commandPrefix
        const cmdPattern = bashMatch[1].replace(/\s*\*$/, "").trim();
        if (cmdPattern) {
          rules.push(`
[[rule]]
toolName = "run_shell_command"
commandPrefix = "${this.escapeTomlBasicString(cmdPattern)}"
decision = "deny"
denyMessage = "${this.escapeTomlBasicString(opts.denyPrefix)}${this.escapeTomlBasicString(entry)}"
priority = ${opts.priority}`);
        }
        continue;
      }

      const fileMatch = /^(Read|Write|Edit)\((.+)\)$/.exec(entry);
      if (fileMatch) {
        const [, toolType, pathGlob] = fileMatch;
        // Convert glob to a simple regex substring for argsPattern.
        // "~/.ssh/**" → ".ssh/"
        const pathFragment = pathGlob
          .replace(/^~\//, "")
          .replace(/\*+$/g, "")
          .replace(/\\/g, "/");
        if (!pathFragment) continue;

        const toolNames: string[] = [];
        if (toolType === "Read") toolNames.push("read_file", "read_many_files");
        if (toolType === "Write" || toolType === "Edit") toolNames.push("write_file", "replace");

        if (toolNames.length > 0) {
          const toolNameValue = toolNames.length === 1
            ? `"${toolNames[0]}"`
            : `[${toolNames.map((t) => `"${t}"`).join(", ")}]`;
          rules.push(`
[[rule]]
toolName = ${toolNameValue}
argsPattern = '${pathFragment}'
decision = "deny"
denyMessage = "${this.escapeTomlBasicString(opts.denyPrefix)}${this.escapeTomlBasicString(entry)}"
priority = ${opts.priority}`);
        }
      }
    }

    if (rules.length === 0) return "";
    return `
# ── ${opts.sectionHeader} ──
${rules.join("\n")}
`;
  }

  /**
   * Build the web-access TOML rules section.
   *
   * Four-state truth table (webSearchEnabled, wikiUrlFetchEnabled):
   *   - (false, false): deny both. Default daemon-wide posture — matches
   *     Claude Code's allowedTools whitelist that excludes WebSearch +
   *     WebFetch by default.
   *   - (true, false): allow google_web_search; deny web_fetch. The
   *     operator opted into search but URL fetch stays blocked as an
   *     exfiltration vector.
   *   - (false, true): deny google_web_search; allow web_fetch. WIKI
   *     ingestion needs the URL the user named, NOT free-form web
   *     search. Narrowest widening for the wiki path.
   *   - (true, true): allow both. Operator wants search + wiki on the
   *     same Gemini turn.
   *
   * `wikiUrlFetchEnabled` is set per-execute only (see
   * `WIKI_BUILDER_DESIGN.md` §4.3) so non-wiki sessions on the same
   * backend keep their narrower posture.
   */
  private buildWebAccessRules(
    webSearchEnabled: boolean,
    wikiUrlFetchEnabled: boolean,
  ): string {
    const searchClause = webSearchEnabled
      ? `[[rule]]
toolName = "google_web_search"
decision = "allow"
priority = 500`
      : `[[rule]]
toolName = "google_web_search"
decision = "deny"
denyMessage = "Web search is not allowed in daemon mode. Use the daemon API for external data."
priority = 999`;

    const fetchClause = wikiUrlFetchEnabled
      ? `[[rule]]
toolName = "web_fetch"
decision = "allow"
priority = 500`
      : `[[rule]]
toolName = "web_fetch"
decision = "deny"
denyMessage = "Web fetch is not allowed. Use the daemon Wiki API for external data."
priority = 999`;

    const header = webSearchEnabled || wikiUrlFetchEnabled
      ? `# ── Web access: PARTIAL ALLOW ──
# Per-turn widening for wiki / web-search; non-wiki turns keep narrower posture.`
      : `# ── Web access: DENY ──
# Block internet search and URL fetching (parity with Claude Code's allowedTools whitelist)`;

    return `${header}

${searchClause}

${fetchClause}`;
  }

  /** Escape characters for TOML basic string values (double-quoted). */
  private escapeTomlBasicString(value: string): string {
    return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  }

  /**
   * Pre-mark vault-scoped file writes from Gemini's tool_use events
   * so the ObsidianWatcher attributes them to actor='agent'.
   */
  private trackVaultWrite(event: GeminiStreamEvent): void {
    if (!this.writeTracker) return;
    const vaultPath = this.config.externalObsidianVaultPath;
    if (!vaultPath) return;

    if (event.tool_name !== "write_file" && event.tool_name !== "replace") return;

    const filePath = event.args?.file_path;
    if (typeof filePath !== "string" || !filePath) return;

    const absFile = resolvePath(filePath);
    const absVault = resolvePath(vaultPath);
    if (isPathInsideOrEqual(absVault, absFile)) {
      this.writeTracker.markWriting(absFile);
      logger.debug(
        { filePath: absFile },
        "Gemini vault write pre-marked for observer attribution",
      );
    }
  }

  private pickSummaryModel(): string {
    // Registry-derived lite-tier model is the canonical pick (compaction
    // summaries are short-shape and benefit from the cheapest model).
    // Falls through to "any registered model" when the registry has no
    // available lite entry, then throws when the registry is empty for
    // this backend — preferable to the prior silent literal fallback
    // that hid registry misconfiguration.
    const liteFromRegistry = latestLiteFor(this.backendId);
    if (liteFromRegistry) return liteFromRegistry;
    const anyFromRegistry = this.listModels()[0]?.modelId;
    if (anyFromRegistry) return anyFromRegistry;
    throw new Error(
      `pickSummaryModel: no models registered for backend ${this.backendId}`,
    );
  }

  /**
   * Resolve the Gemini per-agent-day request ceiling. The daemon does
   * not store per-backend account tiers (Aitne runs on
   * `GEMINI_API_KEY` / `GOOGLE_API_KEY`, with CLI auth as fallback),
   * so this returns a fixed conservative default
   * (`GEMINI_DAILY_REQUEST_CEILING`, matching the free Gemini API tier
   * with 10% headroom). Operators on a paid Google account whose real
   * upstream quota is higher can widen the gate by editing
   * `runtime_state` directly or via a dashboard config surface (out of
   * scope for this layer).
   *
   * Returns `null` only when no db handle is injected (test/dev paths
   * that bypass enforcement entirely).
   */
  private resolveDailyRequestCeiling(): number | null {
    if (!this.db) return null;
    return GEMINI_DAILY_REQUEST_CEILING;
  }

  /**
   * Read the current request count for today's agent day. Returns 0 when:
   * - the stored state is from a previous agent day (natural daily reset),
   * - the row is missing,
   * - or the db handle is not injected.
   */
  private readRequestsCount(today: string): number {
    if (!this.db) return 0;
    const state = readRuntimeState<GeminiRequestsState>(
      this.db,
      GEMINI_REQUESTS_STATE_KEY,
    );
    if (!state || state.date !== today) return 0;
    return state.count;
  }

  /**
   * Increment the per-agent-day counter. Resets to 1 when the stored date
   * does not match the current agent day (that is the reset path — no
   * separate scheduler job is needed because the key is agent-day scoped).
   */
  private incrementRequestsCount(today: string): void {
    if (!this.db) return;
    try {
      const state = readRuntimeState<GeminiRequestsState>(
        this.db,
        GEMINI_REQUESTS_STATE_KEY,
      );
      const nextCount =
        state && state.date === today ? state.count + 1 : 1;
      writeRuntimeState(this.db, GEMINI_REQUESTS_STATE_KEY, {
        date: today,
        count: nextCount,
      } satisfies GeminiRequestsState);
    } catch (err) {
      // A counter write failure must not break an in-flight execution.
      logger.warn({ err }, "Failed to persist Gemini request counter");
    }
  }

  // Failure classification + budget enforcement share a skeleton with the
  // Codex core; the logic lives in `cli-quota-guards.ts` (single source of
  // truth) and each backend passes its own regexes / label. Gemini adds a
  // pre-auth policy-deny branch via `classifyGeminiPolicyDeny`.
  private classifyFailure(message: string): BackendQuotaError | BackendDecisiveFailure {
    return classifyCliFailure({
      backendId: this.backendId,
      message,
      // Google API quota surfaces as "rate limit" / "quota" / HTTP 429.
      rateLimitPattern: /rate limit|quota|429/i,
      authPattern: /authentication page|oauth|api key|login|required/i,
      extraClassifier: classifyGeminiPolicyDeny,
    });
  }

  private assertWithinMaxBudget(
    costUsd: number,
    maxBudgetUsd: number | undefined,
    modelId: string,
    spend?: Omit<import("../agent-core.js").BackendQuotaSpend, "modelId" | "costUsd">,
  ): void {
    assertCostWithinMaxBudget({
      backendId: this.backendId,
      label: "Gemini CLI",
      costUsd,
      maxBudgetUsd,
      modelId,
      spend,
    });
  }

  private assertPromptWithinMaxBudget(
    prompt: string,
    maxBudgetUsd: number | undefined,
    modelId: string,
  ): void {
    assertPromptCostWithinMaxBudget({
      backendId: this.backendId,
      label: "Gemini CLI",
      prompt,
      maxBudgetUsd,
      modelId,
      priceFetcher: this.priceFetcher,
    });
  }

  /**
   * Delegated proxy invocation — Gemini CLI path.
   *
   * **Result extraction**: Gemini CLI ≥ 0.40 emits structured
   * `tool_result` events with `tool_id` correlation and a string-encoded
   * `output` field. We capture the first `tool_result` whose `tool_id`
   * pairs with a `tool_use` event for the requested tool name; that
   * output (parsed JSON when possible) becomes the `toolResult`. This
   * matches the Claude/Codex paths and is robust to Gemini Flash Lite
   * disregarding the proxy prompt's "return raw result, do not narrate"
   * instruction by emitting prose summaries — the prose lands in the
   * assistant message stream, which we now ignore.
   *
   * **Fallback**: if no matching `tool_result` event arrives (older CLI,
   * unexpected stream shape) we fall back to the previous text-based
   * extraction from the final assistant message — strictly worse, but
   * better than failing the call outright.
   *
   * Reachable for every integration whose registry descriptor lists a
   * Gemini connector. As of 2026-04-26 that includes `gmail` (via the
   * `google-workspace` extension), `google_calendar` (same extension),
   * and `notion` (user-installed Notion MCP server registered as
   * `notion`). Gmail and Calendar are also in `PROXY_DRIVEN_INTEGRATIONS`,
   * so a Claude/Codex DM session with `delegatedBackend = "gemini"` for
   * either reaches this method through the internal
   * `DelegatedBackendInvoker.invoke()` API (the underlying transport
   * lives behind the daemon's hourly drift-detection worker and behind
   * `/api/integrations/:key/exec` task-mode dispatch; the legacy
   * `/api/integrations/:key/invoke` RPC route was retired 2026-05-01).
   */
  async runDelegatedTool(
    params: DelegatedToolInvokeParams,
  ): Promise<DelegatedToolResult> {
    const startMs = Date.now();
    const { toolName, toolArgs, modelId, sessionDir, abortSignal } = params;
    if (!this.cliPath) {
      return {
        ok: false,
        errorClass: "subprocess_crashed",
        message: "gemini CLI not found on PATH",
        cost: withDurationMs(emptyCost(), startMs),
      };
    }
    const auth = await this.checkAuth();
    if (!auth.ok) {
      return {
        ok: false,
        errorClass: "auth_error",
        message: auth.reason,
        cost: withDurationMs(emptyCost(), startMs),
      };
    }

    // Daily-request quota gate. Mirrors `runTurn`'s gate — Gemini
    // meters per-day model requests via plan-preset `dailyRequestCeiling`
    // (900/1350/1800), and proxy invocations consume the same quota as
    // direct execute()s. Without this gate, proxy calls would silently
    // exceed the day cap. Counter increment lives at the end of the
    // success path so failed proxy calls don't bias the count toward
    // saturation. See `docs/design/09-safety-cost.md` §9.4.8.
    const today = getAgentDayDateStr(
      this.config.timezone,
      this.config.dayBoundaryHour,
    );
    const ceiling = this.resolveDailyRequestCeiling();
    if (ceiling !== null) {
      const currentCount = this.readRequestsCount(today);
      if (currentCount >= ceiling) {
        return {
          ok: false,
          errorClass: "auth_error",
          message:
            `Gemini daily-request ceiling reached (${currentCount}/${ceiling}) — `
            + `resets at the next agent-day boundary.`,
          cost: withDurationMs(emptyCost(), startMs),
        };
      }
    }

    // Write the same admin policy the normal path uses so context-dir
    // writes and pipe-chained shell commands are denied even on the
    // proxy session. Proxy.md tells the model to call exactly one tool;
    // the policy is belt-and-suspenders.
    const allowMode = this.config.geminiExecutionPermissionMode === "allow";
    const policyPath = join(sessionDir, ADMIN_POLICY_FILENAME);
    writeFileSync(
      policyPath,
      allowMode
        ? this.generateAllowModeMinimalPolicy()
        : this.generateAdminPolicy({ webSearchEnabled: false }),
      "utf-8",
    );

    const prompt = buildDelegatedToolPrompt(toolName, toolArgs);
    const args = this.buildArgs(
      { prompt, modelId },
      policyPath,
    );

    let calledMatchingTool = false;
    let wrongToolName: string | null = null;
    let assistantDelta = "";
    let finalAssistantMessage = "";
    let lastError: string | null = null;
    let resultStatus: string | null = null;
    let stats: GeminiStats | null = null;
    // tool_use → tool_id mapping for the requested tool. Gemini sometimes
    // calls the matching tool more than once (e.g. retries with refined
    // args, or extra confirmation calls disregarding the prompt's
    // "do not call other tools"). We capture every matching tool_id and
    // keep only the first paired tool_result so the proxy returns
    // deterministic output.
    const matchingToolIds = new Set<string>();
    let capturedToolOutput: string | null = null;
    let capturedToolStatus: string | null = null;

    // Local aborter bridged from the caller's signal so we can also
    // trigger an early abort on wrong-tool detection without polluting
    // the caller's signal. Without early abort, a wrong-tool failure
    // burns the full gemini wall-clock waiting for natural completion;
    // abort caps it at ~5s.
    const proxyAborter = new AbortController();
    const callerAbortListener = (): void => {
      proxyAborter.abort(abortSignal?.reason);
    };
    if (abortSignal) {
      if (abortSignal.aborted) {
        proxyAborter.abort(abortSignal.reason);
      } else {
        abortSignal.addEventListener("abort", callerAbortListener, {
          once: true,
        });
      }
    }

    // Idle / hang watchdog. `gemini-cli` has been observed to lock up
    // entirely — subprocess alive, zero stream-json output, only the
    // wall-clock fires. The idle detector trips much earlier (75s
    // default, see `delegated-proxy-config.ts`) by treating each
    // arrived line as a heartbeat. On trip, we abort with a
    // `DelegatedProxyTimeoutError` so the post-loop classifier maps to
    // `errorClass="timeout"`, identical to wall-clock — the cadence
    // retry path stays uniform.
    let idleTimedOut = false;
    const idleTimeoutMs =
      DELEGATED_PROXY_DEFAULTS.idleTimeoutMsByBackend.gemini
      ?? DELEGATED_PROXY_DEFAULTS.idleTimeoutMs;
    const idleWatchdog = new IdleWatchdog({
      idleTimeoutMs,
      onTimeout: (idleMs) => {
        idleTimedOut = true;
        logger.warn(
          { idleMs, idleTimeoutMs, toolName },
          "gemini delegated proxy idle watchdog tripped",
        );
        proxyAborter.abort(
          new DelegatedProxyTimeoutError(
            `gemini stream idle for ${idleMs}ms (limit ${idleTimeoutMs}ms)`,
          ),
        );
      },
    });

    const daemonReadToken = this.readTokenManager?.issue(sessionDir) ?? this.readToken;
    try {
      idleWatchdog.start();
      const runResult = await runLineCommand({
        command: this.cliPath,
        args,
        cwd: sessionDir,
        env: buildDaemonApiCliEnv(sessionDir, this.config.apiPort, {
          ...(daemonReadToken ? { readToken: daemonReadToken } : {}),
          sessionBackend: "gemini",
        }),
        // Safety-net timeout, derived from the invoker's per-backend
        // abort timeout (`callTimeoutMsByBackend.gemini`). We add a 60s
        // grace window so the abort signal *always* fires first and we
        // get a clean `timeout` errorClass instead of the watchdog's
        // ambiguous "subprocess exceeded local safety-net timeout".
        // Deriving rather than hard-coding prevents drift if the abort
        // cap is later raised or lowered.
        timeoutMs:
          (DELEGATED_PROXY_DEFAULTS.callTimeoutMsByBackend.gemini
            ?? DELEGATED_PROXY_DEFAULTS.callTimeoutMs)
          + 60_000,
        abortSignal: proxyAborter.signal,
        onStdoutLine: (line) => {
          idleWatchdog.beat();
          const event = parseJsonLine<GeminiStreamEvent>(line);
          if (!event?.type) return;

          if (
            event.type === "tool_use"
            && typeof event.tool_name === "string"
          ) {
            if (event.tool_name === toolName) {
              calledMatchingTool = true;
              if (typeof event.tool_id === "string") {
                matchingToolIds.add(event.tool_id);
              }
            } else if (wrongToolName === null) {
              wrongToolName = event.tool_name;
              // Early abort: kill the subprocess as soon as we see the
              // model call a tool that doesn't match `toolName`. The
              // post-await classifier checks `wrongToolName` BEFORE
              // `abortSignal?.aborted`, so the resulting failure is
              // attributed to wrong_tool (not cancelled).
              proxyAborter.abort(new Error("wrong_tool"));
            }
            return;
          }

          if (
            event.type === "tool_result"
            && typeof event.tool_id === "string"
            && matchingToolIds.has(event.tool_id)
            && capturedToolOutput === null
          ) {
            capturedToolOutput =
              typeof event.output === "string" ? event.output : "";
            capturedToolStatus = event.status ?? null;
            return;
          }

          if (event.type === "message" && event.role === "assistant") {
            const content =
              typeof event.content === "string" ? event.content : "";
            if (!content) return;
            if (event.delta) {
              assistantDelta += content;
            } else {
              finalAssistantMessage = content;
            }
            return;
          }

          if (event.type === "result") {
            const payload = event.result ?? event;
            resultStatus = payload.status ?? resultStatus;
            stats = payload.stats ?? stats;
            lastError = payload.error ?? lastError;
          }
        },
        onStderrLine: (line) => {
          idleWatchdog.beat();
          if (isLikelyGeminiFailure(line)) {
            lastError = line.trim();
          }
        },
      });

      const usage = normalizeGeminiUsage(stats);
      const actualModelId = modelId;
      const estimatedCost = this.priceFetcher.estimateUsageCost({
        backendId: this.backendId,
        modelId: actualModelId,
        usage,
        fallbackModel: findRegisteredModel(this.backendId, actualModelId),
      });
      const cost = withDurationMs(
        {
          tokensInput: usage.inputTokens,
          tokensOutput: usage.outputTokens,
          cacheCreationTokens: usage.cacheCreationInputTokens,
          cacheReadTokens: usage.cacheReadInputTokens,
          costUsd: estimatedCost.costUsd,
          durationMs: 0,
          numTurns: 1,
        },
        startMs,
      );

      // Order matters: wrong_tool is checked before the abort branch
      // because the early-abort path (proxyAborter.abort) sets
      // wrongToolName + triggers a kill. Without this ordering, the
      // failure would surface as "cancelled" instead of the actual
      // upstream cause. The idle-watchdog branch is checked AFTER
      // wrong_tool (a wrong-tool-then-idle race should still attribute
      // wrong_tool, since the model demonstrably misbehaved) but BEFORE
      // the caller's abortSignal branch (idle-induced proxyAborter abort
      // does not propagate back to abortSignal, so without this ordering
      // an idle hang would mis-classify as `no_tool_call`).
      if (wrongToolName !== null && !calledMatchingTool) {
        return {
          ok: false,
          errorClass: "wrong_tool",
          message: `model called '${wrongToolName}' instead of requested '${toolName}'`,
          cost,
        };
      }
      if (idleTimedOut) {
        return {
          ok: false,
          errorClass: "timeout",
          message: `delegated proxy stream went idle (no gemini events for ${idleTimeoutMs}ms)`,
          cost,
        };
      }
      if (abortSignal?.aborted) {
        const errorClass = classifyAbortReason(abortSignal.reason);
        return {
          ok: false,
          errorClass,
          message:
            errorClass === "timeout"
              ? "delegated proxy timed out (wall-clock)"
              : "delegated proxy cancelled by caller",
          cost,
        };
      }
      if (runResult.timedOut) {
        return {
          ok: false,
          errorClass: "timeout",
          message: "gemini subprocess exceeded local safety-net timeout",
          cost,
        };
      }
      if (!calledMatchingTool) {
        const failure = lastError;
        if (failure && /unauthorized|forbidden|api key|login|auth/i.test(failure)) {
          return {
            ok: false,
            errorClass: "auth_error",
            message: failure,
            cost,
          };
        }
        return {
          ok: false,
          errorClass: "no_tool_call",
          message:
            failure
            ?? `model did not invoke '${toolName}' (resultStatus=${resultStatus ?? "unknown"})`,
          cost,
        };
      }

      // Preferred path: structured tool_result captured from the stream.
      // Reliable across Gemini Flash Lite's prose-narration tendency
      // because we ignore the assistant message and use the connector's
      // raw output verbatim.
      if (capturedToolOutput !== null) {
        if (capturedToolStatus === "error") {
          // Gemini CLI surfaces an MCP-tool-name-not-in-registry condition
          // as a tool_result with `status="error"` and an output starting
          // `Tool "<name>" not found. Did you mean…`. This is a transient
          // CLI-side registry miss (extension MCP server cold-start race
          // observed when the cadence worker's first tick fires <10s after
          // an integration switches to `delegated` — the host's
          // google-workspace MCP hasn't completed handshake yet, so the
          // model's tool_use lands on an empty registry). It is NOT a
          // real connector error from the upstream API, so we classify it
          // distinctly and let `delegated-sync-worker`'s retry policy
          // bounce once with a delay; the second attempt finds the tool
          // registered.
          if (isToolNotRegisteredError(capturedToolOutput, toolName)) {
            return {
              ok: false,
              errorClass: "tool_not_registered",
              message: capturedToolOutput,
              cost,
            };
          }
          return {
            ok: false,
            errorClass: "tool_error",
            message: capturedToolOutput || "tool returned error",
            cost,
          };
        }
        this.incrementRequestsCount(today);
        return {
          ok: true,
          toolResult: tryParseToolResult(capturedToolOutput),
          cost,
        };
      }

      // Fallback: text-based extraction from the assistant message.
      // Reached when the CLI's stream-json schema doesn't emit
      // tool_result events (older versions) or when the matching
      // tool_use never paired with a tool_result for some reason.
      //
      // Warn so production can detect CLI version drift — silent fallback
      // is what produced the original Flash Lite "narrate-the-result"
      // bug. If this warning starts firing, audit the CLI version.
      logger.warn(
        {
          integrationKey: params.integrationKey,
          toolName,
          backendId: this.backendId,
          modelId,
          matchingToolUseCount: matchingToolIds.size,
        },
        "Gemini delegated proxy fell back to assistant-text extraction — no paired tool_result event captured. Audit CLI stream schema if this fires regularly.",
      );
      const resultText =
        finalAssistantMessage.trim().length > 0
          ? finalAssistantMessage.trim()
          : assistantDelta.trim();
      if (resultText.length === 0) {
        return {
          ok: false,
          errorClass: "parse_error",
          message:
            "gemini emitted matching tool_use but no tool_result event and no assistant text to extract result from",
          cost,
        };
      }

      // resultStatus === "error" with content present is a connector
      // tool_error path — surface the message verbatim per proxy.md.
      if (resultStatus === "error") {
        return {
          ok: false,
          errorClass: "tool_error",
          message: resultText,
          cost,
        };
      }

      // Bump the per-agent-day counter on the success path only,
      // mirroring `runTurn`'s success-path counter bump. Proxy success
      // consumes one Gemini request
      // (turn-level approximation; tool fanout still counts as one,
      // matching the existing accounting).
      this.incrementRequestsCount(today);
      return {
        ok: true,
        toolResult: tryParseToolResult(resultText),
        cost,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const cost = withDurationMs(emptyCost(), startMs);
      if (abortSignal?.aborted) {
        return {
          ok: false,
          errorClass: classifyAbortReason(abortSignal.reason),
          message,
          cost,
        };
      }
      return { ok: false, errorClass: "subprocess_crashed", message, cost };
    } finally {
      // Stop the idle watchdog before listener cleanup so a late-firing
      // poll cannot abort an already-resolved subprocess.
      idleWatchdog.stop();
      // Invoker owns sessionDir lifecycle, but the readToken scope is keyed
      // on the same path — revoke here so a leaked token cannot outlive the
      // delegated proxy run.
      this.readTokenManager?.revoke(sessionDir);
      // Drop the listener regardless of how the call resolved so a
      // long-lived caller signal doesn't accumulate references across
      // back-to-back proxy invocations.
      if (abortSignal && !abortSignal.aborted) {
        abortSignal.removeEventListener("abort", callerAbortListener);
      }
    }
  }

  /**
   * DELEGATED-TASK-MODE-DESIGN.md §9.3 — Gemini CLI task mode.
   *
   * The admin policy is rebuilt per-request as a tightly-scoped task-only
   * surface (not the full strict/allow generators):
   *   - catch-all deny at priority 1
   *   - per-task allow rules at priority 920 for each tool in `allowedTools`
   *   - destructive denies at priority 998 (when allowDestructive=false)
   *   - absolute-block at priority 999
   * No shell or file allows — task mode runs MCP tools only.
   *
   * Stream parsing tracks `tool_use` / `tool_result` pairs to populate the
   * trace, counts assistant turns for the §8.3 Gemini per-day request
   * counter, and aborts on `maxToolCalls` overrun or any tool not in
   * `allowedTools` (defense-in-depth past the admin TOML).
   */
  async runDelegatedTask(
    params: DelegatedTaskInvokeParams,
  ): Promise<DelegatedTaskResultRaw> {
    const startMs = Date.now();
    const {
      systemPrompt,
      allowedTools,
      destructiveTools,
      writeClassTools,
      modelId,
      maxToolCalls,
      sessionDir,
      abortSignal,
      onToolStep,
      allowDestructive,
    } = params;
    const trace: DelegatedTaskToolStepRaw[] = [];
    let writeClassToolFired = false;
    // §6.2 / §7.4 — match against the *write-class* set (destructive ∪
    // reversible writes), not just destructive. Otherwise reversible
    // write tools like `create_draft` slip past the retry guard and the
    // single retry creates a duplicate side effect.
    //
    // Phase 1 (`/exec`) entries are fully-qualified exact names; Phase 2
    // (`/api/delegated/run`) may pass `*`-suffixed glob patterns. The shared
    // `matchRunAllowedToolPattern` helper covers both shapes — exact equality
    // OR trailing-`*` prefix match — so the same matcher applies to the
    // allowed-tool guard further down (§9.3 stream-level enforcement).
    const writeClassMatcher = (name: string): boolean =>
      writeClassTools.some((pattern) =>
        matchRunAllowedToolPattern(pattern, name),
      );

    if (!this.cliPath) {
      return {
        ok: false,
        errorClass: "subprocess_crashed",
        message: "gemini CLI not found on PATH",
        cost: withDurationMs(emptyCost(), startMs),
        trace,
        writeClassToolFired,
      };
    }
    const auth = await this.checkAuth();
    if (!auth.ok) {
      return {
        ok: false,
        errorClass: "auth_error",
        message: auth.reason,
        cost: withDurationMs(emptyCost(), startMs),
        trace,
        writeClassToolFired,
      };
    }

    // §8.3 — pre-spawn daily-request gate. Mirrors runDelegatedTool because
    // task mode consumes the same daily budget.
    const today = getAgentDayDateStr(
      this.config.timezone,
      this.config.dayBoundaryHour,
    );
    const ceiling = this.resolveDailyRequestCeiling();
    if (ceiling !== null) {
      const currentCount = this.readRequestsCount(today);
      if (currentCount >= ceiling) {
        return {
          ok: false,
          errorClass: "auth_error",
          message:
            `Gemini daily-request ceiling reached (${currentCount}/${ceiling}) — `
            + `resets at the next agent-day boundary.`,
          cost: withDurationMs(emptyCost(), startMs),
          trace,
          writeClassToolFired,
        };
      }
    }

    const policyPath = join(sessionDir, ADMIN_POLICY_FILENAME);
    writeFileSync(
      policyPath,
      this.generateTaskModePolicy({
        allowedTools,
        destructiveTools: allowDestructive ? [] : destructiveTools,
      }),
      "utf-8",
    );

    const args = this.buildArgs({ prompt: systemPrompt, modelId }, policyPath);

    interface PendingToolUse {
      name: string;
      args: unknown;
      startedAt: number;
    }
    const pendingByUseId = new Map<string, PendingToolUse>();
    let toolCallCount = 0;
    let loopAborted = false;
    let assistantDelta = "";
    let finalAssistantMessage = "";
    let lastError: string | null = null;
    let resultStatus: string | null = null;
    let stats: GeminiStats | null = null;
    let policyViolationTool: string | null = null;
    let assistantTurns = 0;

    const aborter = new AbortController();
    const callerListener = () => aborter.abort(abortSignal?.reason);
    if (abortSignal) {
      if (abortSignal.aborted) {
        aborter.abort(abortSignal.reason);
      } else {
        abortSignal.addEventListener("abort", callerListener, { once: true });
      }
    }

    // §9.3 — stream-level allowed-tools guard. `allowedTools` may carry
    // Phase 2 (`/api/delegated/run`) trailing-`*` glob patterns
    // (DELEGATED-TASK-MODE-DESIGN.md §4.2), so an exact-equality `Set.has`
    // would silently reject every glob-admitted call as `policy_violation`.
    // The Gemini admin policy TOML at priority 920 honors the same glob
    // shape upstream (verified against the gemini-cli policy engine docs);
    // the daemon-side guard mirrors that semantics so the two layers agree.
    // Phase 1 (`/exec`) entries are fully-qualified exact names — the
    // exact-equality fast path inside `matchRunAllowedToolPattern` covers
    // them at one comparison.
    const isAllowedTool = (name: string): boolean =>
      allowedTools.some((pattern) =>
        matchRunAllowedToolPattern(pattern, name),
      );
    // `destructiveTools` is fully-qualified exact names from the registry
    // (Phase 1 only — Phase 2 passes `[]`), so a Set lookup is correct here
    // and stays O(1).
    const destructiveSet = allowDestructive
      ? new Set<string>()
      : new Set<string>(destructiveTools);

    const daemonReadToken = this.readTokenManager?.issue(sessionDir) ?? this.readToken;
    try {
      const runResult = await runLineCommand({
        command: this.cliPath,
        args,
        cwd: sessionDir,
        env: buildDaemonApiCliEnv(sessionDir, this.config.apiPort, {
          ...(daemonReadToken ? { readToken: daemonReadToken } : {}),
          sessionBackend: "gemini",
        }),
        timeoutMs:
          (DELEGATED_PROXY_DEFAULTS.callTimeoutMsByBackend.gemini
            ?? DELEGATED_PROXY_DEFAULTS.callTimeoutMs)
          + 60_000,
        abortSignal: aborter.signal,
        onStdoutLine: (line) => {
          const event = parseJsonLine<GeminiStreamEvent>(line);
          if (!event?.type) return;

          if (event.type === "tool_use" && typeof event.tool_name === "string") {
            const toolName = event.tool_name;
            if (!isAllowedTool(toolName) || destructiveSet.has(toolName)) {
              policyViolationTool = toolName;
              loopAborted = true;
              aborter.abort(new Error("policy_violation"));
              return;
            }
            toolCallCount += 1;
            if (toolCallCount > maxToolCalls) {
              loopAborted = true;
              aborter.abort(new Error("loop_aborted"));
              return;
            }
            if (writeClassMatcher(toolName)) {
              writeClassToolFired = true;
            }
            if (typeof event.tool_id === "string") {
              pendingByUseId.set(event.tool_id, {
                name: toolName,
                args: (event.args as unknown) ?? null,
                startedAt: Date.now(),
              });
            }
            return;
          }

          if (
            event.type === "tool_result"
            && typeof event.tool_id === "string"
          ) {
            const pending = pendingByUseId.get(event.tool_id);
            if (!pending) return;
            pendingByUseId.delete(event.tool_id);
            const status: "ok" | "error" =
              event.status === "error" ? "error" : "ok";
            // `event.output` is a string-encoded tool result (the
            // google-workspace extension and most other connectors
            // serialize JSON responses to text). Try to parse so the
            // response-shape walker downstream can pluck ids; fall back
            // to the raw string when parsing fails (free-form text
            // replies).
            let parsedToolResult: unknown;
            if (typeof event.output === "string") {
              try {
                parsedToolResult = JSON.parse(event.output);
              } catch {
                parsedToolResult = event.output;
              }
            }
            const step: DelegatedTaskToolStepRaw = {
              toolName: pending.name,
              toolArgs: pending.args,
              durationMs: Date.now() - pending.startedAt,
              status,
              costUsd: null,
              tokensInput: null,
              tokensOutput: null,
              toolResult: parsedToolResult,
            };
            trace.push(step);
            onToolStep?.(step);
            return;
          }

          if (event.type === "message" && event.role === "assistant") {
            // Reasoning gate — mirror the executeTurn path. Gemini CLI
            // 0.x's emerging "thought" channel surfaces inside an
            // assistant-role message via `messageType: "thought"`.
            // The delegated-task surface ultimately returns
            // `rawAssistantText` to the dispatcher's structured-output
            // validator, so a leaked thought would either fail JSON
            // parsing (parse_error wrapped around reasoning content)
            // or land verbatim in delegated-task traces. Drop here
            // before any accumulation.
            if (event.messageType === "thought") {
              return;
            }
            assistantTurns += 1;
            const content =
              typeof event.content === "string" ? event.content : "";
            if (!content) return;
            if (event.delta) {
              assistantDelta += content;
            } else {
              finalAssistantMessage = content;
            }
            return;
          }

          if (event.type === "result") {
            const payload = event.result ?? event;
            resultStatus = payload.status ?? resultStatus;
            stats = payload.stats ?? stats;
            lastError = payload.error ?? lastError;
          }
        },
        onStderrLine: (line) => {
          if (isLikelyGeminiFailure(line)) {
            lastError = line.trim();
          }
        },
      });

      const usage = normalizeGeminiUsage(stats);
      const estimatedCost = this.priceFetcher.estimateUsageCost({
        backendId: this.backendId,
        modelId,
        usage,
        fallbackModel: findRegisteredModel(this.backendId, modelId),
      });
      const cost = withDurationMs(
        {
          tokensInput: usage.inputTokens,
          tokensOutput: usage.outputTokens,
          cacheCreationTokens: usage.cacheCreationInputTokens,
          cacheReadTokens: usage.cacheReadInputTokens,
          costUsd: estimatedCost.costUsd,
          durationMs: 0,
          numTurns: assistantTurns,
        },
        startMs,
      );

      // §8.3 per-turn counter — increment once per assistant message
      // observed (turn-level approximation matching Google's billing
      // surface).
      for (let i = 0; i < assistantTurns; i++) {
        this.incrementRequestsCount(today);
      }

      if (policyViolationTool) {
        return {
          ok: false,
          errorClass: "policy_violation",
          message: `subprocess attempted to call '${policyViolationTool}' which is outside the per-task allowlist`,
          cost,
          trace,
          writeClassToolFired,
        };
      }
      if (loopAborted) {
        return {
          ok: false,
          errorClass: "loop_aborted",
          message: `subprocess exceeded maxToolCalls=${maxToolCalls}`,
          cost,
          trace,
          writeClassToolFired,
        };
      }
      if (abortSignal?.aborted) {
        const errorClass = classifyAbortReason(abortSignal.reason);
        return {
          ok: false,
          errorClass,
          message:
            errorClass === "timeout"
              ? "delegated task timed out (wall-clock)"
              : "delegated task cancelled by caller",
          cost,
          trace,
          writeClassToolFired,
        };
      }
      if (runResult.timedOut) {
        return {
          ok: false,
          errorClass: "timeout",
          message: "gemini subprocess exceeded local safety-net timeout",
          cost,
          trace,
          writeClassToolFired,
        };
      }

      const finalText = finalAssistantMessage.trim().length > 0
        ? finalAssistantMessage.trim()
        : assistantDelta.trim();
      if (finalText.length === 0) {
        const failure = lastError;
        if (failure && /unauthorized|forbidden|api key|login|auth/i.test(failure)) {
          return {
            ok: false,
            errorClass: "auth_error",
            message: failure,
            cost,
            trace,
            writeClassToolFired,
          };
        }
        return {
          ok: false,
          errorClass: "parse_error",
          message:
            failure
            ?? `gemini emitted no final assistant message (resultStatus=${resultStatus ?? "unknown"})`,
          cost,
          trace,
          writeClassToolFired,
        };
      }

      return {
        ok: true,
        rawAssistantText: finalText,
        cost,
        trace,
        writeClassToolFired,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const cost = withDurationMs(emptyCost(), startMs);
      if (abortSignal?.aborted || aborter.signal.aborted) {
        return {
          ok: false,
          errorClass: classifyAbortReason(
            abortSignal?.reason ?? aborter.signal.reason,
          ),
          message,
          cost,
          trace,
          writeClassToolFired,
        };
      }
      return {
        ok: false,
        errorClass: "subprocess_crashed",
        message,
        cost,
        trace,
        writeClassToolFired,
      };
    } finally {
      // See runDelegatedTool — invoker owns the dir, but the readToken scope
      // matches the dir path and must not outlive the run.
      this.readTokenManager?.revoke(sessionDir);
      if (abortSignal) {
        abortSignal.removeEventListener("abort", callerListener);
      }
    }
  }

  /**
   * DELEGATED-TASK-MODE-DESIGN.md §9.3 — task-mode admin policy. Tightly
   * scoped: catch-all deny at priority 1, per-task allow rules at 920,
   * destructive denies at 998, absolute-block at 999. No shell or file
   * allows — the task subprocess only needs MCP tool calls.
   */
  private generateTaskModePolicy(args: {
    allowedTools: readonly string[];
    /** Already filtered: empty when allowDestructive=true. */
    destructiveTools: readonly string[];
  }): string {
    const parts: string[] = [];
    parts.push(
      `# ${APP_NAME} task-mode admin policy (auto-generated)`,
      "# DELEGATED-TASK-MODE-DESIGN.md §9.3",
      "",
      "# Catch-all deny",
      "[[rule]]",
      'toolName = "*"',
      'decision = "deny"',
      'denyMessage = "Tool not in the per-task allowlist."',
      "priority = 1",
      "",
    );
    if (args.destructiveTools.length > 0) {
      parts.push(
        "# Destructive tools — denied at priority 998 (allowDestructive=false)",
      );
      for (const tool of args.destructiveTools) {
        parts.push(
          "[[rule]]",
          `toolName = ${JSON.stringify(tool)}`,
          'decision = "deny"',
          'denyMessage = "Destructive tool denied — caller did not pass allowDestructive=true."',
          "priority = 998",
          "",
        );
      }
    }
    if (args.allowedTools.length > 0) {
      parts.push("# Per-task allowed tools (priority 920)");
      for (const tool of args.allowedTools) {
        parts.push(
          "[[rule]]",
          `toolName = ${JSON.stringify(tool)}`,
          'decision = "allow"',
          "priority = 920",
          "",
        );
      }
    }
    parts.push(this.buildAbsoluteBlockRules());
    return parts.join("\n");
  }
}

/**
 * Gemini-specific pre-auth classifier for `classifyCliFailure`. Policy-deny
 * classification must run BEFORE the auth branch — the generated TOML's deny
 * messages can legitimately contain words like "required" or "login" (e.g. a
 * future "<X> login is not permitted in daemon mode" rule), and we don't want
 * those to mis-tag as `auth` and trigger an auth-recovery flow when the real
 * cause is the agent attempting a forbidden tool call. The match targets the
 * wrap the Gemini CLI emits today for TOML deny hits — `Error executing tool
 * …: Tool execution denied by policy. <denyMessage>`. Tight enough to avoid
 * false positives on real auth/quota messages; not claimed to be exhaustive
 * across other Gemini policy surfaces (sandbox kills, MCP allowlist, future
 * hook variants), which can be added here as they're observed in the wild.
 */
function classifyGeminiPolicyDeny(
  message: string,
  backendId: BackendId,
): BackendDecisiveFailure | null {
  if (/tool execution denied|denied by policy/i.test(message)) {
    return new BackendDecisiveFailure(backendId, "policy_denied", new Error(message));
  }
  return null;
}

function normalizeGeminiUsage(stats: GeminiStats | null): BackendUsage {
  if (!stats) {
    return { ...EMPTY_USAGE };
  }

  const totalInputTokens = readNumber(stats.input_tokens);
  const cacheReadInputTokens = readNumber(stats.cached);

  return {
    inputTokens: nonCachedInputTokens(totalInputTokens, cacheReadInputTokens),
    outputTokens: readNumber(stats.output_tokens),
    cacheCreationInputTokens: 0,
    cacheReadInputTokens,
  };
}

function buildGeminiModelUsage(
  priceFetcher: PriceFetcher,
  stats: GeminiStats | null,
): {
  modelUsage: AgentResult["modelUsage"];
  costSource: "litellm" | "hardcoded";
} {
  if (!stats?.models) {
    return { modelUsage: {}, costSource: "hardcoded" };
  }

  const usage: AgentResult["modelUsage"] = {};
  let allFromLitellm = true;
  for (const [modelId, modelStats] of Object.entries(stats.models)) {
    const cacheReadInputTokens = readNumber(modelStats.cached);
    const normalized: BackendUsage = {
      inputTokens: nonCachedInputTokens(
        readNumber(modelStats.input_tokens),
        cacheReadInputTokens,
      ),
      outputTokens: readNumber(modelStats.output_tokens),
      cacheCreationInputTokens: 0,
      cacheReadInputTokens,
    };
    const priceEstimate = priceFetcher.estimateUsageCost({
      backendId: "gemini",
      modelId,
      usage: normalized,
      fallbackModel: findRegisteredModel("gemini", modelId),
    });

    usage[modelId] = {
      inputTokens: normalized.inputTokens,
      outputTokens: normalized.outputTokens,
      costUsd: priceEstimate.costUsd,
    };
    if (priceEstimate.costSource !== "litellm") {
      allFromLitellm = false;
    }
  }
  return {
    modelUsage: usage,
    costSource: allFromLitellm ? "litellm" : "hardcoded",
  };
}

function nonCachedInputTokens(
  totalInputTokens: number,
  cacheReadInputTokens: number,
  cacheCreationInputTokens = 0,
): number {
  return Math.max(totalInputTokens - cacheReadInputTokens - cacheCreationInputTokens, 0);
}

function resolveActualGeminiModel(
  requestedModel: string,
  modelUsage: AgentResult["modelUsage"],
): string {
  const [firstModel] = Object.keys(modelUsage);
  return firstModel ?? requestedModel;
}

function isLikelyGeminiFailure(line: string): boolean {
  return /error|failed|authentication|oauth|api key|quota|rate limit/i.test(line);
}

/**
 * Detect Gemini CLI's "tool name not in registry" tool_result error pattern.
 *
 * Format produced by `getToolSuggestion` in @google/gemini-cli (verified
 * 2026-05-04 against bundle 0.40.1):
 *   `Tool "<name>" not found. Did you mean one of: "<a>", "<b>"?`  (≥2 hits)
 *   `Tool "<name>" not found. Did you mean "<a>"?`                  (1 hit)
 *
 * The expected `toolName` is included in the literal because we want to
 * avoid false positives — a connector tool that itself happens to emit a
 * "not found" message about some upstream resource (e.g. a Notion page
 * not_found error) should NOT be reclassified as transient.
 */
export function isToolNotRegisteredError(
  output: string,
  expectedToolName: string,
): boolean {
  if (typeof output !== "string" || output.length === 0) return false;
  const escapedName = expectedToolName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `^Tool "${escapedName}" not found\\. Did you mean`,
  ).test(output);
}

function firstFailureLine(lines: string[]): string | null {
  const line = lines.find((candidate) => isLikelyGeminiFailure(candidate));
  return line?.trim() ?? null;
}

function readNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * Parse `PA_GEMINI_OAUTH_GRACE_HOURS`. Returns `fallback` for undefined
 * or malformed values; a parseable 0 disables the grace entirely (the
 * intended escape hatch once the upstream CLI bug is fixed).
 */
function parseGraceHours(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return n;
}

/**
 * Append `@<relativePath>` tokens for every staged attachment to the tail
 * of the Gemini prompt. Gemini CLI v0.37+ expands these in non-interactive
 * mode by reading the file bytes and inlining them as multimodal content.
 *
 * The bracketed `[Attached files]` text block composed by the dispatcher
 * still describes what each file is; this helper only adds the
 * machine-readable `@`-tokens the CLI looks for. Kept on a single trailing
 * line so prompt hashing / diff comparisons remain stable when the list is
 * empty.
 *
 * Pure — exported for unit testing.
 */
export function appendGeminiAttachmentTokens(
  prompt: string,
  staged: StagedAttachment[] | undefined,
): string {
  if (!staged || staged.length === 0) return prompt;
  const tokens = staged.map((att) => `@${att.relativePath}`).join(" ");
  return `${prompt}\n\n${tokens}`;
}

/**
 * Read a Gemini config file (extension manifest or settings.json) and
 * collect every key under `mcpServers`. Tolerant of missing keys, malformed
 * JSON, and non-object payloads — best-effort host scan, not validation.
 *
 * Exported for unit testing.
 */
export function collectMcpServerNames(
  filePath: string,
  out: Set<string>,
): void {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch {
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
  const mcpServers = (parsed as { mcpServers?: unknown }).mcpServers;
  // typeof null === "object" and typeof [] === "object" — guard both. A
  // user who hand-edited settings.json with `mcpServers: [{...}]` (array
  // instead of dict) would otherwise have `Object.keys` return numeric
  // index strings ("0", "1") that get added as bogus server names.
  if (
    !mcpServers
    || typeof mcpServers !== "object"
    || Array.isArray(mcpServers)
  ) {
    return;
  }
  for (const name of Object.keys(mcpServers)) {
    out.add(name);
  }
}

/**
 * Extract the MCP server name from a Gemini-convention `toolNamespace`.
 * Gemini's MCP namespace is `mcp_<server>_<rest>`, so the server name is
 * everything between the first `_` and the second `_` after the `mcp_`
 * prefix. Returns null if the namespace is not Gemini-shaped.
 *
 * Examples:
 *   `mcp_google-workspace_gmail.` → `google-workspace`
 *   `mcp_notion_`                 → `notion`
 *   `mcp__claude_ai_Gmail__`      → null  (Claude double-underscore form)
 *
 * Exported for unit testing.
 */
export function extractGeminiServerName(toolNamespace: string): string | null {
  if (!toolNamespace.startsWith("mcp_")) return null;
  // Reject Claude / Codex double-underscore namespaces — they begin with
  // `mcp__` which also starts with `mcp_`. Single-underscore is the
  // distinguishing trait of Gemini's convention.
  if (toolNamespace.startsWith("mcp__")) return null;
  const rest = toolNamespace.slice("mcp_".length);
  const sep = rest.indexOf("_");
  if (sep === -1) return rest.length > 0 ? rest : null;
  return sep === 0 ? null : rest.slice(0, sep);
}
