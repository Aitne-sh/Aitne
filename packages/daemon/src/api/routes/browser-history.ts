import { Hono } from "hono";
import {
  browserHistoryAcceptOfferRequestSchema,
  browserHistoryAcceptOfferResponseSchema,
  browserHistoryClusterDeltaResponseSchema,
  browserHistoryClusterDetailSchema,
  browserHistoryPendingOffersResponseSchema,
  browserHistoryStatusResponseSchema,
  browserHistoryResearchClustersResponseSchema,
  browserHistoryWikiWrittenResponseSchema,
  browserReloadsTodayResponseSchema,
  browserReloadsWeeklyResponseSchema,
  browserShoppingDateResponseSchema,
  cleanupInterestsReflectionRequestSchema,
  cleanupInterestsReflectionResponseSchema,
  getAgentDayDateStr,
  preMorningDigestSchema,
  refreshInterestsReflectionResponseSchema,
  weeklyInterestsSummaryResponseSchema,
  yesterdayResearchSummarySchema,
} from "@aitne/shared";
import type { ApiDependencies } from "../server.js";
import {
  clearClusterOfferStamps,
  deletePendingOffersForCluster,
  getResearchClusterDetail,
  getYesterdayResearchSummary,
  listBrowserResearchClusters,
  listClusterDailyDeltas,
  listPendingOffersWithDisplay,
  listReloadsForDate,
  listReloadsForRange,
  listShoppingSessionsForDate,
  listTopDomainsForCluster,
  readBrowserHistoryCapabilities,
  readBrowserHistoryLastIngestAt,
  readBrowserLifecycleState,
  setResearchClusterStatus,
  stampClusterDmFields,
  writeBrowserHistoryCapabilities,
} from "../../db/browser-history-store.js";
import { createHostProfile } from "../../services/browser-history/lifecycle/platform.js";
import { detectBrowserHistoryCapabilities } from "../../services/browser-history/detectors/registry.js";
import { createResearchCommandEvent } from "../../core/browser-history/research-events.js";
import { readPreMorningDigestJsonForDate } from "../../core/browser-history/pre-morning-digest-job.js";
import { buildPreMorningDigest } from "../../services/browser-history/pipeline/pre-morning-digest.js";
import { buildWeeklyInterestsSummary } from "../../services/browser-history/pipeline/weekly-interests-summary.js";
import { loadProjectKeywords } from "../../services/browser-history/pipeline/project-matcher.js";
import { cleanupInterestsReflection } from "../../services/browser-history/cleanup-interests-reflection.js";
import { InterestsReflectionLockBusyError } from "../../services/browser-history/interests-reflection-lock.js";
import { refreshInterestsReflection } from "../../services/browser-history/refresh-interests-reflection.js";
import { getContextDir } from "../../config.js";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const CLUSTER_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,118}[a-z0-9]$/;

function agentDayBoundary(deps: ApiDependencies) {
  return {
    timezone: deps.config.timezone || undefined,
    dayBoundaryHour: deps.config.dayBoundaryHour ?? 4,
  };
}

function todayKey(deps: ApiDependencies): string {
  const b = agentDayBoundary(deps);
  return getAgentDayDateStr(b.timezone, b.dayBoundaryHour, new Date());
}

function yesterdayKey(deps: ApiDependencies): string {
  const b = agentDayBoundary(deps);
  return getAgentDayDateStr(
    b.timezone,
    b.dayBoundaryHour,
    new Date(Date.now() - 24 * 60 * 60 * 1000),
  );
}

function parseDateParam(
  value: string | undefined,
  fallback: () => string,
): string {
  if (value && DATE_PATTERN.test(value)) return value;
  return fallback();
}

function addDays(dateStr: string, deltaDays: number): string {
  const ms = Date.parse(`${dateStr}T00:00:00Z`);
  return new Date(ms + deltaDays * 86_400_000).toISOString().slice(0, 10);
}

