/**
 * Dashboard pathname (+search) → docId map for the `?` button.
 *
 * Mirrors DOCS_QA_DESIGN.md §8.3 / DOCS_QA_DASHBOARD_DESIGN.md §6.1. Paths
 * that 302-redirect in `dashboard/src/middleware.ts` (e.g.
 * `/settings/notifications`) are intentionally absent — adding them here
 * would map a doc to a URL the operator can never actually be on.
 *
 * Iteration is top-to-bottom; first hit wins. Specifics MUST precede
 * catch-all regexes:
 *   1. Query-qualified entries above their unqualified pathname twins
 *      (`/knowledge?tab=skills` before bare `/knowledge`).
 *   2. Sub-page literals above their parent catch-all
 *      (`/connections/repositories` before bare `/connections`).
 *   3. Suppression entries (`docId: null`) last on their prefix
 *      (`/^\/docs/`) — they only fire when nothing more specific matches.
 */

export interface PageDocMapEntry {
  match: { path: string | RegExp; query?: Record<string, string> };
  /** `null` means "explicitly suppress the help button on this path". */
  docId: string | null;
}

export const PAGE_DOC_MAP: ReadonlyArray<PageDocMapEntry> = [
  // Top-level pages
  { match: { path: "/" },                                           docId: "features/operations/activity-and-conversations" },
  { match: { path: "/chat" },                                       docId: "features/messaging/dashboard-chat" },
  { match: { path: /^\/activity/ },                                 docId: "features/operations/activity-and-conversations" },
  { match: { path: /^\/conversations(\/|$)/ },                      docId: "features/operations/activity-and-conversations" },
  { match: { path: "/schedule" },                                   docId: "features/memory-files/schedule" },
  { match: { path: "/knowledge", query: { tab: "context-files" } }, docId: "concepts/memory-model" },
  { match: { path: "/knowledge", query: { tab: "skills" } },        docId: "concepts/skills" },
  { match: { path: "/knowledge", query: { tab: "upload" } },        docId: "guides/import-knowledge-file" },
  { match: { path: "/knowledge" },                                  docId: "concepts/memory-model" },
  { match: { path: "/reading" },                                    docId: "features/lifestyle/reading" },
  { match: { path: "/git" },                                        docId: "features/lifestyle/git" },
  { match: { path: "/analytics" },                                  docId: "concepts/costs-and-quotas" },

  // Wiki — sub-page literal first, then the index page
  { match: { path: "/wiki/timeline" },                              docId: "features/wiki/dashboard" },
  { match: { path: "/wiki" },                                       docId: "features/wiki/overview" },

  // Connections — specific sub-pages first, then catch-all
  { match: { path: "/connections/calendar" },                       docId: "features/integrations/calendar" },
  { match: { path: "/connections/repositories" },                   docId: "features/integrations/git" },
  { match: { path: "/connections/journal" },                        docId: "features/memory-files/agent-journal" },
  { match: { path: "/connections/knowledge" },                      docId: "concepts/memory-model" },
  { match: { path: "/connections/mail" },                           docId: "features/integrations/mail" },
  { match: { path: "/connections/mcp" },                            docId: "concepts/skills" },
  { match: { path: "/connections/messaging" },                      docId: "features/messaging/overview" },
  { match: { path: "/connections/routines" },                       docId: "concepts/routines" },
  { match: { path: "/connections" },                                docId: "features/messaging/overview" },

  // Settings — specific sub-pages first, then top-level
  { match: { path: "/settings/connections" },                       docId: "features/messaging/overview" },
  { match: { path: "/settings/schedule" },                          docId: "features/operations/quiet-hours" },
  { match: { path: "/settings/routines" },                          docId: "concepts/routines" },
  { match: { path: "/settings/self-learning" },                     docId: "concepts/skills" },
  { match: { path: "/settings/journal" },                           docId: "features/memory-files/agent-journal" },
  { match: { path: "/settings/commands" },                          docId: "features/messaging/overview" },
  { match: { path: "/settings/models" },                            docId: "concepts/backends-and-tiers" },
  { match: { path: "/settings/advanced" },                          docId: "concepts/safety-and-execution" },
  { match: { path: "/settings/wiki" },                              docId: "features/wiki/workspaces" },
  // Managed-chromium sub-page literal first so it wins over the
  // browser-history-managed catch-all that shares its prefix.
  { match: { path: "/settings/integrations/browser-history-managed/b4" }, docId: "features/operations/managed-chromium" },
  { match: { path: "/settings/integrations/browser-history-managed" },    docId: "features/operations/managed-chromium" },
  { match: { path: "/settings/integrations/browser-history" },            docId: "features/integrations/browser-history" },
  { match: { path: "/settings" },                                   docId: "concepts/agent-day" },

  // Setup wizard
  { match: { path: /^\/setup/ },                                    docId: "guides/setup-wizard" },

  // Suppress on /docs itself (the help button is redundant there)
  { match: { path: /^\/docs/ },                                     docId: null },
];

/**
 * Resolve the doc id for a given dashboard location.
 *
 * @param pathname  pathname as returned by Next.js `usePathname()`
 *                  (no query string, no hash)
 * @param search    `URLSearchParams` (from `useSearchParams()`); only
 *                  inspected when an entry declares `query:`. Pass an
 *                  empty `URLSearchParams()` if the caller does not have
 *                  a search-params object.
 * @returns the doc id, `null` for explicit suppression, or `null` if no
 *          entry matches.
 */
export function docIdForPath(
  pathname: string,
  search: URLSearchParams,
): string | null {
  for (const e of PAGE_DOC_MAP) {
    const pathMatch =
      typeof e.match.path === "string"
        ? pathname === e.match.path
        : e.match.path.test(pathname);
    if (!pathMatch) continue;
    if (e.match.query) {
      const allOk = Object.entries(e.match.query).every(
        ([k, v]) => search.get(k) === v,
      );
      if (!allOk) continue;
    }
    return e.docId;
  }
  return null;
}
