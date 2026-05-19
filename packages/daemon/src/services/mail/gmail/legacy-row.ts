import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { LEGACY_GMAIL_BLOB_SENTINEL } from "./gmail-provider.js";
import type { GmailService } from "../../gmail.js";
import type { AuthStatus } from "../provider.js";
import { createLogger } from "../../../logging.js";

const logger = createLogger("mail-legacy-gmail-row");

export interface EnsureLegacyGmailRowResult {
  status:
    | "created"
    | "exists"
    | "no_profile"
    | "service_unavailable";
  accountId?: string;
  email?: string;
}

export interface LegacyGmailAccountStateRegistry {
  updateAuthStatus(
    accountId: string,
    status: AuthStatus,
    lastError?: string | null,
  ): boolean;
  evictProvider(accountId: string): void;
}

/**
 * Ensure the shared-Google-OAuth Gmail identity exists in `mail_accounts` and
 * is owned by the unified `MailPoller`. Fresh installs create the sentinel
 * row with `unified_poll=1`; existing rows are returned as-is.
 */
export async function ensureLegacyGmailRow(
  db: Database.Database,
  gmailService: GmailService,
): Promise<EnsureLegacyGmailRowResult> {
  if (!gmailService.available) {
    return { status: "service_unavailable" };
  }

  const existing = db
    .prepare(
      `SELECT id, email
         FROM mail_accounts
        WHERE secret_blob_name = ?
        LIMIT 1`,
    )
    .get(LEGACY_GMAIL_BLOB_SENTINEL) as
    | {
        id: string;
        email: string;
      }
    | undefined;
  if (existing) {
    return {
      status: "exists",
      accountId: existing.id,
      email: existing.email,
    };
  }

  let email: string | null = null;
  try {
    email = await gmailService.getEmailAddress();
  } catch (err) {
    logger.error({ err }, "Failed to resolve Gmail profile for legacy row");
    return { status: "no_profile" };
  }
  if (!email) {
    logger.warn("Gmail profile returned no email address — skipping legacy row");
    return { status: "no_profile" };
  }

  const id = `gmail-${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const createdAt = new Date().toISOString();

  db.prepare(
    `INSERT INTO mail_accounts (
       id, kind, email, label, auth_type, auth_status,
       secret_blob_name, poll_cursor_json, poll_interval_seconds, idle_enabled,
       unified_poll, active, created_at_utc
     ) VALUES (?, 'gmail', ?, NULL, 'oauth', 'healthy', ?, NULL, 300, 0, 1, 1, ?)`,
  ).run(id, email, LEGACY_GMAIL_BLOB_SENTINEL, createdAt);

  logger.info(
    { accountId: id, email },
    "Legacy Gmail row created (unified_poll=1)",
  );
  return { status: "created", accountId: id, email };
}

export function findLegacyGmailAccountId(
  db: Database.Database,
): string | null {
  const row = db
    .prepare(
      `SELECT id
         FROM mail_accounts
        WHERE secret_blob_name = ?
        LIMIT 1`,
    )
    .get(LEGACY_GMAIL_BLOB_SENTINEL) as { id: string } | undefined;
  return row?.id ?? null;
}

export function syncLegacyGmailAccountState(
  db: Database.Database,
  registry: LegacyGmailAccountStateRegistry,
  options: { available: boolean; error?: string },
): string | null {
  const accountId = findLegacyGmailAccountId(db);
  if (!accountId) return null;
  if (options.available) {
    registry.updateAuthStatus(accountId, "healthy");
  } else {
    registry.updateAuthStatus(
      accountId,
      "requires_consent",
      options.error ?? "Google credentials are not configured.",
    );
  }
  registry.evictProvider(accountId);
  return accountId;
}
