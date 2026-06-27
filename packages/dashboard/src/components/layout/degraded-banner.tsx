"use client";

import Link from "next/link";
import { AlertTriangle } from "lucide-react";
import { useHealth } from "@/lib/hooks/use-health";

/**
 * Degraded-mode banner. Rendered above `<main>` so it stays put while
 * the page scrolls — the degraded signal is safety-critical (writes are
 * being refused) and must not slide out of view.
 *
 * Reads degraded state from `/api/health` (10 s refetch + SSE cache
 * invalidation via `SSEProvider` debouncer).  When `status !== "degraded"`
 * the component renders `null`.
 */
export function DegradedBanner() {
  const { data } = useHealth();
  const degraded = data?.degraded;
  if (!degraded) return null;

  return (
    <div
      role="alert"
      className="flex items-center gap-2 border-b border-destructive/40 bg-destructive/10 px-4 py-2 text-sm text-destructive"
    >
      <AlertTriangle className="h-4 w-4 shrink-0" />
      <div className="flex-1 min-w-0">
        <span className="font-medium">{headlineFor(degraded.reason)}</span>
        {degraded.path && (
          <>
            {" — "}
            <code className="break-all font-mono text-xs">{degraded.path}</code>
          </>
        )}
        {". "}
        <span className="text-destructive/80">
          {bodyFor(degraded.reason)}
        </span>
      </div>
      <Link
        href="/settings#management-mode"
        className="shrink-0 rounded border border-destructive/40 bg-background px-2 py-1 text-xs font-medium text-destructive hover:bg-destructive/10"
      >
        Open Management Mode
      </Link>
    </div>
  );
}

function headlineFor(reason: string): string {
  if (reason === "primary_vault_unreachable") {
    return "Primary vault unreachable";
  }
  return `Daemon degraded: ${reason}`;
}

function bodyFor(reason: string): string {
  if (reason === "primary_vault_unreachable") {
    return "Writes to the context API are currently blocked. Fix the path or switch modes in Settings.";
  }
  return "Some operations may be refused until this clears.";
}
