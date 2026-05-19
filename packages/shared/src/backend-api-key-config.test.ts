import { describe, it, expect } from "vitest";
import {
  buildCodexAzureConfigToml,
  defaultApiKeyProvider,
  DEFAULT_AZURE_OPENAI_API_VERSION,
  foundryApiKeyConfigSchema,
  getApiKeyEnvAssignments,
  getManagedApiKeyEnvVars,
  isApiKeyProviderForBackend,
  isPlausibleOpenAiApiKey,
  parseBackendApiKeyConfig,
  RECOMMENDED_PINNED_MODELS_BY_PROVIDER,
  serializeBackendApiKeyConfig,
  validateBackendApiKeyConfigFormat,
} from "./backend-api-key-config.js";

describe("defaultApiKeyProvider", () => {
  it("returns the direct-API provider for each backend", () => {
    expect(defaultApiKeyProvider("claude")).toBe("anthropic");
    expect(defaultApiKeyProvider("codex")).toBe("openai");
    expect(defaultApiKeyProvider("gemini")).toBe("google");
    expect(defaultApiKeyProvider("opencode")).toBe("opencode-server");
  });
});

describe("isApiKeyProviderForBackend", () => {
  it("accepts cloud providers only for claude", () => {
    expect(isApiKeyProviderForBackend("claude", "anthropic")).toBe(true);
    expect(isApiKeyProviderForBackend("claude", "bedrock")).toBe(true);
    expect(isApiKeyProviderForBackend("claude", "vertex")).toBe(true);
    expect(isApiKeyProviderForBackend("claude", "foundry")).toBe(true);
    expect(isApiKeyProviderForBackend("claude", "openai")).toBe(false);
  });
  it("accepts gemini-vertex for gemini, not for claude/codex", () => {
    expect(isApiKeyProviderForBackend("gemini", "google")).toBe(true);
    expect(isApiKeyProviderForBackend("gemini", "gemini-vertex")).toBe(true);
    expect(isApiKeyProviderForBackend("claude", "gemini-vertex")).toBe(false);
    expect(isApiKeyProviderForBackend("codex", "gemini-vertex")).toBe(false);
  });
  it("accepts the OpenCode server provider only for opencode", () => {
    expect(isApiKeyProviderForBackend("opencode", "opencode-server")).toBe(true);
    expect(isApiKeyProviderForBackend("claude", "opencode-server")).toBe(false);
    expect(isApiKeyProviderForBackend("codex", "opencode-server")).toBe(false);
    expect(isApiKeyProviderForBackend("gemini", "opencode-server")).toBe(false);
  });
});

describe("RECOMMENDED_PINNED_MODELS_BY_PROVIDER", () => {
  it("provides bedrock-format IDs (us.anthropic.…) for bedrock", () => {
    const r = RECOMMENDED_PINNED_MODELS_BY_PROVIDER.bedrock;
    expect(r.defaultOpusModel).toMatch(/^us\.anthropic\./);
    expect(r.defaultSonnetModel).toMatch(/^us\.anthropic\./);
    expect(r.defaultHaikuModel).toMatch(/^us\.anthropic\./);
  });
  it("provides Vertex-format IDs for vertex", () => {
    const r = RECOMMENDED_PINNED_MODELS_BY_PROVIDER.vertex;
    expect(r.defaultOpusModel).toBe("claude-opus-4-7");
    expect(r.defaultSonnetModel).toBe("claude-sonnet-4-6");
    expect(r.defaultHaikuModel).toMatch(/^claude-haiku-4-5@/);
  });
  it("provides Foundry-format IDs for foundry", () => {
    const r = RECOMMENDED_PINNED_MODELS_BY_PROVIDER.foundry;
    expect(r.defaultOpusModel).toBe("claude-opus-4-7");
    expect(r.defaultSonnetModel).toBe("claude-sonnet-4-6");
    expect(r.defaultHaikuModel).toBe("claude-haiku-4-5");
  });
});

