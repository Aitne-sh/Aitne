import type Database from "better-sqlite3";
import type { Observer } from "./manager.js";
import type { MailAccountRegistry } from "../services/mail/account-registry.js";
import type {
  MailAccount,
  MailMessageSummary,
  MailProvider,
  MailProviderKind,
  PollCursor,
} from "../services/mail/provider.js";
import { recordObservation } from "../db/observations.js";
import type { AgentWriteTracker } from "../safety/agent-write-tracker.js";
import {
  classifyAuthFailure,
  effectiveAuthStatus,
} from "../services/mail/outlook/auth-failure-classifier.js";
import {
  classifyImapAuthFailure,
  effectiveImapAuthStatus,
} from "../services/mail/imap/auth-failure-classifier.js";
import {
  classifyGmailAuthFailure,
  effectiveGmailAuthStatus,
} from "../services/mail/gmail/auth-failure-classifier.js";
import { GraphError } from "../services/mail/outlook/graph-client.js";
import { createLogger } from "../logging.js";
import type { IdleCapableMailProvider } from "../services/mail/imap/imap-provider-base.js";
import { processMailBatch } from "../services/mail-classifier.js";
import { isIntegrationPollerless } from "../core/integration-lifecycle.js";
import {
  emptyIngestionStats,
  processClassifiedMailBatch,
  type MailIngestionStats,
} from "../services/mail-ingestion.js";
import type { TriggerRoadmapRefresh } from "../core/roadmap-refresh-triggers.js";

const logger = createLogger("mail-poller");

export interface MailPollerOptions {
  registry: MailAccountRegistry;
  db: Database.Database;
  writeTracker: AgentWriteTracker;
  pollIntervalSeconds: number;
  maxMessagesPerPoll: number;
  /**
   * DM dispatch for `requires_consent` accounts. Optional — when omitted, the
   * poller still marks the auth status, but no notification is sent.
   */
  notifyOwner?: (message: string) => Promise<void>;
  /**
   * Hours between consecutive `requires_consent` re-consent DMs for the same
   * account, per `mailAuthFailureRetryHours` (§3.7). Default 6.
   */
  authFailureRetryHours?: number;
  /**
   * Optional roadmap-refresh trigger (ROADMAP-REDESIGN §3.4 RFC-C). When
   * set, a travel-booking INSERT whose `start_date > now + 3d` fires this
   * callback; the dispatcher side dedupes bursts.
   */
  triggerRoadmapRefresh?: TriggerRoadmapRefresh;
  /**
   * Optional per-provider-kind poll throttle, in seconds. The unified poller
   * ticks every `pollIntervalSeconds`, but a kind with a throttle is skipped
   * on intermediate ticks until at least `providerPollIntervalsSeconds[kind]`
   * seconds have elapsed since that kind last polled. Accounts of kinds
   * without a throttle (or with `0`) are polled on every tick. IMAP IDLE
   * onDirty callbacks bypass this throttle — they're already demand-driven.
   */
  providerPollIntervalsSeconds?: Partial<Record<MailProviderKind, number>>;
}

interface ReconsentDmState {
  lastSentAtMs: number;
}

/**
 * Unified mail poller (§3.4). Iterates over `registry.listActiveAccounts()`
 * and calls `provider.pollSince()` per account, recording one aggregated
 * observation per account per tick. Re-pages immediately when the provider
 * reports `drained=false`.
 *
 * Per-account isolation: a failure on one account never blocks the others.
 * The {@link AgentWriteTracker} suppresses messages the agent sent itself
 * (5-min synthetic-path window keyed by `mail:<accountId>:<providerMsgId>`).
 */
export class MailPoller implements Observer {
  readonly name = "mail";
  private readonly registry: MailAccountRegistry;
  private readonly db: Database.Database;
  private readonly writeTracker: AgentWriteTracker;
  private readonly pollIntervalMs: number;
  private readonly maxMessagesPerPoll: number;
  private readonly notifyOwner?: (message: string) => Promise<void>;
  private readonly authFailureRetryMs: number;
  private readonly triggerRoadmapRefresh?: TriggerRoadmapRefresh;
  private readonly kindThrottleMs: Map<MailProviderKind, number>;
  private readonly lastKindPollAtMs: Map<MailProviderKind, number>;
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight = false;
  private readonly reconsentState = new Map<string, ReconsentDmState>();
  private readonly accountFlights = new Map<string, Promise<void>>();
  private readonly idleStarted = new Set<string>();

