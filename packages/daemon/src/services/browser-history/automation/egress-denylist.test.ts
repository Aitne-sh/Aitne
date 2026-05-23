import { describe, expect, it } from "vitest";

import {
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

  describe("HOSTNAME_DENYLIST coverage", () => {
    it("blocks payment processors", () => {
      expect(matchesHostnameDenylist("paypal.com")).toBe(true);
      expect(matchesHostnameDenylist("www.paypal.com")).toBe(true);
      expect(matchesHostnameDenylist("checkout.stripe.com")).toBe(true);
    });

    it("blocks banking + brokerage hosts", () => {
      expect(matchesHostnameDenylist("chase.com")).toBe(true);
      expect(matchesHostnameDenylist("schwab.com")).toBe(true);
      expect(matchesHostnameDenylist("bitflyer.jp")).toBe(true);
    });

    it("blocks government / identity portals", () => {
      expect(matchesHostnameDenylist("login.gov")).toBe(true);
      expect(matchesHostnameDenylist("irs.gov")).toBe(true);
      expect(matchesHostnameDenylist("portal.go.jp")).toBe(true);
    });

    it("blocks healthcare hosts", () => {
      expect(matchesHostnameDenylist("healthcare.gov")).toBe(true);
      expect(matchesHostnameDenylist("mychart.org")).toBe(true);
      // MyChart EHR portals deploy under per-tenant subdomains of
      // `mychart.org`; the `(?:.*\.)?mychart\.org$` regex catches them.
      expect(matchesHostnameDenylist("mychart.providername.org")).toBe(false);
      // (cross-eTLD+1 tenants like `mychart.cedars-sinai.org` are
      // intentionally NOT blocked at the hostname layer — they sit on
      // their own eTLD+1 and rely on the per-domain user allowlist's
      // empty default to remain unreachable until the user opts in.)
    });

    it("does not block `epicgames.com` (gaming, not Epic Systems EHR)", () => {
      // Regression test — previously the healthcare denylist carried
      // `epicgames.com` as a "placeholder" for Epic Systems patient
      // portals. `epicgames.com` is Fortnite's parent company; blocking
      // it would have broken a legitimate news-article workflow against
      // a gaming site while contributing zero healthcare coverage.
      expect(matchesHostnameDenylist("epicgames.com")).toBe(false);
      expect(matchesHostnameDenylist("www.epicgames.com")).toBe(false);
    });

    it("blocks cloud control planes", () => {
      expect(matchesHostnameDenylist("aws.amazon.com")).toBe(true);
      expect(matchesHostnameDenylist("portal.azure.com")).toBe(true);
      expect(matchesHostnameDenylist("cloudflare.com")).toBe(true);
    });

    it("blocks `localhost` family at the hostname layer (DNS-fail-open hardening)", () => {
      // The CIDR layer catches IP literals; this hostname layer is the
      // belt-and-braces defence against a DNS-fail-open path. If the
      // resolver fails (or is stubbed to a no-op in a test harness),
      // `shouldDenyEgress` short-circuits to "not denied" — without
      // these hostname entries a request to `localhost` would slip past
      // the CIDR check entirely.
      expect(matchesHostnameDenylist("localhost")).toBe(true);
      expect(matchesHostnameDenylist("LOCALHOST")).toBe(true);
      // RFC6761: browsers route `*.localhost` to loopback. We block
      // both the bare and the subdomain shapes.
      expect(matchesHostnameDenylist("foo.localhost")).toBe(true);
      // `.local` mDNS / Bonjour names typically resolve to LAN devices,
      // including the host itself (`aitne.local`, `device.local`).
      expect(matchesHostnameDenylist("aitne.local")).toBe(true);
      expect(matchesHostnameDenylist("printer.local")).toBe(true);
    });

    it("does not block ordinary domains", () => {
      expect(matchesHostnameDenylist("example.com")).toBe(false);
      expect(matchesHostnameDenylist("anthropic.com")).toBe(false);
      expect(matchesHostnameDenylist("news.ycombinator.com")).toBe(false);
    });

    it("defangs subdomain-prefix bypass attempts via eTLD+1 truncation", () => {
      // `evil.paypal.com.attacker.tld` → eTLD+1 is `attacker.tld`,
      // which is not in the denylist; the suffix regex on `paypal.com$`
      // also doesn't match. So the hostname slips by — meaning the
      // primary defence is the eTLD+1 truncation NOT matching on
      // attacker.tld. Defence-in-depth: each entry's regex carries
      // its own suffix anchor so direct subdomain attacks still hit.
      expect(matchesHostnameDenylist("evil.paypal.com.attacker.tld")).toBe(false);
      // But direct subdomain access still blocks.
      expect(matchesHostnameDenylist("login.paypal.com")).toBe(true);
    });

    it("freezes the denylist (defence-in-depth)", () => {
      expect(Object.isFrozen(HOSTNAME_DENYLIST)).toBe(true);
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

    it("allows public IPv4 and IPv6", () => {
      expect(matchesCidrDenylist("8.8.8.8")).toBe(false);
      expect(matchesCidrDenylist("2606:4700:4700::1111")).toBe(false);
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

    it("blocks denylisted hostnames", async () => {
      const decision = await shouldDenyEgress("https://paypal.com/checkout");
      expect(decision.denied).toBe(true);
      if (decision.denied) expect(decision.reason).toBe("hostname");
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
      const decision = await shouldDenyEgress("https://www.paypal.com/", {
        resolveIps: async () => ["8.8.8.8"],
      });
      expect(decision.denied).toBe(true);
      if (decision.denied) expect(decision.reason).toBe("hostname");
    });
  });
});
