import { describe, expect, it } from "vitest";
import {
  AgentFrontmatterError,
  parseAgentFrontmatter,
  renderAgentMarkdown,
} from "./agent-frontmatter.js";

describe("parseAgentFrontmatter", () => {
  it("parses a nested frontmatter mapping + trimmed body", () => {
    const content = [
      "---",
      "slug: morning-routine",
      "schedule:",
      "  kind: cron",
      "  expression: '0 4 * * *'",
      "---",
      "",
      "Body line one.",
      "",
    ].join("\n");
    const { frontmatter, body } = parseAgentFrontmatter(content);
    expect(frontmatter).toEqual({
      slug: "morning-routine",
      schedule: { kind: "cron", expression: "0 4 * * *" },
    });
    expect(body).toBe("Body line one.");
  });

  it("handles CRLF line endings", () => {
    const content = "---\r\nslug: x\r\n---\r\nbody\r\n";
    const { frontmatter, body } = parseAgentFrontmatter(content);
    expect(frontmatter).toEqual({ slug: "x" });
    expect(body).toBe("body");
  });

  it("throws when the document does not open with a fence", () => {
    expect(() => parseAgentFrontmatter("not a fence\nslug: x")).toThrow(
      AgentFrontmatterError,
    );
    expect(() => parseAgentFrontmatter("not a fence\nslug: x")).toThrow(
      /must open with a `---`/,
    );
  });

  it("throws when the frontmatter block is never closed", () => {
    expect(() => parseAgentFrontmatter("---\nslug: x\nno close fence")).toThrow(
      /never closed/,
    );
  });

  it("throws AgentFrontmatterError on invalid YAML", () => {
    // Unclosed flow sequence — js-yaml raises a YAMLException.
    const content = "---\nfoo: [1, 2\n---\nbody";
    expect(() => parseAgentFrontmatter(content)).toThrow(AgentFrontmatterError);
    expect(() => parseAgentFrontmatter(content)).toThrow(/not valid YAML/);
  });

  it("throws when the frontmatter block is empty", () => {
    expect(() => parseAgentFrontmatter("---\n---\nbody")).toThrow(/empty/);
  });

  it("throws when the frontmatter is a scalar", () => {
    expect(() => parseAgentFrontmatter("---\njust a string\n---\nbody")).toThrow(
      /must be a YAML mapping/,
    );
  });

  it("throws when the frontmatter is a sequence", () => {
    expect(() => parseAgentFrontmatter("---\n- a\n- b\n---\nbody")).toThrow(
      /must be a YAML mapping/,
    );
  });
});

describe("renderAgentMarkdown", () => {
  it("renders a frontmatter block + body that round-trips", () => {
    const fm = {
      slug: "weekly-bookmarks",
      name: "Weekly Bookmarks",
      schedule: { kind: "cron", expression: "0 21 * * 0" },
    };
    const md = renderAgentMarkdown(fm, "  Prompt body.  ");
    expect(md.startsWith("---\n")).toBe(true);
    expect(md.endsWith("\n")).toBe(true);
    const parsed = parseAgentFrontmatter(md);
    expect(parsed.frontmatter).toEqual(fm);
    expect(parsed.body).toBe("Prompt body.");
  });

  it("preserves long cron / path strings without line-wrapping", () => {
    const fm = { expression: "*/5 0,6,12,18 * * 1,2,3,4,5" };
    const md = renderAgentMarkdown(fm, "x");
    expect(md).toContain("*/5 0,6,12,18 * * 1,2,3,4,5");
  });
});
