/**
 * Shared mail ingestion pipeline — provider-agnostic.
 *
 * Invoked by the unified {@link MailPoller} to persist categorized findings
 * from a classified email batch. Centralising the logic here guarantees the
 * same classification rules, idempotency contracts, and observation stats
 * shape across every provider (gmail / outlook / yahoo / icloud).
 *
 * Scope of this module (uniform across providers):
 *   - `travel_bookings` insertion on travel category
 *   - `books` + `reading_highlights` insertion on kindle_notebook category
 *     (HTML fetched via the caller-supplied `fetchHtml` callback)
 *   - `parse_failures` for every classification/extraction miss, keyed by a
 *     caller-supplied namespace so rows from different providers cannot
 *     collide on the UNIQUE index.
 *
 * Intentionally NOT covered:
 *   - Attachment *download* semantics. This pipeline only stores attachment
 *     metadata for receipt candidates; actual bytes are fetched later by the
 *     receipts route through the provider's `getAttachment` method (or the
 *     shared-Google-OAuth Gmail route's `GmailService` fallback).
 *
 * The caller owns:
 *   - Classification invocation (so Gmail can use the native `EmailInput`
 *     shape and unified providers can use their `MailMessageSummary` adapter
 *     in {@link mail-classifier}).
 *   - Cursor / dedup management (poller-specific).
 *   - Emitting the aggregate observation (payload shape differs per poller).
 */

import type Database from "better-sqlite3";
import type { Logger } from "pino";
import {
  parseKindleNotebookHtml,
  importKindleNotebook,
} from "../api/routes/books.js";
import type {
  ClassifiedEmail,
  TravelExtraction,
  processEmailBatch,
} from "./gmail-classifier.js";
import {
  maybeTriggerRefreshForTravelBooking,
  type TriggerRoadmapRefresh,
} from "../core/roadmap-refresh-triggers.js";

/**
 * Identity of the source that produced the classified batch. Used to
 * namespace `parse_failures.provider_msg_id` / `travel_bookings.provider_msg_id`
 * so IMAP UIDs from different accounts cannot collide on the UNIQUE index,
 * and to populate `receipts.account_id` for the provider-agnostic download
 * route.
 */
export interface MailIngestionSource {
  /**
   * Prefix prepended to a message's provider id when writing
   * `parse_failures` and `travel_bookings`. Pass an empty string for the
   * shared-Google-OAuth Gmail path (raw Gmail message ids are globally
   * unique there). For unified providers pass `mail:<kind>:<accountId>:`
   * so two IMAP accounts cannot collide on the same UID.
   */
  parseFailureKeyPrefix: string;
  /**
   * Stored on each `receipts` row so the download route can resolve the
   * right provider via the mail registry. `null` for the
   * shared-Google-OAuth Gmail path (download falls back to `GmailService`
   * in the route).
   */
  accountId: string | null;
}

export interface AttachmentLike {
  attachmentId: string;
  filename: string;
  mimeType: string;
  size: number;
}

export interface MailIngestionStats {
  travelBookingsInserted: number;
  receiptsDetected: number;
  kindleNotebooks: number;
  kindleBooksCreated: number;
  kindleHighlightsInserted: number;
  parseFailures: number;
}

export function emptyIngestionStats(): MailIngestionStats {
  return {
    travelBookingsInserted: 0,
    receiptsDetected: 0,
    kindleNotebooks: 0,
    kindleBooksCreated: 0,
    kindleHighlightsInserted: 0,
    parseFailures: 0,
  };
}

export interface MailIngestionInputs {
  db: Database.Database;
  logger: Logger;
  source: MailIngestionSource;
  /** Output of `processEmailBatch` / `processMailBatch`. */
  batch: ReturnType<typeof processEmailBatch>;
  /**
   * Fetches the HTML body for a message id. Return `null` when the provider
   * has no HTML part available. Invoked only for kindle_notebook-classified
   * messages — never for the broader batch, so there is no N+1 cost on
   * unrelated mail.
   */
  fetchHtml: (providerMsgId: string) => Promise<string | null>;
  /**
   * Optional. When present, invoked once per travel-classified message to
   * list its attachments; each attachment lands in `receipts` keyed on
   * `(provider_msg_id, attachment_id)`. Omit to skip receipt scanning —
   * the pipeline will still insert the travel booking itself.
   *
   * Gmail callers should pass a thin wrapper over `GmailService.listAttachments`
   * (metadata-only call). Unified providers should pass a wrapper that
   * returns `provider.get(id).then(m => m.attachments)`.
   */
  fetchAttachments?: (providerMsgId: string) => Promise<AttachmentLike[]>;
  /**
   * Optional. Invoked once per travel-booking INSERT whose `start_date`
   * is more than 3 days out (ROADMAP-REDESIGN §3.4 RFC-C). The dispatcher
   * side absorbs bursts via a 5-minute dedup, so firing this multiple times
   * inside a batch (e.g. flight + hotel confirmations polled together)
   * collapses into a single `routine.roadmap_refresh`.
   */
  triggerRoadmapRefresh?: TriggerRoadmapRefresh;
}

