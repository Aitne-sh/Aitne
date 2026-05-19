import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GitAccountRegistry,
  __ASKPASS_BODY_FOR_TEST,
  __ASKPASS_RELATIVE_PATH_FOR_TEST,
  __ASKPASS_WINDOWS_BODY_FOR_TEST,
  __ASKPASS_WINDOWS_RELATIVE_PATH_FOR_TEST,
  askpassFileExists,
  probeGitAccount,
} from "./git-account-registry.js";
import { SecretBroker } from "../secrets/secret-broker.js";
import type { SecretStore } from "../secrets/secret-store.js";
import type { StoredSecretName } from "../secrets/secret-names.js";
import type { GitAccountSetting } from "../settings/runtime-settings.js";

type GhTokenResolver = NonNullable<
  ConstructorParameters<typeof GitAccountRegistry>[0]["ghTokenResolver"]
>;

class FakeSecretStore implements SecretStore {
  private readonly values = new Map<StoredSecretName, string>();

  seed(name: StoredSecretName, value: string): void {
    this.values.set(name, value);
  }

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
}

describe("GitAccountRegistry", () => {
  let dataDir: string;
  let store: FakeSecretStore;
  let broker: SecretBroker;
  let accounts: Record<string, GitAccountSetting>;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "pa-git-acc-"));
    store = new FakeSecretStore();
    broker = new SecretBroker(store, { cacheTtlMs: 0 });
    accounts = {};
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  function makeRegistry(opts?: {
    ghTokenResolver?: GhTokenResolver;
    platform?: NodeJS.Platform;
  }): GitAccountRegistry {
    return new GitAccountRegistry({
      dataDir,
      secretBroker: broker,
      getAccounts: () => accounts,
      ghTokenResolver: opts?.ghTokenResolver,
      platform: opts?.platform,
    });
  }

  it("returns null when alias is unknown", async () => {
    const reg = makeRegistry();
    expect(reg.getAccount("ghost")).toBeNull();
    await expect(reg.resolveCredentials("ghost")).resolves.toBeNull();
  });

  it("resolves a pat-keychain account via the scoped secret store", async () => {
    accounts.work = {
      type: "github",
      authMode: "pat-keychain",
      host: "github.com",
    };
    store.seed("git.account.work", "ghp_secret_TOKEN");

    const reg = makeRegistry();
    const creds = await reg.resolveCredentials("work");
    expect(creds).toEqual({ token: "ghp_secret_TOKEN", host: "github.com" });
  });

  it("returns null when pat-keychain alias has no stored token", async () => {
    accounts.work = {
      type: "github",
      authMode: "pat-keychain",
      host: "github.com",
    };
    const reg = makeRegistry();
    await expect(reg.resolveCredentials("work")).resolves.toBeNull();
  });

  it("resolves gh-cli-profile via the injected resolver", async () => {
    accounts.personal = {
      type: "github",
      authMode: "gh-cli-profile",
      ghProfile: "alice",
      host: "github.com",
    };
    const ghTokenResolver = vi.fn().mockResolvedValue("gh_cli_token");
    const reg = makeRegistry({
      ghTokenResolver: ghTokenResolver as GhTokenResolver,
    });
    const creds = await reg.resolveCredentials("personal");
    expect(creds).toEqual({ token: "gh_cli_token", host: "github.com" });
    expect(ghTokenResolver).toHaveBeenCalledWith({
      alias: "personal",
      host: "github.com",
      type: "github",
      authMode: "gh-cli-profile",
      ghProfile: "alice",
    });
  });

  it("buildSpawnEnv returns null when alias is undefined", async () => {
    const reg = makeRegistry();
    const overlay = await reg.buildSpawnEnv(undefined, { FOO: "bar" });
    expect(overlay).toBeNull();
  });

  it("buildSpawnEnv returns null when credentials cannot resolve", async () => {
    accounts.broken = {
      type: "github",
      authMode: "pat-keychain",
      host: "github.com",
    };
    const reg = makeRegistry();
    const overlay = await reg.buildSpawnEnv("broken", { FOO: "bar" });
    expect(overlay).toBeNull();
  });

  it("materializes the askpass helper at <dataDir>/runtime/git-askpass.sh on first env build", async () => {
    accounts.work = {
      type: "github",
      authMode: "pat-keychain",
      host: "github.com",
    };
    store.seed("git.account.work", "tok");
    const reg = makeRegistry();
    const askpassPath = join(dataDir, __ASKPASS_RELATIVE_PATH_FOR_TEST);
    expect(existsSync(askpassPath)).toBe(false);

    const env = await reg.buildSpawnEnv("work", {});
    expect(env).not.toBeNull();
    expect(existsSync(askpassPath)).toBe(true);
    expect(readFileSync(askpassPath, "utf-8")).toBe(__ASKPASS_BODY_FOR_TEST);
    // mode bits — at least 0700 (executable for the owner)
    const stat = statSync(askpassPath);
    expect(stat.mode & 0o777).toBe(0o700);

    expect(env!.GH_TOKEN).toBe("tok");
    expect(env!.GITHUB_TOKEN).toBe("tok");
    expect(env!.PA_GIT_TOKEN).toBe("tok");
    expect(env!.GIT_ASKPASS).toBe(askpassPath);
    expect(env!.GIT_TERMINAL_PROMPT).toBe("0");
    // No GH_HOST on github.com (default)
    expect(env!.GH_HOST).toBeUndefined();
  });

  it("sets GH_HOST when account host is non-default", async () => {
    accounts.enterprise = {
      type: "github",
      authMode: "pat-keychain",
      host: "ghe.example.com",
    };
    store.seed("git.account.enterprise", "ghe_tok");
    const reg = makeRegistry();
    const env = await reg.buildSpawnEnv("enterprise", {});
    expect(env?.GH_HOST).toBe("ghe.example.com");
  });

  it("listAccounts returns sorted snapshots without secret values", () => {
    accounts.bbb = {
      type: "github",
      authMode: "pat-keychain",
      host: "github.com",
    };
    accounts.aaa = {
      type: "github",
      authMode: "gh-cli-profile",
      ghProfile: "alice",
      host: "github.com",
    };
    const reg = makeRegistry();
    const snapshots = reg.listAccounts();
    expect(snapshots.map((a) => a.alias)).toEqual(["aaa", "bbb"]);
    expect(snapshots[0].ghProfile).toBe("alice");
    // Snapshots never carry token values
    expect(snapshots).not.toContainEqual(
      expect.objectContaining({ token: expect.any(String) }),
    );
  });

  it("listAccounts and getAccount fall back to 'github.com' when host is an empty string", () => {
    accounts.nohost = {
      type: "github",
      authMode: "pat-keychain",
      host: "",
    } as unknown as GitAccountSetting;
    const reg = makeRegistry();
    const snapshot = reg.getAccount("nohost");
    expect(snapshot?.host).toBe("github.com");
    const allSnapshots = reg.listAccounts();
    expect(allSnapshots[0].host).toBe("github.com");
  });

  it("resolveCredentials returns null for an unrecognized authMode at runtime (exhaustiveness guard)", async () => {
    // Force a runtime authMode that matches neither known variant.
    accounts.weirdmode = {
      type: "github",
      authMode: "totally-unknown" as unknown as "pat-keychain",
      host: "github.com",
    };
    const reg = makeRegistry();
    const result = await reg.resolveCredentials("weirdmode");
    expect(result).toBeNull();
  });

  it("materializes the askpass file at most once across repeated buildSpawnEnv calls", async () => {
    accounts.work = {
      type: "github",
      authMode: "pat-keychain",
      host: "github.com",
    };
    store.seed("git.account.work", "tok");
    const reg = makeRegistry();
    await reg.buildSpawnEnv("work", {});
    const askpassPath = join(dataDir, __ASKPASS_RELATIVE_PATH_FOR_TEST);
    const firstMtime = statSync(askpassPath).mtimeMs;
    // Wait a beat so a second mtime would differ if the file were rewritten.
    await new Promise((r) => setTimeout(r, 30));
    await reg.buildSpawnEnv("work", {});
    const secondMtime = statSync(askpassPath).mtimeMs;
    expect(secondMtime).toBe(firstMtime);
  });

  it("materializes a Windows .cmd askpass helper on win32", async () => {
    accounts.work = {
      type: "github",
      authMode: "pat-keychain",
      host: "github.com",
    };
    store.seed("git.account.work", "tok");
    const reg = makeRegistry({ platform: "win32" });
    const askpassPath = join(dataDir, __ASKPASS_WINDOWS_RELATIVE_PATH_FOR_TEST);
    expect(existsSync(askpassPath)).toBe(false);

    const env = await reg.buildSpawnEnv("work", {});
    expect(env).not.toBeNull();
    expect(env!.GIT_ASKPASS).toBe(askpassPath);
    expect(readFileSync(askpassPath, "utf-8")).toBe(
      __ASKPASS_WINDOWS_BODY_FOR_TEST,
    );
  });
});

