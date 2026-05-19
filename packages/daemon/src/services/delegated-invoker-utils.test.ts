import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  hashArgs,
  LegacyOneShotLease,
  mergeCost,
  readFileSyncIfExists,
  stripCodeFences,
  zeroCost,
} from "./delegated-invoker-utils.js";

describe("readFileSyncIfExists", () => {
  it("returns null when the path is missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "pa-utils-"));
    try {
      expect(readFileSyncIfExists(join(dir, "missing.txt"))).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns the file body when the path exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "pa-utils-"));
    try {
      const target = join(dir, "present.txt");
      writeFileSync(target, "hello\nworld", "utf-8");
      expect(readFileSyncIfExists(target)).toBe("hello\nworld");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("hashArgs", () => {
  it("returns a 16-char hex digest for serializable args", () => {
    const out = hashArgs({ foo: "bar", n: 1 });
    expect(out).toMatch(/^[0-9a-f]{16}$/);
  });

  it("treats undefined and null identically (null fallback)", () => {
    expect(hashArgs(undefined)).toBe(hashArgs(null));
  });

  it("returns the same digest across calls with stable input", () => {
    expect(hashArgs({ a: 1, b: 2 })).toBe(hashArgs({ a: 1, b: 2 }));
  });

  it("returns 'unhashable' when JSON.stringify throws (e.g. circular)", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(hashArgs(circular)).toBe("unhashable");
  });
});

describe("zeroCost / mergeCost", () => {
  it("zeroCost yields all-zero counters", () => {
    expect(zeroCost()).toEqual({
      tokensInput: 0,
      tokensOutput: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      costUsd: 0,
      durationMs: 0,
      numTurns: 0,
    });
  });

  it("mergeCost sums each field elementwise", () => {
    const a = {
      tokensInput: 1,
      tokensOutput: 2,
      cacheCreationTokens: 3,
      cacheReadTokens: 4,
      costUsd: 0.5,
      durationMs: 10,
      numTurns: 1,
    };
    const b = {
      tokensInput: 10,
      tokensOutput: 20,
      cacheCreationTokens: 30,
      cacheReadTokens: 40,
      costUsd: 1.5,
      durationMs: 90,
      numTurns: 2,
    };
    expect(mergeCost(a, b)).toEqual({
      tokensInput: 11,
      tokensOutput: 22,
      cacheCreationTokens: 33,
      cacheReadTokens: 44,
      costUsd: 2.0,
      durationMs: 100,
      numTurns: 3,
    });
  });

  it("mergeCost(zero, zero) is zero", () => {
    expect(mergeCost(zeroCost(), zeroCost())).toEqual(zeroCost());
  });
});

describe("stripCodeFences", () => {
  it("strips ```json …``` wrapping", () => {
    const body = '{"ok":true}';
    expect(stripCodeFences("```json\n" + body + "\n```")).toBe(body);
  });

  it("strips bare ``` …``` wrapping", () => {
    const body = '{"ok":true}';
    expect(stripCodeFences("```\n" + body + "\n```")).toBe(body);
  });

  it("strips a leading fence without a matching trailing fence", () => {
    const body = '{"partial":true}';
    expect(stripCodeFences("```json\n" + body)).toBe(body);
  });

  it("strips a trailing fence without a matching leading fence", () => {
    const body = '{"partial":true}';
    expect(stripCodeFences(body + "\n```")).toBe(body);
  });

  it("returns the input unchanged when no fence is present", () => {
    expect(stripCodeFences('{"ok":true}')).toBe('{"ok":true}');
  });

  it("trims surrounding whitespace before matching", () => {
    expect(stripCodeFences("\n  ```json\n42\n```  \n")).toBe("42");
  });
});

describe("LegacyOneShotLease", () => {
  it("runs cleanup on the first release() and is idempotent", () => {
    const cleanup = vi.fn();
    const lease = new LegacyOneShotLease("/tmp/x", cleanup);
    expect(lease.fromPool).toBe(false);
    expect(lease.sessionDir).toBe("/tmp/x");
    lease.release();
    lease.release();
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("runs cleanup on the first discard() and is idempotent", () => {
    const cleanup = vi.fn();
    const lease = new LegacyOneShotLease("/tmp/y", cleanup);
    lease.discard();
    lease.discard();
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("discard() after release() is a no-op (one-shot semantics)", () => {
    const cleanup = vi.fn();
    const lease = new LegacyOneShotLease("/tmp/z", cleanup);
    lease.release();
    lease.discard();
    expect(cleanup).toHaveBeenCalledTimes(1);
  });
});
