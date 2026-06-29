import { describe, expect, it } from "vitest";
import {
  filterAgents,
  partitionByValidity,
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

describe("partitionByValidity", () => {
  it("splits invalid from valid", () => {
    const items = [item({ slug: "ok" }), item({ slug: "bad", invalid: true }), item({ slug: "ok2" })];
    const { invalid, valid } = partitionByValidity(items);
    expect(invalid.map((i) => i.slug)).toEqual(["bad"]);
    expect(valid.map((i) => i.slug)).toEqual(["ok", "ok2"]);
  });
});
