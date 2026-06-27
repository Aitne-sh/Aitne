"use client";

import { useState } from "react";
import type { ReactNode } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  FileWarning,
  RefreshCw,
  ShieldCheck,
  Wrench,
  XCircle,
} from "lucide-react";
import { ApiError } from "@/lib/api-client";
import type {
  ContextFrontmatterIssue,
  ContextHealthReport,
  ContextIndexLinkIssue,
  ContextSizeIssue,
  MissingContextFileIssue,
} from "@/lib/api-types";
import {
  useContextHealth,
  useRepairContextStub,
} from "@/lib/hooks/use-context-health";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn, formatAbsoluteTime, formatBytes } from "@/lib/utils";

function statusTone(status: ContextHealthReport["status"]) {
  if (status === "ok") return "success" as const;
  if (status === "warning") return "warning" as const;
  return "error" as const;
}

function statusBadge(status: ContextHealthReport["status"]) {
  if (status === "ok") return { variant: "green" as const, label: "Healthy" };
  if (status === "warning") {
    return { variant: "amber" as const, label: "Warnings" };
  }
  return { variant: "red" as const, label: "Needs Repair" };
}

function statusIcon(status: ContextHealthReport["status"]) {
  if (status === "ok") return CheckCircle2;
  if (status === "warning") return AlertTriangle;
  return XCircle;
}

interface IssueGroupProps {
  title: string;
  count: number;
  children: ReactNode;
  defaultOpen?: boolean;
}

