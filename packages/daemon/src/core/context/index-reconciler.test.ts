import { describe, expect, it } from "vitest";
import {
  applyRollingRetention,
  defaultRowFor,
  reconcileContextIndex,
  renderContextIndex,
  shouldIndexPath,
  type FilesystemSnapshotEntry,
} from "./index-reconciler.js";
import type { ContextIndexRow } from "../review-context.js";
import { parseContextIndexRows } from "../review-context.js";
import { validateContextFileFrontmatter } from "../context-frontmatter.js";
import { CONTEXT_RELATIVE_PATHS } from "../context-paths.js";

const TODAY = "2026-04-21";

function entry(
  path: string,
  mtimeDate: string = TODAY,
  h1Title: string | null = null,
): FilesystemSnapshotEntry {
  return { path, mtimeDate, h1Title };
}

function row(
  path: string,
  overrides: Partial<ContextIndexRow> = {},
): ContextIndexRow {
  return {
    path,
    purpose: "Existing purpose",
    reviewFlows: "all",
    lastTouched: TODAY,
    ...overrides,
  };
}

describe("shouldIndexPath", () => {
  it("excludes context-index.md itself and any _index.md", () => {
    expect(shouldIndexPath("context-index.md")).toBe(false);
    expect(shouldIndexPath("_index.md")).toBe(false);
    expect(shouldIndexPath("projects/_index.md")).toBe(false);
    expect(shouldIndexPath("user/_index.md")).toBe(false);
  });

  it("excludes ephemeral directories", () => {
    expect(shouldIndexPath("agent/scratch/2026-04-21-foo.md")).toBe(false);
    expect(shouldIndexPath("inbox/2026-04-21-memo.md")).toBe(false);
    expect(shouldIndexPath("routines/custom/daily-standup.md")).toBe(false);
  });

  it("excludes non-md files (the walker may surface .base)", () => {
    expect(shouldIndexPath("projects/_active.base")).toBe(false);
  });

  it("includes root-level surviving files", () => {
    expect(shouldIndexPath("today.md")).toBe(true);
    expect(shouldIndexPath("yesterday.md")).toBe(true);
    expect(shouldIndexPath("roadmap.md")).toBe(true);
    expect(shouldIndexPath("agent/journal.md")).toBe(true);
  });

  it("includes user/rules/routines/projects/dossiers and rolling dirs", () => {
    expect(shouldIndexPath("user/profile.md")).toBe(true);
    expect(shouldIndexPath("rules/management.md")).toBe(true);
    expect(shouldIndexPath("routines/morning.md")).toBe(true);
    expect(shouldIndexPath("projects/alpha.md")).toBe(true);
    expect(shouldIndexPath("dossiers/morning.md")).toBe(true);
    expect(shouldIndexPath("daily/2026-04-21.md")).toBe(true);
    expect(shouldIndexPath("weekly/2026-W16.md")).toBe(true);
    expect(shouldIndexPath("monthly/2026-04.md")).toBe(true);
  });

  it("excludes unknown top-level paths", () => {
    expect(shouldIndexPath("random.md")).toBe(false);
    expect(shouldIndexPath("outside/foo.md")).toBe(false);
  });
});

