"use client";

import { useCallback } from "react";
import Link from "next/link";
import { useConfig, useConfigDefaults } from "@/lib/hooks/use-config";
import { useHealth } from "@/lib/hooks/use-health";
import { useAgents } from "@/lib/hooks/use-agents";
import { useDirtyFields } from "@/lib/hooks/use-dirty-fields";
import { ConfigSection, EditableField, EditableBooleanField } from "@/components/settings/editors";
import { PrimaryPlatformField } from "@/components/settings/composite-fields";
import {
  TimeRangeRing,
  type TimeRangeRingValues,
} from "@/components/settings/time-range-ring";
import { DelegatedSyncSection } from "@/components/settings/delegated-sync-section";
import { PageHeader } from "@/components/ui/page-header";

/**
 * Hours & Notifications — the cross-cutting time policy: timezone, day
 * boundary, quiet hours, and notification caps (AGENTS_HUB_REDESIGN_PLAN
 * §4.3, formerly /settings/schedule). Per-agent cadence (the activity-scan
 * interval and active window, the monthly-review opt-in) moved to /agents —
 * this page keeps only what applies to EVERY agent: quiet hours always win
 * over any per-agent schedule.
 */
export default function HoursSettingsPage() {
  const { data: config } = useConfig();
  const { df } = useConfigDefaults();
  const { data: health } = useHealth();
  const { data: agentsData } = useAgents();
  const { deferSaveFor, dv, dirtyFields, setDirty } = useDirtyFields();

  // Quiet hours stay draggable; the activity-scan active window is agent-owned
  // and rendered read-only (edit from /agents/activity-scan).
  const handleRingChange = useCallback(
    (next: TimeRangeRingValues) => {
      if (!config) return;
      setDirty("quietHoursStart", next.quietHoursStart, config.quietHoursStart);
      setDirty("quietHoursEnd", next.quietHoursEnd, config.quietHoursEnd);
    },
    [config, setDirty],
  );

  if (!config) {
    return <div className="text-muted-foreground">Loading...</div>;
  }

  const deferSave = deferSaveFor(config);

  // The activity-scan agent's resolved window (live from /api/agents); the
  // config keys remain only as the pre-redesign fallback for older daemons.
  const scanInterval = agentsData?.agents.find((a) => a.slug === "activity-scan")
    ?.schedule.interval;
  const ringValues: TimeRangeRingValues = {
    quietHoursStart: dv("quietHoursStart", config.quietHoursStart),
    quietHoursEnd: dv("quietHoursEnd", config.quietHoursEnd),
    activeStartHour: scanInterval?.active_start_hour ?? config.activityScanActiveStartHour,
    activeEndHour: scanInterval?.active_end_hour ?? config.activityScanActiveEndHour,
    dayBoundaryHour: dv("dayBoundaryHour", config.dayBoundaryHour),
  };

  return (
    <>
      <PageHeader
        title="Hours & Notifications"
        description="The global time policy every agent obeys: timezone, day boundary, quiet hours, and notification caps. Per-agent schedules (including the activity scan's cadence) live on the Agents page — quiet hours always win over them."
      />

      {/* Visual time-axis overview */}
      <ConfigSection title="Time axis" helpDocId="concepts/agent-day">
        <p className="pb-2 text-xs text-muted-foreground">
          Drag the handles to adjust quiet hours (red). The green band is the
          activity scan&apos;s active window — owned by the agent, edit it from{" "}
          <Link
            href="/agents/activity-scan"
            className="text-foreground underline underline-offset-2 hover:no-underline"
          >
            Agents → Activity Scan
          </Link>
          . The dashed blue line marks the day boundary. Changes are staged —
          save with the bar below.
        </p>
        <TimeRangeRing values={ringValues} onChange={handleRingChange} activeWindowReadOnly />
      </ConfigSection>

      <ConfigSection title="Day shape" helpDocId="concepts/agent-day">
        <EditableField
          label="Timezone"
          value={dv("timezone", config.timezone)}
          configKey="timezone"
          modified={dirtyFields.has("timezone")}
          defaultValue={df("timezone")}
          description="IANA timezone name (e.g. America/New_York, America/Los_Angeles). All schedules, quiet hours, and daily boundaries are interpreted in this zone."
          onSave={deferSave}
        />
        <EditableField
          label="Day Boundary Hour"
          value={dv("dayBoundaryHour", config.dayBoundaryHour)}
          configKey="dayBoundaryHour"
          type="number"
          min={0}
          max={9}
          modified={dirtyFields.has("dayBoundaryHour")}
          defaultValue={df("dayBoundaryHour")}
          description="Hour (0–9, local time) at which a new agent day begins. At this hour the previous today.md is archived, a new one is generated, and daily retention and summary routines run. Pick a time you're reliably asleep — 04:00 is the default."
          onSave={deferSave}
        />
        <div className="py-2 text-sm text-muted-foreground">
          Looking for the activity scan&apos;s interval or the monthly review
          opt-in? Each agent&apos;s schedule now lives on its own page —{" "}
          <Link
            href="/agents"
            className="text-foreground underline underline-offset-2 hover:no-underline"
          >
            Agents
          </Link>
          .
        </div>
      </ConfigSection>

      <DelegatedSyncSection />

      <ConfigSection title="Notifications" helpDocId="features/operations/quiet-hours">
        <p className="pb-2 text-xs text-muted-foreground">
          Rate limits and quiet hours for outbound notifications — proactive
          messages the agent sends you (reminders, alerts, summaries). Replies
          to messages you initiated are not affected. Delivery destinations
          are managed in Connections → Messaging.
        </p>
        <EditableField
          label="Max Per Hour"
          value={dv("maxNotificationsPerHour", config.maxNotificationsPerHour)}
          configKey="maxNotificationsPerHour"
          type="number"
          modified={dirtyFields.has("maxNotificationsPerHour")}
          defaultValue={df("maxNotificationsPerHour")}
          description="Hard cap on outbound notifications in any rolling 60-minute window. Anything above the cap is suppressed — not delivered, but still logged to Activity → Notifications so you can see what was dropped. Protects against runaway notification loops."
          onSave={deferSave}
        />
        <EditableField
          label="Max Per Day"
          value={dv("maxNotificationsPerDay", config.maxNotificationsPerDay)}
          configKey="maxNotificationsPerDay"
          type="number"
          modified={dirtyFields.has("maxNotificationsPerDay")}
          defaultValue={df("maxNotificationsPerDay")}
          description="Hard cap per calendar day (resets at the Day Boundary Hour). A safety net on top of the per-hour cap. Suppressed notifications are still logged."
          onSave={deferSave}
        />
        <EditableField
          label="Quiet Hours Start"
          value={dv("quietHoursStart", config.quietHoursStart)}
          configKey="quietHoursStart"
          modified={dirtyFields.has("quietHoursStart")}
          defaultValue={df("quietHoursStart")}
          description="24-hour time (HH:MM, e.g. 22:00) when quiet hours begin in the configured timezone. During quiet hours, regular notifications are held back. Safety-category notifications (deadline, error, security, critical) still go through."
          onSave={deferSave}
        />
        <EditableField
          label="Quiet Hours End"
          value={dv("quietHoursEnd", config.quietHoursEnd)}
          configKey="quietHoursEnd"
          modified={dirtyFields.has("quietHoursEnd")}
          defaultValue={df("quietHoursEnd")}
          description="24-hour time (HH:MM, e.g. 08:00) when quiet hours end. If end is earlier than start, the window wraps over midnight."
          onSave={deferSave}
        />
        <EditableField
          label="Batch Interval"
          value={dv("batchIntervalMinutes", config.batchIntervalMinutes)}
          configKey="batchIntervalMinutes"
          type="number"
          suffix="min"
          modified={dirtyFields.has("batchIntervalMinutes")}
          defaultValue={df("batchIntervalMinutes")}
          description="Minimum minutes between notification deliveries from the same routine. Multiple notifications queued within this window are combined into a single message so you don&rsquo;t get spammed."
          onSave={deferSave}
        />
        <div className="py-2 border-b text-sm text-muted-foreground">
          Default reminder destinations are managed in{" "}
          <a
            href="/connections/messaging"
            className="text-foreground underline underline-offset-2 hover:no-underline"
          >
            Connections → Messaging → Default Reminder Destinations
          </a>
          .
        </div>
        <PrimaryPlatformField
          health={health}
          value={dv("primaryPlatform", config.primaryPlatform)}
          defaultValue={df("primaryPlatform")}
          modified={dirtyFields.has("primaryPlatform")}
          onSave={deferSave}
        />
        <EditableBooleanField
          label="Backend failure alerts to DM"
          value={dv("backendFailureDmAlerts", config.backendFailureDmAlerts)}
          configKey="backendFailureDmAlerts"
          modified={dirtyFields.has("backendFailureDmAlerts")}
          defaultValue={df("backendFailureDmAlerts")}
          description="Off by default. When on, low-level backend-execution failures (a routine's model hitting its budget, a transient API error, etc.) are also sent to your messaging app. These are operator diagnostics — they're always recorded on Activity → Events regardless — so leave this off unless you're actively debugging, or they'll arrive one message per failure. Transient network blips never notify even when on."
          onSave={deferSave}
        />
      </ConfigSection>
    </>
  );
}
