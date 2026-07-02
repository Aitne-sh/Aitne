/**
 * End-to-end coverage of the assumption the unit tests can't reach: that
 * micromark/remark leaves `[[target|alias]]` tokens intact inside text
 * nodes (unresolved reference links stay literal), and that the plugin +
 * urlTransform survive the real react-markdown pipeline. Rendered with
 * `renderToStaticMarkup` — node env, no DOM.
 */
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { knowledgeUrlTransform, remarkWikilinks } from "./remark-wikilinks";

function render(markdown: string): string {
  return renderToStaticMarkup(
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkWikilinks]}
      urlTransform={knowledgeUrlTransform}
    >
      {markdown}
    </ReactMarkdown>,
  );
}

describe("remark-wikilinks through the react-markdown pipeline", () => {
  it("renders a path-qualified aliased wikilink as a pa-wiki anchor", () => {
    const html = render(
      "See [[knowledge/sources/ucla-eda-viz/syllabus|Course syllabus (PDF)]] for details.",
    );
    expect(html).toContain(
      `href="pa-wiki:${encodeURIComponent("knowledge/sources/ucla-eda-viz/syllabus")}"`,
    );
    expect(html).toContain(">Course syllabus (PDF)</a>");
  });

  it("renders a bare-slug wikilink (source-card Project line)", () => {
    const html = render("Project: [[acme-launch]]");
    expect(html).toContain('href="pa-wiki:acme-launch"');
    expect(html).toContain(">acme-launch</a>");
  });

  it("renders a list-item wikilink (## Sources bullet shape)", () => {
    const html = render("- [[knowledge/sources/acme/pitch-deck|Pitch deck]]");
    expect(html).toContain("<li>");
    expect(html).toContain(">Pitch deck</a>");
  });

  it("leaves wikilink syntax in inline code untouched", () => {
    const html = render("Use `[[a/b]]` to link.");
    expect(html).toContain("<code>[[a/b]]</code>");
    expect(html).not.toContain("pa-wiki");
  });

  it("leaves wikilink syntax in fenced code blocks untouched", () => {
    const html = render("```\n[[a/b|alias]]\n```");
    expect(html).not.toContain("pa-wiki");
  });

  it("does not linkify embeds", () => {
    const html = render("![[deck.pdf]]");
    expect(html).not.toContain("pa-wiki");
  });

  it("keeps regular markdown links working through the urlTransform", () => {
    const html = render("[site](https://example.com)");
    expect(html).toContain('href="https://example.com"');
  });

  it("known v1 limitation: an unescaped pipe inside a GFM table cell splits the wikilink", () => {
    const html = render(
      "| col |\n| --- |\n| [[a/b|alias]] |",
    );
    // The table parser consumes the `|` before the plugin runs — no link
    // is produced. Obsidian escapes the pipe as `\|` in tables.
    expect(html).not.toContain("pa-wiki");
  });
});
