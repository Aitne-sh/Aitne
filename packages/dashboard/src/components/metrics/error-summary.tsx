"use client";

import Link from "next/link";
import { AlertCircle, CheckCircle2, Clock, KeyRound, Wifi, HelpCircle } from "lucide-react";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { formatShortDateTime, formatAbsoluteTime, formatRelativeTime } from "@/lib/utils";
import type { MetricsErrorGroup } from "@/lib/api-types";
import { DocsLearnMore } from "@/components/docs/docs-learn-more";

interface ErrorSummaryProps {
  errors: MetricsErrorGroup[];
  days: number;
}

interface CategoryMeta {
  label: string;
  icon: typeof AlertCircle;
  badgeVariant: "default" | "gray" | "red" | "amber";
  /** Docs slug for an "Learn more →" link next to the category. */
  docId?: string;
}

const CATEGORY_META: Record<string, CategoryMeta> = {
  quota: {
    label: "Rate Limit / Quota",
    icon: Clock,
    badgeVariant: "amber",
    docId: "troubleshooting/quota-exhausted",
  },
  timeout: { label: "Timeout", icon: Clock, badgeVariant: "amber" },
  auth: {
    label: "Authentication",
    icon: KeyRound,
    badgeVariant: "red",
    docId: "troubleshooting/auth-failed",
  },
  network: { label: "Network", icon: Wifi, badgeVariant: "amber" },
  other: { label: "Other", icon: HelpCircle, badgeVariant: "gray" },
};

export function ErrorSummary({ errors, days }: ErrorSummaryProps) {
  const totalErrors = errors.reduce((s, e) => s + e.count, 0);

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <CardTitle>Errors</CardTitle>
          {totalErrors > 0 && (
            <Badge variant="red" className="text-xs">
              {totalErrors}
            </Badge>
          )}
        </div>
        <Link
          href="/activity"
          className="text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          View all →
        </Link>
      </CardHeader>

      {errors.length === 0 ? (
        <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
          <CheckCircle2 className="h-4 w-4 text-success" />
          No errors in the last {days} days
        </div>
      ) : (
        <div className="space-y-2">
          {errors.map((err) => {
            const meta = CATEGORY_META[err.category] ?? CATEGORY_META.other;
            const Icon = meta.icon;
            return (
              <div
                key={err.category}
                className="flex items-start gap-3 rounded-lg border border-border/70 px-3 py-2.5"
              >
                <Icon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-foreground">{meta.label}</span>
                    <Badge variant={meta.badgeVariant} className="text-[10px]">
                      {err.count}×
                    </Badge>
                    {err.backend && (
                      <span className="text-[10px] text-muted-foreground">{err.backend}</span>
                    )}
                  </div>
                  <p className="mt-0.5 truncate text-xs text-muted-foreground">
                    {err.sampleMessage}
                  </p>
                  <div className="mt-0.5 flex items-center justify-between gap-2">
                    <p className="text-[10px] font-mono tabular-nums text-muted-foreground">
                      Last:{" "}
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span>{formatShortDateTime(err.lastSeen)}</span>
                        </TooltipTrigger>
                        <TooltipContent>
                          {formatAbsoluteTime(err.lastSeen)} ({formatRelativeTime(err.lastSeen)})
                        </TooltipContent>
                      </Tooltip>
                    </p>
                    {meta.docId && (
                      <DocsLearnMore docId={meta.docId} label="Learn more →" />
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}
