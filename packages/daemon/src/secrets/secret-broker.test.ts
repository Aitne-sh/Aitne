import { describe, it, expect, vi } from "vitest";
import { SecretBroker } from "./secret-broker.js";
import type { SecretStore } from "./secret-store.js";
import { scopedSecretName, type StoredSecretName } from "./secret-names.js";

class CountingSecretStore implements SecretStore {
  readonly getCalls = new Map<StoredSecretName, number>();
  private readonly values = new Map<StoredSecretName, string>();

  constructor(seed: Partial<Record<StoredSecretName, string>> = {}) {
    for (const [key, value] of Object.entries(seed)) {
      if (typeof value === "string") this.values.set(key as StoredSecretName, value);
    }
  }

  async has(name: StoredSecretName): Promise<boolean> {
    return this.values.has(name);
  }

  async get(name: StoredSecretName): Promise<string | null> {
    this.getCalls.set(name, (this.getCalls.get(name) ?? 0) + 1);
    return this.values.get(name) ?? null;
  }

  async set(name: StoredSecretName, value: string): Promise<void> {
    this.values.set(name, value);
  }

  async delete(name: StoredSecretName): Promise<void> {
    this.values.delete(name);
  }
}

describe("SecretBroker", () => {
  it("caches values for the TTL window and invalidates on write", async () => {
    vi.useFakeTimers();
    const store = new CountingSecretStore({ slackBotToken: "xoxb-1" });
    const broker = new SecretBroker(store, { cacheTtlMs: 60_000 });

    await expect(broker.getSlackBotToken()).resolves.toBe("xoxb-1");
    await expect(broker.getSlackBotToken()).resolves.toBe("xoxb-1");
    expect(store.getCalls.get("slackBotToken")).toBe(1);

    vi.advanceTimersByTime(60_001);
    await expect(broker.getSlackBotToken()).resolves.toBe("xoxb-1");
    expect(store.getCalls.get("slackBotToken")).toBe(2);

    await broker.saveGoogleTokenJson("{\"refresh_token\":\"next\"}");
    await expect(broker.getGoogleTokenJson()).resolves.toBe("{\"refresh_token\":\"next\"}");
    expect(store.getCalls.get("googleTokenJson")).toBe(1);

    vi.useRealTimers();
  });

  it("has() returns true for existing secrets and false for missing ones", async () => {
    const store = new CountingSecretStore({ slackBotToken: "xoxb-1" });
    const broker = new SecretBroker(store, { cacheTtlMs: 0 });

    await expect(broker.has("slackBotToken")).resolves.toBe(true);
    await expect(broker.has("notionApiKey")).resolves.toBe(false);
  });

  it("delete() removes the secret from the store and invalidates cache", async () => {
    const store = new CountingSecretStore({ notionApiKey: "secret_key" });
    const broker = new SecretBroker(store, { cacheTtlMs: 60_000 });

    // Populate cache
    await expect(broker.get("notionApiKey")).resolves.toBe("secret_key");

    // Delete
    await broker.delete("notionApiKey");

    // Should be gone from the store and cache
    await expect(broker.get("notionApiKey")).resolves.toBeNull();
  });

  it("invalidate() forces the next get to re-read from the store", async () => {
    const store = new CountingSecretStore({ telegramBotToken: "tg-1" });
    const broker = new SecretBroker(store, { cacheTtlMs: 60_000 });

    // Populate cache
    await broker.get("telegramBotToken");
    expect(store.getCalls.get("telegramBotToken")).toBe(1);

    // Invalidate — next read should go to store
    broker.invalidate("telegramBotToken");
    await broker.get("telegramBotToken");
    expect(store.getCalls.get("telegramBotToken")).toBe(2);
  });

  it("clearCache() forces all subsequent reads to go to the store", async () => {
    const store = new CountingSecretStore({
      slackBotToken: "xoxb-1",
      notionApiKey: "notion-1",
    });
    const broker = new SecretBroker(store, { cacheTtlMs: 60_000 });

    // Populate cache for both
    await broker.get("slackBotToken");
    await broker.get("notionApiKey");
    expect(store.getCalls.get("slackBotToken")).toBe(1);
    expect(store.getCalls.get("notionApiKey")).toBe(1);

    // Clear all cache
    broker.clearCache();

    // Both should re-read from store
    await broker.get("slackBotToken");
    await broker.get("notionApiKey");
    expect(store.getCalls.get("slackBotToken")).toBe(2);
    expect(store.getCalls.get("notionApiKey")).toBe(2);
  });

  it("serializes concurrent writes to the same secret name", async () => {
    const order: string[] = [];
    let inFlight = 0;
    const store: SecretStore = {
      async has() { return false; },
      async get() { return null; },
      async set(name, value) {
        inFlight++;
        expect(inFlight).toBe(1);
        order.push(`start:${value}`);
        await new Promise((resolve) => setTimeout(resolve, 5));
        order.push(`end:${value}`);
        inFlight--;
      },
      async delete() {
        inFlight++;
        expect(inFlight).toBe(1);
        order.push("start:delete");
        await new Promise((resolve) => setTimeout(resolve, 5));
        order.push("end:delete");
        inFlight--;
      },
    };
    const broker = new SecretBroker(store, { cacheTtlMs: 0 });

    await Promise.all([
      broker.saveGoogleTokenJson("A"),
      broker.saveGoogleTokenJson("B"),
      broker.delete("googleTokenJson"),
      broker.saveGoogleTokenJson("C"),
    ]);

    expect(order).toEqual([
      "start:A", "end:A",
      "start:B", "end:B",
      "start:delete", "end:delete",
      "start:C", "end:C",
    ]);
  });

  it("continues serializing after a write rejects", async () => {
    const calls: string[] = [];
    let first = true;
    const store: SecretStore = {
      async has() { return false; },
      async get() { return null; },
      async set(_name, value) {
        calls.push(value);
        if (first) {
          first = false;
          throw new Error("boom");
        }
      },
      async delete() {},
    };
    const broker = new SecretBroker(store, { cacheTtlMs: 0 });

    const failing = broker.saveGoogleTokenJson("A");
    const following = broker.saveGoogleTokenJson("B");

    await expect(failing).rejects.toThrow("boom");
    await expect(following).resolves.toBeUndefined();
    expect(calls).toEqual(["A", "B"]);
  });

  it("convenience getters delegate to get()", async () => {
    const store = new CountingSecretStore({
      apiToken: "api-1",
      slackAppToken: "xapp-1",
      telegramBotToken: "tg-1",
      discordBotToken: "discord-1",
      notionApiKey: "notion-1",
      githubToken: "gh-1",
      githubWebhookSecret: "wh-1",
      googleCredentialsJson: '{"type":"service_account"}',
      googleTokenJson: '{"access_token":"at"}',
    });
    const broker = new SecretBroker(store, { cacheTtlMs: 0 });

    await expect(broker.getApiToken()).resolves.toBe("api-1");
    await expect(broker.getSlackAppToken()).resolves.toBe("xapp-1");
    await expect(broker.getTelegramBotToken()).resolves.toBe("tg-1");
    await expect(broker.getDiscordBotToken()).resolves.toBe("discord-1");
    await expect(broker.getNotionApiKey()).resolves.toBe("notion-1");
    await expect(broker.getGitHubToken()).resolves.toBe("gh-1");
    await expect(broker.getGitHubWebhookSecret()).resolves.toBe("wh-1");
    await expect(broker.getGoogleCredentialsJson()).resolves.toBe('{"type":"service_account"}');
    await expect(broker.getGoogleTokenJson()).resolves.toBe('{"access_token":"at"}');
  });

  it("Apple Calendar credentials round-trip and delete via the broker", async () => {
    const store = new CountingSecretStore();
    const broker = new SecretBroker(store, { cacheTtlMs: 0 });

    expect(await broker.getAppleCalendarCredentialsJson()).toBeNull();

    await broker.saveAppleCalendarCredentialsJson('{"username":"u"}');
    expect(await broker.getAppleCalendarCredentialsJson()).toBe('{"username":"u"}');

    await broker.deleteAppleCalendarCredentials();
    expect(await broker.getAppleCalendarCredentialsJson()).toBeNull();
  });

  it("scoped accessors share the cache + write-tail with static names", async () => {
    const name = scopedSecretName("git.account", "personal");
    const store = new CountingSecretStore();
    const broker = new SecretBroker(store, { cacheTtlMs: 60_000 });

    expect(await broker.hasScoped(name)).toBe(false);
    expect(await broker.getScoped(name)).toBeNull();

    await broker.setScoped(name, "ghp_1");
    expect(await broker.getScoped(name)).toBe("ghp_1");
    expect(await broker.hasScoped(name)).toBe(true);

    // Delete drops the value AND invalidates cache.
    await broker.deleteScoped(name);
    expect(await broker.getScoped(name)).toBeNull();
    expect(await broker.hasScoped(name)).toBe(false);
  });

  describe("backend API key storage", () => {
    it("get/set/delete round-trip the raw scoped secret", async () => {
      const store = new CountingSecretStore();
      const broker = new SecretBroker(store, { cacheTtlMs: 0 });

      expect(await broker.getBackendApiKey("claude")).toBeNull();

      await broker.setBackendApiKey("claude", "sk-ant-1");
      expect(await broker.getBackendApiKey("claude")).toBe("sk-ant-1");

      await broker.deleteBackendApiKey("claude");
      expect(await broker.getBackendApiKey("claude")).toBeNull();
    });

    it("getBackendApiKeyConfig parses the stored JSON config blob", async () => {
      const store = new CountingSecretStore();
      const broker = new SecretBroker(store, { cacheTtlMs: 0 });

      // No config persisted yet.
      expect(await broker.getBackendApiKeyConfig("claude")).toBeNull();

      await broker.setBackendApiKeyConfig("claude", {
        provider: "anthropic",
        apiKey: "sk-ant-2",
      });
      const cfg = await broker.getBackendApiKeyConfig("claude");
      expect(cfg).toEqual({ provider: "anthropic", apiKey: "sk-ant-2" });
    });

    it("getBackendApiKeyConfig promotes legacy raw-string entries", async () => {
      // Legacy: a bare API key string (pre-config-blob format) was stored
      // directly. parseBackendApiKeyConfig should promote it to the
      // backend's default direct provider.
      const store = new CountingSecretStore();
      const broker = new SecretBroker(store, { cacheTtlMs: 0 });
      await broker.setBackendApiKey("claude", "sk-ant-legacy");

      const cfg = await broker.getBackendApiKeyConfig("claude");
      expect(cfg).not.toBeNull();
      expect((cfg as { apiKey?: string }).apiKey).toBe("sk-ant-legacy");
    });
  });

  it("default cacheTtlMs is applied when not overridden", async () => {
    // Construct without options — the `?? 60_000` branch should resolve.
    const store = new CountingSecretStore({ apiToken: "api-1" });
    const broker = new SecretBroker(store);

    await broker.getApiToken();
    await broker.getApiToken();
    // Within the default 60s TTL, the second read serves from cache.
    expect(store.getCalls.get("apiToken")).toBe(1);
  });
});
