/**
 * Tests for the internal `defaultGhTokenResolver` function inside
 * `git-account-registry.ts`.  Because `defaultGhTokenResolver` is not
 * exported, we exercise it indirectly by constructing a `GitAccountRegistry`
 * WITHOUT injecting a `ghTokenResolver` option — meaning the module-level
 * `defaultGhTokenResolver` is used as the real implementation.
 *
 * We mock the `node:child_process` / `node:util` pair using the same
 * pattern as `git-watcher-enrichment.test.ts` so that `execFileAsync` inside
 * the module is fully controlled by `mockExecFileAsync`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// IMPORTANT: vi.mock() is hoisted by Vitest before any const declarations, so
// a plain `const mockExecFileAsync = vi.fn()` would be in the TDZ when the
// factory runs.  Use vi.hoisted() to lift the mock function into the same
// hoisted scope as vi.mock(), giving it a stable reference the factory can
// close over.
// ---------------------------------------------------------------------------
const { mockExecFileAsync } = vi.hoisted(() => ({
  mockExecFileAsync: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  execFile: vi.fn(), // raw callback form — never called directly in this layer
}));

vi.mock("node:util", () => ({
  promisify: () => mockExecFileAsync,
}));

// Import AFTER mocks are registered.
import { GitAccountRegistry } from "./git-account-registry.js";
import { SecretBroker } from "../secrets/secret-broker.js";
import type { SecretStore } from "../secrets/secret-store.js";
import type { StoredSecretName } from "../secrets/secret-names.js";
import type { GitAccountSetting } from "../settings/runtime-settings.js";

// ---------------------------------------------------------------------------
// Minimal in-memory SecretStore (identical to the one in the sibling test).
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
describe("defaultGhTokenResolver (via GitAccountRegistry without injected resolver)", () => {
  let dataDir: string;
  let store: FakeSecretStore;
  let broker: SecretBroker;
  let accounts: Record<string, GitAccountSetting>;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "pa-resolver-"));
    store = new FakeSecretStore();
    broker = new SecretBroker(store, { cacheTtlMs: 0 });
    accounts = {};
    mockExecFileAsync.mockReset();
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  function makeRegistry(): GitAccountRegistry {
    // No `ghTokenResolver` injected — uses the real defaultGhTokenResolver.
    return new GitAccountRegistry({
      dataDir,
      secretBroker: broker,
      getAccounts: () => accounts,
      // Provide a fixed askpass path so materialization doesn't call real fs in
      // the wrong spot (the tmpdir is fine, but we want deterministic paths).
      askpassPath: join(dataDir, "git-askpass.sh"),
    });
  }

  // -------------------------------------------------------------------------
  // Branch 1: gh-cli-profile with no ghProfile — resolveCredentials returns
  // null because defaultGhTokenResolver returns null immediately without
  // calling execFileAsync.
  // -------------------------------------------------------------------------
  it("returns null when authMode is gh-cli-profile but ghProfile is unset", async () => {
    accounts.noprofile = {
      type: "github",
      authMode: "gh-cli-profile",
      // ghProfile deliberately omitted
      host: "github.com",
    };
    const reg = makeRegistry();
    const result = await reg.resolveCredentials("noprofile");
    expect(result).toBeNull();
    // execFileAsync must NOT have been called — the early-return path fires.
    expect(mockExecFileAsync).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Branch 2: gh-cli-profile with ghProfile set, execFileAsync resolves with
  // a non-empty token — resolveCredentials returns { token, host }.
  // -------------------------------------------------------------------------
  it("returns credentials when execFileAsync resolves with a valid token", async () => {
    accounts.personal = {
      type: "github",
      authMode: "gh-cli-profile",
      ghProfile: "alice",
      host: "github.com",
    };
    mockExecFileAsync.mockResolvedValue({ stdout: "the-real-token\n", stderr: "" });

    const reg = makeRegistry();
    const result = await reg.resolveCredentials("personal");
    expect(result).toEqual({ token: "the-real-token", host: "github.com" });

    // Verify the exact execFileAsync call shape.
    expect(mockExecFileAsync).toHaveBeenCalledOnce();
    expect(mockExecFileAsync).toHaveBeenCalledWith(
      "gh",
      ["auth", "token", "--user", "alice", "--hostname", "github.com"],
      expect.objectContaining({ encoding: "utf-8" }),
    );
  });

  // -------------------------------------------------------------------------
  // Branch 3: execFileAsync throws (e.g. non-zero exit) — returns null.
  // -------------------------------------------------------------------------
  it("returns null when execFileAsync throws", async () => {
    accounts.personal = {
      type: "github",
      authMode: "gh-cli-profile",
      ghProfile: "alice",
      host: "github.com",
    };
    mockExecFileAsync.mockRejectedValue(new Error("Command failed: gh\n401 Bad credentials"));

    const reg = makeRegistry();
    const result = await reg.resolveCredentials("personal");
    expect(result).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Branch 4: execFileAsync resolves with an empty / whitespace-only stdout —
  // `token.length > 0 ? token : null` path → returns null.
  // -------------------------------------------------------------------------
  it("returns null when execFileAsync resolves with an empty stdout", async () => {
    accounts.personal = {
      type: "github",
      authMode: "gh-cli-profile",
      ghProfile: "alice",
      host: "github.com",
    };
    mockExecFileAsync.mockResolvedValue({ stdout: "   \n", stderr: "" });

    const reg = makeRegistry();
    const result = await reg.resolveCredentials("personal");
    expect(result).toBeNull();
  });
});
