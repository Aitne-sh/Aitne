"use client";

import { useMemo, useState } from "react";
import dynamic from "next/dynamic";
import { Boxes, FileText, Filter } from "lucide-react";
import {
  DOMAINS,
  ENTITY_TYPES,
  TYPE_PLURALS,
  type Domain,
  type EntityType,
} from "@aitne/shared";
import { ApiError } from "@/lib/api-client";
import { useContextFile } from "@/lib/hooks/use-context";
import {
  useEntitiesByDomainTypeDate,
  useEntitiesBySource,
  type EntityRecord,
} from "@/lib/hooks/use-entities";
import { useManagedTasks } from "@/lib/hooks/use-managed-tasks";
import { extractSources } from "@/lib/sources";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ScrollArea } from "@/components/ui/scroll-area";
import { EmptyState } from "@/components/shared/empty-state";
import { QueryResult } from "@/components/shared/query-result";
import { cn, formatRelativeTime } from "@/lib/utils";

const RenderedMarkdown = dynamic(
  () =>
    import("@/components/knowledge/rendered-markdown").then(
      (m) => m.RenderedMarkdown,
    ),
  {
    ssr: false,
    loading: () => (
      <div className="space-y-2 py-2">
        {Array.from({ length: 5 }).map((_, i) => (
          <div
            key={i}
            className="h-4 animate-pulse rounded bg-muted/30"
            style={{ width: `${65 + ((i * 11) % 30)}%` }}
          />
        ))}
      </div>
    ),
  },
);

/**
 * Memory → Entities (docs/design/21-management-registry-and-entities.md
 * §7.6 — entity-mirror keyed off the `entities` SQLite table).
 *
 * Two filter modes mirror the `/api/entities` lookup contract:
 *   1. By Source → tier-1 bias query (`source=<app>` alone).
 *   2. By Domain/Type/Date → tier-2 fuzzy match.
 *
 * Selecting a row opens the underlying L2 file via the existing
 * context-file API. The mirror is non-authoritative (§7.6 ADR); the
 * file content is what the agent actually reads.
 */

type FilterMode = "source" | "domain";

