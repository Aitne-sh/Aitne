import { describe, expect, it } from "vitest";
import { parseHandoff } from "./handoff-parser.js";

describe("parseHandoff — happy path", () => {
  it("extracts Tomorrow and Later bullets from a well-formed body", () => {
    const body = [
      "# 2026-05-14 (Wednesday)",
      "",
      "## User Schedule",
      "- 10:00 Standup",
      "",
      "## Handoff",
      "### Tomorrow",
      "- Mail Alex back",
      "- Confirm Q2 OKRs",
      "### Later",
      "- 2026-05-20 Quarterly review prep",
      "",
    ].join("\n");
    expect(parseHandoff(body)).toEqual({
      tomorrow: ["Mail Alex back", "Confirm Q2 OKRs"],
      later: ["2026-05-20 Quarterly review prep"],
    });
  });

  it("returns empty arrays when both sub-sections carry the `- (none)` placeholder", () => {
    const body = [
      "## Handoff",
      "### Tomorrow",
      "- (none)",
      "### Later",
      "- (none)",
      "",
      "## Agent Log",
    ].join("\n");
    expect(parseHandoff(body)).toEqual({ tomorrow: [], later: [] });
  });

  it("recognises case-insensitive `none` / `(none)` placeholders without dropping real items", () => {
    const body = [
      "## Handoff",
      "### Tomorrow",
      "- NONE",
      "- Real item",
      "- none",
      "### Later",
      "- (None)",
    ].join("\n");
    expect(parseHandoff(body)).toEqual({
      tomorrow: ["Real item"],
      later: [],
    });
  });

  it("supports sub-sections appearing in reverse order", () => {
    const body = [
      "## Handoff",
      "### Later",
      "- carry-over item",
      "### Tomorrow",
      "- tomorrow item",
    ].join("\n");
    expect(parseHandoff(body)).toEqual({
      tomorrow: ["tomorrow item"],
      later: ["carry-over item"],
    });
  });

  it("returns whatever it found when only one sub-section is present", () => {
    const body = [
      "## Handoff",
      "### Tomorrow",
      "- only-tomorrow item",
    ].join("\n");
    expect(parseHandoff(body)).toEqual({
      tomorrow: ["only-tomorrow item"],
      later: [],
    });
  });

  it("stops at the next H2 boundary even when bullets follow", () => {
    const body = [
      "## Handoff",
      "### Tomorrow",
      "- tomorrow item",
      "",
      "## Agent Log",
      "- 04:00 Morning Routine completed",
    ].join("\n");
    expect(parseHandoff(body)).toEqual({
      tomorrow: ["tomorrow item"],
      later: [],
    });
  });

  it("trims trailing whitespace inside bullets", () => {
    const body = ["## Handoff", "### Tomorrow", "- spaced item   "].join("\n");
    expect(parseHandoff(body)).toEqual({
      tomorrow: ["spaced item"],
      later: [],
    });
  });

  it("silently skips non-bullet lines mixed into a sub-section body", () => {
    const body = [
      "## Handoff",
      "### Tomorrow",
      "stray prose line",
      "- real bullet",
      "  not a bullet either",
      "### Later",
      "- (none)",
    ].join("\n");
    expect(parseHandoff(body)).toEqual({
      tomorrow: ["real bullet"],
      later: [],
    });
  });

  it("ignores empty-string bullets (`- `) without throwing", () => {
    const body = [
      "## Handoff",
      "### Tomorrow",
      "- ",
      "- real",
    ].join("\n");
    expect(parseHandoff(body)).toEqual({
      tomorrow: ["real"],
      later: [],
    });
  });
});

describe("parseHandoff — fail-soft", () => {
  it("returns null for null input", () => {
    expect(parseHandoff(null)).toBeNull();
  });

  it("returns null for empty input", () => {
    expect(parseHandoff("")).toBeNull();
  });

  it("returns null when no `## Handoff` section exists", () => {
    const body = [
      "# 2026-05-14 (Wednesday)",
      "",
      "## User Schedule",
      "- 10:00 Standup",
    ].join("\n");
    expect(parseHandoff(body)).toBeNull();
  });

  it("returns empty arrays when `## Handoff` exists but has no sub-sections", () => {
    const body = ["## Handoff", "", "## Agent Log"].join("\n");
    expect(parseHandoff(body)).toEqual({ tomorrow: [], later: [] });
  });

  it("does not match `## handoff` lowercase — the evening flow writes title case", () => {
    const body = ["## handoff", "### Tomorrow", "- item"].join("\n");
    expect(parseHandoff(body)).toBeNull();
  });
});

