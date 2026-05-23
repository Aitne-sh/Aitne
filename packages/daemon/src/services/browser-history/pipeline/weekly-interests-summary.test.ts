import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { applySchema } from "../../../db/schema.js";
import {
  buildWeeklyInterestsSummary,
  pickTopClusters,
  weekStartFromDate,
  weekWindowMs,
  type AgentDayBoundary,
  type ClusterSnapshot,
  type ProjectKeywords,
} from "./weekly-interests-summary.js";

// ── Fixtures ──────────────────────────────────────────────────────────
//
// Window: agent-day-aligned (04:00 boundary) week starting
// 2026-05-18 (Monday) in Asia/Tokyo. That's 2026-05-17T19:00Z through
// 2026-05-24T19:00Z. Visits placed inside / before / after that range
// exercise the partitioning and dormancy diff.

const TOKYO: AgentDayBoundary = { timezone: "Asia/Tokyo", dayBoundaryHour: 4 };
const UTC: AgentDayBoundary = { timezone: "UTC", dayBoundaryHour: 0 };
const WEEK_START = "2026-05-18";

function tsInWindow(dayOffset: number, hour = 12): number {
  // Day starts 2026-05-17T19:00 UTC (= 2026-05-18T04:00 JST).
  return Date.UTC(2026, 4, 17, 19 + dayOffset * 24 + (hour - 4), 0, 0);
}

function tsInPriorWindow(dayOffset: number, hour = 12): number {
  return Date.UTC(2026, 4, 10, 19 + dayOffset * 24 + (hour - 4), 0, 0);
}

function tsAfterWindow(): number {
  return Date.UTC(2026, 4, 25, 3, 0, 0);
}

