import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyImportMigration, planImportMigration } from "./import-migrate.js";

function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

function writeMd(rootPath: string, rel: string, body: string): void {
  ensureDir(join(rootPath, rel.split("/").slice(0, -1).join("/")));
  writeFileSync(join(rootPath, rel), body);
}

describe("planImportMigration", () => {
  let rootPath: string;

  beforeEach(() => {
    rootPath = mkdtempSync(join(tmpdir(), "pa-wiki-mig-plan-"));
  });

  afterEach(() => {
    rmSync(rootPath, { recursive: true, force: true });
  });

  it("returns empty plan for a vault with no nested subdirs and matching frontmatter", () => {
    ensureDir(join(rootPath, "20_wiki"));
    writeMd(
      rootPath,
      "20_wiki/sample.md",
      "---\ntitle: Sample\ntype: concept\nstatus: draft\n---\n# Sample\n",
    );
    const plan = planImportMigration(rootPath);
    expect(plan.flattenMoves).toEqual([]);
    expect(plan.frontmatterMigrations).toEqual([]);
    expect(plan.conflicts).toEqual([]);
  });

  it("plans flatten moves for type-based subdirectories under 20_wiki and 10_raw", () => {
    writeMd(rootPath, "20_wiki/concepts/idea.md", "---\ntype: concept\n---\n");
    writeMd(rootPath, "10_raw/articles/foo.md", "---\ntype: article\n---\n");
    const plan = planImportMigration(rootPath);
    expect(plan.flattenMoves).toEqual([
      { fromRelPath: "20_wiki/concepts/idea.md", toRelPath: "20_wiki/idea.md" },
      { fromRelPath: "10_raw/articles/foo.md", toRelPath: "10_raw/foo.md" },
    ]);
  });

  it("ignores the 10_raw/images subdirectory when planning flatten moves", () => {
    ensureDir(join(rootPath, "10_raw/images/foo"));
    writeFileSync(join(rootPath, "10_raw/images/foo/x.md"), "stub");
    writeMd(rootPath, "10_raw/articles/foo.md", "stub");
    const plan = planImportMigration(rootPath);
    expect(plan.flattenMoves.map((m) => m.fromRelPath)).toEqual([
      "10_raw/articles/foo.md",
    ]);
  });

  it("detects slug collisions when two subdirs yield the same flattened name", () => {
    writeMd(rootPath, "20_wiki/concepts/idea.md", "stub");
    writeMd(rootPath, "20_wiki/people/idea.md", "stub");
    const plan = planImportMigration(rootPath);
    expect(plan.conflicts).toHaveLength(1);
    expect(plan.conflicts[0].slug).toBe("idea.md");
  });

  it("records frontmatter renames for both raw and wiki layers", () => {
    writeMd(
      rootPath,
      "10_raw/a.md",
      "---\ntitle: x\nsource_url: https://example.com\nretrieved_at: 2026-05-12\n---\n",
    );
    writeMd(
      rootPath,
      "20_wiki/concept.md",
      "---\ntopic: My Concept\nkind: concept\nstate: draft\nlast_compiled: 2026-05-12\n---\n",
    );
    const plan = planImportMigration(rootPath);
    expect(plan.frontmatterMigrations).toHaveLength(2);
    const raw = plan.frontmatterMigrations.find((m) => m.path === "10_raw/a.md");
    const wiki = plan.frontmatterMigrations.find((m) => m.path === "20_wiki/concept.md");
    expect(raw?.renames.map((r) => `${r.from}→${r.to}`).sort()).toEqual([
      "retrieved_at→captured_at",
      "source_url→url",
    ]);
    expect(wiki?.renames.map((r) => `${r.from}→${r.to}`).sort()).toEqual([
      "kind→type",
      "last_compiled→compiled_at",
      "state→status",
      "topic→title",
    ]);
  });
});

describe("applyImportMigration", () => {
  let rootPath: string;

  beforeEach(() => {
    rootPath = mkdtempSync(join(tmpdir(), "pa-wiki-mig-apply-"));
  });

  afterEach(() => {
    rmSync(rootPath, { recursive: true, force: true });
  });

  it("renames frontmatter keys and writes the import report", () => {
    writeMd(
      rootPath,
      "20_wiki/x.md",
      "---\ntopic: Title\nkind: concept\nstate: draft\n---\n# body\n",
    );
    const plan = planImportMigration(rootPath);
    const outcome = applyImportMigration(plan, { dateStamp: "2026-05-12" });
    expect(outcome.filesWritten).toBe(1);
    const post = readFileSync(join(rootPath, "20_wiki/x.md"), "utf-8");
    expect(post).toContain("title: Title");
    expect(post).toContain("type: concept");
    expect(post).toContain("status: draft");
    const report = readFileSync(
      join(rootPath, "90_meta/health/import-2026-05-12.md"),
      "utf-8",
    );
    expect(report).toContain("# Wiki Import Report — 2026-05-12");
    expect(existsSync(join(outcome.backupDir, "20_wiki/x.md"))).toBe(true);
  });

  it("flattens subdirectories and rewrites the resulting file", () => {
    writeMd(
      rootPath,
      "20_wiki/concepts/idea.md",
      "---\ntopic: Idea\n---\n# body\n",
    );
    const plan = planImportMigration(rootPath);
    const outcome = applyImportMigration(plan, { dateStamp: "2026-05-12" });
    expect(outcome.filesMoved).toBe(1);
    expect(existsSync(join(rootPath, "20_wiki/idea.md"))).toBe(true);
    expect(existsSync(join(rootPath, "20_wiki/concepts/idea.md"))).toBe(false);
    const post = readFileSync(join(rootPath, "20_wiki/idea.md"), "utf-8");
    expect(post).toContain("title: Idea");
  });

  it("refuses to apply when slug conflicts are present and allowConflicts is not set", () => {
    writeMd(rootPath, "20_wiki/concepts/idea.md", "stub");
    writeMd(rootPath, "20_wiki/people/idea.md", "stub");
    const plan = planImportMigration(rootPath);
    expect(() => applyImportMigration(plan)).toThrow(/slug collision/);
  });

  it("preserves the original content under the backup directory", () => {
    writeMd(rootPath, "20_wiki/keep.md", "---\nkind: concept\n---\n# unchanged\n");
    const original = readFileSync(join(rootPath, "20_wiki/keep.md"), "utf-8");
    const plan = planImportMigration(rootPath);
    const outcome = applyImportMigration(plan, { dateStamp: "2026-05-12" });
    expect(readFileSync(join(outcome.backupDir, "20_wiki/keep.md"), "utf-8")).toBe(
      original,
    );
  });

  it("snapshots only files that exist; missing references do not throw", () => {
    // Construct a plan referencing a phantom move target. The apply path
    // must skip the backup step for it without crashing, because the
    // flatten could have created the only on-disk path.
    writeMd(rootPath, "20_wiki/keep.md", "---\nstate: draft\n---\n# body\n");
    const plan = planImportMigration(rootPath);
    plan.flattenMoves.push({
      fromRelPath: "20_wiki/missing/none.md",
      toRelPath: "20_wiki/none.md",
    });
    // The rename of the phantom will throw because the file doesn't exist;
    // we just assert that the backup step did not crash beforehand.
    expect(() => applyImportMigration(plan, { dateStamp: "2026-05-12" })).toThrow();
    const backupDir = readdirSync(join(rootPath, "90_meta/health"))[0];
    expect(backupDir).toMatch(/^pre-migrate-/);
  });
});
