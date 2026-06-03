import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";

import { applySchema } from "../../db/schema.js";
import { upsertAgent } from "../../db/agents-store.js";
import { createRecurringSchedule } from "../../db/recurring-schedules.js";
import { resolveAgentId, routineToAgentSlug } from "./agent-id-resolver.js";

/** Create a recurring_schedules row and return its id (the agents FK needs it). */
function seedRecurring(db: Database.Database): number {
  return createRecurringSchedule(db, {
    taskType: "agent.task",
    description: "Paired recurring task",
    recurrenceRule: { frequency: "daily", time: "09:00", timezone: "UTC" },
  }).id;
}

function seedAgent(
  db: Database.Database,
  slug: string,
  opts: { source?: "builtin" | "user"; recurringScheduleId?: number | null } = {},
): void {
  upsertAgent(db, {
    slug,
    name: slug,
    source: opts.source ?? "builtin",
    definitionPath: `/agents/${slug}/agent.md`,
    definitionHash: `hash-${slug}`,
    enabled: true,
    scheduleKind: "cron",
    scheduleExpression: "0 4 * * *",
    scheduleTimezone: "UTC",
    recurringScheduleId: opts.recurringScheduleId ?? null,
  });
}

describe("routineToAgentSlug", () => {
  it("maps a unique built-in routine to its slug", () => {
    expect(routineToAgentSlug("morning_routine", null)).toBe("morning-routine");
    expect(routineToAgentSlug("evening_review", null)).toBe("evening-review");
    expect(routineToAgentSlug("weekly_review", null)).toBe("weekly-review");
    expect(routineToAgentSlug("monthly_review", null)).toBe("monthly-review");
    expect(routineToAgentSlug("hourly_check", null)).toBe("hourly-check");
    expect(routineToAgentSlug("skill_curation", null)).toBe("skill-curation");
  });

  it("disambiguates the two user_profile_sweep slugs by phase", () => {
    expect(routineToAgentSlug("user_profile_sweep", "morning")).toBe(
      "user-profile-sweep-morning",
    );
    expect(routineToAgentSlug("user_profile_sweep", "evening")).toBe(
      "user-profile-sweep-evening",
    );
    // Absent / unknown phase defaults to morning.
    expect(routineToAgentSlug("user_profile_sweep", null)).toBe(
      "user-profile-sweep-morning",
    );
  });

  it("returns null for a routine with no 1:1 built-in Agent", () => {
    expect(routineToAgentSlug("roadmap_refresh", null)).toBeNull();
    expect(routineToAgentSlug("does_not_exist", null)).toBeNull();
  });
});

describe("resolveAgentId", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applySchema(db);
  });

  afterEach(() => {
    db.close();
  });

  it("step 1 — returns task_context.agent_id when the Agent exists", () => {
    seedAgent(db, "my-agent", { source: "user" });
    expect(resolveAgentId(db, { taskContextAgentId: "my-agent" })).toBe("my-agent");
  });

  it("step 1 — returns null when the stamped Agent no longer exists (FK safety)", () => {
    expect(resolveAgentId(db, { taskContextAgentId: "deleted-agent" })).toBeNull();
  });

  it("step 2 — resolves via the recurring_schedule_id join", () => {
    const recurringId = seedRecurring(db);
    seedAgent(db, "paired-agent", { source: "user", recurringScheduleId: recurringId });
    expect(resolveAgentId(db, { recurringScheduleId: recurringId })).toBe("paired-agent");
  });

  it("step 2 — returns null when no Agent owns the recurring id", () => {
    expect(resolveAgentId(db, { recurringScheduleId: 99 })).toBeNull();
  });

  it("step 3 — resolves a routine event to its built-in slug", () => {
    seedAgent(db, "morning-routine");
    expect(resolveAgentId(db, { routine: "morning_routine" })).toBe("morning-routine");
  });

  it("step 3 — resolves the sweep by phase", () => {
    seedAgent(db, "user-profile-sweep-evening");
    expect(
      resolveAgentId(db, { routine: "user_profile_sweep", routinePhase: "evening" }),
    ).toBe("user-profile-sweep-evening");
  });

  it("step 3 — returns null when the resolved built-in row is not loaded", () => {
    // Routine maps to a slug, but no agents row exists yet (load failed).
    expect(resolveAgentId(db, { routine: "weekly_review" })).toBeNull();
  });

  it("returns null when nothing resolves", () => {
    expect(resolveAgentId(db, {})).toBeNull();
    expect(resolveAgentId(db, { routine: "roadmap_refresh" })).toBeNull();
  });

  it("prefers the explicit stamp over the recurring join and routine", () => {
    const recurringId = seedRecurring(db);
    seedAgent(db, "explicit-agent", { source: "user" });
    seedAgent(db, "joined-agent", { source: "user", recurringScheduleId: recurringId });
    expect(
      resolveAgentId(db, {
        taskContextAgentId: "explicit-agent",
        recurringScheduleId: recurringId,
        routine: "morning_routine",
      }),
    ).toBe("explicit-agent");
  });
});
