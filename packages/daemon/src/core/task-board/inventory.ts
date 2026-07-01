/**
 * Unified Task Board — L0 inventory projection (§5.2a).
 *
 * Pure: given the already-fetched owner rows, assemble the unified board view.
 * No DB, no I/O — the route handler (`api/routes/tasks.ts`) does the reads and
 * passes the rows in; this function only projects + orders them. Covered 100%.
 *
 * Reference-don't-duplicate (§3 rule 4): every human field here is *computed*
 * from the owning row at read time; nothing is stored.
 */

import type { RecurringScheduleDTO } from "../../db/recurring-schedules.js";
import type { AgentDTO } from "../../db/agents-store.js";
import type { ManagedTask } from "@aitne/shared";
import type { BackgroundTaskRow } from "../../db/background-task-store.js";
import type { BrowserTaskRow } from "../../db/browser-task-store.js";
import type { TaskBoardItem, TaskOrigin } from "./types.js";
import { formatTaskRef } from "./refs.js";

/** Minimal shape of a pending one-off `agent_schedule` row the board surfaces. */
export interface PendingOneOff {
  id: number;
  scheduledFor: string;
  taskType: string;
  taskDescription: string | null;
  taskPrompt: string | null;
  taskContext: Record<string, unknown>;
}

/** Structural subset of a research cluster the board reads (active/dormant). */
export interface ResearchClusterSummary {
  slug: string;
  displayName: string;
  status: string;
  lastActivityAt: string | number | null;
}

/** Everything the projection needs, pre-fetched by the route. */
export interface InventorySources {
  /** `recurring_schedules WHERE task_type='dm_session'`. */
  recurringDmSessions: readonly RecurringScheduleDTO[];
  /**
   * All agents (built-in + user). Built-ins surface read-only with origin
   * `system`; `origin` is derived per-row from `source`. Symmetric with the
   * impact resolver, which already walks every agent.
   */
  agents: readonly AgentDTO[];
  /** `managed_tasks` (+ their recurring rows resolved via `recurringById`). */
  managedTasks: readonly ManagedTask[];
  /** Recurring rows keyed by id — resolves mt + agent cadence/next-run. */
  recurringById: ReadonlyMap<number, RecurringScheduleDTO>;
  /** `agent_schedule WHERE status='pending' AND recurring_schedule_id IS NULL`. */
  pendingOneOffs: readonly PendingOneOff[];
  /** Non-terminal `background_task` rows. */
  backgroundTasks: readonly BackgroundTaskRow[];
  /** Non-terminal `browser_task` rows. */
  browserTasks: readonly BrowserTaskRow[];
  /** Active/dormant `browser_research_clusters`. */
  researchClusters: readonly ResearchClusterSummary[];
}

const TITLE_MAX = 100;

/** Trim a possibly-long body down to a board title. */
function toTitle(value: string | null | undefined, fallback: string): string {
  const text = (value ?? "").trim();
  if (text.length === 0) return fallback;
  if (text.length <= TITLE_MAX) return text;
  return `${text.slice(0, TITLE_MAX).trimEnd()}…`;
}

/** Epoch-ms → ISO; string passed through; null/undefined → null. */
function normalizeTs(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return new Date(value).toISOString();
  return value;
}

/**
 * Sub-flows the daemon seeds itself — used to tag origin `system`. Intentionally
 * a small explicit allowlist (audit C9): only `morning_briefing` is daemon-seeded
 * today, and origin is a display hint, not a security boundary — add new seeded
 * sub-flows here as they appear rather than inferring from a broader heuristic.
 */
const SYSTEM_SUB_FLOWS: ReadonlySet<string> = new Set(["morning_briefing"]);

function subFlowOf(ctx: Record<string, unknown>): string | null {
  return typeof ctx.sub_flow === "string" ? ctx.sub_flow : null;
}

/** Numeric-aware, stable ordering within a kind group. */
function byRef(a: TaskBoardItem, b: TaskBoardItem): number {
  return a.ref.localeCompare(b.ref, "en", { numeric: true });
}

function dmItems(sources: InventorySources): TaskBoardItem[] {
  return sources.recurringDmSessions
    .map((rs): TaskBoardItem => {
      const ref = formatTaskRef("rs", rs.id);
      const origin: TaskOrigin = SYSTEM_SUB_FLOWS.has(subFlowOf(rs.taskContext) ?? "")
        ? "system"
        : "user";
      return {
        ref,
        title: toTitle(rs.description, "Scheduled DM"),
        kind: "dm",
        status: rs.enabled ? "active" : "paused",
        cadence: rs.recurrenceLabel,
        fulfilledBy: ref,
        origin,
        lastResult: null,
        lastRunAt: null,
        nextRunAt: rs.nextRunAt,
      };
    })
    .sort(byRef);
}

