"use client";

import { useHealth } from "@/lib/hooks/use-health";
import { LayoutDashboard } from "lucide-react";
import type { MessagingHealthStatus } from "@/lib/api-types";
import { ConnectionCard, deriveMessagingStatus } from "./connection-card";

export function DashboardCard() {
  const { data: health } = useHealth();
  const status: MessagingHealthStatus | undefined = health?.messaging?.dashboard;

  return (
    <ConnectionCard
      name="Dashboard"
      icon={<LayoutDashboard className="h-4 w-4" />}
      status={deriveMessagingStatus(status)}
      error={status?.error}
    >
      <p className="text-xs text-muted-foreground">
        The dashboard chat shares the same conversation as your other messaging
        apps. Routine reminders aren&apos;t delivered here by default — they go to
        the destinations you pick below.
      </p>
    </ConnectionCard>
  );
}
