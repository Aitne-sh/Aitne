/**
 * Per-backend provider auth configuration.
 *
 * Direct API keys (Anthropic / OpenAI / Google) are the long-standing path,
 * but Claude Code's SDK also supports cloud-hosted Anthropic deployments,
 * and Gemini CLI supports Vertex AI:
 *
 * Claude Code:
 *  - Amazon Bedrock     → CLAUDE_CODE_USE_BEDROCK=1 + AWS creds (access key /
 *                         bearer token / profile) + AWS_REGION
 *  - Google Vertex AI   → CLAUDE_CODE_USE_VERTEX=1  + ANTHROPIC_VERTEX_PROJECT_ID +
 *                         CLOUD_ML_REGION (creds via Application Default
 *                         Credentials chain or GOOGLE_APPLICATION_CREDENTIALS file)
 *  - Microsoft Foundry  → CLAUDE_CODE_USE_FOUNDRY=1 + ANTHROPIC_FOUNDRY_RESOURCE
 *                         (or ANTHROPIC_FOUNDRY_BASE_URL) + optional
 *                         ANTHROPIC_FOUNDRY_API_KEY (Entra ID auto-fallback)
 *
 * Gemini CLI:
 *  - Vertex AI          → GOOGLE_GENAI_USE_VERTEXAI=true + GOOGLE_CLOUD_PROJECT +
 *                         GOOGLE_CLOUD_LOCATION (auth via ADC / service account
 *                         file / Vertex API key)
 *
 * Codex CLI's Azure OpenAI mode requires a `~/.codex/config.toml` file and is
 * NOT exposed through this surface — env-var mirroring is insufficient to
 * configure it. Codex stays direct-API-key only here.
 *
 * The daemon stores the chosen provider + its credentials as a single JSON
 * blob in the OS keychain (`backend.<id>.api_key`). At startup and on every
 * UI mutation the daemon mirrors the active provider's env vars into
 * `process.env`, so the unchanged Claude SDK / Codex CLI / Gemini CLI
 * subprocesses pick them up via the same inherited-env path.
 *
 * Backwards compatibility: legacy entries written before this feature were
 * raw strings (the API key itself). `parseBackendApiKeyConfig` accepts both
 * the new JSON shape and the legacy raw-string form.
 *
 * Env-var spec sources (verified 2026-05):
 *  - https://code.claude.com/docs/en/amazon-bedrock
 *  - https://code.claude.com/docs/en/google-vertex-ai
 *  - https://code.claude.com/docs/en/microsoft-foundry
 *  - https://geminicli.com/docs/get-started/authentication/
 */

import { z } from "zod";
import type { BackendId } from "./backend.js";

// ── Provider IDs per backend ─────────────────────────────────────────

export const CLAUDE_API_KEY_PROVIDERS = [
  "anthropic",
  "bedrock",
  "vertex",
  "foundry",
] as const;
export type ClaudeApiKeyProvider = (typeof CLAUDE_API_KEY_PROVIDERS)[number];

export const CODEX_API_KEY_PROVIDERS = ["openai", "azure-openai"] as const;
export type CodexApiKeyProvider = (typeof CODEX_API_KEY_PROVIDERS)[number];

export const GEMINI_API_KEY_PROVIDERS = ["google", "gemini-vertex"] as const;
export type GeminiApiKeyProvider = (typeof GEMINI_API_KEY_PROVIDERS)[number];

export const OPENCODE_API_KEY_PROVIDERS = ["opencode-server"] as const;
export type OpencodeApiKeyProvider = (typeof OPENCODE_API_KEY_PROVIDERS)[number];

export type ApiKeyProvider =
  | ClaudeApiKeyProvider
  | CodexApiKeyProvider
  | GeminiApiKeyProvider
  | OpencodeApiKeyProvider;

export const API_KEY_PROVIDERS_BY_BACKEND: Record<
  BackendId,
  readonly ApiKeyProvider[]
> = {
  claude: CLAUDE_API_KEY_PROVIDERS,
  codex: CODEX_API_KEY_PROVIDERS,
  gemini: GEMINI_API_KEY_PROVIDERS,
  opencode: OPENCODE_API_KEY_PROVIDERS,
};

export function defaultApiKeyProvider(backendId: BackendId): ApiKeyProvider {
  return API_KEY_PROVIDERS_BY_BACKEND[backendId][0];
}

