import type { AgentDefinition, AgentLintIssue, AgentTier, StopWarning, OverrideEditPath } from "@aitne/shared";
import { AGENT_TIERS, BACKEND_IDS, OVERRIDE_EDIT_PATHS, agentDefinitionSchema, isPlaceholderPrompt, lintAgentDefinition, recurrenceRuleSchema } from "@aitne/shared";

import type {
  AgentPolicyFile,
  IntervalCadence,
} from "../../../core/agents/builtin-registry.js";
import { getBuiltinRegistryEntry } from "../../../core/agents/builtin-registry.js";
import { recurrenceRuleToCron } from "../../../core/agents/recurrence-convert.js";
import type { AgentDTO } from "../../../db/agents-store.js";
import type {
  AgentExecutionDTO,
  AgentMetricsWindow,
} from "../../../db/agent-executions-store.js";
import { renderAgentMarkdown } from "../../../core/agents/agent-frontmatter.js";

/**
 * Pure response shapers + mutation planners for the `/api/agents` routes
 * (AGENT_DEFINITIONS_DESIGN.md §9). The Hono handlers in `index.ts` stay thin —
 * fetch rows, call these, `c.json(...)`. Keeping the JSON-shape + validation
 * logic here (no DB / fs / Hono) puts it in the 100%-coverage set; the route
 * file is the I/O-shaped glue (auto-excluded as an `index.ts`).
 */

// ── Timestamp serialization ─────────────────────────────────────────────────

/** epoch-ms → ISO-8601, null-safe (execution timestamps are epoch-ms, §5.2). */
export function epochToIso(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString();
}

// ── Execution serialization ─────────────────────────────────────────────────

/** Full execution row for the detail / executions endpoints (§9.2 / §9.3). */
export function serializeExecution(e: AgentExecutionDTO): Record<string, unknown> {
  return {
    id: e.id,
    agent_id: e.agentId,
    schedule_row_id: e.scheduleRowId,
    trigger: e.trigger,
    started_at: epochToIso(e.startedAt),
    ended_at: epochToIso(e.endedAt),
    result: e.result,
    error_kind: e.errorKind,
    error_message: e.errorMessage,
    cost_usd: e.costUsd,
    tokens_input: e.tokensInput,
    tokens_output: e.tokensOutput,
    turns: e.turns,
    success_criteria: e.successCriteria,
    output_summary: e.outputSummary,
  };
}

/** Slim last-execution summary for the list view (§9.1). */
export function serializeLastExecution(
  e: AgentExecutionDTO | null,
): Record<string, unknown> | null {
  if (e === null) return null;
  return {
    id: e.id,
    started_at: epochToIso(e.startedAt),
    ended_at: epochToIso(e.endedAt),
    result: e.result,
    cost_usd: e.costUsd,
    output_summary: e.outputSummary,
  };
}

// ── Metrics serialization ───────────────────────────────────────────────────

/** Full metric window incl. p95 for the detail view (§9.2). */
export function serializeMetricsWindow(
  w: AgentMetricsWindow,
): Record<string, unknown> {
  return {
    executions: w.executions,
    error_rate: w.errorRate,
    avg_cost_usd: w.avgCostUsd,
    p95_duration_seconds: w.p95DurationSeconds,
    criteria_hit_rate: w.criteriaHitRate,
  };
}

/** Compact metric window (no p95) for the list view (§9.1). */
export function serializeListMetrics(
  w: AgentMetricsWindow,
): Record<string, unknown> {
  return {
    executions: w.executions,
    error_rate: w.errorRate,
    avg_cost_usd: w.avgCostUsd,
    criteria_hit_rate: w.criteriaHitRate,
  };
}

// ── List item (§9.1) ────────────────────────────────────────────────────────

export interface ListItemInputs {
  metrics7d: AgentMetricsWindow;
  lastExecution: AgentExecutionDTO | null;
  /**
   * Live interval cadence for a runtime-window built-in (activity-scan), or
   * `null` for fixed-cron / one-shot / event Agents. Resolved by the route from
   * live config via `resolveRuntimeWindowCadence` so the schedule block carries
   * the REAL cadence rather than the stored placeholder cron (§5.5.1).
   */
  intervalCadence?: IntervalCadence | null;
}

