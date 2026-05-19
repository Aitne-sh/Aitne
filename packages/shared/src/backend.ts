export const BACKEND_IDS = ["claude", "codex", "gemini", "opencode"] as const;

export type BackendId = (typeof BACKEND_IDS)[number];

/**
 * Backends whose `IAgentCore` is wired into the daemon's `BackendRouter` in
 * this build. Used by:
 *  - the dashboard's settings/commands/self-learning/integration cards,
 *    which gate selectable backends to those that can actually fire,
 *  - the daemon's API surface (`PUT /backends/main`,
 *    `PUT /process-config/:processKey`, `POST /commands`,
 *    `POST /chat/stream` requestedBackendId), which rejects writes pointing
 *    at registered-but-not-yet-runtime-supported backends with a clear
 *    `backend_not_runtime_supported` error rather than letting the row
 *    persist and dispatch fail later with `BackendDecisiveFailure`.
 *
 * **OpenCode joined in Phase 2.** `docs/design/appendices/opencode-backend.md` Phase 2
 * wired `OpencodeCore` into `BackendRouter` (`packages/daemon/src/index.ts`
 * §10), so opencode is now an accepted backend in destructive API paths
 * (`/api/backends/main`, `/api/process-config/:processKey`,
 * `/api/commands` `requestedBackendId`). Distinct from
 * `NATIVE_CONNECTOR_BACKEND_IDS` in `integrations.ts`, where opencode
 * stays excluded *permanently* (design §11) — OpenCode hosts no
 * native-mode MCP connectors. The two constants intentionally diverge
 * here.
 *
 * `as const` keeps the array's literal element types narrow so downstream
 * `Record<(typeof RUNTIME_AVAILABLE_BACKEND_IDS)[number], …>` lookups only
 * require the runtime-available subset; `satisfies readonly BackendId[]`
 * enforces every entry is a valid `BackendId`.
 */
export const RUNTIME_AVAILABLE_BACKEND_IDS = [
  "claude",
  "codex",
  "gemini",
  "opencode",
] as const satisfies readonly BackendId[];

/** Narrow type — runtime-available subset of `BackendId`. */
export type RuntimeAvailableBackendId =
  (typeof RUNTIME_AVAILABLE_BACKEND_IDS)[number];

/**
 * Type guard mirroring `isBackendId` but restricted to runtime-available
 * backends. Use this in API routes and dashboard derivations where the
 * runtime must be able to fire the backend.
 */
export function isRuntimeAvailableBackendId(
  value: string,
): value is RuntimeAvailableBackendId {
  return (RUNTIME_AVAILABLE_BACKEND_IDS as readonly string[]).includes(value);
}

export type BackendCostSource = "sdk" | "litellm" | "hardcoded";

/**
 * Per-backend tool/sandbox posture. Shared by the daemon cores
 * (via runtimeSettings.{claude,codex,gemini,opencode}ExecutionPermissionMode) and
 * the dashboard (backend-settings card + ConfigResponse).
 *
 * - `"strict"` — shipped defense-in-depth guardrails for the given backend.
 * - `"allow"` — strong permission mode: tool/sandbox restrictions off.
 *   Shell-level context-dir and sensitive-path blocks stay enforced on
 *   Claude + Gemini; OpenCode remote mode cannot enforce strict posture.
 *   Codex in allow mode runs under
 *   `--dangerously-bypass-approvals-and-sandbox` and cannot enforce them.
 */
export const EXECUTION_PERMISSION_MODES = ["strict", "allow"] as const;
export type ExecutionPermissionMode =
  (typeof EXECUTION_PERMISSION_MODES)[number];