export function isApiKeyProviderForBackend(
  backendId: BackendId,
  provider: string,
): provider is ApiKeyProvider {
  return (API_KEY_PROVIDERS_BY_BACKEND[backendId] as readonly string[]).includes(
    provider,
  );
}

// ── Discriminated config union ───────────────────────────────────────

export const anthropicApiKeyConfigSchema = z.object({
  provider: z.literal("anthropic"),
  apiKey: z.string().min(1),
});

/**
 * Bedrock supports three documented auth paths:
 *  - `access_key`   — AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY (+ optional
 *                     AWS_SESSION_TOKEN for STS / Identity Center)
 *  - `bearer_token` — AWS_BEARER_TOKEN_BEDROCK (Bedrock API key — simplest)
 *  - `profile`      — AWS_PROFILE (delegates to ~/.aws/config / ~/.aws/credentials)
 *
 * AWS_REGION is required by Claude Code regardless of the auth mode (the
 * docs explicitly say `Claude Code does not read from the .aws config
 * file for this setting`). `bedrockBaseUrl` is an optional override for
 * VPC endpoints / gateways.
 */
const bedrockAccessKeySchema = z.object({
  authMode: z.literal("access_key"),
  awsAccessKeyId: z.string().min(1),
  awsSecretAccessKey: z.string().min(1),
  awsSessionToken: z.string().min(1).optional(),
});
const bedrockBearerTokenSchema = z.object({
  authMode: z.literal("bearer_token"),
  awsBearerTokenBedrock: z.string().min(1),
});
const bedrockProfileSchema = z.object({
  authMode: z.literal("profile"),
  awsProfile: z.string().min(1),
});

/**
 * Per-provider model pinning fields. Setting any of these mirrors to the
 * `ANTHROPIC_DEFAULT_OPUS_MODEL` / `ANTHROPIC_DEFAULT_SONNET_MODEL` /
 * `ANTHROPIC_DEFAULT_HAIKU_MODEL` env vars so the `opus`/`sonnet`/`haiku`
 * aliases resolve to the cloud-native model ID instead of the latest
 * version (which may not be enabled in the customer's account, causing
 * a 404 or fallback at startup). The Anthropic docs explicitly call this
 * out as required for production deployments.
 *
 * The field shape is shared across Bedrock / Vertex / Foundry — only the
 * recommended *defaults* differ per cloud (see
 * `RECOMMENDED_PINNED_MODELS_BY_PROVIDER`).
 */
const pinnedModelsSchema = z.object({
  defaultOpusModel: z.string().min(1).optional(),
  defaultSonnetModel: z.string().min(1).optional(),
  defaultHaikuModel: z.string().min(1).optional(),
});
export type PinnedModelDefaults = z.infer<typeof pinnedModelsSchema>;

/**
 * Recommended model IDs per cloud. The dashboard pre-fills the pinning
 * fields with these values, but the operator can edit. Update these
 * alongside Anthropic's docs when a new model rolls out across all clouds.
 */
export const RECOMMENDED_PINNED_MODELS_BY_PROVIDER: Record<
  "bedrock" | "vertex" | "foundry",
  Required<PinnedModelDefaults>
> = {
  bedrock: {
    defaultOpusModel: "us.anthropic.claude-opus-4-7",
    defaultSonnetModel: "us.anthropic.claude-sonnet-4-6",
    defaultHaikuModel: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
  },
  vertex: {
    defaultOpusModel: "claude-opus-4-7",
    defaultSonnetModel: "claude-sonnet-4-6",
    defaultHaikuModel: "claude-haiku-4-5@20251001",
  },
  foundry: {
    defaultOpusModel: "claude-opus-4-7",
    defaultSonnetModel: "claude-sonnet-4-6",
    defaultHaikuModel: "claude-haiku-4-5",
  },
};

/**
 * Bedrock-specific extras: Mantle endpoint flag + optional overrides.
 * Mantle is an alternate Bedrock endpoint that uses the native Anthropic
 * API shape; setting both `CLAUDE_CODE_USE_BEDROCK=1` and
 * `CLAUDE_CODE_USE_MANTLE=1` is supported (Claude Code routes per-model).
 */