/**
 * Process a classified batch: persist travel bookings, ingest Kindle
 * notebook exports, and record every failure in `parse_failures`. Never
 * throws — all per-message errors are captured as parse failures so one
 * bad email cannot block the rest of the batch.
 */
export async function processClassifiedMailBatch(
  inputs: MailIngestionInputs,
): Promise<MailIngestionStats> {
  const { db, logger, source, batch, fetchHtml, fetchAttachments, triggerRoadmapRefresh } = inputs;
  const stats = emptyIngestionStats();

  for (const { email, extraction } of batch.travelBookings) {
    const key = `${source.parseFailureKeyPrefix}${email.messageId}`;
    if (insertTravelBooking(db, key, extraction)) {
      stats.travelBookingsInserted += 1;
      maybeTriggerRefreshForTravelBooking(
        { startDate: extraction.startDate },
        triggerRoadmapRefresh,
      );
    }
    if (fetchAttachments) {
      stats.receiptsDetected += await scanTravelAttachments({
        db,
        logger,
        source,
        providerMsgId: email.messageId,
        namespacedMsgId: key,
        fetchAttachments,
      });
    }
  }

  stats.kindleNotebooks = batch.kindleNotebooks.length;
  for (const notebook of batch.kindleNotebooks) {
    const result = await ingestKindleNotebook({
      db,
      logger,
      source,
      email: notebook,
      fetchHtml,
    });
    stats.kindleBooksCreated += result.booksCreated;
    stats.kindleHighlightsInserted += result.highlightsInserted;
    if (result.parseFailure) stats.parseFailures += 1;
  }

  // Classifier-level parse failures (e.g. travel extraction returned null
  // but the sender domain looked right). These arrive with raw provider
  // ids — apply the namespace prefix here so the UNIQUE key is consistent.
  for (const failure of batch.parseFailures) {
    const ok = recordParseFailure(db, {
      uniqueKey: `${source.parseFailureKeyPrefix}${failure.messageId}`,
      sender: failure.sender,
      subject: failure.subject,
      snippet: failure.snippet,
      errorReason: failure.errorReason,
    });
    if (ok) stats.parseFailures += 1;
  }

  return stats;
}

/**
 * Fetch + parse + import a single Kindle Notebook Export email.
 * Records a `parse_failures` row for any miss; returns counts the caller
 * merges into the batch-level stats.
 */
