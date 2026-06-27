import type {
  BackendId,
  BackendModel,
  BackendModelTier,
  BackendUsage,
} from "@aitne/shared";

/**
 * Canonical per-backend default model IDs. Import these instead of
 * hardcoding the literal strings in fallbacks / aliases / legacy env parses
 * so a version bump is a one-line edit here.
 *
 * Tier semantics (see `BackendModelTier` in shared/backend.ts):
 *   - `LITE`   — delegated proxy + observer-fired short-shape tasks.
 *   - `MEDIUM` — main agent surfaces (DM, routines, activity scan, reviews).
 *   - `HIGH`   — heavy reasoning (advisor, knowledge import, generative one-shots).
 *
 * Sources of truth for the alias → API ID mapping:
 *   - Claude:  https://platform.claude.com/docs/en/about-claude/models/overview
 *   - Codex:   https://platform.openai.com/docs/models
 *   - Gemini:  https://ai.google.dev/gemini-api/docs/models
 */

// Claude
export const DEFAULT_CLAUDE_LITE_MODEL = "claude-haiku-4-5-20251001";
export const DEFAULT_CLAUDE_MEDIUM_MODEL = "claude-sonnet-4-6";
export const DEFAULT_CLAUDE_HIGH_MODEL = "claude-opus-4-8";

// Codex (gpt-5.4-mini is the lite-tier pick; gpt-5.4 is the medium-tier
// default — morning_routine / activity_scan / evening_review run on this.
// gpt-5.5 and gpt-5.5-chat-latest are the flagship reasoning models and
// stay registered at high tier as selectable opt-ins, but the seeded
// default for Codex's high tier is also gpt-5.4: gpt-5.5 carries Opus-
// class pricing (~$5 in / $30 out per MTok), and we don't want to spend
// that by default on surfaces that the user merely lets fall through to
// tier defaults. Operators who want gpt-5.5 pin it per row from
// /settings/models. See `SEED_HIGH_TIER_OVERRIDE` below.)
export const DEFAULT_CODEX_LITE_MODEL = "gpt-5.4-mini";
export const DEFAULT_CODEX_MEDIUM_MODEL = "gpt-5.4";
export const DEFAULT_CODEX_HIGH_MODEL = "gpt-5.4";

// Gemini (Google retired the dedicated "flash" mid-tier in the 3.1 series
// and `gemini-2.5-flash` is deprecated, so the registry has no real
// medium-tier flash equivalent left. `gemini-3.1-pro-preview` is priced in
// the Sonnet band — $0.002/$0.012 per 1k in/out under 200k context, ~2/3
// the cost of Sonnet 4.6 — so it serves as the "main agent work" pick for
// every medium-tier surface (morning_routine, message.dm, activity_scan,
// evening / weekly / monthly review). High tier collapses onto the same
// model via `SEED_HIGH_TIER_OVERRIDE` below: there's no Opus-priced Google
// flagship worth defaulting to, and operators who genuinely want
// `gemini-2.5-pro` can pin it per-row from /settings/models. Lite stays
// pinned to flash-lite for delegated proxy + fetch_window/triage surfaces.
export const DEFAULT_GEMINI_LITE_MODEL = "gemini-3.1-flash-lite-preview";
export const DEFAULT_GEMINI_MEDIUM_MODEL = "gemini-3.1-pro-preview";
export const DEFAULT_GEMINI_HIGH_MODEL = "gemini-3.1-pro-preview";

// OpenCode static fallback defaults use provider/model composite IDs. The
// live OpenCode server may report different providers; runtime probing lands
// in a later phase, so Phase 1 seeds Anthropic-compatible safe defaults.
export const DEFAULT_OPENCODE_LITE_MODEL = "anthropic/claude-haiku-4-5";
export const DEFAULT_OPENCODE_MEDIUM_MODEL = "anthropic/claude-sonnet-4-6";
export const DEFAULT_OPENCODE_HIGH_MODEL = "anthropic/claude-opus-4-8";

