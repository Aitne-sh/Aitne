import { describe, it, expect } from "vitest";
import {
  escapeForMd,
  formatHoursCompact,
  renderIndexEntryBlock,
  renderProfileBlock,
  renderProjectBlock,
  renderResearchThemesFile,
  replaceAutoBlock,
  stripAllAutoBlocks,
} from "./interests-block.js";
import type {
  ClusterSnapshot,
  WeeklyInterestsSummary,
} from "./weekly-interests-summary.js";

function makeCluster(
  overrides: Partial<ClusterSnapshot> & { slug: string },
): ClusterSnapshot {
  return {
    slug: overrides.slug,
    displayName: overrides.displayName ?? overrides.slug,
    daysActive: overrides.daysActive ?? 3,
    meaningfulVisits: overrides.meaningfulVisits ?? 12,
    meaningfulForegroundSec: overrides.meaningfulForegroundSec ?? 3600 * 3.2,
    distinctMeaningfulDomains: overrides.distinctMeaningfulDomains ?? 4,
    topDomains: overrides.topDomains ?? ["anthropic.com", "simonwillison.net"],
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

describe("escapeForMd", () => {
  it("passes plain text unchanged", () => {
    expect(escapeForMd("Prompt-injection defenses")).toBe(
      "Prompt-injection defenses",
    );
  });

  it("rewrites `-->` so it cannot terminate an HTML comment", () => {
    expect(escapeForMd("Cluster --> hijack")).toBe("Cluster -→ hijack");
  });

  it("strips markdown brackets, backticks, and heading markers", () => {
    expect(escapeForMd("[bad](url) `code`")).toBe("(bad)(url) 'code'");
    expect(escapeForMd("# big\n## smaller")).toBe("＃ big ＃# smaller");
  });

  it("collapses newlines and trims", () => {
    expect(escapeForMd("  hello\nworld  ")).toBe("hello world");
  });

  // Regression — the property suite below cannot reach inputs whose
  // first byte is non-newline whitespace adjacent to a `#` with seed
  // 0xDEADBEEF. The bug those inputs expose: `(^|\n)#` matches only
  // when `#` is at byte 0 or immediately after `\n`, but the trailing
  // `[\r\n]+` collapse and `.trim()` then eat the leading whitespace,
  // leaving a literal heading marker at byte 0 of the output. The
  // post-trim leading-`#` pass closes the hole.
  it("escapes a leading `#` even when preceded by space/tab/CR before trim", () => {
    expect(escapeForMd(" #urgent")).toBe("＃urgent");
    expect(escapeForMd("\t#urgent")).toBe("＃urgent");
    expect(escapeForMd("\r#urgent")).toBe("＃urgent");
    expect(escapeForMd("   #project-x")).toBe("＃project-x");
  });
});

describe("formatHoursCompact", () => {
  it("uses hours for ≥ 1h", () => {
    expect(formatHoursCompact(3600 * 3.2)).toBe("~3.2h");
  });
  it("uses minutes for < 1h", () => {
    expect(formatHoursCompact(38 * 60)).toBe("~38min");
  });
  it("uses seconds for < 1min", () => {
    expect(formatHoursCompact(12)).toBe("~12sec");
  });
  it("renders 0 as 0sec", () => {
    expect(formatHoursCompact(0)).toBe("0sec");
  });
});

describe("renderProfileBlock", () => {
  it("emits BEGIN/END delimiters plus the H2 header and bullets", () => {
    const block = renderProfileBlock({
      clusters: [
        makeCluster({
          slug: "prompt-injection-defenses",
          displayName: "Prompt-injection defenses",
          daysActive: 4,
          meaningfulVisits: 12,
          meaningfulForegroundSec: 3600 * 3.2,
        }),
      ],
      weekStart: "2026-05-19",
      generatedAt: "2026-05-26T19:30:14Z",
    });
    expect(block).toContain("<!-- BEGIN aitne:browser-interests v1");
    expect(block).toContain("weekStart=2026-05-19");
    expect(block).toContain("generatedAt=2026-05-26T19:30:14Z");
    expect(block).toContain("## Current research themes (auto)");
    expect(block).toContain(
      "- **Prompt-injection defenses** — 4 days, 12 sources, ~3.2h → `research/prompt-injection-defenses.md`",
    );
    expect(block).toContain("<!-- END aitne:browser-interests v1 -->");
  });

  it("singularises 'day' and 'source' counts", () => {
    const block = renderProfileBlock({
      clusters: [
        makeCluster({
          slug: "x",
          displayName: "x",
          daysActive: 1,
          meaningfulVisits: 1,
        }),
      ],
      weekStart: "2026-05-19",
      generatedAt: "2026-05-26T19:30:14Z",
    });
    expect(block).toContain("1 day, 1 source");
  });

  it("escapes hostile cluster names", () => {
    const block = renderProfileBlock({
      clusters: [
        makeCluster({
          slug: "bad",
          displayName: "evil--> [link](x) `code`",
        }),
      ],
      weekStart: "2026-05-19",
      generatedAt: "2026-05-26T19:30:14Z",
    });
    expect(block).not.toContain("-->\nignored");
    // The escaped HTML-comment closer should be neutralised.
    const bulletLine = block.split("\n").find((l) => l.startsWith("- **"))!;
    expect(bulletLine).toContain("evil-→ (link)(x) 'code'");
  });
});

describe("renderProjectBlock", () => {
  it("returns null when no clusters matched", () => {
    expect(
      renderProjectBlock({
        projectSlug: "aitne",
        clusters: [],
        weekStart: "2026-05-19",
        generatedAt: "2026-05-26T19:30:14Z",
      }),
    ).toBeNull();
  });

  it("includes the project disambiguator on BEGIN and END", () => {
    const block = renderProjectBlock({
      projectSlug: "aitne",
      clusters: [makeCluster({ slug: "skill-scope-materialisation", displayName: "Skill-scope materialisation" })],
      weekStart: "2026-05-19",
      generatedAt: "2026-05-26T19:30:14Z",
    })!;
    expect(block).toContain(
      "<!-- BEGIN aitne:browser-interests v1 project=aitne weekStart=2026-05-19 generatedAt=2026-05-26T19:30:14Z -->",
    );
    expect(block).toContain("<!-- END aitne:browser-interests v1 project=aitne -->");
    expect(block).toContain("[Cluster journal](../research/skill-scope-materialisation.md)");
  });

  it("singularises 'day' and 'source' counts in project bullets", () => {
    const block = renderProjectBlock({
      projectSlug: "aitne",
      clusters: [
        makeCluster({
          slug: "x",
          displayName: "x",
          daysActive: 1,
          meaningfulVisits: 1,
        }),
      ],
      weekStart: "2026-05-19",
      generatedAt: "2026-05-26T19:30:14Z",
    })!;
    expect(block).toContain("1 day, 1 source");
  });

  it("escapes `-->` in the project disambiguator", () => {
    const block = renderProjectBlock({
      projectSlug: "evil-->name",
      clusters: [makeCluster({ slug: "x" })],
      weekStart: "2026-05-19",
      generatedAt: "2026-05-26T19:30:14Z",
    })!;
    expect(block).toContain("project=evil-→name");
    expect(block).not.toContain("project=evil--> -->");
  });
});

describe("renderIndexEntryBlock", () => {
  it("renders a one-line idempotent entry with target disambiguator", () => {
    const block = renderIndexEntryBlock({ generatedAt: "2026-05-26T19:30:14Z" });
    expect(block).toBe(
      [
        "<!-- BEGIN aitne:browser-interests v1 target=research-themes -->",
        "- `research-themes.md` — Auto-generated weekly snapshot of current research themes from browser activity. Last refreshed: 2026-05-26.",
        "<!-- END aitne:browser-interests v1 target=research-themes -->",
      ].join("\n"),
    );
  });
});

describe("renderResearchThemesFile", () => {
  function summary(
    overrides: Partial<WeeklyInterestsSummary> = {},
  ): WeeklyInterestsSummary {
    return {
      weekStart: overrides.weekStart ?? "2026-05-19",
      weekEnd: overrides.weekEnd ?? "2026-05-25",
      generatedAt: overrides.generatedAt ?? "2026-05-26T19:30:14Z",
      clusters: overrides.clusters ?? [],
      dormantSinceLastWeek: overrides.dormantSinceLastWeek ?? [],
      projectMatches: overrides.projectMatches ?? [],
    };
  }

  it("emits a minimal file when there is no activity", () => {
    const md = renderResearchThemesFile(summary());
    expect(md).toContain("type: user");
    expect(md).toContain("owner: aitne-browser-history");
    expect(md).toContain("updated: 2026-05-26");
    expect(md).toContain("clusters_active: 0");
    expect(md).toContain("# Research themes — week of 2026-05-19");
    expect(md).toContain("_No active research themes this week.");
    expect(md).toContain("_No themes went dormant this week._");
  });

  it("renders active sections + dormant tail", () => {
    const md = renderResearchThemesFile(
      summary({
        clusters: [
          makeCluster({
            slug: "prompt-injection-defenses",
            displayName: "Prompt-injection defenses",
            daysActive: 4,
            meaningfulVisits: 12,
            meaningfulForegroundSec: 3600 * 3.2,
            topDomains: ["anthropic.com", "simonwillison.net", "arxiv.org"],
            statusChange: "active_continued",
          }),
          makeCluster({
            slug: "quantum-mechanics-intro",
            displayName: "Quantum mechanics intro",
            daysActive: 3,
            meaningfulVisits: 8,
            meaningfulForegroundSec: 3600 * 2.1,
            topDomains: [],
            statusChange: "new",
          }),
        ],
        dormantSinceLastWeek: [
          {
            slug: "lattice-based-cryptography",
            displayName: "Lattice cryptography",
            lastActivity: "2026-05-18",
            lastActivityMs: 0,
          },
        ],
      }),
    );
    expect(md).toContain("### Prompt-injection defenses (`prompt-injection-defenses`)");
    expect(md).toContain("- **Top domains**: anthropic.com, simonwillison.net, arxiv.org");
    expect(md).toContain("- **Last week's status**: active (continued)");
    expect(md).toContain("### Quantum mechanics intro (`quantum-mechanics-intro`)");
    expect(md).toContain("- **Top domains**: _(no domain data)_");
    expect(md).toContain("- **Last week's status**: new this week");
    expect(md).toContain("- **Lattice cryptography** (`lattice-based-cryptography`) — last activity 2026-05-18");
    expect(md).toContain(
      "These themes appeared in last week's snapshot but had no meaningful activity in the past 7 days:",
    );
  });
});

describe("replaceAutoBlock", () => {
  it("appends to the end of a non-empty file when no block present", () => {
    const file = "Existing content\n\n## Section\n\nbody\n";
    const block =
      "<!-- BEGIN aitne:browser-interests v1 weekStart=2026-05-19 -->\n## Current research themes (auto)\n<!-- END aitne:browser-interests v1 -->";
    const out = replaceAutoBlock(file, block);
    expect(out.endsWith("\n")).toBe(true);
    expect(out).toContain("body\n\n<!-- BEGIN");
    expect(out).toContain(block);
  });

  it("appends without a leading separator when the file is empty", () => {
    const block =
      "<!-- BEGIN aitne:browser-interests v1 -->\n…\n<!-- END aitne:browser-interests v1 -->";
    const out = replaceAutoBlock("", block);
    expect(out).toBe(`${block}\n`);
  });

  it("replaces an existing block in place (no disambiguator)", () => {
    const file = [
      "# Title",
      "",
      "<!-- BEGIN aitne:browser-interests v1 weekStart=2026-05-12 -->",
      "old body",
      "<!-- END aitne:browser-interests v1 -->",
      "",
    ].join("\n");
    const newBlock = [
      "<!-- BEGIN aitne:browser-interests v1 weekStart=2026-05-19 -->",
      "new body",
      "<!-- END aitne:browser-interests v1 -->",
    ].join("\n");
    const out = replaceAutoBlock(file, newBlock);
    expect(out).not.toContain("old body");
    expect(out).toContain("new body");
  });

  it("replaces only the block with the matching disambiguator", () => {
    const file = [
      "<!-- BEGIN aitne:browser-interests v1 target=research-themes -->",
      "- old entry",
      "<!-- END aitne:browser-interests v1 target=research-themes -->",
      "",
      "<!-- BEGIN aitne:browser-interests v1 weekStart=2026-05-12 -->",
      "untouched",
      "<!-- END aitne:browser-interests v1 -->",
    ].join("\n");
    const newBlock = [
      "<!-- BEGIN aitne:browser-interests v1 target=research-themes -->",
      "- new entry",
      "<!-- END aitne:browser-interests v1 target=research-themes -->",
    ].join("\n");
    const out = replaceAutoBlock(file, newBlock, "target=research-themes");
    expect(out).toContain("- new entry");
    expect(out).not.toContain("- old entry");
    expect(out).toContain("untouched");
  });

  it("appends a disambiguator-scoped block when none yet exists in the file", () => {
    const file = "# Project notes\n\nbody\n";
    const newBlock = [
      "<!-- BEGIN aitne:browser-interests v1 project=aitne -->",
      "## Related browser research",
      "<!-- END aitne:browser-interests v1 project=aitne -->",
    ].join("\n");
    const out = replaceAutoBlock(file, newBlock, "project=aitne");
    expect(out).toContain("body\n\n<!-- BEGIN");
    expect(out).toContain("project=aitne");
  });

  it("does not prefix-match across a longer-slug block (project=aitne vs project=aitne-foo)", () => {
    // Regression guard: without the trailing-space invariant in the
    // BEGIN regex, searching for `project=aitne` would also match the
    // `project=aitne-foo` BEGIN line as a substring and, paired with
    // the later `project=aitne` END, fuse both blocks into a single
    // replacement.
    const file = [
      "<!-- BEGIN aitne:browser-interests v1 project=aitne-foo weekStart=2026-05-12 -->",
      "- foo body",
      "<!-- END aitne:browser-interests v1 project=aitne-foo -->",
      "",
      "interleaving user prose",
      "",
      "<!-- BEGIN aitne:browser-interests v1 project=aitne weekStart=2026-05-12 -->",
      "- aitne body",
      "<!-- END aitne:browser-interests v1 project=aitne -->",
    ].join("\n");
    const newBlock = [
      "<!-- BEGIN aitne:browser-interests v1 project=aitne weekStart=2026-05-19 -->",
      "- aitne fresh",
      "<!-- END aitne:browser-interests v1 project=aitne -->",
    ].join("\n");
    const out = replaceAutoBlock(file, newBlock, "project=aitne");
    // The aitne block is replaced…
    expect(out).toContain("- aitne fresh");
    expect(out).not.toContain("- aitne body");
    // …but the aitne-foo block — including its interleaving prose —
    // is left intact byte-for-byte.
    expect(out).toContain("project=aitne-foo weekStart=2026-05-12");
    expect(out).toContain("- foo body");
    expect(out).toContain("interleaving user prose");
  });
});

// ─────────────────────────────────────────────────────────────────────
// Property tests — rev 4 (WEEKLY_INTERESTS_REFLECTION_PLAN.md §20).
//
// The renderer is the single chokepoint that converts arbitrary cluster
// `displayName` strings into bytes that land between BEGIN/END HTML-
// comment delimiters. A poisoned displayName containing `-->`, `]`,
// backticks, or leading `#` could in principle close the comment, fuse
// adjacent blocks, or inject markdown structure into the file. The
// `escapeForMd` / `escapeForHtmlComment` pair is the load-bearing
// defence; these property tests assert the defence holds across a
// large randomised input space rather than just the hand-picked spot
// cases above.
//
// We use a seeded PRNG so failures are reproducible without a
// `fast-check` dependency. The seed (0xDEADBEEF) is arbitrary but
// fixed; pick a different seed if a regression slips through and
// re-run to widen coverage.
// ─────────────────────────────────────────────────────────────────────

function makeSeededRng(seed: number): () => number {
  // mulberry32 — small, deterministic PRNG; values are uniform in [0, 1).
  let state = seed >>> 0;
  return function next(): number {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function generateAdversarialString(rng: () => number, maxLen = 80): string {
  // Bias toward the characters most likely to escape the markdown / HTML
  // comment / link-bracket / heading defence. Plain alphanumeric tokens
  // are interleaved so the harness exercises the no-op fast path too.
  const palette = [
    "a", "b", "c", "d", "x", "y", "z", "0", "1", "2", " ", "-", "_",
    "[", "]", "`", "#", "<", ">", "!", "-->", "<!--", "\n", "\r", "\t",
    "\\", "*", "(", ")", "{", "}", "&", "|", ";", ":", "\"", "'",
    "→", "←", "中", "日", "本", "語",
  ];
  const len = 1 + Math.floor(rng() * (maxLen - 1));
  let out = "";
  for (let i = 0; i < len; i++) {
    out += palette[Math.floor(rng() * palette.length)]!;
  }
  return out;
}

const BEGIN_PROFILE_MARKER = "<!-- BEGIN aitne:browser-interests v1";
const END_PROFILE_MARKER = "<!-- END aitne:browser-interests v1 -->";
const ITERATIONS = 500;

describe("interests-block — property tests", () => {
  it("escapeForMd never emits HTML-comment closers, markdown brackets, backticks, or leading hashes", () => {
    const rng = makeSeededRng(0xDEADBEEF);
    for (let i = 0; i < ITERATIONS; i++) {
      const input = generateAdversarialString(rng);
      const out = escapeForMd(input);
      expect(out).not.toContain("-->");
      expect(out).not.toContain("`");
      expect(out).not.toContain("[");
      expect(out).not.toContain("]");
      // Newlines are collapsed to spaces — verify.
      expect(out).not.toContain("\n");
      expect(out).not.toContain("\r");
      // No bullet line should start with a markdown heading character.
      const lines = out.split("\n");
      for (const line of lines) {
        if (line.startsWith("#")) {
          throw new Error(
            `escapeForMd left a leading '#' after escape: input=${JSON.stringify(input)} out=${JSON.stringify(out)}`,
          );
        }
      }
    }
  });

  it("renderProfileBlock output contains exactly one BEGIN line and one END line regardless of displayName payload", () => {
    const rng = makeSeededRng(0xC0FFEE01);
    for (let i = 0; i < ITERATIONS; i++) {
      const displayName = generateAdversarialString(rng);
      const block = renderProfileBlock({
        clusters: [
          makeCluster({ slug: "x", displayName }),
        ],
        weekStart: "2026-05-19",
        generatedAt: "2026-05-26T19:30:14Z",
      });
      const beginCount = (block.match(/<!-- BEGIN aitne:browser-interests v1/g) ?? []).length;
      const endCount = (block.match(/<!-- END aitne:browser-interests v1/g) ?? []).length;
      expect(beginCount).toBe(1);
      expect(endCount).toBe(1);
      // The END marker is the unscoped form (`-->` directly after v1).
      expect(block).toContain(END_PROFILE_MARKER);
      expect(block.startsWith(BEGIN_PROFILE_MARKER)).toBe(true);
    }
  });

  it("stripAllAutoBlocks round-trips: removing what renderProfileBlock produced returns prior content", () => {
    const rng = makeSeededRng(0xBADF00D5);
    for (let i = 0; i < 200; i++) {
      const displayName = generateAdversarialString(rng);
      const block = renderProfileBlock({
        clusters: [makeCluster({ slug: "x", displayName })],
        weekStart: "2026-05-19",
        generatedAt: "2026-05-26T19:30:14Z",
      });
      const prior = "# Profile\n\n## Identity\nUser identity.\n\n## Raw Signals\n- a signal\n";
      const file = `${prior}\n${block}\n`;
      const { content, blocksRemoved } = stripAllAutoBlocks(file);
      expect(blocksRemoved).toBe(1);
      // The strip must leave the prior content intact byte-for-byte
      // (modulo trailing-newline normalisation handled by the helper).
      expect(content).toContain("## Identity\nUser identity.");
      expect(content).toContain("## Raw Signals\n- a signal");
      // And the block markers must not survive.
      expect(content).not.toContain("aitne:browser-interests");
    }
  });

  it("renderProjectBlock with a filesystem-realistic adversarial projectSlug round-trips through stripAllAutoBlocks", () => {
    const rng = makeSeededRng(0x5EEDBEEF);
    // The matcher loads project slugs from `projects/*.md` filenames.
    // POSIX filesystems technically allow most bytes, but ALL real
    // filenames in this codebase are derived from user prose plus the
    // ingestion's slugifier — alphanumeric + `-._` + the `-->` token
    // (deliberate adversarial seed) is the space we defend. Newlines,
    // backticks, and the `<!--` token itself can't legitimately appear
    // in a filename, so excluding them keeps the test honest. If a
    // future ingestion path introduces a slug source that can carry
    // those, harden the renderer first, then widen this alphabet.
    const palette = [
      "a", "b", "c", "d", "e", "x", "y", "z", "0", "1", "2", "3",
      "-", "_", ".", "-->",
    ];
    function adversarialSlug(): string {
      const len = 1 + Math.floor(rng() * 39);
      let out = "";
      for (let i = 0; i < len; i++) {
        out += palette[Math.floor(rng() * palette.length)]!;
      }
      return out;
    }
    for (let i = 0; i < ITERATIONS; i++) {
      const projectSlug = adversarialSlug();
      const block = renderProjectBlock({
        projectSlug,
        clusters: [makeCluster({ slug: "x", displayName: "x" })],
        weekStart: "2026-05-19",
        generatedAt: "2026-05-26T19:30:14Z",
      })!;
      // BEGIN and END counts must match — a fused-block bug would show
      // up here as an asymmetry.
      const beginCount = (block.match(/<!-- BEGIN aitne:browser-interests v1/g) ?? []).length;
      const endCount = (block.match(/<!-- END aitne:browser-interests v1/g) ?? []).length;
      expect(beginCount).toBe(1);
      expect(endCount).toBe(1);
      // The strip helper removes exactly one block.
      const wrapped = `before\n\n${block}\n\nafter\n`;
      const { content, blocksRemoved } = stripAllAutoBlocks(wrapped);
      expect(blocksRemoved).toBe(1);
      expect(content).toContain("before");
      expect(content).toContain("after");
      expect(content).not.toContain("aitne:browser-interests");
    }
  });

  it("replaceAutoBlock idempotently swaps content even with adversarial display names", () => {
    const rng = makeSeededRng(0x12345678);
    for (let i = 0; i < 100; i++) {
      const displayA = generateAdversarialString(rng);
      const displayB = generateAdversarialString(rng);
      const blockA = renderProfileBlock({
        clusters: [makeCluster({ slug: "x", displayName: displayA })],
        weekStart: "2026-05-19",
        generatedAt: "2026-05-26T19:30:14Z",
      });
      const blockB = renderProfileBlock({
        clusters: [makeCluster({ slug: "x", displayName: displayB })],
        weekStart: "2026-05-26",
        generatedAt: "2026-06-02T19:30:14Z",
      });
      const file = `# Profile\n\n${blockA}\n`;
      const after = replaceAutoBlock(file, blockB);
      // Exactly one block survives, and it carries the second weekStart.
      const beginCount = (after.match(/<!-- BEGIN aitne:browser-interests v1/g) ?? []).length;
      expect(beginCount).toBe(1);
      expect(after).toContain("weekStart=2026-05-26");
      expect(after).not.toContain("weekStart=2026-05-19");
    }
  });
});

describe("stripAllAutoBlocks", () => {
  it("returns the file unchanged when no blocks present", () => {
    const file = "# Title\n\ncontent\n";
    const out = stripAllAutoBlocks(file);
    expect(out.content).toBe(file);
    expect(out.blocksRemoved).toBe(0);
  });

  it("removes a single block and preserves surrounding content", () => {
    const file = [
      "Before",
      "",
      "<!-- BEGIN aitne:browser-interests v1 weekStart=2026-05-19 -->",
      "block body",
      "<!-- END aitne:browser-interests v1 -->",
      "",
      "After",
      "",
    ].join("\n");
    const out = stripAllAutoBlocks(file);
    expect(out.blocksRemoved).toBe(1);
    expect(out.content).toContain("Before");
    expect(out.content).toContain("After");
    expect(out.content).not.toContain("block body");
  });

  it("removes multiple blocks across disambiguators", () => {
    const file = [
      "<!-- BEGIN aitne:browser-interests v1 target=research-themes -->",
      "entry",
      "<!-- END aitne:browser-interests v1 target=research-themes -->",
      "",
      "<!-- BEGIN aitne:browser-interests v1 project=aitne -->",
      "annotation",
      "<!-- END aitne:browser-interests v1 project=aitne -->",
      "",
      "<!-- BEGIN aitne:browser-interests v1 weekStart=2026-05-19 -->",
      "block",
      "<!-- END aitne:browser-interests v1 -->",
    ].join("\n");
    const out = stripAllAutoBlocks(file);
    expect(out.blocksRemoved).toBe(3);
    expect(out.content.includes("BEGIN aitne:browser-interests")).toBe(false);
  });

  it("preserves trailing newline when source had one", () => {
    const file = [
      "<!-- BEGIN aitne:browser-interests v1 -->",
      "x",
      "<!-- END aitne:browser-interests v1 -->",
      "",
    ].join("\n");
    expect(stripAllAutoBlocks(file).content.endsWith("\n")).toBe(true);
  });

  it("returns empty string when source has only a block and no trailing newline", () => {
    const file = [
      "<!-- BEGIN aitne:browser-interests v1 -->",
      "x",
      "<!-- END aitne:browser-interests v1 -->",
    ].join("\n");
    const out = stripAllAutoBlocks(file);
    expect(out.content).toBe("");
    expect(out.blocksRemoved).toBe(1);
  });

  it("is idempotent — second pass removes nothing", () => {
    const file = "before\n<!-- BEGIN aitne:browser-interests v1 -->\nx\n<!-- END aitne:browser-interests v1 -->\nafter\n";
    const first = stripAllAutoBlocks(file);
    const second = stripAllAutoBlocks(first.content);
    expect(second.blocksRemoved).toBe(0);
    expect(second.content).toBe(first.content);
  });
});
