import { z } from "zod";

export const browserHistoryBrowserKeySchema = z.enum([
  "chrome",
  "chromium",
  "edge",
  "brave",
  "comet",
  "atlas",
]);
export type BrowserHistoryBrowserKey = z.infer<typeof browserHistoryBrowserKeySchema>;

export const browserHistoryDetectionStatusSchema = z.enum([
  "available",
  "available_no_sync",
  "available_sync_broken",
  "permission_denied",
  "not_installed",
  "error",
]);
export type BrowserHistoryDetectionStatus = z.infer<typeof browserHistoryDetectionStatusSchema>;

export const browserHistoryCategorySchema = z.enum([
  "work",
  "research",
  "shopping",
  "social",
  "news",
  "entertainment",
  "dev",
  "banking",
  "health",
  "adult",
  "cloud-console",
  "localhost",
  "app-config",
  "other",
]);
export type BrowserHistoryCategory = z.infer<typeof browserHistoryCategorySchema>;

export const browserHistoryBrowserOverrideSchema = z.enum([
  "auto",
  "forced-on",
  "forced-off",
]);
export type BrowserHistoryBrowserOverride = z.infer<typeof browserHistoryBrowserOverrideSchema>;

export const browserHistoryPerBrowserLifecycleConfigSchema = z.object({
  enabled: z.boolean().default(true),
  profiles_to_track: z.array(z.string().min(1).max(120)).default([]),
  sync_flush_wait_seconds: z.number().int().min(5).max(300).default(60),
  check_interval_minutes_override: z
    .number()
    .int()
    .min(5)
    .max(360)
    .optional(),
});
export type BrowserHistoryPerBrowserLifecycleConfig = z.infer<
  typeof browserHistoryPerBrowserLifecycleConfigSchema
>;

export const browserHistoryLifecycleConfigSchema = z.object({
  enabled: z.boolean().default(true),
  check_interval_minutes: z.number().int().min(5).max(360).default(30),
  per_browser: z
    .record(z.string(), browserHistoryPerBrowserLifecycleConfigSchema)
    .default({}),
  respect_quiet_hours: z.boolean().default(true),
  max_concurrent_launches: z.number().int().min(1).max(4).default(1),
}).superRefine((value, ctx) => {
  const browserKeys = new Set<string>(browserHistoryBrowserKeySchema.options);
  for (const key of Object.keys(value.per_browser)) {
    if (!browserKeys.has(key)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["per_browser", key],
        message: `Unknown browser key "${key}"`,
      });
    }
  }
});
export type BrowserHistoryLifecycleConfig = z.infer<
  typeof browserHistoryLifecycleConfigSchema
>;

export const browserHistoryLifecycleStateValueSchema = z.enum([
  "healthy",
  "stopped",
  "stale",
  "sync_unresponsive",
  "launch_failed_recently",
  "lifecycle_paused",
]);
export type BrowserHistoryLifecycleStateValue = z.infer<
  typeof browserHistoryLifecycleStateValueSchema
>;

export const browserHistoryCapabilityDetailSchema = z.object({
  status: browserHistoryDetectionStatusSchema,
  profileCount: z.number().int().nonnegative().default(0),
  readableProfiles: z.number().int().nonnegative().default(0),
  signedInProfiles: z.number().int().nonnegative().default(0),
  lastHistoryMtimeMs: z.number().int().nonnegative().nullable().default(null),
  nonCanonicalLayout: z.boolean().default(false),
  message: z.string().max(500).nullable().default(null),
});
export type BrowserHistoryCapabilityDetail = z.infer<
  typeof browserHistoryCapabilityDetailSchema
>;

export const browserHistoryCapabilitiesSchema = z.object({
  detectedAt: z.string(),
  browsers: z.partialRecord(
    browserHistoryBrowserKeySchema,
    browserHistoryDetectionStatusSchema,
  ),
  ingestEnabled: z.array(browserHistoryBrowserKeySchema),
  details: z
    .partialRecord(browserHistoryBrowserKeySchema, browserHistoryCapabilityDetailSchema)
    .default({}),
});
export type BrowserHistoryCapabilities = z.infer<typeof browserHistoryCapabilitiesSchema>;

