"use client";

import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { formatRelativeTime, formatAbsoluteTime, formatCurrency, formatDuration, formatTokens, formatTokenCount } from "@/lib/utils";
import { EVENT_TYPE_COLORS, RESULT_COLORS } from "@/lib/constants";
import { formatShortModelName, modelBadgeVariant, parseModelUsage, pickDisplayModel } from "@/lib/backend-ui";
import type { EventRow as EventRowType } from "@/lib/api-types";

interface EventRowProps {
  event: EventRowType;
  onClick: () => void;
}

export function EventRow({ event, onClick }: EventRowProps) {
  const typeColor = (EVENT_TYPE_COLORS[event.action_type] ?? "gray") as "blue" | "green" | "gray" | "purple" | "amber" | "teal";
  const resultColor = (RESULT_COLORS[event.result] ?? "gray") as "green" | "red" | "amber" | "gray";
  // Prefer the actually-billed model from modelUsage over the requested
  // model_used — the SDK can route opus-4-7 → opus-4-6[1m] silently, and the
  // cost in this row reflects whichever model actually ran.
  const billedModels = parseModelUsage(event.model_usage_json);
  const displayModelId = pickDisplayModel(event.model_used, event.model_usage_json);
  const modelLabel = displayModelId ? formatShortModelName(displayModelId) : null;
  const modelMismatch =
    event.model_used != null
    && billedModels.length > 0
    && billedModels.some((m) => m.modelId !== event.model_used);

  return (
    <tr
      onClick={onClick}
      className="cursor-pointer border-b border-border transition-colors hover:bg-muted/50"
    >
      <td className="px-3 py-2 text-xs font-mono tabular-nums text-muted-foreground whitespace-nowrap">
        <Tooltip>
          <TooltipTrigger>{formatAbsoluteTime(event.started_at)}</TooltipTrigger>
          <TooltipContent>{formatRelativeTime(event.started_at)}</TooltipContent>
        </Tooltip>
      </td>
      <td className="px-3 py-2">
        <Badge variant={typeColor}>{event.action_type}</Badge>
      </td>
      <td className="hidden xl:table-cell px-3 py-2 text-xs text-muted-foreground">{event.trigger}</td>
      <td className="hidden lg:table-cell px-3 py-2">
        {modelLabel && (
          modelMismatch ? (
            <Tooltip>
              <TooltipTrigger>
                <span className="inline-flex items-center gap-1">
                  <Badge variant={modelBadgeVariant(displayModelId)}>{modelLabel}</Badge>
                  <Badge variant="amber" className="text-[10px] uppercase tracking-wide">
                    routed
                  </Badge>
                </span>
              </TooltipTrigger>
              <TooltipContent>
                <div className="space-y-0.5 text-xs font-mono">
                  <div>requested: {formatShortModelName(event.model_used)}</div>
                  {billedModels.map((m) => (
                    <div key={m.modelId}>
                      billed: {formatShortModelName(m.modelId)}
                    </div>
                  ))}
                </div>
              </TooltipContent>
            </Tooltip>
          ) : (
            <Badge variant={modelBadgeVariant(displayModelId)}>{modelLabel}</Badge>
          )
        )}
      </td>
      <td className="hidden xl:table-cell px-3 py-2 text-xs font-mono text-muted-foreground">
        {event.model_used ? (
          <Tooltip>
            <TooltipTrigger>
              {formatTokens(
                event.tokens_input,
                event.tokens_output,
                event.cache_creation_tokens,
                event.cache_read_tokens,
              )}
            </TooltipTrigger>
            <TooltipContent>
              <div className="space-y-0.5 text-xs font-mono">
                <div>fresh in: {formatTokenCount(event.tokens_input)}</div>
                <div>cache write: {formatTokenCount(event.cache_creation_tokens)}</div>
                <div>cache read: {formatTokenCount(event.cache_read_tokens)}</div>
                <div className="border-t border-border pt-0.5 mt-1">
                  out: {formatTokenCount(event.tokens_output)}
                </div>
              </div>
            </TooltipContent>
          </Tooltip>
        ) : null}
      </td>
      <td className="px-3 py-2 text-xs font-mono text-muted-foreground">
        {formatCurrency(event.cost_usd)}
      </td>
      <td className="hidden lg:table-cell px-3 py-2 text-xs font-mono text-muted-foreground">
        {formatDuration(event.duration_ms)}
      </td>
      <td className="px-3 py-2">
        <Badge variant={resultColor}>{event.result}</Badge>
      </td>
    </tr>
  );
}
