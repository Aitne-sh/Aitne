import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { createMailRoutes } from "./mail/index.js";
import { applySchema } from "../../db/schema.js";
import type { AgentConfig } from "../../config.js";
import type { ServiceRegistry } from "../../services/service-registry.js";

/**
 * Route-level tests for GET /mail/search — the FTS5-backed local index
 * search. These need the full migration chain so the fts_mail_messages
 * virtual table and its sync triggers are in place. The unit-level behaviour
 * of searchMail() is covered in services/mail/mail-search.test.ts; here we
 * only assert that the route wires query/options through correctly and
 * shapes the response to match the skill contract.
 */

function makeConfig(): AgentConfig {
  return { enabledMailProviders: ["gmail"] } as unknown as AgentConfig;
}

function seedAccount(db: Database.Database, id: string, email: string): void {
  db.prepare(
    `INSERT INTO mail_accounts (
       id, kind, email, auth_type, secret_blob_name, created_at_utc
     ) VALUES (?, 'gmail', ?, 'oauth', ?, '2026-04-16T00:00:00Z')`,
  ).run(id, email, `blob-${id}`);
}

function seedMessage(
  db: Database.Database,
  accountId: string,
  providerMsgId: string,
  subject: string | null,
  snippet: string | null,
  fromEmail: string | null = null,
  receivedAt = "2026-04-16T00:00:00Z",
): void {
  db.prepare(
    `INSERT INTO mail_messages_index (
       account_id, provider_msg_id, folder, received_at_utc,
       subject, snippet, from_email, observed_at_utc
     ) VALUES (?, ?, 'INBOX', ?, ?, ?, ?, ?)`,
  ).run(
    accountId,
    providerMsgId,
    receivedAt,
    subject,
    snippet,
    fromEmail,
    receivedAt,
  );
}

describe("GET /mail/search", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    applySchema(db);
    seedAccount(db, "acc-1", "alice@example.com");
    seedAccount(db, "acc-2", "bob@example.com");
  });

  afterEach(() => {
    db.close();
  });

  function mountApp() {
    const services = { mail: null } as unknown as ServiceRegistry;
    return createMailRoutes({
      db,
      config: makeConfig(),
      services,
    });
  }

  it("returns 400 when q is missing", async () => {
    const app = mountApp();
    const res = await app.request("/mail/search");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_query");
  });

  it("returns 400 when q is empty or whitespace", async () => {
    const app = mountApp();
    const res = await app.request("/mail/search?q=%20%20");
    expect(res.status).toBe(400);
  });

  it("returns matching messages across accounts with the expected shape", async () => {
    seedMessage(db, "acc-1", "m-1", "Invoice from Acme", "Please pay", "billing@acme.com");
    seedMessage(db, "acc-2", "m-2", "Unrelated note", "Hi there", "pal@example.com");
    seedMessage(db, "acc-1", "m-3", "Second Acme invoice", "Also due", "billing@acme.com");

    const app = mountApp();
    const res = await app.request("/mail/search?q=invoice+acme");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      results: Array<{
        accountId: string;
        providerMsgId: string;
        subject: string | null;
        snippet: string | null;
        receivedAtUtc: string;
        from: { email: string } | null;
        isRead: boolean;
      }>;
      count: number;
      query: string;
    };
    expect(body.query).toBe("invoice acme");
    expect(body.count).toBe(2);
    const ids = body.results.map((r) => r.providerMsgId).sort();
    expect(ids).toEqual(["m-1", "m-3"]);
    const first = body.results[0];
    expect(first.from).toEqual({ email: "billing@acme.com" });
    expect(typeof first.isRead).toBe("boolean");
  });

  it("scopes to one account when accountId is supplied", async () => {
    seedMessage(db, "acc-1", "m-1", "Invoice", "due today");
    seedMessage(db, "acc-2", "m-2", "Invoice", "already paid");
    const app = mountApp();
    const res = await app.request("/mail/search?q=invoice&accountId=acc-1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      results: Array<{ accountId: string; providerMsgId: string }>;
    };
    expect(body.results.map((r) => r.accountId)).toEqual(["acc-1"]);
  });

  it("respects limit (caps results without crashing)", async () => {
    for (let i = 0; i < 5; i++) {
      seedMessage(db, "acc-1", `m-${i}`, "Invoice", `due ${i}`);
    }
    const app = mountApp();
    const res = await app.request("/mail/search?q=invoice&limit=2");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: unknown[]; count: number };
    expect(body.count).toBe(2);
    expect(body.results).toHaveLength(2);
  });

  it("excludes soft-deleted rows", async () => {
    seedMessage(db, "acc-1", "m-live", "Invoice live", "pending");
    db.prepare(
      `INSERT INTO mail_messages_index (
         account_id, provider_msg_id, folder, received_at_utc,
         subject, snippet, observed_at_utc, deleted_at_utc
       ) VALUES ('acc-1', 'm-dead', 'INBOX', '2026-04-15T00:00:00Z',
                 'Invoice dead', 'stale', '2026-04-15T00:00:00Z',
                 '2026-04-16T00:00:00Z')`,
    ).run();
    const app = mountApp();
    const res = await app.request("/mail/search?q=invoice");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      results: Array<{ providerMsgId: string }>;
    };
    expect(body.results.map((r) => r.providerMsgId)).toEqual(["m-live"]);
  });

  it("returns from: null when the row has no sender recorded", async () => {
    seedMessage(db, "acc-1", "m-anon", "Anonymous tip", "no sender", null);
    const app = mountApp();
    const res = await app.request("/mail/search?q=anonymous");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      results: Array<{ from: { email: string } | null }>;
    };
    expect(body.results[0].from).toBeNull();
  });
});