export const browserHistoryLifecycleBrowserStateSchema = z.object({
  state: browserHistoryLifecycleStateValueSchema,
  lastLaunchAt: z.number().int().nonnegative().nullable().default(null),
  lastSuccessfulSyncAt: z.number().int().nonnegative().nullable().default(null),
  lastCheckedAt: z.number().int().nonnegative().nullable().default(null),
  consecutiveFailures: z.number().int().nonnegative().default(0),
  pausedUntil: z.number().int().nonnegative().nullable().default(null),
  lastOutcome: z.string().max(80).nullable().default(null),
});
export type BrowserHistoryLifecycleBrowserState = z.infer<
  typeof browserHistoryLifecycleBrowserStateSchema
>;

export const browserHistoryLifecycleStateSchema = z.partialRecord(
  browserHistoryBrowserKeySchema,
  browserHistoryLifecycleBrowserStateSchema,
);
export type BrowserHistoryLifecycleState = z.infer<
  typeof browserHistoryLifecycleStateSchema
>;

export const browserHistoryClusterStatusSchema = z.enum([
  "active",
  "dormant",
  "concluded",
  "muted",
]);
export type BrowserHistoryClusterStatus = z.infer<
  typeof browserHistoryClusterStatusSchema
>;

export const browserHistoryClusterListItemSchema = z.object({
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,118}[a-z0-9]$/),
  displayName: z.string().min(1).max(120),
  startedAt: z.number().int().nonnegative(),
  lastActivityAt: z.number().int().nonnegative(),
  visitsTotal: z.number().int().nonnegative(),
  meaningfulVisitsTotal: z.number().int().nonnegative(),
  meaningfulForegroundSecTotal: z.number().int().nonnegative(),
  distinctMeaningfulDomains: z.number().int().nonnegative(),
  status: browserHistoryClusterStatusSchema,
  agentSummaryRevision: z.number().int().nonnegative(),
});
export type BrowserHistoryClusterListItem = z.infer<
  typeof browserHistoryClusterListItemSchema
>;

export const browserHistoryResearchClustersResponseSchema = z.object({
  clusters: z.array(browserHistoryClusterListItemSchema),
  generatedAt: z.string(),
});
export type BrowserHistoryResearchClustersResponse = z.infer<
  typeof browserHistoryResearchClustersResponseSchema
>;

export const yesterdayResearchSummarySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  sessions: z
    .array(
      z.object({
        topic: z.string().regex(/^[a-z0-9 /-]+$/i).max(80),
        durationMinutes: z.number().int().min(30).max(1440),
        sessionKind: z.enum([
          "research",
          "shopping",
          "travel-planning",
          "work",
          "other",
        ]),
        visitCount: z.number().int().nonnegative(),
      }),
    )
    .max(8),
});
export type YesterdayResearchSummary = z.infer<
  typeof yesterdayResearchSummarySchema
>;

export const browserHistoryStatusResponseSchema = z.object({
  capabilities: browserHistoryCapabilitiesSchema.nullable(),
  lifecycle: browserHistoryLifecycleStateSchema,
  lastIngestAt: z.number().int().nonnegative().nullable(),
});
export type BrowserHistoryStatusResponse = z.infer<
  typeof browserHistoryStatusResponseSchema
>;

// P2 dashboard browsing surfaces. F3 + F4 read-side endpoints — see
// BROWSER_HISTORY_INTEGRATION_PLAN §9. The schemas constrain shapes
// returned to the dashboard; the AI-side skill (Layer 3) accesses the
// same endpoints through the curl chokepoint.
const dateOnlyString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const asinString = z.string().regex(/^[A-Z0-9]{10}$/);

export const browserShoppingSessionSchema = z.object({
  date: dateOnlyString,
  vendor: z.literal("amazon"),
  asins: z.array(asinString).min(1).max(50),
  comparisonMinutes: z.number().int().min(1).max(24 * 60),
  locale: z.string().max(16).nullable(),
});
export type BrowserShoppingSession = z.infer<typeof browserShoppingSessionSchema>;

export const browserShoppingDateResponseSchema = z.object({
  date: dateOnlyString,
  sessions: z.array(browserShoppingSessionSchema).max(50),
});
export type BrowserShoppingDateResponse = z.infer<
  typeof browserShoppingDateResponseSchema
