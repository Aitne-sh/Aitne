import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { applySchema } from "../../../db/schema.js";
import {
  buildPreMorningDigest,
  digestDateForNow,
  digestWindowMs,
  preMorningDigestRelativePath,
  renderPreMorningDigestMarkdown,
  sanitizeTopic,
  type DigestBoundary,
} from "./pre-morning-digest.js";

// ── Fixtures ──────────────────────────────────────────────────────────
//
// The window is the Asia/Tokyo agent-day starting 2026-05-19T04:00 JST
// (= 2026-05-18T19:00 UTC) and ending 2026-05-20T04:00 JST
// (= 2026-05-19T19:00 UTC). All visits below are placed inside or
// outside this window to exercise the partitioning logic.
//
// 2026-05-19T12:00 JST = 2026-05-19T03:00 UTC — inside window.
// 2026-05-18T12:00 JST = 2026-05-18T03:00 UTC — before window.
// 2026-05-20T12:00 JST = 2026-05-20T03:00 UTC — after window.

const TOKYO: DigestBoundary = { timezone: "Asia/Tokyo", dayBoundaryHour: 4 };
const TARGET_DATE = "2026-05-19";

function tsInWindow(hoursAfterDayStart: number): number {
  // Day starts 2026-05-18T19:00 UTC. The 12 marker keeps fixtures
  // visually anchored at JST noon while staying inside the window.
  return Date.UTC(2026, 4, 18, 19 + hoursAfterDayStart, 0, 0);
}

function tsBeforeWindow(): number {
  return Date.UTC(2026, 4, 18, 3, 0, 0); // 12:00 JST on May 18
}

function tsAfterWindow(): number {
  return Date.UTC(2026, 4, 20, 3, 0, 0); // 12:00 JST on May 20
}

function seedCluster(
  db: Database.Database,
  args: {
    slug: string;
    displayName: string;
    rootTaskId: number;
    status?: "active" | "dormant" | "muted" | "concluded";
    meaningfulVisitsTotal?: number;
    meaningfulForegroundSecTotal?: number;
    distinctMeaningfulDomains?: number;
    visitsTotal?: number;
    startedAt?: number;
    lastActivityAt?: number;
  },
) {
  db.prepare(
    `INSERT INTO browser_research_clusters (
       slug, root_task_id, display_name, started_at, last_activity_at,
       visits_total, meaningful_visits_total, meaningful_foreground_sec_total,
       distinct_meaningful_domains, status, agent_summary_revision
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
  ).run(
    args.slug,
    args.rootTaskId,
    args.displayName,
    args.startedAt ?? tsInWindow(0),
    args.lastActivityAt ?? tsInWindow(10),
    args.visitsTotal ?? 30,
    args.meaningfulVisitsTotal ?? 22,
    args.meaningfulForegroundSecTotal ?? 5400,
    args.distinctMeaningfulDomains ?? 4,
    args.status ?? "active",
  );
}

function seedVisit(
  db: Database.Database,
  args: {
    rootTaskId: number;
    ts: number;
    domain: string;
    meaningful?: 0 | 1;
    foregroundSec?: number;
    urlHash: string;
  },
) {
  db.prepare(
    `INSERT INTO browser_visits (
       ts, browser, profile, url_hash, domain, category, meaningful,
       foreground_sec, transition, is_reload, root_task_id
     ) VALUES (?, 'chrome', 'Default', ?, ?, 'research', ?, ?, 0, 0, ?)`,
  ).run(
    args.ts,
    args.urlHash,
    args.domain,
    args.meaningful ?? 1,
    args.foregroundSec ?? 600,
    args.rootTaskId,
  );
}

function seedPendingOffer(
  db: Database.Database,
  args: {
    slug: string;
    kind: "offered" | "research_assist" | "wiki_summary";
    offeredAt: number;
    expiresAt: number;
  },
) {
  db.prepare(
    `INSERT INTO browser_pending_offers (slug, kind, offered_at, expires_at)
     VALUES (?, ?, ?, ?)`,
  ).run(args.slug, args.kind, args.offeredAt, args.expiresAt);
}

function seedShoppingSession(
  db: Database.Database,
  args: {
    date: string;
    vendor: string;
    asins: string[];
    comparisonMinutes: number;
    locale: string | null;
  },
) {
  db.prepare(
    `INSERT INTO browser_shopping_sessions
       (date, vendor, asin_set, comparison_minutes, locale)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    args.date,
    args.vendor,
    JSON.stringify(args.asins),
    args.comparisonMinutes,
    args.locale,
  );
}

