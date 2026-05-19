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
 * here are actual Next.js routes under `packages/dashboard/src/app/` that
 * the router can navigate to without 404ing.
 *
 * Keep this list in sync with `src/app/**` and `PAGE_DOC_MAP`.
 */
export const DASHBOARD_ROUTES: ReadonlySet<string> = new Set([
  "/",
  "/activity",
  "/analytics",
  "/chat",
  "/connections",
  "/connections/calendar",
  "/connections/repositories",
  "/connections/journal",
  "/connections/knowledge",
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
  "/settings/journal",
  "/settings/messaging",
  "/settings/models",
  "/settings/processes",
  "/settings/routines",
  "/settings/schedule",
  "/setup",
  "/tasks",
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
