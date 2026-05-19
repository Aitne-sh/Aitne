import { describe, expect, it } from "vitest";
import {
  classifyAuthFailure,
  effectiveAuthStatus,
  shouldEscalateToDegraded,
  TRANSIENT_BACKOFF_THRESHOLD,
} from "./auth-failure-classifier.js";

describe("classifyAuthFailure", () => {
  it("classifies AADSTS50173 as requires_consent", () => {
    expect(
      classifyAuthFailure({
        message: "AADSTS50173: User must use multi-factor authentication.",
      }),
    ).toEqual({ status: "requires_consent", reason: "AADSTS50173" });
  });

  it("classifies AADSTS700082 (expired refresh token) as requires_consent", () => {
    expect(
      classifyAuthFailure({
        message: "AADSTS700082: The refresh token has expired due to inactivity.",
      }),
    ).toEqual({ status: "requires_consent", reason: "AADSTS700082" });
  });

  it("classifies invalid_grant errorCode as requires_consent", () => {
    expect(
      classifyAuthFailure({ errorCode: "invalid_grant", message: "refresh failed" }),
    ).toEqual({ status: "requires_consent", reason: "invalid_grant" });
  });

  it("classifies InteractionRequiredAuthError errorName as requires_consent", () => {
    expect(
      classifyAuthFailure({ errorName: "InteractionRequiredAuthError" }),
    ).toEqual({ status: "requires_consent", reason: "InteractionRequiredAuthError" });
  });

  it("prefers AADSTS code when both AADSTS and errorCode are present", () => {
    expect(
      classifyAuthFailure({
        errorCode: "invalid_grant",
        message: "AADSTS50173: ...",
      }),
    ).toEqual({ status: "requires_consent", reason: "AADSTS50173" });
  });

  it("ignores unknown AADSTS codes (falls through to default branches)", () => {
    expect(
      classifyAuthFailure({ message: "AADSTS99999: brand new code" }),
    ).toEqual({ status: "transient", reason: "unknown" });
  });

  it("classifies HTTP 401 (without re-consent signal) as degraded", () => {
    expect(classifyAuthFailure({ httpStatus: 401 })).toEqual({
      status: "degraded",
      reason: "http_401",
    });
  });

  it("classifies HTTP 403 as degraded", () => {
    expect(classifyAuthFailure({ httpStatus: 403 })).toEqual({
      status: "degraded",
      reason: "http_403",
    });
  });

  it("classifies HTTP 500 as transient", () => {
    expect(classifyAuthFailure({ httpStatus: 500 })).toEqual({
      status: "transient",
      reason: "http_500",
    });
  });

  it("classifies HTTP 503 as transient", () => {
    expect(classifyAuthFailure({ httpStatus: 503 })).toEqual({
      status: "transient",
      reason: "http_503",
    });
  });

  it("classifies HTTP 429 as transient with rate_limited reason", () => {
    expect(classifyAuthFailure({ httpStatus: 429 })).toEqual({
      status: "transient",
      reason: "rate_limited",
    });
  });

  it("falls through to transient/unknown when nothing matches", () => {
    expect(classifyAuthFailure({})).toEqual({ status: "transient", reason: "unknown" });
  });

  it("uses errorCode in the unknown-transient reason when present", () => {
    expect(classifyAuthFailure({ errorCode: "weird_error" })).toEqual({
      status: "transient",
      reason: "weird_error",
    });
  });
});

describe("shouldEscalateToDegraded", () => {
  it("returns false at the threshold", () => {
    expect(shouldEscalateToDegraded(TRANSIENT_BACKOFF_THRESHOLD)).toBe(false);
  });

  it("returns true above the threshold", () => {
    expect(shouldEscalateToDegraded(TRANSIENT_BACKOFF_THRESHOLD + 1)).toBe(true);
  });

  it("respects a custom threshold", () => {
    expect(shouldEscalateToDegraded(3, 2)).toBe(true);
    expect(shouldEscalateToDegraded(2, 2)).toBe(false);
  });
});

describe("effectiveAuthStatus", () => {
  it("returns healthy for healthy classifications", () => {
    expect(effectiveAuthStatus({ status: "healthy" }, 0)).toBe("healthy");
  });

  it("returns requires_consent for requires_consent classifications", () => {
    expect(
      effectiveAuthStatus({ status: "requires_consent", reason: "x" }, 0),
    ).toBe("requires_consent");
  });

  it("returns degraded for degraded classifications", () => {
    expect(effectiveAuthStatus({ status: "degraded", reason: "x" }, 0)).toBe("degraded");
  });

  it("returns null for transient under threshold (no status change)", () => {
    expect(effectiveAuthStatus({ status: "transient", reason: "x" }, 1)).toBeNull();
  });

  it("flips transient to degraded above threshold", () => {
    expect(
      effectiveAuthStatus({ status: "transient", reason: "x" }, TRANSIENT_BACKOFF_THRESHOLD + 1),
    ).toBe("degraded");
  });
});
