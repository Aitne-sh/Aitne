"use client";

/**
 * WIKI_BUILDER_DESIGN.md — `/wiki/timeline`.
 *
 * Two surfaces stacked on this page:
 *   1. Health report viewer (latest `90_meta/health/<date>.md`).
 *   2. Chronological log timeline (read from `log.md`).
 *
 * Both surfaces read live from the wiki API; no daemon-side schema is
 * added for them — they're a pure rendering pass over files the wiki
 * skills already produce.
 *
 * Lives under `/wiki` (My Life section) per the §6 IA split: content
 * browsing is co-located with other "user content" pages (Knowledge,
 * Reading, Git, …); `/settings/wiki` retains configuration only.
 */

import { useMemo, useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { HeartPulse, History, Inbox } from "lucide-react";
import { api, ApiError } from "@/lib/api-client";
import type {
  WikiFileResponse,
  WikiIndexResponse,
  WikiWorkspacesResponse,
} from "@/lib/api-types";
import {
  distinctProcessKeys,
  filterByProcessKey,
  findLatestHealthReportPath,
  parseWikiHealthReport,
  parseWikiLog,
  sortWikiLogEntries,
  type WikiHealthReport,
  type WikiLogEntry,
} from "@/lib/wiki-timeline";
import { EmptyState } from "@/components/shared/empty-state";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader as BasePageHeader } from "@/components/ui/page-header";
import { Spinner } from "@/components/ui/spinner";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

// The wiki API requires an `x-process-key` header on every request. The
// dashboard timeline reads files but is not itself a wiki session; we
// pick `wiki.ask` as the closest read-only intent and the auth layer
// passes any `wiki.*` key for GETs (see `authorizeWikiRequest` in
// `packages/daemon/src/api/routes/wiki.ts`).
const WIKI_READ_PROCESS_KEY = "wiki.ask";

interface UseLatestHealthOptions {
  workspace: string;
  enabled: boolean;
}

function useLatestHealthReport({ workspace, enabled }: UseLatestHealthOptions) {
  const indexQuery = useQuery({
    queryKey: ["wiki-index", workspace],
    enabled,
    queryFn: () =>
      api.get<WikiIndexResponse>(`/wiki/${workspace}/index`, {
        headers: { "x-process-key": WIKI_READ_PROCESS_KEY },
      }),
  });
  const latestPath = indexQuery.data
    ? findLatestHealthReportPath(indexQuery.data.files)
    : null;
  const reportQuery = useQuery({
    queryKey: ["wiki-health", workspace, latestPath],
    enabled: enabled && !!latestPath,
    queryFn: () =>
      api.get<WikiFileResponse>(
        `/wiki/${workspace}/files/${encodeURI(latestPath!)}`,
        { headers: { "x-process-key": WIKI_READ_PROCESS_KEY } },
      ),
  });
  const parsed: WikiHealthReport | null = useMemo(() => {
    if (!reportQuery.data || !latestPath) return null;
    return parseWikiHealthReport(latestPath, reportQuery.data.content);
  }, [reportQuery.data, latestPath]);
  return {
    isLoading: indexQuery.isLoading || reportQuery.isLoading,
    error: (indexQuery.error ?? reportQuery.error) as Error | null,
    report: parsed,
    hasIndex: !!indexQuery.data,
    latestPath,
  };
}

function useWikiLog(workspace: string, enabled: boolean) {
  const query = useQuery({
    queryKey: ["wiki-log", workspace],
    enabled,
    // `log.md` is at the workspace root. The wiki API exposes it under
    // `/files/log.md` (the layer classifier recognises the literal path).
    queryFn: () =>
      api.get<WikiFileResponse>(`/wiki/${workspace}/files/log.md`, {
        headers: { "x-process-key": WIKI_READ_PROCESS_KEY },
      }),
  });
  const entries = useMemo<WikiLogEntry[]>(() => {
    if (!query.data) return [];
    return sortWikiLogEntries(parseWikiLog(query.data.content));
  }, [query.data]);
  // A freshly-enabled wiki has no `log.md` until the first write — the
  // daemon's file route returns 404 for that case. Treat 404 as an empty
  // log so the page falls through to the "No activity yet" hint instead
  // of surfacing a scary error toast.
  const error = query.error as Error | null;
  const isMissingFile = error instanceof ApiError && error.status === 404;
  return {
    isLoading: query.isLoading,
    error: isMissingFile ? null : error,
    entries,
  };
}

function formatApiError(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return "Request failed";
}

function formatTimestamp(iso: string): string {
  try {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return iso;
    return date.toLocaleString();
  } catch {
    return iso;
  }
}

