import { describe, expect, it } from "vitest";
import {
  type MdastNode,
  parsePaDocHref,
  splitCitationsInText,
  transformCitations,
} from "./remark-citations";

describe("splitCitationsInText", () => {
  it("returns a single text node when no citation token is present", () => {
    const out = splitCitationsInText("plain prose with no markers");
    expect(out).toEqual([
      { type: "text", value: "plain prose with no markers" },
    ]);
  });

  it("splits a single citation token out of surrounding text", () => {
    const out = splitCitationsInText(
      "before [doc:concepts/agent-day#tldr] after",
    );
    expect(out.map((n) => n.type)).toEqual(["text", "link", "text"]);
    expect(out[0]).toEqual({ type: "text", value: "before " });
    expect(out[1]?.url).toBe("pa-doc:concepts%2Fagent-day#tldr");
    expect(out[2]).toEqual({ type: "text", value: " after" });
  });

  it("supports a citation with no anchor", () => {
    const out = splitCitationsInText("see [doc:glossary] for terms");
    expect(out[1]?.url).toBe("pa-doc:glossary");
  });

  it("handles multiple citations in the same text node", () => {
    const out = splitCitationsInText(
      "[doc:a/b#c] then [doc:x/y#z] tail",
    );
    expect(out.map((n) => n.type)).toEqual([
      "link",
      "text",
      "link",
      "text",
    ]);
    expect(out[0]?.url).toBe("pa-doc:a%2Fb#c");
    expect(out[2]?.url).toBe("pa-doc:x%2Fy#z");
  });
});

describe("transformCitations (mdast walker)", () => {
  it("rewrites citations inside paragraphs", () => {
    const tree: MdastNode = {
      type: "root",
      children: [
        {
          type: "paragraph",
          children: [
            {
              type: "text",
              value: "see [doc:concepts/agent-day#tldr] for context",
            },
          ],
        },
      ],
    };
    transformCitations(tree);
    const para = tree.children![0]!;
    expect(para.children!.map((n) => n.type)).toEqual([
      "text",
      "link",
      "text",
    ]);
    expect(para.children![1]!.url).toBe("pa-doc:concepts%2Fagent-day#tldr");
  });

  it("does not descend into fenced code blocks", () => {
    const tree: MdastNode = {
      type: "root",
      children: [
        {
          type: "code",
          value: "[doc:concepts/agent-day#tldr] inside a code block",
        },
      ],
    };
    transformCitations(tree);
    expect(tree.children![0]!.value).toBe(
      "[doc:concepts/agent-day#tldr] inside a code block",
    );
    // The code node has no children, but importantly we must not have
    // mutated its `value`.
    expect(tree.children![0]!.type).toBe("code");
  });

  it("does not rewrite citations inside inline code spans", () => {
    const tree: MdastNode = {
      type: "root",
      children: [
        {
          type: "paragraph",
          children: [
            { type: "text", value: "the form " },
            { type: "inlineCode", value: "[doc:slug#anchor]" },
            { type: "text", value: " is the citation grammar" },
          ],
        },
      ],
    };
    transformCitations(tree);
    const para = tree.children![0]!;
    // Inline code unchanged; surrounding text untouched.
    expect(para.children!.map((n) => n.type)).toEqual([
      "text",
      "inlineCode",
      "text",
    ]);
    expect(para.children![1]!.value).toBe("[doc:slug#anchor]");
  });

  it("rewrites citations nested inside link text", () => {
    const tree: MdastNode = {
      type: "root",
      children: [
        {
          type: "paragraph",
          children: [
            {
              type: "emphasis",
              children: [
                { type: "text", value: "see [doc:glossary]" },
              ],
            },
          ],
        },
      ],
    };
    transformCitations(tree);
    const para = tree.children![0]!;
    const em = para.children![0]!;
    expect(em.children!.map((n) => n.type)).toEqual(["text", "link"]);
  });
});

describe("parsePaDocHref", () => {
  it("returns null for non-pa-doc hrefs", () => {
    expect(parsePaDocHref("https://example.com")).toBeNull();
    expect(parsePaDocHref("")).toBeNull();
  });

  it("parses slug-only hrefs", () => {
    expect(parsePaDocHref("pa-doc:glossary")).toEqual({
      slug: "glossary",
      anchor: null,
    });
  });

  it("parses slug + anchor hrefs and decodes percent-encoded slashes", () => {
    expect(parsePaDocHref("pa-doc:concepts%2Fagent-day#tldr")).toEqual({
      slug: "concepts/agent-day",
      anchor: "tldr",
    });
  });
});
