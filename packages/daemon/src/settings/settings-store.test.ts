import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { DEFAULT_AGENT_DISPLAY_NAME } from "@aitne/shared";
import { applySchema } from "../db/schema.js";
import { createSettingsStore } from "./settings-store.js";

import { runtimeSettingsSchema } from "./runtime-settings.js";

describe("primaryLanguage validation (B-007)", () => {
  it("accepts 2-letter and 3-letter primary subtags", () => {
    expect(runtimeSettingsSchema.parse({ primaryLanguage: "en" }).primaryLanguage).toBe("en");
    expect(runtimeSettingsSchema.parse({ primaryLanguage: "es" }).primaryLanguage).toBe("es");
    expect(runtimeSettingsSchema.parse({ primaryLanguage: "fil" }).primaryLanguage).toBe("fil");
  });

  it("accepts region subtags (en-US, en-GB, pt-BR, zh-Hans)", () => {
    expect(runtimeSettingsSchema.parse({ primaryLanguage: "en-US" }).primaryLanguage).toBe("en-US");
    expect(runtimeSettingsSchema.parse({ primaryLanguage: "en-GB" }).primaryLanguage).toBe("en-GB");
    expect(runtimeSettingsSchema.parse({ primaryLanguage: "pt-BR" }).primaryLanguage).toBe("pt-BR");
    expect(runtimeSettingsSchema.parse({ primaryLanguage: "zh-Hans" }).primaryLanguage).toBe("zh-Hans");
  });

  it("rejects malformed tags (underscore, uppercase primary, digits, garbage)", () => {
    expect(() => runtimeSettingsSchema.parse({ primaryLanguage: "en_US" })).toThrow();
    expect(() => runtimeSettingsSchema.parse({ primaryLanguage: "EN" })).toThrow();
    expect(() => runtimeSettingsSchema.parse({ primaryLanguage: "xyz123" })).toThrow();
    expect(() => runtimeSettingsSchema.parse({ primaryLanguage: "" })).toThrow();
    expect(() => runtimeSettingsSchema.parse({ primaryLanguage: "e" })).toThrow();
  });

  it("defaults to 'en' when omitted", () => {
    expect(runtimeSettingsSchema.parse({}).primaryLanguage).toBe("en");
  });
});

describe("vaultMode validation (B-007)", () => {
  it("accepts 'obsidian' and 'plain'", () => {
    expect(runtimeSettingsSchema.parse({ vaultMode: "obsidian" }).vaultMode).toBe("obsidian");
    expect(runtimeSettingsSchema.parse({ vaultMode: "plain" }).vaultMode).toBe("plain");
  });

  it("rejects unknown modes", () => {
    expect(() => runtimeSettingsSchema.parse({ vaultMode: "hybrid" })).toThrow();
  });

  it("defaults to 'plain'", () => {
    expect(runtimeSettingsSchema.parse({}).vaultMode).toBe("plain");
  });
});

