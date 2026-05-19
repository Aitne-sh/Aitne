"use client";

import { Card, CardHeader, CardTitle, CardValue } from "@/components/ui/card";
import type { MetricsDailyBucket } from "@/lib/api-types";

interface ContextUpdateCardProps {
  daily: MetricsDailyBucket[];
}

export function ContextUpdateCard({ daily }: ContextUpdateCardProps) {
  const autoTotal = daily.reduce((s, d) => s + d.executionsAutonomous, 0);
  const autoUpdated = daily.reduce((s, d) => s + d.contextUpdatesAutonomous, 0);
  const autoRate = autoTotal > 0 ? autoUpdated / autoTotal : null;

  const reactiveTotal = daily.reduce((s, d) => s + d.executionsReactive, 0);
  const reactiveUpdated = daily.reduce((s, d) => s + d.contextUpdatesReactive, 0);
  const reactiveRate = reactiveTotal > 0 ? reactiveUpdated / reactiveTotal : null;

  const formatPct = (r: number | null) =>
    r !== null ? `${(r * 100).toFixed(0)}%` : "—";

  return (
    <Card>
      <CardHeader>
        <CardTitle>Context Update Rate</CardTitle>
      </CardHeader>
      <p className="mb-3 text-xs text-muted-foreground">
        Share of executions that wrote to context MD files.
      </p>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <p className="text-xs text-muted-foreground">Autonomous</p>
          <CardValue className="text-2xl">{formatPct(autoRate)}</CardValue>
          <p className="text-[11px] text-muted-foreground">
            {autoUpdated} / {autoTotal}
          </p>
        </div>
        <div>
          <p className="text-xs text-muted-foreground">Reactive</p>
          <CardValue className="text-2xl">{formatPct(reactiveRate)}</CardValue>
          <p className="text-[11px] text-muted-foreground">
            {reactiveUpdated} / {reactiveTotal}
          </p>
        </div>
      </div>
    </Card>
  );
}
