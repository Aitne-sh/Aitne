/**
 * Offer-trigger evaluator — pure, deterministic qualification layer over
 * a cluster's engagement-tracking state (last DM, last research/wiki
 * offer wall-clocks, accept/decline flags). No LLM, no DB writes —
 * caller (the browser-history poller) reads cluster rows + the latest
 * aggregate, calls `evaluateOfferTriggers`, then (a) passes through
 * the rate-limit gate (`offer-rate-limit.ts`), (b) inserts a
 * `browser_pending_offers` row, and (c) enqueues a
 * `routine.research_offer_dm` event with the returned OfferContext as
 * event.data.
 *
 * Seventh-pass (BROWSER_HISTORY_INTEGRATION_PLAN.md §5.F1 — LLM-composed
 * offer redesign). Previous passes returned a templated DM string;
 * that is now composed by the `routine.research_offer_dm` agent
 * directly from the OfferContext payload so the prose is natural-
 * language-personalised. The qualification + rate-limit gates remain
 * deterministic Node code.
 *
 * Signals exposed in the OfferContext:
 *
 *   - assist_eligible — cluster has ≥5 distinct meaningful eTLD+1
 *     domains. The "research deeper" option is on the table.
 *   - wiki_eligible — cluster has ≥10 long-read meaningful visits
 *     (foreground ≥120s each) across ≥2 days. The "summarise" option
 *     is on the table.
 *   - day_3_first_mention — cluster has just crossed the 3-day / 20-
 *     visit qualification threshold for the first time.
 *   - stall_48h — ≥48h with no new meaningful visits in a cluster
 *     that already had ≥3 active days.
 *   - phase_shift — top-domain Jaccard distance vs. prior 7 days
 *     exceeds 0.6 AND recent foreground ≥30min.
 *
 * Gating (returns null without further consideration):
 *   - `status !== "active"` (muted / dormant / concluded).
 *   - DM budget gate (≤1 DM per cluster per `dmBudgetMs`).
 *   - Re-fire gate: the cluster has been offered the same option-set
 *     within `offerRefireMs` (14 days) AND the user has not accepted
 *     it yet (researchOfferAcceptedAt / wikiSummaryWrittenAt null).
 *
 * The poller's `offer-rate-limit.ts` adds GLOBAL gates (2/day cap,
 * 4h interval, different topic per offer, quiet hours, active-
 * conversation hold, decline backoff) on top of this per-cluster
 * gate. Keep the two layers separate — per-cluster invariants are
 * load-bearing for correctness; global rate limits are pacing.
 */

export interface ClusterEngagementSnapshot {
  slug: string;
  displayName: string;
  status: "active" | "dormant" | "concluded" | "muted";
  startedAt: number;
  lastActivityAt: number;
  meaningfulVisitsTotal: number;
  meaningfulForegroundSecTotal: number;
  distinctMeaningfulDomains: number;
  distinctMeaningfulDays: number;
  /** Count of meaningful visits with foreground_sec ≥ 120. Wiki gate. */
  longReadVisits: number;
  /** Distinct agent-days containing at least one long-read meaningful visit. */
  longReadDays: number;
  /** Foreground-sec sum over the most recent 7 agent-days. */
  recentForegroundSec: number;
  /** Set of distinct meaningful domains observed in the most recent 7 agent-days. */
  recentDomains: ReadonlySet<string>;
  /** Set of distinct meaningful domains observed in the prior 7 agent-days. */
  priorDomains: ReadonlySet<string>;
  /** Top eTLD+1 domains (≤5) ranked by meaningful-foreground time. */
  topDomains: readonly string[];
  lastDmAt: number | null;
  lastResearchOfferAt: number | null;
  lastWikiOfferAt: number | null;
  researchOfferAcceptedAt: number | null;
  wikiSummaryWrittenAt: number | null;
}