>;

export const browserReloadEntrySchema = z.object({
  urlPattern: z.string().min(1).max(180),
  reloadCount: z.number().int().min(1),
});
export type BrowserReloadEntry = z.infer<typeof browserReloadEntrySchema>;

export const browserReloadsTodayResponseSchema = z.object({
  date: dateOnlyString,
  entries: z.array(browserReloadEntrySchema).max(50),
});
export type BrowserReloadsTodayResponse = z.infer<
  typeof browserReloadsTodayResponseSchema
>;

export const browserReloadsWeeklyResponseSchema = z.object({
  rangeStart: dateOnlyString,
  rangeEnd: dateOnlyString,
  entries: z
    .array(browserReloadEntrySchema.extend({ days: z.number().int().min(1).max(7) }))
    .max(50),
});
export type BrowserReloadsWeeklyResponse = z.infer<
  typeof browserReloadsWeeklyResponseSchema
>;

// ── P3 — cluster engagement schemas ──
// See BROWSER_HISTORY_INTEGRATION_PLAN §9 / §5.F1. The cluster-detail and
// /delta responses are agent-callable through the `browser-history` skill,
// so the field set is intentionally narrow: no raw URLs, no raw titles, no
// search-query strings. `topDomains` are eTLD+1 labels (regex-constrained)
// and `recentDomainsAdded` is bucketed by the agent-day calendar.

export const browserHistoryDomainLabelSchema = z
  .string()
  .min(1)
  .max(253)
  .regex(/^[a-z0-9.-]+$/);

export const browserHistoryClusterDetailSchema = browserHistoryClusterListItemSchema.extend({
  rootTaskId: z.number().int().nonnegative(),
  topDomains: z.array(browserHistoryDomainLabelSchema).max(10),
  lastDmAt: z.number().int().nonnegative().nullable(),
  lastResearchOfferAt: z.number().int().nonnegative().nullable(),
  lastWikiOfferAt: z.number().int().nonnegative().nullable(),
  researchOfferAcceptedAt: z.number().int().nonnegative().nullable(),
  wikiSummaryWrittenAt: z.number().int().nonnegative().nullable(),
});
export type BrowserHistoryClusterDetail = z.infer<
  typeof browserHistoryClusterDetailSchema
>;

export const browserHistoryClusterDeltaEntrySchema = z.object({
  date: dateOnlyString,
  meaningfulVisits: z.number().int().nonnegative(),
  meaningfulForegroundSec: z.number().int().nonnegative(),
  newDomains: z.array(browserHistoryDomainLabelSchema).max(10),
});
export const browserHistoryClusterDeltaResponseSchema = z.object({
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,118}[a-z0-9]$/),
  generatedAt: z.string(),
  days: z.array(browserHistoryClusterDeltaEntrySchema).max(31),
});
export type BrowserHistoryClusterDeltaResponse = z.infer<
  typeof browserHistoryClusterDeltaResponseSchema
>;

// `'offered'` is the seventh-pass two-option flow: the offer DM agent
// has sent a single DM that presents both research-deeper and
// summarise options, and the user has not yet replied. The accept
// endpoint narrows it to `'research_assist'` or `'wiki_summary'` on
// dispatch. `'research_assist'` and `'wiki_summary'` remain in the
// enum for (a) the accept request body (the user's chosen kind) and
// (b) P3b-era pending rows that still exist in shipped DBs (these
// expire naturally via the 14-day TTL).
export const browserHistoryOfferKindSchema = z.enum([
  "offered",
  "research_assist",
  "wiki_summary",
]);
export type BrowserHistoryOfferKind = z.infer<typeof browserHistoryOfferKindSchema>;
/** The two kinds the accept endpoint accepts as a request body. */
export const browserHistoryAcceptKindSchema = z.enum([
  "research_assist",
  "wiki_summary",
]);
export type BrowserHistoryAcceptKind = z.infer<
  typeof browserHistoryAcceptKindSchema
>;

