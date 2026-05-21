import type Database from "better-sqlite3";
import { getAgentDayDateStr } from "@aitne/shared";
import type { Observer } from "./manager.js";
import type { AgentConfig } from "../config.js";
import { createLogger } from "../logging.js";
import {
  detectBrowserHistoryCapabilities,
  browserHistoryCacheRoot,
} from "../services/browser-history/detectors/registry.js";
import { createHostProfile } from "../services/browser-history/lifecycle/platform.js";
import type {
  BrowserDetectionResult,
  BrowserProfileCandidate,
  HostProfile,
} from "../services/browser-history/types.js";
import {
  createBrowserHistorySnapshot,
} from "../services/browser-history/readers/snapshot.js";
import { readChromiumVisits } from "../services/browser-history/readers/chromium-reader.js";
import { summarizeVisits } from "../services/browser-history/pipeline/summarizer.js";
import { extractClustersFromDb } from "../services/browser-history/pipeline/cluster-extractor.js";
import {
  applyBrowserHistoryRetention,
  incrementReloadSignals,
  insertBrowserVisits,
  listPendingOffersForCluster,
  readBrowserHistoryIngestCursor,
  replaceShoppingSessions,
  stampClusterDmFields,
  upsertPendingOffer,
  upsertResearchClusters,
  writeBrowserHistoryIngestCursor,
  writeBrowserHistoryLastIngestAt,
  OFFER_DEFAULT_TTL_MS,
} from "../db/browser-history-store.js";
import {
  buildEngagementSnapshot,
  listActiveClustersForEngagement,
} from "../services/browser-history/pipeline/cluster-extractor.js";
import {
  DEFAULT_OFFER_THRESHOLDS,
  evaluateOfferTriggers,
  type OfferTriggerDecision,
} from "../services/browser-history/pipeline/offer-triggers.js";
import {
  DEFAULT_OFFER_RATE_LIMIT_CONFIG,
  gateOfferRateLimit,
  type OfferRateLimitConfig,
} from "../services/browser-history/pipeline/offer-rate-limit.js";
import { createResearchCommandEvent } from "../core/browser-history/research-events.js";
import type { Event } from "@aitne/shared";
import { PollGuard } from "./poll-guard.js";

const logger = createLogger("browser-history-poller");

const DEFAULT_INGEST_INTERVAL_MINUTES = 30;
const VISIT_BATCH_LIMIT = 5_000;
const TICK_TIMEOUT_MS = 5 * 60 * 1000;
export const SHOPPING_COMPARISON_MIN_ASINS = 3;
export const SHOPPING_COMPARISON_WINDOW_MS = 90 * 60 * 1000;
const SHOPPING_LOOKBACK_MS = 7 * 86_400_000;

export interface ShoppingVisitPoint {
  ts: number;
  asin: string;
}

export interface ShoppingWindowSession {
  asins: string[];
  firstMs: number;
  lastMs: number;
}

/**
 * Greedy sliding 90-min window over ASIN visits in time order. Each
 * emission is the maximal extension that still contains ≥3 distinct
 * ASINs; advancing past the emitted window prevents overlapping
 * duplicates while still surfacing distinct morning/evening bursts as
 * separate sessions. Pure function — caller buckets by day+locale.
 */
export function detectShoppingSessions(
  visits: readonly ShoppingVisitPoint[],
  windowMs: number = SHOPPING_COMPARISON_WINDOW_MS,
  minAsins: number = SHOPPING_COMPARISON_MIN_ASINS,
): ShoppingWindowSession[] {
  const out: ShoppingWindowSession[] = [];
  if (visits.length < minAsins) return out;
  let left = 0;
  const distinct = new Map<string, number>();
  while (left < visits.length) {
    distinct.clear();
    let right = left;
    let lastInWindow = left;
    while (right < visits.length
      && visits[right].ts - visits[left].ts <= windowMs) {
      distinct.set(visits[right].asin, (distinct.get(visits[right].asin) ?? 0) + 1);
      lastInWindow = right;
      right += 1;
    }
    if (distinct.size >= minAsins) {
      out.push({
        asins: [...distinct.keys()],
        firstMs: visits[left].ts,
        lastMs: visits[lastInWindow].ts,
      });
      left = lastInWindow + 1;
    } else {
      left += 1;
    }
  }
  return out;
}

