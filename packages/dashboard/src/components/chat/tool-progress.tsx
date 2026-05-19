"use client";

import { Check, Loader2 } from "lucide-react";
import type { ToolProgressItem } from "@/lib/hooks/use-chat";

interface ToolProgressProps {
  items: ToolProgressItem[];
}

export function ToolProgress({ items }: ToolProgressProps) {
  if (items.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-2 px-2">
      {items.map((item) => {
        const done = item.status === "done" || item.status === "completed";
        return (
          <div
            key={item.tool}
            className="flex items-center gap-1.5 rounded-md bg-muted px-2.5 py-1 text-xs text-muted-foreground"
          >
            {done ? (
              <Check className="h-3 w-3 text-emerald-500" />
            ) : (
              <Loader2 className="h-3 w-3 animate-spin" />
            )}
            <span>{item.tool}</span>
          </div>
        );
      })}
    </div>
  );
}
