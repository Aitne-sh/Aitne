import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  getTaskFlow,
  initTaskFlows,
  listTaskFlows,
  readTaskFlowSources,
  resetTaskFlowsForTest,
} from "./prompts.js";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(TEST_DIR, "..", "..", "..", "..");

describe("task-flow override layer (P5)", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "pa-task-flows-"));
    resetTaskFlowsForTest();
    initTaskFlows(REPO_ROOT, dataDir);
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
    resetTaskFlowsForTest();
  });

  function writeOverride(key: string, body: string): void {
    const overrideDir = join(dataDir, "task-flows");
    mkdirSync(overrideDir, { recursive: true });
    writeFileSync(join(overrideDir, `${key}.md`), body, "utf-8");
  }

  it("returns the bundled flow when no override file is present", () => {
    const flow = getTaskFlow("git.merge_to_default");
    // Bundled file ships and is non-empty.
    expect(flow.length).toBeGreaterThan(0);
    expect(flow).not.toContain("USER-OVERRIDE-MARKER");
  });

  it("user override at <dataDir>/task-flows/<key>.md wins over the bundled file", () => {
    writeOverride(
      "git.merge_to_default",
      "# USER-OVERRIDE-MARKER\nDo nothing — silenced by the user.",
    );
    const flow = getTaskFlow("git.merge_to_default");
    expect(flow).toContain("USER-OVERRIDE-MARKER");
    expect(flow).toContain("silenced by the user");
  });

  it("user override is read fresh on every call so dashboard edits propagate without restart", () => {
    writeOverride("git.tag.created", "first");
    expect(getTaskFlow("git.tag.created")).toBe("first");
    writeOverride("git.tag.created", "second");
    expect(getTaskFlow("git.tag.created")).toBe("second");
  });

  it("removing an override falls back to the bundled file on the next call", () => {
    writeOverride("git.tag.created", "USER-OVERRIDE-MARKER");
    expect(getTaskFlow("git.tag.created")).toBe("USER-OVERRIDE-MARKER");
    rmSync(join(dataDir, "task-flows", "git.tag.created.md"));
    const flow = getTaskFlow("git.tag.created");
    expect(flow.length).toBeGreaterThan(0);
    expect(flow).not.toContain("USER-OVERRIDE-MARKER");
  });

  it("variant filenames respect the same user-override layer", () => {
    // The Claude delegated variant for hourly_check is a real bundled file.
    writeOverride(
      "routine.hourly_check.delegated.claude",
      "# USER-OVERRIDE-MARKER\nClaude delegated override",
    );
    // Pass `claude` + a `gmail: delegated` integration state so the variant
    // resolver picks `routine.hourly_check.delegated.claude.md`.
    const flow = getTaskFlow("routine.hourly_check", "claude", {
      gmail: {
        mode: "delegated",
        delegatedBackend: "claude",
        delegatedModel: null,
        deniedTools: [],
        lastChangedAt: "2026-05-01T00:00:00.000Z",
      },
    });
    expect(flow).toContain("USER-OVERRIDE-MARKER");
  });

  it("listTaskFlows surfaces hasOverride true only when the user file exists", () => {
    writeOverride("git.merge_to_default", "user copy");
    const flows = listTaskFlows();
    const merge = flows.find((f) => f.key === "git.merge_to_default");
    const tag = flows.find((f) => f.key === "git.tag.created");
    expect(merge?.hasOverride).toBe(true);
    expect(merge?.hasBundled).toBe(true);
    expect(tag?.hasOverride).toBe(false);
    expect(tag?.hasBundled).toBe(true);
  });

  it("readTaskFlowSources returns both bodies side-by-side", () => {
    writeOverride("git.merge_to_default", "user copy");
    const sources = readTaskFlowSources("git.merge_to_default");
    expect(sources.override).toBe("user copy");
    expect(sources.bundled?.length).toBeGreaterThan(0);
  });

  it("readTaskFlowSources returns null/null for unknown keys", () => {
    const sources = readTaskFlowSources("nonexistent.key");
    expect(sources.override).toBeNull();
    expect(sources.bundled).toBeNull();
  });

  it("ignores user override files placed in subdirectories — only top-level *.md counts", () => {
    const sub = join(dataDir, "task-flows", "subdir");
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, "git.merge_to_default.md"), "shadow", "utf-8");
    const flow = getTaskFlow("git.merge_to_default");
    expect(flow).not.toBe("shadow");
  });
});

