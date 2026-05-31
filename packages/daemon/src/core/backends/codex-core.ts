import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  INTEGRATION_DESCRIPTORS,
  INTEGRATION_KEYS,
  isAutonomousProcessKey,
  isMessageEvent,
  isPlausibleOpenAiApiKey,
  matchRunAllowedToolPattern,
  type AgentResult,
  type BackendModel,
  type BackendUsage,
  type ProcessKey,
} from "@aitne/shared";
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
import { DELEGATED_PROXY_DEFAULTS } from "../../services/delegated-proxy-config.js";
import {
  buildDelegatedToolPrompt,
  emptyCost,
  flattenToolResultContent,
  tryParseToolResult,
  withDurationMs,
} from "../../services/delegated-tool-runtime.js";
import { materializeMcpForSession } from "../../services/mcp/session-materializer.js";
import { parseMcpToolName } from "../../services/mcp/risk.js";
import { logMcpToolCall } from "../../services/mcp/tool-audit.js";
import { buildDaemonApiCliEnv } from "../daemon-api-cli.js";
import {
  noteNativeSkillToolIfPresent,
  probeCliNativeSkillSubcommand,
} from "./native-skill-discovery-probe.js";
import {
  createOutputCapturePath,
  CliPathCache,
  parseJsonLine,
  readFileIfExists,
  removeFileIfExists,
  runLineCommand,
} from "./cli-utils.js";
import { probeApiKeyServerSide } from "./api-key-probe.js";
import { extractGenericQuotaResetHint } from "./quota-reset-hints.js";
import {
  auditStreamObservation,
  extractCodexShellCall,
} from "../../safety/subprocess-block-scanner.js";
import {
  extractSilentApiErrors,
  logSilentApiErrors,
} from "./silent-api-error-detector.js";
import {
  estimateTextInputTokens,
  findRegisteredModel,
  getModelsForBackend,
  latestLiteFor,
} from "./model-registry.js";
import { PriceFetcher } from "./price-fetcher.js";
import { buildExecutionPrompt, buildSummaryPrompt } from "./prompt-utils.js";
import { createLogger } from "../../logging.js";

const logger = createLogger("codex-core");

const EMPTY_USAGE: BackendUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
};

/**
 * Per-event stream-idle threshold for reactive `runTurn` execution
 * (DMs, routines, scheduled tasks). Distinct from the delegated-path
 * `DELEGATED_PROXY_DEFAULTS.idleTimeoutMsByBackend.codex` (60s) because
 * reactive turns can include longer silences during legitimate work —
 * extended thinking, MCP cold-starts, server-side tools (`web_search`,
 * file reads). The threshold catches a fully hung CLI subprocess (zero
 * stream events) well before `executeTimeoutMinutes` (default 30 min)
 * fires; healthy turns rarely go 5 min silent end-to-end.
 *
 * The delegated path already had this guard (see the `runDelegatedTool`
 * wiring lower in this file); the reactive path needs it explicitly
 * because a single hung subprocess can pin a session for the full
 * executeTimeoutMinutes wall-clock, blocking morning-routine / hourly-check
 * dispatch downstream.
 */
const REACTIVE_IDLE_TIMEOUT_MS = 5 * 60 * 1000;

// Probe prompt is derived from `INTEGRATION_DESCRIPTORS.backendConnectors.codex`
// so adding a new delegated integration (Slack, GitHub, …) requires only the
// registry update. The line-based filter below (`l.startsWith("mcp__")`) is
// permissive enough to accept any namespace the registry declares; the prompt
// is what actually drives ToolSearch to enumerate them. See
// `docs/design/17-delegated-mode-v2.md` §7.1.
export const CODEX_PROBE_TOOLS_PROMPT = ((): string => {
  interface ConnectorMeta {
    displayName: string;
    toolNamespace: string;
    requiredCapabilities: readonly string[];
    capabilityToolNames: readonly string[];
  }
  const meta: ConnectorMeta[] = [];
  for (const key of INTEGRATION_KEYS) {
    const descriptor = INTEGRATION_DESCRIPTORS[key];
    const connector = descriptor.backendConnectors.codex;
    if (!connector) continue;
    const seen = new Set<string>();
    for (const tools of Object.values(connector.capabilityTools)) {
      for (const t of tools) seen.add(t);
    }
    meta.push({
      displayName: descriptor.displayName,
      toolNamespace: connector.toolNamespace,
      requiredCapabilities: connector.requiredCapabilities,
      capabilityToolNames: Array.from(seen),
    });
  }

  const prefixes = meta.map((m) => `'${m.toolNamespace}'`).join(", ");
  const lines: string[] = [];
  const queries = meta.map((m) => {
    // Same semantic query approach as the Claude probe — display name +
    // requiredCapabilities expanded to word tokens. Avoids the
    // bag-of-fragments dilution that all-tool-name splitting causes.
    const queryWords = [
      m.displayName,
      ...m.requiredCapabilities.flatMap((c) => c.split(/[-_]/)),
      "connector tools",
    ]
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    return `'${queryWords}'`;
  });
  lines.push(
    `Use \`tool_search\` for each of these queries with the highest result limit available: ${queries.join("; ")}.`,
  );
  lines.push("Do not call any of the searched tools.");
  lines.push(
    `After the searches, print only full tool names from the search results that start with one of: ${prefixes}.`,
  );
  for (const m of meta) {
    if (m.capabilityToolNames.length === 0) continue;
    const fullNames = m.capabilityToolNames
      .map((n) => m.toolNamespace + n)
      .join(", ");
    lines.push(
      `Include these ${m.displayName} tools if present: ${fullNames}.`,
    );
  }
  lines.push(
    "One tool name per line. No markdown fences. No explanation. If no such tools are available, print NONE.",
  );
  return lines.join(" ");
})();

interface CodexEvent {
  type?: string;
  thread_id?: string;
  model?: string;
  usage?: Record<string, unknown>;
  delta?: unknown;
  text?: unknown;
  message?: string;
  error?: { message?: string };
  output_text?: string;
  item?: Record<string, unknown>;
  output?: unknown;
  reason?: string;
  stop_reason?: string;
}

export class CodexCore implements IAgentCore {
  readonly backendId = "codex" as const;
  // Lazily re-resolved with a 60 s TTL — see ClaudeCodeCore for rationale (§9.4).
  private readonly cliPathCache: CliPathCache;
  /** Legacy shared read token injected into the Codex subprocess env. */
  private readToken: string | undefined;
  /** Scoped token manager preferred over the legacy shared read token. */
  private readTokenManager: ReadSensitiveTokenManager | undefined;

  private get cliPath(): string | null {
    return this.cliPathCache.get();
  }

  constructor(
    private readonly config: AgentConfig,
    private readonly priceFetcher = new PriceFetcher(config.dataDir),
  ) {
    this.cliPathCache = new CliPathCache("codex");
  }

  /** Set the per-daemon-boot read token for subprocess-local daemon API auth. */
  setReadToken(token: string): void {
    this.readToken = token;
  }

  setReadTokenManager(manager: ReadSensitiveTokenManager): void {
    this.readTokenManager = manager;
  }

  /** Resolve the env-injected read token: per-scope token if a manager is wired,
   *  otherwise the legacy shared token. Returns `undefined` when neither is set
   *  (production wires both at startup via index.ts; tests typically wire neither).
   */
  private issueReadToken(scope: string): string | undefined {
    return this.readTokenManager?.issue(scope) ?? this.readToken;
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
    const allowMode = this.config.codexExecutionPermissionMode === "allow";
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
    // ─── Two web-access flags, two different mechanisms ──────────────────
    //
    // `webSearchEnabled` (THREADED, see runTurn → buildArgs):
    //   OpenAI Responses-API `web_search` tool, toggled per-spawn via
    //   `-c tools.web_search=true`. Runs server-side at OpenAI, NOT as a
    //   local shell command, so it is independent of the sandbox posture.
    //   Surfaced via `WEB_SEARCH_CAPABLE_BACKENDS` + `backends.web_search_enabled`.
    //
    // `wikiUrlFetchEnabled` (NO-OP for Codex, see WIKI_BUILDER_DESIGN.md §4.3):
    //   Per-execute widening for wiki URL ingestion (external curl). Strict-
    //   mode Codex already ships with `sandbox_workspace_write.network_access=true`
    //   (see the comment block at the top of `buildArgs`), so external URL
    //   fetch works out of the box without dropping any guard. Threading
    //   the flag deeper would be dead plumbing — and inviting an accidental
    //   "force allow mode" bug later that drops the workspace-write
    //   file-write protection.
    const wikiWorkspaceName =
      typeof params.event.data?.workspace === "string"
        ? params.event.data.workspace
        : undefined;
    return await this.runTurn(
      {
        prompt: buildExecutionPrompt(
          params.prompt,
          params.context,
          params.event,
          params.conversationHistory,
        ),
        modelId: params.modelId,
        eventType: params.event.type,
        processKey: params.processKey,
        ...(wikiWorkspaceName ? { wikiWorkspaceName } : {}),
        sessionDir: params.sessionDir,
        maxBudgetUsd: params.maxBudgetUsd,
        persistSession: params.persistSession ?? false,
        turnToken: params.turnToken,
        stagedAttachments: params.stagedAttachments,
        sessionDbId: params.sessionDbId,
        eventCorrelationId: params.event.correlationId,
        webSearchEnabled: params.webSearchEnabled ?? false,
        ...(isMessageEvent(params.event) ? { messageText: params.event.content } : {}),
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
        prompt: params.message,
        modelId: params.modelId,
        eventType: "message.received",
        sessionDir: params.sessionDir,
        resumeSessionId: params.sessionId,
        maxBudgetUsd: params.maxBudgetUsd,
        persistSession: true,
        turnToken: params.turnToken,
        stagedAttachments: params.stagedAttachments,
        sessionDbId: params.sessionDbId,
        eventCorrelationId: params.eventCorrelationId,
        webSearchEnabled: params.webSearchEnabled ?? false,
        // Resume turns carry the user's reply text in `params.message`;
        // forward it as the predicate's messageText signal.
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
      persistSession: false,
    });
    return result.output;
  }

