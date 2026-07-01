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
import type { AgentExecutionDTO } from "../../db/agent-executions-store.js";
import type { AutomationTriggerDTO } from "../../db/automation-triggers.js";
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
  /**
   * Each agent's most recent completed execution, keyed by slug (from
   * `agents.last_execution_id` → `agent_executions`). Feeds `lastResult` /
   * `lastRunAt` — the data always existed on `/api/agents`; the board used to
   * hardcode these null (projection gap).
   */
  lastExecutionByAgent: ReadonlyMap<string, AgentExecutionDTO>;
  /** Slugs with an execution in flight (`result IS NULL`) → status `running`. */
  inFlightAgentSlugs: ReadonlySet<string>;
  /**
   * All automation triggers (`automation_triggers`). Each pairs 1:1 with an
   * `agent.task` recurring row that is neither dm_session, agent-claimed, nor
   * managed-task-paired — without this lane that autonomous work fired with NO
   * board representation at all.
   */
  automationTriggers: readonly AutomationTriggerDTO[];
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
}

const TITLE_MAX = 100;

/** Trim a possibly-long body down to a board title. */
function toTitle(value: string | null | undefined, fallback: string): string {
  const text = (value ?? "").trim();
  if (text.length === 0) return fallback;
  if (text.length <= TITLE_MAX) return text;
  return `${text.slice(0, TITLE_MAX).trimEnd()}…`;
}

/** Epoch-ms → ISO; null → null. The callers (background/browser `finished_at`,
 * agent-execution `ended_at`/`started_at`) all store epoch-ms `number | null`. */
function normalizeTs(value: number | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

/** The board's origin vocabulary, for narrowing a stored/context value. */
const TASK_ORIGINS: ReadonlySet<string> = new Set(["system", "user", "agent"]);

function asOrigin(value: unknown, fallback: TaskOrigin): TaskOrigin {
  return typeof value === "string" && TASK_ORIGINS.has(value)
    ? (value as TaskOrigin)
    : fallback;
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

/**
 * The canonical-owner rule, defined ONCE: a recurring row an Agent references
 * (via `recurringScheduleId`) is that Agent's cadence satellite — the Agent is
 * its canonical owner (§3 rules 2–3). Keyed by recurring-schedule id, valued
 * with the claiming Agent so callers can name the owner (route guards, error
 * hints). Any agent counts as a claimant regardless of `enabled` — a paused
 * Agent still owns its satellite. Shared by the board projection below and the
 * `/api/recurring-schedules` list-hide + write guards, so the two surfaces
 * cannot drift on what "claimed" means.
 */
export function claimedRecurringScheduleAgents(
  agents: readonly AgentDTO[],
): Map<number, AgentDTO> {
  const claimed = new Map<number, AgentDTO>();
  for (const a of agents) {
    if (a.recurringScheduleId !== null) claimed.set(a.recurringScheduleId, a);
  }
  return claimed;
}

function dmItems(sources: InventorySources): TaskBoardItem[] {
  // An agent-claimed dm_session row is surfaced through the Agent, its
  // canonical owner, never *also* as a standalone `dm` item. Without this an
  // auto-imported `imported-<id>` Agent and its backing `rs:` row double-list
  // the same schedule (identical title/cadence/next-run). Only orphan
  // dm_sessions — e.g. the briefing seed with no Agent wrapper — surface here.
  const claimedByAgent = claimedRecurringScheduleAgents(sources.agents);
  return sources.recurringDmSessions
    .filter((rs) => !claimedByAgent.has(rs.id))
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
      // The scheduler materializes occurrences from the PAIRED ROW's `enabled`
      // (`reconcileRecurringSchedules` gates on `rs.enabled = 1`), and the
      // Agent↔row mirror is one-way and best-effort — so an enabled Agent whose
      // satellite row is paused does NOT fire. Since the dedup above hides the
      // row itself everywhere, deriving status from the Agent flag alone would
      // render that drift state invisible ("active" but never firing). AND the
      // two flags so the board always tells the truth about whether it fires.
      const effectivelyEnabled = a.enabled && (paired?.enabled ?? true);
      // An in-flight execution outranks the enabled flags: a run already in
      // motion is the truth of "what is happening now", even mid-disable.
      const status = a.invalid
        ? "invalid"
        : sources.inFlightAgentSlugs.has(a.slug)
          ? "running"
          : effectivelyEnabled
            ? "active"
            : "paused";
      const last = sources.lastExecutionByAgent.get(a.slug);
      return {
        ref,
        title: toTitle(a.name, a.slug),
        kind: "agent",
        status,
        cadence: paired?.recurrenceLabel ?? a.scheduleExpression ?? null,
        fulfilledBy: ref,
        // Built-ins are system-seeded identities; user Agents are user-created.
        origin: a.source === "builtin" ? "system" : "user",
        lastResult: last ? (last.outputSummary ?? last.result) : null,
        lastRunAt: last ? normalizeTs(last.endedAt ?? last.startedAt) : null,
        nextRunAt: paired?.nextRunAt ?? null,
      };
    })
    .sort(byRef);
}

