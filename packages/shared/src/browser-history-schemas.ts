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

// ── WEEKLY_INTERESTS_REFLECTION_PLAN.md §10.2 / §10.3 / §10.3.1 ──
// Response shapes for the three Approach-A reflection routes. The
// daemon-side helpers in `services/browser-history/{refresh,cleanup}-
// interests-reflection.ts` and `pipeline/weekly-interests-summary.ts`
// own the source TypeScript types; these schemas are the on-the-wire
// projection consumed by the dashboard. Field-by-field parity is
// asserted by `weekly-interests-routes.test.ts`.
//
// Slug shape mirrors the cluster slug regex used elsewhere in this file
// (`browser_research_clusters.slug` is the same column space) so a
// future renamer can grep one regex.
const weeklyInterestsSlugRegex = /^[a-z0-9][a-z0-9-]{0,118}[a-z0-9]$/;
const weeklyInterestsDateRegex = /^\d{4}-\d{2}-\d{2}$/;
const weeklyInterestsRelativePathRegex = /^[A-Za-z0-9_./-]{1,256}$/;

export const weeklyInterestsClusterStatusSchema = z.enum([
  "active",
  "dormant",
  "concluded",
  "muted",
]);
export type WeeklyInterestsClusterStatus = z.infer<
  typeof weeklyInterestsClusterStatusSchema
>;

export const weeklyInterestsClusterStatusChangeSchema = z.enum([
  "new",
  "active_continued",
  "newly_dormant",
  "muted_this_week",
]);
export type WeeklyInterestsClusterStatusChange = z.infer<
  typeof weeklyInterestsClusterStatusChangeSchema
>;

export const weeklyInterestsClusterSnapshotSchema = z.object({
  slug: z.string().regex(weeklyInterestsSlugRegex),
  displayName: z.string().min(1).max(120),
  daysActive: z.number().int().min(0).max(7),
  meaningfulVisits: z.number().int().nonnegative(),
  meaningfulForegroundSec: z.number().int().nonnegative(),
  distinctMeaningfulDomains: z.number().int().nonnegative(),
  topDomains: z.array(browserHistoryDomainLabelSchema).max(5),
  status: weeklyInterestsClusterStatusSchema,
  statusChange: weeklyInterestsClusterStatusChangeSchema,
  clusterJournalPath: z.string().regex(weeklyInterestsRelativePathRegex),
  hasOpenOffer: z.boolean(),
  hasAcceptedResearch: z.boolean(),
  hasWikiSummary: z.boolean(),
  lastActivityDate: z.string().regex(weeklyInterestsDateRegex),
  lastActivityMs: z.number().int().nonnegative(),
});
export type WeeklyInterestsClusterSnapshot = z.infer<
  typeof weeklyInterestsClusterSnapshotSchema
>;

export const weeklyInterestsDormantEntrySchema = z.object({
  slug: z.string().regex(weeklyInterestsSlugRegex),
  displayName: z.string().min(1).max(120),
  lastActivity: z.string().regex(weeklyInterestsDateRegex),
  lastActivityMs: z.number().int().nonnegative(),
});
export type WeeklyInterestsDormantEntry = z.infer<
  typeof weeklyInterestsDormantEntrySchema
>;

export const weeklyInterestsProjectMatchSchema = z.object({
  projectSlug: z.string().min(1).max(120),
  projectPath: z.string().min(1).max(512),
  clusters: z
    .array(
      z.object({
        slug: z.string().regex(weeklyInterestsSlugRegex),
        reason: z.enum(["filename_match", "jaccard"]),
      }),
    )
    .max(5),
});
export type WeeklyInterestsProjectMatch = z.infer<
  typeof weeklyInterestsProjectMatchSchema
>;

