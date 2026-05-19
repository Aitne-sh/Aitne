import { describe, it, expect, vi, beforeEach } from "vitest";
import { GmailService } from "./gmail.js";
import type { SecretBroker } from "../secrets/secret-broker.js";

// ── Mock googleapis ──

const mockMessagesList = vi.fn();
const mockMessagesGet = vi.fn();
const mockMessagesSend = vi.fn();
const mockMessagesModify = vi.fn();
const mockMessagesTrash = vi.fn();
const mockMessagesUntrash = vi.fn();
const mockDraftsList = vi.fn();
const mockDraftsGet = vi.fn();
const mockDraftsCreate = vi.fn();
const mockDraftsUpdate = vi.fn();
const mockDraftsDelete = vi.fn();
const mockDraftsSend = vi.fn();
const mockThreadsGet = vi.fn();
const mockLabelsList = vi.fn();

vi.mock("googleapis", () => ({
  google: {
    auth: {
      GoogleAuth: class MockGoogleAuth {},
      OAuth2: class MockOAuth2 {
        setCredentials() {}
        on() {}
      },
    },
    gmail: () => ({
      users: {
        messages: {
          list: mockMessagesList,
          get: mockMessagesGet,
          send: mockMessagesSend,
          modify: mockMessagesModify,
          trash: mockMessagesTrash,
          untrash: mockMessagesUntrash,
        },
        drafts: {
          list: mockDraftsList,
          get: mockDraftsGet,
          create: mockDraftsCreate,
          update: mockDraftsUpdate,
          delete: mockDraftsDelete,
          send: mockDraftsSend,
        },
        threads: {
          get: mockThreadsGet,
        },
        labels: {
          list: mockLabelsList,
        },
      },
    }),
  },
}));

// ── Helpers ──

function makeSecretBroker(): SecretBroker {
  return {
    getGoogleCredentialsJson: vi.fn().mockResolvedValue(
      JSON.stringify({
        type: "authorized_user",
        client_id: "test",
        client_secret: "test",
        installed: { client_id: "test", client_secret: "test", redirect_uris: ["http://localhost"] },
      }),
    ),
    getGoogleTokenJson: vi.fn().mockResolvedValue(
      JSON.stringify({ access_token: "token", refresh_token: "refresh" }),
    ),
  } as unknown as SecretBroker;
}

function makeFullMessagePayload(overrides: Record<string, unknown> = {}) {
  return {
    id: "msg1",
    threadId: "thread1",
    snippet: "Hello...",
    labelIds: ["INBOX"],
    payload: {
      headers: [
        { name: "Subject", value: "Test Subject" },
        { name: "From", value: "sender@example.com" },
        { name: "To", value: "recipient@example.com" },
        { name: "Cc", value: "cc@example.com" },
        { name: "Date", value: "2026-01-01" },
        { name: "Message-ID", value: "<msg1@mail.gmail.com>" },
        { name: "References", value: "<prev@mail.gmail.com>" },
      ],
      body: { data: Buffer.from("Hello body").toString("base64") },
    },
    ...overrides,
  };
}

async function initService(): Promise<GmailService> {
  const broker = makeSecretBroker();
  const service = new GmailService(broker);
  await service.init();
  return service;
}

// ── Tests ──

