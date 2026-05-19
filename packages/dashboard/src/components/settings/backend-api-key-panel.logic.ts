/**
 * Pure logic helpers for `BackendApiKeyPanel`. Mirrors the Zod schemas
 * from `@aitne/shared` so the dashboard can preview format
 * issues before round-tripping to the daemon.
 *
 * The daemon is the source of truth — even a format-valid config may be
 * rejected by the provider's runtime auth check. The panel surfaces both
 * layers: client-side rejection for cheap typos, server-side detail for
 * the rest.
 */

import {
  defaultApiKeyProvider,
  DEFAULT_AZURE_OPENAI_API_VERSION,
  isPlausibleAnthropicApiKey,
  isPlausibleGeminiApiKey,
  isPlausibleOpenAiApiKey,
  RECOMMENDED_PINNED_MODELS_BY_PROVIDER,
  validateBackendApiKeyConfigFormat,
  type ApiKeyProvider,
  type BackendApiKeyConfig,
  type BackendId,
} from "@aitne/shared";

export type ApiKeySource = "keychain" | "shell" | "none";

// Re-exports so existing dashboard tests / callers keep their import
// surface stable while the implementation is sourced from shared.
export {
  isPlausibleAnthropicApiKey,
  isPlausibleOpenAiApiKey,
  isPlausibleGeminiApiKey,
};

/**
 * Direct-API-key plausibility check used by the legacy single-field
 * form (provider === default direct provider for the backend).
 */
export function isPlausibleApiKey(
  backendId: BackendId,
  value: string,
): boolean {
  switch (defaultApiKeyProvider(backendId)) {
    case "anthropic":
      return isPlausibleAnthropicApiKey(value);
    case "openai":
      return isPlausibleOpenAiApiKey(value);
    case "google":
      return isPlausibleGeminiApiKey(value);
    default:
      return false;
  }
}

/** Hint text shown beneath the direct-API-key input field. */
export function apiKeyFormatHint(backendId: BackendId): string {
  switch (defaultApiKeyProvider(backendId)) {
    case "anthropic":
      return "Anthropic key — starts with `sk-ant-…`.";
    case "openai":
      return "OpenAI key — starts with `sk-…` (not `sk-ant-…`).";
    case "google":
      return "Google API key — starts with `AIza…`, 39 chars total.";
    default:
      return "API key";
  }
}

/** Env var names the daemon will populate when a direct key is saved. */
export function apiKeyEnvVarNames(backendId: BackendId): readonly string[] {
  switch (backendId) {
    case "claude":
      return ["ANTHROPIC_API_KEY"];
    case "codex":
      return ["OPENAI_API_KEY"];
    case "gemini":
      return ["GEMINI_API_KEY", "GOOGLE_API_KEY"];
    case "opencode":
      return ["OPENCODE_SERVER_PASSWORD"];
  }
}

export function apiKeyStatusLabel(source: ApiKeySource): string {
  switch (source) {
    case "keychain":
      return "API key configured (stored in OS keychain).";
    case "shell":
      return "Using API key from shell environment. Save a key here to override.";
    case "none":
      return "No API key configured. Falling back to CLI login / OAuth.";
  }
}

/** Whether the Save button should be enabled for the legacy direct form. */
export function isSaveEnabled(opts: {
  backendId: BackendId;
  draftValue: string;
  saving: boolean;
}): boolean {
  if (opts.saving) return false;
  const trimmed = opts.draftValue.trim();
  if (!trimmed) return false;
  return isPlausibleApiKey(opts.backendId, trimmed);
}

export function isClearVisible(source: ApiKeySource): boolean {
  return source === "keychain";
}

// ── Provider metadata ──────────────────────────────────────────────

export const PROVIDER_LABELS: Record<ApiKeyProvider, string> = {
  anthropic: "Anthropic API key",
  bedrock: "Amazon Bedrock",
  vertex: "Google Vertex AI",
  foundry: "Microsoft Foundry",
  openai: "OpenAI API key",
  "azure-openai": "Azure OpenAI",
  google: "Google API key",
  "gemini-vertex": "Google Vertex AI",
  "opencode-server": "OpenCode server",
};

