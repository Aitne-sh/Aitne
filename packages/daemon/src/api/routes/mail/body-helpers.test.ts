import { describe, it, expect } from "vitest";
import type {
  MailMessage,
  ThreadView,
} from "../../../services/mail/provider.js";
import {
  applyMailMessageBodyMode,
  applyThreadBodyMode,
  buildMailBodyResponse,
  MAIL_BODY_CHUNK_DEFAULT_CHARS,
  MAIL_BODY_CHUNK_MAX_CHARS,
  MAIL_BODY_METADATA_DEFAULT_LIMIT,
  MAIL_BODY_METADATA_MAX_LIMIT,
  parseBodyMode,
} from "./body-helpers.js";

function makeMessage(overrides: Partial<MailMessage> = {}): MailMessage {
  return {
    accountId: "acct-1",
    providerMsgId: "msg-1",
    rfc822MsgId: "<a@host>",
    threadId: "thread-1",
    folder: "INBOX",
    receivedAtUtc: "2026-05-19T00:00:00.000Z",
    subject: "Hi",
    from: { email: "alice@example.test", name: "Alice" },
    to: [{ email: "bob@example.test" }],
    snippet: "Snippet",
    isRead: false,
    flags: [],
    body: {},
    attachments: [],
    ...overrides,
  };
}

