import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DEFAULT_AGENT_DISPLAY_NAME } from "@aitne/shared";
import type { AgentConfig } from "../config.js";
import { applySchema } from "../db/schema.js";
import { createSettingsStore, type SettingsStore } from "../settings/settings-store.js";
import { ensureEnvFilePermissions, getEnvFilePath } from "./env-writer.js";

// The `.env` rewrite path is now atomic: openSync(tmp, "w", 0o600) →
// writeSync(fd, content) → fsyncSync(fd) → closeSync(fd) → renameSync(tmp,
// envPath). The tests still capture "what content was written to .env"
// by inspecting the writeFileSync mock's second argument — `writeSync`
// inside the mock factory below mirrors its bytes through the
// writeFileSync proxy so legacy assertions keep working unchanged.
// `vi.hoisted()` lets the proxy be referenced inside the hoisted
// `vi.mock()` factory.
const fsProxies = vi.hoisted(() => ({
  writeFileSyncProxy: vi.fn(),
}));

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  // Default `lstatSync` returns a non-symlink stat so the env-writer's
  // symlink refusal check passes through. Individual tests can override
  // to assert the symlink-refusal path.
  const nonSymlinkStat = {
    isSymbolicLink: () => false,
    isFile: () => true,
    isDirectory: () => false,
  } as ReturnType<typeof actual.lstatSync>;
  return {
    ...actual,
    writeFileSync: fsProxies.writeFileSyncProxy,
    readFileSync: vi.fn(() => ""),
    chmodSync: vi.fn(),
    lstatSync: vi.fn(() => nonSymlinkStat),
    openSync: vi.fn(() => 42),
    writeSync: vi.fn(
      (
        fd: number,
        bufOrContent: string | Buffer,
        offset?: number,
        length?: number,
      ) => {
        // env-writer uses the low-level `writeSync(fd, buf, offset, length)`
        // signature with a Buffer for partial-write resilience. Tests can
        // also exercise the simpler string signature. Mirror whichever
        // form into the legacy `writeFileSync` proxy so existing
        // assertions on `mockedFs.writeFileSync.mock.calls` keep working,
        // and return the requested length so the caller's write loop
        // exits in one iteration. Errors thrown by writeFileSyncProxy
        // propagate, preserving the "rolls back when .env write fails"
        // assertion.
        let chunk: string;
        if (typeof bufOrContent === "string") {
          chunk = bufOrContent;
        } else {
          const start = offset ?? 0;
          const end = start + (length ?? bufOrContent.length - start);
          chunk = bufOrContent.subarray(start, end).toString("utf-8");
        }
        fsProxies.writeFileSyncProxy(`<atomic-tmp:${fd}>`, chunk);
        return length ?? Buffer.byteLength(chunk);
      },
    ),
    fsyncSync: vi.fn(),
    closeSync: vi.fn(),
    renameSync: vi.fn(),
    unlinkSync: vi.fn(),
  };
});

const { applyConfigUpdates, serializeForEnv } = await import("./env-writer.js");
const mockedFs = await import("node:fs");

function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    dataDir: "/tmp/test",
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
    maxConcurrentSessions: 3,
    maxReactiveSessions: 2,
    delegatedProxyMaxConcurrent: 4,
    executeTimeoutMinutes: 60,
    sessionTimeoutDmMinutes: 60,
    sessionTimeoutChannelMinutes: 30,
    sessionTimeoutDashboardMinutes: 120,
    agentDisplayName: DEFAULT_AGENT_DISPLAY_NAME,
    character: "",
    historyInjectionMaxMessages: 50,
    historyInjectionMaxTokens: 8000,
    historyOtherSurfaceWindowMinutes: 1440,
    dmStalenessStrict: false,
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
    ...overrides,
  } as AgentConfig;
}

