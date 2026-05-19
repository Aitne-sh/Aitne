"use client";

import { AlertCircle, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface QueryResultProps {
  isLoading: boolean;
  isError: boolean;
  error?: Error | null;
  onRetry?: () => void;
  /** Content to show while loading. Defaults to centered spinner. */
  skeleton?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}

function DefaultSkeleton() {
  return (
    <div className="flex items-center justify-center py-16">
      <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
    </div>
  );
}

function ErrorBanner({
  error,
  onRetry,
}: {
  error?: Error | null;
  onRetry?: () => void;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-16">
      <div className="flex items-center gap-2 text-destructive">
        <AlertCircle className="h-5 w-5" />
        <p className="text-sm font-medium">Failed to load data</p>
      </div>
      {error?.message && (
        <p className="max-w-md text-center text-xs text-muted-foreground">
          {error.message}
        </p>
      )}
      {onRetry && (
        <Button variant="outline" size="sm" onClick={onRetry}>
          Retry
        </Button>
      )}
    </div>
  );
}

export function QueryResult({
  isLoading,
  isError,
  error,
  onRetry,
  skeleton,
  className,
  children,
}: QueryResultProps) {
  if (isLoading) {
    return (
      <div className={cn(className)}>
        {skeleton ?? <DefaultSkeleton />}
      </div>
    );
  }

  if (isError) {
    return (
      <div className={cn(className)}>
        <ErrorBanner error={error} onRetry={onRetry} />
      </div>
    );
  }

  return <>{children}</>;
}

/** Skeleton placeholder for stat cards */
export function CardSkeleton({ count = 3 }: { count?: number }) {
  const gridCols =
    count <= 2 ? "grid-cols-1 md:grid-cols-2"
    : count === 4 ? "grid-cols-2 md:grid-cols-4"
    : "grid-cols-1 md:grid-cols-3";

  return (
    <div className={cn("grid gap-4", gridCols)}>
      {Array.from({ length: count }).map((_, i) => (
        <div
          key={i}
          className="h-28 animate-pulse rounded-xl border border-border bg-muted/30"
        />
      ))}
    </div>
  );
}

/** Skeleton placeholder for tables */
export function TableSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div className="space-y-2">
      <div className="h-10 animate-pulse rounded-lg bg-muted/40" />
      {Array.from({ length: rows }).map((_, i) => (
        <div
          key={i}
          className="h-12 animate-pulse rounded-lg bg-muted/20"
        />
      ))}
    </div>
  );
}
