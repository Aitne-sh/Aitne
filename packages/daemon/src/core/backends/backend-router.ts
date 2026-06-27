import type Database from "better-sqlite3";
import type {
  AgentResult,
  BackendId,
  BackendSafetyFloor,
  Event,
  IntegrationKey,
  ProcessKey,
  ProcessModelTier,
} from "@aitne/shared";
import {
  backendHasIntegrationConnector,
  delegatedIntegrationsForProcessKey,
  getBrowserHistorySafetyFloor,
  getDefaultTierForProcessKey,
  isCustomRoutineKey,
  isMessageEvent,
  isProcessKey,
  nativeIntegrationsForProcessKey,
  resolveProcessKey,
  TIER_LOCKED_PROCESS_KEYS,
} from "@aitne/shared";
import { readIntegrations } from "../../db/integrations-store.js";
import type { AgentConfig } from "../../config.js";
import { createLogger } from "../../logging.js";
import {
  BackendDecisiveFailure,
  BackendQuotaError,
  type IAgentCore,
  type StagedAttachment,
  type StreamCallbacks,
} from "../agent-core.js";
import {
  DEFAULT_CLAUDE_HIGH_MODEL,
  DEFAULT_CLAUDE_LITE_MODEL,
  DEFAULT_CLAUDE_MEDIUM_MODEL,
  findRegisteredModel,
  getModelsForBackend,
} from "./model-registry.js";
import {
  readCachedAuthStatus,
  recordReactiveAuthFailure,
  recordReactiveAuthSuccess,
} from "./auth-health-monitor.js";
import {
  extractFailureSpendInfo,
  recordFailureSpendRow,
} from "./failure-spend.js";
import type { AuthTelemetry } from "./auth-telemetry.js";
import {
  extractAgentRouteOverride,
  type AgentRouteOverride,
} from "../agents/agent-route-override.js";

const logger = createLogger("backend-router");

/**
 * Per-process maxTurns caps, applied when no DB-level process_backend_config
 * override exists. Values are set at P95+ of observed turn distributions
 * (see docs/design/appendices/token-efficiency-audit.md §1C).
 */
const PROCESS_MAX_TURNS: Partial<Record<string, number>> = {
  "routine.morning_routine": 50,   // avg 17.7, max observed 35 — 300 was 8.5x max
  "routine.activity_scan": 30,      // P90=25, pad for complex observation sets
  "routine.roadmap_refresh": 25,   // single observed run was 13 turns
  "message.dm": 35,                // most <15, allow long conversations
  // Setup is high-tier (Opus / gpt-5.4 / Pro — Codex collapses high to
  // gpt-5.4 via SEED_HIGH_TIER_OVERRIDE) because the rules document
  // feeds every downstream routine. The high-tier fall-through default is
  // 300 turns which is way past the structural shape — a setup
  // conversation is at most ~6 turns (Q&A + 1–2 revision rounds + the
  // final emit). Cap at 50 so a runaway loop terminates fast.
  "setup": 50,
};
const NOTIFICATION_DEDUPE_WINDOW_MS = 2 * 60 * 60 * 1000;

type BackendFailure = BackendDecisiveFailure | BackendQuotaError;

interface BackendRouterNotifier {
  send(
    message: string,
    event: Event,
    options?: {
      priority?: string;
      category?: string;
      destinationMode?: "default" | "configured_only";
    },
  ): Promise<void>;
}

/**
 * One-line root-cause summary embedded in `BackendRouterHandledError.message`
 * so operators reading dashboard / log output see *why* the backend failed
 * without having to open the JSON payload. Format:
 *   - quota:    `quota:<originalCode> — <inner message>`
 *   - decisive: `<kind> — <inner cause message>` (e.g. `auth — 401 expired`)
 */
function describeBackendFailure(failure: BackendFailure): string {
  if (failure instanceof BackendQuotaError) {
    return `quota:${failure.originalCode} — ${failure.message}`;
  }
  const innerMessage
    = failure.cause instanceof Error
      ? failure.cause.message
      : failure.cause !== undefined
        ? String(failure.cause)
        : failure.message;
  return `${failure.kind} — ${innerMessage}`;
}

export class BackendRouterHandledError extends Error {
  constructor(
    message: string,
    public readonly cause: BackendFailure,
    public readonly mainFailure: BackendFailure,
    public readonly fallbackFailure: BackendFailure | null = null,
  ) {
    super(message);
    this.name = "BackendRouterHandledError";
  }
}

export interface ResolvedBackendBinding {
  backendId: BackendId;
  modelId: string;
  maxTurns: number;
  maxBudgetUsd: number;
}

export interface ResolvedBackendRoute {
  processKey: ProcessKey;
  /** Tier actually used for model selection — derived from process-key
   *  defaults, requestedTier hint, or user-configured process_backend_config. */
  resolvedTier: ProcessModelTier;
  main: ResolvedBackendBinding;
  fallback: ResolvedBackendBinding | null;
}

export interface RouterExecuteParams {
  event: Event;
  prompt: string;
  context: string;
  processKey?: ProcessKey;
  /**
   * **Explicit tier override.** When present, the caller is expressing explicit
   * user intent to run at this tier, bypassing `process_backend_config.main_model`.
   *
   * Concretely: if `requestedTier` is passed and the pinned model's registry
   * tier does NOT match, `resolveBinding` will swap in a canonical model for
   * the requested tier on the same backend (e.g. Pro preset pins
   * `routine.activity_scan` to Sonnet; `requestedTier: "heavy"` swaps to
   * `claude-opus-4-8`). This is the ONLY path through which the three
   * explicit-Opus escape hatches (dashboard chat picker, agent_schedule.model,
   * `/api/agent/run-now {requestedModel}`) can reach Opus on Pro plan.
   *
   * Fallback binding is dropped on override — the caller chose a specific
   * tier, we don't silently re-route to whatever the process's fallback was.
   */
  requestedTier?: ProcessModelTier;
  /**
   * **Explicit backend + model override.** When both are set, this is a
   * HARD override that supersedes `requestedTier` and any
   * `process_backend_config.main_backend/main_model` pin. Used only by the
   * dashboard chat model picker so the user can select any registered model
   * on any enabled backend, not just Claude sonnet/opus. Fallback is dropped
   * — if the user chose a specific backend, we don't silently reroute to
   * whatever the process's fallback was. Validation (backend enabled,
   * modelId registered) happens on the wire boundary (SSE route); the
   * router trusts the pair but still runs `requireCore` on execute.
   */
  requestedBackendId?: BackendId;
  requestedModelId?: string;
  sessionDir?: string;
  persistSession?: boolean;
  sessionDbId?: number;
  conversationHistory?: string;
  /** Pre-resolved binding — skips the internal resolveBinding() call when
   *  the caller already resolved it (e.g. to peek at the backendId for
   *  prompt overlay selection). Avoids a redundant DB query. */
  preResolvedBinding?: ResolvedBackendRoute;
  /**
   * EventType + processKey the fallback path should pass to
   * `prepareSessionDir` when re-materializing the workdir for the fallback
   * backend. Default to `event.type` / `binding.processKey` when omitted.
   *
   * Callers set these when the main-side workdir was materialized with a
   * more specific key than the routing binding would pick — e.g. setup
   * flows collapse to `processKey="setup"` for routing but materialize as
   * `setup.initial` / `setup.update` for skills. Without this override the
   * fallback re-materialization would regress the skill set.
   */
  workdirEventType?: string;
  workdirProcessKey?: ProcessKey;
  /**
   * Rebuild the prompt for a specific backend. Invoked on the fallback path
   * so any backend-specific prompt assembly is re-applied against the
   * fallback backend instead of running the main backend's assembled text
   * on a different model. When omitted the router reuses `params.prompt`
   * verbatim.
   */
  reassemblePrompt?: (backendId: BackendId) => string;
  /** Chat-attachments Phase 1 — per-turn capability token forwarded to the core. */
  turnToken?: string;
  /** Chat-attachments Phase 1 — staged inbound attachments for per-backend translation. */
  stagedAttachments?: StagedAttachment[];
  /** P22 §3.4 step 4 — see `AgentExecuteParams.allowedToolsOverride`. The
   *  router forwards this as-is to the chosen core; if a fallback fires,
   *  the same override applies on the fallback execute (the safety
   *  envelope must hold across backends). */
  allowedToolsOverride?: readonly string[];
  /** WIKI_BUILDER_DESIGN.md §4.3 — see `AgentExecuteParams.wikiUrlFetchEnabled`.
   *  Forwarded verbatim on both main and fallback execute paths so the
   *  URL-fetch widening survives a Claude → Codex fallback. */
  wikiUrlFetchEnabled?: boolean;
  /** AGENT_DEFINITIONS_DESIGN.md §4.2 — see `AgentExecuteParams.extraSkills`.
   *  Forwarded verbatim on both main and fallback execute paths so the
   *  firing Agent's added skills survive a Claude → Codex fallback. */
  extraSkills?: readonly string[];
  /** AGENT_DEFINITIONS_DESIGN.md §4.2 — see `AgentExecuteParams.skillsReplace`. */
  skillsReplace?: boolean;
}

