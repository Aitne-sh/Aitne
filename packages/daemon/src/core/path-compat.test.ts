import { describe, expect, it } from "vitest";
import {
  inferPathFlavor,
  isPathInsideOrEqual,
  jsonStringPathForms,
  shellPathForms,
  slashPath,
  trimTrailingSeparators,
} from "./path-compat.js";

describe("path-compat", () => {
  it("detects Windows paths", () => {
    expect(inferPathFlavor("C:\\Users\\me\\Vault")).toBe("win32");
    expect(inferPathFlavor("\\\\server\\share\\Vault")).toBe("win32");
    expect(inferPathFlavor("/Users/me/Vault")).toBe("posix");
  });

  it("checks containment with segment boundaries on POSIX paths", () => {
    expect(isPathInsideOrEqual("/Users/me/Vault", "/Users/me/Vault/today.md")).toBe(true);
    expect(isPathInsideOrEqual("/Users/me/Vault", "/Users/me/Vaultaneous/today.md")).toBe(false);
  });

  it("checks containment with segment boundaries on Windows paths", () => {
    expect(isPathInsideOrEqual("C:\\Users\\me\\Vault", "C:\\Users\\me\\Vault\\today.md")).toBe(true);
    expect(isPathInsideOrEqual("C:\\Users\\me\\Vault", "C:\\Users\\me\\Vaultaneous\\today.md")).toBe(false);
    expect(isPathInsideOrEqual("C:\\Users\\me\\Vault", "D:\\Vault\\today.md")).toBe(false);
  });

  it("normalizes slashes without changing other text", () => {
    expect(slashPath("C:\\Users\\me\\Vault")).toBe("C:/Users/me/Vault");
  });

  it("builds command-text path forms for Windows home-relative paths", () => {
    const forms = shellPathForms(
      "C:\\Users\\me\\.personal-agent\\context",
      "C:\\Users\\me",
    );
    expect(forms).toContain("C:\\Users\\me\\.personal-agent\\context");
    expect(forms).toContain("C:/Users/me/.personal-agent/context");
    expect(forms).toContain("~\\.personal-agent\\context");
    expect(forms).toContain("~/.personal-agent/context");
    expect(forms).toContain("%USERPROFILE%\\.personal-agent\\context");
    expect(forms).toContain("$env:USERPROFILE\\.personal-agent\\context");
    expect(forms).toContain("$HOME/.personal-agent/context");
  });

  it("builds command-text path forms for POSIX home-relative paths", () => {
    const forms = shellPathForms(
      "/Users/me/.personal-agent/context",
      "/Users/me",
    );
    expect(forms).toContain("/Users/me/.personal-agent/context");
    expect(forms).toContain("~/.personal-agent/context");
    expect(forms).toContain("$HOME/.personal-agent/context");
    expect(forms).toContain("${HOME}/.personal-agent/context");
    // Windows-specific forms must not appear for a POSIX path
    expect(forms).not.toContain(expect.stringContaining("%USERPROFILE%"));
    expect(forms).not.toContain(expect.stringContaining("$env:USERPROFILE"));
  });

  it("omits home-relative forms when absPath is not inside homeDir", () => {
    const forms = shellPathForms("/var/log/app.log", "/Users/me");
    expect(forms).toContain("/var/log/app.log");
    expect(forms).not.toContain(expect.stringContaining("~"));
    expect(forms).not.toContain(expect.stringContaining("$HOME"));
  });

  it("adds JSON-string escaped forms for Windows backslashes", () => {
    const forms = jsonStringPathForms(["C:\\Users\\me\\Vault"]);
    expect(forms).toContain("C:\\\\Users\\\\me\\\\Vault");
  });

  it("trimTrailingSeparators strips trailing separators from non-root paths", () => {
    // POSIX — single trailing slash
    expect(trimTrailingSeparators("/Users/me/vault/", "posix")).toBe("/Users/me/vault");
    // POSIX — multiple trailing slashes
    expect(trimTrailingSeparators("/Users/me/vault///", "posix")).toBe("/Users/me/vault");
    // Windows — single trailing backslash on a non-root path
    expect(trimTrailingSeparators("C:\\Users\\me\\vault\\", "win32")).toBe("C:\\Users\\me\\vault");
    // Windows — mixed trailing separators
    expect(trimTrailingSeparators("C:\\Users\\me\\vault/\\", "win32")).toBe("C:\\Users\\me\\vault");
    // Root paths are left intact regardless of trailing separator inclusion
    expect(trimTrailingSeparators("/", "posix")).toBe("/");
    expect(trimTrailingSeparators("C:\\", "win32")).toBe("C:\\");
  });
});
