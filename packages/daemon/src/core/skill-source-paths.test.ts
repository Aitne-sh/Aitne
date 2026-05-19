import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isSkillCategorySubdir,
  resolveBuiltinSkillDir,
  listBuiltinSlugs,
  listBuiltinSkillDirs,
} from "./skill-source-paths.js";

describe("skill-source-paths", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "skill-paths-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  describe("isSkillCategorySubdir", () => {
    it("returns true for known category names", () => {
      expect(isSkillCategorySubdir("wiki")).toBe(true);
    });
    it("returns false for unrelated names", () => {
      expect(isSkillCategorySubdir("notion")).toBe(false);
      expect(isSkillCategorySubdir("wiki-foo")).toBe(false);
    });
  });

  describe("resolveBuiltinSkillDir", () => {
    it("places wiki-prefixed slugs under the wiki/ subdir", () => {
      expect(resolveBuiltinSkillDir("/skills", "wiki-ingest")).toBe(
        "/skills/wiki/wiki-ingest",
      );
    });
    it("places non-prefixed slugs at the skills root", () => {
      expect(resolveBuiltinSkillDir("/skills", "notion")).toBe(
        "/skills/notion",
      );
    });
  });

  describe("walk helpers", () => {
    it("returns empty arrays when the root does not exist", () => {
      const missing = join(root, "does-not-exist");
      expect(listBuiltinSlugs(missing)).toEqual([]);
      expect(listBuiltinSkillDirs(missing)).toEqual([]);
    });

    it("enumerates root-level slug directories and skips top-level files", () => {
      mkdirSync(join(root, "notion"));
      mkdirSync(join(root, "mail"));
      writeFileSync(join(root, "README.md"), "ignored");
      const slugs = listBuiltinSlugs(root).sort();
      expect(slugs).toEqual(["mail", "notion"]);
      const dirs = listBuiltinSkillDirs(root);
      expect(dirs.find((d) => d.slug === "notion")?.dir).toBe(
        join(root, "notion"),
      );
    });

    it("recurses one level into category subdirs and skips non-directory entries", () => {
      mkdirSync(join(root, "wiki"));
      mkdirSync(join(root, "wiki", "wiki-ingest"));
      mkdirSync(join(root, "wiki", "wiki-compile"));
      // Stray file inside the category subdir — exercises the
      // `if (!sub.isDirectory()) continue;` branch on line 71.
      writeFileSync(join(root, "wiki", "stray.txt"), "ignore me");
      const slugs = listBuiltinSlugs(root).sort();
      expect(slugs).toEqual(["wiki-compile", "wiki-ingest"]);
      const dirs = listBuiltinSkillDirs(root);
      expect(dirs.find((d) => d.slug === "wiki-ingest")?.dir).toBe(
        join(root, "wiki", "wiki-ingest"),
      );
    });
  });
});
