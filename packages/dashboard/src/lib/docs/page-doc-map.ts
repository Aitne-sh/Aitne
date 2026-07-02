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
  // Top-level pages resolve to their `pages/<screen>` hub doc — a
  // "what can I do on this screen?" overview that links down to the
  // feature/concept docs (PAGE_DOCS_HUB_DESIGN.md). Sub-pages and
  // tab-qualified deep links keep pointing at the specific feature/concept
  // doc that documents exactly that surface.
  { match: { path: "/" },                                           docId: "pages/overview" },
  { match: { path: "/chat" },                                       docId: "pages/chat" },
  { match: { path: /^\/activity/ },                                 docId: "pages/activity" },
  { match: { path: /^\/conversations(\/|$)/ },                      docId: "pages/activity" },
  // /schedule redirect()s to /tasks?tab=queue (DASHBOARD_AUTOMATION_IA_REDESIGN
  // §2) and never renders, so it must not appear here; the Tasks hub (board +
  // queue + scheduled DMs) is documented by its own page doc.
  { match: { path: "/tasks" },                                      docId: "pages/tasks" },
  // Agents hub (AGENTS_HUB_REDESIGN_PLAN §4) — documented built-ins get
  // their routine doc; the catch-all regex covers the index, user Agents,
  // undocumented built-ins (monthly-review, sweeps, …) and /executions
  // sub-pages, landing them on the Agents hub page doc. Literals MUST
  // precede the catch-all (first hit wins).
  { match: { path: "/agents/morning-routine" },                     docId: "features/routines/morning-routine" },
  { match: { path: "/agents/evening-review" },                      docId: "features/routines/evening-review" },
  { match: { path: "/agents/weekly-review" },                       docId: "features/routines/weekly-review" },
  { match: { path: "/agents/activity-scan" },                        docId: "features/routines/activity-scan" },
  { match: { path: /^\/agents(\/|$)/ },                             docId: "pages/agents" },
  { match: { path: "/knowledge", query: { tab: "context-files" } }, docId: "concepts/memory-model" },
  { match: { path: "/knowledge", query: { tab: "skills" } },        docId: "concepts/skills" },
  { match: { path: "/knowledge", query: { tab: "upload" } },        docId: "guides/import-knowledge-file" },
  { match: { path: "/knowledge" },                                  docId: "pages/knowledge" },
  { match: { path: "/reading" },                                    docId: "pages/reading" },
  { match: { path: "/git" },                                        docId: "pages/git" },
  { match: { path: "/analytics" },                                  docId: "pages/analytics" },
  // Browser hub (BROWSER_HUB_CONSOLIDATION_DESIGN.md).
  { match: { path: "/browser" },                                    docId: "pages/browser" },
  // Browser Tasks list + run-detail (`/browser-tasks/:id`). Regex so the
  // detail page shares the page's doc — same shape as /activity above.
  // Must precede no narrower entry; `/browser` is an exact-string match
  // and never matches `/browser-tasks`.
  { match: { path: /^\/browser-tasks(\/|$)/ },                      docId: "features/operations/browser-tasks" },

  // Wiki — sub-page literal first, then the index page
  { match: { path: "/wiki/timeline" },                              docId: "features/wiki/dashboard" },
  { match: { path: "/wiki" },                                       docId: "pages/wiki" },

  // Connections — specific sub-pages first, then catch-all.
  // /connections/journal and /connections/routines are compatibility
  // aliases that redirect() to /agents (AGENTS_HUB_REDESIGN_PLAN §4)
  // and never render, so they must not appear here.
  { match: { path: "/connections/calendar" },                       docId: "features/integrations/calendar" },
  { match: { path: "/connections/repositories" },                   docId: "features/integrations/git" },
  // /connections/knowledge 302-redirects to /connections/notes
  // (middleware.ts, Notes IA rename 2026-06) and never renders.
  { match: { path: "/connections/notes" },                          docId: "features/integrations/obsidian" },
  { match: { path: "/connections/mail" },                           docId: "features/integrations/mail" },
  { match: { path: "/connections/mcp" },                            docId: "concepts/skills" },
  { match: { path: "/connections/messaging" },                      docId: "features/messaging/overview" },
  // Connections hub. `/connections` redirect()s to /connections/messaging
  // at render, so the `?` there resolves via the messaging entry above; the
  // hub doc stays browsable in /docs and retrievable by the QA bot.
  { match: { path: "/connections" },                                docId: "pages/connections" },

  // Settings — specific sub-pages first, then top-level. The former
  // /settings/schedule and /settings/routines pages 302-redirect in
  // middleware.ts (AGENTS_HUB_REDESIGN_PLAN §4.3) so they must not appear.
  { match: { path: "/settings/hours" },                             docId: "features/operations/quiet-hours" },
  { match: { path: "/settings/self-learning" },                     docId: "concepts/skills" },
  { match: { path: "/settings/commands" },                          docId: "features/messaging/overview" },
  { match: { path: "/settings/models" },                            docId: "concepts/backends-and-tiers" },
  // /settings/advanced split (DASHBOARD_UI_REFRESH_DESIGN.md follow-up #1);
  // the old path 302-redirects in middleware.ts so it must not appear here.
  { match: { path: "/settings/safety" },                            docId: "concepts/safety-and-execution" },
  { match: { path: "/settings/infrastructure" },                    docId: "reference/config" },
  { match: { path: "/settings/danger-zone" },                       docId: "guides/reinstall-cleanly" },
  { match: { path: "/settings/wiki" },                              docId: "features/wiki/workspaces" },
  // Managed-chromium sub-page literal first so it wins over the
  // browser-history-managed catch-all that shares its prefix.
  { match: { path: "/settings/integrations/browser-history-managed/b4" }, docId: "features/operations/managed-chromium" },
  { match: { path: "/settings/integrations/browser-history-managed" },    docId: "features/operations/managed-chromium" },
  { match: { path: "/settings/integrations/browser-history" },            docId: "features/integrations/browser-history" },
  { match: { path: "/settings" },                                   docId: "pages/settings" },

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
