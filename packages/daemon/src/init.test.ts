import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DEFAULT_AGENT_DISPLAY_NAME } from "@aitne/shared";
import type { AgentConfig } from "./config.js";
import { initDirectories } from "./init.js";

function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    dataDir: "/tmp/personal-agent",
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
    advisorEnabled: false,
    advisorModel: null,
    enforceReadToken: true,
    maxConcurrentSessions: 3,
    maxReactiveSessions: 2,
    executeTimeoutMinutes: 60,
    sessionTimeoutDmMinutes: 60,
    sessionTimeoutChannelMinutes: 30,
    sessionTimeoutDashboardMinutes: 120,
    historyInjectionMaxMessages: 20,
    historyInjectionMaxTokens: 4000,
    agentDisplayName: DEFAULT_AGENT_DISPLAY_NAME,
    character: "",
    timezone: "",
    dayBoundaryHour: 4,
    activityScanEnabled: true,
    activityScanIntervalMinutes: 60,
    activityScanActiveStartHour: 4,
    activityScanActiveEndHour: 24,
    activityScanMinObservations: 1,
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
    disallowedTools: [],
    allowedToolsOverride: null,
    obsidianDebounceSeconds: 5,
    gitPollIntervalSeconds: 300,
    notionPollIntervalSeconds: 300,
    calendarPollIntervalSeconds: 300,
    gmailPollIntervalSeconds: 600,
    enabledMailProviders: ["gmail"],
    mailPollIntervalSeconds: 180,
    mailIdleEnabled: true,
    mailIdleInstabilityThreshold: 3,
    mailIdleFallbackRecoveryMinutes: 60,
    mailMaxMessagesPerPoll: 20,
    mailAuthFailureRetryHours: 6,
    activityScanObservationCharBudget: 8000,
    outlookDeltaPageSize: 50,
    outlookGraphConcurrency: 3,
    imapReconnectBaseMs: 2000,
    imapReconnectMaxMs: 300000,
    autonomousDailyCostCapUsd: null,
    autonomousMonthlyCostCapUsd: null,
    primaryLanguage: "en",
    vaultMode: "plain",
    ...overrides,
  } as AgentConfig;
}

describe("initDirectories", () => {
  const createdRoots: string[] = [];

  afterEach(() => {
    while (createdRoots.length > 0) {
      rmSync(createdRoots.pop()!, { recursive: true, force: true });
    }
  });

  it("creates the fallback context tree under dataDir", () => {
    const root = mkdtempSync(join(tmpdir(), "pa-init-"));
    createdRoots.push(root);
    const dataDir = resolve(root, "data");

    initDirectories(makeConfig({ dataDir }));

    expect(existsSync(resolve(dataDir, "context"))).toBe(true);
    expect(existsSync(resolve(dataDir, "context", "policies"))).toBe(true);
    expect(existsSync(resolve(dataDir, "context", "identity"))).toBe(true);
    expect(existsSync(resolve(dataDir, "context", "state"))).toBe(true);
    expect(existsSync(resolve(dataDir, "context", "plans"))).toBe(true);
    expect(existsSync(resolve(dataDir, "context", "journal"))).toBe(true);
    expect(existsSync(resolve(dataDir, "context", "knowledge"))).toBe(true);
    expect(existsSync(resolve(dataDir, "data"))).toBe(true);
    expect(existsSync(resolve(dataDir, "logs"))).toBe(true);
    expect(existsSync(resolve(dataDir, "tmp"))).toBe(true);
    expect(existsSync(resolve(dataDir, "secrets"))).toBe(true);
  });

  it("does not pre-create primaryVaultPath before validation", () => {
    const root = mkdtempSync(join(tmpdir(), "pa-init-vault-"));
    createdRoots.push(root);
    const dataDir = resolve(root, "data");
    const primaryVaultPath = resolve(root, "missing-parent", "primary-vault");

    initDirectories(makeConfig({
      dataDir,
      vaultMode: "obsidian",
      primaryVaultPath,
    }));

    expect(existsSync(resolve(dataDir, "context"))).toBe(true);
    expect(existsSync(primaryVaultPath)).toBe(false);
  });
});
