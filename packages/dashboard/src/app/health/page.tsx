"use client";

import { Card, CardHeader, CardStatLabel } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/ui/page-header";
import { Heart, Moon, Activity as ActivityIcon, Apple } from "lucide-react";

export default function HealthPage() {
  return (
    <div className="space-y-6 p-6">
      <PageHeader
        icon={Heart}
        title="Health"
        badge={<Badge variant="gray" className="text-[10px]">Skeleton</Badge>}
        description="A long-horizon space for body, sleep, and habit data. No backing implementation yet — integrations and visualizations will follow."
      />

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <Card className="border-dashed">
          <CardHeader>
            <div className="flex items-center gap-2">
              <ActivityIcon className="h-4 w-4 text-muted-foreground" />
              <CardStatLabel>Activity</CardStatLabel>
            </div>
          </CardHeader>
          <p className="text-sm text-muted-foreground">Steps, workouts, and weekly trends.</p>
        </Card>

        <Card className="border-dashed">
          <CardHeader>
            <div className="flex items-center gap-2">
              <Moon className="h-4 w-4 text-muted-foreground" />
              <CardStatLabel>Sleep</CardStatLabel>
            </div>
          </CardHeader>
          <p className="text-sm text-muted-foreground">Bedtime, duration, and consistency over time.</p>
        </Card>

        <Card className="border-dashed">
          <CardHeader>
            <div className="flex items-center gap-2">
              <Apple className="h-4 w-4 text-muted-foreground" />
              <CardStatLabel>Habits</CardStatLabel>
            </div>
          </CardHeader>
          <p className="text-sm text-muted-foreground">Streaks for the few habits you choose to track.</p>
        </Card>

        <Card className="border-dashed">
          <CardHeader>
            <div className="flex items-center gap-2">
              <Heart className="h-4 w-4 text-muted-foreground" />
              <CardStatLabel>Journal</CardStatLabel>
            </div>
          </CardHeader>
          <p className="text-sm text-muted-foreground">Free-form daily check-ins, MD-backed.</p>
        </Card>
      </div>
    </div>
  );
}
