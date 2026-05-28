import { describe, expect, it } from "vitest";

import {
  getSite,
  isAllowlistSubsetOfSitePattern,
  isSiteConnectionFresh,
  listSites,
  resolveSiteSurface,
  SITE_REGISTRY,
  validateSiteRegistry,
  type SiteDefinition,
} from "./site-registry.js";

const baseDef: SiteDefinition = {
  siteKey: "fake_site",
  displayName: "Fake Site",
  signInUrl: "https://example.com/signin",
  homeUrl: "https://example.com/",
  profileVerifyUrl: "https://example.com/account",
  signedInSelector: "#account-link",
  allowedHostPattern: /^https?:\/\/(www\.)?example\.com\//,
  sessionMaxAgeDays: 30,
};

describe("site-registry", () => {
  it("freezes the registry object so the LLM cannot mutate it at runtime", () => {
    expect(Object.isFrozen(SITE_REGISTRY)).toBe(true);
  });

  it("exposes the initial B-2.5 sites plus the Phase-4 social additions", () => {
    // BROWSER_TASK_REDESIGN_PLAN.md §8 widens the registry from the
    // B-2.5 initial three (amazon_jp, amazon_com, netflix) to seven
    // by adding x_com, facebook, instagram, linkedin. Pin the full
    // expected set so an accidental delete or duplicate surfaces here.
    const keys = listSites()
      .map((d) => d.siteKey)
      .sort();
    expect(keys).toEqual([
      "amazon_com",
      "amazon_jp",
      "facebook",
      "instagram",
      "linkedin",
      "netflix",
      "x_com",
    ]);
  });

  it("getSite returns the right def by key", () => {
    const def = getSite("amazon_jp");
    expect(def?.displayName).toBe("Amazon Japan");
  });

  it("x_com allowedHostPattern admits both x.com and twitter.com (incl. mobile.)", () => {
    // The Phase-4 registry entry intentionally widens to the legacy
    // twitter.com host because the live site still serves redirects
    // and asset URLs through it. Pin the positive + negative shape so
    // a tightening of the pattern surfaces here.
    const def = getSite("x_com");
    expect(def).not.toBeNull();
    const pattern = def!.allowedHostPattern;
    expect(pattern.test("https://x.com/")).toBe(true);
    expect(pattern.test("https://x.com/home")).toBe(true);
    expect(pattern.test("https://www.x.com/")).toBe(true);
    expect(pattern.test("https://mobile.x.com/")).toBe(true);
    expect(pattern.test("https://twitter.com/")).toBe(true);
    expect(pattern.test("https://www.twitter.com/")).toBe(true);
    expect(pattern.test("https://mobile.twitter.com/")).toBe(true);
    // Negative: a non-x host that prefix-collides on the eTLD label
    // must NOT match.
    expect(pattern.test("https://x.com.attacker.test/")).toBe(false);
    expect(pattern.test("https://notx.com/")).toBe(false);
    expect(pattern.test("https://twitter.com.attacker.test/")).toBe(false);
  });

  it("facebook allowedHostPattern admits both www. and m. (mobile) subdomains", () => {
    const def = getSite("facebook");
    expect(def).not.toBeNull();
    const pattern = def!.allowedHostPattern;
    expect(pattern.test("https://www.facebook.com/")).toBe(true);
    expect(pattern.test("https://www.facebook.com/me")).toBe(true);
    expect(pattern.test("https://m.facebook.com/")).toBe(true);
    expect(pattern.test("https://facebook.com/")).toBe(true);
    // Negative: prefix-collision rejection.
    expect(pattern.test("https://facebook.com.attacker.test/")).toBe(false);
    expect(pattern.test("https://notfacebook.com/")).toBe(false);
  });

  it("instagram allowedHostPattern admits only the canonical host", () => {
    const def = getSite("instagram");
    expect(def).not.toBeNull();
    const pattern = def!.allowedHostPattern;
    expect(pattern.test("https://www.instagram.com/")).toBe(true);
    expect(pattern.test("https://www.instagram.com/accounts/edit/")).toBe(true);
    expect(pattern.test("https://instagram.com/")).toBe(true);
    expect(pattern.test("https://instagram.com.attacker.test/")).toBe(false);
  });

  it("linkedin allowedHostPattern admits only the canonical host", () => {
    const def = getSite("linkedin");
    expect(def).not.toBeNull();
    const pattern = def!.allowedHostPattern;
    expect(pattern.test("https://www.linkedin.com/")).toBe(true);
    expect(pattern.test("https://www.linkedin.com/feed/")).toBe(true);
    expect(pattern.test("https://linkedin.com/")).toBe(true);
    expect(pattern.test("https://linkedin.com.attacker.test/")).toBe(false);
  });

  it("Phase-4 entries carry sane displayName + selector + sessionMaxAge", () => {
    // Defence-in-depth: validateSiteRegistry already covers the
    // structural invariants, but pin the human-readable fields too so
    // a future refactor that swaps the displayName for a key string
    // surfaces here.
    const xCom = getSite("x_com")!;
    expect(xCom.displayName).toBe("X (Twitter)");
    expect(xCom.signedInSelector).toContain("data-testid");
    expect(xCom.sessionMaxAgeDays).toBeGreaterThanOrEqual(30);

    const fb = getSite("facebook")!;
    expect(fb.displayName).toBe("Facebook");
    expect(fb.signedInSelector).toContain("aria-label");

    const ig = getSite("instagram")!;
    expect(ig.displayName).toBe("Instagram");
    // Regression guard: the original BROWSER_TASK_REDESIGN_PLAN.md §8
    // table specified `[role='main']` for Instagram, but that matches
    // BOTH the signed-in `/accounts/edit/` page AND the signed-out
    // `/accounts/login/...` redirect target (Instagram's login page
    // also wraps its form in `<main role="main">`). The bootstrap
    // probe would have returned a false-positive `signedIn: true`
    // after a user closed the window without authenticating. The fix
    // pins the selector to the Explore link in the signed-in top nav,
    // which the login page does not render. Keep both assertions so a
    // future revert lights up here.
    expect(ig.signedInSelector).not.toBe("[role='main']");
    expect(ig.signedInSelector).toContain("/explore/");

    const li = getSite("linkedin")!;
    expect(li.displayName).toBe("LinkedIn");
    expect(li.signedInSelector).toContain("data-test-global-nav-link");
  });

  it("getSite returns null for unknown keys (no exception)", () => {
    expect(getSite("not_a_site")).toBeNull();
    // Prototype-pollution attempts are defended against.
    expect(getSite("__proto__")).toBeNull();
    expect(getSite("constructor")).toBeNull();
    expect(getSite("hasOwnProperty")).toBeNull();
  });

  it("every shipping entry has consistent siteKey + allowedHostPattern coverage", () => {
    for (const def of listSites()) {
      expect(def.siteKey).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(def.signInUrl.startsWith("https://")).toBe(true);
      expect(def.homeUrl.startsWith("https://")).toBe(true);
      expect(def.profileVerifyUrl.startsWith("https://")).toBe(true);
      expect(def.allowedHostPattern.test(def.homeUrl)).toBe(true);
      expect(def.allowedHostPattern.test(def.signInUrl)).toBe(true);
      expect(def.allowedHostPattern.test(def.profileVerifyUrl)).toBe(true);
      expect(def.sessionMaxAgeDays).toBeGreaterThanOrEqual(1);
      expect(def.sessionMaxAgeDays).toBeLessThanOrEqual(365);
    }
  });
});

