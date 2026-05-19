import { describe, expect, it, vi } from "vitest";
import type { PublicClientApplication } from "@azure/msal-node";
import { OutlookGraphProvider } from "./outlook-provider.js";
import { GraphClient } from "./graph-client.js";
import type { MailAccount } from "../provider.js";

interface FetchCall {
  url: string;
  method: string;
  body: unknown;
}

function makeFakeMsal(): PublicClientApplication {
  // The OutlookGraphProvider's tests inject a GraphClient with a stubbed token
  // provider, so the MSAL app is never touched. A bare object cast satisfies
  // TypeScript without pulling in the heavyweight MSAL surface.
  return {} as unknown as PublicClientApplication;
}

function makeAccount(overrides: Partial<MailAccount> = {}): MailAccount {
  return {
    id: "outlook-abc",
    kind: "outlook",
    email: "owner@example.com",
    authStatus: "healthy",
    idleEnabled: false,
    active: true,
    createdAt: "2026-04-16T00:00:00.000Z",
    ...overrides,
  };
}

function makeProvider(handlers: Array<{
  match: (req: FetchCall) => boolean;
  respond: (req: FetchCall) => Response | Promise<Response>;
}>): { provider: OutlookGraphProvider; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetchImpl = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const req: FetchCall = {
      url: typeof input === "string" ? input : input.toString(),
      method: init?.method ?? "GET",
      body: parseBody(init?.body),
    };
    calls.push(req);
    for (const h of handlers) {
      if (h.match(req)) return h.respond(req);
    }
    throw new Error(`Unmatched fetch: ${req.method} ${req.url}`);
  }) as unknown as typeof fetch;

  const tokenProvider = {
    async getAccessToken() {
      return "test-token";
    },
    invalidateToken() {
      // unused
    },
  };
  const graphClient = new GraphClient({ tokenProvider, fetchImpl });
  const provider = new OutlookGraphProvider({
    account: makeAccount(),
    msalApp: makeFakeMsal(),
    graphClient,
  });
  return { provider, calls };
}

