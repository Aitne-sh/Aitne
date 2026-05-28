/**
 * Browser-task allowlist composition.
 *
 * As of the 2026-05-27 open-navigation revision, browser-task callers
 * no longer pass `siteKey` / `extraAllowedHosts` on the request body —
 * `composeAllowlistRegex({ siteKey: null })` is the canonical call and
 * yields a permissive result (`composedSource: null`, no positive
 * selector). The CDP route handler treats a null `allowlistRegex` as
 * "no positive gate" and decides on the denylist alone (network IP
 * CIDR + user-curated hostname denylist + payment-path URL block).
 *
 * The legacy `siteKey + extraAllowedHosts` composition path remains
 * exported for the B-2.5 sign-in flow (`/api/browser-automation/sites/*`)
 * + any test fixture that still pins a `SiteDefinition`. Tightening
 * rules for the legacy path:
 *  1. Cap count: `extraAllowedHosts.length <= 5`.
 *  2. Host-only shape — bare hostname, no scheme/path/port/userinfo;
 *     wildcard limited to a single leading `*.` label.
 *  3. eTLD+1 subset against the siteKey's pattern OR the static
 *     `EXTRA_ALLOWED_ETLD_HELPERS` set.
 *  4. Scheme floor: composed regex prefix-anchors `^https?://`. The
 *     CDP route handler denies non-http(s) schemes regardless of
 *     allowlist content.
 */

import { extractEtldPlusOne } from "../browser-history/automation/egress-denylist.js";
import {
  getSite,
  type SiteDefinition,
} from "../browser-history/automation/site-registry.js";

/** §14.1.1 — caller cap. A larger ask indicates the task is not
 *  well-scoped. */
export const EXTRA_ALLOWED_HOSTS_MAX = 5;

/**
 * §14.1.3 — small static set enumerating known CDN / asset / auth
 * shells the registered sites actually depend on. Adding an entry
 * requires the same review weight as adding a siteKey (and the
 * test plan asserts both stay in sync).
 */
// BROWSER_TASK_REDESIGN_PLAN.md §14.1.3 — `Object.freeze`'d as the
// intent signal that adding an entry needs the same review weight as
// adding a siteKey. The freeze locks own properties; Set's internal
// slots are not literally protected by `Object.freeze` (Set methods
// access via [[SetData]] not own keys), but the `ReadonlySet<string>`
// type already removes `.add` / `.delete` / `.clear` from the surface
// callers see, and the runtime freeze + this comment make any "let's
// monkey-patch this in a hot fix" attempt impossible to land without
// a deliberate cast. The source-of-truth list is the frozen tuple
// below — extending it requires editing this file.
const ETLD_HELPER_LIST = Object.freeze([
  "twimg.com",
  "licdn.com",
  "cdninstagram.com",
  "fbcdn.net",
  "gstatic.com",
  "googleapis.com",
  "googleusercontent.com",
  "media-amazon.com",
  "ssl-images-amazon.com",
  "nflxext.com",
  "nflximg.net",
] as const);

export const EXTRA_ALLOWED_ETLD_HELPERS: ReadonlySet<string> = Object.freeze(
  new Set<string>(ETLD_HELPER_LIST),
);

/** Bare hostname pattern. Allows:
 *   - `host.example.com`
 *   - `*.example.com` (single leading wildcard label)
 *  Rejects: any scheme/path/port/userinfo, embedded `*`, multiple
 *  wildcards, leading dot, trailing dot, IDN punycode for now (the
 *  registered sites are all ASCII), empty labels, whitespace. */
