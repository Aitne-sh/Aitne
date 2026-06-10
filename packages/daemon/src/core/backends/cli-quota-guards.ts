/**
 * Shared per-turn budget enforcement and failure classification for the CLI
 * backends (`CodexCore`, `GeminiCliCore`).
 *
 * Both CLI backends surface the same two failover signals the dispatcher
 * relies on — `BackendQuotaError` (retry/failover on a different window or
 * backend) and `BackendDecisiveFailure` (auth / timeout / policy / other).
 * The budget asserts and the failure-classification skeleton were previously
 * duplicated byte-for-byte across the two cores, so a single bug fix to
 * quota/cost handling had to be applied in both places with real drift risk.
 * This module is the single source of truth for the CLI backends. Backend-
 * specific bits (the rate-limit / auth regexes, the human-readable backend
 * label, Gemini's policy-deny branch) stay with each core and are passed in.
 *
 * Deliberately NOT shared with the SDK backends — this mirrors the existing
 * Claude/CLI error-handling split (see the `quota-reset-hints.ts` header):
 *  - `OpenCodeCore` raises `BackendDecisiveFailure("model_unavailable")` with
 *    a different estimation model.
 *  - `ClaudeCodeCore` classifies `unknown` SDK errors via `instanceof` and
 *    keeps its own budget-message detector `isClaudeCodeMaxBudgetError`
 *    (`claude-errors.ts`) — a deliberate parallel to `isMaxBudgetMessage`
 *    here, tuned to the Anthropic SDK's structured `{message, code, type}`
 *    errors rather than raw CLI subprocess text. They share the same budget
 *    regex today: a maintainer changing what counts as a budget-rejection
 *    message must update BOTH detectors.
 * Forcing those shapes through this module would be over-abstraction.
 */
import type { BackendId, BackendUsage } from "@aitne/shared";
import {
  BackendDecisiveFailure,
  BackendQuotaError,
  type BackendQuotaSpend,
} from "../agent-core.js";
import { extractGenericQuotaResetHint } from "./quota-reset-hints.js";
import {
  estimateTextInputTokens,
  findRegisteredModel,
} from "./model-registry.js";
import type { PriceFetcher } from "./price-fetcher.js";

/**
 * True when a failure message looks like our own per-turn budget rejection
 * (see `assertCostWithinMaxBudget`). Lets `classifyCliFailure` re-tag a budget
 * message as `max_budget_usd` instead of mis-routing it into the generic
 * rate-limit branch.
 */
export function isMaxBudgetMessage(message: string): boolean {
  return /max(?:imum)? budget|max_budget_usd|budget limit|per-turn budget/i.test(
    message,
  );
}

/**
 * Post-completion per-turn budget enforcement. Both Codex and Gemini meter
 * `max_budget_usd` post-hoc — by the time we reject here the provider has
 * already consumed tokens — so the just-completed turn's `spend` is attached
 * to the `BackendQuotaError` so the dispatcher's error path can write a
 * `result='failed'` agent_actions row with `cost_usd` / `numTurns` /
 * `durationMs` populated. Without it, budget-rejected runs silently drop their
 * spend on the success-only audit path. See `BackendQuotaSpend`.
 */
export function assertCostWithinMaxBudget(params: {
  backendId: BackendId;
  /** Human-readable backend name for the rejection message, e.g. "Codex". */
  label: string;
  costUsd: number;
  maxBudgetUsd: number | undefined;
  modelId: string;
  spend?: Omit<BackendQuotaSpend, "modelId" | "costUsd">;
}): void {
  const { backendId, label, costUsd, maxBudgetUsd, modelId, spend } = params;
  if (maxBudgetUsd === undefined || costUsd <= maxBudgetUsd) {
    return;
  }
  throw new BackendQuotaError(
    backendId,
    "max_budget_usd",
    null,
    `${label} estimated cost $${costUsd.toFixed(4)} exceeded the per-turn budget limit $${maxBudgetUsd.toFixed(2)} for ${modelId}.`,
    spend ? { ...spend, modelId, costUsd } : null,
  );
}

/**
 * Pre-flight per-turn budget guard. Estimates the prompt's input-token cost
 * via the shared price fetcher and rejects before spawning the subprocess when
 * even the prompt alone would exceed `max_budget_usd`.
 */
export function assertPromptCostWithinMaxBudget(params: {
  backendId: BackendId;
  label: string;
  prompt: string;
  maxBudgetUsd: number | undefined;
  modelId: string;
  priceFetcher: PriceFetcher;
}): void {
  const { backendId, label, prompt, maxBudgetUsd, modelId, priceFetcher } =
    params;
  if (maxBudgetUsd === undefined) {
    return;
  }
  const estimatedUsage: BackendUsage = {
    inputTokens: estimateTextInputTokens(prompt),
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
  };
  const { costUsd } = priceFetcher.estimateUsageCost({
    backendId,
    modelId,
    usage: estimatedUsage,
    fallbackModel: findRegisteredModel(backendId, modelId),
  });
  if (costUsd <= maxBudgetUsd) {
    return;
  }
  throw new BackendQuotaError(
    backendId,
    "max_budget_usd",
    null,
    `${label} estimated prompt cost $${costUsd.toFixed(4)} exceeded the per-turn budget limit $${maxBudgetUsd.toFixed(2)} for ${modelId}.`,
  );
}

