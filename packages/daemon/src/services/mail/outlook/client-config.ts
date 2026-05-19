import type { EncryptedBlobStore } from "../../../secrets/encrypted-blob-store.js";

export const OUTLOOK_CLIENT_CONFIG_BLOB = "mail:outlook:client-config";

/** Per §6.1: BYOA registration. One client config covers all Outlook accounts. */
export interface OutlookClientConfig {
  clientId: string;
  /** Tenant `"common"` works for any org + personal MSA accounts. */
  tenant: string;
}

export class OutlookClientConfigMissingError extends Error {
  readonly code = "outlook_client_config_missing";
  constructor() {
    super(
      "Outlook client config not configured. PUT /api/config/mail/outlook/client-config first.",
    );
    this.name = "OutlookClientConfigMissingError";
  }
}

export function parseOutlookClientConfig(raw: string): OutlookClientConfig {
  const parsed = JSON.parse(raw) as Partial<OutlookClientConfig>;
  if (!parsed || typeof parsed.clientId !== "string" || parsed.clientId.length === 0) {
    throw new Error("Invalid Outlook client config: missing clientId");
  }
  const tenant = typeof parsed.tenant === "string" && parsed.tenant.length > 0
    ? parsed.tenant
    : "common";
  return { clientId: parsed.clientId, tenant };
}

export function serializeOutlookClientConfig(config: OutlookClientConfig): string {
  return JSON.stringify({ clientId: config.clientId, tenant: config.tenant });
}

export async function loadOutlookClientConfig(
  blobStore: EncryptedBlobStore,
): Promise<OutlookClientConfig | null> {
  const raw = await blobStore.readUtf8(OUTLOOK_CLIENT_CONFIG_BLOB);
  if (!raw) return null;
  return parseOutlookClientConfig(raw);
}

export async function saveOutlookClientConfig(
  blobStore: EncryptedBlobStore,
  config: OutlookClientConfig,
): Promise<void> {
  await blobStore.writeUtf8(
    OUTLOOK_CLIENT_CONFIG_BLOB,
    serializeOutlookClientConfig(config),
  );
}

export const OUTLOOK_AUTHORITY_BASE = "https://login.microsoftonline.com";

export function authorityForTenant(tenant: string): string {
  return `${OUTLOOK_AUTHORITY_BASE}/${tenant}`;
}

/**
 * Scopes per §6.1 — Mail.ReadWrite subsumes Mail.Read. `offline_access`
 * is required for refresh-token issuance. SETUP-FLOW-REDESIGN-PLAN §6.1
 * adds `Calendars.ReadWrite` so the same OAuth consent serves both Mail
 * and Calendar; the Calendar wizard step does not trigger a second
 * consent screen when Mail is already authenticated. Pre-release
 * caveat: any cache row written before this change holds a token whose
 * scope set excludes `Calendars.ReadWrite`; first Calendar use will
 * 401 once and the loopback flow re-prompts the user.
 */
export const OUTLOOK_SCOPES: readonly string[] = [
  "offline_access",
  "User.Read",
  "Mail.ReadWrite",
  "Mail.Send",
  "Calendars.ReadWrite",
];

/** Per §4: Azure since 2020 special-cases loopback regardless of port. Use 127.0.0.1, not localhost. */
export const OUTLOOK_LOOPBACK_REDIRECT_HOST = "127.0.0.1";
export const OUTLOOK_LOOPBACK_REDIRECT_PATH = "/callback";

export function buildLoopbackRedirectUri(port: number): string {
  return `http://${OUTLOOK_LOOPBACK_REDIRECT_HOST}:${port}${OUTLOOK_LOOPBACK_REDIRECT_PATH}`;
}
