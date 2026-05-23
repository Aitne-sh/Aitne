import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  extractKeywordsFromFile,
  loadProjectKeywords,
  matchClustersToProject,
} from "./project-matcher.js";
import type { ClusterSnapshot } from "./weekly-interests-summary.js";

function makeCluster(
  overrides: Partial<ClusterSnapshot> & { slug: string },
): ClusterSnapshot {
  return {
    slug: overrides.slug,
    displayName: overrides.displayName ?? overrides.slug,
    daysActive: overrides.daysActive ?? 3,
    meaningfulVisits: overrides.meaningfulVisits ?? 12,
    meaningfulForegroundSec: overrides.meaningfulForegroundSec ?? 3600,
    distinctMeaningfulDomains: overrides.distinctMeaningfulDomains ?? 4,
    topDomains: overrides.topDomains ?? [],
    status: overrides.status ?? "active",
    statusChange: overrides.statusChange ?? "new",
    clusterJournalPath:
      overrides.clusterJournalPath ?? `research/${overrides.slug}.md`,
    hasOpenOffer: overrides.hasOpenOffer ?? false,
    hasAcceptedResearch: overrides.hasAcceptedResearch ?? false,
    hasWikiSummary: overrides.hasWikiSummary ?? false,
    lastActivityDate: overrides.lastActivityDate ?? "2026-05-21",
    lastActivityMs: overrides.lastActivityMs ?? 0,
  };
}

