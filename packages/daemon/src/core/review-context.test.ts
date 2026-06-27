import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendReviewContextBlocks,
  loadReviewContextBlocks,
  parseContextIndexRows,
  renderReviewContextBlocks,
  resolveReviewFlow,
  type ReviewContextFlags,
} from "./review-context.js";
import { createPromptInjectionBudget } from "./policy-files.js";

const BOTH_FLAGS_ON: ReviewContextFlags = {
  useReviewDossiers: true,
  useContextIndex: true,
};

describe("review-context", () => {
  let tmp: string;
  let contextDir: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "review-context-"));
    contextDir = join(tmp, "context");
    mkdirSync(join(contextDir, "knowledge", "dossiers"), { recursive: true });
    mkdirSync(join(contextDir, "plans", "projects"), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("maps routine ProcessKeys to the expected dossier flow", () => {
    expect(resolveReviewFlow("routine.activity_scan")?.flow).toBe("activity-scan");
    // `routine.morning_routine_initial` retired by Phase 7 (2026-05-16);
    // the first-run branch resolves through `routine.morning_routine_today`
    // (Stage A) which inherits the morning dossier.
    expect(resolveReviewFlow("routine.morning_routine_initial")).toBeNull();
    // morning-routine-optimization.md Phase 5 — Stage A inherits the
    // morning dossier so the task-flow's "Vault review context" prose
    // resolves. Stage B is deliberately unmapped per design.
    expect(resolveReviewFlow("routine.morning_routine_today")?.flow).toBe(
      "morning",
    );
    expect(resolveReviewFlow("routine.morning_routine_journal")).toBeNull();
    expect(resolveReviewFlow("routine.roadmap_refresh")?.dossierPath).toBe(
      "knowledge/dossiers/roadmap.md",
    );
    expect(resolveReviewFlow("message.received.dm")).toBeNull();
  });

  it("parses the Context Index table schema", () => {
    const rows = parseContextIndexRows([
      "# Context Index",
      "",
      "| Path | Purpose | Review flows | Last touched |",
      "|---|---|---|---|",
      "| `plans/projects/foo.md` | Foo state | hourly, weekly | 2026-04-21 |",
      "| `knowledge/dossiers/activity-scan.md` | Hourly state | hourly | 2026-04-21 |",
    ].join("\n"));

    expect(rows).toEqual([
      {
        path: "plans/projects/foo.md",
        purpose: "Foo state",
        reviewFlows: "hourly, weekly",
        lastTouched: "2026-04-21",
      },
      {
        path: "knowledge/dossiers/activity-scan.md",
        purpose: "Hourly state",
        reviewFlows: "hourly",
        lastTouched: "2026-04-21",
      },
    ]);
  });

  it("loads context-index, matching indexed files, and the per-flow dossier", () => {
    writeFileSync(
      join(contextDir, "_index.md"),
      [
        "# Context Index",
        "",
        "| Path | Purpose | Review flows | Last touched |",
        "|---|---|---|---|",
        "| `plans/projects/foo.md` | Foo project | hourly, weekly | 2026-04-21 |",
        "| `plans/projects/monthly.md` | Monthly only | monthly | 2026-04-21 |",
        "| `knowledge/dossiers/activity-scan.md` | Hourly state | hourly | 2026-04-21 |",
      ].join("\n"),
    );
    writeFileSync(join(contextDir, "plans", "projects","foo.md"), "# Foo\n");
    writeFileSync(join(contextDir, "plans", "projects","monthly.md"), "# Monthly\n");
    writeFileSync(
      join(contextDir, "knowledge", "dossiers","activity-scan.md"),
      "# Hourly Dossier\n",
    );

    const blocks = loadReviewContextBlocks({
      contextDir,
      processKey: "routine.activity_scan",
      flags: BOTH_FLAGS_ON,
    });

    expect(blocks.map((block) => block.path)).toEqual([
      "_index.md",
      "plans/projects/foo.md",
      "knowledge/dossiers/activity-scan.md",
    ]);

    // The legacy "hourly" token matches ONLY the activity-scan flow — a row
    // tagged with it must not leak into other flows' review context.
    const eveningBlocks = loadReviewContextBlocks({
      contextDir,
      processKey: "routine.evening_review",
      flags: BOTH_FLAGS_ON,
    });
    expect(eveningBlocks.map((block) => block.path)).not.toContain(
      "plans/projects/foo.md",
    );
  });

  it("matches an index row whose flow token equals the queried flow exactly", () => {
    // Direct token match (not "all", not the legacy "hourly" alias): a row
    // tagged plainly with "weekly" must surface for the weekly_review flow.
    writeFileSync(
      join(contextDir, "_index.md"),
      [
        "# Context Index",
        "",
        "| Path | Purpose | Review flows | Last touched |",
        "|---|---|---|---|",
        "| `plans/projects/weekly-only.md` | Weekly state | weekly | 2026-04-21 |",
      ].join("\n"),
    );
    writeFileSync(
      join(contextDir, "plans", "projects", "weekly-only.md"),
      "# Weekly\n",
    );

    const blocks = loadReviewContextBlocks({
      contextDir,
      processKey: "routine.weekly_review",
      flags: BOTH_FLAGS_ON,
    });

    expect(blocks.map((block) => block.path)).toContain(
      "plans/projects/weekly-only.md",
    );
  });

  it("renders the dossier in a dedicated XML-style block", () => {
    writeFileSync(join(contextDir, "_index.md"), "# Context Index\n");
    writeFileSync(
      join(contextDir, "knowledge", "dossiers","weekly.md"),
      "# Weekly Dossier\n\n## Open items\n- carry this\n",
    );

    const rendered = appendReviewContextBlocks("base", {
      contextDir,
      processKey: "routine.weekly_review",
      flags: BOTH_FLAGS_ON,
    });

    expect(rendered).toContain("## Vault review context");
    expect(rendered).toContain('<dossier flow="weekly" path="knowledge/dossiers/weekly.md">');
    expect(rendered).toContain("carry this");
    expect(rendered).toContain("</dossier>");
  });

  it("skips the dossier when useReviewDossiers=false", () => {
    writeFileSync(
      join(contextDir, "knowledge", "dossiers","weekly.md"),
      "# Weekly Dossier\n",
    );

    const blocks = loadReviewContextBlocks({
      contextDir,
      processKey: "routine.weekly_review",
      flags: { useReviewDossiers: false, useContextIndex: false },
    });

    expect(blocks).toEqual([]);
  });

  it("skips context-index loading when useContextIndex=false (Phase 2 gate)", () => {
    writeFileSync(
      join(contextDir, "_index.md"),
      [
        "# Context Index",
        "",
        "| Path | Purpose | Review flows | Last touched |",
        "|---|---|---|---|",
        "| `plans/projects/foo.md` | Foo project | hourly | 2026-04-21 |",
      ].join("\n"),
    );
    writeFileSync(join(contextDir, "plans", "projects","foo.md"), "# Foo\n");
    writeFileSync(
      join(contextDir, "knowledge", "dossiers","activity-scan.md"),
      "# Hourly Dossier\n",
    );

    const blocks = loadReviewContextBlocks({
      contextDir,
      processKey: "routine.activity_scan",
      flags: { useReviewDossiers: true, useContextIndex: false },
    });

    expect(blocks.map((b) => b.kind)).toEqual(["dossier"]);
    expect(blocks[0].path).toBe("knowledge/dossiers/activity-scan.md");
  });

  it("honors the shared prompt-injection budget threaded from the caller", () => {
    writeFileSync(
      join(contextDir, "_index.md"),
      [
        "# Context Index",
        "",
        "| Path | Purpose | Review flows | Last touched |",
        "|---|---|---|---|",
        "| `plans/projects/foo.md` | Foo | hourly | 2026-04-21 |",
      ].join("\n"),
    );
    writeFileSync(join(contextDir, "plans", "projects","foo.md"), "# Foo\n");
    writeFileSync(
      join(contextDir, "knowledge", "dossiers","activity-scan.md"),
      "# Hourly\n",
    );

    // Simulate the policy injector having already consumed the entire budget
    // so review-context can admit nothing. This pins the invariant that a
    // single aggregate cap covers both injectors.
    const budget = createPromptInjectionBudget();
    budget.usedBytes = budget.maxBytes;

    const blocks = loadReviewContextBlocks({
      contextDir,
      processKey: "routine.activity_scan",
      flags: BOTH_FLAGS_ON,
      budget,
    });

    expect(blocks).toEqual([]);
    expect(budget.usedBytes).toBe(budget.maxBytes);
  });

  it("accounts review-context usage against the shared budget", () => {
    writeFileSync(
      join(contextDir, "knowledge", "dossiers","activity-scan.md"),
      "# Hourly\n",
    );

    const budget = createPromptInjectionBudget();
    const initial = budget.usedBytes;

    loadReviewContextBlocks({
      contextDir,
      processKey: "routine.activity_scan",
      flags: { useReviewDossiers: true, useContextIndex: false },
      budget,
    });

    expect(budget.usedBytes).toBeGreaterThan(initial);
  });
});

