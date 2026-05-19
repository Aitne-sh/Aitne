"use client";

import { useState } from "react";
import { ChevronRight } from "lucide-react";
import { useConfig, useConfigDefaults } from "@/lib/hooks/use-config";
import { useSaveConfig } from "@/lib/hooks/use-save-config";
import { useDirtyFields } from "@/lib/hooks/use-dirty-fields";
import { BackendSettingsSection } from "@/components/settings/backend-settings";
import { BackendsSection } from "@/components/settings/backends-section";
import { ExecutionModeSettings } from "@/components/settings/execution-mode-settings";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { PageHeader } from "@/components/ui/page-header";
import {
  ConfigSection,
  EditableField,
} from "@/components/settings/editors";
import { SettingsToast } from "@/components/settings/settings-navigation";
import { cn } from "@/lib/utils";

function CollapsibleSection({
  title,
  defaultOpen = false,
  children,
}: {
  title: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger asChild>
        <button className="flex w-full items-center gap-2 rounded-lg px-1 py-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground hover:bg-muted/50 hover:text-foreground transition-colors">
          <ChevronRight
            className={cn(
              "h-3.5 w-3.5 shrink-0 transition-transform duration-200",
              open && "rotate-90",
            )}
          />
          {title}
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent className="space-y-3 pt-1">
        {children}
      </CollapsibleContent>
    </Collapsible>
  );
}