describe("applyConfigUpdates", () => {
  let db: Database.Database;
  let settingsStore: SettingsStore;

  beforeEach(() => {
    db = new Database(":memory:");
    applySchema(db);
    settingsStore = createSettingsStore(db);
    vi.clearAllMocks();
    (mockedFs.readFileSync as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      () => "",
    );
    (mockedFs.writeFileSync as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      () => undefined,
    );
  });

  afterEach(() => {
    db.close();
    vi.restoreAllMocks();
  });

  describe("editability", () => {
    it("rejects keys not in the editable allowlists", async () => {
      const config = makeConfig();
      const result = await applyConfigUpdates(config, settingsStore, { unknownField: "nope" });
      expect(result.updated).toEqual([]);
      expect(result.errors).toHaveProperty("unknownField");
      expect(result.errors.unknownField).toMatch(/not editable/i);
    });

    it("rejects secret fields and points callers to the secret endpoints", async () => {
      const config = makeConfig();
      const result = await applyConfigUpdates(config, settingsStore, { slackBotToken: "xoxb-secret" });
      expect(result.updated).toEqual([]);
      expect(result.errors.slackBotToken).toContain("PUT /api/secrets/");
    });

    it("accepts editable runtime keys and persists them to SQLite", async () => {
      const config = makeConfig();
      const result = await applyConfigUpdates(config, settingsStore, { executeTimeoutMinutes: 120 });
      expect(result.updated).toContain("executeTimeoutMinutes");
      expect(config.executeTimeoutMinutes).toBe(120);
      expect(settingsStore.get("executeTimeoutMinutes")).toBe(120);
      expect(mockedFs.writeFileSync).not.toHaveBeenCalled();
    });

    it("accepts character, history injection, and DM staleness runtime keys", async () => {
      const config = makeConfig();
      const result = await applyConfigUpdates(config, settingsStore, {
        character: "Be concise.",
        historyInjectionMaxMessages: 30,
        historyInjectionMaxTokens: 4000,
        dmStalenessStrict: true,
      });
      expect(result.errors).toEqual({});
      expect(result.updated).toEqual(
        expect.arrayContaining([
          "character",
          "historyInjectionMaxMessages",
          "historyInjectionMaxTokens",
          "dmStalenessStrict",
        ]),
      );
      expect(config.character).toBe("Be concise.");
      expect(config.historyInjectionMaxMessages).toBe(30);
      expect(config.historyInjectionMaxTokens).toBe(4000);
      expect(config.dmStalenessStrict).toBe(true);
    });
  });

  it("normalizes the agent display name before persisting it", async () => {
    const config = makeConfig();
    const result = await applyConfigUpdates(config, settingsStore, { agentDisplayName: "[ai bot]" });
    expect(result.errors).toEqual({});
    expect(config.agentDisplayName).toBe("ai bot");
    expect(settingsStore.get("agentDisplayName")).toBe("ai bot");
  });

  describe("executeTimeoutMinutes range validation", () => {
    it("accepts the lower boundary (1)", async () => {
      const config = makeConfig();
      const result = await applyConfigUpdates(config, settingsStore, { executeTimeoutMinutes: 1 });
      expect(result.errors).toEqual({});
      expect(config.executeTimeoutMinutes).toBe(1);
    });

    it("accepts the upper boundary (1440)", async () => {
      const config = makeConfig();
      const result = await applyConfigUpdates(config, settingsStore, { executeTimeoutMinutes: 1440 });
      expect(result.errors).toEqual({});
      expect(config.executeTimeoutMinutes).toBe(1440);
    });

    it("rejects 0 (below minimum)", async () => {
      const config = makeConfig();
      const result = await applyConfigUpdates(config, settingsStore, { executeTimeoutMinutes: 0 });
      expect(result.errors).toHaveProperty("executeTimeoutMinutes");
      expect(config.executeTimeoutMinutes).toBe(60);
    });

    it("rejects 1441 (above maximum)", async () => {
      const config = makeConfig();
      const result = await applyConfigUpdates(config, settingsStore, { executeTimeoutMinutes: 1441 });
      expect(result.errors).toHaveProperty("executeTimeoutMinutes");
      expect(config.executeTimeoutMinutes).toBe(60);
    });
  });

  describe("hourlyCheckIntervalMinutes range validation", () => {
    it("accepts 1 (minimum boundary — high-frequency check)", async () => {
      const config = makeConfig();
      const result = await applyConfigUpdates(config, settingsStore, { hourlyCheckIntervalMinutes: 1 });
      expect(result.errors).toEqual({});
      expect(config.hourlyCheckIntervalMinutes).toBe(1);
    });

    it("accepts 7 (non-divisor of 60, formerly rejected)", async () => {
      const config = makeConfig();
      const result = await applyConfigUpdates(config, settingsStore, { hourlyCheckIntervalMinutes: 7 });
      expect(result.errors).toEqual({});
      expect(config.hourlyCheckIntervalMinutes).toBe(7);
    });

    it("accepts 45 (non-divisor of 60, formerly rejected)", async () => {
      const config = makeConfig();
      const result = await applyConfigUpdates(config, settingsStore, { hourlyCheckIntervalMinutes: 45 });
      expect(result.errors).toEqual({});
      expect(config.hourlyCheckIntervalMinutes).toBe(45);
    });

    it("accepts 60 (default)", async () => {
      const config = makeConfig();
      const result = await applyConfigUpdates(config, settingsStore, { hourlyCheckIntervalMinutes: 60 });
      expect(result.errors).toEqual({});
      expect(config.hourlyCheckIntervalMinutes).toBe(60);
    });

    it("accepts 90 (>60, cost-saving cadence)", async () => {
      const config = makeConfig();
      const result = await applyConfigUpdates(config, settingsStore, { hourlyCheckIntervalMinutes: 90 });
      expect(result.errors).toEqual({});
      expect(config.hourlyCheckIntervalMinutes).toBe(90);
    });

    it("accepts 1440 (maximum boundary — one day)", async () => {
      const config = makeConfig();
      const result = await applyConfigUpdates(config, settingsStore, { hourlyCheckIntervalMinutes: 1440 });
      expect(result.errors).toEqual({});
      expect(config.hourlyCheckIntervalMinutes).toBe(1440);
    });

    it("rejects 0 (below minimum)", async () => {
      const config = makeConfig();
      const result = await applyConfigUpdates(config, settingsStore, { hourlyCheckIntervalMinutes: 0 });
      expect(result.errors).toHaveProperty("hourlyCheckIntervalMinutes");
      expect(config.hourlyCheckIntervalMinutes).toBe(60);
    });

    it("rejects 1441 (above maximum)", async () => {
      // Cap is 1440 because the modulo gate operates on
      // minutes-since-midnight, which cannot represent multi-day cadence.
      // Operators wanting weekly cadence should use weekly_review.
      const config = makeConfig();
      const result = await applyConfigUpdates(config, settingsStore, { hourlyCheckIntervalMinutes: 1441 });
      expect(result.errors).toHaveProperty("hourlyCheckIntervalMinutes");
      expect(config.hourlyCheckIntervalMinutes).toBe(60);
    });
  });

  describe("hourlyCheckActive hours", () => {
    it("accepts startHour 0 and endHour 24", async () => {
      const config = makeConfig();
      const result = await applyConfigUpdates(config, settingsStore, {
        hourlyCheckActiveStartHour: 0,
        hourlyCheckActiveEndHour: 24,
      });
      expect(result.errors).toEqual({});
      expect(config.hourlyCheckActiveStartHour).toBe(0);
      expect(config.hourlyCheckActiveEndHour).toBe(24);
    });

    it("rejects startHour 24", async () => {
      const config = makeConfig();
      const result = await applyConfigUpdates(config, settingsStore, { hourlyCheckActiveStartHour: 24 });
      expect(result.errors).toHaveProperty("hourlyCheckActiveStartHour");
    });

    it("rejects endHour 0", async () => {
      const config = makeConfig();
      const result = await applyConfigUpdates(config, settingsStore, { hourlyCheckActiveEndHour: 0 });
      expect(result.errors).toHaveProperty("hourlyCheckActiveEndHour");
    });

    it("rejects endHour 25", async () => {
      const config = makeConfig();
      const result = await applyConfigUpdates(config, settingsStore, { hourlyCheckActiveEndHour: 25 });
      expect(result.errors).toHaveProperty("hourlyCheckActiveEndHour");
    });
  });

  describe("hourlyCheckMinObservations", () => {
    it("accepts 0", async () => {
      const config = makeConfig();
      const result = await applyConfigUpdates(config, settingsStore, { hourlyCheckMinObservations: 0 });
      expect(result.errors).toEqual({});
      expect(config.hourlyCheckMinObservations).toBe(0);
    });

    it("accepts the upper boundary (1000)", async () => {
      const config = makeConfig();
      const result = await applyConfigUpdates(config, settingsStore, { hourlyCheckMinObservations: 1000 });
      expect(result.errors).toEqual({});
    });

    it("rejects negative values", async () => {
      const config = makeConfig();
      const result = await applyConfigUpdates(config, settingsStore, { hourlyCheckMinObservations: -1 });
      expect(result.errors).toHaveProperty("hourlyCheckMinObservations");
    });
  });

  describe("hourlyCheckEnabled (boolean)", () => {
    it("accepts true and false", async () => {
      const config = makeConfig();
      const off = await applyConfigUpdates(config, settingsStore, { hourlyCheckEnabled: false });
      expect(off.errors).toEqual({});
      expect(config.hourlyCheckEnabled).toBe(false);
      const on = await applyConfigUpdates(config, settingsStore, { hourlyCheckEnabled: true });
      expect(on.errors).toEqual({});
      expect(config.hourlyCheckEnabled).toBe(true);
    });

    it("rejects non-boolean values (type mismatch)", async () => {
      const config = makeConfig();
      const result = await applyConfigUpdates(config, settingsStore, { hourlyCheckEnabled: "yes" });
      expect(result.errors).toHaveProperty("hourlyCheckEnabled");
      expect(result.errors.hourlyCheckEnabled).toMatch(/type mismatch/i);
    });
  });

  describe("batch updates", () => {
    it("accepts multiple valid updates in one call", async () => {
      const config = makeConfig();
      const result = await applyConfigUpdates(config, settingsStore, {
        executeTimeoutMinutes: 90,
        hourlyCheckIntervalMinutes: 30,
        hourlyCheckMinObservations: 3,
      });
      expect(result.updated).toEqual(
        expect.arrayContaining([
          "executeTimeoutMinutes",
          "hourlyCheckIntervalMinutes",
          "hourlyCheckMinObservations",
        ]),
      );
      expect(result.errors).toEqual({});
      expect(config.executeTimeoutMinutes).toBe(90);
      expect(config.hourlyCheckIntervalMinutes).toBe(30);
      expect(config.hourlyCheckMinObservations).toBe(3);
    });

    it("applies valid fields even if one sibling is invalid", async () => {
      const config = makeConfig();
      const result = await applyConfigUpdates(config, settingsStore, {
        executeTimeoutMinutes: 120,
        // 0 is below the hourlyCheckIntervalMinutes minimum of 1.
        hourlyCheckIntervalMinutes: 0,
      });
      expect(result.updated).toContain("executeTimeoutMinutes");
      expect(result.updated).not.toContain("hourlyCheckIntervalMinutes");
      expect(result.errors).toHaveProperty("hourlyCheckIntervalMinutes");
      expect(config.executeTimeoutMinutes).toBe(120);
      expect(config.hourlyCheckIntervalMinutes).toBe(60);
    });

    it("rolls back runtime persistence when a mixed update fails during .env write", async () => {
      const config = makeConfig();
      (mockedFs.writeFileSync as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error("disk full");
      });

      await expect(
        applyConfigUpdates(config, settingsStore, {
          executeTimeoutMinutes: 120,
          apiPort: 9000,
        }),
      ).rejects.toThrow("disk full");

      expect(config.executeTimeoutMinutes).toBe(60);
      expect(config.apiPort).toBe(8321);
      expect(settingsStore.get("executeTimeoutMinutes")).toBeNull();
    });
  });

  describe("type mismatch detection", () => {
    it("rejects string value for numeric field", async () => {
      const config = makeConfig();
      const result = await applyConfigUpdates(config, settingsStore, { executeTimeoutMinutes: "fast" });
      expect(result.errors).toHaveProperty("executeTimeoutMinutes");
      expect(result.errors.executeTimeoutMinutes).toMatch(/type mismatch/i);
    });

    it("rejects NaN for numeric field without throwing", async () => {
      const config = makeConfig();
      const result = await applyConfigUpdates(config, settingsStore, {
        executeTimeoutMinutes: Number.NaN,
      });
      expect(result.errors).toHaveProperty("executeTimeoutMinutes");
      expect(config.executeTimeoutMinutes).toBe(60);
      expect(settingsStore.get("executeTimeoutMinutes")).toBeNull();
    });

    it("rejects null for structured runtime fields without throwing", async () => {
      const config = makeConfig({ notionDatabaseIds: { tasks: "db-1" } });
      const result = await applyConfigUpdates(config, settingsStore, {
        notionDatabaseIds: null,
      });
      expect(result.errors).toHaveProperty("notionDatabaseIds");
      expect(config.notionDatabaseIds).toEqual({ tasks: "db-1" });
      expect(settingsStore.get("notionDatabaseIds")).toBeNull();
    });

    it("rejects invalid apiPort values before writing .env", async () => {
      const config = makeConfig();
      const result = await applyConfigUpdates(config, settingsStore, { apiPort: 70000 });
      expect(result.errors).toHaveProperty("apiPort");
      expect(config.apiPort).toBe(8321);
      expect(mockedFs.writeFileSync).not.toHaveBeenCalled();
    });

    it("accepts null/empty for nullable string fields without type error", async () => {
      const config = makeConfig();
      const result = await applyConfigUpdates(config, settingsStore, { timezone: "" });
      expect(result.errors).toEqual({});
      expect(config.timezone).toBe("");
    });
  });

  describe("string validators", () => {
    it("rejects invalid timezone", async () => {
      const config = makeConfig();
      const result = await applyConfigUpdates(config, settingsStore, { timezone: "Invalid/Zone_999" });
      expect(result.errors).toHaveProperty("timezone");
      expect(result.errors.timezone).toContain("IANA timezone");
    });

    it("accepts valid timezone", async () => {
      const config = makeConfig();
      const result = await applyConfigUpdates(config, settingsStore, { timezone: "America/New_York" });
      expect(result.errors).toEqual({});
      expect(config.timezone).toBe("America/New_York");
    });

    it("rejects invalid whatsappOwnerPhone format", async () => {
      const config = makeConfig();
      const result = await applyConfigUpdates(config, settingsStore, { whatsappOwnerPhone: "08012345678" });
      expect(result.errors).toHaveProperty("whatsappOwnerPhone");
      expect(result.errors.whatsappOwnerPhone).toContain("E.164");
    });

    it("accepts valid whatsappOwnerPhone format", async () => {
      const config = makeConfig();
      const result = await applyConfigUpdates(config, settingsStore, { whatsappOwnerPhone: "+818012345678" });
      expect(result.errors).toEqual({});
      expect(config.whatsappOwnerPhone).toBe("+818012345678");
    });
  });

  describe("array validators", () => {
    it("rejects invalid notification platform", async () => {
      const config = makeConfig();
      const result = await applyConfigUpdates(config, settingsStore, {
        defaultNotificationPlatforms: ["slack", "carrier_pigeon"],
      });
      expect(result.errors).toHaveProperty("defaultNotificationPlatforms");
    });

    it("accepts valid notification platforms", async () => {
      const config = makeConfig();
      const result = await applyConfigUpdates(config, settingsStore, {
        defaultNotificationPlatforms: ["slack", "telegram"],
      });
      expect(result.errors).toEqual({});
      expect(config.defaultNotificationPlatforms).toEqual(["slack", "telegram"]);
    });
  });

  describe("path expansion", () => {
    it("expands ~ in externalObsidianVaultPath", async () => {
      const tmp = mkdtempSync(join(tmpdir(), "pa-env-writer-ext-"));
      try {
        const config = makeConfig({ dataDir: join(tmp, "data") });
        const vault = resolve(tmp, "vault");
        const result = await applyConfigUpdates(config, settingsStore, {
          externalObsidianVaultPath: vault,
        });
        expect(result.errors).toEqual({});
        expect(config.externalObsidianVaultPath).toBe(vault);
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });

    it("clears externalObsidianVaultPath and vaultName when null is sent", async () => {
      const tmp = mkdtempSync(join(tmpdir(), "pa-env-writer-clear-"));
      try {
        const vault = resolve(tmp, "vault");
        const config = makeConfig({
          dataDir: join(tmp, "data"),
          externalObsidianVaultPath: vault,
          externalObsidianVaultName: "MyVault",
        });
        settingsStore.setMany({
          externalObsidianVaultPath: vault,
          externalObsidianVaultName: "MyVault",
        });
        const result = await applyConfigUpdates(config, settingsStore, {
          externalObsidianVaultPath: null,
          externalObsidianVaultName: null,
        });
        expect(result.errors).toEqual({});
        expect(result.updated).toEqual(
          expect.arrayContaining([
            "externalObsidianVaultPath",
            "externalObsidianVaultName",
          ]),
        );
        expect(config.externalObsidianVaultPath).toBeNull();
        expect(config.externalObsidianVaultName).toBeNull();
        expect(settingsStore.get("externalObsidianVaultPath")).toBeNull();
        expect(settingsStore.get("externalObsidianVaultName")).toBeNull();
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });

    it("rejects a relative externalObsidianVaultPath", async () => {
      const config = makeConfig();
      const result = await applyConfigUpdates(config, settingsStore, {
        externalObsidianVaultPath: "relative-vault",
      });
      expect(result.errors.externalObsidianVaultPath).toMatch(/absolute/i);
      expect(config.externalObsidianVaultPath).toBeNull();
    });

    it("expands ~ in whatsappAuthDir", async () => {
      const config = makeConfig();
      const result = await applyConfigUpdates(config, settingsStore, { whatsappAuthDir: "~/wa-auth" });
      expect(result.errors).toEqual({});
      expect(config.whatsappAuthDir).not.toContain("~");
      expect(config.whatsappAuthDir).toContain("wa-auth");
    });

    it("expands Windows-style ~\\ in whatsappAuthDir", async () => {
      const config = makeConfig();
      const result = await applyConfigUpdates(config, settingsStore, { whatsappAuthDir: "~\\wa-auth" });
      expect(result.errors).toEqual({});
      expect(config.whatsappAuthDir).not.toContain("~");
      expect(config.whatsappAuthDir).toContain("wa-auth");
    });

    // gitRepos / githubRepos config keys removed at the unified-
    // repositories cutover (docs/design/appendices/unified-repositories.md).
    // Path expansion + owner/repo validation now lives in the
    // POST /api/repositories handler and its store, exercised in
    // repositories-store.test.ts.
  });

  describe("restart-required keys", () => {
    it("marks externalObsidianVaultPath as requiring restart", async () => {
      const tmp = mkdtempSync(join(tmpdir(), "pa-env-writer-rr-"));
      try {
        const config = makeConfig({ dataDir: join(tmp, "data") });
        const vault = resolve(tmp, "vault");
        const result = await applyConfigUpdates(config, settingsStore, {
          externalObsidianVaultPath: vault,
        });
        expect(result.requiresRestart).toContain("externalObsidianVaultPath");
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });

    it("does not mark non-restart keys", async () => {
      const config = makeConfig();
      const result = await applyConfigUpdates(config, settingsStore, { executeTimeoutMinutes: 90 });
      expect(result.requiresRestart).toEqual([]);
    });

    it("marks notionDatabaseIds as requiring restart", async () => {
      const config = makeConfig();
      const result = await applyConfigUpdates(config, settingsStore, {
        notionDatabaseIds: { tasks: "abc123" },
      });
      expect(result.requiresRestart).toContain("notionDatabaseIds");
    });
  });

  describe("notionDatabaseIds", () => {
    it("accepts a Record<string, string> and persists to SQLite", async () => {
      const config = makeConfig();
      const ids = { tasks: "db-aaa", projects: "db-bbb" };
      const result = await applyConfigUpdates(config, settingsStore, { notionDatabaseIds: ids });
      expect(result.errors).toEqual({});
      expect(result.updated).toContain("notionDatabaseIds");
      expect(config.notionDatabaseIds).toEqual(ids);
      expect(settingsStore.get("notionDatabaseIds")).toEqual(ids);
      expect(mockedFs.writeFileSync).not.toHaveBeenCalled();
    });

    it("replaces the entire mapping on update", async () => {
      const config = makeConfig({ notionDatabaseIds: { tasks: "old-id" } });
      const result = await applyConfigUpdates(config, settingsStore, {
        notionDatabaseIds: { projects: "new-id" },
      });
      expect(result.errors).toEqual({});
      expect(config.notionDatabaseIds).toEqual({ projects: "new-id" });
    });

    it("accepts an empty object to clear all mappings", async () => {
      const config = makeConfig({ notionDatabaseIds: { tasks: "db-id" } });
      const result = await applyConfigUpdates(config, settingsStore, { notionDatabaseIds: {} });
      expect(result.errors).toEqual({});
      expect(config.notionDatabaseIds).toEqual({});
    });
  });

  describe("dayBoundaryHour range validation", () => {
    it("accepts 0", async () => {
      const config = makeConfig();
      const result = await applyConfigUpdates(config, settingsStore, { dayBoundaryHour: 0 });
      expect(result.errors).toEqual({});
      expect(config.dayBoundaryHour).toBe(0);
    });

    it("accepts 9", async () => {
      const config = makeConfig();
      const result = await applyConfigUpdates(config, settingsStore, { dayBoundaryHour: 9 });
      expect(result.errors).toEqual({});
    });

    it("rejects 10", async () => {
      const config = makeConfig();
      const result = await applyConfigUpdates(config, settingsStore, { dayBoundaryHour: 10 });
      expect(result.errors).toHaveProperty("dayBoundaryHour");
    });
  });

  // Legacy tier max turns range validation removed — lightMaxTurns/heavyMaxTurns
  // no longer exist in the editable config key set.

  // ── DELEGATED-PROXY-API-DESIGN.md §C5 — delegatedProxyMaxConcurrent ──────

  describe("delegatedProxyMaxConcurrent", () => {
    it("round-trips a numeric update through SQLite + AgentConfig", async () => {
      const config = makeConfig({ delegatedProxyMaxConcurrent: 4 });
      const result = await applyConfigUpdates(config, settingsStore, {
        delegatedProxyMaxConcurrent: 8,
      });
      expect(result.errors).toEqual({});
      expect(result.updated).toContain("delegatedProxyMaxConcurrent");
      expect(config.delegatedProxyMaxConcurrent).toBe(8);
    });

    it("rejects 0 (zod min(1))", async () => {
      const config = makeConfig({ delegatedProxyMaxConcurrent: 4 });
      const result = await applyConfigUpdates(config, settingsStore, {
        delegatedProxyMaxConcurrent: 0,
      });
      expect(result.errors).toHaveProperty("delegatedProxyMaxConcurrent");
      expect(config.delegatedProxyMaxConcurrent).toBe(4);
    });

    it("rejects values above the cap (zod max(64))", async () => {
      const config = makeConfig({ delegatedProxyMaxConcurrent: 4 });
      const result = await applyConfigUpdates(config, settingsStore, {
        delegatedProxyMaxConcurrent: 100,
      });
      expect(result.errors).toHaveProperty("delegatedProxyMaxConcurrent");
    });
  });

  describe(".env atomic-write safety", () => {
    // Atomic rename does not follow symlinks like the legacy
    // `writeFileSync` did. Surfacing the symlink as a clear error keeps
    // the behavior change from happening silently for any user who
    // intentionally symlinked `.env` — they get an actionable EENV_TARGET_SYMLINK
    // instead of waking up to find the symlink replaced with a regular file.
    it("refuses to overwrite a symlinked .env with EENV_TARGET_SYMLINK", async () => {
      const config = makeConfig();
      (mockedFs.lstatSync as unknown as ReturnType<typeof vi.fn>).mockImplementation(
        () => ({
          isSymbolicLink: () => true,
          isFile: () => false,
          isDirectory: () => false,
        }),
      );

      await expect(
        applyConfigUpdates(config, settingsStore, { apiPort: 9001 }),
      ).rejects.toThrow(/refusing to overwrite symlinked \.env/);

      // The SQLite tx wraps both the runtime settings setMany AND the
      // .env write. The pre-rename refusal must propagate out of the
      // tx callback so that no settings_json row is committed when the
      // .env write was rejected.
      expect(config.apiPort).toBe(8321);
      // The proxy write never fires because the refusal short-circuits
      // before openSync.
      expect(mockedFs.writeFileSync).not.toHaveBeenCalled();
    });

    // ENOENT from lstat — fresh install, no .env yet — must NOT throw.
    // The write proceeds and creates the file via renameSync(tmp, env).
    it("treats ENOENT from lstat as 'no existing .env' and writes through", async () => {
      const config = makeConfig();
      (mockedFs.lstatSync as unknown as ReturnType<typeof vi.fn>).mockImplementation(
        () => {
          const err = new Error("ENOENT: no such file or directory") as NodeJS.ErrnoException;
          err.code = "ENOENT";
          throw err;
        },
      );

      const result = await applyConfigUpdates(config, settingsStore, { apiPort: 9002 });
      expect(result.errors).toEqual({});
      expect(result.updated).toContain("apiPort");
      expect(config.apiPort).toBe(9002);
      // The atomic-write codepath did fire — writeSync mirrored through
      // the proxy.
      expect(mockedFs.writeFileSync).toHaveBeenCalled();
    });
  });

  describe(".env line-ending handling (cross-platform)", () => {
    // A `.env` edited on Windows ends each line with CRLF. The previous
    // `content.split("\n")` kept `\r` on every untouched line, so a rewrite
    // produced a file with mixed line endings — clean LF on the keys we just
    // updated, CRLF on the rest. The fix normalizes the output to LF.
    it("normalizes CRLF input to an LF-only rewrite", async () => {
      const config = makeConfig();
      (mockedFs.readFileSync as unknown as ReturnType<typeof vi.fn>).mockImplementation(
        () => "# header\r\nPA_API_PORT=8321\r\nOTHER_FIELD=keep-me\r\n",
      );

      const result = await applyConfigUpdates(config, settingsStore, { apiPort: 8322 });
      expect(result.errors).toEqual({});

      const writeMock = mockedFs.writeFileSync as unknown as ReturnType<typeof vi.fn>;
      expect(writeMock).toHaveBeenCalledTimes(1);
      const written = String(writeMock.mock.calls[0][1]);

      expect(written).not.toContain("\r");
      expect(written).toContain("PA_API_PORT=8322");
      expect(written).toContain("OTHER_FIELD=keep-me");
      expect(written).toContain("# header");
    });
  });
});


describe("ensureEnvFilePermissions", () => {

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("silently returns if file does not exist (ENOENT)", async () => {
    const { chmodSync } = mockedFs as unknown as { chmodSync: ReturnType<typeof vi.fn> };
    chmodSync.mockImplementation(() => {
      const err = new Error("ENOENT") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    });

    expect(() => ensureEnvFilePermissions("/nonexistent/.env")).not.toThrow();
  });

  it("rethrows non-ENOENT errors", async () => {
    const { chmodSync } = mockedFs as unknown as { chmodSync: ReturnType<typeof vi.fn> };
    chmodSync.mockImplementation(() => {
      const err = new Error("EPERM") as NodeJS.ErrnoException;
      err.code = "EPERM";
      throw err;
    });

    expect(() => ensureEnvFilePermissions("/tmp/.env")).toThrow("EPERM");
  });
});

describe("getEnvFilePath", () => {

  it("returns a path ending with .env", async () => {
    const path = getEnvFilePath();
    expect(path).toMatch(/\.env$/);
  });
});

describe("serializeForEnv", () => {
  // A raw newline in a scalar env value would be written verbatim as
  // `KEY=foo\nBAR=...`, and dotenv would parse the injected `BAR=...` as a
  // separate variable on next load — silently corrupting `.env`. The scalar
  // path strips CR/LF so no such injection survives.
  it("collapses a bare LF in a scalar to a single space", () => {
    expect(serializeForEnv("foo\nBAR=evil")).toBe("foo BAR=evil");
  });

  it("collapses CRLF and runs of line breaks to a single space", () => {
    expect(serializeForEnv("a\r\nb")).toBe("a b");
    expect(serializeForEnv("a\n\n\nb")).toBe("a b");
    expect(serializeForEnv("a\r\r\nb")).toBe("a b");
  });

  it("leaves a clean scalar string untouched", () => {
    expect(serializeForEnv("/Users/me/vault")).toBe("/Users/me/vault");
  });

  it("coerces non-string scalars to their string form", () => {
    expect(serializeForEnv(8321)).toBe("8321");
    expect(serializeForEnv(true)).toBe("true");
  });

  it("returns an empty string for null and undefined", () => {
    expect(serializeForEnv(null)).toBe("");
    expect(serializeForEnv(undefined)).toBe("");
  });

  it("JSON-encodes arrays and objects on a single line, escaping embedded newlines", () => {
    expect(serializeForEnv(["a", "b"])).toBe('["a","b"]');
    // JSON.stringify escapes \n to a literal backslash-n, so the serialized
    // form stays single-line and cannot inject a second env line.
    const encoded = serializeForEnv({ note: "line1\nline2" });
    expect(encoded).toBe('{"note":"line1\\nline2"}');
    expect(encoded).not.toContain("\n");
  });
});
