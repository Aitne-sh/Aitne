import { describe, expect, it } from "vitest";

import {
  compileUserHostnameDenylist,
  extractEtldPlusOne,
  HOSTNAME_DENYLIST,
  IP_DENYLIST_CIDRS,
  ipInCidr,
  ipv4ToInt,
  ipv6ToBigInt,
  matchesCidrDenylist,
  matchesHostnameDenylist,
  shouldDenyEgress,
} from "./egress-denylist.js";

describe("egress-denylist", () => {
  describe("extractEtldPlusOne", () => {
    it("returns the last two labels for typical hostnames", () => {
      expect(extractEtldPlusOne("www.example.com")).toBe("example.com");
      expect(extractEtldPlusOne("a.b.c.example.com")).toBe("example.com");
    });

    it("returns the input unchanged for 1- or 2-label hostnames", () => {
      expect(extractEtldPlusOne("example.com")).toBe("example.com");
      expect(extractEtldPlusOne("localhost")).toBe("localhost");
    });

    it("trims trailing dot and lower-cases", () => {
      expect(extractEtldPlusOne("WWW.EXAMPLE.COM.")).toBe("example.com");
    });

    it("filters empty path segments from double-dotted input", () => {
      expect(extractEtldPlusOne("a..example.com")).toBe("example.com");
    });
  });

  describe("HOSTNAME_DENYLIST default state", () => {
    it("is empty by default — the framework does not hardcode any third-party domain entries", () => {
      // Historical revisions of this module pinned ~40 brand names
      // (paypal/stripe/banks/.gov/.edu/healthcare/JP-banks) as a
      // hardcoded safety floor. That model was removed because (a) it
      // baked an owner-jurisdiction assumption into a US-targeted
      // product and (b) it forced "look up X" tasks against unrelated
      // brands to bypass the registry-check, making the open-ended
      // browser-task surface unusable for general lookups. The list is
      // now sourced from `runtime-settings.browserTaskHostnameDenylist`
      // (user-curated via Dashboard `/settings/browser`).
      expect(HOSTNAME_DENYLIST.length).toBe(0);
    });

    it("freezes the empty default (shape invariant)", () => {
      expect(Object.isFrozen(HOSTNAME_DENYLIST)).toBe(true);
    });

    it("returns false for every hostname when no list is supplied", () => {
      expect(matchesHostnameDenylist("paypal.com")).toBe(false);
      expect(matchesHostnameDenylist("chase.com")).toBe(false);
      expect(matchesHostnameDenylist("login.gov")).toBe(false);
      expect(matchesHostnameDenylist("hitachi.com")).toBe(false);
    });
  });

  describe("compileUserHostnameDenylist + matchesHostnameDenylist with injected list", () => {
    it("compiles bare hostnames into suffix-anchored regexes", () => {
      const list = compileUserHostnameDenylist(["paypal.com", "chase.com"]);
      expect(matchesHostnameDenylist("paypal.com", list)).toBe(true);
      expect(matchesHostnameDenylist("www.paypal.com", list)).toBe(true);
      expect(matchesHostnameDenylist("checkout.chase.com", list)).toBe(true);
      expect(matchesHostnameDenylist("anthropic.com", list)).toBe(false);
    });

    it("accepts the leading `*.` sugar as identical to the bare form", () => {
      // `*.example.com` and `example.com` are equivalent — both produce
      // a suffix-anchored regex that covers the eTLD+1 and any subdomain.
      const list = compileUserHostnameDenylist(["*.example.com"]);
      expect(matchesHostnameDenylist("example.com", list)).toBe(true);
      expect(matchesHostnameDenylist("api.example.com", list)).toBe(true);
    });

    it("silently drops malformed entries (scheme-prefixed, whitespace, empty, path-shaped)", () => {
      // Note: `evil*.com` is NO LONGER malformed — the 2026-05-27 revision
      // introduced general glob support, so `*` is valid anywhere. The
      // dropped entries here are: scheme prefix, path segment, empty /
      // whitespace-only.
      const list = compileUserHostnameDenylist([
        "",
        "   ",
        "https://example.com",
        "/path",
        "valid.com",
      ]);
      expect(list.length).toBe(1);
      expect(matchesHostnameDenylist("valid.com", list)).toBe(true);
    });

    it("defangs subdomain-prefix bypass attempts via suffix anchoring", () => {
      const list = compileUserHostnameDenylist(["paypal.com"]);
      // `evil.paypal.com.attacker.tld` does NOT end in `paypal.com`
      // (suffix is `.tld`), so the bare-pattern suffix-anchored regex
      // `^(?:.*\.)?paypal\.com$` does not match. The hostname slips by
      // — which is correct: the user's `paypal.com` rule means "block
      // paypal.com or its subdomains", not "block any URL whose
      // hostname *contains* the substring paypal.com". A user who wants
      // the latter shape can register `*paypal*` (general glob) which
      // would catch this case.
      expect(matchesHostnameDenylist("evil.paypal.com.attacker.tld", list)).toBe(false);
      // Direct subdomain access still blocks (the suffix regex matches
      // the canonical `<sub>.paypal.com` shape).
      expect(matchesHostnameDenylist("login.paypal.com", list)).toBe(true);
    });

    it("strips a trailing FQDN dot so `paypal.com.` cannot evade a `paypal.com` entry", () => {
      const list = compileUserHostnameDenylist(["paypal.com"]);
      expect(matchesHostnameDenylist("paypal.com.", list)).toBe(true);
      expect(matchesHostnameDenylist("www.paypal.com.", list)).toBe(true);
      expect(matchesHostnameDenylist("PayPal.com.", list)).toBe(true);
    });

    it("case-insensitive matching", () => {
      const list = compileUserHostnameDenylist(["EXAMPLE.com"]);
      expect(matchesHostnameDenylist("example.com", list)).toBe(true);
      expect(matchesHostnameDenylist("EXAMPLE.COM", list)).toBe(true);
    });
  });

  describe("compileUserHostnameDenylist — general glob patterns", () => {
    it("`*foo*` matches any hostname containing 'foo'", () => {
      const list = compileUserHostnameDenylist(["*paypal*"]);
      expect(matchesHostnameDenylist("paypal.com", list)).toBe(true);
      expect(matchesHostnameDenylist("login.paypal.com", list)).toBe(true);
      expect(matchesHostnameDenylist("paypal.attacker.com", list)).toBe(true);
      expect(matchesHostnameDenylist("evil.paypal.com.attacker.tld", list)).toBe(true);
      expect(matchesHostnameDenylist("anthropic.com", list)).toBe(false);
    });

    it("`tracker*` matches any hostname starting with 'tracker'", () => {
      const list = compileUserHostnameDenylist(["tracker*"]);
      expect(matchesHostnameDenylist("tracker.example.com", list)).toBe(true);
      expect(matchesHostnameDenylist("tracker-prod.foo.com", list)).toBe(true);
      expect(matchesHostnameDenylist("example.com", list)).toBe(false);
      expect(matchesHostnameDenylist("analytics.tracker.com", list)).toBe(false);
    });

    it("`*.com` matches any hostname ending in '.com'", () => {
      const list = compileUserHostnameDenylist(["*.com"]);
      expect(matchesHostnameDenylist("paypal.com", list)).toBe(true);
      expect(matchesHostnameDenylist("api.paypal.com", list)).toBe(true);
      expect(matchesHostnameDenylist("paypal.co.jp", list)).toBe(false);
      expect(matchesHostnameDenylist("paypal.org", list)).toBe(false);
    });

    it("`analytics.*` matches any hostname starting with 'analytics.'", () => {
      const list = compileUserHostnameDenylist(["analytics.*"]);
      expect(matchesHostnameDenylist("analytics.google.com", list)).toBe(true);
      expect(matchesHostnameDenylist("analytics.foo.io", list)).toBe(true);
      expect(matchesHostnameDenylist("foo.analytics.com", list)).toBe(false);
    });

    it("multiple wildcards compose left-to-right", () => {
      const list = compileUserHostnameDenylist(["*ads*track*"]);
      expect(matchesHostnameDenylist("ads.track.example.com", list)).toBe(true);
      expect(matchesHostnameDenylist("foo-ads-bar-track-baz.com", list)).toBe(true);
      expect(matchesHostnameDenylist("track.ads.example.com", list)).toBe(false);
    });

    it("rejects bare-star and other non-literal patterns", () => {
      const list = compileUserHostnameDenylist(["*", "**", "*.*", "...", ".com", "com.", ""]);
      expect(list.length).toBe(0);
    });

    it("rejects entries with disallowed characters (scheme, path, port, userinfo)", () => {
      const list = compileUserHostnameDenylist([
        "https://example.com",
        "example.com/path",
        "example.com:8080",
        "user@example.com",
        "example com",
      ]);
      expect(list.length).toBe(0);
    });

    it("drops null/undefined entries, over-long entries, consecutive dots, and non-bare no-wildcard hosts", () => {
      const list = compileUserHostnameDenylist([
        null as unknown as string, // raw ?? "" branch
        undefined as unknown as string,
        `${"a".repeat(254)}.com`, // length > 253
        "foo..bar.com", // consecutive dots (has alphanumerics, so survives the no-alnum check)
        "localhost", // no wildcard, but not a valid bare hostname (single label)
      ]);
      expect(list.length).toBe(0);
    });

    it("mixed list — bare + sugar + glob coexist", () => {
      const list = compileUserHostnameDenylist([
        "paypal.com",
        "*.example.com",
        "*tracker*",
        "*.co.uk",
      ]);
      expect(list.length).toBe(4);
      expect(matchesHostnameDenylist("paypal.com", list)).toBe(true);
      expect(matchesHostnameDenylist("api.paypal.com", list)).toBe(true);
      expect(matchesHostnameDenylist("example.com", list)).toBe(true);
      expect(matchesHostnameDenylist("api.example.com", list)).toBe(true);
      expect(matchesHostnameDenylist("ads.tracker.io", list)).toBe(true);
      expect(matchesHostnameDenylist("foo.co.uk", list)).toBe(true);
      expect(matchesHostnameDenylist("anthropic.com", list)).toBe(false);
    });
  });

  describe("ipv4ToInt", () => {
    it("parses dotted-quad addresses", () => {
      expect(ipv4ToInt("0.0.0.0")).toBe(0);
      expect(ipv4ToInt("127.0.0.1")).toBe((127 << 24) + 1);
      expect(ipv4ToInt("255.255.255.255")).toBe(0xffffffff);
    });

    it("rejects out-of-range octets, wrong-shape inputs", () => {
      expect(ipv4ToInt("256.0.0.0")).toBeNull();
      expect(ipv4ToInt("10.0.0")).toBeNull();
      expect(ipv4ToInt("10.0.0.0.0")).toBeNull();
      expect(ipv4ToInt("a.b.c.d")).toBeNull();
      expect(ipv4ToInt("10.0.0.-1")).toBeNull();
      // Strict — no leading-zero hex / octal trickery.
      expect(ipv4ToInt("0x7f.0.0.1")).toBeNull();
    });
  });

  describe("ipv6ToBigInt", () => {
    it("parses loopback and full forms", () => {
      expect(ipv6ToBigInt("::1")).toBe(1n);
      expect(ipv6ToBigInt("::")).toBe(0n);
      expect(ipv6ToBigInt("2001:0db8:0000:0000:0000:0000:0000:0001")).toBe(
        (0x2001n << 112n) | (0x0db8n << 96n) | 1n,
      );
    });

    it("parses :: collapsed forms", () => {
      expect(ipv6ToBigInt("2001:db8::1")).toBe(
        (0x2001n << 112n) | (0x0db8n << 96n) | 1n,
      );
    });

    it("parses embedded-IPv4 form", () => {
      // ::ffff:127.0.0.1
      const expected = (0xffffn << 32n) | BigInt(ipv4ToInt("127.0.0.1") ?? 0);
      expect(ipv6ToBigInt("::ffff:127.0.0.1")).toBe(expected);
    });

    it("rejects malformed input", () => {
      expect(ipv6ToBigInt("not:an:address")).toBe(null);
      expect(ipv6ToBigInt(":::1")).toBe(null);
      expect(ipv6ToBigInt("2001:db8:::1")).toBe(null);
      expect(ipv6ToBigInt("12345::1")).toBe(null);
      expect(ipv6ToBigInt("g::1")).toBe(null);
      expect(ipv6ToBigInt("::ffff:300.0.0.1")).toBe(null);
      // No collapse at all but wrong group count
      expect(ipv6ToBigInt("1:2:3:4:5:6:7")).toBe(null);
      // Empty group not at ends.
      expect(ipv6ToBigInt("2001::db8::1")).toBe(null);
      // Empty inner group via single colons.
      expect(ipv6ToBigInt("2001::")).not.toBe(null);
      // Collapse with too many groups across the gap (left+right > 8).
      expect(ipv6ToBigInt("1:2:3:4:5:6:7::8:9")).toBe(null);
    });
  });

  describe("ipInCidr", () => {
    it("matches IPv4 networks correctly", () => {
      expect(ipInCidr("10.0.0.1", "10.0.0.0/8")).toBe(true);
      expect(ipInCidr("10.255.255.255", "10.0.0.0/8")).toBe(true);
      expect(ipInCidr("11.0.0.1", "10.0.0.0/8")).toBe(false);
      expect(ipInCidr("169.254.169.254", "169.254.0.0/16")).toBe(true);
      expect(ipInCidr("169.254.169.254", "169.254.0.0/0")).toBe(true);
    });

    it("matches IPv6 networks correctly", () => {
      expect(ipInCidr("::1", "::1/128")).toBe(true);
      expect(ipInCidr("fe80::1", "fe80::/10")).toBe(true);
      expect(ipInCidr("fc00::1", "fc00::/7")).toBe(true);
      expect(ipInCidr("fd00::1", "fc00::/7")).toBe(true);
      expect(ipInCidr("2001::1", "fc00::/7")).toBe(false);
      expect(ipInCidr("2001::1", "::/0")).toBe(true);
    });

    it("rejects malformed CIDR strings", () => {
      expect(ipInCidr("10.0.0.1", "10.0.0.0")).toBe(false);
      expect(ipInCidr("10.0.0.1", "10.0.0.0/abc")).toBe(false);
      expect(ipInCidr("10.0.0.1", "10.0.0.0/33")).toBe(false);
      expect(ipInCidr("::1", "::/200")).toBe(false);
    });

    it("rejects parse failures on either side", () => {
      expect(ipInCidr("not.ip", "10.0.0.0/8")).toBe(false);
      expect(ipInCidr("10.0.0.1", "not.ip/8")).toBe(false);
      expect(ipInCidr("::g", "::1/128")).toBe(false);
    });
  });

  describe("matchesCidrDenylist", () => {
    it("blocks all required cloud metadata + RFC1918 ranges", () => {
      expect(matchesCidrDenylist("127.0.0.1")).toBe(true);
      expect(matchesCidrDenylist("10.0.0.1")).toBe(true);
      expect(matchesCidrDenylist("172.16.0.1")).toBe(true);
      expect(matchesCidrDenylist("192.168.1.1")).toBe(true);
      expect(matchesCidrDenylist("169.254.169.254")).toBe(true);
      expect(matchesCidrDenylist("100.64.0.1")).toBe(true);
      expect(matchesCidrDenylist("224.0.0.1")).toBe(true);
      expect(matchesCidrDenylist("::1")).toBe(true);
      expect(matchesCidrDenylist("fc00::1")).toBe(true);
      expect(matchesCidrDenylist("fe80::1")).toBe(true);
      expect(matchesCidrDenylist("fd00::1")).toBe(true);
      expect(matchesCidrDenylist("::ffff:127.0.0.1")).toBe(true);
    });

    it("blocks IPv4-mapped IPv6 forms of every private/metadata range (SSRF defence)", () => {
      // WHATWG URL normalizes [::ffff:169.254.169.254] -> ::ffff:a9fe:a9fe,
      // which no v6 CIDR matches — the embedded-IPv4 re-check is what closes
      // the cloud-metadata / RFC1918 SSRF hole on the IP-literal and the
      // resolved-V4MAPPED legs.
      expect(matchesCidrDenylist("::ffff:a9fe:a9fe")).toBe(true); // 169.254.169.254 (metadata)
      expect(matchesCidrDenylist("::ffff:169.254.169.254")).toBe(true); // dotted v4-mapped
      expect(matchesCidrDenylist("::ffff:10.0.0.1")).toBe(true); // RFC1918 10/8
      expect(matchesCidrDenylist("::ffff:0a00:0001")).toBe(true); // 10.0.0.1 (hex groups)
      expect(matchesCidrDenylist("::ffff:172.16.0.1")).toBe(true); // RFC1918 172.16/12
      expect(matchesCidrDenylist("::ffff:192.168.1.1")).toBe(true); // RFC1918 192.168/16
      expect(matchesCidrDenylist("::ffff:c0a8:0101")).toBe(true); // 192.168.1.1 (hex groups)
      expect(matchesCidrDenylist("::ffff:100.64.0.1")).toBe(true); // CGNAT 100.64/10
    });

    it("blocks the IPv6 unspecified address ::", () => {
      expect(matchesCidrDenylist("::")).toBe(true);
    });

    it("allows public IPv4 and IPv6", () => {
      expect(matchesCidrDenylist("8.8.8.8")).toBe(false);
      expect(matchesCidrDenylist("2606:4700:4700::1111")).toBe(false);
      // A public IPv4-mapped address must still be allowed — the embedded
      // re-check denies only when the embedded IPv4 is itself private.
      expect(matchesCidrDenylist("::ffff:8.8.8.8")).toBe(false);
      expect(matchesCidrDenylist("::ffff:0808:0808")).toBe(false); // 8.8.8.8 (hex groups)
    });

    it("freezes the CIDR list", () => {
      expect(Object.isFrozen(IP_DENYLIST_CIDRS)).toBe(true);
    });
  });

  describe("shouldDenyEgress", () => {
    it("blocks invalid URLs", async () => {
      const decision = await shouldDenyEgress("not a url");
      expect(decision.denied).toBe(true);
      if (decision.denied) expect(decision.reason).toBe("invalid_url");
    });

    it("blocks denylisted hostnames when the caller injects a list", async () => {
      const hostnameDenylist = compileUserHostnameDenylist(["paypal.com"]);
      const decision = await shouldDenyEgress("https://paypal.com/checkout", {
        hostnameDenylist,
      });
      expect(decision.denied).toBe(true);
      if (decision.denied) expect(decision.reason).toBe("hostname");
    });

    it("does NOT block hostnames absent a caller-supplied list (open by default)", async () => {
      // No `hostnameDenylist` in opts → module-level empty default → not denied.
      const decision = await shouldDenyEgress("https://paypal.com/checkout");
      expect(decision.denied).toBe(false);
    });

    it("blocks IP literals inside denylist CIDR", async () => {
      const decision = await shouldDenyEgress("http://169.254.169.254/latest/meta-data/");
      expect(decision.denied).toBe(true);
      if (decision.denied) expect(decision.reason).toBe("cidr");
    });

    it("blocks IPv6 literal inside denylist CIDR (brackets stripped)", async () => {
      const decision = await shouldDenyEgress("http://[::1]/health");
      expect(decision.denied).toBe(true);
      if (decision.denied) expect(decision.reason).toBe("cidr");
    });

    it("blocks an IPv4-mapped IPv6 literal pointed at cloud metadata", async () => {
      const decision = await shouldDenyEgress(
        "http://[::ffff:169.254.169.254]/latest/meta-data/",
      );
      expect(decision.denied).toBe(true);
      if (decision.denied) expect(decision.reason).toBe("cidr");
    });

    it("blocks the IPv6 unspecified literal [::]", async () => {
      const decision = await shouldDenyEgress("http://[::]/");
      expect(decision.denied).toBe(true);
      if (decision.denied) expect(decision.reason).toBe("cidr");
    });

    it("blocks a trailing-dot FQDN against a user denylist (no evasion)", async () => {
      const hostnameDenylist = compileUserHostnameDenylist(["paypal.com"]);
      const decision = await shouldDenyEgress("https://paypal.com./checkout", {
        hostnameDenylist,
      });
      expect(decision.denied).toBe(true);
      if (decision.denied) expect(decision.reason).toBe("hostname");
    });

    it("passes a public IP literal without DNS lookup", async () => {
      const decision = await shouldDenyEgress("http://8.8.8.8/");
      expect(decision.denied).toBe(false);
    });

    it("blocks a public hostname whose DNS resolves into a denylisted CIDR", async () => {
      const decision = await shouldDenyEgress("http://internal.example.com/", {
        resolveIps: async () => ["10.0.0.1"],
      });
      expect(decision.denied).toBe(true);
      if (decision.denied) expect(decision.reason).toBe("cidr");
    });

    it("allows a public hostname whose DNS resolves outside denylisted CIDRs", async () => {
      const decision = await shouldDenyEgress("http://anthropic.com/", {
        resolveIps: async () => ["8.8.8.8"],
      });
      expect(decision.denied).toBe(false);
    });

    it("treats a DNS lookup failure as 'allow' (fail-open on the resolve leg)", async () => {
      const decision = await shouldDenyEgress("http://anthropic.com/", {
        resolveIps: async () => {
          throw new Error("ENOTFOUND");
        },
      });
      expect(decision.denied).toBe(false);
    });

    it("treats hostname denylist as primary even when DNS resolver succeeds", async () => {
      const hostnameDenylist = compileUserHostnameDenylist(["paypal.com"]);
      const decision = await shouldDenyEgress("https://www.paypal.com/", {
        resolveIps: async () => ["8.8.8.8"],
        hostnameDenylist,
      });
      expect(decision.denied).toBe(true);
      if (decision.denied) expect(decision.reason).toBe("hostname");
    });
  });
});