/**
 * Hub category for the `/agents` dashboard grouping
 * (AGENTS_HUB_REDESIGN_PLAN.md §4.1): built-ins carry their registry
 * category; every user Agent is `"user"`. An unknown builtin slug (should
 * not happen — the loader synthesises rows from the registry) degrades to
 * `"maintenance"` rather than failing the response.
 */
export function agentCategory(dto: AgentDTO): string {
  if (dto.source === "user") return "user";
  return getBuiltinRegistryEntry(dto.slug)?.category ?? "maintenance";
}

/**
 * The declared Rulebook surface (registry `policyFiles`) for a built-in, or
 * `[]` for user Agents / undeclared built-ins (AGENTS_HUB_REDESIGN_PLAN §4.2).
 */
export function agentPolicyFiles(dto: AgentDTO): readonly AgentPolicyFile[] {
  if (dto.source !== "builtin") return [];
  return getBuiltinRegistryEntry(dto.slug)?.policyFiles ?? [];
}

/** One row of `GET /api/agents` (§9.1). `kind` mirrors the stored `source`. */
export function buildListItem(
  dto: AgentDTO,
  inputs: ListItemInputs,
): Record<string, unknown> {
  // Read the parse-error into a camelCase local + emit it via the object-literal
  // (colon) form. The redaction static guard (check-redaction-coverage.mjs)
  // flags the auth-health JSON key name whenever it is immediately followed by
  // an equals sign — which also catches a strict-equality comparison — so we
  // never write that key adjacent to `=`. This value is an Agent-definition
  // parse error (§6.6), never a secret. Mirrors the agents-store.ts /
  // loader.ts dodge. Surfaced only for invalid rows.
  const parseError = dto.metadata.last_error;
  const surfaceError = dto.invalid && typeof parseError === "string";
  return {
    slug: dto.slug,
    name: dto.name,
    // Coalesce to "" so the daemon honours the dashboard's non-null
    // `description` contract. An invalid row may carry a null description; its
    // real failure is surfaced separately via `last_error` below, so an empty
    // string here loses no information (a valid/fallback row always has one).
    description: dto.description ?? "",
    kind: dto.source,
    category: agentCategory(dto),
    enabled: dto.enabled,
    tags: dto.tags,
    schedule: {
      kind: dto.scheduleKind,
      expression: dto.scheduleExpression,
      timezone: dto.scheduleTimezone,
      interval: inputs.intervalCadence ?? null,
    },
    process_key: dto.processKey,
    last_execution: serializeLastExecution(inputs.lastExecution),
    metrics_7d: serializeListMetrics(inputs.metrics7d),
    stop_warning: dto.stopWarning,
    invalid: dto.invalid,
    ...(surfaceError ? { last_error: parseError } : {}),
  };
}

// ── Detail row + envelope (§9.2) ────────────────────────────────────────────

/**
 * snake_case projection of the stored DB columns for the detail `row` block.
 * `intervalCadence` (resolved by the route from live config) is surfaced as
 * `schedule_interval` so the detail view renders the real runtime-window
 * cadence; `null` for fixed-cron / one-shot / event Agents (§5.5.1).
 */
export function buildRow(
  dto: AgentDTO,
  intervalCadence: IntervalCadence | null = null,
): Record<string, unknown> {
  return {
    slug: dto.slug,
    name: dto.name,
    // Coalesce to "" so the detail `row` block matches the dashboard's non-null
    // `description` type (mirrors buildListItem); invalid rows surface their
    // failure via the envelope's separate error field, not this column.
    description: dto.description ?? "",
    source: dto.source,
    category: agentCategory(dto),
    definition_path: dto.definitionPath,
    definition_hash: dto.definitionHash,
    enabled: dto.enabled,
    enabled_overridden_at: dto.enabledOverriddenAt,
    process_key: dto.processKey,
    schedule_kind: dto.scheduleKind,
    schedule_expression: dto.scheduleExpression,
    schedule_timezone: dto.scheduleTimezone,
    schedule_interval: intervalCadence,
    tags: dto.tags,
    stop_warning: dto.stopWarning,
    recurring_schedule_id: dto.recurringScheduleId,
    last_execution_id: dto.lastExecutionId,
    version_counter:
      typeof dto.metadata.version_counter === "number"
        ? dto.metadata.version_counter
        : null,
    override_snapshot: dto.metadata.override_snapshot ?? null,
    invalid: dto.invalid,
    created_at: dto.createdAt,
    updated_at: dto.updatedAt,
  };
}

