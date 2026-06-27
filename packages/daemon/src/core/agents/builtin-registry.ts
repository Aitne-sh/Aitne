import type { ProcessKey, StopWarning } from "@aitne/shared";

/**
 * Built-in Agent registry — the static identity source for the 10 shipped
 * routines (AGENT_DEFINITIONS_DESIGN.md §5.5 / §5.5.1).
 *
 * This module is the **single source of truth** for the slug ↔ cron-callback
 * ↔ process_key ↔ stop-warning mapping that both the loader (§6) and
 * `scheduler.ts:setupRecurringJobs` (§7) consult. Two roles:
 *
 *   1. **Fallback identity.** When a built-in's `agent-assets/agents/<slug>/`
 *      `agent.md` is missing, the loader synthesises an `agents` row from the
 *      matching entry here and logs a warning. This makes the Phase 4 YAML
 *      rollout incremental — ship the registry first, ship the YAML files
 *      Agent-by-Agent.
 *   2. **Cron / stop-warning authority.** The registry's `cronExpression` is
 *      authoritative over the YAML's `schedule.expression` (the loader emits a
 *      non-fatal drift warning on mismatch, §6.4); the registry's `stopWarning`
 *      must stay byte-identical to the shipped YAML's `stop_warning` (§12.1, a
 *      test enforces it once Phase 4 YAML exists).
 *
 * The firing paths below were verified line-by-line against
 * `scheduler.ts:setupRecurringJobs` during Phase 0 (design §5.5.1, frozen
 * 2026-05-30). Do NOT re-derive from prose — reproduce these exact cron forms,
 * process keys, and `schedulerFn` mechanisms.
 *
 * This module is intentionally pure (no daemon-only imports beyond the shared
 * `ProcessKey` / `StopWarning` types) so it stays in the 100%-coverage set and
 * can be imported by both the loader and the scheduler without a cycle.
 */

/**
 * Resolves a built-in's cron expression from the live `dayBoundaryHour`
 * config. `null` for the interval-gated `activity-scan`, whose cadence is a
 * runtime window (`buildActivityScanCronExpr(intervalMinutes, activeStart,
 * activeEnd)`), not a fixed expression — the loader's drift check is a no-op
 * for a `null` resolver (§5.5.1).
 */
export type CronExpressionResolver = (config: { dayBoundaryHour: number }) => string;

/**
 * How `setupRecurringJobs` fires a built-in. NB: a non-null `processKey` does
 * NOT imply `emit_routine`/`queue_wake` — `activity-scan` carries
 * `routine.activity_scan` yet fires via `in_process_callback`.
 *
 *   - `emit_routine`  — `emitRoutine(routine, data?)` puts a `routine.<name>`
 *     event on the bus. `data` is the fixed payload the scheduler passes; the
 *     two `user-profile-sweep-*` slugs share `routine.user_profile_sweep` and
 *     differ only by `data.phase`. `skill-curation` resolves its `cadence` at
 *     fire time from the DB, so its `data` is intentionally omitted here (a
 *     baked literal would be wrong).
 *   - `queue_wake`    — `queueMorningRoutineWake(...)` enqueues a durable wake
 *     row instead of a transient event (morning-routine only).
 *   - `in_process_callback` — a typed daemon callback (`onActivityScan`,
 *     `onRoadmapMaintenance`, `onContextIndexReconcile`); the last two are
 *     no-LLM passes with `processKey: null`.
 */
export type BuiltinSchedulerFn =
  | { kind: "emit_routine"; routine: string; data?: Record<string, unknown> }
  | { kind: "queue_wake"; routine: string }
  | { kind: "in_process_callback"; callbackName: string };

/**
 * Hub grouping for the `/agents` dashboard (AGENTS_HUB_REDESIGN_PLAN.md §1).
 * Built-ins declare one of the three operational categories; user Agents are
 * implicitly `"user"` at the API layer (not a registry value).
 *
 *   - `synthesis`   — routines that write the user-facing synthesis surfaces
 *     (today.md, journals, reviews).
 *   - `monitoring`  — interval watchers that triage observations and surface
 *     activity proactively.
 *   - `maintenance` — mechanical / background upkeep passes.
 */
export const AGENT_CATEGORIES = ["synthesis", "monitoring", "maintenance"] as const;
export type AgentCategory = (typeof AGENT_CATEGORIES)[number];

