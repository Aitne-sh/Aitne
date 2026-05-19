import { describe, it, expect } from "vitest";
import {
  extractMailHtmlBody,
  htmlToPlainText,
  renderExtractedMailHtmlBody,
} from "./html-to-plaintext.js";

describe("htmlToPlainText", () => {
  it("strips plain tags", () => {
    expect(htmlToPlainText("<p>hello <b>world</b></p>")).toBe("hello world");
  });

  it("drops style/script content entirely", () => {
    const html =
      "<style>.x{color:red}</style>" +
      "<script>alert(1)</script>" +
      "<p>Booking code ABCD12</p>";
    expect(htmlToPlainText(html)).toBe("Booking code ABCD12");
  });

  it("decodes numeric and named entities", () => {
    // &#8212; = em dash; &amp; = ampersand; &nbsp; decodes to U+00A0
    const html = "<p>A&nbsp;B&amp;C&lt;D&gt; &#8212; $500.00</p>";
    const out = htmlToPlainText(html);
    expect(out).toContain("B&C<D>");
    expect(out).toContain("—");
    expect(out).toContain("$500.00");
  });

  it("collapses tables into line-separated text", () => {
    const html = "<table><tr><td>Left</td><td>Right</td></tr></table>";
    const out = htmlToPlainText(html);
    expect(out).toContain("Left");
    expect(out).toContain("Right");
  });

  it("does not wrap anchors into markdown-style link text", () => {
    const html = '<a href="https://example.com/x">Click here</a>';
    const out = htmlToPlainText(html);
    // Should NOT be `Click here [https://example.com/x]` or similar
    expect(out).not.toMatch(/\[.*\]/);
  });

  it("tolerates malformed tags without throwing", () => {
    expect(() => htmlToPlainText("<p>oops<div")).not.toThrow();
  });

  it("returns trimmed output", () => {
    expect(htmlToPlainText("<p>  hello  </p>")).toBe("hello");
  });
});

describe("extractMailHtmlBody", () => {
  it("preserves visible text, link URLs, and image alt metadata", () => {
    const html = `
      <html>
        <head><title>ignored</title></head>
        <head><a href="https://example.com/head">head link</a></head>
        <body>
          <style>.hidden{display:none}</style>
          <script>track()</script>
          <p>Confirmation <strong>MNPQEN</strong></p>
          <a href="https://example.com/manage?c=MNPQEN&amp;src=email&#x26;seat=12A" title="Trip details">Manage trip</a>
          <img alt="Boarding barcode" src="cid:barcode-1">
        </body>
      </html>
    `;
    const extracted = extractMailHtmlBody(html);
    const rendered = renderExtractedMailHtmlBody(extracted);
    expect(extracted.text).toContain("Confirmation MNPQEN");
    expect(extracted.text).not.toContain("track()");
    expect(extracted.links).toEqual([
      {
        text: "Manage trip",
        href: "https://example.com/manage?c=MNPQEN&src=email&seat=12A",
        title: "Trip details",
      },
    ]);
    expect(extracted.images).toEqual([
      { alt: "Boarding barcode", title: null, src: "cid:barcode-1" },
    ]);
    expect(rendered).toContain("Manage trip: https://example.com/manage?c=MNPQEN&src=email&seat=12A");
    expect(rendered).toContain("Boarding barcode: cid:barcode-1");
  });

  it("skips anchors that have no href", () => {
    const html = '<body><a>nameless anchor</a><a href="https://x.example/x">named</a></body>';
    const extracted = extractMailHtmlBody(html);
    expect(extracted.links).toEqual([
      { text: "named", href: "https://x.example/x", title: null },
    ]);
  });

  it("deduplicates identical anchors and identical images", () => {
    const html = `
      <body>
        <a href="https://x.example/a" title="t">A</a>
        <a href="https://x.example/a" title="t">A</a>
        <img alt="logo" src="cid:logo">
        <img alt="logo" src="cid:logo">
      </body>
    `;
    const extracted = extractMailHtmlBody(html);
    expect(extracted.links).toHaveLength(1);
    expect(extracted.images).toHaveLength(1);
  });

  it("skips images with no alt, title, or src attributes", () => {
    const html = '<body><img><img alt="logo"></body>';
    const extracted = extractMailHtmlBody(html);
    expect(extracted.images).toEqual([
      { alt: "logo", title: null, src: null },
    ]);
  });

  it("falls back to the title when an anchor has no inner text", () => {
    const html = '<body><a href="https://x.example" title="Tooltip"></a></body>';
    const extracted = extractMailHtmlBody(html);
    const rendered = renderExtractedMailHtmlBody(extracted);
    // text === null, title === "Tooltip" → rendered as Tooltip
    expect(rendered).toContain("Tooltip: https://x.example");
  });

  it("falls back to '(no text)' / '(no alt/title)' when nothing is available", () => {
    // Anchor with href but no text, no title.
    const html = '<body><a href="https://x.example/no-text"></a></body>';
    const extracted = extractMailHtmlBody(html);
    const rendered = renderExtractedMailHtmlBody(extracted);
    expect(rendered).toContain("(no text): https://x.example/no-text");
  });

  it("renders an image without src as a plain bullet (no URL)", () => {
    // Image with alt but no src — the renderer prints the label only.
    const html = '<body><img alt="banner"></body>';
    const extracted = extractMailHtmlBody(html);
    const rendered = renderExtractedMailHtmlBody(extracted);
    expect(rendered).toContain("- banner");
    expect(rendered).not.toContain("- banner:");
  });

  it("renders an image without alt or title as '(no alt/title): src'", () => {
    const html = '<body><img src="cid:bare"></body>';
    const extracted = extractMailHtmlBody(html);
    const rendered = renderExtractedMailHtmlBody(extracted);
    expect(rendered).toContain("(no alt/title): cid:bare");
  });

  it("supports single-quoted and unquoted attribute values", () => {
    const html = "<body><a href='https://single.example/a' title=plain>x</a></body>";
    const extracted = extractMailHtmlBody(html);
    expect(extracted.links[0].href).toBe("https://single.example/a");
    expect(extracted.links[0].title).toBe("plain");
  });

  it("decodes numeric and named entities inside attribute values", () => {
    const html =
      '<body><a href="https://x.example/p?a=1&amp;b=2&#38;c=3&#x3D;ok">x</a></body>';
    const extracted = extractMailHtmlBody(html);
    expect(extracted.links[0].href).toBe("https://x.example/p?a=1&b=2&c=3=ok");
  });

  it("returns out-of-range numeric entities verbatim", () => {
    // 0x110000 is above the Unicode range; the decoder must leave the
    // raw entity in place rather than throw.
    const html = '<body><a href="https://x.example/&#x110000;">x</a></body>';
    const extracted = extractMailHtmlBody(html);
    expect(extracted.links[0].href).toContain("&#x110000;");
  });

  it("returns the entire HTML when there is no <body> tag", () => {
    const html = "<div>No body wrapper here</div>";
    const extracted = extractMailHtmlBody(html);
    expect(extracted.text).toContain("No body wrapper here");
  });

  it("renders an empty extracted body as the empty string", () => {
    const empty = renderExtractedMailHtmlBody({
      text: "",
      links: [],
      images: [],
    });
    expect(empty).toBe("");
  });
});