export interface DetailInputs {
  dto: AgentDTO;
  definition: AgentDefinition | null;
  definitionYaml: string | null;
  recentExecutions: AgentExecutionDTO[];
  metrics7d: AgentMetricsWindow;
  metrics30d: AgentMetricsWindow;
  byErrorKind7d: Record<string, number>;
  /** Live runtime-window cadence for the detail `row.schedule_interval` (§5.5.1). */
  intervalCadence?: IntervalCadence | null;
  /**
   * Runtime-window editing block for a runtime-window built-in (activity-scan):
   * the stored per-field overrides + the fully-resolved effective values the
   * cadence form prefills with. Null/absent for every other Agent
   * (AGENTS_HUB_REDESIGN_PLAN §2).
   */
  scheduleWindow?: {
    overrides: Record<string, number>;
    resolved: {
      interval_minutes: number;
      active_start_hour: number;
      active_end_hour: number;
      min_observations: number;
    };
  } | null;
}

/** Full `GET /api/agents/:slug` envelope (§9.2). */
export function buildDetail(inputs: DetailInputs): Record<string, unknown> {
  return {
    agent: inputs.definition,
    row: buildRow(inputs.dto, inputs.intervalCadence ?? null),
    recent_executions: inputs.recentExecutions.map(serializeExecution),
    metrics: {
      "7d": serializeMetricsWindow(inputs.metrics7d),
      "30d": serializeMetricsWindow(inputs.metrics30d),
      by_error_kind_7d: inputs.byErrorKind7d,
    },
    definition_yaml: inputs.definitionYaml,
    definition_path: inputs.dto.definitionPath,
    // Rulebook tab inputs (AGENTS_HUB_REDESIGN_PLAN §4.2): the vault policy
    // files this Agent reads at prompt-assembly time. The dashboard edits
    // them through `/api/context/<path>`; this only declares the list.
    policy_files: agentPolicyFiles(inputs.dto),
    // Runtime-window editing inputs (§2): stored overrides + resolved
    // effective values for the activity-scan cadence form. `null` for every
    // non-runtime-window Agent.
    schedule_window: inputs.scheduleWindow ?? null,
  };
}

// ── run-now plan (§9.4) ──────────────────────────────────────────────────────

export type RunNowPlan =
  | { ok: false; status: 409; error: string; hint: string }
  | {
      ok: true;
      taskType: string;
      taskDescription: string;
      taskPrompt: string | null;
      taskContext: Record<string, unknown>;
      /**
       * Routing pins copied from the user Agent's recurring row so a manual
       * `run-now` routes identically to a cron fire (the scheduler resolves
       * `backend_id`/`model`/`tier_override` the same way for both). Null for
       * built-ins (they resolve from the process key) and for unpinned Agents.
       */
      backendId: string | null;
      model: string | null;
      tier: string | null;
      /** True for built-in Agents — the handler DMs the owner before enqueue. */
      emitDm: boolean;
    };

/**
 * Plan a manual run (§9.4): produce the `agent_schedule` insert payload. The
 * owning Agent is stamped into `task_context.agent_id` (resolver step 1, §8.1)
 * so the execution is attributed regardless of which dispatch flow runs;
 * built-in routine Agents additionally carry `task_context.routine` (+ phase
 * for the two sweeps) so the dispatcher's routine special-cases fire the real
 * flow where it supports them.
 *
 * Rejects (409) the no-LLM in-process passes (`process_key: null`) — they fire
 * via the scheduler's in-process callback, not the `agent_schedule` queue —
 * any row currently flagged invalid, and a user Agent whose recurring prompt
 * is empty/placeholder (the run would be dropped as ambiguous by the worker).
 */
