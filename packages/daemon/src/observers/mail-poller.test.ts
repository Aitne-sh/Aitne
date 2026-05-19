import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { MailPoller } from "./mail-poller.js";
import {
  MailAccountRegistry,
  type MailProviderFactory,
} from "../services/mail/account-registry.js";
import type {
  MailAccount,
  MailMessageSummary,
  MailProvider,
  PollCursor,
  PollResult,
} from "../services/mail/provider.js";
import type { EncryptedBlobStore } from "../secrets/encrypted-blob-store.js";
import type { BlobName } from "../secrets/types.js";
import { AgentWriteTracker } from "../safety/agent-write-tracker.js";
import { GraphError } from "../services/mail/outlook/graph-client.js";

class MemoryBlobStore implements EncryptedBlobStore {
  readonly blobs = new Map<string, string>();
  async exists(name: BlobName): Promise<boolean> {
    return this.blobs.has(name);
  }
  async readUtf8(name: BlobName): Promise<string | null> {
    return this.blobs.get(name) ?? null;
  }
  async writeUtf8(name: BlobName, plaintext: string): Promise<void> {
    this.blobs.set(name, plaintext);
  }
  async remove(name: BlobName): Promise<void> {
    this.blobs.delete(name);
  }
}

function createSchema(db: Database.Database): void {
  // Minimal subset of v30 + observations to exercise the poller end-to-end
  // without pulling the whole migration chain.
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
      imap_capabilities_json   TEXT,
      UNIQUE (kind, email)
    );
    CREATE TABLE observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      ref TEXT NOT NULL,
      change_type TEXT NOT NULL
        CHECK (change_type IN ('created', 'modified', 'deleted')),
      actor TEXT NOT NULL DEFAULT 'user'
        CHECK (actor IN ('user', 'agent', 'system', 'unknown')),
      observed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      payload TEXT,
      consumed_at TIMESTAMP,
      consumed_by TEXT,
      summary_text TEXT,
      novelty_score INTEGER,
      summary_at TEXT,
      summary_backend TEXT,
      summary_status TEXT NOT NULL DEFAULT 'pending'
    );
	    CREATE UNIQUE INDEX idx_obs_unique_pending
	      ON observations(source, ref) WHERE consumed_at IS NULL;
      CREATE TABLE mail_messages_index (
        account_id TEXT NOT NULL,
        provider_msg_id TEXT NOT NULL,
        rfc822_msg_id TEXT,
        thread_id TEXT,
        folder TEXT NOT NULL,
        received_at_utc TEXT NOT NULL,
        subject TEXT,
        from_email TEXT,
        to_emails_json TEXT,
        snippet TEXT,
        is_read INTEGER NOT NULL DEFAULT 0,
        flags_json TEXT,
        has_attachment INTEGER NOT NULL DEFAULT 0,
        deleted_at_utc TEXT,
        observed_at_utc TEXT NOT NULL,
        PRIMARY KEY (account_id, provider_msg_id)
      );
      CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
      );
	  `);
  // INTEGRATION_NATIVE_MODE_DESIGN.md Phase A — the install default for
  // gmail/outlook_mail is `disabled`, which now correctly causes
  // MailPoller to skip those accounts. The pre-fix poller ignored
  // `disabled`, so legacy tests in this file assume the poller works
  // out-of-the-box for gmail/outlook accounts. Seed `direct` here so the
  // baseline behavior matches the legacy assumption; the §4.8
  // suppression suite stamps its own modes per-test and is unaffected.
  db.prepare(
    `INSERT INTO settings (key, value_json, updated_at)
     VALUES ('integrations', ?, CURRENT_TIMESTAMP)`,
  ).run(
    JSON.stringify({
      gmail: {
        mode: "direct",
        deniedTools: [],
        lastChangedAt: "2026-04-19T00:00:00Z",
      },
      outlook_mail: {
        mode: "direct",
        deniedTools: [],
        lastChangedAt: "2026-04-19T00:00:00Z",
      },
    }),
  );
}

interface ScriptedProviderOptions {
  pages?: Array<PollResult | Error>;
  onRevoke?: () => void;
}

function scriptedProvider(
  account: MailAccount,
  opts: ScriptedProviderOptions = {},
): MailProvider {
  const pages = [...(opts.pages ?? [])];
  return {
    kind: account.kind,
    account,
    list: async () => [],
    get: async () => {
      throw new Error("stub get");
    },
    send: async () => ({ id: "stub", isDraft: true }),
    modifyTags: async () => undefined,
    markRead: async () => undefined,
    trash: async () => undefined,
    listFolders: async () => [],
    async pollSince(_cursor: PollCursor | null, _limit: number): Promise<PollResult> {
      const next = pages.shift();
      if (!next) {
        return {
          messages: [],
          removedIds: [],
          nextCursor: { kind: "graph" },
          drained: true,
        };
      }
      if (next instanceof Error) throw next;
      return next;
    },
    revoke: async () => {
      opts.onRevoke?.();
    },
  };
}

/**
 * INTEGRATION_NATIVE_MODE_DESIGN.md Phase A — the install default for
 * gmail/outlook_mail is `disabled`, which (after the bug fix) correctly
 * causes MailPoller to skip those kinds. Legacy tests in this file
 * predate the fix and assume the poller polls gmail/outlook by default,
 * so they seed `direct` mode explicitly via this helper. The §4.8
 * suppression suite stamps its own modes per-test and does not call this.
 */
function seedDirectMailIntegrations(db: Database.Database): void {
  db.prepare(
    `INSERT INTO settings (key, value_json, updated_at)
     VALUES ('integrations', ?, CURRENT_TIMESTAMP)
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json,
                                    updated_at = CURRENT_TIMESTAMP`,
  ).run(
    JSON.stringify({
      gmail: {
        mode: "direct",
        deniedTools: [],
        lastChangedAt: "2026-04-19T00:00:00Z",
      },
      outlook_mail: {
        mode: "direct",
        deniedTools: [],
        lastChangedAt: "2026-04-19T00:00:00Z",
      },
    }),
  );
}

function summary(
  accountId: string,
  providerMsgId: string,
  subject = "hi",
): MailMessageSummary {
  return {
    accountId,
    providerMsgId,
    rfc822MsgId: null,
    threadId: null,
    folder: "Inbox",
    receivedAtUtc: new Date().toISOString(),
    subject,
    from: { email: "a@x" },
    to: [],
    snippet: null,
    isRead: false,
    flags: [],
    hasAttachment: false,
  };
}

describe("MailPoller", () => {
  let db: Database.Database;
  let blobStore: MemoryBlobStore;
  let writeTracker: AgentWriteTracker;

  beforeEach(() => {
    db = new Database(":memory:");
    createSchema(db);
    blobStore = new MemoryBlobStore();
    writeTracker = new AgentWriteTracker();
  });

  afterEach(() => {
    db.close();
  });

  async function seedOutlookAccount(
    registry: MailAccountRegistry,
  ): Promise<MailAccount> {
    return registry.addAccount({
      kind: "outlook",
      email: "owner@example.com",
      authType: "oauth",
      secretPayload: "{}",
    });
  }

  async function seedGmailAccount(
    registry: MailAccountRegistry,
  ): Promise<MailAccount> {
    return registry.addAccount({
      kind: "gmail",
      email: "owner@gmail.test",
      authType: "oauth",
      secretPayload: "{}",
    });
  }

  function makeRegistry(factory: MailProviderFactory): MailAccountRegistry {
    return new MailAccountRegistry({
      db,
      blobStore,
      getEnabledKinds: () => ["outlook"],
      providerFactories: { outlook: factory },
      now: () => new Date("2026-04-16T12:00:00.000Z"),
    });
  }

  it("records an observation only for user-originated messages", async () => {
    const registry = makeRegistry((account) =>
      scriptedProvider(account, {
        pages: [
          {
            messages: [
              summary("outlook-acct", "agent-msg"),
              summary("outlook-acct", "user-msg"),
            ],
            removedIds: [],
            nextCursor: { kind: "graph", deltaLink: "https://x/delta" },
            drained: true,
          },
        ],
      }),
    );
    const account = await seedOutlookAccount(registry);
    // Mark one of the messages as agent-originated to verify suppression.
    writeTracker.markWriting(`mail:${account.id}:agent-msg`, null, {
      ttlMs: 60_000,
    });

    const poller = new MailPoller({
      registry,
      db,
      writeTracker,
      pollIntervalSeconds: 60,
      maxMessagesPerPoll: 20,
    });

    // Do not start the timer — just run one tick directly.
    await (poller as unknown as { tick: () => Promise<void> }).tick();

    const obs = db
      .prepare(`SELECT payload FROM observations`)
      .all() as { payload: string }[];
    expect(obs).toHaveLength(1);
    const payload = JSON.parse(obs[0]!.payload);
    expect(payload.newMessages).toBe(1);
    expect(payload.fromAgentSuppressed).toBe(1);
    expect(payload.subjects).toEqual(["hi"]);
  });

  it("persists the cursor and clears errors after a successful tick", async () => {
    const registry = makeRegistry((account) =>
      scriptedProvider(account, {
        pages: [
          {
            messages: [],
            removedIds: [],
            nextCursor: { kind: "graph", deltaLink: "https://final" },
            drained: true,
          },
        ],
      }),
    );
    const account = await seedOutlookAccount(registry);
    // Seed a prior failure so we can assert it's cleared.
    registry.recordPollTick(account.id, { success: false, error: "boom" });

    const poller = new MailPoller({
      registry,
      db,
      writeTracker,
      pollIntervalSeconds: 60,
      maxMessagesPerPoll: 20,
    });
    await (poller as unknown as { tick: () => Promise<void> }).tick();

    expect(registry.loadPollCursor(account.id)).toEqual({
      kind: "graph",
      deltaLink: "https://final",
    });
    const health = registry.getHealth(account.id)!;
    expect(health.consecutiveErrorCount).toBe(0);
    expect(health.lastError).toBeNull();
  });

  it("flips auth_status to requires_consent on AADSTS invalid_grant and DMs the owner", async () => {
    const err = new Error("AADSTS700082: ExpiredOrRevoked");
    const registry = makeRegistry((account) =>
      scriptedProvider(account, { pages: [err] }),
    );
    const account = await seedOutlookAccount(registry);

    const notifyOwner = vi.fn().mockResolvedValue(undefined);
    const poller = new MailPoller({
      registry,
      db,
      writeTracker,
      pollIntervalSeconds: 60,
      maxMessagesPerPoll: 20,
      notifyOwner,
      authFailureRetryHours: 6,
    });
    await (poller as unknown as { tick: () => Promise<void> }).tick();

    expect(registry.getAccount(account.id)?.authStatus).toBe("requires_consent");
    expect(notifyOwner).toHaveBeenCalledTimes(1);
    expect(notifyOwner.mock.calls[0]![0]).toMatch(/owner@example\.com/);
  });

  it("resends DM after a successful tick clears prior cadence (V3 happy path)", async () => {
    const firstErr = new Error("AADSTS700082");
    const secondErr = new Error("AADSTS700082");
    const pages: Array<PollResult | Error> = [firstErr];
    const registry = makeRegistry((account) =>
      scriptedProvider(account, { pages }),
    );
    const account = await seedOutlookAccount(registry);

    const notifyOwner = vi.fn().mockResolvedValue(undefined);
    const poller = new MailPoller({
      registry,
      db,
      writeTracker,
      pollIntervalSeconds: 60,
      maxMessagesPerPoll: 20,
      notifyOwner,
      authFailureRetryHours: 6,
    });

    // First failure — DM sent.
    await (poller as unknown as { tick: () => Promise<void> }).tick();
    expect(notifyOwner).toHaveBeenCalledTimes(1);

    // Simulate user re-consenting: flip back to healthy + evict cached provider.
    registry.updateAuthStatus(account.id, "healthy", null);
    registry.evictProvider(account.id);

    // Successful tick clears reconsentState.
    pages.length = 0;
    pages.push({
      messages: [],
      removedIds: [],
      nextCursor: { kind: "graph", deltaLink: "https://delta2" },
      drained: true,
    });
    await (poller as unknown as { tick: () => Promise<void> }).tick();

    // Next failure within the 6h window — DM fires immediately, not silenced.
    pages.length = 0;
    pages.push(secondErr);
    registry.evictProvider(account.id);
    await (poller as unknown as { tick: () => Promise<void> }).tick();
    expect(notifyOwner).toHaveBeenCalledTimes(2);
  });

  it("resends DM on re-consent → immediate re-fail without an intervening success (V3 edge case)", async () => {
    // This is the stronger variant of V3: user re-consents but the new tokens
    // are immediately broken (e.g., permissions revoked). Before the fix,
    // reconsentState was only cleared on a successful tick, so the second
    // failure was silenced for up to mailAuthFailureRetryHours.
    const firstErr = new Error("AADSTS700082");
    const secondErr = new Error("AADSTS50173");
    const pages: Array<PollResult | Error> = [firstErr];
    const registry = makeRegistry((account) =>
      scriptedProvider(account, { pages }),
    );
    const account = await seedOutlookAccount(registry);

    const notifyOwner = vi.fn().mockResolvedValue(undefined);
    const poller = new MailPoller({
      registry,
      db,
      writeTracker,
      pollIntervalSeconds: 60,
      maxMessagesPerPoll: 20,
      notifyOwner,
      authFailureRetryHours: 6,
    });

    // First failure — DM sent.
    await (poller as unknown as { tick: () => Promise<void> }).tick();
    expect(notifyOwner).toHaveBeenCalledTimes(1);

    // External re-consent flips status back to healthy.
    registry.updateAuthStatus(account.id, "healthy", null);
    registry.evictProvider(account.id);

    // NEXT tick fails again directly — no intervening successful poll.
    pages.length = 0;
    pages.push(secondErr);
    await (poller as unknown as { tick: () => Promise<void> }).tick();

    // Must DM — this is a fresh failure cycle after re-consent, even though
    // the prior DM was sent <6h ago.
    expect(notifyOwner).toHaveBeenCalledTimes(2);
  });

  it("transient 5xx below threshold stays healthy and sends no DM", async () => {
    // First failure should be classified as transient and not flip status.
    const registry = makeRegistry((account) =>
      scriptedProvider(account, {
        pages: [
          new GraphError({
            message: "server down",
            httpStatus: 503,
            responseBody: null,
            graphCode: null,
            retryAfterSeconds: null,
          }),
        ],
      }),
    );
    const account = await seedOutlookAccount(registry);
    const notifyOwner = vi.fn().mockResolvedValue(undefined);
    const poller = new MailPoller({
      registry,
      db,
      writeTracker,
      pollIntervalSeconds: 60,
      maxMessagesPerPoll: 20,
      notifyOwner,
    });

    await (poller as unknown as { tick: () => Promise<void> }).tick();
    expect(registry.getAccount(account.id)?.authStatus).toBe("healthy");
    expect(registry.getConsecutiveErrorCount(account.id)).toBe(1);
    expect(notifyOwner).not.toHaveBeenCalled();
  });

  it("transient 5xx above threshold flips to degraded without DM", async () => {
    // Seed the registry at threshold so a single failure crosses it. The
    // poller's handlePollError previews the post-increment count, so with
    // count=10 going in, `upcoming=11 > TRANSIENT_BACKOFF_THRESHOLD` flips.
    const registry = makeRegistry((account) =>
      scriptedProvider(account, {
        pages: [
          new GraphError({
            message: "still down",
            httpStatus: 503,
            responseBody: null,
            graphCode: null,
            retryAfterSeconds: null,
          }),
        ],
      }),
    );
    const account = await seedOutlookAccount(registry);
    for (let i = 0; i < 10; i++) {
      registry.recordPollTick(account.id, { success: false, error: "prior" });
    }

    const notifyOwner = vi.fn().mockResolvedValue(undefined);
    const poller = new MailPoller({
      registry,
      db,
      writeTracker,
      pollIntervalSeconds: 60,
      maxMessagesPerPoll: 20,
      notifyOwner,
    });

    await (poller as unknown as { tick: () => Promise<void> }).tick();
    expect(registry.getAccount(account.id)?.authStatus).toBe("degraded");
    expect(notifyOwner).not.toHaveBeenCalled();
  });

  it("flips Gmail to requires_consent on 401 authError and DMs the owner", async () => {
    const err = Object.assign(new Error("Invalid Credentials"), {
      response: {
        status: 401,
        data: {
          error: {
            errors: [{ reason: "authError" }],
          },
        },
      },
    });
    const registry = new MailAccountRegistry({
      db,
      blobStore,
      getEnabledKinds: () => ["gmail"],
      providerFactories: {
        gmail: (account) => scriptedProvider(account, { pages: [err] }),
      },
      now: () => new Date("2026-04-16T12:00:00.000Z"),
    });
    const account = await seedGmailAccount(registry);

    const notifyOwner = vi.fn().mockResolvedValue(undefined);
    const poller = new MailPoller({
      registry,
      db,
      writeTracker,
      pollIntervalSeconds: 60,
      maxMessagesPerPoll: 20,
      notifyOwner,
    });

    await (poller as unknown as { tick: () => Promise<void> }).tick();
    expect(registry.getAccount(account.id)?.authStatus).toBe("requires_consent");
    expect(notifyOwner).toHaveBeenCalledTimes(1);
  });

  it("soft-deletes removedIds returned by a provider", async () => {
    const registry = makeRegistry((account) =>
      scriptedProvider(account, {
        pages: [
          {
            messages: [],
            removedIds: ["deleted-msg"],
            nextCursor: { kind: "graph", deltaLink: "https://final" },
            drained: true,
          },
        ],
      }),
    );
    const account = await seedOutlookAccount(registry);
    db.prepare(
      `INSERT INTO mail_messages_index (
         account_id, provider_msg_id, folder, received_at_utc,
         observed_at_utc, deleted_at_utc
       ) VALUES (?, 'deleted-msg', 'Inbox', '2026-04-16T00:00:00.000Z',
                 '2026-04-16T00:00:00.000Z', NULL)`,
    ).run(account.id);

    const poller = new MailPoller({
      registry,
      db,
      writeTracker,
      pollIntervalSeconds: 60,
      maxMessagesPerPoll: 20,
    });

    await (poller as unknown as { tick: () => Promise<void> }).tick();
    const row = db
      .prepare(
        `SELECT deleted_at_utc FROM mail_messages_index
          WHERE account_id = ? AND provider_msg_id = 'deleted-msg'`,
      )
      .get(account.id) as { deleted_at_utc: string | null };
    expect(row.deleted_at_utc).not.toBeNull();
  });

  it("upserts polled messages into mail_messages_index", async () => {
    const registry = makeRegistry((account) =>
      scriptedProvider(account, {
        pages: [
          {
            messages: [
              {
                accountId: "outlook-x",
                providerMsgId: "msg-1",
                rfc822MsgId: "<one@example.com>",
                threadId: "thr-1",
                folder: "Inbox",
                receivedAtUtc: "2026-04-16T08:00:00.000Z",
                subject: "Hello",
                from: { email: "alice@example.com" },
                to: [{ email: "owner@example.com" }],
                snippet: "first body",
                isRead: false,
                flags: ["seen"],
                hasAttachment: true,
              },
            ],
            removedIds: [],
            nextCursor: { kind: "graph", deltaLink: "https://final" },
            drained: true,
          },
        ],
      }),
    );
    const account = await seedOutlookAccount(registry);
    const poller = new MailPoller({
      registry,
      db,
      writeTracker,
      pollIntervalSeconds: 60,
      maxMessagesPerPoll: 20,
    });

    await (poller as unknown as { tick: () => Promise<void> }).tick();
    const row = db
      .prepare(
        `SELECT provider_msg_id, rfc822_msg_id, thread_id, folder,
                received_at_utc, subject, from_email, to_emails_json,
                snippet, is_read, flags_json, has_attachment, deleted_at_utc
           FROM mail_messages_index
          WHERE account_id = ? AND provider_msg_id = 'msg-1'`,
      )
      .get(account.id) as {
      provider_msg_id: string;
      rfc822_msg_id: string;
      thread_id: string;
      folder: string;
      received_at_utc: string;
      subject: string;
      from_email: string;
      to_emails_json: string;
      snippet: string;
      is_read: number;
      flags_json: string;
      has_attachment: number;
      deleted_at_utc: string | null;
    };
    expect(row).toBeDefined();
    expect(row.rfc822_msg_id).toBe("<one@example.com>");
    expect(row.thread_id).toBe("thr-1");
    expect(row.subject).toBe("Hello");
    expect(row.from_email).toBe("alice@example.com");
    expect(JSON.parse(row.to_emails_json)).toEqual([
      { email: "owner@example.com" },
    ]);
    expect(row.is_read).toBe(0);
    expect(row.has_attachment).toBe(1);
    expect(row.deleted_at_utc).toBeNull();
  });

  it("upsert refreshes mutable fields on conflict but does not un-trash", async () => {
    const registry = makeRegistry((account) =>
      scriptedProvider(account, {
        pages: [
          {
            messages: [
              {
                accountId: "outlook-x",
                providerMsgId: "msg-2",
                rfc822MsgId: null,
                threadId: null,
                folder: "Inbox",
                receivedAtUtc: "2026-04-16T08:00:00.000Z",
                subject: "Updated subject",
                from: { email: "alice@example.com" },
                to: [],
                snippet: "now read",
                isRead: true,
                flags: [],
              },
            ],
            removedIds: [],
            nextCursor: { kind: "graph", deltaLink: "https://final" },
            drained: true,
          },
        ],
      }),
    );
    const account = await seedOutlookAccount(registry);
    db.prepare(
      `INSERT INTO mail_messages_index (
         account_id, provider_msg_id, folder, received_at_utc,
         subject, snippet, is_read, deleted_at_utc, observed_at_utc
       ) VALUES (?, 'msg-2', 'Inbox', '2026-04-15T00:00:00Z',
                 'Old subject', 'old snippet', 0,
                 '2026-04-15T01:00:00Z', '2026-04-15T00:00:00Z')`,
    ).run(account.id);

    const poller = new MailPoller({
      registry,
      db,
      writeTracker,
      pollIntervalSeconds: 60,
      maxMessagesPerPoll: 20,
    });
    await (poller as unknown as { tick: () => Promise<void> }).tick();

    const row = db
      .prepare(
        `SELECT subject, snippet, is_read, deleted_at_utc
           FROM mail_messages_index
          WHERE account_id = ? AND provider_msg_id = 'msg-2'`,
      )
      .get(account.id) as {
      subject: string;
      snippet: string;
      is_read: number;
      deleted_at_utc: string | null;
    };
    expect(row.subject).toBe("Updated subject");
    expect(row.snippet).toBe("now read");
    expect(row.is_read).toBe(1);
    // Pre-existing soft-delete is preserved — the upsert intentionally does
    // not clear `deleted_at_utc` so a re-listing by the provider does not
    // silently un-trash a row the user moved to trash upstream.
    expect(row.deleted_at_utc).toBe("2026-04-15T01:00:00Z");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Kindle "Export Notebook" ingestion for unified-poll providers (yahoo /
// outlook / icloud). These tests exercise the MailPoller branch for the
// non-Gmail providers.
// ─────────────────────────────────────────────────────────────────────────────

const KINDLE_NOTEBOOK_HTML = `<!DOCTYPE html>
<html>
  <body>
    <div class="bodyContainer">
      <div class="bookTitle">Thinking, Fast and Slow</div>
      <div class="authors">Daniel Kahneman</div>
      <div class="noteHeading">Highlight (yellow) - Location 1234</div>
      <div class="noteText">We can be blind to the obvious, and we are also blind to our blindness.</div>
      <div class="noteHeading">Highlight (yellow) - Location 2000</div>
      <div class="noteText">A reliable way to make people believe in falsehoods is frequent repetition.</div>
    </div>
  </body>
