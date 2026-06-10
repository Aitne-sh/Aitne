"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, useSyncExternalStore } from "react";
import { APP_NAME, DEFAULT_AGENT_DISPLAY_NAME } from "@aitne/shared";
import {
  LayoutDashboard,
  MessageSquare,
  History,
  BarChart3,
  Clock,
  Bot,
  Brain,
  Settings,
  PanelLeftClose,
  PanelLeftOpen,
  Sun,
  Moon,
  Monitor,
  BookOpen,
  BookText,
  NotebookText,
  Plug,
  GitBranch,
  Globe2,
  Plane,
  Wallet,
  Heart,
  ChevronDown,
  type LucideIcon,
} from "lucide-react";
import { useTheme } from "next-themes";
import { cn, formatCurrency } from "@/lib/utils";
import { Separator } from "@/components/ui/separator";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { ConnectionStatus } from "./connection-status";
import { useHealth } from "@/lib/hooks/use-health";
import { useApprovals } from "@/lib/hooks/use-approvals";
import { useAwaitingBrowserTasksCount } from "@/lib/hooks/use-browser-tasks";
import { useConfig } from "@/lib/hooks/use-config";
import { useEventStream } from "@/lib/hooks/use-event-stream";

type NavItem = {
  label: string;
  href: string;
  icon: LucideIcon;
  badge?: React.ReactNode;
  hidden?: boolean;
};

type NavSection = {
  id: string;
  /** Omitted for the top-level (Overview / Chat) group — rendered without a header. */
  label?: string;
  items: NavItem[];
};

function SidebarBadge({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <span className={cn("ml-auto flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-[10px] font-medium", className)}>
      {children}
    </span>
  );
}

const SECTION_STATE_STORAGE_KEY = "aitne.sidebar.sections.collapsed";
const sectionListeners: Set<() => void> = new Set();
const EMPTY_SECTIONS: ReadonlySet<string> = new Set();
let cachedSections: ReadonlySet<string> | null = null;

function readCollapsedSections(): ReadonlySet<string> {
  if (typeof window === "undefined") return EMPTY_SECTIONS;
  if (cachedSections) return cachedSections;
  try {
    const raw = window.localStorage.getItem(SECTION_STATE_STORAGE_KEY);
    if (!raw) {
      cachedSections = EMPTY_SECTIONS;
      return cachedSections;
    }
    const parsed = JSON.parse(raw) as unknown;
    cachedSections = Array.isArray(parsed)
      ? new Set(parsed.filter((id): id is string => typeof id === "string"))
      : EMPTY_SECTIONS;
  } catch {
    cachedSections = EMPTY_SECTIONS;
  }
  return cachedSections;
}

function getServerSections(): ReadonlySet<string> {
  return EMPTY_SECTIONS;
}

function writeCollapsedSections(next: ReadonlySet<string>): void {
  cachedSections = next;
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(SECTION_STATE_STORAGE_KEY, JSON.stringify([...next]));
    } catch {
      // localStorage blocked (private mode, quota). State still applies in-session.
    }
  }
  for (const l of sectionListeners) l();
}

function subscribeSections(cb: () => void): () => void {
  sectionListeners.add(cb);
  const onStorage = (e: StorageEvent) => {
    if (e.key === SECTION_STATE_STORAGE_KEY || e.key === null) {
      cachedSections = null;
      cb();
    }
  };
  if (typeof window !== "undefined") window.addEventListener("storage", onStorage);
  return () => {
    sectionListeners.delete(cb);
    if (typeof window !== "undefined") window.removeEventListener("storage", onStorage);
  };
}

function useCollapsedSections(): ReadonlySet<string> {
  return useSyncExternalStore(subscribeSections, readCollapsedSections, getServerSections);
}

const subscribeMounted = () => () => {};
const getMountedSnapshot = () => true;
const getMountedServerSnapshot = () => false;

function useMounted(): boolean {
  return useSyncExternalStore(subscribeMounted, getMountedSnapshot, getMountedServerSnapshot);
}

