"use client";

/**
 * `/wiki` — wiki browsing index.
 *
 * Lives under My Life in the sidebar (WIKI_BUILDER_DESIGN.md §6 IA
 * split): this is the user's content surface, distinct from
 * `/settings/wiki` which is configuration. The page is structured for
 * day-to-day use:
 *
 *   1. Workspace summary card (root path, mode, counts, last activity)
 *   2. Quick links into Knowledge (Activity timeline + Configuration)
 *   3. Compiled wiki index (`20_wiki/_index.md` rendered as a list)
 *
 * When wiki is disabled (no `active=1` row), the page shows the same
 * "Wiki not enabled" CTA as the bang-command handler (§3.2), pointing
 * at `/settings/wiki` for the opt-in gesture. The sidebar entry is
 * already gated on workspace presence, so disabled users typically
 * arrive here only by deep link or browser history.
 */

import { useMemo } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import {
  BookText,
  Cog,
  History,
  PlusCircle,
} from "lucide-react";
import { api, ApiError } from "@/lib/api-client";
import { formatApiError, formatTimestamp } from "@/lib/utils";
import type { WikiFileResponse, WikiIndexResponse } from "@/lib/api-types";
import {
  useWikiWorkspaces,
  selectActiveWikiWorkspace,
} from "@/lib/hooks/use-wiki-workspaces";
import {
  parseWikiLog,
  sortWikiLogEntries,
  type WikiLogEntry,
} from "@/lib/wiki-timeline";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader as BasePageHeader } from "@/components/ui/page-header";
import { Spinner } from "@/components/ui/spinner";

const WIKI_READ_PROCESS_KEY = "wiki.ask";
const RECENT_ACTIVITY_LIMIT = 8;

