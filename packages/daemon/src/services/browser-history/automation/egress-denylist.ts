/**
 * Global egress denylist for Instance A workflows (Phase B-2).
 *
 * MANAGED_CHROMIUM_IMPLEMENTATION_PLAN.md §8.6 — closes the localhost /
 * RFC1918 / link-local / cloud-metadata exfiltration vector at the
 * structural level. The denylist is **hardcoded** — the dashboard
 * cannot widen or narrow it. The per-workflow `allowlistRegex` is the
 * positive selector; this module is the unconditional negative one.
 *
 * Two layers:
 *
 *   1. Hostname denylist (eTLD+1 regex array). Matches by suffix so
 *      `evil.paypal.com.attacker.tld` does not slip through a naive
 *      `endsWith("paypal.com")` check — we extract eTLD+1 first.
 *
 *   2. IP CIDR denylist (RFC1918 + link-local + loopback + multicast +
 *      cloud metadata + IPv6 equivalents). Catches both:
 *        - IP literals in the URL host (`http://10.0.0.1/`)
 *        - Domains whose A/AAAA records resolve into a denied range
 *          (DNS-rebinding shape).
 *
 * Both layers are pure — `matchesHostnameDenylist(hostname)` is a
 * regex array walk; `matchesCidrDenylist(ip, ...)` is bitmask
 * arithmetic. DNS resolution is injected from the caller
 * (`cdp-network-interception.ts` provides the real `dns.lookup`); this
 * module never touches the network so it stays unit-testable.
 *
 * Categories from parent BROWSER_HISTORY_INTEGRATION_PLAN.md §23.2 +
 * MANAGED_CHROMIUM_IMPLEMENTATION_PLAN.md §8.6 are reproduced here as
 * regex entries with a one-line comment per category. Additions should
 * cite the source incident or category-spec entry; structural deletions
 * require an upstream parent-plan edit.
 */

// ─────────────────────────────────────────────────────────────────────
// Hostname denylist (eTLD+1 regex array)
// ─────────────────────────────────────────────────────────────────────

/**
 * Suffix-anchored regexes — each entry matches the eTLD+1 form of the
 * hostname. We extract eTLD+1 before testing so attacker-controlled
 * sub-domain prefixes do not leak through (`a.paypal.com.attacker.tld`
 * would extract to `attacker.tld` and miss the `paypal.com` entry,
 * which is correct).
 *
 * Order does not affect correctness; entries grouped by category for
 * review legibility.
 */
