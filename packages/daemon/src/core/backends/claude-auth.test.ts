/**
 * Peer tests for `./claude-auth.ts` — split out of `claude-code-core.ts`
 * in file-split-plan §8 Tier 2. The pure error-introspection helpers
 * mirror the old `(core as any).isAuthError` / `(core as any).getError*`
 * test coverage that lived in `claude-code-core.test.ts`; we keep both
 * the old test paths (via the class shims) and these direct-on-module
 * tests so the module surface stays exercised even after the shims are
 * eventually deleted.
 *
 * The auth-probe tests cover the cheap presence check (`checkAuth`)
 * with the three branches it can take based on env / cliPath. The
 * detailed-probe (`checkAuthDetailed`) is covered by the existing
 * `claude-code-core.test.ts` integration paths against the class shim;
 * splitting that out further would require mocking `probeApiKeyServerSide`
 * + `readClaudeCredentials`, which is outside the no-behavior-change
 * scope of this Tier 2 extraction.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";

import {
  checkAuth,
  getErrorCode,
  getErrorMessage,
  getErrorStatus,
  getErrorType,
  isAuthError,
} from "./claude-auth.js";

describe("claude-auth.ts pure helpers", () => {
  describe("getErrorStatus", () => {
    it("reads numeric status field", () => {
      expect(getErrorStatus({ status: 401 })).toBe(401);
      expect(getErrorStatus({ status: 500 })).toBe(500);
    });
    it("returns undefined for non-object inputs", () => {
      expect(getErrorStatus(null)).toBeUndefined();
      expect(getErrorStatus("string")).toBeUndefined();
      expect(getErrorStatus(42)).toBeUndefined();
    });
    it("returns undefined when status field is absent", () => {
      expect(getErrorStatus({})).toBeUndefined();
    });
  });

  describe("getErrorCode", () => {
    it("returns string code when present", () => {
      expect(getErrorCode({ code: "rate_limit_exceeded" })).toBe(
        "rate_limit_exceeded",
      );
    });
    it("returns undefined for non-string code (e.g. numeric Node EAI codes)", () => {
      expect(getErrorCode({ code: 500 })).toBeUndefined();
    });
    it("returns undefined for non-object inputs", () => {
      expect(getErrorCode(null)).toBeUndefined();
      expect(getErrorCode("string")).toBeUndefined();
    });
  });

  describe("getErrorType", () => {
    it("returns string type when present", () => {
      expect(getErrorType({ type: "authentication_error" })).toBe(
        "authentication_error",
      );
    });
    it("returns undefined for non-string type", () => {
      expect(getErrorType({ type: { nested: true } })).toBeUndefined();
    });
    it("returns undefined for non-object inputs", () => {
      expect(getErrorType(null)).toBeUndefined();
      expect(getErrorType(undefined)).toBeUndefined();
    });
  });

  describe("getErrorMessage", () => {
    it("returns message from Error instances", () => {
      expect(getErrorMessage(new Error("boom"))).toBe("boom");
    });
    it("returns string inputs verbatim", () => {
      expect(getErrorMessage("plain string")).toBe("plain string");
    });
    it("returns fallback for non-Error non-string inputs", () => {
      expect(getErrorMessage(42)).toBe("Claude backend execution failed");
      expect(getErrorMessage(null)).toBe("Claude backend execution failed");
      expect(getErrorMessage({ message: "ignored" })).toBe(
        "Claude backend execution failed",
      );
    });
  });

  describe("isAuthError", () => {
    it("treats 401 / 403 status as auth error", () => {
      expect(isAuthError({ status: 401 })).toBe(true);
      expect(isAuthError({ status: 403 })).toBe(true);
    });
    it("treats other 4xx as non-auth", () => {
      expect(isAuthError({ status: 400 })).toBe(false);
      expect(isAuthError({ status: 429 })).toBe(false);
    });
    it("treats `code` matching auth/forbidden/unauthorized as auth error", () => {
      expect(isAuthError({ code: "AUTHENTICATION_FAILED" })).toBe(true);
      expect(isAuthError({ code: "forbidden" })).toBe(true);
      expect(isAuthError({ code: "unauthorized" })).toBe(true);
    });
    it("treats `type` matching auth/forbidden/unauthorized as auth error", () => {
      expect(isAuthError({ type: "AuthenticationError" })).toBe(true);
      expect(isAuthError({ type: "forbidden_access" })).toBe(true);
    });
    it("detects auth-shaped messages on Error instances", () => {
      expect(isAuthError(new Error("Unauthorized access"))).toBe(true);
      expect(isAuthError(new Error("Invalid API key"))).toBe(true);
      expect(isAuthError(new Error("login required"))).toBe(true);
    });
    it("returns false for non-auth Errors", () => {
      expect(isAuthError(new Error("connection reset"))).toBe(false);
      expect(isAuthError(new Error("ECONNREFUSED 127.0.0.1:8000"))).toBe(false);
    });
    it("returns false for non-object non-Error inputs without auth keywords", () => {
      expect(isAuthError(null)).toBe(false);
      expect(isAuthError(42)).toBe(false);
    });
  });
});

describe("claude-auth.ts checkAuth presence probe", () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    // Make sure no cloud-provider flags or API key leak across tests.
    delete process.env.CLAUDE_CODE_USE_BEDROCK;
    delete process.env.CLAUDE_CODE_USE_VERTEX;
    delete process.env.CLAUDE_CODE_USE_FOUNDRY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.AWS_REGION;
    delete process.env.ANTHROPIC_VERTEX_PROJECT_ID;
    delete process.env.CLOUD_ML_REGION;
    delete process.env.ANTHROPIC_FOUNDRY_RESOURCE;
    delete process.env.ANTHROPIC_FOUNDRY_BASE_URL;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("returns api_key when ANTHROPIC_API_KEY is a plausible key", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-api-test-key-123456789";
    const result = await checkAuth({ cliPath: null });
    expect(result).toEqual({ ok: true, method: "api_key" });
  });

  it("fails when ANTHROPIC_API_KEY is set but malformed", async () => {
    process.env.ANTHROPIC_API_KEY = "not-an-anthropic-key";
    const result = await checkAuth({ cliPath: "/usr/bin/claude" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("ANTHROPIC_API_KEY");
    }
  });

  it("returns cli_login when neither cloud nor API key is set and cliPath resolves", async () => {
    const result = await checkAuth({ cliPath: "/usr/bin/claude" });
    expect(result).toEqual({ ok: true, method: "cli_login" });
  });

  it("fails with install hint when no cloud, no API key, and no cliPath", async () => {
    const result = await checkAuth({ cliPath: null });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("Claude Code CLI is not installed");
    }
  });

  it("returns bedrock when CLAUDE_CODE_USE_BEDROCK=1 with AWS_REGION set", async () => {
    process.env.CLAUDE_CODE_USE_BEDROCK = "1";
    process.env.AWS_REGION = "us-east-1";
    const result = await checkAuth({ cliPath: null });
    expect(result).toEqual({ ok: true, method: "bedrock" });
  });

  it("fails when CLAUDE_CODE_USE_BEDROCK=1 but AWS_REGION is missing", async () => {
    process.env.CLAUDE_CODE_USE_BEDROCK = "1";
    const result = await checkAuth({ cliPath: null });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("AWS_REGION");
    }
  });

  it("returns vertex when CLAUDE_CODE_USE_VERTEX=1 with project + region", async () => {
    process.env.CLAUDE_CODE_USE_VERTEX = "1";
    process.env.ANTHROPIC_VERTEX_PROJECT_ID = "my-project";
    process.env.CLOUD_ML_REGION = "us-central1";
    const result = await checkAuth({ cliPath: null });
    expect(result).toEqual({ ok: true, method: "vertex" });
  });

  it("returns foundry when CLAUDE_CODE_USE_FOUNDRY=1 with resource", async () => {
    process.env.CLAUDE_CODE_USE_FOUNDRY = "1";
    process.env.ANTHROPIC_FOUNDRY_RESOURCE = "my-foundry-resource";
    const result = await checkAuth({ cliPath: null });
    expect(result).toEqual({ ok: true, method: "foundry" });
  });

  it("fails when CLAUDE_CODE_USE_FOUNDRY=1 with no resource and no base URL", async () => {
    process.env.CLAUDE_CODE_USE_FOUNDRY = "1";
    const result = await checkAuth({ cliPath: null });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("ANTHROPIC_FOUNDRY_RESOURCE");
    }
  });
});
