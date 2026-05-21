import { describe, expect, it } from "vitest";
import {
  evaluateOfferTriggers,
  DEFAULT_OFFER_THRESHOLDS,
  type ClusterEngagementSnapshot,
} from "./offer-triggers.js";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const NOW = 1_700_000_000_000;

function snapshot(
  overrides: Partial<ClusterEngagementSnapshot> = {},
): ClusterEngagementSnapshot {
  // Default base = a qualifying cluster on day 3 with no offers yet.
  return {
    slug: "quantum-mechanics",
    displayName: "Quantum Mechanics",
    status: "active",
    startedAt: NOW - 3 * DAY_MS,
    lastActivityAt: NOW - HOUR_MS,
    meaningfulVisitsTotal: 22,
    meaningfulForegroundSecTotal: 4000,
    distinctMeaningfulDomains: 3,
    distinctMeaningfulDays: 3,
    longReadVisits: 0,
    longReadDays: 0,
    recentForegroundSec: 4000,
    recentDomains: new Set(["arxiv.org", "wikipedia.org", "simonwillison.net"]),
    priorDomains: new Set<string>(),
    topDomains: ["arxiv.org", "wikipedia.org", "simonwillison.net"],
    lastDmAt: null,
    lastResearchOfferAt: null,
    lastWikiOfferAt: null,
    researchOfferAcceptedAt: null,
    wikiSummaryWrittenAt: null,
    ...overrides,
  };
}

// Seventh-pass (BROWSER_HISTORY_INTEGRATION_PLAN §5.F1) collapses the
// five trigger kinds into a single `engagement_candidate` with signal
// flags in the OfferContext payload. The `routine.research_offer_dm`
// agent composes the natural-language DM from these signals. The
// tests below pin which signal flags fire under each condition; the
// qualification + re-fire gates are unchanged from earlier passes.

describe("evaluateOfferTriggers — engagement_candidate shape", () => {
  it("returns a single `engagement_candidate` kind regardless of which signal triggered", () => {
    const result = evaluateOfferTriggers(snapshot(), NOW);
    expect(result?.kind).toBe("engagement_candidate");
    expect(result?.pendingOfferKind).toBe("offered");
  });

  it("carries the cluster snapshot into context (slug, displayName, day/visit counts, topDomains)", () => {
    const result = evaluateOfferTriggers(snapshot(), NOW);
    expect(result?.context.slug).toBe("quantum-mechanics");
    expect(result?.context.displayName).toBe("Quantum Mechanics");
    expect(result?.context.daysActive).toBe(3);
    expect(result?.context.meaningfulVisits).toBe(22);
    expect(result?.context.foregroundHours).toBeCloseTo(1.1, 1);
    expect(result?.context.topDomains).toEqual([
      "arxiv.org",
      "wikipedia.org",
      "simonwillison.net",
    ]);
    expect(result?.context.distinctDomainsCount).toBe(3);
  });

  it("caps topDomains at 5 entries even if the snapshot carries more", () => {
    const result = evaluateOfferTriggers(
      snapshot({
        topDomains: ["a", "b", "c", "d", "e", "f", "g"],
      }),
      NOW,
    );
    expect(result?.context.topDomains).toHaveLength(5);
  });
});