describe("SettingsStore", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    applySchema(db);
  });

  afterEach(() => {
    db.close();
  });

  it("stores and reads typed runtime settings", () => {
    const store = createSettingsStore(db);
    store.set("executeTimeoutMinutes", 90);
    store.set("agentDisplayName", "RoundtripBot");

    expect(store.get("executeTimeoutMinutes")).toBe(90);
    expect(store.get("agentDisplayName")).toBe("RoundtripBot");
  });

  it("persists batch updates and returns all stored values", () => {
    const store = createSettingsStore(db);
    store.setMany({
      executeTimeoutMinutes: 120,
      activityScanEnabled: false,
      defaultNotificationPlatforms: ["slack", "telegram"],
    });

    expect(store.getAll()).toMatchObject({
      executeTimeoutMinutes: 120,
      activityScanEnabled: false,
      defaultNotificationPlatforms: ["slack", "telegram"],
    });
  });

  it("ignores invalid JSON rows when reading", () => {
    db.prepare(
      "INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)",
    ).run("executeTimeoutMinutes", "{invalid");

    const store = createSettingsStore(db);
    expect(store.get("executeTimeoutMinutes")).toBeNull();
    expect(store.getAll()).toEqual({});
  });

  it("delete removes a stored setting", () => {
    const store = createSettingsStore(db);
    store.set("executeTimeoutMinutes", 90);
    expect(store.get("executeTimeoutMinutes")).toBe(90);

    store.delete("executeTimeoutMinutes");
    expect(store.get("executeTimeoutMinutes")).toBeNull();
  });

  // v0.1.10 → v0.1.11 rename: rows persisted under the legacy `hourlyCheck*`
  // names must read under the canonical `activityScan*` key on the first
  // post-upgrade boot, BEFORE migration 0010 has rewritten them
  // (loadPersistedSettings runs ahead of runMigrations).
  it("reads a legacy hourlyCheck* row under its canonical activityScan* key", () => {
    db.prepare("INSERT INTO settings (key, value_json) VALUES (?, ?)").run(
      "hourlyCheckPrePassFreshnessMinutes",
      "240",
    );
    const store = createSettingsStore(db);
    expect(store.getAll().activityScanPrePassFreshnessMinutes).toBe(240);
  });

  it("never lets a legacy row shadow an existing canonical row", () => {
    const put = db.prepare("INSERT INTO settings (key, value_json) VALUES (?, ?)");
    // Legacy row inserted FIRST so the SELECT yields it before the canonical
    // row — the canonical value must still win.
    put.run("hourlyCheckIntervalMinutes", "60");
    put.run("activityScanIntervalMinutes", "90");
    const store = createSettingsStore(db);
    expect(store.getAll().activityScanIntervalMinutes).toBe(90);
  });

  it("drops a legacy row whose canonical value arrived earlier in the scan", () => {
    const put = db.prepare("INSERT INTO settings (key, value_json) VALUES (?, ?)");
    // Canonical first, legacy second — the aliased duplicate is skipped.
    put.run("activityScanHeartbeatHours", "8");
    put.run("hourlyCheckHeartbeatHours", "4");
    const store = createSettingsStore(db);
    expect(store.getAll().activityScanHeartbeatHours).toBe(8);
  });

  it("setMany is a no-op when no valid runtime setting keys are provided", () => {
    const store = createSettingsStore(db);
    const countBefore = (db.prepare("SELECT COUNT(*) as cnt FROM settings").get() as { cnt: number }).cnt;

    // Pass an empty object
    store.setMany({});

    // DB should be unchanged
    const countAfter = (db.prepare("SELECT COUNT(*) as cnt FROM settings").get() as { cnt: number }).cnt;
    expect(countAfter).toBe(countBefore);
  });

  it("transaction wraps operations in a DB transaction", () => {
    const store = createSettingsStore(db);
    store.transaction(() => {
      store.set("executeTimeoutMinutes", 120);
      store.set("agentDisplayName", "TestAgent");
    });

    expect(store.get("executeTimeoutMinutes")).toBe(120);
    expect(store.get("agentDisplayName")).toBe("TestAgent");
  });

  it("validates setMany against current stored settings, not schema defaults only", () => {
    const store = createSettingsStore(db);
    store.setMany({
      primaryVaultPath: "/tmp/primary-vault",
    });

    expect(() => {
      store.setMany({
        primaryVaultName: "Primary Vault",
      });
    }).not.toThrow();
    expect(store.get("primaryVaultName")).toBe("Primary Vault");
  });

  it("getAll ignores non-runtime-setting keys in the DB", () => {
    // Insert a row with a key that is NOT a runtime setting
    db.prepare(
      "INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)",
    ).run("unknownKey", '"some_value"');

    const store = createSettingsStore(db);
    const all = store.getAll();
    expect(all).toEqual({});
  });

  it("get returns null for non-existent key", () => {
    const store = createSettingsStore(db);
    expect(store.get("executeTimeoutMinutes")).toBeNull();
  });

  it("getAll skips rows whose value passes JSON.parse but fails the Zod schema", () => {
    // executeTimeoutMinutes is z.number(); a stored string passes JSON.parse
    // but fails type validation. The bad row should be skipped, not throw.
    db.prepare(
      "INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)",
    ).run("executeTimeoutMinutes", '"sixty"');

    // A separate valid row alongside it must still come through.
    db.prepare(
      "INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)",
    ).run("agentDisplayName", '"OkBot"');

    const store = createSettingsStore(db);
    const all = store.getAll();
    expect(all.executeTimeoutMinutes).toBeUndefined();
    expect(all.agentDisplayName).toBe("OkBot");
  });

  it("getAll preserves a mutually-consistent cross-field pair (B1)", () => {
    // prePassBackoffMs length must be >= prePassMaxAttemptsPerIntegration - 1.
    // The pair max=5 / backoff=[1000,2000,4000,8000] (4 entries) is individually
    // valid and mutually consistent. Per-key validation against peer *defaults*
    // (the default backoff is shorter) wrongly dropped max=5; getAll must see
    // both persisted values together and keep them intact.
    db.prepare(
      "INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)",
    ).run("prePassMaxAttemptsPerIntegration", "5");
    db.prepare(
      "INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)",
    ).run("prePassBackoffMs", "[1000,2000,4000,8000]");

    const store = createSettingsStore(db);
    const all = store.getAll();
    expect(all.prePassMaxAttemptsPerIntegration).toBe(5);
    expect(all.prePassBackoffMs).toEqual([1000, 2000, 4000, 8000]);
  });

  it("getAll keeps a valid cross-field pair when a separate row is corrupt (B1)", () => {
    // The valid cross-field pair from above...
    db.prepare(
      "INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)",
    ).run("prePassMaxAttemptsPerIntegration", "5");
    db.prepare(
      "INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)",
    ).run("prePassBackoffMs", "[1000,2000,4000,8000]");
    // ...plus an unrelated, individually-invalid row (executeTimeoutMinutes is a
    // number; a stored string passes JSON.parse but fails the schema).
    db.prepare(
      "INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)",
    ).run("executeTimeoutMinutes", '"oops"');

    const store = createSettingsStore(db);
    const all = store.getAll();
    // The corrupt row is dropped without poisoning the valid cross-field pair.
    expect(all.executeTimeoutMinutes).toBeUndefined();
    expect(all.prePassMaxAttemptsPerIntegration).toBe(5);
    expect(all.prePassBackoffMs).toEqual([1000, 2000, 4000, 8000]);
  });
});

describe("getRuntimeSettingsDefaults", () => {
  it("returns default values from the Zod schema", async () => {
    const { getRuntimeSettingsDefaults } = await import("./settings-store.js");
    const defaults = getRuntimeSettingsDefaults();
    expect(defaults.executeTimeoutMinutes).toBe(60);
    expect(defaults.agentDisplayName).toBe(DEFAULT_AGENT_DISPLAY_NAME);
    expect(defaults.activityScanEnabled).toBe(true);
    expect(defaults.disallowedTools).toBeInstanceOf(Array);
  });
});