function seedReload(
  db: Database.Database,
  args: { date: string; urlPattern: string; count: number },
) {
  db.prepare(
    `INSERT INTO browser_reload_signals (date, url_pattern, reload_count)
     VALUES (?, ?, ?)`,
  ).run(args.date, args.urlPattern, args.count);
}

// ── Pure helpers ──────────────────────────────────────────────────────

describe("sanitizeTopic", () => {
  it("passes already-conforming labels through unchanged", () => {
    expect(sanitizeTopic("prompt-injection-defenses")).toBe(
      "prompt-injection-defenses",
    );
    expect(sanitizeTopic("Quantum Mechanics")).toBe("Quantum Mechanics");
    expect(sanitizeTopic("CaMeL/dual-LLM")).toBe("CaMeL/dual-LLM");
  });

  it("replaces disallowed characters with hyphens and trims", () => {
    expect(sanitizeTopic("prompt-injection: defenses!")).toBe(
      "prompt-injection- defenses",
    );
  });

  it("collapses unicode and control chars", () => {
    expect(sanitizeTopic("デザイン研究")).toBe("untitled");
  });

  it("returns 'untitled' for empty / whitespace input", () => {
    expect(sanitizeTopic("")).toBe("untitled");
    expect(sanitizeTopic("   ")).toBe("untitled");
  });

  it("truncates at 80 chars", () => {
    const long = "a".repeat(120);
    expect(sanitizeTopic(long).length).toBe(80);
  });
});

describe("digestWindowMs / digestDateForNow", () => {
  it("computes the UTC window for an Asia/Tokyo agent-day", () => {
    const { startMs, endMs } = digestWindowMs(TARGET_DATE, TOKYO);
    expect(new Date(startMs).toISOString()).toBe("2026-05-18T19:00:00.000Z");
    expect(new Date(endMs).toISOString()).toBe("2026-05-19T19:00:00.000Z");
  });

  it("resolves digest-time wall clock back to the prior agent-day", () => {
    // 03:00 JST on May 20 is INSIDE the agent-day that started May 19
    // at 04:00 JST — i.e. the day the digest is about to summarise.
    const at0300JstMay20 = Date.UTC(2026, 4, 19, 18, 0, 0);
    expect(digestDateForNow(TOKYO, at0300JstMay20)).toBe(TARGET_DATE);
  });
});

describe("preMorningDigestRelativePath", () => {
  it("returns the canonical context-relative path", () => {
    expect(preMorningDigestRelativePath("2026-05-19")).toBe(
      "browser/yesterday-2026-05-19.md",
    );
  });
});

// ── Builder integration ──────────────────────────────────────────────

