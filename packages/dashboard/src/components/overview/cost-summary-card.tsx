"use client";

import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { formatCurrency } from "@/lib/utils";
import { useCost } from "@/lib/hooks/use-cost";
import { useMetrics } from "@/lib/hooks/use-metrics";
import { Sparkline } from "@/components/metrics/sparkline";

export function CostSummaryCard() {
  const { data: costData } = useCost("daily");
  const { data: metrics } = useMetrics();

  const last7dCost = metrics?.cost.last7dUsd ?? 0;
  const dailyCosts = costData?.byPeriod.slice(-7).map((d) => d.total_cost) ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle>Cost Summary</CardTitle>
        <Link
          href="/analytics"
          className="flex items-center gap-1 text-xs text-primary hover:underline"
        >
          Details <ArrowRight className="h-3 w-3" />
        </Link>
      </CardHeader>
      <div className="space-y-2">
        <div className="flex items-baseline justify-between">
          <span className="text-sm text-muted-foreground">Last 7 days</span>
          <span className="text-lg font-semibold text-foreground">{formatCurrency(last7dCost)}</span>
        </div>
        {dailyCosts.length >= 2 && (
          <Sparkline values={dailyCosts} color="var(--color-primary)" width={200} height={32} />
        )}
      </div>
    </Card>
  );
}
