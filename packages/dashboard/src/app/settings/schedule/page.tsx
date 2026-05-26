"use client";

import { useCallback } from "react";
import { useConfig, useConfigDefaults } from "@/lib/hooks/use-config";
import { useHealth } from "@/lib/hooks/use-health";
import { useDirtyFields } from "@/lib/hooks/use-dirty-fields";
import {
  ConfigSection,
  EditableBooleanField,
  EditableField,
} from "@/components/settings/editors";
import { PrimaryPlatformField } from "@/components/settings/composite-fields";
import {
  TimeRangeRing,
  type TimeRangeRingValues,
} from "@/components/settings/time-range-ring";
import { DelegatedSyncSection } from "@/components/settings/delegated-sync-section";
import { PageHeader } from "@/components/ui/page-header";

const RUN_NOW_EXAMPLE = `curl -X POST http://localhost:8321/api/agent/run-now -H "Authorization: Bearer <daemon-api-token>" -H "Content-Type: application/json" -d '{"reason":"manual"}'`;

export default function ScheduleSettingsPage() {
  const { data: config } = useConfig();
  const { df } = useConfigDefaults();
  const { data: health } = useHealth();
  const { deferSaveFor, dv, dirtyFields, setDirty } = useDirtyFields();

  // Calls setDirty with toggle-back detection — equivalent to deferSaveFor(config),
  // but placed before the early return to satisfy React hooks ordering rules.
  const handleRingChange = useCallback(
    (next: TimeRangeRingValues) => {
      if (!config) return;
      setDirty("quietHoursStart", next.quietHoursStart, config.quietHoursStart);
      setDirty("quietHoursEnd", next.quietHoursEnd, config.quietHoursEnd);
      setDirty("hourlyCheckActiveStartHour", next.activeStartHour, config.hourlyCheckActiveStartHour);
      setDirty("hourlyCheckActiveEndHour", next.activeEndHour, config.hourlyCheckActiveEndHour);
    },
    [config, setDirty],
  );

  if (!config) {
    return <div className="text-muted-foreground">Loading...</div>;
  }

  const deferSave = deferSaveFor(config);

  // Gather ring values from dirty or server state
  const ringValues: TimeRangeRingValues = {
    quietHoursStart: dv("quietHoursStart", config.quietHoursStart),
    quietHoursEnd: dv("quietHoursEnd", config.quietHoursEnd),
    activeStartHour: dv("hourlyCheckActiveStartHour", config.hourlyCheckActiveStartHour),
    activeEndHour: dv("hourlyCheckActiveEndHour", config.hourlyCheckActiveEndHour),
    dayBoundaryHour: dv("dayBoundaryHour", config.dayBoundaryHour),
  };

  return (
    <>
      <PageHeader
        title="Schedule & Notifications"
        description="When the agent runs in the background and how often it can interrupt you. All times are interpreted in the configured timezone."
      />

      {/* Visual time-axis overview */}
      <ConfigSection
        title="Time axis"
        helpDocId="concepts/agent-day"
      >
        <p className="pb-2 text-xs text-muted-foreground">
          Drag the handles to adjust quiet hours (red) and the hourly-check active
          window (green). The dashed blue line marks the day boundary. Changes are
          staged — save with the bar below.
        </p>
        <TimeRangeRing values={ringValues} onChange={handleRingChange} />
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
      </ConfigSection>

      <ConfigSection
        title="Hourly Check"
        helpDocId="features/routines/hourly-check" // drift-allow: doc slug, not vault path
      >
        <p className="pb-2 text-xs text-muted-foreground">
          The hourly check is the agent&rsquo;s passive review loop. At each
          interval it scans pending observations (file edits, calendar
          updates, git events, Notion changes), folds anything actionable into
          your context files (<code>today.md</code>, <code>roadmap.md</code>,
          project notes), and stays silent otherwise. Most runs produce no
          output — that is by design.
        </p>
        <EditableBooleanField
          label="Hourly Check Enabled"
          value={dv("hourlyCheckEnabled", config.hourlyCheckEnabled)}
          configKey="hourlyCheckEnabled"
          modified={dirtyFields.has("hourlyCheckEnabled")}
          defaultValue={df("hourlyCheckEnabled")}
          description="Master switch for the polling routine. When off, the agent only runs on direct messages, schedule.approaching events, and explicitly scheduled tasks."
          onSave={deferSave}
        />
        <EditableField
          label="Check Interval"
          value={dv("hourlyCheckIntervalMinutes", config.hourlyCheckIntervalMinutes)}
          configKey="hourlyCheckIntervalMinutes"
          type="number"
          suffix="min"
          min={1}
          max={1440}
          modified={dirtyFields.has("hourlyCheckIntervalMinutes")}
          defaultValue={df("hourlyCheckIntervalMinutes")}
          description="How often the check runs during the active window, in minutes (1–1440). Lower values give faster feedback; higher values cut quota burn. The cadence is anchored to the active-window start, so the first fire of each agent-day lands exactly at that hour."
          onSave={deferSave}
        />
        <EditableField
          label="Active Start Hour"
          value={dv("hourlyCheckActiveStartHour", config.hourlyCheckActiveStartHour)}
          configKey="hourlyCheckActiveStartHour"
          type="number"
          min={0}
          max={23}
          modified={dirtyFields.has("hourlyCheckActiveStartHour")}
          defaultValue={df("hourlyCheckActiveStartHour")}
          description="Hour (0–23, local time) when the hourly check window opens. Runs before this hour are skipped entirely."
          onSave={deferSave}
        />
        <EditableField
          label="Active End Hour"
          value={dv("hourlyCheckActiveEndHour", config.hourlyCheckActiveEndHour)}
          configKey="hourlyCheckActiveEndHour"
          type="number"
          min={1}
          max={24}
          modified={dirtyFields.has("hourlyCheckActiveEndHour")}
          defaultValue={df("hourlyCheckActiveEndHour")}
          description="Hour (1–24, local time) when the window closes. Exclusive: set 24 to run through 23:59. Prevents the check from firing while you sleep."
          onSave={deferSave}
        />
        <EditableField
          label="Min Observations"
          value={dv("hourlyCheckMinObservations", config.hourlyCheckMinObservations)}
          configKey="hourlyCheckMinObservations"
          type="number"
          min={0}
          max={1000}
          modified={dirtyFields.has("hourlyCheckMinObservations")}
          defaultValue={df("hourlyCheckMinObservations")}
          description="Minimum number of pending user-actor observations required to launch the agent. If fewer are queued, the tick is skipped with no cost. Raise this if you see too many no-op runs."
          onSave={deferSave}
        />
        <p className="pt-2 text-xs text-muted-foreground">
          Trigger one immediately from the CLI:
        </p>
        <pre className="overflow-x-auto rounded bg-muted p-2 font-mono text-[11px] text-muted-foreground">
          {RUN_NOW_EXAMPLE}
        </pre>
      </ConfigSection>

      <ConfigSection title="Monthly Review (experimental — off by default)">
        <p className="pb-2 text-xs text-muted-foreground">
          The monthly review is a once-per-month synthesis routine. At the
          last day of each month it reads the month&rsquo;s daily files,
          weekly retrospectives, and the agent journal, then writes a
          user-facing snapshot to <code>journal/monthly/YYYY-MM.md</code> and
          appends a <code>## Monthly YYYY-MM</code> block to{" "}
          <code>journal/agent.md</code>.
        </p>
        <p className="pb-2 text-xs text-muted-foreground">
          It is <strong>disabled by default</strong> pre-release because
          the current task-flow&rsquo;s cost-to-value ratio is poor — it
          reads roughly 30 daily files plus 4–5 weekly files per run
          (~$0.30–$1.50 in tokens) and produces a snapshot that no
          downstream routine currently consumes. A leaner
          &ldquo;Mirror + Prune&rdquo; redesign — one trend observation
          plus aged carry-over decisions — is planned before the flag
          flips to on-by-default. Enable below to opt in to the current
          heavy version.
        </p>
        <EditableBooleanField
          label="Monthly Review Enabled"
          value={dv("monthlyReviewEnabled", config.monthlyReviewEnabled)}
          configKey="monthlyReviewEnabled"
          modified={dirtyFields.has("monthlyReviewEnabled")}
          defaultValue={df("monthlyReviewEnabled")}
          description="When on, the daemon fires routine.monthly_review on the last day of each month at 18:00 local time. The flag is consulted at fire time, so flipping it takes effect on the next month-end — no daemon restart needed. Expect one Sonnet-class session per month near the per-execute $1.00 budget cap, plus one optional notification."
          onSave={deferSave}
        />
      </ConfigSection>

      <DelegatedSyncSection />

      <ConfigSection
        title="Notifications"
        helpDocId="features/operations/quiet-hours"
      >
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
      </ConfigSection>
    </>
  );
}
