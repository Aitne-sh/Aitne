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
      hourlyCheckEnabled: false,
      defaultNotificationPlatforms: ["slack", "telegram"],
    });

    expect(store.getAll()).toMatchObject({
      executeTimeoutMinutes: 120,
      hourlyCheckEnabled: false,
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
});

describe("getRuntimeSettingsDefaults", () => {
  it("returns default values from the Zod schema", async () => {
    const { getRuntimeSettingsDefaults } = await import("./settings-store.js");
    const defaults = getRuntimeSettingsDefaults();
    expect(defaults.executeTimeoutMinutes).toBe(60);
    expect(defaults.agentDisplayName).toBe(DEFAULT_AGENT_DISPLAY_NAME);
    expect(defaults.hourlyCheckEnabled).toBe(true);
    expect(defaults.disallowedTools).toBeInstanceOf(Array);
  });
});
