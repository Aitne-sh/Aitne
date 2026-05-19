import { describe, expect, it } from "vitest";
import {
  buildReplyBodies,
  dedupeReferences,
} from "./reply-mime.js";

describe("dedupeReferences", () => {
  it("preserves order while removing duplicates/empties", () => {
    expect(dedupeReferences(["<a>", "", "<b>", "<a>", "<c>"])).toEqual([
      "<a>",
      "<b>",
      "<c>",
    ]);
  });
});

describe("buildReplyBodies", () => {
  it("builds plain-text replies with quoted parent text", () => {
    const result = buildReplyBodies({
      textBody: "Thanks.",
      inReplyTo: "<parent@example.com>",
      references: ["<root@example.com>"],
      parent: {
        from: { email: "alice@example.com", name: "Alice" },
        sentAt: "2026-04-16T12:00:00.000Z",
        textBody: "First line\nSecond line",
      },
    });

    expect(result.textBody).toContain("Thanks.");
    expect(result.textBody).toContain("> First line");
    expect(result.textBody).toContain("> Second line");
    expect(result.references).toEqual([
      "<root@example.com>",
      "<parent@example.com>",
    ]);
  });

  it("builds HTML replies with a blockquote", () => {
    const result = buildReplyBodies({
      htmlBody: "<p>Reply</p>",
      inReplyTo: "<parent@example.com>",
      references: [],
      parent: {
        from: { email: "alice@example.com" },
        sentAt: "2026-04-16T12:00:00.000Z",
        htmlBody: "<p>Hello</p>",
      },
    });

    expect(result.htmlBody).toContain("<p>Reply</p>");
    expect(result.htmlBody).toContain("<blockquote><p>Hello</p></blockquote>");
    expect(result.references).toEqual(["<parent@example.com>"]);
  });

  it("falls back to HTML->text when the parent lacks a text body", () => {
    const result = buildReplyBodies({
      textBody: "Ack",
      inReplyTo: "<parent@example.com>",
      references: [],
      parent: {
        from: { email: "alice@example.com" },
        htmlBody: "<p>Hello<br>World</p>",
      },
    });

    expect(result.textBody).toContain("> Hello");
    expect(result.textBody).toContain("> World");
  });

  it("returns undefined textBody when neither input nor parent has text", () => {
    const result = buildReplyBodies({
      inReplyTo: "<parent@example.com>",
      references: [],
      parent: { from: { email: "alice@example.com" } },
    });
    expect(result.textBody).toBeUndefined();
  });

  it("returns undefined htmlBody when neither input nor parent has html", () => {
    const result = buildReplyBodies({
      inReplyTo: "<parent@example.com>",
      references: [],
      parent: { from: { email: "alice@example.com" } },
    });
    expect(result.htmlBody).toBeUndefined();
  });

  it("builds reply when only input textBody is provided (no parent content)", () => {
    // Covers textQuote ?? "" null branch in line with template literal:
    // textBody is defined, textQuote is undefined → "?? """
    const result = buildReplyBodies({
      textBody: "My reply only",
      inReplyTo: "<parent@example.com>",
      references: [],
      parent: { from: { email: "no-content@example.com" } },
    });
    expect(result.textBody).toBe("My reply only");
  });

  it("builds quote-only textBody when input has no text but parent does", () => {
    // Covers input.textBody ?? "" null branch: textBody is undefined, textQuote defined
    const result = buildReplyBodies({
      inReplyTo: "<parent@example.com>",
      references: [],
      parent: {
        from: { email: "alice@example.com" },
        textBody: "Parent message content here",
      },
    });
    expect(result.textBody).toContain("> Parent message content here");
  });

  it("uses 'the sender' fallback when parent has no from field", () => {
    // Covers || "the sender" fallback branch in replyIntro
    const result = buildReplyBodies({
      textBody: "Thanks",
      inReplyTo: "<p@example.com>",
      references: [],
      parent: { textBody: "Hi there" },
    });
    expect(result.textBody).toContain("the sender");
  });

  it("handles sentAt as a Date object instead of a string", () => {
    // Covers `value instanceof Date ? value : ...` true branch in formatReplyDate
    const result = buildReplyBodies({
      textBody: "Reply",
      inReplyTo: "<p@example.com>",
      references: [],
      parent: {
        from: { email: "alice@example.com" },
        sentAt: new Date("2026-04-16T12:00:00Z"),
        textBody: "Original",
      },
    });
    expect(result.textBody).toContain("Thu, 16 Apr 2026");
  });

  it("falls back to 'an earlier message' for invalid sentAt string", () => {
    // Covers Number.isNaN(date.getTime()) true branch in formatReplyDate
    const result = buildReplyBodies({
      textBody: "Reply",
      inReplyTo: "<p@example.com>",
      references: [],
      parent: {
        from: { email: "alice@example.com" },
        sentAt: "not-a-date",
        textBody: "Original",
      },
    });
    expect(result.textBody).toContain("an earlier message");
  });

  it("builds HTML reply when only input htmlBody is provided (no parent html content)", () => {
    // Covers htmlQuote ?? "" null branch: htmlBody is defined, htmlQuote is undefined
    const result = buildReplyBodies({
      htmlBody: "<p>My HTML reply</p>",
      inReplyTo: "<parent@example.com>",
      references: [],
      parent: { from: { email: "no-html@example.com" } },
    });
    expect(result.htmlBody).toContain("<p>My HTML reply</p>");
  });

  it("builds HTML quote from parent textBody when parent has no HTML", () => {
    // Covers buildHtmlQuote path where parent.htmlBody is absent but textBody exists
    const result = buildReplyBodies({
      htmlBody: "<p>Reply</p>",
      inReplyTo: "<parent@example.com>",
      references: [],
      parent: {
        from: { email: "alice@example.com" },
        textBody: "Plain parent message",
      },
    });
    expect(result.htmlBody).toContain("<pre>");
    expect(result.htmlBody).toContain("Plain parent message");
  });
});
