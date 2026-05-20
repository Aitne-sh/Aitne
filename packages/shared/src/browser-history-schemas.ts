import { z } from "zod";

export const browserHistoryBrowserKeySchema = z.enum([
  "chrome",
  "chromium",
  "edge",
  "brave",
  "comet",
  "atlas",
  "safari",
]);
export type BrowserHistoryBrowserKey = z.infer<typeof browserHistoryBrowserKeySchema>;

export const browserHistoryDetectionStatusSchema = z.enum([
  "available",
  "available_no_sync",
  "available_sync_broken",
  "fda_required",
  "permission_denied",
  "not_installed",
  "safari_not_applicable",
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
  quit_after_ingest: z.boolean().default(false),
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