export const HOSTNAME_DENYLIST: ReadonlyArray<RegExp> = Object.freeze([
  // ── Payment processors (parent §23.2) ──
  /^(?:.*\.)?paypal\.com$/i,
  /^(?:.*\.)?stripe\.com$/i,
  /^(?:.*\.)?adyen\.com$/i,
  /^(?:.*\.)?square\.com$/i,
  /^(?:.*\.)?squareup\.com$/i,
  /^(?:.*\.)?braintreepayments\.com$/i,
  /^(?:.*\.)?venmo\.com$/i,
  /^(?:.*\.)?cash\.app$/i,

  // ── Banking / brokerage (parent §23) — hard-deny across all phases ──
  /^(?:.*\.)?chase\.com$/i,
  /^(?:.*\.)?bankofamerica\.com$/i,
  /^(?:.*\.)?wellsfargo\.com$/i,
  /^(?:.*\.)?citi\.com$/i,
  /^(?:.*\.)?capitalone\.com$/i,
  /^(?:.*\.)?usbank\.com$/i,
  /^(?:.*\.)?schwab\.com$/i,
  /^(?:.*\.)?fidelity\.com$/i,
  /^(?:.*\.)?vanguard\.com$/i,
  /^(?:.*\.)?robinhood\.com$/i,
  /^(?:.*\.)?etrade\.com$/i,
  /^(?:.*\.)?interactivebrokers\.com$/i,
  /^(?:.*\.)?coinbase\.com$/i,
  /^(?:.*\.)?binance\.com$/i,
  /^(?:.*\.)?kraken\.com$/i,
  // JP banking + brokerage — the project's primary owner is in Japan; the
  // hard-deny list must reflect that or the floor leaks for the actual
  // population. (Parent §23 hard-deny categories are jurisdiction-blind;
  // this is the JP enumeration of the same category.)
  /^(?:.*\.)?mizuhobank\.co\.jp$/i,
  /^(?:.*\.)?smbc\.co\.jp$/i,
  /^(?:.*\.)?bk\.mufg\.jp$/i,
  /^(?:.*\.)?japanpost\.jp$/i,
  /^(?:.*\.)?rakuten-bank\.co\.jp$/i,
  /^(?:.*\.)?bitflyer\.com$/i,
  /^(?:.*\.)?bitflyer\.jp$/i,

  // ── Government / identity ──
  /^(?:.*\.)?irs\.gov$/i,
  /^(?:.*\.)?ssa\.gov$/i,
  /^(?:.*\.)?usa\.gov$/i,
  /^(?:.*\.)?login\.gov$/i,
  /^(?:.*\.)?id\.me$/i,
  /^(?:.*\.)?gov\.uk$/i,
  /^(?:.*\.)?(?:[a-z-]+\.)?go\.jp$/i,

  // ── Healthcare ──
  // Epic Systems' MyChart EHR portals are deployed under per-tenant
  // subdomains of `mychart.org` (e.g. `mychart.providername.org`), which
  // the canonical `mychart.org` entry below already catches via the
  // `(?:.*\.)?` prefix. The deployment-specific hostnames
  // (`mychart.cedars-sinai.org`, etc.) sit on their own eTLD+1s and are
  // covered only when the user adds them to the per-domain allowlist;
  // hardcoding every healthcare tenant is impractical, but the
  // structural defence holds because the user allowlist is empty by
  // default (§8.4 step 3 / §8.11). The `epicgames.com` entry that
  // previously lived here was a mis-identification (Epic Games is the
  // gaming company that ships Fortnite, not Epic Systems' EHR) and
  // would have blocked a legitimate gaming-news article workflow while
  // providing zero healthcare coverage.
  /^(?:.*\.)?myhealth\.va\.gov$/i,
  /^(?:.*\.)?mychart\.org$/i,
  /^(?:.*\.)?healthcare\.gov$/i,

  // ── Critical infrastructure / cloud-provider control planes ──
  /^(?:.*\.)?aws\.amazon\.com$/i,
  /^(?:.*\.)?console\.aws\.amazon\.com$/i,
  /^(?:.*\.)?console\.cloud\.google\.com$/i,
  /^(?:.*\.)?portal\.azure\.com$/i,
  /^(?:.*\.)?cloudflare\.com$/i,

  // ── Educational portals (parent §23.2) ──
  // Generic .edu — broad but matches the parent plan's intent.
  /^(?:.*\.)?[a-z0-9-]+\.edu$/i,
  // ── Daemon-internal — the agent screenshotting `/api/health` to scrape
  // internal state. OQ-M9. The IP CIDR layer below catches `localhost`
  // / `127.0.0.1`; this hostname entry catches `aitne.local` style
  // mDNS forms that resolve via the user's router instead of /etc/hosts.
  /^(?:.*\.)?aitne\.local$/i,
  // Bare `localhost` (and any subdomain like `foo.localhost` which
  // browsers route to 127.0.0.1 per RFC6761). Belt-and-braces with the
  // CIDR layer below: `shouldDenyEgress` only walks the CIDR check when
  // (a) the hostname is an IP literal or (b) a DNS resolver was
  // injected AND the lookup succeeds. The resolver branch in
  // `shouldDenyEgress` fails-open on DNS error — without this hostname
  // entry, a request to `localhost` with a broken/stubbed resolver
  // would slip through. Adding the hostname here closes that hole
  // structurally.
  /^localhost$/i,
  /^(?:.*\.)?localhost$/i,
  // Microsoft / corporate Active Directory FQDN tail commonly carved
  // out for the host's own services (DNS pre-2008 default). Not
  // strictly RFC, but a frequent enough self-host shape that it
  // belongs alongside the localhost entries.
  /^[a-z0-9-]+\.local$/i,
]);

/**
 * Naïve eTLD+1 extractor — splits on `.` and returns the last two
 * labels. This misses **public-suffix-list multi-label TLDs**
 * (`co.uk`, `co.jp`, `com.br`, etc.); for those the hostname denylist
 * uses an explicit `(?:.*\.)?bk\.mufg\.jp$` form per entry so the
 * suffix match works regardless. The extractor's purpose is to defang
 * attacker-controlled SUBDOMAIN prefixes (`evil.paypal.com.attacker.tld`
 * resolves to `attacker.tld`, missing `paypal.com`) — that defence
 * holds in both the two-label and the PSL-multi-label cases.
 *
 * Trade-off: a fully-correct PSL implementation would pull in ~100 KB
 * of suffix data. For a hardcoded denylist whose entries each carry
 * their own suffix anchor, the regex-direct path is simpler and
 * equivalently safe. Re-evaluate if/when the denylist grows past ~50
 * entries.
 */
export function extractEtldPlusOne(hostname: string): string {
  const lower = hostname.toLowerCase().replace(/\.$/, "");
  const parts = lower.split(".").filter((p) => p.length > 0);
  if (parts.length <= 2) return lower;
  return parts.slice(-2).join(".");
}

/**
 * Returns true when ANY entry in the hostname denylist matches the
 * eTLD+1 form of `hostname`. The regexes themselves carry the suffix
 * anchor, so the eTLD+1 truncation is belt-and-suspenders against
 * subdomain-prefix bypass attempts.
 */
