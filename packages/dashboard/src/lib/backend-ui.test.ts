import { describe, it, expect } from "vitest";
import {
  BACKEND_MODEL_PALETTES,
  CHART_CATEGORY_PALETTE,
  assignModelColors,
  detectBackendFromModel,
  formatShortModelName,
  getBackendDeprecation,
  modelBadgeVariant,
  parseModelUsage,
  pickDisplayModel,
} from "./backend-ui";

describe("detectBackendFromModel", () => {
  it("matches claude models by any family name", () => {
    expect(detectBackendFromModel("claude-opus-4-6")).toBe("claude");
    expect(detectBackendFromModel("claude-sonnet-4-6")).toBe("claude");
    expect(detectBackendFromModel("claude-haiku-4-5-20251001")).toBe("claude");
    expect(detectBackendFromModel("sonnet-preview")).toBe("claude");
  });

  it("matches codex models by gpt/codex/o3/o4", () => {
    expect(detectBackendFromModel("gpt-5")).toBe("codex");
    expect(detectBackendFromModel("gpt-4o")).toBe("codex");
    expect(detectBackendFromModel("codex-mini")).toBe("codex");
    expect(detectBackendFromModel("o3")).toBe("codex");
    expect(detectBackendFromModel("o4-mini")).toBe("codex");
  });

  it("matches gemini models", () => {
    expect(detectBackendFromModel("gemini-2.5-pro")).toBe("gemini");
    expect(detectBackendFromModel("gemini-flash-lite")).toBe("gemini");
  });

  it("matches OpenCode provider/model IDs before provider family names", () => {
    expect(detectBackendFromModel("anthropic/claude-sonnet-4-6")).toBe("opencode");
    expect(detectBackendFromModel("openai/gpt-5.4")).toBe("opencode");
  });

  it("returns null for unknown or empty model ids", () => {
    expect(detectBackendFromModel("")).toBeNull();
    expect(detectBackendFromModel("mystery-model")).toBeNull();
  });
});

