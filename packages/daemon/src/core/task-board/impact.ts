/**
 * Unified Task Board — L0 blast-radius preview (§5.2b, §7).
 *
 * Pure: walks the cross-references that already exist (§2.4) and returns the set
 * of rows a delete/modify of `ref` would touch, each labelled with its **real**
 * cascade semantics (§2.3): the managed_tasks 1:1 IS-A CASCADE wrapper vs the
 * SET-NULL reference satellites (`agents`, `automation_triggers`) that *survive*
 * vs the NO-ACTION fire-queue back-pointers that are unlinked. It *previews* —
 * it never mutates. Covered 100%.
 *
 * `is_a_cascade` is reserved for the genuine managed_tasks↔schedule 1:1 (the row
 * dies WITH its schedule). An Agent's own paired schedule, seen from an `agent:`
 * target, is the inverse direction and gets its own `owner_paired_schedule` kind
 * (§2.3) so the preview never teaches that an Agent's schedule is an IS-A wrapper.
 */

import type { RecurringScheduleDTO } from "../../db/recurring-schedules.js";
import type { AgentDTO } from "../../db/agents-store.js";
import type { ManagedTask } from "@aitne/shared";
import type { AutomationTriggerDTO } from "../../db/automation-triggers.js";
import type {
  ImpactCascade,
  ImpactNode,
  ImpactResult,
  TaskRef,
  TaskRefPrefix,
} from "./types.js";
import { formatTaskRef } from "./refs.js";

/** A pending/materialised occurrence and the recurring parent it links to. */
export interface OccurrenceLink {
  id: number;
  recurringScheduleId: number | null;
}

export interface ImpactSources {
  /** Recurring rows by id (target resolution + satellite back-resolution). */
  recurringById: ReadonlyMap<number, RecurringScheduleDTO>;
  /** All managed tasks (by id, and by schedule_id for rs targets). */
  managedTasks: readonly ManagedTask[];
  /** All agents (by slug, and by recurring_schedule_id for rs targets). */
  agents: readonly AgentDTO[];
  /** All automation triggers (by recurring_schedule_id). */
  automationTriggers: readonly AutomationTriggerDTO[];
  /** Pending one-offs + materialised occurrences (for unlink counting + as: targets). */
  pendingOccurrences: readonly OccurrenceLink[];
  /** Non-terminal background_task ids (existence for bt: refs). */
  backgroundTaskIds: ReadonlySet<string>;
  /** Non-terminal browser_task ids (existence for bx: refs). */
  browserTaskIds: ReadonlySet<string>;
  /** Active/dormant research-cluster slugs (existence for cluster: refs). */
  researchClusterSlugs: ReadonlySet<string>;
}

/**
 * The {@link ImpactSources} fields each ref prefix's {@link computeImpact} branch
 * actually reads. The route (`api/routes/tasks.ts`) consults this to fetch ONLY
 * what a given ref needs: a `bt:`/`bx:`/`cluster:` existence check must not scan
 * every recurring / agent / managed / trigger table, and an `rs:`/`agent:`/`mt:`
 * query must not load the fulfiller id-sets. Kept here beside `computeImpact` so
 * the two cannot drift, and proven a correct **superset** of what each branch
 * reads by the "reads only declared sources" guard in `impact.test.ts` — a Proxy
 * that throws if `computeImpact` touches a field absent from its prefix's set.
 * `obj` is reserved (§5.5) and reads nothing.
 */
export const IMPACT_SOURCE_KEYS: Record<TaskRefPrefix, readonly (keyof ImpactSources)[]> = {
  rs: ["recurringById", "managedTasks", "agents", "automationTriggers", "pendingOccurrences"],
  mt: ["managedTasks", "agents", "automationTriggers", "pendingOccurrences"],
  agent: ["agents"],
  as: ["pendingOccurrences"],
  bt: ["backgroundTaskIds"],
  bx: ["browserTaskIds"],
  cluster: ["researchClusterSlugs"],
  obj: [],
};

function node(
  ref: string,
  label: string,
  cascade: ImpactCascade,
  removed: boolean,
): ImpactNode {
  return { ref, label, cascade, removed };
}