const MODEL_REGISTRY: ReadonlyArray<BackendModel> = [
  {
    backendId: "claude",
    modelId: "claude-sonnet-4-6",
    label: "Claude Sonnet 4.6",
    displayName: "Claude Sonnet 4.6",
    tier: "medium",
    available: true,
    supportsToolUse: true,
    supportsStreaming: true,
    supportsPromptCaching: true,
    usdPer1kIn: 0.003,
    usdPer1kOut: 0.015,
    usdPer1kCacheRead: 0.0003,
    usdPer1kCacheCreate: 0.00375,
    maxInputTokens: 1_000_000,
    maxOutputTokens: 64_000,
  },
  {
    backendId: "claude",
    modelId: "claude-opus-4-8",
    label: "Claude Opus 4.8",
    displayName: "Claude Opus 4.8",
    tier: "high",
    available: true,
    supportsToolUse: true,
    supportsStreaming: true,
    supportsPromptCaching: true,
    // Anthropic Opus 4 tier: $15/$75/$1.50/$18.75 per MTok in/out/cache-read/cache-create
    // — same band as 4.7. The SDK's `total_cost_usd` is the trusted source; pin
    // `pricingTrusted` so the community price-fetcher can't clobber it with the
    // stale 4.6-tier rate LiteLLM lists for the newest Opus generation.
    usdPer1kIn: 0.015,
    usdPer1kOut: 0.075,
    usdPer1kCacheRead: 0.0015,
    usdPer1kCacheCreate: 0.01875,
    pricingTrusted: true,
    maxInputTokens: 1_000_000,
    maxOutputTokens: 128_000,
  },
  {
    backendId: "claude",
    modelId: "claude-opus-4-7",
    label: "Claude Opus 4.7 (legacy)",
    displayName: "Claude Opus 4.7 (legacy)",
    tier: "high",
    available: true,
    deprecated: true,
    supportsToolUse: true,
    supportsStreaming: true,
    supportsPromptCaching: true,
    // Anthropic Opus 4 tier: $15/$75/$1.50/$18.75 per MTok in/out/cache-read/cache-create.
    // Demoted to legacy when 4.8 shipped; kept available so existing pins keep
    // resolving with correct pricing. SDK's `total_cost_usd` confirms 4-7 is
    // billed at the full Opus 4 rate.
    usdPer1kIn: 0.015,
    usdPer1kOut: 0.075,
    usdPer1kCacheRead: 0.0015,
    usdPer1kCacheCreate: 0.01875,
    pricingTrusted: true,
    maxInputTokens: 1_000_000,
    maxOutputTokens: 128_000,
  },
  {
    backendId: "claude",
    modelId: "claude-opus-4-6",
    label: "Claude Opus 4.6 (legacy)",
    displayName: "Claude Opus 4.6 (legacy)",
    tier: "high",
    available: true,
    deprecated: true,
    supportsToolUse: true,
    supportsStreaming: true,
    supportsPromptCaching: true,
    usdPer1kIn: 0.005,
    usdPer1kOut: 0.025,
    usdPer1kCacheRead: 0.0005,
    usdPer1kCacheCreate: 0.00625,
    maxInputTokens: 1_000_000,
    maxOutputTokens: 128_000,
  },
  {
    backendId: "claude",
    modelId: "claude-haiku-4-5-20251001",
    label: "Claude Haiku 4.5",
    displayName: "Claude Haiku 4.5",
    tier: "lite",
    available: true,
    supportsToolUse: true,
    supportsStreaming: true,
    supportsPromptCaching: true,
    usdPer1kIn: 0.001,
    usdPer1kOut: 0.005,
    usdPer1kCacheRead: 0.0001,
    usdPer1kCacheCreate: 0.00125,
    maxInputTokens: 200_000,
    maxOutputTokens: 64_000,
  },
  {
    backendId: "opencode",
    modelId: "anthropic/claude-haiku-4-5",
    label: "OpenCode Claude Haiku 4.5",
    displayName: "Claude Haiku 4.5",
    tier: "lite",
    available: true,
    supportsToolUse: true,
    supportsStreaming: true,
    supportsPromptCaching: true,
    usdPer1kIn: 0.001,
    usdPer1kOut: 0.005,
    usdPer1kCacheRead: 0.0001,
    usdPer1kCacheCreate: 0.00125,
    maxInputTokens: 200_000,
    maxOutputTokens: 64_000,
  },
  {
    backendId: "opencode",
    modelId: "anthropic/claude-sonnet-4-6",
    label: "OpenCode Claude Sonnet 4.6",
    displayName: "Claude Sonnet 4.6",
    tier: "medium",
    available: true,
    supportsToolUse: true,
    supportsStreaming: true,
    supportsPromptCaching: true,
    usdPer1kIn: 0.003,
    usdPer1kOut: 0.015,
    usdPer1kCacheRead: 0.0003,
    usdPer1kCacheCreate: 0.00375,
    maxInputTokens: 1_000_000,
    maxOutputTokens: 64_000,
  },
  {
    backendId: "opencode",
    modelId: "anthropic/claude-opus-4-8",
    label: "OpenCode Claude Opus 4.8",
    displayName: "Claude Opus 4.8",
    tier: "high",
    available: true,
    supportsToolUse: true,
    supportsStreaming: true,
    supportsPromptCaching: true,
    usdPer1kIn: 0.015,
    usdPer1kOut: 0.075,
    usdPer1kCacheRead: 0.0015,
    usdPer1kCacheCreate: 0.01875,
    pricingTrusted: true,
    maxInputTokens: 1_000_000,
    maxOutputTokens: 128_000,
  },
  {
    backendId: "opencode",
    modelId: "anthropic/claude-opus-4-7",
    label: "OpenCode Claude Opus 4.7 (legacy)",
    displayName: "Claude Opus 4.7 (legacy)",
    tier: "high",
    available: true,
    deprecated: true,
    supportsToolUse: true,
    supportsStreaming: true,
    supportsPromptCaching: true,
    usdPer1kIn: 0.015,
    usdPer1kOut: 0.075,
    usdPer1kCacheRead: 0.0015,
    usdPer1kCacheCreate: 0.01875,
    pricingTrusted: true,
    maxInputTokens: 1_000_000,
    maxOutputTokens: 128_000,
  },
  {
    backendId: "codex",
    modelId: "gpt-5.5",
    label: "GPT-5.5",
    displayName: "GPT-5.5",
    tier: "high",
    available: true,
    supportsToolUse: true,
    supportsStreaming: true,
    supportsPromptCaching: true,
    usdPer1kIn: 0.005,
    usdPer1kOut: 0.03,
    usdPer1kCacheRead: 0.0005,
    inputCostThresholdTokens: 272_000,
    pricingThresholdMode: "context",
    usdPer1kInAboveThreshold: 0.01,
    usdPer1kOutAboveThreshold: 0.045,
    usdPer1kCacheReadAboveThreshold: 0.001,
    maxInputTokens: 1_050_000,
    maxOutputTokens: 128_000,
  },
  {
    backendId: "codex",
    modelId: "gpt-5.5-chat-latest",
    label: "GPT-5.5 Instant",
    displayName: "GPT-5.5 Instant",
    // Non-thinking sibling of gpt-5.5 — ChatGPT's default. Same model
    // family / pricing as thinking gpt-5.5 but with no reasoning step,
    // so it returns a token immediately. Registered under `high` to keep the
    // canonical pricing tier honest (latestHighFor still resolves to
    // thinking gpt-5.5 because that entry comes first in this array);
    // operators can pin it from /settings/models when low latency is
    // preferred over deeper reasoning.
    tier: "high",
    available: true,
    supportsToolUse: true,
    supportsStreaming: true,
    supportsPromptCaching: true,
    usdPer1kIn: 0.005,
    usdPer1kOut: 0.03,
    usdPer1kCacheRead: 0.0005,
    inputCostThresholdTokens: 272_000,
    pricingThresholdMode: "context",
    usdPer1kInAboveThreshold: 0.01,
    usdPer1kOutAboveThreshold: 0.045,
    usdPer1kCacheReadAboveThreshold: 0.001,
    maxInputTokens: 1_050_000,
    maxOutputTokens: 128_000,
  },
  {
    backendId: "codex",
    modelId: "gpt-5.4",
    label: "GPT-5.4",
    displayName: "GPT-5.4",
    // Promoted from `high` to `medium` after gpt-5.5 shipped: gpt-5.4 is
    // priced ~half of gpt-5.5 for the same context shapes, and the
    // medium-tier routines (morning_routine / activity_scan /
    // evening_review / message.dm) do not benefit from gpt-5.5's
    // deeper reasoning enough to justify the cost. gpt-5.4 is ALSO the
    // seeded default for codex's high tier via `SEED_HIGH_TIER_OVERRIDE`
    // — gpt-5.5 stays registered as a high-tier opt-in for surfaces that
    // pin it explicitly from /settings/models, but is not the silent
    // fall-through (Opus-class pricing makes that the wrong default).
    tier: "medium",
    available: true,
    supportsToolUse: true,
    supportsStreaming: true,
    supportsPromptCaching: true,
    usdPer1kIn: 0.0025,
    usdPer1kOut: 0.015,
    usdPer1kCacheRead: 0.00025,
    inputCostThresholdTokens: 272_000,
    pricingThresholdMode: "context",
    usdPer1kInAboveThreshold: 0.005,
    usdPer1kOutAboveThreshold: 0.0225,
    usdPer1kCacheReadAboveThreshold: 0.0005,
    maxInputTokens: 1_050_000,
    maxOutputTokens: 128_000,
  },
  {
    backendId: "codex",
    modelId: "gpt-5.4-mini",
    label: "GPT-5.4 Mini",
    displayName: "GPT-5.4 Mini",
    // OpenAI's smallest GPT-5-class chat model. Canonical Codex lite-tier
    // pick — delegated proxy calls and observer-fired surfaces route
    // here. Medium-tier surfaces now resolve to `gpt-5.4` directly via
    // `latestMediumFor("codex")` instead of falling through to mini.
    tier: "lite",
    available: true,
    supportsToolUse: true,
    supportsStreaming: true,
    supportsPromptCaching: true,
    usdPer1kIn: 0.00075,
    usdPer1kOut: 0.0045,
    usdPer1kCacheRead: 0.000075,
    maxInputTokens: 1_050_000,
    maxOutputTokens: 128_000,
  },
  {
    backendId: "codex",
    modelId: "gpt-5.3-codex",
    label: "GPT-5.3 Codex",
    displayName: "GPT-5.3 Codex",
    tier: "high",
    available: true,
    supportsToolUse: true,
    supportsStreaming: true,
    supportsPromptCaching: true,
    usdPer1kIn: 0.003,
    usdPer1kOut: 0.015,
    maxInputTokens: 1_050_000,
    maxOutputTokens: 128_000,
  },
  {
    backendId: "codex",
    modelId: "gpt-5.2-codex",
    label: "GPT-5.2 Codex",
    displayName: "GPT-5.2 Codex",
    tier: "high",
    available: true,
    supportsToolUse: true,
    supportsStreaming: true,
    supportsPromptCaching: true,
    usdPer1kIn: 0.00175,
    usdPer1kOut: 0.014,
    usdPer1kCacheRead: 0.000175,
    maxInputTokens: 1_050_000,
    maxOutputTokens: 128_000,
  },
  {
    backendId: "gemini",
    modelId: "gemini-3.1-flash-lite-preview",
    label: "Gemini 3.1 Flash Lite (preview)",
    displayName: "Gemini 3.1 Flash Lite (preview)",
    tier: "lite",
    // Official Gemini API pricing: https://ai.google.dev/pricing
    available: true,
    supportsToolUse: true,
    supportsStreaming: true,
    supportsPromptCaching: true,
    usdPer1kIn: 0.0001,
    usdPer1kOut: 0.0004,
    usdPer1kCacheRead: 0.00001,
    maxInputTokens: 1_048_576,
    maxOutputTokens: 65_536,
  },
  {
    backendId: "gemini",
    modelId: "gemini-3.1-pro-preview",
    label: "Gemini 3.1 Pro (preview)",
    displayName: "Gemini 3.1 Pro (preview)",
    // Classified as `medium` so `latestMediumFor("gemini")` resolves here
    // instead of returning null (the deprecated `gemini-2.5-flash` is the
    // only other medium candidate and is excluded by `!deprecated`). This
    // is the "main agent work" pick on Gemini — pricing ~$0.002 / $0.012
    // per 1k in/out is in the Sonnet band, and the latest-gen 3.1 Pro
    // model reliably follows multi-step task flows that flash-lite
    // (lite tier) silently skips. High tier collapses onto this same
    // model via `SEED_HIGH_TIER_OVERRIDE.gemini` below; operators who
    // want `gemini-2.5-pro` for high-tier surfaces pin it explicitly.
    tier: "medium",
    // Official Gemini API pricing: https://ai.google.dev/pricing
    available: true,
    supportsToolUse: true,
    supportsStreaming: true,
    supportsPromptCaching: true,
    usdPer1kIn: 0.002,
    usdPer1kOut: 0.012,
    usdPer1kCacheRead: 0.0002,
    inputCostThresholdTokens: 200_000,
    pricingThresholdMode: "context",
    usdPer1kInAboveThreshold: 0.004,
    usdPer1kOutAboveThreshold: 0.018,
    usdPer1kCacheReadAboveThreshold: 0.0004,
    maxInputTokens: 1_048_576,
    maxOutputTokens: 65_536,
  },
  {
    backendId: "gemini",
    modelId: "gemini-3-pro-preview",
    label: "Gemini 3 Pro (preview, legacy)",
    displayName: "Gemini 3 Pro (preview, legacy)",
    tier: "high",
    // Official Gemini API pricing: https://ai.google.dev/pricing
    available: true,
    deprecated: true,
    supportsToolUse: true,
    supportsStreaming: true,
    supportsPromptCaching: true,
    usdPer1kIn: 0.002,
    usdPer1kOut: 0.012,
    usdPer1kCacheRead: 0.0002,
    inputCostThresholdTokens: 200_000,
    pricingThresholdMode: "context",
    usdPer1kInAboveThreshold: 0.004,
    usdPer1kOutAboveThreshold: 0.018,
    usdPer1kCacheReadAboveThreshold: 0.0004,
    maxInputTokens: 1_048_576,
    maxOutputTokens: 65_536,
  },
  {
    backendId: "gemini",
    modelId: "gemini-3-flash-preview",
    label: "Gemini 3 Flash (preview, legacy)",
    displayName: "Gemini 3 Flash (preview, legacy)",
    tier: "lite",
    // Official Gemini API pricing: https://ai.google.dev/pricing
    available: true,
    deprecated: true,
    supportsToolUse: true,
    supportsStreaming: true,
    supportsPromptCaching: true,
    usdPer1kIn: 0.0005,
    usdPer1kOut: 0.003,
    usdPer1kCacheRead: 0.00005,
    maxInputTokens: 1_048_576,
    maxOutputTokens: 65_536,
  },
  {
    backendId: "gemini",
    modelId: "gemini-2.5-pro",
    label: "Gemini 2.5 Pro",
    displayName: "Gemini 2.5 Pro",
    tier: "high",
    available: true,
    supportsToolUse: true,
    supportsStreaming: true,
    supportsPromptCaching: true,
    usdPer1kIn: 0.00125,
    usdPer1kOut: 0.01,
    usdPer1kCacheRead: 0.000125,
    inputCostThresholdTokens: 200_000,
    pricingThresholdMode: "context",
    usdPer1kInAboveThreshold: 0.0025,
    usdPer1kOutAboveThreshold: 0.015,
    usdPer1kCacheReadAboveThreshold: 0.00025,
    maxInputTokens: 1_000_000,
    maxOutputTokens: 32_000,
  },
  {
    backendId: "gemini",
    modelId: "gemini-2.5-flash",
    label: "Gemini 2.5 Flash (legacy)",
    displayName: "Gemini 2.5 Flash (legacy)",
    tier: "medium",
    available: true,
    deprecated: true,
    supportsToolUse: true,
    supportsStreaming: true,
    supportsPromptCaching: true,
    usdPer1kIn: 0.0003,
    usdPer1kOut: 0.0025,
    usdPer1kCacheRead: 0.00003,
    maxInputTokens: 1_000_000,
    maxOutputTokens: 32_000,
  },
  {
    backendId: "gemini",
    modelId: "gemini-2.5-flash-lite",
    label: "Gemini 2.5 Flash Lite",
    displayName: "Gemini 2.5 Flash Lite",
    tier: "lite",
    available: true,
    supportsToolUse: true,
    supportsStreaming: true,
    supportsPromptCaching: true,
    usdPer1kIn: 0.0001,
    usdPer1kOut: 0.0004,
    usdPer1kCacheRead: 0.00001,
    maxInputTokens: 1_000_000,
    maxOutputTokens: 32_000,
  },
] as const;

