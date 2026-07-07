import { describe, it, expect } from "vitest";
import {
  compileGlob,
  evaluateTriggers,
  EVENT_PATH_EXTRACTORS,
  matchAnyGlob,
  matchesFilters,
  matchGlob,
} from "./trigger-evaluator.js";
import type { RepositoryTriggerDTO } from "../db/repositories-store.js";

const baseTrigger: RepositoryTriggerDTO = {
  id: "trg_a",
  repositoryId: "github:a/b",
  name: "test",
  enabled: true,
  eventType: "git.push.detected",
  filters: {},
  backend: "claude",
  model: "sonnet",
  workdirMode: "local-clone",
  prompt: "p",
  instructionMd: null,
  lastFiredAt: null,
  fireCount: 0,
  createdAt: 0,
  updatedAt: 0,
};

describe("trigger-evaluator: glob matcher", () => {
  describe("compileGlob / matchGlob basics", () => {
    it("matches plain segments", () => {
      expect(matchGlob("README.md", "README.md")).toBe(true);
      expect(matchGlob("README.md", "src/README.md")).toBe(false);
    });

    it("matches single * within a segment", () => {
      expect(matchGlob("*.md", "README.md")).toBe(true);
      expect(matchGlob("*.md", "src/README.md")).toBe(false);
    });

    it("matches ** across many segments", () => {
      expect(matchGlob("**/README.md", "README.md")).toBe(true);
      expect(matchGlob("**/README.md", "a/README.md")).toBe(true);
      expect(matchGlob("**/README.md", "a/b/c/README.md")).toBe(true);
      expect(matchGlob("packages/**", "packages/daemon/src/x.ts")).toBe(true);
      expect(matchGlob("packages/**", "tools/x.ts")).toBe(false);
    });

    it("? matches single non-slash char", () => {
      expect(matchGlob("?.md", "a.md")).toBe(true);
      expect(matchGlob("?.md", "/a.md")).toBe(false);
      expect(matchGlob("?.md", "ab.md")).toBe(false);
    });

    it("character classes", () => {
      expect(matchGlob("[abc].md", "a.md")).toBe(true);
      expect(matchGlob("[abc].md", "d.md")).toBe(false);
      expect(matchGlob("[!abc].md", "d.md")).toBe(true);
      expect(matchGlob("[!abc].md", "a.md")).toBe(false);
      expect(matchGlob("[^abc].md", "d.md")).toBe(true);
    });

    it("alternation with braces", () => {
      expect(matchGlob("{foo,bar}.md", "foo.md")).toBe(true);
      expect(matchGlob("{foo,bar}.md", "bar.md")).toBe(true);
      expect(matchGlob("{foo,bar}.md", "baz.md")).toBe(false);
    });

    it("escapes regex metacharacters in literal segments", () => {
      expect(matchGlob("a.b+c", "a.b+c")).toBe(true);
      expect(matchGlob("a.b+c", "axb+c")).toBe(false);
      expect(matchGlob("(grouped)", "(grouped)")).toBe(true);
    });

    it("treats unmatched [ as literal", () => {
      const re = compileGlob("[unterminated");
      expect(re.test("[unterminated")).toBe(true);
    });

    it("treats orphan } as literal", () => {
      expect(matchGlob("a}b", "a}b")).toBe(true);
    });

    it("tolerates unterminated brace by treating as literal close", () => {
      // `{a,b` has no `}` — we still emit a closing group at end so the
      // pattern compiles. Behaviour: `a` or `b` must be the suffix.
      const re = compileGlob("{a,b");
      expect(re.test("a")).toBe(true);
      expect(re.test("b")).toBe(true);
      expect(re.test("c")).toBe(false);
    });
  });

  describe("matchAnyGlob", () => {
    it("OR-matches across patterns", () => {
      expect(
        matchAnyGlob(["packages/**", "docs/**"], ["docs/x.md"]),
      ).toBe(true);
      expect(matchAnyGlob(["packages/**"], ["docs/x.md"])).toBe(false);
    });

    it("OR-matches across paths", () => {
      expect(matchAnyGlob("**.md", ["README.md", "src/main.ts"])).toBe(true);
      expect(matchAnyGlob("**.md", ["src/main.ts"])).toBe(false);
    });

    it("accepts a string pattern as well as an array", () => {
      expect(matchAnyGlob("packages/**", ["packages/x.ts"])).toBe(true);
    });
  });
});