// ---------------------------------------------------------------------------
// askpassFileExists
// ---------------------------------------------------------------------------
describe("askpassFileExists", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "pa-askpass-exists-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns true for an existing file", () => {
    const filePath = join(tmpDir, "script.sh");
    writeFileSync(filePath, "#!/bin/sh\n", "utf-8");
    expect(askpassFileExists(filePath)).toBe(true);
  });

  it("returns false for a non-existent file", () => {
    const filePath = join(tmpDir, "does-not-exist.sh");
    expect(askpassFileExists(filePath)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// probeGitAccount
// ---------------------------------------------------------------------------
describe("probeGitAccount", () => {
  let dataDir: string;
  let binDir: string;
  let store: FakeSecretStore;
  let broker: SecretBroker;
  let accounts: Record<string, GitAccountSetting>;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "pa-probe-data-"));
    binDir = mkdtempSync(join(tmpdir(), "pa-probe-bin-"));
    store = new FakeSecretStore();
    broker = new SecretBroker(store, { cacheTtlMs: 0 });
    accounts = {};
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(binDir, { recursive: true, force: true });
  });

  function makeRegistry(): GitAccountRegistry {
    return new GitAccountRegistry({
      dataDir,
      secretBroker: broker,
      getAccounts: () => accounts,
    });
  }

  function writeBin(name: string, body: string): string {
    const p = join(binDir, name);
    writeFileSync(p, body, "utf-8");
    chmodSync(p, 0o755);
    return p;
  }

  it("returns unknown_alias when the alias is not registered", async () => {
    const reg = makeRegistry();
    const result = await probeGitAccount(reg, "ghost");
    expect(result).toEqual({ ok: false, reason: "unknown_alias" });
  });

  it("returns no_credential when the alias has no stored token", async () => {
    accounts.work = {
      type: "github",
      authMode: "pat-keychain",
      host: "github.com",
    };
    // No token seeded — resolveCredentials will return null.
    const reg = makeRegistry();
    const result = await probeGitAccount(reg, "work");
    expect(result).toEqual({ ok: false, reason: "no_credential" });
  });

  it("returns ok:true with login when gh succeeds", async () => {
    accounts.work = {
      type: "github",
      authMode: "pat-keychain",
      host: "github.com",
    };
    store.seed("git.account.work", "ghp_TEST_TOKEN");
    const ghBin = writeBin("gh-success.sh", "#!/bin/sh\necho 'johndoe'\n");
    const reg = makeRegistry();
    const result = await probeGitAccount(reg, "work", { ghBin });
    expect(result).toEqual({ ok: true, login: "johndoe", host: "github.com" });
  });

  it("sets GH_HOST in env and returns correct host for GHES accounts", async () => {
    accounts.enterprise = {
      type: "github",
      authMode: "pat-keychain",
      host: "ghe.example.com",
    };
    store.seed("git.account.enterprise", "ghp_GHE_TOKEN");
    const ghBin = writeBin("gh-ghes.sh", "#!/bin/sh\necho 'corp_user'\n");
    const reg = makeRegistry();
    const result = await probeGitAccount(reg, "enterprise", { ghBin });
    expect(result).toEqual({
      ok: true,
      login: "corp_user",
      host: "ghe.example.com",
    });
  });

  it("returns empty_response when gh exits 0 with blank output", async () => {
    accounts.work = {
      type: "github",
      authMode: "pat-keychain",
      host: "github.com",
    };
    store.seed("git.account.work", "ghp_TOKEN");
    const ghBin = writeBin("gh-empty.sh", "#!/bin/sh\necho ''\n");
    const reg = makeRegistry();
    const result = await probeGitAccount(reg, "work", { ghBin });
    expect(result).toEqual({ ok: false, reason: "empty_response" });
  });

  it("returns gh_missing when the gh binary does not exist", async () => {
    accounts.work = {
      type: "github",
      authMode: "pat-keychain",
      host: "github.com",
    };
    store.seed("git.account.work", "ghp_TOKEN");
    const reg = makeRegistry();
    const result = await probeGitAccount(reg, "work", {
      ghBin: join(binDir, "nonexistent-gh-binary"),
    });
    expect(result).toEqual({ ok: false, reason: "gh_missing" });
  });

  it("returns unauthorized when gh exits non-zero with 401 in stderr", async () => {
    accounts.work = {
      type: "github",
      authMode: "pat-keychain",
      host: "github.com",
    };
    store.seed("git.account.work", "ghp_BAD_TOKEN");
    const ghBin = writeBin(
      "gh-401.sh",
      "#!/bin/sh\necho '401 Unauthorized' >&2; exit 1\n",
    );
    const reg = makeRegistry();
    const result = await probeGitAccount(reg, "work", { ghBin });
    expect(result).toEqual({ ok: false, reason: "unauthorized" });
  });

  it("returns not_found when gh exits non-zero with 404 in stderr", async () => {
    accounts.work = {
      type: "github",
      authMode: "pat-keychain",
      host: "github.com",
    };
    store.seed("git.account.work", "ghp_TOKEN");
    const ghBin = writeBin(
      "gh-404.sh",
      "#!/bin/sh\necho '404 Not Found' >&2; exit 1\n",
    );
    const reg = makeRegistry();
    const result = await probeGitAccount(reg, "work", { ghBin });
    expect(result).toEqual({ ok: false, reason: "not_found" });
  });

  it("returns probe_failed for generic non-zero exits", async () => {
    accounts.work = {
      type: "github",
      authMode: "pat-keychain",
      host: "github.com",
    };
    store.seed("git.account.work", "ghp_TOKEN");
    const ghBin = writeBin(
      "gh-generic-fail.sh",
      "#!/bin/sh\necho 'internal server error' >&2; exit 1\n",
    );
    const reg = makeRegistry();
    const result = await probeGitAccount(reg, "work", { ghBin });
    expect(result).toEqual({ ok: false, reason: "probe_failed" });
  });

  it("uses the system gh binary when ghBin is not specified (covers ?? fallback)", async () => {
    accounts.work = {
      type: "github",
      authMode: "pat-keychain",
      host: "github.com",
    };
    store.seed("git.account.work", "ghp_FAKE_TOKEN_INVALID");
    const reg = makeRegistry();
    // No ghBin passed — the ?? "gh" branch is exercised.
    // Outcome depends on whether gh is installed; either way ok === false.
    const result = await probeGitAccount(reg, "work");
    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ensureAskpass catch block — materialization failure is non-fatal
// ---------------------------------------------------------------------------
describe("GitAccountRegistry — ensureAskpass failure is non-fatal", () => {
  let store: FakeSecretStore;
  let broker: SecretBroker;
  let accounts: Record<string, GitAccountSetting>;

  beforeEach(() => {
    store = new FakeSecretStore();
    broker = new SecretBroker(store, { cacheTtlMs: 0 });
    accounts = {};
  });

  it("does not throw and returns a valid env when askpass materialization fails", async () => {
    accounts.work = {
      type: "github",
      authMode: "pat-keychain",
      host: "github.com",
    };
    store.seed("git.account.work", "ghp_TOKEN");

    // Point askpassPath at a location inside a root-owned directory that the
    // unprivileged test process cannot create.  mkdirSync will throw EACCES,
    // which lands in the catch block of ensureAskpass.
    const reg = new GitAccountRegistry({
      dataDir: "/tmp/irrelevant-data-dir",
      secretBroker: broker,
      getAccounts: () => accounts,
      askpassPath: "/this-cannot-be-created-by-tests/git-askpass.sh",
    });

    // buildSpawnEnv must not throw even though materialization fails.
    let env: NodeJS.ProcessEnv | null;
    await expect(
      (async () => {
        env = await reg.buildSpawnEnv("work", {});
      })(),
    ).resolves.toBeUndefined();

    // The env is still returned with the token (materialization is non-fatal).
    expect(env!).not.toBeNull();
    expect(env!.GH_TOKEN).toBe("ghp_TOKEN");
    expect(env!.GITHUB_TOKEN).toBe("ghp_TOKEN");
    expect(env!.PA_GIT_TOKEN).toBe("ghp_TOKEN");
    // GIT_ASKPASS still set to the (unwritable) path — the failure is silent.
    expect(env!.GIT_ASKPASS).toBe(
      "/this-cannot-be-created-by-tests/git-askpass.sh",
    );
  });
});

// ---------------------------------------------------------------------------
// getAskpassPath / resetAskpassForTest helpers
// ---------------------------------------------------------------------------
describe("GitAccountRegistry — getAskpassPath and resetAskpassForTest", () => {
  let innerDataDir: string;
  let innerStore: FakeSecretStore;
  let innerBroker: SecretBroker;
  let innerAccounts: Record<string, GitAccountSetting>;

  beforeEach(() => {
    innerDataDir = mkdtempSync(join(tmpdir(), "pa-askpass-helpers-"));
    innerStore = new FakeSecretStore();
    innerBroker = new SecretBroker(innerStore, { cacheTtlMs: 0 });
    innerAccounts = {};
  });

  afterEach(() => {
    rmSync(innerDataDir, { recursive: true, force: true });
  });

  it("getAskpassPath returns the constructed askpass path", () => {
    const reg = new GitAccountRegistry({
      dataDir: innerDataDir,
      secretBroker: innerBroker,
      getAccounts: () => innerAccounts,
    });
    const expected = join(innerDataDir, __ASKPASS_RELATIVE_PATH_FOR_TEST);
    expect(reg.getAskpassPath()).toBe(expected);
  });

  it("resetAskpassForTest allows ensureAskpass to re-materialize the helper", async () => {
    innerAccounts.work = {
      type: "github",
      authMode: "pat-keychain",
      host: "github.com",
    };
    innerStore.seed("git.account.work", "tok");
    const reg = new GitAccountRegistry({
      dataDir: innerDataDir,
      secretBroker: innerBroker,
      getAccounts: () => innerAccounts,
    });

    // First buildSpawnEnv materializes the askpass file and sets the flag.
    await reg.buildSpawnEnv("work", {});
    const askpassPath = reg.getAskpassPath();
    const firstMtime = statSync(askpassPath).mtimeMs;

    // After reset the latch is cleared, so the next buildSpawnEnv rewrites the file.
    reg.resetAskpassForTest();
    await new Promise((r) => setTimeout(r, 30));
    await reg.buildSpawnEnv("work", {});
    const secondMtime = statSync(askpassPath).mtimeMs;

    // The file was rewritten — mtime must have advanced.
    expect(secondMtime).toBeGreaterThan(firstMtime);
  });
});
