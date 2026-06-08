import type Database from "better-sqlite3";
import type { AgentConfig } from "../config.js";
import { formatSqliteDatetime, redactSensitiveString } from "@aitne/shared";
import {
  hasFeedbackSignalForAction,
  recordFeedbackSignal,
  type FeedbackSignalValence,
} from "../db/feedback-signals-store.js";
import { createLogger } from "../logging.js";
import { resolveAgentId } from "./agents/agent-id-resolver.js";

const logger = createLogger("signal-detector");

/**
 * Raw signal entry that gets appended to user/profile.md ## Raw Signals section.
 */
interface RawSignal {
  timestamp: string;
  type: "reaction" | "ignore" | "correction";
  detail: string;
}

type NotificationReaction = "replied" | "ignored" | "acted" | "corrected";

interface PendingNotificationInfo {
  sentAt: number;
  platform: string;
  channel: string | null;
  content: string;
  dispatchId: string | null;
  notificationType: string | null;
  agentId: string | null;
}

interface NotificationMetadata {
  dispatchId: string | null;
  platform: string | null;
  channel: string | null;
  notificationType: string | null;
  contentSummary: string | null;
  agentId: string | null;
  rowId: number | null;
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
  private readonly pendingNotifications = new Map<string, PendingNotificationInfo>();

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
    private readonly deps: { db?: Database.Database } = {},
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
    const metadata = this.lookupNotificationMetadata(notificationId);
    this.pendingNotifications.set(notificationId, {
      sentAt: Date.now(),
      // Single fallback to the delivered platform here, not redundantly inside
      // the lookup — the tracked id's suffix is the delivery platform anyway.
      platform: metadata.platform ?? platform,
      channel: metadata.channel,
      content: (metadata.contentSummary ?? content).slice(0, 100), // Truncate for signal log
      dispatchId: metadata.dispatchId,
      notificationType: metadata.notificationType,
      agentId: metadata.agentId,
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
      const pendingId = this.resolvePendingNotificationId(params.notificationId);
      this.pendingNotifications.delete(pendingId);
      this.recordNotificationOutcome({
        notificationId: pendingId,
        reaction: "replied",
        valence: "positive",
        evidence: {
          emoji,
          responseTimeMs,
          weight: 0.5,
        },
      });
    }

    const signal: RawSignal = {
      timestamp: formatSqliteDatetime(new Date()),
      type: "reaction",
      detail:
        `${emoji} on ${platform}`
        + `${responseTimeMs ? ` (${Math.round(responseTimeMs / 1000)}s)` : ""}`,
    };

    void this.appendSignal(signal);
  }

  /**
   * Record a user message (for reply length and correction detection).
   * Called by the dispatcher after receiving a user message.
   */
  onUserMessage(params: {
    platform: string;
    channel?: string;
    content: string;
    responseToNotificationId?: string;
  }): void {
    const { content, responseToNotificationId } = params;
    const pendingNotificationId = responseToNotificationId
      ? this.resolvePendingNotificationId(responseToNotificationId)
      : this.findPendingNotificationForReply(params.platform, params.channel);

    // Remove from pending (user responded)
    if (pendingNotificationId) {
      this.pendingNotifications.delete(pendingNotificationId);
    }

    // Detect correction instructions
    const isCorrection = SignalDetector.isCorrectionContent(content);
    if (pendingNotificationId) {
      this.recordNotificationOutcome({
        notificationId: pendingNotificationId,
        reaction: isCorrection ? "corrected" : "replied",
        valence: isCorrection ? "correction" : "positive",
        evidence: {
          excerpt: content.slice(0, 160),
          weight: isCorrection ? 1.0 : 0.5,
        },
      });
    }

    if (isCorrection) {
      const signal: RawSignal = {
        timestamp: formatSqliteDatetime(new Date()),
        type: "correction",
        detail: `"${content.slice(0, 60)}"`,
      };
      void this.appendSignal(signal);
      return; // Only log the first matching correction
    }
  }