const BARE_HOSTNAME_RE =
  /^(\*\.)?(?:[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

export type ComposeAllowlistResult =
  | {
      ok: true;
      /** `null` for the open-navigation (no-siteKey) path — the CDP
       *  route handler treats this as "no positive selector". A real
       *  regex source surfaces only for the legacy site-pinned path. */
      composedSource: string | null;
      composed: RegExp | null;
      acceptedExtras: readonly string[];
    }
  | {
      ok: false;
      reason:
        | "too_many_extra_hosts"
        | "extra_host_must_be_hostname"
        | "extra_host_not_in_etld_set"
        | "site_unregistered";
      offendingHost?: string;
    };

/**
 * Compose the effective allowlist regex for a request.
 *
 * Inputs:
 *   - `siteKey`: must resolve in `SITE_REGISTRY`. Returns
 *     `site_unregistered` on miss.
 *   - `extraAllowedHosts`: optional list of bare hostnames. Each
 *     entry's eTLD+1 must equal the siteKey's eTLD+1 OR appear in
 *     `EXTRA_ALLOWED_ETLD_HELPERS`.
 *
 * Output:
 *   - `composedSource`: the regex source string the runner installs
 *     into `cdp-network-interception.applyCDPInterception`. The
 *     pattern is `^(<siteRegex>|<extraHost1>|<extraHost2>|...)`. Each
 *     extra hostname is bound by `^https?://(<host>(/|$))` so a path
 *     boundary or end-of-URL is required (no `evil.com` matching
 *     `evil.com.attacker.test`).
 *   - `composed`: the compiled `RegExp`. Case-insensitive.
 *   - `acceptedExtras`: the canonicalised (lower-cased) extra hosts.
 *
 * The siteKey's own pattern (`SiteDefinition.allowedHostPattern`)
 * already prefix-anchors `^https?://` per the §8 registry shape.
 * Sites with B-2.5 cookies effectively pin `^https://` via the site-
 * registry validator's existing `homeUrl` invariant; this composer
 * keeps `https?` on the union arm so a future http-only registered
 * site doesn't break.
 */
export function composeAllowlistRegex(input: {
  siteKey: string | null;
  extraAllowedHosts?: readonly string[];
}): ComposeAllowlistResult {
  if (input.siteKey === null) {
    // 2026-05-27 open-navigation revision — null siteKey is the
    // canonical browser-task path. No positive selector is composed;
    // domain-level deny comes from the user-curated
    // `runtime-settings.browserTaskHostnameDenylist` and the network
    // IP CIDR + payment-path URL gates remain in place inside the
    // CDP route handler.
    return {
      ok: true,
      composedSource: null,
      composed: null,
      acceptedExtras: [],
    };
  }
  const site = getSite(input.siteKey);
  if (!site) {
    return {
      ok: false,
      reason: "site_unregistered",
      offendingHost: input.siteKey,
    };
  }
  const extras = input.extraAllowedHosts ?? [];
  if (extras.length > EXTRA_ALLOWED_HOSTS_MAX) {
    return { ok: false, reason: "too_many_extra_hosts" };
  }
  const accepted: string[] = [];
  for (const raw of extras) {
    const candidate = (raw ?? "").trim().toLowerCase();
    if (!candidate || !isBareHostname(candidate)) {
      return {
        ok: false,
        reason: "extra_host_must_be_hostname",
        offendingHost: raw,
      };
    }
    if (!extraHostInScope(site, candidate)) {
      return {
        ok: false,
        reason: "extra_host_not_in_etld_set",
        offendingHost: candidate,
      };
    }
    accepted.push(candidate);
  }
  const composed = buildComposedRegex(site, accepted);
  return {
    ok: true,
    composedSource: composed.source,
    composed,
    acceptedExtras: accepted,
  };
}

/** Pure shape check — rejects schemes, paths, ports, embedded `*`. */
export function isBareHostname(value: string): boolean {
  if (typeof value !== "string") return false;
  if (value.length === 0 || value.length > 253) return false;
  if (value.includes("://")) return false;
  if (value.includes("/")) return false;
  if (value.includes(":")) return false;
  if (value.includes("@")) return false;
  if (value.includes(" ")) return false;
  if (value.includes("..")) return false;
  if (value.startsWith(".") || value.endsWith(".")) return false;
  return BARE_HOSTNAME_RE.test(value);
}

/** True when `host` is in the registered site's eTLD+1 OR in the
 *  static helper set. `*.example.com` collapses to `example.com`
 *  for the eTLD+1 check. */
export function extraHostInScope(site: SiteDefinition, host: string): boolean {
  const base = host.startsWith("*.") ? host.slice(2) : host;
  const etld = extractEtldPlusOne(base);
  const siteHostExample = extractSiteHostExample(site);
  if (siteHostExample) {
    const siteEtld = extractEtldPlusOne(siteHostExample);
    if (siteEtld === etld) return true;
  }
  return EXTRA_ALLOWED_ETLD_HELPERS.has(etld);
}

/** The siteKey's `homeUrl` is an https URL; extract its hostname so
 *  the eTLD+1 check has something to compare against. */
function extractSiteHostExample(site: SiteDefinition): string | null {
  try {
    return new URL(site.homeUrl).hostname.toLowerCase();
    /* c8 ignore start -- the site-registry validator asserts every
     * `homeUrl` is a parseable URL at boot, so this catch is purely
     * defensive against a hand-crafted test registry. */
  } catch {
    return null;
  }
  /* c8 ignore stop */
}

/**
 * Flag set the composer applies to the assembled allowlist regex. The
 * driver MUST re-apply the same flags when it re-compiles the persisted
 * source — see `browser-task-driver.ts:prepareDriverHandle`'s
 * `new RegExp(row.effectiveAllowlistRegex, BROWSER_TASK_ALLOWLIST_REGEX_FLAGS)`
 * call. The two ends are pinned to a single shared constant so a future
 * widening (e.g. adding `u` for unicode-property matches) lands in one
 * place.
 *
 * **Persistence contract (current):** `browser_task.effective_allowlist_regex`
 * stores only the source string; the flag set is implicit. If a future
 * widening adds flags beyond `i`, the persisted shape MUST change to
 * carry both source AND flags (`{source, flags}` JSON in the column, or
 * a sibling column) AND the migration MUST handle in-flight rows whose
 * legacy value carries only the source (parse as
 * `{source: <value>, flags: "i"}`). Tracked as F6/F7 in
 * `BROWSER_TASK_REDESIGN_PLAN.md` review.
 *
 * **Case-sensitivity observation:** the `i` flag overrides whatever
 * case-sensitivity the site-registry's `allowedHostPattern` had at its
 * own RegExp creation. For URL matching this is acceptable — HTTP
 * hostnames are case-insensitive per RFC 7230; URL paths are
 * technically case-sensitive but the registered site patterns are
 * authored to be CI-safe (only ASCII labels in the host portion). Do
 * not relax this assumption when adding new sites without confirming
 * the path portion of the pattern survives `i`-folding.
 */
export const BROWSER_TASK_ALLOWLIST_REGEX_FLAGS = "i";

function buildComposedRegex(
  site: SiteDefinition,
  extras: readonly string[],
): RegExp {
  // The site's pattern already prefix-anchors `^https?://...host.../`
  // — wrap it as a captured alternation arm with the leading `^`
  // stripped so it composes cleanly into the union.
  const sitePattern = site.allowedHostPattern.source.replace(/^\^/, "");
  const arms: string[] = [`(?:${sitePattern})`];
  for (const host of extras) {
    arms.push(`(?:https?:\\/\\/${encodeHostForRegex(host)}(?:[\\/?#]|$))`);
  }
  return new RegExp(
    `^(?:${arms.join("|")})`,
    BROWSER_TASK_ALLOWLIST_REGEX_FLAGS,
  );
}

/** Convert a bare hostname (with optional leading `*.`) into a regex
 *  fragment. `*.example.com` becomes `(?:[a-z0-9-]+\.)?example\.com`
 *  so the wildcard matches a single non-empty subdomain label. */
function encodeHostForRegex(host: string): string {
  const escapeDot = (s: string) => s.replace(/\./g, "\\.");
  if (host.startsWith("*.")) {
    const tail = escapeDot(host.slice(2));
    return `(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)?${tail}`;
  }
  return escapeDot(host);
}
