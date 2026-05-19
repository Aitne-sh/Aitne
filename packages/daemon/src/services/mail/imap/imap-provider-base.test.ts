import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { MailAccount } from "../provider.js";
import { buildImapAccountSecret } from "./app-password.js";
import { ImapProviderBase } from "./imap-provider-base.js";
import * as clientModule from "./client.js";

const FIXED_NOW = () => new Date("2026-04-16T12:00:00.000Z");
const FIXED_DATE = new Date("2026-04-16T08:00:00.000Z");

// ImapFlow's `.capabilities` is the only shape the probe consumes. We reuse
// the library type so the test subclass stays honest about what it passes in.
type ImapFlowClient = Parameters<typeof clientModule.createImapFlowClient>[0] extends never
  ? never
  : ReturnType<typeof clientModule.createImapFlowClient>;

class TestImapProvider extends ImapProviderBase {
  readonly kind = "yahoo" as const;

  // Test hook — exposes the protected probe so tests can verify the latch
  // and error-handling paths without resorting to `as unknown as` casts.
  exposeRecordCapabilities(client: ImapFlowClient): void {
    this.recordCapabilities(client);
  }
}

class FakeImapClient extends EventEmitter {
  mailbox = {
    path: "INBOX",
    uidValidity: BigInt(77),
    permanentFlags: new Set<string>(["\\Seen", "\\*"]),
  };
  usable = true;
  opened: string[] = [];
  idleCalls = 0;
  noopCalls = 0;
  searchImpl = async (_query: Record<string, unknown>) => [] as number[];
  fetchAllImpl = async (_uids: number[]) => [] as Array<Record<string, unknown>>;
  private idleResolve: (() => void) | null = null;

  async getMailboxLock(_path: string, _options: { readOnly: boolean }) {
    return { release: () => undefined };
  }

  async search(query: Record<string, unknown>): Promise<number[]> {
    return this.searchImpl(query);
  }

  async fetchAll(uids: number[]): Promise<Array<Record<string, unknown>>> {
    return this.fetchAllImpl(uids);
  }

  async mailboxOpen(path: string, _options: { readOnly: boolean }): Promise<void> {
    this.opened.push(path);
    this.mailbox.path = path;
  }

  async idle(): Promise<void> {
    this.idleCalls++;
    await new Promise<void>((resolve) => {
      this.idleResolve = resolve;
    });
  }

  async noop(): Promise<void> {
    this.noopCalls++;
    this.idleResolve?.();
    this.idleResolve = null;
  }
}

function makeAccount(overrides: Partial<MailAccount> = {}): MailAccount {
  return {
    id: "yahoo-acct",
    kind: "yahoo",
    email: "owner@yahoo.example.com",
    authStatus: "healthy",
    idleEnabled: true,
    active: true,
    createdAt: "2026-04-16T12:00:00.000Z",
    ...overrides,
  };
}

function makeProvider(client: FakeImapClient): TestImapProvider {
  const provider = new TestImapProvider({
    account: makeAccount(),
    secret: buildImapAccountSecret("yahoo", "owner@yahoo.example.com", "secret"),
    now: FIXED_NOW,
  });
  (provider as unknown as { clientPromise: Promise<FakeImapClient> }).clientPromise = Promise.resolve(client);
  (provider as unknown as {
    resolvedFoldersPromise: Promise<{
      inbox: string;
      sent: string;
      drafts: string;
      trash: string;
      archive: string;
    }>;
  }).resolvedFoldersPromise = Promise.resolve({
    inbox: "INBOX",
    sent: "Sent",
    drafts: "Drafts",
    trash: "Trash",
    archive: "Archive",
  });
  // The production `connectClient()` wires a `mailboxOpen` listener that
  // tracks UIDVALIDITY per folder so `expunge` events can build a local
  // provider_msg_id. The test helper pre-injects `clientPromise` and
  // therefore bypasses connectClient — replay the same wiring here.
  const uidValidityByFolder = (
    provider as unknown as { uidValidityByFolder: Map<string, number> }
  ).uidValidityByFolder;
  client.on("mailboxOpen", (mailbox: unknown) => {
    const mb = mailbox as { path?: unknown; uidValidity?: unknown } | null;
    if (!mb || typeof mb !== "object") return;
    const path = typeof mb.path === "string" ? mb.path : null;
    const uv =
      typeof mb.uidValidity === "number"
        ? mb.uidValidity
        : typeof mb.uidValidity === "bigint"
          ? Number(mb.uidValidity)
          : null;
    if (path && uv !== null) uidValidityByFolder.set(path, uv);
  });
  return provider;
}

function makeFetchedMessage(uid: number, extra: Partial<Record<string, unknown>> = {}) {
  return {
    uid,
    envelope: {
      subject: "Quarterly Update",
      messageId: `<msg-${uid}@example.com>`,
      from: [{ address: "sender@example.com", name: "Sender" }],
      to: [{ address: "owner@yahoo.example.com", name: "Owner" }],
    },
    flags: new Set<string>(),
    internalDate: FIXED_DATE,
    bodyStructure: {},
    ...extra,
  };
}

