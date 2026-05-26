/**
 * docs/design/appendices/opencode-backend.md §6.2 — `IAgentCore` implementation backed by
 * the `@opencode-ai/sdk` HTTP server.
 *
 * Surface:
 *   - `execute()` end-to-end against the managed server (loopback)
 *   - `executeResume()` reuses an existing opencode session id so the
 *     dispatcher's multi-turn DM / dashboard-chat / docs-QA path can
 *     own opencode as main backend (see
 *     `docs/design/appendices/opencode-execute-resume.md`)
 *   - Streaming text deltas relayed through the StreamCallbacks
 *   - Cost / token telemetry from `client.session.get(...).data`,
 *     scoped to a per-turn delta when resuming (pre-turn snapshot
 *     subtracted from post-turn cumulative)
 *   - `summarize()` V11 round-trip
 *   - `runDelegatedTask()` via spawnEphemeral (Path A)
 *   - Stub for `runDelegatedTool` (by design — opencode delegation
 *     routes through `runDelegatedTask`)
 *   - Per-execute wall-clock abort via `AbortController` →
 *     `client.session.abort()`
 */

import { randomUUID } from "node:crypto";
import {
  defaultApiKeyProvider,
  isAutonomousProcessKey,
  isMessageEvent,
  type AgentResult,
  type BackendCostSource,
  type BackendModel,
  type BackendUsage,
  type OpencodeRuntimeConfig,
  type ProcessKey,
} from "@aitne/shared";
import type { AgentConfig } from "../../config.js";
import { getContextDir } from "../../config.js";
import {
  cleanupSessionWorkdir,
  createSessionWorkdir,
} from "../workdir.js";
import { resolveUserSkillsRoot } from "../user-skills-root.js";
import type { AgentWriteTracker } from "../../safety/agent-write-tracker.js";
import {
  auditStreamObservation,
  extractOpencodeToolUseTarget,
} from "../../safety/subprocess-block-scanner.js";
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
  StreamCallbacks,
} from "../agent-core.js";
import {
  BackendDecisiveFailure,
  DelegatedToolUnsupportedError,
  LiveProbeUnsupportedError,
  TaskModeUnsupportedError,
  classifyAbortReason,
} from "../agent-core.js";
import { matchRunAllowedToolPattern } from "@aitne/shared";
import {
  emptyCost,
  withDurationMs,
} from "../../services/delegated-tool-runtime.js";
import {
  DEFAULT_OPENCODE_LITE_MODEL,
  findRegisteredModel,
  getModelsForBackend,
} from "./model-registry.js";
import { PriceFetcher } from "./price-fetcher.js";
import { buildExecutionPrompt } from "./prompt-utils.js";
import {
  extractAssistantTextFromParts,
  extractToolUsesFromParts,
  isMessageAborted,
  isTerminal,
  normalize,
  type OpencodeNormalizedEvent,
} from "./opencode-event-mapper.js";
import {
  buildOpencodeRuntimeConfig,
  defensiveInstructionsFromEnv,
} from "./opencode-config-builder.js";
import { renderOpencodeMcp } from "./opencode-mcp.js";
import type { OpencodeServerManager } from "./opencode-server-manager.js";
import type { RawOpencodeEvent } from "./opencode-types.js";
import { listMcpServers, resolveMcpSecrets } from "../../services/mcp/registry.js";
import { buildMcpDisallowedTools } from "../../services/mcp/risk.js";
import { createLogger } from "../../logging.js";

/** Shorthand for the SDK-shaped client returned by the manager. Used for
 *  the few inline awaited-promise type annotations below. */
type OpencodeClientLike = Awaited<ReturnType<OpencodeServerManager["client"]>>;

const logger = createLogger("opencode-core");

const EMPTY_USAGE: BackendUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
};

/**
 * Internal `runTurn` params. Widens `AgentExecuteParams` with the two
 * opencode-specific flags `executeResume` needs to flip:
 *
 *   - `resumeSessionId`: when set, runTurn skips `session.create` and
 *     re-enters the existing opencode session via
 *     `session.prompt({ path: { id } })`. `prompt` is sent verbatim
 *     (no `buildExecutionPrompt` wrap — the system prompt and history
 *     are already inside the server session). The post-turn
 *     `session.get()` is converted to a per-turn delta by subtracting
 *     a pre-turn snapshot, so resume cost is the turn's contribution
 *     rather than the cumulative session aggregate.
 *
 * Out of scope: the `bareMessage` flag could be split out, but is
 * 1:1 with `resumeSessionId` today — keeping a single signal keeps
 * the runTurn branching minimal.
 */
type OpencodeTurnParams = AgentExecuteParams & {
  resumeSessionId?: string;
};

/**
 * Provider/model parse for the SDK's `body.model = { providerID, modelID }`
 * shape. opencode encodes the composite as `providerID/modelID` — note
 * the model id itself may contain slashes (e.g. `openai/gpt-oss-20b:free`
 * on OpenRouter), so we only split on the FIRST `/`.
 */
export function parseModelComposite(
  composite: string,
): { providerID: string; modelID: string } | null {
  const slash = composite.indexOf("/");
  if (slash <= 0 || slash === composite.length - 1) {
    return null;
  }
  return {
    providerID: composite.slice(0, slash),
    modelID: composite.slice(slash + 1),
  };
}

/** Five-minute TTL for the live-models cache. The live picker hits this
 *  on every dashboard load; 5 min matches the `client.config.providers()`
 *  poll cadence and keeps the SDK call out of the hot path. */
const LIVE_MODELS_CACHE_TTL_MS = 5 * 60 * 1000;

type RawOpencodeProviderModel = {
  name?: string;
  family?: string;
  status?: string;
  capabilities?: {
    toolcall?: boolean;
    attachment?: boolean;
    reasoning?: boolean;
  };
  cost?: { input?: number; output?: number };
  limit?: { context?: number; output?: number };
};

export interface LiveOpencodeModel {
  /** Composite the daemon stores in `process_backend_config.main_model`. */
  modelId: string;
  /** Model id without the provider prefix, for display. */
  shortId: string;
  name: string;
  family: string;
  tier: "lite" | "medium" | "high";
  supportsToolUse: boolean;
  supportsAttachment: boolean;
  supportsReasoning: boolean;
  maxInputTokens: number | null;
  maxOutputTokens: number | null;
  usdPer1kIn: number | null;
  usdPer1kOut: number | null;
  isFree: boolean;
  status: string;
}

export interface LiveOpencodeProviderGroup {
  id: string;
  name: string;
  source: string;
  models: LiveOpencodeModel[];
}

export interface LiveOpencodeModelsResponse {
  providers: LiveOpencodeProviderGroup[];
  fetchedAt: string;
  cached: boolean;
}

/**
 * Heuristic tier inference for live models. opencode's catalogue has no
 * native tier concept, so we mirror the daemon's registry thresholds
 * (in/out per 1kTok):
 *   - haiku-4.5:  $0.001 / $0.005   → lite
 *   - gpt-5.4:    $0.0025 / $0.015  → medium
 *   - sonnet-4.6: $0.003 / $0.015   → medium
 *   - gpt-5.5:    $0.005 / $0.03    → high (Opus-class, see registry comment)
 *   - opus-4.7:   $0.015 / $0.075   → high
 *
 * A pure input-rate threshold mis-buckets gpt-5.5 (in=$0.005 sits at the
 * medium boundary but its $30/MTok output is Opus-class). We therefore
 * check input AND output — promote to the higher tier if either rate
 * crosses its threshold.
 *
 * `null` input means cost is unknown (SDK omitted `cost.input`). Treat
 * unknown ≠ free: default to "medium" so an undocumented model is not
 * silently routed to lite-tier surfaces. Free → lite is preserved.
 */
function inferModelTier(
  usdPer1kIn: number | null,
  usdPer1kOut: number | null,
  isFree: boolean,
): "lite" | "medium" | "high" {
  if (isFree) return "lite";
  if (usdPer1kIn === null && usdPer1kOut === null) return "medium";
  const inRate = usdPer1kIn ?? 0;
  const outRate = usdPer1kOut ?? 0;
  // High: Opus-class. gpt-5.5 (in $0.005, out $0.03) qualifies on out alone.
  if (inRate >= 0.005 || outRate >= 0.03) return "high";
  // Medium: Sonnet-class. Sonnet (in $0.003, out $0.015) qualifies on either.
  if (inRate >= 0.002 || outRate >= 0.01) return "medium";
  return "lite";
}

export class OpencodeCore implements IAgentCore {
  readonly backendId = "opencode" as const;