  async checkAuth(): Promise<
    | { ok: true; method: "cli_login" | "api_key" | "oauth" | "vertex" }
    | { ok: false; reason: string }
  > {
    if (!this.cliPath) {
      return { ok: false, reason: "Codex CLI is not installed or not on PATH." };
    }
    const rawApiKey = process.env.OPENAI_API_KEY?.trim();
    if (rawApiKey) {
      if (!isPlausibleOpenAiApiKey(rawApiKey)) {
        return {
          ok: false,
          reason: "OPENAI_API_KEY is set but does not look like an OpenAI key (expected `sk-…`).",
        };
      }
      return { ok: true, method: "api_key" };
    }
    if (existsSync(join(homedir(), ".codex", "auth.json"))) {
      return { ok: true, method: "oauth" };
    }
    return {
      ok: false,
      reason: "Codex is not authenticated. Run `codex login` or set OPENAI_API_KEY.",
    };
  }

  /**
   * Detailed auth probe. Two modes:
   *  - **API key** (`OPENAI_API_KEY`): format check + server-side probe via
   *    `probeApiKeyServerSide("openai", ...)` (roadmap §9.1). Throws on
   *    network/timeout so `checkAll()` records `probe_network_error`.
   *  - **OAuth** (`codex login`): relies on `codex login status` exit code —
   *    Phase 0 confirmed that `auth.json.last_refresh` age is not a
   *    trustworthy staleness signal (CLI returns exit 0 even after 10+ days).
   */
  async checkAuthDetailed(): Promise<AuthCheckResult> {
    if (!this.cliPath) {
      return {
        ok: false,
        status: "missing",
        method: "cli_login",
        detail: "Codex CLI not found on PATH",
        recoveryCommand: "npm install -g @openai/codex",
      };
    }
    const rawApiKey = process.env.OPENAI_API_KEY?.trim();
    if (rawApiKey) {
      if (!isPlausibleOpenAiApiKey(rawApiKey)) {
        return {
          ok: false,
          status: "expired",
          method: "api_key",
          detail: "OPENAI_API_KEY does not match OpenAI key format (expected `sk-…`).",
          recoveryCommand: "Unset OPENAI_API_KEY or replace it with a valid OpenAI API key",
        };
      }
      // Format is plausible — attempt a server-side probe to detect
      // revoked keys within 1 hourly cycle (roadmap §9.1).
      const probe = await probeApiKeyServerSide("openai", rawApiKey);
      return {
        ok: probe.ok,
        status: probe.ok ? "ok" : "expired",
        method: "api_key",
        detail: probe.detail,
        ...(!probe.ok && {
          recoveryCommand: "Unset OPENAI_API_KEY or replace it with a valid OpenAI API key",
        }),
      };
    }

    try {
      const result = await runLineCommand({
        command: this.cliPath,
        args: ["login", "status"],
        cwd: process.cwd(),
        timeoutMs: 10_000,
      });
      if (result.exitCode === 0) {
        return { ok: true, status: "ok", method: "oauth" };
      }
      return {
        ok: false,
        status: "expired",
        method: "oauth",
        detail: "Codex login status reported failure",
        recoveryCommand: "codex login",
      };
    } catch (err) {
      logger.warn({ err }, "codex login status probe failed");
      return {
        ok: false,
        status: "expired",
        method: "oauth",
        detail: err instanceof Error ? err.message : "Codex login status failed",
        recoveryCommand: "codex login",
      };
    }
  }

  listModels(): ReadonlyArray<BackendModel> {
    return getModelsForBackend(this.backendId);
  }