/**
 * BrowserHistoryPoller — P2 Layer 1 runner.
 *
 * On a fixed cadence the poller:
 *   1. Re-detects browser capabilities (cheap; just confirms profiles still
 *      resolve and consent is still granted).
 *   2. For each ingest-enabled Chromium profile, snapshots the live
 *      `History` SQLite, reads visits newer than the persisted cursor,
 *      and runs the deterministic pipeline (redactor → classifier →
 *      meaningful-filter → amazon-extractor → reload-detector) before
 *      writing normalized rows into `browser_visits` and aggregating
 *      reload counts.
 *   3. Recomputes research clusters from `browser_visits` and upserts
 *      `browser_research_clusters`.
 *   4. Materialises shopping sessions (Amazon-only at MVP) for the
 *      yesterday/today day boundaries that intersect the new visits.
 *   5. Enforces row + search-query retention.
 *
 * There is no LLM in this loop. The poller cooperates with the lifecycle
 * supervisor: the supervisor keeps the browser running so the History DB
 * is fresh; the poller reads from it.
 */
export interface BrowserHistoryPollerOptions {
  host?: HostProfile;
  intervalMinutes?: number;
  /**
   * BROWSER_HISTORY_INTEGRATION_PLAN §5.F1 (seventh-pass) — replaces
   * the previous `notifyOwner` callback. When the per-cluster qualifier
   * AND the rate-limit gate both say "fire", the poller enqueues a
   * `routine.research_offer_dm` event onto this EventBus. The
   * subsequent agent session reads the OfferContext payload from
   * `event.data`, composes the natural-language two-option DM, and
   * sends it via the standard notifier path (which records the
   * outbound into the owner DM conversation_sessions so the DM agent
   * sees it on the user's reply turn — §10.5 invariant). When absent
   * (test fixtures, daemon early-boot), the poller still computes
   * candidates but skips the enqueue without advancing `last_dm_at`,
   * so the offer is retried the next cycle once the bus is up.
   */
  enqueueEvent?: (event: Event) => Promise<void>;
  /** Optional rate-limit config override for tests. */
  rateLimitConfig?: OfferRateLimitConfig;
}

export class BrowserHistoryPoller implements Observer {
  readonly name = "browser-history-poller";

  private timer: ReturnType<typeof setInterval> | null = null;
  private host: HostProfile;
  private readonly intervalMinutes: number;
  private readonly enqueueEvent?: (event: Event) => Promise<void>;
  private readonly rateLimitConfig: OfferRateLimitConfig;
  private readonly guard = new PollGuard({
    name: this.name,
    tickTimeoutMs: TICK_TIMEOUT_MS,
  });

  constructor(
    private readonly db: Database.Database,
    private readonly config: AgentConfig,
    options: BrowserHistoryPollerOptions = {},
  ) {
    this.host = options.host ?? createHostProfile();
    this.intervalMinutes = options.intervalMinutes ?? DEFAULT_INGEST_INTERVAL_MINUTES;
    this.enqueueEvent = options.enqueueEvent;
    this.rateLimitConfig =
      options.rateLimitConfig ?? this.deriveRateLimitConfig();
  }

  /**
   * Build the offer rate-limit config from AgentConfig at construction
   * time. Quiet-hours + timezone are read from the daemon config; the
   * cap / interval / decline-backoff / active-conversation values are
   * the seventh-pass design defaults (2/day, 4h, 30d, 30min). Pulled
   * into a method so tests can override via `rateLimitConfig` while
   * production picks up the per-install timezone automatically.
   */
  private deriveRateLimitConfig(): OfferRateLimitConfig {
    return {
      ...DEFAULT_OFFER_RATE_LIMIT_CONFIG,
      quietHoursStart: this.config.quietHoursStart ?? null,
      quietHoursEnd: this.config.quietHoursEnd ?? null,
      timezone: this.config.timezone || "UTC",
    };
  }

  private boundary() {
    return {
      timezone: this.config.timezone || undefined,
      dayBoundaryHour: this.config.dayBoundaryHour,
    };
  }

  private agentDayKey(tsMs: number): string {
    const b = this.boundary();
    return getAgentDayDateStr(b.timezone, b.dayBoundaryHour, new Date(tsMs));
  }

