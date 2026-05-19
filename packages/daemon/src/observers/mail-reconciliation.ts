/**
 * Mail reconciliation observer (Phase 7, §3.1.1).
 *
 * Two responsibilities, both run on a daily cadence and both kept out of the
 * real-time {@link MailPoller} path so their slower failure modes don't
 * contaminate delta polling:
 *
 * 1. IMAP deletion reconciliation. The poll path cannot detect deletions
 *    without QRESYNC because `pollSince()` only walks UIDs above the cursor
 *    watermark. We periodically re-list UIDs in each indexed folder and diff
 *    against the local index to soft-delete rows for messages the user moved
 *    or purged outside our sight.
 *
 * 2. Cross-provider purge of rows soft-deleted more than
 *    {@link MAIL_PURGE_DAYS} ago, so `mail_messages_index` does not grow
 *    unbounded.
 *
 * Per-account isolation matches the mail poller: one IMAP account's failure
 * (auth lapse, server unreachable) never blocks the others. The job also
 * honors daemon shutdown — a reconcile pass in flight when `stop()` is
 * called completes its current folder before returning.
 *
 * **QRESYNC status.** Each tick reads `provider.getCapabilities()` and logs
 * whether QRESYNC is advertised on the account. Today both branches use
 * UID SEARCH + local diff (see {@link planImapReconcile}). Flipping the
 * QRESYNC branch to a `SELECT ... (QRESYNC ...)` with VANISHED-response
 * collection requires extending the IMAP poll cursor with `modSeq`, which is
 * a schema change deferred to a follow-up phase. Structuring the branch
 * here now keeps the capabilities pipeline alive and makes the upgrade a
 * one-file change when the cursor format ships.
 */

import type Database from "better-sqlite3";
import type { Observer } from "./manager.js";
import type { MailAccountRegistry } from "../services/mail/account-registry.js";
import type { MailAccount } from "../services/mail/provider.js";
import {
  isImapReconcileSource,
  type ImapReconcileSource,
} from "../services/mail/imap/imap-provider-base.js";
import {
  planImapReconcile,
  type LocalIndexedMessage,
} from "../services/mail/imap/reconcile-planner.js";
import { createLogger } from "../logging.js";

const logger = createLogger("mail-reconciliation");

/** Age threshold for the cross-provider purge of soft-deleted rows. */
export const MAIL_PURGE_DAYS = 90;

/**
 * Upper bound on how many UIDs back from the cursor's `lastUid` a single
 * reconcile pass walks. Caps IMAP SEARCH cost on multi-100k-message folders
 * (§12 open-question #3). Older rows stay in the index and only disappear
 * via the purge step once the owner explicitly deletes them upstream.
 */
export const MAIL_RECONCILE_UID_WINDOW = 5000;

/**
 * Delay before the first tick runs after `start()`. Non-zero so a daemon
 * reboot doesn't race with the initial poller pass; not the full interval
 * so a crashloop doesn't leave days of drift. Ten minutes balances those.
 */
export const MAIL_RECONCILE_INITIAL_DELAY_MS = 10 * 60 * 1000;

export interface MailReconciliationOptions {
  registry: MailAccountRegistry;
  db: Database.Database;
  /** Interval in ms. Defaults to once per 24 hours. */
  intervalMs?: number;
  /** First-tick delay in ms. Defaults to {@link MAIL_RECONCILE_INITIAL_DELAY_MS}. */
  initialDelayMs?: number;
  /** Age threshold in days for the purge step. Defaults to {@link MAIL_PURGE_DAYS}. */
  purgeDays?: number;
  /** Injected clock for tests. */
  now?: () => Date;
}

export class MailReconciliationJob implements Observer {
  readonly name = "mail-reconciliation";
  private readonly registry: MailAccountRegistry;
  private readonly db: Database.Database;
  private readonly intervalMs: number;
  private readonly initialDelayMs: number;
  private readonly purgeDays: number;
  private readonly now: () => Date;
  private timer: ReturnType<typeof setInterval> | null = null;
  private initialTimer: ReturnType<typeof setTimeout> | null = null;
  private inFlight = false;
  private stopped = false;

  constructor(opts: MailReconciliationOptions) {
    this.registry = opts.registry;
    this.db = opts.db;
    this.intervalMs = opts.intervalMs ?? 24 * 3600 * 1000;
    this.initialDelayMs =
      opts.initialDelayMs ?? MAIL_RECONCILE_INITIAL_DELAY_MS;
    this.purgeDays = opts.purgeDays ?? MAIL_PURGE_DAYS;
    this.now = opts.now ?? (() => new Date());
  }

  async start(): Promise<void> {
    if (this.initialDelayMs > 0) {
      this.initialTimer = setTimeout(() => {
        this.initialTimer = null;
        void this.tick();
      }, this.initialDelayMs);
    }
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    logger.info(
      { intervalMs: this.intervalMs, initialDelayMs: this.initialDelayMs },
      "Mail reconciliation started",
    );
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.initialTimer) {
      clearTimeout(this.initialTimer);
      this.initialTimer = null;
    }
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async tick(): Promise<void> {
    if (this.inFlight || this.stopped) return;
    this.inFlight = true;
    try {
      await this.runImapReconcile();
      this.runPurge();
    } catch (err) {
      logger.error({ err }, "Mail reconciliation tick failed");
    } finally {
      this.inFlight = false;
    }
  }

