import { describe, expect, it } from "vitest";
import { isProcessKey, AGENT_SLUG_PATTERN, stopWarningSchema } from "@aitne/shared";
import {
  AGENT_CATEGORIES,
  BUILTIN_AGENT_REGISTRY,
  BUILTIN_AGENT_REGISTRY_BY_SLUG,
  BUILTIN_AGENT_SLUGS,
  getBuiltinRegistryEntry,
  isBuiltinAgentSlug,
  resolveRuntimeWindowCadence,
} from "./builtin-registry.js";

// The 11 frozen built-in slugs (design §5.5.1; `lesson-maintenance` added by
// SELF_IMPROVEMENT_PHASE2 / QUALITY_LOOP_IMPROVEMENT_PLAN_2026-07 WP1). The
// registry MUST contain exactly these; the per-slug expectations below mirror
// the frozen firing-path table verified against scheduler.ts.
const EXPECTED_SLUGS = [
  "morning-routine",
  "evening-review",
  "weekly-review",
  "monthly-review",
  "activity-scan",
  "user-profile-sweep-morning",
  "user-profile-sweep-evening",
  "roadmap-maintenance",
  "lesson-maintenance",
  "context-index-reconcile",
  "skill-curation",
] as const;

describe("BUILTIN_AGENT_REGISTRY — structure", () => {
  it("contains exactly the 11 frozen built-in slugs", () => {
    expect(BUILTIN_AGENT_REGISTRY).toHaveLength(11);
    expect(BUILTIN_AGENT_REGISTRY.map((e) => e.slug).sort()).toEqual(
      [...EXPECTED_SLUGS].sort(),
    );
  });

  it("has unique slugs", () => {
    const slugs = BUILTIN_AGENT_REGISTRY.map((e) => e.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it("has a non-empty display name for every entry", () => {
    for (const entry of BUILTIN_AGENT_REGISTRY) {
      expect(entry.name.length).toBeGreaterThan(0);
    }
  });

  it("has a non-empty description for every entry (required for fallback synthesis)", () => {
    // `agentDefinitionSchema.description` is required with no default, so the
    // registry-fallback synthesis (§6.1 step 3) needs a real description here.
    for (const entry of BUILTIN_AGENT_REGISTRY) {
      expect(entry.description.length).toBeGreaterThan(0);
    }
  });

  it("defaultEnabled is true for every built-in except the opt-in monthly-review", () => {
    // monthly-review ships OFF pre-release (§2.1, frozen); every other built-in
    // defaults enabled. Without this the fallback would mis-enable monthly-review.
    for (const entry of BUILTIN_AGENT_REGISTRY) {
      expect(entry.defaultEnabled).toBe(entry.slug !== "monthly-review");
    }
  });

  it("every slug is kebab-case (matches AGENT_SLUG_PATTERN)", () => {
    for (const entry of BUILTIN_AGENT_REGISTRY) {
      expect(entry.slug).toMatch(AGENT_SLUG_PATTERN);
    }
  });

  it("processKey is null or a known ProcessKey", () => {
    for (const entry of BUILTIN_AGENT_REGISTRY) {
      if (entry.processKey === null) continue;
      expect(isProcessKey(entry.processKey)).toBe(true);
    }
  });

  it("every stopWarning is a valid StopWarning", () => {
    for (const entry of BUILTIN_AGENT_REGISTRY) {
      expect(() => stopWarningSchema.parse(entry.stopWarning)).not.toThrow();
    }
  });

  it("schedulerFn carries the fields its discriminant requires", () => {
    for (const entry of BUILTIN_AGENT_REGISTRY) {
      const fn = entry.schedulerFn;
      switch (fn.kind) {
        case "emit_routine":
          expect(fn.routine.length).toBeGreaterThan(0);
          break;
        case "queue_wake":
          expect(fn.routine.length).toBeGreaterThan(0);
          break;
        case "in_process_callback":
          expect(fn.callbackName.length).toBeGreaterThan(0);
          break;
        default:
          // Exhaustiveness guard — a new schedulerFn kind must update this test.
          throw new Error(`unhandled schedulerFn ${JSON.stringify(fn)}`);
      }
    }
  });
});

describe("BUILTIN_AGENT_REGISTRY — frozen firing paths (§5.5.1)", () => {
  // Mirror of the frozen table: slug → processKey, schedulerFn shape, and the
  // resolved cron at the default dayBoundaryHour (4). `cron: null` ==
  // runtime-window builtin (activity-scan).
  const TABLE: Record<
    string,
    {
      processKey: string | null;
      cron: string | null;
      scheduler: Record<string, unknown>;
    }
  > = {
    "morning-routine": {
      processKey: "routine.morning_routine",
      cron: "0 4 * * *",
      scheduler: { kind: "queue_wake", routine: "morning_routine" },
    },
    "evening-review": {
      processKey: "routine.evening_review",
      cron: "0 18 * * *",
      scheduler: { kind: "emit_routine", routine: "evening_review" },
    },
    "weekly-review": {
      processKey: "routine.weekly_review",
      cron: "0 19 * * 5",
      scheduler: { kind: "emit_routine", routine: "weekly_review" },
    },
    "monthly-review": {
      processKey: "routine.monthly_review",
      cron: "0 18 * * *",
      scheduler: { kind: "emit_routine", routine: "monthly_review" },
    },
    "activity-scan": {
      processKey: "routine.activity_scan",
      cron: null,
      scheduler: { kind: "in_process_callback", callbackName: "onActivityScan" },
    },
    "user-profile-sweep-morning": {
      processKey: "routine.user_profile_sweep",
      cron: "50 3 * * *",
      scheduler: {
        kind: "emit_routine",
        routine: "user_profile_sweep",
        data: { phase: "morning" },
      },
    },
    "user-profile-sweep-evening": {
      processKey: "routine.user_profile_sweep",
      cron: "50 17 * * *",
      scheduler: {
        kind: "emit_routine",
        routine: "user_profile_sweep",
        data: { phase: "evening" },
      },
    },
    "roadmap-maintenance": {
      processKey: null,
      cron: "45 17 * * *",
      scheduler: {
        kind: "in_process_callback",
        callbackName: "onRoadmapMaintenance",
      },
    },
    "lesson-maintenance": {
      processKey: null,
      cron: "40 17 * * *",
      scheduler: {
        kind: "in_process_callback",
        callbackName: "onLessonMaintenance",
      },
    },
    "context-index-reconcile": {
      processKey: null,
      cron: "45 3 * * *",
      scheduler: {
        kind: "in_process_callback",
        callbackName: "onContextIndexReconcile",
      },
    },
    "skill-curation": {
      processKey: "routine.skill_curation",
      cron: "0 3 * * *",
      scheduler: { kind: "emit_routine", routine: "skill_curation" },
    },
  };

  for (const entry of BUILTIN_AGENT_REGISTRY) {
    it(`${entry.slug} matches the frozen table`, () => {
      const expected = TABLE[entry.slug];
      expect(expected, `no frozen row for ${entry.slug}`).toBeDefined();
      expect(entry.processKey).toBe(expected.processKey);
      expect(entry.schedulerFn).toEqual(expected.scheduler);
      if (expected.cron === null) {
        expect(entry.cronExpression).toBeNull();
      } else {
        expect(entry.cronExpression).toBeTypeOf("function");
        expect(entry.cronExpression!({ dayBoundaryHour: 4 })).toBe(expected.cron);
      }
    });
  }

  it("dayBoundaryHour-dependent crons recompute (and wrap across midnight)", () => {
    const morning = getBuiltinRegistryEntry("morning-routine")!;
    expect(morning.cronExpression!({ dayBoundaryHour: 6 })).toBe("0 6 * * *");
    expect(morning.cronExpression!({ dayBoundaryHour: 0 })).toBe("0 0 * * *");

    const sweep = getBuiltinRegistryEntry("user-profile-sweep-morning")!;
    expect(sweep.cronExpression!({ dayBoundaryHour: 6 })).toBe("50 5 * * *");
    // dayBoundaryHour − 1 wraps backward across midnight.
    expect(sweep.cronExpression!({ dayBoundaryHour: 0 })).toBe("50 23 * * *");

    const reconcile = getBuiltinRegistryEntry("context-index-reconcile")!;
    expect(reconcile.cronExpression!({ dayBoundaryHour: 0 })).toBe("45 23 * * *");
  });

  it("fixed-literal crons ignore dayBoundaryHour", () => {
    for (const slug of [
      "evening-review",
      "weekly-review",
      "monthly-review",
      "user-profile-sweep-evening",
      "roadmap-maintenance",
      "lesson-maintenance",
      "skill-curation",
    ]) {
      const entry = getBuiltinRegistryEntry(slug)!;
      expect(entry.cronExpression!({ dayBoundaryHour: 9 })).toBe(
        entry.cronExpression!({ dayBoundaryHour: 17 }),
      );
    }
  });
});

describe("registry lookup helpers", () => {
  it("BUILTIN_AGENT_REGISTRY_BY_SLUG / BUILTIN_AGENT_SLUGS cover every entry", () => {
    expect(BUILTIN_AGENT_REGISTRY_BY_SLUG.size).toBe(BUILTIN_AGENT_REGISTRY.length);
    expect(BUILTIN_AGENT_SLUGS.size).toBe(BUILTIN_AGENT_REGISTRY.length);
    for (const entry of BUILTIN_AGENT_REGISTRY) {
      expect(BUILTIN_AGENT_REGISTRY_BY_SLUG.get(entry.slug)).toBe(entry);
      expect(BUILTIN_AGENT_SLUGS.has(entry.slug)).toBe(true);
    }
  });

  it("getBuiltinRegistryEntry returns the entry for a known slug, undefined otherwise", () => {
    expect(getBuiltinRegistryEntry("morning-routine")?.slug).toBe("morning-routine");
    expect(getBuiltinRegistryEntry("not-a-builtin")).toBeUndefined();
  });

  it("isBuiltinAgentSlug discriminates built-in vs user slugs", () => {
    expect(isBuiltinAgentSlug("activity-scan")).toBe(true);
    expect(isBuiltinAgentSlug("weekly-bookmarks-cleanup")).toBe(false);
  });
});

describe("resolveRuntimeWindowCadence", () => {
  const cfg = {
    activityScanIntervalMinutes: 60,
    activityScanActiveStartHour: 4,
    activityScanActiveEndHour: 24,
  };

  it("returns the live interval cadence for the runtime-window built-in (activity-scan)", () => {
    expect(resolveRuntimeWindowCadence("activity-scan", cfg)).toEqual({
      interval_minutes: 60,
      active_start_hour: 4,
      active_end_hour: 24,
    });
  });

  it("reflects a runtime-changed interval / active window verbatim", () => {
    expect(
      resolveRuntimeWindowCadence("activity-scan", {
        activityScanIntervalMinutes: 30,
        activityScanActiveStartHour: 8,
        activityScanActiveEndHour: 22,
      }),
    ).toEqual({ interval_minutes: 30, active_start_hour: 8, active_end_hour: 22 });
  });

  it("returns null for a fixed-cron built-in (cronExpression resolver present)", () => {
    expect(resolveRuntimeWindowCadence("morning-routine", cfg)).toBeNull();
    expect(resolveRuntimeWindowCadence("weekly-review", cfg)).toBeNull();
  });

  it("returns null for an unknown / user slug", () => {
    expect(resolveRuntimeWindowCadence("not-a-builtin", cfg)).toBeNull();
  });
});

describe("hub metadata — category + policyFiles (AGENTS_HUB_REDESIGN_PLAN §1)", () => {
  it("every entry carries a known category", () => {
    for (const entry of BUILTIN_AGENT_REGISTRY) {
      expect(AGENT_CATEGORIES).toContain(entry.category);
    }
  });

  it("pins the frozen category assignments", () => {
    const bySlug = Object.fromEntries(
      BUILTIN_AGENT_REGISTRY.map((e) => [e.slug, e.category]),
    );
    expect(bySlug).toEqual({
      "morning-routine": "synthesis",
      "evening-review": "synthesis",
      "weekly-review": "synthesis",
      "monthly-review": "synthesis",
      "activity-scan": "monitoring",
      "user-profile-sweep-morning": "maintenance",
      "user-profile-sweep-evening": "maintenance",
      "roadmap-maintenance": "maintenance",
      "lesson-maintenance": "maintenance",
      "context-index-reconcile": "maintenance",
      "skill-curation": "maintenance",
    });
  });

  it("policy files use canonical class-prefixed vault paths with .md", () => {
    for (const entry of BUILTIN_AGENT_REGISTRY) {
      for (const file of entry.policyFiles) {
        expect(file.path).toMatch(/^policies\/.+\.md$/);
        expect(file.label.length).toBeGreaterThan(0);
        expect(file.description.length).toBeGreaterThan(0);
      }
    }
  });

  it("each review routine declares its rulebook; morning also owns the journal rules", () => {
    const paths = (slug: string) =>
      getBuiltinRegistryEntry(slug)!.policyFiles.map((f) => f.path);
    expect(paths("morning-routine")).toEqual([
      "policies/routines/morning.md",
      "policies/journal-format.md",
      "policies/journal-export.md",
    ]);
    expect(paths("evening-review")).toEqual(["policies/routines/evening.md"]);
    expect(paths("weekly-review")).toEqual(["policies/routines/weekly.md"]);
    expect(paths("monthly-review")).toEqual(["policies/routines/monthly.md"]);
    expect(paths("activity-scan")).toEqual(["policies/routines/activity-scan.md"]);
    expect(paths("roadmap-maintenance")).toEqual([]);
    expect(paths("lesson-maintenance")).toEqual([]);
    expect(paths("context-index-reconcile")).toEqual([]);
    expect(paths("user-profile-sweep-morning")).toEqual([]);
    expect(paths("user-profile-sweep-evening")).toEqual([]);
    expect(paths("skill-curation")).toEqual([]);
  });
});

// The byte-identity comparison between each registry entry's stopWarning and
// its shipped `agent-assets/agents/<slug>/agent.md` `stop_warning` block (plus
// process_key, cron, slug↔dir bijection) is owned by Phase 4's
// `builtin-yaml.test.ts`, which runs after the YAML files exist and has the
// js-yaml frontmatter parser available. The Phase 3 `it.todo` stub was resolved
// there once Phase 4 shipped the files.
