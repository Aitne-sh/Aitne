/**
 * Unified Task Board — typed-ref grammar (§12 OQ#2).
 *
 * Pure parse/format + the prefix → owning-route table that both the
 * blast-radius preview (`impact.ts`) and the write facade (`dispatch.ts`)
 * resolve against. No I/O, no DB — covered 100%.
 *
 * Grammar: `<prefix>:<id>` for every prefix EXCEPT managed tasks, whose
 * canonical handle is the literal `mt_<n>` (underscore) used everywhere in the
 * codebase (§9.4). We also accept the colon form `mt:<n>` and normalise it to
 * `mt_<n>` so callers can be lenient.
 */

import type { TaskRef, TaskRefPrefix } from "./types.js";

/** Every recognised prefix. */
const PREFIXES: ReadonlySet<TaskRefPrefix> = new Set([
  "rs",
  "mt",
  "agent",
  "as",
  "cluster",
  "bt",
  "bx",
  "trigger",
  "obj",
]);

/** Prefixes whose id is a positive integer (a DB rowid). */
const NUMERIC_ID_PREFIXES: ReadonlySet<TaskRefPrefix> = new Set(["rs", "as", "trigger"]);

/**
 * Id shape per prefix. Numeric for rowid-backed rows; a path-safe token (no
 * whitespace, no `/`, no `..`) for slugs/uuids so a ref can never escape its
 * owning route segment.
 */
const NUMERIC_ID = /^\d+$/;
const TOKEN_ID = /^[A-Za-z0-9._-]+$/;

function isValidId(prefix: TaskRefPrefix, id: string): boolean {
  if (id.length === 0) return false;
  if (id.includes("..")) return false;
  return NUMERIC_ID_PREFIXES.has(prefix) ? NUMERIC_ID.test(id) : TOKEN_ID.test(id);
}

/**
 * Parse a raw ref string into a {@link TaskRef}, or `null` if it is malformed
 * or uses an unknown prefix. The returned `id` is the **route-path segment**
 * for the owning resource (e.g. `"mt_3"` for a managed task, `"42"` for `rs:42`).
 */
export function parseTaskRef(raw: string): TaskRef | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;

  // Managed-task literal id: `mt_<n>`.
  const underscore = /^mt_(\d+)$/.exec(trimmed);
  if (underscore) {
    return { prefix: "mt", id: `mt_${underscore[1]}`, raw: `mt_${underscore[1]}` };
  }

  const colon = trimmed.indexOf(":");
  if (colon <= 0) return null;
  const prefix = trimmed.slice(0, colon) as TaskRefPrefix;
  const rest = trimmed.slice(colon + 1);
  if (!PREFIXES.has(prefix)) return null;

  // Colon form of a managed task → normalise to the literal `mt_<n>`.
  if (prefix === "mt") {
    if (!NUMERIC_ID.test(rest)) return null;
    return { prefix: "mt", id: `mt_${rest}`, raw: `mt_${rest}` };
  }

  if (!isValidId(prefix, rest)) return null;
  return { prefix, id: rest, raw: `${prefix}:${rest}` };
}

/**
 * Build the canonical ref string for a prefix + id. For managed tasks pass the
 * numeric part or the full `mt_<n>`; both yield `mt_<n>`.
 */
export function formatTaskRef(prefix: TaskRefPrefix, id: string | number): string {
  const raw = String(id);
  if (prefix === "mt") {
    const n = raw.startsWith("mt_") ? raw.slice(3) : raw;
    return `mt_${n}`;
  }
  return `${prefix}:${raw}`;
}

/**
 * Base API route that owns each prefix. `null` ⇒ the prefix is read-only from
 * the board's perspective (no create/edit/delete owner the facade dispatches
 * to): research clusters are managed via their own status helper, and `obj` is
 * reserved until `objective_task` ships (§5.5). NB: research clusters are no
 * longer *listed* on the board (an unbounded browsing-analytics artifact — see
 * `assembleInventory`); `cluster:` stays in the grammar only so an explicit
 * `/tasks/impact?ref=cluster:<slug>` still resolves.
 */
const OWNER_BASE_PATH: Record<TaskRefPrefix, string | null> = {
  rs: "/api/recurring-schedules",
  mt: "/api/managed-tasks",
  agent: "/api/agents",
  as: "/api/schedule",
  bt: "/api/background-task",
  bx: "/api/browser-task",
  trigger: "/api/triggers",
  cluster: null,
  obj: null,
};

/** Resolve the per-row owner route for a ref, e.g. `rs:42` → `/api/recurring-schedules/42`. */
export function ownerRouteForRef(ref: TaskRef): string | null {
  const base = OWNER_BASE_PATH[ref.prefix];
  return base === null ? null : `${base}/${ref.id}`;
}
