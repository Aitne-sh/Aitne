import type Database from "better-sqlite3";
import type { Event, MessageEvent } from "@aitne/shared";
import { isMessageEvent, getAgentDayBoundsUtc, nowInTimezone } from "@aitne/shared";
import { randomUUID } from "node:crypto";
import type { AgentConfig } from "../config.js";
import type { INotificationManager, ReplyActivityHandle } from "../core/dispatcher.js";
import type { MessageReplyTarget } from "../core/dispatcher-types.js";
import type { SignalDetector } from "../core/signal-detector.js";
import type { MessageHub } from "./message-hub.js";
import { recordProactiveForwardDeliveries } from "../core/channel-timeline.js";
import { createLogger } from "../logging.js";

const logger = createLogger("notification-manager");
const NOOP_REPLY_ACTIVITY: ReplyActivityHandle = {
  stop: async () => {},
};

/** Safety categories bypass quiet hours and user preferences */
const SAFETY_CATEGORIES = [
  "security",
  "deadline",
  "error",
  "critical",
] as const;

/**
 * Default bounded-retry shape for `deliverReply`. Sized so the operator's
 * worst-case wait for an acknowledged DM is small (~600 ms across two
 * backoffs at 200 ms + 400 ms) while still smoothing over the transient
 * 5xx / socket-reset class of platform failures that the pre-M4 code path
 * silently swallowed.
 */
const DEFAULT_REPLY_RETRY_ATTEMPTS = 3;
const DEFAULT_REPLY_RETRY_BACKOFF_BASE_MS = 200;

/**
 * P2-15 per-type rate limit. Sized to allow legitimate bursts of the same
 * notification type (e.g. three rapid-fire calendar updates) but stop a
 * stuck-loop emitter from monopolising the global budget. 3 deliveries
 * per 5 minutes per `event.type` matches the upper bound observed in
 * normal operation; anything beyond is treated as a regression in the
 * emitting code path and dropped with a warn log.
 */
const PER_TYPE_RATE_LIMIT = 3;
const PER_TYPE_RATE_WINDOW_MS = 5 * 60 * 1000;

export interface NotificationManagerOptions {
  /**
   * Maximum number of times `deliverReply` will attempt the originating
   * platform before falling back to the configured proactive destinations.
   * Tests pin this to 1 (no retry) or 3 (full path) and zero out the
   * backoff to keep the suite fast. Production defaults — see
   * {@link DEFAULT_REPLY_RETRY_ATTEMPTS} — keep the user-visible wait
   * under one second even on the worst case.
   */
  replyRetryAttempts?: number;
  /**
   * Base backoff in ms; the actual delay between attempts is
   * `base * 2^(attempt-1)` so 200 → 400 across the default 3-attempt
   * loop. Set to 0 in tests.
   */
  replyRetryBackoffBaseMs?: number;
  /**
   * Test seam — replaces `setTimeout`-based sleeping with a synchronous
   * resolver in unit tests. Production omits this and uses the real
   * `setTimeout(...).unref()` so the timer never blocks daemon shutdown.
   */
  sleep?: (ms: number) => Promise<void>;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    // Don't keep the event loop alive solely because a retry timer is
    // pending — daemon shutdown should not hang on an in-flight reply
    // backoff.
    if (typeof t.unref === "function") t.unref();
  });
}

function truncateSummary(message: string): string {
  return message.length > 200 ? `${message.slice(0, 197)}...` : message;
}

type DestinationMode = "default" | "configured_only";

/**
 * Queued proactive notification awaiting flush. Populated by `send()` when a
 * prior delivery for the same event type happened within the batch window.
 * The slot holds the original event/metadata of the FIRST queued message —
 * subsequent queued messages append to `messages` but do not overwrite the
 * event reference, so the combined flush preserves the initiating context.
 */
interface BatchSlot {
  firstQueuedAtMs: number;
  messages: string[];
  dispatchIds: string[];
  originSessionIds: number[];
  event: Event;
  priority: string;
  category: string | undefined;
  destinationMode: DestinationMode;
}