export interface OfferThresholds {
  /** §5.F1 qualification. */
  minDays: number;
  minMeaningfulVisits: number;
  minMeaningfulForegroundSec: number;
  minDistinctDomains: number;
  /** assist_eligible extra: ≥N distinct domains. */
  researchAssistMinDomains: number;
  /** wiki_eligible extras. */
  wikiMinLongReadVisits: number;
  wikiMinLongReadDays: number;
  /** phase_shift extras. */
  phaseShiftMinJaccardDistance: number;
  phaseShiftMinForegroundSec: number;
  /** stall_48h extra: minimum prior active-day count before stall is meaningful. */
  stallMinActiveDays: number;
  /** Cluster DM budget — 1 DM per `dmBudgetMs` per cluster. */
  dmBudgetMs: number;
  /** Per-offer re-fire window. */
  offerRefireMs: number;
  /** Stall trigger window. */
  stallWindowMs: number;
}

export const DEFAULT_OFFER_THRESHOLDS: OfferThresholds = {
  minDays: 3,
  minMeaningfulVisits: 20,
  minMeaningfulForegroundSec: 3600,
  minDistinctDomains: 3,
  researchAssistMinDomains: 5,
  wikiMinLongReadVisits: 10,
  wikiMinLongReadDays: 2,
  phaseShiftMinJaccardDistance: 0.6,
  phaseShiftMinForegroundSec: 30 * 60,
  stallMinActiveDays: 3,
  dmBudgetMs: 7 * 24 * 60 * 60 * 1000,
  offerRefireMs: 14 * 24 * 60 * 60 * 1000,
  stallWindowMs: 48 * 60 * 60 * 1000,
};

/**
 * The payload the `routine.research_offer_dm` agent reads from
 * `event.data`. Carries the cluster snapshot the LLM needs to compose
 * the two-option offer DM. Pure data — no DM prose, no acceptance
 * commands. The task-flow at
 * `agent-assets/task-flows/routine.research_offer_dm.md` documents
 * how this is consumed.
 */
export interface OfferContext {
  slug: string;
  displayName: string;
  daysActive: number;
  meaningfulVisits: number;
  /** Total foreground reading time, rounded to 1 decimal place. */
  foregroundHours: number;
  /** eTLD+1 labels, regex-constrained at the schema layer. ≤5. */
  topDomains: readonly string[];
  distinctDomainsCount: number;
  signals: {
    assist_eligible: boolean;
    wiki_eligible: boolean;
    day_3_first_mention: boolean;
    stall_48h: boolean;
    phase_shift: boolean;
  };
}

export interface OfferTriggerDecision {
  /**
   * The decision kind. Seventh-pass collapses the previous five
   * trigger kinds into a single `engagement_candidate` — the LLM
   * composes the framing from the `signals` payload, so the trigger
   * kind no longer encodes the variation. Kept as a discriminated-
   * union field so we can add additional kinds later without
   * breaking the consumer.
   */
  kind: "engagement_candidate";
  /** Cluster snapshot the offer DM agent reads from event.data. */
  context: OfferContext;
  /** Which offer-tracking columns to advance on the cluster row. */
  stamp: {
    dm: boolean;
    researchOffer: boolean;
    wikiOffer: boolean;
  };
  /**
   * The kind to write into `browser_pending_offers`. Always
   * `'offered'` for the two-option flow — the kind narrows to
   * `'research_assist'` or `'wiki_summary'` only at accept time,
   * inside the `/offers/<slug>/accept` endpoint.
   */
  pendingOfferKind: "offered";
}

function qualifies(
  snapshot: ClusterEngagementSnapshot,
  thresholds: OfferThresholds,
): boolean {
  return (
    snapshot.distinctMeaningfulDays >= thresholds.minDays
    && snapshot.meaningfulVisitsTotal >= thresholds.minMeaningfulVisits
    && snapshot.meaningfulForegroundSecTotal
      >= thresholds.minMeaningfulForegroundSec
    && snapshot.distinctMeaningfulDomains >= thresholds.minDistinctDomains
  );
}

function jaccardDistance(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  const intersect = new Set<string>();
  for (const item of a) if (b.has(item)) intersect.add(item);
  const union = new Set<string>([...a, ...b]);
  return 1 - intersect.size / union.size;
}

/**
 * Build the OfferContext payload from the cluster snapshot. Pure —
 * inputs in, payload out. Foreground time is rounded for human
 * readability (the LLM presents "2.1h", not "7521.3 seconds").
 */