export const weeklyInterestsSummaryResponseSchema = z.object({
  weekStart: z.string().regex(weeklyInterestsDateRegex),
  weekEnd: z.string().regex(weeklyInterestsDateRegex),
  generatedAt: z.string(),
  clusters: z.array(weeklyInterestsClusterSnapshotSchema).max(20),
  dormantSinceLastWeek: z.array(weeklyInterestsDormantEntrySchema).max(50),
  projectMatches: z.array(weeklyInterestsProjectMatchSchema).max(50),
});
export type WeeklyInterestsSummaryResponse = z.infer<
  typeof weeklyInterestsSummaryResponseSchema
>;

// POST /api/browser-history/refresh-interests-reflection — Approve tier,
// dashboard-only. No request payload by design (§10.3): the helper
// resolves the current ISO Monday itself so the dashboard does not need
// to compute the agent-day boundary. Response mirrors the helper's
// `RefreshResult`; `skipped` is set when the helper bailed. rev 4 —
// both skip reasons live in the same union so the dashboard's
// `data.skipped.reason` branch has no dead arm and the audit row
// shape is uniform regardless of which gate failed:
//   - `"fewer_than_min_themes"` — < 3 qualifying clusters in window.
//   - `"no_browser_history"` — upstream integration mode = `disabled`
//     (set by the dispatcher pre-hook via the `integrationDisabled`
//     option; the dashboard route never sets it because the UI gates
//     on the integration card's enable state).
export const refreshInterestsReflectionSkipReasonSchema = z.object({
  reason: z.enum(["fewer_than_min_themes", "no_browser_history"]),
});

export const refreshInterestsReflectionResponseSchema = z.object({
  weekStart: z.string().regex(weeklyInterestsDateRegex),
  generatedAt: z.string(),
  targetsWritten: z.array(z.string()).max(100),
  targetsSkipped: z
    .array(z.object({ path: z.string(), reason: z.string() }))
    .max(100),
  themesSelected: z.array(z.string().regex(weeklyInterestsSlugRegex)).max(7),
  clustersInSnapshot: z.number().int().nonnegative(),
  clustersDormantSinceLastWeek: z.number().int().nonnegative(),
  projectsAnnotated: z.number().int().nonnegative(),
  projectsSkippedNoMatch: z.number().int().nonnegative(),
  skipped: refreshInterestsReflectionSkipReasonSchema.optional(),
});
export type RefreshInterestsReflectionResponse = z.infer<
  typeof refreshInterestsReflectionResponseSchema
>;

// POST /api/browser-history/cleanup-interests-reflection — Approve
// tier, dashboard-only. Payload toggles whether the daemon-owned
// `user/research-themes.md` snapshot is deleted alongside the
// `<!-- BEGIN aitne:browser-interests v1 ... -->` block strip. Default
// is true (the intuitive "wipe the auto content"); operators that want
// to keep the snapshot file pass `false`.
export const cleanupInterestsReflectionRequestSchema = z
  .object({
    alsoDeleteResearchThemesFile: z.boolean().optional(),
  })
  .strict();
export type CleanupInterestsReflectionRequest = z.infer<
  typeof cleanupInterestsReflectionRequestSchema
>;

export const cleanupInterestsReflectionResponseSchema = z.object({
  blocksRemoved: z.number().int().nonnegative(),
  filesAffected: z.array(z.string()).max(200),
  researchThemesDeleted: z.boolean(),
});
export type CleanupInterestsReflectionResponse = z.infer<
  typeof cleanupInterestsReflectionResponseSchema
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

// ─────────────────────────────────────────────────────────────────────
// Managed Chromium (Approach B / Phase B-1).
// MANAGED_CHROMIUM_IMPLEMENTATION_PLAN.md §7.7 — dashboard surface.
// ─────────────────────────────────────────────────────────────────────

export const managedChromiumStateValueSchema = z.enum([
  "off",
  "needs_setup",
  "missing_binary",
  "missing_sandbox",
  "ready",
  "needs_reauth",
  "disconnected",
]);
export type ManagedChromiumStateValue = z.infer<
  typeof managedChromiumStateValueSchema