/**
 * Nodes for the satellites of a recurring row `rsId` — the rows that *point at*
 * it: managed_tasks (IS-A, removed), agents + triggers (SET-NULL, survive),
 * pending occurrences (NO-ACTION, unlinked). `includeManaged=false` when the
 * managed task is itself the target (already added as `self`).
 */
function recurringSatelliteNodes(
  rsId: number,
  sources: ImpactSources,
  includeManaged: boolean,
): ImpactNode[] {
  const nodes: ImpactNode[] = [];

  if (includeManaged) {
    for (const mt of sources.managedTasks) {
      if (mt.schedule_id === rsId) {
        nodes.push(
          node(
            mt.id,
            `managed task ${mt.id} — a 1:1 wrapper that is deleted with this schedule (IS-A CASCADE)`,
            "is_a_cascade",
            true,
          ),
        );
      }
    }
  }

  for (const a of sources.agents) {
    if (a.recurringScheduleId === rsId) {
      nodes.push(
        node(
          formatTaskRef("agent", a.slug),
          `Agent "${a.slug}" references this schedule and survives its deletion (FK SET NULL)`,
          "set_null_satellite",
          false,
        ),
      );
    }
  }

  // NOTE (audit C6): the satellite node ids below (`trigger:<id>`,
  // `rs:<id>#pending`) are human-readable DISPLAY labels, not parseable typed
  // refs like `formatTaskRef(...)` above — a future clickable-impact UI must
  // treat these as text, not feed them to `parseTaskRef` (they would 400).
  for (const t of sources.automationTriggers) {
    if (t.recurringScheduleId === rsId) {
      nodes.push(
        node(
          `trigger:${t.id}`,
          `Automation trigger #${t.id} references this schedule and survives its deletion (FK SET NULL)`,
          "set_null_satellite",
          false,
        ),
      );
    }
  }

  const pending = sources.pendingOccurrences.filter(
    (o) => o.recurringScheduleId === rsId,
  ).length;
  if (pending > 0) {
    nodes.push(
      node(
        `rs:${rsId}#pending`,
        `${pending} pending fire(s) are unlinked/skipped, not deleted (NO ACTION back-pointer)`,
        "no_action_unlinked",
        false,
      ),
    );
  }

  return nodes;
}

function countRemoved(nodes: readonly ImpactNode[]): number {
  return nodes.filter((n) => n.removed).length;
}

function summarise(targetRef: string, nodes: readonly ImpactNode[]): string {
  const removed = countRemoved(nodes);
  const surviving = nodes.length - removed;
  return (
    `Deleting ${targetRef} removes ${removed} row(s)` +
    (surviving > 0 ? ` and touches ${surviving} that survive/unlink.` : ".")
  );
}

/** Read-only fulfiller (background/browser/research) — never deletable here. */
function readonlyFulfiller(
  ref: TaskRef,
  exists: boolean,
  noun: string,
): ImpactResult {
  if (!exists) {
    return { ref: ref.raw, found: false, summary: `${ref.raw} is not a live ${noun}.`, nodes: [] };
  }
  return {
    ref: ref.raw,
    found: true,
    summary: `${ref.raw} is an in-flight ${noun}; it is read-only from the board and has no delete cascade.`,
    nodes: [node(ref.raw, `in-flight ${noun} (read-only)`, "self", false)],
  };
}

/**
 * Compute the blast radius for a typed ref. Returns `found:false` (not an error)
 * for a well-formed ref that resolves to no live row, so the agent can reason
 * about "nothing to delete" without exception handling. Callers should reject a
 * *malformed* ref (parse failure) with 400 before calling this.
 */
