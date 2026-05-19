import { describe, it, expect } from "vitest";
import {
  ACTIVITY_VIEW_WINDOW_DAYS,
  activityFileSlugFor,
  relativeActivityPath,
  renderActivityView,
  sortEntityActivityRows,
  sortRecentlyChangedRows,
  windowCutoffDate,
  type ActivitySnapshot,
  type EntityActivityInput,
  type RecentlyChangedInput,
} from "./activity-view-reconciler.js";

/**
 * docs/design/21-management-registry-and-entities.md §17 — pure-logic
 * tests for the activity-view reconciler. Covers slug normalisation,
 * snapshot bucketing, and §9.6 markdown render. The driver layer
 * (`activity-view-runner.ts`) is excluded from coverage gating per
 * vitest.config.ts (FS + DB I/O).
 */

describe("activityFileSlugFor", () => {
  it("normalises label + collapses whitespace into kebab-case", () => {
    expect(activityFileSlugFor("Google Docs")).toBe("google-docs");
    expect(activityFileSlugFor("ZOOM")).toBe("zoom");
    expect(activityFileSlugFor("My Tracker!")).toBe("my-tracker");
  });

  it("returns null when the input has no usable characters", () => {
    expect(activityFileSlugFor("***")).toBeNull();
    expect(activityFileSlugFor("")).toBeNull();
  });

  it("collapses repeated separators + trims leading/trailing dashes", () => {
    expect(activityFileSlugFor("- foo - bar -")).toBe("foo-bar");
  });
});

describe("relativeActivityPath", () => {
  it("returns _activity/<slug>.md", () => {
    expect(relativeActivityPath("zoom")).toBe("_activity/zoom.md");
  });
});

describe("windowCutoffDate", () => {
  it("subtracts the window from now", () => {
    const now = new Date("2026-12-05T00:00:00Z");
    expect(windowCutoffDate(now, 90)).toBe("2026-09-06");
  });
  it("uses ACTIVITY_VIEW_WINDOW_DAYS as the v3 default", () => {
    expect(ACTIVITY_VIEW_WINDOW_DAYS).toBe(90);
  });
});

describe("sortEntityActivityRows", () => {
  const a: EntityActivityInput = {
    date: "2026-12-04",
    timeRange: "10:00–11:00",
    title: "Foo",
    entityRelativePath: "work/meetings/foo.md",
    details: [],
    mtId: null,
    fetchedAt: null,
  };
  const b: EntityActivityInput = {
    ...a,
    title: "Bar",
    entityRelativePath: "work/meetings/bar.md",
    timeRange: "09:00–10:00",
  };
  const c: EntityActivityInput = {
    ...a,
    date: "2026-12-03",
    title: "Baz",
    entityRelativePath: "work/meetings/baz.md",
  };
  const d: EntityActivityInput = {
    ...a,
    title: "Bin",
    timeRange: null,
    entityRelativePath: "work/meetings/bin.md",
  };

  it("sorts by date desc, then time asc, then title asc", () => {
    const out = sortEntityActivityRows([a, b, c, d]);
    expect(out.map((e) => e.title)).toEqual(["Bar", "Foo", "Bin", "Baz"]);
  });

  it("places nulls last regardless of input order", () => {
    // Force the comparator to be called with (string, null) and (null,
    // string) so both null-handling branches are exercised.
    const x: EntityActivityInput = {
      ...a,
      timeRange: "10:00–11:00",
      title: "Timed",
      entityRelativePath: "x.md",
    };
    const y: EntityActivityInput = {
      ...a,
      timeRange: null,
      title: "Untimed",
      entityRelativePath: "y.md",
    };
    expect(sortEntityActivityRows([x, y]).map((e) => e.title)).toEqual([
      "Timed",
      "Untimed",
    ]);
    expect(sortEntityActivityRows([y, x]).map((e) => e.title)).toEqual([
      "Timed",
      "Untimed",
    ]);
  });

  it("falls back to title sort when both rows have null timeRange", () => {
    const x: EntityActivityInput = { ...a, timeRange: null, title: "Bee", entityRelativePath: "x.md" };
    const y: EntityActivityInput = { ...a, timeRange: null, title: "Ant", entityRelativePath: "y.md" };
    const out = sortEntityActivityRows([x, y]);
    expect(out.map((e) => e.title)).toEqual(["Ant", "Bee"]);
  });

  it("falls back to title sort when both rows share date+time", () => {
    const x: EntityActivityInput = {
      ...a,
      timeRange: "10:00–11:00",
      title: "Zed",
      entityRelativePath: "x.md",
    };
    const y: EntityActivityInput = {
      ...a,
      timeRange: "10:00–11:00",
      title: "Apple",
      entityRelativePath: "y.md",
    };
    const out = sortEntityActivityRows([x, y]);
    expect(out.map((e) => e.title)).toEqual(["Apple", "Zed"]);
  });
});

