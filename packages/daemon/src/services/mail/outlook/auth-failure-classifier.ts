import type { AuthStatus } from "../provider.js";

export type ClassifiedFailure =
  | { status: "healthy" }
  | { status: "requires_consent"; reason: string }
  | { status: "degraded"; reason: string }
  | { status: "transient"; reason: string };

/**
 * AADSTS error codes that mean "the refresh token will not work without
 * re-consent" — password change, MFA re-prompt, conditional access, etc.
 * Reference: https://learn.microsoft.com/en-us/entra/identity-platform/reference-error-codes
 */
const RECONSENT_AADSTS_CODES = new Set<string>([
  "AADSTS50173", // FreshTokenNeeded — re-authentication required
  "AADSTS700082", // ExpiredOrRevokedRefreshTokenLifetime
  "AADSTS700084", // RefreshTokenExpiredDueToInactivity
  "AADSTS50076", // MFA required — InteractionRequired
  "AADSTS50079", // MFA strong-auth registration required
  "AADSTS50078", // MFA strong-auth required by policy
  "AADSTS65001", // ConsentRequired — admin or user consent needed
  "AADSTS50105", // EntitlementGrantsNotFound — user no longer assigned
  "AADSTS50056", // InvalidPasswordExpiresOnDate — password reset
  "AADSTS530003", // DevicePolicyError — conditional access
  "AADSTS530004", // DeviceCompliancePolicy — conditional access
]);

/**
 * MSAL error names indicating interactive re-auth is required. Note: `error`
 * objects from MSAL include `errorCode` ("invalid_grant") and an `errorMessage`
 * containing the raw AADSTS string ("AADSTS50173: ...") — both are inspected.
 */
const RECONSENT_MSAL_ERROR_NAMES = new Set<string>([
  "InteractionRequiredAuthError",
  "BrowserAuthError", // covers user_cancelled, etc.
]);

const RECONSENT_OAUTH_ERROR_CODES = new Set<string>([
  "invalid_grant", // refresh token rejected
  "interaction_required",
  "consent_required",
  "login_required",
  "mfa_required",
  "invalid_client", // client deleted or disabled
  "unauthorized_client",
]);

export interface ClassifyInput {
  /** MSAL error.name, e.g. "InteractionRequiredAuthError". */
  errorName?: string | null;
  /** MSAL error.errorCode, e.g. "invalid_grant". */
  errorCode?: string | null;
  /** Free-form message — scanned for AADSTS codes. */
  message?: string | null;
  /** HTTP status from a Graph response (when the failure came via Graph). */
  httpStatus?: number | null;
}

/**
 * Map a captured failure to an AuthStatus update. The `transient` outcome
 * means "do not change auth_status; bump consecutive_error_count and let the
 * caller decide whether to flip to degraded."
 */
export function classifyAuthFailure(input: ClassifyInput): ClassifiedFailure {
  const message = input.message ?? "";
  const aadstsMatch = message.match(/AADSTS\d+/);
  const aadstsCode = aadstsMatch ? aadstsMatch[0] : null;

  if (aadstsCode && RECONSENT_AADSTS_CODES.has(aadstsCode)) {
    return { status: "requires_consent", reason: aadstsCode };
  }

  if (input.errorCode && RECONSENT_OAUTH_ERROR_CODES.has(input.errorCode)) {
    return { status: "requires_consent", reason: input.errorCode };
  }

  if (input.errorName && RECONSENT_MSAL_ERROR_NAMES.has(input.errorName)) {
    return { status: "requires_consent", reason: input.errorName };
  }

  if (input.httpStatus === 401 || input.httpStatus === 403) {
    // Graph returned 401/403 but token-refresh layer didn't classify it as
    // re-consent. Could be a permission gap or transient — surface as degraded
    // so the dashboard shows it; bumping consecutive_error_count is the
    // caller's job.
    return { status: "degraded", reason: `http_${input.httpStatus}` };
  }

  if (input.httpStatus && input.httpStatus >= 500) {
    return { status: "transient", reason: `http_${input.httpStatus}` };
  }

  if (input.httpStatus === 429) {
    return { status: "transient", reason: "rate_limited" };
  }

  return { status: "transient", reason: input.errorCode ?? input.errorName ?? "unknown" };
}

export const TRANSIENT_BACKOFF_THRESHOLD = 10;

/**
 * Whether {@link consecutiveErrorCount} has crossed the threshold to flip a
 * `transient` failure into a persistent `degraded` AuthStatus. Mirrors §3.7
 * "5xx > 10 consecutive attempts → degraded".
 */
export function shouldEscalateToDegraded(
  consecutiveErrorCount: number,
  threshold = TRANSIENT_BACKOFF_THRESHOLD,
): boolean {
  return consecutiveErrorCount > threshold;
}

export function effectiveAuthStatus(
  classified: ClassifiedFailure,
  consecutiveErrorCount: number,
): AuthStatus | null {
  if (classified.status === "healthy") return "healthy";
  if (classified.status === "requires_consent") return "requires_consent";
  if (classified.status === "degraded") return "degraded";
  // transient
  if (shouldEscalateToDegraded(consecutiveErrorCount)) return "degraded";
  return null;
}