export interface RouterResumeParams {
  backendId: BackendId;
  sessionId: string;
  message: string;
  modelId: string;
  maxTurns?: number;
  maxBudgetUsd?: number;
  sessionDir?: string;
  sessionDbId?: number;
  /** Chat-attachments Phase 1 — per-turn capability token forwarded to the core. */
  turnToken?: string;
  /** Chat-attachments Phase 1 — staged inbound attachments for per-backend translation. */
  stagedAttachments?: StagedAttachment[];
  /** Originating event's correlationId — forwarded to the core so the
   *  shim env can attach the dedup header on /api/notify, attributing
   *  resume-time notifications back to the dispatcher's in-flight run. */
  eventCorrelationId?: string;
}

export interface IAgentRouter {
  execute(
    params: RouterExecuteParams,
    streamCallbacks?: StreamCallbacks,
  ): Promise<AgentResult>;
  executeResume(
    params: RouterResumeParams,
    streamCallbacks?: StreamCallbacks,
  ): Promise<AgentResult>;
  summarize(conversationText: string): Promise<string>;
  resolveBinding(
    event: Event,
    options?: {
      processKey?: ProcessKey;
      requestedTier?: ProcessModelTier;
      requestedBackendId?: BackendId;
      requestedModelId?: string;
    },
  ): ResolvedBackendRoute;
}

interface ProcessConfigRow {
  main_backend: BackendId;
  main_model: string;
  fallback_backend: BackendId | null;
  fallback_model: string | null;
  max_turns: number;
  max_budget_usd: number;
}

interface BackendGlobalDefaultsRow {
  default_backend: BackendId;
  default_lite_model: string;
  default_medium_model: string;
  default_high_model: string;
}

/**
 * Optional callback the router invokes to ensure the session workdir
 * contains the instruction files needed by a specific backend. This is
 * critical on the fallback path: when main=Claude fails and fallback=Codex,
 * the session dir was materialized for Claude (`CLAUDE.md` + `.claude/skills/`)
 * and lacks `AGENTS.md`. Without this hook, the fallback core runs in a dir
 * missing its instruction file.
 *
 * `messageText` is the inbound DM text (for `MessageEvent` only) that
 * feeds the `gmailLifestyleActiveForDm` / `managedTasksActiveForDm`
 * predicates. Threading it on the fallback path keeps the fallback's
 * `<skill-index>` block and `.codex/skills/` (or `.gemini/skills/`)
 * directory in sync with the main backend's manifest decision — without
 * it, a Claude→Codex DM fallback would re-materialize with the
 * conservative-include defaults (both conditional skills always loaded)
 * even when the main side correctly dropped them, leaking asymmetric
 * skill sets across the two backends mid-turn.
 */
export type PrepareSessionDirFn = (
  sessionDir: string,
  backendId: BackendId,
  eventType: string,
  processKey?: ProcessKey,
  wikiWorkspaceName?: string,
  messageText?: string | null,
) => void;

export class BackendRouter implements IAgentRouter {
  private readonly cores: Partial<Record<BackendId, IAgentCore>>;
  private readonly hasProcessConfigTable: boolean;
  private readonly hasBackendDefaultsTable: boolean;
  private readonly hasAgentsTable: boolean;
  private readonly notificationDedup = new Map<string, number>();

  constructor(
    private readonly db: Database.Database,
    private readonly config: AgentConfig,
    cores: IAgentCore[],
    private readonly notifier?: BackendRouterNotifier,
    private readonly authTelemetry?: AuthTelemetry,
    private readonly prepareSessionDir?: PrepareSessionDirFn,
  ) {
    this.cores = Object.fromEntries(
      cores.map((core) => [core.backendId, core]),
    ) as Partial<Record<BackendId, IAgentCore>>;
    this.hasProcessConfigTable = this.hasTable("process_backend_config");
    this.hasBackendDefaultsTable = this.hasTable("backend_global_defaults");
    this.hasAgentsTable = this.hasTable("agents");
  }

  async execute(
    params: RouterExecuteParams,
    streamCallbacks?: StreamCallbacks,
  ): Promise<AgentResult> {
    const binding = params.preResolvedBinding ?? this.resolveBinding(params.event, {
      processKey: params.processKey,
      requestedTier: params.requestedTier,
      ...(params.requestedBackendId ? { requestedBackendId: params.requestedBackendId } : {}),
      ...(params.requestedModelId ? { requestedModelId: params.requestedModelId } : {}),
    });

    // BROWSER_HISTORY_INTEGRATION_PLAN §10.3 — backend safety floor.
    // High-sensitivity integrations declare a per-process-key allowlist
    // of eligible backends + a forbidden-modes list. When the resolved
    // binding violates the floor, the router refuses to execute, logs
    // an `agent_actions(action_type='backend_floor_refused')` row, and
    // surfaces a one-time owner DM directing the operator at
    // /settings/models. No graceful degradation — the threat model
    // assumes the enforcement surface holds.
    const floorViolation = this.checkSafetyFloor(binding);
    if (floorViolation) {
      this.logSafetyFloorRefusal(binding, floorViolation);
      await this.dmSafetyFloorOnce(binding, floorViolation, params.event);
      const failure = new BackendDecisiveFailure(
        binding.main.backendId,
        "policy_denied",
        floorViolation.reason,
      );
      throw new BackendRouterHandledError(
        `Backend safety floor refused: ${floorViolation.reason}`,
        failure,
        failure,
      );
    }

    // Phase 3.3 — pre-flight auth cache check. When the main backend's
    // cached auth status is recently confirmed bad, skip straight to the
    // fallback to avoid a doomed subprocess. Only applies when a fallback
    // is available; without one, we fall through to main and let it fail
    // naturally (which triggers self-heal on the next successful execute).
    if (binding.fallback) {
      const preflight = readCachedAuthStatus(
        this.db,
        binding.main.backendId,
        this.config.authPreflightFreshnessMs,
      );
      if (preflight.shouldSkip) {
        logger.warn(
          {
            processKey: binding.processKey,
            backendId: binding.main.backendId,
            cachedStatus: preflight.status,
            fallbackBackendId: binding.fallback.backendId,
          },
          "Pre-flight auth check: main backend auth unavailable (cached), routing to fallback",
        );
        this.authTelemetry?.increment(
          binding.main.backendId,
          "preflight_skipped_main",
          "reactive",
        );
        return this.executePreflightFallback(binding, params, streamCallbacks);
      }
    }

    const mainCore = this.requireCore(binding.main.backendId);
    const mainWebSearch = this.isWebSearchEnabled(binding.main.backendId);

    try {
      const result = await mainCore.execute(
        {
          prompt: params.prompt,
          context: params.context,
          event: params.event,
          modelId: binding.main.modelId,
          maxTurns: binding.main.maxTurns,
          maxBudgetUsd: binding.main.maxBudgetUsd,
          sessionDir: params.sessionDir,
          processKey: binding.processKey,
          persistSession: params.persistSession,
          conversationHistory: params.conversationHistory,
          webSearchEnabled: mainWebSearch,
          ...(params.sessionDbId !== undefined ? { sessionDbId: params.sessionDbId } : {}),
          ...(params.turnToken ? { turnToken: params.turnToken } : {}),
          ...(params.stagedAttachments && params.stagedAttachments.length > 0
            ? { stagedAttachments: params.stagedAttachments }
            : {}),
          ...(params.allowedToolsOverride
            ? { allowedToolsOverride: params.allowedToolsOverride }
            : {}),
          ...(params.wikiUrlFetchEnabled
            ? { wikiUrlFetchEnabled: true }
            : {}),
          ...(params.extraSkills && params.extraSkills.length > 0
            ? { extraSkills: params.extraSkills }
            : {}),
          ...(params.skillsReplace ? { skillsReplace: true } : {}),
        },
        streamCallbacks,
      );
      // Reactive self-heal: a successful execute is authoritative proof the
      // CLI held valid credentials. Bump auth_last_success_at (so the 60-day
      // keepalive sweep tracks real usage) and clear any stale expired/missing
      // cache row without waiting for the dashboard "Check auth" button.
      recordReactiveAuthSuccess(
        this.db,
        binding.main.backendId,
        this.authTelemetry,
      );
      return result;
    } catch (error) {
      // Reactive auth-health: persist the failure to the DB cache so
      // pre-flight checks and `/auth status` reflect the real-time state.
      if (error instanceof BackendDecisiveFailure && error.kind === "auth") {
        recordReactiveAuthFailure(
          this.db,
          binding.main.backendId,
          error.cause instanceof Error ? error.cause.message : String(error.cause ?? ""),
          this.authTelemetry,
        );
      }

      if (
        !binding.fallback ||
        !(error instanceof BackendDecisiveFailure || error instanceof BackendQuotaError)
      ) {
        if (error instanceof BackendDecisiveFailure || error instanceof BackendQuotaError) {
          await this.handleNoFallbackFailure(params.event, binding.processKey, binding.main, error);
          throw new BackendRouterHandledError(
            `Backend "${binding.main.backendId}" failed without fallback: ${describeBackendFailure(error)}`,
            error,
            error,
          );
        }
        throw error;
      }

      logger.warn(
        {
          processKey: binding.processKey,
          backendId: binding.main.backendId,
          failureKind: this.describeFailureKind(error),
          fallbackBackendId: binding.fallback.backendId,
        },
        "Main backend failed decisively, attempting fallback",
      );

      return this.executeFallbackCore(binding, params, error, streamCallbacks);
    }
  }