describe("validateSiteRegistry (failure branches)", () => {
  it("accepts a valid entry", () => {
    expect(() =>
      validateSiteRegistry({ fake_site: baseDef }),
    ).not.toThrow();
  });

  it("throws when the map key does not match siteKey", () => {
    expect(() =>
      validateSiteRegistry({ wrong_key: baseDef }),
    ).toThrowError(/does not match siteKey/);
  });

  it("throws on a siteKey that violates the naming convention", () => {
    const bogus: SiteDefinition = { ...baseDef, siteKey: "1invalid" };
    expect(() =>
      validateSiteRegistry({ "1invalid": bogus }),
    ).toThrowError(/violates naming convention/);
  });

  it("throws on sessionMaxAgeDays out of range (zero)", () => {
    const bogus: SiteDefinition = { ...baseDef, sessionMaxAgeDays: 0 };
    expect(() =>
      validateSiteRegistry({ fake_site: bogus }),
    ).toThrowError(/sessionMaxAgeDays out of range/);
  });

  it("throws on sessionMaxAgeDays out of range (too high)", () => {
    const bogus: SiteDefinition = { ...baseDef, sessionMaxAgeDays: 9999 };
    expect(() =>
      validateSiteRegistry({ fake_site: bogus }),
    ).toThrowError(/sessionMaxAgeDays out of range/);
  });

  it("throws on empty displayName", () => {
    const bogus: SiteDefinition = { ...baseDef, displayName: "" };
    expect(() =>
      validateSiteRegistry({ fake_site: bogus }),
    ).toThrowError(/displayName length out of range/);
  });

  it("throws on too-long displayName", () => {
    const bogus: SiteDefinition = {
      ...baseDef,
      displayName: "x".repeat(200),
    };
    expect(() =>
      validateSiteRegistry({ fake_site: bogus }),
    ).toThrowError(/displayName length out of range/);
  });

  it("throws on empty signedInSelector", () => {
    const bogus: SiteDefinition = { ...baseDef, signedInSelector: "" };
    expect(() =>
      validateSiteRegistry({ fake_site: bogus }),
    ).toThrowError(/signedInSelector length out of range/);
  });

  it("throws on too-long signedInSelector", () => {
    const bogus: SiteDefinition = {
      ...baseDef,
      signedInSelector: "x".repeat(300),
    };
    expect(() =>
      validateSiteRegistry({ fake_site: bogus }),
    ).toThrowError(/signedInSelector length out of range/);
  });

  it("throws when signInUrl is not a valid URL", () => {
    const bogus: SiteDefinition = { ...baseDef, signInUrl: "not a url" };
    expect(() =>
      validateSiteRegistry({ fake_site: bogus }),
    ).toThrowError(/signInUrl for "fake_site" is not a valid URL/);
  });

  it("throws when homeUrl is not a valid URL", () => {
    const bogus: SiteDefinition = { ...baseDef, homeUrl: "" };
    expect(() =>
      validateSiteRegistry({ fake_site: bogus }),
    ).toThrowError(/homeUrl for "fake_site" is not a valid URL/);
  });

  it("throws when profileVerifyUrl is not a valid URL", () => {
    const bogus: SiteDefinition = { ...baseDef, profileVerifyUrl: "://bad" };
    expect(() =>
      validateSiteRegistry({ fake_site: bogus }),
    ).toThrowError(/profileVerifyUrl for "fake_site" is not a valid URL/);
  });

  it("throws when an URL uses an http (insecure) scheme", () => {
    const bogus: SiteDefinition = {
      ...baseDef,
      signInUrl: "http://example.com/signin",
    };
    expect(() =>
      validateSiteRegistry({ fake_site: bogus }),
    ).toThrowError(/must be https/);
  });

  it("throws when allowedHostPattern does not cover homeUrl", () => {
    const bogus: SiteDefinition = {
      ...baseDef,
      allowedHostPattern: /^https?:\/\/different\.com\//,
    };
    expect(() =>
      validateSiteRegistry({ fake_site: bogus }),
    ).toThrowError(/does not cover homeUrl/);
  });

  it("throws when allowedHostPattern covers homeUrl but not signInUrl", () => {
    const bogus: SiteDefinition = {
      ...baseDef,
      homeUrl: "https://example.com/",
      signInUrl: "https://other.com/signin",
      profileVerifyUrl: "https://example.com/account",
    };
    expect(() =>
      validateSiteRegistry({ fake_site: bogus }),
    ).toThrowError(/does not cover signInUrl/);
  });
});