describe("extractKeywordsFromFile", () => {
  it("returns the explicit override when aitne_project_keywords is set", () => {
    const content = [
      "---",
      "aitne_project_keywords: [aitne, agent, daemon]",
      "---",
      "# Project",
    ].join("\n");
    const out = extractKeywordsFromFile(
      "aitne.md",
      content,
      "/p/aitne.md",
    )!;
    expect(out.source).toBe("explicit");
    expect([...out.keywords].sort()).toEqual(["aitne", "agent", "daemon"].sort());
  });

  it("falls back to aliases + tags + filename when no explicit override", () => {
    const content = [
      "---",
      "aliases: [research, observation]",
      "tags: [notes]",
      "---",
      "# rag-experiment",
    ].join("\n");
    const out = extractKeywordsFromFile(
      "rag-experiment.md",
      content,
      "/p/rag-experiment.md",
    )!;
    expect(out.source).toBe("frontmatter");
    expect([...out.keywords].sort()).toEqual(
      ["experiment", "notes", "observation", "rag", "research"].sort(),
    );
  });

  it("falls back to filename only when no frontmatter", () => {
    const out = extractKeywordsFromFile(
      "rag-experiment.md",
      "# title only",
      "/p/rag-experiment.md",
    )!;
    expect(out.source).toBe("filename");
    expect([...out.keywords].sort()).toEqual(["experiment", "rag"]);
  });

  it("returns null for projects opting out via aitne.exclude_from_interests", () => {
    const content = [
      "---",
      "aitne.exclude_from_interests: true",
      "---",
      "# Private project",
    ].join("\n");
    expect(
      extractKeywordsFromFile("private.md", content, "/p/private.md"),
    ).toBeNull();
  });

  it("treats `yes` / `on` as truthy opt-out too", () => {
    const yesContent = [
      "---",
      "aitne.exclude_from_interests: yes",
      "---",
    ].join("\n");
    expect(extractKeywordsFromFile("p.md", yesContent, "/p/p.md")).toBeNull();
    const onContent = [
      "---",
      "aitne.exclude_from_interests: on",
      "---",
    ].join("\n");
    expect(extractKeywordsFromFile("p.md", onContent, "/p/p.md")).toBeNull();
  });

  it("ignores `false` for the opt-out key", () => {
    const content = [
      "---",
      "aitne.exclude_from_interests: false",
      "---",
    ].join("\n");
    expect(
      extractKeywordsFromFile("p.md", content, "/p/p.md"),
    ).not.toBeNull();
  });

  it("treats an opt-out array value as not-truthy", () => {
    const content = [
      "---",
      "aitne.exclude_from_interests: [maybe]",
      "---",
    ].join("\n");
    expect(
      extractKeywordsFromFile("p.md", content, "/p/p.md"),
    ).not.toBeNull();
  });

  it("supports block-sequence YAML arrays", () => {
    const content = [
      "---",
      "aliases:",
      "  - foo",
      "  - bar baz",
      "---",
    ].join("\n");
    const out = extractKeywordsFromFile("p.md", content, "/p/p.md")!;
    expect([...out.keywords].sort()).toEqual(["bar", "baz", "foo"]);
  });

  it("supports double-quoted flow-array entries", () => {
    const content = [
      "---",
      'aitne_project_keywords: ["agent ops", "skill set"]',
      "---",
    ].join("\n");
    const out = extractKeywordsFromFile("p.md", content, "/p/p.md")!;
    expect([...out.keywords].sort()).toEqual(["agent", "ops", "set", "skill"]);
  });

  it("supports single-quoted scalars in frontmatter", () => {
    const content = ["---", "aliases: 'lone scalar'", "---"].join("\n");
    const out = extractKeywordsFromFile("p.md", content, "/p/p.md")!;
    expect(out.keywords.has("lone")).toBe(true);
    expect(out.keywords.has("scalar")).toBe(true);
  });

  it("falls back when explicit keyword override is an empty array", () => {
    const content = [
      "---",
      "aitne_project_keywords: []",
      "aliases: [foo]",
      "---",
    ].join("\n");
    const out = extractKeywordsFromFile("p.md", content, "/p/p.md")!;
    expect(out.source).toBe("frontmatter");
    expect(out.keywords.has("foo")).toBe(true);
  });

  it("ignores frontmatter comments and blank lines", () => {
    const content = [
      "---",
      "# this is a comment",
      "",
      "aliases: [alpha]",
      "---",
    ].join("\n");
    const out = extractKeywordsFromFile("p.md", content, "/p/p.md")!;
    expect(out.keywords.has("alpha")).toBe(true);
  });

  it("skips lines that don't match the key/value shape", () => {
    const content = [
      "---",
      "just a plain line",
      "aliases: [alpha]",
      "---",
    ].join("\n");
    const out = extractKeywordsFromFile("p.md", content, "/p/p.md")!;
    expect(out.keywords.has("alpha")).toBe(true);
  });

  it("returns filename-only when no frontmatter fences present", () => {
    const out = extractKeywordsFromFile(
      "no-fm.md",
      "no frontmatter here\n",
      "/p/no-fm.md",
    )!;
    expect(out.source).toBe("filename");
    expect([...out.keywords].sort()).toEqual(["no", "fm"].sort());
  });

  it("returns filename-only when the closing fence is missing", () => {
    const content = ["---", "aliases: [foo]"].join("\n");
    const out = extractKeywordsFromFile(
      "broken-fm.md",
      content,
      "/p/broken-fm.md",
    )!;
    expect(out.source).toBe("filename");
    expect(out.keywords.has("broken")).toBe(true);
  });

  it("treats unquoted scalar with no closing bracket as a normal scalar", () => {
    const content = ["---", "aliases: scalar value here", "---"].join("\n");
    const out = extractKeywordsFromFile("p.md", content, "/p/p.md")!;
    expect(out.keywords.has("scalar")).toBe(true);
  });

  it("handles scalar-where-array-expected by tokenising the scalar", () => {
    const content = [
      "---",
      "aitne_project_keywords: alpha-beta gamma",
      "---",
    ].join("\n");
    const out = extractKeywordsFromFile("p.md", content, "/p/p.md")!;
    expect(out.source).toBe("explicit");
    expect([...out.keywords].sort()).toEqual(["alpha", "beta", "gamma"].sort());
  });

  it("supports scalar value as empty string in array-expected key", () => {
    const content = [
      "---",
      "aitne_project_keywords:",
      "aliases: [alpha]",
      "---",
    ].join("\n");
    const out = extractKeywordsFromFile("p.md", content, "/p/p.md")!;
    // Empty key falls through, aliases contributes.
    expect(out.source).toBe("frontmatter");
    expect(out.keywords.has("alpha")).toBe(true);
  });

  it("collapses empty entries inside flow arrays", () => {
    const content = [
      "---",
      "aliases: [foo,, , bar]",
      "---",
    ].join("\n");
    const out = extractKeywordsFromFile("p.md", content, "/p/p.md")!;
    expect([...out.keywords].sort()).toEqual(["bar", "foo"]);
  });

  it("treats an empty file as filename-only", () => {
    const out = extractKeywordsFromFile("solo.md", "", "/p/solo.md")!;
    expect(out.source).toBe("filename");
    expect([...out.keywords]).toEqual(["solo"]);
  });
});