  /**
   * Record a positive action correlated with a notification. This is the
   * narrow "acted" path: callers must have an actual task/action observation,
   * never silence, before invoking it.
   *
   * NOTE — intentional Phase-1.5 seam, no production caller yet (by design).
   * Firing `acted` deterministically needs the notification's subject
   * `(source, ref)` in `pendingNotifications` to match a later observation,
   * but that subject never reaches `trackNotification`: entity-related
   * proactive DMs are re-authored by an agent turn and delivered via
   * `POST /api/agent/notify`, which carries only message/platform/priority
   * (no subject), and the direct `NotificationManager.send()` paths carry
   * `data:{}`. So this stays correct + silence-safe but dormant — do NOT
   * wire it from a silence- or substring-heuristic source (that re-opens the
   * sign-inversion the promotion gate exists to kill). The loop is complete
   * without it (`explicit` + `replied` drive promotion). See
   * FEEDBACK_LEARNING_LOOP_DESIGN.md §11 v1.9#2 + v1.11.
   */
  onNotificationActed(params: {
    notificationId: string;
    actionRef?: string;
    detail?: string;
  }): void {
    const pendingId = this.resolvePendingNotificationId(params.notificationId);
    this.pendingNotifications.delete(pendingId);
    this.recordNotificationOutcome({
      notificationId: pendingId,
      reaction: "acted",
      valence: "positive",
      evidence: {
        actionRef: params.actionRef,
        detail: params.detail,
        weight: 0.5,
      },
    });
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
        this.recordNotificationOutcome({
          notificationId: id,
          reaction: "ignored",
          valence: "neutral",
          evidence: {
            elapsedMs: elapsed,
            weight: 0.25,
            initiatesLesson: false,
          },
        });
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

      logger.debug(
        { signal: entry },
        "Raw signal appended to user/profile.md via API",
      );
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

  private static isCorrectionContent(content: string): boolean {
    const correctionPatterns = [
      /shorter|brief|concise/i,
      /more detail|elaborate|expand/i,
      /\bin (english|spanish|french|german|portuguese|italian|chinese|japanese|korean|arabic|hindi|russian)\b/i,
      /bullet points|bulleted list/i,
      /\b(stop|no)\b.*\b(notify|message|remind|send|doing|do|again|that)\b/i,
      /\b(do not|don't)\b/i,
    ];
    return correctionPatterns.some((pattern) => pattern.test(content));
  }

  private findPendingNotificationForReply(
    platform: string,
    channel?: string,
  ): string | null {
    const now = Date.now();
    let candidate: { id: string; sentAt: number } | null = null;
    for (const [id, info] of this.pendingNotifications) {
      if (info.platform !== platform) continue;
      if (channel && info.channel && info.channel !== channel) continue;
      if (now - info.sentAt > this.ignoreThresholdMs) continue;
      if (candidate === null || info.sentAt > candidate.sentAt) {
        candidate = { id, sentAt: info.sentAt };
      }
    }
    return candidate?.id ?? null;
  }

  private resolvePendingNotificationId(notificationId: string): string {
    if (this.pendingNotifications.has(notificationId)) return notificationId;
    for (const id of this.pendingNotifications.keys()) {
      if (id.startsWith(`${notificationId}:`)) return id;
    }
    return notificationId;
  }

  private lookupNotificationMetadata(
    notificationId: string,
  ): NotificationMetadata {
    const parsed = SignalDetector.parseTrackedNotificationId(notificationId);
    if (!this.deps.db || !parsed.dispatchId) {
      return {
        dispatchId: parsed.dispatchId,
        platform: parsed.platform,
        channel: null,
        notificationType: null,
        contentSummary: null,
        agentId: null,
        rowId: null,
      };
    }
    const platformValue = parsed.platform;
    const platformPredicate = platformValue ? "AND platform = ?" : "";
    const values = platformValue
      ? [parsed.dispatchId, platformValue]
      : [parsed.dispatchId];
    const row = this.deps.db
      .prepare(
        `SELECT id, dispatch_id, platform, delivery_channel, notification_type, content_summary
         FROM notification_log
         WHERE dispatch_id = ? ${platformPredicate}
         ORDER BY id DESC
         LIMIT 1`,
      )
      .get(...values) as
      | {
          id: number;
          dispatch_id: string;
          platform: string | null;
          delivery_channel: string | null;
          notification_type: string | null;
          content_summary: string | null;
        }
      | undefined;
    const notificationType = row?.notification_type ?? null;
    return {
      dispatchId: row?.dispatch_id ?? parsed.dispatchId,
      platform: row?.platform ?? parsed.platform,
      channel: row?.delivery_channel ?? null,
      notificationType,
      contentSummary: row?.content_summary ?? null,
      agentId: this.resolveAgentIdForNotification(notificationType),
      rowId: row?.id ?? null,
    };
  }

  private resolveAgentIdForNotification(
    notificationType: string | null,
  ): string | null {
    if (!this.deps.db || !notificationType?.startsWith("routine.")) return null;
    // Runs only after a successful notification_log read on the same db, so a
    // connection failure would already have surfaced upstream; the registry
    // lookup + agents existence check are deterministic over a valid handle.
    return resolveAgentId(this.deps.db, {
      routine: notificationType.slice("routine.".length),
    });
  }

  private recordNotificationOutcome(params: {
    notificationId: string;
    reaction: NotificationReaction;
    valence: FeedbackSignalValence;
    evidence: Record<string, unknown>;
  }): void {
    const db = this.deps.db;
    if (this.config.feedbackLearningEnabled === false || !db) return;
    // One guard for the whole behavioral-capture path: the reaction backfill,
    // dedup probe, and signal insert all touch the same connection, so a single
    // catch keeps a DB hiccup from crashing the background detector loop
    // without leaving the reaction column write unguarded.
    try {
      const metadata = this.lookupNotificationMetadata(params.notificationId);
      const dispatchId = metadata.dispatchId;
      if (!dispatchId) return;

      this.updateNotificationReaction(db, dispatchId, metadata.platform, params.reaction);
      if (
        hasFeedbackSignalForAction(db, {
          source: "behavioral",
          actionKind: "notification",
          actionRef: dispatchId,
          valence: params.valence,
          userReaction: params.reaction,
        })
      ) {
        return;
      }

      const scopeType = metadata.agentId ? "agent_slug" : "agent";
      const summary = this.buildOutcomeSummary(params.reaction, metadata);
      const evidence = this.sanitizeEvidence({
        ...params.evidence,
        userReaction: params.reaction,
        notificationLogId: metadata.rowId,
        notificationType: metadata.notificationType,
        platform: metadata.platform,
        contentSummary: metadata.contentSummary,
      });
      recordFeedbackSignal(db, {
        source: "behavioral",
        valence: params.valence,
        scopeType,
        scopeRef: metadata.agentId,
        actionKind: "notification",
        actionRef: dispatchId,
        agentId: metadata.agentId,
        summary,
        evidence,
      });
    } catch (err) {
      logger.warn(
        { err, notificationId: params.notificationId, reaction: params.reaction },
        "Failed to record notification outcome",
      );
    }
  }

  private updateNotificationReaction(
    db: Database.Database,
    dispatchId: string,
    platform: string | null,
    reaction: NotificationReaction,
  ): void {
    if (platform) {
      db.prepare(
        `UPDATE notification_log
           SET user_reaction = ?, reacted_at = CURRENT_TIMESTAMP
           WHERE dispatch_id = ? AND platform = ?`,
      ).run(reaction, dispatchId, platform);
      return;
    }
    db.prepare(
      `UPDATE notification_log
         SET user_reaction = ?, reacted_at = CURRENT_TIMESTAMP
         WHERE dispatch_id = ?`,
    ).run(reaction, dispatchId);
  }

  private buildOutcomeSummary(
    reaction: NotificationReaction,
    metadata: NotificationMetadata,
  ): string {
    const content = metadata.contentSummary
      ? ` "${metadata.contentSummary}"`
      : "";
    const notificationType = metadata.notificationType
      ? ` (${metadata.notificationType})`
      : "";
    const raw = reaction === "ignored"
      ? `Owner did not respond to notification${content}${notificationType}`
      : reaction === "corrected"
        ? `Owner corrected notification${content}${notificationType}`
        : reaction === "acted"
          ? `Owner acted on notification${content}${notificationType}`
          : `Owner responded to notification${content}${notificationType}`;
    return redactSensitiveString(raw.replace(/\s+/g, " ").trim()).slice(0, 280);
  }

  private sanitizeEvidence(
    value: Record<string, unknown>,
  ): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (entry === undefined) continue;
      if (typeof entry === "string") {
        out[key] = redactSensitiveString(
          entry.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 500),
        );
      } else {
        out[key] = entry;
      }
    }
    return out;
  }

  private static parseTrackedNotificationId(
    notificationId: string,
  ): { dispatchId: string | null; platform: string | null } {
    const idx = notificationId.indexOf(":");
    if (idx <= 0) return { dispatchId: notificationId || null, platform: null };
    return {
      dispatchId: notificationId.slice(0, idx),
      platform: notificationId.slice(idx + 1) || null,
    };
  }
}
