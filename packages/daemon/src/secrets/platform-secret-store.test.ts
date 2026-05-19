import { describe, it, expect } from "vitest";
import type { PersonalAgentKeychainClient } from "@aitne/shared/keychain-helper-client";
import { PlatformSecretStore } from "./platform-secret-store.js";

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
  it("supports set/get/delete/has via injected client", async () => {
    const store = new PlatformSecretStore({ client: new FakeSecretClient() });

    await expect(store.has("slackBotToken")).resolves.toBe(false);

    await store.set("slackBotToken", "xoxb-secret");
    await expect(store.has("slackBotToken")).resolves.toBe(true);
    await expect(store.get("slackBotToken")).resolves.toBe("xoxb-secret");

    await store.delete("slackBotToken");
    await expect(store.get("slackBotToken")).resolves.toBeNull();
  });
});
