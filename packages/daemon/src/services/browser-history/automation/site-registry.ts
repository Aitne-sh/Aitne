/**
 * Site registry — Phase B-2.5 of the managed-Chromium plan.
 *
 * MANAGED_CHROMIUM_IMPLEMENTATION_PLAN.md §16.2.
 *
 * A `<siteKey>` is the per-site authentication boundary for the
 * Instance A `auth` variant: every B-2.5 workflow declares a `siteKey`,
 * and the per-site profile dir
 * `<PA_DATA_DIR>/chromium-automation-auth/<siteKey>/` carries cookies
 * scoped exclusively to that site. A workflow can only see cookies for
 * its registered site — there is no shared profile dir across sites.
 *
 * The registry is enumerated, not synthesised: `Object.freeze`d at
 * module load and reviewed in code review. The LLM cannot register
 * sites at runtime. Same structural pattern as the workflow registry
 * (`workflows/registry.ts`) and the per-domain user allowlist.
 *
 * Lives in the covered set — the consistency test (frozen object,
 * stable lookup keys, signedInSelector + allowedHostPattern shape) is
 * the structural guarantee.
 */

/**
 * Per-site authentication definition. Every field is immutable post-
 * declaration; the workflow runner reads from this shape and never
 * mutates it. Adding a new site is a 1-line edit to `SITE_REGISTRY`
 * below — no runtime registration path exists.
 */
export interface SiteDefinition {
  /** Stable identifier — also the URL path segment for
   *  `/api/browser-automation/sites/:siteKey/*` and the on-disk
   *  profile dir name. Must match `/^[a-z][a-z0-9_]*$/`. */
  siteKey: string;
  /** Human-readable label rendered in the dashboard's per-site
   *  status card and DM prompts ("Connect Amazon Japan to use this
   *  workflow"). */
  displayName: string;
  /** Sign-in entry-point URL opened in the bootstrap UI Chromium
   *  window when the user clicks "Connect <site>". */
  signInUrl: string;
  /** Site root, used by the bootstrap status probe as a navigation
   *  fallback when `profileVerifyUrl` is unreachable. */
  homeUrl: string;
  /** Page the bootstrap status probe navigates to in order to
   *  observe whether the cookies in the profile dir produce a
   *  signed-in session. Distinct from `homeUrl` because some sites
   *  (Amazon, Netflix) gate the "your account" link behind a hover
   *  menu — `profileVerifyUrl` is the directly-addressable signed-in
   *  page. */
  profileVerifyUrl: string;
  /** Playwright-flavoured selector the bootstrap probe matches to
   *  confirm signed-in state. Kept as a string so the registry stays
   *  pure (no live `Page` reference); the runner translates it into
   *  the real `page.locator(...)` call. */
  signedInSelector: string;
  /** Per-site URL allowlist — workflows targeting this `siteKey`
   *  MUST declare an `allowlistRegex` whose source is a string-prefix
   *  subset of this pattern. The registry validator enforces the
   *  subset relation at module load so a mis-scoped workflow fails
   *  daemon boot rather than landing in production. */
  allowedHostPattern: RegExp;
  /** Cookies / Local Storage older than this are considered stale —
   *  the runner returns `site_not_connected` and the dashboard's
   *  per-site card prompts for a re-auth. Independent of any
   *  upstream session lifetime the site itself enforces; this is the
   *  daemon's own freshness floor. */
  sessionMaxAgeDays: number;
}

/**
 * The canonical site registry. Every authenticated workflow's
 * `siteKey` MUST resolve here. The registry is frozen at module
 * load so neither the LLM nor a stray test helper can mutate it at
 * runtime.
 *
 * The first three entries (amazon_jp, amazon_com, netflix) are the
 * B-2.5 initial set. The next four (x_com, facebook, instagram,
 * linkedin) land in BROWSER_TASK_REDESIGN_PLAN.md §8 (Phase 4) and
 * widen the open-ended-task surface to the social platforms the
 * `browser_task` sub-agent is most often asked to drive ("post X to
 * Twitter at 09:00 tomorrow"). The `generic_anon` entry from earlier
 * drafts is intentionally NOT added — its `.*` outer fence would
 * invert the safety floor (see §8 of the plan for the rejection
 * trail).
 */
