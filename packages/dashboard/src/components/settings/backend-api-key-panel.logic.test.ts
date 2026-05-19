import { describe, expect, it } from "vitest";
import {
  apiKeyEnvVarNames,
  apiKeyFormatHint,
  apiKeyStatusLabel,
  draftToConfig,
  emptyBedrockDraft,
  emptyDraft,
  emptyGeminiVertexDraft,
  isClearVisible,
  isConfigSaveEnabled,
  isDirectApiKeyProvider,
  isPlausibleAnthropicApiKey,
  isPlausibleApiKey,
  isPlausibleGeminiApiKey,
  isPlausibleOpenAiApiKey,
  isSaveEnabled,
} from "./backend-api-key-panel.logic";

describe("isPlausibleAnthropicApiKey", () => {
  it("accepts a well-formed sk-ant-… key", () => {
    expect(
      isPlausibleAnthropicApiKey("sk-ant-api03-" + "A".repeat(80)),
    ).toBe(true);
  });
  it("rejects an OpenAI-shaped key", () => {
    expect(isPlausibleAnthropicApiKey("sk-" + "A".repeat(40))).toBe(false);
  });
  it("rejects empty / whitespace input", () => {
    expect(isPlausibleAnthropicApiKey("")).toBe(false);
    expect(isPlausibleAnthropicApiKey("   ")).toBe(false);
  });
  it("trims surrounding whitespace before validating", () => {
    const key = "  sk-ant-api03-" + "B".repeat(40) + "  ";
    expect(isPlausibleAnthropicApiKey(key)).toBe(true);
  });
});

describe("isPlausibleOpenAiApiKey", () => {
  it("accepts an sk-… key (≥30 chars after prefix)", () => {
    expect(isPlausibleOpenAiApiKey("sk-" + "B".repeat(40))).toBe(true);
  });
  it("rejects an Anthropic-shaped key (sk-ant-…)", () => {
    // Critical: a swapped key must be caught here, not after we write
    // it to the keychain.
    expect(
      isPlausibleOpenAiApiKey("sk-ant-api03-" + "A".repeat(80)),
    ).toBe(false);
  });
  it("rejects too-short keys", () => {
    expect(isPlausibleOpenAiApiKey("sk-short")).toBe(false);
  });
});

describe("isPlausibleGeminiApiKey", () => {
  it("accepts a 39-char AIza… key", () => {
    expect(
      isPlausibleGeminiApiKey("AIza" + "C".repeat(35)),
    ).toBe(true);
  });
  it("rejects keys missing the AIza prefix", () => {
    expect(isPlausibleGeminiApiKey("Bzy" + "C".repeat(36))).toBe(false);
  });
  it("rejects keys of the wrong length", () => {
    expect(isPlausibleGeminiApiKey("AIza" + "C".repeat(34))).toBe(false);
    expect(isPlausibleGeminiApiKey("AIza" + "C".repeat(36))).toBe(false);
  });
});

describe("isPlausibleApiKey (dispatch)", () => {
  it("dispatches to the correct per-backend validator", () => {
    expect(
      isPlausibleApiKey("claude", "sk-ant-api03-" + "A".repeat(80)),
    ).toBe(true);
    expect(isPlausibleApiKey("codex", "sk-" + "B".repeat(40))).toBe(true);
    expect(isPlausibleApiKey("gemini", "AIza" + "C".repeat(35))).toBe(true);
  });
  it("rejects mismatched key shapes for each backend", () => {
    expect(isPlausibleApiKey("claude", "AIza" + "C".repeat(35))).toBe(false);
    expect(
      isPlausibleApiKey("codex", "sk-ant-api03-" + "A".repeat(80)),
    ).toBe(false);
    expect(isPlausibleApiKey("gemini", "sk-" + "B".repeat(40))).toBe(false);
  });
});

describe("apiKeyFormatHint", () => {
  it("returns Anthropic-specific hint for claude", () => {
    expect(apiKeyFormatHint("claude")).toContain("sk-ant-");
  });
  it("warns codex hint to NOT use sk-ant-", () => {
    // Critical for users who have keys for both providers — the hint
    // must call out the swap risk inline.
    const hint = apiKeyFormatHint("codex");
    expect(hint).toContain("sk-");
    expect(hint).toContain("not");
    expect(hint).toContain("sk-ant-");
  });
  it("returns Google-specific hint for gemini", () => {
    const hint = apiKeyFormatHint("gemini");
    expect(hint).toContain("AIza");
    expect(hint).toContain("39");
  });
});

