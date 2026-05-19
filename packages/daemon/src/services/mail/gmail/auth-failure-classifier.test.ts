import { describe, expect, it } from "vitest";
import {
  classifyGmailAuthFailure,
  effectiveGmailAuthStatus,
} from "./auth-failure-classifier.js";

describe("classifyGmailAuthFailure", () => {
  it("classifies 401 invalid credentials as requires_consent", () => {
    expect(
      classifyGmailAuthFailure({
        httpStatus: 401,
        reason: "authError",
        message: "Invalid Credentials",
      }),
    ).toEqual({ status: "requires_consent", reason: "authError" });
  });

  it("classifies invalid_grant refresh failures as requires_consent", () => {
    expect(
      classifyGmailAuthFailure({
        errorCode: "invalid_grant",
        message: "Token has been expired or revoked.",
      }),
    ).toEqual({ status: "requires_consent", reason: "invalid_grant" });
  });

  it("classifies domain policy failures as degraded", () => {
    expect(
      classifyGmailAuthFailure({
        httpStatus: 403,
        reason: "domainPolicy",
      }),
    ).toEqual({ status: "degraded", reason: "domainPolicy" });
  });

  it("classifies 429 as transient", () => {
    expect(
      classifyGmailAuthFailure({
        httpStatus: 429,
        reason: "rateLimitExceeded",
      }),
    ).toEqual({ status: "transient", reason: "rateLimitExceeded" });
  });

  it("classifies 429 without reason as transient with rate_limited fallback", () => {
    expect(
      classifyGmailAuthFailure({ httpStatus: 429 }),
    ).toEqual({ status: "transient", reason: "rate_limited" });
  });

  it("uses errorName as fallback reason in requires_consent when no errorCode or reason", () => {
    expect(
      classifyGmailAuthFailure({
        httpStatus: 401,
        errorName: "TokenExpiredError",
      }),
    ).toEqual({ status: "requires_consent", reason: "TokenExpiredError" });
  });

  it("falls back to google_auth_failed when all reason fields are absent", () => {
    expect(
      classifyGmailAuthFailure({ httpStatus: 401 }),
    ).toEqual({ status: "requires_consent", reason: "google_auth_failed" });
  });

  it("classifies 403 without domain-policy reason as degraded with fallback reason", () => {
    expect(
      classifyGmailAuthFailure({
        httpStatus: 403,
        reason: "userRateLimitExceeded",
      }),
    ).toEqual({ status: "degraded", reason: "userRateLimitExceeded" });
  });

  it("classifies 403 with no reason as degraded with forbidden fallback", () => {
    expect(
      classifyGmailAuthFailure({ httpStatus: 403 }),
    ).toEqual({ status: "degraded", reason: "forbidden" });
  });

  it("classifies 5xx status as transient with http_ reason", () => {
    expect(
      classifyGmailAuthFailure({ httpStatus: 503 }),
    ).toEqual({ status: "transient", reason: "http_503" });
  });

  it("classifies unknown errors as transient with unknown fallback", () => {
    expect(
      classifyGmailAuthFailure({}),
    ).toEqual({ status: "transient", reason: "unknown" });
  });

  it("uses errorName as fallback for default transient case", () => {
    expect(
      classifyGmailAuthFailure({ errorName: "NetworkError" }),
    ).toEqual({ status: "transient", reason: "NetworkError" });
  });
});

describe("effectiveGmailAuthStatus", () => {
  it("passes requires_consent through immediately", () => {
    expect(
      effectiveGmailAuthStatus({ status: "requires_consent", reason: "x" }, 0),
    ).toBe("requires_consent");
  });

  it("escalates repeated transient failures to degraded", () => {
    expect(
      effectiveGmailAuthStatus({ status: "transient", reason: "http_503" }, 11),
    ).toBe("degraded");
  });

  it("returns healthy for healthy status", () => {
    expect(
      effectiveGmailAuthStatus({ status: "healthy" }, 0),
    ).toBe("healthy");
  });

  it("returns degraded for degraded status immediately", () => {
    expect(
      effectiveGmailAuthStatus({ status: "degraded", reason: "domainPolicy" }, 0),
    ).toBe("degraded");
  });

  it("returns null for transient below threshold", () => {
    expect(
      effectiveGmailAuthStatus({ status: "transient", reason: "rate_limited" }, 5),
    ).toBeNull();
  });
});
