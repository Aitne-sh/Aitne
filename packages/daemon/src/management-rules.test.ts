import { describe, expect, it } from "vitest";
import { upsertManagementRulesAgentIdentity } from "./management-rules.js";

const FRONTMATTER = `---
type: rule
owner: shared
updated: 2026-05-04
---`;

describe("upsertManagementRulesAgentIdentity", () => {
  it("preserves the blank line before the next H2 when replacing in-place", () => {
    const input = `${FRONTMATTER}
# Management Rules

## Agent Identity
- AI name: placeholder
- WhatsApp label: [placeholder]

## Source of Truth
| Domain | Primary | Secondary |
|--------|---------|-----------|
| Schedule | Google Calendar | today.md |
`;

    const out = upsertManagementRulesAgentIdentity(input, "ai-bot");

    // Regression: the buggy regex consumed the `\n\n` separator and the
    // next H2 fused onto the WhatsApp bullet, which made GFM swallow the
    // following table as lazy-continuation of the list item.
    expect(out).not.toContain("[ai-bot]## Source");
    expect(out).toContain("- WhatsApp label: [ai-bot]\n\n## Source of Truth");
  });

  it("replaces in-place when Agent Identity is the last section in the file", () => {
    const input = `# Management Rules

## Agent Identity
- AI name: old
- WhatsApp label: [old]
`;

    const out = upsertManagementRulesAgentIdentity(input, "newname");

    // Regression: `\Z` in the original lookahead matched a literal `Z`,
    // never end-of-string. So at-EOF replacement silently fell through to
    // the title-insertion branch and produced a duplicate section.
    const headingCount = (out.match(/^## Agent Identity/gm) ?? []).length;
    expect(headingCount).toBe(1);
    expect(out).toContain("- AI name: newname");
    expect(out).not.toContain("- AI name: old");
  });

  it("returns the section alone when content is empty / whitespace", () => {
    expect(upsertManagementRulesAgentIdentity("", "bot")).toBe(
      "## Agent Identity\n- AI name: bot\n- WhatsApp label: [bot]",
    );
    expect(upsertManagementRulesAgentIdentity("   \n  \n", "bot")).toBe(
      "## Agent Identity\n- AI name: bot\n- WhatsApp label: [bot]",
    );
  });

  it("inserts under the H1 when no Agent Identity section exists yet", () => {
    const input = `# Management Rules

## Source of Truth
| Domain | Primary |
|--------|---------|
`;
    const out = upsertManagementRulesAgentIdentity(input, "bot");
    expect(out).toMatch(
      /^# Management Rules\n\n## Agent Identity\n- AI name: bot\n- WhatsApp label: \[bot\]\n\n## Source of Truth/,
    );
  });

  it("prepends the section when the file has no H1 either", () => {
    const out = upsertManagementRulesAgentIdentity("free-form notes\n", "bot");
    expect(out).toBe(
      "## Agent Identity\n- AI name: bot\n- WhatsApp label: [bot]\n\nfree-form notes",
    );
  });

  it("normalizes CRLF line endings before matching", () => {
    const input =
      "# Management Rules\r\n\r\n## Agent Identity\r\n- AI name: old\r\n- WhatsApp label: [old]\r\n\r\n## Source of Truth\r\n";
    const out = upsertManagementRulesAgentIdentity(input, "new");
    expect(out).toContain("- AI name: new");
    expect(out).toContain("- WhatsApp label: [new]\n\n## Source of Truth");
    expect(out).not.toContain("\r");
  });

  it("is idempotent — re-running with the same name yields identical content", () => {
    const input = `${FRONTMATTER}
# Management Rules

## Agent Identity
- AI name: bot
- WhatsApp label: [bot]

## Source of Truth
| Domain | Primary |
|--------|---------|
`;
    const once = upsertManagementRulesAgentIdentity(input, "bot");
    const twice = upsertManagementRulesAgentIdentity(once, "bot");
    expect(twice).toBe(once);
  });
});