export function getModelsForBackend(backendId: BackendId): ReadonlyArray<BackendModel> {
  return MODEL_REGISTRY.filter((model) => model.backendId === backendId);
}

export function findRegisteredModel(
  backendId: BackendId,
  modelId: string,
): BackendModel | undefined {
  return MODEL_REGISTRY.find(
    (model) => model.backendId === backendId && model.modelId === modelId,
  );
}

/**
 * Return the first available high-tier model for `backendId`, or `null` if
 * the backend has no high-tier models registered. Preset builders use this
 * so a model/pricing change is a one-line edit inside this registry instead
 * of a cascade through every preset + test. See `plan-presets.ts` and
 * `docs/design/09-safety-cost.md` §9.4.6.
 */
export function latestHighFor(backendId: BackendId): string | null {
  const match = MODEL_REGISTRY.find(
    (model) =>
      model.backendId === backendId
      && model.tier === "high"
      && model.available
      && !model.deprecated,
  );
  // Every backend has a high model today; the null branch is forward-defensive.
  /* c8 ignore next */
  return match?.modelId ?? null;
}

/* c8 ignore start — registry has no `available:false` or deprecated medium
   model today; the predicates and `?? null` fallback exist so the lookup
   degrades cleanly when one is added (e.g. retired Sonnet generation). */
