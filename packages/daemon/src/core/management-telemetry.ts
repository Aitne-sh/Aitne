/**
 * Management-registry telemetry — Phase 8 of
 * docs/design/21-management-registry-and-entities.md §14.3.
 *
 * Process-local, in-memory ring buffers that capture three signals which
 * cannot be reconstructed from `agent_actions` alone:
 *
 *   - `aitne_management_md_render_seconds` (histogram) — wall-clock for
 *     each `renderAndWriteManagementMd` call; surfaces the NFR-2 budget
 *     ("≤ 200 ms for up to 100 rows") to operators.
 *   - `aitne_activity_view_rebuild_seconds{source}` (histogram) — per-
 *     source rebuild wall-clock from `runActivityViewReconciler`.
 *   - `aitne_entity_mirror_lag_ms` (gauge) — most-recent observed lag
 *     between an L2 file's mtime and the mirror upsert that consumed
 *     it (NFR-9 budget: ≤ 500 ms on ≤ 5000 entity files).
 *
 * Persistence: none. Histograms are scrape-interval data — losing them
 * across a daemon restart is acceptable, and the alternative (a SQLite
 * sample table) would either bloat the DB or need its own retention
 * sweep. The Prometheus translation layer (when added) will scrape from
 * this module the same way `MetricsCollector` does.
 *
 * Bounded memory: each per-source ring buffer is capped at
 * {@link MAX_SAMPLES} samples. Sources that fall out of the active set
 * are not actively pruned — `runActivityViewReconciler`'s GC loop runs
 * often enough that an inactive source's buffer sees no new writes and
 * is harmless until the daemon restarts. Tests reset via
 * {@link resetManagementTelemetry}.
 *
 * Thread-safety: the daemon is single-threaded (Node event loop). The
 * record* functions push synchronously between awaits, so two callers
 * never race on a single buffer.
 */

const MAX_SAMPLES = 256;

const renderDurationsMs: number[] = [];
const activityRebuildBySource = new Map<string, number[]>();
let lastEntityMirrorLagMs: number | null = null;
let lastEntityMirrorObservedAt: string | null = null;

/**
 * Record one `renderAndWriteManagementMd` wall-clock sample.
 * `durationMs` may be 0 for very-fast renders; negatives are dropped.
 */
export function recordManagementMdRenderDuration(durationMs: number): void {
  if (!Number.isFinite(durationMs) || durationMs < 0) return;
  renderDurationsMs.push(durationMs);
  if (renderDurationsMs.length > MAX_SAMPLES) {
    renderDurationsMs.splice(0, renderDurationsMs.length - MAX_SAMPLES);
  }
}

/**
 * Record one per-source activity-view rebuild wall-clock sample. The
 * `source` is the user-typed app label (matches the `source:`
 * frontmatter in `_activity/<source>.md`).
 */
export function recordActivityViewRebuildDuration(
  source: string,
  durationMs: number,
): void {
  if (!Number.isFinite(durationMs) || durationMs < 0) return;
  if (typeof source !== "string" || source.length === 0) return;
  let buf = activityRebuildBySource.get(source);
  if (!buf) {
    buf = [];
    activityRebuildBySource.set(source, buf);
  }
  buf.push(durationMs);
  if (buf.length > MAX_SAMPLES) {
    buf.splice(0, buf.length - MAX_SAMPLES);
  }
}

/**
 * Record the latest entity-mirror lag (ms between fs event observation
 * and mirror upsert). Always replaces the previous value — a gauge,
 * not a histogram. `observedAt` defaults to `Date.now()`.
 */
export function recordEntityMirrorLag(
  durationMs: number,
  observedAt: Date = new Date(),
): void {
  if (!Number.isFinite(durationMs) || durationMs < 0) return;
  lastEntityMirrorLagMs = durationMs;
  lastEntityMirrorObservedAt = observedAt.toISOString();
}

/**
 * Histogram summary used for both render and per-source rebuild. All
 * fields except `count`/`sum` are `null` when the buffer is empty so
 * the dashboard can distinguish "no data" from "0 ms".
 */
export interface HistogramSummary {
  count: number;
  sum: number;
  min: number | null;
  max: number | null;
  avg: number | null;
  p50: number | null;
  p90: number | null;
  p95: number | null;
}

export interface ActivityRebuildBucket {
  source: string;
  histogram: HistogramSummary;
}

export interface ManagementTelemetrySnapshot {
  /** All samples in ms — same unit the buffer stores. */
  managementMdRenderMs: HistogramSummary;
  /** Per-source activity-view rebuild histograms (samples in ms). */
  activityViewRebuildMs: ActivityRebuildBucket[];
  /** Latest entity-mirror lag in ms; null when nothing has been recorded. */
  entityMirrorLag: {
    lastMs: number | null;
    observedAt: string | null;
  };
}

/**
 * Snapshot the buffers as a JSON-friendly value. Pure read — does not
 * mutate the buffers. Per-source buckets are sorted by source label so
 * two snapshots taken back-to-back are byte-comparable.
 */
export function snapshotManagementTelemetry(): ManagementTelemetrySnapshot {
  return {
    managementMdRenderMs: summarize(renderDurationsMs),
    activityViewRebuildMs: Array.from(activityRebuildBySource.entries())
      .map(([source, samples]) => ({
        source,
        histogram: summarize(samples),
      }))
      .sort((a, b) => a.source.localeCompare(b.source)),
    entityMirrorLag: {
      lastMs: lastEntityMirrorLagMs,
      observedAt: lastEntityMirrorObservedAt,
    },
  };
}

/**
 * Drop every recorded sample. Test-only helper — production callers
 * should never need this. Exported (not hidden behind `__test__`) so
 * unrelated test files can pull in the telemetry module without an
 * import-tree side-effect.
 */
export function resetManagementTelemetry(): void {
  renderDurationsMs.length = 0;
  activityRebuildBySource.clear();
  lastEntityMirrorLagMs = null;
  lastEntityMirrorObservedAt = null;
}

/**
 * Pure-logic histogram summarizer. Exported for direct unit tests so
 * the snapshot's quantile contract is locked under property-style tests
 * without poking the module-level buffer.
 */
export function summarize(samples: readonly number[]): HistogramSummary {
  if (samples.length === 0) {
    return {
      count: 0,
      sum: 0,
      min: null,
      max: null,
      avg: null,
      p50: null,
      p90: null,
      p95: null,
    };
  }
  const sorted = [...samples].sort((a, b) => a - b);
  let sum = 0;
  for (const v of sorted) sum += v;
  return {
    count: sorted.length,
    sum,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    avg: sum / sorted.length,
    p50: percentile(sorted, 0.5),
    p90: percentile(sorted, 0.9),
    p95: percentile(sorted, 0.95),
  };
}

/**
 * Nearest-rank percentile — same method as `MetricsCollector
 * .responseTimeMetrics`, so the two metric surfaces stay consistent.
 * Caller passes a pre-sorted ascending array.
 */
function percentile(sorted: readonly number[], p: number): number {
  const idx = Math.min(Math.floor(sorted.length * p), sorted.length - 1);
  return sorted[idx];
}