const bedrockExtrasSchema = z.object({
  bedrockBaseUrl: z.string().url().optional(),
  // Mantle endpoint
  useMantle: z.boolean().optional(),
  mantleBaseUrl: z.string().url().optional(),
  // Skip client-side auth (for gateways that inject AWS creds server-side)
  skipMantleAuth: z.boolean().optional(),
  // Per-model region override for the Haiku-class small/fast model
  smallFastModelAwsRegion: z.string().min(1).optional(),
});

export const bedrockApiKeyConfigSchema = z
  .discriminatedUnion("authMode", [
    bedrockAccessKeySchema,
    bedrockBearerTokenSchema,
    bedrockProfileSchema,
  ])
  .and(
    z.object({
      provider: z.literal("bedrock"),
      awsRegion: z.string().min(1),
    }),
  )
  .and(bedrockExtrasSchema)
  .and(pinnedModelsSchema);

export const vertexApiKeyConfigSchema = z
  .object({
    provider: z.literal("vertex"),
    projectId: z.string().min(1),
    region: z.string().min(1),
    // Optional file path for a service-account key file. Mirrors to
    // GOOGLE_APPLICATION_CREDENTIALS. When omitted, the SDK uses Application
    // Default Credentials (e.g. `gcloud auth application-default login`).
    // The previous `serviceAccountJson` (inline JSON) field was removed —
    // Anthropic's SDK does NOT read inline JSON; the env var is a file path.
    credentialsFile: z.string().min(1).optional(),
    vertexBaseUrl: z.string().url().optional(),
  })
  .and(pinnedModelsSchema);

/**
 * Foundry needs *one* of `resource` (the Azure resource name; daemon
 * routes to https://<resource>.services.ai.azure.com/anthropic) OR
 * `baseUrl` (the full URL). API key is **optional** — when omitted,
 * Claude Code uses the Azure DefaultAzureCredential chain (e.g. `az
 * login` / managed identity).
 */
export const foundryApiKeyConfigSchema = z
  .object({
    provider: z.literal("foundry"),
    resource: z.string().min(1).optional(),
    baseUrl: z.string().url().optional(),
    apiKey: z.string().min(1).optional(),
  })
  .and(pinnedModelsSchema)
  .refine(
    (v) => Boolean(v.resource) !== Boolean(v.baseUrl),
    {
      message:
        "Foundry config requires exactly one of `resource` or `baseUrl`.",
    },
  );

export const openaiApiKeyConfigSchema = z.object({
  provider: z.literal("openai"),
  apiKey: z.string().min(1),
});

/**
 * Codex CLI on Azure OpenAI. Codex CLI requires a `[model_providers.azure]`
 * block in `config.toml` — env vars alone are insufficient. The daemon
 * works around this by writing a managed `config.toml` to
 * `<PA_DATA_DIR>/codex-home/config.toml` and pointing `CODEX_HOME` at
 * that directory for spawned codex subprocesses, leaving the operator's
 * personal `~/.codex/` configuration untouched.
 *
 * Required: `resource` (Azure resource name) and `apiKey` (mirrored to
 * `AZURE_OPENAI_API_KEY`). Optional: `apiVersion` (defaults to the latest
 * preview version Codex docs recommend) and `deploymentName` — when set,
 * Codex's `model` setting is pinned to this deployment.
 *
 * **Known limitation: `--model` flag override.** The daemon's CodexCore
 * spawns Codex with `--model <id>` where `<id>` is the per-process
 * model from the registry (e.g. `gpt-5-codex`). On Azure, Codex treats
 * the model argument as the *deployment name*, so the operator MUST
 * name their Azure deployment to match the model IDs the daemon's
 * routing uses. Renaming the deployment in Azure is the supported fix;
 * a future round may plumb the active provider into CodexCore so the
 * daemon can rewrite `--model` automatically.
 */
export const DEFAULT_AZURE_OPENAI_API_VERSION = "2025-04-01-preview";

export const azureOpenAiApiKeyConfigSchema = z.object({
  provider: z.literal("azure-openai"),
  resource: z.string().min(1),
  apiKey: z.string().min(1),
  apiVersion: z.string().min(1).optional(),
  deploymentName: z.string().min(1).optional(),
});

export const googleApiKeyConfigSchema = z.object({
  provider: z.literal("google"),
  apiKey: z.string().min(1),
});