  async executeResume(
    params: RouterResumeParams,
    streamCallbacks?: StreamCallbacks,
  ): Promise<AgentResult> {
    const core = this.requireCore(params.backendId);
    try {
      const result = await core.executeResume(
        {
          sessionId: params.sessionId,
          message: params.message,
          modelId: params.modelId,
          ...(params.maxTurns !== undefined ? { maxTurns: params.maxTurns } : {}),
          ...(params.maxBudgetUsd !== undefined
            ? { maxBudgetUsd: params.maxBudgetUsd }
            : {}),
          sessionDir: params.sessionDir,
          webSearchEnabled: this.isWebSearchEnabled(params.backendId),
          ...(params.sessionDbId !== undefined ? { sessionDbId: params.sessionDbId } : {}),
          ...(params.turnToken ? { turnToken: params.turnToken } : {}),
          ...(params.stagedAttachments && params.stagedAttachments.length > 0
            ? { stagedAttachments: params.stagedAttachments }
            : {}),
          ...(params.eventCorrelationId
            ? { eventCorrelationId: params.eventCorrelationId }
            : {}),
        },
        streamCallbacks,
      );
      // executeResume also proves the backend holds valid credentials —
      // keep `auth_last_success_at` in sync so DM sessions that run
      // purely through session resumption don't false-trip the 60-day
      // keepalive reminder.
      recordReactiveAuthSuccess(this.db, params.backendId, this.authTelemetry);
      return result;
    } catch (error) {
      if (error instanceof BackendDecisiveFailure && error.kind === "auth") {
        recordReactiveAuthFailure(
          this.db,
          params.backendId,
          error.cause instanceof Error ? error.cause.message : String(error.cause ?? ""),
          this.authTelemetry,
        );
      }
      throw error;
    }
  }

  async summarize(conversationText: string): Promise<string> {
    const defaultBackendId = this.loadGlobalDefaults()?.default_backend ?? "claude";
    const core = this.cores[defaultBackendId] ?? Object.values(this.cores)[0];
    if (!core) {
      throw new Error("No agent backends are registered");
    }
    const result = await core.summarize(conversationText);
    // `summarize` is a successful backend invocation — the same reactive
    // self-heal applies. Runs after the outer core is chosen (see
    // loadGlobalDefaults fallback above), so stamp that backend.
    recordReactiveAuthSuccess(this.db, core.backendId, this.authTelemetry);
    return result;
  }

  /**
   * Pre-flight entry point: creates a synthetic mainFailure for the
   * skipped main backend and delegates to `executeFallbackCore`.
   */
  private async executePreflightFallback(
    binding: ResolvedBackendRoute,
    params: RouterExecuteParams,
    streamCallbacks?: StreamCallbacks,
  ): Promise<AgentResult> {
    const syntheticMainFailure = new BackendDecisiveFailure(
      binding.main.backendId,
      "auth",
      new Error("Pre-flight auth cache: main backend skipped"),
    );
    return this.executeFallbackCore(
      binding,
      params,
      syntheticMainFailure,
      streamCallbacks,
      { isPreflight: true },
    );
  }

  /**
   * Shared fallback execution — used by both the catch-block fallback
   * (where `mainFailure` is the real execute error) and the pre-flight
   * fallback (where `mainFailure` is a synthetic auth failure).
   *
   * Handles:
   *   - fallback core execution with the same params shape
   *   - reactive auth success/failure tracking on the fallback backend
   *   - fallback success notification to admin
   *   - fallback failure notification + BackendRouterHandledError throw
   *
   * Extracting this into a single method (design spec §5.2) ensures that
   * a new side-effect (e.g. a new telemetry counter) only needs to be
   * added once instead of in two diverging code paths.
   */
  private async executeFallbackCore(
    binding: ResolvedBackendRoute,
    params: RouterExecuteParams,
    mainFailure: BackendFailure,
    streamCallbacks?: StreamCallbacks,
    opts?: { isPreflight?: boolean },
  ): Promise<AgentResult> {
    const fallback = binding.fallback!;
    const fallbackCore = this.requireCore(fallback.backendId);
    const fallbackWebSearch = this.isWebSearchEnabled(fallback.backendId);

    // Ensure the session workdir has the fallback backend's instruction files.
    // Heavy-tier session dirs are materialized once for the main backend; without
    // this call, a Claude→Codex fallback would leave the dir with only CLAUDE.md
    // and no AGENTS.md for Codex to read.
    //
    // Preflight path: there is no real main-backend failure to mask, so a
    // throw here means the fallback would run in an unmaterialized workdir.
    // Re-throw — the caller can fall back to the real execute path and surface
    // a clearer diagnostic.
    //
    // Real-failure path: a throw here would mask the original main-backend
    // failure with a re-materialization error and skip the fallback entirely.
    // Log and continue: if the fallback core can't read its instructions the
    // next `execute()` will surface a clearer diagnostic than ENOSPC.
    if (params.sessionDir && this.prepareSessionDir) {
      try {
        const fallbackWikiWorkspace =
          typeof params.event.data?.workspace === "string"
            ? params.event.data.workspace
            : undefined;
        // Phase 4 — forward the inbound DM text so the fallback
        // re-materialise sees the same `*ForDm` trigger surface the main
        // path saw. Non-message events get `undefined` and the predicates
        // fall back to the base (DB-only) branch.
        const fallbackMessageText = isMessageEvent(params.event)
          ? params.event.content
          : undefined;
        this.prepareSessionDir(
          params.sessionDir,
          fallback.backendId,
          params.workdirEventType ?? params.event.type,
          params.workdirProcessKey ?? binding.processKey,
          fallbackWikiWorkspace,
          fallbackMessageText,
        );
      } catch (err) {
        if (opts?.isPreflight) {
          logger.error(
            {
              err,
              sessionDir: params.sessionDir,
              fallbackBackendId: fallback.backendId,
              processKey: binding.processKey,
            },
            "Pre-flight fallback session-dir re-materialization failed — aborting preflight",
          );
          throw err;
        }
        logger.error(
          {
            err,
            sessionDir: params.sessionDir,
            fallbackBackendId: fallback.backendId,
            processKey: binding.processKey,
          },
          "Fallback session-dir re-materialization failed — attempting fallback execute anyway",
        );
      }
    }

    // Re-apply backend-specific prompt overlays for the fallback backend
    // when the caller supplied a reassembler. See RouterExecuteParams docs.
    const fallbackPrompt = params.reassemblePrompt
      ? params.reassemblePrompt(fallback.backendId)
      : params.prompt;

    try {
      const result = await fallbackCore.execute(
        {
          prompt: fallbackPrompt,
          context: params.context,
          event: params.event,
          modelId: fallback.modelId,
          maxTurns: fallback.maxTurns,
          maxBudgetUsd: fallback.maxBudgetUsd,
          sessionDir: params.sessionDir,
          processKey: binding.processKey,
          persistSession: params.persistSession,
          conversationHistory: params.conversationHistory,
          webSearchEnabled: fallbackWebSearch,
          ...(params.sessionDbId !== undefined ? { sessionDbId: params.sessionDbId } : {}),
          ...(params.turnToken ? { turnToken: params.turnToken } : {}),
          ...(params.stagedAttachments && params.stagedAttachments.length > 0
            ? { stagedAttachments: params.stagedAttachments }
            : {}),
          ...(params.allowedToolsOverride
            ? { allowedToolsOverride: params.allowedToolsOverride }
            : {}),
          ...(params.wikiUrlFetchEnabled
            ? { wikiUrlFetchEnabled: true }
            : {}),
          ...(params.extraSkills && params.extraSkills.length > 0
            ? { extraSkills: params.extraSkills }
            : {}),
          ...(params.skillsReplace ? { skillsReplace: true } : {}),
        },
        streamCallbacks,
      );
      recordReactiveAuthSuccess(
        this.db,
        fallback.backendId,
        this.authTelemetry,
      );
      // PREPASS_COST_REDUCTION_PLAN.md N1 — the main attempt may have
      // billed before failing over (e.g. a Claude max_budget_usd abort
      // with a partial-usage snapshot). On fallback SUCCESS the
      // dispatcher's error path never runs, so this is the only place
      // the main attempt's spend can land in agent_actions; without it
      // the run shows only the fallback's success row and the main
      // attempt's cost is invisible.
      this.recordMainFailureSpend(params.event, mainFailure);
      await this.notifyFallbackSuccess(
        params.event,
        binding.processKey,
        binding.main,
        mainFailure,
        fallback,
      );
      return result;
    } catch (fallbackError) {
      if (
        fallbackError instanceof BackendDecisiveFailure
        && fallbackError.kind === "auth"
      ) {
        recordReactiveAuthFailure(
          this.db,
          fallback.backendId,
          fallbackError.cause instanceof Error
            ? fallbackError.cause.message
            : String(fallbackError.cause ?? ""),
          this.authTelemetry,
        );
      }
      if (
        !(fallbackError instanceof BackendDecisiveFailure
          || fallbackError instanceof BackendQuotaError)
      ) {
        // Raw (unclassified) fallback errors are rethrown without the
        // router wrap, so the dispatcher's spend unwrap never sees
        // `mainFailure` — record its spend here before rethrowing.
        // PREPASS_COST_REDUCTION_PLAN.md N1.
        this.recordMainFailureSpend(params.event, mainFailure);
        throw fallbackError;
      }
      await this.handleFallbackFailure(
        params.event,
        binding.processKey,
        binding.main,
        mainFailure,
        fallback,
        fallbackError,
      );
      throw new BackendRouterHandledError(
        `Fallback backend "${fallback.backendId}" failed after "${binding.main.backendId}" — `
          + `main: ${describeBackendFailure(mainFailure)}; `
          + `fallback: ${describeBackendFailure(fallbackError)}`,
        fallbackError,
        mainFailure,
        fallbackError,
      );
    }
  }

