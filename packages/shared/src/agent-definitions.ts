import { z } from "zod";
import { BACKEND_IDS } from "./backend.js";
import { PLAYBOOK_SLUGS } from "./playbooks.js";

/**
 * Agent Definitions — shared contract (AGENT_DEFINITIONS_DESIGN.md §4.3).
 *
 * The single typed source of truth for the YAML frontmatter that lives in
 * `agent-assets/agents/<slug>/agent.md` (built-in Agents) and
 * `<contextDir>/policies/agents/<slug>/agent.md` (user Agents). Every other
 * layer — the daemon loader/registry/stores, the API routes, and the
 * dashboard editor — imports this module so the schema never drifts.
 *
 * This module is intentionally **dependency-free** of daemon-only registries.
 * `backend.tier` / `backend.backend_id` are validated here because their
 * enums already live in `@aitne/shared`. `backend.process_key` stays a plain
 * (nullable) string with the `PROCESS_KEYS` cross-check **deferred to the
 * loader**: the full process-key set includes runtime-supplied custom-routine
 * keys (`routine.custom.<slug>`) that cannot be enumerated at compile time, and
 * the loader owns that boundary check (§4.3 parsing pipeline, step 4). A `null`
 * `process_key` marks a no-LLM in-process built-in pass (roadmap-maintenance,
 * context-index-reconcile) that has no backend-routing key at all (§5.5.1);
 * user Agents always run an LLM turn, so the schema requires a non-null key for
 * `kind: "user"` (see `superRefine`).
 */

/** `kind` discriminator — built-in (shipped) vs user-authored Agents (§3.3). */
export const AGENT_KINDS = ["builtin", "user"] as const;
/** Model tier vocabulary, aligned with `ProcessModelTier` (§4.2 `backend`). */
export const AGENT_TIERS = ["lite", "medium", "high"] as const;
/** How an Agent fires: recurring cron, single timestamp, or event ref (§4.2). */
export const SCHEDULE_KINDS = ["cron", "one_shot", "event"] as const;

export type AgentKind = (typeof AGENT_KINDS)[number];
export type AgentTier = (typeof AGENT_TIERS)[number];
export type ScheduleKind = (typeof SCHEDULE_KINDS)[number];

/**
 * The dot-paths a built-in operator may override (§6.4.1 / §9.5) — the SINGLE
 * source of truth for the override allow-list, imported by the daemon's
 * `override-merge.ts` (`MERGEABLE_OVERRIDE_PATHS` = the two `enabled*` keys +
 * these) and the `/api/agents` PATCH planner (`OVERRIDE_EDIT_PATHS`), and by the
 * dashboard's built-in override form. Housing it here keeps the three lists from
 * drifting (they were independently hand-maintained before). `enabled` is NOT
 * here: it is the `agents.enabled` column's authority (§6.4), toggled
 * separately, never an override-snapshot value.
 */
export const OVERRIDE_EDIT_PATHS = [
  "backend.tier",
  "backend.model",
  // Companion to `backend.model`: the backend that owns the pinned model id.
  // The dashboard model picker writes both together so the runtime override
  // (BackendRouter agent-override resolution) never has to guess which
  // backend a model id belongs to. `null` (or absent, for snapshots written
  // before this key existed) falls back to registry inference at resolve time.
  "backend.backend_id",
  "limits.max_turns",
  "limits.max_budget_usd",
  "limits.timeout_minutes",
  "on_error.notify_owner",
] as const;
export type OverrideEditPath = (typeof OVERRIDE_EDIT_PATHS)[number];

/**
 * Slug grammar shared by the schema, the loader (slug == directory name), and
 * the dashboard editor. Kebab-case, must start with a lowercase letter so the
 * value is a safe directory name and a stable URL segment (`/agents/<slug>`).
 */
export const AGENT_SLUG_PATTERN = /^[a-z][a-z0-9-]*$/;

/**
 * Stop warning surfaced when an operator disables an Agent (§4.2 `stop_warning`).
 * Mandatory for built-ins (enforced by `agentDefinitionSchema.superRefine`);
 * optional for user Agents, which can be stopped without an ack.
 */
export const stopWarningSchema = z.object({
  level: z.enum(["critical", "high", "normal"]),
  services_lost: z.array(z.string().min(1)).min(1),
  // Slugs of Agents that consume this one's output. Non-empty so a stray
  // `[""]` can't render a blank bullet in the stop-warning modal.
  dependent_agents: z.array(z.string().min(1)).default([]),
  reactivation_hint: z.string().optional(),
});
export type StopWarning = z.infer<typeof stopWarningSchema>;

