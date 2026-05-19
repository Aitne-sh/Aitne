"use client";

import { Card, CardHeader, CardStatLabel } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/ui/page-header";
import { Plane, MapPin, Camera, ListChecks } from "lucide-react";

export default function TripPage() {
  return (
    <div className="space-y-6 p-6">
      <PageHeader
        icon={Plane}
        title="Trip"
        badge={<Badge variant="gray" className="text-[10px]">Coming soon</Badge>}
        description="A timeline view of your trips — itineraries, packing checklists, and post-trip notes. The daemon already extracts travel bookings from your email and stores them in the database; this dashboard view is still being built."
      />

      <div className="grid gap-4 md:grid-cols-3">
        <Card className="border-dashed">
          <CardHeader>
            <div className="flex items-center gap-2">
              <MapPin className="h-4 w-4 text-muted-foreground" />
              <CardStatLabel>Itinerary</CardStatLabel>
            </div>
          </CardHeader>
          <p className="text-sm text-muted-foreground">
            Day-by-day schedule with locations, transport, and reservations pulled from email and calendar.
          </p>
        </Card>

        <Card className="border-dashed">
          <CardHeader>
            <div className="flex items-center gap-2">
              <ListChecks className="h-4 w-4 text-muted-foreground" />
              <CardStatLabel>Pre-trip checklist</CardStatLabel>
            </div>
          </CardHeader>
          <p className="text-sm text-muted-foreground">
            Reusable packing templates, document checks, and the agent reminding you the night before.
          </p>
        </Card>

        <Card className="border-dashed">
          <CardHeader>
            <div className="flex items-center gap-2">
              <Camera className="h-4 w-4 text-muted-foreground" />
              <CardStatLabel>Post-trip notes</CardStatLabel>
            </div>
          </CardHeader>
          <p className="text-sm text-muted-foreground">
            Highlights, expenses summary, and a recap MD the agent helps you write while it&rsquo;s fresh.
          </p>
        </Card>
      </div>
    </div>
  );
}
