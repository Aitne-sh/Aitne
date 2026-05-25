"use client";

/**
 * Owner-facing editor for the project-doc and git-repo templates, plus
 * the explicit "Apply current template to existing projects" action
 * (git-lifecycle-and-triggers.md Decision 8).
 *
 * Scope:
 *   • Two editors stacked: `project.md` and `git-repo.md`.
 *   • A bundled column the dashboard renders read-only so the user can
 *     diff against ship defaults and reset by clearing their override.
 *   • An "Apply" button per editor that opens a warning sheet, confirms
 *     the auto-backup, and POSTs to `/api/git/templates/<kind>/apply`.
 *   • A live status grid that polls every 2s while a re-template run is
 *     in flight (rolling back to idle once `finalizedAt` is set).
 *
 * Anything substantive lives in `git-templates-card.logic.ts` so it is
 * unit-testable without React.
 */

import { useMemo, useState } from "react";
import { FileType2, Loader2, Play, Save } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { ConnectionCard, deriveConfiguredStatus } from "./connection-card";
import {
  type GitRetemplateApplyResponse,
  type GitTemplateKind,
  useApplyGitTemplate,
  useGitTemplate,
  useRetemplateStatus,
  useSaveGitTemplate,
} from "@/lib/hooks/use-git-templates";
import { useRepositories } from "@/lib/hooks/use-repositories";
import {
  buildApplyWarning,
  buildFileGridRows,
  gridStatusCounts,
  runHeadline,
  templateFileName,
  templateLabel,
} from "./git-templates-card.logic";

const KIND_OPTIONS: GitTemplateKind[] = ["project", "git-repo"];

export function GitTemplatesCard() {
  const status = useRetemplateStatus();
  const record = status.data?.status ?? null;

  const headline = runHeadline(record);

  return (
    <ConnectionCard
      name="Project document templates"
      icon={<FileType2 className="h-4 w-4" />}
      status={deriveConfiguredStatus(true)}
    >
      <div className="mt-2 space-y-3">
        <p className="text-xs text-muted-foreground">
          Edit the templates the agent uses when it (re)writes
          {" "}<code className="rounded bg-muted px-1">context/projects/&lt;slug&gt;.md</code>
          {" "}and{" "}
          <code className="rounded bg-muted px-1">context/git-repos/&lt;slug&gt;.md</code>.
          Changes are forward-only — existing files keep their old shape until
          the next git lifecycle event touches them, or until you press
          &ldquo;Apply&rdquo; below to re-conform every existing file at once.
        </p>

        {headline && (
          <Alert
            variant={
              headline.tone === "error"
                ? "error"
                : headline.tone === "warning"
                  ? "warning"
                  : headline.tone === "success"
                    ? "success"
                    : "info"
            }
          >
            <div className="flex items-center justify-between gap-3">
              <span>{headline.label}</span>
              {record && (
                <span className="text-xs font-mono text-muted-foreground">
                  {record.kind} · run #{record.scheduleId}
                </span>
              )}
            </div>
          </Alert>
        )}

        {KIND_OPTIONS.map((kind) => (
          <TemplateEditor key={kind} kind={kind} />
        ))}

        <RetemplateStatusGrid />
      </div>
    </ConnectionCard>
  );
}