export const SITE_REGISTRY: Readonly<Record<string, SiteDefinition>> = Object.freeze({
  amazon_jp: {
    siteKey: "amazon_jp",
    displayName: "Amazon Japan",
    signInUrl: "https://www.amazon.co.jp/ap/signin",
    homeUrl: "https://www.amazon.co.jp/",
    profileVerifyUrl: "https://www.amazon.co.jp/gp/your-account",
    signedInSelector: "#nav-link-accountList",
    allowedHostPattern: /^https?:\/\/(www\.)?amazon\.co\.jp\//,
    sessionMaxAgeDays: 90,
  },
  amazon_com: {
    siteKey: "amazon_com",
    displayName: "Amazon US",
    signInUrl: "https://www.amazon.com/ap/signin",
    homeUrl: "https://www.amazon.com/",
    profileVerifyUrl: "https://www.amazon.com/gp/your-account",
    signedInSelector: "#nav-link-accountList",
    allowedHostPattern: /^https?:\/\/(www\.)?amazon\.com\//,
    sessionMaxAgeDays: 90,
  },
  netflix: {
    siteKey: "netflix",
    displayName: "Netflix",
    signInUrl: "https://www.netflix.com/login",
    homeUrl: "https://www.netflix.com/",
    profileVerifyUrl: "https://www.netflix.com/YourAccount",
    signedInSelector: "[data-uia='account-menu-item']",
    allowedHostPattern: /^https?:\/\/(www\.)?netflix\.com\//,
    sessionMaxAgeDays: 60,
  },
  // BROWSER_TASK_REDESIGN_PLAN.md §8 — Phase 4 social-platform entries.
  // The `allowedHostPattern` for `x_com` covers both `x.com` and
  // `twitter.com` (the legacy domain still serves redirects + asset
  // URLs); `*.amazon-style` CDN subdomains for the social sites live in
  // `browser-task-allowlist.ts:EXTRA_ALLOWED_ETLD_HELPERS` so per-task
  // `extraAllowedHosts` requests admitting them carry the same review
  // weight as adding a new siteKey.
  x_com: {
    siteKey: "x_com",
    displayName: "X (Twitter)",
    signInUrl: "https://x.com/i/flow/login",
    homeUrl: "https://x.com/",
    profileVerifyUrl: "https://x.com/home",
    signedInSelector: "[data-testid='SideNav_AccountSwitcher_Button']",
    allowedHostPattern: /^https?:\/\/(www\.|mobile\.)?(x\.com|twitter\.com)\//,
    sessionMaxAgeDays: 60,
  },
  facebook: {
    siteKey: "facebook",
    displayName: "Facebook",
    signInUrl: "https://www.facebook.com/login/",
    homeUrl: "https://www.facebook.com/",
    profileVerifyUrl: "https://www.facebook.com/me",
    signedInSelector: "[role='banner'] [aria-label*='account']",
    allowedHostPattern: /^https?:\/\/(www\.|m\.)?facebook\.com\//,
    sessionMaxAgeDays: 90,
  },
  instagram: {
    siteKey: "instagram",
    displayName: "Instagram",
    signInUrl: "https://www.instagram.com/accounts/login/",
    homeUrl: "https://www.instagram.com/",
    profileVerifyUrl: "https://www.instagram.com/accounts/edit/",
    // The Explore link in Instagram's top global nav is only rendered
    // when signed in. The earlier draft used `[role='main']` (per
    // BROWSER_TASK_REDESIGN_PLAN.md §8's original table) but that
    // selector matches BOTH the signed-in edit form AND the signed-out
    // login page (Instagram redirects `/accounts/edit/` → `/accounts/
    // login/?next=...` when no session, and the login page also wraps
    // its form in `<main role="main">`). The bootstrap probe at
    // `site-bootstrap.ts:432` would have reported `signedIn: true`
    // after a user closed the window without authenticating — a
    // false-positive that leaves the per-site profile dir empty while
    // the dashboard says "Connected". The `/explore/` link sits in the
    // signed-in chrome only; the login page has no top nav. Selector
    // uses `*=` (substring) to tolerate query-string suffixes Instagram
    // sometimes appends (`/explore/?source=...`) and absolute-URL
    // variants. Validated by site-registry.test.ts's regression guard.
    signedInSelector: "a[href*='/explore/']",
    allowedHostPattern: /^https?:\/\/(www\.)?instagram\.com\//,
    sessionMaxAgeDays: 90,
  },
  linkedin: {
    siteKey: "linkedin",
    displayName: "LinkedIn",
    signInUrl: "https://www.linkedin.com/login",
    homeUrl: "https://www.linkedin.com/",
    profileVerifyUrl: "https://www.linkedin.com/feed/",
    signedInSelector: "[data-test-global-nav-link='me']",
    allowedHostPattern: /^https?:\/\/(www\.)?linkedin\.com\//,
    sessionMaxAgeDays: 60,
  },
});