  /**
   * Phase 5 §4.11 live probe. Codex doesn't expose a zero-turn tool
   * manifest, so we prompt the agent to discover and print connector tool
   * names. Codex apps are lazy-loaded behind `tool_search` on current CLI
   * builds, so the prompt explicitly opens that catalog before printing
   * `mcp__...` names. The output is plain-text (one per line), one
   * minimum-tokens turn.
   *
   * Tools whose names don't start with `mcp__` (built-ins like `Bash`,
   * `Read`) are out of scope — probes are only used to evaluate
   * connector-namespaced tools via `evaluateProbe`.
   */
  async probeTools(): Promise<string[]> {
    if (!this.cliPath) {
      throw new Error("Codex CLI is not installed or not on PATH");
    }

    const sessionDir = createSessionWorkdir(
      this.config.workspaceDir,
      "message.received",
      undefined,
      { backendId: this.backendId, character: this.config.character },
    );
    const outputPath = createOutputCapturePath(sessionDir, "probe");
    const prompt = CODEX_PROBE_TOOLS_PROMPT;
    const modelId = this.pickSummaryModel();
    const args = [
      "exec",
      "--json",
      "--color",
      "never",
      "--dangerously-bypass-approvals-and-sandbox",
      "--skip-git-repo-check",
      "--output-last-message",
      outputPath,
      "--model",
      modelId,
      "--ephemeral",
      prompt,
    ];

    const lines: string[] = [];
    const daemonReadToken = this.issueReadToken(sessionDir);
    try {
      const result = await runLineCommand({
        command: this.cliPath,
        args,
        cwd: sessionDir,
        env: buildDaemonApiCliEnv(sessionDir, this.config.apiPort, {
          ...(daemonReadToken ? { readToken: daemonReadToken } : {}),
          sessionBackend: "codex",
        }),
        timeoutMs: 60_000,
        onStdoutLine: (line) => {
          const event = parseJsonLine<CodexEvent>(line);
          if (!event) return;
          const text = extractCodexText(event);
          if (text) lines.push(...text.split(/\r?\n/));
        },
      });
      if (result.exitCode !== 0 && result.exitCode !== null) {
        throw new Error(
          `codex exec exited with code ${result.exitCode}: ${result.stderrLines.slice(-3).join(" | ")}`,
        );
      }

      const finalMessage = readFileIfExists(outputPath);
      const combined = [
        ...lines,
        ...(finalMessage ? finalMessage.split(/\r?\n/) : []),
      ];
      const tools = combined
        .map((l) => l.trim())
        .filter((l) => l.startsWith("mcp__"));
      const deduped = Array.from(new Set(tools));
      logger.info(
        { toolCount: deduped.length },
        "Live probe collected tool manifest via codex exec",
      );
      // docs/design/appendices/skills-unification.md Phase 1 item 13 — forward-compat
      // signals. Two probes run side by side:
      //   - Name-pattern scan over `deduped` (mcp__-filtered). Cheap
      //     defence-in-depth; will not fire on a non-MCP native surface
      //     but is harmless when present.
      //   - `codex --help` scan for a top-level `skill`/`skills`
      //     subcommand. This is the ground-truth detector — Codex's
      //     hypothetical future form (`codex skill <command>`) trips
      //     here regardless of how its tool inventory is shaped.
      noteNativeSkillToolIfPresent("codex", deduped);
      void probeCliNativeSkillSubcommand(this.cliPath, "codex");
      return deduped;
    } finally {
      this.readTokenManager?.revoke(sessionDir);
      removeFileIfExists(outputPath);
      cleanupSessionWorkdir(sessionDir);
    }
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
      maxBudgetUsd?: number;
      persistSession: boolean;
      turnToken?: string;
      stagedAttachments?: StagedAttachment[];
      sessionDbId?: number;
      /** See AgentResumeParams.eventCorrelationId — forwarded to the shim env. */
      eventCorrelationId?: string;
      /**
       * When true, adds `-c tools.web_search=true` to the codex argv so the
       * agent can call OpenAI's Responses-API `web_search` tool. The tool
       * runs server-side at OpenAI, so it works under the workspace-write
       * sandbox without dropping any local guard.
       */
      webSearchEnabled?: boolean;
      /**
       * docs/design/appendices/skills-unification.md Phase 4 — inbound message text forwarded
       * to `createSessionWorkdir` so the `gmail-lifestyle` /
       * `managed-tasks` *ForDm trigger-phrase fallbacks can run when the
       * fallback `createSessionWorkdir` path fires (lite-tier non-DM and
       * non-persistent sessions). Undefined for `summarize` / non-message
       * dispatches.
       */
      messageText?: string | null;
    },
    streamCallbacks?: StreamCallbacks,
  ): Promise<AgentResult> {
    // Pre-flight auth gate — ClaudeCodeCore does NOT have this because
    // the Agent SDK's first HTTP round-trip returns a decisive 401 on
    // its own, so a Claude pre-flight would double-read credentials
    // for no benefit. For Codex we're about to spawn a CLI subprocess
    // (costly TTFB), so it is cheaper to read credentials once here
    // and surface `BackendDecisiveFailure("auth")` before the subprocess
    // even boots. See the class-level comment on `ClaudeCodeCore` for
    // the full rationale and `IAgentCore.checkAuth` for the contract.
    const auth = await this.checkAuth();
    if (!auth.ok) {
      logger.warn({ reason: auth.reason }, "Codex auth check failed");
      throw new BackendDecisiveFailure(
        this.backendId,
        "auth",
        new Error(auth.reason),
      );
    }
    // checkAuth() returns {ok:false} when cliPath is null, so reaching here
    // proves it is a resolved absolute path. Pin it to a local const — TS
    // cannot narrow `this.cliPath` (a getter) through the await above, and
    // we avoid a non-null assertion. Used as the spawn `command` below.
    const cliPath: string = this.cliPath as string;
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
        // docs/design/appendices/skills-unification.md Phase 4 — feed the conditional
        // manifest predicates. `db` is the same handle threaded through
        // `setMcpContext`; `messageText` is the inbound DM text (resume
        // turns send the user's reply, fresh executes send the original
        // event content). Both fields are optional — a `summarize` /
        // probe path without either still resolves to the conservative
        // include branch.
        ...(this.mcpContext?.db ? { db: this.mcpContext.db } : {}),
        ...(typeof params.messageText === "string" ? { messageText: params.messageText } : {}),
        ...(params.wikiWorkspaceName ? { wikiWorkspaceName: params.wikiWorkspaceName } : {}),
      },
    );
    const ownsSessionDir = !params.sessionDir;
    const outputPath = createOutputCapturePath(sessionDir, "codex-last-message");
    const daemonReadToken = this.issueReadToken(sessionDir);

    const mcp = await this.materializeMcp(sessionDir, params.processKey);

    logger.info(
      { eventType: params.eventType, model: params.modelId, promptLen: params.prompt.length, mcpServers: mcp.servers.map((s) => s.id) },
      "Codex execute started",
    );

    // Stream text deltas live as they arrive — mirrors ClaudeCodeCore so
    // owner-facing surfaces (dashboard chat, owner DM) get the same
    // incremental-output UX regardless of which backend serves the turn.
    // The post-completion `assertWithinMaxBudget` still enforces the budget
    // cap; an exceeded turn surfaces as `BackendQuotaError` AFTER text has
    // streamed, exactly as Claude behaves. The earlier "defer until budget
    // check" guard buffered the entire turn — which made interactive flows
    // like `setup.initial` look frozen for minutes when the model finally
    // returned a single multi-block response in one chunk.
    let streamed = false;

    // Reactive idle watchdog. Declared outside the outer try so the
    // outer finally below can always call stop() — even if a setup line
    // between here and runLineCommand throws. Mirrors the delegated-path
    // wiring in `runDelegatedTool`: each
    // arrived stream event resets the timer, and when the gap exceeds
    // REACTIVE_IDLE_TIMEOUT_MS the aborter fires — runLineCommand reaps
    // the subprocess via its existing kill-tree path. Distinct from
    // `runResult.timedOut` so the post-await classifier surfaces idle
    // hangs with a distinct message.
    let idleTimedOut = false;
    const idleAborter = new AbortController();
    const idleWatchdog = new IdleWatchdog({
      idleTimeoutMs: REACTIVE_IDLE_TIMEOUT_MS,
      onTimeout: (idleMs) => {
        idleTimedOut = true;
        logger.warn(
          { idleMs, idleTimeoutMs: REACTIVE_IDLE_TIMEOUT_MS, eventType: params.eventType },
          "codex reactive idle watchdog tripped — aborting",
        );
        idleAborter.abort(
          new Error(
            `codex reactive stream idle for ${idleMs}ms (limit ${REACTIVE_IDLE_TIMEOUT_MS}ms)`,
          ),
        );
      },
    });

    try {
      let sessionId: string | null = params.resumeSessionId ?? null;
      let actualModelId = params.modelId;
      let usage: BackendUsage = { ...EMPTY_USAGE };
      let lastError: string | null = null;
      let sawCompletion = false;
      let numTurns = 0;
      let stopReason: string | null = null;
      const outputChunks: string[] = [];
      // Accumulate every scrap of subprocess text (tool-output item fields +
      // raw stderr lines) so we can scan once for `PA_API_ERROR` markers after
      // the run. Collecting up front — rather than scanning per-line — keeps
      // each occurrence logged exactly once across multi-line payloads.
      const apiOutputBuffer: string[] = [];
      // Per-turn set of item IDs whose `item.started` / `item.completed`
      // declared a reasoning type. Used to filter follow-on `item.updated`
      // deltas, which usually omit the type and carry only `id + delta`
      // — `shouldDropAsReasoning` consults this on every event.
      const reasoningItemIds = new Set<string>();
      // Per-turn flag tripped whenever any event is dropped by the
      // reasoning gate. The `--output-last-message` file written by
      // codex CLI is NOT covered by the stream-level filter — when
      // reasoning was observed but the stream produced no final
      // assistant text, the file may itself contain a reasoning
      // summary (codex CLI's GPT-5 behavior under tool-only turns
      // and certain Responses-API relay shapes). Consulting this
      // flag below makes the file-fallback path refuse such content
      // instead of writing it verbatim to the chat bubble / DB.
      let observedReasoning = false;

      idleWatchdog.start();
      const runResult = await runLineCommand({
        // Resolved absolute CLI path, not a bare name — on Windows with
        // shell:false, spawn does no PATHEXT resolution, so a bare "codex"
        // would never match an npm `codex.cmd` or native `codex.exe`. The
        // checkAuth() pre-flight above guarantees cliPath is non-null
        // (checkAuth returns {ok:false} when it is, and the gate throws).
        // Matches the delegated/probe sibling call sites.
        command: cliPath,
        args: this.buildArgs(params, outputPath),
        cwd: sessionDir,
        env: {
          ...buildDaemonApiCliEnv(sessionDir, this.config.apiPort, {
            ...(daemonReadToken ? { readToken: daemonReadToken } : {}),
            sessionBackend: "codex",
            sessionId: params.sessionDbId,
            eventCorrelationId: params.eventCorrelationId,
          }),
          ...mcp.env,
          ...(params.turnToken ? { PA_TURN_TOKEN: params.turnToken } : {}),
        },
        timeoutMs: this.config.executeTimeoutMinutes * 60 * 1000,
        abortSignal: idleAborter.signal,
        onStdoutLine: (line) => {
          idleWatchdog.beat();
          const event = parseJsonLine<CodexEvent>(line);
          if (!event?.type) {
            return;
          }

          if (event.type === "thread.started" && typeof event.thread_id === "string") {
            sessionId = event.thread_id;
            return;
          }

          if (event.type === "turn.started") {
            numTurns += 1;
            return;
          }

          if (event.type === "turn.completed") {
            sawCompletion = true;
            usage = extractCodexUsage(event) ?? usage;
            actualModelId = event.model ?? actualModelId;
            stopReason = event.stop_reason ?? event.reason ?? stopReason;
            return;
          }

          if (event.type === "turn.failed") {
            lastError = event.error?.message ?? lastError;
            return;
          }

          if (event.type === "error") {
            const message = event.message?.trim();
            if (message && !message.startsWith("Reconnecting...")) {
              lastError = message;
            }
            return;
          }

          // Reasoning filter — must run BEFORE every text-bearing path
          // below (`extractCodexText`, `collectCodexItemText`, the tool
          // / shell-call audits). Two steps:
          //
          //  1. Record reasoning item IDs from any event that declares
          //     the item type (`item.started` and `item.completed` are
          //     the canonical carriers; `item.updated` typically omits
          //     it — that's why ID tracking is necessary, not optional).
          //  2. Drop the event entirely when it is reasoning by any
          //     signal: outer event type, declared item type, OR an
          //     `item.updated` delta whose `item.id` was previously
          //     recorded as reasoning.
          //
          // The two-step ordering matters: a single `item.completed`
          // with `{id, type: "reasoning", text: "..."}` must first
          // register the ID (so any straggling deltas for the same ID
          // are still filtered) and THEN be dropped.
          rememberReasoningItem(event, reasoningItemIds);
          if (shouldDropAsReasoning(event, reasoningItemIds)) {
            observedReasoning = true;
            return;
          }

          collectCodexItemText(event, apiOutputBuffer);

          // EXECUTION-MODE-DESIGN.md §6.3 — stream-side absolute-block
          // observability. Codex has no PreToolUse hook, so we classify
          // each shell-call item the moment it surfaces and write a
          // `blocked_absolute` audit row with `result='partial'` on a hit.
          // The actual rejection (if any) happens in the workspace-write
          // sandbox out-of-band; the row tells operators the agent
          // *attempted* an absolute-block-listed pattern.
          const codexShellCall = extractCodexShellCall(event.item);
          if (codexShellCall) {
            auditStreamObservation(codexShellCall, {
              db: this.mcpContext?.db,
              backend: this.backendId,
              mode: this.config.codexExecutionPermissionMode,
              sessionId: params.sessionDbId,
            });
          }

          // B-003 Phase 4.4 — persist MCP tool call to `mcp_tool_calls`.
          const mcpCall = extractMcpToolCall(event);
          if (mcpCall) {
            logger.debug(
              {
                serverId: mcpCall.serverId,
                toolName: mcpCall.toolName,
                sessionId,
                eventType: params.eventType,
              },
              "mcp.tool_call",
            );
            if (this.mcpContext?.db) {
              try {
                logMcpToolCall(this.mcpContext.db, {
                  serverId: mcpCall.serverId,
                  toolName: mcpCall.toolName,
                  eventType: params.eventType,
                  sessionId: sessionId ?? undefined,
                });
              } catch (err) {
                logger.warn({ err, serverId: mcpCall.serverId }, "mcp.tool_call audit insert failed");
              }
            }
          }

          const delta = extractCodexText(event);
          if (!delta) {
            return;
          }
          outputChunks.push(delta);
          streamCallbacks?.onText?.(delta);
          streamed = true;
        },
        onStderrLine: (line) => {
          idleWatchdog.beat();
          apiOutputBuffer.push(line);
          if (isLikelyCodexFailure(line)) {
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

      // Order matters: idle-trip is checked before wall-clock timeout so
      // the post-await classifier surfaces the precise reason. The
      // idle-aborter trips runResult.timedOut=false (an external abort
      // is reported via non-zero exit per cli-utils.ts contract), but
      // we still throw a `timeout` failure here because that matches
      // the dispatcher's retry semantics.
      if (idleTimedOut) {
        const err = new BackendDecisiveFailure(
          this.backendId,
          "timeout",
          new Error(
            `Codex reactive stream went idle for ${REACTIVE_IDLE_TIMEOUT_MS}ms (no events from CLI subprocess)`,
          ),
        );
        logger.error(
          { err, eventType: params.eventType, model: params.modelId, durationMs: Date.now() - startMs },
          "Codex execute idle-timed-out",
        );
        throw err;
      }

      if (runResult.timedOut) {
        const err = new BackendDecisiveFailure(
          this.backendId,
          "timeout",
          new Error(`Codex execution exceeded timeout of ${this.config.executeTimeoutMinutes} minutes`),
        );
        logger.error(
          { err, eventType: params.eventType, model: params.modelId, durationMs: Date.now() - startMs },
          "Codex execute timed out",
        );
        throw err;
      }

      const capturedOutput = readFileIfExists(outputPath);
      // File-vs-stream precedence — minimal change from the original.
      //
      // Original semantics (preserved): the `--output-last-message`
      // file is the authoritative final assistant text; the stream
      // chunks are the fallback. Codex CLI writes the file at turn
      // close after assembling the full agent_message, so it is more
      // resilient than chunk replay against mid-stream truncation or
      // transport hiccups.
      //
      // Safety amendment (new): when reasoning items appeared on the
      // wire during the turn, the file is untrustworthy. Codex's
      // GPT-5 path can write a reasoning summary to the same file
      // when no agent_message item was produced, and the
      // stream-level `shouldDropAsReasoning` gate cannot see that
      // path. Suppress the file in that case and fall back to the
      // (already filtered) stream chunks — which means an empty
      // bubble for reasoning-only turns, but never reasoning
      // narration surfacing as the assistant message.
      const streamJoined = outputChunks.join("");
      let outputSource: string;
      if (
        capturedOutput !== null
        && capturedOutput.trim().length > 0
        && !observedReasoning
      ) {
        outputSource = capturedOutput;
      } else {
        if (
          observedReasoning
          && capturedOutput !== null
          && capturedOutput.trim().length > 0
        ) {
          logger.warn(
            {
              eventType: params.eventType,
              sessionId,
              fileBytes: capturedOutput.trim().length,
              streamBytes: streamJoined.trim().length,
            },
            "Codex --output-last-message suppressed: reasoning was observed during the turn; the file may carry a reasoning summary instead of an agent_message. Falling back to filtered stream chunks.",
          );
        }
        outputSource = streamJoined;
      }
      const output = outputSource.trim();

      const combinedFailure = lastError
        ?? firstFailureLine(runResult.stderrLines)
        ?? firstFailureLine(runResult.stdoutLines);
      if (!sawCompletion || runResult.exitCode !== 0) {
        const failureMsg = combinedFailure ?? "Codex execution did not complete successfully.";
        const classified = this.classifyFailure(failureMsg);
        logger.error(
          { err: classified, eventType: params.eventType, model: params.modelId, exitCode: runResult.exitCode, durationMs: Date.now() - startMs },
          "Codex execute failed",
        );
        throw classified;
      }

      const { costUsd, costSource } = this.priceFetcher.estimateUsageCost({
        backendId: this.backendId,
        modelId: actualModelId,
        usage,
        fallbackModel: findRegisteredModel(this.backendId, actualModelId),
      });
      this.assertWithinMaxBudget(costUsd, params.maxBudgetUsd, actualModelId, {
        usage,
        costSource,
        numTurns: numTurns || 1,
        durationMs: Date.now() - startMs,
      });
      if (output && !streamed) {
        streamCallbacks?.onText?.(output);
      }

      const durationMs = Date.now() - startMs;
      logger.info(
        { eventType: params.eventType, model: actualModelId, durationMs, costUsd, numTurns: numTurns || 1 },
        "Codex execute completed",
      );

      return {
        output,
        sessionId,
        backendId: this.backendId,
        modelId: actualModelId,
        costSource,
        costUsd,
        usage,
        modelUsage: usage.inputTokens || usage.outputTokens
          ? {
              [actualModelId]: {
                inputTokens: usage.inputTokens,
                outputTokens: usage.outputTokens,
                costUsd,
              },
            }
          : {},
        numTurns: numTurns || 1,
        durationMs,
        durationApiMs: durationMs,
        model: actualModelId,
        isError: false,
        stopReason,
        contextUpdated: false,
        // advisorCallCount omitted — non-Anthropic backends never populate
        // this field, consumers treat undefined as 0.
      };
    } finally {
      // Stop the reactive idle watchdog first — idempotent if start()
      // was never reached, but always safe.
      idleWatchdog.stop();
      removeFileIfExists(outputPath);
      streamCallbacks?.onEnd?.();
      if (ownsSessionDir) {
        // Mirror ClaudeCodeCore: only revoke when we own the temp dir.
        // Caller-owned (persistent) dirs survive across turns and reuse the
        // same scope, so revoking here would invalidate a token still in use
        // by a subsequent resume on the same session.
        this.readTokenManager?.revoke(sessionDir);
        cleanupSessionWorkdir(sessionDir);
      }
    }
  }

  private buildArgs(
    params: {
      prompt: string;
      modelId: string;
      resumeSessionId?: string;
      persistSession: boolean;
      stagedAttachments?: StagedAttachment[];
      webSearchEnabled?: boolean;
    },
    outputPath: string,
  ): string[] {
    // ─────────────────────────────────────────────────────────────────────
    // Sandbox network-access asymmetry (known limitation).
    //
    // `-c sandbox_workspace_write.network_access=true` is required for the
    // agent to reach the daemon API at http://localhost:${apiPort}/... under
    // the workspace-write sandbox. Without it, Seatbelt/sandbox-exec blocks
    // ALL network egress and `curl http://localhost:8321/api/health` fails
    // with a connection-refused sandbox denial.
    //
    // HOWEVER: this flag is a binary on/off switch in Codex's sandbox model.
    // There is no host-scoped allowlist. Once enabled, the agent can reach
    // ANY external host (verified: curl https://example.com → HTTP 200).
    //
    // This is MORE PERMISSIVE than the Claude Code backend, which uses a
    // PreToolUse hook (`bashCurlHook` in claude-code-core.ts) to restrict
    // curl targets to localhost:${apiPort}. The Gemini backend achieves the
    // same localhost restriction via a generated TOML admin policy
    // (`generateAdminPolicy()` in gemini-cli-core.ts).
    //
    // Codex has neither a hook system nor an admin-policy layer for shell
    // commands, so the localhost-only restriction cannot currently be
    // enforced on this backend. As long as `message.dm` is routed primarily
    // to Claude Code (the default), this asymmetry is latent. If the default
    // binding changes to Codex, revisit by either:
    //   (a) generating a config.toml with a stricter sandbox profile, or
    //   (b) wrapping curl with a shim that validates URLs before exec.
    //
    // Tracked: BUG-DM-BACKEND-PERMISSIONS.md §5 / §9.
    //
    // Allow mode: `--dangerously-bypass-approvals-and-sandbox` skips both
    // approvals AND sandboxing. No workspace-write network override needed
    // because the sandbox itself is off.
    //
    // `codex exec resume` argv narrowing (verified on 0.121.0):
    //   `codex exec resume` rejects `--sandbox` and `--color`. Both are
    //   accepted by the fresh `codex exec` subcommand but not by the
    //   resume subcommand. We therefore:
    //     - Use `-c sandbox_mode="workspace-write"` (config-override form)
    //       for strict mode instead of `--sandbox workspace-write`, since
    //       `-c` IS accepted by both exec and resume. Functionally
    //       equivalent; keeps one branch for both code paths.
    //     - Drop `--color never` from the resume invocation. It remains
    //       in fresh exec where it is still accepted.
    // ─────────────────────────────────────────────────────────────────────
    const allowMode = this.config.codexExecutionPermissionMode === "allow";
    //
    // EXECUTION-MODE-DESIGN.md §6 absolute-block layer — Codex gap.
    //
    // The absolute-block list (rm -rf, sudo, curl | sh, secret-path reads)
    // cannot be enforced at the daemon layer on Codex:
    //
    //  - Strict mode: the workspace-write sandbox blocks file writes
    //    outside `cwd`, which contains some of the damage (e.g. a
    //    `Write(~/.ssh/authorized_keys)` would be denied by the
    //    sandbox). It does NOT pattern-match shell commands — `rm -rf`
    //    INSIDE the session workdir, `sudo`, and `curl | sh` are not
    //    intercepted.
    //
    //  - Allow mode: `--dangerously-bypass-approvals-and-sandbox` turns
    //    off both approvals and the sandbox entirely. There is no hook
    //    or admin-policy layer we can attach to. The user has
    //    explicitly opted in.
    //
    // Accepted gap per design sign-off. If / when Codex ships a hook
    // system or admin-policy layer for shell commands, wire
    // `ALWAYS_DISALLOWED_TOOLS` + the `classifyAbsoluteBlock` helper
    // from `safety/always-disallowed.ts` here, mirroring the Claude
    // Code implementation.
    //
    // DELEGATED-MODE-V2-DESIGN.md §4.3.4 — same-backend MCP-tool deny
    // shares the same accepted-gap surface (γ outcome). Codex's built-in
    // connector apps (`mcp__codex_apps__*`) are not exposed in
    // `.codex/config.toml` and there is no per-tool disable flag at the
    // CLI layer. Enforcement is prose-only via the `## Denied tools
    // (per-integration)` block in AGENTS.md (rendered by
    // `skills-compiler.buildSameBackendDenyBlock`). Cross-backend
    // delegation provides hard enforcement at the
    // `/api/integrations/:key/exec` task-mode chokepoint, so users
    // requiring strict deny should pick a non-Codex DM backend.
    //
    const sandboxArgs = allowMode
      ? ["--dangerously-bypass-approvals-and-sandbox"]
      : [
          "-c",
          'sandbox_mode="workspace-write"',
          "-c",
          "sandbox_workspace_write.network_access=true",
        ];

    // OpenAI Responses-API `web_search` tool — toggled per-spawn via the
    // shared `WEB_SEARCH_CAPABLE_BACKENDS` flag (`backends.web_search_enabled`
    // in DB, surfaced on `/settings/models`). The tool runs server-side at
    // OpenAI, NOT as a local shell command, so the workspace-write sandbox
    // doesn't need to widen — strict mode + this `-c` is the right combo for
    // safe-mode operators who still want web answers. Equivalent to the
    // interactive `codex --search` flag (codex-cli 0.124.0+); accepted by
    // both `codex exec` and `codex exec resume`.
    const webSearchArgs = params.webSearchEnabled
      ? ["-c", "tools.web_search=true"]
      : [];

    const imageArgs = buildCodexImageArgs(
      params.stagedAttachments,
      CODEX_ARGV_BUDGET_BYTES,
    );

    if (params.resumeSessionId) {
      return [
        "exec",
        "resume",
        params.resumeSessionId,
        "--json",
        // NOTE: `--color never` omitted — rejected by `codex exec resume`.
        ...sandboxArgs,
        ...webSearchArgs,
        "--skip-git-repo-check",
        "--output-last-message",
        outputPath,
        "--model",
        params.modelId,
        ...imageArgs,
        params.prompt,
      ];
    }

    return [
      "exec",
      "--json",
      "--color",
      "never",
      ...sandboxArgs,
      ...webSearchArgs,
      "--skip-git-repo-check",
      "--output-last-message",
      outputPath,
      "--model",
      params.modelId,
      ...(params.persistSession ? [] : ["--ephemeral"]),
      ...imageArgs,
      params.prompt,
    ];
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

  private classifyFailure(message: string): BackendQuotaError | BackendDecisiveFailure {
    if (isMaxBudgetMessage(message)) {
      return new BackendQuotaError(this.backendId, "max_budget_usd", null, message);
    }
    if (/rate limit|usage limit|quota/i.test(message)) {
      // Best-effort reset-time extraction so the dashboard can surface
      // "quota resets at HH:MM (TZ)" instead of a bare "rate_limited" tag.
      // OpenAI rate-limit messages typically carry "try again in Xm" or
      // an ISO retry-after; the helper falls through to null when neither
      // pattern matches, preserving the original behaviour.
      return new BackendQuotaError(
        this.backendId,
        "rate_limited",
        extractGenericQuotaResetHint(message),
        message,
      );
    }
    if (/unauthorized|forbidden|api key|login/i.test(message)) {
      return new BackendDecisiveFailure(this.backendId, "auth", new Error(message));
    }
    if (/timed out|timeout/i.test(message)) {
      return new BackendDecisiveFailure(this.backendId, "timeout", new Error(message));
    }
    return new BackendDecisiveFailure(
      this.backendId,
      "other_non_retryable",
      new Error(message),
    );
  }

  private assertWithinMaxBudget(
    costUsd: number,
    maxBudgetUsd: number | undefined,
    modelId: string,
    /**
     * Spend metadata for the just-completed turn. Codex enforces
     * `max_budget_usd` post-hoc — by the time we reject here OpenAI has
     * already consumed tokens — so we hand the actual usage to the
     * BackendQuotaError so the dispatcher's error path can write a
     * `result='failed'` agent_actions row with `cost_usd` populated.
     * Without this the dashboard silently misses budget-rejected spend.
     */
    spend?: Omit<import("../agent-core.js").BackendQuotaSpend, "modelId" | "costUsd">,
  ): void {
    if (maxBudgetUsd === undefined || costUsd <= maxBudgetUsd) {
      return;
    }
    throw new BackendQuotaError(
      this.backendId,
      "max_budget_usd",
      null,
      `Codex estimated cost $${costUsd.toFixed(4)} exceeded the per-turn budget limit $${maxBudgetUsd.toFixed(2)} for ${modelId}.`,
      spend ? { ...spend, modelId, costUsd } : null,
    );
  }

  private assertPromptWithinMaxBudget(
    prompt: string,
    maxBudgetUsd: number | undefined,
    modelId: string,
  ): void {
    if (maxBudgetUsd === undefined) {
      return;
    }
    const estimatedUsage: BackendUsage = {
      inputTokens: estimateTextInputTokens(prompt),
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    };
    const { costUsd } = this.priceFetcher.estimateUsageCost({
      backendId: this.backendId,
      modelId,
      usage: estimatedUsage,
      fallbackModel: findRegisteredModel(this.backendId, modelId),
    });
    if (costUsd <= maxBudgetUsd) {
      return;
    }
    throw new BackendQuotaError(
      this.backendId,
      "max_budget_usd",
      null,
      `Codex estimated prompt cost $${costUsd.toFixed(4)} exceeded the per-turn budget limit $${maxBudgetUsd.toFixed(2)} for ${modelId}.`,
    );
  }

  /**
   * Delegated proxy invocation — Codex CLI path.
   *
   * Spawns `codex exec --json --ephemeral --skip-git-repo-check
   * --output-last-message <path> --model <m> <prompt>` in the
   * pre-materialized `sessionDir`, parses JSONL events, and matches the
   * first `mcp__codex_apps__*` tool call whose name equals the requested
   * tool. The tool result is extracted from item-output fields (`output`,
   * `aggregated_output`, `stdout`) emitted on the same item or on a
   * subsequent paired item — the precise pairing semantics differ across
   * Codex CLI versions, so the implementation is defensive: it captures
   * the first non-empty output that arrives after the matching call and
   * within the same turn. The captured-last-message file is the final
   * fallback (model-text path; less reliable but better than 502 if the
   * structured pairing changes shape upstream).
   *
   * Error classes mirror the Claude path. `auth_error` is detected via
   * the existing `classifyFailure` regex; `tool_error` arrives as a
   * `turn.failed` event or as a non-zero subprocess exit code with a
   * recognisable message.
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
        message: "codex CLI not found on PATH",
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

    const prompt = buildDelegatedToolPrompt(toolName, toolArgs);
    const outputPath = createOutputCapturePath(
      sessionDir,
      "codex-delegated-last-message",
    );
    // Mirror the user's execution mode rather than hard-coding strict
    // sandbox. The proxy session itself runs proxy.md (one tool call,
    // no Bash / Edit / Write), so the sandbox is purely defensive — but
    // forcing strict on a user who explicitly opted into allow mode is
    // an inconsistency that surfaces when delegated.
    const allowMode = this.config.codexExecutionPermissionMode === "allow";
    const sandboxArgs = allowMode
      ? ["--dangerously-bypass-approvals-and-sandbox"]
      : [
          "-c",
          'sandbox_mode="workspace-write"',
          "-c",
          "sandbox_workspace_write.network_access=true",
        ];
    const args = [
      "exec",
      "--json",
      "--color",
      "never",
      ...sandboxArgs,
      "--skip-git-repo-check",
      "--output-last-message",
      outputPath,
      "--model",
      modelId,
      "--ephemeral",
      prompt,
    ];

    let capturedToolItemId: string | null = null;
    let capturedResultRaw: string | null = null;
    let capturedToolError: string | null = null;
    let wrongToolName: string | null = null;
    let usage: BackendUsage = { ...EMPTY_USAGE };
    let actualModelId = modelId;
    let numTurns = 0;
    let lastError: string | null = null;
    let sawTurnCompleted = false;
    const stderrBuffer: string[] = [];
    // Reasoning-gate state — same shape as the main executeTurn path.
    // The delegated proxy expects exactly one tool result; if codex
    // emitted reasoning summaries during the turn AND structured
    // pairing yielded nothing, the `--output-last-message` fallback
    // below would otherwise hand the reasoning text to
    // `tryParseToolResult` and surface it as a fake "tool result"
    // string. Tracking reasoning observation lets that fallback
    // refuse such content.
    const reasoningItemIds = new Set<string>();
    let observedReasoning = false;

    // Local aborter bridged from the caller's signal so we can also
    // trigger an early abort on wrong-tool detection. See gemini-cli-core
    // for the full rationale: this caps wrong_tool failures at ~5s
    // instead of waiting for the wall-clock or natural completion.
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

    // Idle watchdog — same pattern as gemini-cli-core. Catches a hung
    // codex CLI subprocess (no stream events at all) before the local
    // safety-net timer or the caller's wall-clock signal fires. Tuned
    // for codex's typical first-event time (5-15 s); tripping at 60 s
    // is well outside the healthy distribution.
    let idleTimedOut = false;
    const idleTimeoutMs =
      DELEGATED_PROXY_DEFAULTS.idleTimeoutMsByBackend.codex
      ?? DELEGATED_PROXY_DEFAULTS.idleTimeoutMs;
    const idleWatchdog = new IdleWatchdog({
      idleTimeoutMs,
      onTimeout: (idleMs) => {
        idleTimedOut = true;
        logger.warn(
          { idleMs, idleTimeoutMs, toolName },
          "codex delegated proxy idle watchdog tripped",
        );
        proxyAborter.abort(
          new DelegatedProxyTimeoutError(
            `codex stream idle for ${idleMs}ms (limit ${idleTimeoutMs}ms)`,
          ),
        );
      },
    });

    const daemonReadToken = this.issueReadToken(sessionDir);
    try {
      idleWatchdog.start();
      const runResult = await runLineCommand({
        command: this.cliPath,
        args,
        cwd: sessionDir,
        env: buildDaemonApiCliEnv(sessionDir, this.config.apiPort, {
          ...(daemonReadToken ? { readToken: daemonReadToken } : {}),
          sessionBackend: "codex",
        }),
        // Wall-clock is enforced by the invoker via abortSignal — we still
        // pass a generous local timeout as a safety net (callers can
        // disable it by setting their own abortSignal).
        timeoutMs: 120_000,
        abortSignal: proxyAborter.signal,
        onStdoutLine: (line) => {
          idleWatchdog.beat();
          const event = parseJsonLine<CodexEvent>(line);
          if (!event?.type) return;

          if (event.type === "turn.started") {
            numTurns += 1;
            return;
          }
          if (event.type === "turn.completed") {
            sawTurnCompleted = true;
            usage = extractCodexUsage(event) ?? usage;
            actualModelId = event.model ?? actualModelId;
            return;
          }
          if (event.type === "turn.failed") {
            lastError = event.error?.message ?? lastError;
            return;
          }
          if (event.type === "error") {
            const message = event.message?.trim();
            if (message && !message.startsWith("Reconnecting...")) {
              lastError = message;
            }
            return;
          }

          // Reasoning gate — must run before tool-call matching so a
          // reasoning item never accidentally feeds into the pairing
          // logic and never poisons the file fallback below.
          rememberReasoningItem(event, reasoningItemIds);
          if (shouldDropAsReasoning(event, reasoningItemIds)) {
            observedReasoning = true;
            return;
          }

          // Match MCP tool calls by item.name / item.tool. We accept the
          // first item that resolves to the requested tool name; any
          // earlier item resolving to a different MCP tool flips the
          // wrong_tool flag.
          const item = event.item;
          if (item && typeof item === "object") {
            const bag = item as Record<string, unknown>;
            const itemId =
              typeof bag.id === "string"
                ? bag.id
                : typeof bag.call_id === "string"
                  ? bag.call_id
                  : null;
            const callMatch = extractMcpToolCall(event);
            if (callMatch && itemId !== null && capturedToolItemId === null) {
              const fullName = callMatch.toolName.startsWith("mcp__")
                ? callMatch.toolName
                : `mcp__${callMatch.serverId}__${callMatch.toolName}`;
              if (
                callMatch.toolName === toolName
                || fullName === toolName
                || itemMatchesToolName(bag, toolName)
              ) {
                capturedToolItemId = itemId;
              } else if (wrongToolName === null) {
                wrongToolName = fullName;
                // Early abort: see gemini-cli-core comment on the same
                // pattern. The post-await classifier checks
                // `wrongToolName` before `abortSignal?.aborted` so the
                // failure is attributed correctly.
                proxyAborter.abort(new Error("wrong_tool"));
              }
            }

            // Pair tool result by call_id / parent_id when available;
            // otherwise treat the first non-empty output that arrives
            // after the matching call as the result. The output may live
            // on the call item itself (some Codex versions backfill it)
            // or on a separate function_call_output item.
            if (capturedToolItemId !== null && capturedResultRaw === null) {
              const pairedId =
                typeof bag.call_id === "string"
                  ? bag.call_id
                  : typeof bag.parent_id === "string"
                    ? bag.parent_id
                    : itemId;
              const paired = pairedId === capturedToolItemId;
              if (paired || itemId === capturedToolItemId) {
                const collected = collectItemOutput(bag);
                if (collected !== null) {
                  capturedResultRaw = collected;
                  // Codex marks tool errors with `is_error` or `error`
                  // fields on the output item.
                  if (
                    bag.is_error === true
                    || (typeof bag.error === "string"
                      && bag.error.trim().length > 0)
                  ) {
                    capturedToolError =
                      typeof bag.error === "string"
                        ? bag.error
                        : capturedResultRaw;
                  }
                }
              }
            }
          }
        },
        onStderrLine: (line) => {
          idleWatchdog.beat();
          stderrBuffer.push(line);
          if (isLikelyCodexFailure(line)) {
            lastError = line.trim();
          }
        },
      });

      if (capturedResultRaw === null && capturedToolItemId !== null) {
        // Structured stream pairing did not yield a result block — fall
        // back to the captured `--output-last-message` content. The
        // proxy.md prompt instructs the model to return the tool's raw
        // result, so the assistant's final message should already be the
        // tool output (less reliable than structured matching, but a
        // graceful degradation when pairing semantics drift across
        // Codex versions).
        //
        // Reasoning gate — when reasoning was observed during the turn
        // the file may itself contain a reasoning summary (codex 0.121+
        // GPT-5 behavior). Surfacing it as a fake "tool result" would
        // poison the downstream `tryParseToolResult` walker. Skip the
        // fallback in that case and let the caller classify the run
        // as no-result.
        if (!observedReasoning) {
          const lastMessage = readFileIfExists(outputPath);
          if (lastMessage && lastMessage.trim().length > 0) {
            capturedResultRaw = lastMessage.trim();
          }
        }
      }

      const cost = withDurationMs(
        {
          tokensInput: usage.inputTokens,
          tokensOutput: usage.outputTokens,
          cacheCreationTokens: usage.cacheCreationInputTokens,
          cacheReadTokens: usage.cacheReadInputTokens,
          costUsd: this.priceFetcher.estimateUsageCost({
            backendId: this.backendId,
            modelId: actualModelId,
            usage,
            fallbackModel: findRegisteredModel(this.backendId, actualModelId),
          }).costUsd,
          durationMs: 0,
          numTurns: numTurns || (sawTurnCompleted ? 1 : 0),
        },
        startMs,
      );

      // wrong_tool check is hoisted above the abort branch because the
      // early-abort path (proxyAborter.abort) sets `wrongToolName` and
      // triggers a kill — without this ordering the failure would
      // surface as `cancelled` instead of the actual upstream cause.
      // The idle-watchdog branch sits between wrong_tool and the
      // caller's abortSignal: an idle hang aborts via proxyAborter and
      // does not propagate to abortSignal, so without this ordering the
      // failure would mis-classify as `no_tool_call`.
      if (wrongToolName !== null) {
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
          message: `delegated proxy stream went idle (no codex events for ${idleTimeoutMs}ms)`,
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
          message: "codex subprocess exceeded local safety-net timeout",
          cost,
        };
      }
      if (capturedResultRaw !== null && capturedToolError === null) {
        return {
          ok: true,
          toolResult: tryParseToolResult(capturedResultRaw),
          cost,
        };
      }
      if (capturedToolError !== null) {
        return {
          ok: false,
          errorClass: "tool_error",
          message: flattenToolResultContent(capturedToolError),
          cost,
        };
      }
      const failure = lastError ?? firstFailureLine(stderrBuffer);
      if (failure && /unauthorized|forbidden|api key|login|auth/i.test(failure)) {
        return {
          ok: false,
          errorClass: "auth_error",
          message: failure,
          cost,
        };
      }
      if (runResult.exitCode !== 0 && runResult.exitCode !== null) {
        return {
          ok: false,
          errorClass: "subprocess_crashed",
          message: failure ?? `codex exec exited ${runResult.exitCode}`,
          cost,
        };
      }
      if (capturedToolItemId === null) {
        return {
          ok: false,
          errorClass: "no_tool_call",
          message: failure
            ?? `model did not invoke '${toolName}' (sawTurnCompleted=${sawTurnCompleted})`,
          cost,
        };
      }
      return {
        ok: false,
        errorClass: "parse_error",
        message:
          failure
          ?? `codex emitted '${toolName}' call but no output payload could be paired`,
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
      idleWatchdog.stop();
      removeFileIfExists(outputPath);
      // Invoker owns sessionDir lifecycle, but the readToken scope is keyed
      // on the same path — revoke here so a leaked token cannot outlive the
      // delegated proxy run.
      this.readTokenManager?.revoke(sessionDir);
      if (abortSignal && !abortSignal.aborted) {
        abortSignal.removeEventListener("abort", callerAbortListener);
      }
    }
  }

  /**
   * DELEGATED-TASK-MODE-DESIGN.md §9 — Codex task mode (Phase 1.5+).
   *
   * Codex CLI has no per-spawn allowedTools surface for MCP calls and no
   * PreToolUse hook, so allowed-tools enforcement lives entirely in
   * daemon-side stream pre-emption: we observe each `tool_use` item on
   * stdout, gate it against `allowedTools` and the destructive denylist,
   * and abort the subprocess (via the local AbortController) when the
   * model reaches outside the per-task envelope.
   *
   * Race window (accepted): a fast tool's side effect can land before our
   * SIGTERM arrives. The session's materialized `.codex/` config restricts
   * the MCP surface to the integration's connector (so out-of-scope tools
   * are unreachable to begin with), and `allowDestructive=false` removes
   * destructive entries from `allowedTools` upstream — but a destructive
   * connector tool that the prompt instructs the model NOT to call could
   * still race a SIGTERM. The prompt's destructive-section + the
   * `needsConfirmation` envelope are the load-bearing guardrails for that
   * narrow case; stream pre-emption is the second line.
   *
   * Output extraction: Codex CLI does not expose a structured-output API
   * (Anthropic-style `outputFormat: 'json_schema'`), so we pin
   * `--output-last-message` to a file and let the runtime helper
   * (`extractAndValidateResult`) handle fence-stripping + Ajv validation.
   * The `structuredOutput` field on the result is intentionally omitted
   * for Codex; the invoker falls back to text-extract automatically.
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
      timeoutMs,
      sessionDir,
      abortSignal,
      onToolStep,
      allowDestructive,
    } = params;
    const trace: DelegatedTaskToolStepRaw[] = [];
    let writeClassToolFired = false;

    const writeClassMatcher = (name: string): boolean =>
      writeClassTools.some((pattern) =>
        matchRunAllowedToolPattern(pattern, name),
      );

    if (!this.cliPath) {
      return {
        ok: false,
        errorClass: "subprocess_crashed",
        message: "codex CLI not found on PATH",
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

    const outputPath = createOutputCapturePath(
      sessionDir,
      "codex-delegated-task-last-message",
    );
    // Mirror runDelegatedTool's sandbox decision so the proxy session's
    // posture matches the user's configured execution mode (Allow vs Safe).
    // In both modes the per-task allowed-tools envelope is enforced by
    // stream pre-emption below — sandbox bypass only relaxes shell/file
    // restrictions, which the task subprocess does not exercise anyway.
    const allowMode = this.config.codexExecutionPermissionMode === "allow";
    const sandboxArgs = allowMode
      ? ["--dangerously-bypass-approvals-and-sandbox"]
      : [
        "-c",
        'sandbox_mode="workspace-write"',
        "-c",
        "sandbox_workspace_write.network_access=true",
      ];
    const args = [
      "exec",
      "--json",
      "--color",
      "never",
      ...sandboxArgs,
      "--skip-git-repo-check",
      "--output-last-message",
      outputPath,
      "--model",
      modelId,
      "--ephemeral",
      systemPrompt,
    ];

    // Local aborter bridged from the caller's signal so we can also
    // trigger an early abort on policy_violation / loop_aborted detection.
    // Mirrors the pattern in runDelegatedTool and gemini-cli-core's
    // task-mode implementation.
    const aborter = new AbortController();
    const callerListener = (): void => {
      aborter.abort(abortSignal?.reason);
    };
    if (abortSignal) {
      if (abortSignal.aborted) {
        aborter.abort(abortSignal.reason);
      } else {
        abortSignal.addEventListener("abort", callerListener, { once: true });
      }
    }

    const isAllowedTool = (name: string): boolean =>
      allowedTools.some((pattern) =>
        matchRunAllowedToolPattern(pattern, name),
      );
    const destructiveSet = allowDestructive
      ? new Set<string>()
      : new Set<string>(destructiveTools);

    interface PendingToolUse {
      name: string;
      args: unknown;
      startedAt: number;
    }
    const pendingByItemId = new Map<string, PendingToolUse>();
    let toolCallCount = 0;
    let loopAborted = false;
    let policyViolationTool: string | null = null;
    let usage: BackendUsage = { ...EMPTY_USAGE };
    let actualModelId = modelId;
    let numTurns = 0;
    let lastError: string | null = null;
    let sawTurnCompleted = false;
    const stderrBuffer: string[] = [];
    // Reasoning-gate state — mirrors executeTurn / runDelegatedTool.
    // Delegated tasks pull `rawAssistantText` from the file written by
    // `--output-last-message`; if reasoning was observed and that file
    // is the only text source, the dispatcher's structured-output
    // validator would receive reasoning narration in place of the
    // expected JSON envelope, leaking GPT-5's internal deliberation
    // into delegated-task traces and surfacing as a parse_error
    // wrapped around reasoning content.
    const reasoningItemIds = new Set<string>();
    let observedReasoning = false;

    const daemonReadToken = this.issueReadToken(sessionDir);
    try {
      const runResult = await runLineCommand({
        command: this.cliPath,
        args,
        cwd: sessionDir,
        env: buildDaemonApiCliEnv(sessionDir, this.config.apiPort, {
          ...(daemonReadToken ? { readToken: daemonReadToken } : {}),
          sessionBackend: "codex",
        }),
        // Wall-clock is enforced by the caller's abortSignal (the route
        // handler clamps timeoutMs to DELEGATED_TASK_HARD_CAPS.maxTimeoutMs
        // = 5min). Local timeoutMs is a safety net pegged to the caller
        // bound + 60s grace so the abort fires first and gives a clean
        // errorClass=timeout via classifyAbortReason.
        timeoutMs: timeoutMs + 60_000,
        abortSignal: aborter.signal,
        onStdoutLine: (line) => {
          const event = parseJsonLine<CodexEvent>(line);
          if (!event?.type) return;

          if (event.type === "turn.started") {
            numTurns += 1;
            return;
          }
          if (event.type === "turn.completed") {
            sawTurnCompleted = true;
            usage = extractCodexUsage(event) ?? usage;
            actualModelId = event.model ?? actualModelId;
            return;
          }
          if (event.type === "turn.failed") {
            lastError = event.error?.message ?? lastError;
            return;
          }
          if (event.type === "error") {
            const message = event.message?.trim();
            if (message && !message.startsWith("Reconnecting...")) {
              lastError = message;
            }
            return;
          }

          // Reasoning gate — must precede tool-call matching and the
          // pairing logic so reasoning items are excluded from both,
          // and so `observedReasoning` is set in time to suppress the
          // file fallback after the run completes.
          rememberReasoningItem(event, reasoningItemIds);
          if (shouldDropAsReasoning(event, reasoningItemIds)) {
            observedReasoning = true;
            return;
          }

          const item = event.item;
          if (!item || typeof item !== "object") return;
          const bag = item as Record<string, unknown>;
          const itemId =
            typeof bag.id === "string"
              ? bag.id
              : typeof bag.call_id === "string"
                ? bag.call_id
                : null;

          // Stream pre-emption: gate every MCP tool_use against the
          // per-task allowed-tools / destructive envelope before the
          // subprocess can act on it. The race-window caveat (model side
          // effect lands before SIGTERM) is documented at the top of this
          // method.
          const callMatch = extractMcpToolCall(event);
          if (callMatch && itemId !== null) {
            // Prefer the verbatim `bag.name` (or `bag.tool_name`) when
            // it's already the fully-qualified `mcp__server__tool` form —
            // splitting + reconstructing via serverId+toolName loses
            // dotted namespace prefixes like `gmail.` (e.g. Codex's gmail
            // MCP registers `gmail._search_emails`, but `bag.tool` carries
            // only `_search_emails`, dropping the `gmail.` segment).
            const verbatim =
              typeof bag.name === "string" && bag.name.startsWith("mcp__")
                ? bag.name
                : typeof bag.tool_name === "string"
                    && (bag.tool_name as string).startsWith("mcp__")
                  ? (bag.tool_name as string)
                  : null;
            const fullName =
              verbatim
              ?? (callMatch.toolName.startsWith("mcp__")
                ? callMatch.toolName
                : `mcp__${callMatch.serverId}__${callMatch.toolName}`);
            if (!pendingByItemId.has(itemId)) {
              if (!isAllowedTool(fullName) || destructiveSet.has(fullName)) {
                policyViolationTool = fullName;
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
              if (writeClassMatcher(fullName)) {
                writeClassToolFired = true;
              }
              pendingByItemId.set(itemId, {
                name: fullName,
                args: extractCodexCallArgs(bag),
                startedAt: Date.now(),
              });
              return;
            }
          }

          // Tool result pairing: bind the first non-empty output that
          // arrives for a known pending tool_use. Codex emits the output
          // either backfilled on the call item itself (older versions) or
          // on a paired function_call_output item.
          if (pendingByItemId.size > 0) {
            const pairedId =
              typeof bag.call_id === "string"
                ? bag.call_id
                : typeof bag.parent_id === "string"
                  ? bag.parent_id
                  : itemId;
            if (pairedId !== null && pendingByItemId.has(pairedId)) {
              const pending = pendingByItemId.get(pairedId);
              const collected = collectItemOutput(bag);
              if (pending && collected !== null) {
                pendingByItemId.delete(pairedId);
                const isErrorResult =
                  bag.is_error === true
                  || (typeof bag.error === "string"
                    && bag.error.trim().length > 0);
                // `collected` is the connector response as a string —
                // either a JSON-encoded object (the common path:
                // `bag.output` was the Codex-side tool_result envelope)
                // or a free-form text reply (`stdout` / `stderr`). Try
                // JSON-parse for the response-shape walker downstream;
                // fall back to the raw string so the field is always
                // populated for ok steps.
                let parsedToolResult: unknown = collected;
                try {
                  parsedToolResult = JSON.parse(collected);
                } catch {
                  /* keep raw string */
                }
                const step: DelegatedTaskToolStepRaw = {
                  toolName: pending.name,
                  toolArgs: pending.args,
                  durationMs: Date.now() - pending.startedAt,
                  status: isErrorResult ? "error" : "ok",
                  costUsd: null,
                  tokensInput: null,
                  tokensOutput: null,
                  toolResult: parsedToolResult,
                };
                trace.push(step);
                onToolStep?.(step);
              }
            }
          }
        },
        onStderrLine: (line) => {
          stderrBuffer.push(line);
          if (isLikelyCodexFailure(line)) {
            lastError = line.trim();
          }
        },
      });

      const cost = withDurationMs(
        {
          tokensInput: usage.inputTokens,
          tokensOutput: usage.outputTokens,
          cacheCreationTokens: usage.cacheCreationInputTokens,
          cacheReadTokens: usage.cacheReadInputTokens,
          costUsd: this.priceFetcher.estimateUsageCost({
            backendId: this.backendId,
            modelId: actualModelId,
            usage,
            fallbackModel: findRegisteredModel(this.backendId, actualModelId),
          }).costUsd,
          durationMs: 0,
          numTurns: numTurns || (sawTurnCompleted ? 1 : 0),
        },
        startMs,
      );

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
          message: "codex subprocess exceeded local safety-net timeout",
          cost,
          trace,
          writeClassToolFired,
        };
      }

      // Reasoning gate on the file fallback. The delegated task path
      // has no stream-side text accumulator (unlike executeTurn's
      // `outputChunks`), so the file IS the only text source. When
      // reasoning was observed during the run, codex CLI may have
      // written a reasoning summary to `--output-last-message` —
      // returning that as `rawAssistantText` would feed reasoning
      // narration into the dispatcher's structured-output validator.
      // Treat it as no-output instead and let the standard
      // parse_error path surface a clean failure.
      const lastMessage = observedReasoning
        ? null
        : readFileIfExists(outputPath);
      const finalText = lastMessage?.trim() ?? "";
      if (finalText.length === 0) {
        const failure = lastError ?? firstFailureLine(stderrBuffer);
        if (
          failure
          && /unauthorized|forbidden|api key|login|auth/i.test(failure)
        ) {
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
            ?? (observedReasoning
              ? `codex emitted only reasoning summaries; no final assistant message (sawTurnCompleted=${sawTurnCompleted})`
              : `codex emitted no final assistant message (sawTurnCompleted=${sawTurnCompleted})`),
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
      removeFileIfExists(outputPath);
      // See runDelegatedTool — invoker owns the dir, but the readToken scope
      // matches the dir path and must not outlive the run.
      this.readTokenManager?.revoke(sessionDir);
      if (abortSignal) {
        abortSignal.removeEventListener("abort", callerListener);
      }
    }
  }
}