</html>`;

/** Adds the mail-ingestion feature tables (books, reading_highlights,
 *  parse_failures, travel_bookings, receipts) on top of the poller's
 *  minimal mail_accounts + observations schema. The full applySchema
 *  cannot run here because createSchema creates a stripped-down
 *  mail_messages_index without the columns the FTS triggers reference. */
function addBooksSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS books (
      id INTEGER PRIMARY KEY,
      title TEXT NOT NULL,
      author TEXT,
      source TEXT NOT NULL DEFAULT 'kindle',
      status TEXT DEFAULT 'reading',
      started_at TEXT,
      completed_at TEXT,
      rating INTEGER,
      notes TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_books_title_author
      ON books(title, COALESCE(author, ''));
    CREATE TABLE IF NOT EXISTS reading_highlights (
      id INTEGER PRIMARY KEY,
      book_id INTEGER REFERENCES books(id),
      content TEXT NOT NULL,
      location TEXT,
      note TEXT,
      highlighted_at TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS parse_failures (
      id INTEGER PRIMARY KEY,
      account_id TEXT,
      provider_msg_id TEXT,
      sender TEXT,
      subject TEXT,
      snippet TEXT,
      error_reason TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_parse_failures_account_msg
      ON parse_failures(account_id, provider_msg_id)
     WHERE provider_msg_id IS NOT NULL;
    CREATE TABLE IF NOT EXISTS travel_bookings (
      id INTEGER PRIMARY KEY,
      type TEXT NOT NULL,
      provider TEXT NOT NULL,
      destination TEXT,
      start_date TEXT,
      end_date TEXT,
      confirmation_number TEXT,
      amount INTEGER,
      currency TEXT NOT NULL DEFAULT 'USD',
      status TEXT DEFAULT 'upcoming',
      provider_msg_id TEXT,
      account_id TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_travel_bookings_account_msg
      ON travel_bookings(account_id, provider_msg_id)
     WHERE provider_msg_id IS NOT NULL;
    CREATE TABLE IF NOT EXISTS receipts (
      id INTEGER PRIMARY KEY,
      provider_msg_id TEXT NOT NULL,
      attachment_id TEXT NOT NULL,
      filename TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size_bytes INTEGER,
      category TEXT,
      obsidian_path TEXT,
      saved_at TEXT,
      account_id TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(account_id, provider_msg_id, attachment_id)
    );
  `);
}

