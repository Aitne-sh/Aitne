import { CONTEXT_RELATIVE_PATHS } from "../context-paths.js";
import type { ContextIndexRow } from "../review-context.js";

/**
 * Pure diff logic for the context-index.md reconciler (B-004 Phase 2a).
 *
 * Takes a filesystem snapshot and the currently-parsed rows, returns the
 * reconciled row set plus diff stats. No disk I/O.
 *
 * Invariants worth preserving:
 *  - Purpose / Review flows on an existing row are never rewritten.
 *  - Last touched is refreshed only when the filesystem mtime date differs
 *    from the stored date.
 *  - Retention caps are applied when the caller builds the snapshot
 *    (rolling directories) so capped files never churn through add/remove
 *    cycles — see `applyRollingRetention`.
 */

/** Vocabulary understood by `review-context.ts:reviewFlowsMatch`. */
const REVIEW_FLOW_VOCAB = new Set([
  "all",
  "hourly",
  "morning",
  "evening",
  "weekly",
  "monthly",
  "roadmap",
  "-",
]);

export interface FilesystemSnapshotEntry {
  /** Relative path under contextDir, forward-slashed, ending in `.md`. */
  path: string;
  /** YYYY-MM-DD derived from filesystem mtime in the agent's local tz. */
  mtimeDate: string;
  /** First H1 title found in the first N lines, or null. */
  h1Title: string | null;
}

export interface ReconcileResult {
  rows: ContextIndexRow[];
  added: string[];
  removed: string[];
  refreshedMtime: string[];
  noOp: boolean;
}

/**
 * Retention caps for rolling journals. Applied at snapshot-build time so
 * capped files neither appear in `add_set` nor churn through remove/add
 * cycles on the next run. Values from §4.7.
 */
export const ROLLING_RETENTION: Record<"daily" | "weekly" | "monthly", number> = {
  daily: 7,
  weekly: 4,
  monthly: 6,
};

/**
 * Returns true when the walker should include the given path in the
 * indexer snapshot. §4.2 — walker discovers every `.md` under contextDir,
 * this predicate narrows discovery to the set that should receive rows.
 */
export function shouldIndexPath(relativePath: string): boolean {
  if (!relativePath.endsWith(".md")) return false;
  if (relativePath === CONTEXT_RELATIVE_PATHS.contextIndex) return false;
  const segments = relativePath.split("/");
  const basename = segments[segments.length - 1];
  if (basename === "_index.md") return false;

  if (relativePath.startsWith("agent/scratch/")) return false;
  if (relativePath.startsWith("inbox/")) return false;
  if (relativePath.startsWith("routines/custom/")) return false;

  if (relativePath === CONTEXT_RELATIVE_PATHS.today) return true;
  if (relativePath === CONTEXT_RELATIVE_PATHS.yesterday) return true;
  if (relativePath === CONTEXT_RELATIVE_PATHS.roadmap) return true;
  if (relativePath === CONTEXT_RELATIVE_PATHS.agent.journal) return true;

  if (relativePath.startsWith("user/")) return true;
  if (relativePath.startsWith("rules/")) return true;
  if (relativePath.startsWith("routines/")) return true;
  if (relativePath.startsWith("projects/")) return true;
  if (relativePath.startsWith("dossiers/")) return true;
  if (relativePath.startsWith("daily/")) return true;
  if (relativePath.startsWith("weekly/")) return true;
  if (relativePath.startsWith("monthly/")) return true;

  return false;
}

/**
 * Apply rolling-directory retention caps to a snapshot. Keeps the N
 * lexicographically-largest paths in each capped directory — filenames
 * are date-encoded (`YYYY-MM-DD`, `YYYY-Www`, `YYYY-MM`), so string-sort
 * descending selects the most recent entries. Passes all other paths
 * through untouched.
 */
export function applyRollingRetention(
  snapshot: FilesystemSnapshotEntry[],
): FilesystemSnapshotEntry[] {
  const buckets = new Map<string, FilesystemSnapshotEntry[]>();
  const passthrough: FilesystemSnapshotEntry[] = [];

  for (const entry of snapshot) {
    const prefix = entry.path.startsWith("daily/")
      ? "daily"
      : entry.path.startsWith("weekly/")
        ? "weekly"
        : entry.path.startsWith("monthly/")
          ? "monthly"
          : null;
    if (prefix === null) {
      passthrough.push(entry);
      continue;
    }
    const bucket = buckets.get(prefix) ?? [];
    bucket.push(entry);
    buckets.set(prefix, bucket);
  }

  for (const [prefix, bucket] of buckets) {
    const cap = ROLLING_RETENTION[prefix as keyof typeof ROLLING_RETENTION];
    bucket.sort((a, b) => b.path.localeCompare(a.path));
    bucket.splice(cap);
    passthrough.push(...bucket);
  }

  return passthrough;
}