export function EntitiesContent() {
  const [mode, setMode] = useState<FilterMode>("source");

  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      <Card className="p-3">
        <div className="flex items-center gap-3">
          <Filter className="h-4 w-4 shrink-0 text-muted-foreground" />
          <div className="flex items-center gap-1 rounded-md border border-border bg-background p-0.5">
            <button
              type="button"
              onClick={() => setMode("source")}
              className={cn(
                "rounded px-2.5 py-1 text-xs transition-colors",
                mode === "source"
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              By source
            </button>
            <button
              type="button"
              onClick={() => setMode("domain")}
              className={cn(
                "rounded px-2.5 py-1 text-xs transition-colors",
                mode === "domain"
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              By domain
            </button>
          </div>
        </div>
      </Card>
      {mode === "source" ? <BySourceBrowser /> : <ByDomainBrowser />}
    </div>
  );
}

// ── By source ─────────────────────────────────────────────────────────────

function BySourceBrowser() {
  const tasks = useManagedTasks();
  const sources = useMemo(() => extractSources(tasks.data?.items), [
    tasks.data,
  ]);
  const [selectedSource, setSelectedSource] = useState<string | null>(null);
  const effectiveSource =
    selectedSource ?? (sources[0]?.normalized ?? null);
  const entities = useEntitiesBySource(effectiveSource, 200);

  return (
    <BrowserLayout
      sidebar={
        <Card className="flex h-full min-h-0 flex-col p-3">
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Sources
          </h3>
          <QueryResult
            isLoading={tasks.isLoading}
            isError={tasks.isError}
            error={tasks.error as Error | null}
            onRetry={() => tasks.refetch()}
          >
            {sources.length === 0 ? (
              <EmptyState
                icon={Boxes}
                title="No sources"
                description="Register a managed task first."
              />
            ) : (
              <ScrollArea className="min-h-0 flex-1">
                <ul className="space-y-0.5">
                  {sources.map((source) => {
                    const active = source.normalized === effectiveSource;
                    return (
                      <li key={source.normalized}>
                        <button
                          type="button"
                          onClick={() => setSelectedSource(source.normalized)}
                          className={cn(
                            "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors",
                            active
                              ? "bg-primary/10 text-primary font-medium"
                              : "text-muted-foreground hover:bg-accent hover:text-foreground",
                          )}
                        >
                          <span className="flex-1 truncate">
                            {source.label}
                          </span>
                          <Badge variant="gray" className="shrink-0">
                            {source.count}
                          </Badge>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </ScrollArea>
            )}
          </QueryResult>
        </Card>
      }
      content={
        <EntityResultsPane
          query={entities}
          emptyTitle="No entities tagged yet"
          emptyDescription="Once the scheduled-managed-task skill runs, entity files appear here."
        />
      }
    />
  );
}

// ── By domain/type/date ───────────────────────────────────────────────────

function ByDomainBrowser() {
  const today = useMemo(() => new Date().toISOString().slice(0, 10), []);
  const [domain, setDomain] = useState<Domain>("work");
  const [type, setType] = useState<EntityType>("meeting");
  const [date, setDate] = useState(today);
  const [q, setQ] = useState("");

  const entities = useEntitiesByDomainTypeDate({
    domain,
    type,
    date,
    q: q.trim() ? q.trim() : undefined,
    limit: 100,
  });

  return (
    <BrowserLayout
      sidebar={
        <Card className="flex h-full min-h-0 flex-col gap-3 p-3">
          <div className="space-y-1.5">
            <label className="text-xs font-medium" htmlFor="filter-domain">
              Domain
            </label>
            <Select
              value={domain}
              onValueChange={(v) => setDomain(v as Domain)}
            >
              <SelectTrigger id="filter-domain" className="h-8 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DOMAINS.map((d) => (
                  <SelectItem key={d} value={d}>
                    {d}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium" htmlFor="filter-type">
              Type
            </label>
            <Select
              value={type}
              onValueChange={(v) => setType(v as EntityType)}
            >
              <SelectTrigger id="filter-type" className="h-8 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ENTITY_TYPES.map((t) => (
                  <SelectItem key={t} value={t}>
                    {TYPE_PLURALS[t]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium" htmlFor="filter-date">
              Date
            </label>
            <Input
              id="filter-date"
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium" htmlFor="filter-q">
              Title contains
            </label>
            <Input
              id="filter-q"
              type="search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="optional"
            />
          </div>
        </Card>
      }
      content={
        <EntityResultsPane
          query={entities}
          emptyTitle="No matches"
          emptyDescription={`No entities under ${domain}/${TYPE_PLURALS[type]} on ${date}.`}
        />
      }
    />
  );
}

// ── Layout + result list ──────────────────────────────────────────────────

function BrowserLayout({
  sidebar,
  content,
}: {
  sidebar: React.ReactNode;
  content: React.ReactNode;
}) {
  return (
    <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 md:grid-cols-[18rem_1fr]">
      {sidebar}
      {content}
    </div>
  );
}

interface EntitiesQueryLike {
  data?: { items: EntityRecord[] } | undefined;
  isLoading: boolean;
  isError: boolean;
  error: Error | null;
  refetch: () => unknown;
}

function EntityResultsPane({
  query,
  emptyTitle,
  emptyDescription,
}: {
  query: EntitiesQueryLike;
  emptyTitle: string;
  emptyDescription: string;
}) {
  const [selectedPath, setSelectedPath] = useState<string | null>(null);

  return (
    <Card className="flex h-full min-h-0 flex-col p-0">
      <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-2">
        <div className="flex min-h-0 flex-col border-b border-border md:border-b-0 md:border-r">
          <div className="border-b border-border px-3 py-2 text-[11px] uppercase tracking-wide text-muted-foreground">
            Results {query.data ? `(${query.data.items.length})` : ""}
          </div>
          <div className="min-h-0 flex-1">
            <QueryResult
              isLoading={query.isLoading}
              isError={query.isError}
              error={query.error}
              onRetry={() => query.refetch()}
            >
              {!query.data || query.data.items.length === 0 ? (
                <EmptyState
                  icon={Boxes}
                  title={emptyTitle}
                  description={emptyDescription}
                />
              ) : (
                <ScrollArea className="h-full">
                  <ul className="divide-y divide-border/40">
                    {query.data.items.map((entity) => (
                      <li key={entity.path}>
                        <button
                          type="button"
                          onClick={() => setSelectedPath(entity.path)}
                          className={cn(
                            "flex w-full flex-col gap-0.5 px-3 py-2 text-left text-sm transition-colors",
                            selectedPath === entity.path
                              ? "bg-primary/10 text-primary"
                              : "hover:bg-accent",
                          )}
                        >
                          <span className="flex items-start gap-2">
                            <FileText className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                            <span className="flex-1 truncate font-medium">
                              {entity.title}
                            </span>
                            {entity.status && (
                              <Badge variant="gray" className="shrink-0">
                                {entity.status}
                              </Badge>
                            )}
                          </span>
                          <span className="ml-5 truncate text-[11px] text-muted-foreground">
                            <code>{entity.path}</code>
                          </span>
                          {Object.keys(entity.sources).length > 0 && (
                            <span className="ml-5 flex flex-wrap gap-1">
                              {Object.keys(entity.sources).map((key) => (
                                <Badge
                                  key={key}
                                  variant="blue"
                                  className="text-[10px]"
                                >
                                  {key}
                                </Badge>
                              ))}
                            </span>
                          )}
                        </button>
                      </li>
                    ))}
                  </ul>
                </ScrollArea>
              )}
            </QueryResult>
          </div>
        </div>
        <div className="flex min-h-0 flex-col">
          {selectedPath ? (
            <EntityFilePanel path={selectedPath} />
          ) : (
            <EmptyState
              icon={FileText}
              title="No entity selected"
              description="Pick a result on the left to view the underlying MD file."
              className="py-8"
            />
          )}
        </div>
      </div>
    </Card>
  );
}

function EntityFilePanel({ path }: { path: string }) {
  // Strip the .md suffix (the context API accepts either form, but the
  // canonical key matches without it — keeps the cache aligned with
  // useContextList consumers).
  const contextPath = path.endsWith(".md") ? path.slice(0, -3) : path;
  const file = useContextFile(contextPath);

  if (file.isLoading) {
    return (
      <div className="space-y-2 p-4">
        {Array.from({ length: 5 }).map((_, i) => (
          <div
            key={i}
            className="h-4 animate-pulse rounded bg-muted/30"
            style={{ width: `${50 + ((i * 11) % 30)}%` }}
          />
        ))}
      </div>
    );
  }

  if (file.error) {
    const status = (file.error as ApiError | undefined)?.status;
    if (status === 404) {
      return (
        <EmptyState
          icon={FileText}
          title="Mirror is stale"
          description={`The entity file at ${path} was deleted but the mirror still has the row. The watcher should reconcile shortly.`}
        />
      );
    }
    return (
      <p className="p-4 text-sm text-destructive">
        Failed to load: {(file.error as Error).message}
      </p>
    );
  }

  if (!file.data) return null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b border-border px-3 py-2">
        <code className="font-mono text-[11px] text-muted-foreground">
          {path}
        </code>
        <p className="text-[11px] text-muted-foreground/70">
          Last modified {formatRelativeTime(file.data.lastModified)}
        </p>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="p-4">
          <RenderedMarkdown content={file.data.content} />
        </div>
      </ScrollArea>
    </div>
  );
}

