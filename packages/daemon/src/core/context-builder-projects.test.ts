import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONTEXT_RELATIVE_PATHS } from "./context-paths.js";
import { renderActiveProjectsSection } from "./context-builder-projects.js";

/**
 * Per-sibling test peer for `context-builder-projects.ts`. The block is
 * a deterministic transform from `${contextDir}/${projects.dir}/*.md`
 * to a sorted bullet list, so the entire surface is filesystem
 * fixtures + pure assertions.
 */
describe("context-builder-projects", () => {
  let tmpDir: string;
  let projectsDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `pa-projects-test-${Date.now()}-${Math.random()}`);
    projectsDir = join(tmpDir, CONTEXT_RELATIVE_PATHS.projects.dir);
    mkdirSync(projectsDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeProject(filename: string, content: string): void {
    writeFileSync(join(projectsDir, filename), content);
  }

  it("returns null when contextDir is null (degraded mode)", async () => {
    expect(await renderActiveProjectsSection(null)).toBeNull();
  });

  it("returns null when the projects directory does not exist", async () => {
    rmSync(projectsDir, { recursive: true, force: true });
    expect(await renderActiveProjectsSection(tmpDir)).toBeNull();
  });

  it("returns null when the projects directory contains no eligible .md files", async () => {
    // Underscore-prefixed files (_index.md, _active.base) are
    // intentionally skipped — they are registry/index helpers, not
    // project notes.
    writeProject("_index.md", "---\ntype: index\n---\n# Index");
    writeProject("_active.base", "metadata only");
    writeProject("notes.txt", "not markdown");
    expect(await renderActiveProjectsSection(tmpDir)).toBeNull();
  });

  it("renders one bullet per active project with state/next/due fields", async () => {
    writeProject(
      "project-a.md",
      [
        "---",
        "type: project",
        "state: active",
        "next_milestone: Ship alpha",
        "due: 2026-04-30",
        "updated: 2026-04-17",
        "---",
        "# Project A",
        "",
        "Body",
      ].join("\n"),
    );

    const out = await renderActiveProjectsSection(tmpDir);

    expect(out).toContain("# Active projects");
    expect(out).toContain(
      "- Project A (`project-a`) — state: active; next: Ship alpha; due: 2026-04-30",
    );
  });

  it("filters out archived projects", async () => {
    writeProject(
      "project-a.md",
      [
        "---",
        "state: active",
        "updated: 2026-04-17",
        "---",
        "# Project A",
      ].join("\n"),
    );
    writeProject(
      "project-b.md",
      [
        "---",
        "state: archived",
        "updated: 2026-04-18",
        "---",
        "# Project B",
      ].join("\n"),
    );

    const out = await renderActiveProjectsSection(tmpDir);

    expect(out).toContain("Project A");
    expect(out).not.toContain("Project B");
  });

  it("sorts by `updated` descending, then by title ascending as a tiebreaker", async () => {
    writeProject(
      "alpha.md",
      ["---", "state: active", "updated: 2026-04-10", "---", "# Alpha"].join(
        "\n",
      ),
    );
    writeProject(
      "beta.md",
      ["---", "state: active", "updated: 2026-04-20", "---", "# Beta"].join(
        "\n",
      ),
    );
    writeProject(
      "charlie.md",
      ["---", "state: active", "updated: 2026-04-20", "---", "# Charlie"].join(
        "\n",
      ),
    );

    const out = await renderActiveProjectsSection(tmpDir);

    const betaIdx = out!.indexOf("Beta");
    const charlieIdx = out!.indexOf("Charlie");
    const alphaIdx = out!.indexOf("Alpha");
    // Beta + Charlie share updated=2026-04-20 → newer than Alpha (2026-04-10),
    // so they precede Alpha. Within the tie, ascending title puts
    // Beta before Charlie.
    expect(betaIdx).toBeLessThan(charlieIdx);
    expect(charlieIdx).toBeLessThan(alphaIdx);
  });

  it("falls back to the slug for the title when the body has no H1", async () => {
    writeProject(
      "my-slug.md",
      ["---", "state: active", "---", "no heading here"].join("\n"),
    );

    const out = await renderActiveProjectsSection(tmpDir);

    expect(out).toContain("- my-slug (`my-slug`) — state: active");
  });

  it("defaults missing `state` frontmatter to 'active'", async () => {
    writeProject(
      "no-state.md",
      ["---", "type: project", "---", "# Untagged"].join("\n"),
    );

    const out = await renderActiveProjectsSection(tmpDir);

    expect(out).toContain("- Untagged (`no-state`) — state: active");
  });

  it("strips surrounding single or double quotes from frontmatter scalars", async () => {
    // splitFrontmatter + readFrontmatterScalar mirror the quote-stripping
    // behaviour of YAML-lite — pin it so a future regex tweak does not
    // start leaking quoted strings into the rendered block.
    writeProject(
      "quoted.md",
      [
        "---",
        'state: "active"',
        "next_milestone: 'Ship alpha v2'",
        "updated: '2026-04-17'",
        "---",
        "# Quoted",
      ].join("\n"),
    );

    const out = await renderActiveProjectsSection(tmpDir);

    expect(out).toContain("state: active");
    expect(out).toContain("next: Ship alpha v2");
    expect(out).not.toContain('"active"');
    expect(out).not.toContain("'Ship alpha v2'");
  });

  it("treats content without frontmatter as having only the default state ('active')", async () => {
    writeProject("loose.md", "# Loose Project\n\nNo frontmatter, body only.");

    const out = await renderActiveProjectsSection(tmpDir);

    expect(out).toContain("- Loose Project (`loose`) — state: active");
  });

  it("omits the `next:` and `due:` parts when those frontmatter keys are absent", async () => {
    writeProject(
      "bare.md",
      ["---", "state: active", "---", "# Bare"].join("\n"),
    );

    const out = await renderActiveProjectsSection(tmpDir);

    expect(out).toContain("- Bare (`bare`) — state: active");
    expect(out).not.toContain("next:");
    expect(out).not.toContain("due:");
  });

  it("returns null when every file in projects/ is archived", async () => {
    writeProject(
      "p1.md",
      ["---", "state: archived", "---", "# P1"].join("\n"),
    );
    writeProject(
      "p2.md",
      ["---", "state: archived", "---", "# P2"].join("\n"),
    );

    const out = await renderActiveProjectsSection(tmpDir);
    expect(out).toBeNull();
  });
});