/**
 * Post-execution semantic checks (§4.2 `success_criteria`, §8.3 evaluators).
 * Discriminated on `kind` so each variant carries exactly its own fields and
 * the loader/evaluator can switch without optional-field guards.
 */
export const successCriterionSchema = z.discriminatedUnion("kind", [
  z.object({
    id: z.string().min(1),
    kind: z.literal("file_exists"),
    // Context-vault path; may contain the `{date}` placeholder resolved at
    // eval time against the agent-day boundary (§8.3).
    target: z.string().min(1),
  }),
  z.object({
    id: z.string().min(1),
    kind: z.literal("file_section_count"),
    target: z.string().min(1),
    min: z.number().int().nonnegative(),
    // Markdown heading depth counted toward `min` (default `##`).
    heading_level: z.union([z.literal(1), z.literal(2), z.literal(3)]).default(2),
  }),
  z.object({
    id: z.string().min(1),
    kind: z.literal("notification_log"),
    notification_type: z.string().min(1),
    delivered_within_minutes: z.number().int().positive().default(60),
  }),
  z.object({
    id: z.string().min(1),
    kind: z.literal("agent_action_count"),
    action_type: z.string().min(1),
    min: z.number().int().positive(),
  }),
]);
export type SuccessCriterion = z.infer<typeof successCriterionSchema>;

/**
 * Schedule block (§4.2). The `kind` selects which field carries the spec; the
 * refinement guarantees the matching field is present so the loader never has
 * to second-guess an under-specified schedule. For built-ins whose cron
 * depends on runtime config, `expression` may use the `{dayBoundaryHour}`
 * placeholder — the registry is authoritative and the loader substitutes the
 * live value (§5.5); a stale literal here is a non-fatal drift warning, not a
 * schema error.
 */
export const agentScheduleSchema = z
  .object({
    kind: z.enum(SCHEDULE_KINDS),
    expression: z.string().optional(),
    // Accept a trailing `Z` or an explicit `±hh:mm` offset (matches the
    // `browser-task` schedule input); a bare local datetime is still rejected.
    one_shot_at: z.string().datetime({ offset: true }).optional(),
    event_ref: z.string().optional(),
    // IANA timezone (e.g. "America/New_York"). Optional — the loader
    // auto-fills it from daemon config (`config.timezone`) when omitted,
    // mirroring `recurrenceRuleSchema` (schemas.ts). Defaulting a single
    // zone in this shared, US-targeted schema would silently misfire every
    // routine for operators outside that zone, so resolution is deferred to
    // load time rather than baked in here.
    timezone: z.string().min(1).optional(),
    // QUIET_HOURS_HARDENING_PLAN.md §6 — when true, a firing that lands
    // inside the owner's quiet-hours window is pushed to the window's end
    // (the whole RUN moves, mirroring the browser_task deferral) instead of
    // burning a session whose DM output would then be deferred anyway. Set
    // it whenever the Agent's expected output includes DMing the user.
    // Default false is mandatory: silent file-writing Agents deliberately
    // scheduled overnight must not move. User Agents only — built-ins fire
    // outside `recurring_schedules` and must run inside quiet hours (§2).
    defer_in_quiet_hours: z.boolean().default(false),
  })
  .refine(
    (s) =>
      (s.kind === "cron" && !!s.expression) ||
      (s.kind === "one_shot" && !!s.one_shot_at) ||
      (s.kind === "event" && !!s.event_ref),
    {
      message:
        "schedule kind requires the matching field (cron→expression, one_shot→one_shot_at, event→event_ref)",
    },
  );

/**
 * The full Agent definition (§4.3). Output of parsing `agent.md` frontmatter.
 * Optional keys carry `.default(...)` so a minimal valid file still produces a
 * fully-populated row; required objects (`schedule`, `backend`, `limits`) must
 * be present because every Agent must declare where and how it runs.
 */
