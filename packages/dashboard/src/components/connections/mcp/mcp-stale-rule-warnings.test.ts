import { describe, it, expect } from "vitest";
import { scanMcpRulesForStaleReferences } from "./mcp-stale-rule-warnings";

describe("scanMcpRulesForStaleReferences", () => {
  it("ignores references to enabled servers", () => {
    const body = "Prefer `monday` for task tracking.";
    const warnings = scanMcpRulesForStaleReferences(body, [
      { id: "monday", enabled: true },
    ]);
    expect(warnings).toEqual([]);
  });

  it("flags backtick-quoted references to disabled servers", () => {
    const body = "Use `monday` unless the user opts out.";
    const warnings = scanMcpRulesForStaleReferences(body, [
      { id: "monday", enabled: false },
    ]);
    expect(warnings).toEqual([
      { id: "monday", severity: "disabled", occurrences: 1 },
    ]);
  });

  it("flags backtick-quoted references to unknown servers", () => {
    const body = "Avoid `legacy-mcp` — it's been removed.";
    const warnings = scanMcpRulesForStaleReferences(body, [
      { id: "monday", enabled: true },
    ]);
    expect(warnings).toEqual([
      { id: "legacy-mcp", severity: "unknown", occurrences: 1 },
    ]);
  });

  it("flags bare hyphenated references even without backticks", () => {
    const body = "home-assistant controls lighting. Use home-assistant first.";
    const warnings = scanMcpRulesForStaleReferences(body, [
      { id: "home-assistant", enabled: false },
    ]);
    expect(warnings).toEqual([
      { id: "home-assistant", severity: "disabled", occurrences: 2 },
    ]);
  });

  it("does not flag dictionary-word single tokens without backticks", () => {
    const body = "Monday is a good day. Notion is nice.";
    const warnings = scanMcpRulesForStaleReferences(body, [
      { id: "monday", enabled: false },
      { id: "notion", enabled: false },
    ]);
    // Tokens are not backtick-quoted and not hyphenated — case-sensitive match
    // against the lowercase id would miss anyway, and we deliberately skip
    // bare single-word references to avoid prose collisions.
    expect(warnings).toEqual([]);
  });

  it("counts multiple occurrences of the same stale id", () => {
    const body = "`monday` here. Then `monday` again. And `monday`.";
    const warnings = scanMcpRulesForStaleReferences(body, [
      { id: "monday", enabled: false },
    ]);
    expect(warnings).toEqual([
      { id: "monday", severity: "disabled", occurrences: 3 },
    ]);
  });

  it("merges backtick + bare counts for hyphenated ids", () => {
    const body = "`home-assistant` is the right call. Use home-assistant.";
    const warnings = scanMcpRulesForStaleReferences(body, [
      { id: "home-assistant", enabled: false },
    ]);
    // Pass 1 catches the backticked occurrence; Pass 2 strips the code span
    // before re-scanning so the bare occurrence in the second sentence counts.
    expect(warnings).toEqual([
      { id: "home-assistant", severity: "disabled", occurrences: 2 },
    ]);
  });

  it("returns entries sorted alphabetically for stable UI rendering", () => {
    const body = "Use `zeta-mcp`, fall back to `alpha-mcp`.";
    const warnings = scanMcpRulesForStaleReferences(body, []);
    expect(warnings.map((w) => w.id)).toEqual(["alpha-mcp", "zeta-mcp"]);
  });

  it("handles empty rules body", () => {
    expect(
      scanMcpRulesForStaleReferences("", [{ id: "monday", enabled: true }]),
    ).toEqual([]);
  });

  it("handles empty server list (all references flagged as unknown)", () => {
    const body = "Prefer `monday` and `home-assistant`.";
    const warnings = scanMcpRulesForStaleReferences(body, []);
    expect(warnings).toEqual([
      { id: "home-assistant", severity: "unknown", occurrences: 1 },
      { id: "monday", severity: "unknown", occurrences: 1 },
    ]);
  });

  it("ignores multi-token code spans that are not id-shaped", () => {
    // Code span contains prose, not a single id. We only flag whole-span
    // matches so "use monday" doesn't register "monday" on its own (that
    // case would only fire if the user backticked it separately).
    const body = "Example: `use monday` is not a rule.";
    const warnings = scanMcpRulesForStaleReferences(body, [
      { id: "monday", enabled: false },
    ]);
    expect(warnings).toEqual([]);
  });
});
