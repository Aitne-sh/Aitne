"use client";

import { useCallback, useEffect, useState } from "react";
import { Command } from "cmdk";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { HelpCircle, type LucideIcon, Search } from "lucide-react";
import { docIdForPath } from "@/lib/docs/page-doc-map";
import { openDocsHelpSlideover } from "@/lib/docs/slideover-cache";

// ---------------------------------------------------------------------------
// Discriminated entry shape (DOCS_QA_DASHBOARD_DESIGN.md §9 / §15-D5).
// ---------------------------------------------------------------------------

interface SettingsEntry {
  kind: "setting";
  /** Human-readable field label */
  label: string;
  /** configKey — also used as the scroll target via data-config-key */
  configKey: string;
  /** Route to navigate to */
  page: string;
  /** Section heading the field lives under */
  section: string;
  /** Extra keywords to broaden search matches */
  keywords: string;
}

interface ActionEntry {
  kind: "action";
  /** Stable id used for testing and React keys. */
  id: string;
  /** Human-readable label rendered in the palette. */
  label: string;
  /** Group heading this entry sits under (e.g. "Help"). */
  group: string;
  /** Lucide icon shown to the left of the label. */
  icon: LucideIcon;
  /** Free-form keywords for fuzzy matching. */
  keywords: string;
  /** Imperative effect when the operator selects the entry. */
  onSelect: (ctx: PaletteCtx) => void;
}

type PaletteEntry = SettingsEntry | ActionEntry;

interface PaletteCtx {
  pathname: string;
  searchParams: URLSearchParams;
  queryClient: QueryClient;
  router: ReturnType<typeof useRouter>;
}

// ---------------------------------------------------------------------------
// Search index — every settings field across the 5 pages
// ---------------------------------------------------------------------------

/**
 * Exported for the BROWSER_TASK_REDESIGN_PLAN.md §9a regression test —
 * see `cmdk-palette.browser-tasks.test.ts`. Re-exporting an array of
 * pure data has no runtime cost and lets the test snapshot the live
 * surface so a stale `"Workflow Approvals (B-3)"` entry from a future
 * merge cannot silently land.
 */
