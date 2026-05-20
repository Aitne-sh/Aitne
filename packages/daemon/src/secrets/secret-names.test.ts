import { describe, expect, it } from "vitest";
import {
  backendApiKeySecretName,
  isScopedSecretName,
  scopedSecretName,
} from "./secret-names.js";

describe("scopedSecretName", () => {
  it("builds a git.account scoped name", () => {
    expect(scopedSecretName("git.account", "personal")).toBe(
      "git.account.personal",
    );
  });
});

describe("backendApiKeySecretName", () => {
  it("builds the keychain name for a backend's stored API key", () => {
    expect(backendApiKeySecretName("claude")).toBe("backend.claude.api_key");
    expect(backendApiKeySecretName("codex")).toBe("backend.codex.api_key");
  });
});

describe("isScopedSecretName", () => {
  it("returns true for both scoped families", () => {
    expect(isScopedSecretName("git.account.personal")).toBe(true);
    expect(isScopedSecretName("backend.claude.api_key")).toBe(true);
  });

  it("returns false for non-scoped names (static + internal)", () => {
    expect(isScopedSecretName("apiToken")).toBe(false);
    expect(isScopedSecretName("encryptedBlobMasterKey")).toBe(false);
    expect(isScopedSecretName("")).toBe(false);
    // Suffix-only does not satisfy the prefix check.
    expect(isScopedSecretName("personal.git.account")).toBe(false);
  });
});
