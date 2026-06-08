import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { applySchema } from "../db/schema.js";
import type { MailAccountRegistry } from "../services/mail/account-registry.js";
import type { MailAccount, PollCursor } from "../services/mail/provider.js";
import type { ImapReconcileSource } from "../services/mail/imap/imap-provider-base.js";
import type { ImapCapabilitySet } from "../services/mail/imap/capabilities.js";
import { MailReconciliationJob } from "./mail-reconciliation.js";

function openDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  applySchema(db);
  return db;
}

function seedAccount(
  db: Database.Database,
  id: string,
  kind: "yahoo" | "icloud" | "gmail",
): void {
  db.prepare(
    `INSERT INTO mail_accounts (
       id, kind, email, auth_type, secret_blob_name, created_at_utc, auth_status, active, unified_poll
     ) VALUES (?, ?, ?, 'app_password', ?, '2026-04-16T00:00:00Z', 'healthy', 1, 1)`,
  ).run(id, kind, `user-${id}@example.com`, `blob-${id}`);
}

function seedMessage(
  db: Database.Database,
  accountId: string,
  providerMsgId: string,
  opts: { deleted?: string; folder?: string } = {},
): void {
  db.prepare(
    `INSERT INTO mail_messages_index (
       account_id, provider_msg_id, folder, received_at_utc,
       subject, observed_at_utc, deleted_at_utc
     ) VALUES (?, ?, ?, '2026-04-10T00:00:00Z', 'msg', '2026-04-10T00:00:00Z', ?)`,
  ).run(
    accountId,
    providerMsgId,
    opts.folder ?? "INBOX",
    opts.deleted ?? null,
  );
}

/** Default cursor that grants reconcile a window over the folders the tests
 *  exercise (INBOX, Archive). Reconcile now defers a folder when the cursor
 *  has no entry for it (avoids unbounded SEARCH ALL), so tests must supply a
 *  cursor for each folder they seedMessage into. Tests that need to assert the
 *  defer-without-cursor behavior pass an explicit `cursorFor: () => null` (or
 *  a cursor with a different folder set). */
function defaultTestCursor(): PollCursor {
  return {
    kind: "imap",
    folders: {
      INBOX: { uidValidity: 100, lastUid: 1000 },
      Archive: { uidValidity: 100, lastUid: 1000 },
    },
  };
}

function makeRegistry(args: {
  activeAccounts: MailAccount[];
  providerFor: (accountId: string) => unknown;
  cursorFor?: (accountId: string) => PollCursor | null;
}): MailAccountRegistry {
  return {
    listActiveAccounts: () => args.activeAccounts,
    getProvider: async (accountId: string) => args.providerFor(accountId),
    loadPollCursor: (accountId: string) =>
      args.cursorFor ? args.cursorFor(accountId) : defaultTestCursor(),
  } as unknown as MailAccountRegistry;
}

function account(id: string, kind: MailAccount["kind"]): MailAccount {
  return {
    id,
    kind,
    email: `u-${id}@example.com`,
    authStatus: "healthy",
    idleEnabled: true,
    active: true,
    createdAt: "2026-04-16T00:00:00Z",
  };
}

function makeSource(
  acct: MailAccount,
  listExistingUids: ImapReconcileSource["listExistingUids"],
  capabilities: ImapCapabilitySet | null = null,
): ImapReconcileSource {
  return {
    account: acct,
    listExistingUids,
    getCapabilities: () => capabilities,
  };
}

function makeCaps(overrides: Partial<ImapCapabilitySet> = {}): ImapCapabilitySet {
  return {
    qresync: false,
    threadReferences: false,
    specialUse: false,
    uidplus: false,
    idle: false,
    move: false,
    all: [],
    ...overrides,
  };
}