/**
 * PREPASS_COST_REDUCTION_PLAN.md N1 — recover a best-effort spend payload
 * for a CLI run that failed after the provider already billed tokens.
 * Returns `null` when the JSONL stream never surfaced usage (failure
 * before the first `turn.completed` / stats event), so callers can pass
 * the result straight to `classifyCliFailure` without an empty-usage
 * guard. The dollar figure is a price-fetcher estimate from the observed
 * token totals — same path the success branch uses — so a failed and a
 * successful run with identical usage report identical cost.
 */
export function recoverCliFailureSpend(params: {
  backendId: BackendId;
  priceFetcher: PriceFetcher;
  usage: BackendUsage;
  modelId: string;
  numTurns: number;
  durationMs: number;
}): BackendQuotaSpend | null {
  const { backendId, priceFetcher, usage, modelId, numTurns, durationMs } =
    params;
  const sawUsage =
    usage.inputTokens > 0
    || usage.outputTokens > 0
    || usage.cacheCreationInputTokens > 0
    || usage.cacheReadInputTokens > 0;
  if (!sawUsage) {
    return null;
  }
  const { costUsd, costSource } = priceFetcher.estimateUsageCost({
    backendId,
    modelId,
    usage,
    fallbackModel: findRegisteredModel(backendId, modelId),
  });
  return {
    usage,
    costUsd,
    modelId,
    numTurns: numTurns || 1,
    durationMs,
    costSource,
  };
}

/**
 * Optional pre-auth classifier — given a failure `message`, returns a
 * `BackendDecisiveFailure` when it owns the message, else `null` to fall
 * through to the shared auth/timeout/fallback branches. Runs BEFORE the auth
 * branch so backend-specific messages (e.g. Gemini policy-deny wraps that
 * contain "login"/"required") don't mis-tag as auth.
 */
export type CliFailureExtraClassifier = (
  message: string,
  backendId: BackendId,
) => BackendDecisiveFailure | null;

/**
 * Shared failure-classification skeleton for the CLI backends. Maps a raw
 * failure `message` to the dispatcher's failover signals in a fixed order:
 *
 *   1. our own budget rejection                → BackendQuotaError("max_budget_usd")
 *   2. rate-limit / quota (per-backend regex)  → BackendQuotaError("rate_limited")
 *      with a best-effort reset-time hint for the dashboard
 *   3. optional pre-auth `extraClassifier` (e.g. Gemini policy-deny) — runs
 *      BEFORE auth so deny messages containing "login"/"required" don't
 *      mis-tag as auth and trigger an auth-recovery flow
 *   4. auth (per-backend regex)                → BackendDecisiveFailure("auth")
 *   5. timeout                                 → BackendDecisiveFailure("timeout")
 *   6. anything else                           → BackendDecisiveFailure("other_non_retryable")
 *
 * The rate-limit and auth regexes differ per backend (OpenAI vs Google
 * wording), so each core passes its own.
 */
export function classifyCliFailure(params: {
  backendId: BackendId;
  message: string;
  rateLimitPattern: RegExp;
  authPattern: RegExp;
  extraClassifier?: CliFailureExtraClassifier;
  /**
   * PREPASS_COST_REDUCTION_PLAN.md N1 — best-effort spend recovered from
   * the failed run's JSONL stream (usage totals + price-fetcher
   * estimate). Attached to every error constructed here so the
   * dispatcher's post-hoc audit writer can record what the provider
   * already billed for a turn that produced no `AgentResult`. Errors
   * returned by `extraClassifier` keep their own (usually absent) spend
   * — the classifier owns the full construction of those.
   */
  spend?: BackendQuotaSpend | null;
}): BackendQuotaError | BackendDecisiveFailure {
  const { backendId, message, rateLimitPattern, authPattern, extraClassifier } =
    params;
  const spend = params.spend ?? null;
  if (isMaxBudgetMessage(message)) {
    return new BackendQuotaError(
      backendId,
      "max_budget_usd",
      null,
      message,
      spend,
    );
  }
  if (rateLimitPattern.test(message)) {
    // Best-effort reset-time extraction so the dashboard can surface
    // "quota resets at HH:MM (TZ)" instead of a bare "rate_limited" tag.
    // Falls through to null when no reset-time pattern matches.
    return new BackendQuotaError(
      backendId,
      "rate_limited",
      extractGenericQuotaResetHint(message),
      message,
      spend,
    );
  }
  const extra = extraClassifier?.(message, backendId);
  if (extra) {
    return extra;
  }
  if (authPattern.test(message)) {
    return new BackendDecisiveFailure(
      backendId,
      "auth",
      new Error(message),
      spend,
    );
  }
  if (/timed out|timeout/i.test(message)) {
    return new BackendDecisiveFailure(
      backendId,
      "timeout",
      new Error(message),
      spend,
    );
  }
  return new BackendDecisiveFailure(
    backendId,
    "other_non_retryable",
    new Error(message),
    spend,
  );
}
