import type { AuthStatus } from "../provider.js";

export type ImapClassifiedFailure =
  | { status: "healthy" }
  | { status: "requires_consent"; reason: string }
  | { status: "degraded"; reason: string }
  | { status: "transient"; reason: string };

export interface ImapClassifyInput {
  errorName?: string | null;
  message?: string | null;
  responseCode?: number | null;
}

const RECONSENT_PATTERNS = [
  /AUTHENTICATIONFAILED/i,
  /invalid credentials/i,
  /login failed/i,
  /invalid login/i,
  /app password/i,
  /not authenticated/i,
];

const RECONSENT_CODES = new Set<number>([534, 535]);

export function classifyImapAuthFailure(
  input: ImapClassifyInput,
): ImapClassifiedFailure {
  const message = input.message ?? "";
  if (
    (input.responseCode !== null &&
      input.responseCode !== undefined &&
      RECONSENT_CODES.has(input.responseCode)) ||
    RECONSENT_PATTERNS.some((pattern) => pattern.test(message)) ||
    input.errorName === "AuthError"
  ) {
    return {
      status: "requires_consent",
      reason:
        input.responseCode !== null && input.responseCode !== undefined
          ? `code_${input.responseCode}`
          : input.errorName ?? "authentication_failed",
    };
  }

  if (
    input.responseCode !== null &&
    input.responseCode !== undefined &&
    input.responseCode >= 500
  ) {
    return {
      status: "degraded",
      reason: `code_${input.responseCode}`,
    };
  }

  if (
    input.responseCode !== null &&
    input.responseCode !== undefined &&
    input.responseCode >= 400
  ) {
    return {
      status: "transient",
      reason: `code_${input.responseCode}`,
    };
  }

  return {
    status: "transient",
    reason: input.errorName ?? "unknown",
  };
}

export function effectiveImapAuthStatus(
  classified: ImapClassifiedFailure,
): AuthStatus | null {
  if (classified.status === "healthy") return "healthy";
  if (classified.status === "requires_consent") return "requires_consent";
  if (classified.status === "degraded") return "degraded";
  return null;
}

