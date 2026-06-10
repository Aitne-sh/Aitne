import yaml from "js-yaml";
import {
  AGENT_SLUG_PATTERN,
  AGENT_TIERS,
  RUNTIME_AVAILABLE_BACKEND_IDS,
} from "@aitne/shared";

/**
 * Pure logic for the form-based "+ New Agent" flow (§10.1). The YAML editor
 * (`UserAgentYamlEditor`) asks the operator to hand-author the whole nested
 * `agent.md` frontmatter, which is opaque to non-technical users. This module
 * lets the dialog collect the common fields — name, description, enabled,
 * schedule, backend, limits, prompt — through plain inputs and *render* a
 * schema-valid `agent.md`, so the operator never sees YAML unless they opt into
 * the advanced editor.
 *
 * Keeping the state shape, validation, slug derivation, and markdown rendering
 * here (no React, no I/O) mirrors `format.ts` / `yaml-edit.ts`: the component is
 * thin glue, the rules are unit-tested in isolation. The rendered document is
 * the same shape `renderAgentMarkdown` (daemon) and `scaffoldUserAgentMarkdown`
 * emit, so it round-trips cleanly through `validateAgentMarkdown` — the test
 * asserts exactly that, which is what keeps this builder honest against the
 * shared `agentDefinitionSchema`.
 */

/**
 * Schedule shapes the form offers, all rendered to a cron `expression`:
 * `hourly` → `M * * * *` / `M *​/N * * *`; `daily`/`weekly`/`monthly` →
 * `M H …`. These are exactly the shapes the loader's `cronToRecurrenceSpec`
 * pairs with a `recurring_schedules` row, so a form-built Agent fires through
 * the same path as a hand-authored one. `/agents` is recurring-only: a one-time
 * task is a one-shot wake on the `/schedule` queue, not an Agent — so there is
 * no `once` option here. (Sub-hourly, e.g. every 30 min, is not offered — only
 * the built-in hourly-check supports that, via config.)
 */
export const AGENT_SCHEDULE_FREQUENCIES = ["hourly", "daily", "weekly", "monthly"] as const;
export type AgentScheduleFrequency = (typeof AGENT_SCHEDULE_FREQUENCIES)[number];

/** Backend-engine choices for the dropdown — "" means "use the configured default".
 *  Gated to `RUNTIME_AVAILABLE_BACKEND_IDS` (backends actually wired into the
 *  `BackendRouter` this build), matching the settings/commands + self-learning
 *  pickers — a pinned backend that can't fire would fail dispatch. */
export const AGENT_BACKEND_CHOICES = ["", ...RUNTIME_AVAILABLE_BACKEND_IDS] as const;
/** Model-tier choices for the dropdown — "" means "use the configured default". */
export const AGENT_TIER_CHOICES = ["", ...AGENT_TIERS] as const;

/** The user-Agent default routing key (confirmed in `process-key.ts`). The form
 *  pins this; the backend *engine* and *tier* are the operator-facing knobs. */
export const USER_AGENT_PROCESS_KEY = "agent.task";

/** Schema defaults, surfaced so the form's initial state matches a minimal valid file. */
export const DEFAULT_MAX_TURNS = 20;
export const DEFAULT_MAX_BUDGET_USD = 0.25;
export const DEFAULT_TIMEOUT_MINUTES = 10;

/** Flat, serialisable form state. UI-only concerns (e.g. whether the operator
 *  hand-edited the slug) live in the component, not here. */
export interface AgentFormState {
  name: string;
  /** URL/directory id. Auto-derived from `name` by the component, editable. */
  slug: string;
  description: string;
  enabled: boolean;
  frequency: AgentScheduleFrequency;
  /** HH:MM, 24-hour — used by daily/weekly/monthly. */
  time: string;
  /** 1…23 — used by hourly (fire every N hours). */
  intervalHours: number;
  /** 0…59 — used by hourly (minute-of-hour to fire at). */
  minuteOfHour: number;
  /** 0=Sun … 6=Sat — used by weekly. */
  daysOfWeek: number[];
  /** 1…31 — used by monthly. */
  daysOfMonth: number[];
  /** Quiet-hours opt-in (QUIET_HOURS_HARDENING_PLAN.md §6): when true, a
   *  firing that lands inside quiet hours runs at the window's end instead.
   *  Set it whenever the agent's expected output includes DMing the user. */
  deferInQuietHours: boolean;
  /** "" = default routing; otherwise a `BackendId`. */
  backendId: string;
  /** "" = default tier; otherwise an `AgentTier`. */
  tier: string;
  maxTurns: number;
  maxBudgetUsd: number;
  timeoutMinutes: number;
  /** The Agent's task prompt — becomes the Markdown body. */
  prompt: string;
}

