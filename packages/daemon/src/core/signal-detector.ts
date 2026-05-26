import type { AgentConfig } from "../config.js";
import { formatSqliteDatetime } from "@aitne/shared";
import { createLogger } from "../logging.js";

const logger = createLogger("signal-detector");

/**
 * Raw signal entry that gets appended to user/profile.md ## Raw Signals section.
 */
interface RawSignal {
  timestamp: string;
  type: "reaction" | "ignore" | "correction";
  detail: string;
}

/**
 * Maximum number of Raw Signal entries kept in user/profile.md. Prevents
 * unbounded growth when Evening Review doesn't run or fails.
 * Since user/profile.md is injected into every session prompt, capping this
 * directly bounds token cost inflation.
 */
const MAX_RAW_SIGNALS = 20;

/**
 * TTL for dedup cache entries (10 minutes). Identical signals within
 * this window are suppressed.
 */
const DEDUP_TTL_MS = 10 * 60 * 1000;

/**
 * SignalDetector — collects implicit user feedback signals (no LLM required).
 *
 * Detects behavioral patterns from messaging platforms and appends
 * structured entries to user/profile.md's "Raw Signals" section via the
 * Context File API (PATCH /api/context/identity/profile).
 *
 * All writes go through the Daemon's own HTTP API to:
 * - Respect the Context File API mutex (no race conditions)
 * - Trigger md_file_snapshots backup
 * - Respect Morning Routine write lock
 *
 * Signals are later interpreted by the Evening Review (Opus) which
 * integrates them into "Learned Context" and clears Raw Signals.
 *
 * Detected signals:
 * - Message reactions (thumbs up/down, emoji)
 * - Message ignore (no response within threshold)
 * - Read speed (how fast user reacts)
 * - Reply length tendency
 * - Correction instructions ("shorter", "more detail", etc.)
 */
export class SignalDetector {
  /** Track pending notifications for ignore detection */
  private readonly pendingNotifications = new Map<
    string,
    { sentAt: number; platform: string; content: string }
  >();

  /** Rolling dedup cache: signal key → expiry timestamp */
  private readonly recentSignals = new Map<string, number>();

  /** Timeout for "ignore" detection (default: 30 minutes) */
  private readonly ignoreThresholdMs: number;

  /** Interval handle for the ignore checker */
  private ignoreCheckInterval: ReturnType<typeof setInterval> | null = null;

  /** API base URL for Context File API (self-referencing) */
  private readonly apiBaseUrl: string;

  constructor(
    private readonly config: AgentConfig,
  ) {
    this.ignoreThresholdMs = 30 * 60 * 1000; // 30 minutes
    this.apiBaseUrl = `http://localhost:${config.apiPort}`;
  }

  /** Start the signal detector (periodic ignore check) */
  start(): void {
    // Check for ignored messages every 5 minutes
    this.ignoreCheckInterval = setInterval(
      () => this.checkIgnoredMessages(),
      5 * 60 * 1000,
    );
    logger.info("Signal detector started");
  }

  /** Stop the signal detector */
  stop(): void {
    if (this.ignoreCheckInterval) {
      clearInterval(this.ignoreCheckInterval);
      this.ignoreCheckInterval = null;
    }
    logger.info("Signal detector stopped");
  }

  /**
   * Record that a notification was sent (for ignore tracking).
   * Called by NotificationManager after successful delivery.
   */
  trackNotification(
    notificationId: string,
    platform: string,
    content: string,
  ): void {
    this.pendingNotifications.set(notificationId, {
      sentAt: Date.now(),
      platform,
      content: content.slice(0, 100), // Truncate for signal log
    });
  }

  /**
   * Record a user reaction (emoji, thumbs up/down, etc.).
   * Called by messaging adapters when they detect reactions.
   */
  onReaction(params: {
    platform: string;
    notificationId?: string;
    emoji: string;
    responseTimeMs?: number;
  }): void {
    const { platform, emoji, responseTimeMs } = params;

    // Remove from pending (user responded)
    if (params.notificationId) {
      this.pendingNotifications.delete(params.notificationId);
    }

    const signal: RawSignal = {
      timestamp: formatSqliteDatetime(new Date()),
      type: "reaction",
      detail: `${emoji} on ${platform}${responseTimeMs ? ` (${Math.round(responseTimeMs / 1000)}s)` : ""}`,
    };

    void this.appendSignal(signal);
  }