describe("trigger-evaluator: filter matching", () => {
  it("matches when no filters defined", () => {
    expect(matchesFilters({}, "git.push.detected", {})).toBe(true);
  });

  it("matches scalar branch filter", () => {
    expect(
      matchesFilters({ branch: "main" }, "git.push.detected", {
        branch: "main",
      }),
    ).toBe(true);
    expect(
      matchesFilters({ branch: "main" }, "git.push.detected", {
        branch: "feature/x",
      }),
    ).toBe(false);
  });

  it("AND-matches multiple scalar filters", () => {
    expect(
      matchesFilters(
        { branch: "main", actor: "test-owner" },
        "git.push.detected",
        { branch: "main", actor: "test-owner" },
      ),
    ).toBe(true);
    expect(
      matchesFilters(
        { branch: "main", actor: "test-owner" },
        "git.push.detected",
        { branch: "main", actor: "someone-else" },
      ),
    ).toBe(false);
  });

  it("treats numbers and string-as-number as equal", () => {
    expect(
      matchesFilters({ count: 3 }, "git.push.detected", { count: "3" }),
    ).toBe(true);
  });

  it("path_pattern: matches push commits' changed files", () => {
    expect(
      matchesFilters(
        { path_pattern: "packages/**" },
        "git.push.detected",
        {
          commits: [
            { added: ["packages/daemon/src/x.ts"], modified: [], removed: [] },
            { added: [], modified: ["docs/y.md"], removed: [] },
          ],
        },
      ),
    ).toBe(true);
  });

  it("path_pattern: array OR-s patterns", () => {
    expect(
      matchesFilters(
        { path_pattern: ["packages/**", "docs/**"] },
        "git.push.detected",
        { commits: [{ added: [], modified: ["docs/y.md"], removed: [] }] },
      ),
    ).toBe(true);
  });

  it("path_pattern: returns false when no extractor for event type", () => {
    expect(
      matchesFilters(
        { path_pattern: "**" },
        "github.workflow_run.completed",
        {},
      ),
    ).toBe(false);
  });

  it("path_pattern: returns false when extractor returns empty list", () => {
    expect(
      matchesFilters(
        { path_pattern: "**" },
        "git.push.detected",
        { commits: [] },
      ),
    ).toBe(false);
  });

  it("path_pattern: PR with no files synthesized → no match", () => {
    expect(
      matchesFilters(
        { path_pattern: "packages/**" },
        "github.pull_request.opened",
        { action: "opened" },
      ),
    ).toBe(false);
  });

  it("path_pattern: PR with files synthesized → matches", () => {
    expect(
      matchesFilters(
        { path_pattern: "packages/**" },
        "github.pull_request.opened",
        { action: "opened", files: ["packages/daemon/src/x.ts"] },
      ),
    ).toBe(true);
  });

  it("merge_to_default: extracts from `files` then `changedFiles`", () => {
    expect(
      matchesFilters(
        { path_pattern: "packages/**" },
        "git.merge_to_default",
        { files: ["packages/daemon/src/x.ts"] },
      ),
    ).toBe(true);
    expect(
      matchesFilters(
        { path_pattern: "packages/**" },
        "git.merge_to_default",
        { changedFiles: ["packages/daemon/src/x.ts"] },
      ),
    ).toBe(true);
    expect(
      matchesFilters({ path_pattern: "**" }, "git.merge_to_default", {}),
    ).toBe(false);
  });

  it("push: falls back to changedFiles when commits is empty", () => {
    expect(
      matchesFilters(
        { path_pattern: "packages/**" },
        "git.push.detected",
        { commits: [], changedFiles: ["packages/daemon/src/x.ts"] },
      ),
    ).toBe(true);
  });

  it("push: empty commits and no changedFiles → no match", () => {
    expect(
      matchesFilters(
        { path_pattern: "packages/**" },
        "git.push.detected",
        { commits: [] },
      ),
    ).toBe(false);
  });

  it("push: AND of branch + path_pattern filters", () => {
    const matches = matchesFilters(
      { branch: "main", path_pattern: "packages/**" },
      "git.push.detected",
      {
        branch: "main",
        commits: [{ added: ["packages/x.ts"], modified: [], removed: [] }],
      },
    );
    expect(matches).toBe(true);
    const noMatchBranch = matchesFilters(
      { branch: "main", path_pattern: "packages/**" },
      "git.push.detected",
      {
        branch: "feature",
        commits: [{ added: ["packages/x.ts"], modified: [], removed: [] }],
      },
    );
    expect(noMatchBranch).toBe(false);
  });

  it("scalar nulls are equal only to nulls", () => {
    expect(
      matchesFilters({ name: null }, "x", { name: null }),
    ).toBe(true);
    expect(matchesFilters({ name: null }, "x", { name: "x" })).toBe(false);
  });

  it("number-vs-number branch is exercised both ways", () => {
    expect(matchesFilters({ count: 3 }, "x", { count: 3 })).toBe(true);
    expect(matchesFilters({ count: 3 }, "x", { count: 4 })).toBe(false);
  });

  it("path_pattern: returns false when paths don't match the pattern", () => {
    expect(
      matchesFilters(
        { path_pattern: "docs/**" },
        "git.push.detected",
        {
          commits: [
            { added: ["packages/x.ts"], modified: [], removed: [] },
          ],
        },
      ),
    ).toBe(false);
  });
});

