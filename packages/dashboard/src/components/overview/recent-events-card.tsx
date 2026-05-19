"use client";

import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { formatShortDateTime, formatAbsoluteTime, formatRelativeTime, formatCurrency, parseUtcDate } from "@/lib/utils";
import { EVENT_TYPE_COLORS, RESULT_COLORS } from "@/lib/constants";
import { formatShortModelName, modelBadgeVariant } from "@/lib/backend-ui";
import { useEventStream } from "@/lib/hooks/use-event-stream";
import { useEvents } from "@/lib/hooks/use-events";
import type { EventRow } from "@/lib/api-types";

export function RecentEventsCard() {
  const streamEvents = useEventStream(10);
  const { data } = useEvents();
  const apiEvents = data?.pages[0]?.events.slice(0, 10) ?? [];

  // Merge + dedup + sort by timestamp (newest first)
  const seen = new Set<number>();
  const deduped: EventRow[] = [];
  for (const e of [...streamEvents, ...apiEvents]) {
    if (!seen.has(e.id)) {
      seen.add(e.id);
      deduped.push(e);
    }
  }
  const merged = deduped
    .sort((a, b) => parseUtcDate(b.started_at).getTime() - parseUtcDate(a.started_at).getTime())
    .slice(0, 10);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Recent Events</CardTitle>
        <Link
          href="/activity"
          className="flex items-center gap-1 text-xs text-primary hover:underline"
        >
          View all <ArrowRight className="h-3 w-3" />
        </Link>
      </CardHeader>
      <div className="space-y-2">
        {merged.length === 0 && (
          <p className="text-sm text-muted-foreground">No events yet</p>
        )}
        {merged.map((event) => {
          const typeColor = EVENT_TYPE_COLORS[event.action_type] ?? "gray";
          const resultColor = RESULT_COLORS[event.result] ?? "gray";
          const modelColor = event.model_used
            ? modelBadgeVariant(event.model_used)
            : undefined;

          return (
            <div key={event.id} className="flex items-center gap-2 text-xs">
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="w-24 shrink-0 font-mono tabular-nums text-muted-foreground">
                    {formatShortDateTime(event.started_at)}
                  </span>
                </TooltipTrigger>
                <TooltipContent>
                  {formatAbsoluteTime(event.started_at)} ({formatRelativeTime(event.started_at)})
                </TooltipContent>
              </Tooltip>
              <Badge variant={typeColor as "blue" | "green" | "amber" | "gray"} className="shrink-0">
                {event.action_type.split(".").pop()}
              </Badge>
              {modelColor && modelColor !== "gray" && (
                <Badge variant={modelColor} className="shrink-0">
                  {formatShortModelName(event.model_used)}
                </Badge>
              )}
              <span className="ml-auto font-mono text-muted-foreground">
                {formatCurrency(event.cost_usd)}
              </span>
              <Badge variant={resultColor as "green" | "red" | "amber" | "gray"} className="shrink-0">
                {event.result}
              </Badge>
            </div>
          );
        })}
      </div>
    </Card>
  );
}