describe("applyRollingRetention", () => {
  it("keeps the 7 most recent daily/ files", () => {
    const snapshot: FilesystemSnapshotEntry[] = [];
    for (let i = 1; i <= 12; i++) {
      snapshot.push(entry(`daily/2026-04-${String(i).padStart(2, "0")}.md`));
    }
    const capped = applyRollingRetention(snapshot).map((e) => e.path).sort();
    expect(capped).toEqual([
      "daily/2026-04-06.md",
      "daily/2026-04-07.md",
      "daily/2026-04-08.md",
      "daily/2026-04-09.md",
      "daily/2026-04-10.md",
      "daily/2026-04-11.md",
      "daily/2026-04-12.md",
    ]);
  });

  it("caps weekly to 4 and monthly to 6", () => {
    const snapshot: FilesystemSnapshotEntry[] = [
      entry("weekly/2026-W13.md"),
      entry("weekly/2026-W14.md"),
      entry("weekly/2026-W15.md"),
      entry("weekly/2026-W16.md"),
      entry("weekly/2026-W17.md"),
      entry("monthly/2025-11.md"),
      entry("monthly/2025-12.md"),
      entry("monthly/2026-01.md"),
      entry("monthly/2026-02.md"),
      entry("monthly/2026-03.md"),
      entry("monthly/2026-04.md"),
      entry("monthly/2026-05.md"),
    ];
    const capped = applyRollingRetention(snapshot).map((e) => e.path).sort();
    expect(capped).toEqual([
      "monthly/2025-12.md",
      "monthly/2026-01.md",
      "monthly/2026-02.md",
      "monthly/2026-03.md",
      "monthly/2026-04.md",
      "monthly/2026-05.md",
      "weekly/2026-W14.md",
      "weekly/2026-W15.md",
      "weekly/2026-W16.md",
      "weekly/2026-W17.md",
    ]);
  });

  it("passes non-rolling entries through unchanged", () => {
    const snapshot: FilesystemSnapshotEntry[] = [
      entry("today.md"),
      entry("projects/alpha.md"),
      entry("daily/2026-04-20.md"),
    ];
    expect(applyRollingRetention(snapshot).map((e) => e.path).sort()).toEqual([
      "daily/2026-04-20.md",
      "projects/alpha.md",
      "today.md",
    ]);
  });
});

describe("defaultRowFor", () => {
  it("uses the table for today.md", () => {
    expect(defaultRowFor(entry("today.md"))).toEqual({
      path: "today.md",
      purpose: "Current-day schedule, tasks, agent plan, handoff",
      reviewFlows: "hourly, morning, evening",
      lastTouched: TODAY,
    });
  });

  it("uses the table for yesterday.md", () => {
    expect(defaultRowFor(entry("yesterday.md")).reviewFlows).toBe("morning");
  });

  it("uses the table for roadmap.md", () => {
    expect(defaultRowFor(entry("roadmap.md")).reviewFlows).toBe(
      "evening, weekly, monthly, roadmap",
    );
  });

  it("uses the table for agent/journal.md with H1 override", () => {
    const result = defaultRowFor(entry("agent/journal.md", TODAY, "My Journal"));
    expect(result.purpose).toBe("My Journal");
    expect(result.reviewFlows).toBe("weekly, monthly");
  });

  it("uses user/profile.md defaults", () => {
    expect(defaultRowFor(entry("user/profile.md")).reviewFlows).toBe("all");
  });

  it("derives area name for other user/ files", () => {
    expect(defaultRowFor(entry("user/work.md"))).toEqual({
      path: "user/work.md",
      purpose: "User work",
      reviewFlows: "morning, monthly",
      lastTouched: TODAY,
    });
  });

  it("picks up H1 over path-derived purpose", () => {
    expect(
      defaultRowFor(entry("projects/alpha.md", TODAY, "Project Alpha — Q2")).purpose,
    ).toBe("Project Alpha — Q2");
  });

  it("defaults rules/ rows to all", () => {
    expect(defaultRowFor(entry("rules/management.md"))).toEqual({
      path: "rules/management.md",
      purpose: "Rule: management",
      reviewFlows: "all",
      lastTouched: TODAY,
    });
  });

  it("matches cadence flow for routines/<cadence>.md", () => {
    expect(defaultRowFor(entry("routines/hourly.md")).reviewFlows).toBe("hourly");
    expect(defaultRowFor(entry("routines/morning.md")).reviewFlows).toBe("morning");
    expect(defaultRowFor(entry("routines/evening.md")).reviewFlows).toBe("evening");
    expect(defaultRowFor(entry("routines/weekly.md")).reviewFlows).toBe("weekly");
    expect(defaultRowFor(entry("routines/monthly.md")).reviewFlows).toBe("monthly");
  });

  it("defaults unknown-cadence routines to - without crashing", () => {
    expect(defaultRowFor(entry("routines/mystery.md")).reviewFlows).toBe("-");
  });

  it("defaults projects/ rows to weekly/monthly/roadmap", () => {
    expect(defaultRowFor(entry("projects/alpha.md")).reviewFlows).toBe(
      "weekly, monthly, roadmap",
    );
  });

  it("maps dossiers/<flow>.md to the matching flow", () => {
    expect(defaultRowFor(entry("dossiers/hourly.md")).reviewFlows).toBe("hourly");
    expect(defaultRowFor(entry("dossiers/roadmap.md")).reviewFlows).toBe("roadmap");
  });

  it("falls back to - for unknown dossier flow", () => {
    expect(defaultRowFor(entry("dossiers/weird.md")).reviewFlows).toBe("-");
  });

  it("defaults rolling journals to -", () => {
    expect(defaultRowFor(entry("daily/2026-04-21.md")).reviewFlows).toBe("-");
    expect(defaultRowFor(entry("weekly/2026-W16.md")).reviewFlows).toBe("-");
    expect(defaultRowFor(entry("monthly/2026-04.md")).reviewFlows).toBe("-");
    expect(defaultRowFor(entry("daily/2026-04-21.md")).purpose).toBe(
      "Synthesized daily journal",
    );
    expect(defaultRowFor(entry("weekly/2026-W16.md")).purpose).toBe(
      "Weekly review artifact",
    );
    expect(defaultRowFor(entry("monthly/2026-04.md")).purpose).toBe(
      "Monthly review artifact",
    );
  });

  it("falls back to - for any path outside the known set", () => {
    expect(defaultRowFor(entry("oddball.md")).reviewFlows).toBe("-");
  });

  it("stores pipe characters verbatim — escape is a render-time concern", () => {
    const escaped = defaultRowFor(entry("projects/foo.md", TODAY, "a|b"));
    expect(escaped.purpose).toBe("a|b");
    const empty = defaultRowFor(entry("projects/foo.md", TODAY, " "));
    expect(empty.purpose).toBe("Project foo");
  });

  it("falls back to - when the file's cadence token is unknown", () => {
    const result = defaultRowFor(entry("routines/mystery.md"));
    expect(result.reviewFlows).toBe("-");
  });

  it("falls through to the path-derived default when the H1 is absent", () => {
    expect(defaultRowFor(entry("agent/journal.md")).purpose).toBe(
      "Agent self-reflection log",
    );
    expect(defaultRowFor(entry("user/profile.md")).purpose).toBe(
      "User identity, preferences, communication style",
    );
    expect(defaultRowFor(entry("unknown/foo.md")).purpose).toBe("unknown/foo.md");
    expect(defaultRowFor(entry("unknown/foo.md", TODAY, "Foo Title")).purpose).toBe(
      "Foo Title",
    );
  });

  it("normalizes whitespace-only review flow tokens down to -", () => {
    // Internal branch: the default-cells builder passes a single-token string
    // that isn't in the vocabulary; normalizeFlowsCell reduces it to `-`.
    expect(defaultRowFor(entry("routines/standup.md")).reviewFlows).toBe("-");
  });
});