/**
 * Gemini CLI on Vertex AI. Three auth paths:
 *  - `adc`             — Application Default Credentials (gcloud)
 *  - `service_account` — GOOGLE_APPLICATION_CREDENTIALS file path
 *  - `api_key`         — GOOGLE_API_KEY (Vertex API key, distinct from
 *                        the direct `google` provider's GEMINI_API_KEY)
 *
 * `GOOGLE_CLOUD_PROJECT` + `GOOGLE_CLOUD_LOCATION` are required for all
 * three modes. `GOOGLE_GENAI_USE_VERTEXAI=true` flips the SDK to Vertex.
 */
const geminiVertexAdcSchema = z.object({ authMode: z.literal("adc") });
const geminiVertexServiceAccountSchema = z.object({
  authMode: z.literal("service_account"),
  credentialsFile: z.string().min(1),
});
const geminiVertexApiKeySchema = z.object({
  authMode: z.literal("api_key"),
  apiKey: z.string().min(1),
});

export const geminiVertexApiKeyConfigSchema = z
  .discriminatedUnion("authMode", [
    geminiVertexAdcSchema,
    geminiVertexServiceAccountSchema,
    geminiVertexApiKeySchema,
  ])
  .and(
    z.object({
      provider: z.literal("gemini-vertex"),
      projectId: z.string().min(1),
      location: z.string().min(1),
    }),
  );

export const opencodeServerApiKeyConfigSchema = z.object({
  provider: z.literal("opencode-server"),
  baseUrl: z.string().url(),
  username: z.string().min(1).default("opencode"),
  password: z.string().optional(),
});

export const backendApiKeyConfigSchema = z.union([
  anthropicApiKeyConfigSchema,
  bedrockApiKeyConfigSchema,
  vertexApiKeyConfigSchema,
  foundryApiKeyConfigSchema,
  openaiApiKeyConfigSchema,
  azureOpenAiApiKeyConfigSchema,
  googleApiKeyConfigSchema,
  geminiVertexApiKeyConfigSchema,
  opencodeServerApiKeyConfigSchema,
]);

export type AnthropicApiKeyConfig = z.infer<typeof anthropicApiKeyConfigSchema>;
export type BedrockApiKeyConfig = z.infer<typeof bedrockApiKeyConfigSchema>;
export type VertexApiKeyConfig = z.infer<typeof vertexApiKeyConfigSchema>;
export type FoundryApiKeyConfig = z.infer<typeof foundryApiKeyConfigSchema>;
export type OpenAiApiKeyConfig = z.infer<typeof openaiApiKeyConfigSchema>;
export type AzureOpenAiApiKeyConfig = z.infer<
  typeof azureOpenAiApiKeyConfigSchema
>;
export type GoogleApiKeyConfig = z.infer<typeof googleApiKeyConfigSchema>;
export type OpencodeServerApiKeyConfig = z.infer<
  typeof opencodeServerApiKeyConfigSchema
>;
export type BackendApiKeyConfig = z.infer<typeof backendApiKeyConfigSchema>;

// ── Env var management ───────────────────────────────────────────────

/**
 * Every env var the daemon may set or clear when mirroring auth state for a
 * backend. Returned as a stable list so `backend-api-key-env.ts` can snapshot
 * the operator's shell values once at startup and restore them on UI clear.
 *
 * The list is the **superset** across providers: switching from Anthropic to
 * Bedrock must clear `ANTHROPIC_API_KEY` and set `CLAUDE_CODE_USE_BEDROCK=1`
 * + AWS_*, so both must appear here even though they are never set together.
 */
