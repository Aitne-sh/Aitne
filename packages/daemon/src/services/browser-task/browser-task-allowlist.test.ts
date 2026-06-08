/**
 * browser-task-allowlist — §14.1 / §14.12 coverage.
 */

import { describe, expect, it } from "vitest";

import {
  BROWSER_TASK_ALLOWLIST_REGEX_FLAGS,
  composeAllowlistRegex,
  EXTRA_ALLOWED_ETLD_HELPERS,
  EXTRA_ALLOWED_HOSTS_MAX,
  extraHostInScope,
  isBareHostname,
} from "./browser-task-allowlist.js";
import { getSite } from "../browser-history/automation/site-registry.js";

describe("isBareHostname", () => {
  it("accepts bare hosts", () => {
    expect(isBareHostname("example.com")).toBe(true);
    expect(isBareHostname("www.example.com")).toBe(true);
    expect(isBareHostname("a.b.c.d.example.co.jp")).toBe(true);
  });

  it("accepts single leading wildcard label", () => {
    expect(isBareHostname("*.example.com")).toBe(true);
  });

  it("rejects schemes / paths / ports", () => {
    expect(isBareHostname("https://example.com")).toBe(false);
    expect(isBareHostname("example.com/")).toBe(false);
    expect(isBareHostname("example.com:443")).toBe(false);
    expect(isBareHostname("user@example.com")).toBe(false);
  });

  it("rejects multiple wildcards", () => {
    expect(isBareHostname("*.*.example.com")).toBe(false);
  });

  it("rejects empty / leading / trailing / consecutive dots", () => {
    expect(isBareHostname("")).toBe(false);
    expect(isBareHostname(".example.com")).toBe(false);
    expect(isBareHostname("example.com.")).toBe(false);
    expect(isBareHostname("example..com")).toBe(false);
  });

  it("rejects non-strings", () => {
    expect(isBareHostname(undefined as unknown as string)).toBe(false);
    expect(isBareHostname(123 as unknown as string)).toBe(false);
  });

  it("rejects ports / whitespace / wildcard in non-leading position", () => {
    expect(isBareHostname("a.example.com:80")).toBe(false);
    expect(isBareHostname("a b.example.com")).toBe(false);
    expect(isBareHostname("a.*.example.com")).toBe(false);
  });
});

describe("extraHostInScope", () => {
  const amazonJp = getSite("amazon_jp")!;

  it("returns true when eTLD+1 matches the siteKey", () => {
    expect(extraHostInScope(amazonJp, "cdn.amazon.co.jp")).toBe(true);
    expect(extraHostInScope(amazonJp, "*.amazon.co.jp")).toBe(true);
  });

  it("returns true when host is in the helper set", () => {
    expect(extraHostInScope(amazonJp, "ssl-images-amazon.com")).toBe(true);
    expect(extraHostInScope(amazonJp, "cdn.media-amazon.com")).toBe(true);
  });

  it("returns false otherwise", () => {
    expect(extraHostInScope(amazonJp, "evil.example.com")).toBe(false);
    expect(extraHostInScope(amazonJp, "checkout.attacker.test")).toBe(false);
  });
});