describe("normalization helpers (via defaultRowFor edge cases)", () => {
  it("capitalize handles empty routine slug", () => {
    // When a routines/.md file is somehow named without a slug, the
    // capitalize helper is invoked with an empty string and must not throw.
    const result = defaultRowFor(entry("routines/.md"));
    expect(result.path).toBe("routines/.md");
    // routines/ with empty cadence is not in REVIEW_FLOW_VOCAB so review
    // flow falls back to `-`.
    expect(result.reviewFlows).toBe("-");
  });
});

describe("reconcileContextIndex", () => {
  it("returns noOp when snapshot and rows match exactly", () => {
    const snapshot = [entry("today.md"), entry("projects/alpha.md")];
    const current = [
      row("today.md", { purpose: "Today", reviewFlows: "morning" }),
      row("projects/alpha.md", { purpose: "Alpha", reviewFlows: "weekly" }),
    ];
    const result = reconcileContextIndex(snapshot, current);
    expect(result.noOp).toBe(true);
    expect(result.added).toEqual([]);
    expect(result.removed).toEqual([]);
    expect(result.refreshedMtime).toEqual([]);
    expect(result.rows).toEqual(current);
  });

  it("adds rows for new files with defaults", () => {
    const snapshot = [entry("today.md"), entry("projects/alpha.md", TODAY, "Alpha")];
    const current = [row("today.md")];
    const result = reconcileContextIndex(snapshot, current);
    expect(result.noOp).toBe(false);
    expect(result.added).toEqual(["projects/alpha.md"]);
    expect(result.rows).toHaveLength(2);
    expect(result.rows[1].path).toBe("projects/alpha.md");
    expect(result.rows[1].purpose).toBe("Alpha");
    expect(result.rows[1].reviewFlows).toBe("weekly, monthly, roadmap");
  });

  it("removes rows whose files are absent", () => {
    const snapshot = [entry("today.md")];
    const current = [row("today.md"), row("projects/legacy.md")];
    const result = reconcileContextIndex(snapshot, current);
    expect(result.removed).toEqual(["projects/legacy.md"]);
    expect(result.rows.map((r) => r.path)).toEqual(["today.md"]);
  });

  it("refreshes mtime without touching purpose or review flows", () => {
    const snapshot = [entry("user/profile.md", "2026-04-22")];
    const current = [
      row("user/profile.md", {
        purpose: "Custom user label",
        reviewFlows: "all",
        lastTouched: "2026-04-17",
      }),
    ];
    const result = reconcileContextIndex(snapshot, current);
    expect(result.refreshedMtime).toEqual(["user/profile.md"]);
    expect(result.rows[0]).toEqual({
      path: "user/profile.md",
      purpose: "Custom user label",
      reviewFlows: "all",
      lastTouched: "2026-04-22",
    });
  });

  it("preserves row ordering for existing rows and appends additions sorted", () => {
    const snapshot = [
      entry("today.md"),
      entry("projects/b.md"),
      entry("projects/a.md"),
    ];
    const current = [row("today.md")];
    const result = reconcileContextIndex(snapshot, current);
    expect(result.rows.map((r) => r.path)).toEqual([
      "today.md",
      "projects/a.md",
      "projects/b.md",
    ]);
  });

  it("drops duplicate current rows with missing snapshot entry without duplicate adds", () => {
    const snapshot = [entry("today.md")];
    const current = [row("today.md"), row("gone.md"), row("gone.md")];
    const result = reconcileContextIndex(snapshot, current);
    expect(result.removed).toEqual(["gone.md", "gone.md"]);
    expect(result.rows.map((r) => r.path)).toEqual(["today.md"]);
  });
});

