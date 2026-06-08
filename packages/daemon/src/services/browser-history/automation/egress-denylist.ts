/**
 * Global egress denylist for the browser-task surface.
 *
 * Two layers:
 *
 *   1. **Hostname denylist (DI-injected, user-managed)** — list of
 *      suffix-anchored regexes the *caller* supplies. The list is
 *      sourced from `runtime-settings.browserTaskHostnameDenylist`
 *      (Dashboard `/settings/browser` exclusion list, default empty).
 *      No domain is hardcoded here — Aitne ships as a US-targeted
 *      general-purpose agent and the framework does not embed
 *      opinions about which third-party brands to block. The owner
 *      curates the list in Dashboard. The export `HOSTNAME_DENYLIST`
 *      survives as an empty frozen array for backward-compatible
 *      imports (tests, callers that haven't yet plumbed the runtime
 *      list).
 *
 *      Historical context: prior revisions of this file pinned ~40
 *      brand names (paypal/stripe/banks/.gov/.edu/healthcare/JP-banks)
 *      as a hardcoded "safety floor". That model was removed
 *      (2026-05-27 — see `feedback_no_jp_special_no_hardcoded_domains`)
 *      because (a) the JP enumeration leaked an owner-jurisdiction
 *      assumption into a US-targeted product, (b) the hardcoded list
 *      made open-ended browser-task requests (e.g. "look up Hitachi
 *      IR") fail at the registry-check before they hit the denylist,
 *      and (c) the framework should not opinionate which sites a
 *      user can read. The `payment-path-blocker` URL-pattern layer
 *      remains the structural defence against accidental purchases /
 *      money movement; the per-route allowlist on `browser_task`
 *      is now permissive by default (no positive selector).
 *
 *   2. **IP CIDR denylist (HARDCODED)** — RFC1918 + link-local +
 *      loopback + multicast + cloud-metadata + IPv6 equivalents. NOT
 *      domain-level; this is *network infrastructure* protection
 *      against the agent reaching `169.254.169.254` (AWS instance
 *      metadata), the user's internal LAN, or the daemon's own
 *      127.0.0.1 API. The CIDR layer stays hardcoded because removing
 *      it would expose cloud-instance metadata endpoints + private
 *      LAN devices — categories whose identity is the IP range itself,
 *      not a brand name.
 *
 * DNS resolution is injected from the caller
 * (`cdp-network-interception.ts` provides the real `dns.lookup`); this
 * module never touches the network so it stays unit-testable.
 */

// ─────────────────────────────────────────────────────────────────────
// Hostname denylist (now DI-injected; no hardcoded entries)
// ─────────────────────────────────────────────────────────────────────

/**
 * Empty by default — the framework no longer hardcodes third-party
 * domain entries (no payment processors, no banks, no government, no
 * healthcare, no JP-specific brands). The CDP interception layer reads
 * the user-curated list from `runtime-settings.browserTaskHostnameDenylist`
 * and passes it to `matchesHostnameDenylist` / `shouldDenyEgress` at
 * each call.
 *
 * Kept exported as a frozen empty array so legacy imports keep parsing,
 * the "is-frozen" test invariant still holds, and a future revision
 * that wants to re-add a single structural entry (e.g. a never-allowed
 * project-internal hostname) has a clear seam to do so.
 */
export const HOSTNAME_DENYLIST: ReadonlyArray<RegExp> = Object.freeze([]);

