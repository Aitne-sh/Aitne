import { describe, it, expect } from "vitest";
import {
  boardStats,
  groupTasksByKind,
  kindLabel,
  originLabel,
  KIND_ORDER,
  humanizeCadence,
  parseUtcTimestamp,
  formatTaskTime,
  manageHref,
  manageLabel,
} from "./view.js";
import type { TaskBoardItem, TaskKind } from "./types.js";

function item(over: Partial<TaskBoardItem> & { ref: string; kind: TaskKind }): TaskBoardItem {
  return {
    title: over.ref,
    status: "active",
    cadence: null,
    fulfilledBy: over.ref,
    origin: "user",
    lastResult: null,
    lastRunAt: null,
    nextRunAt: null,
    ...over,
  };
}

describe("labels", () => {
  it("labels every kind and origin", () => {
    for (const kind of KIND_ORDER) expect(kindLabel(kind).length).toBeGreaterThan(0);
    expect(originLabel("system")).toBe("System");
    expect(originLabel("user")).toBe("You");
    expect(originLabel("agent")).toBe("Agent");
  });
});

describe("groupTasksByKind", () => {
  it("groups in KIND_ORDER, drops empty groups, keeps within-kind order", () => {
    const items = [
      item({ ref: "bx:c", kind: "browser" }),
      item({ ref: "rs:7", kind: "dm" }),
      item({ ref: "rs:42", kind: "dm" }),
      item({ ref: "agent:a", kind: "agent" }),
    ];
    const groups = groupTasksByKind(items);
    expect(groups.map((g) => g.kind)).toEqual(["dm", "agent", "browser"]);
    expect(groups[0].items.map((i) => i.ref)).toEqual(["rs:7", "rs:42"]); // server order kept
    expect(groups[0].label).toBe("Recurring DMs");
  });

  it("returns no groups for an empty board", () => {
    expect(groupTasksByKind([])).toEqual([]);
  });

  it("surfaces an unknown kind after the known ones", () => {
    const items = [
      item({ ref: "rs:1", kind: "dm" }),
      item({ ref: "x:1", kind: "mystery" as TaskKind }),
    ];
    const groups = groupTasksByKind(items);
    expect(groups.map((g) => g.kind)).toEqual(["dm", "mystery"]);
    expect(groups[1].label).toBe("mystery");
  });
});

describe("humanizeCadence", () => {
  it("humanizes raw cron expressions", () => {
    expect(humanizeCadence("0 4-22/2 * * *")).toBe("Every 2h, 04:00–22:00");
    expect(humanizeCadence("0 18 * * *")).toBe("Every day at 18:00");
    expect(humanizeCadence("45 17 * * *")).toBe("Every day at 17:45");
  });

  it("passes friendly labels through untouched", () => {
    expect(humanizeCadence("Daily at 19:00")).toBe("Daily at 19:00");
    expect(humanizeCadence("daily 10:00 (Asia/Tokyo)")).toBe("daily 10:00 (Asia/Tokyo)");
    expect(humanizeCadence("one-off")).toBe("one-off");
    expect(humanizeCadence("nightly")).toBe("nightly");
  });

  it("returns null for null / blank", () => {
    expect(humanizeCadence(null)).toBeNull();
    expect(humanizeCadence("   ")).toBeNull();
  });
});

describe("parseUtcTimestamp", () => {
  it("reads a bare SQLite datetime as UTC (not browser-local)", () => {
    expect(parseUtcTimestamp("2026-07-02 02:00:00")?.toISOString()).toBe("2026-07-02T02:00:00.000Z");
  });

  it("respects an explicit zone", () => {
    expect(parseUtcTimestamp("2026-07-02T02:00:00.000Z")?.toISOString()).toBe("2026-07-02T02:00:00.000Z");
  });

  it("returns null for null / blank / unparseable", () => {
    expect(parseUtcTimestamp(null)).toBeNull();
    expect(parseUtcTimestamp("  ")).toBeNull();
    expect(parseUtcTimestamp("not a date")).toBeNull();
  });
});

describe("formatTaskTime", () => {
  const now = new Date("2026-07-01T16:00:00Z");

  it("renders the absolute time in the viewer's timezone + a relative hint", () => {
    // 02:00 UTC = 11:00 the same day in Asia/Tokyo (UTC+9).
    const out = formatTaskTime("2026-07-02 02:00:00", { now, timeZone: "Asia/Tokyo", locale: "en-US" });
    expect(out?.absolute).toBe("Jul 2, 11:00 AM");
    expect(out?.relative).toBe("in about 10 hours");
    expect(out?.iso).toBe("2026-07-02T02:00:00.000Z");
  });

  it("returns null when there is no timestamp", () => {
    expect(formatTaskTime(null)).toBeNull();
  });
});

describe("manageHref / manageLabel", () => {
  const it0 = (over: Partial<TaskBoardItem> & { ref: string; kind: TaskKind }) => item(over);

  it("routes each kind to its owning surface", () => {
    expect(manageHref(it0({ ref: "agent:morning-routine", kind: "agent" }))).toBe("/agents/morning-routine");
    // dm / reminder are managed on the Tasks page's own tabs since the
    // Schedule merge (DASHBOARD_AUTOMATION_IA_REDESIGN.md §2).
    expect(manageHref(it0({ ref: "rs:2", kind: "dm" }))).toBe("/tasks?tab=dms");
    expect(manageHref(it0({ ref: "as:9", kind: "reminder" }))).toBe("/tasks?tab=queue");
    expect(manageHref(it0({ ref: "mt_3", kind: "app_fetch" }))).toBe("/settings/management");
    expect(manageHref(it0({ ref: "bx:abc", kind: "browser" }))).toBe("/browser-tasks/abc");
  });

  it("has no deep link for surface-less kinds", () => {
    expect(manageHref(it0({ ref: "bt:x", kind: "background" }))).toBeNull();
    // Automation triggers are API-managed (Approve tier) — no page yet.
    expect(manageHref(it0({ ref: "trigger:9", kind: "trigger" }))).toBeNull();
  });

  it("labels the link by surface", () => {
    expect(manageLabel(it0({ ref: "agent:a", kind: "agent" }))).toBe("Manage on Agents");
    expect(manageLabel(it0({ ref: "rs:2", kind: "dm" }))).toBe("Manage on Scheduled DMs");
    expect(manageLabel(it0({ ref: "as:9", kind: "reminder" }))).toBe("Manage on the Queue");
  });
});

describe("boardStats", () => {
  it("counts in-flight work and enabled recurring commitments", () => {
    const items = [
      item({ ref: "agent:a", kind: "agent", status: "running", cadence: "0 7 * * *" }),
      item({ ref: "rs:1", kind: "dm", status: "active", cadence: "Daily at 07:00" }),
      item({ ref: "rs:2", kind: "dm", status: "paused", cadence: "Daily at 19:00" }),
      item({ ref: "as:3", kind: "reminder", status: "pending", cadence: null }),
      item({ ref: "bt:4", kind: "background", status: "running", cadence: null }),
    ];
    expect(boardStats(items)).toEqual({ running: 2, activeRecurring: 1 });
  });

  it("is zero on an empty board", () => {
    expect(boardStats([])).toEqual({ running: 0, activeRecurring: 0 });
  });
});