describe("evaluateOfferTriggers — signal flags", () => {
  it("flags day_3_first_mention when qualified, <5 domains, never DM'd", () => {
    const result = evaluateOfferTriggers(snapshot(), NOW);
    expect(result?.context.signals.day_3_first_mention).toBe(true);
    expect(result?.context.signals.assist_eligible).toBe(false);
    expect(result?.context.signals.wiki_eligible).toBe(false);
    expect(result?.stamp).toEqual({
      dm: true,
      researchOffer: false,
      wikiOffer: false,
    });
  });

  it("flags assist_eligible when ≥5 distinct meaningful domains", () => {
    const result = evaluateOfferTriggers(
      snapshot({
        distinctMeaningfulDomains: 5,
        topDomains: ["arxiv", "wiki", "swllsn", "anthropic", "openai"],
      }),
      NOW,
    );
    expect(result?.context.signals.assist_eligible).toBe(true);
    // First DM AND assist eligible — both signals fire, the LLM picks
    // framing from the combination.
    expect(result?.context.signals.day_3_first_mention).toBe(true);
    expect(result?.stamp.researchOffer).toBe(true);
  });

  it("flags wiki_eligible when ≥10 long-reads across ≥2 days, no open research offer", () => {
    const result = evaluateOfferTriggers(
      snapshot({
        lastDmAt: NOW - 8 * DAY_MS, // outside DM budget
        distinctMeaningfulDomains: 5,
        researchOfferAcceptedAt: NOW - 5 * DAY_MS,
        longReadVisits: 12,
        longReadDays: 3,
      }),
      NOW,
    );
    expect(result?.context.signals.wiki_eligible).toBe(true);
    expect(result?.stamp.wikiOffer).toBe(true);
  });

  it("flags wiki_eligible independently of a pending research offer (seventh-pass — per-option gates)", () => {
    // Seventh-pass design: each option's eligibility is independent at
    // the offer-triggers level. The poller's `listPendingOffersForCluster`
    // check is what prevents firing a fresh DM while ANY offer is still
    // pending in the ledger — offer-triggers just emits signals. This
    // is a deliberate change from the P3b `researchOfferStillOpen` gate:
    // separating the two layers lets us add more pending-offer kinds
    // later without re-threading them through offer-triggers.
    const result = evaluateOfferTriggers(
      snapshot({
        lastDmAt: NOW - 8 * DAY_MS, // outside DM budget
        distinctMeaningfulDomains: 5,
        lastResearchOfferAt: NOW - 3 * DAY_MS, // still within 14d
        researchOfferAcceptedAt: null,
        longReadVisits: 12,
        longReadDays: 3,
      }),
      NOW,
    );
    // assist_eligible is suppressed by the per-option re-fire gate.
    expect(result?.context.signals.assist_eligible).toBe(false);
    // wiki_eligible passes — its own re-fire gate is open and the
    // research offer's state does not gate wiki at this layer.
    expect(result?.context.signals.wiki_eligible).toBe(true);
  });

  it("blocks wiki_eligible when a summary was already written", () => {
    const result = evaluateOfferTriggers(
      snapshot({
        lastDmAt: NOW - 8 * DAY_MS,
        distinctMeaningfulDomains: 5,
        researchOfferAcceptedAt: NOW - 10 * DAY_MS,
        wikiSummaryWrittenAt: NOW - 2 * DAY_MS,
        longReadVisits: 12,
        longReadDays: 3,
      }),
      NOW,
    );
    expect(result?.context.signals.wiki_eligible).toBe(false);
  });

  it("flags phase_shift when Jaccard distance ≥0.6 and recent foreground ≥30min and prior DM exists", () => {
    const result = evaluateOfferTriggers(
      snapshot({
        lastDmAt: NOW - 10 * DAY_MS,
        recentForegroundSec: 35 * 60,
        recentDomains: new Set(["github.com", "stackoverflow.com"]),
        priorDomains: new Set(["arxiv.org", "wikipedia.org", "anthropic.com"]),
      }),
      NOW,
    );
    expect(result?.context.signals.phase_shift).toBe(true);
  });

  it("does NOT flag phase_shift when no prior DM has anchored the cluster", () => {
    const result = evaluateOfferTriggers(
      snapshot({
        lastDmAt: null,
        recentForegroundSec: 35 * 60,
        recentDomains: new Set(["github.com"]),
        priorDomains: new Set(["arxiv.org", "wikipedia.org"]),
      }),
      NOW,
    );
    expect(result?.context.signals.phase_shift).toBe(false);
  });

  it("flags stall_48h when lastDmAt set, ≥3 active days, ≥48h since last activity", () => {
    const result = evaluateOfferTriggers(
      snapshot({
        lastDmAt: NOW - 20 * DAY_MS,
        lastActivityAt: NOW - 50 * HOUR_MS,
        distinctMeaningfulDays: 4,
        recentForegroundSec: 0,
        recentDomains: new Set(),
        priorDomains: new Set(),
      }),
      NOW,
    );
    expect(result?.context.signals.stall_48h).toBe(true);
  });

  it("does NOT flag stall when the cluster never received a prior DM", () => {
    const result = evaluateOfferTriggers(
      snapshot({
        lastDmAt: null,
        lastActivityAt: NOW - 3 * DAY_MS,
        distinctMeaningfulDays: 4,
      }),
      NOW,
    );
    // Result may be non-null because day_3_first_mention fires when
    // qualified; we just check stall_48h is not active.
    if (result) {
      expect(result.context.signals.stall_48h).toBe(false);
    }
  });
});

