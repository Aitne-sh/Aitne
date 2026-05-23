import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { applySchema } from "../db/schema.js";
import { createApp, type ApiDependencies } from "./server.js";
import type { AgentConfig } from "../config.js";
import { createServiceRegistry } from "../services/service-registry.js";
import { SecretBroker } from "../secrets/secret-broker.js";
import type { SecretStore } from "../secrets/secret-store.js";
import type { StoredSecretName } from "../secrets/secret-names.js";
import { DEFAULT_DISALLOWED_TOOLS } from "../settings/runtime-settings.js";
import type { IAgentCore } from "../core/agent-core.js";
import { getSessionWorkdirPath } from "../core/workdir.js";
import { DEFAULT_AGENT_DISPLAY_NAME } from "@aitne/shared";
import type { AgentResult, BackendModel } from "@aitne/shared";

vi.mock("googleapis", () => ({
  google: {
    auth: {
      OAuth2: class MockOAuth2 {
        generateAuthUrl(params: { state?: string }) {
          return `https://accounts.example.test/o/oauth2/auth?state=${params.state ?? ""}`;
        }
      },
    },
  },
}));

function makeConfig(dataDir: string): AgentConfig {
  return {
    dataDir,
    workspaceDir: ".",
    apiPort: 8321,
    slackOwnerUserId: null,
    telegramOwnerChatId: null,
    discordOwnerUserId: null,
    whatsappEnabled: false,
    whatsappOwnerPhone: null,
    whatsappAuthDir: null,
    googleCalendarId: "primary",
    notionDatabaseIds: {},
    primaryVaultPath: null,
    primaryVaultName: null,
    externalObsidianVaultPath: null,
    externalObsidianVaultName: null,
    gitRepos: [],
    maxConcurrentSessions: 3,
    maxReactiveSessions: 2,
    executeTimeoutMinutes: 60,
    agentDisplayName: DEFAULT_AGENT_DISPLAY_NAME,
    sessionTimeoutDmMinutes: 60,
    sessionTimeoutChannelMinutes: 30,
    sessionTimeoutDashboardMinutes: 120,
    character: "",
    historyInjectionMaxMessages: 20,
    historyInjectionMaxTokens: 4000,
    historyOtherSurfaceWindowMinutes: 1440,
    dmStalenessStrict: false,
    timezone: "",
    dayBoundaryHour: 4,
    hourlyCheckEnabled: true,
    hourlyCheckIntervalMinutes: 60,
    hourlyCheckActiveStartHour: 4,
    hourlyCheckActiveEndHour: 24,
    hourlyCheckMinObservations: 1,
    authProbeDisabled: false,
    authPreflightFreshnessMs: 600000,
    schedulePollIntervalSeconds: 5,
    maxNotificationsPerHour: 3,
    maxNotificationsPerDay: 12,
    quietHoursStart: "23:00",
    quietHoursEnd: "07:00",
    batchIntervalMinutes: 15,
    primaryPlatform: "slack",
    defaultNotificationPlatforms: [],
    disallowedTools: ["Bash(rm -rf *)"],
    allowedToolsOverride: null,
    claudeExecutionPermissionMode: "strict",
    codexExecutionPermissionMode: "strict",
    geminiExecutionPermissionMode: "strict",
    opencodeExecutionPermissionMode: "strict",
    opencodeBaseUrl: "http://127.0.0.1:4096",
    opencodeServerUsername: "opencode",
    obsidianDebounceSeconds: 5,
    gitPollIntervalSeconds: 300,
    notionPollIntervalSeconds: 300,
    calendarPollIntervalSeconds: 300,
    gmailPollIntervalSeconds: 600,
    autonomousDailyCostCapUsd: null,
    autonomousMonthlyCostCapUsd: null,
    primaryLanguage: "en",
    vaultMode: "plain",
  } as unknown as AgentConfig;
}

class InMemorySecretStore implements SecretStore {
  private readonly values = new Map<StoredSecretName, string>();

  constructor(seed: Partial<Record<StoredSecretName, string>> = {}) {
    for (const [key, value] of Object.entries(seed)) {
      this.values.set(key as StoredSecretName, value);
    }
  }

  async has(name: StoredSecretName): Promise<boolean> {
    return this.values.has(name);
  }

  async get(name: StoredSecretName): Promise<string | null> {
    return this.values.get(name) ?? null;
  }

  async set(name: StoredSecretName, value: string): Promise<void> {
    this.values.set(name, value);
  }

  async delete(name: StoredSecretName): Promise<void> {
    this.values.delete(name);
  }
}

function authHeaders(init?: Record<string, string>): Record<string, string> {
  return {
    Authorization: "Bearer test-token",
    ...(init ?? {}),
  };
}

function makeAgentResult(): AgentResult {
  return {
    output: "ok",
    sessionId: null,
    backendId: "claude",
    modelId: "claude-opus-4-6",
    costSource: "sdk",
    costUsd: 0,
    usage: {
      inputTokens: 1,
      outputTokens: 1,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    },
    modelUsage: {},
    numTurns: 1,
    durationMs: 1,
    durationApiMs: 1,
    model: "claude-opus-4-6",
    isError: false,
    stopReason: null,
    contextUpdated: false,
  };
}

function makeBackendCore(
  backendId: "claude" | "codex" | "gemini",
  models: BackendModel[],
  authResult: Awaited<ReturnType<IAgentCore["checkAuth"]>>,
): IAgentCore {
  const detailedAuth = authResult.ok
    ? { ok: true as const, status: "ok" as const, method: authResult.method }
    : {
        ok: false as const,
        status: "expired" as const,
        method: "cli_login" as const,
        detail: authResult.reason,
      };
  return {
    backendId,
    execute: vi.fn().mockResolvedValue(makeAgentResult()),
    executeResume: vi.fn().mockResolvedValue(makeAgentResult()),
    summarize: vi.fn().mockResolvedValue("summary"),
    checkAuth: vi.fn().mockResolvedValue(authResult),
    checkAuthDetailed: vi.fn().mockResolvedValue(detailedAuth),
    listModels: vi.fn().mockReturnValue(models),
    probeTools: vi.fn().mockResolvedValue([]),
    runDelegatedTool: vi.fn().mockRejectedValue(new Error("not implemented")),
  };
}

