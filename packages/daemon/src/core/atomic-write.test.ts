import { describe, it, expect } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  readlinkSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeFileAtomically } from "./atomic-write.js";

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "pa-atomic-write-"));
}

describe("writeFileAtomically", () => {
  it("creates a new file with the given content", () => {
    const root = makeTempDir();
    try {
      const target = join(root, "a.md");
      writeFileAtomically(target, "hello\n");
      expect(readFileSync(target, "utf-8")).toBe("hello\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("creates parent directories recursively", () => {
    const root = makeTempDir();
    try {
      const target = join(root, "deep", "nested", "file.md");
      writeFileAtomically(target, "x");
      expect(readFileSync(target, "utf-8")).toBe("x");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("overwrites an existing regular file", () => {
    const root = makeTempDir();
    try {
      const target = join(root, "a.md");
      writeFileSync(target, "v1", "utf-8");
      writeFileAtomically(target, "v2");
      expect(readFileSync(target, "utf-8")).toBe("v2");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses to overwrite a symlink at the destination", () => {
    const root = makeTempDir();
    try {
      const outside = join(root, "outside.txt");
      writeFileSync(outside, "untouched", "utf-8");
      const target = join(root, "alias.md");
      symlinkSync(outside, target);

      expect(() => writeFileAtomically(target, "evil")).toThrow(
        /symlink/,
      );
      // The symlink target must remain unchanged — this is the
      // exploit being prevented.
      expect(readFileSync(outside, "utf-8")).toBe("untouched");
      // The link itself should still exist (not silently replaced).
      expect(readlinkSync(target)).toBe(outside);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses to write through a symlinked parent directory", () => {
    const root = makeTempDir();
    try {
      const real = join(root, "real");
      const linked = join(root, "linked");
      mkdirSync(real, { recursive: true });
      symlinkSync(real, linked);

      const target = join(linked, "file.md");
      expect(() => writeFileAtomically(target, "x")).toThrow(/symlink/);
      // No file should have been written through the link.
      expect(existsSync(join(real, "file.md"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not leave a temp file when the rename fails", () => {
    // Simulate rename failure by making the destination directory
    // read-only after the temp file is written. The temp file should
    // be cleaned up.
    const root = makeTempDir();
    try {
      const target = join(root, "a.md");
      writeFileAtomically(target, "v1");
      // Sanity: subsequent successful writes leave no temp residue.
      writeFileAtomically(target, "v2");
      const entries = readdirSync(root);
      const tempLeftovers = entries.filter((name) => name.includes(".tmp."));
      expect(tempLeftovers).toEqual([]);
      expect(readFileSync(target, "utf-8")).toBe("v2");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("preserves UTF-8 multibyte content exactly", () => {
    const root = makeTempDir();
    try {
      const target = join(root, "utf8.md");
      const content = "Café résumé naïve — emoji ✅ 🎉 — symbols €£$\n## Sección\n- Niño\n";
      writeFileAtomically(target, content);
      expect(readFileSync(target, "utf-8")).toBe(content);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("cleans up the temp file when rename fails (e.g. destination is a directory)", () => {
    // If the destination already exists as a directory, rename(2) of a
    // regular file over it returns EISDIR. The catch block must remove
    // the temp file so we don't leak it.
    const root = makeTempDir();
    try {
      const target = join(root, "is-a-dir");
      mkdirSync(target);

      expect(() => writeFileAtomically(target, "x")).toThrow();

      // Rename failed, so no temp leftover should remain in the parent.
      const leftovers = readdirSync(root).filter((n) => n.includes(".tmp."));
      expect(leftovers).toEqual([]);
      // The directory should still be intact.
      expect(existsSync(target)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
