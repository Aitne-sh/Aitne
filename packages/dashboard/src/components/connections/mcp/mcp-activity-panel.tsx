"use client";

import { ChevronDown, Clock } from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { useMcpActivity, type McpToolCallEntry } from "@/lib/hooks/use-mcp";

function formatAgo(ts: number): string {
  const seconds = Math.max(1, Math.round((Date.now() - ts) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86400)}d ago`;
}

function CallRow({ call }: { call: McpToolCallEntry }) {
  return (
    <li className="flex items-start gap-2 text-xs py-0.5">
      <span
        className={
          call.ok === true
            ? "text-success shrink-0"
            : call.ok === false
              ? "text-destructive shrink-0"
              : "text-muted-foreground shrink-0"
        }
        aria-label={call.ok === true ? "success" : call.ok === false ? "error" : "invocation recorded"}
      >
        {call.ok === true ? "✓" : call.ok === false ? "✗" : "·"}
      </span>
      <div className="min-w-0 flex-1">
        <code className="text-foreground">{call.toolName}</code>
        {call.eventType && (
          <span className="ml-1.5 text-muted-foreground text-[10px]">
            via {call.eventType}
          </span>
        )}
        {call.error && (
          <p className="text-destructive text-[10px] truncate">{call.error}</p>
        )}
      </div>
      <div className="flex flex-col items-end shrink-0 tabular-nums text-[10px] text-muted-foreground">
        <span>{formatAgo(call.calledAt)}</span>
        {call.durationMs != null && (
          <span>{call.durationMs}ms</span>
        )}
      </div>
    </li>
  );
}

/**
 * Collapsible recent-activity panel for an MCP server.
 *
 * Reads from GET /api/mcp/servers/:id/activity (read-tier). Each row
 * represents one tool invocation observed in the agent stream. `ok` is null
 * for most rows today because success/failure matching is deferred; the
 * dot is grey in that case.
 */
export function McpActivityPanel({ serverId }: { serverId: string }) {
  const query = useMcpActivity(serverId, 15);

  const calls = query.data?.calls ?? [];
  const loading = query.isLoading;

  return (
    <Collapsible>
      <CollapsibleTrigger className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground mt-2">
        <Clock className="h-3 w-3" />
        Recent activity
        {calls.length > 0 && (
          <span className="text-[10px] text-muted-foreground">({calls.length})</span>
        )}
        <ChevronDown className="h-3 w-3" />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mt-1 rounded bg-muted/50 p-2">
          {loading && (
            <p className="text-xs text-muted-foreground">Loading…</p>
          )}
          {!loading && calls.length === 0 && (
            <p className="text-xs text-muted-foreground italic">
              No tool calls recorded yet.
            </p>
          )}
          {calls.length > 0 && (
            <ul className="space-y-0.5">
              {calls.map((call) => (
                <CallRow key={call.id} call={call} />
              ))}
            </ul>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
