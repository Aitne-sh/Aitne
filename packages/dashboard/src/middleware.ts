import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

/** Dashboard restructure URL redirects (302 temporary). */
const REDIRECTS: Record<string, string> = {
  "/system-logs": "/activity?tab=system",
  "/memory": "/knowledge",
  "/skills": "/knowledge?tab=skills",
  "/messaging": "/connections/messaging",
  "/notifications": "/activity?tab=notifications",
  "/settings/notifications": "/activity?tab=notifications",
  "/settings/messaging": "/connections/messaging",
  "/settings/backends": "/settings/models",
  "/settings/processes": "/settings/models",
  "/settings/connections": "/connections",
  // AGENTS_HUB_REDESIGN_PLAN §4 — routine rulebooks + journal rules moved to
  // each agent's Rulebook tab; the cross-cutting time/notification policy
  // page was renamed Hours & Notifications.
  "/settings/journal": "/agents/morning-routine?tab=rulebook",
  "/settings/routines": "/agents",
  "/settings/schedule": "/settings/hours",
  // DASHBOARD_UI_REFRESH_DESIGN.md follow-up #1 — the monolithic Advanced
  // page split into Safety / Infrastructure / Danger Zone. Safety is the
  // most common destination for old deep links (tool policy).
  "/settings/advanced": "/settings/safety",
  "/cost": "/analytics",
  "/logs": "/activity",
  "/approvals": "/",
  "/metrics": "/analytics?tab=metrics",
  // Notes IA rename (2026-06): note sources (Obsidian personal vault +
  // Notion) moved from "Knowledge" to "Notes"; the agent's own primary
  // vault is managed from Settings → Management Mode.
  "/connections/knowledge": "/connections/notes",
};

export function middleware(request: NextRequest) {
  const target = REDIRECTS[request.nextUrl.pathname];
  if (target) {
    const url = request.nextUrl.clone();
    const [pathname, search] = target.split("?");
    url.pathname = pathname;
    url.search = search ? `?${search}` : "";
    return NextResponse.redirect(url, 302);
  }
}

export const config = {
  matcher: [
    "/system-logs",
    "/memory",
    "/skills",
    "/messaging",
    "/notifications",
    "/settings/notifications",
    "/settings/messaging",
    "/settings/backends",
    "/settings/processes",
    "/settings/connections",
    "/settings/journal",
    "/settings/routines",
    "/settings/schedule",
    "/settings/advanced",
    "/cost",
    "/logs",
    "/approvals",
    "/metrics",
    "/connections/knowledge",
  ],
};
