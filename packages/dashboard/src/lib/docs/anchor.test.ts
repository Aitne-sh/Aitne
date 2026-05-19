import { describe, expect, it } from "vitest";
import { scrollToAnchor, slugifyAnchor, stripLeadingTitleH1 } from "./anchor";

// jsdom is not configured in this workspace, so the DOM-touching code
// path of scrollToAnchor is exercised only by the empty-anchor early
// return. Visual / interaction coverage of the scroll behavior happens
// in manual QA against the live dashboard.

describe("slugifyAnchor (re-exported from shared)", () => {
  it("matches a representative set of headings", () => {
    expect(slugifyAnchor("What It Outputs")).toBe("what-it-outputs");
    expect(slugifyAnchor("In One Sentence")).toBe("in-one-sentence");
    expect(slugifyAnchor("HTTP/SSE & retries")).toBe("httpsse-retries");
    expect(slugifyAnchor("  spaces   collapsed  ")).toBe("spaces-collapsed");
  });
});

describe("scrollToAnchor", () => {
  it("returns false when the anchor is empty (no DOM lookup)", () => {
    expect(scrollToAnchor("")).toBe(false);
  });
});

describe("stripLeadingTitleH1", () => {
  it("strips a leading `# Title` matching the frontmatter title", () => {
    const body = "# Morning Routine\n\n## TL;DR\n\nbody…";
    expect(stripLeadingTitleH1(body, "Morning Routine")).toBe(
      "## TL;DR\n\nbody…",
    );
  });

  it("ignores casing and whitespace differences", () => {
    const body = "#  morning   routine\n\nbody";
    expect(stripLeadingTitleH1(body, "Morning Routine")).toBe("body");
  });

  it("strips a heading with trailing closing `#` characters", () => {
    const body = "# Morning Routine #\n\nbody";
    expect(stripLeadingTitleH1(body, "Morning Routine")).toBe("body");
  });

  it("preserves a leading H1 with different text", () => {
    const body = "# Different Heading\n\nbody";
    expect(stripLeadingTitleH1(body, "Morning Routine")).toBe(body);
  });

  it("preserves a body that does not start with an H1", () => {
    const body = "## TL;DR\n\nbody";
    expect(stripLeadingTitleH1(body, "Morning Routine")).toBe(body);
  });

  it("only strips the first H1, not subsequent ones", () => {
    const body = "# Morning Routine\n\n# Morning Routine\n\nbody";
    expect(stripLeadingTitleH1(body, "Morning Routine")).toBe(
      "# Morning Routine\n\nbody",
    );
  });

  it("returns the body unchanged if title is empty after slugification", () => {
    const body = "# Heading\n\nbody";
    expect(stripLeadingTitleH1(body, "")).toBe(body);
    expect(stripLeadingTitleH1(body, "  ")).toBe(body);
  });
});
