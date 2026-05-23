export const SECRET_NAMES = [
  "apiToken",
  "slackBotToken",
  "slackAppToken",
  "telegramBotToken",
  "discordBotToken",
  "notionApiKey",
  "githubToken",
  "githubWebhookSecret",
  "googleCredentialsJson",
  "googleTokenJson",
  "appleCalendarCredentials",
] as const;

export type SecretName = (typeof SECRET_NAMES)[number];

export const INTERNAL_SECRET_NAMES = [
  "encryptedBlobMasterKey",
  // P22 §4 risk #4 — HMAC key for one-time skill-curation run tokens.
  // Rotated on demand; theft requires keychain compromise + active run window.
  "skillCurationRunTokenKey",
] as const;

export type InternalSecretName = (typeof INTERNAL_SECRET_NAMES)[number];

/**
 * Scoped secret families — open-ended secret names whose scope key is
 * supplied at runtime (an alias, an account id, etc.). Each family lives at
 * a typed prefix so the secret store retains type discipline without
 * widening to `string`.
 *
 * - `git.account.<alias>`: PAT for a Git account registered in
 *   `gitAccounts[<alias>]` when its `authMode === "pat-keychain"`. The alias
 *   matches the same regex the dashboard validates (`^[a-z0-9._-]+$`,
 *   ≤ 40 chars), so the keychain entry name stays bounded.
 * - `backend.<id>.api_key`: Provider API key for a backend (claude / codex
 *   / gemini) when the operator opts to use the dashboard's API-key surface
 *   instead of the CLI login / OAuth flow. The `<id>` is a `BackendId` from
 *   `@aitne/shared` and is validated by `isBackendId()` at every
 *   write/read site.
 */
export type ScopedSecretName =
  | `git.account.${string}`
  | `backend.${string}.api_key`;

export type StoredSecretName =
  | SecretName
  | InternalSecretName
  | ScopedSecretName;

const SCOPED_SECRET_PREFIXES = ["git.account.", "backend."] as const;

export function isScopedSecretName(value: string): value is ScopedSecretName {
  return SCOPED_SECRET_PREFIXES.some((prefix) => value.startsWith(prefix));
}

/**
 * Build a scoped secret name from a family + opaque scope key. The scope
 * key is validated against the same character set every API surface uses
 * (`^[a-z0-9._-]+$`); callers that build names from user input must
 * pre-validate via the dashboard route schemas. This helper exists to keep
 * the prefix in one place — do not concatenate by hand at call sites.
 */
export function scopedSecretName(
  family: "git.account",
  scope: string,
): ScopedSecretName {
  return `${family}.${scope}` as ScopedSecretName;
}

/** Build the keychain name for a backend's stored provider API key. */
export function backendApiKeySecretName(backendId: string): ScopedSecretName {
  return `backend.${backendId}.api_key` as ScopedSecretName;
}