describe("getManagedApiKeyEnvVars", () => {
  it("includes Mantle + cloud model-pin env vars for claude", () => {
    const claude = getManagedApiKeyEnvVars("claude");
    expect(claude).toContain("CLAUDE_CODE_USE_MANTLE");
    expect(claude).toContain("ANTHROPIC_BEDROCK_MANTLE_BASE_URL");
    expect(claude).toContain("CLAUDE_CODE_SKIP_MANTLE_AUTH");
    expect(claude).toContain("ANTHROPIC_DEFAULT_OPUS_MODEL");
    expect(claude).toContain("ANTHROPIC_DEFAULT_SONNET_MODEL");
    expect(claude).toContain("ANTHROPIC_DEFAULT_HAIKU_MODEL");
  });
  it("includes Codex Azure OpenAI env vars (AZURE_OPENAI_API_KEY + CODEX_HOME)", () => {
    const codex = getManagedApiKeyEnvVars("codex");
    expect(codex).toContain("OPENAI_API_KEY");
    expect(codex).toContain("AZURE_OPENAI_API_KEY");
    expect(codex).toContain("CODEX_HOME");
  });
  it("includes the cloud-provider env vars for claude (matches official docs)", () => {
    const claude = getManagedApiKeyEnvVars("claude");
    // Direct
    expect(claude).toContain("ANTHROPIC_API_KEY");
    // Bedrock — all three auth modes
    expect(claude).toContain("CLAUDE_CODE_USE_BEDROCK");
    expect(claude).toContain("AWS_REGION");
    expect(claude).toContain("AWS_ACCESS_KEY_ID");
    expect(claude).toContain("AWS_SECRET_ACCESS_KEY");
    expect(claude).toContain("AWS_SESSION_TOKEN");
    expect(claude).toContain("AWS_BEARER_TOKEN_BEDROCK");
    expect(claude).toContain("AWS_PROFILE");
    expect(claude).toContain("ANTHROPIC_BEDROCK_BASE_URL");
    // Vertex — file path, NOT inline JSON
    expect(claude).toContain("CLAUDE_CODE_USE_VERTEX");
    expect(claude).toContain("ANTHROPIC_VERTEX_PROJECT_ID");
    expect(claude).toContain("CLOUD_ML_REGION");
    expect(claude).toContain("GOOGLE_APPLICATION_CREDENTIALS");
    // Critical: the previously-shipped fake env var must NOT be in the
    // managed set — it's not a real GCP / Anthropic SDK env var.
    expect(claude).not.toContain("GOOGLE_APPLICATION_CREDENTIALS_JSON");
    // Foundry — resource OR baseUrl, NOT the invented ENDPOINT name
    expect(claude).toContain("CLAUDE_CODE_USE_FOUNDRY");
    expect(claude).toContain("ANTHROPIC_FOUNDRY_RESOURCE");
    expect(claude).toContain("ANTHROPIC_FOUNDRY_BASE_URL");
    expect(claude).toContain("ANTHROPIC_FOUNDRY_API_KEY");
    expect(claude).not.toContain("ANTHROPIC_FOUNDRY_ENDPOINT");
  });
  it("includes Vertex AI env vars for gemini", () => {
    const gemini = getManagedApiKeyEnvVars("gemini");
    expect(gemini).toContain("GEMINI_API_KEY");
    expect(gemini).toContain("GOOGLE_API_KEY");
    expect(gemini).toContain("GOOGLE_GENAI_USE_VERTEXAI");
    expect(gemini).toContain("GOOGLE_CLOUD_PROJECT");
    expect(gemini).toContain("GOOGLE_CLOUD_LOCATION");
    expect(gemini).toContain("GOOGLE_APPLICATION_CREDENTIALS");
  });
  it("includes direct + Azure OpenAI env vars for codex", () => {
    // Codex supports two providers: direct OpenAI (just OPENAI_API_KEY)
    // and Azure OpenAI (AZURE_OPENAI_API_KEY + CODEX_HOME pointing at a
    // daemon-managed config.toml). Both env vars are managed so a switch
    // between providers cleanly clears the inactive set.
    expect(getManagedApiKeyEnvVars("codex")).toEqual([
      "OPENAI_API_KEY",
      "AZURE_OPENAI_API_KEY",
      "CODEX_HOME",
    ]);
  });
  it("includes OpenCode server auth env vars", () => {
    expect(getManagedApiKeyEnvVars("opencode")).toEqual([
      "OPENCODE_SERVER_USERNAME",
      "OPENCODE_SERVER_PASSWORD",
    ]);
  });
});

