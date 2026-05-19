import { describe, it, expect } from "vitest";
import {
  extractTerms,
  iterateHeadings,
  LEADING_PARAGRAPH_MAX_LEN,
} from "./extract-terms.js";
import type { DocsFrontmatter } from "@aitne/shared";

function fm(overrides: Partial<DocsFrontmatter> = {}): DocsFrontmatter {
  return {
    schema_version: 1,
    slug: "concepts/agent-day",
    title: "Agent Day",
    category: "concepts",
    summary: "Day boundary at 04:00.",
    ...overrides,
  } as DocsFrontmatter;
}

describe("iterateHeadings", () => {
  it("returns H1, H2, H3 in document order with line indices", () => {
    const body = `# Title
text
## Two
### Three`;
    expect(iterateHeadings(body)).toEqual([
      { level: 1, text: "Title", lineIndex: 0 },
      { level: 2, text: "Two", lineIndex: 2 },
      { level: 3, text: "Three", lineIndex: 3 },
    ]);
  });

  it("skips a heading inside a triple-backtick fenced block", () => {
    const body = `## Real
\`\`\`
## Inside Code
\`\`\`
## After`;
    expect(iterateHeadings(body).map((h) => h.text)).toEqual([
      "Real",
      "After",
    ]);
  });

  it("skips a heading inside a tilde-fenced block", () => {
    const body = `## Real
~~~
## Inside Tildes
~~~
## After`;
    expect(iterateHeadings(body).map((h) => h.text)).toEqual([
      "Real",
      "After",
    ]);
  });

  it("ignores H4+ and setext-style headings", () => {
    const body = `## Real
#### Too Deep
Setext-style
============`;
    expect(iterateHeadings(body).map((h) => h.text)).toEqual(["Real"]);
  });

  it("treats an unbalanced opening fence as 'remain inside' to EOF", () => {
    const body = `## Before
\`\`\`
## Inside Forever
text
## Still Inside`;
    expect(iterateHeadings(body).map((h) => h.text)).toEqual(["Before"]);
  });
});