/**
 * A context-vault policy file a built-in reads at prompt-assembly time —
 * its editable "rulebook" surface (AGENTS_HUB_REDESIGN_PLAN.md §1 / §4.2).
 * The dashboard's per-agent Rulebook tab renders one editor per entry,
 * loading/saving through the context API chokepoint (`/api/context/<path>`);
 * the vault stays the storage, this is declaration only. Paths are the
 * canonical class-prefixed form (`context-paths.ts`).
 */
export interface AgentPolicyFile {
  /** Canonical vault-relative path, e.g. `policies/routines/morning.md`. */
  path: string;
  /** Short editor-card title, e.g. "Morning rulebook". */
  label: string;
  /** One-liner explaining what the file controls. */
  description: string;
}

export interface BuiltinAgentRegistryEntry {
  /** Kebab-case slug; also the `agents.id` and the `agent.md` directory name. */
  slug: string;
  /** Human-facing display name (dashboard). */
  name: string;
  /**
   * One-line English description of what the routine does. `agentDefinitionSchema`
   * requires a non-empty `description` with no default, so the registry must
   * carry it for the loader's registry-fallback synthesis (§6.1 step 3) to build
   * a valid `AgentDefinition` when a built-in's `agent.md` is missing. The Phase 4
   * YAML is the complete source; this is the faithful fallback, not a stopgap.
   */
  description: string;
  /**
   * Cron with `{dayBoundaryHour}` / `{dayBoundaryHour-1}` resolved from live
   * config, or `null` for the runtime-window `activity-scan` (§5.5.1).
   */
  cronExpression: CronExpressionResolver | null;
  /**
   * Backend routing key, or `null` for the two no-LLM in-process passes
   * (`roadmap-maintenance`, `context-index-reconcile`).
   */
  processKey: ProcessKey | null;
  /**
   * The `enabled` state the registry-fallback synthesis assigns when no YAML is
   * present (§6.1 step 3). `true` for every built-in EXCEPT `monthly-review`,
   * which is OFF by default pre-release (frozen decision, §2.1) — without this
   * the fallback would default `enabled: true` (schema default) and silently
   * mis-enable it. Operator toggles still win via the §6.4 override path; this
   * is only the shipped-default base. NB: `backend.tier` is deliberately NOT in
   * the registry — built-ins defer their tier to `process_backend_config` (the
   * seed authority), i.e. the synthesised `backend.tier` is `null`.
   */
  defaultEnabled: boolean;
  /** Mandatory stop warning, surfaced when an operator disables the Agent. */
  stopWarning: StopWarning;
  /** The mechanism `setupRecurringJobs` uses to fire this slug. */
  schedulerFn: BuiltinSchedulerFn;
  /** Hub grouping for the `/agents` dashboard (see `AGENT_CATEGORIES`). */
  category: AgentCategory;
  /**
   * The vault policy files this built-in reads at prompt-assembly time —
   * surfaced as its Rulebook tab. Empty for built-ins with no editable
   * rulebook (no-LLM passes, sweeps).
   */
  policyFiles: readonly AgentPolicyFile[];
}

/**
 * Backward-wrapping hour arithmetic shared by the `{dayBoundaryHour-1}`
 * builtins. `(dayBoundaryHour + 23) % 24` in the scheduler is the same value;
 * the `+ 24` keeps the result non-negative for any in-range `dayBoundaryHour`.
 */
function hourBefore(dayBoundaryHour: number): number {
  return (dayBoundaryHour - 1 + 24) % 24;
}