>;

/**
 * Dashboard view of the managed Chromium control surface. Carries the
 * state-machine value, optional account label, and recent-sync stats.
 * Bootstrap-internal data (PID, deadlineAt) is NOT exposed — those are
 * lifecycle internals, the dashboard only needs to know whether a
 * bootstrap is in progress and whether it has finalised.
 */
export const managedChromiumStatusResponseSchema = z.object({
  enabled: z.boolean(),
  state: managedChromiumStateValueSchema,
  signedInUser: z.string().max(254).nullable(),
  lastCheckAt: z.number().int().nonnegative().nullable(),
  lastSyncAt: z.number().int().nonnegative().nullable(),
  recentRowCount: z.number().int().nonnegative().nullable(),
  bootstrapInProgress: z.boolean(),
  bootstrapDeadlineAt: z.number().int().nonnegative().nullable(),
  pausedUntil: z.number().int().nonnegative().nullable(),
  consecutiveFailures: z.number().int().nonnegative(),
  /** Resolved sandbox-primitive kind: "sandbox-exec" | "bubblewrap" |
   *  "systemd-run" | "appcontainer-jobobject" | "none". */
  sandboxPrimitive: z.enum([
    "sandbox-exec",
    "bubblewrap",
    "systemd-run",
    "appcontainer-jobobject",
    "none",
  ]),
  /** True when host has a display (interactive sign-in supported). */
  hasDisplay: z.boolean(),
  /** True when `HostProfile.browserBinaryFor("chromium")` resolves. */
  chromiumBinaryFound: z.boolean(),
});
export type ManagedChromiumStatusResponse = z.infer<
  typeof managedChromiumStatusResponseSchema
>;

export const managedChromiumSetupStatusResponseSchema = z.object({
  state: z.enum(["idle", "running"]),
  pid: z.number().int().positive().nullable(),
  deadlineAt: z.number().int().nonnegative().nullable(),
  signedIn: z.boolean(),
  observedUser: z.string().max(254).nullable(),
});
export type ManagedChromiumSetupStatusResponse = z.infer<
  typeof managedChromiumSetupStatusResponseSchema
>;

export const managedChromiumEnableRequestSchema = z.object({
  enabled: z.boolean(),
  /** Operator opt-in to running under sandbox `kind=none` (Linux
   *  without bwrap/systemd-run). Default false; required when the
   *  resolved sandbox primitive is `none`. */
  unsandboxedOptIn: z.boolean().optional(),
});
export type ManagedChromiumEnableRequest = z.infer<
  typeof managedChromiumEnableRequestSchema
>;

export const managedChromiumActionResponseSchema = z.object({
  ok: z.boolean(),
  state: managedChromiumStateValueSchema,
  reason: z
    .enum([
      "missing_binary",
      "missing_sandbox",
      "spawn_failed",
      "already_running",
      "not_running",
      "not_signed_in",
    ])
    .optional(),
});
export type ManagedChromiumActionResponse = z.infer<
  typeof managedChromiumActionResponseSchema
>;

// ─────────────────────────────────────────────────────────────────────
// Browser Automation — Instance A workflow surface (Phase B-2).
// MANAGED_CHROMIUM_IMPLEMENTATION_PLAN.md §8.3–§8.10.
//
// These schemas live on the wire boundary — the daemon's route validates
// the request body and renders the response. Per-workflow inputSchema /
// outputSchema definitions live next to each workflow under
// packages/daemon/src/services/browser-history/automation/workflows/
// because they are workflow-specific (e.g., extractNewsArticle's
// outputSchema is different from screenshotPage's).
// ─────────────────────────────────────────────────────────────────────

/** Closed set of workflow-runner outcomes — kept in lockstep with the
 *  CHECK clause on `browser_automation_workflows.outcome` and with
 *  `WorkflowRunOutcome` in `automation/types.ts`. The schema's
 *  `superRefine` on the API layer cannot prevent drift between the three;
 *  the `outcome-drift.test.ts` lint enforces it. */