export function getManagedApiKeyEnvVars(
  backendId: BackendId,
): readonly string[] {
  switch (backendId) {
    case "claude":
      return [
        "ANTHROPIC_API_KEY",
        // Bedrock — covers all three auth modes
        "CLAUDE_CODE_USE_BEDROCK",
        "AWS_REGION",
        "AWS_ACCESS_KEY_ID",
        "AWS_SECRET_ACCESS_KEY",
        "AWS_SESSION_TOKEN",
        "AWS_BEARER_TOKEN_BEDROCK",
        "AWS_PROFILE",
        "ANTHROPIC_BEDROCK_BASE_URL",
        // Bedrock Mantle endpoint
        "CLAUDE_CODE_USE_MANTLE",
        "ANTHROPIC_BEDROCK_MANTLE_BASE_URL",
        "CLAUDE_CODE_SKIP_MANTLE_AUTH",
        "ANTHROPIC_SMALL_FAST_MODEL_AWS_REGION",
        // Vertex
        "CLAUDE_CODE_USE_VERTEX",
        "ANTHROPIC_VERTEX_PROJECT_ID",
        "CLOUD_ML_REGION",
        "GOOGLE_APPLICATION_CREDENTIALS",
        "ANTHROPIC_VERTEX_BASE_URL",
        // Foundry
        "CLAUDE_CODE_USE_FOUNDRY",
        "ANTHROPIC_FOUNDRY_RESOURCE",
        "ANTHROPIC_FOUNDRY_BASE_URL",
        "ANTHROPIC_FOUNDRY_API_KEY",
        // Cloud-only model pinning (shared across Bedrock / Vertex / Foundry)
        "ANTHROPIC_DEFAULT_OPUS_MODEL",
        "ANTHROPIC_DEFAULT_SONNET_MODEL",
        "ANTHROPIC_DEFAULT_HAIKU_MODEL",
      ];
    case "codex":
      return [
        "OPENAI_API_KEY",
        // Azure OpenAI — daemon points CODEX_HOME at a managed config.toml
        // dir so the user's `~/.codex/` config is untouched.
        "AZURE_OPENAI_API_KEY",
        "CODEX_HOME",
      ];
    case "gemini":
      return [
        "GEMINI_API_KEY",
        "GOOGLE_API_KEY",
        // Vertex AI on Gemini CLI
        "GOOGLE_GENAI_USE_VERTEXAI",
        "GOOGLE_CLOUD_PROJECT",
        "GOOGLE_CLOUD_LOCATION",
        "GOOGLE_APPLICATION_CREDENTIALS",
      ];
    case "opencode":
      return [
        "OPENCODE_SERVER_USERNAME",
        "OPENCODE_SERVER_PASSWORD",
      ];
  }
}

/**
 * Map a partial set of pinned model fields to their `ANTHROPIC_DEFAULT_*_MODEL`
 * env vars. Skips any field the operator left unset so the cloud's built-in
 * default takes over (matching the docs' fallback semantics).
 */
function pinnedModelEnvAssignments(
  config: PinnedModelDefaults,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (config.defaultOpusModel) {
    out.ANTHROPIC_DEFAULT_OPUS_MODEL = config.defaultOpusModel;
  }
  if (config.defaultSonnetModel) {
    out.ANTHROPIC_DEFAULT_SONNET_MODEL = config.defaultSonnetModel;
  }
  if (config.defaultHaikuModel) {
    out.ANTHROPIC_DEFAULT_HAIKU_MODEL = config.defaultHaikuModel;
  }
  return out;
}

/**
 * Build the `config.toml` Codex CLI consumes when the daemon points
 * `CODEX_HOME` at the managed directory.
 *
 * Per OpenAI Codex docs (verified 2026-05), the wire_api must be
 * `responses` and the API version must be supplied as a `query_params`
 * entry. Codex resolves the API key by reading `env_key` against
 * `process.env`.
 *
 * **TOML layout matters.** `model_provider` (and `model`, when set) MUST
 * appear *before* the `[model_providers.azure]` table — once a `[section]`
 * header opens, all subsequent keys belong to that section until the next
 * header. Emitting `model_provider = "azure"` after the section header
 * would silently nest it as `model_providers.azure.model_provider`,
 * leaving the top-level `model_provider` unset and Codex routing through
 * the OpenAI default. Tested with `smol-toml`.
 */
export function buildCodexAzureConfigToml(
  config: AzureOpenAiApiKeyConfig,
): string {
  const apiVersion = config.apiVersion ?? DEFAULT_AZURE_OPENAI_API_VERSION;
  const baseUrl = `https://${config.resource}.openai.azure.com/openai/v1`;
  const lines: string[] = [
    "# Generated by aitne — do not edit by hand.",
    "# Source: dashboard provider-auth panel.",
    "",
    // Top-level keys FIRST. Keep these before any [section] header.
    `model_provider = "azure"`,
  ];
  if (config.deploymentName) {
    // Pin the active model to the operator's deployment name. Note:
    // when the daemon's CodexCore invokes codex with `--model <id>`,
    // the CLI flag overrides this. The operator should name their
    // Azure deployment to match the model IDs the daemon's process
    // routing maps to (see /settings/models).
    lines.push(`model = "${config.deploymentName}"`);
  }
  lines.push(
    "",
    "[model_providers.azure]",
    `name = "Azure OpenAI"`,
    `base_url = "${baseUrl}"`,
    `env_key = "AZURE_OPENAI_API_KEY"`,
    `query_params = { api-version = "${apiVersion}" }`,
    `wire_api = "responses"`,
    "",
  );
  return lines.join("\n");
}

