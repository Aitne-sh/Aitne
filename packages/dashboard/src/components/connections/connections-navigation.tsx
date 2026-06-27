"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  MessageSquare,
  GitBranch,
  BookText,
  Calendar,
  Mail,
  Server,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";

type NavItem = {
  href: string;
  label: string;
  icon: LucideIcon;
  description: string;
};

const NAV_ITEMS: NavItem[] = [
  {
    href: "/connections/messaging",
    label: "Messaging",
    icon: MessageSquare,
    description: "Slack, Telegram, Discord, WhatsApp, Dashboard",
  },
  {
    href: "/connections/repositories",
    label: "Repositories",
    icon: GitBranch,
    description: "GitHub remotes and local clones",
  },
  {
    href: "/connections/notes",
    label: "Notes",
    icon: BookText,
    description: "Obsidian vault and Notion pages",
  },
  {
    href: "/connections/calendar",
    label: "Calendar",
    icon: Calendar,
    description: "Google, Outlook, Apple",
  },
  {
    href: "/connections/mail",
    label: "Mail",
    icon: Mail,
    description: "Gmail, Outlook, Yahoo, iCloud",
  },
  {
    href: "/connections/mcp",
    label: "MCP Servers",
    icon: Server,
    description: "Shared tool bundles for every session",
  },
];

export function ConnectionsNavigation() {
  const pathname = usePathname();

  return (
    <nav
      aria-label="Connections sections"
      className="w-full md:w-60 md:shrink-0"
    >
      <ul className="flex flex-row gap-1 overflow-x-auto md:flex-col md:gap-0.5">
        {NAV_ITEMS.map((item) => {
          // Boundary-aware match so sibling routes that share a prefix
          // (e.g. a future `/connections/mail-search` next to `/connections/
          // mail`) don't both light up. Mirrors settings-navigation.tsx.
          const active =
            pathname === item.href
            || pathname.startsWith(item.href + "/");
          const Icon = item.icon;
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
                  <span className="block">{item.label}</span>
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
    </nav>
  );
}
