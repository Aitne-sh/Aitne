import { describe, expect, it } from "vitest";
import {
  filterAgents,
  partitionByValidity,
  sortAgents,
  type AgentListFilterState,
} from "./list-view";
import type { AgentListItem } from "./types";

function item(overrides: Partial<AgentListItem>): AgentListItem {
  return {
    slug: "x",
    name: "X",
    description: "",
    kind: "user",
    category: "user",
    enabled: true,
    tags: [],
    schedule: { kind: "cron", expression: "0 9 * * *", timezone: "UTC" },
    process_key: "agent.task",
    last_execution: null,
    metrics_7d: { executions: 0, error_rate: null, avg_cost_usd: null, criteria_hit_rate: null },
    stop_warning: null,
    invalid: false,
    ...overrides,
  };
}

const filter = (over: Partial<AgentListFilterState>): AgentListFilterState => ({
  search: "",
  kind: "all",
  status: "all",
  cadence: "all",
  ...over,
});

describe("filterAgents", () => {
  const items = [
    item({ slug: "morning-routine", name: "Morning Routine", kind: "builtin", enabled: true, tags: ["daily"] }),
    item({ slug: "weekly-bookmarks", name: "Weekly Bookmarks", kind: "user", enabled: false, tags: ["reading"] }),
  ];

  it("filters by kind", () => {
    expect(filterAgents(items, filter({ kind: "builtin" })).map((i) => i.slug)).toEqual(["morning-routine"]);
    expect(filterAgents(items, filter({ kind: "user" })).map((i) => i.slug)).toEqual(["weekly-bookmarks"]);
  });

  it("filters by enabled status", () => {
    expect(filterAgents(items, filter({ status: "enabled" })).map((i) => i.slug)).toEqual(["morning-routine"]);
    expect(filterAgents(items, filter({ status: "disabled" })).map((i) => i.slug)).toEqual(["weekly-bookmarks"]);
  });

  it("searches slug / name / description / tags case-insensitively", () => {
    expect(filterAgents(items, filter({ search: "MORNING" })).map((i) => i.slug)).toEqual(["morning-routine"]);
    expect(filterAgents(items, filter({ search: "reading" })).map((i) => i.slug)).toEqual(["weekly-bookmarks"]);
    expect(filterAgents(items, filter({ search: "nomatch" }))).toEqual([]);
    expect(filterAgents(items, filter({ search: "  " })).length).toBe(2);
  });

  it("combines filters (AND)", () => {
    expect(
      filterAgents(items, filter({ kind: "builtin", status: "disabled" })),
    ).toEqual([]);
  });

  it("filters by cadence (interval vs scheduled)", () => {
    const cadenceItems = [
      // Runtime-window built-in: structured interval present.
      item({
        slug: "activity-scan",
        schedule: {
          kind: "cron",
          expression: "0 4-23 * * *",
          timezone: "UTC",
          interval: { interval_minutes: 60, active_start_hour: 4, active_end_hour: 24 },
        },
      }),
      // Fixed daily time.
      item({ slug: "morning-routine", schedule: { kind: "cron", expression: "0 4 * * *", timezone: "UTC" } }),
      // User interval cron (*/30).
      item({ slug: "poller", schedule: { kind: "cron", expression: "*/30 * * * *", timezone: "UTC" } }),
    ];
    expect(filterAgents(cadenceItems, filter({ cadence: "interval" })).map((i) => i.slug)).toEqual([
      "activity-scan",
      "poller",
    ]);
    expect(filterAgents(cadenceItems, filter({ cadence: "scheduled" })).map((i) => i.slug)).toEqual([
      "morning-routine",
    ]);
    expect(filterAgents(cadenceItems, filter({ cadence: "all" })).length).toBe(3);
  });
});