  /**
   * Best-effort `agent_actions` record of the main attempt's billed
   * spend on paths where the dispatcher's `BackendRouterHandledError`
   * unwrap will never see `mainFailure` (fallback success, raw fallback
   * rethrow). No-op when the failure carries no spend.
   * PREPASS_COST_REDUCTION_PLAN.md N1.
   */
  private recordMainFailureSpend(event: Event, mainFailure: BackendFailure): void {
    const spendInfo = extractFailureSpendInfo(mainFailure);
    if (spendInfo) {
      recordFailureSpendRow(
        this.db,
        event,
        spendInfo,
        describeBackendFailure(mainFailure),
      );
    }
  }

  resolveBinding(
    event: Event,
    options?: {
      processKey?: ProcessKey;
      requestedTier?: ProcessModelTier;
      requestedBackendId?: BackendId;
      requestedModelId?: string;
    },
  ): ResolvedBackendRoute {
    // Built-in Agent override layer (AGENT_DEFINITIONS_DESIGN.md §6.4.1
    // runtime wiring). When the firing resolved to a built-in Agent whose
    // operator saved tier / model / limit overrides on the Definition tab,
    // fold them in UNDER caller-explicit options:
    //
    //   caller-explicit (chat picker, run-now hint, fetch-window backend pin)
    //     > agent override snapshot
    //       > process_backend_config / process-key defaults
    //
    // A caller that passes ANY routing option (tier, backend, or model)
    // keeps full control and the agent override is skipped WHOLESALE —
    // routing AND limits. The explicit-caller cases are all envelopes the
    // caller owns deliberately: run-now / !checks model hints, the
    // dashboard pickers, the morning-retry medium clamp (a cost cap that
    // must not be re-widened by an agent override), and the fetch-window
    // pre-pass — whose budget sizing + attempt-1 binding resolve against
    // the PARENT routine event (stamped with `agentId`) plus a
    // `requestedBackendId` pin, so a limits-always rule would leak the
    // Agent's envelope into its pre-pass sub-sessions while retries
    // (resolved against unstamped fetcher events) stayed clean.
    //
    // With no caller routing intent, the agent's model pin wins over its
    // own tier (a concrete model is the more specific standing
    // instruction) and the limit overrides are applied onto the resolved
    // main + fallback bindings.
    const agentOverride = this.loadAgentRouteOverride(event);
    if (agentOverride) {
      const callerRouted =
        options?.requestedTier !== undefined
        || options?.requestedBackendId !== undefined
        || options?.requestedModelId !== undefined;
      if (!callerRouted) {
        const merged = {
          ...options,
          ...(agentOverride.tier ? { requestedTier: agentOverride.tier } : {}),
          ...(agentOverride.modelId && agentOverride.backendId
            ? {
                requestedBackendId: agentOverride.backendId,
                requestedModelId: agentOverride.modelId,
              }
            : {}),
        };
        return this.applyAgentLimitOverrides(
          this.resolveBindingCore(event, merged),
          agentOverride,
        );
      }
    }
    return this.resolveBindingCore(event, options);
  }

  /**
   * Read the firing Agent's routing override. `event.data.agentId` is
   * stamped by `Dispatcher.beginAgentExecution` for every firing that
   * resolves to an Agent (and propagates to morning Stage A/B via the
   * parent-data spread); reactive DMs and pre-pass fan-out sub-events carry
   * no stamp and resolve to `null` here. User Agents are excluded — their
   * tier / backend / model already arrive as explicit event hints from the
   * materialised schedule row.
   */
  private loadAgentRouteOverride(event: Event): AgentRouteOverride | null {
    if (!this.hasAgentsTable) return null;
    const agentId = (event.data as { agentId?: unknown } | undefined)?.agentId;
    if (typeof agentId !== "string" || agentId.length === 0) return null;
    let row: { source: string; metadata_json: string | null } | undefined;
    try {
      row = this.db
        .prepare<[string], { source: string; metadata_json: string | null }>(
          "SELECT source, metadata_json FROM agents WHERE id = ? LIMIT 1",
        )
        .get(agentId);
    } catch (err) {
      logger.warn({ err, agentId }, "agent override lookup failed; ignoring");
      return null;
    }
    if (!row || row.source !== "builtin" || !row.metadata_json) return null;
    let override: AgentRouteOverride | null;
    try {
      const metadata = JSON.parse(row.metadata_json) as {
        override_snapshot?: unknown;
      };
      override = extractAgentRouteOverride(metadata.override_snapshot);
    } catch {
      // Corrupt metadata_json must never take routing down with it.
      return null;
    }
    // Standing-pin drift guard: the dashboard dropdown only offers enabled
    // backends at SAVE time, but an agent override persists across later
    // backend disables. A pin to a now-disabled backend would fail the
    // firing on every cron tick (hard override drops the fallback), so
    // drop the pin — tier/limit overrides survive. The chat picker has no
    // such guard because its pin lives for a single user-initiated turn.
    if (override?.backendId && this.isBackendDisabled(override.backendId)) {
      logger.warn(
        { agentId, backendId: override.backendId, modelId: override.modelId },
        "agent model pin targets a disabled backend; ignoring the pin",
      );
      const stripped: AgentRouteOverride = {
        ...override,
        modelId: null,
        backendId: null,
      };
      return stripped.tier === null
        && stripped.maxTurns === null
        && stripped.maxBudgetUsd === null
        ? null
        : stripped;
    }
    return override;
  }

