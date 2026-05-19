import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// vi.mock is hoisted; route most calls through the actual module and
// allow individual tests to override fsyncSync / closeSync / unlinkSync.
const overrides = vi.hoisted(() => ({
  fsyncSync: undefined as ((fd: number) => void) | undefined,
  closeSync: undefined as ((fd: number) => void) | undefined,
  unlinkSync: undefined as ((path: string) => void) | undefined,
}));

vi.mock("node:fs", async () => {
  const actual =
    await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    fsyncSync: (fd: number) =>
      overrides.fsyncSync ? overrides.fsyncSync(fd) : actual.fsyncSync(fd),
    closeSync: (fd: number) =>
      overrides.closeSync ? overrides.closeSync(fd) : actual.closeSync(fd),
    unlinkSync: (p: string) =>
      overrides.unlinkSync ? overrides.unlinkSync(p) : actual.unlinkSync(p),
  };
});

const { writeFileAtomically } = await import("./atomic-write.js");
const { closeSync: realClose, unlinkSync: realUnlink } = await import("node:fs");

afterEach(() => {
  overrides.fsyncSync = undefined;
  overrides.closeSync = undefined;
  overrides.unlinkSync = undefined;
});

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "pa-atomic-write-fail-"));
}

describe("writeFileAtomically — write/fsync failure cleanup", () => {
  it("cleans up the temp file and rethrows when fsync fails", () => {
    const root = makeTempDir();
    try {
      const target = join(root, "a.md");
      overrides.fsyncSync = () => {
        throw new Error("simulated fsync failure");
      };

      expect(() => writeFileAtomically(target, "v1")).toThrow(
        /simulated fsync failure/,
      );

      // Temp file should have been unlinked even though fsync failed.
      const leftovers = readdirSync(root).filter((n) => n.includes(".tmp."));
      expect(leftovers).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("swallows secondary close/unlink failures during the write-error cleanup", () => {
    // The catch block at lines ~120-133 deliberately ignores failures
    // from closeSync and unlinkSync so the original error surfaces.
    const root = makeTempDir();
    try {
      const target = join(root, "b.md");
      overrides.fsyncSync = () => {
        throw new Error("primary failure");
      };
      // Force the secondary cleanup branches to throw — they must be
      // swallowed without masking the primary error.
      overrides.closeSync = (fd) => {
        // Still close the real fd to avoid leaking it, but pretend it
        // failed so the catch path exercises the swallow branch.
        try {
          realClose(fd);
        } catch {
          /* ignore */
        }
        throw new Error("close failed");
      };
      overrides.unlinkSync = (p) => {
        try {
          realUnlink(p);
        } catch {
          /* ignore */
        }
        throw new Error("unlink failed");
      };

      expect(() => writeFileAtomically(target, "v1")).toThrow(/primary failure/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("swallows unlink failure during the rename-error cleanup path", async () => {
    const root = makeTempDir();
    try {
      // Make rename fail by pre-creating a directory at the destination.
      const target = join(root, "as-dir");
      const { mkdirSync } = await import("node:fs");
      mkdirSync(target);

      // The cleanup unlinkSync inside the rename catch must be allowed
      // to throw without the primary rename error being masked.
      overrides.unlinkSync = (p) => {
        try {
          realUnlink(p);
        } catch {
          /* ignore */
        }
        throw new Error("unlink failed during rename cleanup");
      };

      expect(() => writeFileAtomically(target, "v1")).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