export default function WikiTimelinePage() {
  const workspaces = useQuery({
    queryKey: ["wiki-workspaces"],
    queryFn: () => api.get<WikiWorkspacesResponse>("/wiki/workspaces"),
  });
  const workspace =
    workspaces.data?.workspaces.find((w) => w.active) ??
    workspaces.data?.workspaces[0] ??
    null;

  const enabled = !!workspace;
  const health = useLatestHealthReport({
    workspace: workspace?.name ?? "default",
    enabled,
  });
  const log = useWikiLog(workspace?.name ?? "default", enabled);

  const [filter, setFilter] = useState<string>("all");
  const filtered = useMemo(
    () => filterByProcessKey(log.entries, filter),
    [log.entries, filter],
  );
  const filterOptions = useMemo(() => distinctProcessKeys(log.entries), [log.entries]);

  if (workspaces.isLoading) {
    return (
      <div className="flex flex-col gap-4 p-6">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner /> Loading…
        </div>
      </div>
    );
  }
  if (workspaces.error) {
    return (
      <div className="flex flex-col gap-4 p-6">
        <Alert variant="error">{formatApiError(workspaces.error)}</Alert>
      </div>
    );
  }
  if (!workspace) {
    return (
      <div className="flex flex-col gap-4 p-6">
        <PageHeader />
        <Alert variant="info">
          The wiki is not enabled. Open{" "}
          <Link className="underline" href="/settings/wiki">
            /settings/wiki
          </Link>{" "}
          to enable a workspace first.
        </Alert>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 p-6">
      <PageHeader>
        <div className="mt-2 text-sm text-muted-foreground">
          Workspace <code className="font-mono">{workspace.name}</code> ·{" "}
          <Link className="underline" href="/wiki">
            Back to wiki
          </Link>
          {" · "}
          <Link className="underline" href="/settings/wiki">
            Configuration
          </Link>
        </div>
      </PageHeader>

      <Card>
        <CardHeader className="items-start">
          <div className="flex items-start gap-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-border bg-muted text-muted-foreground">
              <HeartPulse className="h-4 w-4" />
            </div>
            <div>
              <CardTitle>Latest health report</CardTitle>
              <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
                Newest <code>90_meta/health/&lt;date&gt;.md</code>. Action
                items come from <code>!lint</code> runs.
              </p>
            </div>
          </div>
        </CardHeader>
        {health.isLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner /> Loading…
          </div>
        ) : health.error ? (
          <Alert variant="error">{formatApiError(health.error)}</Alert>
        ) : !health.latestPath ? (
          <EmptyState
            icon={HeartPulse}
            title="No health reports yet"
            description="Send !lint from a DM to generate the first one."
          />
        ) : !health.report ? (
          <p className="text-sm text-muted-foreground">
            Could not parse the latest health report at{" "}
            <code>{health.latestPath}</code>.
          </p>
        ) : (
          <HealthReportView report={health.report} />
        )}
      </Card>

      <Card>
        <CardHeader className="items-start">
          <div className="flex w-full flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div className="flex items-start gap-3">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-border bg-muted text-muted-foreground">
                <History className="h-4 w-4" />
              </div>
              <div>
                <CardTitle>Activity timeline</CardTitle>
                <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
                  Reverse-chronological view of <code>log.md</code>. Filter
                  by wiki command to focus on a specific surface.
                </p>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <label
                htmlFor="wiki-timeline-filter"
                className="text-xs font-medium uppercase tracking-wide text-muted-foreground"
              >
                Filter
              </label>
              <Select value={filter} onValueChange={setFilter}>
                <SelectTrigger id="wiki-timeline-filter" className="w-48">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All commands</SelectItem>
                  {filterOptions.map((key) => (
                    <SelectItem key={key} value={key}>
                      {key}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardHeader>
        {log.isLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner /> Loading…
          </div>
        ) : log.error ? (
          <Alert variant="error">{formatApiError(log.error)}</Alert>
        ) : filtered.length === 0 ? (
          log.entries.length === 0 ? (
            <EmptyState
              icon={Inbox}
              title="No activity yet"
              description="Run !ingest, !compile, !ask, !lint, !trace, or !connect from a DM to populate the log."
            />
          ) : (
            <EmptyState
              icon={Inbox}
              title="No entries match the current filter"
              description="Try a different command or reset to All commands."
            />
          )
        ) : (
          <ol className="divide-y divide-border">
            {filtered.map((entry) => (
              <li
                key={`${entry.lineNumber}-${entry.timestamp}`}
                className="flex flex-col gap-1 py-3 sm:flex-row sm:items-start sm:justify-between"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="blue">{entry.processKey}</Badge>
                  <span className="text-sm text-muted-foreground">
                    {entry.operation}
                  </span>
                  <code className="font-mono text-sm">{entry.relPath}</code>
                </div>
                <time
                  className="text-xs text-muted-foreground"
                  dateTime={entry.timestamp}
                  title={entry.timestamp}
                >
                  {formatTimestamp(entry.timestamp)}
                </time>
              </li>
            ))}
          </ol>
        )}
      </Card>
    </div>
  );
}

function PageHeader({ children }: { children?: React.ReactNode }) {
  return (
    <BasePageHeader
      title="Wiki Timeline"
      description={
        <>
          Wiki activity history and the latest health report from{" "}
          <code>!lint</code>.
        </>
      }
    >
      {children}
    </BasePageHeader>
  );
}

function HealthReportView({ report }: { report: WikiHealthReport }) {
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Badge variant="purple">{report.date}</Badge>
        <code className="text-xs text-muted-foreground">{report.path}</code>
      </div>
      {report.summary.length > 0 && (
        <section>
          <p className="text-sm font-medium text-foreground">Summary</p>
          <ul className="mt-1 ml-5 list-disc space-y-1 text-sm text-muted-foreground">
            {report.summary.map((line, idx) => (
              <li key={idx}>{line}</li>
            ))}
          </ul>
        </section>
      )}
      <section>
        <p className="text-sm font-medium text-foreground">Action items</p>
        {report.actionItems.length === 0 ? (
          <p className="mt-1 text-sm text-muted-foreground">
            No action items in the latest report.
          </p>
        ) : (
          <ul className="mt-1 ml-5 list-disc space-y-1 text-sm text-foreground">
            {report.actionItems.map((line, idx) => (
              <li key={idx}>{line}</li>
            ))}
          </ul>
        )}
      </section>
      <Collapsible>
        <CollapsibleTrigger asChild>
          <Button variant="outline" size="sm">
            View full report
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent className="mt-3">
          <pre className="overflow-x-auto rounded-md border border-border bg-muted p-3 text-xs leading-snug">
            {report.rawBody}
          </pre>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}