export const browserAutomationOutcomeSchema = z.enum([
  "success",
  "unknown_workflow",
  "input_validation_error",
  "output_validation_error",
  "url_not_allowlisted",
  "user_allowlist_blocked",
  "host_not_extractable",
  "rate_limited",
  "site_not_connected",
  "playwright_launch_timeout",
  "playwright_error",
  "timeout",
  // ── Phase B-3 (gated write automation) outcomes ──
  // MANAGED_CHROMIUM_IMPLEMENTATION_PLAN.md §10 / §13 steps 43-46.
  // Kept in lockstep with the CHECK clause on
  // `browser_automation_workflows.outcome` (see schema.ts) and with
  // `WorkflowRunOutcome` in `automation/types.ts`.
  "needs_approval",
  "approval_expired",
  "approval_token_invalid",
  "payment_path_blocked",
  // ── Phase B-4 (experimental purchase) runner-level outcomes ──
  // MANAGED_CHROMIUM_IMPLEMENTATION_PLAN.md §17 / §13 steps 49-60.
  //
  // These fire BEFORE the workflow's `run()` is invoked — i.e., the
  // master toggle is off, the site is not opted-in to B-4, a token is
  // already pending for this site_key (per-site concurrency cap 1), or
  // the per-site per-day token / spend cap is exhausted. In-flight
  // branches (user replied wrong, timeout, page mutated under the
  // pause, displayed total mismatch) surface through the workflow's
  // structured `outputSchema.status` and the runner-level outcome stays
  // `success` for those.
  //
  // The DM-token gate itself is enforced inside the workflow via
  // `purchase-handler.awaitReply(jti)` — there is no runner-level
  // `purchase_token_invalid` outcome because the agent CANNOT supply
  // a token at the route layer (B-4's consent model is "daemon mints
  // the token AFTER the pre-confirm screenshot; user types it in DM").
  "purchase_b4_disabled",
  "purchase_site_not_enabled",
  "purchase_pending_exists",
  "purchase_daily_cap_exceeded",
]);
export type BrowserAutomationOutcome = z.infer<
  typeof browserAutomationOutcomeSchema
>;

/** Workflow registry entry surfaced by `GET /api/browser-automation/workflows`. */
export const browserAutomationWorkflowSummarySchema = z.object({
  name: z.string().min(1).max(64).regex(/^[a-zA-Z][a-zA-Z0-9_]*$/),
  riskTier: z.enum(["autonomous", "read_sensitive", "approve"]),
  /** Stringified RegExp source (sans flags). The runner enforces; this
   *  is rendered for the dashboard's allowlist hint UI. */
  allowlistRegex: z.string().max(512),
  variant: z.enum(["anon", "auth", "purchase"]),
  /** Defined when `variant !== "anon"` (B-2.5 / B-4 only). B-2 ships
   *  anon workflows only; B-2.5+ workflows declare a registered site
   *  key (e.g., `"amazon_jp"`). */
  siteKey: z.string().min(1).max(64).optional(),
  perWorkflowTimeoutMs: z.number().int().min(1000).max(600_000),
});
export type BrowserAutomationWorkflowSummary = z.infer<
  typeof browserAutomationWorkflowSummarySchema
>;

export const browserAutomationWorkflowListResponseSchema = z.object({
  workflows: z.array(browserAutomationWorkflowSummarySchema).max(64),
  /** True when the master managed-Chromium toggle is on AND the per-
   *  install automation surface sub-toggle is on. The API layer reports
   *  this so the dashboard's empty-state UX can distinguish "no
   *  workflows registered" from "automation surface disabled". */
  automationEnabled: z.boolean(),
});
export type BrowserAutomationWorkflowListResponse = z.infer<
  typeof browserAutomationWorkflowListResponseSchema