  /** True only when an explicit `backends` row says `enabled = 0`. A missing
   *  row or table stays permissive — matches the resolver's existing trust
   *  posture for `process_backend_config` backends. */
  private isBackendDisabled(backendId: BackendId): boolean {
    try {
      const row = this.db
        .prepare<[string], { enabled: number }>(
          "SELECT enabled FROM backends WHERE id = ? LIMIT 1",
        )
        .get(backendId);
      return row !== undefined && row.enabled === 0;
    } catch {
      return false;
    }
  }

  /** Apply the Agent's per-execution limit overrides onto a resolved route. */
  private applyAgentLimitOverrides(
    route: ResolvedBackendRoute,
    override: AgentRouteOverride,
  ): ResolvedBackendRoute {
    if (override.maxTurns === null && override.maxBudgetUsd === null) {
      return route;
    }
    const applyTo = (binding: ResolvedBackendBinding): ResolvedBackendBinding => ({
      ...binding,
      maxTurns: override.maxTurns ?? binding.maxTurns,
      maxBudgetUsd: override.maxBudgetUsd ?? binding.maxBudgetUsd,
    });
    return {
      ...route,
      main: applyTo(route.main),
      fallback: route.fallback ? applyTo(route.fallback) : null,
    };
  }

  private resolveBindingCore(
    event: Event,
    options?: {
      processKey?: ProcessKey;
      requestedTier?: ProcessModelTier;
      requestedBackendId?: BackendId;
      requestedModelId?: string;
    },
  ): ResolvedBackendRoute {
    const processKey = options?.processKey ?? resolveProcessKey(event);
    // TIER_LOCKED hard clamp (DOCS_QA_B7_DESIGN.md S2). When set, this
    // process is pinned to a tier regardless of requestedTier hints,
    // process_backend_config rows, or global defaults. Folded into
    // `effectiveRequestedTier` so the model-substitution branch below
    // also fires, swapping any operator-pinned wrong-tier model to the
    // canonical model at the locked tier.
    const lockedTier = TIER_LOCKED_PROCESS_KEYS[processKey];
    const effectiveRequestedTier = lockedTier ?? options?.requestedTier;
    const requestedTier = effectiveRequestedTier;
    const requestedBackendId = options?.requestedBackendId;
    const requestedModelId = options?.requestedModelId;
    const processConfig = this.loadProcessConfig(processKey);

    // Explicit backend+model HARD override — dashboard chat model picker.
    // Supersedes requestedTier and process_backend_config pins. Fallback is
    // dropped: if the user explicitly picked a backend, silently rerouting
    // to a different fallback would defeat the point of the picker. We
    // still load maxTurns/maxBudget from process_backend_config so the
    // user's per-process caps keep applying; otherwise fall back to the
    // same defaults `resolveBinding` uses for unconfigured processes.
    //
    // Registered model → its registry tier becomes `resolvedTier`.
    // Unregistered (custom) model → use the ProcessKey's default tier
    // rather than hardcoding "high"; the override shouldn't mint a
    // high-tier envelope for a medium-tier process just because the model
    // id isn't in the registry.
    if (requestedBackendId && requestedModelId) {
      const overrideTier =
        this.tierFromModelId(requestedBackendId, requestedModelId) ??
        this.resolveTier(processKey);
      return {
        processKey,
        resolvedTier: overrideTier,
        main: {
          backendId: requestedBackendId,
          modelId: requestedModelId,
          maxTurns:
            processConfig?.max_turns ??
            PROCESS_MAX_TURNS[processKey] ??
            (overrideTier === "high" ? 300 : overrideTier === "medium" ? 50 : 20),
          maxBudgetUsd:
            processConfig?.max_budget_usd ??
            (overrideTier === "high" ? 5.0 : overrideTier === "medium" ? 1.0 : 0.2),
        },
        fallback: null,
      };
    }

    // Backend-only override. Used by the routine pre-pass fan-out
    // (`RoutineFetchWindowRunner`) so a `native` integration bound to a
    // backend other than the configured `routine.fetch_window` backend
    // can still spawn its sub-session on the integration's actual
    // backend (e.g. gmail-native-codex while fetch_window default is
    // claude).
    //
    // Model resolution mirrors the no-override branch's pin semantics so
    // operator customisation is preserved when the override does not
    // actually change the backend:
    //   1. If `requestedBackendId === processConfig.main_backend`, reuse
    //      `processConfig.main_model` (operator's pin). Only swap to a
    //      canonical (backend, tier) model when an explicit
    //      `requestedTier` mismatches the pinned model's registry tier —
    //      this mirrors `maybeApplyTierOverride` below. Without this
    //      branch, a Pro-preset operator who pinned `routine.fetch_window`
    //      to Sonnet would silently get Haiku on every direct-mode
    //      integration sub-session (the canonical lite model), because
    //      the runner ALWAYS passes `requestedBackendId` — even for
    //      sub-plans whose required backend equals the default.
    //   2. Otherwise (cross-backend), the pinned model is for a
    //      different backend and unusable. Look up the canonical model
    //      for (requestedBackendId, resolved tier) via
    //      `resolveDefaultModelId` (same helper the no-override branch
    //      uses for the no-processConfig fallback path).
    //
    // `maxTurns`/`maxBudgetUsd` inherit from `processConfig` regardless
    // — envelopes are per-process, not per-backend.
    //
    // Fallback is dropped — caller specified a backend by name, silently
    // rerouting to a different backend would defeat the purpose of the
    // per-integration routing (matches the dropped-fallback rule of the
    // combined backend+model override above).
    if (requestedBackendId) {
      const overrideTier = this.resolveTier(processKey, requestedTier);
      let modelId: string;
      if (
        processConfig
        && processConfig.main_backend === requestedBackendId
      ) {
        const pinnedTier = this.tierFromModelId(
          requestedBackendId,
          processConfig.main_model,
        );
        // Swap to canonical only when the caller passed an explicit
        // `requestedTier` AND the pin's registry tier disagrees. An
        // unknown `pinnedTier` (custom model) is preserved verbatim —
        // operator chose it on purpose, same trust contract as
        // `maybeApplyTierOverride`.
        const shouldSwap =
          requestedTier !== undefined
          && pinnedTier !== null
          && pinnedTier !== overrideTier;
        if (shouldSwap) {
          const defaults = this.loadGlobalDefaults();
          modelId = this.resolveDefaultModelId(
            requestedBackendId,
            overrideTier,
            defaults,
          );
        } else {
          modelId = processConfig.main_model;
        }
      } else {
        const defaults = this.loadGlobalDefaults();
        modelId = this.resolveDefaultModelId(
          requestedBackendId,
          overrideTier,
          defaults,
        );
      }
      return {
        processKey,
        resolvedTier: overrideTier,
        main: {
          backendId: requestedBackendId,
          modelId,
          maxTurns:
            processConfig?.max_turns ??
            PROCESS_MAX_TURNS[processKey] ??
            (overrideTier === "high" ? 300 : overrideTier === "medium" ? 50 : 20),
          maxBudgetUsd:
            processConfig?.max_budget_usd ??
            (overrideTier === "high" ? 5.0 : overrideTier === "medium" ? 1.0 : 0.2),
        },
        fallback: null,
      };
    }

    const resolvedTier = this.resolveTier(processKey, requestedTier);

    if (processConfig) {
      const main = this.resolveConfiguredBinding(
        processConfig.main_backend,
        processConfig.main_model,
        processConfig.max_turns,
        processConfig.max_budget_usd,
      );
      const fallback =
        processConfig.fallback_backend && processConfig.fallback_model
          ? this.resolveConfiguredBinding(
              processConfig.fallback_backend,
              processConfig.fallback_model,
              processConfig.max_turns,
              processConfig.max_budget_usd,
            )
          : null;

      // Explicit tier override — see RouterExecuteParams.requestedTier.
      // Triggered when the caller passes an explicit requestedTier whose
      // tier does NOT match the pinned model's registry tier. We swap the
      // main model to a canonical choice for (backend, requestedTier).
      // Without this branch, the explicit Opus escape hatches
      // (agent_schedule.model, run-now requestedModel, dashboard chat
      // picker's legacy sonnet/opus form) would be silently ignored after
      // any Pro preset apply — every configurable process would be pinned
      // to Sonnet and `main` would return that Sonnet regardless. The
      // cross-backend superset override (requestedBackendId/requestedModelId)
      // is handled earlier in this function and does not reach this
      // branch.
      //
      // Invariants:
      //   - If the pinned model's registry tier is unknown (user-supplied
      //     custom model id), DO NOT override. The user explicitly chose a
      //     non-standard model; clobbering it would be a silent regression.
      //   - Fallback binding is preserved IFF its model's registry tier
      //     also matches `requestedTier`. Otherwise drop it — routing back
      //     to the wrong-tier fallback defeats the purpose of the override.
      if (requestedTier) {
        const overridden = this.maybeApplyTierOverride(
          main,
          requestedTier,
          processKey,
        );
        if (overridden) {
          const preservedFallback = this.preserveFallbackOnOverride(
            fallback,
            requestedTier,
          );
          return {
            processKey,
            resolvedTier,
            main: overridden,
            fallback: this.refineFallback(processKey, preservedFallback),
          };
        }
      }

      return {
        processKey,
        resolvedTier,
        main,
        fallback: this.refineFallback(processKey, fallback),
      };
    }

    const defaults = this.loadGlobalDefaults();
    const defaultBackendId = defaults?.default_backend ?? "claude";
    const modelId = this.resolveDefaultModelId(defaultBackendId, resolvedTier, defaults);

    return {
      processKey,
      resolvedTier,
      main: {
        backendId: defaultBackendId,
        modelId,
        maxTurns:
          PROCESS_MAX_TURNS[processKey] ??
          (resolvedTier === "high" ? 300 : resolvedTier === "medium" ? 50 : 20),
        maxBudgetUsd:
          resolvedTier === "high" ? 5.0 : resolvedTier === "medium" ? 1.0 : 0.2,
      },
      fallback: null,
    };
  }

