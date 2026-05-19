import type {
  GitTemplateKind,
  RetemplateFileEntry,
  RetemplateFileStatus,
  RetemplateRunStatus,
  RetemplateStatusRecord,
} from "@/lib/hooks/use-git-templates";

/**
 * Pure logic for the Templates card so the multi-state grid + warning
 * copy can be unit-tested without React.
 */

export function templateLabel(kind: GitTemplateKind): string {
  return kind === "project"
    ? "Project (projects/<slug>.md)"
    : "Repo-only (git-repos/<slug>.md)";
}

export function templateFileName(kind: GitTemplateKind): string {
  return kind === "project" ? "project.md" : "git-repo.md";
}

export interface ApplyWarningCopy {
  title: string;
  bullets: string[];
  acknowledge: string;
}

export function buildApplyWarning(
  kind: GitTemplateKind,
  targetCount: number,
): ApplyWarningCopy {
  const label = templateLabel(kind);
  return {
    title: `Re-template ${targetCount} ${kind === "project" ? "project" : "git-repo"} document${targetCount === 1 ? "" : "s"}?`,
    bullets: [
      `${label} files will be re-conformed to the current template body.`,
      "Re-templating may lose information or formatting that the new template does not represent. Files matching the previous schema's sections may have content moved, merged, or dropped depending on how the template changed.",
      "Every targeted file is auto-backed up before the run. The backup path is shown after you confirm.",
      "If a file's session aborts mid-write, the daemon restores it from backup automatically.",
    ],
    acknowledge: "Yes, apply the template",
  };
}

export interface FileGridRow {
  slug: string;
  contextFile: string;
  status: RetemplateFileStatus;
  reason: string | null;
  error: string | null;
  bytesDelta: number | null;
  startedAt: string | null;
  completedAt: string | null;
}

export function buildFileGridRows(
  record: RetemplateStatusRecord | null,
): FileGridRow[] {
  if (!record) return [];
  return Object.values(record.files)
    .map((entry: RetemplateFileEntry) => ({
      slug: entry.slug,
      contextFile: entry.contextFile,
      status: entry.status,
      reason: entry.reason ?? null,
      error: entry.error ?? null,
      bytesDelta:
        entry.beforeBytes !== undefined && entry.afterBytes !== undefined
          ? entry.afterBytes - entry.beforeBytes
          : null,
      startedAt: entry.startedAt ?? null,
      completedAt: entry.completedAt ?? null,
    }))
    .sort((a, b) => a.slug.localeCompare(b.slug));
}

export function gridStatusCounts(
  rows: FileGridRow[],
): Record<RetemplateFileStatus, number> {
  const counts: Record<RetemplateFileStatus, number> = {
    pending: 0,
    started: 0,
    completed: 0,
    skipped: 0,
    failed: 0,
    rolled_back: 0,
  };
  for (const row of rows) counts[row.status] += 1;
  return counts;
}

export function runHeadline(
  record: RetemplateStatusRecord | null,
): { label: string; tone: "info" | "success" | "warning" | "error" } | null {
  if (!record) return null;
  if (!record.finalizedAt) {
    return { label: "Re-template in progress…", tone: "info" };
  }
  switch (record.finalStatus as RetemplateRunStatus) {
    case "success":
      return { label: "Re-template completed", tone: "success" };
    case "partial":
      return { label: "Re-template completed with rollbacks", tone: "warning" };
    case "failed":
      return { label: "Re-template failed", tone: "error" };
    default:
      return { label: "Re-template completed", tone: "success" };
  }
}