function agentItems(sources: InventorySources): TaskBoardItem[] {
  return sources.agents
    .map((a): TaskBoardItem => {
      const ref = formatTaskRef("agent", a.slug);
      const paired =
        a.recurringScheduleId !== null
          ? sources.recurringById.get(a.recurringScheduleId)
          : undefined;
      const status = a.invalid ? "invalid" : a.enabled ? "active" : "paused";
      return {
        ref,
        title: toTitle(a.name, a.slug),
        kind: "agent",
        status,
        cadence: paired?.recurrenceLabel ?? a.scheduleExpression ?? null,
        fulfilledBy: ref,
        // Built-ins are system-seeded identities; user Agents are user-created.
        origin: a.source === "builtin" ? "system" : "user",
        lastResult: null,
        lastRunAt: null,
        nextRunAt: paired?.nextRunAt ?? null,
      };
    })
    .sort(byRef);
}

function appFetchItems(sources: InventorySources): TaskBoardItem[] {
  return sources.managedTasks
    .map((mt): TaskBoardItem => {
      const paired = sources.recurringById.get(mt.schedule_id);
      return {
        ref: mt.id,
        title: toTitle(mt.intent, mt.app),
        kind: "app_fetch",
        status: paired ? (paired.enabled ? "active" : "paused") : "active",
        cadence: mt.cadence,
        fulfilledBy: formatTaskRef("rs", mt.schedule_id),
        origin: "user",
        lastResult: mt.last_result,
        lastRunAt: mt.last_run_at,
        nextRunAt: paired?.nextRunAt ?? null,
      };
    })
    .sort(byRef);
}

function reminderItems(sources: InventorySources): TaskBoardItem[] {
  return sources.pendingOneOffs
    .map((o): TaskBoardItem => {
      const ref = formatTaskRef("as", o.id);
      // A sub_flow on a one-off marks it as agent-self-scheduled (e.g. a
      // `confirm` follow-up); a bare reminder the user asked for has none.
      const origin: TaskOrigin = subFlowOf(o.taskContext) ? "agent" : "user";
      return {
        ref,
        title: toTitle(o.taskDescription ?? o.taskPrompt, "Reminder"),
        kind: "reminder",
        status: "pending",
        cadence: "one-off",
        fulfilledBy: ref,
        origin,
        lastResult: null,
        lastRunAt: null,
        nextRunAt: o.scheduledFor,
      };
    })
    .sort(byRef);
}

function backgroundItems(sources: InventorySources): TaskBoardItem[] {
  return sources.backgroundTasks
    .map((bt): TaskBoardItem => {
      const ref = formatTaskRef("bt", bt.id);
      return {
        ref,
        title: toTitle(bt.title ?? bt.brief, "Background task"),
        kind: "background",
        status: bt.state,
        cadence: null,
        fulfilledBy: ref,
        origin: "agent",
        lastResult: bt.outcomeDetail,
        lastRunAt: normalizeTs(bt.finishedAt),
        nextRunAt: null,
      };
    })
    .sort(byRef);
}

function browserItems(sources: InventorySources): TaskBoardItem[] {
  return sources.browserTasks
    .map((bx): TaskBoardItem => {
      const ref = formatTaskRef("bx", bx.id);
      return {
        ref,
        title: toTitle(bx.description, "Browser task"),
        kind: "browser",
        status: bx.state,
        cadence: null,
        fulfilledBy: ref,
        origin: "agent",
        lastResult: bx.outcomeDetail,
        lastRunAt: normalizeTs(bx.finishedAt),
        nextRunAt: null,
      };
    })
    .sort(byRef);
}

function researchItems(sources: InventorySources): TaskBoardItem[] {
  return sources.researchClusters
    .map((c): TaskBoardItem => {
      const ref = formatTaskRef("cluster", c.slug);
      return {
        ref,
        title: toTitle(c.displayName, c.slug),
        kind: "research",
        status: c.status,
        cadence: "nightly",
        fulfilledBy: ref,
        origin: "agent",
        lastResult: null,
        lastRunAt: normalizeTs(c.lastActivityAt),
        nextRunAt: null,
      };
    })
    .sort(byRef);
}

/**
 * Assemble the unified board. Items are grouped by kind in a fixed order
 * (dm → agent → app_fetch → reminder → background → browser → research) and
 * sorted deterministically within each group, so the output is stable for
 * tests and for a stable dashboard render.
 */
export function assembleInventory(sources: InventorySources): TaskBoardItem[] {
  return [
    ...dmItems(sources),
    ...agentItems(sources),
    ...appFetchItems(sources),
    ...reminderItems(sources),
    ...backgroundItems(sources),
    ...browserItems(sources),
    ...researchItems(sources),
  ];
}