export const browserHistoryPendingOfferSchema = z.object({
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,118}[a-z0-9]$/),
  displayName: z.string().min(1).max(120),
  kind: browserHistoryOfferKindSchema,
  offeredAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().nonnegative(),
});
export type BrowserHistoryPendingOffer = z.infer<
  typeof browserHistoryPendingOfferSchema
>;

export const browserHistoryPendingOffersResponseSchema = z.object({
  offers: z.array(browserHistoryPendingOfferSchema).max(50),
  generatedAt: z.string(),
});
export type BrowserHistoryPendingOffersResponse = z.infer<
  typeof browserHistoryPendingOffersResponseSchema
>;

// The accept endpoint takes only the narrow kinds (research_assist /
// wiki_summary) — `offered` is a server-side state, not a client
// choice.
export const browserHistoryAcceptOfferRequestSchema = z.object({
  kind: browserHistoryAcceptKindSchema,
});
export type BrowserHistoryAcceptOfferRequest = z.infer<
  typeof browserHistoryAcceptOfferRequestSchema
>;

export const browserHistoryAcceptOfferResponseSchema = z.object({
  slug: z.string(),
  kind: browserHistoryOfferKindSchema,
  processKey: z.enum(["routine.research_dispatch", "routine.research_wiki_summary"]),
  enqueued: z.boolean(),
});
export type BrowserHistoryAcceptOfferResponse = z.infer<
  typeof browserHistoryAcceptOfferResponseSchema
>;

// `wikiSummaryWrittenAt` marks "the wiki note physically exists" — it
// must only be advanced after the agent has actually written the wiki
// note (Obsidian / Notion / local context fallback). Stamping it at
// acceptance time would trip the task-flow's materiality check
// (`routine.research_wiki_summary.md` step 3) and skip the first
// write. The accept paths stamp `lastWikiOfferAt` instead (gates the
// 14-day re-fire window); the task-flow calls this endpoint after a
// successful write to advance `wikiSummaryWrittenAt`.
export const browserHistoryWikiWrittenResponseSchema = z.object({
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,118}[a-z0-9]$/),
  wikiSummaryWrittenAt: z.number().int().nonnegative(),
});
export type BrowserHistoryWikiWrittenResponse = z.infer<
  typeof browserHistoryWikiWrittenResponseSchema
>;

// ── P4a — pre-morning digest (F2 Stage 1) ──
// BROWSER_HISTORY_INTEGRATION_PLAN §5.F2 + §10.6 step 3. The digest is
// computed deterministically by the daemon at `day_boundary − 60min`
// and written to `~/.personal-agent/context/browser/yesterday-<date>.md`
// so the morning Stage B journal reads a static file (no LLM in the
// computation path, no API call at 04:00).
//
// The same data is served by `GET /api/browser-history/pre-morning-digest/{date}`
// as a JSON fallback in case the file is missing (daemon stopped at 03:00,
// fresh install, retention purge). Both surfaces must encode the same
// shape, hence a shared Zod schema below.
//
// Layer 1 invariants preserved:
//   - `topic` / `displayName` is the cluster's curated label (no raw
//     title), constrained to `[a-z0-9 /-]+` like `yesterdayResearchSummary.topic`
//     so an attacker-shaped display_name cannot smuggle prompt prose.
//   - `topDomains` are eTLD+1 labels (regex-constrained) — never raw URLs.
//   - `urlPattern` in reloads is `<domain>/<first-path-segment>` —
//     deterministically derived in `pipeline/reload-detector.ts`, query
//     strings stripped. Domain-label-shaped check + path-segment cap so
//     a poisoned History row cannot expand the surface.
//   - No `search_query`, no raw `urls.title`, no full URL anywhere.

