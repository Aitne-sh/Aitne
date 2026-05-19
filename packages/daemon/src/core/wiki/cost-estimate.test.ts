import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { approxTokenCount, estimateFullCompileCost } from "./cost-estimate.js";
import type { WikiWorkspaceRow } from "./workspaces.js";

function makeWorkspaceRow(
  rootPath: string,
  thresholdUsd = 2.0,
): Pick<WikiWorkspaceRow, "root_path" | "full_compile_approval_threshold_usd"> {
  return {
    root_path: rootPath,
    full_compile_approval_threshold_usd: thresholdUsd,
  };
}

describe("estimateFullCompileCost", () => {
  let rootPath: string;

  beforeEach(() => {
    rootPath = mkdtempSync(join(tmpdir(), "pa-wiki-cost-"));
    mkdirSync(join(rootPath, "10_raw"));
  });

  afterEach(() => {
    rmSync(rootPath, { recursive: true, force: true });
  });

  it("returns zero cost on an empty raw layer", () => {
    const estimate = estimateFullCompileCost(makeWorkspaceRow(rootPath));
    expect(estimate.rawCount).toBe(0);
    expect(estimate.expectedUsd).toBe(0);
    expect(estimate.optimisticUsd).toBe(0);
    expect(estimate.pessimisticUsd).toBe(0);
    expect(estimate.exceedsThreshold).toBe(false);
  });

  it("counts only markdown files at the raw layer root", () => {
    writeFileSync(join(rootPath, "10_raw/a.md"), "stub");
    writeFileSync(join(rootPath, "10_raw/b.md"), "stub");
    writeFileSync(join(rootPath, "10_raw/c.txt"), "ignored");
    // `images/` is the only permitted subdirectory and is skipped.
    mkdirSync(join(rootPath, "10_raw/images"), { recursive: true });
    writeFileSync(join(rootPath, "10_raw/images/should-not-count.md"), "stub");
    const estimate = estimateFullCompileCost(makeWorkspaceRow(rootPath));
    expect(estimate.rawCount).toBe(2);
  });

  it("brackets cost with the 0.5×/2× multipliers", () => {
    for (let i = 0; i < 4; i += 1) {
      writeFileSync(join(rootPath, `10_raw/file-${i}.md`), "stub");
    }
    const estimate = estimateFullCompileCost(
      makeWorkspaceRow(rootPath, 100),
      {
        avgInputTokensPerRaw: 1000,
        unitCostUsdPerKToken: 0.003,
      },
    );
    expect(estimate.expectedUsd).toBeCloseTo(0.012, 4);
    expect(estimate.optimisticUsd).toBeCloseTo(0.006, 4);
    expect(estimate.pessimisticUsd).toBeCloseTo(0.024, 4);
  });

  it("flips exceedsThreshold when the pessimistic estimate breaches the cap", () => {
    const estimate = estimateFullCompileCost(
      makeWorkspaceRow(rootPath, 0.01),
      {
        rawCountOverride: 100,
        avgInputTokensPerRaw: 1000,
        unitCostUsdPerKToken: 0.003,
      },
    );
    expect(estimate.exceedsThreshold).toBe(true);
  });

  it("uses override raw counts when supplied (no disk scan needed)", () => {
    const estimate = estimateFullCompileCost(makeWorkspaceRow(rootPath), {
      rawCountOverride: 999,
    });
    expect(estimate.rawCount).toBe(999);
  });

  it("falls back to recursive counting when foreign subdirectories exist", () => {
    // Imported vaults may still have type-based subdirs under 10_raw/
    // until the migration runs. The estimator should still produce a
    // sensible count so the banner is useful pre-flatten.
    mkdirSync(join(rootPath, "10_raw/topic"), { recursive: true });
    writeFileSync(join(rootPath, "10_raw/topic/x.md"), "stub");
    writeFileSync(join(rootPath, "10_raw/topic/y.md"), "stub");
    writeFileSync(join(rootPath, "10_raw/root.md"), "stub");
    const estimate = estimateFullCompileCost(makeWorkspaceRow(rootPath), {
      avgInputTokensPerRaw: 1000,
    });
    expect(estimate.rawCount).toBe(3);
  });

  describe("P4.C — token-level estimator", () => {
    it("defaults to per-file-chars when no flat heuristic is requested", () => {
      writeFileSync(join(rootPath, "10_raw/a.md"), "short note");
      const estimate = estimateFullCompileCost(makeWorkspaceRow(rootPath));
      expect(estimate.method).toBe("per-file-chars");
    });

    it("scales tokens with file size rather than file count", () => {
      writeFileSync(join(rootPath, "10_raw/short.md"), "a");
      writeFileSync(join(rootPath, "10_raw/long.md"), "lorem ipsum dolor ".repeat(1_000));
      const estimate = estimateFullCompileCost(makeWorkspaceRow(rootPath));
      const sortedPerFile = [...estimate.perFile].sort(
        (a, b) => b.estimatedTokens - a.estimatedTokens,
      );
      expect(sortedPerFile[0].path).toBe("10_raw/long.md");
      expect(sortedPerFile[0].estimatedTokens).toBeGreaterThan(
        sortedPerFile[sortedPerFile.length - 1].estimatedTokens,
      );
    });

    it("honours perFileBreakdownLimit", () => {
      for (let i = 0; i < 5; i += 1) {
        writeFileSync(join(rootPath, `10_raw/file-${i}.md`), "abc");
      }
      const estimate = estimateFullCompileCost(makeWorkspaceRow(rootPath), {
        perFileBreakdownLimit: 2,
      });
      expect(estimate.perFile).toHaveLength(2);
      expect(estimate.rawCount).toBe(5);
    });

    it("keeps the per-file breakdown sorted descending by estimatedTokens", () => {
      writeFileSync(join(rootPath, "10_raw/big.md"), "x".repeat(10_000));
      writeFileSync(join(rootPath, "10_raw/mid.md"), "x".repeat(1_000));
      writeFileSync(join(rootPath, "10_raw/small.md"), "x".repeat(10));
      const estimate = estimateFullCompileCost(makeWorkspaceRow(rootPath));
      expect(estimate.perFile.map((f) => f.path)).toEqual([
        "10_raw/big.md",
        "10_raw/mid.md",
        "10_raw/small.md",
      ]);
    });

    it("preserves flat-heuristic semantics when avgInputTokensPerRaw is supplied", () => {
      writeFileSync(join(rootPath, "10_raw/a.md"), "x".repeat(10_000));
      const estimate = estimateFullCompileCost(makeWorkspaceRow(rootPath, 100), {
        avgInputTokensPerRaw: 1000,
        unitCostUsdPerKToken: 0.003,
      });
      expect(estimate.method).toBe("flat-heuristic");
      // 1 file × 1000 tokens flat (NOT the per-file char-count).
      expect(estimate.estimatedInputTokens).toBe(1000);
      expect(estimate.perFile).toEqual([]);
    });

    it("rawCountOverride forces a synthetic count and clears the per-file list", () => {
      writeFileSync(join(rootPath, "10_raw/a.md"), "real file content");
      const estimate = estimateFullCompileCost(makeWorkspaceRow(rootPath), {
        rawCountOverride: 50,
      });
      expect(estimate.rawCount).toBe(50);
      expect(estimate.perFile).toEqual([]);
    });
  });

  describe("approxTokenCount", () => {
    it("returns the per-file minimum for empty input", () => {
      expect(approxTokenCount("")).toBe(200);
    });

    it("uses ~4 chars/token for Latin-script prose", () => {
      const tokens = approxTokenCount("a".repeat(4_000));
      // ceil(4000/4) == 1000, comfortably above the 200 floor.
      expect(tokens).toBe(1000);
    });

    it("uses ~1.5 chars/token for majority-CJK content", () => {
      const cjk = "量子コンピューターは超伝導状態のクビットを使う。".repeat(40);
      const tokens = approxTokenCount(cjk);
      // Should be denser than the Latin divisor: latin would give
      // ceil(cjk.length/4); CJK divisor gives ceil(cjk.length/1.5).
      expect(tokens).toBeGreaterThan(Math.ceil(cjk.length / 4));
    });

    it("never falls below the per-file minimum", () => {
      expect(approxTokenCount("hi")).toBe(200);
    });
  });
});
