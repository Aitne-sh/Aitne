import { describe, expect, it } from "vitest";
import { ScopedReadSensitiveTokenManager } from "./read-sensitive-token-manager.js";

describe("ScopedReadSensitiveTokenManager", () => {
  it("rotates tokens per scope and invalidates the previous token", () => {
    const manager = new ScopedReadSensitiveTokenManager();

    const first = manager.issue("session-a");
    const second = manager.issue("session-a");

    expect(first).not.toBe(second);
    expect(manager.isValid(first)).toBe(false);
    expect(manager.isValid(second)).toBe(true);
  });

  it("isolates scopes and supports explicit revoke", () => {
    const manager = new ScopedReadSensitiveTokenManager();

    const sessionA = manager.issue("session-a");
    const sessionB = manager.issue("session-b");

    expect(manager.isValid(sessionA)).toBe(true);
    expect(manager.isValid(sessionB)).toBe(true);

    manager.revoke("session-a");
    expect(manager.isValid(sessionA)).toBe(false);
    expect(manager.isValid(sessionB)).toBe(true);
  });
});
