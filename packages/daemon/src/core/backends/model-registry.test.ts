import { describe, expect, it } from "vitest";
import {
  cheapestLiteFor,
  defaultModelForTier,
  estimateCostForUsage,
  estimateTextInputTokens,
  findRegisteredModel,
  getModelLabel,
  getModelsForBackend,
  latestHighFor,
  latestLiteFor,
  latestMediumFor,
} from "./model-registry.js";

describe("model-registry", () => {
  it("returns backend-specific models", () => {
    const models = getModelsForBackend("codex");

    expect(models.length).toBeGreaterThan(0);
    expect(models.every((model) => model.backendId === "codex")).toBe(true);
  });

  it("estimates gemini threshold pricing correctly", () => {
    const model = findRegisteredModel("gemini", "gemini-3-pro-preview");

    const cost = estimateCostForUsage(model, {
      inputTokens: 250_000,
      outputTokens: 1_000,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    });

    expect(cost).toBe(1.018);
  });

  it("returns 0 cost when model is undefined", () => {
    const cost = estimateCostForUsage(undefined, {
      inputTokens: 1000,
      outputTokens: 500,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    });

    expect(cost).toBe(0);
  });

  it("estimates gpt-5.4-mini standard pricing correctly", () => {
    const model = findRegisteredModel("codex", "gpt-5.4-mini");

    const cost = estimateCostForUsage(model, {
      inputTokens: 1_000,
      outputTokens: 1_000,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 1_000,
    });

    expect(cost).toBeCloseTo(0.005325, 6);
  });

  it("applies gpt-5.4 long-context rates to the full session", () => {
    const model = findRegisteredModel("codex", "gpt-5.4");

    const cost = estimateCostForUsage(model, {
      inputTokens: 300_000,
      outputTokens: 1_000,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    });

    expect(cost).toBeCloseTo(1.5225, 6);
  });

  it("returns undefined for a nonexistent model", () => {
    const model = findRegisteredModel("claude", "nonexistent-model");
    expect(model).toBeUndefined();
  });

  it("estimates gpt-5.5-chat-latest (Instant) standard pricing correctly", () => {
    const model = findRegisteredModel("codex", "gpt-5.5-chat-latest");

    const cost = estimateCostForUsage(model, {
      inputTokens: 1_000,
      outputTokens: 1_000,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 1_000,
    });

    // input: 1 * 0.005   = 0.005
    // output: 1 * 0.03   = 0.03
    // cacheRead: 1 * 0.0005 = 0.0005
    expect(cost).toBeCloseTo(0.0355, 6);
  });

  it("applies gpt-5.5-chat-latest >272K context-tier rates to the full session", () => {
    const model = findRegisteredModel("codex", "gpt-5.5-chat-latest");

    const cost = estimateCostForUsage(model, {
      inputTokens: 300_000,
      outputTokens: 1_000,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    });

    // 300K input > 272K threshold → use 2x input ($10/1M) and 1.5x output ($45/1M)
    // input:  300 * 0.01    = 3.0
    // output:   1 * 0.045   = 0.045
    expect(cost).toBeCloseTo(3.045, 6);
  });

  it("registering gpt-5.5-chat-latest does not shift codex tier defaults", () => {
    // The Instant variant is registered as a selectable high-tier alternative
    // but must NOT become the canonical lite/medium/high default. lite/medium
    // stay pinned to gpt-5.4-mini and gpt-5.4. `latestHighFor` still answers
    // "what's the latest registered high-tier model" honestly (gpt-5.5), but
    // `defaultModelForTier(codex, "high")` is steered to gpt-5.4 via
    // `SEED_HIGH_TIER_OVERRIDE` — gpt-5.5 is Opus-priced and we don't want it
    // as the silent fall-through for high-tier process keys.
    expect(latestLiteFor("codex")).toBe("gpt-5.4-mini");
    expect(latestMediumFor("codex")).toBe("gpt-5.4");
    expect(latestHighFor("codex")).toBe("gpt-5.5");
    expect(cheapestLiteFor("codex")).toBe("gpt-5.4-mini");
    expect(defaultModelForTier("codex", "lite")).toBe("gpt-5.4-mini");
    expect(defaultModelForTier("codex", "medium")).toBe("gpt-5.4");
    expect(defaultModelForTier("codex", "high")).toBe("gpt-5.4");
  });

  it("classifies gemini-3.1-pro-preview as the medium-tier default and the seeded high-tier pick", () => {
    // Google retired the dedicated "flash" mid-tier in 3.1, and the
    // deprecated `gemini-2.5-flash` is excluded by `!deprecated` in
    // `latestMediumFor`. Pinning `gemini-3.1-pro-preview` at `tier: "medium"`
    // gives every main-agent surface (morning_routine, message.dm,
    // activity_scan, evening / weekly / monthly review) a real medium-tier
    // default instead of silently degrading to lite. `latestHighFor` still
    // reports `gemini-2.5-pro` honestly (it's the only remaining `high`
    // entry), but `defaultModelForTier(gemini, "high")` is steered to the
    // same 3.1-pro via `SEED_HIGH_TIER_OVERRIDE` for continuity across
    // medium and high seeds — operators who genuinely want 2.5-pro pin it
    // per-row from /settings/models.
    expect(latestLiteFor("gemini")).toBe("gemini-3.1-flash-lite-preview");
    expect(latestMediumFor("gemini")).toBe("gemini-3.1-pro-preview");
    expect(latestHighFor("gemini")).toBe("gemini-2.5-pro");
    expect(defaultModelForTier("gemini", "lite")).toBe(
      "gemini-3.1-flash-lite-preview",
    );
    expect(defaultModelForTier("gemini", "medium")).toBe(
      "gemini-3.1-pro-preview",
    );
    expect(defaultModelForTier("gemini", "high")).toBe(
      "gemini-3.1-pro-preview",
    );
  });

  it("registers OpenCode provider/model composite defaults", () => {
    expect(latestLiteFor("opencode")).toBe("anthropic/claude-haiku-4-5");
    expect(latestMediumFor("opencode")).toBe("anthropic/claude-sonnet-4-6");
    expect(latestHighFor("opencode")).toBe("anthropic/claude-opus-4-8");
    expect(cheapestLiteFor("opencode")).toBe("anthropic/claude-haiku-4-5");
    expect(defaultModelForTier("opencode", "lite")).toBe(
      "anthropic/claude-haiku-4-5",
    );
    expect(defaultModelForTier("opencode", "medium")).toBe(
      "anthropic/claude-sonnet-4-6",
    );
    expect(defaultModelForTier("opencode", "high")).toBe(
      "anthropic/claude-opus-4-8",
    );

    const model = findRegisteredModel("opencode", "anthropic/claude-sonnet-4-6");
    expect(model?.backendId).toBe("opencode");
    expect(model?.usdPer1kIn).toBe(0.003);
    expect(model?.usdPer1kOut).toBe(0.015);
  });

  it("registers claude-opus-4-8 as the canonical high-tier model with Opus-4 pricing", () => {
    // Opus 4.8 is the current Claude high-tier default. 4.7 and 4.6 stay
    // registered but flagged deprecated so existing pins keep resolving with
    // correct pricing while `latestHighFor` skips them.
    expect(latestHighFor("claude")).toBe("claude-opus-4-8");
    expect(defaultModelForTier("claude", "high")).toBe("claude-opus-4-8");

    const model = findRegisteredModel("claude", "claude-opus-4-8");
    expect(model?.tier).toBe("high");
    expect(model?.deprecated).toBeUndefined();
    expect(model?.usdPer1kIn).toBe(0.015);
    expect(model?.usdPer1kOut).toBe(0.075);
    expect(model?.usdPer1kCacheRead).toBe(0.0015);
    expect(model?.usdPer1kCacheCreate).toBe(0.01875);

    // Superseded Opus generations remain available but flagged legacy.
    expect(findRegisteredModel("claude", "claude-opus-4-7")?.deprecated).toBe(true);
    expect(findRegisteredModel("claude", "claude-opus-4-6")?.deprecated).toBe(true);
  });

  it("collapses cache-create cost to 0 when the model lacks usdPer1kCacheCreate", () => {
    // gpt-5.4-mini ships usdPer1kCacheRead but no usdPer1kCacheCreate — the
    // last `?? 0` fallback in the non-context branch must be exercised so a
    // missing cache-create rate does not blow up cost estimation.
    const model = findRegisteredModel("codex", "gpt-5.4-mini");
    const cost = estimateCostForUsage(model, {
      inputTokens: 1_000,
      outputTokens: 1_000,
      cacheCreationInputTokens: 5_000,
      cacheReadInputTokens: 0,
    });
    // input: 1 * 0.00075 = 0.00075
    // output: 1 * 0.0045 = 0.0045
    // cacheCreate: 5 * 0 = 0
    expect(cost).toBeCloseTo(0.00525, 6);
  });

  it("estimates cost with cache creation tokens", () => {
    const model = findRegisteredModel("claude", "claude-sonnet-4-6");

    const cost = estimateCostForUsage(model, {
      inputTokens: 1_000,
      outputTokens: 1_000,
      cacheCreationInputTokens: 10_000,
      cacheReadInputTokens: 5_000,
    });

    // input: 1 * 0.003 = 0.003
    // output: 1 * 0.015 = 0.015
    // cacheCreate: 10 * 0.00375 = 0.0375
    // cacheRead: 5 * 0.0003 = 0.0015
    expect(cost).toBeCloseTo(0.057, 6);
  });

  it("cheapestLiteFor reduces over multi-candidate lite tier (gemini)", () => {
    // Gemini has multiple non-deprecated lite-tier models with priced input —
    // the reducer body only runs when the candidate array has 2+ entries.
    // Both flash-lite-preview and 2.5-flash-lite tie at usdPer1kIn=0.0001;
    // the reducer keeps the first encountered on a strict-less-than tie, so
    // the canonical pick is the registry's leading entry.
    expect(cheapestLiteFor("gemini")).toBe("gemini-3.1-flash-lite-preview");
  });

  it("cheapestLiteFor falls back to latestLiteFor when no lite has pricing", () => {
    // Currently every claude-lite registry entry has usdPer1kIn, so the
    // priced reducer wins. This test pins the canonical lite pick.
    expect(cheapestLiteFor("claude")).toBe("claude-haiku-4-5-20251001");
  });

  it("estimateTextInputTokens approximates 4 bytes per token, minimum 1", () => {
    // 0-byte input → 1 (minimum guard).
    expect(estimateTextInputTokens("")).toBe(1);
    // ASCII: "abcd" = 4 bytes / 4 = 1 token.
    expect(estimateTextInputTokens("abcd")).toBe(1);
    // ASCII: "abcde" = 5 bytes / 4 → ceil = 2 tokens.
    expect(estimateTextInputTokens("abcde")).toBe(2);
    // UTF-8 multi-byte: a single ja character = 3 bytes / 4 → ceil = 1.
    expect(estimateTextInputTokens("漢")).toBe(1);
    // Long string: 100 ASCII = 25 tokens.
    expect(estimateTextInputTokens("a".repeat(100))).toBe(25);
  });

  it("getModelLabel returns the canonical label or the raw modelId fallback", () => {
    expect(getModelLabel("claude", "claude-sonnet-4-6")).toBe("Claude Sonnet 4.6");
    expect(getModelLabel("claude", "unregistered-model")).toBe("unregistered-model");
    // Cross-backend miss falls back to raw id.
    expect(getModelLabel("codex", "claude-sonnet-4-6")).toBe("claude-sonnet-4-6");
  });
});