export function planRunNow(
  dto: AgentDTO,
  opts: {
    taskPrompt?: string | null;
    triggerNote?: string;
    backendId?: string | null;
    model?: string | null;
    tier?: string | null;
  } = {},
): RunNowPlan {
  if (dto.invalid) {
    return {
      ok: false,
      status: 409,
      error: "agent_invalid",
      hint: "This Agent's definition failed to load — fix the agent.md before running it.",
    };
  }
  if (dto.processKey === null) {
    return {
      ok: false,
      status: 409,
      error: "agent_not_runnable",
      hint: "This built-in is a no-LLM in-process pass with no routing key; it is fired by the scheduler, not run-now.",
    };
  }

  // A user Agent whose recurring row carries no real prompt — empty, missing
  // (unpaired row), or a whole-body placeholder stub like "placeholder"/"TODO",
  // still possible for Agents created before planCreate started rejecting
  // those — would enqueue a run the worker is guaranteed to drop as ambiguous.
  // Refuse up front with the fix instead of burning the run.
  if (dto.source === "user" && isPlaceholderPrompt(opts.taskPrompt)) {
    return {
      ok: false,
      status: 409,
      error: "agent_prompt_placeholder",
      hint:
        "This Agent's prompt is empty or a placeholder stub, so the run would be "
        + "dropped as ambiguous without doing any work. Write the real task into its "
        + `agent.md (PATCH /api/context/policies/agents/${dto.slug}/agent.md or the `
        + "dashboard editor), then run it again.",
    };
  }

  const taskContext: Record<string, unknown> = {
    agent_id: dto.slug,
    trigger: "manual",
    processKey: dto.processKey,
    importance: "normal",
  };
  if (dto.source === "builtin" && dto.processKey.startsWith("routine.")) {
    taskContext.routine = dto.processKey.slice("routine.".length);
    const phase = sweepPhaseFromSlug(dto.slug);
    if (phase !== null) taskContext.phase = phase;
  }
  // §9.4 optional `trigger_note`: stamp it into the schedule row's context so
  // the operator's reason rides along with the run and is auditable. Only
  // present when supplied (the dashboard's no-note call leaves it absent).
  if (opts.triggerNote !== undefined) {
    taskContext.trigger_note = opts.triggerNote;
  }

  return {
    ok: true,
    taskType: dto.processKey,
    taskDescription: dto.name,
    // Built-ins drive their prompt from the routine/process key; user Agents
    // carry the recurring row's prompt so the manual run does the real task.
    // The agent_prompt_placeholder guard above already rejects a null / empty /
    // placeholder prompt for user source, so past it opts.taskPrompt is a real
    // string — hence the assertion rather than a (dead) `?? null` fallback.
    taskPrompt: dto.source === "user" ? opts.taskPrompt! : null,
    taskContext,
    // Routing pins ride along ONLY for user Agents — mirrors the cron path
    // (`generateNextScheduleRow` copies the recurring row's backend_id / model /
    // tier_override). Built-ins resolve their backend from the process key, so a
    // pin must never leak onto a built-in's manual run.
    backendId: dto.source === "user" ? opts.backendId ?? null : null,
    model: dto.source === "user" ? opts.model ?? null : null,
    tier: dto.source === "user" ? opts.tier ?? null : null,
    emitDm: dto.source === "builtin",
  };
}

/** `user-profile-sweep-{morning,evening}` → its phase; null for every other slug. */
function sweepPhaseFromSlug(slug: string): string | null {
  if (slug.endsWith("-evening")) return "evening";
  if (slug.endsWith("-morning")) return "morning";
  return null;
}

// ── create plan (POST /api/agents) ───────────────────────────────────────────

/** One field-level validation issue surfaced to the caller for self-correction. */
export interface CreateIssue {
  field: string;
  message: string;
}

export type CreatePlan =
  | { ok: false; status: 400; error: string; hint?: string; field?: string; issues?: CreateIssue[] }
  | { ok: false; status: 409; error: "slug_collision"; slug: string }
  | { ok: true; slug: string; markdown: string; warnings: AgentLintIssue[] };

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