export function matchesHostnameDenylist(hostname: string): boolean {
  const etld = extractEtldPlusOne(hostname);
  for (const re of HOSTNAME_DENYLIST) {
    if (re.test(hostname) || re.test(etld)) return true;
  }
  return false;
}

// ─────────────────────────────────────────────────────────────────────
// IP CIDR denylist
// ─────────────────────────────────────────────────────────────────────

/**
 * MUST-deny CIDRs covering loopback, private (RFC1918), link-local
 * (incl. cloud metadata `169.254.169.254`), multicast, IPv6 loopback,
 * IPv6 ULA, IPv6 link-local, and the CGNAT range used by some VPN
 * carve-outs. Hard-coded so the dashboard cannot widen the surface.
 *
 * Cloud-metadata hosts are reachable from the host's network even
 * inside our OS sandbox (the sandbox primitives carve a network for
 * Chromium to talk to the open internet but do not block IP-level
 * routing to RFC1918 / link-local destinations). This list is the
 * primary defence at the Playwright `context.route` layer.
 */
export const IP_DENYLIST_CIDRS: ReadonlyArray<string> = Object.freeze([
  // IPv4 loopback / private / link-local
  "127.0.0.0/8",
  "10.0.0.0/8",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "169.254.0.0/16",
  "100.64.0.0/10",
  "224.0.0.0/4",
  "0.0.0.0/8",
  // IPv6 equivalents
  "::1/128",
  "fc00::/7",
  "fe80::/10",
  "fd00::/8",
  // IPv4-mapped IPv6 loopback — `::ffff:127.0.0.1/104` covers the entire
  // `::ffff:127.0.0.0/104` IPv4-loopback projection.
  "::ffff:127.0.0.0/104",
]);

/**
 * Parse a dotted-quad string into a 32-bit unsigned integer, or null on
 * a non-IPv4 input. Strict — rejects octal-prefixed, hex-prefixed, and
 * `1` (single integer) forms that some shells / curl historically
 * accept as IP literals.
 */
export function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let acc = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n < 0 || n > 255) return null;
    acc = (acc * 256) + n;
  }
  // `acc` may exceed Number.MAX_SAFE_INTEGER? — no, 32-bit max is well
  // under 2^53. Return as unsigned via >>> 0 for downstream masking.
  return acc >>> 0;
}

/**
 * Parse an IPv6 textual address into a 128-bit bigint. Supports `::`
 * collapsing and embedded-IPv4 form (`::ffff:192.0.2.1`). Returns null
 * on invalid input.
 */
export function ipv6ToBigInt(ip: string): bigint | null {
  // Reject anything with characters outside the IPv6 alphabet plus `.`
  // (embedded-IPv4 dotted-quad tail).
  if (!/^[0-9a-fA-F:.]+$/.test(ip)) return null;
  // Embedded IPv4 — split off the trailing dotted-quad and convert to
  // two 16-bit groups so the rest of the parser only sees hex blocks.
  let normalized = ip;
  const ipv4TailMatch = normalized.match(/:(\d+\.\d+\.\d+\.\d+)$/);
  if (ipv4TailMatch) {
    const ipv4Int = ipv4ToInt(ipv4TailMatch[1]);
    if (ipv4Int === null) return null;
    const hi = (ipv4Int >>> 16) & 0xffff;
    const lo = ipv4Int & 0xffff;
    normalized =
      normalized.slice(0, -ipv4TailMatch[1].length - 1)
      + `:${hi.toString(16)}:${lo.toString(16)}`;
  }
  // At most one `::` collapse.
  const halves = normalized.split("::");
  if (halves.length > 2) return null;
  const leftGroups = halves[0].length > 0 ? halves[0].split(":") : [];
  const rightGroups =
    halves.length === 2 && halves[1].length > 0 ? halves[1].split(":") : [];
  if (halves.length === 1 && leftGroups.length !== 8) return null;
  if (halves.length === 2 && leftGroups.length + rightGroups.length > 8) return null;
  const gap = 8 - (leftGroups.length + rightGroups.length);
  const groups: string[] = [
    ...leftGroups,
    ...new Array<string>(gap).fill("0"),
    ...rightGroups,
  ];
  /* c8 ignore next -- defensive: post-collapse arithmetic always yields 8 groups when the two `if` guards above pass; left in as a structural assert */
  if (groups.length !== 8) return null;
  let acc = 0n;
  for (const g of groups) {
    if (g.length === 0 || g.length > 4 || !/^[0-9a-fA-F]+$/.test(g)) return null;
    acc = (acc << 16n) | BigInt(parseInt(g, 16));
  }
  return acc;
}