/**
 * Resolve which env vars to write for a given provider config. Returns a map
 * of env-var name → value. Env vars omitted from the map should be cleared
 * (or restored to their captured shell value) by the caller.
 *
 * Note on `GOOGLE_APPLICATION_CREDENTIALS`: this is the Google standard env
 * var name and expects a **file path** (not inline JSON). The earlier
 * iteration of this code wrote `GOOGLE_APPLICATION_CREDENTIALS_JSON` with
 * inline JSON, which the Anthropic SDK and gcloud SDK both ignore. Operators
 * who want service-account-based auth supply the file path; operators who
 * want ADC leave it blank and use `gcloud auth application-default login`.
 *
 * Note on `CODEX_HOME` (Azure OpenAI): this map does NOT include it. The
 * daemon owns the managed config.toml directory path and adds `CODEX_HOME`
 * separately when materializing the assignment — see the daemon-side
 * `materializeCodexAzureConfig` helper.
 */
export function getApiKeyEnvAssignments(
  config: BackendApiKeyConfig,
): Record<string, string> {
  switch (config.provider) {
    case "anthropic":
      return { ANTHROPIC_API_KEY: config.apiKey };

    case "bedrock": {
      const base: Record<string, string> = {
        CLAUDE_CODE_USE_BEDROCK: "1",
        AWS_REGION: config.awsRegion,
        ...(config.bedrockBaseUrl
          ? { ANTHROPIC_BEDROCK_BASE_URL: config.bedrockBaseUrl }
          : {}),
        // Mantle endpoint (set alongside CLAUDE_CODE_USE_BEDROCK — they're
        // not mutually exclusive: setting both lets Claude Code route per
        // model, sending Mantle-format IDs to Mantle and Invoke-API IDs
        // to standard Bedrock).
        ...(config.useMantle ? { CLAUDE_CODE_USE_MANTLE: "1" } : {}),
        ...(config.mantleBaseUrl
          ? { ANTHROPIC_BEDROCK_MANTLE_BASE_URL: config.mantleBaseUrl }
          : {}),
        ...(config.skipMantleAuth ? { CLAUDE_CODE_SKIP_MANTLE_AUTH: "1" } : {}),
        ...(config.smallFastModelAwsRegion
          ? {
              ANTHROPIC_SMALL_FAST_MODEL_AWS_REGION:
                config.smallFastModelAwsRegion,
            }
          : {}),
        ...pinnedModelEnvAssignments(config),
      };
      switch (config.authMode) {
        case "access_key":
          return {
            ...base,
            AWS_ACCESS_KEY_ID: config.awsAccessKeyId,
            AWS_SECRET_ACCESS_KEY: config.awsSecretAccessKey,
            ...(config.awsSessionToken
              ? { AWS_SESSION_TOKEN: config.awsSessionToken }
              : {}),
          };
        case "bearer_token":
          return {
            ...base,
            AWS_BEARER_TOKEN_BEDROCK: config.awsBearerTokenBedrock,
          };
        case "profile":
          return { ...base, AWS_PROFILE: config.awsProfile };
        /* v8 ignore next 6 */
      }
      // Exhaustiveness guard — TS verifies all authMode branches are covered.
      const _exhaustive: never = config;
      void _exhaustive;
      return base;
    }

    case "vertex":
      return {
        CLAUDE_CODE_USE_VERTEX: "1",
        ANTHROPIC_VERTEX_PROJECT_ID: config.projectId,
        CLOUD_ML_REGION: config.region,
        ...(config.credentialsFile
          ? { GOOGLE_APPLICATION_CREDENTIALS: config.credentialsFile }
          : {}),
        ...(config.vertexBaseUrl
          ? { ANTHROPIC_VERTEX_BASE_URL: config.vertexBaseUrl }
          : {}),
        ...pinnedModelEnvAssignments(config),
      };

    case "foundry":
      return {
        CLAUDE_CODE_USE_FOUNDRY: "1",
        ...(config.resource
          ? { ANTHROPIC_FOUNDRY_RESOURCE: config.resource }
          : {}),
        ...(config.baseUrl
          ? { ANTHROPIC_FOUNDRY_BASE_URL: config.baseUrl }
          : {}),
        ...(config.apiKey
          ? { ANTHROPIC_FOUNDRY_API_KEY: config.apiKey }
          : {}),
        ...pinnedModelEnvAssignments(config),
      };

    case "openai":
      return { OPENAI_API_KEY: config.apiKey };

    case "azure-openai":
      // CODEX_HOME is owned by the daemon (it points at the managed
      // config.toml directory). The daemon's Codex Azure materializer
      // computes the path and adds CODEX_HOME alongside this map; the
      // pure shared layer just provides the env vars Codex CLI itself
      // needs at runtime to fetch credentials.
      return {
        AZURE_OPENAI_API_KEY: config.apiKey,
      };

    case "google":
      // Direct Gemini API — populates BOTH aliases so the SDK reads a
      // consistent value. Notably this does NOT set the Vertex flag.
      return {
        GEMINI_API_KEY: config.apiKey,
        GOOGLE_API_KEY: config.apiKey,
      };

    case "gemini-vertex": {
      const base: Record<string, string> = {
        GOOGLE_GENAI_USE_VERTEXAI: "true",
        GOOGLE_CLOUD_PROJECT: config.projectId,
        GOOGLE_CLOUD_LOCATION: config.location,
      };
      switch (config.authMode) {
        case "adc":
          return base;
        case "service_account":
          return {
            ...base,
            GOOGLE_APPLICATION_CREDENTIALS: config.credentialsFile,
          };
        case "api_key":
          // Vertex API-key auth uses GOOGLE_API_KEY (not GEMINI_API_KEY).
          return { ...base, GOOGLE_API_KEY: config.apiKey };
        /* v8 ignore next 6 */
      }
      // Exhaustiveness guard — TS verifies all authMode branches are covered.
      const _exhaustive: never = config;
      void _exhaustive;
      return base;
    }

    case "opencode-server":
      return {
        ...(config.username
          ? { OPENCODE_SERVER_USERNAME: config.username }
          : {}),
        ...(config.password
          ? { OPENCODE_SERVER_PASSWORD: config.password }
          : {}),
      };
  }
}

