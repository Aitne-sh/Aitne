import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import type { EncryptedBlobStore } from "../../secrets/encrypted-blob-store.js";
import type { BlobName } from "../../secrets/types.js";
import {
  MailAccountRegistry,
  ProviderNotEnabledError,
  ProviderNotImplementedError,
  DuplicateAccountError,
  passesScopeGate,
  parseMailAccountRow,
  parseMailAccountHealth,
} from "./account-registry.js";
import type {
  MailAccount,
  MailProvider,
  MailProviderKind,
} from "./provider.js";

function makeStubProvider(
  account: MailAccount,
  overrides: Partial<MailProvider> = {},
): MailProvider {
  const base: MailProvider = {
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
      nextCursor: { kind: "graph" },
      drained: true,
    }),
    revoke: async () => undefined,
  };
  return { ...base, ...overrides };
}

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
  `);
}

function insertRow(
  db: Database.Database,
  overrides: Partial<{
    id: string;
    kind: MailProviderKind;
    email: string;
    label: string | null;
    authType: "oauth" | "app_password";
    authStatus: "healthy" | "requires_consent" | "degraded";
    secretBlobName: string;
    pollIntervalSeconds: number;
    idleEnabled: number;
    idleFallbackUntil: string | null;
    unifiedPoll: number;
    active: number;
    createdAtUtc: string;
    lastError: string | null;
    lastErrorAtUtc: string | null;
    lastPollAtUtc: string | null;
    consecutiveErrorCount: number;
  }> = {},
): void {
  const row = {
    id: "gmail-default",
    kind: "gmail" as MailProviderKind,
    email: "owner@example.com",
    label: null,
    authType: "oauth" as const,
    authStatus: "healthy" as const,
    secretBlobName: "mail:gmail:gmail-default",
    pollIntervalSeconds: 300,
    idleEnabled: 0,
    idleFallbackUntil: null,
    unifiedPoll: 1,
    active: 1,
    createdAtUtc: "2026-04-16T00:00:00.000Z",
    lastError: null,
    lastErrorAtUtc: null,
    lastPollAtUtc: null,
    consecutiveErrorCount: 0,
    ...overrides,
  };
  db.prepare(
    `INSERT INTO mail_accounts (
       id, kind, email, label, auth_type, auth_status,
       secret_blob_name, poll_interval_seconds, idle_enabled,
       idle_fallback_until, unified_poll, active, created_at_utc,
       last_error, last_error_at_utc, last_poll_at_utc, consecutive_error_count
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    row.kind,
    row.email,
    row.label,
    row.authType,
    row.authStatus,
    row.secretBlobName,
    row.pollIntervalSeconds,
    row.idleEnabled,
    row.idleFallbackUntil,
    row.unifiedPoll,
    row.active,
    row.createdAtUtc,
    row.lastError,
    row.lastErrorAtUtc,
    row.lastPollAtUtc,
    row.consecutiveErrorCount,
  );
}

describe("passesScopeGate", () => {
  const healthyGmail = {
    kind: "gmail" as MailProviderKind,
    active: true,
    authStatus: "healthy" as const,
    unifiedPoll: true,
  };

  it("passes when all four conditions are met", () => {
    expect(passesScopeGate(healthyGmail, ["gmail"])).toBe(true);
    expect(passesScopeGate(healthyGmail, ["gmail", "outlook"])).toBe(true);
  });

  it("fails when kind is not in enabled list", () => {
    expect(passesScopeGate(healthyGmail, ["outlook"])).toBe(false);
    expect(passesScopeGate(healthyGmail, [])).toBe(false);
  });

  it("fails when account is inactive", () => {
    expect(
      passesScopeGate({ ...healthyGmail, active: false }, ["gmail"]),
    ).toBe(false);
  });

  it("fails when authStatus is not healthy", () => {
    expect(
      passesScopeGate({ ...healthyGmail, authStatus: "requires_consent" }, ["gmail"]),
    ).toBe(false);
    expect(
      passesScopeGate({ ...healthyGmail, authStatus: "degraded" }, ["gmail"]),
    ).toBe(false);
  });

  it("fails when unifiedPoll is false (legacy row)", () => {
    expect(
      passesScopeGate({ ...healthyGmail, unifiedPoll: false }, ["gmail"]),
    ).toBe(false);
  });
});

describe("parseMailAccountRow", () => {
  it("maps row columns to MailAccount", () => {
    const account = parseMailAccountRow({
      id: "gmail-abc",
      kind: "gmail",
      email: "owner@example.com",
      label: "work",
      auth_type: "oauth",
      auth_status: "healthy",
      secret_blob_name: "mail:gmail:gmail-abc",
      poll_interval_seconds: 300,
      idle_enabled: 0,
      idle_fallback_until: null,
      unified_poll: 1,
      active: 1,
      created_at_utc: "2026-04-16T00:00:00.000Z",
      last_error: null,
      last_error_at_utc: null,
      last_poll_at_utc: null,
      consecutive_error_count: 0,
      imap_capabilities_json: null,
    });
    expect(account).toEqual({
      id: "gmail-abc",
      kind: "gmail",
      email: "owner@example.com",
      label: "work",
      authStatus: "healthy",
      idleEnabled: false,
      active: true,
      createdAt: "2026-04-16T00:00:00.000Z",
    });
  });

  it("drops missing label to undefined", () => {
    const account = parseMailAccountRow({
      id: "gmail-abc",
      kind: "gmail",
      email: "owner@example.com",
      label: null,
      auth_type: "oauth",
      auth_status: "healthy",
      secret_blob_name: "x",
      poll_interval_seconds: 300,
      idle_enabled: 1,
      idle_fallback_until: null,
      unified_poll: 0,
      active: 0,
      created_at_utc: "2026-04-16T00:00:00.000Z",
      last_error: null,
      last_error_at_utc: null,
      last_poll_at_utc: null,
      consecutive_error_count: 0,
      imap_capabilities_json: null,
    });
    expect(account.label).toBeUndefined();
    expect(account.idleEnabled).toBe(true);
    expect(account.active).toBe(false);
  });

  it("rejects invalid kind", () => {
    expect(() =>
      parseMailAccountRow({
        id: "x",
        kind: "hotmail",
        email: "owner@example.com",
        label: null,
        auth_type: "oauth",
        auth_status: "healthy",
        secret_blob_name: "x",
        poll_interval_seconds: 300,
        idle_enabled: 0,
        idle_fallback_until: null,
        unified_poll: 1,
        active: 1,
        created_at_utc: "2026-04-16T00:00:00.000Z",
        last_error: null,
        last_error_at_utc: null,
        last_poll_at_utc: null,
        consecutive_error_count: 0,
        imap_capabilities_json: null,
      }),
    ).toThrow(/Invalid mail_accounts.kind/);
  });

  it("rejects invalid auth_status", () => {
    expect(() =>
      parseMailAccountRow({
        id: "x",
        kind: "gmail",
        email: "owner@example.com",
        label: null,
        auth_type: "oauth",
        auth_status: "broken",
        secret_blob_name: "x",
        poll_interval_seconds: 300,
        idle_enabled: 0,
        idle_fallback_until: null,
        unified_poll: 1,
        active: 1,
        created_at_utc: "2026-04-16T00:00:00.000Z",
        last_error: null,
        last_error_at_utc: null,
        last_poll_at_utc: null,
        consecutive_error_count: 0,
        imap_capabilities_json: null,
      }),
    ).toThrow(/Invalid mail_accounts.auth_status/);
  });
});