async function ingestKindleNotebook(args: {
  db: Database.Database;
  logger: Logger;
  source: MailIngestionSource;
  email: ClassifiedEmail;
  fetchHtml: (providerMsgId: string) => Promise<string | null>;
}): Promise<{
  booksCreated: number;
  highlightsInserted: number;
  parseFailure: boolean;
}> {
  const { db, logger, source, email, fetchHtml } = args;
  const uniqueKey = `${source.parseFailureKeyPrefix}${email.messageId}`;

  const recordFailure = (errorReason: string, snippet = ""): void => {
    recordParseFailure(db, {
      uniqueKey,
      sender: email.sender,
      subject: email.subject,
      snippet,
      errorReason,
    });
  };

  try {
    const html = await fetchHtml(email.messageId);
    if (!html) {
      recordFailure("kindle_notebook_no_html");
      return { booksCreated: 0, highlightsInserted: 0, parseFailure: true };
    }

    const parsed = parseKindleNotebookHtml(html, {
      subject: email.subject,
      date: email.date,
    });
    if (!parsed) {
      recordFailure("kindle_notebook_unrecognized_format");
      return { booksCreated: 0, highlightsInserted: 0, parseFailure: true };
    }

    const imported = importKindleNotebook(db, parsed);
    return {
      booksCreated: imported.booksCreated,
      highlightsInserted: imported.highlightsInserted,
      parseFailure: false,
    };
  } catch (err) {
    logger.warn(
      { err, messageId: email.messageId, prefix: source.parseFailureKeyPrefix },
      "Failed to ingest Kindle notebook email",
    );
    recordFailure(
      `kindle_notebook_error: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { booksCreated: 0, highlightsInserted: 0, parseFailure: true };
  }
}

/**
 * Insert a travel booking. Returns true if a new row landed, false when
 * the UNIQUE index skipped it (the message was already ingested on a prior
 * tick and we're seeing it again).
 */
export function insertTravelBooking(
  db: Database.Database,
  providerMsgId: string,
  extraction: TravelExtraction,
): boolean {
  try {
    db.prepare(
      `INSERT INTO travel_bookings
         (type, provider, destination, start_date, end_date,
          confirmation_number, amount, currency, provider_msg_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      extraction.type,
      extraction.provider,
      extraction.destination,
      extraction.startDate,
      extraction.endDate,
      extraction.confirmationNumber,
      extraction.amount,
      extraction.currency,
      providerMsgId,
    );
    return true;
  } catch (err) {
    if (isUniqueConstraintError(err)) return false;
    throw err;
  }
}

/**
 * Insert (or de-duplicate) a parse_failures row. Returns true if a new
 * row landed, false if the uniqueKey was already recorded.
 *
 * `provider_msg_id` holds any opaque unique key — callers namespace-prefix
 * non-Gmail keys to keep the UNIQUE constraint well-defined across providers.
 */
export function recordParseFailure(
  db: Database.Database,
  failure: {
    uniqueKey: string;
    sender: string | null;
    subject: string | null;
    snippet: string;
    errorReason: string;
  },
): boolean {
  try {
    db.prepare(
      `INSERT INTO parse_failures
         (provider_msg_id, sender, subject, snippet, error_reason)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(
      failure.uniqueKey,
      failure.sender,
      failure.subject,
      failure.snippet,
      failure.errorReason,
    );
    return true;
  } catch (err) {
    if (isUniqueConstraintError(err)) return false;
    throw err;
  }
}

function isUniqueConstraintError(err: unknown): boolean {
  return (
    err instanceof Error && err.message.includes("UNIQUE constraint failed")
  );
}

/**
 * Detect and record receipt attachments for a single travel-classified email.
 * Attachment metadata only — bytes are downloaded on demand via the
 * receipts API.
 */
async function scanTravelAttachments(args: {
  db: Database.Database;
  logger: Logger;
  source: MailIngestionSource;
  /** Raw id sent to the provider's attachment API. */
  providerMsgId: string;
  /**
   * Namespaced key written to `receipts.provider_msg_id`. Matches the
   * `travel_bookings.provider_msg_id` value used for the same message so
   * UIs can join back.
   */
  namespacedMsgId: string;
  fetchAttachments: (providerMsgId: string) => Promise<AttachmentLike[]>;
}): Promise<number> {
  const { db, logger, source, providerMsgId, namespacedMsgId, fetchAttachments } = args;
  let detected = 0;
  try {
    const attachments = await fetchAttachments(providerMsgId);
    for (const att of attachments) {
      if (insertReceipt(db, namespacedMsgId, att, "travel", source.accountId)) {
        detected += 1;
      }
    }
  } catch (err) {
    logger.warn(
      { err, providerMsgId, namespacedMsgId },
      "Failed to scan attachments for receipts",
    );
  }
  return detected;
}

/**
 * Insert a receipt row. Idempotent on (provider_msg_id, attachment_id).
 * `accountId` is null for the shared-Google-OAuth Gmail path; the
 * download route falls back to GmailService for those rows.
 */
export function insertReceipt(
  db: Database.Database,
  providerMsgId: string,
  attachment: AttachmentLike,
  category: string,
  accountId: string | null,
): boolean {
  try {
    db.prepare(
      `INSERT INTO receipts
         (provider_msg_id, attachment_id, filename, mime_type, size_bytes, category, account_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      providerMsgId,
      attachment.attachmentId,
      attachment.filename,
      attachment.mimeType,
      attachment.size,
      category,
      accountId,
    );
    return true;
  } catch (err) {
    if (isUniqueConstraintError(err)) return false;
    throw err;
  }
}
