import { describe, expect, it } from "vitest";
import { lintAgentDefinition } from "./agent-lint.js";

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

function codes(prompt: string, extra: { playbooks?: string[]; tags?: string[] } = {}) {
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

  it("returns no issues for a well-formed, fully-declared research agent", () => {
    expect(lintAgentDefinition({ prompt: FRAMED_RESEARCH_PROMPT, playbooks: ["research"] })).toEqual(
      [],
    );
  });
});
