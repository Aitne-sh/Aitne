import { isIntervalSchedule } from "./format";
import type { AgentKind, AgentListItem } from "./types";

/**
 * Pure list-view logic for the `/agents` index (§10.1): sort, filter, and the
 * "Needs attention" invalid partition. Kept out of the page component so it can
 * be unit-tested without a render harness.
 */

export type AgentSortKey =
  | "name"
  | "kind"
  | "schedule"
  | "status"
  | "last"
  | "errorRate"
  | "cost";

export type SortDirection = "asc" | "desc";

export interface AgentListFilterState {
  /** Free-text match against slug / name / description / tags. */
  search: string;
  /** "all" | "builtin" | "user". */
  kind: "all" | AgentKind;
  /** "all" | "enabled" | "disabled". */
  status: "all" | "enabled" | "disabled";
  /**
   * Cadence shape: "all" | "interval" (fires every N min/hours, e.g.
   * activity-scan) | "scheduled" (fixed daily/weekly time).
   */
  cadence: "all" | "interval" | "scheduled";
}

export const DEFAULT_FILTER_STATE: AgentListFilterState = {
  search: "",
  kind: "all",
  status: "all",
  cadence: "all",
};

/** Epoch-ms of the agent's last execution start, or -Infinity if never run. */
function lastRunMs(item: AgentListItem): number {
  const ts = item.last_execution?.started_at;
  if (!ts) return Number.NEGATIVE_INFINITY;
  const ms = Date.parse(ts);
  return Number.isFinite(ms) ? ms : Number.NEGATIVE_INFINITY;
}

/** Apply the search + kind + status filters. Does not mutate the input. */
export function filterAgents(
  items: readonly AgentListItem[],
  state: AgentListFilterState,
): AgentListItem[] {
  const needle = state.search.trim().toLowerCase();
  return items.filter((item) => {
    if (state.kind !== "all" && item.kind !== state.kind) return false;
    if (state.status === "enabled" && !item.enabled) return false;
    if (state.status === "disabled" && item.enabled) return false;
    if (state.cadence !== "all") {
      const interval = isIntervalSchedule(item.schedule);
      if (state.cadence === "interval" && !interval) return false;
      if (state.cadence === "scheduled" && interval) return false;
    }
    if (needle.length > 0) {
      const haystack = [
        item.slug,
        item.name,
        item.description,
        ...item.tags,
      ]
        .join(" ")
        .toLowerCase();
      if (!haystack.includes(needle)) return false;
    }
    return true;
  });
}

/** Comparator value for a sort key. Strings compared case-insensitively. */
function sortValue(item: AgentListItem, key: AgentSortKey): number | string {
  switch (key) {
    case "name":
      return item.name.toLowerCase();
    case "kind":
      return item.kind;
    case "schedule":
      return (item.schedule.expression ?? item.schedule.kind).toLowerCase();
    case "status":
      // Enabled sorts before disabled in ascending order.
      return item.enabled ? 0 : 1;
    case "last":
      return lastRunMs(item);
    case "errorRate":
      // Unknown (null) error rate sorts last in ascending order.
      return item.metrics_7d.error_rate ?? -1;
    case "cost":
      return item.metrics_7d.avg_cost_usd ?? -1;
  }
}

/**
 * Stable sort by `key`/`direction`. Returns a new array. `last` defaults to
 * descending (most recent first, per §10.1).
 */
export function sortAgents(
  items: readonly AgentListItem[],
  key: AgentSortKey,
  direction: SortDirection,
): AgentListItem[] {
  const factor = direction === "asc" ? 1 : -1;
  return [...items]
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      const av = sortValue(a.item, key);
      const bv = sortValue(b.item, key);
      let cmp: number;
      if (typeof av === "number" && typeof bv === "number") {
        // Sign comparison rather than `av - bv`: the latter yields NaN for two
        // equal infinities (`(-Infinity) - (-Infinity)`), which is the common
        // fresh-install case — every Agent is never-run, so `last` sort gives
        // them all -Infinity. A NaN would silently skip the `cmp === 0`
        // tiebreak below and leave ordering to the engine's NaN→+0 coercion.
        cmp = av < bv ? -1 : av > bv ? 1 : 0;
      } else {
        cmp = String(av).localeCompare(String(bv));
      }
      // Stable tiebreak on original index so equal rows keep input order.
      if (cmp === 0) return a.index - b.index;
      return cmp * factor;
    })
    .map(({ item }) => item);
}

/**
 * Split into invalid (definition failed to load, §6.6) and valid lists. The
 * invalid rows are surfaced in a dedicated "Needs attention" section above the
 * table.
 */
export function partitionByValidity(items: readonly AgentListItem[]): {
  invalid: AgentListItem[];
  valid: AgentListItem[];
} {
  const invalid: AgentListItem[] = [];
  const valid: AgentListItem[] = [];
  for (const item of items) {
    (item.invalid ? invalid : valid).push(item);
  }
  return { invalid, valid };
}