export class NotificationManager implements INotificationManager {
  private signalDetector: SignalDetector | null = null;

  /** Per-`event.type` queue of proactive notifications awaiting batch flush. */
  private readonly batchSlots = new Map<string, BatchSlot>();
  /** Per-`event.type` timestamp of the last actual delivery (ms since epoch). */
  private readonly lastDeliveryAtMs = new Map<string, number>();
  /**
   * P2-15 — per-event-type rate limiter. A misbehaving emitter for one
   * event type used to consume the global `maxNotificationsPerHour`
   * budget and silently starve unrelated notifications. We now also
   * track a smaller per-type ring buffer of recent delivery timestamps;
   * if a type exceeds {@link PER_TYPE_RATE_LIMIT} within
   * {@link PER_TYPE_RATE_WINDOW_MS}, further sends of THAT type are
   * dropped (logged) without consuming the global budget. Safety
   * categories (`security`/`deadline`/`error`/`critical`) bypass this
   * gate as they do the global one.
   */
  private readonly perTypeDeliveryWindow = new Map<string, number[]>();
  /**
   * Single scheduled flush timer. When set, a callback is armed for the
   * earliest-pending queue's flush time. Queued sends reuse the existing
   * timer — no thundering herd even if dozens of messages pile up in the
   * same window. `stop()` clears it so shutdown doesn't leak handles.
   */
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  /** Flush-in-progress guard so overlapping timer fires don't double-send. */
  private flushing = false;