>;

/** Body of `POST /api/browser-automation/workflows/:name`. The runner
 *  forwards `params` to the workflow's `inputSchema.safeParse`; this
 *  outer schema only validates the envelope shape. */
/** Single-use approval token — 32 hex characters (128 bits entropy)
 *  minted by `POST /api/browser-automation/approvals/:id/approve`.
 *  Required when invoking a B-3 workflow (riskTier=Approve, variant
 *  != purchase). The runner re-hashes and compares atomically; the
 *  raw token never lives in the DB. */
export const browserAutomationApprovalTokenSchema = z
  .string()
  .regex(/^[0-9a-f]{32}$/);
export type BrowserAutomationApprovalToken = z.infer<
  typeof browserAutomationApprovalTokenSchema
>;

export const browserAutomationRunRequestSchema = z.object({
  /** Free-form params object. The per-workflow Zod schema lives daemon-
   *  side and is the source of truth — duplicating it here would force
   *  every workflow addition to touch the shared package. */
  params: z.unknown(),
  /** Required for B-3 workflows (riskTier=Approve, non-purchase
   *  variant). Token must match a row in `browser_automation_approvals`
   *  with status='approved' AND token_hash=sha256(token) AND
   *  workflow_name AND params_hash AND expires_at > now. The runner
   *  atomically flips the row to 'consumed' before Playwright fires. */
  approvalToken: browserAutomationApprovalTokenSchema.optional(),
});
export type BrowserAutomationRunRequest = z.infer<
  typeof browserAutomationRunRequestSchema
>;

export const browserAutomationRunResponseSchema = z.object({
  status: browserAutomationOutcomeSchema,
  /** UUID-shape per-run id (matches `browser_automation_workflows.workflow_id`).
   *  Returned for every status, including failures — so the dashboard's
   *  trace viewer can link to the audit row even when the workflow
   *  short-circuits before Playwright runs. */
  workflowId: z.string().regex(/^[a-f0-9-]{36}$/),
  /** Present only on `status === "success"`. Workflow-specific shape;
   *  not Zod-validated here because the per-workflow outputSchema does
   *  it daemon-side. */
  output: z.unknown().optional(),
  /** Present when input validation failed; Zod error tree. */
  validationErrors: z.unknown().optional(),
  /** Diagnostic detail for `host_not_extractable` /
   *  `user_allowlist_blocked` / `url_not_allowlisted` /
   *  `needs_approval` / `payment_path_blocked` / `site_not_connected`. */
  detail: z
    .object({
      host: z.string().max(253).optional(),
      url: z.string().url().max(2048).optional(),
      reason: z.string().max(120).optional(),
      siteKey: z.string().min(1).max(64).optional(),
      // ── Phase B-3 surfaces ──
      // Approval-handle returned alongside `needs_approval`. The
      // caller (agent skill / dashboard) uses it to poll or to surface
      // a deeplink. `expiresAt` is the 5-min TTL deadline; once it
      // passes, the row flips to 'expired' and a fresh approval must
      // be requested.
      approvalId: z.string().regex(/^[a-f0-9-]{36}$/).optional(),
      expiresAt: z.number().int().nonnegative().optional(),
      // For `payment_path_blocked`: the category that matched
      // (`checkout`, `payment`, `place-order`, `buy`, `place-bid`).
      paymentPathCategory: z
        .enum(["checkout", "payment", "place-order", "buy", "place-bid"])
        .optional(),
    })
    .optional(),
});
export type BrowserAutomationRunResponse = z.infer<
  typeof browserAutomationRunResponseSchema
>;

export const browserAutomationAllowlistEntrySchema = z.object({
  /** eTLD+1, lower-cased. The API rejects non-host strings (paths,
   *  schemes, ports). */
  domain: z
    .string()
    .min(1)
    .max(253)
    .regex(/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/),
  mode: z.enum(["read", "denied"]),
  addedAt: z.number().int().nonnegative(),
  addedBy: z.enum(["user", "system"]),
});
export type BrowserAutomationAllowlistEntry = z.infer<
  typeof browserAutomationAllowlistEntrySchema