/** Stable site-key naming rule, mirrors the workflow naming rule. */
const SITE_KEY_REGEX = /^[a-z][a-z0-9_]*$/;

/**
 * Lookup helper. Returns `null` on miss so callers can render the
 * canonical "unknown_site" / 404 path rather than throwing. Resilient
 * against prototype-pollution attempts (`__proto__`, `constructor`)
 * by gating on `hasOwnProperty`.
 */
export function getSite(siteKey: string): SiteDefinition | null {
  if (!Object.prototype.hasOwnProperty.call(SITE_REGISTRY, siteKey)) return null;
  return SITE_REGISTRY[siteKey];
}

/**
 * Enumerate every registered site. Powers the dashboard's per-site
 * card grid (`GET /api/browser-automation/sites`) and the registry
 * validator's "every workflow's siteKey resolves" check.
 */
export function listSites(): readonly SiteDefinition[] {
  return Object.values(SITE_REGISTRY);
}

/**
 * Validate every entry in the registry against the structural
 * invariants. Throws on the first violation so daemon boot fails fast
 * rather than landing a misshapen registry in production. Exported so
 * the peer test can exercise each throw branch with bogus inputs.
 *
 *   - `siteKey` matches `SITE_KEY_REGEX` and equals the map key.
 *   - `sessionMaxAgeDays` is between 1 and 365.
 *   - URL fields parse as HTTPS URLs.
 *   - `signedInSelector` is a non-empty string ≤ 200 chars.
 *   - `allowedHostPattern` covers `homeUrl` and `signInUrl`.
 */
export function validateSiteRegistry(
  entries: Readonly<Record<string, SiteDefinition>>,
): void {
  for (const [key, def] of Object.entries(entries)) {
    if (key !== def.siteKey) {
      throw new Error(
        `site registry: map key "${key}" does not match siteKey "${def.siteKey}"`,
      );
    }
    if (!SITE_KEY_REGEX.test(def.siteKey)) {
      throw new Error(
        `site registry: siteKey "${def.siteKey}" violates naming convention`,
      );
    }
    if (def.sessionMaxAgeDays < 1 || def.sessionMaxAgeDays > 365) {
      throw new Error(
        `site registry: sessionMaxAgeDays out of range for "${def.siteKey}"`,
      );
    }
    if (def.displayName.length === 0 || def.displayName.length > 120) {
      throw new Error(
        `site registry: displayName length out of range for "${def.siteKey}"`,
      );
    }
    if (def.signedInSelector.length === 0 || def.signedInSelector.length > 200) {
      throw new Error(
        `site registry: signedInSelector length out of range for "${def.siteKey}"`,
      );
    }
    for (const [field, url] of [
      ["signInUrl", def.signInUrl],
      ["homeUrl", def.homeUrl],
      ["profileVerifyUrl", def.profileVerifyUrl],
    ] as const) {
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        throw new Error(
          `site registry: ${field} for "${def.siteKey}" is not a valid URL`,
        );
      }
      if (parsed.protocol !== "https:") {
        throw new Error(
          `site registry: ${field} for "${def.siteKey}" must be https://`,
        );
      }
    }
    if (!def.allowedHostPattern.test(def.homeUrl)) {
      throw new Error(
        `site registry: allowedHostPattern for "${def.siteKey}" does not cover homeUrl`,
      );
    }
    if (!def.allowedHostPattern.test(def.signInUrl)) {
      throw new Error(
        `site registry: allowedHostPattern for "${def.siteKey}" does not cover signInUrl`,
      );
    }
  }
}

// Run the structural validation at module load — a misshapen entry
// throws here, surfacing as a daemon-boot failure. Matches the workflow
// registry's `validateWorkflowRegistry` pattern.
validateSiteRegistry(SITE_REGISTRY);