describe("parseMailAccountHealth", () => {
  it("maps health columns", () => {
    const health = parseMailAccountHealth({
      id: "gmail-abc",
      kind: "gmail",
      email: "o@e.com",
      label: null,
      auth_type: "oauth",
      auth_status: "degraded",
      secret_blob_name: "x",
      poll_interval_seconds: 300,
      idle_enabled: 0,
      idle_fallback_until: "2026-04-16T01:00:00.000Z",
      unified_poll: 1,
      active: 1,
      created_at_utc: "2026-04-16T00:00:00.000Z",
      last_error: "boom",
      last_error_at_utc: "2026-04-16T00:30:00.000Z",
      last_poll_at_utc: "2026-04-16T00:29:00.000Z",
      consecutive_error_count: 4,
      imap_capabilities_json: null,
    });
    expect(health).toEqual({
      accountId: "gmail-abc",
      lastPollAtUtc: "2026-04-16T00:29:00.000Z",
      lastError: "boom",
      lastErrorAtUtc: "2026-04-16T00:30:00.000Z",
      consecutiveErrorCount: 4,
      idleFallbackUntilUtc: "2026-04-16T01:00:00.000Z",
    });
  });
});

describe("MailAccountRegistry", () => {
  let db: Database.Database;
  let blobStore: MemoryBlobStore;
  let enabled: MailProviderKind[];

  beforeEach(() => {
    db = new Database(":memory:");
    createMailSchema(db);
    blobStore = new MemoryBlobStore();
    enabled = ["gmail"];
  });

  afterEach(() => {
    db.close();
  });

  function makeRegistry(): MailAccountRegistry {
    return new MailAccountRegistry({
      db,
      blobStore,
      getEnabledKinds: () => enabled,
      now: () => new Date("2026-04-16T12:00:00.000Z"),
      providerFactories: {
        gmail: (account) => makeStubProvider(account),
      },
    });
  }

  it("listAccounts returns every row", () => {
    insertRow(db, { id: "gmail-a" });
    insertRow(db, {
      id: "outlook-a",
      kind: "outlook",
      email: "work@example.com",
      unifiedPoll: 1,
    });
    const accounts = makeRegistry().listAccounts();
    expect(accounts.map((a) => a.id).sort()).toEqual(["gmail-a", "outlook-a"]);
  });

  it("listActiveAccounts applies the scope gate", () => {
    insertRow(db, { id: "gmail-ok" });
    insertRow(db, {
      id: "gmail-inactive",
      email: "second@example.com",
      active: 0,
    });
    insertRow(db, {
      id: "gmail-unhealthy",
      email: "third@example.com",
      authStatus: "requires_consent",
    });
    insertRow(db, {
      id: "gmail-legacy",
      email: "fourth@example.com",
      unifiedPoll: 0,
    });
    insertRow(db, {
      id: "outlook-disabled",
      kind: "outlook",
      email: "o@example.com",
    });
    const active = makeRegistry().listActiveAccounts();
    expect(active.map((a) => a.id)).toEqual(["gmail-ok"]);
  });

  it("getAccount returns null when missing", () => {
    expect(makeRegistry().getAccount("nope")).toBeNull();
  });

  it("getAccount returns the row", () => {
    insertRow(db, { id: "gmail-ok" });
    expect(makeRegistry().getAccount("gmail-ok")?.id).toBe("gmail-ok");
  });

  it("getHealth returns null when missing and row fields when present", () => {
    const reg = makeRegistry();
    expect(reg.getHealth("nope")).toBeNull();
    insertRow(db, { id: "gmail-ok", consecutiveErrorCount: 2 });
    expect(reg.getHealth("gmail-ok")?.consecutiveErrorCount).toBe(2);
  });

  it("addAccount permits kind outside enabledMailProviders (auth-then-enable flow)", async () => {
    // Per UI v2 (auth-then-enable): registration is allowed regardless of
    // `enabledMailProviders`. The `passesScopeGate` filter keeps the dormant
    // account out of the unified poller until the user toggles the kind on.
    enabled = ["gmail"]; // outlook is NOT in enabled
    const reg = new MailAccountRegistry({
      db,
      blobStore,
      getEnabledKinds: () => enabled,
      now: () => new Date("2026-04-16T12:00:00.000Z"),
      providerFactories: {
        outlook: (account) => makeStubProvider(account),
      },
    });
    const account = await reg.addAccount({
      kind: "outlook",
      email: "o@example.com",
      authType: "oauth",
      secretPayload: "{}",
    });
    expect(account.kind).toBe("outlook");
    expect(account.active).toBe(true);
    // Scope gate must keep the dormant outlook account out of the poller.
    expect(reg.listActiveAccounts().map((a) => a.id)).not.toContain(account.id);
  });

  it("addAccount rejects non-Gmail kinds even when enabled in Phase 1", async () => {
    enabled = ["gmail", "outlook"];
    await expect(
      makeRegistry().addAccount({
        kind: "outlook",
        email: "o@example.com",
        authType: "oauth",
        secretPayload: "{}",
      }),
    ).rejects.toBeInstanceOf(ProviderNotImplementedError);
  });

  it("addAccount writes a row + blob for gmail", async () => {
    const reg = makeRegistry();
    const account = await reg.addAccount({
      kind: "gmail",
      email: "owner@example.com",
      label: "personal",
      authType: "oauth",
      secretPayload: '{"refresh_token":"x"}',
      idleEnabled: false,
      pollIntervalSeconds: 600,
    });
    expect(account.kind).toBe("gmail");
    expect(account.email).toBe("owner@example.com");
    expect(blobStore.blobs.size).toBe(1);
    const [blobName] = [...blobStore.blobs.keys()];
    expect(blobName).toMatch(/^mail:gmail:gmail-[0-9a-f]{12}$/);
    expect(blobStore.blobs.get(blobName)).toBe('{"refresh_token":"x"}');
  });

  it("addAccount rejects duplicate (kind, email) with DuplicateAccountError and rolls back", async () => {
    insertRow(db, { id: "gmail-dup", email: "dupe@example.com" });
    const reg = makeRegistry();
    await expect(
      reg.addAccount({
        kind: "gmail",
        email: "dupe@example.com",
        authType: "oauth",
        secretPayload: "{}",
      }),
    ).rejects.toBeInstanceOf(DuplicateAccountError);
    expect(blobStore.blobs.size).toBe(0);
  });

  it("DuplicateAccountError carries a stable code and names the offending kind", () => {
    const err = new DuplicateAccountError("outlook", "a@b.com");
    expect(err.code).toBe("duplicate_account");
    expect(err.name).toBe("DuplicateAccountError");
    expect(err.message).toMatch(/outlook:a@b\.com/);
  });

  it("addAccount persists multiple gmail rows independently (no primary coupling)", async () => {
    const reg = makeRegistry();
    const first = await reg.addAccount({
      kind: "gmail",
      email: "first@example.com",
      authType: "oauth",
      secretPayload: "x",
    });
    const second = await reg.addAccount({
      kind: "gmail",
      email: "second@example.com",
      authType: "oauth",
      secretPayload: "x",
    });
    expect(first.id).not.toBe(second.id);
    expect(reg.getAccount(first.id)).not.toBeNull();
    expect(reg.getAccount(second.id)).not.toBeNull();
    // No isPrimary on the interface — adding a second account does not
    // mutate the first.
    expect(reg.listAccounts()).toHaveLength(2);
  });

  it("addAccount defaults unifiedPoll=1 but respects explicit false", async () => {
    const reg = makeRegistry();
    const legacy = await reg.addAccount({
      kind: "gmail",
      email: "legacy@example.com",
      authType: "oauth",
      secretPayload: "{}",
      unifiedPoll: false,
    });
    const unified = await reg.addAccount({
      kind: "gmail",
      email: "unified@example.com",
      authType: "oauth",
      secretPayload: "{}",
    });
    enabled = ["gmail"];
    const active = reg.listActiveAccounts().map((a) => a.id).sort();
    expect(active).toEqual([unified.id]);
    expect(legacy.id).not.toEqual(unified.id);
  });

  it("removeAccount deletes DB row + blob, returns true", async () => {
    const reg = makeRegistry();
    const account = await reg.addAccount({
      kind: "gmail",
      email: "owner@example.com",
      authType: "oauth",
      secretPayload: "payload",
    });
    expect(blobStore.blobs.size).toBe(1);
    await expect(reg.removeAccount(account.id)).resolves.toBe(true);
    expect(reg.getAccount(account.id)).toBeNull();
    expect(blobStore.blobs.size).toBe(0);
  });

  it("removeAccount returns false for unknown id", async () => {
    await expect(makeRegistry().removeAccount("ghost")).resolves.toBe(false);
  });

  it("setActive toggles the active flag and returns the updated row", async () => {
    const reg = makeRegistry();
    const account = await reg.addAccount({
      kind: "gmail",
      email: "owner@example.com",
      authType: "oauth",
      secretPayload: "x",
    });
    expect(account.active).toBe(true);

    const disabled = await reg.setActive(account.id, false);
    expect(disabled?.active).toBe(false);

    const enabled = await reg.setActive(account.id, true);
    expect(enabled?.active).toBe(true);
  });

  it("setActive returns null for unknown id", async () => {
    await expect(makeRegistry().setActive("ghost", true)).resolves.toBeNull();
  });

  it("setActive changes scope-gate eligibility", async () => {
    const reg = makeRegistry();
    const account = await reg.addAccount({
      kind: "gmail",
      email: "owner@example.com",
      authType: "oauth",
      secretPayload: "x",
    });
    expect(reg.listActiveAccounts().map((a) => a.id)).toEqual([account.id]);

    await reg.setActive(account.id, false);
    expect(reg.listActiveAccounts()).toEqual([]);
  });

  it("refreshImapSecret overwrites the blob, resets auth_status, evicts cached provider", async () => {
    enabled = ["yahoo"];
    let buildCount = 0;
    const reg = new MailAccountRegistry({
      db,
      blobStore,
      getEnabledKinds: () => enabled,
      now: () => new Date("2026-04-16T12:00:00.000Z"),
      providerFactories: {
        yahoo: (account) => {
          buildCount++;
          return makeStubProvider(account);
        },
      },
    });
    const account = await reg.addAccount({
      kind: "yahoo",
      email: "owner@yahoo.com",
      authType: "app_password",
      secretPayload: '{"appPassword":"old","email":"owner@yahoo.com","kind":"yahoo"}',
      idleEnabled: true,
    });
    // Force a provider build, then put the account into requires_consent so
    // the refresh path's healthy-reset is observable.
    await reg.getProvider(account.id);
    expect(buildCount).toBe(1);
    reg.updateAuthStatus(account.id, "requires_consent", "rotated");
    expect(reg.getAccount(account.id)?.authStatus).toBe("requires_consent");

    const refreshed = await reg.refreshImapSecret(
      account.id,
      '{"appPassword":"new","email":"owner@yahoo.com","kind":"yahoo"}',
    );
    expect(refreshed?.authStatus).toBe("healthy");
    expect(reg.getAccount(account.id)?.authStatus).toBe("healthy");
    // Blob was overwritten in place — same name, new payload.
    expect(blobStore.blobs.size).toBe(1);
    const [name] = [...blobStore.blobs.keys()];
    expect(blobStore.blobs.get(name)).toContain("new");
    // Cached provider is evicted; the next getProvider call rebuilds.
    await reg.getProvider(account.id);
    expect(buildCount).toBe(2);
  });

  it("refreshImapSecret returns null for unknown account id", async () => {
    await expect(
      makeRegistry().refreshImapSecret("ghost", "{}"),
    ).resolves.toBeNull();
  });

  it("refreshImapSecret rejects oauth accounts", async () => {
    const reg = makeRegistry();
    const account = await reg.addAccount({
      kind: "gmail",
      email: "owner@example.com",
      authType: "oauth",
      secretPayload: "x",
    });
    await expect(
      reg.refreshImapSecret(account.id, "{}"),
    ).rejects.toThrow(/app_password/);
  });

  it("removeAccount serializes concurrent removes of the same id", async () => {
    const reg = makeRegistry();
    const account = await reg.addAccount({
      kind: "gmail",
      email: "owner@example.com",
      authType: "oauth",
      secretPayload: "x",
    });
    const [first, second] = await Promise.all([
      reg.removeAccount(account.id),
      reg.removeAccount(account.id),
    ]);
    expect([first, second].sort()).toEqual([false, true]);
  });

  it("onProviderSelectionChanged is a no-op in Phase 1", () => {
    const reg = makeRegistry();
    expect(() => reg.onProviderSelectionChanged(["outlook"])).not.toThrow();
  });

  it("ProviderNotEnabledError carries a stable code", () => {
    const err = new ProviderNotEnabledError("outlook");
    expect(err.code).toBe("provider_not_enabled");
    expect(err.name).toBe("ProviderNotEnabledError");
    expect(err.message).toMatch(/outlook/);
  });

  it("ProviderNotImplementedError carries a stable code", () => {
    const err = new ProviderNotImplementedError("yahoo");
    expect(err.code).toBe("provider_not_implemented");
    expect(err.name).toBe("ProviderNotImplementedError");
    expect(err.message).toMatch(/yahoo/);
  });

  it("addAccount allows outlook when a provider factory is registered", async () => {
    enabled = ["gmail", "outlook"];
    const built: string[] = [];
    const reg = new MailAccountRegistry({
      db,
      blobStore,
      getEnabledKinds: () => enabled,
      now: () => new Date("2026-04-16T12:00:00.000Z"),
      providerFactories: {
        outlook: (account) => {
          built.push(account.id);
          return makeStubProvider(account);
        },
      },
    });
    const account = await reg.addAccount({
      kind: "outlook",
      email: "o@example.com",
      authType: "oauth",
      secretPayload: "{}",
    });
    expect(account.kind).toBe("outlook");
    expect(built).toEqual([]); // factory only fires on getProvider, not addAccount
  });

  it("getProvider lazily instantiates and caches the provider", async () => {
    enabled = ["gmail", "outlook"];
    let buildCount = 0;
    const reg = new MailAccountRegistry({
      db,
      blobStore,
      getEnabledKinds: () => enabled,
      now: () => new Date("2026-04-16T12:00:00.000Z"),
      providerFactories: {
        outlook: (account) => {
          buildCount++;
          return makeStubProvider(account);
        },
      },
    });
    const account = await reg.addAccount({
      kind: "outlook",
      email: "o@example.com",
      authType: "oauth",
      secretPayload: "{}",
    });
    const a = await reg.getProvider(account.id);
    const b = await reg.getProvider(account.id);
    expect(a).not.toBeNull();
    expect(a).toBe(b);
    expect(buildCount).toBe(1);
  });

  it("getProvider returns null for unknown account", async () => {
    const reg = makeRegistry();
    expect(await reg.getProvider("ghost")).toBeNull();
  });

  it("getProvider builds gmail providers through the registered factory", async () => {
    const reg = makeRegistry();
    const account = await reg.addAccount({
      kind: "gmail",
      email: "owner@example.com",
      authType: "oauth",
      secretPayload: "{}",
    });
    const provider = await reg.getProvider(account.id);
    expect(provider).not.toBeNull();
    expect(provider?.kind).toBe("gmail");
  });

  it("getProvider throws ProviderNotImplementedError when factory missing", async () => {
    insertRow(db, { id: "outlook-x", kind: "outlook", email: "x@example.com" });
    const reg = makeRegistry();
    await expect(reg.getProvider("outlook-x")).rejects.toBeInstanceOf(
      ProviderNotImplementedError,
    );
  });

  it("removeAccount evicts the cached provider and calls revoke()", async () => {
    enabled = ["gmail", "outlook"];
    let revoked = 0;
    const reg = new MailAccountRegistry({
      db,
      blobStore,
      getEnabledKinds: () => enabled,
      now: () => new Date("2026-04-16T12:00:00.000Z"),
      providerFactories: {
        outlook: (account) =>
          makeStubProvider(account, {
            revoke: async () => {
              revoked++;
            },
          }),
      },
    });
    const account = await reg.addAccount({
      kind: "outlook",
      email: "o@example.com",
      authType: "oauth",
      secretPayload: "{}",
    });
    await reg.getProvider(account.id);
    await reg.removeAccount(account.id);
    expect(revoked).toBe(1);
  });

  it("removeAccount swallows revoke() errors so deletion still completes", async () => {
    enabled = ["gmail", "outlook"];
    const reg = new MailAccountRegistry({
      db,
      blobStore,
      getEnabledKinds: () => enabled,
      now: () => new Date("2026-04-16T12:00:00.000Z"),
      providerFactories: {
        outlook: (account) =>
          makeStubProvider(account, {
            revoke: async () => {
              throw new Error("network down");
            },
          }),
      },
    });
    const account = await reg.addAccount({
      kind: "outlook",
      email: "o@example.com",
      authType: "oauth",
      secretPayload: "{}",
    });
    await reg.getProvider(account.id);
    await expect(reg.removeAccount(account.id)).resolves.toBe(true);
    expect(reg.getAccount(account.id)).toBeNull();
  });

  it("updateAuthStatus flips the column", async () => {
    const reg = makeRegistry();
    const account = await reg.addAccount({
      kind: "gmail",
      email: "owner@example.com",
      authType: "oauth",
      secretPayload: "x",
    });
    expect(reg.updateAuthStatus(account.id, "requires_consent", "AADSTS50173")).toBe(true);
    expect(reg.getAccount(account.id)?.authStatus).toBe("requires_consent");
    const health = reg.getHealth(account.id)!;
    expect(health.lastError).toBe("AADSTS50173");
    expect(health.lastErrorAtUtc).toBe("2026-04-16T12:00:00.000Z");
  });

  it("updateAuthStatus returns false for unknown id", () => {
    expect(makeRegistry().updateAuthStatus("ghost", "degraded")).toBe(false);
  });

  it("recordPollTick(success) clears errors", async () => {
    const reg = makeRegistry();
    const account = await reg.addAccount({
      kind: "gmail",
      email: "o@example.com",
      authType: "oauth",
      secretPayload: "x",
    });
    reg.recordPollTick(account.id, { success: false, error: "boom" });
    reg.recordPollTick(account.id, { success: false, error: "boom" });
    expect(reg.getConsecutiveErrorCount(account.id)).toBe(2);
    reg.recordPollTick(account.id, { success: true });
    expect(reg.getConsecutiveErrorCount(account.id)).toBe(0);
    const health = reg.getHealth(account.id)!;
    expect(health.lastError).toBeNull();
    expect(health.lastPollAtUtc).toBe("2026-04-16T12:00:00.000Z");
  });

  it("recordPollTick(failure) increments and stamps error", async () => {
    const reg = makeRegistry();
    const account = await reg.addAccount({
      kind: "gmail",
      email: "o@example.com",
      authType: "oauth",
      secretPayload: "x",
    });
    reg.recordPollTick(account.id, { success: false, error: "boom" });
    const health = reg.getHealth(account.id)!;
    expect(health.consecutiveErrorCount).toBe(1);
    expect(health.lastError).toBe("boom");
    expect(health.lastErrorAtUtc).toBe("2026-04-16T12:00:00.000Z");
  });

  it("getConsecutiveErrorCount returns 0 for unknown id", () => {
    expect(makeRegistry().getConsecutiveErrorCount("ghost")).toBe(0);
  });

  it("recordPollTick returns false for unknown id", () => {
    const reg = makeRegistry();
    expect(reg.recordPollTick("ghost", { success: true })).toBe(false);
    expect(reg.recordPollTick("ghost", { success: false, error: "x" })).toBe(false);
  });

  it("loadPollCursor returns null when none set, round-trips after save", async () => {
    const reg = makeRegistry();
    const account = await reg.addAccount({
      kind: "gmail",
      email: "o@example.com",
      authType: "oauth",
      secretPayload: "x",
    });
    expect(reg.loadPollCursor(account.id)).toBeNull();
    expect(reg.savePollCursor(account.id, { kind: "graph", deltaLink: "https://x" })).toBe(true);
    expect(reg.loadPollCursor(account.id)).toEqual({ kind: "graph", deltaLink: "https://x" });
  });

  it("loadPollCursor returns null for invalid JSON in the column", async () => {
    const reg = makeRegistry();
    const account = await reg.addAccount({
      kind: "gmail",
      email: "o@example.com",
      authType: "oauth",
      secretPayload: "x",
    });
    db.prepare(`UPDATE mail_accounts SET poll_cursor_json = 'not-json' WHERE id = ?`).run(
      account.id,
    );
    expect(reg.loadPollCursor(account.id)).toBeNull();
  });

  it("savePollCursor returns false for unknown id", () => {
    expect(makeRegistry().savePollCursor("ghost", { kind: "graph" })).toBe(false);
  });

  it("evictProvider drops the cached provider", async () => {
    enabled = ["gmail", "outlook"];
    let buildCount = 0;
    const reg = new MailAccountRegistry({
      db,
      blobStore,
      getEnabledKinds: () => enabled,
      now: () => new Date("2026-04-16T12:00:00.000Z"),
      providerFactories: {
        outlook: (account) => {
          buildCount++;
          return makeStubProvider(account);
        },
      },
    });
    const account = await reg.addAccount({
      kind: "outlook",
      email: "o@example.com",
      authType: "oauth",
      secretPayload: "{}",
    });
    await reg.getProvider(account.id);
    expect(buildCount).toBe(1);
    reg.evictProvider(account.id);
    await reg.getProvider(account.id);
    expect(buildCount).toBe(2);
  });

  it("onProviderSelectionChanged drops cached providers for kinds leaving the enabled set", async () => {
    enabled = ["gmail", "outlook"];
    let buildCount = 0;
    const reg = new MailAccountRegistry({
      db,
      blobStore,
      getEnabledKinds: () => enabled,
      now: () => new Date("2026-04-16T12:00:00.000Z"),
      providerFactories: {
        outlook: (account) => {
          buildCount++;
          return makeStubProvider(account);
        },
      },
    });
    const account = await reg.addAccount({
      kind: "outlook",
      email: "o@example.com",
      authType: "oauth",
      secretPayload: "{}",
    });
    await reg.getProvider(account.id);
    reg.onProviderSelectionChanged(["gmail"]);
    enabled = ["gmail", "outlook"];
    await reg.getProvider(account.id);
    expect(buildCount).toBe(2);
  });

  it("getAbortSignal returns a live signal that aborts on removeAccount", async () => {
    const reg = makeRegistry();
    const account = await reg.addAccount({
      kind: "gmail",
      email: "owner@example.com",
      authType: "oauth",
      secretPayload: "x",
    });
    const signal = reg.getAbortSignal(account.id);
    expect(signal.aborted).toBe(false);
    await reg.removeAccount(account.id);
    expect(signal.aborted).toBe(true);
  });

  it("getAbortSignal mints a fresh controller for the next caller after remove", async () => {
    const reg = makeRegistry();
    const account = await reg.addAccount({
      kind: "gmail",
      email: "owner@example.com",
      authType: "oauth",
      secretPayload: "x",
    });
    const first = reg.getAbortSignal(account.id);
    await reg.removeAccount(account.id);
    // Re-add with the same email (new id) — the prior signal stays aborted,
    // but a fresh one is minted on demand.
    const reborn = await reg.addAccount({
      kind: "gmail",
      email: "owner@example.com",
      authType: "oauth",
      secretPayload: "x",
    });
    const next = reg.getAbortSignal(reborn.id);
    expect(first.aborted).toBe(true);
    expect(next.aborted).toBe(false);
  });

  it("setActive(false) evicts the cached provider and aborts the controller", async () => {
    enabled = ["gmail", "outlook"];
    let buildCount = 0;
    let revokeCount = 0;
    const reg = new MailAccountRegistry({
      db,
      blobStore,
      getEnabledKinds: () => enabled,
      now: () => new Date("2026-04-16T12:00:00.000Z"),
      providerFactories: {
        outlook: (account) => {
          buildCount++;
          return makeStubProvider(account, {
            revoke: async () => {
              revokeCount++;
            },
          });
        },
      },
    });
    const account = await reg.addAccount({
      kind: "outlook",
      email: "o@example.com",
      authType: "oauth",
      secretPayload: "{}",
    });
    const signal = reg.getAbortSignal(account.id);
    await reg.getProvider(account.id);
    expect(buildCount).toBe(1);
    await reg.setActive(account.id, false);
    expect(signal.aborted).toBe(true);
    expect(revokeCount).toBe(1);
    await reg.setActive(account.id, true);
    await reg.getProvider(account.id);
    expect(buildCount).toBe(2);
  });

  it("provider factory receives the per-account AbortSignal", async () => {
    enabled = ["gmail", "outlook"];
    let received: AbortSignal | null = null;
    const reg = new MailAccountRegistry({
      db,
      blobStore,
      getEnabledKinds: () => enabled,
      now: () => new Date("2026-04-16T12:00:00.000Z"),
      providerFactories: {
        outlook: (account, ctx) => {
          received = ctx.signal;
          return makeStubProvider(account);
        },
      },
    });
    const account = await reg.addAccount({
      kind: "outlook",
      email: "o@example.com",
      authType: "oauth",
      secretPayload: "{}",
    });
    await reg.getProvider(account.id);
    expect(received).not.toBeNull();
    expect(received!.aborted).toBe(false);
    await reg.removeAccount(account.id);
    expect(received!.aborted).toBe(true);
  });

  it("addAccount defaults now() to wall-clock and persists idleEnabled=true", async () => {
    const before = Date.now();
    const reg = new MailAccountRegistry({
      db,
      blobStore,
      getEnabledKinds: () => enabled,
      providerFactories: {
        gmail: (row) => makeStubProvider(row),
      },
    });
    const account = await reg.addAccount({
      kind: "gmail",
      email: "owner@example.com",
      authType: "oauth",
      secretPayload: "x",
      idleEnabled: true,
    });
    const after = Date.now();
    expect(account.idleEnabled).toBe(true);
    const parsed = Date.parse(account.createdAt);
    expect(parsed).toBeGreaterThanOrEqual(before);
    expect(parsed).toBeLessThanOrEqual(after);
  });

  it("updateCapabilities persists the probe and getCapabilities reads it back", () => {
    insertRow(db, { id: "yahoo-a", kind: "yahoo", email: "y@example.com" });
    const reg = makeRegistry();
    expect(reg.getCapabilities("yahoo-a")).toBeNull();

    const written = reg.updateCapabilities("yahoo-a", {
      qresync: false,
      threadReferences: true,
      specialUse: true,
      uidplus: true,
      idle: true,
      move: false,
      all: ["IDLE", "SPECIAL-USE", "THREAD=REFERENCES", "UIDPLUS"],
    });
    expect(written).toBe(true);
    const caps = reg.getCapabilities("yahoo-a");
    expect(caps).not.toBeNull();
    expect(caps?.idle).toBe(true);
    expect(caps?.threadReferences).toBe(true);
    expect(caps?.qresync).toBe(false);
  });

  it("updateCapabilities returns false when the account row is missing", () => {
    const reg = makeRegistry();
    const written = reg.updateCapabilities("missing-acct", {
      qresync: false,
      threadReferences: false,
      specialUse: false,
      uidplus: false,
      idle: false,
      move: false,
      all: [],
    });
    expect(written).toBe(false);
  });

  it("getCapabilities returns null when the account row is missing", () => {
    expect(makeRegistry().getCapabilities("nope")).toBeNull();
  });

  it("addAccount persists capabilities captured at smoke-test time", async () => {
    const enabled: MailProviderKind[] = ["yahoo"];
    const blobStore = new MemoryBlobStore();
    const reg = new MailAccountRegistry({
      db,
      blobStore,
      getEnabledKinds: () => enabled,
      providerFactories: {
        yahoo: (account) => makeStubProvider(account),
      },
    });
    const account = await reg.addAccount({
      kind: "yahoo",
      email: "owner@yahoo.example.com",
      authType: "app_password",
      secretPayload: "x",
      capabilities: {
        qresync: false,
        threadReferences: true,
        specialUse: true,
        uidplus: true,
        idle: true,
        move: false,
        all: ["IDLE", "SPECIAL-USE", "THREAD=REFERENCES", "UIDPLUS"],
      },
    });
    // Freshly-added rows must never start with NULL capabilities — that's the
    // whole reason for threading the smoke-test probe through addAccount. If
    // this test fails, Phase 7's capability-driven branches will see a window
    // of NULL state between account creation and the first poll tick.
    const caps = reg.getCapabilities(account.id);
    expect(caps).not.toBeNull();
    expect(caps?.idle).toBe(true);
    expect(caps?.specialUse).toBe(true);
  });

  it("addAccount omits capabilities when not supplied (non-IMAP paths)", async () => {
    const enabled: MailProviderKind[] = ["outlook"];
    const blobStore = new MemoryBlobStore();
    const reg = new MailAccountRegistry({
      db,
      blobStore,
      getEnabledKinds: () => enabled,
      providerFactories: {
        outlook: (account) => makeStubProvider(account),
      },
    });
    const account = await reg.addAccount({
      kind: "outlook",
      email: "o@example.com",
      authType: "oauth",
      secretPayload: "x",
    });
    // Outlook uses Graph, not IMAP — no CAPABILITY concept. Row stays NULL
    // until (never, for outlook) and that's the correct shape.
    expect(reg.getCapabilities(account.id)).toBeNull();
  });

  it("peekProvider returns null when no provider is cached for the account", async () => {
    enabled = ["gmail", "outlook"];
    const reg = new MailAccountRegistry({
      db,
      blobStore,
      getEnabledKinds: () => enabled,
      now: () => new Date("2026-04-16T12:00:00.000Z"),
      providerFactories: {
        outlook: (account) => makeStubProvider(account),
      },
    });
    const account = await reg.addAccount({
      kind: "outlook",
      email: "peek@example.com",
      authType: "oauth",
      secretPayload: "{}",
    });
    // Provider not yet built (no getProvider call) → peek returns null.
    expect(reg.peekProvider(account.id)).toBeNull();
    // After building, peek returns the cached provider.
    await reg.getProvider(account.id);
    expect(reg.peekProvider(account.id)).not.toBeNull();
  });

  it("constructor accepts options without providerFactories (defaults to {})", async () => {
    // Wiring-time defensive default — the dashboard's setup wizard can
    // construct a registry before any provider factory has been
    // registered. Calls into provider-needing paths just surface the
    // existing ProviderNotImplementedError.
    insertRow(db, { id: "gmail-a" });
    const reg = new MailAccountRegistry({
      db,
      blobStore,
      getEnabledKinds: () => enabled,
      now: () => new Date("2026-04-16T12:00:00.000Z"),
      // providerFactories intentionally omitted.
    });
    expect(reg.listAccounts().map((a) => a.id)).toEqual(["gmail-a"]);
    await expect(reg.getProvider("gmail-a")).rejects.toThrow(
      ProviderNotImplementedError,
    );
  });

  it("onScopeChanged user hook that throws is swallowed (mutations still succeed)", async () => {
    // A buggy observer must not break account mutations — the registry
    // wraps the user-provided hook in a try/catch so a throwing hook
    // doesn't poison addAccount / removeAccount / etc.
    let callCount = 0;
    const reg = new MailAccountRegistry({
      db,
      blobStore,
      getEnabledKinds: () => enabled,
      now: () => new Date("2026-04-16T12:00:00.000Z"),
      providerFactories: { gmail: (account) => makeStubProvider(account) },
      onScopeChanged: () => {
        callCount++;
        throw new Error("observer is misbehaving");
      },
    });
    const account = await reg.addAccount({
      kind: "gmail",
      email: "owner@example.com",
      authType: "oauth",
      secretPayload: "x",
    });
    expect(callCount).toBe(1);
    // Mutation still completed despite the hook throwing.
    expect(reg.getAccount(account.id)).not.toBeNull();
  });

  it("removeAccount logs and continues when blobStore.remove rejects (orphans bytes but row is gone)", async () => {
    // After the DB row is deleted the secret is unreachable; a blob
    // teardown failure only leaks bytes on disk, so the operation
    // must succeed and `onScopeChanged('account_removed')` must fire.
    const flakyBlobStore: MemoryBlobStore = new MemoryBlobStore();
    const removeOrig = flakyBlobStore.remove.bind(flakyBlobStore);
    let removeCallCount = 0;
    flakyBlobStore.remove = async (name) => {
      removeCallCount++;
      if (removeCallCount === 1) throw new Error("disk error");
      return removeOrig(name);
    };

    const reg = new MailAccountRegistry({
      db,
      blobStore: flakyBlobStore,
      getEnabledKinds: () => enabled,
      now: () => new Date("2026-04-16T12:00:00.000Z"),
      providerFactories: { gmail: (account) => makeStubProvider(account) },
    });
    const account = await reg.addAccount({
      kind: "gmail",
      email: "owner@example.com",
      authType: "oauth",
      secretPayload: "x",
    });

    await expect(reg.removeAccount(account.id)).resolves.toBe(true);
    expect(removeCallCount).toBe(1);
    expect(reg.getAccount(account.id)).toBeNull();
  });

  it("refreshImapSecret swallows cached.revoke() throws and proceeds with the rotation", async () => {
    enabled = ["yahoo"];
    const reg = new MailAccountRegistry({
      db,
      blobStore,
      getEnabledKinds: () => enabled,
      now: () => new Date("2026-04-16T12:00:00.000Z"),
      providerFactories: {
        yahoo: (account) =>
          makeStubProvider(account, {
            revoke: async () => {
              throw new Error("network gone");
            },
          }),
      },
    });
    const account = await reg.addAccount({
      kind: "yahoo",
      email: "owner@yahoo.com",
      authType: "app_password",
      secretPayload: '{"appPassword":"old","email":"owner@yahoo.com","kind":"yahoo"}',
    });
    // Build provider to populate the cache, then refresh — revoke()
    // throws but the refresh path must still complete.
    await reg.getProvider(account.id);
    const refreshed = await reg.refreshImapSecret(
      account.id,
      '{"appPassword":"new","email":"owner@yahoo.com","kind":"yahoo"}',
    );
    expect(refreshed?.authStatus).toBe("healthy");
  });

  it("refreshImapSecret persists imap_capabilities_json when capabilities are provided", async () => {
    enabled = ["yahoo"];
    const reg = new MailAccountRegistry({
      db,
      blobStore,
      getEnabledKinds: () => enabled,
      now: () => new Date("2026-04-16T12:00:00.000Z"),
      providerFactories: { yahoo: (account) => makeStubProvider(account) },
    });
    const account = await reg.addAccount({
      kind: "yahoo",
      email: "owner@yahoo.com",
      authType: "app_password",
      secretPayload: '{"appPassword":"old","email":"owner@yahoo.com","kind":"yahoo"}',
    });

    const capabilities = {
      qresync: false,
      threadReferences: false,
      specialUse: true,
      uidplus: true,
      idle: false,
      move: true,
      all: ["IDLE", "MOVE", "SPECIAL-USE", "UIDPLUS"],
    };
    await reg.refreshImapSecret(
      account.id,
      '{"appPassword":"new","email":"owner@yahoo.com","kind":"yahoo"}',
      capabilities,
    );

    const persisted = reg.getCapabilities(account.id);
    expect(persisted).toMatchObject({ specialUse: true, uidplus: true });
  });

  it("refreshImapSecret on a healthy account fires `account_reauthed` (not `auth_status_recovered`)", async () => {
    enabled = ["yahoo"];
    const events: string[] = [];
    const reg = new MailAccountRegistry({
      db,
      blobStore,
      getEnabledKinds: () => enabled,
      now: () => new Date("2026-04-16T12:00:00.000Z"),
      providerFactories: { yahoo: (account) => makeStubProvider(account) },
      onScopeChanged: (reason) => events.push(reason),
    });
    const account = await reg.addAccount({
      kind: "yahoo",
      email: "owner@yahoo.com",
      authType: "app_password",
      secretPayload: '{"appPassword":"old","email":"owner@yahoo.com","kind":"yahoo"}',
    });
    events.length = 0; // drop the account_added event

    await reg.refreshImapSecret(
      account.id,
      '{"appPassword":"new","email":"owner@yahoo.com","kind":"yahoo"}',
    );

    // Healthy → still healthy after refresh: that's `account_reauthed`,
    // not the requires_consent → healthy recovery path.
    expect(events).toEqual(["account_reauthed"]);
  });

  it("updateAuthStatus fires `auth_status_recovered` when transitioning non-healthy → healthy", async () => {
    const events: string[] = [];
    const reg = new MailAccountRegistry({
      db,
      blobStore,
      getEnabledKinds: () => enabled,
      now: () => new Date("2026-04-16T12:00:00.000Z"),
      providerFactories: { gmail: (account) => makeStubProvider(account) },
      onScopeChanged: (reason) => events.push(reason),
    });
    const account = await reg.addAccount({
      kind: "gmail",
      email: "owner@example.com",
      authType: "oauth",
      secretPayload: "x",
    });
    // Degrade first so the next flip is non-healthy → healthy.
    reg.updateAuthStatus(account.id, "requires_consent", "user revoked");
    events.length = 0;

    expect(reg.updateAuthStatus(account.id, "healthy")).toBe(true);
    expect(events).toEqual(["auth_status_recovered"]);
  });

  it("onProviderSelectionChanged announces on the first call even with identical sets (lastAnnouncedKinds=null)", () => {
    // The `changed` predicate's first disjunct is `lastAnnouncedKinds === null`
    // — the first invocation always fires regardless of set membership,
    // so a freshly-constructed registry that's told its enabled kinds
    // for the first time still notifies downstream consumers.
    const events: string[] = [];
    const reg = new MailAccountRegistry({
      db,
      blobStore,
      getEnabledKinds: () => enabled,
      now: () => new Date("2026-04-16T12:00:00.000Z"),
      providerFactories: { gmail: (account) => makeStubProvider(account) },
      onScopeChanged: (reason) => events.push(reason),
    });

    reg.onProviderSelectionChanged(["gmail"]);
    expect(events).toEqual(["enabled_providers_changed"]);

    // Same set → silent on the second call.
    events.length = 0;
    reg.onProviderSelectionChanged(["gmail"]);
    expect(events).toEqual([]);

    // Different size → fires.
    reg.onProviderSelectionChanged(["gmail", "outlook"]);
    expect(events).toEqual(["enabled_providers_changed"]);

    // Same size but different members → fires (some() branch).
    events.length = 0;
    reg.onProviderSelectionChanged(["gmail", "yahoo"]);
    expect(events).toEqual(["enabled_providers_changed"]);
  });

  it("setActive(false) swallows revoke() errors so the account still disables (line 402 catch block)", async () => {
    enabled = ["gmail", "outlook"];
    const reg = new MailAccountRegistry({
      db,
      blobStore,
      getEnabledKinds: () => enabled,
      now: () => new Date("2026-04-16T12:00:00.000Z"),
      providerFactories: {
        outlook: (account) =>
          makeStubProvider(account, {
            revoke: async () => {
              throw new Error("network gone");
            },
          }),
      },
    });
    const account = await reg.addAccount({
      kind: "outlook",
      email: "r@example.com",
      authType: "oauth",
      secretPayload: "{}",
    });
    await reg.getProvider(account.id);
    // revoke() throws but setActive should still succeed.
    const result = await reg.setActive(account.id, false);
    expect(result?.active).toBe(false);
  });
});