export const BUILTIN_AGENT_REGISTRY: readonly BuiltinAgentRegistryEntry[] = [
  {
    slug: "morning-routine",
    name: "Morning Routine",
    description:
      "Regenerates state/today.md, creates the daily journal entry, and delivers the morning DM digest at the day boundary.",
    cronExpression: ({ dayBoundaryHour }) => `0 ${dayBoundaryHour} * * *`,
    processKey: "routine.morning_routine",
    defaultEnabled: true,
    stopWarning: {
      level: "critical",
      services_lost: [
        "Daily state/today.md regeneration",
        "Daily journal entry creation",
        "Morning DM digest delivery",
      ],
      dependent_agents: ["evening-review", "weekly-review"],
      reactivation_hint:
        "Re-enable from /agents/morning-routine. The next firing catches up with a broader observation window.",
    },
    schedulerFn: { kind: "queue_wake", routine: "morning_routine" },
    category: "synthesis",
    // journal-format / journal-export hang off morning-routine because the
    // morning pipeline is their only consumer (task-flows
    // `routine.morning_routine_{today,journal}` + the morning composers —
    // verified 2026-06-10, AGENTS_HUB_REDESIGN_PLAN.md §1).
    policyFiles: [
      {
        path: "policies/routines/morning.md",
        label: "Morning rulebook",
        description: "Checks and rules injected into the morning routine prompt.",
      },
      {
        path: "policies/journal-format.md",
        label: "Journal format",
        description: "Template and voice rules for the daily journal synthesis.",
      },
      {
        path: "policies/journal-export.md",
        label: "Journal export rules",
        description: "Redaction and inclusion rules applied when journal content is exported.",
      },
    ],
  },
  {
    slug: "evening-review",
    name: "Evening Review",
    description:
      "Appends the evening reflection journal and reconciles the roadmap at end of day.",
    cronExpression: () => "0 18 * * *",
    processKey: "routine.evening_review",
    defaultEnabled: true,
    stopWarning: {
      level: "high",
      services_lost: [
        "Evening reflection journal append",
        "End-of-day roadmap reconciliation",
      ],
      dependent_agents: ["weekly-review"],
      reactivation_hint:
        "Re-enable from /agents/evening-review. Resumes on the next 18:00 firing.",
    },
    schedulerFn: { kind: "emit_routine", routine: "evening_review" },
    category: "synthesis",
    policyFiles: [
      {
        path: "policies/routines/evening.md",
        label: "Evening rulebook",
        description: "Checks and rules injected into the evening review prompt.",
      },
    ],
  },
  {
    slug: "weekly-review",
    name: "Weekly Review",
    description:
      "Writes the weekly synthesis note and reviews the roadmap every Friday evening.",
    cronExpression: () => "0 19 * * 5",
    processKey: "routine.weekly_review",
    defaultEnabled: true,
    stopWarning: {
      level: "high",
      services_lost: [
        "Weekly synthesis note (journal/weekly/{week}.md)",
        "Weekly roadmap review",
      ],
      dependent_agents: [],
      reactivation_hint:
        "Re-enable from /agents/weekly-review. Resumes on the next Friday 19:00 firing.",
    },
    schedulerFn: { kind: "emit_routine", routine: "weekly_review" },
    category: "synthesis",
    policyFiles: [
      {
        path: "policies/routines/weekly.md",
        label: "Weekly rulebook",
        description: "Checks and rules injected into the weekly review prompt.",
      },
    ],
  },
  {
    slug: "monthly-review",
    name: "Monthly Review",
    description:
      "Writes the monthly synthesis note and month-end retrospective on the last day of the month (opt-in).",
    cronExpression: () => "0 18 * * *",
    processKey: "routine.monthly_review",
    // OFF by default pre-release (§2.1, frozen). The only built-in whose
    // fallback `enabled` is false; the rest default true.
    defaultEnabled: false,
    stopWarning: {
      level: "normal",
      services_lost: [
        "Monthly synthesis note",
        "Month-end retrospective",
      ],
      dependent_agents: [],
      reactivation_hint:
        "Monthly review is opt-in (off by default). Enable from /agents/monthly-review.",
    },
    schedulerFn: { kind: "emit_routine", routine: "monthly_review" },
    category: "synthesis",
    policyFiles: [
      {
        path: "policies/routines/monthly.md",
        label: "Monthly rulebook",
        description: "Checks and rules injected into the monthly review prompt.",
      },
    ],
  },
  {
    slug: "activity-scan",
    name: "Activity Scan",
    description:
      "Triages pending observations and proactively surfaces new mail / calendar / git / notion activity each interval within active hours.",
    // Runtime-window cadence — `buildActivityScanCronExpr(...)` owns the expression,
    // so the registry resolver is `null` and the loader's drift check skips
    // this slug (§5.5.1). The Phase 4 YAML still carries a self-documenting
    // literal to satisfy the schema's `cron → expression` refinement.
    cronExpression: null,
    processKey: "routine.activity_scan",
    // `agents.enabled` is the single on/off switch (AGENTS_HUB_REDESIGN_PLAN.md
    // §2 — the legacy `activityScanEnabled` config gate was unified into it; a
    // one-time boot reconcile carries an operator's old `false` forward).
    defaultEnabled: true,
    stopWarning: {
      level: "high",
      services_lost: [
        "Periodic observation triage",
        "Proactive surfacing of new mail / calendar / git / notion activity",
      ],
      dependent_agents: [],
      reactivation_hint:
        "Re-enable from /agents/activity-scan. Resumes on the next interval tick within active hours.",
    },
    schedulerFn: { kind: "in_process_callback", callbackName: "onActivityScan" },
    category: "monitoring",
    policyFiles: [
      {
        path: "policies/routines/activity-scan.md",
        label: "Activity scan rulebook",
        description: "Checks and rules injected into the activity scan prompt.",
      },
    ],
  },
  {
    slug: "user-profile-sweep-morning",
    name: "User Profile Sweep (Morning)",
    description:
      "Refreshes identity/profile.md from the day's DM traffic shortly before the day boundary, ahead of the morning routine.",
    cronExpression: ({ dayBoundaryHour }) => `50 ${hourBefore(dayBoundaryHour)} * * *`,
    processKey: "routine.user_profile_sweep",
    defaultEnabled: true,
    stopWarning: {
      level: "normal",
      services_lost: [
        "Pre-morning user/profile.md refresh from the day's DM traffic",
      ],
      // Morning Routine reads a freshly-updated user/profile.md when it loads
      // <user>; the sweep fires 10 min before the day boundary so it is ready.
      dependent_agents: ["morning-routine"],
      reactivation_hint:
        "Re-enable from /agents/user-profile-sweep-morning. Runs 10 min before the day boundary.",
    },
    schedulerFn: {
      kind: "emit_routine",
      routine: "user_profile_sweep",
      data: { phase: "morning" },
    },
    category: "maintenance",
    policyFiles: [],
  },
  {
    slug: "user-profile-sweep-evening",
    name: "User Profile Sweep (Evening)",
    description:
      "Refreshes identity/profile.md from the day's DM traffic shortly before the evening review.",
    cronExpression: () => "50 17 * * *",
    processKey: "routine.user_profile_sweep",
    defaultEnabled: true,
    stopWarning: {
      level: "normal",
      services_lost: [
        "Pre-evening user/profile.md refresh from the day's DM traffic",
      ],
      // Fires 10 min before Evening Review (18:00) so the review reads a
      // fresh profile.
      dependent_agents: ["evening-review"],
      reactivation_hint:
        "Re-enable from /agents/user-profile-sweep-evening. Runs 10 min before Evening Review.",
    },
    schedulerFn: {
      kind: "emit_routine",
      routine: "user_profile_sweep",
      data: { phase: "evening" },
    },
    category: "maintenance",
    policyFiles: [],
  },
  {
    slug: "roadmap-maintenance",
    name: "Roadmap Maintenance",
    description:
      "Mechanical (no-LLM) roadmap.md upkeep — stale-item pruning and section reconciliation — before the evening review.",
    cronExpression: () => "45 17 * * *",
    // No-LLM in-process pass — no backend routing key (§5.5.1).
    processKey: null,
    defaultEnabled: true,
    stopWarning: {
      level: "high",
      services_lost: [
        "Mechanical roadmap.md maintenance (stale-item pruning, section reconciliation)",
      ],
      // Runs at 17:45 and releases roadmap_write_lock before Evening Review's
      // 18:00 Long-term-Plans promotion (evening-review-slimdown §2.2).
      dependent_agents: ["evening-review"],
      reactivation_hint:
        "Re-enable from /agents/roadmap-maintenance. Runs daily at 17:45, before Evening Review.",
    },
    schedulerFn: {
      kind: "in_process_callback",
      callbackName: "onRoadmapMaintenance",
    },
    category: "maintenance",
    policyFiles: [],
  },
  {
    slug: "context-index-reconcile",
    name: "Context Index Reconcile",
    description:
      "Mechanical (no-LLM) context-vault index reconciliation shortly before the day boundary, ahead of the morning routine.",
    cronExpression: ({ dayBoundaryHour }) => `45 ${hourBefore(dayBoundaryHour)} * * *`,
    // No-LLM in-process pass — no backend routing key (§5.5.1).
    processKey: null,
    defaultEnabled: true,
    stopWarning: {
      level: "high",
      services_lost: [
        "Context-vault index reconciliation before the morning routine",
      ],
      // Runs 15 min before the day boundary so the index is fresh when the
      // morning routine reads it.
      dependent_agents: ["morning-routine"],
      reactivation_hint:
        "Re-enable from /agents/context-index-reconcile. Runs 15 min before the day boundary.",
    },
    schedulerFn: {
      kind: "in_process_callback",
      callbackName: "onContextIndexReconcile",
    },
    category: "maintenance",
    policyFiles: [],
  },
  {
    slug: "skill-curation",
    name: "Skill Curation",
    description:
      "Generates typed skill self-optimization proposals on the configured cadence (opt-in).",
    cronExpression: () => "0 3 * * *",
    processKey: "routine.skill_curation",
    // Agent-enabled defaults true; the feature's real opt-in is the scheduler's
    // `isSkillCurationEnabled()` gate, ANDed on top at fire time.
    defaultEnabled: true,
    stopWarning: {
      level: "normal",
      services_lost: [
        "Skill self-optimization proposals (typed curation submissions)",
      ],
      dependent_agents: [],
      reactivation_hint:
        "Skill curation is opt-in via /settings/self-learning. Re-enable from /agents/skill-curation.",
    },
    // `cadence` (daily/weekly/monthly) is read from the DB at fire time, so it
    // is intentionally absent from `data` here — see BuiltinSchedulerFn.
    schedulerFn: { kind: "emit_routine", routine: "skill_curation" },
    category: "maintenance",
    policyFiles: [],
  },
];