/**
 * Compile user-supplied hostname patterns into regex matchers for
 * `matchesHostnameDenylist`. Three shapes are accepted:
 *
 *   1. **Bare hostname** (`paypal.com`, `api.example.co.uk`) —
 *      suffix-anchored: matches the exact host AND any subdomain.
 *      Equivalent to the historical hardcoded format.
 *   2. **Leading-wildcard sugar** (`*.example.com`) — sugar for the
 *      bare form. Matches `example.com` AND any subdomain. (Strict
 *      "subdomain only" was rejected: a user adding `*.example.com`
 *      to their denylist almost always means "block the whole
 *      property", so including the parent eTLD+1 is the safer default.
 *      Users who want literal "subdomain only" can combine with the
 *      negative absence of the bare entry.)
 *   3. **General glob** (`*foo*`, `tracker*`, `*.com`, `analytics.*`,
 *      `*paypal*tracker*`) — each `*` compiles to `[a-z0-9.-]*` and
 *      the resulting regex is fully anchored (`^...$`) against the
 *      hostname. Enables partial-match denials.
 *
 * Entry validation:
 *   - empty / whitespace-only → dropped
 *   - no alphanumeric character → dropped (rejects bare `*`, `*.*`,
 *     `--`, etc.)
 *   - contains a character outside `[a-z0-9.\-*]` → dropped (rejects
 *     scheme prefixes, paths, ports, userinfo, IDN punycode for now)
 *   - leading or trailing dot → dropped
 *   - consecutive dots → dropped
 *   - length > 253 → dropped (DNS hostname max)
 *
 * Invalid entries are silently dropped — the dashboard / API layer is
 * responsible for surfacing validation errors to the user before they
 * land in the persisted config.
 */
const VALID_PATTERN_CHARS_RE = /^[a-z0-9.\-*]+$/i;

/** Bare-hostname shape (matches the historical compile target). Used to
 *  decide whether the `*.X` sugar branch can apply. */