describe("parseContextIndexRows — header / separator edge cases", () => {
  it("skips a header that is missing required columns", () => {
    const rows = parseContextIndexRows([
      "| Path | Purpose |",
      "|---|---|",
      "| plans/projects/foo.md | Foo |",
    ].join("\n"));
    expect(rows).toEqual([]);
  });

  it("skips a table whose separator row is missing or malformed", () => {
    const rows = parseContextIndexRows([
      "| Path | Purpose | Review flows | Last touched |",
      "| not-a-separator | x | y | z |",
      "| plans/projects/foo.md | Foo | hourly | 2026-04-21 |",
    ].join("\n"));
    expect(rows).toEqual([]);
  });

  it("skips rows whose path cell is empty / unparseable", () => {
    const rows = parseContextIndexRows([
      "| Path | Purpose | Review flows | Last touched |",
      "|---|---|---|---|",
      "|  | empty path | hourly | 2026-04-21 |",
      "| plans/projects/ok.md | ok | hourly | 2026-04-21 |",
    ].join("\n"));
    expect(rows.map((r) => r.path)).toEqual(["plans/projects/ok.md"]);
  });

  it("breaks at the first non-table line", () => {
    const rows = parseContextIndexRows([
      "| Path | Purpose | Review flows | Last touched |",
      "|---|---|---|---|",
      "| plans/projects/a.md | A | hourly | 2026-04-21 |",
      "",
      "| plans/projects/b.md | B | hourly | 2026-04-21 |",
    ].join("\n"));
    expect(rows.map((r) => r.path)).toEqual(["plans/projects/a.md"]);
  });

  it("treats a header line with no separator below it as no table (lines[i+1] ?? \"\" branch)", () => {
    // The context index ends right after the header line. `lines[i + 1]
    // ?? ""` falls back to "" which fails the separator regex — no rows.
    const rows = parseContextIndexRows(
      "| Path | Purpose | Review flows | Last touched |",
    );
    expect(rows).toEqual([]);
  });

  it("tolerates rows shorter than the header by treating absent cells as empty", () => {
    // A user-truncated row with only 2 cells of 4 column slots: the
    // missing cells default to "" via the `cells[idx] ?? ""` fallback.
    // splitMarkdownTableRow returns the trimmed-off-pipe array literally
    // so a row written as `| a | b |` has 2 cells.
    const rows = parseContextIndexRows([
      "| Path | Purpose | Review flows | Last touched |",
      "|---|---|---|---|",
      "| plans/projects/short.md | shortRow |",
    ].join("\n"));
    expect(rows).toEqual([
      {
        path: "plans/projects/short.md",
        purpose: "shortRow",
        reviewFlows: "",
        lastTouched: "",
      },
    ]);
  });

  it("handles a row containing only the path column (purpose `?? \"\"` branch)", () => {
    // Single-cell row exercises the `cells[purposeIdx] ?? ""` fallback —
    // cells.length === 1 means cells[1..3] are all undefined.
    const rows = parseContextIndexRows([
      "| Path | Purpose | Review flows | Last touched |",
      "|---|---|---|---|",
      "| plans/projects/single.md |",
    ].join("\n"));
    expect(rows).toEqual([
      {
        path: "plans/projects/single.md",
        purpose: "",
        reviewFlows: "",
        lastTouched: "",
      },
    ]);
  });
});