describe("evaluateOfferTriggers — DM budget", () => {
  it("suppresses every signal when last_dm_at is within budget window", () => {
    expect(
      evaluateOfferTriggers(
        snapshot({ lastDmAt: NOW - 2 * DAY_MS }),
        NOW,
      ),
    ).toBeNull();
  });

  it("allows trigger to fire once budget window has elapsed", () => {
    expect(
      evaluateOfferTriggers(
        snapshot({ lastDmAt: NOW - 8 * DAY_MS }),
        NOW,
      ),
    ).not.toBeNull();
  });
});

describe("evaluateOfferTriggers — status gates", () => {
  it.each(["muted", "concluded", "dormant"] as const)(
    "returns null for status=%s",
    (status) => {
      expect(
        evaluateOfferTriggers(snapshot({ status }), NOW),
      ).toBeNull();
    },
  );
});

describe("evaluateOfferTriggers — offer re-fire gates", () => {
  it("does NOT flag assist_eligible when re-fire window has not elapsed", () => {
    const result = evaluateOfferTriggers(
      snapshot({
        distinctMeaningfulDomains: 5,
        lastDmAt: NOW - 8 * DAY_MS,
        lastResearchOfferAt: NOW - 6 * DAY_MS,
      }),
      NOW,
    );
    expect(result?.context.signals.assist_eligible).toBe(false);
  });

  it("flags assist_eligible once the 14d window has elapsed", () => {
    const result = evaluateOfferTriggers(
      snapshot({
        distinctMeaningfulDomains: 5,
        lastDmAt: NOW - 20 * DAY_MS,
        lastResearchOfferAt: NOW - 16 * DAY_MS,
      }),
      NOW,
    );
    expect(result?.context.signals.assist_eligible).toBe(true);
  });
});