  async start(): Promise<void> {
    await this.tick();
    this.timer = setInterval(
      () => void this.tick(),
      Math.max(1, this.intervalMinutes) * 60 * 1000,
    );
    this.timer.unref?.();
    logger.info(
      { intervalMinutes: this.intervalMinutes },
      "Browser history poller started",
    );
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.guard.abortInFlight(new Error("browser_history_poller_stopped"));
    logger.info("Browser history poller stopped");
  }

  private async tick(): Promise<void> {
    try {
      await this.guard.run(async (signal) => {
        await this.runIngestCycle(signal);
      });
    } catch (err) {
      logger.error({ err }, "Browser history poller tick failed");
    }
  }

  private async runIngestCycle(signal: AbortSignal): Promise<void> {
    const { capabilities, results } = await detectBrowserHistoryCapabilities({
      db: this.db,
      config: this.config,
      host: this.host,
    });
    if (signal.aborted) return;
    if (capabilities.ingestEnabled.length === 0) return;

    let totalInserted = 0;
    let totalDuplicates = 0;
    for (const browser of capabilities.ingestEnabled) {
      if (signal.aborted) return;
      const result = results.find((entry) => entry.browser === browser);
      if (!result) continue;
      const profiles = this.profilesForBrowser(result);
      for (const profile of profiles) {
        if (signal.aborted) return;
        const ingest = await this.ingestProfile(profile);
        totalInserted += ingest.inserted;
        totalDuplicates += ingest.duplicates;
      }
    }

    if (signal.aborted) return;
    if (totalInserted > 0) {
      upsertResearchClusters(
        this.db,
        extractClustersFromDb(this.db, this.boundary()),
      );
      this.refreshShoppingSessions();
    }

    applyBrowserHistoryRetention(this.db, {
      visitRetentionDays: this.config.browserHistoryRetentionDays,
      searchQueryRetentionDays:
        this.config.browserHistorySearchQueryRetentionDays,
    });

    if (totalInserted > 0) {
      writeBrowserHistoryLastIngestAt(this.db, Date.now());
      await this.evaluateAndFireOfferTriggers();
    }
    logger.info(
      { totalInserted, totalDuplicates },
      "Browser history poller cycle complete",
    );
  }

  /**
   * Walk every active cluster, build its engagement snapshot, evaluate
   * the offer-trigger ladder, and fire whichever trigger wins. Always
   * runs AFTER `upsertResearchClusters` so the freshly-upserted row
   * (with new `last_activity_at`) feeds the budget gate.
   *
   * Dispatch order: DM first (via `notifyOwner`), then stamp the row
   * and write the pending-offer ledger row. If the DM throws, the row
   * is left untouched so the next cycle retries — at worst a duplicate
   * DM lands, never a silent suppression. The DM budget gate
   * (`dmBudgetMs`) keeps duplicates bounded.
   */
  private async evaluateAndFireOfferTriggers(): Promise<void> {
    if (!this.enqueueEvent) {
      logger.debug(
        "enqueueEvent not wired; skipping offer-trigger evaluation",
      );
      return;
    }
    const nowMs = Date.now();
    const clusters = listActiveClustersForEngagement(this.db);
    for (const row of clusters) {
      const snapshot = buildEngagementSnapshot(
        this.db,
        row,
        this.boundary(),
        nowMs,
      );
      if (!snapshot) continue;
      const decision = evaluateOfferTriggers(
        snapshot,
        nowMs,
        DEFAULT_OFFER_THRESHOLDS,
      );
      if (!decision) continue;
      // Skip if an open `'offered'` row already exists for this
      // cluster — the per-cluster qualifier inside
      // `evaluateOfferTriggers` is wall-clock-based on `last_dm_at`;
      // the pending-offer ledger is the second source of truth that
      // mutates on accept/decline. Both gates must say "go" before
      // we re-fire.
      const open = listPendingOffersForCluster(this.db, row.slug, nowMs);
      if (open.length > 0) continue;

      // BROWSER_HISTORY_INTEGRATION_PLAN §5.F1 (seventh-pass) —
      // global rate-limit gate. Layered ON TOP OF the per-cluster
      // gate above; both must pass. Skip reasons get an audit row
      // so the operator can see why offers were suppressed (e.g.
      // "quiet_hours suppressed 3 candidate offers last night").
      const gate = gateOfferRateLimit(
        this.db,
        row.slug,
        nowMs,
        this.rateLimitConfig,
      );
      if (gate.decision === "skip") {
        this.logRateLimitSkip(row.slug, gate.reason);
        continue;
      }
      await this.fireDecision(row.slug, decision, nowMs);
    }
  }

