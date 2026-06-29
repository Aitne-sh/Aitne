/**
 * ObservationSummarizerWorker — singleton drain loop that turns pending
 * observation rows into `(summary_text, novelty_score)` pairs.
 *
 * Lifecycle (matches `Observer` so it sits under `ObserverManager`):
 *   1. `start()` — installs the recordObservation enqueue hook + runs
 *      the startup reclaim sweep that re-queues every 'pending' row that
 *      was orphaned by the previous daemon crash. The reclaim cap mirrors
 *      §A's bound on pending rows (the worker doesn't have to drain in
 *      one tick — items left in the queue remain in DB-pending state).
 *   2. `enqueue(id)` — ingestion path. Called by `recordObservation()`.
 *   3. drain — concurrency=2 workers race off the in-memory queue. Each
 *      runs the pre-filter, builds the prompt, calls the LLM client,
 *      parses the response, and persists the verdict. Per-call wall-
 *      clock cap is 15 s; rate-limited to `maxLlmCallsPerMinute`.
 *   4. `stop()` — drains the queue with an upper deadline, removes the
 *      enqueue hook.
 *
 * Backpressure: when the queue depth exceeds `queueDepthLimit` the
 * worker drops new arrivals to `summary_status='skipped'` directly,
 * skipping the LLM call. The activity_scan skill falls back to legacy
 * fetch-on-doubt for those rows.
 */

import type Database from "better-sqlite3";
import {
  getObservationForSummarization,
  listObservationsAwaitingSummary,
  setObservationEnqueueHook,
  updateObservationSummary,
  type SummaryStatus,
} from "../../db/observations.js";
import type { Observer } from "../manager.js";
import { createLogger } from "../../logging.js";
import { preFilterObservation, type PreFilterConfig } from "./pre-filter.js";
import { buildSummarizerPrompt, type SummarizerPrompt } from "./summarizer-prompts.js";
import { applyNoveltyFloor, parseSummarizerResponse, SUMMARY_MAX_CHARS } from "./response-parser.js";
import type { SummarizerLlmClient } from "./summarizer-client.js";

const logger = createLogger("observation-summarizer");

export const OBSERVATION_SUMMARIZER_OBSERVER_NAME = "observation-summarizer";

export interface ObservationSummarizerWorkerOptions {
  db: Database.Database;
  client: SummarizerLlmClient;
  /** Concurrency cap. Design §A: 2. */
  concurrency?: number;
  /** Per-LLM-call wall clock. Design §A: 15 000 ms. */
  perCallTimeoutMs?: number;
  /** Output token cap. Design budget: 50. */
  maxOutputTokens?: number;
  /** Rate limit ceiling — drops to skipped when exceeded. Design: 60/min. */
  maxLlmCallsPerMinute?: number;
  /** Backpressure: queue depth at which new arrivals short-circuit to skipped. */
  queueDepthLimit?: number;
  /** Reclaim sweep cap on startup — at most this many rows re-queued on boot. */
  reclaimLimit?: number;
  /** Pre-filter config (VIP senders, large-file threshold). */
  preFilter?: PreFilterConfig;
  /** Optional clock injection for tests. */
  now?: () => Date;
}

export class ObservationSummarizerWorker implements Observer {
  readonly name = OBSERVATION_SUMMARIZER_OBSERVER_NAME;

  private readonly db: Database.Database;
  private readonly client: SummarizerLlmClient;
  private readonly concurrency: number;
  private readonly perCallTimeoutMs: number;
  private readonly maxOutputTokens: number;
  private readonly maxLlmCallsPerMinute: number;
  private readonly queueDepthLimit: number;
  private readonly reclaimLimit: number;
  private readonly preFilterConfig: PreFilterConfig;
  private readonly now: () => Date;

  // In-memory queue of observation ids awaiting summarization. Dedup
  // against `inFlight` and `enqueued` so a re-write of the same row
  // (UPSERT pending → pending) doesn't double-process.
  private readonly queue: number[] = [];
  private readonly enqueued = new Set<number>();
  private readonly inFlight = new Set<number>();

  // Sliding-window LLM-call timestamps for rate limiting.
  private readonly callTimestamps: number[] = [];

  // Throttle the auth_missing warning. Without this guard every pending
  // observation produces a "Summarizer LLM call failed" log line, drowning
  // real signals. The actionable info — "no API key is configured" —
  // only needs to be surfaced once per cooldown window.
  private lastAuthMissingWarnAt = 0;
  private static readonly AUTH_MISSING_WARN_COOLDOWN_MS = 5 * 60_000;

  private started = false;
  private stopped = false;
  private workersIdle = 0;
  private waiters: Array<() => void> = [];
  private workerPromises: Promise<void>[] = [];