function kindleSummary(
  accountId: string,
  providerMsgId: string,
): MailMessageSummary {
  return {
    accountId,
    providerMsgId,
    rfc822MsgId: null,
    threadId: null,
    folder: "Inbox",
    receivedAtUtc: "2026-04-14T08:00:00.000Z",
    subject: "Your Kindle Notebook from Thinking, Fast and Slow",
    from: { email: "do-not-reply@kindle.amazon.com", name: "Kindle" },
    to: [],
    snippet: "Your notes and highlights",
    isRead: false,
    flags: [],
    hasAttachment: false,
  };
}

function kindleProviderFactory(options: {
  summary: MailMessageSummary;
  html: string | null;
  getShouldThrow?: () => Error | null;
}): MailProviderFactory {
  return (account) => ({
    kind: account.kind,
    account,
    list: async () => [],
    get: async (id: string) => {
      const shouldThrow = options.getShouldThrow?.();
      if (shouldThrow) throw shouldThrow;
      return {
        accountId: account.id,
        providerMsgId: id,
        rfc822MsgId: null,
        threadId: null,
        folder: "Inbox",
        receivedAtUtc: options.summary.receivedAtUtc,
        subject: options.summary.subject,
        from: options.summary.from,
        to: [],
        snippet: options.summary.snippet,
        isRead: false,
        flags: [],
        hasAttachment: false,
        body: {
          html: options.html ?? undefined,
        },
        attachments: [],
      };
    },
    send: async () => ({ id: "stub", isDraft: true }),
    modifyTags: async () => undefined,
    markRead: async () => undefined,
    trash: async () => undefined,
    listFolders: async () => [],
    async pollSince(): Promise<PollResult> {
      return {
        messages: [options.summary],
        removedIds: [],
        nextCursor: { kind: "graph", deltaLink: "https://x/delta" },
        drained: true,
      };
    },
    revoke: async () => undefined,
  });
}

