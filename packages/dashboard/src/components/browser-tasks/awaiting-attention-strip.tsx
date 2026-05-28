"use client";

import Link from "next/link";
import { AlertCircle } from "lucide-react";
import { useAwaitingBrowserTasksCount } from "@/lib/hooks/use-browser-tasks";
import { cn } from "@/lib/utils";

/**
 * BROWSER_TASK_REDESIGN_PLAN.md §9a.4 — the "tasks awaiting you" strip.
 *
 * One source of truth for the cross-cutting attention surface. Mounted
 * twice today:
 *   1. Inline on `/browser-tasks` (above the table) — when rendered
 *      here the user is already on the list, so a compact summary with
 *      jump-to-row anchors does the job.
 *   2. As a persistent dashboard-shell banner (`AwaitingAttentionBanner`)
 *      — see the dashboard layout shell.
 *
 * The strip is the visual partner of the nav-entry red dot. All three
 * derive from the same `["browser-tasks", "awaiting-count"]` query (the
 * SSE-invalidated cache) so they stay in lock-step.
 *
 * Renders nothing when no tasks are parked — no UI noise on the happy
 * path.
 */
export function AwaitingAttentionStrip({
  variant = "inline",
  className,
}: {
  variant?: "inline" | "shell";
  className?: string;
}) {
  const { data } = useAwaitingBrowserTasksCount();
  const tasks = data?.tasks ?? [];
  if (tasks.length === 0) return null;

  const count = tasks.length;
  // The total = the daemon's filtered count (may exceed the 10-row
  // limit cap; if so we say "10+"). Keeps the copy honest about the
  // backlog when there's more behind the fold.
  const total = data?.total ?? count;
  const overflow = total > count;
  const noun = total === 1 ? "browser task" : "browser tasks";
  const copy = `${overflow ? `${count}+ ` : `${total} `}${noun} need your input — check DM`;

  if (variant === "shell") {
    // Full-width shell variant — sits at the top of every page.
    return (
      <Link
        href="/browser-tasks"
        className={cn(
          "flex w-full items-center gap-3 border-b border-orange-300/60 bg-orange-50 px-4 py-2 text-sm text-orange-900 transition-colors hover:bg-orange-100 dark:border-orange-700/50 dark:bg-orange-950 dark:text-orange-100 dark:hover:bg-orange-900",
          className,
        )}
      >
        <AlertCircle className="h-4 w-4 shrink-0" aria-hidden />
        <span className="flex-1 truncate">{copy}</span>
        <span className="shrink-0 text-xs underline-offset-4 hover:underline">
          View
        </span>
      </Link>
    );
  }

  // Inline variant — rendered inside the `/browser-tasks` page above
  // the table. Lists the first few parked tasks by id + brief so the
  // user can jump straight to the row.
  return (
    <div
      className={cn(
        "rounded-xl border border-orange-300/60 bg-orange-50 p-3 text-sm dark:border-orange-700/50 dark:bg-orange-950",
        className,
      )}
    >
      <div className="flex items-center gap-2 text-orange-900 dark:text-orange-100">
        <AlertCircle className="h-4 w-4 shrink-0" aria-hidden />
        <span className="font-medium">{copy}</span>
      </div>
      <ul className="mt-2 space-y-1 pl-6 text-xs text-orange-800 dark:text-orange-200">
        {tasks.slice(0, 5).map((t) => (
          <li key={t.id}>
            <Link
              href={`/browser-tasks/${t.id}`}
              className="hover:underline"
            >
              <span className="font-mono">{t.id.slice(0, 8)}</span>
              {" — "}
              <span>{t.description.slice(0, 80)}</span>
            </Link>
          </li>
        ))}
        {tasks.length > 5 && (
          <li className="italic">+ {tasks.length - 5} more — scroll the table to see all</li>
        )}
      </ul>
    </div>
  );
}