>;

export const browserAutomationAllowlistResponseSchema = z.object({
  entries: z.array(browserAutomationAllowlistEntrySchema).max(256),
});
export type BrowserAutomationAllowlistResponse = z.infer<
  typeof browserAutomationAllowlistResponseSchema
>;

export const browserAutomationAllowlistAddRequestSchema = z.object({
  domain: browserAutomationAllowlistEntrySchema.shape.domain,
  mode: z.enum(["read", "denied"]).default("read"),
});
export type BrowserAutomationAllowlistAddRequest = z.infer<
  typeof browserAutomationAllowlistAddRequestSchema
>;

export const browserAutomationRecentRunSchema = z.object({
  workflowId: z.string().regex(/^[a-f0-9-]{36}$/),
  workflowName: z.string(),
  paramsHash: z.string(),
  targetUrls: z.array(z.string().url()).max(10),
  blockedRequests: z.array(z.string().url().max(2048)).max(200),
  durationMs: z.number().int().nonnegative(),
  outcome: browserAutomationOutcomeSchema,
  startedAt: z.number().int().nonnegative(),
  finishedAt: z.number().int().nonnegative(),
  screenshotPath: z.string().nullable(),
  tracePath: z.string().nullable(),
});
export type BrowserAutomationRecentRun = z.infer<
  typeof browserAutomationRecentRunSchema
>;

export const browserAutomationRecentRunsResponseSchema = z.object({
  runs: z.array(browserAutomationRecentRunSchema).max(50),
});
export type BrowserAutomationRecentRunsResponse = z.infer<
  typeof browserAutomationRecentRunsResponseSchema
>;

// ─────────────────────────────────────────────────────────────────────
// Browser Automation Sites — per-site authenticated sessions (Phase B-2.5).
// MANAGED_CHROMIUM_IMPLEMENTATION_PLAN.md §16.9.
// ─────────────────────────────────────────────────────────────────────

/** Per-site connection state surfaced to the dashboard's per-site card. */
export const browserAutomationSiteConnectionStateSchema = z.enum([
  "connected",
  "needs_reauth",
  "not_connected",
  "bootstrap_running",
]);
export type BrowserAutomationSiteConnectionState = z.infer<
  typeof browserAutomationSiteConnectionStateSchema
>;

/** A single site entry in `GET /api/browser-automation/sites`. */
export const browserAutomationSiteSummarySchema = z.object({
  siteKey: z.string().min(1).max(64).regex(/^[a-z][a-z0-9_]*$/),
  displayName: z.string().min(1).max(120),
  state: browserAutomationSiteConnectionStateSchema,
  /** Captured display label from the signed-in page (may be null
   *  even when state is `connected` — not every site exposes a stable
   *  identifier in the public DOM). */
  accountLabel: z.string().max(120).nullable(),
  /** Epoch ms of the bootstrap finalize, when connected. */
  connectedAt: z.number().int().nonnegative().nullable(),
  /** Epoch ms of the most recent successful auth-variant workflow run. */
  lastWorkflowAt: z.number().int().nonnegative().nullable(),
  /** Days the daemon will accept the cached cookies before flipping
   *  the state to `needs_reauth`. */
  sessionMaxAgeDays: z.number().int().min(1).max(365),
});
export type BrowserAutomationSiteSummary = z.infer<
  typeof browserAutomationSiteSummarySchema
>;

export const browserAutomationSitesResponseSchema = z.object({
  sites: z.array(browserAutomationSiteSummarySchema).max(64),
});
export type BrowserAutomationSitesResponse = z.infer<
  typeof browserAutomationSitesResponseSchema
>;