export default function WikiPage() {
  const workspacesQuery = useWikiWorkspaces();
  const workspace = selectActiveWikiWorkspace(workspacesQuery.data);
  const enabled = !!workspace;

  const indexQuery = useQuery({
    queryKey: ["wiki-index", workspace?.name],
    enabled,
    queryFn: () =>
      api.get<WikiIndexResponse>(`/wiki/${workspace!.name}/index`, {
        headers: { "x-process-key": WIKI_READ_PROCESS_KEY },
      }),
  });

  const logQuery = useQuery({
    queryKey: ["wiki-log", workspace?.name],
    enabled,
    queryFn: () =>
      api.get<WikiFileResponse>(`/wiki/${workspace!.name}/files/log.md`, {
        headers: { "x-process-key": WIKI_READ_PROCESS_KEY },
      }),
  });

  const recentEntries = useMemo<WikiLogEntry[]>(() => {
    if (!logQuery.data) return [];
    return sortWikiLogEntries(parseWikiLog(logQuery.data.content)).slice(
      0,
      RECENT_ACTIVITY_LIMIT,
    );
  }, [logQuery.data]);

  // `log.md` is absent until the first wiki write — treat 404 as empty.
  const logError =
    logQuery.error instanceof ApiError && logQuery.error.status === 404
      ? null
      : (logQuery.error as Error | null);

  if (workspacesQuery.isLoading) {
    return <div className="p-6 text-sm text-muted-foreground">Loading…</div>;
  }
  if (workspacesQuery.error) {
    return (
      <div className="p-6">
        <Alert variant="error">{formatApiError(workspacesQuery.error)}</Alert>
      </div>
    );
  }

  if (!workspace) {
    return (
      <div className="flex flex-col gap-4 p-6">
        <PageHeader />
        <Card>
          <CardHeader className="items-start">
            <div>
              <CardTitle>Wiki not enabled</CardTitle>
              <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
                Enable a wiki workspace to build a long-form, curated
                knowledge base via <code>!ingest</code>, <code>!compile</code>,
                <code>!ask</code>, <code>!trace</code>, and <code>!connect</code>.
                The wiki is a separate corpus from Knowledge (the
                always-loaded context files) &mdash; it&rsquo;s for
                compounding, broad-scoped notes you grow over time.
              </p>
            </div>
          </CardHeader>
          <div>
            <Button asChild>
              <Link href="/settings/wiki">
                <PlusCircle className="h-4 w-4" /> Enable Wiki
              </Link>
            </Button>
          </div>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 p-6">
      <PageHeader />

      <Card>
        <CardHeader className="items-start">
          <div className="flex w-full flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
            <div className="space-y-1">
              <CardTitle>{workspace.name}</CardTitle>
              <p className="break-all text-sm text-muted-foreground">
                <code>{workspace.rootPath}</code>
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={workspace.kind === "external" ? "purple" : "blue"}>
                {workspace.kind === "external" ? "External" : "Internal"}
              </Badge>
              <Badge variant="gray">{workspace.language}</Badge>
            </div>
          </div>
        </CardHeader>
        <dl className="grid gap-x-4 gap-y-4 text-sm sm:grid-cols-3">
          <div className="space-y-1">
            <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Raw notes
            </dt>
            <dd className="text-foreground">{workspace.stats.rawCount}</dd>
          </div>
          <div className="space-y-1">
            <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Wiki pages
            </dt>
            <dd className="text-foreground">{workspace.stats.wikiCount}</dd>
          </div>
          <div className="space-y-1">
            <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Outputs
            </dt>
            <dd className="text-foreground">{workspace.stats.outputCount}</dd>
          </div>
          <div className="space-y-1">
            <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Last ingest
            </dt>
            <dd className="text-foreground">
              {formatTimestamp(workspace.lastIngestAt)}
            </dd>
          </div>
          <div className="space-y-1">
            <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Last compile
            </dt>
            <dd className="text-foreground">
              {formatTimestamp(workspace.lastCompileAt)}
            </dd>
          </div>
        </dl>
        <div className="mt-6 flex flex-wrap gap-2 border-t border-border pt-4">
          <Button asChild variant="outline" size="sm">
            <Link href="/wiki/timeline">
              <History className="h-4 w-4" /> Timeline &amp; health
            </Link>
          </Button>
          <Button asChild variant="outline" size="sm">
            <Link href="/settings/wiki">
              <Cog className="h-4 w-4" /> Configuration
            </Link>
          </Button>
        </div>
      </Card>

      <Card>
        <CardHeader className="items-start">
          <div>
            <CardTitle>Index</CardTitle>
            <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
              Latest snapshot of <code>20_wiki/_index.md</code>, the
              LLM-maintained catalogue.
            </p>
          </div>
        </CardHeader>
        {indexQuery.isLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner /> Loading…
          </div>
        ) : indexQuery.error ? (
          <Alert variant="error">{formatApiError(indexQuery.error)}</Alert>
        ) : !indexQuery.data?.indexFile.exists ? (
          <p className="text-sm text-muted-foreground">
            No <code>_index.md</code> yet. Run <code>!compile</code> from a
            DM to build one.
          </p>
        ) : (
          <pre className="overflow-x-auto rounded-md border border-border bg-muted p-3 text-xs leading-snug">
            {indexQuery.data.indexFile.content ?? ""}
          </pre>
        )}
      </Card>

      <Card>
        <CardHeader className="items-start">
          <div className="flex w-full flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <CardTitle>Recent activity</CardTitle>
              <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
                Latest entries from <code>log.md</code>. The full timeline
                lives on <code>/wiki/timeline</code>.
              </p>
            </div>
            <Button asChild variant="outline" size="sm">
              <Link href="/wiki/timeline">
                <BookText className="h-4 w-4" /> View full timeline
              </Link>
            </Button>
          </div>
        </CardHeader>
        {logQuery.isLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner /> Loading…
          </div>
        ) : logError ? (
          <Alert variant="error">{formatApiError(logError)}</Alert>
        ) : recentEntries.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No activity yet. Send <code>!ingest</code>, <code>!compile</code>,
            or <code>!ask</code> to a DM to populate the log.
          </p>
        ) : (
          <ol className="divide-y divide-border">
            {recentEntries.map((entry) => (
              <li
                key={`${entry.lineNumber}-${entry.timestamp}`}
                className="flex flex-col gap-1 py-2 sm:flex-row sm:items-start sm:justify-between"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="blue">{entry.processKey}</Badge>
                  <span className="text-sm text-muted-foreground">
                    {entry.operation}
                  </span>
                  <code className="font-mono text-xs">{entry.relPath}</code>
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

function PageHeader() {
  return (
    <BasePageHeader
      title="Wiki"
      description={
        <>
          Your curated, opt-in knowledge base &mdash; separate from
          always-loaded Knowledge. <code>!ingest</code> saves sources to{" "}
          <code>10_raw/</code>; <code>!compile</code> promotes them into{" "}
          <code>20_wiki/</code> pages; <code>!ask</code> / <code>!trace</code> /{" "}
          <code>!connect</code> save answers to <code>30_outputs/</code>.
          Configuration lives in{" "}
          <Link className="underline" href="/settings/wiki">/settings/wiki</Link>.
        </>
      }
    />
  );
}