/**
 * Best-effort extraction of tool-call arguments from a Codex
 * `function_call` / `mcp_call` item. Codex serialises args as a JSON
 * string in `bag.arguments`; older versions may use `bag.input` instead.
 * Returns `null` when nothing parseable is present so the trace's
 * `toolArgs` field stays informative.
 */
function extractCodexCallArgs(bag: Record<string, unknown>): unknown {
  const candidates = ["arguments", "input", "args"] as const;
  for (const key of candidates) {
    const value = bag[key];
    if (value === undefined || value === null) continue;
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed.length === 0) continue;
      try {
        return JSON.parse(trimmed);
      } catch {
        return trimmed;
      }
    }
    if (typeof value === "object") return value;
  }
  return null;
}

/**
 * Codex MCP items can carry the tool name on multiple fields depending on
 * CLI version (`name`, `tool`, `tool_name`). Returns true when any of
 * them match the requested tool — used as a belt-and-suspenders check
 * after `extractMcpToolCall` has run, in case the parsing path missed.
 */
function itemMatchesToolName(
  bag: Record<string, unknown>,
  toolName: string,
): boolean {
  const candidates = ["name", "tool", "tool_name"] as const;
  for (const key of candidates) {
    const v = bag[key];
    if (typeof v === "string" && (v === toolName || `mcp__${v}` === toolName)) {
      return true;
    }
  }
  return false;
}