  private async fireDecision(
    slug: string,
    decision: OfferTriggerDecision,
    nowMs: number,
  ): Promise<void> {
    if (!this.enqueueEvent) return; // defensive; caller already checked.

    // Stamp BEFORE enqueue so the rate-limit gate sees the new fire
    // immediately if a second cluster is also eligible in this tick.
    // The enqueue is async + downstream-routed; without the up-front
    // stamp two clusters could both pass the daily-cap check.
    stampClusterDmFields(this.db, slug, {
      lastDmAt: decision.stamp.dm ? nowMs : null,
      lastResearchOfferAt: decision.stamp.researchOffer ? nowMs : null,
      lastWikiOfferAt: decision.stamp.wikiOffer ? nowMs : null,
    });
    upsertPendingOffer(this.db, {
      slug,
      kind: decision.pendingOfferKind,
      offeredAt: nowMs,
      expiresAt: nowMs + OFFER_DEFAULT_TTL_MS,
    });

    // The offer DM agent reads the OfferContext fields from
    // `event.data` directly (displayName, signals, daysActive, etc.).
    // We spread the context into event.data so the task-flow can
    // reference `event.data.displayName` etc. — nesting under
    // `event.data.offerContext` would force the LLM to learn an
    // extra namespace for no benefit.
    //
    // `reply_target` is intentionally absent — the offer DM is
    // unsolicited (poller-driven, not a user reply), so it routes
    // through the proactive forward path. The standard notifier
    // records the outbound into the owner DM scope via
    // `recordProactiveForwardDeliveries` (notification-manager.ts:504),
    // satisfying the §10.5 conversation-injection invariant.
    //
    // The factory adds `slug` at the top level; OfferContext also
    // carries a `slug` field — they're the same value (both come
    // from the cluster row), so the duplicate-key overwrite is a
    // no-op.
    const event = createResearchCommandEvent({
      processKey: "routine.research_offer_dm",
      slug,
      data: { ...decision.context },
    });
    try {
      await this.enqueueEvent(event);
    } catch (err) {
      // The fire-state is already stamped, so a retry on the next tick
      // would be blocked by the rate-limit gate (lastDmAt is set). We
      // log loudly so the operator can investigate; without this branch
      // the operator would see a stamped offer with no DM.
      logger.error(
        { err, slug, kind: decision.kind },
        "Failed to enqueue routine.research_offer_dm event after stamping; the offer is in a half-fired state. Manual cleanup may be needed.",
      );
      return;
    }
    logger.info(
      {
        slug,
        kind: decision.kind,
        assistEligible: decision.context.signals.assist_eligible,
        wikiEligible: decision.context.signals.wiki_eligible,
        day3: decision.context.signals.day_3_first_mention,
        stall48h: decision.context.signals.stall_48h,
        phaseShift: decision.context.signals.phase_shift,
      },
      "Browser-history offer trigger fired — routine.research_offer_dm enqueued",
    );
  }

  private logRateLimitSkip(slug: string, reason: string): void {
    try {
      this.db
        .prepare(
          `INSERT INTO agent_actions (action_type, result, detail)
           VALUES (?, ?, ?)`,
        )
        .run(
          "offer_dm_rate_limited",
          "skipped",
          JSON.stringify({ slug, reason }),
        );
    } catch (err) {
      // Audit write failure must not break the poll loop.
      logger.debug(
        { err, slug, reason },
        "Failed to persist offer_dm_rate_limited audit row",
      );
    }
  }

  private profilesForBrowser(
    result: BrowserDetectionResult,
  ): BrowserProfileCandidate[] {
    const config = this.config.browserHistoryLifecycle.per_browser[result.browser];
    if (config?.enabled === false) return [];
    const allowed = config?.profiles_to_track ?? [];
    return result.profiles.filter((profile) =>
      allowed.length === 0 || allowed.includes(profile.profileName),
    );
  }

