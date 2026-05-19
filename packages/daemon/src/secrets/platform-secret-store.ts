import type { PersonalAgentKeychainClient } from "@aitne/shared/keychain-helper-client";
import { createSecretClient } from "@aitne/shared/secret-client-factory";
import type { SecretStore } from "./secret-store.js";
import type { StoredSecretName } from "./secret-names.js";

export interface PlatformSecretStoreOptions {
  client?: PersonalAgentKeychainClient;
}

export class PlatformSecretStore implements SecretStore {
  private readonly clientPromise: Promise<PersonalAgentKeychainClient>;
  private initError: Error | null = null;

  constructor(options: PlatformSecretStoreOptions = {}) {
    this.clientPromise = (options.client
      ? Promise.resolve(options.client)
      : createSecretClient()
    ).catch((err: Error) => {
      // Capture the error so it doesn't float as an unhandled rejection.
      // It will be re-thrown on the first method call.
      this.initError = err;
      throw err;
    });
  }

  private async getClient(): Promise<PersonalAgentKeychainClient> {
    if (this.initError) throw this.initError;
    return await this.clientPromise;
  }

  async has(name: StoredSecretName): Promise<boolean> {
    const client = await this.getClient();
    return await client.has(name);
  }

  async get(name: StoredSecretName): Promise<string | null> {
    const client = await this.getClient();
    return await client.get(name);
  }

  async set(name: StoredSecretName, value: string): Promise<void> {
    const client = await this.getClient();
    await client.set(name, value);
  }

  async delete(name: StoredSecretName): Promise<void> {
    const client = await this.getClient();
    await client.delete(name);
  }
}