export const EMPTY_AGENT_FORM_STATE: AgentFormState = {
  name: "",
  slug: "",
  description: "",
  enabled: true,
  frequency: "daily",
  time: "09:00",
  intervalHours: 1,
  minuteOfHour: 0,
  daysOfWeek: [],
  daysOfMonth: [],
  deferInQuietHours: false,
  backendId: "",
  tier: "",
  maxTurns: DEFAULT_MAX_TURNS,
  maxBudgetUsd: DEFAULT_MAX_BUDGET_USD,
  timeoutMinutes: DEFAULT_TIMEOUT_MINUTES,
  prompt: "",
};

/**
 * Derive a slug from a free-text name: lowercase, non-alphanumeric runs → a
 * single hyphen, trimmed. The result may still be invalid (empty, or
 * leading-digit) — that is `validateAgentForm`'s job to flag with a clear
 * message rather than silently mangle the operator's intent. A name with no
 * ASCII alphanumerics (e.g. all-CJK) yields "" so the operator types an id.
 */
export function slugifyAgentName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export interface AgentFormErrors {
  name?: string;
  slug?: string;
  description?: string;
  time?: string;
  intervalHours?: string;
  minuteOfHour?: string;
  daysOfWeek?: string;
  daysOfMonth?: string;
  maxTurns?: string;
  maxBudgetUsd?: string;
  timeoutMinutes?: string;
  prompt?: string;
}

/**
 * Field-level validator. Returns `null` when the form is ready to save, or an
 * errors object keyed by field. `existingSlugs` lets the dialog reject a slug
 * that would clobber another Agent's `agent.md` (a real risk of the raw PUT
 * path — a colliding slug overwrites the existing file).
 */
export function validateAgentForm(
  state: AgentFormState,
  existingSlugs: readonly string[] = [],
): AgentFormErrors | null {
  const errs: AgentFormErrors = {};

  if (state.name.trim().length === 0) {
    errs.name = "Name is required.";
  }

  const slug = state.slug.trim();
  if (slug.length === 0) {
    errs.slug = "ID is required.";
  } else if (!AGENT_SLUG_PATTERN.test(slug)) {
    errs.slug =
      "ID must be lowercase letters, numbers and hyphens, and start with a letter (e.g. daily-digest).";
  } else if (existingSlugs.includes(slug)) {
    errs.slug = `An agent with the ID "${slug}" already exists — choose a different ID.`;
  }

  if (state.description.trim().length === 0) {
    errs.description = "Description is required.";
  }

  if (state.prompt.trim().length === 0) {
    errs.prompt = "Task prompt is required — it is what the agent does each time it runs.";
  }

  if (state.frequency === "hourly") {
    if (!Number.isInteger(state.intervalHours) || state.intervalHours < 1 || state.intervalHours > 23) {
      errs.intervalHours = "Every N hours must be a whole number from 1 to 23.";
    }
    if (!Number.isInteger(state.minuteOfHour) || state.minuteOfHour < 0 || state.minuteOfHour > 59) {
      errs.minuteOfHour = "Minute must be a whole number from 0 to 59.";
    }
  } else if (!/^\d{2}:\d{2}$/.test(state.time)) {
    errs.time = "Time must be HH:MM.";
  }
  if (state.frequency === "weekly" && state.daysOfWeek.length === 0) {
    errs.daysOfWeek = "Select at least one day of the week.";
  }
  if (state.frequency === "monthly" && state.daysOfMonth.length === 0) {
    errs.daysOfMonth = "Select at least one day of the month.";
  }

  if (!Number.isInteger(state.maxTurns) || state.maxTurns < 1) {
    errs.maxTurns = "Must be a whole number of 1 or more.";
  }
  if (Number.isNaN(state.maxBudgetUsd) || state.maxBudgetUsd < 0) {
    errs.maxBudgetUsd = "Must be 0 or more.";
  }
  if (!Number.isInteger(state.timeoutMinutes) || state.timeoutMinutes < 1) {
    errs.timeoutMinutes = "Must be a whole number of 1 or more.";
  }

  return Object.keys(errs).length === 0 ? null : errs;
}

