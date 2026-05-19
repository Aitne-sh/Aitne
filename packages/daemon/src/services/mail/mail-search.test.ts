import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { applySchema } from "../../db/schema.js";
import { searchMail } from "./mail-search.js";

function openDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  applySchema(db);
  return db;
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
  opts: { deleted?: boolean; receivedAt?: string } = {},
): void {
  db.prepare(
    `INSERT INTO mail_messages_index (
       account_id, provider_msg_id, folder, received_at_utc,
       subject, snippet, observed_at_utc, deleted_at_utc
     ) VALUES (?, ?, 'INBOX', ?, ?, ?, '2026-04-16T00:00:00Z', ?)`,
  ).run(
    accountId,
    providerMsgId,
    opts.receivedAt ?? "2026-04-16T00:00:00Z",
    subject,
    snippet,
    opts.deleted ? "2026-04-16T01:00:00Z" : null,
  );
}

// Unit tests for `buildMatchExpression` live alongside its source at
// `services/fts5.test.ts`. This file only covers `searchMail` integration
// against the FTS5 virtual table and triggers.

describe("searchMail", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDb();
    seedAccount(db, "acc-1", "alice@example.com");
    seedAccount(db, "acc-2", "bob@example.com");
  });

  it("returns empty array for empty query", () => {
    seedMessage(db, "acc-1", "m1", "Hello world", "Greetings");
    expect(searchMail(db, "")).toEqual([]);
    expect(searchMail(db, "   ")).toEqual([]);
  });

  it("finds messages by subject token", () => {
    seedMessage(db, "acc-1", "m1", "Quarterly report", "numbers");
    seedMessage(db, "acc-1", "m2", "Birthday party", "cake");
    const hits = searchMail(db, "quarterly");
    expect(hits).toHaveLength(1);
    expect(hits[0].providerMsgId).toBe("m1");
    expect(hits[0].subject).toBe("Quarterly report");
  });

  it("finds messages by snippet token", () => {
    seedMessage(db, "acc-1", "m1", "Subj", "meeting at three");
    const hits = searchMail(db, "meeting");
    expect(hits).toHaveLength(1);
  });

  it("excludes soft-deleted rows", () => {
    seedMessage(db, "acc-1", "m1", "Alpha", null);
    seedMessage(db, "acc-1", "m2", "Alpha again", null, { deleted: true });
    const hits = searchMail(db, "alpha");
    expect(hits.map((h) => h.providerMsgId)).toEqual(["m1"]);
  });

  it("scopes by accountId when given", () => {
    seedMessage(db, "acc-1", "m1", "Sync", null);
    seedMessage(db, "acc-2", "m1", "Sync", null);
    expect(searchMail(db, "sync", { accountId: "acc-1" })).toHaveLength(1);
    expect(searchMail(db, "sync")).toHaveLength(2);
  });

  it("orders by received_at DESC", () => {
    seedMessage(db, "acc-1", "m1", "Report", null, {
      receivedAt: "2026-04-10T00:00:00Z",
    });
    seedMessage(db, "acc-1", "m2", "Report", null, {
      receivedAt: "2026-04-15T00:00:00Z",
    });
    const hits = searchMail(db, "report");
    expect(hits.map((h) => h.providerMsgId)).toEqual(["m2", "m1"]);
  });

  it("respects the limit", () => {
    for (let i = 0; i < 10; i++) {
      seedMessage(db, "acc-1", `m${i}`, "Topic", null, {
        receivedAt: `2026-04-${String(i + 1).padStart(2, "0")}T00:00:00Z`,
      });
    }
    expect(searchMail(db, "topic", { limit: 3 })).toHaveLength(3);
  });

  it("clamps limit to [1, 500]", () => {
    seedMessage(db, "acc-1", "m1", "topic", null);
    expect(searchMail(db, "topic", { limit: 0 })).toHaveLength(1);
    expect(searchMail(db, "topic", { limit: 1000 })).toHaveLength(1);
  });

  it("keeps FTS row after subject update", () => {
    seedMessage(db, "acc-1", "m1", "old subject", null);
    db.prepare(
      "UPDATE mail_messages_index SET subject = 'new topic' WHERE provider_msg_id = 'm1'",
    ).run();
    expect(searchMail(db, "old")).toHaveLength(0);
    expect(searchMail(db, "topic")).toHaveLength(1);
  });

  it("drops FTS row when a message is soft-deleted via UPDATE", () => {
    seedMessage(db, "acc-1", "m1", "important", null);
    expect(searchMail(db, "important")).toHaveLength(1);
    db.prepare(
      "UPDATE mail_messages_index SET deleted_at_utc = '2026-04-16T02:00:00Z' WHERE provider_msg_id = 'm1'",
    ).run();
    expect(searchMail(db, "important")).toHaveLength(0);
  });

  it("drops FTS row on DELETE", () => {
    seedMessage(db, "acc-1", "m1", "ephemeral", null);
    expect(searchMail(db, "ephemeral")).toHaveLength(1);
    db.prepare(
      "DELETE FROM mail_messages_index WHERE provider_msg_id = 'm1'",
    ).run();
    expect(searchMail(db, "ephemeral")).toHaveLength(0);
  });

  it("maps is_read to boolean in results", () => {
    seedMessage(db, "acc-1", "m1", "flag", null);
    db.prepare(
      "UPDATE mail_messages_index SET is_read = 1 WHERE provider_msg_id = 'm1'",
    ).run();
    const hits = searchMail(db, "flag");
    expect(hits[0].isRead).toBe(true);
  });
});