describe("MailPoller — Kindle Notebook Export ingest", () => {
  let db: Database.Database;
  let blobStore: MemoryBlobStore;
  let writeTracker: AgentWriteTracker;

  beforeEach(() => {
    db = new Database(":memory:");
    createSchema(db);
    addBooksSchema(db);
    blobStore = new MemoryBlobStore();
    writeTracker = new AgentWriteTracker();
  });

  afterEach(() => {
    db.close();
  });

  async function seedAccount(
    registry: MailAccountRegistry,
    kind: "outlook" | "yahoo" | "icloud",
    email: string,
  ): Promise<MailAccount> {
    return registry.addAccount({
      kind,
      email,
      authType: "oauth",
      secretPayload: "{}",
    });
  }

  function makeRegistryWithProvider(
    enabled: Array<"outlook" | "yahoo" | "icloud">,
    kind: "outlook" | "yahoo" | "icloud",
    factory: MailProviderFactory,
  ): MailAccountRegistry {
    return new MailAccountRegistry({
      db,
      blobStore,
      getEnabledKinds: () => enabled,
      providerFactories: { [kind]: factory },
      now: () => new Date("2026-04-16T12:00:00.000Z"),
    });
  }

  it("ingests a Kindle email arriving at an Outlook account", async () => {
    const sum = kindleSummary("outlook-acct", "oauth-msg-1");
    const registry = makeRegistryWithProvider(
      ["outlook"],
      "outlook",
      kindleProviderFactory({ summary: sum, html: KINDLE_NOTEBOOK_HTML }),
    );
    const account = await seedAccount(registry, "outlook", "owner@outlook.com");
    sum.accountId = account.id;

    const poller = new MailPoller({
      registry,
      db,
      writeTracker,
      pollIntervalSeconds: 60,
      maxMessagesPerPoll: 20,
    });
    await (poller as unknown as { tick: () => Promise<void> }).tick();

    const books = db
      .prepare("SELECT title, author FROM books")
      .all() as { title: string; author: string }[];
    expect(books).toEqual([
      { title: "Thinking, Fast and Slow", author: "Daniel Kahneman" },
    ]);
    const hls = db
      .prepare("SELECT content FROM reading_highlights ORDER BY id")
      .all() as { content: string }[];
    expect(hls).toHaveLength(2);

    const obs = db
      .prepare("SELECT payload FROM observations")
      .all() as { payload: string }[];
    expect(obs).toHaveLength(1);
    const payload = JSON.parse(obs[0]!.payload);
    expect(payload.kindleBooksCreated).toBe(1);
    expect(payload.kindleHighlightsInserted).toBe(2);
    expect(payload.kindleNotebooks).toBe(1);
    expect(payload.kindleParseFailures).toBe(0);
  });

  it("ingests Kindle emails for yahoo and icloud too", async () => {
    for (const kind of ["yahoo", "icloud"] as const) {
      const freshDb = new Database(":memory:");
      createSchema(freshDb);
      addBooksSchema(freshDb);
      const freshStore = new MemoryBlobStore();
      const freshTracker = new AgentWriteTracker();

      const sum = kindleSummary(`${kind}-acct`, `msg-${kind}`);
      const registry = new MailAccountRegistry({
        db: freshDb,
        blobStore: freshStore,
        getEnabledKinds: () => [kind],
        providerFactories: {
          [kind]: kindleProviderFactory({
            summary: sum,
            html: KINDLE_NOTEBOOK_HTML,
          }),
        },
        now: () => new Date("2026-04-16T12:00:00.000Z"),
      });
      const account = await registry.addAccount({
        kind,
        email: `owner@${kind}.com`,
        authType: kind === "yahoo" ? "app_password" : "oauth",
        secretPayload: "{}",
      });
      sum.accountId = account.id;

      const poller = new MailPoller({
        registry,
        db: freshDb,
        writeTracker: freshTracker,
        pollIntervalSeconds: 60,
        maxMessagesPerPoll: 20,
      });
      await (poller as unknown as { tick: () => Promise<void> }).tick();

      const bookCount = freshDb
        .prepare("SELECT COUNT(*) as c FROM books")
        .get() as { c: number };
      expect(bookCount.c, `${kind}: expected 1 book`).toBe(1);
      freshDb.close();
    }
  });

  it("skips ingestion when the provider kind is not in enabledMailProviders", async () => {
    // Yahoo account exists, but yahoo is absent from enabledMailProviders.
    const sum = kindleSummary("yahoo-acct", "msg-1");
    const factory = kindleProviderFactory({
      summary: sum,
      html: KINDLE_NOTEBOOK_HTML,
    });
    const registry = new MailAccountRegistry({
      db,
      blobStore,
      getEnabledKinds: () => [], // yahoo disabled
      providerFactories: { yahoo: factory },
      now: () => new Date("2026-04-16T12:00:00.000Z"),
    });
    await registry.addAccount({
      kind: "yahoo",
      email: "owner@yahoo.com",
      authType: "app_password",
      secretPayload: "{}",
    });

    const poller = new MailPoller({
      registry,
      db,
      writeTracker,
      pollIntervalSeconds: 60,
      maxMessagesPerPoll: 20,
    });
    await (poller as unknown as { tick: () => Promise<void> }).tick();

    const bookCount = db
      .prepare("SELECT COUNT(*) as c FROM books")
      .get() as { c: number };
    expect(bookCount.c).toBe(0);
    const obsCount = db
      .prepare("SELECT COUNT(*) as c FROM observations")
      .get() as { c: number };
    expect(obsCount.c).toBe(0);
  });

  it("records a parse_failure when a Kindle email has no HTML body", async () => {
    const sum = kindleSummary("outlook-acct", "msg-no-html");
    const registry = makeRegistryWithProvider(
      ["outlook"],
      "outlook",
      kindleProviderFactory({ summary: sum, html: null }),
    );
    const account = await seedAccount(registry, "outlook", "owner@outlook.com");
    sum.accountId = account.id;

    const poller = new MailPoller({
      registry,
      db,
      writeTracker,
      pollIntervalSeconds: 60,
      maxMessagesPerPoll: 20,
    });
    await (poller as unknown as { tick: () => Promise<void> }).tick();

    const failures = db
      .prepare(
        `SELECT provider_msg_id, error_reason FROM parse_failures`,
      )
      .all() as { provider_msg_id: string; error_reason: string }[];
    expect(failures).toHaveLength(1);
    expect(failures[0]!.error_reason).toBe("kindle_notebook_no_html");
    expect(failures[0]!.provider_msg_id).toBe(
      `mail:outlook:${account.id}:msg-no-html`,
    );

    const bookCount = db
      .prepare("SELECT COUNT(*) as c FROM books")
      .get() as { c: number };
    expect(bookCount.c).toBe(0);
  });

  it("records a parse_failure for unrecognized HTML", async () => {
    const sum = kindleSummary("outlook-acct", "msg-bad");
    const registry = makeRegistryWithProvider(
      ["outlook"],
      "outlook",
      kindleProviderFactory({
        summary: sum,
        html: "<html><body>Not a Kindle export.</body></html>",
      }),
    );
    const account = await seedAccount(registry, "outlook", "owner@outlook.com");
    sum.accountId = account.id;

    const poller = new MailPoller({
      registry,
      db,
      writeTracker,
      pollIntervalSeconds: 60,
      maxMessagesPerPoll: 20,
    });
    await (poller as unknown as { tick: () => Promise<void> }).tick();

    const failure = db
      .prepare(
        `SELECT error_reason FROM parse_failures WHERE provider_msg_id = ?`,
      )
      .get(`mail:outlook:${account.id}:msg-bad`) as {
      error_reason: string;
    } | undefined;
    expect(failure?.error_reason).toBe(
      "kindle_notebook_unrecognized_format",
    );
  });

  it("does not double-process a Kindle email on repeat polls", async () => {
    // The provider factory captures how many times `get` is called; the
    // cursor and the books UNIQUE constraint should together ensure one
    // book + two highlights regardless of a duplicate summary arriving.
    const sum = kindleSummary("outlook-acct", "msg-dup");
    const factory = kindleProviderFactory({
      summary: sum,
      html: KINDLE_NOTEBOOK_HTML,
    });
    const registry = makeRegistryWithProvider(["outlook"], "outlook", factory);
    const account = await seedAccount(registry, "outlook", "owner@outlook.com");
    sum.accountId = account.id;

    const poller = new MailPoller({
      registry,
      db,
      writeTracker,
      pollIntervalSeconds: 60,
      maxMessagesPerPoll: 20,
    });
    // First tick — book + 2 highlights inserted
    await (poller as unknown as { tick: () => Promise<void> }).tick();
    // Second tick — if the provider replays the same summary, the
    // insert-highlight dedup (content + book_id) prevents duplicates.
    await (poller as unknown as { tick: () => Promise<void> }).tick();

    const bookCount = db
      .prepare("SELECT COUNT(*) as c FROM books")
      .get() as { c: number };
    const hlCount = db
      .prepare("SELECT COUNT(*) as c FROM reading_highlights")
      .get() as { c: number };
    expect(bookCount.c).toBe(1);
    expect(hlCount.c).toBe(2);
  });

  it("inserts a travel_booking when a flight confirmation arrives at Outlook", async () => {
    // Parity with the Gmail branch: travel classification is now provider-
    // agnostic thanks to the shared ingestion module. A booking-confirm
    // email from JetBlue arriving at an Outlook mailbox should land in
    // travel_bookings just like it would for Gmail.
    const sum: MailMessageSummary = {
      accountId: "outlook-acct",
      providerMsgId: "travel-1",
      rfc822MsgId: null,
      threadId: null,
      folder: "Inbox",
      receivedAtUtc: "2026-04-14T08:00:00.000Z",
      subject: "Booking confirmation",
      from: { email: "noreply@jetblue.com", name: "JetBlue" },
      to: [],
      snippet: "Flight to New York confirmation number ABC12345 $350.00",
      isRead: false,
      flags: [],
      hasAttachment: false,
    };
    const factory: MailProviderFactory = (account) => ({
      kind: account.kind,
      account,
      list: async () => [],
      // After receipts scanning moved into the shared pipeline, travel
      // messages trigger one provider.get() per booking to harvest
      // attachments. Return the full summary with an empty attachments
      // list — no receipts expected for this test.
      get: async (id: string) => ({
        accountId: account.id,
        providerMsgId: id,
        rfc822MsgId: null,
        threadId: null,
        folder: "Inbox",
        receivedAtUtc: sum.receivedAtUtc,
        subject: sum.subject,
        from: sum.from,
        to: [],
        snippet: sum.snippet,
        isRead: false,
        flags: [],
        hasAttachment: false,
        body: {},
        attachments: [],
      }),
      send: async () => ({ id: "stub", isDraft: true }),
      modifyTags: async () => undefined,
      markRead: async () => undefined,
      trash: async () => undefined,
      listFolders: async () => [],
      async pollSince(): Promise<PollResult> {
        return {
          messages: [sum],
          removedIds: [],
          nextCursor: { kind: "graph", deltaLink: "https://x/delta" },
          drained: true,
        };
      },
      revoke: async () => undefined,
    });
    const registry = makeRegistryWithProvider(["outlook"], "outlook", factory);
    const account = await seedAccount(registry, "outlook", "owner@outlook.com");
    sum.accountId = account.id;

    const poller = new MailPoller({
      registry,
      db,
      writeTracker,
      pollIntervalSeconds: 60,
      maxMessagesPerPoll: 20,
    });
    await (poller as unknown as { tick: () => Promise<void> }).tick();

    const bookings = db
      .prepare(
        `SELECT type, provider, provider_msg_id, currency FROM travel_bookings`,
      )
      .all() as {
      type: string;
      provider: string;
      provider_msg_id: string;
      currency: string;
    }[];
    expect(bookings).toHaveLength(1);
    expect(bookings[0]).toMatchObject({
      type: "flight",
      provider: "JetBlue",
      // Namespaced key — aligns with parse_failures so IMAP UIDs from
      // different accounts cannot collide on the UNIQUE constraint.
      provider_msg_id: `mail:outlook:${account.id}:travel-1`,
      currency: "USD",
    });

    const obs = db
      .prepare("SELECT payload FROM observations")
      .all() as { payload: string }[];
    expect(obs).toHaveLength(1);
    const payload = JSON.parse(obs[0]!.payload);
    expect(payload.travelBookings).toBe(1);
  });

  it("detects receipt attachments on Outlook travel emails (parity with Gmail)", async () => {
    // The shared mail-ingestion pipeline now scans attachments for every
    // provider, so an Outlook flight confirmation with a PDF boarding pass
    // should produce a `receipts` row linked to the account_id — even
    // though the download route still returns 501 until OutlookProvider
    // implements getAttachment.
    const sum: MailMessageSummary = {
      accountId: "outlook-acct",
      providerMsgId: "travel-with-att",
      rfc822MsgId: null,
      threadId: null,
      folder: "Inbox",
      receivedAtUtc: "2026-04-14T08:00:00.000Z",
      subject: "JetBlue booking confirmation",
      from: { email: "noreply@jetblue.com", name: "JetBlue" },
      to: [],
      snippet: "Your flight to New York $350.00 confirmation ABC123",
      isRead: false,
      flags: [],
      hasAttachment: true,
    };
    const factory: MailProviderFactory = (account) => ({
      kind: account.kind,
      account,
      list: async () => [],
      get: async (id: string) => ({
        accountId: account.id,
        providerMsgId: id,
        rfc822MsgId: null,
        threadId: null,
        folder: "Inbox",
        receivedAtUtc: sum.receivedAtUtc,
        subject: sum.subject,
        from: sum.from,
        to: [],
        snippet: sum.snippet,
        isRead: false,
        flags: [],
        hasAttachment: true,
        body: {},
        attachments: [
          {
            id: "att-boarding-pass",
            filename: "boarding-pass.pdf",
            mimeType: "application/pdf",
            sizeBytes: 82_000,
          },
        ],
      }),
      send: async () => ({ id: "stub", isDraft: true }),
      modifyTags: async () => undefined,
      markRead: async () => undefined,
      trash: async () => undefined,
      listFolders: async () => [],
      async pollSince(): Promise<PollResult> {
        return {
          messages: [sum],
          removedIds: [],
          nextCursor: { kind: "graph", deltaLink: "https://x/delta" },
          drained: true,
        };
      },
      revoke: async () => undefined,
    });
    const registry = makeRegistryWithProvider(["outlook"], "outlook", factory);
    const account = await seedAccount(registry, "outlook", "owner@outlook.com");
    sum.accountId = account.id;

    const poller = new MailPoller({
      registry,
      db,
      writeTracker,
      pollIntervalSeconds: 60,
      maxMessagesPerPoll: 20,
    });
    await (poller as unknown as { tick: () => Promise<void> }).tick();

    const receipts = db
      .prepare(
        `SELECT provider_msg_id, attachment_id, filename, account_id, category FROM receipts`,
      )
      .all() as {
      provider_msg_id: string;
      attachment_id: string;
      filename: string;
      account_id: string;
      category: string;
    }[];
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({
      provider_msg_id: `mail:outlook:${account.id}:travel-with-att`,
      attachment_id: "att-boarding-pass",
      filename: "boarding-pass.pdf",
      account_id: account.id,
      category: "travel",
    });

    const payload = JSON.parse(
      (db.prepare("SELECT payload FROM observations").get() as { payload: string }).payload,
    );
    expect(payload.receipts).toBe(1);
  });
});

