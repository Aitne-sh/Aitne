import { describe, it, expect, vi } from "vitest";
import {
  GmailProvider,
  LEGACY_GMAIL_BLOB_SENTINEL,
} from "./gmail-provider.js";
import type { GmailService } from "../../gmail.js";
import type { MailAccount } from "../provider.js";

type GmailMock = {
  [K in keyof GmailService]: GmailService[K] extends (...args: infer A) => infer R
    ? ReturnType<typeof vi.fn<(...args: A) => R>>
    : GmailService[K];
};

function makeAccount(): MailAccount {
  return {
    id: "gmail-test",
    kind: "gmail",
    email: "user@example.com",
    authStatus: "healthy",
    idleEnabled: false,
    active: true,
    createdAt: "2026-04-16T00:00:00.000Z",
  };
}

function makeMockService(): GmailMock {
  return {
    available: true,
    init: vi.fn(),
    getEmailAddress: vi.fn(),
    getMailboxProfile: vi.fn().mockResolvedValue({
      emailAddress: "user@example.com",
      historyId: "hist-seed",
    }),
    listMessages: vi.fn(),
    searchMessagesPage: vi.fn(),
    listHistoryPage: vi.fn().mockResolvedValue({
      removedIds: [],
      nextPageToken: null,
      historyId: "hist-next",
    }),
    getMessage: vi.fn(),
    sendMessage: vi.fn(),
    createDraft: vi.fn(),
    listDrafts: vi.fn(),
    getDraft: vi.fn(),
    updateDraft: vi.fn(),
    deleteDraft: vi.fn(),
    sendDraft: vi.fn(),
    getThread: vi.fn(),
    listAttachments: vi.fn(),
    listAllAttachments: vi.fn(),
    getAttachment: vi.fn(),
    modifyLabels: vi.fn(),
    trashMessage: vi.fn(),
    untrashMessage: vi.fn(),
    listLabels: vi.fn(),
  } as unknown as GmailMock;
}

