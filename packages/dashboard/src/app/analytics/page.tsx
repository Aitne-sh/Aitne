"use client";

import { Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PageHeader } from "@/components/ui/page-header";
import { CostContent } from "@/components/analytics/cost-content";
import { MetricsContent } from "@/components/analytics/metrics-content";

function AnalyticsPageInner() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const tab = searchParams.get("tab") ?? "cost";

  const handleTabChange = (next: string) => {
    router.replace(`/analytics?tab=${next}`, { scroll: false });
  };

  return (
    <div className="flex min-h-full flex-col p-6 pb-8">
      <PageHeader
        className="mb-4"
        title="Analytics"
        description={
          <>
            Usage and spend trends for the agent. <strong>Cost</strong> aggregates per-run USD spend (computed from token counts × backend pricing) across days, weeks, and months, broken down by backend and process. <strong>Metrics</strong> shows operational health — activity volume, execution breakdown, error rates, notification throughput. Data is derived from the daemon&rsquo;s local SQLite database, not sent anywhere external.
          </>
        }
      />

      <Tabs
        value={tab}
        onValueChange={handleTabChange}
        className="flex flex-col"
      >
        <TabsList className="w-fit">
          <TabsTrigger value="cost">Cost</TabsTrigger>
          <TabsTrigger value="metrics">Metrics</TabsTrigger>
        </TabsList>

        <TabsContent value="cost" className="mt-4">
          <CostContent enabled={tab === "cost"} />
        </TabsContent>

        <TabsContent value="metrics" className="mt-4">
          <MetricsContent enabled={tab === "metrics"} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

export default function AnalyticsPage() {
  return (
    <Suspense>
      <AnalyticsPageInner />
    </Suspense>
  );
}