describe("trigger-evaluator: extractor coverage", () => {
  it("commits-extractor handles non-array `commits`", () => {
    const extractor = EVENT_PATH_EXTRACTORS["git.push.detected"];
    expect(extractor({ commits: "not-an-array" })).toEqual([]);
  });

  it("commits-extractor de-dupes across added/modified/removed", () => {
    const extractor = EVENT_PATH_EXTRACTORS["git.push.detected"];
    expect(
      extractor({
        commits: [
          { added: ["a.ts"], modified: ["a.ts"], removed: [] },
          { added: [], modified: [], removed: ["a.ts"] },
        ],
      }),
    ).toEqual(["a.ts"]);
  });
});

describe("evaluateTriggers", () => {
  it("returns matching triggers in order", () => {
    const a: RepositoryTriggerDTO = {
      ...baseTrigger,
      id: "a",
      filters: { branch: "main" },
    };
    const b: RepositoryTriggerDTO = {
      ...baseTrigger,
      id: "b",
      filters: { branch: "main", path_pattern: "packages/**" },
    };
    const c: RepositoryTriggerDTO = {
      ...baseTrigger,
      id: "c",
      filters: { branch: "feature" },
    };
    const matched = evaluateTriggers([a, b, c], "git.push.detected", {
      branch: "main",
      commits: [{ added: ["packages/x.ts"], modified: [], removed: [] }],
    });
    expect(matched.map((t) => t.id)).toEqual(["a", "b"]);
  });

  it("skips disabled triggers", () => {
    const t: RepositoryTriggerDTO = { ...baseTrigger, id: "x", enabled: false };
    expect(evaluateTriggers([t], "git.push.detected", {})).toHaveLength(0);
  });

  it("skips triggers whose eventType doesn't match", () => {
    const t: RepositoryTriggerDTO = {
      ...baseTrigger,
      id: "x",
      eventType: "github.pull_request.opened",
    };
    expect(evaluateTriggers([t], "git.push.detected", {})).toHaveLength(0);
  });

  it("isolates a trigger whose stored glob throws at compile time", () => {
    // Rows created before the write-time compile gate (or edited
    // out-of-band) can carry a glob whose RegExp construction throws.
    // The bad trigger must read as "no match" without aborting its
    // siblings' evaluation.
    const bad: RepositoryTriggerDTO = {
      ...baseTrigger,
      id: "bad",
      filters: { path_pattern: "[a\\]" },
    };
    const good: RepositoryTriggerDTO = {
      ...baseTrigger,
      id: "good",
      filters: { branch: "main" },
    };
    const matched = evaluateTriggers([bad, good], "git.push.detected", {
      branch: "main",
      commits: [{ added: ["packages/x.ts"], modified: [], removed: [] }],
    });
    expect(matched.map((t) => t.id)).toEqual(["good"]);
  });
});
