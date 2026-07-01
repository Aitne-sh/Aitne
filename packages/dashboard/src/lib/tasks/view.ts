/**
 * Unified Task Board — pure view helpers for the `/tasks` page.
 *
 * Kept out of the page component so the grouping/labelling is unit-tested
 * without a render harness (dashboard convention — see use-agents.ts docstring).
 */

import { formatDistance } from "date-fns";
import { describeCron } from "../agents/format";
import type { TaskBoardItem, TaskKind, TaskOrigin } from "./types";

/** Display order of the kind groups on the board. */
export const KIND_ORDER: readonly TaskKind[] = [
  "dm",
  "agent",
  "app_fetch",
  "trigger",
  "reminder",
  "background",
  "browser",
] as const;

const KIND_LABELS: Record<TaskKind, string> = {
  dm: "Recurring DMs",
  agent: "Agents",
  app_fetch: "App fetch",
  trigger: "Automation triggers",
  reminder: "Reminders",
  background: "Background tasks",
  browser: "Browser tasks",
};

const ORIGIN_LABELS: Record<TaskOrigin, string> = {
  system: "System",
  user: "You",
  agent: "Agent",
};

export function kindLabel(kind: TaskKind): string {
  return KIND_LABELS[kind];
}

export function originLabel(origin: TaskOrigin): string {
  return ORIGIN_LABELS[origin];
}

export interface TaskKindGroup {
  kind: TaskKind;
  label: string;
  items: TaskBoardItem[];
}

/**
 * Group the flat inventory by kind in {@link KIND_ORDER}, preserving the
 * server's within-kind ordering and dropping empty groups. Unknown kinds (a
 * forward-compat safeguard) are appended after the known ones, alphabetically.
 */
export function groupTasksByKind(items: readonly TaskBoardItem[]): TaskKindGroup[] {
  const buckets = new Map<TaskKind, TaskBoardItem[]>();
  for (const item of items) {
    const bucket = buckets.get(item.kind);
    if (bucket) bucket.push(item);
    else buckets.set(item.kind, [item]);
  }

  const groups: TaskKindGroup[] = [];
  for (const kind of KIND_ORDER) {
    const bucket = buckets.get(kind);
    if (bucket && bucket.length > 0) {
      groups.push({ kind, label: kindLabel(kind), items: bucket });
      buckets.delete(kind);
    }
  }
  // Any kind not in KIND_ORDER (shouldn't happen) — surface it rather than hide it.
  for (const kind of [...buckets.keys()].sort()) {
    groups.push({ kind, label: kind, items: buckets.get(kind) as TaskBoardItem[] });
  }
  return groups;
}

// ── Human-readable cadence + time ────────────────────────────────────────────

/** A cron field is only digits / `*` / `,` / `-` / `/` (no letters). */
const CRON_FIELD = /^[\d*/,\-]+$/;

/** True when a cadence string is a raw cron expression (5–6 cron-token fields). */
function looksLikeCron(value: string): boolean {
  const fields = value.split(/\s+/);
  if (fields.length !== 5 && fields.length !== 6) return false;
  return fields.every((f) => CRON_FIELD.test(f));
}

/**
 * Turn the board's `cadence` field into something a person can read. The daemon
 * returns it as EITHER a raw cron expression (built-in agents fall back to their
 * stored `scheduleExpression`, e.g. `0 4-22/2 * * *`) or an already-friendly
 * label (`"Daily at 19:00"`, `"one-off"`, `"nightly"`). Raw cron is run through
 * the shared `describeCron` humanizer (→ "Every 2h", "Every day at 18:00");
 * everything else passes through untouched.
 */
export function humanizeCadence(cadence: string | null): string | null {
  if (cadence === null) return null;
  const trimmed = cadence.trim();
  if (trimmed.length === 0) return null;
  return looksLikeCron(trimmed) ? describeCron(trimmed) : trimmed;
}

/**
 * Parse a daemon timestamp into an absolute instant. Every board timestamp is
 * UTC — SQLite `YYYY-MM-DD HH:MM:SS` (no zone, written via `toISOString()`) or a
 * full ISO string ending in `Z`. A bare SQLite datetime is therefore read as
 * UTC (append `Z`) rather than as browser-local, which is the bug that made
 * "Daily at 19:00" show a next run of "02:00" (the same instant, in two zones).
 */
