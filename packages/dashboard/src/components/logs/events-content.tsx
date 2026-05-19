"use client";

import { useState } from "react";
import { useEvents } from "@/lib/hooks/use-events";
import { useEventStream } from "@/lib/hooks/use-event-stream";
import { EventFilters } from "@/components/logs/event-filters";
import { EventRow } from "@/components/logs/event-row";
import { EventDetailSheet } from "@/components/logs/event-detail-sheet";
import { EmptyState } from "@/components/shared/empty-state";
import { DocsLearnMore } from "@/components/docs/docs-learn-more";
import { QueryResult, TableSkeleton } from "@/components/shared/query-result";
import { Button } from "@/components/ui/button";
import { Activity } from "lucide-react";
import type { EventRow as EventRowType } from "@/lib/api-types";

const DATE_RANGE_DAYS: Record<string, string> = {
  today: "1",
  "7d": "7",
  "30d": "30",
};

export function EventsContent({ enabled }: { enabled: boolean }) {
  const [type, setType] = useState("all");
  const [result, setResult] = useState("all");
  const [dateRange, setDateRange] = useState("today");
  const [live, setLive] = useState(true);
  const [selectedEvent, setSelectedEvent] = useState<EventRowType | null>(null);

  const filters = {
    type: type === "all" ? undefined : type,
    result: result === "all" ? undefined : result,
    days: DATE_RANGE_DAYS[dateRange],
  };

  const { data, fetchNextPage, hasNextPage, isFetchingNextPage, isLoading, isError, error, refetch, isRefetching } = useEvents(
    filters,
    { enabled },
  );
  const streamEvents = useEventStream(live && enabled ? 50 : 0);

  // Merge stream events with paginated events (dedup by id, sorted newest first)
  const allApiEvents = data?.pages.flatMap((p) => p.events) ?? [];
  const seen = new Set<number>();
  const merged: EventRowType[] = [];

  if (live && enabled) {
    for (const e of streamEvents) {
      if (seen.has(e.id)) continue;
      if (filters.type && e.action_type !== filters.type) continue;
      if (filters.result && e.result !== filters.result) continue;
      seen.add(e.id);
      merged.push(e);
    }
  }
  for (const e of allApiEvents) {
    if (!seen.has(e.id)) {
      seen.add(e.id);
      merged.push(e);
    }
  }

  return (
    <div className="space-y-6">
      <EventFilters
        type={type}
        onTypeChange={setType}
        result={result}
        onResultChange={setResult}
        dateRange={dateRange}
        onDateRangeChange={setDateRange}
        live={live}
        onLiveToggle={() => setLive(!live)}
        onRefresh={() => refetch()}
        isRefreshing={isRefetching}
      />

      <QueryResult
        isLoading={isLoading}
        isError={isError}
        error={error}
        onRetry={() => refetch()}
        skeleton={<TableSkeleton rows={8} />}
      >
        {merged.length === 0 ? (
          <EmptyState
            icon={Activity}
            title="No events found"
            description="Events will appear here as the agent processes tasks"
          >
            <div className="mt-4">
              <DocsLearnMore docId="features/operations/activity-and-conversations" />
            </div>
          </EmptyState>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-border">
            <table className="w-full text-left" aria-label="Agent events">
              <thead>
                <tr className="border-b border-border bg-muted/50">
                  <th className="px-3 py-2 text-xs font-medium text-muted-foreground">Time</th>
                  <th className="px-3 py-2 text-xs font-medium text-muted-foreground">Type</th>
                  <th className="hidden xl:table-cell px-3 py-2 text-xs font-medium text-muted-foreground">Trigger</th>
                  <th className="hidden lg:table-cell px-3 py-2 text-xs font-medium text-muted-foreground">Model</th>
                  <th className="hidden xl:table-cell px-3 py-2 text-xs font-medium text-muted-foreground">In / Out</th>
                  <th className="px-3 py-2 text-xs font-medium text-muted-foreground">Cost</th>
                  <th className="hidden lg:table-cell px-3 py-2 text-xs font-medium text-muted-foreground">Duration</th>
                  <th className="px-3 py-2 text-xs font-medium text-muted-foreground">Result</th>
                </tr>
              </thead>
              <tbody>
                {merged.map((event) => (
                  <EventRow
                    key={event.id}
                    event={event}
                    onClick={() => setSelectedEvent(event)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}

        {hasNextPage && (
          <div className="flex justify-center">
            <Button
              variant="outline"
              onClick={() => fetchNextPage()}
              disabled={isFetchingNextPage}
            >
              {isFetchingNextPage ? "Loading..." : "Load More"}
            </Button>
          </div>
        )}
      </QueryResult>

      <EventDetailSheet event={selectedEvent} onClose={() => setSelectedEvent(null)} />
    </div>
  );
}
