"use client";

import { Card, CardHeader, CardStatLabel } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/ui/page-header";
import { Wallet, Receipt, PiggyBank, TrendingUp } from "lucide-react";

export default function FinancePage() {
  return (
    <div className="space-y-6 p-6">
      <PageHeader
        icon={Wallet}
        title="Finance"
        badge={<Badge variant="gray" className="text-[10px]">Coming soon</Badge>}
        description="Personal expense tracking and budget awareness — observational and advisory only. The daemon already extracts receipts from your email and stores them in the database; this dashboard view is still being built."
      />

      <div className="grid gap-4 md:grid-cols-3">
        <Card className="border-dashed">
          <CardHeader>
            <div className="flex items-center gap-2">
              <Receipt className="h-4 w-4 text-muted-foreground" />
              <CardStatLabel>Receipts</CardStatLabel>
            </div>
          </CardHeader>
          <p className="text-sm text-muted-foreground">
            Auto-categorized expenses from email confirmations, with monthly rollups and outliers flagged for review.
          </p>
        </Card>

        <Card className="border-dashed">
          <CardHeader>
            <div className="flex items-center gap-2">
              <PiggyBank className="h-4 w-4 text-muted-foreground" />
              <CardStatLabel>Budgets</CardStatLabel>
            </div>
          </CardHeader>
          <p className="text-sm text-muted-foreground">
            Soft monthly targets per category. The agent nudges you in chat when you&rsquo;re trending over.
          </p>
        </Card>

        <Card className="border-dashed">
          <CardHeader>
            <div className="flex items-center gap-2">
              <TrendingUp className="h-4 w-4 text-muted-foreground" />
              <CardStatLabel>Insights</CardStatLabel>
            </div>
          </CardHeader>
          <p className="text-sm text-muted-foreground">
            Year-over-year and month-over-month trends, with the agent surfacing changes worth noticing.
          </p>
        </Card>
      </div>

      <p className="rounded-md border border-border/50 bg-muted/40 p-3 text-xs text-muted-foreground">
        Safety invariant: the agent never executes trades, places orders, or initiates transfers.
      </p>
    </div>
  );
}
