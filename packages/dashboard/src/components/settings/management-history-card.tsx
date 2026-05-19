"use client";

import { useMemo } from "react";
import { History as HistoryIcon } from "lucide-react";
import { useManagementHistory } from "@/lib/hooks/use-managed-tasks";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/shared/empty-state";
import { QueryResult } from "@/components/shared/query-result";
import {
  formatAbsoluteTime,
  formatRelativeTime,
} from "@/lib/utils";
import {
  KIND_BADGE,
  KIND_LABEL,
  renderSummary,
} from "./management-history-card.logic";

/**
 * Settings → Management — History tab (docs/design/21-management-
 * registry-and-entities.md §14.1).
 *
 * Reads `agent_actions` rows where action_type LIKE 'management_task.%'
 * OR 'sot_binding.%'. The aggregation lives in the daemon at
 * `GET /api/management-history` so the dashboard does not have to
 * issue four parallel /events queries.
 */

export function ManagementHistoryCard({ limit = 50 }: { limit?: number }) {
  const query = useManagementHistory(limit);

  // Flatten the cursor-paginated pages into a single ordered list. Pages
  // are inserted in fetch order and the route already returns rows in
  // `id DESC`, so concat preserves that order across "Load more" calls.
  const events = useMemo(
    () => query.data?.pages.flatMap((p) => p.events) ?? [],
    [query.data],
  );

  return (
    <Card className="space-y-4">
      <CardHeader className="p-0">
        <div>
          <CardTitle className="text-base">History</CardTitle>
          <p className="mt-1 text-xs text-muted-foreground max-w-prose">
            Recent changes to managed tasks (Section B) and SoT bindings
            (Section A). Sourced from <code>agent_actions</code> — the
            authoritative audit trail per §15.
          </p>
        </div>
      </CardHeader>

      <QueryResult
        isLoading={query.isLoading}
        isError={query.isError}
        error={query.error as Error | null}
        onRetry={() => query.refetch()}
      >
        {events.length === 0 ? (
          <EmptyState
            icon={HistoryIcon}
            title="No history yet"
            description="Register or modify a managed task to see entries here."
          />
        ) : (
          <>
            <ol className="space-y-2">
              {events.map((event) => {
                const detail = event.detail as Record<string, unknown> | null;
                const mtId =
                  detail && typeof detail.mt_id === "string"
                    ? (detail.mt_id as string)
                    : null;
                const summary = renderSummary(event.kind, detail);
                return (
                  <li
                    key={event.id}
                    className="flex items-start gap-3 rounded-md border border-border/40 px-3 py-2 text-xs"
                  >
                    <Badge
                      variant={KIND_BADGE[event.kind] ?? "gray"}
                      className="mt-0.5 shrink-0"
                    >
                      {KIND_LABEL[event.kind] ?? event.kind}
                    </Badge>
                    <div className="flex-1 space-y-0.5">
                      {mtId && (
                        <code className="font-mono text-[11px]">{mtId}</code>
                      )}
                      {summary && (
                        <p className="text-foreground/90">{summary}</p>
                      )}
                    </div>
                    {event.startedAt && (
                      <span
                        className="shrink-0 text-[11px] text-muted-foreground"
                        title={formatAbsoluteTime(event.startedAt)}
                      >
                        {formatRelativeTime(event.startedAt)}
                      </span>
                    )}
                  </li>
                );
              })}
            </ol>
            {query.hasNextPage && (
              <div className="flex justify-center pt-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => void query.fetchNextPage()}
                  disabled={query.isFetchingNextPage}
                >
                  {query.isFetchingNextPage ? "Loading…" : "Load more"}
                </Button>
              </div>
            )}
          </>
        )}
      </QueryResult>
    </Card>
  );
}