  private async runImapReconcile(): Promise<void> {
    // No kind filter — the provider's own shape decides eligibility
    // (duck-typed via `isImapReconcileSource`). This keeps us open to
    // hypothetical third IMAP subclasses without editing this file.
    const accounts = this.registry.listActiveAccounts();

    for (const account of accounts) {
      if (this.stopped) break;
      try {
        await this.reconcileAccount(account);
      } catch (err) {
        logger.error(
          { err, accountId: account.id },
          "IMAP reconciliation failed",
        );
      }
    }
  }

  private async reconcileAccount(account: MailAccount): Promise<void> {
    const provider = await this.registry.getProvider(account.id);
    if (!isImapReconcileSource(provider)) return;

    const caps = provider.getCapabilities();
    // Record the strategy the pass *would* take. Both branches currently use
    // UID SEARCH; see class-level docstring for the QRESYNC upgrade path.
    const strategy = caps?.qresync ? "uid-search (qresync-eligible)" : "uid-search";

    const folders = this.listIndexedFolders(account.id);
    if (folders.length === 0) return;

    let totalMissing = 0;
    let totalSkipped = 0;
    for (const folder of folders) {
      if (this.stopped) break;
      // Per-folder isolation: a single bad folder must not abort the rest of
      // the account's reconcile pass. Log + continue so the next folder runs.
      try {
        const counts = await this.reconcileFolder(provider, account.id, folder);
        totalMissing += counts.missing;
        totalSkipped += counts.skipped;
      } catch (err) {
        logger.error(
          { err, accountId: account.id, folder },
          "IMAP folder reconciliation failed",
        );
      }
    }

    if (totalMissing > 0 || totalSkipped > 0) {
      logger.info(
        {
          accountId: account.id,
          folderCount: folders.length,
          missingCount: totalMissing,
          skippedCount: totalSkipped,
          strategy,
        },
        "IMAP reconciliation completed",
      );
    }
  }

  private async reconcileFolder(
    provider: ImapReconcileSource,
    accountId: string,
    folder: string,
  ): Promise<{ missing: number; skipped: number }> {
    // Without a cursor entry for this folder we have no upper bound for the
    // SEARCH, which on a multi-100k-message folder would translate to
    // `SEARCH ALL`. Defer until the poll path establishes a cursor; the next
    // reconcile tick after a successful poll will pick it up. (A small
    // lastUid is still fine — `computeWindowStart` clamps the floor at 0
    // and we walk from UID 1.)
    if (!this.hasCursorEntryForFolder(accountId, folder)) {
      return { missing: 0, skipped: 0 };
    }
    const windowStart = this.computeWindowStart(accountId, folder);
    const { uidValidity, uids } = await provider.listExistingUids(folder, {
      sinceUid: windowStart,
    });

    const local = this.loadLocalMessages(accountId, folder);
    const plan = planImapReconcile({
      serverUidValidity: uidValidity,
      serverUids: uids,
      localMessages: local,
      minUidWalked: windowStart,
    });

    if (plan.missingIds.length > 0) {
      const nowIso = this.now().toISOString();
      const update = this.db.prepare(
        `UPDATE mail_messages_index
            SET deleted_at_utc = ?
          WHERE account_id = ? AND provider_msg_id = ? AND deleted_at_utc IS NULL`,
      );
      const tx = this.db.transaction((ids: string[]) => {
        for (const id of ids) update.run(nowIso, accountId, id);
      });
      tx(plan.missingIds);
    }

    return { missing: plan.missingIds.length, skipped: plan.skippedIds.length };
  }

  private listIndexedFolders(accountId: string): string[] {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT folder
           FROM mail_messages_index
          WHERE account_id = ? AND deleted_at_utc IS NULL`,
      )
      .all(accountId) as { folder: string }[];
    return rows.map((r) => r.folder);
  }

  private hasCursorEntryForFolder(accountId: string, folder: string): boolean {
    const cursor = this.registry.loadPollCursor(accountId);
    if (!cursor || cursor.kind !== "imap") return false;
    return cursor.folders[folder] !== undefined;
  }

  private computeWindowStart(accountId: string, folder: string): number {
    const cursor = this.registry.loadPollCursor(accountId);
    if (!cursor || cursor.kind !== "imap") return 0;
    const entry = cursor.folders[folder];
    if (!entry) return 0;
    return Math.max(entry.lastUid - MAIL_RECONCILE_UID_WINDOW, 0);
  }

  private loadLocalMessages(
    accountId: string,
    folder: string,
  ): LocalIndexedMessage[] {
    const rows = this.db
      .prepare(
        `SELECT provider_msg_id AS providerMsgId,
                received_at_utc  AS receivedAtUtc
           FROM mail_messages_index
          WHERE account_id = ?
            AND folder = ?
            AND deleted_at_utc IS NULL`,
      )
      .all(accountId, folder) as LocalIndexedMessage[];
    return rows;
  }

  private runPurge(): void {
    const cutoff = new Date(
      this.now().getTime() - this.purgeDays * 24 * 3600 * 1000,
    ).toISOString();
    const result = this.db
      .prepare(
        `DELETE FROM mail_messages_index
          WHERE deleted_at_utc IS NOT NULL
            AND deleted_at_utc < ?`,
      )
      .run(cutoff);
    if (result.changes > 0) {
      logger.info(
        { purgedCount: result.changes, cutoff },
        "Purged expired soft-deleted mail index rows",
      );
    }
  }
}