  private async ingestProfile(
    profile: BrowserProfileCandidate,
  ): Promise<{ inserted: number; duplicates: number }> {
    const cacheRoot = browserHistoryCacheRoot(this.config.dataDir);
    const cursor = readBrowserHistoryIngestCursor(
      this.db,
      profile.browser,
      profile.profileName,
    );

    const snapshot = await createBrowserHistorySnapshot(
      profile.historyPath,
      cacheRoot,
    );
    let inserted = 0;
    let duplicates = 0;
    try {
      const rows = readChromiumVisits(snapshot.mainPath, {
        sinceMs: cursor,
        limit: VISIT_BATCH_LIMIT,
      });
      if (rows.length === 0) {
        return { inserted: 0, duplicates: 0 };
      }
      const summary = summarizeVisits({
        browser: profile.browser,
        profile: profile.profileName,
        rows,
        boundary: this.boundary(),
      });
      const insertResult = insertBrowserVisits(this.db, summary.visits);
      inserted = insertResult.inserted;
      duplicates = insertResult.duplicates;

      incrementReloadSignals(this.db, summary.reloadIncrements);

      const nextCursor = Math.max(cursor, summary.highestTimestampMs);
      if (nextCursor > cursor) {
        writeBrowserHistoryIngestCursor(
          this.db,
          profile.browser,
          profile.profileName,
          nextCursor,
        );
      }
    } catch (err) {
      logger.warn(
        { err, browser: profile.browser, profile: profile.profileName },
        "Per-profile ingest failed",
      );
    } finally {
      await snapshot.cleanup();
    }
    return { inserted, duplicates };
  }

  private refreshShoppingSessions(): void {
    const since = Date.now() - SHOPPING_LOOKBACK_MS;
    const rows = this.db
      .prepare(
        `SELECT ts, amazon_asin AS asin, amazon_locale AS locale
         FROM browser_visits
         WHERE amazon_asin IS NOT NULL AND ts >= ?
         ORDER BY ts ASC`,
      )
      .all(since) as Array<{ ts: number; asin: string; locale: string | null }>;

    // Bucket rows by (agent-day, locale) but keep them ordered — the
    // qualification rule (§5.F3) is "≥3 distinct ASINs within a 90-min
    // *window*", so we need a sliding window inside each bucket, not a
    // whole-day min/max (which would either miss bursts split by hours
    // of inactivity or merge unrelated bursts under one session).
    type DayLocaleKey = string;
    type Visit = { ts: number; asin: string };
    const bucketed = new Map<DayLocaleKey, { day: string; locale: string; visits: Visit[] }>();
    for (const row of rows) {
      const day = this.agentDayKey(row.ts);
      const locale = row.locale ?? "com";
      const key = `${day}::${locale}`;
      let bucket = bucketed.get(key);
      if (!bucket) {
        bucket = { day, locale, visits: [] };
        bucketed.set(key, bucket);
      }
      bucket.visits.push({ ts: row.ts, asin: row.asin });
    }

    // For each day+locale bucket, sweep the visits with the pure
    // window detector and tag each emission with its day+locale.
    const sessionsByDay = new Map<string, Array<{
      day: string;
      locale: string;
      asins: string[];
      firstMs: number;
      lastMs: number;
    }>>();
    for (const bucket of bucketed.values()) {
      const detected = detectShoppingSessions(bucket.visits);
      if (detected.length === 0) continue;
      const sessions = sessionsByDay.get(bucket.day) ?? [];
      for (const session of detected) {
        sessions.push({
          day: bucket.day,
          locale: bucket.locale,
          asins: session.asins,
          firstMs: session.firstMs,
          lastMs: session.lastMs,
        });
      }
      sessionsByDay.set(bucket.day, sessions);
    }

    // Always replace per touched day, even if no qualifying sessions —
    // a previously-qualifying day whose visits aged out of the lookback
    // window must clear its row.
    const touchedDays = new Set<string>();
    for (const bucket of bucketed.values()) touchedDays.add(bucket.day);
    for (const day of touchedDays) {
      const sessions = (sessionsByDay.get(day) ?? []).map((session) => ({
        date: session.day,
        vendor: "amazon" as const,
        asinSet: session.asins,
        comparisonMinutes: Math.max(
          1,
          Math.round((session.lastMs - session.firstMs) / 60_000),
        ),
        locale: session.locale,
      }));
      replaceShoppingSessions(this.db, day, sessions);
    }
  }
}