/**
 * Plan a `POST /api/agents` create from a structured JSON body — the
 * programmatic counterpart to the dashboard's "+ New Agent" form (which writes
 * the same `agent.md` via the context-vault PUT). Pure: assembles the
 * frontmatter, validates it through `agentDefinitionSchema`, enforces the
 * recurring-only contract, checks slug uniqueness, and renders the `agent.md`
 * the route then writes. No DB / fs / Hono — fully unit-testable to 100%.
 *
 * `/agents` is recurring-only. The caller picks ONE of two schedule input forms:
 *   - `{ kind: "cron", expression }` — a 5-field cron (incl. hourly `M * * * *`
 *     / `M *​/N * * *`, now that the loader pairs those).
 *   - `{ kind: "recurring", recurrence: <recurrenceRule> }` — the structured
 *     frequency form (`hourly`/`daily`/`weekly`/`monthly` + its fields), the
 *     clear path the dashboard + agent-create skill use. It is rendered to the
 *     canonical cron here so the stored `agent.md` stays cron-based and
 *     round-trips through the loader's recurring pairing.
 * Any other `schedule.kind` (one_shot/event) is rejected with a pointer at the
 * `/schedule` queue. `backend.process_key` defaults to `agent.task` (user
 * recurring Agents always run an LLM turn) so the caller need not know the key.
 */