export function computeImpact(ref: TaskRef, sources: ImpactSources): ImpactResult {
  switch (ref.prefix) {
    case "rs": {
      const rsId = Number(ref.id);
      const rs = sources.recurringById.get(rsId);
      if (!rs) {
        return { ref: ref.raw, found: false, summary: `${ref.raw} is not a live recurring schedule.`, nodes: [] };
      }
      const nodes: ImpactNode[] = [
        node(ref.raw, `recurring schedule (${rs.taskType}) — the target row`, "self", true),
        ...recurringSatelliteNodes(rsId, sources, true),
      ];
      return { ref: ref.raw, found: true, summary: summarise(ref.raw, nodes), nodes };
    }

    case "mt": {
      const mt = sources.managedTasks.find((m) => m.id === ref.id);
      if (!mt) {
        return { ref: ref.raw, found: false, summary: `${ref.raw} is not a live managed task.`, nodes: [] };
      }
      const rsRef = formatTaskRef("rs", mt.schedule_id);
      const nodes: ImpactNode[] = [
        node(ref.raw, `managed task — the target row`, "self", true),
        node(
          rsRef,
          `the managed task's recurring schedule — deleted in the same transaction (1:1 CASCADE)`,
          "is_a_cascade",
          true,
        ),
        // The recurring row's own satellites (excluding the managed task itself).
        ...recurringSatelliteNodes(mt.schedule_id, sources, false),
      ];
      return { ref: ref.raw, found: true, summary: summarise(ref.raw, nodes), nodes };
    }

    case "agent": {
      const a = sources.agents.find((x) => x.slug === ref.id);
      if (!a) {
        return { ref: ref.raw, found: false, summary: `${ref.raw} is not a live Agent.`, nodes: [] };
      }
      // A built-in Agent is unconditionally undeletable (§9.8) — the preview
      // must say "stop, never delete", not imply a keep_history:false hard-delete.
      const isBuiltin = a.source === "builtin";
      const nodes: ImpactNode[] = [
        node(
          ref.raw,
          isBuiltin
            ? `the built-in Agent — cannot be deleted (409); only stopped/disabled with the stop-warning ack`
            : `the Agent — disabled by default; deleted only when keep_history:false`,
          "self",
          false,
        ),
      ];
      if (a.recurringScheduleId !== null) {
        nodes.push(
          node(
            formatTaskRef("rs", a.recurringScheduleId),
            isBuiltin
              ? `the Agent's own recurring schedule — disabled when the Agent is stopped (a built-in is never deleted)`
              : `the Agent's own recurring schedule — disabled with the Agent, removed only on hard-delete (not an IS-A wrapper)`,
            "owner_paired_schedule",
            false,
          ),
        );
      }
      return {
        ref: ref.raw,
        found: true,
        summary: isBuiltin
          ? `${ref.raw} is a built-in Agent — it cannot be deleted (409); stopping it needs the stop-warning ack, and its own schedule disables with it.`
          : `Editing/disabling ${ref.raw} affects the Agent and its recurring schedule; ` +
            `history is retained unless keep_history:false.`,
        nodes,
      };
    }

    case "as": {
      const asId = Number(ref.id);
      const occ = sources.pendingOccurrences.find((o) => o.id === asId);
      if (!occ) {
        return { ref: ref.raw, found: false, summary: `${ref.raw} is not a live pending reminder.`, nodes: [] };
      }
      // A pending agent_schedule row is either a genuine one-off OR one
      // materialized fire of a recurring schedule. The board inventory only
      // lists UNLINKED one-offs, so label a linked occurrence honestly (audit
      // B4): cancelling it drops just this fire — the parent rs regenerates
      // its next occurrence.
      const parentRs = occ.recurringScheduleId;
      if (parentRs !== null) {
        return {
          ref: ref.raw,
          found: true,
          summary: `Cancelling ${ref.raw} removes ONE materialized fire of rs:${parentRs}; the recurring schedule regenerates its next occurrence (no cascade).`,
          nodes: [
            node(ref.raw, `one materialized fire of rs:${parentRs} — the target row`, "self", true),
          ],
        };
      }
      return {
        ref: ref.raw,
        found: true,
        summary: `Cancelling ${ref.raw} removes one pending reminder; no cascade.`,
        nodes: [node(ref.raw, `pending one-off reminder — the target row`, "self", true)],
      };
    }

    case "bt":
      return readonlyFulfiller(ref, sources.backgroundTaskIds.has(ref.id), "background task");
    case "bx":
      return readonlyFulfiller(ref, sources.browserTaskIds.has(ref.id), "browser task");
    case "cluster":
      return readonlyFulfiller(ref, sources.researchClusterSlugs.has(ref.id), "research cluster");

    case "obj":
      return {
        ref: ref.raw,
        found: false,
        summary: `${ref.raw} — objective_task is reserved (§5.5) and not yet available on the board.`,
        nodes: [],
      };
  }
}