const BARE_HOSTNAME_RE =
  /^(?:[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

export function compileUserHostnameDenylist(
  entries: readonly string[],
): ReadonlyArray<RegExp> {
  const out: RegExp[] = [];
  for (const raw of entries) {
    const normalized = (raw ?? "").trim().toLowerCase();
    if (!normalized) continue;
    if (normalized.length > 253) continue;
    if (!VALID_PATTERN_CHARS_RE.test(normalized)) continue;
    if (!/[a-z0-9]/.test(normalized)) continue;
    if (normalized.startsWith(".") || normalized.endsWith(".")) continue;
    if (normalized.includes("..")) continue;

    const hasWildcard = normalized.includes("*");

    // Bare hostname — suffix-anchored (matches host + any subdomain).
    if (!hasWildcard) {
      if (!BARE_HOSTNAME_RE.test(normalized)) continue;
      const escaped = normalized.replace(/\./g, "\\.");
      out.push(new RegExp(`^(?:.*\\.)?${escaped}$`, "i"));
      continue;
    }

    // `*.X` sugar — only when X is itself a valid bare hostname and the
    // rest of the pattern has no further wildcards. Compiled identically
    // to bare X (suffix-anchored, parent eTLD+1 included).
    if (normalized.startsWith("*.")) {
      const tail = normalized.slice(2);
      if (!tail.includes("*") && BARE_HOSTNAME_RE.test(tail)) {
        const escaped = tail.replace(/\./g, "\\.");
        out.push(new RegExp(`^(?:.*\\.)?${escaped}$`, "i"));
        continue;
      }
      // Fall through to the general glob path otherwise (e.g. `*.com`,
      // `*.foo*`).
    }

    // General glob — each `*` matches `[a-z0-9.-]*` (DNS-safe chars,
    // zero or more). Dots / hyphens in literal segments are escaped.
    // Fully anchored against the hostname.
    const literalParts = normalized.split("*").map((part) =>
      part.replace(/[.\\\-]/g, (c) => `\\${c}`),
    );
    const pattern = `^${literalParts.join("[a-z0-9.\\-]*")}$`;
    out.push(new RegExp(pattern, "i"));
  }
  return Object.freeze(out);
}

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
 * Returns true when ANY entry in the supplied hostname denylist matches
 * `hostname`. Each compiled regex from `compileUserHostnameDenylist`
 * already carries the correct anchor (suffix-anchored for bare /
 * `*.X` patterns; fully `^...$` anchored for general glob patterns) so
 * the test is a single `re.test(hostname)` per entry.
 *
 * Historical note: prior revisions also tested against
 * `extractEtldPlusOne(hostname)` as belt-and-braces against subdomain-
 * prefix bypass. That second check is unnecessary now (bare patterns'
 * `^(?:.*\.)?X$` shape already rejects `evil.X.attacker.tld` because
 * the hostname must END in X) and was actively HARMFUL for glob
 * patterns (`tracker*` matched against `analytics.tracker.com` would
 * false-positive via the `tracker.com` eTLD+1 truncation, even though
 * the literal hostname starts with `analytics`).
 *
 * The `list` parameter is injected by the caller; when omitted, the
 * module-level (empty) `HOSTNAME_DENYLIST` is used so the function is
 * still safe to call with no runtime configuration.
 */
export function matchesHostnameDenylist(
  hostname: string,
  list: ReadonlyArray<RegExp> = HOSTNAME_DENYLIST,
): boolean {
  if (list.length === 0) return false;
  // Normalize at the chokepoint so every caller (shouldDenyEgress,
  // cdp-network-interception fast-path, screenshot-output redaction) is
  // covered: lowercase + strip a single trailing FQDN dot. WHATWG `URL`
  // preserves the trailing dot (`new URL("http://paypal.com./").hostname
  // === "paypal.com."`), which the suffix-anchored `^(?:.*\.)?paypal\.com$`
  // regex would NOT match — so without this strip a `paypal.com.` host
  // evades a user `paypal.com` denylist entry entirely.
  const h = hostname.toLowerCase().replace(/\.$/, "");
  for (const re of list) {
    if (re.test(h)) return true;
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
  // IETF protocol assignments (RFC 6890) — includes the DNS64 well-known
  // host 192.0.0.171/.170 used to discover the NAT64 prefix. Not globally
  // routable; no legitimate browse target lives here.
  "192.0.0.0/24",
  // IPv6 equivalents
  "::1/128",
  "::/128", // IPv6 unspecified — mirrors IPv4 0.0.0.0/8; routes to ::1 as a connect target on common stacks
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
  // IPv4-mapped IPv6 (`::ffff:0:0/96`): extract the embedded IPv4 and run
  // it through the IPv4 CIDRs so every v4 deny range is covered without
  // duplicating each as a `/104..../112` v6-mapped entry. WHATWG `URL`
  // normalizes `[::ffff:169.254.169.254]` to `::ffff:a9fe:a9fe`, so the
  // literal-dotted form never survives to here — we must decode the
  // bigint. This closes the SSRF hole where `::ffff:a9fe:a9fe`
  // (AWS/GCP metadata) or `::ffff:10.0.0.1` (RFC1918) would otherwise
  // pass the CIDR check. Covers both the IP-literal leg and any resolved
  // V4MAPPED address from the DNS-resolution leg.
  if (ip.includes(":")) {
    const bits = ipv6ToBigInt(ip);
    if (bits !== null) {
      const mask96 = ((1n << 96n) - 1n) << 32n; // high 96 bits
      const v4MappedPrefix = 0xffffn << 32n; // ::ffff:0:0/96
      // NAT64 well-known prefix `64:ff9b::/96` (RFC 6052) — on NAT64/DNS64
      // networks the entire IPv4 internet is reachable through this prefix,
      // so `64:ff9b::a9fe:a9fe` routes to 169.254.169.254 and
      // `64:ff9b::a00:1` to 10.0.0.1. We must NOT block the whole /96
      // (that would break all IPv4 browsing on such networks) — instead
      // decode the embedded IPv4 (low 32 bits, same position as the
      // v4-mapped form) and run it through the IPv4 deny ranges, so only
      // metadata/private destinations are blocked. Network-specific NAT64
      // prefixes (operator-chosen /32../64) are out of scope — they aren't
      // a guessable SSRF target the way the well-known prefix is.
      const nat64WellKnownPrefix = 0x0064ff9bn << 96n; // 64:ff9b::/96
      const prefix96 = bits & mask96;
      if (prefix96 === v4MappedPrefix || prefix96 === nat64WellKnownPrefix) {
        const embedded = Number(bits & 0xffffffffn);
        const dotted = [
          (embedded >>> 24) & 255,
          (embedded >>> 16) & 255,
          (embedded >>> 8) & 255,
          embedded & 255,
        ].join(".");
        for (const cidr of IP_DENYLIST_CIDRS) {
          if (cidr.includes(":")) continue; // only the IPv4 CIDRs
          if (ipInCidr(dotted, cidr)) return true;
        }
      }
    }
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
  opts?: { resolveIps?: ResolveIps; hostnameDenylist?: ReadonlyArray<RegExp> },
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
  if (matchesHostnameDenylist(hostname, opts?.hostnameDenylist)) {
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