describe("evaluateOfferTriggers — no-fire branches", () => {
  it("returns null when nothing fires (qualified but no triggers)", () => {
    // Qualified, already DM'd, no phase shift, no stall, no wiki long-reads,
    // no research-assist domain threshold. None of the 5 signals should
    // fire → no engagement candidate → null.
    const result = evaluateOfferTriggers(
      snapshot({
        distinctMeaningfulDomains: 3,
        lastDmAt: NOW - 8 * DAY_MS,
        lastActivityAt: NOW - HOUR_MS,
        recentForegroundSec: 0,
        recentDomains: new Set(["a", "b"]),
        priorDomains: new Set(["a", "b"]),
        longReadVisits: 0,
      }),
      NOW,
    );
    expect(result).toBeNull();
  });

  it("handles fully disjoint recent/prior domain sets (intersect never adds)", () => {
    const result = evaluateOfferTriggers(
      snapshot({
        distinctMeaningfulDomains: 3,
        lastDmAt: NOW - 30 * DAY_MS,
        recentForegroundSec: 60 * 60,
        recentDomains: new Set(["a", "b", "c"]),
        priorDomains: new Set(["x", "y", "z"]),
      }),
      NOW,
    );
    expect(result?.context.signals.phase_shift).toBe(true);
  });

  it("handles asymmetric empty/non-empty domain sets (LEFT empty, RIGHT non-empty)", () => {
    const result = evaluateOfferTriggers(
      snapshot({
        distinctMeaningfulDomains: 3,
        lastDmAt: NOW - 30 * DAY_MS,
        recentForegroundSec: 60 * 60,
        recentDomains: new Set(),
        priorDomains: new Set(["x", "y", "z"]),
      }),
      NOW,
    );
    expect(result?.context.signals.phase_shift).toBe(true);
  });

  it("flags phase_shift when sets overlap partially", () => {
    const result = evaluateOfferTriggers(
      snapshot({
        distinctMeaningfulDomains: 3,
        lastDmAt: NOW - 30 * DAY_MS,
        recentForegroundSec: 60 * 60,
        recentDomains: new Set(["a", "b", "c"]),
        priorDomains: new Set(["c", "d", "e"]),
      }),
      NOW,
    );
    expect(result?.context.signals.phase_shift).toBe(true);
  });

  it("returns null when both recent/prior sets are empty AND no other signal fires", () => {
    const result = evaluateOfferTriggers(
      snapshot({
        distinctMeaningfulDomains: 3,
        lastDmAt: NOW - 30 * DAY_MS,
        lastActivityAt: NOW - HOUR_MS,
        recentForegroundSec: 60 * 60,
        recentDomains: new Set(),
        priorDomains: new Set(),
      }),
      NOW,
    );
    expect(result).toBeNull();
  });

  it("flags wiki_eligible when a prior research offer was accepted (research path cleared)", () => {
    const result = evaluateOfferTriggers(
      snapshot({
        distinctMeaningfulDomains: 3,
        lastDmAt: NOW - 30 * DAY_MS,
        lastResearchOfferAt: NOW - 5 * DAY_MS,
        researchOfferAcceptedAt: NOW - 4 * DAY_MS,
        longReadVisits: 12,
        longReadDays: 3,
      }),
      NOW,
    );
    expect(result?.context.signals.wiki_eligible).toBe(true);
  });

  it("flags wiki_eligible when a prior research offer is past the refire window", () => {
    const result = evaluateOfferTriggers(
      snapshot({
        distinctMeaningfulDomains: 3,
        lastDmAt: NOW - 30 * DAY_MS,
        lastResearchOfferAt: NOW - 20 * DAY_MS,
        researchOfferAcceptedAt: null,
        longReadVisits: 12,
        longReadDays: 3,
      }),
      NOW,
    );
    expect(result?.context.signals.wiki_eligible).toBe(true);
  });

  it("flags wiki_eligible when lastWikiOfferAt is past the refire window", () => {
    const result = evaluateOfferTriggers(
      snapshot({
        distinctMeaningfulDomains: 3,
        lastDmAt: NOW - 20 * DAY_MS,
        lastWikiOfferAt: NOW - 20 * DAY_MS,
        longReadVisits: 12,
        longReadDays: 3,
      }),
      NOW,
    );
    expect(result?.context.signals.wiki_eligible).toBe(true);
  });
});

describe("DEFAULT_OFFER_THRESHOLDS — invariants", () => {
  it("declares re-fire window of 14 days", () => {
    expect(DEFAULT_OFFER_THRESHOLDS.offerRefireMs).toBe(14 * DAY_MS);
  });

  it("declares stall window of 48h", () => {
    expect(DEFAULT_OFFER_THRESHOLDS.stallWindowMs).toBe(48 * HOUR_MS);
  });

  it("declares DM budget of 7 days", () => {
    expect(DEFAULT_OFFER_THRESHOLDS.dmBudgetMs).toBe(7 * DAY_MS);
  });
});
