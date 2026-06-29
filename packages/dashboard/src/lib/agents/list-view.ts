import { isIntervalSchedule } from "./format";
import type { AgentKind, AgentListItem } from "./types";

/**
 * Pure list-view logic for the `/agents` index (§10.1): sort, filter, and the
 * "Needs attention" invalid partition. Kept out of the page component so it can
 * be unit-tested without a render harness.
 */

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
