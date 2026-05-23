import { describe, expect, it } from "vitest";
import {
  browserHistoryLifecycleConfigSchema,
  cleanupInterestsReflectionRequestSchema,
  cleanupInterestsReflectionResponseSchema,
  refreshInterestsReflectionResponseSchema,
  weeklyInterestsSummaryResponseSchema,
} from "./browser-history-schemas.js";

describe("browserHistoryLifecycleConfigSchema.superRefine", () => {
  it("accepts an empty per_browser map (default branch)", () => {
    const parsed = browserHistoryLifecycleConfigSchema.parse({});
    expect(parsed.per_browser).toEqual({});
  });

  it("accepts per_browser entries keyed by a known browser", () => {
    const parsed = browserHistoryLifecycleConfigSchema.parse({
      per_browser: {
        chrome: { enabled: true },
        edge: { enabled: false },
      },
    });
    expect(Object.keys(parsed.per_browser).sort()).toEqual(["chrome", "edge"]);
  });

  it("rejects per_browser keyed by an unknown browser with a path-scoped issue", () => {
    const result = browserHistoryLifecycleConfigSchema.safeParse({
      per_browser: { netscape: { enabled: true } },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issues = result.error.issues.filter((i) =>
        i.path.join(".") === "per_browser.netscape",
      );
      expect(issues.length).toBeGreaterThan(0);
      expect(issues[0]?.message).toContain("netscape");
    }
  });

  it("reports one issue per unknown key when several are present", () => {
    const result = browserHistoryLifecycleConfigSchema.safeParse({
      per_browser: {
        chrome: { enabled: true }, // valid, must not be flagged
        opera: { enabled: true },
        vivaldi: { enabled: true },
      },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const unknownPaths = result.error.issues
        .map((i) => i.path.join("."))
        .filter((p) => p.startsWith("per_browser.") && p !== "per_browser.chrome");
      expect(unknownPaths.sort()).toEqual([
        "per_browser.opera",
        "per_browser.vivaldi",
      ]);
    }
  });
});

// ── WEEKLY_INTERESTS_REFLECTION_PLAN.md §10.2 / §10.3 / §10.3.1 ──
// Parity coverage for the three response schemas added alongside the
// dashboard routes. Mirrors the shapes the daemon helpers actually
// produce — if either side drifts (TS interface vs. Zod), one of these
// tests fails first.
describe("weeklyInterestsSummaryResponseSchema", () => {
  it("accepts a fully-populated cluster snapshot row", () => {
    const sample = {
      weekStart: "2026-05-18",
      weekEnd: "2026-05-24",
      generatedAt: "2026-05-21T18:00:00.000Z",
      clusters: [
        {
          slug: "prompt-injection-defenses",
          displayName: "Prompt-injection defenses",
          daysActive: 4,
          meaningfulVisits: 12,
          meaningfulForegroundSec: 11_520,
          distinctMeaningfulDomains: 5,
          topDomains: ["anthropic.com", "arxiv.org"],
          status: "active" as const,
          statusChange: "active_continued" as const,
          clusterJournalPath: "research/prompt-injection-defenses.md",
          hasOpenOffer: false,
          hasAcceptedResearch: true,
          hasWikiSummary: false,
          lastActivityDate: "2026-05-20",
          lastActivityMs: 1747749600000,
        },
      ],
      dormantSinceLastWeek: [
        {
          slug: "lattice-based-cryptography",
          displayName: "Lattice-based cryptography",
          lastActivity: "2026-05-12",
          lastActivityMs: 1747000000000,
        },
      ],
      projectMatches: [
        {
          projectSlug: "aitne",
          projectPath: "/abs/projects/aitne.md",
          clusters: [
            { slug: "prompt-injection-defenses", reason: "jaccard" as const },
          ],
        },
      ],
    };
    expect(() => weeklyInterestsSummaryResponseSchema.parse(sample)).not.toThrow();
  });

  it("rejects a non-YYYY-MM-DD weekStart", () => {
    expect(
      weeklyInterestsSummaryResponseSchema.safeParse({
        weekStart: "20260518",
        weekEnd: "2026-05-24",
        generatedAt: "now",
        clusters: [],
        dormantSinceLastWeek: [],
        projectMatches: [],
      }).success,
    ).toBe(false);
  });
});

describe("refreshInterestsReflectionResponseSchema", () => {
  it("accepts a successful refresh result", () => {
    expect(() =>
      refreshInterestsReflectionResponseSchema.parse({
        weekStart: "2026-05-18",
        generatedAt: "2026-05-21T18:00:00.000Z",
        targetsWritten: [
          "user/profile.md",
          "user/research-themes.md",
          "user/_index.md",
        ],
        targetsSkipped: [],
        themesSelected: [
          "prompt-injection-defenses",
          "quantum-mechanics-intro",
          "rust-borrow-checker",
        ],
        clustersInSnapshot: 5,
        clustersDormantSinceLastWeek: 1,
        projectsAnnotated: 0,
        projectsSkippedNoMatch: 2,
      }),
    ).not.toThrow();
  });

  it("accepts a skipped result carrying the helper's reason enum", () => {
    expect(() =>
      refreshInterestsReflectionResponseSchema.parse({
        weekStart: "2026-05-18",
        generatedAt: "2026-05-21T18:00:00.000Z",
        targetsWritten: [],
        targetsSkipped: [],
        themesSelected: [],
        clustersInSnapshot: 1,
        clustersDormantSinceLastWeek: 0,
        projectsAnnotated: 0,
        projectsSkippedNoMatch: 0,
        skipped: { reason: "fewer_than_min_themes" },
      }),
    ).not.toThrow();
  });

  it("rejects an unknown skipped reason", () => {
    const result = refreshInterestsReflectionResponseSchema.safeParse({
      weekStart: "2026-05-18",
      generatedAt: "now",
      targetsWritten: [],
      targetsSkipped: [],
      themesSelected: [],
      clustersInSnapshot: 0,
      clustersDormantSinceLastWeek: 0,
      projectsAnnotated: 0,
      projectsSkippedNoMatch: 0,
      skipped: { reason: "made_up_reason" },
    });
    expect(result.success).toBe(false);
  });
});

describe("cleanupInterestsReflectionRequestSchema", () => {
  it("accepts an empty body (uses helper default of true)", () => {
    expect(() =>
      cleanupInterestsReflectionRequestSchema.parse({}),
    ).not.toThrow();
  });

  it("accepts alsoDeleteResearchThemesFile=false", () => {
    expect(() =>
      cleanupInterestsReflectionRequestSchema.parse({
        alsoDeleteResearchThemesFile: false,
      }),
    ).not.toThrow();
  });

  it("rejects unknown keys (strict)", () => {
    expect(
      cleanupInterestsReflectionRequestSchema.safeParse({
        destroyEverything: true,
      }).success,
    ).toBe(false);
  });
});

describe("cleanupInterestsReflectionResponseSchema", () => {
  it("accepts a populated cleanup result", () => {
    expect(() =>
      cleanupInterestsReflectionResponseSchema.parse({
        blocksRemoved: 3,
        filesAffected: [
          "user/profile.md",
          "user/_index.md",
          "user/research-themes.md",
        ],
        researchThemesDeleted: true,
      }),
    ).not.toThrow();
  });

  it("accepts a no-op idempotent result", () => {
    expect(() =>
      cleanupInterestsReflectionResponseSchema.parse({
        blocksRemoved: 0,
        filesAffected: [],
        researchThemesDeleted: false,
      }),
    ).not.toThrow();
  });
});
