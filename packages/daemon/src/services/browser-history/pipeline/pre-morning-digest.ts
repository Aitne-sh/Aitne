import type Database from "better-sqlite3";
import {
  getAgentDayBoundsUtc,
  getAgentDayDateStr,
  parseSqliteUtcMs,
  preMorningDigestSchema,
  type PreMorningDigest,
  type PreMorningDigestClusterEntry,
  type PreMorningDigestPendingOffer,
  type PreMorningDigestReloadEntry,
  type PreMorningDigestShoppingEntry,
} from "@aitne/shared";

/**
 * BROWSER_HISTORY_INTEGRATION_PLAN §5.F2 Stage 1 — deterministic
 * pre-morning digest builder. Runs at `day_boundary − 60min` (default
 * 03:00 when `dayBoundaryHour=4`) and writes a static markdown file the
 * morning Stage B journal session reads from disk.
 *
 * Two responsibilities, deliberately separated:
 *
 * 1. `buildPreMorningDigest` — pure Node aggregation over the daemon's
 *    SQLite. No I/O outside the DB, no LLM, no network. Returns a
 *    Zod-validated `PreMorningDigest` payload. Same payload is served
 *    by `GET /api/browser-history/pre-morning-digest/{date}` as the
 *    JSON fallback for §10.6 step 5 ("digest file missing → API").
 *
 * 2. `renderPreMorningDigestMarkdown` — pure templating from the typed
 *    payload to markdown bytes. The journal Stage B task-flow reads
 *    this rendered file; the structured payload is also exposed via
 *    the API for any future caller that wants the typed shape.
 *
 * Layer 1 invariants preserved by both halves:
 *   - The `topic` / `displayName` constraint matches the existing
 *     `yesterdayResearchSummary.topic` regex (`[a-z0-9 /-]+`/i, ≤80
 *     chars). Any cluster `display_name` outside that shape (e.g. a
 *     user-renamed cluster carrying punctuation) is run through
 *     `sanitizeTopic` so the schema parse cannot fail at digest time.
 *   - `topDomains` are eTLD+1 labels read from
 *     `pipeline/redactor.ts`-normalised `browser_visits.domain` —
 *     never raw URLs.
 *   - Reload `urlPattern` is `<domain>/<first-path-segment>` from
 *     `pipeline/reload-detector.ts`. The `.max(180)` schema cap pins
 *     the surface in case the upstream extractor ever drifts.
 *   - No `search_query`, no `urls.title`, no full URL appears in the
 *     output. This is the "prompt-injection blast radius" boundary
 *     §6 calls Layer 1.
 */

/**
 * Cluster activity inside the digest window — driven by a single SQL
 * pass over `browser_visits` joined with `browser_research_clusters`.
 * Bounded by `maxClusters` so an attacker-shaped cluster fan-out
 * cannot balloon the morning context. Default 12 matches the schema's
 * `clusters.max(12)`.
 */
interface BuildOptions {
  /** Override "now" for deterministic tests. Defaults to `Date.now()`. */
  readonly nowMs?: number;
  readonly maxClusters?: number;
  readonly maxShopping?: number;
  readonly maxReloads?: number;
  readonly maxPendingOffers?: number;
}

const DEFAULT_MAX_CLUSTERS = 12;
const DEFAULT_MAX_SHOPPING = 8;
const DEFAULT_MAX_RELOADS = 10;
const DEFAULT_MAX_PENDING_OFFERS = 20;
/** Per-cluster `newDomainsInWindow` cap — must match the schema `.max(10)`. */
const NEW_DOMAINS_CAP = 10;
/** Per-cluster `topDomains` cap — must match the schema `.max(10)`. */
const TOP_DOMAINS_CAP = 10;

export interface DigestBoundary {
  /** IANA timezone string, e.g. "Asia/Tokyo". `undefined` means UTC. */
  readonly timezone: string | undefined;
  /** Hour the agent-day starts (0–23). Default 4 across the project. */
  readonly dayBoundaryHour: number;
}

/**
 * Convert the agent-day date that the digest summarises ("yesterday's
 * agent-day") into the UTC `[startMs, endMs)` window used to filter
 * `browser_visits.ts`. Pure helper so the date math lives next to the
 * builder rather than ad-hoc inside the SQL string.
 */
export function digestWindowMs(
  dateStr: string,
  boundary: DigestBoundary,
): { startMs: number; endMs: number } {
  const anchor = new Date(`${dateStr}T12:00:00Z`);
  const bounds = getAgentDayBoundsUtc(
    boundary.timezone,
    boundary.dayBoundaryHour,
    anchor,
  );
  return {
    startMs: parseSqliteUtcMs(bounds.start),
    endMs: parseSqliteUtcMs(bounds.end),
  };
}

