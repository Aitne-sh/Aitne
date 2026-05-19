import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Hono } from "hono";
import { applySchema } from "../../db/schema.js";
import { SecretBroker } from "../../secrets/secret-broker.js";
import type { SecretStore } from "../../secrets/secret-store.js";
import type { StoredSecretName } from "../../secrets/secret-names.js";
import { createGitAccountsRoutes } from "./git-accounts.js";
import type { ApiDependencies } from "../server.js";
import type { AgentConfig } from "../../config.js";
import type { GitAccountSetting } from "../../settings/runtime-settings.js";
import { createServiceRegistry } from "../../services/service-registry.js";

// ── probeGitAccount + applyConfigUpdates selective mocking ────────────────
// Use vi.hoisted so the mutable overrides object is created before any module
// imports resolve (vitest hoists vi.mock/vi.hoisted calls above imports).
const gitAccountOverrides = vi.hoisted(() => ({
  probeGitAccount: undefined as ((...args: unknown[]) => Promise<unknown>) | undefined,
  applyConfigUpdates: undefined as ((...args: unknown[]) => Promise<unknown>) | undefined,
}));

vi.mock("../../services/git-account-registry.js", async () => {
  const actual = await vi.importActual<typeof import("../../services/git-account-registry.js")>(
    "../../services/git-account-registry.js",
  );
  return {
    ...actual,
    probeGitAccount: async (...args: unknown[]) =>
      gitAccountOverrides.probeGitAccount
        ? gitAccountOverrides.probeGitAccount(...args)
        : actual.probeGitAccount(
            args[0] as Parameters<typeof actual.probeGitAccount>[0],
            args[1] as string,
          ),
  };
});

vi.mock("../env-writer.js", async () => {
  const actual = await vi.importActual<typeof import("../env-writer.js")>("../env-writer.js");
  return {
    ...actual,
    applyConfigUpdates: async (...args: unknown[]) =>
      gitAccountOverrides.applyConfigUpdates
        ? gitAccountOverrides.applyConfigUpdates(...args)
        : actual.applyConfigUpdates(
            args[0] as Parameters<typeof actual.applyConfigUpdates>[0],
            args[1] as Parameters<typeof actual.applyConfigUpdates>[1],
            args[2] as Parameters<typeof actual.applyConfigUpdates>[2],
          ),
  };
});

class InMemorySecretStore implements SecretStore {
  private readonly values = new Map<StoredSecretName, string>();

  async has(name: StoredSecretName): Promise<boolean> {
    return this.values.has(name);
  }

  async get(name: StoredSecretName): Promise<string | null> {
    return this.values.get(name) ?? null;
  }

  async set(name: StoredSecretName, value: string): Promise<void> {
    this.values.set(name, value);
  }

  async delete(name: StoredSecretName): Promise<void> {
    this.values.delete(name);
  }

  inspect(): Map<StoredSecretName, string> {
    return new Map(this.values);
  }
}

/** Store whose set() always throws — exercises the secret_write_failed path. */
class ThrowingSetStore extends InMemorySecretStore {
  override async set(_name: StoredSecretName, _value: string): Promise<void> {
    throw new Error("Simulated keychain write failure");
  }
}

/** Store whose delete() always throws — exercises the non-fatal DELETE catch. */
class ThrowingDeleteStore extends InMemorySecretStore {
  override async delete(_name: StoredSecretName): Promise<void> {
    throw new Error("Simulated keychain delete failure");
  }
}