/** Mirror of `latestHighFor` for the medium tier (main agent surfaces). */
export function latestMediumFor(backendId: BackendId): string | null {
  const match = MODEL_REGISTRY.find(
    (model) =>
      model.backendId === backendId
      && model.tier === "medium"
      && model.available
      && !model.deprecated,
  );
  return match?.modelId ?? null;
}
/* c8 ignore stop */

/* c8 ignore start — every backend has a non-deprecated lite model with
   `available: true`; the `available:false` predicate and `?? null`
   fallback are forward-defensive only. */
/** Mirror of `latestHighFor` for the lite tier (delegated / observer-fired). */
export function latestLiteFor(backendId: BackendId): string | null {
  const match = MODEL_REGISTRY.find(
    (model) =>
      model.backendId === backendId
      && model.tier === "lite"
      && model.available
      && !model.deprecated,
  );
  return match?.modelId ?? null;
}
/* c8 ignore stop */

/**
 * Cheapest available lite-tier model for `backendId` by `usdPer1kIn`.
 * Used by surfaces that want "the budget pick" rather than the canonical
 * latest lite model — e.g. the docs Q&A picker. Falls back to
 * `latestLiteFor` when no lite model has pricing data.
 */
export function cheapestLiteFor(backendId: BackendId): string | null {
  const candidates = MODEL_REGISTRY.filter(
    (model) =>
      model.backendId === backendId
      && model.tier === "lite"
      && model.available
      && !model.deprecated
      && typeof model.usdPer1kIn === "number",
  );
  // Every backend has at least one lite model with priced input today;
  // the `latestLiteFor` fallback is defensive against a future registry
  // where every lite model is unpriced.
  /* c8 ignore next */
  if (candidates.length === 0) return latestLiteFor(backendId);
  /* c8 ignore start — every gemini-lite entry has the same `usdPer1kIn`
     today (no strict-less wins), so the `? model` branch and the
     `?? Infinity` defensive legs are unreachable from current data. */
  return candidates.reduce((cheapest, model) =>
    (model.usdPer1kIn ?? Infinity) < (cheapest.usdPer1kIn ?? Infinity)
      ? model
      : cheapest,
  ).modelId;
  /* c8 ignore stop */
}