  private liveModelsCache:
    | { fetchedAtMs: number; payload: LiveOpencodeModelsResponse }
    | null = null;
  /** Coalesce parallel `listLiveModels()` calls onto a single SDK round-trip.
   *  Mirrors the inflight pattern in `ManagedOpencodeServerManager.spawn()`
   *  so a dashboard burst (picker open + RQ background refresh) doesn't
   *  multiply `client.config.providers()` calls. */
  private liveModelsInflight: Promise<LiveOpencodeModelsResponse> | null = null;
  private readToken: string | undefined;
  private readTokenManager: ReadSensitiveTokenManager | undefined;
  private mcpContext: McpSessionContext | undefined;

  constructor(
    private readonly config: AgentConfig,
    private readonly writeTracker: AgentWriteTracker,
    private readonly serverManager: OpencodeServerManager,
    private readonly priceFetcher = new PriceFetcher(config.dataDir),
  ) {}

  setReadToken(token: string): void {
    this.readToken = token;
  }

  setReadTokenManager(manager: ReadSensitiveTokenManager): void {
    this.readTokenManager = manager;
  }

  setMcpContext(context: McpSessionContext): void {
    this.mcpContext = context;
  }

  /**
   * Materialises a session workdir, ensures the server is running with
   * the desired runtime config, opens a fresh session via the SDK, then
   * runs prompt + event-stream consumption in parallel. Per-execute
   * timeout cancels the inflight prompt via `client.session.abort()`.
   */
  async execute(
    params: AgentExecuteParams,
    streamCallbacks?: StreamCallbacks,
  ): Promise<AgentResult> {
    return this.runTurn(params, streamCallbacks);
  }

  /**
   * Resume a prior turn against an existing opencode session id. The
   * dispatcher reaches this when `conversation_sessions.backend_session_id`
   * was previously written by `execute()`. opencode persists sessions on
   * disk, so the same id stays addressable across server restarts; we
   * skip `session.create` and re-enter via `session.prompt({ path: { id } })`.
   *
   * Design: `docs/design/appendices/opencode-execute-resume.md`.
   */
  async executeResume(
    params: AgentResumeParams,
    streamCallbacks?: StreamCallbacks,
  ): Promise<AgentResult> {
    if (!params.sessionDir) {
      throw new Error(
        "sessionDir is required for executeResume — workdir holds MCP / skill files the server reads",
      );
    }
    return this.runTurn(
      {
        prompt: params.message,
        context: "",
        // Synthetic event for log telemetry only — resume never re-renders
        // a task-flow prompt (the bareMessage branch sends params.message
        // verbatim through `session.prompt`).
        event: {
          type: "message.received",
          source: "platform",
          priority: 2,
          timestamp: new Date(),
          data: {},
          correlationId: params.eventCorrelationId ?? "resume",
        } as AgentExecuteParams["event"],
        modelId: params.modelId,
        maxTurns: params.maxTurns ?? 50,
        maxBudgetUsd: params.maxBudgetUsd ?? 1.0,
        sessionDir: params.sessionDir,
        ...(params.sessionDbId !== undefined
          ? { sessionDbId: params.sessionDbId }
          : {}),
        ...(params.turnToken ? { turnToken: params.turnToken } : {}),
        ...(params.stagedAttachments && params.stagedAttachments.length > 0
          ? { stagedAttachments: params.stagedAttachments }
          : {}),
        webSearchEnabled: params.webSearchEnabled ?? false,
        resumeSessionId: params.sessionId,
      },
      streamCallbacks,
    );
  }

  /**
   * docs/design/appendices/opencode-backend.md §6.2 / §10 D5 / V11 — opencode-side
   * summarisation flow.
   *
   *   1. Open a transient session so the server has a conversation it
   *      can summarise (opencode requires non-empty message history
   *      before `session.summarize` will produce a body).
   *   2. Prompt with the conversation text under the lite-tier model
   *      (`DEFAULT_OPENCODE_LITE_MODEL`) — small_model isn't honoured
   *      here because Aitne disables `task` (V8) so opencode's own
   *      subagent path never picks small_model up. Cheap & quick on the
   *      same provider as the active turn.
   *   3. Call `client.session.summarize({ path: { id }, body: { providerID, modelID } })`
   *      — body is FLAT, NOT nested in a `model` wrapper (V11 contract).
   *      Returns `{ data: true }` on HTTP 200; the actual summary lands
   *      as a new assistant message with `info.summary === true`.
   *   4. Read `client.session.messages({ path: { id } })` and pick the
   *      LAST assistant message with `info.summary === true`. Join its
   *      text parts as the markdown summary. (Do NOT read
   *      `session.get(...).data.summary` — V11 fixture confirms that
   *      field is the diff stat block `{ additions, deletions, files }`,
   *      not text.)
   *   5. Best-effort `session.delete()` in a `finally` so the transient
   *      session row doesn't accumulate on disk.
   *
   * Falls back to a truncated slice on any failure so a caller flowing
   * through a fallback chain still gets *something* — matching the
   * Codex/Gemini summarize contract (return string, never throw).
   */
  async summarize(text: string): Promise<string> {
    const truncated = text.length > 4096 ? text.slice(0, 4096) : text;
    if (!text.trim()) {
      return text;
    }

    let client: OpencodeClientLike;
    try {
      client = await this.serverManager.client();
    } catch (err) {
      logger.warn(
        { err },
        "opencode summarize: server unavailable; returning truncated text",
      );
      return truncated;
    }

    const lite = DEFAULT_OPENCODE_LITE_MODEL;
    const liteParts = parseModelComposite(lite);
    if (!liteParts) {
      // Defensive — DEFAULT_OPENCODE_LITE_MODEL ships in `provider/model`
      // form; a future regression that breaks the format should not
      // wedge summarisation, just degrade to the truncation fallback.
      logger.warn(
        { lite },
        "opencode summarize: lite-model id is malformed; falling back to truncation",
      );
      return truncated;
    }

    let sessionId: string | null = null;
    try {
      const created = await client.session.create({
        body: { title: `aitne:summarize:${randomUUID().slice(0, 8)}` },
      });
      sessionId = created.data?.id ?? null;
      if (!sessionId) {
        return truncated;
      }

      // Prime the session with the text we want summarised. `noReply`
      // would be ideal but opencode 1.14.50 still requires a model turn
      // before `session.summarize` produces output, so let the model
      // produce a short ack — its body is discarded, only the
      // subsequent summary message is read.
      await client.session.prompt({
        path: { id: sessionId },
        body: {
          model: liteParts,
          parts: [
            {
              type: "text",
              text: `Acknowledge with "ok" and stop. Conversation to summarise next:\n\n${text}`,
            },
          ],
        },
      });

      // V11 contract — flat body, NOT nested under `model`.
      await client.session.summarize({
        path: { id: sessionId },
        body: {
          providerID: liteParts.providerID,
          modelID: liteParts.modelID,
        },
      } as Parameters<typeof client.session.summarize>[0]);

      const messagesResp = await client.session.messages({
        path: { id: sessionId },
      });
      const messages =
        (messagesResp.data as Array<{
          info?: { role?: string; summary?: boolean };
          parts?: unknown;
        }>) ?? [];
      const summaryMsg = [...messages]
        .reverse()
        .find(
          (m) =>
            m.info?.role === "assistant" && m.info?.summary === true,
        );
      if (!summaryMsg) {
        logger.debug(
          { sessionId },
          "opencode summarize: no assistant summary message found",
        );
        return truncated;
      }
      const summaryText = extractAssistantTextFromParts(summaryMsg.parts).trim();
      return summaryText.length > 0 ? summaryText : truncated;
    } catch (err) {
      logger.warn(
        { err, sessionId },
        "opencode summarize: SDK call failed; returning truncated text",
      );
      return truncated;
    } finally {
      if (sessionId) {
        try {
          await client.session.delete({ path: { id: sessionId } });
        } catch (err) {
          logger.debug(
            { err, sessionId },
            "opencode summarize: transient session.delete failed",
          );
        }
      }
    }
  }

  /**
   * Lightweight auth presence check. Mirrors Codex's pattern: prefer a
   * keychain-mirrored env var (`OPENCODE_SERVER_PASSWORD` for remote);
   * for the managed loopback server, the daemon owns the credentials so
   * "configured" is sufficient. The deeper "is the provider key
   * accepted?" check is exercised by `checkAuthDetailed`.
   */
  async checkAuth(): Promise<
    | { ok: true; method: "cli_login" | "api_key" | "oauth" | "vertex" }
    | { ok: false; reason: string }
  > {
    try {
      const client = await this.serverManager.client();
      const providersResult = await client.config.providers();
      if (!providersResult.data) {
        return { ok: false, reason: "opencode server did not return providers" };
      }
      const providerCount = providersResult.data.providers.length;
      if (providerCount === 0) {
        return {
          ok: false,
          reason:
            "No providers configured on the opencode server. Run `opencode auth login` to add one.",
        };
      }
      // Managed loopback ⇒ the daemon owns the server; an external API key
      // is configured on the opencode side, so we surface that as `api_key`.
      return { ok: true, method: "api_key" };
    } catch (err) {
      return {
        ok: false,
        reason: err instanceof Error ? err.message : "opencode auth probe failed",
      };
    }
  }

