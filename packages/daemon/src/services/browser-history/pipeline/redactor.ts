import { classifyHost } from "./sensitive-hosts.js";

export interface RawVisitInput {
  url: string;
  title: string | null;
  searchQuery: string | null;
}

export interface RedactedVisit {
  url: string;
  scheme: string;
  host: string;
  path: string;
  searchQuery: string | null;
  title: string | null;
  drop: boolean;
}

const STRIPPED_QUERY_KEYS = new Set([
  "orderid",
  "order_id",
  "order-id",
  "token",
  "access_token",
  "id_token",
  "refresh_token",
  "auth_token",
  "session",
  "sessid",
  "sessionid",
  "session_id",
  "secret",
  "apikey",
  "api_key",
  "key",
  "code",
  "state",
  "nonce",
  "x-amz-security-token",
]);

const JWT_REGEX = /^[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}$/;
const SECRET_TITLE_REGEX = /(api[_ -]?key|password|secret|bearer|access[_ -]?token)/i;
const MAX_TITLE_LENGTH = 240;

function stripSensitiveQueryParams(searchParams: URLSearchParams): void {
  const keys = [...searchParams.keys()];
  for (const rawKey of keys) {
    const key = rawKey.toLowerCase();
    if (STRIPPED_QUERY_KEYS.has(key)) {
      searchParams.delete(rawKey);
      continue;
    }
    const value = searchParams.get(rawKey);
    if (value && JWT_REGEX.test(value)) {
      searchParams.delete(rawKey);
    }
  }
}

function safeTitle(title: string | null): string | null {
  if (!title) return null;
  if (SECRET_TITLE_REGEX.test(title)) return null;
  const trimmed = title.trim();
  if (trimmed.length === 0) return null;
  return trimmed.length > MAX_TITLE_LENGTH
    ? trimmed.slice(0, MAX_TITLE_LENGTH)
    : trimmed;
}

function safeSearchQuery(searchQuery: string | null): string | null {
  if (!searchQuery) return null;
  if (SECRET_TITLE_REGEX.test(searchQuery)) return null;
  const trimmed = searchQuery.trim();
  if (trimmed.length === 0) return null;
  return trimmed.length > MAX_TITLE_LENGTH
    ? trimmed.slice(0, MAX_TITLE_LENGTH)
    : trimmed;
}

export function redactVisit(input: RawVisitInput): RedactedVisit {
  let parsed: URL;
  try {
    parsed = new URL(input.url);
  } catch {
    return {
      url: input.url,
      scheme: "",
      host: "",
      path: "",
      searchQuery: null,
      title: null,
      drop: true,
    };
  }
  const scheme = parsed.protocol.toLowerCase();
  const host = parsed.hostname.toLowerCase();
  const sensitive = classifyHost(host);
  if (sensitive === "adult") {
    return {
      url: "",
      scheme,
      host,
      path: parsed.pathname,
      searchQuery: null,
      title: null,
      drop: true,
    };
  }
  stripSensitiveQueryParams(parsed.searchParams);
  // Force a stable serialised form so the hash is deterministic.
  parsed.hash = "";
  const rebuilt = parsed.toString();
  if (sensitive === "banking" || sensitive === "health") {
    return {
      url: rebuilt,
      scheme,
      host,
      path: parsed.pathname,
      searchQuery: null,
      title: null,
      drop: false,
    };
  }
  return {
    url: rebuilt,
    scheme,
    host,
    path: parsed.pathname,
    searchQuery: safeSearchQuery(input.searchQuery),
    title: safeTitle(input.title),
    drop: false,
  };
}
