import type { AgentDefinition, StopWarning } from "@aitne/shared";

/**
 * Dashboard-side types for the `/api/agents/*` surface
 * (AGENT_DEFINITIONS_DESIGN.md §9). These mirror the JSON shapes produced by
 * the daemon's `api/routes/agents/views.ts` response shapers — kept here as a
 * single import target for the `/agents` page tree (index + detail + executions
 * + editor + modal) so the contract is declared once, the way
 * `use-repositories.ts` colocates its DTOs.
 */

export type { AgentDefinition, StopWarning };

/** `kind` of an Agent — built-in (shipped) vs user-authored (§3.3). */
export type AgentKind = "builtin" | "user";

/**
 * Hub grouping for the `/agents` index (AGENTS_HUB_REDESIGN_PLAN §4.1).
 * Built-ins carry one of the three registry categories; every user Agent is
 * `"user"`. Mirrors the daemon's `agentCategory()`.
 */
export type AgentCategory = "synthesis" | "monitoring" | "maintenance" | "user";

/**
 * A context-vault policy file an Agent reads at prompt-assembly time — its
 * editable Rulebook surface (AGENTS_HUB_REDESIGN_PLAN §4.2). Loaded/saved via
 * the context API (`/api/context/<path>`).
 */
export interface AgentPolicyFile {
  path: string;
  label: string;
  description: string;
}

/**
 * Stored per-field runtime-window overrides for the activity-scan cadence
 * (AGENTS_HUB_REDESIGN_PLAN §2). An absent field follows the legacy config
 * fallback; PATCH `schedule_window` with `null` resets a field.
 */
export interface ScheduleWindowOverrides {
  interval_minutes?: number;
  active_start_hour?: number;
  active_end_hour?: number;
  min_observations?: number;
}

/** Terminal execution outcome (daemon `AgentExecutionResult`, §5.2). */
export type AgentExecutionResult = "success" | "error" | "skipped" | "timeout";

/**
 * Interval cadence of a runtime-window Agent (today: the built-in activity-scan).
 * Resolved by the daemon from live config so the UI shows the REAL cadence
 * ("Every 60 min, 04:00–24:00") rather than the loader-ignored placeholder cron
 * the `agents` row stores for these slugs. `null` for fixed-cron / one-shot /
 * event Agents.
 */
export interface AgentIntervalCadence {
  /** Minutes between firings within the active window. */
  interval_minutes: number;
  /** Active-window start hour, local, inclusive (0–23). */
  active_start_hour: number;
  /** Active-window end hour, local, exclusive (1–24). */
  active_end_hour: number;
}

/** Schedule summary block on the list + detail row. */
export interface AgentScheduleSummary {
  kind: string;
  expression: string | null;
  timezone: string;
  /** Live interval cadence for runtime-window Agents; null otherwise. */
  interval?: AgentIntervalCadence | null;
}

/** Slim last-execution summary on the list view (§9.1). */
export interface AgentLastExecution {
  id: number;
  started_at: string | null;
  ended_at: string | null;
  result: AgentExecutionResult | null;
  cost_usd: number | null;
  output_summary: string | null;
}

/** Compact metric window on the list view — no p95 (§9.1). */
export interface AgentListMetrics {
  executions: number;
  error_rate: number | null;
  avg_cost_usd: number | null;
  criteria_hit_rate: number | null;
}

/** Full metric window on the detail view — incl. p95 (§9.2). */
export interface AgentMetricsWindow extends AgentListMetrics {
  p95_duration_seconds: number | null;
}

/** One row of `GET /api/agents` (§9.1). */
export interface AgentListItem {
  slug: string;
  name: string;
  description: string;
  kind: AgentKind;
  category: AgentCategory;
  enabled: boolean;
  tags: string[];
  schedule: AgentScheduleSummary;
  process_key: string | null;
  last_execution: AgentLastExecution | null;
  metrics_7d: AgentListMetrics;
  stop_warning: StopWarning | null;
  invalid: boolean;
  /** Present only for invalid rows — the parse/load error message (§6.6). */
  last_error?: string;
}

export interface AgentListResponse {
  agents: AgentListItem[];
}

/** Full execution row from the detail / executions endpoints (§9.2 / §9.3). */
export interface AgentExecution {
  id: number;
  agent_id: string;
  schedule_row_id: number | null;
  trigger: string | null;
  started_at: string | null;
  ended_at: string | null;
  result: AgentExecutionResult | null;
  error_kind: string | null;
  error_message: string | null;
  cost_usd: number | null;
  tokens_input: number | null;
  tokens_output: number | null;
  turns: number | null;
  success_criteria: Record<string, boolean> | null;
  output_summary: string | null;
}

/** snake_case projection of the stored DB columns on the detail view (§9.2). */
export interface AgentRow {
  slug: string;
  name: string;
  description: string;
  source: AgentKind;
  category: AgentCategory;
  definition_path: string;
  definition_hash: string | null;
  enabled: boolean;
  enabled_overridden_at: number | null;
  process_key: string | null;
  schedule_kind: string;
  schedule_expression: string | null;
  schedule_timezone: string;
  schedule_interval: AgentIntervalCadence | null;
  tags: string[];
  stop_warning: StopWarning | null;
  recurring_schedule_id: number | null;
  last_execution_id: number | null;
  version_counter: number | null;
  override_snapshot: Record<string, unknown> | null;
  invalid: boolean;
  created_at: number;
  updated_at: number;
}

/** Full `GET /api/agents/:slug` envelope (§9.2). */
export interface AgentDetailResponse {
  agent: AgentDefinition | null;
  row: AgentRow;
  recent_executions: AgentExecution[];
  metrics: {
    "7d": AgentMetricsWindow;
    "30d": AgentMetricsWindow;
    by_error_kind_7d: Record<string, number>;
  };
  definition_yaml: string | null;
  definition_path: string;
  /** Rulebook tab inputs — vault policy files this Agent reads (§4.2). */
  policy_files: AgentPolicyFile[];
  /**
   * Runtime-window editing block for the activity-scan cadence form (stored
   * overrides + resolved effective values), or `null` for every
   * non-runtime-window Agent (§2).
   */
  schedule_window: {
    overrides: ScheduleWindowOverrides;
    resolved: {
      interval_minutes: number;
      active_start_hour: number;
      active_end_hour: number;
      min_observations: number;
    };
  } | null;
}

/** `GET /api/agents/:slug/executions` envelope (§9.3). */
export interface AgentExecutionsResponse {
  slug: string;
  limit: number;
  executions: AgentExecution[];
}

/** `POST /api/agents/:slug/run-now` success envelope (§9.4, 202). */
export interface RunNowResponse {
  status: "queued";
  schedule_row_id: number;
  execution_id: number | null;
}

/** Filters for `GET /api/agents`. */
export interface AgentListFilters {
  source?: AgentKind;
  enabled?: boolean;
  include_invalid?: boolean;
}