/**
 * Returns true when `child.source` is a string-prefix subset of
 * `parent.source`. The subset relation enforced for every workflow's
 * `allowlistRegex` against its site's `allowedHostPattern` (§16.4).
 *
 * Exported as a pure helper so the workflow registry's startup
 * assertion can reuse the exact same comparator the tests cover.
 *
 * The comparison is intentionally simple — pattern equivalence is
 * undecidable in general, but every shipping site's
 * `allowedHostPattern` is anchored to `^` and ends with a `/` that
 * roots the URL space. A workflow's `allowlistRegex` that starts
 * with the site pattern's source as a literal prefix is provably a
 * subset under URL strings the runner is allowed to navigate to.
 *
 * Equal patterns count as a subset (every regex is its own subset).
 */
export function isAllowlistSubsetOfSitePattern(
  child: RegExp,
  parent: RegExp,
): boolean {
  return child.source === parent.source || child.source.startsWith(parent.source);
}

/**
 * Wall-time freshness check: returns true when a connection record
 * for `site` (created at `connectedAtMs`) is still within the site's
 * `sessionMaxAgeDays` floor. The workflow runner's
 * site_not_connected gate (§16.4) and the dashboard's per-site card
 * both call this — kept pure so a single source of truth covers both.
 */
export function isSiteConnectionFresh(
  site: SiteDefinition,
  connectedAtMs: number,
  nowMs: number,
): boolean {
  if (connectedAtMs <= 0 || nowMs < connectedAtMs) return false;
  const maxAgeMs = site.sessionMaxAgeDays * 24 * 60 * 60 * 1000;
  return nowMs - connectedAtMs <= maxAgeMs;
}

/**
 * Surfaced state value for the dashboard's per-site card — single
 * source of truth so the route handler stays thin.
 */
export type SiteSurfaceState =
  | "connected"
  | "needs_reauth"
  | "not_connected"
  | "bootstrap_running";

export interface ResolveSiteSurfaceInput {
  site: SiteDefinition;
  /** Persistent connection row, if any. */
  connection: {
    connectedAt: number;
    accountLabel: string | null;
    lastWorkflowAt: number | null;
  } | null;
  /** True when a bootstrap window is currently up. */
  bootstrapRunning: boolean;
  nowMs: number;
}

export interface ResolveSiteSurfaceResult {
  state: SiteSurfaceState;
  accountLabel: string | null;
  connectedAt: number | null;
  lastWorkflowAt: number | null;
}

/**
 * Pure projection of (site definition, persistent connection,
 * bootstrap flag, now) into the dashboard-facing summary. Computing
 * this once on the daemon side keeps the dashboard's render logic
 * trivial and lets the workflow runner reuse the same predicate for
 * its `site_not_connected` gate.
 *
 * Precedence:
 *   1. `bootstrap_running` if a UI window is up — even if a stale
 *      connection row exists. The dashboard surfaces "Finishing sign-in…"
 *      and the user finalizes via the connect flow.
 *   2. `not_connected` when no connection row exists.
 *   3. `needs_reauth` when a row exists but is past
 *      `sessionMaxAgeDays`.
 *   4. `connected` otherwise.
 */
export function resolveSiteSurface(
  input: ResolveSiteSurfaceInput,
): ResolveSiteSurfaceResult {
  if (input.bootstrapRunning) {
    return {
      state: "bootstrap_running",
      accountLabel: input.connection?.accountLabel ?? null,
      connectedAt: input.connection?.connectedAt ?? null,
      lastWorkflowAt: input.connection?.lastWorkflowAt ?? null,
    };
  }
  if (!input.connection) {
    return {
      state: "not_connected",
      accountLabel: null,
      connectedAt: null,
      lastWorkflowAt: null,
    };
  }
  if (
    !isSiteConnectionFresh(
      input.site,
      input.connection.connectedAt,
      input.nowMs,
    )
  ) {
    return {
      state: "needs_reauth",
      accountLabel: input.connection.accountLabel,
      connectedAt: input.connection.connectedAt,
      lastWorkflowAt: input.connection.lastWorkflowAt,
    };
  }
  return {
    state: "connected",
    accountLabel: input.connection.accountLabel,
    connectedAt: input.connection.connectedAt,
    lastWorkflowAt: input.connection.lastWorkflowAt,
  };
}