export const PROVIDER_DESCRIPTIONS: Record<ApiKeyProvider, string> = {
  anthropic:
    "Direct Anthropic API key (`sk-ant-…`). Stored in the OS keychain and mirrored to `ANTHROPIC_API_KEY`.",
  bedrock:
    "Anthropic models on Amazon Bedrock. Sets `CLAUDE_CODE_USE_BEDROCK=1` plus AWS credentials. Required: `AWS_REGION`.",
  vertex:
    "Anthropic models on Google Vertex AI. Sets `CLAUDE_CODE_USE_VERTEX=1` plus GCP project / region. Auth via Application Default Credentials or a service-account key file.",
  foundry:
    "Anthropic models on Microsoft Foundry. Sets `CLAUDE_CODE_USE_FOUNDRY=1` plus the Foundry resource (or full base URL). API key optional — falls back to Azure DefaultAzureCredential (`az login`).",
  openai:
    "OpenAI API key (`sk-…`). Stored in the keychain and mirrored to `OPENAI_API_KEY`.",
  "azure-openai":
    "Codex CLI on Azure OpenAI. Daemon writes a managed `config.toml` to `<dataDir>/codex-home/` and points `CODEX_HOME` there — your personal `~/.codex/` is untouched. Sets `AZURE_OPENAI_API_KEY`. **Important:** the daemon spawns codex with `--model <id>` from the model registry, which Codex treats as the deployment name on Azure. Name your Azure deployments to match the model IDs shown on the /settings/models page (e.g. `gpt-5-codex`).",
  google:
    "Direct Gemini API key (`AIza…`). Mirrored to `GEMINI_API_KEY` + `GOOGLE_API_KEY`.",
  "gemini-vertex":
    "Gemini on Google Vertex AI. Sets `GOOGLE_GENAI_USE_VERTEXAI=true` plus GCP project / location. Auth via ADC, a service-account key file, or a Vertex API key.",
  "opencode-server":
    "OpenCode server authentication. Stores the server URL, username, and optional password; the daemon mirrors username/password into OpenCode server env vars.",
};

// ── Drafts (form state) ────────────────────────────────────────────

/** Common pinned-model fields shared by all three Anthropic-cloud forms. */
interface PinnedModelDraftFields {
  defaultOpusModel: string;
  defaultSonnetModel: string;
  defaultHaikuModel: string;
}

export type ProviderDraft =
  | { provider: "anthropic"; apiKey: string }
  | ({
      provider: "bedrock";
      authMode: "access_key";
      awsAccessKeyId: string;
      awsSecretAccessKey: string;
      awsSessionToken: string;
      awsRegion: string;
      bedrockBaseUrl: string;
      // Mantle endpoint (optional)
      useMantle: boolean;
      mantleBaseUrl: string;
      skipMantleAuth: boolean;
    } & PinnedModelDraftFields)
  | ({
      provider: "bedrock";
      authMode: "bearer_token";
      awsBearerTokenBedrock: string;
      awsRegion: string;
      bedrockBaseUrl: string;
      useMantle: boolean;
      mantleBaseUrl: string;
      skipMantleAuth: boolean;
    } & PinnedModelDraftFields)
  | ({
      provider: "bedrock";
      authMode: "profile";
      awsProfile: string;
      awsRegion: string;
      bedrockBaseUrl: string;
      useMantle: boolean;
      mantleBaseUrl: string;
      skipMantleAuth: boolean;
    } & PinnedModelDraftFields)
  | ({
      provider: "vertex";
      projectId: string;
      region: string;
      credentialsFile: string;
      vertexBaseUrl: string;
    } & PinnedModelDraftFields)
  | ({
      provider: "foundry";
      endpointKind: "resource" | "base_url";
      resource: string;
      baseUrl: string;
      apiKey: string;
    } & PinnedModelDraftFields)
  | { provider: "openai"; apiKey: string }
  | {
      provider: "azure-openai";
      resource: string;
      apiKey: string;
      apiVersion: string;
      deploymentName: string;
    }
  | { provider: "google"; apiKey: string }
  | {
      provider: "gemini-vertex";
      authMode: "adc";
      projectId: string;
      location: string;
    }
  | {
      provider: "gemini-vertex";
      authMode: "service_account";
      projectId: string;
      location: string;
      credentialsFile: string;
    }
  | {
      provider: "gemini-vertex";
      authMode: "api_key";
      projectId: string;
      location: string;
      apiKey: string;
    }
  | {
      provider: "opencode-server";
      baseUrl: string;
      username: string;
      password: string;
    };

export type BedrockAuthMode = "access_key" | "bearer_token" | "profile";
export type GeminiVertexAuthMode = "adc" | "service_account" | "api_key";

/** Build the recommended-defaults seed for the pinned-model fields. */
function pinnedDefaults(provider: "bedrock" | "vertex" | "foundry"): PinnedModelDraftFields {
  const r = RECOMMENDED_PINNED_MODELS_BY_PROVIDER[provider];
  return {
    defaultOpusModel: r.defaultOpusModel,
    defaultSonnetModel: r.defaultSonnetModel,
    defaultHaikuModel: r.defaultHaikuModel,
  };
}

const EMPTY_MANTLE_FIELDS = {
  useMantle: false,
  mantleBaseUrl: "",
  skipMantleAuth: false,
};