describe("parseHandoff — additional edge cases", () => {
  it("parses CRLF-terminated input by splitting on `\\r?\\n` — operator edits authored on Windows are not silently fail-softed", () => {
    // node:fs preserves `\r` on Windows-authored files. The parser
    // normalises by splitting on `\r?\n`, so the header match succeeds
    // and Stage A skips the inline parse turn. Without this, fail-soft
    // would catch the bad line endings — correct but costs one extra
    // medium-tier turn for every CRLF yesterday.md.
    const body = ["## Handoff", "### Tomorrow", "- item"].join("\r\n");
    expect(parseHandoff(body)).toEqual({ tomorrow: ["item"], later: [] });
  });

  it("still fail-softs on a truly malformed body even after CRLF normalisation", () => {
    // Belt-and-braces: CRLF tolerance must not weaken the fail-soft
    // contract for genuine garbage. A body with no `## Handoff` header
    // still returns null — exercising the post-normalisation header
    // miss path.
    const body = "# 2026-05-14\r\n## User Schedule\r\n- 10:00 Standup\r\n";
    expect(parseHandoff(body)).toBeNull();
  });

  it("only consumes the first `## Handoff` section when the body has more than one", () => {
    // The orchestrator never writes two Handoff sections, but a stray
    // operator edit shouldn't merge them silently. The parser stops at
    // the next H2 boundary, so the second block's bullets are discarded.
    const body = [
      "## Handoff",
      "### Tomorrow",
      "- first-section item",
      "",
      "## Notes",
      "- noise",
      "",
      "## Handoff",
      "### Tomorrow",
      "- second-section item",
    ].join("\n");
    expect(parseHandoff(body)).toEqual({
      tomorrow: ["first-section item"],
      later: [],
    });
  });

  it("stops collecting at the first H3 boundary — duplicate sub-section headers do not re-open the inside flag", () => {
    // The collector `break`s on any `### ` or `## ` line once inside, so
    // a stray `### Random` H3 between two `### Tomorrow` headers
    // terminates collection entirely. Pin this: a future refactor that
    // tries to "resume" on a duplicate header would land as a behavior
    // change and should announce itself as a failing test.
    const body = [
      "## Handoff",
      "### Tomorrow",
      "- A",
      "### Random",
      "- skipped",
      "### Tomorrow",
      "- B",
    ].join("\n");
    expect(parseHandoff(body)).toEqual({ tomorrow: ["A"], later: [] });
  });

  it("treats `#### ` (H4) inside a sub-section as a non-bullet line, not a boundary", () => {
    // `line.startsWith("### ")` is FALSE for `"#### "` because position
    // 3 is `#` not ` `. So an H4 line is silently skipped (no regex
    // match) and bullet collection continues — pin this so the boundary
    // predicate stays specifically about H3.
    const body = [
      "## Handoff",
      "### Tomorrow",
      "- before H4",
      "#### Subheading",
      "- after H4",
    ].join("\n");
    expect(parseHandoff(body)).toEqual({
      tomorrow: ["before H4", "after H4"],
      later: [],
    });
  });

  it("preserves dashes inside bullet content (the BULLET_RE captures the rest greedily)", () => {
    const body = [
      "## Handoff",
      "### Tomorrow",
      "- 2026-05-20 Quarterly review — pre-brief Alex",
      "- ship --no-verify guard",
    ].join("\n");
    expect(parseHandoff(body)).toEqual({
      tomorrow: [
        "2026-05-20 Quarterly review — pre-brief Alex",
        "ship --no-verify guard",
      ],
      later: [],
    });
  });

  it("ignores a `- (none)` placeholder mid-list and keeps real items around it", () => {
    // Stress test for the regex-driven `(none)` filter: it should match
    // only when the bullet's payload (after trimming) is exactly the
    // placeholder, not when "none" appears as a word inside a real item.
    const body = [
      "## Handoff",
      "### Tomorrow",
      "- real item one",
      "- (none)",
      "- nonexistent project follow-up", // contains "none" as substring
      "- none",
    ].join("\n");
    expect(parseHandoff(body)).toEqual({
      tomorrow: ["real item one", "nonexistent project follow-up"],
      later: [],
    });
  });
});
