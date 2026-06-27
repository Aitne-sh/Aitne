"use client";

import { AlertTriangle, CheckCircle2, MessageSquareReply } from "lucide-react";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import type { MetricsResponse } from "@/lib/api-types";

export function ProactiveForwardCard({
  snapshot,
}: {
  snapshot: MetricsResponse | undefined;
}) {
  const stats = snapshot?.proactiveForwardResume;
  const ratio = stats?.ratio ?? null;
  const percent = ratio === null ? null : Math.round(ratio * 1000) / 10;
  const thresholdPercent = Math.round((stats?.threshold ?? 0.05) * 100);
  const overThreshold =
    ratio !== null && stats !== undefined && ratio >= stats.threshold;
  const Icon = overThreshold ? AlertTriangle : CheckCircle2;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <MessageSquareReply className="h-4 w-4 text-muted-foreground" />
          <CardTitle>Forwarded DM Context</CardTitle>
          {overThreshold && (
            <Badge variant="amber" className="text-[10px]">
              Watch
            </Badge>
          )}
        </div>
      </CardHeader>

      {!stats || stats.injected === 0 ? (
        <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
          <CheckCircle2 className="h-4 w-4 text-success" />
          No forwarded notifications injected in the last 30 days
        </div>
      ) : (
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-3 rounded-lg border border-border/70 px-3 py-2.5">
            <div className="flex items-center gap-2">
              <Icon
                className={
                  overThreshold
                    ? "h-4 w-4 text-warning"
                    : "h-4 w-4 text-success"
                }
              />
              <span className="text-sm font-medium text-foreground">
                Disavowal ratio
              </span>
            </div>
            <span className="font-mono text-lg tabular-nums text-foreground">
              {percent}%
            </span>
          </div>
          <div className="grid grid-cols-2 gap-2 text-xs text-muted-foreground">
            <div className="rounded-md border border-border/70 px-3 py-2">
              <div className="font-mono text-sm tabular-nums text-foreground">
                {stats.injected}
              </div>
              <div>Injected</div>
            </div>
            <div className="rounded-md border border-border/70 px-3 py-2">
              <div className="font-mono text-sm tabular-nums text-foreground">
                {stats.disavowed}
              </div>
              <div>Disavowed</div>
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            Fresh-session fallback threshold: {thresholdPercent}%
          </p>
        </div>
      )}
    </Card>
  );
}
