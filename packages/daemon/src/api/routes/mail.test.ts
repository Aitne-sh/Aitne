import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import type { AgentConfig } from "../../config.js";
import { createMailRoutes } from "./mail/index.js";
import { computeAgentWriteTtlMs } from "./mail/provider-resolver.js";
import {
  MailAccountRegistry,
} from "../../services/mail/account-registry.js";
import type {
  MailAccount,
  MailMessage,
  MailProvider,
} from "../../services/mail/provider.js";
import type { ServiceRegistry } from "../../services/service-registry.js";
import type { EncryptedBlobStore } from "../../secrets/encrypted-blob-store.js";
import type { BlobName } from "../../secrets/types.js";
import {
  parseImapAccountSecret,
  type ImapAccountSecret,
} from "../../services/mail/imap/app-password.js";
import {
  probeCapabilities,
  type ImapCapabilitySet,
} from "../../services/mail/imap/capabilities.js";
class MemoryBlobStore implements EncryptedBlobStore {
  readonly blobs = new Map<string, string>();
  async exists(name: BlobName): Promise<boolean> {
    return this.blobs.has(name);
  }
  async readUtf8(name: BlobName): Promise<string | null> {
    return this.blobs.get(name) ?? null;
  }
  async writeUtf8(name: BlobName, plaintext: string): Promise<void> {
    this.blobs.set(name, plaintext);
  }
  async remove(name: BlobName): Promise<void> {
    this.blobs.delete(name);
  }
}

function createMailSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE mail_accounts (
      id                       TEXT PRIMARY KEY,
      kind                     TEXT NOT NULL,
      email                    TEXT NOT NULL,
      label                    TEXT,
      auth_type                TEXT NOT NULL,
      auth_status              TEXT NOT NULL DEFAULT 'healthy',
      secret_blob_name         TEXT NOT NULL,
      poll_cursor_json         TEXT,
      poll_interval_seconds    INTEGER NOT NULL DEFAULT 300,
      idle_enabled             INTEGER NOT NULL DEFAULT 0,
      idle_fallback_until      TEXT,
      unified_poll             INTEGER NOT NULL DEFAULT 1,
      active                   INTEGER NOT NULL DEFAULT 1,
      created_at_utc           TEXT NOT NULL,
      last_error               TEXT,
      last_error_at_utc        TEXT,
      last_poll_at_utc         TEXT,
      consecutive_error_count  INTEGER NOT NULL DEFAULT 0,
      imap_capabilities_json   TEXT,
      UNIQUE (kind, email)
    );
    CREATE TABLE settings (
      key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    -- INTEGRATION-DRIFT-DETECTION-PLAN.md §11 Phase 4 — Gmail send routes
    -- mark this table for actor='agent' attribution. The full schema lives
    -- in db/schema.ts; this minimal mirror keeps the mail-test harness
    -- self-contained.
    CREATE TABLE integration_writes (
      integration TEXT NOT NULL,
      item_id     TEXT NOT NULL,
      written_at  TEXT NOT NULL,
      written_by  TEXT NOT NULL DEFAULT 'agent',
      expires_at  TEXT NOT NULL,
      PRIMARY KEY (integration, item_id)
    );
    CREATE TABLE parse_failures (
      id              INTEGER PRIMARY KEY,
      account_id      TEXT,
      provider_msg_id TEXT,
      sender          TEXT,
      subject         TEXT,
      snippet         TEXT,
      error_reason    TEXT NOT NULL,
      created_at      TEXT DEFAULT (datetime('now'))
    );
  `);
}

function makeConfig(
  overrides: Partial<AgentConfig> = {},
): AgentConfig {
  // Minimal subset of AgentConfig sufficient for the routes under test —
  // the rest is cast because the routes only touch `enabledMailProviders`.
  return {
    enabledMailProviders: ["gmail", "outlook"],
    ...overrides,
  } as unknown as AgentConfig;
}

describe("computeAgentWriteTtlMs", () => {
  it("floors at 5 minutes for poll intervals whose 2× is below the floor", () => {
    // 30s × 2 = 60s < 300s floor → clamped
    expect(computeAgentWriteTtlMs(30)).toBe(5 * 60 * 1000);
    // 149s × 2 = 298s < 300s floor → clamped
    expect(computeAgentWriteTtlMs(149)).toBe(5 * 60 * 1000);
    expect(computeAgentWriteTtlMs(undefined)).toBe(5 * 60 * 1000);
  });
  it("scales to 2× poll interval once it exceeds the floor", () => {
    // 180s (default) × 2 = 360s > 300s floor → 360_000ms
    expect(computeAgentWriteTtlMs(180)).toBe(360 * 1000);
    // 600s × 2 = 1200s = 20min
    expect(computeAgentWriteTtlMs(600)).toBe(20 * 60 * 1000);
    // 3600s (max) × 2 = 2h
    expect(computeAgentWriteTtlMs(3600)).toBe(2 * 3600 * 1000);
  });
});

describe("Mail routes", () => {
  let db: Database.Database;
  let blobStore: MemoryBlobStore;

  beforeEach(() => {
    db = new Database(":memory:");
    createMailSchema(db);
    blobStore = new MemoryBlobStore();
  });

  afterEach(() => {
    db.close();
  });

  function makeStubProvider(account: MailAccount): MailProvider {
    return {
      kind: account.kind,
      account,
      list: async () => [],
      get: async () => {
        throw new Error("stub get");
      },
      send: async () => ({ id: "stub", isDraft: true }),
      modifyTags: async () => undefined,
      markRead: async () => undefined,
      trash: async () => undefined,
      listFolders: async () => [],
      pollSince: async () => ({
        messages: [],
        removedIds: [],
        nextCursor:
          account.kind === "outlook"
            ? { kind: "graph" as const }
            : { kind: "imap" as const, folders: {} },
        drained: true,
      }),
      revoke: async () => undefined,
    };
  }

  function makeRegistry(
    enabledKinds: ("gmail" | "outlook" | "yahoo" | "icloud")[] = ["gmail", "outlook"],
  ): MailAccountRegistry {
    return new MailAccountRegistry({
      db,
      blobStore,
      getEnabledKinds: () => enabledKinds,
      providerFactories: {
        gmail: (account) => makeStubProvider(account),
        outlook: (account) => makeStubProvider(account),
        yahoo: (account) => makeStubProvider(account),
        icloud: (account) => makeStubProvider(account),
      },
      now: () => new Date("2026-04-16T12:00:00.000Z"),
    });
  }

  function makeRegistryWithHook(
    onScopeChanged: (reason: string) => void,
    enabledKinds: ("gmail" | "outlook" | "yahoo" | "icloud")[] = ["gmail", "outlook"],
  ): MailAccountRegistry {
    return new MailAccountRegistry({
      db,
      blobStore,
      getEnabledKinds: () => enabledKinds,
      providerFactories: {
        gmail: (account) => makeStubProvider(account),
        outlook: (account) => makeStubProvider(account),
        yahoo: (account) => makeStubProvider(account),
        icloud: (account) => makeStubProvider(account),
      },
      now: () => new Date("2026-04-16T12:00:00.000Z"),
      onScopeChanged,
    });
  }

  function mountApp(
    registry: MailAccountRegistry | null,
    configOverrides: Partial<AgentConfig> = {},
    verifyImap?: (secret: ImapAccountSecret) => Promise<ImapCapabilitySet>,
  ) {
    const services = { mail: registry } as unknown as ServiceRegistry;
    return createMailRoutes({
      db,
      config: makeConfig(configOverrides),
      services,
      blobStore,
      verifyImapAccountSecret:
        verifyImap ?? (async () => probeCapabilities(["IDLE"])),
    });
  }

  it("GET /mail/providers returns enabled kinds and per-kind counts", async () => {
    const registry = makeRegistry();
    await registry.addAccount({
      kind: "gmail",
      email: "o@example.com",
      authType: "oauth",
      secretPayload: "x",
    });
    const app = mountApp(registry);
    const res = await app.request("/mail/providers");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      enabledKinds: string[];
      available: Array<{ kind: string; accountsConfigured: number; accountsHealthy: number }>;
    };
    expect(body.enabledKinds).toEqual(["gmail", "outlook"]);
    const gmailEntry = body.available.find((a) => a.kind === "gmail")!;
    expect(gmailEntry.accountsConfigured).toBe(1);
    expect(gmailEntry.accountsHealthy).toBe(1);
  });

  it("GET /mail/accounts returns [] when registry is absent", async () => {
    const app = mountApp(null);
    const res = await app.request("/mail/accounts");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ accounts: [] });
  });

  it("GET /mail/accounts returns every row (dormant + unhealthy included)", async () => {
    const registry = makeRegistry(["gmail", "outlook"]);
    const healthy = await registry.addAccount({
      kind: "gmail",
      email: "live@example.com",
      authType: "oauth",
      secretPayload: "x",
    });
    const inactive = await registry.addAccount({
      kind: "outlook",
      email: "paused@example.com",
      authType: "oauth",
      secretPayload: "x",
    });
    await registry.setActive(inactive.id, false);
    const unhealthy = await registry.addAccount({
      kind: "outlook",
      email: "broken@example.com",
      authType: "oauth",
      secretPayload: "x",
    });
    registry.updateAuthStatus(unhealthy.id, "requires_consent", "revoked");
    const app = mountApp(registry);
    const res = await app.request("/mail/accounts");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { accounts: Array<{ id: string }> };
    expect(body.accounts.map((a) => a.id).sort()).toEqual(
      [healthy.id, inactive.id, unhealthy.id].sort(),
    );
  });

  it("GET /mail/accounts?active=1 filters to scope-gated accounts only", async () => {
    const registry = makeRegistry(["gmail", "outlook"]);
    const healthy = await registry.addAccount({
      kind: "gmail",
      email: "live@example.com",
      authType: "oauth",
      secretPayload: "x",
    });
    const inactive = await registry.addAccount({
      kind: "outlook",
      email: "paused@example.com",
      authType: "oauth",
      secretPayload: "x",
    });
    await registry.setActive(inactive.id, false);
    const unhealthy = await registry.addAccount({
      kind: "outlook",
      email: "broken@example.com",
      authType: "oauth",
      secretPayload: "x",
    });
    registry.updateAuthStatus(unhealthy.id, "requires_consent", "revoked");
    // Seed one more account whose kind is not enabled.
    const disabledKind = await registry.addAccount({
      kind: "yahoo",
      email: "dormant@example.com",
      authType: "app_password",
      secretPayload: "x",
    });
    const app = mountApp(registry, {
      enabledMailProviders: ["gmail", "outlook"] as const,
    });
    const res = await app.request("/mail/accounts?active=1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { accounts: Array<{ id: string }> };
    expect(body.accounts.map((a) => a.id)).toEqual([healthy.id]);
    // sanity: the other three are all excluded — inactive, unhealthy, disabled-kind
    expect(body.accounts.map((a) => a.id)).not.toContain(inactive.id);
    expect(body.accounts.map((a) => a.id)).not.toContain(unhealthy.id);
    expect(body.accounts.map((a) => a.id)).not.toContain(disabledKind.id);
  });

  it("PATCH /mail/accounts/:id flips active and returns the updated row", async () => {
    const registry = makeRegistry();
    const account = await registry.addAccount({
      kind: "gmail",
      email: "o@example.com",
      authType: "oauth",
      secretPayload: "x",
    });
    const app = mountApp(registry);
    const res = await app.request(`/mail/accounts/${account.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ active: false }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      account: { active: boolean };
    };
    expect(body.status).toBe("updated");
    expect(body.account.active).toBe(false);
    expect(registry.getAccount(account.id)?.active).toBe(false);
  });

  it("PATCH /mail/accounts/:id returns 400 when active is not a boolean", async () => {
    const registry = makeRegistry();
    const account = await registry.addAccount({
      kind: "gmail",
      email: "o@example.com",
      authType: "oauth",
      secretPayload: "x",
    });
    const app = mountApp(registry);
    const res = await app.request(`/mail/accounts/${account.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ active: "nope" }),
    });
    expect(res.status).toBe(400);
  });

  it("PATCH /mail/accounts/:id returns 404 for unknown id", async () => {
    const app = mountApp(makeRegistry());
    const res = await app.request(`/mail/accounts/ghost`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ active: true }),
    });
    expect(res.status).toBe(404);
  });

  it("DELETE /mail/accounts/:id removes account and returns 200", async () => {
    const registry = makeRegistry();
    const account = await registry.addAccount({
      kind: "gmail",
      email: "o@example.com",
      authType: "oauth",
      secretPayload: "x",
    });
    const app = mountApp(registry);
    const res = await app.request(`/mail/accounts/${account.id}`, {
      method: "DELETE",
    });
    expect(res.status).toBe(200);
    expect(registry.getAccount(account.id)).toBeNull();
  });

  it("DELETE /mail/accounts/:id returns 404 for unknown id", async () => {
    const app = mountApp(makeRegistry());
    const res = await app.request(`/mail/accounts/ghost`, { method: "DELETE" });
    expect(res.status).toBe(404);
  });

  it("POST /mail/accounts rejects unsupported kinds with 400", async () => {
    const app = mountApp(makeRegistry());
    const res = await app.request("/mail/accounts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "yahoo" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, any>;
    expect(body.error).toBe("unsupported_kind");
  });

  it("POST /mail/accounts returns 412 when BYOA client-config is missing", async () => {
    const app = mountApp(makeRegistry());
    const res = await app.request("/mail/accounts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "outlook" }),
    });
    expect(res.status).toBe(412);
    const body = (await res.json()) as Record<string, any>;
    expect(body.error).toBe("outlook_client_config_missing");
  });

  it("PUT /config/mail/outlook/client-config saves clientId+tenant", async () => {
    const app = mountApp(makeRegistry());
    const res = await app.request("/config/mail/outlook/client-config", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ clientId: "abc123", tenant: "organizations" }),
    });
    expect(res.status).toBe(200);
    expect(blobStore.blobs.has("mail:outlook:client-config")).toBe(true);
  });

  it("PUT /config/mail/outlook/client-config defaults tenant to 'common'", async () => {
    const app = mountApp(makeRegistry());
    const res = await app.request("/config/mail/outlook/client-config", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ clientId: "abc123" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    expect(body.tenant).toBe("common");
  });

  it("GET /config/mail/outlook/client-config returns { configured: false } when absent", async () => {
    const app = mountApp(makeRegistry());
    const res = await app.request("/config/mail/outlook/client-config");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ configured: false });
  });

  it("POST /config/mail/app-password adds a Yahoo account with idle enabled", async () => {
    const app = mountApp(
      makeRegistry(["gmail", "outlook", "yahoo"]),
      { enabledMailProviders: ["gmail", "outlook", "yahoo"] as const },
    );
    const res = await app.request("/config/mail/app-password", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "yahoo",
        email: "owner@yahoo.example.com",
        appPassword: "secret",
        label: "personal",
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      account: { kind: string; email: string; idleEnabled: boolean };
    };
    expect(body.status).toBe("completed");
    expect(body.account.kind).toBe("yahoo");
    expect(body.account.idleEnabled).toBe(true);

    const row = db
      .prepare(`SELECT secret_blob_name FROM mail_accounts WHERE email = ?`)
      .get("owner@yahoo.example.com") as { secret_blob_name: string };
    const secret = parseImapAccountSecret(
      blobStore.blobs.get(row.secret_blob_name)!,
    );
    expect(secret.kind).toBe("yahoo");
    expect(secret.imap.host).toBe("imap.mail.yahoo.com");
  });

  it("POST /config/mail/app-password rejects invalid IMAP credentials", async () => {
    const verifyImap = async () => {
      const error = new Error("AUTHENTICATIONFAILED");
      Object.assign(error, { responseCode: 535 });
      throw error;
    };
    const app = mountApp(
      makeRegistry(["gmail", "outlook", "icloud"]),
      { enabledMailProviders: ["gmail", "outlook", "icloud"] as const },
      verifyImap,
    );
    const res = await app.request("/config/mail/app-password", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "icloud",
        email: "owner@icloud.example.com",
        appPassword: "wrong",
      }),
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      error: "imap_auth_failed",
    });
    expect(
      db.prepare(`SELECT COUNT(*) AS count FROM mail_accounts`).get() as { count: number },
    ).toEqual({ count: 0 });
  });

  it("POST /config/mail/app-password returns 409 on duplicate IMAP accounts", async () => {
    const registry = makeRegistry(["gmail", "outlook", "icloud"]);
    await registry.addAccount({
      kind: "icloud",
      email: "owner@icloud.example.com",
      authType: "app_password",
      secretPayload: JSON.stringify({ ok: true }),
      idleEnabled: true,
    });
    const app = mountApp(
      registry,
      { enabledMailProviders: ["gmail", "outlook", "icloud"] as const },
    );
    const res = await app.request("/config/mail/app-password", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "icloud",
        email: "owner@icloud.example.com",
        appPassword: "secret",
      }),
    });
    expect(res.status).toBe(409);
  });

  it("POST /config/mail/app-password/:id/refresh updates an existing IMAP account", async () => {
    const registry = makeRegistry(["gmail", "yahoo"]);
    const seeded = await registry.addAccount({
      kind: "yahoo",
      email: "owner@yahoo.example.com",
      authType: "app_password",
      secretPayload: JSON.stringify({ kind: "yahoo", appPassword: "old" }),
      idleEnabled: true,
    });
    registry.updateAuthStatus(seeded.id, "requires_consent", "rotated");
    const app = mountApp(registry);
    const res = await app.request(
      `/config/mail/app-password/${seeded.id}/refresh`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ appPassword: "new-password" }),
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      account: { id: string; authStatus: string };
    };
    expect(body.status).toBe("refreshed");
    expect(body.account.authStatus).toBe("healthy");
    // Blob was overwritten in place — same name, new payload.
    expect(blobStore.blobs.size).toBe(1);
    const [name] = [...blobStore.blobs.keys()];
    expect(blobStore.blobs.get(name)).toContain("new-password");
  });

  it("POST /config/mail/app-password/:id/refresh 404s on unknown account", async () => {
    const app = mountApp(makeRegistry());
    const res = await app.request("/config/mail/app-password/ghost/refresh", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ appPassword: "x" }),
    });
    expect(res.status).toBe(404);
  });

  it("POST /config/mail/app-password/:id/refresh 400s on oauth (outlook) account", async () => {
    const registry = makeRegistry();
    const account = await registry.addAccount({
      kind: "outlook",
      email: "owner@outlook.example.com",
      authType: "oauth",
      secretPayload: "msal-cache",
    });
    const app = mountApp(registry);
    const res = await app.request(
      `/config/mail/app-password/${account.id}/refresh`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ appPassword: "x" }),
      },
    );
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      error: "unsupported_kind",
    });
  });

  it("POST /config/mail/app-password/:id/refresh 400s on bad credentials", async () => {
    const verifyImap = async () => {
      const error = new Error("AUTHENTICATIONFAILED");
      Object.assign(error, { responseCode: 535 });
      throw error;
    };
    const registry = makeRegistry(["gmail", "yahoo"]);
    const account = await registry.addAccount({
      kind: "yahoo",
      email: "owner@yahoo.example.com",
      authType: "app_password",
      secretPayload: JSON.stringify({ kind: "yahoo", appPassword: "old" }),
      idleEnabled: true,
    });
    const app = mountApp(registry, undefined, verifyImap);
    const res = await app.request(
      `/config/mail/app-password/${account.id}/refresh`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ appPassword: "still-wrong" }),
      },
    );
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      error: "imap_auth_failed",
    });
    // The old secret stays in place — failed verification must not overwrite.
    expect(registry.getAccount(account.id)?.authStatus).toBe("healthy");
  });

  describe("GET /mail/parse-failures", () => {
    it("returns the latest rows newest-first with optional accountId filter", async () => {
      db.prepare(
        `INSERT INTO parse_failures
           (account_id, provider_msg_id, sender, subject, snippet, error_reason, created_at)
         VALUES
           ('acc-1', 'msg-old', 'a@x', 'Old', 'snip', 'kindle_no_html', '2026-01-01T00:00:00Z'),
           ('acc-1', 'msg-new', 'b@x', 'New', 'snip2', 'kindle_unrecognized', '2026-04-16T00:00:00Z'),
           ('acc-2', 'msg-other', NULL, NULL, NULL, 'travel_no_match', '2026-04-16T01:00:00Z')`,
      ).run();
      const app = mountApp(makeRegistry());

      const all = await app.request("/mail/parse-failures");
      expect(all.status).toBe(200);
      const allBody = (await all.json()) as {
        failures: { providerMsgId: string }[];
        count: number;
      };
      expect(allBody.count).toBe(3);
      // Newest-first.
      expect(allBody.failures[0].providerMsgId).toBe("msg-other");

      const filtered = await app.request(
        "/mail/parse-failures?accountId=acc-1",
      );
      const filteredBody = (await filtered.json()) as {
        failures: { providerMsgId: string }[];
        count: number;
      };
      expect(filteredBody.count).toBe(2);
      expect(filteredBody.failures.every((f) => f.providerMsgId.startsWith("msg-"))).toBe(
        true,
      );
      expect(
        filteredBody.failures.map((f) => f.providerMsgId).sort(),
      ).toEqual(["msg-new", "msg-old"]);
    });

    it("respects the limit query parameter", async () => {
      const stmt = db.prepare(
        `INSERT INTO parse_failures (provider_msg_id, error_reason)
         VALUES (?, 'kindle_no_html')`,
      );
      for (let i = 0; i < 10; i++) stmt.run(`msg-${i}`);
      const app = mountApp(makeRegistry());

      const res = await app.request("/mail/parse-failures?limit=3");
      const body = (await res.json()) as { count: number };
      expect(body.count).toBe(3);
    });
  });

  // ── Per-account operation routes (Phase 5) ──
  describe("per-account /mail/:accountId/* surface", () => {
    async function seedOutlookAccount(
      registry: MailAccountRegistry,
    ): Promise<string> {
      const account = await registry.addAccount({
        kind: "outlook",
        email: "owner@outlook.example.com",
        authType: "oauth",
        secretPayload: "stub-msal-cache",
      });
      return account.id;
    }

    it("GET /:accountId/health returns MailAccountHealth for a live account", async () => {
      const registry = makeRegistry();
      const accountId = await seedOutlookAccount(registry);
      const app = mountApp(registry);
      const res = await app.request(`/mail/${accountId}/health`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, any>;
      expect(body.accountId).toBe(accountId);
      expect(body).toHaveProperty("lastPollAtUtc");
      expect(body).toHaveProperty("consecutiveErrorCount");
    });

    it("GET /:accountId/health 404s for unknown accountId", async () => {
      const app = mountApp(makeRegistry());
      const res = await app.request("/mail/does-not-exist/health");
      expect(res.status).toBe(404);
    });

    it("GET /:accountId/messages 400s when the account's provider is disabled", async () => {
      // Seed while outlook is enabled, then mount with outlook disabled.
      const registry = makeRegistry(["gmail", "outlook"]);
      const accountId = await seedOutlookAccount(registry);
      const app = mountApp(registry, {
        enabledMailProviders: ["gmail"] as const,
      });
      const res = await app.request(`/mail/${accountId}/messages`);
      expect(res.status).toBe(400);
      const body = (await res.json()) as Record<string, any>;
      expect(body.error).toBe("provider_not_enabled");
      expect(body.detail).toBe("kind_not_enabled");
    });

    it("GET /:accountId/messages 404s for unknown accountId", async () => {
      const app = mountApp(makeRegistry());
      const res = await app.request("/mail/unknown-account/messages");
      expect(res.status).toBe(404);
    });

    it("GET /:accountId/messages/:id/body extracts HTML body without dropping links or image metadata", async () => {
      const registry = makeRegistry();
      const accountId = await seedOutlookAccount(registry);
      const account = registry.getAccount(accountId)!;
      const html = `
        <html>
          <head><title>Hidden title</title></head>
          <body>
            <style>.x{display:none}</style>
            <script>track()</script>
            <p>United confirmation <strong>MNPQEN</strong></p>
            <table><tr><td>SFO</td><td>HND</td></tr></table>
            <a href="https://example.com/manage?code=MNPQEN&amp;utm=email">Manage trip</a>
            <a href="https://example.com/receipt?code=MNPQEN">Receipt</a>
            <img alt="Boarding barcode" src="cid:barcode-1">
          </body>
        </html>
      `;
      const message: MailMessage = {
        accountId,
        providerMsgId: "m-1",
        rfc822MsgId: "<m-1@example.com>",
        threadId: "t-1",
        folder: "inbox",
        receivedAtUtc: "2026-04-16T12:00:00.000Z",
        subject: "United itinerary",
        from: { email: "united@example.com" },
        to: [{ email: account.email }],
        snippet: "United confirmation MNPQEN",
        isRead: false,
        flags: [],
        body: { html },
        attachments: [],
      };
      const spyProvider = {
        ...makeStubProvider(account),
        get: async () => message,
      } as MailProvider;
      const spyRegistry = new MailAccountRegistry({
        db,
        blobStore,
        getEnabledKinds: () => ["gmail", "outlook"],
        providerFactories: { outlook: () => spyProvider },
      });
      const app = mountApp(spyRegistry);
      const res = await app.request(
        `/mail/${accountId}/messages/m-1/body?format=extracted&maxChars=5000&metadataLimit=1`,
      );
      expect(res.status).toBe(200);
      const body = await res.json() as {
        content: string;
        source: string;
        links: Array<{ text: string; href: string }>;
        images: Array<{ alt: string; src: string }>;
        linkCount: number;
        linksHasMore: boolean;
        nextMetadataOffset: number | null;
        rawHtmlAvailable: boolean;
      };
      expect(body.source).toBe("html");
      expect(body.rawHtmlAvailable).toBe(true);
      expect(body.content).toContain("United confirmation MNPQEN");
      expect(body.content).toContain("SFO");
      expect(body.content).toContain("HND");
      expect(body.content).not.toContain("track()");
      expect(body.content).toContain("Manage trip: https://example.com/manage?code=MNPQEN&utm=email");
      expect(body.content).toContain("Receipt: https://example.com/receipt?code=MNPQEN");
      expect(body.content).toContain("Boarding barcode: cid:barcode-1");
      expect(body.linkCount).toBe(2);
      expect(body.linksHasMore).toBe(true);
      expect(body.nextMetadataOffset).toBe(1);
      expect(body.links).toEqual([
        {
          text: "Manage trip",
          href: "https://example.com/manage?code=MNPQEN&utm=email",
          title: null,
        },
      ]);
      expect(body.images).toEqual([
        { alt: "Boarding barcode", title: null, src: "cid:barcode-1" },
      ]);
    });

    it("GET /:accountId/messages/:id/body chunks raw HTML when exact markup is needed", async () => {
      const registry = makeRegistry();
      const accountId = await seedOutlookAccount(registry);
      const account = registry.getAccount(accountId)!;
      const html = `<html><body><p>${"Long itinerary segment ".repeat(80)}</p></body></html>`;
      const message: MailMessage = {
        accountId,
        providerMsgId: "m-raw",
        rfc822MsgId: "<m-raw@example.com>",
        threadId: "t-raw",
        folder: "inbox",
        receivedAtUtc: "2026-04-16T12:00:00.000Z",
        subject: "Raw itinerary",
        from: { email: "airline@example.com" },
        to: [{ email: account.email }],
        snippet: "Long itinerary",
        isRead: false,
        flags: [],
        body: { html },
        attachments: [],
      };
      const spyProvider = {
        ...makeStubProvider(account),
        get: async () => message,
      } as MailProvider;
      const spyRegistry = new MailAccountRegistry({
        db,
        blobStore,
        getEnabledKinds: () => ["gmail", "outlook"],
        providerFactories: { outlook: () => spyProvider },
      });
      const app = mountApp(spyRegistry);
      const res = await app.request(
        `/mail/${accountId}/messages/m-raw/body?format=raw&maxChars=1000`,
      );
      expect(res.status).toBe(200);
      const body = await res.json() as {
        content: string;
        hasMore: boolean;
        nextChunk: number | null;
        totalChars: number;
        source: string;
      };
      expect(body.source).toBe("html");
      expect(body.content).toContain("<html><body><p>");
      expect(body.content.length).toBeLessThanOrEqual(1000);
      expect(body.totalChars).toBe(html.length);
      expect(body.hasMore).toBe(true);
      expect(body.nextChunk).toBe(1);
    });

    it("GET /:accountId/messages/:id/body rejects unknown formats", async () => {
      const registry = makeRegistry();
      const accountId = await seedOutlookAccount(registry);
      const app = mountApp(registry);
      const res = await app.request(
        `/mail/${accountId}/messages/m-1/body?format=markdown`,
      );
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: "invalid_query" });
    });

    it("GET /:accountId/messages/:id?body=none returns metadata without raw body", async () => {
      const registry = makeRegistry();
      const accountId = await seedOutlookAccount(registry);
      const account = registry.getAccount(accountId)!;
      const message: MailMessage = {
        accountId,
        providerMsgId: "m-meta",
        rfc822MsgId: "<m-meta@example.com>",
        threadId: "t-meta",
        folder: "inbox",
        receivedAtUtc: "2026-04-16T12:00:00.000Z",
        subject: "Metadata only",
        from: { email: "sender@example.com" },
        to: [{ email: account.email }],
        snippet: "snippet",
        isRead: false,
        flags: [],
        body: {
          text: "plain text that should not be returned",
          html: "<p>html that should not be returned</p>",
        },
        attachments: [],
      };
      const spyProvider = {
        ...makeStubProvider(account),
        get: async () => message,
      } as MailProvider;
      const spyRegistry = new MailAccountRegistry({
        db,
        blobStore,
        getEnabledKinds: () => ["gmail", "outlook"],
        providerFactories: { outlook: () => spyProvider },
      });
      const app = mountApp(spyRegistry);
      const res = await app.request(
        `/mail/${accountId}/messages/m-meta?body=none`,
      );
      expect(res.status).toBe(200);
      const body = await res.json() as { message: MailMessage };
      expect(body.message.subject).toBe("Metadata only");
      expect(body.message.body).toEqual({});
    });

    it("GET /:accountId/threads/:id?body=none returns thread headers without raw bodies", async () => {
      const registry = makeRegistry();
      const accountId = await seedOutlookAccount(registry);
      const account = registry.getAccount(accountId)!;
      const message: MailMessage = {
        accountId,
        providerMsgId: "m-thread",
        rfc822MsgId: "<m-thread@example.com>",
        threadId: "t-thread",
        folder: "inbox",
        receivedAtUtc: "2026-04-16T12:00:00.000Z",
        subject: "Thread metadata",
        from: { email: "sender@example.com" },
        to: [{ email: account.email }],
        snippet: "snippet",
        isRead: false,
        flags: [],
        body: { html: "<p>large html</p>" },
        attachments: [],
      };
      const spyProvider = {
        ...makeStubProvider(account),
        getThread: async () => ({
          threadId: "t-thread",
          messages: [message],
          status: "full" as const,
        }),
      } as MailProvider;
      const spyRegistry = new MailAccountRegistry({
        db,
        blobStore,
        getEnabledKinds: () => ["gmail", "outlook"],
        providerFactories: { outlook: () => spyProvider },
      });
      const app = mountApp(spyRegistry);
      const res = await app.request(
        `/mail/${accountId}/threads/t-thread?body=none`,
      );
      expect(res.status).toBe(200);
      const body = await res.json() as { thread: { messages: MailMessage[] } };
      expect(body.thread.messages[0]?.providerMsgId).toBe("m-thread");
      expect(body.thread.messages[0]?.body).toEqual({});
    });

    it("GET /:accountId/messages 400s provider_not_enabled detail=account_inactive when the account is disabled", async () => {
      const registry = makeRegistry();
      const accountId = await seedOutlookAccount(registry);
      await registry.setActive(accountId, false);
      const app = mountApp(registry);
      const res = await app.request(`/mail/${accountId}/messages`);
      expect(res.status).toBe(400);
      const body = (await res.json()) as Record<string, any>;
      expect(body.error).toBe("provider_not_enabled");
      expect(body.detail).toBe("account_inactive");
    });

    it("registry onScopeChanged fires when the active toggle flips via the API", async () => {
      const hook = vi.fn();
      const registry = makeRegistryWithHook(hook);
      const accountId = await seedOutlookAccount(registry);
      hook.mockClear(); // ignore the account_added event from seeding
      const app = mountApp(registry);
      const res = await app.request(`/mail/accounts/${accountId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ active: false }),
      });
      expect(res.status).toBe(200);
      expect(hook).toHaveBeenCalledWith("account_deactivated");
    });

    it("registry onScopeChanged is silent on idempotent active-toggle calls", async () => {
      const hook = vi.fn();
      const registry = makeRegistryWithHook(hook);
      const accountId = await seedOutlookAccount(registry);
      hook.mockClear();
      const app = mountApp(registry);
      // Flip false → false: no-op.
      const res = await app.request(`/mail/accounts/${accountId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ active: true }),
      });
      expect(res.status).toBe(200);
      // true → true: still no fire since wasActive === active.
      expect(hook).not.toHaveBeenCalled();
    });

    it("registry onScopeChanged fires when the account is removed via the API", async () => {
      const hook = vi.fn();
      const registry = makeRegistryWithHook(hook);
      const accountId = await seedOutlookAccount(registry);
      hook.mockClear();
      const app = mountApp(registry);
      const res = await app.request(`/mail/accounts/${accountId}`, {
        method: "DELETE",
      });
      expect(res.status).toBe(200);
      expect(hook).toHaveBeenCalledWith("account_removed");
    });

    it("registry onScopeChanged fires on enabled_providers_changed via PATCH /mail/providers", async () => {
      const hook = vi.fn();
      const registry = makeRegistryWithHook(hook);
      await seedOutlookAccount(registry);
      hook.mockClear();
      const app = mountApp(registry);
      const res = await app.request("/mail/providers", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabledKinds: ["gmail"] }),
      });
      expect(res.status).toBe(200);
      expect(hook).toHaveBeenCalledWith("enabled_providers_changed");
    });

    it("registry onScopeChanged is silent on PATCH /mail/providers with unchanged kinds", async () => {
      const hook = vi.fn();
      const registry = makeRegistryWithHook(hook);
      // Prime the registry's lastAnnouncedKinds with the initial set.
      registry.onProviderSelectionChanged(["gmail", "outlook"]);
      hook.mockClear();
      const app = mountApp(registry);
      const res = await app.request("/mail/providers", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabledKinds: ["outlook", "gmail"] }),
      });
      expect(res.status).toBe(200);
      expect(hook).not.toHaveBeenCalled();
    });

    it("GET /:accountId/messages 400s provider_not_enabled detail=account_unhealthy when authStatus is not healthy", async () => {
      const registry = makeRegistry();
      const accountId = await seedOutlookAccount(registry);
      registry.updateAuthStatus(accountId, "requires_consent", "token expired");
      const app = mountApp(registry);
      const res = await app.request(`/mail/${accountId}/messages`);
      expect(res.status).toBe(400);
      const body = (await res.json()) as Record<string, any>;
      expect(body.error).toBe("provider_not_enabled");
      expect(body.detail).toBe("account_unhealthy");
    });

    it("POST /:accountId/messages/:id/read 400s on malformed body", async () => {
      const registry = makeRegistry();
      const accountId = await seedOutlookAccount(registry);
      const app = mountApp(registry);
      const res = await app.request(
        `/mail/${accountId}/messages/m-1/read`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ read: "yes" }),
        },
      );
      expect(res.status).toBe(400);
    });

    it("POST /:accountId/messages/send rejects requests missing required fields", async () => {
      const registry = makeRegistry();
      const accountId = await seedOutlookAccount(registry);
      const app = mountApp(registry);
      const res = await app.request(`/mail/${accountId}/messages/send`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ to: [], subject: "x" }),
      });
      expect(res.status).toBe(400);
    });

    it("POST /:accountId/messages/send no longer honors draftOnly in the body", async () => {
      // With the Phase 5 rework, drafts go through POST /drafts; send ALWAYS
      // sends. The body flag is ignored by the route.
      const registry = makeRegistry();
      const accountId = await seedOutlookAccount(registry);
      // Swap in a provider whose send records the draftOnly it received.
      let receivedDraftOnly: boolean | undefined;
      const spyProvider: MailProvider = {
        kind: "outlook",
        account: registry.getAccount(accountId)!,
        list: async () => [],
        get: async () => { throw new Error("unused"); },
        send: async (input) => {
          receivedDraftOnly = input.draftOnly;
          return { id: "sent-1", isDraft: false };
        },
        modifyTags: async () => undefined,
        markRead: async () => undefined,
        trash: async () => undefined,
        listFolders: async () => [],
        pollSince: async () => ({
          messages: [],
          removedIds: [],
          nextCursor: { kind: "graph" as const },
          drained: true,
        }),
        revoke: async () => undefined,
      };
      // Force registry to hand out the spy by pre-populating the cache via
      // getProvider — actually simpler to bypass and go through the route
      // using the existing factory. So we reassign the registry factory:
      const spyRegistry = new MailAccountRegistry({
        db,
        blobStore,
        getEnabledKinds: () => ["gmail", "outlook"],
        providerFactories: { outlook: () => spyProvider },
      });
      const app = mountApp(spyRegistry);
      const res = await app.request(`/mail/${accountId}/messages/send`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          to: ["a@example.com"],
          subject: "hi",
          textBody: "x",
          draftOnly: true, // agent supplies this — route must ignore.
        }),
      });
      expect(res.status).toBe(200);
      expect(receivedDraftOnly).toBe(false);
    });

    it("501 when a provider doesn't implement an optional method", async () => {
      const registry = makeRegistry();
      const accountId = await seedOutlookAccount(registry);
      const app = mountApp(registry);
      // makeStubProvider doesn't define listTags — but the route has a
      // fallback that returns an empty catalog; expect 200 with empty arrays.
      const tagsRes = await app.request(`/mail/${accountId}/tags`);
      expect(tagsRes.status).toBe(200);
      const tagsBody = (await tagsRes.json()) as Record<string, any>;
      expect(tagsBody).toEqual({ system: [], userDefined: [] });

      // getThread: stub doesn't implement → 501
      const threadRes = await app.request(`/mail/${accountId}/threads/t-1`);
      expect(threadRes.status).toBe(501);
    });

    it("marks agent writes on send so the poller suppresses them", async () => {
      const registry = makeRegistry();
      const accountId = await seedOutlookAccount(registry);
      const marks: string[] = [];
      const writeTracker = {
        markWriting: (key: string) => marks.push(key),
        isMarked: () => false,
      } as unknown as import("../../safety/agent-write-tracker.js").AgentWriteTracker;
      const app = createMailRoutes({
        db,
        config: makeConfig(),
        services: { mail: registry } as unknown as ServiceRegistry,
        blobStore,
        writeTracker,
      });
      const res = await app.request(`/mail/${accountId}/messages/send`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          to: ["a@example.com"],
          subject: "hi",
          textBody: "x",
        }),
      });
      expect(res.status).toBe(200);
      expect(marks).toContain(`mail:${accountId}:stub`);
    });

    // Phase 4 — INTEGRATION-DRIFT-DETECTION-PLAN.md §11. Gmail-account
    // sends mark integration_writes for `(gmail, messageId)` so the
    // next gmail reconcile attributes the message to the agent. Non-
    // Gmail providers must skip the mark entirely.
    it("marks integration_writes for Gmail send (Phase 4)", async () => {
      const registry = makeRegistry();
      const account = await registry.addAccount({
        kind: "gmail",
        email: "owner@gmail.example.com",
        authType: "oauth",
        secretPayload: "stub-google-token",
      });
      const app = mountApp(registry);
      const res = await app.request(`/mail/${account.id}/messages/send`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          to: ["a@example.com"],
          subject: "hi",
          textBody: "x",
        }),
      });
      expect(res.status).toBe(200);
      const row = db
        .prepare(
          "SELECT integration, item_id FROM integration_writes WHERE integration = 'gmail'",
        )
        .get() as { integration: string; item_id: string } | undefined;
      expect(row).toBeDefined();
      expect(row!.integration).toBe("gmail");
    });

    // Phase 5 — Gmail reconcile keys snapshots by threadId. When the
    // provider surfaces threadId from the upstream send response, the
    // route MUST mark both `(gmail, messageId)` AND `(gmail, threadId)`
    // so the next reconcile resolves `actor='agent'` against either key.
    // This guards the mid-TTL mode-flip window: agent sends in direct
    // mode, user flips Gmail to delegated, DelegatedSyncWorker reconciles
    // by threadId — without this the agent self-notices its own send.
    it("marks both messageId and threadId for Gmail send when provider returns threadId", async () => {
      // Build a registry whose Gmail factory returns a provider that
      // surfaces threadId from `send()` (matching real GmailProvider
      // behaviour after the §SendResult.threadId plumbing fix).
      const registry = new MailAccountRegistry({
        db,
        blobStore,
        getEnabledKinds: () => ["gmail"],
        providerFactories: {
          gmail: (account) => ({
            ...makeStubProvider(account),
            send: async () => ({
              id: "msg-Phase5",
              threadId: "thr-Phase5",
              isDraft: false,
            }),
          }),
        },
        now: () => new Date("2026-04-16T12:00:00.000Z"),
      });
      const account = await registry.addAccount({
        kind: "gmail",
        email: "owner@gmail.example.com",
        authType: "oauth",
        secretPayload: "stub-google-token",
      });
      const app = mountApp(registry);
      const res = await app.request(`/mail/${account.id}/messages/send`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          to: ["a@example.com"],
          subject: "hi",
          textBody: "x",
        }),
      });
      expect(res.status).toBe(200);
      const rows = db
        .prepare(
          "SELECT item_id FROM integration_writes WHERE integration = 'gmail' ORDER BY item_id",
        )
        .all() as { item_id: string }[];
      expect(rows.map((r) => r.item_id)).toEqual(["msg-Phase5", "thr-Phase5"]);
    });

    it("does NOT mark integration_writes for non-Gmail send (Outlook)", async () => {
      const registry = makeRegistry();
      const accountId = await seedOutlookAccount(registry);
      const app = mountApp(registry);
      const res = await app.request(`/mail/${accountId}/messages/send`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          to: ["a@example.com"],
          subject: "hi",
          textBody: "x",
        }),
      });
      expect(res.status).toBe(200);
      const count = db
        .prepare("SELECT COUNT(*) AS n FROM integration_writes")
        .get() as { n: number };
      expect(count.n).toBe(0);
    });

    it("POST /:accountId/drafts with reply missing parentProviderMsgId bubbles as 500 (provider-thrown)", async () => {
      // Outlook's createDraft now guards against a reply block that carries
      // only rfc822MsgId + references but no parentProviderMsgId — without
      // the parent id Graph's /createReply can't thread the draft, and
      // silently falling through would orphan it. The route surfaces the
      // provider's error as a 500 with the provider's message visible; the
      // agent must re-fetch the parent via GET /threads/:id and retry.
      const registry = makeRegistry();
      const accountId = await seedOutlookAccount(registry);
      const spyProvider = {
        kind: "outlook" as const,
        account: registry.getAccount(accountId)!,
        list: async () => [],
        get: async () => { throw new Error("unused"); },
        send: async () => ({ id: "x", isDraft: true }),
        modifyTags: async () => undefined,
        markRead: async () => undefined,
        trash: async () => undefined,
        listFolders: async () => [],
        pollSince: async () => ({
          messages: [],
          removedIds: [],
          nextCursor: { kind: "graph" as const },
          drained: true,
        }),
        revoke: async () => undefined,
        createDraft: async (input: {
          reply?: { parentProviderMsgId?: string };
        }) => {
          if (input.reply && !input.reply.parentProviderMsgId) {
            throw new Error(
              "Outlook createDraft(reply): reply.parentProviderMsgId is required",
            );
          }
          return { id: "d-1" };
        },
      } as unknown as MailProvider;
      const spyRegistry = new MailAccountRegistry({
        db,
        blobStore,
        getEnabledKinds: () => ["gmail", "outlook"],
        providerFactories: { outlook: () => spyProvider },
      });
      const app = mountApp(spyRegistry);
      const res = await app.request(`/mail/${accountId}/drafts`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          to: ["a@example.com"],
          subject: "reply-ish",
          textBody: "hi",
          reply: {
            inReplyToRfc822Id: "<parent@example.com>",
            references: ["<parent@example.com>"],
            // parentProviderMsgId deliberately omitted
          },
        }),
      });
      expect(res.status).toBe(500);
      const body = (await res.json()) as Record<string, any>;
      expect(body.message).toContain("parentProviderMsgId");
    });

    it("PATCH /:accountId/drafts/:id forwards provider `warnings` to the caller", async () => {
      const registry = makeRegistry();
      const accountId = await seedOutlookAccount(registry);
      const spyProvider = {
        kind: "outlook" as const,
        account: registry.getAccount(accountId)!,
        list: async () => [],
        get: async () => { throw new Error("unused"); },
        send: async () => ({ id: "x", isDraft: true }),
        modifyTags: async () => undefined,
        markRead: async () => undefined,
        trash: async () => undefined,
        listFolders: async () => [],
        pollSince: async () => ({
          messages: [],
          removedIds: [],
          nextCursor: { kind: "graph" as const },
          drained: true,
        }),
        revoke: async () => undefined,
        updateDraft: async () => ({
          id: "d-1",
          warnings: ["reply_threading_immutable_after_create"],
        }),
      } as unknown as MailProvider;
      const spyRegistry = new MailAccountRegistry({
        db,
        blobStore,
        getEnabledKinds: () => ["gmail", "outlook"],
        providerFactories: { outlook: () => spyProvider },
      });
      const app = mountApp(spyRegistry);
      const res = await app.request(`/mail/${accountId}/drafts/d-1`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          subject: "reshaped",
          reply: {
            inReplyToRfc822Id: "<abc@example.com>",
            references: ["<abc@example.com>"],
          },
        }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, any>;
      expect(body.warnings).toEqual([
        "reply_threading_immutable_after_create",
      ]);
    });

    it("GET /:accountId/threads/:id returns 404 when provider throws MailNotFoundError", async () => {
      const registry = makeRegistry();
      const accountId = await seedOutlookAccount(registry);
      const spyProvider = {
        kind: "outlook" as const,
        account: registry.getAccount(accountId)!,
        list: async () => [],
        get: async () => { throw new Error("unused"); },
        send: async () => ({ id: "x", isDraft: true }),
        modifyTags: async () => undefined,
        markRead: async () => undefined,
        trash: async () => undefined,
        listFolders: async () => [],
        pollSince: async () => ({
          messages: [],
          removedIds: [],
          nextCursor: { kind: "graph" as const },
          drained: true,
        }),
        revoke: async () => undefined,
        getThread: async () => {
          const { MailNotFoundError } = await import(
            "../../services/mail/provider.js"
          );
          throw new MailNotFoundError("outlook", "thread", "missing-id");
        },
      } as unknown as MailProvider;
      const spyRegistry = new MailAccountRegistry({
        db,
        blobStore,
        getEnabledKinds: () => ["gmail", "outlook"],
        providerFactories: { outlook: () => spyProvider },
      });
      const app = mountApp(spyRegistry);
      const res = await app.request(
        `/mail/${accountId}/threads/missing-id`,
      );
      expect(res.status).toBe(404);
      const body = (await res.json()) as Record<string, any>;
      expect(body.error).toBe("not_found");
    });

    it("maps MailOperationNotSupportedError (httpStatus=501) to 501 not_implemented", async () => {
      const registry = makeRegistry();
      const accountId = await seedOutlookAccount(registry);
      // Swap in a provider whose createDraft throws the structural-
      // unsupported error (matches IMAP draft-write behavior in Phase 5).
      const spyProvider = {
        kind: "outlook" as const,
        account: registry.getAccount(accountId)!,
        list: async () => [],
        get: async () => { throw new Error("unused"); },
        send: async () => ({ id: "x", isDraft: true }),
        modifyTags: async () => undefined,
        markRead: async () => undefined,
        trash: async () => undefined,
        listFolders: async () => [],
        pollSince: async () => ({
          messages: [],
          removedIds: [],
          nextCursor: { kind: "graph" as const },
          drained: true,
        }),
        revoke: async () => undefined,
        createDraft: async () => {
          const { MailOperationNotSupportedError } = await import(
            "../../services/mail/provider.js"
          );
          throw new MailOperationNotSupportedError(
            "outlook",
            "createDraft",
            "Simulated unsupported sub-case",
          );
        },
      } as unknown as MailProvider;
      const spyRegistry = new MailAccountRegistry({
        db,
        blobStore,
        getEnabledKinds: () => ["gmail", "outlook"],
        providerFactories: { outlook: () => spyProvider },
      });
      const app = mountApp(spyRegistry);
      const res = await app.request(`/mail/${accountId}/drafts`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ to: ["a@example.com"], subject: "hi" }),
      });
      expect(res.status).toBe(501);
      const body = (await res.json()) as Record<string, any>;
      expect(body.error).toBe("not_implemented");
    });

    it("POST /mail/accounts with kind=gmail returns 501 not_implemented", async () => {
      const registry = makeRegistry();
      const app = mountApp(registry, {
        enabledMailProviders: ["gmail", "outlook"] as const,
      });
      const res = await app.request("/mail/accounts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "gmail" }),
      });
      expect(res.status).toBe(501);
      const body = (await res.json()) as Record<string, any>;
      expect(body.error).toBe("not_implemented");
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // §4.8 per-account delegated gate. The route-gate middleware cannot
  // blanket-410 `/api/mail/*` because it would also block iCloud/Outlook,
  // so the mail route enforces the gate per-account.
  //
  // Per DELEGATED-MODE-V2-DESIGN.md, the v1 `tryGmailProxy` route-fall-
  // through is gone — direct-mode mail routes never invoke a daemon-side
  // proxy. When Gmail is delegated, every `/mail/:accountId/*` Gmail call
  // returns `410 integration_delegated`; the agent re-reads
  // `integrations.md` and either calls `POST /api/integrations/gmail/exec`
  // (cross-backend; task-mode chokepoint after the 2026-05-01 retirement
  // of the legacy /invoke RPC) or its session backend's native Gmail MCP
  // (same-backend). Tests below pin the 410 behavior on `/health` and
  // `/mail/search`; non-Gmail accounts (iCloud / Outlook) pass through.
  // ──────────────────────────────────────────────────────────────────────────
  describe("delegated-mode per-account gate (§4.8)", () => {
    async function seedGmailAccount(
      registry: MailAccountRegistry,
    ): Promise<string> {
      const account = await registry.addAccount({
        kind: "gmail",
        email: "owner@example.com",
        authType: "oauth",
        secretPayload: "stub-gmail-oauth",
      });
      return account.id;
    }

    async function seedOutlookAccount(
      registry: MailAccountRegistry,
    ): Promise<string> {
      const account = await registry.addAccount({
        kind: "outlook",
        email: "owner@outlook.example.com",
        authType: "oauth",
        secretPayload: "stub-msal-cache",
      });
      return account.id;
    }

    function setGmailMode(mode: "direct" | "delegated" | "disabled"): void {
      // Hand-write the settings row so the test stays independent of the
      // integrations-store module under test elsewhere.
      const payload =
        mode === "delegated"
          ? {
              gmail: {
                mode,
                delegatedBackend: "claude",
                deniedTools: [],
                lastChangedAt: "2026-04-19T00:00:00Z",
              },
              google_calendar: {
                mode: "direct",
                deniedTools: [],
                lastChangedAt: "2026-04-19T00:00:00Z",
              },
            }
          : {
              gmail: { mode, lastChangedAt: "2026-04-19T00:00:00Z" },
              google_calendar: {
                mode: "direct",
                deniedTools: [],
                lastChangedAt: "2026-04-19T00:00:00Z",
              },
            };
      db.prepare(
        `INSERT INTO settings (key, value_json, updated_at)
         VALUES ('integrations', ?, CURRENT_TIMESTAMP)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json,
                                        updated_at = CURRENT_TIMESTAMP`,
      ).run(JSON.stringify(payload));
    }

    function expectGmailDelegationMessage(body: Record<string, any>): void {
      expect(typeof body.message).toBe("string");
      expect(body.message).toContain("delegated to claude");
      expect(body.message).toContain("/api/integrations/gmail/exec");
      expect(body.message).toContain("native Gmail MCP tools");
      expect(body.message).toContain("Non-Gmail mail accounts remain available");
      expect(body.message).not.toMatch(/use your backend's [\w ]*tool/i);
    }

    it("GET /mail/:accountId/messages passes through for a Gmail account when gmail is direct", async () => {
      const registry = makeRegistry();
      const accountId = await seedGmailAccount(registry);
      setGmailMode("direct");
      const app = mountApp(registry);
      const res = await app.request(`/mail/${accountId}/messages`);
      expect(res.status).toBe(200);
    });

    it("GET /mail/:accountId/messages returns 410 with invoke guidance for a Gmail account when delegated", async () => {
      const registry = makeRegistry();
      const accountId = await seedGmailAccount(registry);
      setGmailMode("delegated");
      const app = mountApp(registry);
      const res = await app.request(`/mail/${accountId}/messages`);
      expect(res.status).toBe(410);
      const body = (await res.json()) as Record<string, any>;
      expect(body).toMatchObject({
        error: "integration_delegated",
        integration: "gmail",
        backend: "claude",
        mode: "delegated",
      });
      expectGmailDelegationMessage(body);
    });

    it("GET /mail/:accountId/messages passes through for a non-Gmail account even when gmail is delegated", async () => {
      // Invariant from §4.8: non-Google mail providers remain unaffected.
      const registry = makeRegistry();
      const accountId = await seedOutlookAccount(registry);
      setGmailMode("delegated");
      const app = mountApp(registry);
      const res = await app.request(`/mail/${accountId}/messages`);
      expect(res.status).toBe(200);
    });

    it("GET /mail/:accountId/health returns 410 for a Gmail account when delegated", async () => {
      // `/health` bypasses `resolveProvider` — it has its own inline gate.
      const registry = makeRegistry();
      const accountId = await seedGmailAccount(registry);
      setGmailMode("delegated");
      const app = mountApp(registry);
      const res = await app.request(`/mail/${accountId}/health`);
      expect(res.status).toBe(410);
      const body = (await res.json()) as Record<string, any>;
      expect(body).toMatchObject({
        error: "integration_delegated",
        integration: "gmail",
      });
      expectGmailDelegationMessage(body);
    });

    it("GET /mail/:accountId/health still 404s for an unknown accountId when delegated", async () => {
      setGmailMode("delegated");
      const app = mountApp(makeRegistry());
      const res = await app.request("/mail/does-not-exist/health");
      expect(res.status).toBe(404);
    });

    it("GET /mail/search?accountId=<gmail> returns 410 when delegated (before touching FTS)", async () => {
      // The gate fires before `searchMail` is called, so this test works
      // without seeding the FTS5 virtual table — the 410 short-circuits
      // the handler. The non-Gmail passthrough and the unscoped search
      // cases exercise `searchMail` directly and are covered in
      // `mail-search.test.ts` where the full FTS schema is materialized.
      const registry = makeRegistry();
      const accountId = await seedGmailAccount(registry);
      setGmailMode("delegated");
      const app = mountApp(registry);
      const res = await app.request(
        `/mail/search?q=hello&accountId=${accountId}`,
      );
      expect(res.status).toBe(410);
      const body = (await res.json()) as Record<string, any>;
      expect(body).toMatchObject({
        error: "integration_delegated",
        integration: "gmail",
      });
      expectGmailDelegationMessage(body);
    });
  });

  // ── INTEGRATION_NATIVE_MODE_DESIGN.md §9.2 — per-account native gate ──────
  //
  // Mirrors the delegated-mode gate above. `/api/mail/*` is multi-provider
  // so the centralised route-gate middleware cannot blanket-410 it; the
  // per-account branch inside the handler is what 410s Gmail / Outlook
  // accounts when their integration is in `native` mode. `disabled` is
  // intentionally NOT gated here — see `gatedMailIntegrationResponse`
  // doc-comment in mail.ts.
  describe("native-mode per-account gate (§9.2)", () => {
    async function seedGmailAccount(
      registry: MailAccountRegistry,
    ): Promise<string> {
      const account = await registry.addAccount({
        kind: "gmail",
        email: "owner@example.com",
        authType: "oauth",
        secretPayload: "stub-gmail-oauth",
      });
      return account.id;
    }

    async function seedOutlookAccount(
      registry: MailAccountRegistry,
    ): Promise<string> {
      const account = await registry.addAccount({
        kind: "outlook",
        email: "owner@outlook.example.com",
        authType: "oauth",
        secretPayload: "stub-msal-cache",
      });
      return account.id;
    }

    function setNativeMode(
      key: "gmail" | "outlook_mail",
      nativeBackend: string,
    ): void {
      const payload = {
        [key]: {
          mode: "native",
          nativeBackend,
          deniedTools: [],
          lastChangedAt: "2026-05-11T00:00:00Z",
        },
      };
      db.prepare(
        `INSERT INTO settings (key, value_json, updated_at)
         VALUES ('integrations', ?, CURRENT_TIMESTAMP)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json,
                                        updated_at = CURRENT_TIMESTAMP`,
      ).run(JSON.stringify(payload));
    }

    it("returns 410 integration_native for a Gmail account when gmail is native", async () => {
      const registry = makeRegistry();
      const accountId = await seedGmailAccount(registry);
      setNativeMode("gmail", "claude");
      const app = mountApp(registry);
      const res = await app.request(`/mail/${accountId}/messages`);
      expect(res.status).toBe(410);
      const body = (await res.json()) as Record<string, any>;
      expect(body).toMatchObject({
        error: "integration_native",
        integration: "gmail",
        backend: "claude",
        mode: "native",
      });
      // Descriptor-driven message points at the SKILL.native.<backend>.md
      // body, not the user-installed MCP language.
      expect(body.message).toContain("native MCP tools");
      expect(body.message).toContain("SKILL.native.claude.md");
    });

    it("returns 410 integration_native with user-managed copy for Outlook when outlook_mail is native", async () => {
      // User-managed (`userManagedConnector: true`) — the message must
      // direct the agent at the user-installed Outlook MCP, NOT at a
      // SKILL.native.<backend>.md body the daemon does not ship.
      const registry = makeRegistry();
      const accountId = await seedOutlookAccount(registry);
      setNativeMode("outlook_mail", "claude");
      const app = mountApp(registry);
      const res = await app.request(`/mail/${accountId}/messages`);
      expect(res.status).toBe(410);
      const body = (await res.json()) as Record<string, any>;
      expect(body).toMatchObject({
        error: "integration_native",
        integration: "outlook_mail",
        backend: "claude",
        mode: "native",
      });
      expect(body.message).toContain("user-installed Outlook Mail MCP");
      expect(body.message).not.toContain("SKILL.native");
    });

    it("/health 410s when gmail is native", async () => {
      const registry = makeRegistry();
      const accountId = await seedGmailAccount(registry);
      setNativeMode("gmail", "claude");
      const app = mountApp(registry);
      const res = await app.request(`/mail/${accountId}/health`);
      expect(res.status).toBe(410);
      const body = (await res.json()) as Record<string, any>;
      expect(body).toMatchObject({
        error: "integration_native",
        integration: "gmail",
        mode: "native",
      });
    });

    it("passes through for an Outlook account when only gmail is native", async () => {
      // Invariant: native gate is per-kind. An Outlook account stays
      // reachable when only `gmail` is native and `outlook_mail` is
      // direct/disabled — the gate only fires for the account whose
      // own integration is gated.
      const registry = makeRegistry();
      const accountId = await seedOutlookAccount(registry);
      setNativeMode("gmail", "claude");
      const app = mountApp(registry);
      const res = await app.request(`/mail/${accountId}/messages`);
      expect(res.status).toBe(200);
    });
  });

});
