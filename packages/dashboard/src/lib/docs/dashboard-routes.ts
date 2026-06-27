/**
 * Whitelist of dashboard pathnames the docs renderer can turn into clickable
 * navigation links.
 *
 * Authors write `` `/settings/models` `` as inline code in markdown so the
 * raw source still reads as a literal path. The renderer (`docs-content.tsx`
 * `code` component override) calls `dashboardRouteHref` on each inline
 * code value; when it returns a string, the inline code is rendered as a
 * `<Link>` chip instead of a plain `<code>` span.
 *
 * Why a whitelist rather than `/^\//`-anything: docs also embed API
 * endpoints (`/api/...`), placeholder paths (`/connections/...`), and
 * file-system paths in the same inline-code form. Only entries listed
 * here can be navigated to without 404ing — either an actual Next.js
 * route under `packages/dashboard/src/app/` or a retired path that
 * 302-redirects in `middleware.ts` (kept so older doc revisions' link
 * chips keep working; e.g. `/settings/advanced`, `/settings/journal`).
 *
 * Keep this list in sync with `src/app/**`, `middleware.ts` REDIRECTS,
 * and `PAGE_DOC_MAP`.
 */
export const DASHBOARD_ROUTES: ReadonlySet<string> = new Set([
  "/",
  "/activity",
  // The Agents hub + the built-in detail pages docs deep-link to
  // (AGENTS_HUB_REDESIGN_PLAN §4 — /agents/<slug> is dynamic, so each
  // doc-referenced slug is whitelisted explicitly).
  "/agents",
  "/agents/morning-routine",
  "/agents/evening-review",
  "/agents/weekly-review",
  "/agents/monthly-review",
  "/agents/activity-scan",
  "/analytics",
  "/browser",
  "/browser-tasks",
  "/chat",
  "/connections",
  "/connections/calendar",
  "/connections/repositories",
  "/connections/journal",
  "/connections/knowledge",
  "/connections/notes",
  "/connections/mail",
  "/connections/mcp",
  "/connections/messaging",
  "/connections/routines",
  "/connections/tasks",
  "/conversations",
  "/docs",
  "/knowledge",
  "/reading",
  "/schedule",
  "/settings",
  "/settings/advanced",
  "/settings/backends",
  "/settings/commands",
  "/settings/connections",
  "/settings/danger-zone",
  "/settings/hours",
  "/settings/infrastructure",
  "/settings/journal",
  "/settings/messaging",
  "/settings/models",
  "/settings/processes",
  "/settings/routines",
  "/settings/safety",
  "/settings/schedule",
  "/settings/wiki",
  "/setup",
  "/tasks",
  "/wiki",
  "/wiki/timeline",
]);

/**
 * If `text` looks like a dashboard route the renderer can navigate to,
 * return it normalized as an `href`. Otherwise return `null` so the caller
 * falls through to default `<code>` rendering.
 *
 *   - Pathname must be in `DASHBOARD_ROUTES`.
 *   - Query string is preserved verbatim.
 *   - Hash fragment is preserved verbatim.
 *   - Anything that contains whitespace, a colon (`:placeholder`), or an
 *     ellipsis (`/...`) is rejected.
 */
export function dashboardRouteHref(text: string): string | null {
  if (typeof text !== "string") return null;
  if (text.length === 0) return null;
  if (!text.startsWith("/")) return null;
  if (/\s/.test(text)) return null;
  // Reject placeholders like `/connections/...` or `/api/integrations/:key`.
  if (text.includes("...") || text.includes(":")) return null;

  // Split off optional `?query` and `#hash`, normalize, then check the
  // pathname against the whitelist.
  let path = text;
  let suffix = "";
  const hashIdx = path.indexOf("#");
  if (hashIdx !== -1) {
    suffix = path.slice(hashIdx) + suffix;
    path = path.slice(0, hashIdx);
  }
  const queryIdx = path.indexOf("?");
  if (queryIdx !== -1) {
    suffix = path.slice(queryIdx) + suffix;
    path = path.slice(0, queryIdx);
  }
  if (!DASHBOARD_ROUTES.has(path)) return null;
  return `${path}${suffix}`;
}