describe("isAllowlistSubsetOfSitePattern", () => {
  const parent = /^https?:\/\/(www\.)?amazon\.co\.jp\//;

  it("accepts equal patterns", () => {
    expect(isAllowlistSubsetOfSitePattern(parent, parent)).toBe(true);
  });

  it("accepts a string-prefix subset", () => {
    const child = /^https?:\/\/(www\.)?amazon\.co\.jp\/your-orders/;
    expect(isAllowlistSubsetOfSitePattern(child, parent)).toBe(true);
  });

  it("rejects an unrelated pattern", () => {
    const child = /^https?:\/\/(www\.)?example\.com\//;
    expect(isAllowlistSubsetOfSitePattern(child, parent)).toBe(false);
  });

  it("rejects a broader pattern (parent vs. broader child)", () => {
    const broader = /^https?:\/\//;
    expect(isAllowlistSubsetOfSitePattern(broader, parent)).toBe(false);
  });
});

describe("isSiteConnectionFresh", () => {
  const site = baseDef; // sessionMaxAgeDays = 30

  it("accepts a connection within the freshness window", () => {
    const connectedAt = 1_700_000_000_000;
    const now = connectedAt + 5 * 24 * 60 * 60 * 1000; // 5 days later
    expect(isSiteConnectionFresh(site, connectedAt, now)).toBe(true);
  });

  it("accepts a connection at exactly the maxAge boundary", () => {
    const connectedAt = 1_700_000_000_000;
    const now = connectedAt + 30 * 24 * 60 * 60 * 1000;
    expect(isSiteConnectionFresh(site, connectedAt, now)).toBe(true);
  });

  it("rejects a connection older than sessionMaxAgeDays", () => {
    const connectedAt = 1_700_000_000_000;
    const now = connectedAt + 31 * 24 * 60 * 60 * 1000;
    expect(isSiteConnectionFresh(site, connectedAt, now)).toBe(false);
  });

  it("rejects a connection with non-positive connectedAt (corrupt row)", () => {
    expect(isSiteConnectionFresh(site, 0, 1_700_000_000_000)).toBe(false);
    expect(isSiteConnectionFresh(site, -1, 1_700_000_000_000)).toBe(false);
  });

  it("rejects a connection whose connectedAt is in the future (clock skew)", () => {
    expect(isSiteConnectionFresh(site, 1_700_000_000_001, 1_700_000_000_000)).toBe(
      false,
    );
  });
});

