import { describe, it, expect, vi } from "vitest";
import Database from "better-sqlite3";
import {
  ensureLegacyGmailRow,
  findLegacyGmailAccountId,
  syncLegacyGmailAccountState,
} from "./legacy-row.js";
import { LEGACY_GMAIL_BLOB_SENTINEL } from "./gmail-provider.js";
import type { GmailService } from "../../gmail.js";

function createMailAccountsSchema(db: Database.Database): void {
  // Mirrors the production `mail_accounts` table from `schema.ts` (no
  // is_primary column). Kept local rather than calling applySchema so the
  // test focuses on the columns the legacy-row helper interacts with.
  db.exec(`
    CREATE TABLE mail_accounts (
      id                       TEXT PRIMARY KEY,
      kind                     TEXT NOT NULL,
      email                    TEXT NOT NULL,
      label                    TEXT,
      auth_type                TEXT NOT NULL,
      auth_status              TEXT NOT NULL DEFAULT 'healthy',
      secret_blob_name         TEXT NOT NULL,
      poll_cursor_json         TEXT,
      poll_interval_seconds    INTEGER NOT NULL DEFAULT 300,
      idle_enabled             INTEGER NOT NULL DEFAULT 0,
      idle_fallback_until      TEXT,
      unified_poll             INTEGER NOT NULL DEFAULT 1,
      active                   INTEGER NOT NULL DEFAULT 1,
      created_at_utc           TEXT NOT NULL,
      last_error               TEXT,
      last_error_at_utc        TEXT,
      last_poll_at_utc         TEXT,
      consecutive_error_count  INTEGER NOT NULL DEFAULT 0,
      UNIQUE (kind, email)
    );
  `);
}

function mockService(overrides: Partial<GmailService> = {}): GmailService {
  return {
    available: true,
    getEmailAddress: vi.fn().mockResolvedValue("user@example.com"),
    ...overrides,
  } as unknown as GmailService;
}