describe("GmailService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("parseFullMessage — extended fields", () => {
    it("parses cc, messageIdHeader, and references from headers", async () => {
      const service = await initService();
      mockMessagesGet.mockResolvedValue({ data: makeFullMessagePayload() });

      const msg = await service.getMessage("msg1");
      expect(msg).not.toBeNull();
      expect(msg!.cc).toBe("cc@example.com");
      expect(msg!.messageIdHeader).toBe("<msg1@mail.gmail.com>");
      expect(msg!.references).toBe("<prev@mail.gmail.com>");
    });

    it("returns null for missing headers", async () => {
      const service = await initService();
      mockMessagesGet.mockResolvedValue({
        data: {
          id: "msg2",
          threadId: "thread2",
          snippet: "",
          labelIds: [],
          payload: { headers: [{ name: "Subject", value: "No extras" }] },
        },
      });

      const msg = await service.getMessage("msg2");
      expect(msg!.cc).toBeNull();
      expect(msg!.messageIdHeader).toBeNull();
      expect(msg!.references).toBeNull();
    });
  });

  describe("listDrafts", () => {
    it("returns draft summaries with subject and to", async () => {
      const service = await initService();
      mockDraftsList.mockResolvedValue({
        data: {
          drafts: [
            { id: "d1", message: { id: "m1", threadId: "t1" } },
            { id: "d2", message: { id: "m2", threadId: "t2" } },
          ],
        },
      });
      mockDraftsGet
        .mockResolvedValueOnce({
          data: {
            message: {
              id: "m1",
              threadId: "t1",
              snippet: "Hello",
              payload: {
                headers: [
                  { name: "Subject", value: "Draft 1" },
                  { name: "To", value: "user@example.com" },
                ],
              },
            },
          },
        })
        .mockResolvedValueOnce({
          data: {
            message: {
              id: "m2",
              threadId: "t2",
              snippet: "World",
              payload: {
                headers: [
                  { name: "Subject", value: "Draft 2" },
                  { name: "To", value: "other@example.com" },
                ],
              },
            },
          },
        });

      const drafts = await service.listDrafts();
      expect(drafts).toHaveLength(2);
      expect(drafts[0].draftId).toBe("d1");
      expect(drafts[0].subject).toBe("Draft 1");
      expect(drafts[0].to).toBe("user@example.com");
      expect(drafts[1].draftId).toBe("d2");
    });

    it("falls back to ID-only when individual get fails", async () => {
      const service = await initService();
      mockDraftsList.mockResolvedValue({
        data: {
          drafts: [{ id: "d1", message: { id: "m1", threadId: "t1" } }],
        },
      });
      mockDraftsGet.mockRejectedValueOnce(new Error("API error"));

      const drafts = await service.listDrafts();
      expect(drafts).toHaveLength(1);
      expect(drafts[0].draftId).toBe("d1");
      expect(drafts[0].subject).toBeNull();
      expect(drafts[0].to).toBeNull();
    });
  });

  describe("getDraft", () => {
    it("parses all fields including cc, bcc, messageIdHeader, references", async () => {
      const service = await initService();
      mockDraftsGet.mockResolvedValue({
        data: {
          id: "d1",
          message: {
            id: "m1",
            threadId: "t1",
            snippet: "Draft snippet",
            payload: {
              headers: [
                { name: "Subject", value: "Draft Subject" },
                { name: "From", value: "me@example.com" },
                { name: "To", value: "to@example.com" },
                { name: "Cc", value: "cc@example.com" },
                { name: "Bcc", value: "bcc@example.com" },
                { name: "Date", value: "2026-01-01" },
                { name: "Message-ID", value: "<draft@mail.gmail.com>" },
                { name: "References", value: "<prev@mail.gmail.com>" },
              ],
              body: { data: Buffer.from("Draft body").toString("base64") },
            },
          },
        },
      });

      const draft = await service.getDraft("d1");
      expect(draft).not.toBeNull();
      expect(draft!.draftId).toBe("d1");
      expect(draft!.cc).toBe("cc@example.com");
      expect(draft!.bcc).toBe("bcc@example.com");
      expect(draft!.body).toBe("Draft body");
      expect(draft!.messageIdHeader).toBe("<draft@mail.gmail.com>");
      expect(draft!.references).toBe("<prev@mail.gmail.com>");
    });
  });

  describe("updateDraft", () => {
    it("preserves unspecified fields from existing draft", async () => {
      const service = await initService();

      // getDraft call inside updateDraft
      mockDraftsGet.mockResolvedValue({
        data: {
          id: "d1",
          message: {
            id: "m1",
            threadId: "t1",
            snippet: "",
            payload: {
              headers: [
                { name: "Subject", value: "Original Subject" },
                { name: "To", value: "to@example.com" },
                { name: "Cc", value: "cc@example.com" },
              ],
              body: { data: Buffer.from("Original body").toString("base64") },
            },
          },
        },
      });
      mockDraftsUpdate.mockResolvedValue({ data: { id: "d1" } });

      await service.updateDraft("d1", { body: "New body" });

      expect(mockDraftsUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: "me",
          id: "d1",
        }),
      );

      // Decode the raw payload and verify existing fields are preserved
      const rawB64 = mockDraftsUpdate.mock.calls[0][0].requestBody.message.raw;
      const decoded = Buffer.from(rawB64, "base64url").toString("utf-8");
      expect(decoded).toContain("To: to@example.com");
      expect(decoded).toContain("Subject: Original Subject");
      expect(decoded).toContain("Cc: cc@example.com");
      expect(decoded).toContain("New body");
    });

    it("clears fields when null is passed", async () => {
      const service = await initService();

      mockDraftsGet.mockResolvedValue({
        data: {
          id: "d1",
          message: {
            id: "m1",
            threadId: "t1",
            snippet: "",
            payload: {
              headers: [
                { name: "Subject", value: "Subject" },
                { name: "To", value: "to@example.com" },
                { name: "Cc", value: "cc@example.com" },
              ],
              body: { data: Buffer.from("Body").toString("base64") },
            },
          },
        },
      });
      mockDraftsUpdate.mockResolvedValue({ data: { id: "d1" } });

      await service.updateDraft("d1", { cc: null });

      const rawB64 = mockDraftsUpdate.mock.calls[0][0].requestBody.message.raw;
      const decoded = Buffer.from(rawB64, "base64url").toString("utf-8");
      expect(decoded).not.toContain("Cc:");
    });

    it("throws when draft not found", async () => {
      const service = await initService();
      mockDraftsGet.mockResolvedValue({ data: { id: "d1", message: null } });

      await expect(service.updateDraft("d1", { body: "x" })).rejects.toThrow("not found");
    });
  });

  describe("deleteDraft", () => {
    it("calls drafts.delete", async () => {
      const service = await initService();
      mockDraftsDelete.mockResolvedValue({});

      await service.deleteDraft("d1");
      expect(mockDraftsDelete).toHaveBeenCalledWith({ userId: "me", id: "d1" });
    });
  });

  describe("sendDraft", () => {
    it("returns messageId and threadId", async () => {
      const service = await initService();
      mockDraftsSend.mockResolvedValue({
        data: { id: "sent1", threadId: "t1" },
      });

      const result = await service.sendDraft("d1");
      expect(result.messageId).toBe("sent1");
      expect(result.threadId).toBe("t1");
    });
  });

  describe("getThread", () => {
    it("returns all messages in thread", async () => {
      const service = await initService();
      mockThreadsGet.mockResolvedValue({
        data: {
          id: "t1",
          messages: [
            makeFullMessagePayload({ id: "m1" }),
            makeFullMessagePayload({ id: "m2" }),
            makeFullMessagePayload({ id: "m3" }),
          ],
        },
      });

      const thread = await service.getThread("t1");
      expect(thread!.id).toBe("t1");
      expect(thread!.messages).toHaveLength(3);
    });

    it("limits to last N messages with maxMessages", async () => {
      const service = await initService();
      const msgs = Array.from({ length: 50 }, (_, i) =>
        makeFullMessagePayload({ id: `m${i}` }),
      );
      mockThreadsGet.mockResolvedValue({
        data: { id: "t1", messages: msgs },
      });

      const thread = await service.getThread("t1", { maxMessages: 10 });
      expect(thread!.messages).toHaveLength(10);
      expect(thread!.messages[0].id).toBe("m40");
      expect(thread!.messages[9].id).toBe("m49");
    });

    it("passes format parameter", async () => {
      const service = await initService();
      mockThreadsGet.mockResolvedValue({
        data: { id: "t1", messages: [] },
      });

      await service.getThread("t1", { format: "metadata" });
      expect(mockThreadsGet).toHaveBeenCalledWith(
        expect.objectContaining({ format: "metadata" }),
      );
    });
  });

  describe("modifyLabels", () => {
    it("calls messages.modify with add and remove", async () => {
      const service = await initService();
      mockMessagesModify.mockResolvedValue({});

      await service.modifyLabels("msg1", ["STARRED"], ["UNREAD"]);
      expect(mockMessagesModify).toHaveBeenCalledWith({
        userId: "me",
        id: "msg1",
        requestBody: { addLabelIds: ["STARRED"], removeLabelIds: ["UNREAD"] },
      });
    });
  });

  describe("trashMessage", () => {
    it("calls messages.trash", async () => {
      const service = await initService();
      mockMessagesTrash.mockResolvedValue({});

      await service.trashMessage("msg1");
      expect(mockMessagesTrash).toHaveBeenCalledWith({ userId: "me", id: "msg1" });
    });
  });

  describe("untrashMessage", () => {
    it("calls messages.untrash", async () => {
      const service = await initService();
      mockMessagesUntrash.mockResolvedValue({});

      await service.untrashMessage("msg1");
      expect(mockMessagesUntrash).toHaveBeenCalledWith({ userId: "me", id: "msg1" });
    });
  });

  describe("sendMessage — references header", () => {
    it("includes References header when provided", async () => {
      const service = await initService();
      mockMessagesSend.mockResolvedValue({
        data: { id: "sent1", threadId: "t1" },
      });

      await service.sendMessage({
        to: "to@example.com",
        subject: "Re: Test",
        body: "Reply",
        inReplyTo: "<C@mail.gmail.com>",
        references: "<A@mail.gmail.com> <B@mail.gmail.com> <C@mail.gmail.com>",
        threadId: "t1",
      });

      const rawB64 = mockMessagesSend.mock.calls[0][0].requestBody.raw;
      const decoded = Buffer.from(rawB64, "base64url").toString("utf-8");
      expect(decoded).toContain("In-Reply-To: <C@mail.gmail.com>");
      expect(decoded).toContain("References: <A@mail.gmail.com> <B@mail.gmail.com> <C@mail.gmail.com>");
    });

    it("omits References and In-Reply-To headers when not provided", async () => {
      const service = await initService();
      mockMessagesSend.mockResolvedValue({
        data: { id: "sent1", threadId: "t1" },
      });

      await service.sendMessage({
        to: "to@example.com",
        subject: "New message",
        body: "Hello",
      });

      const rawB64 = mockMessagesSend.mock.calls[0][0].requestBody.raw;
      const decoded = Buffer.from(rawB64, "base64url").toString("utf-8");
      expect(decoded).not.toContain("References:");
      expect(decoded).not.toContain("In-Reply-To:");
    });
  });

  describe("createDraft — bcc and references", () => {
    it("includes Bcc and References headers when provided", async () => {
      const service = await initService();
      mockDraftsCreate.mockResolvedValue({ data: { id: "d1" } });

      await service.createDraft({
        to: "to@example.com",
        subject: "Test",
        body: "Body",
        bcc: "bcc@example.com",
        references: "<A@mail.gmail.com>",
      });

      const rawB64 = mockDraftsCreate.mock.calls[0][0].requestBody.message.raw;
      const decoded = Buffer.from(rawB64, "base64url").toString("utf-8");
      expect(decoded).toContain("Bcc: bcc@example.com");
      expect(decoded).toContain("References: <A@mail.gmail.com>");
    });

    it("places threadId at requestBody.message.threadId", async () => {
      const service = await initService();
      mockDraftsCreate.mockResolvedValue({ data: { id: "d1" } });

      await service.createDraft({
        to: "to@example.com",
        subject: "Reply",
        body: "Body",
        threadId: "t1",
      });

      const call = mockDraftsCreate.mock.calls[0][0];
      expect(call.requestBody.message.threadId).toBe("t1");
      // should NOT be at requestBody.threadId
      expect(call.requestBody.threadId).toBeUndefined();
    });
  });

  describe("listMessages — parseMessageSummary cc field", () => {
    it("includes cc in message summary", async () => {
      const service = await initService();
      mockMessagesList.mockResolvedValue({
        data: { messages: [{ id: "m1" }] },
      });
      mockMessagesGet.mockResolvedValue({
        data: {
          id: "m1",
          threadId: "t1",
          snippet: "Hello",
          labelIds: ["INBOX"],
          payload: {
            headers: [
              { name: "Subject", value: "Test" },
              { name: "From", value: "from@example.com" },
              { name: "Cc", value: "cc@example.com" },
              { name: "Date", value: "2026-01-01" },
            ],
          },
        },
      });

      const messages = await service.listMessages();
      expect(messages[0].cc).toBe("cc@example.com");
    });

    it("returns null cc when header absent", async () => {
      const service = await initService();
      mockMessagesList.mockResolvedValue({
        data: { messages: [{ id: "m1" }] },
      });
      mockMessagesGet.mockResolvedValue({
        data: {
          id: "m1",
          threadId: "t1",
          snippet: "",
          labelIds: [],
          payload: {
            headers: [
              { name: "Subject", value: "Test" },
              { name: "From", value: "from@example.com" },
              { name: "Date", value: "2026-01-01" },
            ],
          },
        },
      });

      const messages = await service.listMessages();
      expect(messages[0].cc).toBeNull();
    });
  });

  describe("getThread — additional cases", () => {
    it("returns null for 404 error with numeric code", async () => {
      const service = await initService();
      const notFoundError = Object.assign(new Error("Not Found"), { code: 404 });
      mockThreadsGet.mockRejectedValue(notFoundError);

      const thread = await service.getThread("nonexistent");
      expect(thread).toBeNull();
    });

    it("returns null for 404 error with string code (GaxiosError)", async () => {
      const service = await initService();
      const notFoundError = Object.assign(new Error("Not Found"), { code: "404" });
      mockThreadsGet.mockRejectedValue(notFoundError);

      const thread = await service.getThread("nonexistent");
      expect(thread).toBeNull();
    });

    it("returns null for 404 via response.status", async () => {
      const service = await initService();
      const notFoundError = Object.assign(new Error("Not Found"), { response: { status: 404 } });
      mockThreadsGet.mockRejectedValue(notFoundError);

      const thread = await service.getThread("nonexistent");
      expect(thread).toBeNull();
    });

    it("rethrows non-404 errors", async () => {
      const service = await initService();
      mockThreadsGet.mockRejectedValue(new Error("Server error"));

      await expect(service.getThread("t1")).rejects.toThrow("Server error");
    });
  });
});