describe("parseContextIndexRows — V15 reconciler-section preference", () => {
  // CONTEXT_VAULT_REDESIGN_PLAN.md V15: the root `_index.md` carries
  // both user-curated prose AND a daemon-owned reconciler block. When
  // both contain a Files table, the block is authoritative — anything
  // in the outer (user-curated) table is treated as stale prose that
  // the user may have left from a pre-V15 hand-curated index. This
  // protects the review-context loader and the reconciler's diff input
  // from picking up zombie rows.
  it("returns only the reconciler-block rows when both outer and inner tables exist", () => {
    const content = [
      "---",
      "type: index",
      "owner: shared",
      "updated: 2026-04-17",
      "---",
      "# Aitne Vault",
      "",
      "## Files",
      "",
      "| Path | Purpose | Review flows | Last touched |",
      "|---|---|---|---|",
      "| plans/projects/legacy-outer.md | stale | weekly | 2026-04-10 |",
      "",
      "<!-- reconciler-section -->",
      "## Files",
      "",
      "_Reconciled by daemon on 2026-04-21._",
      "",
      "| Path | Purpose | Review flows | Last touched |",
      "|---|---|---|---|",
      "| plans/projects/alpha.md | Project Alpha | weekly | 2026-04-21 |",
      "<!-- /reconciler-section -->",
    ].join("\n");
    const rows = parseContextIndexRows(content);
    const paths = rows.map((r) => r.path);
    expect(paths).toEqual(["plans/projects/alpha.md"]);
    expect(paths).not.toContain("plans/projects/legacy-outer.md");
  });

  it("falls back to the whole content when no reconciler-section block exists", () => {
    // Pre-V15 file shape (no markers) — parse the first table as before.
    const content = [
      "# Context Index",
      "",
      "| Path | Purpose | Review flows | Last touched |",
      "|---|---|---|---|",
      "| state/today.md | Today | hourly | 2026-04-21 |",
    ].join("\n");
    const rows = parseContextIndexRows(content);
    expect(rows.map((r) => r.path)).toEqual(["state/today.md"]);
  });

  it("returns [] for a reconciler-section block whose body has no table", () => {
    // Empty block body — no rows parseable from the inner slice.
    const content = [
      "# Aitne Vault",
      "",
      "<!-- reconciler-section -->",
      "(reconciler has not run yet)",
      "<!-- /reconciler-section -->",
    ].join("\n");
    const rows = parseContextIndexRows(content);
    expect(rows).toEqual([]);
  });
});

