import { parseDays } from "../query-utils.js";

export interface ImapQueryTranslation {
  terms: Array<{ op: string; value?: string }>;
  warnings: string[];
  requiresClientSideUnicodeFilter: boolean;
}

export interface TranslateImapOptions {
  now?: () => Date;
}

export function translateImapQuery(
  q: string | null,
  opts: TranslateImapOptions = {},
): ImapQueryTranslation {
  if (!q) {
    return {
      terms: [],
      warnings: [],
      requiresClientSideUnicodeFilter: false,
    };
  }

  const now = opts.now ?? (() => new Date());
  const terms: Array<{ op: string; value?: string }> = [];
  const warnings: string[] = [];
  let requiresClientSideUnicodeFilter = false;

  for (const token of tokenizeQuery(q)) {
    if (token.startsWith("from:")) {
      terms.push({ op: "FROM", value: token.slice(5) });
      continue;
    }
    if (token.startsWith("to:")) {
      terms.push({ op: "TO", value: token.slice(3) });
      continue;
    }
    if (token.startsWith("subject:")) {
      const value = stripOptionalQuotes(token.slice(8));
      if (containsNonAscii(value)) {
        requiresClientSideUnicodeFilter = true;
      } else {
        terms.push({ op: "SUBJECT", value });
      }
      continue;
    }
    if (token === "has:attachment") {
      terms.push({ op: "LARGER", value: "50000" });
      continue;
    }
    if (token === "is:unread") {
      terms.push({ op: "UNSEEN" });
      continue;
    }
    if (token.startsWith("newer_than:")) {
      const days = parseDays(token.slice("newer_than:".length));
      if (days === null) {
        warnings.push(`unsupported_token:${token}`);
      } else {
        terms.push({ op: "SINCE", value: formatImapDate(daysAgo(days, now)) });
      }
      continue;
    }
    if (token.startsWith("older_than:")) {
      const days = parseDays(token.slice("older_than:".length));
      if (days === null) {
        warnings.push(`unsupported_token:${token}`);
      } else {
        terms.push({ op: "BEFORE", value: formatImapDate(daysAgo(days, now)) });
      }
      continue;
    }

    const value = stripOptionalQuotes(token);
    if (containsNonAscii(value)) {
      requiresClientSideUnicodeFilter = true;
      continue;
    }
    if (value.length > 0) {
      terms.push({ op: "TEXT", value });
      continue;
    }
    warnings.push(`unsupported_token:${token}`);
  }

  return { terms, warnings, requiresClientSideUnicodeFilter };
}

function tokenizeQuery(q: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < q.length) {
    while (i < q.length && /\s/.test(q[i]!)) i++;
    if (i >= q.length) break;
    let j = i;
    let inQuotes = false;
    while (j < q.length) {
      const char = q[j]!;
      if (char === '"') inQuotes = !inQuotes;
      if (!inQuotes && /\s/.test(char)) break;
      j++;
    }
    tokens.push(q.slice(i, j));
    i = j;
  }
  return tokens.filter((token) => token.length > 0);
}

function stripOptionalQuotes(value: string): string {
  if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
    return value.slice(1, -1);
  }
  return value;
}

function daysAgo(days: number, now: () => Date): Date {
  return new Date(now().getTime() - days * 24 * 60 * 60 * 1000);
}

function formatImapDate(date: Date): string {
  const day = String(date.getUTCDate()).padStart(2, "0");
  const month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][
    date.getUTCMonth()
  ]!;
  return `${day}-${month}-${date.getUTCFullYear()}`;
}

function containsNonAscii(value: string): boolean {
  return /[^\x00-\x7F]/.test(value);
}