describe("extractTerms", () => {
  it("emits exactly the doc-level row for an empty body", () => {
    const rows = extractTerms(fm(), "");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      anchor: "",
      term: "Agent Day",
      summary: "Day boundary at 04:00.",
    });
  });

  it("emits doc-level + 1 section row for one H2 with one paragraph", () => {
    const rows = extractTerms(
      fm(),
      `# Agent Day
## TL;DR
Day boundary at 04:00.`,
    );
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({
      anchor: "tldr",
      term: "TL;DR",
      summary: "Day boundary at 04:00.",
    });
  });

  it("emits one row per H2/H3 in document order", () => {
    const rows = extractTerms(
      fm(),
      `# Title
## Alpha
alpha body
### Alpha One
sub body
## Beta
beta body`,
    );
    expect(rows.map((r) => r.anchor)).toEqual([
      "",
      "alpha",
      "alpha-one",
      "beta",
    ]);
  });

  it("skips H1 — no row produced for the H1 heading itself", () => {
    const rows = extractTerms(fm(), `# Title\n## Real`);
    expect(rows.map((r) => r.anchor)).toEqual(["", "real"]);
  });

  it("caps section-lead summary at LEADING_PARAGRAPH_MAX_LEN", () => {
    const longLine = "x".repeat(LEADING_PARAGRAPH_MAX_LEN + 100);
    const rows = extractTerms(fm(), `## Big\n${longLine}`);
    expect(rows[1]!.summary).toHaveLength(LEADING_PARAGRAPH_MAX_LEN);
  });

  it("emits a row for an H2 with no body (term-only) so the heading is searchable", () => {
    const rows = extractTerms(fm(), `## Empty Section\n## Next`);
    const empty = rows.find((r) => r.anchor === "empty-section");
    expect(empty).toBeDefined();
    expect(empty!.summary).toBe("");
  });

  it("merges aliases + keywords + ask_examples into the doc-level aliases column", () => {
    const rows = extractTerms(
      fm({
        aliases: ["delegated", "direct mode"],
        keywords: ["delegated mode", "integration"],
        ask_examples: ["What is delegated mode?"],
      }),
      "",
    );
    expect(rows[0]!.aliases.split("\n")).toEqual([
      "delegated",
      "direct mode",
      "delegated mode",
      "integration",
      "What is delegated mode?",
    ]);
  });

  it("does NOT detect a heading inside a triple-backtick fenced block", () => {
    const rows = extractTerms(
      fm(),
      `## Real
\`\`\`
## Inside Code
\`\`\`
text after`,
    );
    expect(rows.map((r) => r.anchor)).toEqual(["", "real"]);
  });

  it("does NOT detect a heading inside a tilde-fenced block", () => {
    const rows = extractTerms(
      fm(),
      `## Real
~~~
## Inside Tildes
~~~
text after`,
    );
    expect(rows.map((r) => r.anchor)).toEqual(["", "real"]);
  });

  it("detects a heading on the line immediately after a closing fence", () => {
    const rows = extractTerms(
      fm(),
      `## Before
\`\`\`
example
\`\`\`
## After`,
    );
    expect(rows.map((r) => r.anchor)).toEqual(["", "before", "after"]);
  });

  it("treats an unbalanced fence as 'remain inside' until EOF (documented degraded behavior)", () => {
    const rows = extractTerms(
      fm(),
      `## Before
\`\`\`
## Inside Forever
## Still Inside`,
    );
    expect(rows.map((r) => r.anchor)).toEqual(["", "before"]);
  });

  it("joins a bullet-list block immediately under an H2 into the section summary (no leading blank)", () => {
    const rows = extractTerms(
      fm(),
      `## Items
- one
- two
- three

next paragraph`,
    );
    const items = rows.find((r) => r.anchor === "items")!;
    expect(items.summary).toBe("- one - two - three");
  });

  it("includes a fenced code block under an H2 into the summary; a blank line INSIDE the fence does not terminate", () => {
    const rows = extractTerms(
      fm(),
      `## Example
\`\`\`
line1

line2
\`\`\`

after`,
    );
    const example = rows.find((r) => r.anchor === "example")!;
    expect(example.summary).toContain("line1");
    expect(example.summary).toContain("line2");
    // Fence delimiter lines themselves are markup, not content — they
    // must NOT surface in the term-search summary string. A regression
    // here would render literal backticks in the API response and any
    // UI surfacing the summary.
    expect(example.summary).not.toContain("```");
  });

  it("dedups H2/H3 sections whose headings slugify to the same anchor (first wins)", () => {
    // Two H2s with the same heading text both slugify to "why". Without
    // dedup the term-search response contains two rows whose `citation`
    // string is byte-identical — the operator gets two cards that
    // scroll to the same #why anchor. Keep the first occurrence; drop
    // the second.
    const rows = extractTerms(
      fm(),
      `# Title
## Why
first definition
## Other
unrelated body
## Why
later elaboration`,
    );
    const whyRows = rows.filter((r) => r.anchor === "why");
    expect(whyRows).toHaveLength(1);
    expect(whyRows[0]!.summary).toBe("first definition");
    // Document order is preserved otherwise.
    expect(rows.map((r) => r.anchor)).toEqual(["", "why", "other"]);
  });

  it("emits an empty summary when an H2 is followed immediately by a blank line", () => {
    const rows = extractTerms(
      fm(),
      `## Empty

paragraph after blank
## Next`,
    );
    const empty = rows.find((r) => r.anchor === "empty")!;
    expect(empty.summary).toBe("");
  });

  it("skips an H2 whose text slugifies to empty (e.g. all-CJK or all-punctuation)", () => {
    // `slugifyAnchor` strips [^a-z0-9\s-] before trimming, so a heading
    // composed entirely of CJK (or only punctuation) yields ""; we must
    // skip the row rather than emit a phantom anchor that collides with
    // the doc-level row's empty anchor.
    const rows = extractTerms(
      fm(),
      `# Title
## 漢字のみ
content
## Real
real body`,
    );
    expect(rows.map((r) => r.anchor)).toEqual(["", "real"]);
  });

  it("handles a leading blank line before the H1 (parseFrontmatter shape)", () => {
    // parseFrontmatter joins body lines with `\n` starting at the line
    // after the closing `---`. The first body character is typically a
    // newline (blank line under the closing marker). Make sure that
    // doesn't produce phantom rows or shift line indices.
    const rows = extractTerms(
      fm(),
      `\n# Title\n## Real\nbody`,
    );
    expect(rows.map((r) => r.anchor)).toEqual(["", "real"]);
    expect(rows[1]!.summary).toBe("body");
  });
});