describe("sortRecentlyChangedRows", () => {
  it("sorts by date desc, then mtId asc (null sorts first)", () => {
    const rows: RecentlyChangedInput[] = [
      { date: "2026-12-01", mtId: "mt_2", actionType: "x", note: null },
      { date: "2026-12-04", mtId: "mt_1", actionType: "x", note: null },
      { date: "2026-12-04", mtId: null, actionType: "x", note: null },
    ];
    const out = sortRecentlyChangedRows(rows);
    expect(out.map((r) => `${r.date}/${r.mtId ?? "-"}`)).toEqual([
      "2026-12-04/-",
      "2026-12-04/mt_1",
      "2026-12-01/mt_2",
    ]);
  });

  it("treats two non-null mtIds as a normal lexicographic compare", () => {
    const out = sortRecentlyChangedRows([
      { date: "2026-12-04", mtId: "mt_2", actionType: "x", note: null },
      { date: "2026-12-04", mtId: "mt_1", actionType: "x", note: null },
    ]);
    expect(out.map((r) => r.mtId)).toEqual(["mt_1", "mt_2"]);
  });

  it("treats two null mtIds as equal under the secondary sort", () => {
    const rows: RecentlyChangedInput[] = [
      { date: "2026-12-04", mtId: null, actionType: "x", note: "first" },
      { date: "2026-12-04", mtId: null, actionType: "x", note: "second" },
    ];
    // Both `??` branches fire when both sides are null.
    const out = sortRecentlyChangedRows(rows);
    expect(out).toHaveLength(2);
  });
});