/**
 * Resolve "the agent-day this digest is being built for" from a wall
 * clock. The cron fires at `dayBoundaryHour − 1` local time — still
 * inside the agent-day that is *just about to roll over* — so the
 * helper returns that current agent-day's date string.
 */
export function digestDateForNow(
  boundary: DigestBoundary,
  nowMs: number,
): string {
  return getAgentDayDateStr(
    boundary.timezone,
    boundary.dayBoundaryHour,
    new Date(nowMs),
  );
}

const SAFE_TOPIC_RE = /^[a-z0-9 /-]+$/i;

/**
 * Project a free-form cluster display-name onto the `[a-z0-9 /-]+`
 * shape the schema demands. Already-conforming values pass through
 * unchanged; punctuation / unicode / control characters collapse to
 * single hyphens; trailing hyphens are trimmed; capped at 80 chars.
 *
 * Exported for tests and for the route layer's defensive re-projection
 * (if a user-renamed cluster row ever drifts past validation, the
 * digest builder still produces a coherent file).
 */
export function sanitizeTopic(displayName: string): string {
  const trimmed = displayName.trim();
  if (trimmed.length === 0) return "untitled";
  if (SAFE_TOPIC_RE.test(trimmed) && trimmed.length <= 80) return trimmed;
  const cleaned = trimmed
    .replace(/[^a-zA-Z0-9 /-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-\s]+|[-\s]+$/g, "")
    .slice(0, 80);
  return cleaned.length > 0 ? cleaned : "untitled";
}

interface ClusterTouchedRow {
  slug: string;
  displayName: string;
  status: string;
  rootTaskId: number;
  visitsInWindow: number;
  foregroundSecInWindow: number;
  meaningfulVisitsTotal: number;
  distinctMeaningfulDays: number;
  meaningfulForegroundSecTotal: number;
}

/**
 * One sweep over `browser_visits` joined to the cluster row: returns
 * every cluster with ≥1 meaningful visit in the window plus the
 * aggregate counts. Status `'muted'` / `'concluded'` clusters are
 * intentionally excluded — the journal's "yesterday's research"
 * surface should not resurrect them.
 */
function clustersTouchedInWindow(
  db: Database.Database,
  startMs: number,
  endMs: number,
  limit: number,
): ClusterTouchedRow[] {
  // SQL-side `COUNT(DISTINCT day-bucket)` would need timezone-aware
  // bucketing which SQLite cannot do natively. `distinctMeaningfulDays`
  // is filled in by a per-cluster JS pass in the caller (small N —
  // bounded by `limit`, which is the schema's cluster cap).
  return db
    .prepare(
      `SELECT
         c.slug,
         c.display_name AS displayName,
         c.status,
         c.root_task_id AS rootTaskId,
         COUNT(v.id) AS visitsInWindow,
         COALESCE(SUM(v.foreground_sec), 0) AS foregroundSecInWindow,
         c.meaningful_visits_total AS meaningfulVisitsTotal,
         c.meaningful_foreground_sec_total AS meaningfulForegroundSecTotal
       FROM browser_research_clusters c
       JOIN browser_visits v
         ON v.root_task_id = c.root_task_id
        AND v.meaningful = 1
        AND v.ts >= ? AND v.ts < ?
       WHERE c.status IN ('active', 'dormant')
       GROUP BY c.slug
       ORDER BY visitsInWindow DESC, c.last_activity_at DESC
       LIMIT ?`,
    )
    .all(startMs, endMs, limit)
    .map((row) => {
      const r = row as Omit<ClusterTouchedRow, "distinctMeaningfulDays">;
      return {
        slug: r.slug,
        displayName: r.displayName,
        status: r.status,
        rootTaskId: r.rootTaskId,
        visitsInWindow: r.visitsInWindow,
        foregroundSecInWindow: r.foregroundSecInWindow,
        meaningfulVisitsTotal: r.meaningfulVisitsTotal,
        distinctMeaningfulDays: 0,
        meaningfulForegroundSecTotal: r.meaningfulForegroundSecTotal,
      };
    });
}

/**
 * Count distinct agent-day buckets for a cluster's meaningful visits.
 * Done in JS (not SQL) so the `dayBoundaryHour=4` + timezone math is
 * the same code used by every other agent-day call site. The query is
 * bounded by cluster size which is bounded by the qualification rules.
 */
