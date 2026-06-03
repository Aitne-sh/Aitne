import { describe, expect, it } from "vitest";
import {
  FORBIDDEN_PREFIXES,
  isSecretPath,
  isUnderForbidden,
  normalizeRequestedPath,
  SECRET_ABS_PATTERNS,
} from "./fs.logic.js";

describe("fs.logic — normalizeRequestedPath", () => {
  it("accepts a valid absolute path under the user's home", () => {
    const result = normalizeRequestedPath("/Users/alice/Documents/Obsidian");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.path).toBe("/Users/alice/Documents/Obsidian");
    }
  });

  it("collapses `..` segments before forbidden-prefix checks", () => {
    // `/Users/alice/Documents/../../../etc` resolves to `/etc` and must
    // be rejected by the forbidden-prefix gate after normalisation.
    const result = normalizeRequestedPath("/Users/alice/Documents/../../../etc");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("forbidden_prefix");
    }
  });

  it("rejects relative paths", () => {
    const result = normalizeRequestedPath("Documents/Obsidian");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("relative_path");
    }
  });

  it("rejects empty / whitespace input", () => {
    expect(normalizeRequestedPath("")).toMatchObject({ ok: false, error: "invalid_path" });
    expect(normalizeRequestedPath("   ")).toMatchObject({ ok: false, error: "invalid_path" });
  });

  it("rejects NUL bytes", () => {
    const result = normalizeRequestedPath("/Users/alice/\0evil");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("invalid_path");
    }
  });

  it("rejects non-string input defensively", () => {
    // The route always passes the query string as a string, but the
    // logic helper is also reused by tests / future surfaces.
    // @ts-expect-error — deliberate type violation
    const result = normalizeRequestedPath(null);
    expect(result.ok).toBe(false);
  });

  it("rejects forbidden system prefixes", () => {
    for (const prefix of ["/etc", "/var/log", "/usr/bin", "/System/Library"]) {
      const result = normalizeRequestedPath(prefix);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe("forbidden_prefix");
      }
    }
  });

  it("does not confuse a sibling prefix for a forbidden one (e.g. /etcetera)", () => {
    // `/etcetera` shares a substring with `/etc` but must not be blocked.
    const result = normalizeRequestedPath("/etcetera");
    expect(result.ok).toBe(true);
  });

  it("rejects exact secret-file paths", () => {
    expect(normalizeRequestedPath("/Users/alice/.ssh")).toMatchObject({
      ok: false,
      error: "secret_path",
    });
    expect(normalizeRequestedPath("/Users/alice/.aws/credentials")).toMatchObject({
      ok: false,
      error: "secret_path",
    });
    expect(normalizeRequestedPath("/Users/alice/.netrc")).toMatchObject({
      ok: false,
      error: "secret_path",
    });
    expect(normalizeRequestedPath("/Users/alice/Library/Keychains/login.keychain-db")).toMatchObject({
      ok: false,
      error: "secret_path",
    });
  });

  it("rejects daemon-managed secret surfaces", () => {
    expect(normalizeRequestedPath("/Users/alice/.personal-agent/secrets/foo")).toMatchObject({
      ok: false,
      error: "secret_path",
    });
    expect(normalizeRequestedPath("/Users/alice/.personal-agent/backups/2025-01")).toMatchObject({
      ok: false,
      error: "secret_path",
    });
    expect(normalizeRequestedPath("/Users/alice/.personal-agent/whatsapp/auth")).toMatchObject({
      ok: false,
      error: "secret_path",
    });
  });

  it("rejects .env in any subtree", () => {
    expect(normalizeRequestedPath("/Users/alice/Projects/myapp/.env")).toMatchObject({
      ok: false,
      error: "secret_path",
    });
    expect(normalizeRequestedPath("/Users/alice/Projects/myapp/.env.local")).toMatchObject({
      ok: false,
      error: "secret_path",
    });
  });
});

describe("fs.logic — isSecretPath / isUnderForbidden", () => {
  it("flags id_rsa / id_ed25519 outside of ~/.ssh", () => {
    expect(isSecretPath("/Users/alice/Downloads/id_rsa")).toBe(true);
    expect(isSecretPath("/Users/alice/Downloads/id_ed25519.pub")).toBe(true);
  });

  it("does not flag normal directories", () => {
    expect(isSecretPath("/Users/alice/Documents")).toBe(false);
    expect(isSecretPath("/Users/alice/Obsidian/Vault")).toBe(false);
  });

  it("`.config/gh/hosts.yml` is hidden but `.config/gh` directory itself is fine", () => {
    expect(isSecretPath("/Users/alice/.config/gh/hosts.yml")).toBe(true);
    // The dir itself is not a secret file — listing it gives the user
    // access to non-token files (`.config/gh/config.yml` etc.).
    expect(isSecretPath("/Users/alice/.config/gh")).toBe(false);
  });

  it("isUnderForbidden detects exact matches and prefix descents", () => {
    expect(isUnderForbidden("/etc")).toBe(true);
    expect(isUnderForbidden("/etc/passwd")).toBe(true);
    expect(isUnderForbidden("/Users/alice")).toBe(false);
  });

  it("isUnderForbidden exempts tmpdir subtrees that sit under a forbidden root", () => {
    // `/var/folders/...` matches the `/var` forbidden prefix but is the
    // macOS tmpdir — the exemption must win.
    expect(isUnderForbidden("/var/folders/ab/cd/T/scratch")).toBe(false);
    expect(isUnderForbidden("/private/var/folders/ab/cd/T/scratch")).toBe(
      false,
    );
  });

  it("FORBIDDEN_PREFIXES contains the expected platform roots", () => {
    // Defensive sanity check — if the list shrinks accidentally, the
    // picker would suddenly expose `/etc` etc.
    expect(FORBIDDEN_PREFIXES).toContain("/etc");
    expect(FORBIDDEN_PREFIXES).toContain("/System");
    expect(FORBIDDEN_PREFIXES.length).toBeGreaterThan(5);
  });

  it("SECRET_ABS_PATTERNS is non-empty", () => {
    expect(SECRET_ABS_PATTERNS.length).toBeGreaterThan(0);
  });
});