export function emptyDraft(provider: ApiKeyProvider): ProviderDraft {
  switch (provider) {
    case "anthropic":
      return { provider: "anthropic", apiKey: "" };
    case "bedrock":
      return emptyBedrockDraft("access_key");
    case "vertex":
      return {
        provider: "vertex",
        projectId: "",
        region: "",
        credentialsFile: "",
        vertexBaseUrl: "",
        ...pinnedDefaults("vertex"),
      };
    case "foundry":
      return {
        provider: "foundry",
        endpointKind: "resource",
        resource: "",
        baseUrl: "",
        apiKey: "",
        ...pinnedDefaults("foundry"),
      };
    case "openai":
      return { provider: "openai", apiKey: "" };
    case "azure-openai":
      return {
        provider: "azure-openai",
        resource: "",
        apiKey: "",
        apiVersion: DEFAULT_AZURE_OPENAI_API_VERSION,
        deploymentName: "",
      };
    case "google":
      return { provider: "google", apiKey: "" };
    case "gemini-vertex":
      return emptyGeminiVertexDraft("adc");
    case "opencode-server":
      return {
        provider: "opencode-server",
        baseUrl: "http://127.0.0.1:4096",
        username: "opencode",
        password: "",
      };
  }
}

export function emptyBedrockDraft(mode: BedrockAuthMode): ProviderDraft {
  const baseShared = {
    awsRegion: "",
    bedrockBaseUrl: "",
    ...EMPTY_MANTLE_FIELDS,
    ...pinnedDefaults("bedrock"),
  };
  switch (mode) {
    case "access_key":
      return {
        provider: "bedrock",
        authMode: "access_key",
        awsAccessKeyId: "",
        awsSecretAccessKey: "",
        awsSessionToken: "",
        ...baseShared,
      };
    case "bearer_token":
      return {
        provider: "bedrock",
        authMode: "bearer_token",
        awsBearerTokenBedrock: "",
        ...baseShared,
      };
    case "profile":
      return {
        provider: "bedrock",
        authMode: "profile",
        awsProfile: "",
        ...baseShared,
      };
  }
}

export function emptyGeminiVertexDraft(
  mode: GeminiVertexAuthMode,
): ProviderDraft {
  const base = { projectId: "", location: "" };
  switch (mode) {
    case "adc":
      return { provider: "gemini-vertex", authMode: "adc", ...base };
    case "service_account":
      return {
        provider: "gemini-vertex",
        authMode: "service_account",
        credentialsFile: "",
        ...base,
      };
    case "api_key":
      return {
        provider: "gemini-vertex",
        authMode: "api_key",
        apiKey: "",
        ...base,
      };
  }
}

/**
 * Build a typed config from the panel draft, dropping optional fields
 * that the operator left blank. Returns null when required fields are
 * missing (the Save button stays disabled in that state).
 */
/**
 * Strip the pinned-model draft fields into the schema's optional shape.
 * Treats blank values as "leave the cloud's built-in default" by omitting
 * the field entirely (so we don't push empty-string env vars).
 */
function pinnedFromDraft(draft: PinnedModelDraftFields): {
  defaultOpusModel?: string;
  defaultSonnetModel?: string;
  defaultHaikuModel?: string;
} {
  const out: {
    defaultOpusModel?: string;
    defaultSonnetModel?: string;
    defaultHaikuModel?: string;
  } = {};
  if (draft.defaultOpusModel.trim()) {
    out.defaultOpusModel = draft.defaultOpusModel.trim();
  }
  if (draft.defaultSonnetModel.trim()) {
    out.defaultSonnetModel = draft.defaultSonnetModel.trim();
  }
  if (draft.defaultHaikuModel.trim()) {
    out.defaultHaikuModel = draft.defaultHaikuModel.trim();
  }
  return out;
}