function distinctDaysForCluster(
  db: Database.Database,
  rootTaskId: number,
  boundary: DigestBoundary,
): number {
  const rows = db
    .prepare(
      `SELECT ts FROM browser_visits
       WHERE root_task_id = ? AND meaningful = 1`,
    )
    .all(rootTaskId) as Array<{ ts: number }>;
  const days = new Set<string>();
  for (const row of rows) {
    days.add(
      getAgentDayDateStr(
        boundary.timezone,
        boundary.dayBoundaryHour,
        new Date(row.ts),
      ),
    );
  }
  return days.size;
}

interface DomainsForClusterResult {
  /** eTLD+1 labels active inside the window. */
  inWindow: Set<string>;
  /** eTLD+1 labels active before the window opened. */
  beforeWindow: Set<string>;
  /** Ranked top eTLD+1 labels across the cluster's meaningful visits. */
  topDomains: string[];
}

/**
 * One pass over a cluster's meaningful visits — partitioned by the
 * window start so the digest can compute `newDomainsInWindow` and
 * `topDomains` without two separate queries. Sorted by visit count for
 * the top-N output; cap is the schema's 10-entry limit.
 */
function domainsForCluster(
  db: Database.Database,
  rootTaskId: number,
  startMs: number,
  endMs: number,
): DomainsForClusterResult {
  const rows = db
    .prepare(
      `SELECT ts, domain
       FROM browser_visits
       WHERE root_task_id = ? AND meaningful = 1`,
    )
    .all(rootTaskId) as Array<{ ts: number; domain: string }>;
  const counts = new Map<string, number>();
  const inWindow = new Set<string>();
  const beforeWindow = new Set<string>();
  for (const row of rows) {
    counts.set(row.domain, (counts.get(row.domain) ?? 0) + 1);
    if (row.ts >= startMs && row.ts < endMs) {
      inWindow.add(row.domain);
    } else if (row.ts < startMs) {
      beforeWindow.add(row.domain);
    }
    // Visits after the window are ignored — they cannot be "new
    // domains in yesterday" by definition. They still contribute to
    // `topDomains` via the count-map above.
  }
  const topDomains = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, TOP_DOMAINS_CAP)
    .map(([domain]) => domain);
  return { inWindow, beforeWindow, topDomains };
}

/**
 * Did this cluster fire an offer inside the window? Used as the
 * `qualifiedOvernight` signal — an offer fires the first time a
 * cluster crosses any of the §5.F1 primary qualification gates, so a
 * pending-offer row whose `offered_at` lands in the digest window is a
 * faithful proxy for "this is the first time the user crossed the
 * threshold since yesterday's digest".
 *
 * `kind` is irrelevant ("offered" / "research_assist" / "wiki_summary"
 * all count); the row's mere presence with `offered_at` in window is
 * enough.
 */
function offersFiredInWindow(
  db: Database.Database,
  startMs: number,
  endMs: number,
): Set<string> {
  const rows = db
    .prepare(
      `SELECT DISTINCT slug
       FROM browser_pending_offers
       WHERE offered_at >= ? AND offered_at < ?`,
    )
    .all(startMs, endMs) as Array<{ slug: string }>;
  return new Set(rows.map((row) => row.slug));
}

function shoppingForDate(
  db: Database.Database,
  dateStr: string,
  limit: number,
): PreMorningDigestShoppingEntry[] {
  const rows = db
    .prepare(
      `SELECT vendor, asin_set AS asinSet, comparison_minutes AS comparisonMinutes, locale
       FROM browser_shopping_sessions
       WHERE date = ?
       ORDER BY id ASC
       LIMIT ?`,
    )
    .all(dateStr, limit) as Array<{
      vendor: string;
      asinSet: string;
      comparisonMinutes: number;
      locale: string | null;
    }>;
  const out: PreMorningDigestShoppingEntry[] = [];
  for (const row of rows) {
    if (row.vendor !== "amazon") continue; // schema only allows literal "amazon"
    let asinCount = 0;
    try {
      const parsed = JSON.parse(row.asinSet) as unknown;
      if (Array.isArray(parsed)) {
        asinCount = parsed.filter((value) => typeof value === "string").length;
      }
    } catch {
      // Corrupt JSON — surface zero ASINs; the entry is dropped below.
      asinCount = 0;
    }
    if (asinCount === 0) continue;
    out.push({
      vendor: "amazon",
      asinCount,
      comparisonMinutes: Math.max(1, row.comparisonMinutes),
      locale: row.locale,
    });
  }
  return out;
}

