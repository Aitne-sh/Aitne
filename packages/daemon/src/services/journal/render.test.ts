import { describe, expect, it } from "vitest";
import { renderJournalMirrorContent } from "./render.js";

describe("renderJournalMirrorContent", () => {
  it("passes through plain content unchanged", () => {
    const content = "# 2026-04-16\n\n## Summary\nPlain text\n";
    expect(
      renderJournalMirrorContent(content, { rendering: "plain" }),
    ).toBe(content);
  });

  it("passes through obsidian content unchanged", () => {
    const content = "# 2026-04-16\n\n## Summary\n[[project-alpha]] moved.\n";
    expect(
      renderJournalMirrorContent(content, { rendering: "obsidian" }),
    ).toBe(content);
  });
});
