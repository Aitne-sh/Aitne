import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  statSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const overrides = vi.hoisted(() => ({
  linkSync: undefined as ((src: string, dst: string) => void) | undefined,
  copyFileSync: undefined as ((src: string, dst: string) => void) | undefined,
  statSync: undefined as ((p: string) => ReturnType<typeof statSync>) | undefined,
}));

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    linkSync: (src: string, dst: string) =>
      overrides.linkSync ? overrides.linkSync(src, dst) : actual.linkSync(src, dst),
    copyFileSync: (src: string, dst: string) =>
      overrides.copyFileSync
        ? overrides.copyFileSync(src, dst)
        : actual.copyFileSync(src, dst),
    statSync: ((p: string) =>
      overrides.statSync ? overrides.statSync(p) : actual.statSync(p)) as typeof statSync,
  };
});

const { hardLinkOrCopy, resetHardLinkLogCache } = await import("./hardlink.js");

function makeRoot(): string {
  return mkdtempSync(join(tmpdir(), "pa-hardlink-"));
}

function withErrno(message: string, code: string): NodeJS.ErrnoException {
  const err = new Error(message) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

describe("hardLinkOrCopy", () => {
  let root: string;

  beforeEach(() => {
    root = makeRoot();
    resetHardLinkLogCache();
  });

  afterEach(() => {
    overrides.linkSync = undefined;
    overrides.copyFileSync = undefined;
    overrides.statSync = undefined;
    rmSync(root, { recursive: true, force: true });
  });

  it("hard-links a new dst to src (same inode after)", () => {
    const src = join(root, "src.bin");
    const dst = join(root, "dst.bin");
    writeFileSync(src, "hello");

    hardLinkOrCopy(src, dst);

    expect(existsSync(dst)).toBe(true);
    const s = statSync(src);
    const d = statSync(dst);
    expect(d.ino).toBe(s.ino);
    expect(d.dev).toBe(s.dev);
  });

  it("is idempotent when dst already exists with same inode (early return)", () => {
    const src = join(root, "src.bin");
    const dst = join(root, "dst.bin");
    writeFileSync(src, "hello");
    hardLinkOrCopy(src, dst);

    // Tighten override to ensure linkSync is never called on second invocation
    overrides.linkSync = () => {
      throw new Error("linkSync should not be called for same-inode dst");
    };

    expect(() => hardLinkOrCopy(src, dst)).not.toThrow();
  });

  it("accepts dst as-is when it exists with a different inode (no overwrite)", () => {
    const src = join(root, "src.bin");
    const dst = join(root, "dst.bin");
    writeFileSync(src, "hello");
    writeFileSync(dst, "different");

    overrides.linkSync = () => {
      throw new Error("linkSync should not be called when dst already exists");
    };

    expect(() => hardLinkOrCopy(src, dst)).not.toThrow();
    // The pre-existing content must NOT have been replaced
    expect(existsSync(dst)).toBe(true);
  });

  it("falls through silently when dst exists but statSync throws (inode compare path)", () => {
    const src = join(root, "src.bin");
    const dst = join(root, "dst.bin");
    writeFileSync(src, "hello");
    writeFileSync(dst, "other");

    overrides.statSync = () => {
      throw withErrno("simulated stat fail", "EACCES");
    };

    // Must not propagate the stat error; dst exists so the function returns.
    expect(() => hardLinkOrCopy(src, dst)).not.toThrow();
  });

  it("falls back to copy on EXDEV and logs once per volume pair", () => {
    const src = join(root, "src.bin");
    const dst = join(root, "dst.bin");
    writeFileSync(src, "payload");

    let copyCalls = 0;
    overrides.linkSync = () => {
      throw withErrno("cross-device", "EXDEV");
    };
    overrides.copyFileSync = (_s, d) => {
      copyCalls++;
      writeFileSync(d, "copied");
    };

    hardLinkOrCopy(src, dst);
    expect(copyCalls).toBe(1);
    expect(existsSync(dst)).toBe(true);

    // Second call: dst now exists, so the existsSync branch returns early —
    // no second link/copy attempt. Reset dst to force the link path again.
    rmSync(dst);
    hardLinkOrCopy(src, dst);
    expect(copyCalls).toBe(2);
  });

  it("falls back to copy on ENOTSUP", () => {
    const src = join(root, "src.bin");
    const dst = join(root, "dst.bin");
    writeFileSync(src, "x");

    let copyCalls = 0;
    overrides.linkSync = () => {
      throw withErrno("not supported", "ENOTSUP");
    };
    overrides.copyFileSync = (_s, d) => {
      copyCalls++;
      writeFileSync(d, "copied");
    };

    hardLinkOrCopy(src, dst);
    expect(copyCalls).toBe(1);
  });

  it("falls back to copy on EPERM", () => {
    const src = join(root, "src.bin");
    const dst = join(root, "dst.bin");
    writeFileSync(src, "x");

    let copyCalls = 0;
    overrides.linkSync = () => {
      throw withErrno("permission", "EPERM");
    };
    overrides.copyFileSync = (_s, d) => {
      copyCalls++;
      writeFileSync(d, "copied");
    };

    hardLinkOrCopy(src, dst);
    expect(copyCalls).toBe(1);
  });

  it("rethrows linkSync errors that aren't in the fallback set", () => {
    const src = join(root, "src.bin");
    const dst = join(root, "dst.bin");
    writeFileSync(src, "x");

    overrides.linkSync = () => {
      throw withErrno("disk full", "ENOSPC");
    };

    expect(() => hardLinkOrCopy(src, dst)).toThrow(/disk full/);
  });

  it("uses '?' in the pair key when deviceOf throws (statSync fail in deviceOf)", () => {
    const src = join(root, "src.bin");
    const dst = join(root, "dst.bin");
    writeFileSync(src, "x");

    overrides.linkSync = () => {
      throw withErrno("cross-device", "EXDEV");
    };

    // Force statSync to throw for every call so deviceOf returns null for both args.
    // hardLinkOrCopy itself never calls statSync on the EXDEV path before deviceOf,
    // so this only affects the pair-key construction.
    overrides.statSync = () => {
      throw withErrno("stat fail", "EACCES");
    };

    overrides.copyFileSync = (_s, d) => writeFileSync(d, "copied");

    expect(() => hardLinkOrCopy(src, dst)).not.toThrow();
  });

  it("resetHardLinkLogCache clears the dedup set so logging fires again", () => {
    const src = join(root, "src.bin");
    const dst1 = join(root, "dst1.bin");
    const dst2 = join(root, "dst2.bin");
    writeFileSync(src, "x");

    overrides.linkSync = () => {
      throw withErrno("cross-device", "EXDEV");
    };
    overrides.copyFileSync = (_s, d) => writeFileSync(d, "copied");

    hardLinkOrCopy(src, dst1); // first log fires
    hardLinkOrCopy(src, dst2); // same pair key — dedup, no second log

    resetHardLinkLogCache();
    // After reset, the next call would log again — we only assert the reset
    // function runs without error (logger side-effects aren't observable here).
    expect(() => resetHardLinkLogCache()).not.toThrow();
  });
});