export default function ModelsSettingsPage() {
  const { data: config } = useConfig();
  const { df } = useConfigDefaults();
  // toast + showToast stay for BackendSettingsSection / BackendsSection (own save flows)
  const { toast, showToast } = useSaveConfig();
  // deferSave / dv for the EditableField components in collapsible sections
  const { deferSaveFor, dv, dirtyFields } = useDirtyFields();

  if (!config) {
    return <div className="text-muted-foreground">Loading...</div>;
  }

  const deferSave = deferSaveFor(config);

  return (
    <>
      <PageHeader
        title="Models & Cost"
        description="AI backends, per-task routing, and execution limits. The backend and process cards are always visible; expand the sections below to tune concurrency, session timeouts, or cost guardrails."
      />

      {/* Toast for BackendsSection / BackendSettingsSection immediate saves */}
      <SettingsToast toast={toast} />

      {/* ── Always visible: Backends (own save flow) ── */}
      <BackendsSection onToast={showToast} />

      <ExecutionModeSettings onToast={showToast} />

      <BackendSettingsSection onToast={showToast} sections={["processes"]} />

      {/* ── Collapsed by default — deferred save ── */}

      <CollapsibleSection title="Execution limits">
        <ConfigSection title="Execution limits">
          <p className="pb-2 text-xs text-muted-foreground">
            Concurrency and wall-clock limits that apply across every agent run,
            regardless of backend or tier.
          </p>
          <EditableField
            label="Max Concurrent Sessions"
            value={dv("maxConcurrentSessions", config.maxConcurrentSessions)}
            configKey="maxConcurrentSessions"
            type="number"
            modified={dirtyFields.has("maxConcurrentSessions")}
            defaultValue={df("maxConcurrentSessions")}
            description="Total number of agent sessions allowed to run in parallel across all sources (DMs, routines, schedules). Additional requests are queued until a slot opens."
            onSave={deferSave}
          />
          <EditableField
            label="Max Reactive Sessions"
            value={dv("maxReactiveSessions", config.maxReactiveSessions)}
            configKey="maxReactiveSessions"
            type="number"
            modified={dirtyFields.has("maxReactiveSessions")}
            defaultValue={df("maxReactiveSessions")}
            description="Subset of the concurrent slots reserved for reactive work (incoming DMs, mentions, and dashboard chat). This guarantees routines never starve out messages you send right now — and the remaining slots guarantee the reverse."
            onSave={deferSave}
          />
          <EditableField
            label="Execute Timeout"
            value={dv("executeTimeoutMinutes", config.executeTimeoutMinutes)}
            configKey="executeTimeoutMinutes"
            type="number"
            suffix="min"
            min={1}
            max={1440}
            modified={dirtyFields.has("executeTimeoutMinutes")}
            defaultValue={df("executeTimeoutMinutes")}
            description="Maximum wall-clock time for a single agent execution. When exceeded the run is cancelled so retries don&rsquo;t double-bill quota. Applies per attempt, not per retry chain."
            onSave={deferSave}
          />
          <EditableField
            label="Delegated Proxy Concurrency"
            value={dv("delegatedProxyMaxConcurrent", config.delegatedProxyMaxConcurrent)}
            configKey="delegatedProxyMaxConcurrent"
            type="number"
            min={1}
            max={64}
            modified={dirtyFields.has("delegatedProxyMaxConcurrent")}
            defaultValue={df("delegatedProxyMaxConcurrent")}
            description="Maximum simultaneous delegated-proxy invocations. Integrations in delegated mode (Gmail, Calendar, Notion) spawn a one-shot subprocess on the configured backend; excess requests FIFO-queue for up to 60 seconds, then fail. Raise this if you see queue timeouts; lower it to cap parallel backend cost."
            onSave={deferSave}
          />
        </ConfigSection>
      </CollapsibleSection>

      <CollapsibleSection title="Session timeouts">
        <ConfigSection title="Session timeouts">
          <p className="pb-2 text-xs text-muted-foreground">
            How long an idle conversation keeps its context before the next message
            starts fresh. Lower values save tokens on long-lived chats; higher values
            preserve continuity.
          </p>
          <EditableField
            label="DM Timeout"
            value={dv("sessionTimeoutDmMinutes", config.sessionTimeoutDmMinutes)}
            configKey="sessionTimeoutDmMinutes"
            type="number"
            suffix="min"
            modified={dirtyFields.has("sessionTimeoutDmMinutes")}
            defaultValue={df("sessionTimeoutDmMinutes")}
            description="Idle minutes before a direct-message session expires. Once expired, the next DM opens a new session without prior conversation history."
            onSave={deferSave}
          />
          <EditableField
            label="Channel Timeout"
            value={dv("sessionTimeoutChannelMinutes", config.sessionTimeoutChannelMinutes)}
            configKey="sessionTimeoutChannelMinutes"
            type="number"
            suffix="min"
            modified={dirtyFields.has("sessionTimeoutChannelMinutes")}
            defaultValue={df("sessionTimeoutChannelMinutes")}
            description="Idle minutes before an @mention thread in a public channel expires. Usually shorter than DM timeout since channel context rotates faster."
            onSave={deferSave}
          />
          <EditableField
            label="Dashboard Timeout"
            value={dv("sessionTimeoutDashboardMinutes", config.sessionTimeoutDashboardMinutes)}
            configKey="sessionTimeoutDashboardMinutes"
            type="number"
            suffix="min"
            modified={dirtyFields.has("sessionTimeoutDashboardMinutes")}
            defaultValue={df("sessionTimeoutDashboardMinutes")}
            description="Idle minutes before a dashboard Chat session expires. The session sidebar will still show it as a past conversation you can reopen."
            onSave={deferSave}
          />
        </ConfigSection>
      </CollapsibleSection>

      <CollapsibleSection title="Cost guardrails">
        <ConfigSection title="Cost guardrails">
          <p className="pb-2 text-xs text-muted-foreground">
            Guardrails and alert thresholds for autonomous routine spend. The
            daily cap can skip lower-priority routines; the monthly cap only
            notifies. Reactive work such as DMs and mentions still runs.
          </p>
          <EditableField
            label="Autonomous Daily Cost Cap"
            value={dv("autonomousDailyCostCapUsd", config.autonomousDailyCostCapUsd)}
            configKey="autonomousDailyCostCapUsd"
            type="number"
            suffix="$"
            nullable
            emptyLabel="Disabled"
            min={0.01}
            modified={dirtyFields.has("autonomousDailyCostCapUsd")}
            defaultValue={df("autonomousDailyCostCapUsd")}
            description="Maximum daily USD spend for autonomous sessions before lower-priority routines are skipped. Leave blank to disable the cap."
            onSave={deferSave}
          />
          <EditableField
            label="Autonomous Monthly Cost Cap (alert only)"
            value={dv("autonomousMonthlyCostCapUsd", config.autonomousMonthlyCostCapUsd)}
            configKey="autonomousMonthlyCostCapUsd"
            type="number"
            suffix="$"
            nullable
            emptyLabel="Disabled"
            min={0.01}
            modified={dirtyFields.has("autonomousMonthlyCostCapUsd")}
            defaultValue={df("autonomousMonthlyCostCapUsd")}
            description="Notification threshold for the rolling 30-day spend. Surfaces a warning at 80% and an error at 100% in the Notifications panel. No dispatcher enforcement — pair with the daily cap for hard guardrails."
            onSave={deferSave}
          />
        </ConfigSection>
      </CollapsibleSection>
    </>
  );
}
