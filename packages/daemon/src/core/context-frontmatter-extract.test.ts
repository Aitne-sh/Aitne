import { describe, expect, it } from "vitest";

import {
  extractContextFrontmatter,
  readContextFrontmatterValues,
} from "./context-frontmatter-extract.js";

describe("extractContextFrontmatter", () => {
  it("returns null when there is no preamble", () => {
    expect(extractContextFrontmatter("# Heading\n")).toBeNull();
  });

  it("returns null when the block is unterminated", () => {
    expect(extractContextFrontmatter("---\nkind: identity\n# heading")).toBeNull();
  });

  it("extracts simple key/value pairs", () => {
    const result = extractContextFrontmatter(
      "---\nkind: identity\nauthority: user\n---\n# Body\n",
    );
    expect(result?.values).toEqual({ kind: "identity", authority: "user" });
    expect(result?.body).toBe("# Body\n");
  });

  it("strips single and double quotes", () => {
    const result = extractContextFrontmatter(
      `---\ntitle: "Quoted title"\nslug: 'single-quoted'\n---\n`,
    );
    expect(result?.values).toEqual({
      title: "Quoted title",
      slug: "single-quoted",
    });
  });

  it("strips inline comments after whitespace", () => {
    const result = extractContextFrontmatter(
      "---\nkind: identity # trailing\n---\n",
    );
    expect(result?.values.kind).toBe("identity");
  });

  it("preserves '#' inside quoted strings", () => {
    const result = extractContextFrontmatter(
      `---\ntitle: "hash # inside"\n---\n`,
    );
    expect(result?.values.title).toBe("hash # inside");
  });

  it("skips comments and blank lines", () => {
    const result = extractContextFrontmatter(
      "---\n# this is a comment\n\nkind: identity\n---\n",
    );
    expect(result?.values).toEqual({ kind: "identity" });
  });
});

describe("readContextFrontmatterValues", () => {
  it("returns just the values map", () => {
    const result = readContextFrontmatterValues(
      "---\nkind: state\n---\n# Body\n",
    );
    expect(result).toEqual({ kind: "state" });
  });

  it("returns null when no frontmatter", () => {
    expect(readContextFrontmatterValues("# Body\n")).toBeNull();
  });
});
