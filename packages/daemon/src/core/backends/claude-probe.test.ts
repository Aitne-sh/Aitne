/**
 * Peer tests for `./claude-probe.ts` — the Claude registry-driven probe
 * surface (file-split-plan §8 Tier 1).
 *
 * Coverage focus:
 *  - `detectCloudProviderEnv` — each branch of the
 *    `CLAUDE_CODE_USE_*` flag matrix, including the missing-required-env
 *    detection that `checkAuth` keys off.
 *  - `CLAUDE_PROBE_TOOLS_PROMPT` — the prompt is built once at module
 *    load from the registry; verify it includes the documented hooks
 *    so a registry rollback doesn't silently neuter probe semantics.
 *  - `computeDelegatedClaudeTools` — only Claude-delegated integrations
 *    contribute; Codex/Gemini-delegated ones must not widen the
 *    Claude allowlist.
 *  - `extractClaudeProbeTools` — tool-name capture from SDK stream
 *    messages (system.init.tools, assistant text matches, terminal
 *    result string).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";

import {
  CLAUDE_PROBE_TOOLS_PROMPT,
  computeDelegatedClaudeTools,
  computeNativeClaudeTools,
  detectCloudProviderEnv,
  extractClaudeProbeTools,
} from "./claude-probe.js";

describe("detectCloudProviderEnv", () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    delete process.env.CLAUDE_CODE_USE_BEDROCK;
    delete process.env.CLAUDE_CODE_USE_VERTEX;
    delete process.env.CLAUDE_CODE_USE_FOUNDRY;
    delete process.env.AWS_REGION;
    delete process.env.ANTHROPIC_VERTEX_PROJECT_ID;
    delete process.env.CLOUD_ML_REGION;
    delete process.env.ANTHROPIC_FOUNDRY_RESOURCE;
    delete process.env.ANTHROPIC_FOUNDRY_BASE_URL;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("returns null in the default direct-API mode", () => {
    expect(detectCloudProviderEnv()).toBeNull();
  });

  it("detects Bedrock with required AWS_REGION", () => {
    process.env.CLAUDE_CODE_USE_BEDROCK = "1";
    process.env.AWS_REGION = "us-east-1";
    const result = detectCloudProviderEnv();
    expect(result?.method).toBe("bedrock");
    expect(result?.missing).toEqual([]);
  });

  it("reports AWS_REGION as missing when Bedrock flag set without it", () => {
    process.env.CLAUDE_CODE_USE_BEDROCK = "1";
    const result = detectCloudProviderEnv();
    expect(result?.method).toBe("bedrock");
    expect(result?.missing).toContain("AWS_REGION");
  });

  it("detects Vertex with required project + region", () => {
    process.env.CLAUDE_CODE_USE_VERTEX = "1";
    process.env.ANTHROPIC_VERTEX_PROJECT_ID = "my-proj";
    process.env.CLOUD_ML_REGION = "us-central1";
    const result = detectCloudProviderEnv();
    expect(result?.method).toBe("vertex");
    expect(result?.missing).toEqual([]);
  });

  it("reports both vertex env vars as missing when flag set without them", () => {
    process.env.CLAUDE_CODE_USE_VERTEX = "1";
    const result = detectCloudProviderEnv();
    expect(result?.missing).toContain("ANTHROPIC_VERTEX_PROJECT_ID");
    expect(result?.missing).toContain("CLOUD_ML_REGION");
  });

  it("detects Foundry with FOUNDRY_RESOURCE alone (Azure DefaultAzureCredential)", () => {
    process.env.CLAUDE_CODE_USE_FOUNDRY = "1";
    process.env.ANTHROPIC_FOUNDRY_RESOURCE = "my-resource";
    const result = detectCloudProviderEnv();
    expect(result?.method).toBe("foundry");
    expect(result?.missing).toEqual([]);
  });

  it("detects Foundry with FOUNDRY_BASE_URL alone", () => {
    process.env.CLAUDE_CODE_USE_FOUNDRY = "1";
    process.env.ANTHROPIC_FOUNDRY_BASE_URL = "https://example.openai.azure.com";
    const result = detectCloudProviderEnv();
    expect(result?.method).toBe("foundry");
    expect(result?.missing).toEqual([]);
  });

  it("reports Foundry missing when neither resource nor base URL is set", () => {
    process.env.CLAUDE_CODE_USE_FOUNDRY = "1";
    const result = detectCloudProviderEnv();
    expect(result?.method).toBe("foundry");
    expect(result?.missing.length).toBeGreaterThan(0);
  });

  it("returns null when flag is set to a non-'1' value (e.g. 'true')", () => {
    process.env.CLAUDE_CODE_USE_BEDROCK = "true";
    expect(detectCloudProviderEnv()).toBeNull();
  });
});

describe("CLAUDE_PROBE_TOOLS_PROMPT", () => {
  it("instructs the agent to only use ToolSearch", () => {
    expect(CLAUDE_PROBE_TOOLS_PROMPT).toContain("ToolSearch");
  });

  it("forbids calling the searched tools", () => {
    expect(CLAUDE_PROBE_TOOLS_PROMPT.toLowerCase()).toContain("not call");
  });

  it("instructs to print one tool name per line and NONE on empty", () => {
    expect(CLAUDE_PROBE_TOOLS_PROMPT).toContain("One tool name per line");
    expect(CLAUDE_PROBE_TOOLS_PROMPT).toContain("NONE");
  });

  it("includes at least one connector namespace prefix", () => {
    // INTEGRATION_DESCRIPTORS exposes Claude connectors with namespaces
    // like `mcp__claude_ai_Gmail__`. The prompt must list those for the
    // agent to know which results to surface.
    expect(CLAUDE_PROBE_TOOLS_PROMPT).toMatch(/mcp__claude_ai_/);
  });
});

describe("computeDelegatedClaudeTools", () => {
  it("returns [] when integrations record is empty", () => {
    expect(computeDelegatedClaudeTools({})).toEqual([]);
  });

  it("excludes non-delegated integrations", () => {
    const result = computeDelegatedClaudeTools({
      gmail: {
        mode: "direct",
        deniedTools: [],
        lastChangedAt: "2026-05-10T00:00:00Z",
      },
    });
    expect(result).toEqual([]);
  });

  it("excludes integrations delegated to non-Claude backends", () => {
    const result = computeDelegatedClaudeTools({
      gmail: {
        mode: "delegated",
        delegatedBackend: "codex",
        deniedTools: [],
        lastChangedAt: "2026-05-10T00:00:00Z",
      },
    });
    expect(result).toEqual([]);
  });

  it("includes namespaced tool names for Claude-delegated integrations", () => {
    const result = computeDelegatedClaudeTools({
      gmail: {
        mode: "delegated",
        delegatedBackend: "claude",
        deniedTools: [],
        lastChangedAt: "2026-05-10T00:00:00Z",
      },
    });
    expect(result.length).toBeGreaterThan(0);
    expect(result.every((t) => t.startsWith("mcp__claude_ai_"))).toBe(true);
  });

  it("excludes native integrations from the delegated allowlist", () => {
    // Cross-mode isolation: a native flip on the same backend must not
    // re-surface through the delegated computation.
    const result = computeDelegatedClaudeTools({
      gmail: {
        mode: "native",
        nativeBackend: "claude",
        deniedTools: [],
        lastChangedAt: "2026-05-10T00:00:00Z",
      },
    });
    expect(result).toEqual([]);
  });
});

describe("computeNativeClaudeTools", () => {
  it("returns [] when integrations record is empty", () => {
    expect(computeNativeClaudeTools({})).toEqual([]);
  });

  it("excludes non-native integrations", () => {
    const result = computeNativeClaudeTools({
      gmail: {
        mode: "direct",
        deniedTools: [],
        lastChangedAt: "2026-05-10T00:00:00Z",
      },
    });
    expect(result).toEqual([]);
  });

  it("excludes delegated integrations (cross-mode isolation)", () => {
    const result = computeNativeClaudeTools({
      gmail: {
        mode: "delegated",
        delegatedBackend: "claude",
        deniedTools: [],
        lastChangedAt: "2026-05-10T00:00:00Z",
      },
    });
    expect(result).toEqual([]);
  });

  it("excludes integrations native to non-Claude backends", () => {
    const result = computeNativeClaudeTools({
      gmail: {
        mode: "native",
        nativeBackend: "codex",
        deniedTools: [],
        lastChangedAt: "2026-05-10T00:00:00Z",
      },
    });
    expect(result).toEqual([]);
  });

  it("includes namespaced tool names for Claude-native integrations", () => {
    const result = computeNativeClaudeTools({
      gmail: {
        mode: "native",
        nativeBackend: "claude",
        deniedTools: [],
        lastChangedAt: "2026-05-10T00:00:00Z",
      },
    });
    expect(result.length).toBeGreaterThan(0);
    expect(result.every((t) => t.startsWith("mcp__claude_ai_Gmail__"))).toBe(true);
  });

  it("covers the full Gmail capability surface (read + draft + destructive)", () => {
    const result = computeNativeClaudeTools({
      gmail: {
        mode: "native",
        nativeBackend: "claude",
        deniedTools: [],
        lastChangedAt: "2026-05-10T00:00:00Z",
      },
    });
    // Read-class
    expect(result).toContain("mcp__claude_ai_Gmail__search_threads");
    expect(result).toContain("mcp__claude_ai_Gmail__get_thread");
    expect(result).toContain("mcp__claude_ai_Gmail__list_labels");
    // Draft (reversible write-class)
    expect(result).toContain("mcp__claude_ai_Gmail__create_draft");
    expect(result).toContain("mcp__claude_ai_Gmail__list_drafts");
    // Destructive — included here because the SDK allowlist is the
    // permission gate; the destructive-confirm contract is enforced
    // separately via the skill prompt and `deniedTools`.
    expect(result).toContain("mcp__claude_ai_Gmail__label_message");
    expect(result).toContain("mcp__claude_ai_Gmail__create_label");
  });

  it("unions tools across multiple native integrations on the same backend", () => {
    const result = computeNativeClaudeTools({
      gmail: {
        mode: "native",
        nativeBackend: "claude",
        deniedTools: [],
        lastChangedAt: "2026-05-10T00:00:00Z",
      },
      google_calendar: {
        mode: "native",
        nativeBackend: "claude",
        deniedTools: [],
        lastChangedAt: "2026-05-10T00:00:00Z",
      },
    });
    expect(result).toContain("mcp__claude_ai_Gmail__search_threads");
    expect(result).toContain("mcp__claude_ai_Google_Calendar__list_events");
    expect(result).toContain("mcp__claude_ai_Google_Calendar__create_event");
  });

  it("returns a deduplicated set even when delegated + native coexist", () => {
    // Different integration keys (gmail delegated, calendar native) can't
    // collide on tool names because each has its own namespace; this test
    // just locks in that the helper returns a Set-shaped array (no
    // duplicates) for forward-compat with any registry overlap.
    const result = computeNativeClaudeTools({
      google_calendar: {
        mode: "native",
        nativeBackend: "claude",
        deniedTools: [],
        lastChangedAt: "2026-05-10T00:00:00Z",
      },
    });
    expect(new Set(result).size).toBe(result.length);
  });
});

describe("extractClaudeProbeTools", () => {
  it("returns [] for non-object inputs", () => {
    expect(extractClaudeProbeTools(null)).toEqual([]);
    expect(extractClaudeProbeTools(42)).toEqual([]);
    expect(extractClaudeProbeTools("x")).toEqual([]);
  });

  it("captures tool names from a system.init.tools array", () => {
    const result = extractClaudeProbeTools({
      type: "system",
      subtype: "init",
      tools: [
        "mcp__claude_ai_Gmail__search_threads",
        "Bash",
        "mcp__claude_ai_Google_Calendar__list_events",
      ],
    });
    expect(result).toContain("mcp__claude_ai_Gmail__search_threads");
    expect(result).toContain("mcp__claude_ai_Google_Calendar__list_events");
    // Non-connector tools shouldn't be captured by the prefix check.
    expect(result).not.toContain("Bash");
  });

  it("captures tool names embedded in a result string", () => {
    const result = extractClaudeProbeTools({
      type: "result",
      result:
        "mcp__claude_ai_Gmail__search_threads\nmcp__claude_ai_Gmail__list_drafts",
    });
    expect(result).toContain("mcp__claude_ai_Gmail__search_threads");
    expect(result).toContain("mcp__claude_ai_Gmail__list_drafts");
  });

  it("captures tool names from assistant.message content arrays", () => {
    // Mirrors the SDK's `assistant` event shape: a `message` object with
    // a `content` array of blocks. The walker recognizes two shapes —
    // a regex-extractable string (`text`) and a structured field named
    // `tool_name` (NOT `name`, which the parser ignores by design — see
    // addClaudeProbeTools in claude-probe.ts for the recursion targets).
    const result = extractClaudeProbeTools({
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "I found mcp__claude_ai_Notion__notion-search." },
          { tool_name: "mcp__claude_ai_Google_Calendar__list_events" },
        ],
      },
    });
    expect(result).toContain("mcp__claude_ai_Notion__notion-search");
    expect(result).toContain("mcp__claude_ai_Google_Calendar__list_events");
  });

  it("recursion depth guard prevents pathological recursion", () => {
    // Build a 12-deep nested message; the walker bails at depth 8 so the
    // deeper match is silently dropped (no throw, no hang).
    let nested: unknown = "mcp__claude_ai_Gmail__search_threads";
    for (let i = 0; i < 12; i++) nested = { message: nested };
    const result = extractClaudeProbeTools({ type: "assistant", message: nested });
    // The buried tool name should NOT be reached.
    expect(result).not.toContain("mcp__claude_ai_Gmail__search_threads");
  });

  it("ignores non-object primitives embedded in message structure", () => {
    // Triggers the `typeof value !== "object"` early-return inside the
    // recursive walker — `tool_name` set to a number is malformed but
    // possible from a future SDK shape change. Walker should drop it
    // silently rather than throw.
    const result = extractClaudeProbeTools({
      type: "assistant",
      message: { tool_name: 42, content: "no matches here" },
    });
    expect(result).toEqual([]);
  });
});

describe("describeClaudeProbeResultError (re-exported via claude-code-core)", () => {
  // The function is private to the module but @internal-exported for the
  // probe path. Coverage of its branches mirrors what the live probe sees:
  //   1. result message has a non-empty `result` string  → return that.
  //   2. result message has a non-empty `errors` array   → return joined.
  //   3. fallback                                        → return subtype.
  it("prefers a non-empty result string", async () => {
    const { describeClaudeProbeResultError } = await import("./claude-probe.js");
    const out = describeClaudeProbeResultError({
      type: "result",
      subtype: "error_max_turns",
      result: "Quota exceeded for this hour",
    } as unknown as Parameters<typeof describeClaudeProbeResultError>[0]);
    expect(out).toBe("Quota exceeded for this hour");
  });

  it("falls back to joined errors array when result is missing", async () => {
    const { describeClaudeProbeResultError } = await import("./claude-probe.js");
    const out = describeClaudeProbeResultError({
      type: "result",
      subtype: "error_during_execution",
      errors: ["network unreachable", "retry exhausted"],
    } as unknown as Parameters<typeof describeClaudeProbeResultError>[0]);
    expect(out).toBe("network unreachable; retry exhausted");
  });

  it("falls back to the subtype when neither result nor errors are present", async () => {
    const { describeClaudeProbeResultError } = await import("./claude-probe.js");
    const out = describeClaudeProbeResultError({
      type: "result",
      subtype: "error_max_turns",
    } as unknown as Parameters<typeof describeClaudeProbeResultError>[0]);
    expect(out).toBe("error_max_turns");
  });
});