describe("buildPreMorningDigest", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applySchema(db);
  });

  afterEach(() => {
    db.close();
  });

  it("returns an empty digest when no data is present", () => {
    const digest = buildPreMorningDigest({
      db,
      date: TARGET_DATE,
      boundary: TOKYO,
      options: { nowMs: tsInWindow(20) },
    });
    expect(digest.date).toBe(TARGET_DATE);
    expect(digest.source).toBe("deterministic");
    expect(digest.clusters).toEqual([]);
    expect(digest.shopping).toEqual([]);
    expect(digest.reloads).toEqual([]);
    expect(digest.pendingOffers).toEqual([]);
    expect(digest.newThresholdsCount).toBe(0);
  });

  it("includes clusters with meaningful visits inside the window", () => {
    seedCluster(db, {
      slug: "prompt-injection-defenses",
      displayName: "prompt-injection-defenses",
      rootTaskId: 1,
    });
    seedVisit(db, {
      rootTaskId: 1,
      ts: tsInWindow(4),
      domain: "arxiv.org",
      urlHash: "h-1",
    });
    seedVisit(db, {
      rootTaskId: 1,
      ts: tsInWindow(8),
      domain: "simonwillison.net",
      urlHash: "h-2",
      foregroundSec: 1200,
    });
    seedVisit(db, {
      rootTaskId: 1,
      ts: tsBeforeWindow(),
      domain: "arxiv.org",
      urlHash: "h-0",
    });

    const digest = buildPreMorningDigest({
      db,
      date: TARGET_DATE,
      boundary: TOKYO,
      options: { nowMs: tsInWindow(20) },
    });

    expect(digest.clusters).toHaveLength(1);
    const cluster = digest.clusters[0];
    expect(cluster.slug).toBe("prompt-injection-defenses");
    expect(cluster.meaningfulVisitsInWindow).toBe(2);
    expect(cluster.meaningfulForegroundSecInWindow).toBe(1800);
    // arxiv.org appeared before window so it's not "new"; simonwillison.net
    // is new in window.
    expect(cluster.newDomainsInWindow).toEqual(["simonwillison.net"]);
    expect(cluster.topDomains).toEqual(["arxiv.org", "simonwillison.net"]);
    // No pending offer fired in window → qualifiedOvernight=false.
    expect(cluster.qualifiedOvernight).toBe(false);
  });

  it("ignores visits outside the window", () => {
    seedCluster(db, {
      slug: "noise",
      displayName: "noise",
      rootTaskId: 2,
    });
    seedVisit(db, {
      rootTaskId: 2,
      ts: tsBeforeWindow(),
      domain: "arxiv.org",
      urlHash: "n-1",
    });
    seedVisit(db, {
      rootTaskId: 2,
      ts: tsAfterWindow(),
      domain: "arxiv.org",
      urlHash: "n-2",
    });

    const digest = buildPreMorningDigest({
      db,
      date: TARGET_DATE,
      boundary: TOKYO,
      options: { nowMs: tsAfterWindow() + 86_400_000 },
    });
    // Cluster has visits but none in window → not surfaced.
    expect(digest.clusters).toHaveLength(0);
  });

  it("excludes muted and concluded clusters", () => {
    seedCluster(db, {
      slug: "muted-topic",
      displayName: "muted-topic",
      rootTaskId: 3,
      status: "muted",
    });
    seedCluster(db, {
      slug: "concluded-topic",
      displayName: "concluded-topic",
      rootTaskId: 4,
      status: "concluded",
    });
    seedVisit(db, { rootTaskId: 3, ts: tsInWindow(2), domain: "x.com", urlHash: "m-1" });
    seedVisit(db, { rootTaskId: 4, ts: tsInWindow(3), domain: "y.com", urlHash: "c-1" });

    const digest = buildPreMorningDigest({
      db,
      date: TARGET_DATE,
      boundary: TOKYO,
      options: { nowMs: tsInWindow(20) },
    });
    expect(digest.clusters).toEqual([]);
  });

  it("marks qualifiedOvernight when a pending offer fired in window", () => {
    seedCluster(db, {
      slug: "fresh-topic",
      displayName: "fresh-topic",
      rootTaskId: 5,
    });
    seedVisit(db, {
      rootTaskId: 5,
      ts: tsInWindow(2),
      domain: "anthropic.com",
      urlHash: "f-1",
    });
    seedPendingOffer(db, {
      slug: "fresh-topic",
      kind: "offered",
      offeredAt: tsInWindow(3),
      expiresAt: tsInWindow(3) + 14 * 86_400_000,
    });

    const digest = buildPreMorningDigest({
      db,
      date: TARGET_DATE,
      boundary: TOKYO,
      options: { nowMs: tsInWindow(20) },
    });
    expect(digest.clusters).toHaveLength(1);
    expect(digest.clusters[0].qualifiedOvernight).toBe(true);
    expect(digest.newThresholdsCount).toBe(1);
  });

  it("ignores offers fired outside the window for qualifiedOvernight", () => {
    seedCluster(db, {
      slug: "old-topic",
      displayName: "old-topic",
      rootTaskId: 6,
    });
    seedVisit(db, {
      rootTaskId: 6,
      ts: tsInWindow(2),
      domain: "a.com",
      urlHash: "o-1",
    });
    seedPendingOffer(db, {
      slug: "old-topic",
      kind: "offered",
      offeredAt: tsBeforeWindow(),
      expiresAt: tsAfterWindow() + 86_400_000,
    });

    const digest = buildPreMorningDigest({
      db,
      date: TARGET_DATE,
      boundary: TOKYO,
      options: { nowMs: tsInWindow(20) },
    });
    expect(digest.clusters[0].qualifiedOvernight).toBe(false);
    expect(digest.newThresholdsCount).toBe(0);
    // Open offer surfaces in pendingOffers since it has not expired.
    expect(digest.pendingOffers).toHaveLength(1);
    expect(digest.pendingOffers[0].slug).toBe("old-topic");
  });

  it("collects shopping sessions for the date", () => {
    seedShoppingSession(db, {
      date: TARGET_DATE,
      vendor: "amazon",
      asins: ["B0000000A1", "B0000000A2", "B0000000A3"],
      comparisonMinutes: 12,
      locale: "co.jp",
    });
    // Different date — must not appear.
    seedShoppingSession(db, {
      date: "2026-05-18",
      vendor: "amazon",
      asins: ["B0000000B1", "B0000000B2", "B0000000B3"],
      comparisonMinutes: 5,
      locale: null,
    });
    // Non-amazon vendor — schema rejects, builder skips.
    seedShoppingSession(db, {
      date: TARGET_DATE,
      vendor: "rakuten",
      asins: ["X1", "X2", "X3"],
      comparisonMinutes: 4,
      locale: null,
    });

    const digest = buildPreMorningDigest({
      db,
      date: TARGET_DATE,
      boundary: TOKYO,
      options: { nowMs: tsInWindow(20) },
    });
    expect(digest.shopping).toHaveLength(1);
    expect(digest.shopping[0]).toEqual({
      vendor: "amazon",
      asinCount: 3,
      comparisonMinutes: 12,
      locale: "co.jp",
    });
  });

  it("drops shopping rows with zero ASINs (corrupt JSON path)", () => {
    // Manually insert a row whose asin_set is malformed JSON.
    db.prepare(
      `INSERT INTO browser_shopping_sessions
         (date, vendor, asin_set, comparison_minutes, locale)
       VALUES (?, 'amazon', '{not json', 1, NULL)`,
    ).run(TARGET_DATE);

    const digest = buildPreMorningDigest({
      db,
      date: TARGET_DATE,
      boundary: TOKYO,
      options: { nowMs: tsInWindow(20) },
    });
    expect(digest.shopping).toEqual([]);
  });

  it("collects reload signals for the date", () => {
    seedReload(db, {
      date: TARGET_DATE,
      urlPattern: "claude.ai/usage",
      count: 8,
    });
    seedReload(db, {
      date: TARGET_DATE,
      urlPattern: "twitter.com/home",
      count: 12,
    });
    seedReload(db, {
      date: "2026-05-18",
      urlPattern: "other.com/dash",
      count: 3,
    });

    const digest = buildPreMorningDigest({
      db,
      date: TARGET_DATE,
      boundary: TOKYO,
      options: { nowMs: tsInWindow(20) },
    });
    expect(digest.reloads.map((entry) => entry.urlPattern)).toEqual([
      "twitter.com/home",
      "claude.ai/usage",
    ]);
  });

  it("filters expired pending offers", () => {
    seedCluster(db, {
      slug: "old-offer",
      displayName: "old-offer",
      rootTaskId: 7,
    });
    seedVisit(db, {
      rootTaskId: 7,
      ts: tsInWindow(2),
      domain: "z.com",
      urlHash: "e-1",
    });
    const now = tsInWindow(20);
    seedPendingOffer(db, {
      slug: "old-offer",
      kind: "offered",
      offeredAt: tsBeforeWindow(),
      expiresAt: now - 1000,
    });

    const digest = buildPreMorningDigest({
      db,
      date: TARGET_DATE,
      boundary: TOKYO,
      options: { nowMs: now },
    });
    expect(digest.pendingOffers).toEqual([]);
  });

  it("sanitises display names that drift from the topic regex", () => {
    seedCluster(db, {
      slug: "renamed-topic",
      displayName: "User Named: With Punctuation!",
      rootTaskId: 8,
    });
    seedVisit(db, {
      rootTaskId: 8,
      ts: tsInWindow(2),
      domain: "a.com",
      urlHash: "r-1",
    });

    const digest = buildPreMorningDigest({
      db,
      date: TARGET_DATE,
      boundary: TOKYO,
      options: { nowMs: tsInWindow(20) },
    });
    // Punctuation collapsed to single hyphens — regex now passes.
    expect(digest.clusters[0].displayName).toMatch(/^[a-z0-9 /-]+$/i);
  });

  it("breaks topDomains ties by domain name (sort comparator second branch)", () => {
    seedCluster(db, {
      slug: "tiebreak",
      displayName: "tiebreak",
      rootTaskId: 10,
    });
    // Two domains with identical visit counts → sort tiebreaker fires.
    seedVisit(db, { rootTaskId: 10, ts: tsInWindow(1), domain: "beta.com", urlHash: "tb-1" });
    seedVisit(db, { rootTaskId: 10, ts: tsInWindow(2), domain: "alpha.com", urlHash: "tb-2" });
    const digest = buildPreMorningDigest({
      db,
      date: TARGET_DATE,
      boundary: TOKYO,
      options: { nowMs: tsInWindow(20) },
    });
    expect(digest.clusters[0].topDomains).toEqual(["alpha.com", "beta.com"]);
  });

  it("never returns raw URLs or titles in the digest payload", () => {
    // Seed visits that carry a (real-world-shaped) title + search_query;
    // the digest builder must not surface either in the output.
    seedCluster(db, {
      slug: "redaction-check",
      displayName: "redaction-check",
      rootTaskId: 9,
    });
    db.prepare(
      `INSERT INTO browser_visits
         (ts, browser, profile, url_hash, domain, category, meaningful,
          foreground_sec, transition, is_reload, root_task_id,
          title, search_query)
       VALUES (?, 'chrome', 'Default', 'redact-1', 'arxiv.org', 'research',
               1, 600, 0, 0, 9,
               'Sensitive paper title 2402.06196',
               'super secret search')`,
    ).run(tsInWindow(2));

    const digest = buildPreMorningDigest({
      db,
      date: TARGET_DATE,
      boundary: TOKYO,
      options: { nowMs: tsInWindow(20) },
    });
    const serialized = JSON.stringify(digest);
    expect(serialized).not.toContain("Sensitive paper title");
    expect(serialized).not.toContain("super secret search");
    expect(serialized).not.toContain("2402.06196");
  });
});

