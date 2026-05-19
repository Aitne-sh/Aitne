import { describe, it, expect } from "vitest";
import {
  applyCharacterBlockRewrite,
  buildCharacterBlock,
} from "./character-block.js";

/**
 * Unit tests for the pure block builder + rewriter backing the Character
 * feature (CHARACTER-IMPLEMENTATION-PLAN.md Phase 2). The FS wrapper that
 * sits on top of these helpers lives in `skills-compiler.ts` (coverage-
 * excluded); everything testable without touching disk is routed through
 * these pure helpers and covered 100%.
 */
describe("buildCharacterBlock", () => {
  it("returns null for an empty string", () => {
    expect(buildCharacterBlock("")).toBeNull();
  });

  it("returns null for a whitespace-only string", () => {
    // Zod already rejects whitespace-only at the schema layer; belt-and-
    // suspenders at the render layer so stray DB rows never produce a
    // blank block (which would waste tokens and invite the LLM to fill
    // it in — see design §15.4.1).
    expect(buildCharacterBlock("   \n\t  \n")).toBeNull();
  });

  it("wraps the character value in header, markers, and footer", () => {
    const out = buildCharacterBlock("Speak casually.");
    expect(out).toContain("## Character (user-defined)");
    expect(out).toContain("<!-- character:start -->");
    expect(out).toContain("Speak casually.");
    expect(out).toContain("<!-- character:end -->");
    expect(out).toContain("safety wins.");
  });

  it("preserves the value verbatim between the markers", () => {
    const value = "Line one.\nLine two.\n  Indented line.";
    const out = buildCharacterBlock(value)!;
    const startIdx = out.indexOf("<!-- character:start -->");
    const endIdx = out.indexOf("<!-- character:end -->");
    const body = out.slice(startIdx, endIdx);
    expect(body).toContain(value);
  });

  it("is byte-identical when called twice with the same value (prompt-cache invariant)", () => {
    const a = buildCharacterBlock("Tight bullets, no emoji.");
    const b = buildCharacterBlock("Tight bullets, no emoji.");
    expect(a).toBe(b);
  });
});