describe("Dashboard API", () => {
  let db: Database.Database;
  let app: ReturnType<typeof createApp>;
  let secretBroker: SecretBroker;
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "pa-dashboard-test-"));
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applySchema(db);
    secretBroker = new SecretBroker(
      new InMemorySecretStore({ apiToken: "test-token" }),
      { cacheTtlMs: 0 },
    );

    const deps: ApiDependencies = {
      db,
      config: makeConfig(dataDir),
      secretBroker,
      services: createServiceRegistry(),
      getHealthData: () => ({
        uptime: 100,
        eventBusSize: 0,
        activeSessions: 0,
        connectedPlatforms: [],
        registeredObservers: [],
        missingContextFiles: [],
        contextFilesOk: true,
      }),
      getIntegrationStatus: () => ({
        google: {
          configured: false,
          connected: false,
          error: null,
          services: {
            calendar: { connected: false, error: null },
            gmail: { connected: false, error: null },
          },
        },
        obsidian: { configured: false, connected: false, error: null },
        notion: { configured: false, connected: false, error: null },
        whatsapp: {
          configured: false,
          connected: false,
          error: null,
          state: "not_configured",
        },
      }),
      agentBackends: [
        makeBackendCore(
          "claude",
          [
            {
              backendId: "claude",
              modelId: "claude-sonnet-4-6",
              label: "Claude Sonnet 4.6",
              tier: "light",
              available: true,
            },
            {
              backendId: "claude",
              modelId: "claude-opus-4-6",
              label: "Claude Opus 4.6",
              tier: "heavy",
              available: true,
            },
          ],
          { ok: true, method: "cli_login" },
        ),
        makeBackendCore(
          "codex",
          [
            {
              backendId: "codex",
              modelId: "gpt-5.4-mini",
              label: "GPT-5.4 Mini",
              tier: "light",
              available: true,
            },
            {
              backendId: "codex",
              modelId: "gpt-5.4",
              label: "GPT-5.4",
              tier: "heavy",
              available: true,
            },
          ],
          { ok: true, method: "oauth" },
        ),
        makeBackendCore(
          "gemini",
          [
            {
              backendId: "gemini",
              modelId: "gemini-3-flash-preview",
              label: "Gemini 3 Flash",
              tier: "light",
              available: true,
            },
            {
              backendId: "gemini",
              modelId: "gemini-3-pro-preview",
              label: "Gemini 3 Pro",
              tier: "heavy",
              available: true,
            },
          ],
          { ok: false, reason: "Gemini is not authenticated." },
        ),
      ],
    };
    app = createApp(deps);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  // ── Config API ──

  describe("GET /api/config", () => {
    it("returns safe config without API keys", async () => {
      await secretBroker.set("notionApiKey", "secret_notion_key");

      const res = await app.request("/api/config", {
        headers: authHeaders(),
      });
      expect(res.status).toBe(200);
      const data = (await res.json()) as Record<string, any>;
      expect(data.agentDisplayName).toBe(DEFAULT_AGENT_DISPLAY_NAME);
      expect(data.disallowedTools).toEqual(["Bash(rm -rf *)"]);
      expect(data.authPreflightFreshnessMs).toBe(600000);
      expect(data.schedulePollIntervalSeconds).toBe(5);
      expect(data.notionPollIntervalSeconds).toBe(300);
      expect(data.gmailPollIntervalSeconds).toBe(600);
      expect(data.dmStalenessStrict).toBe(false);
      expect(data.opencodeExecutionPermissionMode).toBe("strict");
      expect(data.opencodeBaseUrl).toBe("http://127.0.0.1:4096");
      expect(data.opencodeServerUsername).toBe("opencode");
      expect(data.autonomousDailyCostCapUsd).toBeNull();
      // B-007 §8.1: primary language + vault mode must be exposed so the
      // settings UI can let the user revisit the wizard choices.
      expect(data.primaryLanguage).toBe("en");
      expect(data.vaultMode).toBe("plain");
      // Should NOT contain API keys
      expect(data.slackBotToken).toBeUndefined();
      expect(data.apiToken).toBeUndefined();
      expect(data.notionConfigured).toBe(true);
    });
  });

  describe("GET /api/config/defaults", () => {
    it("returns Zod schema defaults for all editable keys", async () => {
      const res = await app.request("/api/config/defaults", {
        headers: authHeaders(),
      });
      expect(res.status).toBe(200);
      const data = (await res.json()) as Record<string, any>;
      // Spot-check several defaults from the Zod schema
      expect(data.dayBoundaryHour).toBe(4);
      expect(data.quietHoursStart).toBe("22:00");
      expect(data.quietHoursEnd).toBe("08:00");
      expect(data.hourlyCheckEnabled).toBe(true);
      expect(data.hourlyCheckIntervalMinutes).toBe(60);
      expect(data.hourlyCheckActiveStartHour).toBe(4);
      expect(data.hourlyCheckActiveEndHour).toBe(24);
      expect(data.maxNotificationsPerHour).toBe(3);
      expect(data.maxNotificationsPerDay).toBe(12);
      expect(data.authPreflightFreshnessMs).toBe(600000);
      expect(data.schedulePollIntervalSeconds).toBe(5);
      expect(data.gmailPollIntervalSeconds).toBe(600);
      expect(data.dmStalenessStrict).toBe(false);
      expect(data.opencodeExecutionPermissionMode).toBe("strict");
      expect(data.opencodeBaseUrl).toBe("http://127.0.0.1:4096");
      expect(data.opencodeServerUsername).toBe("opencode");
      expect(data.autonomousDailyCostCapUsd).toBeNull();
      // Bootstrap key
      expect(data.apiPort).toBe(8321);
      // allowedToolsOverride null → allowedTools []
      expect(data.allowedTools).toEqual([]);
      expect(data.allowedToolsOverride).toBeUndefined();
      // Should NOT contain derivative flags
      expect(data.slackConfigured).toBeUndefined();
      expect(data.notionConfigured).toBeUndefined();
    });
  });

  describe("GET /api/backends", () => {
    it("returns backend rows, auth metadata, and default models", async () => {
      const res = await app.request("/api/backends", {
        headers: authHeaders(),
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as Record<string, any>;
      expect(data.defaultBackend).toBe("claude");
      expect(data.defaultLiteModel).toBe("claude-haiku-4-5-20251001");
      expect(data.defaultMediumModel).toBe("claude-sonnet-4-6");
      expect(data.defaultHighModel).toBe("claude-opus-4-7");
      expect(data.pricingDataSource).toMatchObject({
        source: "hardcoded",
        stale: true,
      });
      expect(data.backends).toHaveLength(4);
      expect(data.backends[0]).toMatchObject({
        id: "claude",
        enabled: true,
        authStatus: "unknown",
      });
      expect(data.backends.map((b: { id: string }) => b.id)).toEqual([
        "claude",
        "codex",
        "gemini",
        "opencode",
      ]);
    });
  });

  describe("POST /api/backends/:id/check-auth", () => {
    it("updates the backend auth status from the registered core", async () => {
      const res = await app.request("/api/backends/codex/check-auth", {
        method: "POST",
        headers: authHeaders(),
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as Record<string, any>;
      expect(data).toMatchObject({
        backendId: "codex",
        ok: true,
        method: "oauth",
      });

      const row = db
        .prepare("SELECT auth_status, auth_method, last_error FROM backends WHERE id = 'codex'")
        .get() as { auth_status: string; auth_method: string | null; last_error: string | null };
      expect(row).toEqual({
        auth_status: "ok",
        auth_method: "oauth",
        last_error: null,
      });
    });
  });

  describe("POST /api/backends/pricing-source/refresh", () => {
    it("refreshes pricing metadata and reports LiteLLM as the source", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          new Response(
            JSON.stringify({
              "gpt-5.4": {
                input_cost_per_token: 0.0000025,
                output_cost_per_token: 0.000015,
              },
            }),
            { status: 200 },
          ),
        ),
      );

      const res = await app.request("/api/backends/pricing-source/refresh", {
        method: "POST",
        headers: authHeaders(),
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as Record<string, any>;
      expect(data.pricingDataSource).toMatchObject({
        source: "litellm",
        lastError: null,
      });
    });
  });

  describe("PUT /api/process-config/:processKey", () => {
    it("updates a configurable process binding", async () => {
      await app.request("/api/backends/codex/enable", {
        method: "POST",
        headers: authHeaders(),
      });

      const res = await app.request("/api/process-config/message.dm", {
        method: "PUT",
        headers: {
          ...authHeaders(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          mainBackend: "codex",
          mainModel: "gpt-5.4",
          fallbackBackend: "claude",
          fallbackModel: "claude-opus-4-6",
          maxTurns: 88,
          maxBudgetUsd: 4.2,
        }),
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as Record<string, any>;
      expect(data.config).toMatchObject({
        processKey: "message.dm",
        mainBackend: "codex",
        mainModel: "gpt-5.4",
        fallbackBackend: "claude",
        fallbackModel: "claude-opus-4-6",
        maxTurns: 88,
        maxBudgetUsd: 4.2,
      });
    });

    // docs/design/appendices/opencode-backend.md Phase 2 — `OpencodeCore` is wired into
    // `BackendRouter`, so opencode joined `RUNTIME_AVAILABLE_BACKEND_IDS`
    // and the destructive write gates accept it. The seed disables every
    // non-claude backend, so the test explicitly enables opencode first
    // (the same dance the wizard runs).
    it("accepts mainBackend='opencode' once Phase 2 wires OpencodeCore", async () => {
      await app.request("/api/backends/opencode/enable", {
        method: "POST",
        headers: authHeaders(),
      });
      const res = await app.request("/api/process-config/message.dm", {
        method: "PUT",
        headers: {
          ...authHeaders(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          mainBackend: "opencode",
          mainModel: "anthropic/claude-sonnet-4-6",
          maxTurns: 50,
          maxBudgetUsd: 1.0,
        }),
      });
      expect(res.status).toBe(200);
      const data = (await res.json()) as Record<string, any>;
      expect(data?.config?.mainBackend ?? data?.row?.mainBackend ?? data?.mainBackend).toBe("opencode");
    });

    it("accepts fallbackBackend='opencode' once Phase 2 wires OpencodeCore", async () => {
      await app.request("/api/backends/opencode/enable", {
        method: "POST",
        headers: authHeaders(),
      });
      const res = await app.request("/api/process-config/message.dm", {
        method: "PUT",
        headers: {
          ...authHeaders(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          mainBackend: "claude",
          mainModel: "claude-sonnet-4-6",
          fallbackBackend: "opencode",
          fallbackModel: "anthropic/claude-haiku-4-5",
          maxTurns: 50,
          maxBudgetUsd: 1.0,
        }),
      });
      expect(res.status).toBe(200);
      const data = (await res.json()) as Record<string, any>;
      expect(data?.config?.fallbackBackend ?? data?.row?.fallbackBackend ?? data?.fallbackBackend).toBe("opencode");
    });
  });

  describe("PUT /api/backends/main", () => {
    // docs/design/appendices/opencode-backend.md Phase 2 — opencode is now eligible to be
    // the main backend. The destructive cascade (`applyDefaultPresets`
    // rewriting every `process_backend_config` row) is intentional once
    // the operator confirms — same blast radius as flipping main to any
    // other backend.
    it("accepts backendId='opencode' once Phase 2 wires OpencodeCore", async () => {
      await app.request("/api/backends/opencode/enable", {
        method: "POST",
        headers: authHeaders(),
      });
      const res = await app.request("/api/backends/main", {
        method: "PUT",
        headers: {
          ...authHeaders(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ backendId: "opencode" }),
      });
      expect([200, 201]).toContain(res.status);
    });
  });

  describe("PUT /api/backends/defaults", () => {
    it("accepts defaultBackend='opencode' once Phase 2 wires OpencodeCore", async () => {
      await app.request("/api/backends/opencode/enable", {
        method: "POST",
        headers: authHeaders(),
      });
      const res = await app.request("/api/backends/defaults", {
        method: "PUT",
        headers: {
          ...authHeaders(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          defaultBackend: "opencode",
          defaultLiteModel: "anthropic/claude-haiku-4-5",
          defaultMediumModel: "anthropic/claude-sonnet-4-6",
          defaultHighModel: "anthropic/claude-opus-4-7",
        }),
      });
      expect([200, 201]).toContain(res.status);
    });
  });

  describe("GET /api/chat/current-binding", () => {
    it("reports the active backend when the current session differs from the configured main backend", async () => {
      db.prepare(
        `INSERT INTO conversation_sessions (
           platform,
           channel_id,
           thread_id,
           scope,
           scope_key,
           status,
           model,
           is_dm,
           backend,
           backend_session_id
         ) VALUES
         ('owner', 'owner', NULL, 'owner_dm', 'owner', 'active', 'claude-opus-4-6', 1, 'claude', 'owner-thread'),
         ('dashboard', 'dashboard-owner', NULL, 'dashboard_chat', 'dashboard', 'active', 'gpt-5.4', 1, 'codex', 'thread-1')`,
      ).run();

      const res = await app.request("/api/chat/current-binding", {
        headers: authHeaders(),
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as Record<string, any>;
      expect(data).toMatchObject({
        processKey: "dashboard.chat",
        mainBackend: "claude",
        activeBackend: "codex",
        activeModel: "gpt-5.4",
        fallbackActive: true,
      });
    });
  });

  describe("PATCH /api/config", () => {
    it("rejects secret fields and points callers to write-only endpoints", async () => {
      const res = await app.request("/api/config", {
        method: "PATCH",
        headers: {
          ...authHeaders(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ notionApiKey: "secret" }),
      });

      expect(res.status).toBe(400);
      const data = (await res.json()) as Record<string, any>;
      expect(data.error).toBe("validation_failed");
      expect(data.details.notionApiKey).toContain("PUT /api/secrets/");
    });
  });

  describe("PUT /api/secrets/notion", () => {
    it("stores the secret without echoing it back", async () => {
      const res = await app.request("/api/secrets/notion", {
        method: "PUT",
        headers: {
          ...authHeaders(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ apiKey: "secret_notion_key" }),
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as Record<string, any>;
      expect(data.status).toBe("updated");
      expect(data.configured).toBe(true);
      expect(JSON.stringify(data)).not.toContain("secret_notion_key");
      await expect(secretBroker.getNotionApiKey()).resolves.toBe("secret_notion_key");
    });
  });

  describe("DELETE /api/secrets/apiToken", () => {
    it("refuses to delete the daemon API token", async () => {
      const res = await app.request("/api/secrets/apiToken", {
        method: "DELETE",
        headers: authHeaders(),
      });

      expect(res.status).toBe(400);
      const data = (await res.json()) as Record<string, any>;
      expect(data.error).toBe("api_token_not_deletable");
      await expect(secretBroker.getApiToken()).resolves.toBe("test-token");
    });
  });

  describe("POST /api/config/reset-safety", () => {
    it("returns default disallowedTools", async () => {
      const res = await app.request("/api/config/reset-safety", {
        method: "POST",
        headers: authHeaders(),
      });
      expect(res.status).toBe(200);
      const data = (await res.json()) as Record<string, any>;
      expect(data.status).toBe("reset");
      expect(data.disallowedTools).toEqual([...DEFAULT_DISALLOWED_TOOLS]);
    });
  });

  describe("error redaction", () => {
    it("redacts secret-like values from dashboard route error payloads", async () => {
      const errorApp = createApp({
        db,
        config: makeConfig(dataDir),
        secretBroker,
        services: createServiceRegistry(),
        getHealthData: () => ({
          uptime: 100,
          eventBusSize: 0,
          activeSessions: 0,
          connectedPlatforms: [],
          registeredObservers: [],
          missingContextFiles: [],
          contextFilesOk: true,
        }),
        getIntegrationStatus: () => ({
          google: {
            configured: false,
            connected: false,
            error: null,
            services: {
              calendar: { connected: false, error: null },
              gmail: { connected: false, error: null },
            },
          },
          obsidian: { configured: false, connected: false, error: null },
          notion: { configured: false, connected: false, error: null },
          whatsapp: {
            configured: false,
            connected: false,
            error: null,
            state: "not_configured",
          },
        }),
        messagingControls: {
          telegram: {
            testToken: async () => {
              throw new Error(
                "Bearer abcdefghijklmnopqrstuvwxyz123456 xoxb-secret-token",
              );
            },
            startPairing: async () => ({
              pairToken: "token",
              deepLink: "link",
              qrDataUrl: "qr",
              expiresAt: Date.now(),
              botUsername: "bot",
            }),
            getPairingStatus: () => ({
              paired: false,
              ownerChatId: null,
              pairingActive: false,
            }),
            cancelPairing: () => {},
          },
        },
      });

      const res = await errorApp.request("/api/messaging/telegram/test-token", {
        method: "POST",
        headers: {
          ...authHeaders(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ token: "draft-token" }),
      });

      expect(res.status).toBe(400);
      const data = (await res.json()) as Record<string, any>;
      expect(data.message).toContain("[REDACTED]");
      expect(data.message).not.toContain("abcdefghijklmnopqrstuvwxyz123456");
      expect(data.message).not.toContain("xoxb-secret-token");
    });
  });

  describe("Google OAuth", () => {
    it("POST /api/config/google-auth/start includes a generated OAuth state", async () => {
      const googleSecretBroker = new SecretBroker(
        new InMemorySecretStore({
          apiToken: "test-token",
          googleCredentialsJson: JSON.stringify({
            installed: {
              client_id: "client-id",
              client_secret: "client-secret",
              redirect_uris: ["http://127.0.0.1:8321/api/config/google-auth/callback"],
            },
          }),
        }),
        { cacheTtlMs: 0 },
      );
      const oauthApp = createApp({
        db,
        config: makeConfig(dataDir),
        secretBroker: googleSecretBroker,
        services: createServiceRegistry(),
        getHealthData: () => ({
          uptime: 100,
          eventBusSize: 0,
          activeSessions: 0,
          connectedPlatforms: [],
          registeredObservers: [],
          missingContextFiles: [],
          contextFilesOk: true,
        }),
        getIntegrationStatus: () => ({
          google: {
            configured: false,
            connected: false,
            error: null,
            services: {
              calendar: { connected: false, error: null },
              gmail: { connected: false, error: null },
            },
          },
          obsidian: { configured: false, connected: false, error: null },
          notion: { configured: false, connected: false, error: null },
          whatsapp: {
            configured: false,
            connected: false,
            error: null,
            state: "not_configured",
          },
        }),
      });

      // The Google OAuth start endpoint validates Origin/Referer against
      // the configured dashboard origin allowlist before issuing a state.
      // Tests must supply a trusted Origin or the endpoint returns 403.
      const res = await oauthApp.request("/api/config/google-auth/start", {
        method: "POST",
        headers: {
          ...authHeaders(),
          Origin: "http://localhost:3000",
        },
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as Record<string, any>;
      expect(data.authUrl).toContain("state=");

      const url = new URL(data.authUrl);
      expect(url.searchParams.get("state")).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      );
    });

    it("POST /api/config/google-auth/start rejects untrusted Origin", async () => {
      // postMessage targetOrigin defence: a request initiated from
      // `attacker.com` must not be able to steer the callback's
      // postMessage back to itself.
      const googleSecretBroker = new SecretBroker(
        new InMemorySecretStore({
          apiToken: "test-token",
          googleCredentialsJson: JSON.stringify({
            installed: {
              client_id: "client-id",
              client_secret: "client-secret",
              redirect_uris: ["http://127.0.0.1:8321/api/config/google-auth/callback"],
            },
          }),
        }),
        { cacheTtlMs: 0 },
      );
      const localApp = createApp({
        db,
        config: makeConfig(dataDir),
        secretBroker: googleSecretBroker,
        services: createServiceRegistry(),
        getHealthData: () => ({
          uptime: 0,
          eventBusSize: 0,
          activeSessions: 0,
          connectedPlatforms: [],
          registeredObservers: [],
          missingContextFiles: [],
          contextFilesOk: true,
        }),
        getIntegrationStatus: () => ({
          google: {
            configured: false,
            connected: false,
            error: null,
            services: {
              calendar: { connected: false, error: null },
              gmail: { connected: false, error: null },
            },
          },
          obsidian: { configured: false, connected: false, error: null },
          notion: { configured: false, connected: false, error: null },
          whatsapp: {
            configured: false,
            connected: false,
            error: null,
            state: "not_configured",
          },
        }),
      });

      const res = await localApp.request("/api/config/google-auth/start", {
        method: "POST",
        headers: {
          ...authHeaders(),
          Origin: "http://attacker.example",
        },
      });
      expect(res.status).toBe(403);
      const data = (await res.json()) as { error: string };
      expect(data.error).toBe("untrusted_origin");
    });

    it("GET /api/config/google-auth/callback rejects missing or unknown state", async () => {
      const res = await app.request("/api/config/google-auth/callback?code=test-code");
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toContain("Invalid or expired OAuth state.");
    });
  });

  // ── Events API ──

  describe("GET /api/events", () => {
    it("returns paginated events", async () => {
      // Insert test data
      db.prepare(
        `INSERT INTO agent_actions (action_type, trigger, model_used, cost_usd, result, started_at)
         VALUES ('routine.morning_routine', 'autonomous', 'opus', 0.50, 'success', datetime('now'))`,
      ).run();
      db.prepare(
        `INSERT INTO agent_actions (action_type, trigger, model_used, cost_usd, result, started_at)
         VALUES ('message.received', 'reactive', 'opus', 0.10, 'success', datetime('now'))`,
      ).run();

      const res = await app.request("/api/events?page=1&limit=10", {
        headers: authHeaders(),
      });
      expect(res.status).toBe(200);
      const data = (await res.json()) as Record<string, any>;
      expect(data.events).toHaveLength(2);
      expect(data.pagination.total).toBe(2);
      expect(data.pagination.page).toBe(1);
    });

    it("filters by type", async () => {
      db.prepare(
        `INSERT INTO agent_actions (action_type, trigger, started_at) VALUES ('routine.morning_routine', 'autonomous', datetime('now'))`,
      ).run();
      db.prepare(
        `INSERT INTO agent_actions (action_type, trigger, started_at) VALUES ('message.received', 'reactive', datetime('now'))`,
      ).run();

      const res = await app.request("/api/events?type=message.received", {
        headers: authHeaders(),
      });
      const data = (await res.json()) as Record<string, any>;
      expect(data.events).toHaveLength(1);
      expect(data.events[0].action_type).toBe("message.received");
    });
  });

  // ── Conversations API ──

  describe("GET /api/conversations", () => {
    it("returns paginated conversations", async () => {
      db.prepare(
        `INSERT INTO conversation_sessions (platform, channel_id, status, model)
         VALUES ('slack', 'D123', 'active', 'opus')`,
      ).run();
      db.prepare(
        `INSERT INTO conversation_sessions (platform, channel_id, status, model)
         VALUES ('telegram', 'T456', 'expired', 'opus')`,
      ).run();

      const res = await app.request("/api/conversations", {
        headers: authHeaders(),
      });
      expect(res.status).toBe(200);
      const data = (await res.json()) as Record<string, any>;
      expect(data.conversations).toHaveLength(2);
    });

    it("filters by platform", async () => {
      db.prepare(
        `INSERT INTO conversation_sessions (platform, channel_id, status, scope_key) VALUES ('slack', 'D1', 'active', 'slack:D1')`,
      ).run();
      db.prepare(
        `INSERT INTO conversation_sessions (platform, channel_id, status, scope_key) VALUES ('telegram', 'T1', 'active', 'telegram:T1')`,
      ).run();

      const res = await app.request("/api/conversations?platform=slack", {
        headers: authHeaders(),
      });
      const data = (await res.json()) as Record<string, any>;
      expect(data.conversations).toHaveLength(1);
      expect(data.conversations[0].platform).toBe("slack");
    });

    it("filters by status", async () => {
      db.prepare(
        `INSERT INTO conversation_sessions (platform, channel_id, status) VALUES ('slack', 'D1', 'active')`,
      ).run();
      db.prepare(
        `INSERT INTO conversation_sessions (platform, channel_id, status) VALUES ('slack', 'D2', 'expired')`,
      ).run();

      const res = await app.request("/api/conversations?status=active", {
        headers: authHeaders(),
      });
      const data = (await res.json()) as Record<string, any>;
      expect(data.conversations).toHaveLength(1);
      expect(data.conversations[0].status).toBe("active");
    });

    it("filters by scope", async () => {
      db.prepare(
        `INSERT INTO conversation_sessions (platform, channel_id, status, scope, scope_key)
         VALUES ('dashboard', 'dashboard', 'closed', 'dashboard_chat', 'dashboard')`,
      ).run();
      db.prepare(
        `INSERT INTO conversation_sessions (platform, channel_id, status, scope, scope_key)
         VALUES ('slack', 'C123', 'closed', 'thread', 'slack:C123')`,
      ).run();

      const res = await app.request("/api/conversations?scope=dashboard_chat", {
        headers: authHeaders(),
      });
      expect(res.status).toBe(200);
      const data = (await res.json()) as Record<string, any>;
      expect(data.conversations).toHaveLength(1);
      expect(data.conversations[0].platform).toBe("dashboard");
      expect(data.conversations[0].scope).toBeUndefined();
    });

    it("returns source platforms and read-only metadata", async () => {
      db.prepare(
        `INSERT INTO conversation_sessions (id, platform, channel_id, status, scope, scope_key)
         VALUES (10, 'owner', 'owner', 'closed', 'owner_dm', 'owner')`,
      ).run();
      db.prepare(
        `INSERT INTO messages (session_id, role, content, platform)
         VALUES
         (10, 'user', 'hello from telegram', 'telegram'),
         (10, 'assistant', 'hi', 'telegram'),
         (10, 'user', 'browser follow-up', 'dashboard')`,
      ).run();

      const res = await app.request("/api/conversations?scope=owner_dm", {
        headers: authHeaders(),
      });
      expect(res.status).toBe(200);
      const data = (await res.json()) as Record<string, any>;
      expect(data.conversations[0].source_platforms).toEqual(["dashboard", "telegram"]);
      expect(data.conversations[0].read_only_from_dashboard).toBe(true);
      expect(data.conversations[0].continue_available).toBe(false);
    });

    it("marks browser-only dashboard history as continueable when resume state exists", async () => {
      db.prepare(
        `INSERT INTO conversation_sessions (
           id, platform, channel_id, status, scope, scope_key, backend_session_id
         )
         VALUES (11, 'dashboard', 'dashboard', 'closed', 'dashboard_chat', 'dashboard', 'sdk-session-1')`,
      ).run();
      db.prepare(
        `INSERT INTO messages (session_id, role, content, platform)
         VALUES
         (11, 'user', 'browser hello', 'dashboard'),
         (11, 'assistant', 'browser hi', 'dashboard')`,
      ).run();
      mkdirSync(getSessionWorkdirPath(dataDir, 11), { recursive: true });

      const res = await app.request("/api/conversations?scope=dashboard_chat", {
        headers: authHeaders(),
      });
      expect(res.status).toBe(200);
      const data = (await res.json()) as Record<string, any>;
      expect(data.conversations[0].source_platforms).toEqual(["dashboard"]);
      expect(data.conversations[0].read_only_from_dashboard).toBe(false);
      expect(data.conversations[0].continue_available).toBe(true);
    });

    it("marks a dashboard session with NULL backend_session_id as continueable when workdir survives", async () => {
      // Regression: a row whose backend was nulled (by the
      // `shouldInvalidateSdkSession` path in continueDashboardSession,
      // or by a backend like Gemini that didn't emit `session_id`) is
      // still resumable — the dispatcher rebuilds via history
      // injection. The sidebar must reflect that, otherwise the row
      // stays permanently read-only from the user's perspective.
      db.prepare(
        `INSERT INTO conversation_sessions (
           id, platform, channel_id, status, scope, scope_key, backend_session_id
         )
         VALUES (12, 'dashboard', 'dashboard', 'closed', 'dashboard_chat', 'dashboard', NULL)`,
      ).run();
      db.prepare(
        `INSERT INTO messages (session_id, role, content, platform)
         VALUES
         (12, 'user', 'revive me', 'dashboard'),
         (12, 'assistant', 'ready', 'dashboard')`,
      ).run();
      mkdirSync(getSessionWorkdirPath(dataDir, 12), { recursive: true });

      const res = await app.request("/api/conversations?scope=dashboard_chat", {
        headers: authHeaders(),
      });
      expect(res.status).toBe(200);
      const data = (await res.json()) as Record<string, any>;
      const row = (data.conversations as Array<{ id: number; continue_available: boolean }>)
        .find((r) => r.id === 12);
      expect(row).toBeDefined();
      expect(row?.continue_available).toBe(true);
    });

    it("supports filtering by multiple scopes", async () => {
      db.prepare(
        `INSERT INTO conversation_sessions (platform, channel_id, status, scope, scope_key)
         VALUES
         ('dashboard', 'dashboard', 'closed', 'dashboard_chat', 'dashboard'),
         ('owner', 'owner', 'closed', 'owner_dm', 'owner'),
         ('slack', 'C123', 'closed', 'thread', 'slack:C123')`,
      ).run();

      const res = await app.request("/api/conversations?scope=dashboard_chat,owner_dm", {
        headers: authHeaders(),
      });
      expect(res.status).toBe(200);
      const data = (await res.json()) as Record<string, any>;
      expect(data.conversations).toHaveLength(2);
      expect(data.conversations.map((row: { platform: string }) => row.platform)).toEqual([
        "dashboard",
        "owner",
      ]);
    });

    it("excludes docs_qa from the default conversations list", async () => {
      db.prepare(
        `INSERT INTO conversation_sessions (platform, channel_id, status, scope, scope_key)
         VALUES
         ('dashboard', 'dashboard', 'closed', 'dashboard_chat', 'dashboard'),
         ('dashboard', 'qa-channel-1', 'closed', 'docs_qa', 'docs_qa')`,
      ).run();

      const res = await app.request("/api/conversations", {
        headers: authHeaders(),
      });
      expect(res.status).toBe(200);
      const data = (await res.json()) as Record<string, any>;
      expect(data.conversations).toHaveLength(1);
      expect(data.conversations[0].platform).toBe("dashboard");
      expect(data.conversations[0].channel_id).toBe("dashboard");
    });

    it("includes docs_qa rows when scope=docs_qa is specified", async () => {
      db.prepare(
        `INSERT INTO conversation_sessions (platform, channel_id, status, scope, scope_key)
         VALUES
         ('dashboard', 'dashboard', 'closed', 'dashboard_chat', 'dashboard'),
         ('dashboard', 'qa-channel-1', 'closed', 'docs_qa', 'docs_qa')`,
      ).run();

      const res = await app.request("/api/conversations?scope=docs_qa", {
        headers: authHeaders(),
      });
      expect(res.status).toBe(200);
      const data = (await res.json()) as Record<string, any>;
      expect(data.conversations).toHaveLength(1);
      expect(data.conversations[0].channel_id).toBe("qa-channel-1");
    });
  });

  describe("GET /api/conversations/:id/messages", () => {
    it("returns messages for a conversation", async () => {
      db.prepare(
        `INSERT INTO conversation_sessions (platform, channel_id, status) VALUES ('slack', 'D1', 'active')`,
      ).run();
      db.prepare(
        `INSERT INTO messages (session_id, role, content, platform) VALUES (1, 'user', 'hello', 'slack')`,
      ).run();
      db.prepare(
        `INSERT INTO messages (session_id, role, content, platform) VALUES (1, 'assistant', 'hi there', 'slack')`,
      ).run();

      const res = await app.request("/api/conversations/1/messages", {
        headers: authHeaders(),
      });
      expect(res.status).toBe(200);
      const data = (await res.json()) as Record<string, any>;
      expect(data.messages).toHaveLength(2);
      // Should be in chronological order
      expect(data.messages[0].role).toBe("user");
      expect(data.messages[1].role).toBe("assistant");
    });
  });

  // ── Cost API ──

  describe("GET /api/cost", () => {
    it("returns cost analytics", async () => {
      db.prepare(
        `INSERT INTO agent_actions (action_type, model_used, cost_usd, tokens_input, tokens_output, backend, started_at)
         VALUES ('routine.morning_routine', 'claude-opus-4-6', 0.50, 1000, 500, 'claude', datetime('now'))`,
      ).run();
      db.prepare(
        `INSERT INTO agent_actions (action_type, model_used, cost_usd, tokens_input, tokens_output, backend, started_at)
         VALUES ('message.received', 'gpt-5.4-mini', 0.02, 200, 100, 'codex', datetime('now'))`,
      ).run();

      const res = await app.request("/api/cost", {
        headers: authHeaders(),
      });
      expect(res.status).toBe(200);
      const data = (await res.json()) as Record<string, any>;
      expect(data.today.costUsd).toBe(0.52);
      expect(data.today.sessions).toBe(2);
      expect(data.byModel).toHaveLength(2);
      expect(data.byEventType).toHaveLength(2);
      expect(data.byBackend).toEqual([
        { backend: "claude", total_cost: 0.5, session_count: 1 },
        { backend: "codex", total_cost: 0.02, session_count: 1 },
      ]);
      expect(data.byBackendPeriod).toHaveLength(2);
    });

    it("supports weekly period", async () => {
      const res = await app.request("/api/cost?period=weekly", {
        headers: authHeaders(),
      });
      expect(res.status).toBe(200);
      const data = (await res.json()) as Record<string, any>;
      expect(data.period).toBe("weekly");
    });
  });

  // ── Approvals API ──

  describe("Approvals", () => {
    it("GET /api/approvals returns pending approvals", async () => {
      db.prepare(
        `INSERT INTO agent_schedule (scheduled_for, task_type, task_description, status)
         VALUES (datetime('now'), 'approval', 'Deploy to production', 'pending')`,
      ).run();

      const res = await app.request("/api/approvals", {
        headers: authHeaders(),
      });
      expect(res.status).toBe(200);
      const data = (await res.json()) as Record<string, any>;
      expect(data.approvals).toHaveLength(1);
      expect(data.approvals[0].task_description).toBe("Deploy to production");
    });

    it("POST /api/approvals/:id/approve marks as approved", async () => {
      db.prepare(
        `INSERT INTO agent_schedule (scheduled_for, task_type, task_description, status)
         VALUES (datetime('now'), 'approval', 'Deploy', 'pending')`,
      ).run();

      const res = await app.request("/api/approvals/1/approve", {
        method: "POST",
        headers: authHeaders(),
      });
      expect(res.status).toBe(200);
      const data = (await res.json()) as Record<string, any>;
      expect(data.status).toBe("approved");

      // Verify status changed
      const row = db
        .prepare("SELECT task_type, status FROM agent_schedule WHERE id = 1")
        .get() as { task_type: string; status: string };
      expect(row.task_type).toBe("approved_task");
      expect(row.status).toBe("pending"); // ready for ScheduleWatcher
    });

    it("POST /api/approvals/:id/deny marks as skipped", async () => {
      db.prepare(
        `INSERT INTO agent_schedule (scheduled_for, task_type, task_description, status)
         VALUES (datetime('now'), 'approval', 'Deploy', 'pending')`,
      ).run();

      const res = await app.request("/api/approvals/1/deny", {
        method: "POST",
        headers: authHeaders(),
      });
      expect(res.status).toBe(200);

      const row = db
        .prepare("SELECT status FROM agent_schedule WHERE id = 1")
        .get() as { status: string };
      expect(row.status).toBe("skipped");
    });

    it("returns 404 for non-existent approval", async () => {
      const res = await app.request("/api/approvals/999/approve", {
        method: "POST",
        headers: authHeaders(),
      });
      expect(res.status).toBe(404);
    });

    it("rejects protected routes without a bearer token", async () => {
      const res = await app.request("/api/approvals");
      expect(res.status).toBe(401);
    });
  });

  // ── Secrets PUT endpoints ──

  describe("PUT /api/secrets/slack", () => {
    it("stores slack tokens", async () => {
      const res = await app.request("/api/secrets/slack", {
        method: "PUT",
        headers: {
          ...authHeaders(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ botToken: "xoxb-test", appToken: "xapp-test" }),
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as Record<string, any>;
      expect(data.status).toBe("updated");
      await expect(secretBroker.getSlackBotToken()).resolves.toBe("xoxb-test");
      await expect(secretBroker.getSlackAppToken()).resolves.toBe("xapp-test");
    });

    it("returns 400 when both tokens are empty", async () => {
      const res = await app.request("/api/secrets/slack", {
        method: "PUT",
        headers: {
          ...authHeaders(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ botToken: "", appToken: "" }),
      });

      expect(res.status).toBe(400);
    });
  });

  describe("PUT /api/secrets/telegram", () => {
    it("stores telegram bot token", async () => {
      const res = await app.request("/api/secrets/telegram", {
        method: "PUT",
        headers: {
          ...authHeaders(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ botToken: "tg-bot-token" }),
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as Record<string, any>;
      expect(data.status).toBe("updated");
      await expect(secretBroker.getTelegramBotToken()).resolves.toBe("tg-bot-token");
    });

    it("returns 400 when token is empty", async () => {
      const res = await app.request("/api/secrets/telegram", {
        method: "PUT",
        headers: {
          ...authHeaders(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ botToken: "" }),
      });

      expect(res.status).toBe(400);
    });
  });

  describe("PUT /api/secrets/discord", () => {
    it("stores discord bot token", async () => {
      const res = await app.request("/api/secrets/discord", {
        method: "PUT",
        headers: {
          ...authHeaders(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ botToken: "discord-token" }),
      });

      expect(res.status).toBe(200);
      await expect(secretBroker.getDiscordBotToken()).resolves.toBe("discord-token");
    });

    it("returns 400 when token is empty", async () => {
      const res = await app.request("/api/secrets/discord", {
        method: "PUT",
        headers: {
          ...authHeaders(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ botToken: "" }),
      });

      expect(res.status).toBe(400);
    });
  });

  describe("PUT /api/secrets/github", () => {
    it("stores github token and webhook secret", async () => {
      const res = await app.request("/api/secrets/github", {
        method: "PUT",
        headers: {
          ...authHeaders(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ token: "ghp_test", webhookSecret: "wh_secret" }),
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as Record<string, any>;
      expect(data.configured).toBe(true);
    });

    it("returns 400 when both fields are empty", async () => {
      const res = await app.request("/api/secrets/github", {
        method: "PUT",
        headers: {
          ...authHeaders(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ token: "", webhookSecret: "" }),
      });

      expect(res.status).toBe(400);
    });
  });

  describe("PUT /api/secrets/google/credentials", () => {
    it("stores OAuth2 credentials JSON", async () => {
      const creds = JSON.stringify({
        installed: { client_id: "id", client_secret: "secret", redirect_uris: ["http://localhost"] },
      });
      const res = await app.request("/api/secrets/google/credentials", {
        method: "PUT",
        headers: {
          ...authHeaders(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ json: creds }),
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as Record<string, any>;
      expect(data.status).toBe("updated");
    });

    it("returns 400 for empty json", async () => {
      const res = await app.request("/api/secrets/google/credentials", {
        method: "PUT",
        headers: {
          ...authHeaders(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ json: "" }),
      });

      expect(res.status).toBe(400);
    });

    it("returns 400 for invalid JSON string", async () => {
      const res = await app.request("/api/secrets/google/credentials", {
        method: "PUT",
        headers: {
          ...authHeaders(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ json: "{not valid}" }),
      });

      expect(res.status).toBe(400);
    });

    it("returns 400 for invalid credentials format", async () => {
      const res = await app.request("/api/secrets/google/credentials", {
        method: "PUT",
        headers: {
          ...authHeaders(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ json: '{"something": "else"}' }),
      });

      expect(res.status).toBe(400);
    });
  });

  describe("PUT /api/secrets/google/token", () => {
    it("stores google token JSON", async () => {
      const res = await app.request("/api/secrets/google/token", {
        method: "PUT",
        headers: {
          ...authHeaders(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ json: '{"access_token": "at"}' }),
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as Record<string, any>;
      expect(data.status).toBe("updated");
    });

    it("returns 400 for empty json", async () => {
      const res = await app.request("/api/secrets/google/token", {
        method: "PUT",
        headers: {
          ...authHeaders(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ json: "" }),
      });

      expect(res.status).toBe(400);
    });

    it("returns 400 for invalid JSON", async () => {
      const res = await app.request("/api/secrets/google/token", {
        method: "PUT",
        headers: {
          ...authHeaders(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ json: "not-json" }),
      });

      expect(res.status).toBe(400);
    });
  });

  describe("DELETE /api/secrets/:name", () => {
    it("deletes a known secret", async () => {
      await secretBroker.set("notionApiKey", "secret");
      const res = await app.request("/api/secrets/notionApiKey", {
        method: "DELETE",
        headers: authHeaders(),
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as Record<string, any>;
      expect(data.status).toBe("deleted");
      await expect(secretBroker.getNotionApiKey()).resolves.toBeNull();
    });

    it("returns 404 for unknown secret name", async () => {
      const res = await app.request("/api/secrets/unknownSecret", {
        method: "DELETE",
        headers: authHeaders(),
      });

      expect(res.status).toBe(404);
    });
  });

  // ── Dashboard-specific endpoints ──

  describe("GET /api/dashboard/next-check", () => {
    it("returns next hourly check info", async () => {
      const res = await app.request("/api/dashboard/next-check", {
        headers: authHeaders(),
      });
      expect(res.status).toBe(200);
      const data = (await res.json()) as Record<string, any>;
      expect(data).toHaveProperty("active");
    });
  });

  // ── Schedule endpoints ──

  describe("GET /api/schedule/next", () => {
    it("returns next pending scheduled task", async () => {
      db.prepare(
        `INSERT INTO agent_schedule (scheduled_for, task_type, task_description, status)
         VALUES (datetime('now', '+1 hour'), 'wake', 'Next task', 'pending')`,
      ).run();

      const res = await app.request("/api/schedule/next", {
        headers: authHeaders(),
      });
      expect(res.status).toBe(200);
      const data = (await res.json()) as Record<string, any>;
      expect(data.next).not.toBeNull();
      expect(data.next.task_description).toBe("Next task");
    });

    it("returns null when no pending tasks", async () => {
      const res = await app.request("/api/schedule/next", {
        headers: authHeaders(),
      });
      expect(res.status).toBe(200);
      const data = (await res.json()) as Record<string, any>;
      expect(data.next).toBeNull();
    });
  });

  describe("GET /api/schedule/list", () => {
    it("returns paginated schedule list", async () => {
      db.prepare(
        `INSERT INTO agent_schedule (scheduled_for, task_type, task_description, status)
         VALUES (datetime('now'), 'wake', 'Task 1', 'pending')`,
      ).run();

      const res = await app.request("/api/schedule/list", {
        headers: authHeaders(),
      });
      expect(res.status).toBe(200);
      const data = (await res.json()) as Record<string, any>;
      expect(data.schedules).toHaveLength(1);
      expect(data.pagination.total).toBe(1);
    });

    it("filters by status and type", async () => {
      db.prepare(
        `INSERT INTO agent_schedule (scheduled_for, task_type, task_description, status)
         VALUES (datetime('now'), 'wake', 'Done', 'completed')`,
      ).run();
      db.prepare(
        `INSERT INTO agent_schedule (scheduled_for, task_type, task_description, status)
         VALUES (datetime('now'), 'dm', 'Pending DM', 'pending')`,
      ).run();

      const res = await app.request("/api/schedule/list?status=pending&type=dm", {
        headers: authHeaders(),
      });
      const data = (await res.json()) as Record<string, any>;
      expect(data.schedules).toHaveLength(1);
      expect(data.schedules[0].task_type).toBe("dm");
    });
  });

  // ── Search API ──

  describe("GET /api/search", () => {
    it("returns 400 for short query", async () => {
      const res = await app.request("/api/search?q=a", {
        headers: authHeaders(),
      });
      expect(res.status).toBe(400);
    });

    it("returns 400 for query over 200 chars", async () => {
      const longQuery = "a".repeat(201);
      const res = await app.request(`/api/search?q=${longQuery}`, {
        headers: authHeaders(),
      });
      expect(res.status).toBe(400);
    });

    it("returns empty results for a valid search with no matches", async () => {
      const res = await app.request("/api/search?q=nonexistent_term_xyz", {
        headers: authHeaders(),
      });
      expect(res.status).toBe(200);
      const data = (await res.json()) as Record<string, any>;
      expect(data.actions).toBeInstanceOf(Array);
      expect(data.messages).toBeInstanceOf(Array);
    });
  });

  // ── Snapshots API ──

  describe("GET /api/snapshots/content/:id", () => {
    it("returns snapshot content by id", async () => {
      db.prepare(
        `INSERT INTO md_file_snapshots (file_path, content, trigger)
         VALUES ('today', '# Today', 'manual')`,
      ).run();

      const res = await app.request("/api/snapshots/content/1", {
        headers: authHeaders(),
      });
      expect(res.status).toBe(200);
      const data = (await res.json()) as Record<string, any>;
      expect(data.content).toBe("# Today");
    });

    it("returns 404 for non-existent snapshot", async () => {
      const res = await app.request("/api/snapshots/content/999", {
        headers: authHeaders(),
      });
      expect(res.status).toBe(404);
    });

    it("returns 400 for invalid id", async () => {
      const res = await app.request("/api/snapshots/content/abc", {
        headers: authHeaders(),
      });
      expect(res.status).toBe(400);
    });
  });

  describe("GET /api/snapshots/*", () => {
    it("returns snapshots for a given file path", async () => {
      db.prepare(
        `INSERT INTO md_file_snapshots (file_path, content, trigger)
         VALUES ('today', '# Old', 'rotation')`,
      ).run();

      const res = await app.request("/api/snapshots/today", {
        headers: authHeaders(),
      });
      expect(res.status).toBe(200);
      const data = (await res.json()) as Record<string, any>;
      expect(data.snapshots).toHaveLength(1);
    });

    it("returns 400 for invalid path characters", async () => {
      const res = await app.request("/api/snapshots/in%00valid", {
        headers: authHeaders(),
      });
      // Invalid characters get rejected by the regex validator
      expect(res.status).toBe(400);
    });
  });

  // ── Notifications API ──

  describe("GET /api/notifications", () => {
    it("returns paginated notifications", async () => {
      db.prepare(
        `INSERT INTO notification_log (dispatch_id, content_summary, platform, priority, status)
         VALUES ('d1', 'test notification', 'slack', 'normal', 'delivered')`,
      ).run();

      const res = await app.request("/api/notifications", {
        headers: authHeaders(),
      });
      expect(res.status).toBe(200);
      const data = (await res.json()) as Record<string, any>;
      expect(data.notifications).toHaveLength(1);
      expect(data.pagination.total).toBe(1);
    });

    it("filters by status and priority", async () => {
      db.prepare(
        `INSERT INTO notification_log (dispatch_id, content_summary, platform, priority, status)
         VALUES ('d1', 'high', 'slack', 'high', 'delivered')`,
      ).run();
      db.prepare(
        `INSERT INTO notification_log (dispatch_id, content_summary, platform, priority, status)
         VALUES ('d2', 'low', 'slack', 'low', 'delivered')`,
      ).run();

      const res = await app.request("/api/notifications?priority=high", {
        headers: authHeaders(),
      });
      const data = (await res.json()) as Record<string, any>;
      expect(data.notifications).toHaveLength(1);
    });
  });

  // ── Events API additional filters ──

  describe("GET /api/events — additional filters", () => {
    it("filters by result", async () => {
      db.prepare(
        `INSERT INTO agent_actions (action_type, trigger, result, started_at) VALUES ('routine.hourly_check', 'autonomous', 'skipped', datetime('now'))`,
      ).run();
      db.prepare(
        `INSERT INTO agent_actions (action_type, trigger, result, started_at) VALUES ('message.received', 'reactive', 'success', datetime('now'))`,
      ).run();

      const res = await app.request("/api/events?result=skipped", {
        headers: authHeaders(),
      });
      const data = (await res.json()) as Record<string, any>;
      expect(data.events).toHaveLength(1);
      expect(data.events[0].result).toBe("skipped");
    });

    it("filters by days", async () => {
      const res = await app.request("/api/events?days=1", {
        headers: authHeaders(),
      });
      expect(res.status).toBe(200);
      const data = (await res.json()) as Record<string, any>;
      expect(data).toHaveProperty("events");
    });
  });

  // ── Conversations cursor pagination ──

  describe("GET /api/conversations/:id/messages — cursor pagination", () => {
    it("supports cursor-based pagination with before param", async () => {
      db.prepare(
        `INSERT INTO conversation_sessions (platform, channel_id, status) VALUES ('slack', 'D1', 'active')`,
      ).run();
      db.prepare(
        `INSERT INTO messages (session_id, role, content, platform) VALUES (1, 'user', 'first', 'slack')`,
      ).run();
      db.prepare(
        `INSERT INTO messages (session_id, role, content, platform) VALUES (1, 'assistant', 'second', 'slack')`,
      ).run();
      db.prepare(
        `INSERT INTO messages (session_id, role, content, platform) VALUES (1, 'user', 'third', 'slack')`,
      ).run();

      const res = await app.request("/api/conversations/1/messages?before=3", {
        headers: authHeaders(),
      });
      expect(res.status).toBe(200);
      const data = (await res.json()) as Record<string, any>;
      expect(data.messages).toHaveLength(2);
    });
  });

  // ── PATCH /api/config ──

  describe("PATCH /api/config — non-object body", () => {
    it("returns 400 for invalid JSON", async () => {
      const res = await app.request("/api/config", {
        method: "PATCH",
        headers: {
          ...authHeaders(),
          "Content-Type": "application/json",
        },
        body: "{invalid",
      });

      expect(res.status).toBe(400);
      const data = (await res.json()) as Record<string, any>;
      expect(data.error).toBe("invalid_json_body");
    });

    it("returns 400 for non-object body", async () => {
      const res = await app.request("/api/config", {
        method: "PATCH",
        headers: {
          ...authHeaders(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify("string body"),
      });

      expect(res.status).toBe(400);
    });

    it("returns 400 for array body", async () => {
      const res = await app.request("/api/config", {
        method: "PATCH",
        headers: {
          ...authHeaders(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify([1, 2]),
      });

      expect(res.status).toBe(400);
    });
  });

  describe("PATCH /api/config — character validation", () => {
    // CHARACTER-IMPLEMENTATION-PLAN.md §3 Phase 1 Tests:
    //   "API: PATCH /api/config with 1001 chars → 400 with character-count
    //    hint." The Zod-level rejection is exercised in
    //   `runtime-settings.test.ts`; this test covers the HTTP wrapping —
    //   `applyConfigUpdates` lifts the matching Zod issue into
    //   `result.errors.character` and the route returns 400 with
    //   `error: "validation_failed"` and the field-keyed details map.
    it("returns 400 with a character-count hint when value exceeds the 1000-char cap", async () => {
      const res = await app.request("/api/config", {
        method: "PATCH",
        headers: {
          ...authHeaders(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ character: "x".repeat(1001) }),
      });

      expect(res.status).toBe(400);
      const data = (await res.json()) as Record<string, any>;
      expect(data.error).toBe("validation_failed");
      // Zod's default `.max(1000)` message contains the literal cap; we
      // match on `"1000"` so the test stays green if the message wording
      // shifts between Zod minor versions.
      expect(data.details.character).toContain("1000");
    });

    it("accepts a valid character within the cap", async () => {
      const res = await app.request("/api/config", {
        method: "PATCH",
        headers: {
          ...authHeaders(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ character: "Speak casually." }),
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as Record<string, any>;
      expect(data.updated).toContain("character");
    });

    // design/15-character.md §15.6.1 live-overwrite: when character
    // changes, every active session's instruction files (CLAUDE.md /
    // AGENTS.md / GEMINI.md) get their `## Character` block rewritten
    // in place so the next turn sees the new value without waiting for
    // a session spawn.
    it("rewrites the Character block in every active session's workdir", async () => {
      // Two active sessions with on-disk workdirs and a pre-existing
      // block (materialized under the old character value). A third
      // ended session is also seeded to confirm it's skipped.
      const activeIds: number[] = [];
      for (let i = 0; i < 2; i++) {
        const info = db
          .prepare(
            `INSERT INTO conversation_sessions (platform, channel_id, scope, scope_key, status)
             VALUES ('dashboard', ?, 'thread', ?, 'active')`,
          )
          .run(`chan-${i}`, `chan-${i}`);
        activeIds.push(Number(info.lastInsertRowid));
      }
      const endedInfo = db
        .prepare(
          `INSERT INTO conversation_sessions (platform, channel_id, scope, scope_key, status)
           VALUES ('dashboard', 'chan-closed', 'thread', 'chan-closed', 'closed')`,
        )
        .run();
      const endedId = Number(endedInfo.lastInsertRowid);

      const seedBlock = [
        "# conversational",
        "",
        "Safety invariants:",
        "- Do no harm.",
        "",
        "## Character (user-defined)",
        "<!-- character:start -->",
        "Old value.",
        "<!-- character:end -->",
        "",
        "Footer text.",
        "",
        "## Runtime profile",
        "",
        "Body.",
        "",
      ].join("\n");

      for (const id of [...activeIds, endedId]) {
        const dir = getSessionWorkdirPath(dataDir, id);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "CLAUDE.md"), seedBlock, "utf-8");
      }

      // Trigger the live-overwrite via the dashboard PATCH.
      const res = await app.request("/api/config", {
        method: "PATCH",
        headers: {
          ...authHeaders(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ character: "New value." }),
      });
      expect(res.status).toBe(200);
      for (const id of activeIds) {
        const dir = getSessionWorkdirPath(dataDir, id);
        const after = readFileSync(join(dir, "CLAUDE.md"), "utf-8");
        expect(after).toContain("New value.");
        expect(after).not.toContain("Old value.");
      }
      // Ended session is untouched.
      const endedDir = getSessionWorkdirPath(dataDir, endedId);
      const endedAfter = readFileSync(
        join(endedDir, "CLAUDE.md"),
        "utf-8",
      );
      expect(endedAfter).toContain("Old value.");
      expect(endedAfter).not.toContain("New value.");
    });

    it("skips the live-overwrite when the character value is unchanged", async () => {
      // Seed one active session with a workdir carrying some character.
      const info = db
        .prepare(
          `INSERT INTO conversation_sessions (platform, channel_id, scope, scope_key, status)
           VALUES ('dashboard', 'chan-stable', 'thread', 'chan-stable', 'active')`,
        )
        .run();
      const id = Number(info.lastInsertRowid);
      const dir = getSessionWorkdirPath(dataDir, id);
      mkdirSync(dir, { recursive: true });
      const seed = [
        "# conversational",
        "",
        "## Character (user-defined)",
        "<!-- character:start -->",
        "Same value.",
        "<!-- character:end -->",
        "",
        "Footer.",
        "",
        "## Runtime profile",
        "",
        "Body.",
      ].join("\n");
      writeFileSync(join(dir, "CLAUDE.md"), seed, "utf-8");

      // PATCH with a different field — character is NOT in the body, so
      // the live-overwrite guard must not even read the workdir. We
      // assert this by overwriting CLAUDE.md with content that would
      // otherwise be broken if the rewriter ran.
      writeFileSync(join(dir, "CLAUDE.md"), "marker", "utf-8");
      const res = await app.request("/api/config", {
        method: "PATCH",
        headers: {
          ...authHeaders(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ executeTimeoutMinutes: 90 }),
      });
      expect(res.status).toBe(200);
      // The workdir file is still the unrelated marker content.
      const after = readFileSync(join(dir, "CLAUDE.md"), "utf-8");
      expect(after).toBe("marker");
    });
  });

  describe("PATCH /api/config — success paths", () => {
    it("updates a valid runtime config field", async () => {
      const res = await app.request("/api/config", {
        method: "PATCH",
        headers: {
          ...authHeaders(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ executeTimeoutMinutes: 120 }),
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as Record<string, any>;
      expect(data.status).toBe("updated");
      expect(data.updated).toContain("executeTimeoutMinutes");
    });

    it("calls onScheduleConfigChanged when schedule config changes", async () => {
      const onScheduleConfigChanged = vi.fn();
      const patchApp = createApp({
        db,
        config: makeConfig(dataDir),
        secretBroker,
        services: createServiceRegistry(),
        getHealthData: () => ({
          uptime: 100,
          eventBusSize: 0,
          activeSessions: 0,
          connectedPlatforms: [],
          registeredObservers: [],
          missingContextFiles: [],
          contextFilesOk: true,
        }),
        getIntegrationStatus: () => ({
          google: {
            configured: false,
            connected: false,
            error: null,
            services: {
              calendar: { connected: false, error: null },
              gmail: { connected: false, error: null },
            },
          },
          obsidian: { configured: false, connected: false, error: null },
          notion: { configured: false, connected: false, error: null },
          whatsapp: {
            configured: false,
            connected: false,
            error: null,
            state: "not_configured",
          },
        }),
        onScheduleConfigChanged,
      });

      const res = await patchApp.request("/api/config", {
        method: "PATCH",
        headers: {
          ...authHeaders(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ hourlyCheckIntervalMinutes: 30 }),
      });

      expect(res.status).toBe(200);
      expect(onScheduleConfigChanged).toHaveBeenCalled();
    });

    it("reports partial success when some fields fail validation", async () => {
      const res = await app.request("/api/config", {
        method: "PATCH",
        headers: {
          ...authHeaders(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          executeTimeoutMinutes: 90,
          // 0 is below the hourlyCheckIntervalMinutes minimum of 1.
          hourlyCheckIntervalMinutes: 0,
        }),
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as Record<string, any>;
      expect(data.updated).toContain("executeTimeoutMinutes");
      expect(data.errors).toHaveProperty("hourlyCheckIntervalMinutes");
    });

    it("reports restart-required keys", async () => {
      // dayBoundaryHour is a runtime-editable numeric field that happens to
      // be in RESTART_REQUIRED_KEY_TUPLE under certain presets — swap for
      // a key that does not require filesystem probing to validate.
      const res = await app.request("/api/config", {
        method: "PATCH",
        headers: {
          ...authHeaders(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ notionDatabaseIds: { primary: "abc" } }),
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as Record<string, any>;
      expect(data.requiresRestart).toContain("notionDatabaseIds");
    });

    it("PATCH of claudeExecutionPermissionMode emits an execution_mode_changed audit row", async () => {
      // EXECUTION-MODE-DESIGN.md §6.3 — the dedicated `POST /api/setup/mode`
      // emits its own audit row; this test guards the power-user PATCH
      // path so it doesn't silently bypass audit coverage.
      const res = await app.request("/api/config", {
        method: "PATCH",
        headers: {
          ...authHeaders(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ claudeExecutionPermissionMode: "allow" }),
      });
      expect(res.status).toBe(200);
      const rows = db
        .prepare(
          `SELECT backend, detail FROM agent_actions
            WHERE action_type = 'execution_mode_changed'
              AND trigger = 'dashboard_config_patch'
            ORDER BY id DESC`,
        )
        .all() as Array<{ backend: string; detail: string }>;
      expect(rows).toHaveLength(1);
      expect(rows[0].backend).toBe("claude");
      const detail = JSON.parse(rows[0].detail) as {
        before: string;
        after: string;
      };
      expect(detail.before).toBe("strict");
      expect(detail.after).toBe("allow");
    });

    it("PATCH that sets the same execution-mode value does not emit an audit row", async () => {
      // Idempotent PATCH is a no-op — keep the audit signal meaningful.
      const res = await app.request("/api/config", {
        method: "PATCH",
        headers: {
          ...authHeaders(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ codexExecutionPermissionMode: "strict" }),
      });
      expect(res.status).toBe(200);
      const rows = db
        .prepare(
          `SELECT COUNT(*) AS n FROM agent_actions
            WHERE action_type = 'execution_mode_changed'
              AND trigger = 'dashboard_config_patch'
              AND backend = 'codex'`,
        )
        .get() as { n: number };
      expect(rows.n).toBe(0);
    });

    it("returns 400 when a runtime field fails schema validation", async () => {
      const res = await app.request("/api/config", {
        method: "PATCH",
        headers: {
          ...authHeaders(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ notionDatabaseIds: null }),
      });

      expect(res.status).toBe(400);
      const data = (await res.json()) as Record<string, any>;
      expect(data.error).toBe("validation_failed");
      expect(data.details).toHaveProperty("notionDatabaseIds");
    });

    it("returns 409 when notionDatabaseIds changed since the caller snapshot", async () => {
      const patchApp = createApp({
        db,
        config: {
          ...makeConfig(dataDir),
          notionDatabaseIds: { tasks: "db-current" },
        },
        secretBroker,
        services: createServiceRegistry(),
        getHealthData: () => ({
          uptime: 100,
          eventBusSize: 0,
          activeSessions: 0,
          connectedPlatforms: [],
          registeredObservers: [],
          missingContextFiles: [],
          contextFilesOk: true,
        }),
        getIntegrationStatus: () => ({
          google: {
            configured: false,
            connected: false,
            error: null,
            services: {
              calendar: { connected: false, error: null },
              gmail: { connected: false, error: null },
            },
          },
          obsidian: { configured: false, connected: false, error: null },
          notion: { configured: false, connected: false, error: null },
          whatsapp: {
            configured: false,
            connected: false,
            error: null,
            state: "not_configured",
          },
        }),
      });

      const res = await patchApp.request("/api/config", {
        method: "PATCH",
        headers: {
          ...authHeaders(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          notionDatabaseIdsBase: { tasks: "db-stale" },
          notionDatabaseIds: { tasks: "db-next" },
        }),
      });

      expect(res.status).toBe(409);
      const data = (await res.json()) as Record<string, any>;
      expect(data.error).toBe("conflict");
    });
  });

  // ── File upload endpoints ──

  describe("POST /api/config/upload/google-credentials", () => {
    it("uploads valid OAuth2 credentials file", async () => {
      const credContent = JSON.stringify({
        installed: { client_id: "id", client_secret: "secret", redirect_uris: ["http://localhost"] },
      });
      const formData = new FormData();
      formData.append("file", new File([credContent], "credentials.json", { type: "application/json" }));

      const res = await app.request("/api/config/upload/google-credentials", {
        method: "POST",
        headers: authHeaders(),
        body: formData,
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as Record<string, any>;
      expect(data.status).toBe("uploaded");
    });

    it("returns 400 for missing file", async () => {
      const formData = new FormData();

      const res = await app.request("/api/config/upload/google-credentials", {
        method: "POST",
        headers: authHeaders(),
        body: formData,
      });

      expect(res.status).toBe(400);
    });

    it("returns 400 for invalid JSON file", async () => {
      const formData = new FormData();
      formData.append("file", new File(["not json"], "bad.json", { type: "application/json" }));

      const res = await app.request("/api/config/upload/google-credentials", {
        method: "POST",
        headers: authHeaders(),
        body: formData,
      });

      expect(res.status).toBe(400);
    });

    it("returns 400 for invalid credentials format", async () => {
      const formData = new FormData();
      formData.append("file", new File(['{"wrong": "format"}'], "creds.json", { type: "application/json" }));

      const res = await app.request("/api/config/upload/google-credentials", {
        method: "POST",
        headers: authHeaders(),
        body: formData,
      });

      expect(res.status).toBe(400);
    });

    it("returns 400 for oversized file", async () => {
      const bigContent = "x".repeat(101 * 1024);
      const formData = new FormData();
      formData.append("file", new File([bigContent], "big.json", { type: "application/json" }));

      const res = await app.request("/api/config/upload/google-credentials", {
        method: "POST",
        headers: authHeaders(),
        body: formData,
      });

      expect(res.status).toBe(400);
    });

    it("uploads service account credentials and deletes token", async () => {
      // Pre-set a token
      await secretBroker.saveGoogleTokenJson('{"access_token":"at"}');

      const credContent = JSON.stringify({
        type: "service_account",
        client_email: "svc@example.com",
        private_key: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n",
      });
      const formData = new FormData();
      formData.append("file", new File([credContent], "sa.json", { type: "application/json" }));

      const res = await app.request("/api/config/upload/google-credentials", {
        method: "POST",
        headers: authHeaders(),
        body: formData,
      });

      expect(res.status).toBe(200);
      // Token should have been deleted for service account
      await expect(secretBroker.getGoogleTokenJson()).resolves.toBeNull();
    });
  });

  describe("POST /api/config/upload/google-token", () => {
    it("uploads valid token file", async () => {
      const tokenContent = JSON.stringify({ access_token: "at", refresh_token: "rt" });
      const formData = new FormData();
      formData.append("file", new File([tokenContent], "token.json", { type: "application/json" }));

      const res = await app.request("/api/config/upload/google-token", {
        method: "POST",
        headers: authHeaders(),
        body: formData,
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as Record<string, any>;
      expect(data.status).toBe("uploaded");
    });

    it("returns 400 for missing file", async () => {
      const formData = new FormData();

      const res = await app.request("/api/config/upload/google-token", {
        method: "POST",
        headers: authHeaders(),
        body: formData,
      });

      expect(res.status).toBe(400);
    });

    it("returns 400 for invalid JSON file", async () => {
      const formData = new FormData();
      formData.append("file", new File(["not json"], "bad.json", { type: "application/json" }));

      const res = await app.request("/api/config/upload/google-token", {
        method: "POST",
        headers: authHeaders(),
        body: formData,
      });

      expect(res.status).toBe(400);
    });

    it("returns 400 for oversized file", async () => {
      const bigContent = "x".repeat(101 * 1024);
      const formData = new FormData();
      formData.append("file", new File([bigContent], "big.json", { type: "application/json" }));

      const res = await app.request("/api/config/upload/google-token", {
        method: "POST",
        headers: authHeaders(),
        body: formData,
      });

      expect(res.status).toBe(400);
    });
  });

  // ── Messaging endpoints (not configured) ──

  describe("Messaging endpoints return 404 when not configured", () => {
    it("POST /api/messaging/whatsapp/pair returns 404", async () => {
      const res = await app.request("/api/messaging/whatsapp/pair", {
        method: "POST",
        headers: authHeaders(),
      });
      expect(res.status).toBe(404);
    });

    it("GET /api/messaging/whatsapp/qr returns 404", async () => {
      const res = await app.request("/api/messaging/whatsapp/qr", {
        headers: authHeaders(),
      });
      expect(res.status).toBe(404);
    });

    it("GET /api/messaging/whatsapp/status returns 404", async () => {
      const res = await app.request("/api/messaging/whatsapp/status", {
        headers: authHeaders(),
      });
      expect(res.status).toBe(404);
    });

    it("POST /api/messaging/telegram/test-token returns 404", async () => {
      const res = await app.request("/api/messaging/telegram/test-token", {
        method: "POST",
        headers: authHeaders(),
      });
      expect(res.status).toBe(404);
    });

    it("POST /api/messaging/telegram/start-pairing returns 404", async () => {
      const res = await app.request("/api/messaging/telegram/start-pairing", {
        method: "POST",
        headers: authHeaders(),
      });
      expect(res.status).toBe(404);
    });

    it("GET /api/messaging/telegram/pairing-status returns 404", async () => {
      const res = await app.request("/api/messaging/telegram/pairing-status", {
        headers: authHeaders(),
      });
      expect(res.status).toBe(404);
    });

    it("POST /api/messaging/telegram/cancel-pairing returns 404", async () => {
      const res = await app.request("/api/messaging/telegram/cancel-pairing", {
        method: "POST",
        headers: authHeaders(),
      });
      expect(res.status).toBe(404);
    });

    it("POST /api/messaging/slack/test-token returns 404", async () => {
      const res = await app.request("/api/messaging/slack/test-token", {
        method: "POST",
        headers: authHeaders(),
      });
      expect(res.status).toBe(404);
    });

    it("POST /api/messaging/slack/start-pairing returns 404", async () => {
      const res = await app.request("/api/messaging/slack/start-pairing", {
        method: "POST",
        headers: authHeaders(),
      });
      expect(res.status).toBe(404);
    });

    it("POST /api/messaging/slack/cancel-pairing returns 404", async () => {
      const res = await app.request("/api/messaging/slack/cancel-pairing", {
        method: "POST",
        headers: authHeaders(),
      });
      expect(res.status).toBe(404);
    });

    it("GET /api/messaging/slack/pairing-status returns 404", async () => {
      const res = await app.request("/api/messaging/slack/pairing-status", {
        headers: authHeaders(),
      });
      expect(res.status).toBe(404);
    });

    it("POST /api/messaging/discord/test-token returns 404", async () => {
      const res = await app.request("/api/messaging/discord/test-token", {
        method: "POST",
        headers: authHeaders(),
      });
      expect(res.status).toBe(404);
    });

    it("POST /api/messaging/discord/start-pairing returns 404", async () => {
      const res = await app.request("/api/messaging/discord/start-pairing", {
        method: "POST",
        headers: authHeaders(),
      });
      expect(res.status).toBe(404);
    });

    it("POST /api/messaging/discord/cancel-pairing returns 404", async () => {
      const res = await app.request("/api/messaging/discord/cancel-pairing", {
        method: "POST",
        headers: authHeaders(),
      });
      expect(res.status).toBe(404);
    });

    it("GET /api/messaging/discord/pairing-status returns 404", async () => {
      const res = await app.request("/api/messaging/discord/pairing-status", {
        headers: authHeaders(),
      });
      expect(res.status).toBe(404);
    });
  });

  // ── Slack manifest ──

  describe("GET /api/messaging/slack/manifest", () => {
    it("returns manifest and create-app URL when slack controls are configured", async () => {
      const slackApp = createApp({
        ...({
          db,
          config: makeConfig(dataDir),
          secretBroker,
          services: createServiceRegistry(),
          getHealthData: () => ({
            uptime: 100,
            eventBusSize: 0,
            activeSessions: 0,
            connectedPlatforms: [],
            registeredObservers: [],
            missingContextFiles: [],
            contextFilesOk: true,
          }),
          getIntegrationStatus: () => ({
            google: {
              configured: false,
              connected: false,
              error: null,
              services: {
                calendar: { connected: false, error: null },
                gmail: { connected: false, error: null },
              },
            },
            obsidian: { configured: false, connected: false, error: null },
            notion: { configured: false, connected: false, error: null },
            whatsapp: {
              configured: false,
              connected: false,
              error: null,
              state: "not_configured",
            },
          }),
          messagingControls: {
            slack: {
              testToken: vi.fn(),
              startPairing: vi.fn(),
              getPairingStatus: vi.fn().mockReturnValue({ paired: false }),
              cancelPairing: vi.fn(),
            },
          },
        }),
      });

      const res = await slackApp.request("/api/messaging/slack/manifest", {
        headers: authHeaders(),
      });
      expect(res.status).toBe(200);
      const data = (await res.json()) as Record<string, any>;
      expect(data.manifest).toHaveProperty("display_information");
      expect(data.createAppUrl).toContain("api.slack.com");
      expect(data.instructions).toBeInstanceOf(Array);
    });
  });

  // STAGE-C-DM-FRESHNESS-PLAN §Task 4 — endpoint surface for the
  // dm_freshness telemetry. Validates the JSON contract dashboards will
  // bind to, plus the input-validation error path.
  describe("GET /api/dashboard/dm-freshness", () => {
    it("returns the zero aggregate when no dm_freshness rows exist", async () => {
      const res = await app.request("/api/dashboard/dm-freshness", {
        headers: authHeaders(),
      });
      expect(res.status).toBe(200);
      const data = (await res.json()) as Record<string, number>;
      expect(data).toEqual({
        windowDays: 7,
        totalDmTurns: 0,
        resumedTurns: 0,
        resumeRate: 0,
        p50LagMinutes: 0,
        p95LagMinutes: 0,
        triggerMatchedTurns: 0,
        refetchHits: 0,
        refetchHitRate: 0,
      });
    });

    it("aggregates dm_freshness rows seeded into agent_actions", async () => {
      const insert = db.prepare(
        `INSERT INTO agent_actions (action_type, trigger, result, detail, started_at)
         VALUES ('message.received', 'reactive', 'success', json(?), datetime('now'))`,
      );
      insert.run(
        JSON.stringify({
          dm_freshness: {
            resumed: true,
            agent_log_lag_minutes: 12,
            loud_writes_since_session_start: 0,
            quiet_writes_since_session_start: 1,
            refetched_today: true,
            trigger_matched: true,
          },
        }),
      );
      insert.run(
        JSON.stringify({
          dm_freshness: {
            resumed: false,
            agent_log_lag_minutes: 0,
            loud_writes_since_session_start: 0,
            quiet_writes_since_session_start: 0,
            refetched_today: false,
            trigger_matched: false,
          },
        }),
      );

      const res = await app.request("/api/dashboard/dm-freshness", {
        headers: authHeaders(),
      });
      expect(res.status).toBe(200);
      const data = (await res.json()) as {
        totalDmTurns: number;
        resumedTurns: number;
        triggerMatchedTurns: number;
        refetchHits: number;
        refetchHitRate: number;
      };
      expect(data.totalDmTurns).toBe(2);
      expect(data.resumedTurns).toBe(1);
      expect(data.triggerMatchedTurns).toBe(1);
      expect(data.refetchHits).toBe(1);
      expect(data.refetchHitRate).toBe(1);
    });

    it("rejects invalid `days` query params with 400", async () => {
      const res = await app.request(
        "/api/dashboard/dm-freshness?days=0",
        { headers: authHeaders() },
      );
      expect(res.status).toBe(400);
      const data = (await res.json()) as Record<string, string>;
      expect(data.error).toBe("invalid_window");
    });

    it("honors a custom days window when valid", async () => {
      const res = await app.request(
        "/api/dashboard/dm-freshness?days=30",
        { headers: authHeaders() },
      );
      expect(res.status).toBe(200);
      const data = (await res.json()) as Record<string, number>;
      expect(data.windowDays).toBe(30);
    });
  });
});