/** Polled by the dashboard during the sign-in window. */
export const browserAutomationSiteStatusResponseSchema = z.object({
  siteKey: z.string().min(1).max(64).regex(/^[a-z][a-z0-9_]*$/),
  bootstrapRunning: z.boolean(),
  /** Present only while a bootstrap is running. */
  pid: z.number().int().positive().nullable(),
  deadlineAt: z.number().int().nonnegative().nullable(),
  /** Probe verdict — true once the site's `signedInSelector` resolves
   *  in the bootstrap UI window. Always false when no bootstrap is
   *  running. */
  signedIn: z.boolean(),
  /** Captured label from the probe (null until selector match). */
  accountLabel: z.string().max(120).nullable(),
});
export type BrowserAutomationSiteStatusResponse = z.infer<
  typeof browserAutomationSiteStatusResponseSchema
>;

/** Generic action envelope used by connect / finalize / reauth / disconnect. */
export const browserAutomationSiteActionResponseSchema = z.object({
  ok: z.boolean(),
  siteKey: z.string().min(1).max(64).regex(/^[a-z][a-z0-9_]*$/),
  state: browserAutomationSiteConnectionStateSchema,
  reason: z
    .enum([
      "unknown_site",
      "missing_binary",
      "missing_sandbox",
      "spawn_failed",
      "already_running",
      "not_running",
      "not_signed_in",
      "managed_chromium_disabled",
    ])
    .optional(),
});
export type BrowserAutomationSiteActionResponse = z.infer<
  typeof browserAutomationSiteActionResponseSchema
>;

// ─────────────────────────────────────────────────────────────────────
// Browser Automation Approvals — single-use, 5-min-TTL approval tokens
// gating Phase B-3 write workflows.
// MANAGED_CHROMIUM_IMPLEMENTATION_PLAN.md §10 / §13 steps 43-46.
// ─────────────────────────────────────────────────────────────────────

export const browserAutomationApprovalStatusSchema = z.enum([
  "pending",
  "approved",
  "consumed",
  "denied",
  "expired",
]);
export type BrowserAutomationApprovalStatus = z.infer<
  typeof browserAutomationApprovalStatusSchema
>;

export const browserAutomationApprovalOriginSchema = z.enum([
  "agent",
  "dashboard",
  "schedule",
]);
export type BrowserAutomationApprovalOrigin = z.infer<
  typeof browserAutomationApprovalOriginSchema
>;

/** One row from `browser_automation_approvals`, projected for the
 *  dashboard. `tokenHash` and the raw token are never surfaced — the
 *  dashboard only needs the row's metadata + status. */
export const browserAutomationApprovalRowSchema = z.object({
  id: z.string().regex(/^[a-f0-9-]{36}$/),
  workflowName: z.string().min(1).max(64).regex(/^[a-zA-Z][a-zA-Z0-9_]*$/),
  paramsHash: z.string().min(1).max(64),
  /** JSON snippet of the params object the runner saw, truncated to
   *  8 KB at insertion. Surface-only; the runner re-validates the
   *  caller's params against the workflow's input schema on every
   *  retry, so this field is not load-bearing. */
  paramsSummary: z.string().max(8192),
  status: browserAutomationApprovalStatusSchema,
  origin: browserAutomationApprovalOriginSchema,
  requestedAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().nonnegative(),
  approvedAt: z.number().int().nonnegative().nullable(),
  consumedAt: z.number().int().nonnegative().nullable(),
  deniedAt: z.number().int().nonnegative().nullable(),
  denialReason: z.string().max(200).nullable(),
});
export type BrowserAutomationApprovalRow = z.infer<
  typeof browserAutomationApprovalRowSchema
>;