describe("renderReviewContextBlocks", () => {
  it("returns empty string when the processKey has no review flow", () => {
    // Covers the `!flowConfig` truthy branch on line 238.
    expect(
      renderReviewContextBlocks("message.received.dm", [
        {
          kind: "context-index",
          label: "Context index",
          path: "_index.md",
          content: "anything",
        },
      ]),
    ).toBe("");
  });

  it("returns empty string when blocks is empty", () => {
    // Covers the `blocks.length === 0` truthy branch on line 238 with a
    // valid flowConfig — distinct from the no-flow case above.
    expect(
      renderReviewContextBlocks("routine.activity_scan", []),
    ).toBe("");
  });
});

describe("appendReviewContextBlocks", () => {
  let tmp: string;
  let contextDir: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "review-append-"));
    contextDir = join(tmp, "context");
    mkdirSync(join(contextDir, "knowledge", "dossiers"), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns basePrompt unchanged when no rendered review block exists", () => {
    // No context-index, no dossier on disk -> loadReviewContextBlocks
    // returns [] -> renderReviewContextBlocks returns "" -> the
    // `if (!rendered) return basePrompt;` branch fires (line 276).
    const result = appendReviewContextBlocks("base prompt", {
      contextDir,
      processKey: "routine.activity_scan",
      flags: BOTH_FLAGS_ON,
    });
    expect(result).toBe("base prompt");
  });

  it("appends the rendered block when context exists", () => {
    writeFileSync(
      join(contextDir, "knowledge", "dossiers","activity-scan.md"),
      "# Hourly dossier\n",
    );
    const result = appendReviewContextBlocks("base prompt", {
      contextDir,
      processKey: "routine.activity_scan",
      flags: BOTH_FLAGS_ON,
    });
    expect(result.startsWith("base prompt\n")).toBe(true);
    expect(result).toContain("Vault review context");
    expect(result).toContain("Hourly dossier");
  });
});