export function createBrowserHistoryRoutes(deps: ApiDependencies): Hono {
  const app = new Hono();

  app.get("/browser-history/status", (c) => {
    const payload = browserHistoryStatusResponseSchema.parse({
      capabilities: readBrowserHistoryCapabilities(deps.db),
      lifecycle: readBrowserLifecycleState(deps.db),
      lastIngestAt: readBrowserHistoryLastIngestAt(deps.db),
    });
    return c.json(payload);
  });

  app.get("/browser-history/research-clusters", (c) => {
    return c.json(
      browserHistoryResearchClustersResponseSchema.parse(
        listBrowserResearchClusters(deps.db),
      ),
    );
  });

  // §9 — single-cluster detail. No per-visit data; the response is the
  // bounded `BrowserHistoryClusterDetail` shape Zod-validates against
  // a domain-label regex (`^[a-z0-9.-]+$`) and length-capped strings.
  app.get("/browser-history/research-clusters/:slug/delta", (c) => {
    const slug = c.req.param("slug");
    if (!CLUSTER_SLUG_PATTERN.test(slug)) {
      return c.json({ error: "invalid_slug" }, 400);
    }
    const detail = getResearchClusterDetail(deps.db, slug);
    if (!detail) {
      return c.json({ error: "not_found" }, 404);
    }
    const days = listClusterDailyDeltas(
      deps.db,
      detail.rootTaskId,
      agentDayBoundary(deps),
      { dayLimit: 31 },
    );
    // RESEARCH_CLUSTER_COST_FIX_PLAN rev5 — stamp each bucket with
    // whether its agent day has ended. The current agent day's bucket is
    // still accumulating (a day-boundary or wake-catch-up run fires
    // mid-day, so the bucket only covers visits up to "now"); consumers
    // that persist day entries (the append-only research journal) must
    // skip incomplete buckets or they freeze an undercounted day forever.
    // ISO agent-day strings compare lexically = chronologically.
    const today = todayKey(deps);
    return c.json(
      browserHistoryClusterDeltaResponseSchema.parse({
        slug,
        generatedAt: new Date().toISOString(),
        days: days.map((day) => ({ ...day, complete: day.date < today })),
      }),
    );
  });

  app.get("/browser-history/research-clusters/:slug", (c) => {
    const slug = c.req.param("slug");
    if (!CLUSTER_SLUG_PATTERN.test(slug)) {
      return c.json({ error: "invalid_slug" }, 400);
    }
    const detail = getResearchClusterDetail(deps.db, slug);
    if (!detail) {
      return c.json({ error: "not_found" }, 404);
    }
    const topDomains = listTopDomainsForCluster(deps.db, detail.rootTaskId, 10);
    return c.json(
      browserHistoryClusterDetailSchema.parse({
        slug: detail.slug,
        displayName: detail.displayName,
        startedAt: detail.startedAt,
        lastActivityAt: detail.lastActivityAt,
        visitsTotal: detail.visitsTotal,
        meaningfulVisitsTotal: detail.meaningfulVisitsTotal,
        meaningfulForegroundSecTotal: detail.meaningfulForegroundSecTotal,
        distinctMeaningfulDomains: detail.distinctMeaningfulDomains,
        status: detail.status,
        agentSummaryRevision: detail.agentSummaryRevision,
        rootTaskId: detail.rootTaskId,
        topDomains,
        lastDmAt: detail.lastDmAt,
        lastResearchOfferAt: detail.lastResearchOfferAt,
        lastWikiOfferAt: detail.lastWikiOfferAt,
        researchOfferAcceptedAt: detail.researchOfferAcceptedAt,
        wikiSummaryWrittenAt: detail.wikiSummaryWrittenAt,
      }),
    );
  });

  // §9 — open-offer surfaces. `/offers/pending` is the read; the three
  // POSTs mutate cluster + pending-offer rows. Accept queues the
  // corresponding process key event through the EventBus; without an
  // EventBus injected (test harness, daemon early boot) the handler
  // returns enqueued=false and the row stamp does not advance, so the
  // operator can retry once the daemon's messaging is up.
  app.get("/browser-history/offers/pending", (c) => {
    const offers = listPendingOffersWithDisplay(deps.db);
    return c.json(
      browserHistoryPendingOffersResponseSchema.parse({
        offers,
        generatedAt: new Date().toISOString(),
      }),
    );
  });

  app.post("/browser-history/offers/:slug/accept", async (c) => {
    const slug = c.req.param("slug");
    if (!CLUSTER_SLUG_PATTERN.test(slug)) {
      return c.json({ error: "invalid_slug" }, 400);
    }
    const body = await c.req.json().catch(() => null);
    const parsed = browserHistoryAcceptOfferRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "invalid_body" }, 400);
    }
    const detail = getResearchClusterDetail(deps.db, slug);
    if (!detail) {
      return c.json({ error: "not_found" }, 404);
    }
    const processKey =
      parsed.data.kind === "research_assist"
        ? "routine.research_dispatch"
        : "routine.research_wiki_summary";

    // Enqueue first, then stamp. Reverse ordering used to leak state:
    // when the EventBus was not wired (boot window, test harness) the
    // route advanced cluster columns + deleted the pending offer but no
    // agent session ever ran, so the operator's accept silently dropped.
    //
    // `wikiSummaryWrittenAt` is NOT stamped here — that column is the
    // agent's "wiki note already exists" gate (see
    // `agent-assets/task-flows/routine.research_wiki_summary.md` step 3).
    // Pre-stamping it on acceptance made the agent skip the very write
    // the operator just asked for; the pending-offer deletion plus the
    // 14-day re-fire gate on `lastWikiOfferAt` are the right guards.
    let enqueued = false;
    if (deps.eventBus) {
      await deps.eventBus.put(
        createResearchCommandEvent({
          processKey,
          slug,
        }),
      );
      enqueued = true;
    }
    if (enqueued) {
      const now = Date.now();
      if (parsed.data.kind === "research_assist") {
        stampClusterDmFields(deps.db, slug, {
          researchOfferAcceptedAt: now,
        });
      } else {
        // wiki_summary acceptance has no permanent "accepted" stamp on
        // the cluster row — `wikiSummaryWrittenAt` is reserved for the
        // agent to stamp after a successful write (task-flow step 6
        // calls /wiki-written). Clearing `lastWikiOfferAt` here closes
        // the rate-limit gate's decline_backoff path: that gate trips
        // when BOTH options' lastXxxOfferAt are set AND neither was
        // accepted within 30d. Without this clear, accepting wiki via
        // the two-option offer + a wiki write that fails (or the agent
        // forgets /wiki-written) would falsely look like "user ignored
        // both options" → 30d cluster silence despite active engagement.
        // The 7-day per-cluster `dmBudgetMs` still bounds re-firing;
        // the wiki re-fire window resets only after the next offer
        // fires and writes a fresh `lastWikiOfferAt`.
        clearClusterOfferStamps(deps.db, slug, { lastWikiOfferAt: true });
      }
      // BROWSER_HISTORY_INTEGRATION_PLAN seventh-pass — clear ALL
      // pending rows for the slug. The poller may have inserted
      // kind='offered' (two-option flow) instead of a kind-specific
      // row, so deleting only `parsed.data.kind` would orphan the
      // open offer and silence the cluster for the 14-day TTL.
      // Acceptance closes the entire offer cycle for this cluster
      // — both options are off the table until the next fire.
      deletePendingOffersForCluster(deps.db, slug);
    }
    return c.json(
      browserHistoryAcceptOfferResponseSchema.parse({
        slug,
        kind: parsed.data.kind,
        processKey,
        enqueued,
      }),
    );
  });

  app.post("/browser-history/offers/:slug/decline", (c) => {
    const slug = c.req.param("slug");
    if (!CLUSTER_SLUG_PATTERN.test(slug)) {
      return c.json({ error: "invalid_slug" }, 400);
    }
    const now = Date.now();
    // Decline = mark both offer types as recently "offered" so the
    // 14-day re-fire gate inside the trigger evaluator suppresses
    // re-emission. Pending-offer rows are deleted to clear the
    // morning-digest surface immediately.
    stampClusterDmFields(deps.db, slug, {
      lastResearchOfferAt: now,
      lastWikiOfferAt: now,
    });
    const cleared = deletePendingOffersForCluster(deps.db, slug);
    return c.json({ slug, cleared });
  });

  // §10.6 — agent write-back. Called by `routine.research_wiki_summary`
  // after a successful Obsidian / Notion / local-context write so the
  // cluster row's `wikiSummaryWrittenAt` advances. Pre-stamping at
  // acceptance time would short-circuit the agent's "wiki already
  // exists" materiality check (task-flow step 3); only the agent knows
  // when the write actually landed.
  app.post(
    "/browser-history/research-clusters/:slug/wiki-written",
    (c) => {
      const slug = c.req.param("slug");
      if (!CLUSTER_SLUG_PATTERN.test(slug)) {
        return c.json({ error: "invalid_slug" }, 400);
      }
      const detail = getResearchClusterDetail(deps.db, slug);
      if (!detail) {
        return c.json({ error: "not_found" }, 404);
      }
      const now = Date.now();
      stampClusterDmFields(deps.db, slug, { wikiSummaryWrittenAt: now });
      return c.json(
        browserHistoryWikiWrittenResponseSchema.parse({
          slug,
          wikiSummaryWrittenAt: now,
        }),
      );
    },
  );

  app.post("/browser-history/offers/:slug/mute", (c) => {
    const slug = c.req.param("slug");
    if (!CLUSTER_SLUG_PATTERN.test(slug)) {
      return c.json({ error: "invalid_slug" }, 400);
    }
    const updated = setResearchClusterStatus(deps.db, slug, "muted");
    if (!updated) {
      return c.json({ error: "not_found" }, 404);
    }
    const cleared = deletePendingOffersForCluster(deps.db, slug);
    return c.json({ slug, cleared, status: "muted" as const });
  });

  app.get("/browser-history/yesterday-summary", (c) => {
    const date = parseDateParam(c.req.query("date"), () => yesterdayKey(deps));
    return c.json(
      yesterdayResearchSummarySchema.parse(
        getYesterdayResearchSummary(date),
      ),
    );
  });

  // BROWSER_HISTORY_INTEGRATION_PLAN §5.F2 P4a — pre-morning digest
  // JSON endpoint. Primary surface is the markdown file written at
  // `dayBoundaryHour − 1` (`context/browser/yesterday-<date>.md`); this
  // endpoint is the typed fallback for callers that want the
  // Zod-validated shape or for days where the cron did not fire
  // (daemon stopped at 03:00, fresh install, sidecar purged).
  //
  // Strategy:
  //   1. Try the JSON sidecar — Zod-validated on read. Cheap, exact
  //      same bytes the journal saw if the cron ran.
  //   2. Sidecar missing / corrupt → rebuild fresh from the DB. The
  //      digest builder is deterministic and cheap, so a stale request
  //      cannot cause a thundering-herd problem.
  //
  // The handler does NOT write the rebuilt digest back to disk — that
  // would make the API a side-effect-ful path, and the cron's job is
  // to own the file. If the operator wants a fresh file, they can
  // re-run the digest job from the dashboard's manual-trigger surface
  // (future work; not part of P4a).
  app.get("/browser-history/pre-morning-digest/:date", (c) => {
    const requested = c.req.param("date");
    if (!DATE_PATTERN.test(requested)) {
      return c.json({ error: "invalid_date" }, 400);
    }
    // DATE_PATTERN only checks digit-shape, so a calendar-invalid value like
    // "2026-13-99" passes it. Unlike the sibling date endpoints (shopping /
    // reloads), this route does date arithmetic — buildPreMorningDigest →
    // getAgentDayBoundsUtc → formatSqliteDatetime calls `new Date(NaN).toISOString()`,
    // which throws RangeError and surfaces as a 500. Reject the inputs that would
    // produce an Invalid Date here so the documented `400 invalid_date` contract
    // holds. (Matches the `Number.isFinite(Date.parse(...))` guard idiom used in
    // observations.ts / integrations-reconcile.ts.)
    if (!Number.isFinite(Date.parse(`${requested}T12:00:00Z`))) {
      return c.json({ error: "invalid_date" }, 400);
    }
    const contextDir = getContextDir(deps.config, deps.db);
    const sidecar = readPreMorningDigestJsonForDate(contextDir, requested);
    if (sidecar && sidecar.date === requested) {
      return c.json(preMorningDigestSchema.parse(sidecar));
    }
    // Rebuild fresh — pass the requested date through as "the digest's
    // agent-day" so the window math doesn't drift onto whatever
    // agent-day the request happens to land in. Uses the pure builder
    // directly (not the file-writing job) — the route must never
    // produce a file as a side effect of a GET. `agentDayBoundary`
    // reuses the same timezone + dayBoundaryHour resolution every
    // other route in this file applies, so the rebuild window matches
    // what the cron writes.
    const digest = buildPreMorningDigest({
      db: deps.db,
      date: requested,
      boundary: agentDayBoundary(deps),
    });
    return c.json(preMorningDigestSchema.parse(digest));
  });

  app.get("/browser-history/shopping/:date", (c) => {
    const requested = c.req.param("date");
    if (!DATE_PATTERN.test(requested)) {
      return c.json({ error: "invalid_date" }, 400);
    }
    const rows = listShoppingSessionsForDate(deps.db, requested);
    const sessions = rows
      .filter((row) => row.asins.length > 0)
      .map((row) => ({
        date: row.date,
        vendor: row.vendor,
        asins: row.asins,
        comparisonMinutes: row.comparisonMinutes,
        locale: row.locale,
      }));
    return c.json(
      browserShoppingDateResponseSchema.parse({
        date: requested,
        sessions,
      }),
    );
  });

  app.get("/browser-history/reloads/today", (c) => {
    const date = parseDateParam(c.req.query("date"), () => todayKey(deps));
    const entries = listReloadsForDate(deps.db, date);
    return c.json(
      browserReloadsTodayResponseSchema.parse({ date, entries }),
    );
  });

  app.get("/browser-history/reloads/weekly", (c) => {
    const rangeEnd = parseDateParam(c.req.query("end"), () => todayKey(deps));
    const rangeStart = parseDateParam(c.req.query("start"), () =>
      addDays(rangeEnd, -6),
    );
    const entries = listReloadsForRange(deps.db, rangeStart, rangeEnd);
    return c.json(
      browserReloadsWeeklyResponseSchema.parse({
        rangeStart,
        rangeEnd,
        entries,
      }),
    );
  });

  // ── WEEKLY_INTERESTS_REFLECTION_PLAN.md §10.2 / §10.3 / §10.3.1 ──
  // Three thin wrappers over the pure daemon helpers. The scheduler
  // pre-hook in `dispatcher-scheduled-tasks.ts` invokes the same
  // helpers via direct function call; these routes are dashboard-only
  // surfaces (Approve tier — see `risk-classifier.ts`). No skill
  // manifest includes them, so an LLM session cannot reach them.
  app.get("/browser-history/weekly-interests-summary", (c) => {
    const weekStart = c.req.query("weekStart");
    if (!weekStart || !DATE_PATTERN.test(weekStart)) {
      return c.json({ error: "invalid_weekStart" }, 400);
    }
    // §10.2 — weekStart must be an ISO Monday. Anchor at noon UTC so a
    // DST flip cannot move the parsed date into Sunday or Tuesday.
    const anchor = Date.parse(`${weekStart}T12:00:00Z`);
    if (Number.isNaN(anchor) || new Date(anchor).getUTCDay() !== 1) {
      return c.json({ error: "weekStart_must_be_monday" }, 400);
    }
    // Load project keywords so `projectMatches` is populated per §10.1.
    // Without this the builder's `if (options.projectKeywords)` gate
    // short-circuits and every response carries an empty list — a
    // spec drift that hides the project-overlap signal a dashboard
    // consumer is meant to see.
    const contextDir = getContextDir(deps.config, deps.db);
    const projectKeywords = loadProjectKeywords(contextDir);
    const summary = buildWeeklyInterestsSummary(deps.db, weekStart, {
      boundary: agentDayBoundary(deps),
      projectKeywords,
    });
    // Convert the daemon-internal absolute `projectPath` to the
    // `projects/<slug>.md` form §10.1 documents. Exposing the absolute
    // path would leak the daemon's PA_DATA_DIR layout to the dashboard
    // (and any future external consumer of this Autonomous-tier route).
    const projected = {
      ...summary,
      projectMatches: summary.projectMatches.map((match) => ({
        ...match,
        projectPath: `plans/projects/${match.projectSlug}.md`,
      })),
    };
    return c.json(weeklyInterestsSummaryResponseSchema.parse(projected));
  });

  app.post("/browser-history/refresh-interests-reflection", (c) => {
    const contextDir = getContextDir(deps.config, deps.db);
    try {
      const result = refreshInterestsReflection(deps.db, contextDir, {
        trigger: "dashboard",
        boundary: agentDayBoundary(deps),
        // Pre-mark the daemon's writes so FS-watch consumers attribute
        // them to the agent (same threading as the scheduler pre-hook in
        // `dispatcher-scheduled-tasks.ts:runWeeklyInterestsReflectionPreHook`).
        writeTracker: deps.writeTracker,
      });
      return c.json(refreshInterestsReflectionResponseSchema.parse(result));
    } catch (err) {
      // rev 4 — lock contention is a documented, expected failure mode
      // when the scheduler pre-hook is mid-flight as the operator
      // clicks "Refresh now". 409 (Conflict) signals "try again in a
      // moment" to the dashboard, which is correct here — the next
      // call will succeed once the in-flight run releases.
      if (err instanceof InterestsReflectionLockBusyError) {
        return c.json(
          { error: "reflection_in_progress", heldBy: err.heldBy },
          409,
        );
      }
      throw err;
    }
  });

  app.post("/browser-history/cleanup-interests-reflection", async (c) => {
    const raw = await c.req.json().catch(() => ({}));
    const parsed = cleanupInterestsReflectionRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: "invalid_body" }, 400);
    }
    const contextDir = getContextDir(deps.config, deps.db);
    try {
      const result = cleanupInterestsReflection(deps.db, contextDir, {
        alsoDeleteResearchThemesFile: parsed.data.alsoDeleteResearchThemesFile,
        trigger: "dashboard",
        writeTracker: deps.writeTracker,
      });
      return c.json(cleanupInterestsReflectionResponseSchema.parse(result));
    } catch (err) {
      if (err instanceof InterestsReflectionLockBusyError) {
        return c.json(
          { error: "reflection_in_progress", heldBy: err.heldBy },
          409,
        );
      }
      throw err;
    }
  });

  app.post("/setup/redetect-browsers", async (c) => {
    const { capabilities } = await detectBrowserHistoryCapabilities({
      db: deps.db,
      config: deps.config,
      host: createHostProfile(),
    });
    writeBrowserHistoryCapabilities(deps.db, capabilities);
    return c.json({ capabilities });
  });

  return app;
}
