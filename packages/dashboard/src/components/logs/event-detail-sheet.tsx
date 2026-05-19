"use client";

import { useState } from "react";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Badge } from "@/components/ui/badge";
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from "@/components/ui/collapsible";
import { formatAbsoluteTime, formatCurrency, formatDuration, formatTokenCount } from "@/lib/utils";
import { RESULT_COLORS } from "@/lib/constants";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { parseModelUsage } from "@/lib/backend-ui";
import type { EventRow } from "@/lib/api-types";
import { DocsLearnMore } from "@/components/docs/docs-learn-more";
import { docIdForEventType } from "@/lib/docs/event-type-doc-map";

interface EventDetailSheetProps {
  event: EventRow | null;
  onClose: () => void;
}

export function EventDetailSheet({ event, onClose }: EventDetailSheetProps) {
  // Keep the Sheet root mounted so Radix observes the open→closed transition
  // and clears its body pointer-events lock. Unmounting the Sheet while open
  // skips that cleanup and freezes clicks (including the tab switcher).
  return (
    <Sheet open={!!event} onOpenChange={(open) => !open && onClose()}>
      {event && <EventDetailSheetContent event={event} />}
    </Sheet>
  );
}

function EventDetailSheetContent({ event }: { event: EventRow }) {
  const [detailOpen, setDetailOpen] = useState(false);

  const resultColor = (RESULT_COLORS[event.result] ?? "gray") as "green" | "red" | "amber" | "gray";

  let formattedDetail: string | null = null;
  if (event.detail) {
    try {
      formattedDetail = JSON.stringify(JSON.parse(event.detail), null, 2);
    } catch {
      formattedDetail = event.detail;
    }
  }

  return (
    <SheetContent className="flex flex-col">
        <SheetHeader>
          <SheetTitle>Event Detail</SheetTitle>
        </SheetHeader>
        <div className="mt-4 flex-1 space-y-4 overflow-y-auto pr-2 -mr-2">
          <DetailRow label="Event ID">
            <code className="font-mono text-xs">{event.event_id}</code>
          </DetailRow>
          <DetailRow label="Type">
            <div className="flex items-center justify-end gap-2">
              <Badge variant="blue">{event.action_type}</Badge>
              {(() => {
                const docId = docIdForEventType(event.action_type);
                return docId ? (
                  <DocsLearnMore docId={docId} label="Learn →" />
                ) : null;
              })()}
            </div>
          </DetailRow>
          <DetailRow label="Trigger">
            <span className="text-sm">{event.trigger}</span>
          </DetailRow>
          <DetailRow label="Result">
            <Badge variant={resultColor}>{event.result}</Badge>
          </DetailRow>
          <DetailRow label="Started">
            <span className="text-sm">{formatAbsoluteTime(event.started_at)}</span>
          </DetailRow>
          {event.completed_at && (
            <DetailRow label="Completed">
              <span className="text-sm">{formatAbsoluteTime(event.completed_at)}</span>
            </DetailRow>
          )}
          <DetailRow label="Duration">
            <span className="text-sm font-mono">{formatDuration(event.duration_ms)}</span>
          </DetailRow>
          {(() => {
            const billed = parseModelUsage(event.model_usage_json);
            // When the SDK billed exactly the model we requested, the
            // requested/billed distinction is noise — collapse to one row.
            const sameAsRequested =
              billed.length === 1
              && billed[0]?.modelId === event.model_used;
            if (billed.length === 0 || sameAsRequested) {
              return (
                <DetailRow label="Model">
                  <span className="text-sm">{event.model_used ?? "—"}</span>
                </DetailRow>
              );
            }
            return (
              <>
                <DetailRow label="Model (requested)">
                  <span className="text-sm">{event.model_used ?? "—"}</span>
                </DetailRow>
                <DetailRow label="Model (billed)">
                  <div className="space-y-0.5 text-right">
                    {billed.map((m) => (
                      <div key={m.modelId} className="text-sm font-mono">
                        {m.modelId}
                        <span className="ml-2 text-xs text-muted-foreground">
                          ({formatCurrency(m.costUsd)})
                        </span>
                      </div>
                    ))}
                  </div>
                </DetailRow>
              </>
            );
          })()}
          {event.model_used && (
            <>
              <DetailRow label="Input (fresh)">
                <span className="text-sm font-mono">{formatTokenCount(event.tokens_input)}</span>
              </DetailRow>
              <DetailRow label="Input (cache write)">
                <span className="text-sm font-mono">{formatTokenCount(event.cache_creation_tokens)}</span>
              </DetailRow>
              <DetailRow label="Input (cache read)">
                <span className="text-sm font-mono">{formatTokenCount(event.cache_read_tokens)}</span>
              </DetailRow>
              <DetailRow label="Input total">
                <span className="text-sm font-mono">
                  {formatTokenCount(
                    (event.tokens_input ?? 0)
                    + (event.cache_creation_tokens ?? 0)
                    + (event.cache_read_tokens ?? 0),
                  )}
                </span>
              </DetailRow>
              <DetailRow label="Output">
                <span className="text-sm font-mono">{formatTokenCount(event.tokens_output)}</span>
              </DetailRow>
            </>
          )}
          <DetailRow label="Turns">
            <span className="text-sm font-mono">{event.num_turns}</span>
          </DetailRow>
          <DetailRow label="Cost">
            <span className="text-sm font-mono">{formatCurrency(event.cost_usd)}</span>
          </DetailRow>

          {formattedDetail && (
            <Collapsible open={detailOpen} onOpenChange={setDetailOpen}>
              <CollapsibleTrigger className="flex w-full items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
                Detail
                <ChevronDown className={cn("h-3 w-3 transition-transform", detailOpen && "rotate-180")} />
              </CollapsibleTrigger>
              <CollapsibleContent>
                <pre className="mt-2 max-h-64 overflow-auto rounded-md bg-muted p-3 text-xs font-mono">
                  {formattedDetail}
                </pre>
              </CollapsibleContent>
            </Collapsible>
          )}

          {event.error && (
            <div className="rounded-lg bg-red-50 p-3 dark:bg-red-950">
              <p className="text-xs font-medium text-red-700 dark:text-red-300">Error</p>
              <pre className="mt-1 whitespace-pre-wrap text-xs text-red-600 dark:text-red-400">
                {event.error}
              </pre>
            </div>
          )}
        </div>
      </SheetContent>
  );
}

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <span className="shrink-0 text-sm text-muted-foreground">{label}</span>
      <div className="text-right">{children}</div>
    </div>
  );
}