describe("loadReviewContextBlocks — file size and injection guards", () => {
  let tmp: string;
  let contextDir: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "review-context-guard-"));
    contextDir = join(tmp, "context");
    mkdirSync(join(contextDir, "knowledge", "dossiers"), { recursive: true });
    mkdirSync(join(contextDir, "plans", "projects"), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("uses injected statFile / readFile and skips non-existent rows", () => {
    const indexContent = [
      "# Context Index",
      "",
      "| Path | Purpose | Review flows | Last touched |",
      "|---|---|---|---|",
      "| plans/projects/exists.md | yes | hourly | 2026-04-21 |",
      "| plans/projects/missing.md | no | hourly | 2026-04-21 |",
    ].join("\n");
    writeFileSync(join(contextDir, "_index.md"), indexContent);

    const seen: string[] = [];
    const blocks = loadReviewContextBlocks({
      contextDir,
      processKey: "routine.activity_scan",
      flags: BOTH_FLAGS_ON,
      statFile: (p) => {
        seen.push(p);
        return p.endsWith("missing.md") ? null : { size: 12 };
      },
      readFile: (p) =>
        p.endsWith("_index.md") ? indexContent : "stub-content",
    });

    expect(blocks.find((b) => b.path === "plans/projects/exists.md")).toBeDefined();
    expect(blocks.find((b) => b.path === "plans/projects/missing.md")).toBeUndefined();
    expect(seen.some((p) => p.endsWith("exists.md"))).toBe(true);
  });

  it("skips a file whose stat reports a size above the per-file cap", () => {
    const indexContent = [
      "# Context Index",
      "",
      "| Path | Purpose | Review flows | Last touched |",
      "|---|---|---|---|",
      "| plans/projects/huge.md | huge | hourly | 2026-04-21 |",
    ].join("\n");
    writeFileSync(join(contextDir, "_index.md"), indexContent);

    const blocks = loadReviewContextBlocks({
      contextDir,
      processKey: "routine.activity_scan",
      flags: BOTH_FLAGS_ON,
      statFile: (p) =>
        p.endsWith("huge.md")
          ? { size: 10 * 1024 * 1024 }
          : { size: indexContent.length },
      readFile: (p) =>
        p.endsWith("_index.md") ? indexContent : "stub-content",
    });

    expect(blocks.find((b) => b.path === "plans/projects/huge.md")).toBeUndefined();
  });

  it("skips a file whose read content exceeds the per-block cap", () => {
    const indexContent = [
      "# Context Index",
      "",
      "| Path | Purpose | Review flows | Last touched |",
      "|---|---|---|---|",
      "| plans/projects/big.md | big | hourly | 2026-04-21 |",
    ].join("\n");
    writeFileSync(join(contextDir, "_index.md"), indexContent);

    const blocks = loadReviewContextBlocks({
      contextDir,
      processKey: "routine.activity_scan",
      flags: BOTH_FLAGS_ON,
      // statFile reports a small size so we get past the stat gate, but
      // readFile returns a huge string so the in-memory check fires.
      statFile: () => ({ size: 100 }),
      readFile: (p) =>
        p.endsWith("_index.md")
          ? indexContent
          : p.endsWith("big.md")
            ? "x".repeat(10 * 1024 * 1024)
            : "small",
    });

    expect(blocks.find((b) => b.path === "plans/projects/big.md")).toBeUndefined();
  });

  it("returns null from readReviewFile when statFile throws", () => {
    const indexContent = [
      "# Context Index",
      "",
      "| Path | Purpose | Review flows | Last touched |",
      "|---|---|---|---|",
      "| plans/projects/throws.md | throws | hourly | 2026-04-21 |",
    ].join("\n");
    writeFileSync(join(contextDir, "_index.md"), indexContent);

    const blocks = loadReviewContextBlocks({
      contextDir,
      processKey: "routine.activity_scan",
      flags: BOTH_FLAGS_ON,
      statFile: (p) => {
        if (p.endsWith("throws.md")) throw new Error("io fail");
        return { size: indexContent.length };
      },
      readFile: (p) =>
        p.endsWith("_index.md") ? indexContent : "ok",
    });

    expect(blocks.find((b) => b.path === "plans/projects/throws.md")).toBeUndefined();
  });

  it("uses real fs (existsSync + readFileSync) when no statFile/readFile is injected", () => {
    // Covers the production path through readReviewFile that the other
    // tests bypass via injection — exercises the existsSync/statSync ternary
    // (line 274) and the readFileSync fallback (line 287).
    const indexContent = [
      "# Context Index",
      "",
      "| Path | Purpose | Review flows | Last touched |",
      "|---|---|---|---|",
      "| plans/projects/real.md | real | hourly | 2026-04-21 |",
      "| plans/projects/missing-on-disk.md | missing | hourly | 2026-04-21 |",
    ].join("\n");
    writeFileSync(join(contextDir, "_index.md"), indexContent);
    writeFileSync(join(contextDir, "plans", "projects","real.md"), "real-body");

    const blocks = loadReviewContextBlocks({
      contextDir,
      processKey: "routine.activity_scan",
      flags: BOTH_FLAGS_ON,
    });

    const realBlock = blocks.find((b) => b.path === "plans/projects/real.md");
    expect(realBlock?.content).toBe("real-body");
    expect(
      blocks.find((b) => b.path === "plans/projects/missing-on-disk.md"),
    ).toBeUndefined();
  });

  it("rejects context-index rows whose path has a forbidden segment or wrong extension", () => {
    // The parent-traversal/absolute/hidden cases below get filtered earlier
    // in cleanIndexPath. This separate row goes through to
    // sanitizeContextIndexPath so the segment-blocklist (`.git`, `.obsidian`,
    // `.DS_Store`) and extension-allowlist (`.md`, `.base`) returns are
    // both exercised.
    const indexContent = [
      "# Context Index",
      "",
      "| Path | Purpose | Review flows | Last touched |",
      "|---|---|---|---|",
      "| plans/projects/.git/config.md | hidden segment | hourly | x |",
      "| plans/projects/notes.txt | wrong extension | hourly | x |",
    ].join("\n");
    writeFileSync(join(contextDir, "_index.md"), indexContent);

    const blocks = loadReviewContextBlocks({
      contextDir,
      processKey: "routine.activity_scan",
      flags: BOTH_FLAGS_ON,
      statFile: () => ({ size: indexContent.length }),
      readFile: (p) =>
        p.endsWith("_index.md") ? indexContent : "stub",
    });

    const indexedPaths = blocks
      .filter((b) => b.kind === "indexed-file")
      .map((b) => b.path);
    expect(indexedPaths).toEqual([]);
  });

  it("rejects unsafe context-index paths (parent traversal, hidden files, non-md, absolute)", () => {
    writeFileSync(
      join(contextDir, "_index.md"),
      [
        "# Context Index",
        "",
        "| Path | Purpose | Review flows | Last touched |",
        "|---|---|---|---|",
        "| `../escape.md` | parent traversal | hourly | x |",
        "| `.git/config` | hidden git | hourly | x |",
        "| `notes.txt` | wrong extension | hourly | x |",
        "| `/etc/passwd` | absolute | hourly | x |",
        "| `# heading-only` | comment-shaped | hourly | x |",
      ].join("\n"),
    );

    const blocks = loadReviewContextBlocks({
      contextDir,
      processKey: "routine.activity_scan",
      flags: BOTH_FLAGS_ON,
      statFile: () => ({ size: 100 }),
      readFile: () => "x",
    });

    // None of the unsafe rows should produce indexed-file blocks.
    const indexedPaths = blocks
      .filter((b) => b.kind === "indexed-file")
      .map((b) => b.path);
    expect(indexedPaths).toEqual([]);
  });

  it("accepts .base files and treats bare links as the link target, not the label", () => {
    const indexContent = [
      "# Context Index",
      "",
      "| Path | Purpose | Review flows | Last touched |",
      "|---|---|---|---|",
      "| [Foo](projects/foo.md) | link form | hourly | x |",
      "| `policies/baseline.base` | base form | hourly | x |",
    ].join("\n");
    writeFileSync(join(contextDir, "_index.md"), indexContent);

    const blocks = loadReviewContextBlocks({
      contextDir,
      processKey: "routine.activity_scan",
      flags: BOTH_FLAGS_ON,
      statFile: () => ({ size: 50 }),
      readFile: (p) =>
        p.endsWith("_index.md") ? indexContent : "stub",
    });

    const paths = blocks
      .filter((b) => b.kind === "indexed-file")
      .map((b) => b.path)
      .sort();
    expect(paths).toEqual(
      ["plans/projects/foo.md", "policies/baseline.base"].sort(),
    );
  });

  it("matches the `all` flow keyword regardless of routine", () => {
    const indexContent = [
      "# Context Index",
      "",
      "| Path | Purpose | Review flows | Last touched |",
      "|---|---|---|---|",
      "| plans/projects/everywhere.md | everywhere | all | x |",
    ].join("\n");
    writeFileSync(join(contextDir, "_index.md"), indexContent);

    const blocks = loadReviewContextBlocks({
      contextDir,
      processKey: "routine.weekly_review",
      flags: BOTH_FLAGS_ON,
      statFile: () => ({ size: 50 }),
      readFile: (p) =>
        p.endsWith("_index.md") ? indexContent : "stub",
    });
    expect(
      blocks.find((b) => b.path === "plans/projects/everywhere.md"),
    ).toBeDefined();
  });

  it("returns [] for a processKey with no resolved review flow", () => {
    // loadReviewContextBlocks must short-circuit when resolveReviewFlow
    // returns null (covers line 171 `if (!flowConfig) return [];`).
    expect(
      loadReviewContextBlocks({
        contextDir,
        processKey: "message.received.dm",
        flags: BOTH_FLAGS_ON,
      }),
    ).toEqual([]);
  });

  it("falls back to bare safePath when the index row's purpose is empty", () => {
    // Covers the `row.purpose || safePath` truthiness branch on line 208:
    // an empty purpose cell forces the block label to use the path.
    const indexContent = [
      "# Context Index",
      "",
      "| Path | Purpose | Review flows | Last touched |",
      "|---|---|---|---|",
      "| plans/projects/noPurpose.md |  | hourly | 2026-04-21 |",
    ].join("\n");
    writeFileSync(join(contextDir, "_index.md"), indexContent);
    writeFileSync(join(contextDir, "plans", "projects","noPurpose.md"), "body");

    const blocks = loadReviewContextBlocks({
      contextDir,
      processKey: "routine.activity_scan",
      flags: BOTH_FLAGS_ON,
    });
    const row = blocks.find((b) => b.path === "plans/projects/noPurpose.md");
    expect(row?.label).toBe("Indexed context: plans/projects/noPurpose.md");
  });

  it("skips the dossier row referenced by the index (avoids duplicate emission)", () => {
    writeFileSync(
      join(contextDir, "_index.md"),
      [
        "# Context Index",
        "",
        "| Path | Purpose | Review flows | Last touched |",
        "|---|---|---|---|",
        "| `knowledge/dossiers/activity-scan.md` | hourly state | hourly | x |",
        "| `_index.md` | self-ref | hourly | x |",
      ].join("\n"),
    );
    writeFileSync(join(contextDir, "knowledge", "dossiers","activity-scan.md"), "# H\n");

    const blocks = loadReviewContextBlocks({
      contextDir,
      processKey: "routine.activity_scan",
      flags: BOTH_FLAGS_ON,
    });
    // The dossier appears once via the dossier branch — not duplicated
    // by the index loop.
    const dossierAppearances = blocks.filter(
      (b) => b.path === "knowledge/dossiers/activity-scan.md",
    );
    expect(dossierAppearances).toHaveLength(1);
    expect(dossierAppearances[0].kind).toBe("dossier");
  });
});