describe("Git accounts API routes", () => {
  let dataDir: string;
  let db: Database.Database;
  let store: InMemorySecretStore;
  let broker: SecretBroker;
  let app: Hono;
  let config: AgentConfig;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "pa-git-acc-route-"));
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applySchema(db);
    store = new InMemorySecretStore();
    broker = new SecretBroker(store, { cacheTtlMs: 0 });
    config = {
      dataDir,
      workspaceDir: resolve(__dirname, "..", "..", "..", "..", ".."),
      apiPort: 8321,
      timezone: "UTC",
      dayBoundaryHour: 0,
      gitAccounts: {},
    } as unknown as AgentConfig;
    const deps = {
      db,
      config,
      secretBroker: broker,
      services: createServiceRegistry(),
      getHealthData: () => ({
        uptime: 0,
        eventBusSize: 0,
        activeSessions: 0,
        connectedPlatforms: [],
        registeredObservers: [],
        missingContextFiles: [],
        contextFilesOk: true,
      }),
      getIntegrationStatus: () =>
        ({}) as ReturnType<ApiDependencies["getIntegrationStatus"]>,
    } as unknown as ApiDependencies;
    app = new Hono();
    app.route("/api", createGitAccountsRoutes(deps));
  });

  afterEach(() => {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
    gitAccountOverrides.probeGitAccount = undefined;
    gitAccountOverrides.applyConfigUpdates = undefined;
  });

  it("GET /api/git-accounts returns an empty list when none configured", async () => {
    const res = await app.request("/api/git-accounts");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { accounts: unknown[] };
    expect(body.accounts).toEqual([]);
  });

  it("PUT creates a pat-keychain account, stores token, GET reflects it", async () => {
    const putRes = await app.request("/api/git-accounts/work", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "github",
        authMode: "pat-keychain",
        host: "github.com",
        token: "ghp_secret",
      }),
    });
    expect(putRes.status).toBe(200);

    expect(store.inspect().get("git.account.work")).toBe("ghp_secret");

    const getRes = await app.request("/api/git-accounts");
    const body = (await getRes.json()) as {
      accounts: Array<{
        alias: string;
        authMode: string;
        host: string;
        tokenStored: boolean | null;
      }>;
    };
    expect(body.accounts).toEqual([
      expect.objectContaining({
        alias: "work",
        authMode: "pat-keychain",
        host: "github.com",
        tokenStored: true,
      }),
    ]);
    // Response never carries the token value itself.
    expect(JSON.stringify(body)).not.toContain("ghp_secret");
  });

  it("PUT for pat-keychain rejects creation without token", async () => {
    const res = await app.request("/api/git-accounts/work", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "github",
        authMode: "pat-keychain",
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("token_required");
  });

  it("PUT update without token preserves the stored secret when present", async () => {
    // Create with a token
    await app.request("/api/git-accounts/work", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "github",
        authMode: "pat-keychain",
        host: "github.com",
        token: "ghp_first",
      }),
    });
    // Update — no token in body
    const res = await app.request("/api/git-accounts/work", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "github",
        authMode: "pat-keychain",
        host: "github.com",
      }),
    });
    expect(res.status).toBe(200);
    expect(store.inspect().get("git.account.work")).toBe("ghp_first");
  });

  it("PUT rejects gh-cli-profile without ghProfile", async () => {
    const res = await app.request("/api/git-accounts/personal", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "github",
        authMode: "gh-cli-profile",
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_body");
  });

  it("PUT rejects aliases outside the safe regex", async () => {
    for (const bad of ["AB", "with space", "with/slash", ""]) {
      const res = await app.request(
        `/api/git-accounts/${encodeURIComponent(bad)}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            type: "github",
            authMode: "pat-keychain",
            token: "x",
          }),
        },
      );
      // Empty key never matches the route; the rest are 400
      expect([400, 404]).toContain(res.status);
    }
  });

  it("DELETE removes both metadata and keychain entry", async () => {
    await app.request("/api/git-accounts/work", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "github",
        authMode: "pat-keychain",
        host: "github.com",
        token: "tok",
      }),
    });
    const res = await app.request("/api/git-accounts/work", {
      method: "DELETE",
    });
    expect(res.status).toBe(200);
    expect(store.inspect().has("git.account.work")).toBe(false);
    expect(config.gitAccounts).toEqual({});
  });

  it("DELETE 404s for unknown alias", async () => {
    const res = await app.request("/api/git-accounts/ghost", {
      method: "DELETE",
    });
    expect(res.status).toBe(404);
  });

  it("survives a fresh settings-store read — proves accounts persist across boot", async () => {
    // Acceptance criterion: switching `gitMode` between `direct` and
    // `delegated` does not lose configured accounts. The mode flip
    // touches integration_modes and observers but never the
    // `settings.gitAccounts` row, so the round-trip we exercise here
    // (write → read from a fresh SettingsStore) is the relevant proof.
    await app.request("/api/git-accounts/work", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "github",
        authMode: "pat-keychain",
        host: "github.com",
        token: "tok",
      }),
    });
    const { createSettingsStore } = await import(
      "../../settings/settings-store.js"
    );
    const fresh = createSettingsStore(db);
    const stored = fresh.get("gitAccounts");
    expect(stored).toEqual({
      work: {
        type: "github",
        authMode: "pat-keychain",
        host: "github.com",
      },
    });
  });

  it("GET /api/git-accounts/:alias returns the single account", async () => {
    await app.request("/api/git-accounts/work", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "github",
        authMode: "pat-keychain",
        host: "ghe.example.com",
        token: "tok",
      }),
    });
    const res = await app.request("/api/git-accounts/work");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      alias: string;
      host: string;
      tokenStored: boolean;
    };
    expect(body).toEqual(
      expect.objectContaining({
        alias: "work",
        host: "ghe.example.com",
        tokenStored: true,
      }),
    );
  });

  // ── GET /:alias — invalid alias + not_found + gh-cli-profile path ────────

  it("GET /api/git-accounts/:alias returns 400 for invalid alias (uppercase)", async () => {
    const res = await app.request("/api/git-accounts/UPPERCASE");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_alias");
  });

  it("GET /api/git-accounts/:alias returns 404 for valid alias with no account", async () => {
    const res = await app.request("/api/git-accounts/ghost");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("not_found");
  });

  it("GET /api/git-accounts/:alias reports tokenStored=null for gh-cli-profile", async () => {
    // gh-cli-profile accounts don't store a token in the keychain.
    await app.request("/api/git-accounts/personal", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "github",
        authMode: "gh-cli-profile",
        ghProfile: "myuser",
        host: "github.com",
      }),
    });
    const res = await app.request("/api/git-accounts/personal");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tokenStored: null };
    // gh-cli-profile: tokenStored is null (token lives in gh CLI, not keychain)
    expect(body.tokenStored).toBeNull();
  });

  it("GET /api/git-accounts (list) reports tokenStored=null for gh-cli-profile entry", async () => {
    await app.request("/api/git-accounts/personal", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "github",
        authMode: "gh-cli-profile",
        ghProfile: "myuser",
      }),
    });
    const res = await app.request("/api/git-accounts");
    const body = (await res.json()) as {
      accounts: Array<{ alias: string; tokenStored: null }>;
    };
    const personal = body.accounts.find((a) => a.alias === "personal");
    expect(personal?.tokenStored).toBeNull();
  });

  // ── PUT: alias validation, empty token, body_too_large, secret_write_failed

  it("PUT returns 400 invalid_alias for alias with uppercase letters", async () => {
    const res = await app.request("/api/git-accounts/WORK", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "github", authMode: "pat-keychain", token: "x" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_alias");
  });

  it("PUT returns 400 invalid_alias for alias exceeding 40 characters", async () => {
    const longAlias = "a".repeat(41);
    const res = await app.request(`/api/git-accounts/${longAlias}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "github", authMode: "pat-keychain", token: "x" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_alias");
  });

  it("PUT returns 400 when token is an empty string", async () => {
    const res = await app.request("/api/git-accounts/work", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "github",
        authMode: "pat-keychain",
        token: "",
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("invalid_body");
    expect(body.message).toContain("non-empty");
  });

  it("PUT returns 413 body_too_large when Content-Length exceeds TOKEN_MAX_BYTES", async () => {
    const res = await app.request("/api/git-accounts/work", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        // 4097 > TOKEN_MAX_BYTES (4096) triggers the Content-Length pre-check.
        "Content-Length": "4097",
      },
      body: JSON.stringify({ type: "github", authMode: "pat-keychain", token: "x" }),
    });
    expect(res.status).toBe(413);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("body_too_large");
  });

  it("PUT returns 500 secret_write_failed when keychain write throws", async () => {
    const throwingStore = new ThrowingSetStore();
    const throwingBroker = new SecretBroker(throwingStore, { cacheTtlMs: 0 });
    const throwingApp = new Hono();
    throwingApp.route(
      "/api",
      createGitAccountsRoutes({
        db,
        config,
        secretBroker: throwingBroker,
        services: createServiceRegistry(),
        getHealthData: () => ({
          uptime: 0,
          eventBusSize: 0,
          activeSessions: 0,
          connectedPlatforms: [],
          registeredObservers: [],
          missingContextFiles: [],
          contextFilesOk: true,
        }),
        getIntegrationStatus: () =>
          ({}) as ReturnType<ApiDependencies["getIntegrationStatus"]>,
      } as unknown as ApiDependencies),
    );
    const res = await throwingApp.request("/api/git-accounts/work", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "github",
        authMode: "pat-keychain",
        host: "github.com",
        token: "ghp_secret",
      }),
    });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("secret_write_failed");
  });

  it("PUT returns 400 validation_failed when applyConfigUpdates reports errors", async () => {
    gitAccountOverrides.applyConfigUpdates = async () => ({
      updated: [],
      requiresRestart: [],
      errors: { gitAccounts: "simulated validation failure" },
    });
    const res = await app.request("/api/git-accounts/work", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "github",
        authMode: "pat-keychain",
        host: "github.com",
        token: "tok",
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("validation_failed");
  });

  // ── DELETE: invalid alias + non-fatal secret deletion failure ────────────

  it("DELETE returns 400 invalid_alias for alias with uppercase letters", async () => {
    const res = await app.request("/api/git-accounts/WORK", { method: "DELETE" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_alias");
  });

  it("DELETE returns 400 validation_failed when applyConfigUpdates reports errors", async () => {
    // First create an account so the not_found check passes.
    await app.request("/api/git-accounts/work", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "github",
        authMode: "pat-keychain",
        host: "github.com",
        token: "tok",
      }),
    });
    gitAccountOverrides.applyConfigUpdates = async () => ({
      updated: [],
      requiresRestart: [],
      errors: { gitAccounts: "simulated validation failure on delete" },
    });
    const res = await app.request("/api/git-accounts/work", { method: "DELETE" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("validation_failed");
  });

  it("DELETE still returns 200 ok when keychain deleteScoped throws (non-fatal)", async () => {
    const throwingStore = new ThrowingDeleteStore();
    // Pre-seed the store so hasScoped returns true for the alias.
    throwingStore["values"].set(
      "git.account.work" as StoredSecretName,
      "tok",
    );
    const throwingBroker = new SecretBroker(throwingStore, { cacheTtlMs: 0 });
    const throwingApp = new Hono();
    throwingApp.route(
      "/api",
      createGitAccountsRoutes({
        db,
        config,
        secretBroker: throwingBroker,
        services: createServiceRegistry(),
        getHealthData: () => ({
          uptime: 0,
          eventBusSize: 0,
          activeSessions: 0,
          connectedPlatforms: [],
          registeredObservers: [],
          missingContextFiles: [],
          contextFilesOk: true,
        }),
        getIntegrationStatus: () =>
          ({}) as ReturnType<ApiDependencies["getIntegrationStatus"]>,
      } as unknown as ApiDependencies),
    );
    // Create the account first through the throwing app so it lands in config.
    await throwingApp.request("/api/git-accounts/work", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      // pat-keychain but the ThrowingDeleteStore base InMemorySecretStore.set
      // still works (only delete throws).
      body: JSON.stringify({
        type: "github",
        authMode: "gh-cli-profile",
        ghProfile: "myuser",
        host: "github.com",
      }),
    });
    const res = await throwingApp.request("/api/git-accounts/work", {
      method: "DELETE",
    });
    // DELETE is non-fatal on keychain errors — still returns 200.
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  // ── POST /probe — invalid alias + not_found + ok/fail paths ──────────────

  it("POST /api/git-accounts/:alias/probe returns 400 for invalid alias", async () => {
    const res = await app.request("/api/git-accounts/INVALID/probe", {
      method: "POST",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_alias");
  });

  it("POST /api/git-accounts/:alias/probe returns 404 when alias has no account", async () => {
    const res = await app.request("/api/git-accounts/ghost/probe", {
      method: "POST",
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("not_found");
  });

  it("POST /api/git-accounts/:alias/probe returns 200 ok with login on success", async () => {
    // Create the account so the not_found guard passes.
    await app.request("/api/git-accounts/work", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "github",
        authMode: "pat-keychain",
        host: "github.com",
        token: "ghp_probe",
      }),
    });
    gitAccountOverrides.probeGitAccount = async () => ({
      ok: true,
      login: "myuser",
      host: "github.com",
    });
    const res = await app.request("/api/git-accounts/work/probe", {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; login: string };
    expect(body.ok).toBe(true);
    expect(body.login).toBe("myuser");
  });

  it("POST /api/git-accounts/:alias/probe returns 200 ok=false with reason on failure", async () => {
    await app.request("/api/git-accounts/work", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "github",
        authMode: "pat-keychain",
        host: "github.com",
        token: "ghp_probe",
      }),
    });
    gitAccountOverrides.probeGitAccount = async () => ({
      ok: false,
      reason: "unauthorized",
    });
    const res = await app.request("/api/git-accounts/work/probe", {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; reason: string };
    expect(body.ok).toBe(false);
    expect(body.reason).toBe("unauthorized");
  });

  // ── config.gitAccounts ?? {} fallback — GET list (branch 91) ────────────

  it("GET /api/git-accounts returns empty array when config.gitAccounts is undefined", async () => {
    // Branch 91: `Object.entries(deps.config.gitAccounts ?? {})` — the `?? {}`
    // right-side path (when gitAccounts is null/undefined). All other tests
    // initialise gitAccounts to {}, so this is the only test reaching this branch.
    const undefConfig = { ...config, gitAccounts: undefined } as unknown as AgentConfig;
    const undefApp = new Hono();
    undefApp.route(
      "/api",
      createGitAccountsRoutes({
        db,
        config: undefConfig,
        secretBroker: broker,
        services: createServiceRegistry(),
        getHealthData: () => ({
          uptime: 0, eventBusSize: 0, activeSessions: 0,
          connectedPlatforms: [], registeredObservers: [],
          missingContextFiles: [], contextFilesOk: true,
        }),
        getIntegrationStatus: () => ({}) as ReturnType<ApiDependencies["getIntegrationStatus"]>,
      } as unknown as ApiDependencies),
    );
    const res = await undefApp.request("/api/git-accounts");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { accounts: unknown[] };
    expect(body.accounts).toEqual([]);
  });

  // ── account.host || "github.com" fallback — GET list (branch 108) ────────

  it("GET /api/git-accounts list falls back to github.com when stored account lacks host", async () => {
    // Branch 108: `host: account.host || "github.com"` — the right-side fallback
    // is triggered when account.host is absent (e.g., migrated from an older
    // schema that lacked the host default). The gitAccountSchema now enforces
    // `.default("github.com")` so this path is unreachable via the API; we
    // test the defensive fallback by populating config directly.
    const accountWithoutHost = {
      type: "github",
      authMode: "gh-cli-profile",
      ghProfile: "myuser",
      // host intentionally absent — simulates old-schema storage row
    } as GitAccountSetting;
    config.gitAccounts = { work: accountWithoutHost };

    const res = await app.request("/api/git-accounts");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      accounts: Array<{ alias: string; host: string }>;
    };
    expect(body.accounts).toHaveLength(1);
    // The `|| "github.com"` fallback supplies the default when host is absent.
    expect(body.accounts[0]!.host).toBe("github.com");
  });

  // ── account.host || "github.com" fallback — GET /:alias (branch 135) ─────

  it("GET /api/git-accounts/:alias falls back to github.com when stored account lacks host", async () => {
    // Branch 135: same defensive `account.host || "github.com"` in the
    // single-account GET handler.
    const accountWithoutHost = {
      type: "github",
      authMode: "gh-cli-profile",
      ghProfile: "myuser",
    } as GitAccountSetting;
    config.gitAccounts = { work: accountWithoutHost };

    const res = await app.request("/api/git-accounts/work");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { alias: string; host: string };
    expect(body.alias).toBe("work");
    expect(body.host).toBe("github.com");
  });

  // ── config.gitAccounts ?? {} fallback — PUT (branch 203) ─────────────────

  it("PUT creates first account when config.gitAccounts is initially undefined", async () => {
    // Branch 203: `...(deps.config.gitAccounts ?? {})` in the PUT merge step.
    // With undefined gitAccounts, `undefined ?? {}` takes the right side,
    // and the new account becomes the only entry in the merged record.
    const undefConfig = { ...config, gitAccounts: undefined } as unknown as AgentConfig;
    const undefApp = new Hono();
    undefApp.route(
      "/api",
      createGitAccountsRoutes({
        db,
        config: undefConfig,
        secretBroker: broker,
        services: createServiceRegistry(),
        getHealthData: () => ({
          uptime: 0, eventBusSize: 0, activeSessions: 0,
          connectedPlatforms: [], registeredObservers: [],
          missingContextFiles: [], contextFilesOk: true,
        }),
        getIntegrationStatus: () => ({}) as ReturnType<ApiDependencies["getIntegrationStatus"]>,
      } as unknown as ApiDependencies),
    );
    const res = await undefApp.request("/api/git-accounts/work", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "github",
        authMode: "gh-cli-profile",
        ghProfile: "myuser",
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; alias: string };
    expect(body.ok).toBe(true);
    expect(body.alias).toBe("work");
  });

  // ── getAccounts arrow function (75% funcs → 100%) ────────────────────────

  it("POST /probe exercises registry.getAccounts via real probe flow (no network call)", async () => {
    // The `getAccounts: () => deps.config.gitAccounts` arrow function at
    // createGitAccountsRoutes is only exercised when the real probeGitAccount
    // runs (not the test override). This test omits the override, letting the
    // actual probe call registry.getAccount() → this.getAccounts() → the arrow
    // function.
    //
    // We use a gh-cli-profile account with a fake profile name. The real
    // defaultGhTokenResolver runs `gh auth token --user <fake-profile>` which
    // fails immediately (no network: it reads local ~/.config/gh/ state and
    // exits non-zero, or returns ENOENT if gh is not installed). Either path
    // returns null → probeGitAccount returns {ok:false, reason:"no_credential"}.
    await app.request("/api/git-accounts/probe-test", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "github",
        authMode: "gh-cli-profile",
        ghProfile: "test-profile-xyz-does-not-exist-coverage-only",
      }),
    });
    // gitAccountOverrides.probeGitAccount is undefined → real probe runs.
    const res = await app.request("/api/git-accounts/probe-test/probe", {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; reason?: string };
    // Probe fails (no real credentials) — any ok:false result is acceptable.
    expect(body.ok).toBe(false);
  });
});
