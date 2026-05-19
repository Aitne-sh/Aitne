import type { AuthStatus } from "../provider.js";

export type GmailClassifiedFailure =
  | { status: "healthy" }
  | { status: "requires_consent"; reason: string }
  | { status: "degraded"; reason: string }
  | { status: "transient"; reason: string };

export interface GmailClassifyInput {
  errorName?: string | null;
  errorCode?: string | null;
  message?: string | null;
  httpStatus?: number | null;
  reason?: string | null;
}

const RECONSENT_ERROR_CODES = new Set<string>([
  "invalid_grant",
  "invalid_client",
  "access_denied",
  "unauthorized_client",
]);

const RECONSENT_REASONS = new Set<string>([
  "authError",
  "invalidGrant",
  "invalidCredentials",
  "insufficientPermissions",
]);

const DEGRADED_REASONS = new Set<string>(["domainPolicy"]);

const RECONSENT_MESSAGE_PATTERNS = [
  /invalid credentials/i,
  /expired or revoked/i,
  /token has been expired or revoked/i,
  /invalid_grant/i,
  /insufficient authentication scopes/i,
  /reauthori[sz]/i,
];

export const GMAIL_TRANSIENT_BACKOFF_THRESHOLD = 10;

export function classifyGmailAuthFailure(
  input: GmailClassifyInput,
): GmailClassifiedFailure {
  const reason = input.reason ?? null;
  const message = input.message ?? "";

  if (
    (input.errorCode && RECONSENT_ERROR_CODES.has(input.errorCode)) ||
    (reason && RECONSENT_REASONS.has(reason)) ||
    RECONSENT_MESSAGE_PATTERNS.some((pattern) => pattern.test(message)) ||
    input.httpStatus === 401
  ) {
    return {
      status: "requires_consent",
      reason: input.errorCode ?? reason ?? input.errorName ?? "google_auth_failed",
    };
  }

  if (input.httpStatus === 403) {
    if (reason && DEGRADED_REASONS.has(reason)) {
      return { status: "degraded", reason };
    }
    return {
      status: "degraded",
      reason: reason ?? input.errorCode ?? input.errorName ?? "forbidden",
    };
  }

  if (input.httpStatus === 429) {
    return { status: "transient", reason: reason ?? "rate_limited" };
  }

  if (input.httpStatus && input.httpStatus >= 500) {
    return {
      status: "transient",
      reason: reason ?? `http_${input.httpStatus}`,
    };
  }

  return {
    status: "transient",
    reason: input.errorCode ?? reason ?? input.errorName ?? "unknown",
  };
}

export function effectiveGmailAuthStatus(
  classified: GmailClassifiedFailure,
  consecutiveErrorCount: number,
  threshold = GMAIL_TRANSIENT_BACKOFF_THRESHOLD,
): AuthStatus | null {
  if (classified.status === "healthy") return "healthy";
  if (classified.status === "requires_consent") return "requires_consent";
  if (classified.status === "degraded") return "degraded";
  return consecutiveErrorCount > threshold ? "degraded" : null;
}
