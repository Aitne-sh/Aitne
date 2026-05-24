import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PersonalAgentKeychainClient } from "@aitne/shared/keychain-helper-client";

const createSecretClientMock = vi.fn<() => Promise<PersonalAgentKeychainClient>>();

vi.mock("@aitne/shared/secret-client-factory", () => ({
  createSecretClient: () => createSecretClientMock(),
}));

class FakeSecretClient implements PersonalAgentKeychainClient {
  readonly values = new Map<string, string>();

  async has(secretName: string): Promise<boolean> {
    return this.values.has(secretName);
  }

  async get(secretName: string): Promise<string | null> {
    return this.values.get(secretName) ?? null;
  }

  async set(secretName: string, value: string): Promise<void> {
    this.values.set(secretName, value);
  }

  async delete(secretName: string): Promise<void> {
    this.values.delete(secretName);
  }
}

describe("PlatformSecretStore", () => {
  beforeEach(() => {
    vi.resetModules();
    createSecretClientMock.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("supports set/get/delete/has via injected client", async () => {
    const { PlatformSecretStore } = await import("./platform-secret-store.js");
    const store = new PlatformSecretStore({ client: new FakeSecretClient() });

    await expect(store.has("slackBotToken")).resolves.toBe(false);

    await store.set("slackBotToken", "xoxb-secret");
    await expect(store.has("slackBotToken")).resolves.toBe(true);
    await expect(store.get("slackBotToken")).resolves.toBe("xoxb-secret");

    await store.delete("slackBotToken");
    await expect(store.get("slackBotToken")).resolves.toBeNull();

    // Factory must NOT have been called when an explicit client was injected.
    expect(createSecretClientMock).not.toHaveBeenCalled();
  });

  it("falls back to createSecretClient() when no client is injected", async () => {
    const fake = new FakeSecretClient();
    createSecretClientMock.mockResolvedValue(fake);

    const { PlatformSecretStore } = await import("./platform-secret-store.js");
    const store = new PlatformSecretStore();

    await store.set("slackBotToken", "from-factory");
    await expect(store.get("slackBotToken")).resolves.toBe("from-factory");
    expect(createSecretClientMock).toHaveBeenCalledOnce();
  });

  it("captures initialisation failure and re-throws on every method", async () => {
    const initErr = new Error("keychain ACL denied");
    createSecretClientMock.mockRejectedValue(initErr);

    const { PlatformSecretStore } = await import("./platform-secret-store.js");
    const store = new PlatformSecretStore();

    // Each method calls getClient(), which sees the captured initError and
    // re-throws synchronously inside the async fn. All four entry points
    // must surface the same root cause — never a generic "client undefined".
    await expect(store.has("slackBotToken")).rejects.toThrow(initErr);
    await expect(store.get("slackBotToken")).rejects.toThrow(initErr);
    await expect(store.set("slackBotToken", "x")).rejects.toThrow(initErr);
    await expect(store.delete("slackBotToken")).rejects.toThrow(initErr);
  });
});