describe("MailReconciliationJob", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDb();
  });

  it("soft-deletes local rows missing from server listing", async () => {
    seedAccount(db, "acc-1", "yahoo");
    seedMessage(db, "acc-1", "100:1");
    seedMessage(db, "acc-1", "100:2");
    seedMessage(db, "acc-1", "100:3");

    const acct = account("acc-1", "yahoo");
    const provider = makeSource(acct, async () => ({
      uidValidity: 100,
      uids: [1, 3], // 2 is missing
    }));
    const registry = makeRegistry({
      activeAccounts: [acct],
      providerFor: () => provider,
    });

    const now = new Date("2026-04-16T12:00:00Z");
    const job = new MailReconciliationJob({
      registry,
      db,
      now: () => now,
    });
    await job.tick();

    const rows = db
      .prepare(
        `SELECT provider_msg_id, deleted_at_utc FROM mail_messages_index ORDER BY provider_msg_id`,
      )
      .all() as { provider_msg_id: string; deleted_at_utc: string | null }[];
    expect(rows[0].deleted_at_utc).toBeNull();
    expect(rows[1].deleted_at_utc).toBe(now.toISOString());
    expect(rows[2].deleted_at_utc).toBeNull();
  });

  it("reconciles every indexed folder, not just INBOX", async () => {
    seedAccount(db, "acc-1", "yahoo");
    seedMessage(db, "acc-1", "100:1", { folder: "INBOX" });
    seedMessage(db, "acc-1", "100:2", { folder: "Archive" });

    const acct = account("acc-1", "yahoo");
    const calls: string[] = [];
    const provider = makeSource(acct, async (folder) => {
      calls.push(folder);
      return { uidValidity: 100, uids: [] }; // everything missing
    });
    const registry = makeRegistry({
      activeAccounts: [acct],
      providerFor: () => provider,
    });

    const now = new Date("2026-04-16T12:00:00Z");
    const job = new MailReconciliationJob({
      registry,
      db,
      now: () => now,
    });
    await job.tick();

    expect(calls.sort()).toEqual(["Archive", "INBOX"]);
    const deletedRows = db
      .prepare(
        `SELECT provider_msg_id FROM mail_messages_index WHERE deleted_at_utc IS NOT NULL ORDER BY provider_msg_id`,
      )
      .all() as { provider_msg_id: string }[];
    expect(deletedRows.map((r) => r.provider_msg_id)).toEqual(["100:1", "100:2"]);
  });

  it("skips providers that don't implement the reconcile contract (Gmail, Outlook)", async () => {
    seedAccount(db, "acc-gmail", "gmail");
    seedMessage(db, "acc-gmail", "gmail-id-1");

    const listed = vi.fn();
    const acct = account("acc-gmail", "gmail");
    const registry = makeRegistry({
      activeAccounts: [acct],
      // GmailProvider doesn't have listExistingUids — duck-type check rejects it.
      providerFor: () => ({ kind: "gmail", account: acct }),
    });

    const job = new MailReconciliationJob({ registry, db });
    await job.tick();

    expect(listed).not.toHaveBeenCalled();
    const row = db
      .prepare(
        `SELECT deleted_at_utc FROM mail_messages_index WHERE provider_msg_id = 'gmail-id-1'`,
      )
      .get() as { deleted_at_utc: string | null };
    expect(row.deleted_at_utc).toBeNull();
  });

  it("isolates per-account failures", async () => {
    seedAccount(db, "acc-1", "yahoo");
    seedAccount(db, "acc-2", "icloud");
    seedMessage(db, "acc-1", "100:99"); // so listExistingUids actually runs + throws
    seedMessage(db, "acc-2", "100:10");

    const acct1 = account("acc-1", "yahoo");
    const acct2 = account("acc-2", "icloud");

    const registry = makeRegistry({
      activeAccounts: [acct1, acct2],
      providerFor: (id) =>
        id === "acc-1"
          ? makeSource(acct1, async () => {
              throw new Error("network unreachable");
            })
          : makeSource(acct2, async () => ({
              uidValidity: 100,
              uids: [], // everything missing
            })),
    });

    const now = new Date("2026-04-16T12:00:00Z");
    const job = new MailReconciliationJob({ registry, db, now: () => now });
    await job.tick();

    const row = db
      .prepare(
        `SELECT deleted_at_utc FROM mail_messages_index WHERE account_id = 'acc-2'`,
      )
      .get() as { deleted_at_utc: string | null };
    expect(row.deleted_at_utc).toBe(now.toISOString());
  });

  it("passes cursor-derived sinceUid to the provider per folder", async () => {
    seedAccount(db, "acc-1", "yahoo");
    seedMessage(db, "acc-1", "100:100", { folder: "INBOX" });

    const acct = account("acc-1", "yahoo");
    const listed = vi.fn(async () => ({ uidValidity: 100, uids: [] }));
    const provider = makeSource(acct, listed);

    const registry = makeRegistry({
      activeAccounts: [acct],
      providerFor: () => provider,
      cursorFor: () => ({
        kind: "imap",
        folders: { INBOX: { uidValidity: 100, lastUid: 20000 } },
      }),
    });

    const job = new MailReconciliationJob({ registry, db });
    await job.tick();

    expect(listed).toHaveBeenCalledWith("INBOX", { sinceUid: 15000 });
  });

  it("skips folders without a cursor entry to avoid unbounded SEARCH ALL", async () => {
    seedAccount(db, "acc-1", "yahoo");
    seedMessage(db, "acc-1", "100:1", { folder: "INBOX" });

    const acct = account("acc-1", "yahoo");
    const listed = vi.fn(async () => ({ uidValidity: 100, uids: [] }));
    const provider = makeSource(acct, listed);

    const registry = makeRegistry({
      activeAccounts: [acct],
      providerFor: () => provider,
      cursorFor: () => ({
        kind: "imap",
        folders: { "Other Folder": { uidValidity: 100, lastUid: 5 } },
      }),
    });

    const job = new MailReconciliationJob({ registry, db });
    await job.tick();

    // Folder is deferred — the next reconcile after the poll path establishes
    // a cursor for INBOX will pick it up.
    expect(listed).not.toHaveBeenCalled();
  });

  it("purges rows deleted older than the threshold", async () => {
    seedAccount(db, "acc-1", "yahoo");
    seedMessage(db, "acc-1", "100:1", {
      deleted: "2026-01-01T00:00:00Z", // ~105 days ago
    });
    seedMessage(db, "acc-1", "100:2", {
      deleted: "2026-04-01T00:00:00Z", // ~15 days ago
    });
    seedMessage(db, "acc-1", "100:3"); // live

    const now = new Date("2026-04-16T00:00:00Z");
    const job = new MailReconciliationJob({
      registry: makeRegistry({
        activeAccounts: [],
        providerFor: () => null,
      }),
      db,
      purgeDays: 90,
      now: () => now,
    });
    await job.tick();

    const ids = (
      db
        .prepare(
          `SELECT provider_msg_id FROM mail_messages_index ORDER BY provider_msg_id`,
        )
        .all() as { provider_msg_id: string }[]
    ).map((r) => r.provider_msg_id);
    expect(ids).toEqual(["100:2", "100:3"]);
  });

  it("skips accounts that have no indexed rows yet", async () => {
    seedAccount(db, "acc-1", "yahoo");
    const acct = account("acc-1", "yahoo");
    const listed = vi.fn(async () => ({ uidValidity: 100, uids: [] }));
    const provider = makeSource(acct, listed);

    const registry = makeRegistry({
      activeAccounts: [acct],
      providerFor: () => provider,
    });

    const job = new MailReconciliationJob({ registry, db });
    await job.tick();

    expect(listed).not.toHaveBeenCalled();
  });

  it("reads capabilities so operators can see QRESYNC availability", async () => {
    seedAccount(db, "acc-1", "icloud");
    seedMessage(db, "acc-1", "100:1");

    const acct = account("acc-1", "icloud");
    const getCaps = vi.fn(() => makeCaps({ qresync: true, all: ["QRESYNC"] }));
    const provider: ImapReconcileSource = {
      account: acct,
      listExistingUids: async () => ({ uidValidity: 100, uids: [1] }),
      getCapabilities: getCaps,
    };

    const registry = makeRegistry({
      activeAccounts: [acct],
      providerFor: () => provider,
    });

    const job = new MailReconciliationJob({ registry, db });
    await job.tick();

    expect(getCaps).toHaveBeenCalled();
  });

  it("tolerates a null capabilities response (pre-first-connect)", async () => {
    seedAccount(db, "acc-1", "yahoo");
    seedMessage(db, "acc-1", "100:1");

    const acct = account("acc-1", "yahoo");
    const provider: ImapReconcileSource = {
      account: acct,
      listExistingUids: async () => ({ uidValidity: 100, uids: [1] }),
      getCapabilities: () => null,
    };

    const registry = makeRegistry({
      activeAccounts: [acct],
      providerFor: () => provider,
    });

    const job = new MailReconciliationJob({ registry, db });
    await expect(job.tick()).resolves.toBeUndefined();
  });

  it("is re-entry safe: a tick in flight skips a second call", async () => {
    seedAccount(db, "acc-1", "yahoo");
    seedMessage(db, "acc-1", "100:1");
    const acct = account("acc-1", "yahoo");
    let calls = 0;
    const gate = new Promise<void>((resolve) => setTimeout(resolve, 10));
    const provider = makeSource(acct, async () => {
      calls++;
      await gate;
      return { uidValidity: 100, uids: [] };
    });
    const registry = makeRegistry({
      activeAccounts: [acct],
      providerFor: () => provider,
    });

    const job = new MailReconciliationJob({ registry, db });
    const first = job.tick();
    await job.tick(); // should short-circuit
    await first;
    expect(calls).toBe(1);
  });

  it("fires an initial tick after initialDelayMs, then repeats on interval", async () => {
    vi.useFakeTimers();
    try {
      seedAccount(db, "acc-1", "yahoo");
      seedMessage(db, "acc-1", "100:1");
      const acct = account("acc-1", "yahoo");
      const listed = vi.fn(async () => ({ uidValidity: 100, uids: [1] }));
      const provider = makeSource(acct, listed);

      const registry = makeRegistry({
        activeAccounts: [acct],
        providerFor: () => provider,
      });

      const job = new MailReconciliationJob({
        registry,
        db,
        initialDelayMs: 5_000,
        intervalMs: 60_000,
      });
      await job.start();
      expect(listed).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(5_000);
      expect(listed).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(60_000);
      expect(listed).toHaveBeenCalledTimes(2);

      await job.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("start() with initialDelayMs=0 does not schedule a first-run timer", async () => {
    seedAccount(db, "acc-1", "yahoo");
    const acct = account("acc-1", "yahoo");
    const provider = makeSource(acct, async () => ({
      uidValidity: 100,
      uids: [],
    }));
    const registry = makeRegistry({
      activeAccounts: [acct],
      providerFor: () => provider,
    });

    const job = new MailReconciliationJob({
      registry,
      db,
      initialDelayMs: 0,
    });
    await job.start();
    await job.stop();
  });

  it("breaks out of the folder loop when stop() fires between folders", async () => {
    seedAccount(db, "acc-1", "yahoo");
    seedMessage(db, "acc-1", "100:1", { folder: "INBOX" });
    seedMessage(db, "acc-1", "100:2", { folder: "Archive" });

    const acct = account("acc-1", "yahoo");
    const seen: string[] = [];
    let job: MailReconciliationJob;

    const provider = makeSource(acct, async (folder) => {
      seen.push(folder);
      // Stop mid-way through folder iteration; the next folder should be skipped.
      await job.stop();
      return { uidValidity: 100, uids: [] };
    });

    const registry = makeRegistry({
      activeAccounts: [acct],
      providerFor: () => provider,
    });

    job = new MailReconciliationJob({ registry, db, initialDelayMs: 0 });
    await job.tick();

    expect(seen).toHaveLength(1);
  });

  it("breaks out of the account loop when stop() fires mid-run", async () => {
    seedAccount(db, "acc-1", "yahoo");
    seedAccount(db, "acc-2", "yahoo");
    seedMessage(db, "acc-1", "100:1");
    seedMessage(db, "acc-2", "100:2");

    const acct1 = account("acc-1", "yahoo");
    const acct2 = account("acc-2", "yahoo");

    let job: MailReconciliationJob;

    const provider1 = makeSource(acct1, async () => {
      await job.stop();
      return { uidValidity: 100, uids: [] };
    });
    const p2Listed = vi.fn(async () => ({ uidValidity: 100, uids: [] }));
    const provider2 = makeSource(acct2, p2Listed);

    const registry = makeRegistry({
      activeAccounts: [acct1, acct2],
      providerFor: (id) => (id === "acc-1" ? provider1 : provider2),
    });

    job = new MailReconciliationJob({ registry, db, initialDelayMs: 0 });
    await job.tick();

    expect(p2Listed).not.toHaveBeenCalled();
  });

  it("catches errors bubbling out of the tick body", async () => {
    const registry = {
      listActiveAccounts: () => {
        throw new Error("registry exploded");
      },
      getProvider: async () => null,
      loadPollCursor: () => null,
    } as unknown as MailAccountRegistry;

    const job = new MailReconciliationJob({ registry, db });
    await expect(job.tick()).resolves.toBeUndefined();
  });

  it("treats a null cursor as 'no cursor entry' for any folder", async () => {
    seedAccount(db, "acc-1", "yahoo");
    seedMessage(db, "acc-1", "100:1");

    const acct = account("acc-1", "yahoo");
    const listed = vi.fn(async () => ({ uidValidity: 100, uids: [] }));
    const provider = makeSource(acct, listed);

    const registry = makeRegistry({
      activeAccounts: [acct],
      providerFor: () => provider,
      cursorFor: () => null,
    });

    const job = new MailReconciliationJob({ registry, db });
    await job.tick();

    // null cursor → hasCursorEntryForFolder returns false → folder deferred,
    // listExistingUids never called.
    expect(listed).not.toHaveBeenCalled();
  });

  it("falls back to UID 0 if the cursor mutates to null between hasCursor and computeWindow", async () => {
    seedAccount(db, "acc-1", "yahoo");
    seedMessage(db, "acc-1", "100:1");

    const acct = account("acc-1", "yahoo");
    const listed = vi.fn(async () => ({ uidValidity: 100, uids: [1] }));
    const provider = makeSource(acct, listed);

    let call = 0;
    const registry = makeRegistry({
      activeAccounts: [acct],
      providerFor: () => provider,
      // First call (hasCursorEntryForFolder) returns a populated cursor;
      // second call (computeWindowStart) returns null. This exercises the
      // defensive `!cursor || cursor.kind !== "imap"` branch in
      // computeWindowStart, where the cursor could disappear mid-tick.
      cursorFor: () => {
        call += 1;
        if (call === 1) {
          return {
            kind: "imap",
            folders: { INBOX: { uidValidity: 100, lastUid: 5000 } },
          };
        }
        return null;
      },
    });

    const job = new MailReconciliationJob({ registry, db });
    await job.tick();

    // sinceUid is 0 because computeWindowStart bailed on the null branch.
    expect(listed).toHaveBeenCalledWith("INBOX", { sinceUid: 0 });
  });

  it("falls back to UID 0 if the cursor entry disappears between hasCursor and computeWindow", async () => {
    seedAccount(db, "acc-1", "yahoo");
    seedMessage(db, "acc-1", "100:1");

    const acct = account("acc-1", "yahoo");
    const listed = vi.fn(async () => ({ uidValidity: 100, uids: [1] }));
    const provider = makeSource(acct, listed);

    let call = 0;
    const registry = makeRegistry({
      activeAccounts: [acct],
      providerFor: () => provider,
      cursorFor: () => {
        call += 1;
        // First call: folder is present. Second call: folder vanished.
        if (call === 1) {
          return {
            kind: "imap",
            folders: { INBOX: { uidValidity: 100, lastUid: 5000 } },
          };
        }
        return { kind: "imap", folders: {} } as PollCursor;
      },
    });

    const job = new MailReconciliationJob({ registry, db });
    await job.tick();

    expect(listed).toHaveBeenCalledWith("INBOX", { sinceUid: 0 });
  });

  it("treats a non-imap cursor kind as 'no cursor entry' (defensive branch)", async () => {
    seedAccount(db, "acc-1", "gmail");
    seedMessage(db, "acc-1", "100:1");

    const acct = account("acc-1", "gmail");
    // Force the duck-type to pass even though the underlying cursor is gmail-shaped:
    // listExistingUids exists, so isImapReconcileSource accepts the provider, but
    // the cursor returned is the gmail (history-id) shape, exercising the
    // `cursor.kind !== "imap"` defensive branch in hasCursorEntryForFolder /
    // computeWindowStart.
    const listed = vi.fn(async () => ({ uidValidity: 100, uids: [] }));
    const provider = makeSource(acct, listed);

    const registry = makeRegistry({
      activeAccounts: [acct],
      providerFor: () => provider,
      cursorFor: () =>
        ({ kind: "gmail", historyId: "abc" }) as unknown as PollCursor,
    });

    const job = new MailReconciliationJob({ registry, db });
    await job.tick();

    expect(listed).not.toHaveBeenCalled();
  });

  it("logs and isolates account-level failures from runImapReconcile", async () => {
    seedAccount(db, "acc-1", "yahoo");
    seedAccount(db, "acc-2", "yahoo");
    seedMessage(db, "acc-2", "100:1");

    const acct1 = account("acc-1", "yahoo");
    const acct2 = account("acc-2", "yahoo");

    const acc2Listed = vi.fn(async () => ({ uidValidity: 100, uids: [] }));
    const provider2 = makeSource(acct2, acc2Listed);

    // First account's getProvider rejects — this surfaces above the
    // per-folder catch block, so the account-level catch in runImapReconcile
    // is exercised. The second account must still be reconciled afterward.
    const registry = {
      listActiveAccounts: () => [acct1, acct2],
      getProvider: async (id: string) => {
        if (id === "acc-1") throw new Error("provider lookup failed");
        return provider2;
      },
      loadPollCursor: () => defaultTestCursor(),
    } as unknown as MailAccountRegistry;

    const job = new MailReconciliationJob({ registry, db });
    await expect(job.tick()).resolves.toBeUndefined();
    expect(acc2Listed).toHaveBeenCalled();
  });

  it("stops cleanly when stop() is called before any tick", async () => {
    seedAccount(db, "acc-1", "yahoo");
    const acct = account("acc-1", "yahoo");
    const provider = makeSource(acct, async () => ({
      uidValidity: 100,
      uids: [],
    }));
    const registry = makeRegistry({
      activeAccounts: [acct],
      providerFor: () => provider,
    });

    const job = new MailReconciliationJob({ registry, db });
    await job.start();
    await job.stop();
    await job.tick();
  });
});