describe("getApiKeyEnvAssignments — Bedrock auth modes", () => {
  it("access_key sets the access-key vars + region; no session token unless supplied", () => {
    const without = getApiKeyEnvAssignments({
      provider: "bedrock",
      authMode: "access_key",
      awsAccessKeyId: "AKIA",
      awsSecretAccessKey: "secret",
      awsRegion: "us-east-1",
    });
    expect(without).toEqual({
      CLAUDE_CODE_USE_BEDROCK: "1",
      AWS_REGION: "us-east-1",
      AWS_ACCESS_KEY_ID: "AKIA",
      AWS_SECRET_ACCESS_KEY: "secret",
    });
  });
  it("access_key with session token", () => {
    const tokened = getApiKeyEnvAssignments({
      provider: "bedrock",
      authMode: "access_key",
      awsAccessKeyId: "ASIA",
      awsSecretAccessKey: "secret",
      awsSessionToken: "TOK",
      awsRegion: "us-west-2",
    });
    expect(tokened.AWS_SESSION_TOKEN).toBe("TOK");
  });
  it("bearer_token sets only the bearer var + region", () => {
    expect(
      getApiKeyEnvAssignments({
        provider: "bedrock",
        authMode: "bearer_token",
        awsBearerTokenBedrock: "bedrock-key-xxx",
        awsRegion: "us-east-1",
      }),
    ).toEqual({
      CLAUDE_CODE_USE_BEDROCK: "1",
      AWS_REGION: "us-east-1",
      AWS_BEARER_TOKEN_BEDROCK: "bedrock-key-xxx",
    });
  });
  it("profile sets AWS_PROFILE + region (no key/secret leakage)", () => {
    const out = getApiKeyEnvAssignments({
      provider: "bedrock",
      authMode: "profile",
      awsProfile: "my-sso",
      awsRegion: "us-east-1",
    });
    expect(out.AWS_PROFILE).toBe("my-sso");
    expect(out.AWS_ACCESS_KEY_ID).toBeUndefined();
    expect(out.AWS_BEARER_TOKEN_BEDROCK).toBeUndefined();
  });
  it("includes ANTHROPIC_BEDROCK_BASE_URL when supplied", () => {
    const out = getApiKeyEnvAssignments({
      provider: "bedrock",
      authMode: "bearer_token",
      awsBearerTokenBedrock: "k",
      awsRegion: "us-east-1",
      bedrockBaseUrl: "https://bedrock.internal.example.com",
    });
    expect(out.ANTHROPIC_BEDROCK_BASE_URL).toBe(
      "https://bedrock.internal.example.com",
    );
  });
});

describe("getApiKeyEnvAssignments — Vertex (Claude)", () => {
  it("required env vars only when nothing optional supplied", () => {
    expect(
      getApiKeyEnvAssignments({
        provider: "vertex",
        projectId: "p",
        region: "us-east5",
      }),
    ).toEqual({
      CLAUDE_CODE_USE_VERTEX: "1",
      ANTHROPIC_VERTEX_PROJECT_ID: "p",
      CLOUD_ML_REGION: "us-east5",
    });
  });
  it("credentialsFile maps to GOOGLE_APPLICATION_CREDENTIALS (file path)", () => {
    const out = getApiKeyEnvAssignments({
      provider: "vertex",
      projectId: "p",
      region: "us-east5",
      credentialsFile: "/Users/me/keys/sa.json",
    });
    expect(out.GOOGLE_APPLICATION_CREDENTIALS).toBe("/Users/me/keys/sa.json");
    // Critical: no fake _JSON variant
    expect(
      "GOOGLE_APPLICATION_CREDENTIALS_JSON" in out,
    ).toBe(false);
  });
});

describe("getApiKeyEnvAssignments — Foundry", () => {
  it("resource form maps to ANTHROPIC_FOUNDRY_RESOURCE", () => {
    const out = getApiKeyEnvAssignments({
      provider: "foundry",
      resource: "my-resource",
    });
    expect(out).toEqual({
      CLAUDE_CODE_USE_FOUNDRY: "1",
      ANTHROPIC_FOUNDRY_RESOURCE: "my-resource",
    });
    expect("ANTHROPIC_FOUNDRY_API_KEY" in out).toBe(false);
  });
  it("baseUrl form maps to ANTHROPIC_FOUNDRY_BASE_URL; API key optional", () => {
    const out = getApiKeyEnvAssignments({
      provider: "foundry",
      baseUrl: "https://foo.azure.com/anthropic",
      apiKey: "k",
    });
    expect(out.ANTHROPIC_FOUNDRY_BASE_URL).toBe(
      "https://foo.azure.com/anthropic",
    );
    expect(out.ANTHROPIC_FOUNDRY_API_KEY).toBe("k");
    expect("ANTHROPIC_FOUNDRY_RESOURCE" in out).toBe(false);
    // Critical: the previously-shipped wrong env var name must not appear.
    expect("ANTHROPIC_FOUNDRY_ENDPOINT" in out).toBe(false);
  });
});

describe("getApiKeyEnvAssignments — Gemini Vertex", () => {
  it("ADC mode sets only project + location + flag", () => {
    expect(
      getApiKeyEnvAssignments({
        provider: "gemini-vertex",
        authMode: "adc",
        projectId: "p",
        location: "us-central1",
      }),
    ).toEqual({
      GOOGLE_GENAI_USE_VERTEXAI: "true",
      GOOGLE_CLOUD_PROJECT: "p",
      GOOGLE_CLOUD_LOCATION: "us-central1",
    });
  });
  it("service_account mode adds GOOGLE_APPLICATION_CREDENTIALS file path", () => {
    const out = getApiKeyEnvAssignments({
      provider: "gemini-vertex",
      authMode: "service_account",
      projectId: "p",
      location: "us-central1",
      credentialsFile: "/Users/me/sa.json",
    });
    expect(out.GOOGLE_APPLICATION_CREDENTIALS).toBe("/Users/me/sa.json");
  });
  it("api_key mode sets GOOGLE_API_KEY (NOT GEMINI_API_KEY)", () => {
    const out = getApiKeyEnvAssignments({
      provider: "gemini-vertex",
      authMode: "api_key",
      projectId: "p",
      location: "us-central1",
      apiKey: "AIzaVertexKey",
    });
    expect(out.GOOGLE_API_KEY).toBe("AIzaVertexKey");
    // GEMINI_API_KEY is reserved for the direct-API provider; Vertex API
    // key auth uses GOOGLE_API_KEY only.
    expect("GEMINI_API_KEY" in out).toBe(false);
  });
});

