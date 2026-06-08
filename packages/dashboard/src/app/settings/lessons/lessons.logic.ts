import type { LessonStore } from "@/lib/api-types";

/**
 * Pure presentation helpers for the Lessons settings page
 * (FEEDBACK_LEARNING_LOOP_DESIGN.md §9 Phase 5). Kept here (not inline in the
 * page component) so they are unit-testable in the node-env dashboard test
 * harness without rendering React.
 */

/** Percent of a cap that is used, clamped to [0, 100] and rounded. */
export function capPercent(used: number, cap: number): number {
  if (cap <= 0) return 0;
  return Math.min(100, Math.max(0, Math.round((used / cap) * 100)));
}

export type CapLevel = "ok" | "warn" | "full";

/**
 * Bucket a utilisation percent into a severity. ≥100% is "full" (the store is
 * over cap and the next consolidation will evict); ≥80% is "warn" (approaching
 * the cap); otherwise "ok".
 */
export function capLevel(percent: number): CapLevel {
  if (percent >= 100) return "full";
  if (percent >= 80) return "warn";
  return "ok";
}

/** The worse of the byte-cap and entry-cap levels for a store. */
export function storeCapLevel(store: LessonStore): CapLevel {
  const order: Record<CapLevel, number> = { ok: 0, warn: 1, full: 2 };
  const byteLevel = capLevel(capPercent(store.bytes, store.capBytes));
  const entryLevel = capLevel(capPercent(store.entries, store.maxEntries));
  // `overCap` from the daemon is authoritative — honour it even if the rounded
  // percents land just under 100 (e.g. a single lesson longer than the cap).
  if (store.overCap) return "full";
  return order[byteLevel] >= order[entryLevel] ? byteLevel : entryLevel;
}

/**
 * Human label for a store's scope. The global `agent` scope is shared by every
 * notify-deciding surface; an `agent:<slug>` scope is injected only into that
 * one Agent's runs.
 */
export function storeTitle(scope: string): string {
  if (scope === "agent") return "Global — all agents & routines";
  if (scope.startsWith("agent:")) return scope.slice("agent:".length);
  return scope;
}

/** Short one-line status for a store, e.g. "3 active · 1 provisional". */
export function storeStatusLine(store: LessonStore): string {
  if (!store.exists) return "Not created yet — no lessons consolidated";
  const parts = [`${store.active} active`];
  if (store.provisional > 0) parts.push(`${store.provisional} provisional`);
  parts.push(`${store.bytes}/${store.capBytes} B`);
  if (store.overCap) parts.push("over cap");
  return parts.join(" · ");
}