describe("ImapProviderBase", () => {
  it("filters unicode queries against parsed body text", async () => {
    const client = new FakeImapClient();
    client.searchImpl = async () => [101];
    client.fetchAllImpl = async () => [
      makeFetchedMessage(101, {
        source: Buffer.from(
          "From: Sender <sender@example.com>\r\n"
            + "To: Owner <owner@yahoo.example.com>\r\n"
            + "Subject: Quarterly Update\r\n"
            + "Message-ID: <msg-101@example.com>\r\n"
            + "Content-Type: text/plain; charset=utf-8\r\n"
            + "\r\n"
            + "Voici le café de l'équipe.\r\n",
          "utf8",
        ),
      }),
    ];

    const provider = makeProvider(client);
    const result = await provider.list({ folder: "INBOX", q: "café", limit: 10 });

    expect(result).toHaveLength(1);
    expect(result[0]?.providerMsgId).toBe("77:101");
    expect(result[0]?.snippet).toContain("café");
  });

  it("pages bootstrap sync from the oldest unseen UID window", async () => {
    const client = new FakeImapClient();
    client.mailbox.uidValidity = BigInt(99);
    client.searchImpl = async (query) => {
      expect(query).toEqual({ all: true });
      return [10, 11, 12];
    };
    client.fetchAllImpl = async (uids) => uids.map((uid) => makeFetchedMessage(uid));

    const provider = makeProvider(client);
    const result = await provider.pollSince(null, 2);

    expect(result.messages.map((message) => message.providerMsgId)).toEqual([
      "99:10",
      "99:11",
    ]);
    expect(result.nextCursor).toEqual({
      kind: "imap",
      folders: {
        INBOX: {
          uidValidity: 99,
          lastUid: 11,
        },
      },
    });
    expect(result.drained).toBe(false);
  });

  it("restarts resync from the beginning when UIDVALIDITY changes", async () => {
    const client = new FakeImapClient();
    client.mailbox.uidValidity = BigInt(200);
    client.searchImpl = async () => [41, 42, 43];
    client.fetchAllImpl = async (uids) => uids.map((uid) => makeFetchedMessage(uid));

    const provider = makeProvider(client);
    const result = await provider.pollSince(
      {
        kind: "imap",
        folders: {
          INBOX: {
            uidValidity: 7,
            lastUid: 999,
          },
        },
      },
      2,
    );

    expect(result.messages.map((message) => message.providerMsgId)).toEqual([
      "200:41",
      "200:42",
    ]);
    expect(result.nextCursor).toEqual({
      kind: "imap",
      folders: {
        INBOX: {
          uidValidity: 200,
          lastUid: 42,
        },
      },
    });
    expect(result.drained).toBe(false);
  });

  it("starts a background IDLE loop and stops it with NOOP", async () => {
    const client = new FakeImapClient();
    const provider = makeProvider(client);
    const onDirty = vi.fn();

    await provider.startIdle({ onDirty });
    await Promise.resolve();

    expect(client.opened).toEqual(["INBOX"]);
    expect(client.idleCalls).toBe(1);

    client.emit("exists");
    expect(onDirty).toHaveBeenCalledTimes(1);

    await provider.startIdle({ onDirty });
    await Promise.resolve();
    expect(client.opened).toEqual(["INBOX"]);
    expect(client.idleCalls).toBe(1);

    await provider.stopIdle();
    expect(client.noopCalls).toBe(1);
  });

  it("forwards VANISHED expunge events as ExpungeNotification to onExpunge", async () => {
    const client = new FakeImapClient();
    const provider = makeProvider(client);
    const onDirty = vi.fn();
    const onExpunge = vi.fn();

    // Prime uidValidity map for INBOX by simulating the mailboxOpen event
    // the real ImapFlow client would emit.
    client.emit("mailboxOpen", { path: "INBOX", uidValidity: 42 });

    await provider.startIdle({ onDirty, onExpunge });
    await Promise.resolve();

    // QRESYNC-style event: vanished=true, uid present, path present
    client.emit("expunge", { path: "INBOX", uid: 7, vanished: true });
    expect(onExpunge).toHaveBeenCalledWith({
      folder: "INBOX",
      uid: 7,
      uidValidity: 42,
      providerMsgId: "42:7",
    });
    expect(onDirty).toHaveBeenCalled();

    // Plain EXPUNGE (vanished=false) does NOT invoke onExpunge
    onExpunge.mockClear();
    client.emit("expunge", { path: "INBOX", seq: 3, vanished: false });
    expect(onExpunge).not.toHaveBeenCalled();

    await provider.stopIdle();
  });

  it("fires the capability probe through the real connect path", async () => {
    // Exercises `connectClient() → recordCapabilities(client)` end-to-end.
    // Without this test, someone could delete the call site in connectClient()
    // and every other test would still pass, silently breaking the probe in
    // production. This is the single load-bearing test for the feature wire.
    const onCapabilitiesProbed = vi.fn();
    const provider = new TestImapProvider({
      account: makeAccount(),
      secret: buildImapAccountSecret("yahoo", "owner@yahoo.example.com", "secret"),
      now: FIXED_NOW,
      onCapabilitiesProbed,
    });

    const fakeClient = new FakeImapClient();
    (fakeClient as unknown as { capabilities: Map<string, boolean | number> }).capabilities =
      new Map<string, boolean | number>([
        ["IDLE", true],
        ["UIDPLUS", 1],
        ["QRESYNC", true],
        ["SPECIAL-USE", true],
        ["THREAD=REFERENCES", true],
        ["MOVE", true],
      ]);
    (fakeClient as unknown as { connect: () => Promise<void> }).connect = async () => undefined;

    const createSpy = vi
      .spyOn(clientModule, "createImapFlowClient")
      .mockReturnValue(fakeClient as unknown as ReturnType<typeof clientModule.createImapFlowClient>);

    try {
      const client = await (provider as unknown as {
        getClient: () => Promise<unknown>;
      }).getClient();
      expect(client).toBe(fakeClient);
      expect(createSpy).toHaveBeenCalledTimes(1);

      await vi.waitFor(() => {
        expect(onCapabilitiesProbed).toHaveBeenCalledTimes(1);
      });

      expect(onCapabilitiesProbed.mock.calls[0]?.[0]).toBe("yahoo-acct");
      const caps = onCapabilitiesProbed.mock.calls[0]?.[1] as {
        idle: boolean;
        uidplus: boolean;
        qresync: boolean;
        specialUse: boolean;
        threadReferences: boolean;
        move: boolean;
      };
      expect(caps).toMatchObject({
        idle: true,
        uidplus: true,
        qresync: true,
        specialUse: true,
        threadReferences: true,
        move: true,
      });
      expect(provider.getCapabilities()?.idle).toBe(true);
    } finally {
      createSpy.mockRestore();
    }
  });

  it("skips capability probe on reconnect within same provider instance", async () => {
    const onCapabilitiesProbed = vi.fn();
    const provider = new TestImapProvider({
      account: makeAccount(),
      secret: buildImapAccountSecret("yahoo", "owner@yahoo.example.com", "secret"),
      now: FIXED_NOW,
      onCapabilitiesProbed,
    });
    const client = new FakeImapClient();
    (client as unknown as { capabilities: Map<string, boolean | number> }).capabilities =
      new Map<string, boolean | number>([["IDLE", true]]);

    provider.exposeRecordCapabilities(
      client as unknown as Parameters<typeof provider.exposeRecordCapabilities>[0],
    );
    provider.exposeRecordCapabilities(
      client as unknown as Parameters<typeof provider.exposeRecordCapabilities>[0],
    );

    await vi.waitFor(() => {
      expect(onCapabilitiesProbed).toHaveBeenCalledTimes(1);
    });
  });

  it("does not let onCapabilitiesProbed errors propagate into the connect path", async () => {
    // Invariant: a slow or broken DB write on the persistence side must not
    // crash or stall IMAP I/O. We assert both (a) the synchronous call did
    // not throw and (b) the probe result is still cached locally regardless
    // of callback outcome. The daemon logs at warn level so operators can
    // diagnose repeated failures, but that is observability — not a
    // correctness invariant — so we don't pin it in a unit test.
    const onCapabilitiesProbed = vi.fn(async () => {
      throw new Error("db write failed");
    });
    const provider = new TestImapProvider({
      account: makeAccount(),
      secret: buildImapAccountSecret("yahoo", "owner@yahoo.example.com", "secret"),
      now: FIXED_NOW,
      onCapabilitiesProbed,
    });
    const client = new FakeImapClient();
    (client as unknown as { capabilities: Map<string, boolean | number> }).capabilities =
      new Map<string, boolean | number>([["IDLE", true]]);

    expect(() =>
      provider.exposeRecordCapabilities(
        client as unknown as Parameters<typeof provider.exposeRecordCapabilities>[0],
      ),
    ).not.toThrow();

    await vi.waitFor(() => {
      expect(onCapabilitiesProbed).toHaveBeenCalledTimes(1);
    });

    expect(provider.getCapabilities()?.idle).toBe(true);
  });

  it("records capabilities even with no onCapabilitiesProbed callback configured", () => {
    const provider = new TestImapProvider({
      account: makeAccount(),
      secret: buildImapAccountSecret("yahoo", "owner@yahoo.example.com", "secret"),
      now: FIXED_NOW,
    });
    const client = new FakeImapClient();
    (client as unknown as { capabilities: Map<string, boolean | number> }).capabilities =
      new Map<string, boolean | number>([["IDLE", true]]);

    provider.exposeRecordCapabilities(
      client as unknown as Parameters<typeof provider.exposeRecordCapabilities>[0],
    );
    expect(provider.getCapabilities()?.idle).toBe(true);
  });
});
