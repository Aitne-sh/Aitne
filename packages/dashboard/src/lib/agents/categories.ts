import type { AgentCategory, AgentListItem } from "./types";

/**
 * Category grouping for the `/agents` hub (AGENTS_HUB_REDESIGN_PLAN §4.1).
 * Pure module — unit-tested without a render harness (dashboard testing
 * convention: pure .test.ts, node env).
 */

export const CATEGORY_ORDER: readonly AgentCategory[] = [
  "synthesis",
  "monitoring",
  "maintenance",
  "user",
];

export interface CategoryMeta {
  label: string;
  description: string;
}

export const CATEGORY_META: Record<AgentCategory, CategoryMeta> = {
  synthesis: {
    label: "Synthesis & reviews",
    description:
      "The daily / weekly / monthly routines that write today.md, your journals, and the reviews.",
  },
  monitoring: {
    label: "Monitoring",
    description:
      "Interval watchers that triage pending observations and proactively surface new activity.",
  },
  maintenance: {
    label: "Maintenance",
    description:
      "Background upkeep passes that keep the vault index, roadmap, profile, and skills healthy.",
  },
  user: {
    label: "Your agents",
    description: "Agents you created — each runs its own prompt on its own schedule.",
  },
};

/**
 * Curated display order for the built-ins inside their category section —
 * the synthesis routines read naturally in day order (morning → evening →
 * weekly → monthly), not alphabetically. Unlisted slugs (user Agents, future
 * built-ins) sort after the curated ones, by name.
 */
const BUILTIN_DISPLAY_RANK: Record<string, number> = {
  "morning-routine": 0,
  "evening-review": 1,
  "weekly-review": 2,
  "monthly-review": 3,
  "activity-scan": 0,
  "user-profile-sweep-morning": 0,
  "user-profile-sweep-evening": 1,
  "roadmap-maintenance": 2,
  "context-index-reconcile": 3,
  "skill-curation": 4,
};

export interface AgentCategoryGroup {
  category: AgentCategory;
  meta: CategoryMeta;
  items: AgentListItem[];
}

/**
 * Partition list items into the fixed category sections, dropping empty
 * sections. Items missing a category (older daemon during a rolling upgrade)
 * fall back to `"user"` for user Agents and `"maintenance"` for built-ins —
 * mirroring the daemon's own fallback.
 */
export function groupByCategory(items: readonly AgentListItem[]): AgentCategoryGroup[] {
  const buckets = new Map<AgentCategory, AgentListItem[]>(
    CATEGORY_ORDER.map((category) => [category, []]),
  );
  for (const item of items) {
    const category: AgentCategory =
      item.category && CATEGORY_ORDER.includes(item.category)
        ? item.category
        : item.kind === "user"
          ? "user"
          : "maintenance";
    buckets.get(category)!.push(item);
  }
  const groups: AgentCategoryGroup[] = [];
  for (const category of CATEGORY_ORDER) {
    const bucket = buckets.get(category)!;
    if (bucket.length === 0) continue;
    const sorted = [...bucket].sort((a, b) => {
      const ra = BUILTIN_DISPLAY_RANK[a.slug] ?? Number.POSITIVE_INFINITY;
      const rb = BUILTIN_DISPLAY_RANK[b.slug] ?? Number.POSITIVE_INFINITY;
      if (ra !== rb) return ra - rb;
      return a.name.localeCompare(b.name);
    });
    groups.push({ category, meta: CATEGORY_META[category], items: sorted });
  }
  return groups;
}