describe("loadProjectKeywords", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pm-test-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns an empty array when projects dir is missing", () => {
    expect(loadProjectKeywords(dir)).toEqual([]);
  });

  it("returns an empty array when projects path is a regular file", () => {
    writeFileSync(join(dir, "projects"), "not a directory");
    expect(loadProjectKeywords(dir)).toEqual([]);
  });

  it("reads .md files only and sorts by slug", () => {
    mkdirSync(join(dir, "projects"));
    writeFileSync(join(dir, "projects", "zebra.md"), "# zebra");
    writeFileSync(join(dir, "projects", "aardvark.md"), "# aardvark");
    writeFileSync(join(dir, "projects", "README.txt"), "ignored");
    const out = loadProjectKeywords(dir);
    expect(out.map((o) => o.projectSlug)).toEqual(["aardvark", "zebra"]);
  });

  it("ignores subdirectories under projects/", () => {
    mkdirSync(join(dir, "projects"));
    mkdirSync(join(dir, "projects", "nested"));
    // Also exercise a `.md`-suffixed directory — passes the extension
    // filter but `statSync.isFile()` is false. Real-world: a user
    // dropped a folder named like a Markdown file.
    mkdirSync(join(dir, "projects", "looks-like-a-file.md"));
    writeFileSync(join(dir, "projects", "real.md"), "# real");
    const out = loadProjectKeywords(dir);
    expect(out.map((o) => o.projectSlug)).toEqual(["real"]);
  });

  it("omits files where the project opts out", () => {
    mkdirSync(join(dir, "projects"));
    writeFileSync(
      join(dir, "projects", "private.md"),
      ["---", "aitne.exclude_from_interests: true", "---"].join("\n"),
    );
    writeFileSync(join(dir, "projects", "public.md"), "# public");
    const out = loadProjectKeywords(dir);
    expect(out.map((o) => o.projectSlug)).toEqual(["public"]);
  });

  it("survives unreadable entries gracefully", () => {
    mkdirSync(join(dir, "projects"));
    // Broken symlink — statSync should throw inside the loop and the
    // file is skipped.
    symlinkSync(
      join(dir, "does-not-exist.md"),
      join(dir, "projects", "broken.md"),
    );
    writeFileSync(join(dir, "projects", "real.md"), "# real");
    const out = loadProjectKeywords(dir);
    expect(out.map((o) => o.projectSlug)).toEqual(["real"]);
  });

  it("skips files that statSync sees but readFileSync cannot open", () => {
    // Process running as root sees every file regardless of mode; skip
    // the chmod-based denial in that case — CI sometimes runs root.
    if (process.getuid && process.getuid() === 0) return;
    mkdirSync(join(dir, "projects"));
    const denied = join(dir, "projects", "denied.md");
    writeFileSync(denied, "# denied");
    chmodSync(denied, 0o000);
    writeFileSync(join(dir, "projects", "ok.md"), "# ok");
    try {
      const out = loadProjectKeywords(dir);
      expect(out.map((o) => o.projectSlug)).toEqual(["ok"]);
    } finally {
      // Restore mode so the afterEach rm can clean up.
      chmodSync(denied, 0o600);
    }
  });
});

