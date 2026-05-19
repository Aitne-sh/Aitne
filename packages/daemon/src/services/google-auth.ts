export type GoogleCredentialType = "oauth2" | "service_account";

export interface GoogleOAuthClientConfig {
  client_id: string;
  client_secret: string;
  redirect_uris?: string[];
}

export interface GoogleCredentialsDocument extends Record<string, unknown> {
  type?: string;
  installed?: GoogleOAuthClientConfig;
  web?: GoogleOAuthClientConfig;
}

export function parseGoogleCredentialsJson(raw: string): GoogleCredentialsDocument {
  return JSON.parse(raw) as GoogleCredentialsDocument;
}

export function detectGoogleCredentialType(raw: string | null): GoogleCredentialType | null {
  if (!raw) return null;
  try {
    const parsed = parseGoogleCredentialsJson(raw);
    if (parsed.type === "service_account") return "service_account";
    if (parsed.installed || parsed.web) return "oauth2";
    return null;
  } catch {
    return null;
  }
}

export function getGoogleOAuthClientConfig(
  credentials: GoogleCredentialsDocument,
): GoogleOAuthClientConfig | null {
  return credentials.installed ?? credentials.web ?? null;
}

export function mergeGoogleTokenPayload(
  existingRaw: string | null,
  nextTokens: Record<string, unknown>,
): string {
  const existing = existingRaw
    ? JSON.parse(existingRaw) as Record<string, unknown>
    : {};
  const merged: Record<string, unknown> = {
    ...existing,
    ...nextTokens,
  };

  const refreshToken = nextTokens.refresh_token;
  if ((refreshToken === undefined || refreshToken === null || refreshToken === "")
    && existing.refresh_token !== undefined) {
    merged.refresh_token = existing.refresh_token;
  }

  return JSON.stringify(merged);
}