  constructor(opts: MailPollerOptions) {
    this.registry = opts.registry;
    this.db = opts.db;
    this.writeTracker = opts.writeTracker;
    this.pollIntervalMs = opts.pollIntervalSeconds * 1000;
    this.maxMessagesPerPoll = opts.maxMessagesPerPoll;
    this.notifyOwner = opts.notifyOwner;
    this.authFailureRetryMs = (opts.authFailureRetryHours ?? 6) * 3600 * 1000;
    this.triggerRoadmapRefresh = opts.triggerRoadmapRefresh;
    this.kindThrottleMs = new Map();
    this.lastKindPollAtMs = new Map();
    for (const [kind, seconds] of Object.entries(
      opts.providerPollIntervalsSeconds ?? {},
    )) {
      if (typeof seconds === "number" && seconds > 0) {
        this.kindThrottleMs.set(kind as MailProviderKind, seconds * 1000);
      }
    }
  }

  /**
   * True when the account's kind has a configured per-kind throttle and not
   * enough time has elapsed since the last tick that polled this kind. See
   * `providerPollIntervalsSeconds` on {@link MailPollerOptions}.
   *
   * Returns false for kinds without a throttle, so they poll on every tick
   * (pre-throttle behavior). Returns false on the very first call so the
   * first tick after startup always polls.
   *
   * **Call site contract**: invoke at most once per kind per tick, at the
   * top of the tick. The tick loop stamps `lastKindPollAtMs` immediately
   * after a kind is cleared to poll, which would make a second call in the
   * same tick incorrectly return true.
   */
  private shouldSkipByKindThrottle(kind: MailProviderKind): boolean {
    const throttleMs = this.kindThrottleMs.get(kind);
    if (!throttleMs || throttleMs <= 0) return false;
    const last = this.lastKindPollAtMs.get(kind);
    if (last === undefined) return false;
    return Date.now() - last < throttleMs;
  }

  async start(): Promise<void> {
    await this.tick();
    this.timer = setInterval(() => void this.tick(), this.pollIntervalMs);
    logger.info(
      { intervalSeconds: this.pollIntervalMs / 1000 },
      "Mail poller started",
    );
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    for (const accountId of [...this.idleStarted]) {
      const provider = this.registry.peekProvider(accountId);
      if (provider && hasIdleSupport(provider)) {
        await provider.stopIdle();
      }
      this.idleStarted.delete(accountId);
    }
  }

