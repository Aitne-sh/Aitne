/**
 * Unified Task Board — L1 facade dispatch planner (§5.3).
 *
 * Pure routing decisions: `kind` → create endpoint, and ref-prefix → edit/delete
 * endpoint. This is where the §9 hard constraints live as code (not prose):
 *
 *  - **No agent_id leak / no 410 misuse (§9.17, §9.32):** `kind:'dm'` can only
 *    create a `dm_session` row — the planner pins `taskType: "dm_session"` so it
 *    can never reach the 410'd `agent.task` door, and `kind:'agent'` routes to
 *    `/api/agents`, never to a `recurring_schedules` insert with an agent stamp.
 *  - **Fulfiller read-only (§9.24, §9.25, §12 OQ#1):** background / browser /
 *    research / objective refs are not editable or deletable through the board.
 *
 * The facade never re-implements an owner's dedup/cascade/validation — it strips
 * `kind` and forwards the rest of the body to the real endpoint (the glue in
 * `api/routes/tasks.ts` does the actual re-dispatch). Covered 100%.
 */

import type { TaskRef, TaskRefPrefix } from "./types.js";
import { ownerRouteForRef } from "./refs.js";

/** The five facade create kinds (§5.3 table). */
export const FACADE_CREATE_KINDS = [
  "reminder",
  "dm",
  "agent",
  "app_fetch",
  "background",
] as const;
export type FacadeCreateKind = (typeof FACADE_CREATE_KINDS)[number];

/** kind → owning create endpoint. */
const CREATE_ROUTE: Record<FacadeCreateKind, string> = {
  // A timed nudge to the user → the one-off DM reminder endpoint.
  reminder: "/api/schedule/dm",
  // Recurring scheduled DM — the ONLY task_type /api/recurring-schedules accepts.
  dm: "/api/recurring-schedules",
  // Recurring autonomous work → the Agent layer (never a stamped recurring row).
  agent: "/api/agents",
  // Recurring app-fetch → managed tasks (L2's create door, unchanged under L1).
  app_fetch: "/api/managed-tasks",
  // One long detached run.
  background: "/api/background-task",
};

export interface CreateDispatchPlan {
  ownerPath: string;
  /** Body to forward (caller's body minus `kind`, plus any §9 guard pins). */
  body: Record<string, unknown>;
}

/**
 * Plan a create dispatch. Strips the facade-only `kind` field and applies the
 * §9 guards before the body reaches an owner endpoint.
 */
export function planCreateDispatch(
  kind: FacadeCreateKind,
  rawBody: Record<string, unknown>,
): CreateDispatchPlan {
  const body: Record<string, unknown> = { ...rawBody };
  delete body.kind;
  if (kind === "dm") {
    // §9.17 / §9.32 guard: pin dm_session so a `dm` create can never become an
    // agent.task (410) nor an agent_id-stamped recurring row.
    body.taskType = "dm_session";
  }
  return { ownerPath: CREATE_ROUTE[kind], body };
}

export type RefDispatchPlan =
  | { editable: true; ownerPath: string }
  | { editable: false; reason: string };

/**
 * Per-prefix edit/delete policy. Writable owners (`rs`, `mt`, `agent`, `as`)
 * forward to their per-row route — where the owner's OWN auth tier and FK
 * cascade still apply. Fulfillers and reserved refs are read-only from the
 * board (§9.24, §9.25, §12 OQ#1). Total over every prefix, so there is no
 * defensive fallback to leave uncovered.
 */
type RefPolicy = { writable: true } | { writable: false; reason: string };
const REF_POLICY: Record<TaskRefPrefix, RefPolicy> = {
  rs: { writable: true },
  mt: { writable: true },
  agent: { writable: true },
  as: { writable: true },
  // Owner routes exist (PATCH/DELETE /api/triggers/:id) and carry their own
  // Approve tier — the facade forwards, the owner still demands the bearer.
  // Creation stays on the owner (no facade create kind): triggers are
  // dashboard-driven Approve-tier config, not agent-authored work.
  trigger: { writable: true },
  bt: {
    writable: false,
    reason: "Background tasks are read-only from the board; manage them on the background-task surface.",
  },
  bx: {
    writable: false,
    reason: "Browser tasks are read-only from the board; never resume a force-failed run or surface a pending token.",
  },
  cluster: {
    writable: false,
    reason: "Research clusters are managed via their own status controls (mute/conclude), not the board.",
  },
  obj: { writable: false, reason: "objective_task is reserved (§5.5) and not yet available on the board." },
};

/** Plan an edit/delete dispatch for a typed ref. */
export function planRefDispatch(ref: TaskRef): RefDispatchPlan {
  const policy = REF_POLICY[ref.prefix];
  if (policy.writable) {
    // A writable prefix always resolves to an owner route (refs.ts OWNER_BASE_PATH).
    return { editable: true, ownerPath: ownerRouteForRef(ref) as string };
  }
  return { editable: false, reason: policy.reason };
}