// §4.8 per-account integration gate inside MailPoller. Gmail / Outlook
// accounts must be skipped when their governing integration is in any
// non-direct mode (today: `delegated` or `disabled`); other providers
// (iCloud, IMAP, Yahoo) keep polling normally — the "non-Google /
// non-Outlook mail providers remain unaffected" invariant. The `disabled`
// branch is the pre-native bug closed by INTEGRATION_NATIVE_MODE_DESIGN.md
// Phase A: before the fix, flipping Gmail to `disabled` left the poller
// silently still polling.
describe("MailPoller — §4.8 non-direct-mode per-account suppression", () => {
  let db: Database.Database;
  let blobStore: MemoryBlobStore;
  let writeTracker: AgentWriteTracker;

  beforeEach(() => {
    db = new Database(":memory:");
    createSchema(db);
    blobStore = new MemoryBlobStore();
    writeTracker = new AgentWriteTracker();
  });

  afterEach(() => {
    db.close();
  });

  type IntegrationMode = "direct" | "delegated" | "disabled";

  /**
   * Seed `settings.integrations` with the requested modes for gmail and
   * outlook_mail. Calendar defaults to `direct` so it doesn't
   * accidentally interact with the predicate under test. The delegated
   * backend is hard-coded to `claude` — the per-account gate consults
   * mode only, never the backend identity, so a single fixed value is
   * sufficient for every test in this suite.
   */
  function setIntegrationModes(modes: {
    gmail?: IntegrationMode;
    outlook_mail?: IntegrationMode;
  }): void {
    const renderRow = (mode: IntegrationMode) => {
      const base: Record<string, unknown> = {
        mode,
        deniedTools: [],
        lastChangedAt: "2026-04-19T00:00:00Z",
      };
      if (mode === "delegated") {
        base.delegatedBackend = "claude";
      }
      if (mode === "native") {
        // Schema's `superRefine` requires `nativeBackend` when mode === "native".
        // The per-account gate consults mode only (`isIntegrationPollerless`),
        // never the backend identity, so a fixed value is sufficient for every
        // test in this suite — same convention as `delegatedBackend`.
        base.nativeBackend = "claude";
      }
      return base;
    };
    const payload: Record<string, unknown> = {
      gmail: renderRow(modes.gmail ?? "direct"),
      outlook_mail: renderRow(modes.outlook_mail ?? "direct"),
      google_calendar: renderRow("direct"),
    };
    db.prepare(
      `INSERT INTO settings (key, value_json, updated_at)
       VALUES ('integrations', ?, CURRENT_TIMESTAMP)
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json,
                                      updated_at = CURRENT_TIMESTAMP`,
    ).run(JSON.stringify(payload));
  }

  /**
   * Build a registry with both gmail and outlook factories wired up, each
   * returning the supplied scripted-poll mock. The tests drive the
   * accounts and modes; this helper only stamps out the boilerplate.
   */
  function buildDualKindRegistry(
    gmailPoll: ReturnType<typeof vi.fn>,
    outlookPoll: ReturnType<typeof vi.fn>,
  ): MailAccountRegistry {
    return new MailAccountRegistry({
      db,
      blobStore,
      getEnabledKinds: () => ["gmail", "outlook"],
      providerFactories: {
        gmail: (account) => ({ ...scriptedProvider(account), pollSince: gmailPoll }),
        outlook: (account) => ({ ...scriptedProvider(account), pollSince: outlookPoll }),
      },
      now: () => new Date("2026-04-16T12:00:00.000Z"),
    });
  }

  async function seedGmailAndOutlook(registry: MailAccountRegistry): Promise<void> {
    await registry.addAccount({
      kind: "gmail",
      email: "owner@gmail.test",
      authType: "oauth",
      secretPayload: "{}",
    });
    await registry.addAccount({
      kind: "outlook",
      email: "owner@outlook.test",
      authType: "oauth",
      secretPayload: "{}",
    });
  }

  function emptyImapResult() {
    return {
      messages: [] as MailMessageSummary[],
      removedIds: [] as string[],
      nextCursor: { kind: "imap" as const, folders: {} },
      drained: true,
    };
  }

  function emptyGraphResult() {
    return {
      messages: [] as MailMessageSummary[],
      removedIds: [] as string[],
      nextCursor: { kind: "graph" as const },
      drained: true,
    };
  }

  it("polls Gmail accounts normally when gmail is direct", async () => {
    const gmailPoll = vi.fn(async () => emptyImapResult());
    const outlookPoll = vi.fn(async () => emptyGraphResult());
    const registry = buildDualKindRegistry(gmailPoll, outlookPoll);
    await seedGmailAndOutlook(registry);

    setIntegrationModes({ gmail: "direct", outlook_mail: "direct" });

    const poller = new MailPoller({
      registry,
      db,
      writeTracker,
      pollIntervalSeconds: 60,
      maxMessagesPerPoll: 20,
    });

    await (poller as unknown as { tick: () => Promise<void> }).tick();
    expect(gmailPoll).toHaveBeenCalledTimes(1);
    expect(outlookPoll).toHaveBeenCalledTimes(1);
  });

  it("skips Gmail accounts on tick when gmail is delegated, leaves Outlook untouched", async () => {
    const gmailPoll = vi.fn(async () => emptyImapResult());
    const outlookPoll = vi.fn(async () => emptyGraphResult());
    const registry = buildDualKindRegistry(gmailPoll, outlookPoll);
    await seedGmailAndOutlook(registry);

    setIntegrationModes({ gmail: "delegated", outlook_mail: "direct" });

    const poller = new MailPoller({
      registry,
      db,
      writeTracker,
      pollIntervalSeconds: 60,
      maxMessagesPerPoll: 20,
    });

    await (poller as unknown as { tick: () => Promise<void> }).tick();
    expect(gmailPoll).not.toHaveBeenCalled();
    expect(outlookPoll).toHaveBeenCalled();
  });

  // INTEGRATION_NATIVE_MODE_DESIGN.md Phase A regression: a `disabled` flip
  // must stop Gmail polling within a single tick. Before the fix the
  // per-account gate only matched `delegated`, so `disabled`-mode Gmail
  // continued to be polled silently — and continued to record
  // `mail:lifecycle` observations the operator had explicitly opted out
  // of. The acceptance criterion is "no auth-fail dependency" — the
  // test asserts the skip on the very first tick, with healthy
  // credentials, not by virtue of an auth error stopping work later.
  it("skips Gmail accounts on tick when gmail is disabled (Phase A regression)", async () => {
    const gmailPoll = vi.fn(async () => emptyImapResult());
    const outlookPoll = vi.fn(async () => emptyGraphResult());
    const registry = buildDualKindRegistry(gmailPoll, outlookPoll);
    await seedGmailAndOutlook(registry);

    setIntegrationModes({ gmail: "disabled", outlook_mail: "direct" });

    const poller = new MailPoller({
      registry,
      db,
      writeTracker,
      pollIntervalSeconds: 60,
      maxMessagesPerPoll: 20,
    });

    await (poller as unknown as { tick: () => Promise<void> }).tick();
    expect(gmailPoll).not.toHaveBeenCalled();
    expect(outlookPoll).toHaveBeenCalled();

    // §4.8 invariant: disabled-mode accounts must produce zero
    // `mail:lifecycle` observations. Before the fix this was the
    // user-visible symptom — observations kept arriving from a key the
    // operator had disabled. Filter by source so the assertion does not
    // accidentally pass because of an unrelated observation kind, and
    // does not break if a future test infrastructure change starts
    // recording metadata rows in the same table.
    const obs = db
      .prepare(
        `SELECT COUNT(*) as c FROM observations WHERE source = 'mail:lifecycle'`,
      )
      .get() as { c: number };
    expect(obs.c).toBe(0);
  });

  // INTEGRATION_NATIVE_MODE_DESIGN.md §6.2 — native mode means the agent's
  // main backend reaches Gmail through its own MCP; the daemon does NOT
  // poll. Symmetric to the delegated and disabled skip tests above. The
  // assertion has to be that gmail.pollSince is not invoked even once on
  // the very first tick — there is no auth-fail dependency.
  it("skips Gmail accounts on tick when gmail is native", async () => {
    const gmailPoll = vi.fn(async () => emptyImapResult());
    const outlookPoll = vi.fn(async () => emptyGraphResult());
    const registry = buildDualKindRegistry(gmailPoll, outlookPoll);
    await seedGmailAndOutlook(registry);

    setIntegrationModes({ gmail: "native", outlook_mail: "direct" });

    const poller = new MailPoller({
      registry,
      db,
      writeTracker,
      pollIntervalSeconds: 60,
      maxMessagesPerPoll: 20,
    });

    await (poller as unknown as { tick: () => Promise<void> }).tick();
    expect(gmailPoll).not.toHaveBeenCalled();
    expect(outlookPoll).toHaveBeenCalled();

    // §8.3 invariant: native-mode accounts must produce zero daemon-side
    // `mail:lifecycle` observations. The agent POSTs to `/api/observations`
    // in-turn instead; that path is not exercised in this poller test.
    const obs = db
      .prepare(
        `SELECT COUNT(*) as c FROM observations WHERE source = 'mail:lifecycle'`,
      )
      .get() as { c: number };
    expect(obs.c).toBe(0);
  });

  it("skips Outlook accounts when outlook_mail is delegated", async () => {
    const gmailPoll = vi.fn(async () => emptyImapResult());
    const outlookPoll = vi.fn(async () => emptyGraphResult());
    const registry = buildDualKindRegistry(gmailPoll, outlookPoll);
    await seedGmailAndOutlook(registry);

    setIntegrationModes({ gmail: "direct", outlook_mail: "delegated" });

    const poller = new MailPoller({
      registry,
      db,
      writeTracker,
      pollIntervalSeconds: 60,
      maxMessagesPerPoll: 20,
    });

    await (poller as unknown as { tick: () => Promise<void> }).tick();
    expect(outlookPoll).not.toHaveBeenCalled();
    expect(gmailPoll).toHaveBeenCalled();
  });

  it("skips Outlook accounts when outlook_mail is disabled (Phase A regression)", async () => {
    const gmailPoll = vi.fn(async () => emptyImapResult());
    const outlookPoll = vi.fn(async () => emptyGraphResult());
    const registry = buildDualKindRegistry(gmailPoll, outlookPoll);
    await seedGmailAndOutlook(registry);

    setIntegrationModes({ gmail: "direct", outlook_mail: "disabled" });

    const poller = new MailPoller({
      registry,
      db,
      writeTracker,
      pollIntervalSeconds: 60,
      maxMessagesPerPoll: 20,
    });

    await (poller as unknown as { tick: () => Promise<void> }).tick();
    expect(outlookPoll).not.toHaveBeenCalled();
    expect(gmailPoll).toHaveBeenCalled();
  });

  it("keeps polling iCloud accounts regardless of gmail mode (provider-not-bound invariant)", async () => {
    // iCloud is an IMAP provider with no integration-descriptor binding —
    // its kind is not in the `isAccountManagedExternally` whitelist, so
    // it MUST poll on every tick irrespective of unrelated integration
    // state. This is the §4.8 "other providers (iCloud / IMAP / Yahoo)
    // remain unaffected" invariant.
    const icloudPoll = vi.fn(async () => emptyImapResult());
    const registry = new MailAccountRegistry({
      db,
      blobStore,
      getEnabledKinds: () => ["icloud"],
      providerFactories: {
        icloud: (account) => ({ ...scriptedProvider(account), pollSince: icloudPoll }),
      },
      now: () => new Date("2026-04-16T12:00:00.000Z"),
    });
    await registry.addAccount({
      kind: "icloud",
      email: "owner@icloud.test",
      authType: "app_password",
      secretPayload: "{}",
    });

    // Flip gmail to disabled and outlook_mail to delegated — neither
    // should affect iCloud polling.
    setIntegrationModes({ gmail: "disabled", outlook_mail: "delegated" });

    const poller = new MailPoller({
      registry,
      db,
      writeTracker,
      pollIntervalSeconds: 60,
      maxMessagesPerPoll: 20,
    });

    await (poller as unknown as { tick: () => Promise<void> }).tick();
    expect(icloudPoll).toHaveBeenCalledTimes(1);
  });

  // INTEGRATION_NATIVE_MODE_DESIGN.md §6.2 wiring requirement: the IDLE
  // control flow must also honour the predicate. Without the
  // `onDirty`-callback re-check, a mode flip to disabled / delegated
  // between IDLE startup and the next tick would let one stray poll
  // through (the callback fires before `stopIdleForInactiveAccounts`
  // gets a chance to tear IDLE down on the next tick boundary). This
  // test simulates that race by manually invoking the `onDirty`
  // callback after flipping the mode.
  it("ignores IDLE-triggered polls when the integration flipped to disabled mid-stream", async () => {
    const gmailPoll = vi.fn(async () => emptyImapResult());
    const startIdle = vi.fn();
    const stopIdle = vi.fn();
    let capturedOnDirty: (() => void) | null = null;

    // Hand-rolled IMAP-style provider that captures the IDLE callback so
    // the test can fire it manually after a mode flip. We can't reuse
    // `scriptedProvider` because it doesn't model the IDLE surface.
    const registry = new MailAccountRegistry({
      db,
      blobStore,
      getEnabledKinds: () => ["gmail"],
      providerFactories: {
        gmail: (account) => ({
          kind: account.kind,
          account,
          list: async () => [],
          get: async () => {
            throw new Error("stub get");
          },
          send: async () => ({ id: "stub", isDraft: true }),
          modifyTags: async () => undefined,
          markRead: async () => undefined,
          trash: async () => undefined,
          listFolders: async () => [],
          pollSince: gmailPoll,
          revoke: async () => undefined,
          startIdle: async (opts: { onDirty: () => void }) => {
            startIdle();
            capturedOnDirty = opts.onDirty;
          },
          stopIdle: async () => {
            stopIdle();
          },
        }),
      },
      now: () => new Date("2026-04-16T12:00:00.000Z"),
    });

    const gmailAccount = await registry.addAccount({
      kind: "gmail",
      email: "owner@gmail.test",
      authType: "oauth",
      secretPayload: "{}",
    });
    // Toggle IDLE on for this account so `ensureIdle` runs.
    db.prepare(`UPDATE mail_accounts SET idle_enabled = 1 WHERE id = ?`).run(
      gmailAccount.id,
    );

    setIntegrationModes({ gmail: "direct" });

    const poller = new MailPoller({
      registry,
      db,
      writeTracker,
      pollIntervalSeconds: 60,
      maxMessagesPerPoll: 20,
    });

    await (poller as unknown as { tick: () => Promise<void> }).tick();
    expect(startIdle).toHaveBeenCalledTimes(1);
    expect(capturedOnDirty).not.toBeNull();
    const pollsAfterFirstTick = gmailPoll.mock.calls.length;

    // Mode flips out from under us. The next IDLE event must not trigger
    // a stray poll, even though no tick has yet had a chance to tear
    // IDLE down.
    setIntegrationModes({ gmail: "disabled" });
    capturedOnDirty!();
    // Drain the microtask queue so any (incorrect) poll the callback
    // scheduled would have run by now.
    await new Promise((resolve) => setImmediate(resolve));

    expect(gmailPoll.mock.calls.length).toBe(pollsAfterFirstTick);
  });
});