  private resolveConfiguredBinding(
    backendId: BackendId,
    configuredModelId: string,
    configuredMaxTurns: number,
    configuredMaxBudgetUsd: number,
  ): ResolvedBackendBinding {
    return {
      backendId,
      modelId: configuredModelId,
      maxTurns: configuredMaxTurns,
      maxBudgetUsd: configuredMaxBudgetUsd,
    };
  }

  /**
   * Returns a modified binding whose `modelId` has been swapped to a canonical
   * model for `requestedTier` on the same backend, or `null` when no override
   * should be applied.
   *
   * Returns `null` (no override) in any of these cases:
   *   1. The pinned model's registry tier is unknown (user-supplied custom
   *      model id). This is **critical**: the user explicitly chose a
   *      non-standard model, so we trust their choice over an
   *      auto-substituted registry default. The previous implementation of
   *      this method clobbered custom pins — that was a regression and is
   *      covered by a dedicated test now.
   *   2. The pinned model's tier already matches `requestedTier`.
   *   3. No suitable canonical model exists for (backend, tier) in the
   *      registry, or the canonical choice happens to be the already-pinned
   *      model.
   */
  private maybeApplyTierOverride(
    main: ResolvedBackendBinding,
    requestedTier: ProcessModelTier,
    processKey: ProcessKey,
  ): ResolvedBackendBinding | null {
    const pinnedTier = this.tierFromModelId(main.backendId, main.modelId);
    if (pinnedTier === null) {
      // Unknown tier → user-supplied custom model. Preserve it.
      return null;
    }
    if (pinnedTier === requestedTier) {
      return null;
    }

    const canonical = this.resolveCanonicalTierModel(main.backendId, requestedTier);
    if (!canonical || canonical === main.modelId) {
      return null;
    }

    logger.debug(
      {
        processKey,
        pinnedModel: main.modelId,
        pinnedTier,
        requestedTier,
        overrideModel: canonical,
      },
      "Explicit tier override — bypassing processConfig.main_model",
    );
    return { ...main, modelId: canonical };
  }

  /**
   * Decide whether to keep the existing fallback binding when a tier override
   * has been applied to the main binding. Returns the fallback unchanged when
   * its model is registered at `requestedTier`; otherwise `null` so we don't
   * silently route the override request into a wrong-tier fallback.
   *
   * Unregistered fallback model ids (custom) are preserved for the same
   * reason as in `maybeApplyTierOverride`: trust user configuration.
   */
  private preserveFallbackOnOverride(
    fallback: ResolvedBackendBinding | null,
    requestedTier: ProcessModelTier,
  ): ResolvedBackendBinding | null {
    if (!fallback) return null;
    const fallbackTier = this.tierFromModelId(fallback.backendId, fallback.modelId);
    if (fallbackTier === null || fallbackTier === requestedTier) {
      return fallback;
    }
    return null;
  }

  /**
   * Phase 4 — Integration-delegation gating.
   *
   * Null the fallback when the fallback backend has no registry connector
   * for any delegated integration whose `taskFlowsTouched` declares this
   * process key. Routing a delegated-integration process key into a
   * connector-less backend would silently execute without the integration
   * tools the task-flow variant expects.
   *
   * Main-backend incompatibility is intentionally NOT checked here —
   * `PATCH /api/integrations/:key` and the setup wizard (§4.12.2 / §4.12.4)
   * are the user-facing enforcement points. The router only refuses the
   * fallback, which is the silent-rewire path the design spec calls out
   * (§Phase 4, "Fallback refused when fallback backend lacks the connector
   * required for any delegated integration the ProcessKey touches").
   *
   * Descriptor presence = contract: no live probe, no capabilityTools walk.
   * Missing `backendConnectors[fallbackBackend]` → no connector → drop.
   */
  private refineFallbackForDelegation(
    processKey: ProcessKey,
    fallback: ResolvedBackendBinding | null,
  ): ResolvedBackendBinding | null {
    if (!fallback) return null;
    const integrations = readIntegrations(this.db);
    const delegatedTouched = delegatedIntegrationsForProcessKey(
      processKey,
      integrations,
    );
    if (delegatedTouched.length === 0) return fallback;

    const blocking: IntegrationKey[] = delegatedTouched.filter(
      (k) => !backendHasIntegrationConnector(k, fallback.backendId),
    );
    if (blocking.length === 0) return fallback;

    logger.warn(
      {
        processKey,
        fallbackBackendId: fallback.backendId,
        blockingIntegrations: blocking,
      },
      "Fallback backend lacks a connector for delegated integration(s) — dropping fallback",
    );
    return null;
  }

  /**
   * INTEGRATION_NATIVE_MODE_DESIGN.md §10.1 — native fallback gate.
   *
   * Native mode pins the integration to a specific backend (`nativeBackend`).
   * The data path is the backend's own MCP — there is no proxy. So a
   * fallback whose `backendId` differs from `nativeBackend` cannot serve
   * the ProcessKey: it lacks the connector entirely and the daemon route
   * is 410-gated in native mode (§9.1). Drop the fallback rather than
   * silently route into a half-functional backend.
   *
   * This is stricter than the delegated gate above: delegated cross-backend
   * routes daemon-side via `/api/integrations/:key/exec`, so a fallback
   * with the right descriptor connector entry is still serviceable.
   * Native has no such proxy fallback, hence equality on `nativeBackend`
   * is the contract.
   */
  private refineFallbackForNative(
    processKey: ProcessKey,
    fallback: ResolvedBackendBinding | null,
  ): ResolvedBackendBinding | null {
    if (!fallback) return null;
    const integrations = readIntegrations(this.db);
    const nativeTouched = nativeIntegrationsForProcessKey(
      processKey,
      integrations,
    );
    if (nativeTouched.length === 0) return fallback;

    const blocking: IntegrationKey[] = nativeTouched.filter((k) => {
      const state = integrations[k];
      return state?.mode !== "native"
        || state.nativeBackend !== fallback.backendId;
    });
    if (blocking.length === 0) return fallback;

    logger.warn(
      {
        processKey,
        fallbackBackendId: fallback.backendId,
        blockingIntegrations: blocking,
      },
      "Fallback backend does not match nativeBackend for native integration(s) — dropping fallback",
    );
    return null;
  }

  /**
   * Chain `refineFallbackForDelegation` + `refineFallbackForNative` —
   * a fallback that any one of the gates drops stays dropped. Single
   * helper so the two call sites stay 1-line.
   */
  private refineFallback(
    processKey: ProcessKey,
    fallback: ResolvedBackendBinding | null,
  ): ResolvedBackendBinding | null {
    return this.refineFallbackForNative(
      processKey,
      this.refineFallbackForDelegation(processKey, fallback),
    );
  }

