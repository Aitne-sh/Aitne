"use client";

import Link from "next/link";
import { BookOpen } from "lucide-react";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { useBooksSummary, useBooks } from "@/lib/hooks/use-books";
import type { BookRow } from "@/lib/api-types";

/**
 * ReadingWidget — compact Overview card showing reading activity.
 *
 * Intentionally hides itself when the user has no books at all, so the
 * Overview grid stays quiet during setup. Once a first import lands, the
 * card appears and surfaces three signals: currently reading, completed
 * this month, and the most recently touched active book title.
 */
export function ReadingWidget() {
  const { data: summary } = useBooksSummary(3);
  const { data: reading } = useBooks({ status: "reading", limit: 3 });

  const byStatus = summary?.byStatus ?? [];
  const totalBooks = byStatus.reduce((acc, row) => acc + row.count, 0);
  if (totalBooks === 0) return null;

  const readingCount = byStatus.find((s) => s.status === "reading")?.count ?? 0;
  const completedThisMonth = summary?.monthlyCompleted?.[0]?.count ?? 0;
  const topReading = (reading?.books ?? []) as BookRow[];

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between w-full">
          <CardTitle>
            <span className="inline-flex items-center gap-2">
              <BookOpen className="h-4 w-4 text-blue-500" />
              Reading
            </span>
          </CardTitle>
          <Link
            href="/reading"
            className="text-xs text-muted-foreground hover:text-foreground"
          >
            View all →
          </Link>
        </div>
      </CardHeader>
      <div className="space-y-2">
        <div className="flex items-center gap-4 text-sm">
          <div>
            <span className="font-medium text-foreground">{readingCount}</span>
            <span className="text-muted-foreground"> in progress</span>
          </div>
          <div>
            <span className="font-medium text-foreground">{completedThisMonth}</span>
            <span className="text-muted-foreground"> completed this month</span>
          </div>
        </div>
        {topReading.length > 0 ? (
          <ul className="space-y-1 text-sm">
            {topReading.map((book) => (
              <li key={book.id} className="flex items-baseline justify-between gap-2">
                <span className="truncate text-foreground">{book.title}</span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {book.highlightCount} hl
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">No active reads.</p>
        )}
      </div>
    </Card>
  );
}