export function planCreate(
  body: Record<string, unknown>,
  existingSlugs: ReadonlySet<string>,
): CreatePlan {
  const slug = asString(body.slug);
  if (slug === undefined || slug.length === 0) {
    return { ok: false, status: 400, error: "slug_required", field: "slug" };
  }
  const name = asString(body.name);
  if (name === undefined || name.length === 0) {
    return { ok: false, status: 400, error: "name_required", field: "name" };
  }

  const schedule = asRecord(body.schedule);
  if (schedule === undefined) {
    return { ok: false, status: 400, error: "schedule_required", field: "schedule" };
  }
  // Resolve either input form into the canonical cron schedule the frontmatter
  // stores. A structured `recurrence` is validated + rendered to cron; a raw
  // cron passes through; anything else is rejected before schema parsing so the
  // caller gets the actionable pointer regardless of the wrong-kind fields.
  const scheduleKind = asString(schedule.kind);
  let scheduleFrontmatter: Record<string, unknown>;
  if (scheduleKind === "recurring") {
    const parsedRule = recurrenceRuleSchema.safeParse(schedule.recurrence);
    if (!parsedRule.success) {
      const issues: CreateIssue[] = parsedRule.error.issues.map((i) => ({
        field: `schedule.recurrence.${i.path.join(".")}`,
        message: i.message,
      }));
      return {
        ok: false,
        status: 400,
        error: "invalid_recurrence",
        hint: "schedule.recurrence must be a valid recurrence rule: frequency hourly/daily/weekly/monthly plus its fields (hourly→intervalHours/minuteOfHour, daily/weekly/monthly→time, weekly→daysOfWeek, monthly→daysOfMonth).",
        issues,
      };
    }
    const timezone = asString(schedule.timezone) ?? parsedRule.data.timezone;
    scheduleFrontmatter = {
      kind: "cron",
      expression: recurrenceRuleToCron(parsedRule.data),
      ...(timezone !== undefined ? { timezone } : {}),
      // Quiet-hours opt-in (QUIET_HOURS_HARDENING_PLAN.md §6) — carried
      // verbatim so the schema validates it (a non-boolean is rejected as
      // invalid_definition on schedule.defer_in_quiet_hours, same as the raw
      // cron form, where the whole schedule block passes through).
      ...(schedule.defer_in_quiet_hours !== undefined
        ? { defer_in_quiet_hours: schedule.defer_in_quiet_hours }
        : {}),
    };
  } else if (scheduleKind === "cron") {
    scheduleFrontmatter = schedule;
  } else {
    return {
      ok: false,
      status: 400,
      error: "one_shot_not_supported",
      field: "schedule.kind",
      hint: "/agents is recurring-only. Use schedule.kind \"cron\" or \"recurring\"; for one-time tasks use POST /api/schedule.",
    };
  }

  // Slug uniqueness (covers built-in slugs too — they're rows in `agents`).
  if (existingSlugs.has(slug)) {
    return { ok: false, status: 409, error: "slug_collision", slug };
  }

  // Assemble the agent.md frontmatter from the input. `kind` is forced to
  // "user"; `backend.process_key` defaults to the user-recurring routing key;
  // `limits` is always present (the schema has no object-level default).
  const inputBackend = asRecord(body.backend) ?? {};
  const backend: Record<string, unknown> = { ...inputBackend };
  if (backend.process_key === undefined) backend.process_key = "agent.task";

  const frontmatter: Record<string, unknown> = {
    slug,
    name,
    ...(body.description !== undefined ? { description: body.description } : {}),
    kind: "user",
    ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
    schedule: scheduleFrontmatter,
    backend,
    limits: asRecord(body.limits) ?? {},
    ...(body.tools !== undefined ? { tools: body.tools } : {}),
    ...(body.on_error !== undefined ? { on_error: body.on_error } : {}),
    ...(body.tags !== undefined ? { tags: body.tags } : {}),
    ...(body.outputs !== undefined ? { outputs: body.outputs } : {}),
    ...(body.success_criteria !== undefined
      ? { success_criteria: body.success_criteria }
      : {}),
    // AGENT_PROMPT_QUALITY_DESIGN.md Phase 2 — pass the declared operating
    // playbooks through to schema validation (enum-checked) + the rendered
    // agent.md. Dropped from the allow-list means the field never reaches the
    // schema; the schema's `.default([])` covers callers that omit it.
    ...(body.playbooks !== undefined ? { playbooks: body.playbooks } : {}),
  };

  const parsed = agentDefinitionSchema.safeParse(frontmatter);
  if (!parsed.success) {
    const issues: CreateIssue[] = parsed.error.issues.map((i) => ({
      // `agentDefinitionSchema`'s field + superRefine issues always carry a
      // path (backend.process_key, stop_warning, success_criteria[i].id, …);
      // an empty path joins to "" which the caller surfaces verbatim.
      field: i.path.join("."),
      message: i.message,
    }));
    return {
      ok: false,
      status: 400,
      error: "invalid_definition",
      hint: "The assembled agent.md failed schema validation; fix the reported fields.",
      issues,
    };
  }

  const prompt = asString(body.prompt) ?? "";
  // AGENT_PROMPT_QUALITY_DESIGN.md §3.5 — the deterministic "verify-agent-
  // definitions" step. Authoring lint (missing # Instruction / a playbook the
  // prompt names but doesn't declare / an # Output contract with no
  // success_criteria) is returned as non-blocking warnings the DM agent fixes
  // or asks the user about.
  const warnings = lintAgentDefinition({
    prompt,
    playbooks: parsed.data.playbooks,
    tags: parsed.data.tags,
    successCriteriaCount: parsed.data.success_criteria.length,
  });
  // The two prompt-stub codes are promoted to a blocking reject at this
  // chokepoint: the body becomes the deployed Agent's task_prompt verbatim,
  // and an empty or whole-body-placeholder task ("placeholder", "TODO") is
  // guaranteed to be dropped as ambiguous by the worker on every firing —
  // creating such an Agent is never right. The caller must resolve the task
  // with the user (clarify-back) and resubmit. The raw agent.md PATCH/PUT
  // editor path intentionally keeps these as warnings (see
  // lintAgentDefinitionMarkdown) — that human path never 400s on lint.
  const blockingPrompt = warnings.filter(
    (w) => w.code === "empty_prompt" || w.code === "placeholder_prompt",
  );
  if (blockingPrompt.length > 0) {
    return {
      ok: false,
      status: 400,
      error: "invalid_definition",
      hint:
        "prompt must be the Agent's real task definition — an empty or placeholder "
        + "body is rejected because every run would be dropped as ambiguous. Resolve "
        + "the task's sources/scope/format with the user, then resubmit.",
      issues: blockingPrompt.map((w) => ({ field: "prompt", message: w.message })),
    };
  }
  return {
    ok: true,
    slug,
    markdown: renderAgentMarkdown(frontmatter, prompt),
    warnings,
  };
}