function reloadsForDate(
  db: Database.Database,
  dateStr: string,
  limit: number,
): PreMorningDigestReloadEntry[] {
  const rows = db
    .prepare(
      `SELECT url_pattern AS urlPattern, reload_count AS reloadCount
       FROM browser_reload_signals
       WHERE date = ?
       ORDER BY reload_count DESC, url_pattern ASC
       LIMIT ?`,
    )
    .all(dateStr, limit) as Array<{ urlPattern: string; reloadCount: number }>;
  return rows.map((row) => ({
    urlPattern: row.urlPattern,
    reloadCount: row.reloadCount,
  }));
}

function pendingOffersOpen(
  db: Database.Database,
  nowMs: number,
  limit: number,
): PreMorningDigestPendingOffer[] {
  const rows = db
    .prepare(
      `SELECT
         po.slug,
         c.display_name AS displayName,
         po.kind,
         po.offered_at AS offeredAt,
         po.expires_at AS expiresAt
       FROM browser_pending_offers po
       JOIN browser_research_clusters c ON c.slug = po.slug
       WHERE po.expires_at >= ?
       ORDER BY po.offered_at DESC
       LIMIT ?`,
    )
    .all(nowMs, limit) as Array<{
      slug: string;
      displayName: string;
      kind: PreMorningDigestPendingOffer["kind"];
      offeredAt: number;
      expiresAt: number;
    }>;
  return rows.map((row) => ({
    slug: row.slug,
    displayName: sanitizeTopic(row.displayName),
    kind: row.kind,
    offeredAt: row.offeredAt,
    expiresAt: row.expiresAt,
  }));
}

export interface BuildPreMorningDigestArgs {
  readonly db: Database.Database;
  /** Agent-day the digest summarises (e.g. yesterday). YYYY-MM-DD. */
  readonly date: string;
  readonly boundary: DigestBoundary;
  readonly options?: BuildOptions;
}

/**
 * Build the typed `PreMorningDigest` payload for one agent-day. Pure
 * over the DB handle and the supplied date/boundary/`nowMs`. The
 * result is Zod-validated before return so a future schema tightening
 * fails loud rather than producing a malformed file.
 */
export function buildPreMorningDigest(
  args: BuildPreMorningDigestArgs,
): PreMorningDigest {
  const { db, date, boundary, options = {} } = args;
  const nowMs = options.nowMs ?? Date.now();
  const maxClusters = options.maxClusters ?? DEFAULT_MAX_CLUSTERS;
  const maxShopping = options.maxShopping ?? DEFAULT_MAX_SHOPPING;
  const maxReloads = options.maxReloads ?? DEFAULT_MAX_RELOADS;
  const maxPendingOffers =
    options.maxPendingOffers ?? DEFAULT_MAX_PENDING_OFFERS;

  const window = digestWindowMs(date, boundary);
  const qualifiedOvernight = offersFiredInWindow(
    db,
    window.startMs,
    window.endMs,
  );

  const clusterRows = clustersTouchedInWindow(
    db,
    window.startMs,
    window.endMs,
    maxClusters,
  );
  const clusters: PreMorningDigestClusterEntry[] = clusterRows.map((row) => {
    const days = distinctDaysForCluster(db, row.rootTaskId, boundary);
    const domains = domainsForCluster(
      db,
      row.rootTaskId,
      window.startMs,
      window.endMs,
    );
    const newDomains: string[] = [];
    for (const domain of domains.inWindow) {
      if (!domains.beforeWindow.has(domain)) newDomains.push(domain);
    }
    newDomains.sort();
    return {
      slug: row.slug,
      displayName: sanitizeTopic(row.displayName),
      // SQL filter in `clustersTouchedInWindow` restricts rows to
      // `status IN ('active', 'dormant')`, so the cast here is the SQL
      // contract — never trust the value past the schema CHECK
      // constraint and the filter. A drift would surface as a Zod
      // parse failure at the `preMorningDigestSchema.parse()` call
      // below, which is the right loud-failure boundary.
      status: row.status as PreMorningDigestClusterEntry["status"],
      daysActive: days,
      meaningfulVisitsInWindow: row.visitsInWindow,
      // Round to whole seconds — the schema is integer-only.
      meaningfulForegroundSecInWindow: Math.round(row.foregroundSecInWindow),
      newDomainsInWindow: newDomains.slice(0, NEW_DOMAINS_CAP),
      topDomains: domains.topDomains,
      qualifiedOvernight: qualifiedOvernight.has(row.slug),
    };
  });

  const shopping = shoppingForDate(db, date, maxShopping);
  const reloads = reloadsForDate(db, date, maxReloads);
  const pendingOffers = pendingOffersOpen(db, nowMs, maxPendingOffers);

  const newThresholdsCount = clusters.filter(
    (entry) => entry.qualifiedOvernight,
  ).length;

  return preMorningDigestSchema.parse({
    date,
    generatedAt: new Date(nowMs).toISOString(),
    source: "deterministic",
    clusters,
    shopping,
    reloads,
    pendingOffers,
    newThresholdsCount,
  });
}

