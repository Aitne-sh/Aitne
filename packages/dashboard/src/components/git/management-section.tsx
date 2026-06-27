"use client";

import { useState } from "react";
import { AlertTriangle, BookOpen, Calendar, FileText, Loader2, RefreshCw, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useConfirm } from "@/components/shared/confirm-dialog";
import { useConfig } from "@/lib/hooks/use-config";
import {
  type RepositoryDTO,
  useRefreshRepositoryArchitecture,
  useRepositoryManagement,
  useRunRepoManagementInit,
  useRunRepoManagementScan,
  useSetRepositoryManagement,
} from "@/lib/hooks/use-repositories";
import { formatRelativeMs } from "@/lib/utils";

const FIELD_LABEL =
  "text-[11px] font-medium uppercase tracking-wider text-muted-foreground";

export function ManagementSection({ repo }: { repo: RepositoryDTO }) {
  const management = useRepositoryManagement(repo.id);
  const setEnabled = useSetRepositoryManagement();
  const init = useRunRepoManagementInit();
  const scan = useRunRepoManagementScan();
  const refreshArch = useRefreshRepositoryArchitecture();
  const { data: config } = useConfig();
  const confirm = useConfirm();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const m = management.data?.management;
  // The init/refresh-architecture flows kick off an asynchronous agent run
  // that fills the `## Architecture` section of overview.md. The HTTP
  // response returns as soon as the schedule row is inserted; the dashboard
  // tracks completion by polling the management endpoint, which surfaces
  // the in-flight schedule row from `agent_schedule`. Clear → re-enable.
  const archInFlight = management.data?.architectureRefresh ?? null;
  const archBusy = archInFlight !== null;
  const localCloneRequired = !repo.localPath;

  const contextDir = config?.contextDir ?? "<contextDir>";
  const outputDir = `${contextDir}/git/${repo.slug}/`;

  const onToggle = async (next: boolean) => {
    setError(null);
    setNotice(null);
    if (next && localCloneRequired) {
      setError(
        "Daily git management requires a local clone for v1. Link one via the connections › repositories page first.",
      );
      return;
    }
    try {
      await setEnabled.mutateAsync({ id: repo.id, enabled: next });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update");
    }
  };

  const handleInit = async () => {
    setError(null);
    setNotice(null);
    const ok = await confirm({
      title: "Generate overview now?",
      description: `Writes the skeleton at git/${repo.slug}/overview.md and queues an agent run to fill in the Architecture section. The button stays disabled until that agent run completes.`,
      confirmLabel: "Generate overview",
    });
    if (!ok) return;
    try {
      const result = await init.mutateAsync(repo.id);
      const where = result.overviewPath ?? `git/${repo.slug}/overview.md`;
      const wrote =
        result.result === "exists"
          ? `Overview already exists at ${where}.`
          : `Wrote ${where}.`;
      setNotice(
        result.architectureScheduleId !== null && result.architectureScheduleId !== undefined
          ? `${wrote} Architecture refresh queued (schedule #${result.architectureScheduleId}); waiting for the agent to fill in the Architecture section…`
          : wrote,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to generate overview");
    }
  };

  const handleRefreshArch = async () => {
    setError(null);
    setNotice(null);
    const ok = await confirm({
      title: "Refresh architecture analysis?",
      description: `Spawns a backend agent that reads ${repo.localPath ?? repo.slug} and rewrites the Architecture section of git/${repo.slug}/overview.md. Only the Architecture block is replaced; Notable Changes and Daily Activity Log are preserved. This costs one model session — no automatic schedule, manual only.`,
      confirmLabel: "Refresh architecture",
    });
    if (!ok) return;
    try {
      const result = await refreshArch.mutateAsync(repo.id);
      setNotice(
        `Architecture refresh queued (schedule #${result.scheduleId}). The Architecture section will update once the backend session completes.`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to enqueue refresh");
    }
  };

  const handleScan = async () => {
    setError(null);
    setNotice(null);
    const ok = await confirm({
      title: "Run today's scan now?",
      description: `Writes today's journal entry for ${repo.slug} if there was git or GitHub activity.`,
      confirmLabel: "Run scan",
    });
    if (!ok) return;
    try {
      const result = await scan.mutateAsync(repo.id);
      setNotice(
        result.status === "skipped_no_activity"
          ? "No git or GitHub activity was found in the lookback window; no journal was written."
          : `Wrote ${result.journalPath ?? `git/${repo.slug}/journal/${todayStamp()}.md`}.`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to run scan");
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3 rounded-md border bg-background/40 p-3">
        <div className="min-w-0 flex-1">
          <p className={FIELD_LABEL}>Daily git management</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Generates a curated overview MD and appends a journal entry once
            per day for this repository&apos;s git activity. Local-clone-bound for v1.
          </p>
          {localCloneRequired && (
            <p className="mt-1 flex items-center gap-1 text-xs text-warning">
              <AlertTriangle className="h-3 w-3" />
              No local clone — link one to enable this feature.
            </p>
          )}
        </div>
        <div className="flex items-center gap-2 text-xs">
          <Switch
            checked={Boolean(m?.enabled)}
            disabled={setEnabled.isPending || localCloneRequired}
            onChange={(next) => void onToggle(next)}
            ariaLabel="Toggle daily git management"
          />
          <span>{m?.enabled ? "Enabled" : "Disabled"}</span>
        </div>
      </div>

      {error && (
        <p className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
          {error}
        </p>
      )}
      {notice && (
        <p className="rounded-md border border-success/40 bg-success/10 p-2 text-xs text-success">
          {notice}
        </p>
      )}

      <div className="space-y-1.5">
        <p className={FIELD_LABEL}>Output location</p>
        <p className="rounded-md border bg-background/40 px-3 py-2 font-mono text-xs">
          {outputDir}
        </p>
        <p className="text-[11px] text-muted-foreground">
          Slug derives from <span className="font-mono">display_name</span>;
          edit it on the repository card to change this directory.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatusTile
          icon={<BookOpen className="h-3.5 w-3.5" />}
          label="Init completed"
          value={m?.initCompletedAt ? formatRelativeMs(m.initCompletedAt) : "never"}
        />
        <StatusTile
          icon={<Calendar className="h-3.5 w-3.5" />}
          label="Last scan"
          value={m?.lastScanAt ? formatRelativeMs(m.lastScanAt) : "never"}
        />
        <StatusTile
          icon={<FileText className="h-3.5 w-3.5" />}
          label="Last status"
          value={
            m?.lastScanStatus ? (
              <Badge
                variant={
                  m.lastScanStatus === "ok"
                    ? "green"
                    : m.lastScanStatus === "failed"
                      ? "red"
                      : "gray"
                }
                className="text-[10px]"
              >
                {m.lastScanStatus}
              </Badge>
            ) : (
              "—"
            )
          }
        />
        <StatusTile
          icon={<AlertTriangle className="h-3.5 w-3.5" />}
          label="Failure streak"
          value={m?.scanFailureCount ?? 0}
        />
      </div>

      {archBusy && (
        <p className="flex items-center gap-2 rounded-md border border-primary/40 bg-primary/10 p-2 text-xs text-primary">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Architecture refresh in progress (schedule #{archInFlight?.scheduleId}, status: {archInFlight?.status}). Generate overview and Refresh architecture stay disabled until the agent run completes.
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="outline"
          // Lock both architecture-touching buttons together: while either
          // mutation is in flight (HTTP outstanding) OR the polled
          // architectureRefresh row is pending/running, neither button is
          // safe to click. Without the cross-mutation guard the user could
          // click Refresh during init's HTTP window and earn a 409.
          disabled={
            localCloneRequired ||
            init.isPending ||
            refreshArch.isPending ||
            archBusy
          }
          onClick={handleInit}
        >
          {init.isPending || archBusy ? (
            <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
          ) : (
            <BookOpen className="mr-1 h-3.5 w-3.5" />
          )}
          Generate overview
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={
            localCloneRequired ||
            refreshArch.isPending ||
            init.isPending ||
            archBusy
          }
          onClick={handleRefreshArch}
          title="Spawn an agent to read the repo and rewrite only the Architecture section of overview.md"
        >
          {refreshArch.isPending || archBusy ? (
            <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
          ) : (
            <Sparkles className="mr-1 h-3.5 w-3.5" />
          )}
          Refresh architecture
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={localCloneRequired || scan.isPending || !m?.enabled}
          onClick={handleScan}
        >
          {scan.isPending ? (
            <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
          ) : (
            <RefreshCw className="mr-1 h-3.5 w-3.5" />
          )}
          Run today&apos;s scan now
        </Button>
        <a
          href={`/knowledge?path=${encodeURIComponent(`git/${repo.slug}/overview`)}`}
          className="inline-flex items-center gap-1 rounded-md border px-3 py-1.5 text-xs hover:bg-accent"
        >
          <BookOpen className="h-3.5 w-3.5" />
          Open overview.md
        </a>
        <a
          href={`/knowledge?path=${encodeURIComponent(`git/${repo.slug}/journal/${todayStamp()}`)}`}
          className="inline-flex items-center gap-1 rounded-md border px-3 py-1.5 text-xs hover:bg-accent"
        >
          <Calendar className="h-3.5 w-3.5" />
          Open today&apos;s journal
        </a>
      </div>
    </div>
  );
}

function Switch({
  checked,
  disabled,
  onChange,
  ariaLabel,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: (v: boolean) => void;
  ariaLabel?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={
        "relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 " +
        (checked ? "bg-primary" : "bg-input")
      }
    >
      <span
        className={
          "inline-block h-5 w-5 transform rounded-full bg-background shadow-sm transition-transform " +
          (checked ? "translate-x-[22px]" : "translate-x-[2px]")
        }
      />
    </button>
  );
}

function StatusTile({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div className="rounded-md border bg-background/40 p-3">
      <p className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-muted-foreground">
        {icon}
        {label}
      </p>
      <p className="mt-1 text-sm font-medium text-foreground">{value}</p>
    </div>
  );
}

function todayStamp(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