describe("renderContextIndex", () => {
  it("produces valid frontmatter and a single-table body that round-trips", () => {
    const rows: ContextIndexRow[] = [
      {
        path: "today.md",
        purpose: "Today",
        reviewFlows: "hourly, morning, evening",
        lastTouched: TODAY,
      },
      {
        path: "projects/alpha.md",
        purpose: "Alpha",
        reviewFlows: "weekly, monthly, roadmap",
        lastTouched: TODAY,
      },
    ];
    const rendered = renderContextIndex(rows, TODAY);
    expect(rendered.startsWith("---\ntype: index\nowner: agent\nupdated: " + TODAY)).toBe(true);
    expect(rendered).toContain("# Context Index");
    expect(rendered).toContain("| `today.md` |");
    const parsed = parseContextIndexRows(rendered);
    expect(parsed).toEqual(rows);
  });

  it("escapes pipe characters in purpose", () => {
    const rendered = renderContextIndex(
      [
        {
          path: "projects/weird.md",
          purpose: "has | pipe",
          reviewFlows: "-",
          lastTouched: TODAY,
        },
      ],
      TODAY,
    );
    expect(rendered).toContain("has \\| pipe");
  });

  it("output passes validateContextFileFrontmatter — guards against reconciler writing 422-bound content (§7.2)", () => {
    const rows: ContextIndexRow[] = [
      {
        path: "today.md",
        purpose: "Today",
        reviewFlows: "hourly, morning, evening",
        lastTouched: TODAY,
      },
    ];
    const rendered = renderContextIndex(rows, TODAY);
    expect(
      validateContextFileFrontmatter(rendered, CONTEXT_RELATIVE_PATHS.contextIndex),
    ).toBeNull();
  });

  it("output still validates when rows is empty (missing-file recovery path)", () => {
    const rendered = renderContextIndex([], TODAY);
    expect(
      validateContextFileFrontmatter(rendered, CONTEXT_RELATIVE_PATHS.contextIndex),
    ).toBeNull();
  });
});
