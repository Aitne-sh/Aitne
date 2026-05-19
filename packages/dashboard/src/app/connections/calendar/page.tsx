"use client";

import { useConfig } from "@/lib/hooks/use-config";
import { useHealth } from "@/lib/hooks/use-health";

import { AppleCalendarCard } from "@/components/connections/apple-calendar-card";
import { GoogleCard } from "@/components/connections/google-card";
import { IntegrationCard } from "@/components/connections/integration-card";
import { OutlookCalendarCard } from "@/components/connections/outlook-calendar-card";
import { ProcessModelCard } from "@/components/connections/process-model-card";
import { ConnectionsSectionHeader } from "@/components/connections/section-header";

export default function CalendarConnectionsPage() {
  const { data: config, isLoading: configLoading } = useConfig();
  const { data: health, isLoading: healthLoading } = useHealth();

  const loading = configLoading || healthLoading;
  const disconnected = !loading && (!config || !health);

  const calendarConnected =
    health?.integrations?.google?.services?.calendar?.connected ?? false;

  // The Calendar Event Model card binds the `calendar.change` ProcessKey,
  // which only fires from the daemon-side poller. In delegated mode the
  // poller is stopped and the picker becomes a misleading dead surface,
  // so we hide it. Mirrors the gate `calendar-preview.tsx` already uses
  // for the today's-events widget. Fail-open on undefined: show the card
  // until we can confirm the mode is delegated.
  const calendarDelegated =
    health?.integrationModes?.google_calendar?.mode === "delegated";

  return (
    <>
      <ConnectionsSectionHeader
        title="Calendar"
        description="Google, Outlook, and Apple calendars. Google and Outlook reuse the OAuth from their matching Mail account — manage those accounts on the Mail page. Apple Calendar uses a separate CalDAV credential set up here."
        healthy={calendarConnected ? 1 : 0}
        total={1}
      />

      {disconnected && (
        <p className="text-sm text-muted-foreground">
          Daemon not connected. Start the daemon to configure calendar access.
        </p>
      )}

      {!loading && (
        <div id="google" className="space-y-4">
          <IntegrationCard integrationKey="google_calendar" />
          <GoogleCard />
          {!calendarDelegated && (
            <ProcessModelCard
              processKey="calendar.change"
              title="Calendar Event Model"
              description="Runs when the daemon-side poller detects a calendar change. Light-tier (Haiku 4.5 / gpt-5.4-mini) handles event classification at low cost."
            />
          )}
        </div>
      )}

      {!loading && (
        <div id="outlook" className="space-y-4">
          <OutlookCalendarCard />
        </div>
      )}

      {!loading && (
        <div id="apple" className="space-y-4">
          <AppleCalendarCard />
        </div>
      )}
    </>
  );
}
