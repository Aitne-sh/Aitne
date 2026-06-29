/**
 * FTS5 search over `mail_messages_index` (Phase 7, §10).
 *
 * The virtual table `fts_mail_messages` is kept in sync via triggers on
 * `mail_messages_index` (see `schema.ts`). This helper composes a MATCH
 * against it, joins back the canonical row so callers get the full summary,
 * and filters out soft-deleted rows.
 *
 * The MATCH string is sanitized — FTS5 treats punctuation like `"` and `:` as
 * operators; unsanitized user input can throw `SQLITE_ERROR: fts5: syntax
 * error`. We quote every whitespace-separated token as a phrase to sidestep
 * the grammar entirely and let the unicode61 tokenizer do the work. The
 * sanitizer itself lives in `services/fts5.ts` so other FTS5 surfaces
 * (`/api/docs/search`) reuse the same chokepoint.
 */

import type Database from "better-sqlite3";
import { buildMatchExpression } from "../fts5.js";

export interface SearchMailHit {
  accountId: string;
  providerMsgId: string;
  subject: string | null;
  snippet: string | null;
  receivedAtUtc: string;
  fromEmail: string | null;
  isRead: boolean;
}

export interface SearchMailOptions {
  /** Scope to a single account. Omit to search across all accounts. */
  accountId?: string;
  /** Hard cap on results. Default 50. Upper bound 500 to keep requests bounded. */
  limit?: number;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

export function searchMail(
  db: Database.Database,
  query: string,
  options: SearchMailOptions = {},
): SearchMailHit[] {
  const matchExpr = buildMatchExpression(query);
  if (matchExpr === null) return [];

  const limit = Math.max(
    1,
    Math.min(options.limit ?? DEFAULT_LIMIT, MAX_LIMIT),
  );
  const params: (string | number)[] = [matchExpr];
  let sql = `
    SELECT m.account_id       AS accountId,
           m.provider_msg_id   AS providerMsgId,
           m.subject           AS subject,
           m.snippet           AS snippet,
           m.received_at_utc   AS receivedAtUtc,
           m.from_email        AS fromEmail,
           m.is_read           AS isRead
      FROM fts_mail_messages f
      JOIN mail_messages_index m
        ON m.account_id = f.account_id
       AND m.provider_msg_id = f.provider_msg_id
     WHERE f.fts_mail_messages MATCH ?
       AND m.deleted_at_utc IS NULL`;
  if (options.accountId !== undefined) {
    sql += ` AND m.account_id = ?`;
    params.push(options.accountId);
  }
  sql += ` ORDER BY m.received_at_utc DESC LIMIT ?`;
  params.push(limit);

  const rows = db.prepare(sql).all(...params) as Array<{
    accountId: string;
    providerMsgId: string;
    subject: string | null;
    snippet: string | null;
    receivedAtUtc: string;
    fromEmail: string | null;
    isRead: number;
  }>;

  return rows.map((r) => ({
    accountId: r.accountId,
    providerMsgId: r.providerMsgId,
    subject: r.subject,
    snippet: r.snippet,
    receivedAtUtc: r.receivedAtUtc,
    fromEmail: r.fromEmail,
    isRead: r.isRead !== 0,
  }));
}