// ── Markdown rendering ────────────────────────────────────────────────

describe("renderPreMorningDigestMarkdown", () => {
  it("renders an empty-day digest with all sections present", () => {
    const md = renderPreMorningDigestMarkdown({
      date: TARGET_DATE,
      generatedAt: "2026-05-20T03:00:00.000Z",
      source: "deterministic",
      clusters: [],
      shopping: [],
      reloads: [],
      pendingOffers: [],
      newThresholdsCount: 0,
    });
    expect(md).toContain(`date: ${TARGET_DATE}`);
    expect(md).toContain("## Yesterday's meaningful research");
    expect(md).toContain("## Shopping");
    expect(md).toContain("## Reload patterns (informational, not surfaced)");
    expect(md).toContain("## Pending offers awaiting response");
    expect(md).toContain("(no meaningful research clusters touched in window)");
    expect(md).toContain("(no shopping comparison sessions)");
    expect(md).toContain("(no notable reload activity)");
    expect(md).toContain("(none)");
  });

  it("renders shopping without a trailing locale when locale is null", () => {
    const md = renderPreMorningDigestMarkdown({
      date: TARGET_DATE,
      generatedAt: "2026-05-20T03:00:00.000Z",
      source: "deterministic",
      clusters: [],
      shopping: [
        {
          vendor: "amazon",
          asinCount: 3,
          comparisonMinutes: 7,
          locale: null,
        },
      ],
      reloads: [],
      pendingOffers: [],
      newThresholdsCount: 0,
    });
    expect(md).toContain("amazon: monitor comparison (3 ASINs, 7min)");
    expect(md).not.toMatch(/7min\s+\./);
  });

  it("renders the wiki_summary kind with its accept hint", () => {
    const md = renderPreMorningDigestMarkdown({
      date: TARGET_DATE,
      generatedAt: "2026-05-20T03:00:00.000Z",
      source: "deterministic",
      clusters: [],
      shopping: [],
      reloads: [],
      pendingOffers: [
        {
          slug: "wiki-topic",
          displayName: "wiki-topic",
          kind: "wiki_summary",
          offeredAt: Date.UTC(2026, 4, 19, 12, 0, 0),
          expiresAt: Date.UTC(2026, 5, 2, 12, 0, 0),
        },
      ],
      newThresholdsCount: 0,
    });
    expect(md).toContain("`!research wiki wiki-topic` to accept");
  });

  it("renders the research_assist kind with its accept hint", () => {
    const md = renderPreMorningDigestMarkdown({
      date: TARGET_DATE,
      generatedAt: "2026-05-20T03:00:00.000Z",
      source: "deterministic",
      clusters: [],
      shopping: [],
      reloads: [],
      pendingOffers: [
        {
          slug: "research-topic",
          displayName: "research-topic",
          kind: "research_assist",
          offeredAt: Date.UTC(2026, 4, 19, 12, 0, 0),
          expiresAt: Date.UTC(2026, 5, 2, 12, 0, 0),
        },
      ],
      newThresholdsCount: 0,
    });
    expect(md).toContain("`!research accept research-topic` to accept");
  });

  it("renders cluster + offer + shopping sections with concrete data", () => {
    const md = renderPreMorningDigestMarkdown({
      date: TARGET_DATE,
      generatedAt: "2026-05-20T03:00:00.000Z",
      source: "deterministic",
      clusters: [
        {
          slug: "prompt-injection-defenses",
          displayName: "prompt-injection-defenses",
          status: "active",
          daysActive: 3,
          meaningfulVisitsInWindow: 6,
          meaningfulForegroundSecInWindow: 1800,
          newDomainsInWindow: ["simonwillison.net"],
          topDomains: ["arxiv.org", "anthropic.com"],
          qualifiedOvernight: true,
        },
      ],
      shopping: [
        {
          vendor: "amazon",
          asinCount: 3,
          comparisonMinutes: 12,
          locale: "co.jp",
        },
      ],
      reloads: [
        { urlPattern: "claude.ai/usage", reloadCount: 8 },
      ],
      pendingOffers: [
        {
          slug: "prompt-injection-defenses",
          displayName: "prompt-injection-defenses",
          kind: "offered",
          offeredAt: Date.UTC(2026, 4, 19, 12, 0, 0),
          expiresAt: Date.UTC(2026, 5, 2, 12, 0, 0),
        },
      ],
      newThresholdsCount: 1,
    });
    expect(md).toContain("### prompt-injection-defenses (3 days, status=active)");
    expect(md).toContain("yesterday: 6 visits, 30 min foreground");
    expect(md).toContain("new domains in window: simonwillison.net");
    expect(md).toContain("top domains: arxiv.org, anthropic.com");
    expect(md).toContain("threshold crossed overnight");
    expect(md).toContain("amazon: monitor comparison (3 ASINs, 12min .co.jp)");
    expect(md).toContain("claude.ai/usage: 8");
    expect(md).toContain(
      "prompt-injection-defenses [offered] (offered 2026-05-19)",
    );
  });
});