/**
 * Pull the first non-empty output payload from a Codex item. Tries the
 * structured `output` field first (object → JSON); falls back to the
 * text-shaped fields the existing `collectCodexItemText` helper scans.
 */
function collectItemOutput(bag: Record<string, unknown>): string | null {
  const structured = bag.output;
  if (structured !== undefined && structured !== null) {
    if (typeof structured === "string" && structured.length > 0) {
      return structured;
    }
    if (typeof structured === "object") {
      try {
        return JSON.stringify(structured);
      } catch {
        /* fall through to text fields */
      }
    }
  }
  const fields = ["aggregated_output", "stdout", "stderr"] as const;
  for (const key of fields) {
    const v = bag[key];
    if (typeof v === "string" && v.length > 0) {
      return v;
    }
  }
  return null;
}

function isMaxBudgetMessage(message: string): boolean {
  return /max(?:imum)? budget|max_budget_usd|budget limit|per-turn budget/i.test(message);
}

/**
 * Codex argv byte budget. macOS `ARG_MAX` is ~1 MB and the kernel counts
 * env vars too, so we cap our contribution at 120 KB to leave plenty of
 * headroom for the prompt body (which can exceed 50 KB on long-context
 * routines) + env. Matches the chat-file-attachments envelope (see
 * `docs/design/04-daemon-api.md` §4.3.23).
 */