// ── Parse / serialize ────────────────────────────────────────────────

/**
 * Decode the raw keychain string for a backend into a typed config.
 *
 * Three accepted forms (highest priority first):
 *   1. JSON-encoded `BackendApiKeyConfig` — the new format.
 *   2. Legacy raw API key (non-JSON string) — promoted to the backend's
 *      default direct provider (anthropic / openai / google).
 *   3. `null` / blank — no config.
 */
export function parseBackendApiKeyConfig(
  backendId: BackendId,
  raw: string | null | undefined,
): BackendApiKeyConfig | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // New format: JSON-encoded discriminated union.
  if (trimmed.startsWith("{")) {
    try {
      const parsed = backendApiKeyConfigSchema.safeParse(JSON.parse(trimmed));
      if (
        parsed.success
        && isApiKeyProviderForBackend(backendId, parsed.data.provider)
      ) {
        return parsed.data;
      }
      return null;
    } catch {
      return null;
    }
  }

  // Legacy raw API key — promote to the default direct provider for the
  // backend. This keeps existing keychain entries working byte-for-byte.
  switch (backendId) {
    case "claude":
      return { provider: "anthropic", apiKey: trimmed };
    case "codex":
      return { provider: "openai", apiKey: trimmed };
    case "gemini":
      return { provider: "google", apiKey: trimmed };
    case "opencode":
      return null;
  }
}

/** Encode a typed config back into the JSON form stored in the keychain. */
export function serializeBackendApiKeyConfig(
  config: BackendApiKeyConfig,
): string {
  return JSON.stringify(config);
}

// ── Format validation ────────────────────────────────────────────────

const ANTHROPIC_KEY_PATTERN = /^sk-ant-[A-Za-z0-9_-]{20,}$/;
const OPENAI_KEY_PATTERN = /^sk-[A-Za-z0-9_-]{30,}$/;
const GEMINI_KEY_PATTERN = /^AIza[0-9A-Za-z_-]{35}$/;