describe("renderActivityView", () => {
  const baseSnapshot: ActivitySnapshot = {
    source: "Zoom",
    sourceNormalized: "zoom",
    activeTasks: [],
    recentlyChanged: [],
    entities: [],
  };

  it("renders the §9.6 layout with all sections", () => {
    const snapshot: ActivitySnapshot = {
      ...baseSnapshot,
      activeTasks: [
        {
          mtId: "mt_43",
          cadence: "daily 10:00 (Asia/Tokyo)",
          lastRunAt: "2026-12-04T10:00Z",
          lastResult: "ok (3 new)",
        },
      ],
      recentlyChanged: [
        {
          date: "2026-11-15",
          mtId: "mt_27",
          actionType: "management_task.deleted",
          note: null,
        },
        {
          date: "2026-11-10",
          mtId: "mt_43",
          actionType: "management_task.modified",
          note: "weekly → daily",
        },
      ],
      entities: [
        {
          date: "2026-12-04",
          timeRange: "14:00–15:00",
          title: "Foo 1on1",
          entityRelativePath: "work/meetings/2026-12-04-foo-1on1.md",
          details: ["duration 60min", "recording zm_xyz789"],
          mtId: "mt_43",
          fetchedAt: "2026-12-05T10:00:00Z",
        },
      ],
    };
    const out = renderActivityView(snapshot, "2026-12-05T03:45:00Z");
    expect(out).toMatchInlineSnapshot(`
      "---
      type: activity-log
      source: zoom
      auto_generated: true
      window_days: 90
      last_built: 2026-12-05T03:45:00Z
      ---
      # Zoom — Activity (last 90 days)

      ## Active managed tasks

      - mt_43 daily 10:00 (Asia/Tokyo) — last 2026-12-04T10:00Z ok (3 new)

      ## Recently changed (90d)

      - 2026-11-15 mt_27 stopped by user
      - 2026-11-10 mt_43 modified (weekly → daily)

      ## 2026-12-04

      - 14:00–15:00 [Foo 1on1](../work/meetings/2026-12-04-foo-1on1.md)
        duration 60min · recording zm_xyz789 · fetched by mt_43 @ 2026-12-05T10:00:00Z

      "
    `);
  });

  it("renders empty-state placeholders when there is no data", () => {
    const out = renderActivityView(baseSnapshot, "2026-12-05T00:00:00Z");
    expect(out).toContain("_No active managed tasks for this source._");
    expect(out).toContain("_No recent changes._");
    expect(out).toContain("_No entries yet");
  });

  it("falls back to 'never run' when an active task has no last_run_at", () => {
    const out = renderActivityView(
      {
        ...baseSnapshot,
        activeTasks: [
          {
            mtId: "mt_1",
            cadence: "daily 10:00",
            lastRunAt: null,
            lastResult: null,
          },
        ],
      },
      "2026-12-05T00:00:00Z",
    );
    expect(out).toContain("- mt_1 daily 10:00 — never run");
  });

  it("uses 'ok' as the default last_result when omitted", () => {
    const out = renderActivityView(
      {
        ...baseSnapshot,
        activeTasks: [
          {
            mtId: "mt_2",
            cadence: "weekly",
            lastRunAt: "2026-12-01T10:00Z",
            lastResult: null,
          },
        ],
      },
      "2026-12-05T00:00:00Z",
    );
    expect(out).toContain("- mt_2 weekly — last 2026-12-01T10:00Z ok");
  });

  it("renders unknown action types using the verbatim type", () => {
    const out = renderActivityView(
      {
        ...baseSnapshot,
        recentlyChanged: [
          {
            date: "2026-12-01",
            mtId: "mt_5",
            actionType: "management_task.exotic_verb",
            note: null,
          },
        ],
      },
      "2026-12-05T00:00:00Z",
    );
    expect(out).toContain("- 2026-12-01 mt_5 management_task.exotic_verb");
  });

  it("renders an em-dash for an unknown mtId in recently-changed", () => {
    const out = renderActivityView(
      {
        ...baseSnapshot,
        recentlyChanged: [
          {
            date: "2026-12-01",
            mtId: null,
            actionType: "management_task.created",
            note: null,
          },
        ],
      },
      "2026-12-05T00:00:00Z",
    );
    expect(out).toContain("- 2026-12-01 — registered");
  });

  it("renders entity rows without time-range or fetched_by metadata", () => {
    const out = renderActivityView(
      {
        ...baseSnapshot,
        entities: [
          {
            date: "2026-12-04",
            timeRange: null,
            title: "Bare entity",
            entityRelativePath: "work/meetings/bare.md",
            details: [],
            mtId: null,
            fetchedAt: null,
          },
        ],
      },
      "2026-12-05T00:00:00Z",
    );
    expect(out).toContain("- [Bare entity](../work/meetings/bare.md)");
    expect(out).not.toContain("fetched by");
  });

  it("renders the fetched-by tag without a fetchedAt stamp", () => {
    const out = renderActivityView(
      {
        ...baseSnapshot,
        entities: [
          {
            date: "2026-12-04",
            timeRange: null,
            title: "T",
            entityRelativePath: "work/meetings/t.md",
            details: [],
            mtId: "mt_9",
            fetchedAt: null,
          },
        ],
      },
      "2026-12-05T00:00:00Z",
    );
    expect(out).toContain("fetched by mt_9");
    expect(out).not.toContain("@");
  });

  it("groups entities by day in input order", () => {
    const snapshot: ActivitySnapshot = {
      ...baseSnapshot,
      entities: [
        {
          date: "2026-12-04",
          timeRange: null,
          title: "A",
          entityRelativePath: "work/meetings/a.md",
          details: [],
          mtId: null,
          fetchedAt: null,
        },
        {
          date: "2026-12-04",
          timeRange: null,
          title: "B",
          entityRelativePath: "work/meetings/b.md",
          details: [],
          mtId: null,
          fetchedAt: null,
        },
        {
          date: "2026-12-03",
          timeRange: null,
          title: "C",
          entityRelativePath: "work/meetings/c.md",
          details: [],
          mtId: null,
          fetchedAt: null,
        },
      ],
    };
    const out = renderActivityView(snapshot, "2026-12-05T00:00:00Z");
    const dec4Index = out.indexOf("## 2026-12-04");
    const dec3Index = out.indexOf("## 2026-12-03");
    expect(dec4Index).toBeGreaterThan(0);
    expect(dec3Index).toBeGreaterThan(dec4Index);
  });

  it("renders a deterministic byte-identical output for the same input", () => {
    const snapshot: ActivitySnapshot = {
      ...baseSnapshot,
      activeTasks: [
        {
          mtId: "mt_1",
          cadence: "daily",
          lastRunAt: "2026-12-04T10:00Z",
          lastResult: "ok",
        },
      ],
    };
    const a = renderActivityView(snapshot, "2026-12-05T00:00:00Z");
    const b = renderActivityView(snapshot, "2026-12-05T00:00:00Z");
    expect(a).toBe(b);
  });
});