export const CODEX_ARGV_BUDGET_BYTES = 120_000;

/**
 * Translate staged image attachments into repeated `--image <absolutePath>`
 * argv pairs. Non-image attachments stay staged-only (the agent opens them
 * via shell `cat` / `grep`). If emitting flags for every image would push
 * argv past the budget, drop the entire list — partial emission would
 * silently bias the model's attention toward the first N images in an
 * order that's not visible in the prompt. All-or-nothing is easier to
 * diagnose and the `[Attached files]` text block still names every file.
 *
 * Pure function — unit-testable without a CLI subprocess.
 */
export function buildCodexImageArgs(
  staged: StagedAttachment[] | undefined,
  budgetBytes: number,
): string[] {
  if (!staged || staged.length === 0) return [];
  const images = staged.filter((att) =>
    att.mimeType.toLowerCase().startsWith("image/"),
  );
  if (images.length === 0) return [];

  let totalBytes = 0;
  const args: string[] = [];
  for (const img of images) {
    // Approximate argv cost: flag name + path + null separators the kernel
    // adds between args. utf-8 covers macOS paths with non-ASCII chars.
    totalBytes += Buffer.byteLength("--image", "utf8") + 1;
    totalBytes += Buffer.byteLength(img.absolutePath, "utf8") + 1;
    args.push("--image", img.absolutePath);
  }

  if (totalBytes > budgetBytes) {
    logger.warn(
      { imageCount: images.length, totalBytes, budgetBytes },
      "Codex --image argv would exceed budget — dropping to staged-only references",
    );
    return [];
  }
  return args;
}

