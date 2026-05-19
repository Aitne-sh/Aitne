/**
 * Translate the unified mail query subset (§3.10) into Microsoft Graph
 * `$filter` and `$search` fragments. Pure for unit testing — the OutlookGraph
 * provider just calls into here and stitches results into the request URL.
 *
 * Tokens:
 *   from:<email>            → from/emailAddress/address eq '...'
 *   to:<email>              → toRecipients/any(...)
 *   is:unread               → isRead eq false
 *   has:attachment          → hasAttachments eq true
 *   newer_than:<N>d         → receivedDateTime ge <iso>
 *   older_than:<N>d         → receivedDateTime lt <iso>
 *   subject:"..."           → folded into $search
 *   <free text>             → folded into $search
 *
 * Unknown tokens fall through into $search verbatim — Graph free-text search
 * is forgiving. Quoted strings are preserved as single tokens.
 */
import { parseDays } from "../query-utils.js";

export interface QueryTranslation {
  filters: string[];
  search: string | null;
}

export interface TranslateOptions {
  /** Override `now` for deterministic newer_than/older_than tests. */
  now?: () => Date;
}

export function translateQueryFilters(
  q: string | null,
  opts: TranslateOptions = {},
): QueryTranslation {
  if (!q) return { filters: [], search: null };

  const now = opts.now ?? (() => new Date());
  const filters: string[] = [];
  const freeTextParts: string[] = [];
  const tokens = tokenizeQuery(q);

  for (const token of tokens) {
    if (token.startsWith("from:")) {
      filters.push(`from/emailAddress/address eq '${escapeOdata(token.slice(5))}'`);
    } else if (token.startsWith("to:")) {
      filters.push(
        `toRecipients/any(r:r/emailAddress/address eq '${escapeOdata(token.slice(3))}')`,
      );
    } else if (token === "is:unread") {
      filters.push("isRead eq false");
    } else if (token === "has:attachment") {
      filters.push("hasAttachments eq true");
    } else if (token.startsWith("newer_than:")) {
      const days = parseDays(token.slice("newer_than:".length));
      if (days !== null) {
        filters.push(`receivedDateTime ge ${isoDaysAgo(days, now)}`);
      }
    } else if (token.startsWith("older_than:")) {
      const days = parseDays(token.slice("older_than:".length));
      if (days !== null) {
        filters.push(`receivedDateTime lt ${isoDaysAgo(days, now)}`);
      }
    } else if (token.startsWith("subject:")) {
      freeTextParts.push(`subject:${token.slice("subject:".length)}`);
    } else {
      freeTextParts.push(token);
    }
  }

  return {
    filters,
    search: freeTextParts.length > 0 ? freeTextParts.join(" ") : null,
  };
}

function tokenizeQuery(q: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < q.length) {
    while (i < q.length && /\s/.test(q[i]!)) i++;
    if (i >= q.length) break;
    if (q[i] === '"') {
      let j = i + 1;
      while (j < q.length && q[j] !== '"') j++;
      tokens.push(q.slice(i, Math.min(j + 1, q.length)));
      i = j + 1;
    } else {
      let j = i;
      while (j < q.length && !/\s/.test(q[j]!)) {
        if (q[j] === ":" && q[j + 1] === '"') {
          let k = j + 2;
          while (k < q.length && q[k] !== '"') k++;
          j = k + 1;
          break;
        }
        j++;
      }
      tokens.push(q.slice(i, j));
      i = j;
    }
  }
  return tokens.filter((t) => t.length > 0);
}

function isoDaysAgo(days: number, now: () => Date): string {
  return new Date(now().getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}

function escapeOdata(value: string): string {
  return value.replaceAll("'", "''");
}