function seedCluster(
  db: Database.Database,
  args: {
    slug: string;
    displayName: string;
    rootTaskId: number;
    status?: "active" | "dormant" | "muted" | "concluded";
    lastActivityAt: number;
    startedAt?: number;
    researchOfferAcceptedAt?: number | null;
    wikiSummaryWrittenAt?: number | null;
  },
) {
  db.prepare(
    `INSERT INTO browser_research_clusters (
       slug, root_task_id, display_name, started_at, last_activity_at,
       visits_total, meaningful_visits_total, meaningful_foreground_sec_total,
       distinct_meaningful_domains, status,
       research_offer_accepted_at, wiki_summary_written_at,
       agent_summary_revision
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
  ).run(
    args.slug,
    args.rootTaskId,
    args.displayName,
    args.startedAt ?? args.lastActivityAt - 86_400_000,
    args.lastActivityAt,
    30,
    22,
    5400,
    4,
    args.status ?? "active",
    args.researchOfferAcceptedAt ?? null,
    args.wikiSummaryWrittenAt ?? null,
  );
}

let visitCounter = 0;
function seedVisit(
  db: Database.Database,
  args: {
    rootTaskId: number;
    ts: number;
    domain: string;
    foregroundSec?: number;
    meaningful?: 0 | 1;
  },
) {
  visitCounter += 1;
  db.prepare(
    `INSERT INTO browser_visits (
       ts, browser, profile, url_hash, domain, category, meaningful,
       foreground_sec, transition, is_reload, root_task_id
     ) VALUES (?, 'chrome', 'Default', ?, ?, 'research', ?, ?, 0, 0, ?)`,
  ).run(
    args.ts,
    `hash-${visitCounter}`,
    args.domain,
    args.meaningful ?? 1,
    args.foregroundSec ?? 600,
    args.rootTaskId,
  );
}

function seedPendingOffer(
  db: Database.Database,
  args: { slug: string; expiresAt: number; offeredAt?: number },
) {
  db.prepare(
    `INSERT INTO browser_pending_offers (slug, kind, offered_at, expires_at)
     VALUES (?, 'offered', ?, ?)`,
  ).run(args.slug, args.offeredAt ?? args.expiresAt - 1000, args.expiresAt);
}

describe("weekWindowMs", () => {
  it("anchors the Tokyo agent-day window at 04:00 local", () => {
    const { startMs, endMs } = weekWindowMs(WEEK_START, TOKYO);
    // 2026-05-18T04:00 JST = 2026-05-17T19:00 UTC.
    expect(startMs).toBe(Date.UTC(2026, 4, 17, 19, 0, 0));
    expect(endMs - startMs).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it("anchors the UTC window at 00:00", () => {
    const { startMs, endMs } = weekWindowMs(WEEK_START, UTC);
    expect(startMs).toBe(Date.UTC(2026, 4, 18, 0, 0, 0));
    expect(endMs - startMs).toBe(7 * 24 * 60 * 60 * 1000);
  });
});

describe("weekStartFromDate", () => {
  it("returns the agent-day label for a given timestamp", () => {
    expect(weekStartFromDate(Date.UTC(2026, 4, 18, 12, 0, 0), TOKYO)).toBe(
      "2026-05-18",
    );
  });

  it("defaults to UTC/00:00 boundary when no boundary supplied", () => {
    expect(weekStartFromDate(Date.UTC(2026, 4, 18, 12, 0, 0))).toBe(
      "2026-05-18",
    );
  });
});

describe("pickTopClusters", () => {
  function snapshot(
    overrides: Partial<ClusterSnapshot> & { slug: string },
  ): ClusterSnapshot {
    return {
      slug: overrides.slug,
      displayName: overrides.displayName ?? overrides.slug,
      daysActive: overrides.daysActive ?? 1,
      meaningfulVisits: overrides.meaningfulVisits ?? 1,
      meaningfulForegroundSec: overrides.meaningfulForegroundSec ?? 0,
      distinctMeaningfulDomains: overrides.distinctMeaningfulDomains ?? 0,
      topDomains: overrides.topDomains ?? [],
      status: overrides.status ?? "active",
      statusChange: overrides.statusChange ?? "active_continued",
      clusterJournalPath: overrides.clusterJournalPath ?? `research/${overrides.slug}.md`,
      hasOpenOffer: overrides.hasOpenOffer ?? false,
      hasAcceptedResearch: overrides.hasAcceptedResearch ?? false,
      hasWikiSummary: overrides.hasWikiSummary ?? false,
      lastActivityDate: overrides.lastActivityDate ?? "2026-05-18",
      lastActivityMs: overrides.lastActivityMs ?? 0,
    };
  }

  it("sorts by foregroundSec desc, then domains desc, then slug asc", () => {
    const result = pickTopClusters(
      [
        snapshot({ slug: "c", meaningfulForegroundSec: 100, distinctMeaningfulDomains: 1 }),
        snapshot({ slug: "a", meaningfulForegroundSec: 200, distinctMeaningfulDomains: 2 }),
        snapshot({ slug: "b", meaningfulForegroundSec: 200, distinctMeaningfulDomains: 3 }),
        snapshot({ slug: "d", meaningfulForegroundSec: 200, distinctMeaningfulDomains: 2 }),
      ],
      10,
    );
    expect(result.map((c) => c.slug)).toEqual(["b", "a", "d", "c"]);
  });

  it("caps the output at maxClusters", () => {
    const inputs: ClusterSnapshot[] = [];
    for (let i = 0; i < 30; i++) {
      inputs.push(snapshot({ slug: `c-${i}`, meaningfulForegroundSec: i * 10 }));
    }
    const result = pickTopClusters(inputs, 5);
    expect(result.length).toBe(5);
    expect(result[0].slug).toBe("c-29");
    expect(result[4].slug).toBe("c-25");
  });

  it("clamps negative maxClusters to 0", () => {
    expect(pickTopClusters([snapshot({ slug: "x" })], -1)).toEqual([]);
  });
});

describe("buildWeeklyInterestsSummary", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    applySchema(db);
    visitCounter = 0;
  });

  afterEach(() => {
    db.close();
  });

  it("returns an empty result on an empty DB", () => {
    const summary = buildWeeklyInterestsSummary(db, WEEK_START, {
      boundary: TOKYO,
      nowMs: tsInWindow(6, 23),
    });
    expect(summary.clusters).toEqual([]);
    expect(summary.dormantSinceLastWeek).toEqual([]);
    expect(summary.projectMatches).toEqual([]);
    expect(summary.weekStart).toBe(WEEK_START);
    expect(summary.weekEnd).toBe("2026-05-24");
    expect(summary.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("includes a single active cluster with visits inside the window", () => {
    seedCluster(db, {
      slug: "prompt-injection-defenses",
      displayName: "Prompt-injection defenses",
      rootTaskId: 1,
      lastActivityAt: tsInWindow(3),
    });
    seedVisit(db, {
      rootTaskId: 1,
      ts: tsInWindow(1, 10),
      domain: "anthropic.com",
      foregroundSec: 900,
    });
    seedVisit(db, {
      rootTaskId: 1,
      ts: tsInWindow(2, 11),
      domain: "simonwillison.net",
      foregroundSec: 600,
    });
    seedVisit(db, {
      rootTaskId: 1,
      ts: tsInWindow(3, 9),
      domain: "anthropic.com",
      foregroundSec: 300,
    });

    const summary = buildWeeklyInterestsSummary(db, WEEK_START, {
      boundary: TOKYO,
      nowMs: tsInWindow(6, 23),
    });

    expect(summary.clusters).toHaveLength(1);
    const c = summary.clusters[0];
    expect(c.slug).toBe("prompt-injection-defenses");
    expect(c.daysActive).toBe(3);
    expect(c.meaningfulVisits).toBe(3);
    expect(c.meaningfulForegroundSec).toBe(1800);
    expect(c.distinctMeaningfulDomains).toBe(2);
    expect(c.topDomains).toEqual(["anthropic.com", "simonwillison.net"]);
    expect(c.statusChange).toBe("new");
    expect(c.clusterJournalPath).toBe(
      "research/prompt-injection-defenses.md",
    );
  });

  it("excludes visits outside the window", () => {
    seedCluster(db, {
      slug: "rust-borrow-checker",
      displayName: "Rust borrow checker",
      rootTaskId: 2,
      lastActivityAt: tsInWindow(0),
    });
    seedVisit(db, {
      rootTaskId: 2,
      ts: tsInPriorWindow(2),
      domain: "rust-lang.org",
      foregroundSec: 9999,
    });
    seedVisit(db, {
      rootTaskId: 2,
      ts: tsAfterWindow(),
      domain: "rust-lang.org",
      foregroundSec: 9999,
    });
    seedVisit(db, {
      rootTaskId: 2,
      ts: tsInWindow(0, 10),
      domain: "rust-lang.org",
      foregroundSec: 100,
    });

    const summary = buildWeeklyInterestsSummary(db, WEEK_START, {
      boundary: TOKYO,
      nowMs: tsInWindow(6, 23),
    });
    expect(summary.clusters).toHaveLength(1);
    expect(summary.clusters[0].meaningfulForegroundSec).toBe(100);
  });

  it("ignores non-meaningful visits", () => {
    seedCluster(db, {
      slug: "skim-only",
      displayName: "Skim only",
      rootTaskId: 3,
      lastActivityAt: tsInWindow(2),
    });
    seedVisit(db, {
      rootTaskId: 3,
      ts: tsInWindow(1),
      domain: "news.ycombinator.com",
      foregroundSec: 5,
      meaningful: 0,
    });
    const summary = buildWeeklyInterestsSummary(db, WEEK_START, {
      boundary: TOKYO,
      nowMs: tsInWindow(6, 23),
    });
    expect(summary.clusters).toEqual([]);
  });

  it("skips clusters whose status is not 'active'", () => {
    seedCluster(db, {
      slug: "muted-topic",
      displayName: "Muted topic",
      rootTaskId: 4,
      status: "muted",
      lastActivityAt: tsInWindow(2),
    });
    seedVisit(db, {
      rootTaskId: 4,
      ts: tsInWindow(2),
      domain: "example.com",
    });
    const summary = buildWeeklyInterestsSummary(db, WEEK_START, {
      boundary: TOKYO,
      nowMs: tsInWindow(6, 23),
    });
    expect(summary.clusters).toEqual([]);
    expect(summary.dormantSinceLastWeek).toEqual([]);
  });

  it("ranks clusters by foreground_sec desc and caps at maxClusters", () => {
    for (let i = 1; i <= 25; i++) {
      seedCluster(db, {
        slug: `c-${i.toString().padStart(2, "0")}`,
        displayName: `Cluster ${i}`,
        rootTaskId: 100 + i,
        lastActivityAt: tsInWindow(2),
      });
      seedVisit(db, {
        rootTaskId: 100 + i,
        ts: tsInWindow(1),
        domain: `c${i}.example.com`,
        foregroundSec: i * 10,
      });
    }
    const summary = buildWeeklyInterestsSummary(db, WEEK_START, {
      boundary: TOKYO,
      nowMs: tsInWindow(6, 23),
    });
    expect(summary.clusters).toHaveLength(20);
    expect(summary.clusters[0].slug).toBe("c-25");
    expect(summary.clusters[0].meaningfulForegroundSec).toBe(250);
  });

  it("flips statusChange to 'active_continued' when prior week had visits", () => {
    seedCluster(db, {
      slug: "continuing",
      displayName: "Continuing topic",
      rootTaskId: 5,
      lastActivityAt: tsInWindow(2),
    });
    seedVisit(db, {
      rootTaskId: 5,
      ts: tsInPriorWindow(3),
      domain: "a.example.com",
    });
    seedVisit(db, {
      rootTaskId: 5,
      ts: tsInWindow(2),
      domain: "a.example.com",
    });
    const summary = buildWeeklyInterestsSummary(db, WEEK_START, {
      boundary: TOKYO,
      nowMs: tsInWindow(6, 23),
    });
    expect(summary.clusters[0].statusChange).toBe("active_continued");
  });

  it("marks clusters as new when no prior-window visits", () => {
    seedCluster(db, {
      slug: "fresh-topic",
      displayName: "Fresh topic",
      rootTaskId: 6,
      lastActivityAt: tsInWindow(2),
    });
    seedVisit(db, {
      rootTaskId: 6,
      ts: tsInWindow(2),
      domain: "fresh.example.com",
    });
    const summary = buildWeeklyInterestsSummary(db, WEEK_START, {
      boundary: TOKYO,
      nowMs: tsInWindow(6, 23),
    });
    expect(summary.clusters[0].statusChange).toBe("new");
  });

  it("surfaces dormant clusters that had prior-week visits but none this week", () => {
    seedCluster(db, {
      slug: "lattice-crypto",
      displayName: "Lattice cryptography",
      rootTaskId: 7,
      lastActivityAt: tsInPriorWindow(4),
    });
    seedVisit(db, {
      rootTaskId: 7,
      ts: tsInPriorWindow(2),
      domain: "eprint.iacr.org",
    });
    seedVisit(db, {
      rootTaskId: 7,
      ts: tsInPriorWindow(4),
      domain: "eprint.iacr.org",
    });
    const summary = buildWeeklyInterestsSummary(db, WEEK_START, {
      boundary: TOKYO,
      nowMs: tsInWindow(6, 23),
    });
    expect(summary.clusters).toEqual([]);
    expect(summary.dormantSinceLastWeek).toHaveLength(1);
    expect(summary.dormantSinceLastWeek[0].slug).toBe("lattice-crypto");
  });

  it("labels dormant lastActivity with the 04:00 agent-day boundary", () => {
    // JST 02:30 belongs to the *previous* agent-day under a 04:00
    // boundary — using calendar-only `localDateStr` would label this
    // visit with the wrong date. The fix in step 4 routes through
    // `getAgentDayDateStr`.
    //
    // 2026-05-15 02:30 JST = 2026-05-14 17:30 UTC.
    const earlyMorningJst = Date.UTC(2026, 4, 14, 17, 30);
    seedCluster(db, {
      slug: "boundary-test",
      displayName: "Boundary test",
      rootTaskId: 60,
      lastActivityAt: earlyMorningJst,
    });
    seedVisit(db, {
      rootTaskId: 60,
      ts: earlyMorningJst,
      domain: "ex.example.com",
    });
    const summary = buildWeeklyInterestsSummary(db, WEEK_START, {
      boundary: TOKYO,
      nowMs: tsInWindow(6, 23),
    });
    expect(summary.dormantSinceLastWeek).toHaveLength(1);
    // JST 02:30 on May 15 is still agent-day 2026-05-14 under the
    // 04:00 boundary.
    expect(summary.dormantSinceLastWeek[0].lastActivity).toBe("2026-05-14");
  });

  it("does not surface clusters with no prior-week or current-week visits as dormant", () => {
    seedCluster(db, {
      slug: "ancient",
      displayName: "Ancient",
      rootTaskId: 8,
      lastActivityAt: tsInPriorWindow(0),
    });
    // No visits inside either window
    seedVisit(db, {
      rootTaskId: 8,
      ts: Date.UTC(2026, 3, 1),
      domain: "x.example.com",
    });
    const summary = buildWeeklyInterestsSummary(db, WEEK_START, {
      boundary: TOKYO,
      nowMs: tsInWindow(6, 23),
    });
    expect(summary.dormantSinceLastWeek).toEqual([]);
  });

  it("does not surface dormant 'muted' or 'concluded' clusters", () => {
    seedCluster(db, {
      slug: "muted-cluster",
      displayName: "Muted cluster",
      rootTaskId: 9,
      status: "muted",
      lastActivityAt: tsInPriorWindow(2),
    });
    seedVisit(db, {
      rootTaskId: 9,
      ts: tsInPriorWindow(2),
      domain: "ex.example.com",
    });

    seedCluster(db, {
      slug: "concluded-cluster",
      displayName: "Concluded cluster",
      rootTaskId: 10,
      status: "concluded",
      lastActivityAt: tsInPriorWindow(3),
    });
    seedVisit(db, {
      rootTaskId: 10,
      ts: tsInPriorWindow(3),
      domain: "ex2.example.com",
    });
    const summary = buildWeeklyInterestsSummary(db, WEEK_START, {
      boundary: TOKYO,
      nowMs: tsInWindow(6, 23),
    });
    expect(summary.dormantSinceLastWeek).toEqual([]);
  });

  it("includes pre-flipped-to-dormant clusters with prior-week activity", () => {
    seedCluster(db, {
      slug: "freshly-dormant",
      displayName: "Freshly dormant",
      rootTaskId: 11,
      status: "dormant",
      lastActivityAt: tsInPriorWindow(4),
    });
    seedVisit(db, {
      rootTaskId: 11,
      ts: tsInPriorWindow(4),
      domain: "ex.example.com",
    });
    const summary = buildWeeklyInterestsSummary(db, WEEK_START, {
      boundary: TOKYO,
      nowMs: tsInWindow(6, 23),
    });
    expect(summary.dormantSinceLastWeek).toHaveLength(1);
    expect(summary.dormantSinceLastWeek[0].slug).toBe("freshly-dormant");
  });

  it("sorts dormant entries by most-recent activity first", () => {
    seedCluster(db, {
      slug: "older",
      displayName: "Older",
      rootTaskId: 12,
      lastActivityAt: tsInPriorWindow(0),
    });
    seedVisit(db, {
      rootTaskId: 12,
      ts: tsInPriorWindow(0),
      domain: "older.example.com",
    });
    seedCluster(db, {
      slug: "newer",
      displayName: "Newer",
      rootTaskId: 13,
      lastActivityAt: tsInPriorWindow(5),
    });
    seedVisit(db, {
      rootTaskId: 13,
      ts: tsInPriorWindow(5),
      domain: "newer.example.com",
    });
    const summary = buildWeeklyInterestsSummary(db, WEEK_START, {
      boundary: TOKYO,
      nowMs: tsInWindow(6, 23),
    });
    expect(summary.dormantSinceLastWeek.map((d) => d.slug)).toEqual([
      "newer",
      "older",
    ]);
  });

  it("propagates research-offer and wiki-summary flags", () => {
    seedCluster(db, {
      slug: "engaged",
      displayName: "Engaged",
      rootTaskId: 14,
      lastActivityAt: tsInWindow(2),
      researchOfferAcceptedAt: tsInWindow(1),
      wikiSummaryWrittenAt: tsInWindow(1),
    });
    seedVisit(db, {
      rootTaskId: 14,
      ts: tsInWindow(2),
      domain: "ex.example.com",
    });
    const summary = buildWeeklyInterestsSummary(db, WEEK_START, {
      boundary: TOKYO,
      nowMs: tsInWindow(6, 23),
    });
    expect(summary.clusters[0].hasAcceptedResearch).toBe(true);
    expect(summary.clusters[0].hasWikiSummary).toBe(true);
  });

  it("flags clusters with an open pending offer", () => {
    seedCluster(db, {
      slug: "pending",
      displayName: "Pending",
      rootTaskId: 15,
      lastActivityAt: tsInWindow(2),
    });
    seedVisit(db, {
      rootTaskId: 15,
      ts: tsInWindow(2),
      domain: "ex.example.com",
    });
    seedPendingOffer(db, {
      slug: "pending",
      expiresAt: tsInWindow(6, 23) + 60 * 60 * 1000,
    });

    const summary = buildWeeklyInterestsSummary(db, WEEK_START, {
      boundary: TOKYO,
      nowMs: tsInWindow(6, 23),
    });
    expect(summary.clusters[0].hasOpenOffer).toBe(true);
  });

  it("ignores expired pending offers", () => {
    seedCluster(db, {
      slug: "expired",
      displayName: "Expired",
      rootTaskId: 16,
      lastActivityAt: tsInWindow(2),
    });
    seedVisit(db, {
      rootTaskId: 16,
      ts: tsInWindow(2),
      domain: "ex.example.com",
    });
    seedPendingOffer(db, {
      slug: "expired",
      expiresAt: tsInWindow(6, 23) - 60 * 60 * 1000,
    });

    const summary = buildWeeklyInterestsSummary(db, WEEK_START, {
      boundary: TOKYO,
      nowMs: tsInWindow(6, 23),
    });
    expect(summary.clusters[0].hasOpenOffer).toBe(false);
  });

  it("emits projectMatches when projectKeywords supplied (filename match)", () => {
    seedCluster(db, {
      slug: "aitne-stuff",
      displayName: "Aitne agent core",
      rootTaskId: 17,
      lastActivityAt: tsInWindow(2),
    });
    seedVisit(db, {
      rootTaskId: 17,
      ts: tsInWindow(2),
      domain: "ex.example.com",
    });
    const projectKeywords: ProjectKeywords[] = [
      {
        projectSlug: "aitne",
        projectPath: "/context/projects/aitne.md",
        keywords: new Set(["aitne"]),
        source: "filename",
      },
    ];
    const summary = buildWeeklyInterestsSummary(db, WEEK_START, {
      boundary: TOKYO,
      nowMs: tsInWindow(6, 23),
      projectKeywords,
    });
    expect(summary.projectMatches).toHaveLength(1);
    expect(summary.projectMatches[0].clusters[0].reason).toBe("filename_match");
  });

  it("emits projectMatches when Jaccard threshold reached", () => {
    seedCluster(db, {
      slug: "rust-async-runtime",
      displayName: "Rust async runtime",
      rootTaskId: 18,
      lastActivityAt: tsInWindow(2),
    });
    seedVisit(db, {
      rootTaskId: 18,
      ts: tsInWindow(2),
      domain: "tokio.rs",
      foregroundSec: 200,
    });
    seedVisit(db, {
      rootTaskId: 18,
      ts: tsInWindow(2, 14),
      domain: "rust-lang.org",
      foregroundSec: 100,
    });
    const projectKeywords: ProjectKeywords[] = [
      {
        projectSlug: "async-server",
        projectPath: "/context/projects/async-server.md",
        keywords: new Set(["async", "runtime", "tokio"]),
        source: "explicit",
      },
    ];
    const summary = buildWeeklyInterestsSummary(db, WEEK_START, {
      boundary: TOKYO,
      nowMs: tsInWindow(6, 23),
      projectKeywords,
    });
    expect(summary.projectMatches).toHaveLength(1);
    expect(summary.projectMatches[0].clusters[0].reason).toBe("jaccard");
  });

  it("drops projects when Jaccard overlap meets count but ratio under threshold", () => {
    // Cluster with many tokens — small ratio when sharing only 2.
    seedCluster(db, {
      slug: "broad-topic",
      displayName: "alpha beta gamma delta epsilon zeta eta theta",
      rootTaskId: 41,
      lastActivityAt: tsInWindow(2),
    });
    seedVisit(db, {
      rootTaskId: 41,
      ts: tsInWindow(2),
      domain: "iota.example.com",
      foregroundSec: 100,
    });
    seedVisit(db, {
      rootTaskId: 41,
      ts: tsInWindow(2, 14),
      domain: "kappa.example.com",
      foregroundSec: 100,
    });
    seedVisit(db, {
      rootTaskId: 41,
      ts: tsInWindow(2, 16),
      domain: "lambda.example.com",
      foregroundSec: 100,
    });
    seedVisit(db, {
      rootTaskId: 41,
      ts: tsInWindow(2, 18),
      domain: "mu.example.com",
      foregroundSec: 100,
    });
    const projectKeywords: ProjectKeywords[] = [
      {
        // Use a slug nowhere in the displayName so the filename-match
        // shortcut doesn't fire — the only path to a match is Jaccard.
        projectSlug: "qrstuvwx",
        projectPath: "/qrstuvwx.md",
        // share only 2 tokens (alpha, beta) with cluster, but project also has
        // 10 unrelated tokens, blowing up the Jaccard denominator.
        keywords: new Set([
          "alpha",
          "beta",
          "k1",
          "k2",
          "k3",
          "k4",
          "k5",
          "k6",
          "k7",
          "k8",
          "k9",
          "k10",
        ]),
        source: "explicit",
      },
    ];
    const summary = buildWeeklyInterestsSummary(db, WEEK_START, {
      boundary: TOKYO,
      nowMs: tsInWindow(6, 23),
      projectKeywords,
    });
    expect(summary.projectMatches).toEqual([]);
  });

  it("excludes dormant-status clusters that have visits inside the current window", () => {
    // The active query already filters non-'active' rows, so this row
    // does NOT appear in `clusters`. The dormant scan also needs to
    // skip it — a dormant cluster with current-window visits is in a
    // transient state and would mislead the user as "dormant" when
    // activity has actually resumed.
    seedCluster(db, {
      slug: "revived",
      displayName: "Revived",
      rootTaskId: 42,
      status: "dormant",
      lastActivityAt: tsInWindow(3),
    });
    seedVisit(db, {
      rootTaskId: 42,
      ts: tsInPriorWindow(2),
      domain: "revived.example.com",
    });
    seedVisit(db, {
      rootTaskId: 42,
      ts: tsInWindow(3),
      domain: "revived.example.com",
    });
    const summary = buildWeeklyInterestsSummary(db, WEEK_START, {
      boundary: TOKYO,
      nowMs: tsInWindow(6, 23),
    });
    expect(summary.clusters).toEqual([]);
    expect(summary.dormantSinceLastWeek).toEqual([]);
  });

  it("drops projects with no matched clusters", () => {
    seedCluster(db, {
      slug: "irrelevant",
      displayName: "Irrelevant topic",
      rootTaskId: 19,
      lastActivityAt: tsInWindow(2),
    });
    seedVisit(db, {
      rootTaskId: 19,
      ts: tsInWindow(2),
      domain: "ex.example.com",
    });
    const projectKeywords: ProjectKeywords[] = [
      {
        projectSlug: "unrelated",
        projectPath: "/context/projects/unrelated.md",
        keywords: new Set(["alpha", "beta", "gamma"]),
        source: "frontmatter",
      },
    ];
    const summary = buildWeeklyInterestsSummary(db, WEEK_START, {
      boundary: TOKYO,
      nowMs: tsInWindow(6, 23),
      projectKeywords,
    });
    expect(summary.projectMatches).toEqual([]);
  });

  it("caps project matches at maxProjectClusters and dedupes by cluster slug", () => {
    for (let i = 0; i < 8; i++) {
      const slug = `aitne-topic-${i}`;
      seedCluster(db, {
        slug,
        displayName: `Aitne topic ${i}`,
        rootTaskId: 200 + i,
        lastActivityAt: tsInWindow(2),
      });
      seedVisit(db, {
        rootTaskId: 200 + i,
        ts: tsInWindow(2),
        domain: "ex.example.com",
        foregroundSec: 100 + i,
      });
    }
    const projectKeywords: ProjectKeywords[] = [
      {
        projectSlug: "aitne",
        projectPath: "/context/projects/aitne.md",
        keywords: new Set(["aitne"]),
        source: "filename",
      },
    ];
    const summary = buildWeeklyInterestsSummary(db, WEEK_START, {
      boundary: TOKYO,
      nowMs: tsInWindow(6, 23),
      projectKeywords,
      maxProjectClusters: 3,
    });
    expect(summary.projectMatches[0].clusters).toHaveLength(3);
  });

  it("returns projectMatches sorted by projectSlug asc", () => {
    seedCluster(db, {
      slug: "x-topic",
      displayName: "x topic alpha beta",
      rootTaskId: 30,
      lastActivityAt: tsInWindow(2),
    });
    seedVisit(db, {
      rootTaskId: 30,
      ts: tsInWindow(2),
      domain: "alpha.example.com",
    });
    seedVisit(db, {
      rootTaskId: 30,
      ts: tsInWindow(2, 14),
      domain: "beta.example.com",
    });
    const projectKeywords: ProjectKeywords[] = [
      {
        projectSlug: "zebra",
        projectPath: "/p/zebra.md",
        keywords: new Set(["alpha", "beta", "topic"]),
        source: "explicit",
      },
      {
        projectSlug: "aardvark",
        projectPath: "/p/aardvark.md",
        keywords: new Set(["alpha", "beta", "topic"]),
        source: "explicit",
      },
    ];
    const summary = buildWeeklyInterestsSummary(db, WEEK_START, {
      boundary: TOKYO,
      nowMs: tsInWindow(6, 23),
      projectKeywords,
    });
    expect(summary.projectMatches.map((p) => p.projectSlug)).toEqual([
      "aardvark",
      "zebra",
    ]);
  });

  it("returns an empty projectMatches list when projectKeywords omitted", () => {
    seedCluster(db, {
      slug: "x",
      displayName: "x",
      rootTaskId: 50,
      lastActivityAt: tsInWindow(2),
    });
    seedVisit(db, {
      rootTaskId: 50,
      ts: tsInWindow(2),
      domain: "ex.example.com",
    });
    const summary = buildWeeklyInterestsSummary(db, WEEK_START, {
      boundary: TOKYO,
      nowMs: tsInWindow(6, 23),
    });
    expect(summary.projectMatches).toEqual([]);
  });

  it("uses defaults (UTC, max 20) when options omitted", () => {
    for (let i = 1; i <= 22; i++) {
      seedCluster(db, {
        slug: `d-${i}`,
        displayName: `D ${i}`,
        rootTaskId: 300 + i,
        lastActivityAt: Date.UTC(2026, 4, 18, 12, 0, 0),
      });
      seedVisit(db, {
        rootTaskId: 300 + i,
        ts: Date.UTC(2026, 4, 18, 12, 0, 0),
        domain: `d${i}.example.com`,
        foregroundSec: i * 5,
      });
    }
    const summary = buildWeeklyInterestsSummary(db, WEEK_START);
    expect(summary.clusters).toHaveLength(20);
  });

  it("uses now=Date.now() default when nowMs omitted", () => {
    // We're not asserting any window content here; just exercising the
    // default branch so coverage doesn't fail on the `nowMs ?? Date.now()`
    // ternary.
    expect(() => buildWeeklyInterestsSummary(db, WEEK_START)).not.toThrow();
  });

  it("ranking is deterministic across calls (idempotent)", () => {
    for (let i = 0; i < 3; i++) {
      seedCluster(db, {
        slug: `idem-${i}`,
        displayName: `idem ${i}`,
        rootTaskId: 400 + i,
        lastActivityAt: tsInWindow(2),
      });
      seedVisit(db, {
        rootTaskId: 400 + i,
        ts: tsInWindow(2),
        domain: "ex.example.com",
        foregroundSec: 500,
      });
    }
    const a = buildWeeklyInterestsSummary(db, WEEK_START, {
      boundary: TOKYO,
      nowMs: tsInWindow(6, 23),
    });
    const b = buildWeeklyInterestsSummary(db, WEEK_START, {
      boundary: TOKYO,
      nowMs: tsInWindow(6, 23),
    });
    expect(a.clusters.map((c) => c.slug)).toEqual(
      b.clusters.map((c) => c.slug),
    );
  });

  it("rejects a cluster that has only window visits with foreground 0 sec", () => {
    seedCluster(db, {
      slug: "zero-fg",
      displayName: "Zero foreground",
      rootTaskId: 500,
      lastActivityAt: tsInWindow(2),
    });
    seedVisit(db, {
      rootTaskId: 500,
      ts: tsInWindow(2),
      domain: "ex.example.com",
      foregroundSec: 0,
    });
    const summary = buildWeeklyInterestsSummary(db, WEEK_START, {
      boundary: TOKYO,
      nowMs: tsInWindow(6, 23),
    });
    expect(summary.clusters).toHaveLength(1);
    expect(summary.clusters[0].meaningfulForegroundSec).toBe(0);
  });

  it("handles null foreground_sec in visit rows as 0", () => {
    seedCluster(db, {
      slug: "null-fg",
      displayName: "Null foreground",
      rootTaskId: 501,
      lastActivityAt: tsInWindow(2),
    });
    db.prepare(
      `INSERT INTO browser_visits (
         ts, browser, profile, url_hash, domain, category, meaningful,
         foreground_sec, transition, is_reload, root_task_id
       ) VALUES (?, 'chrome', 'Default', ?, ?, 'research', 1, NULL, 0, 0, ?)`,
    ).run(tsInWindow(2), "null-hash", "ex.example.com", 501);
    const summary = buildWeeklyInterestsSummary(db, WEEK_START, {
      boundary: TOKYO,
      nowMs: tsInWindow(6, 23),
    });
    expect(summary.clusters[0].meaningfulForegroundSec).toBe(0);
  });
});
