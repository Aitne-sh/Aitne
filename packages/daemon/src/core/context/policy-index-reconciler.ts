/**
 * MANAGEMENT-POLICY-CAPTURE-PLAN §9 P4 — pure logic for the policy-index
 * reconciler. Mirrors the layout of `index-reconciler.ts`: this file owns
 * snapshot → buckets → rendered output, with no disk or DB I/O. The runner
 * (`policy-index-runner.ts`) drives it.
 *
 * Scope:
 *   - Render `policies/management-captures/_index.md` body (table of active / paused +
 *     a Removed table) from a snapshot of policy frontmatters.
 *   - Render the `## Active Policies` section content for
 *     `policies/management.md` (a shorter table — slug, status, cadence, why).
 *   - Provide a section-aware upsert that splices the section into existing
 *     management.md content, mirroring `upsertManagementRulesAgentIdentity`.
 *
 * Invariants:
 *   - Output is deterministic for a given (sorted) snapshot — callers can
 *     compare rendered output against on-disk content to short-circuit
 *     no-op writes.
 *   - Removed entries appear only under `## Removed`, never in `## Active`.
 *   - Pipe characters in user-supplied cells are escaped.
 */

export type PolicyStatus = "active" | "paused" | "removed";

export interface PolicySnapshotEntry {
  /** Filename stem under `policies/management-captures/`. */
  slug: string;
  status: PolicyStatus;
  /**
   * Cron expression read from the linked execution vehicle: the Agent's
   * `policies/agents/<slug>/agent.md` `schedule.expression`, falling back to
   * a legacy `policies/routines/custom/<slug>.md` `cron` (inert
   * pre-migration files). Null when nothing is linked or neither file
   * resolves. Frozen at snapshot time — edits propagate on the next
   * reconcile pass.
   */
  cadence: string | null;
  /** Slug from `linked.routine` frontmatter, or null. */
  linkedRoutine: string | null;
  /** Slug from `linked.dossier` frontmatter, or null. */
  linkedDossier: string | null;
  /** One-line why, extracted from the body's `## Why` section. */
  why: string;
  /** ISO date (YYYY-MM-DD) from frontmatter `created_at`. */
  createdAt: string;
  /**
   * ISO date for status: removed — taken from frontmatter `updated`. Null
   * for active / paused entries.
   */
  removedAt: string | null;
}

export interface PolicyIndexBuckets {
  active: PolicySnapshotEntry[];
  paused: PolicySnapshotEntry[];
  removed: PolicySnapshotEntry[];
}

export const ACTIVE_POLICIES_SECTION_HEADER = "## Active Policies";

const EM_DASH = "—";

/**
 * Sort policies into status buckets and within each bucket order
 * deterministically (by slug). Removed entries are sorted descending by
 * `removedAt` so the most recent removals appear first; ties fall back to
 * slug for determinism.
 */
export function bucketPolicies(
  snapshots: PolicySnapshotEntry[],
): PolicyIndexBuckets {
  const active: PolicySnapshotEntry[] = [];
  const paused: PolicySnapshotEntry[] = [];
  const removed: PolicySnapshotEntry[] = [];
  for (const entry of snapshots) {
    if (entry.status === "active") active.push(entry);
    else if (entry.status === "paused") paused.push(entry);
    else removed.push(entry);
  }
  active.sort((a, b) => a.slug.localeCompare(b.slug));
  paused.sort((a, b) => a.slug.localeCompare(b.slug));
  removed.sort((a, b) => {
    const aAt = a.removedAt ?? "";
    const bAt = b.removedAt ?? "";
    if (aAt !== bAt) return bAt.localeCompare(aAt);
    return a.slug.localeCompare(b.slug);
  });
  return { active, paused, removed };
}

/**
 * Render the body of `policies/management-captures/_index.md` (frontmatter + sections).
 * `updated` populates the frontmatter `updated:` field.
 */