/**
 * Per-backend override for the high-tier *seeded default*. Keeps the
 * "what high-tier models exist on this backend" question (answered by
 * `latestHighFor`) separate from the "what model do we seed when a
 * process key's default tier resolves to high" question (answered by
 * `defaultModelForTier`).
 *
 * Codex's flagship reasoning model (gpt-5.5) is priced in the same band
 * as Anthropic Opus — too expensive to be the silent fall-through for
 * process keys that *happen* to be tagged high tier (delegated_task_heavy,
 * advisor — note `morning_routine_initial` was retired by
 * morning-routine-optimization.md Phase 7 in 2026-05-16, and both
 * `setup` and `knowledge.import` were demoted to medium tier on
 * 2026-05-16 as part of the "no Opus by default" pass). Operators
 * who explicitly want gpt-5.5 pin it per row from
 * /settings/models; the medium-tier model is the safe default. The
 * referenced model must be present + non-deprecated in `MODEL_REGISTRY`
 * — the lookup `findRegisteredModel` confirms before honoring the
 * override; otherwise we fall through to the normal `latestHighFor`
 * resolution.
 */
const SEED_HIGH_TIER_OVERRIDE: Partial<Record<BackendId, string>> = {
  codex: "gpt-5.4",
  // `latestHighFor("gemini")` legitimately resolves to `gemini-2.5-pro`
  // (the only non-deprecated registry entry tagged `tier: "high"` now that
  // `gemini-3.1-pro-preview` carries `tier: "medium"`). 2.5-pro is fine for
  // explicit opt-in, but for the silent fall-through on Aitne's seeded
  // high-tier surfaces we want continuity with the medium tier — same
  // 3.1-preview generation, no surprise version swap between
  // `routine.morning_routine` and `knowledge.import`. The override flips
  // the seed to 3.1-pro; `findRegisteredModel` confirms it's present and
  // non-deprecated before honoring (same guard the Codex override uses).
  gemini: "gemini-3.1-pro-preview",
};