/**
 * Produce a default row for a path the reconciler is seeing for the first
 * time. Callers supply the snapshot entry so the default can read the
 * filesystem mtime + H1 title without re-walking. The returned
 * `reviewFlows` is guaranteed to contain only values from the review-flow
 * vocabulary.
 */
export function defaultRowFor(entry: FilesystemSnapshotEntry): ContextIndexRow {
  const { purpose, reviewFlows } = defaultCells(entry);
  return {
    path: entry.path,
    purpose,
    reviewFlows,
    lastTouched: entry.mtimeDate,
  };
}

/**
 * Core diff. Returns the new row list and diff stats.
 *
 * Row ordering:
 *  - Existing rows preserve their original position.
 *  - Added rows are appended, sorted deterministically by path.
 *
 * `noOp` is true when every set is empty — callers skip the write entirely
 * in that case (§4.3 early-return).
 */
export function reconcileContextIndex(
  snapshot: FilesystemSnapshotEntry[],
  currentRows: ContextIndexRow[],
): ReconcileResult {
  const snapshotByPath = new Map<string, FilesystemSnapshotEntry>();
  for (const entry of snapshot) {
    snapshotByPath.set(entry.path, entry);
  }
  const currentByPath = new Map<string, ContextIndexRow>();
  for (const row of currentRows) {
    currentByPath.set(row.path, row);
  }

  const added: string[] = [];
  const removed: string[] = [];
  const refreshedMtime: string[] = [];

  const resultRows: ContextIndexRow[] = [];
  for (const row of currentRows) {
    const entry = snapshotByPath.get(row.path);
    if (!entry) {
      removed.push(row.path);
      continue;
    }
    if (row.lastTouched !== entry.mtimeDate) {
      refreshedMtime.push(row.path);
      resultRows.push({ ...row, lastTouched: entry.mtimeDate });
      continue;
    }
    resultRows.push(row);
  }

  const newEntries: FilesystemSnapshotEntry[] = [];
  for (const entry of snapshot) {
    if (!currentByPath.has(entry.path)) newEntries.push(entry);
  }
  newEntries.sort((a, b) => a.path.localeCompare(b.path));
  for (const entry of newEntries) {
    resultRows.push(defaultRowFor(entry));
    added.push(entry.path);
  }

  const noOp =
    added.length === 0 && removed.length === 0 && refreshedMtime.length === 0;

  return { rows: resultRows, added, removed, refreshedMtime, noOp };
}

/**
 * Render a full `context-index.md` file from a row list. `updated` goes
 * into the frontmatter; rows are emitted in the order supplied.
 */
export function renderContextIndex(
  rows: ContextIndexRow[],
  updated: string,
): string {
  const lines: string[] = [];
  lines.push("---");
  lines.push("type: index");
  lines.push("owner: agent");
  lines.push(`updated: ${updated}`);
  lines.push("---");
  lines.push("# Context Index");
  lines.push("");
  lines.push(
    "Prompt-injection hub for dossier-backed flows (B-004). This file stays in",
  );
  lines.push(
    "English so review / routine prompts read a stable, backend-neutral summary.",
  );
  lines.push("");
  lines.push("## Files");
  lines.push("");
  lines.push("| Path | Purpose | Review flows | Last touched |");
  lines.push("|---|---|---|---|");
  for (const row of rows) {
    lines.push(
      `| \`${row.path}\` | ${escapeCell(row.purpose)} | ${escapeCell(row.reviewFlows)} | ${row.lastTouched} |`,
    );
  }
  lines.push("");
  lines.push("## Notes");
  lines.push("");
  lines.push(
    "- Maintained by the daemon reconciler (`packages/daemon/src/core/context/index-reconciler.ts`).",
  );
  lines.push(
    "- `Review flows` tokens: `all`, `hourly`, `morning`, `evening`, `weekly`,",
  );
  lines.push("  `monthly`, `roadmap`, or `-` when no flow should auto-load the file.");
  lines.push("");
  return lines.join("\n");
}

