import { describe, expect, it } from "vitest";
import {
  classifyImapAuthFailure,
  effectiveImapAuthStatus,
} from "./auth-failure-classifier.js";

describe("classifyImapAuthFailure", () => {
  it("maps AUTHENTICATIONFAILED to requires_consent", () => {
    expect(
      classifyImapAuthFailure({
        message: "[AUTHENTICATIONFAILED] Invalid credentials",
      }),
    ).toEqual({
      status: "requires_consent",
      reason: "authentication_failed",
    });
  });

  it("maps 535 SMTP login failures to requires_consent", () => {
    expect(
      classifyImapAuthFailure({
        responseCode: 535,
        message: "5.7.8 Username and Password not accepted",
      }),
    ).toEqual({
      status: "requires_consent",
      reason: "code_535",
    });
  });

  it("maps 5xx transport failures to degraded", () => {
    expect(classifyImapAuthFailure({ responseCode: 554 })).toEqual({
      status: "degraded",
      reason: "code_554",
    });
  });

  it("keeps 4xx transport failures transient", () => {
    expect(classifyImapAuthFailure({ responseCode: 421 })).toEqual({
      status: "transient",
      reason: "code_421",
    });
  });
});

describe("classifyImapAuthFailure fallback path", () => {
  it("returns transient with errorName when no code or pattern matches", () => {
    expect(classifyImapAuthFailure({ errorName: "ConnectionReset" })).toEqual({
      status: "transient",
      reason: "ConnectionReset",
    });
  });

  it("returns transient with unknown when no errorName provided", () => {
    expect(classifyImapAuthFailure({})).toEqual({
      status: "transient",
      reason: "unknown",
    });
  });
});

describe("effectiveImapAuthStatus", () => {
  it("returns null for transient outcomes", () => {
    expect(
      effectiveImapAuthStatus({
        status: "transient",
        reason: "code_421",
      }),
    ).toBeNull();
  });

  it("passes through degraded/requires_consent", () => {
    expect(
      effectiveImapAuthStatus({
        status: "degraded",
        reason: "code_554",
      }),
    ).toBe("degraded");
    expect(
      effectiveImapAuthStatus({
        status: "requires_consent",
        reason: "code_535",
      }),
    ).toBe("requires_consent");
  });

  it("returns healthy when input is already healthy", () => {
    expect(
      effectiveImapAuthStatus({
        status: "healthy",
      }),
    ).toBe("healthy");
  });
});