describe("sortAgents", () => {
  it("sorts by last-run descending (default), never-run last", () => {
    const items = [
      item({ slug: "never" }),
      item({ slug: "old", last_execution: { id: 1, started_at: "2026-05-01T00:00:00Z", ended_at: null, result: "success", cost_usd: null, output_summary: null } }),
      item({ slug: "recent", last_execution: { id: 2, started_at: "2026-05-26T00:00:00Z", ended_at: null, result: "success", cost_usd: null, output_summary: null } }),
    ];
    expect(sortAgents(items, "last", "desc").map((i) => i.slug)).toEqual(["recent", "old", "never"]);
    expect(sortAgents(items, "last", "asc").map((i) => i.slug)).toEqual(["never", "old", "recent"]);
  });

  it("keeps multiple never-run agents in stable input order (fresh-install case)", () => {
    // Every Agent never-run → all -Infinity. The comparator must not produce
    // NaN (which would bypass the explicit index tiebreak); order is preserved
    // in both directions because never-run rows are mutually tied.
    const items = [item({ slug: "a" }), item({ slug: "b" }), item({ slug: "c" })];
    expect(sortAgents(items, "last", "desc").map((i) => i.slug)).toEqual(["a", "b", "c"]);
    expect(sortAgents(items, "last", "asc").map((i) => i.slug)).toEqual(["a", "b", "c"]);
  });

  it("sorts by name", () => {
    const items = [item({ slug: "b", name: "Beta" }), item({ slug: "a", name: "alpha" })];
    expect(sortAgents(items, "name", "asc").map((i) => i.slug)).toEqual(["a", "b"]);
    expect(sortAgents(items, "name", "desc").map((i) => i.slug)).toEqual(["b", "a"]);
  });

  it("sorts by error rate with unknown rate last (asc)", () => {
    const items = [
      item({ slug: "unknown" }),
      item({ slug: "low", metrics_7d: { executions: 5, error_rate: 0.1, avg_cost_usd: null, criteria_hit_rate: null } }),
      item({ slug: "high", metrics_7d: { executions: 5, error_rate: 0.9, avg_cost_usd: null, criteria_hit_rate: null } }),
    ];
    // -1 (unknown) < 0.1 < 0.9
    expect(sortAgents(items, "errorRate", "asc").map((i) => i.slug)).toEqual(["unknown", "low", "high"]);
  });

  it("sorts by cost and status", () => {
    const items = [
      item({ slug: "disabled", enabled: false }),
      item({ slug: "enabled", enabled: true }),
    ];
    expect(sortAgents(items, "status", "asc").map((i) => i.slug)).toEqual(["enabled", "disabled"]);
    const byCost = [
      item({ slug: "cheap", metrics_7d: { executions: 1, error_rate: null, avg_cost_usd: 0.01, criteria_hit_rate: null } }),
      item({ slug: "pricey", metrics_7d: { executions: 1, error_rate: null, avg_cost_usd: 0.5, criteria_hit_rate: null } }),
    ];
    expect(sortAgents(byCost, "cost", "desc").map((i) => i.slug)).toEqual(["pricey", "cheap"]);
  });

  it("sorts by schedule expression lexicographically (groups by cron string)", () => {
    const items = [
      item({ slug: "evening", schedule: { kind: "cron", expression: "0 18 * * *", timezone: "UTC" } }),
      item({ slug: "morning", schedule: { kind: "cron", expression: "0 4 * * *", timezone: "UTC" } }),
    ];
    // Lexicographic, not chronological: "0 18..." sorts before "0 4...".
    expect(sortAgents(items, "schedule", "asc").map((i) => i.slug)).toEqual(["evening", "morning"]);
    // Falls back to the kind when there is no expression.
    const noExpr = [
      item({ slug: "z", schedule: { kind: "one_shot", expression: null, timezone: "UTC" } }),
      item({ slug: "a", schedule: { kind: "cron", expression: "5 5 * * *", timezone: "UTC" } }),
    ];
    expect(sortAgents(noExpr, "schedule", "asc").map((i) => i.slug)).toEqual(["a", "z"]);
  });

  it("is stable on ties and does not mutate the input", () => {
    const items = [item({ slug: "a", name: "Same" }), item({ slug: "b", name: "Same" })];
    const frozen = [...items];
    expect(sortAgents(items, "name", "asc").map((i) => i.slug)).toEqual(["a", "b"]);
    expect(sortAgents(items, "name", "desc").map((i) => i.slug)).toEqual(["a", "b"]);
    expect(items).toEqual(frozen);
  });

  it("sorts by kind", () => {
    const items = [item({ slug: "u", kind: "user" }), item({ slug: "b", kind: "builtin" })];
    expect(sortAgents(items, "kind", "asc").map((i) => i.slug)).toEqual(["b", "u"]);
  });
});

describe("partitionByValidity", () => {
  it("splits invalid from valid", () => {
    const items = [item({ slug: "ok" }), item({ slug: "bad", invalid: true }), item({ slug: "ok2" })];
    const { invalid, valid } = partitionByValidity(items);
    expect(invalid.map((i) => i.slug)).toEqual(["bad"]);
    expect(valid.map((i) => i.slug)).toEqual(["ok", "ok2"]);
  });
});