describe("apiKeyEnvVarNames", () => {
  it("returns ANTHROPIC_API_KEY for claude", () => {
    expect(apiKeyEnvVarNames("claude")).toEqual(["ANTHROPIC_API_KEY"]);
  });
  it("returns OPENAI_API_KEY for codex", () => {
    expect(apiKeyEnvVarNames("codex")).toEqual(["OPENAI_API_KEY"]);
  });
  it("returns both Gemini env aliases", () => {
    expect(apiKeyEnvVarNames("gemini")).toEqual([
      "GEMINI_API_KEY",
      "GOOGLE_API_KEY",
    ]);
  });
  it("returns the OpenCode server password env var", () => {
    expect(apiKeyEnvVarNames("opencode")).toEqual(["OPENCODE_SERVER_PASSWORD"]);
  });
});

describe("apiKeyStatusLabel", () => {
  it("describes the keychain branch", () => {
    expect(apiKeyStatusLabel("keychain")).toContain("keychain");
  });
  it("describes the shell branch with override hint", () => {
    expect(apiKeyStatusLabel("shell")).toContain("shell");
    expect(apiKeyStatusLabel("shell")).toContain("override");
  });
  it("describes the none branch with CLI fallback note", () => {
    expect(apiKeyStatusLabel("none")).toContain("No API key");
    expect(apiKeyStatusLabel("none")).toContain("CLI");
  });
});

describe("isSaveEnabled", () => {
  it("disables when saving is in flight", () => {
    expect(
      isSaveEnabled({
        backendId: "claude",
        draftValue: "sk-ant-api03-" + "A".repeat(80),
        saving: true,
      }),
    ).toBe(false);
  });
  it("disables on empty input", () => {
    expect(
      isSaveEnabled({ backendId: "claude", draftValue: "", saving: false }),
    ).toBe(false);
    expect(
      isSaveEnabled({ backendId: "claude", draftValue: "   ", saving: false }),
    ).toBe(false);
  });
  it("disables when format is invalid", () => {
    expect(
      isSaveEnabled({
        backendId: "claude",
        draftValue: "garbage",
        saving: false,
      }),
    ).toBe(false);
  });
  it("enables when format is valid and not in flight", () => {
    expect(
      isSaveEnabled({
        backendId: "claude",
        draftValue: "sk-ant-api03-" + "A".repeat(80),
        saving: false,
      }),
    ).toBe(true);
  });
});

describe("isClearVisible", () => {
  it("is visible only for keychain-stored keys", () => {
    expect(isClearVisible("keychain")).toBe(true);
    // Shell-set vars require shell access to clear; the dashboard can't
    // help with that.
    expect(isClearVisible("shell")).toBe(false);
    expect(isClearVisible("none")).toBe(false);
  });
});

describe("isDirectApiKeyProvider", () => {
  it("identifies the three direct-API providers", () => {
    expect(isDirectApiKeyProvider("anthropic")).toBe(true);
    expect(isDirectApiKeyProvider("openai")).toBe(true);
    expect(isDirectApiKeyProvider("google")).toBe(true);
  });
  it("identifies cloud providers as multi-field", () => {
    expect(isDirectApiKeyProvider("bedrock")).toBe(false);
    expect(isDirectApiKeyProvider("vertex")).toBe(false);
    expect(isDirectApiKeyProvider("foundry")).toBe(false);
    expect(isDirectApiKeyProvider("gemini-vertex")).toBe(false);
    expect(isDirectApiKeyProvider("opencode-server")).toBe(false);
  });
});