  private async tick(): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = true;
    try {
      // §4.8 per-account integration gate. MailPoller is multi-provider,
      // so stopping the whole observer when Gmail flips out of `direct`
      // mode would also stop iCloud / Outlook / IMAP polling — violating
      // the §4.8 invariant. Instead we filter out Gmail (or Outlook)
      // accounts here, and stop any running IDLE for them, when the
      // integration that governs the kind is non-direct (delegated or
      // disabled). INTEGRATION_NATIVE_MODE_DESIGN.md Phase A: the predicate
      // also covers `disabled`, closing the pre-native bug where a flip to
      // `disabled` left the poller silently still polling.
      const activeAccounts = this.registry.listActiveAccounts();
      const accounts = activeAccounts.filter(
        (a) => !this.isAccountManagedExternally(a),
      );
      await this.stopIdleForInactiveAccounts(accounts);

      // Per-kind throttle decisions are made ONCE at the top of the tick so a
      // kind is either polled for every account this tick or skipped for
      // every account this tick. Deciding inside the account loop would
      // misfire: after we stamp `lastKindPollAtMs` for account #1 of a kind,
      // `shouldSkipByKindThrottle` would return true for account #2 of the
      // same kind (elapsed ≈ 0 < throttleMs) and silently drop it.
      const tickStartMs = Date.now();
      const kindsToPollThisTick = new Set<MailProviderKind>();
      const seenKinds = new Set<MailProviderKind>();
      for (const account of accounts) {
        if (seenKinds.has(account.kind)) continue;
        seenKinds.add(account.kind);
        if (!this.shouldSkipByKindThrottle(account.kind)) {
          kindsToPollThisTick.add(account.kind);
          this.lastKindPollAtMs.set(account.kind, tickStartMs);
        }
      }

      // Each account is processed independently — failure isolation per
      // §3.4. We sequence rather than Promise.all to keep log ordering and
      // because Graph's per-tenant concurrency cap is enforced at the client.
      for (const account of accounts) {
        if (!kindsToPollThisTick.has(account.kind)) continue;
        try {
          await this.ensureIdle(account);
          await this.pollAccountSerialized(account);
        } catch (err) {
          logger.error({ err, accountId: account.id }, "Mail poll failed");
        }
      }
    } finally {
      this.inFlight = false;
    }
  }

  /**
   * True when the integration that governs this account's kind is owned
   * externally (delegated worker, native MCP in a future phase, or
   * explicitly disabled). The poller must skip these accounts on every
   * tick and tear down any running IDLE for them — see
   * {@link isIntegrationPollerless} for the predicate's full contract.
   *
   * Today: gmail → "gmail"; outlook → "outlook_mail" (user-managed
   * connector). Other providers (Yahoo / iCloud / IMAP) are not bound to a
   * delegate-able integration descriptor today and always return false —
   * they remain direct-only and keep polling regardless of any registry
   * state for other keys.
   */
  private isAccountManagedExternally(account: MailAccount): boolean {
    if (account.kind === "gmail") {
      return isIntegrationPollerless(this.db, "gmail");
    }
    if (account.kind === "outlook") {
      return isIntegrationPollerless(this.db, "outlook_mail");
    }
    return false;
  }

  private async stopIdleForInactiveAccounts(
    accounts: MailAccount[],
  ): Promise<void> {
    const activeIds = new Set(accounts.map((account) => account.id));
    for (const accountId of [...this.idleStarted]) {
      if (activeIds.has(accountId)) continue;
      const provider = this.registry.peekProvider(accountId);
      if (provider && hasIdleSupport(provider)) {
        await provider.stopIdle();
      }
      this.idleStarted.delete(accountId);
    }
  }

  private async ensureIdle(account: MailAccount): Promise<void> {
    if (!account.idleEnabled) return;
    const provider = await this.registry.getProvider(account.id);
    if (!provider || !hasIdleSupport(provider)) return;
    await provider.startIdle({
      onDirty: () => {
        // INTEGRATION_NATIVE_MODE_DESIGN.md §6.2 — the tick-level filter
        // tears IDLE down on the next tick, but `onDirty` can fire in
        // the gap between a mode flip and that next tick. Re-check the
        // predicate here so a flip to `delegated` / `disabled` (or
        // `native` in Phase B1) takes effect on the very next IDLE
        // event rather than after one stray poll. Cheap predicate: one
        // SQLite read per IDLE event, dominated by the IDLE round-trip.
        if (this.isAccountManagedExternally(account)) {
          logger.debug(
            { accountId: account.id, kind: account.kind },
            "Skipping IDLE-triggered poll — integration in non-direct mode",
          );
          return;
        }
        void this.pollAccountSerialized(account).catch((err) => {
          logger.error({ err, accountId: account.id }, "Idle-triggered mail poll failed");
        });
      },
      // Real-time VANISHED handling (§3.1.1) when QRESYNC is enabled on the
      // server — soft-delete the row immediately instead of waiting for the
      // daily reconcile job. Non-QRESYNC servers never invoke this.
      onExpunge: (event) => {
        this.softDeleteByProviderMsgId(account.id, event.providerMsgId);
      },
    });
    this.idleStarted.add(account.id);
  }

  private softDeleteByProviderMsgId(
    accountId: string,
    providerMsgId: string,
  ): void {
    try {
      const result = this.db
        .prepare(
          `UPDATE mail_messages_index
              SET deleted_at_utc = ?
            WHERE account_id = ? AND provider_msg_id = ? AND deleted_at_utc IS NULL`,
        )
        .run(new Date().toISOString(), accountId, providerMsgId);
      if (result.changes > 0) {
        logger.info(
          { accountId, providerMsgId },
          "Soft-deleted mail row via QRESYNC VANISHED",
        );
      }
    } catch (err) {
      logger.error(
        { err, accountId, providerMsgId },
        "Failed to soft-delete via VANISHED",
      );
    }
  }

  /**
   * Upsert poller-observed messages into `mail_messages_index`.
   *
   * Composite primary key `(account_id, provider_msg_id)` makes this idempotent
   * — a message reappearing on a later poll just refreshes its mutable fields
   * (`subject`, `snippet`, `is_read`, `flags_json`, `has_attachment`,
   * `observed_at_utc`). Static fields (`thread_id`, `folder`, `received_at_utc`,
   * `from_email`, `to_emails_json`, `rfc822_msg_id`) are written on first
   * landing and re-asserted on conflict to handle providers that surface
   * additional headers on a follow-up tick (e.g. IMAP first-seen via SEARCH
   * then ENVELOPE).
   *
   * `deleted_at_utc` is NOT touched on conflict so a previously soft-deleted
   * row is not silently un-trashed when the provider re-lists it (rare; only
   * happens when the user undoes a delete upstream).
   *
   * The AFTER INSERT / AFTER UPDATE FTS triggers (`db/schema.ts:564-589`)
   * keep `fts_mail_messages` in sync without explicit work here.
   */
  private upsertMessages(
    accountId: string,
    messages: MailMessageSummary[],
  ): void {
    if (messages.length === 0) return;
    const nowIso = new Date().toISOString();
    const upsert = this.db.prepare(
      `INSERT INTO mail_messages_index (
         account_id, provider_msg_id, rfc822_msg_id, thread_id, folder,
         received_at_utc, subject, from_email, to_emails_json, snippet,
         is_read, flags_json, has_attachment, observed_at_utc
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(account_id, provider_msg_id) DO UPDATE SET
         rfc822_msg_id    = excluded.rfc822_msg_id,
         thread_id        = excluded.thread_id,
         folder           = excluded.folder,
         received_at_utc  = excluded.received_at_utc,
         subject          = excluded.subject,
         from_email       = excluded.from_email,
         to_emails_json   = excluded.to_emails_json,
         snippet          = excluded.snippet,
         is_read          = excluded.is_read,
         flags_json       = excluded.flags_json,
         has_attachment   = excluded.has_attachment,
         observed_at_utc  = excluded.observed_at_utc`,
    );
    const tx = this.db.transaction((batch: MailMessageSummary[]) => {
      for (const msg of batch) {
        upsert.run(
          accountId,
          msg.providerMsgId,
          msg.rfc822MsgId ?? null,
          msg.threadId ?? null,
          msg.folder,
          msg.receivedAtUtc,
          msg.subject ?? null,
          msg.from?.email ?? null,
          JSON.stringify(msg.to ?? []),
          msg.snippet ?? null,
          msg.isRead ? 1 : 0,
          JSON.stringify(msg.flags ?? []),
          // hasAttachment is `boolean | undefined` — undefined means the
          // provider couldn't determine it in summary mode; coerce to 0 here.
          // The next full fetch resolves the truth.
          msg.hasAttachment === true ? 1 : 0,
          nowIso,
        );
      }
    });
    try {
      tx(messages);
    } catch (err) {
      logger.error(
        { err, accountId, count: messages.length },
        "Failed to upsert mail_messages_index rows",
      );
    }
  }

  private softDeleteRemovedIds(accountId: string, providerMsgIds: string[]): void {
    if (providerMsgIds.length === 0) return;
    const uniqueIds = [...new Set(providerMsgIds)];
    const nowIso = new Date().toISOString();
    const update = this.db.prepare(
      `UPDATE mail_messages_index
          SET deleted_at_utc = ?
        WHERE account_id = ? AND provider_msg_id = ? AND deleted_at_utc IS NULL`,
    );
    const tx = this.db.transaction((ids: string[]) => {
      for (const providerMsgId of ids) {
        update.run(nowIso, accountId, providerMsgId);
      }
    });
    try {
      tx(uniqueIds);
    } catch (err) {
      logger.error(
        { err, accountId, removedCount: uniqueIds.length },
        "Failed to soft-delete removed mail rows",
      );
    }
  }

  private async pollAccountSerialized(account: MailAccount): Promise<void> {
    const previous = this.accountFlights.get(account.id) ?? Promise.resolve();
    const next = previous.then(() => this.pollAccount(account));
    const tracked = next.catch(() => undefined);
    this.accountFlights.set(account.id, tracked);
    try {
      await next;
    } finally {
      if (this.accountFlights.get(account.id) === tracked) {
        this.accountFlights.delete(account.id);
      }
    }
  }

  private async pollAccount(account: MailAccount): Promise<void> {
    const provider = await this.registry.getProvider(account.id);
    if (!provider) return;

    let cursor: PollCursor | null = this.registry.loadPollCursor(account.id);
    let drained = false;
    let aggregated: MailMessageSummary[] = [];
    let removedAggregated: string[] = [];
    // Cap repagination per tick to bound work. drained=false means more pages
    // are immediately available; we walk them in this same tick (§3.4).
    let pages = 0;
    const maxPages = 5;

    try {
      while (!drained && pages < maxPages) {
        const result = await provider.pollSince(cursor, this.maxMessagesPerPoll);
        cursor = result.nextCursor;
        drained = result.drained;
        aggregated = aggregated.concat(result.messages);
        removedAggregated = removedAggregated.concat(result.removedIds);
        pages++;
      }
    } catch (err) {
      this.handlePollError(account, provider, err);
      this.registry.recordPollTick(account.id, {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    // Successful pass: persist cursor + reset error counter.
    if (cursor) this.registry.savePollCursor(account.id, cursor);
    this.registry.recordPollTick(account.id, { success: true });
    // Forget prior re-consent DM cadence so a future failure can DM immediately
    // instead of silently waiting out `mailAuthFailureRetryHours` (§V3).
    this.reconsentState.delete(account.id);

    // Filter agent-originated writes. Two attribution keys (§C6):
    //   1. `mail:<acct>:<providerMsgId>` — matches Gmail/Graph where the id
    //      the route marked is the id the poller later observes.
    //   2. `mail:<acct>:rfc822:<rfc822MsgId>` — matches IMAP where the
    //      SMTP+APPEND Sent-folder UID differs from the draft UID the route
    //      marked, but the RFC-2822 Message-Id header is stable across the
    //      transport path. Providers that surface rfc822 in SendResult mark
    //      this second key too; poller checks both.
    const userMessages = aggregated.filter((m) => {
      const byProviderId = this.writeTracker.isMarked(
        `mail:${account.id}:${m.providerMsgId}`,
        undefined,
      );
      if (byProviderId) return false;
      if (m.rfc822MsgId) {
        const byRfc822 = this.writeTracker.isMarked(
          `mail:${account.id}:rfc822:${m.rfc822MsgId}`,
          undefined,
        );
        if (byRfc822) return false;
      }
      return true;
    });

    // Persist the canonical row before classification so FTS5 search and IMAP
    // deletion reconcile have something to work against. Idempotent on
    // (account_id, provider_msg_id); the AFTER INSERT trigger keeps
    // `fts_mail_messages` in sync.
    this.upsertMessages(account.id, userMessages);

    // Classify + ingest travel_bookings / kindle_notebook / parse_failures
    // through the shared pipeline — identical rules as the prior Gmail-only
    // observer path. Receipt detection now flows through the same attachment
    // metadata surface for providers that expose it.
    const ingestion = await this.ingestClassified(account, provider, userMessages);
    this.softDeleteRemovedIds(account.id, removedAggregated);

    if (userMessages.length > 0 || removedAggregated.length > 0) {
      recordObservation(this.db, {
        source: "mail:lifecycle",
        ref: `${account.id}-${Date.now()}`,
        changeType: "created",
        // External-sender mail is owner-relevant signal, not internal-system
        // bookkeeping. The hourly-check threshold gate, the silent-gate
        // consumption path, and the `observations` skill all filter to
        // `actor='user'` (see dispatcher.ts:1540, 1832 + skills/observations
        // SKILL.md). Marking this `system` would invisibly excise mail from
        // every consumption path. `agent`-attributed sends are already
        // filtered out above via `writeTracker.isMarked`.
        actor: "user",
        payload: {
          accountId: account.id,
          kind: account.kind,
          email: account.email,
          newMessages: userMessages.length,
          removedMessages: removedAggregated.length,
          subjects: userMessages.slice(0, 5).map((m) => m.subject ?? "(no subject)"),
          fromAgentSuppressed: aggregated.length - userMessages.length,
          travelBookings: ingestion.travelBookingsInserted,
          receipts: ingestion.receiptsDetected,
          kindleBooksCreated: ingestion.kindleBooksCreated,
          kindleHighlightsInserted: ingestion.kindleHighlightsInserted,
          kindleNotebooks: ingestion.kindleNotebooks,
          // Retained for backward-compat with the kindle-only observation
          // payload shape from an earlier iteration; equals `parseFailures`
          // for this branch (no separate receipts-scanning failures).
          kindleParseFailures: ingestion.parseFailures,
          parseFailures: ingestion.parseFailures,
        },
      });
    }
  }

  /**
   * Run classification and delegate persistence to the shared ingestion
   * pipeline. The `parseFailureKeyPrefix` namespaces rows so IMAP UIDs from
   * two Yahoo accounts cannot collide on the `parse_failures` UNIQUE key.
   */
  private async ingestClassified(
    account: MailAccount,
    provider: MailProvider,
    messages: MailMessageSummary[],
  ): Promise<MailIngestionStats> {
    if (messages.length === 0) {
      return emptyIngestionStats();
    }
    return processClassifiedMailBatch({
      db: this.db,
      logger,
      source: {
        parseFailureKeyPrefix: `mail:${account.kind}:${account.id}:`,
        accountId: account.id,
      },
      batch: processMailBatch(messages),
      triggerRoadmapRefresh: this.triggerRoadmapRefresh,
      fetchHtml: async (providerMsgId) => {
        const full = await provider.get(providerMsgId);
        return full.body.html ?? null;
      },
      fetchAttachments: async (providerMsgId) => {
        // MailProvider.pollSince() returns summaries only — attachments
        // come from a full `.get()`. Cost: one extra fetch per travel-
        // classified message. Acceptable because travel confirmations
        // are rare compared to the total message volume.
        const full = await provider.get(providerMsgId);
        return full.attachments.map((a) => ({
          attachmentId: a.id,
          filename: a.filename,
          mimeType: a.mimeType,
          size: a.sizeBytes,
        }));
      },
    });
  }

  /**
   * Map a thrown error to an AuthStatus update + (optionally) a Notify-tier
   * DM. `requires_consent` is always sticky and triggers a DM with retry
   * cadence; `degraded` is recorded silently; `transient` only flips after
   * the consecutive_error_count crosses the threshold.
   */
  private handlePollError(
    account: MailAccount,
    provider: MailProvider,
    err: unknown,
  ): void {
    const responseStatus =
      err instanceof GraphError
        ? err.httpStatus
        : typeof (err as { response?: { status?: unknown } } | null)?.response?.status ===
              "number"
          ? (err as { response: { status: number } }).response.status
          : typeof (err as { status?: unknown } | null)?.status === "number"
            ? (err as { status: number }).status
            : null;
    // ImapFlow stores the real server response in serverResponseCode (e.g.
    // "AUTHENTICATIONFAILED") and sets err.message to a generic "Command
    // failed". Concatenate all three fields so the classifier can pattern-match
    // the actual IMAP error, not just the wrapper message.
    const imapE = err as { serverResponseCode?: string; responseText?: string } | null;
    const message =
      err instanceof Error
        ? [err.message, imapE?.serverResponseCode, imapE?.responseText].filter(Boolean).join(" ")
        : String(err);
    const errorName = err instanceof Error ? err.name : null;
    const errorCode =
      err instanceof Error && "errorCode" in err
        ? String((err as { errorCode: unknown }).errorCode)
        : typeof (err as { code?: unknown } | null)?.code === "string"
          ? (err as { code: string }).code
        : null;
    const gmailReason =
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ((err as any)?.response?.data?.error?.errors?.[0]?.reason as string | undefined) ??
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ((err as any)?.errors?.[0]?.reason as string | undefined) ??
      null;
    // ImapFlow IMAP errors don't carry a numeric responseCode; extract it
    // separately from the error object (distinct from httpStatus which is
    // only populated for Outlook GraphErrors).
    const imapResponseCode =
      err instanceof GraphError
        ? null
        : typeof (err as { responseCode?: unknown })?.responseCode === "number"
          ? (err as { responseCode: number }).responseCode
          : null;

    const classified =
      account.kind === "outlook"
        ? classifyAuthFailure({
            httpStatus: responseStatus,
            message,
            errorName,
            errorCode,
          })
        : account.kind === "gmail"
          ? classifyGmailAuthFailure({
              httpStatus: responseStatus,
              message,
              errorName,
              errorCode,
              reason: gmailReason,
            })
          : classifyImapAuthFailure({
            responseCode: imapResponseCode,
            message,
            errorName,
          });
    // recordPollTick will increment the count; preview the post-increment value
    // so the threshold flip lands in the same tick that crossed it.
    const upcoming = this.registry.getConsecutiveErrorCount(account.id) + 1;
    const next =
      account.kind === "outlook"
        ? effectiveAuthStatus(classified, upcoming)
        : account.kind === "gmail"
          ? effectiveGmailAuthStatus(classified, upcoming)
          : effectiveImapAuthStatus(classified);
    if (!next || next === account.authStatus) return;

    this.registry.updateAuthStatus(account.id, next, message);

    if (next === "requires_consent") {
      // Evict the cached provider so a fresh PCA is built after re-consent.
      this.registry.evictProvider(account.id);
      // Fresh failure cycle — `listActiveAccounts` only surfaces healthy rows,
      // so reaching here means we are flipping healthy→requires_consent. If
      // the user just re-consented and the new tokens failed immediately
      // (without an intervening successful tick), drop prior cadence so the
      // DM is sent now instead of being silenced for mailAuthFailureRetryHours.
      // Without this, the `clear on success` path leaves stale state in the
      // re-consent→re-fail-immediately scenario (V3 edge case).
      this.reconsentState.delete(account.id);
      void this.maybeSendReconsentDm(account, classified.status === "requires_consent" ? classified.reason : "auth_failure");
    } else if (next === "degraded") {
      logger.warn({ accountId: account.id, reason: classified }, "Mail account degraded");
    }
    // The provider arg is currently only logged — kept for future use when
    // the poller needs to inspect provider.kind for per-provider DM templates.
    void provider;
  }

  private async maybeSendReconsentDm(account: MailAccount, reason: string): Promise<void> {
    if (!this.notifyOwner) return;
    const state = this.reconsentState.get(account.id);
    const now = Date.now();
    if (state && now - state.lastSentAtMs < this.authFailureRetryMs) return;

    // Link target is Connections → Mail (/connections/mail#<accountId>). The
    // hash fragment lets the page scroll/highlight the offending account row
    // on load.
    const message = [
      `Mail account ${account.email} (${account.kind}) needs re-authorization.`,
      `Reason: ${reason}.`,
      `Open the dashboard → Connections → Mail (/connections/mail#${account.id}) and click "Re-authenticate" on the ${account.email} card.`,
    ].join("\n");
    try {
      await this.notifyOwner(message);
      this.reconsentState.set(account.id, { lastSentAtMs: now });
    } catch (err) {
      logger.error({ err, accountId: account.id }, "Failed to deliver re-consent DM");
    }
  }
}

function hasIdleSupport(provider: MailProvider): provider is IdleCapableMailProvider {
  return (
    "startIdle" in provider &&
    typeof provider.startIdle === "function" &&
    "stopIdle" in provider &&
    typeof provider.stopIdle === "function"
  );
}
