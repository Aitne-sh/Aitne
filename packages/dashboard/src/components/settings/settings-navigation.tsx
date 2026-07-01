"use client";

import { useCallback } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  User,
  Clock,
  Cpu,
  Terminal,
  AlertTriangle,
  BookOpenText,
  History,
  MonitorCog,
  ShieldCheck,
  SlidersHorizontal,
  ClipboardList,
  Sparkles,
  GraduationCap,
  type LucideIcon,
} from "lucide-react";
import type { EditableConfigKey } from "@aitne/shared";
import { Alert } from "@/components/ui/alert";
import { cn } from "@/lib/utils";
import { useDirtyFields } from "@/lib/hooks/use-dirty-fields";

export type SettingsToastState = {
  type: "success" | "error" | "warning" | "info";
  message: string;
};

type NavItem = {
  href: string;
  label: string;
  icon: LucideIcon;
  description: string;
};

type NavGroup = {
  label: string;
  items: NavItem[];
};

/**
 * Settings IA — grouped by what the user is configuring, not by when the
 * page was added. Routes are unchanged (deep links and PAGE_KEYS stay
 * valid); only the navigation presentation is grouped.
 */
const NAV_GROUPS: NavGroup[] = [
  {
    label: "Agent",
    items: [
      {
        href: "/settings",
        label: "Profile",
        icon: User,
        description: "Identity, personality, language",
      },
      {
        href: "/settings/hours",
        label: "Hours & Notifications",
        icon: Clock,
        description: "Timezone, day boundary, quiet hours, notification caps",
      },
    ],
  },
  {
    label: "Intelligence",
    items: [
      {
        href: "/settings/models",
        label: "Models",
        icon: Cpu,
        description: "Backends, routing, execution limits",
      },
      {
        href: "/settings/self-learning",
        label: "Self-learning",
        icon: Sparkles,
        description: "Knowledge-map skill curation (Preview)",
      },
      {
        href: "/settings/lessons",
        label: "Lessons",
        icon: GraduationCap,
        description: "Feedback learning — view/edit lessons, tune caps (Preview)",
      },
      {
        href: "/settings/wiki",
        label: "Wiki",
        icon: BookOpenText,
        description: "Workspace, commands, wiki budgets",
      },
    ],
  },
  {
    label: "Operations",
    items: [
      {
        href: "/settings/management",
        label: "Management",
        icon: ClipboardList,
        description: "Source-of-truth bindings and managed tasks",
      },
      {
        href: "/settings/commands",
        label: "Commands",
        icon: Terminal,
        description: "Messaging shortcuts and custom prompts",
      },
    ],
  },
  {
    label: "Browser",
    items: [
      {
        href: "/settings/integrations/browser-history",
        label: "Browser History",
        icon: History,
        description: "Read from your existing Chrome",
      },
      {
        href: "/settings/integrations/browser-history-managed",
        label: "Browser Automation",
        icon: MonitorCog,
        description: "Dedicated Chromium (OAuth + tasks)",
      },
    ],
  },
  {
    label: "System",
    items: [
      {
        href: "/settings/safety",
        label: "Safety",
        icon: ShieldCheck,
        description: "Tool-policy guardrails for every backend",
      },
      {
        href: "/settings/infrastructure",
        label: "Infrastructure",
        icon: SlidersHorizontal,
        description: "Polling, history injection, ports, voice model",
      },
      {
        href: "/settings/danger-zone",
        label: "Danger Zone",
        icon: AlertTriangle,
        description: "Destructive maintenance actions",
      },
    ],
  },
];

/**
 * Maps each settings page path to the deferred-save config keys displayed
 * on that page.  Used to show per-page dirty indicators in the sidebar.
 *
 * KEEP IN SYNC: when adding or removing an EditableField / EditableBooleanField /
 * EditableArrayField with `onSave={deferSave}` on a settings page, update
 * this mapping. Missing keys won't cause errors but the dirty dot won't
 * appear for that field's page. Extraneous keys are harmless (the field
 * would need to be in the dirty map, which only happens via actual edits).
 */