/**
 * Resolve the canonical default model id for a `(backendId, tier)` pair.
 * Falls back across tiers if the registry has no match (e.g. Codex has no
 * distinct medium model — `latestMediumFor("codex")` returns null and we
 * fall through to lite). For the `high` tier, `SEED_HIGH_TIER_OVERRIDE`
 * takes precedence — used to keep Codex's Opus-priced gpt-5.5 from
 * silently becoming the default on every high-tier process key.
 */
export function defaultModelForTier(
  backendId: BackendId,
  tier: BackendModelTier,
): string {
  if (tier === "lite") {
    /* c8 ignore start — every backend in the registry has a lite model,
       so the medium/high/default fallbacks below are forward-defensive only. */
    return latestLiteFor(backendId)
      ?? latestMediumFor(backendId)
      ?? latestHighFor(backendId)
      ?? DEFAULT_CLAUDE_LITE_MODEL;
    /* c8 ignore stop */
  }
  if (tier === "medium") {
    /* c8 ignore start — codex/gemini exercise the lite-fallback; claude
       has medium directly. The high+default fallthroughs only fire if
       both medium AND lite tiers are removed from a backend, which is
       currently impossible. */
    return latestMediumFor(backendId)
      ?? latestLiteFor(backendId)
      ?? latestHighFor(backendId)
      ?? DEFAULT_CLAUDE_MEDIUM_MODEL;
    /* c8 ignore stop */
  }
  const override = SEED_HIGH_TIER_OVERRIDE[backendId];
  if (override) {
    const found = MODEL_REGISTRY.find(
      (model) =>
        model.backendId === backendId
        && model.modelId === override
        && model.available
        && !model.deprecated,
    );
    if (found) return found.modelId;
  }
  /* c8 ignore start — every backend has a high model; the fallbacks
     here only fire if a high tier is removed entirely. */
  return latestHighFor(backendId)
    ?? latestMediumFor(backendId)
    ?? latestLiteFor(backendId)
    ?? DEFAULT_CLAUDE_HIGH_MODEL;
  /* c8 ignore stop */
}