function buildOfferContext(
  snapshot: ClusterEngagementSnapshot,
  signals: OfferContext["signals"],
): OfferContext {
  return {
    slug: snapshot.slug,
    displayName: snapshot.displayName,
    daysActive: snapshot.distinctMeaningfulDays,
    meaningfulVisits: snapshot.meaningfulVisitsTotal,
    foregroundHours:
      Math.round((snapshot.meaningfulForegroundSecTotal / 3600) * 10) / 10,
    topDomains: snapshot.topDomains.slice(0, 5),
    distinctDomainsCount: snapshot.distinctMeaningfulDomains,
    signals,
  };
}

export function evaluateOfferTriggers(
  snapshot: ClusterEngagementSnapshot,
  nowMs: number,
  thresholds: OfferThresholds = DEFAULT_OFFER_THRESHOLDS,
): OfferTriggerDecision | null {
  // Hard skips — never fire for these statuses regardless of qualification.
  if (snapshot.status !== "active") return null;

  // Per-cluster DM budget gate. The global `offer-rate-limit.ts`
  // applies on top of this; both must say "go". The per-cluster
  // budget exists to bound how often any single cluster can ping the
  // user even if the global cap allows more total offers in the day.
  if (
    snapshot.lastDmAt !== null
    && nowMs - snapshot.lastDmAt < thresholds.dmBudgetMs
  ) {
    return null;
  }

  // Compute signals. None of these throw the decision away on its own;
  // we collect them all and ask whether any "engagement option" is on
  // the table. The LLM colours the offer DM from the signal flags.
  const isQualified = qualifies(snapshot, thresholds);

  const assistEligible =
    isQualified
    && snapshot.distinctMeaningfulDomains >= thresholds.researchAssistMinDomains
    && snapshot.researchOfferAcceptedAt === null
    && (
      snapshot.lastResearchOfferAt === null
      || nowMs - snapshot.lastResearchOfferAt >= thresholds.offerRefireMs
    );

  const wikiEligible =
    isQualified
    && snapshot.longReadVisits >= thresholds.wikiMinLongReadVisits
    && snapshot.longReadDays >= thresholds.wikiMinLongReadDays
    && snapshot.wikiSummaryWrittenAt === null
    && (
      snapshot.lastWikiOfferAt === null
      || nowMs - snapshot.lastWikiOfferAt >= thresholds.offerRefireMs
    );

  const day3FirstMention = isQualified && snapshot.lastDmAt === null;

  const stall48h =
    snapshot.lastDmAt !== null
    && snapshot.distinctMeaningfulDays >= thresholds.stallMinActiveDays
    && nowMs - snapshot.lastActivityAt >= thresholds.stallWindowMs;

  const phaseShift =
    snapshot.lastDmAt !== null
    && snapshot.recentForegroundSec >= thresholds.phaseShiftMinForegroundSec
    && jaccardDistance(snapshot.recentDomains, snapshot.priorDomains)
      >= thresholds.phaseShiftMinJaccardDistance;

  // At least one path to engagement must be open. If neither assist
  // nor wiki is eligible, day_3_first_mention alone DOES still
  // qualify (it's "I notice you're researching X — what's the
  // thread?" — no option offered, just an opener). Stall / phase_shift
  // also fire bare reminders. Without any signal, no DM.
  const anySignal =
    assistEligible
    || wikiEligible
    || day3FirstMention
    || stall48h
    || phaseShift;

  if (!anySignal) return null;

  const signals: OfferContext["signals"] = {
    assist_eligible: assistEligible,
    wiki_eligible: wikiEligible,
    day_3_first_mention: day3FirstMention,
    stall_48h: stall48h,
    phase_shift: phaseShift,
  };

  return {
    kind: "engagement_candidate",
    context: buildOfferContext(snapshot, signals),
    stamp: {
      dm: true,
      // Only stamp the per-option re-fire window when the option was
      // actually on the table this fire. If only stall_48h fired
      // (no assist / wiki options offered), neither stamp should
      // advance — the option re-fire window must reflect "we asked
      // you about this option", not "we sent any DM at all".
      researchOffer: assistEligible,
      wikiOffer: wikiEligible,
    },
    pendingOfferKind: "offered",
  };
}