describe("MailPoller — per-kind poll throttle (gmailPollIntervalSeconds)", () => {
  let db: Database.Database;
  let blobStore: MemoryBlobStore;
  let writeTracker: AgentWriteTracker;

  beforeEach(() => {
    db = new Database(":memory:");
    createSchema(db);
    seedDirectMailIntegrations(db);
    blobStore = new MemoryBlobStore();
    writeTracker = new AgentWriteTracker();
  });

  afterEach(() => {
    db.close();
    vi.useRealTimers();
  });

  function emptyResult() {
    return {
      messages: [] as MailMessageSummary[],
      removedIds: [] as string[],
      nextCursor: { kind: "imap" as const, folders: {} },
      drained: true,
    };
  }

  it("polls Gmail on the first tick and skips until the throttle window elapses", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-16T12:00:00.000Z"));

    const gmailPoll = vi.fn(async () => emptyResult());
    const outlookPoll = vi.fn(async () => emptyResult());

    const registry = new MailAccountRegistry({
      db,
      blobStore,
      getEnabledKinds: () => ["gmail", "outlook"],
      providerFactories: {
        gmail: (account) => ({ ...scriptedProvider(account), pollSince: gmailPoll }),
        outlook: (account) => ({ ...scriptedProvider(account), pollSince: outlookPoll }),
      },
      now: () => new Date("2026-04-16T12:00:00.000Z"),
    });

    await registry.addAccount({
      kind: "gmail",
      email: "owner@gmail.test",
      authType: "oauth",
      secretPayload: "{}",
    });
    await registry.addAccount({
      kind: "outlook",
      email: "owner@outlook.test",
      authType: "oauth",
      secretPayload: "{}",
    });

    const poller = new MailPoller({
      registry,
      db,
      writeTracker,
      pollIntervalSeconds: 60,
      maxMessagesPerPoll: 20,
      providerPollIntervalsSeconds: { gmail: 600 },
    });

    // First tick — cold cache, Gmail should poll.
    await (poller as unknown as { tick: () => Promise<void> }).tick();
    expect(gmailPoll).toHaveBeenCalledTimes(1);
    expect(outlookPoll).toHaveBeenCalledTimes(1);

    // Advance 5 minutes (< 10-minute throttle). Gmail stays idle, Outlook keeps polling.
    vi.setSystemTime(new Date("2026-04-16T12:05:00.000Z"));
    await (poller as unknown as { tick: () => Promise<void> }).tick();
    expect(gmailPoll).toHaveBeenCalledTimes(1);
    expect(outlookPoll).toHaveBeenCalledTimes(2);

    // Advance to 11 minutes total (> 10-minute throttle). Gmail polls again.
    vi.setSystemTime(new Date("2026-04-16T12:11:00.000Z"));
    await (poller as unknown as { tick: () => Promise<void> }).tick();
    expect(gmailPoll).toHaveBeenCalledTimes(2);
    expect(outlookPoll).toHaveBeenCalledTimes(3);
  });

  it("does not throttle kinds without a configured interval", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-16T12:00:00.000Z"));

    const outlookPoll = vi.fn(async () => emptyResult());

    const registry = new MailAccountRegistry({
      db,
      blobStore,
      getEnabledKinds: () => ["outlook"],
      providerFactories: {
        outlook: (account) => ({ ...scriptedProvider(account), pollSince: outlookPoll }),
      },
      now: () => new Date("2026-04-16T12:00:00.000Z"),
    });

    await registry.addAccount({
      kind: "outlook",
      email: "owner@outlook.test",
      authType: "oauth",
      secretPayload: "{}",
    });

    // Gmail throttle is set but we only have Outlook accounts — Outlook must
    // tick unconditionally.
    const poller = new MailPoller({
      registry,
      db,
      writeTracker,
      pollIntervalSeconds: 60,
      maxMessagesPerPoll: 20,
      providerPollIntervalsSeconds: { gmail: 600 },
    });

    await (poller as unknown as { tick: () => Promise<void> }).tick();
    vi.setSystemTime(new Date("2026-04-16T12:00:30.000Z"));
    await (poller as unknown as { tick: () => Promise<void> }).tick();
    vi.setSystemTime(new Date("2026-04-16T12:01:00.000Z"));
    await (poller as unknown as { tick: () => Promise<void> }).tick();
    expect(outlookPoll).toHaveBeenCalledTimes(3);
  });

  it("polls ALL accounts of a throttled kind in a single tick, not just the first", async () => {
    // Regression: an earlier version stamped `lastKindPollAtMs` inside the
    // per-account loop, so the second gmail account in the same tick would
    // see elapsed ≈ 0 and get silently skipped. The fix moves the
    // throttle decision to the top of the tick (once per kind).
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-16T12:00:00.000Z"));

    const gmailPoll = vi.fn(async () => emptyResult());

    const registry = new MailAccountRegistry({
      db,
      blobStore,
      getEnabledKinds: () => ["gmail"],
      providerFactories: {
        gmail: (account) => ({ ...scriptedProvider(account), pollSince: gmailPoll }),
      },
      now: () => new Date("2026-04-16T12:00:00.000Z"),
    });

    await registry.addAccount({
      kind: "gmail",
      email: "alpha@gmail.test",
      authType: "oauth",
      secretPayload: "{}",
    });
    await registry.addAccount({
      kind: "gmail",
      email: "beta@gmail.test",
      authType: "oauth",
      secretPayload: "{}",
    });

    const poller = new MailPoller({
      registry,
      db,
      writeTracker,
      pollIntervalSeconds: 60,
      maxMessagesPerPoll: 20,
      providerPollIntervalsSeconds: { gmail: 600 },
    });

    await (poller as unknown as { tick: () => Promise<void> }).tick();
    // Both gmail accounts polled on the first tick.
    expect(gmailPoll).toHaveBeenCalledTimes(2);

    // Within the throttle window, both accounts are skipped together.
    vi.setSystemTime(new Date("2026-04-16T12:05:00.000Z"));
    await (poller as unknown as { tick: () => Promise<void> }).tick();
    expect(gmailPoll).toHaveBeenCalledTimes(2);

    // Past the throttle window, both accounts poll together again.
    vi.setSystemTime(new Date("2026-04-16T12:11:00.000Z"));
    await (poller as unknown as { tick: () => Promise<void> }).tick();
    expect(gmailPoll).toHaveBeenCalledTimes(4);
  });

  it("treats a zero or negative per-kind interval as no throttle", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-16T12:00:00.000Z"));

    const gmailPoll = vi.fn(async () => emptyResult());

    const registry = new MailAccountRegistry({
      db,
      blobStore,
      getEnabledKinds: () => ["gmail"],
      providerFactories: {
        gmail: (account) => ({ ...scriptedProvider(account), pollSince: gmailPoll }),
      },
      now: () => new Date("2026-04-16T12:00:00.000Z"),
    });

    await registry.addAccount({
      kind: "gmail",
      email: "owner@gmail.test",
      authType: "oauth",
      secretPayload: "{}",
    });

    const poller = new MailPoller({
      registry,
      db,
      writeTracker,
      pollIntervalSeconds: 60,
      maxMessagesPerPoll: 20,
      providerPollIntervalsSeconds: { gmail: 0 },
    });

    await (poller as unknown as { tick: () => Promise<void> }).tick();
    vi.setSystemTime(new Date("2026-04-16T12:00:10.000Z"));
    await (poller as unknown as { tick: () => Promise<void> }).tick();
    expect(gmailPoll).toHaveBeenCalledTimes(2);
  });
});