  constructor(options: ObservationSummarizerWorkerOptions) {
    this.db = options.db;
    this.client = options.client;
    this.concurrency = clampInt(options.concurrency ?? 2, 1, 8);
    this.perCallTimeoutMs = clampInt(options.perCallTimeoutMs ?? 15_000, 1_000, 60_000);
    this.maxOutputTokens = clampInt(options.maxOutputTokens ?? 200, 64, 1024);
    this.maxLlmCallsPerMinute = clampInt(options.maxLlmCallsPerMinute ?? 60, 1, 6_000);
    this.queueDepthLimit = clampInt(options.queueDepthLimit ?? 100, 10, 10_000);
    this.reclaimLimit = clampInt(options.reclaimLimit ?? 200, 10, 5_000);
    this.preFilterConfig = options.preFilter ?? {};
    this.now = options.now ?? (() => new Date());
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.stopped = false;

    // Install enqueue hook BEFORE the reclaim sweep so we don't miss
    // observations that arrive while we're scanning.
    setObservationEnqueueHook((id) => this.enqueue(id));

    // Reclaim sweep bypasses the backpressure check: those rows are
    // already persisted in `summary_status='pending'`, so applying
    // backpressure here would convert them to `'skipped'` and destroy
    // half the backlog whenever `pendingRows > queueDepthLimit` at
    // startup. The reclaim itself is bounded by `reclaimLimit`, so the
    // memory spike is bounded too — the queue may temporarily exceed
    // queueDepthLimit during startup, but normal backpressure resumes
    // for new arrivals once the sweep completes.
    const reclaimed = listObservationsAwaitingSummary(this.db, { limit: this.reclaimLimit });
    for (const id of reclaimed) this.enqueue(id, { bypassBackpressure: true });
    if (reclaimed.length > 0) {
      logger.info(
        { reclaimed: reclaimed.length, backend: this.client.backendId, model: this.client.modelId },
        "Reclaimed pending observations on startup",
      );
    }

    // Spawn N drain loops.
    for (let i = 0; i < this.concurrency; i++) {
      this.workerPromises.push(this.drainLoop());
    }
  }

  async stop(): Promise<void> {
    if (!this.started || this.stopped) return;
    this.stopped = true;
    setObservationEnqueueHook(null);
    // Wake every waiter so they observe `stopped` and exit.
    while (this.waiters.length > 0) {
      const w = this.waiters.shift();
      if (w) w();
    }
    await Promise.allSettled(this.workerPromises);
    this.workerPromises = [];
    this.started = false;
  }

  /**
   * Public entry — invoked by the recordObservation hook. Drops new
   * arrivals to `summary_status='skipped'` directly when the in-memory
   * queue is over capacity. The DB row's `summary_status` reflects the
   * actual state so activity_scan can route accordingly.
   *
   * `bypassBackpressure` is reserved for the startup reclaim sweep where
   * the rows are already in DB-pending state — applying backpressure
   * there would silently lose work.
   */
  enqueue(id: number, options: { bypassBackpressure?: boolean } = {}): void {
    if (this.stopped) return;
    if (this.enqueued.has(id) || this.inFlight.has(id)) return;
    if (!options.bypassBackpressure && this.queue.length >= this.queueDepthLimit) {
      logger.warn(
        { queueDepth: this.queue.length, observationId: id },
        "Summarizer queue at capacity — marking row skipped(backpressure)",
      );
      try {
        updateObservationSummary(this.db, {
          id,
          summaryText: null,
          noveltyScore: null,
          summaryStatus: "skipped",
          summaryBackend: this.client.backendId,
        });
      } catch (err) {
        logger.error({ err, id }, "Failed to mark backpressure-skipped row");
      }
      return;
    }
    this.queue.push(id);
    this.enqueued.add(id);
    this.notifyWaiter();
  }

  /** Telemetry surface — used by /api/observations/stats and the dashboard. */
  getMetrics(): {
    queueDepth: number;
    inFlight: number;
    callsLastMinute: number;
    backendId: string;
    modelId: string;
    started: boolean;
  } {
    this.evictExpiredCallTimestamps();
    return {
      queueDepth: this.queue.length,
      inFlight: this.inFlight.size,
      callsLastMinute: this.callTimestamps.length,
      backendId: this.client.backendId,
      modelId: this.client.modelId,
      started: this.started,
    };
  }

  // ── Drain loop ─────────────────────────────────────────────────────

  private async drainLoop(): Promise<void> {
    while (!this.stopped) {
      const id = this.queue.shift();
      if (id === undefined) {
        await this.waitForWork();
        continue;
      }
      this.enqueued.delete(id);
      this.inFlight.add(id);
      try {
        await this.processOne(id);
      } catch (err) {
        // processOne already logs; this catch is defense-in-depth so a
        // bug in one row never kills the loop.
        logger.error({ err, id }, "Unhandled error in summarizer drain");
      } finally {
        this.inFlight.delete(id);
      }
    }
  }