function extractCodexUsage(event: CodexEvent): BackendUsage | null {
  const usage = event.usage;
  if (!usage || typeof usage !== "object") {
    return null;
  }

  const totalInputTokens = readNumber(usage.input_tokens);
  const cacheReadInputTokens = readNumber(usage.cached_input_tokens);

  return {
    inputTokens: nonCachedInputTokens(totalInputTokens, cacheReadInputTokens),
    outputTokens: readNumber(usage.output_tokens),
    cacheCreationInputTokens: 0,
    cacheReadInputTokens,
  };
}

function nonCachedInputTokens(
  totalInputTokens: number,
  cacheReadInputTokens: number,
  cacheCreationInputTokens = 0,
): number {
  return Math.max(totalInputTokens - cacheReadInputTokens - cacheCreationInputTokens, 0);
}

/**
 * Codex reasoning detection — schema-defensive across naming variants.
 *
 * Reasoning summaries (GPT-5 family, codex 0.121+) surface in three
 * shapes we must drop before they reach `outputChunks` or
 * `streamCallbacks.onText`:
 *
 *  1. Outer event-level reasoning types from older codex builds —
 *     `agent_reasoning`, `agent_reasoning_delta`, …
 *  2. `item.completed` (or `item.started`) carrying the item type
 *     directly. The field name varies across codex versions: `type`,
 *     `item_type`, `kind` — all three are accepted defensively, same
 *     pattern as `extractCodexShellCall`'s multi-shape probe.
 *  3. `item.updated` deltas. The item type is usually only declared on
 *     `item.started` / `item.completed`; the streaming updates carry
 *     only `id` + `delta`. The caller must remember which item IDs are
 *     reasoning (`rememberReasoningItem`) and check IDs on every
 *     event (`shouldDropAsReasoning`).
 *
 * Keeping (2) and (3) separate from the shell-call audit guarantees
 * a reasoning event never reaches `extractMcpToolCall` /
 * `extractCodexShellCall` either — those helpers don't false-match on
 * reasoning shapes today, but the early return makes the contract
 * explicit.
 */
