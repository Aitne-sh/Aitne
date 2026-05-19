import { describe, it, expect } from "vitest";
import { isReferrerAllowed, OAuthLoopbackError } from "./oauth-loopback.js";

describe("isReferrerAllowed", () => {
  it("accepts missing header (browsers commonly strip HTTPS→HTTP Referer)", () => {
    expect(isReferrerAllowed(null)).toBe(true);
    expect(isReferrerAllowed(undefined)).toBe(true);
    expect(isReferrerAllowed("")).toBe(true);
  });

  it("accepts Microsoft identity domains", () => {
    expect(
      isReferrerAllowed("https://login.microsoftonline.com/common/oauth2/v2.0/authorize"),
    ).toBe(true);
    expect(isReferrerAllowed("https://login.microsoft.com/")).toBe(true);
    expect(isReferrerAllowed("https://login.live.com/")).toBe(true);
    expect(
      isReferrerAllowed("https://consent.login.microsoftonline.com/consent"),
    ).toBe(true);
  });

  it("rejects unrelated hosts", () => {
    expect(isReferrerAllowed("https://attacker.example.com/")).toBe(false);
    expect(isReferrerAllowed("https://microsoftonline.com.evil.xyz/")).toBe(false);
    expect(isReferrerAllowed("http://127.0.0.1:8080/foo")).toBe(false);
  });

  it("rejects malformed URLs", () => {
    expect(isReferrerAllowed("not a url")).toBe(false);
  });
});

describe("OAuthLoopbackError", () => {
  it("carries the code it was constructed with", () => {
    const err = new OAuthLoopbackError("origin_mismatch", "unexpected");
    expect(err.code).toBe("origin_mismatch");
    expect(err.name).toBe("OAuthLoopbackError");
  });
});