  private async processOne(id: number): Promise<void> {
    const row = getObservationForSummarization(this.db, id);
    if (!row) return; // Row consumed/deleted between enqueue and drain.
    if (row.summaryStatus !== "pending") return; // Already settled.

    const decision = preFilterObservation(
      {
        source: row.source,
        ref: row.ref,
        changeType: row.changeType,
        actor: row.actor,
        payload: row.payload,
      },
      this.preFilterConfig,
    );

    if (decision.kind === "skipped") {
      this.persist(row.id, {
        status: "skipped",
        summaryText: null,
        novelty: null,
      });
      return;
    }

    if (decision.kind === "done") {
      this.persist(row.id, {
        status: "done",
        summaryText: clampSummary(decision.summaryText),
        novelty: decision.noveltyScore,
      });
      return;
    }

    // Need an LLM call — check rate limit first.
    if (!this.tryConsumeRateBudget()) {
      // Drop this row to skipped rather than wait — backpressure under
      // burst per design §A.
      logger.warn(
        { id, callsLastMinute: this.callTimestamps.length },
        "Summarizer rate limit hit — marking row skipped(rate_limited)",
      );
      this.persist(row.id, { status: "skipped", summaryText: null, novelty: null });
      return;
    }

    const prompt = buildSummarizerPrompt({
      source: row.source,
      ref: row.ref,
      changeType: row.changeType,
      payload: row.payload,
    });

    const result = await this.callLlm(prompt);

    if (!result.ok) {
      // auth_missing is a user-config issue, not a per-row failure. Mark
      // the row 'skipped' so the activity_scan fallback path picks it up
      // (same posture as `unsupported_backend`) and warn at most once
      // per cooldown window so a missing ANTHROPIC_API_KEY does not spam
      // the log with one entry per pending observation.
      if (result.errorClass === "auth_missing") {
        const now = this.now().getTime();
        if (now - this.lastAuthMissingWarnAt >= ObservationSummarizerWorker.AUTH_MISSING_WARN_COOLDOWN_MS) {
          this.lastAuthMissingWarnAt = now;
          logger.warn(
            {
              backend: this.client.backendId,
              model: this.client.modelId,
              cooldownMs: ObservationSummarizerWorker.AUTH_MISSING_WARN_COOLDOWN_MS,
              hint: "Set ANTHROPIC_API_KEY in env or store it via the dashboard. Pending rows are being marked 'skipped' and the activity_scan fallback path will read them directly.",
            },
            "Summarizer LLM auth missing — falling back to skip, future warnings suppressed within cooldown",
          );
        }
        this.persist(row.id, { status: "skipped", summaryText: null, novelty: null });
        return;
      }
      logger.warn(
        { id, errorClass: result.errorClass, source: row.source },
        "Summarizer LLM call failed — marking row failed",
      );
      this.persist(row.id, {
        status: result.errorClass === "unsupported_backend" ? "skipped" : "failed",
        summaryText: null,
        novelty: null,
      });
      return;
    }

    const parsed = parseSummarizerResponse(result.rawText);
    if (!parsed.ok) {
      logger.warn(
        { id, reason: parsed.reason, snippet: parsed.rawSnippet, source: row.source },
        "Summarizer response parse failed",
      );
      this.persist(row.id, { status: "failed", summaryText: null, novelty: null });
      return;
    }

    const final = applyNoveltyFloor(parsed.value, decision.noveltyFloor);
    this.persist(row.id, {
      status: "done",
      summaryText: final.summary,
      novelty: final.novelty,
    });
  }

  private persist(
    id: number,
    args: { status: SummaryStatus; summaryText: string | null; novelty: number | null },
  ): void {
    try {
      updateObservationSummary(this.db, {
        id,
        summaryText: args.summaryText,
        noveltyScore: args.novelty,
        summaryStatus: args.status,
        summaryBackend: this.client.backendId,
      });
    } catch (err) {
      logger.error({ err, id }, "Failed to persist summarizer verdict");
    }
  }

  private async callLlm(prompt: SummarizerPrompt) {
    return this.client.call({
      systemPrompt: prompt.systemPrompt,
      userMessage: prompt.userMessage,
      timeoutMs: this.perCallTimeoutMs,
      maxOutputTokens: this.maxOutputTokens,
    });
  }

  // ── Concurrency primitives ─────────────────────────────────────────

  private waitForWork(): Promise<void> {
    if (this.queue.length > 0 || this.stopped) return Promise.resolve();
    this.workersIdle += 1;
    return new Promise<void>((resolve) => {
      this.waiters.push(() => {
        this.workersIdle -= 1;
        resolve();
      });
    });
  }

  private notifyWaiter(): void {
    if (this.waiters.length === 0) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter();
  }

  // ── Rate limit (sliding 60s window) ────────────────────────────────

  private tryConsumeRateBudget(): boolean {
    this.evictExpiredCallTimestamps();
    if (this.callTimestamps.length >= this.maxLlmCallsPerMinute) return false;
    this.callTimestamps.push(this.now().getTime());
    return true;
  }

  private evictExpiredCallTimestamps(): void {
    const cutoff = this.now().getTime() - 60_000;
    while (this.callTimestamps.length > 0 && this.callTimestamps[0] < cutoff) {
      this.callTimestamps.shift();
    }
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────

function clampSummary(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, SUMMARY_MAX_CHARS);
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.floor(value)));
}