/**
 * Test whether `ip` lies within `cidr`. Dispatches to the v4 or v6
 * arithmetic path based on the CIDR's family. Returns false on any
 * parse error (defensive — a malformed `ip` should NOT pass the
 * denylist check by accident).
 */
export function ipInCidr(ip: string, cidr: string): boolean {
  const slashIdx = cidr.indexOf("/");
  if (slashIdx === -1) return false;
  const base = cidr.slice(0, slashIdx);
  const prefixStr = cidr.slice(slashIdx + 1);
  if (!/^\d+$/.test(prefixStr)) return false;
  const prefix = Number(prefixStr);
  if (base.includes(":") || ip.includes(":")) {
    if (prefix < 0 || prefix > 128) return false;
    const baseBits = ipv6ToBigInt(base);
    const ipBits = ipv6ToBigInt(ip);
    if (baseBits === null || ipBits === null) return false;
    if (prefix === 0) return true;
    const mask = ((1n << BigInt(prefix)) - 1n) << BigInt(128 - prefix);
    return (baseBits & mask) === (ipBits & mask);
  }
  if (prefix < 0 || prefix > 32) return false;
  const baseInt = ipv4ToInt(base);
  const ipInt = ipv4ToInt(ip);
  if (baseInt === null || ipInt === null) return false;
  if (prefix === 0) return true;
  const mask = ((0xffffffff << (32 - prefix)) >>> 0);
  return ((baseInt & mask) >>> 0) === ((ipInt & mask) >>> 0);
}

/**
 * Returns true when `ip` falls inside any CIDR in `IP_DENYLIST_CIDRS`.
 * Walks the small fixed list — at ~14 entries the linear scan is faster
 * than building a trie.
 */
export function matchesCidrDenylist(ip: string): boolean {
  for (const cidr of IP_DENYLIST_CIDRS) {
    if (ipInCidr(ip, cidr)) return true;
  }
  return false;
}

/**
 * Pure boolean check used by the CDP route handler: given a URL string,
 * decide whether it must be blocked.
 *
 * Decision order:
 *   1. Parse the URL — invalid URLs are blocked (defensive — a request
 *      whose URL we can't parse should not reach the network).
 *   2. Hostname denylist check (eTLD+1 + suffix-anchored regex array).
 *   3. If `hostname` is an IP literal (v4 or v6), check it directly
 *      against the CIDR denylist.
 *   4. If a `resolveIps` resolver was passed, resolve `hostname` to one
 *      or more IPs and check each against the CIDR list (catches the
 *      DNS-rebinding shape — `internal.example.com → 10.0.0.1`).
 *
 * The resolver is injected so this module stays test-pure; the wire
 * caller in `cdp-network-interception.ts` provides
 * `dns.promises.lookup`.
 */
export interface ResolveIps {
  (hostname: string): Promise<readonly string[]>;
}

export async function shouldDenyEgress(
  url: string,
  opts?: { resolveIps?: ResolveIps },
): Promise<{ denied: true; reason: "hostname" | "cidr" | "invalid_url" } | { denied: false }> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { denied: true, reason: "invalid_url" };
  }
  // WHATWG `URL.hostname` for an IPv6 literal returns the bracketed
  // form (`"[::1]"`). The CIDR matcher works on bare addresses, so
  // strip the brackets up-front. Hostname-denylist regexes never carry
  // IPv6 literals, so the strip is safe for that leg too.
  const rawHostname = parsed.hostname.toLowerCase();
  const hostname =
    rawHostname.startsWith("[") && rawHostname.endsWith("]")
      ? rawHostname.slice(1, -1)
      : rawHostname;
  if (matchesHostnameDenylist(hostname)) {
    return { denied: true, reason: "hostname" };
  }
  const isIpLiteral = isIpv4Literal(hostname) || isIpv6Literal(hostname);
  if (isIpLiteral) {
    if (matchesCidrDenylist(hostname)) {
      return { denied: true, reason: "cidr" };
    }
    return { denied: false };
  }
  if (opts?.resolveIps) {
    let resolved: readonly string[] = [];
    try {
      resolved = await opts.resolveIps(hostname);
    } catch {
      // DNS failure → let the request through; if the lookup is broken
      // here it will fail at the network layer too. Failing closed
      // (treating a DNS error as a block) would brick every workflow
      // during a temporary resolver outage.
      return { denied: false };
    }
    for (const ip of resolved) {
      if (matchesCidrDenylist(ip)) {
        return { denied: true, reason: "cidr" };
      }
    }
  }
  return { denied: false };
}

function isIpv4Literal(hostname: string): boolean {
  return ipv4ToInt(hostname) !== null;
}

function isIpv6Literal(hostname: string): boolean {
  // `URL.hostname` returns IPv6 bare (no brackets), so a `:` is the
  // signature. We still parse to confirm.
  if (!hostname.includes(":")) return false;
  return ipv6ToBigInt(hostname) !== null;
}
