/**
 * Unified Task Board — shared types (docs/design/appendices/unified-task-board.md).
 *
 * A **Task** is a *tracked work item* — it references the existing owner rows,
 * it never absorbs them (§3). These types describe the **computed projection**
 * (L0) and the **typed-ref grammar** (L0/L1); there is no Task table. All of the
 * runtime logic that produces these shapes lives in the sibling pure modules
 * (`refs.ts`, `inventory.ts`, `impact.ts`, `dispatch.ts`) and is covered 100%;
 * this file is type-only (no runtime code) and is excluded from the gate.
 */

/**
 * Board "kind" — aligned 1:1 with the L1 facade `kind` vocabulary so the read
 * projection (L0) and the write facade (L1) speak the same words. `dm`,
 * `app_fetch`, `agent`, `reminder`, `background` are facade-writable; `browser`
 * is a read-only fulfiller surfaced for visibility (§12 OQ#1). (Browser-history
 * research clusters were dropped from the board — see `assembleInventory` — so
 * `research` is no longer a board kind, though `cluster:` stays a valid ref
 * prefix for `/tasks/impact`.) `trigger` is an automation-trigger rule
 * (`automation_triggers`) — recurring autonomous work that previously fired with
 * no board representation; it is create-owned by `/api/triggers` (Approve tier,
 * dashboard-driven), so it is edit/delete-able by ref but has no facade create
 * kind.
 */
export type TaskKind =
  | "dm"
  | "app_fetch"
  | "agent"
  | "trigger"
  | "reminder"
  | "background"
  | "browser";

/** Who set the task in motion. Heuristic, best-effort, English-only (§9.30). */
export type TaskOrigin = "system" | "user" | "agent";

/**
 * Typed-ref prefixes (§12 OQ#2). `mt` is the managed-task alias whose canonical
 * id is the literal `mt_<n>`; `obj` is RESERVED for `objective_task` (§5.5) —
 * the board recognises it in the grammar but does not yet resolve it. `bx`
 * extends the grammar for in-flight browser tasks (the design's prefix list
 * predates surfacing browser_task; see refs.ts). `trigger` promotes the
 * blast-radius preview's former display-only `trigger:<id>` satellite label
 * (audit C6) into a real parseable ref backed by `automation_triggers`.
 */
export type TaskRefPrefix =
  | "rs"
  | "mt"
  | "agent"
  | "as"
  | "cluster"
  | "bt"
  | "bx"
  | "trigger"
  | "obj";

/**
 * A parsed typed reference. `id` is the **route-path segment** for the owning
 * resource: `"42"` for `rs:42`, the full `"mt_3"` for a managed task, a slug for
 * `agent:<slug>` / `cluster:<slug>`, a uuid for `bt:`/`bx:`. `raw` is the
 * canonical string form (what `formatTaskRef` would emit).
 */
export interface TaskRef {
  prefix: TaskRefPrefix;
  /** Route-path segment for the owning resource (see above). */
  id: string;
  /** Canonical string form, e.g. "rs:42" or "mt_3". */
  raw: string;
}

/**
 * One row of the read-only board. Computed on demand from the owning rows; the
 * board persists no copy of any of this (§5.2). `fulfilledBy` is the typed ref
 * of the row that actually *executes* the work (for an app-fetch, that is its
 * recurring schedule; for everything else it is the item's own ref).
 */
export interface TaskBoardItem {
  /** Typed ref identifying the tracked item (the owner's handle). */
  ref: string;
  /** Human title — a free-prose value; may be the user's primary language. */
  title: string;
  kind: TaskKind;
  /** Lifecycle word: active | paused | pending | running | … (fulfiller state). */
  status: string;
  /** Human cadence label (English), or null for one-shot / unscheduled work. */
  cadence: string | null;
  /** Typed ref of the executing row. */
  fulfilledBy: string;
  origin: TaskOrigin;
  /** Last execution result snippet, when the owner tracks one. */
  lastResult: string | null;
  /** Last run timestamp (as stored / ISO), when known. */
  lastRunAt: string | null;
  /** Next scheduled fire (as stored / ISO), when known. */
  nextRunAt: string | null;
}

/**
 * How a referenced row relates to the target under a delete/modify, labelled by
 * its **real** cascade semantics (§2.3, §7). The board only *previews* these.
 */
export type ImpactCascade =
  /** The target itself. */
  | "self"
  /** 1:1 NOT NULL CASCADE wrapper — dies with the schedule (managed_tasks). */
  | "is_a_cascade"
  /** Nullable SET NULL reference satellite — survives the delete (agents, triggers). */
  | "set_null_satellite"
  /** NO ACTION fire-queue back-pointer — code NULLs it before delete (pending occurrences). */
  | "no_action_unlinked"
  /**
   * The Agent's OWN paired recurring schedule, seen from an `agent:` target.
   * Structurally the Agent is a SET-NULL satellite OF the schedule (§2.3), but
   * when the *Agent* is the delete target the direction inverts: a disable
   * leaves the schedule (mirror-disabled), a hard-delete removes it via the
   * agent-delete code path (§9.11). It is neither an IS-A CASCADE wrapper nor a
   * surviving satellite, so it gets its own honest kind rather than overloading
   * `is_a_cascade`.
   */
  | "owner_paired_schedule";

/** One node in a blast-radius preview. */
export interface ImpactNode {
  /** Typed ref of the affected row. */
  ref: string;
  /** English, human-readable description of what happens to this row. */
  label: string;
  cascade: ImpactCascade;
  /** True when the row is removed by the cascade; false when it survives/unlinks. */
  removed: boolean;
}

/** The result of a blast-radius query for one ref. */
export interface ImpactResult {
  /** The (canonical) ref the impact was computed for. */
  ref: string;
  /** False when the ref does not resolve to a live row. */
  found: boolean;
  /** English one-line summary of the blast radius. */
  summary: string;
  /** Every row a delete/modify of `ref` would touch, target included. */
  nodes: ImpactNode[];
}