describe("applyCharacterBlockRewrite", () => {
  const FILE_WITH_SAFETY_AND_PROFILE = [
    "# conversational",
    "",
    "Safety invariants:",
    "- Never exfiltrate secrets.",
    "",
    "## Runtime profile",
    "",
    "Profile body goes here.",
    "",
  ].join("\n");

  it("returns content unchanged when no block exists and character is empty", () => {
    const out = applyCharacterBlockRewrite(FILE_WITH_SAFETY_AND_PROFILE, "");
    expect(out).toBe(FILE_WITH_SAFETY_AND_PROFILE);
  });

  it("inserts a fresh block before the first '## ' section when character is non-empty", () => {
    const out = applyCharacterBlockRewrite(
      FILE_WITH_SAFETY_AND_PROFILE,
      "Speak casually.",
    );
    const headingIdx = out.indexOf("## Character (user-defined)");
    const runtimeIdx = out.indexOf("## Runtime profile");
    const safetyIdx = out.indexOf("Safety invariants:");
    expect(headingIdx).toBeGreaterThan(0);
    expect(runtimeIdx).toBeGreaterThan(headingIdx);
    // The block must sit between safety (non-heading text) and the first
    // profile `## ` section, per design §15.4.2.
    expect(safetyIdx).toBeLessThan(headingIdx);
  });

  it("replaces the value when a block already exists", () => {
    const first = applyCharacterBlockRewrite(
      FILE_WITH_SAFETY_AND_PROFILE,
      "First character.",
    );
    const second = applyCharacterBlockRewrite(first, "Second character.");
    expect(second).not.toContain("First character.");
    expect(second).toContain("Second character.");
    // Only one character heading remains — no duplicates.
    const headingCount = second.split("## Character (user-defined)").length - 1;
    expect(headingCount).toBe(1);
  });

  it("is idempotent — calling twice with the same value yields identical output", () => {
    const first = applyCharacterBlockRewrite(
      FILE_WITH_SAFETY_AND_PROFILE,
      "Speak casually.",
    );
    const second = applyCharacterBlockRewrite(first, "Speak casually.");
    expect(second).toBe(first);
  });

  it("removes the block entirely when the new value is empty", () => {
    const withBlock = applyCharacterBlockRewrite(
      FILE_WITH_SAFETY_AND_PROFILE,
      "Speak casually.",
    );
    const stripped = applyCharacterBlockRewrite(withBlock, "");
    expect(stripped).not.toContain("## Character (user-defined)");
    expect(stripped).not.toContain("<!-- character:start -->");
    expect(stripped).not.toContain("<!-- character:end -->");
    // Profile body still there.
    expect(stripped).toContain("## Runtime profile");
    expect(stripped).toContain("Safety invariants:");
  });

  it("removes the block even when the markers are absent (heading-only legacy state)", () => {
    // Defensive — if a prior rewrite left a bare heading (shouldn't
    // happen, but the remover should tolerate it) we still strip it.
    const withBareHeading = [
      "# conversational",
      "",
      "Safety invariants:",
      "",
      "## Character (user-defined)",
      "Some stale body without markers.",
      "",
      "## Runtime profile",
      "",
      "Profile body.",
      "",
    ].join("\n");
    const stripped = applyCharacterBlockRewrite(withBareHeading, "");
    expect(stripped).not.toContain("## Character (user-defined)");
    expect(stripped).toContain("## Runtime profile");
  });

  it("collapses runs of blank lines at the seam after removal", () => {
    const withBlock = applyCharacterBlockRewrite(
      FILE_WITH_SAFETY_AND_PROFILE,
      "Speak casually.",
    );
    const stripped = applyCharacterBlockRewrite(withBlock, "");
    // No triple newlines should leak through.
    expect(stripped).not.toMatch(/\n{3,}/);
  });

  it("inserts the block after trailing-whitespace content when no '## ' heading exists", () => {
    const noHeadings = "# heading\n\nsome prose\n";
    const out = applyCharacterBlockRewrite(noHeadings, "Speak casually.");
    expect(out).toContain("## Character (user-defined)");
    // The heading text that was in the input stays at the top.
    expect(out.indexOf("# heading")).toBe(0);
    expect(out.indexOf("some prose")).toBeLessThan(
      out.indexOf("## Character (user-defined)"),
    );
  });

  it("inserts the block into an empty string when character is non-empty", () => {
    const out = applyCharacterBlockRewrite("", "Speak casually.");
    expect(out).toContain("## Character (user-defined)");
    expect(out).toContain("Speak casually.");
  });

  it("handles content that starts directly with '## ' (no preamble)", () => {
    const content = "## Runtime profile\n\nProfile body.\n";
    const out = applyCharacterBlockRewrite(content, "Speak casually.");
    // Character block goes at the very top.
    expect(out.startsWith("## Character (user-defined)")).toBe(true);
    expect(out).toContain("## Runtime profile");
  });

  it("places the block BELOW the `<!-- safety:end -->` sentinel when present", () => {
    // Regression guard for the production bug where `applyCharacterBlockRewrite`
    // inserted before the first `## ` heading — which in production is
    // `## Safety Invariants` inside the safety preamble, putting Character
    // ABOVE safety and violating design §15.4.2 / §15.5. `SkillsCompiler`
    // now emits `<!-- safety:end -->` at the tail of the rendered safety
    // block; this test pins the contract that `insertCharacterBlock` lands
    // after that sentinel.
    const content = [
      "# Conversational Agent",
      "",
      "You respond to direct messages.",
      "",
      "## Safety Invariants",
      "- Confirm destructive operations.",
      "",
      "## Common Patterns",
      "- Read-before-write.",
      "",
      "<!-- safety:end -->",
      "",
      "## Principles",
      "- Respond in the user's language.",
    ].join("\n");
    const out = applyCharacterBlockRewrite(content, "Speak casually.");
    const safetyIdx = out.indexOf("## Safety Invariants");
    const commonIdx = out.indexOf("## Common Patterns");
    const sentinelIdx = out.indexOf("<!-- safety:end -->");
    const characterIdx = out.indexOf("## Character (user-defined)");
    const principlesIdx = out.indexOf("## Principles");
    expect(safetyIdx).toBeGreaterThanOrEqual(0);
    expect(commonIdx).toBeGreaterThan(safetyIdx);
    expect(sentinelIdx).toBeGreaterThan(commonIdx);
    expect(characterIdx).toBeGreaterThan(sentinelIdx);
    expect(principlesIdx).toBeGreaterThan(characterIdx);
  });

  it("removes the block and leaves the `<!-- safety:end -->` sentinel untouched", () => {
    // Insert → remove round-trip keeps the sentinel in place so a future
    // re-insert still lands correctly.
    const base = [
      "# profile",
      "",
      "## Safety Invariants",
      "- Do no harm.",
      "",
      "<!-- safety:end -->",
      "",
      "## Tone",
      "Friendly.",
      "",
    ].join("\n");
    const withBlock = applyCharacterBlockRewrite(base, "Speak casually.");
    expect(withBlock).toContain("## Character (user-defined)");
    const stripped = applyCharacterBlockRewrite(withBlock, "");
    expect(stripped).not.toContain("## Character (user-defined)");
    expect(stripped).toContain("<!-- safety:end -->");
    // Re-insert lands back in the same position.
    const reInserted = applyCharacterBlockRewrite(stripped, "Speak casually.");
    const sentinelIdx = reInserted.indexOf("<!-- safety:end -->");
    const characterIdx = reInserted.indexOf("## Character (user-defined)");
    expect(characterIdx).toBeGreaterThan(sentinelIdx);
  });

  it("handles content that starts directly with the Character heading", () => {
    // Edge case: whole file is the block. Replacement should still work.
    const content = [
      "## Character (user-defined)",
      "<!-- character:start -->",
      "Old value.",
      "<!-- character:end -->",
      "",
      "footer",
    ].join("\n");
    const out = applyCharacterBlockRewrite(content, "New value.");
    expect(out).toContain("New value.");
    expect(out).not.toContain("Old value.");
    // Only one heading.
    expect(out.split("## Character (user-defined)").length - 1).toBe(1);
  });

  it("removes the Character block when it extends to end-of-file (no trailing content)", () => {
    // Branch guard for `removeExistingCharacterBlock`'s `if (!after)` arm:
    // when the block reaches EOF with no `## ` heading after it, the
    // remover must return `${before}\n` (single trailing newline) rather
    // than producing a spurious `\n\n` seam.
    const content = [
      "# heading",
      "",
      "preamble",
      "",
      "## Character (user-defined)",
      "<!-- character:start -->",
      "Only value.",
      "<!-- character:end -->",
    ].join("\n");
    const stripped = applyCharacterBlockRewrite(content, "");
    expect(stripped).not.toContain("## Character (user-defined)");
    expect(stripped.endsWith("\n")).toBe(true);
    expect(stripped).not.toMatch(/\n{3,}/);
  });

  it("inserts a fresh block after a `<!-- safety:end -->` sentinel at end-of-file (no trailing content)", () => {
    // Branch guard for `insertCharacterBlock`'s `after ? ... : ...` arm:
    // when the sentinel is the last non-whitespace thing in the file,
    // insertion must terminate with a single trailing newline instead of
    // appending another `${after}` seam.
    const content = "# heading\n\npreamble\n\n<!-- safety:end -->\n";
    const out = applyCharacterBlockRewrite(content, "Speak casually.");
    expect(out).toContain("## Character (user-defined)");
    // Character block follows sentinel — nothing after.
    const sentinelIdx = out.indexOf("<!-- safety:end -->");
    const characterIdx = out.indexOf("## Character (user-defined)");
    expect(characterIdx).toBeGreaterThan(sentinelIdx);
    expect(out.endsWith("\n")).toBe(true);
  });
});