/** Slug → entry, for O(1) lookup from the loader and the scheduler gate. */
export const BUILTIN_AGENT_REGISTRY_BY_SLUG: ReadonlyMap<
  string,
  BuiltinAgentRegistryEntry
> = new Map(BUILTIN_AGENT_REGISTRY.map((entry) => [entry.slug, entry]));

/** Every built-in slug, for membership tests (e.g. user-Agent slug collision). */
export const BUILTIN_AGENT_SLUGS: ReadonlySet<string> = new Set(
  BUILTIN_AGENT_REGISTRY.map((entry) => entry.slug),
);

/** Returns the registry entry for `slug`, or `undefined` if not a built-in. */
export function getBuiltinRegistryEntry(
  slug: string,
): BuiltinAgentRegistryEntry | undefined {
  return BUILTIN_AGENT_REGISTRY_BY_SLUG.get(slug);
}

/** True when `slug` names a shipped built-in Agent. */
export function isBuiltinAgentSlug(slug: string): boolean {
  return BUILTIN_AGENT_SLUGS.has(slug);
}

// ── Runtime-window interval cadence (§5.5.1) ────────────────────────────────

/**
 * The live config a runtime-window built-in's cadence is resolved from. Today
 * the only runtime-window built-in is `activity-scan`, whose firing window is
 * `buildActivityScanCronExpr(intervalMinutes, activeStart, activeEnd)` — so the three
 * `activityScan*` fields are all that's needed. A narrow shape (not the whole
 * `AgentConfig`) keeps this module pure / coverage-friendly.
 */
