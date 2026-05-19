import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeExistingWikiVault } from "./import-probe.js";

function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

describe("probeExistingWikiVault", () => {
  let rootPath: string;

  beforeEach(() => {
    rootPath = mkdtempSync(join(tmpdir(), "pa-wiki-probe-"));
  });

  afterEach(() => {
    rmSync(rootPath, { recursive: true, force: true });
  });

  it("classifies an empty directory as kind=empty", () => {
    const result = probeExistingWikiVault(rootPath);
    expect(result.kind).toBe("empty");
    expect(result.layers.every((layer) => !layer.exists)).toBe(true);
    expect(result.taxonomyPresent).toBe(false);
    expect(result.indexPresent).toBe(false);
    expect(result.isGitRepo).toBe(false);
  });

  it("classifies a single non-LLM-Wiki markdown file as kind=partial", () => {
    writeFileSync(join(rootPath, "loose-note.md"), "# stray");
    const result = probeExistingWikiVault(rootPath);
    expect(result.kind).toBe("partial");
  });

  it("classifies a full LLM-Wiki layout as kind=wiki and inventories layers", () => {
    ensureDir(join(rootPath, "00_inbox"));
    ensureDir(join(rootPath, "10_raw"));
    ensureDir(join(rootPath, "20_wiki"));
    ensureDir(join(rootPath, "90_meta/schemas"));
    writeFileSync(
      join(rootPath, "10_raw/a.md"),
      "---\ntitle: Sample\nurl: https://example.com\ncaptured_at: 2026-05-12\ntype: article\ntags: []\n---\n# A",
    );
    writeFileSync(
      join(rootPath, "20_wiki/concept.md"),
      "---\ntitle: Concept\ntype: concept\nstatus: draft\ntags: []\nsource: 10_raw/a.md\ncreated: 2026-05-12\n---\n# C",
    );
    writeFileSync(
      join(rootPath, "90_meta/schemas/raw.md"),
      "---\ntitle: Raw\nurl: x\ncaptured_at: 2026-05-12\ntype: x\ntags: []\n---\n",
    );
    writeFileSync(join(rootPath, "20_wiki/_index.md"), "# Index\n");
    writeFileSync(join(rootPath, "90_meta/taxonomy.md"), "# Taxonomy\n");

    const result = probeExistingWikiVault(rootPath);
    expect(result.kind).toBe("wiki");
    expect(result.layers.find((l) => l.dir === "20_wiki")?.fileCount).toBe(2);
    expect(result.taxonomyPresent).toBe(true);
    expect(result.indexPresent).toBe(true);
    expect(result.topTypes.map((entry) => entry.value)).toContain("article");
    expect(result.topTypes.map((entry) => entry.value)).toContain("concept");
  });

  it("flags unexpected subdirectories under 10_raw and 20_wiki", () => {
    ensureDir(join(rootPath, "10_raw/articles"));
    ensureDir(join(rootPath, "20_wiki/concepts"));
    writeFileSync(join(rootPath, "10_raw/articles/x.md"), "stub");
    writeFileSync(join(rootPath, "20_wiki/concepts/y.md"), "stub");
    const result = probeExistingWikiVault(rootPath);
    expect(result.unexpectedSubdirectories).toEqual(
      expect.arrayContaining([
        { layer: "10_raw", subdir: "articles" },
        { layer: "20_wiki", subdir: "concepts" },
      ]),
    );
  });

  it("treats the images/ subdirectory as expected under 10_raw", () => {
    ensureDir(join(rootPath, "10_raw/images/something"));
    writeFileSync(join(rootPath, "10_raw/x.md"), "stub");
    const result = probeExistingWikiVault(rootPath);
    expect(result.unexpectedSubdirectories.find((row) => row.layer === "10_raw")).toBeUndefined();
  });

  it("computes schema deltas including missing/extra keys", () => {
    ensureDir(join(rootPath, "90_meta/schemas"));
    writeFileSync(
      join(rootPath, "90_meta/schemas/wiki.md"),
      "---\ntitle: T\ntype: T\nstatus: T\ntags: T\nextraneous: yes\n---\n",
    );
    const result = probeExistingWikiVault(rootPath);
    const wikiDelta = result.schemas.find((row) => row.schema === "wiki");
    expect(wikiDelta?.present).toBe(true);
    expect(wikiDelta?.missingKeys).toEqual(
      expect.arrayContaining(["source", "created"]),
    );
    expect(wikiDelta?.extraKeys).toEqual(["extraneous"]);
  });
});
