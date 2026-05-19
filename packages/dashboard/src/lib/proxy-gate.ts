/**
 * CSRF gate for the dashboard's daemon-API proxy.
 *
 * The gate runs in `app/api/[...path]/route.ts` BEFORE the proxy injects
 * the daemon's `PA_API_TOKEN` Bearer header. Once it returns true, every
 * forwarded request inherits the daemon owner's authority — so the
 * acceptance criteria here are the actual security boundary for every
 * Approve-tier endpoint.
 *
 * Layered defenses, in evaluation order:
 *
 * 1. **Host header allowlist** — defeats DNS rebinding. Even if the
 *    browser thinks it's same-origin (because the page was loaded from a
 *    domain whose DNS just rebound to 127.0.0.1), the Host header still
 *    carries the attacker's domain, which isn't on our loopback list.
 *
 * 2. **`Sec-Fetch-Site` (Fetch Metadata)** — supported in every modern
 *    browser. `same-origin` is the only safe value for state-changing
 *    methods; `none` (typed URL / bookmark) is OK for safe methods only;
 *    `same-site` and `cross-site` always reject.
 *
 * 3. **`Origin` header** fallback for clients that don't send
 *    `Sec-Fetch-Site` (older browsers, embedded webviews). The Origin
 *    must equal the dashboard's expected origin exactly.
 *
 * 4. **No metadata at all** (curl-style direct hit): allow GET/HEAD/OPTIONS
 *    only, since they have no side effects.
 */

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Loopback hostnames the proxy will accept in the Host header. Anything
 * else (including domains that resolve to 127.0.0.1 via DNS rebinding) is
 * rejected. We list `::1` without brackets because `URL.hostname` strips
 * the brackets when parsing IPv6 authorities.
 */
const ALLOWED_LOOPBACK_HOSTNAMES = new Set([
  "localhost",
  "127.0.0.1",
  "::1",
]);

export interface ProxyGateInput {
  method: string;
  /** The dashboard's expected origin, e.g. `http://localhost:3000`. */
  expectedOrigin: string;
  /** Value of the `Origin` request header, or null if absent. */
  origin: string | null;
  /** Value of the `Sec-Fetch-Site` request header, or null if absent. */
  secFetchSite: string | null;
  /** Value of the `Host` request header (`hostname[:port]`), or null. */
  host: string | null;
}

export type GateDecision =
  | { allowed: true }
  | { allowed: false; reason: string };

/**
 * Parse a Host header value (`hostname[:port]`) and return the bare
 * hostname, lowercased and with IPv6 brackets stripped.
 *
 * Why `URL`: handles bracketed IPv6 (`[::1]:3000`) correctly, where a
 * naive `split(":")` would tokenize on the embedded colons.
 *
 * Why strip brackets: WHATWG `URL.hostname` returns `[::1]` for an
 * IPv6 authority — keeping the brackets in the allowlist would force
 * us to remember bracket variants in two places. Cleaner to strip
 * here so the allowlist holds just `::1`.
 */
function parseHostHeader(host: string | null): string | null {
  if (!host) return null;
  try {
    const parsed = new URL(`http://${host}`);
    const hostname = parsed.hostname.toLowerCase();
    return hostname.startsWith("[") && hostname.endsWith("]")
      ? hostname.slice(1, -1)
      : hostname;
  } catch {
    return null;
  }
}

/**
 * The pure decision function. Inputs are plain values, no `NextRequest`,
 * so it's trivially unit-testable. The route file wraps it.
 */
export function evaluateProxyGate(input: ProxyGateInput): GateDecision {
  // 1. Host check — must be a loopback hostname.
  const hostname = parseHostHeader(input.host);
  if (!hostname || !ALLOWED_LOOPBACK_HOSTNAMES.has(hostname)) {
    return {
      allowed: false,
      reason: "host_not_loopback",
    };
  }

  // 2. Sec-Fetch-Site (preferred signal).
  if (input.secFetchSite) {
    if (input.secFetchSite === "same-origin") return { allowed: true };
    if (input.secFetchSite === "none") {
      return SAFE_METHODS.has(input.method)
        ? { allowed: true }
        : { allowed: false, reason: "unsafe_method_on_user_initiated_navigation" };
    }
    return { allowed: false, reason: `sec_fetch_site_${input.secFetchSite}` };
  }

  // 3. Origin header fallback.
  if (input.origin) {
    return input.origin === input.expectedOrigin
      ? { allowed: true }
      : { allowed: false, reason: "origin_mismatch" };
  }

  // 4. No metadata: allow safe methods only.
  return SAFE_METHODS.has(input.method)
    ? { allowed: true }
    : { allowed: false, reason: "unsafe_method_no_metadata" };
}