/**
 * Three-tier model classification used across backends.
 *
 * - `lite` — cheapest, fastest model. Used for delegated-mode simple
 *   queries (mail polling, gmail classification, github/git event triage,
 *   integration drift sync, calendar change probes). For Claude this is
 *   Haiku 4.5; for Codex it's gpt-5.4-mini; for Gemini it's the flash-lite
 *   preview. Bound by a tight per-call envelope.
 * - `medium` — main agent surfaces (DMs, dashboard chat, hourly check,
 *   morning/evening/weekly/monthly reviews, scheduled DM tasks). Default
 *   tier for owner-in-the-loop work. For Claude this is Sonnet 4.6.
 * - `high` — heaviest reasoning workloads (advisor escalation, knowledge
 *   import, generative routines whose output feeds 24h of downstream
 *   activity). Operators opt in per process key from `/settings/models`.
 *   For Claude this is Opus 4.7.
 *
 * Replaces the legacy two-value `"light" | "heavy"` enum (2026-05). The
 * previous `light` collapsed delegated-and-DM into one bucket; splitting
 * out `lite` lets delegated proxy invocations default to Haiku without
 * dragging the main DM tier down with it.
 */
export type BackendModelTier = "lite" | "medium" | "high";

export interface BackendUsage {
  /**
   * Non-cached billable input tokens. Backends whose raw usage reports
   * cached tokens as a subset of total input must subtract the cached portion
   * before populating this field.
   */
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  costUsd?: number;
  costSource?: BackendCostSource;
}

export interface BackendModel {
  backendId: BackendId;
  modelId: string;
  label: string;
  displayName?: string;
  tier: BackendModelTier;
  available: boolean;
  supportsToolUse?: boolean;
  supportsStreaming?: boolean;
  supportsPromptCaching?: boolean;
  usdPer1kIn?: number;
  usdPer1kOut?: number;
  usdPer1kCacheRead?: number;
  usdPer1kCacheCreate?: number;
  usdPer1kInAboveThreshold?: number;
  usdPer1kOutAboveThreshold?: number;
  usdPer1kCacheReadAboveThreshold?: number;
  usdPer1kCacheCreateAboveThreshold?: number;
  inputCostThresholdTokens?: number;
  pricingThresholdMode?: "marginal" | "context";
  maxInputTokens?: number;
  maxOutputTokens?: number;
  /**
   * Legacy/superseded model kept in the registry so existing DB rows stay
   * valid but sorted to the end of UI pickers. New defaults should pick a
   * non-deprecated model in the same tier.
   */
  deprecated?: boolean;
  /**
   * Pin registry pricing as the authoritative source for this model. When set,
   * `PriceFetcher` ignores LiteLLM cache entries that disagree. Use for models
   * where upstream community pricing data is known stale or wrong (e.g.
   * Anthropic's newest Opus tier where LiteLLM lags). Without this flag the
   * LiteLLM cache wins, which is the right default for the long tail.
   */
  pricingTrusted?: boolean;
}

export function isBackendId(value: string): value is BackendId {
  return BACKEND_IDS.includes(value as BackendId);
}

export function getBackendIds(): readonly BackendId[] {
  return BACKEND_IDS;
}

/**
 * Backends that support web search tools.
 *
 * - Claude: SDK-native `WebSearch` tool, gated through `getAllowedTools`.
 * - Gemini: `google_web_search` tool, gated through the admin-policy TOML.
 * - Codex: OpenAI Responses-API `web_search` tool, enabled per-spawn via
 *   `-c tools.web_search=true` on `codex exec`. The tool runs server-side
 *   at OpenAI (not as a local shell command), so it works under the
 *   workspace-write sandbox without dropping any local guard — same
 *   posture as the interactive `codex --search` flag.
 * - OpenCode: `websearch` tool, gated through the OpenCode server config.
 *
 *   Empirically validated on codex-cli 0.124.0: codex parses
 *   `tools.web_search` as a `WebSearchToolConfigInput` enum (a wrong
 *   value type errors at config load), and `codex exec -c
 *   tools.web_search=true` accepts the override without complaint. End-
 *   to-end "agent actually called the tool" was not exercised here.
 */
export const WEB_SEARCH_CAPABLE_BACKENDS: ReadonlySet<BackendId> = new Set<BackendId>([
  "claude",
  "codex",
  "gemini",
  "opencode",
]);
