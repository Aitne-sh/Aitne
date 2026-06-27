import { describe, expect, it } from "vitest";

import { CATEGORY_META, CATEGORY_ORDER, groupByCategory } from "./categories";
import type { AgentCategory, AgentListItem } from "./types";

function item(
  slug: string,
  category: AgentCategory | undefined,
  kind: "builtin" | "user" = "builtin",
  name = slug,
): AgentListItem {
  return {
    slug,
    name,
    description: "",
    kind,
    category: category as AgentCategory,
    enabled: true,
    tags: [],
    schedule: { kind: "cron", expression: "0 4 * * *", timezone: "UTC" },
    process_key: null,
    last_execution: null,
    metrics_7d: { executions: 0, error_rate: null, avg_cost_usd: null, criteria_hit_rate: null },
    stop_warning: null,
    invalid: false,
  };
}

describe("groupByCategory", () => {
  it("emits sections in the fixed order, dropping empty ones", () => {
    const groups = groupByCategory([
      item("my-agent", "user", "user"),
      item("activity-scan", "monitoring"),
      item("morning-routine", "synthesis"),
    ]);
    expect(groups.map((g) => g.category)).toEqual(["synthesis", "monitoring", "user"]);
    expect(groups.every((g) => g.meta === CATEGORY_META[g.category])).toBe(true);
  });

  it("orders synthesis builtins in day order, not alphabetically", () => {
    const groups = groupByCategory([
      item("weekly-review", "synthesis"),
      item("monthly-review", "synthesis"),
      item("evening-review", "synthesis"),
      item("morning-routine", "synthesis"),
    ]);
    expect(groups[0].items.map((i) => i.slug)).toEqual([
      "morning-routine",
      "evening-review",
      "weekly-review",
      "monthly-review",
    ]);
  });

  it("sorts unranked items by name after curated ones", () => {
    const groups = groupByCategory([
      item("zeta", "user", "user", "Zeta"),
      item("alpha", "user", "user", "Alpha"),
    ]);
    expect(groups[0].items.map((i) => i.slug)).toEqual(["alpha", "zeta"]);
  });

  it("falls back when category is missing (older daemon): user→user, builtin→maintenance", () => {
    const groups = groupByCategory([
      item("legacy-user", undefined, "user"),
      item("legacy-builtin", undefined, "builtin"),
    ]);
    expect(groups.map((g) => g.category)).toEqual(["maintenance", "user"]);
    expect(groups[0].items[0].slug).toBe("legacy-builtin");
    expect(groups[1].items[0].slug).toBe("legacy-user");
  });

  it("CATEGORY_ORDER covers every CATEGORY_META key", () => {
    expect([...CATEGORY_ORDER].sort()).toEqual(Object.keys(CATEGORY_META).sort());
  });
});
