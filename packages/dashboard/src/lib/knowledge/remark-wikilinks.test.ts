import { describe, it, expect } from "vitest";
import type { MdastNode } from "@/lib/docs/remark-citations";
import {
  bareSlugCandidates,
  normalizeWikiTarget,
  parsePaWikiHref,
  resolveBareSlug,
  splitWikilinksInText,
  transformWikilinks,
  wikiTargetHref,
} from "./remark-wikilinks";

const text = (value: string): MdastNode => ({ type: "text", value });

describe("splitWikilinksInText", () => {
  it("rewrites a path-qualified wikilink into a pa-wiki link node", () => {
    const out = splitWikilinksInText(
      "See [[knowledge/sources/ucla-eda-viz/syllabus]] for details",
    );
    expect(out).toEqual([
      { type: "text", value: "See " },
      {
        type: "link",
        url: `pa-wiki:${encodeURIComponent("knowledge/sources/ucla-eda-viz/syllabus")}`,
        title: null,
        children: [
          { type: "text", value: "knowledge/sources/ucla-eda-viz/syllabus" },
        ],
      },
      { type: "text", value: " for details" },
    ]);
  });

  it("uses the alias as link text when present", () => {
    const out = splitWikilinksInText(
      "[[knowledge/sources/ucla-eda-viz/syllabus|Course syllabus (PDF)]]",
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      type: "link",
      children: [{ type: "text", value: "Course syllabus (PDF)" }],
    });
  });

  it("handles a text node that is exactly one wikilink (list-item shape)", () => {
    const out = splitWikilinksInText("[[plans/projects/acme-launch]]");
    expect(out).toHaveLength(1);
    expect(out[0]!.type).toBe("link");
  });

  it("drops a #heading suffix from the target", () => {
    const out = splitWikilinksInText("[[identity/people.md#alice|Alice]]");
    expect(out[0]).toMatchObject({
      type: "link",
      url: `pa-wiki:${encodeURIComponent("identity/people")}`,
    });
  });

  it("strips a trailing .md extension from the target", () => {
    const out = splitWikilinksInText("[[plans/projects/acme.md]]");
    expect(out[0]).toMatchObject({
      url: `pa-wiki:${encodeURIComponent("plans/projects/acme")}`,
      children: [{ type: "text", value: "plans/projects/acme" }],
    });
  });

  it("leaves pure-anchor self links as plain text", () => {
    const out = splitWikilinksInText("jump to [[#setup]]");
    expect(out).toEqual([{ type: "text", value: "jump to [[#setup]]" }]);
  });

  it("skips embeds (![[...]])", () => {
    const out = splitWikilinksInText("![[syllabus.pdf]]");
    expect(out).toEqual([{ type: "text", value: "![[syllabus.pdf]]" }]);
  });

  it("keeps bare slugs verbatim", () => {
    const out = splitWikilinksInText("Project: [[acme-launch]]");
    expect(out).toEqual([
      { type: "text", value: "Project: " },
      {
        type: "link",
        url: "pa-wiki:acme-launch",
        title: null,
        children: [{ type: "text", value: "acme-launch" }],
      },
    ]);
  });

  it("handles multiple wikilinks with surrounding text preserved", () => {
    const out = splitWikilinksInText("a [[x/y]] b [[p/q|Q]] c");
    expect(out.map((n) => n.type)).toEqual([
      "text",
      "link",
      "text",
      "link",
      "text",
    ]);
    expect(out[0]!.value).toBe("a ");
    expect(out[2]!.value).toBe(" b ");
    expect(out[4]!.value).toBe(" c");
  });

  it("returns the original text when no wikilink is present", () => {
    expect(splitWikilinksInText("no links here")).toEqual([
      { type: "text", value: "no links here" },
    ]);
  });
});