export const SETTINGS_INDEX: SettingsEntry[] = [
  // -- Profile (/settings) --
  { kind: "setting", label: "Display Name", configKey: "agentDisplayName", page: "/settings", section: "Agent Identity", keywords: "name agent" },
  { kind: "setting", label: "Character", configKey: "character", page: "/settings", section: "Personality", keywords: "character persona tone style voice prompt" },

  // -- Schedule (/settings/schedule) --
  { kind: "setting", label: "Timezone", configKey: "timezone", page: "/settings/schedule", section: "Day Shape", keywords: "tz iana time zone" },
  { kind: "setting", label: "Day Boundary Hour", configKey: "dayBoundaryHour", page: "/settings/schedule", section: "Day Shape", keywords: "day start reset boundary" },
  { kind: "setting", label: "Hourly Check Enabled", configKey: "hourlyCheckEnabled", page: "/settings/schedule", section: "Hourly Check", keywords: "polling observation toggle" },
  { kind: "setting", label: "Check Interval", configKey: "hourlyCheckIntervalMinutes", page: "/settings/schedule", section: "Hourly Check", keywords: "poll frequency minutes" },
  { kind: "setting", label: "Active Start Hour", configKey: "hourlyCheckActiveStartHour", page: "/settings/schedule", section: "Hourly Check", keywords: "active window start" },
  { kind: "setting", label: "Active End Hour", configKey: "hourlyCheckActiveEndHour", page: "/settings/schedule", section: "Hourly Check", keywords: "active window end" },
  { kind: "setting", label: "Min Observations", configKey: "hourlyCheckMinObservations", page: "/settings/schedule", section: "Hourly Check", keywords: "threshold minimum" },
  { kind: "setting", label: "Monthly Review Enabled", configKey: "monthlyReviewEnabled", page: "/settings/schedule", section: "Monthly Review", keywords: "monthly review retro experimental kill switch toggle disabled" },
  { kind: "setting", label: "Background Sync Cadences", configKey: "", page: "/settings/schedule", section: "Background Sync", keywords: "delegated drift cadence calendar gmail notion poll interval" },
  { kind: "setting", label: "Background Sync Active Hours", configKey: "", page: "/settings/schedule", section: "Background Sync", keywords: "delegated cadence active hours quiet schedule window" },
  { kind: "setting", label: "Max Notifications Per Hour", configKey: "maxNotificationsPerHour", page: "/settings/schedule", section: "Notifications", keywords: "rate limit hourly" },
  { kind: "setting", label: "Max Notifications Per Day", configKey: "maxNotificationsPerDay", page: "/settings/schedule", section: "Notifications", keywords: "rate limit daily" },
  { kind: "setting", label: "Quiet Hours Start", configKey: "quietHoursStart", page: "/settings/schedule", section: "Notifications", keywords: "do not disturb dnd silent" },
  { kind: "setting", label: "Quiet Hours End", configKey: "quietHoursEnd", page: "/settings/schedule", section: "Notifications", keywords: "do not disturb dnd silent" },
  { kind: "setting", label: "Batch Interval", configKey: "batchIntervalMinutes", page: "/settings/schedule", section: "Notifications", keywords: "batch group delay" },
  { kind: "setting", label: "Fallback Primary Platform", configKey: "primaryPlatform", page: "/settings/schedule", section: "Notifications", keywords: "default platform channel" },

  // -- Models (/settings/models) --
  { kind: "setting", label: "Max Concurrent Sessions", configKey: "maxConcurrentSessions", page: "/settings/models", section: "Execution Limits", keywords: "parallel sessions concurrency" },
  { kind: "setting", label: "Max Reactive Sessions", configKey: "maxReactiveSessions", page: "/settings/models", section: "Execution Limits", keywords: "reactive sessions limit" },
  { kind: "setting", label: "Execute Timeout", configKey: "executeTimeoutMinutes", page: "/settings/models", section: "Execution Limits", keywords: "timeout minutes wall clock" },
  { kind: "setting", label: "Delegated Proxy Concurrency", configKey: "delegatedProxyMaxConcurrent", page: "/settings/models", section: "Execution Limits", keywords: "delegated proxy concurrency mail calendar gmail subprocess" },
  { kind: "setting", label: "DM Timeout", configKey: "sessionTimeoutDmMinutes", page: "/settings/models", section: "Session Timeouts", keywords: "direct message timeout" },
  { kind: "setting", label: "Channel Timeout", configKey: "sessionTimeoutChannelMinutes", page: "/settings/models", section: "Session Timeouts", keywords: "channel mention timeout" },
  { kind: "setting", label: "Dashboard Timeout", configKey: "sessionTimeoutDashboardMinutes", page: "/settings/models", section: "Session Timeouts", keywords: "dashboard chat timeout" },

  // -- Advanced (/settings/advanced) --
  { kind: "setting", label: "Disallowed Tools", configKey: "disallowedTools", page: "/settings/advanced", section: "Safety — Tool Policy", keywords: "blocked forbidden tools safety" },
  { kind: "setting", label: "Allowed Tools Override", configKey: "allowedToolsOverride", page: "/settings/advanced", section: "Safety — Tool Policy", keywords: "allowed exception permit" },
  { kind: "setting", label: "Obsidian Debounce", configKey: "obsidianDebounceSeconds", page: "/settings/advanced", section: "Polling Intervals", keywords: "obsidian vault debounce" },
  { kind: "setting", label: "Scheduler Poll Interval", configKey: "schedulePollIntervalSeconds", page: "/settings/advanced", section: "Polling Intervals", keywords: "scheduler recurring tasks poll" },
  { kind: "setting", label: "Git Poll Interval", configKey: "gitPollIntervalSeconds", page: "/settings/advanced", section: "Polling Intervals", keywords: "git repo poll" },
  { kind: "setting", label: "Notion Poll Interval", configKey: "notionPollIntervalSeconds", page: "/settings/advanced", section: "Polling Intervals", keywords: "notion database poll" },
  { kind: "setting", label: "Calendar Poll Interval", configKey: "calendarPollIntervalSeconds", page: "/settings/advanced", section: "Polling Intervals", keywords: "google calendar poll" },
  { kind: "setting", label: "Gmail Poll Interval", configKey: "gmailPollIntervalSeconds", page: "/settings/advanced", section: "Polling Intervals", keywords: "gmail inbox poll" },
  { kind: "setting", label: "Max Messages", configKey: "historyInjectionMaxMessages", page: "/settings/advanced", section: "History Injection", keywords: "history context messages" },
  { kind: "setting", label: "Max Tokens", configKey: "historyInjectionMaxTokens", page: "/settings/advanced", section: "History Injection", keywords: "history context tokens budget" },
  { kind: "setting", label: "Strict DM Staleness", configKey: "dmStalenessStrict", page: "/settings/advanced", section: "History Injection", keywords: "dm resume context stale invalidation strict" },
  { kind: "setting", label: "API Port", configKey: "apiPort", page: "/settings/advanced", section: "Infrastructure", keywords: "port hono daemon tcp" },
  { kind: "setting", label: "Disable Auth Probes", configKey: "authProbeDisabled", page: "/settings/advanced", section: "Infrastructure", keywords: "auth health probe disable" },
  { kind: "setting", label: "Auth Preflight Freshness", configKey: "authPreflightFreshnessMs", page: "/settings/advanced", section: "Infrastructure", keywords: "backend auth preflight cache freshness" },
  { kind: "setting", label: "Autonomous Daily Cost Cap", configKey: "autonomousDailyCostCapUsd", page: "/settings/models", section: "Cost Guardrails", keywords: "daily cost cap autonomous routines budget" },
  { kind: "setting", label: "Autonomous Monthly Cost Cap", configKey: "autonomousMonthlyCostCapUsd", page: "/settings/models", section: "Cost Guardrails", keywords: "monthly cost cap autonomous notification alert budget" },

  // -- Browser Automation (/settings/integrations/browser-history-managed) — page-level navigation only --
  { kind: "setting", label: "Browser Automation (master toggle)", configKey: "", page: "/settings/integrations/browser-history-managed", section: "Browser Automation", keywords: "chromium browser automation managed sync oauth instance s playwright sandbox bwrap" },
  { kind: "setting", label: "Authenticated sites", configKey: "", page: "/settings/integrations/browser-history-managed", section: "Browser Automation", keywords: "amazon netflix x twitter facebook instagram linkedin site auth sign-in profile connect reauth disconnect chromium" },
  { kind: "setting", label: "Purchase confirmations (experimental)", configKey: "", page: "/settings/integrations/browser-history-managed/b4", section: "Browser Automation", keywords: "purchase b4 buy checkout cart token caps daily spend experimental danger workflows chromium" },
  { kind: "setting", label: "Purchase per-site caps", configKey: "", page: "/settings/integrations/browser-history-managed/b4", section: "Browser Automation", keywords: "currency daily token cap spend cap per transaction limit site b4" },
  { kind: "setting", label: "Purchase primary DM channels", configKey: "", page: "/settings/integrations/browser-history-managed/b4", section: "Browser Automation", keywords: "primary dm channel token delivery slack telegram discord whatsapp b4" },
  // BROWSER_TASK_REDESIGN_PLAN.md §9a.1 — top-level browser-task surface.
  { kind: "setting", label: "Browser Tasks (list)", configKey: "", page: "/browser-tasks", section: "Browser Tasks", keywords: "browser task list runs in-flight completed natural language" },
  { kind: "setting", label: "Browser Task — needs your attention", configKey: "", page: "/browser-tasks", section: "Browser Tasks", keywords: "awaiting clarification final confirm pending parked needs attention" },
  { kind: "setting", label: "Cancel browser task", configKey: "", page: "/browser-tasks", section: "Browser Tasks", keywords: "cancel browser task stop abort" },

  // -- Connections (top-level /connections) — page-level navigation only --
  { kind: "setting", label: "Slack", configKey: "", page: "/connections/messaging", section: "Messaging", keywords: "slack bot token channel messaging" },
  { kind: "setting", label: "Telegram", configKey: "", page: "/connections/messaging", section: "Messaging", keywords: "telegram bot chat messaging" },
  { kind: "setting", label: "Discord", configKey: "", page: "/connections/messaging", section: "Messaging", keywords: "discord bot messaging" },
  { kind: "setting", label: "WhatsApp", configKey: "", page: "/connections/messaging", section: "Messaging", keywords: "whatsapp messaging phone" },
  { kind: "setting", label: "Notification Destinations", configKey: "", page: "/connections/messaging", section: "Messaging", keywords: "default notification platform destination" },
  { kind: "setting", label: "Repositories", configKey: "", page: "/connections/repositories", section: "Repositories", keywords: "git github repository watch clone webhook" },
  { kind: "setting", label: "Notion", configKey: "", page: "/connections/knowledge", section: "Knowledge", keywords: "notion database api" },
  { kind: "setting", label: "Obsidian", configKey: "", page: "/connections/knowledge", section: "Knowledge", keywords: "obsidian vault markdown" },
  { kind: "setting", label: "Google Calendar", configKey: "", page: "/connections/calendar", section: "Calendar", keywords: "google oauth calendar" },
  { kind: "setting", label: "Mail accounts", configKey: "", page: "/connections/mail", section: "Mail", keywords: "gmail outlook imap yahoo icloud mailbox" },
  { kind: "setting", label: "MCP Servers", configKey: "", page: "/connections/mcp", section: "MCP", keywords: "mcp model context protocol" },
];