// docs/design/appendices/routine-data-acquisition.md Phase 1 / F0 — partial-include
// directive `{include:_partials/<name>.md}` resolution.
describe("task-flow {include:_partials/...} directive (F0)", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "pa-task-flow-partials-"));
    resetTaskFlowsForTest();
    initTaskFlows(REPO_ROOT, dataDir);
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
    resetTaskFlowsForTest();
  });

  function writeOverride(key: string, body: string): void {
    const overrideDir = join(dataDir, "task-flows");
    mkdirSync(overrideDir, { recursive: true });
    writeFileSync(join(overrideDir, `${key}.md`), body, "utf-8");
  }

  function writeUserPartial(name: string, body: string): void {
    const partialsDir = join(dataDir, "task-flows", "_partials");
    mkdirSync(partialsDir, { recursive: true });
    writeFileSync(join(partialsDir, name), body, "utf-8");
  }

  it("inlines the partial body verbatim into the host flow", () => {
    writeUserPartial("hello.md", "PARTIAL-MARKER body\n");
    writeOverride(
      "git.tag.created",
      "Step 1.\n{include:_partials/hello.md}\nStep 2.",
    );
    const flow = getTaskFlow("git.tag.created");
    expect(flow).toContain("Step 1.");
    expect(flow).toContain("PARTIAL-MARKER body");
    expect(flow).toContain("Step 2.");
    expect(flow).not.toContain("{include:_partials/");
  });

  it("strips a leading YAML frontmatter block from the partial body", () => {
    writeUserPartial(
      "with-frontmatter.md",
      "---\nname: test\ndescription: test\n---\nVISIBLE body\n",
    );
    writeOverride(
      "git.tag.created",
      "before\n{include:_partials/with-frontmatter.md}\nafter",
    );
    const flow = getTaskFlow("git.tag.created");
    expect(flow).toContain("VISIBLE body");
    expect(flow).not.toContain("name: test");
    expect(flow).not.toContain("description: test");
    expect(flow).not.toContain("---\n");
  });

  it("collapses references to missing partials to the empty string", () => {
    writeOverride(
      "git.tag.created",
      "before\n{include:_partials/does-not-exist.md}\nafter",
    );
    const flow = getTaskFlow("git.tag.created");
    expect(flow).toContain("before");
    expect(flow).toContain("after");
    expect(flow).not.toContain("{include:_partials/");
    expect(flow).not.toContain("does-not-exist");
  });

  it("depth cap = 1 — an include nested inside a partial is left verbatim (no recursion)", () => {
    writeUserPartial(
      "outer.md",
      "OUTER start\n{include:_partials/inner.md}\nOUTER end\n",
    );
    writeUserPartial("inner.md", "INNER body\n");
    writeOverride("git.tag.created", "{include:_partials/outer.md}");
    const flow = getTaskFlow("git.tag.created");
    expect(flow).toContain("OUTER start");
    expect(flow).toContain("OUTER end");
    // Inner directive survives verbatim — visible failure signals the cycle
    // to the author / lint rather than expanding silently.
    expect(flow).toContain("{include:_partials/inner.md}");
    expect(flow).not.toContain("INNER body");
  });

  it("does not match directives that traverse out of _partials/", () => {
    writeOverride(
      "git.tag.created",
      "leak: {include:_partials/../escape.md} :leak",
    );
    const flow = getTaskFlow("git.tag.created");
    // Bad directive is not a match; the raw token stays in the body so
    // the failure is visible to the author and the lint pass.
    expect(flow).toContain("{include:_partials/../escape.md}");
  });

  it("runs BEFORE applyIntegrationModeFilter so partial-carried mode blocks filter correctly", () => {
    writeUserPartial(
      "gate.md",
      [
        "<!-- mode:direct:gmail -->",
        "DIRECT-BRANCH",
        "<!-- /mode:direct:gmail -->",
        "<!-- mode:delegated:gmail -->",
        "DELEGATED-BRANCH",
        "<!-- /mode:delegated:gmail -->",
      ].join("\n"),
    );
    writeOverride(
      "git.tag.created",
      "{context}\n{include:_partials/gate.md}\n",
    );
    const ts = "2026-05-11T00:00:00.000Z";
    const direct = getTaskFlow("git.tag.created", "claude", {
      gmail: {
        mode: "direct",
        delegatedBackend: null,
        deniedTools: [],
        lastChangedAt: ts,
      },
    });
    expect(direct).toContain("DIRECT-BRANCH");
    expect(direct).not.toContain("DELEGATED-BRANCH");

    const delegated = getTaskFlow("git.tag.created", "claude", {
      gmail: {
        mode: "delegated",
        delegatedBackend: "codex",
        deniedTools: [],
        lastChangedAt: ts,
      },
    });
    expect(delegated).toContain("DELEGATED-BRANCH");
    expect(delegated).not.toContain("DIRECT-BRANCH");
  });

  it("the user-override layer applies to partials too (override wins over bundled)", () => {
    // No bundled partial exists yet (Phase 1 ships the directive only),
    // so this case verifies the override-wins contract with an
    // override-only file. When Phase 2 lands the bundled partials, the
    // same contract keeps holding because `readPartialFile` checks the
    // user dir first.
    writeUserPartial("scope.md", "OVERRIDE-PARTIAL\n");
    writeOverride("git.tag.created", "{include:_partials/scope.md}");
    expect(getTaskFlow("git.tag.created")).toContain("OVERRIDE-PARTIAL");
  });
});