  /**
   * Record a user message (for reply length and correction detection).
   * Called by the dispatcher after receiving a user message.
   */
  onUserMessage(params: {
    platform: string;
    content: string;
    responseToNotificationId?: string;
  }): void {
    const { content, responseToNotificationId } = params;

    // Remove from pending (user responded)
    if (responseToNotificationId) {
      this.pendingNotifications.delete(responseToNotificationId);
    }

    // Detect correction instructions
    const correctionPatterns = [
      /shorter|brief|concise/i,
      /more detail|elaborate|expand/i,
      /\bin (english|spanish|french|german|portuguese|italian|chinese|japanese|korean|arabic|hindi|russian)\b/i,
      /bullet points|bulleted list/i,
    ];

    for (const pattern of correctionPatterns) {
      if (pattern.test(content)) {
        const signal: RawSignal = {
          timestamp: formatSqliteDatetime(new Date()),
          type: "correction",
          detail: `"${content.slice(0, 60)}"`,
        };
        void this.appendSignal(signal);
        return; // Only log the first matching correction
      }
    }
  }

  /** Check for messages that have been ignored (no response within threshold) */
  private checkIgnoredMessages(): void {
    const now = Date.now();
    const toRemove: string[] = [];

    for (const [id, info] of this.pendingNotifications) {
      const elapsed = now - info.sentAt;
      if (elapsed > this.ignoreThresholdMs) {
        const signal: RawSignal = {
          timestamp: formatSqliteDatetime(new Date(info.sentAt)),
          type: "ignore",
          detail: `${info.platform}: "${info.content}" unread for ${Math.round(elapsed / 60000)}min`,
        };
        void this.appendSignal(signal);
        toRemove.push(id);
      }
    }

    for (const id of toRemove) {
      this.pendingNotifications.delete(id);
    }
  }

  /**
   * Append a raw signal to user/profile.md's "## Raw Signals" section
   * via the Context File API (PATCH /api/context/identity/profile).
   *
   * Uses the Daemon's own HTTP API to ensure:
   * - Write serialization via context mutex
   * - Automatic md_file_snapshots backup
   * - Morning Routine write lock is respected
   *
   * Includes dedup (identical signals within DEDUP_TTL_MS are suppressed)
   * and maxEntries cap (oldest entries trimmed by the API when over limit).
   */
  private async appendSignal(signal: RawSignal): Promise<void> {
    // Dedup: skip if an identical signal was recorded recently.
    // Normalize away dynamic suffixes (elapsed time, response time) so
    // the same logical event isn't recorded twice with different numbers.
    const dedupKey = SignalDetector.normalizeDedupKey(signal);
    const now = Date.now();
    this.pruneExpiredDedup(now);
    if (this.recentSignals.has(dedupKey)) {
      logger.debug({ dedupKey }, "Duplicate signal suppressed");
      return;
    }
    this.recentSignals.set(dedupKey, now + DEDUP_TTL_MS);

    const entry = `- [${signal.timestamp}] [${signal.type}] ${signal.detail}`;

    try {
      const response = await fetch(
        `${this.apiBaseUrl}/api/context/identity/profile`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            section: "raw_signals",
            mode: "append",
            content: entry,
            maxEntries: MAX_RAW_SIGNALS,
          }),
        },
      );

      if (!response.ok) {
        const body = await response.text();
        logger.warn(
          { status: response.status, body },
          "Context API rejected signal append",
        );
        // Remove from dedup cache so retry is possible
        this.recentSignals.delete(dedupKey);
        return;
      }

      logger.debug({ signal: entry }, "Raw signal appended to user/profile.md via API");
    } catch (err) {
      logger.error({ err }, "Failed to append signal via Context API");
      this.recentSignals.delete(dedupKey);
    }
  }

  /**
   * Build a stable dedup key by stripping dynamic suffixes that vary
   * for the same logical event (e.g. "unread for 32min" vs "37min").
   */
  static normalizeDedupKey(signal: RawSignal): string {
    let detail = signal.detail;
    detail = detail.replace(/ unread for \d+min$/, "");
    detail = detail.replace(/ \(\d+s\)/, "");
    return `${signal.type}:${detail}`;
  }

  /** Remove expired entries from the dedup cache */
  private pruneExpiredDedup(now: number): void {
    for (const [key, expiry] of this.recentSignals) {
      if (expiry <= now) {
        this.recentSignals.delete(key);
      }
    }
  }
}
