"use client";

import { useCallback } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  User,
  Clock,
  Cpu,
  Terminal,
  BookOpenText,
  BookText,
  History,
  SlidersHorizontal,
  Repeat,
  ClipboardList,
  Sparkles,
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

const NAV_ITEMS: NavItem[] = [
  {
    href: "/settings",
    label: "Profile",
    icon: User,
    description: "Identity and time axis",
  },
  {
    href: "/settings/schedule",
    label: "Schedule",
    icon: Clock,
    description: "Hourly check, quiet hours, notifications",
  },
  {
    href: "/settings/routines",
    label: "Routines",
    icon: Repeat,
    description: "Per-cadence check rulebooks and custom cron routines",
  },
  {
    href: "/settings/self-learning",
    label: "Self-learning",
    icon: Sparkles,
    description: "Knowledge-map skill curation (Preview)",
  },
  {
    href: "/settings/management",
    label: "Management",
    icon: ClipboardList,
    description: "Source-of-truth bindings and managed tasks",
  },
  {
    href: "/settings/journal",
    label: "Journal",
    icon: BookText,
    description: "Daily journal format template and export redaction rules",
  },
  {
    href: "/settings/models",
    label: "Models",
    icon: Cpu,
    description: "Backends, routing, execution limits",
  },
  {
    href: "/settings/wiki",
    label: "Wiki",
    icon: BookOpenText,
    description: "Workspace, commands, wiki budgets",
  },
  {
    href: "/settings/integrations/browser-history",
    label: "Browser History",
    icon: History,
    description: "Consent, browser detection, lifecycle",
  },
  {
    href: "/settings/commands",
    label: "Commands",
    icon: Terminal,
    description: "Messaging shortcuts and custom prompts",
  },
  {
    href: "/settings/advanced",
    label: "Advanced",
    icon: SlidersHorizontal,
    description: "Safety, infrastructure, danger zone",
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
  "/settings/schedule": [
    "timezone", "dayBoundaryHour",
    "hourlyCheckEnabled", "hourlyCheckIntervalMinutes",
    "hourlyCheckActiveStartHour", "hourlyCheckActiveEndHour", "hourlyCheckMinObservations",
    "monthlyReviewEnabled",
    "maxNotificationsPerHour", "maxNotificationsPerDay",
    "quietHoursStart", "quietHoursEnd", "batchIntervalMinutes",
    "defaultNotificationPlatforms", "primaryPlatform",
  ],
  "/settings/models": [
    "maxConcurrentSessions", "maxReactiveSessions", "delegatedProxyMaxConcurrent", "executeTimeoutMinutes",
    "sessionTimeoutDmMinutes", "sessionTimeoutChannelMinutes", "sessionTimeoutDashboardMinutes",
    "autonomousDailyCostCapUsd",
    "autonomousMonthlyCostCapUsd",
    // advisorEnabled / advisorModel are managed by BackendsAndPlansSection (own save flow, not deferred)
  ],
  "/settings/advanced": [
    "disallowedTools", "allowedToolsOverride",
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
      <ul className="flex flex-row gap-1 overflow-x-auto md:flex-col md:gap-0.5">
        {NAV_ITEMS.map((item) => {
          const active =
            item.href === "/settings"
              ? pathname === item.href
              : pathname.startsWith(item.href);
          const Icon = item.icon;
          const pageDirtyCount = dirtyCountForPage(item.href);

          return (
            <li key={item.href}>
              <Link
                href={item.href}
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
                        className="ml-1.5 inline-block h-2 w-2 rounded-full bg-blue-500"
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