describe("buildMailBodyResponse", () => {
  it("returns the raw HTML when format=raw and html is present", () => {
    const message = makeMessage({
      body: { html: "<p>hello world</p>", text: "fallback" },
    });
    const out = buildMailBodyResponse({
      accountId: "acct-1",
      message,
      format: "raw",
      chunk: 0,
      maxChars: 100,
      metadataOffset: 0,
      metadataLimit: 50,
    });
    expect(out.format).toBe("raw");
    expect(out.source).toBe("html");
    expect(out.content).toBe("<p>hello world</p>");
    expect(out.totalChars).toBe("<p>hello world</p>".length);
    expect(out.hasMore).toBe(false);
    expect(out.nextChunk).toBeNull();
    expect(out.links).toEqual([]);
    expect(out.images).toEqual([]);
    expect(out.linkCount).toBe(0);
    expect(out.imageCount).toBe(0);
    expect(out.rawHtmlAvailable).toBe(true);
    expect(out.rawTextAvailable).toBe(true);
  });

  it("falls back to text when format=raw and only text is present", () => {
    const message = makeMessage({ body: { text: "plain body" } });
    const out = buildMailBodyResponse({
      accountId: "acct-1",
      message,
      format: "raw",
      chunk: 0,
      maxChars: 100,
      metadataOffset: 0,
      metadataLimit: 50,
    });
    expect(out.source).toBe("text");
    expect(out.content).toBe("plain body");
    expect(out.rawHtmlAvailable).toBe(false);
    expect(out.rawTextAvailable).toBe(true);
  });

  it("returns an empty body when format=raw and both html/text are missing", () => {
    const message = makeMessage({ body: {} });
    const out = buildMailBodyResponse({
      accountId: "acct-1",
      message,
      format: "raw",
      chunk: 0,
      maxChars: 100,
      metadataOffset: 0,
      metadataLimit: 50,
    });
    expect(out.source).toBe("empty");
    expect(out.content).toBe("");
    expect(out.totalChars).toBe(0);
    expect(out.rawHtmlAvailable).toBe(false);
    expect(out.rawTextAvailable).toBe(false);
  });

  it("returns plaintext extracted from HTML when format=extracted and html is present", () => {
    const html = '<p>Hello <a href="https://x.test">world</a></p>';
    const message = makeMessage({ body: { html } });
    const out = buildMailBodyResponse({
      accountId: "acct-1",
      message,
      format: "extracted",
      chunk: 0,
      maxChars: 1000,
      metadataOffset: 0,
      metadataLimit: 50,
    });
    expect(out.format).toBe("extracted");
    expect(out.source).toBe("html");
    // Plaintext should contain the visible text but not raw tags.
    expect(out.content).toContain("Hello");
    expect(out.content).toContain("world");
    expect(out.content).not.toContain("<p>");
    expect(out.linkCount).toBeGreaterThan(0);
  });

  it("falls back to text when format=extracted and only text is present", () => {
    const message = makeMessage({ body: { text: "raw text" } });
    const out = buildMailBodyResponse({
      accountId: "acct-1",
      message,
      format: "extracted",
      chunk: 0,
      maxChars: 100,
      metadataOffset: 0,
      metadataLimit: 50,
    });
    expect(out.source).toBe("text");
    expect(out.content).toBe("raw text");
    expect(out.links).toEqual([]);
    expect(out.images).toEqual([]);
  });

  it("returns empty when format=extracted and the message has neither html nor text", () => {
    const message = makeMessage({ body: {} });
    const out = buildMailBodyResponse({
      accountId: "acct-1",
      message,
      format: "extracted",
      chunk: 0,
      maxChars: 100,
      metadataOffset: 0,
      metadataLimit: 50,
    });
    expect(out.source).toBe("empty");
    expect(out.content).toBe("");
  });

  it("paginates content via chunk/maxChars and surfaces hasMore + nextChunk", () => {
    const content = "abcdefghijklmnopqrstuvwxyz"; // 26 chars
    const message = makeMessage({ body: { text: content } });
    const first = buildMailBodyResponse({
      accountId: "acct-1",
      message,
      format: "raw",
      chunk: 0,
      maxChars: 10,
      metadataOffset: 0,
      metadataLimit: 50,
    });
    expect(first.content).toBe("abcdefghij");
    expect(first.totalChars).toBe(26);
    expect(first.hasMore).toBe(true);
    expect(first.nextChunk).toBe(1);

    const second = buildMailBodyResponse({
      accountId: "acct-1",
      message,
      format: "raw",
      chunk: 1,
      maxChars: 10,
      metadataOffset: 0,
      metadataLimit: 50,
    });
    expect(second.content).toBe("klmnopqrst");
    expect(second.hasMore).toBe(true);
    expect(second.nextChunk).toBe(2);

    const last = buildMailBodyResponse({
      accountId: "acct-1",
      message,
      format: "raw",
      chunk: 2,
      maxChars: 10,
      metadataOffset: 0,
      metadataLimit: 50,
    });
    expect(last.content).toBe("uvwxyz");
    expect(last.hasMore).toBe(false);
    expect(last.nextChunk).toBeNull();
  });

  it("returns an empty content when the chunk index is past the end", () => {
    const message = makeMessage({ body: { text: "short" } });
    const out = buildMailBodyResponse({
      accountId: "acct-1",
      message,
      format: "raw",
      chunk: 5,
      maxChars: 10,
      metadataOffset: 0,
      metadataLimit: 50,
    });
    expect(out.content).toBe("");
    expect(out.hasMore).toBe(false);
    expect(out.nextChunk).toBeNull();
  });

  it("paginates link/image metadata via offset+limit", () => {
    // Build HTML with >3 links + >3 images so paging is meaningful.
    const links = Array.from({ length: 5 }, (_, i) =>
      `<a href="https://l${i}.test">link${i}</a>`,
    ).join(" ");
    const imgs = Array.from({ length: 4 }, (_, i) =>
      `<img src="https://i${i}.test/x.png" alt="img${i}">`,
    ).join(" ");
    const message = makeMessage({ body: { html: `${links} ${imgs}` } });

    const page1 = buildMailBodyResponse({
      accountId: "acct-1",
      message,
      format: "extracted",
      chunk: 0,
      maxChars: 10_000,
      metadataOffset: 0,
      metadataLimit: 2,
    });
    expect(page1.links.length).toBe(2);
    expect(page1.images.length).toBe(2);
    expect(page1.linksHasMore).toBe(true);
    expect(page1.imagesHasMore).toBe(true);
    expect(page1.nextMetadataOffset).toBe(2);
    expect(page1.linkCount).toBeGreaterThanOrEqual(5);
    expect(page1.imageCount).toBeGreaterThanOrEqual(4);

    const lastPage = buildMailBodyResponse({
      accountId: "acct-1",
      message,
      format: "extracted",
      chunk: 0,
      maxChars: 10_000,
      metadataOffset: 100,
      metadataLimit: 50,
    });
    // Past the end: empty slices, no more, nextMetadataOffset clears.
    expect(lastPage.links).toEqual([]);
    expect(lastPage.images).toEqual([]);
    expect(lastPage.linksHasMore).toBe(false);
    expect(lastPage.imagesHasMore).toBe(false);
    expect(lastPage.nextMetadataOffset).toBeNull();
  });

  it("returns accountId + identifiers verbatim", () => {
    const message = makeMessage({
      providerMsgId: "p-99",
      rfc822MsgId: "<r-99@x>",
      threadId: "t-99",
      subject: "Hello",
      body: { text: "x" },
    });
    const out = buildMailBodyResponse({
      accountId: "acct-99",
      message,
      format: "raw",
      chunk: 0,
      maxChars: 10,
      metadataOffset: 0,
      metadataLimit: 10,
    });
    expect(out.accountId).toBe("acct-99");
    expect(out.providerMsgId).toBe("p-99");
    expect(out.rfc822MsgId).toBe("<r-99@x>");
    expect(out.threadId).toBe("t-99");
    expect(out.subject).toBe("Hello");
  });
});

