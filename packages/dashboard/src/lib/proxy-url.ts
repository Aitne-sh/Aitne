/**
 * Build the upstream daemon URL for a request hitting the dashboard proxy
 * (`app/api/[...path]/route.ts`).
 *
 * The non-obvious requirement: percent-encoded slashes (`%2F`) in path
 * segments must survive the hop. Repository IDs are formed as
 * `github:owner/repo` and are sent encoded as `github%3Aowner%2Frepo`.
 * If we instead used Next.js's catch-all params (`ctx.params.path`), Next.js
 * would decode `%2F` into a literal `/`, splitting one segment into two,
 * and the joined path would carry an extra slash that Hono's `:id` route
 * cannot match — producing a 404 on any PATCH/DELETE/GET-by-id for a
 * GitHub-backed repository.
 *
 * Using the raw `pathname` from the request URL preserves percent-encoding
 * (per WHATWG URL: `%2F` is not decoded in `URL.pathname`), so the daemon
 * receives the same encoding the browser sent.
 */
export interface ProxyRequestUrl {
  pathname: string;
  search: string;
}

export function buildUpstreamUrl(
  request: ProxyRequestUrl,
  daemonBaseUrl: string,
): URL {
  const upstreamUrl = new URL(request.pathname, daemonBaseUrl);
  upstreamUrl.search = request.search;
  return upstreamUrl;
}