export function parseUtcTimestamp(raw: string | null): Date | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  const hasZone = /([zZ]|[+-]\d{2}:?\d{2})$/.test(trimmed);
  const iso = hasZone ? trimmed.replace(" ", "T") : `${trimmed.replace(" ", "T")}Z`;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

export interface FormattedTime {
  /** Wall-clock in the viewer's own locale + timezone, e.g. "Jul 2, 11:00 AM". */
  absolute: string;
  /** Relative to now, e.g. "in about 10 hours" / "3 days ago". */
  relative: string;
  /** Canonical ISO string, for a hover/title tooltip. */
  iso: string;
}

/**
 * Format a board timestamp for humans: an absolute wall-clock rendered in the
 * viewer's OWN timezone (so a Tokyo user sees Tokyo time, not the daemon's UTC),
 * plus a relative "in 10 hours"/"3 days ago" hint. `opts` are injectable so the
 * transform is deterministic under test; in the browser they default to the
 * runtime locale/zone and the current time.
 */
export function formatTaskTime(
  raw: string | null,
  opts: { now?: Date; timeZone?: string; locale?: string } = {},
): FormattedTime | null {
  const date = parseUtcTimestamp(raw);
  if (!date) return null;
  const now = opts.now ?? new Date();
  const absolute = date.toLocaleString(opts.locale, {
    timeZone: opts.timeZone,
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  return { absolute, relative: formatDistance(date, now, { addSuffix: true }), iso: date.toISOString() };
}

// ── Strip stats ──────────────────────────────────────────────────────────────

export interface BoardStats {
  /** Items with an execution in flight right now. */
  running: number;
  /** Enabled recurring commitments (a cadence + `active` status). */
  activeRecurring: number;
}

/**
 * Counts for the Tasks status strip (DASHBOARD_AUTOMATION_IA_REDESIGN.md §3).
 * Derived from the board inventory the page already fetches — `running` is the
 * fulfiller-state word the daemon emits for in-flight work; `activeRecurring`
 * is the "standing commitments currently on" figure.
 */
export function boardStats(items: readonly TaskBoardItem[]): BoardStats {
  let running = 0;
  let activeRecurring = 0;
  for (const item of items) {
    if (item.status === "running") running++;
    if (item.cadence !== null && item.status === "active") activeRecurring++;
  }
  return { running, activeRecurring };
}

// ── Deep links to the owning surface ─────────────────────────────────────────

/**
 * The surface that actually manages a board item, by kind. The board is
 * read-only (§5.2c) — every write lives on the owner's page — so a detail view
 * links out to it. Since the Schedule merge (DASHBOARD_AUTOMATION_IA_REDESIGN
 * §2), `dm`/`reminder` are managed on the Tasks page's own tabs, so their
 * hrefs stay in-page. Kinds with no dedicated page (`background`) return null.
 */
export function manageHref(item: TaskBoardItem): string | null {
  switch (item.kind) {
    case "agent": {
      const slug = item.ref.startsWith("agent:") ? item.ref.slice("agent:".length) : "";
      return slug ? `/agents/${slug}` : "/agents";
    }
    case "dm":
      return "/tasks?tab=dms";
    case "reminder":
      return "/tasks?tab=queue";
    case "app_fetch":
      return "/settings/management";
    case "browser": {
      const id = item.ref.startsWith("bx:") ? item.ref.slice("bx:".length) : "";
      return id ? `/browser-tasks/${id}` : "/browser-tasks";
    }
    case "background":
      return null;
    default:
      return null;
  }
}

const MANAGE_SURFACE: Record<TaskKind, string> = {
  dm: "Scheduled DMs",
  agent: "Agents",
  app_fetch: "Management",
  // Automation triggers have no dedicated dashboard page yet (API-managed,
  // Approve tier) — manageHref returns null, so this label stays unused
  // until a page exists.
  trigger: "API",
  reminder: "the Queue",
  background: "Activity",
  browser: "Browser",
};

/** Label for the "Manage on …" deep link. */
export function manageLabel(item: TaskBoardItem): string {
  return `Manage on ${MANAGE_SURFACE[item.kind] ?? "its surface"}`;
}