function triggerItems(sources: InventorySources): TaskBoardItem[] {
  return sources.automationTriggers
    .map((t): TaskBoardItem => {
      const ref = formatTaskRef("trigger", t.id);
      const paired =
        t.recurringScheduleId !== null
          ? sources.recurringById.get(t.recurringScheduleId)
          : undefined;
      return {
        ref,
        title: toTitle(t.prompt, `${t.domain} automation`),
        kind: "trigger",
        status: t.enabled ? "active" : "paused",
        cadence: paired?.recurrenceLabel ?? null,
        // Like app_fetch, the paired recurring row is what actually fires.
        fulfilledBy:
          t.recurringScheduleId !== null ? formatTaskRef("rs", t.recurringScheduleId) : ref,
        // Only `POST /api/triggers` (Approve tier, dashboard-driven) creates one.
        origin: "user",
        lastResult: t.lastRunResult,
        lastRunAt: t.lastRunStartedAt,
        nextRunAt: t.nextRunAt,
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
      // A deferred background/browser task carries an explicit `origin` in its
      // schedule context (threaded from the POST body) — honour it. Otherwise a
      // sub_flow marks the one-off as agent-self-scheduled (e.g. a `confirm`
      // follow-up); a bare reminder the user asked for has neither.
      const origin = asOrigin(
        o.taskContext.origin,
        subFlowOf(o.taskContext) ? "agent" : "user",
      );
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
        // Recorded at creation (user request vs autonomous spawn) — no longer
        // assumed: the board used to hardcode "agent" for every worker.
        origin: asOrigin(bt.origin, "agent"),
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
        origin: asOrigin(bx.origin, "agent"),
        lastResult: bx.outcomeDetail,
        lastRunAt: normalizeTs(bx.finishedAt),
        nextRunAt: null,
      };
    })
    .sort(byRef);
}

/**
 * Assemble the unified board. Items are grouped by kind in a fixed order
 * (dm → agent → app_fetch → trigger → reminder → background → browser) and
 * sorted deterministically within each group, so the output is stable for
 * tests and for a stable dashboard render.
 *
 * Browser-history research clusters are intentionally NOT surfaced here: they
 * are a derived browsing-analytics artifact (not a unit of work in motion),
 * have no board-managed owner (dispatch marks `cluster:` non-editable), and are
 * unbounded in count — they flooded the board with noise. They live on the
 * browser-history surface (`/api/browser-history/research-clusters`, `/browser`)
 * instead. The `cluster:` ref grammar stays valid for `/tasks/impact`.
 */
export function assembleInventory(sources: InventorySources): TaskBoardItem[] {
  return [
    ...dmItems(sources),
    ...agentItems(sources),
    ...appFetchItems(sources),
    ...triggerItems(sources),
    ...reminderItems(sources),
    ...backgroundItems(sources),
    ...browserItems(sources),
  ];
}