/**
 * Exported for the §12 / §15-D5 regression test that asserts the docs
 * action exists, is keyword-searchable, and dispatches into the
 * slide-over cache. See `cmdk-palette.actions.test.ts`.
 */
export const ACTION_ENTRIES: ActionEntry[] = [
  {
    kind: "action",
    id: "docs.ask",
    label: "Ask docs…",
    group: "Help",
    icon: HelpCircle,
    keywords: "docs help question how guide manual",
    onSelect: ({ pathname, searchParams, queryClient }) => {
      openDocsHelpSlideover(queryClient, {
        docId: docIdForPath(pathname, searchParams),
        autoFocusComposer: true,
      });
    },
  },
];

// Page labels for the group headings
const PAGE_LABELS: Record<string, string> = {
  "/settings": "Profile",
  "/settings/schedule": "Schedule",
  "/settings/models": "Models",
  "/settings/advanced": "Advanced",
  "/settings/integrations/browser-history-managed": "Browser Automation",
  "/settings/integrations/browser-history-managed/b4": "Browser Automation — B-4",
  "/browser-tasks": "Browser Tasks",
  "/connections/messaging": "Connections — Messaging",
  "/connections/repositories": "Connections — Repositories",
  "/connections/knowledge": "Connections — Knowledge",
  "/connections/calendar": "Connections — Calendar",
  "/connections/mail": "Connections — Mail",
  "/connections/mcp": "Connections — MCP",
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function CmdkPalette() {
  const [open, setOpen] = useState(false);
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();

  // Cmd+K / Ctrl+K keyboard shortcut
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setOpen((prev) => !prev);
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, []);

  const handleSelect = useCallback(
    (entry: PaletteEntry) => {
      setOpen(false);

      if (entry.kind === "action") {
        // Build a fresh URLSearchParams snapshot so the action sees the
        // exact shape it would see from a button click. Avoids leaking
        // the Next.js ReadonlyURLSearchParams identity into action code.
        const search = new URLSearchParams(
          Array.from(searchParams.entries()),
        );
        entry.onSelect({ pathname, searchParams: search, queryClient, router });
        return;
      }

      const needsNavigation = pathname !== entry.page;
      if (needsNavigation) {
        router.push(entry.page);
      }

      // Scroll to the field after navigation settles
      if (entry.configKey) {
        const delay = needsNavigation ? 300 : 50;
        setTimeout(() => {
          const el = document.querySelector(
            `[data-config-key="${entry.configKey}"]`,
          );
          if (el) {
            el.scrollIntoView({ behavior: "smooth", block: "center" });
            // Brief highlight flash
            el.classList.add("cmdk-highlight");
            setTimeout(() => el.classList.remove("cmdk-highlight"), 1500);
          }
        }, delay);
      }
    },
    [pathname, queryClient, router, searchParams],
  );

  // Group entries by page (settings) and by group (actions).
  const settingsByPage = new Map<string, SettingsEntry[]>();
  for (const entry of SETTINGS_INDEX) {
    const list = settingsByPage.get(entry.page) ?? [];
    list.push(entry);
    settingsByPage.set(entry.page, list);
  }
  const actionsByGroup = new Map<string, ActionEntry[]>();
  for (const entry of ACTION_ENTRIES) {
    const list = actionsByGroup.get(entry.group) ?? [];
    list.push(entry);
    actionsByGroup.set(entry.group, list);
  }

  return (
    <Command.Dialog
      open={open}
      onOpenChange={setOpen}
      label="Search settings or actions"
      className="cmdk-dialog"
    >
      <div className="cmdk-input-wrapper">
        <Search className="cmdk-input-icon" />
        <Command.Input
          placeholder="Search settings or actions..."
          className="cmdk-input"
        />
      </div>
      <Command.List className="cmdk-list">
        <Command.Empty className="cmdk-empty">
          No matches.
        </Command.Empty>
        {[...actionsByGroup.entries()].map(([group, entries]) => (
          <Command.Group
            key={`actions:${group}`}
            heading={group}
            className="cmdk-group"
          >
            {entries.map((entry) => (
              <Command.Item
                key={`action:${entry.id}`}
                value={`${entry.label} ${entry.keywords}`}
                onSelect={() => handleSelect(entry)}
                className="cmdk-item"
                data-action-id={entry.id}
              >
                <entry.icon className="mr-2 h-4 w-4 shrink-0" aria-hidden="true" />
                <span className="cmdk-item-label">{entry.label}</span>
              </Command.Item>
            ))}
          </Command.Group>
        ))}
        {[...settingsByPage.entries()].map(([page, entries]) => (
          <Command.Group
            key={page}
            heading={PAGE_LABELS[page] ?? page}
            className="cmdk-group"
          >
            {entries.map((entry) => (
              <Command.Item
                key={`${entry.page}:${entry.configKey || entry.label}`}
                value={`${entry.label} ${entry.section} ${entry.keywords}`}
                onSelect={() => handleSelect(entry)}
                className="cmdk-item"
              >
                <span className="cmdk-item-label">{entry.label}</span>
                <span className="cmdk-item-section">{entry.section}</span>
              </Command.Item>
            ))}
          </Command.Group>
        ))}
      </Command.List>
    </Command.Dialog>
  );
}
