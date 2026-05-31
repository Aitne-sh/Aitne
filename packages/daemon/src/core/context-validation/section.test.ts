import { describe, it, expect } from "vitest";
import {
  findSection,
  getAvailableSections,
  normalizeSection,
  sumLength,
} from "./section.js";

describe("normalizeSection", () => {
  it("lowercases and converts whitespace to underscores", () => {
    expect(normalizeSection("Raw Signals")).toBe("raw_signals");
    expect(normalizeSection("Multi  Word Section")).toBe("multi_word_section");
  });

  it("strips leading hash prefix", () => {
    expect(normalizeSection("## Raw Signals")).toBe("raw_signals");
    expect(normalizeSection("### Sub")).toBe("sub");
  });

  it("returns empty string for an empty input", () => {
    expect(normalizeSection("")).toBe("");
  });
});

describe("sumLength", () => {
  it("counts characters plus one per line up to the given index", () => {
    const lines = ["abc", "de", "f"];
    expect(sumLength(lines, 0)).toBe(0);
    expect(sumLength(lines, 1)).toBe(4); // "abc\n"
    expect(sumLength(lines, 2)).toBe(7); // "abc\nde\n"
    expect(sumLength(lines, 3)).toBe(9); // "abc\nde\nf\n"
  });
});

describe("findSection", () => {
  it("returns null when the section is absent", () => {
    expect(findSection("# Title\n\n## Other\nbody\n", "Missing")).toBeNull();
  });

  it("locates a section and reports its boundaries", () => {
    const content = [
      "# Title",
      "",
      "## First",
      "body of first",
      "",
      "## Second",
      "body of second",
    ].join("\n");
    const bounds = findSection(content, "First");
    expect(bounds).not.toBeNull();
    expect(content.slice(bounds!.start, bounds!.end)).toContain("body of first");
    expect(content.slice(bounds!.start, bounds!.end)).not.toContain("body of second");
  });

  it("treats EOF as the section terminator when no next ## follows", () => {
    const content = "# Title\n\n## Only\nbody\n";
    const bounds = findSection(content, "Only");
    expect(bounds).not.toBeNull();
    expect(bounds!.end).toBe(content.length);
  });

  it("handles a section header with no trailing newline at EOF", () => {
    const bounds = findSection("## Tail", "Tail");
    expect(bounds).not.toBeNull();
    expect(bounds!.start).toBe(bounds!.end);
  });

  it("matches case- and spacing-insensitively", () => {
    const content = "## Raw Signals\nbody\n";
    expect(findSection(content, "raw signals")).not.toBeNull();
    expect(findSection(content, "RAW_SIGNALS")).not.toBeNull();
  });

  it("is CRLF-tolerant: matches headers and reports correct byte bounds on a \\r\\n file", () => {
    // A CRLF-bodied vault file (Windows daemon, or Obsidian/git with
    // core.autocrlf). split("\n") leaves a trailing \r on every header line;
    // the matcher must strip it while byte offsets still account for the \r.
    const content = "# Title\r\n\r\n## First\r\nbody\r\n## Second\r\nmore\r\n";
    const bounds = findSection(content, "First");
    expect(bounds).not.toBeNull();
    // start = just after "## First\r\n"; end = start of "## Second\r\n".
    expect(content.slice(bounds!.start, bounds!.end)).toBe("body\r\n");
  });
});

describe("getAvailableSections", () => {
  it("returns each H2 in document order, normalized", () => {
    const content = [
      "# Title",
      "## First Section",
      "body",
      "## Second",
      "body",
      "### Sub",
      "more",
    ].join("\n");
    expect(getAvailableSections(content)).toEqual(["first_section", "second"]);
  });

  it("returns [] when the file has no H2 headers", () => {
    expect(getAvailableSections("# Title\nbody\n### Sub\n")).toEqual([]);
  });

  it("is CRLF-tolerant: strips trailing \\r before matching headers", () => {
    const content = "# Title\r\n## First Section\r\nbody\r\n## Second\r\nmore\r\n";
    expect(getAvailableSections(content)).toEqual(["first_section", "second"]);
  });
});