export interface RuntimeWindowCadenceConfig {
  activityScanIntervalMinutes: number;
  activityScanActiveStartHour: number;
  activityScanActiveEndHour: number;
}

/**
 * The interval cadence of a runtime-window built-in: how often it fires
 * (`interval_minutes`) and the local active-hours window it fires within. This
 * is the structured form the `/agents` views surface so the dashboard can show
 * the REAL cadence ("Every 60 min, 04:00–24:00") instead of the loader-ignored
 * placeholder cron the `agents` row stores for these slugs (§5.5.1).
 */
export interface IntervalCadence {
  /** Minutes between firings within the active window (e.g. 60, 30). */
  interval_minutes: number;
  /** Active-window start hour, local, inclusive (0–23). */
  active_start_hour: number;
  /** Active-window end hour, local, exclusive (1–24). */
  active_end_hour: number;
}

/**
 * Resolve the live interval cadence for a runtime-window built-in, or `null`
 * for every fixed-cron / one-shot / event Agent.
 *
 * A built-in is "runtime-window" iff its registry `cronExpression` resolver is
 * `null` — the documented marker (§5.5.1) that its cadence is owned by
 * `buildActivityScanCronExpr` from live config, not a baked cron. Today `activity-scan`
 * is the sole such entry, so the mapping reads the `activityScan*` config. A
 * second runtime-window built-in would need its own branch here — the
 * `cronExpression === null` gate plus this comment keep that requirement
 * visible. Pure: the caller supplies the live config (read at request time so a
 * runtime interval change via `PATCH /api/config` is reflected immediately).
 */
export function resolveRuntimeWindowCadence(
  slug: string,
  config: RuntimeWindowCadenceConfig,
): IntervalCadence | null {
  const entry = getBuiltinRegistryEntry(slug);
  if (!entry || entry.cronExpression !== null) return null;
  return {
    interval_minutes: config.activityScanIntervalMinutes,
    active_start_hour: config.activityScanActiveStartHour,
    active_end_hour: config.activityScanActiveEndHour,
  };
}
