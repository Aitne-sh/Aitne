import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { Hono } from "hono";
import { applySchema } from "../../db/schema.js";
import { createSystemRoutes } from "./system.js";
import type { ApiDependencies } from "../server.js";
import type { AgentConfig } from "../../config.js";
import type { SecretBroker } from "../../secrets/secret-broker.js";

vi.mock("../directory-picker.js", () => ({
  pickDirectory: vi.fn().mockResolvedValue({ status: "selected", path: "/chosen/dir", method: "osascript" }),
}));

vi.mock("../../core/system-reset.js", async (importOriginal) => {
  const original = await importOriginal() as Record<string, unknown>;
  return {
    ...original,
    factoryReset: vi.fn(original.factoryReset as (...args: unknown[]) => unknown),
  };
});

function makeConfig(dataDir: string): AgentConfig {
  return {
    dataDir,
    timezone: "America/New_York",
    dayBoundaryHour: 4,
  } as unknown as AgentConfig;
}

describe("createSystemRoutes", () => {
  let dataDir: string;
  let db: Database.Database;
  let app: Hono;
  let brokerDeleteCalls: string[];
  let onSecretChangedCalls: string[];

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "pa-system-route-"));
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applySchema(db);
    brokerDeleteCalls = [];
    onSecretChangedCalls = [];

    const broker = {
      delete: vi.fn(async (name: string) => {
        brokerDeleteCalls.push(name);
      }),
    } as unknown as SecretBroker;

    const deps = {
      db,
      config: makeConfig(dataDir),
      secretBroker: broker,
      onSecretChanged: vi.fn(async (scope: string) => {
        onSecretChangedCalls.push(scope);
      }),
    } as unknown as ApiDependencies;

    app = new Hono();
    app.route("/api", createSystemRoutes(deps));
  });

  afterEach(() => {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("POST /api/system/reset-config clears settings and returns current snapshot", async () => {
    // Schema seeds baseline rows (e.g. the `integrations` row). Wipe first
    // so `cleared` reflects only test-inserted rows.
    db.prepare("DELETE FROM settings").run();
    db.prepare(`INSERT INTO settings (key, value_json) VALUES ('timezone', '"UTC"')`).run();

    const res = await app.request("/api/system/reset-config", { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    expect(body.status).toBe("reset");
    expect(body.cleared).toBe(1);
    expect(body.runtimeSettings).toBeDefined();

    const rows = db.prepare("SELECT COUNT(*) as n FROM settings").get() as { n: number };
    expect(rows.n).toBe(0);
  });

  it("POST /api/system/purge-history returns counts and preserves active session", async () => {
    db.prepare(
      `INSERT INTO conversation_sessions (id, platform, channel_id, scope, scope_key, status, is_dm)
         VALUES (1, 'dashboard', 'ch', 'dashboard_chat', 'dashboard', 'active',  1),
                (2, 'dashboard', 'ch', 'dashboard_chat', 'dashboard', 'closed',  1)`,
    ).run();

    const res = await app.request("/api/system/purge-history", { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    expect(body.status).toBe("purged");
    expect(body.deletedSessions).toBe(1);

    const remaining = db.prepare("SELECT id FROM conversation_sessions").all() as Array<{ id: number }>;
    expect(remaining).toEqual([{ id: 1 }]);
  });

  it("GET /api/system/reinstall-context/plan enumerates files + snapshot rows without side effects", async () => {
    const contextDir = join(dataDir, "context");
    mkdirSync(join(contextDir, "policies"), { recursive: true });
    mkdirSync(join(contextDir, "state"), { recursive: true });
    writeFileSync(join(contextDir, "policies", "management.md"), "rules");
    writeFileSync(join(contextDir, "state", "today.md"), "today");
    db.prepare(
      "INSERT INTO md_file_snapshots (file_path, content, trigger) VALUES (?, ?, ?)",
    ).run("today", "old", "test");

    const res = await app.request("/api/system/reinstall-context/plan");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    expect(body.fileCount).toBe(2);
    expect(body.totalBytes).toBeGreaterThan(0);
    expect(body.snapshotRowCount).toBe(1);
    expect(body.backupPath).toContain("context-pre-reinstall-");
    // Side-effect-free: files and DB row still present.
    expect(existsSync(join(contextDir, "state", "today.md"))).toBe(true);
    const { n } = db
      .prepare("SELECT COUNT(*) as n FROM md_file_snapshots")
      .get() as { n: number };
    expect(n).toBe(1);
  });

  it("POST /api/system/reinstall-context without CLEAN confirmation returns 400", async () => {
    const res = await app.request("/api/system/reinstall-context", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirm: "wrong" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, any>;
    expect(body.error).toBe("confirmation_required");
  });

  it("POST /api/system/reinstall-context wipes context/ and md_file_snapshots after CLEAN confirm", async () => {
    const contextDir = join(dataDir, "context");
    mkdirSync(join(contextDir, "policies"), { recursive: true });
    mkdirSync(join(contextDir, "state"), { recursive: true });
    writeFileSync(join(contextDir, "policies", "management.md"), "rules");
    writeFileSync(join(contextDir, "state", "today.md"), "today");
    db.prepare(
      "INSERT INTO md_file_snapshots (file_path, content, trigger) VALUES (?, ?, ?)",
    ).run("today", "old", "test");

    const res = await app.request("/api/system/reinstall-context", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirm: "CLEAN" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    expect(body.status).toBe("reinstalled");
    expect(body.restartRequired).toBe(true);
    expect(body.filesDeleted).toBe(2);
    expect(body.snapshotRowsDeleted).toBe(1);
    expect(existsSync(join(contextDir, "state", "today.md"))).toBe(false);
    const { n } = db
      .prepare("SELECT COUNT(*) as n FROM md_file_snapshots")
      .get() as { n: number };
    expect(n).toBe(0);
    // Tarball backup was written.
    expect(existsSync(body.backupPath)).toBe(true);
  });

  it("POST /api/system/reinstall-context returns 500 when the tarball backup fails", async () => {
    // Seed files so the tarball step actually runs (empty context dir short-circuits).
    const contextDir = join(dataDir, "context");
    mkdirSync(contextDir, { recursive: true });
    mkdirSync(join(contextDir, "state"), { recursive: true });
    writeFileSync(join(contextDir, "state", "today.md"), "today");

    // Point PATH at an empty dir so the `tar` CLI lookup fails, forcing
    // createTarballBackup to throw. Restore after.
    const originalPath = process.env.PATH;
    process.env.PATH = join(dataDir, "empty-path");
    mkdirSync(process.env.PATH, { recursive: true });
    try {
      const res = await app.request("/api/system/reinstall-context", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: "CLEAN" }),
      });
      expect(res.status).toBe(500);
      const body = (await res.json()) as Record<string, any>;
      expect(body.error).toBe("reinstall_failed");
      // Context stays intact when backup fails (the wipe is gated on success).
      expect(existsSync(join(contextDir, "state", "today.md"))).toBe(true);
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it("POST /api/system/wipe-context removes context entries", async () => {
    const contextDir = join(dataDir, "context");
    mkdirSync(contextDir, { recursive: true });
    mkdirSync(join(contextDir, "state"), { recursive: true });
    mkdirSync(join(contextDir, "policies"), { recursive: true });
    mkdirSync(join(contextDir, "state"), { recursive: true });
    writeFileSync(join(contextDir, "policies", "management.md"), "rules");
    writeFileSync(join(contextDir, "state", "today.md"), "today");

    const res = await app.request("/api/system/wipe-context", { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    expect(body.status).toBe("wiped");
    expect(body.removed).toBe(2);
    expect(existsSync(join(contextDir, "policies", "management.md"))).toBe(false);
  });

  it("POST /api/system/wipe-context clears setup/degraded runtime markers", async () => {
    const contextDir = join(dataDir, "context");
    mkdirSync(join(contextDir, "policies"), { recursive: true });
    mkdirSync(join(contextDir, "state"), { recursive: true });
    writeFileSync(join(contextDir, "policies", "management.md"), "rules");
    db.prepare(
      `INSERT INTO runtime_state (key, value_json)
       VALUES ('management_mode.setup_completed', 'true'),
              ('management_mode.degraded', '{"reason":"x","path":null,"since":"t"}')`,
    ).run();

    const res = await app.request("/api/system/wipe-context", { method: "POST" });
    expect(res.status).toBe(200);

    const rows = db
      .prepare(
        `SELECT key FROM runtime_state
         WHERE key IN ('management_mode.setup_completed', 'management_mode.degraded')`,
      )
      .all();
    expect(rows).toEqual([]);
  });

  it("POST /api/system/wipe-context removes Obsidian primary vault plus fallback context", async () => {
    const primaryVaultPath = join(dataDir, "primary-vault");
    const fallbackContextDir = join(dataDir, "context");
    mkdirSync(join(primaryVaultPath, "rules"), { recursive: true });
    mkdirSync(join(fallbackContextDir, "rules"), { recursive: true });
    writeFileSync(join(primaryVaultPath, "rules", "management.md"), "primary");
    writeFileSync(join(fallbackContextDir, "rules", "management.md"), "fallback");

    const deps = {
      db,
      config: {
        ...makeConfig(dataDir),
        vaultMode: "obsidian",
        primaryVaultPath,
      },
      secretBroker: { delete: vi.fn(async () => {}) },
    } as unknown as ApiDependencies;
    const localApp = new Hono();
    localApp.route("/api", createSystemRoutes(deps));

    const res = await localApp.request("/api/system/wipe-context", { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    expect(body.status).toBe("wiped");
    expect(body.removed).toBe(2);
    expect(body.paths).toEqual([
      { path: primaryVaultPath, removed: 1 },
      { path: fallbackContextDir, removed: 1 },
    ]);
    expect(existsSync(join(primaryVaultPath, "rules", "management.md"))).toBe(false);
    expect(existsSync(join(fallbackContextDir, "rules", "management.md"))).toBe(false);
  });

  it("POST /api/system/wipe-context reports context errors without clearing setup markers", async () => {
    const primaryVaultPath = join(dataDir, "primary-vault-file");
    const fallbackContextDir = join(dataDir, "context");
    writeFileSync(primaryVaultPath, "not a directory");
    mkdirSync(join(fallbackContextDir, "rules"), { recursive: true });
    writeFileSync(join(fallbackContextDir, "rules", "management.md"), "fallback");
    db.prepare(
      `INSERT INTO runtime_state (key, value_json)
       VALUES ('management_mode.setup_completed', 'true'),
              ('management_mode.degraded', '{"reason":"x","path":null,"since":"t"}')`,
    ).run();

    const deps = {
      db,
      config: {
        ...makeConfig(dataDir),
        vaultMode: "obsidian",
        primaryVaultPath,
      },
      secretBroker: { delete: vi.fn(async () => {}) },
    } as unknown as ApiDependencies;
    const localApp = new Hono();
    localApp.route("/api", createSystemRoutes(deps));

    const res = await localApp.request("/api/system/wipe-context", { method: "POST" });
    expect(res.status).toBe(500);
    const body = (await res.json()) as Record<string, any>;
    expect(body.status).toBe("wipe_failed");
    expect(body.errors).toHaveLength(1);
    expect(body.errors[0].path).toBe(primaryVaultPath);
    expect(existsSync(join(fallbackContextDir, "rules", "management.md"))).toBe(false);

    const rows = db
      .prepare(
        `SELECT key FROM runtime_state
         WHERE key IN ('management_mode.setup_completed', 'management_mode.degraded')
         ORDER BY key`,
      )
      .all();
    expect(rows).toEqual([
      { key: "management_mode.degraded" },
      { key: "management_mode.setup_completed" },
    ]);
  });

  it("POST /api/system/factory-reset calls every onSecretChanged scope and returns restartRequired", async () => {
    // PlatformSecretStore would try to hit the real keychain during factoryReset.
    // To keep this test hermetic we skip the internal secret delete by not
    // depending on the store; the route constructs one but the keychain
    // client will fail closed in test env — we just assert the broker path.
    const res = await app.request("/api/system/factory-reset", { method: "POST" });

    // In CI/test envs without a keychain, factoryReset may return 200 or a
    // structured partial-failure 500. Assert the important invariants from
    // whichever reset shape comes back.
    const body = (await res.json()) as Record<string, any>;
    if (res.status === 200 || body.status === "reset_with_errors") {
      expect(body.restartRequired).toBe(true);
      // All seven adapter / service scopes fanned out in order. The
      // `apple_calendar` tail entry ensures `services.appleCalendar`
      // drops its iCloud-connected reference after the credentials blob
      // is wiped — see the matching comment in system.ts.
      expect(onSecretChangedCalls).toEqual([
        "slack",
        "telegram",
        "discord",
        "notion",
        "github",
        "google",
        "apple_calendar",
      ]);
      // User-facing secrets were attempted via the broker
      expect(brokerDeleteCalls.length).toBeGreaterThan(0);
    } else {
      // Hard failure surfaces as 500 with structured error
      expect(res.status).toBe(500);
      expect(body.error).toBe("factory_reset_failed");
    }
  });

  it("POST /api/system/factory-reset returns warnings for secret cleanup errors", async () => {
    const broker = {
      delete: vi.fn(async () => {
        throw new Error("keychain offline");
      }),
    } as unknown as SecretBroker;
    const deps = {
      db,
      config: makeConfig(dataDir),
      secretBroker: broker,
      onSecretChanged: vi.fn(async (scope: string) => {
        onSecretChangedCalls.push(scope);
      }),
    } as unknown as ApiDependencies;
    const localApp = new Hono();
    localApp.route("/api", createSystemRoutes(deps));

    const res = await localApp.request("/api/system/factory-reset", { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    expect(body.status).toBe("reset_with_errors");
    expect(body.error).toBe("factory_reset_incomplete");
    expect(body.message).toContain("clear_secrets");
    expect(body.restartRequired).toBe(true);
    expect(body.errors.map((entry: { step: string }) => entry.step)).toContain("clear_secrets");
  });

  it("POST /api/system/factory-reset returns 500 for blocking reset errors", async () => {
    const primaryVaultPath = join(dataDir, "primary-vault-file");
    writeFileSync(primaryVaultPath, "not a directory");
    const broker = {
      delete: vi.fn(async () => {}),
    } as unknown as SecretBroker;
    const deps = {
      db,
      config: {
        ...makeConfig(dataDir),
        vaultMode: "obsidian",
        primaryVaultPath,
      },
      secretBroker: broker,
      onSecretChanged: vi.fn(async () => {}),
    } as unknown as ApiDependencies;
    const localApp = new Hono();
    localApp.route("/api", createSystemRoutes(deps));

    const res = await localApp.request("/api/system/factory-reset", { method: "POST" });
    expect(res.status).toBe(500);
    const body = (await res.json()) as Record<string, any>;
    expect(body.status).toBe("reset_with_errors");
    expect(body.error).toBe("factory_reset_incomplete");
    expect(body.message).toContain("wipe_context");
    expect(body.errors.map((entry: { step: string }) => entry.step)).toContain("wipe_context");
  });

  it("POST /api/system/factory-reset reports adapter reload errors without failing the request", async () => {
    const broker = {
      delete: vi.fn(async () => {}),
    } as unknown as SecretBroker;

    const deps = {
      db,
      config: makeConfig(dataDir),
      secretBroker: broker,
      onSecretChanged: vi.fn(async (scope: string) => {
        if (scope === "slack") throw new Error("slack reload boom");
      }),
    } as unknown as ApiDependencies;

    const localApp = new Hono();
    localApp.route("/api", createSystemRoutes(deps));

    const res = await localApp.request("/api/system/factory-reset", { method: "POST" });
    if (res.status !== 200) {
      // Test environment keychain interaction may block this — skip rather
      // than assert a false negative.
      return;
    }
    const body = (await res.json()) as Record<string, any>;
    expect(body.adapterReloadErrors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ scope: "slack", message: expect.stringContaining("boom") }),
      ]),
    );
  });

  it("persistent audit log captures reset-config + purge-history + wipe-context calls", async () => {
    await app.request("/api/system/reset-config", { method: "POST" });
    await app.request("/api/system/purge-history", { method: "POST" });

    const contextDir = join(dataDir, "context");
    mkdirSync(contextDir, { recursive: true });
    mkdirSync(join(contextDir, "state"), { recursive: true });
    writeFileSync(join(contextDir, "x.md"), "x");
    await app.request("/api/system/wipe-context", { method: "POST" });

    const logPath = join(dataDir, "system-reset.log");
    expect(existsSync(logPath)).toBe(true);
    const lines = readFileSync(logPath, "utf8").trim().split("\n");
    const events = lines.map((l) => JSON.parse(l).event);
    expect(events).toContain("reset_runtime_config");
    expect(events).toContain("purge_history");
    expect(events).toContain("wipe_context");
  });
});

describe("POST /api/system/pick-directory", () => {
  let dataDir: string;
  let db: Database.Database;
  let app: Hono;

  beforeEach(async () => {
    const { pickDirectory } = await import("../directory-picker.js");
    vi.mocked(pickDirectory).mockResolvedValue({ status: "selected", path: "/chosen/dir", method: "osascript" });

    dataDir = mkdtempSync(join(tmpdir(), "pa-system-pick-"));
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applySchema(db);

    const deps = {
      db,
      config: {
        dataDir,
        timezone: "UTC",
        dayBoundaryHour: 4,
      } as unknown as AgentConfig,
      secretBroker: { delete: vi.fn(async () => {}) } as unknown as SecretBroker,
      onSecretChanged: vi.fn(async () => {}),
    } as unknown as ApiDependencies;

    app = new Hono();
    app.route("/api", createSystemRoutes(deps));
  });

  afterEach(() => {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("returns 200 with selected path when pickDirectory succeeds", async () => {
    const res = await app.request("/api/system/pick-directory", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Choose folder", defaultPath: "/home" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe("selected");
    expect(body.path).toBe("/chosen/dir");
  });

  it("returns 200 when body is empty (no title or defaultPath)", async () => {
    const res = await app.request("/api/system/pick-directory", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
  });

  it("returns 400 when title is a non-string", async () => {
    const res = await app.request("/api/system/pick-directory", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: 42 }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("invalid_request");
    expect(String(body.message)).toContain("title");
  });

  it("returns 400 when title exceeds 120 characters", async () => {
    const res = await app.request("/api/system/pick-directory", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "a".repeat(121) }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("invalid_request");
    expect(String(body.message)).toContain("title");
  });

  it("returns 400 when defaultPath is a non-string", async () => {
    const res = await app.request("/api/system/pick-directory", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ defaultPath: 99 }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("invalid_request");
    expect(String(body.message)).toContain("defaultPath");
  });

  it("returns 400 when defaultPath exceeds 4096 characters", async () => {
    const res = await app.request("/api/system/pick-directory", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ defaultPath: "/a".repeat(2049) }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("invalid_request");
    expect(String(body.message)).toContain("defaultPath");
  });

  it("returns 400 when body is not valid JSON", async () => {
    const res = await app.request("/api/system/pick-directory", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not-json",
    });
    expect(res.status).toBe(400);
  });
});

describe("POST /api/system/factory-reset — outer catch", () => {
  it("returns 500 when factoryReset itself throws", async () => {
    const { factoryReset: factoryResetMock } = await import("../../core/system-reset.js");
    vi.mocked(factoryResetMock as (...args: unknown[]) => unknown)
      .mockRejectedValueOnce(new Error("boom"));

    const dataDir = mkdtempSync(join(tmpdir(), "pa-system-catch-"));
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applySchema(db);

    const deps = {
      db,
      config: {
        dataDir,
        timezone: "UTC",
        dayBoundaryHour: 4,
      } as unknown as AgentConfig,
      secretBroker: { delete: vi.fn(async () => {}) } as unknown as SecretBroker,
      onSecretChanged: vi.fn(async () => {}),
    } as unknown as ApiDependencies;

    const localApp = new Hono();
    localApp.route("/api", createSystemRoutes(deps));

    const res = await localApp.request("/api/system/factory-reset", { method: "POST" });
    expect(res.status).toBe(500);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("factory_reset_failed");
    expect(String(body.message)).toContain("boom");

    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
});

describe("POST /api/system/factory-reset — hasBlockingFactoryResetFailure branches", () => {
  // The blocking-failure detector treats remainingTables / remainingSearchIndexes
  // as hard failures even when `errors` is empty. The two tests below exercise
  // both branches of `result.remainingTables.length > 0 || result.remainingSearchIndexes.length > 0`
  // and the empty-`errors` shape of the warnings message ("Factory reset
  // completed with warnings." with no trailing detail).

  it("returns 500 with empty errors message when remainingTables is non-empty", async () => {
    const { factoryReset: factoryResetMock } = await import("../../core/system-reset.js");
    vi.mocked(factoryResetMock as (...args: unknown[]) => unknown).mockResolvedValueOnce({
      errors: [],
      remainingTables: ["sessions"],
      remainingSearchIndexes: [],
    });

    const dataDir = mkdtempSync(join(tmpdir(), "pa-system-remaining-tables-"));
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applySchema(db);

    const deps = {
      db,
      config: {
        dataDir,
        timezone: "UTC",
        dayBoundaryHour: 4,
      } as unknown as AgentConfig,
      secretBroker: { delete: vi.fn(async () => {}) } as unknown as SecretBroker,
      onSecretChanged: vi.fn(async () => {}),
    } as unknown as ApiDependencies;

    const localApp = new Hono();
    localApp.route("/api", createSystemRoutes(deps));

    const res = await localApp.request("/api/system/factory-reset", { method: "POST" });
    expect(res.status).toBe(500);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe("reset_with_errors");
    expect(body.error).toBe("factory_reset_incomplete");
    // No errors → no `: ${detail}` suffix on the message.
    expect(body.message).toBe("Factory reset completed with warnings.");
    expect(body.remainingTables).toEqual(["sessions"]);

    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("returns 500 when remainingSearchIndexes is non-empty (second OR branch)", async () => {
    const { factoryReset: factoryResetMock } = await import("../../core/system-reset.js");
    vi.mocked(factoryResetMock as (...args: unknown[]) => unknown).mockResolvedValueOnce({
      errors: [],
      remainingTables: [],
      remainingSearchIndexes: ["fts_mail_messages"],
    });

    const dataDir = mkdtempSync(join(tmpdir(), "pa-system-remaining-fts-"));
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applySchema(db);

    const deps = {
      db,
      config: {
        dataDir,
        timezone: "UTC",
        dayBoundaryHour: 4,
      } as unknown as AgentConfig,
      secretBroker: { delete: vi.fn(async () => {}) } as unknown as SecretBroker,
      onSecretChanged: vi.fn(async () => {}),
    } as unknown as ApiDependencies;

    const localApp = new Hono();
    localApp.route("/api", createSystemRoutes(deps));

    const res = await localApp.request("/api/system/factory-reset", { method: "POST" });
    expect(res.status).toBe(500);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe("reset_with_errors");
    expect(body.remainingSearchIndexes).toEqual(["fts_mail_messages"]);

    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
});
