import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  JournalMirrorService,
  resolveJournalMirrorPath,
} from "./writer.js";

describe("JournalMirrorService", () => {
  const tmpRoots: string[] = [];

  afterEach(() => {
    while (tmpRoots.length > 0) {
      rmSync(tmpRoots.pop()!, { recursive: true, force: true });
    }
  });

  it("writes mirrored content beneath the configured subdirectory", () => {
    const root = mkdtempSync(join(tmpdir(), "journal-mirror-"));
    tmpRoots.push(root);
    const service = new JournalMirrorService();

    const result = service.write(
      {
        kind: "obsidian",
        rootPath: root,
        subdirectory: "exports/journal",
      },
      {
        relativePath: "daily/2026-04-16.md",
        content: "# 2026-04-16\n",
        rendering: "obsidian",
      },
    );

    expect(result.targetPath).toBe(
      join(root, "exports/journal", "daily/2026-04-16.md"),
    );
    expect(readFileSync(result.targetPath, "utf-8")).toBe("# 2026-04-16\n");
  });

  it("rejects traversal outside the target root", () => {
    expect(() =>
      resolveJournalMirrorPath(
        {
          kind: "filesystem",
          rootPath: "/tmp/journal-root",
          subdirectory: "daily",
        },
        "../escape.md",
      ),
    ).toThrow("inside the target root");
  });

  it("resolves path directly under rootPath when subdirectory is absent", () => {
    const result = resolveJournalMirrorPath(
      { kind: "filesystem", rootPath: "/tmp/root" },
      "daily/2026-04-18.md",
    );
    expect(result).toBe(join("/tmp/root", "daily/2026-04-18.md"));
  });

  it("resolves path directly under rootPath when subdirectory is null", () => {
    const result = resolveJournalMirrorPath(
      { kind: "filesystem", rootPath: "/tmp/root", subdirectory: null },
      "daily/2026-04-18.md",
    );
    expect(result).toBe(join("/tmp/root", "daily/2026-04-18.md"));
  });

  it("rejects an empty relative path", () => {
    expect(() =>
      resolveJournalMirrorPath(
        { kind: "filesystem", rootPath: "/tmp/root" },
        "   ",
      ),
    ).toThrow("must not be empty");
  });

  it("rejects an absolute relative path", () => {
    expect(() =>
      resolveJournalMirrorPath(
        { kind: "filesystem", rootPath: "/tmp/root" },
        "/absolute/path.md",
      ),
    ).toThrow("must be relative");
  });
});
