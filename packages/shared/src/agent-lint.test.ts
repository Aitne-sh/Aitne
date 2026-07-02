import { describe, expect, it } from "vitest";
import { isPlaceholderPrompt, lintAgentDefinition } from "./agent-lint.js";

const FRAMED_RESEARCH_PROMPT = `# Role
You are the AI-news researcher. Every morning you produce a verified digest.

# Important
- Follow the **research** playbook for method and source verification.
- Do NOT include single-source claims unmarked.

# Instruction
1. Pick 3-5 angles not already covered.
2. Cross-check every claim against >= 2 sources.

# Output
- Write a note and DM the "what matters" summary.`;

function codes(
  prompt: string,
  extra: { playbooks?: string[]; tags?: string[]; successCriteriaCount?: number } = {},
) {
  return lintAgentDefinition({ prompt, ...extra }).map((i) => i.code);
}

describe("lintAgentDefinition", () => {
  describe("empty_prompt", () => {
    it("flags an empty prompt and returns nothing else", () => {
      const issues = lintAgentDefinition({ prompt: "   \n  " });
      expect(issues).toHaveLength(1);
      expect(issues[0].code).toBe("empty_prompt");
      expect(issues[0].severity).toBe("warning");
    });

    it("treats an undefined prompt as empty", () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const issues = lintAgentDefinition({ prompt: undefined as any });
      expect(issues.map((i) => i.code)).toEqual(["empty_prompt"]);
    });
  });

  describe("placeholder_prompt", () => {
    it.each([
      "placeholder",
      "TODO",
      "tbd",
      "# TODO",
      "**placeholder**",
      "[placeholder]",
      "Your prompt here",
      "fill in later",
      "to be determined",
      "coming soon",
      "xxx",
    ])("flags the whole-body stub %j and returns nothing else", (prompt) => {
      const issues = lintAgentDefinition({ prompt });
      expect(issues).toHaveLength(1);
      expect(issues[0].code).toBe("placeholder_prompt");
      expect(issues[0].severity).toBe("warning");
    });

    it("flags a pure-punctuation body", () => {
      expect(codes("...")).toEqual(["placeholder_prompt"]);
      expect(codes("---")).toEqual(["placeholder_prompt"]);
    });

    it("short-circuits like empty_prompt (no criteria nag on top)", () => {
      expect(codes("placeholder", { successCriteriaCount: 0 })).toEqual(["placeholder_prompt"]);
    });

    it("quotes at most 40 characters of a long stub body in the message", () => {
      const issues = lintAgentDefinition({ prompt: "x".repeat(60) });
      expect(issues[0].code).toBe("placeholder_prompt");
      expect(issues[0].message).toContain(`("${"x".repeat(40)}…")`);
    });

    it("does not flag a terse but real task", () => {
      expect(codes("Check Hacker News for AI items and DM me the top 3.")).toEqual([]);
    });

    it("does not flag a real prompt that merely contains a stub word", () => {
      const prompt = `${FRAMED_RESEARCH_PROMPT}\n- TODO markers in the note are fine; {date} is the only placeholder.`;
      expect(codes(prompt, { playbooks: ["research"] })).toEqual([]);
    });
  });

  describe("isPlaceholderPrompt", () => {
    it("treats missing and whitespace-only prompts as placeholders", () => {
      expect(isPlaceholderPrompt(null)).toBe(true);
      expect(isPlaceholderPrompt(undefined)).toBe(true);
      expect(isPlaceholderPrompt("   \n ")).toBe(true);
    });

    it("detects whole-body stub tokens regardless of dressing", () => {
      expect(isPlaceholderPrompt("placeholder")).toBe(true);
      expect(isPlaceholderPrompt("`TBD`")).toBe(true);
      expect(isPlaceholderPrompt("insert prompt here")).toBe(true);
    });

    it("passes a real prompt", () => {
      expect(isPlaceholderPrompt("Summarise AI news from HN + arXiv and DM me.")).toBe(false);
      expect(isPlaceholderPrompt(FRAMED_RESEARCH_PROMPT)).toBe(false);
    });
  });

  describe("empty_instruction", () => {
    it("flags a framed prompt whose # Instruction section is empty", () => {
      const prompt = `# Role
You are an agent.

# Instruction

# Output
- something`;
      expect(codes(prompt)).toContain("empty_instruction");
    });

    it("flags a framed prompt with no # Instruction heading at all", () => {
      const prompt = `# Role
You do a thing.

# Output
- a file`;
      expect(codes(prompt)).toContain("empty_instruction");
    });

    it("does NOT flag a framed prompt with a populated # Instruction", () => {
      expect(codes(FRAMED_RESEARCH_PROMPT, { playbooks: ["research"] })).not.toContain(
        "empty_instruction",
      );
    });

    it("does NOT flag an unframed free-prose prompt", () => {
      // No frame headings → we don't expect a # Instruction section.
      expect(codes("Just clean up my bookmarks folder every Sunday.")).toEqual([]);
    });

    it("stops scanning the Instruction body at the next heading", () => {
      // The only non-blank line after # Instruction is the next heading, so the
      // section is empty.
      const prompt = `# Role
Do it.

# Instruction
## sub
`;
      // "## sub" is a heading, so the Instruction section itself is empty.
      expect(codes(prompt)).toContain("empty_instruction");
    });

    it("does NOT flag a core frame whose action section is the plural # Instructions", () => {
      // `# Instructions` is a natural authoring variation of the singular frame
      // heading; a populated one must not be reported as missing.
      const prompt = `# Role
You are an agent.

# Important
- Read the inputs first.

# Instructions
1. Do the first thing.
2. Do the second thing.

# Output
- a file`;
      expect(codes(prompt)).not.toContain("empty_instruction");
    });

    it("still flags an EMPTY plural # Instructions section", () => {
      const prompt = `# Role
You are an agent.

# Instructions

# Output
- something`;
      expect(codes(prompt)).toContain("empty_instruction");
    });

    it("does NOT flag an extended/operational frame (no # Instruction by design)", () => {
      // The operational frame replaces # Instruction with # Requirements /
      // # Verification — flagging it would be a false positive.
      const prompt = `# Goal
Keep the repo green.

# Role
Act as a careful engineer.

# Scope
Do: fix lint errors.

# Requirements
- pnpm lint passes.

# Verification
- Run pnpm lint; include output.

# Output
1. Summary of what was fixed.`;
      expect(codes(prompt)).not.toContain("empty_instruction");
    });

    it("does NOT flag an old-skeleton prompt that isn't the core frame", () => {
      // ## Goal / ## Steps is not the core frame (no # Role / # Important), so
      // we don't demand a # Instruction section.
      const prompt = `## Goal
Triage inbox.

## Steps
1. Read.
2. Act.`;
      expect(codes(prompt)).not.toContain("empty_instruction");
    });
  });

  describe("playbook_referenced_not_declared", () => {
    it("flags a research playbook named in the prompt but not declared", () => {
      const issues = lintAgentDefinition({ prompt: FRAMED_RESEARCH_PROMPT });
      const ref = issues.find((i) => i.code === "playbook_referenced_not_declared");
      expect(ref).toBeDefined();
      expect(ref?.playbook).toBe("research");
      expect(ref?.message).toContain("research");
    });

    it("does NOT flag when the referenced playbook is declared", () => {
      expect(
        codes(FRAMED_RESEARCH_PROMPT, { playbooks: ["research"] }),
      ).not.toContain("playbook_referenced_not_declared");
    });

    it("matches the plain-text label form too (markdown-note)", () => {
      const prompt = `# Role
Note writer.

# Instruction
1. Write it.

# Output
- Follow the markdown-note playbook for structure.`;
      const issues = lintAgentDefinition({ prompt });
      expect(
        issues.some(
          (i) => i.code === "playbook_referenced_not_declared" && i.playbook === "markdown-note",
        ),
      ).toBe(true);
    });

    it("flags via a matching tag even when the prompt never names the playbook", () => {
      const prompt = `# Role
Watcher.

# Instruction
1. Check the source.

# Output
- Record the delta.`;
      const issues = lintAgentDefinition({ prompt, tags: ["monitoring", "daily"] });
      expect(
        issues.some(
          (i) => i.code === "playbook_referenced_not_declared" && i.playbook === "monitoring",
        ),
      ).toBe(true);
    });

    it("does not flag a playbook that is neither referenced nor tagged", () => {
      const prompt = `# Role
Note writer.

# Instruction
1. Write it.

# Output
- Follow the markdown-note playbook.`;
      const issues = lintAgentDefinition({ prompt, playbooks: ["markdown-note"] });
      // research/monitoring are never mentioned → no spurious warnings.
      expect(issues).toEqual([]);
    });
  });

  describe("no_success_criteria", () => {
    it("fires for an # Output contract with an explicit zero criteria count", () => {
      const issues = lintAgentDefinition({
        prompt: FRAMED_RESEARCH_PROMPT,
        playbooks: ["research"],
        successCriteriaCount: 0,
      });
      expect(issues).toHaveLength(1);
      expect(issues[0].code).toBe("no_success_criteria");
      expect(issues[0].severity).toBe("warning");
    });

    it("is silent when at least one criterion is declared", () => {
      expect(
        codes(FRAMED_RESEARCH_PROMPT, { playbooks: ["research"], successCriteriaCount: 1 }),
      ).not.toContain("no_success_criteria");
    });

    it("is silent for a free-prose prompt without an # Output contract", () => {
      // No output contract → nothing deterministic for criteria to verify.
      expect(
        codes("Just clean up my bookmarks folder every Sunday.", { successCriteriaCount: 0 }),
      ).toEqual([]);
    });

    it("is silent when the caller does not know the criteria count", () => {
      // successCriteriaCount undefined = prompt-only caller; never flagged.
      expect(codes(FRAMED_RESEARCH_PROMPT, { playbooks: ["research"] })).toEqual([]);
    });

    it("accepts the plural # Outputs heading as the output contract", () => {
      const prompt = `# Role
Note writer.

# Instruction
1. Write it.

# Outputs
- a dated note`;
      expect(codes(prompt, { successCriteriaCount: 0 })).toContain("no_success_criteria");
    });

    it("stays out of the empty-prompt early return", () => {
      // Empty prompt short-circuits after empty_prompt — no criteria nag on top.
      expect(codes("   ", { successCriteriaCount: 0 })).toEqual(["empty_prompt"]);
    });
  });

  it("returns no issues for a well-formed, fully-declared research agent", () => {
    expect(lintAgentDefinition({ prompt: FRAMED_RESEARCH_PROMPT, playbooks: ["research"] })).toEqual(
      [],
    );
  });
});
