import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  getContextDir,
  getDbPath,
  getFsInfo,
  getLogsDir,
  getTmpDir,
  isRoadmapStale,
  loadBootstrapConfig,
  loadConfig,
  loadDefaultRuntimeSettings,
  mergeRuntimeSettingsFromDb,
  pickRuntimeSettings,
  validatePrimaryVaultPath,
  validateExternalObsidianVaultPath,
} from "./config.js";
import type { AgentConfig } from "./config.js";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { DEFAULT_AGENT_DISPLAY_NAME } from "@aitne/shared";
import { DEFAULT_DISALLOWED_TOOLS } from "./settings/runtime-settings.js";

describe("loadConfig", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("PA_")) delete process.env[key];
    }
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("loads with minimal required config", () => {
    const config = loadConfig();

    expect(config.agentDisplayName).toBe(DEFAULT_AGENT_DISPLAY_NAME);
    expect(config.apiPort).toBe(8321);
    expect(config.dayBoundaryHour).toBe(4);
    expect(config.activityScanIntervalMinutes).toBe(120);
    expect(config.historyOtherSurfaceWindowMinutes).toBe(1440);
    expect(config.dmStalenessStrict).toBe(false);
    expect(config.proactiveForwardChannelTimelineEnabled).toBe(true);
    expect(config.proactiveForwardForceFreshSession).toBe(false);
    expect(config.opencodeExecutionPermissionMode).toBe("strict");
    expect(config.opencodeBaseUrl).toBe("http://127.0.0.1:4096");
    expect(config.opencodeServerUsername).toBe("opencode");
  });

  it("applies custom values from env", () => {
    process.env.PA_API_PORT = "9999";
    process.env.PA_ACTIVITY_SCAN_INTERVAL_MINUTES = "30";
    process.env.PA_PRIMARY_PLATFORM = "telegram";
    process.env.PA_AGENT_DISPLAY_NAME = "[ai bot]";
    process.env.PA_WHATSAPP_ENABLED = "true";
    process.env.PA_WHATSAPP_OWNER_PHONE = "+818012345678";
    process.env.PA_HISTORY_OTHER_SURFACE_WINDOW_MINUTES = "60";
    process.env.PA_DM_STALENESS_STRICT = "true";
    process.env.PA_PROACTIVE_FORWARD_CHANNEL_TIMELINE_ENABLED = "false";
    process.env.PA_PROACTIVE_FORWARD_FORCE_FRESH_SESSION = "true";
    process.env.PA_OPENCODE_EXECUTION_PERMISSION_MODE = "allow";
    process.env.PA_OPENCODE_BASE_URL = "https://opencode.example.test";
    process.env.PA_OPENCODE_SERVER_USERNAME = "agent";

    const config = loadConfig();

    expect(config.apiPort).toBe(9999);
    expect(config.activityScanIntervalMinutes).toBe(30);
    expect(config.primaryPlatform).toBe("telegram");
    expect(config.agentDisplayName).toBe("ai bot");
    expect(config.whatsappEnabled).toBe(true);
    expect(config.whatsappOwnerPhone).toBe("+818012345678");
    expect(config.historyOtherSurfaceWindowMinutes).toBe(60);
    expect(config.dmStalenessStrict).toBe(true);
    expect(config.proactiveForwardChannelTimelineEnabled).toBe(false);
    expect(config.proactiveForwardForceFreshSession).toBe(true);
    expect(config.opencodeExecutionPermissionMode).toBe("allow");
    expect(config.opencodeBaseUrl).toBe("https://opencode.example.test");
    expect(config.opencodeServerUsername).toBe("agent");
  });

  // gitRepos / gitWatchedRepos / githubRepos config keys removed at the
  // unified-repositories cutover (docs/design/appendices/unified-repositories.md);
  // their data lives in the `repositories` DB table now. The CRUD path
  // is `POST /api/repositories`, exercised in repositories-store.test.ts.

  it("expands ~ in dataDir", () => {
    const config = loadConfig();

    expect(config.dataDir).not.toContain("~");
    expect(config.dataDir).toContain("personal-agent");
  });

  it("defaults B-007 primaryLanguage=en and vaultMode=plain", () => {
    const config = loadConfig();
    expect(config.primaryLanguage).toBe("en");
    expect(config.vaultMode).toBe("plain");
  });

  it("reads PA_PRIMARY_LANGUAGE and PA_VAULT_MODE from env", () => {
    process.env.PA_PRIMARY_LANGUAGE = "ja";
    process.env.PA_VAULT_MODE = "obsidian";
    const config = loadConfig();
    expect(config.primaryLanguage).toBe("ja");
    expect(config.vaultMode).toBe("obsidian");
  });

  it("rejects invalid PA_PRIMARY_LANGUAGE", () => {
    process.env.PA_PRIMARY_LANGUAGE = "xyz123";
    expect(() => loadConfig()).toThrow();
  });

  it("rejects invalid PA_VAULT_MODE", () => {
    process.env.PA_VAULT_MODE = "hybrid";
    expect(() => loadConfig()).toThrow();
  });

  it("has correct default disallowedTools", () => {
    const config = loadConfig();

    expect(config.disallowedTools).toEqual([...DEFAULT_DISALLOWED_TOOLS]);
    expect(config.disallowedTools).toContain("Read(~/Library/Keychains/**)");
    expect(config.disallowedTools).toContain("Read(~/.personal-agent/backups/**)");
    expect(config.disallowedTools).toContain("Read(~/.personal-agent/whatsapp/auth/**)");
  });

  it("rejects invalid WhatsApp owner phone formats", () => {
    process.env.PA_WHATSAPP_OWNER_PHONE = "08012345678";

    expect(() => loadConfig()).toThrow(
      "PA_WHATSAPP_OWNER_PHONE must be E.164",
    );
  });

  it("merges persisted runtime settings over env defaults", () => {
    process.env.PA_AGENT_DISPLAY_NAME = "Env Name";
    const config = loadConfig();

    mergeRuntimeSettingsFromDb(config, {
      agentDisplayName: "[DB Name]",
      executeTimeoutMinutes: 90,
    });

    expect(config.agentDisplayName).toBe("DB Name");
    expect(config.executeTimeoutMinutes).toBe(90);
  });

});

