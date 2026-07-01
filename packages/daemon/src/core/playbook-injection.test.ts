import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  appendPlaybookBlocks,
  loadPlaybookBlocks,
  playbookReferencePath,
  renderPlaybookBlocks,
} from "./playbook-injection.js";
import {
  createPromptInjectionBudget,
  PLAYBOOK_TOTAL_MAX_BYTES,
} from "./policy-files.js";
import { PLAYBOOK_SLUGS } from "@aitne/shared";

const __dirname = dirname(fileURLToPath(import.meta.url));
// packages/daemon/src/core → repo root
const REPO_ROOT = resolve(__dirname, "../../../../");

/** A minimal reference file with frontmatter to prove it's stripped. */
function ref(body: string): string {
  return `---\nkind: reference\nname: research\n---\n\n${body}\n`;
}

describe("playbookReferencePath", () => {
  it("resolves a slug to its bundled content file under agent-assets/playbooks", () => {
    const p = playbookReferencePath("/ws", "monitoring");
    expect(p).toBe("/ws/agent-assets/playbooks/monitoring.md");
  });
});

describe("loadPlaybookBlocks", () => {
  it("loads declared playbooks and strips frontmatter (like the skill inliner)", () => {
    const blocks = loadPlaybookBlocks({
      workspaceDir: "/ws",
      playbooks: ["research"],
      readFile: () => ref("### Method\nDo research."),
    });
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ slug: "research", label: "Research" });
    // Frontmatter gone; body preserved and trimmed.
    expect(blocks[0].content).toBe("### Method\nDo research.");
    expect(blocks[0].content).not.toContain("kind: reference");
  });

  it("skips an unknown slug", () => {
    const blocks = loadPlaybookBlocks({
      workspaceDir: "/ws",
      playbooks: ["research", "not-a-playbook"],
      readFile: () => ref("### Method\nx"),
    });
    expect(blocks.map((b) => b.slug)).toEqual(["research"]);
  });

  it("de-duplicates a slug declared twice (first wins, read once)", () => {
    let reads = 0;
    const blocks = loadPlaybookBlocks({
      workspaceDir: "/ws",
      playbooks: ["research", "research"],
      readFile: () => {
        reads++;
        return ref("### Method\nx");
      },
    });
    expect(blocks).toHaveLength(1);
    expect(reads).toBe(1);
  });

  it("skips a playbook whose reference file is missing/unreadable", () => {
    const blocks = loadPlaybookBlocks({
      workspaceDir: "/ws",
      playbooks: ["research"],
      readFile: () => {
        throw new Error("ENOENT");
      },
    });
    expect(blocks).toEqual([]);
  });

  it("skips a playbook whose body is empty after stripping frontmatter", () => {
    const blocks = loadPlaybookBlocks({
      workspaceDir: "/ws",
      playbooks: ["research"],
      readFile: () => "---\nkind: reference\n---\n",
    });
    expect(blocks).toEqual([]);
  });

  it("skips a playbook that exceeds the per-file cap", () => {
    const huge = "x".repeat(33 * 1024); // > POLICY_FILE_MAX_BYTES (32 KB)
    const blocks = loadPlaybookBlocks({
      workspaceDir: "/ws",
      playbooks: ["research"],
      readFile: () => huge,
    });
    expect(blocks).toEqual([]);
  });

  it("stops at the aggregate budget cap and skips the remainder", () => {
    const budget = createPromptInjectionBudget(10); // 10 bytes total
    const blocks = loadPlaybookBlocks({
      workspaceDir: "/ws",
      playbooks: ["research", "monitoring"],
      budget,
      readFile: () => "0123456789ABCDEF", // 16 bytes > 10 → first breaks
    });
    expect(blocks).toEqual([]);
  });

  it("shares a caller-provided budget across playbooks", () => {
    const budget = createPromptInjectionBudget();
    loadPlaybookBlocks({
      workspaceDir: "/ws",
      playbooks: ["research"],
      budget,
      readFile: () => "abcde", // 5 bytes
    });
    expect(budget.usedBytes).toBe(5);
  });

  it("creates a private budget when none is provided", () => {
    // No throw / no budget arg exercises the `opts.budget ?? create...` branch.
    const blocks = loadPlaybookBlocks({
      workspaceDir: "/ws",
      playbooks: ["research"],
      readFile: () => "abcde",
    });
    expect(blocks).toHaveLength(1);
  });

  it("reads real bundled reference files from disk (no reader override)", () => {
    // Sanity: the shipped agent-assets bundle resolves + parses.
    const p = playbookReferencePath(REPO_ROOT, "research");
    expect(existsSync(p)).toBe(true);
    const blocks = loadPlaybookBlocks({
      workspaceDir: REPO_ROOT,
      playbooks: ["research", "markdown-note", "monitoring"],
    });
    expect(blocks.map((b) => b.slug)).toEqual(["research", "markdown-note", "monitoring"]);
    for (const b of blocks) {
      expect(b.content.length).toBeGreaterThan(0);
      expect(b.content.startsWith("---")).toBe(false); // frontmatter stripped
    }
  });

  it("returns null (skips) when a file is missing and no reader is given", () => {
    const blocks = loadPlaybookBlocks({
      workspaceDir: "/nonexistent-workspace-xyz",
      playbooks: ["research"],
    });
    expect(blocks).toEqual([]);
  });
});

describe("renderPlaybookBlocks", () => {
  it("returns empty string for no blocks", () => {
    expect(renderPlaybookBlocks([])).toBe("");
  });

  it("renders a heading per block with the slug marker", () => {
    const rendered = renderPlaybookBlocks([
      { slug: "research", label: "Research", content: "### Method\nx" },
    ]);
    expect(rendered).toContain("## Operating playbooks");
    expect(rendered).toContain("### Research playbook (`playbooks:research`)");
    expect(rendered).toContain("### Method\nx");
  });
});

describe("appendPlaybookBlocks", () => {
  it("appends rendered blocks to the base prompt", () => {
    const out = appendPlaybookBlocks("BASE", {
      workspaceDir: "/ws",
      playbooks: ["research"],
      readFile: () => ref("### Method\nx"),
    });
    expect(out.startsWith("BASE")).toBe(true);
    expect(out).toContain("## Operating playbooks");
  });

  it("is a no-op when nothing resolves (returns the base prompt unchanged)", () => {
    const out = appendPlaybookBlocks("BASE", {
      workspaceDir: "/ws",
      playbooks: [],
    });
    expect(out).toBe("BASE");
  });

  // audit B6 — the dispatcher gives playbooks their OWN PLAYBOOK_TOTAL_MAX_BYTES
  // budget so a heavy policy/review bundle can never starve a declared playbook
  // (the "hard, platform-enforced guarantee"). That guarantee is only real if
  // the WHOLE curated set fits the dedicated budget — this locks the sizing so a
  // future playbook that pushes the total over the cap fails here, not silently
  // at fire time. Reads the REAL bundled reference files (REPO_ROOT).
  it("admits every curated playbook within the dedicated 16 KiB budget", () => {
    const budget = createPromptInjectionBudget(PLAYBOOK_TOTAL_MAX_BYTES);
    const out = appendPlaybookBlocks("BASE", {
      workspaceDir: REPO_ROOT,
      playbooks: [...PLAYBOOK_SLUGS],
      budget,
    });
    for (const slug of PLAYBOOK_SLUGS) {
      expect(out).toContain(`playbooks:${slug}`);
    }
    expect(budget.usedBytes).toBeLessThan(PLAYBOOK_TOTAL_MAX_BYTES);
  });
});