describe("getApiKeyEnvAssignments — model pinning + Mantle", () => {
  it("Bedrock with all three pinned models populates ANTHROPIC_DEFAULT_*_MODEL", () => {
    const out = getApiKeyEnvAssignments({
      provider: "bedrock",
      authMode: "bearer_token",
      awsBearerTokenBedrock: "k",
      awsRegion: "us-east-1",
      defaultOpusModel: "us.anthropic.claude-opus-4-7",
      defaultSonnetModel: "us.anthropic.claude-sonnet-4-6",
      defaultHaikuModel: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
    });
    expect(out.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe(
      "us.anthropic.claude-opus-4-7",
    );
    expect(out.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe(
      "us.anthropic.claude-sonnet-4-6",
    );
    expect(out.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe(
      "us.anthropic.claude-haiku-4-5-20251001-v1:0",
    );
  });
  it("Vertex pinning works without setting Bedrock-only flags", () => {
    const out = getApiKeyEnvAssignments({
      provider: "vertex",
      projectId: "p",
      region: "us-east5",
      defaultOpusModel: "claude-opus-4-7",
    });
    expect(out.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe("claude-opus-4-7");
    expect("ANTHROPIC_DEFAULT_SONNET_MODEL" in out).toBe(false);
    expect("CLAUDE_CODE_USE_BEDROCK" in out).toBe(false);
  });
  it("Foundry pinning passes through", () => {
    const out = getApiKeyEnvAssignments({
      provider: "foundry",
      resource: "x",
      defaultSonnetModel: "claude-sonnet-4-6",
    });
    expect(out.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe("claude-sonnet-4-6");
  });
  it("Bedrock Mantle flag mirrors to CLAUDE_CODE_USE_MANTLE=1", () => {
    const out = getApiKeyEnvAssignments({
      provider: "bedrock",
      authMode: "bearer_token",
      awsBearerTokenBedrock: "k",
      awsRegion: "us-east-1",
      useMantle: true,
      mantleBaseUrl: "https://mantle.example.com",
      skipMantleAuth: true,
      smallFastModelAwsRegion: "us-west-2",
    });
    expect(out.CLAUDE_CODE_USE_MANTLE).toBe("1");
    expect(out.ANTHROPIC_BEDROCK_MANTLE_BASE_URL).toBe(
      "https://mantle.example.com",
    );
    expect(out.CLAUDE_CODE_SKIP_MANTLE_AUTH).toBe("1");
    expect(out.ANTHROPIC_SMALL_FAST_MODEL_AWS_REGION).toBe("us-west-2");
    // Standard Bedrock flag stays set — Mantle is additive, not replacing.
    expect(out.CLAUDE_CODE_USE_BEDROCK).toBe("1");
  });
  it("Mantle off: no CLAUDE_CODE_USE_MANTLE env var even if mantleBaseUrl is set", () => {
    const out = getApiKeyEnvAssignments({
      provider: "bedrock",
      authMode: "bearer_token",
      awsBearerTokenBedrock: "k",
      awsRegion: "us-east-1",
      mantleBaseUrl: "https://mantle.example.com",
    });
    // Without the explicit flag, the URL should NOT propagate either —
    // setting only the URL would leave Mantle disabled but with stale env.
    // Current behaviour: URL still mirrors because the field is set; the
    // operator gates Mantle by setting `useMantle`. Document this in test.
    expect("CLAUDE_CODE_USE_MANTLE" in out).toBe(false);
    expect(out.ANTHROPIC_BEDROCK_MANTLE_BASE_URL).toBe(
      "https://mantle.example.com",
    );
  });
});

describe("getApiKeyEnvAssignments — Codex Azure OpenAI", () => {
  it("sets AZURE_OPENAI_API_KEY only (CODEX_HOME is daemon-owned)", () => {
    const out = getApiKeyEnvAssignments({
      provider: "azure-openai",
      resource: "my-resource",
      apiKey: "azure-key",
    });
    expect(out).toEqual({ AZURE_OPENAI_API_KEY: "azure-key" });
    expect("CODEX_HOME" in out).toBe(false);
    expect("OPENAI_API_KEY" in out).toBe(false);
  });
});

describe("buildCodexAzureConfigToml", () => {
  it("emits a valid [model_providers.azure] block with API version + responses wire", () => {
    const toml = buildCodexAzureConfigToml({
      provider: "azure-openai",
      resource: "my-resource",
      apiKey: "k",
    });
    expect(toml).toContain("[model_providers.azure]");
    expect(toml).toContain(
      'base_url = "https://my-resource.openai.azure.com/openai/v1"',
    );
    expect(toml).toContain('env_key = "AZURE_OPENAI_API_KEY"');
    expect(toml).toContain(
      `api-version = "${DEFAULT_AZURE_OPENAI_API_VERSION}"`,
    );
    expect(toml).toContain('wire_api = "responses"');
    expect(toml).toContain('model_provider = "azure"');
  });
  it("places `model_provider` BEFORE the [model_providers.azure] header (top-level, not nested)", () => {
    // Critical structural invariant: TOML scopes keys to the most-recent
    // [section] header. If `model_provider = "azure"` appears AFTER the
    // `[model_providers.azure]` header, it nests as
    // `model_providers.azure.model_provider` and the actual top-level
    // `model_provider` stays unset — Codex would silently fall back to
    // the OpenAI default. A real TOML parse-roundtrip is in the daemon
    // test (where `@iarna/toml` is a dep); here we assert the textual
    // ordering as a cheap line-of-defense.
    const toml = buildCodexAzureConfigToml({
      provider: "azure-openai",
      resource: "x",
      apiKey: "k",
    });
    const providerIdx = toml.indexOf('model_provider = "azure"');
    const sectionIdx = toml.indexOf("[model_providers.azure]");
    expect(providerIdx).toBeGreaterThan(-1);
    expect(sectionIdx).toBeGreaterThan(-1);
    expect(providerIdx).toBeLessThan(sectionIdx);
  });
  it("custom api-version overrides the default", () => {
    const toml = buildCodexAzureConfigToml({
      provider: "azure-openai",
      resource: "x",
      apiKey: "k",
      apiVersion: "2025-08-15",
    });
    expect(toml).toContain('api-version = "2025-08-15"');
  });
  it("deploymentName pins the active model AT THE TOP LEVEL (before sections)", () => {
    const toml = buildCodexAzureConfigToml({
      provider: "azure-openai",
      resource: "x",
      apiKey: "k",
      deploymentName: "my-gpt-deployment",
    });
    expect(toml).toContain('model = "my-gpt-deployment"');
    const modelIdx = toml.indexOf('model = "my-gpt-deployment"');
    const sectionIdx = toml.indexOf("[model_providers.azure]");
    // Same invariant as model_provider — `model` is a top-level key.
    expect(modelIdx).toBeLessThan(sectionIdx);
  });
  it("omits the model line when deploymentName is unset", () => {
    const toml = buildCodexAzureConfigToml({
      provider: "azure-openai",
      resource: "x",
      apiKey: "k",
    });
    expect(toml).not.toMatch(/^model = /m);
  });
});

describe("getApiKeyEnvAssignments — direct providers", () => {
  it("anthropic", () => {
    expect(
      getApiKeyEnvAssignments({ provider: "anthropic", apiKey: "k" }),
    ).toEqual({ ANTHROPIC_API_KEY: "k" });
  });
  it("openai", () => {
    expect(
      getApiKeyEnvAssignments({ provider: "openai", apiKey: "k" }),
    ).toEqual({ OPENAI_API_KEY: "k" });
  });
  it("google: populates BOTH aliases with the same value", () => {
    expect(
      getApiKeyEnvAssignments({ provider: "google", apiKey: "AIza" }),
    ).toEqual({ GEMINI_API_KEY: "AIza", GOOGLE_API_KEY: "AIza" });
  });
  it("opencode-server maps username and password when supplied", () => {
    expect(
      getApiKeyEnvAssignments({
        provider: "opencode-server",
        baseUrl: "http://127.0.0.1:4096",
        username: "user",
        password: "secret",
      }),
    ).toEqual({
      OPENCODE_SERVER_USERNAME: "user",
      OPENCODE_SERVER_PASSWORD: "secret",
    });
  });
  it("opencode-server omits both env vars when username/password are empty (defensive — schema defaults username, but the assignment helper is also called on partial drafts)", () => {
    // Force-cast the partial draft past the parse-time `.default("opencode")` —
    // this exercises the empty-branch ternaries in `getApiKeyEnvAssignments`
    // which guard against a caller passing an unparsed config object.
    expect(
      getApiKeyEnvAssignments({
        provider: "opencode-server",
        baseUrl: "http://127.0.0.1:4096",
        username: "",
        password: "",
      } as never),
    ).toEqual({});
  });
});

describe("parseBackendApiKeyConfig", () => {
  it("returns null for null / empty input", () => {
    expect(parseBackendApiKeyConfig("claude", null)).toBeNull();
    expect(parseBackendApiKeyConfig("claude", "")).toBeNull();
    expect(parseBackendApiKeyConfig("claude", "   ")).toBeNull();
  });
  it("decodes Bedrock JSON with auth-mode discriminator", () => {
    const raw = JSON.stringify({
      provider: "bedrock",
      authMode: "bearer_token",
      awsBearerTokenBedrock: "k",
      awsRegion: "us-east-1",
    });
    const parsed = parseBackendApiKeyConfig("claude", raw);
    expect(parsed?.provider).toBe("bedrock");
    if (parsed && parsed.provider === "bedrock") {
      expect(parsed.authMode).toBe("bearer_token");
    }
  });
  it("treats malformed JSON as not configured", () => {
    expect(parseBackendApiKeyConfig("claude", "{broken")).toBeNull();
  });
  it("rejects providers that don't belong to the backend", () => {
    const raw = JSON.stringify({
      provider: "bedrock",
      authMode: "bearer_token",
      awsBearerTokenBedrock: "k",
      awsRegion: "us-east-1",
    });
    // bedrock is claude-only — for codex this is malformed.
    expect(parseBackendApiKeyConfig("codex", raw)).toBeNull();
  });
  it("legacy raw string promotes to the default direct provider", () => {
    expect(parseBackendApiKeyConfig("claude", "sk-ant-legacy")).toEqual({
      provider: "anthropic",
      apiKey: "sk-ant-legacy",
    });
    expect(parseBackendApiKeyConfig("codex", "sk-legacy")).toEqual({
      provider: "openai",
      apiKey: "sk-legacy",
    });
    expect(parseBackendApiKeyConfig("gemini", "AIza-legacy")).toEqual({
      provider: "google",
      apiKey: "AIza-legacy",
    });
  });
  it("does not promote legacy raw strings for OpenCode server config", () => {
    expect(parseBackendApiKeyConfig("opencode", "legacy-secret")).toBeNull();
  });
});

describe("serializeBackendApiKeyConfig", () => {
  it("round-trips a Vertex config with optional file path", () => {
    const original = {
      provider: "vertex",
      projectId: "p",
      region: "us-east5",
      credentialsFile: "/Users/me/sa.json",
    } as const;
    const json = serializeBackendApiKeyConfig(original);
    expect(parseBackendApiKeyConfig("claude", json)).toEqual(original);
  });
  it("round-trips a gemini-vertex config", () => {
    const original = {
      provider: "gemini-vertex",
      authMode: "adc",
      projectId: "p",
      location: "us-central1",
    } as const;
    const json = serializeBackendApiKeyConfig(original);
    expect(parseBackendApiKeyConfig("gemini", json)).toEqual(original);
  });
  it("round-trips an OpenCode server config", () => {
    const original = {
      provider: "opencode-server",
      baseUrl: "http://127.0.0.1:4096",
      username: "opencode",
      password: "secret",
    } as const;
    const json = serializeBackendApiKeyConfig(original);
    expect(parseBackendApiKeyConfig("opencode", json)).toEqual(original);
  });
});

describe("validateBackendApiKeyConfigFormat", () => {
  it("returns null when shapes look plausible", () => {
    expect(
      validateBackendApiKeyConfigFormat("claude", {
        provider: "anthropic",
        apiKey: "sk-ant-api03-" + "A".repeat(40),
      }),
    ).toBeNull();
    expect(
      validateBackendApiKeyConfigFormat("claude", {
        provider: "bedrock",
        authMode: "access_key",
        awsAccessKeyId: "AKIAEXAMPLEEXAMPLE",
        awsSecretAccessKey: "s",
        awsRegion: "us-east-1",
      }),
    ).toBeNull();
    expect(
      validateBackendApiKeyConfigFormat("claude", {
        provider: "bedrock",
        authMode: "bearer_token",
        awsBearerTokenBedrock: "k",
        awsRegion: "us-east-1",
      }),
    ).toBeNull();
    expect(
      validateBackendApiKeyConfigFormat("claude", {
        provider: "vertex",
        projectId: "my-project",
        region: "us-east5",
      }),
    ).toBeNull();
    expect(
      validateBackendApiKeyConfigFormat("claude", {
        provider: "foundry",
        resource: "my-resource",
      }),
    ).toBeNull();
    expect(
      validateBackendApiKeyConfigFormat("claude", {
        provider: "foundry",
        baseUrl: "https://foo.azure.com",
      }),
    ).toBeNull();
    expect(
      validateBackendApiKeyConfigFormat("gemini", {
        provider: "gemini-vertex",
        authMode: "adc",
        projectId: "my-project",
        location: "us-central1",
      }),
    ).toBeNull();
    expect(
      validateBackendApiKeyConfigFormat("opencode", {
        provider: "opencode-server",
        baseUrl: "http://127.0.0.1:4096",
        username: "opencode",
      }),
    ).toBeNull();
  });
  it("rejects providers that don't belong to the backend", () => {
    expect(
      validateBackendApiKeyConfigFormat("codex", {
        provider: "bedrock",
        authMode: "bearer_token",
        awsBearerTokenBedrock: "k",
        awsRegion: "us-east-1",
      }),
    ).toMatch(/not valid for the codex/);
  });
  it("rejects malformed AWS access key (access_key mode only)", () => {
    expect(
      validateBackendApiKeyConfigFormat("claude", {
        provider: "bedrock",
        authMode: "access_key",
        awsAccessKeyId: "lowercase!",
        awsSecretAccessKey: "s",
        awsRegion: "us-east-1",
      }),
    ).toMatch(/AWS access key/);
  });
  it("rejects foundry config that sets both resource and baseUrl", () => {
    expect(
      validateBackendApiKeyConfigFormat("claude", {
        provider: "foundry",
        resource: "x",
        baseUrl: "https://y.example.com",
      } as never),
    ).toMatch(/EITHER/);
  });
  it("rejects gemini-vertex api_key mode with malformed key", () => {
    expect(
      validateBackendApiKeyConfigFormat("gemini", {
        provider: "gemini-vertex",
        authMode: "api_key",
        projectId: "my-project",
        location: "us-central1",
        apiKey: "not-a-vertex-key",
      }),
    ).toMatch(/Vertex API key/);
  });
  it("rejects swapped openai / anthropic keys", () => {
    expect(
      validateBackendApiKeyConfigFormat("codex", {
        provider: "openai",
        apiKey: "sk-ant-api03-" + "A".repeat(40),
      }),
    ).toMatch(/OpenAI API key/);
  });
  it("rejects a malformed Anthropic API key", () => {
    expect(
      validateBackendApiKeyConfigFormat("claude", {
        provider: "anthropic",
        apiKey: "not-an-anthropic-key",
      }),
    ).toMatch(/Anthropic API key/);
  });
  it("accepts a valid OpenAI key → null", () => {
    expect(
      validateBackendApiKeyConfigFormat("codex", {
        provider: "openai",
        apiKey: "sk-" + "x".repeat(30),
      }),
    ).toBeNull();
  });
  it("rejects azure-openai resource containing a space", () => {
    expect(
      validateBackendApiKeyConfigFormat("codex", {
        provider: "azure-openai",
        resource: "my resource name",
        apiKey: "azure-api-key",
      }),
    ).toMatch(/resource name looks malformed/);
  });
  it("rejects azure-openai whitespace-only resource (trims to empty)", () => {
    expect(
      validateBackendApiKeyConfigFormat("codex", {
        provider: "azure-openai",
        resource: "   ",
        apiKey: "azure-api-key",
      }),
    ).toMatch(/resource name looks malformed/);
  });
  it("rejects azure-openai whitespace-only apiKey", () => {
    expect(
      validateBackendApiKeyConfigFormat("codex", {
        provider: "azure-openai",
        resource: "valid-resource",
        apiKey: "   ",
      }),
    ).toMatch(/API key is required/);
  });
  it("accepts valid azure-openai config → null", () => {
    expect(
      validateBackendApiKeyConfigFormat("codex", {
        provider: "azure-openai",
        resource: "my-resource",
        apiKey: "azure-api-key-value",
      }),
    ).toBeNull();
  });
  it("rejects malformed Google API key", () => {
    expect(
      validateBackendApiKeyConfigFormat("gemini", {
        provider: "google",
        apiKey: "not-a-google-key",
      }),
    ).toMatch(/Google API key/);
  });
  it("accepts valid Google API key → null", () => {
    expect(
      validateBackendApiKeyConfigFormat("gemini", {
        provider: "google",
        apiKey: "AIza" + "x".repeat(35),
      }),
    ).toBeNull();
  });
  it("rejects bedrock with single-char AWS region (length < 2)", () => {
    expect(
      validateBackendApiKeyConfigFormat("claude", {
        provider: "bedrock",
        authMode: "bearer_token",
        awsBearerTokenBedrock: "k",
        awsRegion: "x",
      }),
    ).toMatch(/AWS region/);
  });
  it("rejects bedrock with AWS region containing a space", () => {
    expect(
      validateBackendApiKeyConfigFormat("claude", {
        provider: "bedrock",
        authMode: "bearer_token",
        awsBearerTokenBedrock: "k",
        awsRegion: "us east-1",
      }),
    ).toMatch(/AWS region/);
  });
  it("rejects vertex with project id shorter than 4 chars", () => {
    expect(
      validateBackendApiKeyConfigFormat("claude", {
        provider: "vertex",
        projectId: "ab",
        region: "us-east5",
      }),
    ).toMatch(/GCP project id/);
  });
  it("rejects vertex with region shorter than 2 chars", () => {
    expect(
      validateBackendApiKeyConfigFormat("claude", {
        provider: "vertex",
        projectId: "valid-project",
        region: "x",
      }),
    ).toMatch(/Vertex region/);
  });
  it("rejects foundry with neither resource nor baseUrl (belt-and-suspenders check)", () => {
    expect(
      validateBackendApiKeyConfigFormat("claude", {
        provider: "foundry",
      } as never),
    ).toMatch(/either a resource name or a base URL/);
  });
  it("rejects foundry with non-http(s) baseUrl protocol", () => {
    expect(
      validateBackendApiKeyConfigFormat("claude", {
        provider: "foundry",
        baseUrl: "ftp://ftp.example.com",
      } as never),
    ).toMatch(/http\(s\)/);
  });
  it("rejects foundry with an unparseable baseUrl string", () => {
    expect(
      validateBackendApiKeyConfigFormat("claude", {
        provider: "foundry",
        baseUrl: "not-a-valid-url",
      } as never),
    ).toMatch(/not a valid URL/);
  });
  it("rejects gemini-vertex with project id shorter than 4 chars", () => {
    expect(
      validateBackendApiKeyConfigFormat("gemini", {
        provider: "gemini-vertex",
        authMode: "adc",
        projectId: "ab",
        location: "us-central1",
      }),
    ).toMatch(/GCP project id/);
  });
  it("rejects gemini-vertex with location shorter than 2 chars", () => {
    expect(
      validateBackendApiKeyConfigFormat("gemini", {
        provider: "gemini-vertex",
        authMode: "adc",
        projectId: "valid-project",
        location: "x",
      }),
    ).toMatch(/GCP location/);
  });
  it("rejects opencode-server with non-http(s) baseUrl protocol", () => {
    expect(
      validateBackendApiKeyConfigFormat("opencode", {
        provider: "opencode-server",
        baseUrl: "ftp://opencode.example.com",
        username: "opencode",
      }),
    ).toMatch(/http\(s\)/);
  });
  it("rejects opencode-server with an unparseable baseUrl", () => {
    expect(
      validateBackendApiKeyConfigFormat("opencode", {
        provider: "opencode-server",
        baseUrl: "not-a-valid-url",
        username: "opencode",
      }),
    ).toMatch(/not a valid URL/);
  });
  it("rejects opencode-server with an empty username (whitespace-only trims to empty)", () => {
    expect(
      validateBackendApiKeyConfigFormat("opencode", {
        provider: "opencode-server",
        baseUrl: "http://127.0.0.1:4096",
        username: "   ",
      }),
    ).toMatch(/username is required/);
  });
});

describe("isPlausibleOpenAiApiKey", () => {
  it("returns true for a key that does not start with sk-ant- and meets the length pattern", () => {
    expect(isPlausibleOpenAiApiKey("sk-" + "x".repeat(30))).toBe(true);
  });
  it("returns false for a key starting with sk-ant- (Anthropic key)", () => {
    expect(isPlausibleOpenAiApiKey("sk-ant-api03-" + "A".repeat(40))).toBe(false);
  });
  it("returns false for a too-short key that passes the sk-ant- guard but fails the length pattern", () => {
    expect(isPlausibleOpenAiApiKey("sk-short")).toBe(false);
  });
});

describe("getApiKeyEnvAssignments — Vertex vertexBaseUrl", () => {
  it("maps vertexBaseUrl to ANTHROPIC_VERTEX_BASE_URL", () => {
    const out = getApiKeyEnvAssignments({
      provider: "vertex",
      projectId: "p",
      region: "us-east5",
      vertexBaseUrl: "https://vertex.proxy.example.com",
    });
    expect(out.ANTHROPIC_VERTEX_BASE_URL).toBe("https://vertex.proxy.example.com");
    expect(out.CLAUDE_CODE_USE_VERTEX).toBe("1");
  });
});

describe("foundryApiKeyConfigSchema refine", () => {
  it("rejects when neither resource nor baseUrl is supplied", () => {
    const result = foundryApiKeyConfigSchema.safeParse({ provider: "foundry" });
    expect(result.success).toBe(false);
    if (!result.success) {
      const allMessages = result.error.issues.map((e) => e.message).join(" ");
      expect(allMessages).toContain("exactly one of");
    }
  });
  it("rejects when both resource and baseUrl are supplied", () => {
    const result = foundryApiKeyConfigSchema.safeParse({
      provider: "foundry",
      resource: "my-resource",
      baseUrl: "https://foo.azure.com/anthropic",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const allMessages = result.error.issues.map((e) => e.message).join(" ");
      expect(allMessages).toContain("exactly one of");
    }
  });
  it("accepts when only resource is supplied", () => {
    const result = foundryApiKeyConfigSchema.safeParse({
      provider: "foundry",
      resource: "my-resource",
    });
    expect(result.success).toBe(true);
  });
  it("accepts when only baseUrl is supplied", () => {
    const result = foundryApiKeyConfigSchema.safeParse({
      provider: "foundry",
      baseUrl: "https://foo.services.ai.azure.com/anthropic",
    });
    expect(result.success).toBe(true);
  });
});