export function estimateCostForUsage(
  model: BackendModel | undefined,
  usage: BackendUsage,
): number {
  if (!model) {
    return 0;
  }

  const threshold = model.inputCostThresholdTokens ?? Number.POSITIVE_INFINITY;
  // BackendUsage.inputTokens is the non-cached input bucket. Cache read/write
  // tokens are separate billable prompt tokens, so context-tier pricing should
  // look at the full prompt token count reconstructed from all input buckets.
  const thresholdInputTokens =
    usage.inputTokens
    + usage.cacheReadInputTokens
    + usage.cacheCreationInputTokens;
  const contextThresholdApplies =
    model.pricingThresholdMode === "context"
    && thresholdInputTokens > threshold;

  // Every context-threshold model registered today carries all four
  // above-threshold rates AND their base counterparts; the `?? base ?? 0`
  // legs below are forward-defensive against partial pricing data, so the
  // whole context-threshold cost block is wrapped in a single ignore band.
  /* c8 ignore start */
  if (contextThresholdApplies) {
    const inputCost =
      (usage.inputTokens / 1000)
      * (model.usdPer1kInAboveThreshold ?? model.usdPer1kIn ?? 0);
    const outputCost =
      (usage.outputTokens / 1000)
      * (model.usdPer1kOutAboveThreshold ?? model.usdPer1kOut ?? 0);
    const cacheReadCost =
      (usage.cacheReadInputTokens / 1000)
      * (model.usdPer1kCacheReadAboveThreshold ?? model.usdPer1kCacheRead ?? 0);
    const cacheCreateCost =
      (usage.cacheCreationInputTokens / 1000)
      * (model.usdPer1kCacheCreateAboveThreshold ?? model.usdPer1kCacheCreate ?? 0);

    return roundUsd(inputCost + outputCost + cacheReadCost + cacheCreateCost);
  }
  /* c8 ignore stop — context-threshold cases are tested separately; this
     block remains for the gemini long-context path which DOES exercise
     real callers but spans branches v8 cannot map cleanly. */

  const regularInputTokens = Math.min(usage.inputTokens, threshold);
  const aboveThresholdTokens = Math.max(usage.inputTokens - threshold, 0);

  const inputCost =
    // Every registered model has `usdPer1kIn`; the `?? 0` is defensive only.
    /* c8 ignore next */
    (regularInputTokens / 1000) * (model.usdPer1kIn ?? 0) +
    // Above-threshold non-context path: only codex `gpt-5.4` tests reach
    // here today, and it ships `usdPer1kInAboveThreshold`, so the `?? base`
    // and `?? 0` legs are unreachable until a partial-pricing model ships.
    /* c8 ignore next */
    (aboveThresholdTokens / 1000) * (model.usdPer1kInAboveThreshold ?? model.usdPer1kIn ?? 0);
  // Every registered model has `usdPer1kOut`; the `?? 0` is defensive.
  /* c8 ignore next */
  const outputCost = (usage.outputTokens / 1000) * (model.usdPer1kOut ?? 0);
  // Every registered model with cache pricing has `usdPer1kCacheRead`; the
  // `?? 0` fallback covers models that omit it (currently none).
  /* c8 ignore next */
  const cacheReadCost = (usage.cacheReadInputTokens / 1000) * (model.usdPer1kCacheRead ?? 0);
  const cacheCreateCost =
    (usage.cacheCreationInputTokens / 1000) * (model.usdPer1kCacheCreate ?? 0);

  return roundUsd(inputCost + outputCost + cacheReadCost + cacheCreateCost);
}

export function estimateTextInputTokens(text: string): number {
  return Math.max(1, Math.ceil(Buffer.byteLength(text, "utf8") / 4));
}

/** Get the human-readable label for a model, falling back to the raw modelId. */
export function getModelLabel(backendId: BackendId, modelId: string): string {
  return findRegisteredModel(backendId, modelId)?.label ?? modelId;
}

function roundUsd(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