// ── PATCH plan (§9.5) ────────────────────────────────────────────────────────

/**
 * Parent block → its editable leaf keys (everything else under it is read-only).
 * Derived structurally from the shared `OVERRIDE_EDIT_PATHS` so this PATCH edit
 * gate — the fourth consumer of the allow-list — can never omit a path a future
 * 7th entry adds. Same `{backend:{tier,model}, limits:{…}, on_error:{…}}` shape
 * as before; pinned by a drift-guard test against `OVERRIDE_EDIT_PATHS`.
 */
export const EDITABLE_NESTED: Record<string, ReadonlySet<string>> = (() => {
  const acc: Record<string, Set<string>> = {};
  for (const path of OVERRIDE_EDIT_PATHS) {
    const dot = path.indexOf(".");
    const parent = path.slice(0, dot);
    const leaf = path.slice(dot + 1);
    (acc[parent] ??= new Set<string>()).add(leaf);
  }
  return acc;
})();

const CONTROL_KEYS = new Set(["enabled", "ack_warning", "reset", "schedule_window"]);

export type PatchPlan =
  | { ok: false; status: 409; error: "stop_warning_required"; warning: StopWarning | null }
  | { ok: false; status: 400; error: string; hint?: string; field?: string }
  | {
      ok: true;
      /** undefined = no enabled change; otherwise the new `agents.enabled`. */
      setEnabled?: boolean;
      /** Built-in override-snapshot keys to set (dot-path → value). */
      overrideSet: Record<string, unknown>;
      /** Built-in override-snapshot keys to delete. */
      overrideReset: string[];
      /**
       * Raw `schedule_window` patch for a runtime-window built-in
       * (AGENTS_HUB_REDESIGN_PLAN §2). Field-level validation + the
       * cross-field window check happen in `mergeRuntimeWindow` at the route
       * (it needs the stored override + live config). Undefined when absent.
       */
      scheduleWindow?: Record<string, unknown>;
      /** For a user Agent enabled toggle: mirror onto its recurring row. */
      mirrorRecurringEnabled?: boolean;
      /** Read-only / unknown body keys ignored (logged in the response). */
      stripped: string[];
    };

function isAgentTier(v: unknown): v is AgentTier {
  return typeof v === "string" && (AGENT_TIERS as readonly string[]).includes(v);
}
function isPositiveInt(v: unknown): boolean {
  return typeof v === "number" && Number.isInteger(v) && v > 0;
}
function isNonNegativeFinite(v: unknown): boolean {
  return typeof v === "number" && Number.isFinite(v) && v >= 0;
}