export const agentDefinitionSchema = z
  .object({
    // ── Identity ──
    slug: z
      .string()
      .regex(AGENT_SLUG_PATTERN, "slug must be kebab-case matching ^[a-z][a-z0-9-]*$"),
    name: z.string().min(1),
    description: z.string().min(1),
    kind: z.enum(AGENT_KINDS),
    version: z.number().int().positive().default(1),
    enabled: z.boolean().default(true),
    // Elements `.min(1)` so a stray `[""]` can't render a blank chip in the
    // dashboard (parity with stop_warning.services_lost / dependent_agents).
    tags: z.array(z.string().min(1)).default([]),

    // ── Schedule ──
    schedule: agentScheduleSchema,

    // ── Backend / routing ──
    // `process_key` is a plain string here; the loader cross-checks a non-null
    // value against the live `PROCESS_KEYS` set (incl. custom-routine keys) at
    // load time. `null` marks a no-LLM in-process built-in pass
    // (roadmap-maintenance, context-index-reconcile) that has no routing key —
    // user Agents must carry a non-null key (enforced in superRefine).
    backend: z.object({
      process_key: z.string().min(1).nullable(),
      tier: z.enum(AGENT_TIERS).nullable().default(null),
      // `null` defers the model choice to process_backend_config; a real id
      // pins it. `.min(1)` rejects an ambiguous empty string ("" is neither).
      model: z.string().min(1).nullable().default(null),
      backend_id: z.enum(BACKEND_IDS).nullable().default(null),
    }),

    // ── Limits (per execution) ──
    limits: z.object({
      max_turns: z.number().int().positive().default(20),
      max_budget_usd: z.number().nonnegative().default(0.25),
      timeout_minutes: z.number().int().positive().default(10),
    }),

    // ── Tools / skills ──
    // `skills_replace` (Q10 v1 pick): when false (default), `tools.skills`
    // unions with the process-key default skill bundle; when true, it replaces
    // the bundle with a strict subset. The loader composes the effective set.
    tools: z
      .object({
        // Elements `.min(1)`: an empty tool/skill name is meaningless and would
        // only confuse the loader's tool-pattern / skill-manifest cross-check.
        allowed: z.array(z.string().min(1)).default([]),
        skills: z.array(z.string().min(1)).default([]),
        skills_replace: z.boolean().default(false),
      })
      .default({ allowed: [], skills: [], skills_replace: false }),

    // ── Expected outputs (drive success-criteria defaults + dashboard) ──
    outputs: z.array(z.string().min(1)).default([]),
    success_criteria: z.array(successCriterionSchema).default([]),

    // ── Operating playbooks (AGENT_PROMPT_QUALITY_DESIGN.md Phase 2) ──
    // Curated methodology fragments the dispatcher injects into this Agent's
    // prompt *by content* at fire time — the single, hard-guaranteed delivery
    // path for playbook methodology (no by-reference skill copy). Validated against
    // the `PLAYBOOK_SLUGS` registry so a typo can't silently declare a
    // non-existent playbook (and the loader/injector re-read this off disk each
    // firing, so a live edit takes effect next run — no capture-once staleness).
    // Not persisted to a column: like `tools`/`outputs`/`success_criteria`, it
    // lives in `agent.md` and is re-parsed at fire time. Defaults to `[]`, so
    // every pre-Phase-2 Agent (whose file has no `playbooks:` key) is a no-op.
    playbooks: z.array(z.enum(PLAYBOOK_SLUGS)).default([]),

    // ── Error handling ──
    on_error: z
      .object({
        retries: z.number().int().nonnegative().default(0),
        retry_delay_seconds: z.number().int().nonnegative().default(30),
        notify_owner: z.boolean().default(false),
      })
      .default({ retries: 0, retry_delay_seconds: 30, notify_owner: false }),

    // ── Stop warning (mandatory for builtins; see superRefine) ──
    stop_warning: stopWarningSchema.optional(),
  })
  .superRefine((agent, ctx) => {
    if (agent.kind === "builtin" && !agent.stop_warning) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "builtin Agents must declare stop_warning",
        path: ["stop_warning"],
      });
    }
    // `process_key: null` is reserved for the no-LLM in-process built-in passes
    // (roadmap-maintenance, context-index-reconcile). A user Agent always runs
    // an LLM turn against its prompt body, so a null key would silently make it
    // a no-op pass; reject it at parse time and point at the offending field.
    if (agent.kind === "user" && agent.backend.process_key === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "user Agents require a non-null backend.process_key",
        path: ["backend", "process_key"],
      });
    }
    // `success_criteria` ids must be unique: the post-execute evaluator
    // writes results into a `Record<criterion.id, boolean>` (§8.3), so a
    // duplicate id would silently overwrite a sibling's hit/miss. Reject the
    // collision at parse time and point at the offending entry.
    const seenCriterionIds = new Set<string>();
    agent.success_criteria.forEach((criterion, index) => {
      if (seenCriterionIds.has(criterion.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate success_criteria id "${criterion.id}"`,
          path: ["success_criteria", index, "id"],
        });
      }
      seenCriterionIds.add(criterion.id);
    });
  });

export type AgentDefinition = z.infer<typeof agentDefinitionSchema>;