describe("parseBodyMode", () => {
  it("defaults to full when raw is undefined", () => {
    expect(parseBodyMode(undefined)).toEqual({ ok: true, value: "full" });
  });

  it("accepts 'full' explicitly", () => {
    expect(parseBodyMode("full")).toEqual({ ok: true, value: "full" });
  });

  it("accepts 'none'", () => {
    expect(parseBodyMode("none")).toEqual({ ok: true, value: "none" });
  });

  it("rejects any other value with an invalid_query body", () => {
    const out = parseBodyMode("partial");
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.body.error).toBe("invalid_query");
      expect(out.body.message).toMatch(/full or none/);
    }
  });

  it("rejects an empty string (treated as an explicit other value)", () => {
    expect(parseBodyMode("").ok).toBe(false);
  });
});

describe("applyMailMessageBodyMode", () => {
  it("returns the message unchanged when mode=full", () => {
    const message = makeMessage({ body: { text: "hi", html: "<p>hi</p>" } });
    expect(applyMailMessageBodyMode(message, "full")).toBe(message);
  });

  it("clears body when mode=none and preserves all other fields", () => {
    const message = makeMessage({
      providerMsgId: "p1",
      body: { text: "hi", html: "<p>hi</p>" },
      attachments: [
        { id: "a1", filename: "x.txt", mimeType: "text/plain", sizeBytes: 10 },
      ],
    });
    const stripped = applyMailMessageBodyMode(message, "none");
    expect(stripped.body).toEqual({});
    expect(stripped.providerMsgId).toBe("p1");
    expect(stripped.attachments).toBe(message.attachments);
    // Ensure original message is untouched (no in-place mutation).
    expect(message.body.text).toBe("hi");
  });
});

describe("applyThreadBodyMode", () => {
  function makeThread(messages: MailMessage[]): ThreadView {
    return { threadId: "t-1", messages, status: "full" };
  }

  it("returns the thread unchanged when mode=full", () => {
    const thread = makeThread([
      makeMessage({ providerMsgId: "p1", body: { text: "a" } }),
      makeMessage({ providerMsgId: "p2", body: { text: "b" } }),
    ]);
    expect(applyThreadBodyMode(thread, "full")).toBe(thread);
  });

  it("clears every message body when mode=none", () => {
    const thread = makeThread([
      makeMessage({ providerMsgId: "p1", body: { text: "a" } }),
      makeMessage({ providerMsgId: "p2", body: { text: "b", html: "<i>b</i>" } }),
    ]);
    const stripped = applyThreadBodyMode(thread, "none");
    expect(stripped.threadId).toBe("t-1");
    expect(stripped.messages).toHaveLength(2);
    for (const m of stripped.messages) {
      expect(m.body).toEqual({});
    }
    // Original thread's messages are untouched (function is pure).
    expect(thread.messages[0].body.text).toBe("a");
  });

  it("preserves status / missingAncestors", () => {
    const thread: ThreadView = {
      threadId: "t-1",
      messages: [makeMessage({ body: { text: "a" } })],
      status: "partial",
      missingAncestors: 3,
    };
    const stripped = applyThreadBodyMode(thread, "none");
    expect(stripped.status).toBe("partial");
    expect(stripped.missingAncestors).toBe(3);
  });
});

describe("body-helpers constants", () => {
  it("exposes default and ceiling chunk sizes that are sane and bounded", () => {
    expect(MAIL_BODY_CHUNK_DEFAULT_CHARS).toBeGreaterThan(0);
    expect(MAIL_BODY_CHUNK_DEFAULT_CHARS).toBeLessThanOrEqual(MAIL_BODY_CHUNK_MAX_CHARS);
  });

  it("exposes default and ceiling metadata limits that are sane and bounded", () => {
    expect(MAIL_BODY_METADATA_DEFAULT_LIMIT).toBeGreaterThan(0);
    expect(MAIL_BODY_METADATA_DEFAULT_LIMIT).toBeLessThanOrEqual(MAIL_BODY_METADATA_MAX_LIMIT);
  });
});