describe("transformWikilinks", () => {
  const paragraphWith = (...children: MdastNode[]): MdastNode => ({
    type: "paragraph",
    children,
  });

  it("rewrites wikilinks inside a paragraph", () => {
    const tree: MdastNode = {
      type: "root",
      children: [paragraphWith(text("see [[a/b]]"))],
    };
    transformWikilinks(tree);
    const para = tree.children![0]!;
    expect(para.children!.map((n) => n.type)).toEqual(["text", "link"]);
  });

  it("skips fenced code blocks", () => {
    const tree: MdastNode = {
      type: "root",
      children: [{ type: "code", value: "[[a/b]]" }],
    };
    transformWikilinks(tree);
    expect(tree.children![0]).toEqual({ type: "code", value: "[[a/b]]" });
  });

  it("skips inline code spans", () => {
    const tree: MdastNode = {
      type: "root",
      children: [paragraphWith({ type: "inlineCode", value: "[[a/b]]" })],
    };
    transformWikilinks(tree);
    expect(tree.children![0]!.children![0]).toEqual({
      type: "inlineCode",
      value: "[[a/b]]",
    });
  });

  it("does not linkify inside an existing link node", () => {
    const link: MdastNode = {
      type: "link",
      url: "https://example.com",
      children: [text("[[a/b]]")],
    };
    const tree: MdastNode = { type: "root", children: [paragraphWith(link)] };
    transformWikilinks(tree);
    expect(link.children).toEqual([text("[[a/b]]")]);
  });
});

describe("normalizeWikiTarget", () => {
  it("trims whitespace and strips .md", () => {
    expect(normalizeWikiTarget(" plans/projects/acme.md ")).toBe(
      "plans/projects/acme",
    );
  });

  it("returns null for pure-anchor targets", () => {
    expect(normalizeWikiTarget("#setup")).toBeNull();
  });
});

describe("parsePaWikiHref", () => {
  it("round-trips an encoded target", () => {
    const target = "knowledge/sources/ucla-eda-viz/syllabus";
    expect(parsePaWikiHref(`pa-wiki:${encodeURIComponent(target)}`)).toEqual({
      target,
    });
  });

  it("returns null for non-pa-wiki hrefs", () => {
    expect(parsePaWikiHref("https://example.com")).toBeNull();
    expect(parsePaWikiHref("pa-doc:some-doc")).toBeNull();
  });

  it("returns null for an empty target", () => {
    expect(parsePaWikiHref("pa-wiki:")).toBeNull();
  });

  it("returns null (not URIError) for malformed percent-encoding", () => {
    // A hand-written `[x](pa-wiki:%)` in vault content reaches the anchor
    // override verbatim; decoding must degrade, not crash the render.
    expect(parsePaWikiHref("pa-wiki:%")).toBeNull();
    expect(parsePaWikiHref("pa-wiki:%E0%A4%A")).toBeNull();
  });
});

describe("wikiTargetHref", () => {
  it("builds the Context Files deep-link with an encoded path", () => {
    expect(wikiTargetHref("knowledge/sources/a/b")).toBe(
      "/knowledge?tab=context-files&path=knowledge%2Fsources%2Fa%2Fb",
    );
  });
});

describe("bareSlugCandidates", () => {
  it("probes projects, then wiki, then dossiers", () => {
    expect(bareSlugCandidates("acme-launch")).toEqual([
      "plans/projects/acme-launch",
      "knowledge/wiki/acme-launch",
      "knowledge/dossiers/acme-launch",
    ]);
  });
});

describe("resolveBareSlug", () => {
  it("returns the first candidate that resolves and stops probing", async () => {
    const calls: string[] = [];
    const resolved = await resolveBareSlug("acme", async (path) => {
      calls.push(path);
      return {};
    });
    expect(resolved).toBe("plans/projects/acme");
    expect(calls).toEqual(["plans/projects/acme"]);
  });

  it("falls through 404s to later candidates", async () => {
    const resolved = await resolveBareSlug("acme", async (path) => {
      if (path !== "knowledge/dossiers/acme") throw new Error("404");
      return {};
    });
    expect(resolved).toBe("knowledge/dossiers/acme");
  });

  it("returns null when nothing resolves", async () => {
    const resolved = await resolveBareSlug("acme", async () => {
      throw new Error("404");
    });
    expect(resolved).toBeNull();
  });
});