function TemplateEditor({ kind }: { kind: GitTemplateKind }) {
  const detail = useGitTemplate(kind);
  const save = useSaveGitTemplate(kind);
  const apply = useApplyGitTemplate(kind);
  const repos = useRepositories();
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [applyResult, setApplyResult] =
    useState<GitRetemplateApplyResponse | null>(null);

  // Count repositories that this `kind`'s re-template would touch — the
  // confirm dialog title surfaces the number so the user knows the blast
  // radius before clicking through. Mirrors `selectRetemplateTargets` →
  // `classifyTemplateKind` on the server (TemplateKind `git-repo` maps to
  // classification `repo-only`, not the literal `git-repo`).
  //
  // Upper bound: the server additionally requires the per-repo context file
  // to exist on disk before targeting it, which the dashboard cannot check.
  // A repo whose overview/journal hasn't been initialized yet will be
  // counted here but skipped on the server. The number stays useful for
  // signalling the dialog's blast radius, even if a few targets fall out.
  const wantClassification = kind === "project" ? "project" : "repo-only";
  const targetCount = useMemo(
    () =>
      (repos.data?.repositories ?? []).filter(
        (r) => r.classification === wantClassification,
      ).length,
    [repos.data?.repositories, wantClassification],
  );

  const active = detail.data?.active ?? "";
  const bundled = detail.data?.bundled ?? "";
  const hasOverride = detail.data?.hasOverride ?? false;
  const draftActive = draft ?? active;
  const draftDirty = draft !== null && draft !== active;

  const onSave = async () => {
    if (draft === null) return;
    setError(null);
    try {
      await save.mutateAsync(draft);
      setDraft(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save template");
    }
  };

  const onResetToBundled = () => {
    setDraft(bundled);
  };

  const warning = buildApplyWarning(kind, targetCount);
  const onConfirmApply = async () => {
    setError(null);
    try {
      const result = await apply.mutateAsync();
      setApplyResult(result);
      setConfirmOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to apply template");
    }
  };

  return (
    <div className="rounded border bg-card p-3 space-y-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">{templateLabel(kind)}</span>
          {hasOverride && <Badge variant="green">overridden</Badge>}
        </div>
        <span className="text-xs text-muted-foreground">
          {templateFileName(kind)}
        </span>
      </div>

      {error && <Alert variant="error">{error}</Alert>}

      <div className="grid gap-2 lg:grid-cols-2">
        <div>
          <p className="mb-1 text-xs font-medium text-muted-foreground">
            Bundled (read-only)
          </p>
          <textarea
            value={bundled}
            readOnly
            className="h-64 w-full resize-none rounded border bg-muted p-2 font-mono text-xs"
          />
        </div>
        <div>
          <p className="mb-1 text-xs font-medium text-muted-foreground">
            Active (edit and save)
          </p>
          <textarea
            value={draftActive}
            onChange={(e) => setDraft(e.target.value)}
            className="h-64 w-full resize-none rounded border bg-background p-2 font-mono text-xs"
            spellCheck={false}
            disabled={detail.isLoading}
          />
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="outline"
          onClick={onSave}
          disabled={!draftDirty || save.isPending}
        >
          <Save className="mr-1 h-3.5 w-3.5" />
          Save template
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={onResetToBundled}
          disabled={detail.isLoading}
        >
          Reset to bundled
        </Button>
        <Button
          size="sm"
          variant="default"
          onClick={() => setConfirmOpen(true)}
          disabled={apply.isPending}
        >
          {apply.isPending ? (
            <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
          ) : (
            <Play className="mr-1 h-3.5 w-3.5" />
          )}
          Apply current template to existing {kind === "project" ? "projects" : "git-repos"}
        </Button>
      </div>

      {applyResult && (
        <Alert variant="info">
          <div className="space-y-1 text-xs">
            <div>
              Re-template enqueued — schedule #{applyResult.scheduleId},
              {" "}{applyResult.targets.length} file(s) backed up.
            </div>
            <div className="font-mono text-muted-foreground break-all">
              backup: {applyResult.backupRoot}
            </div>
          </div>
        </Alert>
      )}

      <Sheet open={confirmOpen} onOpenChange={setConfirmOpen}>
        <SheetContent side="right" className="w-[480px] sm:w-[540px]">
          <SheetHeader>
            <SheetTitle>{warning.title}</SheetTitle>
          </SheetHeader>
          <div className="mt-4 space-y-3 text-sm">
            <ul className="list-disc space-y-1 pl-5">
              {warning.bullets.map((b) => (
                <li key={b}>{b}</li>
              ))}
            </ul>
            <div className="flex gap-2 pt-2">
              <Button
                size="sm"
                onClick={onConfirmApply}
                disabled={apply.isPending}
              >
                {apply.isPending && (
                  <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                )}
                {warning.acknowledge}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setConfirmOpen(false)}
              >
                Cancel
              </Button>
            </div>
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}

function RetemplateStatusGrid() {
  const status = useRetemplateStatus();
  const record = status.data?.status ?? null;
  const rows = useMemo(() => buildFileGridRows(record), [record]);
  const counts = useMemo(() => gridStatusCounts(rows), [rows]);

  if (!record) {
    return (
      <p className="text-xs text-muted-foreground">
        No re-template runs recorded yet.
      </p>
    );
  }

  return (
    <div className="rounded border bg-card p-3 space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium">Last re-template run</span>
        <div className="flex flex-wrap gap-1 text-xs">
          {Object.entries(counts).map(([status, count]) =>
            count > 0 ? (
              <Badge key={status} variant={badgeVariantForStatus(status)}>
                {status}: {count}
              </Badge>
            ) : null,
          )}
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b text-left text-muted-foreground">
              <th className="px-2 py-1">Slug</th>
              <th className="px-2 py-1">Status</th>
              <th className="px-2 py-1">File</th>
              <th className="px-2 py-1">Bytes Δ</th>
              <th className="px-2 py-1">Note</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.slug} className="border-b last:border-0">
                <td className="px-2 py-1 font-mono">{row.slug}</td>
                <td className="px-2 py-1">
                  <Badge variant={badgeVariantForStatus(row.status)}>
                    {row.status}
                  </Badge>
                </td>
                <td className="px-2 py-1 font-mono text-muted-foreground">
                  {row.contextFile}
                </td>
                <td className="px-2 py-1">
                  {row.bytesDelta === null
                    ? "—"
                    : row.bytesDelta >= 0
                      ? `+${row.bytesDelta}`
                      : `${row.bytesDelta}`}
                </td>
                <td className="px-2 py-1 text-muted-foreground">
                  {row.error ?? row.reason ?? ""}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function badgeVariantForStatus(
  status: string,
):
  | "default"
  | "gray"
  | "green"
  | "amber"
  | "red"
  | "blue" {
  switch (status) {
    case "completed":
      return "green";
    case "skipped":
      return "gray";
    case "started":
    case "pending":
      return "blue";
    case "failed":
      return "red";
    case "rolled_back":
      return "amber";
    default:
      return "default";
  }
}

export default GitTemplatesCard;