export function draftToConfig(
  draft: ProviderDraft,
): BackendApiKeyConfig | null {
  switch (draft.provider) {
    case "anthropic":
      if (!draft.apiKey.trim()) return null;
      return { provider: "anthropic", apiKey: draft.apiKey.trim() };
    case "bedrock": {
      const region = draft.awsRegion.trim();
      if (!region) return null;
      const baseUrl = draft.bedrockBaseUrl.trim();
      const baseUrlField = baseUrl ? { bedrockBaseUrl: baseUrl } : {};
      const mantleFields = {
        ...(draft.useMantle ? { useMantle: true } : {}),
        ...(draft.mantleBaseUrl.trim()
          ? { mantleBaseUrl: draft.mantleBaseUrl.trim() }
          : {}),
        ...(draft.skipMantleAuth ? { skipMantleAuth: true } : {}),
      };
      const pinned = pinnedFromDraft(draft);
      switch (draft.authMode) {
        case "access_key": {
          if (
            !draft.awsAccessKeyId.trim()
            || !draft.awsSecretAccessKey.trim()
          ) {
            return null;
          }
          return {
            provider: "bedrock",
            authMode: "access_key",
            awsAccessKeyId: draft.awsAccessKeyId.trim(),
            awsSecretAccessKey: draft.awsSecretAccessKey.trim(),
            ...(draft.awsSessionToken.trim()
              ? { awsSessionToken: draft.awsSessionToken.trim() }
              : {}),
            awsRegion: region,
            ...baseUrlField,
            ...mantleFields,
            ...pinned,
          };
        }
        case "bearer_token":
          if (!draft.awsBearerTokenBedrock.trim()) return null;
          return {
            provider: "bedrock",
            authMode: "bearer_token",
            awsBearerTokenBedrock: draft.awsBearerTokenBedrock.trim(),
            awsRegion: region,
            ...baseUrlField,
            ...mantleFields,
            ...pinned,
          };
        case "profile":
          if (!draft.awsProfile.trim()) return null;
          return {
            provider: "bedrock",
            authMode: "profile",
            awsProfile: draft.awsProfile.trim(),
            awsRegion: region,
            ...baseUrlField,
            ...mantleFields,
            ...pinned,
          };
      }
      return null;
    }
    case "vertex": {
      if (!draft.projectId.trim() || !draft.region.trim()) return null;
      return {
        provider: "vertex",
        projectId: draft.projectId.trim(),
        region: draft.region.trim(),
        ...(draft.credentialsFile.trim()
          ? { credentialsFile: draft.credentialsFile.trim() }
          : {}),
        ...(draft.vertexBaseUrl.trim()
          ? { vertexBaseUrl: draft.vertexBaseUrl.trim() }
          : {}),
        ...pinnedFromDraft(draft),
      };
    }
    case "foundry": {
      const resource = draft.resource.trim();
      const baseUrl = draft.baseUrl.trim();
      const apiKey = draft.apiKey.trim();
      const pinned = pinnedFromDraft(draft);
      if (draft.endpointKind === "resource") {
        if (!resource) return null;
        return {
          provider: "foundry",
          resource,
          ...(apiKey ? { apiKey } : {}),
          ...pinned,
        };
      }
      if (!baseUrl) return null;
      return {
        provider: "foundry",
        baseUrl,
        ...(apiKey ? { apiKey } : {}),
        ...pinned,
      };
    }
    case "openai":
      if (!draft.apiKey.trim()) return null;
      return { provider: "openai", apiKey: draft.apiKey.trim() };
    case "azure-openai": {
      const resource = draft.resource.trim();
      const apiKey = draft.apiKey.trim();
      if (!resource || !apiKey) return null;
      return {
        provider: "azure-openai",
        resource,
        apiKey,
        ...(draft.apiVersion.trim()
          ? { apiVersion: draft.apiVersion.trim() }
          : {}),
        ...(draft.deploymentName.trim()
          ? { deploymentName: draft.deploymentName.trim() }
          : {}),
      };
    }
    case "google":
      if (!draft.apiKey.trim()) return null;
      return { provider: "google", apiKey: draft.apiKey.trim() };
    case "gemini-vertex": {
      const projectId = draft.projectId.trim();
      const location = draft.location.trim();
      if (!projectId || !location) return null;
      switch (draft.authMode) {
        case "adc":
          return {
            provider: "gemini-vertex",
            authMode: "adc",
            projectId,
            location,
          };
        case "service_account":
          if (!draft.credentialsFile.trim()) return null;
          return {
            provider: "gemini-vertex",
            authMode: "service_account",
            projectId,
            location,
            credentialsFile: draft.credentialsFile.trim(),
          };
        case "api_key":
          if (!draft.apiKey.trim()) return null;
          return {
            provider: "gemini-vertex",
            authMode: "api_key",
            projectId,
            location,
            apiKey: draft.apiKey.trim(),
          };
      }
      return null;
    }
    case "opencode-server": {
      const baseUrl = draft.baseUrl.trim();
      const username = draft.username.trim();
      const password = draft.password.trim();
      if (!baseUrl || !username) return null;
      return {
        provider: "opencode-server",
        baseUrl,
        username,
        ...(password ? { password } : {}),
      };
    }
  }
}

/**
 * Whether the cloud-provider Save button should be enabled. Requires
 * all required fields populated, valid format, and no in-flight save.
 */
export function isConfigSaveEnabled(opts: {
  backendId: BackendId;
  draft: ProviderDraft;
  saving: boolean;
}): boolean {
  if (opts.saving) return false;
  const config = draftToConfig(opts.draft);
  if (!config) return false;
  return validateBackendApiKeyConfigFormat(opts.backendId, config) === null;
}

/** True when a provider is the legacy single-API-key form, false when it
 *  needs the multi-field cloud form. Drives which form to render. */
export function isDirectApiKeyProvider(provider: ApiKeyProvider): boolean {
  return (
    provider === "anthropic" || provider === "openai" || provider === "google"
  );
}