/** Zero-pad a clock field to two digits. */
function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/**
 * Render the schedule's cron expression. The shapes (`M * * * *` / `M *​/N * * *`
 * for hourly, `M H * * *`, `M H * * <dow>`, `M H <dom> * *`) are exactly the
 * ones the loader's `cronToRecurrenceSpec` can pair with a `recurring_schedules`
 * row, so a form-built Agent fires through the same path as a hand-authored one.
 */
export function agentFormToCron(state: AgentFormState): string {
  if (state.frequency === "hourly") {
    const n = state.intervalHours;
    return `${state.minuteOfHour} ${n === 1 ? "*" : `*/${n}`} * * *`;
  }

  const [hourStr, minuteStr] = state.time.split(":");
  const hour = Number.parseInt(hourStr, 10);
  const minute = Number.parseInt(minuteStr, 10);
  const hh = Number.isFinite(hour) ? hour : 0;
  const mm = Number.isFinite(minute) ? minute : 0;

  if (state.frequency === "weekly") {
    const dow =
      state.daysOfWeek.length > 0
        ? [...state.daysOfWeek].sort((a, b) => a - b).join(",")
        : "*";
    return `${mm} ${hh} * * ${dow}`;
  }
  if (state.frequency === "monthly") {
    const dom =
      state.daysOfMonth.length > 0
        ? [...state.daysOfMonth].sort((a, b) => a - b).join(",")
        : "*";
    return `${mm} ${hh} ${dom} * *`;
  }
  // daily
  return `${mm} ${hh} * * *`;
}

/**
 * Build the `agent.md` frontmatter object for a user Agent. Optional backend
 * knobs (`tier`, `backend_id`) are omitted when left at the default so the file
 * stays minimal and the schema defaults apply. The result parses cleanly
 * through `agentDefinitionSchema`.
 */
export function agentFormToFrontmatter(state: AgentFormState): Record<string, unknown> {
  const backend: Record<string, unknown> = { process_key: USER_AGENT_PROCESS_KEY };
  if (state.tier) backend.tier = state.tier;
  if (state.backendId) backend.backend_id = state.backendId;

  const schedule: Record<string, unknown> = {
    kind: "cron",
    expression: agentFormToCron(state),
  };
  // Opt-in only — omitted when false so the file stays minimal and the
  // schema default applies (mirrors the tier / backend_id treatment).
  if (state.deferInQuietHours) schedule.defer_in_quiet_hours = true;

  return {
    slug: state.slug.trim(),
    name: state.name.trim(),
    description: state.description.trim(),
    kind: "user",
    enabled: state.enabled,
    schedule,
    backend,
    limits: {
      max_turns: state.maxTurns,
      max_budget_usd: state.maxBudgetUsd,
      timeout_minutes: state.timeoutMinutes,
    },
  };
}

/**
 * Render a complete `agent.md` document (frontmatter fence + prompt body) from
 * form state. Mirrors the daemon's `renderAgentMarkdown` dump options so the
 * cron strings / timestamps stay intact (`lineWidth: -1`) and the key order is
 * stable.
 */
export function agentFormToMarkdown(state: AgentFormState): string {
  const yamlBlock = yaml.dump(agentFormToFrontmatter(state), {
    lineWidth: -1,
    noRefs: true,
    sortKeys: false,
  });
  const body = state.prompt.trim();
  return `---\n${yamlBlock}---\n\n${body}\n`;
}

/** Weekday labels, index-aligned to cron day-of-week (0=Sun … 6=Sat). */
export const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
/** 1…31 for the month-day grid. */
export const MONTH_DAYS = Array.from({ length: 31 }, (_, i) => i + 1);