  private tierFromModelId(
    backendId: BackendId,
    modelId: string,
  ): ProcessModelTier | null {
    return findRegisteredModel(backendId, modelId)?.tier ?? null;
  }

  /**
   * Pick a canonical model for (backendId, tier) when the caller requests an
   * explicit tier that the process_backend_config row does NOT satisfy.
   *
   * Priority:
   *   1. Global default for that tier if (a) backend matches the default
   *      backend AND (b) the configured default model is actually that tier
   *      in the registry. The registered-tier guard prevents an
   *      operator-customised default from leaking the wrong tier into the
   *      router's resolution path.
   *   2. First available model of (backendId, tier) in the model registry.
   *   3. `null` — caller should keep the pinned model.
   */
  private resolveCanonicalTierModel(
    backendId: BackendId,
    tier: ProcessModelTier,
  ): string | null {
    const defaults = this.loadGlobalDefaults();
    if (defaults && defaults.default_backend === backendId) {
      const candidate =
        tier === "high"
          ? defaults.default_high_model
          : tier === "medium"
            ? defaults.default_medium_model
            : defaults.default_lite_model;
      const registered = findRegisteredModel(backendId, candidate);
      if (registered?.tier === tier && registered.available) {
        return candidate;
      }
    }

    const match = getModelsForBackend(backendId).find(
      (model) => model.tier === tier && model.available,
    );
    return match?.modelId ?? null;
  }

  private resolveDefaultModelId(
    backendId: BackendId,
    tier: ProcessModelTier,
    defaults: BackendGlobalDefaultsRow | null,
  ): string {
    if (defaults && backendId === defaults.default_backend) {
      return tier === "high"
        ? defaults.default_high_model
        : tier === "medium"
          ? defaults.default_medium_model
          : defaults.default_lite_model;
    }

    if (backendId === "claude") {
      return tier === "high"
        ? DEFAULT_CLAUDE_HIGH_MODEL
        : tier === "medium"
          ? DEFAULT_CLAUDE_MEDIUM_MODEL
          : DEFAULT_CLAUDE_LITE_MODEL;
    }

    const core = this.cores[backendId];
    const models = core?.listModels() ?? [];
    const exactTier = models.find((model) => model.tier === tier && model.available);
    const fallback = models.find((model) => model.available) ?? models[0];
    if (exactTier) return exactTier.modelId;
    if (fallback) return fallback.modelId;

    throw new BackendDecisiveFailure(
      backendId,
      "model_unavailable",
      new Error(`No registered model is available for backend "${backendId}"`),
    );
  }

  private resolveTier(
    processKey: ProcessKey,
    requestedTier?: ProcessModelTier,
  ): ProcessModelTier {
    // Hard lock — supersedes both `requestedTier` and any operator pin
    // in `process_backend_config`. Keeps process keys like
    // `dashboard.docs_qa` on the canonical medium tier even when the
    // operator pinned the row to high in /settings/models (the
    // tier-aware cascade leaves `updated_by='user'` rows alone). See
    // TIER_LOCKED_PROCESS_KEYS for rationale.
    const locked = TIER_LOCKED_PROCESS_KEYS[processKey];
    if (locked) {
      return locked;
    }
    if (requestedTier) {
      return requestedTier;
    }
    if (isProcessKey(processKey)) {
      return getDefaultTierForProcessKey(processKey);
    }
    // B-007 §5.8 — custom routines default to 'medium'. The scheduler
    // normally emits an explicit `requestedModel` sourced from the
    // routine file's `backend_tier` frontmatter, but if it ever arrives
    // without one we default to medium rather than high so a
    // misconfigured custom routine cannot silently drain the Opus quota.
    if (isCustomRoutineKey(processKey)) {
      return "medium";
    }
    // Truly unknown process keys keep the pre-B-007 behaviour of
    // routing to a sufficient tier for unattended work — medium is the
    // safer default than high (Opus) for unknown callers.
    return "medium";
  }

  private requireCore(backendId: BackendId): IAgentCore {
    const core = this.cores[backendId];
    if (!core) {
      throw new BackendDecisiveFailure(
        backendId,
        "model_unavailable",
        new Error(`Backend "${backendId}" is not registered`),
      );
    }
    return core;
  }

  private loadProcessConfig(processKey: ProcessKey): ProcessConfigRow | null {
    if (!this.hasProcessConfigTable) {
      return null;
    }
    return (
      (this.db
        .prepare(
          `SELECT
             main_backend,
             main_model,
             fallback_backend,
             fallback_model,
             max_turns,
             max_budget_usd
           FROM process_backend_config
           WHERE process_key = ?`,
        )
        .get(processKey) as ProcessConfigRow | undefined) ?? null
    );
  }

  private loadGlobalDefaults(): BackendGlobalDefaultsRow | null {
    if (!this.hasBackendDefaultsTable) {
      return null;
    }
    return (
      (this.db
        .prepare(
          `SELECT
             default_backend,
             default_lite_model,
             default_medium_model,
             default_high_model
           FROM backend_global_defaults
           WHERE singleton = 1`,
        )
        .get() as BackendGlobalDefaultsRow | undefined) ?? null
    );
  }

  private isWebSearchEnabled(backendId: BackendId): boolean {
    try {
      const row = this.db
        .prepare("SELECT web_search_enabled FROM backends WHERE id = ?")
        .get(backendId) as { web_search_enabled: number } | undefined;
      return row?.web_search_enabled === 1;
    } catch (err) {
      // Defensive fallback: if the column or table is unexpectedly absent,
      // treat web search as off rather than failing the binding lookup.
      logger.debug({ err, backendId }, "web_search_enabled query failed, defaulting to false");
      return false;
    }
  }