  private readonly replyRetryAttempts: number;
  private readonly replyRetryBackoffBaseMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly messageHub: MessageHub,
    private readonly db: Database.Database,
    private readonly config: AgentConfig,
    options: NotificationManagerOptions = {},
  ) {
    // Defensive clamp: a misconfigured `replyRetryAttempts <= 0` would
    // turn `deliverReply` into a no-op (the for-loop body never runs)
    // and silently break every DM reply. Clamp to a minimum of 1 so the
    // worst legitimate misconfiguration is "no retries, same as the
    // pre-M4 contract" rather than "no delivery at all".
    this.replyRetryAttempts = Math.max(
      1,
      options.replyRetryAttempts ?? DEFAULT_REPLY_RETRY_ATTEMPTS,
    );
    this.replyRetryBackoffBaseMs = Math.max(
      0,
      options.replyRetryBackoffBaseMs ?? DEFAULT_REPLY_RETRY_BACKOFF_BASE_MS,
    );
    this.sleep = options.sleep ?? defaultSleep;
  }

  /** Set the SignalDetector for implicit feedback tracking. */
  setSignalDetector(detector: SignalDetector): void {
    this.signalDetector = detector;
  }

  async beginReplyActivity(event: MessageEvent): Promise<ReplyActivityHandle> {
    try {
      return await this.messageHub.beginProcessingIndicator(
        event.platform,
        event.channel,
        event.threadId ?? undefined,
      );
    } catch (err) {
      logger.debug(
        { platform: event.platform, channel: event.channel, error: err instanceof Error ? err.message : String(err) },
        "Failed to begin reply activity indicator",
      );
      return NOOP_REPLY_ACTIVITY;
    }
  }

  /**
   * Send a notification to the user.
   *
   * For message events, replies go back to the originating platform/channel.
   * For other events, proactive delivery uses the configured notification
   * destinations unless a stricter destination mode is requested.
   *
   * Respects quiet hours and rate limits (unless safety category). When
   * `batchIntervalMinutes > 0` the proactive path batches by `event.type`:
   * a second notification of the same type arriving within the window is
   * queued and later flushed as one combined message (see `flushBatches`).
   * Replies and safety-category notifications bypass batching entirely.
   */
  async send(
    message: string,
    event: Event,
    options?: {
      priority?: string;
      category?: string;
      destinationMode?: DestinationMode;
      originSessionId?: number;
      replyTo?: MessageReplyTarget;
    },
  ): Promise<void> {
    const priority = options?.priority ?? this.inferPriority(event);
    const isSafety = this.isSafetyCategory(options?.category, priority);
    const isReply = isMessageEvent(event);
    const destinationMode = options?.destinationMode ?? "default";

    // Explicit reply target wins over the MessageEvent self-derivation.
    // WIKI_BUILDER_DESIGN.md §3.4-bis: events spawned from a bang command
    // (wiki.* directly, or scheduled.task via the approval queue) carry
    // `replyTo` so the completion DM lands back on the originating
    // channel rather than the user's proactive destinations. On adapter
    // failure (e.g. platform unregistered between bang and completion)
    // `deliverDirect` returns false, the failure is already logged with
    // a `failed` notification row, and we fall through to the proactive
    // path so the reply still reaches the operator.
    if (options?.replyTo) {
      const delivered = await this.deliverDirect(
        message,
        event,
        priority,
        options.replyTo,
      );
      if (delivered) return;
      logger.info(
        {
          eventType: event.type,
          replyPlatform: options.replyTo.platform,
        },
        "Direct reply target unreachable — falling back to proactive delivery",
      );
    }

    if (isReply) {
      await this.deliverReply(message, event as MessageEvent, priority);
      return;
    }

    // Batching check runs AFTER quiet-hours / rate-limit suppression so a
    // suppressed notification is never silently promoted into a queued one.
    if (
      !isSafety &&
      this.shouldBatch(event.type)
    ) {
      this.queueForBatch({
        message,
        event,
        priority,
        category: options?.category,
        destinationMode,
        originSessionId: options?.originSessionId,
      });
      return;
    }

    await this.deliverProactive({
      message,
      event,
      priority,
      category: options?.category,
      destinationMode,
      originSessionId: options?.originSessionId,
    });
  }

  /**
   * Direct reply to a MessageEvent — bypasses quiet-hours, rate-limits,
   * and batching.
   *
   * M4 (release-prep): bounded retry with exponential backoff to absorb
   * the transient platform-failure class (Slack 5xx, socket reset, WA
   * relay flap). The previous one-shot path silently swallowed those
   * errors, leaving the user with no acknowledgement of their DM while
   * `agent_actions` showed the turn as completed — the most common
   * user-visible symptom was "agent feels stuck; user resends; agent
   * double-runs the same turn".
   *
   * Final-fallback contract: when the originating platform refuses
   * every attempt, we route the same payload through the proactive
   * delivery path (`messageHub.sendToUser`) tagged as a safety-category
   * `"error"` so it bypasses quiet hours and rate limits. The owner
   * still hears about their reply on at least one channel they've
   * configured. `deliverProactive` catches its own errors, so this is
   * the terminal node — no further retry recursion.
   */
  private async deliverReply(
    message: string,
    event: MessageEvent,
    priority: string,
  ): Promise<void> {
    const target = {
      platform: event.platform,
      channel: event.channel,
      threadId: event.threadId,
    };
    for (let attempt = 1; attempt <= this.replyRetryAttempts; attempt++) {
      const delivered = await this.deliverDirect(message, event, priority, target);
      if (delivered) return;
      if (attempt < this.replyRetryAttempts) {
        const delay = this.replyRetryBackoffBaseMs * Math.pow(2, attempt - 1);
        logger.info(
          {
            attempt,
            nextDelayMs: delay,
            platform: target.platform,
            channel: target.channel,
            eventType: event.type,
          },
          "Reply delivery failed; backing off for retry",
        );
        if (delay > 0) await this.sleep(delay);
      }
    }
    logger.warn(
      {
        platform: target.platform,
        channel: target.channel,
        attempts: this.replyRetryAttempts,
        eventType: event.type,
      },
      "Reply delivery exhausted retries — falling back to proactive destinations",
    );
    // Final fallback. `category: "error"` puts this in
    // SAFETY_CATEGORIES so the proactive path skips both
    // `isQuietHours()` and `isRateLimited()` — the user is actively
    // waiting for a response and we must not silence the fallback.
    await this.deliverProactive({
      message,
      event,
      priority,
      category: "error",
      destinationMode: "default",
    });
  }

  /**
   * Shared direct-delivery primitive. Returns true on successful send,
   * false on failure (adapter missing, network rejection). The failure
   * branch logs the delivery row + error before returning — callers
   * can discard the boolean (`deliverReply` preserves the legacy
   * "fire-and-forget" MessageEvent-reply contract) or inspect it
   * (`send`'s explicit-replyTo path) to drive the §3.4-bis fallback to
   * the proactive destinations.
   */
  private async deliverDirect(
    message: string,
    event: Event,
    priority: string,
    target: MessageReplyTarget,
  ): Promise<boolean> {
    const dispatchId = randomUUID();
    const summary = truncateSummary(message);
    try {
      const delivery = await this.messageHub.sendToPlatform(
        target.platform,
        target.channel,
        message,
        target.threadId ?? undefined,
      );
      this.logNotificationRows({
        dispatchId,
        event,
        messageSummary: summary,
        priority,
        deliveries: [delivery],
        status: "delivered",
      });
      if (this.signalDetector) {
        this.signalDetector.trackNotification(
          `${dispatchId}:${delivery.platform}`,
          delivery.platform,
          message,
        );
      }
      return true;
    } catch (err) {
      if (!this.hasLoggedRowsForDispatch(dispatchId)) {
        this.logNotificationRows({
          dispatchId,
          event,
          messageSummary: summary,
          priority,
          deliveries: [],
          status: "failed",
        });
      }
      logger.error({ err }, "Failed to send notification");
      return false;
    }
  }

  /**
   * Core proactive delivery path. Checks quiet hours + rate limits, routes
   * to the MessageHub (either to-user or configured-only), logs delivery,
   * and fires SignalDetector tracking. Called both from a direct `send()`
   * and from {@link flushBatches}. `isSafety` lets safety-category
   * notifications bypass the suppression gates.
   */
  private async deliverProactive(params: {
    message: string;
    event: Event;
    priority: string;
    category: string | undefined;
    destinationMode: DestinationMode;
    originSessionId?: number;
    /** True when this call is draining a batch queue rather than an immediate send. */
    fromBatch?: boolean;
    batchDispatchIds?: string[];
    batchOriginSessionIds?: number[];
  }): Promise<void> {
    const {
      message,
      event,
      priority,
      category,
      destinationMode,
      originSessionId,
      fromBatch,
      batchDispatchIds,
      batchOriginSessionIds,
    } = params;
    const isSafety = this.isSafetyCategory(category, priority);
    const dispatchId = randomUUID();
    const summary = truncateSummary(message);

    if (!isSafety && this.isQuietHours()) {
      this.logNotificationRows({
        dispatchId,
        event,
        messageSummary: summary,
        priority,
        deliveries: [],
        status: "suppressed",
      });
      logger.info(
        { fromBatch: fromBatch ?? false, eventType: event.type },
        "Notification suppressed (quiet hours)",
      );
      return;
    }

    if (!isSafety && this.isRateLimited()) {
      this.logNotificationRows({
        dispatchId,
        event,
        messageSummary: summary,
        priority,
        deliveries: [],
        status: "suppressed",
      });
      logger.info(
        { fromBatch: fromBatch ?? false, eventType: event.type },
        "Notification suppressed (rate limit)",
      );
      return;
    }

    // P2-15: per-event-type secondary gate. Runs AFTER the global limiter
    // so suppression order is consistent (global → per-type). A burst of
    // the same type cannot starve unrelated notifications by exhausting
    // the global budget alone — both gates have to allow the send.
    if (!isSafety && this.isTypeRateLimited(event.type)) {
      this.logNotificationRows({
        dispatchId,
        event,
        messageSummary: summary,
        priority,
        deliveries: [],
        status: "suppressed",
      });
      logger.warn(
        { fromBatch: fromBatch ?? false, eventType: event.type },
        "Notification suppressed (per-type rate limit; check emitter for stuck loop)",
      );
      return;
    }

    try {
      const logContext = {
        dispatchId,
        notificationType: event.type,
        priority,
        contentSummary: summary,
      };
      const deliveries =
        destinationMode === "configured_only"
          ? await this.messageHub.sendToExactUserDestinations(
              message,
              this.config.defaultNotificationPlatforms,
              logContext,
            )
          : await this.messageHub.sendToUser(message, undefined, logContext);

      this.logNotificationRows({
        dispatchId,
        event,
        messageSummary: summary,
        priority,
        deliveries,
        status: "delivered",
      });
      recordProactiveForwardDeliveries({
        db: this.db,
        config: this.config,
        deliveries,
        content: message,
        dispatchId: fromBatch ? null : dispatchId,
        /* v8 ignore next 1 — batchDispatchIds/batchOriginSessionIds always present when fromBatch=true */
        dispatchIds: fromBatch ? batchDispatchIds ?? [] : [dispatchId],
        originSessionIds: fromBatch
          ? batchOriginSessionIds ?? /* v8 ignore next */ []
          : originSessionId !== undefined
            ? [originSessionId]
            : [],
        notificationType: fromBatch
          ? "proactive_forward_batched"
          : "proactive_forward",
      });
      // Record delivery time for per-event-type batching cooldown — but
      // ONLY for non-safety deliveries. Safety notifications (security /
      // deadline / error / critical) bypass batching on the way in, so
      // they must also not set the cooldown on the way out; otherwise a
      // critical alert would silently freeze subsequent normal
      // notifications of the same event type into the batch queue.
      if (!isSafety) {
        const now = Date.now();
        this.lastDeliveryAtMs.set(event.type, now);
        this.recordTypeDelivery(event.type, now);
      }

      if (this.signalDetector) {
        for (const delivery of deliveries) {
          this.signalDetector.trackNotification(
            `${dispatchId}:${delivery.platform}`,
            delivery.platform,
            message,
          );
        }
      }
    } catch (err) {
      if (!this.hasLoggedRowsForDispatch(dispatchId)) {
        this.logNotificationRows({
          dispatchId,
          event,
          messageSummary: summary,
          priority,
          deliveries: [],
          status: "failed",
        });
      }
      logger.error({ err }, "Failed to send notification");
    }
  }

  /**
   * Close out `notification_log` rows left in the `batched` state by a
   * prior daemon crash. The flush timer never re-fires after a crash —
   * the in-memory queue dies with the process — so the corresponding
   * `batched` row never transitions to `delivered` / `suppressed`. Without
   * this sweep, those rows accumulate forever and the dashboard's
   * notification feed shows ghost entries.
   *
   * 30-minute floor: the batch window is configurable but bounded; rows
   * younger than that may legitimately still be in-flight (cooldown not
   * yet elapsed) when the new daemon boots, so we only sweep what's
   * provably orphaned. Idempotent — re-running it is a no-op.
   *
   * Called once from the boot path (event-pipeline) before adapters
   * register, so the dashboard never sees the stale rows mid-recovery.
   */
  static closeStaleBatchedRows(db: Database.Database): { closed: number } {
    const result = db
      .prepare(
        `UPDATE notification_log
            SET status = 'suppressed',
                delivered_at = CURRENT_TIMESTAMP
          WHERE status = 'batched'
            AND created_at < datetime('now', '-30 minutes')`,
      )
      .run();
    if (result.changes > 0) {
      logger.warn(
        { closed: result.changes },
        "Closed stale batched notification rows from prior crash",
      );
    }
    return { closed: result.changes };
  }

  /**
   * Cancel any pending batch flush. Called on daemon shutdown.
   *
   * Trade-off: queued messages stay in `batchSlots` (memory) and are lost on
   * restart — the corresponding `batched` rows in `notification_log` then
   * have no matching `delivered`/`suppressed` follow-up. We accept this
   * rather than racing a flush during shutdown (flushing calls into the
   * MessageHub which is itself being torn down). Operators investigating
   * orphan `batched` rows should check daemon restart timestamps.
   */
  stop(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }

  /** True when batching is enabled and an in-window prior delivery exists. */
  private shouldBatch(eventType: string): boolean {
    const intervalMs = this.batchIntervalMs();
    if (intervalMs <= 0) return false;
    const lastMs = this.lastDeliveryAtMs.get(eventType);
    if (lastMs === undefined) return false;
    return Date.now() - lastMs < intervalMs;
  }

  private batchIntervalMs(): number {
    const minutes = this.config.batchIntervalMinutes;
    if (!Number.isFinite(minutes) || minutes <= 0) return 0;
    return minutes * 60_000;
  }

  /**
   * Append a proactive notification to its event-type queue and log a
   * `batched` row so the operator can see what was held. A flush timer is
   * armed for the earliest queue's due time; subsequent enqueues reuse it.
   */
  private queueForBatch(params: {
    message: string;
    event: Event;
    priority: string;
    category: string | undefined;
    destinationMode: DestinationMode;
    originSessionId?: number;
  }): void {
    const { message, event, priority, category, destinationMode, originSessionId } = params;
    const summary = truncateSummary(message);
    const dispatchId = randomUUID();
    this.logNotificationRows({
      dispatchId,
      event,
      messageSummary: summary,
      priority,
      deliveries: [],
      status: "batched",
    });

    const existing = this.batchSlots.get(event.type);
    if (existing) {
      existing.messages.push(message);
      existing.dispatchIds.push(dispatchId);
      if (originSessionId !== undefined) {
        existing.originSessionIds.push(originSessionId);
      }
    } else {
      this.batchSlots.set(event.type, {
        firstQueuedAtMs: Date.now(),
        messages: [message],
        dispatchIds: [dispatchId],
        originSessionIds: originSessionId !== undefined ? [originSessionId] : [],
        event,
        priority,
        category,
        destinationMode,
      });
    }
    this.scheduleBatchFlush();
  }

  private scheduleBatchFlush(): void {
    if (this.flushTimer) return;
    if (this.batchSlots.size === 0) return;
    const intervalMs = this.batchIntervalMs();
    if (intervalMs <= 0) return;

    const now = Date.now();
    let earliest = Infinity;
    for (const eventType of this.batchSlots.keys()) {
      /* v8 ignore next 1 — lastDeliveryAtMs always set when eventType is in batchSlots */
      const lastMs = this.lastDeliveryAtMs.get(eventType) ?? 0;
      const dueAt = lastMs + intervalMs;
      if (dueAt < earliest) earliest = dueAt;
    }
    // P2-17: if quiet hours are currently active, push the next flush
    // attempt to the wall-clock moment they end. Without this guard,
    // `flushBatches` would fire on the cooldown timer, hit `isQuietHours()`
    // inside `deliverProactive`, and log the queued batch as `suppressed`
    // — the user loses the message entirely instead of receiving it the
    // moment quiet hours lift. `nextQuietHoursEndMs()` returns null when
    // quiet hours are not configured or already over.
    const quietEnd = this.isQuietHours() ? this.nextQuietHoursEndMs() : null;
    const effective = quietEnd !== null && quietEnd > earliest ? quietEnd : earliest;
    const delay = Math.max(0, effective - now);
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flushBatches();
    }, delay);
    if (typeof this.flushTimer.unref === "function") {
      this.flushTimer.unref();
    }
  }

  /**
   * Flush every queue whose cooldown window has elapsed. Each due slot is
   * delivered as a single combined message (two-blank-line joined). Queues
   * that are still within their window are left for a later timer fire; the
   * timer is rearmed at the new earliest due time.
   */
  private async flushBatches(): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;
    try {
      const intervalMs = this.batchIntervalMs();
      if (intervalMs <= 0) {
        this.batchSlots.clear();
        return;
      }
      const now = Date.now();
      const due: Array<{ eventType: string; slot: BatchSlot }> = [];
      for (const [eventType, slot] of this.batchSlots) {
        /* v8 ignore next 1 — lastDeliveryAtMs always set when eventType is in batchSlots */
        const lastMs = this.lastDeliveryAtMs.get(eventType) ?? 0;
        if (now - lastMs >= intervalMs) {
          due.push({ eventType, slot });
        }
      }
      for (const { eventType, slot } of due) {
        this.batchSlots.delete(eventType);
        const combined = slot.messages.join("\n\n");
        await this.deliverProactive({
          message: combined,
          event: slot.event,
          priority: slot.priority,
          category: slot.category,
          destinationMode: slot.destinationMode,
          fromBatch: true,
          batchDispatchIds: slot.dispatchIds,
          batchOriginSessionIds: slot.originSessionIds,
        });
      }
    } finally {
      this.flushing = false;
      this.scheduleBatchFlush();
    }
  }

  /**
   * P2-17 helper. Returns ms-since-epoch when the current quiet-hours
   * window ends, or null when quiet hours are not active. Used by
   * {@link scheduleBatchFlush} to defer pending batches past the
   * quiet-hours boundary so they actually deliver instead of being
   * suppressed at flush time. Walks forward minute-by-minute (capped at
   * 24 h) so configured timezone + overnight windows stay correct
   * without re-deriving the boundary math here.
   */
  private nextQuietHoursEndMs(): number | null {
    if (!this.isQuietHoursAt(new Date())) return null;
    const startMs = Date.now();
    for (let minutes = 1; minutes <= 24 * 60; minutes++) {
      const probeAt = new Date(startMs + minutes * 60_000);
      if (!this.isQuietHoursAt(probeAt)) return probeAt.getTime();
    }
    return null;
  }

  /** Check if current time is within quiet hours (uses configured timezone) */
  isQuietHours(): boolean {
    return this.isQuietHoursAt(new Date());
  }

  /**
   * Quiet-hours predicate evaluated against an arbitrary wall-clock
   * instant. Extracted from {@link isQuietHours} so {@link nextQuietHoursEndMs}
   * can probe future times without mutating globals.
   */
  private isQuietHoursAt(at: Date): boolean {
    const local = nowInTimezone(this.config.timezone || undefined, at);
    const currentMinutes = local.hours * 60 + local.minutes;
    const [startH, startM] = this.config.quietHoursStart.split(":").map(Number);
    const [endH, endM] = this.config.quietHoursEnd.split(":").map(Number);
    const startMinutes = startH * 60 + startM;
    const endMinutes = endH * 60 + endM;

    if (startMinutes <= endMinutes) {
      // Same day range (e.g., 09:00-17:00)
      return currentMinutes >= startMinutes && currentMinutes < endMinutes;
    }
    // Overnight range (e.g., 23:00-07:00)
    return currentMinutes >= startMinutes || currentMinutes < endMinutes;
  }

  /** Check if hourly or daily notification limits have been reached */
  private isRateLimited(): boolean {
    // Hourly check
    const hourlyCount = this.db
      .prepare(
        `SELECT COUNT(DISTINCT CASE
             WHEN dispatch_id != '' THEN dispatch_id
             ELSE CAST(id AS TEXT)
           END) as cnt
         FROM notification_log
         WHERE status = 'delivered'
           AND COALESCE(notification_type, '') != 'message.received'
           AND created_at > datetime('now', '-1 hour')`,
      )
      .get() as { cnt: number };

    if (hourlyCount.cnt >= this.config.maxNotificationsPerHour) {
      return true;
    }

    // Daily check (timezone-aware agent day)
    const bounds = getAgentDayBoundsUtc(this.config.timezone, this.config.dayBoundaryHour);
    const dailyCount = this.db
      .prepare(
        `SELECT COUNT(DISTINCT CASE
             WHEN dispatch_id != '' THEN dispatch_id
             ELSE CAST(id AS TEXT)
           END) as cnt
         FROM notification_log
         WHERE status = 'delivered'
           AND COALESCE(notification_type, '') != 'message.received'
           AND created_at >= ? AND created_at < ?`,
      )
      .get(bounds.start, bounds.end) as { cnt: number };

    return dailyCount.cnt >= this.config.maxNotificationsPerDay;
  }

  /**
   * P2-15 per-type gate. True when this event type has hit
   * {@link PER_TYPE_RATE_LIMIT} deliveries in the trailing
   * {@link PER_TYPE_RATE_WINDOW_MS}. Trims expired timestamps inline so
   * the ring buffer stays bounded.
   */
  private isTypeRateLimited(eventType: string): boolean {
    const now = Date.now();
    const cutoff = now - PER_TYPE_RATE_WINDOW_MS;
    const recent = this.perTypeDeliveryWindow.get(eventType);
    if (!recent) return false;
    // Trim in place — `recent` is the live array referenced by the map.
    while (recent.length > 0 && recent[0] < cutoff) recent.shift();
    if (recent.length === 0) {
      this.perTypeDeliveryWindow.delete(eventType);
      return false;
    }
    return recent.length >= PER_TYPE_RATE_LIMIT;
  }

  private recordTypeDelivery(eventType: string, atMs: number): void {
    const existing = this.perTypeDeliveryWindow.get(eventType);
    if (existing) {
      existing.push(atMs);
    } else {
      this.perTypeDeliveryWindow.set(eventType, [atMs]);
    }
  }

  /** Check if the notification falls under a safety category */
  private isSafetyCategory(
    category: string | undefined,
    priority: string,
  ): boolean {
    if (category && (SAFETY_CATEGORIES as readonly string[]).includes(category)) {
      return true;
    }
    return priority === "critical";
  }

  /** Infer notification priority from event */
  private inferPriority(event: Event): string {
    switch (event.priority) {
      case 0:
        return "critical";
      case 1:
        return "high";
      case 2:
        return "normal";
      default:
        return "low";
    }
  }

  private hasLoggedRowsForDispatch(dispatchId: string): boolean {
    const row = this.db
      .prepare(
        `SELECT id
         FROM notification_log
         WHERE dispatch_id = ?
         LIMIT 1`,
      )
      .get(dispatchId) as { id: number } | undefined;
    return !!row;
  }

  private logNotificationRows(params: {
    dispatchId: string;
    event: Event;
    messageSummary: string;
    priority: string;
    deliveries: { platform: string; channel: string; messageId?: string }[];
    status: "delivered" | "batched" | "suppressed" | "failed";
  }): void {
    const {
      dispatchId,
      event,
      messageSummary,
      priority,
      deliveries,
      status,
    } = params;

    try {
      const deliveredAtSql = status === "delivered" ? "CURRENT_TIMESTAMP" : "NULL";
      if (deliveries.length === 0) {
        const platform = isMessageEvent(event)
          ? event.platform
          : this.config.primaryPlatform;
        this.db
          .prepare(
            `INSERT INTO notification_log (
               dispatch_id,
               notification_type,
               priority,
               platform,
               content_summary,
               status,
               created_at,
               delivered_at
             )
             VALUES (
               ?, ?, ?, ?, ?, ?,
               CURRENT_TIMESTAMP,
               ${deliveredAtSql}
             )`,
          )
          .run(dispatchId, event.type, priority, platform, messageSummary, status);
        return;
      }

      const insert = this.db.prepare(
        `INSERT INTO notification_log (
           dispatch_id,
           notification_type,
           priority,
           platform,
           delivery_channel,
           delivery_message_id,
           content_summary,
           status,
           created_at,
           delivered_at
         )
         VALUES (
           ?, ?, ?, ?, ?, ?, ?, ?,
           CURRENT_TIMESTAMP,
           ${deliveredAtSql}
         )`,
      );

      for (const delivery of deliveries) {
        insert.run(
          dispatchId,
          event.type,
          priority,
          delivery.platform,
          delivery.channel,
          delivery.messageId ?? null,
          messageSummary,
          status,
        );
      }
    } catch (err) {
      logger.error({ err }, "Failed to log notification");
    }
  }
}