// Item types carried inside `event.item.type` / `item.item_type` /
// `item.kind` for events that wrap a reasoning summary.
//
// **Verified shapes** (covered by existing tests, observed in the
// wild): `reasoning` (codex 0.121+), `agent_reasoning` (older builds).
//
// **Defensive entries** (not yet confirmed from codex-rs source —
// additions are safe because the names are reasoning-specific enough
// that a false positive is implausible): `reasoning_summary` —
// plausible naming if
// codex-rs ever differentiates the summary item from the in-progress
// reasoning stream. Drop this entry if a future codex release
// repurposes the name for something else.
const CODEX_REASONING_ITEM_TYPES = new Set([
  "reasoning",
  "agent_reasoning",
  "reasoning_summary",
]);

// Outer-level `event.type` values that ALWAYS carry reasoning content
// (typically in `event.delta` / `event.text`, with no `event.item`
// wrapper, so item-id tracking does not catch them).
//
// **Verified shapes**: `agent_reasoning`, `agent_reasoning_delta`,
// `agent_reasoning_section_break` — emitted by older codex builds and
// covered by the existing reasoning-filter regression tests.
//
// **Defensive entries** (NOT confirmed against codex-rs source,
// included because the bug surface is real and the false-positive risk
// is near-zero given how reasoning-specific the names are): the
// `response.reasoning_summary_*` family follows
// OpenAI's Responses API streaming schema, which codex CLI is known
// to relay verbatim in some configurations (GPT-5 / o-series models
// against certain backends). The bare `reasoning_*` short forms hedge
// against codex pre-release variants. If any of these conflict with a
// future non-reasoning event type, remove only the conflicting entry
// — the verified set above is the load-bearing minimum.
const CODEX_REASONING_OUTER_EVENT_TYPES = new Set([
  "agent_reasoning",
  "agent_reasoning_delta",
  "agent_reasoning_section_break",
  "response.reasoning_summary_text.delta",
  "response.reasoning_summary_text.done",
  "response.reasoning_summary_part.added",
  "response.reasoning_summary_part.done",
  "response.reasoning.delta",
  "response.reasoning.done",
  "reasoning_delta",
  "reasoning_section_break",
]);

function readCodexItemId(event: CodexEvent): string | null {
  const item = event.item;
  if (!item || typeof item !== "object") return null;
  const id = (item as { id?: unknown }).id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

function readCodexItemTypeName(event: CodexEvent): string | null {
  const item = event.item;
  if (!item || typeof item !== "object") return null;
  const bag = item as Record<string, unknown>;
  for (const key of ["type", "item_type", "kind"] as const) {
    const value = bag[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

function rememberReasoningItem(
  event: CodexEvent,
  reasoningItemIds: Set<string>,
): void {
  const id = readCodexItemId(event);
  if (!id) return;
  const typeName = readCodexItemTypeName(event);
  if (typeName && CODEX_REASONING_ITEM_TYPES.has(typeName)) {
    reasoningItemIds.add(id);
  }
}

function shouldDropAsReasoning(
  event: CodexEvent,
  reasoningItemIds: Set<string>,
): boolean {
  if (event.type && CODEX_REASONING_OUTER_EVENT_TYPES.has(event.type)) {
    return true;
  }
  const typeName = readCodexItemTypeName(event);
  if (typeName && CODEX_REASONING_ITEM_TYPES.has(typeName)) {
    return true;
  }
  const id = readCodexItemId(event);
  if (id && reasoningItemIds.has(id)) {
    return true;
  }
  return false;
}

function extractCodexText(event: CodexEvent): string {
  if (typeof event.output_text === "string") {
    return event.output_text;
  }
  if (typeof event.delta === "string") {
    return event.delta;
  }
  if (typeof event.text === "string") {
    return event.text;
  }
  const item = event.item;
  if (!item || typeof item !== "object") {
    return "";
  }
  if (typeof item.delta === "string") {
    return item.delta;
  }
  if (typeof item.text === "string") {
    return item.text;
  }
  return "";
}

function isLikelyCodexFailure(line: string): boolean {
  return /error|failed|unauthorized|forbidden|rate limit|quota/i.test(line);
}

/**
 * Copy any string-valued subprocess-output fields from a Codex JSONL event's
 * `item` into the given sink. Codex emits tool/command output under a small
 * set of well-known fields; we scan these (not the whole event graph) so that
 * a command echo like `echo PA_API_ERROR` never false-positives on the
 * command-text itself.
 */
/**
 * Detect an MCP tool call in a Codex JSONL event. Returns null when the
 * event does not describe an MCP invocation (plain function calls, text
 * deltas, turn events, etc.). Two shapes are recognised:
 *
 *  1. Items whose `name` matches the cross-runtime `mcp__<server>__<tool>`
 *     convention. This is the form emitted by Codex's function-call items
 *     when the underlying tool is an MCP export.
 *  2. Items that declare `server` + `tool` (or `server_label` + `name`)
 *     fields directly. Surfaced by newer Codex builds for MCP tools and
 *     preferred when present because no string parsing is required.
 *
 * Logging is fire-and-forget — unparseable inputs silently return null so
 * benign shape changes upstream don't spam the log.
 */
function extractMcpToolCall(
  event: CodexEvent,
): { serverId: string; toolName: string } | null {
  const item = event.item;
  if (!item || typeof item !== "object") return null;
  const bag = item as Record<string, unknown>;

  const serverField =
    typeof bag.server === "string"
      ? bag.server
      : typeof bag.server_label === "string"
        ? bag.server_label
        : null;
  const toolField =
    typeof bag.tool === "string"
      ? bag.tool
      : typeof bag.tool_name === "string"
        ? bag.tool_name
        : null;
  if (serverField && toolField) {
    return { serverId: serverField, toolName: toolField };
  }

  const name =
    typeof bag.name === "string"
      ? bag.name
      : typeof bag.tool_name === "string"
        ? bag.tool_name
        : null;
  if (name) {
    const parsed = parseMcpToolName(name);
    if (parsed) return parsed;
  }

  return null;
}

function collectCodexItemText(event: CodexEvent, sink: string[]): void {
  const item = event.item;
  if (!item || typeof item !== "object") return;
  const fields = ["output", "stdout", "stderr", "aggregated_output"] as const;
  for (const key of fields) {
    const value = (item as Record<string, unknown>)[key];
    if (typeof value === "string" && value.length > 0) {
      sink.push(value);
    }
  }
}

function firstFailureLine(lines: string[]): string | null {
  const line = lines.find((candidate) => isLikelyCodexFailure(candidate));
  return line?.trim() ?? null;
}

function readNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