describe("matchClustersToProject", () => {
  it("matches by filename substring (case-insensitive)", () => {
    const out = matchClustersToProject(
      {
        projectSlug: "aitne",
        projectPath: "/p/aitne.md",
        keywords: new Set(["aitne"]),
        source: "filename",
      },
      [makeCluster({ slug: "x", displayName: "AITNE agent core" })],
    );
    expect(out).toEqual([{ slug: "x", reason: "filename_match" }]);
  });

  it("matches by Jaccard ≥ 2 tokens AND ≥ 0.15 ratio", () => {
    const out = matchClustersToProject(
      {
        projectSlug: "async-server",
        projectPath: "/p/async-server.md",
        keywords: new Set(["async", "runtime", "tokio"]),
        source: "explicit",
      },
      [
        makeCluster({
          slug: "rust-async-runtime",
          displayName: "Rust async runtime",
          topDomains: ["tokio.rs"],
        }),
      ],
    );
    expect(out).toEqual([{ slug: "rust-async-runtime", reason: "jaccard" }]);
  });

  it("drops clusters below the overlap threshold", () => {
    const out = matchClustersToProject(
      {
        projectSlug: "qrstu",
        projectPath: "/p/qrstu.md",
        keywords: new Set(["alpha", "beta"]),
        source: "explicit",
      },
      [
        makeCluster({
          slug: "single-match",
          displayName: "alpha only",
          topDomains: [],
        }),
      ],
    );
    expect(out).toEqual([]);
  });

  it("drops clusters that meet overlap but fail ratio", () => {
    const out = matchClustersToProject(
      {
        projectSlug: "qrstuvw",
        projectPath: "/p/qrstuvw.md",
        keywords: new Set([
          "alpha",
          "beta",
          "k1",
          "k2",
          "k3",
          "k4",
          "k5",
          "k6",
          "k7",
          "k8",
          "k9",
          "k10",
        ]),
        source: "explicit",
      },
      [
        makeCluster({
          slug: "broad",
          displayName: "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu",
          topDomains: [],
        }),
      ],
    );
    expect(out).toEqual([]);
  });

  it("caps results at the supplied cap", () => {
    const clusters: ClusterSnapshot[] = [];
    for (let i = 0; i < 10; i++) {
      clusters.push(
        makeCluster({
          slug: `c-${i}`,
          displayName: `aitne thing ${i}`,
        }),
      );
    }
    const out = matchClustersToProject(
      {
        projectSlug: "aitne",
        projectPath: "/p/aitne.md",
        keywords: new Set(["aitne"]),
        source: "filename",
      },
      clusters,
      3,
    );
    expect(out).toHaveLength(3);
  });

  it("dedupes by cluster slug (filename match wins over later jaccard)", () => {
    const out = matchClustersToProject(
      {
        projectSlug: "aitne",
        projectPath: "/p/aitne.md",
        keywords: new Set(["aitne", "agent", "core"]),
        source: "explicit",
      },
      [
        makeCluster({
          slug: "agent-core",
          displayName: "aitne agent core",
        }),
      ],
    );
    expect(out).toEqual([{ slug: "agent-core", reason: "filename_match" }]);
  });

  it("uses default cap of 5 when not specified", () => {
    const clusters: ClusterSnapshot[] = [];
    for (let i = 0; i < 10; i++) {
      clusters.push(
        makeCluster({ slug: `c-${i}`, displayName: `aitne ${i}` }),
      );
    }
    const out = matchClustersToProject(
      {
        projectSlug: "aitne",
        projectPath: "/p/aitne.md",
        keywords: new Set(["aitne"]),
        source: "filename",
      },
      clusters,
    );
    expect(out).toHaveLength(5);
  });

  it("ignores single-character domain prefixes when tokenising", () => {
    const out = matchClustersToProject(
      {
        projectSlug: "z",
        projectPath: "/p/z.md",
        keywords: new Set(["x", "y"]),
        source: "explicit",
      },
      [
        makeCluster({
          slug: "x",
          displayName: "unrelated",
          topDomains: ["x.com", "y.com"],
        }),
      ],
    );
    expect(out).toEqual([]);
  });
});