export const browserAutomationApprovalsListResponseSchema = z.object({
  /** Pending rows the dashboard surfaces with Approve / Deny buttons.
   *  Sorted by `requestedAt` DESC; capped at 64 (a single user is the
   *  only producer, so 64 active pending is enormous). */
  pending: z.array(browserAutomationApprovalRowSchema).max(64),
  /** Recently terminal rows (approved + consumed + denied + expired)
   *  for the dashboard's "recent approvals" audit table. Capped at 50
   *  rows, sorted by terminal timestamp DESC. */
  recent: z.array(browserAutomationApprovalRowSchema).max(50),
});
export type BrowserAutomationApprovalsListResponse = z.infer<
  typeof browserAutomationApprovalsListResponseSchema
>;

/** Response of `POST /api/browser-automation/approvals/:id/approve`.
 *  The minted token is returned ONCE here and never re-readable —
 *  the dashboard renders it inline with a one-time-display banner and
 *  copy button. The user pastes it into the agent prompt or the
 *  dashboard's manual retry form. */
export const browserAutomationApprovalIssueResponseSchema = z.object({
  ok: z.literal(true),
  approval: browserAutomationApprovalRowSchema,
  /** 32 hex chars (128 bits entropy). Returned exactly once; never
   *  fetchable from any later API call. */
  token: browserAutomationApprovalTokenSchema,
});
export type BrowserAutomationApprovalIssueResponse = z.infer<
  typeof browserAutomationApprovalIssueResponseSchema
>;

export const browserAutomationApprovalDenyRequestSchema = z.object({
  reason: z.string().min(1).max(200).optional(),
});
export type BrowserAutomationApprovalDenyRequest = z.infer<
  typeof browserAutomationApprovalDenyRequestSchema
>;

export const browserAutomationApprovalDenyResponseSchema = z.object({
  ok: z.literal(true),
  approval: browserAutomationApprovalRowSchema,
});
export type BrowserAutomationApprovalDenyResponse = z.infer<
  typeof browserAutomationApprovalDenyResponseSchema
>;

// ─────────────────────────────────────────────────────────────────────
// Phase B-3 readiness panel — observation-gate criteria values.
// MANAGED_CHROMIUM_IMPLEMENTATION_PLAN.md §10 (table) + §13 milestone.
// ─────────────────────────────────────────────────────────────────────

export const browserAutomationObservationGateCriterionSchema = z.object({
  /** Slug — stable identifier for the dashboard table row. */
  id: z.enum([
    "absolute_block_hits",
    "compromise_signals",
    "playwright_error_rate",
    "timeout_rate",
    "denylist_hits_per_workflow",
    "reauth_false_positives",
    "user_reported_high_severity",
    "sandbox_refusals",
  ]),
  /** Display label rendered in the panel. */
  label: z.string().min(1).max(120),
  /** Numeric value observed across the 6-week observation window. */
  value: z.number().nonnegative(),
  /** Numeric threshold the value must remain at or under to pass. */
  threshold: z.number().nonnegative(),
  /** Coarse health bucket — green = passing, amber = trending toward
   *  threshold (>= 75% of it), red = exceeded. */
  status: z.enum(["green", "amber", "red"]),
  /** Free-form context (one-liner explaining what the value counts). */
  description: z.string().max(240),
});
export type BrowserAutomationObservationGateCriterion = z.infer<
  typeof browserAutomationObservationGateCriterionSchema
>;

export const browserAutomationObservationGateResponseSchema = z.object({
  /** Window-start epoch ms — the daemon computes 42 days back from now. */
  windowStartedAt: z.number().int().nonnegative(),
  /** Window-end epoch ms — always `now`. */
  windowEndedAt: z.number().int().nonnegative(),
  criteria: z.array(browserAutomationObservationGateCriterionSchema).max(16),
  /** Overall verdict — `green` only when every criterion is green;
   *  `red` if any is red; otherwise `amber`. */
  overall: z.enum(["green", "amber", "red"]),
});
export type BrowserAutomationObservationGateResponse = z.infer<
  typeof browserAutomationObservationGateResponseSchema
>;
