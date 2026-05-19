/**
 * Deterministic random sampling helpers for `<DocsQASuggested>`.
 *
 * The empty-state suggested-question card stack must be stable across
 * renders within the same agent-day (DOCS_QA_DASHBOARD_DESIGN.md §7.5),
 * but must rotate at the 04:00 day boundary. We do not use
 * `crypto.getRandomValues` here — the goal is reproducibility, not
 * cryptographic strength.
 */

const AGENT_DAY_BOUNDARY_HOUR = 4;

/**
 * The `getAgentDayDateStr` rule from `@aitne/shared` runs in
 * the daemon. Reproducing it client-side keeps the dashboard from
 * importing daemon date utilities (different time-zone resolution
 * environment). The dashboard's intl layer uses the browser's local
 * time, which is the operator's local time by definition — exactly
 * what `dayBoundaryHour` operates against.
 */
export function agentDayDateStr(now: Date = new Date()): string {
  const offset = now.getHours() < AGENT_DAY_BOUNDARY_HOUR ? -1 : 0;
  const base = new Date(now);
  base.setDate(base.getDate() + offset);
  const y = base.getFullYear();
  const m = String(base.getMonth() + 1).padStart(2, "0");
  const d = String(base.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** mulberry32 — deterministic uint32-seeded PRNG, well-suited for sampling. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Deterministic FNV-1a 32-bit hash of a UTF-16 string. */
export function fnv1a32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function agentDaySeed(now: Date = new Date()): number {
  return fnv1a32(agentDayDateStr(now));
}

/**
 * Pick `count` items from `pool` using a seeded PRNG. Stable across
 * re-renders for the same `seed`. Returns fewer items if the pool is
 * smaller than `count`. Pool order is *not* preserved — that is the
 * whole point of the random sample.
 */
export function seededSample<T>(pool: ReadonlyArray<T>, count: number, seed: number): T[] {
  if (pool.length === 0 || count <= 0) return [];
  const rand = mulberry32(seed);
  const items = pool.slice();
  // Fisher-Yates with a deterministic PRNG.
  for (let i = items.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [items[i], items[j]] = [items[j]!, items[i]!];
  }
  return items.slice(0, count);
}