describe("GmailProvider", () => {
  it("exports the blob sentinel used by the legacy row", () => {
    expect(LEGACY_GMAIL_BLOB_SENTINEL).toBe("legacy-google-auth");
  });

  it("translates ListQuery filters into Gmail search tokens", async () => {
    const service = makeMockService();
    service.listMessages = vi.fn().mockResolvedValue([]);
    const provider = new GmailProvider({
      account: makeAccount(),
      service: service as unknown as GmailService,
    });
    await provider.list({
      q: "from:boss@example.com",
      unreadOnly: true,
      since: "2026-04-15T00:00:00.000Z",
      limit: 5,
    });
    const call = (service.listMessages as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.query).toContain("from:boss@example.com");
    expect(call.query).toContain("is:unread");
    expect(call.query).toMatch(/after:\d+/);
    expect(call.query).toContain("in:inbox");
    expect(call.maxResults).toBe(5);
  });

  it("send(draftOnly=true) creates a draft and skips sending", async () => {
    const service = makeMockService();
    service.createDraft = vi.fn().mockResolvedValue({ draftId: "d1" });
    service.sendMessage = vi.fn();
    const provider = new GmailProvider({
      account: makeAccount(),
      service: service as unknown as GmailService,
    });
    const result = await provider.send({
      to: ["a@example.com"],
      subject: "hi",
      textBody: "test",
      draftOnly: true,
    });
    expect(result).toEqual({ id: "d1", isDraft: true });
    expect(service.sendMessage).not.toHaveBeenCalled();
  });

  it("markRead adds/removes the UNREAD label appropriately", async () => {
    const service = makeMockService();
    service.modifyLabels = vi.fn().mockResolvedValue(undefined);
    const provider = new GmailProvider({
      account: makeAccount(),
      service: service as unknown as GmailService,
    });
    await provider.markRead("m1", true);
    expect(service.modifyLabels).toHaveBeenLastCalledWith("m1", [], ["UNREAD"]);
    await provider.markRead("m1", false);
    expect(service.modifyLabels).toHaveBeenLastCalledWith("m1", ["UNREAD"], []);
  });

  it("archive removes the INBOX label", async () => {
    const service = makeMockService();
    service.modifyLabels = vi.fn().mockResolvedValue(undefined);
    const provider = new GmailProvider({
      account: makeAccount(),
      service: service as unknown as GmailService,
    });
    await provider.archive!("m2");
    expect(service.modifyLabels).toHaveBeenCalledWith("m2", [], ["INBOX"]);
  });

  it("listTags returns label IDs (not display names) so modifyTags round-trips", async () => {
    const service = makeMockService();
    service.listLabels = vi.fn().mockResolvedValue([
      { id: "INBOX", name: "INBOX", type: "system" },
      { id: "Label_1", name: "Clients", type: "user" },
      { id: "STARRED", name: "STARRED", type: "system" },
    ]);
    const provider = new GmailProvider({
      account: makeAccount(),
      service: service as unknown as GmailService,
    });
    const tags = await provider.listTags!();
    expect(tags.system).toEqual(["INBOX", "STARRED"]);
    // Returns the API id, not "Clients" — modifyLabels needs ids.
    expect(tags.userDefined).toEqual(["Label_1"]);
  });

  it("pollSince seeds the cursor without replaying history on first run", async () => {
    const service = makeMockService();
    const provider = new GmailProvider({
      account: makeAccount(),
      service: service as unknown as GmailService,
    });
    const result = await provider.pollSince(null, 20);
    expect(result.messages).toEqual([]);
    expect(result.removedIds).toEqual([]);
    expect(result.drained).toBe(true);
    expect(result.nextCursor).toEqual({
      kind: "gmail",
      lastEpoch: expect.any(Number),
      historyId: "hist-seed",
      processedIds: [],
    });
    expect(service.searchMessagesPage).not.toHaveBeenCalled();
  });

  it("pollSince returns fresh messages and carries the next page token", async () => {
    const service = makeMockService();
    service.searchMessagesPage = vi.fn().mockResolvedValue({
      messages: [
        {
          id: "m-1",
          threadId: "t-1",
          subject: "Hello",
          from: "Boss <boss@example.com>",
          to: "user@example.com",
          cc: null,
          date: "2026-04-16T10:00:00Z",
          snippet: "ping",
          labelIds: ["INBOX", "UNREAD"],
          messageIdHeader: "<m-1@example.com>",
        },
      ],
      nextPageToken: "page-2",
    });
    const provider = new GmailProvider({
      account: makeAccount(),
      service: service as unknown as GmailService,
    });

    const result = await provider.pollSince(
      { kind: "gmail", lastEpoch: 123, processedIds: [] },
      20,
    );

    expect(service.searchMessagesPage).toHaveBeenCalledWith({
      query: "after:123",
      maxResults: 20,
      pageToken: undefined,
    });
    expect(result.drained).toBe(false);
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toMatchObject({
      providerMsgId: "m-1",
      rfc822MsgId: "<m-1@example.com>",
      subject: "Hello",
      flags: ["INBOX", "UNREAD"],
    });
    expect(result.nextCursor).toEqual({
      kind: "gmail",
      lastEpoch: 123,
      historyId: undefined,
      processedIds: ["m-1"],
      nextPageToken: "page-2",
    });
  });

  it("pollSince returns Gmail deletions and advances historyId", async () => {
    const service = makeMockService();
    service.listHistoryPage = vi.fn().mockResolvedValue({
      removedIds: ["gone-1"],
      nextPageToken: null,
      historyId: "hist-200",
    });
    service.searchMessagesPage = vi.fn().mockResolvedValue({
      messages: [],
      nextPageToken: null,
    });
    const provider = new GmailProvider({
      account: makeAccount(),
      service: service as unknown as GmailService,
    });

    const result = await provider.pollSince(
      { kind: "gmail", lastEpoch: 123, historyId: "hist-100", processedIds: [] },
      20,
    );

    expect(service.listHistoryPage).toHaveBeenCalledWith({
      startHistoryId: "hist-100",
      maxResults: 20,
      pageToken: undefined,
    });
    expect(result.removedIds).toEqual(["gone-1"]);
    expect(result.nextCursor).toEqual({
      kind: "gmail",
      lastEpoch: expect.any(Number),
      historyId: "hist-200",
      processedIds: [],
    });
  });

  it("pollSince paginates history before searching for new messages", async () => {
    const service = makeMockService();
    service.listHistoryPage = vi.fn().mockResolvedValue({
      removedIds: ["gone-1"],
      nextPageToken: "hist-page-2",
      historyId: "hist-200",
    });
    const provider = new GmailProvider({
      account: makeAccount(),
      service: service as unknown as GmailService,
    });

    const result = await provider.pollSince(
      { kind: "gmail", lastEpoch: 123, historyId: "hist-100", processedIds: [] },
      20,
    );

    expect(result).toEqual({
      messages: [],
      removedIds: ["gone-1"],
      nextCursor: {
        kind: "gmail",
        lastEpoch: 123,
        historyId: "hist-100",
        processedIds: [],
        nextPageToken: undefined,
        historyPageToken: "hist-page-2",
      },
      drained: false,
    });
    expect(service.searchMessagesPage).not.toHaveBeenCalled();
  });

  it("get throws when the message is not found", async () => {
    const service = makeMockService();
    service.getMessage = vi.fn().mockResolvedValue(null);
    const provider = new GmailProvider({
      account: makeAccount(),
      service: service as unknown as GmailService,
    });
    await expect(provider.get("missing")).rejects.toThrow(/not found/);
  });

  it("updateDraft returns atomic id (no previousId) for Gmail", async () => {
    const service = makeMockService();
    service.updateDraft = vi.fn().mockResolvedValue({ draftId: "d1" });
    const provider = new GmailProvider({
      account: makeAccount(),
      service: service as unknown as GmailService,
    });
    const result = await provider.updateDraft!("d1", { subject: "new" });
    expect(result).toEqual({ id: "d1" });
  });

  it("get includes attachment metadata from listAllAttachments", async () => {
    const service = makeMockService();
    service.getMessage = vi.fn().mockResolvedValue({
      id: "m1",
      threadId: "t1",
      subject: "Subject",
      from: "Boss <boss@example.com>",
      to: "user@example.com",
      cc: null,
      date: "2026-04-16T10:00:00Z",
      snippet: "hello",
      body: "Body",
      html: "<p>Body</p>",
      labelIds: ["INBOX"],
      messageIdHeader: "<m1@example.com>",
      references: null,
      hasAttachment: true,
    });
    service.listAllAttachments = vi.fn().mockResolvedValue([
      {
        attachmentId: "att-1",
        filename: "invoice.pdf",
        mimeType: "application/pdf",
        size: 1234,
      },
    ]);
    const provider = new GmailProvider({
      account: makeAccount(),
      service: service as unknown as GmailService,
    });

    const message = await provider.get("m1");
    expect(message.attachments).toEqual([
      {
        id: "att-1",
        filename: "invoice.pdf",
        mimeType: "application/pdf",
        sizeBytes: 1234,
      },
    ]);
  });
});
