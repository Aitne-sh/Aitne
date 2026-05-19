/**
 * Integration tests for Management Mode (Phase 1, plan §Phase 1 "Done when").
 *
 * Covers the four wiring scenarios unit tests can't prove end-to-end:
 *   1. Daemon startup transitions into degraded mode on a misconfigured
 *      `primaryVaultPath` + obsidian mode combination.
 *   2. `PA_VAULT_STRICT=1` turns degraded mode into fail-fast exit.
 *   3. The 30-second health probe lifts degraded mode once the path
 *      becomes reachable again.
 *   4. PATCH /api/config invokes the new validators and surfaces
 *      structured errors for invalid paths.
 *
 * These tests exercise the actual named helpers (`runVaultHealthProbe`,
 * `applyConfigUpdates`, `createContextRoutes`) rather than spawning a
 * daemon subprocess — the startup sequence's relevant side effects are
 * reachable through the helpers alone.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { Hono } from "hono";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DEFAULT_AGENT_DISPLAY_NAME } from "@aitne/shared";

import {
  runVaultHealthProbe,
  type AgentConfig,
} from "./config.js";
import { applyConfigUpdates } from "./api/env-writer.js";
import { createContextRoutes } from "./api/routes/context/index.js";
import { createHealthRoutes } from "./api/routes/health.js";
import { applySchema } from "./db/schema.js";
import {
  getDegradedMode,
  isDegraded,
  setDegradedMode,
} from "./db/runtime-state.js";
import { createSettingsStore, type SettingsStore } from "./settings/settings-store.js";

function baseConfig(dataDir: string, overrides: Partial<AgentConfig> = {}): AgentConfig {
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
    sessionTimeoutDmMinutes: 60,
    sessionTimeoutChannelMinutes: 30,
    sessionTimeoutDashboardMinutes: 120,
    agentDisplayName: DEFAULT_AGENT_DISPLAY_NAME,
    character: "",
    historyInjectionMaxMessages: 50,
    historyInjectionMaxTokens: 8000,
    authProbeDisabled: false,
    authPreflightFreshnessMs: 600_000,
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
    disallowedTools: [],
    allowedToolsOverride: null,
    obsidianDebounceSeconds: 5,
    gitPollIntervalSeconds: 300,
    notionPollIntervalSeconds: 300,
    calendarPollIntervalSeconds: 300,
    gmailPollIntervalSeconds: 600,
    autonomousDailyCostCapUsd: null,
    autonomousMonthlyCostCapUsd: null,
    primaryLanguage: "en",
    vaultMode: "plain",
    ...overrides,
  } as unknown as AgentConfig;
}

function seedSetupComplete(dataDir: string): void {
  // runVaultHealthProbe skips degraded mode while `rules/management.md`
  // is missing (bootstrapping bypass). Integration scenarios that want to
  // exercise the full degraded-mode behavior need to materialize this
  // sentinel file so the probe treats the daemon as "setup is done".
  const rulesDir = resolve(dataDir, "context", "rules");
  mkdirSync(rulesDir, { recursive: true });
  writeFileSync(resolve(rulesDir, "management.md"), "# Management\n");
}

describe("Management Mode — integration", () => {
  let tmpRoot: string;
  let dataDir: string;
  let db: Database.Database;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "pa-mm-integration-"));
    dataDir = resolve(tmpRoot, "data");
    mkdirSync(dataDir, { recursive: true });
    db = new Database(":memory:");
    applySchema(db);
  });

  afterEach(() => {
    db.close();
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  describe("(1) startup transitions into degraded mode", () => {
    it("obsidian mode + null primaryVaultPath + setup complete → degraded", () => {
      seedSetupComplete(dataDir);
      const config = baseConfig(dataDir, {
        vaultMode: "obsidian",
        primaryVaultPath: null,
      });

      const probe = runVaultHealthProbe(config, db);

      expect(probe.action).toBe("entered");
      expect(probe.reason).toBe("primary_vault_not_configured");
      expect(isDegraded(db)).toBe(true);
      expect(getDegradedMode(db)?.reason).toBe("primary_vault_not_configured");
    });

    it("obsidian mode + unreachable primaryVaultPath → degraded", () => {
      seedSetupComplete(dataDir);
      const config = baseConfig(dataDir, {
        vaultMode: "obsidian",
        primaryVaultPath: "/nonexistent/path-that-does-not-exist/vault",
      });

      const probe = runVaultHealthProbe(config, db);

      expect(probe.action).toBe("entered");
      expect(probe.reason).toBe("primary_vault_unreachable");
      expect(getDegradedMode(db)?.path).toBe(
        "/nonexistent/path-that-does-not-exist/vault",
      );
    });

    it("bootstrapping bypass — setup incomplete does NOT degrade even in obsidian mode", () => {
      // NOTE: rules/management.md intentionally NOT seeded.
      const config = baseConfig(dataDir, {
        vaultMode: "obsidian",
        primaryVaultPath: null,
      });

      const probe = runVaultHealthProbe(config, db);

      expect(probe.action).toBe("noop");
      expect(isDegraded(db)).toBe(false);
    });

    it("setup-complete detection finds rules/management.md on the PRIMARY vault (post-Phase-2 layout)", () => {
      // Simulate a user who ran Phase 2 migration: their setup artefacts
      // moved to primaryVaultPath and the fallback is empty. The probe must
      // still treat setup as complete or they would be stuck in the
      // bootstrap bypass forever with no way to hit degraded.
      const vaultPath = resolve(tmpRoot, "vault-primary");
      mkdirSync(resolve(vaultPath, "rules"), { recursive: true });
      writeFileSync(resolve(vaultPath, "rules", "management.md"), "# Mgmt\n");

      const config = baseConfig(dataDir, {
        vaultMode: "obsidian",
        primaryVaultPath: vaultPath,
      });

      const probe = runVaultHealthProbe(config, db);

      // Setup is complete AND vault is reachable → no degrade.
      expect(probe.action).toBe("noop");
      expect(isDegraded(db)).toBe(false);

      // Remove the vault so the next probe should degrade (proving the
      // bootstrap check let us past it this time, not that degrade is
      // permanently disabled).
      rmSync(vaultPath, { recursive: true, force: true });
      const next = runVaultHealthProbe(config, db);
      expect(next.action).toBe("entered");
    });

    it("health route reports status: 'degraded' once the probe has set state", async () => {
      seedSetupComplete(dataDir);
      const config = baseConfig(dataDir, { vaultMode: "obsidian" });
      runVaultHealthProbe(config, db);

      const healthRoutes = createHealthRoutes({
        db,
        config,
        getHealthData: () => ({
          uptime: 0,
          eventBusSize: 0,
          activeSessions: 0,
          contextFilesOk: true,
          missingContextFiles: [],
          connectedPlatforms: [],
          registeredObservers: [],
        }),
        getIntegrationStatus: () => ({}),
      } as unknown as Parameters<typeof createHealthRoutes>[0]);

      const app = new Hono();
      app.route("/api", healthRoutes);

      const res = await app.request("/api/health");
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        status: string;
        degraded: { reason: string; path: string | null } | null;
      };
      expect(body.status).toBe("degraded");
      expect(body.degraded).not.toBeNull();
      expect(body.degraded?.reason).toBe("primary_vault_not_configured");
    });
  });

  describe("(2) PA_VAULT_STRICT=1 fail-fast semantics", () => {
    // The actual `process.exit(1)` path lives in index.ts and cannot be
    // invoked here without tearing down the test runner. We instead
    // verify the DB-level signal that strict mode keys off: after the
    // startup probe sets degraded mode, an isDegraded-true check is
    // unambiguous and the env-flag branch in index.ts is a pure
    // short-circuit on that boolean.
    it("isDegraded(db) is unambiguously true when strict mode would trigger", () => {
      seedSetupComplete(dataDir);
      const config = baseConfig(dataDir, {
        vaultMode: "obsidian",
        primaryVaultPath: null,
      });

      runVaultHealthProbe(config, db);

      // This is the exact boolean index.ts reads before deciding whether
      // to `process.exit(1)` under PA_VAULT_STRICT=1.
      expect(isDegraded(db)).toBe(true);
    });

    it("plain mode never satisfies the strict-exit predicate", () => {
      const config = baseConfig(dataDir, { vaultMode: "plain" });
      runVaultHealthProbe(config, db);
      expect(isDegraded(db)).toBe(false);
    });
  });

  describe("(3) 30-second probe lifts degraded mode", () => {
    it("entered then lifted when path becomes reachable with expected vault content", () => {
      seedSetupComplete(dataDir);
      const vaultPath = resolve(tmpRoot, "vault-lazy");
      const config = baseConfig(dataDir, {
        vaultMode: "obsidian",
        primaryVaultPath: vaultPath,
      });

      // First tick: vault doesn't exist → degraded.
      const first = runVaultHealthProbe(config, db);
      expect(first.action).toBe("entered");
      expect(first.reason).toBe("primary_vault_unreachable");
      expect(isDegraded(db)).toBe(true);

      // User restores the directory AND the expected context files (e.g.,
      // re-plugs the drive and the cloud provider has finished syncing).
      mkdirSync(vaultPath, { recursive: true });
      writeFileSync(resolve(vaultPath, "today.md"), "# Today\n", "utf-8");

      // Next tick: reachable + content markers present → lifted.
      const second = runVaultHealthProbe(config, db);
      expect(second.action).toBe("lifted");
      expect(isDegraded(db)).toBe(false);
    });

    it("stays degraded when the directory exists but expected context files are missing", () => {
      seedSetupComplete(dataDir);
      const vaultPath = resolve(tmpRoot, "vault-empty");
      const config = baseConfig(dataDir, {
        vaultMode: "obsidian",
        primaryVaultPath: vaultPath,
      });

      const first = runVaultHealthProbe(config, db);
      expect(first.action).toBe("entered");
      expect(first.reason).toBe("primary_vault_unreachable");

      mkdirSync(vaultPath, { recursive: true });
      const second = runVaultHealthProbe(config, db);
      expect(second.action).toBe("noop");
      expect(isDegraded(db)).toBe(true);
      expect(getDegradedMode(db)?.reason).toBe("primary_vault_missing_content");
    });

    it("stays degraded if path remains broken across ticks", () => {
      seedSetupComplete(dataDir);
      const config = baseConfig(dataDir, {
        vaultMode: "obsidian",
        primaryVaultPath: "/still/nonexistent",
      });

      const first = runVaultHealthProbe(config, db);
      expect(first.action).toBe("entered");

      const second = runVaultHealthProbe(config, db);
      // Already degraded, same reason → no-op, not a second "entered".
      expect(second.action).toBe("noop");
      expect(isDegraded(db)).toBe(true);
    });

    it("probe is read-only — does not silently re-create a user-deleted vault", () => {
      seedSetupComplete(dataDir);
      const vaultPath = resolve(tmpRoot, "vault-deleted");
      mkdirSync(vaultPath, { recursive: true });
      writeFileSync(resolve(vaultPath, "today.md"), "# Today\n", "utf-8");
      const config = baseConfig(dataDir, {
        vaultMode: "obsidian",
        primaryVaultPath: vaultPath,
      });

      // Healthy state.
      const healthy = runVaultHealthProbe(config, db);
      expect(healthy.action).toBe("noop");
      expect(isDegraded(db)).toBe(false);

      // User removes the vault directory.
      rmSync(vaultPath, { recursive: true, force: true });

      // Next tick MUST flip to degraded, not silently re-create.
      const afterDelete = runVaultHealthProbe(config, db);
      expect(afterDelete.action).toBe("entered");
      // Critical: the probe did not re-create the directory.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { existsSync } = require("node:fs") as typeof import("node:fs");
      expect(existsSync(vaultPath)).toBe(false);
    });
  });

  describe("(4) PATCH /api/config validator flow", () => {
    let settingsStore: SettingsStore;

    beforeEach(() => {
      settingsStore = createSettingsStore(db);
    });

    it("rejects primaryVaultPath PATCH — must go through /api/setup/migrate-context", async () => {
      // Phase 2 gated `primaryVaultPath` out of the PATCH /api/config
      // path because writing it without moving the files would strand
      // the user's data in the old location. The migration endpoint is
      // the single entrypoint that owns the atomic move + DB rewrite +
      // settings update. Direct path validation still happens inside
      // that endpoint — see setup-migrate.test.ts.
      const vault = resolve(tmpRoot, "vault-ok");
      const config = baseConfig(dataDir, { vaultMode: "obsidian" });

      const result = await applyConfigUpdates(config, settingsStore, {
        primaryVaultPath: vault,
      });

      expect(result.errors.primaryVaultPath).toBeDefined();
      expect(result.errors.primaryVaultPath).toMatch(/migrate-context/);
      expect(config.primaryVaultPath).toBeNull();
    });

    it("rejects vaultMode PATCH — must go through /api/setup/migrate-context", async () => {
      // Same gating rule applies to vaultMode itself: flipping
      // plain ↔ obsidian without moving files leaves getContextDir
      // pointing at an empty directory.
      const config = baseConfig(dataDir, { vaultMode: "plain" });

      const result = await applyConfigUpdates(config, settingsStore, {
        vaultMode: "obsidian",
      });

      expect(result.errors.vaultMode).toBeDefined();
      expect(result.errors.vaultMode).toMatch(/migrate-context/);
      expect(config.vaultMode).toBe("plain");
    });

    it("still allows primaryVaultName (display-only) PATCH when primaryVaultPath already exists", async () => {
      // primaryVaultName is a human-readable label, not a filesystem
      // path; changing it has no data-integrity impact, so the gate
      // does not apply. Zod's structural check still requires the
      // name live alongside a path, so this test uses a config that
      // already has one AND persists it in SQLite (simulating an actual
      // post-migration state rather than an env-only in-memory override).
      const vault = resolve(tmpRoot, "named-vault");
      mkdirSync(vault, { recursive: true });
      const config = baseConfig(dataDir, {
        vaultMode: "obsidian",
        primaryVaultPath: vault,
      });
      settingsStore.setMany({
        primaryVaultPath: vault,
      });
      const result = await applyConfigUpdates(config, settingsStore, {
        primaryVaultName: "My Vault",
      });
      expect(result.errors).toEqual({});
      expect(config.primaryVaultName).toBe("My Vault");
    });

    it("rejects externalObsidianVaultPath overlapping the primary vault", async () => {
      const primary = resolve(tmpRoot, "primary");
      mkdirSync(primary, { recursive: true });
      const config = baseConfig(dataDir, {
        vaultMode: "obsidian",
        primaryVaultPath: primary,
      });

      const result = await applyConfigUpdates(config, settingsStore, {
        externalObsidianVaultPath: primary,
      });

      expect(result.errors.externalObsidianVaultPath).toBeDefined();
      expect(result.errors.externalObsidianVaultPath).toMatch(/overlap/i);
    });

    it("rejects a relative externalObsidianVaultPath", async () => {
      const config = baseConfig(dataDir);

      const result = await applyConfigUpdates(config, settingsStore, {
        externalObsidianVaultPath: "relative-vault",
      });

      expect(result.errors.externalObsidianVaultPath).toBeDefined();
      expect(result.errors.externalObsidianVaultPath).toMatch(/absolute/i);
      expect(config.externalObsidianVaultPath).toBeNull();
    });

    // SETUP-FLOW-REDESIGN-PLAN §6.2 / §11.2 — round-trip the
    // applyConfigUpdates → writeManagementMd centralization. Setting
    // `externalObsidianVaultPath` via the central mutation point must
    // re-render `<dataDir>/integrations.md` with the new path under
    // `## Note Sources`. Before this contract was centralized, only
    // the dashboard PATCH handler regenerated the file; any other
    // caller of applyConfigUpdates carrying these keys would silently
    // skip the regeneration. The test asserts the §6.2 wiring lives
    // on the shared chokepoint, not in the route handler.
    it("regenerates integrations.md Note Sources when externalObsidianVaultPath is patched (§6.2)", async () => {
      const { existsSync, readFileSync } = await import("node:fs");
      const externalVault = resolve(tmpRoot, "personal-vault");
      mkdirSync(externalVault, { recursive: true });
      const config = baseConfig(dataDir);

      const result = await applyConfigUpdates(
        config,
        settingsStore,
        { externalObsidianVaultPath: externalVault },
        { db },
      );

      expect(result.errors).toEqual({});
      expect(result.updated).toContain("externalObsidianVaultPath");

      const integrationsPath = join(dataDir, "integrations.md");
      expect(existsSync(integrationsPath)).toBe(true);
      const body = readFileSync(integrationsPath, "utf-8");
      expect(body).toContain("## Note Sources");
      expect(body).toContain(`Obsidian vault (personal): ${externalVault}`);
      // notion mode untouched in this test → "disabled".
      expect(body).toContain("Notion: disabled");
    });

    it("re-renders Note Sources when externalObsidianWatch flips false → true (§6.2)", async () => {
      const { existsSync, readFileSync } = await import("node:fs");
      const externalVault = resolve(tmpRoot, "personal-vault-watch");
      mkdirSync(externalVault, { recursive: true });
      const config = baseConfig(dataDir);

      // First pass: set the path with watching disabled. The "(watching
      // disabled)" suffix is the renderer's signal that the kill-switch
      // is engaged (see core/management-md.ts:renderNoteSourcesSection).
      await applyConfigUpdates(
        config,
        settingsStore,
        {
          externalObsidianVaultPath: externalVault,
          externalObsidianWatch: false,
        },
        { db },
      );
      const integrationsPath = join(dataDir, "integrations.md");
      expect(existsSync(integrationsPath)).toBe(true);
      let body = readFileSync(integrationsPath, "utf-8");
      expect(body).toMatch(/Obsidian vault \(personal\):.*\(watching disabled\)/);

      // Second pass: flip the watch flag back on. The render must drop
      // the "(watching disabled)" suffix.
      await applyConfigUpdates(
        config,
        settingsStore,
        { externalObsidianWatch: true },
        { db },
      );
      body = readFileSync(integrationsPath, "utf-8");
      expect(body).toContain(`Obsidian vault (personal): ${externalVault}`);
      expect(body).not.toContain("(watching disabled)");
    });

    it("does NOT re-render Note Sources when patching unrelated keys (§6.2 specificity)", async () => {
      const { existsSync, readFileSync } = await import("node:fs");
      const externalVault = resolve(tmpRoot, "personal-vault-unrelated");
      mkdirSync(externalVault, { recursive: true });
      const config = baseConfig(dataDir);

      // Seed integrations.md by writing the path first.
      await applyConfigUpdates(
        config,
        settingsStore,
        { externalObsidianVaultPath: externalVault },
        { db },
      );
      const integrationsPath = join(dataDir, "integrations.md");
      expect(existsSync(integrationsPath)).toBe(true);
      const seeded = readFileSync(integrationsPath, "utf-8");

      // Patch an unrelated runtime field. The Note Sources keys aren't
      // in the patch payload, so the regeneration must NOT fire — the
      // file stays byte-identical.
      await applyConfigUpdates(
        config,
        settingsStore,
        { executeTimeoutMinutes: 90 },
        { db },
      );
      const after = readFileSync(integrationsPath, "utf-8");
      expect(after).toEqual(seeded);
    });
  });

  describe("context route 503 + getContextDir degraded-aware fallback", () => {
    it("returns 503 on all context reads while degraded", async () => {
      seedSetupComplete(dataDir);
      setDegradedMode(db, {
        reason: "primary_vault_unreachable",
        path: "/broken",
        since: "2026-04-18T10:00:00Z",
      });
      const config = baseConfig(dataDir, {
        vaultMode: "obsidian",
        primaryVaultPath: "/broken",
      });

      const routes = createContextRoutes({
        db,
        config,
      } as unknown as Parameters<typeof createContextRoutes>[0]);
      const app = new Hono();
      app.route("/api", routes);

      const get = await app.request("/api/context/today");
      expect(get.status).toBe(503);

      const put = await app.request("/api/context/today", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "# Today\n" }),
      });
      expect(put.status).toBe(503);
    });
  });
});