describe("validatePrimaryVaultPath", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "pa-validate-"));
    mkdirSync(resolve(tmpRoot, "data"), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("accepts a sibling directory of dataDir", () => {
    const result = validatePrimaryVaultPath(resolve(tmpRoot, "vault"), {
      dataDir: resolve(tmpRoot, "data"),
    });
    expect(result.ok).toBe(true);
    // fsInfo is opt-in to avoid polluting every success path with
    // case-sensitivity probe side effects.
    expect(result.fsInfo).toBeUndefined();
  });

  it("accepts a normalized absolute path with a trailing separator", () => {
    const vault = `${resolve(tmpRoot, "vault-with-trailing")}/`;
    const result = validatePrimaryVaultPath(vault, {
      dataDir: resolve(tmpRoot, "data"),
    });
    expect(result.ok).toBe(true);
  });

  it("returns fsInfo when collectFsInfo=true", () => {
    const result = validatePrimaryVaultPath(
      resolve(tmpRoot, "vault-fs"),
      { dataDir: resolve(tmpRoot, "data") },
      { collectFsInfo: true },
    );
    expect(result.ok).toBe(true);
    expect(result.fsInfo).toBeDefined();
    expect(typeof result.fsInfo?.caseSensitive).toBe("boolean");
  });

  it("does not mkdir when autoCreate=false (read-only probe)", () => {
    const vault = resolve(tmpRoot, "ephemeral");
    const result = validatePrimaryVaultPath(
      vault,
      { dataDir: resolve(tmpRoot, "data") },
      { autoCreate: false },
    );
    expect(result.ok).toBe(false);
    expect(result.error).toBe("not_directory");
    // Critical: the probe must not have silently created the directory.
    // Without this check the health probe would paper over user-intentional
    // vault deletion by re-creating the tree every 30 seconds.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { existsSync } = require("node:fs") as typeof import("node:fs");
    expect(existsSync(vault)).toBe(false);
  });

  it("accepts a missing leaf when allowMissingLeaf=true", () => {
    const vault = resolve(tmpRoot, "candidate-vault");
    const result = validatePrimaryVaultPath(
      vault,
      { dataDir: resolve(tmpRoot, "data") },
      { autoCreate: false, allowMissingLeaf: true, collectFsInfo: true },
    );
    expect(result.ok).toBe(true);
    expect(result.fsInfo).toBeDefined();
    expect(existsSync(vault)).toBe(false);
  });

  it("rejects a relative path", () => {
    const result = validatePrimaryVaultPath("./vault", {
      dataDir: resolve(tmpRoot, "data"),
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("not_absolute");
  });

  it("rejects a path containing ..", () => {
    const result = validatePrimaryVaultPath(`${tmpRoot}/../x`, {
      dataDir: resolve(tmpRoot, "data"),
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("not_absolute");
  });

  it("rejects a path equal to dataDir", () => {
    const result = validatePrimaryVaultPath(resolve(tmpRoot, "data"), {
      dataDir: resolve(tmpRoot, "data"),
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("overlaps_data_dir");
  });

  it("rejects a path under dataDir", () => {
    const result = validatePrimaryVaultPath(resolve(tmpRoot, "data", "nested"), {
      dataDir: resolve(tmpRoot, "data"),
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("overlaps_data_dir");
  });

  it("rejects a dataDir that lives inside the vault path", () => {
    const vaultPath = resolve(tmpRoot, "outer");
    mkdirSync(vaultPath, { recursive: true });
    const result = validatePrimaryVaultPath(vaultPath, {
      dataDir: resolve(tmpRoot, "outer", "data"),
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("overlaps_data_dir");
  });

  it("rejects a system path", () => {
    const result = validatePrimaryVaultPath("/System/Library/foo", {
      dataDir: resolve(tmpRoot, "data"),
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("system_path");
  });

  it("rejects overlap with the configured external Obsidian vault", () => {
    const externalVaultPath = resolve(tmpRoot, "external-vault");
    mkdirSync(externalVaultPath, { recursive: true });

    const result = validatePrimaryVaultPath(resolve(externalVaultPath, "agent"), {
      dataDir: resolve(tmpRoot, "data"),
      externalObsidianVaultPath: externalVaultPath,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBe("overlaps_external_vault");
  });
});

describe("validateExternalObsidianVaultPath", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "pa-validate-ext-"));
    mkdirSync(resolve(tmpRoot, "data"), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("rejects an external vault equal to the primary vault", () => {
    const primary = resolve(tmpRoot, "primary");
    mkdirSync(primary, { recursive: true });
    const result = validateExternalObsidianVaultPath(primary, {
      dataDir: resolve(tmpRoot, "data"),
      primaryVaultPath: primary,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("overlaps_primary_vault");
  });

  it("accepts disjoint external and primary vaults", () => {
    const primary = resolve(tmpRoot, "primary");
    const external = resolve(tmpRoot, "external");
    mkdirSync(primary, { recursive: true });
    const result = validateExternalObsidianVaultPath(external, {
      dataDir: resolve(tmpRoot, "data"),
      primaryVaultPath: primary,
    });
    expect(result.ok).toBe(true);
  });

  it("rejects a relative external vault path", () => {
    const result = validateExternalObsidianVaultPath("./external", {
      dataDir: resolve(tmpRoot, "data"),
      primaryVaultPath: null,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("not_absolute");
  });
});

describe("getContextDir (Management Mode)", () => {
  let tmpRoot: string;
  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "pa-getctx-"));
  });
  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("returns dataDir/context in plain mode", () => {
    const dataDir = resolve(tmpRoot, "data");
    const result = getContextDir({ dataDir, vaultMode: "plain", primaryVaultPath: null });
    expect(result).toBe(resolve(dataDir, "context"));
  });

  it("returns primaryVaultPath in obsidian mode when set", () => {
    const dataDir = resolve(tmpRoot, "data");
    const vault = resolve(tmpRoot, "vault");
    const result = getContextDir({ dataDir, vaultMode: "obsidian", primaryVaultPath: vault });
    expect(result).toBe(vault);
  });

  it("falls back to dataDir/context in obsidian mode without primaryVaultPath", () => {
    const dataDir = resolve(tmpRoot, "data");
    const result = getContextDir({ dataDir, vaultMode: "obsidian", primaryVaultPath: null });
    expect(result).toBe(resolve(dataDir, "context"));
  });

  it("preserves the legacy { dataDir }-only signature", () => {
    const dataDir = resolve(tmpRoot, "data");
    expect(getContextDir({ dataDir })).toBe(resolve(dataDir, "context"));
  });
});

describe("path helpers", () => {
  it("getDbPath returns path under dataDir/data/", () => {
    const result = getDbPath({ dataDir: "/home/user/.personal-agent" });
    expect(result).toBe(resolve("/home/user/.personal-agent", "data", "personal_agent.db"));
  });

  it("getLogsDir returns path under dataDir/logs/", () => {
    const result = getLogsDir({ dataDir: "/home/user/.personal-agent" });
    expect(result).toBe(resolve("/home/user/.personal-agent", "logs"));
  });

  it("getTmpDir returns path under dataDir/tmp/", () => {
    const result = getTmpDir({ dataDir: "/home/user/.personal-agent" });
    expect(result).toBe(resolve("/home/user/.personal-agent", "tmp"));
  });

  it("detects Windows cloud-sync paths after separator normalization", () => {
    const info = getFsInfo("C:\\Users\\me\\OneDrive - Example\\Vault");
    expect(info.isCloudSync).toBe("onedrive");
  });
});

describe("isRoadmapStale", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "pa-roadmap-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns true when roadmap.md does not exist", () => {
    expect(isRoadmapStale(tmpDir)).toBe(true);
  });

  it("returns true when roadmap.md contains placeholder text", () => {
    mkdirSync(join(tmpDir, "plans"), { recursive: true });
    writeFileSync(join(tmpDir, "plans", "roadmap.md"), "# Roadmap\n(Not yet configured)\n");
    expect(isRoadmapStale(tmpDir)).toBe(true);
  });

  it("returns false for a fresh roadmap without placeholder", () => {
    mkdirSync(join(tmpDir, "plans"), { recursive: true });
    writeFileSync(join(tmpDir, "plans", "roadmap.md"), "# Roadmap\n- Build the thing\n");
    expect(isRoadmapStale(tmpDir)).toBe(false);
  });

  it("returns true for a roadmap older than maxAgeDays", () => {
    const roadmapPath = join(tmpDir, "plans", "roadmap.md");
    mkdirSync(join(tmpDir, "plans"), { recursive: true });
    writeFileSync(roadmapPath, "# Roadmap\n- Stuff\n");
    // Backdate mtime by 20 days
    const oldTime = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000);
    utimesSync(roadmapPath, oldTime, oldTime);
    expect(isRoadmapStale(tmpDir)).toBe(true);
  });

  it("returns false for a roadmap within custom maxAgeDays", () => {
    mkdirSync(join(tmpDir, "plans"), { recursive: true });
    writeFileSync(join(tmpDir, "plans", "roadmap.md"), "# Roadmap\n- Stuff\n");
    expect(isRoadmapStale(tmpDir, 30)).toBe(false);
  });
});


describe("parse edge cases via loadConfig", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("PA_")) delete process.env[key];
    }
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("falls back on NaN for numeric config", () => {
    process.env.PA_API_PORT = "abc";
    const config = loadConfig();
    expect(config.apiPort).toBe(8321);
  });

  it("parses boolean '0' as false", () => {
    process.env.PA_ACTIVITY_SCAN_ENABLED = "0";
    const config = loadConfig();
    expect(config.activityScanEnabled).toBe(false);
  });

  it("parses boolean '1' as true", () => {
    process.env.PA_ACTIVITY_SCAN_ENABLED = "1";
    const config = loadConfig();
    expect(config.activityScanEnabled).toBe(true);
  });

  it("parses boolean 'false' as false", () => {
    process.env.PA_ACTIVITY_SCAN_ENABLED = "false";
    expect(loadConfig().activityScanEnabled).toBe(false);
  });

  it("parses boolean 'true' as true", () => {
    process.env.PA_ACTIVITY_SCAN_ENABLED = "true";
    expect(loadConfig().activityScanEnabled).toBe(true);
  });

  it("falls back on unrecognized boolean string", () => {
    process.env.PA_ACTIVITY_SCAN_ENABLED = "garbage";
    const config = loadConfig();
    // default is true
    expect(config.activityScanEnabled).toBe(true);
  });


  it("expands ~ in primaryVaultPath via PA_PRIMARY_VAULT_PATH", () => {
    process.env.PA_PRIMARY_VAULT_PATH = "~/Documents/primary";
    const config = loadConfig();
    expect(config.primaryVaultPath).not.toContain("~");
    expect(config.primaryVaultPath).toContain("Documents/primary");
  });

  it("expands ~ in whatsappAuthDir", () => {
    process.env.PA_WHATSAPP_AUTH_DIR = "~/whatsapp-auth";
    const config = loadConfig();
    expect(config.whatsappAuthDir).not.toContain("~");
    expect(config.whatsappAuthDir).toContain("whatsapp-auth");
  });

  it("handles disallowedTools as explicit JSON array", () => {
    process.env.PA_DISALLOWED_TOOLS = '["Bash(rm -rf *)"]';
    const config = loadConfig();
    expect(config.disallowedTools).toEqual(["Bash(rm -rf *)"]);
  });

  it("parses allowedToolsOverride as null by default", () => {
    const config = loadConfig();
    expect(config.allowedToolsOverride).toBeNull();
  });

  it("parses autonomousDailyCostCapUsd when env var is set", () => {
    process.env.PA_AUTONOMOUS_DAILY_COST_CAP_USD = "10.5";
    const config = loadConfig();
    expect(config.autonomousDailyCostCapUsd).toBe(10.5);
  });
});

describe("pickRuntimeSettings", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("PA_")) delete process.env[key];
    }
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("extracts runtime settings from full config", () => {
    const config = loadConfig();
    const runtime = pickRuntimeSettings(config);

    expect(runtime.agentDisplayName).toBe(DEFAULT_AGENT_DISPLAY_NAME);
    // bootstrap keys should NOT be in runtime
    expect((runtime as Record<string, unknown>).dataDir).toBeUndefined();
    expect((runtime as Record<string, unknown>).apiPort).toBeUndefined();
  });
});