export function isPlausibleAnthropicApiKey(value: string): boolean {
  return ANTHROPIC_KEY_PATTERN.test(value.trim());
}

export function isPlausibleOpenAiApiKey(value: string): boolean {
  const trimmed = value.trim();
  if (/^sk-ant-/.test(trimmed)) return false;
  return OPENAI_KEY_PATTERN.test(trimmed);
}

export function isPlausibleGeminiApiKey(value: string): boolean {
  return GEMINI_KEY_PATTERN.test(value.trim());
}

/**
 * Best-effort format check on a populated config. Returns null when the
 * shape looks plausible, or a human-readable hint when something obvious
 * is wrong. Server-side probes are still authoritative — this catches
 * cheap typos before the keychain write.
 */
export function validateBackendApiKeyConfigFormat(
  backendId: BackendId,
  config: BackendApiKeyConfig,
): string | null {
  if (!isApiKeyProviderForBackend(backendId, config.provider)) {
    return `Provider "${config.provider}" is not valid for the ${backendId} backend.`;
  }
  switch (config.provider) {
    case "anthropic":
      if (!isPlausibleAnthropicApiKey(config.apiKey)) {
        return "Expected an Anthropic API key beginning with `sk-ant-…`.";
      }
      return null;
    case "openai":
      if (!isPlausibleOpenAiApiKey(config.apiKey)) {
        return "Expected an OpenAI API key beginning with `sk-…` (not `sk-ant-…`).";
      }
      return null;
    case "azure-openai":
      if (!config.resource.trim() || /\s/.test(config.resource)) {
        return "Azure resource name looks malformed (no spaces; e.g. `my-foundry-resource`).";
      }
      if (!config.apiKey.trim()) {
        return "Azure OpenAI API key is required.";
      }
      return null;
    case "google":
      if (!isPlausibleGeminiApiKey(config.apiKey)) {
        return "Expected a Google API key beginning with `AIza…` (39 chars total).";
      }
      return null;
    case "bedrock": {
      if (config.awsRegion.length < 2 || /\s/.test(config.awsRegion)) {
        return "AWS region looks malformed (e.g. expected `us-east-1`).";
      }
      if (config.authMode === "access_key") {
        if (!/^[A-Z0-9]{16,}$/.test(config.awsAccessKeyId)) {
          return "AWS access key id should be uppercase alphanumeric (≥ 16 chars, e.g. `AKIA…` or `ASIA…`).";
        }
      }
      return null;
    }
    case "vertex":
      if (config.projectId.length < 4 || /\s/.test(config.projectId)) {
        return "GCP project id looks malformed.";
      }
      if (config.region.length < 2 || /\s/.test(config.region)) {
        return "Vertex region looks malformed (e.g. `us-east5`, `global`, or `eu`).";
      }
      return null;
    case "foundry": {
      if (!config.resource && !config.baseUrl) {
        return "Foundry config requires either a resource name or a base URL.";
      }
      if (config.resource && config.baseUrl) {
        return "Foundry config: set EITHER `resource` OR `baseUrl`, not both.";
      }
      if (config.baseUrl) {
        try {
          const url = new URL(config.baseUrl);
          if (url.protocol !== "https:" && url.protocol !== "http:") {
            return "Foundry base URL must be an http(s) URL.";
          }
        } catch {
          return "Foundry base URL is not a valid URL.";
        }
      }
      return null;
    }
    case "gemini-vertex": {
      if (config.projectId.length < 4 || /\s/.test(config.projectId)) {
        return "GCP project id looks malformed.";
      }
      if (config.location.length < 2 || /\s/.test(config.location)) {
        return "GCP location looks malformed (e.g. `us-central1`).";
      }
      if (
        config.authMode === "api_key"
        && !isPlausibleGeminiApiKey(config.apiKey)
      ) {
        return "Vertex API key should start with `AIza…` (39 chars total).";
      }
      return null;
    }
    case "opencode-server": {
      try {
        const url = new URL(config.baseUrl);
        if (url.protocol !== "http:" && url.protocol !== "https:") {
          return "OpenCode server URL must be an http(s) URL.";
        }
      } catch {
        return "OpenCode server URL is not a valid URL.";
      }
      if (!config.username.trim()) {
        return "OpenCode server username is required.";
      }
      return null;
    }
  }
}