function defaultCells(
  entry: FilesystemSnapshotEntry,
): { purpose: string; reviewFlows: string } {
  const path = entry.path;
  // Treat whitespace-only / pipe-stuffed H1 titles as absent so the
  // path-derived fallback wins. Parsing an H1 from the first few lines
  // can legitimately yield whitespace when the file opens with `# ` (a
  // malformed heading that passes the regex but carries no real title).
  const title = cleanTitle(entry.h1Title);

  if (path === CONTEXT_RELATIVE_PATHS.today) {
    return emit({
      purpose: "Current-day schedule, tasks, agent plan, handoff",
      reviewFlows: "hourly, morning, evening",
    });
  }
  if (path === CONTEXT_RELATIVE_PATHS.yesterday) {
    return emit({
      purpose: "Previous day — Morning routine input",
      reviewFlows: "morning",
    });
  }
  if (path === CONTEXT_RELATIVE_PATHS.roadmap) {
    return emit({
      purpose: "Long-horizon commitments and recurring plans",
      reviewFlows: "evening, weekly, monthly, roadmap",
    });
  }
  if (path === CONTEXT_RELATIVE_PATHS.agent.journal) {
    return emit({
      purpose: title ?? "Agent self-reflection log",
      reviewFlows: "weekly, monthly",
    });
  }

  if (path === CONTEXT_RELATIVE_PATHS.user.profile) {
    return emit({
      purpose: title ?? "User identity, preferences, communication style",
      reviewFlows: "all",
    });
  }
  if (path.startsWith("user/")) {
    const area = path.slice("user/".length).replace(/\.md$/, "");
    return emit({
      purpose: title ?? `User ${area}`,
      reviewFlows: "morning, monthly",
    });
  }

  if (path.startsWith("rules/")) {
    const name = path.slice("rules/".length).replace(/\.md$/, "");
    return emit({
      purpose: title ?? `Rule: ${name}`,
      reviewFlows: "all",
    });
  }

  if (path.startsWith("routines/")) {
    const cadence = path.slice("routines/".length).replace(/\.md$/, "");
    const flow = REVIEW_FLOW_VOCAB.has(cadence) ? cadence : "-";
    return emit({
      purpose: title ?? `${capitalize(cadence)} routine rulebook`,
      reviewFlows: flow,
    });
  }

  if (path.startsWith("projects/")) {
    const slug = path.slice("projects/".length).replace(/\.md$/, "");
    return emit({
      purpose: title ?? `Project ${slug}`,
      reviewFlows: "weekly, monthly, roadmap",
    });
  }

  if (path.startsWith("dossiers/")) {
    const flow = path.slice("dossiers/".length).replace(/\.md$/, "");
    const normalizedFlow = REVIEW_FLOW_VOCAB.has(flow) ? flow : "-";
    return emit({
      purpose: title ?? `${capitalize(flow)} dossier`,
      reviewFlows: normalizedFlow,
    });
  }

  if (path.startsWith("daily/")) {
    return emit({
      purpose: title ?? "Synthesized daily journal",
      reviewFlows: "-",
    });
  }
  if (path.startsWith("weekly/")) {
    return emit({
      purpose: title ?? "Weekly review artifact",
      reviewFlows: "-",
    });
  }
  if (path.startsWith("monthly/")) {
    return emit({
      purpose: title ?? "Monthly review artifact",
      reviewFlows: "-",
    });
  }

  return emit({
    purpose: title ?? path,
    reviewFlows: "-",
  });
}

function emit(cells: {
  purpose: string;
  reviewFlows: string;
}): { purpose: string; reviewFlows: string } {
  return {
    purpose: cells.purpose.replace(/\s+/g, " ").trim(),
    reviewFlows: cells.reviewFlows,
  };
}

function cleanTitle(raw: string | null): string | null {
  if (raw === null) return null;
  const trimmed = raw.replace(/\s+/g, " ").trim();
  return trimmed.length > 0 ? trimmed : null;
}

function escapeCell(value: string): string {
  return value.replace(/\|/g, "\\|");
}

function capitalize(value: string): string {
  return value.slice(0, 1).toUpperCase() + value.slice(1);
}
