"use client";

import { useConfig, useConfigDefaults } from "@/lib/hooks/use-config";
import { useDirtyFields } from "@/lib/hooks/use-dirty-fields";
import {
  ConfigSection,
  EditableBooleanField,
  EditableField,
} from "@/components/settings/editors";
import { VoiceModeSection } from "@/components/settings/voice-mode-section";
import { PageHeader } from "@/components/ui/page-header";

/**
 * Infrastructure — daemon runtime tuning, split out of the former monolithic
 * /settings/advanced page (DASHBOARD_UI_REFRESH_DESIGN.md follow-up #1).
 *
 * The poll-interval / history-injection / port knobs below existed in
 * PAGE_KEYS and the cmdk SETTINGS_INDEX since the initial release but were
 * never actually rendered anywhere — the ⌘K palette navigated to
 * /settings/advanced and silently failed to scroll. This page materializes
 * them with the standard deferred-save EditableField flow.
 */
export default function InfrastructureSettingsPage() {
  const { data: config } = useConfig();
  const { df } = useConfigDefaults();
  const { deferSaveFor, dv, dirtyFields } = useDirtyFields();

  if (!config) {
    return <div className="text-muted-foreground">Loading...</div>;
  }

  const deferSave = deferSaveFor(config);

  return (
    <>
      <PageHeader
        title="Infrastructure"
        description="Daemon runtime tuning — polling cadences, history injection, ports, and the local voice model. Low-level knobs; read each description before saving."
      />

      <ConfigSection title="Polling Intervals">
        <p className="pb-2 text-xs text-muted-foreground">
          How often each observer checks its source for changes. Lower values
          react faster but burn more API quota; the defaults are tuned for
          all-day background use. Observations still consolidate into the
          activity scan — these cadences only control detection latency.
        </p>
        <EditableField
          label="Obsidian Debounce"
          value={dv("obsidianDebounceSeconds", config.obsidianDebounceSeconds)}
          configKey="obsidianDebounceSeconds"
          type="number"
          suffix="sec"
          min={1}
          description="Quiet window after a vault file change before it is recorded — coalesces editor save bursts into one observation."
          modified={dirtyFields.has("obsidianDebounceSeconds")}
          defaultValue={df("obsidianDebounceSeconds")}
          onSave={deferSave}
        />
        <EditableField
          label="Scheduler Poll Interval"
          value={dv("schedulePollIntervalSeconds", config.schedulePollIntervalSeconds)}
          configKey="schedulePollIntervalSeconds"
          type="number"
          suffix="sec"
          min={1}
          description="How often the scheduler scans agent_schedule for due tasks."
          modified={dirtyFields.has("schedulePollIntervalSeconds")}
          defaultValue={df("schedulePollIntervalSeconds")}
          onSave={deferSave}
        />
        <EditableField
          label="Git Poll Interval"
          value={dv("gitPollIntervalSeconds", config.gitPollIntervalSeconds)}
          configKey="gitPollIntervalSeconds"
          type="number"
          suffix="sec"
          min={1}
          description="How often watched local repositories are scanned for new commits."
          modified={dirtyFields.has("gitPollIntervalSeconds")}
          defaultValue={df("gitPollIntervalSeconds")}
          onSave={deferSave}
        />
        <EditableField
          label="Notion Poll Interval"
          value={dv("notionPollIntervalSeconds", config.notionPollIntervalSeconds)}
          configKey="notionPollIntervalSeconds"
          type="number"
          suffix="sec"
          min={1}
          description="How often watched Notion databases are checked for edits (direct mode only)."
          modified={dirtyFields.has("notionPollIntervalSeconds")}
          defaultValue={df("notionPollIntervalSeconds")}
          onSave={deferSave}
        />
        <EditableField
          label="Calendar Poll Interval"
          value={dv("calendarPollIntervalSeconds", config.calendarPollIntervalSeconds)}
          configKey="calendarPollIntervalSeconds"
          type="number"
          suffix="sec"
          min={1}
          description="How often Google Calendar is checked for event changes (direct mode only)."
          modified={dirtyFields.has("calendarPollIntervalSeconds")}
          defaultValue={df("calendarPollIntervalSeconds")}
          onSave={deferSave}
        />
        <EditableField
          label="Gmail Poll Interval"
          value={dv("gmailPollIntervalSeconds", config.gmailPollIntervalSeconds)}
          configKey="gmailPollIntervalSeconds"
          type="number"
          suffix="sec"
          min={1}
          description="How often the Gmail inbox poller runs (direct mode only)."
          modified={dirtyFields.has("gmailPollIntervalSeconds")}
          defaultValue={df("gmailPollIntervalSeconds")}
          onSave={deferSave}
        />
      </ConfigSection>

      <ConfigSection title="History Injection">
        <p className="pb-2 text-xs text-muted-foreground">
          How much prior conversation is replayed into a resumed session.
          Larger budgets give the agent more recall at higher per-turn token
          cost.
        </p>
        <EditableField
          label="Max Messages"
          value={dv("historyInjectionMaxMessages", config.historyInjectionMaxMessages)}
          configKey="historyInjectionMaxMessages"
          type="number"
          min={1}
          description="Upper bound on replayed messages per session resume."
          modified={dirtyFields.has("historyInjectionMaxMessages")}
          defaultValue={df("historyInjectionMaxMessages")}
          onSave={deferSave}
        />
        <EditableField
          label="Max Tokens"
          value={dv("historyInjectionMaxTokens", config.historyInjectionMaxTokens)}
          configKey="historyInjectionMaxTokens"
          type="number"
          min={1}
          description="Token budget for the injected history block — applied after the message cap."
          modified={dirtyFields.has("historyInjectionMaxTokens")}
          defaultValue={df("historyInjectionMaxTokens")}
          onSave={deferSave}
        />
        <EditableBooleanField
          label="Strict DM Staleness"
          value={dv("dmStalenessStrict", config.dmStalenessStrict)}
          configKey="dmStalenessStrict"
          description="Invalidate resumed DM context more aggressively when the underlying session looks stale."
          modified={dirtyFields.has("dmStalenessStrict")}
          defaultValue={df("dmStalenessStrict")}
          onSave={deferSave}
        />
      </ConfigSection>

      <ConfigSection title="Infrastructure">
        <EditableField
          label="API Port"
          value={dv("apiPort", config.apiPort)}
          configKey="apiPort"
          type="number"
          min={1}
          max={65535}
          description="TCP port the daemon's Hono API listens on. The dashboard proxy and every skill curl target this port."
          modified={dirtyFields.has("apiPort")}
          defaultValue={df("apiPort")}
          onSave={deferSave}
        />
        <EditableBooleanField
          label="Disable Auth Probes"
          value={dv("authProbeDisabled", config.authProbeDisabled)}
          configKey="authProbeDisabled"
          description="Turn off the periodic backend auth-health probes. Auth failures then surface only when a real session hits them."
          modified={dirtyFields.has("authProbeDisabled")}
          defaultValue={df("authProbeDisabled")}
          onSave={deferSave}
        />
        <EditableField
          label="Auth Preflight Freshness"
          value={dv("authPreflightFreshnessMs", config.authPreflightFreshnessMs)}
          configKey="authPreflightFreshnessMs"
          type="number"
          suffix="ms"
          min={0}
          description="How long a successful auth-health result is trusted before the pre-dispatch check re-probes."
          modified={dirtyFields.has("authPreflightFreshnessMs")}
          defaultValue={df("authPreflightFreshnessMs")}
          onSave={deferSave}
        />
      </ConfigSection>

      <VoiceModeSection />
    </>
  );
}