describe("resolveSiteSurface", () => {
  const site = baseDef; // sessionMaxAgeDays = 30
  const now = 1_700_000_000_000;

  it("reports bootstrap_running when a bootstrap window is up", () => {
    const r = resolveSiteSurface({
      site,
      connection: null,
      bootstrapRunning: true,
      nowMs: now,
    });
    expect(r.state).toBe("bootstrap_running");
  });

  it("reports bootstrap_running even when a connection row already exists", () => {
    const r = resolveSiteSurface({
      site,
      connection: {
        connectedAt: now - 1_000_000,
        accountLabel: "Alice",
        lastWorkflowAt: null,
      },
      bootstrapRunning: true,
      nowMs: now,
    });
    expect(r.state).toBe("bootstrap_running");
    expect(r.accountLabel).toBe("Alice");
  });

  it("reports not_connected when no connection row exists", () => {
    const r = resolveSiteSurface({
      site,
      connection: null,
      bootstrapRunning: false,
      nowMs: now,
    });
    expect(r.state).toBe("not_connected");
    expect(r.connectedAt).toBeNull();
  });

  it("reports needs_reauth when the connection is older than sessionMaxAgeDays", () => {
    const r = resolveSiteSurface({
      site,
      connection: {
        connectedAt: now - 31 * 24 * 60 * 60 * 1000,
        accountLabel: "Alice",
        lastWorkflowAt: null,
      },
      bootstrapRunning: false,
      nowMs: now,
    });
    expect(r.state).toBe("needs_reauth");
    expect(r.accountLabel).toBe("Alice");
  });

  it("reports connected for a fresh connection", () => {
    const r = resolveSiteSurface({
      site,
      connection: {
        connectedAt: now - 5 * 24 * 60 * 60 * 1000,
        accountLabel: "Alice",
        lastWorkflowAt: now - 1000,
      },
      bootstrapRunning: false,
      nowMs: now,
    });
    expect(r.state).toBe("connected");
    expect(r.lastWorkflowAt).toBe(now - 1000);
  });
});
