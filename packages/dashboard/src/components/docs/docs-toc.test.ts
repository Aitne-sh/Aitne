import { describe, it, expect } from "vitest";
import { extractH2Entries } from "./docs-toc";

describe("extractH2Entries", () => {
  it("captures H2 headings only (not H1 or H3)", () => {
    const body = `# Title
## First
### Subhead
## Second
text
## Third`;
    expect(extractH2Entries(body)).toEqual([
      { anchor: "first", text: "First" },
      { anchor: "second", text: "Second" },
      { anchor: "third", text: "Third" },
    ]);
  });

  it("strips trailing closing `#` characters", () => {
    expect(extractH2Entries("## A heading ##")).toEqual([
      { anchor: "a-heading", text: "A heading" },
    ]);
  });

  it("ignores `## ` lines inside fenced code blocks", () => {
    const body = `## Real
\`\`\`
## Fake heading inside code fence
\`\`\`
## Another real`;
    expect(extractH2Entries(body)).toEqual([
      { anchor: "real", text: "Real" },
      { anchor: "another-real", text: "Another real" },
    ]);
  });

  it("returns [] for a body with no H2s", () => {
    expect(extractH2Entries("# only h1\n### only h3\nbody text")).toEqual([]);
  });
});