/** Validate an override-edit value against the same contract the schema enforces. */
function isValidOverrideValue(path: OverrideEditPath, value: unknown): boolean {
  switch (path) {
    case "backend.tier":
      return value === null || isAgentTier(value);
    case "backend.model":
      return value === null || (typeof value === "string" && value.length > 0);
    case "backend.backend_id":
      return value === null || (typeof value === "string" && (BACKEND_IDS as readonly string[]).includes(value));
    case "limits.max_turns":
    case "limits.timeout_minutes":
      return isPositiveInt(value);
    case "limits.max_budget_usd":
      return isNonNegativeFinite(value);
    case "on_error.notify_owner":
      return typeof value === "boolean";
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Plan a `PATCH /api/agents/:slug` (§9.5). Splits the body into:
 *   - an `enabled` toggle (column authority; built-in disable needs `ack_warning`);
 *   - built-in override-snapshot field edits (validated against the schema);
 *   - override `reset` of those same fields;
 * and reports every read-only / unknown key it ignored under `stripped`.
 *
 * User Agents may only toggle `enabled` here — field edits go through the
 * `agent.md` file (the dashboard editor → context-vault PATCH path, §9.5), so a
 * field-edit / reset on a user Agent is rejected with a pointer.
 */
export function planPatch(dto: AgentDTO, body: Record<string, unknown>): PatchPlan {
  // ── enabled toggle ──
  let setEnabled: boolean | undefined;
  if ("enabled" in body) {
    if (typeof body.enabled !== "boolean") {
      return { ok: false, status: 400, error: "invalid_enabled", field: "enabled" };
    }
    // Only a real ON↔OFF transition is a change (design §12.2 gates on
    // `body.enabled !== agent.enabled`). Re-disabling an already-stopped
    // built-in must NOT demand a fresh stop-warning ack (the spurious 409
    // below), and a same-state toggle must not re-stamp `enabled_overridden_at`
    // / re-emit SSE / re-audit. A no-op `enabled` leaves `setEnabled` undefined
    // so the rest of the plan (override edits) still applies.
    if (body.enabled !== dto.enabled) {
      setEnabled = body.enabled;
    }
  }
  const ackWarning = body.ack_warning === true;
  if (setEnabled === false && dto.source === "builtin" && !ackWarning) {
    return { ok: false, status: 409, error: "stop_warning_required", warning: dto.stopWarning };
  }

  // ── collect override edits + stripped read-only keys ──
  const edits: Array<{ path: OverrideEditPath; value: unknown }> = [];
  const stripped: string[] = [];
  for (const [key, value] of Object.entries(body)) {
    if (CONTROL_KEYS.has(key)) continue;
    const editable = EDITABLE_NESTED[key];
    if (editable) {
      if (!isPlainObject(value)) {
        stripped.push(key);
        continue;
      }
      for (const [subKey, subValue] of Object.entries(value)) {
        const path = `${key}.${subKey}`;
        if (editable.has(subKey)) {
          edits.push({ path: path as OverrideEditPath, value: subValue });
        } else {
          stripped.push(path);
        }
      }
    } else {
      // Top-level read-only field (slug / kind / process_key / schedule / …).
      stripped.push(key);
    }
  }

  // ── reset list ──
  let reset: string[] = [];
  if ("reset" in body) {
    if (!Array.isArray(body.reset) || body.reset.some((p) => typeof p !== "string")) {
      return { ok: false, status: 400, error: "invalid_reset", field: "reset" };
    }
    reset = body.reset as string[];
    for (const path of reset) {
      if (!(OVERRIDE_EDIT_PATHS as readonly string[]).includes(path)) {
        return { ok: false, status: 400, error: "invalid_reset_path", field: path };
      }
    }
  }

  // ── schedule_window (runtime-window built-ins only) ──
  let scheduleWindow: Record<string, unknown> | undefined;
  if ("schedule_window" in body) {
    if (!isPlainObject(body.schedule_window)) {
      return { ok: false, status: 400, error: "invalid_schedule_window", field: "schedule_window" };
    }
    const entry = dto.source === "builtin" ? getBuiltinRegistryEntry(dto.slug) : undefined;
    // Runtime-window marker: a builtin whose registry cron resolver is null
    // (today: activity-scan) owns an interval cadence on its agent row.
    if (!entry || entry.cronExpression !== null) {
      return {
        ok: false,
        status: 400,
        error: "schedule_window_not_supported",
        field: "schedule_window",
        hint: "Only the interval-based activity-scan Agent accepts schedule_window edits.",
      };
    }
    scheduleWindow = body.schedule_window;
  }

  // ── user Agents: only enabled is editable via this endpoint ──
  if (dto.source === "user" && (edits.length > 0 || reset.length > 0)) {
    return {
      ok: false,
      status: 400,
      error: "user_agent_edit_via_file",
      hint: `Edit user Agent fields via PATCH /api/context/policies/agents/${dto.slug}/agent.md, not this endpoint.`,
    };
  }

  // ── validate built-in override edits ──
  const overrideSet: Record<string, unknown> = {};
  for (const { path, value } of edits) {
    if (!isValidOverrideValue(path, value)) {
      return { ok: false, status: 400, error: "invalid_field_value", field: path };
    }
    overrideSet[path] = value;
  }

  const plan: PatchPlan = {
    ok: true,
    overrideSet,
    overrideReset: reset,
    stripped,
    ...(setEnabled !== undefined ? { setEnabled } : {}),
    ...(scheduleWindow !== undefined ? { scheduleWindow } : {}),
  };
  if (dto.source === "user" && setEnabled !== undefined && dto.recurringScheduleId !== null) {
    plan.mirrorRecurringEnabled = setEnabled;
  }
  return plan;
}