const PAGE_KEYS: Record<string, readonly EditableConfigKey[]> = {
  "/settings": [
    "agentDisplayName", "character",
    "primaryLanguage",
    // `vaultMode` / `primaryVaultPath` are migration-only — handled by
    // ManagementModeSection's dialog, not defer-save, so they don't
    // participate in the page dirty-dot indicator.
  ],
  "/settings/hours": [
    "timezone", "dayBoundaryHour",
    "maxNotificationsPerHour", "maxNotificationsPerDay",
    "quietHoursStart", "quietHoursEnd", "batchIntervalMinutes",
    "defaultNotificationPlatforms", "primaryPlatform",
    "backendFailureDmAlerts",
  ],
  "/settings/models": [
    "maxConcurrentSessions", "maxReactiveSessions", "delegatedProxyMaxConcurrent", "executeTimeoutMinutes",
    "sessionTimeoutDmMinutes", "sessionTimeoutChannelMinutes", "sessionTimeoutDashboardMinutes",
    "autonomousDailyCostCapUsd",
    "autonomousMonthlyCostCapUsd",
    // advisorEnabled / advisorModel are managed by BackendsAndPlansSection (own save flow, not deferred)
  ],
  // Feedback Learning Loop (FEEDBACK_LEARNING_LOOP_DESIGN.md §9 Phase 5) — the
  // six tuning knobs use the deferred-save EditableField flow, so the sidebar
  // dirty dot needs them mapped here.
  "/settings/lessons": [
    "feedbackLearningEnabled",
    "feedbackPromotionThreshold",
    "feedbackLessonMaxBytesGlobal",
    "feedbackLessonMaxBytesPerAgent",
    "feedbackLessonStaleDays",
    "feedbackSignalRetentionDays",
  ],
  // DASHBOARD_UI_REFRESH_DESIGN.md follow-up #1 — the former /settings/advanced
  // keys split across the Safety and Infrastructure pages. Danger Zone has no
  // deferred-save keys (its actions are immediate, confirm-gated POSTs).
  "/settings/safety": [
    "disallowedTools", "allowedToolsOverride",
  ],
  "/settings/infrastructure": [
    "obsidianDebounceSeconds", "schedulePollIntervalSeconds", "gitPollIntervalSeconds",
    "notionPollIntervalSeconds", "calendarPollIntervalSeconds", "gmailPollIntervalSeconds",
    "historyInjectionMaxMessages", "historyInjectionMaxTokens", "dmStalenessStrict",
    "apiPort",
    "authProbeDisabled", "authPreflightFreshnessMs",
  ],
  "/settings/integrations/browser-history": [
    "browserHistoryConsentAccepted",
    "browserHistoryBrowserOverrides",
    "browserHistoryCategories",
    "browserHistoryRetentionDays",
    "browserHistorySearchQueryRetentionDays",
    "browserHistoryLifecycle",
  ],
  // BROWSER_TASK_REDESIGN_PLAN.md §9a.10 — Phase 1 introduces three
  // user-tunable settings (slot policy + quiet-hours respect) that live
  // on the Browser Automation settings page (route still named
  // `browser-history-managed` for backward compatibility). Without this
  // PAGE_KEYS entry edits would silently lose their dirty marker and the
  // sidebar dot wouldn't appear.
  "/settings/integrations/browser-history-managed": [
    "browserTaskMaxConcurrent",
    "browserTaskPendingQueueTimeoutMinutes",
    "browserTaskRespectQuietHours",
    // 2026-05-27 open-navigation revision — user-curated hostname
    // denylist for the browser-task surface. Editor lives in a new
    // card on the same Browser Automation page so the sidebar dirty
    // dot covers it without adding a new top-level entry.
    "browserTaskHostnameDenylist",
  ],
};

export function SettingsNavigation() {
  const pathname = usePathname();
  const { dirtyFields } = useDirtyFields();

  /** Count how many dirty keys belong to a given page. */
  const dirtyCountForPage = useCallback(
    (href: string): number => {
      const keys = PAGE_KEYS[href];
      if (!keys) return 0;
      return keys.filter((k) => dirtyFields.has(k)).length;
    },
    [dirtyFields],
  );

  return (
    <nav
      aria-label="Settings sections"
      className="w-full md:w-60 md:shrink-0"
    >
      <div className="flex flex-row gap-1 overflow-x-auto md:flex-col md:gap-4">
        {NAV_GROUPS.map((group) => (
          <div key={group.label} className="flex flex-row gap-1 md:block">
            {/* Group headers only make sense in the vertical (md+) layout —
                the mobile horizontal scroller stays a flat chip row. */}
            <p className="hidden px-3 pb-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground/70 md:block">
              {group.label}
            </p>
            <ul className="flex flex-row gap-1 md:flex-col md:gap-0.5">
              {group.items.map((item) => {
                // Use exact match OR prefix-with-`/` boundary so sibling routes
                // don't fight for the active state — e.g. `/settings/integrations/
                // browser-history-managed` previously matched both `/…/browser-
                // history` and `/…/browser-history-managed` because plain
                // `startsWith` ignores the segment boundary.
                const active =
                  pathname === item.href
                  || (item.href !== "/settings"
                    && pathname.startsWith(item.href + "/"));
                const Icon = item.icon;
                const pageDirtyCount = dirtyCountForPage(item.href);

                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      // Scroll containment lives in SettingsContent (it
                      // resets its own pane on route change); without
                      // scroll={false} Next.js would also scroll the outer
                      // LayoutShell pane and the whole frame jumps.
                      scroll={false}
                      aria-current={active ? "page" : undefined}
                      className={cn(
                        "group flex items-center gap-3 whitespace-nowrap rounded-lg px-3 py-2 text-sm transition-colors md:whitespace-normal",
                        active
                          ? "bg-primary/10 text-primary font-medium"
                          : "text-muted-foreground hover:bg-accent hover:text-foreground",
                      )}
                    >
                      <Icon className="h-4 w-4 shrink-0" />
                      <span className="flex-1">
                        <span className="block">
                          {item.label}
                          {pageDirtyCount > 0 && (
                            <span
                              className="ml-1.5 inline-block h-2 w-2 rounded-full bg-primary"
                              title={`${pageDirtyCount} unsaved change${pageDirtyCount !== 1 ? "s" : ""}`}
                            />
                          )}
                        </span>
                        <span
                          className={cn(
                            "hidden text-[11px] font-normal md:block",
                            active
                              ? "text-primary/70"
                              : "text-muted-foreground/70 group-hover:text-muted-foreground",
                          )}
                        >
                          {item.description}
                        </span>
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>
      <div className="hidden md:block mt-4 px-3">
        <kbd className="text-[10px] text-muted-foreground/60 font-mono">
          {"⌘K"}
        </kbd>
        <span className="text-[10px] text-muted-foreground/60 ml-1.5">
          Search settings
        </span>
      </div>
    </nav>
  );
}

export function SettingsToast({
  toast,
}: {
  toast: SettingsToastState | null;
}) {
  if (!toast) {
    return null;
  }

  return (
    <Alert variant={toast.type} className="rounded-lg px-4 py-2.5 text-sm">
      {toast.message}
    </Alert>
  );
}
