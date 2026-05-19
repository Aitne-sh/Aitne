"use client";

import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import type { MetricsResponse } from "@/lib/api-types";

interface AdvisorUsageCardProps {
  snapshot: MetricsResponse | undefined;
}

export function AdvisorUsageCard({ snapshot }: AdvisorUsageCardProps) {
  const rate = snapshot?.advisorCallRate ?? null;
  const eligible =
    snapshot !== undefined
      ? snapshot.modelCounts.sonnetSessions + snapshot.modelCounts.opusSessions
      : 0;

  const rateLabel =
    rate !== null ? `${rate.toFixed(2)} calls / session` : "—";

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Advisor Usage</CardTitle>
        <span className="text-[11px] text-muted-foreground">Claude runs only</span>
      </CardHeader>
      <div className="flex items-baseline gap-3">
        <span className="text-2xl font-bold text-foreground">{rateLabel}</span>
        <span className="text-xs text-muted-foreground">
          Based on {eligible} Claude run{eligible === 1 ? "" : "s"} in last 30d
        </span>
      </div>
    </Card>
  );
}
