import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  POLICY_FILE_REGISTRY,
  resolvePolicyRefs,
  loadPolicyBlocks,
  renderPolicyBlocks,
  appendPolicyBlocks,
} from "./policy-files.js";

describe("policy-files", () => {
  let tmp: string;
  let contextDir: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "policy-files-test-"));
    contextDir = join(tmp, "context");
    mkdirSync(join(contextDir, "rules"), { recursive: true });
    mkdirSync(join(contextDir, "routines"), { recursive: true });
    mkdirSync(join(contextDir, "routines", "custom"), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  describe("registry", () => {
    it("exposes global * refs for redaction + mcp (management.md is owned by ContextBuilder)", () => {
      const global = POLICY_FILE_REGISTRY["*"];
      // rules/management.md is injected as `<management_rules>` by
      // ContextBuilder; the policy registry intentionally does NOT
      // re-emit it (see policy-files.ts module JSDoc).
      expect(global.some((r) => r.path === "rules/management.md")).toBe(false);
      expect(global.some((r) => r.path === "rules/redaction.md")).toBe(true);
      expect(global.some((r) => r.path === "rules/mcp.md")).toBe(true);
    });

    it("mcp ref is gated on flags.mcpEnabled", () => {
      const mcp = POLICY_FILE_REGISTRY["*"].find(
        (r) => r.path === "rules/mcp.md",
      );
      expect(mcp?.injectIf).toBeDefined();
      expect(mcp?.injectIf?.({ processKey: "x" })).toBe(false);
      expect(mcp?.injectIf?.({ processKey: "x", flags: {} })).toBe(false);
      expect(
        mcp?.injectIf?.({ processKey: "x", flags: { mcpEnabled: true } }),
      ).toBe(true);
      expect(
        mcp?.injectIf?.({ processKey: "x", flags: { mcpEnabled: false } }),
      ).toBe(false);
    });

    it("includes hourly / morning / evening / weekly / monthly / roadmap keys", () => {
      expect(POLICY_FILE_REGISTRY["routine.hourly_check"]).toBeDefined();
      expect(POLICY_FILE_REGISTRY["routine.morning_routine"]).toBeDefined();
      expect(POLICY_FILE_REGISTRY["routine.evening_review"]).toBeDefined();
      expect(POLICY_FILE_REGISTRY["routine.weekly_review"]).toBeDefined();
      expect(POLICY_FILE_REGISTRY["routine.monthly_review"]).toBeDefined();
      expect(POLICY_FILE_REGISTRY["routine.roadmap_refresh"]).toBeDefined();
      // `routine.morning_routine_initial` retired by Phase 7 (2026-05-16)
      // — no longer in the registry. The first-run branch routes through
      // `routine.morning_routine_today` with the same `routines/morning.md`
      // policy file injected via that key's entry.
      expect(POLICY_FILE_REGISTRY["routine.morning_routine_initial"]).toBeUndefined();
    });

    it("declares the Phase 5 stage-split keys with the per-design policy mix", () => {
      // Stage A — inherits the global `*` defaults and gets the
      // user-editable morning checks. Journal-format / journal-export
      // are NOT injected here; those are Stage B's policies in the
      // split.
      const stageA = POLICY_FILE_REGISTRY["routine.morning_routine_today"];
      expect(stageA).toBeDefined();
      const stageAPaths = stageA!.map((r) => r.path);
      expect(stageAPaths).toContain("routines/morning.md");
      expect(stageAPaths).not.toContain("rules/journal-format.md");
      expect(stageAPaths).not.toContain("rules/journal-export.md");

      // Stage B — opts out of the `*` defaults entirely (no `mcp.md`,
      // no parent management bindings) and re-declares only the
      // policies it actually consumes: redaction + journal format +
      // journal export.
      const stageB = POLICY_FILE_REGISTRY["routine.morning_routine_journal"];
      expect(stageB).toBeDefined();
      const stageBPaths = stageB!.map((r) => r.path);
      expect(stageBPaths).toEqual(
        expect.arrayContaining([
          "rules/redaction.md",
          "rules/journal-format.md",
          "rules/journal-export.md",
        ]),
      );
    });
  });

  describe("resolvePolicyRefs", () => {
    it("combines global + specific refs for known keys", () => {
      const refs = resolvePolicyRefs("routine.hourly_check");
      const paths = refs.map((r) => r.path);
      // management.md is injected by ContextBuilder, not here.
      expect(paths).not.toContain("rules/management.md");
      expect(paths).toContain("rules/redaction.md");
      expect(paths).toContain("routines/hourly.md");
    });

    it("maps roadmap refresh to the monthly planning rulebook", () => {
      const refs = resolvePolicyRefs("routine.roadmap_refresh");
      const paths = refs.map((r) => r.path);
      expect(paths).toContain("routines/monthly.md");
      expect(paths).not.toContain("rules/management.md");
    });

    it("adds the dynamic slug file for custom routines", () => {
      const refs = resolvePolicyRefs("routine.custom.tuesday-notion");
      const paths = refs.map((r) => r.path);
      expect(paths).toContain("routines/custom/tuesday-notion.md");
      expect(paths).not.toContain("rules/management.md");
    });

    it("returns only global refs for unknown keys", () => {
      const refs = resolvePolicyRefs("message.received.dm");
      const paths = refs.map((r) => r.path);
      expect(paths).toEqual([
        "rules/redaction.md",
        "rules/mcp.md",
      ]);
    });

    it("Stage A inherits the * defaults plus its registered morning checks", () => {
      const refs = resolvePolicyRefs("routine.morning_routine_today");
      const paths = refs.map((r) => r.path);
      // From `*`:
      expect(paths).toContain("rules/redaction.md");
      expect(paths).toContain("rules/mcp.md");
      // From its own registry entry:
      expect(paths).toContain("routines/morning.md");
      // Stage B's policies do NOT bleed in.
      expect(paths).not.toContain("rules/journal-format.md");
      expect(paths).not.toContain("rules/journal-export.md");
    });

    it("Stage B opts OUT of the * defaults — only its declared policies are returned", () => {
      // Phase 5 explicit opt-out: Stage B runs on lite tier with a
      // narrow `context` + `_safety` skill bundle. Inheriting the
      // global `*` set (mcp + redaction) would pay lite-tier prompt
      // budget for irrelevant behaviour, so the resolver skips `*`
      // entirely and Stage B re-declares redaction inline.
      const refs = resolvePolicyRefs("routine.morning_routine_journal");
      const paths = refs.map((r) => r.path);
      expect(paths).toEqual([
        "rules/redaction.md",
        "rules/journal-format.md",
        "rules/journal-export.md",
      ]);
      // Explicitly verify the opt-out: rules/mcp.md is NOT injected
      // even though it lives in the `*` set with `injectIf:
      // ctx.flags?.mcpEnabled === true`.
      expect(paths).not.toContain("rules/mcp.md");
    });
  });

  describe("loadPolicyBlocks", () => {
    it("skips refs whose file is missing", () => {
      const blocks = loadPolicyBlocks({
        contextDir,
        processKey: "routine.hourly_check",
      });
      expect(blocks).toEqual([]);
    });

    it("reads files that exist", () => {
      writeFileSync(
        join(contextDir, "rules", "redaction.md"),
        "# Redaction\n\nPatterns",
      );
      writeFileSync(
        join(contextDir, "routines", "hourly.md"),
        "# Hourly\n\nChecks",
      );
      const blocks = loadPolicyBlocks({
        contextDir,
        processKey: "routine.hourly_check",
      });
      const labels = blocks.map((b) => b.label);
      expect(labels).toContain("Redaction patterns");
      expect(labels).toContain("Hourly checks");
    });

    it("always loads journal-export rules for morning routine when the file exists", () => {
      writeFileSync(
        join(contextDir, "rules", "journal-format.md"),
        "format spec",
      );
      writeFileSync(
        join(contextDir, "rules", "journal-export.md"),
        "export rules",
      );
      writeFileSync(
        join(contextDir, "routines", "morning.md"),
        "morning checks",
      );

      const off = loadPolicyBlocks({
        contextDir,
        processKey: "routine.morning_routine",
      });
      expect(off.some((b) => b.path === "rules/journal-export.md")).toBe(true);
      expect(off.some((b) => b.path === "rules/journal-format.md")).toBe(true);
    });

    it("supports a custom reader override", () => {
      const blocks = loadPolicyBlocks({
        contextDir,
        processKey: "routine.hourly_check",
        readFile: () => "synthetic content",
      });
      expect(blocks.length).toBeGreaterThan(0);
      expect(blocks.every((b) => b.content === "synthetic content")).toBe(true);
    });

    it("swallows reader failures and skips the ref", () => {
      const blocks = loadPolicyBlocks({
        contextDir,
        processKey: "routine.hourly_check",
        readFile: () => {
          throw new Error("io failure");
        },
      });
      expect(blocks).toEqual([]);
    });

    it("skips individual files that exceed the per-file byte cap", () => {
      const oversize = "x".repeat(40 * 1024);
      const blocks = loadPolicyBlocks({
        contextDir,
        processKey: "routine.hourly_check",
        readFile: () => oversize,
      });
      expect(blocks).toEqual([]);
    });

    it("stops iterating once the total cap is exhausted", () => {
      // Morning routine resolves 5 refs (global redaction/mcp + specific
      // morning/journal-format/journal-export — management.md is owned by
      // ContextBuilder and not in this registry). Each file is just under
      // the per-file cap so the total cap (128KB) is what stops iteration,
      // not the per-file.
      const content = "x".repeat(31 * 1024);
      const blocks = loadPolicyBlocks({
        contextDir,
        processKey: "routine.morning_routine",
        flags: { mcpEnabled: true },
        readFile: () => content,
      });
      // 4 files of 31KB = 124KB fits under the 128KB cap; the 5th ref
      // would push past and is skipped.
      expect(blocks).toHaveLength(4);
      const totalSize = blocks.reduce(
        (n, b) => n + Buffer.byteLength(b.content, "utf-8"),
        0,
      );
      expect(totalSize).toBeLessThanOrEqual(128 * 1024);
    });
  });

  describe("renderPolicyBlocks", () => {
    it("returns empty string for no blocks", () => {
      expect(renderPolicyBlocks([])).toBe("");
    });

    it("wraps each block in a heading with its path", () => {
      const rendered = renderPolicyBlocks([
        { label: "One", path: "rules/one.md", content: "A" },
        { label: "Two", path: "rules/two.md", content: "B\n" },
      ]);
      expect(rendered).toContain("## Vault policy files");
      expect(rendered).toContain("### One (`rules/one.md`)");
      expect(rendered).toContain("### Two (`rules/two.md`)");
      expect(rendered).toContain("A");
      expect(rendered).toContain("B");
    });
  });

  describe("appendPolicyBlocks", () => {
    it("returns the base prompt unchanged when no blocks load", () => {
      const prompt = "base prompt";
      const result = appendPolicyBlocks(prompt, {
        contextDir,
        processKey: "routine.hourly_check",
      });
      expect(result).toBe(prompt);
    });

    it("appends rendered blocks to the prompt", () => {
      writeFileSync(
        join(contextDir, "rules", "redaction.md"),
        "redaction body",
      );
      const result = appendPolicyBlocks("base prompt", {
        contextDir,
        processKey: "message.received.dm",
      });
      expect(result.startsWith("base prompt")).toBe(true);
      expect(result).toContain("Redaction patterns");
      expect(result).toContain("redaction body");
    });
  });
});