  private hasTable(name: string): boolean {
    const row = this.db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
      )
      .get(name) as { 1: number } | undefined;
    return !!row;
  }

  /**
   * BROWSER_HISTORY_INTEGRATION_PLAN §10.3 — backend safety floor check.
   * Returns null when the resolved binding satisfies the floor (or no
   * floor applies to the process key); returns a violation otherwise.
   *
   * The floor is consulted via `getBrowserHistorySafetyFloor`, a
   * static map keyed by process key. When a new high-sensitivity
   * integration ships, it registers its own floor map and routes
   * through a similar lookup; this helper is the single chokepoint.
   *
   * Validates BOTH `binding.main` and `binding.fallback`. The earlier
   * implementation only checked main, which left a security gap: for
   * `routine.research_dispatch` (Claude-only — non-negotiable per the
   * design), a main=Claude / fallback=Codex configuration would pass
   * the gate, but a decisive failure on Claude would then run the
   * routine on Codex through `executeFallbackCore`, violating the
   * floor silently. §10.3 is explicit: "There is no fallback to
   * 'best effort with prose deny' — the design's threat model assumes
   * the enforcement surface holds; running without it is not a
   * graceful degradation, it is a security regression."
   */
  private checkSafetyFloor(
    binding: ResolvedBackendRoute,
  ): { reason: string; backendId: BackendId; side: "main" | "fallback" } | null {
    const floor = getBrowserHistorySafetyFloor(binding.processKey);
    if (!floor) return null;
    const mainViolation = this.evaluateSafetyFloorForBackend(
      binding.processKey,
      binding.main.backendId,
      floor,
      "main",
    );
    if (mainViolation) return mainViolation;
    if (binding.fallback) {
      const fallbackViolation = this.evaluateSafetyFloorForBackend(
        binding.processKey,
        binding.fallback.backendId,
        floor,
        "fallback",
      );
      if (fallbackViolation) return fallbackViolation;
    }
    return null;
  }

  private evaluateSafetyFloorForBackend(
    processKey: ProcessKey,
    backendId: BackendId,
    floor: BackendSafetyFloor,
    side: "main" | "fallback",
  ): { reason: string; backendId: BackendId; side: "main" | "fallback" } | null {
    if (!floor.eligible.includes(backendId)) {
      return {
        reason: `Process ${processKey} requires one of [${floor.eligible.join(", ")}] but the ${side} binding is ${backendId}. ${floor.rationale}`,
        backendId,
        side,
      };
    }
    if (floor.forbiddenModes) {
      const mode = this.executionModeFor(backendId);
      const forbidden = floor.forbiddenModes.find(
        (entry) => entry.backend === backendId && entry.mode === mode,
      );
      if (forbidden) {
        return {
          reason: `Process ${processKey} cannot run on ${backendId} in ${mode} mode (${side} binding). ${floor.rationale}`,
          backendId,
          side,
        };
      }
    }
    return null;
  }

  private executionModeFor(backendId: BackendId): "strict" | "allow" {
    switch (backendId) {
      case "claude":
        return this.config.claudeExecutionPermissionMode;
      case "codex":
        return this.config.codexExecutionPermissionMode;
      case "gemini":
        return this.config.geminiExecutionPermissionMode;
      case "opencode":
        return this.config.opencodeExecutionPermissionMode;
    }
  }

  private logSafetyFloorRefusal(
    binding: ResolvedBackendRoute,
    violation: { reason: string; backendId: BackendId; side: "main" | "fallback" },
  ): void {
    try {
      this.db
        .prepare(
          `INSERT INTO agent_actions
             (action_type, result, error, detail)
           VALUES (?, ?, ?, ?)`,
        )
        .run(
          "backend_floor_refused",
          "failed",
          violation.reason,
          JSON.stringify({
            processKey: binding.processKey,
            backendId: violation.backendId,
            side: violation.side,
            executionMode: this.executionModeFor(violation.backendId),
            reason: violation.reason,
          }),
        );
    } catch (err) {
      // Defensive: an unexpected schema mismatch (e.g. agent_actions
      // missing columns in a stale test fixture) must not block the
      // refusal itself. The throw above still surfaces the policy.
      logger.warn(
        { err, processKey: binding.processKey },
        "Failed to persist backend_floor_refused audit row",
      );
    }
  }

  // BROWSER_HISTORY_INTEGRATION_PLAN §10.3 mandates a one-time DM on
  // floor refusal so the operator notices the binding is misconfigured.
  // Without the DM the routine silently stops running and the
  // `agent_actions` row is only visible through the dashboard activity
  // panel — easy to miss for a routine that runs nightly. We thread
  // the originating event through so notifier.send can route the
  // message on the configured owner channel.
  private async dmSafetyFloorOnce(
    binding: ResolvedBackendRoute,
    violation: { reason: string; backendId: BackendId; side: "main" | "fallback" },
    event: Event,
  ): Promise<void> {
    if (!this.notifier) return;
    const dedupeKey
      = `backend-floor:${binding.processKey}:${violation.side}:${violation.backendId}`;
    const message =
      `Browser-history routine \`${binding.processKey}\` is paused: `
      + `your configured ${violation.side} backend (${violation.backendId}) is not in the safety floor. `
      + `Adjust the binding in /settings/models and re-run.`;
    logger.warn(
      {
        processKey: binding.processKey,
        backendId: violation.backendId,
        reason: violation.reason,
      },
      message,
    );
    await this.notifyConfiguredChannel(message, event, dedupeKey, "high");
  }

  private async handleNoFallbackFailure(
    event: Event,
    processKey: ProcessKey,
    main: ResolvedBackendBinding,
    failure: BackendFailure,
  ): Promise<void> {
    await this.maybeSendUserFacingFailure(event, processKey, failure);
    await this.notifyConfiguredChannel(
      this.buildNoFallbackMessage(processKey, main, failure),
      event,
      `no-fallback:${processKey}:${main.backendId}:${this.describeFailureKind(failure)}`,
      "normal",
    );
  }

  private async handleFallbackFailure(
    event: Event,
    processKey: ProcessKey,
    main: ResolvedBackendBinding,
    mainFailure: BackendFailure,
    fallback: ResolvedBackendBinding,
    fallbackFailure: BackendFailure,
  ): Promise<void> {
    await this.maybeSendUserFacingFailure(event, processKey, fallbackFailure);
    await this.notifyConfiguredChannel(
      this.buildFallbackFailureMessage(
        processKey,
        main,
        mainFailure,
        fallback,
        fallbackFailure,
      ),
      event,
      null,
      "high",
    );
  }

  private async notifyFallbackSuccess(
    event: Event,
    processKey: ProcessKey,
    main: ResolvedBackendBinding,
    mainFailure: BackendFailure,
    fallback: ResolvedBackendBinding,
  ): Promise<void> {
    await this.notifyConfiguredChannel(
      this.buildFallbackSuccessMessage(processKey, main, mainFailure, fallback),
      event,
      `fallback-success:${processKey}:${main.backendId}:${fallback.backendId}`,
      "low",
    );
  }

  private async maybeSendUserFacingFailure(
    event: Event,
    processKey: ProcessKey,
    failure: BackendFailure,
  ): Promise<void> {
    if (!this.notifier || !this.isInteractiveProcess(processKey)) {
      return;
    }

    await this.notifier.send(
      this.buildUserFacingFailureMessage(failure),
      event,
    );
  }

  private async notifyConfiguredChannel(
    message: string,
    event: Event,
    dedupeKey: string | null,
    priority: "low" | "normal" | "high",
  ): Promise<void> {
    if (!this.notifier) {
      return;
    }
    if (dedupeKey && this.isNotificationDeduped(dedupeKey)) {
      return;
    }

    await this.notifier.send(message, event, {
      priority,
      destinationMode: "configured_only",
    });

    if (dedupeKey) {
      this.notificationDedup.set(dedupeKey, Date.now());
    }
  }

  private isNotificationDeduped(key: string): boolean {
    const lastSentAt = this.notificationDedup.get(key);
    if (!lastSentAt) {
      return false;
    }
    if (Date.now() - lastSentAt < NOTIFICATION_DEDUPE_WINDOW_MS) {
      return true;
    }
    this.notificationDedup.delete(key);
    return false;
  }

  private isInteractiveProcess(processKey: ProcessKey): boolean {
    return processKey === "message.dm"
      || processKey === "message.mention"
      || processKey === "dashboard.chat";
  }

  private describeFailureKind(failure: BackendFailure): string {
    if (failure instanceof BackendQuotaError) {
      return "quota";
    }
    return failure.kind;
  }

  private buildFallbackSuccessMessage(
    processKey: ProcessKey,
    main: ResolvedBackendBinding,
    mainFailure: BackendFailure,
    fallback: ResolvedBackendBinding,
  ): string {
    return [
      `Backend switch: ${processKey} encountered `,
      `${this.describeFailureKind(mainFailure)} on ${main.backendId}/${main.modelId}, `,
      `fell back to ${fallback.backendId}/${fallback.modelId}.`,
    ].join("");
  }

  private buildNoFallbackMessage(
    processKey: ProcessKey,
    main: ResolvedBackendBinding,
    failure: BackendFailure,
  ): string {
    return [
      `Backend execution failed: ${processKey} stopped due to `,
      `${this.describeFailureKind(failure)} on ${main.backendId}/${main.modelId}. `,
      "No fallback is configured.",
    ].join("");
  }

  private buildFallbackFailureMessage(
    processKey: ProcessKey,
    main: ResolvedBackendBinding,
    mainFailure: BackendFailure,
    fallback: ResolvedBackendBinding,
    fallbackFailure: BackendFailure,
  ): string {
    return [
      `Backend execution failed: ${processKey} encountered `,
      `${this.describeFailureKind(mainFailure)} on ${main.backendId}/${main.modelId}, `,
      `then ${this.describeFailureKind(fallbackFailure)} on ${fallback.backendId}/${fallback.modelId}.`,
    ].join("");
  }

  private buildUserFacingFailureMessage(failure: BackendFailure): string {
    switch (this.describeFailureKind(failure)) {
      case "quota":
        if (this.isMaxBudgetFailure(failure)) {
          return "The per-turn budget limit was reached. Please try a shorter request or raise the budget in backend settings.";
        }
        return "This backend has reached its usage limit. Please try again later.";
      case "auth":
        return "Backend authentication failed. Please re-authorize from the dashboard.";
      case "max_turns":
        return "The processing turn limit has been reached. Please try a shorter request.";
      case "timeout":
        return "The backend timed out. Please try again later.";
      case "model_unavailable":
        return "The configured model is currently unavailable. Please select a different model in settings.";
      case "policy_denied":
        // maybeSendUserFacingFailure surfaces only this kind-mapped string
        // (the raw cause never reaches the user), so keep the message
        // self-contained and agnostic to which specific TOML rule fired —
        // it could be curl chaining, a non-localhost host, --force on git,
        // or any future workspace policy.
        return "The agent tried a command that is blocked by the workspace policy. Try rephrasing your request and I'll attempt it again.";
      default:
        return "An error occurred during backend execution. Please try again.";
    }
  }

  private isMaxBudgetFailure(failure: BackendFailure): boolean {
    return failure instanceof BackendQuotaError
      && failure.originalCode === "max_budget_usd";
  }
}
