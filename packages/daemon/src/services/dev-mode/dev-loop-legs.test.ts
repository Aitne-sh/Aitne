import { describe, it, expect } from "vitest";
import { deriveBashAllowlist } from "./dev-loop-legs.js";

describe("deriveBashAllowlist (D6 — never push)", () => {
  it("grants each verify command as its FULL prefix, never a bare root", () => {
    const tools = deriveBashAllowlist(["npm test", "npm run lint"]);
    expect(tools).toContain("Bash(npm test:*)");
    expect(tools).toContain("Bash(npm run lint:*)");
    // A bare `Bash(npm:*)` would allow `npm run <push-script>`.
    expect(tools).not.toContain("Bash(npm:*)");
  });

  it("never emits Bash(git:*) even when a verify command starts with git", () => {
    const tools = deriveBashAllowlist(["git diff --exit-code", "git status --porcelain"]);
    // The full commands are granted (their prefix), but NOT a bare git root.
    expect(tools).toContain("Bash(git diff --exit-code:*)");
    expect(tools).not.toContain("Bash(git:*)");
    // The only bare-git grants are the explicit read-only ones.
    for (const t of tools) {
      if (t.startsWith("Bash(git")) {
        expect(
          t === "Bash(git diff --exit-code:*)"
            || t === "Bash(git status --porcelain:*)"
            || t === "Bash(git status:*)"
            || t === "Bash(git diff:*)"
            || t === "Bash(git log:*)",
        ).toBe(true);
      }
    }
    // No grant permits `git push`.
    expect(tools.some((t) => /Bash\(git:\*\)/.test(t))).toBe(false);
  });

  it("never emits Bash(bash:*) / Bash(sh:*) shell-interpreter escapes", () => {
    const tools = deriveBashAllowlist(["bash scripts/check.sh"]);
    expect(tools).toContain("Bash(bash scripts/check.sh:*)");
    expect(tools).not.toContain("Bash(bash:*)");
  });

  it("always includes the read-only orientation commands", () => {
    const tools = deriveBashAllowlist(["true"]);
    expect(tools).toEqual(
      expect.arrayContaining([
        "Bash(true:*)",
        "Bash(git status:*)",
        "Bash(git diff:*)",
        "Bash(git log:*)",
        "Bash(ls:*)",
        "Bash(cat:*)",
      ]),
    );
  });
});