export function renderPolicyIndex(
  buckets: PolicyIndexBuckets,
  updated: string,
): string {
  const lines: string[] = [];
  lines.push("---");
  lines.push("type: index");
  lines.push("owner: agent");
  lines.push(`updated: ${updated}`);
  lines.push("---");
  lines.push("# Policy index");
  lines.push("");
  lines.push(
    "Auto-maintained by the daemon's policy-index reconciler. Direct edits",
  );
  lines.push(
    "are overwritten on the next reconcile pass — to add or modify a policy,",
  );
  lines.push(
    "edit its `policies/management-captures/<slug>.md` file (or use the `management-policy`",
  );
  lines.push("skill).");
  lines.push("");
  lines.push("## Active");
  lines.push("");
  lines.push("| Slug | Status | Cadence | Linked routine | Linked dossier | Why |");
  lines.push("|---|---|---|---|---|---|");
  for (const entry of [...buckets.active, ...buckets.paused]) {
    lines.push(renderActiveRow(entry));
  }
  lines.push("");
  lines.push("## Removed");
  lines.push("");
  lines.push("| Slug | Removed at | Why |");
  lines.push("|---|---|---|");
  for (const entry of buckets.removed) {
    lines.push(
      `| ${entry.slug} | ${entry.removedAt ?? EM_DASH} | ${escapeCell(entry.why)} |`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

/**
 * Render the `## Active Policies` section of `policies/management.md`. The
 * returned string starts with `## Active Policies\n` and does NOT include
 * a trailing newline (the upsert helper appends one).
 *
 * Shorter than the full index — just slug / status / cadence / why so the
 * section stays under the policy-files.ts injection budget when many
 * policies accumulate.
 */
export function renderActivePoliciesSection(
  buckets: PolicyIndexBuckets,
): string {
  const lines: string[] = [];
  lines.push(ACTIVE_POLICIES_SECTION_HEADER);
  lines.push("");
  lines.push(
    "Auto-maintained by the daemon (do not edit). Source files live under",
  );
  lines.push(
    "`policies/management-captures/<slug>.md`; capture new policies via the",
  );
  lines.push("`management-policy` skill. Full index: [[rules/policies/_index.md]]");
  lines.push("");
  const visible = [...buckets.active, ...buckets.paused];
  if (visible.length === 0) {
    lines.push("_No active policies yet._");
    return lines.join("\n");
  }
  lines.push("| Slug | Status | Cadence | Why |");
  lines.push("|---|---|---|---|");
  for (const entry of visible) {
    lines.push(
      `| ${entry.slug} | ${entry.status} | ${formatCadence(entry.cadence)} | ${escapeCell(entry.why)} |`,
    );
  }
  return lines.join("\n");
}

/**
 * Splice the rendered `## Active Policies` section into existing
 * management.md content. Mirrors `upsertManagementRulesAgentIdentity`,
 * with one correctness fix: the original used `\Z` in the lookahead, but
 * JavaScript regex treats `\Z` as a literal letter — so the agent-identity
 * variant only worked when the target section was followed by another H2.
 * Here we resolve the section's end with explicit string scanning instead.
 *
 *   - If the section header already exists, replace from the header up to
 *     (but not including) the next top-level H2 heading or end of file.
 *   - Otherwise, append at the end of the file (after a blank line) so the
 *     section lands at the bottom regardless of which other sections the
 *     wizard payload happens to include.
 *   - When `content` is empty / whitespace, return the section alone.
 *
 * Section content is normalised to end with a single trailing newline so
 * the resulting file always ends with `\n`.
 */
export function upsertManagementRulesActivePolicies(
  content: string,
  sectionContent: string,
): string {
  const normalized = content.replace(/\r\n/g, "\n").replace(/\s+$/u, "");
  const section = sectionContent.replace(/\r\n/g, "\n").replace(/\s+$/u, "");

  if (!normalized) {
    return `${section}\n`;
  }

  const range = findActivePoliciesSectionRange(normalized);
  if (range) {
    const before = normalized.slice(0, range.start).replace(/\s+$/u, "");
    const after = normalized.slice(range.end).replace(/^\s+/u, "");
    const beforePart = before ? `${before}\n\n` : "";
    const afterPart = after ? `\n\n${after}` : "";
    return `${beforePart}${section}${afterPart}\n`;
  }

  return `${normalized}\n\n${section}\n`;
}

/**
 * Read the current rendered section from existing management.md content,
 * if present. Returns null when the section is absent. Used by the wizard
 * preservation path so a `POST /setup/save-rules` payload that omits the
 * section can re-acquire the on-disk version verbatim.
 */
export function extractActivePoliciesSection(
  content: string,
): string | null {
  const normalized = content.replace(/\r\n/g, "\n");
  const range = findActivePoliciesSectionRange(normalized);
  if (!range) return null;
  return normalized.slice(range.start, range.end).replace(/\s+$/u, "");
}

interface SectionRange {
  start: number;
  end: number;
}

/**
 * Locate the byte range of the `## Active Policies` section in
 * already-LF-normalised content. Returns null when the section is absent.
 *
 * The section starts at the header and ends at either the start of the
 * next top-level H2 heading or end of input. We resolve "next H2" by
 * scanning line-by-line so the JS-incompatible `\Z` anchor isn't needed.
 */
function findActivePoliciesSectionRange(
  normalized: string,
): SectionRange | null {
  const headerPattern = /^## Active Policies(?:\s|$)/m;
  const headerMatch = headerPattern.exec(normalized);
  if (!headerMatch || headerMatch.index === undefined) return null;
  const start = headerMatch.index;

  // Scan for the next H2 after the header line.
  const nextHeadingPattern = /^##\s/gm;
  nextHeadingPattern.lastIndex = start + headerMatch[0].length;
  const nextMatch = nextHeadingPattern.exec(normalized);
  const end = nextMatch ? nextMatch.index : normalized.length;

  return { start, end };
}

function renderActiveRow(entry: PolicySnapshotEntry): string {
  return `| ${entry.slug} | ${entry.status} | ${formatCadence(entry.cadence)} | ${formatLink(entry.linkedRoutine)} | ${formatLink(entry.linkedDossier)} | ${escapeCell(entry.why)} |`;
}

function formatCadence(cadence: string | null): string {
  if (!cadence) return EM_DASH;
  return `\`${escapeCell(cadence)}\``;
}

function formatLink(slug: string | null): string {
  if (!slug) return EM_DASH;
  return escapeCell(slug);
}

function escapeCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim() || EM_DASH;
}
