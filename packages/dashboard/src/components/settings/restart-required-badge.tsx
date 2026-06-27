"use client";

import { RotateCcw } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

/**
 * Inline badge shown next to field labels whose config key requires
 * a daemon restart after saving.
 */
export function RestartRequiredBadge() {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex items-center gap-0.5 rounded-sm bg-warning/15 px-1 py-0.5 text-[10px] font-medium text-warning">
          <RotateCcw className="h-2.5 w-2.5" />
          restart
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-[220px] text-xs">
        Changing this value requires a daemon restart to take effect.
      </TooltipContent>
    </Tooltip>
  );
}