  async checkAuthDetailed(): Promise<AuthCheckResult> {
    const inner = await this.checkAuth();
    if (inner.ok) {
      return { ok: true, status: "ok", method: inner.method };
    }
    return {
      ok: false,
      status: "expired",
      method: defaultApiKeyProvider(this.backendId) === "opencode-server"
        ? "api_key"
        : "cli_login",
      detail: inner.reason,
      recoveryCommand: "opencode auth login",
    };
  }

  /**
   * Phase 5 §4.11 — opencode does NOT expose namespaced `mcp__*` tool
   * names through `client.tool.ids()` in 1.14.50 (V7 fixture confirms).
   * Live probe is therefore unsupported on this backend in v1; the
   * route surfaces this as a 501 with a targeted message. Phase 5+ may
   * unlock once `mcp.status()`/`tool.list()` surfaces MCP tools.
   */
  async probeTools(): Promise<string[]> {
    throw new LiveProbeUnsupportedError(
      this.backendId,
      "opencode 1.14.50 does not surface MCP tool ids via tool.ids()",
    );
  }

  /**
   * Static-registry first; Phase 6 (§6.6.2 wizard probe) extends this
   * via `serverManager.listModels()` once the live-server enumeration
   * lands. Today the registry seed is sufficient for `BackendRouter`
   * bindings.
   */
  listModels(): ReadonlyArray<BackendModel> {
    return getModelsForBackend(this.backendId);
  }

  /**
   * Live model enumeration over `client.config.providers()`. Returns the
   * full catalogue an operator can pick from — every provider the live
   * opencode server has credentials for, with capability + cost metadata.
   * Cached in-memory for 5 minutes so the picker doesn't re-bounce the
   * server on every keystroke.
   *
   * Security: the raw `client.config.providers()` response includes
   * `provider.key` (plaintext API key). This method NEVER returns that
   * field — the caller surfaces what's projected here, not the raw SDK
   * response.
   */
  async listLiveModels(
    options: { forceRefresh?: boolean } = {},
  ): Promise<LiveOpencodeModelsResponse> {
    const now = Date.now();
    const cached = this.liveModelsCache;
    if (
      !options.forceRefresh
      && cached
      && now - cached.fetchedAtMs < LIVE_MODELS_CACHE_TTL_MS
    ) {
      return { ...cached.payload, cached: true };
    }
    // Coalesce: if a fetch is already in flight, share its result. This
    // applies to refresh=true as well — getting the freshest in-flight
    // result is strictly better than spawning a redundant SDK call.
    if (this.liveModelsInflight) {
      return this.liveModelsInflight;
    }
    this.liveModelsInflight = this.fetchLiveModels(now);
    try {
      return await this.liveModelsInflight;
    } finally {
      this.liveModelsInflight = null;
    }
  }

  private async fetchLiveModels(
    requestedAtMs: number,
  ): Promise<LiveOpencodeModelsResponse> {
    const client = await this.serverManager.client();
    const res = await client.config.providers();
    const providers = res.data?.providers ?? [];
    const projected: LiveOpencodeModelsResponse["providers"] = providers.map(
      (p) => ({
        id: p.id,
        name: p.name,
        source: p.source ?? "unknown",
        models: Object.entries(p.models ?? {})
          .filter(([, m]) => (m as { status?: string }).status !== "deprecated")
          .map(([mid, mRaw]) => {
            const m = mRaw as RawOpencodeProviderModel;
            const usdPer1kIn =
              typeof m.cost?.input === "number" ? m.cost.input / 1000 : null;
            const usdPer1kOut =
              typeof m.cost?.output === "number" ? m.cost.output / 1000 : null;
            const isFree =
              (m.cost?.input ?? 0) === 0 && (m.cost?.output ?? 0) === 0;
            return {
              modelId: `${p.id}/${mid}`,
              shortId: mid,
              name: m.name ?? mid,
              family: m.family ?? "",
              tier: inferModelTier(usdPer1kIn, usdPer1kOut, isFree),
              supportsToolUse: m.capabilities?.toolcall === true,
              supportsAttachment: m.capabilities?.attachment === true,
              supportsReasoning: m.capabilities?.reasoning === true,
              maxInputTokens: m.limit?.context ?? null,
              maxOutputTokens: m.limit?.output ?? null,
              usdPer1kIn,
              usdPer1kOut,
              isFree,
              status: m.status ?? "active",
            };
          })
          .sort((a, b) => a.shortId.localeCompare(b.shortId)),
      }),
    );
    const payload: LiveOpencodeModelsResponse = {
      providers: projected,
      fetchedAt: new Date(requestedAtMs).toISOString(),
      cached: false,
    };
    this.liveModelsCache = { fetchedAtMs: requestedAtMs, payload };
    return payload;
  }

  async runDelegatedTool(
    _params: DelegatedToolInvokeParams,
  ): Promise<DelegatedToolResult> {
    throw new DelegatedToolUnsupportedError(
      this.backendId,
      "use runDelegatedTask (Phase 4)",
    );
  }

  async runDelegatedTask(
    params: DelegatedTaskInvokeParams,
  ): Promise<DelegatedTaskResultRaw> {
    if (this.serverManager.mode === "remote") {
      // docs/design/appendices/opencode-backend.md §5.9 — Remote mode cannot host
      // tight-permission ephemeral servers and the daemon does not own
      // the agent-file write seat. Surface the canonical sentinel so the
      // delegated-task invoker treats this as 501 / `task_mode_unsupported`
      // and the BackendRouter falls back to a Managed backend.
      throw new TaskModeUnsupportedError(this.backendId);
    }
    return this.runDelegatedTaskAgainstEphemeral(params);
  }

  // ── private ──

