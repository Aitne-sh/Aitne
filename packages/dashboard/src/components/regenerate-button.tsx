"use client";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { RefreshCw, Check, AlertCircle, Loader2 } from "lucide-react";
import type { RegenerateTarget, RegenerateStatus } from "@/lib/hooks/use-regenerate";

interface RegenerateButtonProps {
  target: RegenerateTarget;
  label: string;
  currentTarget: RegenerateTarget | null;
  status: RegenerateStatus;
  error?: string | null;
  onRegenerate: (target: RegenerateTarget) => void;
  onDismiss: () => void;
  variant?: "outline" | "ghost";
  size?: "sm" | "default";
  className?: string;
}

export function RegenerateButton({
  target,
  label,
  currentTarget,
  status,
  error,
  onRegenerate,
  onDismiss,
  variant = "outline",
  size = "sm",
  className,
}: RegenerateButtonProps) {
  const isThisTarget = currentTarget === target;
  const isActive = isThisTarget && status !== "idle";
  const isBusy = status === "triggered" || status === "running";

  if (isThisTarget && status === "done") {
    return (
      <Button
        variant={variant}
        size={size}
        className={cn("text-emerald-600 dark:text-emerald-400", className)}
        onClick={onDismiss}
      >
        <Check className="h-3.5 w-3.5 mr-1.5" />
        Updated
      </Button>
    );
  }

  if (isThisTarget && status === "error") {
    return (
      <span className="inline-flex items-center gap-1.5">
        <Button
          variant={variant}
          size={size}
          className={cn("text-red-600 dark:text-red-400", className)}
          onClick={onDismiss}
        >
          <AlertCircle className="h-3.5 w-3.5 mr-1.5" />
          Failed
        </Button>
        {error && (
          <span className="text-xs text-red-600 dark:text-red-400 max-w-48 truncate">
            {error}
          </span>
        )}
      </span>
    );
  }

  return (
    <Button
      variant={variant}
      size={size}
      onClick={() => onRegenerate(target)}
      disabled={isBusy}
      className={className}
    >
      {isActive ? (
        <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
      ) : (
        <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
      )}
      {isThisTarget && status === "triggered" ? "Triggering..." :
       isThisTarget && status === "running" ? "Running..." :
       label}
    </Button>
  );
}