describe("ensureLegacyGmailRow", () => {
  it("inserts the row with unified_poll=1 on first run", async () => {
    const db = new Database(":memory:");
    createMailAccountsSchema(db);
    const result = await ensureLegacyGmailRow(db, mockService());
    expect(result.status).toBe("created");
    const row = db.prepare(`SELECT * FROM mail_accounts WHERE kind = 'gmail'`).get() as {
      id: string;
      email: string;
      unified_poll: number;
      auth_type: string;
      auth_status: string;
      secret_blob_name: string;
    };
    expect(row.email).toBe("user@example.com");
    expect(row.unified_poll).toBe(1);
    expect(row.auth_type).toBe("oauth");
    expect(row.auth_status).toBe("healthy");
    expect(row.secret_blob_name).toBe(LEGACY_GMAIL_BLOB_SENTINEL);
  });

  it("is idempotent — no new row on second run", async () => {
    const db = new Database(":memory:");
    createMailAccountsSchema(db);
    await ensureLegacyGmailRow(db, mockService());
    const second = await ensureLegacyGmailRow(db, mockService());
    expect(second.status).toBe("exists");
    const count = db
      .prepare(`SELECT COUNT(*) as n FROM mail_accounts WHERE kind = 'gmail'`)
      .get() as { n: number };
    expect(count.n).toBe(1);
  });

  it("coexists with other non-Gmail rows without touching their state", async () => {
    const db = new Database(":memory:");
    createMailAccountsSchema(db);
    db.prepare(
      `INSERT INTO mail_accounts (id, kind, email, auth_type, secret_blob_name,
         unified_poll, active, created_at_utc)
       VALUES ('outlook-a', 'outlook', 'u@outlook.com', 'oauth', 'mail:outlook:outlook-a',
               1, 1, '2026-01-01T00:00:00Z')`,
    ).run();
    const result = await ensureLegacyGmailRow(db, mockService());
    expect(result.status).toBe("created");
    // The outlook row survives untouched and the new Gmail row inserts cleanly
    // alongside it — with no primary-account coupling there is nothing else to
    // compare.
    const outlook = db.prepare(`SELECT id, kind, email FROM mail_accounts WHERE id = 'outlook-a'`)
      .get() as { id: string; kind: string; email: string };
    const gmail = db.prepare(`SELECT id, kind, email FROM mail_accounts WHERE kind = 'gmail'`)
      .get() as { id: string; kind: string; email: string };
    expect(outlook.kind).toBe("outlook");
    expect(outlook.email).toBe("u@outlook.com");
    expect(gmail.kind).toBe("gmail");
    expect(gmail.email).toBe("user@example.com");
    // Two distinct rows coexist.
    const count = db.prepare(`SELECT COUNT(*) as n FROM mail_accounts`).get() as { n: number };
    expect(count.n).toBe(2);
  });

  it("returns service_unavailable when Gmail hasn't finished initializing", async () => {
    const db = new Database(":memory:");
    createMailAccountsSchema(db);
    const result = await ensureLegacyGmailRow(db, {
      available: false,
    } as unknown as GmailService);
    expect(result.status).toBe("service_unavailable");
    const count = db.prepare(`SELECT COUNT(*) as n FROM mail_accounts`).get() as { n: number };
    expect(count.n).toBe(0);
  });

  it("returns no_profile when the API response has no email", async () => {
    const db = new Database(":memory:");
    createMailAccountsSchema(db);
    const result = await ensureLegacyGmailRow(
      db,
      mockService({ getEmailAddress: vi.fn().mockResolvedValue(null) as unknown as GmailService["getEmailAddress"] }),
    );
    expect(result.status).toBe("no_profile");
    const count = db.prepare(`SELECT COUNT(*) as n FROM mail_accounts`).get() as { n: number };
    expect(count.n).toBe(0);
  });

  it("returns no_profile when getEmailAddress throws an error", async () => {
    const db = new Database(":memory:");
    createMailAccountsSchema(db);
    const result = await ensureLegacyGmailRow(
      db,
      mockService({
        getEmailAddress: vi.fn().mockRejectedValue(new Error("API error")) as unknown as GmailService["getEmailAddress"],
      }),
    );
    expect(result.status).toBe("no_profile");
    const count = db.prepare(`SELECT COUNT(*) as n FROM mail_accounts`).get() as { n: number };
    expect(count.n).toBe(0);
  });

  it("finds the primary Gmail row by sentinel blob name", async () => {
    const db = new Database(":memory:");
    createMailAccountsSchema(db);
    await ensureLegacyGmailRow(db, mockService());
    expect(findLegacyGmailAccountId(db)).toMatch(/^gmail-/);
  });

  it("findLegacyGmailAccountId returns null when no sentinel row exists", () => {
    const db = new Database(":memory:");
    createMailAccountsSchema(db);
    expect(findLegacyGmailAccountId(db)).toBeNull();
  });

  it("syncLegacyGmailAccountState returns null when no legacy row exists", () => {
    const db = new Database(":memory:");
    createMailAccountsSchema(db);
    const updateAuthStatus = vi.fn();
    const evictProvider = vi.fn();
    const result = syncLegacyGmailAccountState(
      db,
      { updateAuthStatus, evictProvider },
      { available: false },
    );
    expect(result).toBeNull();
    expect(updateAuthStatus).not.toHaveBeenCalled();
    expect(evictProvider).not.toHaveBeenCalled();
  });

  it("syncLegacyGmailAccountState falls back to a default error message when none is supplied", async () => {
    const db = new Database(":memory:");
    createMailAccountsSchema(db);
    await ensureLegacyGmailRow(db, mockService());
    const updateAuthStatus = vi.fn().mockReturnValue(true);
    const evictProvider = vi.fn();
    const accountId = syncLegacyGmailAccountState(
      db,
      { updateAuthStatus, evictProvider },
      { available: false }, // no error → default message
    );
    expect(accountId).toMatch(/^gmail-/);
    expect(updateAuthStatus).toHaveBeenCalledWith(
      accountId,
      "requires_consent",
      "Google credentials are not configured.",
    );
  });

  it("marks the legacy Gmail row unhealthy and evicts the cached provider on disconnect", async () => {
    const db = new Database(":memory:");
    createMailAccountsSchema(db);
    await ensureLegacyGmailRow(db, mockService());
    const updateAuthStatus = vi.fn().mockReturnValue(true);
    const evictProvider = vi.fn();

    const accountId = syncLegacyGmailAccountState(
      db,
      { updateAuthStatus, evictProvider },
      { available: false, error: "Google credentials are not configured." },
    );

    expect(accountId).toMatch(/^gmail-/);
    expect(updateAuthStatus).toHaveBeenCalledWith(
      accountId,
      "requires_consent",
      "Google credentials are not configured.",
    );
    expect(evictProvider).toHaveBeenCalledWith(accountId);
  });

  it("marks the legacy Gmail row healthy and evicts the cached provider on reconnect", async () => {
    const db = new Database(":memory:");
    createMailAccountsSchema(db);
    await ensureLegacyGmailRow(db, mockService());
    const updateAuthStatus = vi.fn().mockReturnValue(true);
    const evictProvider = vi.fn();

    const accountId = syncLegacyGmailAccountState(
      db,
      { updateAuthStatus, evictProvider },
      { available: true },
    );

    expect(updateAuthStatus).toHaveBeenCalledWith(accountId, "healthy");
    expect(evictProvider).toHaveBeenCalledWith(accountId);
  });
});
