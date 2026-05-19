import {
  parseBackendApiKeyConfig,
  serializeBackendApiKeyConfig,
  type BackendApiKeyConfig,
  type BackendId,
} from "@aitne/shared";
import type { SecretStore } from "./secret-store.js";
import { backendApiKeySecretName } from "./secret-names.js";
import type {
  ScopedSecretName,
  SecretCacheEntry,
  SecretName,
  StoredSecretName,
} from "./types.js";

export interface SecretBrokerOptions {
  cacheTtlMs?: number;
}

export class SecretBroker {
  private readonly cache = new Map<StoredSecretName, SecretCacheEntry>();
  private readonly cacheTtlMs: number;
  // Per-secret write tail. Serializes set/delete for the same name so
  // concurrent writers (e.g. Calendar + Gmail OAuth refreshes hitting
  // googleTokenJson) don't collide at the underlying store.
  private readonly writeTails = new Map<StoredSecretName, Promise<void>>();

  constructor(
    private readonly secretStore: SecretStore,
    options: SecretBrokerOptions = {},
  ) {
    this.cacheTtlMs = options.cacheTtlMs ?? 60_000;
  }

  async has(name: SecretName): Promise<boolean> {
    return (await this.get(name)) !== null;
  }

  async get(name: SecretName): Promise<string | null> {
    return this.getRaw(name);
  }

  async set(name: SecretName, value: string): Promise<void> {
    return this.enqueueWrite(name, () => this.secretStore.set(name, value));
  }

  async delete(name: SecretName): Promise<void> {
    return this.enqueueWrite(name, () => this.secretStore.delete(name));
  }

  /**
   * Scoped-secret accessors — typed for `git.account.<alias>` and other
   * runtime-scoped families declared in `secret-names.ts`. Sharing the
   * cache + write-tail machinery with the static-name accessors keeps
   * the broker's correctness contract unchanged: concurrent
   * `setScoped` / `deleteScoped` for the same alias serialize, and the
   * cache invalidates on every write. Callers must build the name via
   * `scopedSecretName(...)` so the prefix lives in one place.
   */
  async hasScoped(name: ScopedSecretName): Promise<boolean> {
    return (await this.getRaw(name)) !== null;
  }

  async getScoped(name: ScopedSecretName): Promise<string | null> {
    return this.getRaw(name);
  }

  async setScoped(name: ScopedSecretName, value: string): Promise<void> {
    return this.enqueueWrite(name, () => this.secretStore.set(name, value));
  }

  async deleteScoped(name: ScopedSecretName): Promise<void> {
    return this.enqueueWrite(name, () => this.secretStore.delete(name));
  }

  private async getRaw(name: StoredSecretName): Promise<string | null> {
    const now = Date.now();
    const cached = this.cache.get(name);
    if (cached && cached.expiresAt > now) {
      return cached.value;
    }

    const value = await this.secretStore.get(name);
    this.cache.set(name, {
      value,
      expiresAt: now + this.cacheTtlMs,
    });
    return value;
  }

  private enqueueWrite(
    name: StoredSecretName,
    op: () => Promise<void>,
  ): Promise<void> {
    const prev = this.writeTails.get(name) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(async () => {
      try {
        await op();
      } finally {
        this.cache.delete(name);
      }
    });
    this.writeTails.set(name, next);
    next.finally(() => {
      if (this.writeTails.get(name) === next) {
        this.writeTails.delete(name);
      }
    }).catch(() => undefined);
    return next;
  }

  invalidate(name: StoredSecretName): void {
    this.cache.delete(name);
  }

  clearCache(): void {
    this.cache.clear();
  }

  getApiToken(): Promise<string | null> {
    return this.get("apiToken");
  }

  getSlackBotToken(): Promise<string | null> {
    return this.get("slackBotToken");
  }

  getSlackAppToken(): Promise<string | null> {
    return this.get("slackAppToken");
  }

  getTelegramBotToken(): Promise<string | null> {
    return this.get("telegramBotToken");
  }

  getDiscordBotToken(): Promise<string | null> {
    return this.get("discordBotToken");
  }

  getNotionApiKey(): Promise<string | null> {
    return this.get("notionApiKey");
  }

  getGitHubToken(): Promise<string | null> {
    return this.get("githubToken");
  }

  getGitHubWebhookSecret(): Promise<string | null> {
    return this.get("githubWebhookSecret");
  }

  getGoogleCredentialsJson(): Promise<string | null> {
    return this.get("googleCredentialsJson");
  }

  getGoogleTokenJson(): Promise<string | null> {
    return this.get("googleTokenJson");
  }

  saveGoogleTokenJson(json: string): Promise<void> {
    return this.set("googleTokenJson", json);
  }

  getGoogleMapsApiKey(): Promise<string | null> {
    return this.get("googleMapsApiKey");
  }

  getAppleCalendarCredentialsJson(): Promise<string | null> {
    return this.get("appleCalendarCredentials");
  }

  saveAppleCalendarCredentialsJson(json: string): Promise<void> {
    return this.set("appleCalendarCredentials", json);
  }

  deleteAppleCalendarCredentials(): Promise<void> {
    return this.delete("appleCalendarCredentials");
  }

  // ── Per-backend provider API keys ─────────────────────────────────
  // Stored in the OS keychain when the operator opts to use the
  // dashboard's API-key surface instead of CLI login / OAuth. When a
  // value is present, `backend-api-key-env.ts` mirrors it into
  // `process.env` (ANTHROPIC_API_KEY / OPENAI_API_KEY / GEMINI_API_KEY+
  // GOOGLE_API_KEY) so the existing SDK / CLI subprocesses pick it up
  // without per-spawn-site refactoring.

  getBackendApiKey(backendId: string): Promise<string | null> {
    return this.getScoped(backendApiKeySecretName(backendId));
  }

  setBackendApiKey(backendId: string, value: string): Promise<void> {
    return this.setScoped(backendApiKeySecretName(backendId), value);
  }

  deleteBackendApiKey(backendId: string): Promise<void> {
    return this.deleteScoped(backendApiKeySecretName(backendId));
  }

  /**
   * Read the parsed `BackendApiKeyConfig` for a backend. Decodes the
   * stored JSON blob, or falls back to legacy raw-string entries
   * (promoted to the backend's default direct provider). Returns null
   * when nothing is configured or the stored value is malformed.
   */
  async getBackendApiKeyConfig(
    backendId: BackendId,
  ): Promise<BackendApiKeyConfig | null> {
    const raw = await this.getBackendApiKey(backendId);
    return parseBackendApiKeyConfig(backendId, raw);
  }

  setBackendApiKeyConfig(
    backendId: BackendId,
    config: BackendApiKeyConfig,
  ): Promise<void> {
    return this.setBackendApiKey(
      backendId,
      serializeBackendApiKeyConfig(config),
    );
  }
}