/**
 * Render the typed digest to the markdown file the morning Stage B
 * journal reads. The format mirrors the §5.F2 sample digest 1:1 — same
 * frontmatter keys, same section ordering — and is intentionally
 * minimal: structured data, neutral language, no LLM-style framing.
 *
 * The journal author re-frames this into prose; the file's job is to
 * be a faithful snapshot, not to be readable on its own.
 */
export function renderPreMorningDigestMarkdown(digest: PreMorningDigest): string {
  const lines: string[] = [];
  lines.push("---");
  lines.push(`date: ${digest.date}`);
  lines.push(`generated_at: ${digest.generatedAt}`);
  lines.push(`source: ${digest.source}`);
  lines.push(`clusters_touched: ${digest.clusters.length}`);
  lines.push(`pending_offers: ${digest.pendingOffers.length}`);
  lines.push(`new_thresholds: ${digest.newThresholdsCount}`);
  lines.push("---");
  lines.push("");
  lines.push("> Daemon-generated digest. Do not edit; rewritten by the");
  lines.push("> pre-morning cron at `dayBoundaryHour − 1` each day.");
  lines.push("");

  lines.push("## Yesterday's meaningful research");
  lines.push("");
  if (digest.clusters.length === 0) {
    lines.push("- (no meaningful research clusters touched in window)");
  } else {
    for (const cluster of digest.clusters) {
      lines.push(
        `### ${cluster.displayName} (${cluster.daysActive} days, status=${cluster.status})`,
      );
      lines.push(
        `- slug: \`${cluster.slug}\``,
      );
      lines.push(
        `- yesterday: ${cluster.meaningfulVisitsInWindow} visits, `
          + `${Math.round(cluster.meaningfulForegroundSecInWindow / 60)} min foreground`,
      );
      if (cluster.newDomainsInWindow.length > 0) {
        lines.push(
          `- new domains in window: ${cluster.newDomainsInWindow.join(", ")}`,
        );
      }
      if (cluster.topDomains.length > 0) {
        lines.push(`- top domains: ${cluster.topDomains.join(", ")}`);
      }
      if (cluster.qualifiedOvernight) {
        lines.push(
          "- threshold crossed overnight (offer fired in the window)",
        );
      }
      lines.push("");
    }
  }

  lines.push("## Shopping");
  lines.push("");
  if (digest.shopping.length === 0) {
    lines.push("- (no shopping comparison sessions)");
  } else {
    for (const entry of digest.shopping) {
      const localePart = entry.locale ? ` .${entry.locale}` : "";
      lines.push(
        `- ${entry.vendor}: monitor comparison (${entry.asinCount} ASINs, `
          + `${entry.comparisonMinutes}min${localePart})`,
      );
    }
  }
  lines.push("");

  lines.push("## Reload patterns (informational, not surfaced)");
  lines.push("");
  if (digest.reloads.length === 0) {
    lines.push("- (no notable reload activity)");
  } else {
    for (const entry of digest.reloads) {
      lines.push(`- ${entry.urlPattern}: ${entry.reloadCount}`);
    }
  }
  lines.push("");

  lines.push("## Pending offers awaiting response");
  lines.push("");
  if (digest.pendingOffers.length === 0) {
    lines.push("- (none)");
  } else {
    for (const offer of digest.pendingOffers) {
      const offeredIso = new Date(offer.offeredAt).toISOString().slice(0, 10);
      const action =
        offer.kind === "wiki_summary"
          ? `\`!research wiki ${offer.slug}\` to accept`
          : offer.kind === "research_assist"
            ? `\`!research accept ${offer.slug}\` to accept`
            : "reply to the offer DM with \"research\" or \"summarise\"";
      lines.push(
        `- ${offer.displayName} [${offer.kind}] (offered ${offeredIso}) — ${action}`,
      );
    }
  }
  lines.push("");

  return lines.join("\n");
}

/**
 * The `context/...` relative path the morning journal task-flow reads.
 * Lives under the new `browser/` subdirectory of the context root so
 * the agent's existing `GET /api/context/<path>` chokepoint serves it
 * with no new auth surface needed.
 */
export function preMorningDigestRelativePath(dateStr: string): string {
  return `browser/yesterday-${dateStr}.md`;
}
