"use client";

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export interface ConnectionsSectionHeaderProps {
  title: string;
  description?: ReactNode;
  /** Number of entries that are live/healthy. */
  healthy: number;
  /** Total entries in this section. */
  total: number;
  /** Optional short note about the remainder, e.g. "WhatsApp needs re-pairing". */
  attention?: string | null;
  /** Optional right-aligned action element (e.g. an "Add" button). */
  actions?: ReactNode;
}

export function ConnectionsSectionHeader({
  title,
  description,
  healthy,
  total,
  attention,
  actions,
}: ConnectionsSectionHeaderProps) {
  const allHealthy = total > 0 && healthy === total;
  const noneHealthy = total > 0 && healthy === 0;

  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between gap-3">
        <h1 className="text-2xl font-semibold text-foreground">{title}</h1>
        <div className="flex items-center gap-3">
          {total > 0 && (
            <span
              className={cn(
                "text-xs font-medium tabular-nums",
                allHealthy
                  ? "text-success"
                  : noneHealthy
                    ? "text-muted-foreground"
                    : "text-warning",
              )}
            >
              {healthy}/{total} connected
            </span>
          )}
          {actions}
        </div>
      </div>
      {description && (
        <p className="max-w-3xl text-sm text-muted-foreground">{description}</p>
      )}
      {attention && (
        <p className="text-xs text-warning">
          {attention}
        </p>
      )}
    </div>
  );
}
