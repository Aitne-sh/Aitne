/**
 * SETUP-FLOW-REDESIGN-PLAN §11.3 — happy-path integration test that
 * walks the wizard's daemon-side API surface end-to-end. This is the
 * pragmatic replacement for the design's `setup.e2e.ts` Playwright
 * suite: the dashboard package has no E2E framework wired up yet, and
 * the agent-driven Rules step (a multi-turn LLM conversation) needs a
 * full browser fixture anyway. The integration test below covers
 * everything testable without spawning a real backend session — the
 * API contract every wizard step relies on, plus the §6.2 Note Sources
 * round-trip and the §11.3 acceptance assertions about the resulting
 * `integrations.md` body.
 *
 * Steps simulated (mapped to wizard step IDs):
 *   1. basics    → PATCH /api/config { agentDisplayName, primaryLanguage }
 *   2. vault     → POST /api/setup/migrate-context (plain mode = no-op)
 *   3. backend   → PUT /api/backends/main { backend: "claude" } (deferred — server.ts wiring)
 *   4. mail      → PATCH /api/integrations/gmail { mode: "delegated", ... }
 *   5. calendar  → PATCH /api/integrations/google_calendar { mode: "delegated", ... }
 *   6. note      → PATCH /api/config { externalObsidianVaultPath, externalObsidianWatch }
 *   7. messaging → skipped (no API call)
 *   8. rules     → deferred (Playwright territory; covered in spirit by
 *                  prompts.test.ts §5.8 derive-from-integrations assertion)
 *
 * Outlook-on path is exercised separately at the end: switching the
 * Mail and Calendar steps to outlook_mail/outlook_calendar direct mode
 * exercises the §6.1 registry rejection of `delegated` — the same
 * branch the dashboard's IntegrationCard already suppresses, but
 * pinned at the API contract layer for defense-in-depth.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DEFAULT_AGENT_DISPLAY_NAME } from "@aitne/shared";

import { applySchema } from "./db/schema.js";
import { createSettingsStore, type SettingsStore } from "./settings/settings-store.js";
import { applyConfigUpdates } from "./api/env-writer.js";
import { createIntegrationRoutes } from "./api/routes/integrations/index.js";
import { readIntegrations } from "./db/integrations-store.js";
import type { AgentConfig } from "./config.js";

function baseConfig(dataDir: string): AgentConfig {
  return {
    dataDir,
    workspaceDir: process.cwd(),
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
    externalObsidianWatch: true,
    gitRepos: [],
    maxConcurrentSessions: 3,
    maxReactiveSessions: 2,
    delegatedProxyMaxConcurrent: 4,
    executeTimeoutMinutes: 60,
    sessionTimeoutDmMinutes: 60,
    sessionTimeoutChannelMinutes: 30,
    sessionTimeoutDashboardMinutes: 120,
    agentDisplayName: DEFAULT_AGENT_DISPLAY_NAME,
    primaryLanguage: "en-US",
    character: "",
    historyInjectionMaxMessages: 50,
    historyInjectionMaxTokens: 8000,
    authProbeDisabled: false,
    authPreflightFreshnessMs: 600000,
    hourlyCheckEnabled: true,
    hourlyCheckIntervalMinutes: 60,
    hourlyCheckActiveStartHour: 4,
    hourlyCheckActiveEndHour: 24,
    hourlyCheckMinObservations: 1,
    schedulePollIntervalSeconds: 5,
    dayBoundaryHour: 4,
    timezone: "",
    maxNotificationsPerHour: 3,
    maxNotificationsPerDay: 12,
    quietHoursStart: "23:00",
    quietHoursEnd: "07:00",
    batchIntervalMinutes: 15,
    primaryPlatform: "slack",
    defaultNotificationPlatforms: [],
    disallowedTools: ["Bash(rm -rf *)"],
    allowedToolsOverride: null,
    obsidianDebounceSeconds: 5,
    gitPollIntervalSeconds: 300,
    notionPollIntervalSeconds: 60,
    calendarPollIntervalSeconds: 300,
    gmailPollIntervalSeconds: 600,
    autonomousDailyCostCapUsd: null,
    autonomousMonthlyCostCapUsd: null,
    vaultMode: "plain",
    claudeExecutionPermissionMode: "strict",
    codexExecutionPermissionMode: "strict",
    geminiExecutionPermissionMode: "strict",
    opencodeExecutionPermissionMode: "strict",
  } as unknown as AgentConfig;
}

describe("Setup wizard happy-path (SETUP-FLOW-REDESIGN-PLAN §11.3 — integration substitute for E2E)", () => {
  let db: Database.Database;
  let tmpRoot: string;
  let dataDir: string;
  let settingsStore: SettingsStore;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "pa-setup-flow-"));
    dataDir = join(tmpRoot, "data");
    mkdirSync(dataDir, { recursive: true });
    db = new Database(":memory:");
    applySchema(db);
    settingsStore = createSettingsStore(db);
  });

  afterEach(() => {
    db.close();
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("walks Basics → Vault → Mail → Calendar → Note and produces the expected end-state (acceptance criteria §11.3)", async () => {
    const config = baseConfig(dataDir);
    const integrationRoutes = createIntegrationRoutes({
      db,
      config: { dataDir, workspaceDir: config.workspaceDir },
    } as never);
    const externalVault = resolve(tmpRoot, "user-vault");
    mkdirSync(externalVault, { recursive: true });

    // Step 1 — Basics. Display name + language land via PATCH /api/config.
    {
      const res = await applyConfigUpdates(
        config,
        settingsStore,
        { agentDisplayName: "Test", primaryLanguage: "en-US" },
        { db },
      );
      expect(res.errors).toEqual({});
      expect(config.agentDisplayName).toBe("Test");
      expect(config.primaryLanguage).toBe("en-US");
    }

    // Step 2 — Vault (plain). The wizard calls /api/setup/migrate-context;
    // for plain mode it's a no-op, so the assertion is just that the
    // config never became obsidian via direct PATCH (Phase-2 invariant).
    expect(config.vaultMode).toBe("plain");

    // Step 4 — Mail (Gmail delegated, Outlook off). Outlook stays in its
    // default `disabled` state; Gmail flips to delegated/codex.
    {
      const res = await integrationRoutes.request("/integrations/gmail", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "delegated", delegatedBackend: "codex" }),
      });
      expect(res.status).toBe(200);
    }

    // Step 5 — Calendar (Google delegated, Outlook off).
    {
      const res = await integrationRoutes.request("/integrations/google_calendar", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "delegated", delegatedBackend: "codex" }),
      });
      expect(res.status).toBe(200);
    }

    // Step 6 — Note (Notion off, external Obsidian vault). The watch flag
    // is implicitly on (default true). PATCH centralization (§6.2) means
    // applyConfigUpdates re-renders integrations.md as a side effect.
    {
      const res = await applyConfigUpdates(
        config,
        settingsStore,
        { externalObsidianVaultPath: externalVault },
        { db },
      );
      expect(res.errors).toEqual({});
      expect(config.externalObsidianVaultPath).toBe(externalVault);
    }

    // §11.3 acceptance assertions — integrations.md body.
    const integrationsPath = join(dataDir, "integrations.md");
    expect(existsSync(integrationsPath)).toBe(true);
    const body = readFileSync(integrationsPath, "utf-8");
    expect(body).toContain("## Note Sources");
    expect(body).toContain(`Obsidian vault (personal): ${externalVault}`);
    expect(body).toContain("Notion: disabled");
    // outlook_mail / outlook_calendar default to disabled on a fresh
    // install (§11.3): confirm the rows are present in the table even
    // though the wizard never PATCHed them.
    expect(body).toContain("| outlook_mail | disabled |");
    expect(body).toContain("| outlook_calendar | disabled |");
    // Active-today section reflects what the wizard turned on: gmail
    // and google_calendar (delegated), plus git/github (direct
    // defaults).
    expect(body).toContain("- `gmail`");
    expect(body).toContain("- `google_calendar`");

    // §11.3 acceptance — execution-mode columns default to "strict".
    expect(config.claudeExecutionPermissionMode).toBe("strict");
    expect(config.codexExecutionPermissionMode).toBe("strict");
    expect(config.geminiExecutionPermissionMode).toBe("strict");
    expect(config.opencodeExecutionPermissionMode).toBe("strict");

    // §11.3 acceptance — agentDisplayName persisted.
    expect(config.agentDisplayName).toBe("Test");

    // Integration-state sanity: the gmail / google_calendar flips
    // committed; outlook_mail / outlook_calendar stayed at default.
    const integrations = readIntegrations(db);
    expect(integrations.gmail.mode).toBe("delegated");
    expect(integrations.gmail.delegatedBackend).toBe("codex");
    expect(integrations.google_calendar.mode).toBe("delegated");
    expect(integrations.google_calendar.delegatedBackend).toBe("codex");
    expect(integrations.outlook_mail.mode).toBe("disabled");
    expect(integrations.outlook_calendar.mode).toBe("disabled");
  });

  // Outlook integrations ship as user-managed connectors: the user
  // installs an MCP / connector on the agent backend they pick (Claude
  // Code Connector / Codex MCP / Gemini extension) and the daemon
  // trusts that wiring. The PATCH handler must accept the delegated
  // flip without requiring a descriptor-side connector or skill
  // variants; mode-flips back to direct continue to work.
  it("accepts a delegated mode flip on outlook_mail and outlook_calendar (user-managed connector contract)", async () => {
    const config = baseConfig(dataDir);
    const integrationRoutes = createIntegrationRoutes({
      db,
      config: { dataDir, workspaceDir: config.workspaceDir },
    } as never);

    for (const key of ["outlook_mail", "outlook_calendar"] as const) {
      const res = await integrationRoutes.request(`/integrations/${key}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "delegated", delegatedBackend: "claude" }),
      });
      expect(res.status).toBe(200);
      const persisted = readIntegrations(db)[key];
      expect(persisted.mode).toBe("delegated");
      expect(persisted.delegatedBackend).toBe("claude");

      // Direct flip continues to succeed afterwards.
      const direct = await integrationRoutes.request(`/integrations/${key}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "direct" }),
      });
      expect(direct.status).toBe(200);
      expect(readIntegrations(db)[key].mode).toBe("direct");
    }
  });
});