  private async runTurn(
    params: OpencodeTurnParams,
    streamCallbacks?: StreamCallbacks,
  ): Promise<AgentResult> {
    this.assertPromptWithinMaxBudget(params.prompt, params.maxBudgetUsd, params.modelId);

    const resumeSessionId = params.resumeSessionId;
    const isResume = resumeSessionId !== undefined;
    if (isResume && !params.sessionDir) {
      // executeResume already gates this, but be defensive — runTurn is
      // private and may grow new callers.
      throw new Error(
        "runTurn(resumeSessionId): sessionDir is required when resuming",
      );
    }

    const startMs = Date.now();
    const sessionDir = params.sessionDir ?? createSessionWorkdir(
      this.config.workspaceDir,
      params.event.type,
      resolveUserSkillsRoot(this.config),
      {
        backendId: this.backendId,
        ...(params.processKey ? { processKey: params.processKey } : {}),
        character: this.config.character,
        contextDir: getContextDir(this.config),
        // docs/design/appendices/skills-unification.md Phase 4 — feed the conditional
        // manifest predicates. `db` comes through `setMcpContext`; the
        // inbound DM text (when present) lets the *ForDm trigger-phrase
        // fallback drop `gmail-lifestyle` / `managed-tasks` for DMs that
        // have no DB rows AND no trigger phrase.
        ...(this.mcpContext?.db ? { db: this.mcpContext.db } : {}),
        ...(isMessageEvent(params.event) ? { messageText: params.event.content } : {}),
      },
    );
    const ownsSessionDir = !params.sessionDir;
    // NOTE: opencode SDK runs the server in-process (createOpencode does
    // not spawn a subprocess and exposes no per-tool env hook), so the
    // issued token is not yet injected into bash-tool invocations the way
    // Claude / Codex / Gemini do via `buildDaemonApiCliEnv`. The
    // issue/revoke pair stays correct because event-pipeline.ts wires
    // `setReadTokenManager` on all four cores — when an env-injection
    // path lands here, replace this comment with the wiring rather than
    // re-introducing the silent-undefined gap.
    const issuedReadToken =
      this.readTokenManager?.issue(sessionDir) ?? this.readToken;

    try {
      const { config: runtimeConfig, warnings: configWarnings } =
        await this.buildRuntimeConfig(params);
      if (configWarnings.length > 0) {
        // Surface translator + MCP-renderer notices so a same-envelope
        // bounce that drops Edit patterns or rejects MCP server names
        // shows up in operator logs, not just buried in the dashboard
        // tile (which materialises later via /health).
        logger.info(
          { warnings: configWarnings, eventType: params.event.type },
          "opencode runtime config emitted with translator warnings",
        );
      }
      await this.serverManager.ensureConfig(runtimeConfig);
      const client = await this.serverManager.client();

      // Pre-flight: a missing provider key is the most common boot-time
      // failure and surfaces as `session.error` mid-stream. Catch it here
      // so the router fails over to a fallback backend rather than
      // streaming a half-complete response.
      const auth = await this.checkAuth();
      if (!auth.ok) {
        throw new BackendDecisiveFailure(
          this.backendId,
          "auth",
          new Error(auth.reason),
        );
      }

      const modelParts = parseModelComposite(params.modelId);
      if (!modelParts) {
        throw new BackendDecisiveFailure(
          this.backendId,
          "model_unavailable",
          new Error(
            `opencode model id must be in 'provider/model' form, got '${params.modelId}'`,
          ),
        );
      }

      // Session lifecycle — opencode keeps sessions on disk; we delete
      // when we own the workdir (transient sessions). `title` is best-
      // effort metadata only. On resume we re-enter an existing session
      // id; `session.create` is skipped entirely.
      let sessionId: string;
      if (isResume) {
        sessionId = resumeSessionId!;
      } else {
        const sessionTitle = `aitne:${params.event.type}:${randomUUID().slice(0, 8)}`;
        const created = await client.session.create({
          body: { title: sessionTitle },
        });
        const createdId = created.data?.id ?? null;
        if (!createdId) {
          throw new BackendDecisiveFailure(
            this.backendId,
            "other_non_retryable",
            new Error("opencode session.create returned no id"),
          );
        }
        sessionId = createdId;
      }

      // Resume cost-delta — snapshot the session's cumulative cost +
      // tokens before sending the new prompt. After the turn completes
      // the post-turn `session.get()` aggregate is subtracted from this
      // baseline so `AgentResult.costUsd` reflects this turn's
      // contribution rather than the whole-session total. For first
      // execute these stay zero and the math collapses.
      let preTurnCost = 0;
      let preTurnUsage: BackendUsage = { ...EMPTY_USAGE };
      if (isResume) {
        try {
          const preInfo = await client.session.get({ path: { id: sessionId } });
          const preAgg = preInfo.data as
            | {
                cost?: number;
                tokens?: {
                  input?: number;
                  output?: number;
                  reasoning?: number;
                  cache?: { read?: number; write?: number };
                };
              }
            | undefined;
          if (typeof preAgg?.cost === "number") {
            preTurnCost = preAgg.cost;
          }
          if (preAgg?.tokens) {
            preTurnUsage = {
              inputTokens: preAgg.tokens.input ?? 0,
              outputTokens: preAgg.tokens.output ?? 0,
              cacheCreationInputTokens: preAgg.tokens.cache?.write ?? 0,
              cacheReadInputTokens: preAgg.tokens.cache?.read ?? 0,
            };
          }
        } catch (err) {
          // 404 / stale session — let session.prompt below surface the
          // real failure with a clean classification. Pre-snapshot
          // failure is a best-effort cost-attribution miss only.
          logger.debug(
            { err, sessionId },
            "opencode resume: pre-turn session.get failed; cost may include prior turns",
          );
        }
      }

      // AbortController owns both the event stream and the prompt call
      // so per-execute timeout collapses them together.
      const abortController = new AbortController();
      const timeoutMs = this.config.executeTimeoutMinutes * 60 * 1000;
      const timeoutId = setTimeout(async () => {
        abortController.abort(new Error("opencode execute wall-clock timeout"));
        try {
          await client.session.abort({ path: { id: sessionId } });
        } catch (err) {
          logger.warn({ err, sessionId }, "opencode session abort failed");
        }
      }, timeoutMs);

      // §5.1 ordering invariant — `event.subscribe()` MUST complete before
      // `session.prompt()` is sent, otherwise early `message.part.delta`
      // events are emitted into a not-yet-bound stream and lost. Awaiting
      // the subscription here (rather than letting `consumeEventStream`
      // do it concurrently with the prompt below) collapses the race.
      let subscription: Awaited<ReturnType<OpencodeClientLike["event"]["subscribe"]>>;
      try {
        subscription = await client.event.subscribe({
          signal: abortController.signal,
        });
      } catch (err) {
        clearTimeout(timeoutId);
        throw new BackendDecisiveFailure(
          this.backendId,
          "other_non_retryable",
          err instanceof Error
            ? err
            : new Error("opencode event.subscribe failed"),
        );
      }

      let streamedAnyText = false;
      const eventConsumer = this.consumeEventStream({
        stream: subscription.stream,
        sessionId,
        signal: abortController.signal,
        onText: (text) => {
          streamedAnyText = true;
          streamCallbacks?.onText?.(text);
        },
      });

      // Resume sends the user's reply verbatim — the system prompt and
      // conversation history are already inside the opencode server
      // session, so wrapping with `buildExecutionPrompt` would re-emit
      // the task-flow framing and confuse the model.
      const renderedPrompt = isResume
        ? params.prompt
        : buildExecutionPrompt(
            params.prompt,
            params.context,
            params.event,
            params.conversationHistory,
          );

      // docs/design/appendices/opencode-backend.md §4 / Phase 4 — `routine.hourly_check.triage`
      // returns a strict JSON envelope (`{ "action": "log_only" |
      // "escalate", … }`) parsed by `parseStage2Verdict`. opencode's
      // `format: { type: "json_schema", … }` honours the schema with
      // built-in retryCount=2, and the parsed object lands at
      // `info.structured` (V4 contract — NOT in text parts). We
      // stringify it back to text so the dispatcher's existing parser
      // (text-based across all backends) keeps working.
      const structuredFormat = formatForProcessKey(params.processKey);

      try {
        let promptResult: Awaited<ReturnType<OpencodeClientLike["session"]["prompt"]>>;
        try {
          // Cast through OpencodeAugmentedPromptBody — the SDK's body
          // type omits `format` even though opencode 1.14.50 honours it
          // at runtime (V4). Without the cast TypeScript rejects the
          // optional field.
          const promptBody = {
            model: modelParts,
            parts: [{ type: "text", text: renderedPrompt }],
            ...(structuredFormat ? { format: structuredFormat } : {}),
          } as unknown as Parameters<OpencodeClientLike["session"]["prompt"]>[0]["body"];
          promptResult = await client.session.prompt({
            path: { id: sessionId },
            body: promptBody,
          });
        } catch (promptErr) {
          // Fast-fail (network error, transport-level failure): without
          // this branch the consumer would await `session.idle` for the
          // full `executeTimeoutMinutes` because the server never started
          // the turn. Abort the subscribe stream so the for-await loop
          // exits and the consumer's promise resolves; THEN drain so any
          // already-buffered tool calls are still observed before we
          // re-throw.
          abortController.abort(
            promptErr instanceof Error
              ? promptErr
              : new Error("opencode session.prompt failed"),
          );
          await eventConsumer.catch(() => undefined);
          throw promptErr;
        }
        // The stream usually terminates on `session.idle` before the
        // prompt resolves, but in race orderings the prompt response can
        // arrive first. Wait for the stream to drain so we observe every
        // tool call.
        const collected = await eventConsumer;

        clearTimeout(timeoutId);

        // Distinguish a clean abort from a server-side error or successful
        // turn. opencode signals abort via `info.error.name`, not a
        // dedicated event.
        const assistantMessage = promptResult.data?.info;
        if (
          assistantMessage?.error?.name === "MessageAbortedError"
          || isMessageAborted(collected.terminalEvent)
        ) {
          throw new BackendDecisiveFailure(
            this.backendId,
            "timeout",
            new Error("opencode session aborted (likely wall-clock timeout)"),
          );
        }
        if (assistantMessage?.error) {
          throw classifyAssistantError(assistantMessage.error, this.backendId);
        }
        if (collected.terminalEvent?.kind === "session_error") {
          throw classifyStreamError(
            collected.terminalEvent.error,
            this.backendId,
          );
        }

        const partsForExtraction =
          (promptResult.data?.parts as unknown) ?? [];

        // V4 — when `format.type === "json_schema"` was sent, the
        // validated parsed object lives at `info.structured`, NOT in
        // the text parts (which are empty in that mode). Stringify it
        // back to JSON so the dispatcher's existing text-based parser
        // (`parseStage2Verdict`) sees a clean envelope. A missing or
        // null `structured` after a json_schema request is a terminal
        // failure — opencode tried `retryCount=2` server-side and
        // still couldn't satisfy the schema, so escalating to the
        // model again from our side would just burn budget.
        let structuredText: string | null = null;
        if (structuredFormat) {
          const structured = (assistantMessage as unknown as {
            structured?: unknown;
          })?.structured;
          if (structured == null) {
            throw new BackendDecisiveFailure(
              this.backendId,
              "other_non_retryable",
              new Error(
                "opencode json_schema turn returned no structured payload (info.structured was null)",
              ),
            );
          }
          structuredText = JSON.stringify(structured);
        }

        const finalText = structuredText
          ?? (extractAssistantTextFromParts(partsForExtraction).trim()
            || collected.streamedText.trim());

        // Tool-call audit — Phase 3 wires AgentWriteTracker via the tool
        // extraction path. Phase 2 surfaces the structured list so the
        // dispatcher can decide whether the agent touched files.
        const tools = extractToolUsesFromParts(partsForExtraction);
        recordAgentWritesFromTools(tools, this.writeTracker);

        // EXECUTION-MODE-DESIGN.md §6.3 / OPENCODE_BACKEND_DESIGN §5.8
        // synthetic absolute-block audit. opencode has no PreToolUse hook;
        // each tool call surfaced in the final response is run through the
        // classifier so an `agent_actions.blocked_absolute` row is written
        // with `result='partial'` on a hit. The underlying enforcement
        // happens server-side via the permission JSON — this row is
        // observability only.
        auditOpencodeTools(tools, {
          db: this.mcpContext?.db,
          mode: this.config.opencodeExecutionPermissionMode,
          sessionId: params.sessionDbId ?? null,
        });

        // Cost / token aggregation — V11: `client.session.get()` exposes
        // session-level aggregates that avoid summing per-message rows.
        // Default tag is "sdk" because the primary path is the SDK's
        // typed `info.cost`. Free-tier reconciliation below may override
        // to "litellm" or "hardcoded" depending on the registry source.
        let costSourceTag: BackendCostSource = "sdk";
        let costUsd = assistantMessage?.cost ?? 0;
        let usage: BackendUsage = assistantMessage
          ? assistantMessageToUsage(assistantMessage)
          : { ...EMPTY_USAGE };
        try {
          const sessionInfo = await client.session.get({
            path: { id: sessionId },
          });
          const sessAgg = sessionInfo.data as
            | {
                cost?: number;
                tokens?: {
                  input?: number;
                  output?: number;
                  reasoning?: number;
                  cache?: { read?: number; write?: number };
                };
              }
            | undefined;
          if (sessAgg?.tokens) {
            // Subtract the pre-turn snapshot so resume usage reflects
            // this turn only. Clamp to zero in case opencode reports a
            // non-monotonic counter — never charge negative tokens.
            usage = {
              inputTokens: Math.max(
                0,
                (sessAgg.tokens.input ?? 0) - preTurnUsage.inputTokens,
              ),
              outputTokens: Math.max(
                0,
                (sessAgg.tokens.output ?? 0) - preTurnUsage.outputTokens,
              ),
              cacheCreationInputTokens: Math.max(
                0,
                (sessAgg.tokens.cache?.write ?? 0)
                  - preTurnUsage.cacheCreationInputTokens,
              ),
              cacheReadInputTokens: Math.max(
                0,
                (sessAgg.tokens.cache?.read ?? 0)
                  - preTurnUsage.cacheReadInputTokens,
              ),
            };
          }
          if (typeof sessAgg?.cost === "number") {
            costUsd = Math.max(0, sessAgg.cost - preTurnCost);
          }
        } catch (err) {
          logger.debug(
            { err, sessionId },
            "opencode session.get failed; falling back to assistant-message tokens",
          );
        }

        // Free-tier reconciliation (§5.7 layer 2): when opencode reports
        // cost=0 but tokens flowed, fall back to registry pricing so the
        // dashboard sees a non-zero cost figure for budgeting.
        if (
          costUsd === 0
          && usage.inputTokens + usage.outputTokens > 0
        ) {
          const estimate = this.priceFetcher.estimateUsageCost({
            backendId: this.backendId,
            modelId: params.modelId,
            usage,
            fallbackModel: findRegisteredModel(this.backendId, params.modelId),
          });
          costUsd = estimate.costUsd;
          // Preserve `litellm` vs `hardcoded` provenance verbatim — see
          // CodexCore's same pattern (`codex-core.ts:761`). Earlier rev
          // collapsed `litellm` into `sdk`, hiding which estimates came
          // from the LiteLLM cache vs the registry fallback.
          costSourceTag = estimate.costSource;
        }
        this.assertWithinMaxBudget(costUsd, params.maxBudgetUsd, params.modelId);

        if (finalText && !streamedAnyText) {
          streamCallbacks?.onText?.(finalText);
        }

        const durationMs = Date.now() - startMs;
        const stopReason = assistantMessage?.finish ?? null;

        // Best-effort cleanup of the on-disk opencode session row when we
        // own the workdir — keeps disk usage bounded under hourly_check.
        // On resume we must never delete: the dispatcher's next turn
        // needs the same session id to resolve to a live server-side
        // history. (`ownsSessionDir` is already false when sessionDir is
        // provided, but the explicit isResume guard is defense-in-depth
        // against a future caller passing a transient workdir on resume.)
        if (ownsSessionDir && !isResume) {
          try {
            await client.session.delete({ path: { id: sessionId } });
          } catch (err) {
            logger.debug({ err, sessionId }, "opencode session.delete failed");
          }
        }

        logger.info(
          {
            eventType: params.event.type,
            model: params.modelId,
            durationMs,
            costUsd,
            sessionId,
          },
          "opencode execute completed",
        );

        const actualModelId =
          assistantMessage?.providerID && assistantMessage?.modelID
            ? `${assistantMessage.providerID}/${assistantMessage.modelID}`
            : params.modelId;

        return {
          output: finalText,
          sessionId,
          backendId: this.backendId,
          modelId: actualModelId,
          costSource: costSourceTag,
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
          numTurns: 1,
          durationMs,
          durationApiMs: durationMs,
          model: actualModelId,
          isError: false,
          stopReason,
          contextUpdated: false,
        };
      } finally {
        clearTimeout(timeoutId);
      }
    } finally {
      streamCallbacks?.onEnd?.();
      if (ownsSessionDir) {
        if (issuedReadToken) {
          this.readTokenManager?.revoke(sessionDir);
        }
        cleanupSessionWorkdir(sessionDir);
      }
    }
  }

