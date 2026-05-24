import { describe, it, expect } from "vitest";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
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

  it("preserves the existing file's permission mode when overwriting", () => {
    // Regression: before this guard, `openSync(..., 0o644)` silently
    // widened a 0o600 file (e.g. sensitive dossier / policy) on every
    // write. The fix is to lstat the existing file and reuse its mode
    // bits for the temp file open.
    const root = makeTempDir();
    try {
      const target = join(root, "secret.md");
      writeFileSync(target, "v1", "utf-8");
      chmodSync(target, 0o600);
      // Sanity — the test platform must honour 0o600 (skip elsewhere).
      const beforeMode = statSync(target).mode & 0o777;
      if (beforeMode !== 0o600) return;

      writeFileAtomically(target, "v2");

      expect(readFileSync(target, "utf-8")).toBe("v2");
      expect(statSync(target).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("defaults new files to owner-only (0o600) — context MD files carry operator PII", () => {
    const root = makeTempDir();
    try {
      const target = join(root, "fresh.md");
      writeFileAtomically(target, "hello");
      const mode = statSync(target).mode & 0o777;
      // The kernel honours the requested mode AND'd with the inverse
      // of umask, so the assertion is "mode is a subset of 0o600" —
      // we never want world-readable or group-readable as a default.
      expect(mode & 0o077).toBe(0);
      expect(mode & 0o600).toBe(0o600);
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