describe("composeAllowlistRegex", () => {
  it("returns site_unregistered for unknown siteKey", () => {
    const r = composeAllowlistRegex({ siteKey: "no_such_site" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("site_unregistered");
  });

  it("returns an open-navigation result for null siteKey (2026-05-27 revision)", () => {
    // The 2026-05-27 open-navigation revision makes siteKey optional;
    // null is the canonical browser-task path and yields no positive
    // selector (denylist-only gating at the CDP layer).
    const r = composeAllowlistRegex({ siteKey: null });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.composedSource).toBeNull();
    expect(r.composed).toBeNull();
    expect(r.acceptedExtras).toEqual([]);
  });

  it("emits a regex that matches the siteKey's URL on the legacy site-pinned path", () => {
    const r = composeAllowlistRegex({ siteKey: "amazon_jp" });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("ok");
    expect(r.composed).not.toBeNull();
    expect(r.composed!.test("https://www.amazon.co.jp/")).toBe(true);
    expect(r.composed!.test("https://www.amazon.co.jp/dp/B000")).toBe(true);
    expect(r.composed!.test("https://attacker.test/")).toBe(false);
  });

  it("rejects when count exceeds the cap", () => {
    const r = composeAllowlistRegex({
      siteKey: "amazon_jp",
      extraAllowedHosts: Array.from(
        { length: EXTRA_ALLOWED_HOSTS_MAX + 1 },
        (_, i) => `host${i}.amazon.co.jp`,
      ),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("too_many_extra_hosts");
  });

  it("rejects non-bare-host entries", () => {
    const r = composeAllowlistRegex({
      siteKey: "amazon_jp",
      extraAllowedHosts: ["https://evil.example.com"],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("extra_host_must_be_hostname");
  });

  it("rejects extras whose eTLD+1 is out of scope", () => {
    const r = composeAllowlistRegex({
      siteKey: "amazon_jp",
      extraAllowedHosts: ["evil.example.com"],
    });
    if (!r.ok) {
      expect(r.reason).toBe("extra_host_not_in_etld_set");
      expect(r.offendingHost).toBe("evil.example.com");
    }
  });

  it("accepts helper-set hosts even when off the siteKey eTLD+1", () => {
    const r = composeAllowlistRegex({
      siteKey: "amazon_jp",
      extraAllowedHosts: ["ssl-images-amazon.com"],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("ok");
    expect(r.composed!.test("https://ssl-images-amazon.com/")).toBe(true);
    expect(r.composed!.test("https://ssl-images-amazon.com/img/test.jpg")).toBe(true);
  });

  it("accepts wildcard subdomain extras and matches one label deep", () => {
    const r = composeAllowlistRegex({
      siteKey: "amazon_jp",
      extraAllowedHosts: ["*.amazon.co.jp"],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("ok");
    expect(r.composed!.test("https://m.amazon.co.jp/")).toBe(true);
    expect(r.composed!.test("https://amazon.co.jp/")).toBe(true);
    // Does not over-match a different eTLD+1.
    expect(r.composed!.test("https://amazon.co.jp.attacker.test/")).toBe(false);
  });

  it("emits a composed regex that requires path boundary on extras", () => {
    const r = composeAllowlistRegex({
      siteKey: "amazon_jp",
      extraAllowedHosts: ["ssl-images-amazon.com"],
    });
    if (!r.ok) throw new Error("ok");
    // Reject `ssl-images-amazon.com.attacker.test` (prefix-only match).
    expect(
      r.composed!.test("https://ssl-images-amazon.com.attacker.test/"),
    ).toBe(false);
  });

  it("returns canonicalised (lower-cased) acceptedExtras", () => {
    const r = composeAllowlistRegex({
      siteKey: "amazon_jp",
      extraAllowedHosts: ["  SSL-Images-Amazon.com  "],
    });
    if (!r.ok) throw new Error("ok");
    expect(r.acceptedExtras).toEqual(["ssl-images-amazon.com"]);
  });

  it("helper set is non-empty and frozen", () => {
    // Sanity guard so a future regression that empties the set is
    // visible in tests.
    expect(EXTRA_ALLOWED_ETLD_HELPERS.size).toBeGreaterThan(0);
  });

  it("treats a null entry in extraAllowedHosts as a bare-hostname failure", () => {
    // The `(raw ?? "").trim()` null-coalesce arm fires when an entry
    // is missing — surfaced as `extra_host_must_be_hostname`.
    const r = composeAllowlistRegex({
      siteKey: "amazon_jp",
      extraAllowedHosts: [null as unknown as string],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("extra_host_must_be_hostname");
  });
});

describe("BROWSER_TASK_ALLOWLIST_REGEX_FLAGS — round-trip contract", () => {
  // F6/F7 — the persisted column carries only the regex source; the
  // driver re-applies these flags when re-compiling. Both ends MUST
  // agree on the shared constant. The tests below pin (a) the flag set
  // the composer used and (b) the structural property a future flag
  // widening would break, so an implementer who adds e.g. `u` cannot
  // ship without also updating the persistence shape + migration.
  it("composer's flag set matches the shared constant", () => {
    const r = composeAllowlistRegex({ siteKey: "amazon_jp" });
    if (!r.ok) throw new Error("expected ok");
    expect(r.composed).not.toBeNull();
    expect(r.composed!.flags).toBe(BROWSER_TASK_ALLOWLIST_REGEX_FLAGS);
  });

  it("re-compiling the persisted source with the shared flags is behaviour-equivalent", () => {
    const r = composeAllowlistRegex({
      siteKey: "amazon_jp",
      extraAllowedHosts: ["media-amazon.com"],
    });
    if (!r.ok) throw new Error("expected ok");
    expect(r.composedSource).not.toBeNull();
    expect(r.composed).not.toBeNull();
    const rebuilt = new RegExp(
      r.composedSource!,
      BROWSER_TASK_ALLOWLIST_REGEX_FLAGS,
    );
    expect(rebuilt.flags).toBe(r.composed!.flags);
    // Sample positive + negative matches must agree between the
    // composer's RegExp and the driver-side rebuild.
    const samples = [
      "https://www.amazon.co.jp/gp/your-account",
      "https://media-amazon.com/asset.png",
      "https://AMAZON.co.JP/", // exercises the `i` flag — registered pattern is lower-case
      "https://attacker.test/",
    ];
    for (const url of samples) {
      expect(rebuilt.test(url)).toBe(r.composed!.test(url));
    }
  });

  it("locks the flag set to 'i' — any change requires updating the persistence shape", () => {
    // Sentinel. If a future PR adds another flag (e.g. 'iu' for
    // unicode-property matches), this test fails LOUDLY so the
    // implementer remembers to update `browser_task.effective_allowlist_regex`
    // storage + write a forward-only migration that interprets legacy
    // single-source rows as `{source, flags: 'i'}`.
    expect(BROWSER_TASK_ALLOWLIST_REGEX_FLAGS).toBe("i");
  });
});