/** Cluster-touched-in-window entry in the pre-morning digest. */
export const preMorningDigestClusterEntrySchema = z.object({
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,118}[a-z0-9]$/),
  /**
   * Curated display label, same constraint as `yesterdayResearchSummary.topic`
   * — `[a-z0-9 /-]+`, ≤80 chars. Stored on the cluster row and refreshed by
   * the deterministic display-name picker until the agent renames it.
   */
  displayName: z.string().regex(/^[a-z0-9 /-]+$/i).max(80),
  status: browserHistoryClusterStatusSchema,
  /** Total days of meaningful activity across the cluster's lifetime. */
  daysActive: z.number().int().nonnegative(),
  /** Meaningful visits inside the digest window (e.g. yesterday's bucket). */
  meaningfulVisitsInWindow: z.number().int().nonnegative(),
  /** Foreground time inside the window, rounded to whole seconds. */
  meaningfulForegroundSecInWindow: z.number().int().nonnegative(),
  /**
   * eTLD+1 labels that appear in this window's bucket but did not appear
   * in any earlier bucket of the same cluster. Bounded at 10.
   */
  newDomainsInWindow: z.array(browserHistoryDomainLabelSchema).max(10),
  /**
   * Top eTLD+1 labels across the cluster's meaningful visits — useful
   * for the journal-side renderer to colour the "what was I reading
   * yesterday" prose. Bounded at 10.
   */
  topDomains: z.array(browserHistoryDomainLabelSchema).max(10),
  /**
   * True when an offer for this cluster fired inside the digest window —
   * i.e. a `browser_pending_offers` row exists with `offered_at` between
   * the agent-day's start and end. Used by the journal as a proxy for
   * "new threshold crossing"; the proxy is tight in the common case (an
   * offer fires the moment qualification crosses) and loose only when
   * the rate-limit gate suppressed the offer despite qualification — in
   * that case the cluster will still surface here on the next digest
   * after the gate clears, just one day late. Renaming this field to
   * `offerFiredOvernight` is the honest long-term direction; preserved
   * as `qualifiedOvernight` for §10.6 wire-compat with the journal task
   * flow and the route schema.
   */
  qualifiedOvernight: z.boolean(),
});
export type PreMorningDigestClusterEntry = z.infer<
  typeof preMorningDigestClusterEntrySchema
>;

/** F3 shopping-session summary line carried in the digest. */
export const preMorningDigestShoppingEntrySchema = z.object({
  vendor: z.literal("amazon"),
  /** Number of distinct ASINs compared in the qualifying session(s). */
  asinCount: z.number().int().min(1).max(50),
  /** Total comparison minutes across qualifying sessions for the date. */
  comparisonMinutes: z.number().int().min(1).max(24 * 60),
  locale: z.string().max(16).nullable(),
});
export type PreMorningDigestShoppingEntry = z.infer<
  typeof preMorningDigestShoppingEntrySchema
>;

/** F4 reload signal row — informational, never surfaced as a DM. */
export const preMorningDigestReloadEntrySchema = z.object({
  urlPattern: z.string().min(1).max(180),
  reloadCount: z.number().int().min(1),
});
export type PreMorningDigestReloadEntry = z.infer<
  typeof preMorningDigestReloadEntrySchema
>;

/** Open offer awaiting user response, surfaced in the morning digest. */
export const preMorningDigestPendingOfferSchema = z.object({
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,118}[a-z0-9]$/),
  displayName: z.string().regex(/^[a-z0-9 /-]+$/i).max(80),
  kind: browserHistoryOfferKindSchema,
  offeredAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().nonnegative(),
});
export type PreMorningDigestPendingOffer = z.infer<
  typeof preMorningDigestPendingOfferSchema
>;

/**
 * Whole-digest payload. Mirrors the markdown file 1:1 — the digest
 * builder writes one and serves the other from the same in-memory
 * object so the two views never drift. Boot- and shape-resilient
 * (every collection has a `.max()` cap so an attacker-shaped cluster
 * fan-out cannot balloon the morning context).
 */
export const preMorningDigestSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  generatedAt: z.string(),
  /** Source of truth tag — `"deterministic"` today; reserved for future modes. */
  source: z.literal("deterministic"),
  clusters: z.array(preMorningDigestClusterEntrySchema).max(12),
  shopping: z.array(preMorningDigestShoppingEntrySchema).max(8),
  reloads: z.array(preMorningDigestReloadEntrySchema).max(10),
  pendingOffers: z.array(preMorningDigestPendingOfferSchema).max(20),
  /** Count of clusters whose `qualifiedOvernight=true` — convenience for the journal. */
  newThresholdsCount: z.number().int().nonnegative(),
});
export type PreMorningDigest = z.infer<typeof preMorningDigestSchema>;
