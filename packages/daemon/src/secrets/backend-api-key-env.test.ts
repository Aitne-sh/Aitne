import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  BACKEND_API_KEY_ENV_VARS,
  captureOriginalShellEnv,
  describeBackendApiKey,
  syncBackendApiKeyToEnv,
} from "./backend-api-key-env.js";
import { SecretBroker } from "./secret-broker.js";
import type { SecretStore } from "./secret-store.js";
import type { StoredSecretName } from "./secret-names.js";

class MemorySecretStore implements SecretStore {
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
}

function makeBroker(): SecretBroker {
  return new SecretBroker(new MemorySecretStore(), { cacheTtlMs: 0 });
}

function freshEnv(): NodeJS.ProcessEnv {
  return {};
}

describe("backend-api-key-env", () => {
  beforeEach(() => {
    // Always reset the module-level snapshot so cases don't leak.
    captureOriginalShellEnv({});
  });

  describe("BACKEND_API_KEY_ENV_VARS", () => {
    it("lists ANTHROPIC_API_KEY for claude", () => {
      expect(BACKEND_API_KEY_ENV_VARS.claude).toEqual(["ANTHROPIC_API_KEY"]);
    });
    it("lists OPENAI_API_KEY for codex", () => {
      expect(BACKEND_API_KEY_ENV_VARS.codex).toEqual(["OPENAI_API_KEY"]);
    });
    it("lists both GEMINI_API_KEY and GOOGLE_API_KEY for gemini", () => {
      expect(BACKEND_API_KEY_ENV_VARS.gemini).toEqual([
        "GEMINI_API_KEY",
        "GOOGLE_API_KEY",
      ]);
    });
    it("lists OPENCODE_SERVER_PASSWORD for opencode", () => {
      expect(BACKEND_API_KEY_ENV_VARS.opencode).toEqual([
        "OPENCODE_SERVER_PASSWORD",
      ]);
    });
  });

  describe("syncBackendApiKeyToEnv", () => {
    it("mirrors keychain value into env when present", async () => {
      const broker = makeBroker();
      await broker.setBackendApiKey("claude", "sk-ant-test-1");
      captureOriginalShellEnv({});
      const env = freshEnv();

      const result = await syncBackendApiKeyToEnv(broker, "claude", env);

      expect(result).toEqual({
        source: "keychain",
        provider: "anthropic",
        changed: true,
      });
      expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-test-1");
    });

    it("falls back to captured shell value when keychain is empty", async () => {
      const broker = makeBroker();
      // Capture shell BEFORE first sync — this is the contract.
      captureOriginalShellEnv({ OPENAI_API_KEY: "sk-shell" });
      const env: NodeJS.ProcessEnv = { OPENAI_API_KEY: "sk-shell" };

      const result = await syncBackendApiKeyToEnv(broker, "codex", env);

      expect(result).toEqual({
        source: "shell",
        provider: null,
        changed: false,
      });
      expect(env.OPENAI_API_KEY).toBe("sk-shell");
    });

    it("clears env when neither keychain nor shell is set", async () => {
      const broker = makeBroker();
      captureOriginalShellEnv({});
      const env: NodeJS.ProcessEnv = { ANTHROPIC_API_KEY: "stale-mirror" };

      const result = await syncBackendApiKeyToEnv(broker, "claude", env);

      expect(result).toEqual({
        source: "none",
        provider: null,
        changed: true,
      });
      expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    });

    it("keychain overrides shell-set env var", async () => {
      const broker = makeBroker();
      await broker.setBackendApiKey("claude", "sk-ant-from-ui");
      captureOriginalShellEnv({ ANTHROPIC_API_KEY: "sk-ant-from-shell" });
      const env: NodeJS.ProcessEnv = { ANTHROPIC_API_KEY: "sk-ant-from-shell" };

      const result = await syncBackendApiKeyToEnv(broker, "claude", env);

      expect(result.source).toBe("keychain");
      expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-from-ui");
    });

    it("after delete from keychain, restores captured shell value", async () => {
      const broker = makeBroker();
      await broker.setBackendApiKey("claude", "sk-ant-from-ui");
      captureOriginalShellEnv({ ANTHROPIC_API_KEY: "sk-ant-from-shell" });
      const env: NodeJS.ProcessEnv = { ANTHROPIC_API_KEY: "sk-ant-from-shell" };

      // First sync: keychain wins.
      await syncBackendApiKeyToEnv(broker, "claude", env);
      expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-from-ui");

      // User clears via UI → keychain delete + re-sync.
      await broker.deleteBackendApiKey("claude");
      const cleared = await syncBackendApiKeyToEnv(broker, "claude", env);

      expect(cleared.source).toBe("shell");
      expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-from-shell");
    });

    it("sets all env var aliases for gemini (both GEMINI_API_KEY and GOOGLE_API_KEY)", async () => {
      const broker = makeBroker();
      await broker.setBackendApiKey("gemini", "AIzaTestKey");
      captureOriginalShellEnv({});
      const env = freshEnv();

      await syncBackendApiKeyToEnv(broker, "gemini", env);

      expect(env.GEMINI_API_KEY).toBe("AIzaTestKey");
      expect(env.GOOGLE_API_KEY).toBe("AIzaTestKey");
    });

    it("treats blank/whitespace-only keychain value as not set", async () => {
      const broker = makeBroker();
      await broker.setBackendApiKey("claude", "   ");
      captureOriginalShellEnv({});
      const env = freshEnv();

      const result = await syncBackendApiKeyToEnv(broker, "claude", env);

      expect(result.source).toBe("none");
      expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    });

    it("reports changed=false on no-op re-sync", async () => {
      const broker = makeBroker();
      await broker.setBackendApiKey("claude", "sk-ant-test");
      captureOriginalShellEnv({});
      const env = freshEnv();

      await syncBackendApiKeyToEnv(broker, "claude", env);
      const second = await syncBackendApiKeyToEnv(broker, "claude", env);

      expect(second.changed).toBe(false);
    });

    it("preserves shell-set Gemini aliases byte-for-byte (different values per alias stay distinct)", async () => {
      // The shell value is the source of truth in the no-keychain case.
      // We must NOT collapse the two aliases to a single canonical value
      // — the operator's exported env is whatever they wanted. The
      // Gemini SDK reads either alias and would have picked one already.
      const broker = makeBroker();
      captureOriginalShellEnv({
        GEMINI_API_KEY: "AIzaPrimary",
        GOOGLE_API_KEY: "AIzaSecondary",
      });
      const env: NodeJS.ProcessEnv = {
        GEMINI_API_KEY: "AIzaPrimary",
        GOOGLE_API_KEY: "AIzaSecondary",
      };

      const result = await syncBackendApiKeyToEnv(broker, "gemini", env);

      expect(result).toEqual({
        source: "shell",
        provider: null,
        changed: false,
      });
      expect(env.GEMINI_API_KEY).toBe("AIzaPrimary");
      expect(env.GOOGLE_API_KEY).toBe("AIzaSecondary");
    });

    it("does not introduce a sibling alias the shell user never set (GOOGLE_API_KEY only)", async () => {
      // Critical regression guard: if the operator only ever exported
      // GOOGLE_API_KEY (e.g. their tooling uses that name), we must not
      // silently introduce a GEMINI_API_KEY they did not set. That
      // would change which env var their downstream tooling sees and
      // could surprise them.
      const broker = makeBroker();
      captureOriginalShellEnv({ GOOGLE_API_KEY: "AIzaFromGoogleVar" });
      const env: NodeJS.ProcessEnv = { GOOGLE_API_KEY: "AIzaFromGoogleVar" };

      const result = await syncBackendApiKeyToEnv(broker, "gemini", env);

      expect(result).toEqual({
        source: "shell",
        provider: null,
        changed: false,
      });
      expect("GEMINI_API_KEY" in env).toBe(false);
      expect(env.GOOGLE_API_KEY).toBe("AIzaFromGoogleVar");
    });

    it("when keychain is set, populates ALL aliases (so SDK reads a consistent value either way)", async () => {
      // Contrast with the shell-set case above. When the operator
      // explicitly opts into the dashboard surface, we own the env
      // shape and populate both aliases so the Gemini CLI / SDK reads
      // the same value regardless of which env name it consults.
      const broker = makeBroker();
      await broker.setBackendApiKey("gemini", "AIzaFromUI");
      captureOriginalShellEnv({});
      const env: NodeJS.ProcessEnv = {};

      const result = await syncBackendApiKeyToEnv(broker, "gemini", env);

      expect(result.source).toBe("keychain");
      expect(env.GEMINI_API_KEY).toBe("AIzaFromUI");
      expect(env.GOOGLE_API_KEY).toBe("AIzaFromUI");
    });

    it("returns 'none' source when captureOriginalShellEnv was never called for this backend", async () => {
      const broker = makeBroker();
      // Deliberately do NOT call captureOriginalShellEnv — the snapshot
      // map is cleared by beforeEach but never repopulated.
      const env: NodeJS.ProcessEnv = {};

      const result = await syncBackendApiKeyToEnv(broker, "claude", env);

      expect(result.source).toBe("none");
    });

    it("defensively clears env vars when no snapshot map entry exists at all (first-call before capture)", async () => {
      // Walks the bottom branch of `syncBackendApiKeyToEnv` — when
      // `originalShellEnvByBackend.get(backendId)` returns undefined
      // because the helper module was loaded but `captureOriginalShellEnv`
      // has never run. Use vi.resetModules + a fresh import so the
      // module-scope Map starts empty, then call sync directly.
      vi.resetModules();
      const fresh = await import("./backend-api-key-env.js");
      const { SecretBroker: FreshBroker } = await import("./secret-broker.js");
      const store = new MemorySecretStore();
      const broker = new FreshBroker(store, { cacheTtlMs: 0 });
      const env: NodeJS.ProcessEnv = {
        ANTHROPIC_API_KEY: "stale-mirror-pre-capture",
      };

      const result = await fresh.syncBackendApiKeyToEnv(broker, "claude", env);

      expect(result).toEqual({ source: "none", provider: null, changed: true });
      // The stale env var was deleted by the defensive clear.
      expect("ANTHROPIC_API_KEY" in env).toBe(false);
    });
  });

  describe("describeBackendApiKey", () => {
    it("reports configured=true with source='keychain' when keychain has a value", async () => {
      const broker = makeBroker();
      await broker.setBackendApiKey("claude", "sk-ant-test");

      const result = await describeBackendApiKey(broker, "claude", {});

      expect(result).toEqual({
        configured: true,
        source: "keychain",
        provider: "anthropic",
        envVarNames: ["ANTHROPIC_API_KEY"],
      });
    });

    it("reports source='shell' when only shell env is set", async () => {
      const broker = makeBroker();
      const env: NodeJS.ProcessEnv = { OPENAI_API_KEY: "sk-shell" };

      const result = await describeBackendApiKey(broker, "codex", env);

      expect(result.configured).toBe(true);
      expect(result.source).toBe("shell");
      expect(result.provider).toBeNull();
    });

    it("reports source='none' when nothing is configured", async () => {
      const broker = makeBroker();

      const result = await describeBackendApiKey(broker, "gemini", {});

      expect(result.configured).toBe(false);
      expect(result.source).toBe("none");
      expect(result.provider).toBeNull();
      expect(result.envVarNames).toEqual(["GEMINI_API_KEY", "GOOGLE_API_KEY"]);
    });

    it("reports OpenCode server config without leaking the password", async () => {
      const broker = makeBroker();
      await broker.setBackendApiKeyConfig("opencode", {
        provider: "opencode-server",
        baseUrl: "http://127.0.0.1:4096",
        username: "opencode",
        password: "secret",
      });

      const result = await describeBackendApiKey(broker, "opencode", {});

      expect(result).toEqual({
        configured: true,
        source: "keychain",
        provider: "opencode-server",
        envVarNames: [
          "OPENCODE_SERVER_USERNAME",
          "OPENCODE_SERVER_PASSWORD",
        ],
      });
      expect(JSON.stringify(result)).not.toContain("secret");
    });

    it("treats whitespace-only keychain and env values as not set", async () => {
      const broker = makeBroker();
      await broker.setBackendApiKey("claude", "   ");
      const env: NodeJS.ProcessEnv = { ANTHROPIC_API_KEY: "  " };

      const result = await describeBackendApiKey(broker, "claude", env);

      expect(result.configured).toBe(false);
      expect(result.source).toBe("none");
    });

    it("never returns the secret value", async () => {
      const broker = makeBroker();
      await broker.setBackendApiKey("claude", "sk-ant-do-not-leak");

      const result = await describeBackendApiKey(broker, "claude", {});

      // Type-level guarantee: the return type has no value field. Run a
      // structural check to ensure no value-shaped property leaks in.
      expect(JSON.stringify(result)).not.toContain("sk-ant-do-not-leak");
    });
  });

  describe("captureOriginalShellEnv", () => {
    it("clears prior snapshot on re-capture", async () => {
      const broker = makeBroker();

      captureOriginalShellEnv({ ANTHROPIC_API_KEY: "sk-first" });
      captureOriginalShellEnv({});
      const env = freshEnv();

      const result = await syncBackendApiKeyToEnv(broker, "claude", env);

      expect(result.source).toBe("none");
      expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    });

    it("uses process.env by default when no env arg is provided", () => {
      // Smoke test — we don't want to mutate the real process.env, so
      // just verify the function can be called without args and returns.
      expect(() => captureOriginalShellEnv()).not.toThrow();
    });
  });

  // ── Backwards-compatibility / no-regression suite ────────────────
  // The whole point of this feature is that operators who never touch
  // the new UI keep the existing CLI-login / OAuth flow, byte-for-byte
  // unchanged. These tests pin that contract by simulating the exact
  // sequence the daemon executes at startup.
  describe("fallback safety — does not break existing CLI/OAuth auth", () => {
    it("fresh install (no keychain, no shell): process.env stays untouched, source='none'", async () => {
      const broker = makeBroker();
      captureOriginalShellEnv({}); // simulate fresh install — no shell key
      const env: NodeJS.ProcessEnv = {}; // mirrors a fresh process.env

      for (const backendId of ["claude", "codex", "gemini"] as const) {
        const result = await syncBackendApiKeyToEnv(broker, backendId, env);
        expect(result).toEqual({
          source: "none",
          provider: null,
          changed: false,
        });
      }

      // Critical regression guard: not a single API-key env var was
      // introduced. checkAuthDetailed() in each backend reads
      // process.env.ANTHROPIC_API_KEY etc. and falls through to the CLI
      // login / OAuth path when undefined — the unchanged behaviour.
      expect("ANTHROPIC_API_KEY" in env).toBe(false);
      expect("OPENAI_API_KEY" in env).toBe(false);
      expect("GEMINI_API_KEY" in env).toBe(false);
      expect("GOOGLE_API_KEY" in env).toBe(false);
    });

    it("existing shell env, no keychain: the shell value is preserved byte-for-byte", async () => {
      // Simulates the long-standing "I exported ANTHROPIC_API_KEY in my
      // shell before launching the daemon" workflow. After sync,
      // process.env must be byte-identical to what the operator set —
      // otherwise the existing API-key auth path silently changes shape.
      const broker = makeBroker();
      const original: NodeJS.ProcessEnv = {
        ANTHROPIC_API_KEY: "sk-ant-api03-shell-original",
        OPENAI_API_KEY: "sk-openai-shell-original",
        GEMINI_API_KEY: "AIza-shell-original",
        // Note: the operator only set GEMINI_API_KEY. We must NOT
        // silently introduce GOOGLE_API_KEY for them.
      };
      captureOriginalShellEnv(original);
      const env: NodeJS.ProcessEnv = { ...original };

      for (const backendId of ["claude", "codex", "gemini"] as const) {
        const result = await syncBackendApiKeyToEnv(broker, backendId, env);
        expect(result).toEqual({
          source: "shell",
          provider: null,
          changed: false,
        });
      }

      // The post-sync env is byte-identical to the original shell env.
      // No new keys, no removed keys, no value changes.
      expect(env).toEqual(original);
    });

    it("describeBackendApiKey reports 'none' on fresh install (used by the dashboard's GET endpoint)", async () => {
      const broker = makeBroker();
      // No capture, no env, no keychain — the absolute baseline.
      const claude = await describeBackendApiKey(broker, "claude", {});
      const codex = await describeBackendApiKey(broker, "codex", {});
      const gemini = await describeBackendApiKey(broker, "gemini", {});
      const opencode = await describeBackendApiKey(broker, "opencode", {});

      expect(claude.configured).toBe(false);
      expect(codex.configured).toBe(false);
      expect(gemini.configured).toBe(false);
      expect(opencode.configured).toBe(false);
      // The dashboard panel renders "Falling back to CLI login / OAuth"
      // for source='none' — preserving the original UX for users who
      // never touch the new feature.
      expect(claude.source).toBe("none");
      expect(codex.source).toBe("none");
      expect(gemini.source).toBe("none");
      expect(opencode.source).toBe("none");
    });

    it("a user who never opens the panel sees zero behavioural change", async () => {
      // Walk the actual startup sequence index.ts executes:
      //   1. captureOriginalShellEnv()
      //   2. sync each backend
      // For a user who has not configured anything, the post-sync
      // process.env must equal the pre-sync process.env — otherwise the
      // existing checkAuthDetailed() / SDK / CLI behaviour drifts.
      const broker = makeBroker();
      const before: NodeJS.ProcessEnv = {
        // A user with no API key but with a normal shell — PATH, HOME, etc.
        PATH: "/usr/bin:/bin",
        HOME: "/Users/test",
      };
      const env: NodeJS.ProcessEnv = { ...before };

      captureOriginalShellEnv(env);
      for (const backendId of ["claude", "codex", "gemini", "opencode"] as const) {
        await syncBackendApiKeyToEnv(broker, backendId, env);
      }

      // Byte-identical compare. Anything else means we leaked an env
      // mutation into a user's shell that they did not ask for.
      expect(env).toEqual(before);
    });

    it("a user who clears their UI key falls back to CLI auth, NOT to a stale mirrored value", async () => {
      // Regression guard for the 'set then clear' loop. The clear path
      // must remove the env var so checkAuthDetailed() falls through to
      // the CLI login / OAuth check — same as if the key was never set.
      const broker = makeBroker();
      captureOriginalShellEnv({}); // no shell fallback
      const env: NodeJS.ProcessEnv = {};

      // 1. Set
      await broker.setBackendApiKey("claude", "sk-ant-api03-" + "X".repeat(40));
      await syncBackendApiKeyToEnv(broker, "claude", env);
      expect(env.ANTHROPIC_API_KEY).toBeDefined();

      // 2. Clear
      await broker.deleteBackendApiKey("claude");
      const cleared = await syncBackendApiKeyToEnv(broker, "claude", env);

      // Critical: env var is GONE, not just set to "". A bare existence
      // check is what the cores' `process.env.ANTHROPIC_API_KEY?.trim()`
      // depends on to fall through to the OAuth branch.
      expect(env.ANTHROPIC_API_KEY).toBeUndefined();
      expect("ANTHROPIC_API_KEY" in env).toBe(false);
      expect(cleared.source).toBe("none");
    });
  });

  // ── Cloud-provider modes ────────────────────────────────────────
  // Claude Code's SDK supports three cloud-hosted Anthropic deployments
  // (Bedrock / Vertex / Foundry); Gemini CLI supports Vertex AI. Each
  // is signaled by documented env flags. The sync path treats them as
  // alternative keychain configs that mutually exclude direct API keys.

  describe("cloud providers — Bedrock (access_key auth)", () => {
    it("sets the access-key vars + region; clears ANTHROPIC_API_KEY", async () => {
      const broker = makeBroker();
      await broker.setBackendApiKeyConfig("claude", {
        provider: "bedrock",
        authMode: "access_key",
        awsAccessKeyId: "AKIAEXAMPLEEXAMPLE",
        awsSecretAccessKey: "secretkey/secretkey/secretkey/secretkey",
        awsRegion: "us-east-1",
      });
      captureOriginalShellEnv({});
      const env: NodeJS.ProcessEnv = {};

      const result = await syncBackendApiKeyToEnv(broker, "claude", env);

      expect(result).toEqual({
        source: "keychain",
        provider: "bedrock",
        changed: true,
      });
      expect(env.CLAUDE_CODE_USE_BEDROCK).toBe("1");
      expect(env.AWS_ACCESS_KEY_ID).toBe("AKIAEXAMPLEEXAMPLE");
      expect(env.AWS_SECRET_ACCESS_KEY).toBe(
        "secretkey/secretkey/secretkey/secretkey",
      );
      expect(env.AWS_REGION).toBe("us-east-1");
      expect(env.AWS_SESSION_TOKEN).toBeUndefined();
      expect("ANTHROPIC_API_KEY" in env).toBe(false);
      // Other auth-mode env vars must NOT be set when using access_key
      expect("AWS_BEARER_TOKEN_BEDROCK" in env).toBe(false);
      expect("AWS_PROFILE" in env).toBe(false);
    });

    it("includes optional AWS_SESSION_TOKEN when supplied", async () => {
      const broker = makeBroker();
      await broker.setBackendApiKeyConfig("claude", {
        provider: "bedrock",
        authMode: "access_key",
        awsAccessKeyId: "ASIAEXAMPLEEXAMPLE",
        awsSecretAccessKey: "secret/secret/secret/secret/secret/secret",
        awsSessionToken: "FQoGZXIvYXdzEF",
        awsRegion: "us-west-2",
      });
      captureOriginalShellEnv({});
      const env: NodeJS.ProcessEnv = {};
      await syncBackendApiKeyToEnv(broker, "claude", env);
      expect(env.AWS_SESSION_TOKEN).toBe("FQoGZXIvYXdzEF");
    });
  });

  describe("cloud providers — Bedrock (bearer_token auth)", () => {
    it("sets only AWS_BEARER_TOKEN_BEDROCK + AWS_REGION", async () => {
      const broker = makeBroker();
      await broker.setBackendApiKeyConfig("claude", {
        provider: "bedrock",
        authMode: "bearer_token",
        awsBearerTokenBedrock: "bedrock-key-xxx",
        awsRegion: "us-east-1",
      });
      captureOriginalShellEnv({});
      const env: NodeJS.ProcessEnv = {};
      await syncBackendApiKeyToEnv(broker, "claude", env);

      expect(env.AWS_BEARER_TOKEN_BEDROCK).toBe("bedrock-key-xxx");
      expect(env.CLAUDE_CODE_USE_BEDROCK).toBe("1");
      expect(env.AWS_REGION).toBe("us-east-1");
      // The other-mode vars must not be populated
      expect("AWS_ACCESS_KEY_ID" in env).toBe(false);
      expect("AWS_SECRET_ACCESS_KEY" in env).toBe(false);
      expect("AWS_PROFILE" in env).toBe(false);
    });
  });

  describe("cloud providers — Bedrock (profile auth)", () => {
    it("sets only AWS_PROFILE + AWS_REGION", async () => {
      const broker = makeBroker();
      await broker.setBackendApiKeyConfig("claude", {
        provider: "bedrock",
        authMode: "profile",
        awsProfile: "my-sso-profile",
        awsRegion: "us-east-1",
      });
      captureOriginalShellEnv({});
      const env: NodeJS.ProcessEnv = {};
      await syncBackendApiKeyToEnv(broker, "claude", env);

      expect(env.AWS_PROFILE).toBe("my-sso-profile");
      expect(env.AWS_REGION).toBe("us-east-1");
      expect("AWS_ACCESS_KEY_ID" in env).toBe(false);
      expect("AWS_BEARER_TOKEN_BEDROCK" in env).toBe(false);
    });

    it("switching auth modes clears the previous mode's vars", async () => {
      const broker = makeBroker();
      captureOriginalShellEnv({});
      const env: NodeJS.ProcessEnv = {};

      // 1. Start in access_key mode
      await broker.setBackendApiKeyConfig("claude", {
        provider: "bedrock",
        authMode: "access_key",
        awsAccessKeyId: "AKIAFIRST",
        awsSecretAccessKey: "secret",
        awsRegion: "us-east-1",
      });
      await syncBackendApiKeyToEnv(broker, "claude", env);
      expect(env.AWS_ACCESS_KEY_ID).toBe("AKIAFIRST");

      // 2. Switch to bearer_token — the access-key vars must clear.
      await broker.setBackendApiKeyConfig("claude", {
        provider: "bedrock",
        authMode: "bearer_token",
        awsBearerTokenBedrock: "k",
        awsRegion: "us-east-1",
      });
      await syncBackendApiKeyToEnv(broker, "claude", env);

      expect(env.AWS_BEARER_TOKEN_BEDROCK).toBe("k");
      expect("AWS_ACCESS_KEY_ID" in env).toBe(false);
      expect("AWS_SECRET_ACCESS_KEY" in env).toBe(false);
    });
  });

  describe("cloud providers — Vertex (Claude)", () => {
    it("sets vertex flag + project + region; no GOOGLE_APPLICATION_CREDENTIALS_JSON (file path only)", async () => {
      const broker = makeBroker();
      await broker.setBackendApiKeyConfig("claude", {
        provider: "vertex",
        projectId: "my-gcp-project",
        region: "us-east5",
      });
      captureOriginalShellEnv({});
      const env: NodeJS.ProcessEnv = {};

      const result = await syncBackendApiKeyToEnv(broker, "claude", env);

      expect(result.provider).toBe("vertex");
      expect(env.CLAUDE_CODE_USE_VERTEX).toBe("1");
      expect(env.ANTHROPIC_VERTEX_PROJECT_ID).toBe("my-gcp-project");
      expect(env.CLOUD_ML_REGION).toBe("us-east5");
      // CRITICAL: GOOGLE_APPLICATION_CREDENTIALS is unset (no file
      // configured); Anthropic SDK will fall through to ADC.
      expect("GOOGLE_APPLICATION_CREDENTIALS" in env).toBe(false);
      // The previously-shipped fake inline-JSON env var must NOT be populated.
      expect("GOOGLE_APPLICATION_CREDENTIALS_JSON" in env).toBe(false);
    });

    it("credentialsFile path maps to GOOGLE_APPLICATION_CREDENTIALS", async () => {
      const broker = makeBroker();
      await broker.setBackendApiKeyConfig("claude", {
        provider: "vertex",
        projectId: "my-gcp-project",
        region: "us-east5",
        credentialsFile: "/Users/me/keys/sa.json",
      });
      captureOriginalShellEnv({});
      const env: NodeJS.ProcessEnv = {};

      await syncBackendApiKeyToEnv(broker, "claude", env);

      expect(env.GOOGLE_APPLICATION_CREDENTIALS).toBe(
        "/Users/me/keys/sa.json",
      );
    });
  });

  describe("cloud providers — Foundry", () => {
    it("resource form populates ANTHROPIC_FOUNDRY_RESOURCE (not the old ENDPOINT name)", async () => {
      const broker = makeBroker();
      await broker.setBackendApiKeyConfig("claude", {
        provider: "foundry",
        resource: "my-foundry-resource",
        apiKey: "foundry-secret",
      });
      captureOriginalShellEnv({});
      const env: NodeJS.ProcessEnv = {};

      const result = await syncBackendApiKeyToEnv(broker, "claude", env);

      expect(result.provider).toBe("foundry");
      expect(env.CLAUDE_CODE_USE_FOUNDRY).toBe("1");
      expect(env.ANTHROPIC_FOUNDRY_RESOURCE).toBe("my-foundry-resource");
      expect(env.ANTHROPIC_FOUNDRY_API_KEY).toBe("foundry-secret");
      expect("ANTHROPIC_FOUNDRY_BASE_URL" in env).toBe(false);
      // The previously-invented env var name must not appear.
      expect("ANTHROPIC_FOUNDRY_ENDPOINT" in env).toBe(false);
    });

    it("baseUrl form populates ANTHROPIC_FOUNDRY_BASE_URL; API key optional", async () => {
      const broker = makeBroker();
      await broker.setBackendApiKeyConfig("claude", {
        provider: "foundry",
        baseUrl: "https://my.azure.com/anthropic",
      });
      captureOriginalShellEnv({});
      const env: NodeJS.ProcessEnv = {};

      await syncBackendApiKeyToEnv(broker, "claude", env);

      expect(env.ANTHROPIC_FOUNDRY_BASE_URL).toBe(
        "https://my.azure.com/anthropic",
      );
      // No API key supplied → relying on Azure DefaultAzureCredential.
      expect("ANTHROPIC_FOUNDRY_API_KEY" in env).toBe(false);
      expect("ANTHROPIC_FOUNDRY_RESOURCE" in env).toBe(false);
    });
  });

  describe("cloud providers — Gemini Vertex AI", () => {
    it("ADC mode sets project + location + flag (no credentials env)", async () => {
      const broker = makeBroker();
      await broker.setBackendApiKeyConfig("gemini", {
        provider: "gemini-vertex",
        authMode: "adc",
        projectId: "my-gcp-project",
        location: "us-central1",
      });
      captureOriginalShellEnv({});
      const env: NodeJS.ProcessEnv = {};

      const result = await syncBackendApiKeyToEnv(broker, "gemini", env);

      expect(result.provider).toBe("gemini-vertex");
      expect(env.GOOGLE_GENAI_USE_VERTEXAI).toBe("true");
      expect(env.GOOGLE_CLOUD_PROJECT).toBe("my-gcp-project");
      expect(env.GOOGLE_CLOUD_LOCATION).toBe("us-central1");
      // ADC mode: no credentials file or API key
      expect("GOOGLE_APPLICATION_CREDENTIALS" in env).toBe(false);
      expect("GOOGLE_API_KEY" in env).toBe(false);
      expect("GEMINI_API_KEY" in env).toBe(false);
    });

    it("api_key mode sets GOOGLE_API_KEY only — never GEMINI_API_KEY", async () => {
      const broker = makeBroker();
      await broker.setBackendApiKeyConfig("gemini", {
        provider: "gemini-vertex",
        authMode: "api_key",
        projectId: "my-gcp-project",
        location: "us-central1",
        apiKey: "AIzaVertexKey",
      });
      captureOriginalShellEnv({});
      const env: NodeJS.ProcessEnv = {};

      await syncBackendApiKeyToEnv(broker, "gemini", env);

      expect(env.GOOGLE_API_KEY).toBe("AIzaVertexKey");
      // GEMINI_API_KEY is reserved for direct-API auth; routing through
      // Vertex sets only GOOGLE_API_KEY (per Vertex API key conventions).
      expect("GEMINI_API_KEY" in env).toBe(false);
      expect(env.GOOGLE_GENAI_USE_VERTEXAI).toBe("true");
    });

    it("switching from direct google → gemini-vertex clears the dual-alias direct key", async () => {
      const broker = makeBroker();
      captureOriginalShellEnv({});
      const env: NodeJS.ProcessEnv = {};

      await broker.setBackendApiKeyConfig("gemini", {
        provider: "google",
        apiKey: "AIzaDirect",
      });
      await syncBackendApiKeyToEnv(broker, "gemini", env);
      expect(env.GEMINI_API_KEY).toBe("AIzaDirect");
      expect(env.GOOGLE_API_KEY).toBe("AIzaDirect");

      await broker.setBackendApiKeyConfig("gemini", {
        provider: "gemini-vertex",
        authMode: "adc",
        projectId: "p",
        location: "us-central1",
      });
      await syncBackendApiKeyToEnv(broker, "gemini", env);

      // The direct-API GEMINI_API_KEY must be cleared on switch.
      expect("GEMINI_API_KEY" in env).toBe(false);
      // ADC has no GOOGLE_API_KEY either — must be cleared.
      expect("GOOGLE_API_KEY" in env).toBe(false);
      expect(env.GOOGLE_GENAI_USE_VERTEXAI).toBe("true");
    });
  });

  describe("Cloud model pinning + Bedrock Mantle (env-mirror integration)", () => {
    it("Bedrock pinned models flow through to ANTHROPIC_DEFAULT_*_MODEL", async () => {
      const broker = makeBroker();
      await broker.setBackendApiKeyConfig("claude", {
        provider: "bedrock",
        authMode: "bearer_token",
        awsBearerTokenBedrock: "k",
        awsRegion: "us-east-1",
        defaultOpusModel: "us.anthropic.claude-opus-4-7",
        defaultSonnetModel: "us.anthropic.claude-sonnet-4-6",
        defaultHaikuModel: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
      });
      captureOriginalShellEnv({});
      const env: NodeJS.ProcessEnv = {};

      await syncBackendApiKeyToEnv(broker, "claude", env);

      expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe(
        "us.anthropic.claude-opus-4-7",
      );
      expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe(
        "us.anthropic.claude-sonnet-4-6",
      );
      expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe(
        "us.anthropic.claude-haiku-4-5-20251001-v1:0",
      );
    });

    it("Bedrock Mantle flag propagates to CLAUDE_CODE_USE_MANTLE", async () => {
      const broker = makeBroker();
      await broker.setBackendApiKeyConfig("claude", {
        provider: "bedrock",
        authMode: "bearer_token",
        awsBearerTokenBedrock: "k",
        awsRegion: "us-east-1",
        useMantle: true,
        skipMantleAuth: true,
      });
      captureOriginalShellEnv({});
      const env: NodeJS.ProcessEnv = {};

      await syncBackendApiKeyToEnv(broker, "claude", env);

      expect(env.CLAUDE_CODE_USE_MANTLE).toBe("1");
      expect(env.CLAUDE_CODE_SKIP_MANTLE_AUTH).toBe("1");
      expect(env.CLAUDE_CODE_USE_BEDROCK).toBe("1");
    });

    it("switching cloud → direct API clears the pinned model env vars", async () => {
      const broker = makeBroker();
      captureOriginalShellEnv({});
      const env: NodeJS.ProcessEnv = {};

      await broker.setBackendApiKeyConfig("claude", {
        provider: "vertex",
        projectId: "p",
        region: "us-east5",
        defaultOpusModel: "claude-opus-4-7",
      });
      await syncBackendApiKeyToEnv(broker, "claude", env);
      expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe("claude-opus-4-7");

      await broker.setBackendApiKeyConfig("claude", {
        provider: "anthropic",
        apiKey: "sk-ant-api03-" + "Z".repeat(40),
      });
      await syncBackendApiKeyToEnv(broker, "claude", env);

      // Pinned model from previous Vertex setup must be cleared on the
      // switch back to direct API.
      expect("ANTHROPIC_DEFAULT_OPUS_MODEL" in env).toBe(false);
      expect("CLAUDE_CODE_USE_VERTEX" in env).toBe(false);
      expect(env.ANTHROPIC_API_KEY).toBeDefined();
    });
  });

  describe("Codex Azure OpenAI — env-mirror + config.toml materialization", () => {
    it("with dataDir wired: writes config.toml + sets CODEX_HOME + AZURE_OPENAI_API_KEY", async () => {
      const fs = await import("node:fs");
      const os = await import("node:os");
      const path = await import("node:path");
      const dataDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "aitne-azure-mirror-"),
      );
      try {
        const broker = makeBroker();
        await broker.setBackendApiKeyConfig("codex", {
          provider: "azure-openai",
          resource: "my-resource",
          apiKey: "azure-secret",
        });
        captureOriginalShellEnv({});
        const env: NodeJS.ProcessEnv = {};

        await syncBackendApiKeyToEnv(broker, "codex", env, { dataDir });

        expect(env.AZURE_OPENAI_API_KEY).toBe("azure-secret");
        expect(env.CODEX_HOME).toBe(path.join(dataDir, "codex-home"));
        const tomlPath = path.join(env.CODEX_HOME!, "config.toml");
        expect(fs.existsSync(tomlPath)).toBe(true);
        expect(fs.readFileSync(tomlPath, "utf-8")).toContain(
          "[model_providers.azure]",
        );
      } finally {
        fs.rmSync(dataDir, { recursive: true, force: true });
      }
    });

    it("switching azure → openai clears CODEX_HOME and removes config.toml", async () => {
      const fs = await import("node:fs");
      const os = await import("node:os");
      const path = await import("node:path");
      const dataDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "aitne-azure-switch-"),
      );
      try {
        const broker = makeBroker();
        captureOriginalShellEnv({});
        const env: NodeJS.ProcessEnv = {};

        // 1. Start in Azure mode
        await broker.setBackendApiKeyConfig("codex", {
          provider: "azure-openai",
          resource: "x",
          apiKey: "k",
        });
        await syncBackendApiKeyToEnv(broker, "codex", env, { dataDir });
        const tomlPath = path.join(dataDir, "codex-home", "config.toml");
        expect(fs.existsSync(tomlPath)).toBe(true);
        expect(env.CODEX_HOME).toBeDefined();

        // 2. Switch to direct OpenAI
        await broker.setBackendApiKeyConfig("codex", {
          provider: "openai",
          apiKey: "sk-" + "X".repeat(40),
        });
        await syncBackendApiKeyToEnv(broker, "codex", env, { dataDir });

        expect("CODEX_HOME" in env).toBe(false);
        expect("AZURE_OPENAI_API_KEY" in env).toBe(false);
        // config.toml must be gone so a stray CODEX_HOME pointing at the
        // managed dir would not pick up the previous Azure config.
        expect(fs.existsSync(tomlPath)).toBe(false);
      } finally {
        fs.rmSync(dataDir, { recursive: true, force: true });
      }
    });

    it("clearing the codex config tears down the managed config.toml", async () => {
      const fs = await import("node:fs");
      const os = await import("node:os");
      const path = await import("node:path");
      const dataDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "aitne-azure-clear-"),
      );
      try {
        const broker = makeBroker();
        captureOriginalShellEnv({});
        const env: NodeJS.ProcessEnv = {};

        await broker.setBackendApiKeyConfig("codex", {
          provider: "azure-openai",
          resource: "x",
          apiKey: "k",
        });
        await syncBackendApiKeyToEnv(broker, "codex", env, { dataDir });

        await broker.deleteBackendApiKey("codex");
        await syncBackendApiKeyToEnv(broker, "codex", env, { dataDir });

        expect("CODEX_HOME" in env).toBe(false);
        expect(
          fs.existsSync(path.join(dataDir, "codex-home", "config.toml")),
        ).toBe(false);
      } finally {
        fs.rmSync(dataDir, { recursive: true, force: true });
      }
    });
  });

  describe("describeBackendApiKey — cloud provider", () => {
    it("reports the configured provider for a Bedrock bearer_token setup", async () => {
      const broker = makeBroker();
      await broker.setBackendApiKeyConfig("claude", {
        provider: "bedrock",
        authMode: "bearer_token",
        awsBearerTokenBedrock: "k",
        awsRegion: "us-east-1",
      });

      const result = await describeBackendApiKey(broker, "claude", {});

      expect(result.configured).toBe(true);
      expect(result.source).toBe("keychain");
      expect(result.provider).toBe("bedrock");
      expect(result.envVarNames).toEqual(
        expect.arrayContaining([
          "CLAUDE_CODE_USE_BEDROCK",
          "AWS_REGION",
          "AWS_BEARER_TOKEN_BEDROCK",
        ]),
      );
      // Should NOT advertise vars from the OTHER auth modes.
      expect(result.envVarNames).not.toContain("AWS_ACCESS_KEY_ID");
    });
  });
});