  /**
   * docs/design/appendices/opencode-backend.md §5.9 / Phase 4 — opencode delegated-task
   * execution.
   *
   * Implementation choice (v1): spawn an isolated ephemeral server
   * with tight permission JSON for each delegated call. The design's
   * preferred default is Path B (long-lived primary + per-agent
   * permission frontmatter written mid-session), but Phase 0's V5
   * fixture left the agent-file hot-reload behaviour an open question
   * (§5.9 "Open item" — agent file was pre-created in V5). spawnEphemeral
   * sidesteps the hot-reload concern entirely with a deterministic
   * ~900 ms p50 spawn cost (V6 measurement); volume on delegated paths
   * is low enough that the cost-isolation trade-off favours
   * predictability. The router's `params.isolation === "ephemeral"`
   * intent is the same as our default here, so callers that explicitly
   * request ephemeral isolation get exactly what they asked for.
   *
   * Path B (long-lived primary + per-agent file reuse) can land
   * incrementally once V5's open question is resolved against a real
   * opencode server — see §5.9 Phase 3-blocked checklist row.
   *
   * Per-call envelope:
   *   - Tight `permission` JSON: every triple-keyed write tool
   *     (`edit`, `bash`, `webfetch`, `doom_loop`, `external_directory`)
   *     defaults to `deny`. The absolute-block layer's bash
   *     pattern-map merges on top so destructive shapes stay denied.
   *   - `tools.task: false` (V8 — kill subagent spawning) plus
   *     `tools.read: false` and `tools.write: false` for the
   *     non-MCP read/write tools (no permission triple exists for
   *     `read`; hard-disable is the only opencode 1.14.50 surface).
   *   - MCP map carries only the integration's connectors per
   *     `setMcpContext`; per-tool MCP deny is server-level only in v1
   *     (§5.6 v1 strategy) — disallowed connectors are simply not
   *     materialised.
   *   - `model` set to `params.modelId`.
   *
   * Stream pre-emption: opencode 1.14.50 does NOT emit
   * `message.part.updated` events during a turn (V9 — see §5.3), so
   * tool-call data is only available from the FINAL `session.prompt`
   * response. The pre-emption check therefore happens AFTER the turn
   * completes — `policy_violation` / `loop_aborted` classifications
   * still surface, but the subprocess has already executed any
   * out-of-envelope MCP call by the time we see it. Mitigation:
   *   1. Server-level permission denies non-MCP write tools at
   *      enforcement time (the model receives a tool error and stops).
   *   2. The MCP map only carries the integration's allowed
   *      connectors, so non-allowed MCP tools are unreachable.
   *   3. The post-turn pre-emption check is the audit layer — it
   *      classifies whether the turn violated policy for telemetry.
   * If opencode begins emitting streamed tool-call events, this method
   * migrates to the live pre-emption pattern Codex uses; the post-
   * extraction check stays as the back-stop.
   */
  private async runDelegatedTaskAgainstEphemeral(
    params: DelegatedTaskInvokeParams,
  ): Promise<DelegatedTaskResultRaw> {
    const startMs = Date.now();
    const trace: DelegatedTaskToolStepRaw[] = [];
    let writeClassToolFired = false;

    const modelParts = parseModelComposite(params.modelId);
    if (!modelParts) {
      return {
        ok: false,
        errorClass: "subprocess_crashed",
        message: `opencode model id must be in 'provider/model' form, got '${params.modelId}'`,
        cost: withDurationMs(emptyCost(), startMs),
        trace,
        writeClassToolFired,
      };
    }

    // Pre-flight auth gate — same chokepoint runTurn uses; spares us a
    // server spawn on the obvious-401 path.
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

    // Build the tight runtime config envelope. Reuses the regular
    // builder so absolute-block + per-session disallowed merges land
    // identically; the per-task tightening goes on top via
    // `extraHardDisable` (`read`/`write` off) and a tightened
    // permission override (every triple key denied).
    const mcpRender = await this.materializeMcp(undefined);
    const built = buildOpencodeRuntimeConfig({
      modelId: params.modelId,
      executionMode: "strict",
      disallowedTools: this.config.disallowedTools ?? [],
      allowedToolsOverride: null,
      mcpDisallowed: mcpRender.mcpDisallowed,
      mcp: mcpRender.mcp,
      defensiveInstructions: defensiveInstructionsFromEnv(),
      extraHardDisable: { read: false, write: false },
    });
    const tightConfig = {
      ...built.config,
      permission: {
        // Triple-keyed denies — the bash pattern-map from absolute-block
        // already merged into built.config.permission.bash, so taking
        // its value here preserves the wildcards. The other four flip
        // to wholesale "deny" because no per-task narrowing applies.
        ...(built.config.permission ?? {}),
        edit: "deny" as const,
        webfetch: "deny" as const,
        doom_loop: "deny" as const,
        external_directory: "deny" as const,
      },
    };

    let handle:
      | Awaited<ReturnType<OpencodeServerManager["spawnEphemeral"]>>
      | null = null;
    try {
      handle = await this.serverManager.spawnEphemeral(tightConfig);
    } catch (err) {
      return {
        ok: false,
        errorClass: "subprocess_crashed",
        message:
          err instanceof Error
            ? `opencode ephemeral server spawn failed: ${err.message}`
            : "opencode ephemeral server spawn failed",
        cost: withDurationMs(emptyCost(), startMs),
        trace,
        writeClassToolFired,
      };
    }

    const aborter = new AbortController();
    const callerListener = (): void => {
      aborter.abort(params.abortSignal?.reason);
    };
    if (params.abortSignal) {
      if (params.abortSignal.aborted) {
        aborter.abort(params.abortSignal.reason);
      } else {
        params.abortSignal.addEventListener("abort", callerListener, {
          once: true,
        });
      }
    }
    const localTimeout = setTimeout(
      () =>
        aborter.abort(new Error("opencode delegated task local timeout")),
      params.timeoutMs + 60_000,
    );

    let sessionId: string | null = null;
    try {
      const created = await handle.client.session.create({
        body: {
          title: `aitne:delegated:${randomUUID().slice(0, 8)}`,
        },
      });
      sessionId = created.data?.id ?? null;
      if (!sessionId) {
        return {
          ok: false,
          errorClass: "subprocess_crashed",
          message: "opencode session.create returned no id",
          cost: withDurationMs(emptyCost(), startMs),
          trace,
          writeClassToolFired,
        };
      }

      const promptResult = await handle.client.session.prompt({
        path: { id: sessionId },
        body: {
          model: modelParts,
          parts: [{ type: "text", text: params.systemPrompt }],
        },
      });

      if (aborter.signal.aborted) {
        const errorClass = classifyAbortReason(
          params.abortSignal?.reason ?? aborter.signal.reason,
        );
        return {
          ok: false,
          errorClass,
          message:
            errorClass === "timeout"
              ? "opencode delegated task timed out (wall-clock)"
              : "opencode delegated task cancelled",
          cost: withDurationMs(emptyCost(), startMs),
          trace,
          writeClassToolFired,
        };
      }

      const assistantMessage = promptResult.data?.info as
        | {
            cost?: number;
            providerID?: string;
            modelID?: string;
            error?: { name: string };
            tokens?: {
              input?: number;
              output?: number;
              reasoning?: number;
              cache?: { read?: number; write?: number };
            };
          }
        | undefined;

      if (assistantMessage?.error?.name === "MessageAbortedError") {
        return {
          ok: false,
          errorClass: "timeout",
          message: "opencode delegated session aborted",
          cost: withDurationMs(emptyCost(), startMs),
          trace,
          writeClassToolFired,
        };
      }
      if (assistantMessage?.error) {
        return {
          ok: false,
          errorClass: "tool_failed",
          message: `opencode assistant error: ${assistantMessage.error.name}`,
          cost: withDurationMs(emptyCost(), startMs),
          trace,
          writeClassToolFired,
        };
      }

      const partsRaw = (promptResult.data?.parts as unknown) ?? [];
      const finalText = extractAssistantTextFromParts(partsRaw).trim();
      const toolUses = extractToolUsesFromParts(partsRaw);

      // Post-extraction policy gate. opencode 1.14.50 cannot stream
      // tool calls (V9 — see method-level comment), so the check is
      // best-effort audit + classification, not real-time pre-emption.
      let policyViolationTool: string | null = null;
      let toolCallCount = 0;
      const isAllowedTool = (name: string): boolean =>
        params.allowedTools.some((pattern) =>
          matchRunAllowedToolPattern(pattern, name),
        );
      const destructiveSet = params.allowDestructive
        ? new Set<string>()
        : new Set<string>(params.destructiveTools);
      const writeClassMatcher = (name: string): boolean =>
        params.writeClassTools.some((pattern) =>
          matchRunAllowedToolPattern(pattern, name),
        );

      for (const tool of toolUses) {
        if (tool.status === "pending" || tool.status === "running") continue;
        toolCallCount += 1;
        // opencode 1.14.50 surfaces opencode-built-in tool names without
        // the `mcp__server__` prefix (the SDK v1 limitation §5.6 v2 will
        // address). For the allowedTools/destructive comparison we
        // inspect the verbatim name first, falling back to a synthesised
        // prefix when the integration key is known. Either way the audit
        // remains accurate for the same-name match.
        const fullName = tool.toolName;
        if (!isAllowedTool(fullName) || destructiveSet.has(fullName)) {
          policyViolationTool = fullName;
        }
        if (writeClassMatcher(fullName)) {
          writeClassToolFired = true;
        }
        const step: DelegatedTaskToolStepRaw = {
          toolName: fullName,
          toolArgs: tool.input,
          durationMs: tool.durationMs ?? 0,
          status: tool.status === "completed" ? "ok" : "error",
          costUsd: null,
          tokensInput: null,
          tokensOutput: null,
        };
        if (tool.output !== undefined) {
          try {
            step.toolResult = JSON.parse(tool.output);
          } catch {
            step.toolResult = tool.output;
          }
        }
        trace.push(step);
        params.onToolStep?.(step);
      }

      // Synthetic absolute-block audit on tool calls — same chokepoint
      // runTurn uses for execute() (§5.8). Records `blocked_absolute`
      // rows when a tool target matches the absolute-block layer; the
      // permission JSON denied the call server-side, this row is
      // observability only.
      auditOpencodeTools(toolUses, {
        db: this.mcpContext?.db,
        mode: "strict",
        sessionId: null,
      });

      const usage = assistantMessage
        ? {
            inputTokens: assistantMessage.tokens?.input ?? 0,
            outputTokens: assistantMessage.tokens?.output ?? 0,
            cacheCreationInputTokens:
              assistantMessage.tokens?.cache?.write ?? 0,
            cacheReadInputTokens:
              assistantMessage.tokens?.cache?.read ?? 0,
          }
        : { ...EMPTY_USAGE };
      const costUsd = assistantMessage?.cost ?? 0;
      const cost = withDurationMs(
        {
          tokensInput: usage.inputTokens,
          tokensOutput: usage.outputTokens,
          cacheCreationTokens: usage.cacheCreationInputTokens,
          cacheReadTokens: usage.cacheReadInputTokens,
          costUsd,
          durationMs: 0,
          numTurns: 1,
        },
        startMs,
      );

      // Best-effort cleanup of the on-disk session row. Failure is
      // benign — the ephemeral server itself will be torn down in
      // `finally` and its disk state goes with it.
      try {
        await handle.client.session.delete({ path: { id: sessionId } });
      } catch (err) {
        logger.debug(
          { err, sessionId },
          "opencode delegated session.delete failed",
        );
      }

      if (policyViolationTool) {
        return {
          ok: false,
          errorClass: "policy_violation",
          message: `opencode invoked '${policyViolationTool}' which is outside the per-task allowlist`,
          rawAssistantText: finalText,
          cost,
          trace,
          writeClassToolFired,
        };
      }
      if (toolCallCount > params.maxToolCalls) {
        return {
          ok: false,
          errorClass: "loop_aborted",
          message: `opencode exceeded maxToolCalls=${params.maxToolCalls} (observed=${toolCallCount})`,
          rawAssistantText: finalText,
          cost,
          trace,
          writeClassToolFired,
        };
      }

      if (finalText.length === 0) {
        return {
          ok: false,
          errorClass: "parse_error",
          message: "opencode assistant produced empty text",
          rawAssistantText: finalText,
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
      if (aborter.signal.aborted || params.abortSignal?.aborted) {
        return {
          ok: false,
          errorClass: classifyAbortReason(
            params.abortSignal?.reason ?? aborter.signal.reason,
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
      clearTimeout(localTimeout);
      if (params.abortSignal && callerListener) {
        params.abortSignal.removeEventListener("abort", callerListener);
      }
      if (handle) {
        try {
          await handle.close();
        } catch (err) {
          logger.debug(
            { err },
            "opencode delegated ephemeral close threw",
          );
        }
      }
    }
  }

  /**
   * OPENCODE_BACKEND_DESIGN §5.1 / §5.8 — assemble the full per-session
   * `OpencodeRuntimeConfig` envelope. Async because MCP materialization
   * resolves secrets via the encrypted blob store.
   *
   * Self-contained: every field is set explicitly (or deliberately
   * omitted), so the server-manager's bounce hash is stable across
   * same-envelope turns. The §5.1 invariant.
   */
  private async buildRuntimeConfig(
    params: AgentExecuteParams,
  ): Promise<{ config: OpencodeRuntimeConfig; warnings: string[] }> {
    const mcpRender = await this.materializeMcp(params.processKey);
    const built = buildOpencodeRuntimeConfig({
      modelId: params.modelId,
      executionMode: this.config.opencodeExecutionPermissionMode,
      disallowedTools: this.config.disallowedTools ?? [],
      allowedToolsOverride:
        params.allowedToolsOverride ?? this.config.allowedToolsOverride ?? null,
      mcpDisallowed: mcpRender.mcpDisallowed,
      mcp: mcpRender.mcp,
      defensiveInstructions: defensiveInstructionsFromEnv(),
    });
    // MCP renderer warnings (server-name lint failures, missing
    // command/url) must flow through so the dashboard's runtime-config
    // preview tile sees them alongside permission-translator warnings —
    // the §5.6 contract says warnings are "collected from both
    // translators". Without this concatenation they only land in
    // `logger.warn`, invisible to operators not tailing daemon logs.
    return {
      config: built.config,
      warnings: [...built.warnings, ...mcpRender.warnings],
    };
  }

  /**
   * Per-session MCP materialization. Unlike Claude / Codex / Gemini —
   * which write a backend-specific file under `<sessionDir>/.mcp.json`
   * or `.codex/config.toml` — OpenCode receives MCP servers inline via
   * `OPENCODE_CONFIG_CONTENT` (§5.1). The daemon therefore renders
   * directly into a `Record<string, McpLocalConfig | McpRemoteConfig>`
   * map and feeds it into `buildOpencodeRuntimeConfig`.
   *
   * Returns the rendered map + the autonomous-strip disallowedTools so
   * the config builder can surface those as MCP-server warnings
   * (per-tool MCP deny isn't expressible in opencode 1.14.50 — §5.6).
   */
  private async materializeMcp(
    processKey: ProcessKey | undefined,
  ): Promise<{
    mcp: ReturnType<typeof renderOpencodeMcp>["mcp"];
    mcpDisallowed: string[];
    warnings: string[];
  }> {
    if (!this.mcpContext) {
      return { mcp: {}, mcpDisallowed: [], warnings: [] };
    }
    const allServers = listMcpServers(this.mcpContext.db);
    const forBackend = allServers.filter(
      (s) => s.enabled && s.backends.includes(this.backendId),
    );
    if (forBackend.length === 0) {
      return { mcp: {}, mcpDisallowed: [], warnings: [] };
    }

    // Resolve secrets the same way materializeMcpForSession does — keyed
    // by `<serverId>:<keyName>` so the renderer can pick the subset it
    // needs without collisions across servers.
    const scopedSecrets: Record<string, string> = {};
    for (const server of forBackend) {
      const raw = await resolveMcpSecrets(this.mcpContext.blobStore, server);
      for (const [keyName, value] of Object.entries(raw)) {
        if (value == null) continue;
        scopedSecrets[`${server.id}:${keyName}`] = value;
      }
    }

    // Allow mode bypasses the approve-tier strip — mirroring the Codex
    // / Gemini wiring (see codex-core.ts:230).
    const allowMode = this.config.opencodeExecutionPermissionMode === "allow";
    const autonomous =
      !allowMode && (processKey ? isAutonomousProcessKey(processKey) : false);
    const mcpDisallowed = buildMcpDisallowedTools({
      servers: forBackend,
      autonomous,
    });

    const rendered = renderOpencodeMcp({
      servers: forBackend,
      secrets: scopedSecrets,
    });

    if (rendered.warnings.length > 0) {
      logger.warn(
        { warnings: rendered.warnings, contextDir: getContextDir(this.config) },
        "opencode-mcp renderer surfaced warnings",
      );
    }
    return { mcp: rendered.mcp, mcpDisallowed, warnings: rendered.warnings };
  }

  private async consumeEventStream(args: {
    stream: AsyncIterable<unknown>;
    sessionId: string;
    signal: AbortSignal;
    onText: (text: string) => void;
  }): Promise<{
    streamedText: string;
    terminalEvent: OpencodeNormalizedEvent | undefined;
  }> {
    const { stream, sessionId, signal, onText } = args;
    let streamedText = "";
    let terminalEvent: OpencodeNormalizedEvent | undefined;

    try {
      for await (const rawEvent of stream) {
        if (signal.aborted) break;
        const normalized = normalize(
          rawEvent as unknown as RawOpencodeEvent,
        );
        // Filter events that don't belong to our session — `server.heartbeat`
        // and `server.connected` carry no sessionId, but other typed
        // events do; drop foreign sessions to avoid cross-talk on a
        // long-lived server.
        const eventSessionId =
          "sessionId" in normalized ? normalized.sessionId : "";
        if (eventSessionId && eventSessionId !== sessionId) continue;

        if (normalized.kind === "text_delta" && normalized.field === "text") {
          // Only the `text` field is user-visible final output. opencode
          // also emits `field: "reasoning"` (and other non-text part
          // fields) — they must not reach `onText` (chat bubble) and
          // must not pollute `streamedText`, which is the
          // `extractAssistantTextFromParts` fallback used when the parts
          // array carries no `type: "text"` entries.
          streamedText += normalized.delta;
          if (normalized.delta) {
            onText(normalized.delta);
          }
        }
        if (isTerminal(normalized)) {
          terminalEvent = normalized;
          break;
        }
      }
    } catch (err) {
      if (signal.aborted) {
        // Caller surfaces the timeout (or the prompt fast-fail) via the
        // abort path; don't escalate the iterator's AbortError to a warn.
        return { streamedText, terminalEvent };
      }
      logger.warn({ err, sessionId }, "opencode event-stream consumption error");
    }
    return { streamedText, terminalEvent };
  }

  private assertPromptWithinMaxBudget(
    prompt: string,
    maxBudgetUsd: number | undefined,
    modelId: string,
  ): void {
    if (!maxBudgetUsd) return;
    // Same envelope check Codex uses — defensive only; opencode also
    // enforces a context limit server-side.
    const approxInputTokens = Math.ceil(prompt.length / 3.5);
    const fallback = findRegisteredModel(this.backendId, modelId);
    if (!fallback?.usdPer1kIn) return;
    const projected = (approxInputTokens / 1000) * fallback.usdPer1kIn;
    if (projected > maxBudgetUsd * 2) {
      throw new BackendDecisiveFailure(
        this.backendId,
        "model_unavailable",
        new Error(
          `Prompt projected at $${projected.toFixed(4)} exceeds 2× budget cap of $${maxBudgetUsd.toFixed(4)}`,
        ),
      );
    }
  }

  private assertWithinMaxBudget(
    costUsd: number,
    maxBudgetUsd: number | undefined,
    modelId: string,
  ): void {
    if (!maxBudgetUsd) return;
    if (costUsd > maxBudgetUsd) {
      throw new BackendDecisiveFailure(
        this.backendId,
        "model_unavailable",
        new Error(
          `opencode execute cost $${costUsd.toFixed(4)} exceeds budget $${maxBudgetUsd.toFixed(4)} (${modelId})`,
        ),
      );
    }
  }
}

function assistantMessageToUsage(
  msg: {
    tokens?: {
      input?: number;
      output?: number;
      reasoning?: number;
      cache?: { read?: number; write?: number };
    };
  },
): BackendUsage {
  const tokens = msg.tokens;
  return {
    inputTokens: tokens?.input ?? 0,
    outputTokens: tokens?.output ?? 0,
    cacheCreationInputTokens: tokens?.cache?.write ?? 0,
    cacheReadInputTokens: tokens?.cache?.read ?? 0,
  };
}

/**
 * Best-effort write attribution. Permanent limitation in v1 (V9 / §5.3):
 *
 *   opencode 1.14.50 does NOT emit `message.part.updated` events during a
 *   turn — tool-call data is only available from the FINAL session.prompt
 *   response. By the time we read it here, the file watcher has already
 *   fired (chokidar latency: milliseconds), so a marker added now is too
 *   late to influence the immediate `actor` classification.
 *
 *   The practical value of this call is therefore the SECOND-ORDER
 *   protection it gives observers polling slower than 30s (the
 *   AgentWriteTracker default TTL): if the same path is re-observed
 *   within that window, attribution is correct. Real-time chokidar
 *   observers (Obsidian / Git) see opencode tool-driven file writes
 *   without an `actor='agent'` mark — accepted gap, contained because the
 *   context-MD chokepoint forbids `edit`/`write` against
 *   `~/.personal-agent/context/**` server-side (the absolute-block
 *   permission JSON denies the canonical bash exfiltration paths;
 *   `tools.read` hard-disable plus per-session permission denies bar
 *   the opencode `read`/`write` tools from those paths in strict mode).
 *
 *   If opencode begins emitting streamed `tool_call` events upstream
 *   (gated on a future release), this function migrates to the event
 *   mapper's stream path so the marker lands before the file watcher
 *   fires; the existing extraction logic below remains as the
 *   final-response back-stop.
 */
function recordAgentWritesFromTools(
  tools: ReturnType<typeof extractToolUsesFromParts>,
  writeTracker: AgentWriteTracker,
): void {
  for (const tool of tools) {
    if (tool.status !== "completed") continue;
    const writePath = extractWritePathFromInput(tool.toolName, tool.input);
    if (writePath) {
      writeTracker.markWriting(writePath);
    }
  }
}

function extractWritePathFromInput(
  toolName: string,
  input: Record<string, unknown>,
): string | null {
  if (!input) return null;
  if (toolName === "write" || toolName === "edit" || toolName === "apply_patch") {
    const candidate = input.path ?? input.filePath ?? input.file;
    if (typeof candidate === "string" && candidate.length > 0) return candidate;
  }
  return null;
}

/**
 * docs/design/appendices/opencode-backend.md §5.8 synthetic absolute-block audit. For
 * every tool call extracted from the final `session.prompt` response,
 * route through the shared `auditStreamObservation` chokepoint so a
 * `blocked_absolute` row with `result='partial'` is written on a match.
 *
 * Two-step pipeline keeps the classifier centralised:
 *   1. `extractOpencodeToolUseTarget` — opencode-specific tool/arg
 *      normalisation (`bash` / `read` / `write` / `edit` / `apply_patch`).
 *   2. `auditStreamObservation` — runs `classifyAbsoluteBlock` against
 *      the normalised target and writes the audit row when matched.
 *
 * Why the `partial` result code: opencode enforces the deny inside the
 * permission JSON at server side, which the daemon does not directly
 * observe. The audit row records *that the agent attempted* a pattern
 * the absolute-block layer covers — useful even if the underlying
 * enforcement happened correctly server-side, and *critical* if a future
 * permission-JSON regression silently let the call through.
 *
 * Exported for `opencode-core.test.ts` so the synthetic audit can be
 * exercised without spinning up a full server.
 */
export function auditOpencodeTools(
  tools: ReturnType<typeof extractToolUsesFromParts>,
  deps: {
    db: import("better-sqlite3").Database | undefined;
    mode: import("@aitne/shared").ExecutionPermissionMode;
    sessionId: number | null;
  },
): void {
  if (!deps.db) return;
  for (const tool of tools) {
    // Match on every tool we can normalise — both completed and errored
    // calls. Pending/running calls don't carry final input yet.
    if (tool.status === "pending" || tool.status === "running") continue;
    const target = extractOpencodeToolUseTarget(tool.toolName, tool.input);
    if (!target) continue;
    const match = auditStreamObservation(target, {
      db: deps.db,
      backend: "opencode",
      mode: deps.mode,
      sessionId: deps.sessionId,
    });
    // `auditStreamObservation` already writes the row when match is
    // non-null; nothing else to do here. The void return lets callers
    // ignore matches in the hot path while keeping the row in the DB.
    void match;
  }
}


function classifyAssistantError(
  error: { name: string; data?: unknown },
  backendId: "opencode",
): Error {
  if (error.name === "ProviderAuthError") {
    return new BackendDecisiveFailure(
      backendId,
      "auth",
      new Error("opencode provider auth rejected"),
    );
  }
  if (error.name === "MessageOutputLengthError") {
    return new BackendDecisiveFailure(
      backendId,
      "max_turns",
      new Error("opencode message output length exceeded"),
    );
  }
  return new BackendDecisiveFailure(
    backendId,
    "other_non_retryable",
    new Error(`opencode assistant error: ${error.name}`),
  );
}

function classifyStreamError(
  payload: { name: string; data: { statusCode?: number; message?: string } },
  backendId: "opencode",
): Error {
  const status = payload.data?.statusCode;
  const message = payload.data?.message ?? `opencode stream error: ${payload.name}`;
  if (status === 401 || status === 403 || payload.name === "ProviderAuthError") {
    return new BackendDecisiveFailure(
      backendId,
      "auth",
      new Error(message),
    );
  }
  if (status === 429) {
    return new BackendDecisiveFailure(
      backendId,
      "quota",
      new Error(message),
    );
  }
  return new BackendDecisiveFailure(
    backendId,
    "other_non_retryable",
    new Error(message),
  );
}

/**
 * docs/design/appendices/opencode-backend.md Phase 4 — Stage 2 hourly-check triage
 * schema. Mirrors the `parseStage2Verdict` text contract
 * (`dispatcher-types.ts`): the agent must return exactly
 * `{ "action": "log_only" | "escalate", "reason": string }`. Opencode
 * validates against this schema with `retryCount: 2` server-side, then
 * surfaces the parsed object at `info.structured`.
 *
 * Exported for the regression test that exercises the json_schema
 * round-trip without spinning up a real opencode server.
 */
export const STAGE2_TRIAGE_JSON_SCHEMA = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: ["log_only", "escalate"],
    },
    reason: {
      type: "string",
    },
  },
  required: ["action", "reason"],
  additionalProperties: false,
} as const;

/**
 * Returns the opencode `format` envelope to apply when a given process
 * key has a strict structured-output contract; null otherwise. v1
 * covers `routine.hourly_check.triage`; future strict-JSON process
 * keys (e.g. delegated classifiers) extend this map.
 */
function formatForProcessKey(
  processKey: ProcessKey | undefined,
): { type: "json_schema"; schema: object; retryCount: number } | null {
  if (processKey === "routine.hourly_check.triage") {
    return {
      type: "json_schema",
      schema: STAGE2_TRIAGE_JSON_SCHEMA,
      retryCount: 2,
    };
  }
  return null;
}