export function AppSidebar() {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);
  const collapsedSections = useCollapsedSections();
  const { theme, setTheme } = useTheme();
  const mounted = useMounted();
  const { data: config } = useConfig();

  const toggleSection = (id: string) => {
    const next = new Set(collapsedSections);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    writeCollapsedSections(next);
  };

  // Data for badges
  const { data: health } = useHealth();
  const { data: approvals } = useApprovals();
  const { data: awaitingBrowserTasks } = useAwaitingBrowserTasksCount();
  const streamEvents = useEventStream(100);

  const isActive = (href: string) => {
    if (href === "/") return pathname === "/";
    if (href === "/activity") {
      // Conversation detail pages (/conversations/[id]) are children of Agent Log
      return pathname.startsWith("/activity") || pathname.startsWith("/conversations/");
    }
    return pathname === href || pathname.startsWith(`${href}/`);
  };

  const nextTheme = () => {
    if (theme === "light") setTheme("dark");
    else if (theme === "dark") setTheme("system");
    else setTheme("light");
  };

  const ThemeIcon = !mounted
    ? Monitor
    : theme === "dark"
      ? Moon
      : theme === "light"
        ? Sun
        : Monitor;
  const themeLabel = mounted ? (theme ?? "system") : "system";

  const pendingApprovals = approvals?.approvals.length ?? 0;
  const newEventCount = streamEvents.length;
  // BROWSER_TASK_REDESIGN_PLAN.md §9a.4 — nav-entry red dot when any
  // task sits in awaiting_user / final_confirm. Source of truth is the
  // `awaiting-count` query (same anchor as the shell banner + the list
  // strip), kept in lock-step by the Shape B SSE invalidation in
  // sse-provider.tsx.
  const awaitingBrowserTaskCount =
    awaitingBrowserTasks?.total ?? awaitingBrowserTasks?.tasks.length ?? 0;
  const agentDisplayName = config?.agentDisplayName ?? DEFAULT_AGENT_DISPLAY_NAME;

  const sections: NavSection[] = [
    {
      // Top-level destinations — no section header. Overview is the
      // "what's happening" surface, Chat is the primary interaction.
      id: "home",
      items: [
        {
          label: "Overview", href: "/", icon: LayoutDashboard,
          badge: (() => {
            if (collapsed) return undefined;
            if (pendingApprovals > 0) {
              return <span className="ml-auto h-2 w-2 rounded-full bg-destructive" />;
            }
            if (health?.status === "ok") {
              return <span className="ml-auto h-2 w-2 rounded-full bg-success" />;
            }
            return undefined;
          })(),
        },
        { label: "Chat", href: "/chat", icon: MessageSquare },
      ],
    },
    {
      // What the agent does on its own — definitions, timing, and the
      // browser surface it drives.
      id: "automation",
      label: "Automation",
      items: [
        { label: "Agents", href: "/agents", icon: Bot },
        { label: "Schedule", href: "/schedule", icon: Clock },
        {
          label: "Browser Tasks",
          href: "/browser-tasks",
          icon: Globe2,
          badge:
            !collapsed && awaitingBrowserTaskCount > 0 ? (
              <span
                className="ml-auto h-2 w-2 rounded-full bg-destructive"
                aria-label={`${awaitingBrowserTaskCount} browser task(s) need your attention`}
              />
            ) : undefined,
        },
      ],
    },
    {
      // What already happened — the audit trail and what it cost.
      id: "activity",
      label: "Activity",
      items: [
        {
          label: "Agent Log", href: "/activity", icon: History,
          badge: newEventCount > 0 && !collapsed ? (
            <SidebarBadge className="bg-primary/10 text-primary">{newEventCount}</SidebarBadge>
          ) : undefined,
        },
        {
          label: "Analytics", href: "/analytics", icon: BarChart3,
          badge: health && !collapsed ? (
            <span className="ml-auto text-[10px] text-muted-foreground">{formatCurrency(health.todayCostUsd)}</span>
          ) : undefined,
        },
      ],
    },
    {
      id: "my-life",
      label: "My Life",
      items: [
        { label: "Knowledge", href: "/knowledge", icon: Brain },
        // Wiki is opt-in (WIKI_BUILDER_DESIGN.md §0) but the entry is
        // always shown for parity with the other My Life pages
        // (Reading / Git are visible regardless of whether the user
        // has data). The `/wiki` page itself renders an "Enable Wiki"
        // CTA when no `wiki_workspaces` row is active, so first-time
        // users get the discovery path without leaking implementation
        // state into the chrome.
        { label: "Wiki", href: "/wiki", icon: BookText },
        { label: "Reading", href: "/reading", icon: BookOpen },
        { label: "Git", href: "/git", icon: GitBranch },
        // Trip / Finance / Health are placeholder pages with no backing
        // implementation yet — hidden from the sidebar until shipped.
        // Definitions are kept so re-enabling is a one-line `hidden` flip.
        { label: "Trip", href: "/trip", icon: Plane, hidden: true },
        { label: "Finance", href: "/finance", icon: Wallet, hidden: true },
        { label: "Health", href: "/health", icon: Heart, hidden: true },
      ],
    },
    {
      id: "setup",
      label: "Setup",
      items: [
        { label: "Docs", href: "/docs", icon: NotebookText },
        { label: "Connections", href: "/connections", icon: Plug },
        { label: "Settings", href: "/settings", icon: Settings },
      ],
    },
  ];

  const renderNavItem = (item: NavItem) => {
    const active = isActive(item.href);
    const link = (
      <Link
        key={item.href}
        href={item.href}
        className={cn(
          "flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors",
          active
            ? "bg-primary/10 text-primary font-medium"
            : "text-muted-foreground hover:bg-accent hover:text-foreground",
          collapsed && "justify-center px-0",
        )}
      >
        <item.icon className="h-4 w-4 shrink-0" />
        {!collapsed && <span>{item.label}</span>}
        {item.badge}
      </Link>
    );

    if (collapsed) {
      return (
        <Tooltip key={item.href} delayDuration={0}>
          <TooltipTrigger asChild>{link}</TooltipTrigger>
          <TooltipContent side="right">{item.label}</TooltipContent>
        </Tooltip>
      );
    }
    return link;
  };

  const renderSection = (section: NavSection, isFirst: boolean) => {
    // Section collapse only applies when the sidebar itself is expanded
    // (icon-only mode shows everything). Header-less sections (no label)
    // have no collapse affordance and are always expanded.
    const sectionCollapsed =
      !collapsed && section.label !== undefined && collapsedSections.has(section.id);
    const showItems = collapsed || !sectionCollapsed;
    const visibleItems = section.items.filter((item) => !item.hidden);
    if (visibleItems.length === 0) return null;
    const sectionHasActive = visibleItems.some((item) => isActive(item.href));
    // Surface a hint when the active route lives inside a section the user has collapsed,
    // so the user is not silently disoriented when arriving via a deep link.
    const showActiveHint = sectionCollapsed && sectionHasActive;

    return (
      <div
        key={section.id}
        className={cn(
          !isFirst && "mt-2 pt-2 border-t border-border/60",
          !isFirst && collapsed && "mx-1",
        )}
      >
        {!collapsed && section.label !== undefined && (
          <button
            type="button"
            onClick={() => toggleSection(section.id)}
            aria-expanded={!sectionCollapsed}
            aria-controls={`sidebar-section-${section.id}`}
            className="flex w-full items-center gap-1.5 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/70 hover:text-foreground transition-colors"
          >
            <ChevronDown
              className={cn(
                "h-3 w-3 shrink-0 transition-transform duration-150",
                sectionCollapsed && "-rotate-90",
              )}
            />
            <span>{section.label}</span>
            {showActiveHint && (
              <>
                <span className="sr-only"> (current page is in this section)</span>
                <span aria-hidden className="ml-auto h-1.5 w-1.5 rounded-full bg-primary" />
              </>
            )}
          </button>
        )}
        {showItems && (
          <div id={`sidebar-section-${section.id}`} className="space-y-0.5">
            {visibleItems.map(renderNavItem)}
          </div>
        )}
      </div>
    );
  };

  return (
    <aside
      className={cn(
        "flex h-screen flex-col border-r border-border bg-sidebar text-sidebar-foreground transition-[width] duration-200",
        collapsed ? "w-16" : "w-56",
      )}
    >
      {/* Header */}
      <div className="flex h-14 items-center justify-between px-3">
        {!collapsed && (
          <div className="min-w-0">
            <span className="block font-display text-[15px] font-semibold tracking-tight">{APP_NAME}</span>
            <span className="block truncate text-[11px] text-muted-foreground">
              {agentDisplayName}
            </span>
          </div>
        )}
        <button
          onClick={() => setCollapsed(!collapsed)}
          className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          {collapsed ? <PanelLeftOpen className="h-4 w-4" /> : <PanelLeftClose className="h-4 w-4" />}
        </button>
      </div>

      <Separator />

      {/* Sectioned nav */}
      <nav aria-label="Main navigation" className="flex-1 overflow-y-auto p-2">
        {sections.map((section, idx) => renderSection(section, idx === 0))}
      </nav>

      <Separator />

      {/* Footer: connection status + theme */}
      <div className="p-2 space-y-2">
        <ConnectionStatus collapsed={collapsed} />
        <button
          onClick={nextTheme}
          className={cn(
            "flex items-center gap-3 rounded-lg px-3 py-2 text-xs text-muted-foreground hover:bg-accent hover:text-foreground w-full transition-colors",
            collapsed && "justify-center px-0",
          )}
        >
          <ThemeIcon className="h-4 w-4 shrink-0" />
          {!collapsed && <span className="capitalize">{themeLabel}</span>}
        </button>
      </div>
    </aside>
  );
}