describe("assignModelColors", () => {
  it("gives two Claude models distinct shades from the Claude palette", () => {
    const colors = assignModelColors(["claude-opus-4-6", "claude-sonnet-4-6"]);
    expect(colors["claude-opus-4-6"]).not.toBe(colors["claude-sonnet-4-6"]);
    // Both shades should be members of the Claude palette.
    expect(BACKEND_MODEL_PALETTES.claude).toContain(colors["claude-opus-4-6"]);
    expect(BACKEND_MODEL_PALETTES.claude).toContain(colors["claude-sonnet-4-6"]);
  });

  it("spreads a pair of models across the palette instead of picking adjacent slots", () => {
    // With the spread algorithm, a 2-model group lands on palette slots 1
    // and 3 (out of 5), not 0 and 1 — so the two shades are clearly distinct
    // rather than looking like two similar darks.
    const colors = assignModelColors(["claude-opus-4-6", "claude-sonnet-4-6"]);
    const palette = BACKEND_MODEL_PALETTES.claude;
    const indices = [colors["claude-opus-4-6"], colors["claude-sonnet-4-6"]]
      .map((c) => palette.indexOf(c!))
      .sort((a, b) => a - b);
    expect(indices[1]! - indices[0]!).toBeGreaterThanOrEqual(2);
  });

  it("uses the brand-color slot (palette midpoint) for a single model", () => {
    const colors = assignModelColors(["claude-opus-4-6"]);
    const palette = BACKEND_MODEL_PALETTES.claude;
    expect(colors["claude-opus-4-6"]).toBe(palette[Math.floor(palette.length / 2)]);
  });

  it("is deterministic regardless of input order", () => {
    const a = assignModelColors(["claude-opus-4-6", "claude-sonnet-4-6", "claude-haiku-4-5"]);
    const b = assignModelColors(["claude-haiku-4-5", "claude-opus-4-6", "claude-sonnet-4-6"]);
    expect(a).toEqual(b);
  });

  it("keeps colors within the correct backend family for mixed sets", () => {
    const colors = assignModelColors([
      "claude-opus-4-6",
      "gpt-5",
      "gemini-2.5-pro",
    ]);
    expect(BACKEND_MODEL_PALETTES.claude).toContain(colors["claude-opus-4-6"]);
    expect(BACKEND_MODEL_PALETTES.codex).toContain(colors["gpt-5"]);
    expect(BACKEND_MODEL_PALETTES.gemini).toContain(colors["gemini-2.5-pro"]);
  });

  it("uses the OpenCode palette for provider/model IDs", () => {
    const colors = assignModelColors(["anthropic/claude-sonnet-4-6"]);
    expect(BACKEND_MODEL_PALETTES.opencode).toContain(
      colors["anthropic/claude-sonnet-4-6"],
    );
  });

  it("gives every model its own color when the palette is not exhausted", () => {
    const models = [
      "claude-opus-4-6",
      "claude-sonnet-4-6",
      "claude-haiku-4-5",
      "claude-opus-4-5",
    ];
    const colors = assignModelColors(models);
    const unique = new Set(Object.values(colors));
    expect(unique.size).toBe(models.length);
  });

  it("falls back to a gray palette for unknown model ids", () => {
    const colors = assignModelColors(["mystery-model-1", "mystery-model-2"]);
    expect(colors["mystery-model-1"]).not.toBe(colors["mystery-model-2"]);
    expect(colors["mystery-model-1"]).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it("ignores empty strings", () => {
    const colors = assignModelColors(["", "claude-opus-4-6"]);
    expect(colors[""]).toBeUndefined();
    expect(colors["claude-opus-4-6"]).toBeDefined();
  });
});

describe("formatShortModelName", () => {
  it("handles legacy short forms", () => {
    expect(formatShortModelName("opus")).toBe("Opus");
    expect(formatShortModelName("sonnet")).toBe("Sonnet");
  });

  it("formats Claude model IDs", () => {
    expect(formatShortModelName("claude-opus-4-6")).toBe("Opus 4.6");
    expect(formatShortModelName("claude-sonnet-4-6")).toBe("Sonnet 4.6");
  });

  it("drops date suffixes", () => {
    expect(formatShortModelName("claude-haiku-4-5-20251001")).toBe("Haiku 4.5");
  });

  it("formats Codex model IDs", () => {
    expect(formatShortModelName("gpt-5.4")).toBe("GPT-5.4");
    expect(formatShortModelName("gpt-5.4-mini")).toBe("GPT-5.4 Mini");
  });

  it("formats Gemini model IDs", () => {
    expect(formatShortModelName("gemini-3-pro")).toBe("Gemini 3 Pro");
    expect(formatShortModelName("gemini-flash-lite")).toBe("Gemini Flash Lite");
  });

  it("formats OpenCode provider/model IDs without the provider prefix", () => {
    expect(formatShortModelName("anthropic/claude-sonnet-4-6")).toBe("Sonnet 4.6");
  });

  it("returns 'unknown' for null/undefined", () => {
    expect(formatShortModelName(null)).toBe("unknown");
    expect(formatShortModelName(undefined)).toBe("unknown");
  });

  it("preserves the [1m] context-window suffix on Claude models", () => {
    // The Claude SDK can return e.g. claude-opus-4-6[1m] when the 1M context
    // variant runs. The dashboard must keep the [1m] tag visible — without
    // it, two rows ("Opus 4.6" and "Opus 4.6") with very different cost
    // ratios become indistinguishable. This is the core display surface for
    // the Opus-cost-mismatch bug.
    expect(formatShortModelName("claude-opus-4-6[1m]")).toBe("Opus 4.6[1m]");
    expect(formatShortModelName("claude-sonnet-4-6[1m]")).toBe("Sonnet 4.6[1m]");
  });
});

describe("modelBadgeVariant", () => {
  it("returns backend colors", () => {
    expect(modelBadgeVariant("claude-opus-4-6")).toBe("orange");
    expect(modelBadgeVariant("gpt-5.4")).toBe("pink");
    expect(modelBadgeVariant("gemini-3-pro")).toBe("blue");
    expect(modelBadgeVariant("anthropic/claude-sonnet-4-6")).toBe("orange");
  });

  it("returns gray for unknown", () => {
    expect(modelBadgeVariant(null)).toBe("gray");
    expect(modelBadgeVariant("mystery")).toBe("gray");
  });
});

describe("parseModelUsage", () => {
  it("returns an empty array for null/empty input", () => {
    expect(parseModelUsage(null)).toEqual([]);
    expect(parseModelUsage("")).toEqual([]);
    expect(parseModelUsage(undefined)).toEqual([]);
  });

  it("returns an empty array on malformed JSON", () => {
    expect(parseModelUsage("not-json")).toEqual([]);
    expect(parseModelUsage("[1,2,3]")).toEqual([]);
  });

  it("parses a single-model usage map", () => {
    const json = JSON.stringify({
      "claude-opus-4-7": { inputTokens: 17, outputTokens: 6578, costUsd: 2.757 },
    });
    expect(parseModelUsage(json)).toEqual([
      { modelId: "claude-opus-4-7", inputTokens: 17, outputTokens: 6578, costUsd: 2.757 },
    ]);
  });

  it("sorts multi-model usage by costUsd desc so the dominant model is first", () => {
    const json = JSON.stringify({
      "claude-opus-4-6[1m]": { inputTokens: 4, outputTokens: 858, costUsd: 0.055 },
      "claude-opus-4-7": { inputTokens: 17, outputTokens: 6578, costUsd: 2.757 },
    });
    const result = parseModelUsage(json);
    expect(result.map((r) => r.modelId)).toEqual([
      "claude-opus-4-7",
      "claude-opus-4-6[1m]",
    ]);
  });
});

describe("pickDisplayModel", () => {
  it("prefers the dominant billed model from modelUsage", () => {
    // The SDK reports the actual model that ran (here, opus-4-6[1m]) even
    // when we requested opus-4-7. The dashboard must badge whichever model
    // actually ran, since that's what the per-row cost reflects.
    const json = JSON.stringify({
      "claude-opus-4-6[1m]": { inputTokens: 4, outputTokens: 858, costUsd: 0.055 },
    });
    expect(pickDisplayModel("claude-opus-4-7", json)).toBe("claude-opus-4-6[1m]");
  });

  it("falls back to model_used when modelUsage is empty or missing", () => {
    expect(pickDisplayModel("claude-opus-4-7", null)).toBe("claude-opus-4-7");
    expect(pickDisplayModel("claude-opus-4-7", "{}")).toBe("claude-opus-4-7");
    expect(pickDisplayModel("claude-opus-4-7", "garbage")).toBe("claude-opus-4-7");
  });

  it("returns null when both inputs are empty", () => {
    expect(pickDisplayModel(null, null)).toBeNull();
    expect(pickDisplayModel(undefined, undefined)).toBeNull();
  });
});

describe("getBackendDeprecation", () => {
  it("returns the upstream deprecation notice for gemini", () => {
    // Google I/O 2026: Gemini CLI free/Pro/Ultra sunset on 2026-06-18 in
    // favor of Antigravity CLI. The advisory has to be visible on every
    // surface where the operator binds new work to Gemini.
    const notice = getBackendDeprecation("gemini");
    expect(notice).not.toBeNull();
    expect(notice!.badgeLabel).toMatch(/deprecat/i);
    expect(notice!.shortSuffix).toMatch(/deprecat/i);
    expect(notice!.reason).toMatch(/2026-06-18/);
    expect(notice!.reason).toMatch(/Antigravity/);
  });

  it("returns null for backends with no upstream deprecation", () => {
    expect(getBackendDeprecation("claude")).toBeNull();
    expect(getBackendDeprecation("codex")).toBeNull();
    expect(getBackendDeprecation("opencode")).toBeNull();
  });
});

describe("CHART_CATEGORY_PALETTE", () => {
  it("exposes a non-empty list of unique hex colors", () => {
    expect(CHART_CATEGORY_PALETTE.length).toBeGreaterThanOrEqual(8);
    const unique = new Set(CHART_CATEGORY_PALETTE);
    expect(unique.size).toBe(CHART_CATEGORY_PALETTE.length);
    for (const c of CHART_CATEGORY_PALETTE) {
      expect(c).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });
});
