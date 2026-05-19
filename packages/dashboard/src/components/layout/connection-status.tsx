"use client";

import { cn } from "@/lib/utils";
import { useSSE } from "@/providers/sse-provider";

export function ConnectionStatus({ collapsed }: { collapsed: boolean }) {
  const { connected } = useSSE();

  return (
    <div
      className={cn(
        "flex items-center gap-2 rounded-lg px-3 py-2 text-xs text-muted-foreground",
        collapsed && "justify-center px-0",
      )}
    >
      <span
        className={cn(
          "h-2 w-2 shrink-0 rounded-full",
          connected ? "bg-emerald-500 animate-pulse" : "bg-red-500",
        )}
      />
      {!collapsed && <span>{connected ? "Live Updates On" : "Live Updates Off"}</span>}
    </div>
  );
}