describe("emptyDraft / draftToConfig — round-trip", () => {
  it("anthropic draft with apiKey converts to config", () => {
    const draft = { ...emptyDraft("anthropic") };
    if (draft.provider !== "anthropic") throw new Error("type narrowing");
    draft.apiKey = "sk-ant-test";
    expect(draftToConfig(draft)).toEqual({
      provider: "anthropic",
      apiKey: "sk-ant-test",
    });
  });
  it("returns null when required fields are missing", () => {
    expect(draftToConfig(emptyDraft("anthropic"))).toBeNull();
    expect(draftToConfig(emptyBedrockDraft("access_key"))).toBeNull();
    expect(draftToConfig(emptyBedrockDraft("bearer_token"))).toBeNull();
    expect(draftToConfig(emptyGeminiVertexDraft("adc"))).toBeNull();
  });
  it("Bedrock access_key emits the required fields + recommended pinned models", () => {
    const draft = emptyBedrockDraft("access_key");
    if (draft.provider !== "bedrock" || draft.authMode !== "access_key") {
      throw new Error("type narrowing");
    }
    draft.awsAccessKeyId = "AKIA";
    draft.awsSecretAccessKey = "secret";
    draft.awsRegion = "us-east-1";
    const config = draftToConfig(draft);
    // Pinned-model defaults are pre-filled from
    // RECOMMENDED_PINNED_MODELS_BY_PROVIDER.bedrock so the saved config
    // includes them. The Anthropic docs explicitly recommend pinning.
    expect(config).toMatchObject({
      provider: "bedrock",
      authMode: "access_key",
      awsAccessKeyId: "AKIA",
      awsSecretAccessKey: "secret",
      awsRegion: "us-east-1",
      defaultOpusModel: "us.anthropic.claude-opus-4-7",
      defaultSonnetModel: "us.anthropic.claude-sonnet-4-6",
      defaultHaikuModel: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
    });
  });
  it("Bedrock bearer_token emits the required fields + recommended pinned models", () => {
    const draft = emptyBedrockDraft("bearer_token");
    if (draft.provider !== "bedrock" || draft.authMode !== "bearer_token") {
      throw new Error("type narrowing");
    }
    draft.awsBearerTokenBedrock = "k";
    draft.awsRegion = "us-east-1";
    expect(draftToConfig(draft)).toMatchObject({
      provider: "bedrock",
      authMode: "bearer_token",
      awsBearerTokenBedrock: "k",
      awsRegion: "us-east-1",
      defaultOpusModel: "us.anthropic.claude-opus-4-7",
    });
  });
  it("foundry resource form omits baseUrl, sets resource + recommended pinned models", () => {
    const draft = emptyDraft("foundry");
    if (draft.provider !== "foundry") throw new Error("type narrowing");
    draft.endpointKind = "resource";
    draft.resource = "my-resource";
    expect(draftToConfig(draft)).toMatchObject({
      provider: "foundry",
      resource: "my-resource",
      defaultOpusModel: "claude-opus-4-7",
    });
  });
  it("foundry baseUrl form omits resource, sets baseUrl", () => {
    const draft = emptyDraft("foundry");
    if (draft.provider !== "foundry") throw new Error("type narrowing");
    draft.endpointKind = "base_url";
    draft.baseUrl = "https://x.azure.com";
    expect(draftToConfig(draft)).toMatchObject({
      provider: "foundry",
      baseUrl: "https://x.azure.com",
    });
  });
  it("gemini-vertex adc minimal config", () => {
    const draft = emptyGeminiVertexDraft("adc");
    if (
      draft.provider !== "gemini-vertex"
      || draft.authMode !== "adc"
    ) throw new Error("type narrowing");
    draft.projectId = "my-project";
    draft.location = "us-central1";
    expect(draftToConfig(draft)).toEqual({
      provider: "gemini-vertex",
      authMode: "adc",
      projectId: "my-project",
      location: "us-central1",
    });
  });
  it("OpenCode server config requires a base URL and username", () => {
    const draft = emptyDraft("opencode-server");
    if (draft.provider !== "opencode-server") throw new Error("type narrowing");
    expect(draftToConfig(draft)).toEqual({
      provider: "opencode-server",
      baseUrl: "http://127.0.0.1:4096",
      username: "opencode",
    });
    draft.password = "secret";
    expect(draftToConfig(draft)).toEqual({
      provider: "opencode-server",
      baseUrl: "http://127.0.0.1:4096",
      username: "opencode",
      password: "secret",
    });
  });
});

describe("emptyDraft — Codex Azure OpenAI", () => {
  it("seeds the API version from the shared default", () => {
    const draft = emptyDraft("azure-openai");
    if (draft.provider !== "azure-openai") throw new Error("type narrowing");
    expect(draft.apiVersion).toMatch(/^\d{4}-\d{2}-\d{2}/);
    expect(draft.resource).toBe("");
    expect(draft.apiKey).toBe("");
  });
  it("requires resource + apiKey to produce a config", () => {
    expect(draftToConfig(emptyDraft("azure-openai"))).toBeNull();

    const draft = emptyDraft("azure-openai");
    if (draft.provider !== "azure-openai") throw new Error("type narrowing");
    draft.resource = "x";
    draft.apiKey = "k";
    expect(draftToConfig(draft)).toMatchObject({
      provider: "azure-openai",
      resource: "x",
      apiKey: "k",
    });
  });
});

describe("isConfigSaveEnabled — cloud forms", () => {
  it("disabled when bedrock region is missing", () => {
    expect(
      isConfigSaveEnabled({
        backendId: "claude",
        draft: emptyBedrockDraft("bearer_token"),
        saving: false,
      }),
    ).toBe(false);
  });
  it("enabled when bedrock bearer_token is fully populated", () => {
    const draft = emptyBedrockDraft("bearer_token");
    if (draft.provider !== "bedrock" || draft.authMode !== "bearer_token") {
      throw new Error("type narrowing");
    }
    draft.awsBearerTokenBedrock = "k";
    draft.awsRegion = "us-east-1";
    expect(
      isConfigSaveEnabled({ backendId: "claude", draft, saving: false }),
    ).toBe(true);
  });
  it("disabled when foundry config has neither resource nor baseUrl", () => {
    expect(
      isConfigSaveEnabled({
        backendId: "claude",
        draft: emptyDraft("foundry"),
        saving: false,
      }),
    ).toBe(false);
  });
});