function parseBody(body: unknown): unknown {
  if (typeof body !== "string") return body;
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const SAMPLE_MESSAGE = {
  id: "msg-1",
  internetMessageId: "<abc@example.com>",
  conversationId: "conv-1",
  subject: "Hello",
  from: { emailAddress: { address: "alice@example.com", name: "Alice" } },
  toRecipients: [{ emailAddress: { address: "owner@example.com", name: "Owner" } }],
  receivedDateTime: "2026-04-15T10:00:00Z",
  isRead: false,
  hasAttachments: false,
  categories: ["Work"],
  bodyPreview: "Just saying hi.",
};

describe("OutlookGraphProvider.pollSince", () => {
  it("nextLink page → drained=false, cursor carries nextLink", async () => {
    const { provider, calls } = makeProvider([
      {
        match: (r) => r.url.includes("/me/mailFolders/Inbox/messages/delta"),
        respond: () =>
          jsonResponse({
            value: [SAMPLE_MESSAGE],
            "@odata.nextLink": "https://graph.microsoft.com/v1.0/next-page",
          }),
      },
    ]);
    const result = await provider.pollSince(null, 50);
    expect(result.drained).toBe(false);
    expect(result.nextCursor).toEqual({
      kind: "graph",
      nextLink: "https://graph.microsoft.com/v1.0/next-page",
    });
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].providerMsgId).toBe("msg-1");
    expect(result.messages[0].folder).toBe("Inbox");
    expect(result.messages[0].threadId).toBe("conv-1");
    expect(result.removedIds).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it("deltaLink page → drained=true, cursor carries deltaLink", async () => {
    const { provider } = makeProvider([
      {
        match: (r) => r.url.includes("/messages/delta"),
        respond: () =>
          jsonResponse({
            value: [],
            "@odata.deltaLink": "https://graph.microsoft.com/v1.0/delta-token",
          }),
      },
    ]);
    const result = await provider.pollSince(null, 50);
    expect(result.drained).toBe(true);
    expect(result.nextCursor).toEqual({
      kind: "graph",
      deltaLink: "https://graph.microsoft.com/v1.0/delta-token",
    });
  });

  it("@removed.reason both 'changed' and 'deleted' land in removedIds", async () => {
    const { provider } = makeProvider([
      {
        match: (r) => r.url.includes("/messages/delta"),
        respond: () =>
          jsonResponse({
            value: [
              { id: "deleted-1", "@removed": { reason: "deleted" } },
              { id: "moved-1", "@removed": { reason: "changed" } },
              SAMPLE_MESSAGE,
            ],
            "@odata.deltaLink": "https://graph.microsoft.com/v1.0/delta",
          }),
      },
    ]);
    const result = await provider.pollSince(null, 50);
    expect(result.removedIds.sort()).toEqual(["deleted-1", "moved-1"]);
    expect(result.messages.map((m) => m.providerMsgId)).toEqual(["msg-1"]);
  });

  it("follows nextLink from cursor on subsequent calls", async () => {
    const { provider, calls } = makeProvider([
      {
        match: (r) => r.url === "https://graph.microsoft.com/v1.0/next-page",
        respond: () =>
          jsonResponse({
            value: [],
            "@odata.deltaLink": "https://graph.microsoft.com/v1.0/delta",
          }),
      },
    ]);
    await provider.pollSince(
      { kind: "graph", nextLink: "https://graph.microsoft.com/v1.0/next-page" },
      50,
    );
    expect(calls[0].url).toBe("https://graph.microsoft.com/v1.0/next-page");
  });

  it("ignores non-graph cursor and starts fresh", async () => {
    const { provider, calls } = makeProvider([
      {
        match: (r) => r.url.includes("/messages/delta"),
        respond: () =>
          jsonResponse({
            value: [],
            "@odata.deltaLink": "https://graph.microsoft.com/v1.0/delta",
          }),
      },
    ]);
    await provider.pollSince({ kind: "gmail", lastEpoch: 1 }, 50);
    expect(calls[0].url).toContain("/me/mailFolders/Inbox/messages/delta");
  });
});

describe("OutlookGraphProvider.send (new message)", () => {
  it("draftOnly=false → exactly 2 fetches: POST /me/messages then POST /me/messages/{id}/send (NEVER /sendMail)", async () => {
    const { provider, calls } = makeProvider([
      {
        match: (r) =>
          r.method === "POST" &&
          r.url.endsWith("/me/messages"),
        respond: () => jsonResponse({ id: "draft-7" }, 201),
      },
      {
        match: (r) =>
          r.method === "POST" &&
          r.url.endsWith("/me/messages/draft-7/send"),
        respond: () => new Response(null, { status: 202 }),
      },
    ]);
    const result = await provider.send({
      to: ["bob@example.com"],
      subject: "Hello",
      textBody: "Hi Bob",
      draftOnly: false,
    });
    expect(result).toEqual({ id: "draft-7", isDraft: false });
    expect(calls).toHaveLength(2);
    expect(calls[0].url).toBe("https://graph.microsoft.com/v1.0/me/messages");
    expect(calls[1].url).toBe("https://graph.microsoft.com/v1.0/me/messages/draft-7/send");
    for (const call of calls) {
      expect(call.url).not.toContain("/sendMail");
    }
  });

  it("draftOnly=true → exactly 1 fetch (create only)", async () => {
    const { provider, calls } = makeProvider([
      {
        match: (r) => r.method === "POST" && r.url.endsWith("/me/messages"),
        respond: () => jsonResponse({ id: "draft-9" }, 201),
      },
    ]);
    const result = await provider.send({
      to: ["bob@example.com"],
      subject: "Hi",
      textBody: "body",
      draftOnly: true,
    });
    expect(result).toEqual({ id: "draft-9", isDraft: true });
    expect(calls).toHaveLength(1);
  });

  it("default draftOnly is true (Notify-tier safe)", async () => {
    const { provider, calls } = makeProvider([
      {
        match: (r) => r.method === "POST" && r.url.endsWith("/me/messages"),
        respond: () => jsonResponse({ id: "draft-10" }, 201),
      },
    ]);
    const result = await provider.send({
      to: ["bob@example.com"],
      subject: "Hi",
      textBody: "body",
    });
    expect(result.isDraft).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it("uses HTML body when provided over text body", async () => {
    const { provider, calls } = makeProvider([
      {
        match: () => true,
        respond: () => jsonResponse({ id: "d" }, 201),
      },
    ]);
    await provider.send({
      to: ["bob@example.com"],
      subject: "Hi",
      htmlBody: "<p>hi</p>",
      textBody: "ignored",
      draftOnly: true,
    });
    expect((calls[0].body as { body?: { contentType?: string; content?: string } }).body)
      .toEqual({ contentType: "html", content: "<p>hi</p>" });
  });

  it("includes cc and bcc recipients when provided", async () => {
    const { provider, calls } = makeProvider([
      { match: () => true, respond: () => jsonResponse({ id: "d" }, 201) },
    ]);
    await provider.send({
      to: ["a@x.com"],
      cc: ["c@x.com"],
      bcc: ["b@x.com"],
      subject: "Hi",
      textBody: "x",
      draftOnly: true,
    });
    const body = calls[0].body as Record<string, unknown>;
    expect(body.ccRecipients).toEqual([{ emailAddress: { address: "c@x.com" } }]);
    expect(body.bccRecipients).toEqual([{ emailAddress: { address: "b@x.com" } }]);
  });
});

describe("OutlookGraphProvider.send (reply)", () => {
  it("draftOnly=false → exactly 3 fetches in order: createReply, PATCH, send", async () => {
    const { provider, calls } = makeProvider([
      {
        match: (r) =>
          r.method === "POST" &&
          r.url.endsWith("/me/messages/parent-1/createReply"),
        respond: () => jsonResponse({ id: "draft-r1" }, 201),
      },
      {
        match: (r) =>
          r.method === "PATCH" &&
          r.url.endsWith("/me/messages/draft-r1"),
        respond: () => new Response(null, { status: 200 }),
      },
      {
        match: (r) =>
          r.method === "POST" && r.url.endsWith("/me/messages/draft-r1/send"),
        respond: () => new Response(null, { status: 202 }),
      },
    ]);
    const result = await provider.send({
      to: [],
      subject: "irrelevant",
      textBody: "Replying",
      draftOnly: false,
      reply: {
        inReplyToRfc822Id: "<parent@example.com>",
        references: ["<parent@example.com>"],
        parentProviderMsgId: "parent-1",
      },
    });
    expect(result).toEqual({ id: "draft-r1", isDraft: false });
    expect(calls).toHaveLength(3);
    expect(calls[0]).toMatchObject({
      method: "POST",
      url: "https://graph.microsoft.com/v1.0/me/messages/parent-1/createReply",
    });
    expect(calls[1]).toMatchObject({
      method: "PATCH",
      url: "https://graph.microsoft.com/v1.0/me/messages/draft-r1",
    });
    expect(calls[2]).toMatchObject({
      method: "POST",
      url: "https://graph.microsoft.com/v1.0/me/messages/draft-r1/send",
    });
    for (const call of calls) {
      expect(call.url).not.toContain("/sendMail");
    }
  });

  it("draftOnly=true → exactly 2 fetches (createReply + PATCH, no send)", async () => {
    const { provider, calls } = makeProvider([
      {
        match: (r) => r.url.endsWith("/createReply"),
        respond: () => jsonResponse({ id: "draft-r2" }, 201),
      },
      {
        match: (r) => r.method === "PATCH" && r.url.endsWith("/me/messages/draft-r2"),
        respond: () => new Response(null, { status: 200 }),
      },
    ]);
    const result = await provider.send({
      to: ["x@y.com"],
      subject: "ignored",
      textBody: "draft reply",
      draftOnly: true,
      reply: {
        inReplyToRfc822Id: "<p@x.com>",
        references: [],
        parentProviderMsgId: "parent-2",
      },
    });
    expect(result).toEqual({ id: "draft-r2", isDraft: true });
    expect(calls).toHaveLength(2);
  });

  it("includes cc and bcc on reply when provided; omits to when array empty", async () => {
    const { provider, calls } = makeProvider([
      {
        match: (r) => r.url.endsWith("/createReply"),
        respond: () => jsonResponse({ id: "draft-r3" }, 201),
      },
      {
        match: (r) => r.method === "PATCH" && r.url.endsWith("/me/messages/draft-r3"),
        respond: () => new Response(null, { status: 200 }),
      },
    ]);
    await provider.send({
      to: [],
      cc: ["c@x.com"],
      bcc: ["b@x.com"],
      subject: "ignored",
      textBody: "hi",
      draftOnly: true,
      reply: {
        inReplyToRfc822Id: "<p@x.com>",
        references: [],
        parentProviderMsgId: "parent-3",
      },
    });
    const patchBody = calls[1].body as Record<string, unknown>;
    expect(patchBody.toRecipients).toBeUndefined();
    expect(patchBody.ccRecipients).toEqual([{ emailAddress: { address: "c@x.com" } }]);
    expect(patchBody.bccRecipients).toEqual([{ emailAddress: { address: "b@x.com" } }]);
  });

  it("rejects when reply.parentProviderMsgId is missing", async () => {
    const { provider } = makeProvider([]);
    await expect(
      provider.send({
        to: [],
        subject: "x",
        textBody: "x",
        reply: {
          inReplyToRfc822Id: "<p@x.com>",
          references: [],
        },
      }),
    ).rejects.toThrow(/parentProviderMsgId/);
  });
});

describe("OutlookGraphProvider.modifyTags", () => {
  it("preserves existing categories on read-merge-write", async () => {
    const { provider, calls } = makeProvider([
      {
        match: (r) => r.method === "GET" && r.url.endsWith("/me/messages/m1?$select=categories"),
        respond: () => jsonResponse({ id: "m1", categories: ["A", "B"] }),
      },
      {
        match: (r) => r.method === "PATCH" && r.url.endsWith("/me/messages/m1"),
        respond: () => new Response(null, { status: 200 }),
      },
    ]);
    await provider.modifyTags("m1", ["C"], ["B"]);
    expect(calls).toHaveLength(2);
    const patchBody = calls[1].body as { categories: string[] };
    expect(patchBody.categories.sort()).toEqual(["A", "C"]);
  });

  it("no-ops when both add and remove are empty", async () => {
    const { provider, calls } = makeProvider([]);
    await provider.modifyTags("m1", [], []);
    expect(calls).toHaveLength(0);
  });

  it("handles a message with no existing categories", async () => {
    const { provider, calls } = makeProvider([
      {
        match: (r) => r.method === "GET",
        respond: () => jsonResponse({ id: "m1" }),
      },
      { match: (r) => r.method === "PATCH", respond: () => new Response(null, { status: 200 }) },
    ]);
    await provider.modifyTags("m1", ["X"], []);
    expect((calls[1].body as { categories: string[] }).categories).toEqual(["X"]);
  });
});

describe("OutlookGraphProvider.markRead and trash", () => {
  it("markRead PATCHes isRead", async () => {
    const { provider, calls } = makeProvider([
      {
        match: (r) => r.method === "PATCH" && r.url.endsWith("/me/messages/m1"),
        respond: () => new Response(null, { status: 200 }),
      },
    ]);
    await provider.markRead("m1", true);
    expect(calls[0].body).toEqual({ isRead: true });
  });

  it("trash POSTs to /me/messages/{id}/move with destinationId=deletedItems", async () => {
    const { provider, calls } = makeProvider([
      {
        match: (r) =>
          r.method === "POST" && r.url.endsWith("/me/messages/m1/move"),
        respond: () => jsonResponse({ id: "moved" }),
      },
    ]);
    await provider.trash("m1");
    expect(calls).toHaveLength(1);
    expect(calls[0].body).toEqual({ destinationId: "deletedItems" });
  });
});

describe("OutlookGraphProvider.listFolders", () => {
  it("maps wellKnownName to canonical labels (sentitems → sent)", async () => {
    const { provider } = makeProvider([
      {
        match: (r) => r.url.includes("/me/mailFolders"),
        respond: () =>
          jsonResponse({
            value: [
              { id: "f1", displayName: "Inbox", unreadItemCount: 3, wellKnownName: "inbox" },
              { id: "f2", displayName: "Sent Items", unreadItemCount: 0, wellKnownName: "sentitems" },
              { id: "f3", displayName: "Drafts", unreadItemCount: 1, wellKnownName: "drafts" },
              { id: "f4", displayName: "Deleted", unreadItemCount: 0, wellKnownName: "deleteditems" },
              { id: "f5", displayName: "Junk", unreadItemCount: 5, wellKnownName: "junkemail" },
              { id: "f6", displayName: "Custom", unreadItemCount: 2 },
              { id: "f7" },
            ],
          }),
      },
    ]);
    const folders = await provider.listFolders();
    expect(folders).toEqual([
      { id: "f1", name: "Inbox", canonical: "inbox", unread: 3 },
      { id: "f2", name: "Sent Items", canonical: "sent", unread: 0 },
      { id: "f3", name: "Drafts", canonical: "drafts", unread: 1 },
      { id: "f4", name: "Deleted", canonical: "trash", unread: 0 },
      { id: "f5", name: "Junk", canonical: "spam", unread: 5 },
      { id: "f6", name: "Custom", canonical: undefined, unread: 2 },
      { id: "f7", name: "f7", canonical: undefined, unread: 0 },
    ]);
  });

  it("returns [] when Graph response has no value array", async () => {
    const { provider } = makeProvider([
      { match: () => true, respond: () => jsonResponse({}) },
    ]);
    expect(await provider.listFolders()).toEqual([]);
  });

  it("treats missing wellKnownName branches as undefined canonical", async () => {
    const { provider } = makeProvider([
      {
        match: () => true,
        respond: () => jsonResponse({ value: [{ id: "f", wellKnownName: "weird" }] }),
      },
    ]);
    const folders = await provider.listFolders();
    expect(folders[0].canonical).toBeUndefined();
  });
});

describe("OutlookGraphProvider.list", () => {
  it("composes $select, $top, $orderby with no query", async () => {
    const { provider, calls } = makeProvider([
      { match: () => true, respond: () => jsonResponse({ value: [SAMPLE_MESSAGE] }) },
    ]);
    await provider.list({});
    expect(calls[0].url).toContain("/me/mailFolders/Inbox/messages?");
    expect(calls[0].url).toContain("%24select=");
    expect(calls[0].url).toContain("%24top=25");
    expect(calls[0].url).toContain("%24orderby=receivedDateTime+DESC");
  });

  it("respects limit cap of 100", async () => {
    const { provider, calls } = makeProvider([
      { match: () => true, respond: () => jsonResponse({ value: [] }) },
    ]);
    await provider.list({ limit: 500 });
    expect(calls[0].url).toContain("%24top=100");
  });

  it("layers since, unreadOnly, and free-text search into $filter and $search", async () => {
    const { provider, calls } = makeProvider([
      { match: () => true, respond: () => jsonResponse({ value: [] }) },
    ]);
    await provider.list({
      since: "2026-04-01T00:00:00Z",
      unreadOnly: true,
      q: "from:alice@example.com hello",
    });
    expect(calls[0].url).toContain("%24filter=");
    const decoded = decodeURIComponent(calls[0].url).replaceAll("+", " ");
    expect(decoded).toContain("isRead eq false");
    expect(decoded).toContain("receivedDateTime ge 2026-04-01T00:00:00Z");
    expect(decoded).toContain("from/emailAddress/address eq 'alice@example.com'");
    expect(calls[0].url).toContain("%24search=");
  });

  it("returns [] when Graph response has no value array", async () => {
    const { provider } = makeProvider([
      { match: () => true, respond: () => jsonResponse({}) },
    ]);
    expect(await provider.list({})).toEqual([]);
  });

  it("returns mapped MailMessageSummary objects", async () => {
    const { provider } = makeProvider([
      { match: () => true, respond: () => jsonResponse({ value: [SAMPLE_MESSAGE] }) },
    ]);
    const result = await provider.list({});
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      providerMsgId: "msg-1",
      subject: "Hello",
      from: { email: "alice@example.com", name: "Alice" },
      isRead: false,
      flags: ["Work"],
    });
  });
});

describe("OutlookGraphProvider.get", () => {
  it("fetches the message and attachments when hasAttachments is true", async () => {
    const { provider, calls } = makeProvider([
      {
        match: (r) =>
          r.method === "GET" && r.url.includes("/me/messages/msg-1?") && !r.url.includes("/attachments"),
        respond: () =>
          jsonResponse({
            ...SAMPLE_MESSAGE,
            hasAttachments: true,
            body: { contentType: "html", content: "<p>hi</p>" },
            parentFolderId: "inbox-id",
          }),
      },
      {
        match: (r) => r.url.includes("/me/messages/msg-1/attachments"),
        respond: () =>
          jsonResponse({
            value: [
              { id: "a1", name: "doc.pdf", contentType: "application/pdf", size: 1024 },
              { id: "a2" },
            ],
          }),
      },
    ]);
    const result = await provider.get("msg-1");
    expect(calls).toHaveLength(2);
    expect(result.body.html).toBe("<p>hi</p>");
    expect(result.body.text).toBeUndefined();
    expect(result.folder).toBe("inbox-id");
    expect(result.attachments).toEqual([
      { id: "a1", filename: "doc.pdf", mimeType: "application/pdf", sizeBytes: 1024 },
      { id: "a2", filename: "", mimeType: "application/octet-stream", sizeBytes: 0 },
    ]);
  });

  it("treats missing attachments value array as []", async () => {
    const { provider } = makeProvider([
      {
        match: (r) => r.url.includes("/me/messages/msg-1?") && !r.url.includes("/attachments"),
        respond: () => jsonResponse({ ...SAMPLE_MESSAGE, hasAttachments: true }),
      },
      {
        match: (r) => r.url.includes("/attachments"),
        respond: () => jsonResponse({}),
      },
    ]);
    const result = await provider.get("msg-1");
    expect(result.attachments).toEqual([]);
  });

  it("skips the attachments fetch when hasAttachments is false", async () => {
    const { provider, calls } = makeProvider([
      {
        match: () => true,
        respond: () =>
          jsonResponse({
            ...SAMPLE_MESSAGE,
            hasAttachments: false,
            body: { contentType: "text", content: "plain text" },
          }),
      },
    ]);
    const result = await provider.get("msg-1");
    expect(calls).toHaveLength(1);
    expect(result.body.text).toBe("plain text");
    expect(result.body.html).toBeUndefined();
    expect(result.attachments).toEqual([]);
  });
});

describe("OutlookGraphProvider acquireAccessToken (via real GraphClient)", () => {
  function makeMsalAppFake(opts: {
    accounts: { homeAccountId: string; username: string }[];
    accessToken?: string | null;
    expiresOn?: Date | null;
  }): {
    msalApp: PublicClientApplication;
    removed: { homeAccountId: string }[];
    tokenCalls: number;
  } {
    const removed: { homeAccountId: string }[] = [];
    let tokenCalls = 0;
    const msalApp = {
      getTokenCache() {
        return {
          async getAllAccounts() {
            return opts.accounts;
          },
          async removeAccount(account: { homeAccountId: string }) {
            removed.push(account);
          },
        };
      },
      async acquireTokenSilent() {
        tokenCalls++;
        return {
          accessToken: opts.accessToken === undefined ? "tok-1" : opts.accessToken,
          expiresOn: opts.expiresOn === undefined ? new Date(Date.now() + 60 * 60 * 1000) : opts.expiresOn,
        };
      },
    } as unknown as PublicClientApplication;
    return { msalApp, removed, get tokenCalls() { return tokenCalls; } };
  }

  function makeProviderWithMsal(
    msalApp: PublicClientApplication,
    overrides: { homeAccountId?: string } = {},
    fetchHandler?: () => Response,
  ): { provider: OutlookGraphProvider; calls: FetchCall[] } {
    const calls: FetchCall[] = [];
    const fetchImpl = vi.fn(async (input: string | URL, init?: RequestInit) => {
      calls.push({
        url: typeof input === "string" ? input : input.toString(),
        method: init?.method ?? "GET",
        body: parseBody(init?.body),
      });
      return fetchHandler?.() ?? jsonResponse({ ok: true });
    }) as unknown as typeof fetch;
    const provider = new OutlookGraphProvider({
      account: makeAccount(),
      msalApp,
      homeAccountId: overrides.homeAccountId,
      fetchImpl,
    });
    return { provider, calls };
  }

  it("acquires a token via MSAL and reuses it within expiry window", async () => {
    const fake = makeMsalAppFake({
      accounts: [{ homeAccountId: "h1", username: "owner@example.com" }],
    });
    const { provider, calls } = makeProviderWithMsal(fake.msalApp);
    await provider.markRead("m1", true);
    await provider.markRead("m1", true);
    expect(calls).toHaveLength(2);
    expect(fake.tokenCalls).toBe(1); // cached on second call
    const headers = (calls[0] as FetchCall) as unknown as { url: string };
    void headers;
  });

  it("falls back to username lookup when homeAccountId not set", async () => {
    const fake = makeMsalAppFake({
      accounts: [
        { homeAccountId: "other", username: "stranger@x" },
        { homeAccountId: "h1", username: "owner@example.com" },
      ],
    });
    const { provider } = makeProviderWithMsal(fake.msalApp);
    await provider.markRead("m1", true);
    expect(fake.tokenCalls).toBe(1);
  });

  it("uses homeAccountId lookup when provided", async () => {
    const fake = makeMsalAppFake({
      accounts: [
        { homeAccountId: "h-target", username: "different@x" },
        { homeAccountId: "h-other", username: "stranger@y" },
      ],
    });
    const { provider } = makeProviderWithMsal(fake.msalApp, { homeAccountId: "h-target" });
    await provider.markRead("m1", true);
    expect(fake.tokenCalls).toBe(1);
  });

  it("falls back to the single cached account when neither homeAccountId nor username matches", async () => {
    const fake = makeMsalAppFake({
      accounts: [{ homeAccountId: "h-first", username: "fallback@x" }],
    });
    const { provider } = makeProviderWithMsal(fake.msalApp, { homeAccountId: "missing" });
    await expect(provider.markRead("m1", true)).resolves.toBeUndefined();
    expect(fake.tokenCalls).toBe(1);
  });

  it("throws instead of silently selecting when the cache has multiple accounts but none match (C6)", async () => {
    const fake = makeMsalAppFake({
      accounts: [
        { homeAccountId: "h1", username: "stranger1@x" },
        { homeAccountId: "h2", username: "stranger2@x" },
      ],
    });
    const { provider } = makeProviderWithMsal(fake.msalApp, { homeAccountId: "missing" });
    await expect(provider.markRead("m1", true)).rejects.toThrow(
      /MSAL cache has 2 accounts but none match/,
    );
    expect(fake.tokenCalls).toBe(0);
  });

  it("throws when MSAL cache has no accounts at all", async () => {
    const fake = makeMsalAppFake({ accounts: [] });
    const { provider } = makeProviderWithMsal(fake.msalApp);
    await expect(provider.markRead("m1", true)).rejects.toThrow(/re-consent required/);
  });

  it("throws when acquireTokenSilent returns no accessToken", async () => {
    const fake = makeMsalAppFake({
      accounts: [{ homeAccountId: "h1", username: "owner@example.com" }],
      accessToken: null,
    });
    const { provider } = makeProviderWithMsal(fake.msalApp);
    await expect(provider.markRead("m1", true)).rejects.toThrow(/no accessToken/);
  });

  it("invalidates the cached token on 401 and re-fetches via MSAL", async () => {
    const fake = makeMsalAppFake({
      accounts: [{ homeAccountId: "h1", username: "owner@example.com" }],
    });
    let calls = 0;
    const fetchHandler = (): Response => {
      calls++;
      if (calls === 1) return new Response("", { status: 401 });
      return jsonResponse({ ok: true });
    };
    const { provider } = makeProviderWithMsal(fake.msalApp, {}, fetchHandler);
    await provider.markRead("m1", true);
    expect(calls).toBe(2);
    expect(fake.tokenCalls).toBe(2); // first call cached → 401 invalidates → second MSAL call
  });

  it("uses default expiresOn (Date.now()+30min) when MSAL returns no expiry", async () => {
    const fake = makeMsalAppFake({
      accounts: [{ homeAccountId: "h1", username: "owner@example.com" }],
      expiresOn: null,
    });
    const { provider } = makeProviderWithMsal(fake.msalApp);
    await expect(provider.markRead("m1", true)).resolves.toBeUndefined();
    await provider.markRead("m1", true);
    expect(fake.tokenCalls).toBe(1);
  });
});

describe("OutlookGraphProvider.revoke", () => {
  it("removes accounts matching homeAccountId or username", async () => {
    const removed: { homeAccountId: string }[] = [];
    const accounts = [
      { homeAccountId: "h-target", username: "different@x" },
      { homeAccountId: "h-other", username: "owner@example.com" },
      { homeAccountId: "h-stranger", username: "nobody@x" },
    ];
    const msalApp = {
      getTokenCache() {
        return {
          async getAllAccounts() {
            return accounts;
          },
          async removeAccount(account: { homeAccountId: string }) {
            removed.push(account);
          },
        };
      },
    } as unknown as PublicClientApplication;
    const provider = new OutlookGraphProvider({
      account: makeAccount(),
      msalApp,
      homeAccountId: "h-target",
    });
    await provider.revoke();
    expect(removed.map((a) => a.homeAccountId).sort()).toEqual(["h-other", "h-target"]);
  });

  it("revokes purely by username when homeAccountId is not set", async () => {
    const removed: { homeAccountId: string }[] = [];
    const accounts = [
      { homeAccountId: "h-1", username: "owner@example.com" },
      { homeAccountId: "h-2", username: "stranger@x" },
    ];
    const msalApp = {
      getTokenCache() {
        return {
          async getAllAccounts() {
            return accounts;
          },
          async removeAccount(account: { homeAccountId: string }) {
            removed.push(account);
          },
        };
      },
    } as unknown as PublicClientApplication;
    const provider = new OutlookGraphProvider({ account: makeAccount(), msalApp });
    await provider.revoke();
    expect(removed.map((a) => a.homeAccountId)).toEqual(["h-1"]);
  });
});

describe("OutlookGraphProvider summary mapping", () => {
  it("falls back to empty string + empty arrays for malformed Graph payloads", async () => {
    const { provider } = makeProvider([
      {
        match: () => true,
        respond: () =>
          jsonResponse({
            value: [
              {
                id: "incomplete",
                from: undefined,
                toRecipients: [{ emailAddress: undefined }, { emailAddress: { address: "" } }],
              },
            ],
            "@odata.deltaLink": "https://x",
          }),
      },
    ]);
    const result = await provider.pollSince(null, 50);
    expect(result.messages[0]).toMatchObject({
      providerMsgId: "incomplete",
      from: { email: "" },
      to: [],
      subject: null,
      isRead: false,
    });
  });

  it("treats missing toRecipients as empty array", async () => {
    const { provider } = makeProvider([
      {
        match: () => true,
        respond: () =>
          jsonResponse({
            value: [{ id: "no-to", from: { emailAddress: { address: "x@y.com" } } }],
            "@odata.deltaLink": "https://x",
          }),
      },
    ]);
    const result = await provider.pollSince(null, 50);
    expect(result.messages[0].to).toEqual([]);
  });
});