function IssueGroup({ title, count, children, defaultOpen }: IssueGroupProps) {
  const [open, setOpen] = useState(defaultOpen ?? count > 0);
  if (count === 0) return null;
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-sm font-medium text-foreground hover:bg-accent">
        <span>{title}</span>
        <span className="flex items-center gap-2 text-xs text-muted-foreground">
          {count}
          <ChevronRight className={cn("h-3.5 w-3.5 transition-transform", open && "rotate-90")} />
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mt-2 divide-y divide-border rounded-md border border-border">
          {children}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function MissingIssueRow({
  issue,
  repairingPath,
  onRepair,
}: {
  issue: MissingContextFileIssue;
  repairingPath: string | null;
  onRepair: (path: string) => void;
}) {
  const repairing = repairingPath === issue.path;
  return (
    <div className="flex items-center gap-3 px-3 py-2 text-sm">
      <FileWarning className="h-4 w-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div className="truncate font-mono text-xs text-foreground">{issue.path}</div>
        <div className="text-xs text-muted-foreground">{issue.message}</div>
      </div>
      {issue.repairable && (
        <Button
          size="sm"
          variant="outline"
          className="h-7 shrink-0 gap-1"
          disabled={repairingPath !== null}
          onClick={() => onRepair(issue.path)}
        >
          <Wrench className={cn("h-3.5 w-3.5", repairing && "animate-spin")} />
          {repairing ? "Fixing" : "Fix"}
        </Button>
      )}
    </div>
  );
}

function FrontmatterIssueRow({ issue }: { issue: ContextFrontmatterIssue }) {
  return (
    <div className="flex items-start gap-3 px-3 py-2 text-sm">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
      <div className="min-w-0 flex-1">
        <div className="truncate font-mono text-xs text-foreground">{issue.path}</div>
        <div className="text-xs text-muted-foreground">{issue.message}</div>
      </div>
    </div>
  );
}

function SizeIssueRow({ issue }: { issue: ContextSizeIssue }) {
  return (
    <div className="flex items-start gap-3 px-3 py-2 text-sm">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
      <div className="min-w-0 flex-1">
        <div className="truncate font-mono text-xs text-foreground">{issue.path}</div>
        <div className="text-xs text-muted-foreground">
          {formatBytes(issue.bytes)} / {formatBytes(issue.capBytes)}
        </div>
      </div>
    </div>
  );
}

function IndexIssueRow({ issue }: { issue: ContextIndexLinkIssue }) {
  return (
    <div className="flex items-start gap-3 px-3 py-2 text-sm">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
      <div className="min-w-0 flex-1">
        <div className="truncate font-mono text-xs text-foreground">{issue.source}</div>
        <div className="text-xs text-muted-foreground">
          missing <span className="font-mono">{issue.target}</span>
        </div>
      </div>
    </div>
  );
}

export function VaultHealthCard() {
  const { data, isLoading, error, refetch, isFetching } = useContextHealth();
  const repairStub = useRepairContextStub();
  const [repairingPath, setRepairingPath] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [repairError, setRepairError] = useState<string | null>(null);

  const repair = async (path: string) => {
    setRepairingPath(path);
    setNotice(null);
    setRepairError(null);
    try {
      const result = await repairStub.mutateAsync({ path });
      setNotice(
        result.status === "created"
          ? `${result.path} created.`
          : `${result.path} already exists.`,
      );
    } catch (err) {
      if (err instanceof ApiError) {
        setRepairError(`Repair failed: ${err.message}`);
      } else {
        setRepairError(err instanceof Error ? err.message : "Repair failed");
      }
    } finally {
      setRepairingPath(null);
    }
  };

  const status = data?.status ?? "warning";
  const badge = statusBadge(status);
  const StatusIcon = statusIcon(status);

  return (
    <Card tone={data ? statusTone(data.status) : "default"}>
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <ShieldCheck className="h-4 w-4 shrink-0 text-muted-foreground" />
          <h3 className="truncate text-sm font-medium text-foreground">Vault Health</h3>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {data && <Badge variant={badge.variant}>{badge.label}</Badge>}
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={() => void refetch()}
            disabled={isFetching}
            aria-label="Refresh vault health"
          >
            <RefreshCw className={cn("h-3.5 w-3.5", isFetching && "animate-spin")} />
          </Button>
        </div>
      </div>

      {isLoading && (
        <p className="text-sm text-muted-foreground">Checking vault...</p>
      )}

      {error && (
        <Alert variant="error">
          {error instanceof Error ? error.message : "Failed to load vault health."}
        </Alert>
      )}

      {data && (
        <div className="space-y-3">
          <div className="flex items-center gap-2 text-sm">
            <StatusIcon
              className={cn(
                "h-4 w-4",
                data.status === "ok" && "text-success",
                data.status === "warning" && "text-warning",
                data.status === "error" && "text-destructive",
              )}
            />
            <span className="text-foreground">
              {data.status === "ok"
                ? "All required vault checks passed."
                : `${data.summary.missingFiles + data.summary.frontmatterErrors + data.summary.sizeWarnings + data.summary.indexLinkIssues} issue(s) found.`}
            </span>
            <span className="ml-auto text-xs text-muted-foreground">
              {formatAbsoluteTime(data.checkedAt)}
            </span>
          </div>

          <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
            <Metric label="Missing" value={data.summary.missingFiles} />
            <Metric label="Frontmatter" value={data.summary.frontmatterErrors} />
            <Metric label="Oversize" value={data.summary.sizeWarnings} />
            <Metric label="Index links" value={data.summary.indexLinkIssues} />
          </div>

          {notice && <Alert variant="success">{notice}</Alert>}
          {repairError && <Alert variant="error">{repairError}</Alert>}

          <IssueGroup title="Missing files" count={data.missingFiles.length}>
            {data.missingFiles.map((issue) => (
              <MissingIssueRow
                key={issue.path}
                issue={issue}
                repairingPath={repairingPath}
                onRepair={(path) => void repair(path)}
              />
            ))}
          </IssueGroup>

          <IssueGroup title="Frontmatter errors" count={data.frontmatterErrors.length}>
            {data.frontmatterErrors.map((issue) => (
              <FrontmatterIssueRow key={`${issue.path}:${issue.code}`} issue={issue} />
            ))}
          </IssueGroup>

          <IssueGroup title="Oversize injected files" count={data.sizeWarnings.length}>
            {data.sizeWarnings.map((issue) => (
              <SizeIssueRow key={issue.path} issue={issue} />
            ))}
          </IssueGroup>

          <IssueGroup title="Broken index references" count={data.indexLinkIssues.length}>
            {data.indexLinkIssues.map((issue) => (
              <IndexIssueRow
                key={`${issue.source}:${issue.target}`}
                issue={issue}
              />
            ))}
          </IssueGroup>
        </div>
      )}
    </Card>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md border border-border px-2 py-1.5">
      <div className="text-muted-foreground">{label}</div>
      <div className="font-mono text-base font-semibold text-foreground">{value}</div>
    </div>
  );
}
